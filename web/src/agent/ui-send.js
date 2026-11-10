/**
 * 智能体对话轮次的发送 / 停止主流程（从 ui.js 拆出，C1 纯移动：逻辑/文案/时序未改）。
 *
 * 职责：
 * - sendText / doSend / stopTurn：一轮对话的完整生命周期（用户消息落盘 → 实时推理气泡
 *   → 控制器调用 → 回复落盘 → 停止/失败收尾）；
 * - 生命周期基元：beginLiveTurn / finishTurn / appendTurnOutcome / commitTurn /
 *   appendAgentReply / endLiveBubble；
 * - 输入态：setSending / clearPendingImage / resizeInput。
 *
 * 依赖约定：通过 createSendFlow(deps) 显式注入（禁止模块级全局变量）：
 * - state（面板可变状态，读写）、store、controller；
 * - elements（messagesEl/inputEl/imageBtn/sendBtn/attachBar/imageInput）；
 * - onBusyChange、renderAll、saveContext、scrollToBottom 回调。
 * 渲染基元（createLiveStepRenderer/describeShape）从 ui-render.js import。
 * 日志模块名保持 'agent/ui'（事件名不变，沿用既有排查口径）。
 */

import { createAbortError, isAbortError } from '../cancel.js';
import { createLogger } from '../log/index.js';
import { resolveEffectiveConfig } from './llm-config.js';
import { createLiveStepRenderer, describeShape } from './ui-render.js';

/** 模块 logger：用户操作（发送/停止）与轮次失败 */
const log = createLogger('agent/ui');

/** 轮次进行中需要禁用的消息内控件（统一门禁，避免逐个手写循环） */
const BUSY_DISABLED_SELECTORS = [
  '.agent-shape-view',
  '.agent-options.is-live .agent-chip',
  '.agent-reference-choice.is-live .agent-ref-card',
  '.agent-scale-cards.is-live .agent-scale-card',
];

/**
 * 创建发送流程控制器。
 *
 * @param {object} deps 显式依赖（装配时注入）
 * @param {object} deps.state 面板可变状态（读写）
 * @param {object} deps.store 会话存储
 * @param {object} deps.controller 智能体控制器
 * @param {object} deps.elements DOM 引用（messagesEl/inputEl/imageBtn/sendBtn/attachBar/imageInput）
 * @param {(busy: boolean) => void} deps.onBusyChange 轮次状态变化回调
 * @param {Function} deps.renderAll 整表重绘
 * @param {Function} deps.saveContext 保存上下文快照
 * @param {Function} deps.scrollToBottom 滚动消息区到底部
 * @returns {object} 发送流程接口（sendText/doSend/stopTurn + 生命周期基元 + 输入态）
 */
export function createSendFlow(deps) {
  const { state, store, controller, elements, onBusyChange } = deps;
  const { messagesEl, inputEl, imageBtn, sendBtn, attachBar, imageInput } = elements;
  /** 发送闸门：生效配置解析是异步的，占住 await 窗口，防止双击并发两轮 */
  let sendGate = false;

  /**
   * 移除实时推理气泡（轮次收尾时调用，避免与落盘后的正式气泡重复）。
   */
  function endLiveBubble() {
    if (state.liveBubble) {
      state.liveBubble.remove();
      state.liveBubble = null;
    }
  }

  /** 开启一轮实时推理气泡（发送轮与选择参考候选轮共用）：返回本轮信号、步骤收集器与中止控制器 */
  function beginLiveTurn() {
    state.turnController = new AbortController();
    const { signal } = state.turnController;
    const thinking = document.createElement('div');
    thinking.className = 'agent-msg agent-msg-agent is-pending is-reasoning';
    state.liveBubble = thinking;
    messagesEl.appendChild(thinking);
    const stepsList = document.createElement('ol');
    stepsList.className = 'agent-reasoning-steps';
    thinking.appendChild(stepsList);
    /** 实时收集的推理步骤（停止时也保留可查） */
    const steps = [];
    const liveSteps = createLiveStepRenderer(stepsList, steps, () => signal.aborted, deps.scrollToBottom);
    return { signal, steps, liveSteps };
  }

  /** 轮次收尾（成功/失败/停止共用）：清中止控制器、释放计时器、恢复输入区 */
  function finishTurn(liveSteps) {
    state.turnController = null;
    liveSteps.dispose();
    endLiveBubble();
    setSending(false);
    inputEl.focus();
    deps.scrollToBottom();
  }

  /**
   * 轮次停止/失败的落盘与提示（发送轮与选择参考候选轮共用）。
   *
   * @param {string} sessionId 会话 id
   * @param {{stopped: boolean, error: Error, steps: Array, traceId: string|null, userMessageId?: string|null}} outcome 结束状态
   */
  function appendTurnOutcome(sessionId, { stopped, error, steps, traceId, userMessageId = null }) {
    state.suppressRender = true;
    try {
      if (userMessageId) {
        // 停止不是"未完成"：标记"已停止"，刷新后仍可区分停止与超时/失败
        store.updateMessage(sessionId, userMessageId, { status: stopped ? 'stopped' : 'done' });
      }
      if (stopped) {
        // 停止不是失败：已产生的推理过程保留可查
        store.appendMessage(sessionId, { role: 'agent', text: '已停止本轮。', steps, traceId, status: 'stopped' });
      } else if (error?.kind === 'unconfigured') {
        // 模型层兜底（R7）：配置在发送后失效/缺失 → 持久化「去配置」错误气泡
        store.appendMessage(sessionId, {
          role: 'error',
          text: error.message,
          traceId,
          action: 'open-config',
          status: 'failed',
        });
      } else {
        store.appendMessage(sessionId, { role: 'error', text: error.message, traceId, status: 'failed' });
      }
    } finally {
      state.suppressRender = false;
    }
  }

  /** 轮次成功收尾：上下文落盘 → 存储落盘 → 移除实时气泡 → 整表重绘 */
  function commitTurn() {
    deps.saveContext();
    store.flush();
    endLiveBubble();
    deps.renderAll();
  }

  /**
   * 落盘一条智能体回复消息（发送轮与选择参考候选轮共用；字段逐字相同）。
   *
   * @param {string} sessionId 会话 id
   * @param {{result: object, steps: Array, shape: object|null}} payload 回复数据
   */
  function appendAgentReply(sessionId, { result, steps, shape }) {
    return store.appendMessage(sessionId, {
      role: 'agent',
      text: result.reply,
      steps,
      traceId: result.traceId || null,
      // 点序列图整对象落盘（含 traced 的 contentHash/归一化 points）：
      // 供链路验收读取页面真实点列做独立 IoU 校验，不能只存渲染图
      outline: result.outline || null,
      options: result.guide?.options?.length ? result.guide.options : null,
      shapeId: shape?.id || null,
      // 多比例尺候选卡片摘要（需求 2026-11-09）：随消息持久化，刷新后静态可见
      scaleCandidates: result.scalePool?.cards ?? null,
      scalePoolId: result.scalePool?.poolId ?? null,
      scaleCurrentCardId: result.scalePool?.currentCardId ?? null,
      scaleHiddenCount: result.scalePool?.hiddenCount ?? null,
      status: 'done',
    });
  }

  /** 设置发送中状态（发送中：发送按钮变"停止"，输入区禁用） */
  function setSending(value) {
    state.sending = value;
    sendBtn.textContent = value ? '停止' : '发送';
    sendBtn.classList.toggle('is-stop', value);
    sendBtn.title = value ? '停止本轮（模型请求与图形搜索都会中断）' : '发送';
    inputEl.disabled = value;
    imageBtn.disabled = value;
    // 轮次进行中：消息内可点控件统一禁用（查看图形 / 待补引导 / 候选卡 / 比例尺卡，
    // 与图形切换控件同一道门禁，R5/R6 状态一致）
    for (const selector of BUSY_DISABLED_SELECTORS) {
      messagesEl.querySelectorAll(selector).forEach((button) => {
        button.disabled = value;
      });
    }
    if (!value) {
      resizeInput();
    }
    // 轮次进行中：会话切换/图形切换/新建/删除全部禁用（R6 状态一致）
    onBusyChange(value);
  }

  /** 清除待发送图片 */
  function clearPendingImage() {
    state.pendingImage = null;
    attachBar.setAttribute('hidden', '');
    imageInput.value = '';
  }

  /** 输入框自适应高度：随内容长高（上限 96px 见 CSS），发送后收回单行 */
  function resizeInput() {
    inputEl.style.height = 'auto';
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, 96)}px`;
  }

  /**
   * 发送一轮对话（label 为用户气泡显示文本，缺省同 text）。
   * 推理过程实时逐行显示（step 新起一行、progress 原地更新），完成后收进
   * 可展开的"推理过程"折叠块，最终回复在其下方。
   *
   * @param {string} text 用户输入
   * @param {string} [label] 用户气泡显示文本
   */
  async function sendText(text, label = text) {
    if (state.sending || sendGate || (!text && !state.pendingImage)) {
      return;
    }
    // 未配置闸门（R7）：不写消息、不清空输入、不调模型，只提示并高亮「去配置」入口。
    // 闸门必须在 await 期间占位：两次点击都会先通过 sending 检查，靠 sendGate 保证只发一轮
    sendGate = true;
    let effective = null;
    try {
      effective = await resolveEffectiveConfig();
    } finally {
      sendGate = false;
    }
    if (state.sending) {
      return;
    }
    if (!effective?.config) {
      log.warn('ui.send.blocked.unconfigured', { textLength: text.length });
      deps.panelToast.show('尚未配置 LLM，请点上方「去配置」填写', { kind: 'warn' });
      deps.configPanel.flash();
      return;
    }
    const image = state.pendingImage;
    // 空对话状态（删除当前对话后没有当前会话）：发送时才创建会话，避免启动/新建时凭空多出空对话
    let sessionId = store.getActiveId();
    if (!sessionId) {
      sessionId = store.createSession().id;
      log.info('ui.session.created-on-send', { sessionId });
    }
    if (!sessionId) {
      return;
    }
    // 用户已经给出回答：可点选项立刻收起并落盘。
    // appendMessage 会整表重绘；若此时 state.pendingGuide 还在，可点行会被画在实时推理气泡前面，
    // 回复输出过程中选项还留着。气泡内的同一组选项也要一起收起（见 shouldShowHistoryOptions）。
    if (state.pendingGuide) {
      state.pendingGuide = null;
      log.info('ui.guide.dismiss', { reason: 'user-replied', sessionId });
      deps.saveContext();
    }
    log.info('ui.send', {
      text,
      textLength: text.length,
      hasImage: Boolean(image),
      imageDataUrl: image,
      imageLength: image ? image.length : 0,
    });
    // 用户消息**发送瞬间**写入存储（刷新不丢用户输入）
    // 写入即触发 store 的 'messages' 事件 → 整表重绘 → 用户气泡立刻可见（不等回复）
    const userMessage = store.appendMessage(sessionId, {
      role: 'user',
      text: label,
      image,
      status: 'waiting',
    });
    // 立即落盘（不等 300ms 去抖）：回复未回就刷新/关页也不丢这条用户输入
    store.flush();
    inputEl.value = '';
    clearPendingImage();
    setSending(true);

    // 本轮中止控制器（"停止"用；onStep 守卫与收尾判定都用同一个信号）+ 实时推理气泡
    // （气泡不写存储，回复到达后一次性落盘）
    const { signal, steps, liveSteps } = beginLiveTurn();
    const onStep = liveSteps.onStep;

    try {
      // 三路候选追加回调（方案 2026-11-01 §2）：本地/在线/自由轮廓三路并行，卡片随结果
      // 到达追加，不等最慢一路。轮次结束后剩余路仍可能返回——此时实时重绘候选卡；
      // 轮次进行中只更新待选快照（等本轮结束统一落盘/重绘）。
      const onReferenceCandidate = (choice) => {
        if (signal.aborted || !choice || choice.status !== 'awaiting-selection') {
          return;
        }
        // 迟到回调只允许更新当前会话（切换会话后旧快照不得写入新会话上下文）
        if (store.getActiveId() !== sessionId) {
          return;
        }
        state.pendingReferenceChoice = choice;
        deps.saveContext();
        if (!state.sending) {
          deps.renderAll();
        }
      };
      const result = await controller.send({ text, imageDataUrl: image }, onStep, {
        signal,
        onReferenceCandidate,
      });
      // 停止检查点（兜底）：被停止的轮次不得把迟到结果当正常完成写入会话
      if (signal.aborted) {
        throw createAbortError('已停止');
      }
      // 落盘：用户消息标记完成 + 智能体消息（含推理过程/目标小图/traceId/图形快照）
      const shape = result.shape
        ? store.appendShape(sessionId, {
            ...result.shape,
            turnId: userMessage.id,
            label: describeShape(result.shape),
          })
        : null;
      /** 本轮回复消息记录（多比例尺卡片行挂在这条消息上） */
      let agentMessage = null;
      state.suppressRender = true;
      try {
        store.updateMessage(sessionId, userMessage.id, { status: 'done' });
        if (result.referenceChoice) {
          // 候选回复消息（方案 §6.3）：只留 referenceChoiceId/traceId 关联，
          // 不在消息里重复保存候选几何（待选几何在 context.referenceChoice）
          store.appendMessage(sessionId, {
            role: 'agent',
            kind: 'reference-candidates',
            text: result.reply,
            steps,
            traceId: result.traceId || null,
            referenceChoiceId: result.referenceChoice.choiceId,
            status: 'done',
          });
        } else {
          agentMessage = appendAgentReply(sessionId, { result, steps, shape });
        }
      } finally {
        state.suppressRender = false;
      }
      state.pendingGuide = result.guide?.options?.length ? result.guide : null;
      // 待选候选：来自控制器快照（新输入已在控制器侧放弃旧待选）
      state.pendingReferenceChoice = result.referenceChoice ?? null;
      // 多比例尺候选池（需求 2026-11-09）：
      // - 新交付（回复消息即卡片行）：绑定归属消息，卡片行可点；
      // - 文字切换（池已有归属消息）：卡片行留在原交付消息上，就地更新选中态/截断；
      // - 其它轮次（chat/引导/推荐/失败/橙版）：无活池，历史卡片行全部转静态。
      if (result.scalePool) {
        state.pendingScalePool = result.scalePool.ownerMessageId
          ? result.scalePool
          : controller.attachScalePoolMessage(result.scalePool.poolId, agentMessage?.id ?? null);
        if (result.scalePool.ownerMessageId) {
          store.updateMessage(sessionId, result.scalePool.ownerMessageId, {
            scaleCandidates: result.scalePool.cards,
            scaleCurrentCardId: result.scalePool.currentCardId,
            scaleHiddenCount: result.scalePool.hiddenCount,
          });
        }
      } else {
        state.pendingScalePool = null;
      }
      // 本轮结果立即落盘（回复、图形快照、上下文一起写），不等去抖窗口
      commitTurn();
    } catch (error) {
      const stopped = isAbortError(error) || signal.aborted;
      const traceId = error?.traceId || null;
      appendTurnOutcome(sessionId, { stopped, error, steps, traceId, userMessageId: userMessage.id });
      if (!stopped) {
        log.error('ui.send.failed', { text, hasImage: Boolean(image) }, error);
        if (error?.kind === 'unconfigured') {
          log.warn('ui.send.failed.unconfigured', { textLength: text.length });
        }
      }
      state.pendingGuide = null;
      // 新输入已在控制器侧放弃旧待选（错误/停止轮同样不保留）
      state.pendingReferenceChoice = controller.exportContext().referenceChoice ?? null;
      // 错误/停止轮不保留活池（新输入已在控制器侧丢弃；卡片行转静态）
      state.pendingScalePool = null;
      // 停止/失败结论与已产生的推理过程也要立刻落盘（刷新后可见"已停止"与步骤）
      commitTurn();
      if (stopped) {
        log.info('ui.send.stopped', { text, traceId });
      }
    } finally {
      finishTurn(liveSteps);
    }
  }

  /** 发送输入框内容 */
  async function doSend() {
    await sendText(inputEl.value.trim());
  }

  /** 停止进行中的轮次（真正中断模型请求与图形搜索） */
  function stopTurn() {
    if (!state.turnController || state.turnController.signal.aborted) {
      return;
    }
    log.info('ui.stop', {});
    state.turnController.abort();
  }

  return {
    sendText,
    doSend,
    stopTurn,
    beginLiveTurn,
    finishTurn,
    appendTurnOutcome,
    commitTurn,
    appendAgentReply,
    setSending,
    clearPendingImage,
    resizeInput,
  };
}
