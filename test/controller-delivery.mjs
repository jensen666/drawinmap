/**
 * 交付一致性测试（Node 直接运行，mock LLM + mock 引擎，不依赖浏览器/网络）。
 *
 * 背景：搜索曾经"边搜边画"（shape-engine 在搜索成功时就 drawResult），控制器
 * 随后才比较两版候选/过交付闸门——第二版更差或失败时地图与回复不一致，
 * 低于闸门的候选也已画在图上。修复后搜索无副作用，最终选定并通过闸门后
 * 才 commitDraw 一次。
 *
 * 2026-10-31 目标验收闸门（方案 §8/§9）后覆盖：
 * - 路线贴合低（<70）不再触发"重画 T"质量追击：合格 T 在路网重试中固定
 * - 自由轮廓必须通过视觉质检（注入 fake 渲染 + 结论）才进入正式规划
 * - 目标验收未通过 → 只做诊断性参考规划（橙色非合格），路线分再高也不转绿
 * - 低于交付闸门 → 参考版（reference=true）；无候选 → 清空 + 诚实失败
 * - 推荐链路低于/达标闸门的提交行为
 * - 图片轮：改为本地描摹（方案 2026-11-01 §3）——Node 无 canvas 时固定拒绝、不调 LLM 不规划
 * - 参考图命中：跳过视觉质检，且不被质量追击覆盖
 *
 * 运行：node test/controller-delivery.mjs
 */

import { createAgentController } from '../web/src/agent/controller.js';
import { normalizeCustomShape } from '../web/src/agent/intent.js';
import { SHAPES } from '../web/src/engine/shapes.js';
import { placeConfig } from './fixtures/place-config.mjs';

let failures = 0;

/** 断言工具 */
function check(label, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) {
    failures += 1;
  }
  console.log(`[check] ${label} -> ${ok ? 'PASS' : `FAIL ${detail}`}`);
}

/** 构造一次规划结果（metrics 覆盖 composeReply 用到的字段） */
function makePlanned({ score, adjustedScore, sizeMeters = 1200, tag }) {
  const result = {
    shapeName: '马',
    routeLatLngs: [[23.12, 113.32], [23.121, 113.321]],
    outlineLatLngs: [[23.12, 113.32], [23.121, 113.321]],
    metrics: {
      routeMeters: 1000,
      walkMinutes: 15,
      detourRatio: 1.2,
      coverage: 100,
      failedLegs: 0,
      snapMaxMeters: 20,
      keyCoverage: 1,
      collapsedKeyCount: 0,
      keyMaxOffsetRatio: 0.01,
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
      adjustedScore,
      sizeMeters,
      rotationDeg: 0,
      center: { lat: 23.12, lng: 113.32 },
    },
    offset: { meters: 0, text: '' },
    stage: 1,
    stageLabel: '近场搜索',
    triedCount: 100,
  };
}

/** 合法的马轮廓（正方形足够通过归一化与拓扑校验） */
const HORSE_A = {
  name: '马A',
  points: [[-0.4, -0.4], [0.4, -0.4], [0.4, 0.4], [-0.4, 0.4]],
};

/** LLM 意图返回队列（每次 chatCompletion 取一个） */
let intentQueue = [];
/** 视觉质检返回队列（system 含"质检员"的请求取一个） */
let reviewQueue = [];
/** 捕获的 LLM 请求体（校验图片透传） */
let capturedBodies = [];

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
  capturedBodies.push(options.body);
  const system = JSON.parse(options.body).messages?.[0]?.content || '';
  let payload;
  if (system.includes('质检员')) {
    payload = reviewQueue.shift() || { verdict: 'like', seen: 'ok', issues: [] };
  } else {
    payload = intentQueue.shift() || {
      action: 'chat',
      shape: null,
      customShape: null,
      place: null,
      rotationDeg: null,
      reply: '收到',
    };
  }
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
};

/** 构造带调用记录的 mock 引擎 */
function makeEngine(planQueue = [], recommendQueue = []) {
  const calls = [];
  return {
    calls,
    plan: async (options) => {
      calls.push({ type: 'plan', options });
      return planQueue.shift();
    },
    recommend: async (options) => {
      calls.push({ type: 'recommend', options });
      return recommendQueue.shift();
    },
    commitDraw: (result, options) => calls.push({ type: 'commitDraw', result, options }),
    clearDraw: () => calls.push({ type: 'clearDraw' }),
    formatMinutes: (minutes) => `${Math.round(minutes)} 分钟`,
  };
}

const map = { getCenter: () => ({ lat: 23.12, lng: 113.32 }) };

/** fake 渲染器：注入后自由轮廓的视觉质检可用（verdict 由 reviewQueue 控制） */
const fakeRender = () => 'data:image/png;base64,FAKE';

/** 跑一轮对话，返回 { result, calls } */
async function runTurn({ text = '在广州画个马', imageDataUrl = null, planQueue = [], recommendQueue = [], intents = [], reviews = [], renderOutline = fakeRender } = {}) {
  intentQueue = [...intents];
  reviewQueue = [...reviews];
  capturedBodies = [];
  const engine = makeEngine(planQueue, recommendQueue);
  const controller = createAgentController({ map, engine, placeConfig, shapeReviewDeps: { renderOutline } });
  const result = await controller.send({ text, imageDataUrl });
  return { result, calls: engine.calls };
}

// ---------- 场景 1：路线贴合低（<60）→ T 固定不重画（质量追击已取消） ----------
{
  const first = makePlanned({ score: 55, adjustedScore: 60, tag: 'A' });
  const { result, calls } = await runTurn({
    planQueue: [first],
    intents: [
      { action: 'plan', shape: null, customShape: HORSE_A, place: '广州塔', rotationDeg: null, reply: '画马' },
    ],
    reviews: [{ verdict: 'like', seen: '一匹马', issues: [] }],
  });
  const plans = calls.filter((c) => c.type === 'plan');
  const commits = calls.filter((c) => c.type === 'commitDraw');
  const clears = calls.filter((c) => c.type === 'clearDraw');
  check('固定 T：规划只调用 1 次（不重画 T）', plans.length === 1, `plan ${plans.length}`);
  check('固定 T：55 分低于交付线 → 参考版提交一次', commits.length === 1 && commits[0].options?.reference === true);
  check('固定 T：没有清空图层', clears.length === 0);
  check('固定 T：回复成功说明参考', typeof result.reply === 'string' && result.reply.includes('非合格'));
  check('固定 T：不发起第二次意图 LLM 请求（不重画）', capturedBodies.filter((body) => !JSON.parse(body).messages?.[0]?.content?.includes('质检员')).length === 1);
  // 点序列图跟随通过验收的 T
  check(
    '固定 T：点序列图用本轮 T 轮廓',
    result.outline?.source === 'llm' &&
      result.outline?.name === HORSE_A.name &&
      result.outline?.pointCount === normalizeCustomShape(HORSE_A).outlinePoints.length,
    JSON.stringify(result.outline),
  );
}

// ---------- 场景 2：路线达标 → 绿线交付一次（双评分文案） ----------
{
  const first = makePlanned({ score: 75, adjustedScore: 75, tag: 'A' });
  const { result, calls } = await runTurn({
    planQueue: [first],
    intents: [
      { action: 'plan', shape: null, customShape: HORSE_A, place: '广州塔', rotationDeg: null, reply: '画马' },
    ],
    reviews: [{ verdict: 'like', seen: '一匹马', issues: [] }],
  });
  const commits = calls.filter((c) => c.type === 'commitDraw');
  check('达标：提交绿线一次（reference=false）', commits.length === 1 && !commits[0].options?.reference);
  check('达标：回复含路线贴合（双评分文案）', result.reply.includes('路线贴合 75'), result.reply.slice(0, 120));
  check('达标：回复不再用"评分"表述', !result.reply.includes('评分'));
}

// ---------- 场景 3：视觉质检 unlike → 诊断参考（路线分再高也不转绿） ----------
{
  const first = makePlanned({ score: 90, adjustedScore: 90, tag: 'A' });
  const { result, calls } = await runTurn({
    planQueue: [first],
    intents: [
      { action: 'plan', shape: null, customShape: HORSE_A, place: '广州塔', rotationDeg: null, reply: '画马' },
    ],
    reviews: [
      { verdict: 'unlike', seen: '方波腿', issues: ['四条腿呈方波'] },
      { verdict: 'unlike', seen: '仍不像', issues: ['仍机械'] },
    ],
  });
  const plans = calls.filter((c) => c.type === 'plan');
  const commits = calls.filter((c) => c.type === 'commitDraw');
  check('目标不合格：只做一次诊断性参考规划', plans.length === 1, `plan ${plans.length}`);
  check('目标不合格：橙色参考版', commits.length === 1 && commits[0].options?.reference === true);
  check('目标不合格：回复区分目标未通过', result.reply.includes('目标验收没有通过'));
  check('目标不合格：回复标注非合格参考', result.reply.includes('非合格'));
  check('目标不合格：路线高分未转绿', !result.reply.includes('已规划'));
}

// ---------- 场景 3.5：视觉质检不可用（无渲染）→ 不正式规划，诚实失败/诊断参考 ----------
{
  const { result, calls } = await runTurn({
    planQueue: [makePlanned({ score: 90, adjustedScore: 90, tag: 'A' })],
    intents: [
      { action: 'plan', shape: null, customShape: HORSE_A, place: '广州塔', rotationDeg: null, reply: '画马' },
    ],
    renderOutline: () => null,
  });
  const plans = calls.filter((c) => c.type === 'plan');
  check('验收不可用：不绿线交付', !result.reply.includes('已规划'));
  check('验收不可用：只做诊断参考或诚实失败（至多 1 次规划）', plans.length <= 1, `plan ${plans.length}`);
  // 诊断参考时提交橙色参考版；无可绘制时清空——两者都必须明确"目标未通过"
  check('验收不可用：回复说明目标验收未通过', result.reply.includes('目标验收没有通过'), result.reply.slice(0, 120));
}

// ---------- 场景 4：完全无候选 → 不画、诚实失败（目标已验收通过） ----------
{
  const { result, calls } = await runTurn({
    planQueue: [
      {
        status: 'failed',
        result: null,
        best: null,
        bestOverall: null,
        stage: 1,
        stageLabel: '近场搜索',
        triedCount: 100,
      },
    ],
    intents: [
      { action: 'plan', shape: null, customShape: HORSE_A, place: '广州塔', rotationDeg: null, reply: '画马' },
    ],
    reviews: [{ verdict: 'like', seen: '一匹马', issues: [] }],
  });
  const commits = calls.filter((c) => c.type === 'commitDraw');
  const clears = calls.filter((c) => c.type === 'clearDraw');
  check('无候选：不提交绘制', commits.length === 0, `commit ${commits.length}`);
  check('无候选：清空图层一次', clears.length === 1);
  check('无候选：回复说明画不出来', result.reply.includes('画不出'));
  // 诚实失败（一张路线都没画）同样附带目标点序列图：让用户看到系统理解的目标轮廓
  check(
    '无候选：诚实失败仍附带点序列图（LLM 轮廓）',
    result.outline?.source === 'llm' &&
      result.outline?.name === HORSE_A.name &&
      result.outline?.pointCount === normalizeCustomShape(HORSE_A).outlinePoints.length,
    JSON.stringify(result.outline),
  );
}

// ---------- 场景 5：推荐链路低于交付闸门 → 参考版（与单图形规则一致） ----------
{
  const drawn = {
    shapeName: '心形',
    shapeKey: 'heart',
    score: 55,
    adjustedScore: 55,
    sizeMeters: 1200,
    rotationDeg: 0,
    center: { lat: 23.12, lng: 113.32 },
    result: makePlanned({ score: 55, adjustedScore: 55, tag: 'R' }).result,
  };
  const outcome = {
    status: 'ok',
    recommendations: [drawn],
    drawn,
    best: drawn,
    stage: 1,
    stageLabel: '近场搜索',
    triedCount: 300,
    bests: {},
    offset: { meters: 0, text: '' },
  };
  const { result, calls } = await runTurn({
    text: '在珠江新城附近能画什么',
    recommendQueue: [outcome],
    intents: [
      { action: 'recommend', shape: null, customShape: null, place: '珠江新城', rotationDeg: null, reply: '看看能画什么' },
    ],
  });
  const commits = calls.filter((c) => c.type === 'commitDraw');
  const clears = calls.filter((c) => c.type === 'clearDraw');
  check(
    '推荐低于闸门：提交参考版一次（reference=true）',
    commits.length === 1 && commits[0].options?.reference === true,
    `commit ${commits.length}`,
  );
  check('推荐低于闸门：不清空图层（参考版要留在图上）', clears.length === 0);
  check('推荐低于闸门：回复标注非合格参考', result.reply.includes('非合格') && result.reply.includes('参考'));
  // 推荐链路没有自定义点列：点序列图取选中候选的内置图形（shapeKey 来自引擎候选）
  check(
    '推荐低于闸门：参考版附带点序列图（内置心形）',
    result.outline?.source === 'builtin' &&
      result.outline?.name === SHAPES.heart.name &&
      result.outline?.pointCount === SHAPES.heart.buildOutline().length,
    JSON.stringify(result.outline),
  );
}

// ---------- 场景 6：推荐链路达标 → 提交一次 ----------
{
  const drawn = {
    shapeName: '心形',
    score: 75,
    adjustedScore: 75,
    sizeMeters: 1200,
    rotationDeg: 0,
    center: { lat: 23.12, lng: 113.32 },
    result: makePlanned({ score: 75, adjustedScore: 75, tag: 'R2' }).result,
  };
  const outcome = {
    status: 'ok',
    recommendations: [drawn],
    drawn,
    best: drawn,
    stage: 1,
    stageLabel: '近场搜索',
    triedCount: 300,
    bests: {},
    offset: { meters: 0, text: '' },
  };
  const { calls } = await runTurn({
    text: '在珠江新城附近能画什么',
    recommendQueue: [outcome],
    intents: [
      { action: 'recommend', shape: null, customShape: null, place: '珠江新城', rotationDeg: null, reply: '看看能画什么' },
    ],
  });
  const commits = calls.filter((c) => c.type === 'commitDraw');
  check('推荐达标：提交一次', commits.length === 1);
  check('推荐达标：提交的是选中候选', commits[0]?.result.__tag === 'R2');
}

// ---------- 场景 7：图片轮改为本地描摹（方案 2026-11-01 §3；Node 无 canvas → 固定拒绝句） ----------
{
  const imageDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
  const { result, calls } = await runTurn({
    text: '画这张图',
    imageDataUrl,
    planQueue: [makePlanned({ score: 75, adjustedScore: 75, tag: 'A' })],
    intents: [
      { action: 'plan', shape: null, customShape: HORSE_A, place: '广州塔', rotationDeg: null, reply: '画图' },
    ],
    reviews: [{ verdict: 'like', seen: '像', issues: [] }],
  });
  // 图片不再交给模型估点/识别：Node 环境没有 canvas，描摹返回 rejected `no-canvas`，
  // 编排层不调用 LLM、不规划、不画线，只回方案规定的固定一句
  check('图片轮：不发起任何 LLM 请求（含视觉质检）', capturedBodies.length === 0, `实际 ${capturedBodies.length}`);
  check('图片轮：不规划、不绘制', calls.length === 0, JSON.stringify(calls.map((call) => call.type)));
  check(
    '图片轮：回复严格只有固定拒绝句',
    result.reply === '只接受线稿、剪影、白底或纯色底图标。',
    JSON.stringify(result.reply),
  );
}

// ---------- 场景 8：参考图命中 → 跳过视觉质检、T 不被覆盖 ----------
{
  // 参考图源：任何文本都命中（模拟本地 seed 命中链路）
  const referenceShapeSource = async () => {
    const referenceShape = normalizeCustomShape(HORSE_A);
    return referenceShape
      ? { customShape: referenceShape, asset: { id: 'horse-phylopic', names: { zh: ['马'] }, source: { license: 'CC0-1.0' } }, matchedAlias: '马', conversion: { T: { pointCount: 320 } } }
      : null;
  };
  const first = makePlanned({ score: 65, adjustedScore: 80, tag: 'A' });
  intentQueue = [
    // LLM 返回的意图（会被参考图 customShape 覆盖）
    { action: 'plan', shape: null, customShape: { name: '马B', points: [[-0.45, -0.3], [0.45, -0.3], [0.45, 0.35], [-0.45, 0.35]] }, place: '广州塔', rotationDeg: null, reply: '画马' },
  ];
  capturedBodies = [];
  const engine = makeEngine([first]);
  const controller = createAgentController({ map, engine, placeConfig, referenceShapeSource });
  const result = await controller.send({ text: '在广州塔附近走个人形' });
  const planCalls = engine.calls.filter((c) => c.type === 'plan');
  check(
    '参考图保护：规划只跑 1 次（不重画参考图轮廓）',
    planCalls.length === 1,
    `实际 ${planCalls.length}`,
  );
  check('参考图保护：点序列图来源为参考图（未被 LLM 重画覆盖）', result.outline?.source === 'reference', JSON.stringify(result.outline?.source));
  check('参考图保护：不发起视觉质检请求（只调意图 LLM）', capturedBodies.length === 1, `实际 ${capturedBodies.length}`);
}

process.exit(failures === 0 ? 0 : 2);
