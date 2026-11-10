/**
 * 地点解析：行政区优先 / 覆盖中心 / source 测试（Node 直接运行，不依赖浏览器与网络）。
 *
 * 解析算法本身不含任何地名（全部来自 web/config/place-gazetteer.json）；
 * 本测试用配置 fixture 注入，验证配置驱动的解析行为：
 * - 合成路网（主分量在外围包住中心 + 一个不连通小分量）：验证市名落覆盖中心时
 *   坐标等于包围盒中点最近节点的坐标（不是裸中点、不是另一分量的节点）；
 * - 空包围盒（空路网 / 只剩不可步行道路）与空 nodeIndex 时市名返回 null，
 *   且不回退到道路包含匹配（不得落同名前缀道路）；
 * - 真实路网（mapdata + createPlaceIndex）：POI 精确/别名/包含保持原行为；
 *   行政区全名/简称落覆盖中心、覆盖外保留代表点；
 * - 没有 placeContext 时市名/区名逻辑不参与（未解析返回 null，不猜地标/道路）。
 *
 * 运行：node test/place-context.mjs（node 不在 PATH 时用全路径）
 */

import { GUANGZHOU_ROADS_HINT, readRequiredText } from './lib/require-data.mjs';
import {
  buildNodeIndex,
  buildWalkGraph,
  findLargestComponent,
  graphBounds,
  nearestNode,
  pointInBounds,
} from '../web/src/engine/graph.js';
import { createPlaceIndex, resolvePlace as resolvePlaceRaw } from '../web/src/agent/places.js';
import { placeConfig } from './fixtures/place-config.mjs';

/**
 * 测试统一带上地点配置（解析算法不再内置默认地名表）。
 *
 * @param {string} query 查询文本
 * @param {object} [options] 其它参数（roadIndex/placeContext）
 * @returns {object|null} 解析结果
 */
function resolvePlace(query, options = {}) {
  return resolvePlaceRaw(query, { config: placeConfig, ...options });
}

let passed = 0;
let failed = 0;

/** 断言工具：记录并通过/失败计数 */
function check(label, condition, detail = '') {
  const ok = Boolean(condition);
  if (ok) {
    passed += 1;
  } else {
    failed += 1;
  }
  console.log(`[check] ${label} -> ${ok ? 'PASS' : `FAIL ${detail}`}`);
}

/** 覆盖判断边距（与引擎 outsideCoverage 一致） */
const MARGIN_DEG = 0.01;

/** 行政区代表点：直接从地点配置读取（测试不再复制一份地名表） */
const DISTRICT_POINTS = Object.fromEntries(
  placeConfig.activeCity.districts.map((district) => [district.name, district.point]),
);

/** 覆盖内（代表点落在加载路网包围盒内）的区 */
const DISTRICTS_INSIDE = ['越秀区', '荔湾区', '海珠区', '天河区', '白云区'];
/** 覆盖外（代表点在包围盒外）的区 */
const DISTRICTS_OUTSIDE = ['黄埔区', '番禺区', '花都区', '南沙区', '从化区', '增城区'];

/** 包围盒中点（度） */
function boundsMidpoint(bounds) {
  return {
    lat: (bounds.minLat + bounds.maxLat) / 2,
    lng: (bounds.minLng + bounds.maxLng) / 2,
  };
}

/** 判断结果是否与包围盒中点不同（至少相差约 50m，防止直接返回裸中点） */
function differsFromMidpoint(place, mid) {
  return Math.abs(place.lat - mid.lat) + Math.abs(place.lng - mid.lng) > 0.0005;
}

/**
 * 断言覆盖中心：source/label 正确、坐标等于最近节点坐标、在覆盖范围内且不是裸中点。
 *
 * @param {string} label 断言标签前缀
 * @param {object|null} place resolvePlace 结果
 * @param {{graph: object, nodeIndex: object, coverage: object}} context 地点上下文
 * @param {{label: string}} expected 期望 label
 */
function expectCoverageCenter(label, place, context, expected) {
  const mid = boundsMidpoint(context.coverage);
  const nearest = nearestNode(context.nodeIndex, context.graph, mid.lng, mid.lat);
  const node = nearest.id === null ? null : context.graph.nodes.get(nearest.id);
  check(`${label}：source=coverage-center`, place && place.source === 'coverage-center', place ? `实际 ${place.source}` : 'null');
  check(`${label}：label=${expected.label}`, place && place.label === expected.label, place ? `实际 ${place.label}` : 'null');
  check(
    `${label}：坐标=包围盒中点最近节点（不是裸中点）`,
    place &&
      node &&
      place.lat === node[1] &&
      place.lng === node[0] &&
      differsFromMidpoint(place, mid),
    place && node ? `实际 ${place.lat},${place.lng} / 节点 ${node[1]},${node[0]} / 中点 ${mid.lat},${mid.lng}` : 'null',
  );
  check(
    `${label}：pointInBounds(coverage, center, 0.01)=true`,
    place && pointInBounds(context.coverage, place, MARGIN_DEG),
    place ? `${place.lat},${place.lng}` : 'null',
  );
}

// ---------- 一、合成路网：主分量外圈 + 不连通小分量 ----------
const OUTER_POINTS = [
  [113.28, 23.11],
  [113.3, 23.11],
  [113.32, 23.11],
  [113.32, 23.13],
  [113.32, 23.15],
  [113.3, 23.15],
  [113.28, 23.15],
  [113.28, 23.13],
];
/** 合成路网：主分量是外圈（8 节点闭环），小分量落在包围盒中点附近（2 节点，不连通） */
const SYNTHETIC_ROADS = [
  {
    id: 1,
    h: 'residential',
    n: '广州大道合成段',
    r: [1, 2, 3, 4, 5, 6, 7, 8, 1],
    c: [...OUTER_POINTS, OUTER_POINTS[0]],
  },
  {
    id: 2,
    h: 'residential',
    n: '中心支路',
    r: [101, 102],
    c: [
      [113.3, 23.13],
      [113.301, 23.131],
    ],
  },
];

const syntheticGraph = buildWalkGraph(SYNTHETIC_ROADS);
const syntheticMain = findLargestComponent(syntheticGraph);
const syntheticNodeIndex = buildNodeIndex(syntheticGraph, 0.005, syntheticMain);
const syntheticCoverage = graphBounds(syntheticGraph);
const syntheticContext = {
  graph: syntheticGraph,
  nodeIndex: syntheticNodeIndex,
  coverage: syntheticCoverage,
};
const syntheticRoadIndex = createPlaceIndex(SYNTHETIC_ROADS);

check('合成：图有 2 个连通分量（主分量 8 节点、小分量 2 节点）', syntheticMain.size === 8 && syntheticGraph.nodeCount === 10, `主分量 ${syntheticMain.size} / 总节点 ${syntheticGraph.nodeCount}`);
check('合成：覆盖包围盒为外圈范围', syntheticCoverage.minLat === 23.11 && syntheticCoverage.maxLat === 23.15 && syntheticCoverage.minLng === 113.28 && syntheticCoverage.maxLng === 113.32, JSON.stringify(syntheticCoverage));

const syntheticGuangzhou = resolvePlace('广州', { roadIndex: syntheticRoadIndex, placeContext: syntheticContext });
expectCoverageCenter('合成「广州」', syntheticGuangzhou, syntheticContext, { label: placeConfig.activeCity.coverage.centerLabel });
check(
  '合成「广州」：不落在不连通小分量节点上（只索引主分量）',
  syntheticGuangzhou && !(syntheticGuangzhou.lat === 23.13 && syntheticGuangzhou.lng === 113.3),
  syntheticGuangzhou ? `${syntheticGuangzhou.lat},${syntheticGuangzhou.lng}` : 'null',
);
const syntheticGuangzhouCity = resolvePlace('广州市', { roadIndex: syntheticRoadIndex, placeContext: syntheticContext });
check(
  '合成「广州市」：同样落覆盖中心',
  syntheticGuangzhouCity && syntheticGuangzhouCity.source === 'coverage-center' && syntheticGuangzhouCity.lat === syntheticGuangzhou.lat,
  syntheticGuangzhouCity ? `${syntheticGuangzhouCity.source}` : 'null',
);

// 合成普通道路名仍可精确解析（行政区逻辑只在市名/区名精确命中时介入）
const syntheticRoad = resolvePlace('广州大道合成段', { roadIndex: syntheticRoadIndex, placeContext: syntheticContext });
check('合成：普通道路名精确解析不受影响（source=road）', syntheticRoad && syntheticRoad.source === 'road', syntheticRoad ? syntheticRoad.source : 'null');

// 空包围盒：空路网（图无节点）
const emptyGraph = buildWalkGraph([]);
const emptyNodeIndex = buildNodeIndex(emptyGraph, 0.005, findLargestComponent(emptyGraph));
const emptyContext = { graph: emptyGraph, nodeIndex: emptyNodeIndex, coverage: graphBounds(emptyGraph) };
check('合成：空路网 graph 无节点且包围盒为 null', emptyGraph.nodeCount === 0 && emptyContext.coverage === null);
check('合成：空图「广州」返回 null（未解析）', resolvePlace('广州', { roadIndex: syntheticRoadIndex, placeContext: emptyContext }) === null);
check('合成：空图「广州市」返回 null', resolvePlace('广州市', { roadIndex: syntheticRoadIndex, placeContext: emptyContext }) === null);

// 包围盒为空：只剩不可步行道路（motorway），且名字里带「广州」——不得回退道路包含匹配
const motorwayGraph = buildWalkGraph([
  { id: 9, h: 'motorway', n: '广州大道', r: [201, 202], c: [[113.3, 23.13], [113.31, 23.13]] },
]);
const motorwayContext = {
  graph: motorwayGraph,
  nodeIndex: buildNodeIndex(motorwayGraph, 0.005, findLargestComponent(motorwayGraph)),
  coverage: graphBounds(motorwayGraph),
};
check('合成：不可步行道路不建图（包围盒为空）', motorwayGraph.nodeCount === 0 && motorwayContext.coverage === null);
check(
  '合成：空包围盒「广州」返回 null，不回退「广州大道」（道路包含匹配）',
  resolvePlace('广州', { roadIndex: createPlaceIndex([{ n: '广州大道', c: [[113.3, 23.13]] }]), placeContext: motorwayContext }) === null,
);

// 空 nodeIndex：图非空但只索引空集合，nearestNode 返回空 id
const noNodeIndex = buildNodeIndex(syntheticGraph, 0.005, new Set());
const noNodeContext = { graph: syntheticGraph, nodeIndex: noNodeIndex, coverage: syntheticCoverage };
const noNodeNearest = nearestNode(noNodeIndex, syntheticGraph, 113.3, 23.13);
check('合成：空 nodeIndex 时 nearestNode 返回空 id', noNodeNearest.id === null, `id=${noNodeNearest.id}`);
check('合成：道路索引含「广州大道合成段」（若回退包含匹配必然命中）', syntheticRoadIndex.has('广州大道合成段'));
check(
  '合成：nearestNode 空 id 时「广州」返回 null，不回退道路包含匹配',
  resolvePlace('广州', { roadIndex: syntheticRoadIndex, placeContext: noNodeContext }) === null,
);

// ---------- 二、真实路网数据 ----------
const DATA_URL = new URL('../mapdata/guangzhou-roads.json', import.meta.url);
const realRoads = JSON.parse(readRequiredText(DATA_URL, GUANGZHOU_ROADS_HINT)).roads;
const realGraph = buildWalkGraph(realRoads);
const realMain = findLargestComponent(realGraph);
const realNodeIndex = buildNodeIndex(realGraph, 0.005, realMain);
const realCoverage = graphBounds(realGraph);
const realContext = { graph: realGraph, nodeIndex: realNodeIndex, coverage: realCoverage };
const realRoadIndex = createPlaceIndex(realRoads);
const realOptions = { roadIndex: realRoadIndex, placeContext: realContext };

check('真实：主连通分量节点数 > 10000', realMain.size > 10000, `实际 ${realMain.size}`);
check('真实：覆盖包围盒非空', realCoverage !== null);

// 市名 → 覆盖中心
const realGuangzhou = resolvePlace('广州', realOptions);
expectCoverageCenter('真实「广州」', realGuangzhou, realContext, { label: placeConfig.activeCity.coverage.centerLabel });
const realGuangzhouCity = resolvePlace('广州市', realOptions);
check(
  '真实「广州市」：与「广州」同一覆盖中心',
  realGuangzhouCity && realGuangzhouCity.source === 'coverage-center' && realGuangzhouCity.lat === realGuangzhou.lat && realGuangzhouCity.lng === realGuangzhou.lng,
  realGuangzhouCity ? `${realGuangzhouCity.source}` : 'null',
);

// POI 精确 / 别名 / 包含：行为保持
const POI_CASES = [
  ['广州塔', '广州塔'],
  ['小蛮腰', '广州塔'],
  ['广州塔附近', '广州塔'],
  ['珠江', '珠江新城'],
  ['越秀', '越秀公园'],
  ['白云', '白云山'],
  ['花城', '花城广场'],
  ['沙面', '沙面岛'],
];
for (const [query, expectedLabel] of POI_CASES) {
  const place = resolvePlace(query, realOptions);
  check(
    `真实 POI 保持原行为：「${query}」→ ${expectedLabel}（source=poi）`,
    place && place.source === 'poi' && place.label === expectedLabel,
    place ? `实际 ${place.source}/${place.label}` : 'null',
  );
}

// 「天河」不带「区」不进行政区表，不得落覆盖中心
const realTianhe = resolvePlace('天河', realOptions);
check('真实「天河」：不是 coverage-center（继续保持道路解析）', realTianhe && realTianhe.source !== 'coverage-center', realTianhe ? `实际 ${realTianhe.source}` : 'null');

// 「白云区」落覆盖中心；「白云」仍是白云山
const realBaiyunDistrict = resolvePlace('白云区', realOptions);
check('真实「白云区」：source=coverage-center', realBaiyunDistrict && realBaiyunDistrict.source === 'coverage-center', realBaiyunDistrict ? realBaiyunDistrict.source : 'null');
const realBaiyunPoi = resolvePlace('白云', realOptions);
check(
  '真实「白云」：仍是 POI 白云山（与「白云区」结果不同）',
  realBaiyunPoi && realBaiyunPoi.source === 'poi' && realBaiyunPoi.label === '白云山',
  realBaiyunPoi ? `${realBaiyunPoi.source}/${realBaiyunPoi.label}` : 'null',
);
check(
  '真实「白云区」：不声称整个区已定位（坐标≠代表点，落覆盖中心）',
  realBaiyunDistrict && !(realBaiyunDistrict.lat === DISTRICT_POINTS.白云区.lat && realBaiyunDistrict.lng === DISTRICT_POINTS.白云区.lng),
);

// 覆盖内 5 区：先断言代表点在覆盖内，再断言落覆盖中心
for (const name of DISTRICTS_INSIDE) {
  const point = DISTRICT_POINTS[name];
  check(`真实「${name}」：代表点满足 pointInBounds(coverage, 点, 0.01)`, pointInBounds(realCoverage, point, MARGIN_DEG), JSON.stringify(point));
  const place = resolvePlace(name, realOptions);
  check(
    `真实「${name}」：落覆盖中心（source=coverage-center，label=${name}）`,
    place && place.source === 'coverage-center' && place.label === name,
    place ? `${place.source}/${place.label}` : 'null',
  );
  check(
    `真实「${name}」：坐标与该覆盖中心一致（不是该区代表点）`,
    place && place.lat === realGuangzhou.lat && place.lng === realGuangzhou.lng,
    place ? `${place.lat},${place.lng}` : 'null',
  );
}

// 覆盖外 6 区：保留代表点，绝不返回 null，等价引擎 outside-coverage 预检
for (const name of DISTRICTS_OUTSIDE) {
  const point = DISTRICT_POINTS[name];
  check(`真实「${name}」：代表点不满足 pointInBounds（等价 outside-coverage 预检）`, !pointInBounds(realCoverage, point, MARGIN_DEG), JSON.stringify(point));
  const place = resolvePlace(name, realOptions);
  check(
    `真实「${name}」：返回非 null + source=district + 坐标等于代表点`,
    place && place.source === 'district' && place.label === name && place.lat === point.lat && place.lng === point.lng,
    place ? `${place.source}/${place.lat},${place.lng}` : 'null',
  );
  check(
    `真实「${name}」：解析坐标仍在覆盖外（交给规划返回 outside-coverage）`,
    place && !pointInBounds(realCoverage, place, MARGIN_DEG),
    place ? `${place.lat},${place.lng}` : 'null',
  );
}

// 省略「区」的行政区名与全名同义；已有 POI/道路歧义的「越秀」「白云」「天河」保持原行为
for (const name of [...DISTRICTS_INSIDE, ...DISTRICTS_OUTSIDE]) {
  const bareName = name.slice(0, -1);
  if (['越秀', '白云', '天河'].includes(bareName)) {
    continue;
  }
  const fullPlace = resolvePlace(name, realOptions);
  const barePlace = resolvePlace(bareName, realOptions);
  check(
    `真实省略区名「${bareName}」：与「${name}」同一来源和坐标`,
    barePlace &&
      fullPlace &&
      barePlace.source === fullPlace.source &&
      barePlace.label === name &&
      barePlace.lat === fullPlace.lat &&
      barePlace.lng === fullPlace.lng,
    barePlace ? `${barePlace.source}/${barePlace.label}/${barePlace.lat},${barePlace.lng}` : 'null',
  );
}

// 覆盖内区名 + 空 nodeIndex：覆盖中心算不出来时必须未解析，不得回退区代表点
//（否则用户会以为系统按该区做了定位；评审 P2 反例）
const realNoNodeIndex = buildNodeIndex(realGraph, 0.005, new Set());
const realNoNodeContext = { graph: realGraph, nodeIndex: realNoNodeIndex, coverage: realCoverage };
check(
  '真实「越秀区」+ 空 nodeIndex：返回 null（不回退区代表点）',
  resolvePlace('越秀区', { roadIndex: realRoadIndex, placeContext: realNoNodeContext }) === null,
);
{
  const realPanyuNoNode = resolvePlace('番禺区', { roadIndex: realRoadIndex, placeContext: realNoNodeContext });
  check(
    '真实「番禺区」+ 空 nodeIndex：仍保留代表点（覆盖外不受影响）',
    realPanyuNoNode &&
      realPanyuNoNode.source === 'district' &&
      realPanyuNoNode.lat === DISTRICT_POINTS.番禺区.lat &&
      realPanyuNoNode.lng === DISTRICT_POINTS.番禺区.lng,
    realPanyuNoNode ? `${realPanyuNoNode.source}/${realPanyuNoNode.lat},${realPanyuNoNode.lng}` : 'null',
  );
}
// coverage 缺失（空图/覆盖数据加载失败）：无法判断覆盖内外，返回未解析，
// 不把"未知"当成"已证明覆盖外"、也不冒充覆盖中心
const missingCoverageContext = { graph: emptyGraph, nodeIndex: emptyNodeIndex, coverage: null };
check(
  'coverage 缺失时「越秀区」返回 null（不冒充覆盖外/覆盖中心）',
  resolvePlace('越秀区', { roadIndex: realRoadIndex, placeContext: missingCoverageContext }) === null,
);
check(
  'coverage 缺失时「广州」返回 null（不冒充覆盖中心）',
  resolvePlace('广州', { roadIndex: realRoadIndex, placeContext: missingCoverageContext }) === null,
);

// ---------- 三、没有 placeContext 时：市名/区名逻辑不参与（不猜地标/道路） ----------
const legacyOptions = { roadIndex: realRoadIndex };
const legacyGuangzhou = resolvePlace('广州', legacyOptions);
check(
  '无上下文「广州」：未解析（不落覆盖中心，也不被子串命中到 POI/道路）',
  legacyGuangzhou === null,
  legacyGuangzhou ? `${legacyGuangzhou.source}/${legacyGuangzhou.label}` : 'null',
);
check('无上下文「广州市」：返回 null', resolvePlace('广州市', legacyOptions) === null);
check('无上下文「天河区」：不进行政区表（返回 null）', resolvePlace('天河区', legacyOptions) === null);
check('无上下文「白云区」：不进行政区表（返回 null）', resolvePlace('白云区', legacyOptions) === null);

// ---------- 汇总 ----------
console.log('');
console.log(`[summary] 通过 ${passed} / 失败 ${failed} / 共 ${passed + failed}`);
console.log(failed === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${failed} checks)`);
process.exitCode = failed === 0 ? 0 : 1;
