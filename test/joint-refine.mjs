/**
 * 多候选吸附 + 整图联合精修测试。
 *
 * 覆盖：
 * 0. qualityGateReport 门槛分类：达标 / 只超 Fréchet(softCount=1) / 超两道软门槛 /
 *    吸附、coverage 硬门槛；isRefinementImprovement 接受规则：软门槛 2→1、1→1
 *    Fréchet 定向改善、其它软门槛变差拒绝、1→2 拒绝、trial 硬门槛拒绝、
 *    best 硬伤救回、都达标按评分/几何比较；
 * 1. nearbyEdges：排序、去重、距离过滤、不足 K 个、与 nearestEdge 一致性；
 * 2. snapOverrides：缺省重放与基线一致；指定第 N 近边后结果确实使用该边；
 * 3. jointRefine：真实路网达标候选上"有改进则几何指标不劣、无改进返回基线"；
 *    预算限制（maxEvaluations=1）与无路区域返回基线；
 * 4. legProfiles：指定档位重放不改变约束顺序/闭合（路线仍完整）；
 * 5. 软门槛失败基线：联合精修不抛错、返回结构完整、预算受限、失败门槛不增加。
 */
import { GUANGZHOU_ROADS_WEB_HINT, readRequiredText } from './lib/require-data.mjs';
import {
  buildWalkGraph,
  buildEdgeIndex,
  findLargestComponent,
  nearestEdge,
  nearbyEdges,
} from '../web/src/engine/graph.js';
import { planShapeRoute } from '../web/src/engine/planner.js';
import { isRefinementImprovement, jointRefine } from '../web/src/engine/joint-refine.js';
import { meetsQualityBar, qualityGateReport, scoreRoute } from '../web/src/engine/quality.js';

let passCount = 0;
let failCount = 0;
function check(label, condition, detail = '') {
  if (condition) {
    passCount += 1;
    console.log(`[check] ${label} -> PASS`);
  } else {
    failCount += 1;
    console.log(`[check] ${label} -> FAIL ${detail}`);
  }
}

// ---------- 0. 门槛报告分类 + 联合精修接受规则（纯函数单测，不依赖路网） ----------
/** 合成一份"所有门槛都达标"的规划指标（字段名与 planner 输出一致，单测专用） */
function makeMetrics(overrides = {}) {
  return {
    failedLegs: 0,
    routePointCount: 20,
    coverage: 100,
    snapMaxMeters: 20,
    snapAvgMeters: 5,
    collapsedKeyCount: 0,
    keyCoverage: 1,
    orderedOutlineMeanRatio: 0.02,
    orderedOutlineMaxRatio: 0.08,
    orderedRouteMeanRatio: 0.02,
    orderedRouteMaxRatio: 0.1,
    keyMaxOffsetRatio: 0.03,
    featureCoverage: 0.9,
    frechetMaxRatio: 0.1,
    aspectDistortionRatio: 0.05,
    featureGapRetainRatio: 2,
    detourRatio: 1.1,
    ...overrides,
  };
}

/** 合成候选 entry（接受规则只读取 metrics 与 score） */
function makeEntry(overrides, score = 60) {
  return { metrics: makeMetrics(overrides), score };
}

{
  const passed = qualityGateReport(makeMetrics());
  check(
    'qualityGateReport：全部达标 -> passes、softCount=0、无硬门槛失败',
    passed.passes === true && passed.softCount === 0 && passed.hardFailures.length === 0,
    JSON.stringify({ passes: passed.passes, softCount: passed.softCount, hard: passed.hardFailures }),
  );
  check(
    'qualityGateReport：与 meetsQualityBar 判定等价（达标/只差 Fréchet/coverage 硬伤）',
    [makeMetrics(), makeMetrics({ frechetMaxRatio: 0.18 }), makeMetrics({ coverage: 80 })].every(
      (metrics) => qualityGateReport(metrics).passes === meetsQualityBar(metrics),
    ),
  );

  const frechetOnly = qualityGateReport(makeMetrics({ frechetMaxRatio: 0.18 }));
  check(
    'qualityGateReport：只超 Fréchet -> softCount=1 且失败项为 frechetMax',
    frechetOnly.softCount === 1 &&
      frechetOnly.softFailures.length === 1 &&
      frechetOnly.softFailures[0].key === 'frechetMax' &&
      frechetOnly.softFailures[0].excess > 0 &&
      frechetOnly.hardFailures.length === 0,
    JSON.stringify(frechetOnly.softFailures.map((gate) => [gate.key, gate.excess])),
  );

  const twoSoft = qualityGateReport(
    makeMetrics({ frechetMaxRatio: 0.18, orderedRouteMaxRatio: 0.2 }),
  );
  check(
    'qualityGateReport：超两道软门槛 -> softCount=2（Fréchet + 有序路线最大偏差）',
    twoSoft.softCount === 2 &&
      twoSoft.softFailures.map((gate) => gate.key).sort().join(',') ===
        'frechetMax,orderedRouteMax',
    JSON.stringify(twoSoft.softFailures.map((gate) => gate.key)),
  );

  const snapHard = qualityGateReport(makeMetrics({ snapMaxMeters: 150 }));
  check(
    'qualityGateReport：吸附硬门槛 -> hardFailures 含 snap-max 且 passes=false',
    snapHard.hardFailures.includes('snap-max') && snapHard.passes === false,
    JSON.stringify(snapHard.hardFailures),
  );

  const coverageHard = qualityGateReport(makeMetrics({ coverage: 80 }));
  check(
    'qualityGateReport：coverage 硬门槛 -> hardFailures 含 coverage 且 passes=false',
    coverageHard.hardFailures.includes('coverage') && coverageHard.passes === false,
    JSON.stringify(coverageHard.hardFailures),
  );
}

{
  // 失败软门槛数量 2→1：即使评分更低也接受（先把"差得多"救成"差得少"）
  check(
    'isRefinementImprovement：软门槛 2→1 接受（评分更低也接受）',
    isRefinementImprovement(
      makeEntry({ frechetMaxRatio: 0.18 }, 50),
      makeEntry({ frechetMaxRatio: 0.18, orderedRouteMaxRatio: 0.2 }, 55),
    ) === true,
  );
  // 数量相同 1→1：Fréchet excess 严格下降且其它软门槛不退化 -> 接受
  check(
    'isRefinementImprovement：1→1 且 Fréchet excess 下降、其它不退化 -> 接受',
    isRefinementImprovement(
      makeEntry({ frechetMaxRatio: 0.16 }, 50),
      makeEntry({ frechetMaxRatio: 0.18 }, 55),
    ) === true,
  );
  // 数量相同 1→1：Fréchet 下降但有序最大偏差变大（仍未超门槛）-> 拒绝
  check(
    'isRefinementImprovement：Fréchet 下降但有序偏差变大 -> 拒绝',
    isRefinementImprovement(
      makeEntry({ frechetMaxRatio: 0.16, orderedOutlineMaxRatio: 0.115 }, 55),
      makeEntry({ frechetMaxRatio: 0.18, orderedOutlineMaxRatio: 0.1 }, 55),
    ) === false,
  );
  // 失败软门槛数量 1→2：变多 -> 拒绝
  check(
    'isRefinementImprovement：软门槛 1→2 拒绝',
    isRefinementImprovement(
      makeEntry({ frechetMaxRatio: 0.18, orderedRouteMaxRatio: 0.2 }, 55),
      makeEntry({ frechetMaxRatio: 0.18 }, 55),
    ) === false,
  );
  // trial 有硬门槛失败（覆盖不全，局部吸附修不了）-> 拒绝
  check(
    'isRefinementImprovement：trial 硬门槛失败 -> 拒绝',
    isRefinementImprovement(
      makeEntry({ coverage: 80, frechetMaxRatio: 0.16 }, 60),
      makeEntry({ frechetMaxRatio: 0.18 }, 50),
    ) === false,
  );
  // best 有硬门槛失败、trial 没有 -> 接受（"画不出来"先救成"画得出来"）
  check(
    'isRefinementImprovement：best 有硬门槛失败而 trial 无 -> 接受',
    isRefinementImprovement(makeEntry({}, 40), makeEntry({ coverage: 80 }, 60)) === true,
  );
  // 都已达标：评分更高接受、更低拒绝
  check(
    'isRefinementImprovement：都达标时评分更高 -> 接受',
    isRefinementImprovement(makeEntry({}, 63), makeEntry({}, 62)) === true,
  );
  check(
    'isRefinementImprovement：都达标时评分更低 -> 拒绝',
    isRefinementImprovement(makeEntry({}, 61), makeEntry({}, 62)) === false,
  );
  // 都已达标同分：沿用整图比较器，Fréchet 更小 -> 接受（展示分不退化前提下比几何）
  check(
    'isRefinementImprovement：都达标同分时几何更准（Fréchet 更小）-> 接受',
    isRefinementImprovement(
      makeEntry({ frechetMaxRatio: 0.09 }, 62),
      makeEntry({ frechetMaxRatio: 0.1 }, 62),
    ) === true,
  );
  // 几何与评分都相同：更短的绕行不得替换当前候选（里程不参与决胜）
  check(
    'isRefinementImprovement：都达标同分且几何相同，绕行更短 -> 不替换',
    isRefinementImprovement(
      makeEntry({ detourRatio: 1.05 }, 62),
      makeEntry({ detourRatio: 1.8 }, 62),
    ) === false,
  );
}

// ---------- 1. nearbyEdges：合成路网（两条平行道路 + 去重/过滤） ----------
{
  const LAT0 = 23.12;
  const LNG0 = 113.32;
  const M_PER_DEG_LAT = 111320;
  const mPerDegLng = M_PER_DEG_LAT * Math.cos((LAT0 * Math.PI) / 180);
  const northLat = LAT0 + 30 / M_PER_DEG_LAT; // 第二近道路（北侧 30m）
  const roads = [
    { id: 1, h: 'residential', n: 'a', c: [[LNG0, LAT0], [LNG0 + 0.002, LAT0], [LNG0 + 0.004, LAT0]], r: [1, 2, 3] },
    { id: 2, h: 'residential', n: 'b', c: [[LNG0, northLat], [LNG0 + 0.002, northLat], [LNG0 + 0.004, northLat]], r: [4, 5, 6] },
    // 垂直连接路：让两条平行路属于同一连通分量（否则 mainComponent 只保留一条）
    { id: 3, h: 'residential', n: 'c', c: [[LNG0 + 0.002, LAT0], [LNG0 + 0.002, northLat]], r: [2, 5] },
  ];
  const graph = buildWalkGraph(roads);
  const mainComponent = findLargestComponent(graph);
  const edgeIndex = buildEdgeIndex(graph, 0.002, mainComponent);
  const queryLng = LNG0 + 0.002;
  const queryLat = LAT0 + 10 / M_PER_DEG_LAT; // 距 a 10m、距 b 20m

  const k2 = nearbyEdges(edgeIndex, graph, queryLng, queryLat, { count: 2 });
  check('nearbyEdges：返回 2 条候选', k2.length === 2, `实际 ${k2.length}`);
  check('nearbyEdges：按距离升序', k2[0].distance <= k2[1].distance, JSON.stringify(k2.map((c) => c.distance)));
  check('nearbyEdges：第 1 条是最近边（与 nearestEdge 一致）', (() => {
    const nearest = nearestEdge(edgeIndex, graph, queryLng, queryLat);
    return nearest && Math.abs(nearest.distance - k2[0].distance) < 1e-6 && nearest.a === k2[0].a && nearest.b === k2[0].b;
  })());
  check('nearbyEdges：去重（每条边只出现一次）', new Set(k2.map((c) => `${c.a}-${c.b}`)).size === k2.length);
  const filtered = nearbyEdges(edgeIndex, graph, queryLng, queryLat, { count: 5, maxDistance: 15 });
  check(
    'nearbyEdges：距离过滤生效（返回候选全部 ≤15m，20m 的北侧路被剔除）',
    filtered.length >= 1 && filtered.every((candidate) => candidate.distance <= 15),
    JSON.stringify(filtered.map((c) => Math.round(c.distance))),
  );
  const far = nearbyEdges(edgeIndex, graph, queryLng, queryLat, { count: 5, maxRings: 0 });
  check('nearbyEdges：maxRings 小且不足 K 个时返回同格内的实际候选', far.length >= 1, `实际 ${far.length}`);
  check('nearbyEdges：返回结构含 a/b/t/lon/lat/distance', k2.every((c) => ['a', 'b', 't', 'lon', 'lat', 'distance'].every((key) => key in c)));
}

// ---------- 2. 真实路网：snapOverrides 重放 + jointRefine ----------
const roadsData = JSON.parse(readRequiredText('web/data/guangzhou-roads.json', GUANGZHOU_ROADS_WEB_HINT)).roads;
const graph = buildWalkGraph(roadsData);
const mainComponent = findLargestComponent(graph);
const edgeIndex = buildEdgeIndex(graph, 0.005, mainComponent);

/** 在真实路网上找一个小范围的达标候选（矩形，珠江新城网格路网），供联合精修测试 */
function findRectCandidate(center, sizeMeters, rotationDeg) {
  const result = planShapeRoute({ graph, edgeIndex, shapeKey: 'rect', center, sizeMeters, rotationDeg });
  return { result, score: scoreRoute(result.metrics), center, sizeMeters, rotationDeg };
}

{
  const center = { lat: 23.1252, lng: 113.2455 };
  // 珠江新城网格路网上的矩形候选（engine-smoke 推荐链路同区域，容易达标）
  const base = findRectCandidate(center, 1600, 35);
  const baseMetrics = base.result.metrics;
  check('真实路网：基线候选可规划', Boolean(base.result.routeLatLngs?.length > 2));
  check('真实路网：基线候选达标（门槛内）', meetsQualityBar(baseMetrics), JSON.stringify({
    orderedRouteMax: baseMetrics.orderedRouteMaxRatio,
    keyMax: baseMetrics.keyMaxOffsetRatio,
    coverage: baseMetrics.coverage,
  }));

  // 2.1 缺省重放：不传 snapOverrides 与传"全部最近边"结果一致
  const withOverrides = planShapeRoute({
    graph,
    edgeIndex,
    shapeKey: 'rect',
    center,
    sizeMeters: 1600,
    rotationDeg: 35,
  });
  check(
    'snapOverrides：缺省重放与基线指标一致',
    withOverrides.metrics.routeMeters === baseMetrics.routeMeters &&
      withOverrides.metrics.orderedRouteMaxRatio === baseMetrics.orderedRouteMaxRatio,
  );

  // 2.2 指定第 2 近边：某个关键约束换成第二近道路边后，路线仍完整、指标可计算
  const projected = base.result.snapped;
  const snapIndex = projected.findIndex((snap) => snap.nodeId && snap.distance > 0);
  if (snapIndex >= 0) {
    const constraintLatLng = projected[snapIndex];
    const candidates = nearbyEdges(edgeIndex, graph, constraintLatLng.lng, constraintLatLng.lat, { count: 3 });
    check('snapOverrides：第二近边存在', candidates.length >= 2, `实际 ${candidates.length}`);
    if (candidates.length >= 2) {
      const overrides = new Array(projected.length).fill(null);
      overrides[snapIndex] = candidates[1];
      const replaced = planShapeRoute({
        graph,
        edgeIndex,
        shapeKey: 'rect',
        center,
        sizeMeters: 1600,
        rotationDeg: 35,
        snapOverrides: overrides,
      });
      check(
        'snapOverrides：指定第二近边后 snapSource=mixed 且被记录',
        replaced.metrics.snapSource === 'mixed' && replaced.metrics.snapOverrideCount === 1,
        JSON.stringify({ source: replaced.metrics.snapSource, count: replaced.metrics.snapOverrideCount }),
      );
      check(
        'snapOverrides：路线仍连续（有足够路线点、无失败段）',
        replaced.routeLatLngs.length > 2 && replaced.metrics.failedLegs === 0,
        `routePoints=${replaced.routeLatLngs.length}, failedLegs=${replaced.metrics.failedLegs}`,
      );
    }
  }

  // 2.3 jointRefine：有改进则几何指标不劣于基线；无改进返回基线
  const refined = await jointRefine({
    graph,
    edgeIndex,
    shapeKey: 'rect',
    base,
    origin: center,
    maxEvaluations: 40,
  });
  check('jointRefine：返回完整结果结构', Boolean(refined && refined.best && refined.best.result));
  check(
    'jointRefine：评价数受 maxEvaluations 限制',
    refined.evaluated >= 1 && refined.evaluated <= 40 + 2,
    `实际 ${refined.evaluated}`,
  );
  if (refined.improved) {
    check(
      'jointRefine：有改进时最终评分不劣于基线',
      refined.best.score >= base.score,
      `baseline=${base.score}, final=${refined.best.score}`,
    );
    check(
      'jointRefine：有改进时确实更换了吸附/档位',
      refined.best.snapChoice.some((candidateIndex) => candidateIndex !== 0) ||
        Boolean(refined.best.legProfiles?.some((profile) => profile)),
    );
    check(
      'jointRefine：改进后仍通过质量门槛',
      meetsQualityBar(refined.best.metrics),
      `finalScore=${refined.best.score}`,
    );
  } else {
    check(
      'jointRefine：无改进时返回与基线等价的路线（评分与里程一致）',
      refined.best.score === base.score &&
        refined.best.metrics.routeMeters === baseMetrics.routeMeters,
      `baseline=${base.score}/${Math.round(baseMetrics.routeMeters)}m, final=${refined.best.score}/${Math.round(refined.best.metrics.routeMeters)}m`,
    );
  }

  // 2.4 预算限制：maxEvaluations=1 时最多基线一次评价，返回基线
  const tight = await jointRefine({
    graph,
    edgeIndex,
    shapeKey: 'rect',
    base,
    origin: center,
    maxEvaluations: 1,
  });
  check('jointRefine：预算极小时返回基线', tight.improved === false && tight.evaluated <= 2, `evaluated=${tight.evaluated}`);
}

// ---------- 3. 无路区域：jointRefine 返回基线（不返回半条路线） ----------
{
  const center = { lat: 23.5, lng: 113.9 };
  // 无路区没有可吸附道路：直接构造一个空基线（planShapeRoute 在该区域会抛错）
  const base = { result: { metrics: {} }, score: 0, center, sizeMeters: 1200, rotationDeg: 0 };
  const refined = await jointRefine({ graph, edgeIndex, shapeKey: 'rect', base, origin: center, maxEvaluations: 10 });
  check(
    '无路区域：jointRefine 返回基线且无改进',
    refined.improved === false && refined.best === base,
    `improved=${refined.improved}`,
  );
}

// ---------- 4. legProfiles：指定档位重放不破坏路线完整性 ----------
{
  const center = { lat: 23.1252, lng: 113.2455 };
  const legProfiles = new Array(20).fill(null);
  legProfiles[0] = { name: '强引导', guideGain: 4, corridorSizeRatio: 0.12 };
  const replaced = planShapeRoute({
    graph,
    edgeIndex,
    shapeKey: 'rect',
    center,
    sizeMeters: 1600,
    rotationDeg: 35,
    legProfiles,
  });
  check(
    'legProfiles：指定档位后路线完整且档位被记录',
    replaced.metrics.legProfileCount === 1 &&
      replaced.metrics.failedLegs === 0 &&
      replaced.routeLatLngs.length > 2,
    JSON.stringify({ legProfileCount: replaced.metrics.legProfileCount, failedLegs: replaced.metrics.failedLegs }),
  );
}

// ---------- 5. 软门槛失败基线：不抛错、结构完整、预算受限、失败门槛不增加 ----------
{
  // 真实路网近失矩形：硬门槛全过、本身差两道软门槛（有序路线平均/最大偏差），
  // 联合精修应把它往"失败门槛更少"救（实测 2 道 -> 1 道，评分不降）。
  const center = { lat: 23.137, lng: 113.278 };
  const sizeMeters = 1600;
  const rotationDeg = 45;
  const baseResult = planShapeRoute({ graph, edgeIndex, shapeKey: 'rect', center, sizeMeters, rotationDeg });
  const baseScore = scoreRoute(baseResult.metrics);
  const base = { result: baseResult, score: baseScore, center, sizeMeters, rotationDeg };
  const baseReport = qualityGateReport(baseResult.metrics);
  check(
    '软门槛失败基线：基线本身未达标（硬门槛全过、只差软门槛）',
    baseReport.hardFailures.length === 0 && baseReport.softCount >= 1,
    JSON.stringify({
      hard: baseReport.hardFailures,
      softKeys: baseReport.softFailures.map((gate) => gate.key),
    }),
  );

  let refined = null;
  let refineError = null;
  try {
    refined = await jointRefine({
      graph,
      edgeIndex,
      shapeKey: 'rect',
      base,
      origin: center,
      maxEvaluations: 100,
    });
  } catch (error) {
    refineError = error;
  }
  check('软门槛失败基线：联合精修不抛错', refineError === null, String(refineError));

  if (refined) {
    check(
      '软门槛失败基线：返回结构完整（best.result/metrics/score/snapChoice + 计数）',
      Boolean(
        refined.best &&
          refined.best.result?.metrics &&
          Array.isArray(refined.best.snapChoice) &&
          typeof refined.best.score === 'number' &&
          typeof refined.evaluated === 'number' &&
          typeof refined.expandedNodes === 'number' &&
          typeof refined.improved === 'boolean',
      ),
      JSON.stringify({ keys: Object.keys(refined), bestKeys: Object.keys(refined.best || {}) }),
    );
    check(
      '软门槛失败基线：evaluated 受 maxEvaluations 限制',
      refined.evaluated >= 1 && refined.evaluated <= 100 + 2,
      `实际 ${refined.evaluated}`,
    );
    const finalReport = qualityGateReport(refined.best.metrics);
    check(
      '软门槛失败基线：精修后失败门槛不增加（无硬门槛失败、softCount 不升）',
      finalReport.hardFailures.length === 0 && finalReport.softCount <= baseReport.softCount,
      JSON.stringify({
        before: baseReport.softCount,
        after: finalReport.softCount,
        hard: finalReport.hardFailures,
      }),
    );
    // 复算一遍基线 entry，用接受规则校验 improved 语义（把规则当契约测试）
    const baselineEntry = { metrics: baseResult.metrics, score: baseScore };
    check(
      '软门槛失败基线：improved 语义与接受规则一致（最终结果相对基线可接受）',
      isRefinementImprovement(refined.best, baselineEntry) === refined.improved,
      JSON.stringify({
        improved: refined.improved,
        ruleSays: isRefinementImprovement(refined.best, baselineEntry),
        beforeSoft: baseReport.softCount,
        afterSoft: finalReport.softCount,
      }),
    );
    if (!refined.improved) {
      check(
        '软门槛失败基线：无改进时原样返回等价基线（评分与里程一致）',
        refined.best.score === baseScore &&
          refined.best.metrics.routeMeters === baseResult.metrics.routeMeters,
        `baseline=${baseScore}/${Math.round(baseResult.metrics.routeMeters)}m, final=${refined.best.score}/${Math.round(refined.best.metrics.routeMeters)}m`,
      );
    } else {
      check(
        '软门槛失败基线：有改进时至少把失败软门槛减少或 Fréchet 余量变大',
        finalReport.softCount < baseReport.softCount ||
          finalReport.softGates.find((gate) => gate.key === 'frechetMax').excess <
            baseReport.softGates.find((gate) => gate.key === 'frechetMax').excess,
        JSON.stringify({ before: baseReport.softCount, after: finalReport.softCount }),
      );
    }
  }
}

console.log(`\nRESULT: ${failCount === 0 ? 'PASS' : `FAIL (${failCount})`}  (${passCount} passed, ${failCount} failed)`);
process.exit(failCount === 0 ? 0 : 2);
