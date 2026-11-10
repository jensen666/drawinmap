/**
 * LLM 配置设置界面（llm-config-panel.js）fake DOM 单测（Node 直接运行，零依赖）。
 *
 * 覆盖方案 §6.2：打开回显（来源/五字段/密钥隐藏）、保存校验错误、保存成功来源与提示、
 * 恢复默认二次确认与回落、测试连接成功/失败渲染、未配置引导条显隐与「去配置」打开、
 * 密钥显示切换不改值；另补窄屏无关的交互边界（保存失败不误报成功、损坏配置提示、
 * 关闭后消息区滚动位置不变、缺失 DOM 早报错、订阅/销毁）。
 *
 * 设计：模块的 configApi/document/timers 都是注入点，测试用契约桩（与方案 §3 对齐的
 * 同步/异步返回结构）驱动面板，不触达真实 localStorage / fetch，也不依赖 T1 内部实现。
 *
 * 运行：node test/llm-config-panel.mjs
 */

/** 最小 fake DOM：只实现设置界面用到的接口 */
function createFakeDocument() {
  class FakeElement {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.className = '';
      this.textContent = '';
      this.hidden = false;
      this.value = '';
      this.type = '';
      this.disabled = false;
      this.scrollTop = 0;
      this.focusedCount = 0;
      this.children = [];
      this.parent = null;
      this.attributes = new Map();
      this.listeners = new Map();
      const classSet = () => new Set(String(this.className).split(/\s+/).filter(Boolean));
      this.classList = {
        add: (...names) => {
          const set = classSet();
          for (const name of names) set.add(name);
          this.className = [...set].join(' ');
        },
        remove: (...names) => {
          const set = classSet();
          for (const name of names) set.delete(name);
          this.className = [...set].join(' ');
        },
        contains: (name) => classSet().has(name),
        toggle: (name, force) => {
          const set = classSet();
          const on = force === undefined ? !set.has(name) : Boolean(force);
          if (on) set.add(name);
          else set.delete(name);
          this.className = [...set].join(' ');
          return on;
        },
      };
    }

    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    }

    getAttribute(name) {
      return this.attributes.get(name) ?? null;
    }

    removeAttribute(name) {
      this.attributes.delete(name);
    }

    addEventListener(type, handler) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(handler);
    }

    removeEventListener(type, handler) {
      const handlers = this.listeners.get(type) ?? [];
      this.listeners.set(type, handlers.filter((item) => item !== handler));
    }

    /** 触发一次事件（模拟真实 DOM 的事件派发） */
    dispatch(type) {
      for (const handler of [...(this.listeners.get(type) ?? [])]) {
        handler({ type, target: this, preventDefault() {} });
      }
    }

    /** 模拟点击 */
    click() {
      this.dispatch('click');
    }

    /** 模拟聚焦（只记录次数，校验"焦点落在第一个错误字段"） */
    focus() {
      this.focusedCount += 1;
    }

    /** 追加子节点（toast 挂载用） */
    appendChild(child) {
      this.children.push(child);
      child.parent = this;
      return child;
    }

    /** 替换全部子节点（模型下拉列表重置用） */
    replaceChildren(...nodes) {
      for (const child of this.children) child.parent = null;
      this.children = [];
      for (const node of nodes) this.appendChild(node);
    }

    /** 从父节点移除自身（toast dispose 用） */
    remove() {
      if (this.parent) {
        this.parent.children = this.parent.children.filter((item) => item !== this);
        this.parent = null;
      }
    }
  }
  const registry = new Map();
  const doc = {
    createElement: (tag) => new FakeElement(tag),
    getElementById: (id) => registry.get(id) ?? null,
    /**
     * 登记一个静态骨架元素（等价于 index.html 里写好的节点）。
     *
     * @param {string} id 元素 id
     * @param {string} [tag] 标签名
     * @returns {FakeElement} 元素
     */
    register(id, tag = 'div') {
      const element = new FakeElement(tag);
      registry.set(id, element);
      return element;
    },
  };
  return { doc, registry, FakeElement };
}

/** 假定时器：支持手动到点（面板 flash 高亮用） */
function makeFakeTimers() {
  const scheduled = new Map();
  let seq = 0;
  return {
    setTimeout: (fn, ms) => {
      seq += 1;
      scheduled.set(seq, { fn, ms });
      return seq;
    },
    clearTimeout: (id) => {
      scheduled.delete(id);
    },
    get size() {
      return scheduled.size;
    },
    /** 触发全部到点回调（模拟时间流逝） */
    flush() {
      const entries = [...scheduled.values()];
      scheduled.clear();
      for (const entry of entries) entry.fn();
    },
  };
}

/** 契约桩的默认校验：足够测试面板"校验错误渲染"路径，不复制核心模块逻辑 */
function defaultValidate(draft) {
  const errors = {};
  if (!String(draft.baseUrl ?? '').trim()) errors.baseUrl = '端点必填';
  if (!String(draft.apiKey ?? '').trim()) errors.apiKey = '密钥不能为空';
  if (!String(draft.model ?? '').trim()) errors.model = '模型不能为空';
  const timeoutMs = Number(draft.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) {
    errors.timeoutMs = '单次超时必须是 1000~600000 的整数';
  }
  const maxTokens = Number(draft.maxTokens);
  if (!Number.isInteger(maxTokens) || maxTokens < 256 || maxTokens > 64000) {
    errors.maxTokens = '最大输出必须是 256~64000 的整数';
  }
  if (Object.keys(errors).length > 0) {
    return { ok: false, errors, normalized: { baseUrl: null, apiKey: null, model: null, timeoutMs: null, maxTokens: null }, corrections: [] };
  }
  return {
    ok: true,
    errors: {},
    normalized: {
      baseUrl: String(draft.baseUrl).trim(),
      apiKey: String(draft.apiKey).trim(),
      model: String(draft.model).trim(),
      timeoutMs,
      maxTokens,
    },
    corrections: [],
  };
}

/**
 * 按方案 §3 契约创建假配置核心（同步/异步与真实模块一致）：
 * resolveEffectiveConfig / testConnection 异步；validateDraft / savePageConfig / clearPageConfig 同步。
 *
 * @param {{page?: object|null, file?: object|null}} initial 初始页面/文件配置
 * @returns {{api: object, state: object, notify: Function}} 假模块与可观测状态
 */
function createFakeConfigApi({ page = null, file = null } = {}) {
  const state = {
    page,
    file,
    pageStatus: null,
    pageMessage: null,
    fileStatus: null,
    validateImpl: null,
    saveImpl: null,
    clearImpl: null,
    testImpl: null,
    fetchModelsImpl: null,
    validateDrafts: [],
    savedDrafts: [],
    testDrafts: [],
    fetchDrafts: [],
    clearCalls: 0,
    listeners: new Set(),
  };
  /** 当前生效解析结果（与真实契约结构一致） */
  function effective() {
    const source = state.page ? 'page' : state.file ? 'file' : 'none';
    return {
      source,
      config: state.page ?? state.file ?? null,
      page: {
        status: state.pageStatus ?? (state.page ? 'ok' : 'none'),
        config: state.page,
        message: state.pageMessage,
        reason: null,
      },
      file: { status: state.fileStatus ?? (state.file ? 'ok' : 'missing'), config: state.file, message: null },
    };
  }
  /** 通知订阅者（保存/恢复成功时） */
  function notify(event) {
    for (const listener of [...state.listeners]) listener(event);
  }
  const api = {
    LLM_CONFIG_DEFAULTS: Object.freeze({ timeoutMs: 180000, maxTokens: 32000 }),
    LLM_CONFIG_STORAGE_KEY: 'drawinmap.llm-config.v1',
    sourceLabel: (source) => ({ page: '页面配置', file: '文件配置' }[source] ?? '未配置'),
    resolveEffectiveConfig: async () => effective(),
    validateDraft: (draft) => {
      state.validateDrafts.push(draft);
      return state.validateImpl ? state.validateImpl(draft) : defaultValidate(draft);
    },
    savePageConfig: (draft) => {
      state.savedDrafts.push(draft);
      const result = state.saveImpl
        ? state.saveImpl(draft)
        : { ok: true, source: 'page', config: { ...draft }, corrections: [], previousSource: state.page ? 'page' : state.file ? 'file' : 'none' };
      if (result?.ok && result.config) {
        state.page = result.config;
        notify({ action: 'save', source: 'page', config: state.page });
      }
      return result;
    },
    clearPageConfig: () => {
      state.clearCalls += 1;
      const result = state.clearImpl
        ? state.clearImpl()
        : { ok: true, source: state.file ? 'file' : 'none', config: null, previousSource: state.page ? 'page' : 'none' };
      if (result?.ok) {
        state.page = null;
        notify({ action: 'restore', source: result.source, config: state.file });
      }
      return result;
    },
    testConnection: async (draft) => {
      state.testDrafts.push(draft);
      return state.testImpl
        ? state.testImpl(draft)
        : { ok: true, model: 'stub-model', durationMs: 100, httpStatus: 200, requestId: null };
    },
    // 「获取模型」（追加需求 2026-11-10）契约桩：normalizeEndpointInput + fetchModels
    normalizeEndpointInput: (raw) => {
      const value = typeof raw === 'string' ? raw.trim() : '';
      if (!value) return { ok: false, value: null, correction: null, error: '端点不能为空' };
      if (!/^https?:\/\//i.test(value)) {
        return { ok: false, value: null, correction: null, error: '端点必须以 http:// 或 https:// 开头' };
      }
      const normalized = value.replace(/\/chat\/completions$/i, '').replace(/\/+$/, '');
      return {
        ok: true,
        value: normalized,
        correction: normalized !== value ? '已自动去除端点末尾的 /chat/completions' : null,
        error: null,
      };
    },
    fetchModels: async (draft) => {
      state.fetchDrafts.push(draft);
      return state.fetchModelsImpl
        ? state.fetchModelsImpl(draft)
        : { ok: true, models: ['stub-model-a', 'stub-model-b'], count: 2, durationMs: 50, httpStatus: 200 };
    },
    subscribeConfigChange: (listener) => {
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
  };
  return { api, state, notify };
}

/** 造齐 index.html 里的静态骨架（id 与方案 §5.1 一致） */
function buildSkeleton(doc) {
  const register = (id, tag = 'div') => doc.register(id, tag);
  const elements = {
    panel: register('agent-panel', 'section'),
    messages: register('agent-messages'),
    open: register('agent-config-open', 'button'),
    required: register('agent-config-required'),
    requiredOpen: register('agent-config-required-open', 'button'),
    config: register('agent-config', 'section'),
    source: register('llm-config-source'),
    close: register('llm-config-close', 'button'),
    notice: register('llm-config-notice'),
    endpoint: register('llm-endpoint', 'input'),
    apiKey: register('llm-api-key', 'input'),
    apiKeyToggle: register('llm-api-key-toggle', 'button'),
    model: register('llm-model', 'input'),
    modelsFetch: register('llm-models-fetch', 'button'),
    modelsSelect: register('llm-models-select', 'select'),
    modelsResult: register('llm-models-result'),
    timeoutMs: register('llm-timeout', 'input'),
    maxTokens: register('llm-max-tokens', 'input'),
    endpointError: register('llm-endpoint-error'),
    apiKeyError: register('llm-api-key-error'),
    modelError: register('llm-model-error'),
    timeoutError: register('llm-timeout-error'),
    maxTokensError: register('llm-max-tokens-error'),
    test: register('llm-config-test', 'button'),
    testResult: register('llm-config-test-result'),
    save: register('llm-config-save', 'button'),
    restore: register('llm-config-restore', 'button'),
    restoreConfirm: register('llm-config-restore-confirm'),
    restoreOk: register('llm-config-restore-ok', 'button'),
    restoreCancel: register('llm-config-restore-cancel', 'button'),
  };
  // 与 index.html 初始状态一致：设置视图/引导条/确认区/提示/错误行默认隐藏
  elements.panel.hidden = true;
  elements.required.hidden = true;
  elements.config.hidden = true;
  elements.notice.hidden = true;
  elements.testResult.hidden = true;
  elements.restore.hidden = true;
  elements.restoreConfirm.hidden = true;
  elements.modelsSelect.hidden = true;
  elements.modelsResult.hidden = true;
  // 静态骨架里的行内二次确认文案（真实页面由 index.html 提供，fake DOM 需显式写入）
  elements.restoreConfirm.textContent = '将删除浏览器中的配置，回落到文件配置。此操作不修改代码文件，确认恢复？';
  elements.apiKey.type = 'password';
  return elements;
}

/** 等待面板内部 async 刷新链跑完（纯微任务，不依赖真实计时器） */
async function settle() {
  for (let i = 0; i < 12; i += 1) {
    await Promise.resolve();
  }
}

let failures = 0;
let checks = 0;

/**
 * 断言。
 *
 * @param {string} label 断言说明
 * @param {boolean} condition 是否通过
 * @param {string} [detail] 失败详情
 */
function check(label, condition, detail = '') {
  checks += 1;
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`[check] ${label} -> ${ok ? 'PASS' : `FAIL ${detail}`}`);
}

const fakeDocument = createFakeDocument();
const fakeTimers = makeFakeTimers();
/** 全局计时器调用计数：toast.js 用全局 setTimeout，用它验证"同一损坏只提示一次" */
let globalTimerCalls = 0;
globalThis.setTimeout = (...args) => {
  globalTimerCalls += 1;
  return fakeTimers.setTimeout(...args);
};
globalThis.clearTimeout = (id) => fakeTimers.clearTimeout(id);
globalThis.document = fakeDocument.doc;

const { createLlmConfigPanel } = await import('../web/src/agent/llm-config-panel.js');

/** 页面配置样例 */
const PAGE_CONFIG = {
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'test-placeholder-key-page',
  model: 'page-model',
  timeoutMs: 120000,
  maxTokens: 20000,
};
/** 文件配置样例 */
const FILE_CONFIG = {
  baseUrl: 'https://file.example.com/v1',
  apiKey: 'test-placeholder-key-filepanel',
  model: 'file-model',
  timeoutMs: 180000,
  maxTokens: 32000,
};

/**
 * 创建一套被测试的面板实例。
 *
 * @param {{page?: object|null, file?: object|null, isBusy?: Function}} [options] 初始配置与轮次状态
 * @returns {Promise<object>} { elements, state, api, panel, timers, doc }
 */
async function setup({ page = null, file = null, isBusy = () => false } = {}) {
  const dom = createFakeDocument();
  const elements = buildSkeleton(dom.doc);
  const timers = makeFakeTimers();
  const fake = createFakeConfigApi({ page, file });
  const panel = createLlmConfigPanel({
    panel: elements.panel,
    document: dom.doc,
    configApi: fake.api,
    isBusy,
    timers,
  });
  await settle();
  return { elements, state: fake.state, api: fake.api, panel, timers, doc: dom.doc, notify: fake.notify };
}

// ==================== 场景 1：未配置引导条（R7） ====================
{
  const { elements, panel } = await setup();
  check('未配置：引导条显示', elements.required.hidden === false, String(elements.required.hidden));
  check('未配置：来源徽标文本', elements.source.textContent.includes('未配置'), elements.source.textContent);
  check('未配置：来源 data-source=none', elements.source.getAttribute('data-source') === 'none', elements.source.getAttribute('data-source'));
  check('未配置：恢复默认按钮隐藏', elements.restore.hidden === true, String(elements.restore.hidden));
  check('未配置：设置视图默认关闭', elements.config.hidden === true, String(elements.config.hidden));
  check('未配置：设置入口不被禁用', elements.open.disabled === false, String(elements.open.disabled));
  // 引导条「去配置」打开设置界面
  elements.requiredOpen.click();
  await settle();
  check('去配置：引导条按钮可打开设置界面', elements.config.hidden === false, String(elements.config.hidden));
  check('去配置：面板加 is-config-open', elements.panel.classList.contains('is-config-open'), elements.panel.className);
  panel.dispose();
}

// ==================== 场景 2：打开回显（来源/五字段/密钥隐藏，R3） ====================
{
  const { elements } = await setup({ page: PAGE_CONFIG, file: FILE_CONFIG });
  elements.messages.scrollTop = 42;
  elements.open.click();
  await settle();
  check('回显：来源=页面配置', elements.source.textContent.includes('页面配置'), elements.source.textContent);
  check('回显：端点', elements.endpoint.value === PAGE_CONFIG.baseUrl, elements.endpoint.value);
  check('回显：密钥', elements.apiKey.value === PAGE_CONFIG.apiKey, elements.apiKey.value);
  check('回显：模型', elements.model.value === PAGE_CONFIG.model, elements.model.value);
  check('回显：超时', elements.timeoutMs.value === String(PAGE_CONFIG.timeoutMs), elements.timeoutMs.value);
  check('回显：最大输出', elements.maxTokens.value === String(PAGE_CONFIG.maxTokens), elements.maxTokens.value);
  check('回显：密钥默认隐藏（type=password）', elements.apiKey.type === 'password', elements.apiKey.type);
  check('回显：切换按钮文案为「显示」', elements.apiKeyToggle.textContent === '显示', elements.apiKeyToggle.textContent);
  check('回显：页面配置时恢复默认可见', elements.restore.hidden === false, String(elements.restore.hidden));
  check('回显：有生效配置时引导条隐藏', elements.required.hidden === true, String(elements.required.hidden));
}

// ==================== 场景 3：文件配置回显（来源=文件配置） ====================
{
  const { elements } = await setup({ file: FILE_CONFIG });
  elements.open.click();
  await settle();
  check('文件配置：来源=文件配置', elements.source.textContent.includes('文件配置'), elements.source.textContent);
  check('文件配置：data-source=file', elements.source.getAttribute('data-source') === 'file', elements.source.getAttribute('data-source'));
  check('文件配置：端点回显文件值', elements.endpoint.value === FILE_CONFIG.baseUrl, elements.endpoint.value);
  check('文件配置：恢复默认按钮隐藏', elements.restore.hidden === true, String(elements.restore.hidden));
  check('文件配置：引导条隐藏', elements.required.hidden === true, String(elements.required.hidden));
}

// ==================== 场景 4：密钥显示切换只改 type 不改 value（R3/R8） ====================
{
  const { elements } = await setup({ page: PAGE_CONFIG });
  elements.open.click();
  await settle();
  const before = elements.apiKey.value;
  elements.apiKeyToggle.click();
  check('密钥切换：显示后 type=text', elements.apiKey.type === 'text', elements.apiKey.type);
  check('密钥切换：值不变', elements.apiKey.value === before, elements.apiKey.value);
  check('密钥切换：按钮文案为「隐藏」', elements.apiKeyToggle.textContent === '隐藏', elements.apiKeyToggle.textContent);
  check('密钥切换：aria-pressed=true', elements.apiKeyToggle.getAttribute('aria-pressed') === 'true', elements.apiKeyToggle.getAttribute('aria-pressed'));
  elements.apiKeyToggle.click();
  check('密钥切换：再切回 password', elements.apiKey.type === 'password', elements.apiKey.type);
  check('密钥切换：值仍不变', elements.apiKey.value === before, elements.apiKey.value);
}

// ==================== 场景 5：保存校验错误渲染（R2） ====================
{
  const { elements, state } = await setup({ page: PAGE_CONFIG });
  elements.open.click();
  await settle();
  state.validateImpl = () => ({
    ok: false,
    errors: { baseUrl: '端点必须以 http:// 或 https:// 开头', timeoutMs: '单次超时必须是 1000~600000 的整数' },
    normalized: {},
    corrections: [],
  });
  elements.save.click();
  await settle();
  check('校验错误：端点错误行显示', elements.endpointError.hidden === false && elements.endpointError.textContent.includes('http'), elements.endpointError.textContent);
  check('校验错误：超时错误行显示', elements.timeoutError.hidden === false && elements.timeoutError.textContent.includes('整数'), elements.timeoutError.textContent);
  check('校验错误：无误字段错误行保持隐藏', elements.modelError.hidden === true, String(elements.modelError.hidden));
  check('校验错误：aria-invalid=true', elements.endpoint.getAttribute('aria-invalid') === 'true', elements.endpoint.getAttribute('aria-invalid'));
  check('校验错误：焦点落到第一个错误字段', elements.endpoint.focusedCount > 0, String(elements.endpoint.focusedCount));
  check('校验错误：提示区说明校验未通过', elements.notice.textContent.includes('校验未通过'), elements.notice.textContent);
  check('校验错误：不写存储（savePageConfig 未调用）', state.savedDrafts.length === 0, String(state.savedDrafts.length));
  check('校验错误：来源徽标不变', elements.source.textContent.includes('页面配置'), elements.source.textContent);
}

// ==================== 场景 6：保存成功（来源立即变页面配置、提示含模型名与端点纠正） ====================
{
  const { elements, state } = await setup({ file: FILE_CONFIG });
  state.validateImpl = () => ({
    ok: true,
    errors: {},
    normalized: { ...FILE_CONFIG, baseUrl: 'https://api.example.com/v1', model: 'new-model' },
    corrections: ['已自动去除端点末尾的 /chat/completions'],
  });
  elements.open.click();
  await settle();
  // 用户把端点误填成带接口后缀的地址
  elements.endpoint.value = 'https://api.example.com/v1/chat/completions';
  elements.save.click();
  await settle();
  check('保存成功：来源徽标立即变页面配置', elements.source.textContent.includes('页面配置'), elements.source.textContent);
  check('保存成功：data-source=page', elements.source.getAttribute('data-source') === 'page', elements.source.getAttribute('data-source'));
  check('保存成功：提示含生效模型名', elements.notice.textContent.includes('已保存并生效') && elements.notice.textContent.includes('new-model'), elements.notice.textContent);
  check('保存成功：提示含端点自动纠正', elements.notice.textContent.includes('端点已自动纠正') && elements.notice.textContent.includes('/chat/completions'), elements.notice.textContent);
  check('保存成功：端点输入框已回填纠正值', elements.endpoint.value === 'https://api.example.com/v1', elements.endpoint.value);
  check('保存成功：恢复默认按钮出现', elements.restore.hidden === false, String(elements.restore.hidden));
  check('保存成功：未配置引导条隐藏', elements.required.hidden === true, String(elements.required.hidden));
  check('保存成功：写入草稿为归一化值', state.savedDrafts[0]?.baseUrl === 'https://api.example.com/v1', JSON.stringify(state.savedDrafts[0]));
  check('保存成功：错误行已清空', elements.endpointError.hidden === true, String(elements.endpointError.hidden));
}

// ==================== 场景 7：轮次进行中保存（R4：提示从下一轮生效、不打断当前轮） ====================
{
  const { elements, state } = await setup({ file: FILE_CONFIG, isBusy: () => true });
  state.validateImpl = () => ({ ok: true, errors: {}, normalized: { ...FILE_CONFIG, model: 'next-turn-model' }, corrections: [] });
  elements.open.click();
  await settle();
  elements.save.click();
  await settle();
  check('轮次中保存：成功提示正常', elements.notice.textContent.includes('已保存并生效'), elements.notice.textContent);
  check('轮次中保存：提示从下一轮生效', elements.notice.textContent.includes('下一轮生效'), elements.notice.textContent);
  check('轮次中保存：设置入口未被禁用', elements.open.disabled === false, String(elements.open.disabled));
  check('轮次中保存：保存按钮未被禁用', elements.save.disabled === false, String(elements.save.disabled));
}

// ==================== 场景 8：保存失败（存储不可用，R7：明确报错不静默） ====================
{
  const { elements, state } = await setup({ file: FILE_CONFIG });
  state.validateImpl = () => ({ ok: true, errors: {}, normalized: { ...FILE_CONFIG }, corrections: [] });
  state.saveImpl = () => ({ ok: false, code: 'storage-unavailable', message: '浏览器本地存储不可用（隐私模式或配额已满）' });
  elements.open.click();
  await settle();
  elements.save.click();
  await settle();
  check('保存失败：提示明确原因', elements.notice.textContent.includes('保存失败') && elements.notice.textContent.includes('存储不可用'), elements.notice.textContent);
  check('保存失败：提示刷新会丢失', elements.notice.textContent.includes('配置未保存，刷新后会丢失'), elements.notice.textContent);
  check('保存失败：不出现成功文案', !elements.notice.textContent.includes('已保存并生效'), elements.notice.textContent);
  check('保存失败：来源仍为文件配置', elements.source.textContent.includes('文件配置'), elements.source.textContent);
  check('保存失败：测试连接仍可用', elements.test.disabled === false, String(elements.test.disabled));
}

// ==================== 场景 9：保存失败（核心模块返回字段错误，不静默丢非法值） ====================
{
  const { elements, state } = await setup({ file: FILE_CONFIG });
  state.validateImpl = () => ({ ok: true, errors: {}, normalized: { ...FILE_CONFIG }, corrections: [] });
  state.saveImpl = () => ({ ok: false, code: 'validation', errors: { model: '模型名不合法' }, message: '校验未通过' });
  elements.open.click();
  await settle();
  elements.save.click();
  await settle();
  check('保存字段错误：错误行渲染', elements.modelError.hidden === false && elements.modelError.textContent.includes('模型名不合法'), elements.modelError.textContent);
  check('保存字段错误：提示失败原因', elements.notice.textContent.includes('保存失败'), elements.notice.textContent);
}

// ==================== 场景 10：恢复默认二次确认与回落（R6） ====================
{
  const { elements, state } = await setup({ page: PAGE_CONFIG, file: FILE_CONFIG });
  elements.open.click();
  await settle();
  check('恢复默认：页面配置时按钮可见', elements.restore.hidden === false, String(elements.restore.hidden));
  elements.restore.click();
  check('恢复默认：点按钮出现行内二次确认', elements.restoreConfirm.hidden === false, String(elements.restoreConfirm.hidden));
  check('恢复默认：确认文案含删除/回落说明', elements.restoreConfirm.textContent.includes('将删除浏览器中的配置，回落到文件配置'), elements.restoreConfirm.textContent);
  elements.restoreCancel.click();
  check('恢复默认：取消后确认区收起', elements.restoreConfirm.hidden === true, String(elements.restoreConfirm.hidden));
  check('恢复默认：取消不清理配置', state.clearCalls === 0, String(state.clearCalls));
  elements.restore.click();
  elements.restoreOk.click();
  await settle();
  check('恢复默认：确实调用清理', state.clearCalls === 1, String(state.clearCalls));
  check('恢复默认：来源回落文件配置', elements.source.textContent.includes('文件配置'), elements.source.textContent);
  check('恢复默认：data-source=file', elements.source.getAttribute('data-source') === 'file', elements.source.getAttribute('data-source'));
  check('恢复默认：恢复按钮再次隐藏', elements.restore.hidden === true, String(elements.restore.hidden));
  check('恢复默认：明确反馈结果', elements.notice.textContent.includes('已恢复默认') && elements.notice.textContent.includes('文件配置'), elements.notice.textContent);
  check('恢复默认：字段回显文件配置', elements.endpoint.value === FILE_CONFIG.baseUrl, elements.endpoint.value);
  check('恢复默认：确认区已收起', elements.restoreConfirm.hidden === true, String(elements.restoreConfirm.hidden));
}

// ==================== 场景 11：恢复默认后无文件配置 → 未配置 + 引导条显示 ====================
{
  const { elements } = await setup({ page: PAGE_CONFIG });
  elements.open.click();
  await settle();
  elements.restore.click();
  elements.restoreOk.click();
  await settle();
  check('恢复后无文件配置：来源=未配置', elements.source.textContent.includes('未配置'), elements.source.textContent);
  check('恢复后无文件配置：引导条立即显示', elements.required.hidden === false, String(elements.required.hidden));
  check('恢复后无文件配置：提示说明暂无文件配置', elements.notice.textContent.includes('暂无文件配置'), elements.notice.textContent);
  check('恢复后无文件配置：回显默认超时', elements.timeoutMs.value === '180000', elements.timeoutMs.value);
}

// ==================== 场景 12：恢复默认失败（不静默、来源不变） ====================
{
  const { elements, state } = await setup({ page: PAGE_CONFIG, file: FILE_CONFIG });
  state.clearImpl = () => ({ ok: false, code: 'storage-unavailable', message: '浏览器本地存储不可用' });
  elements.open.click();
  await settle();
  elements.restore.click();
  elements.restoreOk.click();
  await settle();
  check('恢复失败：提示失败原因', elements.notice.textContent.includes('恢复默认失败') && elements.notice.textContent.includes('存储不可用'), elements.notice.textContent);
  check('恢复失败：来源仍为页面配置', elements.source.textContent.includes('页面配置'), elements.source.textContent);
}

// ==================== 场景 13：测试连接成功（显示响应模型与耗时，R5） ====================
{
  const { elements, state } = await setup({ page: PAGE_CONFIG });
  state.testImpl = () => ({ ok: true, model: 'response-model-x', durationMs: 1234.4, httpStatus: 200, requestId: 'req-1' });
  elements.open.click();
  await settle();
  elements.test.click();
  await settle();
  check('测试成功：结果区显示', elements.testResult.hidden === false, String(elements.testResult.hidden));
  check('测试成功：含响应模型', elements.testResult.textContent.includes('response-model-x'), elements.testResult.textContent);
  check('测试成功：含耗时', elements.testResult.textContent.includes('耗时 1234 ms'), elements.testResult.textContent);
  check('测试成功：含 HTTP 状态', elements.testResult.textContent.includes('HTTP 200'), elements.testResult.textContent);
  check('测试成功：结果区 is-ok', elements.testResult.classList.contains('is-ok'), elements.testResult.className);
  check('测试成功：按钮恢复可用', elements.test.disabled === false && elements.test.textContent === '测试连接', `${elements.test.disabled}/${elements.test.textContent}`);
  check('测试成功：使用当前填写内容（不必先保存）', state.testDrafts[0]?.baseUrl === PAGE_CONFIG.baseUrl, JSON.stringify(state.testDrafts[0]));
  check('测试成功：不写存储配置', state.savedDrafts.length === 0, String(state.savedDrafts.length));
}

// ==================== 场景 14：测试连接成功但响应无模型名（不编造） ====================
{
  const { elements, state } = await setup({ page: PAGE_CONFIG });
  state.testImpl = () => ({ ok: true, model: null, durationMs: 88, httpStatus: 200, requestId: null });
  elements.open.click();
  await settle();
  elements.test.click();
  await settle();
  check('无模型名：显示「响应未返回模型名」', elements.testResult.textContent.includes('响应未返回模型名'), elements.testResult.textContent);
  check('无模型名：不编造模型', !elements.testResult.textContent.includes('null'), elements.testResult.textContent);
}

// ==================== 场景 15：测试连接失败（分类可读原因） ====================
{
  const { elements, state } = await setup({ page: PAGE_CONFIG });
  state.testImpl = () => ({
    ok: false, kind: 'auth', message: '鉴权失败（密钥无效或无权限）', suggestion: '检查密钥是否正确',
    httpStatus: 401, durationMs: 88, detail: null,
  });
  elements.open.click();
  await settle();
  elements.test.click();
  await settle();
  check('测试失败：结果区显示', elements.testResult.hidden === false, String(elements.testResult.hidden));
  check('测试失败：鉴权分类文案', elements.testResult.textContent.includes('鉴权失败'), elements.testResult.textContent);
  check('测试失败：含可读原因', elements.testResult.textContent.includes('密钥无效'), elements.testResult.textContent);
  check('测试失败：含建议', elements.testResult.textContent.includes('检查密钥'), elements.testResult.textContent);
  check('测试失败：结果区 is-error', elements.testResult.classList.contains('is-error'), elements.testResult.className);
  check('测试失败：按钮恢复可用', elements.test.disabled === false, String(elements.test.disabled));
  check('测试失败：不误报成功', !elements.testResult.textContent.includes('连接成功'), elements.testResult.textContent);
}

// ==================== 场景 16：测试连接本地校验未过（不发请求的提示） ====================
{
  const { elements, state } = await setup({ page: PAGE_CONFIG });
  state.testImpl = () => ({
    ok: false, kind: 'validation', message: '端点：端点必填', suggestion: null, httpStatus: null, durationMs: 0,
    errors: { baseUrl: '端点必填' },
  });
  elements.open.click();
  await settle();
  elements.test.click();
  await settle();
  check('测试校验未过：分类文案', elements.testResult.textContent.includes('本地校验未过（未发请求）'), elements.testResult.textContent);
  check('测试校验未过：附字段原因', elements.testResult.textContent.includes('端点必填'), elements.testResult.textContent);
}

// ==================== 场景 17：配置损坏提示（R7：忽略并回落，不白屏） ====================
{
  const { elements, state } = await setup({ file: FILE_CONFIG });
  state.pageStatus = 'corrupt';
  state.pageMessage = '配置已损坏，已忽略（可重新保存）';
  elements.open.click();
  await settle();
  check('损坏配置：来源回落文件配置', elements.source.textContent.includes('文件配置'), elements.source.textContent);
  check('损坏配置：提示已忽略', elements.notice.hidden === false && elements.notice.textContent.includes('配置已损坏'), elements.notice.textContent);
}

// ==================== 场景 17b：损坏配置在初始化时浮出面板 toast，且同一损坏只提示一次（R7） ====================
{
  globalTimerCalls = 0;
  const dom = createFakeDocument();
  const elements = buildSkeleton(dom.doc);
  const fake = createFakeConfigApi({ file: FILE_CONFIG });
  fake.state.pageStatus = 'corrupt';
  fake.state.pageMessage = '页面配置已损坏，已忽略（可重新保存）：不是有效 JSON';
  const panel = createLlmConfigPanel({
    panel: elements.panel,
    document: dom.doc,
    configApi: fake.api,
    timers: makeFakeTimers(),
  });
  await settle();
  const toast = elements.panel.children.find((child) => String(child.className).includes('agent-toast'));
  check('损坏提示：初始化即浮出面板 toast', Boolean(toast) && toast.textContent.includes('页面配置已损坏'), toast ? toast.textContent : '未找到 toast');
  const callsAfterInit = globalTimerCalls;
  await panel.refresh({ reason: 'config-change' });
  check('损坏提示：同一损坏不重复浮出（不刷屏）', globalTimerCalls === callsAfterInit, `${callsAfterInit}->${globalTimerCalls}`);
  panel.dispose();
}

// ==================== 场景 18：关闭设置界面（回对话；滚动位置不变，R1） ====================
{
  const { elements, panel } = await setup({ page: PAGE_CONFIG });
  elements.messages.scrollTop = 64;
  elements.open.click();
  await settle();
  // 模拟 display:none 导致滚动位置丢失
  elements.messages.scrollTop = 0;
  elements.close.click();
  check('关闭设置：设置视图隐藏', elements.config.hidden === true, String(elements.config.hidden));
  check('关闭设置：面板移除 is-config-open', !elements.panel.classList.contains('is-config-open'), elements.panel.className);
  check('关闭设置：消息区滚动位置恢复', elements.messages.scrollTop === 64, String(elements.messages.scrollTop));
  check('关闭设置：设置入口取消高亮', !elements.open.classList.contains('is-active'), elements.open.className);
  check('关闭设置：再次打开可回显', panel.open !== undefined, typeof panel.open);
}

// ==================== 场景 19：flash 高亮（发送被未配置闸门拦下时） ====================
{
  const { elements, panel, timers } = await setup();
  panel.flash();
  check('flash：引导条高亮', elements.required.classList.contains('is-flash'), elements.required.className);
  check('flash：设置入口高亮', elements.open.classList.contains('is-flash'), elements.open.className);
  check('flash：注册一次计时', timers.size === 1, String(timers.size));
  timers.flush();
  check('flash：到点取消高亮', !elements.required.classList.contains('is-flash') && !elements.open.classList.contains('is-flash'), `${elements.required.className}/${elements.open.className}`);
}

// ==================== 场景 20：配置变更订阅（保存/恢复后外部刷新） ====================
{
  const { elements, state, notify } = await setup();
  check('订阅：面板创建时已订阅', state.listeners.size === 1, String(state.listeners.size));
  state.page = PAGE_CONFIG;
  notify({ action: 'save', source: 'page', config: PAGE_CONFIG });
  await settle();
  check('订阅：外部保存后来源徽标刷新', elements.source.textContent.includes('页面配置'), elements.source.textContent);
  check('订阅：外部保存后引导条隐藏', elements.required.hidden === true, String(elements.required.hidden));
}

// ==================== 场景 21：dispose 解绑与退订 ====================
{
  const { elements, state, panel } = await setup();
  panel.dispose();
  check('dispose：取消配置订阅', state.listeners.size === 0, String(state.listeners.size));
  elements.open.click();
  await settle();
  check('dispose：事件已解绑（点击不再打开）', elements.config.hidden === true, String(elements.config.hidden));
}

// ==================== 场景 22：DOM 骨架缺失直接报错（不静默失败） ====================
{
  const dom = createFakeDocument();
  const panelEl = dom.doc.register('agent-panel', 'section');
  let threw = null;
  try {
    createLlmConfigPanel({ panel: panelEl, document: dom.doc, configApi: createFakeConfigApi().api });
  } catch (error) {
    threw = error;
  }
  check('缺 DOM：抛错并指出缺失 id', threw instanceof Error && threw.message.includes('#agent-config-open'), threw ? threw.message : '未抛错');
}

// ==================== 场景 23：获取模型成功（追加需求 2026-11-10：填充下拉与占位） ====================
{
  const { elements, state } = await setup({ page: PAGE_CONFIG });
  elements.open.click();
  await settle();
  elements.modelsFetch.click();
  await settle();
  check('获取模型：用当前表单草稿调用 fetchModels', state.fetchDrafts.length === 1
    && state.fetchDrafts[0].baseUrl === PAGE_CONFIG.baseUrl
    && state.fetchDrafts[0].apiKey === PAGE_CONFIG.apiKey, JSON.stringify(state.fetchDrafts[0] ?? null));
  check('获取模型：结果区提示数量', elements.modelsResult.hidden === false
    && elements.modelsResult.textContent.includes('已获取 2 个模型，选择后自动填入模型'), elements.modelsResult.textContent);
  check('获取模型：下拉显示', elements.modelsSelect.hidden === false, String(elements.modelsSelect.hidden));
  check('获取模型：下拉项数=占位+2', elements.modelsSelect.children.length === 3, String(elements.modelsSelect.children.length));
  check('获取模型：首项占位文案', elements.modelsSelect.children[0].textContent === '选择模型（共 2 个）', elements.modelsSelect.children[0]?.textContent);
  check('获取模型：选项值为模型名', elements.modelsSelect.children[1].value === 'stub-model-a'
    && elements.modelsSelect.children[2].value === 'stub-model-b', `${elements.modelsSelect.children[1]?.value}/${elements.modelsSelect.children[2]?.value}`);
  check('获取模型：按钮恢复可用且文案复位', elements.modelsFetch.disabled === false
    && elements.modelsFetch.textContent === '获取模型', `${elements.modelsFetch.disabled}/${elements.modelsFetch.textContent}`);
  check('获取模型：不自动保存配置', state.savedDrafts.length === 0, String(state.savedDrafts.length));
}

// ==================== 场景 24：选择模型回填（不自动保存） ====================
{
  const { elements, state } = await setup({ page: PAGE_CONFIG });
  elements.open.click();
  await settle();
  elements.modelsFetch.click();
  await settle();
  elements.modelsSelect.value = 'stub-model-b';
  elements.modelsSelect.dispatch('change');
  check('选择模型：回填模型输入框', elements.model.value === 'stub-model-b', elements.model.value);
  check('选择模型：结果提示保存后生效', elements.modelsResult.textContent.includes('已选择模型 stub-model-b（保存后生效）'), elements.modelsResult.textContent);
  check('选择模型：不自动保存配置', state.savedDrafts.length === 0, String(state.savedDrafts.length));
  // 选占位项（空值）不改模型
  elements.modelsSelect.value = '';
  elements.modelsSelect.dispatch('change');
  check('选择模型：选占位项不改模型值', elements.model.value === 'stub-model-b', elements.model.value);
}

// ==================== 场景 25：获取到 0 个模型（明确文案） ====================
{
  const { elements, state } = await setup({ page: PAGE_CONFIG });
  state.fetchModelsImpl = () => ({ ok: true, models: [], count: 0, durationMs: 10, httpStatus: 200 });
  elements.open.click();
  await settle();
  elements.modelsFetch.click();
  await settle();
  check('0 个模型：结果区明确说明', elements.modelsResult.textContent.includes('端点返回了 0 个模型'), elements.modelsResult.textContent);
  check('0 个模型：下拉保持隐藏', elements.modelsSelect.hidden === true, String(elements.modelsSelect.hidden));
  check('0 个模型：不报成功数量', !elements.modelsResult.textContent.includes('已获取'), elements.modelsResult.textContent);
}

// ==================== 场景 26：获取模型失败（复用分类文案，auth 提示核对密钥） ====================
{
  const { elements, state } = await setup({ page: PAGE_CONFIG });
  state.fetchModelsImpl = () => ({
    ok: false, kind: 'auth', message: '鉴权失败（密钥无效或无权限）', suggestion: null, httpStatus: 401, durationMs: 20,
  });
  elements.open.click();
  await settle();
  elements.modelsFetch.click();
  await settle();
  check('获取失败：分类文案', elements.modelsResult.textContent.includes('获取模型失败（鉴权失败）'), elements.modelsResult.textContent);
  check('获取失败：含核心原因', elements.modelsResult.textContent.includes('密钥无效'), elements.modelsResult.textContent);
  check('获取失败：auth 提示核对密钥', elements.modelsResult.textContent.includes('请核对密钥是否正确'), elements.modelsResult.textContent);
  check('获取失败：结果区 is-error', elements.modelsResult.classList.contains('is-error'), elements.modelsResult.className);
  check('获取失败：下拉隐藏', elements.modelsSelect.hidden === true, String(elements.modelsSelect.hidden));
  check('获取失败：按钮恢复可用', elements.modelsFetch.disabled === false, String(elements.modelsFetch.disabled));
  check('获取失败：不自动保存', state.savedDrafts.length === 0, String(state.savedDrafts.length));
}

// ==================== 场景 27：缺端点 → 标红端点且不发请求 ====================
{
  const { elements, state } = await setup({ page: PAGE_CONFIG });
  elements.open.click();
  await settle();
  elements.endpoint.value = '';
  elements.modelsFetch.click();
  await settle();
  check('缺端点：不发请求', state.fetchDrafts.length === 0, String(state.fetchDrafts.length));
  check('缺端点：端点错误行显示', elements.endpointError.hidden === false
    && elements.endpointError.textContent.includes('端点不能为空'), elements.endpointError.textContent);
  check('缺端点：端点字段聚焦', elements.endpoint.focusedCount > 0, String(elements.endpoint.focusedCount));
  check('缺端点：密钥错误行不显示', elements.apiKeyError.hidden === true, String(elements.apiKeyError.hidden));
}

// ==================== 场景 28：端点非法 → 标红端点且不发请求 ====================
{
  const { elements, state } = await setup({ page: PAGE_CONFIG });
  elements.open.click();
  await settle();
  elements.endpoint.value = 'ftp://example.com';
  elements.modelsFetch.click();
  await settle();
  check('非法端点：不发请求', state.fetchDrafts.length === 0, String(state.fetchDrafts.length));
  check('非法端点：端点错误行显示', elements.endpointError.hidden === false
    && elements.endpointError.textContent.includes('http'), elements.endpointError.textContent);
  check('非法端点：端点字段聚焦', elements.endpoint.focusedCount > 0, String(elements.endpoint.focusedCount));
}

// ==================== 场景 29：密钥为空 → 标红密钥且不发请求（用户 2026-11-10 修正） ====================
{
  const { elements, state } = await setup({ page: PAGE_CONFIG });
  elements.open.click();
  await settle();
  elements.apiKey.value = '   ';
  elements.modelsFetch.click();
  await settle();
  check('空密钥：不发请求', state.fetchDrafts.length === 0, String(state.fetchDrafts.length));
  check('空密钥：密钥错误行提示需先填密钥', elements.apiKeyError.hidden === false
    && elements.apiKeyError.textContent.includes('获取模型需要先填写密钥'), elements.apiKeyError.textContent);
  check('空密钥：密钥字段聚焦', elements.apiKey.focusedCount > 0, String(elements.apiKey.focusedCount));
  check('空密钥：端点错误行不显示', elements.endpointError.hidden === true, String(elements.endpointError.hidden));
}

// ==================== 场景 30：请求进行中按钮禁用并显示「获取中…」 ====================
{
  const { elements, state } = await setup({ page: PAGE_CONFIG });
  let resolveFetch = null;
  state.fetchModelsImpl = () => new Promise((resolve) => { resolveFetch = resolve; });
  elements.open.click();
  await settle();
  elements.modelsFetch.click();
  await settle();
  check('获取中：按钮禁用', elements.modelsFetch.disabled === true, String(elements.modelsFetch.disabled));
  check('获取中：按钮文案', elements.modelsFetch.textContent === '获取中…', elements.modelsFetch.textContent);
  check('获取中：结果区提示进行中', elements.modelsResult.textContent.includes('正在获取模型'), elements.modelsResult.textContent);
  resolveFetch({ ok: true, models: ['only-model'], count: 1, durationMs: 5, httpStatus: 200 });
  await settle();
  check('获取完成：按钮恢复', elements.modelsFetch.disabled === false && elements.modelsFetch.textContent === '获取模型', `${elements.modelsFetch.disabled}/${elements.modelsFetch.textContent}`);
  check('获取完成：下拉填充 1 个模型', elements.modelsSelect.children.length === 2
    && elements.modelsSelect.children[1].value === 'only-model', String(elements.modelsSelect.children.length));
}

// ==================== 场景 31：打开设置/保存/恢复成功重置模型列表 ====================
{
  const { elements, state } = await setup({ page: PAGE_CONFIG, file: FILE_CONFIG });
  elements.open.click();
  await settle();
  elements.modelsFetch.click();
  await settle();
  check('重置前置：列表已显示', elements.modelsSelect.hidden === false, String(elements.modelsSelect.hidden));
  elements.close.click();
  elements.open.click();
  await settle();
  check('重新打开设置：下拉重置隐藏', elements.modelsSelect.hidden === true, String(elements.modelsSelect.hidden));
  check('重新打开设置：结果区重置隐藏', elements.modelsResult.hidden === true, String(elements.modelsResult.hidden));
  check('重新打开设置：旧选项清空', elements.modelsSelect.children.length === 0, String(elements.modelsSelect.children.length));

  // 保存成功后重置
  elements.modelsFetch.click();
  await settle();
  state.validateImpl = () => ({ ok: true, errors: {}, normalized: { ...PAGE_CONFIG, model: 'saved-model' }, corrections: [] });
  elements.save.click();
  await settle();
  check('保存成功：下拉重置隐藏', elements.modelsSelect.hidden === true, String(elements.modelsSelect.hidden));
  check('保存成功：结果区重置隐藏', elements.modelsResult.hidden === true, String(elements.modelsResult.hidden));

  // 恢复默认成功后重置
  elements.modelsFetch.click();
  await settle();
  check('恢复前置：列表重新显示', elements.modelsSelect.hidden === false, String(elements.modelsSelect.hidden));
  elements.restore.click();
  elements.restoreOk.click();
  await settle();
  check('恢复默认成功：下拉重置隐藏', elements.modelsSelect.hidden === true, String(elements.modelsSelect.hidden));
  check('恢复默认成功：结果区重置隐藏', elements.modelsResult.hidden === true, String(elements.modelsResult.hidden));
}

console.log(`\n[summary] ${checks - failures}/${checks} 项通过，失败 ${failures} 项`);
if (failures > 0) {
  process.exitCode = 1;
}
