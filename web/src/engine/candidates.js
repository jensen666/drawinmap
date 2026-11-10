/**
 * 候选选址与校核导出门面（清理方案 2026-11-09 C3 拆分后保持既有 import 路径兼容）。
 *
 * 实现按职责拆到三个模块（纯移动，行为零变化）：
 * - candidate-search.js：单轮候选搜索 + 四级尽力链（含精修/联合精修编排）；
 * - refine-around.js：局部精修（细格点再搜一轮）；
 * - recommend-shapes.js：多图形实测推荐。
 * 评分与质量门槛的唯一实现在 quality.js（此处沿用导出，agent 层与既有测试仍经此处取）。
 */

export {
  ESCALATION_STAGES,
  GOOD_ENOUGH_SCORE,
  SINGLE_SEARCH_TIME_BUDGET_MS,
  MIN_FEATURE_METERS,
  NEAR_FIELD_MAX_SIZE_FACTOR,
  searchBestCandidate,
} from './candidate-search.js';

export { searchWithEscalation } from './escalation.js';

export {
  RECOMMEND_MAX_CANDIDATES,
  RECOMMEND_TIME_BUDGET_MS,
  recommendShapes,
} from './recommend-shapes.js';

/** 质量门槛的沿用导出：agent 层与既有测试仍经此处取这两个函数，实现唯一源在 quality.js */
export { meetsQualityBar, scoreRoute } from './quality.js';
