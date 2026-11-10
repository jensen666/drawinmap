/**
 * 交付与摘要辅助（C4 拆分自 controller.js，纯移动）。
 *
 * 包含：点序列图预览、日志摘要（意图/规划/轮廓）、图像描摹目标构造与提示文本、
 * 地名展示文本，以及参考版/诊断版交付出口工厂（B2 已抽取的 deliverReference）。
 */

import { SHAPES } from '../../engine/shapes.js';
import { sha256Hex, stableStringify } from '../../reference/hash.js';
import { throwIfAborted } from '../../cancel.js';
import { describeShapeSpec } from '../shape-spec.js';
import { renderOutlineDataUrl } from '../shape-review.js';
import { normalizeCustomShape } from '../intent.js';

/** 图像描摹 contentHash 载荷 schema（与参考候选同一套稳定序列化+纯 JS SHA-256） */
const IMAGE_TRACE_HASH_SCHEMA = 'image-trace-v1';

/**
 * 轮廓摘要（日志用）。只留名称、来源和点数，不写点列本身：
 * 轮廓点与约束点常是同一数组的重复引用，整对象丢进 JSONL 会被写成 [Circular]
 * （见 test/fixtures/fixed-samples.mjs）；几百个点也不该出现在每轮 plan.request 里。
 *
 * @param {object|null} customShape 归一化轮廓
 * @returns {object|null} 可读摘要
 */
export function summarizeShape(customShape) {
  if (!customShape?.outlinePoints) {
    return null;
  }
  return {
    name: customShape.name,
    source: customShape.source ?? null,
    outlinePoints: customShape.outlinePoints.length,
    constraintPoints: customShape.constraintPoints?.length ?? 0,
    parts: customShape.parts?.length ?? 1,
    // 图像描摹目标的内容哈希：与落盘 outline.contentHash、agent.imageTrace.used 同值，
    // 供 E2E 断言"页面点列 === 贴路 T 是同一版"（方案 2026-11-01 §4.2）
    contentHash: customShape.contentHash ?? null,
  };
}

/**
 * 内置图形的可渲染轮廓（用于借视觉质检能力核对用户显式约束）。
 *
 * 内置图形没有 customShape（轮廓由引擎在搜索时按尺寸/朝向投影），
 * 但质检只需要"这个形状长什么样"，用规范轮廓渲染即可。
 *
 * @param {string|null} shapeKey 内置图形标识
 * @returns {object|null} 可渲染的 customShape 形状；未知图形返回 null
 */
export function builtinReviewShape(shapeKey) {
  const shape = SHAPES[shapeKey];
  if (!shape || typeof shape.buildOutline !== 'function') {
    return null;
  }
  const outlinePoints = shape.buildOutline();
  if (!Array.isArray(outlinePoints) || outlinePoints.length < 3) {
    return null;
  }
  return {
    name: shape.name,
    outlinePoints,
    parts: [{ name: shape.name, outlineStart: 0, outlineCount: outlinePoints.length }],
  };
}

/**
 * 意图摘要（日志用，避免把完整轮廓点列塞进编排日志——点列由引擎 plan.request 完整记录）。
 *
 * @param {object} intent 归一化意图
 * @returns {object} 可读摘要
 */
export function summarizeIntent(intent) {
  if (!intent) {
    return null;
  }
  return {
    action: intent.action,
    shapeKey: intent.shapeKey,
    customShape: summarizeShape(intent.customShape),
    shapeSpec: intent.shapeSpec
      ? {
          family: intent.shapeSpec.family,
          variant: intent.shapeSpec.variant,
          pointCount: intent.shapeSpec.pointCount,
          summary: describeShapeSpec(intent.shapeSpec),
          seed: intent.shapeSpec.seed,
          // 实际规格参数（方案 2026-11-08 §6.1：参数化实际规格必须可断言——
          // "实际 innerRadii/outerRadii=0.5 且不变量通过"要能从日志直接核对）
          outerRadii: intent.shapeSpec.outerRadii ?? null,
          innerRadii: intent.shapeSpec.innerRadii ?? null,
          aspect: intent.shapeSpec.aspect ?? null,
          userConstraints: (intent.shapeSpec.userConstraints ?? []).map((item) =>
            typeof item === 'string' ? item : item?.text ?? '',
          ),
        }
      : null,
    shapeSpecError: intent.shapeSpecError ?? null,
    planBlocked: intent.planBlocked ?? null,
    userConstraints: intent.userConstraints ?? [],
    referenceQuery: intent.referenceQuery ?? null,
    requestObjects: intent.requestObjects ?? [],
    place: intent.place,
    centerChosen: Boolean(intent.centerChosen),
    sizeMeters: intent.sizeMeters,
    sizeExplicit: intent.sizeExplicit === true,
    sizeToleranceMeters: intent.sizeToleranceMeters ?? null,
    rotationDeg: intent.rotationDeg,
    rotationExplicit: intent.rotationExplicit === true,
    reply: intent.reply,
    notes: intent.notes,
  };
}

/**
 * 规划结果摘要（日志用：状态/阶段/候选数/最优候选/指标/偏移）。
 *
 * @param {object|null} planned 引擎规划或推荐结果
 * @returns {object|null} 可读摘要
 */
export function summarizePlanned(planned) {
  if (!planned) {
    return null;
  }
  const best = planned.best || planned.drawn || null;
  return {
    status: planned.status ?? null,
    reason: planned.reason ?? null,
    stage: planned.stage ?? null,
    stageLabel: planned.stageLabel ?? null,
    // 来源阶段口径（方案 2026-11-05 §5.2）：stage = 粗搜来源级别，
    // 是否精修/最终来源分别记录，不再共用一个 stage 值。
    refined: planned.refined ?? false,
    sourceStage: planned.sourceStage ?? planned.stage ?? null,
    sourceStageLabel: planned.sourceStageLabel ?? planned.stageLabel ?? null,
    sourceSizeMeters: planned.sourceSizeMeters ?? null,
    finalSource: planned.finalSource ?? null,
    finalStage: planned.finalStage ?? null,
    finalStageLabel: planned.finalStageLabel ?? null,
    triedCount: planned.triedCount ?? null,
    budgetExhausted: planned.budgetExhausted ?? null,
    best: best
      ? {
          score: best.score ?? null,
          adjustedScore: best.adjustedScore ?? null,
          sizeMeters: best.sizeMeters ?? null,
          rotationDeg: best.rotationDeg ?? null,
          center: best.center ?? null,
        }
      : null,
    // 近场证据（偏移说明用；失败但无候选时为 null）
    nearBest: planned.nearBest
      ? {
          score: planned.nearBest.score ?? null,
          adjustedScore: planned.nearBest.adjustedScore ?? null,
          sizeMeters: planned.nearBest.sizeMeters ?? null,
          rotationDeg: planned.nearBest.rotationDeg ?? null,
          center: planned.nearBest.center ?? null,
        }
      : null,
    offset: planned.offset
      ? { meters: Math.round(planned.offset.meters), text: planned.offset.text }
      : null,
    metrics: planned.result?.metrics ?? best?.result?.metrics ?? null,
    recommendations:
      planned.recommendations?.map((item) => ({
        shapeName: item.shapeName,
        score: item.score,
        sizeMeters: item.sizeMeters,
        rotationDeg: item.rotationDeg,
      })) ?? null,
  };
}

/**
 * 点序列图预览：把本轮实际用于规划的目标轮廓（参考图 T 点列 / 参数化 T / LLM 点列 / 内置图形）
 * 渲染成小图，随回复一并展示——地图上画的是贴了路网的路线，这里让用户直接看到
 * "系统理解的目标形状"（参考图命中是否正确、参数化/LLM 画的是什么，一眼可查）。
 *
 * 朝向（方案 5.5）：有交付候选时传入最终 rotationDeg，小图与地图紫色虚线保持
 * 同一刚体旋转；无候选朝向（null）时不旋转。
 *
 * Node 测试环境无 canvas，dataUrl 为 null（调用方据此跳过渲染），元数据仍可用于断言。
 *
 * @param {object} options
 * @param {object|null} options.customShape 本轮实际用于规划的目标轮廓（自由轮廓修正采纳时为修正版）
 * @param {string|null} options.shapeKey 内置图形 key（无自定义图形时使用）
 * @param {object|null} [options.referenceSource] 参考图命中信息（区分点列来源）
 * @param {number|null} [options.rotationDeg] 最终交付候选的朝向（度；null = 无候选朝向，不旋转）
 * @returns {{name: string|null, source: 'reference'|'procedural'|'llm'|'builtin'|'traced', pointCount: number,
 *   rotationDeg: number|null, contentHash: string|null, points?: Array<[number, number]>, dataUrl: string|null}|null}
 *   预览元数据；既无自定义图形也非内置图形时为 null
 */
export function buildOutlinePreview({ customShape, shapeKey, referenceSource = null, rotationDeg = null }) {
  let outlinePoints = null;
  let parts = null;
  let name = null;
  let source = 'builtin';
  if (customShape?.outlinePoints?.length) {
    outlinePoints = customShape.outlinePoints;
    parts = customShape.parts || null;
    name = customShape.name || null;
    if (referenceSource) {
      source = 'reference';
    } else if (customShape.source === 'procedural') {
      source = 'procedural';
    } else if (customShape.source === 'traced') {
      // 图像描摹目标（方案 2026-11-01 §3）：点列来源单独记为 traced，
      // 与参考图命中/LLM 生成区分，UI 图注显示「图像描摹」
      source = 'traced';
    } else {
      source = 'llm';
    }
  } else if (shapeKey && SHAPES[shapeKey]) {
    outlinePoints = SHAPES[shapeKey].buildOutline();
    name = SHAPES[shapeKey].name;
  }
  if (!outlinePoints?.length) {
    return null;
  }
  const deliveredRotation = Number.isFinite(rotationDeg) ? rotationDeg : null;
  const preview = {
    name,
    source,
    pointCount: outlinePoints.length,
    rotationDeg: deliveredRotation,
    // 内容哈希（仅图像描摹目标有值；其它来源为 null）：E2E 用它与贴路 T 对齐
    contentHash: customShape?.contentHash ?? null,
    dataUrl: renderOutlineDataUrl(
      { name, outlinePoints, parts },
      { size: 160, rotationDeg: deliveredRotation ?? 0 },
    ),
  };
  // 归一化点列仅随图像描摹目标输出（方案 2026-11-01 §4.2：链路验收要拿页面真实
  // 点列做独立 IoU 校验）；其它来源不输出，控制会话存储体积
  if (source === 'traced') {
    preview.points = outlinePoints.map((point) => [point[0], point[1]]);
  }
  return preview;
}

/**
 * 构造图像描摹目标轮廓（方案 2026-11-01 §3）：`normalizeCustomShape` 与现有拓扑校验
 * 通过后，附加 source/contentHash/trace 元数据。归一化失败（点列退化/自交等）返回
 * null，编排层按"描摹失败"处理——不调用模型补点、不规划。
 *
 * contentHash 只由本次描摹实际点列与元数据决定（schema 固定），与参考候选的
 * contentHash 同一套稳定序列化 + 纯 JS SHA-256；落盘 outline、agent.imageTrace.used
 * 日志、plan.request.customShape 三处同值，供链路验收断言"页面点列与贴路 T 是同一版"。
 *
 * @param {{points: Array<[number, number]>, diagnostics: object}} traced 描摹结果
 * @returns {object|null} 带 source='traced'/contentHash/trace 的归一化 customShape
 */
export function buildTracedCustomShape(traced) {
  const points = Array.isArray(traced?.points) ? traced.points : null;
  if (!points?.length) {
    return null;
  }
  const shape = normalizeCustomShape({ name: '图像描摹', points });
  if (!shape) {
    return null;
  }
  const iou = traced.diagnostics?.iou ?? null;
  const contentHash = sha256Hex(
    stableStringify({
      schema: IMAGE_TRACE_HASH_SCHEMA,
      points,
      pointCount: points.length,
      iou,
    }),
  );
  return {
    ...shape,
    // 点列来源记为图像描摹（方案 §3："点列来源记为图像描摹"）
    source: 'traced',
    contentHash,
    // 描摹元数据：目标验收（deterministic）与日志/落盘都用这一份
    trace: {
      iou,
      pointCount: points.length,
      imageWidth: traced.diagnostics?.imageWidth ?? null,
      imageHeight: traced.diagnostics?.imageHeight ?? null,
    },
  };
}

/** 图片已由系统描摹的提示括注（不把图片交给模型，也不让它猜图片内容） */
const IMAGE_TRACE_PROMPT_HINT =
  '用户上传了一张图片，系统已直接描摹图片外轮廓作为目标图形，不需要识别图片内容；请解析地点、尺寸等其余需求';

/**
 * 构造图片轮的意图解析文本：用户原文 + "图片已由系统描摹"括注；原文为空时只给括注。
 * 图片本身不再进入模型请求（buildUserMessage 第二参数固定为 null）。
 *
 * @param {string} text 用户原文
 * @returns {string} 意图解析用文本
 */
export function buildTracePromptText(text) {
  const original = typeof text === 'string' ? text.trim() : '';
  return original ? `${original}（${IMAGE_TRACE_PROMPT_HINT}）` : IMAGE_TRACE_PROMPT_HINT;
}

  /**
   * 地名展示文本（plan/recommend 两链路共用）：用户指定了地点写「地点」这一带，
   * 未指定/未解析时写"当前视野这一带"——不得把视野中心说成用户指定的地方。
   *
   * @param {object|null} center 解析后的中心（null 表示未解析/无中心）
   * @param {string|null} place 用户提到的地名
   * @returns {string} 回复里使用的地名短语
   */
export function placeTextOf(center, place) {
    return center && place ? `「${place}」这一带` : '当前视野这一带';
  }

  /**
   * 参考版/诊断版交付出口（B2：6 处交付共用同一骨架）：
   * 中止检查 → commitDraw(reference) → 生成回复 → 写历史 → 日志 → 返回统一结构。
   * 各出口只在"候选/回复文案/计划状态/日志字段"上不同，橙色非合格语义一致。
   *
   * @param {object} input
   * @param {string} input.text 用户原文（写历史用）
   * @param {AbortSignal|null} input.signal 中止信号
   * @param {object} input.candidate 交付候选（含 result/score；非合格参考版）
   * @param {() => string} input.compose 回复生成回调（候选与地点由调用方闭包带入）
   * @param {object} input.planned 计划结果（调用方按交付类型覆盖 status）
   * @param {object} input.outline 点序列预览
   * @param {object} [input.commitOptions] commitDraw 选项（缺省 {reference, score}）
   * @param {string} [input.logEvent] 交付日志事件名（缺省不记日志）；input.logPayload 为字段
   * @returns {{reply: string, planned: object, outline: object, shape: object}} 交付结果
   */

/**
 * 创建参考版/诊断版交付出口（B2 抽取；C4 从 controller 闭包搬出，依赖显式注入）。
 * 6 处交付共用同一骨架：中止检查 → commitDraw(reference) → 回复 → 写历史 → 日志 → 返回。
 *
 * @param {object} deps 依赖
 * @param {object} deps.engine 图形引擎（只用 commitDraw）
 * @param {(userText: string, assistantText: string) => void} deps.pushHistory 写对话历史
 * @param {{info: Function}} deps.log 日志器
 * @returns {Function} deliverReference（参数见函数内 JSDoc）
 */
export function createDeliverReference({ engine, pushHistory, log }) {
  /**
   * 参考版/诊断版交付出口（B2：6 处交付共用同一骨架）：
   * 中止检查 → commitDraw(reference) → 生成回复 → 写历史 → 日志 → 返回统一结构。
   * 各出口只在"候选/回复文案/计划状态/日志字段"上不同，橙色非合格语义一致。
   *
   * @param {object} input
   * @param {string} input.text 用户原文（写历史用）
   * @param {AbortSignal|null} input.signal 中止信号
   * @param {object} input.candidate 交付候选（含 result/score；非合格参考版）
   * @param {() => string} input.compose 回复生成回调（候选与地点由调用方闭包带入）
   * @param {object} input.planned 计划结果（调用方按交付类型覆盖 status）
   * @param {object} input.outline 点序列预览
   * @param {object} [input.commitOptions] commitDraw 选项（缺省 {reference, score}）
   * @param {string} [input.logEvent] 交付日志事件名（缺省不记日志）；input.logPayload 为字段
   * @returns {{reply: string, planned: object, outline: object, shape: object}} 交付结果
   */
  function deliverReference({
    text,
    signal,
    candidate,
    compose,
    planned,
    outline,
    commitOptions = null,
    logEvent = null,
    logPayload = null,
  }) {
    throwIfAborted(signal, '已停止');
    const shape = engine.commitDraw(candidate.result, commitOptions ?? { reference: true, score: candidate.score });
    const reply = compose();
    pushHistory(text, reply);
    if (logEvent) {
      log.info(logEvent, logPayload);
    }
    return { reply, planned, outline, shape };
  }

  return deliverReference;
}
