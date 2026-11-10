/**
 * 自由轮廓质量能力测试（方案 2026-11-01《三种轮廓人选与自由轮廓质量方案》§3/§5.1）。
 *
 * 只做能力层验证：注入已归一化的候选与 fake LLM，不发模型请求、不打开浏览器、不走路网。
 * 覆盖 §5.1 的三行能力要求 + 本次新增的两个接口（callLlm 阶段参数、llm 超时覆盖）：
 * a) 点数：LLM 声明特征（kind=declared）≥3 的复杂剪影 79 点拒绝、80 点接受
 *    （视觉质检 like + 约束 ok 前提下）；几何检测特征（notch/gap/identity）≥3 但
 *    声明特征<3 的图形仍按简单图形处理（不做点数区间拒绝）；
 * b) 提示词：自由轮廓生成提示（buildSystemPrompt）与修正提示（reviseMessages）全文
 *    不含「12%」（12% 只留在贴路逻辑），且含复杂剪影 80~120 点规则；
 * c) 修正次数：质检 unlike 后修正阶段只调用一次 LLM 且 options.phase==='revision'；
 *    修正失败/复检失败都不再发第二次修正（方案 §3：不自动再发）；
 * d) llm.js：chatCompletion 的 timeoutMs 覆盖单次请求超时（错误分类仍为 kind=timeout）。
 *
 * 运行：node test/freeform-quality.mjs
 */

import {
  acceptFreeformTarget,
  FREEFORM_COMPLEX_FEATURE_MIN,
  FREEFORM_COMPLEX_POINT_MAX,
  FREEFORM_COMPLEX_POINT_MIN,
  FREEFORM_COMPLEX_POINT_RELAXED_MIN,
} from '../web/src/agent/target-acceptance.js';
import { normalizeCustomShape } from '../web/src/agent/intent.js';
import { buildSystemPrompt } from '../web/src/agent/prompt.js';
import { freeformPointRuleText } from '../web/src/agent/point-budget.js';
import { reviseMessages, reviewTargetShape } from '../web/src/agent/shape-review.js';
import { chatCompletion } from '../web/src/agent/llm.js';
import { getEntries, initLogging } from '../web/src/log/index.js';
import { placeConfig } from './fixtures/place-config.mjs';

let failures = 0;
let checks = 0;

/**
 * 断言工具：记录并通过/失败计数。
 *
 * @param {string} label 断言名
 * @param {boolean} condition 是否通过
 * @param {string} [detail] 失败详情
 */
function check(label, condition, detail = '') {
  checks += 1;
  const ok = Boolean(condition);
  if (!ok) {
    failures += 1;
  }
  console.log(`[check] ${label} -> ${ok ? 'PASS' : `FAIL ${detail}`}`);
}

// 日志只留 error 级、禁用 storage/server：llm 超时用例不产生真实请求
initLogging({ server: false, storage: false, level: 'error' });

// ---------- 测试夹具 ----------

/**
 * 自由轮廓夹具：N 点圆环 + LLM 声明特征（归一化后 outlinePoints 点数不变）。
 * 只有 features 里 kind==='declared' 的条目参与"复杂剪影"判定；数量即顶层
 * features 的长度（normalizeCustomShape 把它们标成 declared）。
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
 * detectFeatures 会检出 3 个 notch，但 kind 全是几何检测特征——复杂度判定只认
 * LLM 声明特征，因此即便检测特征 ≥3，这个 24 点（>20 且 <80）图形仍按简单图形
 * 处理（不因点数不在 80~120 而拒绝）。
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
 * 用于验证复杂剪影上限按部分数放宽：单部分上限 120、两部分 240（下限仍是总点数 80）。
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

/** 视觉质检通过 + 无用户约束的验收输入（点数闸门用例的"其余条件全通过"） */
const likeReview = { available: true, verdict: 'like', constraintSummary: { ok: true, unavailable: false, failed: [] } };

/** fake 渲染器（返回 data URL 表示"浏览器环境"，不真的画布渲染） */
const fakeRender = () => 'data:image/png;base64,FAKE';

// ---------- a) 点数闸门（§5.1 点数行） ----------

{
  check(
    '点数常量：复杂剪影特征下限 3、点数区间 80~120、分级放行下限 60',
    FREEFORM_COMPLEX_FEATURE_MIN === 3
      && FREEFORM_COMPLEX_POINT_MIN === 80
      && FREEFORM_COMPLEX_POINT_MAX === 120
      && FREEFORM_COMPLEX_POINT_RELAXED_MIN === 60,
    `${FREEFORM_COMPLEX_FEATURE_MIN}/${FREEFORM_COMPLEX_POINT_RELAXED_MIN}~${FREEFORM_COMPLEX_POINT_MIN}~${FREEFORM_COMPLEX_POINT_MAX}`,
  );

  // 声明特征≥3 且 79 点：分级放行（缺陷清单 Bug 4.2）——视觉质检明确 like 且
  // 约束全过时允许进入规划（78/77/73/68 这类"看着像"不再差几点被拒）
  const shape79 = freeformRing(79, 3);
  const released79 = acceptFreeformTarget(shape79, likeReview);
  check(
    '点数：声明特征≥3 + 79 点 + 质检 like → 分级放行进入规划',
    shape79?.outlinePoints.length === 79 && released79.verdict === 'pass' && released79.checks.pointGate === 'tiered' && released79.checks.pointGateRelaxed === true,
    JSON.stringify(released79.reasons),
  );

  // 同样 79 点但质检结论不可用：分级放行前提不成立 → 按 80 硬门拒绝
  const gated79 = acceptFreeformTarget(shape79, { available: false, verdict: 'unknown', skipped: 'deadline' });
  check(
    '点数：79 点 + 质检不可用 → 按 80 硬门拒绝（分级放行前提不成立）',
    gated79.verdict === 'fail' && gated79.reasons[0]?.includes('分级放行') === true,
    JSON.stringify(gated79.reasons),
  );

  // 同样 79 点但质检 unlike：拒绝，且原因同时说明点数与不像
  const unlike79 = acceptFreeformTarget(shape79, { available: true, verdict: 'unlike', issues: ['比例失真'] });
  check(
    '点数：79 点 + 质检 unlike → 拒绝（点数 + 像不像双重原因）',
    unlike79.verdict === 'fail' && unlike79.reasons[0]?.includes('79') === true && unlike79.reasons[0]?.includes('不像') === true,
    JSON.stringify(unlike79.reasons),
  );

  // 硬下限：59 点即使质检 like 也必须拒绝（下限不无限放宽）
  const shape59 = freeformRing(59, 3);
  const gated59 = acceptFreeformTarget(shape59, likeReview);
  check(
    '点数：59 点 + 质检 like → 仍拒绝（硬下限 60 不放宽）',
    shape59?.outlinePoints.length === 59 && gated59.verdict === 'fail' && gated59.reasons[0]?.includes('硬下限') === true,
    JSON.stringify(gated59.reasons),
  );

  // 声明特征≥3 且 80 点：区间下限（含）→ pass
  const shape80 = freeformRing(80, 3);
  const accepted80 = acceptFreeformTarget(shape80, likeReview);
  check('点数：声明特征≥3 + 80 点 → 接受（下限含）', accepted80.verdict === 'pass', JSON.stringify(accepted80.reasons));
  check(
    '点数：接受记录 complex 档、点数与声明特征数',
    accepted80.checks.pointGate === 'complex'
      && accepted80.checks.pointCount === 80
      && accepted80.checks.declaredFeatureCount === 3
      && accepted80.checks.featureCount === 3,
  );

  // 声明特征<3 且 8~20 点：简单图形只按生成提示，不做区间拒绝
  const simple20 = freeformRing(20, 0);
  const acceptedSimple = acceptFreeformTarget(simple20, likeReview);
  check('点数：声明特征<3 + 20 点 → 接受（简单图形不加区间）', simple20?.features.length === 0 && acceptedSimple.verdict === 'pass', JSON.stringify(acceptedSimple.reasons));
  check('点数：简单图形标记 simple 档', acceptedSimple.checks.pointGate === 'simple' && acceptedSimple.checks.declaredFeatureCount === 0);

  // 几何检测特征（notch/gap/identity）≥3、但 LLM 声明特征=0：复杂度只认声明特征 →
  // simple 档，24 点（>20 且 <80）不因点数区间被拒（旧口径把检测特征计入 features，
  // 会误判复杂剪影 → 24 点低于 80 被拒）
  const detected = notchedDisk(24);
  const detectedAcceptance = acceptFreeformTarget(detected, likeReview);
  const detectedKinds = (detected?.features || []).map((feature) => feature.kind);
  check(
    '点数：几何检测特征≥3、声明特征 0、24 点 → simple 档通过（不因点数拒绝）',
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
    '点数：12 点圆 + 0 声明特征（normalize 24 点）→ simple 档通过',
    plainCircle?.outlinePoints.length === 24
      && plainCircleAcceptance.verdict === 'pass'
      && plainCircleAcceptance.checks.pointGate === 'simple'
      && plainCircleAcceptance.checks.declaredFeatureCount === 0,
    JSON.stringify({ points: plainCircle?.outlinePoints?.length, checks: plainCircleAcceptance.checks, reasons: plainCircleAcceptance.reasons }),
  );

  // 多部分目标：上限按部分数放宽（120×部分数）——两部分 120+50=170 点通过
  const islands = islandPair();
  const islandAcceptance = acceptFreeformTarget(islands, likeReview);
  check(
    '点数：多部分 170 点（两部分）→ 复杂剪影通过（上限 240）',
    islands?.parts.length === 2
      && islands.outlinePoints.length === 170
      && islandAcceptance.verdict === 'pass'
      && islandAcceptance.checks.pointGate === 'complex'
      && islandAcceptance.checks.declaredFeatureCount === 3
      && islandAcceptance.checks.partCount === 2
      && islandAcceptance.checks.pointMax === FREEFORM_COMPLEX_POINT_MAX * 2,
    JSON.stringify({ points: islands?.outlinePoints?.length, checks: islandAcceptance.checks, reasons: islandAcceptance.reasons }),
  );
}

// ---------- b) 提示词不含 12%（§5.1 提示词行；方案 §3「12% 只留在贴路」） ----------

{
  const systemPrompt = buildSystemPrompt(placeConfig);
  check('生成提示：全文不含「12%」', !systemPrompt.includes('12%'));
  check('生成提示：不含「不得小于整个图形尺寸的 12%」', !systemPrompt.includes('不得小于整个图形尺寸的 12%'));
  check('生成提示：含复杂剪影 80~120 点规则（声明特征口径）', systemPrompt.includes('80~120') && systemPrompt.includes('声明特征不少于 3 个'), systemPrompt.includes('80~120') ? '' : '缺少 80~120');
  check('生成提示：简单图形不硬凑 features', systemPrompt.includes('不要硬凑 features'));
  check('生成提示：含简单图形 8~20 点规则', systemPrompt.includes('8~20'));
  // 方案 2026-11-05 §7.2：生成/修正提示与验收点数闸门同源——每部分上限 120，
  // 不再写 240（此前提示要求 240、验收按 120 执行，口径矛盾）。
  check('生成提示：每部分上限与验收一致（120 点，不是 240）', systemPrompt.includes(`每部分最多 ${FREEFORM_COMPLEX_POINT_MAX} 点`) && !systemPrompt.includes('每部分最多 240 点'));
  check('生成提示：保留禁止等宽矩形梳齿/方波', systemPrompt.includes('梳齿') && systemPrompt.includes('方波'));
  check('生成提示：保留真实长宽比要求', systemPrompt.includes('真实长宽比'));
  check('生成提示：保留先列 features 再描轮廓', systemPrompt.includes('先分析这个图形的鲜明特征'));

  const revised = reviseMessages({
    userText: '在广州画个小狗',
    shapeName: '小狗',
    feedback: ['四条腿呈方波', '尾巴细环自交'],
  });
  const reviseFullText = revised.map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content))).join('\n');
  check('修正提示：全文不含「12%」', !reviseFullText.includes('12%'));
  check('修正提示：不含「不得小于整个图形尺寸的 12%」', !reviseFullText.includes('不得小于整个图形尺寸的 12%'));
  check('修正提示：含复杂剪影 80~120 点规则（声明特征口径）', reviseFullText.includes('80~120') && reviseFullText.includes('声明特征不少于 3 个'));
  check('修正提示：简单图形不硬凑 features', reviseFullText.includes('不要硬凑 features'));
  check('修正提示：含简单图形 8~20 点规则', reviseFullText.includes('8~20'));
  check('修正提示：每部分上限与验收一致（120 点，不是 240）', reviseFullText.includes(`每部分最多 ${FREEFORM_COMPLEX_POINT_MAX} 点`) && !reviseFullText.includes('每部分最多 240 点'));
  check('修正提示：保留禁止等宽矩形梳齿/方波', reviseFullText.includes('梳齿') && reviseFullText.includes('方波'));
  check('修正提示：保留真实长宽比要求', reviseFullText.includes('真实长宽比'));

  // 口径一致性硬断言：提示文本里的数字必须来自 point-budget.js（防止再次漂移）
  check(
    '口径一致：提示的点数区间与验收常量同源',
    systemPrompt.includes(`${FREEFORM_COMPLEX_POINT_MIN}~${FREEFORM_COMPLEX_POINT_MAX} 点`)
      && reviseFullText.includes(`${FREEFORM_COMPLEX_POINT_MIN}~${FREEFORM_COMPLEX_POINT_MAX} 点`)
      && freeformPointRuleText().includes(`每部分最多 ${FREEFORM_COMPLEX_POINT_MAX} 点`),
    freeformPointRuleText(),
  );
}

// ---------- c) 修正只调一次且带 phase（§5.1 修正次数 + 阶段接口） ----------

/**
 * 用 fake LLM 跑一次质检闭环，记录每次调用的 messages 与 options（阶段）。
 *
 * @param {object} options
 * @param {object|Error} options.verdict 初检返回
 * @param {object|Error} [options.revision] 修正返回
 * @param {object|Error} [options.reReview] 复检返回
 * @returns {Promise<{outcome: object, calls: Array<{messages: object, phase: string|null}>}>}
 */
async function runReview({ verdict, revision, reReview = { verdict: 'like', seen: '像', issues: [] } }) {
  const calls = [];
  const callLlm = async (messages, options) => {
    calls.push({ messages, phase: options?.phase ?? null });
    const index = calls.length;
    if (index === 1) {
      if (verdict instanceof Error) throw verdict;
      return verdict;
    }
    if (index === 2) {
      if (revision instanceof Error) throw revision;
      return revision;
    }
    if (reReview instanceof Error) throw reReview;
    return reReview;
  };
  const outcome = await reviewTargetShape({
    userText: '在广州画个小狗',
    customShape: freeformRing(32, 0),
    callLlm,
    renderOutline: fakeRender,
    now: () => 0,
    onEvent: () => {},
    onProgress: () => {},
  });
  return { outcome, calls };
}

{
  // 一次 unlike → 修正 → 复检 like：三个阶段各一次，修正阶段恰好一次
  const { outcome, calls } = await runReview({
    verdict: { verdict: 'unlike', seen: '方波腿', issues: ['四条腿呈方波'] },
    revision: { name: '小狗B', features: [{ name: '尖耳', points: [[0, 0.4]] }], points: freeformRing(80, 3).outlinePoints },
    reReview: { verdict: 'like', seen: '像狗', issues: [] },
  });
  const revisionCalls = calls.filter((call) => call.phase === 'revision');
  check('修正次数：修正阶段只调用一次', revisionCalls.length === 1, `实际 ${revisionCalls.length}`);
  check('修正次数：修正调用 phase=revision', revisionCalls[0]?.phase === 'revision');
  check('修正次数：总调用三次（verdict/revision/re-review）', calls.length === 3 && calls.map((call) => call.phase).join(',') === 'verdict,revision,re-review', calls.map((call) => call.phase).join(','));
  check('修正次数：修正请求是修正提示（非质检消息）', JSON.stringify(revisionCalls[0]?.messages).includes('必须修正的问题') && !JSON.stringify(revisionCalls[0]?.messages).includes('质检员'));
  check('修正次数：复检通过后采纳修正版', outcome.adopted === true && outcome.verdict === 'like' && Boolean(outcome.customShape));
}

{
  // 修正请求抛错：不再发第二次修正，直接按"自由轮廓这一路失败"返回
  const { outcome, calls } = await runReview({
    verdict: { verdict: 'unlike', issues: ['不像'] },
    revision: new Error('模型请求超时（180 秒）'),
  });
  check('修正次数：修正失败不再重试（修正调用一次、总调用两次）', calls.filter((call) => call.phase === 'revision').length === 1 && calls.length === 2, `calls=${calls.length}`);
  check('修正次数：修正失败不采纳、不给合格结论', outcome.adopted === false && outcome.customShape === null);
}

{
  // 复检仍 unlike：不再发第二次修正（方案 §3：质检不像时只修正一次）
  const { outcome, calls } = await runReview({
    verdict: { verdict: 'unlike', issues: ['不像'] },
    revision: { name: '小狗B', points: freeformRing(80, 3).outlinePoints },
    reReview: { verdict: 'unlike', seen: '仍不像', issues: ['仍机械'] },
  });
  check('修正次数：复检仍 unlike 时不再修正（修正调用一次、总调用三次）', calls.filter((call) => call.phase === 'revision').length === 1 && calls.length === 3, `calls=${calls.length}`);
  check('修正次数：复检 unlike 时验收不通过', outcome.verdict === 'unlike' && outcome.available === true);
}

// ---------- d) llm 超时覆盖（修正请求 180 秒截止即停的底层能力） ----------

{
  const realFetch = globalThis.fetch;
  let calls = 0;
  // fetch 桩：挂起直到内部超时计时器 abort（不建真实连接）
  globalThis.fetch = (url, init) =>
    new Promise((resolve, reject) => {
      calls += 1;
      const signal = init?.signal;
      const rejectAbort = () => {
        const error = new Error('This operation was aborted');
        error.name = 'AbortError';
        reject(error);
      };
      if (signal?.aborted) {
        rejectAbort();
        return;
      }
      signal?.addEventListener('abort', rejectAbort, { once: true });
    });

  let error = null;
  const startedAt = performance.now();
  try {
    await chatCompletion({ messages: [{ role: 'user', content: '测试' }], retries: 0, timeoutMs: 40 });
  } catch (reason) {
    error = reason;
  } finally {
    globalThis.fetch = realFetch;
  }
  const elapsedMs = performance.now() - startedAt;

  check('超时覆盖：retries=0 时只发起一次请求', calls === 1, `实际 ${calls}`);
  check('超时覆盖：错误分类仍为 kind=timeout', error?.kind === 'timeout', `实际 ${error?.kind}`);
  check('超时覆盖：错误消息含「超时」', error?.message?.includes('超时') === true, String(error?.message));
  check('超时覆盖：按传入 timeoutMs 生效（40ms 而非配置 45s）', elapsedMs < 1000, `实际耗时 ${Math.round(elapsedMs)}ms`);
  const timeoutRecords = getEntries({ level: 'error', module: 'agent/llm' }).filter((record) => record.data?.kind === 'timeout');
  check('超时覆盖：llm.error 日志记录覆盖后的 timeoutMs=40', timeoutRecords.some((record) => record.data?.timeoutMs === 40), JSON.stringify(timeoutRecords.map((record) => record.data?.timeoutMs)));
  check('超时覆盖：测试结束已恢复 globalThis.fetch', globalThis.fetch === realFetch);
}

console.log(`\n[summary] ${checks - failures}/${checks} 项通过，失败 ${failures} 项`);
if (failures > 0) {
  process.exitCode = 1;
}
