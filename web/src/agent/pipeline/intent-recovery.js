/**
 * 意图解析 + 生成失败恢复（C4 拆分自 controller.js，纯移动）。
 *
 * 包含：LLM 原始意图的归一化、点列/参数化规格生成失败后的一次带原因恢复、
 * 点列失败的诚实失败意图，以及自由轮廓恢复模式（full/local A/B 实验开关）。
 */

import { createLogger } from '../../log/index.js';
import { chatCompletion } from '../llm.js';
import { normalizeCustomShape, normalizeIntent } from '../intent.js';
import { buildShapeFromSpec, describeShapeSpec, normalizeShapeSpec } from '../shape-spec.js';
import { isUnsupportedTopologyCode } from '../shape-validate.js';
import { reviseMessages } from '../shape-review.js';
import { rethrowIfAborted } from './shared.js';

/** 模块 logger：与 controller 同 label（日志归属口径不变） */
const log = createLogger('agent');

/**
 * 意图解析 + 自定义图形校验失败恢复。
 *
 * LLM 一次生成的点列可能自交/退化（2026-10-27 采样：5 个剪影请求 2 个被拒），
 * 旧链路在校验失败时静默丢弃点列、把 plan 翻成 recommend——用户要的图形被
 * 无声换成实测推荐。这里带具体失败原因重生成一次点列：成功则恢复 plan 通道；
 * 仍失败按"生成失败就是失败"诚实失败（2026-10-31 用户裁定），不再转实测推荐
 * ——替用户画一个没要过的图形，即使是明说的兜底，也是交付错误目标。
 *
 * 规则图形参数化通道（方案 §4/§6）：意图带 shapeSpec 时由参数化生成器产生 T，
 * 生成失败（参数组合导致退化/流水线改动关键顶点）时带几何原因让模型修正参数
 * 或退回自由点列；仍失败则 planBlocked——诚实失败，不静默换成另一种图形
 * （方案 §4 分派约束 3）。LLM 标了 plan 却没给出任何图形时同样诚实失败。
 *
 * @param {object} raw LLM 返回的意图 JSON
 * @param {string} text 用户原文
 * @param {object} [options]
 * @param {number|null} [options.explicitSizeMeters] 原文显式尺寸
 * @param {object} [options.trace] 链路（可空）
 * @param {AbortSignal} [options.signal] 中止信号（用户点"停止"）
 * @param {(step: {text: string, kind: string}) => void} [options.onProgress] 推理过程回调：
 *   恢复路径在发起第二次模型调用前先报一条可见步骤——恢复调用同样是非流式且耗时
 *   10~40 秒，界面上必须看得出"在重画"而不是卡死在「理解需求…」
 * @returns {Promise<object>} 归一化意图（恢复成功时 customShape 为修正版；
 *   参数化成功时 customShape 带 spec/source 元数据）
 */
export async function parseIntentWithRecovery(
  raw,
  text,
  { explicitSizeMeters = null, trace = null, signal = null, onProgress = null } = {},
) {
  let invalidReason = null;
  let invalidCode = null;
  if (raw && typeof raw === 'object' && raw.customShape) {
    normalizeCustomShape(raw.customShape, (reason, code) => {
      invalidReason = reason;
      invalidCode = code ?? null;
    });
  }
  const intent = normalizeIntent(raw, { explicitSizeMeters });

  // LLM 标了 plan 却没给出任何图形（无点列/规格/内置 key）：同样按"生成失败就是
  // 失败"诚实失败——它 believed 有图形要画，画不出来就明说，不转实测推荐替用户
  // 画一个没要过的图形（用户没点名图形时 LLM 会直接输出 recommend，不受影响）。
  if (intent.action === 'recommend' && !invalidReason
      && (intent.notes || []).some((note) => note.includes('plan 但未指定图形'))) {
    log.warn('shape.missing.blocked', { textHead: text.slice(0, 40) });
    return {
      ...intent,
      action: 'plan',
      customShape: null,
      shapeKey: null,
      planBlocked: '模型没有返回可绘制的轮廓点列',
      shapeBlockedName: null,
      notes: [...(intent.notes || []), '图形生成失败，按用户要求诚实失败，不再转实测推荐'],
    };
  }

  // 参数化通道：shapeSpec 校验通过 → 生成 T；生成失败 → 带原因恢复
  if (intent.action === 'plan' && intent.shapeSpec) {
    const built = buildShapeFromSpec(intent.shapeSpec);
    if (built.ok) {
      log.info('shape.procedural.built', {
        family: intent.shapeSpec.family,
        name: intent.shapeSpec.name,
        summary: describeShapeSpec(intent.shapeSpec),
        pointCount: built.customShape.outlinePoints.length,
        constraintCount: built.customShape.constraintPoints.length,
      });
      return {
        ...intent,
        customShape: built.customShape,
        notes: [...intent.notes, '规则图形按参数化规格生成（坐标由程序产生，可复现）'],
      };
    }
    log.warn('shape.procedural.failed', {
      family: intent.shapeSpec.family,
      name: intent.shapeSpec.name,
      reason: built.reason,
    });
    // 恢复调用是非流式模型请求（实测 10~40 秒）：先给用户一条可见步骤，避免界面停在「理解需求…」
    onProgress?.({ text: `参数化规格无法生成合法图形（${built.reason}），正在重新生成…`, kind: 'step' });
    const recovered = await recoverShapeByLlm({
      intent,
      text,
      trace,
      signal,
      feedback: [`参数化规格无法生成合法图形：${built.reason}`],
      extra:
        '上一版规格被参数化生成器拒收（不会进入规划）。请修正 shapeSpec 参数（半径比例/角数/aspect）使几何成立；若该图形其实不是规则图形，改用 customShape 徒手点列描述。',
    });
    if (recovered) {
      return recovered;
    }
    // 恢复失败：诚实失败（编排层不再规划），不静默换成推荐图形
    return {
      ...intent,
      planBlocked: `「${intent.shapeSpec.name || intent.shapeSpec.family}」的参数规格无法生成合法图形：${built.reason}`,
    };
  }

  // shapeSpec 校验失败（Schema 拒绝）：带原因恢复
  if (intent.action === 'plan' && intent.shapeSpecError) {
    log.warn('shape.spec.invalid', { reason: intent.shapeSpecError });
    // 同理由：恢复请求前先报步骤，让界面知道正在重画
    onProgress?.({ text: `图形规格校验未通过（${intent.shapeSpecError}），正在重新生成…`, kind: 'step' });
    const recovered = await recoverShapeByLlm({
      intent,
      text,
      trace,
      signal,
      feedback: [`shapeSpec 校验未通过：${intent.shapeSpecError}`],
      extra:
        '上一版 shapeSpec 未通过本地 Schema 校验（不会进入规划）。请修正参数（缺字段/数组长度/半径范围/非法角数等）；若该图形其实不是规则图形，改用 customShape 徒手点列描述。',
    });
    if (recovered) {
      return recovered;
    }
    return {
      ...intent,
      planBlocked: `图形规格校验未通过：${intent.shapeSpecError}`,
    };
  }

  // 只有"LLM 想给图形但点列非法"（被翻成 recommend）才恢复；chat/纯条件推荐不掺和
  if (!invalidReason || intent.action !== 'recommend') {
    return intent;
  }
  const shapeName = typeof raw.customShape?.name === 'string' ? raw.customShape.name : null;
  // 当前架构**确定不支持**的拓扑（嵌套孔洞）：再生成一版还是不支持，
  // 不浪费一次恢复调用，直接诚实失败并说明能力边界（方案 2026-11-08 §5.2）。
  if (isUnsupportedTopologyCode(invalidCode)) {
    log.warn('shape.recovery.skipped', {
      reason: invalidReason,
      code: invalidCode,
      shapeName,
      reason2: '当前架构不支持该拓扑（嵌套孔洞），不进入无效恢复',
    });
    return blockedShapeIntent(
      intent,
      raw,
      invalidReason,
      '当前架构不支持该拓扑，未再发起一次重生成',
      `这类图形目前画不了：${invalidReason}——路线要一笔画成，不能穿过中间的洞。可以改成没有孔洞的形状（比如实心圆环改成实心圆）再试。`,
    );
  }
  log.warn('shape.recovery.start', { reason: invalidReason, code: invalidCode, shapeName });
  // 恢复调用是非流式模型请求（实测 18~50 秒）：先给用户一条可见步骤，
  // 否则界面会一直停在「理解需求…」，看起来像卡死（用户 2026-11-04 反馈）
  onProgress?.({ text: `轮廓点列校验未通过（${invalidReason}），正在重新生成…`, kind: 'step' });
  const messages = reviseMessages({
    userText: text,
    shapeName,
    feedback: [`上一版点列未通过拓扑校验：${invalidReason}`],
    extra:
      '上一版因点列不合法被拒收（不会进入规划）。细窄往返结构（细尾巴/细脖子）极易自交，请画得短粗；四肢不要画成等宽矩形梳齿或方波。',
  });
  const startedAt = performance.now();
  try {
    const revisedRaw = trace
      ? await trace.withSpan('shape.recovery.llm', () => chatCompletion({ messages, signal }), { reason: invalidReason })
      : await chatCompletion({ messages, signal });
    const fixedShape = normalizeCustomShape(revisedRaw);
    if (!fixedShape) {
      log.warn('shape.recovery.invalid', { reason: invalidReason, durationMs: Math.round(performance.now() - startedAt) });
      return blockedShapeIntent(intent, raw, invalidReason, '重生成点列仍未通过校验');
    }
    log.info('shape.recovery.done', {
      reason: invalidReason,
      pointCount: fixedShape.outlinePoints.length,
      durationMs: Math.round(performance.now() - startedAt),
    });
    return {
      ...intent,
      action: 'plan',
      shapeKey: null,
      customShape: fixedShape,
      notes: [
        ...(intent.notes || []).filter(
          (note) => !note.includes('转 recommend') && !note.includes('校验未通过'),
        ),
        `轮廓点列校验未通过（${invalidReason}），已自动修正重生成`,
      ],
    };
  } catch (error) {
    // 用户点"停止"：中止错误必须原样上抛，不能被当成"点列恢复失败"降级成一次正常回复
    rethrowIfAborted(error, signal);
    log.warn('shape.recovery.failed', { reason: invalidReason, message: error.message }, error);
    return blockedShapeIntent(intent, raw, invalidReason, `重生成请求失败（${error.message}）`);
  }
}

/**
 * 点列生成失败的诚实失败意图（2026-10-31 用户裁定：生成失败就是失败）。
 *
 * 用户点名了图形而点列两轮（首轮 + 带原因恢复）都没能通过校验时，不再转入
 * 实测推荐——替用户画一个没要过的图形（哪怕是明说的兜底）仍是交付错误目标；
 * 按方案 §8.5"无法生成合法 T → 完全不调用路网引擎、诚实失败"执行。
 * planBlocked 由编排层返回失败回复（说明原因 + 建议重试/换说法/可选实测推荐），
 * 不绘制、不规划。
 *
 * @param {object} intent 归一化意图（action 已被翻成 recommend）
 * @param {object} raw LLM 原始返回（取图形名）
 * @param {string} invalidReason 首轮点列的拒收原因
 * @param {string} retryOutcome 恢复轮的结果概述
 * @param {string} [blockedMessage] 覆盖默认的 planBlocked 文案
 *   （用于"当前架构确定不支持"这类**没有恢复轮**的早停分支）
 * @returns {object} 带 planBlocked 的 plan 意图（编排层诚实失败，不规划）
 */
function blockedShapeIntent(intent, raw, invalidReason, retryOutcome, blockedMessage = null) {
  const shapeName = typeof raw?.customShape?.name === 'string' && raw.customShape.name.trim()
    ? raw.customShape.name.trim().slice(0, 10)
    : null;
  return {
    ...intent,
    action: 'plan',
    customShape: null,
    shapeKey: null,
    planBlocked:
      blockedMessage ||
      `轮廓点列两轮生成都没能通过校验（首轮：${invalidReason}；${retryOutcome}）`,
    shapeBlockedName: shapeName,
    notes: [...(intent.notes || []), '点列生成失败，按用户要求诚实失败，不再转实测推荐'],
  };
}

/**
 * 自由轮廓恢复模式（方案 2026-11-08 §5.3 的独立 A/B 实验项）。
 *
 * - `full`（默认）：现有单次恢复——带完整上下文重新生成一版点列；
 * - `local`：单次**低上下文/局部修复**恢复——只携带需修复的部分、相关约束与验证器反馈，
 *   不依赖当前服务尚未证明支持的推理控制字段，不通过插值凑点数；
 *   修正版仍执行完整拓扑/点数/视觉/约束验收。
 *
 * 采纳门槛（§5.3）：截断率下降、语义合格率不下降、交付率不下降、耗时不恶化，
 * 四项同时满足才可替换默认实现；未通过即保留 `full`。
 *
 * 通过环境变量切换，便于同一套输入在两种实现上跑真实 A/B：
 * `DRAWINMAP_RECOVERY_MODE=local`。
 */
export function recoveryMode() {
  const raw = (typeof process !== 'undefined' && process?.env?.DRAWINMAP_RECOVERY_MODE) || 'full';
  return raw === 'local' ? 'local' : 'full';
}

/**
 * 规格失败后的一次恢复：让模型修正 shapeSpec 参数或退回自由点列。
 * 返回 null 表示恢复失败（调用方诚实失败，不静默换图形）。
 *
 * @param {object} options
 * @param {object} options.intent 归一化意图
 * @param {string} options.text 用户原文
 * @param {object|null} options.trace 链路
 * @param {string[]} options.feedback 失败原因清单
 * @param {string} options.extra 附加要求
 * @param {AbortSignal} [options.signal] 中止信号（用户点"停止"）
 * @returns {Promise<object|null>} 恢复成功的新意图
 */
async function recoverShapeByLlm({ intent, text, trace, feedback, extra, signal = null }) {
  const local = recoveryMode() === 'local';
  const constraints = Array.isArray(intent?.userConstraints) ? intent.userConstraints : [];
  const messages = [
    {
      role: 'system',
      content: local
        ? '你是 DrawInMap 的图形轮廓局部修复器。上一版轮廓只有**被指出的那一部分**不合法。' +
          '只重画需要修的那一部分（其余部分沿用原样），输出完整 JSON：' +
          '{"name":"图形名","features":[...],"parts":[{"name":"部分名","points":[[x,y],...]}]} 或 ' +
          '{"name":"图形名","features":[...],"points":[[x,y],...]}（归一化坐标 [-0.5,0.5]，y 向上，闭环）。' +
          '只输出一个 JSON 对象，不要输出其他文字。'
        : '你是 DrawInMap 的图形规格修正器。用户想画一个图形，上一版参数/点列被本地校验拒收。' +
          '若该图形是规则图形（N 角星/正多边形/圆），输出修正后的 {"shapeSpec": {...}}；' +
          '否则输出自由点列 {"name":"图形名","features":[...],"points":[[x,y],...]}（归一化坐标 [-0.5,0.5]，y 向上，闭环）。' +
          '只输出一个 JSON 对象，不要输出其他文字。',
    },
    {
      role: 'user',
      content:
        `用户想画：${text}\n` +
        (local && constraints.length
          ? `用户明确提出的要求（新版必须保留）：\n${constraints.map((item) => `- ${item}`).join('\n')}\n`
          : '') +
        `${extra ? extra + '\n' : ''}必须修正的问题：\n${feedback
        .map((item) => `- ${item}`)
        .join('\n')}`,
    },
  ];
  const startedAt = performance.now();
  try {
    const revisedRaw = trace
      ? await trace.withSpan('shape.spec.recovery.llm', () => chatCompletion({ messages, signal }), { feedback: feedback[0] })
      : await chatCompletion({ messages, signal });
    const revised = revisedRaw && typeof revisedRaw === 'object' ? revisedRaw : null;
    if (revised?.shapeSpec) {
      const specResult = normalizeShapeSpec(revised.shapeSpec);
      if (specResult.ok) {
        const built = buildShapeFromSpec(specResult.spec);
        if (built.ok) {
          log.info('shape.spec.recovery.done', {
            name: specResult.spec.name,
            durationMs: Math.round(performance.now() - startedAt),
          });
          return {
            ...intent,
            shapeSpec: specResult.spec,
            shapeSpecError: null,
            customShape: built.customShape,
            planBlocked: null,
            notes: [...intent.notes, '规格校验失败后已按反馈修正参数，重新参数化生成'],
          };
        }
        log.warn('shape.spec.recovery.buildFailed', { reason: built.reason });
        return null;
      }
      log.warn('shape.spec.recovery.invalid');
      return null;
    }
    if (revised?.points || revised?.parts) {
      const fixedShape = normalizeCustomShape(revised);
      if (fixedShape) {
        log.info('shape.spec.recovery.freeform', {
          pointCount: fixedShape.outlinePoints.length,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return {
          ...intent,
          shapeSpec: null,
          shapeSpecError: null,
          customShape: fixedShape,
          planBlocked: null,
          notes: [...intent.notes, '参数化不可行，已按反馈改为自由轮廓生成（将通过完整目标验收）'],
        };
      }
      log.warn('shape.spec.recovery.freeformInvalid');
      return null;
    }
    log.warn('shape.spec.recovery.noShape');
    return null;
  } catch (error) {
    // 用户点"停止"：中止错误必须原样上抛，不能被当成"规格恢复失败"降级成一次正常回复
    rethrowIfAborted(error, signal);
    log.warn('shape.spec.recovery.failed', { message: error.message }, error);
    return null;
  }
}
