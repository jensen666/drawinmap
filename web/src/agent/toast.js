/**
 * 对话面板轻提示（toast）：就地操作（点选比例尺卡片等）的即时反馈。
 *
 * 与消息气泡的区别：不进入会话存储、不占消息流、不改变消息区滚动位置；
 * 同一条提示反复触发只更新文本并重置消失计时，几秒后自动淡出。
 * DOM 常驻（保留最后一条文本，便于无障碍与 E2E 读取），用 is-visible 控制显隐。
 */

/** 默认自动消失时长（毫秒） */
const DEFAULT_DURATION_MS = 3000;

/** 类型 → class（未列出的类型按 info 处理） */
const KIND_CLASSES = { info: 'is-info', warn: 'is-warn', error: 'is-error' };

/**
 * 创建面板内轻提示控制器。
 *
 * @param {HTMLElement} host 挂载容器（如 #agent-panel，需是定位元素）
 * @param {{durationMs?: number}} [options] 自动消失时长
 * @returns {{show: (text: string, options?: {kind?: 'info'|'warn'|'error'}) => void,
 *   hide: () => void, dispose: () => void, element: HTMLElement}} 控制器
 */
export function createPanelToast(host, { durationMs = DEFAULT_DURATION_MS } = {}) {
  if (!host) {
    throw new Error('createPanelToast 需要挂载容器');
  }
  const element = document.createElement('div');
  element.className = 'agent-toast';
  element.setAttribute('role', 'status');
  element.setAttribute('aria-live', 'polite');
  host.appendChild(element);
  /** 自动消失计时器（连续触发时重置，null = 没有在计时） */
  let timer = null;

  /** 立刻隐藏（不移除 DOM，保留最后一条文本） */
  function hide() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    element.classList.remove('is-visible');
  }

  /**
   * 显示一条提示（同一条提示重复触发会重置消失计时）。
   *
   * @param {string} text 提示文本
   * @param {{kind?: 'info'|'warn'|'error'}} [options] 类型（默认 info）
   */
  function show(text, { kind = 'info' } = {}) {
    if (!text) {
      return;
    }
    element.textContent = text;
    element.classList.remove('is-info', 'is-warn', 'is-error');
    element.classList.add(KIND_CLASSES[kind] ?? KIND_CLASSES.info);
    // 强制回流后再加 is-visible：连续触发也能重新触发淡入
    void element.offsetWidth;
    element.classList.add('is-visible');
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      element.classList.remove('is-visible');
    }, durationMs);
  }

  /** 销毁：移除 DOM 并取消计时 */
  function dispose() {
    hide();
    element.remove();
  }

  return { show, hide, dispose, element };
}
