/**
 * 统一评分与质量门槛：候选搜索、路线规划与交付判定共用同一套评分口径。
 *
 * 评分导向：用户要的是"像"，且"画不出来就说画不出来"：
 * - 候选级硬淘汰：任一顶点吸附超 120m（落水面/无路区）、关键角塌缩、
 *   覆盖不全、不可达、有序指标缺失 → 0 分；
 * - 评分使用有序分段贴合（第 N 段只与第 N 段比，全局"贴错边"逃不掉）
 *   与尺寸归一化关键角误差；
 * - 质量门槛 meetsQualityBar：双向有序贴合 + 关键角偏移都达标才算
 *   "画出来了"，由上层诚实告知，不达标不绘制、不推荐。
 *
 * 阈值经真实路网正反例校准（见 test/engine-smoke.mjs 的固定正反例）：
 * 原截图反例（实际偏移中心、纯最短路重放：路线侧 mean 4.53% / max 16.63%）
 * 必须被路线侧门槛拦截；正例（路线侧 mean ≤3.62% /
 * max ≤12.16%）必须放行。
 */

/** 顶点吸附硬门槛（米）：超过即认为顶点落在水面/空旷无路区，候选淘汰 */
export const SNAP_HARD_GATE_METERS = 120;

/** 交付闸门：几何达标但评分低于该线 → 不硬画，诚实说明并建议重试。
 * 实测教训：中国地图 50 分交付被用户评价"差太多"——走得出 ≠ 画得像。
 * 放在 quality.js：选优比较器（selection.js）需要用同一条线区分"合格交付档"
 * 与"橙色参考档"，而 candidates.js 已反向依赖 selection.js，常量放这里避免循环依赖。 */
export const DELIVERABLE_SCORE = 60;

/** 质量门槛：有序"目标段→路线"相对平均偏差（正例锚点实测 ≤2.3%） */
export const QUALITY_ORDERED_OUTLINE_MEAN_RATIO = 0.06;

/** 质量门槛：有序"目标段→路线"相对最大偏差（正例锚点实测 ≤8.4%） */
export const QUALITY_ORDERED_OUTLINE_MAX_RATIO = 0.12;

/** 质量门槛：有序"路线→目标段"相对平均偏差（路线不许乱跑）。
 * 正例锚点实测 ≤3.62%；原截图反例（偏移中心 23.129861, 113.3245 / 1200m / 60°）
 * 引导后 4.34%、纯最短路 4.53%——4.0% 拦截反例、给正例留 10% 余量。 */
export const QUALITY_ORDERED_ROUTE_MEAN_RATIO = 0.04;

/** 质量门槛：有序"路线→目标段"相对最大偏差（局部绕行上限）。
 * 正例锚点实测 ≤12.16%；上述反例纯最短路 16.63% 被拦（引导版 13.13% 由
 * 路线侧平均门槛拦截）。 */
export const QUALITY_ORDERED_ROUTE_MAX_RATIO = 0.145;

/** 质量门槛：关键角（角点/尖端）吸附偏移相对图形尺寸的上限 */
export const QUALITY_KEY_MAX_RATIO = 0.065;

/** 质量门槛：细节特征（凹口/窄间隙）走出覆盖率下限。
 * 整体贴合达标不等于局部细节走出——腿间隙可能被 A* 抄近路跨过，
 * 单独要求至少 3/4 的特征被真正走到（无特征图形恒为 1，不受影响）。 */
export const QUALITY_FEATURE_COVERAGE = 0.75;

/** 质量门槛：保序曲线相似度（离散 Fréchet 距离 ÷ 图形尺寸）。
 * 逐段偏差可能"每段都贴着目标"，但同一段内顺序错乱/来回折返（腿间隙绕成
 * 麻花）时 Fréchet 会明显放大。计算前目标段/路线已按 ~1% 尺寸稠密重采样
 * （见 fidelity.densifyPolyline）：离散 Fréchet 按顶点配对，长直边目标只有
 * 2 个顶点时中段路线会被采样伪影抬到 ≈段长/2——那不是折返。门槛保持 0.15
 * 不变：合成验算中去而复返（900m 目标）仍 26%、垂直绕行 400m 仍 44%，
 * 顺序错乱/明显绕行依旧被拦截。 */
export const QUALITY_FRECHET_MAX_RATIO = 0.15;

/** 质量门槛：特征间隙保留率下限。
 * 窄间隙（腿间隙）两侧壁点到路线的弧长距离 ÷ 声明间隙宽度——路线跨过间隙时
 * 弧长≈宽度（保留率 1），绕行保留间隙时弧长 > 1.5 倍宽度。 */
export const QUALITY_FEATURE_GAP_RETAIN = 1.2;

/** 质量门槛：整体比例失真上限（路线包围盒宽高比 vs 理想轮廓宽高比）。
 * 头身比/整体朝向被路网拉扁拉长时超限——形状"整体不像"的直接度量。 */
export const QUALITY_ASPECT_DISTORTION = 0.2;

/** 评分权重（有序指标为主，吸附为辅；绕行比不参与评分） */
const W_ORDERED_OUTLINE_MEAN = 3;
const W_ORDERED_OUTLINE_MAX = 1;
const W_ORDERED_ROUTE_MEAN = 1.5;
const W_ORDERED_ROUTE_MAX = 0.5;
const W_KEY_MAX = 1.5;
const W_FEATURE_MISSING = 35;
const W_FEATURE_OFFSET = 2;
const W_FRECHET = 0.5;
const W_ASPECT = 20;
const W_SNAP_AVG = 0.15;
const SNAP_AVG_CAP = 30;

/** 安全读取数值指标：缺失/非有限时给"最差值"，保证旧式 metrics 不炸 */
function num(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * 给一条图形路线评分（0~100，越高越"像且顺"）。
 *
 * 硬门槛（0 分）：不可达 / 覆盖不全 / 顶点落无路区 / 关键角塌缩 /
 * 关键角覆盖不全 / 有序指标缺失。软扣分：有序贴合双向四项 +
 * 关键角偏移 + 平均吸附误差。绕行比（路线长 ÷ 轮廓周长）只供展示，
 * 不进评分——先把「像不像」选出来，里程和耗时以后再管。
 *
 * @param {object} metrics 规划指标（含 planner 输出的有序贴合与关键点字段）
 * @returns {number} 评分
 */
export function scoreRoute(metrics) {
  if (!metrics || metrics.failedLegs > 0 || !metrics.routePointCount) {
    return 0;
  }
  if (metrics.coverage < 100) {
    return 0;
  }
  if (metrics.snapMaxMeters > SNAP_HARD_GATE_METERS) {
    return 0;
  }
  // 关键角塌缩（两个关键点吸到同一位置）或覆盖不全 → 图形特征已失真
  if ((metrics.collapsedKeyCount || 0) > 0 || (metrics.keyCoverage || 0) < 1) {
    return 0;
  }
  const orderedOutlineMean = num(metrics.orderedOutlineMeanRatio, Infinity);
  const orderedRouteMean = num(metrics.orderedRouteMeanRatio, Infinity);
  if (orderedOutlineMean === Infinity || orderedRouteMean === Infinity) {
    return 0;
  }
  const orderedOutlineMax = num(metrics.orderedOutlineMaxRatio, 1);
  const orderedRouteMax = num(metrics.orderedRouteMaxRatio, 1);
  const keyMaxRatio = num(metrics.keyMaxOffsetRatio, 1);
  const featureCoverage = num(metrics.featureCoverage, 1);
  // 无特征图形（内置图形/旧式 metrics）不参与特征偏差扣分：缺失时按 0 处理
  const featureMaxRatio = num(metrics.featureMaxOffsetRatio, 0);
  const frechetMaxRatio = num(metrics.frechetMaxRatio, 0);
  // 整体比例失真：路线包围盒宽高比 vs 理想轮廓宽高比（相对偏差）
  const aspectDistortion = num(metrics.aspectDistortionRatio, 0);
  // 特征间隙保留率：1 = 路线跨过间隙（没保留），>1.2 = 绕行保留间隙
  const featureGapRetain = num(metrics.featureGapRetainRatio, Number.POSITIVE_INFINITY);

  let score = 100;
  score -= orderedOutlineMean * 100 * W_ORDERED_OUTLINE_MEAN;
  score -= orderedOutlineMax * 100 * W_ORDERED_OUTLINE_MAX;
  score -= orderedRouteMean * 100 * W_ORDERED_ROUTE_MEAN;
  score -= orderedRouteMax * 100 * W_ORDERED_ROUTE_MAX;
  score -= keyMaxRatio * 100 * W_KEY_MAX;
  // 细节特征单独计分：整体贴合达标但腿间隙/耳根没走出来的候选要被扣下来
  score -= (1 - featureCoverage) * W_FEATURE_MISSING;
  score -= featureMaxRatio * 100 * W_FEATURE_OFFSET;
  // 保序曲线相似度：段内顺序错乱/折返
  score -= frechetMaxRatio * 100 * W_FRECHET;
  // 整体比例失真：头身比被路网拉扁/拉长
  // 量纲与其余权重一致（ratio × 权重，不再额外 ×100）：5% 失真扣 1 分、
  // 20% 扣 4 分；硬门槛 QUALITY_ASPECT_DISTORTION 独立负责拦截，评分只做区分。
  // （旧实现 ×100 会让 5% 失真直接扣 100 分，把候选区分度压平。）
  score -= Math.min(1, aspectDistortion) * W_ASPECT;
  // 间隙保留：路线跨过腿间隙（保留率 < 1.2）扣分
  if (Number.isFinite(featureGapRetain) && featureGapRetain < QUALITY_FEATURE_GAP_RETAIN) {
    score -= (QUALITY_FEATURE_GAP_RETAIN - featureGapRetain) * 20;
  }
  score -= Math.min(SNAP_AVG_CAP, metrics.snapAvgMeters * W_SNAP_AVG);
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * 软门槛定义（结构化偏差，可在候选之间比较"差多少"）：
 * 顺序与 meetsQualityBar 的判定顺序一致；higherIsBetter=false 表示越小越好。
 * key 供联合精修/近失候选筛选做逐门槛对比，不参与评分展示。
 */
const SOFT_GATE_DEFS = [
  {
    key: 'orderedOutlineMean',
    label: '有序轮廓平均偏差',
    valueOf: (metrics) => metrics.orderedOutlineMeanRatio,
    threshold: QUALITY_ORDERED_OUTLINE_MEAN_RATIO,
    higherIsBetter: false,
  },
  {
    key: 'orderedOutlineMax',
    label: '有序轮廓最大偏差',
    valueOf: (metrics) => metrics.orderedOutlineMaxRatio,
    threshold: QUALITY_ORDERED_OUTLINE_MAX_RATIO,
    higherIsBetter: false,
  },
  {
    key: 'orderedRouteMean',
    label: '有序路线平均偏差',
    valueOf: (metrics) => metrics.orderedRouteMeanRatio,
    threshold: QUALITY_ORDERED_ROUTE_MEAN_RATIO,
    higherIsBetter: false,
  },
  {
    key: 'orderedRouteMax',
    label: '有序路线最大偏差',
    valueOf: (metrics) => metrics.orderedRouteMaxRatio,
    threshold: QUALITY_ORDERED_ROUTE_MAX_RATIO,
    higherIsBetter: false,
  },
  {
    key: 'keyMaxOffset',
    label: '关键角偏移',
    valueOf: (metrics) => metrics.keyMaxOffsetRatio ?? 1,
    threshold: QUALITY_KEY_MAX_RATIO,
    higherIsBetter: false,
  },
  {
    key: 'featureCoverage',
    label: '特征覆盖',
    valueOf: (metrics) => metrics.featureCoverage ?? 1,
    threshold: QUALITY_FEATURE_COVERAGE,
    higherIsBetter: true,
  },
  {
    key: 'frechetMax',
    label: '保序偏差',
    valueOf: (metrics) => metrics.frechetMaxRatio ?? 0,
    threshold: QUALITY_FRECHET_MAX_RATIO,
    higherIsBetter: false,
  },
  {
    key: 'aspectDistortion',
    label: '整体比例失真',
    valueOf: (metrics) => metrics.aspectDistortionRatio ?? 0,
    threshold: QUALITY_ASPECT_DISTORTION,
    higherIsBetter: false,
  },
  {
    key: 'featureGapRetain',
    label: '特征间隙保留',
    valueOf: (metrics) => metrics.featureGapRetainRatio ?? Number.POSITIVE_INFINITY,
    threshold: QUALITY_FEATURE_GAP_RETAIN,
    higherIsBetter: true,
  },
];

/** 计算单个软门槛的"超出量"：>0 即不达标；数值越大越差（可跨候选比较） */
function softGateExcess(value, threshold, higherIsBetter) {
  const finite = Number.isFinite(value);
  if (higherIsBetter) {
    // 越大越好：Infinity 视为完美，缺失/非法视为最差
    if (value === Number.POSITIVE_INFINITY) {
      return -1;
    }
    return finite ? (threshold - value) / threshold : Number.POSITIVE_INFINITY;
  }
  return finite ? value / threshold - 1 : Number.POSITIVE_INFINITY;
}

/**
 * 质量门槛分类报告：把"不达标"拆成硬门槛与软门槛，供联合精修/近失候选筛选使用。
 *
 * - 硬门槛（geometry/可达性/塌缩类）：联合精修无法通过局部吸附修复，候选直接淘汰；
 * - 软门槛（双向有序偏差、关键角偏移、特征覆盖、Fréchet、比例失真、间隙保留）：
 *   数值连续可比，"差一道软门槛"的候选可以被联合精修救回来。
 *
 * 判定结果与 meetsQualityBar 完全等价（后者直接复用本报告）。
 *
 * @param {object} metrics 规划指标
 * @returns {{
 *   hardFailures: string[],
 *   softGates: Array<{key: string, label: string, value: number, threshold: number, excess: number, failed: boolean}>,
 *   softFailures: Array<object>,
 *   softCount: number,
 *   passes: boolean
 * }} 门槛报告
 */
export function qualityGateReport(metrics) {
  const hardFailures = [];
  if (!metrics) {
    return { hardFailures: ['metrics-missing'], softGates: [], softFailures: [], softCount: 0, passes: false };
  }
  if ((metrics.failedLegs || 0) > 0) {
    hardFailures.push('failed-legs');
  }
  if (metrics.coverage < 100) {
    hardFailures.push('coverage');
  }
  if (metrics.snapMaxMeters > SNAP_HARD_GATE_METERS) {
    hardFailures.push('snap-max');
  }
  if ((metrics.collapsedKeyCount || 0) > 0) {
    hardFailures.push('collapsed-key');
  }
  if ((metrics.keyCoverage ?? 0) < 1) {
    hardFailures.push('key-coverage');
  }
  const softGates = SOFT_GATE_DEFS.map((def) => {
    const raw = def.valueOf(metrics);
    const value = raw === undefined ? (def.higherIsBetter ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY) : raw;
    const excess = softGateExcess(value, def.threshold, def.higherIsBetter);
    return {
      key: def.key,
      label: def.label,
      value,
      threshold: def.threshold,
      excess,
      failed: excess > 0,
    };
  });
  const softFailures = softGates.filter((gate) => gate.failed);
  return {
    hardFailures,
    softGates,
    softFailures,
    softCount: softFailures.length,
    passes: hardFailures.length === 0 && softFailures.length === 0,
  };
}

/**
 * 质量门槛：这条路线是否"画出来了"（像到可以交付）。
 * 双向有序贴合达标 + 关键角无塌缩、覆盖完整、偏移达标。
 *
 * @param {object} metrics 规划指标
 * @returns {boolean} 是否达标
 */
export function meetsQualityBar(metrics) {
  return qualityGateReport(metrics).passes;
}
