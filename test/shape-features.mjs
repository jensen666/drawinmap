/**
 * 轮廓特征检测、约束保护与尺寸反推测试（Node 直接运行，不依赖浏览器与网络）。
 *
 * 背景：只按整体贴合评分时，简单轮廓容易得高分、细节被 RDP 抽稀或 A* 抄近路
 * 跨过，画出来的动物就"简单"了。本轮引入：
 * - detectFeatures：凹口（腿间隙等）/窄间隙检测；
 * - normalizeCustomShape：特征点强制成为约束；
 * - planner：特征单独检查是否走出（featureCoverage）；
 * - candidates：按特征宽度反推尺寸下限，跳过路网表达不了的尺寸档。
 *
 * 本轮（gap 判据修复）新增覆盖：
 * - gap 两端必须与凹口同级深度：凸多边形（三角/矩形/正五边形/近似圆）零 gap。
 *   旧症：三角形经"去重+加密"后顶点两侧的浮点噪声点被当成"宽 0.116 的窄间隙"，
 *   candidates.js 按 150/0.116 ≈ 1290m 反推尺寸下限，900/1200 档被跳过，三角形
 *   被放大到 3km 级；现在零特征 → 不做尺寸反推。
 * - gap 不再只留最窄一条：三腿双腿缝剪影应同时保留两条 U 型腿缝（位置不同）。
 * - notch 的 widthRatio 是开口宽度（旧实现恒为 0），尺寸反推由 notch + gap 共同驱动。
 *
 * 运行：node test/shape-features.mjs（node 不在 PATH 时用 dsh 运行时自带 node）
 */

import { detectFeatures } from '../web/src/engine/shape-features.js';
import { normalizeCustomShape } from '../web/src/agent/intent.js';
import { buildWalkGraph, findLargestComponent, buildEdgeIndex } from '../web/src/engine/graph.js';
import { planShapeRoute } from '../web/src/engine/planner.js';
import { searchBestCandidate, MIN_FEATURE_METERS } from '../web/src/engine/candidates.js';

let failures = 0;

/** 断言工具 */
function check(label, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) {
    failures += 1;
  }
  console.log(`[check] ${label} -> ${ok ? 'PASS' : `FAIL ${detail}`}`);
}

/** 正多边形（首点在正上方，覆盖三角形/五边形/近似圆等凸形状） */
function regularPolygon(vertexCount, radius = 0.5) {
  const points = [];
  for (let i = 0; i < vertexCount; i += 1) {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / vertexCount;
    points.push([Math.cos(angle) * radius, Math.sin(angle) * radius]);
  }
  return points;
}

/** gap 特征中点（取两个原始轮廓索引点的均值，用于判断腿缝位置） */
function gapMidpoints(features, outline) {
  return features
    .filter((feature) => feature.kind === 'gap')
    .map((feature) => {
      const a = outline[feature.indices[0]];
      const b = outline[feature.indices[1]];
      return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    });
}

/** 点集最大两两距离（证明多条腿缝分布在不同位置） */
function maxPairwiseDistance(points) {
  let max = 0;
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      max = Math.max(max, Math.hypot(points[i][0] - points[j][0], points[i][1] - points[j][1]));
    }
  }
  return max;
}

/** 带两个腿间隙的剪影：矩形底部伸出两条腿，腿间是凹口 */
const LEGGED_SHAPE = [
  [-0.5, 0.4],
  [0.5, 0.4],
  [0.5, -0.2],
  [0.2, -0.2],
  [0.2, -0.45],
  [0.1, -0.45],
  [0.1, -0.2],
  [-0.1, -0.2],
  [-0.1, -0.45],
  [-0.2, -0.45],
  [-0.2, -0.2],
  [-0.5, -0.2],
];

/** 报告里的三角形（旧症复现输入：顶点浮点噪声曾被误判出宽 0.116 的窄间隙） */
const REPORT_TRIANGLE = [
  [0, 0.5],
  [-0.45, -0.35],
  [0.45, -0.35],
];

/**
 * 梳状剪影：矩形主体 + 底部 teethCount 条腿，腿间是 teethCount-1 条 U 型腿缝。
 * 齿多时候选 gap 对会超过 6 条，用于验证数量上限与顺序确定性。
 */
function combShape(teethCount, teethWidth = 0.06, notchWidth = 0.1, toothDepth = 0.4) {
  const top = 0.4;
  const bottom = -0.05;
  const toothBottom = bottom - toothDepth;
  const used = teethCount * teethWidth + (teethCount - 1) * notchWidth;
  const flank = (1 - used) / 2;
  const points = [[-0.5, top], [0.5, top], [0.5, bottom]];
  let x = 0.5 - flank;
  for (let i = 0; i < teethCount; i += 1) {
    points.push([x, bottom], [x, toothBottom], [x - teethWidth, toothBottom], [x - teethWidth, bottom]);
    x -= teethWidth;
    if (i < teethCount - 1) {
      points.push([x - notchWidth, bottom]);
      x -= notchWidth;
    }
  }
  points.push([-0.5, bottom]);
  return points;
}

/** 双通道剪影：矩形主体 + 底部 3 条腿，腿间形成 2 条 U 型腿缝（宽 0.12、深 0.4） */
const DOUBLE_SLOT_SHAPE = [
  [-0.5, 0.4],
  [0.5, 0.4],
  [0.5, -0.05],
  [0.27, -0.05],
  [0.27, -0.45],
  [0.17, -0.45],
  [0.17, -0.05],
  [0.05, -0.05],
  [0.05, -0.45],
  [-0.05, -0.45],
  [-0.05, -0.05],
  [-0.17, -0.05],
  [-0.17, -0.45],
  [-0.27, -0.45],
  [-0.27, -0.05],
  [-0.5, -0.05],
];

// ---------- 1. 特征检测 ----------
{
  const features = detectFeatures(LEGGED_SHAPE);
  const notches = features.filter((feature) => feature.kind === 'notch');
  const gaps = features.filter((feature) => feature.kind === 'gap');
  console.log(`  [detect] notch=${notches.length} gap=${gaps.length}`, JSON.stringify(features));
  check('带腿间隙剪影：检测到凹口', notches.length >= 1, `notch=${notches.length}`);
  check('带腿间隙剪影：凹口深度 > 0', notches.every((feature) => feature.depthRatio > 0));
  check('带腿间隙剪影：检测到窄间隙', gaps.length >= 1, `gap=${gaps.length}`);
  check(
    '带腿间隙剪影：窄间隙宽度在合理范围',
    gaps.every((feature) => feature.widthRatio > 0.01 && feature.widthRatio <= 0.2),
  );
  // 新增：gap 两端必须与凹口同级深度（depthRatio 记两端较小值）
  check(
    '带腿间隙剪影：gap 两端凹深均达到凹口深度',
    gaps.every((feature) => feature.depthRatio >= 0.12),
    JSON.stringify(gaps.map((feature) => feature.depthRatio)),
  );
  // 新增：凹口 widthRatio 是开口宽度（旧实现恒为 0 → 尺寸反推漏掉凹口）
  check(
    '带腿间隙剪影：凹口开口宽度 > 0 且在合理范围',
    notches.every((feature) => feature.widthRatio > 0 && feature.widthRatio <= 0.3),
    JSON.stringify(notches.map((feature) => feature.widthRatio)),
  );
}

{
  // 凸多边形没有凹口 → 绝不该有 gap（gap 是"深凹口之间的窄缝"）。
  // 矩形对边距离远、三角/五边形顶点仅浮点噪声，均不得命中。
  const convexShapes = [
    ['矩形', [[-0.4, -0.4], [0.4, -0.4], [0.4, 0.4], [-0.4, 0.4]]],
    ['正五边形', regularPolygon(5)],
    ['正16边形圆', regularPolygon(16)],
  ];
  const square = convexShapes[0][1];
  const squareFeatures = detectFeatures(square);
  check('矩形：无凹口特征', squareFeatures.filter((f) => f.kind === 'notch').length === 0,
    JSON.stringify(squareFeatures));
  for (const [name, points] of convexShapes) {
    const features = detectFeatures(points);
    const gaps = features.filter((feature) => feature.kind === 'gap');
    check(`${name}：无窄间隙特征`, gaps.length === 0, JSON.stringify(gaps));
    // 归一化链路（去重+加密后）同样不能冒出假 gap——旧症就发生在这条链路上
    const shape = normalizeCustomShape({ name, points });
    check(
      `${name}：归一化后零特征`,
      shape !== null && shape.features.length === 0,
      shape ? JSON.stringify(shape.features) : 'null',
    );
  }
}

{
  // 报告复现：三角形旧实现会得到 gap（widthRatio 0.116），导致尺寸反推到 1290m
  const features = detectFeatures(REPORT_TRIANGLE);
  const notches = features.filter((feature) => feature.kind === 'notch');
  const gaps = features.filter((feature) => feature.kind === 'gap');
  console.log(`  [triangle] notch=${notches.length} gap=${gaps.length}`, JSON.stringify(features));
  check('报告三角形：detectFeatures 零凹口', notches.length === 0, JSON.stringify(notches));
  check('报告三角形：detectFeatures 零窄间隙', gaps.length === 0, JSON.stringify(gaps));
  const shape = normalizeCustomShape({ name: '三角形', points: REPORT_TRIANGLE });
  check(
    '报告三角形：归一化后零特征（不再把顶点噪声当宽 0.116 的窄间隙）',
    shape !== null && shape.features.length === 0,
    shape ? JSON.stringify(shape.features) : 'null',
  );
}

{
  // 多腿缝保留：旧实现只留最窄一条 gap，这条剪影的两条 U 型腿缝会全部丢失
  const features = detectFeatures(DOUBLE_SLOT_SHAPE);
  const notches = features.filter((feature) => feature.kind === 'notch');
  const gaps = features.filter((feature) => feature.kind === 'gap');
  const midpoints = gapMidpoints(features, DOUBLE_SLOT_SHAPE);
  console.log(
    `  [double-slot] notch=${notches.length} gap=${gaps.length} midpoints=${JSON.stringify(
      midpoints.map((point) => point.map((value) => +value.toFixed(3))),
    )}`,
  );
  console.log(`  [double-slot] features=${JSON.stringify(features)}`);
  check('双缝剪影：检测到两条凹口（两条 U 型腿缝）', notches.length >= 2, `notch=${notches.length}`);
  check('双缝剪影：保留多条腿缝（不再只留最窄一条）', gaps.length >= 2, `gap=${gaps.length}`);
  check(
    '双缝剪影：两条腿缝位置不同（中点相距足够远）',
    midpoints.length >= 2 && maxPairwiseDistance(midpoints) >= 0.3,
    `spread=${maxPairwiseDistance(midpoints).toFixed(4)}`,
  );
  check(
    '双缝剪影：左右两条腿缝都保留',
    midpoints.some((point) => point[0] < -0.05) && midpoints.some((point) => point[0] > 0.05),
    JSON.stringify(midpoints),
  );
  check(
    '双缝剪影：gap 两端凹深均达到凹口深度',
    gaps.every((feature) => feature.depthRatio >= 0.12),
    JSON.stringify(gaps.map((feature) => feature.depthRatio)),
  );
  check(
    '双缝剪影：gap 宽度在合理范围',
    gaps.every((feature) => feature.widthRatio > 0.01 && feature.widthRatio <= 0.2),
    JSON.stringify(gaps.map((feature) => feature.widthRatio)),
  );
}

{
  // 多腿缝 + 上限：5 条腿 = 4 条 U 型腿缝，候选 gap 对超过 6 条 → 验证上限与确定性
  const comb = combShape(5);
  const first = detectFeatures(comb);
  const second = detectFeatures(comb);
  const gaps = first.filter((feature) => feature.kind === 'gap');
  const notches = first.filter((feature) => feature.kind === 'notch');
  console.log(
    `  [comb] notch=${notches.length} gap=${gaps.length} widths=${JSON.stringify(
      gaps.map((feature) => +feature.widthRatio.toFixed(4)),
    )}`,
  );
  check('多腿缝剪影：检测到多条凹口', notches.length >= 3, `notch=${notches.length}`);
  check('多腿缝剪影：保留多条腿缝（≥3 条）', gaps.length >= 3, `gap=${gaps.length}`);
  check('多腿缝剪影：保留数量受上限保护（≤6 条）', gaps.length <= 6, `gap=${gaps.length}`);
  check(
    '多腿缝剪影：特征顺序确定（同输入重复检测结果一致）',
    JSON.stringify(first) === JSON.stringify(second),
  );
}

{
  // 退化输入：点列过短 / 空 / 所有点重合 → 返回空特征而不是崩溃
  check('退化输入：点数 < 8 返回空特征', detectFeatures([[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5]]).length === 0);
  check('退化输入：空点列返回空特征', detectFeatures([]).length === 0);
  check(
    '退化输入：所有点重合返回空特征',
    detectFeatures(Array.from({ length: 12 }, () => [0, 0])).length === 0,
  );
}

// ---------- 2. 归一化：特征点强制成为约束 ----------
{
  const shape = normalizeCustomShape({ name: '腿形', points: LEGGED_SHAPE });
  check('归一化：带腿间隙图形被接受', shape !== null);
  if (shape) {
    check('归一化：输出特征列表', Array.isArray(shape.features) && shape.features.length >= 1);
    const featurePoints = shape.features.flatMap((feature) => feature.points);
    const constraintHasFeature = featurePoints.every((point) =>
      shape.constraintPoints.some(
        (candidate) => Math.hypot(candidate[0] - point[0], candidate[1] - point[1]) < 1e-6,
      ),
    );
    check('归一化：特征点全部进入约束（不会被 RDP 抽掉）', constraintHasFeature);
    check(
      '归一化：特征带 partIndex',
      shape.features.every((feature) => Number.isInteger(feature.partIndex)),
    );
  }
}

// ---------- 3. 合成路网：特征覆盖指标 ----------
/** 水平路网：21 个节点、间距约 50m */
const LAT0 = 23.12;
const LNG0 = 113.32;
const coords = [];
const refs = [];
for (let i = 0; i <= 20; i += 1) {
  coords.push([LNG0 + i * 0.0005, LAT0]);
  refs.push(i + 1);
}
const graph = buildWalkGraph([{ id: 1, h: 'residential', n: 'test', c: coords, r: refs }]);
const mainComponent = findLargestComponent(graph);
const edgeIndex = buildEdgeIndex(graph, 0.005, mainComponent);
const center = { lat: LAT0, lng: LNG0 + 0.005 };

{
  // 用原始比例图形 + 较小尺寸：腿伸出量 < 吸附硬门槛，能在水平路网上正常规划
  const shape = normalizeCustomShape({ name: '腿形', points: LEGGED_SHAPE });
  const result = planShapeRoute({ graph, edgeIndex, customShape: shape, center, sizeMeters: 200, rotationDeg: 0 });
  const m = result.metrics;
  console.log(
    `  [plan] featureCount=${m.featureCount} covered=${m.featureCoveredCount} ` +
      `coverage=${m.featureCoverage} maxRatio=${m.featureMaxOffsetRatio?.toFixed(3)} minWidth=${m.featureMinWidthRatio}`,
  );
  check('规划：特征计数 > 0', m.featureCount > 0, `featureCount=${m.featureCount}`);
  check(
    '规划：特征覆盖率在 [0,1]',
    Number.isFinite(m.featureCoverage) && m.featureCoverage >= 0 && m.featureCoverage <= 1,
  );
  check('规划：特征最小宽度 > 0（尺寸反推依据）', m.featureMinWidthRatio > 0);
}

// ---------- 3.5 LLM 声明的鲜明特征（"先分析特征再描点"） ----------
{
  const declared = [
    { name: '顶边', points: [[-0.3, 0.4]] },
    { name: '腿间隙', points: [[0.15, -0.2]] },
  ];
  const shape = normalizeCustomShape({ name: '腿形', points: LEGGED_SHAPE, features: declared });
  check('声明特征：被解析为 declared', shape !== null && shape.features.some((f) => f.kind === 'declared'));
  check('声明特征：名称保留', Boolean(shape && shape.features.some((f) => f.name === '顶边')));
  if (shape) {
    const declaredPoints = shape.features.filter((f) => f.kind === 'declared').flatMap((f) => f.points);
    check(
      '声明特征：点进入约束（不会被抽稀掉）',
      declaredPoints.length >= 2 &&
        declaredPoints.every((point) =>
          shape.constraintPoints.some(
            (candidate) => Math.hypot(candidate[0] - point[0], candidate[1] - point[1]) < 1e-6,
          ),
        ),
    );
    const result = planShapeRoute({
      graph, edgeIndex, customShape: shape, center, sizeMeters: 200, rotationDeg: 0,
    });
    check(
      '声明特征：参与特征计数与覆盖检查',
      result.metrics.featureCount >= 2 && Number.isFinite(result.metrics.featureCoverage),
    );
  }
}

// ---------- 4. 尺寸反推：低于最小可表达尺寸的档位被跳过 ----------
{
  const shape = normalizeCustomShape({ name: '腿形', points: LEGGED_SHAPE });
  const seenSizes = new Set();
  await searchBestCandidate({
    graph,
    edgeIndex,
    customShape: shape,
    center,
    baseSizeMeters: 1200,
    sizeFactors: [1.5, 1, 0.75],
    gridRadius: 0,
    onProgress: (p) => seenSizes.add(p.sizeMeters),
  });
  const sizes = [...seenSizes].sort((a, b) => a - b);
  const minWidth = shape.features.reduce(
    (min, f) => (f.widthRatio > 0 && f.widthRatio < min ? f.widthRatio : min),
    Number.POSITIVE_INFINITY,
  );
  // 反推下限用代码里真实的常量（旧测试写死过时的 260，与 MIN_FEATURE_METERS 漂移）
  const required = MIN_FEATURE_METERS / minWidth;
  console.log(`  [sizes] 实际搜索尺寸 ${JSON.stringify(sizes)} / 反推下限 ${required.toFixed(0)}m`);
  // 全部档位都低于下限时走"最大档兜底"（只搜一个尺寸），否则每个实际尺寸都应 ≥ 下限
  const fallbackOnly = sizes.length === 1;
  check(
    '尺寸反推：实际搜索尺寸不低于反推下限（或全部低于时用最大档兜底）',
    fallbackOnly || sizes.every((value) => value >= required),
    JSON.stringify(sizes),
  );
}

// ---------- 5. 有界身份凹口（identity）窗口（方案 5.2 / 第 6 节冻结边界） ----------
{
  /**
   * 密采样闭环：沿多边形路径按 ~0.008 等距采样（>80 点触发 identity 检测）。
   * @param {Array<[number, number]>} loop 闭环顶点（不重复闭合点）
   */
  function densifyLoop(loop, spacing = 0.008) {
    const out = [];
    const n = loop.length;
    for (let i = 0; i < n; i += 1) {
      const [x1, y1] = loop[i];
      const [x2, y2] = loop[(i + 1) % n];
      const len = Math.hypot(x2 - x1, y2 - y1);
      const steps = Math.max(1, Math.round(len / spacing));
      for (let k = 0; k < steps; k += 1) {
        out.push([x1 + ((x2 - x1) * k) / steps, y1 + ((y2 - y1) * k) / steps]);
      }
    }
    return out;
  }

  /** 矩形 + 顶边中部一段浅凹（抛物线凹陷：中心深 depth，两端口沿相距 width） */
  function rectWithDip({ depth, halfWidth }) {
    const loop = [
      [-0.5, -0.5],
      [0.5, -0.5],
      [0.5, 0.5],
    ];
    // 顶边从右往左，中段下凹
    const topRight = [0.5 - (0.5 - halfWidth), 0.5];
    const topLeft = [-0.5 + (0.5 - halfWidth), 0.5];
    loop.push(topRight);
    for (let k = 1; k < 24; k += 1) {
      const t = k / 24;
      const x = topRight[0] + (topLeft[0] - topRight[0]) * t;
      // 抛物线：端口 0、中心 depth
      const y = 0.5 - depth * 4 * t * (1 - t);
      loop.push([x, y]);
    }
    loop.push(topLeft);
    loop.push([-0.5, 0.5]);
    return densifyLoop(loop);
  }

  // 5a. 高密凸形（近似圆，>80 点）：零 notch、零 gap、零 identity
  {
    const circle = densifyLoop(
      Array.from({ length: 12 }, (_, i) => {
        const angle = (Math.PI * 2 * i) / 12;
        return [Math.cos(angle) * 0.5, Math.sin(angle) * 0.5];
      }),
    );
    const features = detectFeatures(circle);
    check(
      'identity：高密凸形（近似圆）零特征',
      features.length === 0,
      JSON.stringify(features.map((f) => f.kind)),
    );
  }

  // 5b. 宽缓大弧：0.04 阈值穿越宽度 ≈ 0.578 × 口宽，口宽 0.5 → 穿越 ≈ 0.29 > 0.20
  // （猫背/腹部宽浅弧不得误检）
  {
    const features = detectFeatures(rectWithDip({ depth: 0.06, halfWidth: 0.25 }));
    check(
      'identity：宽缓大弧（穿越开口 ≈ 0.29）不产出 identity',
      features.filter((f) => f.kind === 'identity').length === 0,
      JSON.stringify(features.map((f) => `${f.kind}:${f.widthRatio?.toFixed?.(3)}`)),
    );
  }

  // 5c. 细碎毛刺：口宽 0.03 → 穿越 ≈ 0.021 < 0.06（马鬃毛/耳根碎齿不得误检）
  {
    const features = detectFeatures(rectWithDip({ depth: 0.08, halfWidth: 0.015 }));
    check(
      'identity：细碎毛刺（穿越开口 ≈ 0.02）不产出 identity',
      features.filter((f) => f.kind === 'identity').length === 0,
      JSON.stringify(features.map((f) => `${f.kind}:${f.widthRatio?.toFixed?.(3)}`)),
    );
  }

  // 5d. 有界浅凹：口宽 0.16、深 0.08 → 穿越开口 ≈ 0.113 ∈ [0.06, 0.20]：恰好 1 条
  {
    const features = detectFeatures(rectWithDip({ depth: 0.08, halfWidth: 0.08 }));
    const identities = features.filter((f) => f.kind === 'identity');
    check('identity：有界浅凹产出 1 条 identity', identities.length === 1, `实际 ${identities.length}`);
    if (identities.length === 1) {
      check(
        'identity：深度/开口落在 [0.04,0.12) × [0.06,0.20]',
        identities[0].depthRatio >= 0.04 &&
          identities[0].depthRatio < 0.12 &&
          identities[0].widthRatio >= 0.06 &&
          identities[0].widthRatio <= 0.2,
        `depth=${identities[0].depthRatio?.toFixed?.(3)} width=${identities[0].widthRatio?.toFixed?.(3)}`,
      );
      check('identity：indices 为 [口沿, 凹底, 口沿] 三点', identities[0].indices.length === 3);
    }
  }

  // 5e. 深凹口（深度 ≥ 0.12）是 notch 的领地：不产出 identity
  {
    const features = detectFeatures(rectWithDip({ depth: 0.18, halfWidth: 0.08 }));
    const kinds = features.map((f) => f.kind);
    check(
      'identity：深凹口归 notch、不产出 identity',
      kinds.includes('notch') && !kinds.includes('identity'),
      JSON.stringify(kinds),
    );
  }

  // 5f. 连续浅凹留最深代表：两条宽 0.15 的浅凹（深 0.10 / 0.11）共享口沿、
  // 中间无墙（阈值穿越点沿轮廓间隔 ≈ 2.5 步 ≤ 3），合并后只留更深的一条
  {
    const loop = [
      [-0.5, -0.5],
      [0.5, -0.5],
      [0.5, 0.5],
    ];
    const dip = (fromX, toX, depth) => {
      const steps = 24;
      for (let k = 0; k <= steps; k += 1) {
        const t = k / steps;
        const x = fromX + (toX - fromX) * t;
        loop.push([x, 0.5 - depth * 4 * t * (1 - t)]);
      }
    };
    loop.push([0.2, 0.5]);
    dip(0.2, 0.05, 0.1); // 浅的一段（深 0.10）
    dip(0.05, -0.1, 0.11); // 深的一段（共享口沿点，无墙）
    loop.push([-0.5, 0.5]);
    const features = detectFeatures(densifyLoop(loop));
    const identities = features.filter((f) => f.kind === 'identity');
    check('identity：连续浅凹只留最深代表（1 条）', identities.length === 1, `实际 ${identities.length}`);
    if (identities.length === 1) {
      check(
        'identity：保留的是更深的一段（深度 ≈ 0.11）',
        Math.abs(identities[0].depthRatio - 0.11) < 0.02,
        `实际 ${identities[0].depthRatio?.toFixed?.(3)}`,
      );
    }
  }

  // 5g. 粗多边形（≤80 点）零产出：三角/五边形/手绘点列不触发 identity
  {
    const triangle = normalizeCustomShape({
      name: '三角形',
      points: [[0, 0.5], [-0.45, -0.35], [0.45, -0.35]],
    });
    const pentagon = normalizeCustomShape({
      name: '五边形',
      points: Array.from({ length: 5 }, (_, i) => {
        const angle = -Math.PI / 2 + (Math.PI * 2 * i) / 5;
        return [Math.cos(angle) * 0.5, Math.sin(angle) * 0.5];
      }),
    });
    const coarse = normalizeCustomShape({ name: '粗轮廓', points: LEGGED_SHAPE });
    const kindsOf = (shape) => (shape?.features || []).map((f) => f.kind);
    check(
      'identity：粗多边形（三角/五边形/腿形）零 identity',
      [triangle, pentagon, coarse].every(
        (shape) => shape !== null && !kindsOf(shape).includes('identity'),
      ),
      JSON.stringify([triangle, pentagon, coarse].map(kindsOf)),
    );
  }
}

process.exit(failures === 0 ? 0 : 2);
