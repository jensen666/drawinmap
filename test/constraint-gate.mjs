/**
 * 约束闸门 fail-open 修复测试（缺陷清单 2026-11-06 Bug 4.1）。
 *
 * 缺陷：userConstraints 由 LLM 解析，漏记时 `summarizeConstraints` 在 required 为空
 * 处直接 ok——"没核对"被当成"通过"（fail-open）。真实教训（2026-11-05 H06 首跑）：
 * 原文"在花城广场画一匹马，要奔跑的样子"，LLM 漏记 → userConstraints=[] → 约束核对
 * 被跳过 → 仍绿线交付 78 分，用户可能拿到一匹"站着的马"。
 *
 * 修复口径（清单 4.1.4 最保守版 + 打点）：
 * - freeform：userConstraints 为空但原文疑似包含显式要求 → 验收 fail，不给绿线；
 * - reference/builtin/procedural：无逐项核对机制，同样条件下降级 unavailable
 *   （橙色诊断参考 + 明确原因），不得"无核对绿线交付"；
 * - 原文没有约束触发词 → 正常 pass（修复必须区分"用户没提约束"与"提了但没解析出来"）；
 * - 检测精度优先：意图表达（我要画）、尺寸请求（要大一点）、常用词（需要/重要）
 *   不得误报。
 *
 * 运行：node test/constraint-gate.mjs
 */

import { createAgentController } from '../web/src/agent/controller.js';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertSvg } from '../web/src/reference/convert.js';
import { sha256NormalizedText } from '../web/src/reference/hash.js';
import { detectPossibleConstraintText } from '../web/src/agent/constraint-detect.js';
import { acceptFreeformTarget } from '../web/src/agent/target-acceptance.js';
import { normalizeCustomShape } from '../web/src/agent/intent.js';
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

// ---------- 1. 检测器：正例（H06 及典型约束表达） ----------

{
  const positives = [
    ['在花城广场画一匹马，要奔跑的样子', '的样子', 'H06 原文'],
    ['画一只猫，不要尖角', '不要', '否定约束'],
    ['画个五角星，必须有五个尖角', '必须', '显式要求词'],
    ['画只兔子，尾巴要翘起来', '要翘', 'X要Y'],
    ['画一朵花，要红色的', '要红', '颜色约束'],
    ['画匹马，站立的姿态', '姿态', '姿态词'],
    ['画个五角星，一定要有四个尖角', '一定要', '一定要有'],
    ['画只猫，别画得太机械', '别画', '别画'],
  ];
  for (const [text, expectCue, label] of positives) {
    const detected = detectPossibleConstraintText(text);
    check(
      `检测正例（${label}）：「${text}」→ suspected`,
      detected.suspected === true && detected.cues.some((cue) => expectCue.split('|').some((word) => cue.includes(word))),
      JSON.stringify(detected),
    );
  }

  const negatives = [
    ['我要画个心形', '意图表达「我要画」'],
    ['画只猫和兔子', '多对象无约束'],
    ['生成一个小猪佩奇', '普通请求'],
    ['在花城广场画一匹马', '无约束普通请求'],
    ['画大一点的心形', '尺寸请求'],
    ['心形要大一点', '尺寸请求（X要Y 但要后是尺寸词）'],
    ['画五角星需要多少分钟', '常用词「需要」'],
    ['画个重要的地标', '常用词「重要」'],
    ['帮我画只狗，大概 2 公里', '尺寸请求'],
    ['画个广州塔的样子', '目标描述（的样子 无要求前缀）'],
    ['要不要画个心形', '疑问表达（要不要）'],
    ['能不能画一只猫', '疑问表达（能不能）'],
    ['一定要画个大一点的心形', '意图表达（一定要画）'],
    ['我必须画个五角星', '意图表达（必须画）'],
    ['', '空文本'],
  ];
  for (const [text, label] of negatives) {
    const detected = detectPossibleConstraintText(text);
    check(
      `检测负例（${label}）：「${text}」→ 不误报`,
      detected.suspected === false,
      JSON.stringify(detected),
    );
  }
}

// ---------- 2. freeform 验收：漏解析 + 疑似约束 → fail ----------

{
  const points = Array.from({ length: 90 }, (_, i) => {
    const t = (Math.PI * 2 * i) / 90;
    return [Math.cos(t) * 0.4, Math.sin(t) * 0.4];
  });
  const shape = normalizeCustomShape({
    name: '马',
    points,
    features: [1, 2, 3].map((n) => ({ name: `特征${n}`, points: [[0, 0]] })),
  });
  const likeReview = { available: true, verdict: 'like', constraintSummary: { ok: true, unavailable: false, failed: [] } };

  const gated = acceptFreeformTarget(shape, likeReview, { userText: '在花城广场画一匹马，要奔跑的样子' });
  check(
    'freeform：质检 like 但原文疑似含约束且 userConstraints=[] → fail（不 fail-open）',
    gated.verdict === 'fail' && gated.checks.constraintSuspected?.length > 0,
    JSON.stringify(gated.reasons),
  );

  const clean = acceptFreeformTarget(shape, likeReview, { userText: '在花城广场画一匹马' });
  check(
    'freeform：原文无约束触发词 → 正常 pass（不误伤普通请求）',
    clean.verdict === 'pass',
    JSON.stringify(clean.reasons),
  );

  // 约束已解析（userConstraints 非空）且逐项核对通过 → 正常 pass，不做检测降级：
  // 检测只是"漏解析"的兜底，已核对通过的合法交付不得被原文 cue 误拦
  // （2026-11-07 复核：此处断言曾写反成 fail，恰好掩盖了过度拦截缺陷）
  const withConstraints = acceptFreeformTarget(shape, likeReview, {
    userText: '在花城广场画一匹马，要奔跑的样子',
    userConstraints: ['要奔跑的样子'],
  });
  check(
    'freeform：约束已解析且核对通过 → pass（疑似约束检测不误拦已核对交付）',
    withConstraints.verdict === 'pass',
    JSON.stringify(withConstraints.reasons),
  );

  // 约束已解析但核对未通过 → 仍 fail（走 constraintSummary 裁决，与检测无关）
  const constraintFailed = acceptFreeformTarget(shape, {
    available: true,
    verdict: 'like',
    constraintSummary: { ok: false, unavailable: false, failed: ['要奔跑的样子'] },
  }, { userText: '在花城广场画一匹马，要奔跑的样子', userConstraints: ['要奔跑的样子'] });
  check(
    'freeform：约束已解析但核对未通过 → fail（constraintSummary 裁决不受检测影响）',
    constraintFailed.verdict === 'fail',
    JSON.stringify(constraintFailed.reasons),
  );
}

// ---------- 3. reference 目标（controller 级）：漏解析 → 降级橙色诊断，不绿线 ----------

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(root, 'web/data/shapes');
const manifest = JSON.parse(readFileSync(resolve(dataDir, 'manifest.json'), 'utf8'));

/** 本地精选马候选（与 controller-multi-object 同构造） */
function makeHorseCandidate() {
  const asset = manifest.assets.find((item) => item.id === 'horse-phylopic');
  const svgText = readFileSync(resolve(dataDir, asset.file), 'utf8');
  const conversion = convertSvg(svgText);
  return {
    asset: { ...asset, displayName: '马' },
    customShape: {
      name: '马',
      constraintPoints: conversion.T.points.filter((_, index) => index % 8 === 0),
      outlinePoints: conversion.T.points,
      parts: [],
      features: [],
    },
    conversion: { status: conversion.status, T: conversion.T, metrics: conversion.metrics ?? null },
    matchedAlias: '马',
    origin: 'local',
    reviewStatus: 'curated',
    sourceSha256: sha256NormalizedText(svgText),
    contentHash: `hash-horse`,
  };
}

const HORSE = makeHorseCandidate();

let intentQueue = [];
globalThis.fetch = async (url, options = {}) => {
  const href = String(url);
  if (href.includes('/data/guangzhou-roads.json')) {
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ roads: [] }) };
  }
  const system = JSON.parse(options.body || '{}')?.messages?.[0]?.content || '';
  if (system.includes('质检员')) {
    return llmResponse({ verdict: 'like', seen: 'ok', issues: [] });
  }
  return llmResponse(intentQueue.shift() ?? { action: 'chat', reply: '收到' });
};

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

const map = { getCenter: () => ({ lat: 23.12, lng: 113.32 }) };

/** 达标规划结果（绿线口径），用于验证"被降级后不会走正式规划" */
function makePlanned() {
  const result = {
    shapeName: '马',
    routeLatLngs: [[23.12, 113.32], [23.121, 113.321]],
    outlineLatLngs: [[23.12, 113.32], [23.121, 113.321]],
    metrics: {
      routeMeters: 1000, walkMinutes: 15, detourRatio: 1.2, coverage: 100, failedLegs: 0,
      snapMaxMeters: 20, keyCoverage: 1, collapsedKeyCount: 0, keyMaxOffsetRatio: 0.01,
      orderedOutlineMeanMeters: 20, orderedOutlineMaxMeters: 40, orderedOutlineMeanRatio: 0.02,
      orderedOutlineMaxRatio: 0.04, orderedRouteMeanRatio: 0.02, orderedRouteMaxRatio: 0.05,
      featureCount: 0, featureCoveredCount: 0, featureCoverage: 1, frechetMaxRatio: 0.1,
      aspectDistortionRatio: 0.1, featureGapRetainRatio: 1,
    },
  };
  return {
    status: 'ok', result,
    best: { result, score: 78, adjustedScore: 78, sizeMeters: 1200, rotationDeg: 0, center: { lat: 23.12, lng: 113.32 } },
    offset: { meters: 0, text: '' }, stage: 1, stageLabel: '近场搜索', triedCount: 100, alternatives: [],
  };
}

function makeEngine() {
  const calls = [];
  return {
    calls,
    plan: async (options) => {
      calls.push({ type: 'plan', options });
      return makePlanned();
    },
    recommend: async () => ({ status: 'failed' }),
    commitDraw: (result, options) => {
      calls.push({ type: 'commitDraw', result, options });
      return { shapeName: '马' };
    },
    clearDraw: () => calls.push({ type: 'clearDraw' }),
    formatMinutes: (minutes) => `${Math.round(minutes)} 分钟`,
    getPlaceContext: async () => null,
  };
}

/** 旧串行参考源：本地唯一命中直走 resolveTarget（H06 的真实路径） */
const serialReferenceSource = {
  async resolveCandidates() {
    return {
      status: 'ok',
      origin: 'local',
      candidates: [HORSE],
      failures: [],
      rawCount: 1,
      poolSize: 1,
      attempts: [],
    };
  },
};

{
  const engine = makeEngine();
  const controller = createAgentController({
    map,
    engine,
    placeConfig,
    referenceSource: serialReferenceSource,
    shapeReviewDeps: { renderOutline: () => 'data:image/png;base64,FAKE' },
  });
  intentQueue = [
    { action: 'plan', shape: null, customShape: null, place: '花城广场', reply: '好的，画一匹马。', userConstraints: [] },
  ];
  const result = await controller.send({ text: '在花城广场画一匹马，要奔跑的样子' });
  const plans = engine.calls.filter((call) => call.type === 'plan');
  const commits = engine.calls.filter((call) => call.type === 'commitDraw');
  const greenCommits = commits.filter((call) => call.options?.reference !== true);
  check('H06 场景：调用路网引擎（诊断性参考仍允许）', plans.length === 1, `plan ${plans.length}`);
  check(
    'H06 场景：没有绿线交付（不发生"无核对绿线交付"）',
    greenCommits.length === 0,
    JSON.stringify(commits.map((call) => call.options)),
  );
  check(
    'H06 场景：回复明确说明要求未核对（诚实降级，不静默）',
    /未验收|没有解析出|无法逐项核对|未通过|参考/.test(result.reply),
    result.reply.slice(0, 200),
  );

  // 对照：同一请求但原文无约束 → 正常绿线（不误伤）
  const engine2 = makeEngine();
  const controller2 = createAgentController({
    map,
    engine: engine2,
    placeConfig,
    referenceSource: serialReferenceSource,
    shapeReviewDeps: { renderOutline: () => 'data:image/png;base64,FAKE' },
  });
  intentQueue = [
    { action: 'plan', shape: null, customShape: null, place: '花城广场', reply: '好的，画一匹马。', userConstraints: [] },
  ];
  const result2 = await controller2.send({ text: '在花城广场画一匹马' });
  const greenCommits2 = engine2.calls.filter((call) => call.type === 'commitDraw' && call.options?.reference !== true);
  check('H06 对照：原文无约束 → 正常绿线交付', greenCommits2.length === 1, JSON.stringify({ commits: engine2.calls.filter((c) => c.type === 'commitDraw').length, reply: result2.reply.slice(0, 80) }));
}

console.log(failures === 0 ? `RESULT: PASS (${checks} checks)` : `RESULT: FAIL (${failures}/${checks} checks)`);
process.exit(failures === 0 ? 0 : 2);
