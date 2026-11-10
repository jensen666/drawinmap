/**
 * 目标验收硬闸门与重试隔离测试（Node 直接运行，mock LLM + mock 引擎）。
 *
 * 覆盖（方案 §8.5/§9/§11.1）：
 * - 生成分派：shapeSpec → 参数化 T（procedural）；customShape → 自由 T（freeform）；
 *   参考图命中覆盖 spec/点列（参考图优先尊重参考内容）
 * - 语义闸门：S/拓扑非法 → 完全不调用路网引擎（含诊断规划）
 * - 诊断参考隔离：目标未通过 → 只做一次诊断性参考规划，结果固定为标注
 *   "目标未通过"的非合格参考版；路线分再高也不转绿、不改写目标结论
 * - 修正版复检：unlike → 修正 → 复检 like 才可正式规划；复检不像/不可用时
 *   不得正式交付
 * - 重试隔离：路线贴合低（含 <70）不重画 T；不存在按路线分跨目标替换
 * - 双评分：绿线回复文案明确"路线贴合"；不合格 T 的高路线分不能交付绿线
 * - 目标版本与验收留痕（trace 事件 target.accepted / target.replaced）
 * - 参数化规格恢复：生成失败带原因重试；恢复失败 → planBlocked 诚实失败
 * - planBlocked 原因优先（审查 M2）：三路阶段无候选时，具体失败原因不得被
 *   固定句「没有可用轮廓。」顶掉
 *
 * 运行：node test/target-gate.mjs
 */

import { createAgentController } from '../web/src/agent/controller.js';
import { normalizeCustomShape } from '../web/src/agent/intent.js';
import { placeConfig } from './fixtures/place-config.mjs';
import { clearLogs, getEntries, initLogging } from '../web/src/log/index.js';

initLogging({ server: false, storage: false, level: 'debug' });

let failures = 0;
let checks = 0;

function check(label, condition, detail = '') {
  checks += 1;
  const ok = Boolean(condition);
  if (!ok) {
    failures += 1;
  }
  console.log(`[check] ${label} -> ${ok ? 'PASS' : `FAIL ${detail}`}`);
}

// ---------- LLM mock：意图 / 修正 / 规格恢复 / 质检 四类请求分别供给 ----------
let intentQueue = [];
let reviseQueue = [];
let reviewQueue = [];
let capturedBodies = [];

function llmResponse(content) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({
      id: 'mock',
      model: 'mock',
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: {},
    }),
  };
}

globalThis.fetch = async (url, options) => {
  if (typeof url === 'string' && url.includes('/data/guangzhou-roads.json')) {
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ roads: [] }) };
  }
  capturedBodies.push(JSON.parse(options.body));
  const system = capturedBodies[capturedBodies.length - 1].messages?.[0]?.content || '';
  let payload;
  if (system.includes('质检员')) {
    payload = reviewQueue.shift() || { verdict: 'like', seen: 'ok', issues: [] };
  } else if (system.includes('规格修正器') || system.includes('按轮廓顺序采样')) {
    // 规格恢复 / 点列修正请求
    payload = reviseQueue.shift() || { action: 'chat', reply: '收到' };
  } else {
    payload = intentQueue.shift() || { action: 'chat', reply: '收到' };
  }
  return llmResponse(JSON.stringify(payload));
};

function makeResult(tag, shapeName = '六角星') {
  return {
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
}

function makePlanned(score, tag, shapeName = '六角星') {
  const result = makeResult(tag, shapeName);
  return {
    status: 'ok',
    result,
    best: { result, score, adjustedScore: score, sizeMeters: 1200, rotationDeg: 0, center: { lat: 23.12, lng: 113.32 } },
    offset: { meters: 0, text: '' },
    stage: 1,
    stageLabel: '近场搜索',
    triedCount: 100,
  };
}

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
      throw new Error('unused');
    },
    commitDraw: (result, options) => calls.push({ type: 'commitDraw', result, options }),
    clearDraw: () => calls.push({ type: 'clearDraw' }),
    formatMinutes: (minutes) => `${Math.round(minutes)} 分钟`,
  };
}

const map = { getCenter: () => ({ lat: 23.12, lng: 113.32 }) };
const fakeRender = () => 'data:image/png;base64,FAKE';

async function runTurn({ text, intents = [], revisions = [], reviews = [], planQueue = [], renderOutline = fakeRender, referenceSource = null } = {}) {
  intentQueue = [...intents];
  reviseQueue = [...revisions];
  reviewQueue = [...reviews];
  capturedBodies = [];
  clearLogs();
  const engine = makeEngine(planQueue);
  // referenceSource：注入三路参考源（支持本地/在线独立入口）时 executeIntent 走
  // 三路阶段；不注入时保持旧串行链路（既有场景口径不变）
  const controller = createAgentController({ map, engine, placeConfig, referenceSource, shapeReviewDeps: { renderOutline } });
  const result = await controller.send({ text });
  return { result, calls: engine.calls };
}

function eventsOf(name) {
  return getEntries({ limit: 0 }).filter((record) => record.event === name);
}

const HEXA_INTENT = {
  action: 'plan',
  shape: null,
  shapeSpec: { family: 'star', pointCount: 6, outerRadii: 0.5, innerRadii: 0.2887 },
  customShape: null,
  place: '越秀公园',
  rotationDeg: null,
  reply: '画六角星',
};
const HORSE_INTENT = {
  action: 'plan',
  shape: null,
  shapeSpec: null,
  customShape: { name: '马', points: [[-0.4, -0.4], [0.4, -0.4], [0.4, 0.4], [-0.4, 0.4]] },
  place: '越秀公园',
  rotationDeg: null,
  reply: '画马',
};

// ---------- 场景 1：六角星 shapeSpec → 参数化 T → 正式规划（绿线 = 双验收通过） ----------
{
  const { result, calls } = await runTurn({
    text: '在越秀公园画个六角星',
    intents: [HEXA_INTENT],
    planQueue: [makePlanned(75, 'v1')],
  });
  const plans = calls.filter((c) => c.type === 'plan');
  check('S1：规划一次（无质量追击重画）', plans.length === 1, `plans=${plans.length}`);
  check('S1：引擎收到参数化 T（带 spec 元数据）', plans[0]?.options?.customShape?.source === 'procedural' && Boolean(plans[0]?.options?.customShape?.spec));
  check('S1：绿线提交一次', calls.filter((c) => c.type === 'commitDraw' && !c.options?.reference).length === 1);
  check('S1：回复含路线贴合', result.reply.includes('路线贴合 75'), result.reply.slice(0, 80));
  check('S1：点序列图来源 procedural', result.outline?.source === 'procedural');
  check('S1：target.accepted 记录验收通过', eventsOf('target.accepted').some((record) => record.data?.source === 'procedural' && record.data?.verdict === 'pass'), JSON.stringify(eventsOf('target.accepted').map((r) => r.data?.source)));
  check('S1：plan.request 记录规划用途 formal', eventsOf('plan.request').some((record) => record.data?.purpose === 'formal'));
}

// ---------- 场景 2：三长三短变体 → 参数摘要出现在回复 ----------
{
  const { result } = await runTurn({
    text: '在越秀公园画个三长三短的六角星',
    intents: [{
      ...HEXA_INTENT,
      shapeSpec: {
        family: 'star',
        variant: 'alternating-outer-radius',
        pointCount: 6,
        outerRadii: [0.5, 0.32, 0.5, 0.32, 0.5, 0.32],
        innerRadii: 0.25,
      },
    }],
    planQueue: [makePlanned(72, 'alt')],
  });
  check('S2：回复含三长三短规格摘要', result.reply.includes('三长三短'), result.reply.slice(0, 120));
  check('S2：绿线交付', result.reply.includes('已规划'));
}

// ---------- 场景 3：自由轮廓 unlike → 诊断参考隔离（路线高分不转绿） ----------
{
  const { result, calls } = await runTurn({
    text: '在越秀公园画个马',
    intents: [HORSE_INTENT],
    reviews: [
      { verdict: 'unlike', seen: '方波腿', issues: ['四条腿呈方波'] },
      { verdict: 'unlike', seen: '仍不像', issues: ['仍机械'] },
    ],
    planQueue: [makePlanned(95, 'diag', '马')],
  });
  const plans = calls.filter((c) => c.type === 'plan');
  check('S3：只做一次诊断性参考规划', plans.length === 1, `plans=${plans.length}`);
  check('S3：橙色参考版（非合格）', calls.filter((c) => c.type === 'commitDraw' && c.options?.reference).length === 1);
  check('S3：回复区分目标未通过', result.reply.includes('目标验收没有通过'));
  check('S3：回复标注诊断参考非合格', result.reply.includes('诊断性参考') && result.reply.includes('非合格'));
  check('S3：高分路线没有转成绿线', !result.reply.includes('已规划'));
  check('S3：诊断规划带用途标记（plan.request purpose=diagnostic）', eventsOf('plan.request').some((record) => record.data?.purpose === 'diagnostic'));
  check('S3：deliver.diagnosticReference 留痕', eventsOf('deliver.diagnosticReference').length === 1);
  check('S3：target.rejected 记录验收失败', eventsOf('target.rejected').some((record) => record.data?.source === 'freeform' && record.data?.verdict === 'fail'));
}

// ---------- 场景 4：修正版复检通过 → 正式规划（v2） ----------
{
  const { result, calls } = await runTurn({
    text: '在越秀公园画个马',
    intents: [HORSE_INTENT],
    revisions: [{ name: '马v2', features: [], points: [[-0.45, -0.35], [0.45, -0.35], [0.45, 0.35], [-0.45, 0.35]] }],
    reviews: [
      { verdict: 'unlike', seen: '方波腿', issues: ['四条腿呈方波'] },
      // 复检（第三轮 LLM）：like
      { verdict: 'like', seen: '像马', issues: [] },
    ],
    planQueue: [makePlanned(80, 'v2', '马v2')],
  });
  const planCalls = calls.filter((c) => c.type === 'plan');
  check('S4：复检通过后正式规划一次', planCalls.length === 1);
  // 评审 🔴1：规划必须用复检通过的 v2，而不是 intent 里的 v1（验收/预览/规划同一版 T）
  check('S4：规划用的是复检通过的修正版 v2', planCalls[0]?.options?.customShape?.name === '马v2', `实际 ${planCalls[0]?.options?.customShape?.name}`);
  check('S4：绿线交付', calls.filter((c) => c.type === 'commitDraw' && !c.options?.reference).length === 1);
  check('S4：回复交付修正版图形', result.reply.includes('马v2'), result.reply.slice(0, 100));
  check('S4：target.replaced 记录 v1→v2 与两版结论', eventsOf('target.replaced').some((record) => record.data?.fromVersion === 1 && record.data?.toVersion === 2));
  check('S4：target.accepted 记录 v2', eventsOf('target.accepted').some((record) => record.data?.targetVersion === 2));
}

// ---------- 场景 5：修正版复检 unlike → 不得正式交付 ----------
{
  const { result, calls } = await runTurn({
    text: '在越秀公园画个马',
    intents: [HORSE_INTENT],
    revisions: [{ name: '马v2', features: [], points: [[-0.45, -0.35], [0.45, -0.35], [0.45, 0.35], [-0.45, 0.35]] }],
    reviews: [
      { verdict: 'unlike', issues: ['不像'] },
      { verdict: 'unlike', issues: ['复检仍不像'] },
    ],
    planQueue: [makePlanned(90, 'diag', '马v2')],
  });
  check('S5：不绿线交付', !result.reply.includes('已规划'));
  check('S5：复检不像 → 诊断参考', result.reply.includes('诊断性参考') && result.reply.includes('非合格'));
  check('S5：诊断参考用修正版 T（当前最好尝试）', result.outline?.name === '马v2', JSON.stringify(result.outline));
}

// ---------- 场景 6：S 非法（曲边）且恢复失败 → 完全不规划 ----------
{
  const { result, calls } = await runTurn({
    text: '在越秀公园画个曲边六角星',
    intents: [{
      ...HEXA_INTENT,
      shapeSpec: { family: 'star', pointCount: 6, outerRadii: 0.5, innerRadii: 0.2887, curvature: 0.4 },
    }],
    // 恢复请求：返回仍非法的规格（缺 innerRadii）
    revisions: [{ shapeSpec: { family: 'star', pointCount: 6, outerRadii: 0.5 } }],
    planQueue: [makePlanned(90, 'x')],
  });
  check('S6：完全不调用路网引擎（含诊断）', calls.filter((c) => c.type === 'plan').length === 0, `calls=${calls.map((c) => c.type).join(',')}`);
  check('S6：清空图层', calls.filter((c) => c.type === 'clearDraw').length === 1);
  check('S6：诚实失败说明参数问题', result.reply.includes('没能生成出来') && !result.reply.includes('已规划'), result.reply.slice(0, 120));
}

// ---------- 场景 7：S 生成失败恢复 → 修正参数后重新参数化成功 ----------
{
  const { result, calls } = await runTurn({
    text: '在越秀公园画个六角星',
    intents: [{
      ...HEXA_INTENT,
      // 首轮生成失败：内凹 ≥ 外尖
      shapeSpec: { family: 'star', pointCount: 6, outerRadii: 0.5, innerRadii: 0.6 },
    }],
    // 恢复请求：修正后的合法规格
    revisions: [{ shapeSpec: { family: 'star', pointCount: 6, outerRadii: 0.5, innerRadii: 0.2887 } }],
    planQueue: [makePlanned(70, 'fixed')],
  });
  check('S7：恢复成功后正式规划一次', calls.filter((c) => c.type === 'plan').length === 1);
  check('S7：绿线交付', calls.filter((c) => c.type === 'commitDraw' && !c.options?.reference).length === 1);
  check('S7：恢复留痕', result.reply.includes('已规划'));
}

// ---------- 场景 8：用户显式约束具有否决权（freeform + 约束 fail） ----------
{
  const { result, calls } = await runTurn({
    text: '在越秀公园画把吉他，必须有琴颈',
    intents: [{ ...HORSE_INTENT, customShape: { name: '吉他', points: [[-0.4, -0.4], [0.4, -0.4], [0.4, 0.4], [-0.4, 0.4]] }, userConstraints: ['必须有琴颈'] }],
    reviews: [
      { verdict: 'like', seen: '像吉他', constraints: [{ text: '必须有琴颈', result: 'fail' }] },
      { verdict: 'unlike', issues: ['缺琴颈'] },
    ],
    planQueue: [makePlanned(90, 'diag', '吉他')],
  });
  check('S8：约束 fail → 不绿线', !result.reply.includes('已规划'));
  check('S8：进入诊断参考（目标未通过）', result.reply.includes('目标验收没有通过'));
  check('S8：质检请求带约束清单', capturedBodies.some((body) => body.messages?.[0]?.content?.includes('必须有琴颈') && body.messages[0].content.includes('质检员')));
}

// ---------- 场景 9：用户未给约束时不误杀（无 constraints 字段也通过） ----------
{
  const { result, calls } = await runTurn({
    text: '在越秀公园画个马',
    intents: [HORSE_INTENT],
    reviews: [{ verdict: 'like', seen: '像马', issues: [] }],
    planQueue: [makePlanned(75, 'ok', '马')],
  });
  check('S9：无用户约束 + like → 正式规划', calls.filter((c) => c.type === 'plan').length === 1);
  check('S9：绿线交付', calls.filter((c) => c.type === 'commitDraw' && !c.options?.reference).length === 1);
}

// ---------- 场景 10：路线贴合低分（含 <70）全程固定 T ----------
{
  const { result, calls } = await runTurn({
    text: '在越秀公园画个马',
    intents: [HORSE_INTENT],
    reviews: [{ verdict: 'like', seen: '像马', issues: [] }],
    planQueue: [makePlanned(55, 'low', '马')],
  });
  check('S10：T 合格 → 只做一次正式规划（不重画 T）', calls.filter((c) => c.type === 'plan').length === 1);
  check('S10：低于交付线 → 参考版（目标通过、路线未通过）', calls.filter((c) => c.type === 'commitDraw' && c.options?.reference).length === 1);
  check('S10：回复说明路线未达标', result.reply.includes('非合格'));
  check('S10：无第二次意图/重画 LLM 调用', capturedBodies.filter((body) => !body.messages?.[0]?.content?.includes('质检员')).length === 1);
}

// ---------- 场景 11：planBlocked 与三路无候选同时发生 → 具体失败原因优先（审查 M2） ----------
{
  // LLM 两轮点列都不合法：首轮自交 → 带原因恢复 → 重生成仍自交 → intent.planBlocked
  const invalidPoints = [[-0.4, -0.4], [0.4, 0.4], [0.4, -0.4], [-0.4, 0.4]];
  const invalidIntent = {
    action: 'plan',
    shape: null,
    shapeSpec: null,
    customShape: { name: '马', points: invalidPoints },
    place: '越秀公园',
    rotationDeg: null,
    reply: '画马',
  };
  const { result, calls } = await runTurn({
    text: '在越秀公园画一只马',
    intents: [invalidIntent],
    revisions: [{ points: invalidPoints }],
    // 注入三路参考源（本地/在线都 miss）：executeIntent 会先跑三路阶段且无候选，
    // 此时 planBlocked 的具体原因不得被固定句「没有可用轮廓。」顶掉
    referenceSource: {
      async resolveLocalCandidates() {
        return { status: 'miss', origin: 'local', candidates: [], failures: [], poolSize: 0, attempts: [] };
      },
      async resolveOnlineCandidates() {
        return { status: 'miss', origin: 'online', candidates: [], failures: [], poolSize: 0, attempts: [] };
      },
    },
  });
  check('S11：planBlocked + 三路无候选 → 不调用路网引擎（含诊断）', calls.filter((c) => c.type === 'plan').length === 0, `calls=${calls.map((c) => c.type).join(',')}`);
  check('S11：回复含具体失败原因（没能生成出来 + 两轮生成）', result.reply.includes('没能生成出来') && result.reply.includes('两轮生成'), result.reply.slice(0, 160));
  check('S11：回复不再被固定句「没有可用轮廓。」顶掉', !result.reply.includes('没有可用轮廓'), result.reply.slice(0, 160));
  check('S11：清空图层一次', calls.filter((c) => c.type === 'clearDraw').length === 1, String(calls.filter((c) => c.type === 'clearDraw').length));
  check('S11：planBlocked 优先级留痕', eventsOf('agent.threeSources.noContour.planBlocked').length === 1, JSON.stringify(eventsOf('agent.threeSources.noContour.planBlocked').map((record) => record.data)));
}

console.log(`\n[summary] ${checks - failures}/${checks} 项通过，失败 ${failures} 项`);
if (failures > 0) {
  process.exitCode = 1;
}
