/**
 * 规划器段间复用惩罚 + 特征覆盖绝对上限测试（合成路网，快；Node 直接运行）。
 *
 * 背景：
 * - planner.js 逐段走廊引导 A* 各段独立，同一图形的后续段会原路走回已用过的边，
 *   路线形成"顺着腿走下去又原路返回"的段内折返；本测试验证"段间复用边"被写进
 *   寻路代价后 A* 会改选未走过的边（reusePenaltyFactor=1 复现旧行为，=6 改道）。
 * - FEATURE_COVERED_RATIO=0.04 对 3600m 图形会放宽到 144m，"脚尖擦到路线"就算
 *   特征走出；本测试验证容差改为 min(4%×尺寸, 80m) 后 100m 级的凹口不再误判。
 *
 * 运行：node test/planner-retrace.mjs
 */

import { buildWalkGraph, buildEdgeIndex, findLargestComponent } from '../web/src/engine/graph.js';
import {
  canonicalEdgeKey,
  featureCoverToleranceMeters,
  makeReusePenaltyCost,
  planShapeRoute,
} from '../web/src/engine/planner.js';

let failures = 0;

/** 断言工具：记录并通过/失败计数 */
function check(label, condition, detail = '') {
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
/** 经纬度 → 局部米坐标（x 向东、y 向北） */
const metersX = (lng) => (lng - LNG0) * mPerDegLng;
const metersY = (lat) => (lat - LAT0) * M_PER_DEG_LAT;

// ---------- 1. 特征覆盖容差：min(4% × 尺寸, 80m) ----------
{
  check('容差：1200m → 48m', featureCoverToleranceMeters(1200) === 48);
  check('容差：3600m → 封顶 80m', featureCoverToleranceMeters(3600) === 80);
  check('容差：450m → 18m', featureCoverToleranceMeters(450) === 18);
  check('容差：2000m → 80m（4%=80 恰好等于上限）', featureCoverToleranceMeters(2000) === 80);
  // 尺寸非法/非正：无法按比例推算，取绝对上限 80m（不返回 NaN/负数）
  check('容差：非有限 → 80m', featureCoverToleranceMeters(Number.NaN) === 80);
  check('容差：Infinity → 80m', featureCoverToleranceMeters(Number.POSITIVE_INFINITY) === 80);
  check('容差：0 → 80m', featureCoverToleranceMeters(0) === 80);
  check('容差：负尺寸 → 80m', featureCoverToleranceMeters(-100) === 80);
  check('容差：undefined → 80m', featureCoverToleranceMeters(undefined) === 80);
  // 旧行为（4%×尺寸）在 3600m 上会放宽到 144m：本测试的 108m 特征点会被误判为走出
  check('容差：大尺寸不再按 4% 放宽到 144m', featureCoverToleranceMeters(3600) < 0.04 * 3600);
}

// ---------- 2. 复用惩罚辅助纯函数：无向边键 + 惩罚包装 ----------
{
  check('边键：数字端点两个方向同键', canonicalEdgeKey(2, 3) === canonicalEdgeKey(3, 2));
  check('边键：格式为 小|大', canonicalEdgeKey(3, 2) === '2|3');
  // 虚拟节点 id 是 `virt_` 字符串：跨类型端点也必须两个方向同键
  check(
    '边键：数字/虚拟节点跨类型两个方向同键',
    canonicalEdgeKey('virt_1', 3) === canonicalEdgeKey(3, 'virt_1'),
  );
  check(
    '边键：数字/虚拟节点结果稳定',
    canonicalEdgeKey(3, 'virt_1') === '3|virt_1',
  );
  const used = new Set([canonicalEdgeKey(2, 3)]);
  const plain = makeReusePenaltyCost(null, used, 2);
  check('惩罚包装：未走过的边保持原边长', plain({ to: 4, w: 10 }, 3) === 10);
  check('惩罚包装：走过的边 ×2', plain({ to: 2, w: 10 }, 3) === 20);
  const factorOne = makeReusePenaltyCost(null, used, 1);
  check('惩罚包装：factor=1 时旧行为（不惩罚）', factorOne({ to: 2, w: 10 }, 3) === 10);
  // 非法 factor（<1 / NaN）回落到默认常量 2，避免把代价乘以 <1 破坏启发式可采纳性
  check('惩罚包装：factor=0.5 回落默认 2', makeReusePenaltyCost(null, used, 0.5)({ to: 2, w: 10 }, 3) === 20);
  check(
    '惩罚包装：factor=NaN 回落默认 2',
    makeReusePenaltyCost(null, used, Number.NaN)({ to: 2, w: 10 }, 3) === 20,
  );
  // 与引导代价叠加：基础代价先算，再乘惩罚倍数
  const guided = makeReusePenaltyCost((edge) => edge.w * 1.5, used, 2);
  check('惩罚包装：可叠加在引导代价之上（1.5w×2）', guided({ to: 2, w: 10 }, 3) === 30);
}

// ---------- 3. 段间复用惩罚：合成路网（A* 改走未走过的边） ----------
/*
 * 合成路网（直线主路 + 侧向回路 + 旁路，等价于"环路 + 捷径"结构）：
 *
 *   P0 --100-- P1 --100-- P2 --100-- P3 --100-- P4     （东西向主路 y=0）
 *               |            |            \            /
 *              A(50)        B(150)        N2 --100-- N1
 *                            \                        |
 *                             Q(150,-50)              |（回路：P4→N1→N2→P2）
 *                              \                      |
 *                               P0（旁路：P2→Q→P0）  /
 *
 * 三个约束点都吸附在主路边中点上（投影距离 0，虚拟节点不替换整条边，
 * 复用边仍落在真实图边上）：
 *   A = (50,0)   P0-P1 边中点
 *   C = (350,0)  P3-P4 边中点
 *   B = (150,0)  P1-P2 边中点
 *
 * 旧行为（factor=1，无惩罚）：
 *   第 1 段 A→C 沿主路向东（virtA→P1→P2→P3→virtC）；
 *   第 2 段 C→B 直接原路向西折返（virtC→P3→P2→virtB）—— 复用第 1 段用过的边；
 *   第 3 段 B→A 继续沿主路折返（virtB→P1→virtA）—— 复用第 1 段用过的 P1-virtA。
 * factor=6：
 *   第 2 段改走未走过的侧向回路（virtC→P4→N1→N2→P2→virtB）；
 *   第 3 段改走未走过的 P1→P0→virtA，全程 reusedEdgeCount=0。
 */
{
  const positions = {
    1: [0, 0], // P0
    2: [100, 0], // P1
    3: [200, 0], // P2
    4: [300, 0], // P3
    5: [400, 0], // P4
    6: [300, 30], // N1（回路）
    7: [200, 30], // N2（回路）
    8: [150, -50], // Q（旁路）
  };
  /** 合成道路：id + 道路名 + 节点引用序列（坐标由 positions 换算） */
  const road = (id, name, ids) => ({
    id,
    h: 'residential',
    n: name,
    c: ids.map((nodeId) => [lngOf(positions[nodeId][0]), latOf(positions[nodeId][1])]),
    r: ids,
  });
  const roads = [
    road(1, '主路', [1, 2, 3, 4, 5]),
    road(2, '回路-a', [5, 6]),
    road(3, '回路-b', [6, 7]),
    road(4, '回路-c', [7, 3]),
    road(5, '旁路', [3, 8, 1]),
  ];
  const graph = buildWalkGraph(roads);
  const mainComponent = findLargestComponent(graph);
  const edgeIndex = buildEdgeIndex(graph, 0.005, mainComponent);
  check('合成路网：节点/边/连通分量构建成功', graph.nodeCount === 8 && graph.edgeCount === 9 && mainComponent.size === 8);

  const sizeMeters = 600;
  const center = { lat: latOf(0), lng: lngOf(200) };
  const constraintTargets = [
    [50, 0], // A
    [350, 0], // C
    [150, 0], // B
  ];
  /** 目标米坐标 → 图形局部坐标（projectShape 的逆变换，旋转 0） */
  const toLocal = ([x, y]) => [(x - 200) / sizeMeters, y / sizeMeters];
  const customShape = {
    name: '测试直线三角',
    constraintPoints: constraintTargets.map(toLocal),
    outlinePoints: constraintTargets.map(toLocal),
  };
  /** 用同一合成路网分别按不同复用惩罚倍数规划 */
  const plan = (factor) =>
    planShapeRoute({
      graph,
      edgeIndex,
      customShape,
      center,
      sizeMeters,
      rotationDeg: 0,
      reusePenaltyFactor: factor,
    });
  const noPenalty = plan(1);
  const strongPenalty = plan(6);
  const baseline = noPenalty.metrics;
  const penalized = strongPenalty.metrics;
  console.log(
    `  [retrace] factor=1: reused=${baseline.reusedEdgeCount} (${Math.round(baseline.reusedEdgeMeters)}m) ` +
      `route=${Math.round(baseline.routeMeters)}m / ` +
      `factor=6: reused=${penalized.reusedEdgeCount} (${Math.round(penalized.reusedEdgeMeters)}m) ` +
      `route=${Math.round(penalized.routeMeters)}m`,
  );

  // 两次都要路线完整：惩罚只改变路线选择，不能让某段寻路失败
  check(
    '复用惩罚：factor=1 路线完整（failedLegs=0、三段齐全）',
    baseline.failedLegs === 0 && noPenalty.legs.length === 3 && noPenalty.metrics.routePointCount > 2,
    `failed=${baseline.failedLegs}, legs=${noPenalty.legs.length}`,
  );
  check(
    '复用惩罚：factor=6 路线完整（failedLegs=0、三段齐全）',
    penalized.failedLegs === 0 && strongPenalty.legs.length === 3 && strongPenalty.metrics.routePointCount > 2,
    `failed=${penalized.failedLegs}, legs=${strongPenalty.legs.length}`,
  );
  // 旧行为：第二/三段确实原路复用了第一段走过的边
  check('复用惩罚：factor=1 时存在段间复用边（旧行为复现）', baseline.reusedEdgeCount > 0, `reused=${baseline.reusedEdgeCount}`);
  check('复用惩罚：factor=1 复用米数 > 0', baseline.reusedEdgeMeters > 0, `reusedM=${baseline.reusedEdgeMeters}`);
  // 惩罚开启后 A* 改走未走过的边，复用归零
  check('复用惩罚：factor=6 时 reusedEdgeCount === 0（A* 改走未走过的边）', penalized.reusedEdgeCount === 0, `reused=${penalized.reusedEdgeCount}`);
  // 证明"惩罚改变了 A* 选择"：路线本身不同（第二段绕回路，总里程变长）
  check(
    '复用惩罚：factor=6 的路线与 factor=1 不同（A* 选择确实改变）',
    Math.abs(penalized.routeMeters - baseline.routeMeters) > 50,
    `factor1=${Math.round(baseline.routeMeters)}m, factor6=${Math.round(penalized.routeMeters)}m`,
  );
}

// ---------- 4. 特征覆盖绝对上限：合成水平直路 + 108m 凹口底部 ----------
/*
 * 3600m 图形上有一个凹口底部点距路线约 108m：
 * - 旧容差 4%×3600=144m → 108 ≤ 144，会被误判为"特征已走出"（featureCoverage=1）；
 * - 新容差 min(144, 80)=80m → 108 > 80，特征未走出（featureCoverage<1）。
 * 108m 仍 < 吸附硬门槛 120m，所以约束能正常吸附、路线能规划出来（不是吸附短路）。
 */
{
  const roadCoords = [];
  const roadRefs = [];
  // 主路：x ∈ [-2000, 2000]，节点间距 100m（36 个节点、35 条边）
  for (let i = 0; i <= 40; i += 1) {
    roadCoords.push([lngOf(-2000 + i * 100), latOf(0)]);
    roadRefs.push(i + 1);
  }
  const graph = buildWalkGraph([{ id: 1, h: 'residential', n: '直路', c: roadCoords, r: roadRefs }]);
  const mainComponent = findLargestComponent(graph);
  const edgeIndex = buildEdgeIndex(graph, 0.005, mainComponent);

  const sizeMeters = 3600;
  const center = { lat: latOf(0), lng: lngOf(0) };
  /** 目标米坐标 → 图形局部坐标（尺寸 3600，中心为原点） */
  const toLocal = ([x, y]) => [x / sizeMeters, y / sizeMeters];
  const notchBottom = [0, 100]; // 凹口底部：路线（y=0）上方 100m
  const customShape = {
    name: '带凹口直条',
    // 约束点：两端 + 凹口两侧口沿 + 凹口底部（底部由 features 强制保留为关键约束）
    constraintPoints: [
      [-1400, 0],
      [-180, 0],
      notchBottom,
      [180, 0],
      [1400, 0],
    ].map(toLocal),
    // 闭环轮廓：上沿经过凹口底部，下沿走 y=-30m 闭合
    outlinePoints: [
      [-1400, 0],
      [-180, 0],
      notchBottom,
      [180, 0],
      [1400, 0],
      [1400, -30],
      [-1400, -30],
    ].map(toLocal),
    // 凹口特征：points[1]（底部点）参与"特征是否走出"判定
    features: [
      {
        kind: 'notch',
        name: '凹口',
        points: [[-180, 0], notchBottom, [180, 0]].map(toLocal),
        depthRatio: 0.1,
        widthRatio: 0,
      },
    ],
  };
  const result = planShapeRoute({ graph, edgeIndex, customShape, center, sizeMeters, rotationDeg: 0 });
  const m = result.metrics;
  console.log(
    `  [feature] featureCount=${m.featureCount} covered=${m.featureCoveredCount} ` +
      `coverage=${m.featureCoverage} maxOffset=${Math.round(m.featureMaxOffsetMeters)}m ` +
      `snapMax=${Math.round(m.snapMaxMeters)}m`,
  );
  check(
    '特征上限：路线规划成功（未触发 120m 吸附短路）',
    m.failedLegs === 0 && m.routePointCount > 2 && m.snapMaxMeters < 120,
    `failed=${m.failedLegs}, routePoints=${m.routePointCount}, snapMax=${m.snapMaxMeters}`,
  );
  // 特征点到路线距离应约等于凹口深度 100m（容差 ±15m，含投影/去重误差）
  check(
    '特征上限：凹口底部到路线距离 ≈100m',
    m.featureMaxOffsetMeters > 85 && m.featureMaxOffsetMeters < 115,
    `maxOffset=${m.featureMaxOffsetMeters}`,
  );
  // 旧容差 144m 会误判走出（108m ≤ 144m）；新容差 80m 必须判未走出
  check(
    '特征上限：100m > 新容差 80m 且 < 旧容差 144m（旧行为会误判覆盖）',
    m.featureMaxOffsetMeters > featureCoverToleranceMeters(sizeMeters) &&
      m.featureMaxOffsetMeters < 0.04 * sizeMeters,
  );
  check(
    '特征上限：sizeMeters=3600 时 featureCoverage < 1（不再被 4% 比例蒙混）',
    m.featureCoverage < 1 && m.featureCoveredCount === 0,
    `coverage=${m.featureCoverage}, covered=${m.featureCoveredCount}`,
  );
}

// ---------- 5. 既有结构兼容：吸附短路 metrics 也带复用字段 ----------
{
  // 无路区域：约束点附近没有道路 → 吸附失败抛错（与既有语义一致）；
  // 这里改用"有路但吸附超 120m 门槛"的合成图验证短路 metrics 结构完整。
  const roadCoords = [
    [lngOf(0), latOf(0)],
    [lngOf(100), latOf(0)],
  ];
  const graph = buildWalkGraph([{ id: 1, h: 'residential', n: '单边', c: roadCoords, r: [1, 2] }]);
  const mainComponent = findLargestComponent(graph);
  const edgeIndex = buildEdgeIndex(graph, 0.005, mainComponent);
  const sizeMeters = 600;
  const center = { lat: latOf(0), lng: lngOf(50) };
  // 两个约束都落在道路北侧 200m 处（吸附距离 > 120m 硬门槛）
  const toLocal = ([x, y]) => [(x - 50) / sizeMeters, y / sizeMeters];
  const result = planShapeRoute({
    graph,
    edgeIndex,
    customShape: {
      name: '远离道路',
      constraintPoints: [[30, 200], [80, 200]].map(toLocal),
      outlinePoints: [[30, 200], [80, 200]].map(toLocal),
    },
    center,
    sizeMeters,
    rotationDeg: 0,
  });
  const m = result.metrics;
  console.log(`  [short-circuit] snapMax=${Math.round(m.snapMaxMeters)}m reused=${m.reusedEdgeCount}`);
  check(
    '吸附短路：metrics 补齐 reusedEdgeCount/reusedEdgeMeters 默认 0',
    m.reusedEdgeCount === 0 && m.reusedEdgeMeters === 0,
    `reused=${m.reusedEdgeCount}, reusedM=${m.reusedEdgeMeters}`,
  );
  check('吸附短路：超门槛不寻路（routePointCount=0）', m.routePointCount === 0 && m.snapMaxMeters > 120);
}

console.log(`\nRESULT: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 2);
