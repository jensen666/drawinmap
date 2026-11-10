/**
 * 路网图：从 OSM 裁剪数据构建步行可通行图，并提供吸附索引。
 * A* 最短路与优先队列在 pathfinding.js（含引导代价/走廊过滤/扩展上限）。
 *
 * 建图要点：
 * - 只用道路的显式节点引用 `r` 连边，几何相交但节点不同的道路互不连通
 *   （桥/隧道/高架天然分开，不会产生假路口）；
 * - 步行可通行判断：排除快速路类型、foot=no/private、access=private/no；
 * - 边权为相邻节点间球面距离（米）。
 */

import { METERS_PER_DEG_LAT } from './geo.js';

const EARTH_RADIUS_M = 6371000;

/** 步行不可通行的道路类型（快速路/在建等） */
const WALK_EXCLUDE_TYPES = new Set([
  'motorway',
  'motorway_link',
  'trunk',
  'trunk_link',
  'construction',
  'proposed',
  'raceway',
]);

/**
 * 球面距离（米）。
 */
export function distanceMeters(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

/**
 * 判断一条道路是否可步行。
 *
 * @param {{h: string, a?: object}} road 道路数据
 * @returns {boolean} 是否可步行
 */
function isWalkable(road) {
  if (WALK_EXCLUDE_TYPES.has(road.h)) {
    return false;
  }
  const access = road.a || {};
  if (access.foot === 'no' || access.foot === 'private') {
    return false;
  }
  if (access.access === 'private' || access.access === 'no') {
    return false;
  }
  return true;
}

/**
 * 从道路数据构建步行图。
 *
 * @param {Array} roads 道路数组（含 r 节点引用与 c 坐标）
 * @returns {{nodes: Map<number, [number, number]>, adj: Map<number, Array<{to:number, w:number}>>, nodeCount:number, edgeCount:number}}
 *   nodes: 节点 id → [lon, lat]；adj: 邻接表
 */
export function buildWalkGraph(roads) {
  const nodes = new Map();
  const adj = new Map();
  let edgeCount = 0;

  const addEdge = (from, to, weight) => {
    let list = adj.get(from);
    if (!list) {
      list = [];
      adj.set(from, list);
    }
    list.push({ to, w: weight });
  };

  for (const road of roads) {
    if (!isWalkable(road)) {
      continue;
    }
    const coords = road.c;
    const refs = road.r;
    if (!Array.isArray(coords) || !Array.isArray(refs) || refs.length !== coords.length) {
      continue;
    }
    for (let i = 0; i < refs.length; i += 1) {
      if (!nodes.has(refs[i])) {
        nodes.set(refs[i], coords[i]);
      }
    }
    for (let i = 1; i < refs.length; i += 1) {
      const from = refs[i - 1];
      const to = refs[i];
      if (from === to) {
        continue;
      }
      const [fromLon, fromLat] = nodes.get(from);
      const [toLon, toLat] = nodes.get(to);
      const weight = distanceMeters(fromLat, fromLon, toLat, toLon);
      addEdge(from, to, weight);
      addEdge(to, from, weight);
      edgeCount += 1;
    }
  }

  return { nodes, adj, nodeCount: nodes.size, edgeCount };
}

/**
 * 计算最大连通分量（步行路网常被封闭小区、桥隧分成多个分量；
 * 图形顶点只应吸附到主分量，避免吸附到孤立路网导致路段不可达）。
 *
 * @param {{nodes: Map<number, [number, number]>, adj: Map<number, Array<{to:number, w:number}>>}} graph 路网图
 * @returns {Set<number>} 主连通分量的节点 id 集合
 */
export function findLargestComponent(graph) {
  const visited = new Set();
  let largest = new Set();
  for (const startId of graph.nodes.keys()) {
    if (visited.has(startId)) {
      continue;
    }
    const component = new Set();
    const stack = [startId];
    visited.add(startId);
    while (stack.length > 0) {
      const nodeId = stack.pop();
      component.add(nodeId);
      for (const edge of graph.adj.get(nodeId) || []) {
        if (!visited.has(edge.to)) {
          visited.add(edge.to);
          stack.push(edge.to);
        }
      }
    }
    if (component.size > largest.size) {
      largest = component;
    }
  }
  return largest;
}

/**
 * 路网图覆盖范围（节点坐标包围盒）。
 * 路网数据只覆盖裁剪 bbox（配置城市的核心区）——规划中心在覆盖外时应直接告知
 * "超出数据范围"，而不是空烧几百个候选后得出"画不出正方形"的荒诞结论。
 *
 * @param {{nodes: Map<number, [number, number]>}} graph 路网图
 * @returns {{minLat: number, maxLat: number, minLng: number, maxLng: number}|null} 包围盒（空图返回 null）
 */
export function graphBounds(graph) {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const [, [lon, lat]] of graph.nodes) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLng) minLng = lon;
    if (lon > maxLng) maxLng = lon;
  }
  if (!Number.isFinite(minLat)) {
    return null;
  }
  return { minLat, maxLat, minLng, maxLng };
}

/**
 * 判断点是否在包围盒内（可留边距）。
 *
 * @param {{minLat: number, maxLat: number, minLng: number, maxLng: number}} bounds 包围盒
 * @param {{lat: number, lng: number}} point 待检点
 * @param {number} [marginDeg] 四周放宽的边距（度），默认 0（贴边算在内）
 * @returns {boolean} 是否在范围内
 */
export function pointInBounds(bounds, point, marginDeg = 0) {
  return (
    point.lat >= bounds.minLat - marginDeg &&
    point.lat <= bounds.maxLat + marginDeg &&
    point.lng >= bounds.minLng - marginDeg &&
    point.lng <= bounds.maxLng + marginDeg
  );
}

/**
 * 构建节点网格索引，加速"最近节点"查询。
 *
 * @param {{nodes: Map<number, [number, number]>}} graph 路网图
 * @param {number} [cellDeg] 网格边长（度），默认 0.005°（约 500m）
 * @param {Set<number>|null} [nodeFilter] 只索引这些节点（如主连通分量）
 * @returns {{grid: Map<string, number[]>, cell: number}} 网格索引
 */
export function buildNodeIndex(graph, cellDeg = 0.005, nodeFilter = null) {
  const grid = new Map();
  for (const [id, [lon, lat]] of graph.nodes) {
    if (nodeFilter && !nodeFilter.has(id)) {
      continue;
    }
    const key = `${Math.floor(lon / cellDeg)},${Math.floor(lat / cellDeg)}`;
    let list = grid.get(key);
    if (!list) {
      list = [];
      grid.set(key, list);
    }
    list.push(id);
  }
  return { grid, cell: cellDeg };
}

/**
 * 查找最近的可用路网节点（按环逐圈扩大搜索）。
 *
 * @param {{grid: Map<string, number[]>, cell: number}} index 网格索引
 * @param {{nodes: Map<number, [number, number]>}} graph 路网图
 * @param {number} lon 经度
 * @param {number} lat 纬度
 * @param {number} [maxRings] 最大搜索圈数
 * @returns {{id: number|null, distance: number}} 最近节点 id 与距离（米）
 */
export function nearestNode(index, graph, lon, lat, maxRings = 6) {
  const { grid, cell } = index;
  const cx = Math.floor(lon / cell);
  const cy = Math.floor(lat / cell);
  let bestId = null;
  let bestDistance = Infinity;

  // 从 ring=0（中心格）开始；找到候选后不立即停——相邻圈里可能有更近的路。
  // 终止条件：Chebyshev 距离为 ring+1 的格子中，任一点到查询点在某一轴上至少
  // 相差 ring 个格宽（查询点在自身格内有 <1 格的余量），故距离下界为
  // ring × cell 度；按经度轴换算米（×cos 纬度，最保守）。下界 ≥ 当前最优才可停。
  for (let ring = 0; ring <= maxRings; ring += 1) {
    for (let dx = -ring; dx <= ring; dx += 1) {
      for (let dy = -ring; dy <= ring; dy += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) {
          continue;
        }
        const list = grid.get(`${cx + dx},${cy + dy}`);
        if (!list) {
          continue;
        }
        for (const id of list) {
          const [nodeLon, nodeLat] = graph.nodes.get(id);
          const distance = distanceMeters(lat, lon, nodeLat, nodeLon);
          if (distance < bestDistance) {
            bestDistance = distance;
            bestId = id;
          }
        }
      }
    }
    if (bestId !== null) {
      // 下一圈（Chebyshev 距离 ring+1）内任意点到查询点的距离下界（米，保守）
      const nextRingMinMeters = ring * cell * METERS_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
      if (nextRingMinMeters >= bestDistance) {
        break;
      }
    }
  }
  return { id: bestId, distance: bestDistance };
}

/**
 * 构建道路线段索引（用于把图形顶点吸附到道路边上的投影点）。
 *
 * @param {{nodes: Map<number, [number, number]>, adj: Map<number, Array<{to:number, w:number}>>}} graph 路网图
 * @param {number} [cellDeg] 网格边长（度）
 * @param {Set<number>|null} [nodeFilter] 只索引这些节点之间的边（如主连通分量）
 * @returns {{grid: Map<string, number[]>, cell: number, edges: Array}} 线段索引
 */
export function buildEdgeIndex(graph, cellDeg = 0.005, nodeFilter = null) {
  const grid = new Map();
  const edges = [];
  const seen = new Set();

  const addCell = (cx, cy, index) => {
    const key = `${cx},${cy}`;
    let list = grid.get(key);
    if (!list) {
      list = [];
      grid.set(key, list);
    }
    list.push(index);
  };

  for (const [fromId, neighbors] of graph.adj) {
    if (nodeFilter && !nodeFilter.has(fromId)) {
      continue;
    }
    for (const edge of neighbors) {
      if (nodeFilter && !nodeFilter.has(edge.to)) {
        continue;
      }
      const pairKey = fromId < edge.to ? `${fromId}_${edge.to}` : `${edge.to}_${fromId}`;
      if (seen.has(pairKey)) {
        continue;
      }
      seen.add(pairKey);
      const [aLon, aLat] = graph.nodes.get(fromId);
      const [bLon, bLat] = graph.nodes.get(edge.to);
      const index = edges.length;
      edges.push({ a: fromId, b: edge.to, aLon, aLat, bLon, bLat });
      const cx1 = Math.floor(Math.min(aLon, bLon) / cellDeg);
      const cx2 = Math.floor(Math.max(aLon, bLon) / cellDeg);
      const cy1 = Math.floor(Math.min(aLat, bLat) / cellDeg);
      const cy2 = Math.floor(Math.max(aLat, bLat) / cellDeg);
      for (let cx = cx1; cx <= cx2; cx += 1) {
        for (let cy = cy1; cy <= cy2; cy += 1) {
          addCell(cx, cy, index);
        }
      }
    }
  }
  return { grid, cell: cellDeg, edges };
}

/**
 * 把点投影到线段（局部米制平面近似）。
 *
 * @returns {{t: number, lon: number, lat: number, distance: number}} 投影参数、投影点与距离（米）
 */
function projectToSegment(lon, lat, aLon, aLat, bLon, bLat) {
  const latRad = (lat * Math.PI) / 180;
  const cos = Math.cos(latRad);
  const toX = (value) => (value - lon) * METERS_PER_DEG_LAT * cos;
  const toY = (value) => (value - lat) * METERS_PER_DEG_LAT;
  const ax = toX(aLon);
  const ay = toY(aLat);
  const bx = toX(bLon);
  const by = toY(bLat);
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  let t = lengthSquared === 0 ? 0 : -(ax * dx + ay * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  const px = ax + t * dx;
  const py = ay + t * dy;
  return {
    t,
    lon: lon + px / (METERS_PER_DEG_LAT * cos),
    lat: lat + py / METERS_PER_DEG_LAT,
    distance: Math.hypot(px, py),
  };
}

/**
 * 查找最近的道路边，并返回边上的投影点（比吸附到节点更贴合图形）。
 *
 * @param {{grid: Map<string, number[]>, cell: number, edges: Array}} index 线段索引
 * @param {{nodes: Map<number, [number, number]>}} graph 路网图
 * @param {number} lon 经度
 * @param {number} lat 纬度
 * @param {number} [maxRings] 最大搜索圈数
 * @returns {{a:number, b:number, t:number, lon:number, lat:number, distance:number}|null} 最近边与投影点
 */
export function nearestEdge(index, graph, lon, lat, maxRings = 8) {
  const { grid, cell, edges } = index;
  const cx = Math.floor(lon / cell);
  const cy = Math.floor(lat / cell);
  let best = null;
  // 从 ring=0（中心格）开始；找到候选后不立即停——相邻圈里可能有更近的边
  // （实测中心格 101m 的边挡住了邻格 1m 的边）。终止条件同 nearestNode：
  // 下一圈内任意点到查询点的距离有下界 ring × cell 度（经度轴保守换算），
  // 下界 ≥ 当前最优即不可能更近。注意边可能跨格，网格按边包围盒登记，
  // 下界按"格内点"计已是保守（实际边端点只会更远或相等）。
  for (let ring = 0; ring <= maxRings; ring += 1) {
    for (let dx = -ring; dx <= ring; dx += 1) {
      for (let dy = -ring; dy <= ring; dy += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) {
          continue;
        }
        const list = grid.get(`${cx + dx},${cy + dy}`);
        if (!list) {
          continue;
        }
        for (const edgeIndex of list) {
          const edge = edges[edgeIndex];
          const projected = projectToSegment(
            lon,
            lat,
            edge.aLon,
            edge.aLat,
            edge.bLon,
            edge.bLat,
          );
          if (!best || projected.distance < best.distance) {
            best = { a: edge.a, b: edge.b, ...projected };
          }
        }
      }
    }
    if (best) {
      const nextRingMinMeters = ring * cell * METERS_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
      if (nextRingMinMeters >= best.distance) {
        break;
      }
    }
  }
  return best;
}

/**
 * 查找最近的 K 条道路边（按距离升序、按边去重），返回每条边的投影点。
 *
 * 用于"多候选吸附"：每个约束点不再只锁死最近道路，而是保留前 K 条候选，
 * 由整图联合精修决定选哪条（最近边可能导致整体绕行/偏航）。
 *
 * 终止条件（可证明正确）：环形搜索逐圈扩大；当已收集到 K 个候选、且
 * 下一圈（Chebyshev 距离 ring+1）内任意点到查询点的距离下界 ≥ 第 K 个候选
 * 的距离时，不可能再有候选进入前 K，停止。不足 K 个时继续搜到 maxRings。
 *
 * @param {{grid: Map<string, number[]>, cell: number, edges: Array}} index 线段索引
 * @param {{nodes: Map<number, [number, number]>}} graph 路网图
 * @param {number} lon 经度
 * @param {number} lat 纬度
 * @param {object} [options]
 * @param {number} [options.count] 需要的候选数（K）
 * @param {number} [options.maxDistance] 距离上限（米，超过过滤掉）
 * @param {number} [options.maxRings] 最大搜索圈数
 * @returns {Array<{a:number, b:number, t:number, lon:number, lat:number, distance:number}>}
 *   按距离升序的候选投影（不足 count 个时返回实际找到的）
 */
export function nearbyEdges(
  index,
  graph,
  lon,
  lat,
  { count = 5, maxDistance = Number.POSITIVE_INFINITY, maxRings = 8 } = {},
) {
  const { grid, cell, edges } = index;
  const cx = Math.floor(lon / cell);
  const cy = Math.floor(lat / cell);
  /** 已处理的边索引（边可能跨多个格子被重复登记） */
  const seen = new Set();
  /** 候选列表（按距离升序维护） */
  const candidates = [];
  const targetCount = Math.max(1, Math.floor(count));
  const cosLat = Math.cos((lat * Math.PI) / 180);

  for (let ring = 0; ring <= maxRings; ring += 1) {
    for (let dx = -ring; dx <= ring; dx += 1) {
      for (let dy = -ring; dy <= ring; dy += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) {
          continue;
        }
        const list = grid.get(`${cx + dx},${cy + dy}`);
        if (!list) {
          continue;
        }
        for (const edgeIndex of list) {
          if (seen.has(edgeIndex)) {
            continue;
          }
          seen.add(edgeIndex);
          const edge = edges[edgeIndex];
          const projected = projectToSegment(
            lon,
            lat,
            edge.aLon,
            edge.aLat,
            edge.bLon,
            edge.bLat,
          );
          if (projected.distance > maxDistance) {
            continue;
          }
          candidates.push({ a: edge.a, b: edge.b, ...projected });
        }
      }
    }
    // 每圈结束后按距离排序，检查是否可证明停止
    candidates.sort((p, q) => p.distance - q.distance);
    if (candidates.length >= targetCount) {
      const kthDistance = candidates[targetCount - 1].distance;
      // 下一圈内任意点到查询点的距离下界（经度轴保守换算，与 nearestEdge 同口径）
      const nextRingMinMeters = ring * cell * METERS_PER_DEG_LAT * cosLat;
      if (nextRingMinMeters >= kthDistance) {
        break;
      }
    }
  }
  candidates.sort((p, q) => p.distance - q.distance);
  return candidates.slice(0, targetCount);
}

