/**
 * 统一目标语义验收入口（方案 §8）。
 *
 * 目标语义验收先于正式路网规划与绿线交付：拓扑非法时完全不规划；拓扑合法但
 * 目标不像、规格不符或验收未完成时，只允许以非合格参考版为目的的诊断性规划，
 * 或直接诚实失败，绝不给合格绿线（方案 §2 原则 5、§8.5）。
 *
 * 验收依据随来源不同，交付门槛一致（方案 §8.1）：
 * - 参数化规则生成（procedural）：S 结构合法性 + T 是否精确满足 S 的几何不变量
 *   （确定性检查，无需视觉质检——规则图形优先确定性检查，方案 §13 风险表）。
 * - 参考图生成（reference）：参考模块已做几何/拓扑校验，验收记录来源与结论。
 * - 图像描摹生成（traced，方案 2026-11-01 §3）：拓扑合法 + 点数在描摹区间 + 描摹 IoU
 *   达标（确定性检查，无需视觉质检——描摹点列直接来自掩膜，不存在"像不像"的判断）。
 * - LLM 自由生成（freeform）：拓扑合法 + 用户显式约束逐项通过 + 视觉质检明确
 *   结论为 like——三者是合取，任一必要条件失败即不通过；视觉结论缺失/不明
 *   一律按"验收不可用"处理，不得给合格绿线（绿线否决权）。
 * - 内置图形（builtin）：轮廓由几何定义保证，验收记录来源。
 *
 * 特征角色隔离（方案 §8.2）：userConstraints 具有目标否决权；LLM 自行声明的
 * generatorGuides 与几何检测的 detectedFeatures 都没有——本模块不会因声明特征、
 * 映射距离或特征覆盖算法变化改判目标不合格。
 */

import { validateSimplePolygon, validateDisjointParts } from './shape-validate.js';
import { checkSpecInvariants } from './shape-spec.js';
import {
  IMAGE_TRACE_IOU_MIN,
  IMAGE_TRACE_POINT_MAX,
  IMAGE_TRACE_POINT_MIN,
} from './image-trace.js';
import {
  FREEFORM_COMPLEX_FEATURE_MIN,
  FREEFORM_COMPLEX_POINT_MAX,
  FREEFORM_COMPLEX_POINT_MIN,
  FREEFORM_COMPLEX_POINT_RELAXED_MIN,
  freeformPointMax,
} from './point-budget.js';
import { detectPossibleConstraintText } from './constraint-detect.js';
import { CONSTRAINT_STATUS } from '../engine/constraint-contract.js';

/**
 * 统一约束结论条目（方案 2026-11-08 §4.1）。
 *
 * 所有来源输出同一结构，状态四态：
 * - pass：已核验且满足；
 * - fail：已核验且不满足；
 * - unavailable：必要核验不可用/结论不明/未完成——**不得**当作通过；
 * - not-applicable：该项对本次来源不适用（例如用户没有提结构要求）。
 *
 * @param {object} input
 * @param {string} input.kind 约束种类（topology/structure/semantic/objects/user-constraint…）
 * @param {string} input.status 四态之一
 * @param {string|null} [input.requested] 用户要求原文
 * @param {string|null} [input.actual] 实际结果
 * @param {string|null} [input.tolerance] 容差口径
 * @param {string} [input.message] 可读说明
 * @returns {object} 约束结论条目
 */
function buildConstraintResult({
  kind,
  status,
  requested = null,
  actual = null,
  tolerance = null,
  message = '',
}) {
  return { kind, status, requested, actual, tolerance, message };
}

/** 质检结论 → 约束四态状态（pass/like→pass；fail/unlike→fail；其余→unavailable，不得当成通过）。 */
function constraintStatusOf(verdict) {
  if (verdict === 'pass' || verdict === 'like') {
    return CONSTRAINT_STATUS.PASS;
  }
  if (verdict === 'fail' || verdict === 'unlike') {
    return CONSTRAINT_STATUS.FAIL;
  }
  return CONSTRAINT_STATUS.UNAVAILABLE;
}

/**
 * 结构约束条目（内置图形 / 参考图共用）：用户显式约束的质检裁决 → 统一条目。
 * @param {{verdict: string, results: Array<object>}} judged judgeConstraintsByReview 结果
 * @param {string[]} required 用户显式约束清单（调用方保证非空）
 * @param {{pass: string, fail: string, unavailable: string}} messages 三态可读说明
 */
function structureConstraintResult(judged, required, messages) {
  const message =
    judged.verdict === 'pass' ? messages.pass : judged.verdict === 'fail' ? messages.fail : messages.unavailable;
  return buildConstraintResult({
    kind: 'structure',
    status: constraintStatusOf(judged.verdict),
    requested: required.join('、'),
    message,
  });
}

/** 拓扑复验约束条目（参考图 / 自由轮廓共用；通过与否的可读说明固定）。 */
function topologyConstraintResult(topologyOk) {
  return buildConstraintResult({
    kind: 'topology',
    status: topologyOk ? CONSTRAINT_STATUS.PASS : CONSTRAINT_STATUS.FAIL,
    actual: topologyOk ? '拓扑合法' : '拓扑不合法',
    message: topologyOk ? '拓扑复验通过' : '拓扑复验不通过',
  });
}

/**
 * 约束清单 → 逐条结论条目（用户显式约束被质检逐项核对后的结果）。
 *
 * @param {Array<string>} userConstraints 用户显式约束清单
 * @param {object|null} constraintSummary summarizeConstraints 的结果
 * @returns {Array<object>} 约束结论条目
 */
function buildUserConstraintResults(userConstraints, constraintSummary) {
  const required = (userConstraints || []).filter((item) => typeof item === 'string' && item.trim());
  if (required.length === 0) {
    return [];
  }
  const failed = new Set(constraintSummary?.failed || []);
  const unavailable = constraintSummary?.unavailable === true;
  return required.map((text) => {
    if (unavailable) {
      return buildConstraintResult({
        kind: 'user-constraint',
        status: CONSTRAINT_STATUS.UNAVAILABLE,
        requested: text,
        message: `约束「${text}」未能逐项核对（质检没有给出逐项结论）`,
      });
    }
    if (failed.has(text)) {
      return buildConstraintResult({
        kind: 'user-constraint',
        status: CONSTRAINT_STATUS.FAIL,
        requested: text,
        message: `约束「${text}」未满足`,
      });
    }
    return buildConstraintResult({
      kind: 'user-constraint',
      status: CONSTRAINT_STATUS.PASS,
      requested: text,
      message: `约束「${text}」已核对通过`,
    });
  });
}

/**
 * 自由轮廓点数闸门（方案 2026-11-01 §3/§5.1，2026-11-05 §7.2 口径统一）：
 * 复杂剪影（LLM 声明的鲜明特征不少于 3 个）的点数必须落在 [80, 120 × 部分数]——
 * 点数过少特征走样、贴到路网更像机械符号；上限沿用每部分 120 点
 * （多部分目标按部分数放宽）。
 *
 * 常量与生成/修正提示**同源**（point-budget.js）：此前提示写"每部分最多 240 点"、
 * 验收按 120 点执行，两处口径矛盾；现已统一到 120，验收闸门本身不放宽。
 *
 * 复杂度只按声明特征判定：customShape.features 里由 LLM 写出的 kind==='declared'
 * 条目；detectFeatures 自动检出的 notch/gap/identity 是几何形状的产物，任何轮廓
 * 都可能检出若干个，拿它们判"复杂剪影"会让 simple 档对 LLM 输出几乎不可达
 * （§5.1 的 features 语境是 LLM 声明的鲜明特征）。
 * 声明特征少于 3 个的简单图形只按生成提示 8~20 点，不做验收拒绝。
 */
export { FREEFORM_COMPLEX_FEATURE_MIN, FREEFORM_COMPLEX_POINT_MAX, FREEFORM_COMPLEX_POINT_MIN, FREEFORM_COMPLEX_POINT_RELAXED_MIN };

/**
 * 从归一化 customShape 提取各部分闭环点列（拓扑复验用）。
 *
 * @param {object} customShape 归一化 customShape
 * @returns {Array<Array<[number, number]>>} 每部分的闭环点列
 */
export function extractPartLoops(customShape) {
  const parts = customShape.parts || [];
  if (parts.length > 1) {
    return parts.map((part) =>
      customShape.outlinePoints.slice(part.outlineStart, part.outlineStart + part.outlineCount),
    );
  }
  return [customShape.outlinePoints];
}

/**
 * 基础拓扑复验（所有来源都必须过；程序生成不等于可以省略结果验证，方案 §8.1）。
 *
 * @param {object} customShape 归一化 customShape
 * @returns {{ok: boolean, reasons: string[]}}
 */
export function checkTopology(customShape) {
  const reasons = [];
  const loops = extractPartLoops(customShape);
  loops.forEach((loop, index) => {
    const topology = validateSimplePolygon(loop);
    if (!topology.ok) {
      reasons.push(`第 ${index + 1} 部分拓扑不合法：${topology.reason}`);
    }
  });
  for (let i = 0; i < loops.length; i += 1) {
    for (let j = i + 1; j < loops.length; j += 1) {
      const disjoint = validateDisjointParts(loops[i], loops[j]);
      if (!disjoint.ok) {
        reasons.push(`第 ${i + 1}/${j + 1} 部分${disjoint.reason}`);
      }
    }
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * 依据视觉质检结论裁决「用户显式约束」这一项（方案 2026-11-08 §4.1）。
 *
 * 用于目标**不可由模型重新生成**的来源（参考素材 / 内置图形 / 图像描摹）：
 * 这类来源没有"重生成一版再复检"的余地，只能借质检能力逐项核对；
 * 核不了就不给绿线（verdict=unavailable → 橙色参考或诚实失败），不得假装已验收。
 *
 * @param {object|null} review 质检闭环结果（verifyConstraintsByReview 的输出）
 * @param {Array<string>|null} userConstraints 用户显式约束清单
 * @returns {{verdict: 'pass'|'fail'|'unavailable', reasons: string[], results: Array<object>}}
 */
function judgeConstraintsByReview(review, userConstraints) {
  const required = (userConstraints || []).filter((item) => typeof item === 'string' && item.trim());
  if (required.length === 0) {
    return { verdict: 'pass', reasons: [], results: [] };
  }
  if (!review || review.available !== true || review.verdict === 'unknown') {
    return {
      verdict: 'unavailable',
      reasons: [
        `用户显式约束未逐项核对（质检${review ? '结论不明' : '未执行'}）：${required.join('、')}`,
      ],
      results: buildUserConstraintResults(required, { unavailable: true, failed: required }),
    };
  }
  const summary = review.constraintSummary;
  const results = buildUserConstraintResults(required, summary);
  if (review.verdict === 'unlike') {
    return {
      verdict: 'fail',
      reasons: [
        `质检结论为不像，用户的显式要求未能满足：${(review.issues || []).join('；') || required.join('、')}`,
      ],
      results: results.map((item) =>
        item.status === CONSTRAINT_STATUS.PASS
          ? buildConstraintResult({
              kind: item.kind,
              status: CONSTRAINT_STATUS.FAIL,
              requested: item.requested,
              message: `约束「${item.requested}」未满足（整体质检结论为不像）`,
            })
          : item,
      ),
    };
  }
  if (!summary || !summary.ok) {
    return {
      verdict: summary?.unavailable ? 'unavailable' : 'fail',
      reasons: [
        summary?.unavailable
          ? '用户显式约束未逐项核对（质检未返回逐项结论）'
          : `用户显式约束未满足：${(summary?.failed || required).join('、')}`,
      ],
      results,
    };
  }
  return { verdict: 'pass', reasons: [], results };
}

/**
 * 参数化目标验收：S 结构合法性 + T 几何不变量 + 拓扑复验。
 *
 * @param {object} customShape 由 buildShapeFromSpec 生成的归一化 customShape
 * @param {object} spec 规范化 ShapeSpec
 * @returns {{verdict: 'pass'|'fail', reasons: string[], checks: object, constraintResults: Array<object>}}
 */
export function acceptProceduralTarget(customShape, spec, { userConstraints = null } = {}) {
  const checks = { source: 'procedural', family: spec?.family ?? null };
  const constraintResults = [];
  if (!spec) {
    constraintResults.push(
      buildConstraintResult({
        kind: 'structure',
        status: CONSTRAINT_STATUS.FAIL,
        message: '缺少图形规格 S，无法核验结构约束',
      }),
    );
    return { verdict: 'fail', reasons: ['缺少图形规格 S'], checks, constraintResults };
  }
  const topology = checkTopology(customShape);
  checks.topology = topology.ok;
  constraintResults.push(
    buildConstraintResult({
      kind: 'topology',
      status: topology.ok ? CONSTRAINT_STATUS.PASS : CONSTRAINT_STATUS.FAIL,
      actual: topology.ok ? '拓扑合法' : topology.reasons.join('；'),
      message: topology.ok ? '拓扑复验通过（不自交、不退化、部分互不嵌套）' : topology.reasons.join('；'),
    }),
  );
  if (!topology.ok) {
    return { verdict: 'fail', reasons: topology.reasons, checks, constraintResults };
  }
  const invariants = checkSpecInvariants(customShape, spec);
  checks.invariants = invariants.ok;
  checks.cornerCount = invariants.cornerCount;
  constraintResults.push(
    buildConstraintResult({
      kind: 'structure',
      status: invariants.ok ? CONSTRAINT_STATUS.PASS : CONSTRAINT_STATUS.FAIL,
      requested: describeShapeSpecBrief(spec),
      actual: invariants.ok ? `几何不变量通过（角点 ${invariants.cornerCount}）` : invariants.reasons.join('；'),
      message: invariants.ok
        ? `实际规格满足结构约束（${describeShapeSpecBrief(spec)}）`
        : `实际规格不满足结构约束：${invariants.reasons.join('；')}`,
    }),
  );
  if (!invariants.ok) {
    return { verdict: 'fail', reasons: invariants.reasons, checks, constraintResults };
  }
  // 用户显式约束与规格的对应关系（方案 2026-11-08 §4.1）：
  // 参数化来源的确定性核验是"规格参数 + 几何不变量"——规格声明了用户约束、
  // 且实际几何通过不变量复验时，该约束记为已核验；规格没声明对应约束时记为
  // unavailable（不假装已验收），但**不**单独否决交付（几何不变量才是硬门）。
  const specConstraintTexts = (spec.userConstraints || [])
    .map((item) => (typeof item === 'string' ? item : item?.text))
    .filter((item) => typeof item === 'string' && item.trim());
  const required = (userConstraints || []).filter((item) => typeof item === 'string' && item.trim());
  for (const text of required) {
    const encoded = specConstraintTexts.some(
      (declared) => declared === text || declared.includes(text) || text.includes(declared),
    );
    constraintResults.push(
      buildConstraintResult({
        kind: 'user-constraint',
        status: encoded ? CONSTRAINT_STATUS.PASS : CONSTRAINT_STATUS.UNAVAILABLE,
        requested: text,
        actual: encoded ? describeShapeSpecBrief(spec) : null,
        message: encoded
          ? `约束「${text}」已编码进参数化规格（${describeShapeSpecBrief(spec)}），几何不变量复验通过`
          : `约束「${text}」没有对应的规格参数，无法逐项核对（几何不变量复验仍通过）`,
      }),
    );
  }
  if (required.length === 0) {
    constraintResults.push(
      buildConstraintResult({
        kind: 'user-constraint',
        status: CONSTRAINT_STATUS.NOT_APPLICABLE,
        message: '用户未提出可逐项核对的显式约束',
      }),
    );
  }
  return { verdict: 'pass', reasons: [], checks, constraintResults };
}

/**
 * 规格的可读摘要（结构约束结论里说明"核对的是哪份规格"）。
 *
 * @param {object} spec 规范化 ShapeSpec
 * @returns {string}
 */
function describeShapeSpecBrief(spec) {
  if (!spec || typeof spec !== 'object') {
    return '（缺规格）';
  }
  const parts = [spec.family, spec.variant].filter(Boolean).join('/');
  const radii = Array.isArray(spec.innerRadii) && Array.isArray(spec.outerRadii)
    ? '逐尖半径'
    : '内外半径';
  const ratio =
    Number.isFinite(spec.innerRadii) && Number.isFinite(spec.outerRadii) && spec.outerRadii > 0
      ? `（内/外=${(spec.innerRadii / spec.outerRadii).toFixed(3)}）`
      : '';
  return `${parts}${parts ? ' ' : ''}${radii}${ratio}`;
}

/**
 * 内置图形目标验收：轮廓由几何定义（buildStar/buildHeart/buildRect）保证。
 *
 * 用户提出无法用内置图形表达的附加要求时，**不得假装已验收**：
 * 只有质检逐项核对通过才放行；核不了即 unavailable（不得绿线）。
 *
 * @param {object} [options]
 * @param {object|null} [options.review] 质检结论（verifyConstraintsByReview）
 * @param {Array<string>|null} [options.userConstraints] 用户显式约束清单
 * @returns {{verdict: 'pass'|'fail'|'unavailable', reasons: string[], checks: object, constraintResults: Array<object>}}
 */
export function acceptBuiltinTarget({ review = null, userConstraints = null } = {}) {
  const required = (userConstraints || []).filter((item) => typeof item === 'string' && item.trim());
  const checks = { source: 'builtin' };
  if (required.length === 0) {
    return {
      verdict: 'pass',
      reasons: [],
      checks,
      constraintResults: [
        buildConstraintResult({
          kind: 'structure',
          status: CONSTRAINT_STATUS.NOT_APPLICABLE,
          message: '内置图形的几何由数学定义保证，用户未提出附加结构要求',
        }),
      ],
    };
  }
  const judged = judgeConstraintsByReview(review, required);
  checks.constraintReview = review?.verdict ?? null;
  const constraintResults = [
    structureConstraintResult(judged, required, {
      pass: '内置图形的附加要求已逐项核对通过',
      fail: '内置图形无法用几何定义表达用户的附加要求，已借质检逐项核对',
      unavailable: '内置图形无法用几何定义表达用户的附加要求，已借质检逐项核对',
    }),
    ...judged.results,
  ];
  if (judged.verdict !== 'pass') {
    return { verdict: judged.verdict, reasons: judged.reasons, checks, constraintResults };
  }
  return { verdict: 'pass', reasons: [], checks, constraintResults };
}

/**
 * 参考图目标验收（方案 2026-10-31 §8）：拓扑复验 + 按来源/审核状态的语义依据检查。
 *
 * - 本地正式库（curated）：必须带人工审核通过记录（review.status=approved +
 *   review.visual=like），且 review.sha256 与 sourceSha256 一致——审核绑定素材版本，
 *   素材变化后审核失效，不得正式规划；
 * - 在线（unreviewed）：未选择 → unavailable（不得正式规划）；已被用户选择 →
 *   必须携带与待选快照一致的 user-selection 确认（choiceId/candidateId/contentHash
 *   三者对上）。用户确认只适用于当前选择快照和当前 T，不把在线素材提升为
 *   全局人工精选素材（后续请求再次使用该在线缓存时仍需本轮确认）。
 *
 * 这是 UI 之外的第二道验收防御：即使因界面 bug 直接提交在线未确认候选，
 * 也不能放行正式规划（方案 §8 防御要求）。
 *
 * @param {object} customShape 参考图转换出的归一化 customShape
 * @param {object|null} referenceSource 参考命中信息（id/origin/reviewStatus/sourceSha256/
 *   contentHash/choiceId/candidateId/confirmation/review）
 * @returns {{verdict: 'pass'|'fail'|'unavailable', reasons: string[], checks: object}}
 */
/**
 * 把「用户显式约束」的裁决结果并入来源验收结论（方案 2026-11-08 §4.1）。
 *
 * 没有用户约束时补一条 not-applicable 的结构条目（明确「没有要求」不等于「已核验」）；
 * 有用户约束时按质检结论裁决：核不了 → unavailable，不得绿线。
 *
 * @param {object} base 来源验收结论
 * @param {object} options
 * @param {object|null} [options.review] 质检结论
 * @param {Array<string>|null} [options.userConstraints] 用户显式约束清单
 * @param {string} source 来源标识（用于可读说明）
 * @returns {{verdict: string, reasons: string[], checks: object, constraintResults: Array<object>}}
 */
function applyConstraintJudgement(base, options = {}, source = '') {
  const required = (options.userConstraints || []).filter((item) => typeof item === 'string' && item.trim());
  const existing = Array.isArray(base.constraintResults) ? [...base.constraintResults] : [];
  if (existing.length === 0 && typeof base.checks?.topology === 'boolean') {
    existing.push(topologyConstraintResult(base.checks.topology));
  }
  if (required.length === 0) {
    existing.push(
      buildConstraintResult({
        kind: 'structure',
        status: CONSTRAINT_STATUS.NOT_APPLICABLE,
        message: `${source} 来源：用户未提出附加结构要求，无需逐项核对`,
      }),
    );
    return { ...base, constraintResults: existing };
  }
  const judged = judgeConstraintsByReview(options.review, required);
  existing.push(
    structureConstraintResult(judged, required, {
      pass: '附加结构要求已逐项核对通过',
      fail: '附加结构要求未满足',
      unavailable: '附加结构要求无法逐项核验（质检不可用或结论不明）',
    }),
  );
  existing.push(...judged.results);
  if (judged.verdict !== 'pass') {
    return {
      verdict: judged.verdict,
      reasons: [...(base.reasons || []), ...judged.reasons],
      checks: { ...base.checks, constraintReview: options.review?.verdict ?? null },
      constraintResults: existing,
    };
  }
  return {
    ...base,
    checks: { ...base.checks, constraintReview: options.review?.verdict ?? null },
    constraintResults: existing,
  };
}

export function acceptReferenceTarget(customShape, referenceSource = null, options = {}) {
  const base = acceptReferenceTargetBase(customShape, referenceSource);
  return applyConstraintJudgement(base, options, 'reference');
}

/**
 * 参考图目标验收的内部实现（不含用户显式约束裁决）。
 *
 * @param {object} customShape 参考图转换出的归一化 customShape
 * @param {object|null} referenceSource 参考命中信息
 * @returns {{verdict: 'pass'|'fail'|'unavailable', reasons: string[], checks: object}}
 */
function acceptReferenceTargetBase(customShape, referenceSource = null) {
  const topology = checkTopology(customShape);
  const checks = {
    source: 'reference',
    assetId: referenceSource?.id ?? null,
    origin: referenceSource?.origin ?? 'local',
    reviewStatus: referenceSource?.reviewStatus ?? 'curated',
    topology: topology.ok,
  };
  if (!topology.ok) {
    return { verdict: 'fail', reasons: topology.reasons, checks };
  }
  // 复合目标（多对象）：逐部分过审——任一部分缺审核记录或哈希不符即整体不合格，
  // 不得用任一部分的审核记录代表整体（方案 2026-11-05 §4.2）。
  if (referenceSource?.composite === true) {
    const parts = Array.isArray(referenceSource.parts) ? referenceSource.parts : [];
    if (parts.length < 2) {
      return { verdict: 'fail', reasons: ['复合目标缺少组成部分记录'], checks };
    }
    const failed = parts.filter((part) => {
      if (part?.reviewStatus === 'unreviewed') {
        return true;
      }
      const review = part?.review;
      return !(
        review
        && review.status === 'approved'
        && review.visual === 'like'
        && Boolean(review.sha256)
        && review.sha256 === part?.sourceSha256
      );
    });
    checks.partCount = parts.length;
    checks.parts = parts.map((part) => ({
      name: part?.name ?? null,
      assetId: part?.assetId ?? null,
      reviewStatus: part?.reviewStatus ?? null,
    }));
    if (failed.length > 0) {
      return {
        verdict: 'fail',
        reasons: [
          `复合目标中有 ${failed.length} 个部分缺少人工审核通过记录，或审核哈希与素材版本不匹配：${failed
            .map((part) => part?.name ?? part?.assetId ?? '?')
            .join('、')}`,
        ],
        checks,
      };
    }
    checks.review = 'approved';
    return { verdict: 'pass', reasons: [], checks };
  }
  if (referenceSource?.reviewStatus === 'unreviewed') {
    const confirmation = referenceSource.confirmation;
    const confirmed =
      confirmation
      && confirmation.type === 'user-selection'
      && Boolean(confirmation.choiceId)
      && confirmation.choiceId === referenceSource.choiceId
      && Boolean(confirmation.candidateId)
      && confirmation.candidateId === referenceSource.candidateId
      && Boolean(confirmation.contentHash)
      && confirmation.contentHash === referenceSource.contentHash;
    if (!confirmed) {
      return {
        verdict: 'unavailable',
        reasons: ['在线候选未经本轮用户确认（或确认与待选快照不一致），不得正式规划'],
        checks: { ...checks, confirmation: 'missing-or-mismatch' },
      };
    }
    checks.confirmation = 'user-selection';
    return { verdict: 'pass', reasons: [], checks };
  }
  const review = referenceSource?.review;
  const reviewOk =
    review
    && review.status === 'approved'
    && review.visual === 'like'
    && Boolean(review.sha256)
    && review.sha256 === referenceSource.sourceSha256;
  if (!reviewOk) {
    return {
      verdict: 'fail',
      reasons: ['参考素材缺少人工审核通过记录，或审核哈希与素材版本不匹配'],
      checks: { ...checks, review: 'missing-or-mismatch' },
    };
  }
  checks.review = 'approved';
  return { verdict: 'pass', reasons: [], checks };
}

/**
 * 自由轮廓目标验收（合取闸门，方案 §8.1/§8.5、2026-11-01 §3）：
 * 拓扑合法 ∧ 点数达标（复杂剪影）∧ 视觉质检明确 like ∧ 用户显式约束逐项通过。
 *
 * 点数闸门（方案 2026-11-01 §5.1）：customShape.features 中 LLM 声明特征
 * （kind==='declared'）不少于 3 个时视为复杂剪影，outlinePoints 点数必须在
 * [FREEFORM_COMPLEX_POINT_MIN, FREEFORM_COMPLEX_POINT_MAX × 部分数]——多部分目标
 * （如群岛）按部分数放宽上限，单部分仍是 120；几何检测特征（notch/gap/identity）
 * 不参与复杂度判定。声明特征少于 3 个的简单图形不设点数区间（8~20 只是生成提示，
 * 不用于拒绝）。点数属于确定性检查，先于语义质检判定：不达标直接 fail。
 *
 * @param {object} customShape 归一化 customShape（自由轮廓 T）
 * @param {object|null} review reviewTargetShape 的质检闭环结果
 * @param {{userText?: string|null, userConstraints?: Array<string>|null}} [options]
 *   userText：用户原文（原始请求文本）；userConstraints：意图解析出的约束清单。
 *   仅当**约束清单为空**且原文疑似包含显式要求时，验收降级不给绿线（Bug 4.1
 *   fail-open 修复）；约束已解析时走既有逐项核对（constraintSummary），不做检测降级
 *   ——否则"约束已解析且核对通过"的合法交付会被误拦（2026-11-07 复核发现）。
 * @returns {{verdict: 'pass'|'fail'|'unavailable', reasons: string[], checks: object}}
 *   unavailable 表示必要语义验收不可用/结论不明/未完成——不得给合格绿线，
 *   只允许诊断性参考规划或诚实失败
 */
export function acceptFreeformTarget(customShape, review, options = {}) {
  const base = acceptFreeformTargetBase(customShape, review, options);
  const constraintResults = [];
  const checks = base.checks || {};
  if (typeof checks.topology === 'boolean') {
    constraintResults.push(topologyConstraintResult(checks.topology));
  }
  if (checks.pointGate) {
    const gateOk = base.verdict !== 'fail' || !String((base.reasons || []).join(' ')).includes('点数');
    constraintResults.push(
      buildConstraintResult({
        kind: 'point-gate',
        status: gateOk ? CONSTRAINT_STATUS.PASS : CONSTRAINT_STATUS.FAIL,
        actual: `${checks.pointGate}（${checks.pointCount ?? '?'} 点）`,
        message: gateOk
          ? `点数门通过（${checks.pointGate} 档，${checks.pointCount ?? '?'} 点）`
          : '点数门未通过',
      }),
    );
  }
  if (checks.visual !== undefined && checks.visual !== null) {
    constraintResults.push(
      buildConstraintResult({
        kind: 'semantic',
        status: constraintStatusOf(checks.visual),
        actual: String(checks.visual),
        message: `视觉质检结论：${checks.visual}`,
      }),
    );
  }
  const required = (options.userConstraints || []).filter((item) => typeof item === 'string' && item.trim());
  if (required.length === 0) {
    constraintResults.push(
      buildConstraintResult({
        kind: 'user-constraint',
        status: CONSTRAINT_STATUS.NOT_APPLICABLE,
        message: '用户未提出可逐项核对的显式约束',
      }),
    );
  } else {
    constraintResults.push(...buildUserConstraintResults(required, review?.constraintSummary));
  }
  return { ...base, constraintResults };
}

/**
 * 自由轮廓目标验收的内部实现（不含统一约束结论条目）。
 *
 * @param {object} customShape 归一化 customShape（自由轮廓 T）
 * @param {object|null} review reviewTargetShape 的质检闭环结果
 * @param {{userText?: string|null, userConstraints?: Array<string>|null}} [options]
 * @returns {{verdict: 'pass'|'fail'|'unavailable', reasons: string[], checks: object}}
 */
function acceptFreeformTargetBase(customShape, review, { userText = null, userConstraints = null } = {}) {
  const checks = { source: 'freeform' };
  // 约束漏解析 fail-open 防御（缺陷清单 Bug 4.1）：约束清单为空但原文疑似包含
  // 显式要求（"要奔跑的样子"）时，"没有约束要核对"不能当成"通过"——验收降级，
  // 用户要求是否满足不得在未核对的情况下给绿线（H06 实测教训）。
  // 约束已解析（非空）时跳过检测：其满足性由 constraintSummary 逐项核对裁决，
  // 这里再拦会把"已核对通过"的合法交付误杀。
  const hasParsedConstraints = Array.isArray(userConstraints) && userConstraints.some((item) => typeof item === 'string' && item.trim());
  const suspected = hasParsedConstraints ? { suspected: false, cues: [] } : detectPossibleConstraintText(userText);
  if (suspected.suspected) {
    checks.constraintSuspected = suspected.cues;
    return {
      verdict: 'fail',
      reasons: [
        `用户原文疑似包含显式图形要求（${suspected.cues.join('、')}），但意图没有解析出可核对的约束清单，该要求无法逐项核对——按未验收处理，不给合格绿线`,
      ],
      checks,
    };
  }
  const topology = checkTopology(customShape);
  checks.topology = topology.ok;
  if (!topology.ok) {
    return { verdict: 'fail', reasons: topology.reasons, checks };
  }
  // 点数闸门（确定性检查）：复杂剪影点数过少/过多都视为不合格点列。
  // 复杂度只按 LLM 声明特征（kind==='declared'）判定：detectFeatures 检出的
  // notch/gap/identity 是几何形状的产物（任何轮廓都可能检出若干条），参与判定会
  // 把几乎所有 LLM 输出误判成复杂剪影，使 simple 档不可达（方案 §5.1 口径）。
  const pointCount = customShape?.outlinePoints?.length ?? 0;
  const features = Array.isArray(customShape?.features) ? customShape.features : [];
  const featureCount = features.length;
  const declaredFeatureCount = features.filter((feature) => feature?.kind === 'declared').length;
  // 多部分目标按部分数放宽上限（每部分最多 120 点）：单部分 120、两部分 240；
  // 下限仍是总点数 80（多部分整体复杂度由总点数承载）。
  const partCount = Math.max(1, Array.isArray(customShape?.parts) ? customShape.parts.length : 1);
  const pointMax = freeformPointMax(partCount);
  const complex = declaredFeatureCount >= FREEFORM_COMPLEX_FEATURE_MIN;
  checks.pointCount = pointCount;
  checks.featureCount = featureCount;
  checks.declaredFeatureCount = declaredFeatureCount;
  checks.partCount = partCount;
  checks.pointMax = pointMax;
  checks.pointGate = complex ? 'complex' : 'simple';
  if (complex && pointCount > pointMax) {
    const partsNote = partCount > 1
      ? `，共 ${partCount} 个部分，每部分上限 ${FREEFORM_COMPLEX_POINT_MAX} 点`
      : '，共 1 个部分';
    return {
      verdict: 'fail',
      reasons: [
        `复杂剪影（声明特征 ${declaredFeatureCount} 个${partsNote}）点数 ${pointCount} 超过上限 ${pointMax}`,
      ],
      checks,
    };
  }
  if (complex && pointCount < FREEFORM_COMPLEX_POINT_RELAXED_MIN) {
    // 硬下限不放宽（缺陷清单 Bug 4.2.5.3）：60 点以下的退化轮廓必须拒绝
    const partsNote = partCount > 1 ? `，共 ${partCount} 个部分` : '';
    return {
      verdict: 'fail',
      reasons: [
        `复杂剪影（声明特征 ${declaredFeatureCount} 个${partsNote}）点数 ${pointCount} 低于硬下限 ${FREEFORM_COMPLEX_POINT_RELAXED_MIN}`,
      ],
      checks,
    };
  }
  // 分级放行（缺陷清单 Bug 4.2 修复方案 3）：复杂剪影点数在 [60, 80) 时不再一票
  // 否决——视觉质检明确 like 且约束全过才允许进入正式规划（由贴路质量分与质检
  // 裁决准确性）；质检结论不像/不可用时仍按 80 硬门拒绝。点数由 LLM 输出长度
  // 决定而非质量，78 与 80 没有本质差别（40 例统计：77% 的自由轮廓拒绝是点数门）。
  const tieredRelease = complex && pointCount < FREEFORM_COMPLEX_POINT_MIN;
  if (tieredRelease) {
    checks.pointGate = 'tiered';
  }
  // 视觉质检不可用/结论不明：验收未完成（不是"通过"也不是"不像"）
  if (!review || review.available !== true || review.verdict === 'unknown') {
    const reasons = [];
    if (tieredRelease) {
      // 分级放行前提不成立：质检结论不明确就不能证明"少点数但像"，按点数硬门拒绝
      reasons.push(
        `复杂剪影点数 ${pointCount} 低于 ${FREEFORM_COMPLEX_POINT_MIN}（分级放行要求视觉质检明确像），而质检结论不可用（${review?.skipped || review?.verdict || 'unknown'}）`,
      );
      checks.visual = review?.verdict ?? null;
      return { verdict: 'fail', reasons, checks };
    }
    if (!review) {
      reasons.push('视觉质检未执行');
    } else if (review.available !== true) {
      reasons.push(`视觉质检不可用或结论不明（${review.skipped || review.verdict || 'unknown'}）`);
    } else {
      reasons.push('视觉质检没有给出明确结论（unknown）');
    }
    checks.visual = review?.verdict ?? null;
    return { verdict: 'unavailable', reasons, checks };
  }
  // 结论明确为 unlike：整体不像 → 不通过（方案 §8.1 绿线否决权）
  if (review.verdict === 'unlike') {
    checks.visual = 'unlike';
    return {
      verdict: 'fail',
      reasons: [
        tieredRelease
          ? `复杂剪影点数 ${pointCount} 低于 ${FREEFORM_COMPLEX_POINT_MIN}（分级放行要求视觉质检明确像），且质检结论为不像：${(review.issues || []).join('；') || '未说明原因'}`
          : `视觉质检结论为不像：${(review.issues || []).join('；') || '未说明原因'}`,
      ],
      checks,
    };
  }
  checks.visual = 'like';
  // 用户显式约束逐项核对（合取必要条件）：不通过或必要项无法判定都不得给合格绿线
  const constraintSummary = review.constraintSummary;
  if (constraintSummary && !constraintSummary.ok) {
    checks.constraints = constraintSummary;
    return {
      verdict: 'fail',
      reasons: [
        constraintSummary.unavailable
          ? '用户显式约束未逐项核对（质检未返回结论）'
          : `用户显式约束未满足：${constraintSummary.failed.join('、')}`,
      ],
      checks,
    };
  }
  checks.constraints = constraintSummary || { ok: true, unavailable: false, failed: [] };
  if (tieredRelease) {
    // 分级放行留痕：这版交付靠"质检明确像"放行，不是点数达标（回归统计用）
    checks.pointGateRelaxed = true;
  }
  return { verdict: 'pass', reasons: [], checks };
}

/**
 * 图像描摹目标验收（方案 2026-11-01 §3/§4.1）：确定性检查，不做视觉质检。
 *
 * 合取条件（任一失败即 fail，不得给合格绿线）：
 * - 拓扑复验：单条填充外轮廓合法（不自交/不退化/单部分）；
 * - 点数区间：[IMAGE_TRACE_POINT_MIN, IMAGE_TRACE_POINT_MAX]（与描摹重采样口径一致）；
 * - 描摹元数据完整：traceMeta.iou 存在且 ≥ IMAGE_TRACE_IOU_MIN（描摹结果对填充后
 *   原图的 IoU 是描摹算法的能力证明，缺失/过低说明这份点列不可信）。
 *
 * @param {object} customShape 归一化后的图像描摹 T
 * @param {{iou?: number, pointCount?: number}|null} [traceMeta] 描摹元数据
 * @returns {{verdict: 'pass'|'fail', reasons: string[], checks: object}}
 */
export function acceptTracedTarget(customShape, traceMeta = null, options = {}) {
  const base = acceptTracedTargetBase(customShape, traceMeta);
  return applyConstraintJudgement(base, options, 'traced');
}

/**
 * 图像描摹目标验收的内部实现（不含用户显式约束裁决）。
 *
 * @param {object} customShape 归一化后的图像描摹 T
 * @param {{iou?: number, pointCount?: number}|null} traceMeta 描摹元数据
 * @returns {{verdict: 'pass'|'fail', reasons: string[], checks: object}}
 */
function acceptTracedTargetBase(customShape, traceMeta = null) {
  const pointCount = customShape?.outlinePoints?.length ?? 0;
  const iou = Number.isFinite(traceMeta?.iou) ? traceMeta.iou : null;
  const checks = { source: 'traced', topology: false, pointCount, iou };
  const topology = checkTopology(customShape);
  checks.topology = topology.ok;
  if (!topology.ok) {
    return { verdict: 'fail', reasons: topology.reasons, checks };
  }
  if (pointCount < IMAGE_TRACE_POINT_MIN || pointCount > IMAGE_TRACE_POINT_MAX) {
    return {
      verdict: 'fail',
      reasons: [
        `描摹外轮廓点数 ${pointCount} 不在 ${IMAGE_TRACE_POINT_MIN}~${IMAGE_TRACE_POINT_MAX} 范围内`,
      ],
      checks,
    };
  }
  if (iou === null) {
    return {
      verdict: 'fail',
      reasons: ['缺少描摹元数据（描摹 IoU），无法确认点列来自这张图'],
      checks,
    };
  }
  if (iou < IMAGE_TRACE_IOU_MIN) {
    return {
      verdict: 'fail',
      reasons: [`描摹外轮廓与原图填充后轮廓的 IoU ${iou.toFixed(3)} 低于 ${IMAGE_TRACE_IOU_MIN}`],
      checks,
    };
  }
  return { verdict: 'pass', reasons: [], checks };
}

/**
 * 统一验收入口：按目标来源分派到对应验收依据（方案 §8.1 表格）。
 *
 * @param {object} options
 * @param {'procedural'|'builtin'|'reference'|'freeform'|'traced'} options.source 目标来源
 * @param {object} options.customShape 归一化 customShape（T）
 * @param {object|null} [options.spec] 规范化 ShapeSpec（procedural 必填）
 * @param {object|null} [options.referenceSource] 参考图命中信息（reference 用）
 * @param {object|null} [options.review] 视觉质检闭环结果（freeform 用）
 * @param {object|null} [options.traceMeta] 描摹元数据（traced 用；缺省读 customShape.trace）
 * @param {string|null} [options.userText] 用户原文（原始请求文本；freeform 约束
 *   漏解析 fail-open 防御用，Bug 4.1）
 * @param {Array<string>|null} [options.userConstraints] 意图解析出的约束清单
 *   （freeform：非空时跳过疑似约束检测，走逐项核对；reference/builtin/traced：
 *   非空时按质检结论逐项核对，核不了即 unavailable——不得假装已验收）
 * @returns {{verdict: 'pass'|'fail'|'unavailable', reasons: string[], checks: object, constraintResults: Array<object>}}
 */
export function acceptTarget({
  source,
  customShape,
  spec = null,
  referenceSource = null,
  review = null,
  traceMeta = null,
  userText = null,
  userConstraints = null,
}) {
  const options = { review, userConstraints };
  switch (source) {
    case 'procedural':
      return acceptProceduralTarget(customShape, spec, { userConstraints });
    case 'builtin':
      return acceptBuiltinTarget(options);
    case 'reference':
      return acceptReferenceTarget(customShape, referenceSource, options);
    case 'traced':
      return acceptTracedTarget(customShape, traceMeta ?? customShape?.trace ?? null, options);
    case 'freeform':
      return acceptFreeformTarget(customShape, review, { userText, userConstraints });
    default:
      return {
        verdict: 'fail',
        reasons: [`未知目标来源「${source}」`],
        checks: { source },
        constraintResults: [
          buildConstraintResult({
            kind: 'structure',
            status: CONSTRAINT_STATUS.FAIL,
            message: `未知目标来源「${source}」`,
          }),
        ],
      };
  }
}

/**
 * 目标验收结论是否允许进入正式路网规划（方案 §8.5 表格）。
 * 只有 pass 才正式规划；fail/unavailable 只允许诊断性参考规划或诚实失败。
 *
 * @param {{verdict: string}} acceptance 验收结论
 * @returns {boolean}
 */
export function isTargetQualified(acceptance) {
  return acceptance?.verdict === 'pass';
}
