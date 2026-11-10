/**
 * 规划结果指标（清理方案 2026-11-09 C3：从 planner.js 纯移动拆出，行为零变化）。
 *
 * 职责：把投影后的轮廓/路线/分段评价汇总成 metrics 所需的形态指标
 * （周长、特征覆盖、比例失真、间隙保留率、Fréchet/有序贴合），以及投影与
 * 容差等被多处复用的纯函数。planShapeRoute 只负责编排与结果组装；
 * 指标唯一汇总口仍是 metrics.js 的 assembleMetrics（正常与吸附短路分支共用）。
 */

import { distanceMeters } from './graph.js';
import { orderedFidelity, shapeFidelity, pointToPolylineMeters } from './fidelity.js';
import { METERS_PER_DEG_LAT } from './geo.js';

/** 特征覆盖容差：min(4% × 尺寸, 80m)（大尺寸不按比例放宽，见 planner-retrace 用例） */
const FEATURE_COVERED_RATIO = 0.04;
const FEATURE_COVERED_MAX_METERS = 80;

/**
 * 特征覆盖容差（米）：min(4% × 尺寸, 80m)。
 * 大尺寸不能靠比例把容差放宽到 144m，否则"擦到脚尖"也算特征走出，
 * 凹口/尖耳这种局部细节的检查就失效了。
 *
 * @param {number} sizeMeters 图形外接尺寸（米）
 * @returns {number} 容差（米）
 */
export function featureCoverToleranceMeters(sizeMeters) {
  if (!(sizeMeters > 0)) {
    return FEATURE_COVERED_MAX_METERS;
  }
  return Math.min(sizeMeters * FEATURE_COVERED_RATIO, FEATURE_COVERED_MAX_METERS);
}

/**
 * 把图形局部坐标投影到经纬度（rotate → scale → translate）。
 *
 * @param {Array<[number, number]>} localPoints 局部坐标点列
 * @param {{lat: number, lng: number}} center 图形中心
 * @param {number} sizeMeters 图形外接尺寸（米）
 * @param {number} rotationDeg 旋转角度（度）
 * @returns {Array<[number, number]>} 经纬度点列
 */
export function projectShape(localPoints, center, sizeMeters, rotationDeg) {
  const rotation = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const latRad = (center.lat * Math.PI) / 180;
  const metersPerDegLon = METERS_PER_DEG_LAT * Math.cos(latRad);
  const dLatPerM = 1 / METERS_PER_DEG_LAT;
  const dLonPerM = 1 / metersPerDegLon;
  return localPoints.map(([x, y]) => {
    const px = x * sizeMeters;
    const py = y * sizeMeters;
    const rotatedX = px * cos - py * sin;
    const rotatedY = px * sin + py * cos;
    return [center.lat + rotatedY * dLatPerM, center.lng + rotatedX * dLonPerM];
  });
}

/**
 * 计算多边形周长（米）。
 *
 * @param {Array<[number, number]>} latlngs 顶点
 * @returns {number} 周长（米）
 */
export function polygonPerimeter(latlngs) {
  let total = 0;
  for (let i = 0; i < latlngs.length; i += 1) {
    const [lat1, lng1] = latlngs[i];
    const [lat2, lng2] = latlngs[(i + 1) % latlngs.length];
    total += distanceMeters(lat1, lng1, lat2, lng2);
  }
  return total;
}

/**
 * 折线包围盒（米）：宽/高按等距投影换算，用于整体比例失真检查。
 *
 * @param {Array<[number, number]>} latlngs 折线
 * @returns {{width: number, height: number}} 宽高（米）
 */
function bboxMeters(latlngs) {
  if (!latlngs || latlngs.length < 2) {
    return { width: 0, height: 0 };
  }
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const [lat, lng] of latlngs) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  const midLat = (minLat + maxLat) / 2;
  const metersPerDegLng = METERS_PER_DEG_LAT * Math.cos((midLat * Math.PI) / 180);
  return {
    width: (maxLng - minLng) * metersPerDegLng,
    height: (maxLat - minLat) * METERS_PER_DEG_LAT,
  };
}

/**
 * 多部分图形的全局对照指标：逐部分计算"轮廓 → 路线"偏差后汇总。
 *
 * 不能把扁平的 outlineLatLngs 直接传给 shapeFidelity——它会把所有部分首尾
 * 连成一条折线闭合，产生部分之间并不存在的轮廓边（群岛图形会凭空多出
 * 跨海长边，指标失真）。"路线 → 轮廓"方向包含部分之间的连接段，对任何
 * 单一轮廓都不成立，该方向以有序分段指标为准，这里返回 Infinity 避免
 * 给出误导性数值。
 *
 * @param {object} model 图形模型（含 partRanges）
 * @param {Array<[number, number]>} outlineLatLngs 扁平轮廓
 * @param {Array<[number, number]>} routeLatLngs 实际路线
 * @param {number} sizeMeters 图形外接尺寸
 * @returns {object} 与 shapeFidelity 同结构的指标
 */
function multiPartFidelity(model, outlineLatLngs, routeLatLngs, sizeMeters) {
  const list = model.partRanges.map((range) =>
    shapeFidelity({
      outlineLatLngs: outlineLatLngs.slice(range.outlineStart, range.outlineStart + range.outlineCount),
      routeLatLngs,
      sizeMeters,
    }),
  );
  const outlineMeanMeters =
    list.reduce((sum, item) => sum + (Number.isFinite(item.outlineMeanMeters) ? item.outlineMeanMeters : 0), 0) /
    list.length;
  const outlineMaxMeters = Math.max(
    ...list.map((item) => (Number.isFinite(item.outlineMaxMeters) ? item.outlineMaxMeters : 0)),
  );
  return {
    outlineMeanMeters,
    outlineMaxMeters,
    routeMeanMeters: Number.POSITIVE_INFINITY,
    routeMaxMeters: Number.POSITIVE_INFINITY,
    outlineMeanRatio: sizeMeters > 0 ? outlineMeanMeters / sizeMeters : Number.POSITIVE_INFINITY,
    outlineMaxRatio: sizeMeters > 0 ? outlineMaxMeters / sizeMeters : Number.POSITIVE_INFINITY,
    routeMeanRatio: Number.POSITIVE_INFINITY,
    routeMaxRatio: Number.POSITIVE_INFINITY,
  };
}

/**
 * 汇总一次规划的形态指标（正常分支与吸附短路分支之外的完整口径）。
 *
 * 纯计算、无副作用；所有输入来自 planShapeRoute 已完成投影与寻路的结果。
 *
 * @param {object} options
 * @param {object} options.model 图形模型（含 partRanges/features 无关）
 * @param {object|null} options.customShape 自定义图形（取 features）
 * @param {Array<[number, number]>} options.outlineLatLngs 投影后轮廓
 * @param {Array<[number, number]>} options.constraintLatLngs 投影后约束点
 * @param {Array<[number, number]>} options.routeLatLngs 拼接后的路线
 * @param {Array} options.shapeLegTargets 形状腿目标折线（有序贴合）
 * @param {Array} options.shapeLegRoutes 形状腿路线（有序贴合）
 * @param {number} options.sizeMeters 图形外接尺寸（米）
 * @param {{lat: number, lng: number}} options.center 图形中心
 * @param {number} options.rotationDeg 旋转角度（度）
 * @param {boolean} options.multiPart 是否多部分图形
 * @param {boolean} options.collectOutlineRatios 是否收集轮廓行比值
 * @returns {object} 指标字段（供 assembleMetrics 汇总）
 */
export function computeShapeMetrics({
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
}) {
  // 多部分图形的形状周长 = 各部分闭合周长之和；连接腿计入路长但不计入周长
  const shapePerimeterMeters = multiPart
    ? model.partRanges.reduce(
        (sum, range) =>
          sum +
          polygonPerimeter(
            constraintLatLngs.slice(range.constraintStart, range.constraintStart + range.constraintCount),
          ),
        0,
      )
    : polygonPerimeter(constraintLatLngs);

  // 细节特征单独检查：凹口底部点（腿间隙顶、嘴缺口等）与 LLM 声明的鲜明特征
  // （长脸/尖耳/翘尾等）必须被路线走到。只看整体平均/最大偏差不够——整体贴合
  // 达标时，局部特征仍可能被 A* 抄近路跨过。
  const featureList = customShape?.features || [];
  const checkableFeatures = featureList.filter(
    (feature) => feature.kind === 'notch' || feature.kind === 'declared',
  );
  const projectedFeaturePoints = projectShape(
    checkableFeatures.map((feature) =>
      feature.kind === 'notch' ? feature.points[1] || feature.points[0] : feature.points[0],
    ),
    center,
    sizeMeters,
    rotationDeg,
  );
  let featureMaxOffsetMeters = 0;
  let featureCoveredCount = 0;
  // 覆盖容差 = min(4% × 尺寸, 80m)：大尺寸不能靠比例把容差放宽到 144m，
  // 否则"擦到脚尖"也算特征走出，凹口/尖耳这种局部细节的检查就失效了
  const featureCoveredTolerance = featureCoverToleranceMeters(sizeMeters);
  for (const [lat, lng] of projectedFeaturePoints) {
    const d = pointToPolylineMeters(lat, lng, routeLatLngs);
    if (d > featureMaxOffsetMeters) {
      featureMaxOffsetMeters = d;
    }
    if (d <= featureCoveredTolerance) {
      featureCoveredCount += 1;
    }
  }
  const featureCount = checkableFeatures.length;
  // 尺寸反推最小宽度只统计深凹口与窄间隙（identity 浅凹不参与起搜尺寸反推）
  const featureMinWidthRatioRaw = featureList.reduce(
    (min, feature) =>
      (feature.kind === 'notch' || feature.kind === 'gap') &&
      feature.widthRatio > 0 &&
      feature.widthRatio < min
        ? feature.widthRatio
        : min,
    Number.POSITIVE_INFINITY,
  );
  const featureMinWidthRatio = Number.isFinite(featureMinWidthRatioRaw) ? featureMinWidthRatioRaw : 0;

  // 整体比例失真：路线包围盒宽高比 vs 理想轮廓宽高比（头身比/朝向被拉扁拉长的度量）
  const outlineBBox = bboxMeters(outlineLatLngs);
  const routeBBox = bboxMeters(routeLatLngs);
  const outlineAspect = outlineBBox.height > 0 ? outlineBBox.width / outlineBBox.height : 0;
  const routeAspect = routeBBox.height > 0 ? routeBBox.width / routeBBox.height : 0;
  const aspectDistortionRatio =
    outlineAspect > 0 && routeAspect > 0
      ? Math.abs(routeAspect / outlineAspect - 1)
      : Number.POSITIVE_INFINITY;

  // 特征间隙保留率：窄间隙两壁点在路线上的弧长 ÷ 声明宽度。
  // 路线跨过间隙（抄近路）时弧长≈宽度（保留率≈1）；绕行保留间隙时弧长明显更大。
  let featureGapRetainRatio = Number.POSITIVE_INFINITY;
  for (const feature of featureList.filter((item) => item.kind === 'gap')) {
    if (feature.points.length < 2 || !(feature.widthRatio > 0)) {
      continue;
    }
    const [p1, p2] = projectShape(feature.points.slice(0, 2), center, sizeMeters, rotationDeg);
    const nearestRouteIndex = ([lat, lng]) => {
      let best = 0;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (let index = 0; index < routeLatLngs.length; index += 1) {
        const d = distanceMeters(lat, lng, routeLatLngs[index][0], routeLatLngs[index][1]);
        if (d < bestDistance) {
          bestDistance = d;
          best = index;
        }
      }
      return best;
    };
    const i = nearestRouteIndex(p1);
    const j = nearestRouteIndex(p2);
    if (i === j) {
      featureGapRetainRatio = Math.min(featureGapRetainRatio, 0);
      continue;
    }
    const from = Math.min(i, j);
    const to = Math.max(i, j);
    let arc = 0;
    for (let k = from; k < to; k += 1) {
      arc += distanceMeters(
        routeLatLngs[k][0],
        routeLatLngs[k][1],
        routeLatLngs[k + 1][0],
        routeLatLngs[k + 1][1],
      );
    }
    const declaredWidth = feature.widthRatio * sizeMeters;
    if (declaredWidth > 0) {
      featureGapRetainRatio = Math.min(featureGapRetainRatio, arc / declaredWidth);
    }
  }

  const fidelity = multiPart
    ? multiPartFidelity(model, outlineLatLngs, routeLatLngs, sizeMeters)
    : shapeFidelity({ outlineLatLngs, routeLatLngs, sizeMeters });
  const ordered = orderedFidelity({
    legTargets: shapeLegTargets,
    legRoutes: shapeLegRoutes,
    sizeMeters,
    collectOutlineRatios,
  });

  return {
    shapePerimeterMeters,
    featureCount,
    featureCoveredCount,
    featureMaxOffsetMeters,
    featureMinWidthRatio,
    aspectDistortionRatio,
    featureGapRetainRatio,
    fidelity,
    ordered,
  };
}
