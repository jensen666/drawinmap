/**
 * 轮廓特征检测（纯函数，Node 可直接测试）：找出决定"像不像"的细节特征——
 * 凹口（动物腿间隙、嘴巴缺口等）与窄间隙（两腿之间、尾巴贴近身体等）。
 *
 * 为什么需要：RDP 约束抽稀只看几何简化误差，容易把腿间隙、耳根这类
 * "窄而深"的特征当成可省略的细节——约束点没有钉在特征上，走廊引导 A*
 * 就会抄近路跨过去，画出来的动物就"简单"了。这里把特征检测出来，
 * 由归一化阶段强制保留为约束、由规划器单独检查是否走出。
 *
 * 尺度约定：所有阈值都是"相对图形包围盒最长边"的归一化比例（0~1），
 * 与 customShape 的 [-0.5, 0.5] 坐标系一致，跨图形/跨尺寸可比。
 *
 * 两类特征的判据（注释里的"为什么"是实测教训，改动前先读）：
 *
 * 1) gap 两端必须与凹口同级凹陷：两端相对凸包的凹深都 ≥ NOTCH_DEPTH_RATIO。
 *    为什么必须同深度：gap 的本质是"两个深凹口之间的窄缝"，凸包边界上的采样
 *    抖动不是特征。反例（实测）：三角形/正五边形经"相邻去重 + 稀疏加密"后，
 *    顶点两侧的采样点相对凸包只有 1e-16 量级的浮点噪声深度，旧实现只要求
 *    depths > 0，于是把顶点两侧误判成"宽 0.116 的窄间隙"；candidates.js 按
 *    150 / 0.116 ≈ 1290m 反推尺寸下限，900/1200 档被跳过，三角形被放大到 3km
 *    级。凸多边形没有凹口，就绝不该产出 gap——没有任何点达到凹口深度时这里
 *    显式不产出 gap。
 *
 * 2) 不再只保留最窄一条 gap：动物的每条腿缝都是决定"像不像"的特征，只留
 *    最窄一条会让"间隙保留率"漏掉其余腿缝（腿间隙被 A* 抄近路也查不出来）。
 *    改为按"两端所属凹口分组 id"去重——同一个凹口区域只留最窄代表，不同凹口
 *    区域/凹口之间的窄缝各留一条；上限 GAP_MAX_COUNT 条，排序确定（先宽度、
 *    再索引），保证同样输入永远得到同样顺序的特征列表。
 *
 * 3) notch 的 widthRatio 是"开口宽度"：凹口分组两端口沿点（凹陷跨过阈值的
 *    两个端点）在重采样轮廓上的直线距离 ÷ 包围盒最长边。旧实现恒为 0，
 *    导致尺寸反推只能靠 gap 驱动、凹口再深再宽也不影响尺寸选择；现在尺寸
 *    反推由 notch 开口宽度 + gap 宽度共同驱动。凸多边形零凹口 → 零 widthRatio>0
 *    的特征 → 不做尺寸反推，保持用户/默认尺寸档。
 *
 * 4) identity（有界身份凹口，方案 5.2）：高密有机轮廓（点数 > 80）上的"浅凹"
 *    ——深度低于深凹口（0.12）但高于采样噪声（0.04），开口宽度落在可走走廊
 *    尺度（[0.06, 0.20]）。RDP 会把人形后背/手臂分界这类浅凹抽成直线，路线
 *    贴外侧直路偏离百余米；identity 把凹底钉成约束、并供规划器收紧该段走廊。
 *    双窗口缺一不可（实测教训）：只限深度会误收猫背/腹部宽缓大弧（开口占
 *    0.21~0.80），只限开口会误收鬃毛/耳根碎齿（开口 0.036~0.050）。深度 ≥ 0.12
 *    的凹段是 notch 的领地，不重复产出；粗多边形（≤80 点）零产出。
 */

import { pointToSegmentDistanceXY } from './geo.js';

/** 重采样点数（与 shape-model 关键点识别同口径） */
const FEATURE_RESAMPLE_COUNT = 128;

/** 凹口判定：凹深度 ≥ 该比例（相对包围盒最长边）才算特征。
 * 0.12 而非更低：实测马轮廓上 0.07~0.10 的浅凹口是鬃毛锯齿/轮廓采样波动，
 * 不是腿间隙（真实腿间隙深度 0.19~0.24）；阈值太低会把噪声当关键特征。
 * 同一阈值同时约束 gap 两端：两端都必须是"跟凹口一样深"的凹陷点，否则
 * 凸多边形顶点附近的浮点噪声就会变成假 gap（见模块头注释第 1 条）。 */
const NOTCH_DEPTH_RATIO = 0.12;

/** 窄间隙判定：非相邻轮廓点距离 ≤ 该比例才算窄（动物腿间隙实测约 0.1~0.2） */
const GAP_WIDTH_RATIO = 0.2;

/** 窄间隙两端之间的弧长 ≥ 该倍数 × 间隙距离（排除相邻点噪声） */
const GAP_ARC_FACTOR = 2.5;

/** 窄间隙两端的最小环距（重采样步数），排除相邻采样点 */
const GAP_MIN_STEPS = 10;

/** 窄间隙数量上限：四条腿的动物最多 3 条腿缝 + 尾/颈等，6 条足够覆盖；
 * 上限只为防御病态轮廓产生几十条候选，不是"只认 6 条腿"的特判。 */
const GAP_MAX_COUNT = 6;

/** identity 触发条件：轮廓点数 > 该值才算高密有机轮廓（SVG 转换轮廓去重后
 * ≥87 点，手绘粗多边形上限 64 点，中间零重叠）；粗多边形零产出。 */
const IDENTITY_MIN_OUTLINE_POINTS = 80;

/** identity 深度下限：对齐 planner 的 FEATURE_COVERED_RATIO(0.04)（路网可分辨
 * 最小特征容差），也高于 8 点最少点列圆的弦拱量化误差 0.038——低于它时凸
 * 多边形重采样与 SVG 曲线量化抖动会出假阳性。 */
const IDENTITY_DEPTH_MIN = 0.04;

/** identity 深度上限（不含）：与 NOTCH_DEPTH_RATIO 同值——达到深凹口深度的
 * 凹段已由 notch 负责，identity 只认浅凹。 */
const IDENTITY_DEPTH_MAX = 0.12;

/** identity 开口宽度下限：对齐最小走廊尺度（CORRIDOR_MIN_METERS 60m ÷ 基准
 * 尺寸 1000~1200m ≈ 0.05~0.06）——实测马鬃毛/耳根碎齿开口 0.036~0.050，全部排除。 */
const IDENTITY_WIDTH_MIN = 0.06;

/** identity 开口宽度上限：与 GAP_WIDTH_RATIO 同尺度——实测猫背(0.211)/鸽(0.360)/
 * 狗(0.384)/人(0.803) 的背部/腹部宽缓大弧全部排除。 */
const IDENTITY_WIDTH_MAX = 0.2;

/** identity 数量上限：连续浅凹留最深代表后，按深度降序最多保留 4 条
 * （人形实测 2 条：前胸手臂弯 + 前腿腹股沟），防御病态轮廓刷屏。 */
const IDENTITY_MAX_COUNT = 4;

/** 连续浅凹的"相邻"判定（重采样步数）：间隔 ≤ 该值的浅凹视为同一弧的抖动
 * 分裂，只留最深代表。128 点重采样下 3 步 ≈ 周长的 2.3%，比任何真实凹口的
 * 口沿间隔都小。 */
const IDENTITY_MERGE_STEPS = 3;

/**
 * 闭环弧长均匀重采样（与 shape-model 共用，避免两份实现漂移）。
 *
 * @param {Array<[number, number]>} loop 原始闭环点列（不重复闭合点）
 * @param {number} count 重采样点数
 * @returns {{points: Array<[number, number]>, sourceIndices: number[]}}
 */
export function resampleClosedLoop(loop, count) {
  const n = loop.length;
  if (n < 3) {
    return { points: loop.slice(), sourceIndices: loop.map((_, i) => i) };
  }
  const cum = [0];
  for (let i = 1; i < n; i += 1) {
    cum.push(cum[i - 1] + Math.hypot(loop[i][0] - loop[i - 1][0], loop[i][1] - loop[i - 1][1]));
  }
  const total = cum[n - 1] + Math.hypot(loop[0][0] - loop[n - 1][0], loop[0][1] - loop[n - 1][1]);
  if (total <= 0) {
    return { points: loop.slice(), sourceIndices: loop.map((_, i) => i) };
  }
  const points = [];
  const segIndices = [];
  let seg = 0;
  for (let k = 0; k < count; k += 1) {
    const target = (total * k) / count;
    while (seg < n - 1 && cum[seg + 1] < target) {
      seg += 1;
    }
    const segLen = (seg === n - 1 ? total : cum[seg + 1]) - cum[seg];
    const t = segLen > 0 ? (target - cum[seg]) / segLen : 0;
    const a = loop[seg];
    const b = loop[(seg + 1) % n];
    points.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    segIndices.push(t < 0.5 ? seg : (seg + 1) % n);
  }
  return { points, sourceIndices: segIndices };
}

/**
 * 凸包索引（Andrew 单调链，按逆时针/顺时针输出）。
 *
 * @param {Array<[number, number]>} points 点列
 * @returns {number[]} 凸包顶点索引
 */
function convexHullIndices(points) {
  const n = points.length;
  if (n < 3) {
    return points.map((_, i) => i);
  }
  const order = points.map((_, i) => i).sort(
    (a, b) => points[a][0] - points[b][0] || points[a][1] - points[b][1],
  );
  const cross = (o, a, b) =>
    (points[a][0] - points[o][0]) * (points[b][1] - points[o][1]) -
    (points[a][1] - points[o][1]) * (points[b][0] - points[o][0]);
  const lower = [];
  for (const i of order) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], i) <= 0) {
      lower.pop();
    }
    lower.push(i);
  }
  const upper = [];
  for (let k = order.length - 1; k >= 0; k -= 1) {
    const i = order[k];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], i) <= 0) {
      upper.pop();
    }
    upper.push(i);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** 点到线段距离（统一走 geo.js 的平面算法） */
function pointToSegmentDistance(p, a, b) {
  return pointToSegmentDistanceXY(p[0], p[1], a[0], a[1], b[0], b[1]);
}

/** 点到凸包边界的距离 */
function pointToHullDistance(point, hull, points) {
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < hull.length; i += 1) {
    const d = pointToSegmentDistance(point, points[hull[i]], points[hull[(i + 1) % hull.length]]);
    if (d < min) {
      min = d;
    }
  }
  return min;
}

/**
 * 把"达到凹口深度"的采样点按闭环顺序分成连续分组。
 *
 * 分组是 gap 判据的骨架：同一个凹口（U 型腿缝的两壁 + 顶部）在轮廓上是
 * 一段连续凹陷，属于同一分组；不同凹口属于不同分组。首尾相接的分组（凹陷
 * 跨过索引 0）合并成一组，保证环状拓扑下不会被切成两段。
 *
 * @param {number[]} depths 每个重采样点的归一化凹深
 * @param {number} [minDepth] 凹深判定下限（缺省 NOTCH_DEPTH_RATIO；identity 用
 *   更低的 IDENTITY_DEPTH_MIN 找浅凹）
 * @returns {number[][]} 分组列表，每组是重采样索引的连续（环形）序列
 */
function groupConcaveIndices(depths, minDepth = NOTCH_DEPTH_RATIO) {
  const count = depths.length;
  const groups = [];
  let current = [];
  for (let i = 0; i < count; i += 1) {
    if (depths[i] < minDepth) {
      continue;
    }
    if (current.length === 0 || i === current[current.length - 1] + 1) {
      current.push(i);
    } else {
      groups.push(current);
      current = [i];
    }
  }
  if (current.length > 0) {
    groups.push(current);
  }
  // 环状：首尾两组在索引 0 / count-1 处相接时合并
  if (
    groups.length > 1 &&
    groups[0][0] === 0 &&
    groups[groups.length - 1][groups[groups.length - 1].length - 1] === count - 1
  ) {
    groups[0] = [...groups[groups.length - 1], ...groups[0]];
    groups.pop();
  }
  return groups;
}

/**
 * 检测轮廓细节特征。
 *
 * 返回三类特征（都带原始轮廓索引，供归一化阶段强制保留为约束）：
 * - notch：凹口——轮廓上连续凹进凸包的区段，取"两侧口沿 + 最深点"；
 *   widthRatio 是两端口沿点的直线距离（开口宽度，相对包围盒最长边）；
 * - gap：窄间隙——两端都达到凹口深度、环距很远而空间距离很近的两点
 *   （腿缝两壁、尾巴贴近身体等）；每个凹口区域只留最窄代表，最多 6 条。
 * - identity：有界身份凹口——仅高密有机轮廓（点数 > 80）上深度与开口都落在
 *   有界窗口内的浅凹，连续浅凹留最深代表，最多 4 条（详见模块头第 4 条）。
 *
 * @param {Array<[number, number]>} outline 闭环点列（不重复闭合点）
 * @returns {Array<{kind: 'notch'|'gap'|'identity', indices: number[], depthRatio: number, widthRatio: number}>}
 *   特征列表；indices 为原始轮廓索引，depthRatio/widthRatio 为相对包围盒最长边的比例
 */
export function detectFeatures(outline) {
  const n = outline.length;
  if (n < 8) {
    return [];
  }
  const { points, sourceIndices } = resampleClosedLoop(outline, FEATURE_RESAMPLE_COUNT);
  const count = points.length;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const scale = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  if (!(scale > 0)) {
    return [];
  }

  const features = [];

  // ---------- 凹口：连续凹进凸包的区段 ----------
  const hull = convexHullIndices(points);
  const hullSet = new Set(hull);
  const depths = points.map((point, i) =>
    hullSet.has(i) ? 0 : pointToHullDistance(point, hull, points) / scale,
  );
  const groups = groupConcaveIndices(depths);
  // 凹口分组 id：gap 去重（同一凹口只留最窄代表）与"两端同深度"判定依赖它
  const groupOfIndex = new Array(count).fill(-1);
  groups.forEach((group, groupId) => {
    for (const index of group) {
      groupOfIndex[index] = groupId;
    }
  });

  for (const group of groups) {
    let deepest = group[0];
    for (const i of group) {
      if (depths[i] > depths[deepest]) {
        deepest = i;
      }
    }
    const mouthStart = points[group[0]];
    const mouthEnd = points[group[group.length - 1]];
    // 开口宽度：凹陷区段跨过阈值的两个口沿点的直线距离（旧实现恒为 0，
    // 尺寸反推因此漏掉凹口信息；现在与 gap 宽度共同驱动尺寸下限）
    const mouthWidthRatio =
      Math.hypot(mouthStart[0] - mouthEnd[0], mouthStart[1] - mouthEnd[1]) / scale;
    const indices = [
      sourceIndices[group[0]],
      sourceIndices[deepest],
      sourceIndices[group[group.length - 1]],
    ];
    // 退化凹口（重采样把同一原始点映射成多个采样点）不构成特征
    if (new Set(indices).size < 2) {
      continue;
    }
    features.push({
      kind: 'notch',
      indices,
      depthRatio: depths[deepest],
      widthRatio: mouthWidthRatio,
    });
  }

  // ---------- 窄间隙：空间很近、沿轮廓很远的两点 ----------
  // 显式处理"没有任何点达到凹口深度 → 不产出 gap"：凸多边形（三角/矩形/
  // 正五边形/近似圆）绝不允许有 gap（见模块头注释第 1 条）。
  if (groups.length > 0) {
    /** 每个"凹口分组对"只保留最窄代表：key 为两端所属分组 id（小的在前） */
    const gapByGroupPair = new Map();
    for (let i = 0; i < count; i += 1) {
      // gap 两端必须与凹口同级深度：只认真正的深凹点，浮点噪声深度不算
      if (depths[i] < NOTCH_DEPTH_RATIO) {
        continue;
      }
      for (let j = i + GAP_MIN_STEPS; j < count; j += 1) {
        if (depths[j] < NOTCH_DEPTH_RATIO) {
          continue;
        }
        const ringDistance = Math.min(j - i, count - (j - i));
        if (ringDistance < GAP_MIN_STEPS) {
          continue;
        }
        const distance =
          Math.hypot(points[i][0] - points[j][0], points[i][1] - points[j][1]) / scale;
        if (distance > GAP_WIDTH_RATIO) {
          continue;
        }
        // 弧长：i → j 沿轮廓的距离（取较长的一侧，避免把相邻点对当间隙）
        let arc = 0;
        for (let k = i; k < j; k += 1) {
          arc += Math.hypot(points[k + 1][0] - points[k][0], points[k + 1][1] - points[k][1]);
        }
        arc /= scale;
        if (arc < distance * GAP_ARC_FACTOR) {
          continue;
        }
        // 退化：两端映射到同一原始顶点时端点没有分离度（规划器会得到 0 弧长
        // → 间隙保留率 0，误杀所有候选），不作为特征。
        if (sourceIndices[i] === sourceIndices[j]) {
          continue;
        }
        const groupI = groupOfIndex[i];
        const groupJ = groupOfIndex[j];
        const pairKey = groupI <= groupJ ? `${groupI}:${groupJ}` : `${groupJ}:${groupI}`;
        const existing = gapByGroupPair.get(pairKey);
        // 同组对只留最窄代表：更宽的同一腿缝不重复计特征
        if (existing && existing.widthRatio <= distance) {
          continue;
        }
        gapByGroupPair.set(pairKey, {
          i,
          j,
          widthRatio: distance,
          depthRatio: Math.min(depths[i], depths[j]),
        });
      }
    }
    // 排序确定：先宽度（最窄的腿缝最该保留），再索引；上限 6 条防止病态轮廓刷屏
    const gaps = [...gapByGroupPair.values()]
      .sort((a, b) => a.widthRatio - b.widthRatio || a.i - b.i || a.j - b.j)
      .slice(0, GAP_MAX_COUNT);
    for (const gap of gaps) {
      features.push({
        kind: 'gap',
        indices: [sourceIndices[gap.i], sourceIndices[gap.j]],
        depthRatio: gap.depthRatio,
        widthRatio: gap.widthRatio,
      });
    }
  }

  // ---------- 有界身份凹口：高密有机轮廓上的浅凹 ----------
  // 与 notch/gap 并列的第三类特征：RDP 会把人形后背/手臂分界这类浅凹抽成直线，
  // 路线贴外侧直路偏离百余米（实测 t-rmbotf3tbn6：脚下 4.8m 有路却偏 112.5m）。
  // 深度/开口双窗口见常量注释；粗多边形（≤80 点）与深凹段零产出。
  if (n > IDENTITY_MIN_OUTLINE_POINTS) {
    const shallowGroups = groupConcaveIndices(depths, IDENTITY_DEPTH_MIN);
    /** 候选浅凹：连续浅凹分组的 {start, end, deepest, depth, width}（重采样索引） */
    const candidates = [];
    for (const group of shallowGroups) {
      let deepest = group[0];
      for (const i of group) {
        if (depths[i] > depths[deepest]) {
          deepest = i;
        }
      }
      const depth = depths[deepest];
      // 深凹口归 notch：identity 只认全程浅的凹段
      if (depth < IDENTITY_DEPTH_MIN || depth >= IDENTITY_DEPTH_MAX) {
        continue;
      }
      const width =
        Math.hypot(
          points[group[0]][0] - points[group[group.length - 1]][0],
          points[group[0]][1] - points[group[group.length - 1]][1],
        ) / scale;
      if (width < IDENTITY_WIDTH_MIN || width > IDENTITY_WIDTH_MAX) {
        continue;
      }
      candidates.push({ start: group[0], end: group[group.length - 1], deepest, depth, width });
    }
    // 连续浅凹留最深代表：按起点排序后，与前一保留项环距很近的候选视为同一
    // 弧的抖动分裂，只留深度更大者（与 gap"同凹口只留代表"同一思想）
    candidates.sort((a, b) => a.start - b.start);
    const kept = [];
    for (const candidate of candidates) {
      const previous = kept[kept.length - 1];
      if (previous) {
        const rawGap = candidate.start - previous.end;
        const gap = rawGap >= 0 ? rawGap : rawGap + count;
        if (gap <= IDENTITY_MERGE_STEPS) {
          if (candidate.depth > previous.depth) {
            kept[kept.length - 1] = candidate;
          }
          continue;
        }
      }
      kept.push(candidate);
    }
    // 按深度降序取最深的前几条（排序确定，同样输入永远得到同样顺序）
    kept.sort((a, b) => b.depth - a.depth || a.start - b.start);
    for (const item of kept.slice(0, IDENTITY_MAX_COUNT)) {
      const indices = [
        sourceIndices[item.start],
        sourceIndices[item.deepest],
        sourceIndices[item.end],
      ];
      // 退化浅凹（重采样把同一原始点映射成多个采样点）不构成特征
      if (new Set(indices).size < 2) {
        continue;
      }
      features.push({
        kind: 'identity',
        indices,
        depthRatio: item.depth,
        widthRatio: item.width,
      });
    }
  }

  return features;
}
