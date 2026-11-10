/**
 * 折线/闭环几何工具：包围盒、弧长重采样、归一化、点到折线距离统计。
 *
 * 坐标约定：
 * - 源坐标：SVG 坐标系（y 向下），单位由 viewBox 决定；
 * - 归一化坐标：[-0.5, 0.5]，y 向上，最长边为 1，与现有 customShape 输入一致。
 */

import { bboxOf, pointToSegmentDistanceXY } from "../engine/geo.js";
import { polygonArea, polygonSignedArea } from "../engine/polygon.js";

/**
 * 包围盒（保留旧导出名 `bbox`，实现统一走 engine/geo.js 的 `bboxOf`）。
 *
 * 清理方案 2026-11-09 §3.2 B4：此前 geometry/path-data/rings/convert 各手抄一份
 * min/max 扫描，现由共享层单点维护；返回结构 `{minX,minY,maxX,maxY,width,height}`
 * 与旧实现逐字段一致（空集时 minX/minY=Infinity、maxX/maxY=-Infinity）。
 */
export { bboxOf as bbox } from "../engine/geo.js";

/** 闭环/开放折线长度 */
export function polylineLength(points, closed = true) {
  let total = 0;
  for (let i = 0; i < points.length; i += 1) {
    const next = points[(i + 1) % points.length];
    if (!closed && i === points.length - 1) break;
    total += Math.hypot(points[i][0] - next[0], points[i][1] - next[1]);
  }
  return total;
}

/**
 * 按弧长均匀重采样闭环（起点保持为原第一个点）。
 *
 * @param {Array<[number, number]>} points 闭环点列
 * @param {number} count 目标点数
 * @returns {Array<[number, number]>} 重采样点列（不含重复首点）
 */
export function resampleClosed(points, count) {
  if (!Array.isArray(points) || points.length < 3 || count < 3) return [];
  const segments = [];
  let total = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length > 1e-9) {
      segments.push({ a, b, length, start: total });
      total += length;
    }
  }
  if (total <= 1e-9 || segments.length < 2) return [];
  const out = [];
  let segmentIndex = 0;
  for (let i = 0; i < count; i += 1) {
    const target = (total * i) / count;
    while (segmentIndex < segments.length - 1 && target > segments[segmentIndex].start + segments[segmentIndex].length) {
      segmentIndex += 1;
    }
    const segment = segments[segmentIndex];
    const t = Math.max(0, Math.min(1, (target - segment.start) / segment.length));
    out.push([segment.a[0] + (segment.b[0] - segment.a[0]) * t, segment.a[1] + (segment.b[1] - segment.a[1]) * t]);
  }
  return out;
}

/**
 * 计算把源点列归一化到 [-0.5, 0.5] 的参数（最长边为 1、包围盒居中、y 翻转）。
 *
 * @param {Array<[number, number]>} points 源坐标闭环
 * @returns {{centerX: number, centerY: number, span: number, bbox: object}}
 */
export function normalizationParams(points) {
  const box = bboxOf(points);
  const span = Math.max(box.width, box.height);
  return {
    centerX: (box.minX + box.maxX) / 2,
    centerY: (box.minY + box.maxY) / 2,
    span: span > 1e-9 ? span : 1,
    bbox: box,
  };
}

/**
 * 应用归一化参数（y 向下 → y 向上）。
 *
 * @param {Array<[number, number]>} points 源坐标点列
 * @param {{centerX: number, centerY: number, span: number}} params 归一化参数
 * @param {{decimals?: number|null}} [options] decimals 为 null 时不取整（用于度量）
 * @returns {Array<[number, number]>}
 */
export function applyNormalization(points, params, { decimals = 6 } = {}) {
  const round = decimals === null ? (value) => value : (value) => Number(value.toFixed(decimals));
  return points.map(([x, y]) => [round((x - params.centerX) / params.span), round((params.centerY - y) / params.span)]);
}

/** 去重：相邻点距离 ≤ eps 时丢弃后一个；同时去掉与首点重合的尾点 */
export function dedupeClosedRing(points, eps = 1e-7) {
  const out = [];
  for (const point of points) {
    const prev = out[out.length - 1];
    if (!prev || Math.hypot(point[0] - prev[0], point[1] - prev[1]) > eps) {
      out.push(point);
    }
  }
  while (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= eps) {
    out.pop();
  }
  return out;
}

/**
 * 归一化闭环（不取整，供度量/校验使用；输出另取整）。
 *
 * @param {Array<[number, number]>} points 源坐标闭环
 * @returns {{points: Array<[number, number]>, rounded: Array<[number, number]>, params: object, aspect: number, area: number}}
 */
export function normalizeClosedRing(points) {
  const params = normalizationParams(points);
  const normalized = dedupeClosedRing(applyNormalization(points, params, { decimals: null }));
  const rounded = normalized.map(([x, y]) => [Number(x.toFixed(6)), Number(y.toFixed(6))]);
  const box = bboxOf(normalized);
  return {
    points: normalized,
    rounded: dedupeClosedRing(rounded),
    params,
    aspect: box.width >= box.height ? box.height / (box.width || 1) : box.width / (box.height || 1),
    area: polygonArea(normalized),
    signedArea: polygonSignedArea(normalized),
  };
}

/** 点到线段距离（统一走 geo.js 的平面算法） */
function pointToSegmentDistance(point, a, b) {
  return pointToSegmentDistanceXY(point[0], point[1], a[0], a[1], b[0], b[1]);
}

/** 点到闭环折线的最短距离 */
export function distanceToClosedPolyline(point, polyline) {
  let min = Infinity;
  for (let i = 0; i < polyline.length; i += 1) {
    const distance = pointToSegmentDistance(point, polyline[i], polyline[(i + 1) % polyline.length]);
    if (distance < min) min = distance;
  }
  return min;
}

/**
 * 双向点到折线距离统计（归一化坐标下，最长边为 1）。
 *
 * @param {Array<[number, number]>} from 源点列
 * @param {Array<[number, number]>} to 目标闭环折线
 * @returns {{mean: number, max: number, p95: number}} 距离（归一化单位）
 */
export function distanceStats(from, to) {
  const distances = from.map((point) => distanceToClosedPolyline(point, to)).sort((a, b) => a - b);
  if (distances.length === 0) return { mean: 0, max: 0, p95: 0 };
  const sum = distances.reduce((acc, value) => acc + value, 0);
  const index = Math.min(distances.length - 1, Math.floor(distances.length * 0.95));
  return { mean: sum / distances.length, max: distances[distances.length - 1], p95: distances[index] };
}

/** 判断闭环是否在容差内闭合（首尾点距离） */
export function isClosedWithin(points, tolerance) {
  if (points.length < 3) return false;
  const first = points[0];
  const last = points[points.length - 1];
  return Math.hypot(first[0] - last[0], first[1] - last[1]) <= tolerance;
}

/** 开放折线的 RDP 简化（返回保留点） */
function rdpOpen(points, epsilon) {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop();
    let maxDistance = -1;
    let index = -1;
    for (let i = start + 1; i < end; i += 1) {
      const distance = pointToSegmentDistance(points[i], points[start], points[end]);
      if (distance > maxDistance) {
        maxDistance = distance;
        index = i;
      }
    }
    if (index > 0 && maxDistance > epsilon) {
      keep[index] = 1;
      stack.push([start, index], [index, end]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * 闭环 RDP 简化：用最远点把闭环拆成两段开放折线分别简化。
 *
 * @param {Array<[number, number]>} points 闭环点列（不含重复首点）
 * @param {number} epsilon 简化容差（与坐标同单位）
 * @returns {Array<[number, number]>} 简化后的闭环点列（仍不含重复首点）
 */
export function simplifyClosedRdp(points, epsilon) {
  if (!Array.isArray(points) || points.length < 4 || !(epsilon > 0)) return points.slice();
  let farIndex = 1;
  let farDistance = -1;
  for (let i = 1; i < points.length; i += 1) {
    const distance = Math.hypot(points[i][0] - points[0][0], points[i][1] - points[0][1]);
    if (distance > farDistance) {
      farDistance = distance;
      farIndex = i;
    }
  }
  const firstHalf = rdpOpen(points.slice(0, farIndex + 1), epsilon);
  const secondHalf = rdpOpen([...points.slice(farIndex), points[0]], epsilon);
  const merged = [...firstHalf, ...secondHalf.slice(1, -1)];
  return merged.length >= 3 ? merged : points.slice();
}
