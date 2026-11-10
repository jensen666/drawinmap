/**
 * 自由轮廓点数口径（方案 2026-11-05 §7.2）。
 *
 * 此前生成提示写「每部分最多 240 点」，验收却按「每部分 120 点」执行——
 * 两处口径可直接核对且互相矛盾，导致模型被要求产出验收必然拒收的点列
 * （12 次复杂轮廓恢复只有 2 次满足点数区间）。
 *
 * 本模块是**唯一口径来源**：生成提示、修正提示与点数验收都从这里取数，
 * 提示永远不会要求验收必然拒收的点列。验收闸门本身不放宽
 * （上限仍是每部分 120 点），只把提示改到与闸门一致。
 */

/** 复杂剪影判定门槛：LLM 声明特征（kind==='declared'）的最小个数 */
export const FREEFORM_COMPLEX_FEATURE_MIN = 3;
/** 复杂自由剪影总点数下限（含）——生成/修正提示按它要求，验收分级放行的硬门 */
export const FREEFORM_COMPLEX_POINT_MIN = 80;
/**
 * 分级放行下限（含，缺陷清单 2026-11-06 Bug 4.2）：复杂剪影点数在
 * [RELAXED_MIN, 80) 时不再一票否决——视觉质检明确 like 且约束全过就允许进入
 * 正式规划，由贴路质量分与质检裁决准确性；质检结论不像/不可用时仍按 80 硬门拒绝。
 * 依据：2026-11-04 的 40 例统计里 22 次拒绝中 17 次是点数门（78/77/73/68 点差几点
 * 被拒），点数少 2~12 个与"像不像"没有本质关系；60 以下仍硬拒（下限不无限放宽）。
 */
export const FREEFORM_COMPLEX_POINT_RELAXED_MIN = 60;
/** 复杂自由剪影**每部分**点数上限（含） */
export const FREEFORM_COMPLEX_POINT_MAX = 120;
/** 简单图形的生成提示点数下限（只作提示，不用于拒收） */
export const FREEFORM_SIMPLE_POINT_MIN = 8;
/** 简单图形的生成提示点数上限（只作提示，不用于拒收） */
export const FREEFORM_SIMPLE_POINT_MAX = 20;

/**
 * 点数上限（按部分数放宽）。
 *
 * @param {number} partCount 部分数（缺省 1）
 * @returns {number} 总点数上限
 */
export function freeformPointMax(partCount = 1) {
  const parts = Number.isFinite(partCount) && partCount >= 1 ? Math.floor(partCount) : 1;
  return FREEFORM_COMPLEX_POINT_MAX * parts;
}

/**
 * 生成/修正提示共用的点数规则文本（与验收闸门同源）。
 *
 * @returns {string} 提示片段
 */
export function freeformPointRuleText() {
  return (
    `复杂剪影（features 里声明特征不少于 ${FREEFORM_COMPLEX_FEATURE_MIN} 个）` +
    `${FREEFORM_COMPLEX_POINT_MIN}~${FREEFORM_COMPLEX_POINT_MAX} 点，` +
    `简单图形（声明特征少于 ${FREEFORM_COMPLEX_FEATURE_MIN} 个）` +
    `${FREEFORM_SIMPLE_POINT_MIN}~${FREEFORM_SIMPLE_POINT_MAX} 点，` +
    `每部分最多 ${FREEFORM_COMPLEX_POINT_MAX} 点`
  );
}
