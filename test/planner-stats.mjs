/**
 * D2 回归：段寻路失败时 searchStats 被重复累加（缺陷修复用例 T-D2）。
 *
 * 缺陷：planner.js 的引导尝试循环已把每次尝试的 `leg.stats` 累加进 searchStats
 * （expandedNodes / relaxedEdges / prunedNodes / cappedLegs），失败分支又对同一份
 * `leg.stats` 再累加一次 —— 段寻路超扩展上限（capped A*）时统计翻倍，诊断指标失真。
 *
 * 构造（合成路网，无大文件、无真实路网依赖）：
 * - 左右两块各 111×161 的网格路网（间距 100m），中间留 1000m 宽"无路带"；
 * - 只在 y=+7000m 用一条桥路连接两侧（唯一通路，绕行很远）；
 * - 图形两个约束点分别落在无路带两侧的网格节点上（吸附距离 0，远低于 120m 硬门槛），
 *   两点相距 10000m，两条形状腿都必须跨过无路带；
 * - 引导两级走廊（270m / 675m）被无路带切断 → 两次尝试失败且不触发上限；
 *   第三级兜底纯最短路绕桥 → 扩展数超过 MAX_EXPANDED_PER_LEG=12000 → 该腿失败。
 *
 * 断言（改前红 / 改后绿）：
 * - 两条形状腿都失败（failedLegs=2，构造命中，必须成立）；
 * - cappedLegs === failedLegs（改前每个失败腿被记两次 → 4）；
 * - expandedNodes < failedLegs × 2 × 12000（改前把同一份 capped 统计加两遍）。
 *
 * 运行：node test/planner-stats.mjs
 */

import { buildWalkGraph, buildEdgeIndex, findLargestComponent } from '../web/src/engine/graph.js';
import { planShapeRoute } from '../web/src/engine/planner.js';

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

/** 单段 A* 扩展硬上限（与 planner.js MAX_EXPANDED_PER_LEG 同口径，断言用） */
const MAX_EXPANDED_PER_LEG = 12000;

/**
 * 构造一块网格路网（横竖各 seam 条道路，节点间距 stepMeters）。
 *
 * @param {object} options 参数
 * @param {number} options.idBase 节点 id 基址（左右两块用不同基址避免冲突）
 * @param {number} options.xStart 最西节点 x（米）
 * @param {number} options.xEnd 最东节点 x（米）
 * @param {number} options.yStart 最南节点 y（米）
 * @param {number} options.yEnd 最北节点 y（米）
 * @param {number} options.stepMeters 节点间距（米）
 * @returns {{roads: Array<object>, nodeId: Function}} 道路数组与节点 id 查询
 */
function buildGrid({ idBase, xStart, xEnd, yStart, yEnd, stepMeters }) {
  const cols = Math.round((xEnd - xStart) / stepMeters) + 1;
  const rows = Math.round((yEnd - yStart) / stepMeters) + 1;
  /** 网格节点 id：横竖道路在节点处共享同一 id，形成真正路口 */
  const nodeId = (col, row) => idBase + col * 1000 + row;
  const coordOf = (col, row) => [lngOf(xStart + col * stepMeters), latOf(yStart + row * stepMeters)];
  const roads = [];
  let roadId = idBase;
  // 横向道路：每行一条
  for (let row = 0; row < rows; row += 1) {
    const refs = [];
    const coords = [];
    for (let col = 0; col < cols; col += 1) {
      refs.push(nodeId(col, row));
      coords.push(coordOf(col, row));
    }
    roads.push({ id: (roadId += 1), h: 'residential', n: `横${row}`, c: coords, r: refs });
  }
  // 纵向道路：每列一条
  for (let col = 0; col < cols; col += 1) {
    const refs = [];
    const coords = [];
    for (let row = 0; row < rows; row += 1) {
      refs.push(nodeId(col, row));
      coords.push(coordOf(col, row));
    }
    roads.push({ id: (roadId += 1), h: 'residential', n: `纵${col}`, c: coords, r: refs });
  }
  return { roads, nodeId };
}

// ---------- 构造：左右网格 + 远端桥 + 跨无路带的两约束图形 ----------
const STEP = 100;
const Y_MIN = -8000;
const Y_MAX = 8000;
const COLS = 111;
const ROWS = 161;
const left = buildGrid({ idBase: 1_000_000, xStart: -11500, xEnd: -500, yStart: Y_MIN, yEnd: Y_MAX, stepMeters: STEP });
const right = buildGrid({ idBase: 2_000_000, xStart: 500, xEnd: 11500, yStart: Y_MIN, yEnd: Y_MAX, stepMeters: STEP });
/** 桥：y=+7000m 处连接左右网格（无路带上的唯一通路） */
const bridge = {
  id: 1,
  h: 'residential',
  n: '桥',
  c: [[lngOf(-500), latOf(7000)], [lngOf(500), latOf(7000)]],
  r: [left.nodeId(COLS - 1, 150), right.nodeId(0, 150)],
};
const graph = buildWalkGraph([...left.roads, ...right.roads, bridge]);
const mainComponent = findLargestComponent(graph);
const edgeIndex = buildEdgeIndex(graph, 0.005, mainComponent);

console.log(
  `[graph] nodes=${graph.nodeCount} edges=${graph.edgeCount} component=${mainComponent.size}`,
);
check(
  '构造：路网建成且全连通（两网格经桥连成一个分量）',
  graph.nodeCount === 2 * COLS * ROWS && mainComponent.size === graph.nodeCount,
  `nodes=${graph.nodeCount}, component=${mainComponent.size}`,
);

/** 图形：两个约束点相距 10000m，都落在网格节点上（吸附距离 0） */
const sizeMeters = 10000;
const center = { lat: latOf(0), lng: lngOf(0) };
const customShape = {
  name: '跨无路带两点',
  constraintPoints: [[-0.5, 0], [0.5, 0]],
  outlinePoints: [[-0.5, 0], [0.5, 0]],
};
const started = Date.now();
const result = planShapeRoute({ graph, edgeIndex, customShape, center, sizeMeters, rotationDeg: 0 });
const elapsedMs = Date.now() - started;
const metrics = result.metrics;
const stats = metrics.searchStats;
console.log(
  `[plan] ${elapsedMs}ms failedLegs=${metrics.failedLegs} routePoints=${metrics.routePointCount} ` +
    `expanded=${stats.expandedNodes} relaxed=${stats.relaxedEdges} pruned=${stats.prunedNodes} capped=${stats.cappedLegs}`,
);

check('构造命中：两条形状腿都因超扩展上限失败（不是吸附短路、不是不可达）', metrics.failedLegs === 2 && metrics.routePointCount === 0, `failedLegs=${metrics.failedLegs}, routePoints=${metrics.routePointCount}`);
check('构造命中：失败原因是 capped（搜索超上限）而不是纯不可达', stats.cappedLegs > 0, `cappedLegs=${stats.cappedLegs}`);
check(
  'D2 failedLegs 只按失败腿计一次',
  metrics.failedLegs === 2,
  `failedLegs=${metrics.failedLegs}`,
);
check(
  'D2 cappedLegs 每个失败腿只记一次（改前失败分支重复累加 → 4）',
  stats.cappedLegs === metrics.failedLegs,
  `cappedLegs=${stats.cappedLegs}, failedLegs=${metrics.failedLegs}`,
);
check(
  'D2 expandedNodes 不因失败分支重复累加而翻倍',
  stats.expandedNodes < metrics.failedLegs * 2 * MAX_EXPANDED_PER_LEG,
  `expandedNodes=${stats.expandedNodes} >= ${metrics.failedLegs * 2 * MAX_EXPANDED_PER_LEG}`,
);
check('D2 relaxedEdges 为有限正数（统计未污染成 NaN/0）', Number.isFinite(stats.relaxedEdges) && stats.relaxedEdges > 0, `relaxedEdges=${stats.relaxedEdges}`);
check('D2 prunedNodes 为有限非负数（走廊过滤统计可读）', Number.isFinite(stats.prunedNodes) && stats.prunedNodes >= 0, `prunedNodes=${stats.prunedNodes}`);

console.log(`\nRESULT: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}  (${checks - failures} passed, ${failures} failed)`);
process.exit(failures === 0 ? 0 : 2);
