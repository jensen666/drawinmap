/**
 * 规划结果指标汇总（自 planner.js 拆出，缺陷 D3 单点化）。
 *
 * 背景：planner.js 的"吸附硬门槛短路"分支此前手抄了 57 个 metrics 字段，正常分支用
 * `...ordered` / `...fidelity` 展开，两处字段集逐渐漂移——短路分支缺
 * orderedOutlineRms / orderedRouteRms / snapSource / snapOverrideCount / legProfileCount，
 * 落无路区/水面的候选在排序与诊断时读到 undefined，与正常候选不同口径。
 *
 * 现在两个分支共用本文件的 assembleMetrics：短路 = 空路线走同一汇总
 * （fidelity/ordered 传空路线版本），键集合与正常分支完全一致。
 * 单独成文件也让 planner.js 回到行数闸门内（≤500 行规范 + 豁免上限）。
 */

import { reusedEdgeRatio } from './route-topology.js';

/**
 * 汇总一套规划 metrics（正常分支与吸附短路分支共用）。
 *
 * @param {object} input 汇总输入
 * @param {number} input.shapePerimeterMeters 形状周长（米）
 * @param {number} input.routeMeters 路线总长（米）
 * @param {number} input.walkSpeed 步行速度（米/秒），用于换算步行时间
 * @param {Array<{distance: number, key?: boolean}>} input.snapped 约束点吸附结果
 * @param {number} input.validCount 吸附成功的约束点数
 * @param {number} input.constraintCount 参与规划的约束点数（合并后 kept 数）
 * @param {number} input.partCount 图形部分数
 * @param {number} input.failedLegs 失败段数
 * @param {number} input.routePointCount 路线点数
 * @param {number} input.keyPointCount 关键点总数
 * @param {number} input.keptKeyCount 保留下来的关键点数（覆盖率分子）
 * @param {number} input.collapsedKeyCount 塌缩关键点数
 * @param {number} input.sizeMeters 图形尺寸（米）
 * @param {Array|null} input.snapOverrides 多候选吸附覆盖（联合精修）
 * @param {Array|null} input.legProfiles 单段引导档位覆盖（联合精修）
 * @param {number} input.featureCount 可检查特征数
 * @param {number} input.featureCoveredCount 特征走出数
 * @param {number} input.featureMaxOffsetMeters 特征最大偏差（米）
 * @param {number} input.featureMinWidthRatio 最小特征宽度比例
 * @param {number} input.aspectDistortionRatio 整体比例失真
 * @param {number} input.featureGapRetainRatio 特征间隙保留率
 * @param {object} input.ordered 有序分段贴合指标（orderedFidelity 输出）
 * @param {object} input.fidelity 全局贴合指标（shapeFidelity / multiPartFidelity 输出）
 * @param {number} input.reusedEdgeCount 段间复用边数
 * @param {number} input.reusedEdgeMeters 段间复用米数
 * @param {{expandedNodes: number, relaxedEdges: number, prunedNodes: number, cappedLegs: number}} input.searchStats 寻路统计
 * @returns {object} 规划结果 metrics
 */
export function assembleMetrics(input) {
  const {
    shapePerimeterMeters,
    routeMeters,
    walkSpeed,
    snapped,
    validCount,
    constraintCount,
    partCount,
    failedLegs,
    routePointCount,
    keyPointCount,
    keptKeyCount,
    collapsedKeyCount,
    sizeMeters,
    snapOverrides,
    legProfiles,
    featureCount,
    featureCoveredCount,
    featureMaxOffsetMeters,
    featureMinWidthRatio,
    aspectDistortionRatio,
    featureGapRetainRatio,
    ordered,
    fidelity,
    reusedEdgeCount,
    reusedEdgeMeters,
    searchStats,
  } = input;
  const snapDistances = snapped
    .map((item) => item.distance)
    .filter((distance) => Number.isFinite(distance));
  const snapAvgMeters = snapDistances.length
    ? snapDistances.reduce((sum, value) => sum + value, 0) / snapDistances.length
    : 0;
  const snapMaxMeters = snapDistances.length ? Math.max(...snapDistances) : 0;
  const keySnapDistances = snapped.filter((item) => item.key).map((item) => item.distance);
  const keyMaxOffsetMeters = keySnapDistances.length ? Math.max(...keySnapDistances) : 0;
  return {
    shapePerimeterMeters,
    routeMeters,
    walkMinutes: routeMeters / walkSpeed / 60,
    snapAvgMeters,
    snapMaxMeters,
    coverage: (validCount / snapped.length) * 100,
    constraintCount,
    partCount,
    failedLegs,
    routePointCount,
    detourRatio: shapePerimeterMeters > 0 ? routeMeters / shapePerimeterMeters : 0,
    // 关键点：数量、覆盖（缺失即 <1）、塌缩、最大吸附偏移（尺寸归一化）
    keyPointCount,
    keyCoverage: keyPointCount > 0 ? keptKeyCount / keyPointCount : 1,
    collapsedKeyCount,
    keyMaxOffsetMeters,
    keyMaxOffsetRatio: keyMaxOffsetMeters / sizeMeters,
    // 吸附来源与单段档位（联合精修可复现：哪些约束用了第 N 近边、哪些段换了档位）
    snapSource: snapOverrides ? 'mixed' : 'nearest',
    snapOverrideCount: snapOverrides ? snapOverrides.filter(Boolean).length : 0,
    legProfileCount: legProfiles ? legProfiles.filter(Boolean).length : 0,
    // 细节特征（凹口/窄间隙）：数量、走出覆盖、最大偏差、最小特征宽度（尺寸反推用）
    featureCount,
    featureCoveredCount,
    featureCoverage: featureCount > 0 ? featureCoveredCount / featureCount : 1,
    featureMaxOffsetMeters,
    featureMaxOffsetRatio: sizeMeters > 0 ? featureMaxOffsetMeters / sizeMeters : Number.POSITIVE_INFINITY,
    featureMinWidthRatio,
    // 双重评价补充：整体比例失真 + 特征间隙保留率（路线是否跨过腿间隙）
    aspectDistortionRatio,
    featureGapRetainRatio,
    // 有序分段贴合（评分与门槛主指标）+ 全局对照
    ...ordered,
    ...fidelity,
    // 段间复用诊断：默认启用惩罚后仍复用（不降为 0）说明路网几何逼着折返，
    // 供排查"绕路变大/掉分"是惩罚过强还是路网无替代边
    reusedEdgeCount,
    reusedEdgeMeters,
    // 重复道路比例（reusedEdgeMeters ÷ routeMeters）：诊断指标，阶段 0 只记录不设门
    reusedEdgeRatio: reusedEdgeRatio({ reusedEdgeMeters, routeMeters }),
    searchStats,
  };
}
