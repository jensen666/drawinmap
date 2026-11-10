/**
 * 多比例尺候选池构建（需求 2026-11-09 多比例尺候选展示，方案同日 §2）。
 *
 * 一次规划在真实路网上按多比例尺实测会得到多个达标候选；本模块把编排层手里的
 * `best + alternatives`（引擎达标池的全量透出，不重搜）整理成"按比例尺去重、
 * 升序、可交付"的候选卡片池。纯函数、不碰 DOM、不发请求：
 *
 * - 只收"可交付"的候选：路线可画（≥2 点）、路线贴合 ≥ 交付闸门、质量门槛全过、
 *   且满足用户显式尺寸/朝向约束（沿用原契约口径复核）；
 * - 同一比例尺档多个位置/朝向变体只留一版（档内按"近且像"比较器取最优），
 *   变体差异通过中心偏移体现；
 * - 档位按尺寸升序；超过展示上限时当前交付版必在、其余按与当前版尺寸接近程度
 *   保留，界面上告知未展示档数。
 *
 * 目标验收只有合格/不合格结论，不进卡片指标；卡片不编造任何数值。
 */

import { DELIVERABLE_SCORE, meetsQualityBar } from '../engine/quality.js';
import { evaluateConstraintContract } from '../engine/constraint-contract.js';
import { comparePassingCandidates } from '../engine/selection.js';
import { distanceMeters } from '../engine/graph.js';

/** 卡片展示上限（需求 R4）：超过时当前交付版必在，其余按尺寸接近度保留 */
export const SCALE_CANDIDATE_DISPLAY_LIMIT = 6;

/** 中心偏移说明阈值（米）：沿用交付/备选切换回复的既有口径（>800m 才说） */
export const SCALE_OFFSET_NOTE_METERS = 800;

/**
 * 比例尺档位键：精修不改尺寸，同档候选尺寸一致；10m 粒度吸收浮点噪声。
 *
 * @param {number} sizeMeters 候选尺寸
 * @returns {number} 档位键（10m 整数倍）
 */
function scaleTierKey(sizeMeters) {
  return Math.round(Number(sizeMeters) / 10) * 10;
}

/**
 * 候选是否"可交付"（能进卡片、也能被点选切换交付）：路线可画 + 过交付闸门 +
 * 过质量门槛 + 满足显式约束契约。与绿线交付、备选切换用同一套口径。
 *
 * @param {object} candidate 引擎候选（{result, score, sizeMeters, rotationDeg, center}）
 * @param {object|null} constraintContract 显式约束契约（可空）
 * @returns {boolean} 是否可交付
 */
export function isDeliverableScaleCandidate(candidate, constraintContract = null) {
  if (!candidate || !candidate.result) {
    return false;
  }
  if (!Array.isArray(candidate.result.routeLatLngs) || candidate.result.routeLatLngs.length < 2) {
    return false;
  }
  if (!Number.isFinite(candidate.score) || candidate.score < DELIVERABLE_SCORE) {
    return false;
  }
  if (!candidate.result.metrics || !meetsQualityBar(candidate.result.metrics)) {
    return false;
  }
  if (!Number.isFinite(candidate.sizeMeters) || candidate.sizeMeters <= 0) {
    return false;
  }
  if (constraintContract) {
    const compliance = evaluateConstraintContract(constraintContract, {
      sizeMeters: candidate.sizeMeters,
      rotationDeg: candidate.rotationDeg,
    });
    if (!compliance.ok) {
      return false;
    }
  }
  return true;
}

/**
 * 由候选构建一张卡片（controller 内存形态，带 result 几何引用）。
 *
 * @param {object} candidate 引擎候选
 * @param {string} id 卡片 id
 * @returns {object} 卡片
 */
export function buildScaleCard(candidate, id) {
  const metrics = candidate.result.metrics;
  return {
    id,
    // 数值型指标：卡片展示与点选切换交付共用同一份
    sizeMeters: candidate.sizeMeters,
    rotationDeg: candidate.rotationDeg ?? 0,
    center: candidate.center ? { lat: candidate.center.lat, lng: candidate.center.lng } : null,
    score: candidate.score,
    routeMeters: Number.isFinite(metrics.routeMeters) ? metrics.routeMeters : null,
    walkMinutes: Number.isFinite(metrics.walkMinutes) ? metrics.walkMinutes : null,
    meanMeters: Number.isFinite(metrics.orderedOutlineMeanMeters) ? metrics.orderedOutlineMeanMeters : null,
    maxMeters: Number.isFinite(metrics.orderedOutlineMaxMeters) ? metrics.orderedOutlineMaxMeters : null,
    coverage: Number.isFinite(metrics.coverage) ? metrics.coverage : null,
    featureCount: Number.isFinite(metrics.featureCount) ? metrics.featureCount : 0,
    featureCoveredCount: Number.isFinite(metrics.featureCoveredCount) ? metrics.featureCoveredCount : 0,
    // 路线几何引用：点选切换时直接 commitDraw，不重新规划
    result: candidate.result,
  };
}

/**
 * 卡片摘要（会话消息持久化形态）：去掉 result 几何，只留展示与核对所需数字。
 *
 * @param {object} card 卡片
 * @returns {object} 摘要
 */
export function buildScaleCardSummary(card) {
  const { result, ...summary } = card;
  void result;
  return summary;
}

/**
 * 构建比例尺卡片数组（去重 + 升序 + 截断）。
 *
 * @param {object} options
 * @param {Array<object>} options.candidates 候选数组（best + alternatives）
 * @param {object|null} [options.constraintContract] 显式约束契约
 * @param {object|null} [options.current] 当前交付候选（截断时必在展示中）
 * @param {string} [options.idPrefix='sc'] 卡片 id 前缀
 * @param {number} [options.limit=SCALE_CANDIDATE_DISPLAY_LIMIT] 展示上限
 * @returns {{cards: Array<object>, hiddenCount: number, rawCount: number, tierCount: number}}
 *   卡片、未展示档数、去重前可交付候选数（rawCount）、去重后档位数（tierCount）
 */
export function buildScaleCards({
  candidates,
  constraintContract = null,
  current = null,
  idPrefix = 'sc',
  limit = SCALE_CANDIDATE_DISPLAY_LIMIT,
}) {
  const pool = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
  const deliverable = pool.filter((candidate) => isDeliverableScaleCandidate(candidate, constraintContract));
  // 按比例尺档去重：档内保留"近且像"最优一版（同一比较器口径）
  const tierMap = new Map();
  for (const candidate of deliverable) {
    const key = scaleTierKey(candidate.sizeMeters);
    const existing = tierMap.get(key);
    if (current && candidate.result === current.result) {
      // 当前交付版优先：同档点选回当前版时不得变成重绘另一变体
      tierMap.set(key, candidate);
    } else if (!existing || (existing.result !== current?.result && comparePassingCandidates(candidate, existing) < 0)) {
      tierMap.set(key, candidate);
    }
  }
  const sorted = [...tierMap.values()].sort((a, b) => a.sizeMeters - b.sizeMeters);
  const tierCount = sorted.length;
  const currentCardIndex = current
    ? sorted.findIndex((candidate) => candidate.result === current.result
      || scaleTierKey(candidate.sizeMeters) === scaleTierKey(current.sizeMeters))
    : -1;
  const currentCandidate = currentCardIndex >= 0 ? sorted[currentCardIndex] : null;
  const kept = applyDisplayLimit(sorted, currentCandidate, limit);
  const cards = kept.map((candidate, index) => buildScaleCard(candidate, `${idPrefix}-${index + 1}`));
  return { cards, hiddenCount: tierCount - kept.length, rawCount: deliverable.length, tierCount };
}

/**
 * 展示上限截断：当前交付版必在；其余按与当前版尺寸的接近程度优先保留（需求 R4）。
 *
 * @param {Array<object>} sorted 升序候选数组（引擎候选形态）
 * @param {object|null} currentCandidate 当前交付候选（可能不在数组里，防御性处理）
 * @param {number} limit 上限
 * @returns {Array<object>} 保留的候选（升序）
 */
function applyDisplayLimit(sorted, currentCandidate, limit) {
  const boundedLimit = Math.max(1, Math.floor(limit) || SCALE_CANDIDATE_DISPLAY_LIMIT);
  if (sorted.length <= boundedLimit) {
    return sorted;
  }
  const reference = currentCandidate ?? sorted[0];
  const rest = sorted.filter((candidate) => candidate !== currentCandidate);
  rest.sort(
    (a, b) =>
      Math.abs(a.sizeMeters - reference.sizeMeters) - Math.abs(b.sizeMeters - reference.sizeMeters),
  );
  const kept = currentCandidate
    ? [...rest.slice(0, boundedLimit - 1), currentCandidate]
    : rest.slice(0, boundedLimit);
  return kept.sort((a, b) => a.sizeMeters - b.sizeMeters);
}

/**
 * 重新截断既有卡片数组（点选/文字切换后当前版变化时调用）：
 * 把"当前版卡片"必进展示、其余按尺寸接近度保留。卡片已是展示形态（带 id）。
 *
 * @param {Array<object>} cards 现有卡片（升序）
 * @param {string|null} currentCardId 当前版卡片 id（找不到时只按上限截头）
 * @param {number} [limit] 上限
 * @returns {{cards: Array<object>, hiddenCount: number}} 截断后的卡片与未展示档数
 */
export function reapplyDisplayLimit(cards, currentCardId, limit = SCALE_CANDIDATE_DISPLAY_LIMIT) {
  const boundedLimit = Math.max(1, Math.floor(limit) || SCALE_CANDIDATE_DISPLAY_LIMIT);
  const list = Array.isArray(cards) ? cards.filter(Boolean) : [];
  if (list.length <= boundedLimit) {
    return { cards: list, hiddenCount: 0 };
  }
  const current = list.find((card) => card.id === currentCardId) ?? null;
  const rest = current ? list.filter((card) => card.id !== current.id) : list;
  if (current) {
    rest.sort(
      (a, b) =>
        Math.abs(a.sizeMeters - current.sizeMeters) - Math.abs(b.sizeMeters - current.sizeMeters),
    );
  }
  const kept = current ? [...rest.slice(0, boundedLimit - 1), current] : rest.slice(0, boundedLimit);
  kept.sort((a, b) => a.sizeMeters - b.sizeMeters);
  return { cards: kept, hiddenCount: list.length - kept.length };
}

/**
 * 两张卡片的中心偏移（米）；任一缺中心返回 null。
 *
 * @param {object} cardA 卡片
 * @param {object} cardB 卡片
 * @returns {number|null} 偏移米数
 */
export function scaleCardOffsetMeters(cardA, cardB) {
  if (!cardA?.center || !cardB?.center) {
    return null;
  }
  const meters = distanceMeters(cardA.center.lat, cardA.center.lng, cardB.center.lat, cardB.center.lng);
  return Number.isFinite(meters) ? meters : null;
}
