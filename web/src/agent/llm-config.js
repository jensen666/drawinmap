/**
 * LLM 配置核心模块（方案 2026-11-09 §3）：配置的唯一读写/校验/归一化/生效解析/测试连接入口。
 *
 * 来源与优先级：页面配置 `localStorage['drawinmap.llm-config.v1']` > 文件配置
 * （`globalThis.__AGENT_LLM_CONFIG__` 注入或 `./agent-config.js` 动态 import）> 未配置。
 * 页面配置损坏/存储不可用只回落文件配置，不抛异常进启动链路。
 * 安全：密钥只存浏览器 localStorage 与内存；日志只记 hasApiKey，对外文本一律 redactSensitive，
 * 连端点 URL 查询参数里的密钥也脱敏；不记录 Authorization。
 */
import { createLogger } from '../log/index.js';

import {
  FIELD_LABELS,
  LLM_CONFIG_DEFAULTS,
  LLM_CONFIG_LIMITS,
  formatFieldErrors,
  normalizeEndpointInput,
  redactSensitive,
  validateDraft,
} from './llm-config-shared.js';

/** 本模块自身的公开 API 包含 shared 层（保持既有调用方/测试从 llm-config.js 导入） */
export {
  LLM_CONFIG_DEFAULTS,
  LLM_CONFIG_LIMITS,
  formatFieldErrors,
  normalizeEndpointInput,
  redactSensitive,
  validateDraft,
} from './llm-config-shared.js';

/** 模块 logger（日志不得含密钥明文） */
const log = createLogger('agent/llm-config');

/** 页面配置存储键（结构变更时递增 version，而不是换键） */
export const LLM_CONFIG_STORAGE_KEY = 'drawinmap.llm-config.v1';

/** 页面配置结构版本 */
export const LLM_CONFIG_VERSION = 1;

/** 动态 import 的 agent-config.js 缓存（注入口不缓存，便于测试与"保存后立即生效"） */
let fileConfigCache = null;
/** 文件配置是否已尝试加载（缺失同样缓存，避免每次请求重复 import） */
let fileConfigLoaded = false;
/** 最近一次文件配置状态（save/clear 计算回落来源用） */
let fileConfigState = { status: 'missing', config: null, message: null };
/** 配置变更订阅者 */
const listeners = new Set();
/** 损坏配置通知去重签名（每次解析都读配置，避免同一条损坏反复刷日志/通知） */
let lastCorruptSignature = null;

/** 解析可用的 localStorage（允许测试注入假存储），不可用返回 null。 */
function resolveStorage(storage) {
  if (storage && typeof storage.getItem === 'function') return storage;
  const candidate = globalThis.localStorage;
  if (candidate && typeof candidate.getItem === 'function' && typeof candidate.setItem === 'function') return candidate;
  return null;
}

/** 存储异常分类：配额满 / 被禁止 / 其它。 */
function storageErrorCode(error) {
  const name = error?.name || '';
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED' || error?.code === 22 || error?.code === 1014) {
    return 'quota-exceeded';
  }
  if (name === 'SecurityError' || name === 'NotAllowedError') return 'storage-unavailable';
  return 'storage-error';
}

/** 通知配置变更订阅者（订阅者异常不影响配置读写主流程）。 */
function notify(event) {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch {
      // 订阅者异常不能阻断保存/恢复
    }
  }
}

/**
 * 订阅配置变更（保存/恢复成功、检测到损坏忽略时触发）。
 *
 * @param {(event: object) => void} listener 回调
 * @returns {() => void} 取消订阅函数
 */
export function subscribeConfigChange(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 已有配置（文件/页面）的数值字段归一：只要求正整数，不套表单范围。
 *
 * 表单范围（1000~600000 / 256~64000）是"用户输入校验"规则；文件配置历史上由人工维护、
 * 单测也会临时注入极小超时（如 30ms 验证超时分支），这里必须保留旧语义（R9 兼容）。
 *
 * @param {unknown} raw 原始值
 * @param {string} label 字段中文名
 * @returns {{value: number|null, error: string|null}} 归一值或中文错误
 */
function normalizePositiveInteger(raw, label) {
  let value = raw;
  if (typeof value === 'string' && /^[+-]?\d+$/.test(value.trim())) value = Number(value.trim());
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return { value: null, error: `${label}必须是正整数` };
  }
  return { value, error: null };
}

/**
 * 已有配置对象（文件/页面存储）的字段归一与严格校验。
 *
 * @param {object} raw 原始配置对象
 * @param {{useDefaults?: boolean}} [options] useDefaults：缺省超时/最大输出是否用默认值
 * @returns {{errors: string[], config: object|null}} 错误列表与归一配置
 */
function normalizeConfigFields(raw, { useDefaults = false } = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const errors = [];
  const endpoint = normalizeEndpointInput(source.baseUrl);
  if (!endpoint.ok) errors.push(`端点：${endpoint.error}`);
  const apiKey = typeof source.apiKey === 'string' ? source.apiKey.trim() : '';
  if (!apiKey) errors.push('密钥不能为空');
  const model = typeof source.model === 'string' ? source.model.trim() : '';
  if (!model) errors.push('模型不能为空');
  const timeout = normalizePositiveInteger(source.timeoutMs ?? (useDefaults ? LLM_CONFIG_DEFAULTS.timeoutMs : undefined), FIELD_LABELS.timeoutMs);
  if (timeout.error) errors.push(`单次超时：${timeout.error}`);
  const maxTokens = normalizePositiveInteger(source.maxTokens ?? (useDefaults ? LLM_CONFIG_DEFAULTS.maxTokens : undefined), FIELD_LABELS.maxTokens);
  if (maxTokens.error) errors.push(`最大输出：${maxTokens.error}`);
  const config =
    errors.length === 0
      ? { baseUrl: endpoint.value, apiKey, model, timeoutMs: timeout.value, maxTokens: maxTokens.value }
      : null;
  return { errors, config };
}

/**
 * 读取页面配置（每次重新读 localStorage，保证保存后下一轮立即生效）。
 *
 * 损坏（非法 JSON / 版本不符 / 字段不合法）→ status='corrupt'，不删除原始值（下次保存覆盖）。
 *
 * @param {{storage?: object}} [options] storage 可注入假存储（单测用）
 * @returns {{status: 'none'|'ok'|'corrupt', config: object|null, message: string|null, reason: string|null}} 读取结果
 */
export function readPageConfig({ storage } = {}) {
  const store = resolveStorage(storage);
  const pageCorrupt = (detail) => ({
    status: 'corrupt',
    config: null,
    message: `页面配置已损坏，已忽略（可重新保存）：${detail}`,
    reason: 'invalid',
  });
  if (!store) {
    return { status: 'corrupt', config: null, message: '浏览器本地存储不可用，页面配置已忽略', reason: 'storage-unavailable' };
  }
  let raw;
  try {
    raw = store.getItem(LLM_CONFIG_STORAGE_KEY);
  } catch {
    return pageCorrupt('读取本地存储失败');
  }
  if (raw === null || raw === undefined || raw === '') return { status: 'none', config: null, message: null, reason: null };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return pageCorrupt('不是有效 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return pageCorrupt('结构不是对象');
  if (parsed.version !== LLM_CONFIG_VERSION) return pageCorrupt(`版本不兼容（version=${JSON.stringify(parsed.version)}）`);
  const { errors, config } = normalizeConfigFields(parsed, { useDefaults: false });
  if (errors.length > 0) return pageCorrupt(errors.join('；'));
  return { status: 'ok', config, message: null, reason: null };
}

/**
 * 校验文件配置对象（注入口对象若无需修正则保留原引用，兼容既有测试直接改 timeoutMs）。
 *
 * @param {object} raw 文件配置对象
 * @returns {{status: 'ok'|'corrupt', config: object|null, message: string|null}} 校验结果
 */
function validateFileConfig(raw) {
  if (!raw || typeof raw !== 'object') {
    return { status: 'corrupt', config: null, message: '文件配置为空或格式不正确，已忽略' };
  }
  const { errors, config } = normalizeConfigFields(raw, { useDefaults: true });
  if (errors.length > 0) return { status: 'corrupt', config: null, message: `文件配置已损坏，已忽略：${errors.join('；')}` };
  const sameReference =
    raw.baseUrl === config.baseUrl &&
    raw.apiKey === config.apiKey &&
    raw.model === config.model &&
    raw.timeoutMs === config.timeoutMs &&
    raw.maxTokens === config.maxTokens;
  return { status: 'ok', config: sameReference ? raw : config, message: null };
}

/**
 * 加载文件配置（R3）：`globalThis.__AGENT_LLM_CONFIG__` 注入口优先，否则动态 import agent-config.js。
 *
 * 注入口只用于单测/测试 runner：属性存在即视为"已接管文件配置"（值为空表示模拟缺文件），
 * 不写入缓存，便于同一进程内多组用例切换；真实文件 import 结果做模块级缓存。
 *
 * @returns {Promise<{status: 'ok'|'missing'|'corrupt', config: object|null, message: string|null}>} 文件配置状态
 */
export async function loadFileConfig() {
  if ('__AGENT_LLM_CONFIG__' in globalThis) {
    const injected = globalThis.__AGENT_LLM_CONFIG__;
    fileConfigState = injected ? validateFileConfig(injected) : { status: 'missing', config: null, message: null };
    return fileConfigState;
  }
  if (fileConfigLoaded) return fileConfigCache;
  fileConfigLoaded = true;
  try {
    const module = await import('./agent-config.js');
    fileConfigCache = validateFileConfig(module?.AGENT_LLM);
  } catch {
    // 干净克隆/浏览器里没有 agent-config.js：属于"未配置"，不是异常
    fileConfigCache = { status: 'missing', config: null, message: null };
  }
  fileConfigState = fileConfigCache;
  return fileConfigCache;
}

/** 检测损坏配置并按"每个损坏状态只通知一次"留痕（页面配置每次重新读，需要去重）。 */
function trackCorruptState(page, file) {
  const parts = [];
  if (page.status === 'corrupt') parts.push(`page:${page.message}`);
  if (file.status === 'corrupt') parts.push(`file:${file.message}`);
  const signature = parts.length > 0 ? parts.join('|') : null;
  if (signature === lastCorruptSignature) return;
  lastCorruptSignature = signature;
  if (signature === null) return;
  const effectiveSource = file.status === 'ok' ? 'file' : 'none';
  if (page.status === 'corrupt') {
    log.warn('llm.config.corrupt', { scope: 'page', message: page.message });
    notify({ action: 'corrupt', scope: 'page', source: effectiveSource, config: null, message: page.message });
  }
  if (file.status === 'corrupt') {
    log.warn('llm.config.corrupt', { scope: 'file', message: file.message });
    notify({ action: 'corrupt', scope: 'file', source: 'none', config: null, message: file.message });
  }
}

/**
 * 解析生效配置（R3）：页面配置 > 文件配置 > 未配置；同时带 page/file 各自状态供界面显示。
 *
 * @param {{storage?: object}} [options] storage 可注入假存储（单测用）
 * @returns {Promise<{source: 'page'|'file'|'none', config: object|null, page: object, file: object}>} 生效配置
 */
export async function resolveEffectiveConfig({ storage } = {}) {
  const page = readPageConfig({ storage });
  const file = await loadFileConfig();
  trackCorruptState(page, file);
  if (page.status === 'ok') return { source: 'page', config: page.config, page, file };
  if (file.status === 'ok') return { source: 'file', config: file.config, page, file };
  return { source: 'none', config: null, page, file };
}

/**
 * 来源中文名（设置界面来源徽标与日志复用）。
 *
 * @param {'page'|'file'|'none'|null|undefined} source 来源
 * @returns {string} 中文来源名
 */
export function sourceLabel(source) {
  if (source === 'page') return '页面配置';
  if (source === 'file') return '文件配置';
  return '未配置';
}

/**
 * 保存页面配置（R4）：先校验（不通过不写），写 localStorage 时明确区分配额满/存储被禁/其它异常。
 *
 * @param {object} draft 表单草稿
 * @param {{storage?: object}} [options] storage 可注入假存储（单测用）
 * @returns {{ok: true, source: string, config: object, corrections: string[], previousSource: string}|{ok: false, code: string, message: string, errors?: object}} 保存结果
 */
export function savePageConfig(draft, { storage } = {}) {
  const validation = validateDraft(draft);
  if (!validation.ok) {
    const message = `配置校验未通过：${formatFieldErrors(validation.errors)}`;
    log.warn('llm.config.save.rejected', { code: 'validation', fields: Object.keys(validation.errors), message });
    return { ok: false, code: 'validation', message, errors: validation.errors };
  }
  const store = resolveStorage(storage);
  if (!store) {
    const message = '浏览器本地存储不可用（可能处于隐私模式），配置未保存';
    log.warn('llm.config.storage.failed', { action: 'save', code: 'storage-unavailable', message });
    return { ok: false, code: 'storage-unavailable', message };
  }
  const previousPage = readPageConfig({ storage: store });
  const previousSource = previousPage.status === 'ok' ? 'page' : fileConfigState.status === 'ok' ? 'file' : 'none';
  const config = validation.normalized;
  const payload = { version: LLM_CONFIG_VERSION, ...config, savedAt: Date.now() };
  try {
    store.setItem(LLM_CONFIG_STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    const code = storageErrorCode(error);
    const detail = redactSensitive(error?.message ?? '未知异常', config.apiKey);
    const message =
      code === 'quota-exceeded'
        ? '浏览器本地存储空间已满，配置未保存（可清理站点数据后重试）'
        : code === 'storage-unavailable'
          ? '浏览器禁止了本地存储（隐私模式或站点设置），配置未保存'
          : `保存配置失败：${detail}`;
    log.warn('llm.config.storage.failed', { action: 'save', code, message });
    return { ok: false, code, message };
  }
  const endpointCorrected = validation.corrections.length > 0;
  log.info('llm.config.saved', {
    action: 'save',
    source: 'page',
    previousSource,
    baseUrl: redactSensitive(config.baseUrl, config.apiKey),
    model: config.model,
    timeoutMs: config.timeoutMs,
    maxTokens: config.maxTokens,
    endpointCorrected,
  });
  notify({ action: 'save', source: 'page', config, corrections: validation.corrections, previousSource });
  return { ok: true, source: 'page', config, corrections: validation.corrections, previousSource };
}

/**
 * 恢复默认（R6）：删除页面配置，回落文件配置/未配置（不修改代码文件）。
 *
 * @param {{storage?: object}} [options] storage 可注入假存储（单测用）
 * @returns {{ok: true, source: string, config: object|null, previousSource: string}|{ok: false, code: string, message: string}} 恢复结果
 */
export function clearPageConfig({ storage } = {}) {
  const store = resolveStorage(storage);
  if (!store) {
    return { ok: false, code: 'storage-unavailable', message: '浏览器本地存储不可用（可能处于隐私模式），无法清除页面配置' };
  }
  const previousPage = readPageConfig({ storage: store });
  try {
    store.removeItem(LLM_CONFIG_STORAGE_KEY);
  } catch (error) {
    const code = storageErrorCode(error);
    const message = `清除页面配置失败：${redactSensitive(error?.message ?? '未知异常', previousPage.config?.apiKey)}`;
    log.warn('llm.config.storage.failed', { action: 'clear', code, message });
    return { ok: false, code, message };
  }
  const source = fileConfigState.status === 'ok' ? 'file' : 'none';
  const config = fileConfigState.status === 'ok' ? fileConfigState.config : null;
  const previousSource = previousPage.status === 'ok' ? 'page' : source;
  log.info('llm.config.restored', {
    action: 'restore',
    source,
    previousSource,
    previousModel: previousPage.status === 'ok' ? previousPage.config.model : null,
  });
  notify({ action: 'restore', source, config });
  return { ok: true, source, config, previousSource };
}

/**
 * 远程调用对外入口（测试连接 / 获取模型）：实现拆到 llm-config-test.js（生产文件 ≤500 行闸门）。
 * 这里 re-export 保持契约：调用方仍从 llm-config.js 导入 testConnection / fetchModels。
 */
export { fetchModels, testConnection } from './llm-config-test.js';
