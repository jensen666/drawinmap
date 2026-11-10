/**
 * 城市目录全量验证：逐城实测"获取 bbox 内道路数"，验证中心锚点质量（方案 §8.2）。
 *
 * 对目录里每个非 preset 城市按获取 bbox（center ± halfSpan）向 Overpass 发 `out count`
 * 查询，道路数 < minRoads 判为"锚点可疑"（城郊/山地/水域），需要人工复核修正。
 * 输出 JSON 明细 + 控制台摘要，供方案验证报告引用。
 *
 * 用法：node tools/verify-city-catalog.mjs [--only id1,id2,…] [--min 1000] [--concurrency 2]
 * 产物：docs/测试报告/2026-11-08-按需获取全国城市路网验收/catalog-verify.json
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildBboxQuery, fetchOverpass, resolveOverpassUrls } from '../web/server/city/overpass.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_PATH = join(
  ROOT,
  'docs',
  '测试报告',
  '2026-11-08-按需获取全国城市路网验收',
  'catalog-verify.json',
);

const argv = process.argv.slice(2);
const argOf = (name, fallback = null) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const onlyIds = (argOf('only') ?? '').split(',').map((id) => id.trim()).filter(Boolean);
const MIN_ROADS = Number(argOf('min', '1000'));
const CONCURRENCY = Math.max(1, Number(argOf('concurrency', '2')));

const catalog = JSON.parse(await readFile(join(ROOT, 'web', 'config', 'city-catalog.json'), 'utf8'));
const halfSpan = catalog.fetchHalfSpanDeg ?? { lat: 0.055, lng: 0.07 };
const urls = resolveOverpassUrls(process.env.DRAWINMAP_OVERPASS_URLS);


const cities = catalog.cities.filter((city) => {
  if (city.preset) {
    return false;
  }
  if (onlyIds.length > 0) {
    return onlyIds.includes(city.id);
  }
  return true;
});

console.log(`[verify] ${cities.length} 城（preset 跳过），并发=${CONCURRENCY}，阈值=${MIN_ROADS} 条，镜像=${urls.length}`);

const results = [];
let done = 0;
let startedAt = Date.now();

async function verifyCity(city) {
  const bbox = {
    minLat: Math.round((city.center.lat - halfSpan.lat) * 1e6) / 1e6,
    maxLat: Math.round((city.center.lat + halfSpan.lat) * 1e6) / 1e6,
    minLng: Math.round((city.center.lng - halfSpan.lng) * 1e6) / 1e6,
    maxLng: Math.round((city.center.lng + halfSpan.lng) * 1e6) / 1e6,
  };
  const query = buildBboxQuery(bbox, { mode: 'count', timeoutSec: 120 });
  const record = {
    cityId: city.id,
    label: city.label,
    province: city.province,
    center: city.center,
    bbox: [bbox.minLng, bbox.minLat, bbox.maxLng, bbox.maxLat],
    roads: null,
    ok: false,
    error: null,
    ms: null,
    host: null,
  };
  const started = Date.now();
  try {
    const result = await fetchOverpass({ urls, query, timeoutMs: 150_000 });
    const countElement = (result.json?.elements ?? []).find((element) => element.type === 'count');
    const roads = countElement?.tags?.ways !== undefined ? Number(countElement.tags.ways) : null;
    record.roads = roads;
    record.ok = Number.isFinite(roads) && roads >= MIN_ROADS;
    record.ms = Date.now() - started;
    record.host = result.host;
  } catch (error) {
    record.error = String(error?.message ?? error);
    record.ms = Date.now() - started;
  }
  done += 1;
  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  console.log(
    `[verify ${done}/${cities.length}] ${city.label}（${city.id}）: ${record.error ? `ERROR ${record.error}` : `${record.roads} 条 ${record.ok ? 'OK' : '可疑'}`}（${Math.round(record.ms / 1000)}s，累计 ${elapsed}s）`,
  );
  return record;
}

/** 简易并发池 */
let next = 0;
async function worker() {
  while (next < cities.length) {
    const city = cities[next];
    next += 1;
    results.push(await verifyCity(city));
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, cities.length) }, () => worker()));

const suspicious = results.filter((item) => !item.ok && !item.error);
const errors = results.filter((item) => item.error);
const ok = results.filter((item) => item.ok);
results.sort((a, b) => (a.roads ?? -1) - (b.roads ?? -1));

const summary = {
  generatedAt: new Date().toISOString(),
  total: results.length,
  okCount: ok.length,
  suspiciousCount: suspicious.length,
  errorCount: errors.length,
  minRoads: MIN_ROADS,
  urls,
  suspicious,
  errors,
};

await mkdir(dirname(OUT_PATH), { recursive: true });
await writeFile(OUT_PATH, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
await writeFile(
  OUT_PATH.replace('.json', '-detail.json'),
  `${JSON.stringify(results, null, 2)}\n`,
  'utf8',
);

console.log('\n===== 摘要 =====');
console.log(`通过（≥${MIN_ROADS} 条）：${ok.length}/${results.length}`);
console.log(`可疑（<${MIN_ROADS} 条）：${suspicious.length}${suspicious.length ? ` → ${suspicious.map((item) => `${item.label}(${item.roads})`).join('、')}` : ''}`);
console.log(`查询失败：${errors.length}${errors.length ? ` → ${errors.map((item) => item.label).join('、')}` : ''}`);
console.log(`明细：${OUT_PATH}`);
if (suspicious.length > 0 || errors.length > 0) {
  process.exit(2);
}
