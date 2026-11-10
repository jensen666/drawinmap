/**
 * 交付结果的分维度评定（方案 2026-11-05 §5.1）。
 *
 * 此前 E2E 只有一个"契约通过"布尔值，地图为绿就算通过——绿色只表示既有图形/路线
 * 质量门通过，不代表地点合理、路线成本可接受。本模块把结果拆成互相独立的维度：
 *
 * - contractPass：回复、绘制状态、来源与诚实性是否符合契约；
 * - targetPass：请求对象与目标语义是否完整（请求对象 = 实际交付对象）；
 * - locationStatus：实际中心相对请求地点是否合理（默认「附近/原地」偏移 ≤ 1 km）；
 * - routeCostStatus：尺寸、路线长度与步行时间是否超出本次**观察口径**；
 * - overallPass：必须由上面四项共同推出，**不得只由地图为绿色推出**。
 *
 * 观察口径（routeCost / location）只用于报告标红，不改变产品交付闸门——
 * 方案 §2.2 明确"不把固定 15 km / 3 km / 3 h 等默认阈值直接变成无交付硬门"。
 *
 * 纯函数模块：Node 可直接单测，E2E 报告与产品日志共用同一套口径。
 */

/** 默认「附近/原地」偏移上限（米）：超过即在报告中显式标红 */
export const DEFAULT_LOCATION_LIMIT_METERS = 1000;

/**
 * 默认路线成本观察口径（只用于报告，不作为交付硬门）。
 * sizeMeters 缺省不判：尺寸由全尺寸阶梯搜索裁决，用户显式尺寸另有口径。
 */
export const DEFAULT_ROUTE_COST_LIMITS = Object.freeze({
  sizeMeters: null,
  routeMeters: 15000,
  walkMinutes: 180,
});

/**
 * 用户是否明确授权了「可以画在别处 / 范围大一点」。
 *
 * 保守判定：只认明确的授权措辞，避免把普通描述当成授权。
 * 授权时偏移事实仍然记录，但状态降级为 'authorized'（提示而非缺陷）。
 *
 * @param {string} text 用户原文
 * @returns {boolean}
 */
export function detectScopeWidening(text) {
  const raw = String(text ?? '');
  if (!raw) {
    return false;
  }
  const patterns = [
    /范围(?:可以)?大(?:一)?点/,
    /范围(?:可以)?放宽/,
    /离得远点?也?行/,
    /(?:在哪|哪儿)都?行/,
    /远一点(?:也)?(?:行|没关系)/,
    /不用(?:太)?近/,
    /附近.*(?:就行|都行)/,
  ];
  return patterns.some((pattern) => pattern.test(raw));
}

/**
 * 成本维度判定：任一指标超限即 'over'；没有数据即 'unknown'。
 *
 * @param {object} input
 * @param {number|null} input.sizeMeters 交付尺寸（米）
 * @param {number|null} input.routeMeters 路线长度（米）
 * @param {number|null} input.walkMinutes 步行时间（分钟）
 * @param {object} [input.limits] 观察口径上限
 * @param {boolean} [input.authorized] 用户是否授权了超出范围
 * @returns {{status: 'ok'|'over'|'unknown'|'authorized', over: string[], limits: object}}
 */
export function evaluateRouteCost({
  sizeMeters = null,
  routeMeters = null,
  walkMinutes = null,
  limits = {},
  authorized = false,
} = {}) {
  const effective = { ...DEFAULT_ROUTE_COST_LIMITS, ...(limits || {}) };
  const over = [];
  const check = (value, limit, label) => {
    if (limit == null || !Number.isFinite(value) || !Number.isFinite(limit)) {
      return;
    }
    if (value > limit) {
      over.push(`${label}=${Math.round(value)}（上限 ${Math.round(limit)}）`);
    }
  };
  check(sizeMeters, effective.sizeMeters, '尺寸 m');
  check(routeMeters, effective.routeMeters, '路线 m');
  check(walkMinutes, effective.walkMinutes, '步行 min');
  const hasData = Number.isFinite(sizeMeters) || Number.isFinite(routeMeters) || Number.isFinite(walkMinutes);
  if (!hasData) {
    return { status: 'unknown', over: [], limits: effective };
  }
  if (over.length === 0) {
    return { status: 'ok', over: [], limits: effective };
  }
  return { status: authorized ? 'authorized' : 'over', over, limits: effective };
}

/**
 * 落点维度判定：实际中心相对请求地点的偏移。
 *
 * @param {object} input
 * @param {number|null} input.offsetMeters 偏移（米）
 * @param {number|null} [input.limitMeters] 偏移上限（默认 1 km）
 * @param {boolean} [input.authorized] 用户是否授权了超出范围
 * @returns {{status: 'ok'|'over'|'unknown'|'authorized', meters: number|null, limit: number}}
 */
export function evaluateLocation({ offsetMeters = null, limitMeters = DEFAULT_LOCATION_LIMIT_METERS, authorized = false } = {}) {
  const limit = Number.isFinite(limitMeters) ? limitMeters : DEFAULT_LOCATION_LIMIT_METERS;
  if (!Number.isFinite(offsetMeters)) {
    return { status: 'unknown', meters: null, limit };
  }
  if (offsetMeters > limit) {
    return { status: authorized ? 'authorized' : 'over', meters: offsetMeters, limit };
  }
  return { status: 'ok', meters: offsetMeters, limit };
}

/**
 * 交付结果分维度评定（方案 2026-11-05 §5.1）。
 *
 * @param {object} input
 * @param {boolean} [input.contractPass] 契约维度结论
 * @param {object} [input.contractDetails] 契约维度明细
 * @param {boolean} [input.targetPass] 目标维度结论（请求对象 = 实际交付对象）
 * @param {object} [input.targetDetails] 目标维度明细
 * @param {number|null} [input.offsetMeters] 实际中心相对请求地点的偏移（米）
 * @param {number|null} [input.sizeMeters] 交付尺寸（米）
 * @param {number|null} [input.routeMeters] 路线长度（米）
 * @param {number|null} [input.walkMinutes] 步行时间（分钟）
 * @param {number|null} [input.locationLimitMeters] 偏移上限
 * @param {object} [input.routeCostLimits] 路线成本观察口径
 * @param {boolean} [input.scopeWidened] 用户是否明确授权扩大范围
 * @param {boolean} [input.delivered] 本轮是否有交付
 * @param {boolean} [input.reference] 交付是否为非合格参考版（橙色）
 * @param {boolean} [input.constraintCompliant] 显式约束（尺寸/朝向/结构）是否全部满足
 * @param {boolean} [input.covered] 本轮是否走到了预期分支
 * @returns {{
 *   contractPass: boolean, targetPass: boolean,
 *   locationStatus: 'ok'|'over'|'unknown'|'authorized',
 *   routeCostStatus: 'ok'|'over'|'unknown'|'authorized',
 *   overallPass: boolean, delivered: boolean,
 *   deliveryOutcome: string, deliveryOutcomeReasons: string[],
 *   details: object
 * }}
 */
export function evaluateDeliveryReport({
  contractPass = false,
  contractDetails = null,
  targetPass = true,
  targetDetails = null,
  offsetMeters = null,
  sizeMeters = null,
  routeMeters = null,
  walkMinutes = null,
  locationLimitMeters = DEFAULT_LOCATION_LIMIT_METERS,
  routeCostLimits = {},
  scopeWidened = false,
  delivered = false,
  reference = false,
  constraintCompliant = true,
  covered = true,
} = {}) {
  const location = evaluateLocation({ offsetMeters, limitMeters: locationLimitMeters, authorized: scopeWidened });
  const cost = evaluateRouteCost({
    sizeMeters,
    routeMeters,
    walkMinutes,
    limits: routeCostLimits,
    authorized: scopeWidened,
  });
  const locationStatus = location.status;
  const routeCostStatus = cost.status;
  // overallPass 必须由契约 + 目标 + 落点 + 成本共同推出，不得只由地图为绿色推出
  const overallPass =
    Boolean(contractPass) &&
    Boolean(targetPass) &&
    locationStatus !== 'over' &&
    routeCostStatus !== 'over';
  // 交付结果类别（方案 2026-11-08 §6.3）：独立字段，不改写 overallPass 的历史口径
  const outcome = classifyDeliveryOutcome({
    covered,
    delivered: Boolean(delivered),
    reference: Boolean(reference),
    contractPass: Boolean(contractPass),
    targetPass: Boolean(targetPass),
    constraintCompliant: constraintCompliant !== false,
    authorized: Boolean(scopeWidened),
    honestFailure: !delivered && Boolean(contractPass),
  });
  return {
    contractPass: Boolean(contractPass),
    targetPass: Boolean(targetPass),
    locationStatus,
    routeCostStatus,
    overallPass,
    delivered: Boolean(delivered),
    deliveryOutcome: outcome.outcome,
    deliveryOutcomeReasons: outcome.reasons,
    details: {
      offsetMeters: Number.isFinite(offsetMeters) ? Math.round(offsetMeters) : null,
      locationLimitMeters: location.limit,
      sizeMeters: Number.isFinite(sizeMeters) ? Math.round(sizeMeters) : null,
      routeMeters: Number.isFinite(routeMeters) ? Math.round(routeMeters) : null,
      walkMinutes: Number.isFinite(walkMinutes) ? Math.round(walkMinutes) : null,
      routeCostLimits: cost.limits,
      routeCostOver: cost.over,
      scopeWidened: Boolean(scopeWidened),
      contractDetails,
      targetDetails,
    },
  };
}

/**
 * 交付结果类别（方案 2026-11-08 §6.3）。
 *
 * 与既有 `overallPass` **并存**，不改写历史口径：新字段只回答"这一轮到底是哪种结果"，
 * 让"合格出图 / 授权的折中 / 诊断参考 / 诚实未交付 / 错误交付 / 分支未覆盖"可分别统计。
 */
export const DELIVERY_OUTCOMES = Object.freeze({
  /** 合格交付：绿线 + 契约/目标/约束全部通过 */
  QUALIFIED: 'qualified-delivery',
  /** 用户明确授权后的折中交付（范围/成本越界但已授权） */
  AUTHORIZED_COMPROMISE: 'authorized-compromise',
  /** 诊断性参考：画了但明确标注为非合格（橙色虚线） */
  DIAGNOSTIC_REFERENCE: 'diagnostic-reference',
  /** 诚实未交付：没有交付，但如实说明了原因 */
  HONEST_NO_DELIVERY: 'honest-no-delivery',
  /** 错误交付：交付了，但对象/约束/契约不成立 */
  INCORRECT_DELIVERY: 'incorrect-delivery',
  /** 分支未覆盖：这一轮没有走到该用例预期的分支 */
  NOT_COVERED: 'not-covered',
});

/**
 * 交付结果分类（方案 2026-11-08 §6.3）。
 *
 * 判定顺序（先排除未覆盖，再看是否交付，最后看交付是否成立）：
 * 1. 未覆盖 → not-covered（这一轮没走到预期分支，不算失败也不算成功）；
 * 2. 交付了但对象/约束/契约不成立 → incorrect-delivery（**最严重**，不允许被算成合格）；
 * 3. 交付了但只是橙色参考 → diagnostic-reference；
 * 4. 交付了且用户已授权越界 → authorized-compromise；
 * 5. 交付了且全部通过 → qualified-delivery；
 * 6. 没交付 → honest-no-delivery。
 *
 * @param {object} input
 * @param {boolean} [input.covered] 本轮是否走到了预期分支（默认 true）
 * @param {boolean} [input.delivered] 是否产生了交付（绿线或橙色参考）
 * @param {boolean} [input.reference] 交付是否为非合格参考版（橙色）
 * @param {boolean} [input.contractPass] 契约维度结论
 * @param {boolean} [input.targetPass] 目标维度结论（请求对象 = 实际交付对象）
 * @param {boolean} [input.constraintCompliant] 显式约束（尺寸/朝向/结构）是否全部满足
 * @param {boolean} [input.authorized] 用户是否明确授权了越界（范围/成本）
 * @param {boolean} [input.honestFailure] 未交付时是否如实说明了原因
 * @returns {{outcome: string, reasons: string[]}}
 */
export function classifyDeliveryOutcome({
  covered = true,
  delivered = false,
  reference = false,
  contractPass = true,
  targetPass = true,
  constraintCompliant = true,
  authorized = false,
  honestFailure = false,
} = {}) {
  if (!covered) {
    return { outcome: DELIVERY_OUTCOMES.NOT_COVERED, reasons: ['本轮未走到该用例预期的分支'] };
  }
  if (delivered) {
    const broken = [];
    if (!contractPass) {
      broken.push('契约维度未通过');
    }
    if (!targetPass) {
      broken.push('请求对象与实际交付对象不一致');
    }
    if (!constraintCompliant) {
      broken.push('用户显式约束未被满足');
    }
    if (broken.length > 0) {
      return { outcome: DELIVERY_OUTCOMES.INCORRECT_DELIVERY, reasons: broken };
    }
    if (reference) {
      return {
        outcome: DELIVERY_OUTCOMES.DIAGNOSTIC_REFERENCE,
        reasons: ['交付为非合格参考版（橙色虚线），已明确标注'],
      };
    }
    if (authorized) {
      return {
        outcome: DELIVERY_OUTCOMES.AUTHORIZED_COMPROMISE,
        reasons: ['用户已明确授权越界（范围/成本），按授权交付'],
      };
    }
    return { outcome: DELIVERY_OUTCOMES.QUALIFIED, reasons: [] };
  }
  if (honestFailure) {
    return { outcome: DELIVERY_OUTCOMES.HONEST_NO_DELIVERY, reasons: ['未交付，但如实说明了原因'] };
  }
  return {
    outcome: DELIVERY_OUTCOMES.NOT_COVERED,
    reasons: ['未产生交付，且没有明确的诚实失败说明'],
  };
}

/**
 * 汇总一组用例的分维度结果（报告用）。
 *
 * @param {Array<object>} reports 每例的 evaluateDeliveryReport 结果
 * @returns {object} 汇总
 */
export function summarizeDeliveryReports(reports) {
  const list = Array.isArray(reports) ? reports : [];
  const count = (predicate) => list.filter(predicate).length;
  const overLocations = list.filter((item) => item?.locationStatus === 'over');
  const overCosts = list.filter((item) => item?.routeCostStatus === 'over');
  /** 交付结果类别分布（方案 2026-11-08 §6.3）：六类分别统计 */
  const outcomeCounts = {};
  for (const outcome of Object.values(DELIVERY_OUTCOMES)) {
    outcomeCounts[outcome] = 0;
  }
  for (const item of list) {
    const outcome = item?.deliveryOutcome;
    if (outcome && outcome in outcomeCounts) {
      outcomeCounts[outcome] += 1;
    }
  }
  return {
    total: list.length,
    contractPass: count((item) => item?.contractPass),
    targetPass: count((item) => item?.targetPass),
    overallPass: count((item) => item?.overallPass),
    locationOk: count((item) => item?.locationStatus === 'ok'),
    locationOver: overLocations.length,
    locationAuthorized: count((item) => item?.locationStatus === 'authorized'),
    locationUnknown: count((item) => item?.locationStatus === 'unknown'),
    routeCostOk: count((item) => item?.routeCostStatus === 'ok'),
    routeCostOver: overCosts.length,
    routeCostAuthorized: count((item) => item?.routeCostStatus === 'authorized'),
    routeCostUnknown: count((item) => item?.routeCostStatus === 'unknown'),
    // 交付结果类别分布
    outcomeCounts,
    qualifiedDelivery: outcomeCounts[DELIVERY_OUTCOMES.QUALIFIED],
    authorizedCompromise: outcomeCounts[DELIVERY_OUTCOMES.AUTHORIZED_COMPROMISE],
    diagnosticReference: outcomeCounts[DELIVERY_OUTCOMES.DIAGNOSTIC_REFERENCE],
    honestNoDelivery: outcomeCounts[DELIVERY_OUTCOMES.HONEST_NO_DELIVERY],
    incorrectDelivery: outcomeCounts[DELIVERY_OUTCOMES.INCORRECT_DELIVERY],
    notCovered: outcomeCounts[DELIVERY_OUTCOMES.NOT_COVERED],
    // 标红清单：哪几例越界，越了什么
    flagged: list
      .map((item, index) => ({
        index,
        locationStatus: item?.locationStatus ?? 'unknown',
        routeCostStatus: item?.routeCostStatus ?? 'unknown',
        offsetMeters: item?.details?.offsetMeters ?? null,
        routeMeters: item?.details?.routeMeters ?? null,
        walkMinutes: item?.details?.walkMinutes ?? null,
        deliveryOutcome: item?.deliveryOutcome ?? null,
      }))
      .filter((item) => item.locationStatus === 'over' || item.routeCostStatus === 'over'),
  };
}
