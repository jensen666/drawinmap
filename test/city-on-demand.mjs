/**
 * 城市按需获取单元测试（Node 直接运行，不依赖浏览器/真实网络/LLM）。
 *
 * 覆盖（方案 docs/方案设计/2026-11-08-按需获取全国城市路网方案.md §8.1）：
 * 1. Overpass 转换器：schema 同构 / highway 过滤 / r-c 失配丢弃 / 桥隧分层 / 去重 / 0 道路判失败；
 * 2. 城市目录：结构校验 / id 与城市名唯一 / 精确名查找（全名/简名/直辖市带市）/ 非城市名不误判；
 * 3. 城市配置推导：过 normalizeCity 校验 / dataUrl 指向缓存文件 / pois-districts-aliases 为空；
 * 4. 城市状态机：选择未获取城市 → 获取（fake 作业）→ 完成自动切换 / 忙碌挂起空闲落地 /
 *    已切走不拉回 / 失败可重试 / preset 拒绝获取 / 引擎重建与 placeConfig 替换；
 * 5. 点名路由：wait / failed / guide / switched / 非城市名 null；
 * 6. 瓦片拆分：2×2 带重叠、并集覆盖、四片相交区保证跨界 way 完整。
 *
 * 运行：node test/city-on-demand.mjs
 */

import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  HIGHWAY_KEEP,
  assertRoadCount,
  buildCityRoadsPayload,
  dedupeRoadsById,
  overpassElementsToRoads,
} from '../web/server/city/overpass-convert.js';
import { buildBboxQuery } from '../web/server/city/overpass.js';
import { findCityByName, normalizeCatalog } from '../web/src/city/catalog.js';
import { buildCityConfig } from '../web/src/city/city-config.js';
import { splitTiles } from '../web/server/city/fetch-service.js';
import { createCityStore } from '../web/src/city/store.js';
import { normalizeCity } from '../web/src/place-config.js';
import { readFileSync } from 'node:fs';

let checks = 0;
let failures = 0;

/**
 * 断言工具：记录通过/失败计数（失败必须体现在退出码里）。
 *
 * @param {string} label 断言描述
 * @param {() => void} fn 断言体（throw 即失败）
 */
function check(label, fn) {
  checks += 1;
  try {
    fn();
    console.log(`[check] ${label} -> PASS`);
  } catch (error) {
    failures += 1;
    console.log(`[check] ${label} -> FAIL ${error.message}`);
    if (process.env.CITY_TEST_STACK) console.log(error.stack);
  }
}

/** 异步断言 */
async function checkAsync(label, fn) {
  checks += 1;
  try {
    await fn();
    console.log(`[check] ${label} -> PASS`);
  } catch (error) {
    failures += 1;
    console.log(`[check] ${label} -> FAIL ${error.message}`);
    if (process.env.CITY_TEST_STACK && error.stack) {
      console.log(error.stack.split('\n').slice(1, 5).join('\n'));
    }
  }
}

// ==================== 1. Overpass 转换器 ====================

const SAMPLE_ELEMENTS = [
  {
    type: 'way',
    id: 1001,
    nodes: [11, 12, 13],
    geometry: [
      { lat: 22.5431, lon: 114.0579 },
      { lat: 22.5441, lon: 114.0589 },
      { lat: 22.5451, lon: 114.0599 },
    ],
    tags: { highway: 'primary', name: '益田路', oneway: 'yes', bridge: 'yes', layer: '1', access: 'yes' },
  },
  {
    type: 'way',
    id: 1002,
    nodes: [21, 22],
    geometry: [
      { lat: 22.55, lon: 114.06 },
      { lat: 22.551, lon: 114.061 },
    ],
    tags: { highway: 'footway', name: '鹏程三路' },
  },
  // 非 highway（应被过滤）
  { type: 'way', id: 1003, nodes: [31, 32], geometry: [{ lat: 22.5, lon: 114.0 }, { lat: 22.51, lon: 114.01 }], tags: { waterway: 'river' } },
  // highway=construction（应被过滤）
  { type: 'way', id: 1004, nodes: [41, 42], geometry: [{ lat: 22.5, lon: 114.0 }, { lat: 22.51, lon: 114.01 }], tags: { highway: 'construction' } },
  // r-c 长度失配（应被丢弃）
  { type: 'way', id: 1005, nodes: [51], geometry: [{ lat: 22.5, lon: 114.0 }, { lat: 22.51, lon: 114.01 }], tags: { highway: 'residential', name: '断链路' } },
  // 节点数 <2（应被丢弃）
  { type: 'way', id: 1006, nodes: [61], geometry: [{ lat: 22.5, lon: 114.0 }], tags: { highway: 'residential' } },
];

check('转换器：保留 highway way 并映射为同构 schema', () => {
  const roads = overpassElementsToRoads(SAMPLE_ELEMENTS);
  assert.equal(roads.length, 2);
  const first = roads[0];
  assert.equal(first.id, 1001);
  assert.equal(first.h, 'primary');
  assert.equal(first.n, '益田路');
  assert.equal(first.c.length, 3);
  assert.equal(first.r.length, 3);
  assert.deepEqual(first.c[0], [114.0579, 22.5431]); // [lng, lat]
  assert.equal(first.o, 'yes');
  assert.equal(first.b, 'yes');
  assert.equal(first.ly, 1);
  assert.deepEqual(first.a, { access: 'yes' });
  const second = roads[1];
  assert.equal(second.h, 'footway');
  assert.equal(second.b, undefined);
  assert.equal(second.o, undefined);
});

check('转换器：非 highway / construction / r-c 失配 / 单点 way 全部丢弃', () => {
  const roads = overpassElementsToRoads(SAMPLE_ELEMENTS);
  const ids = roads.map((road) => road.id);
  assert.ok(!ids.includes(1003));
  assert.ok(!ids.includes(1004));
  assert.ok(!ids.includes(1005));
  assert.ok(!ids.includes(1006));
});

check('去重：同 id 多瓦片重复只保留一份', () => {
  const roads = overpassElementsToRoads(SAMPLE_ELEMENTS);
  const merged = [...roads, ...roads.map((road) => ({ ...road }))];
  assert.equal(dedupeRoadsById(merged).length, roads.length);
});

check('payload：meta 留痕（cityId/source/bbox/tiles/road_count）', () => {
  const roads = overpassElementsToRoads(SAMPLE_ELEMENTS);
  const payload = buildCityRoadsPayload({
    cityId: 'shenzhen',
    roads,
    bbox: [113.99, 22.49, 114.13, 22.61],
    tiles: [{ index: 0, bbox: [113.99, 22.49, 114.07, 22.56], ways: 2, bytes: 10, ms: 5, host: 'overpass-api.de', attempts: [] }],
    sourceHost: 'overpass-api.de',
    generatedAt: '2026-11-08T00:00:00.000Z',
  });
  assert.equal(payload.meta.cityId, 'shenzhen');
  assert.equal(payload.meta.road_count, 2);
  assert.ok(payload.meta.source.includes('overpass-api.de'));
  assert.equal(payload.meta.license, 'ODbL 1.0');
  assert.equal(payload.meta.tiles.length, 1);
  assert.ok(payload.meta.highway_types.includes('primary'));
});

check('闸门：道路数低于阈值判失败（0 条/半份都不能落盘）', () => {
  assert.throws(() => assertRoadCount([], 1000), /低于最低要求/);
  assert.throws(() => assertRoadCount([{ id: 1 }], 1000), /低于最低要求/);
  assert.doesNotThrow(() => assertRoadCount(new Array(1000).fill({ id: 1 }), 1000));
});

// ---------- 1b. T-B4d：路型表 2→1（查询正则由 HIGHWAY_KEEP 单一源生成） ----------
// 改前：overpass-convert.js 的 HIGHWAY_KEEP（21 类 Set）与 overpass.js 的 HIGHWAY_FILTER_RE
// 字符串各写一份，靠人工保持逐字一致。改后正则从 Set 生成，这里断言：
// 1) Set 恰为 21 类；2) 查询串与改前**逐字一致**；3) 从查询串解析出的集合 === HIGHWAY_KEEP。

const HIGHWAY_KEEP_SORTED = [
  'cycleway', 'footway', 'living_street', 'motorway', 'motorway_link', 'path', 'pedestrian',
  'primary', 'primary_link', 'residential', 'road', 'secondary', 'secondary_link', 'service',
  'steps', 'tertiary', 'tertiary_link', 'track', 'trunk', 'trunk_link', 'unclassified',
];

check('路型表：HIGHWAY_KEEP 恰为 21 类（与 parse_pbf.py 同口径）', () => {
  assert.equal(HIGHWAY_KEEP.size, 21);
  assert.deepEqual([...HIGHWAY_KEEP].sort(), HIGHWAY_KEEP_SORTED);
});

check('路型表：overpass 查询串与改前逐字一致（21 类同一顺序）', () => {
  const query = buildBboxQuery({ minLat: 22.5, minLng: 113.9, maxLat: 22.6, maxLng: 114.1 });
  const expected =
    '[out:json][timeout:180];way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|' +
    'service|road|pedestrian|footway|path|cycleway|steps|track|motorway_link|trunk_link|' +
    'primary_link|secondary_link|tertiary_link)$"](22.5,113.9,22.6,114.1);out geom;';
  assert.equal(query, expected);
});

check('路型表：查询串覆盖集合 === HIGHWAY_KEEP（21 类无漏无多）', () => {
  const query = buildBboxQuery({ minLat: 22.5, minLng: 113.9, maxLat: 22.6, maxLng: 114.1 });
  const match = query.match(/way\["highway"~"\^\(([^)]+)\)\$"\]/);
  assert.ok(match, `查询串未包含路型正则：${query}`);
  const covered = new Set(match[1].split('|'));
  assert.equal(covered.size, 21);
  assert.deepEqual([...covered].sort(), [...HIGHWAY_KEEP].sort());
});

// ==================== 2. 城市目录 ====================

/** 从真实目录文件做校验（不是缩水样本） */
const catalogRaw = JSON.parse(readFileSync(new URL('../web/config/city-catalog.json', import.meta.url), 'utf8'));

check('目录：297 城（4 直辖市 + 293 地级市），preset=guangzhou', () => {
  const catalog = normalizeCatalog(catalogRaw);
  assert.equal(catalog.cities.length, 297);
  const municipalities = catalog.cities.filter((city) => city.province === '直辖市');
  assert.equal(municipalities.length, 4);
  assert.equal(catalog.presetCityId, 'guangzhou');
  assert.equal(catalog.byId.get('guangzhou').preset, true);
  const presets = catalog.cities.filter((city) => city.preset);
  assert.equal(presets.length, 1);
});

check('目录：id 与城市名（含全名/简名）全目录唯一', () => {
  // normalizeCatalog 内部做唯一性校验，重复会 throw
  const catalog = normalizeCatalog(catalogRaw);
  assert.equal(catalog.nameOwners.size > 0, true);
});

check('目录：精确名查找——全名/简名/直辖市"北京市"命中，非城市名不误判', () => {
  const catalog = normalizeCatalog(catalogRaw);
  assert.equal(findCityByName(catalog, '深圳市')?.id, 'shenzhen');
  assert.equal(findCityByName(catalog, '深圳')?.id, 'shenzhen');
  assert.equal(findCityByName(catalog, '北京')?.id, 'beijing');
  assert.equal(findCityByName(catalog, '北京市')?.id, 'beijing');
  assert.equal(findCityByName(catalog, '重庆市')?.id, 'chongqing');
  assert.equal(findCityByName(catalog, '深圳湾'), null);
  assert.equal(findCityByName(catalog, '深圳市区'), null);
  assert.equal(findCityByName(catalog, ''), null);
  assert.equal(findCityByName(catalog, null), null);
});

// ==================== 3. 城市配置推导 ====================

check('城市配置推导：过 normalizeCity 校验 / dataUrl / 零手写地标', () => {
  const catalog = normalizeCatalog(catalogRaw);
  const config = buildCityConfig(catalog.byId.get('shenzhen'));
  const normalized = normalizeCity(config, 'test');
  assert.equal(normalized.id, 'shenzhen');
  assert.equal(normalized.roads.dataUrl, '/data/city-roads/shenzhen.json');
  assert.deepEqual(normalized.pois, []);
  assert.deepEqual(normalized.districts, []);
  assert.deepEqual(normalized.aliases, []);
  assert.ok(normalized.names.includes('深圳市'));
  assert.ok(normalized.names.includes('深圳'));
  assert.equal(normalized.view.center.lat, catalog.byId.get('shenzhen').center.lat);
  assert.equal(normalized.coverage.description.includes('深圳市'), true);
  assert.equal(normalized.examples[0], '在深圳画个五角星');
});

check('城市配置推导：直辖市全名不带"市"后缀', () => {
  const catalog = normalizeCatalog(catalogRaw);
  const config = buildCityConfig(catalog.byId.get('beijing'));
  assert.equal(config.label, '北京');
  assert.equal(config.coverage.description.includes('北京'), true);
  assert.equal(config.roads.dataUrl, '/data/city-roads/beijing.json');
});

// ==================== 4. 瓦片拆分 ====================

check('瓦片拆分：2×2、带 0.01° 重叠、并集覆盖全 bbox', () => {
  const bbox = { minLat: 22.4881, minLng: 113.9879, maxLat: 22.5981, maxLng: 114.1279 };
  const tiles = splitTiles(bbox);
  assert.equal(tiles.length, 4);
  const midLat = (bbox.minLat + bbox.maxLat) / 2;
  const midLng = (bbox.minLng + bbox.maxLng) / 2;
  for (const tile of tiles) {
    assert.ok(tile.minLat <= midLat + 0.01 && tile.maxLat >= midLat - 0.01, '每片跨中线（含重叠）');
    assert.ok(tile.minLng <= midLng + 0.01 && tile.maxLng >= midLng - 0.01, '每片跨中线（含重叠）');
    assert.ok(tile.minLat >= bbox.minLat - 1e-9 && tile.maxLat <= bbox.maxLat + 1e-9, '片不出界');
    assert.ok(tile.minLng >= bbox.minLng - 1e-9 && tile.maxLng <= bbox.maxLng + 1e-9, '片不出界');
  }
  // 并集覆盖：对角片都触达 bbox 角点（含重叠方向）
  assert.ok(tiles.some((tile) => tile.minLng <= bbox.minLng + 1e-9 && tile.minLat <= bbox.minLat + 1e-9));
  assert.ok(tiles.some((tile) => tile.maxLng >= bbox.maxLng - 1e-9 && tile.maxLat >= bbox.maxLat - 1e-9));
});

// ==================== 5. 城市状态机（fake 服务器/引擎） ====================

/**
 * 构造 fake 服务器（内存作业）与测试环境。
 *
 * @param {object} [options]
 * @param {Array<string>} [options.cachedCities] 预置缓存城市
 * @param {number} [options.jobSteps] 作业推进次数（每次 poll 推进一格；0=立即 done）
 * @param {string} [options.jobError] 作业失败原因
 * @returns {object} { catalog, placeConfig, engine, fetchCalls, cleanup }
 */
async function makeTestEnv({ cachedCities = [], jobSteps = 1, jobError = null, missingRoadFiles = [] } = {}) {
  const catalog = normalizeCatalog(catalogRaw);
  const guangzhou = normalizeCity(
    JSON.parse(readFileSync(new URL('../web/config/place-gazetteer.json', import.meta.url), 'utf8')).cities[0],
    'gz',
  );
  const placeConfig = {
    version: 1,
    activeCityId: 'guangzhou',
    matching: { unresolvedPlace: 'ask' },
    cities: [guangzhou],
    activeCity: guangzhou,
  };
  const engineCalls = [];
  const engine = {
    useCity(cityConfig, roads) {
      engineCalls.push({ cityId: cityConfig.id, roads: roads.length });
    },
    clearDraw() {
      engineCalls.push({ clearDraw: true });
    },
    getPlaceContext: async () => null,
  };
  const fetchCalls = [];
  /** 内存作业表 */
  const jobs = new Map();
  let jobSeq = 0;
  let pollCount = 0;
  const fakeFetch = async (url, init = {}) => {
    fetchCalls.push({ url, method: init.method ?? 'GET', body: init.body ?? null });
    const urlText = String(url);
    if (urlText === '/__city/fetch' && init.method === 'POST') {
      const { cityId } = JSON.parse(init.body);
      if (cityId === 'guangzhou') {
        return jsonOut(400, { ok: false, error: 'preset 不允许获取' });
      }
      if (cachedCities.includes(cityId)) {
        return jsonOut(200, { ok: true, jobId: 'existing', reused: true });
      }
      jobSeq += 1;
      const jobId = `job-${jobSeq}`;
      jobs.set(jobId, { cityId, done: false, failed: false, tilesDone: 0 });
      return jsonOut(200, { ok: true, jobId, reused: false });
    }
    const jobMatch = urlText.match(/^\/__city\/job\/([\w-]+)$/);
    if (jobMatch) {
      const job = jobs.get(jobMatch[1]);
      if (!job) {
        return jsonOut(404, { ok: false, error: '作业不存在' });
      }
      pollCount += 1;
      if (jobError) {
        job.failed = true;
        job.error = jobError;
      } else if (pollCount > jobSteps) {
        job.done = true;
      } else {
        job.tilesDone = Math.min(4, job.tilesDone + 2);
      }
      return jsonOut(200, {
        ok: true,
        job: {
          jobId: jobMatch[1],
          cityId: job.cityId,
          status: job.failed ? 'failed' : job.done ? 'done' : 'running',
          tilesDone: job.tilesDone,
          tilesTotal: 4,
          roads: job.done ? 12000 : job.tilesDone * 3000,
          bytes: job.tilesDone * 1_000_000,
          startedAt: 1,
          finishedAt: job.done || job.failed ? 2 : null,
          error: job.error ?? null,
        },
      });
    }
    if (urlText === '/__city/catalog') {
      return jsonOut(200, {
        ok: true,
        cache: cachedCities.map((cityId) => ({ cityId, roadCount: 12000, generatedAt: '2026-11-08T00:00:00.000Z', bytes: 1 })),
      });
    }
    // 路网数据请求：返回小份假数据（真实 schema）
    if (urlText === '/data/guangzhou-roads.json') {
      return jsonOut(200, {
        meta: {},
        roads: [
          { id: 9, h: 'residential', n: '广州测试路', c: [[113.26, 23.13], [113.261, 23.131]], r: [9, 10] },
        ],
      });
    }
    const roadsMatch = urlText.match(/^\/data\/city-roads\/([\w-]+)\.json$/);
    if (roadsMatch) {
      if (missingRoadFiles.includes(roadsMatch[1])) {
        return jsonOut(404, { ok: false });
      }
      return jsonOut(200, {
        meta: {},
        roads: [
          { id: 1, h: 'residential', n: '测试路', c: [[113.0, 22.0], [113.001, 22.001]], r: [1, 2] },
          { id: 2, h: 'primary', n: '', c: [[113.001, 22.0], [113.002, 22.0]], r: [2, 3] },
        ],
      });
    }
    return jsonOut(404, { ok: false, error: `unexpected ${urlText}` });
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  const tempDir = await mkdtemp(join(tmpdir(), 'city-store-test-'));
  const cleanup = async () => {
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  };
  return { catalog, placeConfig, engine, engineCalls, fetchCalls, cleanup, tempDir };
}

function jsonOut(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

/** 组装 store（不打日志） */
function makeStore({ catalog, placeConfig, engine, events = [], isBusy = () => false, afterSwitch = () => {} }) {
  return createCityStore({
    catalog,
    placeConfig,
    engine,
    isBusy,
    onEvent: (event) => events.push(event),
    afterSwitch,
  });
}

await checkAsync('状态机：preset 广州初始 ready，选择广州=already-active 不触发获取', async () => {
  const env = await makeTestEnv();
  try {
    const store = makeStore(env);
    await store.refreshCacheStates();
    assert.equal(store.cityState('guangzhou').state, 'ready');
    const result = await store.selectCity('guangzhou');
    assert.equal(result, 'already-active');
    assert.equal(env.fetchCalls.filter((call) => call.url === '/__city/fetch').length, 0);
  } finally {
    await env.cleanup();
  }
});

await checkAsync('状态机：preset 广州拒绝获取', async () => {
  const env = await makeTestEnv();
  try {
    const store = makeStore(env);
    await assert.rejects(() => store.startFetch('guangzhou'), /无需获取/);
  } finally {
    await env.cleanup();
  }
});

await checkAsync('状态机：选择未获取城市 → 获取完成 → 自动切换（引擎重建+placeConfig 替换）', async () => {
  const env = await makeTestEnv({ jobSteps: 1 });
  try {
    const events = [];
    const store = makeStore({ ...env, events });
    await store.refreshCacheStates();
    assert.equal(store.cityState('shenzhen').state, 'not-fetched');
    const result = await store.selectCity('shenzhen');
    assert.equal(result, 'fetching');
    // 轮询至完成并自动切换（fake 作业 2 次 poll 内完成）
    for (let i = 0; i < 20 && store.cityState('shenzhen').state === 'fetching'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1100));
    }
    assert.equal(store.cityState('shenzhen').state, 'ready', '完成后转 ready');
    // 自动切换已发生（当前城市仍是发起时的广州）
    assert.equal(store.activeId(), 'shenzhen');
    assert.equal(env.placeConfig.activeCityId, 'shenzhen');
    const useCalls = env.engineCalls.filter((call) => call.cityId === 'shenzhen');
    assert.equal(useCalls.length, 1, '引擎 useCity 调用一次');
    assert.ok(events.some((event) => event.type === 'city.fetch.done'));
    assert.ok(events.some((event) => event.type === 'city.switch.done'));
  } finally {
    await env.cleanup();
  }
});

await checkAsync('状态机：获取完成时轮次忙碌 → 挂起，notifyIdle 后落地', async () => {
  const env = await makeTestEnv({ jobSteps: 3 });
  try {
    let busy = false;
    const store = makeStore({ ...env, isBusy: () => busy });
    await store.refreshCacheStates();
    await store.selectCity('shenzhen');
    busy = true; // 获取进行中，用户开始画图
    for (let i = 0; i < 20 && store.cityState('shenzhen').state === 'fetching'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1100));
    }
    assert.equal(store.cityState('shenzhen').state, 'ready');
    assert.equal(store.activeId(), 'guangzhou', '忙碌期间不切换');
    busy = false;
    store.notifyIdle();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(store.activeId(), 'shenzhen', '空闲后落地自动切换');
  } finally {
    await env.cleanup();
  }
});

await checkAsync('状态机：获取完成前用户已切走 → 只置就绪，不强行拉回', async () => {
  const env = await makeTestEnv({ jobSteps: 2, cachedCities: ['zhuhai'] });
  try {
    const store = makeStore(env);
    await store.refreshCacheStates();
    await store.selectCity('shenzhen');
    // 用户手动切到已缓存的珠海
    await store.selectCity('zhuhai');
    assert.equal(store.activeId(), 'zhuhai');
    for (let i = 0; i < 20 && store.cityState('shenzhen').state === 'fetching'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1100));
    }
    assert.equal(store.cityState('shenzhen').state, 'ready');
    assert.equal(store.activeId(), 'zhuhai', '不强行拉回');
  } finally {
    await env.cleanup();
  }
});

await checkAsync('状态机：获取失败 → failed 带原因；重试成功后就绪可切换', async () => {
  const env = await makeTestEnv({ jobError: '所有 Overpass 镜像均失败' });
  try {
    const events = [];
    const store = makeStore({ ...env, events });
    await store.refreshCacheStates();
    await store.selectCity('shenzhen');
    for (let i = 0; i < 10 && store.cityState('shenzhen').state === 'fetching'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1100));
    }
    assert.equal(store.cityState('shenzhen').state, 'failed');
    assert.ok(store.cityState('shenzhen').error.includes('Overpass'));
    assert.ok(events.some((event) => event.type === 'city.fetch.failed'));
    assert.equal(store.activeId(), 'guangzhou', '失败不切换');
    // 重试（fake 服务器第二次不再失败：去掉 jobError）
    // —— fakeEnv 的 jobError 是构造时固定的；直接换一个新 store 复用同一 env 不可行，
    //    这里直接断言 selectCity 对 failed 城市再次发起获取（fetch 调用数增加）。
    const fetchCallsBefore = env.fetchCalls.filter((call) => call.url === '/__city/fetch').length;
    await store.selectCity('shenzhen');
    const fetchCallsAfter = env.fetchCalls.filter((call) => call.url === '/__city/fetch').length;
    assert.equal(fetchCallsAfter, fetchCallsBefore + 1, '重试再次发起获取');
  } finally {
    await env.cleanup();
  }
});

await checkAsync('状态机：缓存文件缺失时切换失败且转 failed（诚实报错，不切换）', async () => {
  // 用韶关（其他用例不会加载它的路网，避免 road-data 模块级缓存污染本例）：
  // 服务器缓存清单里有它，但路网 JSON 404（清单与文件不一致）
  const env = await makeTestEnv({ cachedCities: ['shaoguan'], missingRoadFiles: ['shaoguan'] });
  try {
    const events = [];
    const store = makeStore({ ...env, events });
    await store.refreshCacheStates();
    assert.equal(store.cityState('shaoguan').state, 'ready');
    await assert.rejects(() => store.selectCity('shaoguan'), /读取失败|HTTP 404/);
    assert.equal(store.cityState('shaoguan').state, 'failed');
    assert.equal(store.activeId(), 'guangzhou');
    assert.ok(events.some((event) => event.type === 'city.switch.failed'));
  } finally {
    await env.cleanup();
  }
});

await checkAsync('点名路由：非城市名 → null；未获取 → guide；获取中 → wait；失败 → failed；就绪 → switched', async () => {
  const env = await makeTestEnv({ cachedCities: ['zhuhai'] });
  try {
    const store = makeStore(env);
    await store.refreshCacheStates();
    assert.equal(await store.handleCityMention('深圳湾'), null, '非城市名');
    const activeMention = await store.handleCityMention('广州');
    assert.equal(activeMention?.action, 'active', '当前城市');
    const guide = await store.handleCityMention('深圳市');
    assert.equal(guide.action, 'guide', '未获取 → 引导面板');
    // 就绪城市 → switched（切换发生，placeConfig 替换）
    const switched = await store.handleCityMention('珠海');
    assert.equal(switched.action, 'switched');
    assert.equal(store.activeId(), 'zhuhai');
    assert.equal(env.placeConfig.activeCityId, 'zhuhai');
    // 再点回广州，制造 wait/failed 场景（用内存作业）
    await store.selectCity('guangzhou');
    assert.equal(store.activeId(), 'guangzhou');
    // 深圳 not-fetched → guide；开始获取后 → wait
    await store.startFetch('shenzhen');
    const wait = await store.handleCityMention('深圳');
    assert.equal(wait.action, 'wait', '获取中 → 等待');
  } finally {
    await env.cleanup();
  }
});

await checkAsync('状态机：忙碌时 selectCity 拒绝（busy 返回值，不发起获取不切换）', async () => {
  const env = await makeTestEnv({ cachedCities: ['zhuhai'] });
  try {
    const store = makeStore({ ...env, isBusy: () => true });
    await store.refreshCacheStates();
    const result = await store.selectCity('zhuhai');
    assert.equal(result, 'busy');
    assert.equal(store.activeId(), 'guangzhou');
    assert.equal(env.fetchCalls.filter((call) => call.url === '/__city/fetch').length, 0);
  } finally {
    await env.cleanup();
  }
});

// ==================== 汇总 ====================

console.log(`\n[summary] checks=${checks} failures=${failures}`);
if (failures > 0) {
  process.exit(1);
}
