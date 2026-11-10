/**
 * 多对象复合目标（方案 2026-11-05 §4.2）。
 *
 * 当参考通道命中了**全部**请求对象、且用户请求允许组合时，把每个对象的
 * 目标轮廓 T 组合成一个 multi-part 目标（各部分是独立闭环、共用同一坐标系），
 * 由规划器逐部分绕行并用真实路网衔接。
 *
 * 布局规则：
 * - 每个部分先按自身最长边归一化到 1（保持长宽比，不压扁形状）；
 * - 部分按网格摆放（cols = ⌈√n⌉），单元格之间留固定间隙 → 各部分必然分离，
 *   validateDisjointParts 不会因相交而拒收；
 * - 整体交给 normalizeCustomShape 做居中 + 等比归一化（最长边 = 1）。
 *
 * 纯函数：输入各部分点列，输出归一化 customShape 或失败原因。
 */

import { normalizeCustomShape } from './intent.js';

/** 复合目标允许的部分数上限（与 intent.js 的 parts 上限一致） */
export const MAX_COMPOSITE_PARTS = 8;
/** 单元格之间的间隙（归一化单位，相对单元格边长） */
const CELL_GAP = 0.08;

/**
 * 计算一组点列的包围盒。
 *
 * @param {Array<[number, number]>} points 点列
 * @returns {{minX: number, maxX: number, minY: number, maxY: number, width: number, height: number}|null}
 */
function bboxOf(points) {
  if (!Array.isArray(points) || points.length < 3) {
    return null;
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    const x = Number(point?.[0]);
    const y = Number(point?.[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return null;
    }
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const width = maxX - minX;
  const height = maxY - minY;
  if (!(width > 0) || !(height > 0)) {
    return null; // 退化点列（一条线/一个点）不能作为复合部分
  }
  return { minX, maxX, minY, maxY, width, height };
}

/**
 * 把多个对象的轮廓组合成一个 multi-part 目标。
 *
 * @param {Array<{name: string, points: Array<[number, number]>}>} parts 各部分的点列与名字
 * @param {object} [options]
 * @param {string} [options.name] 复合目标的名字（缺省用各部分名拼接）
 * @returns {{ok: true, customShape: object}|{ok: false, reason: string}}
 */
export function composeMultiPartShape(parts, { name = null } = {}) {
  const list = Array.isArray(parts) ? parts : [];
  if (list.length < 2) {
    return { ok: false, reason: '复合目标至少需要两个部分' };
  }
  if (list.length > MAX_COMPOSITE_PARTS) {
    return { ok: false, reason: `复合目标最多 ${MAX_COMPOSITE_PARTS} 个部分（收到 ${list.length} 个）` };
  }

  // 每个部分：先按自身最长边归一化到 1（保持长宽比，不压扁形状）
  const normalized = [];
  for (const part of list) {
    const bbox = bboxOf(part?.points);
    if (!bbox) {
      return { ok: false, reason: `部分「${part?.name ?? '?'}」点列非法或退化` };
    }
    const scale = 1 / Math.max(bbox.width, bbox.height);
    const points = part.points.map((point) => [
      (Number(point[0]) - (bbox.minX + bbox.maxX) / 2) * scale,
      (Number(point[1]) - (bbox.minY + bbox.maxY) / 2) * scale,
    ]);
    normalized.push({
      name: part?.name ?? '',
      points,
      width: bbox.width * scale,
      height: bbox.height * scale,
    });
  }

  // 网格布局：cols = ⌈√n⌉，行数 = ⌈n/cols⌉
  const cols = Math.ceil(Math.sqrt(normalized.length));
  const rows = Math.ceil(normalized.length / cols);
  // 所有部分共用同一归一化坐标系：整个图形必须落在 [-0.5, 0.5] 内，
  // 因此单元格边长按网格行列数反推（间距固定留白，形状之间必然分离）。
  const cell = (1 - (Math.max(cols, rows) - 1) * CELL_GAP) / Math.max(cols, rows);
  const prepared = normalized.map((part) => {
    const scale = cell / Math.max(part.width, part.height);
    return {
      name: part.name,
      points: part.points.map((point) => [point[0] * scale, point[1] * scale]),
    };
  });

  // 网格摆放：cols = ⌈√n⌉，行数 = ⌈n/cols⌉；网格整体居中于原点
  const step = cell + CELL_GAP;
  const laidOut = prepared.map((part, index) => {
    const row = Math.floor(index / cols);
    const col = index % cols;
    const cellCenterX = col * step - ((cols - 1) * step) / 2;
    const cellCenterY = ((rows - 1) * step) / 2 - row * step; // 行向下排（y 轴向上）
    return {
      name: part.name,
      points: part.points.map((point) => [point[0] + cellCenterX, point[1] + cellCenterY]),
    };
  });

  const shapeName =
    (name && name.trim()) ||
    laidOut.map((part) => part.name).filter(Boolean).join('+') ||
    '组合图形';
  const customShape = normalizeCustomShape({
    name: shapeName.slice(0, 20),
    parts: laidOut.map((part) => ({ name: part.name.slice(0, 20), points: part.points })),
  });
  if (!customShape) {
    return { ok: false, reason: '复合目标拓扑或点列校验未通过（部分可能相交或退化）' };
  }
  if (customShape.parts.length !== laidOut.length) {
    return { ok: false, reason: '复合目标部分数不一致' };
  }
  return { ok: true, customShape };
}
