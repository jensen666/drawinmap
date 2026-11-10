/**
 * 失败路径的近失精修（清理方案 2026-11-09 C3：从 candidates.js 的
 * searchWithEscalation 失败路径纯移动拆出，行为与顺序保持原样）。
 *
 * 没有达标候选、但存在"只差一道软门槛"的近失候选时，失败前用联合精修换一次
 * 吸附组合/单段档位（多候选吸附可能把它救过门槛）：
 * - 救回来（精修后过质量门槛）→ 返回 status:'ok'（stageLabel '联合精修'）；
 * - 精修后仍不达标 → 如实返回 status:'failed'，但 best/bestOverall 更新为精修后的
 *   真实最好成绩，让失败诊断反映这条链路实际达到的水平；
 * - 联合精修未改进/异常 → 返回 null，由调用方继续走"全部失败"出口。
 *
 * 预算累计原地写入 budget（{triedCount, expandedTotal}），与粗搜/局部精修同口径。
 */

import { qualityGateReport, meetsQualityBar } from './quality.js';
import { adjustedScoreOf } from './selection.js';
import { DEFAULT_MAX_EVALUATIONS, jointRefine } from './joint-refine.js';
import { createLogger } from '../log/index.js';

const log = createLogger('engine/candidates');

/**
 * 对近失候选做一次联合精修，并在需要时给出交付/失败结论。
 *
 * @param {object} options
 * @param {object} options.graph 步行路网图
 * @param {object} options.edgeIndex 道路线段索引
 * @param {string} [options.shapeKey] 内置图形标识
 * @param {object|null} [options.customShape] 自定义图形
 * @param {{lat: number, lng: number}} options.center 请求中心（调整分偏移基准）
 * @param {object} options.bestNearMiss 近失候选（含 result/score/adjustedScore/center/sizeMeters/rotationDeg/stage/stageLabel）
 * @param {object|null} options.nearBest 近场证据候选（原样带回结果对象，不改写）
 * @param {{stage: number, stageLabel: string}} options.lastStage 最后一级搜索阶段
 * @param {{triedCount: number, expandedTotal: number}} options.budget 共享预算计数器（原地累加）
 * @param {number|null} [options.deadline] 整轮截止（performance.now() 口径），null 不限
 * @param {(progress: object) => void} [options.onProgress] 进度回调
 * @param {AbortSignal|null} [options.signal] 用户停止信号
 * @returns {Promise<object|null>} 交付/失败结果对象；null = 联合精修未改进或异常
 */
export async function refineNearMiss({
  graph,
  edgeIndex,
  shapeKey,
  customShape,
  center,
  bestNearMiss,
  nearBest,
  lastStage,
  budget,
  deadline,
  onProgress,
  signal,
}) {
  const beforeMetrics = bestNearMiss.result.metrics;
  const beforeReport = qualityGateReport(beforeMetrics);
  let joint = null;
  try {
    joint = await jointRefine({
      graph,
      edgeIndex,
      shapeKey,
      customShape,
      base: {
        result: bestNearMiss.result,
        score: bestNearMiss.score,
        adjustedScore: bestNearMiss.adjustedScore,
        center: bestNearMiss.center,
        sizeMeters: bestNearMiss.sizeMeters,
        rotationDeg: bestNearMiss.rotationDeg,
        metrics: bestNearMiss.result.metrics,
      },
      origin: center,
      deadline,
      maxEvaluations: DEFAULT_MAX_EVALUATIONS,
      onProgress,
      signal,
    });
  } catch (error) {
    // 联合精修异常不改变"诚实失败"的结论，只影响诊断细节
    log.warn('candidates.nearMiss.joint.error', {
      message: error?.message ?? String(error),
    });
  }
  if (!joint) {
    return null;
  }
  budget.triedCount += joint.evaluated;
  budget.expandedTotal += joint.expandedNodes || 0;
  const afterMetrics = joint.best?.metrics ?? joint.best?.result?.metrics;
  const afterReport = afterMetrics ? qualityGateReport(afterMetrics) : null;
  log.info('candidates.nearMiss.joint', {
    stage: bestNearMiss.stage,
    stageLabel: bestNearMiss.stageLabel,
    improved: joint.improved,
    evaluations: joint.evaluated,
    scoreBefore: bestNearMiss.score,
    scoreAfter: joint.best?.score ?? null,
    softCountBefore: beforeReport.softCount,
    softCountAfter: afterReport?.softCount ?? null,
    frechetBefore: beforeMetrics?.frechetMaxRatio ?? null,
    frechetAfter: afterMetrics?.frechetMaxRatio ?? null,
    passesAfter: afterMetrics ? meetsQualityBar(afterMetrics) : false,
  });
  if (!(joint.improved && joint.best?.result)) {
    return null;
  }
  const refinedCandidate = {
    result: joint.best.result,
    score: joint.best.score,
    adjustedScore: adjustedScoreOf(joint.best.score, bestNearMiss.center, center),
    center: bestNearMiss.center,
    sizeMeters: bestNearMiss.sizeMeters,
    rotationDeg: bestNearMiss.rotationDeg,
  };
  if (afterMetrics && meetsQualityBar(afterMetrics)) {
    // 救回来了：仍须过质量门槛才算交付，不把"差一点"当成功
    log.info('candidates.nearMiss.rescued', {
      scoreBefore: bestNearMiss.score,
      scoreAfter: refinedCandidate.score,
      adjustedScore: refinedCandidate.adjustedScore,
      sizeMeters: refinedCandidate.sizeMeters,
      rotationDeg: refinedCandidate.rotationDeg,
      evaluations: joint.evaluated,
      triedCount: budget.triedCount,
    });
    return {
      status: 'ok',
      best: refinedCandidate,
      alternatives: [],
      bestOverall: refinedCandidate,
      // 近场证据保持第一级记录，精修救回也不改写
      nearBest,
      stage: 5,
      stageLabel: '联合精修',
      triedCount: budget.triedCount,
      budgetExhausted: false,
      aborted: false,
    };
  }
  // 精修后仍不达标：如实失败，但 best/bestOverall 更新为精修后的真实最好成绩，
  // 让失败诊断（最接近的偏差/评分）反映这条链路实际达到的水平
  log.warn('candidates.nearMiss.still.failed', {
    scoreBefore: bestNearMiss.score,
    scoreAfter: refinedCandidate.score,
    softCountAfter: afterReport?.softCount ?? null,
    frechetAfter: afterMetrics?.frechetMaxRatio ?? null,
    evaluations: joint.evaluated,
    triedCount: budget.triedCount,
  });
  return {
    status: 'failed',
    best: refinedCandidate,
    bestOverall: refinedCandidate,
    // 近场证据保持第一级记录（精修后的成绩只影响 best/bestOverall）
    nearBest,
    stage: lastStage.stage,
    stageLabel: lastStage.stageLabel,
    triedCount: budget.triedCount,
    budgetExhausted: false,
    aborted: false,
  };
}
