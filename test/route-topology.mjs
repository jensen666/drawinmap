/**
 * 路线拓扑指标测试：唯一交叉（非相邻段交叉）与重复道路比例（Node 直接运行）。
 *
 * 背景（《图形路线视觉效果通用优化方案》阶段 0）：逐段贴合合理不等于整条路线成立，
 * 需要"非相邻段交叉"与"重复道路比例"两个诊断指标，先只做指标与日志、不做阈值门禁。
 *
 * 本测试用真实几何合成（米制坐标换算成经纬度后送入模块），覆盖：
 * 1) 正例：不相交段 → 0 个交叉；
 * 2) 反例：非相邻段真实交叉 → 1 个交叉且交点坐标正确；
 * 3) 相邻腿接缝、首尾闭合接缝不算交叉；
 * 4) 端点接触（含 1.0m 容差边界）不算交叉；
 * 5) 同一交点被 3 条腿命中只算一次；
 * 6) 共线重叠不算交叉；
 * 7) 重复道路比例的正常值与 null 口径（缺失/零分母/非有限/负值）；
 * 8) 空输入、单点段、非法值不产生 NaN/Infinity 误判；
 * 9) 降采样上界：超大折线集合仍在预算内完成。
 *
 * 运行：node test/route-topology.mjs
 */
import {
  countUniqueCrossings,
  reusedEdgeRatio,
  routeReuseSummary,
  collectRouteTopologyMetrics,
} from '../web/src/engine/route-topology.js';

let failures = 0;
let assertions = 0;

/** 断言工具 */
function check(label, condition, detail = '') {
  assertions += 1;
  const ok = Boolean(condition);
  if (!ok) {
    failures += 1;
  }
  console.log(`[check] ${label} -> ${ok ? 'PASS' : `FAIL ${detail}`}`);
}

// 合成几何的米制基准（与 engine/fidelity.js 同口径：111320m/纬度，经度按 cos(lat)）
const LAT0 = 23.12;
const LNG0 = 113.32;
const M_PER_DEG_LAT = 111320;
const M_PER_DEG_LNG = M_PER_DEG_LAT * Math.cos((LAT0 * Math.PI) / 180);
const latOf = (north) => LAT0 + north / M_PER_DEG_LAT;
const lngOf = (east) => LNG0 + east / M_PER_DEG_LNG;
/** 米制（东, 北）→ 经纬度点 */
const P = (east, north) => [latOf(north), lngOf(east)];

/** 两点间米制距离 */
function meters(a, b) {
  return Math.hypot((b[0] - a[0]) * M_PER_DEG_LAT, (b[1] - a[1]) * M_PER_DEG_LNG);
}

/** 过原点的直线（两条端点） */
function throughOrigin(deg) {
  const rad = (deg * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  return [P(-2000 * dx, -2000 * dy), P(2000 * dx, 2000 * dy)];
}

// ---------- 1. 正例：两条不相交的非相邻段 ----------
{
  const legs = [
    [P(-200, 0), P(200, 0)],
    [P(-200, 500), P(200, 500)],
    [P(-200, -500), P(200, -500)],
    [P(-200, 900), P(200, 900)],
  ];
  const r = countUniqueCrossings(legs);
  check('正例：不相交的非相邻段 → count = 0', r.count === 0, `实际 ${r.count}`);
  check('正例：points 为空数组', Array.isArray(r.points) && r.points.length === 0, `实际 ${JSON.stringify(r.points)}`);
}

// ---------- 2. 反例：两条非相邻段真实交叉 ----------
{
  const legs = [
    [P(-200, 0), P(200, 0)], // 腿 0：水平
    [P(-200, 500), P(200, 500)], // 腿 1：远
    [P(0, -300), P(0, 300)], // 腿 2：竖直，与腿 0 在 (0,0) 相交
    [P(-200, 900), P(200, 900)], // 腿 3：远
  ];
  const r = countUniqueCrossings(legs);
  check('反例：非相邻段交叉 → count = 1', r.count === 1, `实际 ${r.count}`);
  check(
    '反例：交点坐标正确（落在原点 0.5m 内）',
    r.points.length === 1 && meters(r.points[0], P(0, 0)) < 0.5,
    `实际 ${JSON.stringify(r.points)}`,
  );
}

// ---------- 3. 相邻腿接缝不算交叉 ----------
{
  // 腿 1 与腿 2 相邻，几何上真实相交，但属合法接缝
  const legs = [
    [P(-200, 0), P(200, 0)],
    [P(-200, 500), P(200, 500)],
    [P(0, 300), P(0, 700)], // 与腿 1 在 (0,500) 相交（相邻腿）
    [P(-200, 900), P(200, 900)],
  ];
  const r = countUniqueCrossings(legs);
  check('相邻接缝：相邻腿真实相交也不算交叉 → count = 0', r.count === 0, `实际 ${r.count}`);
}
{
  // 相邻腿首尾相接（共享端点）
  const legs = [
    [P(-200, 0), P(0, 0)],
    [P(0, 0), P(0, 200)], // 与腿 0 共享端点 (0,0)
    [P(-200, 500), P(200, 500)],
    [P(-200, 900), P(200, 900)],
  ];
  const r = countUniqueCrossings(legs);
  check('相邻接缝：相邻腿共享端点不算交叉 → count = 0', r.count === 0, `实际 ${r.count}`);
}

// ---------- 4. 首尾闭合接缝不算交叉 ----------
{
  const legs = [
    [P(-200, 0), P(200, 0)], // 腿 0
    [P(-200, 500), P(200, 500)], // 腿 1
    [P(-200, 900), P(200, 900)], // 腿 2
    [P(0, -300), P(0, 300)], // 腿 3：与腿 0 在 (0,0) 相交，但 0 与 n-1 是首尾闭合接缝
  ];
  const r = countUniqueCrossings(legs);
  check('首尾闭合：首尾腿真实相交也不算交叉 → count = 0', r.count === 0, `实际 ${r.count}`);
}

// ---------- 5. 端点接触不算交叉（含 1.0m 容差边界） ----------
{
  const legs = [
    [P(-200, 0), P(0, 0)], // 腿 0 末端正好落在交点 (0,0)
    [P(-200, 500), P(200, 500)],
    [P(-100, -300), P(100, 300)], // 腿 2 经过 (0,0)
    [P(-200, 900), P(200, 900)],
  ];
  const r = countUniqueCrossings(legs);
  check('端点接触：交点正好在段端点 → 不算交叉 → count = 0', r.count === 0, `实际 ${r.count}`);
}
{
  const near = countUniqueCrossings([
    [P(-200, 0), P(0.5, 0)], // 末端距交点 0.5m（< 1.0m 容差）
    [P(-200, 500), P(200, 500)],
    [P(-100, -300), P(100, 300)],
    [P(-200, 900), P(200, 900)],
  ]);
  check('端点容差：交点距端点 0.5m（<1.0m）→ 不计入', near.count === 0, `实际 ${near.count}`);
}
{
  const far = countUniqueCrossings([
    [P(-200, 0), P(1.5, 0)], // 末端距交点 1.5m（> 1.0m 容差）
    [P(-200, 500), P(200, 500)],
    [P(-100, -300), P(100, 300)],
    [P(-200, 900), P(200, 900)],
  ]);
  check('端点容差：交点距端点 1.5m（>1.0m）→ 计入', far.count === 1, `实际 ${far.count}`);
}

// ---------- 6. 同一交点被 3 条腿命中只算一次 ----------
{
  // 6 条腿：腿 0/2/4 是三条不同方向、都经过原点的直线
  const legs = [
    throughOrigin(0),
    [P(-200, 500), P(200, 500)],
    throughOrigin(60),
    [P(-200, -500), P(200, -500)],
    throughOrigin(120),
    [P(-200, 900), P(200, 900)],
  ];
  const r = countUniqueCrossings(legs);
  check('聚类去重：3 条腿命中同一交点 → 只算一次 → count = 1', r.count === 1, `实际 ${r.count}`);
  check(
    '聚类去重：交点坐标为原点',
    r.points.length === 1 && meters(r.points[0], P(0, 0)) < 0.5,
    `实际 ${JSON.stringify(r.points)}`,
  );
}

// ---------- 7. 共线重叠不算交叉 ----------
{
  const full = countUniqueCrossings([
    [P(-300, 0), P(300, 0)], // 腿 0
    [P(-200, 500), P(200, 500)],
    [P(-100, 0), P(100, 0)], // 腿 2：与腿 0 共线且完全重叠
    [P(-200, 900), P(200, 900)],
  ]);
  check('共线重叠：完全重叠不算交叉 → count = 0', full.count === 0, `实际 ${full.count}`);
}
{
  const partial = countUniqueCrossings([
    [P(-300, 0), P(0, 0)], // 腿 0：部分重叠
    [P(-200, 500), P(200, 500)],
    [P(-100, 0), P(100, 0)], // 腿 2
    [P(-200, 900), P(200, 900)],
  ]);
  check('共线重叠：部分重叠也不算交叉 → count = 0', partial.count === 0, `实际 ${partial.count}`);
}

// ---------- 8. 重复道路比例 ----------
{
  check('重复比例：0 / 1000 → 0', reusedEdgeRatio({ reusedEdgeMeters: 0, routeMeters: 1000 }) === 0);
  check(
    '重复比例：250 / 1000 → 0.25',
    Math.abs(reusedEdgeRatio({ reusedEdgeMeters: 250, routeMeters: 1000 }) - 0.25) < 1e-12,
    `实际 ${reusedEdgeRatio({ reusedEdgeMeters: 250, routeMeters: 1000 })}`,
  );
  check('重复比例：routeMeters = 0 → null', reusedEdgeRatio({ reusedEdgeMeters: 100, routeMeters: 0 }) === null);
  check('重复比例：字段缺失 → null', reusedEdgeRatio({ routeMeters: 1000 }) === null);
  check('重复比例：NaN → null', reusedEdgeRatio({ reusedEdgeMeters: Number.NaN, routeMeters: 1000 }) === null);
  check(
    '重复比例：Infinity → null',
    reusedEdgeRatio({ reusedEdgeMeters: 100, routeMeters: Number.POSITIVE_INFINITY }) === null,
  );
  check('重复比例：负复用米数 → null', reusedEdgeRatio({ reusedEdgeMeters: -5, routeMeters: 1000 }) === null);
  check('重复比例：空输入 → null', reusedEdgeRatio(null) === null);
  check('重复比例：非对象输入 → null', reusedEdgeRatio(42) === null);
  check(
    '重复比例：复用米数超过总长 → 夹到 1',
    reusedEdgeRatio({ reusedEdgeMeters: 1500, routeMeters: 1000 }) === 1,
  );
}

// ---------- 9. 原始字段透传（便于日志） ----------
{
  const s = routeReuseSummary({ routeMeters: 1000, reusedEdgeMeters: 250, reusedEdgeCount: 3 });
  check('字段透传：routeMeters 原样透传', s.routeMeters === 1000, `实际 ${s.routeMeters}`);
  check('字段透传：reusedEdgeMeters 原样透传', s.reusedEdgeMeters === 250, `实际 ${s.reusedEdgeMeters}`);
  check('字段透传：reusedEdgeCount 原样透传', s.reusedEdgeCount === 3, `实际 ${s.reusedEdgeCount}`);
  check('字段透传：比例与 reusedEdgeRatio 一致', s.reusedEdgeRatio === 0.25, `实际 ${s.reusedEdgeRatio}`);
  const bad = routeReuseSummary({ routeMeters: Number.POSITIVE_INFINITY, reusedEdgeMeters: 10 });
  check(
    '字段透传：非有限字段按未知（null）透传，不把 Infinity 写进日志',
    bad.routeMeters === null && bad.reusedEdgeMeters === 10 && bad.reusedEdgeRatio === null,
    `实际 ${JSON.stringify(bad)}`,
  );
  const empty = routeReuseSummary(null);
  check(
    '字段透传：空输入返回全 null',
    empty.routeMeters === null && empty.reusedEdgeMeters === null && empty.reusedEdgeRatio === null,
  );
}

// ---------- 10. 汇总入口 ----------
{
  const legs = [
    [P(-200, 0), P(200, 0)],
    [P(-200, 500), P(200, 500)],
    [P(0, -300), P(0, 300)],
    [P(-200, 900), P(200, 900)],
  ];
  const metrics = { routeMeters: 1000, reusedEdgeMeters: 250, reusedEdgeCount: 3 };
  const all = collectRouteTopologyMetrics({ legs, metrics });
  check('汇总入口：交叉数正确', all.crossings.count === 1, `实际 ${all.crossings.count}`);
  check('汇总入口：复用比例正确', all.reuse.reusedEdgeRatio === 0.25, `实际 ${all.reuse.reusedEdgeRatio}`);
  const empty = collectRouteTopologyMetrics();
  check('汇总入口：空输入不崩且交叉为 0', empty.crossings.count === 0 && empty.reuse.reusedEdgeRatio === null);
}

// ---------- 11. 边界输入：空/单点/非法值不产生 NaN、Infinity ----------
{
  check('边界：空数组 → count 0', countUniqueCrossings([]).count === 0);
  check('边界：null → count 0', countUniqueCrossings(null).count === 0);
  check('边界：undefined → count 0', countUniqueCrossings(undefined).count === 0);
  const single = countUniqueCrossings([[P(0, 0)]]);
  check('边界：单点段 → count 0 且 points 为空', single.count === 0 && single.points.length === 0);
  const nanLeg = countUniqueCrossings([
    [[Number.NaN, 0], [1, 1]],
    [[2, 2], [3, 3]],
  ]);
  check(
    '边界：NaN 点被丢弃，交点无 NaN/Infinity',
    nanLeg.count === 0 && nanLeg.points.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])),
    `实际 ${JSON.stringify(nanLeg)}`,
  );
  const junk = countUniqueCrossings([null, undefined, 'x', [[0, 0], [1, 1]]]);
  check(
    '边界：脏腿数组不崩且交点无 NaN/Infinity',
    junk.count === 0 && junk.points.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])),
    `实际 ${JSON.stringify(junk)}`,
  );
  const infLeg = countUniqueCrossings([
    [[Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY], [-Infinity, -Infinity]],
  ]);
  check('边界：全非法点 → count 0', infLeg.count === 0, `实际 ${infLeg.count}`);
}

// ---------- 12. 降采样上界：超大折线集合仍在预算内完成 ----------
{
  // 12 条过原点的直线，每条 3001 点（合计 36012 点，远超总子段数上限）
  const legs = [];
  for (let k = 0; k < 12; k += 1) {
    const line = [];
    const rad = (k * 15 * Math.PI) / 180;
    const dx = Math.cos(rad);
    const dy = Math.sin(rad);
    for (let i = 0; i <= 3000; i += 1) {
      const t = -2000 + (4000 * i) / 3000;
      line.push(P(t * dx, t * dy));
    }
    legs.push(line);
  }
  const started = Date.now();
  const r = countUniqueCrossings(legs);
  const elapsed = Date.now() - started;
  console.log(`  [perf] 12×3001 点（36012 点）统计耗时 ${elapsed}ms`);
  check(
    '降采样上界：超大折线集合降采样后仍算出唯一交点 → count = 1',
    r.count === 1,
    `实际 ${r.count}`,
  );
  check('降采样上界：超大折线集合在 5s 内完成', elapsed < 5000, `实际 ${elapsed}ms`);
  check(
    '降采样上界：超大折线集合交点仍为有限坐标',
    r.points.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])),
    `实际 ${JSON.stringify(r.points)}`,
  );
}

// ---------- 13. 断言非空自检 ----------
check('断言非空：本次运行至少执行 40 条断言', assertions >= 40, `实际 ${assertions}`);

console.log(failures === 0 ? `\nRESULT: PASS（${assertions} 条断言）` : `\nRESULT: FAIL（${failures}/${assertions}）`);
if (failures > 0) {
  process.exitCode = 1;
}
