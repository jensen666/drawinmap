/**
 * LLM 配置核心单测（Node 直接运行、零依赖；假 localStorage + fetch 桩，不联网）。
 *
 * 覆盖方案 2026-11-09 §6.1：
 * - 端点归一化/自动纠正/非法协议、带查询参数与特殊字符端点；
 * - 五个字段校验与边界（空/全空格/小数/负数/0/超范围/整数字符串）、默认值；
 * - readPageConfig 的 none/ok/corrupt（非法 JSON、版本不符、字段非法、存储读取失败）；
 * - 保存/恢复/订阅通知/损坏通知去重/存储异常（Quota/Security/其它/无存储）；
 * - 生效优先级 page > file > none（globalThis.__AGENT_LLM_CONFIG__ 注入 + 假 localStorage）；
 * - testConnection 成功与全部失败分类（validation/network/timeout/auth/not-found/rate-limit/server/incompatible/unknown）；
 * - 日志事件与「日志/错误/建议文本中密钥 0 命中」；
 * - 轮次快照语义（快照期内保存配置不变、end 后下一次调用用新配置、未配置快照）。
 *
 * 运行：node test/llm-config.mjs
 */

import { getEntries, initLogging } from '../web/src/log/index.js';

let failures = 0;
let checks = 0;

/**
 * 断言工具：记录并通过/失败计数（失败时 process.exitCode=1）。
 *
 * @param {string} label 断言名
 * @param {boolean} condition 是否通过
 * @param {string} [detail] 失败详情
 */
function check(label, condition, detail = '') {
  checks += 1;
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`[check] ${label} -> ${ok ? 'PASS' : `FAIL ${detail}`}`);
}

/**
 * 构造假 localStorage：支持读取/写入/删除与异常注入。
 *
 * @returns {object} 假存储
 */
function createFakeStorage() {
  const data = new Map();
  const failures = { get: null, set: null, remove: null };
  return {
    data,
    failures,
    getItem(key) {
      if (failures.get) throw failures.get;
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      if (failures.set) throw failures.set;
      data.set(key, String(value));
    },
    removeItem(key) {
      if (failures.remove) throw failures.remove;
      data.delete(key);
    },
    /** 清空数据与异常注入 */
    reset() {
      data.clear();
      failures.get = null;
      failures.set = null;
      failures.remove = null;
    },
  };
}

/**
 * 构造带 name 的存储异常（模拟浏览器 DOMException）。
 *
 * @param {string} name 异常名（QuotaExceededError/SecurityError）
 * @param {string} message 异常信息
 * @returns {Error} 异常
 */
function makeStorageError(name, message) {
  const error = new Error(message);
  error.name = name;
  return error;
}

/** 测试用密钥（只出现在测试假存储/假响应里，用于验证日志/错误 0 命中） */
const SECRET = 'test-placeholder-key-unit';
const FILE_SECRET = 'test-placeholder-key-file';
const SNAPSHOT_FILE_SECRET = 'test-placeholder-key-snap';

// 先布置全局环境再动态 import 模块：
// - 属性存在但值为 undefined = 模拟"干净克隆没有 agent-config.js"（同时避免读到本机真实配置）；
// - globalThis.localStorage 供 llm.js 内部 resolveEffectiveConfig() 使用。
const storage = createFakeStorage();
globalThis.localStorage = storage;
globalThis.__AGENT_LLM_CONFIG__ = undefined;

const cfg = await import('../web/src/agent/llm-config.js');
const llm = await import('../web/src/agent/llm.js');

/** 日志系统：mem-only，保留全部级别（后面断言事件与密钥 0 命中） */
initLogging({ server: false, storage: false, level: 'debug' });

const STORAGE_KEY = cfg.LLM_CONFIG_STORAGE_KEY;
/** 收集 testConnection 结果，最后统一做密钥 0 命中扫描 */
const testConnectionResults = [];
/** 收集 fetchModels 结果，最后统一做密钥 0 命中扫描 */
const fetchModelsResults = [];

/**
 * 读取最近一条指定事件的 agent/llm-config 日志（断言请求超时等日志字段用）。
 *
 * @param {string} event 事件名
 * @returns {object|null} 日志记录
 */
function latestConfigLog(event) {
  const records = getEntries({ level: 'debug', limit: 0, module: 'agent/llm-config' });
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (records[index].event === event) return records[index];
  }
  return null;
}

/**
 * 构造合法草稿（字段可覆盖）。
 *
 * @param {object} [overrides] 覆盖字段
 * @returns {object} 草稿
 */
function draft(overrides = {}) {
  return {
    baseUrl: 'https://api.test.local/v1',
    apiKey: SECRET,
    model: 'unit-model',
    timeoutMs: 180000,
    maxTokens: 32000,
    ...overrides,
  };
}

/* ========== 1. 常量、默认值、来源文案 ========== */

check('存储键固定为 drawinmap.llm-config.v1', STORAGE_KEY === 'drawinmap.llm-config.v1', STORAGE_KEY);
check('配置结构版本为 1', cfg.LLM_CONFIG_VERSION === 1, String(cfg.LLM_CONFIG_VERSION));
check(
  '默认值：超时 180000 / 最大输出 32000',
  cfg.LLM_CONFIG_DEFAULTS.timeoutMs === 180000 && cfg.LLM_CONFIG_DEFAULTS.maxTokens === 32000,
  JSON.stringify(cfg.LLM_CONFIG_DEFAULTS),
);
check(
  '合法区间：超时 1000~600000',
  cfg.LLM_CONFIG_LIMITS.timeoutMs.min === 1000 && cfg.LLM_CONFIG_LIMITS.timeoutMs.max === 600000,
  JSON.stringify(cfg.LLM_CONFIG_LIMITS.timeoutMs),
);
check(
  '合法区间：最大输出 256~64000',
  cfg.LLM_CONFIG_LIMITS.maxTokens.min === 256 && cfg.LLM_CONFIG_LIMITS.maxTokens.max === 64000,
  JSON.stringify(cfg.LLM_CONFIG_LIMITS.maxTokens),
);
check(
  '来源文案：页面配置/文件配置/未配置',
  cfg.sourceLabel('page') === '页面配置' &&
    cfg.sourceLabel('file') === '文件配置' &&
    cfg.sourceLabel('none') === '未配置' &&
    cfg.sourceLabel(null) === '未配置',
);

/* ========== 2. 端点归一化（§3.2） ========== */

const endpointValidCases = [
  ['https://a.com/v1', 'https://a.com/v1'],
  ['  https://a.com/v1  ', 'https://a.com/v1'],
  ['HTTPS://a.com/v1', 'https://a.com/v1'],
  ['https://a.com/v1/', 'https://a.com/v1'],
  ['https://a.com/v1/chat/completions', 'https://a.com/v1'],
  ['https://a.com/v1/chat/completions/', 'https://a.com/v1'],
  ['http://127.0.0.1:8080/v1', 'http://127.0.0.1:8080/v1'],
];
for (const [input, expected] of endpointValidCases) {
  const result = cfg.normalizeEndpointInput(input);
  check(`端点归一：${JSON.stringify(input)} → ${expected}`, result.ok && result.value === expected, JSON.stringify(result));
}
{
  const withSuffix = cfg.normalizeEndpointInput('https://a.com/v1/chat/completions');
  check(
    '端点纠正：误带 /chat/completions 返回 correction 文案',
    withSuffix.ok && typeof withSuffix.correction === 'string' && withSuffix.correction.includes('chat/completions'),
    JSON.stringify(withSuffix),
  );
  const trailing = cfg.normalizeEndpointInput('https://a.com/v1/');
  check('端点纠正：多余结尾 / 有 correction 文案', trailing.ok && Boolean(trailing.correction), JSON.stringify(trailing));
}
{
  const queryEndpoint = 'https://a.com/v1?x=1&city=%E5%B9%BF%E5%B7%9E&page=2';
  const result = cfg.normalizeEndpointInput(queryEndpoint);
  check('端点归一：查询参数/转义字符原样保留', result.ok && result.value === queryEndpoint, JSON.stringify(result));
  const rawChinese = 'https://a.com/v1?k=中文密钥&p=1';
  const chineseResult = cfg.normalizeEndpointInput(rawChinese);
  check('端点归一：查询参数含中文不破坏', chineseResult.ok && chineseResult.value === rawChinese, JSON.stringify(chineseResult));
  const suffixQuery = cfg.normalizeEndpointInput('https://a.com/v1/chat/completions?foo=1');
  check(
    '端点纠正：带查询参数时只去路径后缀',
    suffixQuery.ok && suffixQuery.value === 'https://a.com/v1?foo=1',
    JSON.stringify(suffixQuery),
  );
}
const endpointInvalidCases = [
  ['空串', ''],
  ['全空格', '   '],
  ['ftp 协议', 'ftp://a.com/v1'],
  ['javascript 协议', 'javascript:alert(1)'],
  ['file 协议', 'file:///tmp/x'],
  ['缺主机名', 'http://'],
  ['非字符串', 123],
  ['null', null],
  ['undefined', undefined],
];
for (const [name, input] of endpointInvalidCases) {
  const result = cfg.normalizeEndpointInput(input);
  check(
    `端点非法：${name} 被拦截并给中文原因`,
    result.ok === false && typeof result.error === 'string' && result.error.length > 0,
    JSON.stringify(result),
  );
}

/* ========== 3. 五字段校验与边界（§3.2） ========== */

{
  const valid = cfg.validateDraft({
    baseUrl: ' HTTPS://api.test.local/v1/chat/completions/ ',
    apiKey: `  ${SECRET}  `,
    model: ' deepseek-x ',
    timeoutMs: '180000',
    maxTokens: '32000',
  });
  check('草稿校验：合法输入 ok', valid.ok === true, JSON.stringify(valid.errors));
  check(
    '草稿校验：端点已纠正并去空格',
    valid.normalized.baseUrl === 'https://api.test.local/v1',
    valid.normalized.baseUrl,
  );
  check('草稿校验：密钥去首尾空格（保留特殊字符）', valid.normalized.apiKey === SECRET, valid.normalized.apiKey);
  check('草稿校验：模型去首尾空格', valid.normalized.model === 'deepseek-x', valid.normalized.model);
  check(
    '草稿校验：数字字符串归一为数字',
    valid.normalized.timeoutMs === 180000 && valid.normalized.maxTokens === 32000,
    JSON.stringify(valid.normalized),
  );
  check('草稿校验：返回 corrections 纠正说明', Array.isArray(valid.corrections) && valid.corrections.length > 0);
  check('草稿校验：errors 为空对象', Object.keys(valid.errors).length === 0, JSON.stringify(valid.errors));
}
{
  const alias = cfg.validateDraft({ endpoint: 'https://a.com/v1', apiKey: 'k', model: 'm', timeoutMs: 180000, maxTokens: 32000 });
  check('草稿校验：endpoint 别名兼容', alias.ok === true, JSON.stringify(alias.errors));
  const boundaries = [
    [1000, 256],
    ['1000', '256'],
    [600000, 64000],
    [180000, 32000],
  ];
  for (const [timeoutMs, maxTokens] of boundaries) {
    const result = cfg.validateDraft(draft({ timeoutMs, maxTokens }));
    check(`草稿校验：边界值 timeoutMs=${timeoutMs} maxTokens=${maxTokens} 通过`, result.ok === true, JSON.stringify(result.errors));
  }
}
{
  const empty = cfg.validateDraft({});
  check(
    '草稿校验：全空 → 五个字段全部报错（键名 baseUrl/apiKey/model/timeoutMs/maxTokens）',
    Object.keys(empty.errors).sort().join(',') === 'apiKey,baseUrl,maxTokens,model,timeoutMs',
    JSON.stringify(empty.errors),
  );
  check(
    '草稿校验：全空且 normalized 保留字段形状（非法字段为 null）',
    empty.normalized &&
      empty.normalized.baseUrl === null &&
      empty.normalized.apiKey === null &&
      empty.normalized.model === null &&
      empty.normalized.timeoutMs === null &&
      empty.normalized.maxTokens === null,
    JSON.stringify(empty.normalized),
  );
}
{
  const spaces = cfg.validateDraft(draft({ apiKey: '   ', model: '  ' }));
  check('草稿校验：密钥/模型全空格被拦截', Boolean(spaces.errors.apiKey && spaces.errors.model), JSON.stringify(spaces.errors));
  const badEndpoint = cfg.validateDraft(draft({ baseUrl: 'javascript:alert(1)' }));
  check('草稿校验：非法协议端点被拦截', Boolean(badEndpoint.errors.baseUrl), JSON.stringify(badEndpoint.errors));
}
{
  const invalidNumbers = [
    ['timeoutMs=999（低于下限）', { timeoutMs: 999 }, 'timeoutMs'],
    ['timeoutMs=600001（高于上限）', { timeoutMs: 600001 }, 'timeoutMs'],
    ['timeoutMs=1.5（小数）', { timeoutMs: 1.5 }, 'timeoutMs'],
    ['timeoutMs="1.5"（小数字符串）', { timeoutMs: '1.5' }, 'timeoutMs'],
    ['timeoutMs="abc"（非数字）', { timeoutMs: 'abc' }, 'timeoutMs'],
    ['timeoutMs=0', { timeoutMs: 0 }, 'timeoutMs'],
    ['timeoutMs=-1（负数）', { timeoutMs: -1 }, 'timeoutMs'],
    ['maxTokens=255（低于下限）', { maxTokens: 255 }, 'maxTokens'],
    ['maxTokens=64001（高于上限）', { maxTokens: 64001 }, 'maxTokens'],
    ['maxTokens=1.5（小数）', { maxTokens: 1.5 }, 'maxTokens'],
    ['maxTokens=0', { maxTokens: 0 }, 'maxTokens'],
    ['maxTokens=-10（负数）', { maxTokens: -10 }, 'maxTokens'],
  ];
  for (const [name, overrides, field] of invalidNumbers) {
    const result = cfg.validateDraft(draft(overrides));
    check(
      `草稿校验：${name} 被拦截且落在 ${field}`,
      result.ok === false && typeof result.errors[field] === 'string' && result.errors[field].length > 0,
      JSON.stringify(result.errors),
    );
  }
}

/* ========== 4. readPageConfig：none/ok/corrupt（§3.1） ========== */

storage.reset();
check('读取页面配置：无存储值 → status=none', cfg.readPageConfig({ storage }).status === 'none');
{
  const stored = {
    version: 1,
    baseUrl: 'https://a.com/v1',
    apiKey: 'page-secret-key',
    model: 'page-model',
    timeoutMs: 180000,
    maxTokens: 32000,
    savedAt: 1700000000000,
  };
  storage.setItem(STORAGE_KEY, JSON.stringify(stored));
  const read = cfg.readPageConfig({ storage });
  check(
    '读取页面配置：合法 JSON → status=ok 且字段一致',
    read.status === 'ok' &&
      read.config.baseUrl === stored.baseUrl &&
      read.config.apiKey === stored.apiKey &&
      read.config.model === stored.model &&
      read.config.timeoutMs === stored.timeoutMs &&
      read.config.maxTokens === stored.maxTokens,
    JSON.stringify(read),
  );
  storage.setItem(STORAGE_KEY, JSON.stringify({ ...stored, timeoutMs: '600000' }));
  const readString = cfg.readPageConfig({ storage });
  check('读取页面配置：整数字符串归一为数字', readString.status === 'ok' && readString.config.timeoutMs === 600000, JSON.stringify(readString));
}
{
  storage.setItem(STORAGE_KEY, '{not-json');
  const corrupt = cfg.readPageConfig({ storage });
  check(
    '读取页面配置：非法 JSON → corrupt + 中文提示（配置已损坏/已忽略）',
    corrupt.status === 'corrupt' &&
      corrupt.config === null &&
      corrupt.message.includes('配置已损坏') &&
      corrupt.message.includes('已忽略') &&
      corrupt.reason === 'invalid',
    JSON.stringify(corrupt),
  );
  check('读取页面配置：损坏时不删除原始值（下次保存覆盖）', storage.getItem(STORAGE_KEY) === '{not-json');
}
{
  const baseStored = {
    version: 1,
    baseUrl: 'https://a.com/v1',
    apiKey: 'k',
    model: 'm',
    timeoutMs: 180000,
    maxTokens: 32000,
  };
  const corruptCases = [
    ['版本不兼容', { ...baseStored, version: 2 }],
    ['缺密钥', { ...baseStored, apiKey: undefined }],
    ['密钥全空格', { ...baseStored, apiKey: '   ' }],
    ['端点非法', { ...baseStored, baseUrl: 'ftp://a.com' }],
    ['超时为 0', { ...baseStored, timeoutMs: 0 }],
    ['最大输出为负', { ...baseStored, maxTokens: -1 }],
    ['结构不是对象', ['not', 'object']],
  ];
  for (const [name, value] of corruptCases) {
    storage.setItem(STORAGE_KEY, JSON.stringify(value));
    const result = cfg.readPageConfig({ storage });
    check(`读取页面配置：${name} → corrupt`, result.status === 'corrupt' && result.config === null, JSON.stringify(result));
  }
}
{
  const brokenStorage = {
    getItem() {
      throw makeStorageError('SecurityError', 'denied');
    },
  };
  const readBroken = cfg.readPageConfig({ storage: brokenStorage });
  check(
    '读取页面配置：存储读取抛错 → corrupt（不抛异常）',
    readBroken.status === 'corrupt' && readBroken.message.includes('本地存储'),
    JSON.stringify(readBroken),
  );
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = undefined;
  const noStorage = cfg.readPageConfig();
  check(
    '读取页面配置：浏览器无 localStorage → corrupt + reason=storage-unavailable',
    noStorage.status === 'corrupt' && noStorage.reason === 'storage-unavailable',
    JSON.stringify(noStorage),
  );
  globalThis.localStorage = previousStorage;
  storage.reset();
}

/* ========== 5. 保存 / 恢复 / 存储异常 / 订阅通知（§3.4） ========== */

{
  storage.reset();
  const saved = cfg.savePageConfig(
    {
      baseUrl: 'https://api.test.local/v1/chat/completions/',
      apiKey: `  ${SECRET}  `,
      model: ' unit-model ',
      timeoutMs: 180000,
      maxTokens: 32000,
    },
    { storage },
  );
  check('保存页面配置：成功返回 ok/source/config', saved.ok === true && saved.source === 'page' && saved.config.model === 'unit-model', JSON.stringify(saved));
  check('保存页面配置：previousSource=none（此前无页面配置）', saved.previousSource === 'none', saved.previousSource);
  check('保存页面配置：返回纠正说明', Array.isArray(saved.corrections) && saved.corrections.length > 0);
  const rawSaved = JSON.parse(storage.getItem(STORAGE_KEY));
  check(
    '保存页面配置：落盘 version=1 + savedAt + 归一字段',
    rawSaved.version === 1 &&
      typeof rawSaved.savedAt === 'number' &&
      rawSaved.baseUrl === 'https://api.test.local/v1' &&
      rawSaved.apiKey === SECRET &&
      rawSaved.model === 'unit-model',
    JSON.stringify({ ...rawSaved, apiKey: '***' }),
  );
  const reread = cfg.readPageConfig({ storage });
  check('保存页面配置：重新读取来源为页面配置且值一致', reread.status === 'ok' && reread.config.apiKey === SECRET);
}
{
  storage.reset();
  const invalidSave = cfg.savePageConfig({ baseUrl: 'javascript:x', apiKey: ' ', model: '', timeoutMs: 1, maxTokens: 1 }, { storage });
  check(
    '保存页面配置：校验失败 code=validation 且带字段错误',
    invalidSave.ok === false &&
      invalidSave.code === 'validation' &&
      Boolean(invalidSave.errors?.baseUrl && invalidSave.errors?.apiKey && invalidSave.errors?.model),
    JSON.stringify(invalidSave),
  );
  check('保存页面配置：校验失败不写存储', storage.getItem(STORAGE_KEY) === null);
}
{
  storage.reset();
  storage.failures.set = makeStorageError('QuotaExceededError', 'quota exceeded');
  const quota = cfg.savePageConfig(draft(), { storage });
  check(
    '保存页面配置：Quota → code=quota-exceeded 且不提示成功',
    quota.ok === false && quota.code === 'quota-exceeded' && quota.message.includes('空间已满'),
    JSON.stringify(quota),
  );
  storage.failures.set = makeStorageError('SecurityError', 'denied');
  const security = cfg.savePageConfig(draft(), { storage });
  check(
    '保存页面配置：SecurityError → code=storage-unavailable',
    security.ok === false && security.code === 'storage-unavailable',
    JSON.stringify(security),
  );
  storage.failures.set = makeStorageError('Error', `boom ${SECRET}`);
  const generic = cfg.savePageConfig(draft(), { storage });
  check(
    '保存页面配置：其它异常 → code=storage-error 且异常信息已脱敏',
    generic.ok === false && generic.code === 'storage-error' && !generic.message.includes(SECRET),
    JSON.stringify(generic),
  );
  storage.reset();
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = undefined;
  const noStorageSave = cfg.savePageConfig(draft());
  check(
    '保存页面配置：浏览器无 localStorage → code=storage-unavailable',
    noStorageSave.ok === false && noStorageSave.code === 'storage-unavailable',
    JSON.stringify(noStorageSave),
  );
  globalThis.localStorage = previousStorage;
}
{
  storage.reset();
  cfg.savePageConfig(draft({ model: 'model-to-clear' }), { storage });
  const beforeClear = await cfg.resolveEffectiveConfig({ storage });
  check('恢复默认前：生效来源为页面配置', beforeClear.source === 'page', beforeClear.source);
  const cleared = cfg.clearPageConfig({ storage });
  check(
    '恢复默认：成功删除页面配置且回落来源正确',
    cleared.ok === true && cleared.source === 'none' && cleared.previousSource === 'page',
    JSON.stringify(cleared),
  );
  check('恢复默认：存储键已删除', storage.getItem(STORAGE_KEY) === null);
  storage.failures.remove = makeStorageError('SecurityError', 'denied');
  cfg.savePageConfig(draft(), { storage });
  const clearFailed = cfg.clearPageConfig({ storage });
  check(
    '恢复默认：删除异常 → ok=false + 可读原因',
    clearFailed.ok === false && clearFailed.code === 'storage-unavailable',
    JSON.stringify(clearFailed),
  );
  storage.reset();
}
{
  // 订阅：保存/恢复成功通知；损坏只通知一次；取消订阅后不再触发
  const events = [];
  const unsubscribe = cfg.subscribeConfigChange((event) => events.push(event));
  check('订阅配置变更：返回取消订阅函数', typeof unsubscribe === 'function');
  storage.reset();
  globalThis.__AGENT_LLM_CONFIG__ = undefined;
  await cfg.resolveEffectiveConfig({ storage }); // 清掉可能残留的损坏签名
  cfg.savePageConfig(draft({ model: 'model-notify-1' }), { storage });
  check('订阅通知：保存成功触发 action=save', events.some((event) => event.action === 'save' && event.source === 'page'));
  // 修好后再损坏 → 第一次通知；连续解析不再重复通知
  storage.setItem(STORAGE_KEY, '{broken');
  const before = events.filter((event) => event.action === 'corrupt').length;
  await cfg.resolveEffectiveConfig({ storage });
  await cfg.resolveEffectiveConfig({ storage });
  const after = events.filter((event) => event.action === 'corrupt').length;
  check('订阅通知：损坏配置去重（连续解析只通知一次）', after - before === 1, `before=${before} after=${after}`);
  storage.reset();
  cfg.savePageConfig(draft({ model: 'model-notify-2' }), { storage });
  await cfg.resolveEffectiveConfig({ storage });
  const clearEvents = events.filter((event) => event.action === 'restore').length;
  cfg.clearPageConfig({ storage });
  check('订阅通知：恢复默认触发 action=restore', events.filter((event) => event.action === 'restore').length === clearEvents + 1);
  unsubscribe();
  const frozen = events.length;
  cfg.savePageConfig(draft(), { storage });
  check('订阅通知：取消订阅后不再触发', events.length === frozen);
  storage.reset();
}

/* ========== 6. 生效优先级 page > file > none（§3.3） ========== */

{
  storage.reset();
  globalThis.__AGENT_LLM_CONFIG__ = undefined;
  const none = await cfg.resolveEffectiveConfig({ storage });
  check(
    '生效优先级：页面/文件都没有 → source=none',
    none.source === 'none' && none.config === null && none.page.status === 'none' && none.file.status === 'missing',
    JSON.stringify({ source: none.source, page: none.page.status, file: none.file.status }),
  );

  const fileConfig = {
    baseUrl: 'https://file-a.test/v1',
    apiKey: FILE_SECRET,
    model: 'file-model-a',
    timeoutMs: 180000,
    maxTokens: 32000,
  };
  globalThis.__AGENT_LLM_CONFIG__ = fileConfig;
  const fileOnly = await cfg.resolveEffectiveConfig({ storage });
  check(
    '生效优先级：只有文件配置 → source=file',
    fileOnly.source === 'file' && fileOnly.config.model === 'file-model-a' && fileOnly.file.status === 'ok',
    JSON.stringify({ source: fileOnly.source, file: fileOnly.file.status }),
  );

  globalThis.__AGENT_LLM_CONFIG__ = {
    baseUrl: 'https://file-a.test/v1',
    apiKey: FILE_SECRET,
    model: 'file-model-defaults',
  };
  const fileDefaults = await cfg.resolveEffectiveConfig({ storage });
  check(
    '文件配置：缺省超时/最大输出 → 使用默认值 180000/32000',
    fileDefaults.file.status === 'ok' && fileDefaults.config.timeoutMs === 180000 && fileDefaults.config.maxTokens === 32000,
    JSON.stringify(fileDefaults.config),
  );

  globalThis.__AGENT_LLM_CONFIG__ = fileConfig;
  cfg.savePageConfig(draft({ model: 'page-model-b', baseUrl: 'https://page-b.test/v1' }), { storage });
  const pageWins = await cfg.resolveEffectiveConfig({ storage });
  check(
    '生效优先级：页面 + 文件都有 → 页面优先',
    pageWins.source === 'page' && pageWins.config.model === 'page-model-b' && pageWins.file.status === 'ok',
    JSON.stringify({ source: pageWins.source, model: pageWins.config?.model }),
  );

  storage.setItem(STORAGE_KEY, '{broken');
  const pageCorruptFallback = await cfg.resolveEffectiveConfig({ storage });
  check(
    '生效优先级：页面配置损坏 → 回落文件配置并带损坏提示',
    pageCorruptFallback.source === 'file' &&
      pageCorruptFallback.page.status === 'corrupt' &&
      pageCorruptFallback.page.message.includes('配置已损坏'),
    JSON.stringify({ source: pageCorruptFallback.source, page: pageCorruptFallback.page.status }),
  );

  storage.reset();
  globalThis.__AGENT_LLM_CONFIG__ = { baseUrl: 'ftp://bad', apiKey: '', model: '' };
  const fileCorrupt = await cfg.resolveEffectiveConfig({ storage });
  check(
    '生效优先级：文件配置损坏且无页面配置 → source=none + file.corrupt',
    fileCorrupt.source === 'none' && fileCorrupt.file.status === 'corrupt' && fileCorrupt.file.message.includes('文件配置'),
    JSON.stringify({ source: fileCorrupt.source, file: fileCorrupt.file.status }),
  );

  cfg.savePageConfig(draft({ model: 'page-model-c' }), { storage });
  const pageOverCorruptFile = await cfg.resolveEffectiveConfig({ storage });
  check(
    '生效优先级：页面配置合法 + 文件配置损坏 → 页面优先',
    pageOverCorruptFile.source === 'page' && pageOverCorruptFile.config.model === 'page-model-c',
    pageOverCorruptFile.source,
  );

  globalThis.__AGENT_LLM_CONFIG__ = fileConfig;
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = undefined;
  const noStorageResolve = await cfg.resolveEffectiveConfig();
  check(
    '生效优先级：本地存储不可用 → 回落文件配置',
    noStorageResolve.source === 'file' &&
      noStorageResolve.page.status === 'corrupt' &&
      noStorageResolve.page.reason === 'storage-unavailable',
    JSON.stringify({ source: noStorageResolve.source, page: noStorageResolve.page.status }),
  );
  globalThis.localStorage = previousStorage;

  // 复位：清空页面配置与注入，重置损坏通知签名
  storage.reset();
  globalThis.__AGENT_LLM_CONFIG__ = undefined;
  await cfg.resolveEffectiveConfig({ storage });
}

/* ========== 7. testConnection：成功与全部失败分类（§3.5） ========== */

/**
 * 构造成功响应桩（HTTP 2xx + JSON 正文）。
 *
 * @param {object} payload 响应体
 * @param {{status?: number, requestId?: string|null}} [options] 状态与请求 id
 * @returns {object} fetch Response 形状
 */
function makeOkResponse(payload, { status = 200, requestId = null } = {}) {
  return {
    ok: true,
    status,
    headers: { get: (name) => (String(name).toLowerCase() === 'x-request-id' ? requestId : null) },
    json: async () => payload,
  };
}

/**
 * 构造 HTTP 失败响应桩。
 *
 * @param {number} status HTTP 状态码
 * @param {string} body 响应正文
 * @returns {object} fetch Response 形状
 */
function makeErrorResponse(status, body) {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    text: async () => body,
  };
}

/**
 * 构造记录请求的 fetch 桩。
 *
 * @param {(url: string, init: object, callIndex: number) => object} handler 响应处理
 * @returns {Function} fetch 桩（calls 记录每次请求）
 */
function makeFetchStub(handler) {
  const calls = [];
  const stub = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
    return handler(url, init, calls.length);
  };
  stub.calls = calls;
  return stub;
}

{
  const fetchStub = makeFetchStub(() =>
    makeOkResponse(
      {
        id: 'resp-1',
        model: 'unit-model-reply',
        choices: [{ message: { content: 'pong' }, finish_reason: 'stop' }],
        usage: {},
      },
      { requestId: 'req-abc-1' },
    ),
  );
  const success = await cfg.testConnection(draft(), { fetchImpl: fetchStub });
  testConnectionResults.push(success);
  check(
    '测试连接成功：ok=true + 模型 + 耗时 + 状态 + 请求 id',
    success.ok === true &&
      success.model === 'unit-model-reply' &&
      Number.isFinite(success.durationMs) &&
      success.durationMs >= 0 &&
      success.httpStatus === 200 &&
      success.requestId === 'req-abc-1',
    JSON.stringify(success),
  );
  const call = fetchStub.calls[0];
  check('测试连接成功：请求地址为 {baseUrl}/chat/completions', call.url === 'https://api.test.local/v1/chat/completions', call.url);
  check('测试连接成功：Authorization 头为 Bearer <key>', call.init.headers.Authorization === `Bearer ${SECRET}`);
  check(
    '测试连接成功：请求体 model/ping/max_tokens=8/stream=false 且无 response_format',
    call.body.model === 'unit-model' &&
      Array.isArray(call.body.messages) &&
      call.body.messages[0].content === 'ping' &&
      call.body.max_tokens === 8 &&
      call.body.stream === false &&
      call.body.response_format === undefined,
    JSON.stringify(call.body),
  );
}
{
  const noModel = await cfg.testConnection(draft(), {
    fetchImpl: makeFetchStub(() => makeOkResponse({ choices: [{ message: { content: 'pong' } }] })),
  });
  testConnectionResults.push(noModel);
  check('测试连接成功但响应无模型名：model=null（不编造）', noModel.ok === true && noModel.model === null, JSON.stringify(noModel));
  check('测试连接成功但响应无请求 id：requestId=null', noModel.ok === true && noModel.requestId === null);
}
{
  const noChoices = await cfg.testConnection(draft(), {
    fetchImpl: makeFetchStub(() => makeOkResponse({ model: 'x', choices: [] })),
  });
  testConnectionResults.push(noChoices);
  check(
    '测试连接：2xx 但响应无 choices → kind=incompatible',
    noChoices.ok === false && noChoices.kind === 'incompatible' && noChoices.detail.includes('choices'),
    JSON.stringify(noChoices),
  );
  const badJson = await cfg.testConnection(draft(), {
    fetchImpl: makeFetchStub(() => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => {
        throw new Error('不是 JSON');
      },
    })),
  });
  testConnectionResults.push(badJson);
  check('测试连接：2xx 但正文不是 JSON → kind=incompatible', badJson.ok === false && badJson.kind === 'incompatible', JSON.stringify(badJson));
}
{
  let calls = 0;
  const validation = await cfg.testConnection(
    { baseUrl: '', apiKey: '   ', model: '', timeoutMs: 1, maxTokens: 1 },
    {
      fetchImpl: async () => {
        calls += 1;
        return makeOkResponse({ choices: [{}] });
      },
    },
  );
  testConnectionResults.push(validation);
  check(
    '测试连接：本地校验失败 → kind=validation 且不发请求',
    validation.ok === false && validation.kind === 'validation' && calls === 0,
    JSON.stringify(validation),
  );
  check(
    '测试连接：本地校验失败带字段错误与中文原因',
    Boolean(validation.errors?.baseUrl && validation.errors?.apiKey && validation.errors?.model) &&
      validation.message.includes('本地校验未通过') &&
      validation.durationMs === 0 &&
      validation.httpStatus === null,
    JSON.stringify(validation),
  );
}
{
  const httpCases = [
    [401, 'auth'],
    [403, 'auth'],
    [404, 'not-found'],
    [429, 'rate-limit'],
    [500, 'server'],
    [502, 'server'],
    [400, 'incompatible'],
    [405, 'incompatible'],
    [418, 'unknown'],
  ];
  for (const [status, expectedKind] of httpCases) {
    const result = await cfg.testConnection(draft(), {
      fetchImpl: makeFetchStub(() => makeErrorResponse(status, `{"error":"denied ${SECRET}"}`)),
    });
    testConnectionResults.push(result);
    check(
      `测试连接：HTTP ${status} → kind=${expectedKind}`,
      result.ok === false &&
        result.kind === expectedKind &&
        result.httpStatus === status &&
        Number.isFinite(result.durationMs) &&
        typeof result.message === 'string' &&
        result.message.length > 0,
      JSON.stringify({ kind: result.kind, httpStatus: result.httpStatus }),
    );
    check(`测试连接：HTTP ${status} 失败信息/建议不含密钥`, !JSON.stringify(result).includes(SECRET));
    check(`测试连接：HTTP ${status} 返回中文建议`, typeof result.suggestion === 'string' && result.suggestion.length > 0);
  }
}
{
  // 真实 OpenAI 兼容实现的常见形态：HTTP 400 + {"error":{"code":"model_not_found",...}}
  const modelNotFound = await cfg.testConnection(draft(), {
    fetchImpl: makeFetchStub(() =>
      makeErrorResponse(
        400,
        JSON.stringify({
          error: {
            code: 'model_not_found',
            type: 'invalid_request_error',
            message: 'The model unit-model does not exist or you do not have access to it.',
          },
        }),
      ),
    ),
  });
  testConnectionResults.push(modelNotFound);
  check(
    '测试连接：HTTP 400 + model_not_found → kind=not-found（不误报接口不兼容）',
    modelNotFound.ok === false &&
      modelNotFound.kind === 'not-found' &&
      modelNotFound.httpStatus === 400 &&
      modelNotFound.message.includes('端点或模型不存在') &&
      modelNotFound.message.includes('model_not_found') &&
      typeof modelNotFound.suggestion === 'string' &&
      modelNotFound.suggestion.length > 0,
    JSON.stringify({ kind: modelNotFound.kind, httpStatus: modelNotFound.httpStatus, message: modelNotFound.message }),
  );
  check(
    '测试连接：400 模型不存在保留脱敏 detail 且不含密钥',
    typeof modelNotFound.detail === 'string' &&
      modelNotFound.detail.length > 0 &&
      !JSON.stringify(modelNotFound).includes(SECRET),
    JSON.stringify({ detail: modelNotFound.detail }),
  );
}
{
  const genericBadRequest = await cfg.testConnection(draft(), {
    fetchImpl: makeFetchStub(() =>
      makeErrorResponse(400, '{"error":{"code":"invalid_request_error","message":"Invalid request body"}}'),
    ),
  });
  testConnectionResults.push(genericBadRequest);
  check(
    '测试连接：HTTP 400 无模型/端点不存在特征 → kind=incompatible',
    genericBadRequest.ok === false && genericBadRequest.kind === 'incompatible' && genericBadRequest.httpStatus === 400,
    JSON.stringify({ kind: genericBadRequest.kind, httpStatus: genericBadRequest.httpStatus }),
  );
}
{
  // 纯文本 body 的模型不存在特征同样识别（非 JSON 实现）
  const plainModelNotFound = await cfg.testConnection(draft(), {
    fetchImpl: makeFetchStub(() => makeErrorResponse(400, 'The model "unit-model" does not exist')),
  });
  testConnectionResults.push(plainModelNotFound);
  check(
    '测试连接：HTTP 400 纯文本 does not exist → kind=not-found',
    plainModelNotFound.ok === false && plainModelNotFound.kind === 'not-found' && plainModelNotFound.httpStatus === 400,
    JSON.stringify({ kind: plainModelNotFound.kind, httpStatus: plainModelNotFound.httpStatus }),
  );
}
{
  const network = await cfg.testConnection(draft(), {
    fetchImpl: async () => {
      throw new TypeError(`Failed to fetch ${SECRET}`);
    },
  });
  testConnectionResults.push(network);
  check(
    '测试连接：网络/跨域错误 → kind=network + 说明浏览器直连限制',
    network.ok === false &&
      network.kind === 'network' &&
      network.message.includes('网络错误或跨域被拒') &&
      network.suggestion.includes('跨域'),
    JSON.stringify(network),
  );
  check('测试连接：网络错误信息不含密钥', !JSON.stringify(network).includes(SECRET));
}
{
  const timeoutFetch = (url, init) =>
    new Promise((resolve, reject) => {
      init.signal.addEventListener(
        'abort',
        () => {
          const error = new Error('The operation was aborted');
          error.name = 'AbortError';
          reject(error);
        },
        { once: true },
      );
    });
  const startedAt = Date.now();
  const timeout = await cfg.testConnection(draft({ timeoutMs: 1000 }), { fetchImpl: timeoutFetch });
  const waitedMs = Date.now() - startedAt;
  testConnectionResults.push(timeout);
  check(
    '测试连接：超时 → kind=timeout + 实际等待秒数',
    timeout.ok === false && timeout.kind === 'timeout' && timeout.message.includes('超时') && /秒/.test(timeout.message),
    JSON.stringify(timeout),
  );
  check('测试连接：超时按草稿 timeoutMs=1000 生效（实际等待 ≥900ms）', waitedMs >= 900, `实际 ${waitedMs}ms`);
}
{
  // 端点查询参数里带密钥：请求照发，但日志/错误/建议必须脱敏
  const queryDraft = draft({ baseUrl: `https://api.test.local/v1?api_key=${SECRET}` });
  const queryFetch = makeFetchStub(() => makeErrorResponse(500, `server error ${SECRET}`));
  const queryResult = await cfg.testConnection(queryDraft, { fetchImpl: queryFetch });
  testConnectionResults.push(queryResult);
  check(
    '测试连接：端点查询参数含密钥时请求地址保留原参数',
    queryFetch.calls[0].url.startsWith(`https://api.test.local/v1?api_key=${SECRET}`),
    queryFetch.calls[0].url,
  );
  check('测试连接：端点查询参数含密钥时失败信息已脱敏', !JSON.stringify(queryResult).includes(SECRET));
}

/* ========== 7.5 获取模型列表 fetchModels（2026-11-10 追加需求） ========== */

{
  // 成功：{id} 与字符串混合、重复、空值/非字符串过滤、去重、localeCompare 排序
  const fetchStub = makeFetchStub(() =>
    makeOkResponse({
      object: 'list',
      data: [
        { id: 'model-b', object: 'model' },
        'model-a',
        { id: ' model-c ' },
        { id: 'model-a' },
        'model-b',
        '   ',
        { id: '' },
        123,
        null,
        { id: 123 },
        'model-d',
      ],
    }),
  );
  const result = await cfg.fetchModels(draft({ baseUrl: 'https://api.test.local/v1/', timeoutMs: 180000 }), {
    fetchImpl: fetchStub,
  });
  fetchModelsResults.push(result);
  check(
    '获取模型：成功返回 models/count/durationMs/httpStatus',
    result.ok === true &&
      Array.isArray(result.models) &&
      result.count === 4 &&
      Number.isFinite(result.durationMs) &&
      result.durationMs >= 0 &&
      result.httpStatus === 200,
    JSON.stringify(result),
  );
  check(
    '获取模型：过滤空值/非字符串 + 去重 + localeCompare 排序',
    JSON.stringify(result.models) === JSON.stringify(['model-a', 'model-b', 'model-c', 'model-d']),
    JSON.stringify(result.models),
  );
  const call = fetchStub.calls[0];
  check(
    '获取模型：GET {归一化端点}/models（去掉结尾 /）且 method=GET',
    call.url === 'https://api.test.local/v1/models' && call.init.method === 'GET',
    JSON.stringify({ url: call.url, method: call.init.method }),
  );
  check('获取模型：始终带 Authorization: Bearer <key>', call.init.headers.Authorization === `Bearer ${SECRET}`);
  const requestLog = latestConfigLog('llm.config.models.request');
  check(
    '获取模型：日志 request 含脱敏 baseUrl/timeoutMs/hasApiKey 且不含密钥',
    requestLog?.data?.hasApiKey === true &&
      Number.isInteger(requestLog?.data?.timeoutMs) &&
      typeof requestLog?.data?.baseUrl === 'string' &&
      !JSON.stringify(requestLog?.data).includes(SECRET),
    JSON.stringify(requestLog?.data),
  );
  check('获取模型：超时取 min(timeoutMs, 60000)', requestLog?.data?.timeoutMs === 60000, String(requestLog?.data?.timeoutMs));
}
{
  // 端点误带 /chat/completions 后缀：归一化后再拼 /models；timeoutMs 非法 → 默认 30000
  const suffixFetch = makeFetchStub(() => makeOkResponse({ data: [] }));
  const result = await cfg.fetchModels(draft({ baseUrl: ' HTTPS://api.test.local/v1/chat/completions/ ', timeoutMs: 'abc' }), {
    fetchImpl: suffixFetch,
  });
  fetchModelsResults.push(result);
  check(
    '获取模型：端点自动纠正（去 /chat/completions 与结尾 /）后请求 /models',
    result.ok === true && suffixFetch.calls[0].url === 'https://api.test.local/v1/models',
    suffixFetch.calls[0].url,
  );
  check(
    '获取模型：空 data → ok=true、count=0、models=[]',
    result.ok === true && result.count === 0 && Array.isArray(result.models) && result.models.length === 0,
    JSON.stringify(result),
  );
  const requestLog = latestConfigLog('llm.config.models.request');
  check('获取模型：timeoutMs 非法（非整数）时默认 30000', requestLog?.data?.timeoutMs === 30000, String(requestLog?.data?.timeoutMs));
}
{
  // 合法 timeoutMs 未超上限时原样生效（日志可观测）
  const fetchStub = makeFetchStub(() => makeOkResponse({ data: [] }));
  await cfg.fetchModels(draft({ timeoutMs: 5000 }), { fetchImpl: fetchStub });
  const requestLog = latestConfigLog('llm.config.models.request');
  check('获取模型：合法 timeoutMs=5000 原样生效', requestLog?.data?.timeoutMs === 5000, String(requestLog?.data?.timeoutMs));
}
{
  // 校验失败：无密钥 → validation，不发请求（用户要求获取模型也必须先配置 key）
  let calls = 0;
  const noKey = await cfg.fetchModels(
    { baseUrl: 'https://api.test.local/v1', apiKey: '   ' },
    {
      fetchImpl: async () => {
        calls += 1;
        return makeOkResponse({ data: [] });
      },
    },
  );
  fetchModelsResults.push(noKey);
  check(
    '获取模型：无密钥 → kind=validation 且不发请求',
    noKey.ok === false &&
      noKey.kind === 'validation' &&
      calls === 0 &&
      noKey.httpStatus === null &&
      noKey.durationMs === 0,
    JSON.stringify(noKey),
  );
  check(
    '获取模型：无密钥 errors.apiKey 文案含「获取模型需要先填写密钥」',
    typeof noKey.errors?.apiKey === 'string' && noKey.errors.apiKey.includes('获取模型需要先填写密钥'),
    JSON.stringify(noKey.errors),
  );
  check('获取模型：校验失败带中文 message', noKey.message.includes('本地校验未通过') && noKey.message.includes('密钥'));
}
{
  // 校验失败：端点缺失/非法 → errors.baseUrl，不发请求
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return makeOkResponse({ data: [] });
  };
  const emptyDraft = await cfg.fetchModels({}, { fetchImpl });
  fetchModelsResults.push(emptyDraft);
  check(
    '获取模型：端点缺失 → errors.baseUrl + errors.apiKey，且不发请求',
    emptyDraft.kind === 'validation' && Boolean(emptyDraft.errors?.baseUrl && emptyDraft.errors?.apiKey) && calls === 0,
    JSON.stringify(emptyDraft.errors),
  );
  const badEndpoint = await cfg.fetchModels({ baseUrl: 'ftp://a.com', apiKey: SECRET }, { fetchImpl });
  fetchModelsResults.push(badEndpoint);
  check(
    '获取模型：非法协议端点 → errors.baseUrl 且不发请求',
    badEndpoint.kind === 'validation' && Boolean(badEndpoint.errors?.baseUrl) && calls === 0,
    JSON.stringify(badEndpoint.errors),
  );
}
{
  // HTTP 失败复用现有分类与中文文案
  const httpCases = [
    [401, 'auth'],
    [404, 'not-found'],
    [429, 'rate-limit'],
    [500, 'server'],
    [502, 'server'],
    [400, 'incompatible'],
  ];
  for (const [status, expectedKind] of httpCases) {
    const result = await cfg.fetchModels(draft(), {
      fetchImpl: makeFetchStub(() => makeErrorResponse(status, `{"error":"denied ${SECRET}"}`)),
    });
    fetchModelsResults.push(result);
    check(
      `获取模型：HTTP ${status} → kind=${expectedKind} + httpStatus 保留`,
      result.ok === false &&
        result.kind === expectedKind &&
        result.httpStatus === status &&
        typeof result.message === 'string' &&
        result.message.length > 0,
      JSON.stringify({ kind: result.kind, httpStatus: result.httpStatus }),
    );
    check(`获取模型：HTTP ${status} 失败信息/建议不含密钥`, !JSON.stringify(result).includes(SECRET));
    check(`获取模型：HTTP ${status} 返回中文建议`, typeof result.suggestion === 'string' && result.suggestion.length > 0);
  }
}
{
  // 网络错误
  const network = await cfg.fetchModels(draft(), {
    fetchImpl: async () => {
      throw new TypeError(`Failed to fetch ${SECRET}`);
    },
  });
  fetchModelsResults.push(network);
  check(
    '获取模型：网络/跨域错误 → kind=network',
    network.ok === false && network.kind === 'network' && network.suggestion.includes('跨域'),
    JSON.stringify(network),
  );
  check('获取模型：网络错误信息不含密钥', !JSON.stringify(network).includes(SECRET));
}
{
  // 超时：fetch 桩等待信号中止（draft timeoutMs=1000 生效）
  const timeoutFetch = (url, init) =>
    new Promise((resolve, reject) => {
      init.signal.addEventListener(
        'abort',
        () => {
          const error = new Error('The operation was aborted');
          error.name = 'AbortError';
          reject(error);
        },
        { once: true },
      );
    });
  const startedAt = Date.now();
  const timeout = await cfg.fetchModels(draft({ timeoutMs: 1000 }), { fetchImpl: timeoutFetch });
  const waitedMs = Date.now() - startedAt;
  fetchModelsResults.push(timeout);
  check(
    '获取模型：超时 → kind=timeout + 实际等待秒数',
    timeout.ok === false && timeout.kind === 'timeout' && timeout.message.includes('超时') && /秒/.test(timeout.message),
    JSON.stringify(timeout),
  );
  check('获取模型：timeoutMs=1000 生效（实际等待 ≥900ms）', waitedMs >= 900, `实际 ${waitedMs}ms`);
}
{
  // 2xx 但响应结构不兼容
  const nonJson = await cfg.fetchModels(draft(), {
    fetchImpl: makeFetchStub(() => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => {
        throw new Error('不是 JSON');
      },
    })),
  });
  fetchModelsResults.push(nonJson);
  check(
    '获取模型：2xx 但正文不是 JSON → kind=incompatible',
    nonJson.kind === 'incompatible' && nonJson.httpStatus === 200,
    JSON.stringify(nonJson),
  );
  const dataNotArray = await cfg.fetchModels(draft(), {
    fetchImpl: makeFetchStub(() => makeOkResponse({ object: 'list', data: 'not-array' })),
  });
  fetchModelsResults.push(dataNotArray);
  check(
    '获取模型：body.data 非数组 → kind=incompatible + detail 含 data',
    dataNotArray.kind === 'incompatible' && String(dataNotArray.detail).includes('data'),
    JSON.stringify({ kind: dataNotArray.kind, detail: dataNotArray.detail }),
  );
  const dataMissing = await cfg.fetchModels(draft(), {
    fetchImpl: makeFetchStub(() => makeOkResponse({ object: 'list' })),
  });
  fetchModelsResults.push(dataMissing);
  check(
    '获取模型：body.data 缺失 → kind=incompatible',
    dataMissing.kind === 'incompatible' && dataMissing.httpStatus === 200,
    JSON.stringify(dataMissing),
  );
}

/* ========== 8. 轮次快照语义（§4） ========== */

{
  const realFetch = globalThis.fetch;
  const snapshotFileConfig = {
    baseUrl: 'https://file-snap.test/v1',
    apiKey: SNAPSHOT_FILE_SECRET,
    model: 'model-file-snap',
    timeoutMs: 180000,
    maxTokens: 32000,
  };
  globalThis.__AGENT_LLM_CONFIG__ = snapshotFileConfig;
  storage.reset();
  const chatFetch = makeFetchStub(() =>
    makeOkResponse({
      id: 'snap',
      model: 'mock',
      choices: [{ message: { content: '{"action":"chat","reply":"好"}' }, finish_reason: 'stop' }],
      usage: {},
    }),
  );
  globalThis.fetch = chatFetch;
  try {
    const snapshot = await llm.beginTurnConfigSnapshot();
    check(
      '轮次快照：begin 取到当轮生效配置（文件配置）',
      snapshot.source === 'file' && snapshot.config?.model === 'model-file-snap',
      JSON.stringify({ source: snapshot.source, model: snapshot.config?.model }),
    );
    check('轮次快照：isConfigSnapshotActive=true', llm.isConfigSnapshotActive() === true);

    await llm.chatCompletion({ messages: [{ role: 'user', content: '快照请求1' }], retries: 0 });
    check('轮次快照：首个请求使用快照配置', chatFetch.calls[0].body.model === 'model-file-snap', chatFetch.calls[0].body.model);

    // 快照进行中保存页面配置：不得改变本轮快照，也不得 abort
    const midSave = cfg.savePageConfig(
      draft({ baseUrl: 'https://page-mid.test/v1', model: 'model-page-mid', apiKey: SECRET }),
      { storage },
    );
    check('轮次快照：快照期内保存页面配置成功', midSave.ok === true);
    check(
      '轮次快照：保存后快照内容不变',
      llm.isConfigSnapshotActive() === true && snapshot.config.model === 'model-file-snap',
      JSON.stringify({ active: llm.isConfigSnapshotActive(), model: snapshot.config?.model }),
    );
    await llm.chatCompletion({ messages: [{ role: 'user', content: '快照请求2' }], retries: 0 });
    check(
      '轮次快照：保存后本轮请求仍用旧配置（当前轮不受影响）',
      chatFetch.calls[1].body.model === 'model-file-snap',
      chatFetch.calls[1].body.model,
    );

    llm.endTurnConfigSnapshot();
    check('轮次快照：end 后 isConfigSnapshotActive=false', llm.isConfigSnapshotActive() === false);
    await llm.chatCompletion({ messages: [{ role: 'user', content: '快照结束后请求' }], retries: 0 });
    check(
      '轮次快照：结束后下一次请求使用新保存的页面配置',
      chatFetch.calls[2].body.model === 'model-page-mid',
      chatFetch.calls[2].body.model,
    );

    const cleared = cfg.clearPageConfig({ storage });
    check('轮次快照：恢复默认后回落文件配置', cleared.ok === true && cleared.source === 'file');
    await llm.chatCompletion({ messages: [{ role: 'user', content: '恢复后请求' }], retries: 0 });
    check('轮次快照：恢复默认后请求使用文件配置', chatFetch.calls[3].body.model === 'model-file-snap', chatFetch.calls[3].body.model);
  } finally {
    llm.endTurnConfigSnapshot();
    globalThis.fetch = realFetch;
  }
}
{
  // 未配置时开轮：快照冻结"未配置"，中途保存也不影响本轮；结束后下一轮生效
  const realFetch = globalThis.fetch;
  const chatFetch = makeFetchStub(() =>
    makeOkResponse({ choices: [{ message: { content: '{"action":"chat"}' }, finish_reason: 'stop' }], usage: {} }),
  );
  globalThis.fetch = chatFetch;
  globalThis.__AGENT_LLM_CONFIG__ = undefined;
  storage.reset();
  try {
    const emptySnapshot = await llm.beginTurnConfigSnapshot();
    check(
      '轮次快照：未配置时 begin 冻结 source=none/config=null',
      emptySnapshot.source === 'none' && emptySnapshot.config === null,
      JSON.stringify(emptySnapshot),
    );
    cfg.savePageConfig(draft({ model: 'model-late-configured' }), { storage });
    let unconfiguredError = null;
    try {
      await llm.chatCompletion({ messages: [{ role: 'user', content: '未配置轮次' }], retries: 0 });
    } catch (error) {
      unconfiguredError = error;
    }
    check(
      '轮次快照：未配置快照期内即使保存配置仍抛 unconfigured（不打断本轮语义）',
      unconfiguredError?.kind === 'unconfigured' && unconfiguredError.message.includes('尚未配置') && chatFetch.calls.length === 0,
      `${unconfiguredError?.kind} calls=${chatFetch.calls.length}`,
    );
    llm.endTurnConfigSnapshot();
    await llm.chatCompletion({ messages: [{ role: 'user', content: '配置后续轮次' }], retries: 0 });
    check(
      '轮次快照：结束后新配置立即生效',
      chatFetch.calls.length === 1 && chatFetch.calls[0].body.model === 'model-late-configured',
      JSON.stringify(chatFetch.calls.map((call) => call.body.model)),
    );
    check(
      '错误分类：unconfigured 进入 classifyError 分类',
      llm.classifyError(unconfiguredError, null) === 'unconfigured',
      llm.classifyError(unconfiguredError, null),
    );
  } finally {
    llm.endTurnConfigSnapshot();
    globalThis.fetch = realFetch;
    storage.reset();
    globalThis.__AGENT_LLM_CONFIG__ = undefined;
  }
}

/* ========== 9. 日志事件与密钥 0 命中（§3.5/§3.6/R8） ========== */

const allRecords = getEntries({ level: 'debug', limit: 0 });
const recordsOf = (module) => allRecords.filter((record) => record.module === module);
const configRecords = recordsOf('agent/llm-config');
const llmRecords = recordsOf('agent/llm');
const hasEvent = (records, event) => records.some((record) => record.event === event);

check('日志事件：test.request 带 hasApiKey 且不含 apiKey 字段', configRecords.some((record) => {
  if (record.event !== 'llm.config.test.request') return false;
  const data = record.data || {};
  return data.hasApiKey === true && data.apiKey === undefined && typeof data.baseUrl === 'string';
}));
check(
  '日志事件：test.success 记录 model/durationMs/httpStatus',
  configRecords.some(
    (record) =>
      record.event === 'llm.config.test.success' &&
      record.data?.model === 'unit-model-reply' &&
      Number.isFinite(record.data?.durationMs) &&
      record.data?.httpStatus === 200,
  ),
);
{
  const failedKinds = new Set(
    configRecords.filter((record) => record.event === 'llm.config.test.failed').map((record) => record.data?.kind),
  );
  const expectedKinds = ['validation', 'network', 'timeout', 'auth', 'not-found', 'rate-limit', 'server', 'incompatible', 'unknown'];
  check(
    '日志事件：test.failed 覆盖全部失败分类',
    expectedKinds.every((kind) => failedKinds.has(kind)),
    JSON.stringify([...failedKinds]),
  );
}
{
  check(
    '日志事件：获取模型 request/success/failed 均有留痕',
    hasEvent(configRecords, 'llm.config.models.request') &&
      hasEvent(configRecords, 'llm.config.models.success') &&
      hasEvent(configRecords, 'llm.config.models.failed'),
  );
  const modelFailedKinds = new Set(
    configRecords.filter((record) => record.event === 'llm.config.models.failed').map((record) => record.data?.kind),
  );
  const expectedModelKinds = ['validation', 'network', 'timeout', 'auth', 'not-found', 'rate-limit', 'server', 'incompatible'];
  check(
    '日志事件：models.failed 覆盖分类',
    expectedModelKinds.every((kind) => modelFailedKinds.has(kind)),
    JSON.stringify([...modelFailedKinds]),
  );
  check(
    '日志事件：models.success 记录 count/durationMs/httpStatus',
    configRecords.some(
      (record) =>
        record.event === 'llm.config.models.success' &&
        record.data?.count === 4 &&
        Number.isFinite(record.data?.durationMs) &&
        record.data?.httpStatus === 200,
    ),
  );
  const modelsRequestRecord = configRecords.find((record) => record.event === 'llm.config.models.request');
  check(
    '日志事件：models.request 不含 apiKey 字段/密钥明文',
    modelsRequestRecord?.data?.apiKey === undefined && !JSON.stringify(modelsRequestRecord?.data).includes(SECRET),
    JSON.stringify(modelsRequestRecord?.data),
  );
}
check('日志事件：保存页面配置留痕 llm.config.saved', hasEvent(configRecords, 'llm.config.saved'));
{
  const savedRecord = configRecords.find((record) => record.event === 'llm.config.saved');
  check(
    '日志事件：saved 含 action/source/previousSource/endpointCorrected 且不含密钥',
    savedRecord?.data?.action === 'save' &&
      savedRecord?.data?.source === 'page' &&
      typeof savedRecord?.data?.previousSource === 'string' &&
      savedRecord?.data?.endpointCorrected === true &&
      savedRecord?.data?.apiKey === undefined,
    JSON.stringify(savedRecord?.data),
  );
}
check('日志事件：恢复默认留痕 llm.config.restored', hasEvent(configRecords, 'llm.config.restored'));
check('日志事件：存储失败留痕 llm.config.storage.failed', hasEvent(configRecords, 'llm.config.storage.failed'));
check('日志事件：损坏配置留痕 llm.config.corrupt', hasEvent(configRecords, 'llm.config.corrupt'));
check('日志事件：轮次快照 llm.config.snapshot.begin/end 留痕', hasEvent(llmRecords, 'llm.config.snapshot.begin') && hasEvent(llmRecords, 'llm.config.snapshot.end'));
check('日志事件：llm.js 生效配置留痕 llm.config', hasEvent(llmRecords, 'llm.config'));

{
  const serializedLogs = JSON.stringify(allRecords);
  const secrets = [
    ['请求/页面配置密钥', SECRET],
    ['文件配置密钥', FILE_SECRET],
    ['快照文件配置密钥', SNAPSHOT_FILE_SECRET],
  ];
  for (const [name, secret] of secrets) {
    check(`密钥 0 命中：运行日志不含${name}`, !serializedLogs.includes(secret));
  }
  check('密钥 0 命中：日志不含 Authorization 头明文', !serializedLogs.includes('Authorization'));
  check(
    '密钥 0 命中：日志 data 中不存在 apiKey 明文',
    allRecords.every((record) => !record.data || record.data.apiKey === undefined || record.data.apiKey === '***'),
  );
  check(
    '密钥 0 命中：远程调用失败结果（testConnection/fetchModels 的 message/suggestion/detail）不含密钥',
    !JSON.stringify([...testConnectionResults, ...fetchModelsResults]).includes(SECRET),
  );
  check(
    '密钥 0 命中：错误提示中不含 Bearer 令牌明文',
    [...testConnectionResults, ...fetchModelsResults].every((result) => !JSON.stringify(result).includes('Bearer ')),
  );
}

/* ========== 收尾 ========== */

check('测试结束已清理全局 fetch 桩（未污染真实 fetch）', typeof globalThis.fetch === 'function');
globalThis.__AGENT_LLM_CONFIG__ = undefined;
globalThis.localStorage = storage;

console.log(`\n[summary] ${checks - failures}/${checks} 项通过，失败 ${failures} 项`);
console.log(failures === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${failures} checks)`);
process.exitCode = failures === 0 ? 0 : 1;
