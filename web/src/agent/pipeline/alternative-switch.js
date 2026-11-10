/**
 * 文字备选切换（C4 拆分自 controller.js）：用户说"要大一点/小一点的那版"时，
 * 不调 LLM、不重新规划，直接提交 pendingAlternative 里的对应候选并交付。
 *
 * 依赖显式注入：引擎提交、历史、待切换备选读写、文案与多比例尺池同步回调。
 */

import { DELIVERABLE_SCORE } from '../../engine/quality.js';
import {
  buildConstraintContract,
  describeConstraintViolations,
  evaluateConstraintContract,
} from '../../engine/constraint-contract.js';
import { throwIfAborted } from '../../cancel.js';
import { buildOutlinePreview } from './deliver.js';

/**
 * 创建文字备选切换运行时。
 *
 * @param {object} deps 依赖
 * @param {object} deps.engine 引擎（commitDraw）
 * @param {{info: Function, warn: Function}} deps.log 日志器
 * @param {(userText: string, assistantText: string) => void} deps.pushHistory 写对话历史
 * @param {() => object|null} deps.getPendingAlternative 取待切换备选
 * @param {(value: object|null) => void} deps.setPendingAlternative 写待切换备选
 * @param {(intent: object) => string|null} deps.shapeNameOf 图形显示名
 * @param {(input: object) => string} deps.composeAlternativeSwitchReply 切换回复文案
 * @param {(candidate: object) => void} deps.syncScalePoolAfterSwitch 多比例尺池同步
 * @returns {{deliverAlternativeSwitch: Function}}
 */
export function createAlternativeSwitch({
  engine,
  log,
  pushHistory,
  getPendingAlternative,
  setPendingAlternative,
  shapeNameOf,
  composeAlternativeSwitchReply,
  syncScalePoolAfterSwitch,
}) {
  /** "没有该方向备选"的诚实回复（不重规划、不硬凑） */
  function finishAlternativeSwitchMiss(direction, text, current, swappable) {
    const shapeName = shapeNameOf(getPendingAlternative()?.intent) || '图形';
    const reply =
      `当前这版（${(current.sizeMeters / 1000).toFixed(1)} km）已经是我搜到的${
        direction === 'bigger' ? '最大' : '最小'
      }备选，没有${direction === 'bigger' ? '更大' : '更小'}的一版了。想要别的尺寸可以直接说（比如"画个 3 公里的${shapeName}"），我重新规划。`;
    pushHistory(text, reply);
    log.info('deliver.alternativeSwitch.miss', {
      direction,
      currentSizeMeters: current.sizeMeters,
      alternativeSizes: swappable.map((item) => item.sizeMeters),
    });
    return { reply, planned: null, outline: null };
  }

  /**
   * 执行备选切换（缺陷清单 Bug 5 完整方案）：不调 LLM、不重新规划，
   * 直接提交对应候选并交付；切换后的版本成为当前版，旧版进入备选可切回。
   *
   * @param {'bigger'|'smaller'} direction 切换方向
   * @param {string} text 用户输入（切换短语）
   * @param {object} trace 本轮 trace
   * @param {AbortSignal|null} signal 中止信号
   * @returns {object} 与 send 相同的结果结构
   */
  function deliverAlternativeSwitch(direction, text, trace, signal = null) {
    throwIfAborted(signal, '已停止');
    const pending = getPendingAlternative();
    const current = pending.best;
    const swappable = (pending.alternatives || []).filter(
      (item) => item?.result?.routeLatLngs?.length >= 2 && Number.isFinite(item.sizeMeters),
    );
    const candidates = swappable.filter((item) =>
      direction === 'bigger' ? item.sizeMeters > current.sizeMeters : item.sizeMeters < current.sizeMeters,
    );
    if (candidates.length === 0) {
      // 空池直接走"没有该方向备选"分支（不能先 reduce——空数组 reduce 抛错）
      return finishAlternativeSwitchMiss(direction, text, current, swappable);
    }
    // 优先交付回复文案承诺的那一版（promised 与文案同源）；承诺版本不属于该方向
    // （如承诺更大、用户要更小）时才按方向取极值（缺陷清单 Bug 5，2026-11-07 复核修正：
    // 此前按极值取——承诺 7.2 km 版、实际切到 0.9 km 版，承诺不可兑现）
    const promised = pending.promised && candidates.includes(pending.promised) ? pending.promised : null;
    const candidate = promised ?? (direction === 'bigger'
      ? candidates.reduce((a, b) => (b.sizeMeters > a.sizeMeters ? b : a))
      : candidates.reduce((a, b) => (b.sizeMeters < a.sizeMeters ? b : a)));
    {
      // 切换前复用 60 分交付闸门（复核发现切换可把低于闸门的备选当绿线交付）
      if (Number(candidate.score) < DELIVERABLE_SCORE) {
        const shapeName = shapeNameOf(pending.intent) || '图形';
        const reply =
          `那一版备选的路线贴合只有 ${candidate.score} 分（低于 ${DELIVERABLE_SCORE} 分的交付闸门），画出来不会像，我就不切成那一版了。` +
          `当前这版（${(current.sizeMeters / 1000).toFixed(1)} km · 路线贴合 ${current.score}）仍是更好的选择；想要别的尺寸可以直接说明（比如"画个 3 公里的${shapeName}"），我重新规划。`;
        pushHistory(text, reply);
        log.warn('deliver.alternativeSwitch.gateRefused', {
          direction,
          candidateScore: candidate.score,
          threshold: DELIVERABLE_SCORE,
          currentSizeMeters: current.sizeMeters,
        });
        return { reply, planned: null, outline: null };
      }
    }
    trace.step(
      `切换备选：${(current.sizeMeters / 1000).toFixed(1)} km → ${(candidate.sizeMeters / 1000).toFixed(1)} km（不重新规划）`,
    );
    // 显式约束闸门（方案 2026-11-08 §3.2"备选池与备选切换：只能承诺和交付仍满足原约束的版本"）：
    // 切到备选前复核这一版是否仍满足原始的显式尺寸/朝向要求。
    {
      const switchContract = buildConstraintContract({
        sizeMeters: pending.intent?.sizeMeters,
        sizeExplicit: pending.intent?.sizeExplicit === true,
        rotationDeg: pending.intent?.rotationDeg,
        rotationExplicit: pending.intent?.rotationExplicit === true,
      });
      const switchCompliance = evaluateConstraintContract(switchContract, {
        sizeMeters: candidate.sizeMeters,
        rotationDeg: candidate.rotationDeg,
      });
      if (!switchCompliance.ok) {
        const reply =
          `那一版备选不满足你最初的要求（${describeConstraintViolations(switchCompliance.violations)}），` +
          `我没有切成它。当前这版（${(current.sizeMeters / 1000).toFixed(1)} km · 路线贴合 ${current.score}）仍然符合要求。`;
        pushHistory(text, reply);
        log.warn('deliver.alternativeSwitch.constraintRefused', {
          direction,
          violations: switchCompliance.violations,
          currentSizeMeters: current.sizeMeters,
          candidateSizeMeters: candidate.sizeMeters,
        });
        return { reply, planned: null, outline: null };
      }
    }
    const shape = engine.commitDraw(candidate.result, { score: candidate.score });
    const reply = composeAlternativeSwitchReply({ pending, candidate, direction, promisedDelivered: pending.promised === candidate });
    pushHistory(text, reply);
    log.info('deliver.alternativeSwitched', {
      direction,
      promisedDelivered: pending.promised === candidate,
      from: { sizeMeters: current.sizeMeters, score: current.score },
      to: {
        sizeMeters: candidate.sizeMeters,
        score: candidate.score,
        rotationDeg: candidate.rotationDeg ?? null,
        stage: candidate.stage ?? null,
        stageLabel: candidate.stageLabel ?? null,
      },
      alternativeSizes: swappable.map((item) => item.sizeMeters),
    });
    // 切换后的版本成为"当前版"，旧版与其余备选一起保留（可反复切换，无需重规划）
    const next = {
      best: candidate,
      alternatives: [...swappable.filter((item) => item !== candidate), current],
      intent: pending.intent,
      placeNote: pending.placeNote,
      placeSource: pending.placeSource,
      offset: pending.offset,
      nearBest: pending.nearBest,
      stage: pending.stage,
      refined: pending.refined === true,
      at: Date.now(),
    };
    setPendingAlternative(next);
    // 多比例尺候选卡片同步（需求 R6 共存）：文字切换后卡片行的当前版随实际交付更新
    syncScalePoolAfterSwitch(candidate);
    const outlinePreview = buildOutlinePreview({
      customShape: pending.intent.customShape ?? null,
      shapeKey: pending.intent.shapeKey ?? null,
      referenceSource: pending.intent.referenceSource || null,
      rotationDeg: candidate.rotationDeg ?? null,
    });
    return {
      reply,
      planned: {
        status: 'ok',
        best: candidate,
        result: candidate.result,
        stage: candidate.stage ?? pending.stage,
        stageLabel: candidate.stageLabel ?? null,
        alternatives: next.alternatives,
      },
      outline: outlinePreview,
      shape,
    };
  }

  return { deliverAlternativeSwitch };
}
