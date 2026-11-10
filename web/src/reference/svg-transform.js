/**
 * SVG 变换矩阵工具（纯函数，Node / 浏览器通用）。
 *
 * 采用 SVG 规范约定：矩阵 [a, b, c, d, e, f]，
 *   x' = a*x + c*y + e
 *   y' = b*x + d*y + f
 * 组合时 multiply(parent, child) 表示"先应用 child、再应用 parent"。
 */

/** 单位矩阵 */
export const IDENTITY = [1, 0, 0, 1, 0, 0];

/**
 * 组合两个矩阵：先 child 后 parent。
 *
 * @param {number[]} parent 父矩阵
 * @param {number[]} child 子矩阵
 * @returns {number[]} 组合矩阵
 */
export function multiply(parent, child) {
  const [pa, pb, pc, pd, pe, pf] = parent;
  const [ca, cb, cc, cd, ce, cf] = child;
  return [
    pa * ca + pc * cb,
    pb * ca + pd * cb,
    pa * cc + pc * cd,
    pb * cc + pd * cd,
    pa * ce + pc * cf + pe,
    pb * ce + pd * cf + pf,
  ];
}

/**
 * 对点应用矩阵。
 *
 * @param {number[]} matrix 矩阵
 * @param {[number, number]} point 点
 * @returns {[number, number]} 变换后的点
 */
export function applyMatrix(matrix, [x, y]) {
  const [a, b, c, d, e, f] = matrix;
  return [a * x + c * y + e, b * x + d * y + f];
}

/** 数值解析：容忍空串/非法值，非法返回 null */
function numbers(text) {
  const out = [];
  for (const part of String(text || "").split(/[\s,]+/)) {
    if (!part) continue;
    const value = Number(part);
    if (!Number.isFinite(value)) return null;
    out.push(value);
  }
  return out;
}

/**
 * 解析 transform 属性（支持 matrix / translate / scale / rotate / skewX / skewY）。
 * 无法识别或参数不足的函数会被忽略（宁少变换，不抛异常）。
 *
 * @param {string} text transform 属性值
 * @returns {number[]} 组合矩阵
 */
export function parseTransform(text) {
  let result = IDENTITY.slice();
  const re = /([a-zA-Z]+)\s*\(([^)]*)\)/g;
  let match;
  while ((match = re.exec(text || ""))) {
    const name = match[1].toLowerCase();
    const nums = numbers(match[2]);
    if (!nums) continue;
    let local = null;
    if (name === "matrix" && nums.length >= 6) {
      local = nums.slice(0, 6);
    } else if (name === "translate" && nums.length >= 1) {
      local = [1, 0, 0, 1, nums[0], nums.length > 1 ? nums[1] : 0];
    } else if (name === "scale" && nums.length >= 1) {
      const sx = nums[0];
      const sy = nums.length > 1 ? nums[1] : sx;
      local = [sx, 0, 0, sy, 0, 0];
    } else if (name === "rotate" && nums.length >= 1) {
      const angle = (nums[0] * Math.PI) / 180;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const rotation = [cos, sin, -sin, cos, 0, 0];
      if (nums.length >= 3) {
        const cx = nums[1];
        const cy = nums[2];
        local = multiply(multiply([1, 0, 0, 1, cx, cy], rotation), [1, 0, 0, 1, -cx, -cy]);
      } else {
        local = rotation;
      }
    } else if (name === "skewx" && nums.length >= 1) {
      local = [1, 0, Math.tan((nums[0] * Math.PI) / 180), 1, 0, 0];
    } else if (name === "skewy" && nums.length >= 1) {
      local = [1, Math.tan((nums[0] * Math.PI) / 180), 0, 1, 0, 0];
    }
    if (local) {
      result = multiply(result, local);
    }
  }
  return result;
}
