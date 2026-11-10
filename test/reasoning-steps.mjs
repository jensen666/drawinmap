/**
 * 推理过程「轮廓重生成」可见步骤测试（Node 直接运行，mock LLM + mock 引擎）。
 *
 * 背景：用户反馈「理解需求…」一步卡很久。日志（trace t-0wm8uv1s5xgd「在越秀公园画个奥迪标」）
 * 显示该步停留 64.9 秒 = 意图解析非流式调用 27.6 s + 点列拓扑校验失败后自动重生成 37.2 s；
 * 重生成期间界面上没有任何新步骤，看起来像卡死。修复后恢复路径在发起第二次模型调用前
 * 先报一条「轮廓点列校验未通过（原因），正在重新生成…」步骤。
 *
 * 运行：node test/reasoning-steps.mjs
 */

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

/** 合法轮廓（圆形 24 点，必过归一化） */
const VALID_CIRCLE = {
  name: '小狗B',
  points: Array.from({ length: 24 }, (_, i) => {
    const t = (Math.PI * 2 * i) / 24;
    return [Math.cos(t) * 0.4, Math.sin(t) * 0.4];
  }),
};
/** 非法轮廓（蝴蝶结自交，加密后仍非简单闭环） */
const INVALID_BOWTIE = {
  name: '坏狗',
  points: [
    [-0.4, -0.4], [0.4, 0.4], [0.4, -0.4], [-0.4, 0.4],
    [-0.35, -0.35], [0.35, 0.35], [0.35, -0.35], [-0.35, 0.35],
  ],
};

/** 构造一次规划结果（metrics 覆盖 composeReply 用到的字段） */
function makePlanned(tag) {
  const result = {
    shapeName: '小狗B',
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
    __tag: tag,
  };
  return {
    status: 'ok',
    result,
    best: { result, score: 75, adjustedScore: 80, sizeMeters: 1200, rotationDeg: 0, center: { lat: 23.12, lng: 113.32 } },
    offset: { meters: 0, text: '' },
    stage: 1,
    stageLabel: '近场搜索',
    triedCount: 100,
  };
}

/** LLM 返回队列 + 请求捕获（globalThis.fetch mock） */
let llmQueue = [];
globalThis.fetch = async (url, options) => {
  if (typeof url === 'string' && url.includes('/data/guangzhou-roads.json')) {
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ roads: [] }) };
  }
  const body = JSON.parse(options.body);
  // 视觉质检请求（system 含"质检员"）：返回"像"，让恢复后的自由轮廓过目标验收闸门
  if (body.messages?.[0]?.content?.includes('质检员')) {
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        id: 'mock',
        model: 'mock',
        choices: [{ message: { content: JSON.stringify({ verdict: 'like', seen: '像', issues: [] }) }, finish_reason: 'stop' }],
        usage: {},
      }),
    };
  }
  const next = llmQueue.shift() || { action: 'chat', shape: null, customShape: null, place: null, rotationDeg: null, reply: '收到' };
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({
      id: 'mock',
      model: 'mock',
      choices: [{ message: { content: JSON.stringify(next) }, finish_reason: 'stop' }],
      usage: {},
    }),
  };
};

const { createAgentController } = await import('../web/src/agent/controller.js');
const { placeConfig } = await import('./fixtures/place-config.mjs');

function makeEngine() {
  const calls = [];
  return {
    calls,
    plan: async (options) => {
      calls.push({ type: 'plan', options });
      return makePlanned('plan');
    },
    recommend: async () => null,
    commitDraw: (result, options) => calls.push({ type: 'commitDraw', result, options }),
    clearDraw: () => calls.push({ type: 'clearDraw' }),
    formatMinutes: (minutes) => `${Math.round(minutes)} 分钟`,
  };
}

const map = { getCenter: () => ({ lat: 23.12, lng: 113.32 }) };

/**
 * 跑一轮对话，收集推理过程步骤。
 *
 * @param {object} intents LLM 依次返回的意图
 * @returns {Promise<{result: object, steps: Array<{text: string, kind: string}>}>}
 */
async function runTurn(intents) {
  llmQueue = [...intents];
  const controller = createAgentController({
    map,
    engine: makeEngine(),
    placeConfig,
    shapeReviewDeps: { renderOutline: () => 'data:image/png;base64,FAKE' },
  });
  const steps = [];
  const result = await controller.send({ text: '在广州塔画个小狗', imageDataUrl: null }, (step) => steps.push(step));
  return { result, steps };
}

/** 是否是「校验未通过（原因），正在重新生成…」这类可见恢复步骤 */
function isRecoveryStep(step) {
  return typeof step?.text === 'string' && step.text.includes('校验未通过') && step.text.includes('重新生成');
}

// ---------- 场景 1：点列非法 → 恢复前必须出现可见步骤 ----------
{
  const { steps } = await runTurn([
    { action: 'plan', shape: null, customShape: INVALID_BOWTIE, place: '广州塔', rotationDeg: null, reply: '画小狗' },
    { name: '小狗B', features: [{ name: '尖耳', points: [[0, 0.3]] }], points: VALID_CIRCLE.points },
  ]);
  const understandIndex = steps.findIndex((step) => step.text?.includes('理解需求'));
  const recoveryIndex = steps.findIndex(isRecoveryStep);
  check('恢复路径：出现「校验未通过，正在重新生成」步骤', recoveryIndex >= 0, JSON.stringify(steps.map((step) => step.text)));
  check('恢复路径：步骤排在「理解需求」之后', understandIndex >= 0 && recoveryIndex > understandIndex, `理解需求=${understandIndex} 重生成=${recoveryIndex}`);
  check('恢复路径：步骤带首轮拒收原因', steps[recoveryIndex]?.text.includes('拓扑不合法'), steps[recoveryIndex]?.text ?? '');
  check('恢复路径：步骤类型是 step（逐行显示，不是进度原地更新）', steps[recoveryIndex]?.kind === 'step', steps[recoveryIndex]?.kind);
  check('恢复路径：只报一次（不重复刷步骤）', steps.filter(isRecoveryStep).length === 1, `实际 ${steps.filter(isRecoveryStep).length}`);
}

// ---------- 场景 2：轮廓合法 → 不出现恢复步骤 ----------
{
  const { steps } = await runTurn([
    { action: 'plan', shape: null, customShape: VALID_CIRCLE, place: '广州塔', rotationDeg: null, reply: '画小狗' },
  ]);
  check('合法轮廓：不出现恢复步骤', !steps.some(isRecoveryStep), JSON.stringify(steps.map((step) => step.text)));
  check('合法轮廓：正常走到「理解需求」后的需求步骤', steps.some((step) => step.text?.includes('需求：画自定义')), JSON.stringify(steps.map((step) => step.text)));
}

console.log(`\n[summary] ${checks - failures}/${checks} 项通过，失败 ${failures} 项`);
if (failures > 0) {
  process.exitCode = 1;
}
