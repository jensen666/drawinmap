/**
 * 备选切换测试（缺陷清单 2026-11-06 Bug 5）。
 *
 * 缺陷：成功交付的回复承诺"想换这一版直接说『要大一点/小一点的那版』"，
 * 但系统没有任何解析/切换逻辑——用户照做会被当成全新请求重新走 LLM 解析 +
 * 全量重规划，结果未必是那一版（承诺不可兑现）；备选随轮次结束即丢弃。
 *
 * 修复口径（清单 5.4 完整方案）：绿线交付后保存备选（含完整几何）为待切换快照；
 * 下一轮输入命中切换短语时直接提交对应候选并交付（不调 LLM、不重新规划）；
 * 切换后的版本成为当前版、旧版进入备选可切回；无该方向备选时诚实说明；
 * 新输入/切会话清理快照。
 *
 * 运行：node test/alternative-switch.mjs
 */

import { createAgentController, matchAlternativeSwitchPhrase } from '../web/src/agent/controller.js';
import { initLogging } from '../web/src/log/index.js';
import { placeConfig } from './fixtures/place-config.mjs';

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

initLogging({ server: false, storage: false, level: 'error' });

// ---------- 1. 短语识别 ----------

{
  check('短语：要大一点的那版 → bigger', matchAlternativeSwitchPhrase('要大一点的那版') === 'bigger');
  check('短语：要小一点的那版 → smaller', matchAlternativeSwitchPhrase('要小一点的那版') === 'smaller');
  check('短语：换小一点的那版吧 → smaller', matchAlternativeSwitchPhrase('换小一点的那版吧') === 'smaller');
  check('短语：给我要大一点的那版 → bigger', matchAlternativeSwitchPhrase('给我要大一点的那版') === 'bigger');
  check('短语：要大一点的那版。 → bigger（尾标点）', matchAlternativeSwitchPhrase('要大一点的那版。') === 'bigger');
  check('短语：来大一点的那版 → bigger', matchAlternativeSwitchPhrase('来大一点的那版') === 'bigger');
  check('非短语：画个心形 → null', matchAlternativeSwitchPhrase('画个心形') === null);
  check('非短语：帮我画个要大一点的那版看看 → null（长句不误判）', matchAlternativeSwitchPhrase('帮我画个要大一点的那版看看') === null);
  check('非短语：要大一点的那版还是小一点的？ → null（引述/疑问不误判）', matchAlternativeSwitchPhrase('要大一点的那版还是小一点的？') === null);
  check('非短语：空输入 → null', matchAlternativeSwitchPhrase('') === null);
}

// ---------- 2. controller 级：交付 → 切换 → 切回 ----------

const map = { getCenter: () => ({ lat: 23.12, lng: 113.32 }) };

function makeMetrics(routeMeters, sizeMeters) {
  return {
    routeMeters,
    walkMinutes: Math.round(routeMeters / 80),
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
    featureCount: 0,
    featureCoveredCount: 0,
    featureCoverage: 1,
    frechetMaxRatio: 0.1,
    aspectDistortionRatio: 0.1,
    featureGapRetainRatio: 1,
    sizeMeters,
  };
}

function makeResult(name, sizeMeters) {
  return {
    shapeName: name,
    sizeMeters,
    routeLatLngs: [[23.12, 113.32], [23.121, 113.321]],
    outlineLatLngs: [[23.12, 113.32], [23.121, 113.321]],
    metrics: makeMetrics(sizeMeters * 3, sizeMeters),
  };
}

/** 交付 5400m 版，备选 9000m 版（回复承诺"要大一点的那版"） */
function makePlannedWithAlternative() {
  const bestResult = makeResult('心形', 5400);
  const altResult = makeResult('心形', 9000);
  return {
    status: 'ok',
    result: bestResult,
    best: {
      result: bestResult,
      score: 70,
      adjustedScore: 70,
      sizeMeters: 5400,
      rotationDeg: 0,
      center: { lat: 23.12, lng: 113.32 },
    },
    alternatives: [
      {
        result: altResult,
        score: 77,
        adjustedScore: 77,
        sizeMeters: 9000,
        rotationDeg: 0,
        center: { lat: 23.12, lng: 113.32 },
        stage: 1,
        stageLabel: '近场搜索',
        envelopeMeters: 40,
      },
    ],
    offset: { meters: 0, text: '' },
    stage: 1,
    stageLabel: '近场搜索',
    triedCount: 100,
    nearBest: null,
  };
}

let intentQueue = [];
/** 真实 LLM fetch 调用计数（修复前断言是"常量自比较"的假断言：llmCallsAfter = llmCallsBefore） */
let llmFetchCount = 0;
globalThis.fetch = async (url, options = {}) => {
  const href = String(url);
  if (href.includes('/data/guangzhou-roads.json')) {
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ roads: [] }) };
  }
  llmFetchCount += 1;
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({
      id: 'mock',
      model: 'mock',
      choices: [{ message: { content: JSON.stringify(intentQueue.shift() ?? { action: 'chat', reply: '收到' }) }, finish_reason: 'stop' }],
      usage: {},
    }),
  };
};

function makeEngine({ planned = makePlannedWithAlternative() } = {}) {
  const calls = [];
  return {
    calls,
    plan: async (options) => {
      calls.push({ type: 'plan', options });
      return planned;
    },
    recommend: async () => ({ status: 'failed' }),
    commitDraw: (result, options) => {
      calls.push({ type: 'commitDraw', result, options });
      return { shapeName: result.shapeName ?? null, sizeMeters: result.sizeMeters ?? null, score: options?.score ?? null };
    },
    clearDraw: () => calls.push({ type: 'clearDraw' }),
    formatMinutes: (minutes) => `${Math.round(minutes)} 分钟`,
    getPlaceContext: async () => null,
  };
}

const INTENT = {
  action: 'plan',
  shape: 'heart',
  customShape: null,
  place: '广州塔',
  rotationDeg: null,
  reply: '好的，画个心形。',
};

{
  const engine = makeEngine();
  const controller = createAgentController({ map, engine, placeConfig, shapeReviewDeps: { renderOutline: () => null } });
  intentQueue = [{ ...INTENT }];

  const first = await controller.send({ text: '在广州塔画个心形' });
  check('首轮：绿线交付', first.planned?.status === 'ok', JSON.stringify({ status: first.planned?.status, reply: first.reply?.slice(0, 80) }));
  check('首轮：回复承诺可切换备选', first.reply.includes('要大一点的那版'), first.reply.slice(-120));

  // 用户照做：切换短语 → 直接提交备选（不调 LLM、不重新规划）
  const llmFetchBefore = llmFetchCount; // 首轮 1 次意图解析
  const second = await controller.send({ text: '要大一点的那版' });
  check(
    '切换轮：不重新 LLM 解析、不重新规划',
    engine.calls.filter((call) => call.type === 'plan').length === 1,
    `plan ${engine.calls.filter((call) => call.type === 'plan').length}`,
  );
  check(
    '切换轮：LLM 调用数真实不变（fetch 计数，无意图解析重发）',
    llmFetchCount === llmFetchBefore,
    `before=${llmFetchBefore} after=${llmFetchCount}`,
  );
  check(
    '切换轮：交付备选那版（sizeMeters=9000）',
    second.shape?.sizeMeters === 9000 && second.planned?.best?.sizeMeters === 9000,
    JSON.stringify({ shape: second.shape, best: second.planned?.best?.sizeMeters }),
  );
  check('切换轮：回复说明已切换', second.reply.includes('已切换到更大的一版'), second.reply.slice(0, 160));
  check(
    '切换轮：commitDraw 用的是备选候选的完整结果',
    engine.calls.filter((call) => call.type === 'commitDraw').pop()?.result?.sizeMeters === 9000,
    JSON.stringify(engine.calls.filter((call) => call.type === 'commitDraw').pop()?.result?.sizeMeters),
  );

  // 切回：旧版进入备选，可反向切换
  const third = await controller.send({ text: '要小一点的那版' });
  check(
    '切回：可切回旧版（5400）',
    third.shape?.sizeMeters === 5400,
    JSON.stringify({ shape: third.shape }),
  );

  // 交替切换：再切大 → 回到 9000 版（可反复切换，无需重规划）
  const fourth = await controller.send({ text: '要大一点的那版' });
  check(
    '交替切换：再切大回到 9000 版（仍不重规划）',
    fourth.shape?.sizeMeters === 9000 && engine.calls.filter((call) => call.type === 'plan').length === 1,
    JSON.stringify({ shape: fourth.shape, plans: engine.calls.filter((c) => c.type === 'plan').length }),
  );

  // 方向缺失：当前已是最大备选 → 诚实说明（不硬凑、不重规划）
  const fifth = await controller.send({ text: '要大一点的那版' });
  check(
    '方向缺失：已是最大版时诚实说明且不重规划',
    fifth.planned === null && fifth.reply.includes('没有更大') && engine.calls.filter((call) => call.type === 'plan').length === 1,
    JSON.stringify({ reply: fifth.reply.slice(0, 100), plans: engine.calls.filter((c) => c.type === 'plan').length }),
  );

  // 新输入清空快照：之后再发切换短语 → 明确说没有备选
  intentQueue = [{ action: 'chat', reply: '好的。' }];
  await controller.send({ text: '换个话题' });
  const sixth = await controller.send({ text: '要小一点的那版' });
  check(
    '新输入清理：非切换输入后快照清空，切换短语明确说没有备选',
    sixth.reply.includes('没有可切换的备选'),
    sixth.reply.slice(0, 100),
  );
}

// ---------- 3. 无待切换快照时直接说切换短语 ----------

{
  const engine = makeEngine();
  const controller = createAgentController({ map, engine, placeConfig, shapeReviewDeps: { renderOutline: () => null } });
  const first = await controller.send({ text: '要大一点的那版' });
  check(
    '无快照：切换短语明确说没有备选（不调 LLM、不规划）',
    first.reply.includes('没有可切换的备选') && engine.calls.filter((call) => call.type === 'plan').length === 0,
    JSON.stringify({ reply: first.reply.slice(0, 80), plans: engine.calls.filter((c) => c.type === 'plan').length }),
  );
}

// ---------- 4. 承诺版本 = 切换版本（2026-11-07 复核：B8 实锤承诺 7.2km 切到 0.9km） ----------

{
  // 交付 9000m 版，备选 [900m(67分), 7200m(78分)]：
  // 回复承诺的是"尺寸最大的另一版"= 7200m（relation"尺寸更小"），不是极小值 900m
  const planned = makePlannedWithAlternative();
  planned.best = { ...planned.best, sizeMeters: 9000, score: 82 };
  planned.result = makeResult('心形', 9000);
  planned.best.result = planned.result;
  planned.alternatives = [
    { result: makeResult('心形', 900), score: 67, adjustedScore: 67, sizeMeters: 900, rotationDeg: 15, center: { lat: 23.12, lng: 113.32 }, stage: 1, stageLabel: '近场搜索', envelopeMeters: 40 },
    { result: makeResult('心形', 7200), score: 78, adjustedScore: 78, sizeMeters: 7200, rotationDeg: 180, center: { lat: 23.121, lng: 113.321 }, stage: 1, stageLabel: '近场搜索', envelopeMeters: 40 },
  ];
  const engine = makeEngine({ planned });
  const controller = createAgentController({ map, engine, placeConfig, shapeReviewDeps: { renderOutline: () => null } });
  intentQueue = [{ ...INTENT }];

  const first = await controller.send({ text: '在广州塔画个心形' });
  check('承诺场景：绿线交付 9000m 版', first.planned?.status === 'ok' && first.shape?.sizeMeters === 9000, JSON.stringify(first.shape));
  check(
    '承诺场景：回复承诺的是 7.2km 版（不是 0.9km 极值）',
    first.reply.includes('7.2 km') && first.reply.includes('要小一点的那版'),
    first.reply.slice(-160),
  );

  // 照做：必须交付承诺的 7200m 版（尺寸/朝向/中心与承诺版本一致），绝不切到 900m
  const switched = await controller.send({ text: '要小一点的那版' });
  check(
    '承诺=切换：交付 7200m 承诺版（不是 900m 极值）',
    switched.shape?.sizeMeters === 7200,
    JSON.stringify({ shape: switched.shape, reply: switched.reply?.slice(0, 100) }),
  );
  const promisedCandidate = planned.alternatives[1];
  check(
    '承诺=切换：rotationDeg/center 与承诺版本逐字段一致',
    switched.planned?.best?.rotationDeg === promisedCandidate.rotationDeg
      && switched.planned?.best?.center?.lat === promisedCandidate.center.lat
      && switched.planned?.best?.center?.lng === promisedCandidate.center.lng,
    JSON.stringify({ to: switched.planned?.best, promised: { rotationDeg: promisedCandidate.rotationDeg, center: promisedCandidate.center } }),
  );
}

// ---------- 5. 切换前 60 分交付闸门 ----------

{
  // 备选只有 55 分（低于交付闸门）→ 不承诺；用户强行切换 → 闸门拒绝（不当绿线交付）
  const planned = makePlannedWithAlternative();
  planned.alternatives = [
    { result: makeResult('心形', 3000), score: 55, adjustedScore: 55, sizeMeters: 3000, rotationDeg: 0, center: { lat: 23.12, lng: 113.32 }, stage: 1, stageLabel: '近场搜索', envelopeMeters: 40 },
  ];
  const engine = makeEngine({ planned });
  const controller = createAgentController({ map, engine, placeConfig, shapeReviewDeps: { renderOutline: () => null } });
  intentQueue = [{ ...INTENT }];

  const first = await controller.send({ text: '在广州塔画个心形' });
  check(
    '闸门：低于 60 分的备选不进承诺文案（不再制造兑现不了的承诺）',
    first.planned?.status === 'ok' && !first.reply.includes('想换这一版'),
    first.reply.slice(-140),
  );
  const refused = await controller.send({ text: '要小一点的那版' });
  check(
    '闸门：强行切换低于闸门备选 → 拒绝且不当绿线交付',
    refused.planned === null && refused.reply.includes('交付闸门') && engine.calls.filter((call) => call.type === 'commitDraw').length === 1,
    JSON.stringify({ reply: refused.reply.slice(0, 120), commits: engine.calls.filter((c) => c.type === 'commitDraw').length }),
  );
}

console.log(failures === 0 ? `RESULT: PASS (${checks} checks)` : `RESULT: FAIL (${failures}/${checks} checks)`);
process.exit(failures === 0 ? 0 : 2);
