/**
 * LLM 配置设置界面（需求 2026-11-09 R1～R8，方案 §5）：来源徽标、五项配置回显/编辑、字段级校验、
 * 测试连接、保存、恢复默认（行内二次确认）、未配置引导条与安全提示；打开设置只隐藏对话区 DOM。
 * 约束：不删除消息、不清空输入、不中断轮次；密钥只在输入框 value 与浏览器存储，日志/提示不落明文。
 */

import { createLogger } from '../log/index.js';
import * as defaultConfigApi from './llm-config.js';
import { createModelsView } from './llm-config-models-view.js';
import { formatFailureText } from './llm-config-texts.js';
import { createPanelToast } from './toast.js';

/** 模块 logger：只记动作与配置元信息，绝不记录密钥明文 */
const log = createLogger('agent/llm-config-panel');

/** 来源文案兜底（核心模块 sourceLabel 不可用时） */
const SOURCE_LABELS = { page: '页面配置', file: '文件配置', none: '未配置' };

/** 存储失败 code：保存失败必须提示刷新会丢失，但「测试连接」仍可用（R7） */
const STORAGE_FAILURE_CODES = new Set(['quota-exceeded', 'storage-unavailable', 'storage-error']);
/** 「去配置」入口闪烁高亮时长（毫秒） */
const FLASH_DURATION_MS = 1600;
/** 字段名 → [输入框 id, 字段错误行 id]（与 index.html 骨架一致，方案 §5.1） */
const FIELD_IDS = {
  endpoint: ['llm-endpoint', 'llm-endpoint-error'], apiKey: ['llm-api-key', 'llm-api-key-error'],
  model: ['llm-model', 'llm-model-error'], timeoutMs: ['llm-timeout', 'llm-timeout-error'],
  maxTokens: ['llm-max-tokens', 'llm-max-tokens-error'],
};
/** 页面/文件配置状态归一化：兼容字符串状态与对象状态两种契约写法 */
function statusOf(entry) {
  if (typeof entry === 'string') return { status: entry };
  if (entry && typeof entry === 'object') return { status: entry.status ?? entry.state ?? 'unknown', ...entry };
  return { status: entry === null || entry === undefined ? 'none' : 'unknown' };
}

/** 错误字段名归一化：兼容 baseUrl/endpoint、apiKey/key 等同义命名 */
function normalizeFieldName(name) {
  const key = String(name ?? '');
  const aliases = {
    baseUrl: 'endpoint', url: 'endpoint', endpoint: 'endpoint',
    apiKey: 'apiKey', key: 'apiKey', max_tokens: 'maxTokens', timeout: 'timeoutMs',
  };
  return aliases[key] ?? key;
}

/** 把 validateDraft / savePageConfig 的 errors 归一成 {字段名: 中文文案} */
function collectFieldErrors(errors) {
  const map = {};
  if (!errors) return map;
  const entries = Array.isArray(errors)
    ? errors.map((item) => [item?.field ?? item?.name, item?.message ?? item?.text])
    : Object.entries(errors);
  for (const [rawKey, rawValue] of entries) {
    if (rawValue === null || rawValue === undefined || rawValue === '') continue;
    map[normalizeFieldName(rawKey)] = typeof rawValue === 'string' ? rawValue : rawValue?.message ?? String(rawValue);
  }
  return map;
}

/** 页面配置损坏时浮出一次的面板提示文案（R7） */
const CORRUPT_TOAST_TEXT = '页面配置已损坏，已忽略（可重新保存）';

/** 端点自动纠正文案归并（corrections 可能是字符串/对象数组） */
function correctionsTextOf(corrections) {
  if (!Array.isArray(corrections) || corrections.length === 0) return '';
  return corrections.map((item) => (typeof item === 'string' ? item : item?.message ?? item?.text ?? '')).filter(Boolean).join('；');
}
/** 创建 LLM 配置设置界面控制器（options 见方案 §5.2；configApi/document/timers 供单测注入） */
export function createLlmConfigPanel(options = {}) {
  const {
    panel, document: doc = globalThis.document, configApi = defaultConfigApi,
    isBusy = () => false, onSaved = () => {}, timers = globalThis,
  } = options;
  if (!panel) throw new Error('createLlmConfigPanel 需要智能体面板容器 #agent-panel');
  if (!doc) throw new Error('createLlmConfigPanel 需要 document（Node 单测可注入 fake document）');

  /** 取必需 DOM；缺失直接报错（index.html 骨架与模块版本不一致时尽早暴露） */
  function getById(id) {
    const el = doc.getElementById(id);
    if (!el) throw new Error(`LLM 配置设置界面缺少 DOM：#${id}（请检查 web/index.html）`);
    return el;
  }

  /** 静态骨架元素（与 index.html / 方案 §5.1 的 id 一一对应） */
  const els = {};
  for (const [key, id] of Object.entries({
    open: 'agent-config-open', required: 'agent-config-required',
    requiredOpen: 'agent-config-required-open', config: 'agent-config',
    source: 'llm-config-source', close: 'llm-config-close', notice: 'llm-config-notice',
    apiKey: 'llm-api-key', apiKeyToggle: 'llm-api-key-toggle',
    test: 'llm-config-test', testResult: 'llm-config-test-result', save: 'llm-config-save',
    restore: 'llm-config-restore', restoreConfirm: 'llm-config-restore-confirm',
    restoreOk: 'llm-config-restore-ok', restoreCancel: 'llm-config-restore-cancel',
  })) els[key] = getById(id);
  /** 字段名 → {input, error}（键与 FIELD_IDS 一致） */
  const fields = {};
  for (const [name, [inputId, errorId]] of Object.entries(FIELD_IDS)) fields[name] = { input: getById(inputId), error: getById(errorId) };
  /** 对话消息区：打开设置记录滚动位置，关闭后恢复（display:none 期间滚动位置会丢） */
  const messagesEl = doc.getElementById('agent-messages');
  /** 面板内轻提示：页面配置损坏时浮出一次（不进入消息流、不改变滚动位置） */
  const panelToast = createPanelToast(panel);
  /** 「获取模型」子视图（追加需求 2026-11-10）：真实拉取端点模型列表并回填模型字段 */
  const modelsView = createModelsView({ document: doc, configApi, getDraft: buildDraft, showFieldErrors: renderFieldErrors });

  let keyVisible = false; // 密钥是否明文显示（只改 input.type，不改 value）
  let saving = false; // 保存进行中（防重入）
  let testing = false; // 测试连接进行中（只禁用测试按钮自身）
  let savedScrollTop = null; // 打开设置前的消息区滚动位置
  let flashTimer = null; // 「去配置」闪烁计时器
  let unsubscribe = null; // 配置变更订阅取消函数
  let corruptToastSignature = null; // 已浮出提示的损坏签名（同一损坏只提示一次，避免刷屏）
  /** 来源中文文案：优先核心模块 sourceLabel，缺失时用内置兜底 */
  function labelOf(source) {
    try {
      const label = configApi.sourceLabel?.(source);
      if (typeof label === 'string' && label) return label;
    } catch {
      // 核心模块异常时用兜底文案，不阻断界面
    }
    return SOURCE_LABELS[source] ?? SOURCE_LABELS.none;
  }
  /** 超时/最大输出默认值（核心模块常量缺失时用需求表内默认值兜底） */
  function defaultsOf() {
    const defaults = configApi.LLM_CONFIG_DEFAULTS ?? {};
    return {
      timeoutMs: Number.isFinite(defaults.timeoutMs) ? defaults.timeoutMs : 180000,
      maxTokens: Number.isFinite(defaults.maxTokens) ? defaults.maxTokens : 32000,
    };
  }

  /** 面板内提示区（保存/恢复/纠正/损坏提示共用；空文本即收起） */
  function setNotice(text, kind = 'info') {
    els.notice.textContent = text || '';
    els.notice.hidden = !text;
    els.notice.className = text ? `llm-notice is-${kind}` : 'llm-notice';
  }

  /** 测试结果区（成功/失败；空文本即收起） */
  function setTestResult(text, kind = '') {
    els.testResult.textContent = text || '';
    els.testResult.hidden = !text;
    els.testResult.className = text ? `llm-test-result is-${kind}` : 'llm-test-result';
  }

  /** 清空全部字段错误行与 aria-invalid */
  function clearFieldErrors() {
    for (const item of Object.values(fields)) {
      item.error.textContent = '';
      item.error.hidden = true;
      item.error.className = 'llm-field-error';
      item.input.setAttribute('aria-invalid', 'false');
      item.input.removeAttribute('aria-describedby');
    }
  }

  /** 渲染字段级错误（保存不生效；焦点落到第一个错误字段） */
  function renderFieldErrors(errors) {
    let firstInput = null;
    for (const [name, item] of Object.entries(fields)) {
      const message = errors[name] ?? '';
      item.error.textContent = message;
      item.error.hidden = !message;
      item.error.className = message ? 'llm-field-error is-visible' : 'llm-field-error';
      item.input.setAttribute('aria-invalid', message ? 'true' : 'false');
      if (message) {
        item.input.setAttribute('aria-describedby', FIELD_IDS[name][1]);
        if (!firstInput) firstInput = item.input;
      } else {
        item.input.removeAttribute('aria-describedby');
      }
    }
    if (firstInput) {
      try { firstInput.focus(); } catch { /* 失焦失败不影响校验提示 */ }
    }
  }

  /** 密钥显示切换：只改 input.type 与按钮文案，不动 value（R3/R8） */
  function setKeyVisible(visible) {
    keyVisible = Boolean(visible);
    els.apiKey.type = keyVisible ? 'text' : 'password';
    els.apiKeyToggle.textContent = keyVisible ? '隐藏' : '显示';
    els.apiKeyToggle.setAttribute('aria-pressed', keyVisible ? 'true' : 'false');
    els.apiKeyToggle.setAttribute('aria-label', keyVisible ? '隐藏密钥' : '显示密钥');
  }

  /** 把生效配置回显到五个字段（打开设置/恢复默认后调用；密钥默认隐藏） */
  function applyConfigToFields(config) {
    const defaults = defaultsOf();
    fields.endpoint.input.value = typeof config?.baseUrl === 'string' ? config.baseUrl : '';
    fields.apiKey.input.value = typeof config?.apiKey === 'string' ? config.apiKey : '';
    fields.model.input.value = typeof config?.model === 'string' ? config.model : '';
    fields.timeoutMs.input.value = String(Number.isFinite(config?.timeoutMs) ? config.timeoutMs : defaults.timeoutMs);
    fields.maxTokens.input.value = String(Number.isFinite(config?.maxTokens) ? config.maxTokens : defaults.maxTokens);
    setKeyVisible(false);
  }

  /** 把校验归一化结果回填输入框（端点自动纠正等，保存前可见） */
  function applyNormalizedToFields(normalized) {
    if (!normalized || typeof normalized !== 'object') return;
    const values = {
      endpoint: normalized.baseUrl, apiKey: normalized.apiKey, model: normalized.model,
      timeoutMs: normalized.timeoutMs, maxTokens: normalized.maxTokens,
    };
    for (const [name, value] of Object.entries(values)) {
      if (value !== undefined && value !== null && value !== '') fields[name].input.value = String(value);
    }
  }
  /** 从输入框构造草稿（字段名与存储结构一致；数值以字符串交给核心模块校验，不静默丢弃） */
  function buildDraft() {
    return {
      baseUrl: fields.endpoint.input.value.trim(),
      apiKey: fields.apiKey.input.value,
      model: fields.model.input.value,
      timeoutMs: fields.timeoutMs.input.value.trim(),
      maxTokens: fields.maxTokens.input.value.trim(),
    };
  }

  /** 刷新界面：来源徽标 / 恢复默认按钮 / 未配置引导条 / 损坏提示；可选回显字段 */
  async function refresh({ reason = 'refresh', renderFields = false } = {}) {
    let effective = null;
    try {
      effective = await configApi.resolveEffectiveConfig();
    } catch (error) {
      log.error('llm.panel.resolve.failed', { reason }, error);
      return null;
    }
    const source = effective?.source ?? 'none';
    els.source.textContent = `来源：${labelOf(source)}`;
    els.source.setAttribute('data-source', source);
    els.source.className = `agent-config-source is-${source}`;
    els.restore.hidden = source !== 'page'; // R6：仅页面配置可恢复默认
    if (source !== 'page') els.restoreConfirm.hidden = true;
    els.required.hidden = Boolean(effective?.config); // R7：无生效配置时显示引导条
    const pageStatus = statusOf(effective?.page);
    if (pageStatus.status === 'corrupt') {
      // R7：页面配置损坏只回落文件配置不白屏；设置界面常驻提示 + 面板 toast 只浮出一次
      setNotice(pageStatus.message || CORRUPT_TOAST_TEXT, 'warn');
      const signature = pageStatus.message ?? 'corrupt';
      if (corruptToastSignature !== signature) {
        corruptToastSignature = signature;
        panelToast.show(CORRUPT_TOAST_TEXT, { kind: 'warn' });
        log.warn('llm.panel.corrupt', { message: signature });
      }
    } else if (corruptToastSignature !== null) {
      corruptToastSignature = null;
    }
    if (renderFields) applyConfigToFields(effective?.config ?? null);
    log.debug('llm.panel.refresh', {
      reason, source, hasConfig: Boolean(effective?.config), pageStatus: pageStatus.status,
      fileStatus: statusOf(effective?.file).status,
    });
    return effective;
  }

  /** 打开设置界面：隐藏对话展示、回显生效配置；不删除消息/不清空输入/不中断轮次 */
  async function open() {
    if (!els.config.hidden) return refresh({ reason: 'reopen', renderFields: true });
    // 记录消息区滚动位置：对话区用 display:none 隐藏，关闭后恢复（关闭后滚动位置必须不变）
    if (messagesEl && Number.isFinite(messagesEl.scrollTop)) savedScrollTop = messagesEl.scrollTop;
    panel.hidden = false;
    els.open.classList.add('is-active');
    panel.classList.add('is-config-open');
    els.config.hidden = false;
    els.restoreConfirm.hidden = true;
    clearFieldErrors();
    setNotice('');
    setTestResult('');
    modelsView.reset(); // 重新打开设置不显示上一次的模型列表（追加需求 2026-11-10）
    els.config.scrollTop = 0;
    const effective = await refresh({ reason: 'open', renderFields: true });
    log.info('llm.panel.open', { source: effective?.source ?? 'none', hasConfig: Boolean(effective?.config) });
  }

  /** 关闭设置界面：恢复对话展示与滚动位置；会话/消息/输入值全部不动 */
  function close() {
    if (els.config.hidden) return;
    panel.classList.remove('is-config-open');
    els.config.hidden = true;
    els.open.classList.remove('is-active');
    els.restoreConfirm.hidden = true;
    // 先恢复显示再回写滚动位置（display:none 期间无法定位滚动）
    if (messagesEl && savedScrollTop !== null) {
      messagesEl.scrollTop = savedScrollTop;
      savedScrollTop = null;
    }
    log.info('llm.panel.close', {});
  }

  /** 保存：校验 →（端点自动纠正并提示）→ 写浏览器存储 → 来源徽标/引导条立即刷新；失败明确报错 */
  async function doSave() {
    if (saving) return;
    saving = true;
    try {
      clearFieldErrors();
      setNotice('');
      const draft = buildDraft();
      log.info('llm.panel.save.start', {
        baseUrl: draft.baseUrl, model: draft.model, hasApiKey: Boolean(draft.apiKey), apiKeyLength: draft.apiKey.length,
      });
      let validation = null;
      try {
        validation = await configApi.validateDraft(draft);
      } catch (error) {
        setNotice(`校验失败：${error?.message ?? '未知错误'}`, 'error');
        log.error('llm.panel.validate.failed', {}, error);
        return;
      }
      if (!validation?.ok) {
        const errors = collectFieldErrors(validation?.errors);
        renderFieldErrors(errors);
        setNotice('校验未通过：请修正标红字段后再保存', 'warn');
        log.warn('llm.panel.save.invalid', { fields: Object.keys(errors) });
        return;
      }
      const normalized = validation.normalized ?? draft;
      const corrections = correctionsTextOf(validation.corrections);
      applyNormalizedToFields(normalized);
      let result = null;
      try {
        result = await configApi.savePageConfig(normalized);
      } catch (error) {
        setNotice(`保存失败：${error?.message ?? '未知错误'}`, 'error');
        log.error('llm.panel.save.failed', {}, error);
        return;
      }
      if (!result?.ok) {
        if (result?.errors) renderFieldErrors(collectFieldErrors(result.errors));
        const storageHint = STORAGE_FAILURE_CODES.has(result?.code)
          ? '（配置未保存，刷新后会丢失；测试连接仍可用）'
          : '';
        const reason = result?.message ?? result?.reason ?? '浏览器本地存储不可用';
        setNotice(`保存失败：${reason}${storageHint}${corrections ? `；端点已自动纠正：${corrections}` : ''}`, 'error');
        log.error('llm.panel.save.rejected', { code: result?.code ?? null });
        return;
      }
      // 保存成功：来源徽标 / 未配置引导条 / 恢复默认按钮立即刷新（R3/R7）
      await refresh({ reason: 'saved' });
      const savedConfig = result?.config ?? normalized;
      const model = typeof savedConfig?.model === 'string' ? savedConfig.model : String(draft.model ?? '');
      const busyHint = isBusy() ? '（本轮进行中，新配置从下一轮生效）' : '';
      const correctionHint = corrections ? `；端点已自动纠正：${corrections}` : '';
      setNotice(`已保存并生效 · 模型 ${model}${correctionHint}${busyHint}`, 'success');
      setTestResult('');
      modelsView.reset(); // 保存后清空模型列表状态（追加需求 2026-11-10）
      log.info('llm.panel.saved', {
        source: 'page', baseUrl: savedConfig?.baseUrl ?? null, model,
        timeoutMs: savedConfig?.timeoutMs ?? null, maxTokens: savedConfig?.maxTokens ?? null,
        endpointCorrected: Boolean(corrections), busy: isBusy(),
      });
      onSaved({ source: 'page', model });
    } finally {
      saving = false;
    }
  }

  /** 恢复默认：行内二次确认 → 清除页面配置 → 来源与回显立即回落（R6） */
  async function doRestore() {
    els.restoreConfirm.hidden = true;
    let result = null;
    try {
      result = await configApi.clearPageConfig();
    } catch (error) {
      setNotice(`恢复默认失败：${error?.message ?? '未知错误'}`, 'error');
      log.error('llm.panel.restore.failed', {}, error);
      return;
    }
    if (!result?.ok) {
      setNotice(`恢复默认失败：${result?.message ?? result?.reason ?? '浏览器本地存储不可用'}`, 'error');
      log.error('llm.panel.restore.rejected', { code: result?.code ?? null });
      return;
    }
    const effective = await refresh({ reason: 'restored', renderFields: true });
    const label = labelOf(effective?.source ?? 'none');
    const hint = effective?.config ? '' : '（暂无文件配置，请填写后保存）';
    setNotice(`已恢复默认：当前来源「${label}」${hint}`, 'success');
    setTestResult('');
    modelsView.reset(); // 恢复默认后清空模型列表状态（追加需求 2026-11-10）
    log.info('llm.panel.restored', { source: effective?.source ?? 'none', hasConfig: Boolean(effective?.config) });
  }

  /** 测试连接：用当前填写内容发真实请求；不保存、不写消息、不触发画图（R5） */
  async function doTest() {
    if (testing) return;
    testing = true;
    els.test.disabled = true;
    els.test.textContent = '测试中…';
    setTestResult('');
    try {
      const draft = buildDraft();
      log.info('llm.panel.test.start', { baseUrl: draft.baseUrl, model: draft.model, hasApiKey: Boolean(draft.apiKey) });
      let result = null;
      try {
        result = await configApi.testConnection(draft);
      } catch (error) {
        setTestResult(`测试连接异常：${error?.message ?? '未知错误'}`, 'error');
        log.error('llm.panel.test.failed', { kind: 'exception' }, error);
        return;
      }
      if (result?.ok) {
        const modelText = typeof result.model === 'string' && result.model ? result.model : '响应未返回模型名';
        const parts = [`连接成功 · 模型 ${modelText}`];
        if (Number.isFinite(result.durationMs)) parts.push(`耗时 ${Math.round(result.durationMs)} ms`);
        if (Number.isFinite(result.httpStatus)) parts.push(`HTTP ${result.httpStatus}`);
        setTestResult(parts.join(' · '), 'ok');
        log.info('llm.panel.test.success', {
          model: result.model ?? null, httpStatus: result.httpStatus ?? null,
          durationMs: Number.isFinite(result.durationMs) ? Math.round(result.durationMs) : null,
        });
      } else {
        setTestResult(formatFailureText('连接失败', result), 'error');
        log.warn('llm.panel.test.rejected', {
          kind: result?.kind ?? 'unknown', httpStatus: result?.httpStatus ?? null,
          durationMs: Number.isFinite(result?.durationMs) ? Math.round(result.durationMs) : null,
        });
      }
    } finally {
      testing = false;
      els.test.disabled = false;
      els.test.textContent = '测试连接';
    }
  }

  /** 「去配置」入口闪烁高亮（发送被未配置闸门拦下时由 ui.js 调用；不改变其它状态） */
  function flash() {
    const targets = [els.open];
    if (!els.required.hidden) targets.push(els.required);
    for (const target of targets) target.classList.add('is-flash');
    if (flashTimer !== null) timers.clearTimeout(flashTimer);
    flashTimer = timers.setTimeout(() => {
      flashTimer = null;
      for (const target of targets) target.classList.remove('is-flash');
    }, FLASH_DURATION_MS);
    log.debug('llm.panel.flash', { requiredVisible: !els.required.hidden });
  }

  /** 事件绑定（保留引用，dispose 时可解绑） */
  const listeners = [];
  function on(el, type, handler) {
    el.addEventListener(type, handler);
    listeners.push([el, type, handler]);
  }
  on(els.open, 'click', () => void open());
  on(els.requiredOpen, 'click', () => void open());
  on(els.close, 'click', () => close());
  on(els.apiKeyToggle, 'click', () => {
    setKeyVisible(!keyVisible);
    log.debug('llm.panel.key.visibility', { visible: keyVisible });
  });
  on(els.save, 'click', () => void doSave());
  on(els.restore, 'click', () => {
    els.restoreConfirm.hidden = false;
    log.info('llm.panel.restore.confirm', {});
  });
  on(els.restoreOk, 'click', () => void doRestore());
  on(els.restoreCancel, 'click', () => {
    els.restoreConfirm.hidden = true;
    log.info('llm.panel.restore.cancel', {});
  });
  on(els.test, 'click', () => void doTest());

  /** 销毁：解绑事件、取消配置订阅与闪烁计时（页面生命周期管理用） */
  function dispose() {
    for (const [el, type, handler] of listeners) {
      try { el.removeEventListener(type, handler); } catch { /* 解绑失败不影响页面 */ }
    }
    listeners.length = 0;
    modelsView.dispose();
    if (flashTimer !== null) {
      timers.clearTimeout(flashTimer);
      flashTimer = null;
    }
    if (typeof unsubscribe === 'function') {
      try { unsubscribe(); } catch { /* 退订失败不影响页面 */ }
    }
    unsubscribe = null;
    log.info('llm.panel.dispose', {});
  }

  // 初始化：订阅配置变更 + 首次刷新未配置引导条/来源徽标（启动路径异常不得影响页面）
  try {
    const off = configApi.subscribeConfigChange?.(() => {
      void refresh({ reason: 'config-change' });
    });
    unsubscribe = typeof off === 'function' ? off : null;
  } catch (error) {
    log.error('llm.panel.subscribe.failed', {}, error);
  }
  setNotice('');
  setTestResult('');
  clearFieldErrors();
  void refresh({ reason: 'init' });
  log.info('llm.panel.ready', {});

  return { open, close, refresh, flash, dispose };
}
