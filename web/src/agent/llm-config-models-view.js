/**
 * 「获取模型」子视图（追加需求 2026-11-10）：从当前端点真实拉取可用模型列表，选择后填入模型字段。
 *
 * 职责：`#llm-models-fetch` / `#llm-models-select` / `#llm-models-result` 三段 DOM 的交互。
 * 网络请求经注入的 configApi.fetchModels(draft) 完成（契约见任务 T5）；本模块：
 * - 只更新表单与结果区，不写对话消息、不触发画图、不保存配置；
 * - 本地预检：端点非法 → 端点字段标红；密钥为空/全空格 → 密钥字段标红（用户 2026-11-10 明确
 *   「获取模型也要先配置 key」），预检不通过不发请求；
 * - 失败文案复用 llm-config-texts.js 的 kind→中文映射；日志不含密钥（只记 count/kind/耗时）。
 *
 * 与设置面板的分工：本模块不管理设置视图开关与来源徽标，只做「获取/选择模型」这一段；
 * 面板在打开设置/保存/恢复成功时调用 reset() 清空上一次列表状态。
 */

import { createLogger } from '../log/index.js';
import { formatFailureText } from './llm-config-texts.js';

/** 模块 logger：只记数量/类别/耗时，不记录密钥明文 */
const log = createLogger('agent/llm-config-models');

/** 获取中/空闲时的按钮文案 */
const FETCH_TEXT = '获取模型';
const FETCHING_TEXT = '获取中…';

/** 结果区文案模板（E2E 会断言） */
const successText = (count) => `已获取 ${count} 个模型，选择后自动填入模型`;
const selectedText = (model) => `已选择模型 ${model}（保存后生效）`;
const EMPTY_TEXT = '端点返回了 0 个模型';
const KEY_REQUIRED_TEXT = '获取模型需要先填写密钥';

/**
 * 创建「获取模型」子视图控制器。
 *
 * @param {object} options
 * @param {Document} [options.document] 文档对象（单测注入 fake document）
 * @param {object} options.configApi 配置核心模块（需提供 fetchModels；可选 normalizeEndpointInput）
 * @param {() => object} options.getDraft 读取当前表单草稿（返回 {baseUrl,apiKey,...}）
 * @param {(errors: Record<string,string>) => void} [options.showFieldErrors] 渲染字段错误（复用面板实现）
 * @returns {{reset: Function, dispose: Function, isFetching: Function}} 控制器
 */
export function createModelsView({ document: doc = globalThis.document, configApi, getDraft, showFieldErrors = () => {} } = {}) {
  if (!doc) throw new Error('createModelsView 需要 document（Node 单测可注入 fake document）');
  if (!configApi || typeof configApi !== 'object') throw new Error('createModelsView 需要 configApi 配置核心模块');
  if (typeof getDraft !== 'function') throw new Error('createModelsView 需要 getDraft 读取表单草稿');

  /** 取必需 DOM；缺失直接报错（index.html 骨架与模块版本不一致时尽早暴露） */
  function byId(id) {
    const el = doc.getElementById(id);
    if (!el) throw new Error(`「获取模型」缺少 DOM：#${id}（请检查 web/index.html）`);
    return el;
  }
  const els = {
    fetch: byId('llm-models-fetch'),
    select: byId('llm-models-select'),
    result: byId('llm-models-result'),
    modelInput: byId('llm-model'),
    endpointInput: doc.getElementById('llm-endpoint'),
  };

  let fetching = false; // 请求进行中（防重复点击、按钮禁用）
  let requestSeq = 0; // 请求序号：reset/重新获取后丢弃迟到的旧结果

  /** 结果区：成功/失败/进行中文案；空文本即收起 */
  function setResult(text, kind = 'info') {
    els.result.textContent = text || '';
    els.result.hidden = !text;
    els.result.className = text ? `llm-models-result is-${kind}` : 'llm-models-result';
  }

  /** 用模型列表填充下拉：首项为占位「选择模型（共 N 个）」，value 留空表示未选择 */
  function fillSelect(models) {
    els.select.replaceChildren();
    const placeholder = doc.createElement('option');
    placeholder.value = '';
    placeholder.textContent = `选择模型（共 ${models.length} 个）`;
    els.select.appendChild(placeholder);
    for (const model of models) {
      const option = doc.createElement('option');
      option.value = model;
      option.textContent = model;
      els.select.appendChild(option);
    }
    els.select.hidden = false;
    els.select.value = '';
  }

  /**
   * 清空模型列表状态（打开设置/保存/恢复成功时调用；进行中的请求结果会被丢弃）。
   * 同时恢复按钮可用与文案，避免上一次「获取中…」残留。
   */
  function reset() {
    requestSeq += 1;
    fetching = false;
    els.fetch.disabled = false;
    els.fetch.textContent = FETCH_TEXT;
    els.select.replaceChildren();
    els.select.hidden = true;
    els.select.value = '';
    setResult('');
    log.debug('llm.panel.models.reset', {});
  }

  /** 本地预检：端点合法性与密钥必填；不通过时标红对应字段并返回 null（不发请求） */
  function precheck(draft) {
    const rawEndpoint = String(draft?.baseUrl ?? '').trim();
    let endpoint = rawEndpoint;
    const normalize = configApi.normalizeEndpointInput;
    if (typeof normalize === 'function') {
      const normalized = normalize(rawEndpoint);
      if (!normalized?.ok) {
        showFieldErrors({ endpoint: normalized?.error ?? '端点不能为空' });
        log.warn('llm.panel.models.fetch.invalid', { field: 'endpoint' });
        return null;
      }
      endpoint = normalized.value ?? rawEndpoint;
      // 端点自动纠正（如误带 /chat/completions）：回填输入框，请求用纠正后的地址
      if (normalized.value && els.endpointInput) els.endpointInput.value = normalized.value;
    } else if (!/^https?:\/\//i.test(rawEndpoint)) {
      showFieldErrors({ endpoint: '端点必须以 http:// 或 https:// 开头' });
      log.warn('llm.panel.models.fetch.invalid', { field: 'endpoint' });
      return null;
    }
    // 用户 2026-11-10 明确：获取模型也要先配置 key，空/全空格不发请求
    if (String(draft?.apiKey ?? '').trim() === '') {
      showFieldErrors({ apiKey: KEY_REQUIRED_TEXT });
      log.warn('llm.panel.models.fetch.invalid', { field: 'apiKey' });
      return null;
    }
    return { ...draft, baseUrl: endpoint };
  }

  /** 点击「获取模型」：预检 → 真实请求 → 填下拉/结果区；不保存、不写消息、不画图 */
  async function doFetch() {
    if (fetching) return;
    showFieldErrors({});
    const draft = precheck(getDraft() || {});
    if (!draft) return;
    if (typeof configApi.fetchModels !== 'function') {
      setResult('获取模型失败：当前版本不支持获取模型', 'error');
      log.warn('llm.panel.models.fetch.unsupported', {});
      return;
    }
    fetching = true;
    requestSeq += 1;
    const mySeq = requestSeq;
    els.fetch.disabled = true;
    els.fetch.textContent = FETCHING_TEXT;
    els.select.replaceChildren();
    els.select.hidden = true;
    setResult('正在获取模型…', 'info');
    log.info('llm.panel.models.fetch.start', { hasApiKey: Boolean(draft.apiKey), timeoutMs: draft.timeoutMs ?? null });
    let result = null;
    try {
      result = await configApi.fetchModels(draft);
    } catch (error) {
      if (mySeq !== requestSeq) return;
      setResult(`获取模型失败：${error?.message ?? '未知错误'}`, 'error');
      log.error('llm.panel.models.fetch.failed', {}, error);
      return;
    } finally {
      if (mySeq === requestSeq) {
        fetching = false;
        els.fetch.disabled = false;
        els.fetch.textContent = FETCH_TEXT;
      }
    }
    if (mySeq !== requestSeq) return; // 已被 reset()/新的获取请求取代，丢弃迟到结果
    if (result?.ok) {
      const models = Array.isArray(result.models)
        ? result.models.filter((model) => typeof model === 'string' && model.trim() !== '')
        : [];
      const count = Number.isFinite(result.count) ? result.count : models.length;
      log.info('llm.panel.models.fetch', {
        ok: true, count, durationMs: result.durationMs ?? null, httpStatus: result.httpStatus ?? null,
      });
      if (models.length === 0) {
        setResult(EMPTY_TEXT, 'warn');
        return;
      }
      fillSelect(models);
      setResult(successText(count), 'ok');
      return;
    }
    // 失败：字段级错误（validation 时核心可能给 errors.baseUrl）→ 标红对应字段
    const fieldErrors = {};
    const errors = result?.errors ?? {};
    if (typeof errors.baseUrl === 'string' && errors.baseUrl) fieldErrors.endpoint = errors.baseUrl;
    if (typeof errors.apiKey === 'string' && errors.apiKey) fieldErrors.apiKey = errors.apiKey;
    if (Object.keys(fieldErrors).length > 0) showFieldErrors(fieldErrors);
    const kind = result?.kind ?? 'unknown';
    const authHint = kind === 'auth' ? '，请核对密钥是否正确' : '';
    setResult(formatFailureText('获取模型失败', result, authHint), 'error');
    log.warn('llm.panel.models.fetch', {
      ok: false, kind, durationMs: result?.durationMs ?? null, httpStatus: result?.httpStatus ?? null,
    });
  }

  /** 选择下拉项：回填模型字段并提示「保存后生效」；不自动保存 */
  function onSelectChange() {
    const model = String(els.select.value ?? '').trim();
    if (!model) return;
    els.modelInput.value = model;
    setResult(selectedText(model), 'ok');
    log.info('llm.panel.models.selected', { model });
  }

  /** 点击「获取模型」的事件处理器（保留函数引用，dispose 时才能解绑） */
  function doFetchHandler() {
    void doFetch();
  }
  els.fetch.addEventListener('click', doFetchHandler);
  els.select.addEventListener('change', onSelectChange);

  /** 销毁：解绑事件（面板 dispose 时调用） */
  function dispose() {
    els.fetch.removeEventListener('click', doFetchHandler);
    els.select.removeEventListener('change', onSelectChange);
    reset();
    log.info('llm.panel.models.dispose', {});
  }

  log.info('llm.panel.models.ready', {});
  return { reset, dispose, isFetching: () => fetching };
}
