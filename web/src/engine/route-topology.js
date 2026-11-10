/**
 * 路线拓扑诊断指标：唯一交叉（非相邻段交叉）与重复道路比例。
 *
 * 用途（《图形路线视觉效果通用优化方案》阶段 0）：只实现指标与日志，
 * 不参与评分与门禁判定；阈值待阶段 2 用全量语料校准后再定。
 *
 * 几何口径：与 engine/fidelity.js 保持一致——等距圆柱投影近似，
 * 每纬度 111320m，经度按 cos(纬度) 缩放。投影原点取全部参与点的平均经纬度，
 * 使整条路线落在同一个平面坐标系内（叉积法求交要求平面一致）；
 * 经度缩放按该局部平均纬度取值，单个图形尺度上的误差在米级以下。
 *
 * 复杂度保护：段数 × 段间点对。先按总子段数上限降采样，再用腿级包围盒剪枝，
 * 保证在搜索预算内不拖慢（见 MAX_TOTAL_SEGMENTS / MAX_LEGS）。
 * 降采样是均匀抽样，极短的交叉可能被抽样跳过——本模块只作诊断指标使用。
 *
 * 纯函数、无浏览器 API、无副作用。
 */

/** 每纬度约对应的米数（与 engine/fidelity.js 同口径） */
import { METERS_PER_DEG_LAT } from './geo.js';

/**
 * 端点接触容差（米）：交点落在任一参与腿的端点附近即视为合法接缝 /
 * 必要重复访问，不计入交叉。默认 1.0m。
 */
const CROSSING_ENDPOINT_TOLERANCE_METERS = 1;

/**
 * 聚类去重容差（米）：同一处交点被多对腿命中时按空间距离合并，只算一次。
 * 略大于端点接触容差，使"同一路口被不同腿对命中"这种轻微偏移也能合并。
 */
const CROSSING_CLUSTER_TOLERANCE_METERS = 2;

/** 单次统计允许的腿数上限（腿数是二次项，必须设上界） */
const MAX_LEGS = 256;

/** 单次统计允许的总子段数上限（超出先降采样；每腿保底 1 段，故实际上界再多 MAX_LEGS 段） */
const MAX_TOTAL_SEGMENTS = 1500;

/** 平行/共线判定的相对阈值（叉积面积 / 两段长乘积）的平方，避免热路径开方 */
const PARALLEL_EPSILON_SQ = 1e-18;

/** 交点参数 t/u 的越界容差（吸收浮点误差） */
const PARAM_EPSILON = 1e-9;

/**
 * 统计路线各腿之间的"唯一交叉"（非相邻段交叉）。
 *
 * 口径：
 * - 相邻腿（i 与 i+1）与首尾闭合腿（0 与 n-1）之间的接缝不算交叉；
 * - 交点落在任一参与腿端点附近（默认 1.0m）视为合法接缝/必要重复访问，不计入；
 * - 同一处交点被多对腿命中时按空间聚类只算一次；
 * - 共线重叠不算交叉（避免长直边重叠刷计数）。
 *
 * @param {Array<Array<[number, number]>>} legs 各腿折线（每腿 [[lat,lng], ...]）
 * @param {{endpointToleranceMeters?: number, clusterToleranceMeters?: number}} [options]
 *   容差覆盖（米）；非法值回落默认常量
 * @returns {{count: number, points: Array<[number, number]>}} 唯一交叉数与交点坐标；
 *   输入无法判定时返回 {count: 0, points: []}
 */
export function countUniqueCrossings(legs, options) {
  const empty = { count: 0, points: [] };
  if (!Array.isArray(legs) || legs.length === 0) {
    return empty;
  }
  const opts = options && typeof options === 'object' ? options : {};
  const endpointTolerance = positiveOption(opts.endpointToleranceMeters, CROSSING_ENDPOINT_TOLERANCE_METERS);
  const clusterTolerance = positiveOption(opts.clusterToleranceMeters, CROSSING_CLUSTER_TOLERANCE_METERS);

  const normalized = normalizeLegs(legs);
  const legCount = normalized.length;
  if (legCount < 2) {
    return empty;
  }
  const frame = createFrame(normalized);
  if (!frame) {
    return empty;
  }
  // 投影到同一平面 → 按预算降采样 → 腿级包围盒剪枝 → 子段叉积求交
  const projected = downsampleLegs(
    normalized.map((leg) => leg.map(([lat, lng]) => toMeters(lat, lng, frame))),
    MAX_TOTAL_SEGMENTS,
  );
  const bounds = projected.map(legBounds);
  const hits = [];
  const limit = Math.min(legCount, MAX_LEGS);
  for (let a = 0; a < limit; a += 1) {
    const legA = projected[a];
    if (legA.length < 2) {
      continue;
    }
    for (let b = a + 1; b < limit; b += 1) {
      const legB = projected[b];
      if (legB.length < 2 || isSeamPair(a, b, legCount)) {
        continue;
      }
      if (!boundsOverlap(bounds[a], bounds[b], endpointTolerance)) {
        continue;
      }
      collectCrossings(legA, legB, endpointTolerance, hits);
    }
  }
  const clusters = dedupeHits(hits, clusterTolerance);
  return { count: clusters.length, points: clusters.map((c) => toLatLng(c[0], c[1], frame)) };
}

/**
 * 重复道路比例：reusedEdgeMeters / routeMeters。
 *
 * 缺失/非有限/负值、routeMeters <= 0 一律返回 null——不得用 0 冒充"没有重复"。
 * 结果夹到 [0,1]；原始字段请用 routeReuseSummary 透传（便于日志发现异常账目）。
 *
 * @param {{reusedEdgeMeters?: number, routeMeters?: number}} metrics 规划结果的 metrics
 * @returns {number|null} 比例（0~1）；无法判定返回 null
 */
export function reusedEdgeRatio(metrics) {
  if (!metrics || typeof metrics !== 'object') {
    return null;
  }
  const reused = metrics.reusedEdgeMeters;
  const total = metrics.routeMeters;
  if (!Number.isFinite(reused) || !Number.isFinite(total)) {
    return null;
  }
  if (total <= 0 || reused < 0) {
    return null;
  }
  const ratio = reused / total;
  if (!Number.isFinite(ratio)) {
    return null;
  }
  return Math.min(1, Math.max(0, ratio));
}

/**
 * 复用原始字段透传（便于日志）：总路长、复用米数、复用边数与比例。
 * 非有限/缺失字段按 null（未知）透传，不把 Infinity 写进日志。
 *
 * @param {{routeMeters?: number, reusedEdgeMeters?: number, reusedEdgeCount?: number}} metrics
 *   规划结果的 metrics
 * @returns {{routeMeters: number|null, reusedEdgeMeters: number|null,
 *   reusedEdgeCount: number|null, reusedEdgeRatio: number|null}} 原始字段与比例
 */
export function routeReuseSummary(metrics) {
  const source = metrics && typeof metrics === 'object' ? metrics : {};
  return {
    routeMeters: finiteOrNull(source.routeMeters),
    reusedEdgeMeters: finiteOrNull(source.reusedEdgeMeters),
    reusedEdgeCount: finiteOrNull(source.reusedEdgeCount),
    reusedEdgeRatio: reusedEdgeRatio(source),
  };
}

/**
 * 汇总路线拓扑诊断指标（阶段 0 的"指标 + 日志"入口）。
 *
 * @param {{legs?: Array<Array<[number, number]>>, metrics?: object}} input
 *   legs 取规划结果的 legs（各腿折线），metrics 取规划结果的 metrics
 * @returns {{crossings: {count: number, points: Array<[number, number]>},
 *   reuse: {routeMeters: number|null, reusedEdgeMeters: number|null,
 *   reusedEdgeCount: number|null, reusedEdgeRatio: number|null}}} 拓扑诊断汇总
 */
export function collectRouteTopologyMetrics(input) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    crossings: countUniqueCrossings(source.legs),
    reuse: routeReuseSummary(source.metrics),
  };
}

/**
 * 读取合法的正数选项（非法值回落默认值）。
 * @param {unknown} value 候选值
 * @param {number} fallback 默认值
 * @returns {number} 合法正数或默认值
 */
function positiveOption(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * 有限数转 null（缺失/NaN/Infinity 统一按未知处理）。
 * @param {unknown} value 候选值
 * @returns {number|null} 有限数或 null
 */
function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 规整腿数组：丢弃非法点，但保留腿的空位（腿序号与邻接关系必须保持不变）。
 * @param {Array<Array<[number, number]>>} legs 原始腿数组
 * @returns {Array<Array<[number, number]>>} 规整后的腿数组
 */
function normalizeLegs(legs) {
  const out = [];
  for (const leg of legs) {
    const points = [];
    if (Array.isArray(leg)) {
      for (const p of leg) {
        if (!Array.isArray(p) || p.length < 2) {
          continue;
        }
        const lat = p[0];
        const lng = p[1];
        if (typeof lat !== 'number' || typeof lng !== 'number') {
          continue;
        }
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
          continue;
        }
        points.push([lat, lng]);
      }
    }
    out.push(points);
  }
  return out;
}

/**
 * 建立局部平面坐标系：以全部参与点的平均经纬度为原点，经度按 cos(参考纬度) 缩放。
 * @param {Array<Array<[number, number]>>} legs 规整后的腿数组
 * @returns {{refLat: number, refLng: number, metersPerDegLng: number}|null} 坐标系；无法判定返回 null
 */
function createFrame(legs) {
  let latSum = 0;
  let lngSum = 0;
  let count = 0;
  for (const leg of legs) {
    for (const [lat, lng] of leg) {
      latSum += lat;
      lngSum += lng;
      count += 1;
    }
  }
  if (count === 0) {
    return null;
  }
  const refLat = latSum / count;
  const refLng = lngSum / count;
  const metersPerDegLng = METERS_PER_DEG_LAT * Math.cos((refLat * Math.PI) / 180);
  if (!Number.isFinite(metersPerDegLng) || metersPerDegLng <= 0) {
    return null;
  }
  return { refLat, refLng, metersPerDegLng };
}

/**
 * 经纬度 → 平面米制坐标。
 * @param {number} lat 纬度
 * @param {number} lng 经度
 * @param {{refLat: number, refLng: number, metersPerDegLng: number}} frame 坐标系
 * @returns {[number, number]} [x 向东米, y 向北米]
 */
function toMeters(lat, lng, frame) {
  return [(lng - frame.refLng) * frame.metersPerDegLng, (lat - frame.refLat) * METERS_PER_DEG_LAT];
}

/**
 * 平面米制坐标 → 经纬度。
 * @param {number} x 向东米
 * @param {number} y 向北米
 * @param {{refLat: number, refLng: number, metersPerDegLng: number}} frame 坐标系
 * @returns {[number, number]} [lat, lng]
 */
function toLatLng(x, y, frame) {
  return [frame.refLat + y / METERS_PER_DEG_LAT, frame.refLng + x / frame.metersPerDegLng];
}

/**
 * 折线均匀抽样（保留首尾）：点数压到 keep。
 * @param {Array<[number, number]>} points 折线
 * @param {number} keep 目标点数
 * @returns {Array<[number, number]>} 抽样后的折线
 */
function downsamplePolyline(points, keep) {
  if (keep >= points.length) {
    return points;
  }
  if (keep <= 1) {
    return points.slice(0, 1);
  }
  const out = [];
  for (let k = 0; k < keep; k += 1) {
    out.push(points[Math.round((k * (points.length - 1)) / (keep - 1))]);
  }
  return out;
}

/**
 * 腿集合降采样到总子段数预算内：按比例均匀削减，每条有内容的腿至少保留 2 点。
 * @param {Array<Array<[number, number]>>} legs 投影后的腿数组
 * @param {number} maxTotalSegments 总子段数上限
 * @returns {Array<Array<[number, number]>>} 降采样后的腿数组
 */
function downsampleLegs(legs, maxTotalSegments) {
  let current = legs;
  for (let pass = 0; pass < 4; pass += 1) {
    const segments = current.map((leg) => Math.max(0, leg.length - 1));
    const total = segments.reduce((sum, n) => sum + n, 0);
    if (total <= maxTotalSegments) {
      return current;
    }
    const ratio = maxTotalSegments / total;
    current = current.map((leg, index) => {
      if (segments[index] === 0) {
        return leg;
      }
      const keep = Math.max(2, Math.min(leg.length, Math.ceil(leg.length * ratio)));
      return downsamplePolyline(leg, keep);
    });
  }
  return current;
}

/**
 * 腿级包围盒（米）。
 * @param {Array<[number, number]>} leg 投影后的腿
 * @returns {{minX: number, minY: number, maxX: number, maxY: number}} 包围盒
 */
function legBounds(leg) {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [x, y] of leg) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * 两个包围盒是否可能相交（按容差外扩，用于腿级剪枝）。
 * @param {{minX: number, minY: number, maxX: number, maxY: number}} a 包围盒 A
 * @param {{minX: number, minY: number, maxX: number, maxY: number}} b 包围盒 B
 * @param {number} pad 外扩量（米）
 * @returns {boolean} 是否可能相交
 */
function boundsOverlap(a, b, pad) {
  return (
    a.minX - pad <= b.maxX &&
    b.minX - pad <= a.maxX &&
    a.minY - pad <= b.maxY &&
    b.minY - pad <= a.maxY
  );
}

/**
 * 腿对是否为接缝（相邻腿或首尾闭合腿）——接缝不算交叉。
 * @param {number} i 腿序号（小）
 * @param {number} j 腿序号（大）
 * @param {number} legCount 总腿数
 * @returns {boolean} 是否为接缝腿对
 */
function isSeamPair(i, j, legCount) {
  if (Math.abs(i - j) === 1) {
    return true;
  }
  return legCount >= 2 && i === 0 && j === legCount - 1;
}

/**
 * 两子段求交（标准叉积参数法）。
 * 平行或共线的子段返回 null（不算交叉），避免长直边重叠刷计数。
 * @param {[number, number]} p1 子段 A 起点
 * @param {[number, number]} p2 子段 A 终点
 * @param {[number, number]} q1 子段 B 起点
 * @param {[number, number]} q2 子段 B 终点
 * @returns {[number, number]|null} 交点（米）或 null
 */
function segmentIntersection(p1, p2, q1, q2) {
  const rx = p2[0] - p1[0];
  const ry = p2[1] - p1[1];
  const sx = q2[0] - q1[0];
  const sy = q2[1] - q1[1];
  const rLen2 = rx * rx + ry * ry;
  const sLen2 = sx * sx + sy * sy;
  if (rLen2 === 0 || sLen2 === 0) {
    return null; // 退化子段（重复点）
  }
  const denom = rx * sy - ry * sx;
  if (denom * denom <= PARALLEL_EPSILON_SQ * rLen2 * sLen2) {
    return null; // 平行或共线
  }
  const qpx = q1[0] - p1[0];
  const qpy = q1[1] - p1[1];
  const t = (qpx * sy - qpy * sx) / denom;
  const u = (qpx * ry - qpy * rx) / denom;
  if (t < -PARAM_EPSILON || t > 1 + PARAM_EPSILON) {
    return null;
  }
  if (u < -PARAM_EPSILON || u > 1 + PARAM_EPSILON) {
    return null;
  }
  return [p1[0] + t * rx, p1[1] + t * ry];
}

/**
 * 交点是否贴近某条腿的端点（合法接缝 / 必要重复访问）。
 * @param {[number, number]} point 交点（米）
 * @param {Array<[number, number]>} leg 投影后的腿
 * @param {number} tolerance 容差（米）
 * @returns {boolean} 是否为端点接触
 */
function isEndpointTouch(point, leg, tolerance) {
  if (leg.length < 2) {
    return false;
  }
  const first = leg[0];
  const last = leg[leg.length - 1];
  if (Math.hypot(point[0] - first[0], point[1] - first[1]) < tolerance) {
    return true;
  }
  return Math.hypot(point[0] - last[0], point[1] - last[1]) < tolerance;
}

/**
 * 收集两条腿之间的有效交点（排除端点接触）。
 * @param {Array<[number, number]>} legA 腿 A（米）
 * @param {Array<[number, number]>} legB 腿 B（米）
 * @param {number} tolerance 端点接触容差（米）
 * @param {Array<[number, number]>} out 交点收集桶
 */
function collectCrossings(legA, legB, tolerance, out) {
  for (let i = 1; i < legA.length; i += 1) {
    const p1 = legA[i - 1];
    const p2 = legA[i];
    for (let j = 1; j < legB.length; j += 1) {
      const hit = segmentIntersection(p1, p2, legB[j - 1], legB[j]);
      if (!hit) {
        continue;
      }
      if (isEndpointTouch(hit, legA, tolerance) || isEndpointTouch(hit, legB, tolerance)) {
        continue;
      }
      out.push(hit);
    }
  }
}

/**
 * 交点空间聚类去重：同一处交点被多对腿命中时只保留一个代表点。
 * 用格网做近邻查找，线性复杂度。
 * @param {Array<[number, number]>} hits 交点列表（米）
 * @param {number} tolerance 聚类容差（米）
 * @returns {Array<[number, number]>} 去重后的交点代表列表
 */
function dedupeHits(hits, tolerance) {
  const cell = tolerance > 0 ? tolerance : 1;
  const buckets = new Map();
  const clusters = [];
  for (const hit of hits) {
    const cx = Math.floor(hit[0] / cell);
    const cy = Math.floor(hit[1] / cell);
    let duplicate = false;
    for (let dx = -1; dx <= 1 && !duplicate; dx += 1) {
      for (let dy = -1; dy <= 1 && !duplicate; dy += 1) {
        const bucket = buckets.get(`${cx + dx},${cy + dy}`);
        if (!bucket) {
          continue;
        }
        for (const c of bucket) {
          if (Math.hypot(c[0] - hit[0], c[1] - hit[1]) <= tolerance) {
            duplicate = true;
            break;
          }
        }
      }
    }
    if (duplicate) {
      continue;
    }
    const key = `${cx},${cy}`;
    if (!buckets.has(key)) {
      buckets.set(key, []);
    }
    buckets.get(key).push([hit[0], hit[1]]);
    clusters.push([hit[0], hit[1]]);
  }
  return clusters;
}
