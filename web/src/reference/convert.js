/**
 * 参考轮廓转换：SVG 素材 → R（高保真参考轮廓）→ T（可画目标轮廓）。
 *
 * R 层回答"它是不是用户想要的东西"：保留源素材外环的高密度采样点，
 *   不做任何为迁就路网的篡改；
 * T 层回答"转换后能不能交给现有引擎"：只取一个闭合外环，归一化到
 *   [-0.5, 0.5]（y 向上、最长边为 1），并做拓扑/退化校验。
 *
 * 当前范围（第一阶段）：只支持"单个闭合外轮廓"的简单剪影。
 * 多部分、过大孔洞、未闭合轮廓、自交等会被明确拒绝，不静默硬用。
 */

import { parseSvgDocument } from "./svg-document.js";
import { classifyRings } from "./rings.js";
import {
  applyNormalization,
  dedupeClosedRing,
  distanceStats,
  normalizeClosedRing,
  normalizationParams,
  resampleClosed,
  simplifyClosedRdp,
} from "./geometry.js";
import { polygonArea, validateSimplePolygon } from "../engine/polygon.js";
import { bboxOf } from "../engine/geo.js";

/** 默认配置（集中在这里，便于后续调参） */
export const CONVERSION_DEFAULTS = Object.freeze({
  refinePoints: 4000,
  targetPoints: 320,
  holeAreaRatio: 0.05,
  strayAreaRatio: 0.01,
  maxStrayCount: 8,
  minSpanRatio: 0.01,
});

/**
 * 把一组源坐标子路径转换为归一化 R 环（使用主环的归一化参数）。
 *
 * @param {Array<object>} rings 分类后的环
 * @param {object} params 归一化参数
 * @param {number} pointCount 每个环的重采样点数
 * @param {Set<string>} skipRoles 跳过的角色
 * @returns {Array<{role: string, index: number, points: Array<[number, number]>}>}
 */
function buildNormalizedRings(rings, params, pointCount, skipRoles) {
  const out = [];
  for (const ring of rings) {
    if (skipRoles.has(ring.role)) continue;
    const dense = resampleClosed(ring.points, pointCount) || [];
    if (dense.length < 3) continue;
    const normalized = dedupeClosedRing(applyNormalization(dense, params, { decimals: null }));
    if (normalized.length < 3) continue;
    out.push({
      role: ring.role,
      index: ring.index,
      points: normalized.map(([x, y]) => [Number(x.toFixed(6)), Number(y.toFixed(6))]),
    });
  }
  return out;
}

/**
 * 转换一段 SVG 文本。
 *
 * @param {string} svgText SVG 源码
 * @param {object} [options] 覆盖 CONVERSION_DEFAULTS
 * @returns {{
 *   status: 'accepted'|'rejected',
 *   reasons: Array<{code: string, message: string}>,
 *   warnings: string[],
 *   diagnostics: object,
 *   R: object|null,
 *   T: object|null,
 *   metrics: object|null
 * }}
 */
export function convertSvg(svgText, options = {}) {
  const config = { ...CONVERSION_DEFAULTS, ...options };
  const reasons = [];
  const warnings = [];
  const doc = parseSvgDocument(svgText);
  warnings.push(...doc.warnings);
  const classification = classifyRings(doc.subpaths, { strayAreaRatio: config.strayAreaRatio });
  warnings.push(...classification.warnings);
  const { rings, main, holes, parts, strays } = classification;

  const diagnostics = {
    viewBox: doc.viewBox,
    documentStats: doc.stats,
    subpathCount: doc.subpaths.length,
    ringCount: rings.length,
    outerRingCount: rings.filter((ring) => ring.depth === 0).length,
    holeCount: holes.length,
    partCount: parts.length,
    strayCount: strays.length,
    mainArea: main ? main.area : 0,
    mainClosed: main ? main.closed : false,
    holeAreaRatio: main ? holes.reduce((sum, ring) => sum + ring.area, 0) / main.area : 0,
  };

  if (!main) {
    reasons.push({ code: "no-outer-contour", message: "没有提取到可用的外轮廓" });
    return { status: "rejected", reasons, warnings, diagnostics, R: null, T: null, metrics: null };
  }
  if (!main.closed) {
    reasons.push({ code: "unclosed-contour", message: "主外轮廓未闭合（缺少 Z，首尾也不重合）" });
  }
  if (parts.length > 0) {
    reasons.push({
      code: "multi-part",
      message: `存在 ${parts.length} 个独立部分，当前只支持单个外轮廓`,
    });
  }
  if (strays.length > config.maxStrayCount) {
    reasons.push({
      code: "fragmented-paths",
      message: `存在 ${strays.length} 条杂散路径（碎片化素材），超过 ${config.maxStrayCount} 条上限，当前不支持`,
    });
  } else if (strays.length > 0) {
    warnings.push(`${strays.length} 条小杂散路径已被忽略`);
  }
  if (diagnostics.holeAreaRatio > config.holeAreaRatio) {
    reasons.push({
      code: "holes-too-large",
      message: `孔洞总面积占主环 ${(diagnostics.holeAreaRatio * 100).toFixed(1)}%，超过 ${(config.holeAreaRatio * 100).toFixed(0)}% 上限`,
    });
  } else if (holes.length > 0) {
    warnings.push(`检测到 ${holes.length} 个孔洞，T 层按外环填充（孔洞被忽略）`);
  }

  const params = normalizationParams(main.points);
  const targetSource = resampleClosed(main.points, config.targetPoints);
  const target = targetSource.length >= 3 ? normalizeClosedRing(targetSource) : null;
  const refineSource = resampleClosed(main.points, config.refinePoints);
  const R = {
    params,
    rounds: buildNormalizedRings(rings, params, config.refinePoints, new Set(["stray"])),
    main: applyNormalization(refineSource, params, { decimals: null }).map(([x, y]) => [
      Number(x.toFixed(6)),
      Number(y.toFixed(6)),
    ]),
    sourcePointCount: main.points.length,
  };

  let metrics = null;
  let T = null;
  if (target) {
    let points = target.points;
    let topology = validateSimplePolygon(points);
    let simplification = null;
    // 均匀重采样可能把极窄发丝/胡须采成"相邻两点几乎重合"，触发现有拓扑校验的
    // 非相邻重复点判定。先做小容差 RDP 简化，既去掉不可画的毛刺，也让 T 与现有
    // normalizeCustomShape 的校验口径一致；干净轮廓不会被改动。
    if (!topology.ok) {
      for (const epsilon of [0.002, 0.004, 0.008, 0.012, 0.02]) {
        const simplified = simplifyClosedRdp(points, epsilon);
        if (simplified.length < 3) continue;
        const check = validateSimplePolygon(simplified);
        if (check.ok) {
          simplification = { epsilon, removedPoints: points.length - simplified.length };
          points = simplified;
          topology = check;
          break;
        }
        topology = check;
      }
    }
    if (!topology.ok) {
      reasons.push({ code: "topology", message: `目标轮廓拓扑非法：${topology.reason}` });
    }
    const rounded = dedupeClosedRing(points.map(([x, y]) => [Number(x.toFixed(6)), Number(y.toFixed(6))]));
    const roundedTopology = validateSimplePolygon(rounded);
    if (topology.ok && !roundedTopology.ok) {
      reasons.push({ code: "topology", message: `取整后目标轮廓拓扑非法：${roundedTopology.reason}` });
    }
    const box = bboxOf(points);
    const spanX = box.width;
    const spanY = box.height;
    if (spanX < config.minSpanRatio || spanY < config.minSpanRatio) {
      reasons.push({ code: "degenerate", message: `目标轮廓跨度过小（${spanX.toFixed(4)} × ${spanY.toFixed(4)}）` });
    }
    const aspect = Math.max(spanX, spanY) > 0 ? Math.min(spanX, spanY) / Math.max(spanX, spanY) : 0;
    T = {
      points: rounded,
      pointCount: rounded.length,
      aspect: Number(aspect.toFixed(4)),
      area: Number(polygonArea(points).toFixed(6)),
      bounds: { minX: box.minX, minY: box.minY, maxX: box.maxX, maxY: box.maxY },
      simplification,
    };
    const refineNormalized = applyNormalization(refineSource, params, { decimals: null });
    const forward = distanceStats(refineNormalized, points);
    const backward = distanceStats(points, refineNormalized);
    metrics = {
      sourceToTargetMeanPct: Number((forward.mean * 100).toFixed(4)),
      sourceToTargetMaxPct: Number((forward.max * 100).toFixed(4)),
      sourceToTargetP95Pct: Number((forward.p95 * 100).toFixed(4)),
      targetToSourceMeanPct: Number((backward.mean * 100).toFixed(4)),
      targetToSourceMaxPct: Number((backward.max * 100).toFixed(4)),
      refinePointCount: refineNormalized.length,
      targetPointCount: rounded.length,
      simplificationEpsilon: simplification ? simplification.epsilon : 0,
      aspect: Number(aspect.toFixed(4)),
      area: Number(polygonArea(points).toFixed(6)),
    };
  } else {
    reasons.push({ code: "resample-failed", message: "主外轮廓重采样失败" });
  }

  const status = reasons.length === 0 ? "accepted" : "rejected";
  return { status, reasons, warnings, diagnostics, R, T: status === "accepted" ? T : null, metrics };
}
