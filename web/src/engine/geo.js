/**
 * 地理计算共享层（清理方案 2026-11-09 §5.4-3.3）。
 *
 * 原先米/度换算常量 `111320` 在 6 个文件里各定义一份、另有 14 处内联；
 * "点到线段距离"在 4 个文件里各写一份（同一算法、不同坐标空间）。
 * 这里收敛成单一实现，**口径统一**（此前各文件的内联写法略有差异）。
 *
 * 坐标系说明：
 * - 经纬度（度）→ 米：1 纬度 ≈ 111320 m；1 经度 ≈ 111320·cos(纬度) m。
 * - 点到线段的通用算法在**平面直角坐标**里做，因此调用方要么直接传平面坐标，
 *   要么先做局部等距投影（见 `pointToSegmentMeters`）。
 */

/** 每纬度对应的米数（球面近似，常用取值） */
export const METERS_PER_DEG_LAT = 111320;

/**
 * 某纬度处每经度对应的米数。
 *
 * @param {number} lat 纬度（度）
 * @returns {number} 米/度
 */
export function metersPerDegLng(lat) {
  return METERS_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}

/**
 * 点到线段的最短距离（平面直角坐标，调用方自行保证坐标已投影）。
 *
 * @param {number} px 点 x
 * @param {number} py 点 y
 * @param {number} ax 线段起点 x
 * @param {number} ay 线段起点 y
 * @param {number} bx 线段终点 x
 * @param {number} by 线段终点 y
 * @returns {number} 距离（与输入坐标同单位）
 */
export function pointToSegmentDistanceXY(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 <= 1e-18) {
    return Math.hypot(px - ax, py - ay);
  }
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * 点到线段的最短距离（米）：以 p 点为原点做局部等距投影后按平面算法计算。
 *
 * @param {number} pLat 点纬度
 * @param {number} pLng 点经度
 * @param {number} aLat 线段起点纬度
 * @param {number} aLng 线段起点经度
 * @param {number} bLat 线段终点纬度
 * @param {number} bLng 线段终点经度
 * @returns {number} 距离（米）
 */
export function pointToSegmentMeters(pLat, pLng, aLat, aLng, bLat, bLng) {
  const mPerLng = metersPerDegLng(pLat);
  const ax = (aLng - pLng) * mPerLng;
  const ay = (aLat - pLat) * METERS_PER_DEG_LAT;
  const bx = (bLng - pLng) * mPerLng;
  const by = (bLat - pLat) * METERS_PER_DEG_LAT;
  return pointToSegmentDistanceXY(0, 0, ax, ay, bx, by);
}

/**
 * 以某点为原点的局部等距投影坐标系（"米/度"换算的唯一实现）。
 *
 * 消除 3 份手抄的等距投影公式（planner.makeCorridor / graph.projectToSegment /
 * fidelity.pointDistanceMeters）：三处都是"经纬度 → 以某纬度为中心的米制平面"
 * 再做平面几何。统一走这里后，换算口径（尤其经度按纬度余弦缩放）只维护一份。
 *
 * @param {number} originLat 原点纬度（度）
 * @param {number} originLng 原点经度（度）
 * @returns {{
 *   metersPerDegLat: number,
 *   metersPerDegLng: number,
 *   toXY: (lat: number, lng: number) => [number, number],
 *   toLatLng: (x: number, y: number) => [number, number]
 * }} 投影坐标系（toXY/toLatLng 的 x 向东、y 向北，单位米）
 */
export function localFrame(originLat, originLng) {
  const mPerLng = metersPerDegLng(originLat);
  return {
    metersPerDegLat: METERS_PER_DEG_LAT,
    metersPerDegLng: mPerLng,
    toXY: (lat, lng) => [(lng - originLng) * mPerLng, (lat - originLat) * METERS_PER_DEG_LAT],
    toLatLng: (x, y) => [originLat + y / METERS_PER_DEG_LAT, originLng + x / mPerLng],
  };
}

/**
 * 二维点集包围盒（平面坐标，单位与输入一致）。
 *
 * 消除 4 份手抄的 min/max 扫描（reference/geometry.js、path-data.js、rings.js、
 * convert.js）：返回统一结构，调用方按需取 fields。
 *
 * @param {Array<[number, number]>} points 点集
 * @returns {{minX: number, minY: number, maxX: number, maxY: number, width: number, height: number}}
 *   包围盒（空集时 minX/minY 为 Infinity、maxX/maxY 为 -Infinity，与旧实现一致）
 */
export function bboxOf(points) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}
