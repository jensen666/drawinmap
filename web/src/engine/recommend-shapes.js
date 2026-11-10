/**
 * 多图形实测推荐（清理方案 2026-11-09 C3：从 candidates.js 纯移动拆出，行为零变化）。
 *
 * 只给条件（地点/时间）时，对多种内置图形分别跑逐级候选搜索，跨级选优，
 * 只推荐真实路网上画得出来的图形。
 */

import { SHAPES } from './shapes.js';
import { meetsQualityBar, scoreRoute } from './quality.js';
import { compareCandidatesWithScoreTier, adjustedScoreOf } from './selection.js';
import { jointRefine } from './joint-refine.js';
import { createLogger } from '../log/index.js';
import { isAborted } from '../cancel.js';
import {
  ESCALATION_STAGES,
  NEAR_FIELD_MAX_SIZE_FACTOR,
  searchBestCandidate,
} from './candidate-search.js';
import { refineAround } from './refine-around.js';

/** 模块 logger：推荐阶段汇总（与候选搜索同属 engine/candidates 模块，便于按模块过滤） */
const log = createLogger('engine/candidates');

/** 三图形推荐合计默认预算。三种图形都走完四级 7×7 网格时大约 1.1 万个候选。 */
export const RECOMMEND_MAX_CANDIDATES = 14000;
export const RECOMMEND_TIME_BUDGET_MS = 300000;

/** 推荐链路局部精修的候选数预留（最多 3 个图形 × 45 个精修候选 = 135）。 */
const REFINE_CANDIDATES_PER_SHAPE_SET = 135;

/**
 * 只给条件（地点/时间）时的实测推荐（分片异步、合计双重预算）：对多种内置图形
 * 分别跑逐级候选搜索，跨级选优，只推荐真实路网上画得出来的图形。
 *
 * @param {object} options
 * @param {{nodes: Map, adj: Map}} options.graph 步行路网图
 * @param {{grid: Map, cell: number, edges: Array}} options.edgeIndex 道路线段索引
 * @param {{lat: number, lng: number}} options.center 搜索中心
 * @param {Object<string, number>} options.shapeSizes 各图形基准尺寸（米）
 * @param {boolean} [options.allowEnlarge] 是否允许比例尺兜底级（false 时尺寸档位封顶近场上限）
 * @param {number} [options.timeBudgetMs] 合计时间预算（毫秒）
 * @param {number} [options.maxCandidates] 合计候选数硬上限
 * @param {number|null} [options.deadline] 外部整轮截止（performance.now() 口径），null 用本次预算
 * @param {(progress: object) => void} [options.onProgress] 进度回调（附 shapeKey/shapeName/stage）
 * @returns {Promise<{
 *   status: 'ok'|'failed',
 *   recommendations: Array<{shapeKey: string, shapeName: string, score: number, sizeMeters: number, rotationDeg: number, center: object, result: object}>,
 *   stage: number, stageLabel: string, triedCount: number, budgetExhausted: boolean,
 *   bests: Object<string, object|null>,
 *   nearBests: Object<string, object|null>
 * }>} 推荐集按评分降序；failed 时 recommendations 为空、bests 供诊断
 *   nearBests 为第一级（近场搜索）按图形另存的原始分最优候选（同 nearBest 结构，
 *   另带 shapeKey/shapeName），供偏移说明选取代表候选；后续级别与精修不会改写。
 */
export async function recommendShapes({
  graph,
  edgeIndex,
  center,
  shapeSizes,
  allowEnlarge = true,
  timeBudgetMs = RECOMMEND_TIME_BUDGET_MS,
  maxCandidates = RECOMMEND_MAX_CANDIDATES,
  deadline: externalDeadline = null,
  onProgress,
  signal = null,
}) {
  const shapeKeys = Object.keys(shapeSizes).filter((key) => SHAPES[key]);
  const deadline = Number.isFinite(externalDeadline)
    ? externalDeadline
    : performance.now() + timeBudgetMs;
  let triedCount = 0;
  let expandedTotal = 0;
  const bests = {};
  /** 第一级（近场）按图形另存的最好候选：偏移说明用它挑代表候选，后续级别与精修不得改写 */
  const nearBests = {};
  /** 各图形跨级最佳达标候选 */
  const bestPassingByShape = {};
  let lastStage = ESCALATION_STAGES[0];
  let budgetExhausted = false;
  /** 是否被用户"停止"中断 */
  let aborted = false;

  for (const stage of ESCALATION_STAGES) {
    // 用户点"停止"：立刻结束整条推荐链
    if (isAborted(signal)) {
      aborted = true;
      break;
    }
    if (triedCount >= maxCandidates || performance.now() >= deadline) {
      budgetExhausted = true;
      break;
    }
    lastStage = stage;
    for (const shapeKey of shapeKeys) {
      if (triedCount >= maxCandidates || performance.now() >= deadline) {
        budgetExhausted = true;
        break;
      }
      const {
        best,
        bestPassing,
        candidateCount,
        budgetExhausted: exhausted,
        aborted: shapeAborted,
        expandedNodes,
      } =
        await searchBestCandidate({
          graph,
          edgeIndex,
          shapeKey,
          center,
          baseSizeMeters: shapeSizes[shapeKey],
          sizeFactors: stage.sizeFactors,
          gridRadius: stage.gridRadius,
          spacingRatio: stage.spacingRatio,
          onProgress: onProgress
            ? (p) =>
                onProgress({
                  ...p,
                  shapeKey,
                  shapeName: SHAPES[shapeKey].name,
                  stage: stage.stage,
                  stageLabel: stage.label,
                  triedCount: triedCount + p.done,
                })
            : undefined,
          deadline,
          maxCandidates: maxCandidates - triedCount,
          signal,
          spacingBySize: stage.spacingBySize === true,
        });
      triedCount += candidateCount;
      expandedTotal += expandedNodes || 0;
      if (exhausted) {
        budgetExhausted = true;
      }
      if (shapeAborted) {
        aborted = true;
      }
      if (best) {
        // bests 记录该图形所有级别里评分最高者（供失败诊断）
        if (!bests[shapeKey] || best.score > bests[shapeKey].score) {
          bests[shapeKey] = best;
        }
      }
      // 近场证据：第一级搜索的 stage best 按图形另存（后续级别与精修不得改写）。
      // 第一级没搜到该图形时记 null；该图形若因预算未跑到第一级搜索则保持缺失。
      if (stage.stage === ESCALATION_STAGES[0].stage) {
        nearBests[shapeKey] = best
          ? {
              ...best,
              shapeKey,
              shapeName: SHAPES[shapeKey].name,
              stage: stage.stage,
              stageLabel: stage.label,
            }
          : null;
      }
      if (
        bestPassing &&
        (!bestPassingByShape[shapeKey] ||
          bestPassing.adjustedScore > bestPassingByShape[shapeKey].adjustedScore)
      ) {
        bestPassingByShape[shapeKey] = {
          shapeKey,
          shapeName: SHAPES[shapeKey].name,
          score: bestPassing.score,
          adjustedScore: bestPassing.adjustedScore,
          sizeMeters: bestPassing.sizeMeters,
          rotationDeg: bestPassing.rotationDeg,
          center: bestPassing.center,
          result: bestPassing.result,
          stage: stage.stage,
          stageLabel: stage.label,
        };
      }
      if (budgetExhausted) {
        break;
      }
    }
    const stagePassing = Object.values(bestPassingByShape);
    log.info('recommend.stage', {
      stage: stage.stage,
      stageLabel: stage.label,
      triedCount,
      passingCount: stagePassing.length,
      shapes: stagePassing.map((item) => ({
        shapeName: item.shapeName,
        score: item.score,
        adjustedScore: item.adjustedScore,
        sizeMeters: item.sizeMeters,
      })),
      budgetExhausted,
    });
    if (budgetExhausted) {
      break;
    }
  }

  // 局部精修：每个图形的入选候选周围用细格点再搜一轮（只赚不赔；预算守卫）。
  // 与粗搜共享 deadline 与工作量预算，避免三种图形各自精修把总耗时拖出预算。
  for (const entry of Object.values(bestPassingByShape)) {
    if (
      budgetExhausted ||
      triedCount + REFINE_CANDIDATES_PER_SHAPE_SET > maxCandidates ||
      performance.now() >= deadline ||
      isAborted(signal)
    ) {
      if (isAborted(signal)) {
        aborted = true;
      }
      break;
    }
    const refined = await refineAround({
      graph,
      edgeIndex,
      shapeKey: entry.shapeKey,
      customShape: null,
      base: entry,
      origin: center,
      // 禁止放大：精修尺寸不得越过该图形的近场最大档（NEAR_FIELD_MAX_SIZE_FACTOR × 图形基准尺寸）
      maxSizeMeters: allowEnlarge ? null : Math.round(shapeSizes[entry.shapeKey] * NEAR_FIELD_MAX_SIZE_FACTOR),
      deadline,
      onProgress,
      signal,
    });
    triedCount += refined.candidateCount;
    expandedTotal += refined.expandedNodes || 0;
    if (refined.best !== entry) {
      const r = refined.best;
      log.info('recommend.refine', {
        shapeName: entry.shapeName,
        before: { score: entry.score, adjustedScore: entry.adjustedScore },
        after: { score: r.score, adjustedScore: r.adjustedScore },
        sizeMeters: r.sizeMeters,
        rotationDeg: r.rotationDeg,
      });
      entry.result = r.result;
      entry.score = r.score;
      entry.adjustedScore = r.adjustedScore;
      entry.center = r.center;
      entry.sizeMeters = r.sizeMeters;
      entry.rotationDeg = r.rotationDeg;
      // 来源阶段口径（方案 2026-11-05 §5.2）：stage 保持粗搜级别不变，
      // 「局部精修」用 refined 表达——不再把 stage 改写成 4。
      entry.refined = true;
      entry.finalStageLabel = '局部精修';
    }
    // 联合精修：对入选候选做整图吸附/档位精修（共享预算与截止）
    if (!budgetExhausted && !isAborted(signal) && (deadline === null || performance.now() < deadline)) {
      const joint = await jointRefine({
        graph,
        edgeIndex,
        shapeKey: entry.shapeKey,
        customShape: null,
        base: {
          result: entry.result,
          score: entry.score,
          adjustedScore: entry.adjustedScore,
          center: entry.center,
          sizeMeters: entry.sizeMeters,
          rotationDeg: entry.rotationDeg,
          metrics: entry.result.metrics,
        },
        origin: center,
        deadline,
        onProgress,
        signal,
      });
      triedCount += joint.evaluated;
      expandedTotal += joint.expandedNodes;
      if (joint.improved) {
        const jointMetrics = joint.best.metrics ?? joint.best.result?.metrics;
        // 推荐给用户的候选必须仍过质量门槛；联合精修不改中心/尺寸，
        // 调整分按新分数与同一偏移重算（保持"近且像"排序口径一致）
        if (meetsQualityBar(jointMetrics)) {
          log.info('recommend.joint', {
            shapeName: entry.shapeName,
            before: { score: entry.score, adjustedScore: entry.adjustedScore },
            after: { score: joint.best.score },
            evaluations: joint.evaluated,
          });
          entry.result = joint.best.result;
          entry.score = joint.best.score;
          entry.adjustedScore = adjustedScoreOf(joint.best.score, entry.center, center);
          // stage 仍是粗搜来源级别；联合精修用 refined/finalStageLabel 表达
          entry.refined = true;
          entry.finalStageLabel = '联合精修';
        } else {
          log.warn('recommend.joint.rejected', {
            shapeName: entry.shapeName,
            reason: '联合精修结果未过质量门槛，保留原推荐候选',
            score: joint.best.score,
          });
        }
      }
    }
  }

  // 推荐排序与单图形交付同口径（缺陷清单 Bug 3/X15）：先分数分档（差 >3 分高分
  // 直接胜出），同档内再按更差一侧均方根——此前纯 RMS 排序会让分数明显更高的
  // 图形被 RMS 略差挤到后面（X15：矩形 84 分排在心形 82 分之后不被推荐）
  const recommendations = Object.values(bestPassingByShape).sort(
    (a, b) => compareCandidatesWithScoreTier(a, b),
  );
  if (recommendations.length > 0) {
    return {
      status: 'ok',
      recommendations,
      stage: recommendations[0].stage,
      stageLabel: recommendations[0].stageLabel,
      triedCount,
      budgetExhausted,
      aborted,
      bests,
      // 近场证据：第一级按图形记录，后续级别与精修未改写
      nearBests,
    };
  }

  return {
    status: 'failed',
    recommendations: [],
    stage: lastStage.stage,
    stageLabel: lastStage.stageLabel,
    triedCount,
    budgetExhausted,
    aborted,
    bests,
    // 近场证据：全部失败时也带上（代表候选可能为 null/缺失）
    nearBests,
  };
}

