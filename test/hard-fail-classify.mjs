/**
 * 硬失败归因纯函数测试。
 *
 * 不加载路网。覆盖：合成网、人工屏障、裁剪窗口、覆盖外、覆盖内空洞，
 * 以及 OSM 面种类的优先级（水面不得被草皮平票盖过）。
 */

import { classifyPlacement, summarizeAttributions } from '../tools/hard-fail-classify.mjs';

let passed = 0;
let failed = 0;

/**
 * 断言一条判定。
 *
 * @param {string} name 用例名
 * @param {object} actual 实际结果
 * @param {object} expected 期望字段
 */
function expect(name, actual, expected) {
  const mismatches = [];
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) {
      mismatches.push(`${key}: 实际 ${JSON.stringify(actual[key])} ≠ 期望 ${JSON.stringify(value)}`);
    }
  }
  if (mismatches.length === 0) {
    passed += 1;
    console.log(`PASS ${name}`);
    return;
  }
  failed += 1;
  console.log(`FAIL ${name}`);
  for (const line of mismatches) {
    console.log(`  ${line}`);
  }
}

/** 构造一个约束点。 */
function point(overrides) {
  return {
    distSample: 10,
    distRegion: 10,
    distCity: 10,
    outsideBbox: false,
    osm: null,
    ...overrides,
  };
}

expect(
  '合成网失败但全城吸得上：语料问题，不是产品路网',
  classifyPlacement({ synthetic: true, severed: false }, [point({ distSample: 200, distCity: 40 })]),
  { corpus: 'synthetic', product: 'city-snap-ok', gapBucket: null },
);

expect(
  '合成网失败且全城也吸不上：两边都记',
  classifyPlacement(
    { synthetic: true, severed: false },
    [point({ distSample: 250, distCity: 180, osm: 'park' })],
  ),
  { corpus: 'synthetic', product: 'city-snap-fail', gapBucket: 'walkable-surface', osmMajority: 'park' },
);

expect(
  '真实分区被人工屏障切断，去掉屏障后全城和窗口都吸得上',
  classifyPlacement(
    { synthetic: false, severed: true },
    [point({ distSample: 300, distRegion: 20, distCity: 20 })],
  ),
  { corpus: 'corpus-sever', product: 'city-snap-ok' },
);

expect(
  '屏障去掉仍然远，但全城吸得上：窗口把路裁掉了',
  classifyPlacement(
    { synthetic: false, severed: true },
    [point({ distSample: 400, distRegion: 400, distCity: 30 })],
  ),
  { corpus: 'corpus-window', product: 'city-snap-ok' },
);

expect(
  '未切路的真实窗口，全城吸得上',
  classifyPlacement(
    { synthetic: false, severed: false },
    [point({ distSample: 220, distRegion: 220, distCity: 50 })],
  ),
  { corpus: 'corpus-window', product: 'city-snap-ok' },
);

expect(
  '全城吸不上的点都在路网 bbox 外',
  classifyPlacement(
    { synthetic: false, severed: false },
    [point({ distSample: 800, distRegion: 800, distCity: 800, outsideBbox: true })],
  ),
  { corpus: 'outside-coverage', product: 'city-snap-fail', farInside: 0, gapBucket: null },
);

expect(
  '覆盖内空洞，多数落在公园',
  classifyPlacement(
    { synthetic: false, severed: false },
    [
      point({ distSample: 200, distRegion: 200, distCity: 200, osm: 'park' }),
      point({ distSample: 180, distRegion: 180, distCity: 180, osm: 'park' }),
      point({ distSample: 160, distRegion: 160, distCity: 40, osm: null }),
    ],
  ),
  { corpus: 'centerline-gap', product: 'city-snap-fail', osmMajority: 'park', gapBucket: 'walkable-surface', farInside: 2 },
);

expect(
  '水面与草皮同票时水面优先',
  classifyPlacement(
    { synthetic: false, severed: false },
    [
      point({ distSample: 200, distRegion: 200, distCity: 200, osm: 'water' }),
      point({ distSample: 200, distRegion: 200, distCity: 220, osm: 'grass' }),
    ],
  ),
  { corpus: 'centerline-gap', osmMajority: 'water', gapBucket: 'water' },
);

expect(
  '建成区不是可通行面',
  classifyPlacement(
    { synthetic: false, severed: false },
    [point({ distSample: 150, distRegion: 150, distCity: 150, osm: 'built' })],
  ),
  { gapBucket: 'built', osmMajority: 'built' },
);

expect(
  '语料图本身没有超 120m：不能当成硬失败重放',
  classifyPlacement({ synthetic: false, severed: false }, [point({ distSample: 119, distCity: 10 })]),
  { corpus: 'replay-mismatch', product: 'city-snap-ok' },
);

expect(
  '还没查 OSM 时不得把空洞说成无标签',
  classifyPlacement(
    { synthetic: false, severed: false },
    [point({ distSample: 200, distRegion: 200, distCity: 200, osm: 'unmeasured' })],
  ),
  { corpus: 'centerline-gap', gapBucket: 'unmeasured', osmMajority: 'unmeasured' },
);

const summary = summarizeAttributions([
  { corpus: 'synthetic', product: 'city-snap-ok', gapBucket: null },
  { corpus: 'centerline-gap', product: 'city-snap-fail', gapBucket: 'water' },
  { corpus: 'centerline-gap', product: 'city-snap-fail', gapBucket: 'water' },
]);
if (summary.count === 3 && summary.corpus.synthetic === 1 && summary.gapBucket.water === 2 && summary.product['city-snap-fail'] === 2) {
  passed += 1;
  console.log('PASS 汇总计数');
} else {
  failed += 1;
  console.log('FAIL 汇总计数', JSON.stringify(summary));
}

console.log(`RESULT ${failed === 0 ? 'PASS' : 'FAIL'} ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
