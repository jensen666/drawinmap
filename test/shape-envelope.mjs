/**
 * 形状绝对误差包络 E_shape 与基线—候选集裁决测试（Node 直接运行，不依赖浏览器/网络/LLM）。
 *
 * 覆盖方案（docs/方案设计/2026-11-01-图形路线视觉效果通用优化方案.md 第 5.2 / 5.3 节）：
 * 1. 包络只取三项米制指标（orderedOutlineMaxMeters / orderedRouteMaxMeters /
 *    frechetMaxMeters），吸附、关键点、特征偏差一律不并入；
 * 2. 三项任一缺失 / NaN / Infinity → 包络为 null，候选被拒（不得缺省放行）；
 * 3. "包络最大值不劣"而非"任一字段变差即否决"：基线 72/57m，两个大档 73/55m 与
 *    74/56m 都进入胜出集；
 * 4. 分数不高于基线 / 包络大于基线 → 不进胜出集；
 * 5. 目标哈希不一致 → 不进胜出集；
 * 6. 最大胜出档选择：{73/55m, 74/56m} 选 74/56m（更大者），中间档不得卡住更大档；
 * 7. 偏移 D：精修结果偏移大于基线 → 拒绝（reason 含 offset），持平/更近且分数包络
 *    满足 → 接受；
 * 8. 空 / 非法输入不产生 NaN 比较（返回拒绝而不是抛错）。
 *
 * 运行：node test/shape-envelope.mjs
 */

import { qualityGateReport, scoreRoute } from '../web/src/engine/quality.js';
import {
  SHAPE_ENVELOPE_REASONS,
  SHAPE_ENVELOPE_TOLERANCE_METERS,
  evaluateChallenger,
  offsetMetersOf,
  selectLargestWinner,
  shapeErrorEnvelopeMeters,
  verifyRefinedCandidate,
} from '../web/src/engine/shape-envelope.js';

let checks = 0;
let failures = 0;

/**
 * 断言工具：记录通过/失败计数（失败必须体现在退出码里）。
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

/** 请求中心（origin）：与 candidates.js 的 adjustedScoreOf 同一个点 */
const ORIGIN = { lat: 23.12, lng: 113.32 };

/** 同一内容哈希（同一数据/版本才允许比较） */
const HASH = 'target-hash-v1';

/**
 * 构造一份"质量达标"的规划指标（字段口径同 quality.js 真实字段）。
 * 三项米制指标默认给 40/30/20，包络 = 40m。
 *
 * @param {object} [overrides] 覆盖字段
 * @returns {object} metrics
 */
function makeMetrics(overrides = {}) {
  return {
    failedLegs: 0,
    routePointCount: 40,
    coverage: 100,
    snapMaxMeters: 20,
    snapAvgMeters: 10,
    collapsedKeyCount: 0,
    keyCoverage: 1,
    orderedOutlineMeanRatio: 0.02,
    orderedOutlineMaxRatio: 0.05,
    orderedRouteMeanRatio: 0.02,
    orderedRouteMaxRatio: 0.06,
    keyMaxOffsetRatio: 0.02,
    featureCount: 0,
    featureCoveredCount: 0,
    featureCoverage: 1,
    featureMaxOffsetRatio: 0,
    frechetMaxRatio: 0.08,
    aspectDistortionRatio: 0.05,
    featureGapRetainRatio: 1.5,
    detourRatio: 1.1,
    orderedOutlineMaxMeters: 40,
    orderedRouteMaxMeters: 30,
    frechetMaxMeters: 20,
    ...overrides,
  };
}

/**
 * 构造候选（口径同 candidates.js：result.metrics + score + sizeMeters + center）。
 *
 * @param {object} options 候选字段
 * @param {object} options.metrics 规划指标
 * @param {number} [options.score] 分数
 * @param {number} [options.sizeMeters] 尺寸（米）
 * @param {object} [options.center] 候选中心
 * @param {string|null} [options.targetHash] 内容哈希（null 表示缺失）
 * @param {number} [options.order] 原始生成顺序
 * @returns {object} 候选
 */
function makeCandidate({
  metrics,
  score,
  sizeMeters = 1200,
  center = ORIGIN,
  targetHash = HASH,
  order = 0,
}) {
  const candidate = {
    result: {
      metrics,
      routeLatLngs: [
        [23.12, 113.32],
        [23.121, 113.321],
      ],
    },
    sizeMeters,
    center: { ...center },
    rotationDeg: 0,
    targetHash,
    order,
  };
  if (score !== undefined) {
    candidate.score = score;
    candidate.adjustedScore = score;
  }
  return candidate;
}

/** 基线：分数 72，包络 57m（outline 57 / route 50 / frechet 40） */
const BASELINE = makeCandidate({
  metrics: makeMetrics({ orderedOutlineMaxMeters: 57, orderedRouteMaxMeters: 50, frechetMaxMeters: 40 }),
  score: 72,
  sizeMeters: 1200,
  order: 0,
});

/** 中间档：分数 73，包络 55m（outline 50 / route 55 / frechet 30）——route 项比基线差 */
const MID_TIER = makeCandidate({
  metrics: makeMetrics({ orderedOutlineMaxMeters: 50, orderedRouteMaxMeters: 55, frechetMaxMeters: 30 }),
  score: 73,
  sizeMeters: 2400,
  order: 1,
});

/** 更大档：分数 74，包络 56m（outline 48 / route 56 / frechet 32）——route 项比基线差 */
const LARGE_TIER = makeCandidate({
  metrics: makeMetrics({ orderedOutlineMaxMeters: 48, orderedRouteMaxMeters: 56, frechetMaxMeters: 32 }),
  score: 74,
  sizeMeters: 3600,
  order: 2,
});

// ---------- 0. 构造前提：基准 metrics 真实通过质量门 ----------
{
  const report = qualityGateReport(BASELINE.result.metrics);
  check(
    '前提：基线 metrics 质量门通过（qualityGateReport.passes）',
    report.passes,
    JSON.stringify({ hard: report.hardFailures, soft: report.softFailures.map((g) => g.key) }),
  );
  check('常量：SHAPE_ENVELOPE_TOLERANCE_METERS === 1e-6', SHAPE_ENVELOPE_TOLERANCE_METERS === 1e-6);
}

// ---------- 1. 包络只取三项米制指标 ----------
{
  check('包络：候选（result.metrics）取三项最大值 = 40m', shapeErrorEnvelopeMeters(BASELINE) === 57);
  check(
    '包络：直接传 metrics 与传候选结果一致',
    shapeErrorEnvelopeMeters(BASELINE.result.metrics) === shapeErrorEnvelopeMeters(BASELINE),
  );
  check(
    '包络：只挂 metrics 的候选（无 result）同样可读',
    shapeErrorEnvelopeMeters({ metrics: BASELINE.result.metrics }) === 57,
  );

  // 三项各自成为最大值时都要被取到
  check('包络：outline 最大时取 outline', shapeErrorEnvelopeMeters(makeCandidate({ metrics: makeMetrics({ orderedOutlineMaxMeters: 90, orderedRouteMaxMeters: 10, frechetMaxMeters: 20 }) })) === 90);
  check('包络：route 最大时取 route', shapeErrorEnvelopeMeters(makeCandidate({ metrics: makeMetrics({ orderedOutlineMaxMeters: 10, orderedRouteMaxMeters: 95, frechetMaxMeters: 20 }) })) === 95);
  check('包络：frechet 最大时取 frechet', shapeErrorEnvelopeMeters(makeCandidate({ metrics: makeMetrics({ orderedOutlineMaxMeters: 10, orderedRouteMaxMeters: 20, frechetMaxMeters: 99 }) })) === 99);

  // 吸附偏差、关键点、特征偏差不并入包络
  const noisy = makeMetrics({
    orderedOutlineMaxMeters: 40,
    orderedRouteMaxMeters: 30,
    frechetMaxMeters: 20,
    snapMaxMeters: 200,
    snapAvgMeters: 150,
    keyMaxOffsetRatio: 0.9,
    featureMaxOffsetRatio: 0.9,
    featureCount: 6,
    featureCoveredCount: 2,
  });
  check(
    '包络：吸附/关键点/特征偏差不并入（snap 200m 也不抬包络）',
    shapeErrorEnvelopeMeters(makeCandidate({ metrics: noisy })) === 40,
    String(shapeErrorEnvelopeMeters(makeCandidate({ metrics: noisy }))),
  );
}

// ---------- 2. 缺失 / NaN / Infinity → null 且候选被拒 ----------
{
  const fields = ['orderedOutlineMaxMeters', 'orderedRouteMaxMeters', 'frechetMaxMeters'];
  for (const field of fields) {
    const missing = makeMetrics();
    delete missing[field];
    check(`包络：${field} 缺失 → null`, shapeErrorEnvelopeMeters(makeCandidate({ metrics: missing })) === null);
    check(
      `包络：${field} = NaN → null`,
      shapeErrorEnvelopeMeters(makeCandidate({ metrics: makeMetrics({ [field]: Number.NaN }) })) === null,
    );
    check(
      `包络：${field} = Infinity → null`,
      shapeErrorEnvelopeMeters(makeCandidate({ metrics: makeMetrics({ [field]: Number.POSITIVE_INFINITY }) })) === null,
    );
    check(
      `包络：${field} = -Infinity → null`,
      shapeErrorEnvelopeMeters(makeCandidate({ metrics: makeMetrics({ [field]: Number.NEGATIVE_INFINITY }) })) === null,
    );

    // 缺该字段的候选不得进入胜出集
    const broken = makeCandidate({
      metrics: makeMetrics({ orderedOutlineMaxMeters: 40, orderedRouteMaxMeters: 30, frechetMaxMeters: 20 }),
      score: 80,
      sizeMeters: 3600,
    });
    delete broken.result.metrics[field];
    const evaluated = evaluateChallenger({ challenger: broken, baseline: BASELINE, origin: ORIGIN });
    check(
      `裁决：${field} 缺失的候选被拒（reason=envelope-missing）`,
      evaluated.accepted === false && evaluated.reason === SHAPE_ENVELOPE_REASONS.ENVELOPE_MISSING,
      `accepted=${evaluated.accepted} reason=${evaluated.reason}`,
    );
  }

  const nanCandidate = makeCandidate({
    metrics: makeMetrics({ orderedOutlineMaxMeters: Number.NaN }),
    score: 80,
    sizeMeters: 3600,
  });
  const nanEvaluated = evaluateChallenger({ challenger: nanCandidate, baseline: BASELINE, origin: ORIGIN });
  check(
    '裁决：NaN 包络的候选被拒（reason=envelope-missing）',
    nanEvaluated.accepted === false && nanEvaluated.reason === SHAPE_ENVELOPE_REASONS.ENVELOPE_MISSING,
    `accepted=${nanEvaluated.accepted} reason=${nanEvaluated.reason}`,
  );
  const infCandidate = makeCandidate({
    metrics: makeMetrics({ frechetMaxMeters: Number.POSITIVE_INFINITY }),
    score: 80,
    sizeMeters: 3600,
  });
  const infEvaluated = evaluateChallenger({ challenger: infCandidate, baseline: BASELINE, origin: ORIGIN });
  check(
    '裁决：Infinity 包络的候选被拒（reason=envelope-missing）',
    infEvaluated.accepted === false && infEvaluated.reason === SHAPE_ENVELOPE_REASONS.ENVELOPE_MISSING,
    `accepted=${infEvaluated.accepted} reason=${infEvaluated.reason}`,
  );
}

// ---------- 3. "包络最大值不劣"而非"任一字段变差即否决" ----------
{
  const midResult = evaluateChallenger({ challenger: MID_TIER, baseline: BASELINE, origin: ORIGIN });
  check(
    '裁决：73/55m 大档进入胜出集（包络 55 ≤ 基线 57）',
    midResult.accepted === true && midResult.reason === SHAPE_ENVELOPE_REASONS.ACCEPTED,
    `accepted=${midResult.accepted} reason=${midResult.reason}`,
  );
  check(
    '裁决：返回字段正确（envelope 55 / baselineEnvelope 57 / score 73 / baselineScore 72）',
    midResult.envelope === 55 &&
      midResult.baselineEnvelope === 57 &&
      midResult.score === 73 &&
      midResult.baselineScore === 72,
    JSON.stringify({
      envelope: midResult.envelope,
      baselineEnvelope: midResult.baselineEnvelope,
      score: midResult.score,
      baselineScore: midResult.baselineScore,
    }),
  );
  check(
    '裁决：route 项比基线差（50 → 55）但包络不劣，不单独否决',
    midResult.accepted === true,
    `reason=${midResult.reason}`,
  );

  const largeResult = evaluateChallenger({ challenger: LARGE_TIER, baseline: BASELINE, origin: ORIGIN });
  check(
    '裁决：74/56m 大档进入胜出集（包络 56 ≤ 基线 57）',
    largeResult.accepted === true && largeResult.reason === SHAPE_ENVELOPE_REASONS.ACCEPTED,
    `accepted=${largeResult.accepted} reason=${largeResult.reason}`,
  );
  check(
    '裁决：基线在比较期间不被改写（两次比较的 baselineEnvelope 恒为 57）',
    midResult.baselineEnvelope === 57 && largeResult.baselineEnvelope === 57,
  );
}

// ---------- 4. 分数不高于基线 / 包络大于基线 → 不进胜出集 ----------
{
  const sameScore = makeCandidate({
    metrics: makeMetrics({ orderedOutlineMaxMeters: 40, orderedRouteMaxMeters: 30, frechetMaxMeters: 20 }),
    score: 72,
    sizeMeters: 3600,
  });
  const sameScoreResult = evaluateChallenger({ challenger: sameScore, baseline: BASELINE, origin: ORIGIN });
  check(
    '裁决：分数与基线持平 → 不进胜出集（reason=score-not-better）',
    sameScoreResult.accepted === false && sameScoreResult.reason === SHAPE_ENVELOPE_REASONS.SCORE_NOT_BETTER,
    `accepted=${sameScoreResult.accepted} reason=${sameScoreResult.reason}`,
  );

  const lowerScore = makeCandidate({
    metrics: makeMetrics({ orderedOutlineMaxMeters: 40, orderedRouteMaxMeters: 30, frechetMaxMeters: 20 }),
    score: 71,
    sizeMeters: 3600,
  });
  const lowerScoreResult = evaluateChallenger({ challenger: lowerScore, baseline: BASELINE, origin: ORIGIN });
  check(
    '裁决：分数低于基线 → 不进胜出集（reason=score-not-better）',
    lowerScoreResult.accepted === false && lowerScoreResult.reason === SHAPE_ENVELOPE_REASONS.SCORE_NOT_BETTER,
    `accepted=${lowerScoreResult.accepted} reason=${lowerScoreResult.reason}`,
  );

  const worseEnvelope = makeCandidate({
    metrics: makeMetrics({ orderedOutlineMaxMeters: 58, orderedRouteMaxMeters: 30, frechetMaxMeters: 20 }),
    score: 80,
    sizeMeters: 3600,
  });
  const worseResult = evaluateChallenger({ challenger: worseEnvelope, baseline: BASELINE, origin: ORIGIN });
  check(
    '裁决：包络 58m > 基线 57m → 不进胜出集（reason=envelope-worse）',
    worseResult.accepted === false && worseResult.reason === SHAPE_ENVELOPE_REASONS.ENVELOPE_WORSE,
    `accepted=${worseResult.accepted} reason=${worseResult.reason}`,
  );

  // 浮点容差边界：默认 1e-6 米
  const withinTolerance = makeCandidate({
    metrics: makeMetrics({ orderedOutlineMaxMeters: 57 + 1e-7, orderedRouteMaxMeters: 30, frechetMaxMeters: 20 }),
    score: 80,
    sizeMeters: 3600,
  });
  const withinResult = evaluateChallenger({ challenger: withinTolerance, baseline: BASELINE, origin: ORIGIN });
  check(
    '裁决：包络超出基线 1e-7m（容差内）→ 接受',
    withinResult.accepted === true,
    `accepted=${withinResult.accepted} reason=${withinResult.reason}`,
  );
  const beyondTolerance = makeCandidate({
    metrics: makeMetrics({ orderedOutlineMaxMeters: 57 + 1e-5, orderedRouteMaxMeters: 30, frechetMaxMeters: 20 }),
    score: 80,
    sizeMeters: 3600,
  });
  const beyondResult = evaluateChallenger({ challenger: beyondTolerance, baseline: BASELINE, origin: ORIGIN });
  check(
    '裁决：包络超出基线 1e-5m（容差外）→ 拒绝',
    beyondResult.accepted === false && beyondResult.reason === SHAPE_ENVELOPE_REASONS.ENVELOPE_WORSE,
    `accepted=${beyondResult.accepted} reason=${beyondResult.reason}`,
  );
  const looseTolerance = makeCandidate({
    metrics: makeMetrics({ orderedOutlineMaxMeters: 57.5, orderedRouteMaxMeters: 30, frechetMaxMeters: 20 }),
    score: 80,
    sizeMeters: 3600,
  });
  const looseResult = evaluateChallenger({
    challenger: looseTolerance,
    baseline: BASELINE,
    origin: ORIGIN,
    tolerance: 1,
  });
  check(
    '裁决：自定义容差 1m 时包络 57.5m → 接受（容差可覆盖）',
    looseResult.accepted === true && looseResult.tolerance === 1,
    `accepted=${looseResult.accepted} tolerance=${looseResult.tolerance}`,
  );
  check(
    '裁决：容差缺省为 SHAPE_ENVELOPE_TOLERANCE_METERS',
    evaluateChallenger({ challenger: MID_TIER, baseline: BASELINE, origin: ORIGIN }).tolerance ===
      SHAPE_ENVELOPE_TOLERANCE_METERS,
  );
}

// ---------- 5. 目标哈希不一致 → 不进胜出集 ----------
{
  const otherHash = makeCandidate({
    metrics: makeMetrics({ orderedOutlineMaxMeters: 40, orderedRouteMaxMeters: 30, frechetMaxMeters: 20 }),
    score: 80,
    sizeMeters: 3600,
    targetHash: 'target-hash-v2',
  });
  const hashResult = evaluateChallenger({ challenger: otherHash, baseline: BASELINE, origin: ORIGIN });
  check(
    '裁决：内容哈希不一致 → 不进胜出集（reason=target-hash-mismatch）',
    hashResult.accepted === false && hashResult.reason === SHAPE_ENVELOPE_REASONS.TARGET_HASH_MISMATCH,
    `accepted=${hashResult.accepted} reason=${hashResult.reason}`,
  );

  const noHash = makeCandidate({
    metrics: makeMetrics({ orderedOutlineMaxMeters: 40, orderedRouteMaxMeters: 30, frechetMaxMeters: 20 }),
    score: 80,
    sizeMeters: 3600,
    targetHash: null,
  });
  const noHashResult = evaluateChallenger({ challenger: noHash, baseline: BASELINE, origin: ORIGIN });
  check(
    '裁决：缺失内容哈希 → 不进胜出集（reason=target-hash-mismatch）',
    noHashResult.accepted === false && noHashResult.reason === SHAPE_ENVELOPE_REASONS.TARGET_HASH_MISMATCH,
    `accepted=${noHashResult.accepted} reason=${noHashResult.reason}`,
  );
  const baselineNoHash = makeCandidate({
    metrics: makeMetrics({ orderedOutlineMaxMeters: 57, orderedRouteMaxMeters: 50, frechetMaxMeters: 40 }),
    score: 72,
    sizeMeters: 1200,
    targetHash: null,
  });
  const baselineNoHashResult = evaluateChallenger({
    challenger: MID_TIER,
    baseline: baselineNoHash,
    origin: ORIGIN,
  });
  check(
    '裁决：基线缺失内容哈希 → 不进胜出集（reason=target-hash-mismatch）',
    baselineNoHashResult.accepted === false &&
      baselineNoHashResult.reason === SHAPE_ENVELOPE_REASONS.TARGET_HASH_MISMATCH,
    `accepted=${baselineNoHashResult.accepted} reason=${baselineNoHashResult.reason}`,
  );
}

// ---------- 6. 最大胜出档选择 ----------
{
  const winners = [MID_TIER, LARGE_TIER];
  const picked = selectLargestWinner(winners);
  check(
    '最大档：{73/55m, 74/56m} 选中 74/56m（更大者，中间档不卡住更大档）',
    picked === LARGE_TIER,
    `选中 sizeMeters=${picked?.sizeMeters} score=${picked?.score}`,
  );
  check(
    '最大档：胜出集顺序颠倒结果不变（可复现）',
    selectLargestWinner([LARGE_TIER, MID_TIER]) === LARGE_TIER,
  );
  check(
    '最大档：返回值就是胜出集成员本身（不复制对象）',
    picked === winners[1],
  );

  const sameSizeLow = makeCandidate({
    metrics: makeMetrics({ orderedOutlineMaxMeters: 40, orderedRouteMaxMeters: 30, frechetMaxMeters: 20 }),
    score: 70,
    sizeMeters: 3600,
    order: 1,
  });
  const sameSizeHigh = makeCandidate({
    metrics: makeMetrics({ orderedOutlineMaxMeters: 40, orderedRouteMaxMeters: 30, frechetMaxMeters: 20 }),
    score: 76,
    sizeMeters: 3600,
    order: 2,
  });
  check(
    '最大档：同尺寸取分数更高者',
    selectLargestWinner([sameSizeLow, sameSizeHigh]) === sameSizeHigh,
  );
  const sameSizeSameScoreLate = makeCandidate({
    metrics: makeMetrics({ orderedOutlineMaxMeters: 40, orderedRouteMaxMeters: 30, frechetMaxMeters: 20 }),
    score: 76,
    sizeMeters: 3600,
    order: 5,
  });
  const sameSizeSameScoreEarly = makeCandidate({
    metrics: makeMetrics({ orderedOutlineMaxMeters: 40, orderedRouteMaxMeters: 30, frechetMaxMeters: 20 }),
    score: 76,
    sizeMeters: 3600,
    order: 3,
  });
  check(
    '最大档：同尺寸同分取原始生成顺序更早者',
    selectLargestWinner([sameSizeSameScoreLate, sameSizeSameScoreEarly]) === sameSizeSameScoreEarly,
  );
  check(
    '最大档：不改写传入数组（顺序保持原样）',
    winners[0] === MID_TIER && winners[1] === LARGE_TIER,
  );
  check('最大档：空胜出集 → null', selectLargestWinner([]) === null);
  check('最大档：null 输入 → null', selectLargestWinner(null) === null);
  check('最大档：非数组输入 → null', selectLargestWinner({ sizeMeters: 3600 }) === null);
}

// ---------- 7. 偏移 D（精修复检） ----------
{
  // 基线与请求中心同点（D = 0），精修结果挪到北侧 0.001°（约 111m）→ 偏移变远
  const farther = makeCandidate({
    metrics: makeMetrics({ orderedOutlineMaxMeters: 40, orderedRouteMaxMeters: 30, frechetMaxMeters: 20 }),
    score: 80,
    sizeMeters: 3600,
    center: { lat: ORIGIN.lat + 0.001, lng: ORIGIN.lng },
    order: 3,
  });
  const fartherResult = verifyRefinedCandidate({ candidate: farther, baseline: BASELINE, origin: ORIGIN });
  check(
    '精修复检：偏移大于基线 → 拒绝（reason 含 offset）',
    fartherResult.accepted === false && fartherResult.reason.includes('offset'),
    `accepted=${fartherResult.accepted} reason=${fartherResult.reason}`,
  );
  check(
    '精修复检：偏移变远时 reason=offset-farther 且 offsetOk=false',
    fartherResult.reason === SHAPE_ENVELOPE_REASONS.OFFSET_FARTHER && fartherResult.offsetOk === false,
    `reason=${fartherResult.reason} offsetOk=${fartherResult.offsetOk}`,
  );
  check(
    '精修复检：偏移距离按请求中心→候选中心计算（约 111m）',
    fartherResult.offsetMeters > 100 && fartherResult.offsetMeters < 120,
    `offsetMeters=${fartherResult.offsetMeters}`,
  );
  check(
    '精修复检：基线偏移为 0（与请求中心同点）',
    fartherResult.baselineOffsetMeters === 0,
    `baselineOffsetMeters=${fartherResult.baselineOffsetMeters}`,
  );

  // 持平：精修结果仍在请求中心（D = 0 = 基线 D）
  const sameOffset = makeCandidate({
    metrics: makeMetrics({ orderedOutlineMaxMeters: 40, orderedRouteMaxMeters: 30, frechetMaxMeters: 20 }),
    score: 80,
    sizeMeters: 3600,
    center: { ...ORIGIN },
    order: 4,
  });
  const sameOffsetResult = verifyRefinedCandidate({ candidate: sameOffset, baseline: BASELINE, origin: ORIGIN });
  check(
    '精修复检：偏移持平且分数/包络满足 → 接受',
    sameOffsetResult.accepted === true && sameOffsetResult.offsetOk === true,
    `accepted=${sameOffsetResult.accepted} reason=${sameOffsetResult.reason}`,
  );

  // 更近：基线偏北 0.001°，精修结果回到请求中心
  const northBaseline = makeCandidate({
    metrics: makeMetrics({ orderedOutlineMaxMeters: 57, orderedRouteMaxMeters: 50, frechetMaxMeters: 40 }),
    score: 72,
    sizeMeters: 1200,
    center: { lat: ORIGIN.lat + 0.001, lng: ORIGIN.lng },
    order: 0,
  });
  const nearer = makeCandidate({
    metrics: makeMetrics({ orderedOutlineMaxMeters: 40, orderedRouteMaxMeters: 30, frechetMaxMeters: 20 }),
    score: 80,
    sizeMeters: 3600,
    center: { ...ORIGIN },
    order: 5,
  });
  const nearerResult = verifyRefinedCandidate({ candidate: nearer, baseline: northBaseline, origin: ORIGIN });
  check(
    '精修复检：偏移更近且分数/包络满足 → 接受',
    nearerResult.accepted === true && nearerResult.offsetOk === true,
    `accepted=${nearerResult.accepted} reason=${nearerResult.reason}`,
  );

  // 其他条件不满足时保留原有 reason（不误报成 offset 问题）
  const worseScore = makeCandidate({
    metrics: makeMetrics({ orderedOutlineMaxMeters: 40, orderedRouteMaxMeters: 30, frechetMaxMeters: 20 }),
    score: 70,
    sizeMeters: 3600,
    center: { ...ORIGIN },
  });
  const worseScoreResult = verifyRefinedCandidate({ candidate: worseScore, baseline: BASELINE, origin: ORIGIN });
  check(
    '精修复检：分数不足时 reason 仍是 score-not-better（不误判为 offset）',
    worseScoreResult.accepted === false &&
      worseScoreResult.reason === SHAPE_ENVELOPE_REASONS.SCORE_NOT_BETTER,
    `reason=${worseScoreResult.reason}`,
  );

  // 偏移数据缺失 → 无法复检 → 拒绝（reason 含 offset）
  const noCenter = makeCandidate({
    metrics: makeMetrics({ orderedOutlineMaxMeters: 40, orderedRouteMaxMeters: 30, frechetMaxMeters: 20 }),
    score: 80,
    sizeMeters: 3600,
  });
  noCenter.center = null;
  const noCenterResult = verifyRefinedCandidate({ candidate: noCenter, baseline: BASELINE, origin: ORIGIN });
  check(
    '精修复检：偏移不可得 → 拒绝（reason 含 offset）',
    noCenterResult.accepted === false && noCenterResult.reason.includes('offset'),
    `accepted=${noCenterResult.accepted} reason=${noCenterResult.reason}`,
  );
  check(
    '偏移工具：缺 origin 或缺 center → null（不产生 NaN）',
    offsetMetersOf(sameOffset, null) === null && offsetMetersOf(noCenter, ORIGIN) === null,
  );
}

// ---------- 8. 空 / 非法输入不产生 NaN 比较 ----------
{
  const emptyResult = evaluateChallenger({});
  check(
    '非法输入：evaluateChallenger({}) → 拒绝而不是抛错',
    emptyResult.accepted === false && emptyResult.reason === SHAPE_ENVELOPE_REASONS.INVALID_INPUT,
    `accepted=${emptyResult.accepted} reason=${emptyResult.reason}`,
  );
  const nullResult = evaluateChallenger({ challenger: null, baseline: null, origin: null });
  check(
    '非法输入：challenger/baseline 为 null → 拒绝',
    nullResult.accepted === false && nullResult.reason === SHAPE_ENVELOPE_REASONS.INVALID_INPUT,
    `accepted=${nullResult.accepted} reason=${nullResult.reason}`,
  );
  check(
    '非法输入：包络工具对 null/undefined/数字返回 null',
    shapeErrorEnvelopeMeters(null) === null &&
      shapeErrorEnvelopeMeters(undefined) === null &&
      shapeErrorEnvelopeMeters(42) === null,
  );

  const noMetrics = makeCandidate({ metrics: makeMetrics(), score: 80, sizeMeters: 3600 });
  noMetrics.result.metrics = null;
  const noMetricsResult = evaluateChallenger({ challenger: noMetrics, baseline: BASELINE, origin: ORIGIN });
  check(
    '非法输入：challenger 无 metrics → 拒绝（reason=metrics-missing）',
    noMetricsResult.accepted === false && noMetricsResult.reason === SHAPE_ENVELOPE_REASONS.METRICS_MISSING,
    `accepted=${noMetricsResult.accepted} reason=${noMetricsResult.reason}`,
  );

  const badQuality = makeCandidate({
    metrics: makeMetrics({ frechetMaxRatio: 0.2 }),
    score: 80,
    sizeMeters: 3600,
  });
  const badQualityResult = evaluateChallenger({ challenger: badQuality, baseline: BASELINE, origin: ORIGIN });
  check(
    '非法输入：质量门不通过 → 拒绝（reason=quality-bar-failed）',
    badQualityResult.accepted === false &&
      badQualityResult.reason === SHAPE_ENVELOPE_REASONS.QUALITY_BAR_FAILED,
    `accepted=${badQualityResult.accepted} reason=${badQualityResult.reason}`,
  );

  const nanScore = makeCandidate({
    metrics: makeMetrics({ orderedOutlineMaxMeters: 40, orderedRouteMaxMeters: 30, frechetMaxMeters: 20 }),
    score: Number.NaN,
    sizeMeters: 3600,
  });
  const nanScoreResult = evaluateChallenger({ challenger: nanScore, baseline: BASELINE, origin: ORIGIN });
  check(
    '非法输入：分数 NaN → 拒绝且不产生 NaN 比较（score=null，reason=score-not-better）',
    nanScoreResult.accepted === false &&
      nanScoreResult.reason === SHAPE_ENVELOPE_REASONS.SCORE_NOT_BETTER &&
      nanScoreResult.score === null,
    `accepted=${nanScoreResult.accepted} reason=${nanScoreResult.reason} score=${nanScoreResult.score}`,
  );

  const noScoreCandidate = makeCandidate({
    metrics: makeMetrics({ orderedOutlineMaxMeters: 40, orderedRouteMaxMeters: 30, frechetMaxMeters: 20 }),
    sizeMeters: 3600,
  });
  delete noScoreCandidate.score;
  const fallbackResult = evaluateChallenger({ challenger: noScoreCandidate, baseline: BASELINE, origin: ORIGIN });
  check(
    '非法输入：缺 score 时按 metrics 重算（与 scoreRoute 同值），不当作 0',
    fallbackResult.score === scoreRoute(noScoreCandidate.result.metrics),
    `score=${fallbackResult.score} scoreRoute=${scoreRoute(noScoreCandidate.result.metrics)}`,
  );

  const refinedEmpty = verifyRefinedCandidate({});
  check(
    '非法输入：verifyRefinedCandidate({}) → 拒绝而不是抛错',
    refinedEmpty.accepted === false && refinedEmpty.reason === SHAPE_ENVELOPE_REASONS.INVALID_INPUT,
    `accepted=${refinedEmpty.accepted} reason=${refinedEmpty.reason}`,
  );
}

check('断言数非零（测试确实执行了检查）', checks > 0, `checks=${checks}`);

console.log(`\n[summary] ${checks - failures}/${checks} 项通过，失败 ${failures} 项`);
if (failures > 0) {
  process.exitCode = 1;
}
