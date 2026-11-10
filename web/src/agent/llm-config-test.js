/**
 * 远程调用（R5 + 2026-11-10 追加需求）：测试连接（POST /chat/completions）与获取模型列表（GET /models）。
 *
 * 从 llm-config.js 拆出（生产文件 ≤500 行闸门）：本模块负责请求、HTTP/网络失败分类、
 * 中文原因与建议、留痕；配置校验/脱敏等公共逻辑仍来自 llm-config.js。
 * 约束：不写对话消息、不触发意图解析或画图、必留日志；日志/错误/建议文本绝不含密钥。
 */
import { createLogger } from '../log/index.js';
import { formatFieldErrors, normalizeEndpointInput, redactSensitive, validateDraft } from './llm-config-shared.js';

/** 模块 logger（module 与 llm-config.js 保持一致：agent/llm-config） */
const log = createLogger('agent/llm-config');

/** 失败详情摘要最大长度（避免把整段服务端正文塞进日志与界面） */
const MAX_DETAIL_LENGTH = 300;

/** 从响应头读取请求 id（不同实现字段名不同，取不到返回 null，不编造）。 */
function requestIdOf(response) {
  try {
    const headers = response?.headers;
    if (!headers || typeof headers.get !== 'function') return null;
    return headers.get('x-request-id') || headers.get('request-id') || headers.get('x-trace-id') || null;
  } catch {
    return null;
  }
}

/**
 * 模型/端点不存在的错误特征：OpenAI 兼容实现的 error.code/error.type/error.message
 * 或纯文本 body 里常见写法（真实实现常在 HTTP 400 上返回 model_not_found）。
 */
const NOT_FOUND_SIGNALS = [
  'model_not_found',
  'model not found',
  'model_not_exist',
  'unknown model',
  'unknown_model',
  'invalid model',
  'invalid_model',
  'does not exist',
  'no such model',
  'no_such_model',
  'not found',
  'not_found',
  '模型不存在',
  '端点不存在',
];

/**
 * 判断失败响应文本是否在描述"模型/端点不存在"（用于 400 等状态码的语义识别）。
 *
 * @param {string} detail 已脱敏并压缩的响应摘要
 * @returns {boolean} 是否命中"不存在"特征
 */
function isMissingModelOrEndpoint(detail) {
  const text = String(detail ?? '').toLowerCase();
  return NOT_FOUND_SIGNALS.some((signal) => text.includes(signal));
}

/**
 * HTTP 状态码 + 响应摘要 → 测试连接失败分类（方案 §3.5 表格）。
 *
 * 401/403 鉴权、429 限流、5xx 服务端错误按状态码直接判定；404 恒为"不存在"；
 * 400（及其余 4xx/未知）优先看响应语义：命中模型/端点不存在特征 → not-found，
 * 无特征时才归 incompatible（避免把真实"模型不存在"误报成"接口不兼容"）。
 *
 * @param {number} status HTTP 状态码
 * @param {string} [detail] 已脱敏的响应摘要
 * @returns {'auth'|'not-found'|'rate-limit'|'server'|'incompatible'|'unknown'} 分类
 */
function classifyHttpFailure(status, detail = '') {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not-found';
  if (status === 429) return 'rate-limit';
  if (status >= 500 && status < 600) return 'server';
  if (isMissingModelOrEndpoint(detail)) return 'not-found';
  if (status === 400 || status === 405) return 'incompatible';
  return 'unknown';
}

/** 压缩失败详情为一行可读摘要（调用方已脱敏，长度有界）。 */
function summarizeDetail(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DETAIL_LENGTH);
}

/**
 * 构造测试连接失败结果（统一中文原因 + 建议，并留日志；文案不含密钥）。
 *
 * @param {'timeout'|'network'|'auth'|'not-found'|'rate-limit'|'server'|'incompatible'|'unknown'} kind 失败分类
 * @param {{httpStatus?: number|null, durationMs?: number, detail?: string, errorMessage?: string, logEvent?: string}} [context] 上下文
 * @returns {object} 失败结果
 */
function buildTestFailure(kind, { httpStatus = null, durationMs = 0, detail = '', errorMessage = '', logEvent = 'llm.config.test.failed' } = {}) {
  const suffix = detail ? `：${detail}` : '';
  const statusText = httpStatus ? `HTTP ${httpStatus}` : '';
  const suggestions = {
    timeout: '检查端点是否可达或把「单次超时」调大；超时也可能由网络抖动导致。',
    network: '浏览器直连模型接口受跨域限制：确认端点允许 CORS、网络可达，并检查地址是否写错。',
    auth: '确认密钥正确、未过期，且该密钥有目标模型的使用权限。',
    'not-found': '确认模型名存在；端点只需填到 /v1 这类前缀，不要把 /chat/completions 填进端点。',
    'rate-limit': '请求过于频繁，稍等片刻再测试。',
    server: '服务端暂时异常，稍后重试；持续出现请检查服务状态。',
    incompatible: '确认端点是 OpenAI 兼容的 /chat/completions 接口（2xx 响应应包含 choices）。',
    unknown: '请核对端点、密钥与模型名后重试。',
  };
  let message;
  if (kind === 'timeout') message = `请求超时（实际等待 ${(durationMs / 1000).toFixed(1)} 秒）`;
  else if (kind === 'network') message = `网络错误或跨域被拒${errorMessage ? `：${errorMessage}` : ''}`;
  else if (kind === 'auth') message = `鉴权失败（${statusText}）：密钥无效或无权限${suffix}`;
  else if (kind === 'not-found') message = `端点或模型不存在（${statusText}）${suffix}`;
  else if (kind === 'rate-limit') message = `触发限流（${statusText}），请稍后重试${suffix}`;
  else if (kind === 'server') message = `服务端错误（${statusText}）${suffix}`;
  else if (kind === 'incompatible') message = `接口不兼容${statusText ? `（${statusText}）` : ''}${suffix}`;
  else message = statusText ? `请求失败（${statusText}）${suffix}` : `请求失败${suffix}`;
  const suggestion = suggestions[kind] ?? suggestions.unknown;
  log.warn(logEvent, { kind, httpStatus, durationMs, message });
  return { ok: false, kind, message, suggestion, httpStatus, durationMs, detail: detail || null };
}

/**
 * 测试连接（R5）：用当前填写内容发一次真实 POST /chat/completions（不写消息、不画图、必留日志）。
 *
 * @param {object} draft 表单草稿（不要求先保存）
 * @param {{fetchImpl?: Function}} [options] fetchImpl 可注入测试桩（默认用全局 fetch）
 * @returns {Promise<object>} 成功 {ok:true, model, durationMs, httpStatus, requestId}；失败 {ok:false, kind, message, suggestion, httpStatus, durationMs, detail?, errors?}
 */
export async function testConnection(draft, { fetchImpl } = {}) {
  const validation = validateDraft(draft);
  if (!validation.ok) {
    const message = `本地校验未通过：${formatFieldErrors(validation.errors)}`;
    log.warn('llm.config.test.failed', { kind: 'validation', httpStatus: null, durationMs: 0, message });
    return {
      ok: false,
      kind: 'validation',
      message,
      suggestion: '请先修正上述字段，再测试连接（本次未发起请求）。',
      httpStatus: null,
      durationMs: 0,
      errors: validation.errors,
    };
  }
  const config = validation.normalized;
  const startedAt = performance.now();
  log.info('llm.config.test.request', {
    baseUrl: redactSensitive(config.baseUrl, config.apiKey),
    model: config.model,
    timeoutMs: config.timeoutMs,
    hasApiKey: true,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    let response;
    try {
      const url = `${config.baseUrl}/chat/completions`;
      const init = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
        // 不带 response_format：避免个别实现不支持导致误判「接口不兼容」
        body: JSON.stringify({ model: config.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 8, stream: false }),
        signal: controller.signal,
      };
      response = fetchImpl ? await fetchImpl(url, init) : await globalThis.fetch(url, init);
    } catch (error) {
      const durationMs = Math.round(performance.now() - startedAt);
      if (error?.name === 'AbortError') return buildTestFailure('timeout', { durationMs });
      const errorMessage = summarizeDetail(redactSensitive(error?.message ?? '无法连接端点', config.apiKey));
      return buildTestFailure('network', { durationMs, errorMessage });
    }
    const durationMs = Math.round(performance.now() - startedAt);
    const httpStatus = typeof response?.status === 'number' ? response.status : 0;
    const requestId = requestIdOf(response);
    if (!response?.ok) {
      let detail = '';
      try {
        detail = summarizeDetail(redactSensitive(String(await response.text()), config.apiKey));
      } catch {
        detail = '';
      }
      return buildTestFailure(classifyHttpFailure(httpStatus, detail), { httpStatus, durationMs, detail });
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      return buildTestFailure('incompatible', { httpStatus, durationMs, detail: '响应正文不是有效 JSON' });
    }
    if (!payload || !Array.isArray(payload.choices) || !payload.choices[0]) {
      return buildTestFailure('incompatible', { httpStatus, durationMs, detail: '响应缺少 choices[0]' });
    }
    const model = typeof payload.model === 'string' && payload.model ? payload.model : null;
    log.info('llm.config.test.success', { model, durationMs, httpStatus, requestId });
    return { ok: true, model, durationMs, httpStatus, requestId };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 获取可用模型列表（2026-11-10 追加需求）：先校验端点与密钥，再 GET {baseUrl}/models。
 *
 * 端点必须为 http(s) 地址；密钥必填（获取模型同样需要鉴权），校验不过不发请求。
 * 超时：草稿 timeoutMs 为合法正整数时取 min(timeoutMs, 60000)，否则默认 30000 毫秒。
 * 成功：body.data 数组中元素为 {id:string} 或字符串 → 过滤空值/非字符串、去重、排序。
 *
 * @param {object} draft 表单草稿 {baseUrl|endpoint, apiKey, timeoutMs?}
 * @param {{fetchImpl?: Function}} [options] fetchImpl 可注入测试桩（默认用全局 fetch）
 * @returns {Promise<object>} 成功 {ok:true, models:string[], count, durationMs, httpStatus}；
 *   失败 {ok:false, kind, message, suggestion, httpStatus, durationMs, detail?, errors?}
 */
export async function fetchModels(draft, { fetchImpl } = {}) {
  const input = draft && typeof draft === 'object' ? draft : {};
  const errors = {};
  const endpoint = normalizeEndpointInput(input.baseUrl !== undefined && input.baseUrl !== null ? input.baseUrl : input.endpoint);
  if (!endpoint.ok) errors.baseUrl = endpoint.error;
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  if (!apiKey) errors.apiKey = '获取模型需要先填写密钥（不能为空或全空格）';
  if (Object.keys(errors).length > 0) {
    const message = `本地校验未通过：${formatFieldErrors(errors)}`;
    log.warn('llm.config.models.failed', { kind: 'validation', httpStatus: null, durationMs: 0, message });
    return {
      ok: false,
      kind: 'validation',
      message,
      suggestion: '请先填写合法端点与密钥，再获取模型（本次未发起请求）。',
      httpStatus: null,
      durationMs: 0,
      errors,
    };
  }
  const timeoutMs = Number.isInteger(input.timeoutMs) && input.timeoutMs > 0 ? Math.min(input.timeoutMs, 60000) : 30000;
  const baseUrl = endpoint.value;
  const startedAt = performance.now();
  log.info('llm.config.models.request', { baseUrl: redactSensitive(baseUrl, apiKey), timeoutMs, hasApiKey: true });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      const init = { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` }, signal: controller.signal };
      response = fetchImpl ? await fetchImpl(`${baseUrl}/models`, init) : await globalThis.fetch(`${baseUrl}/models`, init);
    } catch (error) {
      const durationMs = Math.round(performance.now() - startedAt);
      if (error?.name === 'AbortError') return buildTestFailure('timeout', { durationMs, logEvent: 'llm.config.models.failed' });
      const errorMessage = summarizeDetail(redactSensitive(error?.message ?? '无法连接端点', apiKey));
      return buildTestFailure('network', { durationMs, errorMessage, logEvent: 'llm.config.models.failed' });
    }
    const durationMs = Math.round(performance.now() - startedAt);
    const httpStatus = typeof response?.status === 'number' ? response.status : 0;
    if (!response?.ok) {
      let detail = '';
      try {
        detail = summarizeDetail(redactSensitive(String(await response.text()), apiKey));
      } catch {
        detail = '';
      }
      return buildTestFailure(classifyHttpFailure(httpStatus, detail), { httpStatus, durationMs, detail, logEvent: 'llm.config.models.failed' });
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      return buildTestFailure('incompatible', { httpStatus, durationMs, detail: '响应正文不是有效 JSON', logEvent: 'llm.config.models.failed' });
    }
    if (!payload || !Array.isArray(payload.data)) {
      return buildTestFailure('incompatible', { httpStatus, durationMs, detail: '响应缺少 data 数组', logEvent: 'llm.config.models.failed' });
    }
    const seen = new Set();
    const models = [];
    for (const item of payload.data) {
      let id = '';
      if (typeof item === 'string') id = item.trim();
      else if (item && typeof item.id === 'string') id = item.id.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      models.push(id);
    }
    models.sort((a, b) => a.localeCompare(b));
    log.info('llm.config.models.success', { count: models.length, durationMs, httpStatus });
    return { ok: true, models, count: models.length, durationMs, httpStatus };
  } finally {
    clearTimeout(timer);
  }
}
