/**
 * 轻量 SVG 文档解析（不依赖 DOM，Node 可直接运行）。
 *
 * 目标：从素材 SVG 中取出"可见填充几何"——path / polygon / rect / circle / ellipse，
 * 应用 g、元素上的 transform，输出源坐标子路径；不处理样式继承、渐变、文本、图片、
 * clipPath/mask/use 等复杂特性（遇到时记录 warning，交给上层决定拒绝或忽略）。
 *
 * 这是参考图模块的第一道入口：只对"简单剪影素材"负责，不承诺任意 SVG。
 */

import { applyMatrix, multiply, parseTransform, IDENTITY } from "./svg-transform.js";
import { parsePathData, parsePointsAttribute } from "./path-data.js";

const SKIP_CONTAINERS = new Set([
  "defs",
  "clippath",
  "mask",
  "pattern",
  "symbol",
  "style",
  "script",
  "title",
  "desc",
  "metadata",
  "marker",
  "filter",
  "lineargradient",
  "radialgradient",
  "foreignobject",
]);

const UNSUPPORTED_GEOMETRY = new Set(["use", "image", "text", "tspan", "textpath"]);

/** 读取标签属性（双引号/单引号都支持） */
function parseAttributes(text) {
  const attrs = {};
  const re = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = re.exec(text || ""))) {
    attrs[match[1].toLowerCase()] = match[2] !== undefined ? match[2] : match[3];
  }
  return attrs;
}

/** 数值属性 */
function num(attrs, key, fallback = 0) {
  const value = Number(attrs[key]);
  return Number.isFinite(value) ? value : fallback;
}

/** 圆/椭圆近似为多边形（64 段） */
function ellipsePoints(cx, cy, rx, ry, segments = 64) {
  const points = [];
  for (let i = 0; i < segments; i += 1) {
    const angle = (Math.PI * 2 * i) / segments;
    points.push([cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)]);
  }
  return points;
}

/** 把元素上的几何转成源坐标子路径（并应用矩阵） */
function elementToSubpaths(element) {
  const { type, attrs, matrix } = element;
  let rawSubpaths = [];
  const warnings = [];
  if (type === "path") {
    const parsed = parsePathData(attrs.d || "");
    rawSubpaths = parsed.subpaths;
    warnings.push(...parsed.warnings);
  } else if (type === "polygon") {
    const points = parsePointsAttribute(attrs.points || "");
    if (points.length >= 3) rawSubpaths = [{ points, closed: true }];
  } else if (type === "rect") {
    const x = num(attrs, "x");
    const y = num(attrs, "y");
    const width = num(attrs, "width");
    const height = num(attrs, "height");
    if (width > 0 && height > 0) {
      if (num(attrs, "rx") > 0 || num(attrs, "ry") > 0) {
        warnings.push("rect 的圆角未单独建模，按直角矩形处理");
      }
      rawSubpaths = [
        {
          points: [
            [x, y],
            [x + width, y],
            [x + width, y + height],
            [x, y + height],
          ],
          closed: true,
        },
      ];
    }
  } else if (type === "circle") {
    const r = num(attrs, "r");
    if (r > 0) rawSubpaths = [{ points: ellipsePoints(num(attrs, "cx"), num(attrs, "cy"), r, r), closed: true }];
  } else if (type === "ellipse") {
    const rx = num(attrs, "rx");
    const ry = num(attrs, "ry");
    if (rx > 0 && ry > 0) rawSubpaths = [{ points: ellipsePoints(num(attrs, "cx"), num(attrs, "cy"), rx, ry), closed: true }];
  }
  const mapped = rawSubpaths
    .map((subpath) => ({
      points: subpath.points.map((point) => applyMatrix(matrix, point)),
      closed: subpath.closed,
    }))
    .filter((subpath) => subpath.points.length >= 2);
  return { subpaths: mapped, warnings };
}

/**
 * 解析 SVG 文本，返回子路径与文档信息。
 *
 * @param {string} svgText SVG 源码
 * @returns {{
 *   viewBox: {minX: number, minY: number, width: number, height: number},
 *   width: number|null,
 *   height: number|null,
 *   subpaths: Array<{points: Array<[number, number]>, closed: boolean}>,
 *   warnings: string[],
 *   stats: object
 * }}
 */
export function parseSvgDocument(svgText) {
  const warnings = [];
  const cleaned = String(svgText || "")
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!DOCTYPE[\s\S]*?>/gi, "");
  const tagRe = /<\/?([a-zA-Z][\w:-]*)\b([^>]*?)(\/?)>/g;
  const gStack = [IDENTITY.slice()];
  const skipStack = [];
  const elements = [];
  let viewBox = null;
  let width = null;
  let height = null;
  const stats = { tags: 0, paths: 0, polygons: 0, shapes: 0, groups: 0, skipped: 0, unsupported: 0 };

  let match;
  while ((match = tagRe.exec(cleaned))) {
    stats.tags += 1;
    const raw = match[0];
    const closing = raw.startsWith("</");
    const name = match[1].toLowerCase().split(":").pop();
    const attrsText = match[2] || "";
    const selfClosing = raw.endsWith("/>") || /\/\s*$/.test(attrsText);

    // 处于跳过容器内部：只维护容器栈
    if (skipStack.length > 0) {
      if (closing) {
        if (skipStack[skipStack.length - 1] === name) skipStack.pop();
      } else if (SKIP_CONTAINERS.has(name) && !selfClosing) {
        skipStack.push(name);
      }
      continue;
    }

    if (!closing && SKIP_CONTAINERS.has(name)) {
      stats.skipped += 1;
      if (!selfClosing) skipStack.push(name);
      continue;
    }

    if (name === "svg") {
      if (closing) continue;
      const attrs = parseAttributes(attrsText);
      if (attrs.viewbox) {
        const nums = (attrs.viewbox.match(/-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || []).map(Number);
        if (nums.length === 4) {
          viewBox = { minX: nums[0], minY: nums[1], width: nums[2], height: nums[3] };
        }
      }
      if (attrs.width) width = Number.parseFloat(attrs.width) || null;
      if (attrs.height) height = Number.parseFloat(attrs.height) || null;
      continue;
    }

    if (name === "g") {
      if (closing) {
        if (gStack.length > 1) gStack.pop();
      } else if (!selfClosing) {
        stats.groups += 1;
        const attrs = parseAttributes(attrsText);
        const local = attrs.transform ? parseTransform(attrs.transform) : IDENTITY;
        gStack.push(multiply(gStack[gStack.length - 1], local));
      }
      continue;
    }

    if (closing) continue;

    if (UNSUPPORTED_GEOMETRY.has(name)) {
      stats.unsupported += 1;
      warnings.push(`忽略不支持的 <${name}>`);
      continue;
    }

    if (!["path", "polygon", "rect", "circle", "ellipse"].includes(name)) {
      continue;
    }
    const attrs = parseAttributes(attrsText);
    const localTransform = attrs.transform ? parseTransform(attrs.transform) : IDENTITY;
    const matrix = multiply(gStack[gStack.length - 1], localTransform);
    if (name === "path") stats.paths += 1;
    else if (name === "polygon") stats.polygons += 1;
    else stats.shapes += 1;
    if (attrs.fill && attrs.fill.toLowerCase() === "none" && attrs.stroke) {
      warnings.push("遇到仅描边路径（fill=none），外轮廓可能不是实心剪影");
    }
    elements.push({ type: name, attrs, matrix });
  }

  if (skipStack.length > 0) warnings.push("SVG 跳过容器未闭合，解析可能不完整");
  if (gStack.length > 1) warnings.push("SVG <g> 未闭合，变换栈可能不完整");

  const subpaths = [];
  for (const element of elements) {
    const converted = elementToSubpaths(element);
    subpaths.push(...converted.subpaths);
    warnings.push(...converted.warnings);
  }
  if (subpaths.length === 0) warnings.push("未从 SVG 中提取到任何填充几何");
  if (!viewBox) {
    const w = width || 1000;
    const h = height || 1000;
    viewBox = { minX: 0, minY: 0, width: w, height: h };
    warnings.push("SVG 缺少 viewBox，使用 width/height 兜底");
  }
  return { viewBox, width, height, subpaths, warnings, stats };
}
