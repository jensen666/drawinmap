/**
 * 多对象请求正确性测试（方案 2026-11-05 §4.2/§4.3）。
 *
 * 覆盖三条硬要求：
 * 1. 参考通道只命中**部分**请求对象时，不得单候选自动规划——
 *    必须明确列出已命中与缺失对象并追问；
 * 2. 全部命中且复合目标合法时，生成 multi-part 目标并正常规划；
 * 3. 交付前核对「请求对象 = 实际交付对象」：缺对象不硬画、不承诺。
 *
 * 运行：node test/controller-multi-object.mjs
 */

import { createAgentController } from '../web/src/agent/controller.js';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertSvg } from '../web/src/reference/convert.js';
import { sha256NormalizedText } from '../web/src/reference/hash.js';
import { acceptReferenceTarget } from '../web/src/agent/target-acceptance.js';
import { composeMultiPartShape } from '../web/src/agent/composite-shape.js';
import { placeConfig } from './fixtures/place-config.mjs';

let failures = 0;
let checks = 0;
function check(label, condition, detail = '') {
  checks += 1;
  if (!condition) {
    failures += 1;
  }
  console.log(`[check] ${label} -> ${condition ? 'PASS' : `FAIL ${detail}`}`);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(root, 'web/data/shapes');
const manifest = JSON.parse(readFileSync(resolve(dataDir, 'manifest.json'), 'utf8'));

/** 造一个"参考素材候选"（含归一化 customShape 与审核信息） */
function makeCandidate(zhName, assetId) {
  const asset = manifest.assets.find((item) => item.id === assetId);
  const svgText = readFileSync(resolve(dataDir, asset.file), 'utf8');
  const conversion = convertSvg(svgText);
  const customShape = {
    name: zhName,
    constraintPoints: conversion.T.points.filter((_, index) => index % 8 === 0),
    outlinePoints: conversion.T.points,
    parts: [],
    features: [],
  };
  return {
    asset: { ...asset, displayName: zhName },
    customShape,
    conversion: { status: conversion.status, T: conversion.T, metrics: conversion.metrics ?? null },
    matchedAlias: zhName,
    origin: 'local',
    reviewStatus: 'curated',
    // 与生产链路同口径：实际下载内容的归一化哈希（审核绑定素材版本）
    sourceSha256: sha256NormalizedText(svgText),
    contentHash: `hash-${assetId}`,
  };
}

const HORSE = makeCandidate('马', 'horse-phylopic');
const DOG = makeCandidate('狗', 'dog-phylopic');

/** 构造参考候选源（可控命中集合） */
function makeReferenceSource(groups) {
  return {
    async resolveLocalCandidates() {
      return {
        status: groups.length > 1 ? 'multi' : 'ok',
        origin: 'local',
        candidates: groups.flatMap((group) => group.candidates),
        failures: [],
        objectGroups: groups.map((group) => ({
          objectKey: group.objectName,
          objectName: group.objectName,
          aliases: group.aliases ?? [],
          candidates: group.candidates,
          failures: [],
          candidateCount: group.candidates.length,
        })),
        objects: groups.map((group) => group.objectName),
        poolSize: groups.length,
        attempts: [],
        error: null,
      };
    },
    async resolveOnlineCandidates() {
      return { status: 'miss', origin: 'online', candidates: [], failures: [], poolSize: 0, attempts: [] };
    },
    async resolveCandidates() {
      return { status: 'miss', origin: 'local', candidates: [], failures: [], poolSize: 0, attempts: [] };
    },
  };
}

/** mock 引擎 */
function makeEngine(planResult) {
  const calls = [];
  return {
    calls,
    plan: async (options) => {
      calls.push({ type: 'plan', options });
      return planResult;
    },
    recommend: async () => ({ status: 'failed' }),
    commitDraw: (result, options) => calls.push({ type: 'commitDraw', result, options }),
    clearDraw: () => calls.push({ type: 'clearDraw' }),
    formatMinutes: (minutes) => `${Math.round(minutes)} 分钟`,
  };
}

/** 达标的一次规划结果 */
function makePlanned() {
  const result = {
    shapeName: '马+狗',
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
      featureCount: 0,
      featureCoveredCount: 0,
      featureCoverage: 1,
      frechetMaxRatio: 0.1,
      aspectDistortionRatio: 0.1,
      featureGapRetainRatio: 1,
    },
  };
  return {
    status: 'ok',
    result,
    best: {
      result,
      score: 78,
      adjustedScore: 78,
      sizeMeters: 1200,
      rotationDeg: 0,
      center: { lat: 23.12, lng: 113.32 },
    },
    offset: { meters: 0, text: '' },
    stage: 1,
    stageLabel: '近场搜索',
    triedCount: 100,
    alternatives: [],
  };
}

/** LLM 意图队列 */
let intentQueue = [];
globalThis.fetch = async (url, options) => {
  if (typeof url === 'string' && url.includes('/data/guangzhou-roads.json')) {
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ roads: [] }) };
  }
  const system = JSON.parse(options.body).messages?.[0]?.content || '';
  let payload;
  if (system.includes('质检员')) {
    payload = { verdict: 'like', seen: 'ok', issues: [] };
  } else {
    payload = intentQueue.shift() ?? { action: 'chat', reply: '收到' };
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

const map = { getCenter: () => ({ lat: 23.12, lng: 113.32 }) };

async function runTurn({ text, intent, groups, planResult = makePlanned() }) {
  intentQueue = [intent];
  const engine = makeEngine(planResult);
  const controller = createAgentController({
    map,
    engine,
    placeConfig,
    referenceSource: makeReferenceSource(groups),
    shapeReviewDeps: { renderOutline: () => 'data:image/png;base64,FAKE' },
  });
  const result = await controller.send({ text });
  return { result, calls: engine.calls };
}

const MULTI_INTENT = {
  action: 'plan',
  shape: null,
  customShape: null,
  place: '广州塔',
  rotationDeg: null,
  reply: '好的，我给你画一匹马和一只狗',
  requestObjects: [{ name: '马' }, { name: '狗' }],
};

// ---------- 场景 1：部分命中 → 不得单候选自动规划 ----------
{
  const { result, calls } = await runTurn({
    text: '在广州塔画一匹马和一只狗',
    intent: MULTI_INTENT,
    groups: [{ objectName: '马', aliases: ['马匹'], candidates: [HORSE] }],
  });
  const plans = calls.filter((call) => call.type === 'plan');
  const commits = calls.filter((call) => call.type === 'commitDraw');
  check('部分命中：不调用路网引擎', plans.length === 0, `plan ${plans.length}`);
  check('部分命中：不交付任何图形', commits.length === 0, `commit ${commits.length}`);
  check('部分命中：回复列出已命中对象', result.reply.includes('马'), result.reply.slice(0, 200));
  check('部分命中：回复列出缺失对象', result.reply.includes('狗'), result.reply.slice(0, 200));
  check('部分命中：回复明确追问怎么办', /还是|怎么办|重新找|先只画/.test(result.reply), result.reply.slice(0, 240));
  check('部分命中：不承诺已规划', !result.reply.includes('已规划'), result.reply.slice(0, 200));
}

// ---------- 场景 2：全部命中 → 组合 multi-part 目标并规划 ----------
{
  const { result, calls } = await runTurn({
    text: '在广州塔画一匹马和一只狗',
    intent: MULTI_INTENT,
    groups: [
      { objectName: '马', aliases: ['马匹'], candidates: [HORSE] },
      { objectName: '狗', aliases: ['小狗'], candidates: [DOG] },
    ],
  });
  const plans = calls.filter((call) => call.type === 'plan');
  const commits = calls.filter((call) => call.type === 'commitDraw');
  check('全部命中：调用路网引擎一次', plans.length === 1, `plan ${plans.length}`);
  check('全部命中：交付绿线', commits.length === 1 && !commits[0].options?.reference, `commit ${commits.length}`);
  const plannedShape = plans[0]?.options?.customShape ?? null;
  check('全部命中：目标是 2 部分 multi-part', plannedShape?.parts?.length === 2, JSON.stringify(plannedShape?.parts?.map((part) => part.name)));
  check(
    '全部命中：部分名对应两个对象',
    (plannedShape?.parts ?? []).map((part) => part.name).join(',') === '马,狗',
    JSON.stringify(plannedShape?.parts?.map((part) => part.name)),
  );
  check('全部命中：回复承诺的对象都交付了', result.reply.includes('马') && result.reply.includes('狗'), result.reply.slice(0, 200));
}

// ---------- 场景 2.5：复合目标逐部分过审（真实素材哈希绑定） ----------
{
  const composed = composeMultiPartShape([
    { name: '马', points: HORSE.conversion.T.points },
    { name: '狗', points: DOG.conversion.T.points },
  ]);
  check('复合目标：组合成功', composed.ok === true, composed.reason ?? '');
  if (composed.ok) {
    const referenceSource = {
      id: 'composite:horse-phylopic+dog-phylopic',
      name: '马+狗',
      origin: 'local',
      reviewStatus: 'curated',
      composite: true,
      parts: [
        {
          name: '马',
          assetId: 'horse-phylopic',
          origin: 'local',
          reviewStatus: 'curated',
          sourceSha256: HORSE.sourceSha256,
          review: HORSE.asset.review,
        },
        {
          name: '狗',
          assetId: 'dog-phylopic',
          origin: 'local',
          reviewStatus: 'curated',
          sourceSha256: DOG.sourceSha256,
          review: DOG.asset.review,
        },
      ],
    };
    const acceptance = acceptReferenceTarget(composed.customShape, referenceSource);
    check(
      '复合目标：逐部分审核绑定通过（真实素材哈希）',
      acceptance.verdict === 'pass',
      JSON.stringify(acceptance.reasons),
    );
    // 任一部分审核缺失 → 整体不合格（不得用任一部分代表整体）
    const broken = acceptReferenceTarget(composed.customShape, {
      ...referenceSource,
      parts: [referenceSource.parts[0], { ...referenceSource.parts[1], review: null }],
    });
    check('复合目标：任一部分缺审核 → 整体不合格', broken.verdict === 'fail', JSON.stringify(broken.reasons));
  }
}

// ---------- 场景 3：交付前核对——请求 2 个对象但只交付 1 个 → 阻塞交付 ----------
{
  const singleObjectIntent = {
    action: 'plan',
    shape: null,
    customShape: {
      name: '马',
      points: [[-0.4, -0.4], [0.4, -0.4], [0.4, 0.4], [-0.4, 0.4]],
    },
    place: '广州塔',
    rotationDeg: null,
    reply: '好的，我给你画了马和狗',
    requestObjects: [{ name: '马' }, { name: '狗' }],
  };
  const { result, calls } = await runTurn({
    text: '在广州塔画一匹马和一只狗',
    intent: singleObjectIntent,
    groups: [{ objectName: '马', aliases: ['马匹'], candidates: [HORSE] }],
  });
  const plans = calls.filter((call) => call.type === 'plan');
  const commits = calls.filter((call) => call.type === 'commitDraw');
  check('交付核对：缺对象时不调用引擎', plans.length === 0, `plan ${plans.length}`);
  check('交付核对：缺对象时不交付', commits.length === 0, `commit ${commits.length}`);
  check('交付核对：回复不含 LLM 的未兑现承诺', !result.reply.includes('我给你画了马和狗'), result.reply.slice(0, 200));
  check('交付核对：回复说明缺哪个对象', result.reply.includes('狗'), result.reply.slice(0, 240));
}

// ---------- 场景 4：逐对象匹配（缺陷清单 2026-11-06 Bug 4.3.4.2） ----------
// 「画猫和兔子」类请求：整段原文扫描的词边界对"单字别名 + 连词"失效（旧缺陷：
// 只有兔子命中 → 部分命中追问，多对象能力实际不可用）。意图层已给出
// requestObjects 清单，controller 现按清单逐对象匹配——猫、兔子都必须命中并复合交付。
{
  const CAT = makeCandidate('猫', 'cat-phylopic');
  const RABBIT = makeCandidate('兔', 'rabbit');
  const multiIntentCatRabbit = { ...MULTI_INTENT, reply: '好的，我给你画一只猫和一只兔子', requestObjects: [{ name: '猫' }, { name: '兔子' }] };

  // 旧整段扫描源：只命中兔子（复现旧缺陷行为）
  const wholeTextOnly = {
    async resolveLocalCandidates() {
      return { status: 'ok', origin: 'local', candidates: [RABBIT], failures: [], poolSize: 1, attempts: [] };
    },
    async resolveOnlineCandidates() {
      return { status: 'miss', origin: 'online', candidates: [], failures: [], poolSize: 0, attempts: [] };
    },
    async resolveCandidates() {
      return { status: 'miss', origin: 'local', candidates: [], failures: [], poolSize: 0, attempts: [] };
    },
  };
  const engineOld = makeEngine(makePlanned());
  const controllerOld = createAgentController({
    map,
    engine: engineOld,
    placeConfig,
    referenceSource: wholeTextOnly,
    shapeReviewDeps: { renderOutline: () => 'data:image/png;base64,FAKE' },
  });
  intentQueue = [multiIntentCatRabbit];
  const oldResult = await controllerOld.send({ text: '在花城广场画猫和兔子' });
  check(
    '逐对象缺位（旧链路）：只命中兔子 → 部分命中追问（不硬画单对象）',
    engineOld.calls.filter((call) => call.type === 'plan').length === 0 && oldResult.reply.includes('猫'),
    JSON.stringify({ plans: engineOld.calls.filter((c) => c.type === 'plan').length, reply: oldResult.reply.slice(0, 120) }),
  );

  // 逐对象匹配源：猫、兔子都命中（整段扫描仍只命中兔子——模拟旧词边界缺陷仍在）
  const perObjectSource = {
    async resolveLocalCandidatesForObjects(objects) {
      const names = objects.map((item) => item?.name);
      const groups = [];
      if (names.includes('猫')) groups.push({ objectKey: '猫', objectName: '猫', aliases: ['猫'], candidates: [CAT], failures: [], candidateCount: 1 });
      if (names.includes('兔子')) groups.push({ objectKey: '兔子', objectName: '兔子', aliases: ['兔'], candidates: [RABBIT], failures: [], candidateCount: 1 });
      if (groups.length === 0) {
        return { status: 'miss', origin: 'local', candidates: [], failures: [], objectGroups: [], objects: [], poolSize: 0, attempts: [], error: null };
      }
      return {
        status: 'multi',
        origin: 'local',
        candidates: groups.flatMap((group) => group.candidates),
        failures: [],
        objectGroups: groups,
        objects: groups.map((group) => group.objectName),
        rawCount: groups.length,
        poolSize: groups.length,
        attempts: [],
        reason: 'multi-object',
        error: null,
      };
    },
    async resolveLocalCandidates() {
      // 整段扫描仍是旧缺陷行为：单字"猫"被连词吞词，只有兔子命中
      return { status: 'ok', origin: 'local', candidates: [RABBIT], failures: [], poolSize: 1, attempts: [] };
    },
    async resolveOnlineCandidates() {
      return { status: 'miss', origin: 'online', candidates: [], failures: [], poolSize: 0, attempts: [] };
    },
    async resolveCandidates() {
      return { status: 'miss', origin: 'local', candidates: [], failures: [], poolSize: 0, attempts: [] };
    },
  };
  const engineNew = makeEngine(makePlanned());
  const controllerNew = createAgentController({
    map,
    engine: engineNew,
    placeConfig,
    referenceSource: perObjectSource,
    shapeReviewDeps: { renderOutline: () => 'data:image/png;base64,FAKE' },
  });
  intentQueue = [multiIntentCatRabbit];
  const newResult = await controllerNew.send({ text: '在花城广场画猫和兔子' });
  const plansNew = engineNew.calls.filter((call) => call.type === 'plan');
  const plannedShape = plansNew[0]?.options?.customShape ?? null;
  check('逐对象匹配：全部命中 → 调用引擎规划（不再是部分命中追问）', plansNew.length === 1, JSON.stringify({ plans: plansNew.length, reply: newResult.reply.slice(0, 120) }));
  check(
    '逐对象匹配：复合目标包含两个对象（猫 + 兔）',
    (plannedShape?.parts ?? []).map((part) => part.name).sort().join(',') === '兔子,猫',
    JSON.stringify(plannedShape?.parts?.map((part) => part.name)),
  );
  check('逐对象匹配：回复提及两个对象', newResult.reply.includes('猫') && newResult.reply.includes('兔子'), newResult.reply.slice(0, 160));
}

if (failures > 0) {
  console.error(`\nFAILED: ${failures}/${checks} 项未通过`);
  process.exitCode = 1;
} else {
  console.log(`\nPASS: controller-multi-object 全部断言通过（${checks} 项）`);
}
