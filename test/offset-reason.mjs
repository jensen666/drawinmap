/**
 * 偏移说明近场证据测试（Node 直接运行，不依赖浏览器/网络/LLM）。
 *
 * 覆盖 docs/方案设计/2026-10-26-推理过程固定工作流.md 第 3.2 节：
 * 1. offsetSubject：覆盖中心主语与普通主语；
 * 2. describeNearFieldFailure：四种近场证据分支（吸附 >120m / 路线完整+有限有序偏差 /
 *    有部分路线未走通 / 没有候选或没有可评价路线）；
 * 3. pickNearRepresentative：按 adjustedScore 取最高、并列保持 shapeKeys 顺序；
 * 4. composeOffsetNotice：plan/recommend 两条模板、areaName 缺省、推荐不声称三种图形同因失败；
 * 5. 反例隔离：近场 metrics 与最终远处候选完全不同时，文案只反映近场值；
 * 6. 候选数据字段（真实路网、小预算）：searchWithEscalation 的 nearBest 与
 *    recommendShapes 的 nearBests 确实来自第一级搜索、结构完整、失败时为 null。
 *
 * 运行：node test/offset-reason.mjs
 * 说明：第 1~5 节只针对纯函数模块；第 6 节加载真实路网但把候选预算压到很小
 *（30 个候选），用于快速回归 candidates.js 的近场记录行为。
 */

import { GUANGZHOU_ROADS_HINT, readRequiredText } from './lib/require-data.mjs';
import { buildEdgeIndex, buildWalkGraph, findLargestComponent } from '../web/src/engine/graph.js';
import { planShapeRoute } from '../web/src/engine/planner.js';
import { recommendShapes, scoreRoute, searchWithEscalation } from '../web/src/engine/candidates.js';
import {
  NEAR_FIELD_SNAP_HARD_METERS,
  composeOffsetNotice,
  describeNearFieldFailure,
  offsetSubject,
  pickNearRepresentative,
} from '../web/src/agent/offset-reason.js';

let passCount = 0;
let failCount = 0;

/**
 * 断言工具：失败时打印实际值，便于定位。
 *
 * @param {string} label 断言标签
 * @param {boolean} condition 断言条件
 * @param {string} [detail] 失败时附带的实际值说明
 */
function check(label, condition, detail = '') {
  if (condition) {
    passCount += 1;
    console.log(`[check] ${label} -> PASS`);
  } else {
    failCount += 1;
    console.log(`[check] ${label} -> FAIL ${detail}`);
  }
}

/** 断言包含子串 */
function checkIncludes(label, text, fragment) {
  check(label, typeof text === 'string' && text.includes(fragment), `期望包含「${fragment}」，实际：${text}`);
}

/** 断言不包含子串 */
function checkExcludes(label, text, fragment) {
  check(label, typeof text === 'string' && !text.includes(fragment), `不应包含「${fragment}」，实际：${text}`);
}

/** 断言完全相等 */
function checkEquals(label, actual, expected) {
  check(label, actual === expected, `期望：${JSON.stringify(expected)} 实际：${JSON.stringify(actual)}`);
}

/**
 * 构造近场候选的 metrics（字段口径与 planner 输出的 metrics 一致）。
 *
 * @param {object} [overrides] 覆盖字段
 * @returns {object} metrics
 */
function makeMetrics(overrides = {}) {
  return {
    failedLegs: 0,
    snapMaxMeters: 20,
    orderedOutlineMeanMeters: 35.4,
    orderedOutlineMaxMeters: 88.6,
    ...overrides,
  };
}

/**
 * 构造近场最好候选（candidates.js nearBest 的真实结构）。
 *
 * @param {object} [options]
 * @param {object|null} [options.metrics] 近场 metrics，null 表示 metrics 缺失
 * @param {Array<[number, number]>|null} [options.routeLatLngs] 路线点列，null 表示缺失
 * @param {number} [options.score] 原始分
 * @param {number} [options.adjustedScore] 调整分
 * @returns {object} nearBest
 */
function makeNearBest({
  metrics = makeMetrics(),
  routeLatLngs = [
    [23.1, 113.3],
    [23.101, 113.301],
    [23.102, 113.302],
  ],
  score = 66,
  adjustedScore = 60,
} = {}) {
  const result = {};
  if (metrics !== null) {
    result.metrics = metrics;
  }
  if (routeLatLngs !== null) {
    result.routeLatLngs = routeLatLngs;
  }
  return {
    result,
    score,
    adjustedScore,
    center: { lat: 23.1, lng: 113.3 },
    sizeMeters: 1200,
    rotationDeg: 0,
    stage: 1,
    stageLabel: '近场搜索',
  };
}

/** 构造一个按图形记录近场候选的 nearBests 表 */
function makeNearBests(map) {
  const table = {};
  for (const [shapeKey, adjustedScore] of Object.entries(map || {})) {
    table[shapeKey] = makeNearBest({ adjustedScore, score: adjustedScore + 5 });
    table[shapeKey].shapeKey = shapeKey;
  }
  return table;
}

// ---------- 1. 主语：覆盖中心 / 普通地点 ----------
{
  const center = offsetSubject('coverage-center');
  checkEquals('subject.coverage-center', center, '按已加载路网的覆盖中心');
  checkExcludes('subject.coverage-center.no-user-place', center, '您指定的地方');

  checkEquals('subject.poi', offsetSubject('poi'), '您指定的地方');
  checkEquals('subject.road', offsetSubject('road'), '您指定的地方');
  checkEquals('subject.undefined', offsetSubject(undefined), '您指定的地方');
  checkEquals('subject.null', offsetSubject(null), '您指定的地方');
}

// ---------- 2. 近场证据表：吸附 > 120m → 可能临水/无路区 ----------
{
  const hardSnap = makeNearBest({ metrics: makeMetrics({ snapMaxMeters: 200.4, orderedOutlineMeanMeters: 9999 }) });
  checkEquals(
    'near.snap-hard.text',
    describeNearFieldFailure(hardSnap),
    '图形部分区域可能临水或落在无路区',
  );
  checkEquals(
    'near.snap-hard.threshold-constant',
    NEAR_FIELD_SNAP_HARD_METERS,
    120,
  );
  // 边界：恰好 120m 不算超阈值，必须落到"有序贴合"口径；121m 才算
  checkEquals(
    'near.snap-boundary-120',
    describeNearFieldFailure(makeNearBest({ metrics: makeMetrics({ snapMaxMeters: 120 }) })),
    '近场最好候选的有序贴合平均 35 m / 最大 89 m',
  );
  checkEquals(
    'near.snap-boundary-121',
    describeNearFieldFailure(makeNearBest({ metrics: makeMetrics({ snapMaxMeters: 121 }) })),
    '图形部分区域可能临水或落在无路区',
  );
  // 评审反例：规划器吸附超限会直接短路，返回 routeLatLngs=[] 但保留真实 snapMaxMeters；
  // 此时必须先判吸附（临水/无路区），不能因"没有可评价路线"把真实证据说丢
  const emptyRouteHardSnap = makeNearBest({
    metrics: makeMetrics({ snapMaxMeters: 139.001, orderedOutlineMeanMeters: Number.POSITIVE_INFINITY }),
    routeLatLngs: [],
  });
  checkEquals(
    'near.snap-hard-empty-route.text',
    describeNearFieldFailure(emptyRouteHardSnap),
    '图形部分区域可能临水或落在无路区',
  );
  // 对照：空路线但吸附未超限 → 仍落到"没有形成可评价的路线"（不误报临水）
  checkEquals(
    'near.empty-route-snap-ok.text',
    describeNearFieldFailure(makeNearBest({ metrics: makeMetrics({ snapMaxMeters: 80 }), routeLatLngs: [] })),
    '近场没有形成可评价的路线',
  );
}

// ---------- 3. 近场证据表：路线完整 + 有序偏差有限 → 写明平均/最大 ----------
{
  const complete = makeNearBest({
    metrics: makeMetrics({ failedLegs: 0, snapMaxMeters: 40, orderedOutlineMeanMeters: 42.6, orderedOutlineMaxMeters: 118.4 }),
  });
  const reason = describeNearFieldFailure(complete);
  checkEquals('near.ordered.text', reason, '近场最好候选的有序贴合平均 43 m / 最大 118 m');
  checkIncludes('near.ordered.has-mean', reason, '平均 43 m');
  checkIncludes('near.ordered.has-max', reason, '最大 118 m');
  checkExcludes('near.ordered.no-water', reason, '临水');
  checkExcludes('near.ordered.no-incomplete-network', reason, '路网不完整');
}

// ---------- 4. 近场证据表：有部分路线但未走通 → 近场路线未走通 ----------
{
  const partial = makeNearBest({ metrics: makeMetrics({ failedLegs: 2, snapped: undefined }) });
  const reason = describeNearFieldFailure(partial);
  checkEquals('near.partial.text', reason, '近场路线未走通');
  checkExcludes('near.partial.no-water', reason, '临水');
  checkExcludes('near.partial.no-incomplete-network', reason, '路网不完整');
}

// ---------- 5. 近场证据表：没有候选 / 没有可评价路线 ----------
{
  checkEquals('near.no-candidate', describeNearFieldFailure(null), '近场没有形成可评价的路线');
  checkEquals('near.undefined-candidate', describeNearFieldFailure(undefined), '近场没有形成可评价的路线');
  // 有候选对象但没有 result
  checkEquals(
    'near.no-result',
    describeNearFieldFailure({ score: 0, adjustedScore: 0 }),
    '近场没有形成可评价的路线',
  );
  // 有 result 但没有 metrics
  checkEquals(
    'near.no-metrics',
    describeNearFieldFailure(makeNearBest({ metrics: null })),
    '近场没有形成可评价的路线',
  );
  // 路线不足 2 个点
  checkEquals(
    'near.route-too-short',
    describeNearFieldFailure(makeNearBest({ routeLatLngs: [[23.1, 113.3]] })),
    '近场没有形成可评价的路线',
  );
  checkEquals(
    'near.route-empty',
    describeNearFieldFailure(makeNearBest({ routeLatLngs: [] })),
    '近场没有形成可评价的路线',
  );
  // 有序偏差非有限值且路线完整：没有可报数字，不能编造临水，落到兜底口径
  checkEquals(
    'near.complete-infinite-ordered',
    describeNearFieldFailure(
      makeNearBest({
        metrics: makeMetrics({
          failedLegs: 0,
          orderedOutlineMeanMeters: Number.POSITIVE_INFINITY,
          orderedOutlineMaxMeters: Number.POSITIVE_INFINITY,
        }),
      }),
    ),
    '近场没有形成可评价的路线',
  );
  // 有序偏差其中一个为 NaN 也同样落到兜底口径
  checkEquals(
    'near.complete-nan-ordered',
    describeNearFieldFailure(
      makeNearBest({ metrics: makeMetrics({ failedLegs: 0, orderedOutlineMeanMeters: 10, orderedOutlineMaxMeters: Number.NaN }) }),
    ),
    '近场没有形成可评价的路线',
  );
}

// ---------- 6. pickNearRepresentative：adjustedScore 最高 + 并列保持遍历顺序 ----------
{
  const nearBests = makeNearBests({ star: 50, heart: 70, rect: 70 });
  const first = pickNearRepresentative(nearBests, ['star', 'heart', 'rect']);
  checkEquals('pick.highest.shapeKey', first?.shapeKey, 'heart');
  // 并列时按 shapeKeys 顺序：rect 在前则取 rect
  const reordered = pickNearRepresentative(nearBests, ['rect', 'star', 'heart']);
  checkEquals('pick.tie-follows-shapeKeys', reordered?.shapeKey, 'rect');
  // 唯一最高分不受遍历顺序影响
  const clear = makeNearBests({ star: 50, heart: 80, rect: 60 });
  checkEquals('pick.clear-winner', pickNearRepresentative(clear, ['star', 'heart', 'rect'])?.shapeKey, 'heart');
  checkEquals('pick.clear-winner.any-order', pickNearRepresentative(clear, ['rect', 'star', 'heart'])?.shapeKey, 'heart');
  // 缺失/null 候选跳过
  const withNulls = makeNearBests({ star: 50 });
  withNulls.heart = null;
  checkEquals('pick.skip-null', pickNearRepresentative(withNulls, ['heart', 'star', 'rect'])?.shapeKey, 'star');
  // 无候选
  checkEquals('pick.empty-table', pickNearRepresentative({}, ['star', 'heart', 'rect']), null);
  checkEquals('pick.empty-keys', pickNearRepresentative(makeNearBests({ star: 50 }), []), null);
  checkEquals('pick.null-table', pickNearRepresentative(null, ['star']), null);
  checkEquals('pick.bad-shape-keys', pickNearRepresentative(makeNearBests({ star: 50 }), null), null);
}

// ---------- 7. composeOffsetNotice：plan / recommend 模板 ----------
{
  const reason = '图形部分区域可能临水或落在无路区';
  const planNotice = composeOffsetNotice({
    kind: 'plan',
    reason,
    placeSource: 'coverage-center',
    offsetText: '东约 1.2 km',
    areaName: '花城广场',
  });
  checkEquals(
    'notice.plan.exact',
    planNotice,
    '注意：按已加载路网的覆盖中心画不出像样的图形（图形部分区域可能临水或落在无路区）。我扩大范围后，在东约 1.2 km的「花城广场」一带画出来了，图上就是。如果您要求必须画在原地，物理上做不到，可以换个图形或地点。',
  );
  checkIncludes('notice.plan.coverage-subject', planNotice, '按已加载路网的覆盖中心');
  checkExcludes('notice.plan.no-user-subject', planNotice, '您指定的地方');
  checkIncludes('notice.plan.has-area', planNotice, '「花城广场」一带');
  checkIncludes('notice.plan.has-offset', planNotice, '东约 1.2 km');

  const recommendNotice = composeOffsetNotice({
    kind: 'recommend',
    reason: '近场路线未走通',
    placeSource: 'poi',
    offsetText: '北约 900 m',
    areaName: null,
  });
  checkEquals(
    'notice.recommend.exact',
    recommendNotice,
    '注意：您指定的地方近场画不出像样的图形（近场路线未走通）。我扩大范围后，在北约 900 m的路网更完整的区域画出来了，图上就是。如果您要求必须画在原地，物理上做不到。',
  );
  checkIncludes('notice.recommend.default-where', recommendNotice, '路网更完整的区域');
  // 推荐链路只描述代表候选，不声称三种图形同因失败
  checkExcludes('notice.recommend.no-three-shapes', recommendNotice, '三种图形');
  checkExcludes('notice.recommend.no-same-reason', recommendNotice, '同一原因');
  checkExcludes('notice.recommend.no-plan-suffix', recommendNotice, '可以换个图形或地点');
  // docs 模板要求推荐解释也带"近场"，计划模板不带
  checkIncludes('notice.recommend.has-near-field', recommendNotice, '近场画不出像样的图形');

  // 未知 kind 按 plan 模板处理（链路只有这两条，多传不应丢句尾建议）
  const unknownKind = composeOffsetNotice({ kind: 'other', reason: '近场路线未走通', offsetText: '东约 1 km', areaName: null });
  checkIncludes('notice.unknown-kind.plan-fallback', unknownKind, '可以换个图形或地点');
}

// ---------- 8. 反例隔离：近场 metrics 与最终远处候选完全不同 → 只用近场值 ----------
{
  // 近场：吸附 200m（触达临水/无路区口径），有序偏差也是近场自己的数
  const nearBest = makeNearBest({
    metrics: makeMetrics({ snapMaxMeters: 200, orderedOutlineMeanMeters: 9999, orderedOutlineMaxMeters: 9999 }),
  });
  // 最终远处候选：吸附 10m、有序偏差很小——若被误用于解释近场失败，会给出"贴合很好"的错误文案
  const finalCandidate = makeNearBest({
    metrics: makeMetrics({ snapMaxMeters: 10, orderedOutlineMeanMeters: 5, orderedOutlineMaxMeters: 8 }),
    routeLatLngs: [
      [23.2, 113.4],
      [23.201, 113.401],
      [23.202, 113.402],
    ],
  });
  const nearReason = describeNearFieldFailure(nearBest);
  checkEquals('isolation.near-reason', nearReason, '图形部分区域可能临水或落在无路区');
  // 同一句话若错误地用了最终候选，会变成"贴合平均 5 m / 最大 8 m"——证明两条路径可区分
  checkEquals(
    'isolation.final-reason-would-differ',
    describeNearFieldFailure(finalCandidate),
    '近场最好候选的有序贴合平均 5 m / 最大 8 m',
  );
  const notice = composeOffsetNotice({
    kind: 'recommend',
    reason: nearReason,
    placeSource: 'coverage-center',
    offsetText: '东约 2.0 km',
    areaName: '天河体育中心',
  });
  checkIncludes('isolation.notice.uses-near', notice, '图形部分区域可能临水或落在无路区');
  checkExcludes('isolation.notice.no-final-numbers', notice, '贴合平均 5 m');
  checkExcludes('isolation.notice.no-final-max', notice, '最大 8 m');
  checkExcludes('isolation.notice.no-user-subject', notice, '您指定的地方');
}

// ---------- 9. 联调口径：推荐链路 nearBests → 代表候选 → 原因 → 整句 ----------
{
  const nearBests = {
    star: makeNearBest({ adjustedScore: 40, metrics: makeMetrics({ snapMaxMeters: 10 }) }),
    heart: makeNearBest({ adjustedScore: 72, metrics: makeMetrics({ snapMaxMeters: 180 }) }),
    rect: makeNearBest({ adjustedScore: 55, metrics: makeMetrics({ failedLegs: 1 }) }),
  };
  nearBests.star.shapeKey = 'star';
  nearBests.heart.shapeKey = 'heart';
  nearBests.rect.shapeKey = 'rect';
  const representative = pickNearRepresentative(nearBests, ['star', 'heart', 'rect']);
  checkEquals('chain.representative', representative?.shapeKey, 'heart');
  const reason = describeNearFieldFailure(representative);
  checkEquals('chain.reason', reason, '图形部分区域可能临水或落在无路区');
  const notice = composeOffsetNotice({
    kind: 'recommend',
    reason,
    placeSource: 'coverage-center',
    offsetText: '西约 1.5 km',
    areaName: null,
  });
  checkEquals(
    'chain.notice.exact',
    notice,
    '注意：按已加载路网的覆盖中心近场画不出像样的图形（图形部分区域可能临水或落在无路区）。我扩大范围后，在西约 1.5 km的路网更完整的区域画出来了，图上就是。如果您要求必须画在原地，物理上做不到。',
  );
}

// ---------- 10. 候选数据字段（真实路网、小预算）：nearBest / nearBests 来自第一级 ----------
{
  const roads = JSON.parse(
    readRequiredText(new URL('../mapdata/guangzhou-roads.json', import.meta.url), GUANGZHOU_ROADS_HINT),
  ).roads;
  const graph = buildWalkGraph(roads);
  const mainComponent = findLargestComponent(graph);
  const edgeIndex = buildEdgeIndex(graph, 0.005, mainComponent);
  console.log(`  [data] 路网节点 ${graph.nodeCount} / 边 ${graph.edgeCount}`);

  // 单图形：预算 30 个候选（只够第一级的一部分），nearBest 仍必须来自第一级的 best
  const single = await searchWithEscalation({
    graph,
    edgeIndex,
    shapeKey: 'rect',
    center: { lat: 23.1252, lng: 113.2455 },
    baseSizeMeters: 800,
    maxCandidates: 30,
  });
  check('data.search.has-nearBest-key', 'nearBest' in single);
  check('data.search.nearBest-present', Boolean(single.nearBest?.result?.metrics));
  check(
    'data.search.nearBest-stage1',
    single.nearBest?.stage === 1 && single.nearBest?.stageLabel === '近场搜索',
    `${single.nearBest?.stage}/${single.nearBest?.stageLabel}`,
  );
  check(
    'data.search.nearBest-structure',
    Boolean(single.nearBest) &&
      ['result', 'score', 'adjustedScore', 'center', 'sizeMeters', 'rotationDeg', 'stage', 'stageLabel'].every(
        (key) => key in single.nearBest,
      ),
  );
  check(
    'data.search.nearBest-score',
    Boolean(single.nearBest) && single.nearBest.score === scoreRoute(single.nearBest.result.metrics),
  );
  check(
    'data.search.nearBest-route',
    Boolean(single.nearBest?.result?.routeLatLngs) && single.nearBest.result.routeLatLngs.length >= 2,
  );
  // 不得写入 metrics
  check('data.search.metrics-clean', single.best?.result?.metrics?.nearBest === undefined);

  // 无路区域：近场没有任何成功候选 → nearBest 必须是 null（字段仍存在）
  const failed = await searchWithEscalation({
    graph,
    edgeIndex,
    shapeKey: 'heart',
    center: { lat: 23.5, lng: 113.9 },
    baseSizeMeters: 939,
    maxCandidates: 30,
  });
  check('data.failed.has-nearBest-key', 'nearBest' in failed);
  check('data.failed.nearBest-null', failed.nearBest === null, JSON.stringify(failed.nearBest));

  // 推荐链路：第一级按图形记录 nearBests（预算 30 只够第一个图形的一级的一部分）
  const recommend = await recommendShapes({
    graph,
    edgeIndex,
    center: { lat: 23.1252, lng: 113.2455 },
    shapeSizes: { star: 1200, heart: 1200, rect: 1200 },
    maxCandidates: 30,
  });
  check('data.recommend.has-nearBests-key', 'nearBests' in recommend);
  check(
    'data.recommend.nearBests.star-stage1',
    recommend.nearBests?.star?.stage === 1 &&
      recommend.nearBests?.star?.stageLabel === '近场搜索' &&
      recommend.nearBests?.star?.shapeKey === 'star',
    JSON.stringify(recommend.nearBests?.star ? { stage: recommend.nearBests.star.stage } : null),
  );
  check(
    'data.recommend.nearBests-values-finite',
    ['star', 'heart', 'rect'].every((key) => {
      const candidate = recommend.nearBests?.[key];
      return !candidate || Number.isFinite(candidate.adjustedScore);
    }),
  );
}

// ---------- 11. 真实复现：定点吸附超限短路（空路线 + 真实 snapMax）必须说"临水/无路区" ----------
{
  const roads = JSON.parse(
    readRequiredText(new URL('../mapdata/guangzhou-roads.json', import.meta.url), GUANGZHOU_ROADS_HINT),
  ).roads;
  const graph = buildWalkGraph(roads);
  const edgeIndex = buildEdgeIndex(graph, 0.005, findLargestComponent(graph));
  // 广州塔紧贴珠江：1200m 心形定点回放会被吸附门槛短路（评审复现：route 0 点 / snapMax 139.001m）
  const shortCircuited = planShapeRoute({
    graph,
    edgeIndex,
    shapeKey: 'heart',
    center: { lat: 23.1066, lng: 113.3246 },
    sizeMeters: 1200,
    rotationDeg: 0,
  });
  check(
    'repro.guangzhoutower.heart.snap-hard-short-circuit',
    shortCircuited.routeLatLngs.length === 0 &&
      shortCircuited.metrics.snapMaxMeters > NEAR_FIELD_SNAP_HARD_METERS,
    `routePoints=${shortCircuited.routeLatLngs.length} snapMax=${shortCircuited.metrics.snapMaxMeters}`,
  );
  checkEquals(
    'repro.guangzhoutower.heart.offset-reason',
    describeNearFieldFailure({
      result: shortCircuited,
      score: 0,
      adjustedScore: 0,
      stage: 1,
      stageLabel: '近场搜索',
    }),
    '图形部分区域可能临水或落在无路区',
  );
}

// ---------- 汇总 ----------
const total = passCount + failCount;
console.log('');
console.log(`SUMMARY: ${passCount}/${total} checks passed, ${failCount} failed`);
// 失败必须让脚本以非 0 退出（CI/人工复跑据此判断）；与 engine-smoke 保持同一口径
process.exitCode = failCount === 0 ? 0 : 1;
console.log(failCount === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${failCount} failed)`);
// 第 6 节的候选搜索会创建 MessageChannel 用于让出主线程（engine/candidates.js），
// 它不会自动关闭并会保持 Node 事件循环存活；这里显式退出，避免测试跑完却挂住不返回。
process.exit(process.exitCode);
