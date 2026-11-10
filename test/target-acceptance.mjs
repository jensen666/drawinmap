/**
 * 统一目标语义验收入口测试（Node 直接运行，不依赖浏览器/网络）。
 *
 * 覆盖（方案 §8/§11.1）：
 * - 各来源验收依据：procedural（几何不变量+拓扑）、builtin、reference、freeform（合取）
 * - 自由轮廓合格合取：拓扑 ∧ 用户显式约束 ∧ 视觉结论 like——任一失败/不可判定
 *   都不给合格绿线；只有 seen 文案合理但结论缺失不算通过
 * - 自由轮廓点数闸门（方案 2026-11-01 §3/§5.1）：complex 只按 LLM 声明特征
 *   （kind=declared）≥3 判定，点数必须在 80~120（单部分 79/121 拒绝，80/120 接受；
 *   多部分上限按部分数放宽为 120×部分数，下限仍是总点数 80）；几何检测特征
 *   notch/gap/identity 不参与复杂度判定；声明特征<3 的简单图形不加区间
 * - 特征角色隔离：generatorGuides（LLM 声明特征）与 detectedFeatures 无目标否决权；
 *   只有 userConstraints 具有否决权
 * - 语义闸门：名叫六角星的 20 点不规则凹多边形不得通过 procedural 验收
 * - 交付闸门语义：pass 才允许正式规划；fail/unavailable 只允许诊断参考或诚实失败
 * - 声明特征映射距离只记录不否决（防误杀）
 *
 * 运行：node test/target-acceptance.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  acceptBuiltinTarget,
  acceptFreeformTarget,
  acceptProceduralTarget,
  acceptReferenceTarget,
  acceptTarget,
  checkTopology,
  extractPartLoops,
  FREEFORM_COMPLEX_FEATURE_MIN,
  FREEFORM_COMPLEX_POINT_MAX,
  FREEFORM_COMPLEX_POINT_MIN,
  isTargetQualified,
} from '../web/src/agent/target-acceptance.js';
import { buildShapeFromSpec, normalizeShapeSpec } from '../web/src/agent/shape-spec.js';
import { normalizeCustomShape } from '../web/src/agent/intent.js';

let failures = 0;
let checks = 0;

function check(label, condition, detail = '') {
  checks += 1;
  const ok = Boolean(condition);
  if (!ok) {
    failures += 1;
  }
  console.log(`[check] ${label} -> ${ok ? 'PASS' : `FAIL ${detail}`}`);
}

const here = dirname(fileURLToPath(import.meta.url));

/** 构造 procedural 夹具：规格六角星 */
const hexaSpec = normalizeShapeSpec({ family: 'star', pointCount: 6, outerRadii: 0.5, innerRadii: 0.2887 }).spec;
const hexaT = buildShapeFromSpec(hexaSpec).customShape;

/** 自由轮廓夹具：合法闭环（方形） */
const freeT = normalizeCustomShape({ name: '马', points: [[-0.4, -0.4], [0.4, -0.4], [0.4, 0.4], [-0.4, 0.4]] });

/**
 * 自由轮廓点数闸门夹具（方案 2026-11-01 §3/§5.1）：N 点圆环 + LLM 声明特征。
 * 特征点落在轮廓上——normalizeCustomShape 会为声明特征标 kind='declared'，
 * 只有这些条目参与"复杂剪影"判定（几何检测特征不算）。
 *
 * @param {number} pointCount 圆环点数
 * @param {number} [featureCount] 声明特征个数
 * @returns {object|null} 归一化 customShape
 */
function freeformRing(pointCount, featureCount = 0) {
  const points = Array.from({ length: pointCount }, (_, i) => {
    const t = (Math.PI * 2 * i) / pointCount;
    return [Math.cos(t) * 0.4, Math.sin(t) * 0.4];
  });
  const features = Array.from({ length: featureCount }, (_, i) => {
    const t = (Math.PI * 2 * i) / featureCount;
    return { name: `特征${i + 1}`, points: [[Math.cos(t) * 0.4, Math.sin(t) * 0.4]] };
  });
  return normalizeCustomShape({ name: '复杂剪影', points, features });
}

/**
 * 几何检测特征夹具：三凹口圆盘（纯点列、无声明特征）。
 * detectFeatures 检出 3 个 notch，但复杂度判定只认 LLM 声明特征 →
 * 这个 24 点图形仍按简单图形处理（不因点数跑到 80~120 之外而拒绝）。
 *
 * @param {number} [pointCount] 点数（默认 24，落在简单图形提示区间之上、复杂下限之下）
 * @returns {object|null} 归一化 customShape
 */
function notchedDisk(pointCount = 24) {
  const notchCenters = [Math.PI / 2, Math.PI / 2 + (2 * Math.PI) / 3, Math.PI / 2 + (4 * Math.PI) / 3];
  const points = [];
  for (let i = 0; i < pointCount; i += 1) {
    const angle = (2 * Math.PI * i) / pointCount;
    let radius = 0.4;
    for (const center of notchCenters) {
      let delta = Math.abs(angle - center);
      delta = Math.min(delta, 2 * Math.PI - delta);
      if (delta < 0.275) {
        radius = Math.min(radius, 0.18);
      }
    }
    points.push([Math.cos(angle) * radius, Math.sin(angle) * radius]);
  }
  return normalizeCustomShape({ name: '三凹口圆盘', points });
}

/**
 * 多部分夹具：两个分离圆环（120 + 50 点，合计 170 点）+ 每部分声明特征（合计 3 个）。
 * 用于验证复杂剪影上限按部分数放宽：单部分上限 120、两部分 240。
 *
 * @returns {object|null} 归一化 customShape（parts=2、outlinePoints=170）
 */
function islandPair() {
  const ring = (count, radius, cx, cy) =>
    Array.from({ length: count }, (_, i) => {
      const t = (Math.PI * 2 * i) / count;
      return [cx + Math.cos(t) * radius, cy + Math.sin(t) * radius];
    });
  const main = ring(120, 0.3, -0.15, 0);
  const island = ring(50, 0.12, 0.3, 0.2);
  return normalizeCustomShape({
    name: '群岛',
    parts: [
      {
        name: '大陆',
        points: main,
        features: [{ name: '岸1', points: [main[0]] }, { name: '岸2', points: [main[30]] }],
      },
      { name: '岛', points: island, features: [{ name: '岸3', points: [island[0]] }] },
    ],
  });
}

// ---------- procedural 验收 ----------
{
  const pass = acceptProceduralTarget(hexaT, hexaSpec);
  check('procedural：合格 T 通过', pass.verdict === 'pass', JSON.stringify(pass.reasons));
  check('procedural：检查项包含拓扑与不变量', pass.checks.topology === true && pass.checks.invariants === true);
  const fail = acceptProceduralTarget({ outlinePoints: [[0, 0], [1, 1], [0, 1], [1, 0]] }, hexaSpec);
  check('procedural：自交 T 拒绝', fail.verdict === 'fail');
  const noSpec = acceptProceduralTarget(hexaT, null);
  check('procedural：缺 S 拒绝', noSpec.verdict === 'fail');
  // 名叫六角星但实际 20 点不规则凹多边形（方案 §11.1 语义闸门行）
  const fake = [];
  for (let i = 0; i < 20; i += 1) {
    const a = (Math.PI * 2 * i) / 20;
    const rad = 0.3 + 0.15 * Math.sin(3 * a) + 0.05 * Math.cos(7 * a + i);
    fake.push([Math.cos(a) * rad, Math.sin(a) * rad]);
  }
  const fakeShape = normalizeCustomShape({ name: '六角星', points: fake });
  const gate = acceptProceduralTarget(fakeShape, hexaSpec);
  check('语义闸门：20 点不规则凹多边形冒充六角星被拒', gate.verdict === 'fail' && gate.reasons.length > 0);
  check('语义闸门：不合格不得正式规划', isTargetQualified(gate) === false);
}

// ---------- builtin / reference 验收（方案 2026-10-31 §8：curated/unreviewed 差异化门槛） ----------
{
  check('builtin：直接通过', acceptBuiltinTarget().verdict === 'pass');
  const refT = normalizeCustomShape({ name: '马', points: [[-0.4, -0.4], [0.4, -0.4], [0.4, 0.4], [-0.4, 0.4]] });
  const review = { status: 'approved', visual: 'like', reviewedAt: '2026-11-01', sha256: 'a'.repeat(64) };
  const curated = acceptReferenceTarget(refT, {
    id: 'horse-phylopic',
    origin: 'local',
    reviewStatus: 'curated',
    sourceSha256: 'a'.repeat(64),
    review,
  });
  check('reference：curated + 审核哈希绑定 → 通过并记录来源', curated.verdict === 'pass' && curated.checks.source === 'reference' && curated.checks.assetId === 'horse-phylopic');
  const noReview = acceptReferenceTarget(refT, { id: 'horse-phylopic', reviewStatus: 'curated', sourceSha256: 'a'.repeat(64), review: null });
  check('reference：curated 缺审核记录 → 拒绝', noReview.verdict === 'fail' && noReview.checks.review === 'missing-or-mismatch');
  const staleReview = acceptReferenceTarget(refT, {
    id: 'horse-phylopic',
    reviewStatus: 'curated',
    sourceSha256: 'b'.repeat(64),
    review,
  });
  check('reference：审核哈希与素材版本不符 → 拒绝（素材变化后审核失效）', staleReview.verdict === 'fail');
  const onlineUnselected = acceptReferenceTarget(refT, {
    id: 'oc-1',
    origin: 'online',
    reviewStatus: 'unreviewed',
    sourceSha256: 'c'.repeat(64),
    contentHash: 'd'.repeat(64),
    choiceId: 'rc_1',
    confirmation: null,
  });
  check('reference：在线未确认 → unavailable 不得正式规划', onlineUnselected.verdict === 'unavailable' && isTargetQualified(onlineUnselected) === false);
  const onlineConfirmed = acceptReferenceTarget(refT, {
    id: 'oc-1',
    origin: 'online',
    reviewStatus: 'unreviewed',
    sourceSha256: 'c'.repeat(64),
    contentHash: 'd'.repeat(64),
    choiceId: 'rc_1',
    candidateId: 'rc_1:0',
    confirmation: { type: 'user-selection', choiceId: 'rc_1', candidateId: 'rc_1:0', contentHash: 'd'.repeat(64), sourceTraceId: 't_1' },
  });
  check('reference：在线候选本轮确认一致 → 通过', onlineConfirmed.verdict === 'pass' && onlineConfirmed.checks.confirmation === 'user-selection');
  const crossChoice = acceptReferenceTarget(refT, {
    id: 'oc-1',
    origin: 'online',
    reviewStatus: 'unreviewed',
    sourceSha256: 'c'.repeat(64),
    contentHash: 'd'.repeat(64),
    choiceId: 'rc_2',
    candidateId: 'rc_2:0',
    confirmation: { type: 'user-selection', choiceId: 'rc_1', candidateId: 'rc_2:0', contentHash: 'd'.repeat(64), sourceTraceId: 't_1' },
  });
  check('reference：跨选择快照确认 → 不得正式规划', crossChoice.verdict === 'unavailable');
  const hashMismatch = acceptReferenceTarget(refT, {
    id: 'oc-1',
    origin: 'online',
    reviewStatus: 'unreviewed',
    sourceSha256: 'c'.repeat(64),
    contentHash: 'd'.repeat(64),
    choiceId: 'rc_1',
    candidateId: 'rc_1:0',
    confirmation: { type: 'user-selection', choiceId: 'rc_1', candidateId: 'rc_1:0', contentHash: 'e'.repeat(64), sourceTraceId: 't_1' },
  });
  check('reference：contentHash 不符的确认 → 不得正式规划', hashMismatch.verdict === 'unavailable');
  const badRef = acceptReferenceTarget({ outlinePoints: [[0, 0], [1, 1], [0, 1], [1, 0]] });
  check('reference：拓扑非法拒绝', badRef.verdict === 'fail');
}

// ---------- freeform 合取闸门 ----------
{
  // 全部通过
  const pass = acceptFreeformTarget(freeT, { available: true, verdict: 'like', constraintSummary: { ok: true, unavailable: false, failed: [] } });
  check('freeform：like + 无约束 → 通过', pass.verdict === 'pass');
  check('freeform：pass 才允许正式规划', isTargetQualified(pass) === true);

  // unlike → fail（不是 unavailable）
  const unlike = acceptFreeformTarget(freeT, { available: true, verdict: 'unlike', issues: ['四条腿呈方波'] });
  check('freeform：unlike → 不通过', unlike.verdict === 'fail' && unlike.reasons[0].includes('不像'));

  // 只有 seen 合理、结论缺失 → unavailable（方案 §8.1）
  const unknown = acceptFreeformTarget(freeT, { available: false, verdict: 'unknown', seen: '看着像一只狗' });
  check('freeform：结论缺失 → 验收不可用', unknown.verdict === 'unavailable');
  check('freeform：验收不可用不得正式规划', isTargetQualified(unknown) === false);

  // review 缺失 → unavailable
  check('freeform：质检未执行 → 不可用', acceptFreeformTarget(freeT, null).verdict === 'unavailable');

  // 约束 fail → fail
  const constraintFail = acceptFreeformTarget(freeT, {
    available: true,
    verdict: 'like',
    constraintSummary: { ok: false, unavailable: false, failed: ['必须有琴颈'] },
  });
  check('freeform：用户约束 fail → 不通过', constraintFail.verdict === 'fail' && constraintFail.reasons[0].includes('必须有琴颈'));

  // 约束无法判定 → fail（不得给绿线）
  const constraintUnknown = acceptFreeformTarget(freeT, {
    available: true,
    verdict: 'like',
    constraintSummary: { ok: false, unavailable: true, failed: ['必须有琴颈'] },
  });
  check('freeform：约束无法判定 → 不通过', constraintUnknown.verdict === 'fail');

  // 拓扑非法 → fail（优先于一切）
  const badTopology = acceptFreeformTarget({ outlinePoints: [[0, 0], [1, 1], [0, 1], [1, 0]] }, { available: true, verdict: 'like' });
  check('freeform：拓扑非法 → fail', badTopology.verdict === 'fail' && badTopology.checks.topology === false);
}

// ---------- freeform 点数闸门（方案 2026-11-01 §3/§5.1） ----------
{
  const likeReview = { available: true, verdict: 'like', constraintSummary: { ok: true, unavailable: false, failed: [] } };
  check(
    '点数常量：复杂剪影特征下限 3、点数区间 80~120',
    FREEFORM_COMPLEX_FEATURE_MIN === 3 && FREEFORM_COMPLEX_POINT_MIN === 80 && FREEFORM_COMPLEX_POINT_MAX === 120,
    `${FREEFORM_COMPLEX_FEATURE_MIN}/${FREEFORM_COMPLEX_POINT_MIN}~${FREEFORM_COMPLEX_POINT_MAX}`,
  );

  // 缺陷清单 2026-11-06 Bug 4.2 分级放行：79 点 + 质检 like → 进入规划（tiered）；
  // 质检不可用/不像时仍按 80 硬门拒绝；59 点（低于 60 硬下限）一律拒绝
  const complex79 = freeformRing(79, 3);
  const released79 = acceptFreeformTarget(complex79, likeReview);
  check('点数闸门：声明特征≥3 且 79 点 + 质检 like → 分级放行', complex79?.outlinePoints.length === 79 && released79.verdict === 'pass' && released79.checks.pointGate === 'tiered', JSON.stringify(released79.reasons));
  const gated79 = acceptFreeformTarget(complex79, { available: false, verdict: 'unknown', skipped: 'deadline' });
  check('点数闸门：79 点 + 质检不可用 → 按 80 硬门拒绝', gated79.verdict === 'fail' && gated79.reasons[0]?.includes('分级放行') === true, JSON.stringify(gated79.reasons));
  check('点数闸门：79 点 + 质检不可用不得正式规划', isTargetQualified(gated79) === false);

  // 声明特征 ≥ 3 + 80 点（区间下限，含）：接受
  const complex80 = freeformRing(80, 3);
  const accepted80 = acceptFreeformTarget(complex80, likeReview);
  check('点数闸门：声明特征≥3 且 80 点 → 接受（下限含）', accepted80.verdict === 'pass', JSON.stringify(accepted80.reasons));
  check(
    '点数闸门：接受时记录点数、复杂档与声明特征数',
    accepted80.checks.pointCount === 80
      && accepted80.checks.pointGate === 'complex'
      && accepted80.checks.featureCount === 3
      && accepted80.checks.declaredFeatureCount === 3
      && accepted80.checks.partCount === 1
      && accepted80.checks.pointMax === 120,
  );

  // 声明特征 ≥ 3 + 120 点（单部分区间上限，含）：接受；121 点：拒绝
  check('点数闸门：声明特征≥3 且 120 点 → 接受（单部分上限含）', acceptFreeformTarget(freeformRing(120, 3), likeReview).verdict === 'pass');
  const rejected121 = acceptFreeformTarget(freeformRing(121, 3), likeReview);
  check('点数闸门：声明特征≥3 且单部分 121 点 → 拒绝（超过 120）', rejected121.verdict === 'fail', JSON.stringify(rejected121.reasons));

  // 声明特征 < 3（简单图形）：不设点数区间，8~20 只是生成提示
  const simple20 = freeformRing(20, 0);
  const acceptedSimple = acceptFreeformTarget(simple20, likeReview);
  check('点数闸门：声明特征<3 且 20 点 → 接受（简单图形不加区间）', acceptedSimple.verdict === 'pass', JSON.stringify(acceptedSimple.reasons));
  check('点数闸门：简单图形标记 simple 档', acceptedSimple.checks.pointGate === 'simple' && acceptedSimple.checks.declaredFeatureCount === 0 && acceptedSimple.checks.featureCount === 0);

  // 几何检测特征（notch/gap/identity）≥3、但 LLM 声明特征=0：复杂度只认声明特征 →
  // simple 档，24 点（>20 且 <80）也接受——旧口径会把检测特征算进 features 误判复杂剪影
  const detected = notchedDisk(24);
  const detectedAcceptance = acceptFreeformTarget(detected, likeReview);
  const detectedKinds = (detected?.features || []).map((feature) => feature.kind);
  check(
    '点数闸门：几何检测特征≥3、声明特征 0、24 点 → simple 档通过（不因点数拒绝）',
    detectedKinds.length >= 3
      && detectedKinds.every((kind) => kind !== 'declared')
      && detected?.outlinePoints.length === 24
      && detectedAcceptance.verdict === 'pass'
      && detectedAcceptance.checks.pointGate === 'simple'
      && detectedAcceptance.checks.declaredFeatureCount === 0,
    JSON.stringify({ kinds: detectedKinds, checks: detectedAcceptance.checks, reasons: detectedAcceptance.reasons }),
  );

  // H1 修复目标：简单图形不硬凑 features 时 simple 档可达——12 点圆 + 0 声明特征
  // normalize 加密到 24 点，仍 simple → 通过（旧口径下模型被逼声明 3 个特征 → 拒绝）
  const plainCircle = freeformRing(12, 0);
  const plainCircleAcceptance = acceptFreeformTarget(plainCircle, likeReview);
  check(
    '点数闸门：12 点圆 + 0 声明特征（normalize 24 点）→ simple 档通过',
    plainCircle?.outlinePoints.length === 24
      && plainCircleAcceptance.verdict === 'pass'
      && plainCircleAcceptance.checks.pointGate === 'simple'
      && plainCircleAcceptance.checks.declaredFeatureCount === 0,
    JSON.stringify({ points: plainCircle?.outlinePoints?.length, checks: plainCircleAcceptance.checks, reasons: plainCircleAcceptance.reasons }),
  );

  // 多部分目标：复杂剪影点数上限按部分数放宽（120×部分数）——
  // 两部分 120+50=170 点（旧口径按展平总数 170 > 120 误拒）→ 通过
  const islands = islandPair();
  const islandAcceptance = acceptFreeformTarget(islands, likeReview);
  check(
    '点数闸门：多部分 170 点（两部分）→ 复杂剪影通过（上限 240）',
    islands?.parts.length === 2
      && islands.outlinePoints.length === 170
      && islandAcceptance.verdict === 'pass'
      && islandAcceptance.checks.pointGate === 'complex'
      && islandAcceptance.checks.declaredFeatureCount === 3
      && islandAcceptance.checks.partCount === 2
      && islandAcceptance.checks.pointMax === FREEFORM_COMPLEX_POINT_MAX * 2,
    JSON.stringify({ points: islands?.outlinePoints?.length, checks: islandAcceptance.checks, reasons: islandAcceptance.reasons }),
  );

  // 点数属确定性检查：不达标直接 fail，不因视觉结论缺失变成 unavailable
  const unavailable79 = acceptFreeformTarget(complex79, { available: false, verdict: 'unknown' });
  check('点数闸门：确定性点数失败优先于视觉不可用', unavailable79.verdict === 'fail', JSON.stringify(unavailable79.reasons));
}

// ---------- 特征角色隔离（方案 §8.2/§11.1） ----------
{
  // LLM 声明特征（generatorGuides）：在范围内的坐标参与映射并记录距离/可信度；
  // 明显脱节轮廓的声明只标低可信（记录），不否决目标（验收入口不读 features）
  const withGuides = normalizeCustomShape({
    name: '吉他',
    features: [
      { name: '琴颈', points: [[0.4, 0.4]] },
      { name: '琴头', points: [[0.55, 0]] },
    ],
    points: [[-0.4, -0.4], [0.4, -0.4], [0.4, 0.4], [-0.4, 0.4]],
  });
  const declared = (withGuides.features || []).filter((feature) => feature.role === 'generator-guide' || feature.role === 'generator-guide-lowconf');
  check('声明特征标注为 generator-guide 角色', declared.length === 2, JSON.stringify((withGuides.features || []).map((f) => f.role)));
  const lowConf = declared.filter((feature) => feature.confidence === 'low');
  check('脱节声明坐标标记低可信（记录不否决）', lowConf.length === 1 && lowConf[0].mappingDistance > 0.08, JSON.stringify(declared.map((f) => [f.name, f.mappingDistance, f.confidence])));
  const guidePass = acceptFreeformTarget(withGuides, { available: true, verdict: 'like', constraintSummary: { ok: true, unavailable: false, failed: [] } });
  check('声明特征不参与目标否决（guide 脱节仍通过）', guidePass.verdict === 'pass');

  // 几何检测特征同样无否决权（验收入口不读 detectedFeatures）
  check('几何检测特征标注 detected 角色', (freeT.features || []).every((feature) => feature.role === 'detected' || feature.role === 'generator-guide'));
}

// ---------- 冻结样本防误杀：吉他 / 中国地图（方案 §11.1） ----------
{
  for (const [traceId, expectName, expectParts] of [
    ['t-ts2cig38pmr', '吉他', 1],
    ['t-pem9zy3ufu4', '中国地图', 3],
  ]) {
    const frozen = JSON.parse(readFileSync(join(here, 'fixtures', 'frozen-targets', `${traceId}.json`), 'utf8'));
    // 用冻结目标点列重建归一化 T（与历史 plan.request 记录同一输入口径）
    const rebuilt = normalizeCustomShape({
      name: frozen.name,
      points: frozen.outlinePoints,
      parts: frozen.parts?.length > 1
        ? frozen.parts.map((part) => ({
            name: part.name,
            points: frozen.outlinePoints.slice(part.outlineStart, part.outlineStart + part.outlineCount),
          }))
        : undefined,
    });
    check(`${expectName}: 冻结目标可重建`, Boolean(rebuilt) && rebuilt.name === expectName, JSON.stringify(rebuilt?.name));
    check(`${expectName}: 拓扑复验通过`, checkTopology(rebuilt).ok === true, JSON.stringify(checkTopology(rebuilt).reasons));
    const pass = acceptFreeformTarget(rebuilt, { available: true, verdict: 'like', constraintSummary: { ok: true, unavailable: false, failed: [] } });
    check(`${expectName}: 视觉 like 时不因声明特征/映射距离改判不合格`, pass.verdict === 'pass', JSON.stringify(pass.reasons));
    check(`${expectName}: 多部分结构保留`, (rebuilt.parts || []).length === expectParts, `parts=${rebuilt?.parts?.length}`);
  }
}

// ---------- 统一入口分派 ----------
{
  check('统一入口：procedural 分派', acceptTarget({ source: 'procedural', customShape: hexaT, spec: hexaSpec }).verdict === 'pass');
  check('统一入口：builtin 分派', acceptTarget({ source: 'builtin', customShape: null }).verdict === 'pass');
  check('统一入口：未知来源拒绝', acceptTarget({ source: 'alien', customShape: null }).verdict === 'fail');
}

// ---------- 拓扑工具 ----------
{
  const multi = normalizeCustomShape({
    name: '群岛',
    parts: [
      { name: '大陆', points: [[-0.5, -0.5], [0, -0.5], [0, 0], [-0.5, 0]] },
      { name: '岛', points: [[0.2, 0.2], [0.5, 0.2], [0.5, 0.5], [0.2, 0.5]] },
    ],
  });
  check('多部分：分离闭环合法', Boolean(multi));
  check('多部分：extractPartLoops 逐部分取环', extractPartLoops(multi).length === 2);
}

console.log(`\n[summary] ${checks - failures}/${checks} 项通过，失败 ${failures} 项`);
if (failures > 0) {
  process.exitCode = 1;
}
