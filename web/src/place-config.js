/**
 * 地点配置加载与校验（配置驱动，代码内不写死任何城市/地名）。
 *
 * 设计：
 * - 城市、行政区、地标、别名、示例话术、地图默认视野、覆盖说明全部来自
 *   `/data/place-gazetteer.json`（浏览器）或调用方注入的原始配置（Node 测试）；
 * - 本模块只做**结构校验 + 默认值归一化 + 索引字段整理**，不含解析策略；
 * - 解析算法在 `agent/places.js`，通过 `config.activeCity` 与 `config.matching` 工作。
 *
 * 配置格式（version 1）见 web/config/place-gazetteer.json 与 README。
 */

import { createLogger } from './log/index.js';

/** 模块 logger */
const log = createLogger('place-config');

/** 浏览器端默认配置文件地址（配置放 web/config/，与可重新生成的路网数据 web/data/ 分开） */
const DEFAULT_PLACE_CONFIG_URL = '/config/place-gazetteer.json';

/** 当前支持的配置版本 */
const SUPPORTED_VERSION = 1;

/** 未解析地点时的兜底策略取值 */
const UNRESOLVED_PLACE_POLICIES = new Set(['ask', 'view-center']);

/** 别名目标类型 */
const ALIAS_TARGET_TYPES = new Set(['poi', 'district', 'road']);

/**
 * 抛出带字段路径的配置错误，便于定位是哪条配置写错了。
 *
 * @param {string} path 字段路径
 * @param {string} message 错误说明
 * @returns {never}
 */
function fail(path, message) {
  throw new Error(`地点配置错误（${path}）：${message}`);
}

/**
 * 断言字段为非空字符串。
 *
 * @param {unknown} value 待检值
 * @param {string} path 字段路径
 * @param {string} label 字段含义
 * @returns {string} 原字符串
 */
function requireString(value, path, label) {
  if (typeof value !== 'string' || !value.trim()) {
    fail(path, `${label}必须是非空字符串`);
  }
  return value.trim();
}

/**
 * 断言字段为有限数字。
 *
 * @param {unknown} value 待检值
 * @param {string} path 字段路径
 * @param {string} label 字段含义
 * @returns {number} 原数字
 */
function requireNumber(value, path, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(path, `${label}必须是有限数字`);
  }
  return value;
}

/**
 * 断言字段为数组（缺省时给空数组）。
 *
 * @param {unknown} value 待检值
 * @param {string} path 字段路径
 * @param {string} label 字段含义
 * @returns {unknown[]} 数组
 */
function optionalArray(value, path, label) {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    fail(path, `${label}必须是数组`);
  }
  return value;
}

/**
 * 校验并归一化坐标。
 *
 * @param {unknown} value 待检值
 * @param {string} path 字段路径
 * @returns {{lat: number, lng: number}} 坐标
 */
function normalizePoint(value, path) {
  if (!value || typeof value !== 'object') {
    fail(path, '坐标必须是 {lat, lng} 对象');
  }
  return {
    lat: requireNumber(value.lat, `${path}.lat`, '纬度'),
    lng: requireNumber(value.lng, `${path}.lng`, '经度'),
  };
}

/**
 * 归一化匹配策略（全部有默认值，允许配置只写关心项）。
 *
 * @param {object|null|undefined} raw 原始 matching 配置
 * @returns {object} 归一化后的策略
 */
function normalizeMatching(raw) {
  const source = raw ?? {};
  if (typeof source !== 'object' || Array.isArray(source)) {
    fail('matching', '必须是一个对象');
  }
  const policy = {
    coverageMarginDeg: 0.01,
    poiContainmentMinQueryLength: 3,
    roadContainmentMinQueryLength: 3,
    roadContainmentMinSegments: 1,
    unresolvedPlace: 'ask',
  };
  if (source.coverageMarginDeg !== undefined) {
    policy.coverageMarginDeg = requireNumber(source.coverageMarginDeg, 'matching.coverageMarginDeg', '覆盖判断边距');
  }
  if (source.poiContainmentMinQueryLength !== undefined) {
    policy.poiContainmentMinQueryLength = requireNumber(
      source.poiContainmentMinQueryLength,
      'matching.poiContainmentMinQueryLength',
      'POI 包含匹配最小查询长度',
    );
  }
  if (source.roadContainmentMinQueryLength !== undefined) {
    policy.roadContainmentMinQueryLength = requireNumber(
      source.roadContainmentMinQueryLength,
      'matching.roadContainmentMinQueryLength',
      '道路包含匹配最小查询长度',
    );
  }
  if (source.roadContainmentMinSegments !== undefined) {
    policy.roadContainmentMinSegments = requireNumber(
      source.roadContainmentMinSegments,
      'matching.roadContainmentMinSegments',
      '道路包含匹配最小路段数',
    );
  }
  if (source.unresolvedPlace !== undefined) {
    if (!UNRESOLVED_PLACE_POLICIES.has(source.unresolvedPlace)) {
      fail('matching.unresolvedPlace', `只能是 ${[...UNRESOLVED_PLACE_POLICIES].join(' / ')}`);
    }
    policy.unresolvedPlace = source.unresolvedPlace;
  }
  if (policy.poiContainmentMinQueryLength < 1 || policy.roadContainmentMinQueryLength < 1) {
    fail('matching', '包含匹配最小查询长度必须 ≥ 1');
  }
  if (policy.roadContainmentMinSegments < 1) {
    fail('matching.roadContainmentMinSegments', '必须 ≥ 1');
  }
  if (policy.coverageMarginDeg < 0) {
    fail('matching.coverageMarginDeg', '必须 ≥ 0');
  }
  return policy;
}

/**
 * 校验并归一化单个地标。
 *
 * @param {object} raw 原始地标
 * @param {string} path 字段路径
 * @returns {object} 归一化地标
 */
function normalizePoi(raw, path) {
  if (!raw || typeof raw !== 'object') {
    fail(path, '地标必须是对象');
  }
  const point = normalizePoint(raw, path);
  return {
    name: requireString(raw.name, `${path}.name`, '地标名'),
    category: typeof raw.category === 'string' ? raw.category : '',
    lat: point.lat,
    lng: point.lng,
  };
}

/**
 * 校验并归一化单个行政区。
 *
 * @param {object} raw 原始行政区
 * @param {string} path 字段路径
 * @returns {object} 归一化行政区
 */
function normalizeDistrict(raw, path) {
  if (!raw || typeof raw !== 'object') {
    fail(path, '行政区必须是对象');
  }
  if (!raw.point || typeof raw.point !== 'object') {
    fail(`${path}.point`, '缺少代表点 {lat, lng}');
  }
  return {
    name: requireString(raw.name, `${path}.name`, '行政区名'),
    point: normalizePoint(raw.point, `${path}.point`),
    shortName:
      typeof raw.shortName === 'string' && raw.shortName.trim() ? raw.shortName.trim() : null,
  };
}

/**
 * 校验并归一化单条别名。
 *
 * @param {object} raw 原始别名
 * @param {string} path 字段路径
 * @param {Map<string, object>} poiByName 地标索引（校验目标存在性）
 * @param {Map<string, object>} districtByName 行政区索引
 * @returns {object} 归一化别名
 */
function normalizeAlias(raw, path, poiByName, districtByName) {
  if (!raw || typeof raw !== 'object') {
    fail(path, '别名必须是对象');
  }
  const text = requireString(raw.text, `${path}.text`, '别名文本');
  const target = raw.target;
  if (!target || typeof target !== 'object') {
    fail(`${path}.target`, '缺少目标 {type, name}');
  }
  if (!ALIAS_TARGET_TYPES.has(target.type)) {
    fail(`${path}.target.type`, `只能是 ${[...ALIAS_TARGET_TYPES].join(' / ')}`);
  }
  const targetName = requireString(target.name, `${path}.target.name`, '目标名');
  if (target.type === 'poi' && !poiByName.has(targetName)) {
    fail(`${path}.target.name`, `目标地标「${targetName}」不在 pois 列表中`);
  }
  if (target.type === 'district' && !districtByName.has(targetName)) {
    fail(`${path}.target.name`, `目标行政区「${targetName}」不在 districts 列表中`);
  }
  return { text, target: { type: target.type, name: targetName } };
}

/**
 * 校验并归一化单个城市配置。
 *
 * @param {object} raw 原始城市
 * @param {string} [path] 字段路径（报错定位用，缺省 city）
 * @returns {object} 归一化城市
 */
export function normalizeCity(raw, path = 'city') {
  if (!raw || typeof raw !== 'object') {
    fail(path, '城市必须是对象');
  }
  const id = requireString(raw.id, `${path}.id`, '城市 id');
  const label = requireString(raw.label, `${path}.label`, '城市显示名');
  const names = optionalArray(raw.names, `${path}.names`, '城市名列表').map((name, index) =>
    requireString(name, `${path}.names[${index}]`, '城市名'),
  );
  if (names.length === 0) {
    fail(`${path}.names`, '至少配置一个城市名（用于识别用户输入的城市全名/简称）');
  }
  if (!raw.view || typeof raw.view !== 'object') {
    fail(`${path}.view`, '缺少地图默认视野 {center, zoom}');
  }
  const view = {
    center: normalizePoint(raw.view.center, `${path}.view.center`),
    zoom: requireNumber(raw.view.zoom, `${path}.view.zoom`, '缩放级别'),
  };
  const coverage = raw.coverage && typeof raw.coverage === 'object' ? raw.coverage : {};
  const pois = optionalArray(raw.pois, `${path}.pois`, '地标列表').map((poi, index) =>
    normalizePoi(poi, `${path}.pois[${index}]`),
  );
  const districts = optionalArray(raw.districts, `${path}.districts`, '行政区列表').map(
    (district, index) => normalizeDistrict(district, `${path}.districts[${index}]`),
  );
  const roads = raw.roads && typeof raw.roads === 'object' ? raw.roads : {};
  const roadDataUrl =
    typeof roads.dataUrl === 'string' && roads.dataUrl.trim() ? roads.dataUrl.trim() : null;
  const roadExamples = optionalArray(roads.examples, `${path}.roads.examples`, '道路示例').map(
    (example, index) => requireString(example, `${path}.roads.examples[${index}]`, '道路示例'),
  );
  const examples = optionalArray(raw.examples, `${path}.examples`, '示例问法').map(
    (example, index) => requireString(example, `${path}.examples[${index}]`, '示例问法'),
  );

  // 同一城市内名称必须唯一，避免解析结果取决于数组顺序
  const poiByName = new Map();
  for (const poi of pois) {
    if (poiByName.has(poi.name)) {
      fail(`${path}.pois`, `地标名重复：「${poi.name}」`);
    }
    poiByName.set(poi.name, poi);
  }
  const districtByName = new Map();
  for (const district of districts) {
    if (districtByName.has(district.name)) {
      fail(`${path}.districts`, `行政区名重复：「${district.name}」`);
    }
    districtByName.set(district.name, district);
  }
  const shortNameOwner = new Map();
  for (const district of districts) {
    if (!district.shortName) {
      continue;
    }
    if (shortNameOwner.has(district.shortName)) {
      fail(`${path}.districts`, `行政区简称重复：「${district.shortName}」`);
    }
    if (districtByName.has(district.shortName)) {
      fail(`${path}.districts`, `行政区简称与全名相同：「${district.shortName}」`);
    }
    shortNameOwner.set(district.shortName, district);
  }
  const aliases = optionalArray(raw.aliases, `${path}.aliases`, '别名列表').map((alias, index) =>
    normalizeAlias(alias, `${path}.aliases[${index}]`, poiByName, districtByName),
  );
  const aliasTexts = new Set();
  for (const alias of aliases) {
    if (aliasTexts.has(alias.text)) {
      fail(`${path}.aliases`, `别名重复：「${alias.text}」`);
    }
    if (poiByName.has(alias.text)) {
      fail(`${path}.aliases`, `别名「${alias.text}」与地标同名，会永远被地标精确匹配遮蔽`);
    }
    aliasTexts.add(alias.text);
  }

  return {
    id,
    label,
    names,
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : `${label}地图原型`,
    subtitle:
      typeof raw.subtitle === 'string' && raw.subtitle.trim()
        ? raw.subtitle.trim()
        : 'Leaflet + OpenStreetMap',
    mapAriaLabel:
      typeof raw.mapAriaLabel === 'string' && raw.mapAriaLabel.trim()
        ? raw.mapAriaLabel.trim()
        : `${label}地图`,
    view,
    coverage: {
      centerLabel:
        typeof coverage.centerLabel === 'string' && coverage.centerLabel.trim()
          ? coverage.centerLabel.trim()
          : `${label}覆盖中心`,
      description:
        typeof coverage.description === 'string' && coverage.description.trim()
          ? coverage.description.trim()
          : `${label}范围`,
      hint:
        typeof coverage.hint === 'string' && coverage.hint.trim() ? coverage.hint.trim() : label,
    },
    examples,
    roads: { dataUrl: roadDataUrl, examples: roadExamples },
    pois,
    districts,
    aliases,
  };
}

/**
 * 校验并归一化整份地点配置。
 *
 * @param {unknown} raw 原始配置（JSON.parse 结果或测试注入对象）
 * @returns {object} 归一化配置：{version, activeCityId, matching, cities, activeCity}
 */
export function normalizePlaceConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('root', '必须是 JSON 对象');
  }
  if (raw.version !== undefined && raw.version !== SUPPORTED_VERSION) {
    fail('version', `不支持的版本：${raw.version}（当前支持 ${SUPPORTED_VERSION}）`);
  }
  const rawCities = optionalArray(raw.cities, 'cities', '城市列表');
  if (rawCities.length === 0) {
    fail('cities', '至少配置一个城市');
  }
  const cities = rawCities.map((city, index) => normalizeCity(city, `cities[${index}]`));
  const idSeen = new Set();
  for (const city of cities) {
    if (idSeen.has(city.id)) {
      fail('cities', `城市 id 重复：「${city.id}」`);
    }
    idSeen.add(city.id);
  }
  const activeCityId = raw.activeCityId === undefined ? cities[0].id : raw.activeCityId;
  if (typeof activeCityId !== 'string' || !idSeen.has(activeCityId)) {
    fail('activeCityId', `找不到对应城市：「${activeCityId}」`);
  }
  const activeCity = cities.find((city) => city.id === activeCityId);
  const matching = normalizeMatching(raw.matching);
  const config = { activeCityId, matching, cities, activeCity };
  log.info('place.config.ready', {
    activeCityId,
    cities: cities.length,
    pois: activeCity.pois.length,
    districts: activeCity.districts.length,
    aliases: activeCity.aliases.length,
    unresolvedPlace: matching.unresolvedPlace,
  });
  return config;
}

/** 浏览器端配置缓存（失败不缓存，刷新可重试） */
let configPromise = null;

/**
 * 加载地点配置（浏览器端 fetch，带缓存）。
 *
 * @param {string} [url] 配置地址（默认 `/data/place-gazetteer.json`）
 * @returns {Promise<object>} 归一化配置
 */
export function loadPlaceConfig(url = DEFAULT_PLACE_CONFIG_URL) {
  if (!configPromise) {
    configPromise = fetch(url, { cache: 'no-store' })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`地点配置加载失败：HTTP ${response.status}（${url}）`);
        }
        return response.json();
      })
      .then((raw) => normalizePlaceConfig(raw))
      .catch((error) => {
        configPromise = null;
        log.error('place.config.load.failed', { url }, error);
        throw error;
      });
  }
  return configPromise;
}

/**
 * 取当前生效城市（供 UI/提示词/控制器统一读取）。
 *
 * @param {object} config 归一化配置
 * @returns {object|null} 当前城市
 */
export function getActiveCity(config) {
  return config?.activeCity ?? null;
}
