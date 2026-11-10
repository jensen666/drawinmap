/**
 * LLM 配置的纯校验/归一/脱敏共享层（从 llm-config.js 拆出）。
 *
 * 拆分原因：llm-config.js 需要 re-export 远程调用入口（testConnection / fetchModels，
 * 实现在 llm-config-test.js，为控制单文件行数），而 llm-config-test.js 又需要复用
 * 端点归一化/草稿校验/脱敏——形成 llm-config.js -> llm-config-test.js -> llm-config.js
 * 的循环。把纯函数下沉到本文件后，`module-graph` 闸门恢复 0 循环，对外 API 不变
 *（llm-config.js 继续 re-export 这些函数与常量）。
 *
 * 本文件只放纯函数/常量：不接触 localStorage、不写日志、不发起网络请求。
 */

/** 超时与最大输出的默认值（需求 §4.2 表内默认；端点/密钥/模型无内置默认） */
export const LLM_CONFIG_DEFAULTS = Object.freeze({ timeoutMs: 180000, maxTokens: 32000 });

/** 超时与最大输出的合法区间（均为整数） */
export const LLM_CONFIG_LIMITS = Object.freeze({
  timeoutMs: Object.freeze({ min: 1000, max: 600000 }),
  maxTokens: Object.freeze({ min: 256, max: 64000 }),
});

/** 字段中文名（错误/提示文案统一从一处取） */
export const FIELD_LABELS = Object.freeze({ baseUrl: '端点', apiKey: '密钥', model: '模型', timeoutMs: '单次超时', maxTokens: '最大输出' });
/** 端点误带接口路径后缀的纠正规则（含再带结尾 / 的情况） */
const ENDPOINT_SUFFIX = /\/chat\/completions$/i;

/**
 * 敏感文本脱敏：把密钥明文（及其 URL 编码形式）替换为 ***。
 *
 * @param {unknown} text 原始文本
 * @param {string} [apiKey] 当前密钥（为空则原样返回）
 * @returns {string} 脱敏后的文本
 */
export function redactSensitive(text, apiKey) {
  let output = typeof text === 'string' ? text : String(text ?? '');
  if (typeof apiKey !== 'string' || apiKey.length === 0) return output;
  const variants = new Set([apiKey]);
  try {
    variants.add(encodeURIComponent(apiKey));
  } catch {
    // 密钥含无法编码字符：只按原样替换
  }
  for (const variant of variants) {
    if (variant) output = output.split(variant).join('***');
  }
  return output;
}

/**
 * 整数归一化与校验（超时/最大输出共用；接受数字或纯整数字符串，非法值不静默丢弃）。
 *
 * @param {unknown} raw 原始输入
 * @param {{label: string, min: number, max: number, unit?: string}} rule 校验规则
 * @returns {{value: number|null, error: string|null}} 归一值或中文错误
 */
function normalizeInteger(raw, { label, min, max, unit = '' }) {
  if (raw === undefined || raw === null) return { value: null, error: `${label}不能为空` };
  let value;
  if (typeof raw === 'number') {
    value = raw;
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return { value: null, error: `${label}不能为空` };
    if (!/^[+-]?\d+$/.test(trimmed)) return { value: null, error: `${label}必须是整数（不能是小数或非数字）` };
    value = Number(trimmed);
  } else {
    return { value: null, error: `${label}必须是整数` };
  }
  if (!Number.isInteger(value)) return { value: null, error: `${label}必须是整数（不能是小数）` };
  if (value < min || value > max) return { value: null, error: `${label}需在 ${min}~${max}${unit} 之间（当前 ${value}）` };
  return { value, error: null };
}

/**
 * 端点归一化：去首尾空格、协议小写、去尾部多余 /、纠正误带的 /chat/completions 后缀。
 *
 * 用 URL 解析校验合法性，但返回值保留用户子路径/端口/查询参数（只做上述清理），
 * 不重排查询参数、不破坏特殊字符。
 *
 * @param {unknown} raw 原始端点
 * @returns {{ok: boolean, value: string|null, correction: string|null, error: string|null}} 归一结果
 */
export function normalizeEndpointInput(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, value: null, correction: null, error: '端点不能为空' };
  }
  const trimmed = raw.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return { ok: false, value: null, correction: null, error: '端点必须以 http:// 或 https:// 开头' };
  }
  const corrections = [];
  const queryIndex = trimmed.indexOf('?');
  let head = queryIndex >= 0 ? trimmed.slice(0, queryIndex) : trimmed;
  const tail = queryIndex >= 0 ? trimmed.slice(queryIndex) : '';
  const withoutTrailing = head.replace(/\/+$/, '');
  if (withoutTrailing !== head) corrections.push('已自动去除端点末尾多余的 /');
  head = withoutTrailing;
  if (ENDPOINT_SUFFIX.test(head)) {
    head = head.replace(ENDPOINT_SUFFIX, '').replace(/\/+$/, '');
    corrections.push('已自动去除端点末尾的 /chat/completions（请求时会自动拼接）');
  }
  const value = head.replace(/^(https?):\/\//i, (_match, protocol) => `${protocol.toLowerCase()}://`) + tail;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, value: null, correction: null, error: '端点格式无法解析，请检查是否为合法 URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, value: null, correction: null, error: '端点必须以 http:// 或 https:// 开头' };
  }
  if (!parsed.hostname) return { ok: false, value: null, correction: null, error: '端点缺少主机名' };
  if (parsed.username || parsed.password) {
    return { ok: false, value: null, correction: null, error: '端点不能包含用户名/密码' };
  }
  return { ok: true, value, correction: corrections.length > 0 ? corrections.join('；') : null, error: null };
}

/**
 * 草稿校验（R2）：五个字段全部校验，非法值逐个报错、不静默丢弃。
 *
 * @param {object} draft 表单草稿 { baseUrl|endpoint, apiKey, model, timeoutMs, maxTokens }
 * @returns {{ok: boolean, errors: object, normalized: object, corrections: string[]}} 校验结果
 */
export function validateDraft(draft) {
  const input = draft && typeof draft === 'object' ? draft : {};
  const errors = {};
  const corrections = [];
  const rawEndpoint = input.baseUrl !== undefined && input.baseUrl !== null ? input.baseUrl : input.endpoint;
  const endpoint = normalizeEndpointInput(rawEndpoint);
  if (!endpoint.ok) errors.baseUrl = endpoint.error;
  else if (endpoint.correction) corrections.push(endpoint.correction);
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  if (!apiKey) errors.apiKey = '密钥不能为空或全空格';
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  if (!model) errors.model = '模型不能为空或全空格';
  const timeout = normalizeInteger(input.timeoutMs, { label: FIELD_LABELS.timeoutMs, ...LLM_CONFIG_LIMITS.timeoutMs, unit: ' 毫秒' });
  if (timeout.error) errors.timeoutMs = timeout.error;
  const maxTokens = normalizeInteger(input.maxTokens, { label: FIELD_LABELS.maxTokens, ...LLM_CONFIG_LIMITS.maxTokens });
  if (maxTokens.error) errors.maxTokens = maxTokens.error;
  const normalized = {
    baseUrl: endpoint.ok ? endpoint.value : null,
    apiKey: apiKey || null,
    model: model || null,
    timeoutMs: timeout.value,
    maxTokens: maxTokens.value,
  };
  return { ok: Object.keys(errors).length === 0, errors, normalized, corrections };
}

/**
 * 把字段错误拼成一行中文（测试连接/保存失败提示用；llm-config-test.js 也复用）。
 *
 * @param {object} errors 字段错误表
 * @returns {string} 中文摘要
 */
export function formatFieldErrors(errors) {
  return Object.keys(errors)
    .map((field) => `${FIELD_LABELS[field] ?? field}：${errors[field]}`)
    .join('；');
}
