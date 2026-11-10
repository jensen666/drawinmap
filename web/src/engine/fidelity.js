/**
 * 贴合度指标：衡量规划出的真实路线"像不像"理想图形。
 *
 * 全局双向偏差（shapeFidelity，无对应关系）：
 * - 轮廓 → 路线：理想轮廓采样点到实际路线的距离（图形有没有被走出来）；
 * - 路线 → 轮廓：实际路线到理想轮廓的距离（路线有没有乱跑）。
 * 保留用于对照与界面展示；评分与门槛使用有序指标。
 *
 * 有序分段贴合（orderedFidelity）：第 N 段实际路线只与第 N 段理想目标比较，
 * 消除"路线贴着错误的边也能得低偏差"的全局盲区。
 *
 * 距离用等距圆柱投影近似（本地纬度下误差可忽略）。纯函数，Node 可直接测试。
 */

/** 局部等距投影的唯一实现（geo.localFrame）与点到线段距离 */
import { localFrame, pointToSegmentMeters } from './geo.js';

/**
 * Fréchet 计算的折线重采样步长 = 图形尺寸 × 该比例（约 1%）。
 * 离散 Fréchet 只按顶点配对，目标段顶点过稀会产生"长直边中段距离≈半段长"的
 * 采样伪影（与路线是否折返无关）。按 1% 尺寸重采样目标是通用做法（对所有
 * 图形/段落一致，不针对具体形状），让度量逼近连续 Fréchet；15% 质量门槛不变。
 */
const FRECHET_RESAMPLE_STEP_RATIO = 0.01;

/** 重采样步长下限（米）：极小图形也能保持足够顶点数，同时避免步长趋 0 */
const FRECHET_RESAMPLE_MIN_STEP_METERS = 5;

/** 单条折线重采样点数上限（防御超长段把 O(n·m) 动态规划撑爆） */
const FRECHET_RESAMPLE_MAX_POINTS = 400;

/**
 * 折线按弧长稠密重采样（保留首尾）：在每段内等分插点，使相邻点弧长间距
 * 不超过 max(步长下限, 尺寸 × 1%)，总点数封顶 FRECHET_RESAMPLE_MAX_POINTS
 * （超长折线退化为均匀抽样，只影响度量精度、不影响几何）。
 * 只增加顶点、不改变折线几何，用于消除离散 Fréchet 的采样密度依赖。
 *
 * @param {Array<[number, number]>} points 折线 [[lat, lng], ...]
 * @param {number} sizeMeters 图形尺寸（米），决定重采样步长
 * @returns {Array<[number, number]>} 重采样后的折线（可能多于输入点）
 */
export function densifyPolyline(points, sizeMeters) {
  if (!Array.isArray(points) || points.length < 2) {
    return points;
  }
  const stepMeters = Math.max(
    FRECHET_RESAMPLE_MIN_STEP_METERS,
    Number.isFinite(sizeMeters) && sizeMeters > 0 ? sizeMeters * FRECHET_RESAMPLE_STEP_RATIO : 0,
  );
  const out = [points[0]];
  for (let i = 1; i < points.length; i += 1) {
    const [lat1, lng1] = points[i - 1];
    const [lat2, lng2] = points[i];
    const legMeters = pointDistanceMeters(lat1, lng1, lat2, lng2);
    const pieces = Math.max(1, Math.ceil(legMeters / stepMeters));
    for (let k = 1; k <= pieces; k += 1) {
      const t = k / pieces;
      out.push([lat1 + (lat2 - lat1) * t, lng1 + (lng2 - lng1) * t]);
    }
  }
  if (out.length <= FRECHET_RESAMPLE_MAX_POINTS) {
    return out;
  }
  // 超长折线：均匀抽样到上限（保留首尾），保证动态规划规模有界且确定
  const sampled = [out[0]];
  for (let k = 1; k < FRECHET_RESAMPLE_MAX_POINTS - 1; k += 1) {
    sampled.push(out[Math.round((k * (out.length - 1)) / (FRECHET_RESAMPLE_MAX_POINTS - 1))]);
  }
  sampled.push(out[out.length - 1]);
  return sampled;
}

/**
 * 点到折线的最短距离（米）。
 *
 * @param {number} lat 点纬度
 * @param {number} lng 点经度
 * @param {Array<[number, number]>} polyline 折线 [[lat, lng], ...]
 * @returns {number} 距离（米）；折线不足 2 点返回 Infinity
 */
export function pointToPolylineMeters(lat, lng, polyline) {
  let min = Number.POSITIVE_INFINITY;
  for (let i = 1; i < polyline.length; i += 1) {
    const d = pointToSegmentMeters(
      lat,
      lng,
      polyline[i - 1][0],
      polyline[i - 1][1],
      polyline[i][0],
      polyline[i][1],
    );
    if (d < min) {
      min = d;
    }
  }
  return min;
}

/**
 * 计算规划结果的贴合度。
 *
 * @param {object} result 规划结果（含 outlineLatLngs / routeLatLngs / sizeMeters）
 * @returns {{
 *   outlineMeanMeters: number,
 *   outlineMaxMeters: number,
 *   routeMeanMeters: number,
 *   routeMaxMeters: number,
 *   outlineMeanRatio: number,
 *   outlineMaxRatio: number,
 *   routeMeanRatio: number,
 *   routeMaxRatio: number
 * }} 贴合度指标（ratio 为偏差 ÷ 图形尺寸，跨尺寸可比）
 */
export function shapeFidelity({ outlineLatLngs, routeLatLngs, sizeMeters }) {
  // 两条折线都先闭合再算距离——轮廓/路线都是环，不闭合会漏掉最后一条边
  // （矩形 4 角只连成 3 条边，导致西边鼓包逃离贴合度考核的教训）
  // 路线点抽样到上限：全局指标只用于对照展示（评分与门槛用有序全量指标）
  const outline = closePolyline(outlineLatLngs || []);
  const route = closePolyline(sampleRouteForDisplay(routeLatLngs || [], 128));
  if (outline.length < 2 || route.length < 2 || !Number.isFinite(sizeMeters) || sizeMeters <= 0) {
    return {
      outlineMeanMeters: Number.POSITIVE_INFINITY,
      outlineMaxMeters: Number.POSITIVE_INFINITY,
      routeMeanMeters: Number.POSITIVE_INFINITY,
      routeMaxMeters: Number.POSITIVE_INFINITY,
      outlineMeanRatio: Number.POSITIVE_INFINITY,
      outlineMaxRatio: Number.POSITIVE_INFINITY,
      routeMeanRatio: Number.POSITIVE_INFINITY,
      routeMaxRatio: Number.POSITIVE_INFINITY,
    };
  }

  let outlineSum = 0;
  let outlineMax = 0;
  for (const [lat, lng] of outline) {
    const d = pointToPolylineMeters(lat, lng, route);
    outlineSum += d;
    if (d > outlineMax) {
      outlineMax = d;
    }
  }
  let routeSum = 0;
  let routeMax = 0;
  for (const [lat, lng] of route) {
    const d = pointToPolylineMeters(lat, lng, outline);
    routeSum += d;
    if (d > routeMax) {
      routeMax = d;
    }
  }

  const outlineMeanMeters = outlineSum / outline.length;
  const routeMeanMeters = routeSum / route.length;
  return {
    outlineMeanMeters,
    outlineMaxMeters: outlineMax,
    routeMeanMeters,
    routeMaxMeters: routeMax,
    outlineMeanRatio: outlineMeanMeters / sizeMeters,
    outlineMaxRatio: outlineMax / sizeMeters,
    routeMeanRatio: routeMeanMeters / sizeMeters,
    routeMaxRatio: routeMax / sizeMeters,
  };
}

/** 折线等距抽样（保留首尾），仅全局对照展示使用 */
function sampleRouteForDisplay(points, cap) {
  if (points.length <= cap) {
    return points;
  }
  const sampled = [points[0]];
  for (let k = 1; k < cap - 1; k += 1) {
    const index = Math.round((k * (points.length - 1)) / (cap - 1));
    if (index > 0 && index < points.length - 1) {
      sampled.push(points[index]);
    }
  }
  sampled.push(points[points.length - 1]);
  return sampled;
}

/** 闭合折线：首尾不同则补上首点（不足 2 点原样返回） */
function closePolyline(points) {
  if (points.length < 2) {
    return points;
  }
  const [firstLat, firstLng] = points[0];
  const [lastLat, lastLng] = points[points.length - 1];
  if (firstLat === lastLat && firstLng === lastLng) {
    return points;
  }
  return [...points, points[0]];
}

/** 两点距离（米，等距圆柱投影近似）：
 * 复用 geo.localFrame 的米/度换算（以两点中纬度为原点纬度，只取换算常量），
 * 与旧式 dx/dy 手写公式逐位一致。 */
function pointDistanceMeters(lat1, lng1, lat2, lng2) {
  const frame = localFrame((lat1 + lat2) / 2, lng1);
  const dx = (lng2 - lng1) * frame.metersPerDegLng;
  const dy = (lat2 - lat1) * frame.metersPerDegLat;
  return Math.hypot(dx, dy);
}

/**
 * 离散 Fréchet 距离（米）：衡量两条折线的"保序曲线相似度"。
 *
 * 与逐点/逐段偏差不同，Fréchet 要求沿两条曲线**顺序前进**地配对，
 * 能发现"路线在同一段内顺序错乱/来回折返"这类有序贴合指标漏掉的问题
 * （例如腿间隙被绕成麻花：每段都贴着目标，但配对顺序已经乱了）。
 *
 * 注意：离散 Fréchet 只按**顶点**配对，结果依赖采样密度。目标段如果只有
 * 2 个顶点（长直边两个约束点之间的轮廓切片），任何走到中段的路线点到两个
 * 端点的距离都接近半段长，Fréchet 会被采样伪影抬到 ≈ 段长/2——实测马的
 * 1500m 直边段 745m（20.7%）全是这个伪影，与路线是否折返无关。调用方
 * （orderedFidelity）因此先对目标段/路线做稠密重采样再计算，见 densifyPolyline。
 *
 * 动态规划 O(n·m)；单段目标折线 2~15 点、路线几百点，成本可控。
 *
 * @param {Array<[number, number]>} polylineA 折线 A [[lat,lng],...]
 * @param {Array<[number, number]>} polylineB 折线 B [[lat,lng],...]
 * @returns {number} Fréchet 距离（米）；非法输入返回 Infinity
 */
export function discreteFrechetMeters(polylineA, polylineB) {
  const n = polylineA.length;
  const m = polylineB.length;
  if (n === 0 || m === 0) {
    return Number.POSITIVE_INFINITY;
  }
  // 距离矩阵按需计算并缓存
  const dist = Array.from({ length: n }, () => new Array(m));
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < m; j += 1) {
      dist[i][j] = pointDistanceMeters(
        polylineA[i][0],
        polylineA[i][1],
        polylineB[j][0],
        polylineB[j][1],
      );
    }
  }
  const ca = Array.from({ length: n }, () => new Array(m));
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < m; j += 1) {
      const d = dist[i][j];
      if (i === 0 && j === 0) {
        ca[i][j] = d;
      } else if (i === 0) {
        ca[i][j] = Math.max(ca[i][j - 1], d);
      } else if (j === 0) {
        ca[i][j] = Math.max(ca[i - 1][j], d);
      } else {
        ca[i][j] = Math.max(Math.min(ca[i - 1][j], ca[i - 1][j - 1], ca[i][j - 1]), d);
      }
    }
  }
  return ca[n - 1][m - 1];
}
/**
 * 有序分段贴合：第 N 段实际路线只与第 N 段理想目标比较（两个方向），
 * 全局指标"靠近错误的边也得低偏差"的盲区由此消除。
 *
 * 段缺失、段数不匹配或尺寸非法时全部指标为 Infinity（上层质量门槛判不达标）。
 *
 * 两方向均用全量点计算（不做抽样）：最大偏差在抽样点之外的尖刺/折返
 * 必须被计入——实测均匀抽样到 48 点时 101 点路线上的 1 km 尖刺测得 ≈0 偏差。
 * 目标折线是约束点间的短切片（内置图形 2~15 点），全量成本可控；路线点
 * 是逐段几百个路网节点，实测在搜索预算内。
 *
 * @param {object} options
 * @param {Array<Array<[number, number]>>} options.legTargets 各段理想目标折线 [[lat,lng],...]
 * @param {Array<Array<[number, number]>>} options.legRoutes 各段实际路线 [[lat,lng],...]
 * @param {number} options.sizeMeters 图形外接尺寸（米）
 * @param {boolean} [options.collectOutlineRatios] 为真时附带两侧相对偏差样本：
 *   轮廓点到本段路线、本段路线点到目标段，都是距离 ÷ 尺寸。
 *   默认不收集，避免搜索热路径多留数组。
 * @returns {{
 *   orderedOutlineMeanMeters: number, orderedOutlineMaxMeters: number,
 *   orderedRouteMeanMeters: number, orderedRouteMaxMeters: number,
 *   orderedOutlineMeanRatio: number, orderedOutlineMaxRatio: number,
 *   orderedRouteMeanRatio: number, orderedRouteMaxRatio: number,
 *   worstLegIndex: number, worstLegOutlineMeters: number
 * }} 有序贴合指标（ratio 为偏差 ÷ 图形尺寸），worstLeg* 为最差段定位（诊断用）
 */
export function orderedFidelity({ legTargets, legRoutes, sizeMeters, collectOutlineRatios = false }) {
  const invalid = {
    orderedOutlineMeanMeters: Number.POSITIVE_INFINITY,
    orderedOutlineMaxMeters: Number.POSITIVE_INFINITY,
    orderedRouteMeanMeters: Number.POSITIVE_INFINITY,
    orderedRouteMaxMeters: Number.POSITIVE_INFINITY,
    orderedOutlineMeanRatio: Number.POSITIVE_INFINITY,
    orderedOutlineMaxRatio: Number.POSITIVE_INFINITY,
    orderedRouteMeanRatio: Number.POSITIVE_INFINITY,
    orderedRouteMaxRatio: Number.POSITIVE_INFINITY,
    orderedOutlineRms: Number.POSITIVE_INFINITY,
    orderedRouteRms: Number.POSITIVE_INFINITY,
    frechetMaxMeters: Number.POSITIVE_INFINITY,
    frechetMeanMeters: Number.POSITIVE_INFINITY,
    frechetMaxRatio: Number.POSITIVE_INFINITY,
    worstLegIndex: -1,
    worstLegOutlineMeters: Number.POSITIVE_INFINITY,
  };
  const targets = legTargets || [];
  const routes = legRoutes || [];
  if (
    routes.length !== targets.length ||
    routes.length === 0 ||
    !Number.isFinite(sizeMeters) ||
    sizeMeters <= 0
  ) {
    return invalid;
  }

  let outlineSum = 0;
  let outlineCount = 0;
  let outlineMax = 0;
  let outlineSquare = 0;
  let routeSum = 0;
  let routeCount = 0;
  let routeMax = 0;
  let routeSquare = 0;
  let frechetSum = 0;
  let frechetCount = 0;
  let frechetMax = 0;
  let worstLegIndex = -1;
  let worstLegOutline = 0;
  /** 两侧相对偏差样本，仅在调用方明确要求时收集 */
  const outlineRatios = collectOutlineRatios ? [] : null;
  const routeRatios = collectOutlineRatios ? [] : null;

  for (let leg = 0; leg < targets.length; leg += 1) {
    const target = targets[leg] || [];
    const route = routes[leg] || [];
    if (target.length < 2 || route.length < 2) {
      return invalid;
    }
    // 目标段 → 本段路线：理想有没有被走出来
    let legOutlineMax = 0;
    for (const [lat, lng] of target) {
      const d = pointToPolylineMeters(lat, lng, route);
      const ratio = d / sizeMeters;
      outlineSum += d;
      outlineCount += 1;
      outlineSquare += ratio * ratio;
      if (outlineRatios) outlineRatios.push(ratio);
      if (d > legOutlineMax) {
        legOutlineMax = d;
      }
    }
    // 本段路线 → 目标段：路线有没有乱跑（只对目标段，靠近别的段不算数）
    for (const [lat, lng] of route) {
      const d = pointToPolylineMeters(lat, lng, target);
      const ratio = d / sizeMeters;
      routeSum += d;
      routeCount += 1;
      routeSquare += ratio * ratio;
      if (routeRatios) routeRatios.push(ratio);
      if (d > routeMax) {
        routeMax = d;
      }
    }
    if (legOutlineMax > worstLegOutline) {
      worstLegOutline = legOutlineMax;
      worstLegIndex = leg;
    }
    if (legOutlineMax > outlineMax) {
      outlineMax = legOutlineMax;
    }
    // 保序曲线相似度：同一段内路线是否顺序错乱/来回折返。
    // 目标段与路线都先按 ~1% 尺寸稠密重采样再算离散 Fréchet：稀疏顶点
    // （长直边目标只有 2 点）会把"中段正常行走"误判成折返（1500m 直边段
    // 中段距两端 ≈750m=20.7%），这是采样伪影而非路线问题。重采样对所有
    // 图形/所有段一致生效，逼近连续 Fréchet；15% 质量门槛保持不变。
    const legFrechet = discreteFrechetMeters(
      densifyPolyline(target, sizeMeters),
      densifyPolyline(route, sizeMeters),
    );
    frechetSum += Number.isFinite(legFrechet) ? legFrechet : 0;
    frechetCount += 1;
    if (legFrechet > frechetMax) {
      frechetMax = legFrechet;
    }
  }

  const outlineMean = outlineSum / outlineCount;
  const routeMean = routeSum / routeCount;
  const frechetMean = frechetCount > 0 ? frechetSum / frechetCount : Number.POSITIVE_INFINITY;
  return {
    orderedOutlineMeanMeters: outlineMean,
    orderedOutlineMaxMeters: outlineMax,
    orderedRouteMeanMeters: routeMean,
    orderedRouteMaxMeters: routeMax,
    orderedOutlineMeanRatio: outlineMean / sizeMeters,
    orderedOutlineMaxRatio: outlineMax / sizeMeters,
    orderedRouteMeanRatio: routeMean / sizeMeters,
    orderedRouteMaxRatio: routeMax / sizeMeters,
    // 均方根 = √(相对偏差平方的平均) = √(均值² + 总体方差)。两侧分开，供选优取更差一侧。
    orderedOutlineRms: Math.sqrt(outlineSquare / outlineCount),
    orderedRouteRms: Math.sqrt(routeSquare / routeCount),
    frechetMaxMeters: frechetMax,
    frechetMeanMeters: frechetMean,
    ...(outlineRatios ? { orderedOutlineRatios: outlineRatios, orderedRouteRatios: routeRatios } : {}),
    frechetMaxRatio: frechetMax / sizeMeters,
    worstLegIndex,
    worstLegOutlineMeters: worstLegOutline,
  };
}
