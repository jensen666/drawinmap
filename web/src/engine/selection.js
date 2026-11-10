/**
 * 候选选优比较器与"近失候选"判定（纯函数，Node 可直接测试）。
 *
 * 单独成文件：candidates.js 已超 1000 行，而"近且像优先"的选优规则是跨阶段的
 * 公共契约（粗搜逐轮、跨级尽力链、局部精修、失败诊断共用一套比较），集中在
 * 这里便于单测复用。达标候选的好坏用相对偏差的均方根：轮廓侧和路线侧各算
 * √(均值² + 总体方差)，取更差的一侧，越小越贴。不看绝对米数，也不再把大尺寸
 * 压回 1800m。均方根相同再比原始分，最后比尺寸。调整分只用于近场早退，不参与
 * 最终选优。
 *
 * 最终交付选优（2026-11-06 Bug 3 修复）走 selectPassingByScoreTier：先按分数
 * 分档（与池最高分差 ≤ SCORE_TIER_TOLERANCE），档内再按本文件比较器——
 * 准确性优先（分数明显更高的候选不得被 RMS 略差挤掉）。
 */

import { meetsQualityBar, qualityGateReport } from './quality.js';
import { distanceMeters } from './graph.js';

/** 近失候选的最低原始评分：更低说明多项几何偏差叠加，联合精修救不回来 */
export const NEAR_MISS_SCORE = 55;

/** 偏移感知调整分：每公里扣 5 分、封顶 12 分 */
const OFFSET_PENALTY_PER_KM = 5;
/** 偏移感知调整分：惩罚上限（分） */
const OFFSET_PENALTY_CAP = 12;

/**
 * 偏移感知调整分：达标候选之间的选择依据（原始分只衡量"像"，不衡量"近"）。
 * 评分里的偏差全部除以尺寸——同样的路网毛刺在更大的图形上占比更小、分更高，
 * 选优天然漂向"超大尺寸 + 远位置"（实测教训：九边形选中 3.6km/3.8km
 * 外的候选，评分 70 但既不像也不在"附近"）。调整分 = 评分 − 偏移惩罚
 * （每公里 5 分、封顶 12 分），让"用户指定的地点"重新进入决策。
 *
 * @param {number} score 原始评分
 * @param {{lat: number, lng: number}|null} candidateCenter 候选中心
 * @param {{lat: number, lng: number}|null} origin 请求中心（偏移惩罚基准）
 * @returns {number} 调整分
 */
export function adjustedScoreOf(score, candidateCenter, origin) {
  if (!origin || !candidateCenter) {
    return score;
  }
  const offsetKm = distanceMeters(origin.lat, origin.lng, candidateCenter.lat, candidateCenter.lng) / 1000;
  return score - Math.min(OFFSET_PENALTY_CAP, offsetKm * OFFSET_PENALTY_PER_KM);
}

/** 安全取数：非有限值用兜底值，保证候选字段残缺时比较器仍确定、不抛错 */
function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

/** 降序比较：a 大返回 -1（a 更优）；显式分支避免 Infinity − Infinity = NaN */
function byDescending(a, b) {
  return a === b ? 0 : a > b ? -1 : 1;
}

/** 升序比较：a 小返回 -1（a 更优） */
function byAscending(a, b) {
  return a === b ? 0 : a < b ? -1 : 1;
}

/**
 * 更差一侧的相对均方根。轮廓或路线缺字段时返回 Infinity，避免残缺候选冒充最贴。
 *
 * @param {object|null} candidate 候选，metrics 在 result.metrics 或 metrics 上
 * @returns {number} 更差一侧的均方根（越小越好）
 */
export function worseSideRmsOf(candidate) {
  const metrics = candidate?.result?.metrics ?? candidate?.metrics ?? null;
  const outline = metrics?.orderedOutlineRms;
  const route = metrics?.orderedRouteRms;
  if (!Number.isFinite(outline) || !Number.isFinite(route)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(outline, route);
}

/**
 * 达标候选跨档比较器（严格传递全序）：
 * ① 更差一侧相对均方根升序（越小越贴），分数高低不能压过它；
 * ② 原始分降序；
 * ③ 尺寸升序（均方根和分数都一样时，取更小的一档）。
 * 可直接作为 Array.prototype.sort 的比较函数（负数表示 a 更优）。
 *
 * 注意（缺陷清单 2026-11-06 Bug 3）：这个比较器**只用于同档内排序**（精修基线、
 * 近失比较、A/B 工具）。最终交付选优必须走 selectPassingByScoreTier——
 * 纯"相对 RMS 优先"会让合格池里分数更高的候选因为 RMS 略差被跳过
 * （N09 交付 70 分、同池 77 分；X14-ab 交付 74 分、同池 83 分）。
 *
 * @param {object} a 候选 {result: {metrics}, score, sizeMeters}
 * @param {object} b 候选
 * @returns {number} 排序值
 */
export function comparePassingCandidates(a, b) {
  return (
    byAscending(worseSideRmsOf(a), worseSideRmsOf(b)) ||
    byDescending(finiteOr(a?.score, -Infinity), finiteOr(b?.score, -Infinity)) ||
    byAscending(finiteOr(a?.sizeMeters, Infinity), finiteOr(b?.sizeMeters, Infinity))
  );
}

/**
 * 准确性优先的分数同档容差（分）：与同池最高分差不超过该值的候选视为"同档"，
 * 同档内才按"近且像"比较器选。3 分口径：贴合分是加权扣分的连续量，3 分以内的
 * 差异在"像"的分辨力之下，此时才允许尺寸/偏移/误差参与决策（缺陷清单 Bug 3.4）。
 */
export const SCORE_TIER_TOLERANCE = 3;

/**
 * 从达标候选池选出最终交付候选（缺陷清单 2026-11-06 Bug 3 修复，准确性优先口径）：
 *
 * ① 分数分档：与同池最高分差 ≤ SCORE_TIER_TOLERANCE 的候选进入首选档——
 *    分数明显更高的候选不得被"相对 RMS 略差"挤掉（项目口径：准确性第一目标）；
 * ② 档内按 comparePassingCandidates（相对 RMS → 分数 → 尺寸）选最优——
 *    同档内仍然"近且像优先"，避免分档退化成纯分数排序。
 *
 * @param {Array<object>} passing 达标候选池（{result, score, sizeMeters, ...}）
 * @param {{tolerance?: number}} [options] 分档容差（缺省 SCORE_TIER_TOLERANCE）
 * @returns {object|null} 选中的候选；空池返回 null
 */
export function selectPassingByScoreTier(passing, { tolerance = SCORE_TIER_TOLERANCE } = {}) {
  const list = (Array.isArray(passing) ? passing : []).filter(Boolean);
  if (list.length === 0) {
    return null;
  }
  const scores = list.map((candidate) => candidate?.score).filter((score) => Number.isFinite(score));
  const top = scores.length > 0 ? Math.max(...scores) : -Infinity;
  // 全池分数缺失（理论上不会出现）时退回比较器兜底，不抛错
  const tier = scores.length > 0
    ? list.filter((candidate) => Number.isFinite(candidate?.score) && top - candidate.score <= tolerance)
    : list;
  const base = tier.length > 0 ? tier : list;
  return base.reduce((best, candidate) => (comparePassingCandidates(candidate, best) < 0 ? candidate : best));
}

/**
 * 两个达标候选的分档比较（**只成对使用**：精修/联合精修采纳判定）。
 * 分差 > 容差时高分直接胜出；同档内按 comparePassingCandidates。
 *
 * 与 selectPassingByScoreTier 的分档口径一致——精修结果替换交付候选时，
 * 低分版不得因为 RMS 略差顶掉高分版（Bug 3 同源问题）。
 *
 * @param {object} a 候选
 * @param {object} b 候选
 * @param {{tolerance?: number}} [options]
 * @returns {number} 负数表示 a 更优
 */
export function compareCandidatesWithScoreTier(a, b, { tolerance = SCORE_TIER_TOLERANCE } = {}) {
  const sa = a?.score;
  const sb = b?.score;
  if (Number.isFinite(sa) && Number.isFinite(sb)) {
    if (sa - sb > tolerance) {
      return -1;
    }
    if (sb - sa > tolerance) {
      return 1;
    }
  }
  return comparePassingCandidates(a, b);
}

/**
 * 历史早退判定：质量达标 + 特征全部走出 + 调整分达到分数线。
 * 搜索已经不再调用它来停止。保留函数只为既有单测。
 *
 * @param {object|null} candidate 候选 {result: {metrics}, adjustedScore}
 * @param {number} scoreLine 早退分数线（调整分口径）
 * @returns {boolean} 是否可以提前结束搜索
 */
export function isGoodEnoughToExit(candidate, scoreLine) {
  const metrics = candidate?.result?.metrics;
  if (!metrics || !meetsQualityBar(metrics)) {
    return false;
  }
  if (finiteOr(metrics.featureCoverage, 1) < 1) {
    return false;
  }
  return finiteOr(candidate.adjustedScore, -Infinity) >= scoreLine;
}

/**
 * 是否"值得进联合精修的近失候选"：无硬门槛失败、只差一道软门槛、评分不低于线、
 * 且有完整路线（联合精修需要重放/重算）。硬门槛是几何本身画不出，联合精修只
 * 调吸附组合与单段档位，修不了。
 *
 * @param {object} candidate 候选 {result: {metrics, routeLatLngs}, score}
 * @param {{scoreLine?: number}} [opts] 可覆盖最低分线（缺省 NEAR_MISS_SCORE）
 * @returns {boolean} 是否可作为联合精修的近失基线
 */
export function isRefinableNearMiss(candidate, opts = {}) {
  const result = candidate?.result;
  if (!result || !Array.isArray(result.routeLatLngs) || result.routeLatLngs.length < 2) {
    return false;
  }
  const scoreLine = Number.isFinite(opts?.scoreLine) ? opts.scoreLine : NEAR_MISS_SCORE;
  if (finiteOr(candidate.score, -Infinity) < scoreLine) {
    return false;
  }
  const report = qualityGateReport(result.metrics);
  return report.hardFailures.length === 0 && report.softCount === 1;
}

// ============================================================================
// 成本感知选优（方案 2026-11-05 §6）
//
// §6 不预设已验证参数，只定义下一轮**公平对照方法**：同一个候选池上跑同一组规则，
// 看整组交付率、最低分、平均分、尺寸/路线/偏移中位与极端值。
// 生产默认选优规则**不变**（仍是本文件上方的 comparePassingCandidates），
// 下列规则只服务于对照实验，未通过采纳条件不得上线。
// ============================================================================

/** 可对照的选优规则（scoreTier = 生产规则，2026-11-06 Bug 3 修复后上线） */
export const SELECTION_RULES = Object.freeze(['current', 'tolerance', 'costFirst', 'scoreTier']);

/** 候选成本指标（方案 §6.2）：每个候选同时保留相对 RMS、绝对误差、尺寸、路线长度、步行时间和偏移 */
export function candidateCostMetrics(candidate, { origin = null } = {}) {
  const metrics = candidate?.result?.metrics ?? candidate?.metrics ?? null;
  const outlineMax = metrics?.orderedOutlineMaxMeters;
  const routeMax = metrics?.orderedRouteMaxMeters;
  const absError =
    Number.isFinite(outlineMax) && Number.isFinite(routeMax)
      ? Math.max(outlineMax, routeMax)
      : Number.isFinite(outlineMax)
        ? outlineMax
        : Number.isFinite(routeMax)
          ? routeMax
          : null;
  const offsetMeters =
    origin && candidate?.center
      ? distanceMeters(origin.lat, origin.lng, candidate.center.lat, candidate.center.lng)
      : null;
  return {
    score: finiteOr(candidate?.score, null),
    worseSideRms: worseSideRmsOf(candidate),
    absErrorMeters: absError,
    sizeMeters: finiteOr(candidate?.sizeMeters, null),
    routeMeters: finiteOr(metrics?.routeMeters, null),
    walkMinutes: finiteOr(metrics?.walkMinutes, null),
    offsetMeters,
    stage: candidate?.stage ?? null,
  };
}

/**
 * 统一容差规则（方案 §6.3 的第二条规则）：
 * 先按相对 RMS 容差过滤（在容差内的候选优先），再按现有规则排序。
 *
 * 容差内候选集合为空时退回全部候选（逐级回退，不直接无交付）。
 *
 * @param {object} a 带 metrics 的候选条目
 * @param {object} b 同上
 * @param {{tolerance?: number}} [options] 相对 RMS 容差（默认 0.1）
 * @returns {number} 排序值（负数表示 a 更优）
 */
function compareByUnifiedTolerance(a, b, { tolerance = 0.1 } = {}) {
  const aIn = Number.isFinite(a?.worseSideRms) && a.worseSideRms <= tolerance;
  const bIn = Number.isFinite(b?.worseSideRms) && b.worseSideRms <= tolerance;
  if (aIn !== bIn) {
    return aIn ? -1 : 1;
  }
  return comparePassingCandidates(a?.candidate, b?.candidate);
}

/**
 * 合格候选中的成本优先规则（方案 §6.3 的第三条规则）：
 * 尺寸 → 路线长度 → 偏移优先，质量分与 RMS 兜底比较。
 *
 * 只在**已过硬门槛**的候选之间使用——低成本不得抵消硬失败（方案 §6.1）。
 *
 * @param {object} a 带 metrics 的候选条目
 * @param {object} b 同上
 * @returns {number} 排序值（负数表示 a 更优）
 */
function compareByCostFirst(a, b) {
  return (
    byAscending(finiteOr(a?.sizeMeters, Infinity), finiteOr(b?.sizeMeters, Infinity)) ||
    byAscending(finiteOr(a?.routeMeters, Infinity), finiteOr(b?.routeMeters, Infinity)) ||
    byAscending(finiteOr(a?.offsetMeters, Infinity), finiteOr(b?.offsetMeters, Infinity)) ||
    byDescending(finiteOr(a?.score, -Infinity), finiteOr(b?.score, -Infinity)) ||
    byAscending(finiteOr(a?.worseSideRms, Infinity), finiteOr(b?.worseSideRms, Infinity))
  );
}

/**
 * 在同一个候选池上应用一条选优规则（方案 §6.3：规则对所有案例一致）。
 *
 * @param {Array<object>} candidates 候选池（元素形如 { result, score, sizeMeters, center }）
 * @param {'current'|'tolerance'|'costFirst'} [rule] 规则名
 * @param {object} [options]
 * @param {number} [options.tolerance] 统一容差规则的相对 RMS 容差
 * @param {{lat: number, lng: number}|null} [options.origin] 请求中心（偏移基准）
 * @param {boolean} [options.applyQualityGate] 是否先过质量门（默认 true）
 * @param {boolean} [options.allowFallback] 没有合格候选时是否退回全部候选（默认 true）
 * @returns {{selected: object|null, metrics: object|null, pool: Array<object>,
 *   passingCount: number, fallbackUsed: boolean}|null}
 */
export function selectByRule(candidates, rule = 'current', options = {}) {
  const {
    tolerance = 0.1,
    origin = null,
    applyQualityGate = true,
    allowFallback = true,
  } = options;
  const all = (Array.isArray(candidates) ? candidates : []).filter(Boolean);
  if (all.length === 0) {
    return null;
  }
  const passing = applyQualityGate
    ? all.filter((candidate) => meetsQualityBar(candidate?.result?.metrics ?? candidate?.metrics ?? null))
    : all;
  const pool = passing.length > 0 || !allowFallback ? passing : all;
  if (pool.length === 0) {
    return null;
  }
  const enriched = pool.map((candidate) => ({ candidate, ...candidateCostMetrics(candidate, { origin }) }));
  let sorted;
  if (rule === 'tolerance') {
    sorted = [...enriched].sort((a, b) => compareByUnifiedTolerance(a, b, { tolerance }));
  } else if (rule === 'costFirst') {
    sorted = [...enriched].sort(compareByCostFirst);
  } else if (rule === 'scoreTier') {
    // 生产规则（Bug 3 修复）：分数分档 → 档内"近且像"。池序 = 选中者置首，
    // 其余按分档比较器（分数明显更高者靠前，同档按 RMS）
    const selected = selectPassingByScoreTier(pool);
    sorted = selected
      ? [
          enriched.find((entry) => entry.candidate === selected) ?? { candidate: selected, ...candidateCostMetrics(selected, { origin }) },
          ...[...enriched].filter((entry) => entry.candidate !== selected).sort((a, b) => compareCandidatesWithScoreTier(a.candidate, b.candidate)),
        ]
      : [];
  } else {
    sorted = [...enriched].sort((a, b) => comparePassingCandidates(a.candidate, b.candidate));
  }
  return {
    selected: sorted[0]?.candidate ?? null,
    metrics: sorted[0] ?? null,
    pool: sorted,
    passingCount: passing.length,
    fallbackUsed: passing.length === 0 && allowFallback,
  };
}
