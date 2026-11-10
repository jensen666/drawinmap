/**
 * 偏移说明的近场证据文案（纯函数，需求见 docs/方案设计/2026-10-26-推理过程固定工作流.md 第 3.2 节）。
 *
 * 背景：用户指定地点画不出达标图形时，编排层会扩大范围在别处画出来，并在回复里明说
 * 偏移。解释"原地为什么画不出来"必须使用**近场（第一级）最好候选**的证据：
 * - 不能用最终远处候选的 metrics——那会把"远处候选差在哪"误当成"近场为什么失败"；
 * - 不许硬编码"附近路网不完整/临水"——只有近场候选吸附超阈值才可以说"可能临水"。
 *
 * 本模块只做纯文本映射：
 * - 输入是 candidates.js 输出的 nearBest / nearBests（第一级搜索另存，后续级别与
 *   精修不会改写）；
 * - 输出是可直接拼进回复的中文说明或整句，不读写全局状态、不发起搜索；
 * - 函数返回值只由入参决定；关键分支打 debug 日志（默认 info 级不输出，排查时
 *   ?log=debug 可见），便于核对文案到底依据了哪份近场证据。
 */

import { createLogger } from '../log/index.js';

/** 模块 logger：记录偏移说明的输入证据与命中的分支（debug 级，默认不刷屏） */
const log = createLogger('agent/offset-reason');

/** 近场吸附硬伤阈值（米）：超过该值才允许说"图形部分区域可能临水或落在无路区"。
 * 与 docs 第 3.2 节表格一致（>120m）；未超过时不得编造"临水""路网不完整"。 */
export const NEAR_FIELD_SNAP_HARD_METERS = 120;

/**
 * 偏移说明的主语：地点来源为路网覆盖中心时，不能说成"您指定的地方"。
 *
 * @param {string|null|undefined} placeSource 地点来源（'coverage-center' 表示已加载路网的覆盖中心）
 * @returns {string} 中文主语：'按已加载路网的覆盖中心' 或 '您指定的地方'
 */
export function offsetSubject(placeSource) {
  const subject = placeSource === 'coverage-center' ? '按已加载路网的覆盖中心' : '您指定的地方';
  log.debug('offset.subject', { placeSource, subject });
  return subject;
}

/**
 * 读取近场候选的路线点列。
 * 注意：planner 把 routeLatLngs 放在规划结果（result）顶层，metrics 里只有
 * routePointCount；这里只读 result，避免把"没有 metrics 字段"误判成没有路线。
 *
 * @param {object|null} nearBest 第一级（近场）最好候选
 * @returns {Array<[number, number]>} 路线点列；缺失时为空数组
 */
function routeLatLngsOf(nearBest) {
  const latlngs = nearBest?.result?.routeLatLngs;
  return Array.isArray(latlngs) ? latlngs : [];
}

/**
 * 近场候选是否形成"可评价路线"：有 result、有 metrics，且路线至少 2 个点。
 *
 * @param {object|null} nearBest 第一级（近场）最好候选
 * @returns {boolean} 是否可评价
 */
function hasEvaluableRoute(nearBest) {
  return Boolean(nearBest?.result?.metrics) && routeLatLngsOf(nearBest).length >= 2;
}

/**
 * 用近场证据说明"原地为什么画不出像样的图形"（返回说明文字，不含"注意："与主语）。
 *
 * 分支顺序严格按 docs 第 3.2 节表格（吸附硬伤优先于"路线可评价性"）：
 * 1. 近场吸附最大偏移 > 120m → '图形部分区域可能临水或落在无路区'。
 *    必须先判这一支：规划器吸附超限时会直接短路，返回 routeLatLngs=[] 但保留真实的
 *    snapMaxMeters（planner.js 的 quickSnapMax 短路）——若先判"有没有可评价路线"，
 *    就会把"跨江/无路区"误说成"近场没有形成可评价的路线"（本项要修的误导话术）。
 * 2. 没有候选 / 没有 result / 没有可评价路线 → '近场没有形成可评价的路线'；
 * 3. 路线完整（failedLegs === 0）且有序偏差为有限值 → 写近场最好候选的有序贴合平均/最大偏差；
 * 4. 有部分路线但未走通（failedLegs > 0） → '近场路线未走通'；
 * 5. 其余 → '近场没有形成可评价的路线'。
 *
 * 只依据传入的 nearBest，绝不读取最终远处候选；没有证据时不编造原因。
 *
 * @param {object|null} nearBest candidates.js 记录的近场最好候选
 *   { result: { metrics, routeLatLngs }, score, adjustedScore, center, sizeMeters, rotationDeg, stage, stageLabel }
 * @returns {string} 偏移原因说明（不带"注意："前缀、不带主语）
 */
export function describeNearFieldFailure(nearBest) {
  const routeLatLngs = routeLatLngsOf(nearBest);
  const metrics = nearBest?.result?.metrics ?? null;

  // 分支 1：吸附硬伤——只有这一支允许提"临水/无路区"，且必须由近场证据触发。
  // 放在"可评价路线"判断之前：吸附超限短路时 routeLatLngs 为空，但 snapMaxMeters 是真实证据。
  if (metrics && Number.isFinite(metrics.snapMaxMeters) && metrics.snapMaxMeters > NEAR_FIELD_SNAP_HARD_METERS) {
    log.debug('nearField.reason', {
      branch: 'snap-hard',
      snapMaxMeters: metrics.snapMaxMeters,
      threshold: NEAR_FIELD_SNAP_HARD_METERS,
      routePointCount: routeLatLngs.length,
    });
    return '图形部分区域可能临水或落在无路区';
  }

  // 分支 2：没有可评价路线就到此为止，后面的偏差数字都无从谈起
  if (!hasEvaluableRoute(nearBest)) {
    log.debug('nearField.reason', {
      branch: 'no-evaluable-route',
      hasResult: Boolean(nearBest?.result),
      hasMetrics: Boolean(metrics),
      routePointCount: routeLatLngs.length,
    });
    return '近场没有形成可评价的路线';
  }

  // 分支 3：路线完整且有序偏差为有限值——如实报近场最好候选的贴合偏差
  const orderedMean = metrics.orderedOutlineMeanMeters;
  const orderedMax = metrics.orderedOutlineMaxMeters;
  if (metrics.failedLegs === 0 && Number.isFinite(orderedMean) && Number.isFinite(orderedMax)) {
    const text = `近场最好候选的有序贴合平均 ${Math.round(orderedMean)} m / 最大 ${Math.round(orderedMax)} m`;
    log.debug('nearField.reason', {
      branch: 'ordered-outline',
      orderedOutlineMeanMeters: orderedMean,
      orderedOutlineMaxMeters: orderedMax,
      text,
    });
    return text;
  }

  // 分支 4：有部分路线但整体未走通——不编造原因，只说"未走通"
  if (metrics.failedLegs > 0) {
    log.debug('nearField.reason', {
      branch: 'route-not-through',
      failedLegs: metrics.failedLegs,
    });
    return '近场路线未走通';
  }

  // 分支 5：有路线也有 metrics，但完整性和偏差都不足以给出更具体口径
  log.debug('nearField.reason', {
    branch: 'fallback',
    failedLegs: metrics.failedLegs ?? null,
    orderedOutlineMeanMeters: orderedMean ?? null,
    orderedOutlineMaxMeters: orderedMax ?? null,
  });
  return '近场没有形成可评价的路线';
}

/**
 * 从第一级按图形记录的近场候选中选"代表候选"：adjustedScore 最高者。
 * 并列时保持 shapeKeys 的遍历顺序（先出现者胜出），与 docs "并列保持图形遍历顺序" 一致。
 *
 * @param {Object<string, object|null>} nearBests candidates.js recommendShapes 返回的近场候选表
 * @param {string[]} shapeKeys 图形遍历顺序（如 ['star', 'heart', 'rect']）
 * @returns {object|null} 代表候选；无可用候选时返回 null
 */
export function pickNearRepresentative(nearBests, shapeKeys) {
  if (!nearBests || typeof nearBests !== 'object' || !Array.isArray(shapeKeys)) {
    log.debug('nearField.representative', {
      branch: 'invalid-input',
      hasNearBests: Boolean(nearBests),
      shapeKeyCount: Array.isArray(shapeKeys) ? shapeKeys.length : null,
    });
    return null;
  }

  let best = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const shapeKey of shapeKeys) {
    const candidate = nearBests[shapeKey];
    if (!candidate) {
      continue;
    }
    // 非法 adjustedScore 记 -Infinity：不参与"更高分"竞争，但唯一候选仍可被选中
    const adjustedScore = Number.isFinite(candidate.adjustedScore)
      ? candidate.adjustedScore
      : Number.NEGATIVE_INFINITY;
    // 严格大于：并列时保留 shapeKeys 中靠前的图形
    if (best === null || adjustedScore > bestScore) {
      best = candidate;
      bestScore = adjustedScore;
    }
  }

  log.debug('nearField.representative', {
    branch: best ? 'picked' : 'none',
    shapeKey: best?.shapeKey ?? null,
    adjustedScore: Number.isFinite(bestScore) ? bestScore : null,
  });
  return best;
}

/**
 * 拼装偏移说明整句（plan/recommend 两条链路共用同一套模板）。
 *
 * - kind === 'plan'：允许最后补"可以换个图形或地点"；
 * - kind === 'recommend'：只说代表候选这一条，不声称"三种图形都因同一原因失败"；
 * - 其余 kind 按 plan 处理（调用方只需区分这两条链路）。
 *
 * @param {object} options
 * @param {'plan'|'recommend'} options.kind 回复链路类型
 * @param {string} options.reason describeNearFieldFailure 返回的近场原因说明
 * @param {string|null} [options.placeSource] 地点来源（'coverage-center' 时为覆盖中心主语）
 * @param {string} options.offsetText 偏移方向与距离文本（如"东约 1.2 km"）
 * @param {string|null} [options.areaName] 实际落点附近的地标名，缺省写"路网更完整的区域"
 * @returns {string} 带"注意："前缀的偏移说明整句
 */
export function composeOffsetNotice({ kind, reason, placeSource, offsetText, areaName }) {
  const subject = offsetSubject(placeSource);
  const where = areaName ? `「${areaName}」一带` : '路网更完整的区域';
  if (kind === 'recommend') {
    const notice =
      `注意：${subject}近场画不出像样的图形（${reason}）。我扩大范围后，在${offsetText}的${where}画出来了，图上就是。` +
      '如果您要求必须画在原地，物理上做不到。';
    log.debug('offset.notice', {
      branch: 'recommend',
      placeSource: placeSource ?? null,
      reason,
      offsetText,
      areaName: areaName ?? null,
    });
    return notice;
  }
  const notice =
    `注意：${subject}画不出像样的图形（${reason}）。我扩大范围后，在${offsetText}的${where}画出来了，图上就是。` +
    '如果您要求必须画在原地，物理上做不到，可以换个图形或地点。';
  log.debug('offset.notice', {
    branch: 'plan',
    placeSource: placeSource ?? null,
    reason,
    offsetText,
    areaName: areaName ?? null,
  });
  return notice;
}
