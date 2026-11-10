/**
 * 图形规划引擎冒烟测试（Node 直接运行，不依赖浏览器）。
 *
 * 覆盖：
 * - 路网图构建（节点/边数量）
 * - 图形模型：关键点识别（角点/尖端/锚点）、LLM 点列不误判
 * - 寻路：默认最短路不变、引导代价选靠目标段的路、走廊硬过滤、扩展上限
 * - 规划器：走廊引导寻路、同边投影不绕端点、关键点塌缩/覆盖指标、有序指标
 * - 有序分段贴合：贴错边/顺序断裂/缺段反例（全局指标的盲区）
 * - 候选搜索：评分/质量门槛/双最优记录/尽力链/自定义图形
 * - 双重预算：时间与候选数耗尽只返回已达标结果并标记 budgetExhausted
 * - 只给条件时的实测推荐（recommendShapes）
 * - 固定正反例（珠江新城旧反例必须拦截；越秀公园/广州塔/陈家祠正例）与性能预算
 *
 * 运行：node test/engine-smoke.mjs
 * 环境：shell 无独立 node 时，用任意可用 Node ≥ 20 运行（开发机为 nvm Node 22）。
 */

import { GUANGZHOU_ROADS_HINT, readRequiredText } from './lib/require-data.mjs';
import {
  buildEdgeIndex,
  buildNodeIndex,
  buildWalkGraph,
  distanceMeters,
  findLargestComponent,
  graphBounds,
  nearestEdge,
  pointInBounds,
} from '../web/src/engine/graph.js';
import { shortestPath } from '../web/src/engine/pathfinding.js';
import { buildShapeModel } from '../web/src/engine/shape-model.js';
import { orderedFidelity } from '../web/src/engine/fidelity.js';
import { planShapeRoute } from '../web/src/engine/planner.js';
import {
  ESCALATION_STAGES,
  GOOD_ENOUGH_SCORE,
  RECOMMEND_MAX_CANDIDATES,
  RECOMMEND_TIME_BUDGET_MS,
  meetsQualityBar,
  recommendShapes,
  scoreRoute,
  searchBestCandidate,
  searchWithEscalation,
} from '../web/src/engine/candidates.js';
import { worseSideRmsOf } from '../web/src/engine/selection.js';

/** 某一级的位置 × 朝向 × 尺寸档候选数 */
function stageCandidateCount(stage, rotationCount) {
  return (stage.gridRadius * 2 + 1) ** 2 * rotationCount * stage.sizeFactors.length;
}

/** 按当前阶梯加总候选数。includeLarge 为 false 时不含「更大比例尺」级。 */
function ladderCandidateCount(rotationCount, { includeLarge = true } = {}) {
  return ESCALATION_STAGES.reduce((sum, stage) => {
    if (stage.alwaysRun && !includeLarge) return sum;
    return sum + stageCandidateCount(stage, rotationCount);
  }, 0);
}

const DATA_URL = new URL('../mapdata/guangzhou-roads.json', import.meta.url);
const roads = JSON.parse(readRequiredText(DATA_URL, GUANGZHOU_ROADS_HINT)).roads;
const graph = buildWalkGraph(roads);
const mainComponent = findLargestComponent(graph);
const nodeIndex = buildNodeIndex(graph, 0.005, mainComponent);
const edgeIndex = buildEdgeIndex(graph, 0.005, mainComponent);
console.log(
  `[graph] 节点 ${graph.nodeCount} / 边 ${graph.edgeCount} / 主连通分量 ${mainComponent.size}`,
);

let failures = 0;
/** 记录一组检查并打印单行结果 */
function checkSection(label, checks) {
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length > 0) {
    failures += 1;
  }
  console.log(`[${label}] -> ${failed.length === 0 ? 'PASS' : `FAIL(${failed.join(',')})`}`);
  return failed.length === 0;
}

/** 折线长度（米） */
function polylineMeters(latlngs) {
  let total = 0;
  for (let i = 1; i < latlngs.length; i += 1) {
    total += distanceMeters(latlngs[i - 1][0], latlngs[i - 1][1], latlngs[i][0], latlngs[i][1]);
  }
  return total;
}

/** 判断路线是否连续（相邻点距离不超过阈值） */
function isContinuous(latlngs, maxGapMeters = 800) {
  if (latlngs.length < 2) {
    return false;
  }
  for (let i = 1; i < latlngs.length; i += 1) {
    if (distanceMeters(latlngs[i - 1][0], latlngs[i - 1][1], latlngs[i][0], latlngs[i][1]) > maxGapMeters) {
      return false;
    }
  }
  return true;
}

const zhujiangXincheng = { lat: 23.1198, lng: 113.3245 };

// ---------- 0. 覆盖范围：包围盒与范围判定（覆盖外地点预检的数据基础） ----------
{
  const bounds = graphBounds(graph);
  // 覆盖外反例：兰桂社区不在广州核心区路网内（约 23.1°N 以外的佛山地带）
  const outside = { lat: 23.02, lng: 113.11 };
  const nearbyOutside = {
    lat: bounds.maxLat + 0.02,
    lng: (bounds.minLng + bounds.maxLng) / 2,
  };
  checkSection('coverage', [
    ['bounds_present', bounds !== null && bounds.minLat < bounds.maxLat],
    [
      'guangzhou_inside',
      pointInBounds(bounds, zhujiangXincheng) && pointInBounds(bounds, { lat: 23.1066, lng: 113.3246 }),
    ],
    ['outside_rejected', !pointInBounds(bounds, outside) && !pointInBounds(bounds, nearbyOutside)],
    // 边距：贴边 ~1km 内仍算覆盖内（搜索网格会外扩）
    [
      'margin_tolerance',
      pointInBounds(bounds, nearbyOutside, 0.02) && !pointInBounds(bounds, outside, 0.01),
    ],
  ]);
}

// ---------- 1. 图形模型：关键点识别 ----------
{
  const star = buildShapeModel({ shapeKey: 'star' });
  const rect = buildShapeModel({ shapeKey: 'rect' });
  const heart = buildShapeModel({ shapeKey: 'heart' });
  const keyIdx = (m) => new Set(m.constraints.filter((c) => c.key).map((c) => c.outlineIndex));
  const starKeys = keyIdx(star);
  const rectKeys = keyIdx(rect);
  // LLM 风格 16 点圆（坐标量化到 2 位小数）：只有闭环锚点是关键点
  const llmCircle = Array.from({ length: 16 }, (_, i) => {
    const t = (Math.PI * 2 * i) / 16;
    return [Math.round(Math.cos(t) * 45) / 100, Math.round(Math.sin(t) * 45) / 100];
  });
  const circle = buildShapeModel({
    customShape: { name: '圆形', constraintPoints: llmCircle, outlinePoints: llmCircle },
  });
  const triangle = buildShapeModel({
    customShape: { name: '三角', constraintPoints: [[0, -0.5], [0.45, 0.4], [-0.45, 0.4]], outlinePoints: [[0, -0.5], [0.45, 0.4], [-0.45, 0.4]] },
  });
  checkSection('shape-model', [
    // 对称图形的关键点必须对称：5 外尖 + 5 内凹全部受保护（45° 门槛曾漏掉
    // 内凹点 9/21 造成同类特征保护不一致，阈值降到 35° 修复）
    ['star_all_10_vertices_key', [0, 3, 6, 9, 12, 15, 18, 21, 24, 27].every((i) => starKeys.has(i))],
    ['star_constraints_10', star.constraints.length === 10],
    ['rect_four_corners', [0, 8, 16, 24].every((i) => rectKeys.has(i)) && rectKeys.size === 4],
    ['heart_notch_tip', keyIdx(heart).has(0) && keyIdx(heart).has(60) && keyIdx(heart).size === 2],
    ['llm_circle_anchor_only', circle.keyPointCount === 1],
    ['triangle_corners', triangle.keyPointCount === 3],
  ]);
}

// ---------- 2. 寻路原语：默认不变 / 引导代价 / 走廊过滤 / 扩展上限（合成图） ----------
{
  // 1 --900m-- 2 ；1 --500m-- 3 --500m-- 2（经 3 总长 1000m）
  const g = {
    nodes: new Map([
      [1, [113.3, 23.12]],
      [2, [113.31, 23.12]],
      [3, [113.305, 23.121]],
    ]),
    adj: new Map([
      [1, [{ to: 2, w: 900 }, { to: 3, w: 500 }]],
      [2, [{ to: 1, w: 900 }, { to: 3, w: 500 }]],
      [3, [{ to: 1, w: 500 }, { to: 2, w: 500 }]],
    ]),
  };
  const direct = shortestPath(g, 1, 2);
  const guided = shortestPath(g, 1, 2, null, {
    edgeCost: (e) => (e.w > 600 ? e.w * 10 : e.w),
  });
  const blocked = shortestPath(g, 1, 2, null, { allowNode: (id) => id !== 3 });
  // 链式图 1-4-3-2（无直连边）：1→2 需要扩展 3 个节点，上限 2 必然触发截断
  const chain = {
    nodes: new Map([
      [1, [113.3, 23.12]],
      [2, [113.304, 23.123]],
      [3, [113.302, 23.122]],
      [4, [113.301, 23.121]],
    ]),
    adj: new Map([
      [1, [{ to: 4, w: 150 }]],
      [4, [{ to: 1, w: 150 }, { to: 3, w: 150 }]],
      [3, [{ to: 4, w: 150 }, { to: 2, w: 150 }]],
      [2, [{ to: 3, w: 150 }]],
    ]),
  };
  const chainPath = shortestPath(chain, 1, 2);
  const capped = shortestPath(chain, 1, 2, null, { maxExpanded: 2 });
  // 最近边合成反例：查询点贴着格边界，7m 近边在相邻格、100m 远边在本格——
  // 贪心"本格找到即停"会选 100m 的（漏掉邻格 1m 级最近路的通用吸附错误）
  const cellDeg = 0.002;
  const mPerDegLat = 111320;
  const mPerDegLon = mPerDegLat * Math.cos((23.1 * Math.PI) / 180);
  const boundary = Math.ceil(113.3 / cellDeg) * cellDeg; // 查询点所在格的西边界
  const qLat = 23.1;
  const qLon = boundary + 2 / mPerDegLon; // 边界东 2m（本格内）
  const snapGraph = {
    nodes: new Map([
      [101, [boundary - 15 / mPerDegLon, qLat]],
      [102, [boundary - 5 / mPerDegLon, qLat]],
      [201, [boundary + 100 / mPerDegLon, qLat]],
      [202, [boundary + 102 / mPerDegLon, qLat]],
    ]),
    adj: new Map([
      [101, [{ to: 102, w: 10 }]],
      [102, [{ to: 101, w: 10 }]],
      [201, [{ to: 202, w: 2 }]],
      [202, [{ to: 201, w: 2 }]],
    ]),
  };
  const snapIndex = buildEdgeIndex(snapGraph, cellDeg, null);
  const snappedNear = nearestEdge(snapIndex, snapGraph, qLon, qLat);
  checkSection('pathfinding', [
    ['default_shortest', direct.path.join(',') === '1,2' && Math.round(direct.distance) === 900],
    ['cost_prefers_contour', guided.path.join(',') === '1,3,2'],
    ['corridor_filters', blocked.path.join(',') === '1,2' && blocked.stats.prunedNodes > 0],
    ['chain_reachable', chainPath.path.join(',') === '1,4,3,2'],
    ['expansion_cap', capped.path === null && capped.stats.capped === true],
    ['stats_present', direct.stats.expandedNodes >= 1 && direct.stats.relaxedEdges >= 2],
    // 必须找到邻格 7m 的近边，而不是本格 100m 的远边
    ['nearest_edge_provably_nearest', snappedNear.distance < 20 && snappedNear.a === 101],
  ]);
}

// ---------- 3. 同边投影劈边：同一条长路上两个投影点不绕端点（合成图） ----------
{
  // 纵向长路 R1：5 个节点每 100m；横向短路 R2 在北端给第三个顶点落位
  const lat = (m) => 23.1 + m / 111320;
  const lng = (m) => 113.3 + m / (111320 * Math.cos((23.1 * Math.PI) / 180));
  const nodes = new Map();
  const adj = new Map();
  const addNode = (id, lo, la) => {
    nodes.set(id, [lo, la]);
    adj.set(id, []);
  };
  const link = (a, b) => {
    const [aLo, aLa] = nodes.get(a);
    const [bLo, bLa] = nodes.get(b);
    const w = distanceMeters(aLa, aLo, bLa, bLo);
    adj.get(a).push({ to: b, w });
    adj.get(b).push({ to: a, w });
  };
  for (let i = 0; i < 5; i += 1) {
    addNode(i + 1, lng(0), lat(i * 100));
  }
  for (let i = 1; i < 5; i += 1) {
    link(i, i + 1);
  }
  // 横向路经节点 5（与纵向路共点相交），否则两条路互不连通
  addNode(10, lng(-60), lat(400));
  addNode(11, lng(220), lat(400));
  link(10, 5);
  link(5, 11);
  const syntheticGraph = { nodes, adj };
  const syntheticEdges = buildEdgeIndex(syntheticGraph, 0.005, null);
  // 三角形：v0/v1 落在 R1 第 2 段（节点2-3）中段（相距约 40m），v2 落在 R2
  const center = { lat: lat(170), lng: lng(0) };
  // 尺寸取大值让走廊（尺寸×12%，上限 240m）覆盖 L 形实际路线到理想直线的偏差
  const size = 2000;
  const toLocal = (lo, la) => [
    ((lo - center.lng) * 111320 * Math.cos((23.1 * Math.PI) / 180)) / size,
    ((la - center.lat) * 111320) / size,
  ];
  const v0 = toLocal(lng(0), lat(130)); // 边(2,3)上 t≈0.3
  const v1 = toLocal(lng(0), lat(170)); // 边(2,3)上 t≈0.7
  const v2 = toLocal(lng(180), lat(400));
  const tri = planShapeRoute({
    graph: syntheticGraph,
    edgeIndex: syntheticEdges,
    customShape: { name: '三角', constraintPoints: [v0, v1, v2], outlinePoints: [v0, v1, v2] },
    center,
    sizeMeters: size,
    rotationDeg: 0,
  });
  const leg0Meters = polylineMeters(tri.legs[0]);
  // 链接后 ≈ 40m；绕端点 ≥ 100m（0.3+0.7 段长）
  checkSection('same-edge-chain', [
    ['routed', tri.metrics.failedLegs === 0 && tri.metrics.routePointCount > 0],
    ['no_endpoint_detour', leg0Meters > 20 && leg0Meters < 80],
  ]);
}

// ---------- 4. 有序分段贴合：贴错边 / 缺段（全局指标盲区的反例） ----------
{
  const t1 = [
    [23.1, 113.3],
    [23.11, 113.3],
  ];
  const t2 = [
    [23.1, 113.31],
    [23.11, 113.31],
  ]; // 两段相距约 1km
  const swapRoute = [t2, t1]; // 每段路线都画在"另一段"的位置
  const ordered = orderedFidelity({ legTargets: [t1, t2], legRoutes: swapRoute, sizeMeters: 1200 });
  const missing = orderedFidelity({ legTargets: [t1, t2], legRoutes: [t1, []], sizeMeters: 1200 });
  const good = orderedFidelity({ legTargets: [t1, t2], legRoutes: [t1, t2], sizeMeters: 1200 });
  // 尖刺反例：101 点直线路线，第 1 点向旁侧甩出约 1 km。均匀抽样到 48 点时
  // 该点不被抽中，最大偏差测得 ≈0——最大/平均偏差必须按全量点计算
  const spikeRoute = Array.from({ length: 101 }, (_, i) => [23.1 + (i * 0.01) / 100, 113.3]);
  spikeRoute[1] = [23.105, 113.311];
  const spike = orderedFidelity({ legTargets: [t1], legRoutes: [spikeRoute], sizeMeters: 1200 });
  checkSection('ordered-fidelity', [
    ['wrong_edge_caught', ordered.orderedOutlineMeanRatio > 0.5],
    ['missing_leg_invalid', missing.orderedOutlineMeanRatio === Number.POSITIVE_INFINITY],
    ['aligned_low', good.orderedOutlineMeanRatio < 0.01 && good.orderedRouteMeanRatio < 0.01],
    ['worst_leg_reported', ordered.worstLegIndex >= 0],
    ['spike_max_caught', spike.orderedRouteMaxMeters > 800],
    ['spike_mean_caught', spike.orderedRouteMeanMeters > 5],
  ]);
}

// ---------- 5. 质量门槛：合成指标正反例（有序 + 关键角 + 塌缩） ----------
{
  const base = {
    failedLegs: 0,
    coverage: 100,
    routePointCount: 100,
    snapMaxMeters: 80,
    snapAvgMeters: 20,
    detourRatio: 1.1,
    keyCoverage: 1,
    collapsedKeyCount: 0,
    keyMaxOffsetRatio: 0.03,
    orderedOutlineMeanRatio: 0.03,
    orderedOutlineMaxRatio: 0.08,
    orderedRouteMeanRatio: 0.03,
    orderedRouteMaxRatio: 0.1,
  };
  checkSection('quality-bar', [
    ['accept_good', meetsQualityBar(base)],
    ['reject_outline_mean', !meetsQualityBar({ ...base, orderedOutlineMeanRatio: 0.2 })],
    ['reject_outline_max', !meetsQualityBar({ ...base, orderedOutlineMaxRatio: 0.3 })],
    ['reject_route_mean', !meetsQualityBar({ ...base, orderedRouteMeanRatio: 0.15 })],
    ['reject_route_max', !meetsQualityBar({ ...base, orderedRouteMaxRatio: 0.4 })],
    ['reject_key_offset', !meetsQualityBar({ ...base, keyMaxOffsetRatio: 0.1 })],
    ['reject_key_collapse', !meetsQualityBar({ ...base, collapsedKeyCount: 1 })],
    ['reject_key_missing', !meetsQualityBar({ ...base, keyCoverage: 0.8 })],
    ['reject_snap_gate', !meetsQualityBar({ ...base, snapMaxMeters: 200 })],
    ['reject_missing_ordered', !meetsQualityBar({ ...base, orderedOutlineMeanRatio: undefined })],
    ['score_zero_on_collapse', scoreRoute({ ...base, collapsedKeyCount: 1 }) === 0],
    ['score_positive_on_good', scoreRoute(base) > 0],
    // 比例失真量纲：5% 失真只做轻微扣分（≤2 分），不应像旧实现那样直接扣 100 分
    ['aspect_5pct_light', scoreRoute({ ...base, aspectDistortionRatio: 0.05 }) >= scoreRoute(base) - 2],
    ['aspect_20pct_light', scoreRoute({ ...base, aspectDistortionRatio: 0.2 }) >= scoreRoute(base) - 5],
    ['aspect_hard_gate', !meetsQualityBar({ ...base, aspectDistortionRatio: 0.25 })],
    ['aspect_within_gate', meetsQualityBar({ ...base, aspectDistortionRatio: 0.2 })],
    // 绕行比只展示：同样的几何，路线长一倍不得扣分；几何更差不得靠更短翻盘
    ['detour_not_in_score', scoreRoute({ ...base, detourRatio: 2.5 }) === scoreRoute(base)],
    [
      'accuracy_beats_shorter_route',
      scoreRoute({ ...base, orderedOutlineMeanRatio: 0.05, detourRatio: 1 }) <
        scoreRoute({ ...base, orderedOutlineMeanRatio: 0.03, detourRatio: 3 }),
    ],
  ]);
}

// ---------- 5.5 多部分图形：逐环首尾塌缩检测（合成路网） ----------
// 旧实现只看扁平约束数组的首尾：多部分时 kept[0] 与 kept[last] 属于不同部分，
// 各环自己的闭合处漏检。合成一条水平路网，让两个三角形的首尾关键点同 x
// （沿路方向）不同 y（垂直路方向）——吸附后各自塌缩到同一投影点。
{
  const lat0 = 23.12;
  const lng0 = 113.32;
  const coords = [];
  const refs = [];
  for (let i = 0; i <= 20; i += 1) {
    coords.push([lng0 + i * 0.0005, lat0]);
    refs.push(i + 1);
  }
  const synthetic = buildWalkGraph([{ id: 1, h: 'residential', n: 'test', c: coords, r: refs }]);
  const syntheticMain = findLargestComponent(synthetic);
  const syntheticEdgeIndex = buildEdgeIndex(synthetic, 0.005, syntheticMain);
  const center = { lat: lat0, lng: lng0 + 0.005 };
  /** 三角形：首点与尾点同 x、不同 y，吸附到同一条水平边后投影重合 */
  const triangle = (x) => [
    [x, 0.05],
    [x + 0.2, 0.1],
    [x, 0.15],
  ];
  const partA = triangle(-0.3);
  const partB = triangle(0.1);
  const multiShape = {
    name: '双三角',
    outlinePoints: [...partA, ...partB],
    constraintPoints: [...partA, ...partB],
    parts: [
      { name: 'a', outlineStart: 0, outlineCount: 3, constraintStart: 0, constraintCount: 3 },
      { name: 'b', outlineStart: 3, outlineCount: 3, constraintStart: 3, constraintCount: 3 },
    ],
  };
  const multiResult = planShapeRoute({
    graph: synthetic,
    edgeIndex: syntheticEdgeIndex,
    customShape: multiShape,
    center,
    sizeMeters: 500,
    rotationDeg: 0,
  });
  const singleResult = planShapeRoute({
    graph: synthetic,
    edgeIndex: syntheticEdgeIndex,
    customShape: {
      name: '单三角',
      outlinePoints: partA,
      constraintPoints: partA,
      parts: [{ name: 'a', outlineStart: 0, outlineCount: 3, constraintStart: 0, constraintCount: 3 }],
    },
    center,
    sizeMeters: 500,
    rotationDeg: 0,
  });
  console.log(
    `  [multipart] 多部分塌缩 ${multiResult.metrics.collapsedKeyCount}（期望 2）· ` +
      `单部分塌缩 ${singleResult.metrics.collapsedKeyCount}（期望 1）`,
  );
  checkSection('multipart-collapse', [
    ['multi_two_rings_collapsed', multiResult.metrics.collapsedKeyCount === 2],
    ['multi_rejected', !meetsQualityBar(multiResult.metrics)],
    ['single_ring_collapsed', singleResult.metrics.collapsedKeyCount === 1],
    ['single_rejected', !meetsQualityBar(singleResult.metrics)],
  ]);
}

// ---------- 6. 直接规划：指标存在性与连续性（真实路网） ----------
{
  const cases = [
    { shapeKey: 'star', sizeMeters: 800, rotationDeg: 30 },
    { shapeKey: 'heart', sizeMeters: 1000, rotationDeg: 0 },
    { shapeKey: 'rect', sizeMeters: 600, rotationDeg: 0 },
  ];
  let allOk = true;
  for (const testCase of cases) {
    let result;
    try {
      result = planShapeRoute({ graph, edgeIndex, center: zhujiangXincheng, ...testCase });
    } catch (error) {
      console.log(`  [case] ${testCase.shapeKey} -> ERROR ${error.message}`);
      allOk = false;
      continue;
    }
    const m = result.metrics;
    const snapDead = m.snapMaxMeters > 120;
    const ok = snapDead
      ? !meetsQualityBar(m) && m.routePointCount === 0 // 吸附超门槛：短路返回且必不达标
      : [
          m.coverage >= 100,
          m.failedLegs === 0,
          m.routeMeters > 0,
          isContinuous(result.routeLatLngs),
          Number.isFinite(m.orderedOutlineMeanRatio) && m.orderedOutlineMeanRatio >= 0,
          Number.isFinite(m.orderedRouteMeanRatio) && m.orderedRouteMeanRatio >= 0,
          m.keyCoverage === 1,
          m.collapsedKeyCount === 0,
          Number.isFinite(m.keyMaxOffsetRatio) && m.keyMaxOffsetRatio >= 0,
          m.searchStats.expandedNodes > 0,
        ].every(Boolean);
    if (!ok) {
      allOk = false;
    }
    console.log(
      `  [case] ${testCase.shapeKey} size=${testCase.sizeMeters} ` +
        (snapDead
          ? `吸附 ${Math.round(m.snapMaxMeters)}m 超门槛 → 短路不寻路（正确）`
          : `路线 ${(m.routeMeters / 1000).toFixed(2)} km / 有序 ${(m.orderedOutlineMeanRatio * 100).toFixed(1)}% / 角偏 ${(m.keyMaxOffsetRatio * 100).toFixed(1)}%`),
    );
  }
  checkSection('direct-plan', allOk ? [['all', true]] : [['all', false]]);
}

// ---------- 7. 固定反例：珠江新城五角星 1200m/60°（截图复现条件）不得过门槛 ----------
{
  const repro = planShapeRoute({
    graph,
    edgeIndex,
    shapeKey: 'star',
    center: zhujiangXincheng,
    sizeMeters: 1200,
    rotationDeg: 60,
  });
  // 原截图候选的实际偏移中心（评审复现）：纯最短路重放路线侧 mean 4.53%/max 16.63%，
  // 引导重放 mean 4.34%/max 13.13%——收紧后的路线侧门槛（4%/14.5%）两种都必须拦截
  const reproOffsetCenter = { lat: 23.129861, lng: 113.3245 };
  const reproOffsetUnguided = planShapeRoute({
    graph,
    edgeIndex,
    shapeKey: 'star',
    center: reproOffsetCenter,
    sizeMeters: 1200,
    rotationDeg: 60,
    guided: false,
  });
  const reproOffsetGuided = planShapeRoute({
    graph,
    edgeIndex,
    shapeKey: 'star',
    center: reproOffsetCenter,
    sizeMeters: 1200,
    rotationDeg: 60,
    guided: true,
  });
  checkSection('fixed-repro', [
    ['bad_star_rejected', !meetsQualityBar(repro.metrics)],
    ['bad_star_below_deliverable', scoreRoute(repro.metrics) < GOOD_ENOUGH_SCORE],
    ['offset_unguided_rejected', !meetsQualityBar(reproOffsetUnguided.metrics)],
    ['offset_guided_rejected', !meetsQualityBar(reproOffsetGuided.metrics)],
  ]);
}

// ---------- 8. 候选搜索：双最优记录与一致性（真实路网） ----------
{
  const search = await searchBestCandidate({
    graph,
    edgeIndex,
    shapeKey: 'heart',
    center: { lat: 23.1212, lng: 113.2841 },
    baseSizeMeters: 700,
  });
  const baseline = await searchBestCandidate({
    graph,
    edgeIndex,
    shapeKey: 'heart',
    center: { lat: 23.1212, lng: 113.2841 },
    baseSizeMeters: 700,
    rotations: [0],
    sizeFactors: [1],
  });
  checkSection('search', [
    ['has_best', search.best !== null],
    ['count_bounded', search.candidateCount >= 1 && search.candidateCount <= 441],
    ['baseline_count', baseline.candidateCount === 49],
    ['score_matches', search.best.score === scoreRoute(search.best.result.metrics)],
    // 双最优不变式：达标最优（若存在）必过门槛，且原始最优分数 ≥ 达标最优分数
    ['passing_consistent', !search.bestPassing || meetsQualityBar(search.bestPassing.result.metrics)],
    ['best_ge_passing', !search.bestPassing || search.best.score >= search.bestPassing.score],
    // 全空间搜索不差于基线（或已以"够像"分数提前收工）
    [
      'superset_score',
      (search.bestPassing && search.bestPassing.score >= GOOD_ENOUGH_SCORE) ||
        search.best.score >= baseline.best.score,
    ],
  ]);
}

// ---------- 9. 尽力链与固定正例（真实路网交叉验证，覆盖多种比例尺） ----------
{
  const anchors = [
    ['yuexiu-star', { shapeKey: 'star', center: { lat: 23.1459, lng: 113.2545 }, baseSizeMeters: 1200, allowEnlarge: true }],
    ['gztower-heart', { shapeKey: 'heart', center: { lat: 23.1066, lng: 113.3246 }, baseSizeMeters: 939, allowEnlarge: false }],
    ['chenjiaci-rect', { shapeKey: 'rect', center: { lat: 23.1252, lng: 113.2455 }, baseSizeMeters: 800, allowEnlarge: true }],
  ];
  const results = {};
  let allOk = true;
  const checks = [];
  for (const [label, opts] of anchors) {
    const escalation = await searchWithEscalation({ graph, edgeIndex, ...opts });
    results[label] = escalation;
    const ok =
      escalation.status === 'ok' &&
      meetsQualityBar(escalation.best.result.metrics) &&
      escalation.triedCount > 0 &&
      !escalation.budgetExhausted;
    checks.push([`anchor_${label}`, ok]);
    if (!ok) {
      allOk = false;
    }
    console.log(
      `  [anchor] ${label}: ${escalation.status} 分${escalation.status === 'ok' ? escalation.best.score : '-'} ` +
        `尺寸${escalation.status === 'ok' ? escalation.best.sizeMeters : '-'}m 试${escalation.triedCount}`,
    );
  }
  // 尽力链反例：数据中心范围外（无道路）→ 必须失败而不是硬画
  const nowhere = await searchWithEscalation({
    graph,
    edgeIndex,
    shapeKey: 'heart',
    center: { lat: 23.5, lng: 113.9 },
    baseSizeMeters: 939,
  });
  checks.push(['nowhere_failed', nowhere.status === 'failed']);
  // 反例候选数：四级全跑（无早退）。心形 3 个朝向。
  checks.push(['nowhere_tried_full', nowhere.triedCount === ladderCandidateCount(3)]);
  checkSection('escalation', checks);
}

// ---------- 10. 自定义图形（LLM 点列通道） ----------
{
  const circleOutline = Array.from({ length: 24 }, (_, i) => {
    const t = (Math.PI * 2 * i) / 24;
    return [Math.cos(t) * 0.45, Math.sin(t) * 0.45];
  });
  const customCircle = {
    name: '圆形',
    constraintPoints: circleOutline.filter((_, i) => i % 2 === 0),
    outlinePoints: circleOutline,
  };
  const circleDirect = planShapeRoute({
    graph,
    edgeIndex,
    customShape: customCircle,
    center: zhujiangXincheng,
    sizeMeters: 1000,
  });
  const circleEscalation = await searchWithEscalation({
    graph,
    edgeIndex,
    customShape: customCircle,
    center: zhujiangXincheng,
    baseSizeMeters: 1000,
  });
  checkSection('custom', [
    ['coverage', circleDirect.metrics.coverage >= 100],
    ['reachable', circleDirect.metrics.failedLegs === 0],
    ['ordered_finite', Number.isFinite(circleDirect.metrics.orderedOutlineMeanMeters)],
    ['shape_name', circleDirect.shapeName === '圆形' && circleDirect.shapeKey === 'custom'],
    [
      'escalation_structure',
      (circleEscalation.status === 'ok' &&
        meetsQualityBar(circleEscalation.best.result.metrics) &&
        circleEscalation.best.result.shapeName === '圆形') ||
        (circleEscalation.status === 'failed' && circleEscalation.triedCount > 0),
    ],
  ]);
}

// ---------- 10.5 尺寸基准兜底：null/非正基准不得产出 0 尺寸候选（trace t-0wg0g71b5eu0） ----------
{
  // 编排层自定义点列恢复路径曾把 baseSizeMeters=null 传进引擎：尺寸阶梯 × null = 0 米，
  // 图形投影成一个点，有序贴合偏差除零得 Infinity、评分恒 0，四级 1960 个候选全废。
  // 引擎侧必须有兜底：非正/非有限基准按默认 1200m 算，候选尺寸恒为正。
  const nullBase = await searchBestCandidate({
    graph,
    edgeIndex,
    shapeKey: 'heart',
    center: { lat: 23.1212, lng: 113.2841 },
    baseSizeMeters: null,
    rotations: [0],
    sizeFactors: [1],
    gridRadius: 0,
  });
  const nullBaseMetrics = nullBase.best?.result?.metrics ?? {};
  const zeroBase = await searchBestCandidate({
    graph,
    edgeIndex,
    shapeKey: 'heart',
    center: { lat: 23.1212, lng: 113.2841 },
    baseSizeMeters: 0,
    rotations: [0],
    sizeFactors: [1],
    gridRadius: 0,
  });
  checkSection('size-fallback', [
    ['null_base_candidate_count', nullBase.candidateCount === 1],
    ['null_base_defaulted_1200', nullBase.best?.sizeMeters === 1200],
    ['null_base_outline_finite', Number.isFinite(nullBaseMetrics.orderedOutlineMeanMeters)],
    ['null_base_perimeter_positive', nullBaseMetrics.shapePerimeterMeters > 0],
    ['zero_base_defaulted_1200', zeroBase.best?.sizeMeters === 1200],
  ]);
}

// ---------- 11. 双重预算：时间 / 候选数耗尽的行为 ----------
{
  const tinyTime = await searchWithEscalation({
    graph,
    edgeIndex,
    shapeKey: 'heart',
    center: zhujiangXincheng,
    baseSizeMeters: 1200,
    timeBudgetMs: 5,
  });
  const tinyCount = await searchWithEscalation({
    graph,
    edgeIndex,
    shapeKey: 'heart',
    center: zhujiangXincheng,
    baseSizeMeters: 1200,
    maxCandidates: 10,
  });
  checkSection('budget', [
    ['time_exhausted_flag', tinyTime.budgetExhausted === true],
    ['time_exhausted_honest', tinyTime.status === 'failed' || meetsQualityBar(tinyTime.best.result.metrics)],
    ['time_stopped_early', tinyTime.triedCount < ladderCandidateCount(3)],
    ['count_exhausted_flag', tinyCount.budgetExhausted === true],
    ['count_capped', tinyCount.triedCount <= 10],
    ['count_honest', tinyCount.status === 'failed' || meetsQualityBar(tinyCount.best.result.metrics)],
  ]);
}

// ---------- 12. 实测推荐 + 性能预算验收（珠江新城，禁放大 = 用户给时间场景） ----------
{
  const recSizes = { star: 1200, heart: 1200, rect: 1200 };
  const t0 = performance.now();
  const recommend = await recommendShapes({
    graph,
    edgeIndex,
    center: zhujiangXincheng,
    shapeSizes: recSizes,
    allowEnlarge: false,
  });
  const elapsedMs = performance.now() - t0;
  // 推荐按偏移感知调整分降序（"近且像"优先，调整分随候选返回）
  const recSorted = recommend.recommendations.every(
    (r, i, arr) => i === 0 || worseSideRmsOf(arr[i - 1]) <= worseSideRmsOf(arr[i]),
  );
  checkSection('recommend', [
    ['status_ok', recommend.status === 'ok'],
    ['has_recommendation', recommend.recommendations.length >= 1],
    ['all_pass_bar', recommend.recommendations.every((r) => meetsQualityBar(r.result.metrics))],
    ['sorted_by_score', recSorted],
    // 有"够像"候选即早退；含局部精修（每图形 +135）与联合精修（每图形 ≤120 评价）
    ['tried_bounded', recommend.triedCount >= 1 && recommend.triedCount <= RECOMMEND_MAX_CANDIDATES],
    ['budget_ok', recommend.budgetExhausted === false],
    [
      'rec_fields',
      recommend.recommendations.every(
        (r) => r.shapeName && Number.isFinite(r.sizeMeters) && Number.isFinite(r.rotationDeg) && r.center,
      ),
    ],
  ]);
  checkSection('perf', [
    ['within_time_budget', elapsedMs <= RECOMMEND_TIME_BUDGET_MS],
    ['within_candidate_cap', recommend.triedCount <= RECOMMEND_MAX_CANDIDATES],
  ]);
  console.log(
    `  [perf] 三图形推荐耗时 ${Math.round(elapsedMs)} ms / 候选 ${recommend.triedCount}（预算 ${RECOMMEND_TIME_BUDGET_MS}ms / ${RECOMMEND_MAX_CANDIDATES}）`,
  );

  // 反例：无路区域 → 失败且不硬画；给了时间也照样三级兜底（一无所得时放大一搏）
  const nowhereRec = await recommendShapes({
    graph,
    edgeIndex,
    center: { lat: 23.5, lng: 113.9 },
    shapeSizes: recSizes,
  });
  const nowhereNoEnlarge = await recommendShapes({
    graph,
    edgeIndex,
    center: { lat: 23.5, lng: 113.9 },
    shapeSizes: recSizes,
    allowEnlarge: false,
  });
  checkSection('recommend-negative', [
    ['failed_nowhere', nowhereRec.status === 'failed' && nowhereRec.recommendations.length === 0],
    ['last_resort_enlarge', nowhereNoEnlarge.status === 'failed' && nowhereNoEnlarge.triedCount === ladderCandidateCount(5) + ladderCandidateCount(3) * 2],
  ]);
}

console.log(failures === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${failures} sections)`);
process.exit(failures === 0 ? 0 : 2);
