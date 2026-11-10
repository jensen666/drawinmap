/**
 * 自定义图形点列归一化（纯函数）：把各部分的点列汇总成规划可用的目标轮廓 T。
 *
 * 去重、坐标钳位、跨度校验、约束点抽稀与特征索引在 custom-shape-points.js；
 * 这里负责多部分汇总、拓扑校验（自交/退化拒收）与部分范围表。
 *
 * 本模块从 intent.js 独立出来（清理方案 2026-11-09 §5.4-3.4），目的是消除
 * `intent.js ↔ shape-spec.js` 的循环依赖：shape-spec.js 需要"规格 → 点列"的
 * 归一化，intent.js 需要"规格 → 意图"，两者共用同一份归一化口径。
 */

import { validateSimplePolygon, validateDisjointParts } from './shape-validate.js';
import {
  CUSTOM_COORD_LIMIT,
  CUSTOM_MIN_SPAN,
  CUSTOM_NAME_MAX,
  normalizePartPoints,
} from './custom-shape-points.js';

/** 对外口径：跨度下限与图像描摹（image-trace.js）共用同一门槛 */
export { CUSTOM_MIN_SPAN } from './custom-shape-points.js';

export function normalizeCustomShape(raw, onInvalid = null) {
  const invalidate = (reason, code = null) => {
    if (typeof onInvalid === 'function') {
      onInvalid(reason, code);
    }
    return null;
  };
  if (!raw || typeof raw !== 'object') {
    return invalidate('customShape 不是对象', 'invalid-shape');
  }
  let rawParts = null;
  if (Array.isArray(raw.parts) && raw.parts.length >= 1 && raw.parts.length <= 8) {
    rawParts = raw.parts;
  } else if (Array.isArray(raw.points)) {
    rawParts = [{ points: raw.points }];
  }
  if (!rawParts) {
    return invalidate('缺少 points/parts 点列', 'missing-points');
  }

  const outlinePoints = [];
  const constraintPoints = [];
  const parts = [];
  /** 各部分的细节特征（凹口/窄间隙/声明特征）：带部分内索引 indices 与 partIndex，
   * 供规划器检查是否走出、供部位弧偏差按"部分内闭环"取弧（不跨部分混弧） */
  const features = [];
  /** 各部分的闭环点列（拓扑校验用；与 parts 同序） */
  const partLoops = [];
  const singlePart = rawParts.length === 1;
  for (const part of rawParts) {
    if (!part || typeof part !== 'object' || !Array.isArray(part.points)) {
      return invalidate('parts 条目缺少 points 点列', 'missing-points');
    }
    // LLM 显式声明的特征：单部分时接受顶层 features，多部分时接受每部分 features
    const declaredFeatures = Array.isArray(part.features)
      ? part.features
      : singlePart && Array.isArray(raw.features)
        ? raw.features
        : [];
    // 分离小部分放宽跨度下限（岛 lobe 本就小），退化线仍拒收
    const one = normalizePartPoints(part.points, {
      minSpan: singlePart ? CUSTOM_MIN_SPAN : 0.04,
      declaredFeatures,
      // 部分序号按 parts 已汇总数量赋值（单部分恒为 0）
      partIndex: parts.length,
    });
    if (!one) {
      return invalidate('点列不合法（点数/坐标范围/跨度不达标）', 'invalid-points');
    }
    // 拓扑校验：自交（蝴蝶结）、非相邻重复点、退化面积一律拒收——
    // 规划器假设每个部分是简单闭环，非法拓扑会让走廊引导与贴合指标失去意义
    const topology = validateSimplePolygon(one.deduped);
    if (!topology.ok) {
      return invalidate(`拓扑不合法：${topology.reason}`, topology.code);
    }
    partLoops.push(one.deduped);
    // 特征汇总（坐标 + 所属部分 + 部分内索引；归一化后坐标会同步变换，
    // indices 保持部分内索引，不转成扁平 outlinePoints 的全局索引）
    for (const feature of one.features || []) {
      features.push({ ...feature, partIndex: parts.length, indices: [...feature.indices] });
    }
    parts.push({
      name: typeof part.name === 'string' && part.name.trim() ? part.name.trim().slice(0, CUSTOM_NAME_MAX) : '',
      outlineStart: outlinePoints.length,
      outlineCount: one.deduped.length,
      constraintStart: constraintPoints.length,
      constraintCount: one.constraintPoints.length,
    });
    outlinePoints.push(...one.deduped);
    constraintPoints.push(...one.constraintPoints);
  }
  // 多部分：部分之间不得相交/嵌套（当前架构只支持分离部分，不支持孔洞）
  for (let i = 0; i < partLoops.length; i += 1) {
    for (let j = i + 1; j < partLoops.length; j += 1) {
      const disjoint = validateDisjointParts(partLoops[i], partLoops[j]);
      if (!disjoint.ok) {
        return invalidate(`第 ${i + 1}/${j + 1} 部分${disjoint.reason}`, disjoint.code);
      }
    }
  }
  if (parts.length > 1) {
    // 多部分：整体跨度仍须达标（防整个图形退化）
    const xs = outlinePoints.map((p) => p[0]);
    const ys = outlinePoints.map((p) => p[1]);
    if (
      Math.max(...xs) - Math.min(...xs) < CUSTOM_MIN_SPAN ||
      Math.max(...ys) - Math.min(...ys) < CUSTOM_MIN_SPAN
    ) {
      return invalidate('多部分整体跨度不达标', 'degenerate-span');
    }
  }

  // 整体居中 + 等比归一化：LLM 的点列常偏在 [-0.5,0.5] 的一角（实测包围盒
  // 中心 [0.25,0.15]、跨度 0.36），直接投影会让 sizeMeters 不等于实际外接尺寸、
  // 图形中心偏离候选中心（偏移惩罚与用户可见偏移都失真）。对所有部分做同一次
  // 变换（保持部分间相对位置）：包围盒中心移到原点，最长边缩放到 1。
  const bounds = {
    minX: Math.min(...outlinePoints.map((p) => p[0])),
    maxX: Math.max(...outlinePoints.map((p) => p[0])),
    minY: Math.min(...outlinePoints.map((p) => p[1])),
    maxY: Math.max(...outlinePoints.map((p) => p[1])),
  };
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  const longestSpan = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
  if (Number.isFinite(longestSpan) && longestSpan > 0) {
    const scale = 1 / longestSpan;
    const normalizePoint = (point) => [
      Math.max(-CUSTOM_COORD_LIMIT, Math.min(CUSTOM_COORD_LIMIT, (point[0] - centerX) * scale)),
      Math.max(-CUSTOM_COORD_LIMIT, Math.min(CUSTOM_COORD_LIMIT, (point[1] - centerY) * scale)),
    ];
    for (let i = 0; i < outlinePoints.length; i += 1) {
      outlinePoints[i] = normalizePoint(outlinePoints[i]);
    }
    for (let i = 0; i < constraintPoints.length; i += 1) {
      constraintPoints[i] = normalizePoint(constraintPoints[i]);
    }
    // 特征点与轮廓同步变换（特征检查按投影后的实际位置计算）
    for (const feature of features) {
      feature.points = feature.points.map(normalizePoint);
    }
  }

  const name = typeof raw.name === 'string' && raw.name.trim()
    ? raw.name.trim().slice(0, CUSTOM_NAME_MAX)
    : '自定义图形';
  return { name, constraintPoints, outlinePoints, parts, features };
}