/**
 * 三路参考候选（本地素材 / 在线检索 / 自由轮廓质检）的会话与候选辅助
 * （C4 拆分自 controller.js，纯逻辑 + 显式依赖）。
 *
 * 边界：时序控制（waitChange/主等待循环/AbortController 生命周期）仍留在
 * controller.js 的 resolveThreeSourcePhase；本模块只放纯函数与"访问器注入"的状态操作。
 */

import { createId } from '../../log/core.js';
import { sha256Hex, stableStringify } from '../../reference/hash.js';
import { composeObjectShortfallReply } from '../request-objects.js';

/** 自由轮廓候选内容哈希载荷 schema（与参考候选同一套稳定序列化 + 纯 JS SHA-256） */
const FREEFORM_CANDIDATE_HASH_SCHEMA = 'freeform-candidate-v1';

/**
 * 把选中候选写入意图（方案 §6.2/§7/§8）：customShape 替换为候选归一化 T，
 * referenceSource 携带 origin/reviewStatus/哈希与确认信息，供目标验收校验。
 *
 * @param {object} intent 待执行意图（选择快照中的原始意图）
 * @param {object} candidate 统一候选
 * @param {{choiceId: string|null, confirmation: object|null}} binding 绑定信息
 * @returns {object} 新意图
 */
export function applyReferenceCandidate(intent, candidate, { choiceId = null, confirmation = null } = {}) {
  return {
    ...intent,
    // contentHash 随目标轮廓一起走：plan.request.customShape.contentHash 与候选一致，
    // 供链路验收断言「贴路 T 就是被点中的那一版」（方案 2026-11-01 §5.2）
    customShape: { ...candidate.customShape, contentHash: candidate.contentHash ?? null },
    shapeKey: null,
    shapeSpec: null,
    shapeSpecError: null,
    // 参考命中是有效目标：LLM 点名图形但两轮生成失败（planBlocked）时，
    // 命中即恢复 plan 通道，不再诚实失败
    planBlocked: null,
    shapeBlockedName: null,
    referenceSource: {
      id: candidate.asset?.id ?? null,
      name: candidate.asset?.displayName ?? candidate.asset?.names?.zh?.[0] ?? candidate.asset?.id ?? null,
      license: candidate.asset?.source?.license ?? null,
      matchedAlias: candidate.matchedAlias ?? null,
      pointCount: candidate.customShape.outlinePoints.length,
      origin: candidate.origin,
      reviewStatus: candidate.reviewStatus,
      sourceSha256: candidate.sourceSha256 ?? null,
      contentHash: candidate.contentHash,
      choiceId,
      candidateId: candidate.candidateId ?? null,
      confirmation,
      // 本地精选素材携带 manifest 审核块；在线素材不带（未审核）
      review: candidate.origin === 'local' ? candidate.asset?.review ?? null : null,
    },
  };
}

/**
 * 自由轮廓候选内容哈希：与参考候选同一套稳定序列化 + 纯 JS SHA-256。
 * 选择候选后 plan.request.customShape.contentHash 与候选一致（§5.2 链路断言）。
 *
 * @param {object} customShape 归一化自由轮廓
 * @returns {string} 内容哈希
 */
function freeformCandidateContentHash(customShape) {
  return sha256Hex(
    stableStringify({
      schema: FREEFORM_CANDIDATE_HASH_SCHEMA,
      name: customShape?.name ?? null,
      outlinePoints: customShape?.outlinePoints ?? [],
      parts: (customShape?.parts ?? []).map((part) => [part.outlineStart, part.outlineCount]),
    }),
  );
}

/**
 * 质检闭环结论的可序列化摘要（进候选卡与选择后复用；不含点列本身）。
 *
 * @param {object|null} outcome reviewTargetShape 结果
 * @returns {object|null} 可序列化摘要
 */
function summarizeFreeformReview(outcome) {
  if (!outcome) {
    return null;
  }
  return {
    available: outcome.available === true,
    verdict: outcome.verdict ?? 'unknown',
    seen: typeof outcome.seen === 'string' ? outcome.seen : '',
    issues: Array.isArray(outcome.issues) ? outcome.issues : [],
    constraints: Array.isArray(outcome.constraints) ? outcome.constraints : null,
    constraintSummary: outcome.constraintSummary ?? null,
    adopted: outcome.adopted === true,
    constraintFailed: outcome.constraintFailed === true,
    reReviewSkipped: outcome.reReviewSkipped ?? null,
    attempts: (Array.isArray(outcome.attempts) ? outcome.attempts : []).map((attempt) => ({
      version: attempt?.version ?? null,
      verdict: attempt?.verdict ?? null,
      seen: attempt?.seen ?? '',
      issues: attempt?.issues ?? [],
      skipped: attempt?.skipped ?? null,
    })),
  };
}

/**
 * 构造自由轮廓候选（只有质检通过的那一版能进卡，方案 §3）。
 *
 * @param {object} customShape 最终采纳的自由轮廓 T（修正版复检通过时为修正版）
 * @param {{review: object, intent: object}} options 质检闭环结果与原始意图
 * @returns {object} 统一候选（与参考候选同结构，origin='freeform'）
 */
export function buildFreeformCandidate(customShape, { review, intent }) {
  const contentHash = freeformCandidateContentHash(customShape);
  const name = customShape?.name || intent?.customShape?.name || '自由轮廓';
  return {
    asset: {
      id: `freeform-${contentHash.slice(0, 12)}`,
      displayName: name,
      names: { zh: [name], en: [] },
      source: { name: '自由轮廓（已质检）', url: null, license: null, attribution: null },
      tags: [],
      review: null,
    },
    customShape: { ...customShape, contentHash },
    conversion: null,
    matchedAlias: null,
    origin: 'freeform',
    reviewStatus: 'freeform-reviewed',
    sourceSha256: null,
    contentHash,
    review: summarizeFreeformReview(review),
  };
}

/**
 * 用户选中自由轮廓候选：意图替换为候选 T，并携带已通过复检的质检结论
 * （resolveTarget 复用结论，不重复调用模型）。
 *
 * @param {object} intent 选择的原始意图
 * @param {object} candidate 自由轮廓候选
 * @param {{choiceId?: string|null}} [binding]
 * @returns {object} 新意图
 */
export function applyFreeformCandidate(intent, candidate, { choiceId = null } = {}) {
  return {
    ...intent,
    customShape: { ...candidate.customShape, contentHash: candidate.contentHash ?? null },
    shapeKey: null,
    shapeSpec: null,
    shapeSpecError: null,
    planBlocked: null,
    shapeBlockedName: null,
    referenceSource: null,
    freeformReview: candidate.review ?? null,
  };
}

/**
 * 生产默认参考源是否支持三路并发（同时提供本地与在线独立入口）。
 * 旧注入源（{resolveCandidates} 单接口/旧单命中适配）保持旧串行链路。
 *
 * @param {object|null} source 参考候选源
 * @returns {boolean}
 */
export function supportsThreeSourcePhase(source) {
  return Boolean(
    source
    && typeof source.resolveLocalCandidates === 'function'
    && typeof source.resolveOnlineCandidates === 'function',
  );
}

/** 三路会话路径是否已结束（done/cancelled 都算结束；cancelled 只在整体取消时出现） */
export function isThreeSourcePathSettled(path) {
  return path.state !== 'running' && path.state !== 'pending';
}

/** 参考通道通用适用条件（多对象/单对象参考阶段共用）：plan、非内置/参数化/图像描摹目标；
 *  单对象参考阶段额外要求无用户图片。imageDataUrl 传入即按"有图片"处理。 */
export function canUseReferenceChannel(source, intent, { imageDataUrl = null } = {}) {
  return Boolean(
    source
    && intent
    && intent.action === 'plan'
    && !intent.shapeKey
    && !intent.shapeSpec
    && intent.customShape?.source !== 'traced'
    && !imageDataUrl,
  );
}

/** 三路会话是否「本地唯一命中」：本地路 ok、候选池恰好 1 个且来自本地（自动规划唯一条件）。 */
export function isLocalOnlyHit(session) {
  return session.paths.local.result?.status === 'ok'
    && session.candidates.length === 1
    && session.candidates[0].origin === 'local';
}


/** 三路候选按来源计数（日志/快照用） */
export function countCandidatesByOrigin(candidates) {
  const byOrigin = { local: 0, online: 0, freeform: 0 };
  for (const candidate of candidates) {
    const origin = candidate?.origin ?? 'unknown';
    byOrigin[origin] = (byOrigin[origin] ?? 0) + 1;
  }
  return byOrigin;
}

/**
 * 创建三路候选会话（方案 §2）。
 *
 * @param {{intent: object, text: string, trace: object}} options
 * @returns {object} 会话状态
 */
export function createThreeSourceSession({ intent, text, trace }) {
  return {
    choiceId: createId('rc'),
    sourceTraceId: trace.id,
    originalText: text,
    // 快照里的原始意图清掉几何（选择时用候选自带 T；与既有待选快照同口径）
    intent: JSON.parse(JSON.stringify({ ...intent, customShape: null, freeformReview: null })),
    candidates: [],
    paths: {
      local: { state: 'pending', result: null, error: null },
      online: { state: 'pending', result: null, error: null },
      freeform: { state: 'pending', result: null, error: null },
    },
    aborters: new Map(),
    status: 'collecting',
    createdAt: Date.now(),
  };
}

/**
 * 构造待选快照（控制器上下文与 UI 追加卡同源）。
 *
 * @param {object} session 三路会话
 * @returns {object} 待选快照
 */
export function buildThreeSourceSnapshot(session) {
  const origins = new Set(session.candidates.map((candidate) => candidate.origin));
  return {
    choiceId: session.choiceId,
    sourceTraceId: session.sourceTraceId,
    status: 'awaiting-selection',
    originalText: session.originalText,
    intent: session.intent,
    candidates: session.candidates,
    origin: origins.size === 1 ? [...origins][0] : 'mixed',
    createdAt: session.createdAt,
  };
}

/**
 * 参考通道结果 → 命中的对象列表（统一多对象分组与单对象命中的形状）。
 *
 * @param {object} outcome 参考通道结果
 * @returns {Array<{objectKey: string, objectName: string, aliases: string[], candidate: object|null}>}
 */
export function matchedObjectsOf(outcome) {
  if (!outcome) {
    return [];
  }
  if (outcome.status === 'multi' && Array.isArray(outcome.objectGroups)) {
    return outcome.objectGroups.map((group) => ({
      objectKey: group.objectKey ?? group.objectName ?? '',
      objectName: group.objectName ?? '',
      aliases: Array.isArray(group.aliases) ? group.aliases : [],
      candidate: group.candidates?.[0] ?? null,
    }));
  }
  if (outcome.status === 'ok' && Array.isArray(outcome.candidates) && outcome.candidates.length > 0) {
    const candidate = outcome.candidates[0];
    const objectName = candidate?.asset?.displayName ?? candidate?.asset?.names?.zh?.[0] ?? '';
    return [{
      objectKey: candidate?.asset?.names?.zh?.[0] ?? objectName,
      objectName,
      aliases: Array.isArray(candidate?.asset?.aliases) ? candidate.asset.aliases : [],
      candidate,
    }];
  }
  return [];
}

/**
 * 把组合好的 multi-part 目标写入意图（多对象参考命中）。
 *
 * referenceSource.parts 逐部分记录素材审核信息——复合目标要逐部分过审，
 * 不能用任一部分的审核记录代表整体（方案 2026-11-05 §4.2）。
 *
 * @param {object} intent 原意图
 * @param {object} customShape 组合后的多部分目标
 * @param {Array<{name: string, candidate: object}>} entries 命中的对象与候选
 * @returns {object} 新意图
 */
export function applyCompositeReference(intent, customShape, entries) {
  const parts = entries.map((entry) => {
    const candidate = entry.candidate;
    return {
      name: entry.objectName,
      assetId: candidate?.asset?.id ?? null,
      license: candidate?.asset?.source?.license ?? null,
      matchedAlias: candidate?.matchedAlias ?? null,
      origin: candidate?.origin ?? 'local',
      reviewStatus: candidate?.reviewStatus ?? 'curated',
      sourceSha256: candidate?.sourceSha256 ?? null,
      contentHash: candidate?.contentHash ?? null,
      review: candidate?.origin === 'local' ? candidate?.asset?.review ?? null : null,
    };
  });
  return {
    ...intent,
    customShape,
    shapeKey: null,
    shapeSpec: null,
    shapeSpecError: null,
    planBlocked: null,
    shapeBlockedName: null,
    referenceSource: {
      id: `composite:${parts.map((part) => part.assetId ?? part.name).join('+')}`,
      name: parts.map((part) => part.name).join('+'),
      license: parts[0]?.license ?? null,
      matchedAlias: null,
      pointCount: customShape.outlinePoints.length,
      origin: 'local',
      reviewStatus: 'curated',
      sourceSha256: null,
      contentHash: null,
      choiceId: null,
      candidateId: null,
      confirmation: null,
      review: null,
      parts,
      composite: true,
    },
  };
}

/**
 * 创建三路会话运行时（C4：可变状态用访问器注入，日志/写历史显式传入）。
 *
 * @param {object} deps 依赖
 * @param {() => object|null} deps.getSession 取当前三路会话
 * @param {(session: object|null) => void} deps.setSession 写当前三路会话
 * @param {(choice: object|null) => void} deps.setChoice 写待选快照（referenceChoice）
 * @param {() => Function|null} deps.getListener 取候选追加监听
 * @param {{info: Function, warn: Function}} deps.log 日志器
 * @param {(userText: string, assistantText: string) => void} deps.pushHistory 写对话历史
 * @returns {object} { publishThreeSourceSnapshot, addThreeSourceCandidates,
 *   cancelThreeSourceSession, askObjectShortfall }
 */
export function createThreeSourceRuntime({ getSession, setSession, setChoice, getListener, log, pushHistory }) {
  /**
   * 发布待选快照：写入控制器上下文，并通知 UI 追加候选卡（方案 §2：卡片随结果到达追加）。
   *
   * @param {object} session 三路会话
   */
  function publishThreeSourceSnapshot(session) {
    if (session.status !== 'collecting' && session.status !== 'awaiting-selection') {
      return; // 已选中/已取消：迟到结果不得回填
    }
    const snapshot = buildThreeSourceSnapshot(session);
    setChoice(snapshot);
    log.info('agent.reference.candidates', {
      choiceId: session.choiceId,
      origin: snapshot.origin,
      count: session.candidates.length,
      candidates: session.candidates.map((candidate) => ({
        assetId: candidate.asset?.id ?? null,
        name: candidate.asset?.displayName ?? null,
        origin: candidate.origin,
        reviewStatus: candidate.reviewStatus,
        pointCount: candidate.customShape?.outlinePoints?.length ?? 0,
        contentHash: candidate.contentHash,
        matchedAlias: candidate.matchedAlias ?? null,
      })),
    });
    const listener = getListener();
    if (typeof listener === 'function') {
      try {
        listener(JSON.parse(JSON.stringify(snapshot)));
      } catch (error) {
        log.warn('agent.threeSources.notify.failed', { message: error?.message ?? String(error) });
      }
    }
  }

  /**
   * 追加某一路到达的候选（按到达顺序编号；出卡后仍可继续追加剩余路）。
   *
   * @param {object} session 三路会话
   * @param {Array<object>} candidates 统一候选
   */
  function addThreeSourceCandidates(session, candidates) {
    if (session.status !== 'collecting' && session.status !== 'awaiting-selection') {
      return;
    }
    const added = [];
    for (const candidate of candidates || []) {
      if (!candidate?.customShape?.outlinePoints?.length) {
        continue;
      }
      const prepared = {
        ...candidate,
        choiceId: session.choiceId,
        candidateId: `${session.choiceId}:${session.candidates.length}`,
      };
      session.candidates.push(prepared);
      added.push(prepared);
    }
    if (added.length > 0) {
      publishThreeSourceSnapshot(session);
    }
  }

  /**
   * 取消尚未返回的三路（用户点选/新输入/切换会话/停止）：
   * 立刻中止在线检索与自由轮廓质检，已到达的候选保留快照。
   *
   * @param {string} reason 取消原因（user-selection/new-input/session-switch/stopped）
   */
  function cancelThreeSourceSession(reason) {
    const session = getSession();
    if (!session) {
      return;
    }
    const pendingPaths = [...session.aborters.keys()];
    for (const controller of session.aborters.values()) {
      try {
        controller.abort();
      } catch {
        // 已中止/已结束的控制器忽略
      }
    }
    session.aborters.clear();
    if (session.status === 'collecting' || session.status === 'awaiting-selection') {
      log.info('agent.threeSources.cancelled', {
        choiceId: session.choiceId,
        reason,
        pendingPaths,
        candidateCount: session.candidates.length,
      });
    }
    session.status = 'cancelled';
    if (getSession() === session) {
      setSession(null);
    }
  }

  return {
    publishThreeSourceSnapshot,
    addThreeSourceCandidates,
    cancelThreeSourceSession,
  };
}
