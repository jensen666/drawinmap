/**
 * 图形路线规划器：把图形放到地图上，吸附到可步行路网，生成连续可走路线。
 *
 * 流程：图形轮廓模型（关键点/普通点）→ 旋转/缩放投影 → 约束点吸附到最近
 * 道路边的投影点（同一条边上的投影点按投影顺序连成虚拟边，不绕端点）→
 * 普通点近距合并/关键点保留（关键点吸到同位记塌缩）→ 按图形顺序逐段
 * "走廊引导 A*"串联（边代价含离目标段的偏差惩罚；走廊外的节点硬过滤不
 * 扩展；单段扩展上限防失控）→ 闭合回起点 → 指标（全局对照 + 有序分段
 * 贴合 + 关键角误差 + 寻路统计）。
 *
 * 引导代价 = 原路长 ×（1 + 增益 × min(1, 偏差/走廊半径)），恒 ≥ 原边长，
 * A* 启发式保持可采纳。每段只沿自己的理想轮廓片段走，路线抄近路、贴错边
 * 由有序指标如实暴露。
 */

import { distanceMeters, nearestEdge } from './graph.js';
import { shortestPath } from './pathfinding.js';
import { shapeFidelity, orderedFidelity } from './fidelity.js';
import { buildShapeModel, outlineSlice } from './shape-model.js';
import { SNAP_HARD_GATE_METERS } from './quality.js';
import { assembleMetrics } from './metrics.js';
import {
  computeShapeMetrics,
  featureCoverToleranceMeters,
  polygonPerimeter,
  projectShape,
} from './planner-result.js';
import {
  buildSnapOverlay,
  chainSameEdgeProjections,
  mergeNearbyConstraints,
} from './planner-snap.js';
import { buildLegCorridorCap, buildWalkLegs, slicePartOutline } from './planner-legs.js';

/** 局部等距投影的唯一实现（geo.localFrame） */
import { localFrame } from './geo.js';

/** 投影与容差函数从结果模块 re-export，保持既有 import 路径（joint-refine/test 经此取） */
export { projectShape, featureCoverToleranceMeters };

/** 默认步行速度（米/秒），约 4.5 km/h */
const DEFAULT_WALK_SPEED = 1.25;

/** 段间复用边惩罚倍数：此前形状腿已走过的边，寻路代价 ×该倍数。
 * 取 2 而不是更大的理由：翻倍足以让 A* 在"沿着已走过的边原路折返"与
 * "多绕一条没走过的边"之间改选后者（两条候选的原路长通常只差 1 倍以内），
 * 又不会把路线远远逼出走廊；代价只增不减，所有边代价仍 ≥ 原边长 w，
 * 欧氏距离启发式保持可采纳，搜索仍给出（含惩罚代价的）最优路径。 */
const REUSE_EDGE_PENALTY_FACTOR = 2;

/** 走廊半径 = clamp(尺寸 × 该比例, 下限, 上限)，两端吸附误差另加余量 */
const CORRIDOR_SIZE_RATIO = 0.12;
const CORRIDOR_MIN_METERS = 60;
const CORRIDOR_MAX_METERS = 240;
/** 走廊为两端吸附误差预留的额外余量（米，道路接近段） */
const CORRIDOR_SNAP_BUFFER_METERS = 30;

/** 引导代价增益：偏差达走廊半径时边代价 ×(1+增益) */
const GUIDE_GAIN = 2;

/** 单段 A* 扩展节点硬上限：超限视为该候选不可达 */
const MAX_EXPANDED_PER_LEG = 12000;

/** 走廊内点判定：点到本段目标折线的距离（米），带逐节点缓存 */
function makeCorridor(targetPolyline, corridorMeters, exemptIds, coordsOf, guideGain = GUIDE_GAIN) {
  const cache = new Map();
  const deviation = (id) => {
    let value = cache.get(id);
    if (value === undefined) {
      const coord = coordsOf(id);
      if (!coord) {
        value = Number.POSITIVE_INFINITY;
      } else {
        const [lon, lat] = coord;
        // 局部米制坐标系（geo.localFrame 单点实现）：原点 = 当前判定节点，
        // 与旧式手写投影逐位等价（mPerLng = METERS_PER_DEG_LAT × cos(lat)）。
        const { toXY } = localFrame(lat, lon);
        let min = Number.POSITIVE_INFINITY;
        for (let i = 1; i < targetPolyline.length; i += 1) {
          const [aLat, aLng] = targetPolyline[i - 1];
          const [bLat, bLng] = targetPolyline[i];
          const [ax, ay] = toXY(aLat, aLng);
          const [bx, by] = toXY(bLat, bLng);
          const dx = bx - ax;
          const dy = by - ay;
          const len2 = dx * dx + dy * dy;
          let t = len2 === 0 ? 0 : (-ax * dx - ay * dy) / len2;
          t = Math.max(0, Math.min(1, t));
          const d = Math.hypot(ax + t * dx, ay + t * dy);
          if (d < min) {
            min = d;
          }
        }
        value = min;
      }
      cache.set(id, value);
    }
    return value;
  };
  return {
    deviation,
    allowNode: (id) => exemptIds.has(id) || deviation(id) <= corridorMeters,
    edgeCost: (edge, fromId) => {
      const dev = deviation(edge.to);
      if (dev === Number.POSITIVE_INFINITY) {
        return edge.w * (1 + guideGain);
      }
      const ratio = Math.min(1, dev / corridorMeters);
      return edge.w * (1 + guideGain * ratio);
    },
  };
}

/**
 * 无向边规范键：同一条边的两个遍历方向必须得到同一个键，供"段间复用"记账。
 *
 * 节点 id 可能是数字（真实路网节点）或 `virt_` 字符串（图形顶点吸附的虚拟节点），
 * 两侧都是数字时按数值比较；跨类型（数字 vs 字符串）时统一转字符串比较，
 * 保证同一对端点无论从哪个方向遍历、以哪种类型混用都得到稳定一致的键。
 *
 * @param {number|string} a 端点 id
 * @param {number|string} b 端点 id
 * @returns {string} `${较小的 id}|${较大的 id}`
 */
export function canonicalEdgeKey(a, b) {
  if (typeof a === 'number' && typeof b === 'number') {
    return a <= b ? `${a}|${b}` : `${b}|${a}`;
  }
  const left = String(a);
  const right = String(b);
  return left <= right ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * 生成叠加"段间复用惩罚"的边代价函数：此前形状腿走过的无向边 ×factor。
 *
 * 为什么写进寻路代价而不是事后改路线：逐段独立寻路时，后续段会原路走回
 * 前序段用过的边，路线形成"顺着腿走下去又原路返回"的段内折返。把复用
 * 代价交给 A*，在"折返已走过的一段"与"多绕一段没走过的路"之间直接比较，
 * 由寻路自己选出更像轮廓的那条，而不是事后一刀切删改。
 *
 * 可采纳性：基础代价（引导代价 = 原路长 × (1+增益×偏差比例)）恒 ≥ 边长 w，
 * multiplier clamp 到 ≥1，因此叠加后所有边代价仍 ≥ w，欧氏启发式不高估，
 * A* 结果仍是（含惩罚代价的）最优路径；返回的 distance 仍是真实几何长度。
 *
 * @param {((edge: {to: any, w: number}, fromId: any) => number)|null} baseCost
 *   基础边代价函数（null = 纯最短路，即用原边长）
 * @param {Set<string>} usedEdgeKeys 此前形状腿走过的无向边规范键集合
 * @param {number} factor 复用惩罚倍数（≥1；1 = 旧行为不惩罚；非法值回落默认常量）
 * @returns {(edge: {to: any, w: number}, fromId: any) => number} 叠加惩罚后的边代价函数
 */
export function makeReusePenaltyCost(baseCost, usedEdgeKeys, factor) {
  const multiplier = Number.isFinite(factor) && factor >= 1 ? factor : REUSE_EDGE_PENALTY_FACTOR;
  return (edge, fromId) => {
    const base = baseCost ? baseCost(edge, fromId) : edge.w;
    if (usedEdgeKeys.size === 0 || !usedEdgeKeys.has(canonicalEdgeKey(fromId, edge.to))) {
      return base;
    }
    return base * multiplier;
  };
}

/**
 * 统计一条路径中"此前形状腿已走过"的边数与米数（用于 reusedEdgeCount 记账）。
 *
 * 米数按相邻节点球面距离近似（与建图边权同口径）；虚拟节点坐标从叠加层取。
 *
 * @param {Array<number|string>} path 节点 id 序列
 * @param {Set<string>} usedEdgeKeys 此前形状腿走过的无向边规范键集合
 * @param {(id: number|string) => [number, number]|undefined} coordinateOf 节点坐标查询（[lon, lat]）
 * @returns {{count: number, meters: number}} 复用边数与米数
 */
function accumulateReusedEdges(path, usedEdgeKeys, coordinateOf) {
  let count = 0;
  let meters = 0;
  for (let i = 1; i < path.length; i += 1) {
    if (!usedEdgeKeys.has(canonicalEdgeKey(path[i - 1], path[i]))) {
      continue;
    }
    count += 1;
    const from = coordinateOf(path[i - 1]);
    const to = coordinateOf(path[i]);
    if (from && to) {
      meters += distanceMeters(from[1], from[0], to[1], to[0]);
    }
  }
  return { count, meters };
}

/**
 * 规划图形路线。
 *
 * @param {object} options 规划参数
 * @param {{nodes: Map, adj: Map}} options.graph 步行路网图
 * @param {{grid: Map, cell: number, edges: Array}} options.edgeIndex 道路线段索引
 * @param {string} [options.shapeKey] 内置图形标识（star/heart/rect）
 * @param {{name: string, constraintPoints: Array, outlinePoints: Array}} [options.customShape]
 *   自定义图形（LLM 生成点列，优先级高于 shapeKey）
 * @param {{lat: number, lng: number}} options.center 图形中心
 * @param {number} [options.sizeMeters] 图形外接尺寸（米）
 * @param {number} [options.rotationDeg] 旋转角度（度）
 * @param {number} [options.walkSpeed] 步行速度（米/秒）
 * @param {boolean} [options.guided] 是否启用走廊引导寻路（默认 true；false 时退回纯最短路，用于对照）
 * @param {number} [options.guideGain] 引导代价增益覆盖（实验/调参用，默认 GUIDE_GAIN）
 * @param {number} [options.corridorSizeRatio] 走廊半径比例覆盖（默认 CORRIDOR_SIZE_RATIO）
 * @param {number} [options.reusePenaltyFactor] 段间复用边惩罚倍数覆盖（实验/调参用：
 *   1 = 旧行为不惩罚，默认 REUSE_EDGE_PENALTY_FACTOR）
 * @returns {object} 规划结果（约束点、平滑轮廓、吸附点、分段路线与指标）
 */
export function planShapeRoute({
  graph,
  edgeIndex,
  shapeKey,
  customShape = null,
  center,
  sizeMeters = 1200,
  rotationDeg = 0,
  walkSpeed = DEFAULT_WALK_SPEED,
  guided = true,
  guideGain = GUIDE_GAIN,
  corridorSizeRatio = CORRIDOR_SIZE_RATIO,
  reusePenaltyFactor = REUSE_EDGE_PENALTY_FACTOR,
  snapOverrides = null,
  legProfiles = null,
  collectOutlineRatios = false,
}) {
  // 1. 图形模型：约束点（关键/普通）+ 密轮廓，统一处理内置与自定义图形
  const model = buildShapeModel({ shapeKey, customShape });
  const outlineLatLngs = projectShape(model.outlinePoints, center, sizeMeters, rotationDeg);
  const constraintLatLngs = projectShape(
    model.constraints.map((c) => c.point),
    center,
    sizeMeters,
    rotationDeg,
  );

  // 2. 约束点吸附到最近道路边的投影点，构建虚拟节点叠加层
  const {
    overlay,
    snapped,
    valid,
  } = buildSnapOverlay({
    graph,
    edgeIndex,
    constraintLatLngs,
    constraints: model.constraints,
    snapOverrides,
  });
  if (valid.length < 2) {
    throw new Error('图形顶点附近没有可步行道路，请移动地图或调整大小后重试');
  }

  // 吸附硬门槛前置短路：任一约束点吸附超门槛（落水面/无路区）→ 必被评分淘汰，
  // 跳过寻路与指标计算（候选搜索的主要提速点；诊断走 snapMax 分支）
  const quickSnapMax = Math.max(...valid.map((item) => item.distance));
  if (quickSnapMax > SNAP_HARD_GATE_METERS) {
    const emptyRoute = [];
    return {
      shapeKey: shapeKey || 'custom',
      shapeName: model.name,
      center,
      sizeMeters,
      rotationDeg,
      shapeLatLngs: constraintLatLngs,
      outlineLatLngs,
      outlineParts:
        (model.partRanges?.length ?? 0) > 1
          ? model.partRanges.map((range) =>
              outlineLatLngs.slice(range.outlineStart, range.outlineStart + range.outlineCount),
            )
          : null,
      snapped,
      routeLatLngs: emptyRoute,
      legs: [],
      // 短路 = 空路线走同一个 metrics 汇总口（缺陷 D3：字段集与正常分支一致，
      // 不再手抄 57 个字段，避免缺 orderedOutputRms / snapSource 等导致口径漂移）
      metrics: assembleMetrics({
        shapePerimeterMeters: polygonPerimeter(constraintLatLngs),
        routeMeters: 0,
        walkSpeed,
        snapped,
        validCount: valid.length,
        constraintCount: valid.length,
        partCount: model.partRanges?.length ?? 1,
        failedLegs: 0,
        routePointCount: 0,
        keyPointCount: model.keyPointCount,
        keptKeyCount: 0,
        collapsedKeyCount: 0,
        sizeMeters,
        snapOverrides,
        legProfiles,
        // 吸附短路（落无路区）：特征无从谈起，按"全部未走出"记，候选必被淘汰
        featureCount: (customShape?.features || []).filter(
          (f) => f.kind === 'notch' || f.kind === 'declared',
        ).length,
        featureCoveredCount: 0,
        featureMaxOffsetMeters: Number.POSITIVE_INFINITY,
        featureMinWidthRatio: 0,
        aspectDistortionRatio: Number.POSITIVE_INFINITY,
        featureGapRetainRatio: Number.POSITIVE_INFINITY,
        ordered: orderedFidelity({ legTargets: [], legRoutes: [], sizeMeters }),
        fidelity: shapeFidelity({ outlineLatLngs, routeLatLngs: emptyRoute, sizeMeters }),
        // 没有寻路就没有段间复用，按 0 记（保持 metrics 结构完整）
        reusedEdgeCount: 0,
        reusedEdgeMeters: 0,
        searchStats: { expandedNodes: 0, relaxedEdges: 0, prunedNodes: 0, cappedLegs: 0 },
      }),
    };
  }

  // 同边投影点成链：按 t 排序后相邻互连（权重 = 沿边距离）
  chainSameEdgeProjections({ graph, overlay, valid });

  // 3. 普通点近距合并（仅同部分内）+ 关键点保留与闭环塌缩统计
  const { kept, collapsedKeyCount, keptKeyCount } = mergeNearbyConstraints({ graph, valid });

  // identity 浅凹所在段的走廊上限（方案 5.3）：凹底所在形状腿的走廊上限
  // 收紧为 min(240m, 凹深米数)（实现见 planner-legs.js）
  const legCorridorCap = buildLegCorridorCap({ customShape, model, sizeMeters });

  // 4. 步行序列：单部分按约束顺序成环；多部分"主体 + 岛 excursion"（见 planner-legs.js）
  const multiPart = (model.partRanges?.length ?? 0) > 1;
  const walkLegs = buildWalkLegs({ model, kept });

  const shapeLegRoutes = []; // 有序贴合评价用（仅形状腿，与 legTargets 对齐）
  const shapeLegTargets = [];
  const walkNodeIds = []; // 完整步行路线（形状腿 + 连接腿，按行走顺序）
  let routeMeters = 0;
  let failedLegs = 0;
  const searchStats = { expandedNodes: 0, relaxedEdges: 0, prunedNodes: 0, cappedLegs: 0 };

  /**
   * 汇总一次寻路的搜索统计（缺陷 D2：只允许在**拿到 stats 的地方**累加一次）。
   *
   * 引导尝试循环里每次尝试先累加；失败分支不得对同一份 `leg.stats` 再累加，
   * 否则 capped A* 失败段的 expandedNodes/relaxedEdges/cappedLegs 全部翻倍。
   *
   * @param {{expandedNodes: number, relaxedEdges: number, prunedNodes: number, capped: boolean}|null|undefined} stats 寻路统计
   */
  const addSearchStats = (stats) => {
    if (!stats) {
      return;
    }
    searchStats.expandedNodes += stats.expandedNodes;
    searchStats.relaxedEdges += stats.relaxedEdges;
    searchStats.prunedNodes += stats.prunedNodes;
    if (stats.capped) {
      searchStats.cappedLegs += 1;
    }
  };

  /** 节点坐标查询：真实节点优先，虚拟节点查吸附叠加层（拼接与复用记账共用） */
  const coordinateOf = (nodeId) => graph.nodes.get(nodeId) || overlay.coords.get(nodeId);
  /** 此前形状腿走过的无向边规范键：段间复用惩罚与 reusedEdgeCount 记账。
   * 仅形状腿参与（连接腿不画轮廓、不该为"复用"买单），见下方 connector 分支。 */
  const usedEdgeKeys = new Set();
  let reusedEdgeCount = 0;
  let reusedEdgeMeters = 0;

  let carryStartIndex = null;
  /** 零长段并入下一段时同步携带的走廊上限（米；null 无上限，多段取更紧者） */
  let carryCorridorCap = null;
  /** 形状腿序号（不含连接腿；联合精修可按段覆盖引导档位） */
  let shapeLegIndex = 0;
  for (const walkLeg of walkLegs) {
    const from = walkLeg.from;
    const to = walkLeg.to;

    if (walkLeg.kind === 'connector') {
      // 连接腿：纯最短路（部分之间的衔接，不属于图形轮廓），失败按失败段计。
      // 不做段间复用惩罚、不记账：连接腿不画轮廓，只是群岛之间的最短衔接，
      // 加惩罚会把"绕岛一整圈"的进出衔接扭曲成绕远路。
      carryStartIndex = null;
      carryCorridorCap = null;
      const leg = shortestPath(graph, from.nodeId, to.nodeId, overlay, {
        maxExpanded: MAX_EXPANDED_PER_LEG,
      });
      addSearchStats(leg?.stats);
      if (!leg || !leg.path) {
        failedLegs += 1;
        walkNodeIds.push([]);
        continue;
      }
      routeMeters += leg.distance;
      walkNodeIds.push(leg.path);
      continue;
    }

    // 形状腿
    const startIndex = carryStartIndex ?? from.outlineIndex;
    // 单段引导档位：legProfiles[形状腿序号] 可覆盖该段的引导增益/走廊比例
    // （缺省用全局参数，既有调用行为不变）
    const legProfile = legProfiles?.[shapeLegIndex] || null;
    const legGuideGain = legProfile?.guideGain ?? guideGain;
    const legCorridorRatio = legProfile?.corridorSizeRatio ?? corridorSizeRatio;
    shapeLegIndex += 1;
    if (from.nodeId === to.nodeId) {
      // 零长段（相邻约束吸到同一投影点）：不单独成段，目标折线并入下一段，
      // 避免单点路线让有序贴合误判为"缺段"；走廊上限同步并入（取更紧者）
      carryStartIndex = startIndex;
      const zeroLegCap = legCorridorCap(from.outlineIndex, to.outlineIndex);
      carryCorridorCap = Math.min(carryCorridorCap ?? zeroLegCap, zeroLegCap);
      walkNodeIds.push([]);
      continue;
    }
    carryStartIndex = null;
    // 本段搜索范围的走廊上限：零长段并入的上限与本段自身范围的上限取更紧者
    const identityCapMeters = Math.min(
      carryCorridorCap ?? Number.POSITIVE_INFINITY,
      legCorridorCap(startIndex, to.outlineIndex),
    );
    carryCorridorCap = null;
    const target = multiPart
      ? slicePartOutline(model.partRanges[walkLeg.part], outlineLatLngs, startIndex, to.outlineIndex)
      : outlineSlice(outlineLatLngs, startIndex, to.outlineIndex);
    shapeLegTargets.push(target);

    let leg = null;
    if (guided) {
      // 走廊半径：几何推导 + 两端吸附误差余量；起终点邻接点豁免过滤保证可达。
      // 渐进回退：初始走廊无解时放宽 2.5 倍重试，仍无解退纯最短路——
      // 走廊过紧不应直接判候选死刑，偏差由有序指标如实呈现
      // identity 浅凹段：走廊上限收紧为 min(240m, 凹深米数)，下限仍 60m
      const identityCap = Number.isFinite(identityCapMeters)
        ? Math.max(CORRIDOR_MIN_METERS, Math.min(CORRIDOR_MAX_METERS, identityCapMeters))
        : CORRIDOR_MAX_METERS;
      const baseCorridor = Math.min(
        identityCap,
        Math.max(CORRIDOR_MIN_METERS, sizeMeters * legCorridorRatio),
      );
      const snapMargin = Math.max(from.distance, to.distance) + CORRIDOR_SNAP_BUFFER_METERS;
      const corridorMeters = baseCorridor + snapMargin;
      const exempt = new Set();
      for (const virt of [from.nodeId, to.nodeId]) {
        for (const edge of overlay.adj.get(virt) || []) {
          exempt.add(edge.to);
        }
      }
      const coordsOf = (id) => graph.nodes.get(id) || overlay.coords.get(id);
      // 第三级兜底：纯最短路但保留扩展上限——不受走廊约束的寻路可能重新生成
      // 旧式乱跑路线（由有序指标如实拦截），但单段耗仍须有界，不拖垮搜索预算。
      // 两级寻路都叠加段间复用惩罚：已走过的边 ×reusePenaltyFactor，
      // 让 A* 自己在"折返旧路"与"绕未走过的边"之间比较，而不是事后删改路线。
      const attempts = [corridorMeters, corridorMeters * 2.5, null];
      for (const attemptRadius of attempts) {
        if (attemptRadius === null) {
          leg = shortestPath(graph, from.nodeId, to.nodeId, overlay, {
            edgeCost: makeReusePenaltyCost(null, usedEdgeKeys, reusePenaltyFactor),
            maxExpanded: MAX_EXPANDED_PER_LEG,
          });
        } else {
          const corridor = makeCorridor(target, attemptRadius, exempt, coordsOf, legGuideGain);
          leg = shortestPath(graph, from.nodeId, to.nodeId, overlay, {
            edgeCost: makeReusePenaltyCost(corridor.edgeCost, usedEdgeKeys, reusePenaltyFactor),
            allowNode: corridor.allowNode,
            maxExpanded: MAX_EXPANDED_PER_LEG,
          });
        }
        // 统计跨尝试累计（失败尝试的扩展/剪枝也是真实开销，不可漏记）
        addSearchStats(leg?.stats);
        if (leg && leg.path) {
          break;
        }
      }
    } else {
      // 关闭引导的对照基线：保持"纯最短路"语义（不加复用惩罚），
      // 用于复现旧路线、与引导结果对比；仍统计复用边数供诊断。
      leg = shortestPath(graph, from.nodeId, to.nodeId, overlay);
      addSearchStats(leg?.stats);
    }
    if (!leg || !leg.path) {
      // null = 不可达；path:null = 超过扩展上限——都按失败段计，候选会被评分淘汰。
      // 统计已在上面（尝试循环 / 对照分支）累加过，这里只记失败段数，绝不能重复累加。
      failedLegs += 1;
      shapeLegRoutes.push([]);
      walkNodeIds.push([]);
      continue;
    }
    routeMeters += leg.distance;
    // 段间复用记账：先按"此前形状腿"的边集统计本段复用了几条边，再并入本段边。
    // 顺序不能反——否则本段内部的边也会被自己算成"复用"。
    const reused = accumulateReusedEdges(leg.path, usedEdgeKeys, coordinateOf);
    reusedEdgeCount += reused.count;
    reusedEdgeMeters += reused.meters;
    for (let i = 1; i < leg.path.length; i += 1) {
      usedEdgeKeys.add(canonicalEdgeKey(leg.path[i - 1], leg.path[i]));
    }
    shapeLegRoutes.push(
      leg.path.map((nodeId) => {
        const [lon, lat] = graph.nodes.get(nodeId) || overlay.coords.get(nodeId);
        return [lat, lon];
      }),
    );
    walkNodeIds.push(leg.path);
  }

  // 5. 拼接总路线（相邻段接缝去重），保留形状腿结构供有序评价
  const routeLatLngs = [];
  for (const path of walkNodeIds) {
    for (const nodeId of path) {
      const [lon, lat] = coordinateOf(nodeId);
      const last = routeLatLngs[routeLatLngs.length - 1];
      if (!last || last[0] !== lat || last[1] !== lon) {
        routeLatLngs.push([lat, lon]);
      }
    }
  }

  // 6. 指标（多部分图形周长、特征覆盖、比例失真、有序贴合等，实现见 planner-result.js）
  const shapeMetrics = computeShapeMetrics({
    model,
    customShape,
    outlineLatLngs,
    constraintLatLngs,
    routeLatLngs,
    shapeLegTargets,
    shapeLegRoutes,
    sizeMeters,
    center,
    rotationDeg,
    multiPart,
    collectOutlineRatios,
  });

  return {
    shapeKey: shapeKey || 'custom',
    shapeName: model.name,
    center,
    sizeMeters,
    rotationDeg,
    shapeLatLngs: constraintLatLngs,
    outlineLatLngs,
    snapped,
    routeLatLngs,
    legs: shapeLegRoutes,
    outlineParts: multiPart
      ? model.partRanges.map((range) =>
          outlineLatLngs.slice(range.outlineStart, range.outlineStart + range.outlineCount),
        )
      : null,
    // 与吸附短路分支共用同一个 metrics 汇总口（缺陷 D3：字段集不再两套手抄）
    metrics: assembleMetrics({
      ...shapeMetrics,
      routeMeters,
      walkSpeed,
      snapped,
      validCount: valid.length,
      constraintCount: kept.length,
      partCount: multiPart ? model.partRanges.length : 1,
      failedLegs,
      routePointCount: routeLatLngs.length,
      keyPointCount: model.keyPointCount,
      keptKeyCount,
      collapsedKeyCount,
      sizeMeters,
      snapOverrides,
      legProfiles,
      reusedEdgeCount,
      reusedEdgeMeters,
      searchStats,
    }),
  };
}
