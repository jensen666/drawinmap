/**
 * 自定义图形的点级处理（纯函数）：去重、坐标钳位、跨度校验、约束点抽稀、特征索引。
 *
 * 从 custom-shape.js 拆出（清理方案 2026-11-09 阶段 3）：点级处理与"多部分汇总"是两件事，
 * 分开后 custom-shape.js 只负责把各部分的点列汇总成一个目标轮廓。
 */

/**
 * 自定义图形点列归一化（纯函数）。
 *
 * LLM 生成的自由点列 → 规整为规划可用的目标轮廓 T：去重、坐标钳位、跨度校验、
 * 约束点抽稀（RDP + 均匀采样并集）、拓扑校验（自交/退化拒收）、部分范围表。
 *
 * 本模块从 intent.js 独立出来（清理方案 2026-11-09 §5.4-3.4），目的是消除
 * `intent.js ↔ shape-spec.js` 的循环依赖：shape-spec.js 需要"规格 → 点列"的
 * 归一化，intent.js 需要"规格 → 意图"，两者共用同一份归一化口径。
 */

import { detectFeatures } from '../engine/shape-features.js';

/** 点数上限：由图形复杂度决定，不设固定点数（提示词要求 LLM 按特征复杂度采样）。
 * 512 是防御性上限（防 LLM 输出爆炸），不是"标准点数"——简单图形 8~20 点、
 * 复杂剪影 30~120 点、程序采样 256~512 点都合法，超出 512 才拒收。 */
const CUSTOM_MAX_POINTS = 512;
export const CUSTOM_COORD_LIMIT = 0.5; // 归一化坐标范围 [-0.5, 0.5]
const CUSTOM_DEDUP_GAP = 0.01; // 相邻点最小间距（归一化单位）
/** 包围盒两轴最小跨度（防退化）；导出给图像描摹（image-trace.js）共用同一跨度门槛，
 * 避免描摹通过了归一化却因跨度不足被 normalizeCustomShape 拒绝。 */
export const CUSTOM_MIN_SPAN = 0.2;
/** 约束点抽稀：RDP（曲率自适应）选点。约束是逼路线进细节的"钉子"，
 * 必须钉在拐角/凸出部/颈口——均匀抽稀会整段跳过岛 lobe（实测教训：复杂
 * 轮廓岛屿无约束被路线抄近路绕过）。
 * 上限按点数自适应：min(96, max(28, 点数×50%))——点数多时保留更多约束，
 * 但不超过 96（每段 A* 成本随约束数线性增长，搜索预算有限）。 */
const CUSTOM_CONSTRAINT_MAX = 96;
const CUSTOM_CONSTRAINT_FLOOR = 28;
const CUSTOM_MIN_CONSTRAINTS = 12; // 平滑图形的基础密度（RDP 不足时与均匀采样取并集）
const CUSTOM_RDP_EPSILON = 0.02; // RDP 初始 epsilon（归一化单位，≈2% 图形尺寸；再小会让粗多边形全保留）
/** 高密轮廓点数分界：> 该值视为高密有机轮廓（SVG 转换轮廓去重后 ≥87 点，
 * 手绘粗多边形上限 64 点，[64, 87] 零重叠），只对高密轮廓做自适应收紧，
 * 已够密的轮廓（马 48/狗 41/猫 42）零增负、搜索耗时不变。 */
const CUSTOM_HIGH_DENSITY_POINTS = 80;
/** 高密轮廓自适应 RDP 约束下限（含特征点）：默认 epsilon 产出不足该值时收紧补足。
 * 取 38 恰好只补足过稀的人形（29），不触碰已够密的轮廓。 */
const CUSTOM_ADAPTIVE_CONSTRAINT_FLOOR = 38;
/** 自适应 RDP 的 epsilon 收紧阶梯（最细 0.012）：16 点圆的弦拱量化误差
 * ≈0.0096 ≈ CUSTOM_DEDUP_GAP，0.01 及以下会过度踩点进支路（实测人形 0.008
 * 时最大偏差反升至 156.8m）；0.012 已拿到与 0.01 相同的最高分与最低最大偏差。 */
const CUSTOM_RDP_EPSILON_LADDER = [0.016, 0.014, 0.012];
export const CUSTOM_NAME_MAX = 10;
/** 稀疏点列（如 LLM 只给 N 边形顶点）加密后的目标点数 */
const CUSTOM_DENSIFY_TARGET = 20;
/** 坐标小越界容差：|v| ≤ 上限+该值时钳到边界（LLM 偶尔给 0.52 这类微越界，
 * 为一个点作废整个图形不可接受）；超过容差说明模型没理解坐标系，拒收 */
const CUSTOM_COORD_TOLERANCE = 0.05;
/** 窄刺折叠阈值：去而复返、张口 <1.2% 图形尺寸、伸出 >2% 的 hairpin 死胡同
 * （LLM 偶尔在起点画细刺——RDP 会保住刺尖，走廊逼路线走进死胡同窄巷） */
const CUSTOM_FINGER_WIDTH = 0.012;
const CUSTOM_FINGER_DEPTH = 0.02;
/** 声明特征（generatorGuides）映射可信距离（归一化单位，图形最长边 = 1 的 8%）：
 * LLM 被要求特征点"精确落在轮廓上"，超过 8% 说明该特征坐标与轮廓明显脱节。
 * 本轮只用于标记 confidence='low'（日志/诊断可观测，方案 §8.3 映射距离记录），
 * 不改变该特征的路线约束角色、不否决目标——降级启用前需重新校准历史回放基线。 */
const GUIDE_LOW_CONFIDENCE_DISTANCE = 0.08;
/** 分离小部分低于跨度下限时，围绕质心放大到下限（制图学惯例：小岛夸大才能走出来） */
const SMALL_PART_SCALE_MARGIN = 1.05;

/**
 * 闭环 Ramer–Douglas–Peucker：返回应保留为约束点的索引集合。
 * 以 0 号点及其最远点把闭环拆成两段折线分别简化；结果超帽时增大 epsilon 重跑。
 *
 * @param {Array<[number, number]>} points 闭环点列（不重复闭合点）
 * @param {number} epsilonStart 初始 epsilon（归一化单位）
 * @param {number} cap 保留点数硬上限
 * @returns {Set<number>} 保留的索引集合（含 0 与最远点）
 */
function rdpKeepIndices(points, epsilonStart, cap) {
  const n = points.length;
  let far = 0;
  let farD = -1;
  for (let i = 1; i < n; i += 1) {
    const d = Math.hypot(points[i][0] - points[0][0], points[i][1] - points[0][1]);
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  const walk = (keep, start, end, epsilon) => {
    const [ax, ay] = points[start];
    const [bx, by] = points[end % n];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let worst = -1;
    let worstD = -1;
    for (let i = start + 1; i < end; i += 1) {
      const [px, py] = points[i];
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst >= 0 && worstD > epsilon) {
      keep.add(worst);
      walk(keep, start, worst, epsilon);
      walk(keep, worst, end, epsilon);
    }
  };
  let epsilon = epsilonStart;
  for (;;) {
    const keep = new Set([0, far]);
    walk(keep, 0, far, epsilon);
    walk(keep, far, n, epsilon);
    if (keep.size <= cap) {
      return keep;
    }
    epsilon *= 1.4;
  }
}

/**
 * 沿闭合点列各边线性插值，把稀疏轮廓加密到至少 target 个点。
 * LLM 生成"七边形"时偶尔只给 7 个顶点（几何上完全成立），直接按点数下限
 * 拒收会让用户明确的图形请求静默落入内置推荐（实测教训：七边形→推荐心形）。
 *
 * @param {Array<[number, number]>} loop 闭环点列（不重复闭合点）
 * @param {number} target 目标点数下限
 * @returns {Array<[number, number]>} 加密后的点列
 */
function densifyClosedPoints(loop, target) {
  if (loop.length >= target) {
    return loop;
  }
  let out = loop.slice();
  while (out.length < target) {
    const next = [];
    const n = out.length;
    for (let i = 0; i < n; i += 1) {
      const [x1, y1] = out[i];
      const [x2, y2] = out[(i + 1) % n];
      next.push([x1, y1], [(x1 + x2) / 2, (y1 + y2) / 2]);
    }
    out = next;
  }
  return out;
}

/**
 * 特征索引去重（保序，只留合法的部分内索引）。
 *
 * 为什么需要：detectFeatures 的凹口分组两端可能映射到同一原始点（重采样
 * 128 点 > 原轮廓点数时一个原始点对应多个采样点），而下游要求 indices 与
 * points 一一对应；声明的特征点本身已按最近轮廓点去重，这里统一兜底。
 *
 * @param {number[]} indices 部分内轮廓索引
 * @returns {number[]} 去重后的索引（保持首次出现顺序）
 */
function uniqueFeatureIndices(indices) {
  const seen = new Set();
  const out = [];
  for (const index of Array.isArray(indices) ? indices : []) {
    if (!Number.isInteger(index) || index < 0 || seen.has(index)) {
      continue;
    }
    seen.add(index);
    out.push(index);
  }
  return out;
}

/**
 * 校验并规整单部分的点列：坐标校验/钳制 → 相邻去重 → 加密 → 跨度校验 → RDP 约束。
 *
 * @param {Array} points 部分点列
 * @param {object} [options]
 * @param {number} [options.minSpan] 包围盒两轴最小跨度（整体图形用 0.2，分离小部分放宽）
 * @param {Array} [options.declaredFeatures] LLM 显式声明的特征（坐标映射到最近轮廓点）
 * @param {number} [options.partIndex] 所属部分序号（单部分为 0；特征只记部分内索引）
 * @returns {{
 *   deduped: Array,
 *   constraintPoints: Array,
 *   features: Array<{kind: string, name: string, indices: number[], partIndex: number,
 *     points: Array<[number, number]>, depthRatio: number, widthRatio: number}>
 * }|null} 非法返回 null
 */
export function normalizePartPoints(
  points,
  { minSpan = CUSTOM_MIN_SPAN, declaredFeatures = [], partIndex = 0 } = {},
) {
  // 数量：3 个点起（LLM 生成"N 边形"偶尔只给 N 个顶点，几何上成立）
  if (points.length < 3 || points.length > CUSTOM_MAX_POINTS) {
    return null;
  }
  const valid = [];
  for (const p of points) {
    if (!Array.isArray(p) || p.length < 2) {
      return null;
    }
    let x = Number(p[0]);
    let y = Number(p[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return null;
    }
    // 小越界钳到边界（LLM 偶发 0.52 这类微越界），大越界才拒收
    if (
      Math.abs(x) > CUSTOM_COORD_LIMIT + CUSTOM_COORD_TOLERANCE ||
      Math.abs(y) > CUSTOM_COORD_LIMIT + CUSTOM_COORD_TOLERANCE
    ) {
      return null;
    }
    x = Math.max(-CUSTOM_COORD_LIMIT, Math.min(CUSTOM_COORD_LIMIT, x));
    y = Math.max(-CUSTOM_COORD_LIMIT, Math.min(CUSTOM_COORD_LIMIT, y));
    valid.push([x, y]);
  }

  // 相邻去重（间距过近归并）
  const dedupedRaw = [];
  for (const p of valid) {
    const prev = dedupedRaw[dedupedRaw.length - 1];
    if (!prev || Math.hypot(p[0] - prev[0], p[1] - prev[1]) >= CUSTOM_DEDUP_GAP) {
      dedupedRaw.push(p);
    }
  }
  if (dedupedRaw.length < 3) {
    return null;
  }

  // 窄刺折叠：LLM 偶尔在轮廓上画"去而复返"的 hairpin 细刺（去/回几乎重合，
  // 张口极小）——RDP 会保住刺尖、走廊逼路线走进死胡同窄巷，视觉就是一根刺。
  // 判据：相邻邻居互相贴近（张口小）而当前点远离它们中点（有伸出）→ 删除。
  for (let pass = 0; pass < 3; pass += 1) {
    let removed = false;
    for (let i = 0; i < dedupedRaw.length; i += 1) {
      const prev = dedupedRaw[(i - 1 + dedupedRaw.length) % dedupedRaw.length];
      const cur = dedupedRaw[i];
      const next = dedupedRaw[(i + 1) % dedupedRaw.length];
      const gap = Math.hypot(prev[0] - next[0], prev[1] - next[1]);
      const stickOut = Math.hypot(
        cur[0] - (prev[0] + next[0]) / 2,
        cur[1] - (prev[1] + next[1]) / 2,
      );
      if (gap < CUSTOM_FINGER_WIDTH && stickOut > CUSTOM_FINGER_DEPTH) {
        dedupedRaw.splice(i, 1);
        removed = true;
        i -= 1;
      }
    }
    if (!removed) break;
  }
  if (dedupedRaw.length < 3) {
    return null;
  }

  // 稀疏轮廓加密到目标点数（贴合度采样与走廊引导需要边中段有采样点）
  const deduped = densifyClosedPoints(dedupedRaw, CUSTOM_DENSIFY_TARGET);

  // 包围盒跨度校验（防退化成一条线/一个点）
  const xs = deduped.map((p) => p[0]);
  const ys = deduped.map((p) => p[1]);
  const spanX = Math.max(...xs) - Math.min(...xs);
  const spanY = Math.max(...ys) - Math.min(...ys);
  if (minSpan >= CUSTOM_MIN_SPAN) {
    // 整体图形：两轴都须达标
    if (spanX < minSpan || spanY < minSpan) {
      return null;
    }
  } else {
    // 分离小部分：狭长形状（南北向的岛）合法，只拒"两轴都太小"的退化；
    // 低于下限不拒收而是围绕质心放大到下限（小岛夸大是制图学惯例，
    // 否则小岛在路网上走不出来，整条 parts 请求失败）
    const maxSpan = Math.max(spanX, spanY);
    if (maxSpan < minSpan) {
      const k = (minSpan / maxSpan) * SMALL_PART_SCALE_MARGIN;
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
      const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
      for (let i = 0; i < deduped.length; i += 1) {
        deduped[i] = [
          Math.max(-CUSTOM_COORD_LIMIT, Math.min(CUSTOM_COORD_LIMIT, cx + (deduped[i][0] - cx) * k)),
          Math.max(-CUSTOM_COORD_LIMIT, Math.min(CUSTOM_COORD_LIMIT, cy + (deduped[i][1] - cy) * k)),
        ];
      }
    }
  }

  // 细节特征检测（凹口/窄间隙）：这些是决定"像不像"的细节，必须成为约束。
  // RDP 只看几何简化误差，会把"窄而深"的腿间隙当可省略细节——没有约束点，
  // 走廊引导 A* 就直接抄近路跨过去，画出来的动物就"简单"了。
  const features = detectFeatures(deduped);

  // LLM 显式声明的鲜明特征（"先分析特征、再描轮廓"）：坐标映射到最近轮廓点，
  // 与几何检测到的特征合并——语义特征（长脸/尖耳/翘尾）几何检测未必能识别，
  // 但 LLM 知道它们"鲜明"，必须保留并单独检查是否走出。
  for (const rawFeature of Array.isArray(declaredFeatures) ? declaredFeatures : []) {
    if (!rawFeature || typeof rawFeature !== 'object' || !Array.isArray(rawFeature.points)) {
      continue;
    }
    const mappedIndices = [];
    // 映射距离 = 声明坐标到最近轮廓点的最大距离（技术吸附质量，方案 §8.3）：
    // 只用于把明显脱节的 guide 降级为诊断（不作路线硬约束），不用于否决目标。
    let mappingDistance = 0;
    for (const point of rawFeature.points.slice(0, 3)) {
      if (!Array.isArray(point) || point.length < 2) {
        continue;
      }
      const x = Number(point[0]);
      const y = Number(point[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        continue;
      }
      if (
        Math.abs(x) > CUSTOM_COORD_LIMIT + CUSTOM_COORD_TOLERANCE ||
        Math.abs(y) > CUSTOM_COORD_LIMIT + CUSTOM_COORD_TOLERANCE
      ) {
        continue;
      }
      const clamped = [
        Math.max(-CUSTOM_COORD_LIMIT, Math.min(CUSTOM_COORD_LIMIT, x)),
        Math.max(-CUSTOM_COORD_LIMIT, Math.min(CUSTOM_COORD_LIMIT, y)),
      ];
      // 映射到最近的轮廓点（特征点必须在轮廓上，否则投影后没有意义）
      let nearest = 0;
      let nearestDist = Infinity;
      for (let i = 0; i < deduped.length; i += 1) {
        const d = (deduped[i][0] - clamped[0]) ** 2 + (deduped[i][1] - clamped[1]) ** 2;
        if (d < nearestDist) {
          nearestDist = d;
          nearest = i;
        }
      }
      mappedIndices.push(nearest);
      mappingDistance = Math.max(mappingDistance, Math.sqrt(nearestDist));
    }
    if (mappedIndices.length > 0) {
      // 映射距离 = 声明坐标到最近轮廓点的最大距离（技术吸附质量，方案 §8.3）。
      // 本轮只记录距离与可信度供日志/诊断使用：低可信（> GUIDE_LOW_CONFIDENCE_DISTANCE）
      // 不否决目标 T，也暂不改变其路线约束角色——历史绿线回放（吉他 78 / 中国地图 74、
      // 固定样本 A/B）依赖声明特征作为约束与特征覆盖项，降级启用前需重新校准基线
      // （方案 §11.1 防误杀冻结、§13 不修改现有路线质量阈值）。
      const lowConfidence = mappingDistance > GUIDE_LOW_CONFIDENCE_DISTANCE;
      features.push({
        // 角色（方案 §8.2）：LLM 声明特征是 generatorGuides——生成引导与诊断，
        // 无目标否决权；低可信只作标记，不参与目标验收否决。
        kind: 'declared',
        role: lowConfidence ? 'generator-guide-lowconf' : 'generator-guide',
        name: typeof rawFeature.name === 'string' ? rawFeature.name.trim().slice(0, CUSTOM_NAME_MAX) : '',
        indices: uniqueFeatureIndices(mappedIndices),
        depthRatio: 0,
        widthRatio: 0,
        mappingDistance: Number(mappingDistance.toFixed(4)),
        confidence: lowConfidence ? 'low' : 'high',
      });
    }
  }

  // 约束点抽稀：RDP（曲率自适应）——把"钉子"钉在拐角/凸出部/颈口，
  // 均匀抽稀会整段跳过岛 lobe（实测教训：复杂轮廓岛屿无约束被抄近路绕过）。
  // 上限按点数自适应（点数越多保留越多约束，最多 96）——不再固定 28。
  const constraintCap = Math.min(
    CUSTOM_CONSTRAINT_MAX,
    Math.max(CUSTOM_CONSTRAINT_FLOOR, Math.round(deduped.length * 0.5)),
  );
  /** 特征点强制保留（特征优先于普通点，允许轻微超出约束上限；identity 只补凹底） */
  const addFeatureIndices = () => {
    for (const feature of features) {
      const forceIndices = feature.kind === 'identity' ? feature.indices.slice(1, 2) : feature.indices;
      for (const index of forceIndices) {
        keep.add(index);
      }
    }
  };
  let keep = rdpKeepIndices(deduped, CUSTOM_RDP_EPSILON, constraintCap);
  addFeatureIndices();
  // 高密有机轮廓自适应补足 RDP 约束：触发判定看"含特征点"的归一化约束总数
  // （马 48/狗 41/猫 42 ≥ 38 → 不触发，约束数与搜索耗时零增长）；收紧循环按
  // RDP 原始保留数判停（人形 297 点轮廓 0.02 抽成 29 个约束，后背浅凹被抽成
  // 直线、路线偏 112.5m——收紧到 0.012 后浅凹与小腿贴上约束）。
  if (deduped.length > CUSTOM_HIGH_DENSITY_POINTS && keep.size < CUSTOM_ADAPTIVE_CONSTRAINT_FLOOR) {
    for (const epsilon of CUSTOM_RDP_EPSILON_LADDER) {
      keep = rdpKeepIndices(deduped, epsilon, constraintCap);
      if (keep.size >= CUSTOM_ADAPTIVE_CONSTRAINT_FLOOR) {
        break;
      }
    }
    addFeatureIndices();
  }
  if (keep.size < CUSTOM_MIN_CONSTRAINTS) {
    const step = Math.max(1, Math.ceil(deduped.length / CUSTOM_MIN_CONSTRAINTS));
    for (let i = 0; i < deduped.length; i += step) {
      keep.add(i);
    }
  }
  return {
    deduped,
    constraintPoints: deduped.filter((_, index) => keep.has(index)),
    // 特征保留部分内索引（indices）与所属部分（partIndex）：坐标仍同步变换，
    // 但索引不转成全局索引——规划器/弧偏差按"部分内闭环"使用，跨部分混用会串弧。
    // identity 浅凹仅把凹底最深点补入约束并放进 points（buildShapeModel 据此标关键点）：
    // 两侧平滑口沿保留在 indices 中供部位弧日志使用，不单独钉点/不标关键，
    // 防止平滑口沿分段拉偏路线或与相邻特征关键点吸到同位触发塌缩误杀。
    features: features.map((feature) => {
      const indices = uniqueFeatureIndices(feature.indices);
      const pointIndices = feature.kind === 'identity' ? indices.slice(1, 2) : indices;
      return {
        kind: feature.kind,
        // 角色标注（方案 §8.2）：detectFeatures 产出的几何特征默认 role=detected，
        // LLM 声明特征在上方已标 generator-guide[_lowconf]；角色决定否决权与日志归属。
        role: feature.role || 'detected',
        name: feature.name || '',
        indices,
        partIndex,
        points: pointIndices.map((index) => deduped[index].slice()),
        depthRatio: feature.depthRatio,
        widthRatio: feature.widthRatio,
        mappingDistance: feature.mappingDistance ?? null,
        confidence: feature.confidence ?? null,
      };
    }),
  };
}

/**
 * 校验并规整 LLM 生成的自定义图形。
 *
 * 单部分：{name, points}；有分离部分（群岛、岛+大陆等）：{name, parts: [{name?, points}, ...]}。
 * 所有部分共用同一归一化坐标系（[-0.5, 0.5] 描述整个图形），每个部分是独立闭环；
 * 输出按部分顺序拼接的扁平 outlinePoints/constraintPoints + parts 范围表，
 * 供模型/规划器逐部分处理、部分之间用真实路网衔接。
 *
 * @param {object} raw LLM 返回的 customShape 字段
 * @param {((reason: string) => void)} [onInvalid] 校验失败原因回调（编排层据此
 *   带原因重生成，不再静默丢弃；不影响返回值仍为 null 的约定）
 * @returns {{
 *   name: string,
 *   constraintPoints: Array<[number, number]>,
 *   outlinePoints: Array<[number, number]>,
 *   parts: Array<{name: string, outlineStart: number, outlineCount: number, constraintStart: number, constraintCount: number}>,
 *   features: Array<{kind: string, name: string, indices: number[], partIndex: number,
 *     points: Array<[number, number]>, depthRatio: number, widthRatio: number}>
 * }|null} 非法返回 null；features.indices 是部分内索引（不转全局索引）
 */