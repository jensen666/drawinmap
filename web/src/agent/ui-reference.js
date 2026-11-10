/**
 * 智能体面板的"点选类"交互（从 ui.js 拆出，C1 纯移动：逻辑/文案/时序未改）。
 *
 * 职责：
 * - switchScale：点选多比例尺卡片（本地状态机交互，不占 LLM 轮次、不产生对话消息，
 *   只切换地图/卡片选中态并浮出轻提示）；
 * - selectReferenceCandidate：点选参考候选卡（写 reference-selection 消息 →
 *   控制器规划 → 落最终回复）；
 * - refreshMessageNode：就地刷新单条消息节点（不整表重绘、不动滚动位置）。
 *
 * 依赖约定：通过 createReferenceFlow(deps) 显式注入（禁止模块级全局变量）：
 * - state（面板可变状态，读写）、store、controller、engine（formatMinutes）；
 * - elements（messagesEl）、panelToast、sendFlow（ui-send.js 的生命周期基元）；
 * - renderAll / saveContext / renderDeps（渲染依赖）回调与装配对象。
 * 日志模块名保持 'agent/ui'（事件名不变，沿用既有排查口径）。
 */

import { createAbortError, isAbortError } from '../cancel.js';
import { createLogger } from '../log/index.js';
import { describeShape, renderMessage } from './ui-render.js';
import {
  formatScaleSwitchNotice,
  formatScaleCurrentNotice,
  SCALE_POOL_STALE_NOTICE,
  SCALE_SWITCH_REFUSED_NOTICE,
} from './scale-notice.js';

/** 模块 logger：点选类交互的关键路径留痕 */
const log = createLogger('agent/ui');

/**
 * 创建点选类交互控制器。
 *
 * @param {object} deps 显式依赖（装配时注入）
 * @param {object} deps.state 面板可变状态（读写）
 * @param {object} deps.store 会话存储
 * @param {object} deps.controller 智能体控制器
 * @param {{formatMinutes: Function}} deps.engine 图形引擎
 * @param {{messagesEl: HTMLElement}} deps.elements DOM 引用
 * @param {{show: Function}} deps.panelToast 面板轻提示
 * @param {object} deps.sendFlow 发送流程（beginLiveTurn/finishTurn/appendTurnOutcome/
 *   commitTurn/appendAgentReply/setSending）
 * @param {Function} deps.renderAll 整表重绘
 * @param {Function} deps.saveContext 保存上下文快照
 * @param {object} deps.renderDeps 渲染依赖（转交 renderMessage）
 * @returns {{switchScale: Function, selectReferenceCandidate: Function, refreshMessageNode: Function}} 点选交互接口
 */
export function createReferenceFlow(deps) {
  const { state, store, controller, engine, elements, panelToast, sendFlow, renderDeps } = deps;
  const { messagesEl } = elements;

  /**
   * 就地刷新一条消息节点（点选比例尺卡片后只更新这条回复，不整表重绘、不动滚动位置）。
   * 节点不在当前视图（极端情况）时回退整表重绘。
   *
   * @param {string} messageId 消息 id
   */
  function refreshMessageNode(messageId) {
    const sessionId = store.getActiveId();
    const session = sessionId ? store.getSession(sessionId) : null;
    const message = session?.messages.find((item) => item.id === messageId) ?? null;
    const node = messageId ? messagesEl.querySelector(`[data-message-id="${messageId}"]`) : null;
    if (!message || !node) {
      deps.renderAll();
      return;
    }
    node.replaceWith(renderMessage(message, session.messages, renderDeps));
  }

  /**
   * 点选比例尺卡片（需求 R2；交互修正 2026-11-09）：本地状态机交互，不占 LLM 轮次、
   * 不重新规划、**不产生对话消息**——只就地切换地图/卡片选中态并浮出轻提示，
   * 消息区滚动位置保持不动（此前会追加"点选 X km 卡片"+切换回复并强制滚到底部）。
   *
   * @param {object} message 拥有卡片行的消息
   * @param {object} card 被点选的卡片摘要
   */
  function switchScale(message, card) {
    if (state.sending || !state.pendingScalePool || state.pendingScalePool.poolId !== message.scalePoolId) {
      return;
    }
    const sessionId = store.getActiveId();
    if (!sessionId) {
      return;
    }
    const sizeText = `${(card.sizeMeters / 1000).toFixed(1)} km`;
    log.info('ui.scaleCard.click', { poolId: message.scalePoolId, cardId: card.id, sizeText });
    const result = controller.switchScaleCandidate({ poolId: message.scalePoolId, cardId: card.id });
    if (!result || result.ok === false) {
      // 池在点击间隙失效（如城市切换）：轻提示如实说明，不报未捕获错误、不改地图；
      // 卡片行就地转静态（不整表重绘，避免把用户正在看的位置冲掉）
      state.pendingScalePool = null;
      deps.saveContext();
      store.flush();
      refreshMessageNode(message.id);
      panelToast.show(SCALE_POOL_STALE_NOTICE, { kind: 'warn' });
      log.info('ui.scaleCard.stale', {
        poolId: message.scalePoolId,
        cardId: card.id,
        reason: result?.reason ?? 'pool-gone',
      });
      return;
    }
    if (result.alreadyCurrent) {
      // 点当前版：控制器不重绘、不改地图，只就地确认状态
      panelToast.show(formatScaleCurrentNotice(card), { kind: 'info' });
      log.info('ui.scaleCard.current', { poolId: message.scalePoolId, cardId: card.id, sizeText });
      return;
    }
    if (result.refused) {
      // 复核未过原交付标准：保持当前版不变（不重绘、不切换）
      panelToast.show(SCALE_SWITCH_REFUSED_NOTICE, { kind: 'warn' });
      log.warn('ui.scaleCard.refused', { poolId: message.scalePoolId, cardId: card.id, sizeText });
      return;
    }
    const shape = result.shape
      ? store.appendShape(sessionId, {
          ...result.shape,
          turnId: message.id,
          label: describeShape(result.shape),
        })
      : null;
    state.suppressRender = true;
    try {
      // 活跃池与归属消息同步：切换后的当前版/截断立即反映到拥有卡片行的消息；
      // "查看此图形"入口与目标点序列图同步到切换版（地图/消息/历史图形三处一致）
      state.pendingScalePool = result.scalePool ?? null;
      if (state.pendingScalePool) {
        store.updateMessage(sessionId, message.id, {
          scaleCandidates: state.pendingScalePool.cards,
          scaleCurrentCardId: state.pendingScalePool.currentCardId,
          scaleHiddenCount: state.pendingScalePool.hiddenCount,
          ...(shape ? { shapeId: shape.id } : {}),
          ...(result.outline ? { outline: result.outline } : {}),
        });
      }
      deps.saveContext();
    } finally {
      state.suppressRender = false;
    }
    store.flush();
    refreshMessageNode(message.id);
    panelToast.show(formatScaleSwitchNotice(card, engine.formatMinutes), { kind: 'info' });
    log.info('ui.scaleCard.applied', {
      poolId: message.scalePoolId,
      cardId: card.id,
      sizeText,
      shapeId: shape?.id ?? null,
      messageId: message.id,
      messagesAdded: 0,
    });
  }

  /**
   * 用户点击候选（方案 §6.2）：写入 reference-selection 消息 → 调用
   * chooseReferenceCandidate（新规划轮 trace）→ 落最终回复；
   * 选择后更新候选消息的 selectedCandidateId 并清除未选候选完整几何。
   *
   * @param {object} choice 待选快照
   * @param {object} candidate 被选候选
   * @param {string} displayName 候选显示名（用户消息文案用）
   */
  async function selectReferenceCandidate(choice, candidate, displayName) {
    if (state.sending) {
      return;
    }
    const sessionId = store.getActiveId();
    if (!sessionId) {
      return;
    }
    log.info('ui.reference.select', {
      choiceId: choice.choiceId,
      candidateId: candidate.candidateId,
      contentHash: candidate.contentHash,
    });
    // 用户点击选择消息（本地状态机交互，不占用 LLM 对话轮次）
    store.appendMessage(sessionId, {
      role: 'user',
      kind: 'reference-selection',
      text: `选择「${displayName}」`,
      referenceChoiceId: choice.choiceId,
      selectedCandidateId: candidate.candidateId,
      status: 'done',
    });
    store.flush();
    sendFlow.setSending(true);
    const { signal, steps, liveSteps } = sendFlow.beginLiveTurn();
    const onStep = liveSteps.onStep;

    try {
      const result = await controller.chooseReferenceCandidate(
        { choiceId: choice.choiceId, candidateId: candidate.candidateId, contentHash: candidate.contentHash },
        onStep,
        { signal },
      );
      if (signal.aborted) {
        throw createAbortError('已停止');
      }
      const shape = result.shape
        ? store.appendShape(sessionId, { ...result.shape, label: describeShape(result.shape) })
        : null;
      state.suppressRender = true;
      try {
        const agentMessage = sendFlow.appendAgentReply(sessionId, { result, steps, shape });
        // 参考图点选后的规划轮：新交付的卡片行挂在本条回复消息上
        state.pendingScalePool = result.scalePool
          ? controller.attachScalePoolMessage(result.scalePool.poolId, agentMessage.id)
          : null;
        // 候选消息留选择记录（未选候选几何已在控制器里清除）
        if (choice.choiceId) {
          const session = store.getSession(sessionId);
          const candidatesMessage = session?.messages.find(
            (message) => message.kind === 'reference-candidates' && message.referenceChoiceId === choice.choiceId,
          );
          if (candidatesMessage) {
            store.updateMessage(sessionId, candidatesMessage.id, { selectedCandidateId: candidate.candidateId });
          }
        }
      } finally {
        state.suppressRender = false;
      }
      // 选择完成：待选清空（控制器侧 status='selected' 随上下文留痕）
      state.pendingReferenceChoice = null;
      sendFlow.commitTurn();
    } catch (error) {
      const stopped = isAbortError(error) || signal.aborted;
      const traceId = error?.traceId || null;
      sendFlow.appendTurnOutcome(sessionId, { stopped, error, steps, traceId });
      if (!stopped) {
        log.error('ui.reference.select.failed', { choiceId: choice.choiceId }, error);
      }
      // 失败/停止恢复待选（控制器已恢复 awaiting 快照），可换一张卡重选
      state.pendingReferenceChoice = controller.exportContext().referenceChoice ?? null;
      sendFlow.commitTurn();
      if (stopped) {
        log.info('ui.reference.select.stopped', { choiceId: choice.choiceId });
      }
    } finally {
      sendFlow.finishTurn(liveSteps);
    }
  }

  return { switchScale, selectReferenceCandidate, refreshMessageNode };
}
