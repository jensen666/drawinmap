/**
 * 尺寸轴大档阶段编排（方案 2026-11-01 §5.1~§5.3）。
 *
 * 职责：把「近场基线冻结 → 定向补搜大档 → 基线—候选集裁决 → 胜出档精修复检 →
 * 交付或回退」串成一段可独立测试的流程。裁决与复检的判定逻辑在
 * shape-envelope.js，补搜与回退链在 large-tier.js，本模块只做编排与日志。
 *
 * 三条硬规则（与方案一一对应）：
 * - 所有大档与**同一个**近场基线 B 比较（比较期间不更新 B）；
 * - 形状绝对误差包络只含三项米制指标，判定看包络最大值是否不劣；
 * - 胜出大档必须补做精修并重新过闸（分数更高 + 包络不劣 + 偏移不比基线更远），
 *   不过即回退到最近一个已验证版本；根本没有执行精修时保留近场基线。
 *
 * 精修与联合精修以回调注入（candidates.js 提供实现），本模块不依赖引擎的
 * 搜索实现，便于在 Node 里用受控输入验证回退链。
 */

import { distanceMeters } from '../../web/src/engine/graph.js';
import { meetsQualityBar } from '../../web/src/engine/quality.js';
import { isAborted } from '../../web/src/cancel.js';
import { createLogger } from '../../web/src/log/index.js';
import {
  LARGE_TIER_SIZE_FACTORS,
  adjudicateLargeTiers,
  finalizeLargeTier,
  probeLargeTiers,
  targetIdentityOf,
} from './large-tier.js';
import { shapeErrorEnvelopeMeters } from '../../web/src/engine/shape-envelope.js';
import { adjustedScoreOf } from '../../web/src/engine/selection.js';

/**
 * 模块 logger：尺寸轴大档阶段的裁决日志。
 * 事件名统一为 `candidates.largeTier.*`，与候选搜索的其它日志同属 engine/candidates
 * 模块——方案 §5.3 要求"全程记录"这条链路，按模块过滤时应当一次看全。
 */
const log = createLogger('engine/candidates');

/**
 * 尺寸轴大档阶段（§5.1~§5.3）：近场基线冻结 → 定向补搜大档 → 基线—候选集裁决 →
 * 胜出档精修复检 → 交付或回退。
 *
 * @param {object} options
 * @param {object} options.graph 步行路网图
 * @param {object} options.edgeIndex 道路线段索引
 * @param {string|null} options.shapeKey 内置图形标识
 * @param {object|null} options.customShape 自定义图形
 * @param {{lat: number, lng: number}} options.center 请求中心
 * @param {number} options.baseSizeMeters 原始基准尺寸（米）
 * @param {object} options.baseline 近场基线 B（已冻结）
 * @param {boolean} options.allowEnlarge 是否允许比例尺兜底级
 * @param {number|null} options.deadline 整轮截止（与粗搜共享）
 * @param {number|null} options.maxCandidates 候选数硬上限（与粗搜共享）
 * @param {AbortSignal|null} options.signal 用户停止信号
 * @param {(progress: object) => void} options.onProgress 进度回调
 * @param {Set<string>} options.evaluatedKeys 已评价候选去重键（跨级共享）
 * @param {{triedCount: number, expandedTotal: number}} options.budget 共享预算计数器（原地累加）
 * @param {(base: object) => Promise<{best: object, candidateCount: number, expandedNodes: number}>} options.refine
 *   局部精修实现（candidates.js 的 refineAround）
 * @param {(base: object) => Promise<object|null>} options.joint
 *   联合精修实现（candidates.js 的 jointRefine）
 * @returns {Promise<{
 *   final: object|null, replaced: boolean, challengers: Array, winners: Array,
 *   selected: object|null, alternatives: Array, notes: Array,
 *   budgetExhausted: boolean, aborted: boolean
 * }>}
 */
export async function runLargeTierStage({
  graph,
  edgeIndex,
  shapeKey,
  customShape,
  center,
  baseSizeMeters,
  baseline,
  allowEnlarge,
  deadline,
  maxCandidates,
  signal,
  onProgress,
  evaluatedKeys,
  budget,
  refine,
  joint,
}) {
  const outcome = {
    final: baseline,
    replaced: false,
    challengers: [],
    winners: [],
    selected: null,
    alternatives: [],
    notes: [],
    budgetExhausted: false,
    aborted: false,
  };

  // §5.1 触发条件：没有合格基线 / 禁止放大 / 用户停止 → 不补搜、不放宽任何门槛
  if (!baseline || !meetsQualityBar(baseline.result?.metrics)) {
    outcome.notes.push('no-baseline');
    return outcome;
  }
  if (!allowEnlarge) {
    outcome.notes.push('enlarge-not-allowed');
    return outcome;
  }
  if (isAborted(signal)) {
    outcome.aborted = true;
    outcome.notes.push('aborted');
    return outcome;
  }

  const targetHash = targetIdentityOf({ shapeKey, customShape });
  const baselineEnvelope = shapeErrorEnvelopeMeters(baseline.result?.metrics);
  const baselineOffset = distanceMeters(
    center.lat,
    center.lng,
    baseline.center.lat,
    baseline.center.lng,
  );
  log.info('candidates.largeTier.baseline', {
    score: baseline.score,
    sizeMeters: baseline.sizeMeters,
    rotationDeg: baseline.rotationDeg,
    center: baseline.center,
    envelopeMeters: baselineEnvelope,
    offsetMeters: Math.round(baselineOffset),
    sizeFactors: LARGE_TIER_SIZE_FACTORS,
  });

  // §5.1 定向补搜：固定 B 的中心与朝向，按原始基准尺寸的 2×/2.5×/3× 各真实规划一次
  const probe = await probeLargeTiers({
    graph,
    edgeIndex,
    shapeKey,
    customShape,
    origin: center,
    baseSizeMeters,
    baseline,
    targetHash,
    evaluatedKeys,
    deadline,
    maxCandidates,
    signal,
    triedCount: budget.triedCount,
    expandedNodes: budget.expandedTotal,
  });
  budget.triedCount += probe.triedCount;
  budget.expandedTotal += probe.expandedNodes;
  outcome.challengers = probe.challengers;
  // 补搜因预算/中止停下时如实标记（语义沿用粗搜：预算耗尽只返回已达标结果）
  if (probe.stopReason === 'candidate-budget') {
    outcome.budgetExhausted = true;
  }
  if (probe.stopReason === 'aborted') {
    outcome.aborted = true;
  }

  // §5.2 裁决：所有挑战者独立与同一个 B 比较，胜出集内取尺寸最大的一档
  const adjudication = adjudicateLargeTiers({
    baseline,
    challengers: probe.challengers,
    origin: center,
  });
  outcome.winners = adjudication.winners;
  outcome.selected = adjudication.selected;

  log.info('candidates.largeTier.probe', {
    stopReason: probe.stopReason,
    probed: probe.triedCount,
    skipped: probe.skipped,
    failed: probe.failed.map((item) => ({ sizeMeters: item.sizeMeters, reason: item.reason })),
    baseline: {
      score: baseline.score,
      envelopeMeters: baselineEnvelope,
      offsetMeters: Math.round(baselineOffset),
    },
    challengers: adjudication.evaluations.map((item) => ({
      sizeMeters: item.sizeMeters,
      score: item.score,
      baselineScore: item.baselineScore,
      envelopeMeters: item.envelope,
      baselineEnvelopeMeters: item.baselineEnvelope,
      offsetMeters:
        Number.isFinite(item.offsetMeters) ? Math.round(item.offsetMeters) : null,
      baselineOffsetMeters:
        Number.isFinite(item.baselineOffsetMeters)
          ? Math.round(item.baselineOffsetMeters)
          : null,
      accepted: item.accepted,
      reason: item.reason,
    })),
  });

  if (!adjudication.selected) {
    outcome.notes.push('no-winner');
    outcome.alternatives = buildLargeTierAlternatives(adjudication.evaluations, center);
    return outcome;
  }

  log.info('candidates.largeTier.selected', {
    winnerCount: adjudication.winners.length,
    sizeMeters: adjudication.selected.sizeMeters,
    score: adjudication.selected.score,
    envelopeMeters: shapeErrorEnvelopeMeters(adjudication.selected.metrics),
    winners: adjudication.winners.map((item) => ({
      sizeMeters: item.sizeMeters,
      score: item.score,
      envelopeMeters: shapeErrorEnvelopeMeters(item.metrics),
    })),
  });

  // §5.3 胜出大档补做精修并重新过闸；未通过复检即回退到最近一个已验证版本
  const finalized = await finalizeLargeTier({
    baseline,
    selected: adjudication.selected,
    origin: center,
    refine: async (base) => {
      const refined = await refine(base);
      budget.triedCount += refined?.candidateCount || 0;
      budget.expandedTotal += refined?.expandedNodes || 0;
      if (refined?.best) {
        // 目标内容哈希随候选传递（跨版本比较防护）
        refined.best = { ...refined.best, targetHash };
      }
      return refined;
    },
    joint: async (base) => {
      if (isAborted(signal) || (deadline !== null && performance.now() >= deadline)) {
        return null;
      }
      const result = await joint(base);
      budget.triedCount += result?.evaluated || 0;
      budget.expandedTotal += result?.expandedNodes || 0;
      return result;
    },
    canRefine: () =>
      !isAborted(signal) &&
      (deadline === null || performance.now() < deadline) &&
      (maxCandidates === null || budget.triedCount + 135 <= maxCandidates),
  });

  outcome.notes = finalized.notes;
  outcome.replaced = finalized.replaced;
  outcome.final = finalized.final;
  outcome.alternatives = buildLargeTierAlternatives(adjudication.evaluations, center);

  log.info('candidates.largeTier.final', {
    replaced: finalized.replaced,
    notes: finalized.notes,
    versions: finalized.versions.map((item) => ({
      sizeMeters: item.sizeMeters,
      score: item.score,
      envelopeMeters: shapeErrorEnvelopeMeters(item.metrics),
    })),
    final: finalized.final
      ? {
          sizeMeters: finalized.final.sizeMeters,
          score: finalized.final.score,
          envelopeMeters: shapeErrorEnvelopeMeters(finalized.final.metrics),
        }
      : null,
  });

  return outcome;
}

/**
 * 合格大档备选条目（§9.2）：展示实际贴合分与形状绝对误差包络，
 * 不再统一使用"更大所以细节更好"的暗示性文案。
 *
 * @param {Array} evaluations 裁决明细（含每个挑战者的分数/包络/是否胜出）
 * @param {{lat: number, lng: number}} center 请求中心
 * @returns {Array} 备选条目
 */
function buildLargeTierAlternatives(evaluations, center) {
  return (evaluations || [])
    .filter((item) => item?.candidate && meetsQualityBar(item.candidate.metrics))
    .map((item) => ({
      result: item.candidate.result,
      score: item.candidate.score,
      adjustedScore: adjustedScoreOf(item.candidate.score, item.candidate.center, center),
      center: item.candidate.center,
      sizeMeters: item.candidate.sizeMeters,
      rotationDeg: item.candidate.rotationDeg,
      stage: 6,
      stageLabel: '尺寸轴大档',
      envelopeMeters: item.envelope ?? null,
    }));
}
