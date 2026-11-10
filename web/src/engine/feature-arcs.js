/**
 * 部位弧偏差（纯函数，Node 可直接测试；只记日志，不参与评分）。
 *
 * 背景：normalizeCustomShape 输出的 features 现在保留部分内索引 indices 与
 * partIndex（见 intent.js）。本模块按"所属部分内闭环"取包含特征锚点的最短弧，
 * 再取弧上每个投影轮廓点到最终路线最近点的距离最大值，供 trace 事件
 * `plan.feature.arcs` 观察各部位偏差（是"腿/耳/尾"整段没走出来，还是只有单点偏）。
 *
 * 口径约定（方案 3.3 节）：
 * - 只记录方案要求的两类部位：LLM 声明特征（declared）与几何检测凹口（notch）；
 *   窄间隙（gap）的"弧"语义取决于取哪一侧绕法、与其他两类不可比，本轮不写入弧日志
 *   （gap 仍由规划器的间隙保留率指标单独考核）；
 * - 多个锚点：闭环去掉相邻锚点间最大空隙，剩下的即包含全部锚点的最短弧；
 *   并列时取补集弧起点索引较小者；索引对部分点数取模，正确处理跨索引 0；
 * - 单个锚点：取「前一顶点 → 该点 → 后一顶点」，索引取模；n<3 按可用点退化；
 * - 多部分：严格按 partIndex 独立取弧，不混入跨部分假边或连接腿目标；
 * - 偏差 `measurement: 'unordered-point-to-route'`：弧上轮廓点到最终路线的
 *   无序最近距离最大值。该口径可能被无关路段拉低，只用于第一轮观察，
 *   不能直接转成绿色交付门槛。
 *
 * 硬约束：不写 metrics、不调用 scoreRoute / meetsQualityBar，不影响评分与交付；
 * 任何缺失/不匹配输入都返回 null + reason 降级，不抛异常。
 */

import { pointToPolylineMeters } from './fidelity.js';

/** 偏差口径标记：弧上投影轮廓点到最终路线的无序最近距离（不做同段对应） */
const FEATURE_ARC_MEASUREMENT = 'unordered-point-to-route';

/** 参与弧偏差的部位类型：方案要求的声明特征、检测凹口与有界身份浅凹（identity，
 * 方案 5.2：计入 plan.feature.arcs 部位弧日志）；gap 不写弧日志，避免不可比的
 * 弧口径混入（gap 仍由规划器的间隙保留率指标单独考核） */
const ARC_FEATURE_KINDS = new Set(['notch', 'declared', 'identity']);

/** 降级原因：最终路线不足 2 点，无法计算点到路线距离 */
const REASON_NO_ROUTE = 'no-route';
/** 降级原因：结果里没有投影轮廓（result.outlineLatLngs 缺失） */
const REASON_NO_OUTLINE = 'no-outline';
/** 降级原因：投影轮廓点数与归一化轮廓点数不一致（坐标系不匹配） */
const REASON_OUTLINE_MISMATCH = 'outline-mismatch';
/** 降级原因：特征找不到所属部分（partIndex 越界/parts 缺失） */
const REASON_NO_PART = 'no-part';
/** 降级原因：特征没有可用索引，取不出弧 */
const REASON_NO_ARC = 'no-arc';

/**
 * 把任意索引规范到闭环 [0, n)（负数按取模处理）。
 *
 * @param {number} index 原始索引
 * @param {number} n 闭环点数（> 0）
 * @returns {number} 规范后的索引
 */
function toRingIndex(index, n) {
  return ((Math.trunc(index) % n) + n) % n;
}

/**
 * 特征锚点索引去重（保序）并规范到闭环 [0, n)。
 *
 * @param {number[]} indices 部分内索引
 * @param {number} n 闭环点数（> 0）
 * @returns {number[]} 去重后的闭环索引
 */
function uniqueRingIndices(indices, n) {
  const seen = new Set();
  const out = [];
  for (const index of Array.isArray(indices) ? indices : []) {
    // 只认有限数字：Number(null)===0 会把非法索引静默当成 0 号点
    if (typeof index !== 'number' || !Number.isFinite(index)) {
      continue;
    }
    const ringIndex = toRingIndex(index, n);
    if (seen.has(ringIndex)) {
      continue;
    }
    seen.add(ringIndex);
    out.push(ringIndex);
  }
  return out;
}

/**
 * 闭环上从 start 沿索引递增方向走到 end（含两端）的索引序列。
 *
 * @param {number} start 起点索引（已规范）
 * @param {number} end 终点索引（已规范）
 * @param {number} n 闭环点数（> 0）
 * @returns {number[]} 索引序列（首元素 start、末元素 end）
 */
function ringWalk(start, end, n) {
  const out = [start];
  let cursor = start;
  while (cursor !== end) {
    cursor = (cursor + 1) % n;
    out.push(cursor);
    if (out.length > n) {
      break; // 防御：start/end 已规范时理论不会绕超过一整圈
    }
  }
  return out;
}

/**
 * 计算特征锚点在所属部分闭环上的最短弧（含全部锚点、中间点与两端）。
 *
 * @param {{indices: number[], outlineStart?: number}} feature 归一化特征：
 *   indices 为部分内索引（必填）；outlineStart 为所属部分在扁平轮廓里的起点
 *   （可选，缺省 0——直接调用时返回的"绝对索引"即部分内索引）
 * @param {number} partPointCount 所属部分的闭合点数 n
 * @returns {{
 *   arcStartIndex: number,
 *   arcEndIndex: number,
 *   arcPointCount: number,
 *   arcLocalIndices: number[]
 * }|null} 取不出弧（无合法索引/点数非法）返回 null
 */
export function computeFeatureArc(feature, partPointCount) {
  const n = Math.trunc(Number(partPointCount));
  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }
  const anchors = uniqueRingIndices(feature?.indices, n);
  if (anchors.length === 0) {
    return null;
  }
  // 绝对索引 = 所属部分扁平起点 + 部分内索引；直接调用未给 outlineStart 时即部分内索引
  const outlineStart =
    typeof feature?.outlineStart === 'number' && Number.isFinite(feature.outlineStart)
      ? Math.trunc(feature.outlineStart)
      : 0;

  let arcLocalIndices;
  if (anchors.length === 1) {
    // 单个锚点：前一顶点 → 该点 → 后一顶点（n>=3 时恰好 3 点，跨索引 0 自动取模）
    const only = anchors[0];
    if (n < 3) {
      // 点数不足 3：按可用点退化——从锚点起绕环一周即全部可用点
      arcLocalIndices = ringWalk(only, (only - 1 + n) % n, n);
    } else {
      arcLocalIndices = ringWalk((only - 1 + n) % n, (only + 1) % n, n);
    }
  } else {
    // 多个锚点：最短弧 = 闭环去掉相邻锚点间最大空隙（含全部中间点与两端）。
    // 并列时取补集弧起点索引较小者：排除起点索引最大（最靠后）的并列空隙，
    // 补集弧就从小锚点开始——这是确定性的唯一结果。
    anchors.sort((a, b) => a - b);
    let gapIndex = 0;
    let gapSteps = -1;
    for (let i = 0; i < anchors.length; i += 1) {
      const next = anchors[(i + 1) % anchors.length];
      const steps = ((next - anchors[i]) % n + n) % n;
      if (steps > gapSteps || (steps === gapSteps && anchors[i] > anchors[gapIndex])) {
        gapSteps = steps;
        gapIndex = i;
      }
    }
    const arcStart = anchors[(gapIndex + 1) % anchors.length];
    const arcEnd = anchors[gapIndex];
    arcLocalIndices = ringWalk(arcStart, arcEnd, n);
  }

  const arcStartLocal = arcLocalIndices[0];
  const arcEndLocal = arcLocalIndices[arcLocalIndices.length - 1];
  return {
    arcStartIndex: outlineStart + arcStartLocal,
    arcEndIndex: outlineStart + arcEndLocal,
    arcPointCount: arcLocalIndices.length,
    arcLocalIndices,
  };
}

/**
 * 对归一化图形中的每个"声明特征 / 检测凹口"计算部位弧偏差（供 trace 事件 plan.feature.arcs）。
 * 窄间隙（gap）不写入（见模块头口径说明）。
 *
 * 只对选定/最终参考候选调用（不要在 planShapeRoute 的每个候选里调用，否则额外
 * 耗时会改变预算耗尽位置与最终交付）。纯函数：不写 metrics、不碰评分。
 *
 * @param {object} options
 * @param {object} [options.customShape] normalizeCustomShape 的输出
 *   （features 带 indices/partIndex，parts 带 outlineStart/outlineCount）
 * @param {object} [options.result] planShapeRoute 结果（outlineLatLngs / routeLatLngs /
 *   shapeName / sizeMeters / rotationDeg / center）
 * @param {number} [options.score] 选定候选评分（外部传入，本函数不重新评分）
 * @returns {{
 *   shapeName: string,
 *   score: number|null,
 *   sizeMeters: number|null,
 *   rotationDeg: number|null,
 *   center: {lat: number, lng: number}|null,
 *   features: Array<{
 *     kind: string, name: string, partIndex: number, anchorIndices: number[],
 *     arcStartIndex: number|null, arcEndIndex: number|null, arcPointCount: number,
 *     maxOffsetMeters: number|null, measurement: string, reason?: string
 *   }>
 * }}
 */
export function measureFeatureArcs({ customShape, result, score } = {}) {
  const shape = customShape && typeof customShape === 'object' ? customShape : {};
  const planned = result && typeof result === 'object' ? result : {};
  const features = Array.isArray(shape.features) ? shape.features : [];
  const parts = Array.isArray(shape.parts) ? shape.parts : [];
  const outlineLatLngs = planned.outlineLatLngs;
  const routeLatLngs = planned.routeLatLngs;

  // 基础字段：候选的 shapeName / 尺寸 / 朝向 / 中心直接取结果（结果缺失则安全降级）
  const shapeName =
    typeof planned.shapeName === 'string' && planned.shapeName
      ? planned.shapeName
      : typeof shape.name === 'string'
        ? shape.name
        : '';
  const returnedScore = typeof score === 'number' && Number.isFinite(score) ? score : null;
  const sizeMeters = typeof planned.sizeMeters === 'number' && Number.isFinite(planned.sizeMeters)
    ? planned.sizeMeters
    : null;
  const rotationDeg = typeof planned.rotationDeg === 'number' && Number.isFinite(planned.rotationDeg)
    ? planned.rotationDeg
    : null;
  const centerLat = planned.center?.lat;
  const centerLng = planned.center?.lng;
  const center =
    typeof centerLat === 'number' &&
    Number.isFinite(centerLat) &&
    typeof centerLng === 'number' &&
    Number.isFinite(centerLng)
      ? { lat: centerLat, lng: centerLng }
      : null;

  // 输入可用性：投影轮廓缺失/点数不匹配、最终路线不足 2 点 → 统一降级为 null + reason
  const hasOutline = Array.isArray(outlineLatLngs) && outlineLatLngs.length > 0;
  const expectedOutlineCount = Array.isArray(shape.outlinePoints) ? shape.outlinePoints.length : null;
  const outlineMatched =
    hasOutline && (expectedOutlineCount === null || outlineLatLngs.length === expectedOutlineCount);
  const hasRoute = Array.isArray(routeLatLngs) && routeLatLngs.length >= 2;
  const degradeReason = !hasOutline
    ? REASON_NO_OUTLINE
    : !outlineMatched
      ? REASON_OUTLINE_MISMATCH
      : !hasRoute
        ? REASON_NO_ROUTE
        : null;

  const measured = [];
  // 只对方案要求的部位类型取弧（声明特征 + 检测凹口）；gap 不写弧日志，避免不可比的弧口径混入
  for (const feature of features.filter((item) => item && ARC_FEATURE_KINDS.has(item.kind))) {
    if (!feature || typeof feature !== 'object') {
      continue;
    }
    const kind = typeof feature.kind === 'string' ? feature.kind : '';
    const name = typeof feature.name === 'string' ? feature.name : '';
    const partIndex =
      Number.isInteger(feature.partIndex) && feature.partIndex >= 0 ? feature.partIndex : 0;
    const anchorLocalIndices = Array.isArray(feature.indices) ? feature.indices.slice() : [];
    const part = parts[partIndex];
    const partValid =
      part &&
      Number.isInteger(part.outlineStart) &&
      Number.isInteger(part.outlineCount) &&
      part.outlineCount > 0;

    if (!partValid) {
      measured.push({
        kind,
        name,
        partIndex,
        anchorIndices: anchorLocalIndices,
        arcStartIndex: null,
        arcEndIndex: null,
        arcPointCount: 0,
        maxOffsetMeters: null,
        measurement: FEATURE_ARC_MEASUREMENT,
        reason: REASON_NO_PART,
      });
      continue;
    }
    const outlineStart = part.outlineStart;
    const anchorIndices = anchorLocalIndices.map(
      (index) => outlineStart + toRingIndex(index, part.outlineCount),
    );
    const arc = computeFeatureArc({ ...feature, outlineStart }, part.outlineCount);
    if (!arc) {
      measured.push({
        kind,
        name,
        partIndex,
        anchorIndices,
        arcStartIndex: null,
        arcEndIndex: null,
        arcPointCount: 0,
        maxOffsetMeters: null,
        measurement: FEATURE_ARC_MEASUREMENT,
        reason: REASON_NO_ARC,
      });
      continue;
    }
    const entry = {
      kind,
      name,
      partIndex,
      anchorIndices,
      arcStartIndex: arc.arcStartIndex,
      arcEndIndex: arc.arcEndIndex,
      arcPointCount: arc.arcPointCount,
      measurement: FEATURE_ARC_MEASUREMENT,
    };
    if (degradeReason) {
      measured.push({ ...entry, maxOffsetMeters: null, reason: degradeReason });
      continue;
    }
    // 弧上每个投影轮廓点（绝对索引）到最终路线的最近距离，取最大值
    let maxOffsetMeters = 0;
    let missingOutlinePoint = false;
    for (const localIndex of arc.arcLocalIndices) {
      const point = outlineLatLngs[outlineStart + localIndex];
      const lat = point?.[0];
      const lng = point?.[1];
      if (typeof lat !== 'number' || !Number.isFinite(lat) || typeof lng !== 'number' || !Number.isFinite(lng)) {
        missingOutlinePoint = true;
        break;
      }
      const distance = pointToPolylineMeters(lat, lng, routeLatLngs);
      if (distance > maxOffsetMeters) {
        maxOffsetMeters = distance;
      }
    }
    if (missingOutlinePoint || !Number.isFinite(maxOffsetMeters)) {
      measured.push({
        ...entry,
        maxOffsetMeters: null,
        reason: missingOutlinePoint ? REASON_OUTLINE_MISMATCH : REASON_NO_ROUTE,
      });
    } else {
      measured.push({ ...entry, maxOffsetMeters });
    }
  }

  return {
    shapeName,
    score: returnedScore,
    sizeMeters,
    rotationDeg,
    center,
    features: measured,
  };
}
