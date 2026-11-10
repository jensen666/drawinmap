/**
 * 离散 Fréchet 度量的采样不变性与顺序敏感性测试（Node 直接运行，无路网/无网络）。
 *
 * 背景（26 号报告问题 3）：人/牛/马的"只死在 Fréchet"其实是采样伪影——
 * 目标段只有 2 个顶点（长直边两端的约束点切片），离散 Fréchet 只按顶点配对，
 * 1500m 直边段上任何走到中段的路线到两个端点都≈750m，被误判成 20.7% 折返。
 *
 * 修复：orderedFidelity 计算前对目标段与路线按 ~1% 尺寸稠密重采样
 * （fidelity.densifyPolyline），15% 门槛保持不变。本测试证明：
 * 1) 重采样正确（端点/几何不变、间距受限、点数有界）；
 * 2) 同一几何的稀疏/稠密目标得到一致结果（采样不变性），且稀疏 2 点目标的
 *    伪影可被复现、被修复消除；
 * 3) 真正的顺序错乱（去而复返）、明显绕行、U 形被抄近路仍被 15% 门槛拦截
 *    ——修复不是变相放宽门槛；
 * 4) 有序分段聚合（多段取最大）正确。
 *
 * 运行：node test/fidelity-frechet.mjs
 */
import {
  densifyPolyline,
  discreteFrechetMeters,
  orderedFidelity,
} from '../web/src/engine/fidelity.js';
import { QUALITY_FRECHET_MAX_RATIO } from '../web/src/engine/quality.js';

let failures = 0;

/** 断言工具 */
function check(label, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) {
    failures += 1;
  }
  console.log(`[check] ${label} -> ${ok ? 'PASS' : `FAIL ${detail}`}`);
}

const LAT0 = 23.12;
const LNG0 = 113.32;
const M_PER_DEG_LAT = 111320;
const M_PER_DEG_LNG = M_PER_DEG_LAT * Math.cos((LAT0 * Math.PI) / 180);
const latOf = (northMeters) => LAT0 + northMeters / M_PER_DEG_LAT;
const lngOf = (eastMeters) => LNG0 + eastMeters / M_PER_DEG_LNG;
const point = (east, north) => [latOf(north), lngOf(east)];

/** 两点间米制距离（与 fidelity 同口径） */
function meters(a, b) {
  return Math.hypot((b[0] - a[0]) * M_PER_DEG_LAT, (b[1] - a[1]) * M_PER_DEG_LNG);
}

/** 折线最大相邻间距 */
function maxGap(points) {
  let max = 0;
  for (let i = 1; i < points.length; i += 1) {
    max = Math.max(max, meters(points[i - 1], points[i]));
  }
  return max;
}

// ---------- 1. 重采样正确性 ----------
{
  const sparse = [point(0, 0), point(900, 0)];
  const dense12 = densifyPolyline(sparse, 1200); // 步长 = 12m
  check('重采样：2 点 900m 直线，size1200 得到 ≥70 点', dense12.length >= 70, `实际 ${dense12.length}`);
  check(
    '重采样：端点保持不变',
    dense12[0][0] === sparse[0][0] && dense12[0][1] === sparse[0][1] &&
      dense12[dense12.length - 1][0] === sparse[1][0] &&
      dense12[dense12.length - 1][1] === sparse[1][1],
  );
  check('重采样：相邻间距 ≤ 步长 12m', maxGap(dense12) <= 12.01, `实际 ${maxGap(dense12).toFixed(2)}m`);
  const dense36 = densifyPolyline(sparse, 3600); // 步长 = 36m
  check('重采样：size3600 步长 36m 生效', maxGap(dense36) <= 36.01, `实际 ${maxGap(dense36).toFixed(2)}m`);
  const multi = densifyPolyline([point(0, 0), point(900, 0), point(900, 600)], 1200);
  check(
    '重采样：多段折线端点与几何保持（首尾命中）',
    multi.length > 100 &&
      meters(multi[0], point(0, 0)) < 1e-6 &&
      meters(multi[multi.length - 1], point(900, 600)) < 1e-6,
    `点数 ${multi.length}`,
  );
  // 超长多段折线：总点数封顶 400，端点保持
  const many = [];
  for (let k = 0; k <= 40; k += 1) {
    many.push(point(k * 1000, k % 2 === 0 ? 0 : 800));
  }
  const capped = densifyPolyline(many, 3600);
  check('重采样：超长折线总点数封顶 400 且端点保持', capped.length <= 400 && capped.length > 100, `实际 ${capped.length}`);
}

// ---------- 2. 采样不变性：稀疏 2 点目标伪影被消除 ----------
{
  // 目标：900m 向东直线；路线：每 20m 一个点、南北 ±8m 轻微锯齿（贴线正常行走）
  const targetSparse = [point(0, 0), point(900, 0)];
  const route = [];
  for (let x = 0; x <= 900; x += 20) {
    route.push(point(x, x % 40 === 0 ? 0 : 8));
  }
  const sizeMeters = 1200;
  const ordered = orderedFidelity({ legTargets: [targetSparse], legRoutes: [route], sizeMeters });
  const oldValue = discreteFrechetMeters(targetSparse, route);
  const manualDense = discreteFrechetMeters(densifyPolyline(targetSparse, sizeMeters), densifyPolyline(route, sizeMeters));
  console.log(
    `  [fr] 稀疏目标伪影 ${Math.round(oldValue)}m (${(oldValue / sizeMeters * 100).toFixed(1)}%) → ` +
      `修复后 ${Math.round(ordered.frechetMaxMeters)}m (${(ordered.frechetMaxRatio * 100).toFixed(1)}%)`,
  );
  check(
    '采样伪影：2 点目标会虚高（旧口径 > 30% 尺寸）',
    oldValue / sizeMeters > 0.3,
    `旧口径 ${(oldValue / sizeMeters * 100).toFixed(1)}%`,
  );
  check(
    '采样伪影：修复后同一路线远低于 15% 门槛',
    ordered.frechetMaxRatio < QUALITY_FRECHET_MAX_RATIO / 2,
    `修复后 ${(ordered.frechetMaxRatio * 100).toFixed(1)}%`,
  );
  check(
    '采样不变性：orderedFidelity 与手工稠密重采样结果一致',
    Math.abs(ordered.frechetMaxMeters - manualDense) < 1e-6,
    `ordered=${ordered.frechetMaxMeters.toFixed(3)} manual=${manualDense.toFixed(3)}`,
  );
  // 继续加密到 1m 步长：结果不应明显变化（收敛性）
  let ultraDense = [];
  for (let x = 0; x <= 900; x += 1) {
    ultraDense.push(point(x, x % 40 === 0 ? 0 : 8));
  }
  const ultraTarget = densifyPolyline(targetSparse, 100); // 步长 5m
  const ultraValue = discreteFrechetMeters(ultraTarget, ultraDense);
  check(
    '采样不变性：1% 尺寸步长与 5m 超密步长结果接近（<5m 差异）',
    Math.abs(ordered.frechetMaxMeters - ultraValue) < 5,
    `1%=${ordered.frechetMaxMeters.toFixed(1)}m, 5m=${ultraValue.toFixed(1)}m`,
  );
}

// ---------- 3. 顺序敏感性：真正的折返 / 绕行 / U 形抄近路仍被拦截 ----------
{
  const sizeMeters = 900;
  const straight = [point(0, 0), point(900, 0)];
  // 3.1 去而复返：0 → 450 → 0 → 900（沿同一直线来回）
  const backForth = [];
  for (let x = 0; x <= 450; x += 10) backForth.push(point(x, 0));
  for (let x = 450; x >= 0; x -= 10) backForth.push(point(x, 0));
  for (let x = 0; x <= 900; x += 10) backForth.push(point(x, 0));
  const backForthRatio = discreteFrechetMeters(
    densifyPolyline(straight, sizeMeters),
    densifyPolyline(backForth, sizeMeters),
  ) / sizeMeters;
  console.log(`  [fr] 去而复返 900m 目标：${(backForthRatio * 100).toFixed(1)}%`);
  check(
    '顺序敏感：去而复返仍超过 15% 门槛（不是变相放宽）',
    backForthRatio > QUALITY_FRECHET_MAX_RATIO,
    `实际 ${(backForthRatio * 100).toFixed(1)}%`,
  );
  // 3.2 垂直绕行 400m
  const detour = [point(0, 0), point(450, 400), point(900, 0)];
  const detourRatio = discreteFrechetMeters(
    densifyPolyline(straight, sizeMeters),
    densifyPolyline(detour, sizeMeters),
  ) / sizeMeters;
  console.log(`  [fr] 垂直绕行 400m：${(detourRatio * 100).toFixed(1)}%`);
  check('绕行敏感：400m/900m 绕行仍超过门槛', detourRatio > 0.4, `实际 ${(detourRatio * 100).toFixed(1)}%`);
  // 3.3 U 形目标被直线抄近路：U 深 300m、宽 200m
  const uTarget = [point(0, 0), point(0, -300), point(200, -300), point(200, 0)];
  const shortcut = [point(0, 0), point(200, 0)];
  const uRatio = discreteFrechetMeters(
    densifyPolyline(uTarget, sizeMeters),
    densifyPolyline(shortcut, sizeMeters),
  ) / sizeMeters;
  console.log(`  [fr] U 形深度 300m 被直线抄近路：${(uRatio * 100).toFixed(1)}%`);
  check('U 形敏感：抄近路跨过 300m 深凹口仍超过门槛', uRatio > 0.3, `实际 ${(uRatio * 100).toFixed(1)}%`);
}

// ---------- 4. 多段聚合：取最大段 ----------
{
  const sizeMeters = 900;
  const legTargets = [
    [point(0, 0), point(300, 0)],
    [point(0, 200), point(0, -100), point(200, -100), point(200, 200)],
  ];
  const legRoutes = [
    [point(0, 0), point(300, 0)],
    [point(0, 200), point(200, 200)], // 抄近路跨过 U 形
  ];
  const result = orderedFidelity({ legTargets, legRoutes, sizeMeters });
  check('多段聚合：frechetMaxMeters 取各段最大', result.frechetMaxMeters > 250, `实际 ${Math.round(result.frechetMaxMeters)}m`);
  check(
    '多段聚合：frechetMaxRatio 为最大段 ÷ 尺寸',
    Math.abs(result.frechetMaxRatio - result.frechetMaxMeters / sizeMeters) < 1e-9,
  );
}

// ---------- 5. 边界输入 ----------
{
  check('重采样：非法输入原样返回（不足 2 点）', densifyPolyline([point(0, 0)], 1200).length === 1);
  check('重采样：null 不崩', densifyPolyline(null, 1200) === null);
  check('重采样：尺寸非法时用步长下限 5m', maxGap(densifyPolyline([point(0, 0), point(20, 0)], Number.NaN)) <= 5.01);
}

// ---------- 6. 相对偏差样本：默认不收集；打开后方差能区分贴线和甩开 ----------
{
  const sizeMeters = 1000;
  const target = [point(0, 0), point(400, 0)];
  const onLine = [point(0, 0), point(200, 0), point(400, 0)];
  const bulge = [point(0, 0), point(200, 200), point(400, 0)];
  const quiet = orderedFidelity({ legTargets: [target], legRoutes: [onLine], sizeMeters });
  const sampled = orderedFidelity({
    legTargets: [target],
    legRoutes: [bulge],
    sizeMeters,
    collectOutlineRatios: true,
  });
  check('默认不附带相对偏差样本', quiet.orderedOutlineRatios === undefined && quiet.orderedRouteRatios === undefined);
  check('打开后两侧样本都在', Array.isArray(sampled.orderedOutlineRatios) && sampled.orderedRouteRatios.length === bulge.length);
  const ratios = sampled.orderedRouteRatios;
  const mean = ratios.reduce((sum, value) => sum + value, 0) / ratios.length;
  const variance = ratios.reduce((sum, value) => sum + (value - mean) ** 2, 0) / ratios.length;
  check('贴线样本方差为 0', orderedFidelity({
    legTargets: [target],
    legRoutes: [onLine],
    sizeMeters,
    collectOutlineRatios: true,
  }).orderedRouteRatios.every((value) => value < 1e-9));
  check('甩开的路线方差大于 0，且均值等于路线平均相对偏差', variance > 0 && Math.abs(mean - sampled.orderedRouteMeanRatio) < 1e-9, `方差 ${variance}`);
  const rms = Math.sqrt(mean * mean + variance);
  check(
    '均方根等于 √(均值²+方差)',
    Math.abs(sampled.orderedRouteRms - rms) < 1e-9,
    `rms ${sampled.orderedRouteRms} 期望 ${rms}`,
  );
  check('贴线的均方根接近 0', orderedFidelity({
    legTargets: [target],
    legRoutes: [onLine],
    sizeMeters,
  }).orderedRouteRms < 1e-9);
}

console.log(failures === 0 ? '\nRESULT: PASS' : `\nRESULT: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 2);
