/**
 * 智能体意图归一化与地点解析测试（Node 直接运行，不依赖浏览器与网络）。
 *
 * 覆盖：
 * - normalizeIntent：合法全字段 / 缺省推断 / recommend（只给条件）双向兜底 / 非法 shape / 越界值钳制（时间维度已移除）
 * - resolvePlace：POI 精确 / 别名 / 包含 / 路网道路名 / 未知地点
 * - 解析出的中心点接入真实引擎规划不报错（复用路网数据）
 *
 * 运行：node test/agent-intent.mjs
 */

import { GUANGZHOU_ROADS_HINT, readRequiredText } from './lib/require-data.mjs';
import {
  DEFAULT_SIZE_METERS,
  MAX_SIZE_METERS,
  MIN_SIZE_METERS,
  extractExplicitSizeMeters,
  normalizeCustomShape,
  normalizeIntent,
} from '../web/src/agent/intent.js';
import { createPlaceIndex, resolvePlace as resolvePlaceRaw } from '../web/src/agent/places.js';
import { buildEdgeIndex, buildWalkGraph, findLargestComponent, buildNodeIndex } from '../web/src/engine/graph.js';
import { planShapeRoute } from '../web/src/engine/planner.js';
import { meetsQualityBar, scoreRoute } from '../web/src/engine/candidates.js';
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

let failures = 0;

/** 断言工具：记录并通过/失败计数 */
function check(label, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) {
    failures += 1;
  }
  console.log(`[check] ${label} -> ${ok ? 'PASS' : `FAIL ${detail}`}`);
}

// ---------- normalizeIntent（时间维度已移除：minutes 一律忽略） ----------
const full = normalizeIntent({
  action: 'plan',
  shape: 'star',
  place: '广州塔',
  minutes: 60,
  sizeMeters: 1500,
  rotationDeg: 47,
  reply: '好的',
});
check('全字段：action=plan', full.action === 'plan');
check('全字段：shapeKey=star', full.shapeKey === 'star');
check('全字段：place=广州塔', full.place === '广州塔');
check(
  '全字段：LLM sizeMeters=1500 被忽略，尺寸兜底基准 1200m',
  full.sizeMeters === DEFAULT_SIZE_METERS,
  `实际 ${full.sizeMeters}`,
);
check('全字段：minutes 被忽略并记入 notes', full.minutes === undefined && full.notes.some((n) => n.includes('minutes 已忽略')));
check('全字段：rotationDeg 取整到 15 的倍数', full.rotationDeg === 45, `实际 ${full.rotationDeg}`);
check('全字段：rotationExplicit=true（用户明确给了朝向）', full.rotationExplicit === true);
// 未给朝向时 rotationDeg 是默认 0，但 rotationExplicit 必须为 false——
// 否则自动搜索会被锁死在 0°（人形请求只搜一个朝向的 bug）
const noRotation = normalizeIntent({ action: 'plan', shape: 'heart' });
check(
  '未给朝向：rotationDeg 默认 0 且 rotationExplicit=false',
  noRotation.rotationDeg === 0 && noRotation.rotationExplicit === false,
  `rotationDeg=${noRotation.rotationDeg}, rotationExplicit=${noRotation.rotationExplicit}`,
);
// LLM 按提示返回 "rotationDeg": null（字段存在、值为 null）——必须与"未给朝向"
// 同等对待。曾因 Number(null)===0 被当成"显式指定 0°"，多朝向阶梯搜索被锁死
//（评审 bonus 发现：2026-10-26 起所有真实轮次 plan.begin 的 rotations 都是 [0]）。
const nullRotation = normalizeIntent({ action: 'plan', shape: 'heart', rotationDeg: null });
check(
  'LLM 返回 rotationDeg:null：与未指定同等（rotationExplicit=false，多朝向搜索不被锁死）',
  nullRotation.rotationDeg === 0 && nullRotation.rotationExplicit === false,
  `rotationDeg=${nullRotation.rotationDeg}, rotationExplicit=${nullRotation.rotationExplicit}`,
);
// 规格朝向并入意图级（🔴2 修复后唯一的旋转施加点）：意图级未指定时采纳规格朝向
const specRotation = normalizeIntent({
  action: 'plan',
  shapeSpec: { family: 'star', pointCount: 6, outerRadii: 0.5, innerRadii: 0.28, rotationDeg: 90 },
  rotationDeg: null,
});
check(
  '规格朝向并入意图级：rotationDeg=90 且 explicit=true',
  specRotation.rotationDeg === 90 && specRotation.rotationExplicit === true,
  `rotationDeg=${specRotation.rotationDeg}, explicit=${specRotation.rotationExplicit}`,
);
// 意图级朝向优先于规格朝向
const bothRotation = normalizeIntent({
  action: 'plan',
  shapeSpec: { family: 'star', pointCount: 6, outerRadii: 0.5, innerRadii: 0.28, rotationDeg: 90 },
  rotationDeg: 45,
});
check('意图级朝向优先于规格朝向', bothRotation.rotationDeg === 45 && !bothRotation.notes.some((n) => n.includes('规格朝向')));

// 评审 🟠4：shapeSpec.userConstraints 合并进意图级（否则到不了验收闸门，否决权空转）
const specConstraints = normalizeIntent({
  action: 'plan',
  shapeSpec: {
    family: 'star', pointCount: 6, outerRadii: 0.5, innerRadii: 0.28,
    userConstraints: [{ text: '三长三短', source: 'user-text' }, { text: '必须有六个尖', source: 'user-text' }],
  },
  userConstraints: ['三长三短', '尖朝上'],
});
check(
  '规格内约束合并进意图级（去重、保持顶层约束）',
  specConstraints.userConstraints.length === 3
    && specConstraints.userConstraints.includes('三长三短')
    && specConstraints.userConstraints.includes('尖朝上')
    && specConstraints.userConstraints.includes('必须有六个尖'),
  JSON.stringify(specConstraints.userConstraints),
);

// extractExplicitSizeMeters：只认带图形语境的尺寸表述
check('显式尺寸：「画个1公里的星星」→ 1000m', extractExplicitSizeMeters('画个1公里的星星') === 1000);
check('显式尺寸：「尺寸800米」→ 800m', extractExplicitSizeMeters('在珠江新城画矩形，尺寸800米') === 800);
check('显式尺寸：「走2公里」无图形语境 → null', extractExplicitSizeMeters('我想走2公里') === null);
check('显式尺寸：未提尺寸 → null', extractExplicitSizeMeters('在广州塔附近走个心形') === null);
check(
  '显式尺寸：钳到上限 3000m',
  extractExplicitSizeMeters('画个99公里的矩形') === MAX_SIZE_METERS,
);

const explicitWins = normalizeIntent(
  { action: 'plan', shape: 'star', minutes: 60, sizeMeters: 300 },
  { explicitSizeMeters: 1500 },
);
check('显式尺寸作为搜索基准', explicitWins.sizeMeters === 1500, `实际 ${explicitWins.sizeMeters}`);

const llmSizeIgnored = normalizeIntent({ action: 'plan', shape: 'star', sizeMeters: 300 });
check(
  'LLM 编造 sizeMeters：兜底默认 1200m',
  llmSizeIgnored.sizeMeters === DEFAULT_SIZE_METERS,
  `实际 ${llmSizeIgnored.sizeMeters}`,
);

const empty = normalizeIntent({});
check('空输入：action=chat', empty.action === 'chat');
check('空输入：shapeKey=null', empty.shapeKey === null);
check('空输入：place=null', empty.place === null);

const timeOnly = normalizeIntent({ action: 'plan', place: '珠江新城', minutes: 60 });
check('只有条件：plan 无图形转 recommend', timeOnly.action === 'recommend');
check('只有条件：shapeKey=null（不再兜底 heart）', timeOnly.shapeKey === null);
check('只有条件：sizeMeters=null（尺寸由控制器设定基准）', timeOnly.sizeMeters === null);

const badShape = normalizeIntent({ action: 'plan', shape: 'triangle' });
check('非法 shape：忽略后无图形转 recommend', badShape.action === 'recommend' && badShape.shapeKey === null);
check('非法 shape：notes 记录忽略', badShape.notes.some((n) => n.includes('非法 shape')));

const rec = normalizeIntent({ action: 'recommend', place: '珠江新城', minutes: 60, reply: '我来看看' });
check('recommend：action 保留', rec.action === 'recommend');
check(
  'recommend：shapeKey/customShape/sizeMeters 均为 null',
  rec.shapeKey === null && rec.customShape === null && rec.sizeMeters === null,
);
check('recommend：reply 保留', rec.reply === '我来看看');

const recWithShape = normalizeIntent({ action: 'recommend', shape: 'star', minutes: 60 });
check('recommend 带图形：图形优先转 plan', recWithShape.action === 'plan' && recWithShape.shapeKey === 'star');

const noActionCond = normalizeIntent({ place: '花城广场', minutes: 120 });
check('action 缺省且只有条件：推断为 recommend', noActionCond.action === 'recommend');

const clamped = normalizeIntent({ action: 'plan', shape: 'rect', sizeMeters: 99999, minutes: -3 });
check('越界 LLM sizeMeters 被忽略，兜底默认 1200m', clamped.sizeMeters === DEFAULT_SIZE_METERS);

const noAction = normalizeIntent({ shape: 'heart' });
check('action 缺省推断为 plan', noAction.action === 'plan');

const textReply = normalizeIntent({ action: 'chat', reply: '你好' });
check('chat：保留 reply', textReply.reply === '你好');

// ---------- normalizeCustomShape（LLM 点列校验） ----------
const circlePoints = Array.from({ length: 24 }, (_, i) => {
  const t = (Math.PI * 2 * i) / 24;
  return [Math.cos(t) * 0.45, Math.sin(t) * 0.45];
});
const circle = normalizeCustomShape({ name: '圆形', points: circlePoints });
check('自定义圆形：合法点列通过', circle !== null && circle.name === '圆形');
check('自定义圆形：轮廓点保留 24 个', circle && circle.outlinePoints.length === 24);
check(
  '自定义圆形：约束点在基础密度与硬帽之间（RDP+均匀并集）',
  circle && circle.constraintPoints.length >= 12 && circle.constraintPoints.length <= 28,
  circle ? `实际 ${circle.constraintPoints.length}` : 'null',
);
check('点数过少（2）→ null', normalizeCustomShape({ name: 'x', points: circlePoints.slice(0, 2) }) === null);
// 稀疏多边形：LLM 生成"七边形"偶尔只给 7 个顶点（几何上成立）——加密接受而非拒收
// （旧 8 点下限拒收会让明确的七边形请求静默落入内置推荐，实测教训）
const heptaVertices = Array.from({ length: 7 }, (_, i) => {
  const t = (Math.PI * 2 * i) / 7 - Math.PI / 2;
  return [+(Math.cos(t) * 0.5).toFixed(3), +(Math.sin(t) * 0.5).toFixed(3)];
});
const heptaSparse = normalizeCustomShape({ name: '七边形', points: heptaVertices });
check(
  '稀疏七边形（仅 7 顶点）：加密接受',
  heptaSparse !== null && heptaSparse.outlinePoints.length >= 16,
  heptaSparse ? `轮廓 ${heptaSparse.outlinePoints.length} 点` : 'null',
);
check(
  '稀疏七边形：约束点覆盖全部顶点方向',
  heptaSparse !== null && heptaSparse.constraintPoints.length >= 6,
);
check(
  '坐标越界（0.6）→ null',
  normalizeCustomShape({ name: 'x', points: [...circlePoints.slice(0, 23), [0.6, 0]] }) === null,
);
check(
  '退化图形（一条直线）→ null',
  normalizeCustomShape({ name: 'x', points: Array.from({ length: 10 }, (_, i) => [i * 0.04 - 0.2, 0]) }) === null,
);
check(
  '相邻重复点归并后点数不足 → null',
  normalizeCustomShape({ name: 'x', points: Array.from({ length: 12 }, () => [0.1, 0.1]) }) === null,
);
check('非数组 points → null', normalizeCustomShape({ name: 'x', points: 'abc' }) === null);
check('非对象 → null', normalizeCustomShape('圆形') === null);
check(
  '名称缺失兜底为「自定义图形」',
  normalizeCustomShape({ points: circlePoints }).name === '自定义图形',
);

// customShape 参与意图归一化
const customIntent = normalizeIntent({
  action: 'plan',
  customShape: { name: '圆形', points: circlePoints },
  place: '海珠湖',
});
check('customShape 合法：shapeKey 置 null', customIntent.customShape !== null && customIntent.shapeKey === null);

// ---------- 时间维度已移除：意图里不再有 minutes 字段 ----------
check('意图对象无 minutes 字段', normalizeIntent({ action: 'plan', shape: 'star' }).minutes === undefined);
check('意图对象无 timeUnlimited 字段', normalizeIntent({ action: 'plan', shape: 'star' }).timeUnlimited === undefined);
check('customShape 合法：place 保留', customIntent.place === '海珠湖');
const customFallback = normalizeIntent({ action: 'plan', customShape: { points: [[9, 9]] } });
check(
  'customShape 校验失败：无图形转 recommend',
  customFallback.customShape === null && customFallback.action === 'recommend',
);
const noActionShape = normalizeIntent({ customShape: { name: '圆形', points: circlePoints } });
check('action 缺省且有图形：推断为 plan', noActionShape.action === 'plan');

// 时间→尺寸换算已随时间维度移除：尺寸 = 显式尺寸 || 默认基准（1200m），
// 最终档位由引擎的全尺寸阶梯（0.5~7.5×）搜索按相对均方根现选。

// ---------- resolvePlace ----------
const DATA_URL = new URL('../mapdata/guangzhou-roads.json', import.meta.url);
const roads = JSON.parse(readRequiredText(DATA_URL, GUANGZHOU_ROADS_HINT)).roads;
const roadIndex = createPlaceIndex(roads);
check('道路名索引非空', roadIndex.size > 2000, `实际 ${roadIndex.size}`);

const tower = resolvePlace('广州塔', { roadIndex });
check('POI 精确：广州塔', tower && tower.source === 'poi' && tower.label === '广州塔');
check(
  'POI 精确：坐标接近 (23.1066, 113.3246)',
  tower && Math.abs(tower.lat - 23.1066) < 0.01 && Math.abs(tower.lng - 113.3246) < 0.01,
);

const alias = resolvePlace('小蛮腰', { roadIndex });
check('POI 别名：小蛮腰 → 广州塔', alias && alias.label === '广州塔');

const beijing = resolvePlace('北京路', { roadIndex });
check('POI 包含：北京路 → 北京路步行街', beijing && beijing.label === '北京路步行街');

const huacheng = resolvePlace('花城大道', { roadIndex });
check(
  '道路名：花城大道 → road 源且坐标在裁剪范围内',
  huacheng &&
    huacheng.source === 'road' &&
    huacheng.lat > 23.06 &&
    huacheng.lat < 23.17 &&
    huacheng.lng > 113.22 &&
    huacheng.lng < 113.36,
  huacheng ? `实际 ${huacheng.lat},${huacheng.lng}` : 'null',
);

const unknown = resolvePlace('不存在的地名xyz', { roadIndex });
check('未知地点：返回 null', unknown === null);

const emptyQuery = resolvePlace('', { roadIndex });
check('空地名：返回 null', emptyQuery === null);

// ---------- 解析中心接入真实引擎 ----------
const graph = buildWalkGraph(roads);
const mainComponent = findLargestComponent(graph);
buildNodeIndex(graph, 0.005, mainComponent);
const edgeIndex = buildEdgeIndex(graph, 0.005, mainComponent);
const result = planShapeRoute({
  graph,
  edgeIndex,
  shapeKey: 'heart',
  center: { lat: tower.lat, lng: tower.lng },
  sizeMeters: DEFAULT_SIZE_METERS,
});
// 广州塔定点跨江：吸附超门槛的候选被短路（路线为空）且必须不达标；
// 若吸附达标则应有真实连续路线。两种结果都合法，空路线+达标=矛盾（误判成功）。
check(
  '广州塔心形规划：要么真实路线要么吸附短路且不达标',
  result.metrics.coverage >= 100 &&
    result.metrics.failedLegs === 0 &&
    (result.metrics.routeMeters > 0
      ? true
      : !meetsQualityBar(result.metrics) && scoreRoute(result.metrics) === 0),
  `覆盖 ${result.metrics.coverage} / 失败段 ${result.metrics.failedLegs} / 路线 ${result.metrics.routeMeters}m`,
);
console.log(
  `[plan] 广州塔心形（基准 ${DEFAULT_SIZE_METERS}m）-> 路线 ${(result.metrics.routeMeters / 1000).toFixed(2)} km ` +
    `/ 约 ${Math.round(result.metrics.walkMinutes)} 分钟 / 绕行 ${result.metrics.detourRatio.toFixed(2)}x`,
);

console.log(failures === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${failures} checks)`);

// ---------- 多部分图形（分离区域独立布点，如群岛/大陆+岛屿） ----------
const multiParts = normalizeCustomShape({
  name: '双环',
  parts: [
    { name: '左环', points: circlePoints.map(([x, y]) => [x * 0.4 - 0.26, y * 0.4]) },
    { name: '右环', points: circlePoints.map(([x, y]) => [x * 0.4 + 0.26, y * 0.4]) },
  ],
});
check(
  '多部分图形：合法且扁平拼接',
  multiParts !== null && multiParts.parts.length === 2 && multiParts.outlinePoints.length === 48,
  multiParts ? `轮廓 ${multiParts.outlinePoints.length}` : 'null',
);
check(
  '多部分图形：parts 范围表正确',
  multiParts.parts[0].outlineStart === 0 &&
    multiParts.parts[1].outlineStart === 24 &&
    multiParts.parts[0].constraintCount >= 8 &&
    multiParts.parts[1].constraintCount >= 8,
);
check(
  '多部分图形：整体退化（全部重叠）→ null',
  normalizeCustomShape({
    name: 'x',
    parts: [
      { points: [[0, 0], [0.1, 0], [0.05, 0.08]] },
      { points: [[0.01, 0.01], [0.11, 0.01], [0.06, 0.09]] },
    ],
  }) === null,
);

// ---------- 地点解析（追加）：无 placeContext 不猜城市/行政区，有 placeContext 才启用 ----------
// 解析算法不含地名，统一由地点配置提供候选表。
const legacyCity = resolvePlace('广州', { roadIndex });
check(
  '地点（无 placeContext）：「广州」未解析（不猜地标/道路）',
  legacyCity === null,
  legacyCity ? `${legacyCity.source}/${legacyCity.label}` : 'null',
);
check('地点（无 placeContext）：「广州市」未解析', resolvePlace('广州市', { roadIndex }) === null);

// 用上面已建好的路网图构造只读地点上下文（与引擎 getPlaceContext 返回结构一致）
const { graphBounds, nearestNode } = await import('../web/src/engine/graph.js');
const placeNodeIndex = buildNodeIndex(graph, 0.005, mainComponent);
const placeCoverage = graphBounds(graph);
const placeContext = { graph, nodeIndex: placeNodeIndex, coverage: placeCoverage };
const cityCenter = resolvePlace('广州', { roadIndex, placeContext });
const centerMidLng = (placeCoverage.minLng + placeCoverage.maxLng) / 2;
const centerMidLat = (placeCoverage.minLat + placeCoverage.maxLat) / 2;
const centerNearest = nearestNode(placeNodeIndex, graph, centerMidLng, centerMidLat);
const centerNode = centerNearest.id === null ? null : graph.nodes.get(centerNearest.id);
check(
  '地点（有 placeContext）：「广州」落覆盖中心且坐标=包围盒中点最近节点',
  cityCenter &&
    cityCenter.source === 'coverage-center' &&
    centerNode &&
    cityCenter.lat === centerNode[1] &&
    cityCenter.lng === centerNode[0],
  cityCenter ? `${cityCenter.source}/${cityCenter.lat},${cityCenter.lng}` : 'null',
);
const districtCenter = resolvePlace('天河区', { roadIndex, placeContext });
check(
  '地点（有 placeContext）：「天河区」落覆盖中心',
  districtCenter && districtCenter.source === 'coverage-center' && districtCenter.label === '天河区',
  districtCenter ? `${districtCenter.source}/${districtCenter.label}` : 'null',
);
const outsideDistrict = resolvePlace('增城区', { roadIndex, placeContext });
check(
  '地点（有 placeContext）：覆盖外「增城区」保留代表点，不返回 null',
  outsideDistrict && outsideDistrict.source === 'district' && outsideDistrict.lat === 23.29 && outsideDistrict.lng === 113.83,
  outsideDistrict ? `${outsideDistrict.source}/${outsideDistrict.lat},${outsideDistrict.lng}` : 'null',
);
// 原型属性名（'toString'/'constructor' 等）不得被当成区名命中
check(
  '地点（有 placeContext）：原型属性名不会被当成区名',
  resolvePlace('toString', { roadIndex, placeContext }) === null &&
    resolvePlace('constructor', { roadIndex, placeContext }) === null,
);
console.log(`[place-context] 追加检查完成，累计失败 ${failures}`);

process.exit(failures === 0 ? 0 : 2);
