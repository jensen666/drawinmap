/**
 * D3 回归：吸附短路分支 metrics 与正常分支口径漂移（缺陷修复用例 T-D3）。
 *
 * 缺陷：planner.js 的"吸附硬门槛短路"分支手抄了 57 个 metrics 字段，正常分支用
 * `...ordered` / `...fidelity` 展开；短路分支缺 orderedOutlineRms / orderedRouteRms /
 * snapSource / snapOverrideCount / legProfileCount —— 落无路区/水面的候选被排序与
 * 诊断时读到 undefined，与正常候选不同口径。
 *
 * 构造（合成水平直路，无大文件）：
 * - 主路：y=0 直线，x ∈ [-2000, 2000]，节点间距 100m；
 * - 4 点小矩形（约束点 y 偏移 ±20m，吸附距离 20m < 120m 硬门槛）：
 *   - 正常场景 center=(0,0) → 正常规划出路线；
 *   - 短路场景 center=(0,500) → 吸附距离 500m > SNAP_HARD_GATE_METERS=120，走吸附短路。
 *
 * 断言（改前红 / 改后绿）：
 * - 短路结果 routePointCount=0、failedLegs=0、routeMeters=0；
 * - 白名单 5 字段齐全、短路值为 Infinity / 默认值，typeof 正确；
 * - 短路 metrics 键集与正常 metrics 键集一致（缺失数为 0）；
 * - selection.js 吃短路 metrics 不抛错、不产出 NaN 分。
 *
 * 运行：node test/planner-shortcircuit.mjs
 */

import { buildWalkGraph, buildEdgeIndex, findLargestComponent } from '../web/src/engine/graph.js';
import { planShapeRoute } from '../web/src/engine/planner.js';
import { selectByRule, worseSideRmsOf, candidateCostMetrics } from '../web/src/engine/selection.js';

let failures = 0;
let checks = 0;

/**
 * 断言工具：记录并通过/失败计数。
 *
 * @param {string} label 用例标签
 * @param {boolean} condition 是否通过
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

const M_PER_DEG_LAT = 111320;
const LAT0 = 23.12;
const LNG0 = 113.32;
const mPerDegLng = M_PER_DEG_LAT * Math.cos((LAT0 * Math.PI) / 180);
/** 局部米坐标 → 经纬度（x 向东、y 向北，原点 LAT0/LNG0） */
const latOf = (m) => LAT0 + m / M_PER_DEG_LAT;
const lngOf = (m) => LNG0 + m / mPerDegLng;

/** 吸附硬门槛（米，与 planner.js SNAP_HARD_GATE_METERS 同口径，断言用） */
const SNAP_HARD_GATE_METERS = 120;

// ---------- 合成路网：y=0 水平直路，x ∈ [-2000, 2000]，间距 100m ----------
const roadCoords = [];
const roadRefs = [];
for (let i = 0; i <= 40; i += 1) {
  roadCoords.push([lngOf(-2000 + i * 100), latOf(0)]);
  roadRefs.push(i + 1);
}
const graph = buildWalkGraph([{ id: 1, h: 'residential', n: '直路', c: roadCoords, r: roadRefs }]);
const mainComponent = findLargestComponent(graph);
const edgeIndex = buildEdgeIndex(graph, 0.005, mainComponent);

/** 4 点小矩形：x 半宽 800m、y 偏移 ±20m（正常场景吸附 20m，短路场景 500m 级别偏移） */
const sizeMeters = 2000;
const customShape = {
  name: '贴路矩形',
  constraintPoints: [
    [-0.4, -0.01],
    [0.4, -0.01],
    [0.4, 0.01],
    [-0.4, 0.01],
  ],
  outlinePoints: [
    [-0.4, -0.02],
    [-0.4, 0.02],
    [0.4, 0.02],
    [0.4, -0.02],
  ],
};
/** 正常场景：中心在路面上，约束点吸附距离 20m，正常规划 */
const normal = planShapeRoute({
  graph,
  edgeIndex,
  customShape,
  center: { lat: latOf(0), lng: lngOf(0) },
  sizeMeters,
  rotationDeg: 0,
});
/** 短路场景：中心北移 500m，全部约束点吸附距离 >120m → 吸附硬门槛短路 */
const short = planShapeRoute({
  graph,
  edgeIndex,
  customShape,
  center: { lat: latOf(500), lng: lngOf(0) },
  sizeMeters,
  rotationDeg: 0,
});
const normalMetrics = normal.metrics;
const shortMetrics = short.metrics;
console.log(
  `[normal] failedLegs=${normalMetrics.failedLegs} routePoints=${normalMetrics.routePointCount} ` +
    `snapMax=${Math.round(normalMetrics.snapMaxMeters)}m routeMeters=${Math.round(normalMetrics.routeMeters)}m`,
);
console.log(
  `[short] failedLegs=${shortMetrics.failedLegs} routePoints=${shortMetrics.routePointCount} ` +
    `snapMax=${Math.round(shortMetrics.snapMaxMeters)}m routeMeters=${shortMetrics.routeMeters}m`,
);

// ---------- 1. 场景自检：正常分支真的正常、短路分支真的短路 ----------
check(
  '构造命中：正常场景走出路线（非短路，failedLegs=0）',
  normalMetrics.failedLegs === 0 && normalMetrics.routePointCount > 2 && normalMetrics.snapMaxMeters < SNAP_HARD_GATE_METERS,
  `failedLegs=${normalMetrics.failedLegs}, routePoints=${normalMetrics.routePointCount}, snapMax=${normalMetrics.snapMaxMeters}`,
);
check(
  '构造命中：短路场景确实走吸附硬门槛短路（无路线、无失败段）',
  shortMetrics.routePointCount === 0 && shortMetrics.routeMeters === 0 && shortMetrics.snapMaxMeters > SNAP_HARD_GATE_METERS,
  `routePoints=${shortMetrics.routePointCount}, routeMeters=${shortMetrics.routeMeters}, snapMax=${shortMetrics.snapMaxMeters}`,
);
check('短路场景 failedLegs=0（没寻路就没有失败段）', shortMetrics.failedLegs === 0, `failedLegs=${shortMetrics.failedLegs}`);

// ---------- 2. 白名单 5 字段齐全且值口径正确 ----------
const whitelist = ['orderedOutlineRms', 'orderedRouteRms', 'snapSource', 'snapOverrideCount', 'legProfileCount'];
for (const key of whitelist) {
  check(
    `白名单字段齐全：short.metrics.${key}`,
    Object.prototype.hasOwnProperty.call(shortMetrics, key),
    `keys=${Object.keys(shortMetrics).length}`,
  );
}
check(
  '短路值口径：orderedOutlineRms/orderedRouteRms 为 Infinity（无路线最差值）',
  shortMetrics.orderedOutlineRms === Number.POSITIVE_INFINITY
    && shortMetrics.orderedRouteRms === Number.POSITIVE_INFINITY,
  `outlineRms=${shortMetrics.orderedOutlineRms}, routeRms=${shortMetrics.orderedRouteRms}`,
);
check(
  '短路值口径：snapSource=nearest、count 类为 0、typeof 正确',
  shortMetrics.snapSource === 'nearest'
    && shortMetrics.snapOverrideCount === 0
    && shortMetrics.legProfileCount === 0
    && typeof shortMetrics.snapOverrideCount === 'number'
    && typeof shortMetrics.legProfileCount === 'number',
  `snapSource=${shortMetrics.snapSource}, overrides=${shortMetrics.snapOverrideCount}, profiles=${shortMetrics.legProfileCount}`,
);

// ---------- 3. 键集一致：短路分支不得少于正常分支 ----------
const normalKeys = Object.keys(normalMetrics);
const shortKeys = Object.keys(shortMetrics);
const missingInShort = normalKeys.filter((key) => !shortKeys.includes(key));
const missingInNormal = shortKeys.filter((key) => !normalKeys.includes(key));
check(
  '键集：正常分支的 metrics 键在短路分支全部存在（缺失 0）',
  missingInShort.length === 0,
  `missing=${JSON.stringify(missingInShort)}`,
);
check(
  '键集：短路分支的 metrics 键在正常分支全部存在（多出 0）',
  missingInNormal.length === 0,
  `extra=${JSON.stringify(missingInNormal)}`,
);

// ---------- 4. 排序/诊断吃短路 metrics：不抛错、不产 NaN ----------
let selectionError = null;
let selected = null;
try {
  selected = selectByRule(
    [{ result: { metrics: shortMetrics }, score: 70, sizeMeters, center: { lat: latOf(500), lng: lngOf(0) } }],
    'current',
    { origin: { lat: latOf(0), lng: lngOf(0) } },
  );
} catch (error) {
  selectionError = error;
}
check('selection：selectByRule 吃短路 metrics 不抛错', selectionError === null && selected !== null, String(selectionError));
const costMetrics = candidateCostMetrics({ result: { metrics: shortMetrics }, score: 70, sizeMeters });
check(
  'selection：候选成本指标无 NaN（worseSideRms 缺失就是 Infinity，不是 NaN）',
  Object.entries(costMetrics).every(([, value]) => typeof value !== 'number' || Number.isFinite(value) || value === Number.POSITIVE_INFINITY),
  JSON.stringify(costMetrics),
);
check(
  'selection：worseSideRmsOf(短路) = Infinity（不冒充最贴合候选）',
  worseSideRmsOf({ metrics: shortMetrics }) === Number.POSITIVE_INFINITY,
  String(worseSideRmsOf({ metrics: shortMetrics })),
);

console.log(`\nRESULT: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}  (${checks - failures} passed, ${failures} failed)`);
process.exit(failures === 0 ? 0 : 2);
