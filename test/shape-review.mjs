/**
 * 目标轮廓自检闭环测试（Node 直接运行，不依赖浏览器/网络/模型）。
 *
 * 覆盖：
 * - normalizeCustomShape 的 onInvalid 原因回调（自交/越界给出可读原因）
 * - 质检/修正消息构建（带图短输出、纯文本修正、参考图透传、用户约束逐项核对指令）
 * - 修正消息不含 12% 特征尺度要求、含复杂剪影 80~120 点规则（声明特征口径，
 *   方案 2026-11-01 §3；简单图形不硬凑 features）
 * - callLlm(messages, {phase}) 三阶段约定：verdict / revision / re-review；旧单参注入兼容
 * - parseVerdict 严格三态语义（方案 §8.1：取消 fail-open，缺失/未知 → unknown）
 * - reviewTargetShape 全分支：跳过（无渲染/截止/LLM 失败）、like 不修正、
 *   unlike 采纳合法修正版并复检（复检 like/unlike/不可用）、修正版不合法/
 *   失败保留原版、预算降级、用户显式约束逐项核对
 *
 * 运行：node test/shape-review.mjs
 */

import {
  normalizeCustomShape,
} from '../web/src/agent/intent.js';
import {
  OUTCOME_KEYS,
  parseVerdict,
  renderOutlineDataUrl,
  reviseMessages,
  reviewTargetShape,
  summarizeConstraints,
  verdictMessages,
} from '../web/src/agent/shape-review.js';

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

// ---------- 测试夹具 ----------
const circlePoints = Array.from({ length: 24 }, (_, i) => {
  const t = (Math.PI * 2 * i) / 24;
  return [Math.cos(t) * 0.4, Math.sin(t) * 0.4];
});
const validShape = normalizeCustomShape({ name: '圆形', points: circlePoints });
/** 蝴蝶结自交（非相邻边 0-1 与 2-3 交叉，无重复点） */
const bowtie = {
  name: '坏狗',
  points: [
    [-0.4, -0.4], [0.4, 0.4], [0.4, -0.4], [-0.4, 0.4],
  ],
};

// ---------- onInvalid 原因回调 ----------
{
  let reason = null;
  const shape = normalizeCustomShape(bowtie, (r) => { reason = r; });
  check('自交点列：归一化仍返回 null', shape === null);
  // 夹具点列会先被加密再校验，具体触发的拓扑条款可能不同（重合/自交），
  // 断言"给出了可读的拓扑失败原因"这一真正约定
  check('自交点列：onInvalid 给出拓扑失败原因', typeof reason === 'string' && reason.includes('拓扑不合法'), String(reason));

  let reason2 = null;
  normalizeCustomShape({ points: [[9, 9]] }, (r) => { reason2 = r; });
  check('越界点列：onInvalid 给出原因', typeof reason2 === 'string' && reason2.length > 0, String(reason2));

  let called = false;
  const ok = normalizeCustomShape({ name: '圆形', points: circlePoints }, () => { called = true; });
  check('合法点列：onInvalid 不触发', ok !== null && !called);
}

// ---------- 消息构建 ----------
{
  const messages = verdictMessages({
    userText: '在广州画个小狗',
    shapeName: '小狗',
    outlineDataUrl: 'data:image/png;base64,AAA',
    referenceDataUrl: 'data:image/png;base64,REF',
  });
  check('质检消息：带轮廓图', JSON.stringify(messages).includes('data:image/png;base64,AAA'));
  check('质检消息：参考图透传', JSON.stringify(messages).includes('base64,REF'));
  check('质检消息：只要求短 JSON（无点列字段）', !messages[0].content.includes('"points"'));
  check('质检消息：包含用户原文', messages[1].content[0].text.includes('在广州画个小狗'));
  check('质检消息：要求 verdict 必须明确（不得省略）', messages[0].content.includes('verdict 必须明确给出'));

  const noRef = verdictMessages({ userText: 'x', shapeName: null, outlineDataUrl: 'data:image/png;base64,AAA' });
  const imageCount = noRef[1].content.filter((part) => part.type === 'image_url').length;
  check('质检消息：无参考图时只有轮廓图', imageCount === 1);

  const withConstraints = verdictMessages({
    userText: '画把吉他',
    shapeName: '吉他',
    outlineDataUrl: 'data:image/png;base64,AAA',
    userConstraints: ['必须有琴颈', '琴身要收腰'],
  });
  check('质检消息：用户约束逐项列出', withConstraints[0].content.includes('1. 必须有琴颈') && withConstraints[0].content.includes('2. 琴身要收腰'));
  check('质检消息：要求逐项输出 constraints', withConstraints[0].content.includes('"constraints"'));

  const revise = reviseMessages({
    userText: '在广州画个小狗',
    shapeName: '小狗',
    feedback: ['四条腿呈方波', '尾巴细环自交'],
    extra: '上一版因点列不合法被拒收。',
  });
  const reviseText = revise[1].content;
  check('修正消息：包含问题清单', reviseText.includes('四条腿呈方波') && reviseText.includes('尾巴细环自交'));
  check('修正消息：包含附加说明', reviseText.includes('上一版因点列不合法被拒收'));
  check('修正消息：要求输出完整点列', revise[1].content.includes('"points"'));
  check('修正消息：纯文本（无图片）', Array.isArray(revise[1].content) === false);
  // 方案 2026-11-01 §3：12% 特征尺度不再写进目标点列提示，点数按复杂度分档
  check('修正消息：system 不含 12% 特征尺度要求', !revise[0].content.includes('12%'));
  check('修正消息：system 含复杂剪影 80~120 点规则', revise[0].content.includes('80~120'));
  check('修正消息：复杂剪影按声明特征口径（声明特征不少于 3 个）', revise[0].content.includes('声明特征不少于 3 个'));
  check('修正消息：简单图形不要硬凑 features', revise[0].content.includes('不要硬凑 features'));
  check('修正消息：保留禁止等宽矩形梳齿/方波要求', revise[0].content.includes('梳齿') && revise[0].content.includes('方波'));
  check('修正消息：保留真实长宽比要求', revise[0].content.includes('真实长宽比'));

  const reviseWithConstraints = reviseMessages({
    userText: '画把吉他',
    shapeName: '吉他',
    feedback: ['不像'],
    userConstraints: ['必须有琴颈'],
  });
  check('修正消息：用户约束要求保留', reviseWithConstraints[1].content.includes('- 必须有琴颈'));
}

// ---------- parseVerdict（严格三态，方案 §8.1 取消 fail-open） ----------
{
  check('verdict=unlike 原样保留', parseVerdict({ verdict: 'unlike', seen: 'x', issues: ['a'] }).verdict === 'unlike');
  check('verdict=like 原样保留', parseVerdict({ verdict: 'like', seen: 'x', issues: [] }).verdict === 'like');
  check('verdict 缺失 → unknown（验收不可用）', parseVerdict({}).verdict === 'unknown');
  check('verdict 未知值 → unknown', parseVerdict({ verdict: 'maybe' }).verdict === 'unknown');
  check('只有 seen 合理不算通过', parseVerdict({ seen: '像一只狗' }).verdict === 'unknown' && parseVerdict({ seen: '像一只狗' }).verdict !== 'like');
  check('issues 非字符串过滤', parseVerdict({ verdict: 'unlike', issues: ['a', 3, null, 'b'] }).issues.join(',') === 'a,b');
  check('issues 上限 6 条', parseVerdict({ issues: ['1', '2', '3', '4', '5', '6', '7', '8'] }).issues.length === 6);
  check('seen 非字符串 → 空串', parseVerdict({ seen: 42 }).seen === '');
  check('无约束要求时 constraints 为 null', parseVerdict({ verdict: 'like', constraints: [{ text: 'x', result: 'pass' }] }).constraints === null);
  check('有约束要求时逐项解析', parseVerdict(
    { verdict: 'like', constraints: [{ text: '必须有琴颈', result: 'pass' }, { text: '收腰', result: 'unsure' }] },
    2,
  ).constraints?.length === 2);
  check('非法约束结果归为 unsure', parseVerdict({ constraints: [{ text: 'x', result: 'whatever' }] }, 1).constraints[0].result === 'unsure');
  check('要求核对但模型未返回 → null（不可判定）', parseVerdict({ verdict: 'like' }, 2).constraints === null);
}

// ---------- summarizeConstraints（合取语义） ----------
{
  check('无约束 → 通过', summarizeConstraints(null, []).ok === true);
  check('全 pass → 通过', summarizeConstraints([{ text: 'a', result: 'pass' }], ['a']).ok === true);
  check('任一 fail → 不通过', summarizeConstraints([{ text: 'a', result: 'pass' }, { text: 'b', result: 'fail' }], ['a', 'b']).ok === false);
  check('unsure → 不通过（不得给绿线）', summarizeConstraints([{ text: 'a', result: 'unsure' }], ['a']).ok === false);
  check('约束清单缺失 → 不可判定', summarizeConstraints(null, ['a']).unavailable === true);
}

// ---------- reviewTargetShape ----------
/** fake 渲染器（返回 data url 表示"浏览器环境"） */
const fakeRender = () => 'data:image/png;base64,FAKE';
/** 不支持渲染（Node 环境） */
const nullRender = () => null;

/**
 * 三段式 fake LLM：质检 → 修正 → 复检，各返回独立夹具。
 * 第二参数收集 phase（方案 2026-11-01 §3 接口约定：verdict/revision/re-review）。
 */
async function runReview({
  verdictJson,
  revisionJson,
  reVerdictJson = null,
  renderOutline = fakeRender,
  deadlineAt = null,
  now,
  userConstraints = [],
} = {}) {
  const calls = [];
  const phases = [];
  const steps = [];
  const events = [];
  const callLlm = async (messages, options) => {
    calls.push(messages);
    phases.push(options?.phase ?? null);
    const index = calls.length;
    if (index === 1) {
      if (verdictJson instanceof Error) throw verdictJson;
      return typeof verdictJson === 'function' ? verdictJson() : verdictJson;
    }
    if (index === 2) {
      if (revisionJson instanceof Error) throw revisionJson;
      return typeof revisionJson === 'function' ? revisionJson() : revisionJson;
    }
    // 复检轮：缺省 like（修正版合格）
    const payload = reVerdictJson instanceof Error ? reVerdictJson : reVerdictJson ?? { verdict: 'like', seen: '像', issues: [] };
    if (payload instanceof Error) throw payload;
    return typeof payload === 'function' ? payload() : payload;
  };
  const outcome = await reviewTargetShape({
    userText: '在广州画个小狗',
    customShape: validShape,
    userConstraints,
    callLlm,
    renderOutline,
    deadlineAt,
    now: now || (() => 0),
    onEvent: (e) => events.push(e),
    onProgress: (s) => steps.push(s.text),
  });
  return { outcome, calls, steps, events, phases };
}

// 1. 无渲染器（Node）→ 跳过且不调 LLM；验收不可用
{
  const { outcome, calls } = await runReview({ renderOutline: nullRender });
  check('无渲染器：skipped=no-render', outcome.skipped === 'no-render');
  check('无渲染器：不发起 LLM 调用', calls.length === 0);
  check('无渲染器：available=false（验收不可用）', outcome.available === false && outcome.verdict === 'unknown');
}

// 2. 截止时间已过 → 跳过
{
  const { outcome, calls } = await runReview({ deadlineAt: 1000, now: () => 5000 });
  check('截止已过：skipped=deadline', outcome.skipped === 'deadline');
  check('截止已过：不发起 LLM 调用', calls.length === 0);
}

// 3. verdict=like → 不修正、验收通过
{
  const { outcome, calls, steps, phases } = await runReview({ verdictJson: { verdict: 'like', seen: '一只狗' } });
  check('like：不修正', outcome.adopted === false && outcome.customShape === null);
  check('like：只调一次 LLM', calls.length === 1);
  check('like：进度提示"像"', steps.some((s) => s.includes('像')));
  check('like：验收可用且通过', outcome.available === true && outcome.verdict === 'like');
  check('like：质检阶段 phase=verdict', phases.join(',') === 'verdict', phases.join(','));
}

// 4. verdict=unlike + 合法修正版 + 复检 like → 采纳（v2）
{
  const revisedPoints = Array.from({ length: 28 }, (_, i) => {
    const t = (Math.PI * 2 * i) / 28;
    return [Math.cos(t) * 0.45, Math.sin(t) * 0.42];
  });
  const { outcome, calls, phases } = await runReview({
    verdictJson: { verdict: 'unlike', seen: '方波腿', issues: ['四条腿呈方波'] },
    revisionJson: { name: '小狗B', features: [{ name: '尖耳', points: [[0, 0.4]] }], points: revisedPoints },
  });
  check('unlike+合法修正：采纳', outcome.adopted === true && Boolean(outcome.customShape));
  check('unlike+合法修正：调三次 LLM（质检+修正+复检）', calls.length === 3, `calls=${calls.length}`);
  check('unlike+合法修正：修正版是归一化形状', outcome.customShape.outlinePoints.length >= 24);
  check('unlike+合法修正：复检通过后验收可用', outcome.available === true && outcome.verdict === 'like');
  check('unlike+合法修正：attempts 记录两版结论', outcome.attempts.length === 2 && outcome.attempts[0].version === 1 && outcome.attempts[1].version === 2);
  check('unlike+合法修正：三阶段 phase 依次为 verdict/revision/re-review', phases.join(',') === 'verdict,revision,re-review', phases.join(','));
  const secondCall = JSON.stringify(calls[1]);
  check('unlike+合法修正：修正请求带问题清单', secondCall.includes('四条腿呈方波'));
}

// 4b. 修正版复检 unlike → 采纳但验收不通过（不得给绿线）
{
  const revisedPoints = Array.from({ length: 28 }, (_, i) => {
    const t = (Math.PI * 2 * i) / 28;
    return [Math.cos(t) * 0.45, Math.sin(t) * 0.42];
  });
  const { outcome } = await runReview({
    verdictJson: { verdict: 'unlike', issues: ['不像'] },
    revisionJson: { name: '小狗B', points: revisedPoints },
    reVerdictJson: { verdict: 'unlike', seen: '还是不像', issues: ['仍机械'] },
  });
  check('复检 unlike：采纳修正版但验收不通过', outcome.adopted === true && outcome.verdict === 'unlike' && outcome.available === true);
  check('复检 unlike：最终 T 为修正版（诊断参考用）', Boolean(outcome.customShape));
}

// 4c. 修正版复检不可用 → 验收不可用（不得给绿线，可诊断参考）
{
  const revisedPoints = Array.from({ length: 28 }, (_, i) => {
    const t = (Math.PI * 2 * i) / 28;
    return [Math.cos(t) * 0.45, Math.sin(t) * 0.42];
  });
  const { outcome } = await runReview({
    verdictJson: { verdict: 'unlike', issues: ['不像'] },
    revisionJson: { name: '小狗B', points: revisedPoints },
    reVerdictJson: { seen: '看着合理' },
  });
  check('复检结论缺失：验收不可用', outcome.available === false && outcome.verdict === 'unknown');
  check('复检结论缺失：修正版已采纳（诊断参考用）', outcome.adopted === true && Boolean(outcome.customShape));
}

// 5. verdict=unlike + 修正版不合法 → 保留原版
{
  const { outcome, calls, phases } = await runReview({
    verdictJson: { verdict: 'unlike', issues: ['不像'] },
    revisionJson: bowtie,
  });
  check('unlike+非法修正：不采纳', outcome.adopted === false && outcome.customShape === null);
  check('unlike+非法修正：仍调用了修正', calls.length === 2);
  check('unlike+非法修正：验收结论为 unlike', outcome.available === true && outcome.verdict === 'unlike');
  check('unlike+非法修正：修正版不合法不进入复检（phase 只有 verdict/revision）', phases.join(',') === 'verdict,revision', phases.join(','));
}

// 6. 修正 LLM 失败 → 保留原版不抛错
{
  const { outcome } = await runReview({
    verdictJson: { verdict: 'unlike', issues: ['不像'] },
    revisionJson: new Error('网络错误'),
  });
  check('修正失败：不采纳且不抛错', outcome.adopted === false && outcome.verdict === 'unlike');
}

// 7. 质检 LLM 失败 → 验收不可用
{
  const { outcome, calls } = await runReview({ verdictJson: new Error('模型请求超时（180 秒）') });
  check('质检失败：skipped=llm-error', outcome.skipped === 'llm-error');
  check('质检失败：不再尝试修正', calls.length === 1);
  check('质检失败：available=false（不得给绿线）', outcome.available === false);
}

// 8. unlike 但无问题清单 → 无从修正
{
  const { outcome, calls } = await runReview({ verdictJson: { verdict: 'unlike', issues: [] } });
  check('unlike 无 issues：不修正', outcome.adopted === false && calls.length === 1);
}

// 9. 修正前预算不足 → 保留原版（降级）
{
  let clock = 0;
  const { outcome, calls, phases } = await runReview({
    verdictJson: { verdict: 'unlike', issues: ['不像'] },
    deadlineAt: 12000 + 1,
    now: () => {
      clock += 1000;
      return clock; // 质检后时钟已越过修正下限
    },
  });
  check('修正预算不足：不发起修正', outcome.adopted === false && calls.length === 1);
  check('修正预算不足：只有 verdict 阶段调用', phases.join(',') === 'verdict', phases.join(','));
}

// 9b. 向后兼容：旧注入函数只声明 messages 时忽略第二参数，行为不变
{
  const legacyCalls = [];
  const legacy = await reviewTargetShape({
    userText: '在广州画个小狗',
    customShape: validShape,
    callLlm: async (messages) => {
      legacyCalls.push(messages);
      return { verdict: 'like', seen: '像', issues: [] };
    },
    renderOutline: fakeRender,
    now: () => 0,
    onEvent: () => {},
  });
  check('旧注入函数（只收 messages）：正常完成质检', legacy.available === true && legacy.verdict === 'like');
  check('旧注入函数（只收 messages）：单次调用', legacyCalls.length === 1);
}

// 10. 用户显式约束：整体像但约束 fail/缺失 → 合取不通过
{
  const { outcome } = await runReview({
    verdictJson: { verdict: 'like', seen: '像吉他', constraints: [{ text: '必须有琴颈', result: 'fail' }] },
    userConstraints: ['必须有琴颈'],
  });
  check('约束 fail：合取不通过', outcome.available === true && outcome.constraintSummary.ok === false);
  check('约束 fail：constraintFailed 标记', outcome.constraintFailed === true);
}
{
  const { outcome } = await runReview({
    verdictJson: { verdict: 'like', seen: '像吉他' },
    userConstraints: ['必须有琴颈'],
  });
  check('约束未逐项核对：不可判定', outcome.constraintSummary.unavailable === true && outcome.constraintFailed === true);
}
{
  const { outcome } = await runReview({
    verdictJson: { verdict: 'unlike', issues: ['不像'], constraints: [{ text: '必须有琴颈', result: 'pass' }] },
    revisionJson: { name: '琴', points: circlePoints },
    reVerdictJson: { verdict: 'like', seen: '像', constraints: [{ text: '必须有琴颈', result: 'pass' }] },
    userConstraints: ['必须有琴颈'],
  });
  check('约束 pass + 复检 like：通过', outcome.available === true && outcome.verdict === 'like' && outcome.constraintSummary.ok === true);
}

// 11. 浏览器渲染器直测：Node 无 document 返回 null
{
  check('renderOutlineDataUrl：Node 环境返回 null', renderOutlineDataUrl(validShape) === null);
  check('renderOutlineDataUrl：空轮廓返回 null', renderOutlineDataUrl({ outlinePoints: [] }) === null);
}

// 12. 气泡点序列交付朝向（方案 5.5）：rotateShapePoints 与 projectShape 同一旋转矩阵
{
  const { rotateShapePoints } = await import('../web/src/agent/shape-review.js');
  const { projectShape } = await import('../web/src/engine/planner.js');
  const sample = [
    [0, 0.5],
    [-0.4, -0.3],
    [0.35, -0.25],
    [0.1, 0.2],
  ];
  for (const rotationDeg of [0, 10, 350, 90]) {
    const rotated = rotateShapePoints(sample, rotationDeg);
    // projectShape 在 center=(0,0)、size=1 时：lat = rotatedY / 111320，lng = rotatedX / 111320
    const projected = projectShape(sample, { lat: 0, lng: 0 }, 1, rotationDeg);
    const maxError = Math.max(
      ...rotated.flatMap(([rx, ry], i) => [
        Math.abs(rx - projected[i][1] * 111320),
        Math.abs(ry - projected[i][0] * 111320),
      ]),
    );
    check(
      `rotateShapePoints：rotationDeg=${rotationDeg} 与 projectShape 同矩阵（误差 0）`,
      maxError < 1e-6,
      `maxError=${maxError}`,
    );
  }
  // 缺省不旋转：rotationDeg 缺省 0，点列原样返回
  const noRotation = rotateShapePoints(sample);
  const sameAsZero = rotateShapePoints(sample, 0);
  const identical = noRotation.every(
    ([x, y], i) => x === sample[i][0] && y === sample[i][1] && x === sameAsZero[i][0] && y === sameAsZero[i][1],
  );
  check('rotateShapePoints：缺省 rotationDeg=0 且点列不变', identical);
}

// 13. T-B2b：11 处返回分支统一键集（outcomeOf 构造，对比 OUTCOME_KEYS）
// 口径：全部结论对象的前 9 个键与 OUTCOME_KEYS 顺序一致；分支附加字段必须在已知白名单内。
{
  const EXTRA_KEYS = ['skipped', 'failureKind', 'failureMessage', 'terminatedWith', 'constraintFailed', 'reReviewSkipped'];
  const checkOutcomeKeys = (label, outcome) => {
    const keys = Object.keys(outcome);
    const missing = OUTCOME_KEYS.filter((key) => !keys.includes(key));
    const extras = keys.filter((key) => !OUTCOME_KEYS.includes(key));
    const badExtras = extras.filter((key) => !EXTRA_KEYS.includes(key));
    check(
      `${label}：键集与 OUTCOME_KEYS 一致`,
      missing.length === 0
        && keys.slice(0, OUTCOME_KEYS.length).join(',') === OUTCOME_KEYS.join(',')
        && badExtras.length === 0,
      `missing=${JSON.stringify(missing)} extras=${JSON.stringify(extras)} keys=${JSON.stringify(keys)}`,
    );
  };

  const scenarios = [];
  scenarios.push(['like 通过', (await runReview({ verdictJson: { verdict: 'like', seen: '像' } })).outcome]);
  scenarios.push([
    'like 但约束未过',
    (await runReview({
      verdictJson: { verdict: 'like', seen: '像', constraints: [{ text: '必须有琴颈', result: 'fail' }] },
      userConstraints: ['必须有琴颈'],
    })).outcome,
  ]);
  scenarios.push(['结论缺失（unknown）', (await runReview({ verdictJson: { seen: '看不清' } })).outcome]);
  scenarios.push(['质检调用失败（unknown+skipped）', (await runReview({ verdictJson: new Error('boom') })).outcome]);
  scenarios.push([
    'unlike 但未说明问题',
    (await runReview({ verdictJson: { verdict: 'unlike', issues: [] } })).outcome,
  ]);
  scenarios.push([
    '修正调用失败（skipped/failureKind/terminatedWith）',
    (await runReview({ verdictJson: { verdict: 'unlike', issues: ['不像'] }, revisionJson: new Error('修正失败') })).outcome,
  ]);
  scenarios.push([
    '修正版不合法',
    (await runReview({ verdictJson: { verdict: 'unlike', issues: ['不像'] }, revisionJson: { name: '坏', points: [[0, 0], [1, 1]] } })).outcome,
  ]);
  {
    // 预算顺序：顶层检查→初检 startedAt/duration→修正截止检查→修正 startedAt/duration→复检截止检查
    const times = [0, 0, 0, 0, 0, 0, 99000];
    let index = 0;
    const { outcome } = await runReview({
      verdictJson: { verdict: 'unlike', issues: ['不像'] },
      revisionJson: { name: '小狗B', points: circlePoints },
      deadlineAt: 100000,
      now: () => times[Math.min(index++, times.length - 1)],
    });
    check('复检截止：reReviewSkipped=deadline', outcome.reReviewSkipped === 'deadline');
    scenarios.push(['复检截止（reReviewSkipped）', outcome]);
  }
  scenarios.push([
    '修正版复检通过（final）',
    (await runReview({
      verdictJson: { verdict: 'unlike', issues: ['不像'] },
      revisionJson: { name: '小狗B', points: circlePoints },
    })).outcome,
  ]);
  {
    const onlyReview = await reviewTargetShape({
      userText: '在广州画个小狗',
      customShape: validShape,
      callLlm: async () => ({ verdict: 'unlike', issues: ['不像'] }),
      renderOutline: fakeRender,
      allowRevision: false,
      now: () => 0,
    });
    scenarios.push(['只质检不修正（unlike）', onlyReview]);
  }
  for (const [label, outcome] of scenarios) {
    checkOutcomeKeys(label, outcome);
  }
}

console.log(`\n[summary] ${checks - failures}/${checks} 项通过，失败 ${failures} 项`);
if (failures > 0) {
  process.exitCode = 1;
}
