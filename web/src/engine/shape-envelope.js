/**
 * 形状绝对误差包络 E_shape 与基线—候选集裁决原语（纯函数，Node 可直接测试）。
 *
 * 背景（docs/方案设计/2026-11-01-图形路线视觉效果通用优化方案.md 第 5.2 / 5.3 节）：
 * 粗搜出的各个大档必须与"同一个近场基线 B"逐个比较，而不是逐个更新冠军，
 * 否则中间档会把更大的好档卡住。本模块只提供裁决用的纯函数原语：
 *
 *   E_shape(c) = max(orderedOutlineMaxMeters, orderedRouteMaxMeters, frechetMaxMeters)
 *
 * - 包络只含三项直接描述"目标 vs 路线"形状的米制指标；吸附偏差只走 quality.js
 *   的 SNAP_HARD_GATE_METERS 硬门，关键点与特征偏差只走质量门，一律不并入包络
 *   （否则吸附毛刺会单独否决形状更好的大档）。
 * - 三项任一缺失 / 非有限 → 包络为 null：该候选不得进入胜出集，也不得"缺省放行"。
 * - 判定看"包络最大值是否不劣"，不是"任一字段变差即否决"：一项改善让包络不劣时，
 *   另一项较低量级的指标变差不得单独否决（基线 72/57m 与大档 73/55m、74/56m 场景）。
 *
 * 裁决口径（evaluateChallenger）：挑战者必须同时满足
 *   ① 内容哈希一致（不跨数据/版本比较）；
 *   ② 质量门通过（quality.js 的 meetsQualityBar）；
 *   ③ 分数严格高于基线；
 *   ④ E_shape(c) <= E_shape(B) + 浮点容差；
 * 比较期间基线保持不变（不拿前一个胜出者改写 B），避免中间档卡住更大档。
 *
 * 精修复检（verifyRefinedCandidate）：在上述四条之上追加
 *   D(c) <= D(B) + 同一容差（D = 请求中心到候选中心的地面距离，与 candidates.js
 *   的 adjustedScoreOf 用同一个 origin），偏移变远即拒绝，由上层回退到精修前
 *   的大档候选；这里不改成比较调整分。
 *
 * 本模块是纯函数：只依赖 engine 内的 quality.js / graph.js，不读写全局状态、
 * 不使用浏览器 API、不打日志（调用方负责记录），Node 可直接 import 测试。
 */

import { distanceMeters } from './graph.js';
import { meetsQualityBar, scoreRoute } from './quality.js';

/** 统一浮点比较容差（米）：包络与偏移比较共用，判定"不劣"用 envelope(c) <= envelope(B) + 容差 */
export const SHAPE_ENVELOPE_TOLERANCE_METERS = 1e-6;

/** 包络取值来源的三个米制字段（吸附、关键点、特征偏差一律不并入） */
export const SHAPE_ENVELOPE_FIELDS = Object.freeze([
  'orderedOutlineMaxMeters',
  'orderedRouteMaxMeters',
  'frechetMaxMeters',
]);

/** 裁决结果的 reason 取值（上层据此决定回退、提示或记录） */
export const SHAPE_ENVELOPE_REASONS = Object.freeze({
  ACCEPTED: 'accepted',
  INVALID_INPUT: 'invalid-input',
  TARGET_HASH_MISMATCH: 'target-hash-mismatch',
  METRICS_MISSING: 'metrics-missing',
  QUALITY_BAR_FAILED: 'quality-bar-failed',
  SCORE_NOT_BETTER: 'score-not-better',
  ENVELOPE_MISSING: 'envelope-missing',
  ENVELOPE_WORSE: 'envelope-worse',
  OFFSET_UNKNOWN: 'offset-unknown',
  OFFSET_FARTHER: 'offset-farther',
});

/**
 * 是否是"普通对象"（排除 null / 数组 / 原始值），用于输入合法性判定。
 *
 * @param {*} value 待判定值
 * @returns {boolean} 是否为普通对象
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 取候选的规划指标：兼容 `candidate.result.metrics`（candidates.js 现行结构）与
 * `candidate.metrics`（直挂指标）两个入口。
 *
 * @param {object|null|undefined} candidate 候选对象
 * @returns {object|null} metrics（缺失返回 null）
 */
function metricsOf(candidate) {
  if (!isPlainObject(candidate)) {
    return null;
  }
  const fromResult = candidate.result?.metrics;
  if (isPlainObject(fromResult)) {
    return fromResult;
  }
  return isPlainObject(candidate.metrics) ? candidate.metrics : null;
}

/**
 * 从 metrics 计算形状绝对误差包络：三项米制指标的最大值。
 * 任一项缺失或非有限 → 返回 null（不得缺省放行）。
 *
 * @param {object|null|undefined} metrics 规划指标
 * @returns {number|null} 包络值（米）或 null
 */
function envelopeOfMetrics(metrics) {
  if (!isPlainObject(metrics)) {
    return null;
  }
  let envelope = null;
  for (const field of SHAPE_ENVELOPE_FIELDS) {
    const value = metrics[field];
    if (!Number.isFinite(value)) {
      return null;
    }
    envelope = envelope === null ? value : Math.max(envelope, value);
  }
  return envelope;
}

/**
 * 形状绝对误差包络 E_shape：max(orderedOutlineMaxMeters, orderedRouteMaxMeters, frechetMaxMeters)。
 * 只取这三项米制指标，吸附偏差、关键点与特征偏差不并入。
 *
 * 入参既可以是候选对象（读 `result.metrics` 或 `metrics`），也可以直接是 metrics。
 *
 * @param {object|null|undefined} input 候选或 metrics
 * @returns {number|null} 包络值（米）；字段缺失/非有限返回 null
 */
export function shapeErrorEnvelopeMeters(input) {
  if (!isPlainObject(input)) {
    return null;
  }
  const isMetrics =
    SHAPE_ENVELOPE_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(input, field));
  return envelopeOfMetrics(isMetrics ? input : metricsOf(input));
}

/**
 * 取候选分数：优先用候选自带的 score（candidates.js 口径，与 scoreRoute 同源）。
 * 分数字段存在但非有限（NaN/Infinity）视为数据损坏，直接返回 null 走拒绝，
 * 不得静默改写为其它数值；分数字段缺失时才按 metrics 重算一次 scoreRoute。
 * 仍不可得返回 null（不得当成 0 参与比较）。
 *
 * @param {object|null|undefined} candidate 候选对象
 * @returns {number|null} 分数
 */
function scoreOf(candidate) {
  if (!isPlainObject(candidate)) {
    return null;
  }
  if (candidate.score !== undefined && candidate.score !== null) {
    return Number.isFinite(candidate.score) ? candidate.score : null;
  }
  const metrics = metricsOf(candidate);
  if (!metrics) {
    return null;
  }
  const computed = scoreRoute(metrics);
  return Number.isFinite(computed) ? computed : null;
}

/**
 * 偏移距离 D：请求中心（origin）到候选中心的地面距离（米）。
 * 与 candidates.js 的 adjustedScoreOf 使用同一个 origin 口径。
 *
 * @param {object|null|undefined} candidate 候选对象（读 center）
 * @param {{lat: number, lng: number}|null|undefined} origin 请求中心
 * @returns {number|null} 偏移距离（米）；中心或 origin 缺失/非法返回 null
 */
export function offsetMetersOf(candidate, origin) {
  const center = isPlainObject(candidate) ? candidate.center : null;
  if (!isPlainObject(origin) || !isPlainObject(center)) {
    return null;
  }
  const lat1 = origin.lat;
  const lng1 = origin.lng;
  const lat2 = center.lat;
  const lng2 = center.lng;
  if (!Number.isFinite(lat1) || !Number.isFinite(lng1) || !Number.isFinite(lat2) || !Number.isFinite(lng2)) {
    return null;
  }
  return distanceMeters(lat1, lng1, lat2, lng2);
}

/**
 * 归一化浮点比较容差：非法或负数容差回退到默认的 SHAPE_ENVELOPE_TOLERANCE_METERS。
 *
 * @param {number|undefined|null} tolerance 调用方指定的容差（米）
 * @returns {number} 生效容差（米）
 */
function toleranceOf(tolerance) {
  return Number.isFinite(tolerance) && tolerance >= 0 ? tolerance : SHAPE_ENVELOPE_TOLERANCE_METERS;
}

/**
 * 内容哈希读取：非空字符串才算有效（缺失即视为不一致）。
 *
 * @param {object|null|undefined} candidate 候选对象
 * @returns {string|null} 内容哈希
 */
function targetHashOf(candidate) {
  const hash = isPlainObject(candidate) ? candidate.targetHash : null;
  return typeof hash === 'string' && hash.length > 0 ? hash : null;
}

/**
 * 基线相对裁决：把一个挑战者与同一个基线比较，给出是否进入胜出集。
 * 不修改 comparePassingCandidates，也不改动基线（比较期间不更新 B）。
 *
 * 进入胜出集需同时满足：
 *   ① challenger.targetHash === baseline.targetHash（缺失即拒绝）；
 *   ② quality.js 的 meetsQualityBar 通过（metrics 缺失即拒绝）；
 *   ③ score(challenger) > score(baseline)（严格大于）；
 *   ④ E_shape(challenger) <= E_shape(baseline) + tolerance（包络缺失即拒绝）。
 *
 * @param {object} params 输入参数
 * @param {object} params.challenger 挑战者候选
 * @param {object} params.baseline 基线候选（比较期间不变）
 * @param {{lat: number, lng: number}} [params.origin] 请求中心（算偏移用）
 * @param {number} [params.tolerance] 浮点比较容差（米），缺省 SHAPE_ENVELOPE_TOLERANCE_METERS
 * @returns {{
 *   accepted: boolean,
 *   reason: string,
 *   envelope: number|null,
 *   baselineEnvelope: number|null,
 *   score: number|null,
 *   baselineScore: number|null,
 *   offsetMeters: number|null,
 *   baselineOffsetMeters: number|null,
 *   tolerance: number
 * }} 裁决结果
 */
export function evaluateChallenger({ challenger, baseline, origin, tolerance } = {}) {
  const effectiveTolerance = toleranceOf(tolerance);
  const envelope = shapeErrorEnvelopeMeters(challenger);
  const baselineEnvelope = shapeErrorEnvelopeMeters(baseline);
  const score = scoreOf(challenger);
  const baselineScore = scoreOf(baseline);
  const offsetMeters = offsetMetersOf(challenger, origin);
  const baselineOffsetMeters = offsetMetersOf(baseline, origin);

  const result = {
    accepted: false,
    reason: SHAPE_ENVELOPE_REASONS.INVALID_INPUT,
    envelope,
    baselineEnvelope,
    score,
    baselineScore,
    offsetMeters,
    baselineOffsetMeters,
    tolerance: effectiveTolerance,
  };

  // 输入合法性：两侧都必须是对象，否则直接拒绝（不产生 NaN 比较）
  if (!isPlainObject(challenger) || !isPlainObject(baseline)) {
    return result;
  }

  // ① 内容哈希一致（不跨数据/版本比较；缺失即拒绝）
  const hash = targetHashOf(challenger);
  const baselineHash = targetHashOf(baseline);
  if (hash === null || baselineHash === null || hash !== baselineHash) {
    result.reason = SHAPE_ENVELOPE_REASONS.TARGET_HASH_MISMATCH;
    return result;
  }

  // ② 质量门（metrics 缺失即拒绝；不达标由 meetsQualityBar 判定）
  const metrics = metricsOf(challenger);
  if (!metrics) {
    result.reason = SHAPE_ENVELOPE_REASONS.METRICS_MISSING;
    return result;
  }
  if (!meetsQualityBar(metrics)) {
    result.reason = SHAPE_ENVELOPE_REASONS.QUALITY_BAR_FAILED;
    return result;
  }

  // ③ 分数严格高于基线
  if (!Number.isFinite(score) || !Number.isFinite(baselineScore) || !(score > baselineScore)) {
    result.reason = SHAPE_ENVELOPE_REASONS.SCORE_NOT_BETTER;
    return result;
  }

  // ④ 形状绝对误差包络不劣（任一缺失即拒绝，不缺省放行）
  if (envelope === null || baselineEnvelope === null) {
    result.reason = SHAPE_ENVELOPE_REASONS.ENVELOPE_MISSING;
    return result;
  }
  if (!(envelope <= baselineEnvelope + effectiveTolerance)) {
    result.reason = SHAPE_ENVELOPE_REASONS.ENVELOPE_WORSE;
    return result;
  }

  result.accepted = true;
  result.reason = SHAPE_ENVELOPE_REASONS.ACCEPTED;
  return result;
}

/**
 * 最大胜出档选择：在胜出集中取尺寸最大的一档；同尺寸按分数更高；再同分按原始
 * 生成顺序更早（winner.order）确定，保证结果稳定可复现。
 *
 * 说明：不改写既有比较器语义（不触碰 comparePassingCandidates），内部用
 * slice().sort() 只对副本排序，并以 order 作为最后一级 tiebreak；缺 order 时
 * 退化为数组下标（即传入顺序）。
 *
 * @param {Array<object>} winners 胜出集成员，需带 sizeMeters / score / order
 * @returns {object|null} 选中的胜出者；胜出集为空或非法返回 null
 */
export function selectLargestWinner(winners) {
  if (!Array.isArray(winners) || winners.length === 0) {
    return null;
  }
  const decorated = winners.map((winner, index) => ({
    winner,
    index,
    size: Number.isFinite(winner?.sizeMeters) ? winner.sizeMeters : Number.NEGATIVE_INFINITY,
    score: Number.isFinite(winner?.score) ? winner.score : Number.NEGATIVE_INFINITY,
    order: Number.isFinite(winner?.order) ? winner.order : index,
  }));
  const sorted = decorated.slice().sort((a, b) => {
    if (a.size !== b.size) {
      return a.size > b.size ? -1 : 1;
    }
    if (a.score !== b.score) {
      return a.score > b.score ? -1 : 1;
    }
    if (a.order !== b.order) {
      return a.order < b.order ? -1 : 1;
    }
    return a.index - b.index;
  });
  return sorted[0].winner;
}

/**
 * 精修复检（方案 5.3）：在 evaluateChallenger 的全部条件之上追加偏移条件
 * D(candidate) <= D(baseline) + tolerance（D = 请求中心到候选中心的地面距离，
 * 与 adjustedScoreOf 用同一个 origin）。偏移变远即拒绝，由上层回退到精修前
 * 已经胜出的大档原候选；这里不改成比较调整分。
 *
 * @param {object} params 输入参数
 * @param {object} params.candidate 精修后的候选
 * @param {object} params.baseline 近场基线候选
 * @param {{lat: number, lng: number}} [params.origin] 请求中心
 * @param {number} [params.tolerance] 浮点比较容差（米）
 * @returns {{
 *   accepted: boolean,
 *   reason: string,
 *   envelope: number|null,
 *   baselineEnvelope: number|null,
 *   score: number|null,
 *   baselineScore: number|null,
 *   offsetMeters: number|null,
 *   baselineOffsetMeters: number|null,
 *   tolerance: number,
 *   offsetOk: boolean|null
 * }} 复检结果
 */
export function verifyRefinedCandidate({ candidate, baseline, origin, tolerance } = {}) {
  const evaluated = evaluateChallenger({ challenger: candidate, baseline, origin, tolerance });
  const result = { ...evaluated, offsetOk: null };
  if (!result.accepted) {
    return result;
  }
  const { offsetMeters, baselineOffsetMeters } = result;
  if (!Number.isFinite(offsetMeters) || !Number.isFinite(baselineOffsetMeters)) {
    result.accepted = false;
    result.reason = SHAPE_ENVELOPE_REASONS.OFFSET_UNKNOWN;
    result.offsetOk = false;
    return result;
  }
  if (!(offsetMeters <= baselineOffsetMeters + result.tolerance)) {
    result.accepted = false;
    result.reason = SHAPE_ENVELOPE_REASONS.OFFSET_FARTHER;
    result.offsetOk = false;
    return result;
  }
  result.offsetOk = true;
  return result;
}
