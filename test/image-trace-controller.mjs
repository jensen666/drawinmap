/**
 * 图像描摹接入（B2）测试（Node 直接运行，注入 fake 描摹/引擎/参考源，mock LLM，不依赖浏览器/网络）。
 *
 * 覆盖方案《2026-11-01 长尾图形轮廓来源与贴路上限方案》§3 与 §4.2 的编排规则：
 * 1. 描摹失败：不调用 LLM、不规划、不画线，回复严格只有固定一句；日志留痕；
 * 2. 描摹成功：不把图片交给模型、意图被强制为 plan + 描摹 T；traced 确定性验收通过；
 *    规划请求/落盘 outline/日志三处 contentHash 一致；不走参考通道；绿线交付一次；
 * 3. 目标验收失败（描摹 IoU 低于门槛）：回复区分"轮廓来自这张图，但目标验收没过"，
 *    只做诊断性参考（橙线），不得出现合格绿线，点列仍是描摹结果；
 * 4. 目标验收通过但路网贴不出：回复写"路网贴不出这条外轮廓"，不得写成描摹失败；
 * 5. 图片轮缺地点 → 地点引导 → 补地点后仍不走参考通道、描摹 T 不被覆盖；
 * 6. acceptTracedTarget 确定性验收口径（拓扑/点数区间/描摹 IoU）。
 *
 * 运行：node test/image-trace-controller.mjs
 */

import { createAgentController } from '../web/src/agent/controller.js';
import { normalizeCustomShape } from '../web/src/agent/intent.js';
import { acceptTarget, acceptTracedTarget } from '../web/src/agent/target-acceptance.js';
import { sha256Hex, stableStringify } from '../web/src/reference/hash.js';
import { clearLogs, getEntries, initLogging } from '../web/src/log/index.js';
import { placeConfig } from './fixtures/place-config.mjs';

initLogging({ server: false, storage: false, level: 'debug' });

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

/** 方案 §3 规定的描摹失败固定回复（严格只有这一句） */
const TRACE_REJECT_REPLY = '只接受线稿、剪影、白底或纯色底图标。';

/** 测试用图片 data URL（内容不重要：描摹被注入的 fake 接管） */
const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

/** 图像描摹 contentHash 的 schema（controller 与落盘/日志同口径） */
const HASH_SCHEMA = 'image-trace-v1';

/**
 * 构造一条闭合圆形描摹点列（归一化 [-0.5,0.5]，默认 200 点落在 120~320 区间）。
 * 相邻点距 > normalizeCustomShape 的去重阈值（0.01），归一时不会被抽稀。
 *
 * @param {number} [count] 点数
 * @param {number} [radius] 半径（归一化单位）
 * @returns {Array<[number, number]>} 点列
 */
function circlePoints(count = 200, radius = 0.4) {
  const points = [];
  for (let index = 0; index < count; index += 1) {
    const angle = (Math.PI * 2 * index) / count;
    points.push([
      Number((Math.cos(angle) * radius).toFixed(4)),
      Number((Math.sin(angle) * radius).toFixed(4)),
    ]);
  }
  return points;
}

/** 与 controller 一致的描摹 contentHash 计算（测试侧独立复算，钉住 schema） */
function traceContentHash(points, iou) {
  return sha256Hex(
    stableStringify({
      schema: HASH_SCHEMA,
      points,
      pointCount: points.length,
      iou,
    }),
  );
}

/** 20 点雨滴形描摹点列：用于覆盖成功分支（非圆形也应是合法闭环） */
const TRACE_POINTS = circlePoints(200);
const TRACE_HASH = traceContentHash(TRACE_POINTS, 0.95);
const TRACE_HASH_LOW_IOU = traceContentHash(TRACE_POINTS, 0.5);

/** 描摹成功结果（fake imageTrace 返回值，字段与 image-trace-browser.js 契约一致） */
function makeTraceOk({ iou = 0.95, points = TRACE_POINTS } = {}) {
  return {
    status: 'ok',
    reasons: [],
    points: points.map((point) => [point[0], point[1]]),
    diagnostics: {
      iou,
      pointCount: points.length,
      imageWidth: 512,
      imageHeight: 512,
      background: [255, 255, 255],
    },
  };
}

/** 描摹失败结果（照片/多块碎片场景：抽不出单闭合外轮廓） */
function makeTraceRejected() {
  return {
    status: 'rejected',
    reasons: [{ code: 'multi-part', message: '前景碎成多块，抽不出单闭合外轮廓' }],
    points: null,
    diagnostics: { imageWidth: 512, imageHeight: 512, components: 3 },
  };
}

// ---------- mock LLM：意图请求按队列供给；同时记录完整请求体 ----------
let intentQueue = [];
let capturedBodies = [];

/**
 * 构造一次成功的 chat/completions 响应。
 *
 * @param {object} payload 模型返回的 JSON 载荷
 * @returns {object} fetch Response 形状
 */
function llmResponse(payload) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({
      id: 'mock',
      model: 'mock',
      choices: [{ message: { content: JSON.stringify(payload) }, finish_reason: 'stop' }],
      usage: {},
    }),
  };
}

globalThis.fetch = async (url, options) => {
  // 路网数据请求：返回空路网（地点解析走 POI 别名表即可命中）
  if (typeof url === 'string' && url.includes('/data/guangzhou-roads.json')) {
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ roads: [] }),
    };
  }
  capturedBodies.push(JSON.parse(options.body));
  const payload = intentQueue.shift() || {
    action: 'chat',
    shape: null,
    customShape: null,
    place: null,
    rotationDeg: null,
    reply: '收到',
  };
  return llmResponse(payload);
};

// ---------- 引擎桩（与 test/controller-delivery.mjs 同风格） ----------

/** 构造一次规划结果（metrics 覆盖回复模板用到的字段） */
function makePlanned({ score, tag, shapeName = '图像描摹' }) {
  const result = {
    shapeName,
    routeLatLngs: [[23.12, 113.32], [23.121, 113.321]],
    outlineLatLngs: [[23.12, 113.32], [23.121, 113.321]],
    metrics: {
      routeMeters: 1000,
      walkMinutes: 15,
      detourRatio: 1.2,
      coverage: 100,
      failedLegs: 0,
      snapMaxMeters: 20,
      orderedOutlineMeanMeters: 20,
      orderedOutlineMaxMeters: 40,
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
      featureGapRetainRatio: 1,
    },
    __tag: tag,
  };
  return {
    status: 'ok',
    result,
    best: {
      result,
      score,
      adjustedScore: score,
      sizeMeters: 1200,
      rotationDeg: 0,
      center: { lat: 23.12, lng: 113.32 },
    },
    offset: { meters: 0, text: '' },
    stage: 1,
    stageLabel: '近场搜索',
    triedCount: 100,
  };
}

/** 构造带调用记录的 mock 引擎 */
function makeEngine(planQueue = []) {
  const calls = [];
  return {
    calls,
    plan: async (options) => {
      calls.push({ type: 'plan', options });
      return planQueue.shift();
    },
    recommend: async () => {
      calls.push({ type: 'recommend' });
      throw new Error('图像描摹链路不应走实测推荐');
    },
    commitDraw: (result, options) => calls.push({ type: 'commitDraw', result, options }),
    clearDraw: () => calls.push({ type: 'clearDraw' }),
    formatMinutes: (minutes) => `${Math.round(minutes)} 分钟`,
  };
}

/** 参考候选源桩：被调用即计数（断言图像描摹链路不走参考通道） */
function makeReferenceSource() {
  return {
    calls: 0,
    async resolveCandidates() {
      this.calls += 1;
      return { status: 'miss', candidates: [] };
    },
  };
}

const map = { getCenter: () => ({ lat: 23.12, lng: 113.32 }) };
/** fake 渲染器：仅自由轮廓视觉质检用；图像描摹走确定性验收，不应触发 */
const fakeRender = () => 'data:image/png;base64,FAKE';

/** 抓取指定事件名的日志记录 */
function eventsOf(name) {
  return getEntries({ limit: 0 }).filter((record) => record.event === name);
}

/**
 * 跑一轮图片输入。
 *
 * @param {object} options
 * @param {string} [options.text] 用户文本
 * @param {Function} options.imageTrace 注入的 fake traceImageDataUrl
 * @param {Array<object>} [options.planQueue] 引擎 plan 返回队列
 * @param {Array<object>} [options.intents] LLM 意图队列
 * @returns {Promise<{result: object, calls: Array<object>, steps: Array<object>, referenceSource: object}>}
 */
async function runImageTurn({ text = '', imageTrace, planQueue = [], intents = [] } = {}) {
  intentQueue = [...intents];
  capturedBodies = [];
  clearLogs();
  const engine = makeEngine(planQueue);
  const referenceSource = makeReferenceSource();
  const steps = [];
  const controller = createAgentController({
    map,
    engine,
    placeConfig,
    imageTrace,
    referenceSource,
    shapeReviewDeps: { renderOutline: fakeRender },
  });
  const result = await controller.send(
    { text, imageDataUrl: IMAGE },
    (step) => steps.push(step),
  );
  return { result, calls: engine.calls, steps, referenceSource };
}

// ========================================================================
// 一、描摹失败：不调用 LLM、不规划、不画线，回复严格只有固定一句
// ========================================================================
{
  const { result, calls, referenceSource, steps } = await runImageTurn({
    text: '画这个',
    imageTrace: async () => makeTraceRejected(),
  });
  check('描摹失败：不调用 LLM（请求数 0）', capturedBodies.length === 0, `实际 ${capturedBodies.length}`);
  check(
    '描摹失败：不规划、不提交绘制、不清空（引擎调用 0 次）',
    calls.length === 0,
    JSON.stringify(calls.map((call) => call.type)),
  );
  check('描摹失败：回复严格只有方案固定句', result.reply === TRACE_REJECT_REPLY, JSON.stringify(result.reply));
  check('描摹失败：planned 为 null、无图形快照', result.planned === null && !result.outline && !result.shape);
  check(
    '描摹失败：先报进度「描摹图片外轮廓…」',
    steps.some((step) => typeof step.text === 'string' && step.text.includes('描摹图片外轮廓')),
    JSON.stringify(steps),
  );
  const rejected = eventsOf('agent.imageTrace.rejected');
  check(
    '描摹失败：日志 agent.imageTrace.rejected 含 reasons/diagnostics',
    rejected.length === 1
      && rejected[0].data?.reasons?.[0]?.code === 'multi-part'
      && rejected[0].data?.diagnostics?.components === 3,
    JSON.stringify(rejected[0]?.data),
  );
  check('描摹失败：不走参考通道', referenceSource.calls === 0);
}

// ========================================================================
// 二、描摹成功：traced 验收通过 → 绿线交付；三处 contentHash 一致；不走参考通道
// ========================================================================
{
  const { result, calls, referenceSource, steps } = await runImageTurn({
    text: '画这张图',
    imageTrace: async () => makeTraceOk(),
    planQueue: [makePlanned({ score: 80, tag: 'GREEN' })],
    intents: [
      {
        action: 'plan',
        shape: 'star',
        customShape: null,
        place: '广州塔',
        rotationDeg: null,
        reply: '看起来像五角星',
      },
    ],
  });

  check('描摹成功：只发一次 LLM 请求', capturedBodies.length === 1, `实际 ${capturedBodies.length}`);
  check(
    '描摹成功：模型请求不含图片（无 image_url / data:image）',
    !JSON.stringify(capturedBodies[0]).includes('data:image')
      && !JSON.stringify(capturedBodies[0]).includes('image_url'),
  );
  const userMessage = capturedBodies[0].messages[capturedBodies[0].messages.length - 1];
  check(
    '描摹成功：意图文本带"系统已直接描摹…不需要识别图片内容"括注',
    typeof userMessage.content === 'string' && userMessage.content.includes('直接描摹图片外轮廓'),
    JSON.stringify(userMessage),
  );

  const plans = calls.filter((call) => call.type === 'plan');
  const commits = calls.filter((call) => call.type === 'commitDraw');
  check(
    '描摹成功：规划的 T 来源为 traced 且点数在 120~320',
    plans.length === 1
      && plans[0].options.customShape?.source === 'traced'
      && plans[0].options.customShape?.outlinePoints?.length >= 120
      && plans[0].options.customShape?.outlinePoints?.length <= 320,
    JSON.stringify({ planCount: plans.length, source: plans[0]?.options.customShape?.source }),
  );
  check(
    '描摹成功：LLM 的图形猜测被覆盖（plan + traced T + 固定 reply）',
    result.reply.includes('已从这张图描出目标轮廓（实心外轮廓，中间空洞不保留）。')
      && !result.reply.includes('看起来像五角星'),
    result.reply.slice(0, 160),
  );
  check(
    '描摹成功：outline 来源/名称/点数为图像描摹',
    result.outline?.source === 'traced'
      && result.outline?.name === '图像描摹'
      && result.outline?.pointCount === plans[0].options.customShape.outlinePoints.length,
    JSON.stringify({ source: result.outline?.source, name: result.outline?.name, pointCount: result.outline?.pointCount }),
  );
  check(
    '描摹成功：落盘 outline 含归一化 points（120~320 点，[-0.5,0.5]）',
    Array.isArray(result.outline?.points)
      && result.outline.points.length === result.outline.pointCount
      && result.outline.points.every(
        (point) => Array.isArray(point)
          && Math.abs(point[0]) <= 0.5 + 1e-9
          && Math.abs(point[1]) <= 0.5 + 1e-9,
      ),
    JSON.stringify({ hasPoints: Array.isArray(result.outline?.points), count: result.outline?.points?.length }),
  );

  const used = eventsOf('agent.imageTrace.used');
  const planRequests = eventsOf('plan.request');
  const accepted = eventsOf('target.accepted');
  check(
    '描摹成功：contentHash 三处一致（outline === imageTrace.used === plan.request.customShape）',
    used.length === 1
      && planRequests.length === 1
      && result.outline?.contentHash === TRACE_HASH
      && used[0].data?.contentHash === TRACE_HASH
      && planRequests[0].data?.customShape?.contentHash === TRACE_HASH,
    JSON.stringify({
      outline: result.outline?.contentHash,
      used: used[0]?.data?.contentHash,
      plan: planRequests[0]?.data?.customShape?.contentHash,
    }),
  );
  check(
    '描摹成功：日志 agent.imageTrace.used 元数据完整',
    used[0].data?.origin === 'image-trace'
      && used[0].data?.source === 'traced'
      && used[0].data?.pointCount === 200
      && used[0].data?.iou === 0.95
      && used[0].data?.imageWidth === 512
      && used[0].data?.imageHeight === 512
      && Array.isArray(used[0].data?.background),
    JSON.stringify(used[0]?.data),
  );
  check(
    '描摹成功：目标验收按 traced 通过（不视觉质检）',
    accepted.length === 1
      && accepted[0].data?.source === 'traced'
      && accepted[0].data?.checks?.iou === 0.95
      && accepted[0].data?.checks?.topology === true,
    JSON.stringify(accepted[0]?.data),
  );
  check(
    '描摹成功：不走参考通道（源未被调用、日志无 reference.candidates）',
    referenceSource.calls === 0 && eventsOf('reference.candidates').length === 0,
    `referSource.calls=${referenceSource.calls}`,
  );
  check(
    '描摹成功：绿线交付一次（reference 非 true）',
    commits.length === 1 && !commits[0]?.options?.reference,
    JSON.stringify(commits.map((call) => call.options)),
  );
  check(
    '描摹成功：进度先描摹后理解需求',
    steps.findIndex((step) => step.text?.includes('描摹图片外轮廓')) <
      steps.findIndex((step) => step.text?.includes('理解需求')),
    JSON.stringify(steps.map((step) => step.text)),
  );
}

// ========================================================================
// 三、目标验收失败（描摹 IoU 低于门槛）：诊断参考（橙线）+ 明确区分两件事
// ========================================================================
{
  const { result, calls } = await runImageTurn({
    text: '画这个',
    imageTrace: async () => makeTraceOk({ iou: 0.5 }),
    planQueue: [makePlanned({ score: 90, tag: 'DIAG' })],
    intents: [
      { action: 'plan', shape: null, customShape: null, place: '广州塔', rotationDeg: null, reply: '收到' },
    ],
  });
  const plans = calls.filter((call) => call.type === 'plan');
  const commits = calls.filter((call) => call.type === 'commitDraw');
  check(
    '目标验收失败：回复含「轮廓来自这张图，但目标验收没过」',
    typeof result.reply === 'string' && result.reply.includes('轮廓来自这张图，但目标验收没过'),
    result.reply.slice(0, 200),
  );
  check(
    '目标验收失败：只做一次诊断性参考规划（不得正式规划）',
    plans.length === 1 && eventsOf('plan.request')[0]?.data?.purpose === 'diagnostic',
    JSON.stringify({ planCount: plans.length, purpose: eventsOf('plan.request')[0]?.data?.purpose }),
  );
  check(
    '目标验收失败：只提交橙色参考版（非合格），绿线不出现',
    commits.length === 1
      && commits[0].options?.reference === true
      && !result.reply.includes('已规划'),
    JSON.stringify(commits.map((call) => call.options)),
  );
  check(
    '目标验收失败：点列仍是描摹结果（source/contentHash 一致）',
    result.outline?.source === 'traced'
      && result.outline?.contentHash === TRACE_HASH_LOW_IOU
      && result.outline?.pointCount === 200,
    JSON.stringify({ source: result.outline?.source, hash: result.outline?.contentHash }),
  );
  const rejected = eventsOf('target.rejected');
  check(
    '目标验收失败：日志 target.rejected source=traced 且记 iou',
    rejected.length === 1
      && rejected[0].data?.source === 'traced'
      && rejected[0].data?.checks?.iou === 0.5,
    JSON.stringify(rejected[0]?.data),
  );
}

// ========================================================================
// 四、目标验收通过但路网贴不出：写"路网贴不出这条外轮廓"，不写成描摹失败
// ========================================================================
{
  const fallback = {
    ...makePlanned({ score: 55, tag: 'FALLBACK' }),
    status: undefined,
    best: null,
    bestOverall: makePlanned({ score: 55, tag: 'FALLBACK' }).best,
    result: null,
    stage: 1,
    stageLabel: '近场搜索',
    triedCount: 100,
  };
  // 规划结果 failed：有最像的一版（bestOverall 带可绘制路线）→ 橙色参考版
  const plannedFailed = {
    status: 'failed',
    best: null,
    bestOverall: fallback.bestOverall,
    stage: 1,
    stageLabel: '近场搜索',
    triedCount: 100,
  };
  const { result, calls } = await runImageTurn({
    text: '画这个',
    imageTrace: async () => makeTraceOk(),
    planQueue: [plannedFailed],
    intents: [
      { action: 'plan', shape: null, customShape: null, place: '广州塔', rotationDeg: null, reply: '收到' },
    ],
  });
  const commits = calls.filter((call) => call.type === 'commitDraw');
  check(
    '贴不出：回复写明「路网贴不出这条外轮廓」',
    typeof result.reply === 'string' && result.reply.includes('路网贴不出'),
    result.reply.slice(0, 240),
  );
  check(
    '贴不出：不写成描摹失败/抽不出轮廓',
    !result.reply.includes('描摹失败') && !result.reply.includes('抽不出轮廓'),
    result.reply.slice(0, 240),
  );
  check(
    '贴不出：交付橙色参考版一次',
    commits.length === 1 && commits[0].options?.reference === true,
    JSON.stringify(commits.map((call) => call.options)),
  );
  check(
    '贴不出：outline 仍是描摹点列',
    result.outline?.source === 'traced' && result.outline?.contentHash === TRACE_HASH,
    JSON.stringify({ source: result.outline?.source, hash: result.outline?.contentHash }),
  );
  check(
    '贴不出：目标验收先通过（route 验收失败，不是目标失败）',
    eventsOf('target.accepted').length === 1 && eventsOf('target.rejected').length === 0,
  );
}

// ========================================================================
// 五、图片轮缺地点 → 地点引导 → 补地点后仍不走参考通道、描摹 T 不被覆盖
// ========================================================================
{
  intentQueue = [
    { action: 'plan', shape: null, customShape: null, place: null, rotationDeg: null, reply: '收到' },
  ];
  capturedBodies = [];
  clearLogs();
  const engine = makeEngine([makePlanned({ score: 80, tag: 'GUIDED' })]);
  const referenceSource = makeReferenceSource();
  const controller = createAgentController({
    map,
    engine,
    placeConfig,
    imageTrace: async () => makeTraceOk(),
    referenceSource,
    shapeReviewDeps: { renderOutline: fakeRender },
  });
  const first = await controller.send({ text: '', imageDataUrl: IMAGE });
  check(
    '引导：图片轮缺地点先追问（选项含当前视野中心）',
    first.planned === null
      && first.guide?.slot === 'place'
      && (first.guide?.options || []).some((option) => option.value === '就在当前视野中心画'),
    JSON.stringify(first.guide),
  );
  check('引导：图片轮不直接规划', engine.calls.length === 0, JSON.stringify(engine.calls.map((call) => call.type)));

  clearLogs();
  const second = await controller.send({ text: '就在当前视野中心画' });
  const plans = engine.calls.filter((call) => call.type === 'plan');
  const commits = engine.calls.filter((call) => call.type === 'commitDraw');
  check(
    '引导补地点后：仍用描摹 T 规划（source=traced，点数一致）',
    plans.length === 1
      && plans[0].options.customShape?.source === 'traced'
      && plans[0].options.customShape?.outlinePoints?.length === 200,
    JSON.stringify({ planCount: plans.length, source: plans[0]?.options.customShape?.source }),
  );
  check(
    '引导补地点后：仍不走参考通道',
    referenceSource.calls === 0 && eventsOf('reference.candidates').length === 0,
  );
  check(
    '引导补地点后：outline 来源 traced 且 contentHash 与首次描摹一致',
    second.outline?.source === 'traced'
      && second.outline?.contentHash === TRACE_HASH
      && eventsOf('agent.imageTrace.used').length === 0,
    JSON.stringify({ source: second.outline?.source, hash: second.outline?.contentHash }),
  );
  check(
    '引导补地点后：绿线交付一次',
    commits.length === 1 && !commits[0].options?.reference,
    JSON.stringify(commits.map((call) => call.options)),
  );
}

// ========================================================================
// 五半、图片轮尺寸基准补齐（E2E 实测缺陷回归）：
// 图片轮 LLM 只解析地点、常返回 recommend/chat（无图形）→ normalizeIntent 不给尺寸基准；
// 强制 plan 后必须补 1200 默认基准（否则引擎 baseSizeMeters=null → 全部候选 0 尺寸、
// 8/8 描摹图贴不出、回复出现 0.00km 假参考版）；用户原文显式尺寸仍优先。
// ========================================================================
{
  const { calls } = await runImageTurn({
    text: '画这张图',
    imageTrace: async () => makeTraceOk(),
    planQueue: [makePlanned({ score: 80, tag: 'DEFAULT-SIZE' })],
    intents: [{ action: 'recommend', shape: null, customShape: null, place: '广州塔', rotationDeg: null, reply: '收到' }],
  });
  const plans = calls.filter((call) => call.type === 'plan');
  check(
    '尺寸基准：图片轮 LLM 返回 recommend（无图形）时强制 plan 并补默认 1200m',
    plans.length === 1 && plans[0].options.sizeMeters === 1200,
    JSON.stringify({ planCount: plans.length, sizeMeters: plans[0]?.options.sizeMeters }),
  );
}
{
  const { calls } = await runImageTurn({
    text: '这张图尺寸 800 米',
    imageTrace: async () => makeTraceOk(),
    planQueue: [makePlanned({ score: 80, tag: 'EXPLICIT-SIZE' })],
    intents: [{ action: 'recommend', shape: null, customShape: null, place: '广州塔', rotationDeg: null, reply: '收到' }],
  });
  const plans = calls.filter((call) => call.type === 'plan');
  check(
    '尺寸基准：图片轮用户原文显式尺寸 800m 优先于默认基准',
    plans.length === 1 && plans[0].options.sizeMeters === 800,
    JSON.stringify({ planCount: plans.length, sizeMeters: plans[0]?.options.sizeMeters }),
  );
}
{
  // 退化候选防御：引擎返回路线点 <2 的候选时不得提交橙色"0.00km 参考版"
  const degenerate = makePlanned({ score: 0, tag: 'DEGENERATE' });
  degenerate.best.result.routeLatLngs = [[23.12, 113.32]];
  const { result, calls } = await runImageTurn({
    text: '画这张图',
    imageTrace: async () => makeTraceOk(),
    planQueue: [degenerate],
    intents: [{ action: 'plan', shape: null, customShape: null, place: '广州塔', rotationDeg: null, reply: '收到' }],
  });
  const commits = calls.filter((call) => call.type === 'commitDraw');
  check(
    '退化候选：路线点 <2 不提交橙色参考版（走诚实失败）',
    commits.length === 0 && typeof result.reply === 'string' && result.reply.length > 0,
    JSON.stringify({ commits: commits.map((call) => call.options), reply: result.reply?.slice(0, 120) }),
  );
}

// ========================================================================
// 六、acceptTracedTarget 确定性验收口径（拓扑/点数区间/描摹 IoU）
// ========================================================================
{
  const passShape = normalizeCustomShape({ name: '图像描摹', points: TRACE_POINTS });
  check(
    '验收：合法描摹 T（200 点、IoU 0.95）通过',
    Boolean(passShape) && acceptTracedTarget(passShape, { iou: 0.95 }).verdict === 'pass',
  );
  const passChecks = acceptTracedTarget(passShape, { iou: 0.95 }).checks;
  check(
    '验收：checks 记录 source/topology/pointCount/iou',
    passChecks.source === 'traced'
      && passChecks.topology === true
      && passChecks.pointCount === passShape.outlinePoints.length
      && passChecks.iou === 0.95,
    JSON.stringify(passChecks),
  );
  check(
    '验收：IoU 低于门槛拒绝',
    acceptTracedTarget(passShape, { iou: 0.5 }).verdict === 'fail',
  );
  check(
    '验收：缺描摹元数据拒绝',
    acceptTracedTarget(passShape, null).verdict === 'fail',
  );
  const lowPoints = { outlinePoints: circlePoints(100) };
  check(
    '验收：点数低于 120 拒绝',
    acceptTracedTarget(lowPoints, { iou: 0.95 }).verdict === 'fail',
  );
  const highPoints = { outlinePoints: circlePoints(400) };
  check(
    '验收：点数高于 320 拒绝',
    acceptTracedTarget(highPoints, { iou: 0.95 }).verdict === 'fail',
  );
  check(
    '验收：统一入口 acceptTarget 支持 traced 分派',
    acceptTarget({ source: 'traced', customShape: passShape, traceMeta: { iou: 0.95 } }).verdict === 'pass',
  );
}

console.log(`\n[summary] ${checks - failures}/${checks} 项通过，失败 ${failures} 项`);
if (failures > 0) {
  process.exitCode = 1;
}
