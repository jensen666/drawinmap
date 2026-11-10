/**
 * 平面闭环几何与拓扑校验（纯函数，Node 可直接测试）——**共享几何层**。
 *
 * 这些函数原先在 `web/src/agent/shape-validate.js`，被 `reference/{geometry,rings,convert}.js`
 * 反向依赖（reference → agent 的分层倒挂，清理方案 2026-11-09 §3.2 B4）。现下沉到
 * engine 共享层：agent 与 reference 都从这里取，依赖方向统一为"上层 → engine"。
 *
 * 坐标约定：归一化平面坐标 [-0.5, 0.5]，与 intent.js 的 customShape 一致；
 * MIN_SHAPE_AREA / POINT_EPSILON 是引擎口径，与 customShape 的接受区间一致。
 * 校验背景：拒绝自交、非相邻重复点、退化面积、部分相交/嵌套（见各函数注释）。
 */

/** 图形有效面积下限（归一化单位²）：低于该值视为退化（一条线/一个点） */
const MIN_SHAPE_AREA = 0.001;

/** 两个浮点坐标判等的容差（归一化单位，约图形尺寸的 0.1%） */
const POINT_EPSILON = 0.001;

/**
 * 有向面积（鞋带公式，逆时针为正）。
 *
 * @param {Array<[number, number]>} points 闭环点列
 * @returns {number} 有向面积（归一化单位²）
 */
export function polygonSignedArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

/** 绝对面积 */
export function polygonArea(points) {
  return Math.abs(polygonSignedArea(points));
}

/** 两点判等（含容差） */
function samePoint(a, b, epsilon = POINT_EPSILON) {
  return Math.abs(a[0] - b[0]) <= epsilon && Math.abs(a[1] - b[1]) <= epsilon;
}

/**
 * 线段相交判定（含端点接触）。使用方向叉积 + 共线重叠检测。
 *
 * @returns {boolean} 是否相交
 */
function segmentsIntersect(a, b, c, d) {
  const cross = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const onSegment = (p, q, r) =>
    Math.min(p[0], r[0]) - POINT_EPSILON <= q[0] &&
    q[0] <= Math.max(p[0], r[0]) + POINT_EPSILON &&
    Math.min(p[1], r[1]) - POINT_EPSILON <= q[1] &&
    q[1] <= Math.max(p[1], r[1]) + POINT_EPSILON;

  const d1 = cross(a, b, c);
  const d2 = cross(a, b, d);
  const d3 = cross(c, d, a);
  const d4 = cross(c, d, b);
  const eps = 1e-9;

  // 一般位置：两条线段各自跨立对方所在直线
  if (((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) &&
      ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps))) {
    return true;
  }
  // 共线/端点接触
  if (Math.abs(d1) <= eps && onSegment(a, c, b)) return true;
  if (Math.abs(d2) <= eps && onSegment(a, d, b)) return true;
  if (Math.abs(d3) <= eps && onSegment(c, a, d)) return true;
  if (Math.abs(d4) <= eps && onSegment(c, b, d)) return true;
  return false;
}

/**
 * 拓扑校验的错误码（方案 2026-11-08 §5.2：依据验证器错误类型提前终止无效恢复）。
 *
 * - `unsupported-topology`：当前架构**确定不支持**的拓扑（嵌套孔洞）——
 *   再生成一版也还是不支持，不得浪费一次恢复调用；
 * - 其余为可尝试修复的非法点列（自交、部分相交、退化），保留既有有界恢复。
 */
const TOPOLOGY_ERROR_CODES = Object.freeze({
  POINT_COUNT: 'point-count',
  DUPLICATE_POINT: 'duplicate-point',
  SELF_INTERSECTION: 'self-intersection',
  DEGENERATE_AREA: 'degenerate-area',
  PARTS_INTERSECT: 'parts-intersect',
  PARTS_NESTED: 'parts-nested',
  UNSUPPORTED_TOPOLOGY: 'unsupported-topology',
});

/**
 * 判断某个错误码是否属于"当前确定不支持的拓扑"。
 *
 * @param {string|null} code 错误码
 * @returns {boolean}
 */
export function isUnsupportedTopologyCode(code) {
  return (
    code === TOPOLOGY_ERROR_CODES.UNSUPPORTED_TOPOLOGY ||
    code === TOPOLOGY_ERROR_CODES.PARTS_NESTED
  );
}

/**
 * 闭环是否自交：非相邻线段相交、或存在非相邻重复点。
 * 相邻线段共享一个端点（正常闭合），跳过。
 *
 * @param {Array<[number, number]>} points 闭环点列（不重复闭合点）
 * @returns {{ok: boolean, reason: string|null, code: string|null}} 校验结果
 */
export function validateSimplePolygon(points) {
  const n = points.length;
  if (n < 3) {
    return { ok: false, reason: '点数不足 3', code: TOPOLOGY_ERROR_CODES.POINT_COUNT };
  }
  // 非相邻重复点（相邻重复由去重阶段处理）
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 2; j < n; j += 1) {
      if (i === 0 && j === n - 1) {
        continue; // 首尾相邻（闭环）
      }
      if (samePoint(points[i], points[j])) {
        return {
          ok: false,
          reason: `非相邻点重合（#${i} 与 #${j}）`,
          code: TOPOLOGY_ERROR_CODES.DUPLICATE_POINT,
        };
      }
    }
  }
  // 非相邻边相交
  for (let i = 0; i < n; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % n];
    for (let j = i + 1; j < n; j += 1) {
      // 跳过相邻边（共享端点）与首尾边
      if (j === i || j === (i + 1) % n || (i === 0 && j === n - 1)) {
        continue;
      }
      const c = points[j];
      const d = points[(j + 1) % n];
      if (segmentsIntersect(a, b, c, d)) {
        return {
          ok: false,
          reason: `自交（边 #${i} 与 #${j}）`,
          code: TOPOLOGY_ERROR_CODES.SELF_INTERSECTION,
        };
      }
    }
  }
  const area = polygonArea(points);
  if (area < MIN_SHAPE_AREA) {
    return {
      ok: false,
      reason: `面积过小（${area.toFixed(4)}）`,
      code: TOPOLOGY_ERROR_CODES.DEGENERATE_AREA,
    };
  }
  return { ok: true, reason: null, code: null };
}

/**
 * 点是否在多边形内部（射线法，边界点视为在内部）。
 *
 * @param {[number, number]} point 点
 * @param {Array<[number, number]>} polygon 闭环点列
 * @returns {boolean} 是否在内部
 */
export function pointInPolygon(point, polygon) {
  const [px, py] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersect =
      yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi || Number.EPSILON) + xi;
    if (intersect) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * 两个闭环是否相交/包含/重合（即不能作为"分离部分"）。
 * 边相交 → 非法；一个部分的所有顶点都在另一个内部 → 嵌套（当前架构
 * 不支持孔洞，一笔画路线无法在不穿行的情况下画出内环）→ 非法。
 *
 * @param {Array<[number, number]>} a 闭环 A
 * @param {Array<[number, number]>} b 闭环 B
 * @returns {{ok: boolean, reason: string|null}} 校验结果
 */
export function validateDisjointParts(a, b) {
  for (let i = 0; i < a.length; i += 1) {
    const a1 = a[i];
    const a2 = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j += 1) {
      const b1 = b[j];
      const b2 = b[(j + 1) % b.length];
      if (segmentsIntersect(a1, a2, b1, b2)) {
        return {
          ok: false,
          reason: '部分之间边相交',
          code: TOPOLOGY_ERROR_CODES.PARTS_INTERSECT,
        };
      }
    }
  }
  // 包含判定：任一部分的顶点全在另一部分内部 → 嵌套
  const allInside = (inner, outer) => inner.every((point) => pointInPolygon(point, outer));
  if (allInside(a, b) || allInside(b, a)) {
    return {
      ok: false,
      reason: '部分之间嵌套（当前不支持孔洞图形）',
      // 嵌套孔洞是**当前架构确定不支持**的拓扑：再生成一版还是不支持
      code: TOPOLOGY_ERROR_CODES.UNSUPPORTED_TOPOLOGY,
    };
  }
  return { ok: true, reason: null, code: null };
}
