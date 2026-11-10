/**
 * 地点配置与解析策略测试（Node 直接运行，不依赖浏览器与网络）。
 *
 * 覆盖：
 * 1. 配置校验/归一化：缺字段报错、默认值填充、重复名/坏别名报错、策略枚举校验；
 * 2. 配置驱动解析：别名、地标、城市、行政区全名/简称、道路精确/包含；
 * 3. 准确率守卫：2 字短查询不参与包含匹配（城市名/路名不再被误命中）；
 * 4. 策略可配置：收紧/放宽最小查询长度确实改变解析结果；
 * 5. 未解析策略默认值；
 * 6. 生产代码无地名扫描：web/src 与 index.html 不得出现城市/地标/行政区名（只允许出现在配置文件里）。
 *
 * 运行：node test/place-gazetteer.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizePlaceConfig } from '../web/src/place-config.js';
import { createPlaceIndex, resolvePlace } from '../web/src/agent/places.js';
import { createAgentController } from '../web/src/agent/controller.js';
import {
  buildNodeIndex,
  buildWalkGraph,
  findLargestComponent,
  graphBounds,
} from '../web/src/engine/graph.js';
import { RAW_PLACE_CONFIG, clonePlaceConfig, placeConfig } from './fixtures/place-config.mjs';

let failures = 0;

/**
 * 断言工具：记录并通过/失败计数。
 *
 * @param {string} label 断言描述
 * @param {boolean} condition 断言条件
 * @param {string} [detail] 失败详情
 */
function check(label, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) {
    failures += 1;
  }
  console.log(`[check] ${label} -> ${ok ? 'PASS' : `FAIL ${detail}`}`);
}

/** 断言代码抛错（配置校验负例） */
function expectThrow(label, fn) {
  let thrown = null;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  check(label, thrown instanceof Error, thrown ? String(thrown) : '未抛错');
}

// ---------- 一、配置校验与默认值 ----------
{
  const minimalCity = {
    id: 'demo',
    label: '演示城',
    names: ['演示城'],
    view: { center: { lat: 1, lng: 2 }, zoom: 10 },
  };
  const defaults = normalizePlaceConfig({ cities: [minimalCity] });
  check('最小配置：activeCityId 默认取第一个城市', defaults.activeCityId === 'demo');
  check('最小配置：匹配策略默认值', 
    defaults.matching.poiContainmentMinQueryLength === 3 &&
      defaults.matching.roadContainmentMinQueryLength === 3 &&
      defaults.matching.roadContainmentMinSegments === 1 &&
      defaults.matching.unresolvedPlace === 'ask',
    JSON.stringify(defaults.matching));
  check('最小配置：覆盖中心/覆盖说明有通用默认值', 
    defaults.activeCity.coverage.centerLabel === '演示城覆盖中心' &&
      defaults.activeCity.coverage.description === '演示城范围');
  const nullMatching = normalizePlaceConfig({ cities: [minimalCity], matching: null });
  check('matching=null：按默认策略处理（不崩）', 
    nullMatching.matching.unresolvedPlace === 'ask' &&
      nullMatching.matching.poiContainmentMinQueryLength === 3);
  check('真实配置：解析出地标/行政区/别名数量', 
    placeConfig.activeCity.pois.length === RAW_PLACE_CONFIG.cities[0].pois.length &&
      placeConfig.activeCity.districts.length === RAW_PLACE_CONFIG.cities[0].districts.length &&
      placeConfig.activeCity.aliases.length === RAW_PLACE_CONFIG.cities[0].aliases.length);

  expectThrow('配置校验：缺少 cities 抛错', () => normalizePlaceConfig({}));
  expectThrow('配置校验：activeCityId 不存在抛错', 
    () => normalizePlaceConfig({ activeCityId: 'nope', cities: [minimalCity] }));
  expectThrow('配置校验：城市重名抛错', () => normalizePlaceConfig({ cities: [minimalCity, minimalCity] }));
  expectThrow('配置校验：地标重复抛错', () =>
    normalizePlaceConfig({
      cities: [{ ...minimalCity, pois: [{ name: '甲', lat: 1, lng: 2 }, { name: '甲', lat: 3, lng: 4 }] }],
    }));
  expectThrow('配置校验：别名指向不存在的地标抛错', () =>
    normalizePlaceConfig({
      cities: [{ ...minimalCity, aliases: [{ text: '乙', target: { type: 'poi', name: '不存在' } }] }],
    }));
  expectThrow('配置校验：行政区简称重复抛错（同时给出两个不同的区）', () =>
    normalizePlaceConfig({
      cities: [{
        ...minimalCity,
        districts: [
          { name: '甲区', point: { lat: 1, lng: 2 }, shortName: '甲' },
          { name: '乙区', point: { lat: 3, lng: 4 }, shortName: '甲' },
        ],
      }],
    }));
  expectThrow('配置校验：未解析策略枚举非法抛错', () =>
    normalizePlaceConfig({ cities: [minimalCity], matching: { unresolvedPlace: 'draw-anywhere' } }));
  expectThrow('配置校验：别名 target.type 非法抛错', () =>
    normalizePlaceConfig({
      cities: [{ ...minimalCity, aliases: [{ text: '乙', target: { type: 'city', name: '演示城' } }] }],
    }));
}

// ---------- 二、合成路网/覆盖上下文（用于解析策略验证） ----------
const LOOP = [
  [113.26, 23.10], [113.30, 23.10], [113.34, 23.10], [113.34, 23.13],
  [113.34, 23.16], [113.30, 23.16], [113.26, 23.16], [113.26, 23.13], [113.26, 23.10],
];
const synthGraph = buildWalkGraph([{ r: [1, 2, 3, 4, 5, 6, 7, 8, 1], c: LOOP }]);
const synthMain = findLargestComponent(synthGraph);
const synthNodeIndex = buildNodeIndex(synthGraph, 0.005, synthMain);
const synthCoverage = graphBounds(synthGraph);
const synthContext = { graph: synthGraph, nodeIndex: synthNodeIndex, coverage: synthCoverage };
const SYNTH_ROADS = [
  { n: '天河北路', c: [[113.32, 23.14], [113.33, 23.14]] },
  { n: '天河路', c: [[113.32, 23.13], [113.33, 23.13]] },
  { n: '体育西路', c: [[113.31, 23.13], [113.31, 23.14]] },
  { n: '中山一路', c: [[113.30, 23.12], [113.31, 23.12]] },
  { n: '东莞庄路', c: [[113.33, 23.15], [113.34, 23.15]] },
];
const synthRoadIndex = createPlaceIndex(SYNTH_ROADS);

/**
 * 用给定配置解析地点。
 *
 * @param {string} query 查询
 * @param {object} [config] 配置
 * @param {object} [options] 其它参数
 * @returns {object|null} 解析结果
 */
function resolveWith(query, config = placeConfig, options = {}) {
  return resolvePlace(query, {
    config,
    roadIndex: synthRoadIndex,
    placeContext: synthContext,
    ...options,
  });
}

// ---------- 三、配置驱动的解析结果 ----------
const POI_ALIAS_CASES = [
  ['小蛮腰', '广州塔'],
  ['越秀', '越秀公园'],
  ['白云', '白云山'],
  ['珠江', '珠江新城'],
  ['花城', '花城广场'],
  ['陈家', '陈家祠'],
  ['沙面', '沙面岛'],
];
for (const [query, expectedLabel] of POI_ALIAS_CASES) {
  const resolved = resolveWith(query);
  check(`别名命中：「${query}」→ ${expectedLabel}`, 
    resolved && resolved.source === 'poi' && resolved.label === expectedLabel,
    resolved ? `${resolved.source}/${resolved.label}` : 'null');
}
const tower = resolveWith('广州塔附近');
check('地标包含（≥3 字）：「广州塔附近」→ 广州塔', tower?.label === '广州塔' && tower?.source === 'poi');
const road = resolveWith('体育西路');
check('道路精确：体育西路 → source=road', road?.source === 'road' && road?.label === '体育西路', road ? road.source : 'null');
const tianheAlias = resolveWith('天河');
check('道路别名（配置声明）：天河 → 道路名包含「天河」', 
  tianheAlias?.source === 'road' && tianheAlias.label.includes('天河'),
  tianheAlias ? `${tianheAlias.source}/${tianheAlias.label}` : 'null');
const city = resolveWith('广州');
check('城市名：广州 → coverage-center（覆盖中心）', city?.source === 'coverage-center', city ? city.source : 'null');
const cityNames = RAW_PLACE_CONFIG.cities[0].names;
for (const name of cityNames) {
  check(`城市名「${name}」均解析`, resolveWith(name)?.source === 'coverage-center');
}
const busanFull = resolveWith('番禺区');
const busanPoint = RAW_PLACE_CONFIG.cities[0].districts.find((entry) => entry.name === '番禺区').point;
check('行政区全名（覆盖外）：番禺区 → district 代表点', 
  busanFull?.source === 'district' && busanFull.lat === busanPoint.lat && busanFull.lng === busanPoint.lng,
  busanFull ? `${busanFull.source}/${busanFull.lat},${busanFull.lng}` : 'null');
const busanShort = resolveWith('番禺');
check('行政区简称（配置声明）：番禺 与全名结果一致', 
  busanShort && busanShort.source === 'district' && busanShort.label === '番禺区' &&
    busanShort.lat === busanFull.lat && busanShort.lng === busanFull.lng);
const yuexiuFull = resolveWith('越秀区');
check('行政区全名（覆盖内）：越秀区 → coverage-center', 
  yuexiuFull?.source === 'coverage-center' && yuexiuFull.label === '越秀区',
  yuexiuFull ? `${yuexiuFull.source}/${yuexiuFull.label}` : 'null');

// ---------- 四、短查询守卫（准确率核心） ----------
for (const query of ['北京', '中山', '东莞', '上海', '深圳', '佛山']) {
  check(`短查询守卫：「${query}」不参与包含匹配 → null`, resolveWith(query) === null, 
    JSON.stringify(resolveWith(query)));
}
check('守卫可被配置放宽：POI 包含最小长度 2 时「北京」会命中更名（证明策略生效）', 
  resolveWith('北京', clonePlaceConfig({ matching: { poiContainmentMinQueryLength: 2 } }))?.source === 'poi');
check('守卫可被配置放宽：道路包含最小长度 2 时「中山」会命中中山一路', 
  resolveWith('中山', clonePlaceConfig({ matching: { roadContainmentMinQueryLength: 2 } }))?.label === '中山一路');

// 覆盖数据缺失：城市/行政区不猜，返回 null
const missingCoverageContext = { graph: synthGraph, nodeIndex: synthNodeIndex, coverage: null };
const emptyGraph = buildWalkGraph([]);
const noGraphContext = {
  graph: emptyGraph,
  nodeIndex: buildNodeIndex(emptyGraph, 0.005, new Set()),
  coverage: null,
};
check('coverage 缺失：「越秀区」返回 null', 
  resolvePlace('越秀区', { config: placeConfig, roadIndex: synthRoadIndex, placeContext: missingCoverageContext }) === null);
check('无路网图（coverage 缺失）：「广州」返回 null', 
  resolvePlace('广州', { config: placeConfig, roadIndex: synthRoadIndex, placeContext: noGraphContext }) === null);
check('无 placeContext：「广州」返回 null（不猜地标/道路）', 
  resolvePlace('广州', { config: placeConfig, roadIndex: synthRoadIndex }) === null);
check('无配置：返回 null 而非抛错', resolvePlace('广州', {}) === null);
check('原型属性名不会被当成别名/区名：「toString」返回 null', resolveWith('toString') === null);

// ---------- 五、控制器强制要求注入配置 ----------
{
  const map = { getCenter: () => ({ lat: 0, lng: 0 }) };
  const engine = { plan: async () => null, formatMinutes: () => '' };
  let thrown = null;
  try {
    createAgentController({ map, engine });
  } catch (error) {
    thrown = error;
  }
  check('createAgentController 缺少 placeConfig 时抛错', thrown instanceof Error);
}

// ---------- 六、生产代码无地名扫描（只允许出现在配置/数据文件） ----------
{
  const FORBIDDEN = [
    '广州', '越秀', '天河', '海珠', '荔湾', '白云', '黄埔', '番禺', '花都', '南沙', '从化', '增城',
    '珠江', '花城', '小蛮腰', '沙面', '陈家祠', '北京路', '北京', '上海', '深圳', '佛山', '中山', '东莞',
  ];
  const SRC_DIR = fileURLToPath(new URL('../web/src/', import.meta.url));
  const INDEX_HTML = fileURLToPath(new URL('../web/index.html', import.meta.url));
  const files = [];
  /** 递归收集参与扫描的源文件（跳过第三方 vendor） */
  function collectPath(path) {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) {
        if (entry === 'vendor') {
          continue; // 第三方库不参与扫描
        }
        collectPath(join(path, entry));
      }
      return;
    }
    if (/\.(js|mjs|html|css)$/.test(path)) {
      files.push(path);
    }
  }
  collectPath(SRC_DIR);
  files.push(INDEX_HTML);
  const hits = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const token of FORBIDDEN) {
      if (text.includes(token)) {
        hits.push(`${file} → ${token}`);
      }
    }
  }
  check(`生产代码无写死地名（扫描 ${files.length} 个文件）`, hits.length === 0, hits.slice(0, 5).join('；'));
  const normalizeSep = (path) => path.replace(/\\/g, '/');
  check('无写死扫描：确认扫描确实覆盖到关键文件', 
    files.some((file) => normalizeSep(file).endsWith('agent/places.js')) &&
      files.some((file) => normalizeSep(file).endsWith('agent/prompt.js')) &&
      files.some((file) => normalizeSep(file).endsWith('main.js')));
  check('配置文件本身包含城市名（数据在配置里）', RAW_PLACE_CONFIG.cities[0].label === '广州');
}

// ---------- 汇总 ----------
console.log('');
console.log(failures === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${failures} checks)`);
process.exitCode = failures === 0 ? 0 : 1;
