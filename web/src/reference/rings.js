/**
 * 子轮廓分类：外环 / 孔洞 / 独立部分 / 杂散路径。
 *
 * SVG 里"一个 <path>"不等于"一个轮廓"：potrace 生成的素材常见一个 path 含多个
 * 子路径，也可能有独立部分、内部孔洞和微小杂散。当前引擎只消费"一个闭合外轮廓"，
 * 所以必须在转换前识别并明确拒绝/忽略，而不是拿第一个环硬用。
 *
 * 判定方法（与路径方向无关）：用点包含测试统计每个环被多少更大的环包含；
 * 深度 0 = 外环，深度 1 = 孔洞，深度 ≥2 = 孔中岛（当前架构不支持）。
 */

import { bboxOf } from "../engine/geo.js";
import { pointInPolygon, polygonArea } from "../engine/polygon.js";

/** 判断环 a 是否被环 b 包含（a 的多数采样点位于 b 内部） */
function isContained(a, b) {
  if (a.area >= b.area) return false;
  const boxA = a.bbox;
  const boxB = b.bbox;
  if (
    boxA.minX < boxB.minX - 1e-6 ||
    boxA.minY < boxB.minY - 1e-6 ||
    boxA.maxX > boxB.maxX + 1e-6 ||
    boxA.maxY > boxB.maxY + 1e-6
  ) {
    return false;
  }
  const step = Math.max(1, Math.floor(a.points.length / 63));
  let inside = 0;
  let total = 0;
  for (let i = 0; i < a.points.length; i += step) {
    total += 1;
    if (pointInPolygon(a.points[i], b.points)) inside += 1;
  }
  return total > 0 && inside / total >= 0.9;
}

/**
 * 对子路径做外环/孔洞/独立部分/杂散分类。
 *
 * @param {Array<{points: Array<[number, number]>, closed: boolean}>} subpaths SVG 子路径
 * @param {{strayAreaRatio?: number}} [options] 杂散面积阈值（占主环面积比例）
 * @returns {{
 *   rings: Array<object>,
 *   main: object|null,
 *   holes: Array<object>,
 *   parts: Array<object>,
 *   strays: Array<object>,
 *   warnings: string[]
 * }}
 */
export function classifyRings(subpaths, { strayAreaRatio = 0.01 } = {}) {
  const warnings = [];
  const rings = [];
  for (let index = 0; index < subpaths.length; index += 1) {
    const subpath = subpaths[index];
    const points = subpath.points;
    if (!Array.isArray(points) || points.length < 3) {
      warnings.push(`忽略点数不足的子路径 #${index}（${points ? points.length : 0} 点）`);
      continue;
    }
    const area = polygonArea(points);
    if (!(area > 1e-9)) {
      warnings.push(`忽略零面积子路径 #${index}`);
      continue;
    }
    rings.push({
      index,
      points,
      closed: Boolean(subpath.closed),
      area,
      bbox: bboxOf(points),
      depth: 0,
      parents: [],
    });
  }

  // 面积降序后两两判定包含（只可能被更大的环包含）
  rings.sort((a, b) => b.area - a.area);
  for (let i = 0; i < rings.length; i += 1) {
    for (let j = 0; j < i; j += 1) {
      if (isContained(rings[i], rings[j])) {
        rings[i].depth += 1;
        rings[i].parents.push(rings[j].index);
      }
    }
  }

  const outer = rings.filter((ring) => ring.depth === 0);
  const main = outer.length > 0 ? outer[0] : null;
  if (!main) {
    warnings.push("没有找到深度为 0 的外轮廓");
    return { rings, main: null, holes: [], parts: [], strays: [], warnings };
  }
  main.role = "main";
  const strayLimit = main.area * strayAreaRatio;
  const parts = [];
  const strays = [];
  for (const ring of rings) {
    if (ring === main) continue;
    const inMainLineage = ring.parents.length === 0 || ring.parents.includes(main.index) || ring.parents.some((parent) => {
      const parentRing = rings.find((candidate) => candidate.index === parent);
      return parentRing ? parentRing.parents.includes(main.index) : false;
    });
    if (ring.depth === 0) {
      if (ring.area >= strayLimit) {
        ring.role = "part";
        parts.push(ring);
      } else {
        ring.role = "stray";
        strays.push(ring);
        warnings.push(`忽略杂散路径 #${ring.index}（面积占主环 ${((ring.area / main.area) * 100).toFixed(2)}%）`);
      }
    } else if (ring.depth % 2 === 1) {
      ring.role = "hole";
    } else if (ring.area >= strayLimit) {
      ring.role = "part";
      parts.push(ring);
      warnings.push(`检测到孔中岛 #${ring.index}（当前不支持嵌套部分）`);
    } else {
      ring.role = "stray";
      strays.push(ring);
    }
    if (!inMainLineage && ring.role === "hole") {
      // 与主环无包含关系却被判为孔洞：保守起见按独立部分处理
      ring.role = "part";
      parts.push(ring);
    }
    if (ring.role === "hole" && !ring.closed) {
      warnings.push(`孔洞 #${ring.index} 未闭合，按闭合处理`);
    }
  }
  const holes = rings.filter((ring) => ring.role === "hole");
  return { rings, main, holes, parts, strays, warnings };
}
