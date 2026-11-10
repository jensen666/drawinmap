/**
 * 会话入口 send + 单轮编排 handleSend（C4-5 拆分自 controller.js，最高风险路径）。
 *
 * 纯移动 + 访问器注入：引导状态（guideState）、候选追加监听、对话历史、待切换备选
 * 均通过 get/set 访问器读写；**时序/取消/引导状态机语义一行未改**。
 */

import { beginTrace, createLogger } from '../../log/index.js';
import { buildSystemPrompt } from '../prompt.js';
import { buildUserMessage, chatCompletion, beginTurnConfigSnapshot, endTurnConfigSnapshot } from '../llm.js';
import { redactSensitive } from '../llm-config.js';
import { DEFAULT_SIZE_METERS, extractExplicitSizeMeters } from '../intent.js';
import { sizeToleranceMeters } from '../../engine/constraint-contract.js';
import { describeShapeSpec } from '../shape-spec.js';
import { createGuideState, nextMissingSlot, questionFor } from '../guide.js';
import { createAbortError, isAbortError, isAborted, throwIfAborted } from '../../cancel.js';
import {
  buildTracePromptText,
  buildTracedCustomShape,
  summarizeIntent,
  summarizePlanned,
} from './deliver.js';
import { parseIntentWithRecovery } from './intent-recovery.js';
import {
  errorKindOf,
  isParseFailure,
  rethrowIfAborted,
  UNPARSABLE_REPLY,
  withErrorKind,
} from './shared.js';

/** 模块 logger：与 controller 同 label（日志归属口径不变） */
const log = createLogger('agent');

/** 图像描摹固定拒绝回复（方案 2026-11-01 §3）：抽不出单闭合外轮廓时只回这一句，
 * 不调用模型补点、不规划、不画线；照片走同一句，不另做照片分类。 */
const IMAGE_TRACE_REJECT_REPLY = '只接受线稿、剪影、白底或纯色底图标。';

/**
 * 备选切换短语识别（缺陷清单 2026-11-06 Bug 5）。
 *
 * 回复承诺"想换这一版直接说『要大一点/小一点的那版』"，系统此前没有任何解析
 * 与切换逻辑——这句话被当成全新请求重新走 LLM 解析 + 全量重规划，备选随轮次
 * 结束即丢弃。本函数整句匹配切换短语（允许前后礼貌词/标点，不允许长句里夹带，
 * 防止把引述或别的请求误判成切换指令）。
 *
 * @param {string} text 用户输入
 * @returns {'bigger'|'smaller'|null} 切换方向；非切换短语返回 null
 */
export function matchAlternativeSwitchPhrase(text) {
  const normalized = String(text ?? '')
    .trim()
    .replace(/^[，,。！!？?\s]+/, '')
    .replace(/[，,。！!？?\s]+$/, '');
  const match = normalized.match(
    /^(?:请|给我|帮我|麻烦)?(?:换|要|来)(?:那个|一下)?(大|小)一点的那(?:一)?版(?:就?行|就好|吧|可以吗|谢谢)?$/,
  );
  if (!match) {
    return null;
  }
  return match[1] === '大' ? 'bigger' : 'smaller';
}


/** 推荐链路内置图形遍历顺序（executeRecommend 的 shapeSizes 与近场代表候选都按此顺序） */

/**
 * 创建会话入口运行时（C4-5）。
 *
 * @param {object} deps 依赖
 * @param {(userText: string, assistantText: string) => void} deps.pushHistory 写对话历史
 * @param {() => Array<object>} deps.getHistory 取对话历史
 * @param {() => object|null} deps.getGuideState 取引导状态
 * @param {(value: object|null) => void} deps.setGuideState 写引导状态
 * @param {() => object|null} deps.getPendingAlternative 取待切换备选
 * @param {(listener: Function|null) => void} deps.setReferenceCandidateListener 写候选追加监听
 * @param {() => object|null} deps.currentScalePoolView 取多比例尺池视图
 * @param {object} deps.placeConfig 城市地点配置
 * @param {Function} deps.traceImage 图片描摹实现
 * @param {object} deps.replyTemplates 回复模板集合（exampleHint）
 * @param {object} deps.runtime 编排 runtime
 *   { deliverAlternativeSwitch, discardPendingAlternative, discardScaleCandidates,
 *     discardReferenceChoice, continueGuide, executeIntent }
 * @returns {{send: Function}} 会话入口
 */
export function createSendRuntime({
  pushHistory,
  getHistory,
  getGuideState,
  setGuideState,
  getPendingAlternative,
  setReferenceCandidateListener,
  currentScalePoolView,
  placeConfig,
  traceImage,
  replyTemplates,
  runtime,
}) {
  const { exampleHint } = replyTemplates;
  const {
    deliverAlternativeSwitch,
    discardPendingAlternative,
    discardScaleCandidates,
    discardReferenceChoice,
    continueGuide,
    executeIntent,
  } = runtime;

  /**
   * 处理一轮用户输入（入口）：开启 trace 后交给 handleSend。
   *
   * 一轮对话 = 一条 trace：用户输入 → 意图解析（LLM 请求/响应/推理内容）→ 引导
   * → 地点解析 → 引擎规划 → 回复，全部记录挂同一 traceId，按时间线即可定位问题。
   *
   * @param {object} input
   * @param {string} input.text 用户文本
   * @param {string|null} [input.imageDataUrl] 图片 data URL
   * @param {(step: {text: string, kind: 'step'|'progress'}) => void} [onProgress]
   *   推理过程回调：kind='step' 为新里程碑（理解需求/地点/尺寸/选定…），
   *   kind='progress' 为进行中进度（搜索 done/total，同一条上原地更新）
   * @param {object} [options]
   * @param {AbortSignal} [options.signal] 中止信号（用户点"停止"）：模型请求与图形搜索
   *   立刻中断，被停止的轮次不交付任何结果
   * @returns {Promise<{reply: string, planned: object|null, outline?: {name: string|null, source: 'reference'|'llm'|'builtin', pointCount: number, dataUrl: string|null}|null, guide?: {slot: string, options: Array<{label: string, value: string}>}, shape?: object|null, referenceChoice?: object}>}
   *   回复与规划信息；outline 为目标点序列图预览（plan/recommend 实际执行过规划才附带，
   *   dataUrl 由浏览器 canvas 渲染，Node 测试环境为 null）；guide 存在表示正在引导追问
   *   （附选项，由 UI 渲染为可点按钮）；referenceChoice 存在表示等待用户点击候选卡
   *   （方案 2026-10-31 §6.1，planned/shape/outline 均为 null，引擎调用次数为 0）；
   *   shape 为本轮交付的图形快照（供会话存储）
   */
  async function send(input = {}, onProgress = () => {}, { signal = null, onReferenceCandidate = null } = {}) {
    const text = typeof input.text === 'string' ? input.text : '';
    const imageDataUrl = input.imageDataUrl || null;
    // 三路候选追加监听（方案 2026-11-01 §2：卡片随结果到达追加，不等最慢一路）：
    // 轮次结束后剩余路仍可能返回，监听保留到下一次 send/点选/切会话。
    setReferenceCandidateListener(typeof onReferenceCandidate === 'function' ? onReferenceCandidate : null);
    const trace = beginTrace('turn', {
      text,
      textLength: text.length,
      hasImage: Boolean(imageDataUrl),
      imageDataUrl,
      guideActive: Boolean(getGuideState()),
      historyCount: getHistory().length,
    });
    /** 用户可见的推理步骤同步写入 trace（与对话面板"推理过程"一致） */
    const tracedProgress = (step) => {
      if (step && step.kind === 'step' && step.text) {
        trace.step(step.text);
      }
      onProgress(step);
    };
    // 配置轮次快照（方案 2026-11-09 §4）：本轮所有 LLM 调用固定用同一份生效配置，
    // 用户中途保存的新配置只从下一轮生效，不打断、不改变当前轮（R4）。
    // 快照失败（如存储不可读）不阻断本轮：chatCompletion 会按"未配置/读取异常"留痕。
    try {
      const snapshot = await beginTurnConfigSnapshot();
      trace.info('llm.config.turn.snapshot', {
        source: snapshot?.source ?? 'none',
        hasConfig: Boolean(snapshot?.config),
        // 端点可能带查询参数（极端情况把密钥塞在 URL 里）：与 llm.js 同一套脱敏，R8
        baseUrl: snapshot?.config?.baseUrl
          ? redactSensitive(snapshot.config.baseUrl, snapshot.config.apiKey)
          : null,
        model: snapshot?.config?.model ?? null,
      });
    } catch (error) {
      log.error('llm.config.turn.snapshot.failed', {}, error);
    }
    try {
      const result = await handleSend({ text, imageDataUrl }, tracedProgress, trace, signal);
      trace.info('agent.reply', {
        reply: result.reply,
        plannedStatus: result.planned?.status ?? null,
        planned: summarizePlanned(result.planned),
        guideSlot: result.guide?.slot ?? null,
        guideOptions: result.guide?.options?.map((option) => option.label) ?? null,
        // 点序列图（回复内展示的目标轮廓）：渲染失败（无 canvas）时 rendered=false；
        // rotationDeg 供 E2E 核对"气泡图注朝向 = plan.result.rotationDeg = 地图紫线"
        outline: result.outline
          ? {
              name: result.outline.name,
              source: result.outline.source,
              pointCount: result.outline.pointCount,
              rotationDeg: result.outline.rotationDeg ?? null,
              rendered: Boolean(result.outline.dataUrl),
            }
          : null,
      });
      trace.end({
        replyLength: typeof result.reply === 'string' ? result.reply.length : 0,
        plannedStatus: result.planned?.status ?? null,
        guide: Boolean(result.guide),
        // 待选候选轮：记录 choiceId（与规划轮经 sourceTraceId 串联，方案 §7.1）
        referenceChoice: result.referenceChoice?.choiceId ?? null,
      });
      // 本轮 traceId 交给界面：回复下方提供"复制 traceId"入口（发给编程工具按 trace 定位）
      // scalePool：多比例尺候选池视图（null = 本轮无可选池；UI 据此统一维护卡片活/静态）
      return { ...result, traceId: trace.id, scalePool: currentScalePoolView() };
    } catch (error) {
      // 停止不是失败：被停止的轮次 trace 以 info 收尾并标注 aborted（不落 error 级别）
      if (isAbortError(error) || isAborted(signal)) {
        trace.end({ aborted: true, message: error?.message ?? '已停止' });
      } else {
        trace.fail(error, { text });
      }
      // 失败轮同样保留 traceId（解析失败/超时/接口错误也能复制该轮链路给编程工具）
      if (error && typeof error === 'object') {
        try {
          error.traceId = trace.id;
        } catch {
          // 只读/冻结的错误对象忽略；复制入口降级为不显示
        }
      }
      throw error;
    } finally {
      // 轮次结束解除配置快照（幂等）：下一轮重新解析生效配置（R4 "下一轮生效"）
      endTurnConfigSnapshot();
    }
  }
  /**
   * 一轮输入的编排主体（链路已由 send 开启）。
   *
   * @param {{text: string, imageDataUrl: string|null}} input 用户输入
   * @param {(step: object) => void} onProgress 推理过程回调（已带 trace 步骤记录）
   * @param {object} trace 当前链路
   * @param {AbortSignal} [signal] 中止信号（用户点"停止"）
   * @returns {Promise<object>} 与 send 相同
   */
  async function handleSend({ text, imageDataUrl = null }, onProgress, trace, signal = null) {
    // 备选切换（缺陷清单 Bug 5）：先于引导/新输入检查——切换短语不进 LLM、
    // 不重新规划，直接提交对应备选。有图片时不适用（图片轮是描摹新目标）。
    const switchDirection = matchAlternativeSwitchPhrase(text);
    if (switchDirection && !imageDataUrl) {
      if (getPendingAlternative()) {
        return deliverAlternativeSwitch(switchDirection, text, trace, signal);
      }
      const reply =
        '这一轮没有可切换的备选版本。想调整尺寸可以直接说明（比如"画个 2 公里的心形"），我按新尺寸规划一版。';
      pushHistory(text, reply);
      log.info('deliver.alternativeSwitch.miss', { direction: switchDirection, reason: 'no-pending' });
      return { reply, planned: null, outline: null };
    }
    // 非切换输入：丢弃待切换备选（当轮已交付的绿线不受影响），再放弃旧待选
    //（方案 §6.4）：旧卡片变成静态历史，不补写无意义的 LLM 历史
    discardPendingAlternative('new-input');
    discardScaleCandidates('new-input');
    discardReferenceChoice('new-input');
    // 引导进行中且为纯文本：先进引导状态机（选项本地填充不调 LLM；自由文本才重解析合并）
    if (getGuideState() && !imageDataUrl) {
      return continueGuide(text, onProgress, trace, signal);
    }
    // 全新输入/图片：丢弃未完成的引导
    setGuideState(null);

    // 有图片：先描摹外轮廓（方案 2026-11-01 §3）——不识别图片种类、不把图交给模型估点。
    // 描摹失败 → 不调用 LLM、不规划、不画线，只回固定一句；成功 → 描摹点列直接作为 T。
    let tracedCustomShape = null;
    if (imageDataUrl) {
      onProgress({ text: '描摹图片外轮廓…', kind: 'step' });
      let traced = null;
      try {
        traced = await traceImage(imageDataUrl, { signal });
      } catch (error) {
        // 用户点"停止"：中止必须原样上抛，不能被当成描摹失败降级成固定回复
        rethrowIfAborted(error, signal);
        log.warn('agent.imageTrace.failed', { message: error?.message ?? String(error) });
      }
      throwIfAborted(signal, '已停止');
      const tracedPoints =
        traced?.status === 'ok' && Array.isArray(traced.points) && traced.points.length > 0
          ? traced.points
          : null;
      tracedCustomShape = tracedPoints
        ? buildTracedCustomShape({ points: tracedPoints, diagnostics: traced.diagnostics || {} })
        : null;
      if (!tracedCustomShape) {
        // 抽不出单闭合外轮廓（或点列无法归一化为合法闭环）：不调用模型补点、不规划、
        // 不画线。回复严格只有方案 §3 规定的一句（照片走同一句，不另做照片分类）。
        const reply = IMAGE_TRACE_REJECT_REPLY;
        pushHistory(text, reply);
        log.warn('agent.imageTrace.rejected', {
          reasons:
            traced?.reasons ?? [{ code: 'normalize-failed', message: '描摹点列无法归一化为合法闭环' }],
          diagnostics: traced?.diagnostics ?? null,
        });
        return { reply, planned: null };
      }
      onProgress({
        text: `外轮廓描摹完成：${tracedCustomShape.trace.pointCount} 点（描摹 IoU ${Number(
          tracedCustomShape.trace.iou ?? 0,
        ).toFixed(3)}）`,
        kind: 'step',
      });
      log.info('agent.imageTrace.used', {
        origin: 'image-trace',
        source: 'traced',
        name: tracedCustomShape.name,
        contentHash: tracedCustomShape.contentHash,
        pointCount: tracedCustomShape.trace.pointCount,
        iou: tracedCustomShape.trace.iou,
        imageWidth: tracedCustomShape.trace.imageWidth,
        imageHeight: tracedCustomShape.trace.imageHeight,
        background: traced?.diagnostics?.background ?? null,
      });
    }

    onProgress({ text: '理解需求…', kind: 'step' });
    const messages = [
      { role: 'system', content: buildSystemPrompt(placeConfig) },
      ...getHistory(),
      // 图片不再交给模型（方案 §3）：图片轮只传"系统已直接描摹外轮廓"的文本提示，
      // buildUserMessage 第二参数固定 null，模型不接触图片、也不猜图片内容
      buildUserMessage(tracedCustomShape ? buildTracePromptText(text) : text, null),
    ];

    let intent;
    const explicitSizeMeters = extractExplicitSizeMeters(text);
    try {
      const raw = await trace.withSpan(
        'agent.intent',
        () => chatCompletion({ messages, signal }),
        {
          text,
          hasImage: Boolean(imageDataUrl),
          imageTraced: Boolean(tracedCustomShape),
          messageCount: messages.length,
        },
      );
      // 尺寸只信用户原文的本地提取（LLM 的 sizeMeters 字段会编造，一律忽略）；
      // 点列校验失败时带原因重生成一次（不再静默换推荐）
      intent = await parseIntentWithRecovery(raw, text, { explicitSizeMeters, trace, signal, onProgress });
    } catch (error) {
      // 用户点"停止"：按"已停止"收尾，不落到失败提示，也不重试
      if (isAborted(signal) || error?.name === 'AbortError') {
        log.warn('agent.intent.aborted', { text, hasImage: Boolean(imageDataUrl) });
        throw createAbortError('已停止');
      }
      log.error('agent.intent.failed', { text, hasImage: Boolean(imageDataUrl) }, error);
      // 解析型失败（超时/模型返回无法解析/输出截断）→ 统一友好提示；
      // 网络/接口错误仍按原分支抛出（保留 kind 供上层使用）
      if (isParseFailure(error)) {
        const reply = UNPARSABLE_REPLY;
        pushHistory(text, reply);
        log.warn('agent.intent.unparsable', { kind: errorKindOf(error) });
        return { reply, planned: null };
      }
      throw withErrorKind(new Error(`智能体解析失败：${error.message}`), errorKindOf(error));
    }
    // 停止检查点：恢复链路/解析链路返回后若已被停止，不再进入闲聊/参考图/引导/规划任一分支
    throwIfAborted(signal, '已停止');
    // 图像描摹目标：强制 plan 通道，并用描摹 T 覆盖 LLM 的任何图形猜测（方案 2026-11-01 §3）。
    // LLM 只负责地点/尺寸等其余需求；reply 固定，避免模型猜测图片内容。
    if (tracedCustomShape) {
      // 图片轮 LLM 只解析地点，常返回 recommend/chat（没有图形）→ normalizeIntent 因此
      // 不给尺寸基准（sizeMeters=null）。强制 plan 后必须补默认基准：引擎用 baseSizeMeters
      // 计算尺寸阶梯与搜索网格，null 会让全部候选退化为 0 尺寸（E2E 实测：8/8 描摹图贴不出、
      // 回复出现 0.00km 假参考版）。用户原文显式尺寸仍优先（intent.sizeMeters 已含）。
      intent = {
        ...intent,
        action: 'plan',
        shapeKey: null,
        shapeSpec: null,
        shapeSpecError: null,
        planBlocked: null,
        shapeBlockedName: null,
        customShape: tracedCustomShape,
        referenceSource: null,
        // 尺寸基准优先级：LLM 解析出的（通常为 null）> 用户原文显式尺寸 > 默认基准。
        // 图片轮 LLM 只解析地点，常返回 recommend/chat（无图形）→ normalizeIntent 不给尺寸
        // 基准，必须在这里补齐，否则引擎拿到 null 会产出 0 尺寸退化候选（E2E 实测 8/8 贴不出）。
        sizeMeters: intent.sizeMeters ?? explicitSizeMeters ?? DEFAULT_SIZE_METERS,
        // 显式尺寸标记跟着尺寸基准一起走：原文里的显式尺寸必须仍然是"显式"
        // （否则描摹轮会把用户的尺寸要求当成系统自选，尺寸契约失效）
        sizeExplicit: Boolean(intent.sizeExplicit) || explicitSizeMeters !== null,
        sizeToleranceMeters:
          intent.sizeToleranceMeters ?? sizeToleranceMeters(explicitSizeMeters),
        reply: '已从这张图描出目标轮廓（实心外轮廓，中间空洞不保留）。',
      };
    }
    // 尺寸基准兜底：normalizeIntent 只在"归一化后 action 仍为 plan"时填尺寸基准；
    // 自定义点列校验失败会先被翻成 recommend、恢复成功后再翻回 plan（parseIntentWithRecovery），
    // 这条路径上 sizeMeters 会残留 null。引擎拿 null 算尺寸阶梯会得到全部 0 尺寸候选：
    // 图形投影成一个点、贴合偏差除零得 Infinity、评分恒 0，四级 1960 个候选全废——
    // trace t-0wg0g71b5eu0 实测「长颈鹿」路线贴合 0、尺寸 0.0 km、地图上没画出来。
    // 任何强制 plan 的路径都在这里补齐，口径与图片描摹分支一致：原文显式尺寸 > 默认基准。
    if (intent.action === 'plan' && !(Number.isFinite(intent.sizeMeters) && intent.sizeMeters > 0)) {
      const fallbackSizeMeters = explicitSizeMeters ?? DEFAULT_SIZE_METERS;
      log.warn('agent.sizeFallback', {
        reason: 'plan 意图缺尺寸基准（自定义点列恢复路径），按默认基准补齐',
        sizeMeters: fallbackSizeMeters,
        previousSizeMeters: intent.sizeMeters ?? null,
      });
      intent = {
        ...intent,
        sizeMeters: fallbackSizeMeters,
        // 兜底基准不等于放弃显式要求：原文里写了尺寸就仍是显式约束
        sizeExplicit: Boolean(intent.sizeExplicit) || explicitSizeMeters !== null,
        sizeToleranceMeters:
          intent.sizeToleranceMeters ?? sizeToleranceMeters(explicitSizeMeters),
      };
    }
    log.info('agent.intent', {
      ...summarizeIntent(intent),
      replyText: intent.reply,
      explicitSizeMeters,
      imageTraced: Boolean(tracedCustomShape),
    });

    if (intent.action === 'chat') {
      const reply =
        intent.reply || `我还没明白。可以说说想画什么图形、在哪里画，例如"${exampleHint()}"。`;
      pushHistory(text, reply);
      log.info('agent.chat', { reply });
      return { reply, planned: null };
    }

    // 推理过程第一步：把理解到的需求说给用户看（图形/地点/尺寸依据）
    // （参考图命中已迁移到 executeIntent 内、resolveTarget 之前——方案 2026-10-31 §3）
    if (intent.action === 'plan') {
      const shapeText = intent.customShape
        ? intent.customShape.source === 'procedural' && intent.shapeSpec
          ? `参数化「${describeShapeSpec(intent.shapeSpec)}」（${intent.customShape.outlinePoints.length} 点轮廓）`
          : intent.customShape.source === 'traced'
            ? `从图片描出的外轮廓（${intent.customShape.outlinePoints.length} 点）`
            : `自定义「${intent.customShape.name}」（${intent.customShape.outlinePoints.length} 点轮廓）`
        : `「${{ star: '五角星', heart: '心形', rect: '矩形' }[intent.shapeKey] || intent.shapeKey}」`;
      onProgress({
        text: `需求：画${shapeText} · ${intent.place ? `地点「${intent.place}」` : '地点待定'}${
          explicitSizeMeters ? ` · 尺寸 ${explicitSizeMeters}m` : ''
        }`,
        kind: 'step',
      });
    } else {
      onProgress({
        text: `需求：只给条件（${intent.place ? `地点「${intent.place}」` : '地点待定'}），实测推荐画得出的图形`,
        kind: 'step',
      });
    }

    // plan/recommend：缺地点 → 引导追问，选项补齐后再执行
    // （sourceText 留档：地点经选项定稿后，参考候选匹配仍用原始请求文本）
    const nextGuide = createGuideState(intent, { sizeLocked: explicitSizeMeters !== null, sourceText: text });
    setGuideState(nextGuide);
    const slot = nextMissingSlot(nextGuide);
    if (slot) {
      const { question, options } = questionFor(slot, placeConfig);
      const reply = intent.reply ? `${intent.reply}\n${question}` : question;
      pushHistory(text, reply);
      log.info('guide.question', {
        slot,
        question,
        options: options.map((option) => option.label),
        intent: summarizeIntent(intent),
      });
      throwIfAborted(signal, '已停止');
      return { reply, planned: null, guide: { slot, options } };
    }
    setGuideState(null);
    return executeIntent(intent, text, onProgress, trace, imageDataUrl, signal);
  }

  return { send };
}
