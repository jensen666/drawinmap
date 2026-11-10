/**
 * controller 装配测试底座（清理方案 2026-11-09 阶段 0，T-B2d）。
 *
 * 抽取自既有 controller 集成测试（`three-sources.mjs` / `controller-replies.mjs` /
 * `controller-delivery.mjs` / `controller-multi-object.mjs` /
 * `controller-recommend-fallback.mjs` / `scale-candidates.mjs` / `alternative-switch.mjs`）
 * 里反复手写的装配：
 * - 固定地点配置（不依赖真实 gazetteer 内容变化）；
 * - LLM fetch mock（按 system 提示分流：意图解析 / 视觉质检 / 修正生成）；
 * - fake 引擎（plan / recommend / commitDraw / clearDraw / formatMinutes + 调用记录）；
 * - fake 三路参考源（本地 / 在线 / 逐对象）；
 * - 候选/规划结果/推荐结果的固定构造器；
 * - 把一轮结果收敛成**确定性摘要**（供 golden fixture 逐字段对比，见 capture 系列）。
 *
 * 设计约束：
 * 1. 全程不发真实网络请求、不打开浏览器、不走路网真实数据（确定性、<10s）；
 * 2. 摘要里**不得出现随机值**：createId() 产物（choiceId / candidateId / poolId /
 *    cardId / traceId）、Date.now() 时间戳一律不进摘要，只保留可复核的结构字段；
 * 3. 只做"装配与摘要"，不断言业务语义——断言在用例文件里。
 */

import { createAgentController } from '../../web/src/agent/controller.js';
import { normalizeCustomShape } from '../../web/src/agent/intent.js';

/** 测试用固定城市中心 */
export const TEST_CENTER = { lat: 23.12, lng: 113.32 };

/**
 * 固定地点配置（形状与 normalizePlaceConfig 结果一致；4 个地标 + 当前视野中心
 * 正好凑出 5 个引导选项，不读取真实 place-gazetteer.json，避免配置变动影响 golden）。
 *
 * @returns {object} 地点配置
 */
export function createTestPlaceConfig() {
  return {
    version: 1,
    activeCityId: 'test-city',
    matching: { unresolvedPlace: 'ask' },
    activeCity: {
      id: 'test-city',
      label: '测试城',
      names: ['测试城'],
      title: '测试城',
      subtitle: '',
      mapAriaLabel: '地图',
      view: { center: { ...TEST_CENTER }, zoom: 12 },
      coverage: {
        description: '测试范围',
        hint: '换地点',
        bbox: { minLat: 22.9, maxLat: 23.4, minLng: 113.0, maxLng: 113.6 },
      },
      examples: ['画个五角星'],
      roads: { dataUrl: '/data/guangzhou-roads.json' },
      pois: [
        { name: '广州塔', lat: 23.1066, lng: 113.3246 },
        { name: '花城广场', lat: 23.1195, lng: 113.3221 },
        { name: '珠江新城', lat: 23.1199, lng: 113.3311 },
        { name: '广州大剧院', lat: 23.1173, lng: 113.3266 },
      ],
      districts: [],
      aliases: [],
    },
  };
}

/**
 * 圆环点列（n 点；无凹口时 features 检测为 0）。
 *
 * @param {number} n 点数
 * @param {number} [radius] 半径（归一化坐标）
 * @returns {Array<[number, number]>} 点列
 */
export function circlePoints(n, radius = 0.4) {
  return Array.from({ length: n }, (_, index) => {
    const angle = (2 * Math.PI * index) / n;
    return [Math.sin(angle) * radius, Math.cos(angle) * radius];
  });
}

/**
 * 构造 LLM chat/completions 成功响应（与页面同一条链路消费的形状）。
 *
 * @param {object} content 响应正文对象（会被 JSON.stringify）
 * @returns {object} fetch Response 替身
 */
export function jsonResponse(content) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({
      id: 'mock',
      model: 'mock',
      choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }],
      usage: {},
    }),
    text: async () => '',
  };
}

/**
 * 创建 LLM fetch mock（意图解析 / 视觉质检 / 修正生成三路分流）。
 *
 * @returns {{
 *   state: {ints: Array<object>, verdicts: Array<string>, revisions: Array<object>,
 *     calls: {intent: number, verdict: number, revision: number}, bodies: Array<string>},
 *   reset: (options?: {intents?: Array<object>, verdicts?: Array<string>, revisions?: Array<object>}) => void,
 *   install: () => () => void,
 *   fetchImpl: (url: string|URL, options?: object) => Promise<object>
 * }} mock
 */
export function createLlmMock() {
  const state = {
    ints: [],
    verdicts: [],
    revisions: [],
    calls: { intent: 0, verdict: 0, revision: 0 },
    bodies: [],
  };

  /**
   * 重置队列与计数。
   *
   * @param {{intents?: Array<object>, verdicts?: Array<string>, revisions?: Array<object>}} [options] 队列
   */
  function reset({ intents = [], verdicts = [], revisions = [] } = {}) {
    state.ints = [...intents];
    state.verdicts = [...verdicts];
    state.revisions = [...revisions];
    state.calls = { intent: 0, verdict: 0, revision: 0 };
    state.bodies = [];
  }

  /**
   * fetch 替身：按 system 提示识别请求类型。
   *
   * @param {string|URL} url 请求地址
   * @param {object} [options] fetch options
   * @returns {Promise<object>} Response 替身
   */
  async function fetchImpl(url, options = {}) {
    const href = String(url);
    if (href.includes('/data/guangzhou-roads.json')) {
      // 路网数据：地点解析走 POI 表即可命中，不需要真实路网
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ roads: [] }) };
    }
    if (!href.includes('/chat/completions')) {
      return { ok: false, status: 404, headers: { get: () => null }, text: async () => '' };
    }
    const bodyText = options.body || '{}';
    state.bodies.push(bodyText);
    let system = '';
    try {
      system = JSON.parse(bodyText).messages?.[0]?.content || '';
    } catch {
      system = '';
    }
    if (system.includes('图形路线规划助手')) {
      state.calls.intent += 1;
      return jsonResponse(state.ints.shift() ?? { action: 'chat', reply: '收到' });
    }
    if (system.includes('目标轮廓质检员')) {
      state.calls.verdict += 1;
      const verdict = state.verdicts.shift() ?? 'unlike';
      return jsonResponse({
        verdict,
        seen: '一只动物',
        issues: verdict === 'unlike' ? ['四条腿呈方波'] : [],
      });
    }
    if (system.includes('你为 DrawInMap 生成')) {
      state.calls.revision += 1;
      const next = state.revisions.shift() ?? { http: 500 };
      if (next.abort) {
        const error = new Error('模拟修正请求超时中断');
        error.name = 'AbortError';
        throw error;
      }
      if (next.http) {
        return {
          ok: false,
          status: next.http,
          headers: { get: () => null },
          text: async () => 'mock failure',
        };
      }
      return jsonResponse(next.json);
    }
    return jsonResponse({});
  }

  /**
   * 安装到 globalThis.fetch，返回恢复函数。
   *
   * @returns {() => void} 恢复函数
   */
  function install() {
    const previous = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    return () => {
      globalThis.fetch = previous;
    };
  }

  return { state, reset, install, fetchImpl };
}

/**
 * 构造 fake 引擎（记录全部调用；plan/recommend 可按队列或函数返回）。
 *
 * @param {{planQueue?: Array<object>, recommendQueue?: Array<object>,
 *   plan?: Function, recommend?: Function,
 *   placeContext?: object|null, withPlaceContext?: boolean}} [options] 选项
 * @returns {object} fake 引擎
 */
export function makeFakeEngine({
  planQueue = [],
  recommendQueue = [],
  plan = null,
  recommend = null,
  placeContext = null,
  withPlaceContext = false,
} = {}) {
  const calls = [];
  const engine = {
    calls,
    planCalls: () => calls.filter((call) => call.type === 'plan'),
    recommendCalls: () => calls.filter((call) => call.type === 'recommend'),
    commitCalls: () => calls.filter((call) => call.type === 'commitDraw'),
    clearCalls: () => calls.filter((call) => call.type === 'clearDraw'),
    plan: async (options) => {
      calls.push({ type: 'plan', options });
      return typeof plan === 'function' ? plan(options) : planQueue.shift() ?? null;
    },
    recommend: async (options) => {
      calls.push({ type: 'recommend', options });
      return typeof recommend === 'function' ? recommend(options) : recommendQueue.shift() ?? { status: 'failed' };
    },
    commitDraw: (result, options) => {
      calls.push({ type: 'commitDraw', result, options });
      // 与真实 shape-engine 返回的句柄同形（只保留摘要需要的可序列化字段）
      return {
        shapeName: result?.shapeName ?? null,
        sizeMeters: result?.sizeMeters ?? null,
        score: options?.score ?? null,
        reference: options?.reference === true,
      };
    },
    clearDraw: () => calls.push({ type: 'clearDraw' }),
    formatMinutes: (minutes) => `${Math.round(minutes)} 分钟`,
  };
  if (withPlaceContext) {
    engine.getPlaceContext = async () => placeContext;
  }
  return engine;
}

/** 三路参考源的"命中"结果 */
export function okResult(origin, candidates) {
  return { status: 'ok', origin, candidates, failures: [], poolSize: candidates.length, attempts: [] };
}

/** 三路参考源的"未命中"结果 */
export function missResult(origin) {
  return { status: 'miss', origin, candidates: [], failures: [], poolSize: 0, attempts: [] };
}

/**
 * 构造 fake 三路参考源。
 *
 * 每个入口可以是值、函数（可读 options.signal）或 deferred 结果；
 * `objects` 提供 `resolveLocalCandidatesForObjects`（多对象逐对象匹配接口）。
 *
 * @param {{local?: object|Function, online?: object|Function, objects?: object|Function}} [options] 三路
 * @returns {object} fake 参考源
 */
export function makeThreeSource({ local = missResult('local'), online = missResult('online'), objects = null } = {}) {
  const calls = { local: 0, online: 0, objects: 0 };
  const source = {
    calls,
    async resolveLocalCandidates(text, options = {}) {
      calls.local += 1;
      return typeof local === 'function' ? await local(options) : local;
    },
    async resolveOnlineCandidates(text, options = {}) {
      calls.online += 1;
      return typeof online === 'function' ? await online(options) : online;
    },
  };
  if (objects) {
    source.resolveLocalCandidatesForObjects = async (requestObjects, options = {}) => {
      calls.objects += 1;
      return typeof objects === 'function' ? await objects(requestObjects, options) : objects;
    };
  }
  return source;
}

/**
 * 构造本地参考候选（固定哈希，不依赖真实素材文件）。
 *
 * @param {{id?: string, name?: string, alias?: string, points?: number}} [options] 选项
 * @returns {object} 候选
 */
export function makeLocalCandidate({ id = 'swan', name = '天鹅', alias = '天鹅', points = 24 } = {}) {
  const sha = 'a'.repeat(64);
  const customShape = normalizeCustomShape({ name, points: circlePoints(points) });
  return {
    asset: {
      id,
      displayName: name,
      names: { zh: [name], en: [] },
      source: { name: 'PhyloPic', license: 'CC0-1.0', url: `https://example.com/${id}`, attribution: 'Tester' },
      tags: [],
      review: { status: 'approved', visual: 'like', reviewedAt: '2026-11-01', sha256: sha },
    },
    customShape,
    conversion: { status: 'accepted', T: { points: customShape.outlinePoints }, metrics: null },
    matchedAlias: alias,
    origin: 'local',
    reviewStatus: 'curated',
    sourceSha256: sha,
    contentHash: 'b'.repeat(64),
  };
}

/**
 * 构造在线参考候选（固定哈希，不依赖外网）。
 *
 * @param {{id?: string, name?: string, points?: number}} [options] 选项
 * @returns {object} 候选
 */
export function makeOnlineCandidate({ id = 'oc-swan', name = '天鹅', points = 24 } = {}) {
  const customShape = normalizeCustomShape({ name, points: circlePoints(points) });
  return {
    asset: {
      id,
      displayName: name,
      names: { zh: [name], en: [] },
      source: { name: 'PhyloPic', license: 'CC0-1.0', url: `https://example.com/${id}`, attribution: 'Tester' },
      tags: [],
      review: null,
    },
    customShape,
    conversion: { status: 'accepted', T: { points: customShape.outlinePoints }, metrics: null },
    matchedAlias: null,
    origin: 'online',
    reviewStatus: 'unreviewed',
    sourceSha256: 'c'.repeat(64),
    contentHash: 'd'.repeat(64),
  };
}

/**
 * 构造"逐对象命中"的本地结果（多对象链路）。
 *
 * @param {Array<{name: string, candidates: Array<object>, aliases?: Array<string>}>} groups 对象分组
 * @returns {object} 多对象本地结果
 */
export function makeObjectGroupsResult(groups) {
  const objectGroups = groups.map((group) => ({
    objectKey: group.name,
    objectName: group.name,
    aliases: group.aliases ?? [group.name],
    candidates: group.candidates,
    failures: [],
    candidateCount: group.candidates.length,
  }));
  return {
    status: 'multi',
    origin: 'local',
    candidates: objectGroups.flatMap((group) => group.candidates),
    failures: [],
    objectGroups,
    objects: groups.map((group) => group.name),
    rawCount: groups.length,
    poolSize: groups.length,
    attempts: [],
    reason: 'multi-object',
    error: null,
  };
}

/**
 * 构造带完整 metrics 的规划结果（composeReply / 候选池 / 交付闸门用到的字段齐全）。
 *
 * @param {{shapeName?: string, sizeMeters?: number, rotationDeg?: number,
 *   center?: {lat: number, lng: number}, metrics?: object,
 *   routeLatLngs?: Array, outlineLatLngs?: Array}} [options] 选项
 * @returns {object} 规划结果
 */
export function makePlannedResult({
  shapeName = '马',
  sizeMeters = 1200,
  rotationDeg = 0,
  center = { ...TEST_CENTER },
  metrics = null,
  routeLatLngs = [[23.12, 113.32], [23.121, 113.321]],
  outlineLatLngs = [[23.12, 113.32], [23.121, 113.321]],
} = {}) {
  return {
    shapeName,
    sizeMeters,
    rotationDeg,
    center,
    routeLatLngs,
    outlineLatLngs,
    metrics: metrics ?? makeMetrics({ sizeMeters }),
  };
}

/**
 * 构造候选 metrics（字段覆盖评分/门槛/比例尺卡片/reply 文案所需）。
 *
 * @param {{routeMeters?: number, sizeMeters?: number, rms?: number, overrides?: object}} [options] 选项
 * @returns {object} metrics
 */
export function makeMetrics({ routeMeters = 1000, sizeMeters = 1200, rms = 0.02, overrides = {} } = {}) {
  return {
    routeMeters,
    walkMinutes: Math.round(routeMeters / 80),
    detourRatio: 1.2,
    coverage: 100,
    failedLegs: 0,
    snapMaxMeters: 20,
    snapAvgMeters: 10,
    keyCoverage: 1,
    collapsedKeyCount: 0,
    keyMaxOffsetRatio: 0.01,
    orderedOutlineMeanMeters: 20,
    orderedOutlineMaxMeters: 40,
    orderedOutlineRms: rms,
    orderedRouteRms: rms,
    orderedOutlineMeanRatio: 0.02,
    orderedOutlineMaxRatio: 0.04,
    orderedRouteMeanRatio: 0.02,
    orderedRouteMaxRatio: 0.05,
    outlineMeanMeters: 20,
    outlineMaxMeters: 40,
    featureCount: 0,
    featureCoveredCount: 0,
    featureCoverage: 1,
    frechetMaxRatio: 0.1,
    aspectDistortionRatio: 0.1,
    // 无特征图形：与 planner 真实口径一致（Infinity = 视为完美）
    featureGapRetainRatio: Number.POSITIVE_INFINITY,
    sizeMeters,
    ...overrides,
  };
}

/**
 * 构造候选条目（best / alternatives / bests 共用）。
 *
 * @param {{result?: object, score?: number, adjustedScore?: number, sizeMeters?: number,
 *   rotationDeg?: number, center?: object, stage?: number, stageLabel?: string,
 *   envelopeMeters?: number}} [options] 选项
 * @returns {object} 候选
 */
export function makeCandidateEntry({
  result = null,
  score = 75,
  adjustedScore = null,
  sizeMeters = 1200,
  rotationDeg = 0,
  center = { ...TEST_CENTER },
  stage = 1,
  stageLabel = '近场搜索',
  envelopeMeters = 40,
} = {}) {
  return {
    result: result ?? makePlannedResult({ sizeMeters, rotationDeg, center }),
    score,
    adjustedScore: adjustedScore ?? score,
    sizeMeters,
    rotationDeg,
    center,
    stage,
    stageLabel,
    envelopeMeters,
  };
}

/**
 * 构造 plan 成功的推进结果。
 *
 * @param {{best?: object, alternatives?: Array<object>, nearBest?: object|null,
 *   offset?: {meters: number, text: string}, stage?: number, stageLabel?: string,
 *   triedCount?: number}} [options] 选项
 * @returns {object} 引擎 plan 返回值
 */
export function makePlanOutcome({
  best = makeCandidateEntry(),
  alternatives = [],
  nearBest = null,
  offset = { meters: 0, text: '' },
  stage = 1,
  stageLabel = '近场搜索',
  triedCount = 100,
} = {}) {
  return {
    status: 'ok',
    result: best.result,
    best,
    nearBest,
    alternatives,
    offset,
    stage,
    stageLabel,
    triedCount,
  };
}

/**
 * 构造 plan 完全失败的结果（无任何可绘制候选）。
 *
 * @param {{stage?: number, stageLabel?: string, triedCount?: number, reason?: string}} [options] 选项
 * @returns {object} 引擎 plan 返回值
 */
export function makeFailedPlan({ stage = 1, stageLabel = '近场搜索', triedCount = 100, reason = null } = {}) {
  return {
    status: 'failed',
    result: null,
    best: null,
    bestOverall: null,
    nearBest: null,
    stage,
    stageLabel,
    triedCount,
    ...(reason ? { reason } : {}),
  };
}

/**
 * 构造 recommend 成功的推进结果。
 *
 * @param {{drawn?: object, recommendations?: Array<object>, bests?: object,
 *   offset?: object, stage?: number, stageLabel?: string, triedCount?: number}} [options] 选项
 * @returns {object} 引擎 recommend 返回值
 */
export function makeRecommendOutcome({
  drawn = makeCandidateEntry(),
  recommendations = null,
  bests = {},
  offset = { meters: 0, text: '' },
  stage = 1,
  stageLabel = '近场搜索',
  triedCount = 100,
} = {}) {
  return {
    status: 'ok',
    drawn,
    recommendations: recommendations ?? [drawn],
    bests,
    offset,
    stage,
    stageLabel,
    triedCount,
  };
}

/**
 * 构造 recommend 失败但带可回退候选的结果。
 *
 * @param {{bests?: object, stage?: number, stageLabel?: string, triedCount?: number}} [options] 选项
 * @returns {object} 引擎 recommend 返回值
 */
export function makeFailedRecommend({
  bests = {
    heart: makeCandidateEntry({ score: 55, adjustedScore: 55, sizeMeters: 1200 }),
  },
  stage = 3,
  stageLabel = '大档补搜',
  triedCount = 800,
} = {}) {
  return {
    status: 'failed',
    drawn: null,
    best: null,
    stage,
    stageLabel,
    triedCount,
    bests,
    offset: { meters: 0, text: '' },
  };
}

/**
 * 构造自由轮廓意图（LLM 输出形态）。
 *
 * @param {{points?: number, featureCount?: number, place?: string, name?: string}} [options] 选项
 * @returns {object} 意图
 */
export function makeFreeformIntent({ points = 84, featureCount = 0, place = '广州塔', name = '天鹅' } = {}) {
  const declaredFeatures = Array.from({ length: featureCount }, (_, index) => ({
    name: `特征${index + 1}`,
    points: [circlePoints(points)[index]],
  }));
  return {
    action: 'plan',
    shape: null,
    customShape: {
      name,
      ...(declaredFeatures.length ? { features: declaredFeatures } : {}),
      points: circlePoints(points),
    },
    place,
    rotationDeg: null,
    reply: `画一只${name}`,
  };
}

/**
 * 构造内置图形意图。
 *
 * @param {{shape?: string, place?: string, reply?: string}} [options] 选项
 * @returns {object} 意图
 */
export function makeBuiltinIntent({ shape = 'star', place = '广州塔', reply = '好的。' } = {}) {
  return {
    action: 'plan',
    shape,
    customShape: null,
    place,
    rotationDeg: null,
    reply,
  };
}

/**
 * 构造控制器（默认注入 fake 渲染器；未提供参考源时不注入，走"无参考通道"分支）。
 *
 * @param {{engine: object, source?: object|null, placeConfig?: object,
 *   shapeReviewDeps?: object, map?: object, referenceShapeSource?: Function}} options 选项
 * @returns {object} 控制器
 */
export function makeController({
  engine,
  source = null,
  placeConfig = createTestPlaceConfig(),
  shapeReviewDeps = { renderOutline: () => 'data:image/png;base64,FAKE' },
  map = { getCenter: () => ({ ...TEST_CENTER }) },
  referenceShapeSource,
} = {}) {
  const options = { map, engine, placeConfig, shapeReviewDeps };
  if (source) options.referenceSource = source;
  if (referenceShapeSource) options.referenceShapeSource = referenceShapeSource;
  return createAgentController(options);
}

// ---------------------------------------------------------------------------
// 确定性摘要：golden fixture 的捕获口径
// ---------------------------------------------------------------------------

/**
 * 清洗回复文本里的白名单字段（traceId / 时间戳类）。
 *
 * golden 只允许这类字段变化；其余文本必须逐字一致。替换成稳定占位符后仍按
 * 全文逐字比较。
 *
 * @param {string} text 回复文本
 * @returns {string} 清洗后文本
 */
export function sanitizeText(text) {
  return String(text ?? '')
    .replace(/\b(?:t|s|sp|scp|rc|sc|tr)-[a-z0-9]{4,}\b/gi, '<id>')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, '<timestamp>')
    .replace(/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '<timestamp>');
}

/**
 * 摘要图形句柄（engine.commitDraw 返回值）。
 *
 * @param {object|null} shape 图形句柄
 * @returns {object|null} 摘要
 */
export function summarizeShape(shape) {
  if (!shape) return null;
  return {
    shapeName: shape.shapeName ?? null,
    sizeMeters: shape.sizeMeters ?? null,
    score: shape.score ?? null,
    reference: shape.reference === true,
  };
}

/**
 * 摘要点序列图。
 *
 * @param {object|null} outline 点序列图
 * @returns {object|null} 摘要
 */
export function summarizeOutline(outline) {
  if (!outline) return null;
  return {
    source: outline.source ?? null,
    name: outline.name ?? null,
    pointCount: outline.pointCount ?? null,
    dataUrl: outline.dataUrl ?? null,
  };
}

/**
 * 摘要 commitDraw 调用（只取最后一次的参数；count 反映调用次数）。
 *
 * @param {Array<object>} calls fake 引擎调用记录
 * @returns {object|null} 摘要
 */
export function summarizeCommit(calls) {
  const commits = calls.filter((call) => call.type === 'commitDraw');
  if (commits.length === 0) return null;
  const last = commits[commits.length - 1];
  return {
    count: commits.length,
    reference: last.options?.reference === true,
    score: last.options?.score ?? null,
    shapeName: last.result?.shapeName ?? null,
    sizeMeters: last.result?.sizeMeters ?? null,
    routeMeters: last.result?.metrics?.routeMeters ?? null,
    deliveredObjects: Array.isArray(last.options?.deliveredObjects)
      ? last.options.deliveredObjects.map((item) => item?.name ?? item?.objectName ?? String(item))
      : null,
  };
}

/**
 * 摘要待选候选快照（**不含** choiceId / candidateId 等随机 id）。
 *
 * @param {object|null} choice 待选快照
 * @returns {object|null} 摘要
 */
export function summarizeReferenceChoice(choice) {
  if (!choice) return null;
  const candidates = Array.isArray(choice.candidates) ? choice.candidates : [];
  return {
    status: choice.status ?? null,
    candidateCount: candidates.length,
    origins: candidates.map((item) => item.origin ?? null),
    names: candidates.map((item) => item.customShape?.name ?? item.asset?.displayName ?? null),
    reviewStatuses: candidates.map((item) => item.reviewStatus ?? null),
    objects: Array.isArray(choice.objects) ? choice.objects : null,
  };
}

/**
 * 摘要比例尺候选池视图（**不含** poolId / cardId / traceId 等随机 id）。
 *
 * @param {object|null} pool 池视图
 * @returns {object|null} 摘要
 */
export function summarizeScalePool(pool) {
  if (!pool) return null;
  const cards = Array.isArray(pool.cards) ? pool.cards : [];
  const current = cards.find((card) => card.id === pool.currentCardId) ?? null;
  return {
    cardCount: cards.length,
    hiddenCount: pool.hiddenCount ?? 0,
    shapeName: pool.shapeName ?? null,
    currentSizeMeters: current?.sizeMeters ?? null,
    sizes: cards.map((card) => card.sizeMeters),
    scores: cards.map((card) => card.score),
  };
}

/**
 * 摘要引导追问。
 *
 * @param {object|null} guide 引导状态
 * @returns {object|null} 摘要
 */
export function summarizeGuide(guide) {
  if (!guide) return null;
  return {
    slot: guide.slot ?? null,
    options: (guide.options ?? []).map((option) => option.label),
  };
}

/**
 * 把一轮结果收敛成固定结构摘要（golden 逐字段对比的口径）。
 *
 * 固定字段（所有场景一致，便于 diff 定位）：
 * `reply / status / shape / outline / commitDraw / referenceChoice / scalePool / guide`。
 *
 * @param {object|null} result 控制器一轮返回值（send / chooseReferenceCandidate）
 * @param {object} engine fake 引擎（读调用记录）
 * @returns {object} 摘要
 */
export function captureTurn(result, engine) {
  return {
    reply: sanitizeText(result?.reply ?? ''),
    status: result?.planned?.status ?? (result?.guide ? 'guide' : null),
    shape: summarizeShape(result?.shape),
    outline: summarizeOutline(result?.outline),
    commitDraw: summarizeCommit(engine.calls),
    referenceChoice: summarizeReferenceChoice(result?.referenceChoice),
    scalePool: summarizeScalePool(result?.scalePool),
    guide: summarizeGuide(result?.guide),
  };
}

/**
 * 把一次卡片点选/比例尺切换收敛成摘要（无 planned/outline，结构保持一致）。
 *
 * @param {object} result controller.switchScaleCandidate 返回值
 * @param {object} engine fake 引擎
 * @returns {object} 摘要
 */
export function captureSwitch(result, engine) {
  const status = result?.ok === true ? (result.alreadyCurrent === true ? 'already-current' : 'switched') : 'rejected';
  return {
    reply: sanitizeText(result?.reply ?? ''),
    status,
    shape: null,
    outline: null,
    commitDraw: summarizeCommit(engine.calls),
    referenceChoice: null,
    scalePool: summarizeScalePool(result?.scalePool),
    guide: null,
  };
}
