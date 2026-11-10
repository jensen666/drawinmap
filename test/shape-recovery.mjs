/**
 * 自定义图形校验失败恢复测试（Node 直接运行，mock LLM + mock 引擎）。
 *
 * 背景：LLM 生成的点列可能自交/退化（实测采样 5 个剪影 2 个被拒），旧链路
 * 静默丢弃点列并把 plan 翻成 recommend——用户要的图形被无声换成内置推荐。
 * 修复后：校验失败带具体原因重生成一次，成功恢复 plan 通道；仍失败/恢复调用
 * 失败才走原 recommend 兜底（话术不变）。
 *
 * 运行：node test/shape-recovery.mjs
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
function makePlanned({ score, adjustedScore, tag }) {
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
    best: {
      result,
      score,
      adjustedScore,
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

function makeRecommendOutcome(tag) {
  const drawn = {
    shapeName: '心形',
    score: 75,
    adjustedScore: 75,
    sizeMeters: 1200,
    rotationDeg: 0,
    center: { lat: 23.12, lng: 113.32 },
    result: makePlanned({ score: 75, adjustedScore: 75, tag }).result,
  };
  return {
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
}

/** LLM 返回队列 + 请求捕获（globalThis.fetch mock） */
let llmQueue = [];
let capturedBodies = [];
let llmCallCount = 0;
let failAllSubsequent = false;

globalThis.fetch = async (url, options) => {
  if (typeof url === 'string' && url.includes('/data/guangzhou-roads.json')) {
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ roads: [] }),
    };
  }
  llmCallCount += 1;
  if (failAllSubsequent && capturedBodies.length >= 1) {
    throw new Error('接口不可达');
  }
  capturedBodies.push(JSON.parse(options.body));
  // 视觉质检请求（system 含"质检员"）：返回"像"，让恢复后的自由轮廓过目标验收闸门
  if (capturedBodies[capturedBodies.length - 1].messages?.[0]?.content?.includes('质检员')) {
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
  const next = llmQueue.shift() || {
    action: 'chat',
    shape: null,
    customShape: null,
    place: null,
    rotationDeg: null,
    reply: '收到',
  };
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

async function runTurn({ text = '在广州画个小狗', planQueue = [], recommendQueue = [], intents = [], failAfterFirst = false } = {}) {
  llmQueue = [...intents];
  capturedBodies = [];
  llmCallCount = 0;
  failAllSubsequent = failAfterFirst;
  const engine = makeEngine(planQueue, recommendQueue);
  // 注入 fake 渲染器：恢复后的自由轮廓能走完视觉质检（verdict 由 fetch mock 固定返回 like）
  const controller = createAgentController({ map, engine, placeConfig, shapeReviewDeps: { renderOutline: () => 'data:image/png;base64,FAKE' } });
  const result = await controller.send({ text, imageDataUrl: null });
  return { result, calls: engine.calls, bodies: capturedBodies, llmCalls: llmCallCount };
}

// ---------- 场景 1：校验失败 → 带原因重生成成功 → 恢复 plan ----------
{
  const planned = makePlanned({ score: 75, adjustedScore: 80, tag: 'A' });
  const { result, calls, bodies } = await runTurn({
    planQueue: [planned],
    intents: [
      { action: 'plan', shape: null, customShape: INVALID_BOWTIE, place: '广州塔', rotationDeg: null, reply: '画小狗' },
      { name: '小狗B', features: [{ name: '尖耳', points: [[0, 0.3]] }], points: VALID_CIRCLE.points },
    ],
  });
  const plans = calls.filter((c) => c.type === 'plan');
  const commits = calls.filter((c) => c.type === 'commitDraw');
  check('恢复成功：LLM 调用 3 次（意图+重生成+质检）', bodies.length === 3, `实际 ${bodies.length}`);
  check('恢复成功：重生成请求带失败原因', bodies[1]?.messages?.[1]?.content.includes('拓扑不合法'));
  check('恢复成功：按 plan 通道规划', plans.length === 1, `plan ${plans.length}`);
  check('恢复成功：规划用的是修正版图形', plans[0]?.options?.customShape?.name === '小狗B');
  // 尺寸基准回归（trace t-0wg0g71b5eu0）：normalizeIntent 在"点列非法被翻成 recommend"时
  // 不填 sizeMeters，恢复成功翻回 plan 后若直接进引擎，引擎会按 null 算出全部 0 尺寸候选，
  // 四级 1960 个候选全废、地图画不出来。恢复路径必须带着正数尺寸基准进规划。
  check(
    '恢复成功：规划带正数尺寸基准（不是 null）',
    Number.isFinite(plans[0]?.options?.sizeMeters) && plans[0].options.sizeMeters > 0,
    String(plans[0]?.options?.sizeMeters),
  );
  check('恢复成功：提交绘制一次', commits.length === 1);
  check('恢复成功：回复是规划交付而非推荐兜底', result.reply.includes('已规划') && !result.reply.includes('没能生成'));
}

// ---------- 场景 2：重生成仍非法 → 诚实失败（不转实测推荐，2026-10-31 用户裁定） ----------
{
  const { result, calls, bodies } = await runTurn({
    recommendQueue: [makeRecommendOutcome('B')],
    intents: [
      { action: 'plan', shape: null, customShape: INVALID_BOWTIE, place: '广州塔', rotationDeg: null, reply: '好嘞，马上画小狗轮廓～' },
      INVALID_BOWTIE,
    ],
  });
  const recommends = calls.filter((c) => c.type === 'recommend');
  const commits = calls.filter((c) => c.type === 'commitDraw');
  check('恢复后仍非法：LLM 调用 2 次', bodies.length === 2, `实际 ${bodies.length}`);
  check('恢复后仍非法：不调用实测推荐（生成失败就是失败）', recommends.length === 0, `recommend ${recommends.length}`);
  check('恢复后仍非法：不绘制任何替代图形', commits.length === 0, `commit ${commits.length}`);
  check('恢复后仍非法：清空图层（不画）', calls.filter((c) => c.type === 'clearDraw').length === 1);
  check('恢复后仍非法：回复诚实说明失败', result.reply.includes('没能生成出来') && result.reply.includes('两轮生成'), result.reply.slice(0, 100));
  check('恢复后仍非法：回复带首轮拒收原因', result.reply.includes('拓扑不合法'), result.reply.slice(0, 120));
  // LLM 的开场白在生成失败前就已产生，与失败事实矛盾——失败回复不用它
  check('恢复后仍非法：不使用 LLM 的乐观开场白', !result.reply.includes('好嘞，马上画小狗'));
  check('恢复后仍非法：给出可选实测推荐入口（不替用户执行）', result.reply.includes('实测推荐'));
}

// ---------- 场景 3：合法轮廓 → 不触发恢复 ----------
{
  const planned = makePlanned({ score: 75, adjustedScore: 80, tag: 'C' });
  const { calls, bodies } = await runTurn({
    planQueue: [planned],
    intents: [
      { action: 'plan', shape: null, customShape: VALID_CIRCLE, place: '广州塔', rotationDeg: null, reply: '画小狗' },
    ],
  });
  const plans = calls.filter((c) => c.type === 'plan');
  check('合法轮廓：只有 2 次 LLM 调用（意图+质检）', bodies.length === 2, `实际 ${bodies.length}`);
  check('合法轮廓：按原图形规划', plans[0]?.options?.customShape?.name === '小狗B');
}

// ---------- 场景 4：恢复调用失败（网络错误）→ 诚实失败，不崩、不转推荐 ----------
{
  const { result, calls, bodies, llmCalls } = await runTurn({
    failAfterFirst: true,
    recommendQueue: [makeRecommendOutcome('D')],
    intents: [
      { action: 'plan', shape: null, customShape: INVALID_BOWTIE, place: '广州塔', rotationDeg: null, reply: '画小狗' },
    ],
  });
  const recommends = calls.filter((c) => c.type === 'recommend');
  check('恢复调用失败：重试 3 次后放弃', llmCalls === 4, `实际 ${llmCalls}`);
  check('恢复调用失败：不转实测推荐', recommends.length === 0, `recommend ${recommends.length}`);
  check('恢复调用失败：回复诚实失败且不抛错', result.reply.includes('没能生成出来') && result.reply.includes('重生成请求失败'), result.reply.slice(0, 120));
}

// ---------- 场景 4b：LLM 标了 plan 却没给出任何图形 → 诚实失败（不转实测推荐） ----------
{
  const { result, calls } = await runTurn({
    recommendQueue: [makeRecommendOutcome('E')],
    intents: [
      { action: 'plan', shape: null, customShape: null, place: '广州塔', rotationDeg: null, reply: '画小狗' },
    ],
  });
  const recommends = calls.filter((c) => c.type === 'recommend');
  check('无图形意图：不调用实测推荐', recommends.length === 0, `recommend ${recommends.length}`);
  check('无图形意图：不绘制', calls.filter((c) => c.type === 'commitDraw').length === 0);
  check('无图形意图：诚实失败说明', result.reply.includes('没能生成出来') && result.reply.includes('没有返回可绘制的轮廓'), result.reply.slice(0, 120));
}

// ---------- 场景 4c：用户真没点名图形（recommend 意图）→ 实测推荐照常（不受影响） ----------
{
  const { result, calls } = await runTurn({
    recommendQueue: [makeRecommendOutcome('F')],
    intents: [
      { action: 'recommend', shape: null, customShape: null, place: '广州塔', rotationDeg: null, reply: '看看能画什么' },
    ],
  });
  const recommends = calls.filter((c) => c.type === 'recommend');
  check('真推荐意图：照常实测推荐', recommends.length === 1, `recommend ${recommends.length}`);
  check('真推荐意图：无"没能生成"误报（用户没点名图形）', !result.reply.includes('没能生成出来'), result.reply.slice(0, 80));
}

// ---------- 场景 5：引导自由文本路径同样恢复 ----------
{
  // 第一轮缺地点 → 引导；点击选项后 finalizeIntent 不再走 LLM；
  // 这里直接验证"带图形的自由文本合并"路径：first intent invalid + 恢复
  const planned = makePlanned({ score: 75, adjustedScore: 80, tag: 'E' });
  const { calls, bodies } = await runTurn({
    text: '画个小狗',
    planQueue: [planned],
    intents: [
      { action: 'plan', shape: null, customShape: INVALID_BOWTIE, place: '广州塔', rotationDeg: null, reply: '画小狗' },
      { name: '小狗B', points: VALID_CIRCLE.points },
    ],
  });
  const plans = calls.filter((c) => c.type === 'plan');
  check('主路径恢复：修正版进入规划', plans.length === 1 && plans[0]?.options?.customShape?.name === '小狗B');
  check(
    '主路径恢复：规划带正数尺寸基准（不是 null）',
    Number.isFinite(plans[0]?.options?.sizeMeters) && plans[0].options.sizeMeters > 0,
    String(plans[0]?.options?.sizeMeters),
  );
  check('主路径恢复：LLM 调用 3 次（意图+重生成+质检）', bodies.length === 3, `实际 ${bodies.length}`);
}

// ---------- 场景 5b：嵌套孔洞（当前架构不支持）→ 提前终止无效恢复，诚实说明能力边界 ----------
{
  // 外圆 + 内圆（内圆完全落在外圆内部）= 嵌套孔洞：当前架构不支持（路线要一笔画成）
  const outer = Array.from({ length: 24 }, (_, i) => {
    const t = (Math.PI * 2 * i) / 24;
    return [Math.cos(t) * 0.45, Math.sin(t) * 0.45];
  });
  const inner = Array.from({ length: 20 }, (_, i) => {
    const t = (Math.PI * 2 * i) / 20;
    return [Math.cos(t) * 0.18, Math.sin(t) * 0.18];
  });
  const nestedShape = { name: '同心圆', parts: [{ name: '外圆', points: outer }, { name: '内圆', points: inner }] };
  const { result, calls, bodies } = await runTurn({
    recommendQueue: [makeRecommendOutcome('G')],
    intents: [
      { action: 'plan', shape: null, customShape: nestedShape, place: '越秀公园', rotationDeg: null, reply: '画同心圆' },
    ],
  });
  const plans = calls.filter((c) => c.type === 'plan');
  const commits = calls.filter((c) => c.type === 'commitDraw');
  const recommends = calls.filter((c) => c.type === 'recommend');
  check('嵌套孔洞：不发起第二次生成（LLM 只调用意图 1 次）', bodies.length === 1, `实际 ${bodies.length}`);
  check('嵌套孔洞：不进入无效恢复', bodies.length === 1 && !bodies[1]);
  check('嵌套孔洞：不规划、不绘制', plans.length === 0 && commits.length === 0, `plan ${plans.length} commit ${commits.length}`);
  check('嵌套孔洞：不转实测推荐（能力边界要说清楚，不是"再找找"）', recommends.length === 0, `recommend ${recommends.length}`);
  check('嵌套孔洞：回复说明能力边界（带孔洞画不了）', result.reply.includes('带孔洞') || result.reply.includes('洞'), result.reply.slice(0, 160));
  check('嵌套孔洞：回复给出可行动的下一步', /实心|简化|换个|再试/.test(result.reply), result.reply.slice(0, 200));
}

console.log(`\n[summary] ${checks - failures}/${checks} 项通过，失败 ${failures} 项`);
if (failures > 0) {
  process.exitCode = 1;
}
