/**
 * 图形规格 ShapeSpec：结构化规格 → 参数化目标轮廓（纯函数，Node 可直接测试）。
 *
 * 方案（docs/方案设计/2026-10-31-规则图形参数化与混合轮廓生成方案.md）核心决策：
 * 数学定义明确的图形（N 角星、正多边形、圆）由程序生成坐标，LLM 只理解语义和参数
 * （填 ShapeSpec），不直接猜测规则图形的点列；参数化不等于固定模板——半径、角数、
 * 排列、比例、扰动和随机种子均可变，支持"尖一点""三长三短""轻微手绘感"等变体。
 *
 * 职责边界：
 * - normalizeShapeSpec：Schema 校验与规范化。拒绝缺失字段、数组长度错误、非有限数、
 *   非正半径、非法角数及会导致退化或自交的参数组合（方案 §5）。
 * - buildShapeFromSpec：由 S 生成目标轮廓 T。输出与 normalizeCustomShape 完全相同的
 *   customShape 结构（outlinePoints/constraintPoints/parts/features），复用现有归一化、
 *   轮廓加密、旋转和路网投影链路（方案 §6.1）；生成后立即做精确性核验（流水线不得
 *   改动关键顶点，防止去重/窄刺折叠悄悄吞掉尖角）。
 * - checkSpecInvariants：T 是否精确满足 S 的几何不变量（方案 §8.4）。对旋转、平移、
 *   整体缩放保持不变——用"角点检测 + 循环对应相似变换拟合"实现，不假设任何绝对朝向。
 * - SHAPE_FAMILIES：图形族注册表。生成器按图形族和参数能力注册，不为单个图形名称
 *   写一次性特判（方案 §4 分派约束 5）。
 *
 * 坐标约定与 intent.js 一致：归一化平面 [-0.5, 0.5]，y 向上。
 * 生成顺序：单位框架（首尖朝上）→ aspect 横纵缩放 → 预归一化（包围盒中心移到
 * 原点、最长边缩放到 1）。预归一化与 normalizeCustomShape 的整体变换一致，使
 * 流水线对该点列成为恒等变换——几何规格因此不被流水线漂移。
 * 旋转不在 T 中烘焙：spec.rotationDeg 由编排层并入意图级 rotationDeg，复用现有
 * 旋转链路在投影时统一施加（方案 §6.1"复用现有……旋转和路网投影链路"；
 * 2026-10-31 评审 🔴2：此前的"烤入 + 意图级并入"会把朝向转两倍）。
 */

import { normalizeCustomShape } from './custom-shape.js';
import { validateSimplePolygon } from './shape-validate.js';

/** 角点检测的转角阈值（弧度）：加密采样的边中点转角为 0（共线），关键顶点
 * 的转角对 3~12 角星形/多边形最小也有 2π/(2N) ≥ 15°——阈值取 1° 量级即可
 * 完全分离"关键顶点"与"加密点"，加密点不会被误计数（方案 §8.4）。 */
const CORNER_TURN_EPSILON = 0.02;

/** 相似变换拟合的残差容差（归一化单位，图形最长边 = 1）：T 与 S 的关键顶点
 * 逐点吻合时残差为浮点噪声（~1e-12）；半径/角度序列不符时残差为几何量级。 */
const FIT_RESIDUAL_TOLERANCE = 1e-6;

/** 星形内凹/外尖半径比下限，按角数 N 给出（评审 🟠3：单一 0.05 比例与流水线实测
 * 不符——窄刺折叠触发在外尖端的相邻采样点上，最终归一化缩放（~0.5×）与加密
 * 采样都参与其中，实测可用下限随 N 上升：N=5 需 0.059、N=9 需 0.070、N=11 需
 * 0.085（N=6/12 因每边加密档位不同反而 0.05 即可）。表值 = 实测下限 × 1.15
 * 向上取整到 0.005，保证 schema 放行的参数必定可生成。 */
const MIN_INNER_OUTER_RATIO_BY_POINTS = {
  3: 0.06, 4: 0.06, 5: 0.07, 6: 0.06, 7: 0.065, 8: 0.075,
  9: 0.085, 10: 0.09, 11: 0.1, 12: 0.06,
};
export { MIN_INNER_OUTER_RATIO_BY_POINTS };

/** 圆的轮廓采样数：足够平滑地通过拓扑/特征检测，又不至于放大搜索成本 */
const CIRCLE_SAMPLE_COUNT = 48;

/** 扰动参数上限：振幅超过该值时角向扰动可能破坏"角度严格递增"（星形对中心
 * 的星状性），导致自交；半径扰动超过 20% 也已超出"轻微手绘感"的范围。 */
const MAX_JITTER_AMPLITUDE = 0.2;

/** 角数范围：3~12。更少退化（3 以下无意义），更多在路网上不可辨识。 */
const MIN_POINT_COUNT = 3;
const MAX_POINT_COUNT = 12;

/** userConstraints 上限与单条长度（防 LLM 输出爆炸） */
const MAX_USER_CONSTRAINTS = 8;
const USER_CONSTRAINT_MAX_CHARS = 40;

const CN_NUMBERS = {
  3: '三', 4: '四', 5: '五', 6: '六', 7: '七', 8: '八', 9: '九',
  10: '十', 11: '十一', 12: '十二',
};

/** 允许的 variant 取值（描述性标签，与数组内容做一致性校验） */
const VARIANTS = new Set(['regular', 'alternating-outer-radius', 'custom-radii']);

/**
 * 确定性伪随机数（mulberry32）：相同 seed 产生相同序列，支撑"可复现扰动"。
 *
 * @param {number} seed 任意有限数（散列到 32 位）
 * @returns {() => number} [0, 1) 均匀分布
 */
function createSeededRandom(seed) {
  let state = Math.floor(seed) >>> 0;
  if (seed % 1 !== 0) {
    // 非整数 seed：用其小数部分参与散列，保持确定性
    state = (state ^ Math.floor((seed % 1) * 0xffffffff)) >>> 0;
  }
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 数组校验：长度恰好 n、全部为有限正数。返回 {ok, values|reason} */
function validateRadiusArray(value, n, label) {
  if (!Array.isArray(value) || value.length !== n) {
    return { ok: false, reason: `${label} 必须是长度为 ${n} 的数组` };
  }
  const values = [];
  for (const item of value) {
    const num = Number(item);
    if (!Number.isFinite(num) || num <= 0) {
      return { ok: false, reason: `${label} 含非正数或非有限数` };
    }
    values.push(num);
  }
  return { ok: true, values };
}

/** 标量或数组 → 长度 n 的数组（标量展开；方案 §5"标量参数可按生成器规则展开为数组"） */
function expandRadiusParam(value, n) {
  if (Array.isArray(value)) {
    return value.slice();
  }
  return new Array(n).fill(Number(value));
}

/** 全部相等（浮点严格判等：参数来自同一标量展开或 LLM 逐字重复） */
function allEqual(values) {
  return values.every((v) => v === values[0]);
}

/**
 * 判断外半径序列的排列标签（用于 variant 一致性校验与规格摘要）。
 *
 * @param {number[]} radii 外尖半径序列（长度 N）
 * @returns {'uniform'|'alternating'|'custom'} 均匀 / 两值交替 / 自定义
 */
function classifyRadiusPattern(radii) {
  if (allEqual(radii)) {
    return 'uniform';
  }
  const first = radii[0];
  const second = radii[1];
  if (second !== first && radii.every((v, i) => (i % 2 === 0 ? v === first : v === second))) {
    return 'alternating';
  }
  return 'custom';
}

/**
 * 规格摘要（方案 §10 用户呈现：参数化变体简述实际采用的关键规格）。
 * 例：「六角星 · 三长三短」「正五边形」「六角星 · 宽扁 · 轻微不规则」。
 * 名称已包含的描述（如 LLM 命名「六角星（三长三短）」）不重复追加。
 *
 * @param {object} spec 规范化 ShapeSpec
 * @returns {string} 摘要
 */
export function describeShapeSpec(spec) {
  const parts = [spec.name];
  const push = (text) => {
    if (text && !parts.some((existing) => existing.includes(text))) {
      parts.push(text);
    }
  };
  if (spec.family === 'star' && spec.innerRadii) {
    const pattern = classifyRadiusPattern(spec.outerRadii);
    if (pattern === 'alternating') {
      const longCount = spec.outerRadii.filter((v) => v === spec.outerRadii[0]).length;
      const shortCount = spec.outerRadii.length - longCount;
      const cn = (n) => CN_NUMBERS[n] || String(n);
      push(`${cn(longCount)}长${cn(shortCount)}短`);
    } else if (pattern === 'custom') {
      push('各尖不等长');
    }
  }
  const [ax, ay] = spec.aspect;
  if (Math.abs(ax - ay) > 1e-9) {
    push(ax > ay ? '宽扁' : '竖长');
  }
  if (spec.jitter) {
    push('轻微不规则');
  }
  return parts.join(' · ');
}

/**
 * ShapeSpec Schema 校验与规范化（方案 §5）。
 *
 * @param {object} raw LLM 输出的 shapeSpec 字段（或测试直接构造）
 * @returns {{ok: true, spec: object}|{ok: false, reason: string}} 规范化规格或拒绝原因
 */
export function normalizeShapeSpec(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'shapeSpec 不是对象' };
  }
  const allowed = new Set([
    'family', 'variant', 'name', 'pointCount', 'outerRadii', 'innerRadii',
    'rotationDeg', 'aspect', 'curvature', 'jitter', 'seed', 'userConstraints',
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      return { ok: false, reason: `未知字段「${key}」` };
    }
  }
  const family = raw.family;
  if (family !== 'star' && family !== 'polygon' && family !== 'circle') {
    return { ok: false, reason: `未知图形族「${family}」（支持 star/polygon/circle）` };
  }

  // pointCount：star/polygon 必填，circle 禁止（圆无角数）
  let pointCount = null;
  if (family === 'circle') {
    if (raw.pointCount !== null && raw.pointCount !== undefined) {
      return { ok: false, reason: 'circle 图形族不接受 pointCount' };
    }
  } else {
    pointCount = Number(raw.pointCount);
    if (!Number.isInteger(pointCount) || pointCount < MIN_POINT_COUNT || pointCount > MAX_POINT_COUNT) {
      return {
        ok: false,
        reason: `pointCount 必须是 ${MIN_POINT_COUNT}~${MAX_POINT_COUNT} 的整数`,
      };
    }
  }

  // variant：可选，一致性在半径序列确定后校验
  let variant = raw.variant;
  if (variant === null || variant === undefined) {
    variant = null;
  } else if (typeof variant !== 'string' || !VARIANTS.has(variant)) {
    return { ok: false, reason: `非法 variant「${variant}」` };
  }

  // 半径：star 必填外+内；polygon 只用外；circle 无半径
  let outerRadii = null;
  let innerRadii = null;
  if (family === 'star') {
    if (raw.outerRadii === null || raw.outerRadii === undefined) {
      return { ok: false, reason: 'star 缺少 outerRadii' };
    }
    if (raw.innerRadii === null || raw.innerRadii === undefined) {
      return { ok: false, reason: 'star 缺少 innerRadii' };
    }
    if (Array.isArray(raw.outerRadii)) {
      const checked = validateRadiusArray(raw.outerRadii, pointCount, 'outerRadii');
      if (!checked.ok) {
        return checked;
      }
      outerRadii = checked.values;
    } else {
      const scalar = Number(raw.outerRadii);
      if (!Number.isFinite(scalar) || scalar <= 0) {
        return { ok: false, reason: 'outerRadii 含非正数或非有限数' };
      }
      outerRadii = expandRadiusParam(scalar, pointCount);
    }
    if (Array.isArray(raw.innerRadii)) {
      const checked = validateRadiusArray(raw.innerRadii, pointCount, 'innerRadii');
      if (!checked.ok) {
        return checked;
      }
      innerRadii = checked.values;
    } else {
      const scalar = Number(raw.innerRadii);
      if (!Number.isFinite(scalar) || scalar <= 0) {
        return { ok: false, reason: 'innerRadii 含非正数或非有限数' };
      }
      innerRadii = expandRadiusParam(scalar, pointCount);
    }
    // 退化组合：内凹 ≥ 外尖（星形塌成圆环/反转），内凹过小（外尖端会被窄刺折叠吞掉）
    const ratioFloor = MIN_INNER_OUTER_RATIO_BY_POINTS[pointCount] ?? 0.1;
    for (let i = 0; i < pointCount; i += 1) {
      if (innerRadii[i] >= outerRadii[i]) {
        return { ok: false, reason: `第 ${i + 1} 个尖角 innerRadii ≥ outerRadii（图形退化）` };
      }
      if (innerRadii[i] < outerRadii[i] * ratioFloor) {
        return {
          ok: false,
          reason: `第 ${i + 1} 个尖角 innerRadii/outerRadii 低于 ${ratioFloor}（${pointCount} 角星的尖刺下限；过细的外尖会被当作窄刺折叠，路网上不可辨识）`,
        };
      }
    }
  } else if (family === 'polygon') {
    if (raw.innerRadii !== null && raw.innerRadii !== undefined) {
      return { ok: false, reason: 'polygon 不接受 innerRadii' };
    }
    if (raw.outerRadii === null || raw.outerRadii === undefined) {
      outerRadii = new Array(pointCount).fill(0.5);
    } else {
      const scalar = Number(raw.outerRadii);
      if (Number.isFinite(scalar) && scalar > 0) {
        outerRadii = expandRadiusParam(scalar, pointCount);
      } else if (Array.isArray(raw.outerRadii)) {
        const checked = validateRadiusArray(raw.outerRadii, pointCount, 'outerRadii');
        if (!checked.ok) {
          return checked;
        }
        outerRadii = checked.values;
      } else {
        return { ok: false, reason: 'outerRadii 含非正数或非有限数' };
      }
    }
  }

  // variant 与半径序列一致性（不静默改写：声明与数据矛盾按错误处理）
  if (family === 'star' || family === 'polygon') {
    const pattern = classifyRadiusPattern(outerRadii);
    if (variant === 'regular' && pattern !== 'uniform') {
      return { ok: false, reason: 'variant=regular 但半径序列不完全相等' };
    }
    if (variant === 'alternating-outer-radius' && pattern !== 'alternating') {
      return { ok: false, reason: 'variant=alternating-outer-radius 但外半径不是两值交替排列' };
    }
    if (variant === 'custom-radii' && pattern === 'uniform') {
      return { ok: false, reason: 'variant=custom-radii 但半径序列完全相等' };
    }
    if (variant === null) {
      variant = pattern === 'uniform' ? 'regular' : pattern === 'alternating' ? 'alternating-outer-radius' : 'custom-radii';
    }
  } else {
    variant = 'regular';
  }

  // aspect：[ax, ay] 正数；默认 [1, 1]
  let aspect = [1, 1];
  if (raw.aspect !== null && raw.aspect !== undefined) {
    if (!Array.isArray(raw.aspect) || raw.aspect.length !== 2) {
      return { ok: false, reason: 'aspect 必须是 [ax, ay] 二元数组' };
    }
    const ax = Number(raw.aspect[0]);
    const ay = Number(raw.aspect[1]);
    if (!Number.isFinite(ax) || !Number.isFinite(ay) || ax <= 0 || ay <= 0) {
      return { ok: false, reason: 'aspect 含非正数或非有限数' };
    }
    aspect = [ax, ay];
  }

  // curvature：v1 只支持直边（受控曲边留待后续扩展，明确拒绝而非静默忽略）
  if (raw.curvature !== null && raw.curvature !== undefined) {
    const curvature = Number(raw.curvature);
    if (!Number.isFinite(curvature) || curvature !== 0) {
      return { ok: false, reason: '曲边（curvature ≠ 0）暂不支持，请去掉该参数或改用自由轮廓描述' };
    }
  }

  // jitter：null 或 {amplitude}
  let jitter = null;
  if (raw.jitter !== null && raw.jitter !== undefined) {
    if (!raw.jitter || typeof raw.jitter !== 'object' || Array.isArray(raw.jitter)) {
      return { ok: false, reason: 'jitter 必须是 {amplitude} 对象或 null' };
    }
    const keys = Object.keys(raw.jitter);
    if (keys.length !== 1 || keys[0] !== 'amplitude') {
      return { ok: false, reason: 'jitter 只接受 amplitude 字段' };
    }
    const amplitude = Number(raw.jitter.amplitude);
    if (!Number.isFinite(amplitude) || amplitude <= 0 || amplitude > MAX_JITTER_AMPLITUDE) {
      return { ok: false, reason: `jitter.amplitude 必须在 (0, ${MAX_JITTER_AMPLITUDE}] 内` };
    }
    jitter = { amplitude };
  }

  // seed：null 或有限数（只在指定 jitter 时有意义，但允许冗余携带）
  let seed = null;
  if (raw.seed !== null && raw.seed !== undefined) {
    const num = Number(raw.seed);
    if (!Number.isFinite(num)) {
      return { ok: false, reason: 'seed 必须是有限数或 null' };
    }
    seed = num;
  }
  if (jitter && seed === null) {
    return { ok: false, reason: '指定 jitter 时必须同时给出 seed（可复现扰动）' };
  }

  // rotationDeg：有限数，规范到 [0, 360)
  let rotationDeg = 0;
  if (raw.rotationDeg !== null && raw.rotationDeg !== undefined) {
    const num = Number(raw.rotationDeg);
    if (!Number.isFinite(num)) {
      return { ok: false, reason: 'rotationDeg 必须是有限数或 null' };
    }
    rotationDeg = ((num % 360) + 360) % 360;
  }

  // userConstraints：{text, source} 列表；只记录用户显式给出的约束（方案 §5/§8.2）
  const userConstraints = [];
  if (raw.userConstraints !== null && raw.userConstraints !== undefined) {
    if (!Array.isArray(raw.userConstraints) || raw.userConstraints.length > MAX_USER_CONSTRAINTS) {
      return { ok: false, reason: `userConstraints 必须是不超过 ${MAX_USER_CONSTRAINTS} 条的数组` };
    }
    for (const item of raw.userConstraints) {
      const text = typeof item === 'string' ? item : item?.text;
      const source = typeof item === 'object' && item !== null && typeof item.source === 'string' ? item.source : 'user-text';
      if (typeof text !== 'string' || !text.trim()) {
        return { ok: false, reason: 'userConstraints 条目缺少 text' };
      }
      if (source !== 'user-text' && source !== 'user-confirmed') {
        return { ok: false, reason: `userConstraints 来源必须是 user-text/user-confirmed，收到「${source}」` };
      }
      userConstraints.push({ text: text.trim().slice(0, USER_CONSTRAINT_MAX_CHARS), source });
    }
  }

  // name：可选显示名；缺省按图形族与角数生成
  let name = null;
  if (raw.name !== null && raw.name !== undefined) {
    if (typeof raw.name !== 'string' || !raw.name.trim()) {
      return { ok: false, reason: 'name 必须是非空字符串或 null' };
    }
    name = raw.name.trim().slice(0, 10);
  } else if (family === 'star') {
    name = `${CN_NUMBERS[pointCount] || pointCount}角星`;
  } else if (family === 'polygon') {
    name = `正${CN_NUMBERS[pointCount] || pointCount}边形`;
  } else {
    name = '圆形';
  }

  return {
    ok: true,
    spec: {
      family,
      variant,
      name,
      pointCount,
      outerRadii,
      innerRadii,
      rotationDeg,
      aspect,
      curvature: 0,
      jitter,
      seed,
      userConstraints,
      source: 'procedural',
    },
  };
}

/**
 * 展开规格为关键顶点（单位框架：外接半径 1，首尖朝上，点序沿轮廓方向）。
 * 生成器与不变量校验共用同一展开——相同 S（含 seed）必然得到相同顶点，
 * 这是"确定性只约束目标生成"的落点（方案 §7.1）。
 *
 * 星形：2N 个顶点，外尖角 θi = 90° − i·(360°/N)，内凹位于相邻外尖之间（方案 §6.1）。
 * 扰动：半径乘 (1 ± amplitude)、角度偏移 ±amplitude·半间距的一半，由 seed 驱动；
 * 角向扰动幅度保证角度严格递增（维持星状性、不自交）。
 *
 * @param {object} spec 规范化 ShapeSpec
 * @returns {Array<[number, number]>} 单位框架关键顶点
 */
export function expandSpecKeyVertices(spec) {
  if (spec.family === 'circle') {
    const points = [];
    for (let i = 0; i < CIRCLE_SAMPLE_COUNT; i += 1) {
      const angle = Math.PI / 2 - (Math.PI * 2 * i) / CIRCLE_SAMPLE_COUNT;
      points.push([Math.cos(angle), Math.sin(angle)]);
    }
    return points;
  }
  const n = spec.pointCount;
  const random = spec.jitter ? createSeededRandom(spec.seed) : null;
  const amplitude = spec.jitter ? spec.jitter.amplitude : 0;
  const vertices = [];
  // 半径归一化统一按最大外半径缩放（star/polygon 共用，避免每个点重复计算与多份口径）
  const outerRadiusScale = Math.max(...spec.outerRadii);
  if (spec.family === 'star') {
    const step = (Math.PI * 2) / (n * 2); // 相邻关键顶点的角距（180°/N）
    for (let i = 0; i < n; i += 1) {
      const outerAngle = Math.PI / 2 - step * 2 * i;
      const innerAngle = Math.PI / 2 - step * (2 * i + 1);
      const outerRadius = spec.outerRadii[i] / outerRadiusScale;
      const innerRadius = spec.innerRadii[i] / outerRadiusScale;
      const oa = random ? outerAngle + amplitude * step * 0.5 * (random() * 2 - 1) : outerAngle;
      const ia = random ? innerAngle + amplitude * step * 0.5 * (random() * 2 - 1) : innerAngle;
      const or_ = random ? outerRadius * (1 + amplitude * (random() * 2 - 1)) : outerRadius;
      const ir_ = random ? innerRadius * (1 + amplitude * (random() * 2 - 1)) : innerRadius;
      vertices.push([Math.cos(oa) * or_, Math.sin(oa) * or_]);
      vertices.push([Math.cos(ia) * ir_, Math.sin(ia) * ir_]);
    }
  } else {
    for (let i = 0; i < n; i += 1) {
      const angle = Math.PI / 2 - (Math.PI * 2 * i) / n;
      const radius = spec.outerRadii[i] / outerRadiusScale;
      const a = random ? angle + amplitude * ((Math.PI * 2) / n) * 0.25 * (random() * 2 - 1) : angle;
      const r = random ? radius * (1 + amplitude * (random() * 2 - 1)) : radius;
      vertices.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
  }
  return vertices;
}

/** 沿多边形各边等分加密（与 engine/shapes.js densifyLoop 同一算法，目标点数下限） */
function densifyLoop(vertices, targetCount) {
  if (vertices.length >= targetCount) {
    return vertices.slice();
  }
  const segmentsPerEdge = Math.max(2, Math.ceil(targetCount / vertices.length));
  const dense = [];
  for (let i = 0; i < vertices.length; i += 1) {
    const [x1, y1] = vertices[i];
    const [x2, y2] = vertices[(i + 1) % vertices.length];
    for (let k = 0; k < segmentsPerEdge; k += 1) {
      dense.push([
        x1 + ((x2 - x1) * k) / segmentsPerEdge,
        y1 + ((y2 - y1) * k) / segmentsPerEdge,
      ]);
    }
  }
  return dense;
}

/**
 * 生成目标轮廓 T（方案 §6：参数化生成器把明确的 S 准确转换为 T）。
 *
 * 流程：关键顶点 → 旋转 → aspect → 预归一化 → 按边加密 → normalizeCustomShape
 * （拓扑校验 + 特征检测 + RDP 约束）→ 关键顶点精确性核验（流水线不得增删/移动
 * 关键顶点）。任何一步失败都返回拒绝原因，不静默产出畸形 T。
 *
 * @param {object} spec 规范化 ShapeSpec（normalizeShapeSpec 输出）
 * @returns {{ok: true, customShape: object}|{ok: false, reason: string}}
 */
export function buildShapeFromSpec(spec) {
  const unit = expandSpecKeyVertices(spec);
  // 旋转不在此烘焙（评审 🔴2）：spec.rotationDeg 已由编排层并入意图级 rotationDeg，
  // 复用现有旋转链路在投影时统一施加——在这里再转一次会变成双倍朝向。
  // aspect 直接作用于单位框架；意图级朝向旋转的是整个（含 aspect 的）图形。
  const [ax, ay] = spec.aspect;
  const transformed = unit.map(([x, y]) => [x * ax, y * ay]);
  // 预归一化：与 normalizeCustomShape 的整体变换一致（包围盒中心 → 原点，最长边 → 1），
  // 使流水线对该点列成为恒等变换——后续精确性核验才能以生成坐标为基准。
  const xs = transformed.map((p) => p[0]);
  const ys = transformed.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const longestSpan = Math.max(spanX, spanY);
  if (!Number.isFinite(longestSpan) || longestSpan <= 0) {
    return { ok: false, reason: '参数导致图形退化（包围盒跨度为 0）' };
  }
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const scale = 1 / longestSpan;
  const normalized = transformed.map(([x, y]) => [
    (x - centerX) * scale,
    (y - centerY) * scale,
  ]);
  // 跨度下限（与 normalizeCustomShape 的 CUSTOM_MIN_SPAN 一致）：两轴都必须有 0.2 跨度，
  // 极端 aspect（如 10:1）在这里被拒绝，而不是流进流水线后被静默拒收
  if (spanX * scale < 0.2 || spanY * scale < 0.2) {
    return { ok: false, reason: 'aspect 比例过于极端（短轴跨度不足长轴的 1/5），图形在路网上不可辨识' };
  }

  const outline = densifyLoop(normalized, 24);
  let pipelineInvalidReason = null;
  const built = normalizeCustomShape(
    { name: spec.name, points: outline },
    (reason) => {
      pipelineInvalidReason = reason;
    },
  );
  if (!built) {
    return { ok: false, reason: `生成的轮廓未通过归一化/拓扑校验：${pipelineInvalidReason || '未知原因'}` };
  }

  // 关键顶点精确性核验：流水线（去重/窄刺折叠/加密/整体归一化）不得增删或移动关键顶点。
  // 逐点比对（顺序保持）：生成坐标与 T 的轮廓点一一对应。
  if (built.outlinePoints.length !== outline.length) {
    return {
      ok: false,
      reason: `流水线改动了关键顶点（生成 ${outline.length} 点，实际 ${built.outlinePoints.length} 点）——参数导致图形退化（如尖刺过细被折叠）`,
    };
  }
  for (let i = 0; i < outline.length; i += 1) {
    const [gx, gy] = outline[i];
    const [tx, ty] = built.outlinePoints[i];
    if (Math.abs(gx - tx) > 1e-9 || Math.abs(gy - ty) > 1e-9) {
      return { ok: false, reason: `流水线移动了轮廓点 #${i}（参数与结果不一致）` };
    }
  }

  return {
    ok: true,
    customShape: {
      ...built,
      spec,
      source: 'procedural',
    },
  };
}

/**
 * 检测闭环点列中的角点（转角超过阈值的顶点）。
 * 加密采样的边中点严格共线（转角 ~0），不会被误计数（方案 §8.4）。
 *
 * @param {Array<[number, number]>} loop 闭环点列（不重复闭合点）
 * @returns {number[]} 角点索引（按轮廓顺序）
 */
function detectCorners(loop) {
  const n = loop.length;
  const corners = [];
  for (let i = 0; i < n; i += 1) {
    const prev = loop[(i - 1 + n) % n];
    const cur = loop[i];
    const next = loop[(i + 1) % n];
    const d1x = cur[0] - prev[0];
    const d1y = cur[1] - prev[1];
    const d2x = next[0] - cur[0];
    const d2y = next[1] - cur[1];
    const len1 = Math.hypot(d1x, d1y);
    const len2 = Math.hypot(d2x, d2y);
    if (len1 === 0 || len2 === 0) {
      continue;
    }
    const cross = (d1x * d2y - d1y * d2x) / (len1 * len2);
    const dot = (d1x * d2x + d1y * d2y) / (len1 * len2);
    const turn = Math.abs(Math.atan2(cross, dot));
    if (turn > CORNER_TURN_EPSILON) {
      corners.push(i);
    }
  }
  return corners;
}

/**
 * 相似变换（等比缩放 + 旋转 + 平移）最小二乘拟合：s·R·a_i + t ≈ b_i。
 * 闭式解：w = Σ conj(a′)·b′ / Σ|a′|²（复数域），s = |w|，θ = arg(w)。
 *
 * @param {Array<[number, number]>} src 源点集
 * @param {Array<[number, number]>} dst 目标点集（与 src 一一对应）
 * @returns {{residual: number, scale: number, rotation: number}} 最大残差与拟合参数
 */
function fitSimilarity(src, dst) {
  const n = src.length;
  const meanSrc = [
    src.reduce((sum, p) => sum + p[0], 0) / n,
    src.reduce((sum, p) => sum + p[1], 0) / n,
  ];
  const meanDst = [
    dst.reduce((sum, p) => sum + p[0], 0) / n,
    dst.reduce((sum, p) => sum + p[1], 0) / n,
  ];
  let numRe = 0;
  let numIm = 0;
  let denom = 0;
  for (let i = 0; i < n; i += 1) {
    const ax = src[i][0] - meanSrc[0];
    const ay = src[i][1] - meanSrc[1];
    const bx = dst[i][0] - meanDst[0];
    const by = dst[i][1] - meanDst[1];
    // conj(a)·b = (ax·bx + ay·by) + i(ax·by − ay·bx)
    numRe += ax * bx + ay * by;
    numIm += ax * by - ay * bx;
    denom += ax * ax + ay * ay;
  }
  if (denom === 0) {
    return { residual: Infinity, scale: 0, rotation: 0 };
  }
  const wRe = numRe / denom;
  const wIm = numIm / denom;
  const scale = Math.hypot(wRe, wIm);
  const rotation = Math.atan2(wIm, wRe);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  let maxResidual = 0;
  for (let i = 0; i < n; i += 1) {
    const rx = scale * (src[i][0] * cos - src[i][1] * sin) + meanDst[0] - scale * (meanSrc[0] * cos - meanSrc[1] * sin);
    const ry = scale * (src[i][0] * sin + src[i][1] * cos) + meanDst[1] - scale * (meanSrc[0] * sin + meanSrc[1] * cos);
    const residual = Math.hypot(dst[i][0] - rx, dst[i][1] - ry);
    if (residual > maxResidual) {
      maxResidual = residual;
    }
  }
  return { residual: maxResidual, scale, rotation };
}

/**
 * 星形几何不变量校验（方案 §8.4）。
 *
 * 对旋转、平移和整体缩放保持不变：从 T 的轮廓中检测角点（关键顶点），
 * 与 S 展开的关键顶点做循环对应 + 相似变换拟合——真实匹配残差为浮点噪声，
 * 角数、半径序列、排列或比例不符时残差为几何量级。
 *
 * @param {object} customShape 归一化 customShape（outlinePoints）
 * @param {object} spec 规范化 ShapeSpec
 * @returns {{ok: boolean, reasons: string[], cornerCount: number}} 校验结果
 */
function checkStarInvariants(customShape, spec) {
  const reasons = [];
  const loop = customShape.outlinePoints;
  const expected = expandSpecKeyVertices(spec);
  const expectedCount = spec.pointCount * 2;

  // 拓扑硬门槛复验（程序生成不等于可以省略结果验证，方案 §8.1）
  const topology = validateSimplePolygon(loop);
  if (!topology.ok) {
    reasons.push(`拓扑不合法：${topology.reason}`);
    return { ok: false, reasons, cornerCount: 0 };
  }

  const corners = detectCorners(loop);
  if (corners.length !== expectedCount) {
    reasons.push(
      `外尖/内凹关键顶点数不符：检测到 ${corners.length} 个角点，S 要求 ${expectedCount} 个（${spec.pointCount} 外尖 + ${spec.pointCount} 内凹）`,
    );
    return { ok: false, reasons, cornerCount: corners.length };
  }

  // aspect 逆变换只在 T 角点侧做：生成顺序是"旋转 → aspect → 归一化"，
  // T 坐标先减去角点形心再按 (ax, ay) 分量除回，恰好把 aspect 剥掉，剩下
  // "单位框架顶点的旋转 + 等比缩放"——旋转/平移/整体缩放由相似拟合吸收。
  // S 侧直接用单位框架关键顶点（expandSpecKeyVertices），不做任何变换。
  const [ax, ay] = spec.aspect;
  const specVertices = expected;
  const cornerPoints = corners.map((index) => loop[index]);
  const centroid = [
    cornerPoints.reduce((sum, p) => sum + p[0], 0) / cornerPoints.length,
    cornerPoints.reduce((sum, p) => sum + p[1], 0) / cornerPoints.length,
  ];
  const centeredCorners = cornerPoints.map(([x, y]) => [(x - centroid[0]) / ax, (y - centroid[1]) / ay]);

  let best = null;
  for (const direction of [1, -1]) {
    for (let shift = 0; shift < expectedCount; shift += 1) {
      const paired = specVertices.map((_, i) => {
        const j = direction === 1 ? (i + shift) % expectedCount : (shift - i + expectedCount * 2) % expectedCount;
        return centeredCorners[j];
      });
      const fit = fitSimilarity(specVertices, paired);
      if (!best || fit.residual < best.residual) {
        best = { ...fit, shift, direction };
      }
      if (best.residual <= FIT_RESIDUAL_TOLERANCE) {
        break;
      }
    }
    if (best.residual <= FIT_RESIDUAL_TOLERANCE) {
      break;
    }
  }

  if (!best || best.residual > FIT_RESIDUAL_TOLERANCE) {
    reasons.push(
      `轮廓与 S 的几何不变量不符（最优相似拟合残差 ${best ? best.residual.toExponential(2) : '∞'}，超过 ${FIT_RESIDUAL_TOLERANCE}）——半径序列、长短排列或角度布置与规格不一致`,
    );
    return { ok: false, reasons, cornerCount: corners.length };
  }
  return { ok: true, reasons: [], cornerCount: corners.length };
}

/**
 * 正多边形几何不变量校验（N 个外顶点、无内凹）。
 *
 * @param {object} customShape 归一化 customShape
 * @param {object} spec 规范化 ShapeSpec
 * @returns {{ok: boolean, reasons: string[], cornerCount: number}}
 */
function checkPolygonInvariants(customShape, spec) {
  const reasons = [];
  const loop = customShape.outlinePoints;
  const topology = validateSimplePolygon(loop);
  if (!topology.ok) {
    reasons.push(`拓扑不合法：${topology.reason}`);
    return { ok: false, reasons, cornerCount: 0 };
  }
  const corners = detectCorners(loop);
  if (corners.length !== spec.pointCount) {
    reasons.push(
      `顶点数不符：检测到 ${corners.length} 个角点，S 要求 ${spec.pointCount} 个`,
    );
    return { ok: false, reasons, cornerCount: corners.length };
  }
  const [ax, ay] = spec.aspect;
  const specVertices = expandSpecKeyVertices(spec);
  const cornerPoints = corners.map((index) => loop[index]);
  const centroid = [
    cornerPoints.reduce((sum, p) => sum + p[0], 0) / cornerPoints.length,
    cornerPoints.reduce((sum, p) => sum + p[1], 0) / cornerPoints.length,
  ];
  const centeredCorners = cornerPoints.map(([x, y]) => [(x - centroid[0]) / ax, (y - centroid[1]) / ay]);
  let best = null;
  for (const direction of [1, -1]) {
    for (let shift = 0; shift < spec.pointCount; shift += 1) {
      const paired = specVertices.map((_, i) => {
        const j = direction === 1 ? (i + shift) % spec.pointCount : (shift - i + spec.pointCount * 2) % spec.pointCount;
        return centeredCorners[j];
      });
      const fit = fitSimilarity(specVertices, paired);
      if (!best || fit.residual < best.residual) {
        best = { ...fit };
      }
      if (best.residual <= FIT_RESIDUAL_TOLERANCE) {
        break;
      }
    }
    if (best.residual <= FIT_RESIDUAL_TOLERANCE) {
      break;
    }
  }
  if (!best || best.residual > FIT_RESIDUAL_TOLERANCE) {
    reasons.push(
      `轮廓与 S 的几何不变量不符（最优相似拟合残差 ${best ? best.residual.toExponential(2) : '∞'}）`,
    );
    return { ok: false, reasons, cornerCount: corners.length };
  }
  return { ok: true, reasons: [], cornerCount: corners.length };
}

/**
 * 圆的几何不变量校验：所有轮廓点到拟合圆心的距离一致、点数与采样数一致、
 * 角度均匀分布。对旋转/平移/缩放不变。
 *
 * @param {object} customShape 归一化 customShape
 * @param {object} spec 规范化 ShapeSpec
 * @returns {{ok: boolean, reasons: string[], cornerCount: number}}
 */
function checkCircleInvariants(customShape, spec) {
  const reasons = [];
  const loop = customShape.outlinePoints;
  const topology = validateSimplePolygon(loop);
  if (!topology.ok) {
    reasons.push(`拓扑不合法：${topology.reason}`);
    return { ok: false, reasons, cornerCount: 0 };
  }
  if (loop.length !== CIRCLE_SAMPLE_COUNT) {
    reasons.push(`采样点数不符：${loop.length}，S 要求 ${CIRCLE_SAMPLE_COUNT}`);
    return { ok: false, reasons, cornerCount: 0 };
  }
  // aspect 逆变换后所有点到形心距离应相等（圆心 = 形心）
  const [ax, ay] = spec.aspect;
  const pts = loop.map(([x, y]) => [x / ax, y / ay]);
  const cx = pts.reduce((sum, p) => sum + p[0], 0) / pts.length;
  const cy = pts.reduce((sum, p) => sum + p[1], 0) / pts.length;
  const radii = pts.map(([x, y]) => Math.hypot(x - cx, y - cy));
  const meanRadius = radii.reduce((sum, r) => sum + r, 0) / radii.length;
  const maxDeviation = Math.max(...radii.map((r) => Math.abs(r - meanRadius)));
  if (maxDeviation > FIT_RESIDUAL_TOLERANCE) {
    reasons.push(`轮廓不是圆（半径最大偏差 ${maxDeviation.toExponential(2)}）`);
    return { ok: false, reasons, cornerCount: 0 };
  }
  // 角度均匀性（相邻采样点圆心角 = 2π/采样数）
  for (let i = 0; i < pts.length; i += 1) {
    const a1 = Math.atan2(pts[i][1] - cy, pts[i][0] - cx);
    const a2 = Math.atan2(pts[(i + 1) % pts.length][1] - cy, pts[(i + 1) % pts.length][0] - cx);
    let delta = Math.abs(a2 - a1);
    if (delta > Math.PI) {
      delta = Math.PI * 2 - delta;
    }
    const expectedAngle = (Math.PI * 2) / CIRCLE_SAMPLE_COUNT;
    if (Math.abs(delta - expectedAngle) > 1e-6) {
      reasons.push(`采样角度不均匀（#${i} 处偏差 ${Math.abs(delta - expectedAngle).toExponential(2)}）`);
      return { ok: false, reasons, cornerCount: 0 };
    }
  }
  return { ok: true, reasons: [], cornerCount: 0 };
}

/**
 * 图形族注册表：生成器按图形族和参数能力注册（方案 §4 分派约束 5），
 * 不为单个图形名称写一次性特判。
 */
export const SHAPE_FAMILIES = {
  star: {
    label: '星形',
    minPoints: MIN_POINT_COUNT,
    maxPoints: MAX_POINT_COUNT,
    needsInnerRadii: true,
    build: buildShapeFromSpec,
    checkInvariants: checkStarInvariants,
  },
  polygon: {
    label: '正多边形',
    minPoints: MIN_POINT_COUNT,
    maxPoints: MAX_POINT_COUNT,
    needsInnerRadii: false,
    build: buildShapeFromSpec,
    checkInvariants: checkPolygonInvariants,
  },
  circle: {
    label: '圆形',
    minPoints: null,
    maxPoints: null,
    needsInnerRadii: false,
    build: buildShapeFromSpec,
    checkInvariants: checkCircleInvariants,
  },
};

/**
 * 统一入口：按规格校验 T 的几何不变量（目标语义验收的确定性部分，方案 §8.1/§8.4）。
 *
 * @param {object} customShape 归一化 customShape
 * @param {object} spec 规范化 ShapeSpec
 * @returns {{ok: boolean, reasons: string[], cornerCount: number}}
 */
export function checkSpecInvariants(customShape, spec) {
  const family = SHAPE_FAMILIES[spec?.family];
  if (!family) {
    return { ok: false, reasons: [`未知图形族「${spec?.family}」`], cornerCount: 0 };
  }
  return family.checkInvariants(customShape, spec);
}
