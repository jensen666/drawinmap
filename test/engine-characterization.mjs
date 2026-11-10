/**
 * 引擎行为特征化基线（清理方案 2026-11-09 阶段 0，T-B1b）。
 *
 * 目的：B 批 engine 去重 / C 批 planner 拆分时，用**固定合成场景**把
 * `planShapeRoute` 的输出特征钉住——改前生成 fixture 入库，改后同输入逐字段
 * `===` 对比；任何非白名单差异都说明行为变了（metrics 是评分与验收契约）。
 *
 * 5 个固定场景（全部程序化合成路网，不读 6.7MB 真实路网，<10s）：
 * 1. straight  —— 直线主路 + 两点线段（最简形状腿 / 闭合回程复用边）
 * 2. triangle  —— 方格网 + 三角三点
 * 3. loop      —— 方格网 + 六点闭环（6 条形状腿）
 * 4. multipart-connector —— 多部分图形（主体闭环 + 岛），走连接腿（connector）
 * 5. snap-shortcircuit  —— 吸附超 120m 硬门槛，命中 planner 短路分支（无寻路）
 *
 * 摘要口径（与方案 §6.3 T-B1b 一致）：
 * `{routeMeters, failedLegs, reusedEdgeCount, legsCount, score, metrics: 10 个关键字段}`，
 * 所有数值 `Math.round(x*10)/10`；非有限值（Infinity 等）编码为字符串，避免
 * JSON.stringify 把 Infinity 变成 null 丢失语义。
 *
 * 用法：
 *   node test/engine-characterization.mjs            # 与 fixture 逐字段对比（CI 用）
 *   node test/engine-characterization.mjs --update   # 在当前 HEAD 代码上重生成 fixture
 *
 * 注意：D3（吸附短路 metrics 键集合缺失）修复后短路场景的 `snapSource` 会由
 * `undefined` 变为 `'nearest'`，必须 `--update` 重生成 fixture（实施记录写清）。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildEdgeIndex, buildWalkGraph, findLargestComponent } from '../web/src/engine/graph.js';
import { planShapeRoute } from '../web/src/engine/planner.js';
import { scoreRoute } from '../web/src/engine/quality.js';
import { diffJson } from '../tools/diff-baseline.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const FIXTURE_PATH = join(ROOT, 'test', 'fixtures', 'engine-characterization.json');

/** 摘要里 metrics 固定取这 10 个关键字段（跨正常分支与吸附短路分支） */
const METRIC_KEYS = [
  'routePointCount',
  'failedLegs',
  'snapMaxMeters',
  'snapAvgMeters',
  'coverage',
  'partCount',
  'keyMaxOffsetRatio',
  'orderedOutlineMeanRatio',
  'orderedRouteMeanRatio',
  'snapSource',
];

/** 场景摘要的顶层字段（顺序即 fixture 里的键顺序） */
const SUMMARY_KEYS = ['routeMeters', 'failedLegs', 'reusedEdgeCount', 'legsCount', 'score', 'metrics'];

let checks = 0;
let failures = 0;

/**
 * 断言工具：记录并通过/失败计数。
 *
 * @param {string} label 断言标签
 * @param {boolean} condition 断言条件
 * @param {string} [detail] 失败详情
 */
function check(label, condition, detail = '') {
  checks += 1;
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`[check] ${label} -> ${ok ? 'PASS' : `FAIL ${detail}`}`);
}

// ---------- 合成路网 / 坐标工具（沿用 test/planner-retrace.mjs 的造图模式） ----------
const M_PER_DEG_LAT = 111320;
const LAT0 = 23.12;
const LNG0 = 113.32;
const M_PER_DEG_LNG = M_PER_DEG_LAT * Math.cos((LAT0 * Math.PI) / 180);
/** 局部米坐标（x 向东、y 向北）→ 经纬度 */
const latOf = (meters) => LAT0 + meters / M_PER_DEG_LAT;
const lngOf = (meters) => LNG0 + meters / M_PER_DEG_LNG;

/**
 * 数值序列（含两端），避免依赖 Array.from 的浮点步进写法。
 *
 * @param {number} min 起点
 * @param {number} max 终点
 * @param {number} step 步长
 * @returns {Array<number>} 序列
 */
function range(min, max, step) {
  const list = [];
  for (let value = min; value <= max + 1e-9; value += step) list.push(value);
  return list;
}

/**
 * 方格路网：节点行列交叉点共享编号，横竖道路组成全连通网格。
 *
 * @param {{min: number, max: number, step: number}} options 范围与间距（米）
 * @returns {{graph: object, edgeIndex: object}} 步行图与边索引
 */
function makeGridGraph({ min, max, step }) {
  const axis = range(min, max, step);
  const size = axis.length;
  const nodeId = (col, row) => row * size + col + 1;
  const roads = [];
  let roadId = 1;
  // 横向道路：每行一条
  for (let row = 0; row < size; row += 1) {
    const y = axis[row];
    roads.push({
      id: roadId,
      h: 'residential',
      n: `横${row}`,
      c: axis.map((x) => [lngOf(x), latOf(y)]),
      r: axis.map((_, col) => nodeId(col, row)),
    });
    roadId += 1;
  }
  // 纵向道路：每列一条（与横向道路共享交叉点节点，graph 自动连通）
  for (let col = 0; col < size; col += 1) {
    const x = axis[col];
    roads.push({
      id: roadId,
      h: 'residential',
      n: `纵${col}`,
      c: axis.map((y) => [lngOf(x), latOf(y)]),
      r: axis.map((_, row) => nodeId(col, row)),
    });
    roadId += 1;
  }
  const graph = buildWalkGraph(roads);
  const mainComponent = findLargestComponent(graph);
  return { graph, edgeIndex: buildEdgeIndex(graph, 0.005, mainComponent) };
}

/**
 * 单条道路路网（直线场景）。
 *
 * @param {Array<[number, number]>} points 米坐标折线
 * @returns {{graph: object, edgeIndex: object}} 步行图与边索引
 */
function makeRoadGraph(points) {
  const graph = buildWalkGraph([
    {
      id: 1,
      h: 'residential',
      n: '合成路',
      c: points.map(([x, y]) => [lngOf(x), latOf(y)]),
      r: points.map((_, index) => index + 1),
    },
  ]);
  const mainComponent = findLargestComponent(graph);
  return { graph, edgeIndex: buildEdgeIndex(graph, 0.005, mainComponent) };
}

/**
 * 场景投影：米坐标 → 图形局部坐标（center / sizeMeters 的逆变换）。
 *
 * @param {{x: number, y: number}} center 米坐标中心
 * @param {number} sizeMeters 图形尺寸（米）
 * @returns {(point: [number, number]) => [number, number]} 投影函数
 */
function projector(center, sizeMeters) {
  return ([x, y]) => [(x - center.x) / sizeMeters, (y - center.y) / sizeMeters];
}

/**
 * 数值摘要：有限值保留 1 位小数（不引入 -0），非有限值转字符串保留语义。
 *
 * @param {number} value 数值
 * @returns {number|string} 摘要值
 */
function round1(value) {
  if (typeof value !== 'number') return String(value);
  if (!Number.isFinite(value)) return String(value);
  const rounded = Math.round(value * 10) / 10;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * 从规划结果提取固定摘要。
 *
 * @param {object} result planShapeRoute 结果
 * @returns {object} 摘要
 */
function summarize(result) {
  const metrics = result.metrics;
  const metricSummary = {};
  for (const key of METRIC_KEYS) {
    const value = metrics[key];
    metricSummary[key] = typeof value === 'number' || typeof value === 'string' ? round1(value) : String(value);
  }
  return {
    routeMeters: round1(metrics.routeMeters),
    failedLegs: metrics.failedLegs,
    reusedEdgeCount: metrics.reusedEdgeCount,
    legsCount: result.legs.length,
    score: round1(scoreRoute(metrics)),
    metrics: metricSummary,
  };
}

/** 5 个固定场景定义（顺序即 fixture 顺序） */
const SCENARIOS = [
  {
    id: 'straight',
    title: '合成直线：单条东西向主路 + 两点线段',
    build() {
      const { graph, edgeIndex } = makeRoadGraph(range(-1000, 1000, 100).map((x) => [x, 0]));
      const center = { x: 0, y: 0 };
      const sizeMeters = 800;
      const toLocal = projector(center, sizeMeters);
      const points = [[-400, 0], [400, 0]].map(toLocal);
      return {
        graph,
        edgeIndex,
        options: {
          customShape: { name: '直线', constraintPoints: points, outlinePoints: points.map((p) => p.slice()) },
          center: { lat: latOf(center.y), lng: lngOf(center.x) },
          sizeMeters,
          rotationDeg: 0,
        },
      };
    },
  },
  {
    id: 'triangle',
    title: '方格网三角：三个顶点都落在网格节点上',
    build() {
      const { graph, edgeIndex } = makeGridGraph({ min: -600, max: 600, step: 200 });
      const center = { x: 200, y: 100 };
      const sizeMeters = 600;
      const toLocal = projector(center, sizeMeters);
      const points = [[0, 0], [400, 0], [200, 200]].map(toLocal);
      return {
        graph,
        edgeIndex,
        options: {
          customShape: { name: '三角', constraintPoints: points, outlinePoints: points.map((p) => p.slice()) },
          center: { lat: latOf(center.y), lng: lngOf(center.x) },
          sizeMeters,
          rotationDeg: 0,
        },
      };
    },
  },
  {
    id: 'loop',
    title: '方格网六点闭环：六条形状腿顺时针绕一圈',
    build() {
      const { graph, edgeIndex } = makeGridGraph({ min: -600, max: 600, step: 200 });
      const center = { x: 0, y: 0 };
      const sizeMeters = 800;
      const toLocal = projector(center, sizeMeters);
      const points = [
        [-400, -200],
        [0, -400],
        [400, -200],
        [400, 200],
        [0, 400],
        [-400, 200],
      ].map(toLocal);
      return {
        graph,
        edgeIndex,
        options: {
          customShape: { name: '六点闭环', constraintPoints: points, outlinePoints: points.map((p) => p.slice()) },
          center: { lat: latOf(center.y), lng: lngOf(center.x) },
          sizeMeters,
          rotationDeg: 0,
        },
      };
    },
  },
  {
    id: 'multipart-connector',
    title: '多部分图形：主体闭环 + 分离岛（产生 connector 连接腿）',
    build() {
      const { graph, edgeIndex } = makeGridGraph({ min: -600, max: 600, step: 200 });
      const center = { x: 0, y: 0 };
      const sizeMeters = 1000;
      const toLocal = projector(center, sizeMeters);
      const basePoints = [
        [-400, -400],
        [400, -400],
        [400, -200],
        [-400, -200],
      ];
      const islandPoints = [
        [-200, 200],
        [0, 400],
        [200, 200],
      ];
      const outlineMeters = [...basePoints, ...islandPoints];
      return {
        graph,
        edgeIndex,
        options: {
          customShape: {
            name: '主体+岛',
            outlinePoints: outlineMeters.map(toLocal),
            constraintPoints: outlineMeters.map(toLocal),
            parts: [
              { name: 'base', outlineStart: 0, outlineCount: basePoints.length, constraintStart: 0, constraintCount: basePoints.length },
              { name: 'island', outlineStart: basePoints.length, outlineCount: islandPoints.length, constraintStart: basePoints.length, constraintCount: islandPoints.length },
            ],
          },
          center: { lat: latOf(center.y), lng: lngOf(center.x) },
          sizeMeters,
          rotationDeg: 0,
        },
      };
    },
  },
  {
    id: 'snap-shortcircuit',
    title: '吸附短路：约束点距道路 200m > 120m 硬门槛，planner 走无寻路短路分支',
    build() {
      const { graph, edgeIndex } = makeRoadGraph([[0, 0], [100, 0]]);
      const center = { x: 50, y: 0 };
      const sizeMeters = 600;
      const toLocal = projector(center, sizeMeters);
      const points = [[30, 200], [80, 200]].map(toLocal);
      return {
        graph,
        edgeIndex,
        options: {
          customShape: { name: '远离道路', constraintPoints: points, outlinePoints: points.map((p) => p.slice()) },
          center: { lat: latOf(center.y), lng: lngOf(center.x) },
          sizeMeters,
          rotationDeg: 0,
        },
      };
    },
  },
];

/**
 * 跑全部场景，返回 [{id, summary}]。
 *
 * @returns {Array<{id: string, summary: object}>} 场景摘要
 */
function generate() {
  return SCENARIOS.map((scenario) => {
    const { graph, edgeIndex, options } = scenario.build();
    const result = planShapeRoute({ graph, edgeIndex, ...options });
    return { id: scenario.id, summary: summarize(result) };
  });
}

/**
 * 取当前 HEAD 短 hash（仅 --update 写 meta 用；对比阶段不参与）。
 *
 * @returns {string} 短 hash 或 unknown
 */
function currentCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

// ---------- 场景前置断言：证明每个场景确实覆盖目标分支（与 golden 无关） ----------
/**
 * 场景分支覆盖断言。
 *
 * @param {string} id 场景 id
 * @param {object} summary 摘要
 * @returns {[string, boolean, string]} [标签, 条件, 详情]
 */
function scenarioExpectation(id, summary) {
  switch (id) {
    case 'straight':
      return [
        'straight：两点线段完整规划、2 条形状腿',
        summary.failedLegs === 0 && summary.metrics.routePointCount > 2 && summary.legsCount === 2,
        JSON.stringify(summary),
      ];
    case 'triangle':
      return [
        'triangle：三角三腿完整规划',
        summary.failedLegs === 0 && summary.metrics.routePointCount > 2 && summary.legsCount === 3,
        JSON.stringify(summary),
      ];
    case 'loop':
      return [
        'loop：六点闭环 6 条形状腿',
        summary.failedLegs === 0 && summary.metrics.routePointCount > 2 && summary.legsCount === 6,
        JSON.stringify(summary),
      ];
    case 'multipart-connector':
      return [
        'multipart-connector：多部分（partCount=2）且 7 条形状腿（主体 4 + 岛 3，connector 不计入 legs）',
        summary.failedLegs === 0 &&
          summary.metrics.partCount === 2 &&
          summary.metrics.routePointCount > 2 &&
          summary.legsCount === 7,
        JSON.stringify(summary),
      ];
    case 'snap-shortcircuit':
      return [
        'snap-shortcircuit：短路分支（无寻路）且吸附超 120m 门槛',
        summary.metrics.routePointCount === 0 &&
          summary.failedLegs === 0 &&
          Number(summary.metrics.snapMaxMeters) > 120,
        JSON.stringify(summary),
      ];
    default:
      return [`${id}：未知场景拒绝`, false, '未登记的场景 id'];
  }
}

// ---------- 主流程 ----------
const updateMode = process.argv.includes('--update');
const generated = generate();

// 1. 5 个场景都要有明确的前置分支覆盖（不是"跑通即通过"）
for (const scenario of generated) {
  const [label, condition, detail] = scenarioExpectation(scenario.id, scenario.summary);
  check(label, condition, detail);
}

// 2. 摘要结构：顶层字段固定、metrics 键固定（防止 fixture/生成器口径漂移）
for (const scenario of generated) {
  const actualSummaryKeys = Object.keys(scenario.summary);
  const actualMetricKeys = Object.keys(scenario.summary.metrics);
  check(
    `${scenario.id}：摘要字段口径固定`,
    JSON.stringify(actualSummaryKeys) === JSON.stringify(SUMMARY_KEYS) &&
      JSON.stringify(actualMetricKeys) === JSON.stringify(METRIC_KEYS),
    `summary=${actualSummaryKeys.join(',')} metrics=${actualMetricKeys.join(',')}`,
  );
}

const generatedSections = generated.map((item) => ({ id: item.id, summary: item.summary }));

if (updateMode) {
  const fixture = {
    _meta: {
      description:
        '引擎行为特征化基线（T-B1b）。由 `node test/engine-characterization.mjs --update` 生成；数值 round 到 0.1，非有限值存字符串。',
      generatedFromCommit: currentCommit(),
      metricKeys: METRIC_KEYS,
    },
    scenarios: generatedSections,
  };
  writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
  console.log(`\n[update] 已写入 ${FIXTURE_PATH}`);
  for (const scenario of generatedSections) {
    console.log(
      `  ${scenario.id}: route=${scenario.summary.routeMeters}m failed=${scenario.summary.failedLegs} ` +
        `reused=${scenario.summary.reusedEdgeCount} legs=${scenario.summary.legsCount} score=${scenario.summary.score}`,
    );
  }
} else if (!existsSync(FIXTURE_PATH)) {
  check('fixture 已入库', false, `缺少 ${FIXTURE_PATH}，请先运行 node test/engine-characterization.mjs --update`);
} else {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
  const golden = Array.isArray(fixture.scenarios) ? fixture.scenarios : [];

  check('fixture：含 5 个固定场景', golden.length === generatedSections.length && golden.length === 5,
    `golden=${golden.length} generated=${generatedSections.length}`);

  const goldenIds = golden.map((item) => item.id);
  const generatedIds = generatedSections.map((item) => item.id);
  check('fixture：场景 id 与顺序一致', JSON.stringify(goldenIds) === JSON.stringify(generatedIds),
    `golden=${goldenIds.join(',')} generated=${generatedIds.join(',')}`);

  // 逐字段严格 === 对比（复用 T-B1a 的 diff 工具；meta 不参与）
  const result = diffJson({ scenarios: golden }, { scenarios: generatedSections });
  check('fixture：5 个场景摘要逐字段 ===（0 差异）', result.equal === true,
    result.equal ? '' : `差异 ${result.totalDifferences} 处：${JSON.stringify(result.differences.slice(0, 8))}`);
  for (const difference of result.differences) {
    console.log(`  [diff] ${difference.path}: golden=${difference.before} current=${difference.after}`);
  }

  // 差异时把"如何重生成基线"一并打印，降低维护成本
  if (!result.equal) {
    console.log('\n提示：若差异是本方案预期的 metrics 口径变化（例如 D2/D3 修复），');
    console.log('      先确认变更理由后运行 `node test/engine-characterization.mjs --update` 重生成基线并评审 diff。');
  }

  console.log(
    `\n[fixture] 生成于 commit ${fixture._meta?.generatedFromCommit ?? 'unknown'}；对比 ${generatedSections.length} 个场景`,
  );
}

console.log(`\nRESULT: ${checks - failures}/${checks} 项通过，失败 ${failures} 项`);
if (failures > 0) {
  process.exitCode = 1;
}
