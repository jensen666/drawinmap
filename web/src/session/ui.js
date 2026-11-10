/**
 * 会话界面：历史对话列表（会话管理）+ 地图上的图形切换控件。
 *
 * 需求对应：
 * - R1 历史列表：新建/删除（二次确认）/空态/最近活跃倒序
 * - R2 切换对话后地图展示该对话最新图形并聚焦
 * - R3 对话内所有图形可前后切换 + "回到最新" + 每轮回复的"查看此图形"入口
 * - R6 控件分区：会话管理在对话面板旁，图形切换靠地图；窄屏不溢出
 *
 * 分层约定：
 * - 本模块只负责"视图 + 交互意图"，不直接改智能体状态；
 * - 切换对话时的上下文搬运（导出/导入 LLM 上下文、重绘消息、地图重画）
 *   交给 agent 层通过 agent 回调完成，保证"查看历史图形不影响对话理解"。
 */

import { createLogger } from '../log/index.js';

/** 模块 logger */
const log = createLogger('session/ui');

/**
 * 相对时间文本（今天用相对时间，跨天用日期）。
 *
 * @param {number} ts 时间戳（毫秒）
 * @returns {string} 时间文本
 */
function formatActivityTime(ts) {
  if (!Number.isFinite(ts)) {
    return '--';
  }
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60_000) {
    return '刚刚';
  }
  if (diff < 3_600_000) {
    return `${Math.floor(diff / 60_000)} 分钟前`;
  }
  const date = new Date(ts);
  const pad = (value) => String(value).padStart(2, '0');
  const today = new Date(now);
  const sameDay = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
  if (sameDay) {
    return `今天 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

/**
 * 初始化会话界面。
 *
 * @param {object} options
 * @param {object} options.store 会话存储
 * @param {object} options.engine 图形引擎（重绘历史图形用）
 * @param {object} options.agent 智能体接口（上下文搬运与消息重绘）
 * @param {() => void} [options.agent.beforeSwitch] 切换对话前：把当前上下文存回 store
 * @param {(sessionId: string) => void} [options.agent.afterSwitch] 切换对话后：恢复上下文并重绘
 * @param {(shapeId: string) => void} [options.agent.onShapeViewed] 用户查看某个图形后回调
 * @returns {object} 会话界面接口
 */
export function initSessionUI({ store, engine, agent = {} }) {
  const panel = document.getElementById('session-panel');
  const listEl = document.getElementById('session-list');
  const metaEl = document.getElementById('session-meta');
  const noteEl = document.getElementById('session-note');
  const closeBtn = document.getElementById('session-close');
  const newBtn = document.getElementById('agent-new-session');
  const historyBtn = document.getElementById('agent-history-toggle');

  const switcher = document.getElementById('shape-switcher');
  const indicatorEl = document.getElementById('shape-indicator');
  const prevBtn = document.getElementById('shape-prev');
  const nextBtn = document.getElementById('shape-next');
  const latestBtn = document.getElementById('shape-latest');

  /** 轮次进行中：切换对话/图形/删除全部禁用（R6 状态一致） */
  let busy = false;
  /** 待确认删除的会话 id */
  let pendingDeleteId = null;

  /**
   * 设置按钮禁用态（按钮可能不存在，统一兜空；历史列表与图形切换控件共用）。
   *
   * @param {HTMLButtonElement|null} button 按钮
   * @param {boolean} disabled 是否禁用
   */
  function setDisabled(button, disabled) {
    if (button) {
      button.disabled = disabled;
    }
  }

  /**
   * 是否只有"刚打开的空对话"（欢迎语不算消息）：此时历史列表显示空态提示。
   *
   * 两种情况都算空对话：① 还没有任何会话（首次进入/删除当前对话后的空对话状态）；
   * ② 只有当前一个空会话（有欢迎语但还没聊）。空对话不会再叠加出第二个空会话
   * （见 newSession 的复用逻辑），需求 R1"无历史时显示空态提示"始终可达。
   *
   * @param {Array<object>} sessions 会话列表
   * @returns {boolean} 是否展示空态
   */
  function onlyEmptyActiveSession(sessions) {
    const activeId = store.getActiveId();
    return sessions.length === 0
      || (sessions.length === 1
        && sessions[0].id === activeId
        && sessions[0].messageCount === 0
        && sessions[0].shapeCount === 0);
  }

  /**
   * 渲染存储提示（无法持久化时提示"历史不会保存"）。
   */
  function renderStorageNote() {
    if (!noteEl) {
      return;
    }
    if (!store.isStorageEnabled()) {
      noteEl.textContent = '历史不会保存：浏览器禁止了本地存储（隐私模式或配额受限）。';
      noteEl.removeAttribute('hidden');
      return;
    }
    const error = store.getStorageError();
    if (error) {
      noteEl.textContent = `历史保存受限：${error}`;
      noteEl.removeAttribute('hidden');
      return;
    }
    noteEl.setAttribute('hidden', '');
  }

  /**
   * 渲染历史对话列表。
   */
  function renderHistory() {
    if (!listEl) {
      return;
    }
    const sessions = store.listSessions();
    listEl.textContent = '';
    const activeId = store.getActiveId();
    if (onlyEmptyActiveSession(sessions)) {
      const empty = document.createElement('div');
      empty.className = 'session-empty';
      empty.textContent = '还没有历史对话。发一条消息就会自动出现在这里。';
      listEl.appendChild(empty);
    } else {
      for (const session of sessions) {
        const row = document.createElement('div');
        row.className = 'session-item';
        row.dataset.sessionId = session.id;
        if (session.id === activeId) {
          row.classList.add('is-active');
        }
        if (session.id === pendingDeleteId) {
          row.classList.add('is-confirming');
          const text = document.createElement('span');
          text.className = 'session-confirm-text';
          // 危险操作必须能看清"删的是哪一条"：带上标题而不是只靠行位置判断
          text.textContent = `删除「${session.title || '新对话'}」？不可恢复`;
          text.title = text.textContent;
          const yes = document.createElement('button');
          yes.type = 'button';
          yes.className = 'session-confirm-yes';
          yes.textContent = '确认删除';
          yes.disabled = busy;
          yes.addEventListener('click', (event) => {
            event.stopPropagation();
            pendingDeleteId = null;
            deleteSession(session.id);
          });
          const no = document.createElement('button');
          no.type = 'button';
          no.className = 'session-confirm-no';
          no.textContent = '取消';
          no.disabled = busy;
          no.addEventListener('click', (event) => {
            event.stopPropagation();
            pendingDeleteId = null;
            renderHistory();
          });
          row.append(text, yes, no);
        } else {
          const main = document.createElement('button');
          main.type = 'button';
          main.className = 'session-item-main';
          const title = document.createElement('span');
          title.className = 'session-item-title';
          title.textContent = session.title || '新对话';
          const meta = document.createElement('span');
          meta.className = 'session-item-meta';
          meta.textContent = `${session.messageCount} 条消息 · ${session.shapeCount} 个图形 · ${formatActivityTime(
            session.updatedAt,
          )}`;
          main.append(title, meta);
          main.disabled = busy;
          main.addEventListener('click', () => switchTo(session.id));
          const del = document.createElement('button');
          del.type = 'button';
          del.className = 'session-item-del';
          del.title = '删除该对话';
          del.textContent = '×';
          del.disabled = busy;
          del.addEventListener('click', (event) => {
            event.stopPropagation();
            pendingDeleteId = session.id;
            renderHistory();
          });
          row.append(main, del);
        }
        listEl.appendChild(row);
      }
    }
    if (metaEl) {
      metaEl.textContent = sessions.length > 0 ? `${sessions.length} 个对话` : '--';
    }
    renderStorageNote();
  }

  /**
   * 收起历史抽屉（并同步"历史"按钮的选中态与 aria-expanded）。
   */
  function closePanel() {
    panel?.setAttribute('hidden', '');
    historyBtn?.classList.remove('is-active');
    historyBtn?.setAttribute('aria-expanded', 'false');
  }

  /**
   * 切换到指定对话（导出当前上下文 → 切换 → 恢复上下文并重绘）。
   *
   * @param {string} sessionId 会话 id
   */
  function switchTo(sessionId) {
    if (busy) {
      log.info('session.switch.blocked', { sessionId, reason: '轮次进行中' });
      return;
    }
    if (sessionId === store.getActiveId()) {
      return;
    }
    agent.beforeSwitch?.();
    store.switchSession(sessionId);
    agent.afterSwitch?.(sessionId);
    renderHistory();
    // 窄屏（≤640px）历史抽屉是全宽覆盖层：选完对话立刻收起，避免挡住消息与输入区
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        && window.matchMedia('(max-width: 640px)').matches) {
      closePanel();
    }
    log.info('session.switch', { sessionId });
  }

  /**
   * 删除对话（二次确认已在列表项内完成）。
   *
   * @param {string} sessionId 会话 id
   */
  function deleteSession(sessionId) {
    if (busy) {
      return;
    }
    const wasActive = store.getActiveId() === sessionId;
    agent.beforeSwitch?.();
    store.deleteSession(sessionId);
    if (wasActive) {
      // 删掉当前对话：进入空对话并清空地图
      agent.afterSwitch?.(null);
    }
    renderHistory();
    renderSwitcher();
    log.info('session.delete', { sessionId, wasActive });
  }

  /**
   * 新建对话（旧对话完整保留）。
   *
   * 空对话不叠加：当前对话还是空对话时直接复用，不新建第二个空对话
   * （否则历史列表会凭空多出一条空对话，删除时又互相牵连）；
   * 删除当前对话后的空对话状态（无当前会话）点"新对话"同样保持空对话，
   * 等用户真正发消息时再创建会话。
   */
  function newSession() {
    if (busy) {
      log.info('session.new.blocked', { reason: '轮次进行中' });
      return;
    }
    const beforeId = store.getActiveId();
    agent.beforeSwitch?.();
    const session = store.createSession({ reuseEmpty: true });
    if (!session) {
      // 无当前会话：已经是空对话，保持现状
      renderHistory();
      renderSwitcher();
      log.info('session.create.keep-empty', {});
      return;
    }
    agent.afterSwitch?.(session.id);
    renderHistory();
    renderSwitcher();
    log.info('session.create', { sessionId: session.id, reused: session.id === beforeId });
  }

  /**
   * 当前会话的图形序列。
   *
   * @returns {Array<object>} 图形记录
   */
  function currentShapes() {
    const sessionId = store.getActiveId();
    if (!sessionId) {
      return [];
    }
    return store.getSession(sessionId)?.shapes ?? [];
  }

  /**
   * 渲染图形切换控件（地图侧）。
   */
  function renderSwitcher() {
    if (!switcher) {
      return;
    }
    const shapes = currentShapes();
    if (shapes.length === 0) {
      switcher.removeAttribute('hidden');
      switcher.classList.add('is-empty');
      if (indicatorEl) {
        indicatorEl.textContent = '暂无图形';
        indicatorEl.title = '该对话还没有生成过图形';
      }
      setDisabled(prevBtn, true);
      setDisabled(nextBtn, true);
      setDisabled(latestBtn, true);
      return;
    }
    const active = store.getActiveShape(store.getActiveId());
    const index = active ? shapes.findIndex((item) => item.id === active.id) : shapes.length - 1;
    const position = index >= 0 ? index : shapes.length - 1;
    switcher.removeAttribute('hidden');
    switcher.classList.remove('is-empty');
    if (indicatorEl) {
      indicatorEl.textContent = `图形 ${position + 1}/${shapes.length}`;
      indicatorEl.title = active?.label ? `当前：${active.label}` : '图形切换';
    }
    setDisabled(prevBtn, busy || position <= 0);
    setDisabled(nextBtn, busy || position >= shapes.length - 1);
    setDisabled(latestBtn, busy || position >= shapes.length - 1);
  }

  /**
   * 把某个图形画到地图上（并聚焦），并记为当前查看的图形。
   *
   * @param {string} shapeId 图形 id
   */
  function showShape(shapeId) {
    // R6：轮次进行中不可切换图形（防止状态错乱）——与前后切换/最新按钮同一道门禁
    if (busy) {
      log.info('shape.view.blocked', { shapeId, reason: '轮次进行中' });
      return;
    }
    const sessionId = store.getActiveId();
    if (!sessionId) {
      return;
    }
    const session = store.getSession(sessionId);
    const shape = session?.shapes.find((item) => item.id === shapeId);
    if (!shape) {
      return;
    }
    const drawn = engine.drawSnapshot(shape);
    if (!drawn) {
      // 快照损坏（几何缺失/为空）：不改变"当前查看"记录，避免指示器指向画不出来的图形
      log.warn('shape.view.failed', { shapeId, sessionId });
      return;
    }
    store.setActiveShape(sessionId, shapeId);
    renderSwitcher();
    agent.onShapeViewed?.(shape);
    log.info('shape.view', { shapeId, sessionId, reference: shape.reference });
  }

  /**
   * 前后切换图形（按生成顺序）。
   *
   * @param {number} delta 方向（-1 上一，+1 下一个）
   */
  function stepShape(delta) {
    if (busy) {
      return;
    }
    const shapes = currentShapes();
    if (shapes.length === 0) {
      return;
    }
    const active = store.getActiveShape(store.getActiveId());
    const current = active ? shapes.findIndex((item) => item.id === active.id) : shapes.length - 1;
    const next = Math.max(0, Math.min(shapes.length - 1, current + delta));
    if (next === current) {
      return;
    }
    showShape(shapes[next].id);
  }

  /**
   * 回到最新图形。
   */
  function latestShape() {
    if (busy) {
      return;
    }
    const shapes = currentShapes();
    if (shapes.length === 0) {
      return;
    }
    showShape(shapes[shapes.length - 1].id);
  }

  /**
   * 设置忙碌状态（轮次进行中禁用切换类操作）。
   *
   * @param {boolean} value 是否忙碌
   */
  function setBusy(value) {
    busy = Boolean(value);
    setDisabled(newBtn, busy);
    setDisabled(historyBtn, busy);
    renderHistory();
    renderSwitcher();
  }

  // 事件绑定
  newBtn?.addEventListener('click', newSession);
  if (historyBtn) {
    historyBtn.setAttribute('aria-expanded', 'false');
    historyBtn.addEventListener('click', () => {
      if (busy) {
        return;
      }
      const willShow = panel.hasAttribute('hidden');
      if (willShow) {
        panel.removeAttribute('hidden');
        historyBtn.classList.add('is-active');
        historyBtn.setAttribute('aria-expanded', 'true');
        renderHistory();
      } else {
        closePanel();
      }
    });
  }
  closeBtn?.addEventListener('click', closePanel);
  prevBtn?.addEventListener('click', () => stepShape(-1));
  nextBtn?.addEventListener('click', () => stepShape(1));
  latestBtn?.addEventListener('click', latestShape);

  // 回复气泡里的"查看此图形"入口：agent 层派发自定义事件，这里统一处理
  document.addEventListener('drawinmap:show-shape', (event) => {
    const shapeId = event?.detail?.shapeId;
    if (shapeId) {
      showShape(shapeId);
    }
  });

  // 存储变化（会话增删、消息/图形写入）→ 刷新列表与切换控件
  const unsubscribe = store.subscribe((event) => {
    if (event.type === 'sessions' || event.type === 'active' || event.type === 'storage') {
      renderHistory();
    }
    if (event.type === 'shapes' || event.type === 'active-shape' || event.type === 'active') {
      renderSwitcher();
    }
  });

  renderHistory();
  renderSwitcher();

  return {
    /** 重绘历史列表 */
    renderHistory,
    /** 重绘图形切换控件 */
    renderSwitcher,
    /** 设置忙碌状态 */
    setBusy,
    /** 查看指定图形 */
    showShape,
    /** 新建对话 */
    newSession,
    /** 切换对话 */
    switchTo,
    /** 销毁（解绑订阅） */
    destroy() {
      unsubscribe();
    },
  };
}
