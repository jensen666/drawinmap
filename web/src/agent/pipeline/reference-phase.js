/**
 * 参考通道两阶段（C4 拆分自 controller.js）：多对象请求的逐对象参考匹配与组合、
 * 单对象参考候选阶段（本地单候选直接固定 / 多候选出待选卡）。
 *
 * 依赖显式注入：参考候选源、日志、写历史、待选快照写入；候选点选后的规划仍由
 * controller 的 chooseReferenceCandidate/resolveTarget 负责。
 */

import {
  composeObjectShortfallReply,
  matchRequestedObjects,
} from '../request-objects.js';
import { composeMultiPartShape } from '../composite-shape.js';
import { REFERENCE_CHOICE_LIMIT } from '../reference.js';
import { createAbortError, isAbortError, isAborted, throwIfAborted } from '../../cancel.js';
import { createId } from '../../log/core.js';
import { rethrowIfAborted } from './shared.js';
import {
  applyCompositeReference,
  applyReferenceCandidate,
  canUseReferenceChannel,
  matchedObjectsOf,
} from './three-source.js';

/**
 * 创建参考通道两阶段运行时。
 *
 * @param {object} deps 依赖
 * @param {object|null} deps.referenceCandidatesSource 参考候选源
 * @param {{info: Function, warn: Function}} deps.log 日志器
 * @param {(userText: string, assistantText: string) => void} deps.pushHistory 写对话历史
 * @param {(choice: object|null) => void} deps.setReferenceChoice 写待选快照（referenceChoice）
 * @param {() => object|null} deps.getReferenceChoice 取待选快照
 * @param {(reason: string) => void} deps.cancelThreeSourceSession 取消未返回的三路
 * @returns {{discardReferenceChoice: Function, resolveMultiObjectPhase: Function,
 *   resolveReferencePhase: Function}}
 */
export function createReferencePhases({
  referenceCandidatesSource,
  log,
  pushHistory,
  setReferenceChoice,
  getReferenceChoice,
  cancelThreeSourceSession,
}) {
  /**
   * 放弃当前待选候选（方案 2026-10-31 §6.4/§10）。
   * 新输入、切换对话、过期等场景调用；已选定的快照不再重复记放弃事件。
   *
   * @param {string} reason 放弃原因（new-input / session-switch / invalid-selection）
   */
  function discardReferenceChoice(reason) {
    // 放弃待选的同时取消后台未返回的三路（方案 2026-11-01 §2：新输入/切会话/停止时
    // 不再等待剩余路）；失败/停止轮由调用方恢复快照时不会重新启动后台任务。
    cancelThreeSourceSession(reason);
    const current = getReferenceChoice();
    if (!current || current.status !== 'awaiting-selection') {
      setReferenceChoice(null);
      return;
    }
    log.info('reference.selection.discarded', {
      choiceId: current.choiceId,
      reason,
      candidateCount: current.candidates?.length ?? 0,
    });
    setReferenceChoice(null);
  }

  /** 多对象部分命中追问（两处共用）：列出已命中与缺失对象并追问，绝不单候选自动规划。
   *  logName 保留两处既有日志字段名（matched/delivered）差异。 */
  function askObjectShortfall({ text, trace, requested, delivered, missing, logName = 'delivered' }) {
    const reply = composeObjectShortfallReply({ requested, delivered, missing });
    pushHistory(text, reply);
    trace.info('agent.reply', { reply, plannedStatus: null, objectShortfall: true });
    log.warn('agent.reference.multi.partial', {
      requested: requested.map((item) => item.name),
      [logName]: delivered,
      missing: missing.map((item) => item.name),
    });
    return { awaiting: true, result: { reply, planned: null, shape: null, outline: null } };
  }

  /**
   * 多对象请求的参考通道阶段（方案 2026-11-05 §4.2）。
   *
   * 只在「意图层给出 ≥2 个请求对象」时启用：
   * - 参考通道命中**全部**请求对象、且复合目标拓扑合法、用户请求允许组合
   *   → 生成 multi-part 目标（各对象一个部分），走正常规划；
   * - 只命中部分对象 → **不得单候选自动规划**：明确列出已命中与缺失对象并追问；
   * - 一个都没命中 → 交回原链路（自由轮廓仍可能画得出）。
   *
   * @param {object} intent 归一化意图
   * @param {string} text 用户原文
   * @param {(step: object) => void} onProgress 进度回调
   * @param {object} trace 本轮 trace
   * @param {AbortSignal|null} signal 中止信号
   * @returns {Promise<null|{intent: object}|{awaiting: true, result: object}>} null 表示不适用
   */
  async function resolveMultiObjectPhase(intent, text, onProgress, trace, signal) {
    if (!canUseReferenceChannel(referenceCandidatesSource, intent) || !Array.isArray(intent.requestObjects) || intent.requestObjects.length < 2) {
      return null;
    }
    let outcome = null;
    try {
      const requestedObjects = intent.requestObjects
        .map((item) => (typeof item === 'string' ? item : item?.name))
        .filter((name) => typeof name === 'string' && name.trim());
      // 按清单逐对象匹配（缺陷清单 2026-11-06 Bug 4.3.4.2）：意图层已给出对象清单，
      // 把每个对象名单独送入匹配器，不再依赖整段原文的词边界——
      // 「猫和兔子」里单字别名"猫"此前因连词吞词不命中，多对象能力实际不可用。
      // 源不支持逐对象时回退整段扫描（保持旧行为）。
      if (requestedObjects.length >= 2 && typeof referenceCandidatesSource.resolveLocalCandidatesForObjects === 'function') {
        outcome = await referenceCandidatesSource.resolveLocalCandidatesForObjects(intent.requestObjects, {
          intent,
          limit: REFERENCE_CHOICE_LIMIT,
          signal,
        });
        log.info('agent.reference.multi.perObject', {
          requested: requestedObjects,
          matched: outcome?.objectGroups?.map((group) => group.objectName) ?? [],
        });
      } else {
        outcome = await referenceCandidatesSource.resolveLocalCandidates(text, {
          intent,
          limit: REFERENCE_CHOICE_LIMIT,
          signal,
        });
      }
    } catch (error) {
      rethrowIfAborted(error, signal);
      // 逐对象匹配失败：回退整段扫描再试一次（不让新路径拖垮多对象）
      try {
        outcome = await referenceCandidatesSource.resolveLocalCandidates(text, {
          intent,
          limit: REFERENCE_CHOICE_LIMIT,
          signal,
        });
        log.warn('agent.reference.multi.perObjectFallback', { textHead: text.slice(0, 40) });
      } catch (fallbackError) {
        if (isAbortError(fallbackError) || isAborted(signal)) {
          throw createAbortError('已停止');
        }
        log.warn('agent.reference.multi.failed', { textHead: text.slice(0, 40) }, fallbackError);
        return null;
      }
    }
    throwIfAborted(signal, '已停止');

    // 命中的对象（本地库多对象分组 / 单对象命中都归一成同一形状）
    const matched = matchedObjectsOf(outcome);
    if (matched.length === 0) {
      log.info('agent.reference.multi.miss', {
        textHead: text.slice(0, 40),
        status: outcome?.status ?? 'miss',
        requested: intent.requestObjects.map((item) => item.name),
      });
      return null; // 一个都没命中 → 交回原链路
    }

    const { hit, missing, hitAvailable } = matchRequestedObjects(intent.requestObjects, matched);
    log.info('agent.reference.multi', {
      requested: intent.requestObjects.map((item) => item.name),
      matched: matched.map((item) => item.objectName),
      hit: hit.map((item) => item.name),
      missing: missing.map((item) => item.name),
    });

    if (missing.length > 0) {
      // 部分命中：明确列出已命中与缺失对象并追问，绝不单候选自动规划
      return askObjectShortfall({
        text,
        trace,
        requested: intent.requestObjects,
        delivered: matched.map((item) => item.objectName),
        missing,
        logName: 'matched',
      });
    }

    // 全部命中：把每个对象的目标轮廓组合成一个 multi-part 目标。
    // 防御：同一个对象只能占一个部分——重复的命中（别名口径导致的重复认领）
    // 必须丢弃，否则会用同一素材拼出两份相同轮廓。
    const seenObjects = new Set();
    const entries = [];
    for (const entry of hitAvailable) {
      const key = entry.objectKey || entry.objectName;
      if (seenObjects.has(key)) {
        log.warn('agent.reference.multi.duplicateObject', { objectKey: key, objectName: entry.objectName });
        continue;
      }
      seenObjects.add(key);
      entries.push({
        name: entry.objectName,
        objectKey: key,
        candidate: entry.candidate,
        points: entry.candidate?.conversion?.T?.points ?? [],
      });
    }
    if (entries.length < hitAvailable.length) {
      const deduped = matchRequestedObjects(
        intent.requestObjects,
        entries.map((entry) => ({ objectName: entry.name })),
      );
      if (deduped.missing.length > 0) {
        // 去重后有对象缺失 → 回到"部分命中"分支：列出缺失对象并追问
        return askObjectShortfall({
          text,
          trace,
          requested: intent.requestObjects,
          delivered: entries.map((entry) => entry.name),
          missing: deduped.missing,
        });
      }
    }
    const composed = composeMultiPartShape(
      entries.map((entry) => ({ name: entry.name, points: entry.points })),
      { name: entries.map((entry) => entry.name).join('+') },
    );
    if (!composed.ok) {
      const reply = composeObjectShortfallReply({
        requested: intent.requestObjects,
        delivered: matched.map((item) => item.objectName),
        missing: [],
      });
      const reason = `找到了全部对象，但没法把它们组合成一个能走出来的目标（${composed.reason}）。`;
      const full = `${reason}\n${reply}`;
      pushHistory(text, full);
      trace.info('agent.reply', { reply: full, plannedStatus: null, objectCompositeFailed: true });
      log.warn('agent.reference.multi.compositeFailed', {
        requested: intent.requestObjects.map((item) => item.name),
        reason: composed.reason,
      });
      return {
        awaiting: true,
        result: { reply: full, planned: null, shape: null, outline: null },
      };
    }

    onProgress({
      text: `参考图命中「${entries.map((entry) => entry.name).join('」「')}」→ 组合成 ${composed.customShape.parts.length} 部分目标轮廓`,
      kind: 'step',
    });
    const nextIntent = applyCompositeReference(intent, composed.customShape, entries);
    log.info('agent.reference.multi.used', {
      objects: entries.map((entry) => entry.name),
      partCount: composed.customShape.parts.length,
      pointCount: composed.customShape.outlinePoints.length,
    });
    return { intent: nextIntent };
  }

  /**
   * 多对象参考通道阶段：适用条件（方案 §2.2/§5）：plan、非内置图形（星/心/矩形不被覆盖）、
   * 非参数化规格（规则图形 T 由程序产生，优先确定性生成）、无用户图片；
   * 图像描摹目标不适用参考通道（方案 2026-11-01 §3：有图片/经引导补地点后都不查参考）
   */

  /**
   * 参考通道阶段：本地素材命中 → 固定目标轮廓 → 继续 resolveTarget。
   *
   * 返回：
   * - null：参考通道不适用/未命中/失败 → 调用方继续原 resolveTarget 链路（回退语义）；
   * - { intent }：本地单候选（或适配注入的单命中）直接固定，继续 resolveTarget；
   * - { awaiting: true, result }：2~3 个本地候选或 1~3 个在线候选 → 等待用户点击，
   *   不执行规划（引擎调用次数为 0），referenceChoice 同时写入控制器会话上下文。
   *
   * @param {object} intent 归一化意图
   * @param {string} text 用户原文（originalText）
   * @param {(step: object) => void} onProgress 推理过程回调
   * @param {object} trace 候选轮 trace（sourceTraceId）
   * @param {AbortSignal|null} signal 中止信号
   * @param {string|null} imageDataUrl 用户图片（有图片时不走参考通道）
   */
  async function resolveReferencePhase(intent, text, onProgress, trace, signal, imageDataUrl) {
    if (!canUseReferenceChannel(referenceCandidatesSource, intent, { imageDataUrl })) {
      return null;
    }
    let outcome = null;
    try {
      outcome = await referenceCandidatesSource.resolveCandidates(text, {
        intent,
        limit: REFERENCE_CHOICE_LIMIT,
        signal,
      });
    } catch (error) {
      rethrowIfAborted(error, signal);
      // 参考通道是增强路径：任何失败都回退原链路，不阻断规划
      log.warn('agent.reference.failed', { textHead: text.slice(0, 40) }, error);
      return null;
    }
    throwIfAborted(signal, '已停止');
    if (!outcome || outcome.status !== 'ok' || !Array.isArray(outcome.candidates) || outcome.candidates.length === 0) {
      // 未命中/多对象歧义/在线不可用：全部回退 LLM 链路（§9.4 降级顺序）
      log.info('agent.reference.miss', {
        textHead: text.slice(0, 40),
        status: outcome?.status ?? 'miss',
        objects: outcome?.objects ?? null,
      });
      return null;
    }

    const { candidates, origin } = outcome;
    trace.info('reference.candidates', {
      origin,
      count: candidates.length,
      rawCount: outcome.rawCount ?? null,
      poolSize: outcome.poolSize ?? null,
      failures: outcome.failures ?? [],
      cache: outcome.cache ?? null,
      sources: outcome.sources ?? null,
      sourceTraceId: trace.id,
    });
    // 候选摘要（日志可观测，不写完整点列）
    log.info('reference.candidates', {
      choiceOrigin: origin,
      candidates: candidates.map((candidate) => ({
        assetId: candidate.asset?.id ?? null,
        name: candidate.asset?.displayName ?? null,
        tags: candidate.asset?.tags ?? [],
        origin: candidate.origin,
        reviewStatus: candidate.reviewStatus,
        pointCount: candidate.customShape.outlinePoints.length,
        contentHash: candidate.contentHash,
      })),
      failures: outcome.failures ?? [],
    });

    // 本地单候选：沿用单命中直接规划，不增加一次多余点击（方案 §2.1.2）
    if (candidates.length === 1 && origin === 'local') {
      const candidate = candidates[0];
      const nextIntent = applyReferenceCandidate(intent, candidate, { choiceId: null, confirmation: null });
      onProgress({
        text: `参考图命中「${nextIntent.referenceSource.name}」→ ${nextIntent.referenceSource.pointCount} 点目标轮廓（本地精选 · ${nextIntent.referenceSource.license ?? '许可见来源'}）`,
        kind: 'step',
      });
      log.info('agent.reference.used', {
        assetId: nextIntent.referenceSource.id,
        matchedAlias: nextIntent.referenceSource.matchedAlias,
        pointCount: nextIntent.referenceSource.pointCount,
        license: nextIntent.referenceSource.license,
        origin,
        contentHash: candidate.contentHash,
      });
      return { intent: nextIntent };
    }

    // 2~3 个本地候选，或 1~3 个在线候选：返回待选快照，等用户点击（在线单候选也必须确认）
    const choiceId = createId('rc');
    for (let index = 0; index < candidates.length; index += 1) {
      candidates[index].choiceId = choiceId;
      candidates[index].candidateId = `${choiceId}:${index}`;
    }
    const choice = {
      choiceId,
      sourceTraceId: trace.id,
      status: 'awaiting-selection',
      originalText: text,
      intent: JSON.parse(JSON.stringify({ ...intent, customShape: null })),
      candidates: JSON.parse(JSON.stringify(candidates)),
      origin,
      createdAt: Date.now(),
    };
    setReferenceChoice(choice);
    trace.info('reference.selection.required', { choiceId, count: candidates.length, online: origin === 'online' });
    onProgress({
      text: `找到「${candidates[0].asset?.displayName ?? '目标'}」的 ${candidates.length} 个候选版本${
        origin === 'online' ? '（在线检索，未审核）' : ''
      }`,
      kind: 'step',
    });
    return {
      awaiting: true,
      result: {
        reply: `请选择一个目标轮廓（共 ${candidates.length} 个候选）：`,
        planned: null,
        shape: null,
        outline: null,
        referenceChoice: JSON.parse(JSON.stringify(choice)),
      },
    };
  }

  return { discardReferenceChoice, resolveMultiObjectPhase, resolveReferencePhase };
}
