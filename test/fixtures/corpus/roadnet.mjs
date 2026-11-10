/**
 * 语料路网实例：真实路网分区 + 程序化合成路网。
 *
 * 语料按"路网属性"分层（道路密度、走向集中度、连通性、完整性），不按地点语义分层：
 * - 真实路网来自 mapdata/guangzhou-roads.json，按矩形分区裁剪；
 * - 合成路网由固定 seed 的网格/放射状生成器产出，可控密度、走向与断路；
 * - 断路环境用"屏障切路"实现：把穿过屏障带的道路切断，模拟真实断路。
 *
 * 密度、走向集中度、连通性都在构建时从实际路网测得，不写死。
 */

import { GUANGZHOU_ROADS_HINT, readRequiredText } from '../../lib/require-data.mjs';
import {
  buildEdgeIndex,
  buildWalkGraph,
  distanceMeters,
  findLargestComponent,
} from '../../../web/src/engine/graph.js';

/** 真实路网数据文件（相对本文件） */
const ROADS_URL = new URL('../../../mapdata/guangzhou-roads.json', import.meta.url);

/** 每纬度约合米数 */
const METERS_PER_DEG_LAT = 111320;

/** 步行不可通行的道路类型（与引擎 graph.js 同口径） */
const WALK_EXCLUDE_TYPES = new Set([
  'motorway',
  'motorway_link',
  'trunk',
  'trunk_link',
  'construction',
  'proposed',
  'raceway',
]);

/** 密度分档阈值（可步行路网公里数 / 平方公里） */
const DENSITY_DENSE = 18;
const DENSITY_SPARSE = 8;

/** 走向集中度分档阈值（最大 10° 方向桶占比） */
const ORIENTATION_CONCENTRATED = 0.16;

/** 连通性分档阈值（主连通分量节点占比） */
const CONNECTIVITY_CONNECTED = 0.93;

/**
 * 判断道路是否可步行（与引擎 graph.js 同口径）。
 *
 * @param {object} road 道路数据
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

let cachedRoads = null;

/**
 * 读取并缓存真实路网（只读一次）。
 *
 * @returns {Array} 可步行道路数组
 */
export function loadWalkableRoads() {
  if (!cachedRoads) {
    const raw = JSON.parse(readRequiredText(ROADS_URL, GUANGZHOU_ROADS_HINT));
    cachedRoads = raw.roads.filter((road) => isWalkable(road) && Array.isArray(road.c) && Array.isArray(road.r));
  }
  return cachedRoads;
}

/**
 * 真实路网分区定义。
 *
 * 分区只是"路网的取样窗口"，id 用中性编号（不按地点命名）；
 * reserved 的分区只出现在最终留出集（calibration/holdout 不得使用）。
 */
export const REAL_REGIONS = [
  { id: 'R0', lat: 23.13, lng: 113.32, size: 0.02, sever: false },
  { id: 'R1', lat: 23.12, lng: 113.32, size: 0.02, sever: true },
  { id: 'R2', lat: 23.13, lng: 113.25, size: 0.02, sever: false },
  { id: 'R3', lat: 23.12, lng: 113.34, size: 0.02, sever: false },
  { id: 'R4', lat: 23.08, lng: 113.27, size: 0.02, sever: false },
  { id: 'R5', lat: 23.15, lng: 113.27, size: 0.02, sever: false },
  { id: 'R6', lat: 23.06, lng: 113.25, size: 0.02, sever: false },
  { id: 'R7', lat: 23.06, lng: 113.3, size: 0.02, sever: true },
  { id: 'R8', lat: 23.15, lng: 113.22, size: 0.02, sever: false },
  { id: 'R9', lat: 23.06, lng: 113.34, size: 0.02, sever: false },
  { id: 'R10', lat: 23.07, lng: 113.33, size: 0.02, sever: false, reserved: true },
  { id: 'R11', lat: 23.16, lng: 113.29, size: 0.02, sever: false, reserved: true },
  { id: 'R12', lat: 23.16, lng: 113.32, size: 0.02, sever: false, reserved: true },
  { id: 'R13', lat: 23.16, lng: 113.28, size: 0.02, sever: false, reserved: true },
];

/**
 * 合成路网定义（固定 seed 的网格/放射状生成器）。
 *
 * reserved 的实例只出现在最终留出集。
 */
export const SYNTHETIC_NETWORKS = [
  { id: 'S0', kind: 'grid', center: { lat: 23.13, lng: 113.29 }, spacing: 90, extent: 1300, fragment: false, sever: false },
  { id: 'S1', kind: 'grid', center: { lat: 23.09, lng: 113.31 }, spacing: 200, extent: 1400, fragment: false, sever: false },
  { id: 'S2', kind: 'grid', center: { lat: 23.15, lng: 113.25 }, spacing: 380, extent: 1500, fragment: false, sever: false },
  { id: 'S3', kind: 'grid', center: { lat: 23.11, lng: 113.28 }, spacing: 190, extent: 1400, fragment: true, sever: false },
  { id: 'S4', kind: 'grid', center: { lat: 23.07, lng: 113.3 }, spacing: 150, extent: 1400, fragment: false, sever: true },
  { id: 'S5', kind: 'polar', center: { lat: 23.13, lng: 113.26 }, spokeCount: 20, ringStep: 110, rMin: 110, rMax: 1200, fragment: false, sever: false },
  { id: 'S6', kind: 'polar', center: { lat: 23.09, lng: 113.27 }, spokeCount: 12, ringStep: 220, rMin: 220, rMax: 1400, fragment: false, sever: false },
  { id: 'S7', kind: 'polar', center: { lat: 23.16, lng: 113.29 }, spokeCount: 16, ringStep: 160, rMin: 160, rMax: 1100, fragment: true, sever: false },
  { id: 'S8', kind: 'polar', center: { lat: 23.12, lng: 113.33 }, spokeCount: 24, ringStep: 90, rMin: 90, rMax: 1000, fragment: false, sever: true, reserved: true },
];

/**
 * 判断道路是否触及窗口（保留整条道路，不在窗口边界切断）。
 *
 * 真实路网不会在任意矩形边界上停止，强行裁剪会把边界上的道路砍成碎片，
 * 连通性指标会失真。因此这里只按"是否触及窗口"筛选，密度统计仍只算窗口内路段。
 *
 * @param {object} road 原始道路
 * @param {{minLat:number,maxLat:number,minLng:number,maxLng:number}} window 窗口
 * @returns {boolean} 是否触及窗口
 */
function roadTouchesWindow(road, window) {
  for (const [lon, lat] of road.c) {
    if (lat >= window.minLat && lat <= window.maxLat && lon >= window.minLng && lon <= window.maxLng) {
      return true;
    }
  }
  return false;
}

/**
 * 按屏障切断道路（断路环境）：把落在屏障带内的点断开，保留两侧的连续段。
 *
 * @param {Array<object>} roads 道路数组
 * @param {{axis:'lat'|'lng', value:number, halfWidthMeters:number}} barrier 屏障定义
 * @returns {Array<object>} 切断后的道路数组
 */
function severRoads(roads, barrier) {
  const metersPerDegLon =
    METERS_PER_DEG_LAT * Math.cos(((barrier.lat ?? 23.1) * Math.PI) / 180);
  const inside = (point) => {
    const [lon, lat] = point;
    const delta =
      barrier.axis === 'lng'
        ? Math.abs(lon - barrier.value) * metersPerDegLon
        : Math.abs(lat - barrier.value) * METERS_PER_DEG_LAT;
    return delta <= barrier.halfWidthMeters;
  };
  const out = [];
  for (const road of roads) {
    let run = [];
    const flush = () => {
      if (run.length >= 2) {
        out.push({
          h: road.h,
          n: road.n,
          c: run.map((index) => road.c[index]),
          r: run.map((index) => road.r[index]),
        });
      }
      run = [];
    };
    for (let i = 0; i < road.c.length; i += 1) {
      if (inside(road.c[i])) {
        flush();
      } else {
        run.push(i);
      }
    }
    flush();
  }
  return out;
}

/**
 * 生成网格状合成路网（正交街道网，交点共享节点 → 真正连通）。
 *
 * @param {object} spec 生成参数
 * @returns {Array<object>} 道路数组
 */
function generateGridRoads(spec) {
  const { center, spacing, extent, fragment, sever } = spec;
  const half = Math.round(extent / spacing);
  const step = spacing / 2;
  const gridSize = 4 * half + 1;
  const latRad = (center.lat * Math.PI) / 180;
  const metersPerDegLon = METERS_PER_DEG_LAT * Math.cos(latRad);
  const nodeId = (gx, gy) => (gy + 2 * half) * gridSize + (gx + 2 * half);
  const toLng = (x) => center.lng + x / metersPerDegLon;
  const toLat = (y) => center.lat + y / METERS_PER_DEG_LAT;
  const roads = [];

  // 横向路：gy 固定为偶数行
  for (let row = 0; row <= 2 * half; row += 1) {
    if (fragment && Math.abs(row - half) <= 1) {
      continue;
    }
    const gy = 2 * (row - half);
    const c = [];
    const r = [];
    for (let gx = -2 * half; gx <= 2 * half; gx += 1) {
      c.push([toLng(gx * step), toLat(gy * step)]);
      r.push(nodeId(gx, gy));
    }
    roads.push({ h: 'residential', n: '', c, r });
  }

  // 纵向路：gx 固定为偶数列
  for (let column = 0; column <= 2 * half; column += 1) {
    if (fragment && Math.abs(column - half) <= 1) {
      continue;
    }
    const gx = 2 * (column - half);
    const c = [];
    const r = [];
    for (let gy = -2 * half; gy <= 2 * half; gy += 1) {
      c.push([toLng(gx * step), toLat(gy * step)]);
      r.push(nodeId(gx, gy));
    }
    roads.push({ h: 'residential', n: '', c, r });
  }

  if (sever) {
    return severRoads(roads, { axis: 'lng', value: center.lng, halfWidthMeters: 45, lat: center.lat });
  }
  return roads;
}

/**
 * 生成放射状合成路网（辐条 + 同心环，交点共享节点）。
 *
 * @param {object} spec 生成参数
 * @returns {Array<object>} 道路数组
 */
function generatePolarRoads(spec) {
  const { center, spokeCount, ringStep, rMin, rMax, fragment, sever } = spec;
  const ringCount = Math.max(2, Math.round((rMax - rMin) / ringStep) + 1);
  const latRad = (center.lat * Math.PI) / 180;
  const metersPerDegLon = METERS_PER_DEG_LAT * Math.cos(latRad);
  const nodeId = (ring, spoke) => ring * spokeCount + spoke;
  const toLng = (x) => center.lng + x / metersPerDegLon;
  const toLat = (y) => center.lat + y / METERS_PER_DEG_LAT;
  const roads = [];
  const radiusOf = (ring) => rMin + ring * ringStep;

  // 辐条
  for (let spoke = 0; spoke < spokeCount; spoke += 1) {
    const angle = (Math.PI * 2 * spoke) / spokeCount;
    const c = [];
    const r = [];
    for (let ring = 0; ring < ringCount; ring += 1) {
      const radius = radiusOf(ring);
      c.push([toLng(Math.cos(angle) * radius), toLat(Math.sin(angle) * radius)]);
      r.push(nodeId(ring, spoke));
    }
    roads.push({ h: 'residential', n: '', c, r });
  }

  // 同心环（首尾同点表示闭合环）
  for (let ring = 0; ring < ringCount; ring += 1) {
    // 分片：移除中间几圈环，内圈与外圈互不连通
    if (fragment && Math.abs(ring - Math.floor(ringCount / 2)) <= 1) {
      continue;
    }
    const radius = radiusOf(ring);
    const c = [];
    const r = [];
    const steps = Math.max(16, spokeCount * 2);
    for (let k = 0; k <= steps; k += 1) {
      const angle = (Math.PI * 2 * (k % steps)) / steps;
      c.push([toLng(Math.cos(angle) * radius), toLat(Math.sin(angle) * radius)]);
      r.push(nodeId(ring, k % spokeCount));
    }
    roads.push({ h: 'residential', n: '', c, r });
  }

  if (sever) {
    return severRoads(roads, { axis: 'lng', value: center.lng, halfWidthMeters: 45, lat: center.lat });
  }
  return roads;
}

/**
 * 测量路网属性：密度、走向集中度、连通性。
 *
 * 密度与走向只统计窗口内的路段（两端点都在窗口内的线段），
 * 避免把窗外延伸出去的路算进来；连通性按整张图算。
 *
 * @param {Array<object>} roads 道路数组
 * @param {{minLat:number,maxLat:number,minLng:number,maxLng:number}} bounds 统计窗口
 * @param {object} graph 建好的路网图
 * @returns {{densityKmPerKm2:number, orientationConcentration:number, connectivity:number}} 路网属性
 */
function measureNetworkProperties(roads, bounds, graph) {
  let lengthMeters = 0;
  const bins = new Array(18).fill(0);
  let segmentCount = 0;
  for (const road of roads) {
    for (let i = 1; i < road.c.length; i += 1) {
      const [lon1, lat1] = road.c[i - 1];
      const [lon2, lat2] = road.c[i];
      const inside =
        lat1 >= bounds.minLat &&
        lat1 <= bounds.maxLat &&
        lon1 >= bounds.minLng &&
        lon1 <= bounds.maxLng &&
        lat2 >= bounds.minLat &&
        lat2 <= bounds.maxLat &&
        lon2 >= bounds.minLng &&
        lon2 <= bounds.maxLng;
      if (!inside) {
        continue;
      }
      const meters = distanceMeters(lat1, lon1, lat2, lon2);
      lengthMeters += meters;
      const dx = (lon2 - lon1) * METERS_PER_DEG_LAT * Math.cos((lat1 * Math.PI) / 180);
      const dy = (lat2 - lat1) * METERS_PER_DEG_LAT;
      let bearing = (Math.atan2(dy, dx) * 180) / Math.PI;
      if (bearing < 0) {
        bearing += 180;
      }
      bins[Math.min(17, Math.floor(bearing / 10))] += 1;
      segmentCount += 1;
    }
  }
  const heightKm = ((bounds.maxLat - bounds.minLat) * METERS_PER_DEG_LAT) / 1000;
  const widthKm =
    ((bounds.maxLng - bounds.minLng) * METERS_PER_DEG_LAT * Math.cos((bounds.minLat * Math.PI) / 180)) / 1000;
  const areaKm2 = Math.max(1e-6, heightKm * widthKm);
  const densityKmPerKm2 = lengthMeters / 1000 / areaKm2;
  const orientationConcentration =
    segmentCount > 0 ? Math.max(...bins) / segmentCount : 0;
  const main = findLargestComponent(graph);
  const connectivity = graph.nodeCount > 0 ? main.size / graph.nodeCount : 0;
  return { densityKmPerKm2, orientationConcentration, connectivity };
}

/**
 * 由路网属性给出分层标签。
 *
 * @param {{densityKmPerKm2:number, orientationConcentration:number, connectivity:number}} props 路网属性
 * @param {boolean} severed 是否施加了断路
 * @returns {{density:string, orientation:string, connectivity:string, integrity:string}} 路网分层标签
 */
export function networkTagsOf(props, severed) {
  return {
    density:
      props.densityKmPerKm2 >= DENSITY_DENSE
        ? 'dense'
        : props.densityKmPerKm2 >= DENSITY_SPARSE
          ? 'medium'
          : 'sparse',
    orientation: props.orientationConcentration >= ORIENTATION_CONCENTRATED ? 'concentrated' : 'diverse',
    connectivity: props.connectivity >= CONNECTIVITY_CONNECTED ? 'connected' : 'fragmented',
    integrity: severed ? 'broken' : 'intact',
  };
}

/**
 * 计算道路集合的经纬度包围盒。
 *
 * @param {Array<object>} roads 道路数组
 * @returns {{minLat:number,maxLat:number,minLng:number,maxLng:number}} 包围盒
 */
function boundsOf(roads) {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const road of roads) {
    for (const [lon, lat] of road.c) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLng) minLng = lon;
      if (lon > maxLng) maxLng = lon;
    }
  }
  if (!Number.isFinite(minLat)) {
    return { minLat: 0, maxLat: 0, minLng: 0, maxLng: 0 };
  }
  return { minLat, maxLat, minLng, maxLng };
}

const networkCache = new Map();

/**
 * 构建一个路网实例（真实分区或合成网），并测出其分层属性。
 *
 * @param {object} instance 实例定义（REAL_REGIONS 或 SYNTHETIC_NETWORKS 的一项）
 * @returns {{id:string, kind:string, graph:object, edgeIndex:object, tags:object, props:object, bounds:object, center:{lat:number,lng:number}, reserved:boolean}} 路网实例
 */
export function buildNetwork(instance) {
  if (networkCache.has(instance.id)) {
    return networkCache.get(instance.id);
  }
  let roads;
  let center;
  let severed = Boolean(instance.sever);
  let measureBounds = null;
  if (instance.kind === 'grid' || instance.kind === 'polar') {
    roads = instance.kind === 'grid' ? generateGridRoads(instance) : generatePolarRoads(instance);
    center = instance.center;
  } else {
    const half = instance.size / 2;
    const window = {
      minLat: instance.lat - half,
      maxLat: instance.lat + half,
      minLng: instance.lng - half,
      maxLng: instance.lng + half,
    };
    measureBounds = window;
    roads = loadWalkableRoads()
      .filter((road) => roadTouchesWindow(road, window))
      .map((road) => ({
        h: road.h,
        n: road.n,
        c: road.c,
        r: road.r,
      }));
    if (instance.sever) {
      roads = severRoads(roads, {
        axis: 'lng',
        value: instance.lng,
        halfWidthMeters: 40,
        lat: instance.lat,
      });
    }
    center = { lat: instance.lat, lng: instance.lng };
  }

  const bounds = boundsOf(roads);
  const graph = buildWalkGraph(roads);
  const edgeIndex = buildEdgeIndex(graph, 0.005, findLargestComponent(graph));
  const props = measureNetworkProperties(roads, measureBounds || bounds, graph);
  const tags = networkTagsOf(props, severed);
  const built = {
    id: instance.id,
    kind: instance.kind || 'real',
    graph,
    edgeIndex,
    tags,
    props,
    bounds,
    center,
    reserved: Boolean(instance.reserved),
  };
  networkCache.set(instance.id, built);
  return built;
}

/**
 * 列出全部路网实例定义。
 *
 * @returns {Array<object>} 实例定义数组
 */
export function allNetworkInstances() {
  return [...REAL_REGIONS, ...SYNTHETIC_NETWORKS];
}

/**
 * 按 id 查找路网实例定义。
 *
 * @param {string} id 实例 id
 * @returns {object|null} 实例定义（找不到返回 null）
 */
export function networkInstanceById(id) {
  return allNetworkInstances().find((instance) => instance.id === id) || null;
}
