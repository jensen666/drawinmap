/**
 * 逐级尽力链（清理方案 2026-11-09 C3：从 candidates.js 经 candidate-search.js 纯移动拆出）。
 *
 * 职责：四级搜索（近场 → 扩大范围 → 比例尺兜底 → 更大比例尺）、跨级选优、
 * 局部精修与联合精修编排。失败路径的近失精修在 near-miss.js，选优规则在 selection.js。
 * 规则：跨级取两侧相对均方根的更差一侧（越小越贴）；四级都会搜；全部不达标时
 * 用近失候选做一次联合精修一搏（过质量门槛才算交付）。
 */

import { meetsQualityBar } from './quality.js';
import {
  comparePassingCandidates,
  compareCandidatesWithScoreTier,
  selectPassingByScoreTier,
  SCORE_TIER_TOLERANCE,
  adjustedScoreOf,
} from './selection.js';
import { DEFAULT_MAX_EVALUATIONS, jointRefine } from './joint-refine.js';
import { shapeErrorEnvelopeMeters } from './shape-envelope.js';
import { createLogger } from '../log/index.js';
import { isAborted } from '../cancel.js';
import {
  ESCALATION_STAGES,
  NEAR_FIELD_MAX_SIZE_FACTOR,
  REFINE_CANDIDATES_PER_CANDIDATE,
  SINGLE_SEARCH_MAX_CANDIDATES,
  SINGLE_SEARCH_TIME_BUDGET_MS,
  searchBestCandidate,
} from './candidate-search.js';
import { refineAround } from './refine-around.js';
import { refineNearMiss } from './near-miss.js';

/** 模块 logger：尽力链阶段汇总（与候选搜索同属 engine/candidates 模块，便于按模块过滤） */
const log = createLogger('engine/candidates');

/**
 * 逐级尽力搜索（分片异步、双重预算）：四级都会搜，不因近场够分跳过后续级；
 * 全部不达标时用近失候选做一次联合精修一搏（过质量门槛才算交付）。
 *
 * @param {object} options 同 searchBestCandidate，另支持：
 * @param {boolean} [options.allowEnlarge] 是否允许比例尺兜底级（false 时尺寸档位封顶近场上限）
 * @param {number} [options.timeBudgetMs] 时间预算（毫秒）
 * @param {number} [options.maxCandidates] 候选数硬上限
 * @param {boolean} [options.collectCandidates] 是否在返回值里带上全部达标候选池（对照实验用）
 * @param {object|null} [options.constraintContract] 显式约束契约：贯穿粗搜/精修/联合精修
 * @returns {Promise<object>} { status, best, bestOverall, nearBest, alternatives?, stage,
 *   stageLabel, triedCount, budgetExhausted }；nearBest 为近场原始分最优候选，后续不改写
 */
export async function searchWithEscalation({
  graph,
  edgeIndex,
  shapeKey,
  customShape = null,
  center,
  baseSizeMeters,
  rotations,
  allowEnlarge = true,
  timeBudgetMs = SINGLE_SEARCH_TIME_BUDGET_MS,
  maxCandidates = SINGLE_SEARCH_MAX_CANDIDATES,
  deadline: externalDeadline = null,
  onProgress,
  collectCandidates = false,
  signal = null,
  constraintContract = null,
}) {
  // 外部传入 deadline（整轮请求总截止）优先于本次预算：第二次规划/精修共享同一截止
  const deadline = Number.isFinite(externalDeadline)
    ? externalDeadline
    : performance.now() + timeBudgetMs;
  let triedCount = 0;
  /** 累计 A* 扩展节点数（跨级、跨轮共享的工作量预算） */
  let expandedTotal = 0;
  /** 各级最佳达标候选（跨级选优） */
  const passing = [];
  /** 各级最佳近失候选（全部不达标时，失败前交给联合精修一搏） */
  let bestNearMiss = null;
  /** 第一级（近场）搜索的原始分最优候选：偏移说明的近场证据，后续级别与精修不得改写 */
  let nearBest = null;
  let lastBest = null;
  let lastStage = ESCALATION_STAGES[0];
  let budgetExhausted = false;
  /** 是否被用户"停止"中断 */
  let aborted = false;

  for (const stage of ESCALATION_STAGES) {
    // 用户点"停止"：立刻结束整条尽力链（不再进入下一级搜索）
    if (isAborted(signal)) {
      aborted = true;
      break;
    }
    if (triedCount >= maxCandidates || performance.now() >= deadline) {
      budgetExhausted = true;
      break;
    }
    lastStage = stage;
    const {
      best,
      bestPassing: stagePassing,
      topPassing = [],
      topScorePassing: stageTopScore = [],
      bestNearMiss: stageNearMiss = null,
      candidateCount,
      budgetExhausted: exhausted,
      aborted: stageAborted,
      expandedNodes,
    } =
      await searchBestCandidate({
        graph,
        edgeIndex,
        shapeKey,
        customShape,
        center,
        baseSizeMeters,
        rotations,
        sizeFactors: stage.sizeFactors,
        gridRadius: stage.gridRadius,
        spacingRatio: stage.spacingRatio,
        onProgress: onProgress
          ? (p) => onProgress({ ...p, stage: stage.stage, stageLabel: stage.label, triedCount: triedCount + p.done })
          : undefined,
        deadline,
        maxCandidates: maxCandidates - triedCount,
        signal,
        spacingBySize: stage.spacingBySize === true,
        constraintContract,
      });
    triedCount += candidateCount;
    expandedTotal += expandedNodes || 0;
    if (exhausted) {
      budgetExhausted = true;
    }
    if (stageAborted) {
      aborted = true;
    }
    if (best) {
      lastBest = best;
    }
    // 近场证据：第一级搜索的 stage best 另存为 nearBest（原始分最优，不是达标最优），
    // 后续级别、局部精修、联合精修一律不得改写——偏移说明必须解释近场为什么失败。
    if (stage.stage === ESCALATION_STAGES[0].stage && best) {
      nearBest = { ...best, stage: stage.stage, stageLabel: stage.label };
      log.info('candidates.nearBest', {
        score: nearBest.score,
        adjustedScore: nearBest.adjustedScore,
        sizeMeters: nearBest.sizeMeters,
        rotationDeg: nearBest.rotationDeg,
        center: nearBest.center,
      });
    }
    // 汇总近失候选：跨级取"近且像"最优（调整分优先），失败前精修一次
    if (stageNearMiss && (!bestNearMiss || comparePassingCandidates(stageNearMiss, bestNearMiss) < 0)) {
      bestNearMiss = { ...stageNearMiss, stage: stage.stage, stageLabel: stage.label };
    }
    // 收集本级 top 达标候选（多候选精修用）：调整分靠后的达标候选也可能是
    // 精修潜力股，不能被"只留一个 bestPassing"直接淘汰
    const topResults = new Set(topPassing.map((candidate) => candidate.result));
    for (const candidate of topPassing) {
      const stamped = { ...candidate, stage: stage.stage, stageLabel: stage.label };
      passing.push(stamped);
    }
    // 缺陷清单 Bug 3：分数 top 3 也入池（按 result 去重）——保证"同池高分候选"
    // 能被 selectPassingByScoreTier 看到；只扩池不改选优规则
    for (const candidate of stageTopScore) {
      if (topResults.has(candidate.result)) {
        continue;
      }
      topResults.add(candidate.result);
      const stamped = { ...candidate, stage: stage.stage, stageLabel: stage.label };
      passing.push(stamped);
    }
    if (stagePassing && !topResults.has(stagePassing.result)) {
      const stamped = { ...stagePassing, stage: stage.stage, stageLabel: stage.label };
      passing.push(stamped);
    }
    if (stagePassing) {
      log.info('candidates.stage', {
        stage: stage.stage,
        stageLabel: stage.label,
        stageCandidates: candidateCount,
        triedCount,
        passed: true,
        best: {
          score: stagePassing.score,
          adjustedScore: stagePassing.adjustedScore,
          sizeMeters: stagePassing.sizeMeters,
          rotationDeg: stagePassing.rotationDeg,
        },
        nearMissScore: stageNearMiss?.score ?? null,
        bestOverallScore: best?.score ?? null,
        budgetExhausted,
      });
    } else {
      log.info('candidates.stage', {
        stage: stage.stage,
        stageLabel: stage.label,
        stageCandidates: candidateCount,
        triedCount,
        passed: false,
        nearMissScore: stageNearMiss?.score ?? null,
        nearMissAdjusted: stageNearMiss?.adjustedScore ?? null,
        bestOverallScore: best?.score ?? null,
        budgetExhausted,
      });
    }
    if (budgetExhausted) {
      break;
    }
  }

  if (budgetExhausted) {
    log.warn('candidates.budget.exhausted', {
      triedCount,
      maxCandidates,
      timeBudgetMs,
      stage: lastStage.stage,
      stageLabel: lastStage.stageLabel,
    });
  }

  // 最终交付选优（缺陷清单 2026-11-06 Bug 3 修复）：先按分数分档（与池最高分差
  // ≤ SCORE_TIER_TOLERANCE），档内再按"近且像"——准确性优先，同池分数明显更高的
  // 候选不得因相对 RMS 略差被跳过（N09 交付 70/同池 77、X14-ab 交付 74/同池 83）。
  const chosen = selectPassingByScoreTier(passing);
  const poolTopScore = passing.reduce((top, candidate) => (candidate?.score > top ? candidate.score : top), -Infinity);
  if (chosen) {
    // 多候选精修：按"近且像"（调整分优先）取前 3 个达标候选分别精修，
    // 最后统一用同一比较器选最优。只精修一个候选会漏掉精修潜力大的候选。
    // 精修共享粗搜的 deadline 与工作量预算，避免最后阶段超时卡页面。
    const refineBases = [...passing].sort(comparePassingCandidates).slice(0, 3);
    let final = chosen;
    let refinedTotal = 0;
    // 最终候选的来源标识（方案 2026-11-05 §5.2）：最终候选可能来自**另一个**精修基线，
    // 只用最终尺寸反推来源会错——这里显式记住是哪条基线精修出来的。
    let finalSource = {
      stage: chosen.stage,
      stageLabel: chosen.stageLabel,
      sizeMeters: chosen.sizeMeters,
      rotationDeg: chosen.rotationDeg,
      center: chosen.center,
      origin: 'coarse',
      refineBaseKey: null,
    };
    for (const base of refineBases) {
      if (
        budgetExhausted ||
        triedCount + REFINE_CANDIDATES_PER_CANDIDATE > maxCandidates ||
        (deadline !== null && performance.now() >= deadline) ||
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
        shapeKey,
        customShape,
        base,
        origin: center,
        // 禁止放大：精修尺寸不得越过近场最大档（NEAR_FIELD_MAX_SIZE_FACTOR × 基准尺寸）
        maxSizeMeters: allowEnlarge ? null : Math.round(baseSizeMeters * NEAR_FIELD_MAX_SIZE_FACTOR),
        deadline,
        onProgress,
        signal,
        constraintContract,
      });
      triedCount += refined.candidateCount;
      expandedTotal += refined.expandedNodes || 0;
      refinedTotal += refined.candidateCount;
      // 精修结果与当前最优按同一分档比较器比较（分差 > 容差高分胜出；同档内
      // "近且像"：调整分 → 原始分 → 尺寸）——低分精修版不得顶掉高分交付版（Bug 3）
      if (compareCandidatesWithScoreTier(refined.best, final) < 0) {
        final = refined.best;
        finalSource = {
          stage: base.stage,
          stageLabel: base.stageLabel,
          sizeMeters: base.sizeMeters,
          rotationDeg: base.rotationDeg,
          center: base.center,
          origin: 'refine',
          refineBaseKey: `${base.stage}:${base.sizeMeters}:${base.rotationDeg}`,
        };
      }
    }
    // 联合精修：多候选精修后再对最终候选做整图吸附/档位精修（共享预算与截止）。
    // 只对"最终选定的一个候选"做——多候选 × 联合精修会撑爆预算。
    let jointRefined = null;
    if (!budgetExhausted && !isAborted(signal) && (deadline === null || performance.now() < deadline)) {
      jointRefined = await jointRefine({
        graph,
        edgeIndex,
        shapeKey,
        customShape,
        base: {
          result: final.result,
          score: final.score,
          adjustedScore: final.adjustedScore,
          center: final.center,
          sizeMeters: final.sizeMeters,
          rotationDeg: final.rotationDeg,
          metrics: final.result.metrics,
        },
        origin: center,
        deadline,
        onProgress,
        signal,
      });
      triedCount += jointRefined.evaluated;
      expandedTotal += jointRefined.expandedNodes;
      if (jointRefined.improved) {
        // 联合精修不改中心/尺寸，调整分随原始分单调变化，直接按新分数重算；
        // 采纳前必须过质量门槛——联合精修后的未达标结果不能当交付。
        const jointMetrics = jointRefined.best.metrics ?? jointRefined.best.result?.metrics;
        const jointCandidate = {
          result: jointRefined.best.result,
          score: jointRefined.best.score,
          adjustedScore: adjustedScoreOf(jointRefined.best.score, final.center, center),
          center: final.center,
          sizeMeters: final.sizeMeters,
          rotationDeg: final.rotationDeg,
        };
        // joint-refine 的 improved 已保证"整图比较器更优"（同分时几何更好），
        // 采纳按分档比较器判定（同档内不劣于当前最优即可；分差超容差必须高分才采纳）
        if (meetsQualityBar(jointMetrics) && compareCandidatesWithScoreTier(jointCandidate, final) <= 0) {
          final = jointCandidate;
        }
      }
    }
    log.info('candidates.chosen', {
      // 粗搜来源阶段（方案 2026-11-05 §5.2）：stage 只表示粗搜级别，
      // 「是否精修」由 refined 单独表达——两者不再共用一个数。
      stage: chosen.stage,
      stageLabel: chosen.stageLabel,
      score: chosen.score,
      adjustedScore: chosen.adjustedScore,
      // 合格池选优可验证性（缺陷清单 Bug 3.5 + 2026-11-07 复核口径修正）：
      // chosenScore = 分档选优在**粗搜池**里选中的候选（断言口径：chosenScore ≥
      // poolTopScore − 容差）；selectedScore = 精修后的最终交付分（可高于池最高分，
      // 与 poolTopScore 不可比——此前 e2e 拿它断言，天然通过等于没验）。poolSample
      // 落池摘要供 A/B 复核"高分候选是否在池里"
      poolTopScore: Number.isFinite(poolTopScore) ? poolTopScore : null,
      chosenScore: chosen.score,
      selectedScore: final.score,
      passingCount: passing.length,
      poolSample: [...passing]
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map((candidate) => ({
          score: candidate.score,
          sizeMeters: candidate.sizeMeters,
          rotationDeg: candidate.rotationDeg,
          center: candidate.center,
        })),
      scoreTierTolerance: SCORE_TIER_TOLERANCE,
      refineCandidates: refineBases.length,
      refinedCandidates: refinedTotal,
      jointRefined: Boolean(jointRefined?.improved),
      jointEvaluations: jointRefined?.evaluated ?? 0,
      refined: final !== chosen,
      sourceSizeMeters: chosen.sizeMeters,
      sourceRotationDeg: chosen.rotationDeg,
      finalSource,
      finalStage: finalSource.stage,
      finalStageLabel: finalSource.stageLabel,
      finalScore: final.score,
      finalAdjustedScore: final.adjustedScore,
      sizeMeters: final.sizeMeters,
      rotationDeg: final.rotationDeg,
      center: final.center,
      triedCount,
      budgetExhausted,
    });
    return {
      status: 'ok',
      best: {
        result: final.result,
        score: final.score,
        adjustedScore: final.adjustedScore,
        center: final.center,
        sizeMeters: final.sizeMeters,
        rotationDeg: final.rotationDeg,
      },
      // 合格池选优可验证性（缺陷清单 Bug 3.5）：结果 JSON 直接带池最高分与交付分
      poolTopScore: Number.isFinite(poolTopScore) ? poolTopScore : null,
      selectedScore: final.score,
      passingCount: passing.length,
      // 多候选：各级达标候选（含不同尺寸/位置/朝向），供编排层展示
      // "更精细但更长 / 更简单但更近"的对比，让用户自己选；
      // 每条备选带形状绝对误差包络，便于对比实际贴合（方案 §9.2）
      alternatives: [
        ...passing
          .map((candidate) => ({
            result: candidate.result,
            score: candidate.score,
            adjustedScore: candidate.adjustedScore,
            center: candidate.center,
            sizeMeters: candidate.sizeMeters,
            rotationDeg: candidate.rotationDeg,
            stage: candidate.stage,
            stageLabel: candidate.stageLabel,
            envelopeMeters: shapeErrorEnvelopeMeters(candidate.result?.metrics),
          }))
          .filter(
            (candidate) => candidate.sizeMeters !== final.sizeMeters || candidate.result !== final.result,
          ),
      ],
      // 完整达标候选池（成本感知选优对照实验用；默认不返回，避免长期持有路线数据）
      ...(collectCandidates ? { passingCandidates: [...passing] } : {}),
      bestOverall: lastBest,
      // 近场证据：只在第一级记录、后续级别与精修未改写，供偏移说明使用
      nearBest,
      // 来源阶段口径（方案 2026-11-05 §5.2）：stage 只表示**粗搜来源级别**，
      // 局部精修不再把 stage 改写成 4——此前 stage=4 同时表示"第 4 级大比例尺"
      // 与"局部精修结果"，两者含义不同却共用一个数，导致报告无法判定来源阶段。
      stage: chosen.stage,
      stageLabel: chosen.stageLabel,
      // 是否精修、粗搜候选与最终候选分别记录：尺寸/阶段变化可回溯到具体来源
      refined: final !== chosen,
      sourceStage: chosen.stage,
      sourceStageLabel: chosen.stageLabel,
      sourceSizeMeters: chosen.sizeMeters,
      sourceRotationDeg: chosen.rotationDeg,
      sourceCenter: chosen.center,
      // 最终候选来源（可能来自另一条精修基线，不能只看最终尺寸反推）
      finalSource,
      finalStage: finalSource.stage,
      finalStageLabel: finalSource.stageLabel,
      finalSizeMeters: final.sizeMeters,
      triedCount,
      budgetExhausted,
      aborted,
    };
  }


  // 失败路径的近失精修：没有达标候选，但存在"只差一道软门槛"的近失候选时，
  // 失败前用联合精修换一次吸附组合/单段档位（多候选吸附可能把它救过门槛）。
  // 预算守卫与粗搜/局部精修同风格：候选数上限、deadline、扩展节点数共享。
  // C3 拆分：精修实现移至 near-miss.js（行为与顺序保持原样）。
  if (
    bestNearMiss &&
    !budgetExhausted &&
    !isAborted(signal) &&
    triedCount + DEFAULT_MAX_EVALUATIONS <= maxCandidates &&
    (deadline === null || performance.now() < deadline)
  ) {
    const budget = { triedCount, expandedTotal };
    const nearMissOutcome = await refineNearMiss({
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
    });
    triedCount = budget.triedCount;
    expandedTotal = budget.expandedTotal;
    if (nearMissOutcome) {
      return nearMissOutcome;
    }
  }

  log.warn('candidates.all.failed', {
    stage: lastStage.stage,
    stageLabel: lastStage.stageLabel,
    triedCount,
    budgetExhausted,
    bestScore: lastBest?.score ?? null,
    nearMissScore: bestNearMiss?.score ?? null,
    timeBudgetMs,
  });
  return {
    status: 'failed',
    best: lastBest,
    bestOverall: lastBest,
    // 近场证据：全部失败时也带上（近场没有任何成功候选则为 null）
    nearBest,
    stage: lastStage.stage,
    stageLabel: lastStage.stageLabel,
    triedCount,
    budgetExhausted,
    aborted,
  };
}

