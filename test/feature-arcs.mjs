/**
 * 部位弧偏差测试（Node 直接运行，不依赖浏览器/网络/模型）。
 *
 * 覆盖两件事：
 * 1. normalizeCustomShape 的 features 已保留部分内索引 indices 与 partIndex（纯增量，
 *    轮廓点/约束点/特征 points 不变）；
 * 2. feature-arcs 纯函数：最短弧规则（多点/并列/跨索引 0/单点首末/多部分不串弧）、
 *    空路线与缺失 outline 的安全降级、固定样本定点回放的弧偏差、metrics 不被污染。
 *
 * 固定样本与候选见 test/fixtures/fixed-samples.mjs（样本 A 带 3 条声明特征，
 * 样本 B 为历史马轮廓、只验证检测凹口）；定点回放用固定候选，避免机器负载改变搜索轨迹。
 *
 * 运行：node test/feature-arcs.mjs
 */

import { GUANGZHOU_ROADS_HINT, readRequiredText } from './lib/require-data.mjs';
import { normalizeCustomShape } from '../web/src/agent/intent.js';
import { buildEdgeIndex, buildWalkGraph, findLargestComponent } from '../web/src/engine/graph.js';
import { planShapeRoute } from '../web/src/engine/planner.js';
import { scoreRoute } from '../web/src/engine/quality.js';
import { pointToPolylineMeters } from '../web/src/engine/fidelity.js';
import { computeFeatureArc, measureFeatureArcs } from '../web/src/engine/feature-arcs.js';
import {
  SAMPLE_A_CANDIDATE,
  SAMPLE_A_RAW,
  SAMPLE_B_CANDIDATE,
  SAMPLE_B_RAW,
} from './fixtures/fixed-samples.mjs';

/** 纬度基准（合成图形投影用） */
const LAT0 = 23.12;
/** 经度基准（合成图形投影用） */
const LNG0 = 113.32;

let checks = 0;
let failures = 0;

/**
 * 断言工具：逐条打印 [check] 并记录失败数（失败必须在退出码体现）。
 *
 * @param {string} label 断言描述
 * @param {boolean} condition 断言条件
 * @param {string} [detail] 失败详情
 */
function check(label, condition, detail = '') {
  checks += 1;
  const ok = Boolean(condition);
  if (!ok) {
    failures += 1;
  }
  console.log(`[check] ${label} -> ${ok ? 'PASS' : `FAIL ${detail}`}`);
}

/**
 * 两个索引数组是否逐项相等。
 *
 * @param {unknown} actual 实际数组
 * @param {number[]} expected 期望数组
 * @returns {boolean} 是否相等
 */
function sameArray(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

/**
 * metrics 里是否出现部位弧偏差字段。
 *
 * 只认 featureArcs / 以 arc 开头的键；不能简单写成 /arc/i——metrics 里的
 * searchStats 含 "arc" 子串会误报。
 *
 * @param {object} metrics 评分指标
 * @returns {boolean} 是否含弧偏差字段
 */
function hasArcMetricKey(metrics) {
  return Object.keys(metrics || {}).some((key) => key === 'featureArcs' || /^arc/i.test(key));
}

// ---------- 1. computeFeatureArc：最短弧规则 ----------
{
  // 多点：n=8、锚点 [1,3]；最大空隙 3→1（6 步）被去掉，弧 = [1,2,3]
  const arc = computeFeatureArc({ indices: [1, 3] }, 8);
  check(
    '多点：n=8 [1,3] 取最短弧 [1,2,3]',
    arc !== null &&
      sameArray(arc.arcLocalIndices, [1, 2, 3]) &&
      arc.arcStartIndex === 1 &&
      arc.arcEndIndex === 3 &&
      arc.arcPointCount === 3,
    JSON.stringify(arc),
  );

  // 三锚点：n=24、[2,5,7]；最大空隙 7→2（19 步），弧 = 2..7 含全部中间点
  const three = computeFeatureArc({ indices: [2, 5, 7] }, 24);
  check(
    '多点：n=24 [2,5,7] 去掉最大空隙 7→2 后弧 = 2..7',
    three !== null &&
      three.arcStartIndex === 2 &&
      three.arcEndIndex === 7 &&
      sameArray(three.arcLocalIndices, [2, 3, 4, 5, 6, 7]),
    JSON.stringify(three),
  );

  // 乱序/重复/取模：n=8、[3,1,9,3] 规范后只剩 {1,3}，结果与 [1,3] 一致
  const messy = computeFeatureArc({ indices: [3, 1, 9, 3] }, 8);
  check(
    '索引去重/乱序/取模：n=8 [3,1,9,3] 等价 [1,3]',
    messy !== null && sameArray(messy.arcLocalIndices, [1, 2, 3]),
    JSON.stringify(messy),
  );
}

{
  // 并列：n=10、[0,5] 两段空隙等长（5/5）；取补集弧起点索引较小者 → [0..5]
  const tie = computeFeatureArc({ indices: [0, 5] }, 10);
  check(
    '并列：n=10 [0,5] 取弧起点较小者 [0,1,2,3,4,5]',
    tie !== null && tie.arcStartIndex === 0 && tie.arcEndIndex === 5 && tie.arcPointCount === 6 && sameArray(tie.arcLocalIndices, [0, 1, 2, 3, 4, 5]),
    JSON.stringify(tie),
  );

  // 并列但不含 0：n=10、[1,6] 并列 → 弧起点取 1 而非 6
  const tie2 = computeFeatureArc({ indices: [1, 6] }, 10);
  check(
    '并列：n=10 [1,6] 取弧起点 1（较小）',
    tie2 !== null && tie2.arcStartIndex === 1 && tie2.arcEndIndex === 6 && tie2.arcPointCount === 6,
    JSON.stringify(tie2),
  );

  // 三锚点等长空隙：n=12、[0,4,8] 三段空隙都 4；弧起点取 0 → 0..8
  const tie3 = computeFeatureArc({ indices: [0, 4, 8] }, 12);
  check(
    '并列：n=12 [0,4,8] 三段空隙等长时弧起点 0',
    tie3 !== null && tie3.arcStartIndex === 0 && tie3.arcEndIndex === 8 && tie3.arcPointCount === 9,
    JSON.stringify(tie3),
  );
}

{
  // 跨索引 0：n=8、[6,1]；最大空隙 1→6（5 步），弧 = 6,7,0,1
  const wrap = computeFeatureArc({ indices: [6, 1] }, 8);
  check(
    '跨索引 0：n=8 [6,1] 的弧 = [6,7,0,1]',
    wrap !== null && sameArray(wrap.arcLocalIndices, [6, 7, 0, 1]) && wrap.arcStartIndex === 6 && wrap.arcEndIndex === 1 && wrap.arcPointCount === 4,
    JSON.stringify(wrap),
  );
  check('跨索引 0：弧内含索引 0', wrap !== null && wrap.arcLocalIndices.includes(0));
}

{
  // 单点在首位：n=6、[0] → 前一顶点 5 → 0 → 后一顶点 1（跨索引 0）
  const first = computeFeatureArc({ indices: [0] }, 6);
  check(
    '单点在首位：n=6 [0] → [5,0,1]',
    first !== null && sameArray(first.arcLocalIndices, [5, 0, 1]) && first.arcStartIndex === 5 && first.arcEndIndex === 1 && first.arcPointCount === 3,
    JSON.stringify(first),
  );
  // 单点在末位：n=6、[5] → [4,5,0]
  const last = computeFeatureArc({ indices: [5] }, 6);
  check(
    '单点在末位：n=6 [5] → [4,5,0]',
    last !== null && sameArray(last.arcLocalIndices, [4, 5, 0]) && last.arcStartIndex === 4 && last.arcEndIndex === 0,
    JSON.stringify(last),
  );
  // 单点在末位且 n=3：n=3、[2] → [1,2,0]
  const last3 = computeFeatureArc({ indices: [2] }, 3);
  check(
    '单点在末位：n=3 [2] → [1,2,0]',
    last3 !== null && sameArray(last3.arcLocalIndices, [1, 2, 0]),
    JSON.stringify(last3),
  );
}

{
  // 退化点数：n<3 按可用点处理；n<=0/非法直接 null
  const n2 = computeFeatureArc({ indices: [1] }, 2);
  check('退化：n=2 [1] 取全部可用点 [1,0]', n2 !== null && sameArray(n2.arcLocalIndices, [1, 0]), JSON.stringify(n2));
  const n1 = computeFeatureArc({ indices: [0] }, 1);
  check('退化：n=1 [0] 取 [0]', n1 !== null && sameArray(n1.arcLocalIndices, [0]), JSON.stringify(n1));
  check('非法：n=0 返回 null', computeFeatureArc({ indices: [0] }, 0) === null);
  check('非法：n=NaN 返回 null', computeFeatureArc({ indices: [0] }, Number.NaN) === null);
  check('非法：空 indices 返回 null', computeFeatureArc({ indices: [] }, 8) === null);
  check('非法：indices 缺失返回 null', computeFeatureArc({}, 8) === null);
  check('非法：无有限索引返回 null', computeFeatureArc({ indices: ['x', null] }, 8) === null);
  check('非法：feature 为 null 返回 null', computeFeatureArc(null, 8) === null);
}

{
  // outlineStart：返回的 arcStartIndex/arcEndIndex 是绝对索引，arcLocalIndices 仍是部分内索引
  const local = computeFeatureArc({ indices: [1, 3], outlineStart: 100 }, 8);
  check(
    '绝对索引：outlineStart=100 时弧端点为 101/103、局部序列仍 [1,2,3]',
    local !== null && local.arcStartIndex === 101 && local.arcEndIndex === 103 && sameArray(local.arcLocalIndices, [1, 2, 3]),
    JSON.stringify(local),
  );
}

// ---------- 2. measureFeatureArcs：多部分、降级与只读约束 ----------
{
  // 多部分图形：两个独立圆环，各自带一条声明特征，验证按 partIndex 独立取弧、不串部分
  const circle = [];
  for (let i = 0; i < 12; i += 1) {
    const angle = (i / 12) * Math.PI * 2;
    circle.push([Math.cos(angle) * 0.25, Math.sin(angle) * 0.25]);
  }
  const shape = normalizeCustomShape({
    name: '双环',
    parts: [
      {
        name: '左',
        points: circle.map(([x, y]) => [x * 0.5 - 0.3, y * 0.5]),
        features: [{ name: '左耳', points: [[-0.33, 0.06]] }],
      },
      {
        name: '右',
        points: circle.map(([x, y]) => [x * 0.5 + 0.3, y * 0.5]),
        features: [{ name: '右耳', points: [[0.33, 0.06]] }],
      },
    ],
  });
  check('多部分：归一化成功且有两部分', shape !== null && shape.parts.length === 2);
  if (shape) {
    check(
      '多部分：每部分各有一条特征且 partIndex 独立',
      shape.features.length === 2 &&
        shape.features[0].partIndex === 0 &&
        shape.features[1].partIndex === 1 &&
        shape.features.every((feature) => Array.isArray(feature.indices) && feature.indices.length > 0),
      JSON.stringify(shape.features.map((feature) => ({ partIndex: feature.partIndex, name: feature.name }))),
    );
    // 合成投影轮廓：归一化坐标 → 经纬度（足够让点到路线距离为有限值）
    const outlineLatLngs = shape.outlinePoints.map(([x, y]) => [LAT0 + y * 0.001, LNG0 + x * 0.001]);
    const result = {
      shapeName: shape.name,
      sizeMeters: 800,
      rotationDeg: 0,
      center: { lat: LAT0, lng: LNG0 },
      outlineLatLngs,
      routeLatLngs: [
        [LAT0, LNG0],
        [LAT0 + 0.0005, LNG0 + 0.0005],
      ],
      metrics: { marker: 1 },
    };
    const metricsBefore = JSON.stringify(result.metrics);
    const shapeBefore = JSON.stringify(shape);
    const measured = measureFeatureArcs({ customShape: shape, result, score: 66 });
    check(
      '多部分：两个特征各有弧偏差（finite）',
      measured.features.length === 2 &&
        measured.features.every((entry) => Number.isFinite(entry.maxOffsetMeters)),
      JSON.stringify(measured.features.map((entry) => entry.maxOffsetMeters)),
    );
    for (let i = 0; i < measured.features.length; i += 1) {
      const entry = measured.features[i];
      const part = shape.parts[entry.partIndex];
      check(
        `多部分：第 ${i} 条弧只在所属部分范围 [${part.outlineStart}, ${part.outlineStart + part.outlineCount - 1}] 内`,
        entry.arcStartIndex >= part.outlineStart &&
          entry.arcStartIndex < part.outlineStart + part.outlineCount &&
          entry.arcEndIndex >= part.outlineStart &&
          entry.arcEndIndex < part.outlineStart + part.outlineCount &&
          entry.arcPointCount >= 1 &&
          entry.arcPointCount <= part.outlineCount,
        JSON.stringify({ part, entry }),
      );
      check(
        `多部分：第 ${i} 条 anchorIndices 为绝对索引`,
        sameArray(
          entry.anchorIndices,
          shape.features[i].indices.map((index) => part.outlineStart + index),
        ),
      );
    }
    check(
      '多部分：两部分弧互不串（第 0 条不进第 1 部分、第 1 条不进第 0 部分）',
      measured.features[0].arcStartIndex < shape.parts[1].outlineStart &&
        measured.features[0].arcEndIndex < shape.parts[1].outlineStart &&
        measured.features[1].arcStartIndex >= shape.parts[1].outlineStart,
      JSON.stringify(measured.features.map((entry) => [entry.arcStartIndex, entry.arcEndIndex])),
    );
    check('只读：metrics 未被写入', JSON.stringify(result.metrics) === metricsBefore);
    check('只读：customShape 未被修改', JSON.stringify(shape) === shapeBefore);
    check(
      '只读：metrics 不含弧偏差字段',
      !hasArcMetricKey(result.metrics),
    );
  }
}

{
  // 单部分合成图形：降级路径与空路线
  const shape = normalizeCustomShape({
    name: '方块',
    points: [
      [-0.4, -0.3],
      [0.4, -0.3],
      [0.4, 0.3],
      [-0.4, 0.3],
    ],
    features: [{ name: '顶角', points: [[0.4, 0.3]] }],
  });
  check('降级：单部分合成图形归一化成功', shape !== null && shape.features.length === 1);
  if (shape) {
    const outlineLatLngs = shape.outlinePoints.map(([x, y]) => [LAT0 + y * 0.001, LNG0 + x * 0.001]);
    const routeLatLngs = [
      [LAT0, LNG0],
      [LAT0, LNG0 + 0.001],
    ];
    const base = {
      shapeName: shape.name,
      sizeMeters: 600,
      rotationDeg: 0,
      center: { lat: LAT0, lng: LNG0 },
      outlineLatLngs,
      routeLatLngs,
    };
    // 空路线：maxOffsetMeters null + reason no-route，其余字段照常
    const noRoute = measureFeatureArcs({ customShape: shape, result: { ...base, routeLatLngs: [] }, score: 50 });
    check(
      '降级：空路线 → maxOffsetMeters null + reason no-route',
      noRoute.features.length === 1 &&
        noRoute.features[0].maxOffsetMeters === null &&
        noRoute.features[0].reason === 'no-route' &&
        Number.isInteger(noRoute.features[0].arcStartIndex) &&
        noRoute.features[0].measurement === 'unordered-point-to-route',
      JSON.stringify(noRoute.features[0]),
    );
    // 缺 outlineLatLngs
    const noOutline = measureFeatureArcs({
      customShape: shape,
      result: { ...base, outlineLatLngs: undefined },
      score: 50,
    });
    check(
      '降级：无 outlineLatLngs → null + reason no-outline',
      noOutline.features.length === 1 &&
        noOutline.features[0].maxOffsetMeters === null &&
        noOutline.features[0].reason === 'no-outline',
      JSON.stringify(noOutline.features[0]),
    );
    // 长度不匹配
    const mismatch = measureFeatureArcs({
      customShape: shape,
      result: { ...base, outlineLatLngs: outlineLatLngs.slice(1) },
      score: 50,
    });
    check(
      '降级：outlineLatLngs 长度不匹配 → null + reason outline-mismatch',
      mismatch.features.length === 1 &&
        mismatch.features[0].maxOffsetMeters === null &&
        mismatch.features[0].reason === 'outline-mismatch',
      JSON.stringify(mismatch.features[0]),
    );
    // 完全没有 result：不抛异常
    let noResult = null;
    try {
      noResult = measureFeatureArcs({ customShape: shape });
    } catch {
      noResult = null;
    }
    check(
      '降级：result 缺失不抛异常 → null + reason',
      noResult !== null &&
        noResult.features.length === 1 &&
        noResult.features[0].maxOffsetMeters === null &&
        typeof noResult.features[0].reason === 'string',
      JSON.stringify(noResult),
    );
    // partIndex 越界 → no-part
    const badPart = measureFeatureArcs({
      customShape: { ...shape, features: shape.features.map((feature) => ({ ...feature, partIndex: 9 })) },
      result: base,
      score: 50,
    });
    check(
      '降级：partIndex 越界 → null + reason no-part',
      badPart.features[0].maxOffsetMeters === null && badPart.features[0].reason === 'no-part',
      JSON.stringify(badPart.features[0]),
    );
    // indices 为空 → no-arc
    const noArc = measureFeatureArcs({
      customShape: { ...shape, features: shape.features.map((feature) => ({ ...feature, indices: [] })) },
      result: base,
      score: 50,
    });
    check(
      '降级：indices 为空 → null + reason no-arc',
      noArc.features[0].maxOffsetMeters === null && noArc.features[0].reason === 'no-arc',
      JSON.stringify(noArc.features[0]),
    );
    // 完全没有输入
    let empty = null;
    try {
      empty = measureFeatureArcs();
    } catch {
      empty = null;
    }
    check(
      '降级：无输入不抛异常且 features 为空',
      empty !== null && Array.isArray(empty.features) && empty.features.length === 0 && empty.score === null,
      JSON.stringify(empty),
    );
  }
}

// ---------- 3. 固定样本：索引保留 + 定点回放弧偏差 ----------
const roads = JSON.parse(
  readRequiredText(new URL('../mapdata/guangzhou-roads.json', import.meta.url), GUANGZHOU_ROADS_HINT),
).roads;
const graph = buildWalkGraph(roads);
const edgeIndex = buildEdgeIndex(graph, 0.005, findLargestComponent(graph));
console.log(`[graph] 节点 ${graph.nodeCount} / 边 ${graph.edgeCount}`);

/**
 * 断言归一化特征的 indices/partIndex 纯增量字段。
 *
 * @param {string} label 样本名
 * @param {object} customShape normalizeCustomShape 输出
 */
function checkFeatureIndexFields(label, customShape) {
  const features = customShape.features || [];
  check(`[${label}] 每条特征都有 indices 且与 points 一一对应`, features.every(
    (feature) =>
      Array.isArray(feature.indices) &&
      feature.indices.length === feature.points.length &&
      new Set(feature.indices).size === feature.indices.length,
  ));
  check(
    `[${label}] 每条特征都有整数 partIndex`,
    features.every((feature) => Number.isInteger(feature.partIndex)),
  );
  check(
    `[${label}] indices 是部分内索引（落在所属部分轮廓范围内）`,
    features.every((feature) => {
      const part = customShape.parts[feature.partIndex];
      return (
        Boolean(part) &&
        feature.indices.every((index) => index >= 0 && index < part.outlineCount)
      );
    }),
  );
}

/**
 * 固定样本：归一化 → 定点回放 → 弧偏差断言。
 *
 * @param {string} label 样本名
 * @param {object} raw 原始 customShape
 * @param {{center: {lat: number, lng: number}, sizeMeters: number, rotationDeg: number}} candidate 固定候选
 * @param {object} expectation { declaredNames?: string[], notchCount: number, totalFeatures: number }
 */
function runSample(label, raw, candidate, expectation) {
  const customShape = normalizeCustomShape(raw);
  check(`[${label}] 归一化成功`, customShape !== null);
  if (!customShape) {
    return;
  }
  const features = customShape.features || [];
  const parts = customShape.parts || [];
  check(
    `[${label}] 特征数=${expectation.totalFeatures}`,
    features.length === expectation.totalFeatures,
    `实际 ${features.length}`,
  );
  check(`[${label}] 单部分 partIndex 恒为 0`, features.every((feature) => feature.partIndex === 0));
  checkFeatureIndexFields(label, customShape);

  if (expectation.declaredNames) {
    const declaredNames = features
      .filter((feature) => feature.kind === 'declared')
      .map((feature) => feature.name);
    check(
      `[${label}] 声明特征名保留（${expectation.declaredNames.join('/')}）`,
      sameArray(declaredNames, expectation.declaredNames),
      JSON.stringify(declaredNames),
    );
  }

  const result = planShapeRoute({
    graph,
    edgeIndex,
    customShape,
    center: candidate.center,
    sizeMeters: candidate.sizeMeters,
    rotationDeg: candidate.rotationDeg,
  });
  check(`[${label}] 定点回放有可绘制路线`, result.routeLatLngs.length > 0, `实际 ${result.routeLatLngs.length} 点`);
  check(
    `[${label}] 投影轮廓点数与归一化轮廓一致`,
    result.outlineLatLngs.length === customShape.outlinePoints.length,
    `实际 ${result.outlineLatLngs.length} vs ${customShape.outlinePoints.length}`,
  );
  const score = scoreRoute(result.metrics);
  const scoreBefore = score;
  const metricsBefore = JSON.stringify(result.metrics);
  console.log(
    `[${label}] 回放: score=${score} 尺寸=${candidate.sizeMeters}m 朝向=${candidate.rotationDeg}° 特征=${features.length}`,
  );

  // 弧偏差测量（不写 metrics、不影响评分）：方案只要求声明特征 + 检测凹口，
  // gap（窄间隙）不写弧日志——这里按同一口径算出期望条目，防越界记录。
  const arcFeatures = features.filter((feature) => feature.kind === 'notch' || feature.kind === 'declared');
  const measured = measureFeatureArcs({ customShape, result, score });
  check(
    `[${label}] measureFeatureArcs 基础字段来自候选`,
    measured.shapeName === result.shapeName &&
      measured.score === score &&
      measured.sizeMeters === candidate.sizeMeters &&
      measured.rotationDeg === candidate.rotationDeg &&
      measured.center?.lat === candidate.center.lat &&
      measured.center?.lng === candidate.center.lng,
    JSON.stringify({ shapeName: measured.shapeName, score: measured.score, sizeMeters: measured.sizeMeters, rotationDeg: measured.rotationDeg, center: measured.center }),
  );
  check(
    `[${label}] 每个声明特征/凹口都产出弧偏差条目（gap 不写入）`,
    measured.features.length === arcFeatures.length,
    `实际 ${measured.features.length}，期望 ${arcFeatures.length}（总特征 ${features.length}）`,
  );
  check(
    `[${label}] 弧日志只含 notch/declared（不含 gap）`,
    measured.features.every((entry) => entry.kind === 'notch' || entry.kind === 'declared') &&
      !measured.features.some((entry) => entry.kind === 'gap'),
    JSON.stringify([...new Set(measured.features.map((entry) => entry.kind))]),
  );
  check(
    `[${label}] 每条都标记 measurement=unordered-point-to-route`,
    measured.features.every((entry) => entry.measurement === 'unordered-point-to-route'),
  );
  check(
    `[${label}] 全部特征 maxOffsetMeters 为有限值`,
    measured.features.every((entry) => Number.isFinite(entry.maxOffsetMeters)),
    JSON.stringify(measured.features.map((entry) => entry.maxOffsetMeters)),
  );
  check(
    `[${label}] 弧字段齐全（arcStartIndex/arcEndIndex/arcPointCount）`,
    measured.features.every(
      (entry) =>
        Number.isInteger(entry.arcStartIndex) &&
        Number.isInteger(entry.arcEndIndex) &&
        Number.isInteger(entry.arcPointCount) &&
        entry.arcPointCount >= 2 &&
        entry.arcPointCount <= parts[entry.partIndex].outlineCount,
    ),
  );
  check(
    `[${label}] anchorIndices 为绝对索引（单部分即部分内索引）`,
    measured.features.every((entry, index) => sameArray(entry.anchorIndices, arcFeatures[index].indices)),
  );

  // 独立复算：按 computeFeatureArc 的弧 + pointToPolylineMeters 重算，验证测量用的是弧上点
  let recomputeOk = true;
  for (let index = 0; index < measured.features.length; index += 1) {
    const entry = measured.features[index];
    const feature = arcFeatures[index];
    const part = parts[entry.partIndex];
    const arc = computeFeatureArc({ ...feature, outlineStart: part.outlineStart }, part.outlineCount);
    let expected = 0;
    for (const localIndex of arc.arcLocalIndices) {
      const [lat, lng] = result.outlineLatLngs[part.outlineStart + localIndex];
      const distance = pointToPolylineMeters(lat, lng, result.routeLatLngs);
      if (distance > expected) {
        expected = distance;
      }
    }
    if (Math.abs(expected - entry.maxOffsetMeters) > 1e-9) {
      recomputeOk = false;
      console.log(`  [recompute] 第 ${index} 条 expected=${expected} actual=${entry.maxOffsetMeters}`);
    }
  }
  check(`[${label}] 弧偏差可用弧上点独立复算（口径一致）`, recomputeOk);

  if (expectation.declaredNames) {
    const declared = measured.features.filter((entry) => entry.kind === 'declared');
    check(
      `[${label}] 3 条声明特征各有弧偏差（finite）`,
      declared.length === 3 &&
        declared.every((entry) => Number.isFinite(entry.maxOffsetMeters) && entry.arcPointCount === 3),
      JSON.stringify(declared.map((entry) => ({ name: entry.name, maxOffsetMeters: entry.maxOffsetMeters, arcPointCount: entry.arcPointCount }))),
    );
  }
  if (expectation.notchCount > 0) {
    const notches = measured.features.filter((entry) => entry.kind === 'notch');
    check(
      `[${label}] ${expectation.notchCount} 条 notch 各有弧偏差（finite）`,
      notches.length === expectation.notchCount &&
        notches.every((entry) => Number.isFinite(entry.maxOffsetMeters)),
      JSON.stringify(notches.map((entry) => entry.maxOffsetMeters)),
    );
  }

  // 只读/不参与评分：metrics 与评分在测量前后不变，且结果里没有弧字段
  check(`[${label}] 测量后 metrics 未被写入`, JSON.stringify(result.metrics) === metricsBefore);
  check(`[${label}] 测量后 scoreRoute 不变`, scoreRoute(result.metrics) === scoreBefore);
  check(
    `[${label}] metrics 中没有 featureArcs/arc 字段`,
    !('featureArcs' in result.metrics) &&
      !('arcMaxOffsetMeters' in result.metrics) &&
      !hasArcMetricKey(result.metrics),
  );
  check(
    `[${label}] 结果对象没有挂弧偏差字段`,
    !('featureArcs' in result) && !('featureArcs' in customShape),
  );
}

runSample('样本A', SAMPLE_A_RAW, SAMPLE_A_CANDIDATE, {
  declaredNames: ['尖耳', '长脸', '翘尾'],
  notchCount: 3,
  totalFeatures: 8,
});
runSample('样本B', SAMPLE_B_RAW, SAMPLE_B_CANDIDATE, {
  notchCount: 2,
  totalFeatures: 4,
});

console.log(`\n[summary] ${checks - failures}/${checks} 项通过，失败 ${failures} 项`);
if (failures > 0) {
  process.exitCode = 1;
}
