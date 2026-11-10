/**
 * 固定样本定点回放回归测试（Node 直接运行，不依赖浏览器/网络/模型）。
 *
 * 目的：本轮（地点/偏移说明/部位日志/超时文案）只改诊断与话术，不得改出图质量。
 * 用两份固定样本 + 固定候选做定点回放（不走带时间预算的全搜索，避免机器负载
 * 改变搜索轨迹），把改前的 scoreRoute / meetsQualityBar / 交付状态 / reference
 * 固化为基线；改后逐项比较。历史日志里的 74 分属于旧指标，不是预期值。
 *
 * 样本定义见 test/fixtures/fixed-samples.mjs（含来源与基线说明）。
 *
 * 运行：node test/fixed-candidates.mjs
 */

import { GUANGZHOU_ROADS_HINT, readRequiredText } from './lib/require-data.mjs';
import { normalizeCustomShape } from '../web/src/agent/intent.js';
import {
  buildEdgeIndex,
  buildWalkGraph,
  findLargestComponent,
} from '../web/src/engine/graph.js';
import { planShapeRoute } from '../web/src/engine/planner.js';
import {
  DELIVERABLE_SCORE,
  meetsQualityBar,
  scoreRoute,
} from '../web/src/engine/quality.js';
import {
  SAMPLE_A_CANDIDATE,
  SAMPLE_A_RAW,
  SAMPLE_BASELINES,
  SAMPLE_B_CANDIDATE,
  SAMPLE_B_RAW,
} from './fixtures/fixed-samples.mjs';

let failures = 0;
let checks = 0;

/**
 * 断言工具：记录通过/失败计数（失败必须在退出码体现）。
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

const roads = JSON.parse(
  readRequiredText(new URL('../mapdata/guangzhou-roads.json', import.meta.url), GUANGZHOU_ROADS_HINT),
).roads;
const graph = buildWalkGraph(roads);
const edgeIndex = buildEdgeIndex(graph, 0.005, findLargestComponent(graph));
console.log(`[graph] 节点 ${graph.nodeCount} / 边 ${graph.edgeCount}`);

/**
 * 按控制器/引擎的交付闸门推算交付状态与 reference 标志（与实现同口径）：
 * - meetsQualityBar 且评分 ≥ DELIVERABLE_SCORE → 绿色交付；
 * - 几何达标但评分低于闸门、或规划失败但仍有可绘制路线 → 橙色参考版；
 * - 连可绘制路线都没有 → 诚实失败。
 *
 * @param {object} result planShapeRoute 结果
 * @returns {{score: number, meetsQualityBar: boolean, planStatus: string, delivery: string, reference: boolean}}
 */
function deliveryOf(result) {
  const score = scoreRoute(result.metrics);
  const passes = meetsQualityBar(result.metrics) && result.routeLatLngs.length > 0;
  if (passes && score >= DELIVERABLE_SCORE) {
    return { score, meetsQualityBar: true, planStatus: 'ok', delivery: 'green', reference: false };
  }
  if (passes || result.routeLatLngs.length > 0) {
    return {
      score,
      meetsQualityBar: passes,
      planStatus: passes ? 'ok' : 'failed',
      delivery: 'orange-reference',
      reference: true,
    };
  }
  return {
    score,
    meetsQualityBar: passes,
    planStatus: 'failed',
    delivery: 'failed',
    reference: false,
  };
}

/**
 * 跑一份固定样本：归一化 → 定点回放 → 与基线逐项比较。
 *
 * @param {string} label 样本名
 * @param {object} raw 原始 customShape
 * @param {{center: {lat: number, lng: number}, sizeMeters: number, rotationDeg: number}} candidate 固定候选
 * @param {object} baseline 改前基线
 */
function runSample(label, raw, candidate, baseline) {
  const customShape = normalizeCustomShape(raw);
  check(`[${label}] 归一化成功`, Boolean(customShape));
  if (!customShape) {
    return;
  }
  const features = customShape.features || [];
  const kinds = features.reduce((acc, feature) => {
    acc[feature.kind] = (acc[feature.kind] || 0) + 1;
    return acc;
  }, {});
  check(
    `[${label}] 轮廓点数=${baseline.outlinePoints}`,
    customShape.outlinePoints.length === baseline.outlinePoints,
    `实际 ${customShape.outlinePoints.length}`,
  );
  check(
    `[${label}] 约束点数=${baseline.constraintPoints}`,
    customShape.constraintPoints.length === baseline.constraintPoints,
    `实际 ${customShape.constraintPoints.length}`,
  );
  check(
    `[${label}] 特征数=${baseline.features.total}`,
    features.length === baseline.features.total,
    `实际 ${features.length}（${JSON.stringify(kinds)}）`,
  );
  for (const kind of ['notch', 'gap', 'declared']) {
    check(
      `[${label}] ${kind} 特征数=${baseline.features[kind]}`,
      (kinds[kind] || 0) === baseline.features[kind],
      `实际 ${kinds[kind] || 0}`,
    );
  }
  // 样本 B 原始对象没有 features：特征全部来自 detectFeatures 的 notch/gap
  check(
    `[${label}] detectFeatures 至少产出一个 notch`,
    (kinds.notch || 0) >= 1,
    `实际 ${kinds.notch || 0}`,
  );

  const result = planShapeRoute({
    graph,
    edgeIndex,
    customShape,
    center: candidate.center,
    sizeMeters: candidate.sizeMeters,
    rotationDeg: candidate.rotationDeg,
  });
  check(`[${label}] 定点回放有可绘制路线`, result.routeLatLngs.length > 0, `实际 ${result.routeLatLngs.length} 点`);
  if (result.routeLatLngs.length === 0) {
    return;
  }
  const delivery = deliveryOf(result);
  check(`[${label}] scoreRoute=${baseline.score}`, delivery.score === baseline.score, `实际 ${delivery.score}`);
  check(
    `[${label}] meetsQualityBar=${baseline.meetsQualityBar}`,
    delivery.meetsQualityBar === baseline.meetsQualityBar,
    `实际 ${delivery.meetsQualityBar}`,
  );
  // 文档要求逐项一致：planStatus 也要直接断言（不只靠 delivery/reference 间接覆盖）
  check(
    `[${label}] planStatus=${baseline.planStatus}`,
    delivery.planStatus === baseline.planStatus,
    `实际 ${delivery.planStatus}`,
  );
  check(
    `[${label}] 交付状态=${baseline.delivery}`,
    delivery.delivery === baseline.delivery,
    `实际 ${delivery.delivery}`,
  );
  check(
    `[${label}] commitDraw reference=${baseline.reference}`,
    delivery.reference === baseline.reference,
    `实际 ${delivery.reference}`,
  );
  // 本轮新增的部位弧偏差只进独立 trace 事件，不得混入评分指标
  check(
    `[${label}] metrics 不含部位弧偏差字段`,
    !('featureArcs' in result.metrics) && !('arcMaxOffsetMeters' in result.metrics),
  );
  console.log(
    `[${label}] 回放: score=${delivery.score} 尺寸=${candidate.sizeMeters}m 朝向=${candidate.rotationDeg}° ` +
      `路线=${Math.round(result.metrics.routeMeters)}m 特征走全=${result.metrics.featureCoveredCount}/${result.metrics.featureCount}`,
  );
}

runSample('样本A', SAMPLE_A_RAW, SAMPLE_A_CANDIDATE, SAMPLE_BASELINES.A);
runSample('样本B', SAMPLE_B_RAW, SAMPLE_B_CANDIDATE, SAMPLE_BASELINES.B);

console.log(`\n[summary] ${checks - failures}/${checks} 项通过，失败 ${failures} 项`);
if (failures > 0) {
  process.exitCode = 1;
}
