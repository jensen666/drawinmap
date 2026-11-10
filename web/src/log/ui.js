/**
 * 运行日志查看器：把日志系统的内存记录渲染成可筛选、可展开、可导出的左侧抽屉。
 *
 * DOM 骨架在 index.html（#log-btn 按钮 + #log-panel 面板），本模块只负责查询与渲染；
 * 由 main.js 启动时调用 initLogViewer()（无参、可重复调用且幂等）。
 *
 * 安全约定：日志内容来自用户输入与 LLM 输出，所有动态文本一律用 textContent 写入，
 * 绝不用 innerHTML 拼接，避免日志文本被当成 HTML 执行。
 */

import { getEntries, subscribe, getStats, downloadJsonl, clearLogs } from './index.js';
import { LEVELS, filterRecords } from './core.js';

/** 列表最多渲染的行数（超出只显示最新，避免超长日志把 DOM 撑爆） */
const MAX_ROWS = 400;
/** 状态栏统计刷新间隔（毫秒） */
const STATUS_REFRESH_MS = 1500;
/** 导出/清空等操作反馈在状态栏停留的时长（毫秒） */
const FLASH_MS = 4000;
/** 判定"列表已在底部"的滚动阈值（像素） */
const SCROLL_BOTTOM_GAP = 40;
/** 已初始化的查看器实例（幂等：重复调用直接返回，不重复绑定事件） */
let viewer = null;

/**
 * 创建元素并可选设置类名与文本（日志内容只走 textContent）。
 *
 * @param {string} tagName 标签名
 * @param {string|null} [className] 类名
 * @param {string|null} [text] 文本内容
 * @returns {HTMLElement} 元素
 */
function createEl(tagName, className = null, text = null) {
  const el = document.createElement(tagName);
  if (className) {
    el.className = className;
  }
  if (text !== null) {
    el.textContent = String(text);
  }
  return el;
}

/**
 * 服务端落盘状态 → 状态栏文案。
 *
 * @param {object} [server] getStats().server
 * @returns {string} 文案
 */
function describeServer(server = {}) {
  const status = server.status || 'disabled';
  if (status === 'available') {
    return '落盘已连接 web/logs/*.jsonl';
  }
  if (status === 'probing') {
    return '探测落盘接口…';
  }
  if (status === 'error') {
    return '落盘写入异常';
  }
  if (status === 'idle') {
    return '等待落盘探测…';
  }
  return '仅浏览器（未落盘）';
}

/**
 * 时间列：记录 time 形如 '2026-10-26 01:13:20.896'，取后 12 位 HH:mm:ss.SSS。
 *
 * @param {object} record 日志记录
 * @returns {string} 时间文本
 */
function formatTime(record) {
  if (typeof record.time === 'string' && record.time.length >= 12) {
    return record.time.slice(-12);
  }
  if (Number.isFinite(record.ts)) {
    const date = new Date(record.ts);
    const pad = (value, size = 2) => String(value).padStart(size, '0');
    return (
      `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.` +
      `${pad(date.getMilliseconds(), 3)}`
    );
  }
  return '--:--:--.---';
}

/**
 * trace 短标签：去掉前缀只留尾部 6 位（完整 id 放 title，点击按 traceId 筛选）。
 *
 * @param {string} traceId 链路 id
 * @returns {string} 短标签
 */
function shortTrace(traceId) {
  return `#${String(traceId).replace(/^t-/, '').slice(-6)}`;
}

/**
 * 格式化整条记录为可展开的 JSON 文本（缩进 2）。
 *
 * @param {object} record 日志记录
 * @returns {string} JSON 文本（序列化失败退化为字符串）
 */
function formatRecord(record) {
  try {
    return JSON.stringify(record, null, 2);
  } catch {
    return String(record);
  }
}

/**
 * 关键词归一化（去首尾空白 + 小写），与 filterRecords 的关键词口径一致。
 *
 * @param {unknown} value 原始输入
 * @returns {string} 归一化关键词
 */
function normalizeKeyword(value) {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * 初始化页面内日志查看器（无参、可重复调用、幂等）。
 *
 * 注意：请在 initLogging() 之后调用，这样订阅的是页面实际使用的日志系统实例。
 *
 * @returns {object|null} 简单控制接口（DOM 缺失时返回 null）
 */
export function initLogViewer() {
  if (viewer) {
    return viewer;
  }

  // 面板需要的 DOM 引用（与 index.html 中的 ID 一一对应）
  const refs = {
    btn: document.getElementById('log-btn'),
    panel: document.getElementById('log-panel'),
    close: document.getElementById('log-close'),
    meta: document.getElementById('log-meta'),
    level: document.getElementById('log-level'),
    module: document.getElementById('log-module'),
    search: document.getElementById('log-search'),
    exportBtn: document.getElementById('log-export'),
    clearBtn: document.getElementById('log-clear'),
    status: document.getElementById('log-status'),
    limit: document.getElementById('log-limit'),
    list: document.getElementById('log-list'),
  };
  const missing = Object.keys(refs).filter((key) => !refs[key]);
  if (missing.length > 0) {
    console.error('[log/ui] 缺少日志查看器 DOM，跳过初始化：', missing.join('、'));
    return null;
  }

  // 查看器运行状态（open 控制抽屉，其余为筛选与定时器）
  const state = {
    open: false,
    level: LEVELS[refs.level.value] ? refs.level.value : 'debug',
    module: '',
    keyword: '',
    matchedTotal: 0,
    statusTimer: null,
    flash: null,
  };

  /**
   * 当前筛选条件（语义与 log/core.js 的 filterRecords 一致）。
   *
   * @returns {{level: string, module: string|null, traceId: null, keyword: string}} 筛选对象
   */
  function currentFilter() {
    return {
      level: state.level,
      module: state.module || null,
      traceId: null,
      keyword: state.keyword,
    };
  }

  /**
   * 单条记录是否匹配当前筛选（复用 core.js 的 filterRecords：与全量渲染、
   * 导出共用同一份筛选语义，避免"列表渲染"与"实时追加"两套实现漂移）。
   *
   * @param {object} record 日志记录
   * @returns {boolean} 是否匹配
   */
  function matchesRecord(record) {
    return filterRecords([record], currentFilter()).length > 0;
  }

  /**
   * 构造一行日志：级别徽标、时间、模块、事件、耗时、trace 短标签 + 可展开 JSON。
   *
   * @param {object} record 日志记录
   * @returns {HTMLElement} 行元素
   */
  function createRow(record) {
    const level = LEVELS[record.level] ? record.level : 'info';
    const row = createEl('div', 'log-row');
    const badge = createEl('span', `log-badge log-level-${level}`, level);
    const time = createEl('span', 'log-time', formatTime(record));
    const moduleEl = createEl('span', 'log-module', record.module || '-');
    moduleEl.title = record.module || '';
    const eventEl = createEl('span', 'log-event', record.event || '-');
    row.append(badge, time, moduleEl, eventEl);
    if (Number.isFinite(record.durationMs)) {
      row.appendChild(createEl('span', 'log-duration', `${Math.round(record.durationMs)}ms`));
    }
    if (record.traceId) {
      const traceBtn = createEl('button', 'log-trace', shortTrace(record.traceId));
      traceBtn.type = 'button';
      traceBtn.title = `按 traceId 筛选：${record.traceId}`;
      traceBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        refs.search.value = record.traceId;
        state.keyword = normalizeKeyword(record.traceId);
        renderList();
      });
      row.appendChild(traceBtn);
    }
    const detail = createEl('pre', 'log-detail', formatRecord(record));
    detail.hidden = true;
    row.appendChild(detail);
    row.addEventListener('click', () => {
      detail.hidden = !detail.hidden;
      row.classList.toggle('is-open', detail.hidden === false);
    });
    return row;
  }

  /** 刷新模块下拉：从内存记录动态收集模块名，并保持当前选择。 */
  function refreshModules() {
    const modules = new Set();
    for (const record of getEntries({ level: 'debug', limit: 0 })) {
      if (record.module) {
        modules.add(record.module);
      }
    }
    // 已选模块若已无记录（例如清空后），回退为"全部模块"，避免选择与结果不一致
    if (state.module && !modules.has(state.module)) {
      state.module = '';
    }
    refs.module.textContent = '';
    const allOption = createEl('option', null, '全部模块');
    allOption.value = '';
    refs.module.appendChild(allOption);
    for (const name of [...modules].sort()) {
      const option = createEl('option', null, name);
      option.value = name;
      refs.module.appendChild(option);
    }
    refs.module.value = state.module;
  }

  /** 更新"仅显示最新 N 条"提示（只有被截断时才显示）。 */
  function updateLimitHint() {
    const truncated = state.matchedTotal > MAX_ROWS;
    refs.limit.textContent = truncated
      ? `仅显示最新 ${MAX_ROWS} 条（共 ${state.matchedTotal} 条匹配，导出可获取全部）`
      : '';
    refs.limit.hidden = !truncated;
  }

  /** 全量重渲染列表（打开面板、筛选变化、清空后调用）。 */
  function renderList() {
    refreshModules();
    const all = getEntries({ ...currentFilter(), limit: 0 });
    state.matchedTotal = all.length;
    const shown = all.slice(-MAX_ROWS);
    refs.list.textContent = '';
    if (shown.length === 0) {
      refs.list.appendChild(createEl('div', 'log-empty', '当前筛选没有日志'));
    } else {
      const fragment = document.createDocumentFragment();
      for (const record of shown) {
        fragment.appendChild(createRow(record));
      }
      refs.list.appendChild(fragment);
      refs.list.scrollTop = refs.list.scrollHeight;
    }
    updateLimitHint();
    refreshStats();
  }

  /**
   * 实时追加一条新记录（只在面板打开且匹配当前筛选时渲染）。
   *
   * @param {object} record 新日志记录
   */
  function appendRecord(record) {
    if (!state.open || !matchesRecord(record)) {
      return;
    }
    const nearBottom =
      refs.list.scrollHeight - refs.list.scrollTop - refs.list.clientHeight <= SCROLL_BOTTOM_GAP;
    const empty = refs.list.querySelector('.log-empty');
    if (empty) {
      empty.remove();
    }
    refs.list.appendChild(createRow(record));
    while (refs.list.children.length > MAX_ROWS) {
      refs.list.firstElementChild.remove();
    }
    state.matchedTotal += 1;
    updateLimitHint();
    if (nearBottom) {
      refs.list.scrollTop = refs.list.scrollHeight;
    }
  }

  /** 刷新标题右侧统计与状态栏（含导出/清空的临时反馈文案）。 */
  function refreshStats() {
    const stats = getStats();
    const byLevel = stats.byLevel || {};
    refs.meta.textContent =
      `共 ${stats.stored ?? 0} 条 · warn ${byLevel.warn ?? 0} · error ${byLevel.error ?? 0}`;
    if (state.flash && Date.now() > state.flash.until) {
      state.flash = null;
    }
    const parts = [];
    if (state.flash) {
      parts.push(state.flash.text);
    }
    parts.push(`会话 ${stats.sessionId || '-'}`);
    parts.push(`内存 ${stats.stored ?? 0} 条 / 累计 ${stats.total ?? 0} 条`);
    parts.push(describeServer(stats.server));
    const storage = stats.storage || {};
    parts.push(storage.enabled ? `localStorage ${storage.entries ?? 0} 条` : 'localStorage 未启用');
    const pending = stats.server && stats.server.pending;
    if (Number.isFinite(pending) && pending > 0) {
      parts.push(`待落盘 ${pending} 条`);
    }
    refs.status.textContent = parts.join(' · ');
  }

  /**
   * 在状态栏显示一条临时操作反馈（几秒后自动消失）。
   *
   * @param {string} text 反馈文案
   */
  function flash(text) {
    state.flash = { text, until: Date.now() + FLASH_MS };
    refreshStats();
  }

  /** 启动状态栏定时刷新（面板打开期间生效）。 */
  function startStatusTimer() {
    stopStatusTimer();
    state.statusTimer = setInterval(refreshStats, STATUS_REFRESH_MS);
  }

  /** 停止状态栏定时刷新。 */
  function stopStatusTimer() {
    if (state.statusTimer !== null) {
      clearInterval(state.statusTimer);
      state.statusTimer = null;
    }
  }

  /** 打开日志面板：渲染已有记录并开始刷新统计。 */
  function openPanel() {
    if (state.open) {
      return;
    }
    state.open = true;
    refs.panel.removeAttribute('hidden');
    refs.btn.classList.add('is-active');
    renderList();
    startStatusTimer();
  }

  /** 关闭日志面板并停止统计刷新。 */
  function closePanel() {
    if (!state.open) {
      return;
    }
    state.open = false;
    refs.panel.setAttribute('hidden', '');
    refs.btn.classList.remove('is-active');
    stopStatusTimer();
  }

  /** 按当前筛选导出 JSONL 文件（导出全部匹配记录，不受列表 400 行限制）。 */
  function exportLogs() {
    const filter = currentFilter();
    if (getEntries({ ...filter, limit: 1 }).length === 0) {
      flash('当前筛选没有可导出的日志');
      return;
    }
    const fileName = downloadJsonl(filter);
    flash(fileName ? `已导出 ${fileName}` : '导出失败：当前环境不支持下载');
  }

  /** 确认后清空内存与 localStorage 日志（服务端已落盘文件保留）。 */
  function clearAllLogs() {
    const before = getStats().stored ?? 0;
    const ok = window.confirm(
      `确定清空当前页面日志？\n共 ${before} 条（服务端已落盘到 web/logs/*.jsonl 的文件不会删除）`,
    );
    if (!ok) {
      return;
    }
    clearLogs();
    state.matchedTotal = 0;
    state.module = '';
    renderList();
    flash(`已清空 ${before} 条日志（服务端落盘文件保留）`);
  }

  // ---------- 事件绑定（初始化只执行一次，保证幂等） ----------
  refs.btn.addEventListener('click', () => {
    if (state.open) {
      closePanel();
    } else {
      openPanel();
    }
  });
  refs.close.addEventListener('click', closePanel);
  refs.level.addEventListener('change', () => {
    // 级别为"最低级别"语义：warn 表示 warn + error
    state.level = LEVELS[refs.level.value] ? refs.level.value : 'debug';
    renderList();
  });
  refs.module.addEventListener('change', () => {
    state.module = refs.module.value || '';
    renderList();
  });
  refs.search.addEventListener('input', () => {
    state.keyword = normalizeKeyword(refs.search.value);
    renderList();
  });
  refs.exportBtn.addEventListener('click', exportLogs);
  refs.clearBtn.addEventListener('click', clearAllLogs);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.open) {
      closePanel();
    }
  });

  // 新日志实时追加（匹配当前筛选才渲染；面板关闭时等下次打开全量渲染）
  subscribe((record) => {
    appendRecord(record);
  });

  // 初始态：面板默认隐藏、按钮非激活，先渲染一次统计与模块选项
  refs.panel.setAttribute('hidden', '');
  refs.btn.classList.remove('is-active');
  refs.level.value = state.level;
  refreshModules();
  refreshStats();

  viewer = {
    open: openPanel,
    close: closePanel,
    refresh: renderList,
  };
  console.info('[log/ui] 运行日志查看器已初始化');
  return viewer;
}
