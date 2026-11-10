/**
 * 城市目录加载与查询（浏览器端）。
 *
 * 目录是静态配置（/config/city-catalog.json）：全国地级市/直辖市的名称与中心锚点，
 * 不含任何路网数据。路网只能通过 /__city/fetch 按需获取后由服务器落盘缓存。
 */

import { createLogger } from '../log/index.js';

/** 模块 logger */
const log = createLogger('city/catalog');

/** 浏览器端默认目录地址 */
const DEFAULT_CATALOG_URL = '/config/city-catalog.json';

/**
 * 校验并归一化目录（轻校验：结构正确、id/名唯一）。
 *
 * @param {unknown} raw JSON.parse 结果
 * @returns {{cities: Array, byId: Map<string, object>, presetCityId: string}} 归一化目录
 */
export function normalizeCatalog(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.cities) || raw.cities.length === 0) {
    throw new Error('城市目录格式错误（缺少 cities 数组）');
  }
  const byId = new Map();
  const nameOwners = new Map();
  for (const city of raw.cities) {
    if (!city?.id || typeof city.id !== 'string') {
      throw new Error('城市目录条目缺少 id');
    }
    if (byId.has(city.id)) {
      throw new Error(`城市目录 id 重复：${city.id}`);
    }
    const names = Array.isArray(city.names) ? city.names.filter((name) => typeof name === 'string' && name.trim()) : [];
    if (names.length === 0) {
      throw new Error(`城市目录条目缺少名称：${city.id}`);
    }
    if (!city.center || !Number.isFinite(city.center.lat) || !Number.isFinite(city.center.lng)) {
      throw new Error(`城市目录条目缺少中心坐标：${city.id}`);
    }
    byId.set(city.id, { ...city, names });
    for (const name of names) {
      const owner = nameOwners.get(name);
      if (owner && owner !== city.id) {
        throw new Error(`城市名「${name}」同时属于 ${owner} 与 ${city.id}`);
      }
      nameOwners.set(name, city.id);
    }
  }
  const presetCityId = typeof raw.presetCityId === 'string' ? raw.presetCityId : raw.cities[0].id;
  if (!byId.has(presetCityId)) {
    throw new Error(`presetCityId 不在目录中：${presetCityId}`);
  }
  log.info('city.catalog.ready', { cities: byId.size, presetCityId });
  return {
    cities: [...byId.values()],
    byId,
    nameOwners,
    presetCityId,
  };
}

/**
 * 按名称精确查找城市（目录 names/label/fullName 全量精确匹配，不做包含匹配——
 * 避免把普通地名误判成城市点名；匹配不到返回 null，走原地点解析流程）。
 *
 * @param {{byId: Map<string, object>, nameOwners: Map<string, string>}} catalog 归一化目录
 * @param {string} text 用户提到的地名原文
 * @returns {object|null} 目录条目
 */
export function findCityByName(catalog, text) {
  const name = typeof text === 'string' ? text.trim() : '';
  if (!name) {
    return null;
  }
  const cityId = catalog?.nameOwners?.get(name);
  if (!cityId) {
    return null;
  }
  return catalog.byId.get(cityId) ?? null;
}

/** 浏览器端目录缓存（失败不缓存，刷新可重试） */
let catalogPromise = null;

/**
 * 加载城市目录（fetch + 校验，带缓存）。
 *
 * @param {string} [url] 目录地址
 * @returns {Promise<object>} 归一化目录
 */
export function loadCityCatalog(url = DEFAULT_CATALOG_URL) {
  if (!catalogPromise) {
    catalogPromise = fetch(url, { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`城市目录加载失败：HTTP ${response.status}（${url}）`);
        }
        return normalizeCatalog(await response.json());
      })
      .catch((error) => {
        catalogPromise = null;
        log.error('city.catalog.load.failed', { url }, error);
        throw error;
      });
  }
  return catalogPromise;
}
