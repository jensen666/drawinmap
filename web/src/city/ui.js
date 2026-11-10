/**
 * 城市面板：全国地级市/直辖市选择、按需获取进度、失败重试（方案 2026-11-08 §5.4）。
 *
 * 交互纪律：
 * - 每行状态徽标区分：当前 / 已就绪 / 排队中·正在获取 / 获取失败·可重试 / 未获取；
 * - 点击行为按状态路由（store.selectCity）：就绪=切换；未获取/失败=发起获取（重试）；
 *   获取中=不重复发起；
 * - 轮次进行中禁用整表（与历史对话切换同一道门禁），面板本身仍可查看。
 *
 * DOM 骨架在 index.html（#city-panel），本模块负责绑定与渲染。
 */

import { createLogger } from '../log/index.js';

/** 模块 logger */
const log = createLogger('city/ui');

/** 状态徽标文案与样式类 */
const STATUS_BADGE = {
  current: { text: '当前', className: 'is-current' },
  ready: { text: '已就绪', className: 'is-ready' },
  fetching: { text: '正在获取', className: 'is-fetching' },
  failed: { text: '获取失败·可重试', className: 'is-failed' },
  'not-fetched': { text: '未获取', className: 'is-notfetched' },
};

/**
 * 初始化城市面板。
 *
 * @param {object} options
 * @param {object} options.store 城市状态机（createCityStore 结果）
 * @param {() => boolean} [options.isBusy] 轮次是否进行中
 * @returns {{setBusy: Function}} 面板接口
 */
export function initCityUi({ store, isBusy = () => false }) {
  const panel = document.getElementById('city-panel');
  const toggleBtn = document.getElementById('city-btn');
  const closeBtn = document.getElementById('city-close');
  const searchInput = document.getElementById('city-search');
  const listEl = document.getElementById('city-list');
  const metaEl = document.getElementById('city-meta');
  const noteEl = document.getElementById('city-note');
  if (!panel || !toggleBtn || !closeBtn || !searchInput || !listEl) {
    throw new Error('城市面板 DOM 骨架缺失（#city-panel / #city-btn / #city-search / #city-list）');
  }

  /** 面板是否打开 */
  let open = false;
  /** 搜索关键词 */
  let filterText = '';
  /** 获取中重绘定时器：面板打开期间每秒主动重绘（进度不依赖事件回调，事件丢失也会更新） */
  let fetchRenderTimer = null;
  /** 渲染失败的连续计数（渲染抛错也不中断定时器，只记日志） */
  let renderErrorCount = 0;

  /** 面板重绘（吞掉单次渲染异常，避免一次渲染错误让进度永远停住） */
  function renderSafe() {
    try {
      render();
      renderErrorCount = 0;
    } catch (error) {
      renderErrorCount += 1;
      log.error('city.ui.render.failed', { count: renderErrorCount }, error);
    }
  }

  function startFetchRenderTimer() {
    if (fetchRenderTimer !== null) {
      return;
    }
    fetchRenderTimer = setInterval(() => {
      const fetching = store.catalog.cities.some((city) => store.cityState(city.id).state === 'fetching');
      if (fetching) {
        renderSafe();
      }
    }, 1000);
  }

  function stopFetchRenderTimer() {
    if (fetchRenderTimer !== null) {
      clearInterval(fetchRenderTimer);
      fetchRenderTimer = null;
    }
  }

  function setBusy(busy) {
    listEl.classList.toggle('is-busy', Boolean(busy));
    toggleBtn.disabled = Boolean(busy) && !open;
    if (open) {
      renderSafe();
    }
  }

  function setOpen(next) {
    open = next;
    panel.hidden = !open;
    toggleBtn.classList.toggle('is-active', open);
    if (open) {
      // 打开面板时与服务器重同步缓存清单（跨页面会话/其他用户获取的城市也能看到）
      store
        .refreshCacheStates()
        .then(renderSafe)
        .catch(() => {});
      renderSafe();
      // 打开期间若有城市在获取，每秒重绘（不依赖状态机事件是否送达）
      startFetchRenderTimer();
    } else {
      stopFetchRenderTimer();
    }
  }

  toggleBtn.addEventListener('click', () => setOpen(!open));
  closeBtn.addEventListener('click', () => setOpen(false));
  searchInput.addEventListener('input', () => {
    filterText = searchInput.value.trim();
    render();
  });

  /** 行点击 → selectCity（就绪切换/未获取与失败发起获取；获取中不重复发起） */
  listEl.addEventListener('click', async (event) => {
    const retryBtn = event.target.closest('.city-retry');
    const row = event.target.closest('.city-row');
    if (isBusy()) {
      log.info('city.select.blocked', { reason: '轮次进行中' });
      return;
    }
    const target = retryBtn ?? row;
    if (!target) {
      return;
    }
    const cityId = target.dataset.cityId;
    if (!cityId) {
      return;
    }
    try {
      await store.selectCity(cityId);
    } catch (error) {
      log.error('city.select.failed', { cityId }, error);
      if (noteEl) {
        noteEl.textContent = `操作失败：${error.message}`;
        noteEl.hidden = false;
      }
    }
  });

  /** 渲染城市列表（分省分组 + 搜索过滤 + 状态徽标） */
  function render() {
    const catalog = store.catalog;
    const activeId = store.activeId();
    const keyword = filterText.toLowerCase();
    const busy = isBusy();

    // 按省份分组（目录顺序即省序，组内按目录顺序）
    const groups = new Map();
    for (const city of catalog.cities) {
      if (keyword) {
        const haystack = `${city.label}${city.fullName}${city.province}${city.id}`.toLowerCase();
        const hit = city.names.some((name) => name.toLowerCase().includes(keyword)) || haystack.includes(keyword);
        if (!hit) {
          continue;
        }
      }
      if (!groups.has(city.province)) {
        groups.set(city.province, []);
      }
      groups.get(city.province).push(city);
    }

    const fragment = document.createDocumentFragment();
    for (const [province, cities] of groups) {
      const groupEl = document.createElement('div');
      groupEl.className = 'city-group';
      const headEl = document.createElement('div');
      headEl.className = 'city-group-head';
      headEl.textContent = `${province} · ${cities.length}`;
      groupEl.appendChild(headEl);
      for (const city of cities) {
        const info = store.cityState(city.id);
        const line = store.statusLine(city.id);
        const badge =
          city.id === activeId
            ? STATUS_BADGE.current
            : STATUS_BADGE[info.state] ?? STATUS_BADGE['not-fetched'];
        const rowEl = document.createElement('button');
        rowEl.type = 'button';
        rowEl.className = `city-row ${city.id === activeId ? 'is-active-row' : ''}`;
        rowEl.dataset.cityId = city.id;
        rowEl.title = line;
        rowEl.disabled = busy;
        const nameEl = document.createElement('span');
        nameEl.className = 'city-name';
        nameEl.textContent = city.fullName || city.label;
        const statusEl = document.createElement('span');
        statusEl.className = `city-status ${badge.className}`;
        statusEl.textContent = city.id === activeId ? '当前' : line || badge.text;
        rowEl.appendChild(nameEl);
        rowEl.appendChild(statusEl);
        if (info.state === 'failed' && city.id !== activeId) {
          const retryEl = document.createElement('span');
          retryEl.className = 'city-retry';
          retryEl.dataset.cityId = city.id;
          retryEl.textContent = '重试';
          retryEl.title = '重新获取该城市路网';
          rowEl.appendChild(retryEl);
        }
        groupEl.appendChild(rowEl);
      }
      fragment.appendChild(groupEl);
    }
    listEl.replaceChildren(fragment);
    if (metaEl) {
      const readyCount = [...catalog.byId.values()].filter((city) => store.cityState(city.id).state === 'ready').length;
      metaEl.textContent = `${catalog.cities.length} 城 · ${readyCount} 城已就绪`;
    }
    if (noteEl) {
      noteEl.hidden = false;
      noteEl.textContent = busy
        ? '智能体正在画图，选择暂时停用'
        : '选择尚未获取的城市后开始获取；获取完成前当前城市不变，失败可重试。';
    }
  }

  // 订阅状态机事件：任何状态/进度变化都重绘（面板未打开时跳过；
  // 进度更新另有每秒定时重绘兜底，不依赖本事件是否送达）
  store.subscribe((event) => {
    if (!event.type.startsWith('city.')) {
      return;
    }
    log.info(event.type, event);
    if (open) {
      renderSafe();
    }
  });

  return { setBusy };
}
