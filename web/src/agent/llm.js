/**
 * LLM 客户端：调用 OpenAI 兼容的 chat/completions 接口。
 *
 * 配置来源（页面配置 > 文件配置）由 agent/llm-config.js 统一解析，轮次快照保证
 * "中途保存配置只影响下一轮"；无生效配置时抛 kind='unconfigured' 的可读错误。
 *
 * 日志留痕（全部可追溯，定位"为什么这次理解错了/画歪了"）：
 * - llm.config：端点/模型/超时/预算（密钥只记"是否已配置"，不落明文）；
 * - llm.request：每次尝试的完整请求（含 system/历史/图片元信息，图片 dataURL 脱敏）；
 * - llm.response：响应正文、**reasoning_content 推理内容**、usage（含 reasoning_tokens）、
 *   finish_reason、HTTP 状态、服务端 request id、耗时；
 * - llm.truncated / llm.error / llm.retry：截断、失败原因与重试决策。
 */

import { createLogger } from '../log/index.js';
import { createAbortError, isAborted, linkSignals } from '../cancel.js';
import { redactSensitive, resolveEffectiveConfig } from './llm-config.js';

/** 模块 logger（自动归属当前对话 trace） */
const log = createLogger('agent/llm');

/** 轮次配置快照：controller.send 开始时固定本轮配置，中途保存只影响下一轮 */
let turnSnapshot = null;
/** 上一次留痕的生效配置签名（仅生效配置变化时补一条 llm.config，不含密钥） */
let lastConfigSignature = null;

/**
 * 记录一次生效配置留痕（只记"是否配置了密钥"，绝不把 apiKey 写进日志/落盘文件）。
 *
 * @param {object} config 生效配置
 * @param {string} source 配置来源（page/file/none）
 */
function logConfigOnce(config, source) {
  const signature = [source, config.baseUrl, config.model, config.timeoutMs, config.maxTokens].join('|');
  if (signature === lastConfigSignature) return;
  lastConfigSignature = signature;
  log.info('llm.config', {
    source,
    baseUrl: redactSensitive(config.baseUrl, config.apiKey),
    model: config.model,
    timeoutMs: config.timeoutMs,
    maxTokens: config.maxTokens,
    hasApiKey: Boolean(config.apiKey),
    apiKeyLength: typeof config.apiKey === 'string' ? config.apiKey.length : 0,
  });
}

/**
 * 构造"尚未配置"错误（kind=unconfigured，供 UI 渲染"去配置"引导）。
 *
 * @returns {Error} 未配置错误
 */
function createUnconfiguredError() {
  return Object.assign(new Error('尚未配置 LLM：请在「设置」中填写端点、密钥与模型'), { kind: 'unconfigured' });
}

/**
 * 解析本轮生效配置：轮次快照优先；无快照时每次请求重新解析（保存后下一轮立即生效）。
 *
 * 来源优先级（页面配置 > 文件配置 > 未配置）与 `globalThis.__AGENT_LLM_CONFIG__`
 * 测试注入口由 agent/llm-config.js 统一实现，本函数只消费解析结果。
 *
 * @returns {Promise<object>} 生效配置
 */
async function loadConfig() {
  if (turnSnapshot) {
    if (!turnSnapshot.config) throw createUnconfiguredError();
    logConfigOnce(turnSnapshot.config, turnSnapshot.source);
    return turnSnapshot.config;
  }
  const resolved = await resolveEffectiveConfig();
  if (!resolved.config) throw createUnconfiguredError();
  logConfigOnce(resolved.config, resolved.source);
  return resolved.config;
}

/**
 * 开始一轮对话的配置快照：固定本轮的端点/密钥/模型/超时/最大输出。
 *
 * 本轮内所有 chatCompletion 优先用快照；用户中途保存配置不 abort、不改快照，
 * 保证"保存只影响下一轮"；快照在轮次开始时取，未配置则固定为"未配置"。
 *
 * @returns {Promise<{source: string, config: object|null}>} 本轮快照
 */
export async function beginTurnConfigSnapshot() {
  const resolved = await resolveEffectiveConfig();
  turnSnapshot = { source: resolved.source, config: resolved.config ? { ...resolved.config } : null };
  log.info('llm.config.snapshot.begin', {
    source: resolved.source,
    model: resolved.config?.model ?? null,
    hasApiKey: Boolean(resolved.config?.apiKey),
  });
  return turnSnapshot;
}

/** 结束本轮配置快照：恢复"每次请求解析生效配置"（幂等）。 */
export function endTurnConfigSnapshot() {
  if (!turnSnapshot) return;
  turnSnapshot = null;
  log.info('llm.config.snapshot.end');
}

/** 当前是否有轮次配置快照（本轮 chatCompletion 将使用快照而非最新配置）。 */
export function isConfigSnapshotActive() {
  return Boolean(turnSnapshot);
}

/**
 * 构造用户消息（纯文本或图文混排，OpenAI vision 格式）。
 *
 * 注意（方案 2026-11-01 §3）：图片不再走视觉通道——控制器在有图片时先本地描摹
 * 外轮廓，再只用文本请求模型（本函数第二参数固定传 null），模型不接触图片、
 * 也不负责识别/猜测图片内容。图文混排格式保留以兼容旧的调用方式/测试。
 *
 * @param {string} text 用户文本
 * @param {string|null} [imageDataUrl] 图片 data URL（base64；当前编排链路不再传图）
 * @returns {object} chat 消息
 */
export function buildUserMessage(text, imageDataUrl = null) {
  if (!imageDataUrl) {
    return { role: 'user', content: text };
  }
  return {
    role: 'user',
    content: [
      { type: 'text', text: text || '请识别这张图片，判断它最接近哪个内置图形' },
      { type: 'image_url', image_url: { url: imageDataUrl } },
    ],
  };
}

/**
 * 从模型输出中容错提取 JSON 对象。
 * 依次尝试：整体解析 → 提取第一个 {...} 片段。
 *
 * @param {string} content 模型输出文本
 * @returns {object} 解析出的 JSON 对象
 */
function extractJson(content) {
  if (!content || typeof content !== 'string') {
    throw new Error('模型返回为空');
  }
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // 继续尝试片段提取
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      // 落到报错
    }
  }
  throw new Error('模型返回不是有效 JSON');
}

/**
 * 从响应消息中提取推理模型的思考内容（不同 OpenAI 兼容实现的字段名不同）。
 *
 * @param {object} message choices[0].message
 * @returns {string|null} 推理内容（部分实现不返回则为 null）
 */
function extractReasoningContent(message) {
  if (!message || typeof message !== 'object') {
    return null;
  }
  const candidates = [message.reasoning_content, message.reasoning, message.reasoningContent];
  for (const value of candidates) {
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return null;
}

/**
 * 失败原因分类（日志、重试决策与控制器友好文案共用）。
 *
 * 导出为纯函数：上层（控制器）按同一套分类选择用户可见文案，
 * 不得另造一套字符串判断。判定顺序：未配置 > HTTP 状态 > 超时 > 网络错误 >
 * 截断 > 模型返回解析失败 > 未知。
 *
 * @param {Error} error 错误
 * @param {number|null} httpStatus HTTP 状态（网络错误为 null）
 * @returns {'unconfigured'|'timeout'|'network'|'http'|'truncated'|'parse'|'unknown'} 失败类别
 */
export function classifyError(error, httpStatus) {
  if (error?.kind === 'unconfigured') {
    return 'unconfigured';
  }
  if (httpStatus !== null) {
    return 'http';
  }
  const message = error?.message || '';
  if (message.includes('超时')) {
    return 'timeout';
  }
  if (message.includes('网络错误')) {
    return 'network';
  }
  if (message.includes('截断')) {
    return 'truncated';
  }
  if (message.includes('模型返回')) {
    return 'parse';
  }
  return 'unknown';
}

/**
 * 响应元数据的挂载键（Symbol，不污染 JSON 序列化结果）。
 *
 * 方案 2026-11-08 §5.1 要求把「原始响应与修正响应的 finishReason、正文长度、
 * 推理/正文 token」在证据里贯通——日志里有，但调用方拿不到。这里把元数据
 * 以不可枚举属性挂到返回对象上，调用方用 llmMetaOf() 读取。
 */
const LLM_META = Symbol.for('drawinmap.llm.meta');

/**
 * 读取调用结果上的响应元数据（不存在时返回 null）。
 *
 * @param {*} value chatCompletion 的返回值
 * @returns {object|null}
 */
export function llmMetaOf(value) {
  return value && typeof value === 'object' ? value[LLM_META] ?? null : null;
}

/**
 * 调用 chat/completions 接口（自动重试，全程留痕）。
 *
 * 模型接口偶发空返回/非 JSON（实测约每 3~4 次一次），一次失败就把
 * "没能理解"甩给用户不可接受——空返回、HTTP 5xx、解析失败自动重试，
 * 最多 3 次尝试；非空但语义不合格（如拒绝生成）原样交上层处理。
 *
 * @param {object} options
 * @param {Array<object>} options.messages 消息列表（含 system）
 * @param {boolean} [options.jsonMode] 是否要求 JSON 输出（response_format）
 * @param {number} [options.retries] 失败后的额外尝试次数（默认 2）
 * @param {AbortSignal} [options.signal] 外部中止信号（用户点"停止"）：立刻中断请求，
 *   且不再重试（需求 R5：停止后不自动重试）
 * @param {number} [options.timeoutMs] 单次请求超时覆盖（毫秒；缺省用配置 timeoutMs）。
 *   修正阶段由调用方传入超时（当前 180 秒、retries=0），错误分类与日志
 *   （kind=timeout）仍按实际生效的这次超时记录
 * @returns {Promise<object>} 解析后的 JSON 对象
 */
export async function chatCompletion({ messages, jsonMode = true, retries = 2, signal = null, timeoutMs = null }) {
  const config = await loadConfig();
  // 单次请求超时：显式传参优先，缺省用配置值（修正请求由调用方传入更短的单次超时）
  const requestTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : config.timeoutMs;
  let lastError = null;
  // max_tokens 状态放在重试循环体外：截断后翻倍的预算必须跨尝试保持——
  // 放在循环体内会每次用配置初值重建请求体，翻倍形同虚设（实测教训）。
  let maxTokens = config.maxTokens;

  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    // 已被外部中止：不再发起请求，直接抛中止错误（停止即真正中断）
    if (isAborted(signal)) {
      throw createAbortError('已停止');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    // 外部"停止"信号与内部超时信号联动：用户点停止 → fetch 立刻中断
    const unlink = linkSignals(signal, controller);
    const body = {
      model: config.model,
      messages,
      max_tokens: maxTokens,
    };
    if (jsonMode) {
      body.response_format = { type: 'json_object' };
    }

    const startedAt = performance.now();
    log.info('llm.request', {
      model: config.model,
      // 端点若含查询参数形式的密钥也不能落明文（R8）
      baseUrl: redactSensitive(config.baseUrl, config.apiKey),
      attempt,
      maxAttempts: retries + 1,
      jsonMode,
      maxTokens: body.max_tokens,
      // 本次请求实际生效的超时（可能是调用方按阶段覆盖的值）
      timeoutMs: requestTimeoutMs,
      messageCount: messages.length,
      messages,
    });

    let content;
    let finishReason = null;
    let httpStatus = null;
    // HTTP 层失败状态：只在 !response.ok 的接口错误分支赋值；
    // 与响应成功后正文解析/截断失败区分，避免 200 被误分类成 'http'
    let errorHttpStatus = null;
    let serverRequestId = null;
    try {
      let response;
      try {
        response = await fetch(`${config.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (error) {
        const elapsedMs = performance.now() - startedAt;
        // 外部"停止"造成的中断：不是超时，也不是网络错误——按"已停止"抛出且不重试
        if (isAborted(signal)) {
          log.warn('llm.aborted', { attempt, durationMs: elapsedMs, message: error.message });
          throw createAbortError('已停止');
        }
        if (error.name === 'AbortError') {
          log.error(
            'llm.error',
            { attempt, durationMs: elapsedMs, kind: 'timeout', timeoutMs: requestTimeoutMs, message: error.message },
            error,
          );
          throw new Error(`模型请求超时（${Math.round(requestTimeoutMs / 1000)} 秒）`);
        }
        log.error('llm.error', { attempt, durationMs: elapsedMs, kind: 'network', message: error.message }, error);
        throw new Error(`模型接口网络错误：${error.message}`);
      }

      httpStatus = response.status;
      serverRequestId =
        response.headers.get('x-request-id') ||
        response.headers.get('request-id') ||
        response.headers.get('x-trace-id') ||
        null;

      if (!response.ok) {
        const detail = (await response.text()).slice(0, 200);
        const elapsedMs = performance.now() - startedAt;
        const retryable = !(response.status >= 400 && response.status < 500 && response.status !== 429);
        // 仅 HTTP 层失败标记接口状态，供外层分类为 'http'
        errorHttpStatus = response.status;
        const error = new Error(
          retryable
            ? `模型接口错误 HTTP ${response.status}（可重试）：${detail}`
            : `模型接口错误 HTTP ${response.status}：${detail}`,
        );
        log.error(
          'llm.error',
          {
            attempt,
            durationMs: elapsedMs,
            kind: 'http',
            httpStatus,
            serverRequestId,
            retryable,
            detail,
          },
          error,
        );
        throw error;
      }

      const payload = await response.json();
      finishReason = payload?.choices?.[0]?.finish_reason ?? null;
      const message = payload?.choices?.[0]?.message ?? null;
      content = message?.content;
      const reasoningContent = extractReasoningContent(message);
      const usage = payload?.usage ?? null;
      const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens;
      const elapsedMs = performance.now() - startedAt;

      // 完整响应留痕：正文 + 推理内容 + usage + finish_reason（排查"截断/空返回/理解偏移"的关键证据）
      log.info('llm.response', {
        attempt,
        durationMs: elapsedMs,
        httpStatus,
        serverRequestId,
        responseId: payload?.id ?? null,
        responseModel: payload?.model ?? null,
        finishReason,
        usage,
        reasoningTokens: reasoningTokens !== undefined ? reasoningTokens : null,
        contentLength: typeof content === 'string' ? content.length : 0,
        reasoningLength: reasoningContent ? reasoningContent.length : 0,
        content,
        reasoningContent,
      });

      // 截断检测：推理模型（deepseek 等）的思考链消耗同一 token 预算，
      // 复杂轮廓生成常在思考上耗尽配额导致正文为空或半截——下一次尝试加倍预算
      if (finishReason === 'length') {
        // 配置初值 32000；截断后只加倍一次，封顶 64000，避免重试把预算压回更小的旧上限
        maxTokens = Math.min((maxTokens || config.maxTokens) * 2, 64000);
        log.warn('llm.truncated', {
          attempt,
          finishReason,
          reasoningTokens: reasoningTokens ?? null,
          contentLength: typeof content === 'string' ? content.length : 0,
          reasoningContent,
          nextMaxTokens: maxTokens,
        });
        throw new Error(`输出被 max_tokens 截断（已加倍至 ${maxTokens} 重试）`);
      }
      // 响应体读完仍被外部"停止"：同样按已停止抛出（迟到结果不得回填）
      if (isAborted(signal)) {
        log.warn('llm.aborted', { attempt, durationMs: elapsedMs, message: '响应体读取期间被停止' });
        throw createAbortError('已停止');
      }
      const parsed = extractJson(content);
      // 响应元数据随结果返回（方案 2026-11-08 §5.1：截断/正文长度/推理 token 贯通）
      try {
        Object.defineProperty(parsed, LLM_META, {
          value: {
            attempt,
            finishReason: finishReason ?? null,
            contentLength: typeof content === 'string' ? content.length : 0,
            reasoningTokens: reasoningTokens ?? null,
            completionTokens: usage?.completion_tokens ?? null,
            promptTokens: usage?.prompt_tokens ?? null,
            reasoningLength: reasoningContent ? reasoningContent.length : 0,
            durationMs: Math.round(elapsedMs),
          },
          enumerable: false,
          configurable: true,
          writable: true,
        });
      } catch {
        // 挂载失败不影响主流程（元数据只是观测增强）
      }
      return parsed;
    } catch (error) {
      lastError = error;
      // 用户点"停止"：直接抛出，不重试（需求 R5：停止后不再自动重试）
      if (isAborted(signal)) {
        log.warn('llm.abort.retry.skipped', { attempt });
        throw createAbortError('已停止');
      }
      // 内部超时（计时器现覆盖到响应体读取阶段）：AbortError 是超时不是"停止"，
      // 归一成可重试的超时错误，交给下面的分类/重试决策（不得误报成"已停止"）
      if (error?.name === 'AbortError') {
        const timeoutError = new Error(`模型请求超时（${Math.round(requestTimeoutMs / 1000)} 秒）`);
        log.error(
          'llm.error',
          { attempt, kind: 'timeout', timeoutMs: requestTimeoutMs, message: error.message },
          timeoutError,
        );
        error = timeoutError;
      }
      // 分类区分 HTTP 层失败与响应成功后的正文失败（timeout/network/parse/truncated），
      // 最终错误对象保留 kind 与真实 httpStatus，供控制器复用同一套分类（如 timeout 走友好句）
      const kind = classifyError(error, errorHttpStatus);
      if (error && typeof error === 'object') {
        error.kind = kind;
        error.httpStatus = httpStatus;
      }
      const retryable =
        error.message.includes('超时') ||
        error.message.includes('网络错误') ||
        error.message.includes('可重试') ||
        error.message.includes('模型返回') ||
        error.message.includes('截断');
      const willRetry = retryable && attempt <= retries;
      if (kind === 'parse') {
        // 正文无法解析（如空返回/半截 JSON）：记下原始内容长度，便于判断是截断还是格式漂移
        log.error(
          'llm.error',
          {
            attempt,
            kind,
            finishReason,
            httpStatus,
            contentLength: typeof content === 'string' ? content.length : 0,
            willRetry,
          },
          error,
        );
      }
      if (!retryable || attempt > retries) {
        throw error;
      }
      // 已经在上面的分支记过的原因不重复刷屏，只补一条重试决策
      log.warn('llm.retry', { attempt, nextAttempt: attempt + 1, kind, message: error.message });
    } finally {
      // 内部超时计时器与外部停止信号的联动覆盖整个 attempt（含响应体下载/解析）：
      // 放到 finally 而不是 fetch 之后，停止在"响应头已到、正文未读完"阶段同样立即生效
      clearTimeout(timer);
      unlink();
    }
  }
  // 兜底（循环正常结束/未知路径）：最终错误同样携带分类与 HTTP 状态
  const finalError = lastError ?? new Error('模型返回为空');
  finalError.kind = finalError.kind ?? classifyError(finalError, null);
  finalError.httpStatus = finalError.httpStatus ?? null;
  throw finalError;
}
