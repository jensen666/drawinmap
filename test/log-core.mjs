/**
 * 日志系统测试（Node 直接运行，不依赖浏览器与网络）。
 *
 * 覆盖：
 * - 脱敏/截断：密钥字段打码、图片 dataURL 只留元信息、超长字符串截断、循环引用、Error 提取；
 * - 记录与缓冲：字段完整、环形缓冲上限、恢复历史、清空、订阅；
 * - 过滤：最低级别 / 模块 / traceId / 关键词 / 条数上限；
 * - 链路追踪：trace/span 归属、耗时、步骤记录、异常结束；
 * - 级别开关：info 级别丢弃 debug、debug 级别放行；
 * - 输出端：localStorage 持久化与恢复、服务端落盘（本地 HTTP 桩 + 自动降级）；
 * - 公共入口：initLogging 后 createLogger/beginTrace 可用、JSONL 导出可解析。
 *
 * 运行：node test/log-core.mjs
 */

import { createServer } from 'node:http';
import {
  LEVELS,
  LogStore,
  createRecord,
  extractError,
  filterRecords,
  sanitize,
  serializeRecord,
} from '../web/src/log/core.js';
import { createLogSystem } from '../web/src/log/system.js';
import { initLogging, createLogger, beginTrace, getEntries, exportJsonl, clearLogs } from '../web/src/log/index.js';

let failures = 0;

/**
 * 断言工具：记录并通过/失败计数。
 *
 * @param {string} label 断言名
 * @param {boolean} condition 是否通过
 * @param {string} [detail] 失败详情
 */
function check(label, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) {
    failures += 1;
  }
  console.log(`[check] ${label} -> ${ok ? 'PASS' : `FAIL ${detail}`}`);
}

/** 等待条件成立（异步输出端用），超时返回 false */
async function waitFor(condition, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return condition();
}

// ---------- 脱敏与截断 ----------
const secret = sanitize({
  apiKey: 'test-placeholder-key-live',
  Authorization: 'Bearer abc',
  nested: { token: 't0k', normal: 'ok' },
});
check('密钥字段打码：apiKey', secret.apiKey === '***');
check('密钥字段打码：Authorization', secret.Authorization === '***');
check('密钥字段打码：嵌套 token', secret.nested.token === '***');
check('普通字段保留', secret.nested.normal === 'ok');

const imageDataUrl = `data:image/jpeg;base64,${'A'.repeat(200)}`;
const withImage = sanitize({ image_url: { url: imageDataUrl } });
check(
  '图片 dataURL 只保留元信息',
  typeof withImage.image_url.url === 'string' &&
    withImage.image_url.url.includes('dataURL 已省略') &&
    withImage.image_url.url.includes('jpeg') &&
    !withImage.image_url.url.includes('AAAA'),
  String(withImage.image_url.url),
);

const long = sanitize({ text: 'x'.repeat(30000) });
check(
  '超长字符串截断并标注原长',
  long.text.length < 20100 && long.text.includes('截断') && long.text.includes('30000'),
  `长度 ${long.text.length}`,
);

const circular = { name: 'loop' };
circular.self = circular;
const sanitizedCircular = sanitize(circular);
check('循环引用不抛错并标注', sanitizedCircular.self === '[Circular]');

const deep = sanitize({ a: { b: { c: { d: { e: { f: { g: { h: { i: 1 } } } } } } } } });
check('超深嵌套截断为标记', JSON.stringify(deep).includes('MaxDepth'));

const errorInfo = extractError(new TypeError('bad input'));
check('错误提取：name/message', errorInfo.name === 'TypeError' && errorInfo.message === 'bad input');
check('错误提取：带 stack', typeof errorInfo.stack === 'string' && errorInfo.stack.length > 0);
check('非 Error 值转字符串记录', extractError('plain failure').message === 'plain failure');

// ---------- 记录结构与缓冲 ----------
const record = createRecord({
  level: 'warn',
  module: 'test/module',
  event: 'test.event',
  data: { ok: true },
  error: new Error('boom'),
  sessionId: 's-test',
  traceId: 't-test',
  spanId: 'sp-test',
  durationMs: 12.34,
});
check(
  '记录字段完整（v/ts/time/level/module/event/sessionId/traceId/spanId/durationMs）',
  record.v === 1 &&
    typeof record.ts === 'number' &&
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/.test(record.time) &&
    record.level === 'warn' &&
    record.module === 'test/module' &&
    record.event === 'test.event' &&
    record.sessionId === 's-test' &&
    record.traceId === 't-test' &&
    record.spanId === 'sp-test' &&
    record.durationMs === 12.3,
  JSON.stringify(record),
);
check('记录内错误已转结构化', record.error && record.error.message === 'boom');
check('JSONL 序列化单行可解析', JSON.parse(serializeRecord(record)).event === 'test.event');

const store = new LogStore({ maxRecords: 50 });
const seen = [];
const unsubscribe = store.subscribe((item) => seen.push(item.event));
for (let i = 0; i < 60; i += 1) {
  store.push(createRecord({ level: 'info', module: 'm', event: `e${i}`, sessionId: 's' }));
}
check('环形缓冲上限生效', store.size === 50, `实际 ${store.size}`);
check('最早记录被淘汰', store.records[0].event === 'e10', store.records[0].event);
check('订阅收到新记录', seen.length === 60 && seen[0] === 'e0');
check('累计计数不受淘汰影响', store.total === 60);
unsubscribe();
store.push(createRecord({ level: 'info', module: 'm', event: 'after', sessionId: 's' }));
check('取消订阅后不再回调', seen.length === 60);

const restored = new LogStore({ maxRecords: 5 });
restored.push(createRecord({ level: 'info', module: 'm', event: 'new', sessionId: 's' }));
restored.restore([createRecord({ level: 'info', module: 'm', event: 'old1', sessionId: 's' })]);
check('恢复历史记录到缓冲头部', restored.records[0].event === 'old1' && restored.records.length === 2);
restored.clear();
check('清空缓冲', restored.size === 0);

// ---------- 过滤 ----------
const sample = [
  createRecord({ level: 'debug', module: 'a', event: 'd1', sessionId: 's' }),
  createRecord({ level: 'info', module: 'a', event: 'i1', sessionId: 's', traceId: 't1' }),
  createRecord({ level: 'warn', module: 'b', event: 'w1', sessionId: 's', traceId: 't1' }),
  createRecord({ level: 'error', module: 'b', event: 'e1', sessionId: 's', data: { 关键词: '广州塔' } }),
];
check('过滤：最低级别 info 排除 debug', filterRecords(sample, { level: 'info' }).length === 3);
check('过滤：warn 级别', filterRecords(sample, { level: 'warn' }).length === 2);
check('过滤：按模块', filterRecords(sample, { level: 'debug', module: 'b' }).length === 2);
check('过滤：按 traceId', filterRecords(sample, { level: 'debug', traceId: 't1' }).length === 2);
check('过滤：关键词匹配 data 中文', filterRecords(sample, { level: 'debug', keyword: '广州塔' }).length === 1);
check('过滤：limit 取最新', filterRecords(sample, { level: 'debug', limit: 2 })[1].event === 'e1');

// ---------- T-B4b：log 面板筛选复用 filterRecords（与改前 matchesRecord 逐条一致） ----------
// 背景（清理方案 2026-11-09 §3.2 B4）：log/ui.js 此前手抄 LEVEL_RANK + matchesRecord
// （只用于"实时追加"），与 core.js 的 filterRecords（列表渲染/导出）是两套实现；
// 现实时追加直接复用 filterRecords。此段以**改前实现**为参照，穷举记录 × 三级筛选
// （级别/模块/关键词 + 组合），断言逐条结果一致；并固化三组筛选的期望事件序列，
// 防止 filterRecords 自身语义漂移后"两边同时错"仍通过。
{
  /** 改前 log/ui.js 的 LEVEL_RANK / matchesRecord 原样复刻（仅作等价性参照） */
  const LEVEL_RANK_LEGACY = { debug: 10, info: 20, warn: 30, error: 40 };
  function matchesRecordLegacy(record, state) {
    if ((LEVEL_RANK_LEGACY[record.level] ?? 0) < (LEVEL_RANK_LEGACY[state.level] ?? 0)) {
      return false;
    }
    if (state.module && record.module !== state.module) {
      return false;
    }
    if (state.keyword) {
      let text = '';
      try {
        text = JSON.stringify(record);
      } catch {
        text = String(record);
      }
      if (!text.toLowerCase().includes(state.keyword)) {
        return false;
      }
    }
    return true;
  }
  const make = (level, module, event, data, traceId = null) =>
    createRecord({ level, module, event, data, sessionId: 's', traceId });
  const fixtureRecords = [
    make('debug', 'engine', 'engine.debug', { note: '缓存命中 cacheHit' }, 't-aaa001'),
    make('info', 'agent/llm', 'llm.request', { 提示词: '画个广州塔' }, 't-aaa001'),
    make('info', 'ui', 'ui.render', { 文本: 'LLM 回复就绪' }),
    make('warn', 'city', 'city.fetch.slow', { 城市: '广州', 耗时毫秒: 1200 }),
    make('error', 'agent/llm', 'llm.failed', { HTTP: 500 }),
    make('warn', 'engine', 'engine.cap', { expandedNodes: 24000 }, 't-bbb002'),
    make('debug', 'ui', 'ui.scroll', { bottom: true }),
    make('info', 'city', 'city.cache', { 城市: '深圳', note: '广州塔附近' }, 't-bbb002'),
  ];
  const filterStates = [
    ['级别 debug（全放行）', { level: 'debug', module: '', keyword: '' }],
    ['级别 info', { level: 'info', module: '', keyword: '' }],
    ['级别 warn', { level: 'warn', module: '', keyword: '' }],
    ['级别 error', { level: 'error', module: '', keyword: '' }],
    ['模块 engine', { level: 'debug', module: 'engine', keyword: '' }],
    ['模块 agent/llm', { level: 'debug', module: 'agent/llm', keyword: '' }],
    ['模块 city + warn', { level: 'warn', module: 'city', keyword: '' }],
    ['关键词 广州塔（中文）', { level: 'debug', module: '', keyword: '广州塔' }],
    ['关键词 llm（大小写不敏感）', { level: 'debug', module: '', keyword: 'llm' }],
    ['关键词 traceId 片段 t-bbb002', { level: 'debug', module: '', keyword: 't-bbb002' }],
    ['组合：warn + agent/llm + 500', { level: 'warn', module: 'agent/llm', keyword: '500' }],
  ];
  for (const [label, state] of filterStates) {
    const legacy = fixtureRecords.filter((record) => matchesRecordLegacy(record, state)).map((record) => record.event);
    const actual = filterRecords(fixtureRecords, {
      level: state.level,
      module: state.module || null,
      traceId: null,
      keyword: state.keyword,
    }).map((record) => record.event);
    check(
      `log 面板筛选复用：${label} 与改前 matchesRecord 逐条一致`,
      JSON.stringify(actual) === JSON.stringify(legacy),
      `actual=${JSON.stringify(actual)} legacy=${JSON.stringify(legacy)}`,
    );
  }
  // 三组筛选的改前期望序列（fixture 固化：两边同时错也能被抓到）
  check(
    'log 面板筛选：级别组期望序列固化',
    JSON.stringify(filterRecords(fixtureRecords, { level: 'warn' }).map((record) => record.event)) ===
      JSON.stringify(['city.fetch.slow', 'llm.failed', 'engine.cap']),
  );
  check(
    'log 面板筛选：模块组期望序列固化',
    JSON.stringify(filterRecords(fixtureRecords, { level: 'debug', module: 'engine' }).map((record) => record.event)) ===
      JSON.stringify(['engine.debug', 'engine.cap']),
  );
  check(
    'log 面板筛选：关键词组期望序列固化',
    JSON.stringify(filterRecords(fixtureRecords, { level: 'debug', keyword: '广州塔' }).map((record) => record.event)) ===
      JSON.stringify(['llm.request', 'city.cache']),
  );
}

// ---------- 级别开关 + 链路追踪 ----------
const memorySystem = createLogSystem({ level: 'info', storage: false, server: false, console: false });
const logger = memorySystem.createLogger('unit');
logger.debug('should.drop', {});
logger.info('kept', { value: 1 });
check('info 级别丢弃 debug 记录', memorySystem.entries({ level: 'debug' }).length === 1);
memorySystem.setLevel('debug');
logger.debug('now.kept', {});
check('切到 debug 后放行 debug', memorySystem.entries({ level: 'debug' }).length === 2);

const trace = memorySystem.beginTrace('turn', { text: '画个心形', imageDataUrl: imageDataUrl });
check('trace 开启后 currentTraceId 可用', memorySystem.getCurrentTraceId() === trace.id);
logger.info('inside.trace', {});
trace.step('理解需求…');
const span = trace.startSpan('llm.request', { attempt: 1 });
logger.info('inside.span', {});
span.end({ ok: true });
trace.info('after.span', {});
trace.end({ replyLength: 3 });
check('trace 结束后 currentTraceId 清空', memorySystem.getCurrentTraceId() === null);

const traceRecords = memorySystem.entries({ level: 'debug', traceId: trace.id });
check('trace 内模块日志自动带 traceId', traceRecords.some((item) => item.event === 'inside.trace'));
check('span 内的日志带 spanId', traceRecords.some((item) => item.event === 'inside.span' && item.spanId === span.id));
check('step 记录用户可见步骤', traceRecords.some((item) => item.event === 'step' && item.data.step === '理解需求…'));
check('trace.start 记录图片元信息而非明文', (() => {
  const start = traceRecords.find((item) => item.event === 'trace.start');
  return start && JSON.stringify(start).includes('dataURL 已省略') && !JSON.stringify(start).includes('AAAA');
})());
const spanEnd = traceRecords.find((item) => item.event === 'span.end' && item.spanId === span.id);
check('span.end 带耗时', spanEnd && Number.isFinite(spanEnd.durationMs) && spanEnd.durationMs >= 0);
const traceEnd = traceRecords.find((item) => item.event === 'trace.end');
check('trace.end 带总耗时与结果', traceEnd && Number.isFinite(traceEnd.durationMs) && traceEnd.data.replyLength === 3);

// 异常链路：span/trace 记录错误堆栈
const failing = memorySystem.beginTrace('failing', {});
try {
  await failing.withSpan('boom.span', async () => {
    throw new Error('span 内失败');
  });
} catch {
  // 预期抛出
}
failing.fail(new Error('整轮失败'), { stage: 'test' });
const failRecords = memorySystem.entries({ level: 'debug', traceId: failing.id });
check('异常 span 记录错误', failRecords.some((item) => item.event === 'span.end' && item.error?.message === 'span 内失败'));
check('异常 trace.end 记录错误', failRecords.some((item) => item.event === 'trace.end' && item.error?.message === '整轮失败'));

// ---------- JSONL 导出 ----------
const jsonl = memorySystem.exportJsonl({ level: 'debug' });
const lines = jsonl.split('\n').filter(Boolean);
check('导出 JSONL 行数等于记录数', lines.length === memorySystem.entries({ level: 'debug', limit: 0 }).length);
check('导出 JSONL 每行可解析', lines.every((line) => {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}));

// ---------- localStorage 持久化与恢复 ----------
function createFakeStorage() {
  const data = new Map();
  return {
    data,
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      data.set(key, String(value));
    },
    removeItem(key) {
      data.delete(key);
    },
  };
}
const fakeStorage = createFakeStorage();
const storageSystem = createLogSystem({
  level: 'info',
  storage: true,
  storageOptions: { storage: fakeStorage, debounceMs: 5 },
  server: false,
  console: false,
});
storageSystem.createLogger('persist').info('persist.event', { value: 42 });
await storageSystem.flush();
check('localStorage 已写入', fakeStorage.data.size === 1);
const restoredSystem = createLogSystem({
  level: 'info',
  storage: true,
  storageOptions: { storage: fakeStorage, debounceMs: 5 },
  server: false,
  console: false,
});
check(
  '新实例可恢复上次日志',
  restoredSystem.entries({ level: 'info' }).some((item) => item.event === 'persist.event'),
);
restoredSystem.clear();
check('清空后 localStorage 键被移除', fakeStorage.data.size === 0);
storageSystem.dispose();
restoredSystem.dispose();

// ---------- 服务端落盘（本地 HTTP 桩）与自动降级 ----------
const received = [];
const stubServer = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/__log/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === 'POST' && req.url === '/__log') {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        received.push(...JSON.parse(Buffer.concat(chunks).toString('utf8')).records);
      } catch (error) {
        received.push({ parseError: error.message });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }
  res.writeHead(404).end();
});
await new Promise((resolve) => stubServer.listen(0, '127.0.0.1', resolve));
const stubPort = stubServer.address().port;
const serverSystem = createLogSystem({
  level: 'debug',
  storage: false,
  console: false,
  server: true,
  serverOptions: {
    endpoint: `http://127.0.0.1:${stubPort}/__log`,
    pingEndpoint: `http://127.0.0.1:${stubPort}/__log/ping`,
    flushIntervalMs: 25,
    probeTimeoutMs: 1000,
    fetchImpl: fetch,
  },
});
await serverSystem.start();
check('服务端接口探测成功', serverSystem.serverStatus().status === 'available', JSON.stringify(serverSystem.serverStatus()));
serverSystem.createLogger('remote').info('remote.event', { value: 7 });
await serverSystem.flush();
check('日志批次送达服务端', await waitFor(() => received.length >= 1), `收到 ${received.length} 条`);
check(
  '服务端收到的事件与内容正确',
  received.some((item) => item.event === 'remote.event' && item.data?.value === 7),
);
serverSystem.dispose();
await new Promise((resolve) => stubServer.close(resolve));

const deadSystem = createLogSystem({
  level: 'info',
  storage: false,
  console: false,
  server: true,
  serverOptions: {
    endpoint: 'http://127.0.0.1:1/__log',
    pingEndpoint: 'http://127.0.0.1:1/__log/ping',
    probeTimeoutMs: 500,
    flushIntervalMs: 50,
    fetchImpl: fetch,
  },
});
await deadSystem.start();
check('接口不可用时自动降级（不抛错）', deadSystem.serverStatus().status === 'unavailable');
deadSystem.createLogger('offline').info('offline.event', { ok: true });
check('降级后日志仍进内存缓冲', deadSystem.entries({ level: 'info' }).some((item) => item.event === 'offline.event'));
deadSystem.dispose();

// ---------- 瞬时失败恢复：首批 POST 失败后 error 状态仍重试（2026-10-31 E2E 回归） ----------
// 背景：一次瞬时失败曾让 flush 停在 error、定时冲刷再也不发（整轮日志滞留丢失）；
// 且 keepalive 请求在部分环境一律 "Failed to fetch"。回归断言：失败批不丢、恢复后送达。
{
  const flakyReceived = [];
  let failFirst = true;
  const flakyServer = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/__log/ping') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === 'POST' && req.url === '/__log') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const records = JSON.parse(Buffer.concat(chunks).toString('utf8')).records;
        if (failFirst) {
          failFirst = false;
          res.destroy(); // 连接级失败（模拟瞬时网络错误）
          return;
        }
        flakyReceived.push(...records);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => flakyServer.listen(0, '127.0.0.1', resolve));
  const flakyPort = flakyServer.address().port;
  const flakySystem = createLogSystem({
    level: 'info',
    storage: false,
    console: false,
    server: true,
    serverOptions: {
      endpoint: `http://127.0.0.1:${flakyPort}/__log`,
      pingEndpoint: `http://127.0.0.1:${flakyPort}/__log/ping`,
      flushIntervalMs: 30,
      probeTimeoutMs: 1000,
      fetchImpl: fetch,
    },
  });
  await flakySystem.start();
  flakySystem.createLogger('flaky').info('flaky.event', { n: 1 });
  await flakySystem.flush(); // 首批连接级失败 → error 状态 → 同一轮 flush 内重试成功
  const afterFail = flakySystem.serverStatus();
  check('瞬时失败不再停摆（重试后恢复 available）', afterFail.status === 'available' && afterFail.enabled === true, JSON.stringify(afterFail));
  check('失败被计数且批次未丢（failed ≥ 1，pending = 0）', afterFail.failed >= 1 && afterFail.pending === 0, `failed=${afterFail.failed} pending=${afterFail.pending}`);
  check('首批记录经重试送达', await waitFor(() => flakyReceived.some((r) => r.event === 'flaky.event')), `收到 ${flakyReceived.length} 条`);
  flakySystem.createLogger('flaky').info('flaky.event2', { n: 2 });
  await flakySystem.flush();
  check('后续批次正常送达', await waitFor(() => flakyReceived.some((r) => r.event === 'flaky.event2')), `收到 ${flakyReceived.length} 条`);
  flakySystem.dispose();
  await new Promise((resolve) => flakyServer.close(resolve));
}

// ---------- 公共入口（页面实际调用路径） ----------
initLogging({ server: false, storage: false, level: 'debug', version: 'test-rev' });
const facadeLog = createLogger('facade');
const facadeTrace = beginTrace('facade.turn', { text: '测试' });
facadeLog.info('facade.event', { a: 1 });
facadeTrace.step('步骤一');
facadeTrace.end({});
check('initLogging 后公共 logger 可用', getEntries({ level: 'debug' }).some((item) => item.event === 'facade.event'));
check('公共 beginTrace 的 step 可查', getEntries({ level: 'debug' }).some((item) => item.event === 'step'));
check('公共入口导出 JSONL 非空', exportJsonl({ level: 'debug' }).split('\n').filter(Boolean).length > 0);
clearLogs();
check('公共入口清空生效', getEntries({ level: 'debug' }).length === 0);
check('LEVELS 级别数值有序', LEVELS.debug < LEVELS.info && LEVELS.info < LEVELS.warn && LEVELS.warn < LEVELS.error);

console.log(failures === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${failures} checks)`);
process.exit(failures === 0 ? 0 : 2);
