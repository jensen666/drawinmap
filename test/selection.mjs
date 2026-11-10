/**
 * 候选选优链路测试（Node 直接运行，不依赖浏览器/网络/LLM）。
 *
 * 覆盖第五十五轮"近且像优先 + 复杂图形可早退 + 近失候选联合精修"的选优规则：
 * 1. selection.comparePassingCandidates：调整分降序 → 原始分降序 → 尺寸升序；
 * 2. selection.isGoodEnoughToExit：达标 + 特征走全 + 调整分够早退线，复杂图形同样适用；
 * 3. selection.isRefinableNearMiss：无硬门槛失败、只差一道软门槛、评分够高、路线完整；
 * 4. 集成回归（真实路网）：报告三角形 1200m/禁止放大 → 不再被系统性放大到 2760/3600m。
 *
 * 运行：node test/selection.mjs
 * 说明：三角集成用例依赖 shape-features 的凸多边形零特征修复；若该修复未就绪，
 * 三角形会被误判出 gap 特征（尺寸反推把 900/1200 档跳掉），本用例会 FAIL，
 * 属于依赖未就绪而不是选优逻辑回归——不要放宽断言，等修复后复跑。
 */

import { GUANGZHOU_ROADS_HINT, readRequiredText } from './lib/require-data.mjs';
import {
  buildEdgeIndex,
  buildWalkGraph,
  findLargestComponent,
} from '../web/src/engine/graph.js';
import { scoreRoute, qualityGateReport } from '../web/src/engine/quality.js';
import {
  NEAR_MISS_SCORE,
  SCORE_TIER_TOLERANCE,
  candidateCostMetrics,
  compareCandidatesWithScoreTier,
  comparePassingCandidates,
  isGoodEnoughToExit,
  isRefinableNearMiss,
  selectByRule,
  selectPassingByScoreTier,
} from '../web/src/engine/selection.js';
import { searchWithEscalation } from '../web/src/engine/candidates.js';
import { normalizeCustomShape } from '../web/src/agent/intent.js';

let passCount = 0;
let failCount = 0;

/** 断言工具：失败时打印实际值，便于定位 */
function check(label, condition, detail = '') {
  if (condition) {
    passCount += 1;
    console.log(`[check] ${label} -> PASS`);
  } else {
    failCount += 1;
    console.log(`[check] ${label} -> FAIL ${detail}`);
  }
}

/**
 * 构造一份"质量达标"的规划指标（真实字段口径，数值全部落在门槛内）。
 * 单个 gate 的期望值一律用 qualityGateReport 实测结果做断言，不手抄门槛常量。
 *
 * @param {object} [overrides] 需要覆盖的字段（例如把 Fréchet 抬到超门槛）
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
    ...overrides,
  };
}

/**
 * 构造候选（selection 三个函数只需要 score/adjustedScore/sizeMeters/result）。
 *
 * @param {object} options 候选字段
 * @returns {object} 候选
 */
function makeCandidate({ metrics, score, adjustedScore, sizeMeters = 1200, center = null, route = true }) {
  return {
    result: {
      metrics,
      routeLatLngs: route
        ? [
            [23.12, 113.32],
            [23.121, 113.321],
          ]
        : [],
    },
    score,
    adjustedScore,
    sizeMeters,
    center: center ?? { lat: 23.12, lng: 113.32 },
    rotationDeg: 0,
  };
}

// ---------- 1. comparePassingCandidates：更差一侧均方根 ----------
{
  const withRms = (outline, route, extra = {}) => ({
    score: 70,
    adjustedScore: 70,
    sizeMeters: 1800,
    result: { metrics: { orderedOutlineRms: outline, orderedRouteRms: route } },
    ...extra,
  });
  // 5400m 均方根 1.9% 必须胜过 7200m 分数更高但均方根 2.3% 的候选
  const tighter = withRms(0.009, 0.019, { score: 80, sizeMeters: 5400 });
  const higherScore = withRms(0.016, 0.023, { score: 81, sizeMeters: 7200 });
  check(
    'compare：均方根更小者优先，即使分数略低',
    comparePassingCandidates(tighter, higherScore) < 0,
    String(comparePassingCandidates(tighter, higherScore)),
  );
  check('compare：反向比较为正', comparePassingCandidates(higherScore, tighter) > 0);
  check(
    'compare：排序后均方根更小的候选排第一',
    [higherScore, tighter].sort(comparePassingCandidates)[0] === tighter,
  );

  const sameRmsHighScore = withRms(0.02, 0.02, { score: 75, sizeMeters: 2400 });
  const sameRmsLowScore = withRms(0.02, 0.02, { score: 72, sizeMeters: 1200 });
  check(
    'compare：均方根相同时原始分高者优先',
    comparePassingCandidates(sameRmsHighScore, sameRmsLowScore) < 0,
  );

  const small = withRms(0.02, 0.02, { score: 70, sizeMeters: 1200 });
  const big = withRms(0.02, 0.02, { score: 70, sizeMeters: 3600 });
  check('compare：均方根与分数都相同时尺寸小者优先', comparePassingCandidates(small, big) < 0);
  check('compare：同值候选返回 0', comparePassingCandidates({ ...small }, { ...small }) === 0);

  // 缺均方根视为 Infinity，不能靠高分冒充最贴，但仍参与交付线比较
  check(
    'compare：缺均方根的合格候选排在有均方根的合格候选之后',
    comparePassingCandidates({ score: 90, sizeMeters: 800 }, small) > 0,
  );
}

// ---------- 1b. 比较器防降级与尺度折算（方案第 6 节冻结场景） ----------
{
  /**
   * 带绝对最大偏差的达标候选：orderedOutlineMaxMeters 供比较器扣除大尺寸比值红利。
   * 比值分口径：偏差/尺寸，大尺寸天然占便宜——尺度折算必须把红利扣回。
   */
  const withMaxMeters = (overrides) => makeMetrics({ orderedOutlineMaxMeters: 100, ...overrides });

  // 绝对米数更大、但相对均方根更小的大档应该赢
  const c2400 = {
    score: 77,
    adjustedScore: 77,
    sizeMeters: 2400,
    result: { metrics: withMaxMeters({ orderedOutlineMaxMeters: 113, orderedOutlineRms: 0.031, orderedRouteRms: 0.031 }) },
  };
  const c3600 = {
    score: 80,
    adjustedScore: 80,
    sizeMeters: 3600,
    result: { metrics: withMaxMeters({ orderedOutlineMaxMeters: 222, orderedOutlineRms: 0.019, orderedRouteRms: 0.019 }) },
  };
  check(
    'compare：3600m 相对均方根更小，胜过绝对米数更小的 2400m',
    comparePassingCandidates(c3600, c2400) < 0,
    String(comparePassingCandidates(c3600, c2400)),
  );
  check('compare：场景 1 反向比较为正', comparePassingCandidates(c2400, c3600) > 0);
  check('compare：场景 1 排序首选 3600m', [c2400, c3600].sort(comparePassingCandidates)[0] === c3600);

  // 场景 2（防降级）：1200m 56 分（橙色参考）不得抢在 2400m 78 分（绿色交付）之前
  const c1200 = { score: 56, adjustedScore: 56, sizeMeters: 1200, result: { metrics: withMaxMeters({ orderedOutlineMaxMeters: 90 }) } };
  const c2400b = { score: 78, adjustedScore: 78, sizeMeters: 2400, result: { metrics: withMaxMeters({ orderedOutlineMaxMeters: 106 }) } };
  check(
    'compare：2400m（绿色 78 分）胜 1200m（橙色 56 分），合格档不降级',
    comparePassingCandidates(c2400b, c1200) < 0,
  );
  check('compare：场景 2 排序首选 2400m', [c1200, c2400b].sort(comparePassingCandidates)[0] === c2400b);

  // 交付线边界：score === 60 算合格档（>= 60 优先）
  const atLine = { score: 60, adjustedScore: 60, sizeMeters: 1200 };
  const belowLine = { score: 59, adjustedScore: 59, sizeMeters: 900 };
  check('compare：都没有均方根时分数高者优先', comparePassingCandidates(atLine, belowLine) < 0);
  const lowScoreTight = {
    score: 59,
    adjustedScore: 59,
    sizeMeters: 5400,
    result: { metrics: { orderedOutlineRms: 0.01, orderedRouteRms: 0.012 } },
  };
  const highScoreLoose = {
    score: 80,
    adjustedScore: 80,
    sizeMeters: 1800,
    result: { metrics: { orderedOutlineRms: 0.04, orderedRouteRms: 0.05 } },
  };
  check(
    'compare：59 分但均方根更小，胜过 80 分更散的路线',
    comparePassingCandidates(lowScoreTight, highScoreLoose) < 0,
  );

  // 场景 3（跨中心三元组传递性）：偏移惩罚不同 + 尺寸不同 + 偏差不同，
  // 全排列排序首选必须一致（比较器是全序，不因输入顺序漂移）
  const triple = [
    { score: 78, adjustedScore: 75.5, sizeMeters: 2400, center: { lat: 23.12, lng: 113.32 }, result: { metrics: withMaxMeters({ orderedOutlineRms: 0.02, orderedRouteRms: 0.02 }) } },
    { score: 80, adjustedScore: 74, sizeMeters: 3600, center: { lat: 23.11, lng: 113.31 }, result: { metrics: withMaxMeters({ orderedOutlineRms: 0.03, orderedRouteRms: 0.03 }) } },
    { score: 66, adjustedScore: 65, sizeMeters: 1800, center: { lat: 23.13, lng: 113.33 }, result: { metrics: withMaxMeters({ orderedOutlineRms: 0.04, orderedRouteRms: 0.04 }) } },
  ];
  const permutations = [
    [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
  ].map((order) => order.map((index) => triple[index]));
  const firsts = new Set(permutations.map((perm) => [...perm].sort(comparePassingCandidates)[0]));
  check(
    'compare：跨中心三元组全排列首选一致（传递性）',
    firsts.size === 1 && [...firsts][0] === triple[0],
    `首选集合 ${firsts.size} 个`,
  );

  const noMetricsBig = { score: 80, adjustedScore: 80, sizeMeters: 3600 };
  check(
    'compare：缺均方根的合格候选不胜过有均方根的合格候选',
    comparePassingCandidates(noMetricsBig, c2400) > 0,
    String(comparePassingCandidates(noMetricsBig, c2400)),
  );
}

// ---------- 2. isGoodEnoughToExit：达标 + 特征走全 + 调整分够线 ----------
{
  const metrics = makeMetrics();
  const report = qualityGateReport(metrics);
  check(
    'gate：基准 metrics 质量达标（构造前提）',
    report.passes,
    JSON.stringify({ hard: report.hardFailures, soft: report.softFailures.map((g) => g.key) }),
  );

  const candidate = makeCandidate({ metrics, score: 72, adjustedScore: 70 });
  // 复杂图形候选（带细节特征）：只要特征走全，同样允许早退，不再被"是否复杂"一刀切
  candidate.customShape = { name: '复杂图形', features: [{ kind: 'gap', widthRatio: 0.12 }] };
  check(
    'earlyExit：调整分 70 且特征覆盖 1 → true（即使带 features）',
    isGoodEnoughToExit(candidate, 70) === true,
  );
  check(
    'earlyExit：调整分恰好等于早退线 → true（边界）',
    isGoodEnoughToExit(makeCandidate({ metrics, score: 70, adjustedScore: 70 }), 70) === true,
  );
  check(
    'earlyExit：调整分低于早退线 → false',
    isGoodEnoughToExit(makeCandidate({ metrics, score: 74, adjustedScore: 69.9 }), 70) === false,
  );

  const featureNotReady = makeMetrics({ featureCount: 2, featureCoveredCount: 1, featureCoverage: 0.5 });
  check(
    'earlyExit：特征覆盖 <1 → false（继续下探更大尺寸）',
    isGoodEnoughToExit(
      makeCandidate({ metrics: featureNotReady, score: 72, adjustedScore: 75 }),
      70,
    ) === false,
  );

  const belowBar = makeMetrics({ frechetMaxRatio: 0.2 });
  check(
    'earlyExit：质量门槛不达标 → false（哪怕调整分很高）',
    isGoodEnoughToExit(makeCandidate({ metrics: belowBar, score: 65, adjustedScore: 90 }), 70) === false,
  );
  check('earlyExit：null 候选 → false', isGoodEnoughToExit(null, 70) === false);
}

// ---------- 3. isRefinableNearMiss：只差一道软门槛才值得进联合精修 ----------
{
  check('nearMiss：NEAR_MISS_SCORE 常量为 55', NEAR_MISS_SCORE === 55);

  // 只差 Fréchet 一道软门槛（58 分）：可联合精修
  const onlyFrechet = makeMetrics({ frechetMaxRatio: 0.2 });
  const frechetReport = qualityGateReport(onlyFrechet);
  check(
    'nearMiss：构造前提——只差 Fréchet 一道软门槛',
    frechetReport.hardFailures.length === 0 &&
      frechetReport.softCount === 1 &&
      frechetReport.softFailures[0].key === 'frechetMax',
    JSON.stringify({
      hard: frechetReport.hardFailures,
      soft: frechetReport.softFailures.map((gate) => gate.key),
    }),
  );
  check(
    'nearMiss：只差 Fréchet 的 58 分候选 → true',
    isRefinableNearMiss(makeCandidate({ metrics: onlyFrechet, score: 58, adjustedScore: 52 })) === true,
  );

  // 差两道软门槛：联合精修只调吸附组合，救回来的概率太低，不值得花预算
  const twoSoft = makeMetrics({ frechetMaxRatio: 0.2, orderedRouteMeanRatio: 0.05 });
  const twoReport = qualityGateReport(twoSoft);
  check(
    'nearMiss：构造前提——同时超两道软门槛',
    twoReport.hardFailures.length === 0 && twoReport.softCount === 2,
    JSON.stringify(twoReport.softFailures.map((gate) => gate.key)),
  );
  check(
    'nearMiss：差两道软门槛 → false',
    isRefinableNearMiss(makeCandidate({ metrics: twoSoft, score: 58, adjustedScore: 52 })) === false,
  );

  // 硬门槛失败（覆盖率只有 50%）：几何本身画不出，联合精修修不了
  const hardFail = makeMetrics({ coverage: 50 });
  const hardReport = qualityGateReport(hardFail);
  check(
    'nearMiss：构造前提——硬门槛 coverage 失败',
    hardReport.hardFailures.includes('coverage'),
    JSON.stringify(hardReport.hardFailures),
  );
  check(
    'nearMiss：硬门槛失败（coverage 50）→ false',
    isRefinableNearMiss(makeCandidate({ metrics: hardFail, score: 58, adjustedScore: 50 })) === false,
  );

  // 评分太低的候选返工价值低（哪怕只差一道软门槛）
  check(
    'nearMiss：score 50 低于 55 → false',
    isRefinableNearMiss(makeCandidate({ metrics: onlyFrechet, score: 50, adjustedScore: 48 })) === false,
  );

  // 路线不完整（吸附短路返回空路线）：联合精修无从重放
  check(
    'nearMiss：无完整路线（routeLatLngs 空）→ false',
    isRefinableNearMiss(
      makeCandidate({ metrics: onlyFrechet, score: 58, adjustedScore: 52, route: false }),
    ) === false,
  );

  // opts.scoreLine 可覆盖最低分线（供上层按场景调整）
  check(
    'nearMiss：opts.scoreLine=60 时 58 分候选 → false',
    isRefinableNearMiss(makeCandidate({ metrics: onlyFrechet, score: 58, adjustedScore: 52 }), {
      scoreLine: 60,
    }) === false,
  );
  check(
    'nearMiss：opts.scoreLine=50 时 58 分候选 → true',
    isRefinableNearMiss(makeCandidate({ metrics: onlyFrechet, score: 58, adjustedScore: 52 }), {
      scoreLine: 50,
    }) === true,
  );
}

// ---------- 4. 集成回归：报告三角形（真实路网，禁止放大） ----------
// 依赖 shape-features 的"凸多边形零 gap"修复：修复前三角形被误判出 0.116 宽的假 gap，
// 尺寸反推下限 1290m 把 900/1200 档跳掉，图形被系统性放大——本断言会 FAIL。
const roadsData = JSON.parse(
  readRequiredText(new URL('../mapdata/guangzhou-roads.json', import.meta.url), GUANGZHOU_ROADS_HINT),
).roads;
const graph = buildWalkGraph(roadsData);
const mainComponent = findLargestComponent(graph);
const edgeIndex = buildEdgeIndex(graph, 0.005, mainComponent);
const center = { lat: 23.1198, lng: 113.3245 };

const triangle = normalizeCustomShape({
  name: '三角形',
  points: [
    [0, 0.5],
    [-0.45, -0.35],
    [0.45, -0.35],
  ],
});
check('集成：三角形归一化被接受', triangle !== null);
if (triangle) {
  const featureDump = (triangle.features || []).map((f) => ({
    kind: f.kind,
    width: f.widthRatio,
  }));
  console.log(`  [triangle] 特征 ${triangle.features?.length ?? 0} 个 ${JSON.stringify(featureDump)}`);

  const startedAt = performance.now();
  const outcome = await searchWithEscalation({
    graph,
    edgeIndex,
    customShape: triangle,
    center,
    baseSizeMeters: 1200,
    allowEnlarge: false,
  });
  const elapsedMs = Math.round(performance.now() - startedAt);
  const best = outcome.best;
  console.log(
    `  [triangle] status=${outcome.status} size=${best?.sizeMeters ?? '-'}m score=${best?.score ?? '-'} ` +
      `adjusted=${best?.adjustedScore?.toFixed?.(1) ?? '-'} tried=${outcome.triedCount} stage=${outcome.stageLabel} ${elapsedMs}ms`,
  );
  if (best?.result?.metrics) {
    const metrics = best.result.metrics;
    console.log(
      `  [triangle] featureCount=${metrics.featureCount} coverage=${metrics.featureCoverage} ` +
        `orderedRouteMax=${metrics.orderedRouteMaxRatio?.toFixed?.(3)} frechet=${metrics.frechetMaxRatio?.toFixed?.(3)}`,
    );
  }

  check(
    '集成：三角形搜索成功（status=ok）',
    outcome.status === 'ok',
    `status=${outcome.status} tried=${outcome.triedCount}`,
  );
  check(
    '集成：交付候选真实达标（meetsQualityBar + 评分与指标一致）',
    Boolean(best && best.result && qualityGateReport(best.result.metrics).passes),
  );
  check(
    '集成：交付尺寸停在阶梯档上（精修不再 ±8% 漂出）',
    Boolean(best && [600, 720, 900, 1080, 1200, 1500, 1800, 2040, 2400, 3000, 3600, 5400, 7200, 9000].includes(best.sizeMeters)),
    `sizeMeters=${best?.sizeMeters}`,
  );
  check(
    '集成：交付候选带有限均方根',
    Boolean(best && Number.isFinite(best.result?.metrics?.orderedOutlineRms) && Number.isFinite(best.result?.metrics?.orderedRouteRms)),
  );
  check(
    '集成：交付候选评分与 scoreRoute 一致',
    Boolean(best && best.score === scoreRoute(best.result.metrics)),
  );
  // 接口兼容：调用方（shape-engine/controller）依赖 alternatives/bestOverall/triedCount 结构
  check(
    '集成：返回结构保持兼容（alternatives 数组 / bestOverall / triedCount / budgetExhausted）',
    Array.isArray(outcome.alternatives) &&
      'bestOverall' in outcome &&
      Number.isFinite(outcome.triedCount) &&
      outcome.triedCount > 0 &&
      typeof outcome.budgetExhausted === 'boolean',
    JSON.stringify({
      alternatives: Array.isArray(outcome.alternatives),
      triedCount: outcome.triedCount,
      budgetExhausted: outcome.budgetExhausted,
    }),
  );
  check(
    '集成：交付候选带调整分（近且像优先的排序依据）',
    Boolean(best && Number.isFinite(best.adjustedScore)),
    `adjusted=${best?.adjustedScore}`,
  );
  // ---------- 来源阶段口径（方案 2026-11-05 §5.2） ----------
  // stage 只表示粗搜来源级别；局部精修不再把 stage 改写成 4。
  check(
    '来源阶段：stage 是粗搜级别（1~4），不是精修标记',
    Number.isInteger(outcome.stage) && outcome.stage >= 1 && outcome.stage <= 4,
    `stage=${outcome.stage} label=${outcome.stageLabel}`,
  );
  check(
    '来源阶段：是否精修单独记录（refined 布尔）',
    typeof outcome.refined === 'boolean',
    `refined=${outcome.refined}`,
  );
  check(
    '来源阶段：粗搜来源级别与 stage 一致（sourceStage === stage）',
    outcome.sourceStage === outcome.stage,
    `stage=${outcome.stage} sourceStage=${outcome.sourceStage}`,
  );
  check(
    '来源阶段：粗搜候选尺寸与最终尺寸分开记录',
    Number.isFinite(outcome.sourceSizeMeters) && Number.isFinite(outcome.finalSizeMeters),
    `source=${outcome.sourceSizeMeters} final=${outcome.finalSizeMeters}`,
  );
  check(
    '来源阶段：精修发生时 stage 仍是粗搜级别（不再是硬编码 4）',
    outcome.refined !== true || outcome.stage === outcome.sourceStage,
    `refined=${outcome.refined} stage=${outcome.stage} label=${outcome.stageLabel}`,
  );
  check(
    '来源阶段：最终候选来源标识存在（可回溯到具体精修基线）',
    Boolean(outcome.finalSource) &&
      'stage' in outcome.finalSource &&
      'origin' in outcome.finalSource &&
      'sizeMeters' in outcome.finalSource,
    JSON.stringify(outcome.finalSource),
  );
  check(
    '来源阶段：精修发生时来源标记为 refine',
    outcome.refined !== true || outcome.finalSource.origin === 'refine',
    `refined=${outcome.refined} origin=${outcome.finalSource?.origin}`,
  );
}

// ---------- 成本感知选优规则（方案 2026-11-05 §6） ----------
{
  const origin = { lat: 23.1198, lng: 113.3245 };
  /** 过质量门的合成候选指标（各项有序偏差都在门槛内） */
  const passingMetrics = (overrides = {}) => ({
    orderedOutlineRms: 0.02,
    orderedRouteRms: 0.015,
    orderedOutlineMeanRatio: 0.02,
    orderedOutlineMaxRatio: 0.05,
    orderedRouteMeanRatio: 0.02,
    orderedRouteMaxRatio: 0.05,
    keyMaxOffsetRatio: 0.02,
    featureCoverage: 1,
    frechetMaxRatio: 0.05,
    aspectDistortionRatio: 0.05,
    featureGapRetainRatio: 1.5,
    orderedOutlineMaxMeters: 40,
    orderedRouteMaxMeters: 30,
    routeMeters: 9000,
    walkMinutes: 120,
    coverage: 100,
    failedLegs: 0,
    snapMaxMeters: 10,
    collapsedKeyCount: 0,
    keyCoverage: 1,
    detourRatio: 1.2,
    ...overrides,
  });
  const passing = (overrides = {}) => ({
    result: { metrics: passingMetrics(overrides.metrics ?? {}) },
    score: 80,
    sizeMeters: 1800,
    center: { lat: 23.12, lng: 113.325 },
    ...overrides,
  });

  const metrics = candidateCostMetrics(passing(), { origin });
  check(
    '成本指标：相对 RMS / 绝对误差 / 尺寸 / 路线 / 步行 / 偏移齐全',
    Number.isFinite(metrics.worseSideRms) &&
      Number.isFinite(metrics.absErrorMeters) &&
      metrics.sizeMeters === 1800 &&
      metrics.routeMeters === 9000 &&
      metrics.walkMinutes === 120 &&
      Number.isFinite(metrics.offsetMeters),
    JSON.stringify(metrics),
  );

  const small = passing({ sizeMeters: 900, metrics: { routeMeters: 4000, walkMinutes: 50 } });
  const big = passing({ sizeMeters: 5400, metrics: { routeMeters: 32000, walkMinutes: 420 } });
  check(
    '成本规则前提：两个合成候选都过质量门',
    selectByRule([big, small], 'current', { origin }).passingCount === 2,
    `passingCount=${selectByRule([big, small], 'current', { origin }).passingCount}`,
  );

  const currentPick = selectByRule([big, small], 'current', { origin });
  check('规则 current：按现有规则（更差一侧均方根）选', currentPick.selected !== null);

  const costPick = selectByRule([big, small], 'costFirst', { origin });
  check(
    '规则 costFirst：同等质量下选更小的（尺寸优先）',
    costPick.selected.sizeMeters === 900,
    `sizeMeters=${costPick.selected?.sizeMeters}`,
  );

  // 容差规则：更差一侧均方根超容差的候选先被排除
  const farRms = passing({
    metrics: { orderedOutlineRms: 0.5, orderedRouteRms: 0.5 },
  });
  const tolPick = selectByRule([farRms, small], 'tolerance', { origin, tolerance: 0.1 });
  check(
    '规则 tolerance：容差内的候选优先（排除超容差候选）',
    tolPick.selected.sizeMeters === 900,
    `sizeMeters=${tolPick.selected?.sizeMeters}`,
  );

  // 硬失败不得被低成本抵消（方案 §6.1）
  const hardFail = passing({
    score: 0,
    metrics: { coverage: 60, failedLegs: 1 },
  });
  const gated = selectByRule([hardFail, small], 'costFirst', { origin });
  check(
    '规则 costFirst：硬失败候选不得因成本低被选中',
    gated.selected.sizeMeters === 900 && gated.passingCount === 1,
    `sizeMeters=${gated.selected?.sizeMeters} passingCount=${gated.passingCount}`,
  );
  check(
    '规则 costFirst：没有合格候选时逐级回退（不直接无交付）',
    selectByRule([hardFail], 'costFirst', { origin }).fallbackUsed === true,
  );
  check(
    '规则成本优先：生产默认规则未被改动（current 仍是均方根优先）',
    comparePassingCandidates(small, big) !== 0,
  );
}

// ---------- 5. 分数分档选优（缺陷清单 2026-11-06 Bug 3，准确性优先） ----------
{
  const withRms = (score, outline, route, sizeMeters) => ({
    score,
    adjustedScore: score,
    sizeMeters,
    result: { metrics: { orderedOutlineRms: outline, orderedRouteRms: route } },
  });

  // N09 复现：交付 70 分（RMS 更小）而同池有 77 分——旧比较器会选 70，分档选优必须选 77
  const n09Pool = [withRms(70, 0.008, 0.012, 5400), withRms(77, 0.011, 0.016, 9000)];
  const n09Selected = selectPassingByScoreTier(n09Pool);
  check(
    '分档选优：分数明显更高（差 >3）的候选不得被 RMS 略差挤掉（N09 复现）',
    n09Selected.score === 77,
    `selected=${n09Selected.score}`,
  );

  // X14-ab 复现：交付 74 分而同池 83 分
  const x14Pool = [withRms(74, 0.007, 0.010, 9000), withRms(83, 0.012, 0.018, 5400)];
  check(
    '分档选优：X14 复现（74 vs 83 → 选 83）',
    selectPassingByScoreTier(x14Pool).score === 83,
    `selected=${selectPassingByScoreTier(x14Pool).score}`,
  );

  // 同档（差 ≤3）内仍"近且像"优先：79 分 RMS 差 vs 77 分 RMS 好 → 选 77（不退化为纯分数排序）
  const sameTierPool = [withRms(79, 0.02, 0.02, 7200), withRms(77, 0.01, 0.012, 5400)];
  check(
    '分档选优：同档（差 ≤3）内仍按均方根优先',
    selectPassingByScoreTier(sameTierPool).score === 77,
    `selected=${selectPassingByScoreTier(sameTierPool).score}`,
  );

  // 容差边界：恰差 3 分属同档（RMS 决定）；差 3 以上高分直接胜出
  const atBoundary = [
    withRms(80, 0.02, 0.02, 5400),
    withRms(77, 0.009, 0.010, 5400),
  ];
  check('分档选优：恰差 3 分视为同档（RMS 决定）', selectPassingByScoreTier(atBoundary).score === 77);
  const beyondBoundary = [
    withRms(80.5, 0.02, 0.02, 5400),
    withRms(77, 0.009, 0.010, 5400),
  ];
  check('分档选优：差超过 3 分高分直接胜出', selectPassingByScoreTier(beyondBoundary).score === 80.5);

  // 成对比较器与池选优同口径（精修/联合精修采纳判定用）
  check(
    '成对分档比较：高分差 >3 直接胜出',
    compareCandidatesWithScoreTier(withRms(83, 0.02, 0.02, 5400), withRms(74, 0.005, 0.008, 9000)) < 0,
  );
  check(
    '成对分档比较：同档内 RMS 优先',
    compareCandidatesWithScoreTier(withRms(79, 0.02, 0.02, 5400), withRms(77, 0.01, 0.012, 5400)) > 0,
  );

  // selectByRule('scoreTier') 与池选优一致，选中者排首位
  const ruled = selectByRule(n09Pool, 'scoreTier');
  check(
    '规则 scoreTier：与 selectPassingByScoreTier 同口径（77 分置首）',
    ruled.selected.score === 77 && ruled.pool[0].score === 77,
    JSON.stringify({ selected: ruled.selected.score, poolTop: ruled.pool[0]?.score }),
  );

  // 池选优返回"同池最高分未被选"为 0 例（验收口径：交付分与池最高分差 ≤ 容差）
  const pools = [n09Pool, x14Pool, sameTierPool, atBoundary];
  const abandoned = pools.filter((pool) => {
    const selected = selectPassingByScoreTier(pool);
    const top = Math.max(...pool.map((candidate) => candidate.score));
    return top - selected.score > SCORE_TIER_TOLERANCE;
  });
  check('分档选优：同池"高分未被选"例数降为 0', abandoned.length === 0, JSON.stringify(abandoned.length));

  // 空池与分数缺失兜底
  check('分档选优：空池返回 null', selectPassingByScoreTier([]) === null);
  const noScore = [{ result: { metrics: { orderedOutlineRms: 0.01, orderedRouteRms: 0.01 } }, sizeMeters: 1200 }];
  check('分档选优：分数缺失时退回比较器不抛错', selectPassingByScoreTier(noScore) !== null);
}

console.log(`\nRESULT: ${failCount === 0 ? 'PASS' : `FAIL (${failCount})`}  (${passCount} passed, ${failCount} failed)`);
process.exit(failCount === 0 ? 0 : 2);
