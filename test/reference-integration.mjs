/**
 * 参考图模块接入主流程的集成测试（Node，mock LLM + mock 引擎 + 注入参考图源）。
 *
 * 验证：
 * 1. plan 文本命中参考图 → 引擎拿到参考图的 customShape；
 * 2. 参考图源抛错 → 回退 LLM customShape；
 * 3. 未命中/无参考图源 → 保持原 LLM 链路；
 * 4. 参考图命中后质量追击被禁止（方案 5.6 轮廓保护）→ 不再调 LLM 重画覆盖，
 *    点序列图保持参考图来源。
 *
 * 运行：node test/reference-integration.mjs
 */

import { createAgentController } from '../web/src/agent/controller.js';
import { normalizeCustomShape } from '../web/src/agent/intent.js';

/** 自包含地点配置：避免依赖用户未提交的 place-config fixture（保证测试在无配置环境下也能跑） */
const placeConfig = {
  version: 1,
  activeCityId: 'test-city',
  matching: {
    coverageMarginDeg: 0.01,
    poiContainmentMinQueryLength: 3,
    roadContainmentMinQueryLength: 3,
    roadContainmentMinSegments: 1,
    unresolvedPlace: 'ask',
  },
  activeCity: {
    id: 'test-city',
    label: '测试城',
    names: ['测试城'],
    title: '测试城',
    subtitle: '',
    mapAriaLabel: '地图',
    view: { center: { lat: 23.12, lng: 113.32 }, zoom: 12 },
    coverage: { description: '测试范围', hint: '换地点', bbox: { minLat: 22.9, maxLat: 23.4, minLng: 113.0, maxLng: 113.6 } },
    examples: ['画个五角星'],
    roads: { dataUrl: '/data/guangzhou-roads.json' },
    pois: [{ name: '广州塔', lat: 23.1066, lng: 113.3246 }],
    districts: [],
    aliases: [],
  },
};

let failures = 0;
function check(label, condition, detail = '') {
  if (!condition) failures += 1;
  console.log(`[check] ${label} -> ${condition ? 'PASS' : `FAIL ${detail}`}`);
}

const LLM_SQUARE = { name: 'LLM马', points: [[-0.4, -0.4], [0.4, -0.4], [0.4, 0.4], [-0.4, 0.4]] };

function makePlanned({ score = 85, adjustedScore = 85 } = {}) {
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
    },
  };
  return {
    status: 'ok',
    result,
    best: { result, score, adjustedScore, sizeMeters: 1200, rotationDeg: 0, center: { lat: 23.12, lng: 113.32 } },
    offset: { meters: 0, text: '' },
    stage: 1,
    stageLabel: '近场搜索',
    triedCount: 100,
  };
}

const map = { getCenter: () => ({ lat: 23.12, lng: 113.32 }) };
let intentQueue = [];
globalThis.fetch = async (url, options) => {
  if (typeof url === 'string' && url.includes('/data/guangzhou-roads.json')) {
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ roads: [] }) };
  }
  const intent = intentQueue.shift() || { action: 'chat', customShape: null, place: null, reply: '收到' };
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ id: 'mock', model: 'mock', choices: [{ message: { content: JSON.stringify(intent) }, finish_reason: 'stop' }], usage: {} }),
  };
};

function makeEngine(planResults = []) {
  const calls = [];
  return {
    calls,
    plan: async (options) => {
      calls.push({ type: 'plan', options });
      return planResults.length > 0 ? planResults.shift() : makePlanned();
    },
    recommend: async () => makePlanned(),
    commitDraw: (result, options) => calls.push({ type: 'commitDraw', result, options }),
    clearDraw: () => calls.push({ type: 'clearDraw' }),
    formatMinutes: (minutes) => `${Math.round(minutes)} 分钟`,
  };
}

const referenceCustomShape = normalizeCustomShape({
  name: '参考马',
  points: [[-0.45, -0.3], [0.4, -0.3], [0.45, 0.3], [-0.4, 0.35], [-0.1, 0.1]],
});

async function runTurn({ referenceShapeSource, intents = [], planResults = [] }) {
  intentQueue = [...intents];
  const engine = makeEngine(planResults);
  const controller = createAgentController({ map, engine, placeConfig, referenceShapeSource });
  const result = await controller.send({ text: '在广州画一匹马' });
  return { engine, result };
}

// ---------- 场景 1：参考图命中 → 引擎使用参考图 customShape ----------
{
  const calls = [];
  const source = async (text) => {
    calls.push(text);
    return {
      customShape: referenceCustomShape,
      asset: {
        id: 'horse-phylopic',
        names: { zh: ['马'] },
        source: { license: 'CC0-1.0' },
        sha256: 'a'.repeat(64),
        review: { status: 'approved', visual: 'like', reviewedAt: '2026-11-01', sha256: 'a'.repeat(64) },
      },
      matchedAlias: '马',
      conversion: { T: { pointCount: referenceCustomShape.outlinePoints.length } },
    };
  };
  const { engine, result } = await runTurn({
    referenceShapeSource: source,
    intents: [{ action: 'plan', shape: null, customShape: LLM_SQUARE, place: '广州塔', rotationDeg: null, reply: '画马' }],
  });
  const planCall = engine.calls.find((call) => call.type === 'plan');
  check('接入：参考图源被调用', calls.length === 1 && calls[0].includes('马'));
  check('接入：引擎拿到参考图轮廓', planCall?.options?.customShape?.name === '参考马' && planCall.options.customShape.outlinePoints.length > 0);
  check('接入：规划成功返回', typeof result.reply === 'string' && result.reply.includes('已规划'));
  check(
    '接入：回复附带点序列图（来源=参考图，点数与 T 一致）',
    result.outline &&
      result.outline.source === 'reference' &&
      result.outline.name === '参考马' &&
      result.outline.pointCount === referenceCustomShape.outlinePoints.length &&
      result.outline.dataUrl === null,
    JSON.stringify(result.outline),
  );
}

// ---------- 场景 2：参考图源失败 → 回退 LLM customShape ----------
{
  const { engine } = await runTurn({
    referenceShapeSource: async () => {
      throw new Error('manifest 404');
    },
    intents: [{ action: 'plan', shape: null, customShape: LLM_SQUARE, place: '广州塔', rotationDeg: null, reply: '画马' }],
  });
  const planCall = engine.calls.find((call) => call.type === 'plan');
  check('回退：参考图失败后仍用 LLM 轮廓', planCall?.options?.customShape?.name === 'LLM马');
}

// ---------- 场景 3：参考图未命中 → 保持 LLM 轮廓 ----------
{
  const { engine, result } = await runTurn({
    referenceShapeSource: async () => null,
    intents: [{ action: 'plan', shape: null, customShape: LLM_SQUARE, place: '广州塔', rotationDeg: null, reply: '画马' }],
  });
  const planCall = engine.calls.find((call) => call.type === 'plan');
  check('未命中：保持 LLM 轮廓', planCall?.options?.customShape?.name === 'LLM马');
  check('未命中：点序列图来源=LLM', result.outline?.source === 'llm' && result.outline.name === 'LLM马', JSON.stringify(result.outline));
}

// ---------- 场景 4：参考图命中后质量追击被禁止（方案 5.6 轮廓保护） ----------
// 旧行为（参考图 65 分触发 LLM 盲画覆盖轮廓）已被方案明令禁止：参考图是审核过
// 的素材，追击重画等于用更差的生成覆盖更好的轮廓。改为断言：不触发第二次规划、
// 提交第一版、点序列图保持参考图来源。
{
  const firstPlan = makePlanned({ score: 65, adjustedScore: 60 });
  const secondPlan = makePlanned({ score: 80, adjustedScore: 75 });
  const { engine, result } = await runTurn({
    referenceShapeSource: async () => ({
      customShape: referenceCustomShape,
      asset: {
        id: 'horse-phylopic',
        names: { zh: ['马'] },
        source: { license: 'CC0-1.0' },
        sha256: 'a'.repeat(64),
        review: { status: 'approved', visual: 'like', reviewedAt: '2026-11-01', sha256: 'a'.repeat(64) },
      },
      matchedAlias: '马',
      conversion: { T: { pointCount: referenceCustomShape.outlinePoints.length } },
    }),
    intents: [
      { action: 'plan', shape: null, customShape: LLM_SQUARE, place: '广州塔', rotationDeg: null, reply: '画马' },
      { action: 'plan', shape: null, customShape: { name: 'LLM猫', points: [[-0.4, -0.4], [0.4, -0.4], [0, 0.4]] }, place: '广州塔', rotationDeg: null, reply: '重画' },
    ],
    planResults: [firstPlan, secondPlan],
  });
  const planCalls = engine.calls.filter((call) => call.type === 'plan');
  check(
    '参考图保护：第一版 65 分（<70）不触发质量追击（规划只跑 1 次）',
    planCalls.length === 1,
    `plan=${planCalls.length}`,
  );
  check(
    '参考图保护：提交的是第一版（参考图轮廓）',
    engine.calls.find((call) => call.type === 'commitDraw')?.result === firstPlan.result,
  );
  check(
    '参考图保护：点序列图来源保持 reference（未被 LLM 重画覆盖）',
    result.outline?.source === 'reference' && result.outline.name === referenceCustomShape.name,
    JSON.stringify(result.outline),
  );
}

if (failures > 0) {
  console.error(`\nFAILED: ${failures} 项未通过`);
  process.exitCode = 1;
} else {
  console.log('\nPASS: reference-integration 全部断言通过');
}
