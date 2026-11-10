/**
 * 尺寸轴双闸专项确定性测试（方案 2026-11-01 §12.1）。
 *
 * 覆盖五组断言：
 * - A 组：裁决原语（形状绝对误差包络 / 基线—候选集裁决 / 最大胜出档 / 偏移复检）——
 *   纯函数；候选的路线与指标全部来自**真实规划结果**，只覆盖被裁决的三项米制误差
 *   与分数，不伪造路线几何；
 * - B 组：定向大档补搜（真实路网 mapdata/guangzhou-roads.json 真实规划，不是 mock）；
 * - C 组：胜出大档的精修复检与回退链（控制流：refine/joint 注入受控结果，
 *   候选的路线指标仍取自真实规划结果）；
 * - D 组：大档阶段的触发条件（allowEnlarge / 合格基线 / 预算 / 用户停止）；
 * - E 组：端到端（真实路网尽力链）与可复现性、同几何换名称不变性。
 *
 * 运行：node test/double-gate.mjs
 */

import { GUANGZHOU_ROADS_HINT, readRequiredText } from './lib/require-data.mjs';
import {
  buildEdgeIndex,
  buildWalkGraph,
  distanceMeters,
  findLargestComponent,
} from '../web/src/engine/graph.js';
import { planShapeRoute } from '../web/src/engine/planner.js';
import { meetsQualityBar, scoreRoute } from '../web/src/engine/quality.js';
import { searchWithEscalation } from '../web/src/engine/candidates.js';
import { runLargeTierStage } from './lib/large-tier-stage.js';
import {
  LARGE_TIER_SIZE_FACTORS,
  adjudicateLargeTiers,
  candidateEvaluationKey,
  finalizeLargeTier,
  probeLargeTiers,
  targetIdentityOf,
} from './lib/large-tier.js';
import {
  SHAPE_ENVELOPE_FIELDS,
  evaluateChallenger,
  selectLargestWinner,
  shapeErrorEnvelopeMeters,
  verifyRefinedCandidate,
} from '../web/src/engine/shape-envelope.js';

let failures = 0;
let checks = 0;

/**
 * 断言工具：记录通过/失败计数（失败必须在退出码体现）。
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

const roads = JSON.parse(
  readRequiredText(new URL('../mapdata/guangzhou-roads.json', import.meta.url), GUANGZHOU_ROADS_HINT),
).roads;
const graph = buildWalkGraph(roads);
const edgeIndex = buildEdgeIndex(graph, 0.005, findLargestComponent(graph));
console.log(`[graph] 节点 ${graph.nodeCount} / 边 ${graph.edgeCount}`);

/**
 * 找一个真实通过质量门的规划结果：裁决测试的路线与指标来源。
 * 质量门用真实指标判定（不是放宽门槛），因此候选必须真的画得出来。
 *
 * @returns {object|null} 真实规划结果
 */
function findPassingResult() {
  const centers = [
    { lat: 23.12742529644269, lng: 113.27530907989502 },
    { lat: 23.1212, lng: 113.2841 },
    { lat: 23.1259, lng: 113.3245 },
  ];
  const sizes = [1350, 1200, 1500, 1000, 900, 1800];
  const rotations = [0, 30, 15];
  for (const center of centers) {
    for (const sizeMeters of sizes) {
      for (const rotationDeg of rotations) {
        try {
          const result = planShapeRoute({
            graph,
            edgeIndex,
            shapeKey: 'heart',
            center,
            sizeMeters,
            rotationDeg,
          });
          if (meetsQualityBar(result.metrics)) {
            return result;
          }
        } catch {
          // 该落点无路属常态，继续换组合
        }
      }
    }
  }
  return null;
}

const PASSING = findPassingResult();
if (!PASSING) {
  console.log('[fatal] 找不到真实通过质量门的规划结果，双闸测试无法进行');
  process.exitCode = 1;
} else {
  console.log(
    `[real] 通过质量门的真实规划：尺寸 ${PASSING.sizeMeters}m 朝向 ${PASSING.rotationDeg}° ` +
      `分 ${scoreRoute(PASSING.metrics)} 中心 ${PASSING.center.lat},${PASSING.center.lng}`,
  );
}

/** 请求中心：与基线中心错开，才能测出"偏移持平/更近/更远"三种情形 */
const ORIGIN = {
  lat: PASSING.center.lat + 0.002,
  lng: PASSING.center.lng,
};

/**
 * 构造受控候选：路线与指标取自真实规划结果，只覆盖被裁决的三项米制误差与分数，
 * 其余质量门字段保持真实值（质量门判定仍由真实指标驱动）。
 *
 * @param {object} options 覆盖项
 * @returns {object} 候选
 */
function controlledCandidate({
  score,
  outlineMax,
  routeMax,
  frechetMax,
  center = PASSING.center,
  sizeMeters = 900,
  targetHash = 'hash-a',
  order = 0,
}) {
  const metrics = {
    ...PASSING.metrics,
    orderedOutlineMaxMeters: outlineMax,
    orderedRouteMaxMeters: routeMax,
    frechetMaxMeters: frechetMax,
  };
  return {
    result: { ...PASSING, metrics },
    metrics,
    score,
    center,
    sizeMeters,
    rotationDeg: PASSING.rotationDeg,
    targetHash,
    order,
  };
}

/** 真实基线候选：分数与指标都来自真实规划 */
function realBaseline() {
  return {
    result: PASSING,
    metrics: PASSING.metrics,
    score: scoreRoute(PASSING.metrics),
    center: PASSING.center,
    sizeMeters: PASSING.sizeMeters,
    rotationDeg: PASSING.rotationDeg,
    targetHash: 'hash-a',
    order: 0,
  };
}

// ---------- A 组：裁决原语（纯函数） ----------
{
  const baseline = realBaseline();
  // 包络只含三项米制指标：吸附/关键点/特征偏差不得并入
  check(
    'envelope_fields_only_three',
    SHAPE_ENVELOPE_FIELDS.length === 3 &&
      SHAPE_ENVELOPE_FIELDS.includes('orderedOutlineMaxMeters') &&
      SHAPE_ENVELOPE_FIELDS.includes('orderedRouteMaxMeters') &&
      SHAPE_ENVELOPE_FIELDS.includes('frechetMaxMeters') &&
      !SHAPE_ENVELOPE_FIELDS.includes('snapMaxMeters') &&
      !SHAPE_ENVELOPE_FIELDS.includes('keyMaxOffsetMeters'),
    JSON.stringify(SHAPE_ENVELOPE_FIELDS),
  );
  check(
    'envelope_value_is_max_of_three',
    shapeErrorEnvelopeMeters(PASSING.metrics) ===
      Math.max(
        PASSING.metrics.orderedOutlineMaxMeters,
        PASSING.metrics.orderedRouteMaxMeters,
        PASSING.metrics.frechetMaxMeters,
      ),
  );
  // 缺失 / 非有限 → null（不得缺省放行）
  check(
    'envelope_missing_is_null',
    shapeErrorEnvelopeMeters({ ...PASSING.metrics, frechetMaxMeters: undefined }) === null,
  );
  check(
    'envelope_non_finite_is_null',
    shapeErrorEnvelopeMeters({ ...PASSING.metrics, orderedRouteMaxMeters: Infinity }) === null,
  );
  // 吸附/关键点/特征偏差不得影响包络
  const perturbed = {
    ...PASSING.metrics,
    snapMaxMeters: PASSING.metrics.snapMaxMeters + 30,
    keyMaxOffsetMeters: PASSING.metrics.keyMaxOffsetMeters + 30,
    featureMaxOffsetMeters: PASSING.metrics.featureMaxOffsetMeters + 30,
  };
  check(
    'envelope_ignores_snap_key_feature',
    shapeErrorEnvelopeMeters(perturbed) === shapeErrorEnvelopeMeters(PASSING.metrics),
  );

  // §12.1：基线 72/57m，两个大档 73/55m 与 74/56m → 都进胜出集，选更大的后者
  const fixedBaseline = controlledCandidate({
    score: 72,
    outlineMax: 57,
    routeMax: 40,
    frechetMax: 30,
  });
  const tierA = controlledCandidate({
    score: 73,
    outlineMax: 55,
    routeMax: 40,
    frechetMax: 30,
    sizeMeters: 2000,
    order: 0,
  });
  const tierB = controlledCandidate({
    score: 74,
    outlineMax: 56,
    routeMax: 40,
    frechetMax: 30,
    sizeMeters: 2500,
    order: 1,
  });
  const verdictA = evaluateChallenger({
    challenger: tierA,
    baseline: fixedBaseline,
    origin: ORIGIN,
  });
  const verdictB = evaluateChallenger({
    challenger: tierB,
    baseline: fixedBaseline,
    origin: ORIGIN,
  });
  check(
    'winner_set_accepts_both',
    verdictA.accepted && verdictB.accepted,
    `${verdictA.reason}/${verdictB.reason}`,
  );
  // "包络最大值不劣"而非"任一字段变差即否决"：tierB 的 56m 比 tierA 的 55m 差，
  // 但各自相对基线 57m 都不劣，因此两者都能进胜出集
  check('envelope_uses_max_not_per_field', verdictB.accepted && verdictB.envelope === 56);
  const selected = selectLargestWinner([{ ...tierA, order: 0 }, { ...tierB, order: 1 }]);
  check(
    'largest_winner_selected',
    selected && selected.sizeMeters === 2500,
    selected ? String(selected.sizeMeters) : 'null',
  );
  // 中间档不得卡住更大的好档：颠倒输入顺序，结果仍是更大档
  const selectedReordered = selectLargestWinner([{ ...tierB, order: 1 }, { ...tierA, order: 0 }]);
  check(
    'largest_winner_not_blocked_by_middle',
    selectedReordered && selectedReordered.sizeMeters === 2500,
  );

  // 分数不高于基线 / 包络大于基线 → 不进胜出集
  const lowerScore = controlledCandidate({
    score: 71,
    outlineMax: 50,
    routeMax: 40,
    frechetMax: 30,
  });
  const worseEnvelope = controlledCandidate({
    score: 90,
    outlineMax: 90,
    routeMax: 40,
    frechetMax: 30,
  });
  check(
    'lower_score_rejected',
    !evaluateChallenger({ challenger: lowerScore, baseline: fixedBaseline, origin: ORIGIN }).accepted,
  );
  check(
    'worse_envelope_rejected',
    !evaluateChallenger({ challenger: worseEnvelope, baseline: fixedBaseline, origin: ORIGIN }).accepted,
  );
  // 指标缺失 / 非有限 / 跨版本（哈希不一致）→ 同样不得进入
  const missingMetrics = { ...tierA, metrics: null, result: { metrics: null } };
  check(
    'missing_metrics_rejected',
    !evaluateChallenger({ challenger: missingMetrics, baseline: fixedBaseline, origin: ORIGIN }).accepted,
  );
  const nonFinite = controlledCandidate({
    score: 90,
    outlineMax: NaN,
    routeMax: 40,
    frechetMax: 30,
  });
  check(
    'non_finite_envelope_rejected',
    !evaluateChallenger({ challenger: nonFinite, baseline: fixedBaseline, origin: ORIGIN }).accepted,
  );
  const crossVersion = controlledCandidate({
    score: 90,
    outlineMax: 40,
    routeMax: 40,
    frechetMax: 30,
    targetHash: 'hash-b',
  });
  check(
    'cross_version_rejected',
    !evaluateChallenger({ challenger: crossVersion, baseline: fixedBaseline, origin: ORIGIN }).accepted,
  );
  // 空/非法输入不产生 NaN 崩溃，直接拒绝
  const garbage = evaluateChallenger({ challenger: null, baseline: null, origin: null });
  check(
    'invalid_input_rejected_cleanly',
    garbage.accepted === false && typeof garbage.reason === 'string',
    JSON.stringify(garbage),
  );

  // 偏移复检：分数更高、包络不劣，但偏移大于基线 → 拒绝
  const baselineOffset = distanceMeters(
    ORIGIN.lat,
    ORIGIN.lng,
    PASSING.center.lat,
    PASSING.center.lng,
  );
  const farther = controlledCandidate({
    score: 90,
    outlineMax: 40,
    routeMax: 40,
    frechetMax: 30,
    center: { lat: PASSING.center.lat + 0.005, lng: PASSING.center.lng },
  });
  const offsetVerdict = verifyRefinedCandidate({
    candidate: farther,
    baseline: fixedBaseline,
    origin: ORIGIN,
  });
  check(
    'offset_farther_rejected',
    offsetVerdict.accepted === false && offsetVerdict.reason === 'offset-farther',
    offsetVerdict.reason,
  );
  check(
    'offset_farther_is_actually_farther',
    distanceMeters(ORIGIN.lat, ORIGIN.lng, farther.center.lat, farther.center.lng) > baselineOffset,
  );
  const sameCenter = controlledCandidate({
    score: 90,
    outlineMax: 40,
    routeMax: 40,
    frechetMax: 30,
    center: PASSING.center,
  });
  const sameOffsetVerdict = verifyRefinedCandidate({
    candidate: sameCenter,
    baseline: fixedBaseline,
    origin: ORIGIN,
  });
  check('offset_equal_accepted', sameOffsetVerdict.accepted === true, sameOffsetVerdict.reason);
  const nearer = controlledCandidate({
    score: 90,
    outlineMax: 40,
    routeMax: 40,
    frechetMax: 30,
    center: { lat: PASSING.center.lat + 0.001, lng: PASSING.center.lng },
  });
  const nearerVerdict = verifyRefinedCandidate({
    candidate: nearer,
    baseline: fixedBaseline,
    origin: ORIGIN,
  });
  check('offset_nearer_accepted', nearerVerdict.accepted === true, nearerVerdict.reason);
}

// ---------- B 组：定向补搜与去重（真实路网） ----------
{
  const baseline = realBaseline();
  const baseSizeMeters = 900;
  const evaluatedKeys = new Set();
  const targetHash = targetIdentityOf({ shapeKey: 'heart' });
  const probe = await probeLargeTiers({
    graph,
    edgeIndex,
    shapeKey: 'heart',
    origin: ORIGIN,
    baseSizeMeters,
    baseline,
    targetHash,
    evaluatedKeys,
    maxCandidates: 2200,
  });
  // 补搜候选：中心/朝向与近场基线一致，尺寸是原始基准的 2×/2.5×/3×
  check(
    'probe_uses_baseline_center_and_rotation',
    probe.challengers.length > 0 &&
      probe.challengers.every(
        (item) =>
          item.center.lat === baseline.center.lat &&
          item.center.lng === baseline.center.lng &&
          item.rotationDeg === baseline.rotationDeg,
      ),
    String(probe.challengers.length),
  );
  check(
    'probe_sizes_are_original_base_multiples',
    probe.challengers.length > 0 &&
      LARGE_TIER_SIZE_FACTORS.every((factor) =>
        probe.challengers.some((item) => item.sizeMeters === Math.round(baseSizeMeters * factor)),
      ),
    JSON.stringify(probe.challengers.map((item) => item.sizeMeters)),
  );
  check(
    'probe_at_most_three_evaluations',
    probe.challengers.length <= 3,
    String(probe.challengers.length),
  );
  check(
    'probe_uses_real_routes',
    probe.challengers.some((item) => item.result.metrics.routeMeters > 0) &&
      probe.challengers.every(
        (item) =>
          !Array.isArray(item.result.routeLatLngs) ||
          item.result.routeLatLngs.length < 2 ||
          item.result.metrics.routeMeters > 0,
      ),
    JSON.stringify(probe.challengers.map((item) => item.result.metrics.routeMeters)),
  );
  // 重复键只评价一次
  const probeAgain = await probeLargeTiers({
    graph,
    edgeIndex,
    shapeKey: 'heart',
    origin: ORIGIN,
    baseSizeMeters,
    baseline,
    targetHash,
    evaluatedKeys,
    maxCandidates: 2200,
  });
  check(
    'probe_dedup_skips_evaluated',
    probeAgain.challengers.length === 0 && probeAgain.skipped.length === probe.challengers.length,
    `${probeAgain.challengers.length}/${probeAgain.skipped.length}`,
  );
  // 去重键含"目标哈希 + 中心 + 朝向 + 尺寸"
  const key = candidateEvaluationKey({
    targetHash,
    center: baseline.center,
    rotationDeg: baseline.rotationDeg,
    sizeMeters: 1800,
  });
  check('dedup_key_shape', key.split('|').length === 5 && key.startsWith(targetHash));

  // 裁决：所有挑战者与同一个基线比较（基线在比较期间不变）
  const adjudication = adjudicateLargeTiers({
    baseline,
    challengers: probe.challengers,
    origin: ORIGIN,
  });
  check(
    'adjudication_same_baseline',
    adjudication.evaluations.every(
      (item) =>
        item.baselineScore === baseline.score &&
        item.baselineEnvelope === shapeErrorEnvelopeMeters(baseline.metrics),
    ),
  );
  check(
    'adjudication_winner_subset_of_challengers',
    adjudication.winners.every((winner) =>
      probe.challengers.some(
        (item) => item.sizeMeters === winner.sizeMeters && item.score === winner.score,
      ),
    ),
  );
  // 可复现：同样的输入重跑一次补搜，结果完全一致
  const probeRepeat = await probeLargeTiers({
    graph,
    edgeIndex,
    shapeKey: 'heart',
    origin: ORIGIN,
    baseSizeMeters,
    baseline,
    targetHash,
    evaluatedKeys: new Set(),
    maxCandidates: 2200,
  });
  check(
    'probe_reproducible',
    probeRepeat.challengers.length === probe.challengers.length &&
      probeRepeat.challengers.every(
        (item, index) =>
          item.sizeMeters === probe.challengers[index].sizeMeters &&
          item.score === probe.challengers[index].score,
      ),
  );
}

// ---------- C 组：胜出大档精修复检与回退链 ----------
{
  const baseline = realBaseline();
  const coarse = controlledCandidate({
    score: baseline.score + 2,
    outlineMax: 10,
    routeMax: 10,
    frechetMax: 10,
    sizeMeters: 1800,
    order: 0,
  });

  // C1：胜出档只精修一次（不为三个大档分别精修）
  let refineCalls = 0;
  const refinedOnce = await finalizeLargeTier({
    baseline,
    selected: coarse,
    origin: ORIGIN,
    refine: async (base) => {
      refineCalls += 1;
      return { best: base, candidateCount: 1, expandedNodes: 0 };
    },
    joint: null,
    canRefine: () => true,
  });
  check('refine_called_exactly_once', refineCalls === 1, String(refineCalls));
  check(
    'refine_unchanged_keeps_coarse_winner',
    refinedOnce.final.sizeMeters === 1800 && refinedOnce.replaced === true,
  );

  // C2：精修结果分数更高、包络不劣、但偏移更远 → 回退到精修前已验证大档
  const farther = controlledCandidate({
    score: baseline.score + 9,
    outlineMax: 10,
    routeMax: 10,
    frechetMax: 10,
    center: { lat: PASSING.center.lat + 0.005, lng: PASSING.center.lng },
    sizeMeters: 1800,
  });
  const rolledBack = await finalizeLargeTier({
    baseline,
    selected: coarse,
    origin: ORIGIN,
    refine: async () => ({ best: farther, candidateCount: 1, expandedNodes: 0 }),
    joint: null,
    canRefine: () => true,
  });
  check(
    'offset_rollback_to_pre_refine',
    rolledBack.final.sizeMeters === 1800 &&
      rolledBack.final.center.lat === coarse.center.lat &&
      rolledBack.notes.some((note) => note.startsWith('refine-rejected:offset-farther')),
    JSON.stringify(rolledBack.notes),
  );
  check(
    'offset_rollback_same_center_as_baseline',
    distanceMeters(
      ORIGIN.lat,
      ORIGIN.lng,
      rolledBack.final.center.lat,
      rolledBack.final.center.lng,
    ) ===
      distanceMeters(ORIGIN.lat, ORIGIN.lng, coarse.center.lat, coarse.center.lng),
  );

  // C3：精修结果通过三项复检 → 采用精修结果
  const nearer = controlledCandidate({
    score: baseline.score + 9,
    outlineMax: 10,
    routeMax: 10,
    frechetMax: 10,
    center: { lat: PASSING.center.lat + 0.001, lng: PASSING.center.lng },
    sizeMeters: 1800,
  });
  const acceptedRefine = await finalizeLargeTier({
    baseline,
    selected: coarse,
    origin: ORIGIN,
    refine: async () => ({ best: nearer, candidateCount: 1, expandedNodes: 0 }),
    joint: null,
    canRefine: () => true,
  });
  check(
    'refine_accepted_when_all_three_pass',
    acceptedRefine.replaced === true &&
      acceptedRefine.final.center.lat === nearer.center.lat &&
      acceptedRefine.notes.length === 0,
    JSON.stringify(acceptedRefine.notes),
  );

  // C4：联合精修未过同一复检 → 回退到最近一个已验证版本（精修通过的那版）
  // 联合精修不改中心/尺寸（joint-refine 的既有语义），因此它的复检失败通常来自
  // 分数或形状包络：这里用"包络变糟"的联合结果触发回退。
  const jointBad = controlledCandidate({
    score: baseline.score + 20,
    outlineMax: 500,
    routeMax: 10,
    frechetMax: 10,
    center: nearer.center,
    sizeMeters: 1800,
  });
  const jointRollback = await finalizeLargeTier({
    baseline,
    selected: coarse,
    origin: ORIGIN,
    refine: async () => ({ best: nearer, candidateCount: 1, expandedNodes: 0 }),
    joint: async () => ({
      improved: true,
      best: { result: jointBad.result, score: jointBad.score, metrics: jointBad.metrics },
      evaluated: 1,
      expandedNodes: 0,
    }),
    canRefine: () => true,
  });
  check(
    'joint_rollback_to_last_verified',
    jointRollback.final.center.lat === nearer.center.lat &&
      jointRollback.notes.some((note) => note.startsWith('joint-rejected:')),
    JSON.stringify(jointRollback.notes),
  );

  // C5：根本没有执行胜出档精修（预算耗尽/用户停止）→ 保留近场基线
  const notExecuted = await finalizeLargeTier({
    baseline,
    selected: coarse,
    origin: ORIGIN,
    refine: async () => {
      throw new Error('精修不应被调用');
    },
    joint: null,
    canRefine: () => false,
  });
  check(
    'no_refine_keeps_baseline',
    notExecuted.replaced === false &&
      notExecuted.final.sizeMeters === baseline.sizeMeters &&
      notExecuted.notes.includes('refine-not-executed'),
    JSON.stringify(notExecuted.notes),
  );
}

// ---------- D 组：大档阶段的触发条件 ----------
{
  const baseline = { ...realBaseline(), targetHash: targetIdentityOf({ shapeKey: 'heart' }) };
  const baseSizeMeters = 900;
  const common = {
    graph,
    edgeIndex,
    shapeKey: 'heart',
    customShape: null,
    center: ORIGIN,
    baseSizeMeters,
    baseline,
    allowEnlarge: true,
    deadline: null,
    maxCandidates: 2200,
    signal: null,
    onProgress: undefined,
    evaluatedKeys: new Set(),
    budget: { triedCount: 0, expandedTotal: 0 },
    // 精修/联合精修由引擎提供实现；本组只验证触发条件，用受控实现占位即可
    refine: async (base) => ({ best: base, candidateCount: 0, expandedNodes: 0 }),
    joint: async () => null,
  };

  const enlarged = await runLargeTierStage({ ...common, allowEnlarge: true });
  check(
    'allow_enlarge_probes_large_tiers',
    enlarged.challengers.length > 0 &&
      !enlarged.notes.includes('no-baseline') &&
      !enlarged.notes.includes('enlarge-not-allowed'),
    JSON.stringify(enlarged.notes),
  );

  const notAllowed = await runLargeTierStage({ ...common, allowEnlarge: false });
  check(
    'allow_enlarge_false_no_probe',
    notAllowed.challengers.length === 0 &&
      notAllowed.notes.includes('enlarge-not-allowed'),
    JSON.stringify(notAllowed.notes),
  );

  const badBaseline = await runLargeTierStage({
    ...common,
    baseline: { ...baseline, result: { ...baseline.result, metrics: null }, metrics: null },
  });
  check(
    'no_qualifying_baseline_no_probe',
    badBaseline.challengers.length === 0 && badBaseline.notes.includes('no-baseline'),
    JSON.stringify(badBaseline.notes),
  );

  const noBudget = await runLargeTierStage({
    ...common,
    budget: { triedCount: 2200, expandedTotal: 0 },
  });
  check(
    'budget_exhausted_no_probe',
    noBudget.challengers.length === 0,
    JSON.stringify(noBudget.notes),
  );

  const controller = new AbortController();
  controller.abort();
  const stopped = await runLargeTierStage({ ...common, signal: controller.signal });
  check(
    'aborted_no_probe',
    stopped.challengers.length === 0 && stopped.notes.includes('aborted'),
    JSON.stringify(stopped.notes),
  );
}

// ---------- E 组：端到端（真实路网尽力链）与防特判 ----------
{
  const escalation = await searchWithEscalation({
    graph,
    edgeIndex,
    shapeKey: 'heart',
    center: { lat: 23.1212, lng: 113.2841 },
    baseSizeMeters: 900,
    allowEnlarge: true,
  });
  check('escalation_ok', escalation.status === 'ok', escalation.status);
  if (escalation.status === 'ok') {
    check(
      'escalation_delivery_passes_gate',
      meetsQualityBar(escalation.best.result.metrics) && escalation.best.score > 0,
    );
    check(
      'escalation_real_route',
      escalation.best.result.routeLatLngs.length >= 2 &&
        escalation.best.result.metrics.routeMeters > 0,
    );
    // 备选条目必须带真实分数；大档备选还要带形状绝对误差
    check(
      'alternatives_carry_score',
      (escalation.alternatives || []).every((item) => Number.isFinite(item.score)),
    );
    check(
      'alternatives_carry_envelope_or_null',
      (escalation.alternatives || []).every(
        (item) => item.envelopeMeters === null || Number.isFinite(item.envelopeMeters),
      ),
    );
    // 近场证据未被大档阶段改写
    check(
      'near_best_not_overwritten',
      escalation.nearBest === null ||
        (Number.isFinite(escalation.nearBest.score) &&
          escalation.nearBest.sizeMeters <= Math.round(900 * 1.5)),
    );
  }

  // 同几何换名称：生产逻辑不读名称 → 补搜与裁决结果完全一致（§10.3 防特判）
  const outline = Array.from({ length: 24 }, (_, i) => {
    const t = (Math.PI * 2 * i) / 24;
    return [Math.cos(t) * 0.45, Math.sin(t) * 0.45];
  });
  const namedA = {
    name: '形状甲',
    constraintPoints: outline.filter((_, i) => i % 2 === 0),
    outlinePoints: outline,
    contentHash: 'same-hash',
  };
  const namedB = { ...namedA, name: '形状乙' };
  const probeNamed = async (customShape) => {
    const shapeBaseline = {
      result: PASSING,
      metrics: PASSING.metrics,
      score: scoreRoute(PASSING.metrics),
      center: PASSING.center,
      sizeMeters: PASSING.sizeMeters,
      rotationDeg: PASSING.rotationDeg,
      targetHash: targetIdentityOf({ customShape }),
    };
    return probeLargeTiers({
      graph,
      edgeIndex,
      customShape,
      origin: ORIGIN,
      baseSizeMeters: 900,
      baseline: shapeBaseline,
      targetHash: targetIdentityOf({ customShape }),
      evaluatedKeys: new Set(),
      maxCandidates: 2200,
    });
  };
  const probeA = await probeNamed(namedA);
  const probeB = await probeNamed(namedB);
  check(
    'same_geometry_different_name_same_probe',
    probeA.challengers.length === probeB.challengers.length &&
      probeA.challengers.every(
        (item, index) =>
          item.sizeMeters === probeB.challengers[index].sizeMeters &&
          item.score === probeB.challengers[index].score,
      ),
    `${probeA.challengers.length}/${probeB.challengers.length}`,
  );
}

console.log(`[summary] 断言 ${checks} 项，失败 ${failures} 项`);
// Node 里 MessageChannel 端口会挂住事件循环，测试结束必须显式退出（与 engine-smoke 同口径）
process.exit(failures === 0 ? 0 : 1);
