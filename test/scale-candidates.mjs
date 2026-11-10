/**
 * 多比例尺候选展示测试（需求 2026-11-09，方案同日 §2/§3/§5）。
 *
 * 覆盖：
 * - 池构建纯函数：可交付过滤（60 分闸门/质量门槛/显式约束）、按比例尺去重（同档
 *   变体只留一版且优先保留当前交付版）、升序、展示上限（当前版必在、按尺寸接近度
 *   保留、hiddenCount 如实）；
 * - controller 级：绿线交付挂卡（回复提示点卡片）、点选切换（不调 LLM、不重规划、
 *   commitDraw 用对应候选、回复数字与卡片同源）、点当前版不重绘、失效池拒绝、
 *   新输入/切会话丢弃、文字切换与卡片互通（含切到被截断隐藏档补卡）；
 * - 显式尺寸请求天然单档不出卡；低于闸门档位不进卡；
 * - 消息白名单：卡片摘要随消息持久化（刷新后静态可见的基础）。
 *
 * 运行：node test/scale-candidates.mjs
 */

import assert from 'node:assert/strict';

import { createAgentController, matchAlternativeSwitchPhrase } from '../web/src/agent/controller.js';
import {
  SCALE_CANDIDATE_DISPLAY_LIMIT,
  buildScaleCards,
  buildScaleCardSummary,
  scaleCardOffsetMeters,
} from '../web/src/agent/scale-candidates.js';
import { createSessionStore } from '../web/src/session/store.js';
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

const map = { getCenter: () => ({ lat: 23.12, lng: 113.32 }) };

// ---------- 1. 池构建纯函数 ----------

/** 构造过质量门槛的候选 metrics（与 test/alternative-switch.mjs 同一口径，补 RMS 字段） */
function makeMetrics(routeMeters, sizeMeters, rms = 0.02) {
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
    orderedOutlineRms: rms,
    orderedRouteRms: rms,
    orderedOutlineMeanRatio: 0.02,
    orderedOutlineMaxRatio: 0.04,
    orderedRouteMeanRatio: 0.02,
    orderedRouteMaxRatio: 0.05,
    featureCount: 0,
    featureCoveredCount: 0,
    featureCoverage: 1,
    frechetMaxRatio: 0.1,
    aspectDistortionRatio: 0.1,
    // 无特征图形：真实 planner 置 Infinity（视为完美），与 planner.js:973 一致
    featureGapRetainRatio: Number.POSITIVE_INFINITY,
    sizeMeters,
  };
}

function makeResult(name, sizeMeters, rms = 0.02) {
  return {
    shapeName: name,
    sizeMeters,
    routeLatLngs: [[23.12, 113.32], [23.121, 113.321]],
    outlineLatLngs: [[23.12, 113.32], [23.121, 113.321]],
    metrics: makeMetrics(sizeMeters * 3, sizeMeters, rms),
  };
}

function makeCandidate(sizeMeters, score, overrides = {}) {
  const rms = overrides.rms ?? 0.02;
  const result = overrides.result ?? makeResult('心形', sizeMeters, rms);
  return {
    result,
    score,
    adjustedScore: score,
    sizeMeters,
    rotationDeg: overrides.rotationDeg ?? 0,
    center: overrides.center ?? { lat: 23.12, lng: 113.32 },
    stage: 1,
    stageLabel: '近场搜索',
    envelopeMeters: 40,
    ...overrides.extra,
  };
}

{
  // 去重 + 升序：同档多个变体只留一版
  const best = makeCandidate(1800, 75);
  const variantSameTier = makeCandidate(1800, 70, { rotationDeg: 30, rms: 0.05 });
  const small = makeCandidate(900, 68);
  const large = makeCandidate(3600, 72);
  const { cards, hiddenCount, rawCount } = buildScaleCards({
    candidates: [best, variantSameTier, small, large],
    current: best,
  });
  check('纯函数：原始候选数按去重前计', rawCount === 4, String(rawCount));
  check('纯函数：同档去重后 3 档', cards.length === 3 && hiddenCount === 0, JSON.stringify(cards.map((c) => c.sizeMeters)));
  check(
    '纯函数：按尺寸升序',
    cards.map((c) => c.sizeMeters).join(',') === '900,1800,3600',
    JSON.stringify(cards.map((c) => c.sizeMeters)),
  );
  check(
    '纯函数：同档保留比较器最优一版（RMS 小者，不是当前版以外的变体）',
    cards.find((c) => c.sizeMeters === 1800)?.score === 75,
    JSON.stringify(cards.find((c) => c.sizeMeters === 1800)?.score),
  );
  check('纯函数：卡片摘要不含几何 result', !('result' in buildScaleCardSummary(cards[0])));
}

{
  // 可交付过滤：低于 60 分 / 路线退化 / 质量门槛不过 不进卡
  const best = makeCandidate(1800, 75);
  const lowScore = makeCandidate(900, 55);
  const degenerate = makeCandidate(2700, 70, {
    result: { ...makeResult('心形', 2700), routeLatLngs: [[23.12, 113.32]] },
  });
  const badQuality = makeCandidate(3600, 70, {
    result: {
      ...makeResult('心形', 3600),
      metrics: { ...makeMetrics(10800, 3600), failedLegs: 2 },
    },
  });
  const { cards } = buildScaleCards({ candidates: [best, lowScore, degenerate, badQuality], current: best });
  check(
    '纯函数：不可交付档位（低分/退化/质量不过）全部不进卡',
    cards.length === 1 && cards[0].sizeMeters === 1800,
    JSON.stringify(cards.map((c) => c.sizeMeters)),
  );
}

{
  // 展示上限：当前版必在、其余按尺寸接近度保留、hiddenCount 如实
  const sizes = [900, 1800, 2700, 3600, 4500, 5400, 6300, 7200, 9000];
  const candidates = sizes.map((size, index) => makeCandidate(size, 70 + (index % 3)));
  const current = candidates.find((c) => c.sizeMeters === 5400);
  const { cards, hiddenCount } = buildScaleCards({ candidates, current });
  check(
    `纯函数：超上限截断到 ${SCALE_CANDIDATE_DISPLAY_LIMIT} 档`,
    cards.length === SCALE_CANDIDATE_DISPLAY_LIMIT,
    JSON.stringify(cards.map((c) => c.sizeMeters)),
  );
  check('纯函数：hiddenCount = 档位数 - 展示数', hiddenCount === sizes.length - SCALE_CANDIDATE_DISPLAY_LIMIT, String(hiddenCount));
  check(
    '纯函数：当前交付版必在展示中',
    cards.some((c) => c.sizeMeters === 5400),
    JSON.stringify(cards.map((c) => c.sizeMeters)),
  );
  check(
    '纯函数：保留的是与当前版尺寸最接近的档位',
    cards.map((c) => c.sizeMeters).join(',') === '2700,3600,4500,5400,6300,7200',
    JSON.stringify(cards.map((c) => c.sizeMeters)),
  );

  // 当前版在极端档（最大）：同样必在，未展示的是远离它的档
  const currentLargest = candidates[candidates.length - 1];
  const extreme = buildScaleCards({ candidates, current: currentLargest });
  check(
    '纯函数：当前版在最大档时同样必在',
    extreme.cards.some((c) => c.sizeMeters === 9000) && extreme.hiddenCount === 3,
    JSON.stringify(extreme.cards.map((c) => c.sizeMeters)),
  );
}

{
  // 中心偏移口径
  const a = { center: { lat: 23.12, lng: 113.32 } };
  const b = { center: { lat: 23.13, lng: 113.32 } };
  const offset = scaleCardOffsetMeters(a, b);
  check('纯函数：中心偏移可算（约 1.1 km）', offset > 1000 && offset < 1200, String(offset));
  check('纯函数：缺中心返回 null（不编造）', scaleCardOffsetMeters(a, { center: null }) === null);
}

// ---------- 2. controller 级：交付挂卡 → 点选切换 → 互通 ----------

let intentQueue = [];
let llmFetchCount = 0;
globalThis.fetch = async (url) => {
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

function makeEngine({ planned } = {}) {
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

/** 三档达标池：交付 1800m（75 分），备选 900m（68）/3600m（72） */
function makePlannedThreeTiers() {
  const bestResult = makeResult('心形', 1800);
  return {
    status: 'ok',
    result: bestResult,
    best: {
      result: bestResult,
      score: 75,
      adjustedScore: 75,
      sizeMeters: 1800,
      rotationDeg: 0,
      center: { lat: 23.12, lng: 113.32 },
    },
    alternatives: [
      { result: makeResult('心形', 900), score: 68, adjustedScore: 68, sizeMeters: 900, rotationDeg: 15, center: { lat: 23.12, lng: 113.32 }, stage: 1, stageLabel: '近场搜索', envelopeMeters: 40 },
      { result: makeResult('心形', 3600), score: 72, adjustedScore: 72, sizeMeters: 3600, rotationDeg: 0, center: { lat: 23.125, lng: 113.32 }, stage: 2, stageLabel: '扩大范围', envelopeMeters: 40 },
    ],
    offset: { meters: 0, text: '' },
    stage: 1,
    stageLabel: '近场搜索',
    triedCount: 100,
    nearBest: null,
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
  const engine = makeEngine({ planned: makePlannedThreeTiers() });
  const controller = createAgentController({ map, engine, placeConfig, shapeReviewDeps: { renderOutline: () => null } });
  intentQueue = [{ ...INTENT }];

  const first = await controller.send({ text: '在广州塔画个心形' });
  check('交付挂卡：绿线交付', first.planned?.status === 'ok');
  const pool = first.scalePool;
  check(
    '交付挂卡：scalePool 3 张卡、升序、当前版是交付的 1800',
    pool
      && pool.cards.length === 3
      && pool.cards.map((c) => c.sizeMeters).join(',') === '900,1800,3600'
      && pool.cards.find((c) => c.id === pool.currentCardId)?.sizeMeters === 1800,
    JSON.stringify(pool),
  );
  check(
    '交付挂卡：卡片摘要含尺寸/贴合/里程/用时，不含几何',
    pool.cards.every((c) => Number.isFinite(c.sizeMeters) && Number.isFinite(c.score) && Number.isFinite(c.routeMeters) && Number.isFinite(c.walkMinutes) && !('result' in c)),
    JSON.stringify(pool.cards[0]),
  );
  check(
    '交付挂卡：回复提示可点卡片',
    first.reply.includes('点下方比例尺卡片'),
    first.reply.slice(-140),
  );

  // 归属消息绑定：只绑第一次，防串
  const bound = controller.attachScalePoolMessage(pool.poolId, 'm-reply-1');
  check('归属绑定：ownerMessageId 回填', bound.ownerMessageId === 'm-reply-1');
  const rebind = controller.attachScalePoolMessage(pool.poolId, 'm-other');
  check('归属绑定：重复绑定不覆盖', rebind.ownerMessageId === 'm-reply-1');
  const wrongBind = controller.attachScalePoolMessage('scp-none', 'm-x');
  check('归属绑定：poolId 不匹配不绑定', wrongBind?.ownerMessageId === 'm-reply-1');

  // 点选切换：不调 LLM、不重规划、交付对应候选
  const target = pool.cards.find((c) => c.sizeMeters === 3600);
  const planCountBefore = engine.calls.filter((c) => c.type === 'plan').length;
  const llmBefore = llmFetchCount;
  const historyBeforeSwitch = controller.exportContext().history.length;
  const switched = controller.switchScaleCandidate({ poolId: pool.poolId, cardId: target.id });
  check('点选切换：ok 且非 alreadyCurrent', switched.ok === true && switched.alreadyCurrent === false);
  check(
    '点选切换：不重新规划（plan 次数不变）',
    engine.calls.filter((c) => c.type === 'plan').length === planCountBefore,
    String(engine.calls.filter((c) => c.type === 'plan').length),
  );
  check('点选切换：不新增 LLM 请求（fetch 计数不变）', llmFetchCount === llmBefore, `before=${llmBefore} after=${llmFetchCount}`);
  check(
    '点选切换：commitDraw 用对应候选（3600m/72 分）',
    engine.calls.filter((c) => c.type === 'commitDraw').pop()?.result?.sizeMeters === 3600
      && engine.calls.filter((c) => c.type === 'commitDraw').pop()?.options?.score === 72,
    JSON.stringify(engine.calls.filter((c) => c.type === 'commitDraw').pop()?.result?.sizeMeters),
  );
  check(
    '点选切换：只返回数据、不再构造同义 reply（文案单源到 toast 摘要）',
    !('reply' in switched),
    JSON.stringify(Object.keys(switched)),
  );
  check(
    '点选切换：不写对话历史（点选不产生对话消息）',
    controller.exportContext().history.length === historyBeforeSwitch,
    `before=${historyBeforeSwitch} after=${controller.exportContext().history.length}`,
  );
  check(
    '点选切换：池当前版更新到 3600 卡',
    switched.scalePool?.currentCardId === target.id,
    JSON.stringify({ current: switched.scalePool?.currentCardId, target: target.id }),
  );
  check(
    '点选切换：消息摘要里的选中态同步（卡片行高亮依据）',
    switched.scalePool.cards.find((c) => c.id === target.id)?.sizeMeters === 3600,
  );

  // 点当前版：不重绘、明确提示
  const commitCountBefore = engine.calls.filter((c) => c.type === 'commitDraw').length;
  const again = controller.switchScaleCandidate({ poolId: pool.poolId, cardId: target.id });
  check(
    '点当前版：alreadyCurrent、不重绘、不构造同义 reply',
    again.alreadyCurrent === true
      && engine.calls.filter((c) => c.type === 'commitDraw').length === commitCountBefore
      && !('reply' in again),
    JSON.stringify(Object.keys(again ?? {})),
  );

  // 失效拒绝：poolId/cardId 不匹配
  check('失效拒绝：poolId 不匹配 ok:false', controller.switchScaleCandidate({ poolId: 'scp-x', cardId: target.id }).ok === false);
  check('失效拒绝：cardId 不匹配 ok:false', controller.switchScaleCandidate({ poolId: pool.poolId, cardId: 'sc-x' }).ok === false);

  // 卡片切换后文字短语继续可用：要小一点 → 从 3600 切到 1800（池重建 pendingAlternative）
  const phraseAfterCard = await controller.send({ text: '要小一点的那版' });
  check(
    '卡片→短语互通：点选 3600 后说"要小一点"切到 1800，仍不重规划',
    phraseAfterCard.shape?.sizeMeters === 1800
      && engine.calls.filter((c) => c.type === 'plan').length === planCountBefore
      && phraseAfterCard.scalePool?.currentCardId !== target.id,
    JSON.stringify({ size: phraseAfterCard.shape?.sizeMeters, pool: phraseAfterCard.scalePool?.currentCardId }),
  );
  check(
    '卡片→短语互通：短语切换后卡片行当前版同步（scalePool 随 send 返回）',
    phraseAfterCard.scalePool?.cards.some((c) => c.sizeMeters === 1800 && c.id === phraseAfterCard.scalePool.currentCardId),
    JSON.stringify(phraseAfterCard.scalePool),
  );

  // 新输入丢弃：非切换输入后池失效，卡片点不动
  intentQueue = [{ action: 'chat', reply: '好的。' }];
  const chat = await controller.send({ text: '换个话题' });
  check('新输入丢弃：chat 轮 scalePool 为 null', chat.scalePool === null);
  check('新输入丢弃：旧池点选返回 ok:false（不报错）', controller.switchScaleCandidate({ poolId: pool.poolId, cardId: target.id }).ok === false);

  // 切会话丢弃
  const controller2 = createAgentController({ map, engine, placeConfig, shapeReviewDeps: { renderOutline: () => null } });
  intentQueue = [{ ...INTENT }];
  const first2 = await controller2.send({ text: '在广州塔画个心形' });
  check('切会话前置：第二轮交付挂卡', Boolean(first2.scalePool?.poolId));
  controller2.importContext({ history: [] });
  check('切会话丢弃：importContext 后池失效', controller2.switchScaleCandidate({ poolId: first2.scalePool.poolId, cardId: first2.scalePool.currentCardId }).ok === false);
}

{
  // 文字切换到被截断隐藏的档位：补卡 + 重新截断，当前版必在
  const sizes = [900, 1800, 2700, 3600, 4500, 5400, 6300, 7200, 9000];
  const bestResult = makeResult('心形', 5400);
  const planned = {
    status: 'ok',
    result: bestResult,
    best: { result: bestResult, score: 80, adjustedScore: 80, sizeMeters: 5400, rotationDeg: 0, center: { lat: 23.12, lng: 113.32 } },
    alternatives: sizes.filter((s) => s !== 5400).map((s) => ({
      result: makeResult('心形', s),
      score: 65 + (s % 10),
      adjustedScore: 65 + (s % 10),
      sizeMeters: s,
      rotationDeg: 0,
      center: { lat: 23.12, lng: 113.32 },
      stage: 1,
      stageLabel: '近场搜索',
      envelopeMeters: 40,
    })),
    offset: { meters: 0, text: '' },
    stage: 1,
    stageLabel: '近场搜索',
    triedCount: 100,
    nearBest: null,
  };
  const engine = makeEngine({ planned });
  const controller = createAgentController({ map, engine, placeConfig, shapeReviewDeps: { renderOutline: () => null } });
  intentQueue = [{ ...INTENT }];

  const first = await controller.send({ text: '在广州塔画个心形' });
  check(
    '超上限例：交付 5400，9 档截到 6 档，当前版必在',
    first.scalePool.cards.length === SCALE_CANDIDATE_DISPLAY_LIMIT
      && first.scalePool.cards.some((c) => c.sizeMeters === 5400)
      && first.scalePool.cards.every((c) => c.sizeMeters !== 9000),
    JSON.stringify(first.scalePool.cards.map((c) => c.sizeMeters)),
  );

  // 回复承诺最大的 9000m 版（被截断隐藏）；照做切换 → 补卡并重新截断
  check('超上限例：回复仍承诺 9 km 版（文字切换可达）', first.reply.includes('9.0 km'), first.reply.slice(-160));
  const switched = await controller.send({ text: '要大一点的那版' });
  check('超上限例：文字切换交付被隐藏的 9000m 版', switched.shape?.sizeMeters === 9000, JSON.stringify({ size: switched.shape?.sizeMeters }));
  check(
    '超上限例：隐藏档补进卡片并重新截断（当前版必在）',
    switched.scalePool
      && switched.scalePool.currentCardId !== null
      && switched.scalePool.cards.some((c) => c.sizeMeters === 9000 && c.id === switched.scalePool.currentCardId)
      && switched.scalePool.cards.length === SCALE_CANDIDATE_DISPLAY_LIMIT,
    JSON.stringify(switched.scalePool?.cards.map((c) => c.sizeMeters)),
  );
}

{
  // 显式尺寸：契约外档位不进卡；只剩 1 档 → 不出卡（行为与改动前一致）
  const bestResult = makeResult('五角星', 1000);
  const planned = {
    status: 'ok',
    result: bestResult,
    best: { result: bestResult, score: 78, adjustedScore: 78, sizeMeters: 1000, rotationDeg: 0, center: { lat: 23.12, lng: 113.32 } },
    // 引擎在显式尺寸下只会产出请求尺寸；这里多放一个"违规档"验证契约过滤
    alternatives: [
      { result: makeResult('五角星', 2000), score: 82, adjustedScore: 82, sizeMeters: 2000, rotationDeg: 0, center: { lat: 23.12, lng: 113.32 }, stage: 1, stageLabel: '近场搜索', envelopeMeters: 40 },
    ],
    offset: { meters: 0, text: '' },
    stage: 1,
    stageLabel: '近场搜索',
    triedCount: 50,
    nearBest: null,
  };
  const engine = makeEngine({ planned });
  const controller = createAgentController({ map, engine, placeConfig, shapeReviewDeps: { renderOutline: () => null } });
  intentQueue = [{ ...INTENT, shape: 'star', sizeMeters: 1000, sizeExplicit: true, place: '广州塔' }];
  const first = await controller.send({ text: '在广州塔画个 1 公里的五角星' });
  check(
    '显式尺寸：契约外档位被过滤，单档不出卡、回复不提示卡片',
    first.scalePool === null && !first.reply.includes('点下方比例尺卡片'),
    JSON.stringify({ pool: first.scalePool, tail: first.reply.slice(-100) }),
  );
}

{
  // 推荐链路不适用：recommend 交付不带卡片池
  const engine = makeEngine();
  engine.plan = async () => ({ status: 'failed' });
  engine.recommend = async () => {
    const starResult = makeResult('五角星', 2400);
    const drawn = { shapeName: '五角星', result: starResult, score: 72, adjustedScore: 72, sizeMeters: 2400, rotationDeg: 0, center: { lat: 23.12, lng: 113.32 } };
    return {
      status: 'ok',
      drawn,
      recommendations: [drawn],
      bests: {},
      offset: { meters: 0, text: '' },
      stage: 1,
      stageLabel: '近场搜索',
      triedCount: 10,
      nearBest: null,
    };
  };
  const controller = createAgentController({ map, engine, placeConfig, shapeReviewDeps: { renderOutline: () => null } });
  intentQueue = [{ ...INTENT, action: 'recommend', shape: null, place: '广州塔' }];
  const first = await controller.send({ text: '在广州塔推荐一个图形' });
  check('推荐链路：不产出比例尺卡片池', first.scalePool === null, JSON.stringify(first.scalePool));
}

// ---------- 3. 消息白名单：卡片摘要随消息持久化 ----------

{
  const storage = {
    data: {},
    getItem(key) {
      return this.data[key] ?? null;
    },
    setItem(key, value) {
      this.data[key] = String(value);
    },
    removeItem(key) {
      delete this.data[key];
    },
  };
  const store = createSessionStore({ storage });
  const session = store.createSession();
  const summary = {
    id: 'sc-1',
    sizeMeters: 1800,
    rotationDeg: 0,
    center: { lat: 23.12, lng: 113.32 },
    score: 75,
    routeMeters: 5400,
    walkMinutes: 68,
    meanMeters: 20,
    maxMeters: 40,
    coverage: 100,
    featureCount: 0,
    featureCoveredCount: 0,
  };
  store.appendMessage(session.id, {
    role: 'agent',
    text: '已规划',
    scaleCandidates: [summary, { ...summary, id: 'sc-2', sizeMeters: 3600 }],
    scalePoolId: 'scp-1',
    scaleCurrentCardId: 'sc-1',
    scaleHiddenCount: 0,
  });
  store.flush();
  const persisted = JSON.parse(storage.data['drawinmap.sessions.v1']);
  const message = persisted.sessions[0].messages.find((item) => item.role === 'agent');
  check(
    '消息白名单：scaleCandidates/scalePoolId/scaleCurrentCardId/scaleHiddenCount 全部落盘',
    Array.isArray(message.scaleCandidates)
      && message.scaleCandidates.length === 2
      && message.scalePoolId === 'scp-1'
      && message.scaleCurrentCardId === 'sc-1'
      && message.scaleHiddenCount === 0,
    JSON.stringify(message),
  );
  check('消息白名单：几何不入消息（摘要无 result 字段）', message.scaleCandidates.every((card) => !('result' in card)));
}

// ---------- 4. 短语识别回归（与 alternative-switch.mjs 同口径，防卡片改动破坏短语） ----------

check('短语回归：要大一点的那版 → bigger', matchAlternativeSwitchPhrase('要大一点的那版') === 'bigger');
check('短语回归：画个心形 → null', matchAlternativeSwitchPhrase('画个心形') === null);

assert.doesNotThrow(() => {
  // 池视图序列化安全（消息落盘路径会 JSON 克隆）
  JSON.stringify({ cards: [buildScaleCardSummary(makeCandidate(900, 68))] });
}, '卡片摘要必须可直接 JSON 序列化');

console.log(failures === 0 ? `RESULT: PASS (${checks} checks)` : `RESULT: FAIL (${failures}/${checks} checks)`);
process.exit(failures === 0 ? 0 : 2);
