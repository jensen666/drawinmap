/**
 * 智能体编排：用户输入 → LLM 意图解析 → 地点解析（路网数据）→ 图形引擎规划 → 回复。
 *
 * 与 UI 解耦：通过 send() 返回回复文本，通过 onProgress 回调报告阶段。
 */

import { loadRoadData } from '../road-data.js';
import {
  DELIVERABLE_SCORE,
  QUALITY_ASPECT_DISTORTION,
  QUALITY_FEATURE_COVERAGE,
  QUALITY_FEATURE_GAP_RETAIN,
  QUALITY_FRECHET_MAX_RATIO,
  QUALITY_ORDERED_ROUTE_MAX_RATIO,
} from '../engine/quality.js';
import {
  buildConstraintContract,
  describeConstraintViolations,
  evaluateConstraintContract,
  sizeToleranceMeters,
} from '../engine/constraint-contract.js';
import { buildSystemPrompt } from './prompt.js';
import { buildUserMessage, chatCompletion, classifyError, llmMetaOf } from './llm.js';
import {
  DEFAULT_SIZE_METERS,
  extractExplicitSizeMeters,
} from './intent.js';
import { describeShapeSpec } from './shape-spec.js';
import { acceptTarget, isTargetQualified } from './target-acceptance.js';
import { detectPossibleConstraintText } from './constraint-detect.js';
import {
  renderOutlineDataUrl,
  reviewTargetShape,
  verifyConstraintsByReview,
} from './shape-review.js';
import { createPlaceIndex, nearestPoi, resolvePlace } from './places.js';
import {
  buildDeliveredObjectUnits,
  checkDeliveryObjectConsistency,
  matchRequestedObjects,
} from './request-objects.js';
import { composeMultiPartShape } from './composite-shape.js';
import {
  composeOffsetNotice,
  describeNearFieldFailure,
  pickNearRepresentative,
} from './offset-reason.js';
import { measureFeatureArcs } from '../engine/feature-arcs.js';
import { SHAPES } from '../engine/shapes.js';
import { createGuideState, fillFromOption, finalizeIntent, mergeIntentInto, nextMissingSlot, questionFor } from './guide.js';
import { createReferenceCandidateSource, wrapLegacyReferenceSource, REFERENCE_CHOICE_LIMIT } from './reference.js';
import { beginTrace, createLogger } from '../log/index.js';
import { createId } from '../log/core.js';
import { createAbortError, isAbortError, isAborted, linkSignals, throwIfAborted } from '../cancel.js';
import { traceImageDataUrl } from './image-trace-browser.js';
import { createReplyTemplates } from './reply/templates.js';

/** 模块 logger：记录编排过程（自动归属当前对话 trace） */
const log = createLogger('agent');
import { errorKindOf, isParseFailure, rethrowIfAborted, withErrorKind } from './pipeline/shared.js';
import {
  buildOutlinePreview,
  buildTracePromptText,
  buildTracedCustomShape,
  builtinReviewShape,
  createDeliverReference,
  placeTextOf,
  summarizeIntent,
  summarizePlanned,
  summarizeShape,
} from './pipeline/deliver.js';
import {
  applyCompositeReference,
  applyFreeformCandidate,
  applyReferenceCandidate,
  buildFreeformCandidate,
  buildThreeSourceSnapshot,
  canUseReferenceChannel,
  countCandidatesByOrigin,
  createThreeSourceRuntime,
  createThreeSourceSession,
  isLocalOnlyHit,
  isThreeSourcePathSettled,
  matchedObjectsOf,
  supportsThreeSourcePhase,
} from './pipeline/three-source.js';
import { parseIntentWithRecovery, recoveryMode } from './pipeline/intent-recovery.js';
import { createScalePool } from './pipeline/scale-pool.js';
import { createReferencePhases } from './pipeline/reference-phase.js';
import { createAlternativeSwitch } from './pipeline/alternative-switch.js';
import { createPlanRuntime } from './pipeline/plan.js';
import { createRecommendRuntime } from './pipeline/recommend.js';
import { createSendRuntime } from './pipeline/send.js';

// 对外 API 兼容：recoveryMode / matchAlternativeSwitchPhrase 仍从 controller 导出
export { recoveryMode };
export { matchAlternativeSwitchPhrase } from './pipeline/send.js';

/** 对话上下文保留的最近消息条数（user+assistant 合计） */
const HISTORY_LIMIT = 4;

/** 整轮规划总时间预算（毫秒）：与引擎单图形搜索预算一致。
 * 四级 7×7 网格大约几千个候选，60 秒会在搜完前被掐断。 */
/** 目标轮廓自检闭环的时间预算（毫秒）：质检 + 按需修正 + 复检共用，与搜索预算独立
 * （LLM 调用本就不在引擎 deadline 内）。修正请求 180 秒截止、只发一次，
 * 预算需覆盖「质检 + 单次修正 ≤180s + 复检」，超出按剩余量降级，不阻塞规划。 */
const SHAPE_REVIEW_BUDGET_MS = 400000;

/** 自由轮廓修正请求超时（毫秒）：该次请求 retries=0，180 秒截止即停，不自动再发。
 * 超时中止本次修正，不重试。 */
const FREEFORM_REVISION_TIMEOUT_MS = 180000;

/** 三路都没有可用轮廓时的回复由 composeNoContourReply 按失败原因分类生成
 *  （方案 2026-11-08 §5.2：不同原因给不同文案与对应下一步）。 */

/**
 * 三路都没有可用轮廓时的失败原因分类（方案 2026-11-08 §5.2）。
 *
 * 不同原因必须给**不同**的结构化原因与对应下一步，不能一律笼统成"没有可用轮廓"：
 * - truncation：修正响应被截断（推理预算耗尽）
 * - semantics：视觉质检结论不像
 * - topology：拓扑非法（自交/部分嵌套/退化）
 * - points：点数门不合格
 * - constraints：用户显式约束未满足/未核验
 *
 * @param {string[]} reasons 验收失败原因清单
 * @returns {{category: string, label: string, nextStep: string, detail: string|null}}
 */
function classifyNoContourReason(reasons) {
  const list = (Array.isArray(reasons) ? reasons : []).filter((item) => typeof item === 'string' && item.trim());
  const text = list.join('；');
  const pick = (category, label, nextStep, keywords) => ({
    category,
    label,
    nextStep,
    detail: list.find((item) => keywords.some((keyword) => item.includes(keyword))) ?? null,
  });
  if (!text) {
    return {
      category: 'unknown',
      label: '没能生成可用轮廓',
      nextStep: '换个更常见的叫法让我重新找，或者换个图形。',
      detail: null,
    };
  }
  if (/截断|finishReason|token|推理预算/i.test(text)) {
    return pick('truncation', '生成的轮廓太长、写到一半被截断了', '把描述简化一点（比如只说最显眼的特征），我重新生成一次。', [
      '截断',
      'token',
      '推理',
    ]);
  }
  if (/拓扑|自交|嵌套|退化|非法/i.test(text)) {
    return pick('topology', '生成的轮廓几何上不成立（自交或带孔洞）', '换个更简单、没有孔洞的形状，我再试一次。', [
      '拓扑',
      '自交',
      '嵌套',
      '退化',
    ]);
  }
  if (/点数|点低于|超过上限/i.test(text)) {
    return pick('points', '生成的轮廓细节点数没达标（太简单或太繁复）', '把轮廓简化一点（少几个细节）再试，通常更好画出来。', [
      '点数',
      '低于',
      '超过上限',
    ]);
  }
  if (/约束|不像|质检/i.test(text)) {
    return pick('semantics', '生成出来不像你要的那个（或没满足你提的要求）', '把你最想要的那一个特征说得更具体一点（比如"头朝左、尾巴翘起来"），我重画。', [
      '不像',
      '约束',
      '质检',
    ]);
  }
  return {
    category: 'unknown',
    label: '没能生成可用轮廓',
    nextStep: '换个更常见的叫法让我重新找，或者换个图形。',
    detail: list[0] ?? null,
  };
}

/**
 * 三路都没有可用轮廓时的回复（方案 2026-11-05 §4.2、2026-11-08 §5.2）：
 * 单对象请求也必须点明**目标**与**主要原因**，并给出与原因对应的下一步；
 * 多对象请求点名用户要的每一个对象——通用句「没有可用轮廓」让用户不知道是哪个对象没画出来。
 *
 * @param {object} intent 归一化意图
 * @param {object} [options]
 * @param {string[]} [options.reasons] 验收失败原因清单（自由轮廓路径给出）
 * @param {string|null} [options.shapeName] 目标图形名
 * @returns {string} 回复文本
 */
function composeNoContourReply(intent, { reasons = [], shapeName = null } = {}) {
  const requested = Array.isArray(intent?.requestObjects) ? intent.requestObjects : [];
  const target = shapeName || (requested.length > 0 ? requested.map((item) => item?.name).filter(Boolean).join('、') : null);
  const failure = classifyNoContourReason(reasons);
  const head = target ? `「${target}」` : '这个图形';
  if (requested.length < 2) {
    // 单对象：点明目标 + 主要原因 + 对应下一步（不再是一句笼统的"没有可用轮廓"）
    return (
      `${head}这次没画出来：${failure.label}${failure.detail ? `（${failure.detail}）` : ''}。\n` +
      `${failure.nextStep}`
    );
  }
  const names = requested.map((item) => item?.name).filter(Boolean);
  if (names.length === 0) {
    return `${head}这次没画出来：${failure.label}。\n${failure.nextStep}`;
  }
  return (
    `「${names.join('」「')}」这次没有可用轮廓：${failure.label}${failure.detail ? `（${failure.detail}）` : ''}。\n` +
    `${failure.nextStep}`
  );
}

/**
 * 挑选回复文案承诺的备选版本（缺陷清单 2026-11-06 Bug 5，2026-11-07 复核修正）。
 *
 * 规则与 composeReply 的"另有一版"文案完全同源：非当前尺寸里**尺寸最大**的一版。
 * 此前切换逻辑按方向取极值（要小 → 最小版），与承诺的版本错位——真实运行 B8：
 * 回复承诺 7.2 km 版、照做后交付 0.9 km 版。现在承诺与切换共用本函数，
 * 承诺哪版就切换哪版。
 *
 * @param {object|null} best 当前交付候选
 * @param {Array<object>} alternatives 备选池
 * @returns {object|null} 被承诺的备选（无可承诺备选返回 null）
 */
function pickPromisedAlternative(best, alternatives) {
  if (!best || !Array.isArray(alternatives)) {
    return null;
  }
  const pool = alternatives.filter(
    (item) => item && Number.isFinite(item.sizeMeters) && item.sizeMeters !== best.sizeMeters,
  );
  // 只承诺"切得过去"的版本：低于 60 分交付闸门的备选不写进承诺文案——
  // 否则用户照做后被闸门拒绝，承诺又一次不可兑现（Bug 5 同类问题）
  const deliverable = pool.filter(
    (item) => !Number.isFinite(item.score) || item.score >= DELIVERABLE_SCORE,
  );
  return deliverable.sort((a, b) => b.sizeMeters - a.sizeMeters)[0] ?? null;
}


const RECOMMEND_SHAPE_KEYS = ['star', 'heart', 'rect'];


/** 浏览器默认参考候选源：本地多候选 + 同源在线补漏（方案 2026-10-31 §5/§9） */
function createReferenceShapeSourceCompat() {
  return createReferenceCandidateSource();
}



/**
 * 创建智能体控制器。
 *
 * @param {object} options
 * @param {L.Map} options.map Leaflet 地图实例
 * @param {{plan: Function, recommend: Function, commitDraw: Function, clearDraw: Function, formatMinutes: Function}} options.engine 图形引擎接口
 * @param {object} options.placeConfig 归一化地点配置（normalizePlaceConfig 结果；城市/地标/文案都从这里取）
 * @param {object|Function} [options.referenceSource] 参考候选源（新接口：{resolveCandidates}；
 *   浏览器默认本地+在线组合；Node 测试可注入。旧单命中函数也可注入，内部自动适配）
 * @param {Function} [options.referenceShapeSource] 旧单命中参考源（迁移期兼容，等价于
 *   传入函数形式的 referenceSource）
 * @param {{renderOutline?: Function}} [options.shapeReviewDeps]
 *   目标视觉质检依赖注入（renderOutline 缺省用浏览器 canvas 渲染；Node 测试注入
 *   fake 以覆盖质检闸门分支——自由轮廓验收不可用时不得给合格绿线）
 * @param {Function} [options.imageTrace]
 *   图像描摹依赖注入（签名同 image-trace-browser.js 的 traceImageDataUrl：图片 data URL →
 *   {status, reasons, points, diagnostics}；缺省用浏览器实现）。Node 能力测试注入 fake，
 *   不依赖 canvas 即可覆盖描摹成功/失败/目标验收失败三个分支（方案 2026-11-01 §3）
 * @param {object|null} [options.cityStore] 城市状态机（方案 2026-11-08 §6）：
 *   提供 handleCityMention（对话点名城市路由）与 onCitySwitched 联动；Node 测试可缺省，
 *   缺省时城市名解析退化回"未解析 → 追问"，不影响其它链路
 * @returns {{send: Function, onCitySwitched: Function}} 智能体接口
 */
export function createAgentController({ map, engine, placeConfig, referenceSource = null, referenceShapeSource = typeof window !== 'undefined' ? createReferenceShapeSourceCompat() : null, shapeReviewDeps = {}, imageTrace = null, cityStore = null }) {
  if (!placeConfig?.activeCity) {
    throw new Error('createAgentController 需要地点配置 placeConfig（由 place-config.js 加载）');
  }
  /** 图像描摹入口：缺省浏览器实现（canvas 二值化→外轮廓→重采样），测试可注入 fake */
  // 回复文案与摘要（纯模板，依赖显式传入；拆出后 controller.js 只留编排）
  const replyTemplates = createReplyTemplates({
    engine,
    pickPromisedAlternative,
    recommendShapeKeys: RECOMMEND_SHAPE_KEYS,
    // 城市可切换 → 传取值函数而不是快照，避免切城后文案仍写旧城市的覆盖范围
    getCity: () => city,
  });
  const {
    escalationLikeReason,
    exampleHint,
    diagnoseReason,
    triedScopeText,
    composeFailureReply,
    describeShortfall,
    composeReferenceReply,
    composeConstraintViolationReply,
    composeReply,
    composeRecommendReply,
    composeRecommendFailureReply,
    shapeNameOf,
    confirmLine,
    composeTargetBlockedReply,
    composeTargetFailureReply,
    composeDiagnosticReferenceReply,
    composeAlternativeSwitchReply,
  } = replyTemplates;

  const traceImage = typeof imageTrace === 'function' ? imageTrace : traceImageDataUrl;
  /** 当前城市配置（代码内不写死任何城市/地名；城市切换由 onCitySwitched 刷新） */
  let city = placeConfig.activeCity;
  const matching = placeConfig.matching || {};
  /** 最近对话上下文（文本摘要，图片不入历史） */
  const history = [];
  /** 引导状态（非 null 表示正在追问补全需求） */
  let guideState = null;
  /** 待选参考候选快照（方案 2026-10-31 §6；非 null 表示等待用户点击候选卡）。
   * 结构：{ choiceId, sourceTraceId, status: 'awaiting-selection'|'selected',
   *   originalText, intent, candidates, origin, createdAt, selectedCandidateId?, confirmation? } */
  let referenceChoice = null;
  /** 待切换备选快照（缺陷清单 2026-11-06 Bug 5）：绿线交付后保留当轮备选（含完整
   * 几何与交付上下文），用户说"要大一点/小一点的那版"时直接切换交付，不再重新
   * LLM 解析 + 全量重规划（此前回复承诺"想换这一版直接说"，但系统没有任何处理
   * 逻辑——承诺不可兑现）。结构：{ best, alternatives, intent, placeNote, placeSource, at } */
  let pendingAlternative = null;
  /** 多比例尺候选池（需求 2026-11-09）：绿线交付后保留本次规划全部可交付比例尺档
   * （含路线几何），供回复下方候选卡片点选切换——不调 LLM、不重新规划。生命周期与
   * pendingAlternative 完全一致（新输入/切会话/切城市丢弃）；消息里只存卡片摘要，
   * 刷新后静态可见、不可点。结构见 buildScaleCandidatePool。 */
  let scaleCandidatePool = null;

  /** 多比例尺池/待切换备选运行时（C4 搬到 pipeline/scale-pool.js；状态访问器注入）。 */
  const scalePoolRuntime = createScalePool({
    engine,
    log,
    shapeNameOf,
    pickPromisedAlternative,
    getPendingAlternative: () => pendingAlternative,
    setPendingAlternative: (value) => { pendingAlternative = value; },
    getScaleCandidatePool: () => scaleCandidatePool,
    setScaleCandidatePool: (value) => { scaleCandidatePool = value; },
  });
  const {
    discardPendingAlternative,
    discardScaleCandidates,
    scalePoolView,
    currentScalePoolView,
    buildScaleCandidatePool,
    attachScalePoolMessage,
    cardToAlternative,
    rebuildPendingAlternativeFromPool,
    syncScalePoolAfterSwitch,
    switchScaleCandidate,
  } = scalePoolRuntime;

  /** 文字备选切换运行时（C4 搬到 pipeline/alternative-switch.js；状态访问器/文案注入）。 */
  const alternativeSwitchRuntime = createAlternativeSwitch({
    engine,
    log,
    pushHistory,
    getPendingAlternative: () => pendingAlternative,
    setPendingAlternative: (value) => { pendingAlternative = value; },
    shapeNameOf,
    composeAlternativeSwitchReply,
    syncScalePoolAfterSwitch,
  });
  const { deliverAlternativeSwitch } = alternativeSwitchRuntime;

  /** 参考候选源：新接口 {resolveCandidates}；旧单命中函数自动适配（迁移期兼容） */
  const referenceCandidatesSource = referenceSource
    ? typeof referenceSource === 'function'
      ? wrapLegacyReferenceSource(referenceSource)
      : referenceSource
    : referenceShapeSource
      ? typeof referenceShapeSource === 'function'
        ? wrapLegacyReferenceSource(referenceShapeSource)
        : referenceShapeSource
      : null;
  /** 参考通道两阶段运行时（C4 搬到 pipeline/reference-phase.js；写入用访问器注入）。 */
  const referencePhases = createReferencePhases({
    referenceCandidatesSource,
    log,
    pushHistory,
    setReferenceChoice: (choice) => { referenceChoice = choice; },
    getReferenceChoice: () => referenceChoice,
    cancelThreeSourceSession: (reason) => cancelThreeSourceSession(reason),
  });
  const { discardReferenceChoice, resolveMultiObjectPhase, resolveReferencePhase } = referencePhases;

  /** 路网道路名索引（懒加载，与引擎共用 road-data 缓存） */
  let roadIndexPromise = null;

  /** 懒加载路网并构建道路名索引 */
  function ensureRoadIndex() {
    if (!roadIndexPromise) {
      roadIndexPromise = loadRoadData(city.roads?.dataUrl)
        .then((roads) => createPlaceIndex(roads))
        .catch((error) => {
          roadIndexPromise = null;
          throw error;
        });
    }
    return roadIndexPromise;
  }

  /** 只读地点上下文（引擎已建好的 graph/nodeIndex/coverage；旧引擎/加载失败时返回 null，
   *  地点解析退化为只用道路名索引，不影响其它功能） */
  let placeContextPromise = null;

  /** 懒加载只读地点上下文 */
  function ensurePlaceContext() {
    if (!placeContextPromise) {
      placeContextPromise = Promise.resolve()
        .then(() => (typeof engine.getPlaceContext === 'function' ? engine.getPlaceContext() : null))
        .catch((error) => {
          log.warn('place.context.failed', { message: error?.message ?? String(error) });
          // 失败不缓存：下一轮可重试（避免一次临时失败永久退化）
          placeContextPromise = null;
          return null;
        });
    }
    return placeContextPromise;
  }

  /**
   * 城市切换通知（city store 完成切换后由 main.js 调用，方案 2026-11-08 §6.1）：
   * 刷新活动城市闭包并失效按城市缓存的索引/上下文；上一城市的引导与待切换备选
   * 一并丢弃（选项和备选都是按上一城市语境给出的，换城后继续会答非所问）。
   */
  function onCitySwitched() {
    const previousCityId = city?.id ?? null;
    city = placeConfig.activeCity;
    roadIndexPromise = null;
    placeContextPromise = null;
    guideState = null;
    discardPendingAlternative('city-switch');
    discardScaleCandidates('city-switch');
    log.info('city.switched.agent', {
      fromCityId: previousCityId,
      toCityId: city?.id ?? null,
      label: city?.label ?? null,
    });
  }

  /**
   * 对话点名城市的路由（方案 2026-11-08 §6.2）：place 精确命中城市目录名且不是
   * 当前城市时，按该城状态路由——
   * - wait：还在获取中 → 诚实等待回复，不画不切；
   * - failed：上次失败 → 说明失败 + 引导重试，不画不切；
   * - guide：未获取 → 引导到城市面板显式获取（不做"点名即拉取"），不画不切；
   * - switched：已就绪 → 就地切换进入该城市，本轮继续用新城路网规划。
   * place 不是目录城市名时返回 null（走原地点解析，城市内地点不受影响）。
   *
   * @param {string} placeText 用户提到的地名原文
   * @param {{onProgress?: Function}} [options] 推理步骤回调（切换可见）
   * @returns {Promise<null|{blocked: boolean, reply?: string, cityId: string, switched?: boolean}>}
   */
  async function routeCityMention(placeText, { onProgress: routeProgress = () => {} } = {}) {
    if (!cityStore || typeof cityStore.handleCityMention !== 'function') {
      return null;
    }
    const route = await cityStore.handleCityMention(placeText);
    if (!route) {
      return null;
    }
    const label = route.city?.label ?? route.city?.fullName ?? String(placeText);
    if (route.action === 'switched') {
      routeProgress({ text: `已切换到${label}，用${label}路网继续`, kind: 'step' });
      return { blocked: false, switched: true, cityId: route.city.id };
    }
    if (route.action === 'wait') {
      return {
        blocked: true,
        cityId: route.city.id,
        reply: `「${label}」的路网还在获取中，等获取完成后才能在${label}画。当前仍在${city.label}，可以继续在这里画，也可以在城市面板看进度。`,
      };
    }
    if (route.action === 'failed') {
      return {
        blocked: true,
        cityId: route.city.id,
        reply: `上次获取「${label}」的路网失败了（${route.error ?? '原因未知'}），现在还不能在${label}画。可以在城市面板重试；当前仍在${city.label}，可以继续在这里画。`,
      };
    }
    if (route.action === 'guide') {
      return {
        blocked: true,
        cityId: route.city.id,
        reply: `「${label}」还没有获取路网，我画不了。请打开城市面板选择「${label}」，获取完成后再来。当前仍在${city.label}，可以继续在这里画。`,
      };
    }
    // 'active'：当前城市名没走到城市名匹配（覆盖中心解析失败等）——按未解析正常追问
    return null;
  }

  /** 记录一轮对话到上下文（截断到 HISTORY_LIMIT） */
  function pushHistory(userText, assistantText) {
    history.push({ role: 'user', content: userText || '[图片]' });
    history.push({ role: 'assistant', content: assistantText.slice(0, 500) });
    while (history.length > HISTORY_LIMIT) {
      history.shift();
    }
  }

  // 交付出口（参考版/诊断版共用骨架）：C4 搬到 pipeline/deliver.js，依赖显式注入
  const deliverReference = createDeliverReference({ engine, pushHistory, log });

  /**
   * 地点未解析时的追问回复（`matching.unresolvedPlace = "ask"`）：
   * 不把图形画到当前视野中心冒充用户指定地点，先让用户换地点或明确选择视野中心。
   *
   * @param {object} intent 当前意图
   * @param {string} text 用户原文
   * @param {string} placeNote 地点解析备注（可空）
   * @param {{sourceText?: string|null}} [options] 发起引导的原始请求文本（缺省用 text）。
   *   引导状态必须带 sourceText：否则后续 continueGuide 的 requestText 拿不到原始请求，
   *   会把引导回答当"用户原文"送进视觉质检（缺陷清单 Bug 2.4 第 4 条）
   * @returns {{reply: string, planned: null, guide: {slot: string, options: Array}}} 追问结果
   */
  function askUnresolvedPlace(intent, text, placeNote, { sourceText = null } = {}) {
    const { question, options } = questionFor('place', placeConfig);
    const lines = [];
    if (intent.reply) {
      lines.push(intent.reply);
    }
    if (placeNote) {
      lines.push(placeNote);
    } else {
      lines.push(
        `没在地点配置里找到「${intent.place}」。我目前只有${city.label}范围的路网数据（${city.coverage.description}），只能在这个范围内画。`,
      );
    }
    lines.push(question);
    const reply = lines.join('\n');
    // 回到地点引导：下一轮点选项/说地点即可续问，不用重新解析整段意图
    guideState = createGuideState({ ...intent, place: null, centerChosen: false }, { sourceText: sourceText || text });
    pushHistory(text, reply);
    log.warn('place.unresolved.ask', { place: intent.place, policy: matching.unresolvedPlace });
    return { reply, planned: null, guide: { slot: 'place', options } };
  }



  /** 解析地点文本为坐标（解析失败/未找到时按配置策略处理，供 plan/recommend 共用）。
   *  返回 placeSource 供回复层区分「用户指定地点」与「已加载路网的覆盖中心」——
   *  覆盖中心不能说成"您指定的地方"；unresolved=true 表示地点没解析出来。 */
  async function resolvePlaceToCenter(place, centerChosen = false) {
    if (!place) {
      return {
        center: null,
        placeNote: centerChosen ? '位置：按您选择的当前地图视野中心' : '',
        placeSource: 'view-center',
        unresolved: false,
      };
    }
    /** 未找到地点时的策略：ask=追问换地点（默认，不画到视野中心）；view-center=旧行为 */
    const useViewCenter = matching.unresolvedPlace === 'view-center';
    try {
      const [roadIndex, placeContext] = await Promise.all([
        // 道路索引失败不应拖垮地标/行政区解析（降级为 null，仍可解析 POI/城市/行政区）
        ensureRoadIndex().catch((error) => {
          log.warn('place.road-index.failed', { message: error?.message ?? String(error) });
          return null;
        }),
        ensurePlaceContext(),
      ]);
      const resolved = resolvePlace(place, { config: placeConfig, roadIndex, placeContext });
      if (resolved) {
        log.info('place.resolved', {
          place,
          source: resolved.source,
          label: resolved.label,
          lat: resolved.lat,
          lng: resolved.lng,
          hasPlaceContext: Boolean(placeContext),
        });
        let placeNote = '';
        if (resolved.source === 'coverage-center') {
          // 覆盖中心不是用户点名的地标，也不冒充某个区已定位——只说覆盖中心
          placeNote = `地点「${place}」按已加载路网的覆盖中心定位`;
        } else if (resolved.source === 'district') {
          // 覆盖外行政区：保留代表点交给引擎 outside-coverage 预检，
          // 由失败回复统一说明"超出路网数据范围"，这里不重复提示
          placeNote = '';
        } else if (resolved.source === 'road') {
          placeNote = `地点「${place}」按道路「${resolved.label}」定位`;
        } else {
          placeNote = `地点「${place}」→ ${resolved.label}`;
        }
        return {
          center: { lat: resolved.lat, lng: resolved.lng },
          placeNote,
          placeSource: resolved.source,
          unresolved: false,
        };
      }
      log.warn('place.fallback', { place, reason: 'not-found', roadIndexSize: roadIndex.size });
      return {
        center: null,
        placeNote: useViewCenter ? `没在地点配置里找到「${place}」，改用地图当前视野中心` : '',
        placeSource: 'view-center',
        unresolved: true,
      };
    } catch (error) {
      log.error('place.resolve.failed', { place }, error);
      return {
        center: null,
        placeNote: useViewCenter ? '地点数据加载失败，改用地图当前视野中心' : '地点数据加载失败，暂时无法解析地点',
        placeSource: 'view-center',
        unresolved: true,
      };
    }
  }

  /** 执行推荐（只给条件）：地点解析 → 内置图形逐一实测 → 回复 */
  /** plan/recommend 通道运行时（C4 搬到 pipeline/plan.js + recommend.js，依赖显式注入）。 */
  const planRuntime = createPlanRuntime({
    engine,
    log,
    pushHistory,
    getCity: () => city,
    matching,
    getPendingAlternative: () => pendingAlternative,
    setPendingAlternative: (value) => { pendingAlternative = value; },
    getScaleCandidatePool: () => scaleCandidatePool,
    replyTemplates,
    pickPromisedAlternative,
    runtime: {
      deliverReference,
      buildScaleCandidatePool,
      askUnresolvedPlace,
      resolvePlaceToCenter,
      auditDeliveryObjects,
    },
  });
  const { executePlan } = planRuntime;
  const { executeRecommend } = createRecommendRuntime({
    engine,
    log,
    pushHistory,
    matching,
    recommendShapeKeys: RECOMMEND_SHAPE_KEYS,
    replyTemplates,
    runtime: { deliverReference, askUnresolvedPlace, resolvePlaceToCenter, auditDeliveryObjects },
  });

  /**
   * 交付对象一致性核对（方案 2026-11-05 §4.3）。
   *
   * 「请求对象 = 实际交付对象」：多对象请求缺对象时**不硬画、不承诺**——
   * 明确列出已命中与缺失对象并追问；单对象请求只做记录与回复净化
   * （不因命名差异牺牲交付率，但回复不得承诺未交付的对象）。
   *
   * @param {object} input
   * @param {object} input.intent 归一化意图
   * @param {object|null} input.target 已解析目标
   * @returns {{checked: boolean, ok: boolean, requested: Array<object>, missing: Array<object>,
   *   deliveredNames: string[], deliveredPartCount: number, blocking: boolean}}
   */
  function auditDeliveryObjects({ intent, target }) {
    const requested = Array.isArray(intent?.requestObjects) ? intent.requestObjects : [];
    if (requested.length === 0) {
      return {
        checked: false,
        ok: true,
        requested,
        missing: [],
        deliveredNames: [],
        deliveredPartCount: 0,
        deliveredObjects: [],
        assignments: [],
        unverifiedCount: 0,
        blocking: false,
      };
    }
    const referenceParts = Array.isArray(intent?.referenceSource?.parts) ? intent.referenceSource.parts : [];
    const extraNames = [
      intent?.referenceSource?.name ?? null,
      intent?.referenceSource?.matchedAlias ?? null,
      ...referenceParts.map((part) => part?.name ?? null),
    ].filter(Boolean);
    const deliveredShape = target?.customShape ?? intent?.customShape ?? null;
    // 交付物名称兜底：内置图形没有 customShape，用图形注册名/规格名作为身份
    const displayName =
      intent?.customShape?.name ??
      intent?.shapeSpec?.name ??
      (intent?.shapeKey && SHAPES[intent.shapeKey] ? SHAPES[intent.shapeKey].name : null) ??
      null;
    // 结构化交付身份（方案 2026-11-08 §4.2）：实际交付必须携带可靠的部分身份，
    // 不能只靠拼接显示名——最终验收与 E2E 断言共用这一份结果。
    const deliveredObjects = buildDeliveredObjectUnits({
      customShape: deliveredShape,
      displayName,
      referenceParts,
      referenceNames: [
        intent?.referenceSource?.name ?? null,
        intent?.referenceSource?.matchedAlias ?? null,
      ].filter(Boolean),
    });
    const consistency = checkDeliveryObjectConsistency({
      requested,
      customShape: deliveredShape,
      extraNames,
      deliveredObjects,
    });
    return {
      checked: true,
      ok: consistency.ok,
      requested,
      missing: consistency.missing,
      deliveredNames: consistency.deliveredNames,
      deliveredPartCount: consistency.deliveredPartCount,
      deliveredObjects: consistency.deliveredObjects,
      assignments: consistency.assignments,
      unverifiedCount: consistency.unverifiedCount,
      // 多对象请求缺对象 = 可证伪的漏交付 → 阻塞交付；单对象只记差异
      blocking: !consistency.ok && requested.length >= 2,
    };
  }

  /**
   * 执行规划：地点解析 → 目标闸门 → 引擎尽力链 → 回复。
   * planBlocked 完全不调用路网；验收未通过只做诊断性参考；验收通过才正式规划。
   */


  // ==========================================================================
  // 三种轮廓同一轮（方案 2026-11-01 §2）
  // 本地素材 / 在线检索 / 自由轮廓质检三路同时发起，卡片随结果到达追加；
  // 用户点选前引擎调用次数为 0；只有「在线与自由轮廓都失败且本地唯一命中整词」
  // 时才自动规划；三路都没有可用轮廓则不规划、不画线，回复「没有可用轮廓」。
  // ==========================================================================

  /** 当前三路会话（非 null 表示还有路在跑或等待用户点选；选择/新输入/切会话时取消） */
  let threeSourceSession = null;
  /** 当前轮次的三路候选追加监听（UI 用来实时追加候选卡；后台路在轮次结束后仍可能回调） */
  let referenceCandidateListener = null;

  /** 三路会话运行时（C4 搬到 pipeline/three-source.js；状态访问器/日志/历史显式注入，
   *  时序控制仍留在本文件的 resolveThreeSourcePhase）。 */
  const threeSourceRuntime = createThreeSourceRuntime({
    getSession: () => threeSourceSession,
    setSession: (session) => { threeSourceSession = session; },
    setChoice: (choice) => { referenceChoice = choice; },
    getListener: () => referenceCandidateListener,
    log,
    pushHistory,
  });
  const {
    publishThreeSourceSnapshot,
    addThreeSourceCandidates,
    cancelThreeSourceSession,
  } = threeSourceRuntime;





  /**
   * 三路并发候选阶段（方案 2026-11-01 §2）。
   *
   * 返回：
   * - null：不适用（非 plan/内置/参数化/图像描摹/无参考源）→ 调用方走旧链路；
   * - { intent }：自动规划（在线与自由轮廓都失败，且本地唯一对象命中整词）；
   * - { awaiting: true, result }：至少一张可用候选卡 → 等待用户点选，引擎 0 次调用，
   *   剩余路后台继续跑并追加；
   * - { noContour: true }：三路都没有可用轮廓 → 不规划、不画线。
   *
   * @param {object} intent 归一化意图
   * @param {string} text 用户原文
   * @param {(step: object) => void} onProgress 推理过程回调
   * @param {object} trace 候选轮 trace
   * @param {AbortSignal|null} signal 中止信号
   * @returns {Promise<object|null>}
   */
  async function resolveThreeSourcePhase(intent, text, onProgress, trace, signal) {
    if (!supportsThreeSourcePhase(referenceCandidatesSource)) {
      return null;
    }
    const freeformShape = intent.customShape ?? null;
    const session = createThreeSourceSession({ intent, text, trace });
    threeSourceSession = session;
    /** 变化通知：任一路结束/追加候选时唤醒主等待循环（版本号避免丢失唤醒） */
    let changeVersion = 0;
    let pendingNotify = null;
    const bump = () => {
      changeVersion += 1;
      if (pendingNotify) {
        const resolve = pendingNotify;
        pendingNotify = null;
        resolve();
      }
    };
    const waitChange = (seenVersion) => {
      if (changeVersion !== seenVersion) {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        pendingNotify = resolve;
      });
    };

    /** 三路中一路的公共生命周期骨架：AbortController/信号联动/路径状态/取消与异常兜底/唤醒。
     *  业务体只写成功结果；取消与失败兜底统一处理（参考路单路失败不阻断另一路）。 */
    const runPathSkeleton = async (path, run, { onError = null } = {}) => {
      const controller = new AbortController();
      const unlink = linkSignals(signal, controller);
      session.aborters.set(path, controller);
      session.paths[path].state = 'running';
      try {
        await run(controller.signal);
      } catch (error) {
        if (isAborted(signal) || isAborted(controller.signal)) {
          session.paths[path].state = 'cancelled';
          log.info('agent.threeSources.path.cancelled', { path });
        } else if (onError) {
          onError(error);
        } else {
          // 参考通道是增强路径：单路失败不阻断自由轮廓/另一路
          session.paths[path].state = 'done';
          session.paths[path].error = error?.message ?? String(error);
          log.warn('agent.threeSources.path.failed', { path, message: error?.message ?? String(error) });
        }
      } finally {
        unlink();
        session.aborters.delete(path);
        bump();
      }
    };

    /**
     * 跑参考一路（本地/在线）：结果到达即追加候选；失败只记日志，不阻断另一路。
     *
     * @param {'local'|'online'} path 路径
     * @param {(signal: AbortSignal) => Promise<object>} runner 该路实现
     */
    const runReferencePath = async (path, runner) => {
      await runPathSkeleton(path, async (pathSignal) => {
        const result = await runner(pathSignal);
        session.paths[path].state = 'done';
        session.paths[path].result = result;
        const status = result?.status ?? 'failed';
        log.info('agent.threeSources.path', {
          path,
          status,
          count: result?.candidates?.length ?? 0,
          objects: result?.objects ?? null,
          error: result?.error ?? null,
          // 失败可见化（缺陷清单 Bug 1.6.3）：区分 offline / upstream-failed / no-match /
          // filtered / conversion-failed，并带 poolSize/attempts/被过滤数——
          // 在线通道静默失效 168 次无告警的教训
          failureKind: result?.failureKind
            ?? (status === 'offline' ? 'offline' : status === 'miss' ? 'no-match' : null),
          poolSize: result?.poolSize ?? null,
          attempts: Array.isArray(result?.attempts) ? result.attempts.length : null,
          filteredOut: result?.filteredOut ?? null,
        });
        if (status === 'ok' && Array.isArray(result.candidates) && result.candidates.length > 0) {
          addThreeSourceCandidates(session, result.candidates);
        } else if (path === 'local') {
          // 本地未命中/歧义：记录既有 miss 事件语义（在线路结论单独记录）
          log.info('agent.reference.miss', {
            textHead: text.slice(0, 40),
            status,
            objects: result?.objects ?? null,
          });
        }
      });
    };

    /**
     * 跑自由轮廓一路：质检（不像时单次修正 + 复检）通过才进卡；
     * 失败时这一路视为失败——点序列图不展示这版、地图不画它的诊断线（方案 §3）。
     */
    // 自由轮廓质检 userText = 原始请求（session text）；用户经引导主动选择
    // "当前视野中心"时补充说明，与串行 resolveTarget 同口径（缺陷清单 Bug 2.5.4）
    const freeformReviewUserText = intent.centerChosen
      ? `${text}（用户已明确选择：画在当前视野中心，无需再确认地点）`
      : text;
    const runFreeformPath = async () => {
      if (!freeformShape) {
        session.paths.freeform.state = 'done';
        session.paths.freeform.result = { status: 'absent' };
        log.info('agent.freeform.notProduced', {});
        bump();
        return;
      }
      // 自由轮廓一路的失败兜底与参考路不同：写 result + 专用失败日志（其余骨架共用）
      await runPathSkeleton('freeform', async (pathSignal) => {
        onProgress({ text: '自检自由轮廓…', kind: 'step' });
        // 每次质检/修正调用的响应元数据（finishReason/正文长度/推理 token）：
        // 方案 2026-11-08 §5.1 要求原始响应与修正响应的证据都贯通到最终事件。
        const llmResponses = [];
        const outcome = await reviewTargetShape({
          userText: freeformReviewUserText,
          customShape: freeformShape,
          referenceDataUrl: null,
          userConstraints: intent.userConstraints || [],
          recoveryMode: recoveryMode(),
          callLlm: async (messages, meta) => {
            const phase = meta?.phase ?? 'verdict';
            const result = await trace.withSpan(
              'shape.review.llm',
              () =>
                chatCompletion({
                  messages,
                  signal: pathSignal,
                  // 修正请求只发一次（retries=0），180 秒截止即停，不自动再发
                  retries: phase === 'revision' ? 0 : undefined,
                  timeoutMs: phase === 'revision' ? FREEFORM_REVISION_TIMEOUT_MS : undefined,
                }),
              { shapeName: freeformShape.name, phase },
            );
            const meta2 = llmMetaOf(result);
            if (meta2) {
              llmResponses.push({ phase, ...meta2 });
            }
            return result;
          },
          renderOutline: shapeReviewDeps.renderOutline || renderOutlineDataUrl,
          deadlineAt: performance.now() + SHAPE_REVIEW_BUDGET_MS,
          onEvent: (event) => log.info('shape.review', event),
          onProgress,
        });
        session.paths.freeform.state = 'done';
        const finalShape = outcome.adopted && outcome.customShape ? outcome.customShape : freeformShape;
        const acceptance = acceptTarget({ source: 'freeform', customShape: finalShape, review: outcome, userText: text, userConstraints: intent.userConstraints || [] });
        const qualified = isTargetQualified(acceptance);
        log.info('agent.threeSources.freeform', {
          available: outcome.available === true,
          verdict: outcome.verdict ?? 'unknown',
          adopted: outcome.adopted === true,
          qualified,
          // 目标版本：v1 = 首轮 T；v2 = 修正版被采纳并复检
          targetVersion: outcome.adopted ? 2 : 1,
          pointCount: finalShape?.outlinePoints?.length ?? 0,
          featureCount: finalShape?.features?.length ?? 0,
          reasons: acceptance.reasons,
          skipped: outcome.skipped ?? null,
          // 验收证据（点数门/拓扑/视觉/约束）：候选轮即可读到，不再"已执行但 checks 为空"
          checks: acceptance.checks ?? {},
          constraintResults: acceptance.constraintResults ?? [],
          // 每版 T 的分别结论（首轮失败 / 修正版复检结论）
          attempts: outcome.attempts ?? [],
          // 终止原因：截断与普通失败分开
          terminatedWith: outcome.terminatedWith ?? null,
          failureKind: outcome.failureKind ?? null,
          failureMessage: outcome.failureMessage ?? null,
          // 原始响应与修正响应的 finishReason / 正文长度 / 推理 token
          llmResponses,
          traceId: trace?.id ?? null,
        });
        if (!qualified) {
          // 自由轮廓这一路失败：不入场（不进卡、不展示点列图、不画诊断线）
          session.paths.freeform.result = { status: 'rejected', reasons: acceptance.reasons };
          log.info('agent.freeform.qualityFailed', {
            verdict: outcome.verdict ?? 'unknown',
            reasons: acceptance.reasons,
            adopted: outcome.adopted === true,
          });
          return;
        }
        const candidate = buildFreeformCandidate(finalShape, { review: outcome, intent });
        session.paths.freeform.result = { status: 'ok', contentHash: candidate.contentHash };
        addThreeSourceCandidates(session, [candidate]);
        log.info('agent.freeform.qualified', {
          contentHash: candidate.contentHash,
          pointCount: finalShape?.outlinePoints?.length ?? 0,
          featureCount: finalShape?.features?.length ?? 0,
          adopted: outcome.adopted === true,
        });
      }, {
        onError: (error) => {
          session.paths.freeform.state = 'done';
          session.paths.freeform.result = { status: 'failed', error: error?.message ?? String(error) };
          log.warn('agent.freeform.failed', { message: error?.message ?? String(error) });
        },
      });
    };

    onProgress({ text: '同时检索本地素材、在线素材，并自检目标轮廓…', kind: 'step' });
    // 三路同一轮发起：本地与在线互不等待，自由轮廓质检同时进行
    void runReferencePath('local', (pathSignal) =>
      referenceCandidatesSource.resolveLocalCandidates(text, {
        intent,
        limit: REFERENCE_CHOICE_LIMIT,
        signal: pathSignal,
      }),
    );
    void runReferencePath('online', (pathSignal) =>
      referenceCandidatesSource.resolveOnlineCandidates(text, {
        intent,
        limit: REFERENCE_CHOICE_LIMIT,
        signal: pathSignal,
      }),
    );
    void runFreeformPath();

    const paths = ['local', 'online', 'freeform'];
    /** 构造待选返回（reply/referenceChoice 与既有候选轮结构一致） */
    const buildAwaiting = () => {
      session.status = 'awaiting-selection';
      publishThreeSourceSnapshot(session);
      log.info('agent.threeSources.awaiting', {
        choiceId: session.choiceId,
        candidateCount: session.candidates.length,
        byOrigin: countCandidatesByOrigin(session.candidates),
        pendingPaths: paths.filter((name) => !isThreeSourcePathSettled(session.paths[name])),
      });
      return {
        reply: `请选择一个目标轮廓（共 ${session.candidates.length} 个候选）：`,
        planned: null,
        shape: null,
        outline: null,
        referenceChoice: JSON.parse(JSON.stringify(buildThreeSourceSnapshot(session))),
      };
    };

    while (true) {
      throwIfAborted(signal, '已停止');
      const allSettled = paths.every((name) => isThreeSourcePathSettled(session.paths[name]));
      if (allSettled) {
        if (isLocalOnlyHit(session)) {
          // 自动规划唯一条件：在线与自由轮廓都失败，且本地唯一对象命中整词（方案 §2）
          const candidate = session.candidates[0];
          const nextIntent = applyReferenceCandidate(intent, candidate, { choiceId: null, confirmation: null });
          session.status = 'auto-plan';
          onProgress({
            text: `参考图命中「${nextIntent.referenceSource.name}」→ ${nextIntent.referenceSource.pointCount} 点目标轮廓（本地精选 · ${nextIntent.referenceSource.license ?? '许可见来源'}）`,
            kind: 'step',
          });
          log.info('agent.threeSources.autoPlan', {
            choiceId: session.choiceId,
            candidateCount: session.candidates.length,
            assetId: nextIntent.referenceSource.id,
            matchedAlias: nextIntent.referenceSource.matchedAlias,
            onlineStatus: session.paths.online.result?.status ?? null,
            freeformStatus: session.paths.freeform.result?.status ?? null,
          });
          log.info('agent.reference.used', {
            assetId: nextIntent.referenceSource.id,
            matchedAlias: nextIntent.referenceSource.matchedAlias,
            pointCount: nextIntent.referenceSource.pointCount,
            license: nextIntent.referenceSource.license,
            origin: 'local',
            contentHash: candidate.contentHash,
          });
          // 三路都已结束：清空会话引用（无未完成路可取消）；自动规划不展示候选卡，
          // 过程快照一并清掉（否则 UI 会同时出现待选卡与已规划回复）
          threeSourceSession = null;
          referenceChoice = null;
          return { intent: nextIntent };
        }
        if (session.candidates.length === 0) {
          // 三路都没有可用轮廓：不规划、不画线（回复固定句）
          session.status = 'none';
          log.info('agent.threeSources.none', {
            choiceId: session.choiceId,
            local: session.paths.local.result?.status ?? session.paths.local.error ?? null,
            online: session.paths.online.result?.status ?? session.paths.online.error ?? null,
            freeform: session.paths.freeform.result?.status ?? session.paths.freeform.error ?? null,
          });
          threeSourceSession = null;
          // 把自由轮廓的验收失败原因带出去（方案 2026-11-08 §5.2）：回复要说明
          // 主要原因（点数/语义/拓扑/截断），而不是笼统一句"没有可用轮廓"
          return {
            noContour: true,
            reasons: Array.isArray(session.paths.freeform.result?.reasons)
              ? session.paths.freeform.result.reasons
              : [],
            freeformStatus: session.paths.freeform.result?.status ?? null,
          };
        }
        return { awaiting: true, result: buildAwaiting() };
      }
      if (session.candidates.length > 0) {
        // 本地唯一命中时须等其他两路结论才能决定自动规划（还有一路没返回时不自动规划）；
        // 其余情况已有候选即可出卡，剩余路后台继续追加（不等最慢一路）
        if (!isLocalOnlyHit(session)) {
          return { awaiting: true, result: buildAwaiting() };
        }
      }
      await waitChange(changeVersion);
    }
  }


  /**
   * 用户点击候选后的规划入口（方案 §6.2）：不重新进入 handleSend、地点引导、
   * 候选检索或 LLM 解析，直接 resolveTarget → executePlan。
   *
   * @param {{choiceId: string, candidateId: string, contentHash: string}} selection 选择信息
   * @param {(step: object) => void} [onProgress] 推理过程回调
   * @param {{signal?: AbortSignal}} [options] 中止信号（候选轮与规划轮都响应"停止"）
   * @returns {Promise<object>} 与 send() 规划完成时相同的结果结构
   */
  async function chooseReferenceCandidate(selection = {}, onProgress = () => {}, { signal = null } = {}) {
    const { choiceId, candidateId, contentHash } = selection;
    const pending = referenceChoice;
    // 用户点了某一版：立刻取消尚未返回的其余路（方案 2026-11-01 §2）并规划。
    // 已到达的候选保留；未返回的在线检索/自由轮廓质检不再继续消耗时间。
    cancelThreeSourceSession('user-selection');
    const candidate =
      pending && pending.status === 'awaiting-selection' && pending.choiceId === choiceId
        ? (pending.candidates || []).find(
            (item) => item.candidateId === candidateId && item.contentHash === contentHash,
          ) || null
        : null;
    if (!candidate) {
      // 无效、过期或跨会话选择：清除旧待选状态，不规划（引擎调用次数为 0）
      log.warn('reference.selection.invalid', {
        choiceId: choiceId ?? null,
        candidateId: candidateId ?? null,
        hasPending: Boolean(pending),
        pendingChoiceId: pending?.choiceId ?? null,
        pendingStatus: pending?.status ?? null,
      });
      discardReferenceChoice('invalid-selection');
      return {
        reply: '候选已失效，请重新生成。',
        planned: null,
        shape: null,
        outline: null,
      };
    }

    // 新的规划轮 trace：不复用候选轮 traceId（§7.1 choiceId 绑定跨轮关联）
    const planningTrace = beginTrace('turn', {
      kind: 'reference-planning',
      text: pending.originalText,
      choiceId,
      sourceTraceId: pending.sourceTraceId,
      candidateId,
      online: candidate.origin === 'online',
    });
    const tracedProgress = (step) => {
      if (step && step.kind === 'step' && step.text) {
        planningTrace.step(step.text);
      }
      onProgress(step);
    };
    /** 失败/停止时恢复待选快照，用户可以换一张卡重选 */
    const restorePending = () => {
      referenceChoice = pending;
    };
    try {
      const confirmation = {
        type: 'user-selection',
        choiceId,
        candidateId,
        contentHash,
        sourceTraceId: pending.sourceTraceId,
      };
      const selectedIntent = JSON.parse(JSON.stringify(pending.intent));
      const selectedCandidate = JSON.parse(JSON.stringify(candidate));
      // 自由轮廓候选：目标就是进卡时通过质检的那一版 T，选择后复用质检结论；
      // 参考候选：沿用参考命中信息与用户确认绑定（第二道验收防御）。
      const intent = candidate.origin === 'freeform'
        ? applyFreeformCandidate(selectedIntent, selectedCandidate, { choiceId })
        : applyReferenceCandidate(selectedIntent, selectedCandidate, { choiceId, confirmation });
      // 选择后清理：未选候选几何清除，只保留选择记录与选中 T（方案 §6.4）
      referenceChoice = {
        ...pending,
        status: 'selected',
        selectedCandidateId: candidateId,
        confirmation,
        candidates: JSON.parse(JSON.stringify([candidate])),
      };
      planningTrace.info('reference.selected', {
        choiceId,
        candidateId,
        contentHash,
        sourceTraceId: pending.sourceTraceId,
        origin: candidate.origin,
        reviewStatus: candidate.reviewStatus,
        assetId: candidate.asset?.id ?? null,
      });
      const target = await resolveTarget(intent, pending.originalText, null, tracedProgress, planningTrace, signal);
      throwIfAborted(signal, '已停止');
      const result = await executePlan(intent, pending.originalText, tracedProgress, planningTrace, null, target, signal);
      planningTrace.info('agent.reply', {
        reply: result.reply,
        plannedStatus: result.planned?.status ?? null,
        planned: summarizePlanned(result.planned),
      });
      planningTrace.end({
        replyLength: typeof result.reply === 'string' ? result.reply.length : 0,
        plannedStatus: result.planned?.status ?? null,
        choiceId,
        sourceTraceId: pending.sourceTraceId,
      });
      return {
        ...result,
        traceId: planningTrace.id,
        choiceId,
        sourceTraceId: pending.sourceTraceId,
        scalePool: currentScalePoolView(),
      };
    } catch (error) {
      if (isAbortError(error) || isAborted(signal)) {
        planningTrace.end({ aborted: true, message: error?.message ?? '已停止', choiceId });
      } else {
        planningTrace.fail(error, { choiceId, candidateId });
      }
      restorePending();
      if (error && typeof error === 'object') {
        try {
          error.traceId = planningTrace.id;
        } catch {
          // 只读错误对象忽略
        }
      }
      throw error;
    }
  }

  /** 目标验收结论日志（resolveTarget 3 个来源分支共用；分支差异走 extra 附加字段）。 */
  function logAcceptance({ source, acceptance, targetVersion, shapeName, extra = {} }) {
    log.info(acceptance.verdict === 'pass' ? 'target.accepted' : 'target.rejected', {
      targetVersion,
      source,
      shapeName,
      verdict: acceptance.verdict,
      reasons: acceptance.reasons,
      checks: acceptance.checks,
      constraintResults: acceptance.constraintResults ?? [],
      ...extra,
    });
  }

  /**
   * 目标轮廓质检调用（resolveTarget 两处共用：约束核验 / 自由轮廓闭环）：
   * 统一 LLM span、渲染器、预算、事件日志与进度回调的注入口径（B2 去重）。
   */
  function runShapeReview({
    trace, signal, onProgress, userText, customShape, referenceDataUrl = null, userConstraints = [],
    spanName, spanMetaOf = (meta) => ({ phase: meta?.phase ?? 'verdict' }), withRecoveryMode = false, allowRevision = true,
  }) {
    const review = allowRevision ? reviewTargetShape : verifyConstraintsByReview;
    return review({
      userText,
      customShape,
      referenceDataUrl,
      userConstraints,
      ...(withRecoveryMode ? { recoveryMode: recoveryMode() } : {}),
      callLlm: (messages, meta) =>
        trace.withSpan(spanName, () => chatCompletion({ messages, signal }), spanMetaOf(meta)),
      renderOutline: shapeReviewDeps.renderOutline || renderOutlineDataUrl,
      deadlineAt: performance.now() + SHAPE_REVIEW_BUDGET_MS,
      onEvent: (event) => log.info('shape.review', event),
      onProgress,
    });
  }

  /**
   * 目标语义验收（方案 §8：先于正式路网规划与绿线交付）。
   *
   * 按目标来源分派验收依据：
   * - builtin：轮廓由几何定义保证，直接通过（记录来源）。
   * - procedural：参数化 T 过 S 几何不变量 + 拓扑复验（确定性检查，无需视觉质检）。
   * - reference：参考图模块已校验，记录来源并复验拓扑。
   * - traced：图像描摹 T 做确定性验收（拓扑 + 点数区间 + 描摹 IoU），不视觉质检。
   * - freeform：视觉质检闭环（质检 → 按需修正 → 复检）+ 用户显式约束逐项核对，
   *   合取通过才合格；质检不可用/结论不明一律按未验收处理，不得给合格绿线。
   *
   * targetVersion：v1 为首轮 T；自由轮廓修正被采纳并复检后为 v2。日志记录每版
   * 的完整验收结论（方案 §10）。
   *
   * @param {object} intent 归一化意图
   * @param {string} text 用户原文（**原始请求文本**；引导补地点轮次不得传引导回答，
   *   否则视觉质检在错误语境下判定——缺陷清单 Bug 2）
   * @param {string|null} imageDataUrl 用户参考图
   * @param {(step: object) => void} onProgress 推理过程回调
   * @param {object} trace 当前链路
   * @returns {Promise<object|null>} null = 非规划意图；否则
   *   {source, customShape, spec, acceptance, review, targetVersion, blocked}
   */
  async function resolveTarget(intent, text, imageDataUrl, onProgress, trace, signal = null) {
    if (intent.action !== 'plan') {
      return null;
    }
    // 规格无法生成合法图形：完全不规划（方案 §8.5 第一行），编排层诚实失败
    if (intent.planBlocked) {
      return {
        source: null,
        customShape: null,
        spec: null,
        acceptance: { verdict: 'fail', reasons: [intent.planBlocked], checks: {} },
        review: null,
        targetVersion: 0,
        blocked: intent.planBlocked,
      };
    }
    const source = intent.referenceSource
      ? 'reference'
      : intent.customShape?.source === 'traced'
        ? 'traced'
        : intent.customShape?.source === 'procedural'
          ? 'procedural'
          : intent.customShape
            ? 'freeform'
            : 'builtin';

    if (source !== 'freeform') {
      const userConstraints = Array.isArray(intent.userConstraints) ? intent.userConstraints : [];
      // 有用户显式约束、但目标**不可由模型重新生成**时（参考素材/内置图形/图像描摹）：
      // 借视觉质检能力逐项核对约束（方案 2026-11-08 §4.1）。核不了就不给绿线。
      let constraintReview = null;
      if (userConstraints.length > 0) {
        const reviewShape =
          source === 'builtin' ? builtinReviewShape(intent.shapeKey) : intent.customShape;
        if (reviewShape) {
          onProgress({ text: '核对用户提出的图形要求…', kind: 'step' });
          constraintReview = await runShapeReview({
            trace, signal, onProgress, userText: text, customShape: reviewShape, userConstraints,
            spanName: 'target.constraintReview.llm',
            spanMetaOf: (meta) => ({ phase: meta?.phase ?? 'verdict', source }),
            allowRevision: false,
          });
        }
      }
      let acceptance = acceptTarget({
        source,
        customShape: intent.customShape,
        spec: intent.shapeSpec,
        referenceSource: intent.referenceSource,
        review: constraintReview,
        // 图像描摹目标：确定性验收用描摹元数据（点数区间 + 描摹 IoU，方案 2026-11-01 §3）
        traceMeta: intent.customShape?.trace ?? null,
        userText: text,
        userConstraints,
      });
      // 约束漏解析 fail-open 防御（缺陷清单 Bug 4.1）：这些来源没有逐项约束核对，
      // 意图又漏记 userConstraints、原文却疑似包含显式要求时，"绿灯"等于没核对——
      // 降级为未验收（橙色诊断参考 + 明确原因），不得无核对绿线交付（H06 教训）。
      if (acceptance.verdict === 'pass' && userConstraints.length === 0) {
        const suspected = detectPossibleConstraintText(text);
        if (suspected.suspected) {
          acceptance = {
            ...acceptance,
            verdict: 'unavailable',
            reasons: [
              `用户原文疑似包含显式图形要求（${suspected.cues.join('、')}），但意图没有解析出可核对的约束清单，该要求无法逐项核对——按未验收处理`,
            ],
            checks: { ...acceptance.checks, constraintSuspected: suspected.cues },
          };
          log.warn('target.constraints.suspected', {
            source,
            cues: suspected.cues,
            shapeName: intent.customShape?.name ?? null,
          });
        }
      } else if (userConstraints.length > 0) {
        // 已解析出约束：逐条结论写在 acceptance.constraintResults 里（统一四态结构）
        log.warn('target.constraints.checked', {
          source,
          userConstraints,
          reviewVerdict: constraintReview?.verdict ?? null,
          constraintResults: acceptance.constraintResults ?? [],
        });
      }
      logAcceptance({
        source,
        acceptance,
        targetVersion: 1,
        shapeName: intent.customShape?.name ?? null,
      });
      return {
        source,
        customShape: intent.customShape,
        spec: intent.shapeSpec,
        acceptance,
        review: null,
        targetVersion: 1,
        blocked: null,
      };
    }

    // 三路候选中的自由轮廓版本：质检（含单次修正与复检）已在候选轮完成，进卡的
    // 就是通过验收的那一版点列——用户点选后复用质检结论，不重复调用模型
    // （方案 2026-11-01 §2「自由轮廓只有质检通过的那一版能进卡」）。
    if (intent.freeformReview) {
      const finalShape = intent.customShape;
      const review = { ...intent.freeformReview, available: true, customShape: null };
      const targetVersion = review.adopted ? 2 : 1;
      const acceptance = acceptTarget({ source: 'freeform', customShape: finalShape, review, userText: text, userConstraints: intent.userConstraints || [] });
      logAcceptance({
        source,
        acceptance,
        targetVersion,
        shapeName: finalShape?.name ?? null,
        extra: { reusedReview: true, reviewVerdict: review.verdict ?? null, adopted: review.adopted === true },
      });
      return {
        source,
        customShape: finalShape,
        spec: null,
        acceptance,
        review,
        targetVersion,
        blocked: null,
      };
    }

    // 自由轮廓：视觉质检闭环（含修正与复检；Node/无画布环境自动按未验收处理）
    // 质检 userText = 原始请求；用户经引导主动选择"当前视野中心"时补充说明，
    // 避免质检模型误以为用户在原文里否定过地点（缺陷清单 Bug 2.5.4）
    const reviewUserText = intent.centerChosen
      ? `${text}（用户已明确选择：画在当前视野中心，无需再确认地点）`
      : text;
    const outcome = await runShapeReview({
      trace, signal, onProgress, userText: reviewUserText, customShape: intent.customShape,
      referenceDataUrl: imageDataUrl, userConstraints: intent.userConstraints || [],
      spanName: 'shape.review.llm', spanMetaOf: () => ({ shapeName: intent.customShape.name }),
      withRecoveryMode: true,
    });
    /** 采纳修正版时目标版本递增（v2 = 修正版），最终 T 与验收都用同一版 */
    const finalShape =
      outcome.adopted && outcome.customShape ? outcome.customShape : intent.customShape;
    const targetVersion = outcome.adopted ? 2 : 1;
    const acceptance = acceptTarget({ source: 'freeform', customShape: finalShape, review: outcome, userText: text, userConstraints: intent.userConstraints || [] });
    logAcceptance({
      source,
      acceptance,
      targetVersion,
      shapeName: finalShape.name,
      extra: {
        attempts: outcome.attempts || [],
        adopted: outcome.adopted || false,
        userConstraints: intent.userConstraints || [],
      },
    });
    if (outcome.adopted) {
      // 目标替换留痕：新旧版本各自的验收结论（方案 §10）
      log.info('target.replaced', {
        fromVersion: 1,
        toVersion: 2,
        reason: '视觉自检不像/约束未满足，按反馈修正并复检',
        oldAttempt: outcome.attempts?.[0] ?? null,
        newAttempt: outcome.attempts?.[1] ?? null,
        finalVerdict: acceptance.verdict,
      });
    }
    return {
      source,
      customShape: finalShape,
      spec: intent.shapeSpec,
      acceptance,
      review: outcome,
      targetVersion,
      blocked: null,
    };
  }

  /** 按意图类型执行（plan/recommend）；plan 先过参考候选解析（§3），再过统一目标语义验收硬闸门 */
  async function executeIntent(intent, text, onProgress, trace, imageDataUrl = null, signal = null, { referenceText = null, requestText = null } = {}) {
    throwIfAborted(signal, '已停止');
    // 原始请求文本（缺陷清单 Bug 2）：引导补地点轮次里 text 是引导回答，
    // 视觉质检 userText、目标失败回复、地点追问的 sourceText 都必须用原始请求，
    // 否则质检在"就在当前视野中心画"这种错误语境下判定（误杀/误放/越修越偏）。
    const originalRequestText = requestText || referenceText || text;
    // 城市点名路由（方案 2026-11-08 §6.2）：用户点名另一座城市时，按该城状态诚实路由，
    // 绝不把路线画进别的城市、也不退回当前城市核心区冒充（需求 R2/R4 边界）。
    if (intent.place && !intent.centerChosen) {
      const cityRoute = await routeCityMention(intent.place, { onProgress });
      if (cityRoute?.blocked) {
        pushHistory(text, cityRoute.reply);
        trace.info('agent.city.mention.blocked', { place: intent.place, cityId: cityRoute.cityId });
        return { reply: cityRoute.reply, planned: null, shape: null, outline: null };
      }
    }
    if (intent.action !== 'plan') {
      return executeRecommend(intent, text, onProgress, trace, signal, { requestText: originalRequestText });
    }
    // 三种轮廓同一轮（方案 2026-11-01 §2）：适用条件与参考通道一致（非内置/非参数化/
    // 无用户图片/非图像描摹目标），且生产默认参考源同时具备本地/在线独立入口。
    // 本地素材 + 在线检索 + 自由轮廓质检并行；点选前引擎 0 次调用。
    const sourceText = referenceText || text;
    // 多对象请求（方案 2026-11-05 §4.2）：先走多对象参考通道——
    // 全部命中就组合 multi-part 目标，部分命中就诚实追问，绝不单候选自动规划。
    const multiPhase = await resolveMultiObjectPhase(intent, sourceText, onProgress, trace, signal);
    if (multiPhase?.awaiting) {
      return multiPhase.result;
    }
    if (multiPhase?.intent) {
      const multiTarget = await resolveTarget(multiPhase.intent, originalRequestText, imageDataUrl, onProgress, trace, signal);
      throwIfAborted(signal, '已停止');
      return executePlan(multiPhase.intent, text, onProgress, trace, imageDataUrl, multiTarget, signal, { requestText: originalRequestText });
    }
    const threeSourceApplicable =
      supportsThreeSourcePhase(referenceCandidatesSource)
      && !imageDataUrl
      && !intent.shapeKey
      && !intent.shapeSpec
      && intent.customShape?.source !== 'traced';
    if (threeSourceApplicable) {
      const threePhase = await resolveThreeSourcePhase(intent, sourceText, onProgress, trace, signal);
      if (threePhase?.awaiting) {
        return threePhase.result;
      }
      if (threePhase?.noContour) {
        // 生成阶段已诚实失败（planBlocked，如点列两轮不合法/规格无法生成）：
        // 具体失败原因必须优先于三路固定句。三路阶段仍先跑（保留"参考命中恢复
        // plan 通道"的语义），但无候选且本就有生成失败原因时走原 resolveTarget +
        // executePlan 的 blocked 分支，输出「「X」这次没能生成出来：<原因>」——
        // 一个笼统句会把可行动的原因（首轮/重生成轮各失败在哪）全顶掉（审查 M2）。
        if (intent.planBlocked) {
          log.info('agent.threeSources.noContour.planBlocked', {
            planBlocked: intent.planBlocked,
            shapeBlockedName: intent.shapeBlockedName ?? null,
          });
          const blockedTarget = await resolveTarget(intent, originalRequestText, imageDataUrl, onProgress, trace, signal);
          throwIfAborted(signal, '已停止');
          return executePlan(intent, text, onProgress, trace, imageDataUrl, blockedTarget, signal, { requestText: originalRequestText });
        }
        // 三路都没有可用轮廓：不规划、不画线，回复点明目标与主要原因
        // （多对象请求时点名用户要的每个对象——通用句「没有可用轮廓」会让用户
        //  不知道是哪个对象没画出来，方案 2026-11-05 §4.2 要求列出缺失对象；
        //  单对象也必须说明原因与对应下一步，方案 2026-11-08 §5.2）
        engine.clearDraw();
        const noContourReply = composeNoContourReply(intent, {
          reasons: threePhase.reasons ?? [],
          shapeName: intent?.customShape?.name ?? intent?.shapeBlockedName ?? null,
        });
        pushHistory(text, noContourReply);
        log.info('agent.reply', {
          reply: noContourReply,
          plannedStatus: null,
          noContour: true,
          noContourReasons: threePhase.reasons ?? [],
          noContourCategory: classifyNoContourReason(threePhase.reasons ?? []).category,
        });
        return { reply: noContourReply, planned: null, shape: null, outline: null };
      }
      const threeIntent = threePhase?.intent ?? intent;
      const threeTarget = await resolveTarget(threeIntent, originalRequestText, imageDataUrl, onProgress, trace, signal);
      throwIfAborted(signal, '已停止');
      return executePlan(threeIntent, text, onProgress, trace, imageDataUrl, threeTarget, signal, { requestText: originalRequestText });
    }
    // 旧串行链路（内置/参数化/图像描摹目标/非生产注入参考源）：保持既有行为。
    // referenceText：引导补地点的场景用发起引导的原始文本匹配（选项文本没有对象名）；
    // 单本地候选直走；多候选/在线候选返回待选结果（引擎调用次数为 0）；
    // 未命中/失败回退原参数化/自由轮廓链路。
    const phase = await resolveReferencePhase(intent, sourceText, onProgress, trace, signal, imageDataUrl);
    if (phase?.awaiting) {
      return phase.result;
    }
    const phaseIntent = phase?.intent ?? intent;
    // 目标语义验收先于正式路网规划（方案 §8）：参数化/内置/参考图做确定性检查，
    // 自由轮廓走视觉质检闭环；验收结论决定正式规划、诊断参考还是诚实失败
    const target = await resolveTarget(phaseIntent, originalRequestText, imageDataUrl, onProgress, trace, signal);
    throwIfAborted(signal, '已停止');
    return executePlan(phaseIntent, text, onProgress, trace, imageDataUrl, target, signal, { requestText: originalRequestText });
  }

  /** 引导中：选项本地填充或自由文本 LLM 合并，逐槽补齐，需求明确后执行 */
  async function continueGuide(text, onProgress, trace, signal = null) {
    let ack = '';
    const filled = fillFromOption(guideState, text, placeConfig);
    if (filled) {
      ack = filled.ack;
      // 选项点击是本地状态机（不耗 LLM），留痕后才能区分"点了选项"与"自由文本回答"
      log.info('guide.option', { text, ack });
    } else {
      // 自由文本：LLM 重解析（历史含引导问题，LLM 能理解上下文）后合并进引导状态
      onProgress({ text: '理解需求…', kind: 'step' });
      const messages = [
        { role: 'system', content: buildSystemPrompt(placeConfig) },
        ...history,
        buildUserMessage(text, null),
      ];
      log.info('guide.freeText', { text, historyCount: history.length });
      let next;
      try {
        const raw = await trace.withSpan(
          'agent.guide.reparse',
          () => chatCompletion({ messages, signal }),
          { text, historyCount: history.length },
        );
        next = await parseIntentWithRecovery(raw, text, {
          explicitSizeMeters: extractExplicitSizeMeters(text),
          trace,
          signal,
          onProgress,
        });
      } catch (error) {
        // 用户点"停止"：中止错误不能被包装成"解析失败"（否则停止会变成一次正常追问回复）
        rethrowIfAborted(error, signal);
        log.error('guide.intent.failed', { text }, error);
        // 解析型失败（超时/模型返回无法解析/截断）：重新抛出当前问题，不暴露原始错误
        if (isParseFailure(error)) {
          const slot = nextMissingSlot(guideState);
          const { question, options } = questionFor(slot, placeConfig);
          const reply = `这个我没能理解。\n${question}`;
          pushHistory(text, reply);
          log.warn('guide.reparse.unparsable', { slot, reply, kind: errorKindOf(error) });
          return { reply, planned: null, guide: { slot, options } };
        }
        throw withErrorKind(new Error(`智能体解析失败：${error.message}`), errorKindOf(error));
      }
      log.info('guide.intent', summarizeIntent(next));
      if (next.action === 'chat') {
        // 闲聊/反问：回应并重新抛出当前问题选项
        const slot = nextMissingSlot(guideState);
        const { question, options } = questionFor(slot, placeConfig);
        const reply = `${next.reply || '好的。'}\n${question}`;
        pushHistory(text, reply);
        log.info('guide.chat', { slot, reply });
        return { reply, planned: null, guide: { slot, options } };
      }
      mergeIntentInto(guideState, next, { sizeLocked: extractExplicitSizeMeters(text) !== null });
      ack = '好的，记下了。';
      log.info('guide.merged', { text, slot: nextMissingSlot(guideState), ack });
    }

    const slot = nextMissingSlot(guideState);
    if (slot) {
      const { question, options } = questionFor(slot, placeConfig);
      const reply = ack ? `${ack}\n${question}` : question;
      pushHistory(text, reply);
      log.info('guide.question', { slot, question, options: options.map((option) => option.label) });
      return { reply, planned: null, guide: { slot, options } };
    }

    // 需求明确：确认语 + 执行（referenceText/requestText 用发起引导的原始文本——
    // 参考候选匹配需要对象名，选项文本只有地点；视觉质检 userText 也必须是原始请求，
    // 引导回答只用于引导状态与 history，缺陷清单 Bug 2）
    const intent = finalizeIntent(guideState);
    intent.centerChosen = guideState.placeCenterChosen;
    intent.reply = confirmLine(intent, guideState);
    const referenceText = guideState.sourceText || null;
    guideState = null;
    log.info('guide.done', { ...summarizeIntent(intent), confirm: intent.reply });
    return executeIntent(intent, text, onProgress, trace, null, signal, { referenceText, requestText: referenceText });
  }



  /** send/handleSend 运行时（C4-5 搬到 pipeline/send.js；引导/监听/历史用访问器注入）。 */
  const sendRuntime = createSendRuntime({
    pushHistory,
    getHistory: () => history,
    getGuideState: () => guideState,
    setGuideState: (value) => { guideState = value; },
    getPendingAlternative: () => pendingAlternative,
    setReferenceCandidateListener: (listener) => { referenceCandidateListener = listener; },
    currentScalePoolView,
    placeConfig,
    traceImage,
    replyTemplates,
    runtime: {
      deliverAlternativeSwitch,
      discardPendingAlternative,
      discardScaleCandidates,
      discardReferenceChoice,
      continueGuide,
      executeIntent,
    },
  });
  const { send } = sendRuntime;

  /**
   * 导出当前会话上下文（对话历史 + 引导状态 + 待选候选快照）。
   *
   * 需求 R1/R4：每个对话有独立的上下文，切换对话时把当前上下存回会话存储，
   * 切回来时原样恢复——"查看历史图形不影响对话本身：后续继续对话时，智能体的
   * 理解与查看前一致"。待选几何保存在 context.referenceChoice（方案 §6.4），
   * 刷新后据此重新渲染候选卡的实际 T。
   *
   * @returns {{history: Array<object>, guideState: object|null, referenceChoice: object|null}} 上下文快照
   */
  function exportContext() {
    return {
      history: history.map((item) => ({ role: item.role, content: item.content })),
      guideState: guideState ? JSON.parse(JSON.stringify(guideState)) : null,
      referenceChoice: referenceChoice ? JSON.parse(JSON.stringify(referenceChoice)) : null,
    };
  }

  /**
   * 导入指定会话的上下文（切换对话时调用）。
   *
   * @param {{history?: Array<object>, guideState?: object|null, referenceChoice?: object|null}} context 上下文快照
   */
  function importContext(context) {
    // 切换会话：取消上一个会话尚未返回的三路（迟到结果不得写入新会话上下文）；
    // 待切换备选属于上一会话的交付上下文，一并丢弃（缺陷清单 Bug 5 清理要求）
    cancelThreeSourceSession('session-switch');
    discardPendingAlternative('session-switch');
    discardScaleCandidates('session-switch');
    history.length = 0;
    if (Array.isArray(context?.history)) {
      for (const item of context.history) {
        if (item && typeof item.role === 'string' && typeof item.content === 'string') {
          history.push({ role: item.role, content: item.content });
        }
      }
    }
    guideState = context?.guideState ?? null;
    const importedChoice = context?.referenceChoice ?? null;
    if (referenceChoice && referenceChoice.status === 'awaiting-selection' && importedChoice?.choiceId !== referenceChoice.choiceId) {
      log.info('reference.selection.discarded', { choiceId: referenceChoice.choiceId, reason: 'session-switch' });
    }
    // 只恢复等待中的待选（已选定的快照仅作历史留痕，不能再点击选择）
    referenceChoice =
      importedChoice && importedChoice.status === 'awaiting-selection' ? importedChoice : null;
  }

  return {
    send,
    chooseReferenceCandidate,
    switchScaleCandidate,
    attachScalePoolMessage,
    exportContext,
    importContext,
    onCitySwitched,
  };
}
