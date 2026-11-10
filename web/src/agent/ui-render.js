/**
 * 智能体消息区渲染（从 ui.js 拆出，C1 纯移动：逻辑/文案/DOM 结构/时序均未改）。
 *
 * 职责：消息气泡、chip 行、卡片外壳、状态备注、目标点序列图、trace 复制条、
 * 推理过程折叠块与实时步骤渲染等"渲染基元"；全部文本走 textContent，禁止 innerHTML。
 *
 * 依赖约定：不持有可变状态、不做业务决策。需要面板状态或交互回调时，
 * 由 ui.js 在调用处通过显式 `deps` 参数注入（禁止模块级全局变量）。
 * - renderMessage(message, messages, deps)：deps.state（panelState 只读）+
 *   deps.appendScaleCards（卡片行渲染回调，属 ui-cards.js，装配时注入）；
 * - renderPendingGuide(messagesEl, guide, deps)：deps.sending / deps.onPick / deps.scrollToBottom；
 * - createLiveStepRenderer / appendErrorMessage：scrollToBottom 回调注入。
 *
 * 日志模块名保持 'agent/ui'（拆分不改变日志事件名与模块标记，便于沿用既有排查口径）。
 */

import { shouldShowHistoryOptions } from './option-rows.js';
import { copyText } from '../clipboard.js';
import { createLogger } from '../log/index.js';
import { createStepClock, formatElapsedSuffix } from './live-step-clock.js';

/** 模块 logger：复用 agent/ui 事件名（拆分不改变日志事件名） */
const log = createLogger('agent/ui');

/** 推理过程来源标签（目标点序列图注） */
const OUTLINE_SOURCE_LABELS = {
  reference: '参考图命中',
  procedural: '参数化生成',
  traced: '图像描摹',
  llm: 'AI 生成',
  builtin: '内置图形',
};

/**
 * 渲染一行引导/示例芯片（历史选项/待补引导/快捷示例三处同构；文本全走 textContent）。
 * options: { asStatic, disabled, title, onPick }；items 为空时整个行不渲染。
 *
 * @param {HTMLElement} container 挂载容器
 * @param {string|null} rowClass 行容器 class；null = 芯片直接追加到容器
 * @param {Array<{label: string, value: string}>} items 芯片项
 * @returns {HTMLElement|null} 行容器
 */
export function renderChipRow(container, rowClass, items, { asStatic = false, disabled = false, title = null, onPick = null } = {}) {
  if (items.length === 0) {
    return null;
  }
  const row = rowClass ? document.createElement('div') : container;
  if (rowClass) {
    row.className = rowClass;
  }
  for (const item of items) {
    const chip = document.createElement(asStatic ? 'span' : 'button');
    if (!asStatic) {
      chip.type = 'button';
      chip.disabled = disabled;
    }
    chip.className = asStatic ? 'agent-chip is-static' : 'agent-chip';
    chip.textContent = item.label;
    if (title) {
      chip.title = title;
    }
    if (!asStatic && onPick) {
      chip.addEventListener('click', () => onPick(item));
    }
    row.appendChild(chip);
  }
  if (row !== container) {
    container.appendChild(row);
  }
  return row === container ? null : row;
}

/**
 * 创建卡片按钮外壳（比例尺卡与参考候选卡共用；只合外壳，字段映射各自保留）。
 *
 * @param {{className: string, disabled: boolean, title?: string|null, onClick?: Function|null}} options 外壳参数
 */
export function createCardShell({ className, disabled, title = null, onClick = null }) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = className;
  card.disabled = disabled;
  if (title) {
    card.title = title;
  }
  if (onClick) {
    card.addEventListener('click', onClick);
  }
  return card;
}

/**
 * 在消息气泡内追加一条状态备注（已停止 / 等待回复 / 回复未完成）。
 *
 * @param {HTMLElement} item 消息节点
 * @param {string} text 备注文案
 */
export function appendNote(item, text) {
  const note = document.createElement('div');
  note.className = 'agent-msg-note';
  note.textContent = text;
  item.appendChild(note);
}

/**
 * 在消息气泡底部追加本轮 traceId 复制条：
 * 看到哪一轮画得不对，直接点一下复制完整 traceId（发给编程工具按 trace 定位），
 * 不用再打开日志抽屉按关键词找。
 *
 * @param {HTMLElement} item 消息节点（助手回复气泡）
 * @param {string|null} traceId 本轮链路 id
 */
export function appendTraceCopy(item, traceId) {
  if (!traceId) {
    return;
  }
  const row = document.createElement('div');
  row.className = 'agent-msg-trace';
  const label = document.createElement('span');
  label.className = 'agent-trace-label';
  label.textContent = 'trace';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'agent-trace-copy';
  button.textContent = traceId;
  button.title = `点击复制本轮 traceId（画得不对时发给编程工具定位）：${traceId}`;
  /** 复制反馈的恢复计时器（连点时重置，避免状态错乱） */
  let resetTimer = null;
  button.addEventListener('click', async () => {
    const copied = await copyText(traceId);
    log.info('ui.trace.copy', { traceId, copied });
    button.textContent = copied ? '已复制 traceId' : '复制失败';
    button.classList.toggle('is-copied', copied);
    if (resetTimer !== null) {
      clearTimeout(resetTimer);
    }
    resetTimer = setTimeout(() => {
      button.textContent = traceId;
      button.classList.remove('is-copied');
      resetTimer = null;
    }, 1600);
  });
  row.append(label, button);
  item.appendChild(row);
}

/**
 * 在回复气泡底部追加目标点序列图（点列渲染小图 + 来源说明）：
 * 地图画的是贴路网后的路线，这里直接展示系统理解的目标形状——
 * 参考图命中对不对、LLM 画的是什么，一眼可查。带交付朝向时图注追加
 * 「朝向 X°」（小图已按该朝向刚体旋转，与地图紫色虚线一致）。
 *
 * @param {HTMLElement} item 消息节点（助手回复气泡）
 * @param {{name: string|null, source: string, pointCount: number, rotationDeg?: number|null, dataUrl: string}} outline 点序列图预览
 */
export function appendOutlinePreview(item, outline) {
  const figure = document.createElement('figure');
  figure.className = 'agent-outline';
  const img = document.createElement('img');
  img.className = 'agent-outline-img';
  img.src = outline.dataUrl;
  img.alt = `目标点序列：${outline.name || '图形'}`;
  const caption = document.createElement('figcaption');
  caption.className = 'agent-outline-caption';
  const rotationSuffix =
    Number.isFinite(outline.rotationDeg) && outline.rotationDeg !== 0
      ? ` · 朝向 ${outline.rotationDeg}°`
      : '';
  caption.textContent = `目标点序列「${outline.name || '图形'}」· ${outline.pointCount} 点 · ${
    OUTLINE_SOURCE_LABELS[outline.source] || outline.source
  }${rotationSuffix}`;
  figure.append(img, caption);
  item.appendChild(figure);
}

/**
 * 追加"查看此图形"入口（需求 R3：每个产生过图形的回复都能直接定位到那一轮的图形）。
 *
 * @param {HTMLElement} item 消息节点
 * @param {string} shapeId 图形 id
 */
export function appendShapeEntry(item, shapeId) {
  const row = document.createElement('div');
  row.className = 'agent-msg-shape';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'agent-shape-view';
  button.textContent = '查看此图形';
  button.title = '把这轮的图形切到地图上查看';
  button.addEventListener('click', () => {
    button.dispatchEvent(
      new CustomEvent('drawinmap:show-shape', { detail: { shapeId }, bubbles: true }),
    );
  });
  row.appendChild(button);
  item.appendChild(row);
}

/**
 * 创建实时推理过程渲染器（发送轮次与选择参考候选共用）：
 * - step 新起一行，progress 原地更新当前进度行；
 * - 当前步骤行尾每秒刷新「（已等待 Ns）」，步骤完成冻结成「（用时 Ns）」——
 *   非流式模型调用期间（实测 10~65 秒）界面必须看得出还在跑，不能像卡死；
 * - 被停止后不再回填界面（迟到步骤丢弃）。
 *
 * @param {HTMLElement} stepsList 步骤列表容器（ol）
 * @param {Array<{text: string, kind: string}>} steps 本轮步骤累积（落盘用，不存耗时后缀）
 * @param {() => boolean} isAborted 本轮是否已停止
 * @param {() => void} scrollToBottom 滚动消息区到底部（装配时注入）
 * @returns {{onStep: (step: {text: string, kind?: string}) => void, dispose: () => void}}
 */
export function createLiveStepRenderer(stepsList, steps, isAborted, scrollToBottom) {
  let progressLine = null;
  let elapsedSuffix = null;
  const clock = createStepClock({
    onTick: (elapsedMs, phase) => {
      if (elapsedSuffix) {
        elapsedSuffix.textContent = formatElapsedSuffix(elapsedMs, phase);
      }
    },
  });
  const onStep = (step) => {
    if (!step || !step.text || isAborted()) {
      return;
    }
    if (step.kind === 'progress' && progressLine) {
      // 搜索进度原地更新（同一行反复刷新，不新起步骤、不计时）
      progressLine.textContent = step.text;
    } else {
      // 新行出现＝上一步完成：先把上一步的秒数冻结成「用时」
      clock.finish();
      const li = document.createElement('li');
      li.textContent = step.text;
      stepsList.appendChild(li);
      steps.push({ text: step.text, kind: step.kind || 'step' });
      progressLine = step.kind === 'progress' ? li : null;
      if (progressLine) {
        elapsedSuffix = null;
      } else {
        elapsedSuffix = document.createElement('span');
        elapsedSuffix.className = 'agent-step-elapsed';
        li.appendChild(elapsedSuffix);
        clock.start();
      }
    }
    scrollToBottom();
  };
  return { onStep, dispose: () => clock.dispose() };
}

/**
 * 追加一条错误提示（不进入会话历史）。
 *
 * @param {HTMLElement} messagesEl 消息区容器
 * @param {string} text 错误文案
 * @param {() => void} scrollToBottom 滚动消息区到底部（装配时注入）
 */
export function appendErrorMessage(messagesEl, text, scrollToBottom) {
  const item = document.createElement('div');
  item.className = 'agent-msg agent-msg-error';
  item.textContent = text;
  messagesEl.appendChild(item);
  scrollToBottom();
}

/**
 * 图形快照的可读描述（切换控件的 title 用）。
 *
 * @param {object} shape 图形快照
 * @returns {string} 描述文本
 */
export function describeShape(shape) {
  const parts = [];
  if (shape.shapeName) {
    parts.push(shape.shapeName);
  }
  if (Number.isFinite(shape.sizeMeters)) {
    parts.push(`${(shape.sizeMeters / 1000).toFixed(1)} km`);
  }
  if (Number.isFinite(shape.rotationDeg)) {
    parts.push(`朝向 ${shape.rotationDeg}°`);
  }
  if (shape.reference) {
    parts.push('非合格参考版');
  }
  return parts.join(' · ') || '图形';
}

/**
 * 渲染待补的引导选项（可点：当前会话的实时引导状态）。
 *
 * @param {HTMLElement} messagesEl 消息区容器
 * @param {{slot: string, options: Array<{label: string, value: string}>}|null} guide 引导状态
 * @param {{sending: boolean, onPick: Function, scrollToBottom: Function}} deps 显式依赖（装配时注入）
 */
export function renderPendingGuide(messagesEl, guide, deps) {
  messagesEl.querySelectorAll('.agent-options.is-live').forEach((el) => el.remove());
  const options = Array.isArray(guide?.options) ? guide.options : [];
  if (options.length === 0) {
    return;
  }
  renderChipRow(messagesEl, 'agent-options is-live', options, {
    disabled: deps.sending,
    onPick: deps.onPick,
  });
  deps.scrollToBottom();
}

/**
 * 渲染一条消息记录为 DOM 节点。
 *
 * @param {object} message 消息记录
 * @param {Array<object>} [messages] 当前会话消息（判断这条引导是否已被回答）
 * @param {{state: object, appendScaleCards: Function}} deps 显式依赖：
 *   state.expandedReasoning / state.pendingGuide（只读）；appendScaleCards 由 ui-cards 注入
 * @returns {HTMLElement} 消息节点
 */
export function renderMessage(message, messages, deps) {
  const item = document.createElement('div');
  item.className = `agent-msg agent-msg-${message.role}`;
  item.dataset.messageId = message.id;
  if (message.image) {
    const img = document.createElement('img');
    img.className = 'agent-msg-img';
    img.src = message.image;
    img.alt = '上传的图片';
    item.appendChild(img);
  }
  if (message.text) {
    const body = document.createElement('div');
    body.className = 'agent-msg-text';
    body.textContent = message.text;
    item.appendChild(body);
  }
  if (message.status === 'stopped') {
    appendNote(item, '本轮已停止，未交付任何结果。');
  }
  if (
    message.role === 'user'
    && (message.status === 'waiting' || message.status === 'interrupted' || message.status === 'stopped')
  ) {
    appendNote(
      item,
      message.status === 'waiting'
        ? '（等待回复…）'
        : message.status === 'stopped'
          ? '（本轮已停止，可重新发送一次）'
          : '（该轮回复未完成，可重新发送一次）',
    );
  }
  // 推理过程：完成后收进可展开的折叠块
  if (Array.isArray(message.steps) && message.steps.length > 0) {
    const details = document.createElement('details');
    details.className = 'agent-reasoning';
    details.dataset.messageId = message.id;
    const summary = document.createElement('summary');
    summary.textContent = `推理过程（${message.steps.length} 步）`;
    details.appendChild(summary);
    const list = document.createElement('ol');
    list.className = 'agent-reasoning-steps';
    for (const step of message.steps) {
      const li = document.createElement('li');
      li.textContent = step.text;
      list.appendChild(li);
    }
    details.appendChild(list);
    details.open = deps.state.expandedReasoning.has(message.id);
    details.addEventListener('toggle', () => {
      if (details.open) {
        deps.state.expandedReasoning.add(message.id);
      } else {
        deps.state.expandedReasoning.delete(message.id);
      }
    });
    item.appendChild(details);
  }
  if (message.outline?.dataUrl) {
    appendOutlinePreview(item, message.outline);
  }
  if (message.shapeId) {
    appendShapeEntry(item, message.shapeId);
  }
  if (Array.isArray(message.scaleCandidates) && message.scaleCandidates.length >= 2) {
    deps.appendScaleCards(item, message);
  }
  if (shouldShowHistoryOptions({ message, messages: messages || [], pendingGuide: deps.state.pendingGuide })) {
    // 历史引导选项（不可点）：只在「问题还没答、且当前没有可点引导」时展示，
    // 避免和底部可点行叠成两套都像能点的芯片
    renderChipRow(item, 'agent-options is-history', message.options, {
      asStatic: true,
      title: '历史引导选项（回到该对话后可直接输入文字继续）',
    });
  }
  if (message.action === 'open-config') {
    // 未配置兜底气泡的「去配置」入口（R1/R7）：点开设置界面，不写消息、不动历史
    const openConfig = document.createElement('button');
    openConfig.type = 'button';
    openConfig.className = 'agent-open-config';
    openConfig.textContent = '去配置';
    openConfig.addEventListener('click', () => {
      deps.openConfigPanel?.();
    });
    item.appendChild(openConfig);
  }
  appendTraceCopy(item, message.traceId);
  return item;
}
