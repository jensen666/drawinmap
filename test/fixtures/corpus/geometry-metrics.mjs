/**
 * 语料轮廓的几何测量与分层判定。
 *
 * 语料分层必须落在"几何属性"上，而不是生成意图、图形名称或对象语义上：
 * 因此这里全部指标都从轮廓点列本身算出来（直线/曲线主导、规则/不规则、
 * 凹口深浅、窄缝、细长凸出、曲率高低、周长跨度比、采样噪声、局部尺度），
 * 同一批点无论由谁生成、叫什么名字，分层结论都一致。
 *
 * 所有量都按"包围盒对角线"归一化，因此与图形的绝对尺寸（米）无关。
 */

/** 角点判定阈值（度）：转向角超过该值视为角点（与引擎 shape-model 同量级） */
const CORNER_TURN_DEG = 20;

/** 直线主导判定：角点转角占全部转角的比例阈值 */
const STRAIGHT_TURN_SHARE = 0.5;

/** 规则判定：最佳 k 重旋转对称的径向残差上限 */
const SYMMETRY_RESIDUAL_MAX = 0.1;

/** 凹口深度分档（相对包围盒对角线） */
const NOTCH_DEPTH_SHALLOW = 0.05;
const NOTCH_DEPTH_DEEP = 0.16;

/** 窄缝判定：沿轮廓相距较远而空间较近的边界点对距离上限 */
const GAP_WIDTH_NARROW = 0.15;

/** 细长凸出判定：极端点半径 / 极端点局部宽度（越大越尖细） */
const PROTRUSION_TIP_SHARPNESS = 5;

/** 细长凸出判定：极端点半径 / 中位半径 */
const PROTRUSION_RADIUS_RATIO = 1.25;

/** 细尖子结构判定：径向伸出量 / 局部宽度 */
const PROTRUSION_EXTENSION_RATIO = 2.5;

/** 局部尺度分档：子结构尺度 / 整体尺度的上限 */
const LOCAL_SCALE_FINE = 0.2;

/** 高曲率判定：窗口化曲率半径的 20 分位（相对对角线） */
const CURVATURE_RADIUS_HIGH = 0.1;

/** 周长跨度比分档：周长 / 包围盒对角线 */
const PERIMETER_SPAN_HIGH = 3.6;

/** 采样噪声判定：转向符号交替的小角顶点占弧长比例 */
const NOISE_ARC_SHARE = 0.06;

/** 转向角数值噪声阈值（度）：低于该值视为共线，不参与噪声统计 */
const TURN_EPSILON_DEG = 0.2;

/** 曲率统计的转向角阈值（度）：低于该值不计入转角和 */
const CURVATURE_TURN_EPSILON_DEG = 0.5;

/** 角点邻域判定：与该角点相距不超过该步数的顶点不参与噪声统计 */
const CORNER_NEIGHBORHOOD_STEPS = 2;

/** 噪声转向角上限（度）：超过该值按形变处理，不算采样噪声 */
const NOISE_TURN_MAX_DEG = 30;

/** 极端点局部宽度的取样弧长（周长比例） */
const TIP_WIDTH_ARC_SHARE = 0.06;

/** 局部尺度分档：曲率半径 p90 / p10 */
const LOCAL_SCALE_RATIO_VARIED = 2.5;

/**
 * 计算点列包围盒。
 *
 * @param {Array<[number, number]>} points 点列
 * @returns {{minX:number,minY:number,maxX:number,maxY:number,width:number,height:number,diagonal:number,center:[number,number]}} 包围盒
 */
export function bboxOf(points) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const width = maxX - minX;
  const height = maxY - minY;
  return {
    minX,
    minY,
    maxX,
    maxY,
    width,
    height,
    diagonal: Math.hypot(width, height),
    center: [(minX + maxX) / 2, (minY + maxY) / 2],
  };
}

/**
 * 闭合折线周长。
 *
 * @param {Array<[number, number]>} points 点列
 * @returns {number} 周长
 */
export function polygonPerimeter(points) {
  let total = 0;
  for (let i = 0; i < points.length; i += 1) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    total += Math.hypot(x2 - x1, y2 - y1);
  }
  return total;
}

/**
 * 各边长度。
 *
 * @param {Array<[number, number]>} points 点列
 * @returns {number[]} 边长数组（边 i = points[i] → points[i+1]）
 */
export function edgeLengthsOf(points) {
  const lengths = [];
  for (let i = 0; i < points.length; i += 1) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    lengths.push(Math.hypot(x2 - x1, y2 - y1));
  }
  return lengths;
}

/**
 * 各顶点转向角（度，带符号；逆时针为正）。
 *
 * @param {Array<[number, number]>} points 闭合点列
 * @returns {number[]} 每个顶点的带符号转向角
 */
export function signedTurnAngles(points) {
  const n = points.length;
  const turns = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const [px, py] = points[(i - 1 + n) % n];
    const [cx, cy] = points[i];
    const [nx, ny] = points[(i + 1) % n];
    const v1x = cx - px;
    const v1y = cy - py;
    const v2x = nx - cx;
    const v2y = ny - cy;
    const dot = v1x * v2x + v1y * v2y;
    const cross = v1x * v2y - v1y * v2x;
    turns[i] = (Math.atan2(cross, dot) * 180) / Math.PI;
  }
  return turns;
}

/**
 * 凸包（Andrew monotone chain），返回逆时针顶点序列。
 *
 * @param {Array<[number, number]>} points 点列
 * @returns {Array<[number, number]>} 凸包顶点
 */
export function convexHull(points) {
  const sorted = [...points].sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  if (sorted.length < 3) {
    return sorted;
  }
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
      lower.pop();
    }
    lower.push(point);
  }
  const upper = [];
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const point = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
      upper.pop();
    }
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * 点到线段的最短距离。
 *
 * @param {[number, number]} point 待检点
 * @param {[number, number]} a 线段起点
 * @param {[number, number]} b 线段终点
 * @returns {number} 距离
 */
export function distancePointToSegment(point, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  let t = lengthSquared === 0 ? 0 : ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(point[0] - (a[0] + dx * t), point[1] - (a[1] + dy * t));
}

/**
 * 点到闭合折线的最短距离（点到各边取最小）。
 *
 * @param {[number, number]} point 待检点
 * @param {Array<[number, number]>} polyline 闭合折线
 * @returns {number} 距离
 */
export function distancePointToPolygon(point, polyline) {
  let best = Infinity;
  for (let i = 0; i < polyline.length; i += 1) {
    const d = distancePointToSegment(point, polyline[i], polyline[(i + 1) % polyline.length]);
    if (d < best) {
      best = d;
    }
  }
  return best;
}

/**
 * 从 origin 沿 direction 方向射线与闭合多边形的最远交点距离（外轮廓半径）。
 *
 * @param {Array<[number, number]>} points 闭合多边形
 * @param {[number, number]} origin 射线起点
 * @param {number} angle 方向角（弧度）
 * @returns {number} 最远交点距离（无交点返回 0）
 */
export function rayRadius(points, origin, angle) {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  let best = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const denominator = dx * ey - dy * ex;
    if (Math.abs(denominator) < 1e-12) {
      continue;
    }
    const qx = a[0] - origin[0];
    const qy = a[1] - origin[1];
    const t = (qx * ey - qy * ex) / denominator;
    const s = (qx * dy - qy * dx) / denominator;
    if (t >= 0 && s >= 0 && s <= 1) {
      if (t > best) {
        best = t;
      }
    }
  }
  return best;
}

/**
 * 按弧长均匀重采样闭合折线。
 *
 * @param {Array<[number, number]>} points 闭合点列
 * @param {number} count 目标点数
 * @returns {Array<[number, number]>} 重采样点列
 */
export function resampleClosed(points, count) {
  const n = points.length;
  if (n === 0 || count <= 2) {
    return points.slice();
  }
  const cumulative = [0];
  for (let i = 1; i <= n; i += 1) {
    const [x1, y1] = points[i - 1];
    const [x2, y2] = points[i % n];
    cumulative.push(cumulative[i - 1] + Math.hypot(x2 - x1, y2 - y1));
  }
  const total = cumulative[n];
  if (total <= 0) {
    return points.slice();
  }
  const out = [];
  let segment = 0;
  for (let k = 0; k < count; k += 1) {
    const target = (total * k) / count;
    while (segment < n - 1 && cumulative[segment + 1] < target) {
      segment += 1;
    }
    const span = cumulative[segment + 1] - cumulative[segment];
    const t = span > 0 ? (target - cumulative[segment]) / span : 0;
    const [x1, y1] = points[segment];
    const [x2, y2] = points[(segment + 1) % n];
    out.push([x1 + (x2 - x1) * t, y1 + (y2 - y1) * t]);
  }
  return out;
}

/**
 * 百分位（输入需已排序）。
 *
 * @param {number[]} values 已排序的数值数组
 * @param {number} p 百分位（0~1）
 * @returns {number} 百分位数值（空数组返回 0）
 */
export function percentile(values, p) {
  if (values.length === 0) {
    return 0;
  }
  const index = Math.min(values.length - 1, Math.max(0, Math.round(p * (values.length - 1))));
  return values[index];
}

/**
 * 中位数。
 *
 * @param {number[]} values 数值数组
 * @returns {number} 中位数
 */
export function median(values) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return percentile(sorted, 0.5);
}

/**
 * 窗口化曲率半径：每个顶点取 ±window 个相邻顶点累计弧长 / 累计转角。
 *
 * 用窗口而不是单条边，是为了避免"同一拐角被采样成多个短边"时半径被低估
 * （细分的正多边形每个拐角边长很短，单边算法会误判成高曲率）。
 *
 * @param {Array<[number, number]>} points 闭合点列
 * @param {number[]} turns 带符号转向角（度）
 * @param {number[]} lengths 边长数组
 * @returns {number[]} 每个顶点的曲率半径（无转角处为 Infinity）
 */
export function windowedCurvatureRadii(points, turns, lengths) {
  const n = points.length;
  const window = Math.max(2, Math.round(n / 40));
  const radii = new Array(n);
  for (let i = 0; i < n; i += 1) {
    let arc = 0;
    let turn = 0;
    for (let d = -window; d <= window; d += 1) {
      const index = (i + d + n * 2) % n;
      arc += lengths[(index - 1 + n) % n];
      // 数值噪声（共线点）不计入转角，否则会伪造出巨大的曲率半径
      const magnitude = Math.abs(turns[index]);
      if (magnitude >= CURVATURE_TURN_EPSILON_DEG) {
        turn += magnitude;
      }
    }
    const turnRad = (turn * Math.PI) / 180;
    radii[i] = turnRad > 1e-9 ? arc / turnRad : Number.POSITIVE_INFINITY;
  }
  return radii;
}

/**
 * 轻度平滑（中心移动平均）：用于在测对称性时滤掉采样抖动。
 *
 * @param {Array<[number, number]>} points 闭合点列
 * @param {number} [window] 平滑窗口（奇数）
 * @returns {Array<[number, number]>} 平滑后的点列
 */
export function smoothOutline(points, window = 3) {
  const n = points.length;
  const half = Math.max(1, Math.floor(window / 2));
  const out = new Array(n);
  for (let i = 0; i < n; i += 1) {
    let sx = 0;
    let sy = 0;
    for (let d = -half; d <= half; d += 1) {
      const [x, y] = points[(i + d + n * 2) % n];
      sx += x;
      sy += y;
    }
    out[i] = [sx / (half * 2 + 1), sy / (half * 2 + 1)];
  }
  return out;
}

/**
 * 窄缝宽度：沿轮廓相距较远、空间却较近的边界点对的最小距离（相对对角线）。
 *
 * 用"弧长相距 18%~45%"限定点对，避免把同一段轮廓上的相邻点当成窄缝。
 *
 * @param {Array<[number, number]>} points 闭合点列
 * @param {number} diagonal 包围盒对角线
 * @returns {number} 窄缝宽度比例（无候选点对返回 1）
 */
export function narrowGapRatio(points, diagonal) {
  const count = 160;
  const sampled = resampleClosed(points, count);
  const minStep = Math.round(count * 0.18);
  const maxStep = Math.round(count * 0.45);
  let best = Infinity;
  for (let i = 0; i < count; i += 1) {
    for (let step = minStep; step <= maxStep; step += 1) {
      const j = (i + step) % count;
      const d = Math.hypot(sampled[i][0] - sampled[j][0], sampled[i][1] - sampled[j][1]);
      if (d < best) {
        best = d;
      }
    }
  }
  if (!Number.isFinite(best) || diagonal <= 0) {
    return 1;
  }
  return best / diagonal;
}

/**
 * 极端点处的局部宽度：沿轮廓向两侧各走固定弧长，再量两点间距。
 *
 * 用弧长而不是固定点数，保证不同点密度下量到的是同一几何尺度。
 *
 * @param {Array<[number, number]>} points 闭合点列
 * @param {number[]} lengths 边长数组
 * @param {number} perimeter 周长
 * @param {number} extreme 极端点索引
 * @returns {number} 局部宽度
 */
export function tipWidthAt(points, lengths, perimeter, extreme) {
  const n = points.length;
  const target = perimeter * TIP_WIDTH_ARC_SHARE;
  const walk = (direction) => {
    let accumulated = 0;
    let index = extreme;
    while (accumulated < target) {
      index = (index + direction + n) % n;
      accumulated += lengths[(index - direction + n) % n];
      if (accumulated > target * 3) {
        break;
      }
    }
    return index;
  };
  const forward = walk(1);
  const backward = walk(-1);
  return Math.hypot(
    points[forward][0] - points[backward][0],
    points[forward][1] - points[backward][1],
  );
}

/**
 * 最佳 k 重旋转对称残差（径向轮廓自相关）。
 *
 * @param {Array<[number, number]>} points 闭合点列
 * @param {[number, number]} origin 参考中心（包围盒中心）
 * @returns {number} 残差（0 表示完全对称）
 */
export function symmetryResidual(points, origin) {
  const count = 72;
  const profile = new Array(count);
  for (let i = 0; i < count; i += 1) {
    profile[i] = rayRadius(points, origin, (Math.PI * 2 * i) / count);
  }
  const mean = profile.reduce((sum, value) => sum + value, 0) / count;
  if (!(mean > 1e-9)) {
    return 1;
  }
  let best = Infinity;
  for (const k of [2, 3, 4, 5, 6, 8, 12]) {
    const shift = Math.round(count / k);
    if (shift < 1) {
      continue;
    }
    let sum = 0;
    for (let i = 0; i < count; i += 1) {
      const diff = profile[i] - profile[(i + shift) % count];
      sum += diff * diff;
    }
    const residual = Math.sqrt(sum / count) / mean;
    if (residual < best) {
      best = residual;
    }
  }
  return Number.isFinite(best) ? best : 1;
}

/**
 * 测量一条轮廓的全部几何属性并给出几何分层标签。
 *
 * @param {Array<[number, number]>} points 归一化后的闭合轮廓点列
 * @returns {object} 几何测量结果（含 measured 数值与 tags 分层标签）
 */
export function measureGeometry(points) {
  const bbox = bboxOf(points);
  const diagonal = bbox.diagonal > 1e-9 ? bbox.diagonal : 1e-9;
  const perimeter = polygonPerimeter(points);
  const lengths = edgeLengthsOf(points);
  const turns = signedTurnAngles(points);

  // 直线/曲线主导：角点转角占全部转角的比例
  let cornerTurn = 0;
  let totalTurn = 0;
  for (const turn of turns) {
    const magnitude = Math.abs(turn);
    totalTurn += magnitude;
    if (magnitude >= CORNER_TURN_DEG) {
      cornerTurn += magnitude;
    }
  }
  const cornerTurnShare = totalTurn > 1e-9 ? cornerTurn / totalTurn : 0;

  // 规则/不规则：最佳旋转对称残差（在轻度平滑后的轮廓上量，滤掉采样抖动）
  const symmetry = symmetryResidual(smoothOutline(points, 3), bbox.center);

  // 凹口深度：顶点相对凸包的最大内陷
  const hull = convexHull(points);
  let maxInward = 0;
  for (const point of points) {
    const d = distancePointToPolygon(point, hull);
    if (d > maxInward) {
      maxInward = d;
    }
  }
  const notchDepthRatio = maxInward / diagonal;

  // 窄缝
  const gapWidthRatio = narrowGapRatio(points, diagonal);

  // 细长凸出：极端点处的局部宽度（尖细程度）+ 极端半径相对中位半径的拉伸比
  const radii = points.map(([x, y]) => Math.hypot(x - bbox.center[0], y - bbox.center[1]));
  const maxRadius = Math.max(...radii);
  const medianRadius = Math.max(1e-9, median(radii));
  let extreme = 0;
  for (let i = 1; i < points.length; i += 1) {
    if (radii[i] > radii[extreme]) {
      extreme = i;
    }
  }
  // 极端点局部宽度：沿轮廓向两侧各走 6% 周长，再量两点间距
  const tipWidthMeters = tipWidthAt(points, lengths, perimeter, extreme);
  const tipWidth = tipWidthMeters / diagonal;
  const protrusionRatio = maxRadius / medianRadius;
  // 尖细程度：极端半径 / 极端点局部宽度
  const tipSharpness = maxRadius / Math.max(1e-9, tipWidthMeters);
  // 径向伸出量与局部宽度之比：钝角（普通多边形顶点）远小于 1，尖刺远大于 1
  const extensionRatio = (maxRadius - medianRadius) / Math.max(1e-9, tipWidthMeters);

  // 曲率与局部尺度
  const curvatureRadii = windowedCurvatureRadii(points, turns, lengths)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const curvatureRadiusP20 = percentile(curvatureRadii, 0.2);

  // 采样噪声：非角点邻域里转向符号交替的小角顶点占弧长比例
  const nearCorner = new Array(points.length).fill(false);
  for (let i = 0; i < points.length; i += 1) {
    if (Math.abs(turns[i]) < CORNER_TURN_DEG) {
      continue;
    }
    for (let d = -CORNER_NEIGHBORHOOD_STEPS; d <= CORNER_NEIGHBORHOOD_STEPS; d += 1) {
      nearCorner[(i + d + points.length * 2) % points.length] = true;
    }
  }
  let noisyArc = 0;
  for (let i = 0; i < points.length; i += 1) {
    if (nearCorner[i] || nearCorner[(i - 1 + points.length) % points.length]) {
      continue;
    }
    const previous = turns[(i - 1 + points.length) % points.length];
    const current = turns[i];
    const opposite = previous * current < 0;
    const smallEnough = Math.abs(current) < NOISE_TURN_MAX_DEG && Math.abs(previous) < NOISE_TURN_MAX_DEG;
    const aboveEpsilon = Math.abs(current) >= TURN_EPSILON_DEG && Math.abs(previous) >= TURN_EPSILON_DEG;
    if (opposite && smallEnough && aboveEpsilon) {
      noisyArc += (lengths[(i - 1 + points.length) % points.length] + lengths[i]) / 2;
    }
  }
  const noiseArcShare = perimeter > 0 ? noisyArc / perimeter : 0;

  const perimeterSpanRatio = perimeter / diagonal;

  // 局部尺度：形状内部是否存在明显小于整体尺度的子结构（凹口 / 窄缝 / 细尖）
  const subScales = [];
  if (notchDepthRatio > 0.03) {
    subScales.push(notchDepthRatio);
    subScales.push(gapWidthRatio);
  }
  if (extensionRatio >= PROTRUSION_EXTENSION_RATIO) {
    subScales.push(tipWidth);
  }
  const fineStructureScale = subScales.length > 0 ? Math.min(...subScales) : 1;

  return {
    measured: {
      pointCount: points.length,
      perimeter,
      diagonal,
      cornerTurnShare,
      symmetryResidual: symmetry,
      notchDepthRatio,
      gapWidthRatio,
      protrusionRatio,
      protrusionTipWidthRatio: tipWidth,
      protrusionTipSharpness: tipSharpness,
      protrusionExtensionRatio: extensionRatio,
      curvatureRadiusP20,
      fineStructureScale,
      noiseArcShare,
      perimeterSpanRatio,
    },
    tags: {
      dominant: cornerTurnShare >= STRAIGHT_TURN_SHARE ? 'straight' : 'curved',
      regularity: symmetry <= SYMMETRY_RESIDUAL_MAX ? 'regular' : 'irregular',
      notch: notchDepthRatio < NOTCH_DEPTH_SHALLOW ? 'none' : notchDepthRatio < NOTCH_DEPTH_DEEP ? 'shallow' : 'deep',
      gap: gapWidthRatio < GAP_WIDTH_NARROW ? 'narrow' : 'none',
      protrusion: tipSharpness >= PROTRUSION_TIP_SHARPNESS && protrusionRatio >= PROTRUSION_RADIUS_RATIO ? 'slender' : 'none',
      curvature: curvatureRadii.length >= 3 && curvatureRadiusP20 / diagonal < CURVATURE_RADIUS_HIGH ? 'high' : 'normal',
      perimeterSpan: perimeterSpanRatio < PERIMETER_SPAN_HIGH ? 'low' : 'high',
      noise: noiseArcShare >= NOISE_ARC_SHARE ? 'noisy' : 'clean',
      localScale: fineStructureScale < LOCAL_SCALE_FINE ? 'varied' : 'uniform',
    },
  };
}

/**
 * 点密度分层（按轮廓点数）。
 *
 * @param {number} pointCount 轮廓点数
 * @returns {string} sparse | medium | dense
 */
export function pointDensityTag(pointCount) {
  if (pointCount <= 24) {
    return 'sparse';
  }
  if (pointCount <= 64) {
    return 'medium';
  }
  return 'dense';
}
