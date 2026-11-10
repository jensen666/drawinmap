/**
 * SVG path 数据解析与曲线采样（纯函数，Node / 浏览器通用）。
 *
 * 只负责几何：把 d 属性解析成若干闭合/开放子路径的点列（源坐标）。
 * 不处理样式、变换、外环/孔洞判定——那些在 svg-document.js / rings.js。
 *
 * 支持 M/L/H/V/C/S/Q/T/A/Z（大小写、隐式重复命令）。
 * 曲线按控制多边形长度自适应采样；采样点不含重复的闭合首点。
 */

import { bboxOf } from "../engine/geo.js";

const TOKEN_RE = /[MmLlHhVvCcSsQqTtAaZz]|-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;

/** 各命令的参数个数（大写键） */
const ARITY = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

/** 两点距离 */
function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** 根据控制多边形长度决定采样段数（限制在 [6, 96]） */
function stepsFor(length) {
  return Math.max(6, Math.min(96, Math.ceil(length / 3)));
}

/** 三次贝塞尔采样（不含起点） */
function sampleCubic(p0, p1, p2, p3) {
  const steps = stepsFor(dist(p0, p1) + dist(p1, p2) + dist(p2, p3));
  const out = [];
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const mt = 1 - t;
    out.push([
      mt ** 3 * p0[0] + 3 * mt ** 2 * t * p1[0] + 3 * mt * t ** 2 * p2[0] + t ** 3 * p3[0],
      mt ** 3 * p0[1] + 3 * mt ** 2 * t * p1[1] + 3 * mt * t ** 2 * p2[1] + t ** 3 * p3[1],
    ]);
  }
  return out;
}

/** 二次贝塞尔采样（不含起点） */
function sampleQuadratic(p0, p1, p2) {
  const steps = stepsFor(dist(p0, p1) + dist(p1, p2));
  const out = [];
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const mt = 1 - t;
    out.push([
      mt ** 2 * p0[0] + 2 * mt * t * p1[0] + t ** 2 * p2[0],
      mt ** 2 * p0[1] + 2 * mt * t * p1[1] + t ** 2 * p2[1],
    ]);
  }
  return out;
}

/**
 * 椭圆弧采样（SVG 规范 endpoint → center 参数化），不含起点。
 *
 * @returns {Array<[number, number]>} 采样点
 */
function sampleArc(p0, rx, ry, phiDeg, large, sweep, p1) {
  const [x1, y1] = p0;
  const [x2, y2] = p1;
  if (rx === 0 || ry === 0) return [[x2, y2]];
  let rxAbs = Math.abs(rx);
  let ryAbs = Math.abs(ry);
  const phi = (phiDeg * Math.PI) / 180;
  const dx2 = (x1 - x2) / 2;
  const dy2 = (y1 - y2) / 2;
  const x1p = Math.cos(phi) * dx2 + Math.sin(phi) * dy2;
  const y1p = -Math.sin(phi) * dx2 + Math.cos(phi) * dy2;
  const lambda = (x1p * x1p) / (rxAbs * rxAbs) + (y1p * y1p) / (ryAbs * ryAbs);
  if (lambda > 1) {
    const scale = Math.sqrt(lambda);
    rxAbs *= scale;
    ryAbs *= scale;
  }
  const numerator = rxAbs * rxAbs * ryAbs * ryAbs - rxAbs * rxAbs * y1p * y1p - ryAbs * ryAbs * x1p * x1p;
  const denominator = rxAbs * rxAbs * y1p * y1p + ryAbs * ryAbs * x1p * x1p;
  const factor = denominator === 0 ? 0 : (-1 * (large === sweep ? 1 : -1) * Math.sqrt(Math.max(0, numerator / denominator)));
  const cxp = (factor * rxAbs * y1p) / ryAbs;
  const cyp = (-factor * ryAbs * x1p) / rxAbs;
  const cx = Math.cos(phi) * cxp - Math.sin(phi) * cyp + (x1 + x2) / 2;
  const cy = Math.sin(phi) * cxp + Math.cos(phi) * cyp + (y1 + y2) / 2;
  const theta1 = Math.atan2((y1p - cyp) / ryAbs, (x1p - cxp) / rxAbs);
  const theta2 = Math.atan2((-y1p - cyp) / ryAbs, (-x1p - cxp) / rxAbs);
  let delta = theta2 - theta1;
  if (sweep === 0 && delta > 0) delta -= Math.PI * 2;
  if (sweep === 1 && delta < 0) delta += Math.PI * 2;
  const steps = Math.max(8, Math.min(96, Math.ceil((Math.abs(delta) * Math.max(rxAbs, ryAbs)) / 3)));
  const out = [];
  for (let i = 1; i <= steps; i += 1) {
    const t = theta1 + (delta * i) / steps;
    out.push([
      Math.cos(phi) * rxAbs * Math.cos(t) - Math.sin(phi) * ryAbs * Math.sin(t) + cx,
      Math.sin(phi) * rxAbs * Math.cos(t) + Math.cos(phi) * ryAbs * Math.sin(t) + cy,
    ]);
  }
  return out;
}

/** 新增子路径并返回新对象（保持点引用）；首尾重合但没写 Z 的也视为闭合 */
function pushSubpath(subpaths, current, explicitClosed) {
  if (!current || current.points.length < 2) return;
  const points = current.points;
  let closed = Boolean(explicitClosed);
  if (!closed && points.length >= 3) {
    // 闭合容差按 bbox 最长边缩放（共享层的 bboxOf 与旧内联扫描逐字段等价）
    const box = bboxOf(points);
    const scale = Math.max(1, box.width, box.height);
    const first = points[0];
    const last = points[points.length - 1];
    if (Math.hypot(first[0] - last[0], first[1] - last[1]) <= scale * 1e-6) {
      closed = true;
      points.pop(); // 去掉与首点重合的尾点，避免闭合边零长度
    }
  }
  if (points.length >= 2) {
    subpaths.push({ points, closed });
  }
}

/**
 * 解析 SVG path 的 d 属性。
 *
 * @param {string} d path 数据
 * @returns {{subpaths: Array<{points: Array<[number, number]>, closed: boolean}>, warnings: string[]}}
 */
export function parsePathData(d) {
  const warnings = [];
  const subpaths = [];
  const tokens = String(d || "").match(TOKEN_RE) || [];
  let index = 0;
  let cmd = null;
  let pos = [0, 0];
  let start = [0, 0];
  let current = null;
  let prevCubicControl = null;
  let prevQuadControl = null;

  const ensureCurrent = () => {
    if (!current) current = { points: [pos.slice()] };
  };

  while (index < tokens.length) {
    const token = tokens[index];
    if (/^[A-Za-z]$/.test(token)) {
      cmd = token;
      index += 1;
      if (cmd.toUpperCase() === "Z") {
        pushSubpath(subpaths, current, true);
        current = null;
        pos = start.slice();
        prevCubicControl = null;
        prevQuadControl = null;
        cmd = null;
      }
      continue;
    }
    if (!cmd) {
      index += 1;
      continue;
    }
    const upper = cmd.toUpperCase();
    const arity = ARITY[upper];
    if (arity === undefined) {
      warnings.push(`忽略未知命令 ${cmd}`);
      cmd = null;
      index += 1;
      continue;
    }
    if (arity === 0) {
      cmd = null;
      continue;
    }
    if (index + arity > tokens.length) {
      warnings.push(`命令 ${cmd} 参数不足，路径提前结束`);
      break;
    }
    const chunk = tokens.slice(index, index + arity);
    if (chunk.some((item) => /^[A-Za-z]$/.test(item))) {
      warnings.push(`命令 ${cmd} 参数不完整，路径提前结束`);
      break;
    }
    index += arity;
    const nums = chunk.map(Number);
    const relative = cmd === cmd.toLowerCase();
    const base = pos.slice();
    const point = (a, b) => (relative ? [base[0] + a, base[1] + b] : [a, b]);

    if (upper === "M") {
      pushSubpath(subpaths, current, false);
      current = { points: [point(nums[0], nums[1])] };
      pos = current.points[0];
      start = pos.slice();
      cmd = relative ? "l" : "L";
      prevCubicControl = null;
      prevQuadControl = null;
    } else if (upper === "L") {
      ensureCurrent();
      const p = point(nums[0], nums[1]);
      current.points.push(p);
      pos = p;
      prevCubicControl = null;
      prevQuadControl = null;
    } else if (upper === "H") {
      ensureCurrent();
      const p = relative ? [base[0] + nums[0], base[1]] : [nums[0], base[1]];
      current.points.push(p);
      pos = p;
      prevCubicControl = null;
      prevQuadControl = null;
    } else if (upper === "V") {
      ensureCurrent();
      const p = relative ? [base[0], base[1] + nums[0]] : [base[0], nums[0]];
      current.points.push(p);
      pos = p;
      prevCubicControl = null;
      prevQuadControl = null;
    } else if (upper === "C") {
      ensureCurrent();
      const c1 = point(nums[0], nums[1]);
      const c2 = point(nums[2], nums[3]);
      const p = point(nums[4], nums[5]);
      current.points.push(...sampleCubic(pos, c1, c2, p));
      prevCubicControl = c2;
      prevQuadControl = null;
      pos = p;
    } else if (upper === "S") {
      ensureCurrent();
      const c1 = prevCubicControl ? [2 * pos[0] - prevCubicControl[0], 2 * pos[1] - prevCubicControl[1]] : pos;
      const c2 = point(nums[0], nums[1]);
      const p = point(nums[2], nums[3]);
      current.points.push(...sampleCubic(pos, c1, c2, p));
      prevCubicControl = c2;
      prevQuadControl = null;
      pos = p;
    } else if (upper === "Q") {
      ensureCurrent();
      const c = point(nums[0], nums[1]);
      const p = point(nums[2], nums[3]);
      current.points.push(...sampleQuadratic(pos, c, p));
      prevQuadControl = c;
      prevCubicControl = null;
      pos = p;
    } else if (upper === "T") {
      ensureCurrent();
      const c = prevQuadControl ? [2 * pos[0] - prevQuadControl[0], 2 * pos[1] - prevQuadControl[1]] : pos;
      const p = point(nums[0], nums[1]);
      current.points.push(...sampleQuadratic(pos, c, p));
      prevQuadControl = c;
      prevCubicControl = null;
      pos = p;
    } else if (upper === "A") {
      ensureCurrent();
      const p = point(nums[5], nums[6]);
      current.points.push(...sampleArc(pos, nums[0], nums[1], nums[2], nums[3] ? 1 : 0, nums[4] ? 1 : 0, p));
      prevCubicControl = null;
      prevQuadControl = null;
      pos = p;
    }
  }
  pushSubpath(subpaths, current, false);
  return { subpaths, warnings };
}

/**
 * 把 points 属性（polygon / polyline）解析成点列。
 *
 * @param {string} text points 属性
 * @returns {Array<[number, number]>}
 */
export function parsePointsAttribute(text) {
  const nums = (String(text || "").match(/-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || []).map(Number);
  const points = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    points.push([nums[i], nums[i + 1]]);
  }
  return points;
}
