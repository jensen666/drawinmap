/**
 * 显式约束契约（方案 2026-11-08 §3.1 / §3.3 / §4.1）。
 *
 * 解决的问题：用户显式说出的尺寸、朝向、结构要求没有贯穿到最终交付
 * （历史实测："800 米的心形"交付 6000 m、"旋转 90 度"精修后交付 100°）。
 *
 * 本模块只负责**判定**，不负责搜索、不负责回复：
 * - `buildConstraintContract`：把"用户显式要求"归一成一份契约（尺寸/朝向 + 容差）；
 * - `evaluateConstraintContract`：交付前比较"契约"与"最终候选实际值"，给出违规清单；
 * - `sizeSatisfiesConstraint` / `rotationSatisfiesConstraint`：搜索层用同一口径
 *   生成"允许的候选集合"，保证搜索阶段与交付前核验口径完全一致。
 *
 * 放在 engine 层而不是 agent 层：编排层（agent/）与引擎层（engine/）都要用它，
 * 引擎层不得反向依赖编排层。
 *
 * 纯函数模块：不依赖 DOM/网络，Node 可直接单测。
 */

/** 显式尺寸容差比例：请求尺寸的 ±12%。 */
const SIZE_TOLERANCE_RATIO = 0.12;
/** 显式尺寸容差下限（米）：小尺寸请求的绝对误差不能太大。 */
const SIZE_TOLERANCE_MIN_METERS = 60;
/** 显式尺寸容差上限（米）：大尺寸请求的绝对误差不应无上限放大。 */
const SIZE_TOLERANCE_MAX_METERS = 300;

/**
 * 显式朝向容差（度）。
 *
 * 取 5° 而不是搜索步长 15°：搜索朝向集合是 15° 一档，但**显式朝向被锁定后**
 * 实际交付朝向只可能是用户指定的那个值（精修不再做 ±10° 扰动）。
 * 容差只用来吸收"名义值 vs 实测值"的表达差异，不该放过"精修把 90° 改成 100°"
 * 这种真实违约（差 10° > 5°）。
 */
const ROTATION_TOLERANCE_DEG = 5;

/** 约束结论状态（方案 §4.1：四态，不把"没核验"写成"通过"） */
export const CONSTRAINT_STATUS = Object.freeze({
  PASS: 'pass',
  FAIL: 'fail',
  UNAVAILABLE: 'unavailable',
  NOT_APPLICABLE: 'not-applicable',
});

/**
 * 显式尺寸的工程容差（米）。
 *
 * @param {number} requestedMeters 请求尺寸（米）
 * @returns {number|null} 容差（米）；请求尺寸非法时返回 null
 */
export function sizeToleranceMeters(requestedMeters) {
  if (!Number.isFinite(requestedMeters) || requestedMeters <= 0) {
    return null;
  }
  const raw = requestedMeters * SIZE_TOLERANCE_RATIO;
  return Math.min(
    SIZE_TOLERANCE_MAX_METERS,
    Math.max(SIZE_TOLERANCE_MIN_METERS, Math.round(raw)),
  );
}

/**
 * 角度归一到 [0, 360)。
 *
 * @param {number} deg 角度
 * @returns {number|null} 归一化角度；非法输入返回 null
 */
function normalizeRotationDeg(deg) {
  if (!Number.isFinite(deg)) {
    return null;
  }
  return ((Math.round(deg) % 360) + 360) % 360;
}

/**
 * 构造显式约束契约。
 *
 * 未显式指定的约束一律标记 `explicit=false` —— **不得**把"没提"当成"必须是 0/默认"。
 * 这与现有 `rotationExplicit` 的口径一致（方案 §3.1：不另建平行状态）。
 *
 * @param {object} [input]
 * @param {number|null} [input.sizeMeters] 尺寸（米）
 * @param {boolean} [input.sizeExplicit] 尺寸是否来自用户原文
 * @param {number|null} [input.rotationDeg] 朝向（度）
 * @param {boolean} [input.rotationExplicit] 朝向是否由用户明确指定
 * @returns {{size: object, rotation: object}} 契约
 */
export function buildConstraintContract({
  sizeMeters = null,
  sizeExplicit = false,
  rotationDeg = null,
  rotationExplicit = false,
} = {}) {
  const sizeValid = sizeExplicit && Number.isFinite(sizeMeters) && sizeMeters > 0;
  const rotation = rotationExplicit ? normalizeRotationDeg(rotationDeg) : null;
  return {
    size: {
      explicit: Boolean(sizeValid),
      requestedMeters: sizeValid ? Math.round(sizeMeters) : null,
      toleranceMeters: sizeValid ? sizeToleranceMeters(sizeMeters) : null,
    },
    rotation: {
      explicit: Boolean(rotationExplicit && rotation !== null),
      requestedDeg: rotationExplicit && rotation !== null ? rotation : null,
      toleranceDeg: rotationExplicit && rotation !== null ? ROTATION_TOLERANCE_DEG : null,
    },
  };
}

/**
 * 尺寸是否满足契约（搜索层与交付前核验共用同一口径）。
 *
 * @param {number|null} actualMeters 实际尺寸（米）
 * @param {object} contract 契约
 * @returns {boolean} 未显式要求时恒为 true
 */
export function sizeSatisfiesConstraint(actualMeters, contract) {
  if (!contract?.size?.explicit) {
    return true;
  }
  if (!Number.isFinite(actualMeters)) {
    return false;
  }
  const tolerance = contract.size.toleranceMeters ?? 0;
  return Math.abs(actualMeters - contract.size.requestedMeters) <= tolerance;
}

/**
 * 朝向是否满足契约（搜索层与交付前核验共用同一口径）。
 *
 * @param {number|null} actualDeg 实际朝向（度）
 * @param {object} contract 契约
 * @returns {boolean} 未显式要求时恒为 true
 */
function rotationSatisfiesConstraint(actualDeg, contract) {
  if (!contract?.rotation?.explicit) {
    return true;
  }
  const actual = normalizeRotationDeg(actualDeg);
  if (actual === null) {
    return false;
  }
  const tolerance = contract.rotation.toleranceDeg ?? ROTATION_TOLERANCE_DEG;
  const requested = contract.rotation.requestedDeg;
  // 角度是环形量：0° 与 359° 只差 1°
  const diff = Math.abs(((actual - requested + 540) % 360) - 180);
  return diff <= tolerance;
}

/**
 * 交付前核验：比较"请求约束"与"最终候选实际值"。
 *
 * 只看实际产物，不看意图——意图对了、产物没兑现，同样是违约。
 *
 * @param {object} contract 契约
 * @param {object} [actual]
 * @param {number|null} [actual.sizeMeters] 最终交付的实际尺寸（米）
 * @param {number|null} [actual.rotationDeg] 最终交付的实际朝向（度）
 * @returns {{ok: boolean, violations: Array<object>, results: Array<object>}}
 *   results 为逐条结论，状态取自 CONSTRAINT_STATUS（四态）
 */
export function evaluateConstraintContract(contract, actual = {}) {
  const violations = [];
  const results = [];

  // 尺寸
  if (!contract?.size?.explicit) {
    results.push({
      kind: 'size',
      status: CONSTRAINT_STATUS.NOT_APPLICABLE,
      requested: null,
      actual: Number.isFinite(actual?.sizeMeters) ? Math.round(actual.sizeMeters) : null,
      tolerance: null,
      message: '用户未显式要求尺寸，不做尺寸核验',
    });
  } else {
    const requested = contract.size.requestedMeters;
    const tolerance = contract.size.toleranceMeters ?? 0;
    const value = actual?.sizeMeters;
    const ok = sizeSatisfiesConstraint(value, contract);
    const message = ok
      ? `交付尺寸 ${Math.round(value)}m 在请求的 ${requested}m ±${tolerance}m 内`
      : `交付尺寸 ${Number.isFinite(value) ? Math.round(value) : '未知'}m 违反请求的 ${requested}m ±${tolerance}m`;
    results.push({
      kind: 'size',
      status: ok ? CONSTRAINT_STATUS.PASS : CONSTRAINT_STATUS.FAIL,
      requested,
      actual: Number.isFinite(value) ? Math.round(value) : null,
      tolerance,
      message,
    });
    if (!ok) {
      violations.push({ kind: 'size', requested, actual: value ?? null, tolerance, message });
    }
  }

  // 朝向
  if (!contract?.rotation?.explicit) {
    results.push({
      kind: 'rotation',
      status: CONSTRAINT_STATUS.NOT_APPLICABLE,
      requested: null,
      actual: normalizeRotationDeg(actual?.rotationDeg),
      tolerance: null,
      message: '用户未显式要求朝向，不做朝向核验',
    });
  } else {
    const requested = contract.rotation.requestedDeg;
    const tolerance = contract.rotation.toleranceDeg ?? ROTATION_TOLERANCE_DEG;
    const value = normalizeRotationDeg(actual?.rotationDeg);
    const ok = rotationSatisfiesConstraint(value, contract);
    const message = ok
      ? `交付朝向 ${value}° 在请求的 ${requested}° ±${tolerance}° 内`
      : `交付朝向 ${value === null ? '未知' : `${value}°`} 违反请求的 ${requested}° ±${tolerance}°`;
    results.push({
      kind: 'rotation',
      status: ok ? CONSTRAINT_STATUS.PASS : CONSTRAINT_STATUS.FAIL,
      requested,
      actual: value,
      tolerance,
      message,
    });
    if (!ok) {
      violations.push({ kind: 'rotation', requested, actual: value, tolerance, message });
    }
  }

  return { ok: violations.length === 0, violations, results };
}

/**
 * 把违规清单拼成一句用户可读的话（明确差异，不含糊）。
 *
 * @param {Array<object>} violations 违规清单
 * @returns {string} 可读描述；无违规返回空串
 */
export function describeConstraintViolations(violations) {
  const list = Array.isArray(violations) ? violations : [];
  if (list.length === 0) {
    return '';
  }
  return list.map((item) => item?.message).filter(Boolean).join('；');
}
