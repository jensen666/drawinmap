/**
 * 图形几何快照：把引擎规划结果压成"可长期保存、可原样重绘"的最小数据。
 *
 * 需求 R2/R3/R4 要求刷新后仍能查看此前画过的每一个图形，且"样式与当时一致"
 * （合格绿线 / 非合格橙色参考版）。引擎的规划结果对象体量大（metrics、legs、
 * snapped 明细、约束点索引等），直接存 localStorage 会很快撑爆配额，所以这里
 * 只保留**重绘需要的几何**：
 *
 * - outline：图形轮廓（紫色虚线）
 * - outlineParts：多部分图形（群岛等）的逐部分轮廓
 * - route：实际路线（绿线/橙线）
 * - snapped：吸附点（紫色小圆点）
 *
 * 路线点常常上千个（路网折线的每个顶点），直接存会迅速膨胀。保存前用
 * Douglas–Peucker 抽稀（容差按米计），再按点数硬上限均匀降采样：
 * 视觉上与原路线几乎一致（路线本身是折线，抽稀只去掉共线冗余点），
 * 但体积能降一个数量级。
 *
 * 纯函数，不依赖浏览器 API，Node 测试可直接导入。
 */

/** 每纬度对应的米数（WGS84 近似，够用） */
import { METERS_PER_DEG_LAT, pointToSegmentDistanceXY } from '../engine/geo.js';

/** 坐标保留小数位：5 位 ≈ 1.1m 精度，足够图形回看 */
const COORD_DECIMALS = 5;

/** 路线抽稀容差（米）：保留形状轮廓的视觉特征，抹掉共线冗余点 */
const ROUTE_TOLERANCE_METERS = 2;

/** 轮廓抽稀容差（米） */
const OUTLINE_TOLERANCE_METERS = 1.5;

/** 各类几何保存的点数硬上限（超出后均匀降采样） */
const GEOMETRY_LIMITS = Object.freeze({
  route: 420,
  outline: 160,
  outlinePart: 120,
  snapped: 120,
});

/**
 * 坐标取整（控制存储体积）。
 *
 * @param {number} value 坐标值
 * @returns {number} 取整后的坐标
 */
function roundCoord(value) {
  return Number(value.toFixed(COORD_DECIMALS));
}

/**
 * 把经纬度点列投影到以首点为原点的米制平面（抽稀需要真实距离）。
 *
 * @param {Array<Array<number>>} points [lat, lng] 点列
 * @returns {{xy: Array<Array<number>>, mPerDegLng: number}} 米制坐标与每经度米数
 */
function projectMeters(points) {
  const lat0 = points[0][0];
  const lng0 = points[0][1];
  const mPerDegLng = METERS_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);
  return {
    xy: points.map(([lat, lng]) => [
      (lat - lat0) * METERS_PER_DEG_LAT,
      (lng - lng0) * mPerDegLng,
    ]),
    mPerDegLng,
  };
}

/**
 * 点到线段的垂直距离（米）。
 *
 * @param {Array<number>} p 点
 * @param {Array<number>} a 线段起点
 * @param {Array<number>} b 线段终点
 * @returns {number} 距离（米）
 */
function perpendicularDistance(p, a, b) {
  return pointToSegmentDistanceXY(p[0], p[1], a[0], a[1], b[0], b[1]);
}

/**
 * Douglas–Peucker 抽稀（米制平面内执行）。
 *
 * @param {Array<Array<number>>} points 米制点列
 * @param {number} tolerance 容差（米）
 * @returns {Array<number>} 保留点的索引（升序）
 */
function douglasPeuckerIndexes(points, tolerance) {
  const n = points.length;
  if (n <= 2) {
    return points.map((_, index) => index);
  }
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  /** 显式栈（避免深递归） */
  const stack = [[0, n - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop();
    let maxDist = 0;
    let maxIndex = -1;
    for (let i = start + 1; i < end; i += 1) {
      const dist = perpendicularDistance(points[i], points[start], points[end]);
      if (dist > maxDist) {
        maxDist = dist;
        maxIndex = i;
      }
    }
    if (maxIndex >= 0 && maxDist > tolerance) {
      keep[maxIndex] = 1;
      stack.push([start, maxIndex], [maxIndex, end]);
    }
  }
  const indexes = [];
  for (let i = 0; i < n; i += 1) {
    if (keep[i]) {
      indexes.push(i);
    }
  }
  return indexes;
}

/**
 * 均匀降采样到不超过上限点数（保持首尾点）。
 *
 * @param {Array<Array<number>>} points 点列
 * @param {number} maxPoints 上限
 * @returns {Array<Array<number>>} 降采样后的点列
 */
function capPoints(points, maxPoints) {
  if (points.length <= maxPoints || maxPoints < 2) {
    return points;
  }
  const step = (points.length - 1) / (maxPoints - 1);
  const out = [];
  for (let i = 0; i < maxPoints; i += 1) {
    out.push(points[Math.round(i * step)]);
  }
  return out;
}

/**
 * 抽稀 + 限长 + 取整：把引擎点列转成可保存的紧凑点列。
 *
 * @param {Array<Array<number>>} points [lat, lng] 点列
 * @param {number} tolerance 容差（米）
 * @param {number} maxPoints 点数上限
 * @returns {Array<Array<number>>} 紧凑点列
 */
export function compactPoints(points, tolerance, maxPoints) {
  if (!Array.isArray(points) || points.length === 0) {
    return [];
  }
  const valid = points.filter(
    (item) => Array.isArray(item) && Number.isFinite(item[0]) && Number.isFinite(item[1]),
  );
  if (valid.length <= 2) {
    return valid.map(([lat, lng]) => [roundCoord(lat), roundCoord(lng)]);
  }
  const { xy } = projectMeters(valid);
  const indexes = douglasPeuckerIndexes(xy, tolerance);
  const kept = indexes.map((index) => valid[index]);
  const capped = capPoints(kept, maxPoints);
  return capped.map(([lat, lng]) => [roundCoord(lat), roundCoord(lng)]);
}

/**
 * 从引擎规划结果抽取可保存的几何快照。
 *
 * @param {object} result 引擎结果（outlineLatLngs/routeLatLngs/snapped/outlineParts）
 * @returns {{outline: Array<Array<number>>, outlineParts: Array<Array<Array<number>>>|null,
 *   route: Array<Array<number>>, snapped: Array<Array<number>>}} 几何快照
 */
export function captureGeometry(result) {
  if (!result || typeof result !== 'object') {
    return { outline: [], outlineParts: null, route: [], snapped: [] };
  }
  const outlineParts = Array.isArray(result.outlineParts) && result.outlineParts.length > 1
    ? result.outlineParts.map((part) =>
        compactPoints(part, OUTLINE_TOLERANCE_METERS, GEOMETRY_LIMITS.outlinePart),
      )
    : null;
  const snapped = Array.isArray(result.snapped)
    ? compactPoints(
        result.snapped.map((item) => [item.lat, item.lng]),
        0,
        GEOMETRY_LIMITS.snapped,
      )
    : [];
  return {
    outline: compactPoints(
      result.outlineLatLngs || [],
      OUTLINE_TOLERANCE_METERS,
      GEOMETRY_LIMITS.outline,
    ),
    outlineParts,
    route: compactPoints(result.routeLatLngs || [], ROUTE_TOLERANCE_METERS, GEOMETRY_LIMITS.route),
    snapped,
  };
}

/**
 * 把保存的几何快照还原成引擎绘制需要的结构。
 *
 * 键名与 captureGeometry 的输出**完全一致**（outline / outlineParts / route /
 * snapped），也正是 shape-engine.js 的 geometryOf() 使用的结构——直接对接绘制层，
 * 不做二次转换（键名一旦对不上，重绘就会只画吸附点、丢掉路线）。
 *
 * @param {{outline: Array<Array<number>>, outlineParts: Array<Array<Array<number>>>|null,
 *   route: Array<Array<number>>, snapped: Array<Array<number>>}} geometry 几何快照
 * @returns {{outline: Array<Array<number>>, outlineParts: Array<Array<Array<number>>>|null,
 *   route: Array<Array<number>>, snapped: Array<{lat: number, lng: number}>}} 绘制用几何
 */
export function restoreGeometry(geometry) {
  const safe = geometry || {};
  return {
    outline: Array.isArray(safe.outline) ? safe.outline : [],
    outlineParts: Array.isArray(safe.outlineParts) ? safe.outlineParts : null,
    route: Array.isArray(safe.route) ? safe.route : [],
    snapped: Array.isArray(safe.snapped)
      ? safe.snapped.map(([lat, lng]) => ({ lat, lng }))
      : [],
  };
}

/**
 * 几何快照的总点数（存储体积估算与"是否为空"判定）。
 *
 * @param {object} geometry 几何快照
 * @returns {number} 点数总和
 */
export function geometryPointCount(geometry) {
  const safe = geometry || {};
  const parts = Array.isArray(safe.outlineParts)
    ? safe.outlineParts.reduce((sum, part) => sum + (Array.isArray(part) ? part.length : 0), 0)
    : 0;
  return (
    (Array.isArray(safe.outline) ? safe.outline.length : 0) +
    parts +
    (Array.isArray(safe.route) ? safe.route.length : 0) +
    (Array.isArray(safe.snapped) ? safe.snapped.length : 0)
  );
}
