/**
 * 尺寸轴定向大档补搜与"基线—候选集"裁决（方案 2026-11-01 §5.1~§5.3）。
 *
 * 位置说明（清理方案 2026-11-09 B1）：尺寸轴大档链路已从生产移除，本模块只被
 * test/double-gate.mjs 与 test/lib/large-tier-stage.js 使用，故从
 * `web/src/engine/large-tier.js` 下沉到 `test/lib/`；生产侧不再 import 本文件。
 *
 * 要解决的两道闸：
 * 1. 候选生成闸：近场（1.5× 基准）达到早退条件后，尽力链会直接关闭尺寸轴，
 *    2×/2.5×/3× 档从未真实规划过——"更大的档看起来更好"只是文案，没有任何候选。
 * 2. 裁决闸：即使大档已进入备选池，比较器的尺寸惩罚与"更小优先"也会把它压回
 *    近场小档，于是大档永远只出现在备选文案里。
 *
 * 本模块只做三件事，全部与图形名称/对象类别/素材/地点无关：
 *
 * - probeLargeTiers（§5.1）：以近场基线 B 的中心与朝向为**固定条件**，按**原始**
 *   基准尺寸的 2×/2.5×/3× 各真实调用一次完整规划（不重新展开位置网格、不重新
 *   扫朝向、不用比例估算代替），与既有候选数/扩展节点/deadline/中止信号共享预算，
 *   并按"目标内容哈希 + 中心 + 朝向 + 尺寸"去重（重复键不重复评价、不重复计数）。
 * - adjudicateLargeTiers（§5.2）：所有挑战者**独立**与同一个近场基线 B 比较
 *   （比较期间不得用前一个胜出者更新 B），进入胜出集的条件是质量门通过 +
 *   分数更高 + 形状绝对误差包络不劣 + 目标内容哈希一致；胜出集内取**尺寸最大**的一档。
 * - finalizeLargeTier（§5.3）：胜出大档不能直接定稿，必须补做局部精修并重新过闸
 *   （分数更高 + 包络不劣 + 偏移不比基线更远）；任一项不过即回退到最近一个已验证
 *   版本；因预算/停止根本没有执行精修时保留近场基线，不交付未经复检的大档。
 *
 * 裁决/复检/回退链与路网解耦（refine/joint 以回调注入），便于在 Node 里做确定性测试。
 */

import { planShapeRoute } from '../../web/src/engine/planner.js';
import { scoreRoute, meetsQualityBar } from '../../web/src/engine/quality.js';
import { isAborted } from '../../web/src/cancel.js';
import {
  evaluateChallenger,
  verifyRefinedCandidate,
  selectLargestWinner,
} from '../../web/src/engine/shape-envelope.js';

/** 定向大档补搜的尺寸倍率（相对**原始**基准尺寸，不是精修后的当前尺寸翻倍） */
export const LARGE_TIER_SIZE_FACTORS = [2, 2.5, 3];

/** 目标身份标识：同一目标内所有候选必须一致，跨目标/跨版本不得互相比较 */
export function targetIdentityOf({ shapeKey = null, customShape = null } = {}) {
  if (customShape?.contentHash) {
    return customShape.contentHash;
  }
  if (customShape) {
    return 'custom-shape';
  }
  return `builtin:${shapeKey ?? 'unknown'}`;
}

/**
 * 候选去重键：目标内容哈希 + 中心 + 朝向 + 尺寸。
 * 坐标量化到 1e-7 度（约 1cm），朝向量化到 1e-3 度，尺寸取整米。
 *
 * @param {object} options
 * @param {string|null} options.targetHash 目标内容哈希
 * @param {{lat: number, lng: number}} options.center 候选中心
 * @param {number} options.rotationDeg 候选朝向（度）
 * @param {number} options.sizeMeters 候选尺寸（米）
 * @returns {string} 去重键
 */
export function candidateEvaluationKey({ targetHash, center, rotationDeg, sizeMeters }) {
  const lat = Number.isFinite(center?.lat) ? center.lat.toFixed(7) : 'na';
  const lng = Number.isFinite(center?.lng) ? center.lng.toFixed(7) : 'na';
  const rotation = Number.isFinite(rotationDeg) ? rotationDeg.toFixed(3) : 'na';
  const size = Number.isFinite(sizeMeters) ? Math.round(sizeMeters) : 'na';
  return `${targetHash ?? 'na'}|${lat}|${lng}|${rotation}|${size}`;
}

/**
 * 归一化候选：把引擎内部候选（result/score/center/...）整成裁决与展示都用的形状。
 * metrics 与 result 同时保留，裁决模块按任一入口读取都不失配。
 *
 * @param {object|null} candidate 候选
 * @param {number} [order] 生成顺序（用于同尺寸同分时的稳定 tiebreak）
 * @returns {object|null} 归一化候选；输入为空时返回 null
 */
function normalizeCandidate(candidate, order = 0) {
  if (!candidate) {
    return null;
  }
  const metrics = candidate.metrics ?? candidate.result?.metrics ?? null;
  return {
    result: candidate.result ?? null,
    metrics,
    score: candidate.score,
    adjustedScore: candidate.adjustedScore,
    center: candidate.center,
    sizeMeters: candidate.sizeMeters,
    rotationDeg: candidate.rotationDeg,
    targetHash: candidate.targetHash ?? null,
    order: Number.isFinite(candidate.order) ? candidate.order : order,
  };
}

/**
 * 定向大档补搜（§5.1）：以近场基线的中心/朝向为固定条件，按原始基准尺寸的
 * 2×/2.5×/3× 各真实规划一次。
 *
 * 触发条件（全部满足才补搜，任一不满足都不补搜、不放宽任何门槛）：
 * - 已有质量门通过的近场基线；
 * - allowEnlarge === true；
 * - 对应大档尚未通过去重键评价过；
 * - 未用户停止，且候选数/扩展节点/时间预算仍有余量。
 *
 * @param {object} options
 * @param {object} options.graph 步行路网图
 * @param {object} options.edgeIndex 道路线段索引
 * @param {string|null} options.shapeKey 内置图形标识
 * @param {object|null} options.customShape 自定义图形
 * @param {{lat: number, lng: number}} options.origin 请求中心
 * @param {number} options.baseSizeMeters 原始基准尺寸（米）
 * @param {object} options.baseline 近场基线（含 center/rotationDeg）
 * @param {string} options.targetHash 目标内容哈希
 * @param {Set<string>} options.evaluatedKeys 已评价过的候选去重键（原地写入）
 * @param {number|null} [options.deadline] 时间截止（performance.now() 口径）
 * @param {number|null} [options.maxCandidates] 候选数硬上限（共享预算）
 * @param {AbortSignal|null} [options.signal] 用户停止信号
 * @param {number} [options.triedCount] 已用候选数（共享预算起点）
 * @param {number} [options.expandedNodes] 已用扩展节点数（共享预算起点）
 * @returns {Promise<{
 *   challengers: Array, skipped: Array, failed: Array,
 *   triedCount: number, expandedNodes: number, stopReason: string|null
 * }>} challengers 为成功规划出的大档候选（未裁决），skipped/failed 记录未进入裁决的原因
 */
export async function probeLargeTiers({
  graph,
  edgeIndex,
  shapeKey = null,
  customShape = null,
  origin,
  baseSizeMeters,
  baseline,
  targetHash,
  evaluatedKeys,
  deadline = null,
  maxCandidates = null,
  signal = null,
  triedCount = 0,
  expandedNodes = 0,
}) {
  const challengers = [];
  const skipped = [];
  const failed = [];
  let addedTried = 0;
  let addedExpanded = 0;
  let stopReason = null;

  if (!baseline || !Number.isFinite(baseSizeMeters) || baseSizeMeters <= 0) {
    return {
      challengers,
      skipped,
      failed,
      triedCount: 0,
      expandedNodes: 0,
      stopReason: 'no-baseline',
    };
  }

  for (const factor of LARGE_TIER_SIZE_FACTORS) {
    const sizeMeters = Math.round(baseSizeMeters * factor);
    const center = baseline.center;
    const rotationDeg = baseline.rotationDeg;
    const key = candidateEvaluationKey({ targetHash, center, rotationDeg, sizeMeters });

    // 去重：同键已评价过则不重复规划、不重复计入候选数
    if (evaluatedKeys instanceof Set && evaluatedKeys.has(key)) {
      skipped.push({ factor, sizeMeters, reason: 'duplicate-key' });
      continue;
    }

    // 预算守卫：与粗搜/精修共享候选数、扩展节点、deadline 与中止信号
    if (maxCandidates !== null && triedCount + addedTried >= maxCandidates) {
      stopReason = 'candidate-budget';
      break;
    }
    if (deadline !== null && performance.now() >= deadline) {
      stopReason = 'deadline';
      break;
    }
    if (isAborted(signal)) {
      stopReason = 'aborted';
      break;
    }

    try {
      const result = planShapeRoute({
        graph,
        edgeIndex,
        shapeKey,
        customShape,
        center,
        sizeMeters,
        rotationDeg,
      });
      const score = scoreRoute(result.metrics);
      const legExpanded = result.metrics?.searchStats?.expandedNodes || 0;
      addedTried += 1;
      addedExpanded += legExpanded;
      if (evaluatedKeys instanceof Set) {
        evaluatedKeys.add(key);
      }
      challengers.push(
        normalizeCandidate(
          {
            result,
            score,
            center,
            sizeMeters,
            rotationDeg,
            targetHash,
            order: challengers.length,
          },
          challengers.length,
        ),
      );
    } catch (error) {
      // 候选中心落在无路区等属搜索常态：记失败，不逐条刷日志
      failed.push({
        factor,
        sizeMeters,
        reason: error?.message ? String(error.message).slice(0, 120) : 'plan-failed',
      });
    }
  }

  return {
    challengers,
    skipped,
    failed,
    triedCount: addedTried,
    expandedNodes: addedExpanded,
    stopReason,
  };
}

/**
 * 大档裁决（§5.2）：所有挑战者独立与同一个近场基线 B 比较，形成胜出集后
 * 在胜出集中取尺寸最大的一档（同尺寸按分数更高、原始生成顺序更早）。
 *
 * 比较期间不得用前一个胜出的大档更新 B——本函数只读基线，不改基线。
 *
 * @param {object} options
 * @param {object} options.baseline 近场基线 B
 * @param {Array} options.challengers 挑战者候选
 * @param {{lat: number, lng: number}} options.origin 请求中心
 * @returns {{winners: Array, selected: object|null, evaluations: Array}}
 *   evaluations 为每个挑战者的裁决明细（供日志与诊断）
 */
export function adjudicateLargeTiers({ baseline, challengers, origin }) {
  const evaluations = [];
  const winners = [];
  for (const raw of challengers || []) {
    const challenger = normalizeCandidate(raw, raw?.order ?? 0);
    const verdict = evaluateChallenger({ challenger, baseline, origin });
    evaluations.push({
      sizeMeters: challenger?.sizeMeters ?? null,
      score: challenger?.score ?? null,
      baselineScore: verdict?.baselineScore ?? null,
      envelope: verdict?.envelope ?? null,
      baselineEnvelope: verdict?.baselineEnvelope ?? null,
      offsetMeters: verdict?.offsetMeters ?? null,
      baselineOffsetMeters: verdict?.baselineOffsetMeters ?? null,
      accepted: Boolean(verdict?.accepted),
      reason: verdict?.reason ?? null,
      candidate: challenger,
    });
    if (verdict?.accepted) {
      winners.push({ ...challenger, order: challenger.order });
    }
  }
  const selected = selectLargestWinner(winners);
  return { winners, selected, evaluations };
}

/**
 * 胜出大档的精修复检与回退链（§5.3）。
 *
 * 回退链：精修前已胜出的大档原候选 → 精修结果 → 联合精修结果。
 * 每一步都必须重新过闸（分数更高 + 形状包络不劣 + 偏移不比基线更远），
 * 没过就停在最近一个已验证版本；因预算/停止根本没有执行精修时保留近场基线。
 *
 * @param {object} options
 * @param {object} options.baseline 近场基线 B（已验证）
 * @param {object} options.selected 胜出大档（粗规划，§5.2 已验证）
 * @param {{lat: number, lng: number}} options.origin 请求中心
 * @param {(base: object) => Promise<{best: object}>} options.refine 局部精修回调
 * @param {((base: object) => Promise<object|null>)|null} [options.joint] 联合精修回调
 * @param {() => boolean} [options.canRefine] 预算/中止守卫（false = 不能执行精修）
 * @returns {Promise<{
 *   final: object, replaced: boolean, versions: Array, notes: Array
 * }>} final 为最终候选（归一化形态）
 */
export async function finalizeLargeTier({
  baseline,
  selected,
  origin,
  refine,
  joint = null,
  canRefine = () => true,
}) {
  const base = normalizeCandidate(baseline);
  const notes = [];
  const versions = base ? [base] : [];

  // 根本没有执行胜出档精修（预算耗尽/用户停止）→ 保留近场基线，
  // 不把未经精修复检的大档直接交付
  if (!selected || !base) {
    notes.push('no-selected-large-tier');
    return { final: base, replaced: false, versions, notes };
  }
  if (!canRefine()) {
    notes.push('refine-not-executed');
    return { final: base, replaced: false, versions, notes };
  }

  // 精修前已胜出且仍通过全部门的大档原候选（与基线同中心，偏移不变）
  let current = normalizeCandidate(selected);
  versions.push(current);

  // 局部精修：复用现有 refineAround（位置/朝向/±8% 尺寸），只对选出的最大档调用一次
  if (typeof refine === 'function') {
    const refined = await refine(current);
    const refinedCandidate = normalizeCandidate(refined?.best);
    if (refinedCandidate && refinedCandidate !== current) {
      const verdict = verifyRefinedCandidate({
        candidate: refinedCandidate,
        baseline: base,
        origin,
      });
      if (verdict?.accepted) {
        current = refinedCandidate;
        versions.push(current);
      } else {
        notes.push(`refine-rejected:${verdict?.reason ?? 'unknown'}`);
      }
    }
  }

  // 联合精修：对当前大档版本再做一次整图吸附/档位精修，未过同一复检则回退
  if (typeof joint === 'function') {
    const jointResult = await joint(current);
    if (jointResult?.improved && jointResult?.best) {
      const jointMetrics = jointResult.best.metrics ?? jointResult.best.result?.metrics;
      if (!jointMetrics || !meetsQualityBar(jointMetrics)) {
        notes.push('joint-quality-gate-failed');
      } else {
        const jointCandidate = normalizeCandidate({
          result: jointResult.best.result,
          score: jointResult.best.score,
          center: current.center,
          sizeMeters: current.sizeMeters,
          rotationDeg: current.rotationDeg,
          targetHash: current.targetHash,
          order: current.order,
        });
        const verdict = verifyRefinedCandidate({
          candidate: jointCandidate,
          baseline: base,
          origin,
        });
        if (verdict?.accepted) {
          current = jointCandidate;
          versions.push(current);
        } else {
          notes.push(`joint-rejected:${verdict?.reason ?? 'unknown'}`);
        }
      }
    }
  }

  return {
    final: current,
    replaced: current !== base,
    versions,
    notes,
  };
}
