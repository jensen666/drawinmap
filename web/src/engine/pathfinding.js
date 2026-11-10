/**
 * 寻路基础设施：二叉最小堆与 A* 最短路（自 graph.js 拆出）。
 *
 * shortestPath 支持三类可选能力（供"轮廓分段引导寻路"使用，默认全部关闭、
 * 行为与拆分前一致）：
 * - edgeCost：边代价函数（引导代价），须不小于原边长 w，否则破坏启发式可采纳性；
 * - allowNode：节点扩展过滤器（走廊硬过滤），返回 false 的邻居节点不扩展；
 * - maxExpanded：单次搜索扩展节点硬上限，超限视为不可达（防止单段失控）。
 *
 * 返回值附带统计（expandedNodes / relaxedEdges / prunedNodes / capped），
 * 供上层汇总搜索诊断。distance 始终为真实几何长度（米），与代价函数无关。
 */

import { distanceMeters } from './graph.js';

/** 极简二叉最小堆（A* 的优先队列） */
class MinHeap {
  constructor() {
    this.items = [];
  }

  get size() {
    return this.items.length;
  }

  push(key, priority) {
    const items = this.items;
    items.push({ key, priority });
    let index = items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (items[parent].priority <= items[index].priority) {
        break;
      }
      [items[parent], items[index]] = [items[index], items[parent]];
      index = parent;
    }
  }

  pop() {
    const items = this.items;
    if (items.length === 0) {
      return null;
    }
    const top = items[0];
    const last = items.pop();
    if (items.length > 0) {
      items[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < items.length && items[left].priority < items[smallest].priority) {
          smallest = left;
        }
        if (right < items.length && items[right].priority < items[smallest].priority) {
          smallest = right;
        }
        if (smallest === index) {
          break;
        }
        [items[smallest], items[index]] = [items[index], items[smallest]];
        index = smallest;
      }
    }
    return top.key;
  }
}

/**
 * A* 最短路径（边权为米），支持叠加虚拟节点（图形顶点吸附到边上的投影点）。
 *
 * @param {{nodes: Map<number, [number, number]>, adj: Map<number, Array<{to:number, w:number}>>}} graph 路网图
 * @param {number|string} startId 起点节点 id（可为虚拟节点）
 * @param {number|string} goalId 终点节点 id（可为虚拟节点）
 * @param {{adj?: Map<any, Array<{to:any, w:number}>>, coords?: Map<any, [number, number]>}|null} [overlay]
 *   虚拟节点叠加层：adj 为额外邻接，coords 为虚拟节点坐标
 * @param {{
 *   edgeCost?: (edge: {to:any, w:number}, fromId: any) => number,
 *   allowNode?: (id: any) => boolean,
 *   maxExpanded?: number
 * }} [options] 引导寻路选项（默认关闭，保持纯最短路）
 * @returns {{path: Array<number|string>, distance: number, cost: number, stats: {expandedNodes: number, relaxedEdges: number, prunedNodes: number, capped: boolean}}|null}
 *   路径、真实长度（米）、代价（含引导惩罚）与统计；不可达或超上限返回 null
 */
export function shortestPath(graph, startId, goalId, overlay = null, options = null) {
  const { edgeCost, allowNode, maxExpanded } = options || {};
  const getCoord = (id) =>
    graph.nodes.get(id) || (overlay && overlay.coords ? overlay.coords.get(id) : undefined);

  if (!getCoord(startId) || !getCoord(goalId)) {
    return null;
  }
  if (startId === goalId) {
    return {
      path: [startId],
      distance: 0,
      cost: 0,
      stats: { expandedNodes: 0, relaxedEdges: 0, prunedNodes: 0, capped: false },
    };
  }

  const neighborsOf = (id) => {
    const base = graph.adj.get(id) || [];
    const extra = overlay && overlay.adj ? overlay.adj.get(id) : undefined;
    return extra ? base.concat(extra) : base;
  };

  const [goalLon, goalLat] = getCoord(goalId);
  const heuristic = (id) => {
    const [lon, lat] = getCoord(id);
    return distanceMeters(lat, lon, goalLat, goalLon);
  };

  const open = new MinHeap();
  const gScore = new Map([[startId, 0]]);
  const cameFrom = new Map();
  const closed = new Set();
  open.push(startId, heuristic(startId));
  let expandedNodes = 0;
  let relaxedEdges = 0;
  let prunedNodes = 0;
  let capped = false;

  while (open.size > 0) {
    const current = open.pop();
    if (current === goalId) {
      const path = [];
      const cost = gScore.get(goalId);
      let node = goalId;
      let distance = 0;
      // 回溯累加真实边长（与引导代价分离，供里程指标使用）
      while (node !== startId) {
        path.push(node);
        const step = cameFrom.get(node);
        distance += step.w;
        node = step.from;
      }
      path.push(startId);
      path.reverse();
      return { path, distance, cost, stats: { expandedNodes, relaxedEdges, prunedNodes, capped } };
    }
    if (closed.has(current)) {
      continue;
    }
    closed.add(current);
    expandedNodes += 1;
    if (maxExpanded && expandedNodes > maxExpanded) {
      // 超限：返回带统计的空路径（与"不可达"的 null 区分，供诊断）
      return {
        path: null,
        distance: 0,
        cost: 0,
        stats: { expandedNodes, relaxedEdges, prunedNodes, capped: true },
      };
    }
    const currentScore = gScore.get(current);
    for (const edge of neighborsOf(current)) {
      if (closed.has(edge.to)) {
        continue;
      }
      // 走廊硬过滤：目标段之外的节点直接不扩展（起点/终点由调用方保证在走廊内）
      if (allowNode && !allowNode(edge.to)) {
        prunedNodes += 1;
        continue;
      }
      relaxedEdges += 1;
      const stepCost = edgeCost ? edgeCost(edge, current) : edge.w;
      const tentative = currentScore + stepCost;
      const known = gScore.get(edge.to);
      if (known === undefined || tentative < known) {
        gScore.set(edge.to, tentative);
        cameFrom.set(edge.to, { from: current, w: edge.w });
        open.push(edge.to, tentative + heuristic(edge.to));
      }
    }
  }
  return null;
}
