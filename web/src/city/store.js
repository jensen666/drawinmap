/**
 * 城市状态机（浏览器端）：选择 → 获取（进度可见）→ 就绪 → 切换进入；失败可重试。
 *
 * 状态口径（方案 2026-11-08 §5）：
 * - not-fetched：未获取（缓存目录里没有该城数据）；
 * - fetching：获取作业进行中（服务器串行队列，queued/running 都算）；
 * - ready：路网可用（preset 城市或已成功落盘的缓存）；
 * - failed：上次获取失败（有原因，可重试；该城不可画）。
 *
 * 切换纪律（需求 R2/R3）：
 * - 获取完成前，当前城市不变、引擎图不变，用户可继续在当前城市画；
 * - 完成后自动进入新城（仅当当前城市仍是发起获取时的城市且轮次空闲；
 *   轮次进行中记 pendingAutoSwitch，空闲时落地；用户已切走则只置就绪）；
 * - 换城 = 引擎重建路网图 + 清残留图形 + placeConfig.activeCity 替换（R3：不能拿
 *   上一座城市的路网在新城市出图）。
 */

import { loadRoadData } from '../road-data.js';
import { createLogger } from '../log/index.js';
import { buildCityConfig } from './city-config.js';

/** 模块 logger */
const log = createLogger('city/store');

/** 作业进度轮询间隔（毫秒） */
const JOB_POLL_INTERVAL_MS = 1000;

/**
 * 创建城市状态机。
 *
 * @param {object} options
 * @param {object} options.catalog 归一化城市目录（normalizeCatalog 结果）
 * @param {object} options.placeConfig 归一化地点配置（activeCity/activeCityId 由 store 切换时原地替换）
 * @param {{useCity: Function, clearDraw: Function}} options.engine 图形引擎（useCity 重建路网图）
 * @param {() => boolean} [options.isBusy] 智能体轮次是否进行中
 * @param {(event: object) => void} [options.onEvent] 状态/进度事件（UI 渲染与留痕）
 * @param {(cityConfig: object) => Promise<void>|void} [options.afterSwitch]
 *   切换收尾回调（main.js：文案/POI/路网参考层/飞视野 + controller.onCitySwitched）
 * @returns {object} 城市状态机接口
 */
export function createCityStore({
  catalog,
  placeConfig,
  engine,
  isBusy = () => false,
  onEvent = () => {},
  afterSwitch = () => {},
}) {
  if (!catalog?.byId || !placeConfig?.activeCity || !engine?.useCity) {
    throw new Error('createCityStore 需要 catalog/placeConfig/engine（useCity）');
  }

  /** 每城状态：Map<cityId, {state, error?, jobId?, progress?}> */
  const states = new Map();
  /** 当前城市 id（与 placeConfig.activeCityId 同步维护） */
  let activeCityId = placeConfig.activeCityId;
  /** 轮次空闲后待执行的自动切换 */
  let pendingAutoSwitch = null;
  /** 进行中的作业轮询（cityId → timer） */
  const pollTimers = new Map();
  /** preset 城市（当前默认城市）的配置来自地点配置文件（含手写地标），切换回来时复用 */
  const presetCityConfig =
    placeConfig.cities.find((city) => city.id === catalog.presetCityId) ?? placeConfig.activeCity;

  function emit(type, data = {}) {
    const event = { type, at: Date.now(), ...data };
    try {
      onEvent(event);
    } catch (error) {
      log.warn('city.event.listener.failed', { type }, error);
    }
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        log.warn('city.event.listener.failed', { type }, error);
      }
    }
  }

  /** 事件订阅（城市面板重绘用） */
  const listeners = new Set();

  /**
   * 订阅城市事件（city.* 前缀）。
   *
   * @param {(event: object) => void} listener 监听器
   * @returns {() => void} 取消订阅
   */
  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /**
   * 初始化/重同步各城状态：preset → ready；其余按服务器缓存清单 → ready / not-fetched。
   * fetching（轮询自己维护）与 failed（错误信息+重试入口）不被清单覆盖——
   * 面板打开时的 refreshCacheStates 不能把进行中的获取抹成 not-fetched。
   *
   * @param {Array<{cityId: string, roadCount: number|null, generatedAt: string|null}>} [cacheList]
   *   /__city/catalog 返回的 cache 清单
   */
  function initStates(cacheList = []) {
    for (const city of catalog.cities) {
      const prev = states.get(city.id);
      if (prev && (prev.state === 'fetching' || prev.state === 'failed')) {
        continue;
      }
      if (city.id === catalog.presetCityId) {
        states.set(city.id, { state: 'ready' });
        continue;
      }
      const cached = cacheList.find((item) => item.cityId === city.id);
      states.set(
        city.id,
        cached
          ? { state: 'ready', cached: true, roadCount: cached.roadCount, generatedAt: cached.generatedAt }
          : { state: 'not-fetched' },
      );
    }
  }

  /** 状态读取（UI/控制器路由共用） */
  function cityState(cityId) {
    return states.get(cityId) ?? { state: catalog.byId.get(cityId)?.preset ? 'ready' : 'not-fetched' };
  }

  /**
   * 切换进入一座 ready 城市：加载路网 → 引擎重建 → placeConfig 替换 → 收尾回调。
   *
   * @param {string} cityId 城市 id
   * @param {string} cause 切换原因（select/mention/auto-complete/idle-apply）
   * @returns {Promise<object>} 新活动城市配置
   */
  async function switchTo(cityId, cause) {
    const entry = catalog.byId.get(cityId);
    if (!entry) {
      throw new Error(`城市不存在：${cityId}`);
    }
    const cityStateInfo = cityState(cityId);
    if (cityStateInfo.state !== 'ready') {
      throw new Error(`${entry.label}路网尚未就绪（${cityStateInfo.state}），不能切换`);
    }
    const cityConfig = cityId === catalog.presetCityId ? presetCityConfig : buildCityConfig(entry);
    emit('city.switch.begin', { cityId, label: entry.label, cause });
    let roads;
    try {
      // loadRoadData 按 URL 缓存：回访已用过的城市不再重复下载（内存命中）
      roads = await loadRoadData(cityConfig.roads.dataUrl);
    } catch (error) {
      // 缓存文件损坏/被删：该城转 failed，诚实报错且不切换
      states.set(cityId, { state: 'failed', error: `路网缓存读取失败：${error.message}` });
      emit('city.switch.failed', { cityId, label: entry.label, error: error.message, cause });
      throw error;
    }
    engine.useCity(cityConfig, roads);
    placeConfig.activeCity = cityConfig;
    placeConfig.activeCityId = cityConfig.id;
    activeCityId = cityConfig.id;
    try {
      await afterSwitch(cityConfig);
    } catch (error) {
      log.error('city.switch.afterSwitch.failed', { cityId }, error);
    }
    emit('city.switch.done', { cityId, label: entry.label, roads: roads.length, cause });
    return cityConfig;
  }

  /**
   * 发起获取（selectCity 对 not-fetched/failed 城市与重试共用入口）。
   *
   * @param {string} cityId 城市 id
   * @returns {Promise<void>}
   */
  async function startFetch(cityId) {
    const entry = catalog.byId.get(cityId);
    if (!entry || entry.id === catalog.presetCityId) {
      throw new Error(`${entry?.label ?? cityId} 无需获取`);
    }
    const current = cityState(cityId);
    if (current.state === 'fetching') {
      emit('city.fetch.already', { cityId, jobId: current.jobId });
      return;
    }
    let startPayload;
    try {
      const response = await fetch('/__city/fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cityId }),
      });
      startPayload = await response.json();
      if (!response.ok || !startPayload?.ok) {
        throw new Error(startPayload?.error ?? `HTTP ${response.status}`);
      }
    } catch (error) {
      states.set(cityId, { state: 'failed', error: `获取请求失败：${error.message}` });
      emit('city.fetch.failed', { cityId, label: entry.label, error: error.message });
      return;
    }
    states.set(cityId, {
      state: 'fetching',
      jobId: startPayload.jobId,
      progress: { tilesDone: 0, tilesTotal: null, roads: 0, bytes: 0, phase: startPayload.reused ? '复用进行中的作业' : '排队中' },
      cityIdAtStart: activeCityId,
      startedAt: Date.now(),
    });
    emit('city.fetch.start', {
      cityId,
      label: entry.label,
      jobId: startPayload.jobId,
      reused: Boolean(startPayload.reused),
    });
    pollJob(cityId, entry, startPayload.jobId);
  }

  /**
   * 轮询作业状态直到 done/failed（1s；404 = 服务器重启丢作业，按失败处理可重试）。
   *
   * @param {string} cityId 城市 id
   * @param {object} entry 目录条目
   * @param {string} jobId 作业 id
   */
  function pollJob(cityId, entry, jobId) {
    stopPolling(cityId);
    const timer = setInterval(async () => {
      let job = null;
      try {
        const response = await fetch(`/__city/job/${encodeURIComponent(jobId)}`, { cache: 'no-store' });
        if (response.status === 404) {
          throw new Error('服务器作业不存在（可能已重启）');
        }
        const payload = await response.json();
        if (!payload?.ok) {
          throw new Error(payload?.error ?? `HTTP ${response.status}`);
        }
        job = payload.job;
      } catch (error) {
        stopPolling(cityId);
        states.set(cityId, { state: 'failed', error: `获取进度查询失败：${error.message}` });
        emit('city.fetch.failed', { cityId, label: entry.label, error: error.message, jobId });
        return;
      }
      const info = states.get(cityId);
      if (!info || info.jobId !== jobId) {
        stopPolling(cityId);
        return;
      }
      if (job.status === 'done') {
        stopPolling(cityId);
        const cityIdAtStart = info.cityIdAtStart ?? null;
        states.set(cityId, {
          state: 'ready',
          cached: true,
          roadCount: job.roads,
          generatedAt: new Date().toISOString(),
        });
        emit('city.fetch.done', { cityId, label: entry.label, roads: job.roads, durationMs: job.finishedAt - job.startedAt });
        maybeAutoSwitch(cityId, { cityIdAtStart });
        return;
      }
      if (job.status === 'failed') {
        stopPolling(cityId);
        states.set(cityId, { state: 'failed', error: job.error ?? '获取失败' });
        emit('city.fetch.failed', { cityId, label: entry.label, error: job.error ?? '获取失败', jobId });
        return;
      }
      // running/queued：刷新进度（进度字段来自服务端作业）
      info.progress = {
        tilesDone: job.tilesDone,
        tilesTotal: job.tilesTotal,
        roads: job.roads,
        bytes: job.bytes,
        phase: job.status === 'running' ? '正在获取' : '排队等待',
      };
      emit('city.fetch.progress', {
        cityId,
        label: entry.label,
        jobId,
        tilesDone: job.tilesDone,
        tilesTotal: job.tilesTotal,
        roads: job.roads,
        bytes: job.bytes,
        phase: info.progress.phase,
      });
    }, JOB_POLL_INTERVAL_MS);
    pollTimers.set(cityId, timer);
  }

  function stopPolling(cityId) {
    const timer = pollTimers.get(cityId);
    if (timer) {
      clearInterval(timer);
      pollTimers.delete(cityId);
    }
  }

  /**
   * 获取完成后的自动进入（R2"完成后，地图进入该城市"）：
   * 仅当轮次空闲且当前城市仍是发起获取时的城市；轮次进行中则挂起，空闲时落地。
   *
   * @param {string} cityId 完成的城市 id
   * @param {{cityIdAtStart: string|null}} [options] 发起获取时的活动城市（发起时记录）
   */
  function maybeAutoSwitch(cityId, { cityIdAtStart = null } = {}) {
    if (isBusy()) {
      pendingAutoSwitch = { cityId, cityIdAtStart };
      emit('city.switch.deferred', { cityId, reason: 'busy' });
      return;
    }
    if (cityIdAtStart && activeCityId !== cityIdAtStart) {
      // 用户已手动切到别的城市：只置就绪，不强行拉回
      emit('city.ready.not.switched', { cityId, activeCityId });
      return;
    }
    switchTo(cityId, 'auto-complete').catch(() => {
      // switchTo 已发 city.switch.failed 事件；状态已转 failed
    });
  }

  /**
   * 轮次空闲通知（main.js 在 onBusyChange(false) 时调用）：落地挂起的自动切换。
   */
  function notifyIdle() {
    if (!pendingAutoSwitch) {
      return;
    }
    const { cityId, cityIdAtStart } = pendingAutoSwitch;
    pendingAutoSwitch = null;
    const info = states.get(cityId);
    if (info?.state !== 'ready') {
      return;
    }
    if (cityIdAtStart && activeCityId !== cityIdAtStart) {
      emit('city.ready.not.switched', { cityId, activeCityId });
      return;
    }
    switchTo(cityId, 'idle-apply').catch(() => {});
  }

  /**
   * 选择城市（城市面板唯一入口；重试=再次选择失败城市）。
   *
   * @param {string} cityId 城市 id
   * @returns {Promise<'switched'|'fetching'|'already-active'|'busy'|'noop'>} 结果
   */
  async function selectCity(cityId) {
    const entry = catalog.byId.get(cityId);
    if (!entry) {
      throw new Error(`城市不存在：${cityId}`);
    }
    if (isBusy()) {
      emit('city.select.rejected', { cityId, reason: 'busy' });
      return 'busy';
    }
    if (cityId === activeCityId) {
      emit('city.select.already', { cityId });
      return 'already-active';
    }
    const info = cityState(cityId);
    if (info.state === 'ready') {
      await switchTo(cityId, 'select');
      return 'switched';
    }
    if (info.state === 'fetching') {
      emit('city.fetch.already', { cityId, jobId: info.jobId });
      return 'fetching';
    }
    // not-fetched / failed：发起获取（重试=failed 再选一次）
    await startFetch(cityId);
    return 'fetching';
  }

  /**
   * 对话点名城市的路由（控制器在自城解析失败后调用）。
   *
   * @param {string} placeText 用户提到的地名原文
   * @returns {Promise<null|{action: 'wait'|'failed'|'guide'|'switched', city: object, error?: string}>}
   *   null = 不是目录里的城市名（走原地点解析）
   */
  async function handleCityMention(placeText) {
    const name = typeof placeText === 'string' ? placeText.trim() : '';
    if (!name) {
      return null;
    }
    const cityId = catalog.nameOwners.get(name);
    if (!cityId) {
      return null;
    }
    const entry = catalog.byId.get(cityId);
    const info = cityState(cityId);
    if (cityId === activeCityId) {
      // 当前城市名按理已被城市名匹配命中（覆盖中心）；此分支只是兜底
      return { action: 'active', city: entry };
    }
    if (info.state === 'fetching') {
      emit('city.mention.wait', { cityId, placeText: name });
      return { action: 'wait', city: entry };
    }
    if (info.state === 'failed') {
      emit('city.mention.failed', { cityId, placeText: name, error: info.error });
      return { action: 'failed', city: entry, error: info.error };
    }
    if (info.state === 'ready') {
      // 已就绪：就地切换进入该城市，本轮继续用新城路网规划
      await switchTo(cityId, 'mention');
      return { action: 'switched', city: entry };
    }
    // not-fetched：引导到城市面板显式获取（不做"点名即拉取"）
    emit('city.mention.guide', { cityId, placeText: name });
    return { action: 'guide', city: entry };
  }

  /**
   * 从服务器刷新缓存清单（面板打开/需要重同步时调用）。
   *
   * @returns {Promise<Array>} 缓存清单
   */
  async function refreshCacheStates() {
    try {
      const response = await fetch('/__city/catalog', { cache: 'no-store' });
      const payload = await response.json();
      if (!payload?.ok) {
        throw new Error(payload?.error ?? `HTTP ${response.status}`);
      }
      initStates(payload.cache ?? []);
      // 获取中的城市状态不被刷新覆盖（轮询自己维护）
      emit('city.cache.refreshed', { count: (payload.cache ?? []).length });
      return payload.cache ?? [];
    } catch (error) {
      log.warn('city.cache.refresh.failed', { message: error?.message ?? String(error) });
      return [];
    }
  }

  /** 面板进度文案（"正在获取 50% · 已收到 8.8MB"；不出现"瓦片"等专业词） */
  function statusLine(cityId) {
    const entry = catalog.byId.get(cityId);
    const info = cityState(cityId);
    if (!entry) {
      return '';
    }
    if (cityId === activeCityId) {
      return '当前城市';
    }
    switch (info.state) {
      case 'ready':
        return info.roadCount ? `已就绪 · ${info.roadCount} 条道路` : '已就绪';
      case 'fetching': {
        const p = info.progress ?? {};
        const waited = info.startedAt ? Math.max(0, Math.round((Date.now() - info.startedAt) / 1000)) : null;
        const waitText = waited !== null && waited >= 3
          ? `（已等待 ${waited >= 60 ? `${Math.floor(waited / 60)} 分 ${waited % 60} 秒` : `${waited} 秒`}）`
          : '';
        if ((p.phase ?? '').includes('排队')) {
          return `排队等待中…${waitText}`;
        }
        const percent = p.tilesTotal && p.tilesDone
          ? ` ${Math.min(100, Math.round((p.tilesDone / p.tilesTotal) * 100))}%`
          : '';
        const mega = p.bytes ? ` · 已收到 ${(p.bytes / 1e6).toFixed(1)}MB` : '';
        return `正在获取${percent || '…'}${mega}${p.bytes ? '' : waitText}`;
      }
      case 'failed':
        return `获取失败 · ${info.error ?? '原因未知'}`;
      default:
        return '未获取';
    }
  }

  initStates([]);

  return {
    selectCity,
    startFetch,
    handleCityMention,
    refreshCacheStates,
    notifyIdle,
    cityState,
    statusLine,
    activeId: () => activeCityId,
    catalog,
    subscribe,
  };
}
