/**
 * 语料轮廓生成器：固定 seed 的程序化轮廓生成。
 *
 * 全部轮廓都由参数化生成器产出（凸多边形 / 辐射瓣 / 椭圆团 / 凹口块 / 分叉带 /
 * 尖刺体 / 蛇形带 / 梳状栅格 / 多部分簇 / 螺旋带 / 钩形带 / 弧形带），没有任何
 * 手写坐标；生成顺序完全由 seed 决定，同一 seed 必然产出逐点相同的轮廓
 * （可复现、可扩展）。
 *
 * 轮廓一律归一化到 [-0.5, 0.5]（最宽边恰为 1.0），与引擎的局部坐标约定一致：
 * 引擎里 1 个归一化单位 = sizeMeters 米，x 向东、y 向北。
 *
 * 分层标签不在这里给出——标签由 geometry-metrics.mjs 从几何本身测量得到，
 * 因此生成器只负责"造形状"，不负责"贴标签"，避免用生成意图冒充几何属性。
 */

import { createRandom } from './random.mjs';
import { bboxOf, edgeLengthsOf, median, resampleClosed } from './geometry-metrics.mjs';

/**
 * 生成凸多边形轮廓。
 *
 * @param {{seed:number, sides:number, jitter:number}} params 生成参数
 * @returns {{parts: Array}} 分部件轮廓与特征声明
 */
function convexPolygon({ seed, sides, jitter }) {
  const rand = createRandom(seed);
  const phase = rand() * Math.PI * 2;
  const points = [];
  for (let i = 0; i < sides; i += 1) {
    const angle = phase + (Math.PI * 2 * i) / sides;
    const radius = 0.5 * (1 + jitter * (rand() * 2 - 1));
    points.push([Math.cos(angle) * radius, Math.sin(angle) * radius]);
  }
  return { parts: [{ outlinePoints: points, features: [] }] };
}

/**
 * 生成辐射瓣轮廓（瓣间形成凹口）。
 *
 * @param {{seed:number, lobes:number, depth:number, jitter:number}} params 生成参数
 * @returns {{parts: Array}} 分部件轮廓与特征声明
 */
function radialLobes({ seed, lobes, depth, jitter }) {
  const rand = createRandom(seed);
  const phase = rand() * Math.PI * 2;
  const count = Math.max(160, lobes * 32);
  const points = [];
  for (let i = 0; i < count; i += 1) {
    const t = (Math.PI * 2 * i) / count;
    const wave = Math.cos(lobes * t + phase);
    let radius = 0.5 * (1 - depth * 0.5 * (1 + wave));
    radius *= 1 + jitter * Math.cos(lobes * t + phase * 1.7);
    points.push([Math.cos(t) * radius, Math.sin(t) * radius]);
  }
  // 最深的一处凹口声明为 notch 特征（口沿两点 + 最深点）
  let deepest = 0;
  for (let i = 1; i < count; i += 1) {
    if (Math.hypot(points[i][0], points[i][1]) < Math.hypot(points[deepest][0], points[deepest][1])) {
      deepest = i;
    }
  }
  const half = Math.round(count / (2 * lobes));
  const features = [
    {
      kind: 'notch',
      partIndex: 0,
      points: [points[(deepest + half) % count], points[deepest], points[(deepest - half + count) % count]],
    },
  ];
  return { parts: [{ outlinePoints: points, features }] };
}

/**
 * 生成椭圆团轮廓（低频径向扰动）。
 *
 * @param {{seed:number, rx:number, ry:number, harmonics:number, amplitude:number}} params 生成参数
 * @returns {{parts: Array}} 分部件轮廓与特征声明
 */
function ellipseBlob({ seed, rx, ry, harmonics, amplitude }) {
  const rand = createRandom(seed);
  const phases = [];
  const amps = [];
  for (let k = 0; k < harmonics; k += 1) {
    phases.push(rand() * Math.PI * 2);
    amps.push((amplitude / Math.max(1, harmonics)) * (0.6 + rand()));
  }
  const points = [];
  const count = 144;
  for (let i = 0; i < count; i += 1) {
    const t = (Math.PI * 2 * i) / count;
    let radius = 1;
    for (let k = 0; k < harmonics; k += 1) {
      radius += amps[k] * Math.cos((k + 2) * t + phases[k]);
    }
    points.push([Math.cos(t) * rx * radius, Math.sin(t) * ry * radius]);
  }
  return { parts: [{ outlinePoints: points, features: [] }] };
}

/**
 * 生成带凹口的块体轮廓（凹口深度可控）。
 *
 * @param {{seed:number, depth:number, mouthWidth:number}} params 生成参数
 * @returns {{parts: Array}} 分部件轮廓与特征声明
 */
function notchedBlock({ seed, depth, mouthWidth }) {
  const rand = createRandom(seed);
  const half = 0.5;
  const notchX = 0.04 * (rand() * 2 - 1);
  const mouthHalf = mouthWidth / 2;
  const points = [
    [-half, -half],
    [half, -half],
    [half, half],
    [notchX + mouthHalf, half],
    [notchX, half - depth],
    [notchX - mouthHalf, half],
    [-half, half],
  ];
  const features = [
    {
      kind: 'notch',
      partIndex: 0,
      points: [
        [notchX + mouthHalf, half],
        [notchX, half - depth],
        [notchX - mouthHalf, half],
      ],
    },
  ];
  return { parts: [{ outlinePoints: points, features }] };
}

/**
 * 生成带窄缝的分叉带轮廓。
 *
 * @param {{seed:number, gapWidth:number, slotDepth:number}} params 生成参数
 * @returns {{parts: Array}} 分部件轮廓与特征声明
 */
function forkedBand({ seed, gapWidth, slotDepth }) {
  const rand = createRandom(seed);
  const half = 0.5;
  const shift = 0.03 * (rand() * 2 - 1);
  const gapHalf = gapWidth / 2;
  const points = [
    [-half, -half],
    [half, -half],
    [half, half],
    [shift + gapHalf, half],
    [shift + gapHalf, half - slotDepth],
    [shift - gapHalf, half - slotDepth],
    [shift - gapHalf, half],
    [-half, half],
  ];
  const features = [
    {
      kind: 'gap',
      partIndex: 0,
      points: [
        [shift + gapHalf, half - slotDepth],
        [shift - gapHalf, half - slotDepth],
      ],
    },
  ];
  return { parts: [{ outlinePoints: points, features }] };
}

/**
 * 生成带细长凸出的体块轮廓。
 *
 * @param {{seed:number, spikeLength:number, bodyRatio:number}} params 生成参数
 * @returns {{parts: Array}} 分部件轮廓与特征声明
 */
function spikeBody({ seed, spikeLength, bodyRatio }) {
  const rand = createRandom(seed);
  const phase = rand() * 0.4 - 0.2;
  const rx = 0.5;
  const ry = 0.5 * bodyRatio;
  const cy = -0.5 + ry;
  const start = (102 * Math.PI) / 180 + phase;
  const end = (438 * Math.PI) / 180 + phase;
  const arcSteps = 72;
  const points = [];
  for (let i = 0; i <= arcSteps; i += 1) {
    const t = start + ((end - start) * i) / arcSteps;
    points.push([Math.cos(t) * rx, cy + Math.sin(t) * ry]);
  }
  points.push([Math.sin(phase) * 0.04, cy + ry + spikeLength]);
  return { parts: [{ outlinePoints: points, features: [] }] };
}

/**
 * 生成蛇形带轮廓（中心线正弦 + 等厚偏移）。
 *
 * @param {{seed:number, waves:number, amplitude:number, thickness:number, length:number}} params 生成参数
 * @returns {{parts: Array}} 分部件轮廓与特征声明
 */
function serpentineBand({ seed, waves, amplitude, thickness, length }) {
  const rand = createRandom(seed);
  const phase = rand() * Math.PI * 2;
  const count = 120;
  const top = [];
  const bottom = [];
  for (let i = 0; i < count; i += 1) {
    const u = i / (count - 1);
    const x = (u - 0.5) * length;
    const y = amplitude * Math.sin(Math.PI * 2 * waves * u + phase);
    const dx = length;
    const dy = amplitude * Math.PI * 2 * waves * Math.cos(Math.PI * 2 * waves * u + phase);
    const norm = Math.hypot(dx, dy) || 1;
    const nx = -dy / norm;
    const ny = dx / norm;
    top.push([x + (nx * thickness) / 2, y + (ny * thickness) / 2]);
    bottom.push([x - (nx * thickness) / 2, y - (ny * thickness) / 2]);
  }
  return { parts: [{ outlinePoints: top.concat(bottom.reverse()), features: [] }] };
}

/**
 * 生成梳状栅格轮廓（梳齿之间的窄槽）。
 *
 * @param {{seed:number, teeth:number, slotWidth:number, toothDepth:number}} params 生成参数
 * @returns {{parts: Array}} 分部件轮廓与特征声明
 */
function combLattice({ seed, teeth, slotWidth, toothDepth }) {
  const rand = createRandom(seed);
  const half = 0.5;
  const root = half - toothDepth;
  const pitch = 1 / teeth;
  const points = [[-half, -half], [half, -half], [half, root]];
  for (let k = 0; k < teeth; k += 1) {
    const right = half - k * pitch;
    const left = right - (pitch - slotWidth);
    const jitter = 0.01 * (rand() * 2 - 1);
    points.push([right, root]);
    points.push([right + jitter, half]);
    points.push([left + jitter, half]);
    points.push([left, root]);
  }
  points.push([-half, root]);
  return { parts: [{ outlinePoints: points, features: [] }] };
}

/**
 * 生成多部分簇轮廓（若干彼此分离的块体）。
 *
 * @param {{seed:number, partCount:number, spread:number, partSides:number}} params 生成参数
 * @returns {{parts: Array}} 分部件轮廓与特征声明
 */
function clusterParts({ seed, partCount, spread, partSides }) {
  const rand = createRandom(seed);
  const parts = [];
  for (let p = 0; p < partCount; p += 1) {
    const angle = (Math.PI * 2 * p) / partCount + 0.5 * (rand() * 2 - 1);
    const distance = spread * (0.55 + rand() * 0.45);
    const cx = Math.cos(angle) * distance;
    const cy = Math.sin(angle) * distance;
    const radius = 0.13 + rand() * 0.05;
    const phase = rand() * Math.PI * 2;
    const points = [];
    for (let i = 0; i < partSides; i += 1) {
      const t = phase + (Math.PI * 2 * i) / partSides;
      const r = radius * (1 + 0.14 * (rand() * 2 - 1));
      points.push([cx + Math.cos(t) * r, cy + Math.sin(t) * r]);
    }
    parts.push({ outlinePoints: points, features: [] });
  }
  return { parts };
}

/**
 * 生成螺旋带轮廓（周长跨度比极高）。
 *
 * @param {{seed:number, turns:number, thickness:number, rStart:number, rEnd:number}} params 生成参数
 * @returns {{parts: Array}} 分部件轮廓与特征声明
 */
function spiralBand({ seed, turns, thickness, rStart, rEnd }) {
  const rand = createRandom(seed);
  const phase = rand() * Math.PI * 2;
  const count = Math.max(120, Math.round(turns * 72));
  const center = [];
  for (let i = 0; i < count; i += 1) {
    const u = i / (count - 1);
    const angle = phase + u * Math.PI * 2 * turns;
    const r = rStart + (rEnd - rStart) * u;
    center.push([Math.cos(angle) * r, Math.sin(angle) * r]);
  }
  const top = [];
  const bottom = [];
  for (let i = 0; i < count; i += 1) {
    const previous = center[Math.max(0, i - 1)];
    const next = center[Math.min(count - 1, i + 1)];
    const dx = next[0] - previous[0];
    const dy = next[1] - previous[1];
    const norm = Math.hypot(dx, dy) || 1;
    const nx = (-dy / norm) * (thickness / 2);
    const ny = (dx / norm) * (thickness / 2);
    top.push([center[i][0] + nx, center[i][1] + ny]);
    bottom.push([center[i][0] - nx, center[i][1] - ny]);
  }
  return { parts: [{ outlinePoints: top.concat(bottom.reverse()), features: [] }] };
}

/**
 * 生成钩形带轮廓（急转弯 + 收紧的窄缝）。
 *
 * @param {{seed:number, hookRadius:number, thickness:number, stemLength:number}} params 生成参数
 * @returns {{parts: Array}} 分部件轮廓与特征声明
 */
function hookBand({ seed, hookRadius, thickness, stemLength }) {
  const rand = createRandom(seed);
  const phase = rand() * 0.3 - 0.15;
  const center = [[0, 0.5]];
  const stemSteps = 24;
  for (let i = 1; i <= stemSteps; i += 1) {
    center.push([0, 0.5 - (stemLength * i) / stemSteps]);
  }
  const arcCenter = [hookRadius, 0.5 - stemLength];
  const arcSteps = 48;
  for (let i = 1; i <= arcSteps; i += 1) {
    const angle = Math.PI - (Math.PI * i) / arcSteps;
    center.push([arcCenter[0] + Math.cos(angle) * hookRadius, arcCenter[1] + Math.sin(angle) * hookRadius]);
  }
  const tailSteps = 16;
  for (let i = 1; i <= tailSteps; i += 1) {
    center.push([hookRadius * 2, 0.5 - stemLength + (stemLength * 0.55 * i) / tailSteps]);
  }
  const shifted = center.map(([x, y]) => [
    x * Math.cos(phase) - y * Math.sin(phase),
    x * Math.sin(phase) + y * Math.cos(phase),
  ]);
  const top = [];
  const bottom = [];
  for (let i = 0; i < shifted.length; i += 1) {
    const previous = shifted[Math.max(0, i - 1)];
    const next = shifted[Math.min(shifted.length - 1, i + 1)];
    const dx = next[0] - previous[0];
    const dy = next[1] - previous[1];
    const norm = Math.hypot(dx, dy) || 1;
    const nx = (-dy / norm) * (thickness / 2);
    const ny = (dx / norm) * (thickness / 2);
    top.push([shifted[i][0] + nx, shifted[i][1] + ny]);
    bottom.push([shifted[i][0] - nx, shifted[i][1] - ny]);
  }
  return { parts: [{ outlinePoints: top.concat(bottom.reverse()), features: [] }] };
}

/**
 * 生成弧形带轮廓（圆弧中心线 + 等厚偏移）。
 *
 * @param {{seed:number, radius:number, sweep:number, thickness:number}} params 生成参数
 * @returns {{parts: Array}} 分部件轮廓与特征声明
 */
function arcBand({ seed, radius, sweep, thickness }) {
  const rand = createRandom(seed);
  const phase = rand() * Math.PI * 2;
  const count = 110;
  const top = [];
  const bottom = [];
  for (let i = 0; i < count; i += 1) {
    const u = i / (count - 1);
    const angle = phase + (u - 0.5) * sweep;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    const nx = Math.cos(angle);
    const ny = Math.sin(angle);
    top.push([x + (nx * thickness) / 2, y + (ny * thickness) / 2]);
    bottom.push([x - (nx * thickness) / 2, y - (ny * thickness) / 2]);
  }
  return { parts: [{ outlinePoints: top.concat(bottom.reverse()), features: [] }] };
}

/** 可用轮廓原型表 */
const ARCHETYPES = {
  convexPolygon,
  radialLobes,
  ellipseBlob,
  notchedBlock,
  forkedBand,
  spikeBody,
  serpentineBand,
  combLattice,
  clusterParts,
  spiralBand,
  hookBand,
  arcBand,
};

/**
 * 轮廓采样档案：控制点数（点密度）、采样噪声与约束密度。
 *
 * noise 是"噪声幅度 / 中位边长"，与点密度无关，因此不同档案的噪声在几何上同量级。
 */
export const OUTLINE_PROFILES = {
  sparseClean: { pointCount: 18, noise: 0, constraintLevel: 'low' },
  sparseNoisy: { pointCount: 22, noise: 0.07, constraintLevel: 'low' },
  mediumClean: { pointCount: 40, noise: 0, constraintLevel: 'medium' },
  mediumNoisy: { pointCount: 46, noise: 0.07, constraintLevel: 'medium' },
  denseClean: { pointCount: 96, noise: 0, constraintLevel: 'high' },
  denseNoisy: { pointCount: 104, noise: 0.07, constraintLevel: 'high' },
};

/**
 * 语料轮廓族定义。
 *
 * 每个族 = 一个生成原型 + 一组参数变体 + 一个采样档案 + 实例数。
 * 族名只描述结构生成方式（几何），不含任何对象语义。
 */
export const OUTLINE_FAMILIES = [
  {
    id: 'polygon-regular',
    archetype: 'convexPolygon',
    params: { sides: 5, jitter: 0.015 },
    profile: 'mediumClean',
    instances: 8,
  },
  {
    id: 'polygon-regular-dense',
    archetype: 'convexPolygon',
    params: { sides: 8, jitter: 0.02 },
    profile: 'denseClean',
    instances: 8,
  },
  {
    id: 'polygon-irregular',
    archetype: 'convexPolygon',
    params: { sides: 7, jitter: 0.19 },
    profile: 'mediumNoisy',
    instances: 8,
  },
  {
    id: 'polygon-irregular-sparse',
    archetype: 'convexPolygon',
    params: { sides: 9, jitter: 0.24 },
    profile: 'sparseNoisy',
    instances: 7,
  },
  {
    id: 'lobes-regular',
    archetype: 'radialLobes',
    params: { lobes: 6, depth: 0.42, jitter: 0 },
    profile: 'denseClean',
    instances: 8,
  },
  {
    id: 'lobes-shallow',
    archetype: 'radialLobes',
    params: { lobes: 9, depth: 0.2, jitter: 0 },
    profile: 'mediumClean',
    instances: 7,
  },
  {
    id: 'lobes-irregular',
    archetype: 'radialLobes',
    params: { lobes: 5, depth: 0.5, jitter: 0.18 },
    profile: 'denseNoisy',
    instances: 8,
  },
  {
    id: 'blob-smooth',
    archetype: 'ellipseBlob',
    params: { rx: 0.5, ry: 0.32, harmonics: 1, amplitude: 0 },
    profile: 'mediumClean',
    constraintLevel: 'low',
    instances: 7,
  },
  {
    id: 'blob-irregular',
    archetype: 'ellipseBlob',
    params: { rx: 0.5, ry: 0.36, harmonics: 3, amplitude: 0.16 },
    profile: 'denseNoisy',
    instances: 8,
  },
  {
    id: 'notch-shallow',
    archetype: 'notchedBlock',
    params: { depth: 0.09, mouthWidth: 0.3 },
    profile: 'sparseClean',
    instances: 7,
  },
  {
    id: 'notch-deep',
    archetype: 'notchedBlock',
    params: { depth: 0.32, mouthWidth: 0.22 },
    profile: 'mediumClean',
    instances: 8,
  },
  {
    id: 'fork-narrow',
    archetype: 'forkedBand',
    params: { gapWidth: 0.11, slotDepth: 0.62 },
    profile: 'mediumClean',
    instances: 8,
  },
  {
    id: 'spike-body',
    archetype: 'spikeBody',
    params: { spikeLength: 0.6, bodyRatio: 0.7 },
    profile: 'mediumClean',
    instances: 8,
  },
  {
    id: 'serpentine',
    archetype: 'serpentineBand',
    params: { waves: 5, amplitude: 0.16, thickness: 0.09, length: 1 },
    profile: 'denseClean',
    constraintLevel: 'high',
    instances: 8,
  },
  {
    id: 'comb-lattice',
    archetype: 'combLattice',
    params: { teeth: 6, slotWidth: 0.07, toothDepth: 0.3 },
    profile: 'denseClean',
    constraintLevel: 'low',
    instances: 8,
  },
  {
    id: 'cluster-parts',
    archetype: 'clusterParts',
    params: { partCount: 3, spread: 0.34, partSides: 7 },
    profile: 'mediumClean',
    constraintLevel: 'medium',
    instances: 8,
  },
  {
    id: 'cluster-parts-dense',
    archetype: 'clusterParts',
    params: { partCount: 2, spread: 0.3, partSides: 9 },
    profile: 'denseClean',
    instances: 7,
  },
  {
    id: 'spiral-band',
    archetype: 'spiralBand',
    params: { turns: 2.5, thickness: 0.05, rStart: 0.09, rEnd: 0.46 },
    profile: 'denseClean',
    instances: 6,
    reserved: true,
  },
  {
    id: 'hook-band',
    archetype: 'hookBand',
    params: { hookRadius: 0.18, thickness: 0.07, stemLength: 0.45 },
    profile: 'mediumClean',
    instances: 6,
    reserved: true,
  },
  {
    id: 'arc-band-smooth',
    archetype: 'arcBand',
    params: { radius: 0.42, sweep: 2.2, thickness: 0.12 },
    profile: 'mediumClean',
    instances: 8,
  },
  {
    id: 'arc-band-tight',
    archetype: 'arcBand',
    params: { radius: 0.13, sweep: 2.4, thickness: 0.05 },
    profile: 'denseClean',
    instances: 8,
  },
];

/**
 * 在轮廓点列中找到与给定坐标最近的点。
 *
 * @param {[number, number]} target 目标坐标
 * @param {Array<[number, number]>} outline 轮廓点列
 * @returns {[number, number]} 最近的轮廓点
 */
function nearestOutlinePoint(target, outline) {
  let best = outline[0];
  let bestDistance = Infinity;
  for (const point of outline) {
    const distance = Math.hypot(point[0] - target[0], point[1] - target[1]);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = point;
    }
  }
  return [best[0], best[1]];
}

/**
 * 给轮廓加采样噪声（模拟 LLM 点列的抖动）。
 *
 * 噪声幅度按"中位边长"的比例给，而不是绝对值：这样不同点密度的轮廓上，
 * 噪声造成的转向角量级一致（与采样密度无关），噪声才是"采样噪声"而不是形变。
 *
 * @param {Array<[number, number]>} outline 轮廓点列
 * @param {number} ratio 噪声幅度 / 中位边长
 * @param {number} seed 随机种子
 * @returns {Array<[number, number]>} 加噪后的轮廓点列
 */
function applyNoise(outline, ratio, seed) {
  if (!(ratio > 0)) {
    return outline.map(([x, y]) => [x, y]);
  }
  const amplitude = ratio * median(edgeLengthsOf(outline));
  const rand = createRandom(seed ^ 0x9e3779b9);
  return outline.map(([x, y]) => [
    x + (rand() * 2 - 1) * amplitude,
    y + (rand() * 2 - 1) * amplitude,
  ]);
}

/**
 * 在一段索引区间内挑选约束点（等间隔）。
 *
 * @param {number} start 起始索引（含）
 * @param {number} count 索引数量
 * @param {string} level low | medium | high
 * @returns {number[]} 选中的索引（升序）
 */
function chooseConstraintIndices(start, count, level) {
  const ratio = level === 'low' ? 12 : level === 'high' ? 4 : 3;
  const cap = level === 'low' ? 8 : level === 'high' ? 18 : 16;
  const wanted = Math.max(3, Math.min(cap, Math.round(count / ratio)));
  const indices = [];
  for (let k = 0; k < wanted; k += 1) {
    const offset = Math.min(count - 1, Math.round((k * count) / wanted));
    indices.push(start + offset);
  }
  return [...new Set(indices)].sort((a, b) => a - b);
}

/**
 * 生成一条语料轮廓（归一化坐标 + 约束点 + 特征声明）。
 *
 * @param {object} options
 * @param {string} options.archetype 原型名
 * @param {object} options.params 原型参数
 * @param {string} options.profile 采样档案名
 * @param {string} [options.constraintLevel] 约束密度覆盖（low | medium | high）
 * @param {number} options.seed 随机种子
 * @returns {{outlinePoints:Array, constraintPoints:Array, features:Array, parts:Array|null}} 轮廓产物
 */
export function generateOutline({ archetype, params, profile, constraintLevel, seed }) {
  const generator = ARCHETYPES[archetype];
  if (!generator) {
    throw new Error(`未知轮廓原型：${archetype}`);
  }
  const profileConfig = OUTLINE_PROFILES[profile];
  if (!profileConfig) {
    throw new Error(`未知采样档案：${profile}`);
  }
  const base = generator({ ...params, seed });

  // 各部件按点数比例重采样（多部分必须分别重采样，否则部件之间会被直线连起来）
  const baseTotal = base.parts.reduce((sum, part) => sum + part.outlinePoints.length, 0) || 1;
  const outline = [];
  const partRanges = [];
  for (const part of base.parts) {
    const share = Math.max(6, Math.round((part.outlinePoints.length / baseTotal) * profileConfig.pointCount));
    const resampled = resampleClosed(part.outlinePoints, share);
    const outlineStart = outline.length;
    for (const point of resampled) {
      outline.push([point[0], point[1]]);
    }
    partRanges.push({ outlineStart, outlineCount: resampled.length });
  }

  const noisy = applyNoise(outline, profileConfig.noise, seed);

  // 特征点重映射到加噪后的轮廓上（特征点必须落在轮廓上，才能作为关键约束）
  const features = [];
  base.parts.forEach((part, partIndex) => {
    for (const feature of part.features || []) {
      const mapped = feature.points.map((point) => nearestOutlinePoint(point, noisy));
      features.push({ kind: feature.kind, partIndex, points: mapped });
    }
  });

  // 约束点：每个部件分别等间隔挑选（族可覆盖档案里的约束密度）
  const effectiveConstraintLevel = constraintLevel || profileConfig.constraintLevel;
  const constraintIndices = [];
  partRanges.forEach((range, partIndex) => {
    const indices = chooseConstraintIndices(range.outlineStart, range.outlineCount, effectiveConstraintLevel);
    constraintIndices.push(...indices);
    partRanges[partIndex].constraintIndices = indices;
  });

  // 归一化到 [-0.5, 0.5]（最宽边恰为 1.0）
  const bbox = bboxOf(noisy);
  const cx = (bbox.minX + bbox.maxX) / 2;
  const cy = (bbox.minY + bbox.maxY) / 2;
  const half = Math.max(bbox.width, bbox.height) / 2 || 1;
  const map = ([x, y]) => [(x - cx) / half * 0.5, (y - cy) / half * 0.5];
  const outlinePoints = noisy.map(map);
  const constraintPoints = constraintIndices.map((index) => outlinePoints[index]);

  // 特征声明：宽度比例按"相对最宽边"（归一化后最宽边 = 1.0）
  const featureList = features.map((feature) => {
    const points = feature.points.map(map);
    const widthRatio =
      feature.points.length >= 2
        ? Math.hypot(points[0][0] - points[1][0], points[0][1] - points[1][1])
        : 0;
    const mouthRatio =
      feature.kind === 'notch' && points.length >= 3
        ? Math.hypot(points[0][0] - points[2][0], points[0][1] - points[2][1])
        : widthRatio;
    const declared = feature.kind === 'notch' ? mouthRatio : widthRatio;
    return {
      kind: feature.kind,
      partIndex: feature.partIndex,
      points,
      widthRatio: declared,
      depthRatio: feature.kind === 'notch' && points.length >= 3 ? declared : 0,
    };
  });

  // 多部分时给出引擎需要的 parts 描述
  let parts = null;
  if (partRanges.length > 1) {
    let constraintStart = 0;
    parts = partRanges.map((range, partIndex) => {
      const count = range.constraintIndices.length;
      const entry = {
        name: `part${partIndex}`,
        outlineStart: range.outlineStart,
        outlineCount: range.outlineCount,
        constraintStart,
        constraintCount: count,
      };
      constraintStart += count;
      return entry;
    });
  }

  return {
    outlinePoints,
    constraintPoints,
    features: featureList,
    parts,
  };
}
