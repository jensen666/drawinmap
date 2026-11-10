/**
 * 约束点吸附与叠加层（清理方案 2026-11-09 C3：从 planner.js 纯移动拆出，行为零变化）。
 *
 * 职责：约束点吸附到最近（或联合精修指定的第 N 近）道路边的投影点、构建虚拟节点
 * 叠加层、同边投影点成链、普通点近距合并与闭环塌缩统计。投影顺序与阈值语义
 * 与 planner.js 原实现逐行一致（A* 的虚拟节点/虚拟边结构因此保持不变）。
 */

import { distanceMeters, nearestEdge } from './graph.js';

/** 相邻约束点距离小于该值（米）时合并普通点（关键点不合并），避免同路反复 */
const MIN_CONSTRAINT_GAP_METERS = 10;

/**
 * 约束点吸附到最近道路边（或联合精修指定的第 N 近边），构建虚拟节点叠加层。
 *
 * @param {object} options
 * @param {object} options.graph 步行路网图
 * @param {object} options.edgeIndex 道路线段索引
 * @param {Array<[number, number]>} options.constraintLatLngs 约束点经纬度
 * @param {Array} options.constraints shape-model 约束（取 key/outlineIndex/partIndex）
 * @param {Array|null} options.snapOverrides 联合精修的吸附覆盖（第 N 近道路边）
 * @returns {{overlay: {adj: Map, coords: Map}, snapped: Array, valid: Array}}
 *   overlay 虚拟节点叠加层；snapped 每个约束的吸附记录；valid 吸附成功（可步行）的约束
 */
export function buildSnapOverlay({ graph, edgeIndex, constraintLatLngs, constraints, snapOverrides }) {
  // 约束点吸附到最近道路边的投影点，构建虚拟节点叠加层
  const overlay = { adj: new Map(), coords: new Map() };
  const ensureAdj = (id) => {
    let list = overlay.adj.get(id);
    if (!list) {
      list = [];
      overlay.adj.set(id, list);
    }
    return list;
  };

  const snapped = constraintLatLngs.map(([lat, lng], index) => {
    // 多候选吸附：联合精修可通过 snapOverrides 指定某个约束使用第 N 近的道路边；
    // 缺省仍走最近边，保证既有调用与对照基线完全不变。
    const override = snapOverrides?.[index] || null;
    const nearest = override ?? nearestEdge(edgeIndex, graph, lng, lat);
    if (!nearest) {
      return { nodeId: null, distance: Number.POSITIVE_INFINITY, lat, lng, key: false, outlineIndex: -1 };
    }
    const [aLon, aLat] = graph.nodes.get(nearest.a);
    const [bLon, bLat] = graph.nodes.get(nearest.b);
    const weightA = distanceMeters(nearest.lat, nearest.lon, aLat, aLon);
    const weightB = distanceMeters(nearest.lat, nearest.lon, bLat, bLon);
    const virtualId = `virt_${index}`;
    overlay.coords.set(virtualId, [nearest.lon, nearest.lat]);
    overlay.adj.set(virtualId, [
      { to: nearest.a, w: weightA },
      { to: nearest.b, w: weightB },
    ]);
    ensureAdj(nearest.a).push({ to: virtualId, w: weightA });
    ensureAdj(nearest.b).push({ to: virtualId, w: weightB });
    return {
      nodeId: virtualId,
      distance: nearest.distance,
      lat: nearest.lat,
      lng: nearest.lon,
      key: constraints[index].key,
      outlineIndex: constraints[index].outlineIndex,
      partIndex: constraints[index].partIndex ?? 0,
      edgePair: nearest.a < nearest.b ? `${nearest.a}_${nearest.b}` : `${nearest.b}_${nearest.a}`,
      edgeT: nearest.t,
    };
  });

  const valid = snapped.filter((item) => item.nodeId !== null);
  return { overlay, snapped, valid };
}

/**
 * 同边投影点成链：按 t 排序后相邻互连（权重 = 沿边距离），消除绕端点的人为折返。
 *
 * @param {object} options
 * @param {object} options.graph 步行路网图
 * @param {{adj: Map, coords: Map}} options.overlay 虚拟节点叠加层（原地增边）
 * @param {Array} options.valid 吸附成功的约束
 * @returns {void}
 */
export function chainSameEdgeProjections({ graph, overlay, valid }) {
  const byEdge = new Map();
  for (const item of valid) {
    let list = byEdge.get(item.edgePair);
    if (!list) {
      list = [];
      byEdge.set(item.edgePair, list);
    }
    list.push(item);
  }
  for (const list of byEdge.values()) {
    if (list.length < 2) {
      continue;
    }
    list.sort((p, q) => p.edgeT - q.edgeT);
    for (let i = 1; i < list.length; i += 1) {
      const p = list[i - 1];
      const q = list[i];
      const w = distanceMeters(p.lat, p.lng, q.lat, q.lng);
      if (w > 0) {
        overlay.adj.get(p.nodeId).push({ to: q.nodeId, w });
        overlay.adj.get(q.nodeId).push({ to: p.nodeId, w });
      }
    }
  }
}

/**
 * 普通点近距合并（仅同部分内；不同部分的相邻约束不合并，各部分独立绕行）；
 * 关键点一律保留，两个关键点吸到同一位置记塌缩（不达标）。
 *
 * 闭环塌缩：每个部分自己的首尾关键点吸到同一位置同样记塌缩。多部分图形（群岛等）
 * 不能只看扁平数组首尾——kept[0] 与 kept[last] 属于不同部分，各环的闭合处会漏检
 * （合成路网实测：两个不相交三角形首尾都吸到 0m 时 collapsedKeyCount 仍为 0）。
 *
 * @param {object} options
 * @param {object} options.graph 步行路网图
 * @param {Array} options.valid 吸附成功的约束
 * @returns {{kept: Array, collapsedKeyCount: number, keptKeyCount: number}} 合并后约束与统计
 */
export function mergeNearbyConstraints({ graph, valid }) {
  const kept = [];
  let collapsedKeyCount = 0;
  for (const item of valid) {
    const previous = kept[kept.length - 1];
    const samePart = previous && previous.partIndex === item.partIndex;
    if (
      previous &&
      samePart &&
      distanceMeters(previous.lat, previous.lng, item.lat, item.lng) <= MIN_CONSTRAINT_GAP_METERS
    ) {
      if (item.key && previous.key) {
        collapsedKeyCount += 1;
        kept.push(item);
      } else if (item.key) {
        kept.push(item);
      }
      // else：普通点被近距合并丢弃，不入 kept
    } else {
      kept.push(item);
    }
  }
  const partFirstLast = new Map();
  kept.forEach((item, index) => {
    const part = item.partIndex ?? 0;
    if (!partFirstLast.has(part)) {
      partFirstLast.set(part, { first: index, last: index });
    } else {
      partFirstLast.get(part).last = index;
    }
  });
  for (const { first, last } of partFirstLast.values()) {
    if (first === last) {
      continue;
    }
    const head = kept[first];
    const tail = kept[last];
    if (
      head.key &&
      tail.key &&
      distanceMeters(head.lat, head.lng, tail.lat, tail.lng) <= MIN_CONSTRAINT_GAP_METERS
    ) {
      collapsedKeyCount += 1;
    }
  }
  return { kept, collapsedKeyCount, keptKeyCount: kept.filter((item) => item.key).length };
}
