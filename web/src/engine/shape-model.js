/**
 * 通用图形轮廓模型：把内置图形与 AI 自定义图形统一为
 * "有序密轮廓 + 约束点（区分关键点/普通点）+ 约束点到轮廓的索引"。
 *
 * 关键点 = 轮廓上转向角的局部峰值（角点/尖端/缺口），由几何识别，
 * 不依赖图形名称；闭环锚点（首约束）恒为关键点。识别在弧长均匀重采样
 * 的轮廓上进行，LLM 点列采样不均匀也不会误判。
 *
 * 关键约束缺失时从轮廓补入（例如心形 8 采样点没落在两瓣顶点上）。
 * 普通采样点允许吸附后合并（规划器侧按米距判断），关键点不得合并。
 *
 * 每条约束路段（约束 i → 约束 i+1）取得自己的理想引导折线 =
 * 轮廓上两索引之间的切片（曲线段保留曲线，不退化为直线），供
 * 引导寻路、走廊过滤与有序贴合评价共用。
 */

import { SHAPES } from './shapes.js';
import { resampleClosedLoop } from './shape-features.js';

/** 弧长均匀重采样点数（识别在重采样轮廓上进行） */
const RESAMPLE_COUNT = 128;

/** 角点判据：单点转向角局部峰值 ≥ TURN_CORNER_DEG 且占窗口总转角 ≥ SPIKE_DOMINANCE。
 * 阈值取 35°：星形内凹点实测 41~72°（重采样对齐会使同一类角在 41~45 间波动，
 * 45° 会漏掉部分内凹点造成对称特征保护不对称）；矩形角 90°/星形外尖 98~144°/
 * 心形缺口 162°/三角 127° 都在上方；LLM 圆形点列的量化顶角 ~22.5°、量化噪声
 * ~25°（自定义图形最少 16 点，基线 ≤22.5°）在下方仍有余量。
 * 集中度用于排除"分散噪声"（孤立尖峰 vs 邻居也抬升的波动）。 */
const TURN_CORNER_DEG = 35;
const SPIKE_DOMINANCE = 0.45;

/** 平滑弧判据：±TURN_ARC_WINDOW 窗口转向角总和局部峰值 ≥ TURN_ARC_SUM_DEG，
 * 且窗口内无任何尖峰（窗口最大单点角 < TURN_CORNER_DEG）——只认"持续平滑弯曲"，
 * 避免把尖角邻域的高窗口和误判为平滑弧（矩形角旁窗口和=90°的教训）。 */
const TURN_ARC_WINDOW = 3;
const TURN_ARC_SUM_DEG = 70;

/** 重采样轮廓上相邻峰值的合并半径（步），五角星相邻角间隔约 12.8 步 */
const PEAK_MERGE_STEPS = 4;

/** 关键轮廓点与最近约束的索引距离 ≤ 该值时升级该约束为关键，否则补入新约束 */
const KEY_UPGRADE_GAP = 2;

/**
 * 计算重采样闭环每个点的转向角（度，恒为正）。
 *
 * @param {Array<[number, number]>} points 闭环点列
 * @returns {number[]} 每点转向角
 */
function turnAnglesClosed(points) {
  const n = points.length;
  const angles = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const prev = points[(i - 1 + n) % n];
    const cur = points[i];
    const next = points[(i + 1) % n];
    const v1x = cur[0] - prev[0];
    const v1y = cur[1] - prev[1];
    const v2x = next[0] - cur[0];
    const v2y = next[1] - cur[1];
    const dot = v1x * v2x + v1y * v2y;
    const cross = v1x * v2y - v1y * v2x;
    angles[i] = (Math.atan2(Math.abs(cross), dot) * 180) / Math.PI;
  }
  return angles;
}

/** 环形索引距离（最短方向） */
function circularIndexDist(a, b, n) {
  const raw = Math.abs(a - b);
  return Math.min(raw, n - raw);
}

/**
 * 在重采样轮廓上识别关键点，返回原始轮廓索引（有序去重）。
 *
 * 候选 = 角点尖峰 ∪ 平滑高曲率弧极值；角点再做一致性过滤（见判据常量注释）。
 *
 * @param {Array<[number, number]>} outline 原始密轮廓（闭环）
 * @returns {number[]} 关键点的原始轮廓索引
 */
function detectKeyIndices(outline) {
  const { points, sourceIndices } = resampleClosedLoop(outline, RESAMPLE_COUNT);
  const turns = turnAnglesClosed(points);
  const n = turns.length;
  const window = TURN_ARC_WINDOW * 2 + 1;
  const arcSums = turns.map((_, i) => {
    let sum = 0;
    for (let d = -TURN_ARC_WINDOW; d <= TURN_ARC_WINDOW; d += 1) {
      sum += turns[(i + d + n) % n];
    }
    return sum;
  });
  // 峰值强度（合并相邻峰时比较用）：角点用单点角，弧极值用窗口平均
  const strength = (i) => Math.max(turns[i], arcSums[i] / window);

  const cornerCandidates = [];
  const arcCandidates = [];
  for (let i = 0; i < n; i += 1) {
    const leftTurn = turns[(i - 1 + n) % n];
    const rightTurn = turns[(i + 1) % n];
    const isCornerPeak =
      turns[i] >= TURN_CORNER_DEG &&
      turns[i] >= leftTurn &&
      turns[i] >= rightTurn &&
      (turns[i] > leftTurn || turns[i] > rightTurn) &&
      // 集中度：尖峰至少占窗口总转角的 45%（孤立尖峰 vs 分散噪声）
      turns[i] >= arcSums[i] * SPIKE_DOMINANCE;
    // 窗口内最大单点角（平滑弧判据用：窗口含尖峰就不是平滑弧）
    let windowMaxTurn = 0;
    for (let d = -TURN_ARC_WINDOW; d <= TURN_ARC_WINDOW; d += 1) {
      const t = turns[(i + d + n) % n];
      if (t > windowMaxTurn) {
        windowMaxTurn = t;
      }
    }
    const leftArc = arcSums[(i - 1 + n) % n];
    const rightArc = arcSums[(i + 1) % n];
    const isArcPeak =
      arcSums[i] >= TURN_ARC_SUM_DEG &&
      windowMaxTurn < TURN_CORNER_DEG &&
      arcSums[i] >= leftArc &&
      arcSums[i] >= rightArc &&
      (arcSums[i] > leftArc || arcSums[i] > rightArc);
    if (isCornerPeak) {
      cornerCandidates.push(i);
    }
    if (isArcPeak) {
      arcCandidates.push(i);
    }
  }

  const kept = cornerCandidates.concat(arcCandidates);

  // 相邻峰合并（保留强度更高者），避免一个特征被拆成两个关键点
  const merged = [];
  for (const peak of kept) {
    const conflict = merged.find((p) => circularIndexDist(p, peak, n) <= PEAK_MERGE_STEPS);
    if (conflict === undefined) {
      merged.push(peak);
    } else if (strength(peak) > strength(conflict)) {
      merged[merged.indexOf(conflict)] = peak;
    }
  }
  // 闭环锚点恒为关键点
  if (!merged.includes(0)) {
    merged.push(0);
  }
  const keyIndices = [...new Set(merged.map((p) => sourceIndices[p]))].sort((a, b) => a - b);
  return keyIndices;
}

/**
 * 在原始轮廓上找距给定点最近的索引。
 *
 * @param {Array<[number, number]>} outline 轮廓
 * @param {[number, number]} point 点
 * @returns {number} 最近索引
 */
function nearestOutlineIndex(outline, point) {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < outline.length; i += 1) {
    const d = (outline[i][0] - point[0]) ** 2 + (outline[i][1] - point[1]) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/**
 * 把细节特征点（凹口底部/窄间隙两壁）升级为关键约束。
 *
 * 特征点已由归一化阶段强制加入约束（RDP 后补入），这里再把它们标为 key：
 * 普通点允许 <10m 合并、塌缩不单独考核——腿间隙/耳根一旦被当成普通点合并，
 * 图形就"简单"了。升级后由 keyCoverage/keyMaxOffset/collapsedKeyCount 单独考核。
 *
 * @param {Array<{point: [number, number], outlineIndex: number, key: boolean}>} anchors 约束锚点
 * @param {Array<[number, number]>} featurePoints 本部分的特征点（局部坐标）
 * @param {Array<[number, number]>} outline 本部分轮廓
 * @returns {void}
 */
function markFeatureAnchors(anchors, featurePoints, outline) {
  for (const point of featurePoints) {
    const index = nearestOutlineIndex(outline, point);
    let nearest = null;
    let nearestDist = Infinity;
    for (const anchor of anchors) {
      const dist = circularIndexDist(anchor.outlineIndex, index, outline.length);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = anchor;
      }
    }
    if (nearest && nearestDist <= KEY_UPGRADE_GAP) {
      nearest.key = true;
    } else {
      anchors.push({ point: point.slice(), outlineIndex: index, key: true });
    }
  }
}

/**
 * 构建一个部分的锚点列表（单部分图形与多部分图形的每个部分共用同一流程）：
 * 基础约束映射到轮廓索引 → 关键点升级 → 细节特征点升级 → 按轮廓顺序排序 →
 * 闭环首个锚点恒为关键。
 * 此前单部分与多部分各手抄一份同样的流程（B1），两处不同步就会出现
 * "多部分图形关键点处理与单部分不一致"的漂移。
 *
 * @param {Array<[number, number]>} outline 本部分轮廓（局部坐标）
 * @param {Array<[number, number]>} constraints 本部分基础约束点（局部坐标）
 * @param {Array<[number, number]>} featurePoints 本部分细节特征点（局部坐标）
 * @returns {Array<{point: [number, number], outlineIndex: number, key: boolean}>} 已排序锚点（首锚关键）
 */
function buildPartAnchors(outline, constraints, featurePoints) {
  // 基础约束映射到轮廓索引
  const anchors = constraints.map((point) => ({
    point,
    outlineIndex: nearestOutlineIndex(outline, point),
    key: false,
  }));
  // 每个关键轮廓索引：升级离它最近的那一个约束；附近没有约束则从轮廓补入。
  // 只升级"最近的一个"，避免把关键点旁边的普通采样点整批误升为关键。
  for (const keyIndex of detectKeyIndices(outline)) {
    let nearest = null;
    let nearestDist = Infinity;
    for (const anchor of anchors) {
      const dist = circularIndexDist(anchor.outlineIndex, keyIndex, outline.length);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = anchor;
      }
    }
    if (nearest && nearestDist <= KEY_UPGRADE_GAP) {
      nearest.key = true;
    } else {
      anchors.push({ point: outline[keyIndex].slice(), outlineIndex: keyIndex, key: true });
    }
  }
  // 细节特征点（凹口/窄间隙）升级为关键约束：不可合并、单独考核偏移与塌缩
  markFeatureAnchors(anchors, featurePoints, outline);
  anchors.sort((a, b) => a.outlineIndex - b.outlineIndex);
  // 闭环锚点（首个约束）恒为关键
  anchors[0].key = true;
  return anchors;
}

/**
 * 构建通用图形模型（内置与自定义走同一逻辑，不读 shapeKey 做分支判断）。
 *
 * 自定义图形带 parts（分离部分，如群岛）时逐部分独立处理：
 * 每部分是独立闭环，各自做关键点检测与锚点升级，约束按部分顺序拼接并带
 * partIndex——规划器据此安排"逐部分绕行 + 部分间连接腿"的步行序列。
 *
 * @param {object} options
 * @param {string} [options.shapeKey] 内置图形标识
 * @param {{name: string, constraintPoints: Array, outlinePoints: Array,
 *   parts?: Array<{name: string, outlineStart: number, outlineCount: number, constraintStart: number, constraintCount: number}>
 * }} [options.customShape] 自定义图形（优先于 shapeKey）
 * @returns {{
 *   name: string,
 *   outlinePoints: Array<[number, number]>,
 *   constraints: Array<{point: [number, number], outlineIndex: number, key: boolean, partIndex: number}>,
 *   partRanges: Array<{name: string, outlineStart: number, outlineCount: number, constraintStart: number, constraintCount: number}>|null,
 *   keyPointCount: number
 * }} 图形模型
 */
export function buildShapeModel({ shapeKey, customShape = null }) {
  // 多部分自定义图形：逐部分独立建模
  if (customShape?.parts?.length) {
    const constraints = [];
    const partRanges = [];
    let constraintStart = 0; // 模型扁平约束列表里的游标（随补入的关键点增长）
    customShape.parts.forEach((part, partIndex) => {
      const partOutline = customShape.outlinePoints.slice(part.outlineStart, part.outlineStart + part.outlineCount);
      const partConstraints = customShape.constraintPoints.slice(
        part.constraintStart,
        part.constraintStart + part.constraintCount,
      );
      const anchors = buildPartAnchors(
        partOutline,
        partConstraints,
        (customShape.features || [])
          .filter((feature) => (feature.partIndex ?? 0) === partIndex)
          .flatMap((feature) => feature.points),
      );
      for (const anchor of anchors) {
        constraints.push({
          point: anchor.point,
          outlineIndex: part.outlineStart + anchor.outlineIndex,
          key: anchor.key,
          partIndex,
        });
      }
      partRanges.push({
        name: part.name,
        outlineStart: part.outlineStart,
        outlineCount: part.outlineCount,
        constraintStart,
        constraintCount: anchors.length,
      });
      constraintStart += anchors.length;
    });
    return {
      name: customShape.name,
      outlinePoints: customShape.outlinePoints,
      constraints,
      partRanges,
      keyPointCount: constraints.filter((c) => c.key).length,
    };
  }

  const shape = customShape
    ? {
        name: customShape.name,
        build: () => customShape.constraintPoints,
        buildOutline: () => customShape.outlinePoints,
      }
    : SHAPES[shapeKey];
  if (!shape) {
    throw new Error(`未知图形：${shapeKey}`);
  }

  const outline = shape.buildOutline();
  const baseConstraints = shape.build();
  const anchors = buildPartAnchors(
    outline,
    baseConstraints,
    (customShape?.features || []).flatMap((feature) => feature.points),
  );
  const constraints = anchors.map(({ point, outlineIndex, key }) => ({
    point,
    outlineIndex,
    key,
    partIndex: 0,
  }));
  return {
    name: shape.name,
    outlinePoints: outline,
    constraints,
    partRanges: null,
    keyPointCount: constraints.filter((c) => c.key).length,
  };
}

/**
 * 取第 legIndex 条约束路段的理想引导折线（原始轮廓切片，闭合环绕）。
 *
 * @param {Array<[number, number]>} outline 密轮廓
 * @param {number} startIndex 起约束的轮廓索引（含）
 * @param {number} endIndex 末约束的轮廓索引（含）
 * @returns {Array<[number, number]>} 轮廓切片
 */
export function outlineSlice(outline, startIndex, endIndex) {
  const n = outline.length;
  const slice = [outline[startIndex]];
  let i = startIndex;
  while (i !== endIndex) {
    i = (i + 1) % n;
    slice.push(outline[i]);
  }
  return slice;
}
