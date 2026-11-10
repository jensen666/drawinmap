/**
 * 城市目录条目 → normalizeCity 兼容配置（零手写地标/行政区/别名，需求 R4）。
 *
 * 新城没有手写 POI 表：地点解析只依赖城市名（→ 覆盖中心）与获取到的真实道路名索引。
 * 覆盖文案按城市全名生成（"<城市全名>已获取的路网覆盖范围"），不冒充整个市域已定位。
 */

import { normalizeCity } from '../place-config.js';

/** 获取缓存文件的浏览器访问地址前缀（服务器落盘目录 web/data/city-roads/） */
const CITY_ROADS_URL_PREFIX = '/data/city-roads/';

/**
 * 目录条目 → 原始城市配置（normalizeCity 输入口径）。
 *
 * @param {object} city 目录条目（city-catalog.json 的 cities[i]）
 * @returns {object} normalizeCity 兼容的原始配置
 */
function catalogCityToRawConfig(city) {
  if (!city?.id || !city?.center) {
    throw new Error(`城市目录条目不完整：${city?.id ?? '(null)'}`);
  }
  const label = city.label || city.fullName;
  return {
    id: city.id,
    label,
    names: city.names?.length ? city.names : [city.fullName || label],
    subtitle: `${city.fullName || label} · Leaflet + OpenStreetMap`,
    view: { center: { lat: city.center.lat, lng: city.center.lng }, zoom: 11 },
    coverage: {
      centerLabel: `${city.fullName || label}路网覆盖中心`,
      description: `${city.fullName || label}已获取的路网覆盖范围`,
      hint: `${city.fullName || label}市区`,
    },
    examples: [`在${label}画个五角星`, `在${label}画个心形`, `在${label}画个矩形`],
    roads: {
      dataUrl: `${CITY_ROADS_URL_PREFIX}${city.id}.json`,
    },
  };
}

/**
 * 目录条目 → 归一化城市配置（复用 place-config 的结构校验与默认值）。
 *
 * @param {object} city 目录条目
 * @returns {object} 归一化城市配置
 */
export function buildCityConfig(city) {
  return normalizeCity(catalogCityToRawConfig(city), `city-catalog(${city?.id ?? '?'})`);
}
