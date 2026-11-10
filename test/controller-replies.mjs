/**
 * 控制器回复链路集成测试（Node 直接运行，mock LLM + mock 引擎 + 固定样本；不依赖浏览器/网络）。
 *
 * 覆盖本轮四项任务的"最后一公里"（引擎侧与纯函数由各自测试覆盖）：
 * 1. 地点来源：备选地解析「广州」→ 已加载路网的覆盖中心（不是广州塔、不是裸视野中心），
 *    覆盖中心解析失败时如实回退视野中心；覆盖外行政区（番禺/番禺区）保留代表点并把
 *    outside-coverage 提示如实回给用户。
 * 2. 偏移说明：plan 用 planned.nearBest、recommend 用 outcome.nearBests 代表候选的
 *    近场证据，不得拿最终远处候选 metrics 解释近场失败；覆盖中心来源不得说"您指定的地方"。
 * 3. 部位弧偏差：plan 选定候选后写独立 trace 事件 plan.feature.arcs（含声明特征/凹口），
 *    且不进入 metrics。
 * 4. 错误文案：重试耗尽后的超时/模型返回/截断统一走友好句；HTTP 错误仍抛
 *    "智能体解析失败"并保留 kind。
 *
 * 运行：node test/controller-replies.mjs
 */

import { GUANGZHOU_ROADS_HINT, readRequiredText } from './lib/require-data.mjs';
import { createAgentController } from '../web/src/agent/controller.js';
import { normalizeCustomShape } from '../web/src/agent/intent.js';
import { planShapeRoute, projectShape } from '../web/src/engine/planner.js';
import { SHAPES } from '../web/src/engine/shapes.js';
import {
  buildEdgeIndex,
  buildNodeIndex,
  buildWalkGraph,
  findLargestComponent,
  graphBounds,
  nearestNode,
  pointInBounds,
} from '../web/src/engine/graph.js';
import { clearLogs, getEntries, initLogging } from '../web/src/log/index.js';
import { isAbortError } from '../web/src/cancel.js';
import {
  SAMPLE_A_CANDIDATE,
  SAMPLE_A_FREEFORM_RAW,
  SAMPLE_B_CANDIDATE,
  SAMPLE_B_FREEFORM_RAW,
} from './fixtures/fixed-samples.mjs';
import { clonePlaceConfig, placeConfig } from './fixtures/place-config.mjs';

let failures = 0;
let checks = 0;

/**
 * 断言工具：失败计入退出码。
 *
 * @param {string} label 断言描述
 * @param {boolean} condition 断言条件
 * @param {string} [detail] 失败详情
 */
function check(label, condition, detail = '') {
  checks += 1;
  const ok = Boolean(condition);
  if (!ok) {
    failures += 1;
  }
  console.log(`[check] ${label} -> ${ok ? 'PASS' : `FAIL ${detail}`}`);
}

/** 初始化日志系统（内存 + 控制台，不落盘/不写 localStorage），用于断言 trace 事件 */
initLogging({ server: false, storage: false, level: 'info' });

// ---------- 合成路网与只读地点上下文（覆盖包围盒 = lng 113.30~113.34 / lat 23.10~23.14） ----------
const LOOP_COORDS = [
  [113.3, 23.1],
  [113.34, 23.1],
  [113.34, 23.14],
  [113.3, 23.14],
  [113.3, 23.1],
];
const syntheticGraph = buildWalkGraph([{ r: [1, 2, 3, 4, 1], c: LOOP_COORDS }]);
const syntheticNodeIndex = buildNodeIndex(syntheticGraph, 0.005, null);
const syntheticCoverage = graphBounds(syntheticGraph);
const emptyNodeIndex = buildNodeIndex(syntheticGraph, 0.005, new Set());
const placeContext = {
  graph: syntheticGraph,
  nodeIndex: syntheticNodeIndex,
  coverage: syntheticCoverage,
};

/** 【覆盖中心】期望坐标：包围盒中点最近的主分量节点（不是裸中点） */
const coverageBounds = {
  midLat: (syntheticCoverage.minLat + syntheticCoverage.maxLat) / 2,
  midLng: (syntheticCoverage.minLng + syntheticCoverage.maxLng) / 2,
};
const expectedNearest = nearestNode(
  syntheticNodeIndex,
  syntheticGraph,
  coverageBounds.midLng,
  coverageBounds.midLat,
);
const [expectedLng, expectedLat] = syntheticGraph.nodes.get(expectedNearest.id);
const expectedCoverageCenter = { lat: expectedLat, lng: expectedLng };

// ---------- mock LLM（按模式返回固定意图/错误） ----------
/** 意图队列：每次 LLM 请求取一个 */
let intentQueue = [];
/** LLM 行为模式：intent / abort / http500 / badjson / truncated */
let llmMode = 'intent';
/** LLM 请求次数（断言重试次数） */
let llmRequestCount = 0;

/** 构造一次成功的 chat/completions 响应 */
function llmResponse(content, finishReason = 'stop') {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({
      id: 'mock',
      model: 'mock',
      choices: [{ message: { content }, finish_reason: finishReason }],
      usage: {},
    }),
  };
}

globalThis.fetch = async (url, options) => {
  if (typeof url === 'string' && url.includes('/data/guangzhou-roads.json')) {
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ roads: [] }),
    };
  }
  llmRequestCount += 1;
  if (llmMode === 'abort') {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    throw error;
  }
  if (llmMode === 'http500') {
    return {
      ok: false,
      status: 500,
      headers: { get: () => null },
      text: async () => 'mock server error',
    };
  }
  if (llmMode === 'badjson') {
    return llmResponse('这不是 JSON');
  }
  if (llmMode === 'truncated') {
    return llmResponse('', 'length');
  }
  // 视觉质检请求（system 含"质检员"）：返回"像"，让自由轮廓通过目标验收闸门
  const system = JSON.parse(options.body).messages?.[0]?.content || '';
  if (system.includes('质检员')) {
    return llmResponse(JSON.stringify({ verdict: 'like', seen: '像', issues: [] }));
  }
  return llmResponse(JSON.stringify(intentQueue.shift() || { action: 'chat', reply: '收到' }));
};

// ---------- mock 引擎 ----------
/**
 * 构造带调用记录的 mock 引擎。
 *
 * @param {object} options
 * @param {object|Function} [options.planResult] 单图形规划返回值（函数则按调用参数计算）
 * @param {object} [options.recommendResult] 实测推荐返回值
 * @param {object|null} [options.placeContext] getPlaceContext 返回值（null 表示不提供该接口）
 * @returns {object} 引擎接口与 calls
 */
function makeEngine({ planResult = null, recommendResult = null, placeContext: context = placeContext, withPlaceContext = true } = {}) {
  const calls = [];
  const engine = {
    calls,
    plan: async (options) => {
      calls.push({ type: 'plan', options });
      return typeof planResult === 'function' ? planResult(options) : planResult;
    },
    recommend: async (options) => {
      calls.push({ type: 'recommend', options });
      return typeof recommendResult === 'function' ? recommendResult(options) : recommendResult;
    },
    commitDraw: (result, options) => calls.push({ type: 'commitDraw', result, options }),
    clearDraw: () => calls.push({ type: 'clearDraw' }),
    formatMinutes: (minutes) => `${Math.round(minutes)} 分钟`,
  };
  if (withPlaceContext) {
    engine.getPlaceContext = async () => context;
  }
  return engine;
}

const map = { getCenter: () => ({ lat: 23.12, lng: 113.32 }) };

/** 跑一轮对话（config 可覆盖匹配策略；signal 用于验证"停止"语义） */
async function runTurn({ text = '画个图形', intents = [], engine, config = placeConfig, signal = null }) {
  intentQueue = [...intents];
  llmMode = 'intent';
  llmRequestCount = 0;
  clearLogs();
  // 注入 fake 渲染器：自由轮廓的视觉质检可用（verdict 由 mock fetch 固定返回 like）
  const controller = createAgentController({ map, engine, placeConfig: config, shapeReviewDeps: { renderOutline: () => 'data:image/png;base64,FAKE' } });
  return controller.send({ text }, () => {}, { signal });
}

/** 从日志记录里取指定事件的数据 */
function eventsOf(name) {
  return getEntries({ limit: 0 }).filter((record) => record.event === name);
}

/** 构造带完整 metrics 的规划结果（composeReply 用到的字段齐全） */
function makeResult({ shapeName = '样本马A', center, sizeMeters = 1500, rotationDeg = 30, outlineLatLngs = [], routeLatLngs = [[23.12, 113.32], [23.121, 113.321], [23.122, 113.322]], metrics = {} }) {
  return {
    shapeName,
    center,
    sizeMeters,
    rotationDeg,
    outlineLatLngs,
    routeLatLngs,
    metrics: {
      routeMeters: 3200,
      walkMinutes: 48,
      detourRatio: 1.3,
      coverage: 100,
      failedLegs: 0,
      orderedOutlineMeanMeters: 22,
      orderedOutlineMaxMeters: 50,
      featureCount: 8,
      featureCoveredCount: 6,
      ...metrics,
    },
  };
}

/** 样本 A 的归一化图形（与控制器内部 normalizeIntent 结果一致；加密版满足复杂剪影 80 点下限） */
const customShapeA = normalizeCustomShape(SAMPLE_A_FREEFORM_RAW);
const farCenter = { lat: 23.138, lng: 113.332 };
const outlineLatLngsA = projectShape(
  customShapeA.outlinePoints,
  farCenter,
  SAMPLE_A_CANDIDATE.sizeMeters,
  30,
);

// ---------- 场景 1：plan + 覆盖中心 + 近场证据偏移说明 + 部位弧事件 ----------
{
  const result = makeResult({ center: farCenter, outlineLatLngs: outlineLatLngsA });
  const best = {
    result,
    score: 75,
    adjustedScore: 70,
    sizeMeters: SAMPLE_A_CANDIDATE.sizeMeters,
    rotationDeg: 30,
    center: farCenter,
  };
  // 近场证据与最终候选 metrics 故意不同：文案必须反映近场（40/90），不能反映最终（22/50）
  const nearBest = {
    result: {
      routeLatLngs: [[23.11, 113.31], [23.111, 113.311]],
      metrics: {
        snapMaxMeters: 5,
        failedLegs: 0,
        orderedOutlineMeanMeters: 40,
        orderedOutlineMaxMeters: 90,
      },
    },
    score: 40,
    adjustedScore: 30,
    center: farCenter,
    sizeMeters: 1500,
    rotationDeg: 30,
    stage: 1,
    stageLabel: '近场搜索',
  };
  const engine = makeEngine({
    planResult: {
      status: 'ok',
      result,
      best,
      nearBest,
      offset: { meters: 1500, text: '北约 1.5 km' },
      stage: 2,
      stageLabel: '扩大范围',
      triedCount: 120,
      alternatives: [],
    },
  });
  const response = await runTurn({
    text: '在广州画匹马',
    intents: [{ action: 'plan', customShape: SAMPLE_A_FREEFORM_RAW, place: '广州', rotationDeg: null, reply: '好，画马。' }],
    engine,
  });
  const planCall = engine.calls.find((call) => call.type === 'plan');
  const commits = engine.calls.filter((call) => call.type === 'commitDraw');
  check('场景1：引擎收到覆盖中心（落主分量节点，不在裸中点）', planCall?.options?.center?.lat === expectedCoverageCenter.lat && planCall?.options?.center?.lng === expectedCoverageCenter.lng,
    planCall ? `实际 ${JSON.stringify(planCall.options.center)}，期望 ${JSON.stringify(expectedCoverageCenter)}` : '未调用 plan');
  check('场景1：覆盖中心满足覆盖判断（outsideCoverage=false）', Boolean(planCall?.options?.center) && pointInBounds(syntheticCoverage, planCall.options.center, 0.01) === true);
  check('场景1：回复说明按已加载路网的覆盖中心定位', response.reply.includes('地点「广州」按已加载路网的覆盖中心定位'));
  check('场景1：send 返回本轮 traceId（对话内复制定位入口）', typeof response.traceId === 'string' && /^t-/.test(response.traceId), String(response.traceId));
  check('场景1：偏移说明用近场证据（40/90）', response.reply.includes('近场最好候选的有序贴合平均 40 m / 最大 90 m'), response.reply);
  check('场景1：覆盖中心主语不写「您指定的地方」', !response.reply.includes('您指定的地方'));
  check('场景1：不再硬编码「附近路网不完整」', !response.reply.includes('附近路网不完整'));
  check('场景1：没有近场证据时不说「临水」', !response.reply.includes('临水'));
  check('场景1：绿色交付提交一次（reference=false）', commits.length === 1 && commits[0].options?.reference !== true, `commit=${commits.length}`);
  check('场景1：place.resolved 记录 coverage-center', eventsOf('place.resolved').some((record) => record.data?.source === 'coverage-center'));
  const arcEvents = eventsOf('plan.feature.arcs');
  check('场景1：写出 plan.feature.arcs 事件', arcEvents.length === 1, `事件数=${arcEvents.length}`);
  const arcPayload = arcEvents[0]?.data;
  check('场景1：弧事件含候选参数', Boolean(arcPayload) && arcPayload.shapeName === '样本马A' && arcPayload.score === 75 && arcPayload.sizeMeters === 1500 && arcPayload.rotationDeg === 30 && Boolean(arcPayload.center));
  const arcFeatures = arcPayload?.features || [];
  const declaredNames = arcFeatures.filter((item) => item.kind === 'declared').map((item) => item.name);
  check('场景1：声明部位都有弧偏差', ['尖耳', '长脸', '翘尾'].every((name) => declaredNames.includes(name)), `实际 ${declaredNames.join(',')}`);
  check('场景1：检测凹口都有弧偏差', arcFeatures.filter((item) => item.kind === 'notch').length === 3, `notch=${arcFeatures.filter((item) => item.kind === 'notch').length}`);
  check('场景1：每条弧偏差口径正确且为有限值', arcFeatures.length > 0 && arcFeatures.every((item) => item.measurement === 'unordered-point-to-route' && Number.isFinite(item.maxOffsetMeters) && item.arcPointCount >= 2), JSON.stringify(arcFeatures.map((item) => item.maxOffsetMeters)));
  check('场景1：弧偏差字段没有写进 metrics', !('featureArcs' in result.metrics) && !('arcMaxOffsetMeters' in result.metrics));
  // 点序列图：成功交付带本轮实际使用的 LLM 目标轮廓（Node 无 canvas，dataUrl 为 null）
  check(
    '场景1：回复附带点序列图（LLM 轮廓，点数一致）',
    response.outline?.source === 'llm' &&
      response.outline?.name === customShapeA.name &&
      response.outline?.pointCount === customShapeA.outlinePoints.length &&
      response.outline?.dataUrl === null,
    JSON.stringify(response.outline),
  );
  // trace 事件记录摘要：渲染失败（无 canvas）要能从日志看出 rendered=false
  const replyEvent = eventsOf('agent.reply')[0]?.data;
  check(
    '场景1：trace 的 agent.reply 记录点序列图摘要',
    replyEvent?.outline?.source === 'llm' &&
      replyEvent?.outline?.name === customShapeA.name &&
      replyEvent?.outline?.pointCount === customShapeA.outlinePoints.length &&
      replyEvent?.outline?.rendered === false,
    JSON.stringify(replyEvent?.outline),
  );
}

// ---------- 场景 1b/1c：近场证据的其余分支（吸附硬伤 / 没有可评价路线） ----------
{
  const result = makeResult({ center: farCenter, outlineLatLngs: outlineLatLngsA });
  const baseBest = {
    result,
    score: 75,
    adjustedScore: 70,
    sizeMeters: 1500,
    rotationDeg: 30,
    center: farCenter,
  };
  const planOutcome = (nearBest) => ({
    status: 'ok',
    result,
    best: baseBest,
    nearBest,
    offset: { meters: 1500, text: '北约 1.5 km' },
    stage: 2,
    stageLabel: '扩大范围',
    triedCount: 120,
    alternatives: [],
  });
  const intent = { action: 'plan', customShape: SAMPLE_A_FREEFORM_RAW, place: '广州', rotationDeg: null, reply: '' };

  // 近场候选吸附 200m：唯一允许说"临水/无路区"的分支
  const snapEngine = makeEngine({
    planResult: planOutcome({
      result: {
        routeLatLngs: [[23.12, 113.32], [23.121, 113.321]],
        metrics: { snapMaxMeters: 200, failedLegs: 0, orderedOutlineMeanMeters: 80, orderedOutlineMaxMeters: 150 },
      },
      score: 35,
      adjustedScore: 30,
      stage: 1,
      stageLabel: '近场搜索',
    }),
  });
  const snapResponse = await runTurn({ text: '在广州画匹马', intents: [intent], engine: snapEngine });
  check('场景1b：近场吸附>120m 时说明可能临水/落在无路区', snapResponse.reply.includes('图形部分区域可能临水或落在无路区'), snapResponse.reply);
  check('场景1b：吸附硬伤分支不编造其它原因', !snapResponse.reply.includes('有序贴合平均'));

  // 近场没有可评价路线（nearBest 为 null）：如实说没有形成可评价的路线
  const noNearEngine = makeEngine({ planResult: planOutcome(null) });
  const noNearResponse = await runTurn({ text: '在广州画匹马', intents: [intent], engine: noNearEngine });
  check('场景1c：近场没有候选时说明没有形成可评价路线', noNearResponse.reply.includes('近场没有形成可评价的路线'), noNearResponse.reply);
  check('场景1c：没有证据时不说临水', !noNearResponse.reply.includes('临水'));

  // 评审 P1 反例：吸附超限短路返回空路线但保留真实 snapMaxMeters → 必须说"可能临水/无路区"，
  // 不能因为 routeLatLngs 为空就退化成"近场没有形成可评价的路线"
  const shortCircuitEngine = makeEngine({
    planResult: planOutcome({
      result: {
        routeLatLngs: [],
        metrics: {
          snapMaxMeters: 139.001,
          failedLegs: 0,
          orderedOutlineMeanMeters: Number.POSITIVE_INFINITY,
          orderedOutlineMaxMeters: Number.POSITIVE_INFINITY,
        },
      },
      score: 0,
      adjustedScore: 0,
      stage: 1,
      stageLabel: '近场搜索',
    }),
  });
  const shortCircuitResponse = await runTurn({ text: '在广州画匹马', intents: [intent], engine: shortCircuitEngine });
  check(
    '场景1b：空路线 + 吸附超限仍说明可能临水/落在无路区',
    shortCircuitResponse.reply.includes('图形部分区域可能临水或落在无路区') &&
      !shortCircuitResponse.reply.includes('近场没有形成可评价的路线'),
    shortCircuitResponse.reply,
  );
}

// ---------- 场景 1d：样本 B 走完整控制器链路后写出 plan.feature.arcs（两个检测凹口） ----------
{
  // 真实路网定点回放得到样本 B 的规划结果（与 test/feature-arcs.mjs 同一固定候选），
  // 再经 mock 引擎交给控制器，验证"选定后写 trace 事件"的接线（不只测纯函数测量层）。
  const roads = JSON.parse(
    readRequiredText(new URL('../mapdata/guangzhou-roads.json', import.meta.url), GUANGZHOU_ROADS_HINT),
  ).roads;
  const realGraph = buildWalkGraph(roads);
  const realEdgeIndex = buildEdgeIndex(realGraph, 0.005, findLargestComponent(realGraph));
  const customShapeB = normalizeCustomShape(SAMPLE_B_FREEFORM_RAW);
  const resultB = planShapeRoute({
    graph: realGraph,
    edgeIndex: realEdgeIndex,
    customShape: customShapeB,
    center: SAMPLE_B_CANDIDATE.center,
    sizeMeters: SAMPLE_B_CANDIDATE.sizeMeters,
    rotationDeg: SAMPLE_B_CANDIDATE.rotationDeg,
  });
  const bestB = {
    result: resultB,
    score: 75,
    adjustedScore: 70,
    sizeMeters: SAMPLE_B_CANDIDATE.sizeMeters,
    rotationDeg: SAMPLE_B_CANDIDATE.rotationDeg,
    center: SAMPLE_B_CANDIDATE.center,
  };
  const engine = makeEngine({
    planResult: {
      status: 'ok',
      result: resultB,
      best: bestB,
      nearBest: null,
      offset: { meters: 0, text: '' },
      stage: 1,
      stageLabel: '近场搜索',
      triedCount: 10,
      alternatives: [],
    },
  });
  const response = await runTurn({
    text: '在广州塔附近画匹马',
    intents: [{ action: 'plan', customShape: SAMPLE_B_FREEFORM_RAW, place: '广州塔', rotationDeg: null, reply: '' }],
    engine,
  });
  const arcEvents = eventsOf('plan.feature.arcs');
  check('场景1d：样本 B 经控制器写出 plan.feature.arcs', arcEvents.length === 1, `事件数=${arcEvents.length}`);
  const payload = arcEvents[0]?.data;
  check(
    '场景1d：事件携带样本 B 候选参数',
    Boolean(payload) &&
      payload.shapeName === '马' &&
      payload.score === 75 &&
      payload.sizeMeters === SAMPLE_B_CANDIDATE.sizeMeters &&
      payload.rotationDeg === SAMPLE_B_CANDIDATE.rotationDeg,
    JSON.stringify({ shapeName: payload?.shapeName, score: payload?.score, sizeMeters: payload?.sizeMeters }),
  );
  const notches = (payload?.features || []).filter((entry) => entry.kind === 'notch');
  // 加密版样本 B（每条边 4 段，满足复杂剪影 80 点下限）检测出 3 个凹口；
  // 原 26 点样本为 2 个——这里验证"实际检测凹口都写出弧偏差"，数量随样本点密度而定
  check('场景1d：含实际检测凹口', notches.length === 3, `实际 ${notches.length}`);
  check(
    '场景1d：检测凹口弧偏差有限且口径正确',
    notches.length === 3 &&
      notches.every(
        (entry) =>
          entry.measurement === 'unordered-point-to-route' &&
          Number.isFinite(entry.maxOffsetMeters) &&
          entry.arcPointCount >= 2,
      ),
    JSON.stringify(notches.map((entry) => entry.maxOffsetMeters)),
  );
  check(
    '场景1d：样本 B 为绿色交付（reference=false）',
    response.reply.includes('已规划') &&
      engine.calls.filter((call) => call.type === 'commitDraw').length === 1 &&
      engine.calls.find((call) => call.type === 'commitDraw')?.options?.reference !== true,
    response.reply,
  );
}

// ---------- 场景 2：recommend + 覆盖中心 + 近场代表候选（近场与最终 metrics 不同） ----------
{
  const drawnCenter = { lat: 23.135, lng: 113.33 };
  const drawnResult = makeResult({ shapeName: '五角星', center: drawnCenter, sizeMeters: 1200, rotationDeg: 0 });
  const drawn = {
    shapeKey: 'star',
    shapeName: '五角星',
    score: 75,
    adjustedScore: 70,
    sizeMeters: 1200,
    rotationDeg: 0,
    center: drawnCenter,
    result: drawnResult,
  };
  const outcome = {
    status: 'ok',
    recommendations: [drawn],
    drawn,
    best: drawn,
    stage: 2,
    stageLabel: '扩大范围',
    triedCount: 900,
    bests: {
      star: { result: drawnResult, score: 75, adjustedScore: 70, center: drawnCenter, sizeMeters: 1200, rotationDeg: 0 },
    },
    nearBests: {
      // 五角星近场吸附超 120m（若误用它会说临水），但调整分低，不是代表候选
      star: {
        result: {
          routeLatLngs: [[23.12, 113.32], [23.121, 113.321]],
          metrics: { snapMaxMeters: 200, failedLegs: 0, orderedOutlineMeanMeters: 88, orderedOutlineMaxMeters: 160 },
        },
        adjustedScore: 50,
        shapeKey: 'star',
        shapeName: '五角星',
        stage: 1,
        stageLabel: '近场搜索',
      },
      // 心形近场调整分最高 → 代表候选（完整路线 + 30/60 有序偏差）
      heart: {
        result: {
          routeLatLngs: [[23.12, 113.32], [23.121, 113.321]],
          metrics: { snapMaxMeters: 5, failedLegs: 0, orderedOutlineMeanMeters: 30, orderedOutlineMaxMeters: 60 },
        },
        adjustedScore: 70,
        shapeKey: 'heart',
        shapeName: '心形',
        stage: 1,
        stageLabel: '近场搜索',
      },
      rect: null,
    },
    offset: { meters: 1200, text: '东约 1.2 km' },
  };
  const engine = makeEngine({ recommendResult: outcome });
  const response = await runTurn({
    text: '在广州能画什么',
    intents: [{ action: 'recommend', place: '广州', reply: '我实测看看。' }],
    engine,
  });
  const recommendCall = engine.calls.find((call) => call.type === 'recommend');
  const commits = engine.calls.filter((call) => call.type === 'commitDraw');
  check('场景2：引擎收到覆盖中心', recommendCall?.options?.center?.lat === expectedCoverageCenter.lat && recommendCall?.options?.center?.lng === expectedCoverageCenter.lng, recommendCall ? JSON.stringify(recommendCall.options.center) : '未调用 recommend');
  check('场景2：推荐偏移说明用代表候选（30/60，不是五角星 88/160）', response.reply.includes('近场最好候选的有序贴合平均 30 m / 最大 60 m'), response.reply);
  check('场景2：代表候选未吸附超限时不说「临水」', !response.reply.includes('临水'));
  check('场景2：覆盖中心主语不写「您指定的地方」', !response.reply.includes('您指定的地方'));
  check('场景2：推荐达标提交一次（非参考版）', commits.length === 1 && commits[0].options?.reference !== true);
  check('场景2：没有把三种图形都归因成同一原因', !response.reply.includes('三种图形都画不出像样的'));
  // 推荐链路没有自定义点列：目标形状取选中候选的内置图形（五角星 30 点）
  check(
    '场景2：回复附带点序列图（内置图形五角星）',
    response.outline?.source === 'builtin' &&
      response.outline?.name === SHAPES.star.name &&
      response.outline?.pointCount === SHAPES.star.buildOutline().length &&
      response.outline?.dataUrl === null,
    JSON.stringify(response.outline),
  );
}

// ---------- 场景 3：覆盖外行政区（番禺区）保留代表点 + outside-coverage 提示 ----------
{
  const engine = makeEngine({
    planResult: {
      status: 'failed',
      result: null,
      best: null,
      bestOverall: null,
      nearBest: null,
      stage: 0,
      stageLabel: '数据范围校验',
      triedCount: 0,
      reason: 'outside-coverage',
    },
  });
  const response = await runTurn({
    text: '在番禺区画个五角星',
    intents: [{ action: 'plan', shape: 'star', place: '番禺区', rotationDeg: null, reply: '好。' }],
    engine,
  });
  const planCall = engine.calls.find((call) => call.type === 'plan');
  check('场景3：行政区代表点传入引擎（22.95, 113.36）', Math.abs(planCall?.options?.center?.lat - 22.95) < 1e-9 && Math.abs(planCall?.options?.center?.lng - 113.36) < 1e-9, planCall ? JSON.stringify(planCall.options.center) : '未调用 plan');
  check('场景3：代表点在覆盖外（等价 outside-coverage 预检）', !pointInBounds(syntheticCoverage, { lat: 22.95, lng: 113.36 }, 0.01));
  check('场景3：回复给出超出路网数据范围提示', response.reply.includes('「番禺区」超出了我的路网数据范围'), response.reply);
  check('场景3：没有静默落到广州塔', !response.reply.includes('广州塔'));
  check('场景3：没有误报近场弧事件（内置图形无特征）', eventsOf('plan.feature.arcs').length === 0);
  // 诚实失败（覆盖外、一条路线都没走）仍要展示"系统理解的目标形状"，让用户核对画的是什么
  check(
    '场景3：诚实失败仍附带点序列图（内置图形五角星）',
    response.outline?.source === 'builtin' &&
      response.outline?.name === SHAPES.star.name &&
      response.outline?.pointCount === SHAPES.star.buildOutline().length,
    JSON.stringify(response.outline),
  );
}

// ---------- 场景 3b：省略「区」的番禺同样识别为覆盖外，不回退视野中心 ----------
{
  const engine = makeEngine({
    planResult: {
      status: 'failed',
      result: null,
      best: null,
      bestOverall: null,
      nearBest: null,
      stage: 0,
      stageLabel: '数据范围校验',
      triedCount: 0,
      reason: 'outside-coverage',
    },
  });
  const response = await runTurn({
    text: '在番禺画个五角星',
    intents: [{ action: 'plan', shape: 'star', place: '番禺', rotationDeg: null, reply: '好。' }],
    engine,
  });
  const planCall = engine.calls.find((call) => call.type === 'plan');
  check('场景3b：「番禺」传入行政区代表点而非视野中心', Math.abs(planCall?.options?.center?.lat - 22.95) < 1e-9 && Math.abs(planCall?.options?.center?.lng - 113.36) < 1e-9, planCall ? JSON.stringify(planCall.options.center) : '未调用 plan');
  check('场景3b：「番禺」回复超出范围且不误报地点未找到', response.reply.includes('「番禺」超出了我的路网数据范围') && !response.reply.includes('改用地图当前视野中心'), response.reply);
  check('场景3b：覆盖外不绘制路线', engine.calls.filter((call) => call.type === 'commitDraw').length === 0);
}

// ---------- 场景 4：覆盖中心解析失败 → 未解析地点不再画到视野中心（默认 ask 策略） ----------
{
  const engine = makeEngine({
    placeContext: { graph: syntheticGraph, nodeIndex: emptyNodeIndex, coverage: syntheticCoverage },
    planResult: () => {
      const result = makeResult({ center: { lat: 23.12, lng: 113.32 }, outlineLatLngs: [] });
      return {
        status: 'ok',
        result,
        best: { result, score: 75, adjustedScore: 75, sizeMeters: 1200, rotationDeg: 0, center: { lat: 23.12, lng: 113.32 } },
        nearBest: null,
        offset: { meters: 0, text: '' },
        stage: 1,
        stageLabel: '近场搜索',
        triedCount: 50,
        alternatives: [],
      };
    },
  });
  const response = await runTurn({
    text: '在广州画个五角星',
    intents: [{ action: 'plan', shape: 'star', place: '广州', rotationDeg: null, reply: '好。' }],
    engine,
  });
  const planCall = engine.calls.find((call) => call.type === 'plan');
  check('场景4：未解析地点不调用规划（不再退到视野中心作画）', !planCall);
  check('场景4：如实说明没在地点配置里找到', response.reply.includes('没在地点配置里找到「广州」'), response.reply);
  check('场景4：回到地点引导并给出选项', response.guide?.slot === 'place' && response.guide?.options?.length === 5);
  check('场景4：不冒充覆盖中心', !response.reply.includes('按已加载路网的覆盖中心定位'));
  check('场景4：引导追问轮未执行规划，不附带点序列图', !response.outline);
}

// ---------- 场景 4b：配置 matching.unresolvedPlace="view-center" 时保留旧回退行为 ----------
{
  const viewCenterConfig = clonePlaceConfig({ matching: { unresolvedPlace: 'view-center' } });
  const engine = makeEngine({
    placeContext: { graph: syntheticGraph, nodeIndex: emptyNodeIndex, coverage: syntheticCoverage },
    planResult: () => {
      const result = makeResult({ center: { lat: 23.12, lng: 113.32 }, outlineLatLngs: [] });
      return {
        status: 'ok',
        result,
        best: { result, score: 75, adjustedScore: 75, sizeMeters: 1200, rotationDeg: 0, center: { lat: 23.12, lng: 113.32 } },
        nearBest: null,
        offset: { meters: 0, text: '' },
        stage: 1,
        stageLabel: '近场搜索',
        triedCount: 50,
        alternatives: [],
      };
    },
  });
  const response = await runTurn({
    text: '在广州画个五角星',
    intents: [{ action: 'plan', shape: 'star', place: '广州', rotationDeg: null, reply: '好。' }],
    engine,
    config: viewCenterConfig,
  });
  const planCall = engine.calls.find((call) => call.type === 'plan');
  check('场景4b：策略为 view-center 时中心为 null（用视图中心）', planCall?.options?.center === null || planCall?.options?.center === undefined);
  check('场景4b：如实说明改用视野中心', response.reply.includes('改用地图当前视野中心'), response.reply);
}

// ---------- 场景 5：重试耗尽后超时 → 统一友好句（不再显示"模型请求超时"原始错误） ----------
{
  llmMode = 'abort';
  llmRequestCount = 0;
  clearLogs();
  const controller = createAgentController({ map, engine: makeEngine({ planResult: null }), placeConfig });
  const response = await controller.send({ text: '画个心形' });
  check('场景5：超时返回友好句', response.reply === '这个我没能理解或生成出来。可以换个说法试试。', response.reply);
  check('场景5：不再显示「智能体解析失败：模型请求超时（180 秒）」', !response.reply.includes('智能体解析失败') && !response.reply.includes('超时'));
  check('场景5：超时仍重试 3 次（每次 180 秒预算不变）', llmRequestCount === 3, `实际 ${llmRequestCount}`);
  check('场景5：超时事件记录 kind=timeout', eventsOf('llm.error').some((record) => record.data?.kind === 'timeout'));
}

// ---------- 场景 6：模型返回无法解析 / 输出截断 → 同一友好句 ----------
for (const [label, mode] of [['模型返回', 'badjson'], ['截断', 'truncated']]) {
  llmMode = mode;
  clearLogs();
  const controller = createAgentController({ map, engine: makeEngine({ planResult: null }), placeConfig });
  const response = await controller.send({ text: '画个复杂的图形' });
  check(`场景6：${label}使用同一友好句`, response.reply === '这个我没能理解或生成出来。可以换个说法试试。', response.reply);
  check(`场景6：${label}不抛「智能体解析失败」`, !response.reply.includes('智能体解析失败'));
}

// ---------- 场景 7：HTTP 接口错误 → 其它错误仍走原分支（抛错并保留 kind） ----------
{
  llmMode = 'http500';
  clearLogs();
  const controller = createAgentController({ map, engine: makeEngine({ planResult: null }), placeConfig });
  let thrown = null;
  try {
    await controller.send({ text: '画个心形' });
  } catch (error) {
    thrown = error;
  }
  check('场景7：HTTP 错误仍抛「智能体解析失败」', Boolean(thrown) && thrown.message.includes('智能体解析失败：'), thrown?.message);
  check('场景7：HTTP 错误保留 kind=http', thrown?.kind === 'http', `kind=${thrown?.kind}`);
  check('场景7：抛错也带本轮 traceId（失败轮可复制定位）', typeof thrown?.traceId === 'string' && /^t-/.test(thrown.traceId), String(thrown?.traceId));
}

// ---------- 场景 8：用户点"停止" —— 真中断且不交付任何结果（需求 R5） ----------
{
  const abortController = new AbortController();
  const result = makeResult({ center: farCenter, outlineLatLngs: outlineLatLngsA });
  const engine = makeEngine({
    planResult: () => {
      // 模拟用户在搜索/交付前点"停止"：引擎返回后编排层必须拦住，不绘制、不清图
      abortController.abort();
      return {
        status: 'ok',
        result,
        best: { result, score: 75, adjustedScore: 70, sizeMeters: 1500, rotationDeg: 30, center: farCenter },
        offset: { meters: 0, text: '' },
        stage: 1,
        stageLabel: '近场搜索',
        triedCount: 10,
        alternatives: [],
      };
    },
  });
  let thrown = null;
  try {
    await runTurn({
      text: '在广州画匹马',
      intents: [{ action: 'plan', customShape: SAMPLE_A_FREEFORM_RAW, place: '广州', rotationDeg: null, reply: '' }],
      engine,
      signal: abortController.signal,
    });
  } catch (error) {
    thrown = error;
  }
  check('停止场景：以中止错误收尾（不按失败/友好句处理）', isAbortError(thrown), String(thrown));
  check(
    '停止场景：不提交绘制（地图保持停止前图形）',
    engine.calls.filter((call) => call.type === 'commitDraw').length === 0,
    `commit=${engine.calls.filter((call) => call.type === 'commitDraw').length}`,
  );
  check(
    '停止场景：不清空旧图形',
    engine.calls.filter((call) => call.type === 'clearDraw').length === 0,
    `clear=${engine.calls.filter((call) => call.type === 'clearDraw').length}`,
  );
  check('停止场景：trace.end 标注 aborted（停止不是失败）', eventsOf('trace.end').some((record) => record.data?.aborted === true));
  check(
    '停止场景：不落 error 级 trace.end',
    !getEntries({ limit: 0 }).some((record) => record.event === 'trace.end' && record.level === 'error'),
  );
}

// ---------- 场景 9：信号已中止时发请求 —— 不调模型、不调引擎（停止后立即可继续输入） ----------
{
  const abortController = new AbortController();
  abortController.abort();
  const engine = makeEngine({ planResult: null });
  let thrown = null;
  try {
    await runTurn({
      text: '在广州画匹马',
      intents: [{ action: 'plan', customShape: SAMPLE_A_FREEFORM_RAW, place: '广州', rotationDeg: null, reply: '' }],
      engine,
      signal: abortController.signal,
    });
  } catch (error) {
    thrown = error;
  }
  check('预中止：抛中止错误', isAbortError(thrown), String(thrown));
  check('预中止：不发起模型请求', llmRequestCount === 0, String(llmRequestCount));
  check('预中止：不调用引擎', engine.calls.length === 0, String(engine.calls.length));
}

console.log(`\n[summary] ${checks - failures}/${checks} 项通过，失败 ${failures} 项`);
if (failures > 0) {
  process.exitCode = 1;
}
