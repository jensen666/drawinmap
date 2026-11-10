/**
 * 开发用服务器（Node 自带模块，无依赖）：静态文件 + 日志落盘接口 + 参考图在线检索代理。
 *
 * 为什么不用 `python -m http.server`：
 * - python 不发 Cache-Control，浏览器按 Last-Modified 做启发式缓存，
 *   改过的 src/*.js 在已打开的标签页/软刷新下可能仍是旧代码，
 *   造成"同一句话在我这成功、在用户那失败"的陈旧代码假故障；
 * - .mjs 的 MIME 类型在 Windows 上受注册表影响，可能被当成非 JS 导致模块加载失败。
 * 这里对一切响应强制 Cache-Control: no-store，每次加载都拿磁盘最新文件。
 *
 * 日志接口（只写本地文件，无业务逻辑）：
 * - GET  /__log/ping  探测接口是否可用（前端据此决定是否落盘，不可用自动降级）
 * - POST /__log       接收前端日志批次，按天追加到 web/logs/YYYY-MM-DD.jsonl
 *
 * 参考图在线检索（方案 2026-10-31 §9）：浏览器只请求同源 /__reference/*，
 * 不直接访问外部素材站；服务端负责查询校验、源适配、外部请求、下载缓存、
 * 拒绝记录与超时。使用 npx serve 等纯静态托管时没有这两个接口，
 * 前端探测失败自动跳过在线检索（不影响本地素材/自由轮廓/路网规划）。
 * 注意：修改本文件后必须重启开发服务器——旧进程没有这些接口，
 * 前端不得把"旧进程缺接口"误判为"在线无素材"。
 * - GET  /__reference/ping    能力探测 { ok, sources, experimentalSources }
 * - POST /__reference/search  在线检索 raw candidates（未归一化 T，浏览器统一归一化）
 *
 * 城市路网按需获取（方案 2026-11-08 §4）：浏览器只访问同源 /__city/* 与
 * /data/city-roads/<cityId>.json（获取成功后由本服务落盘的缓存文件）；
 * Overpass 等外部数据源只在服务端访问，瓦片拆分 + 多镜像重试 + 0 道路判失败。
 * - GET  /__city/catalog      目录 + 各城缓存状态
 * - POST /__city/fetch        发起获取 {cityId}（串行作业队列）
 * - GET  /__city/job/<id>     作业进度
 */

import { createServer } from 'node:http';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createOnlineReferenceService } from './server/reference/online-service.js';
import { createCityFetchService } from './server/city/fetch-service.js';

const root = fileURLToPath(new URL('./', import.meta.url));
const logDir = join(root, 'logs');
const port = Number(process.argv[2] || 5173);

/** 日志接口请求体上限（一次批次最多 40 条，正常远小于该值；防异常大包打爆内存） */
const MAX_LOG_BODY = 8 * 1024 * 1024;

/** 在线检索请求体上限（查询是小 JSON；方案 §9.2 请求体设上限） */
const MAX_REFERENCE_BODY = 64 * 1024;

/** 在线检索缓存根（方案 §9.4：复用 web/data/shapes/cache/，只由 Node 服务写入） */
const referenceCacheDir = join(root, 'data', 'shapes', 'cache');

/**
 * Openclipart 是 experimental 源（依赖搜索页/详情页 HTML 解析，方案 §9.5）：
 * 默认关闭；仅在项目负责人明确接受该方式的风险后，用环境变量显式开启。
 */
const EXPERIMENTAL_OPENCLIPART = process.env.DRAWINMAP_EXPERIMENTAL_OPENCLIPART === '1';

/** 在线检索服务（node:fs 适配缓存存储；路径都约束在 cache 目录内） */
/** 缓存路径越界检查：前缀必须带分隔符对齐——否则 "…/cache-evil" 也会 startsWith
 * "…/cache" 通过（缺陷清单 Bug 1.6.6 顺带修） */
function isInsideCacheDir(filePath) {
  return filePath === referenceCacheDir || filePath.startsWith(referenceCacheDir + sep);
}
const referenceService = createOnlineReferenceService({
  storage: {
    readText: async (relativePath) => {
      const filePath = normalize(join(referenceCacheDir, relativePath));
      if (!isInsideCacheDir(filePath)) {
        return null;
      }
      try {
        return await readFile(filePath, 'utf8');
      } catch {
        return null;
      }
    },
    writeText: async (relativePath, text) => {
      const filePath = normalize(join(referenceCacheDir, relativePath));
      if (!isInsideCacheDir(filePath)) {
        throw new Error(`缓存路径越界：${relativePath}`);
      }
      await mkdir(join(filePath, '..'), { recursive: true });
      await writeFile(filePath, text, 'utf8');
    },
  },
  sources: ['phylopic'],
  experimental: { openclipart: EXPERIMENTAL_OPENCLIPART },
});

/** 城市目录（静态配置：名称+锚点，无路网数据）与按需获取服务（方案 2026-11-08 §4） */
const cityCatalog = JSON.parse(await readFile(join(root, 'config', 'city-catalog.json'), 'utf8'));
const cityFetchService = await createCityFetchService({
  cacheDir: join(root, 'data', 'city-roads'),
  catalog: cityCatalog,
  testHooksEnabled: process.env.DRAWINMAP_CITY_TEST_HOOKS === '1',
  onLog: (...args) => console.log(...args),
});

/** 日志落盘串行队列：并发 POST 时按到达顺序依次追加，避免文件内容交错 */
let appendChain = Promise.resolve();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/**
 * 读取请求体（超过上限直接拒收并报错）。
 *
 * @param {import('node:http').IncomingMessage} req 请求
 * @param {number} limit 字节上限
 * @returns {Promise<string>} 请求体文本
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) {
        return;
      }
      size += chunk.length;
      if (size > limit) {
        settled = true;
        chunks.length = 0;
        req.resume(); // 丢弃剩余数据：连接保持可写，让调用方把 413 送回客户端
        reject(new Error(`请求体超过上限 ${limit} 字节`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });
    req.on('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

/**
 * 读取并解析 JSON 请求体；失败时按统一口径直接回 413/400。
 *
 * 4 个接口（POST /__log、POST /__reference/search、POST /__city/fetch、
 * POST /__city/test/source-block）此前各手抄一遍"读体 → JSON.parse → 错误响应"；
 * 抽取后状态码、错误文案、响应头与抽取前一致（城市接口错误响应带 no-store，
 * 日志/在线检索接口不带，由 noStore 参数保持原口径）。
 *
 * @param {import('node:http').IncomingMessage} req 请求
 * @param {number} limit 字节上限
 * @param {import('node:http').ServerResponse} res 响应（失败时直接写回）
 * @param {boolean} [noStore] 错误响应是否带 Cache-Control: no-store
 * @returns {Promise<any|undefined>} 解析结果；undefined 表示已回错误响应（合法 JSON 不可能解析出 undefined）
 */
async function readJsonBody(req, limit, res, noStore = false) {
  /** 统一的 413/400 错误响应（响应头口径与抽取前逐字一致） */
  const respondError = (status, message) => {
    const headers = { 'Content-Type': 'application/json; charset=utf-8' };
    if (noStore) {
      headers['Cache-Control'] = 'no-store';
    }
    res.writeHead(status, headers);
    res.end(JSON.stringify({ ok: false, error: message }));
  };
  let body;
  try {
    body = await readBody(req, limit);
  } catch (error) {
    respondError(413, error.message);
    return undefined;
  }
  try {
    return JSON.parse(body || '{}');
  } catch {
    respondError(400, '请求体不是有效 JSON');
    return undefined;
  }
}

/** 本地日期字符串 YYYY-MM-DD（按服务器本地时区，与日志记录的 time 字段同口径） */
function localDateText(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 单条记录归属日期：优先用记录自带时间戳（跨天会话按事件发生日归档），
 * 时间戳非法时退回服务器当前日期。
 *
 * @param {object} record 日志记录
 * @returns {string} YYYY-MM-DD
 */
function recordDateText(record) {
  if (Number.isFinite(record?.ts)) {
    const date = new Date(record.ts);
    if (!Number.isNaN(date.getTime())) {
      return localDateText(date);
    }
  }
  return localDateText(new Date());
}

/**
 * 把一批记录按日期分组追加到 web/logs/*.jsonl。
 *
 * @param {Array<object>} records 日志记录
 * @returns {Promise<{written: number, files: Object<string, number>}>} 写入结果
 */
async function appendLogRecords(records) {
  await mkdir(logDir, { recursive: true });
  /** @type {Map<string, Array<object>>} 日期 → 记录列表 */
  const groups = new Map();
  for (const record of records) {
    if (!record || typeof record !== 'object') {
      continue;
    }
    const date = recordDateText(record);
    if (!groups.has(date)) {
      groups.set(date, []);
    }
    groups.get(date).push(record);
  }
  const files = {};
  let written = 0;
  for (const [date, list] of groups) {
    const file = join(logDir, `${date}.jsonl`);
    const text = `${list.map((record) => JSON.stringify(record)).join('\n')}\n`;
    await appendFile(file, text, 'utf8');
    files[`logs/${date}.jsonl`] = list.length;
    written += list.length;
  }
  return { written, files };
}

/**
 * 处理日志接口：探测（GET）与批量落盘（POST）。
 *
 * @param {import('node:http').IncomingMessage} req 请求
 * @param {import('node:http').ServerResponse} res 响应
 * @returns {Promise<boolean>} 是否已处理（false 表示交给静态文件逻辑）
 */
async function handleLogApi(req, res) {
  if (req.url.startsWith('/__log/ping') && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, dir: 'web/logs', today: `${localDateText(new Date())}.jsonl` }));
    return true;
  }
  if (req.url.startsWith('/__log') && req.method === 'POST') {
    const payload = await readJsonBody(req, MAX_LOG_BODY, res);
    if (payload === undefined) {
      return true;
    }
    const records = Array.isArray(payload) ? payload : payload?.records;
    if (!Array.isArray(records) || records.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: '缺少 records 数组' }));
      return true;
    }
    const task = appendChain.then(() => appendLogRecords(records));
    appendChain = task.catch(() => {});
    try {
      const result = await task;
      console.log(`[log] 追加 ${result.written} 条 → ${Object.keys(result.files).join('、')}`);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, ...result }));
    } catch (error) {
      console.error('[log] 写入日志文件失败：', error);
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: error.message }));
    }
    return true;
  }
  if (req.url.startsWith('/__log')) {
    res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: '仅支持 GET /__log/ping 与 POST /__log' }));
    return true;
  }
  return false;
}

/**
 * 处理参考图在线检索接口（方案 2026-10-31 §9.1）。
 *
 * @param {import('node:http').IncomingMessage} req 请求
 * @param {import('node:http').ServerResponse} res 响应
 * @returns {Promise<boolean>} 是否已处理（false 表示交给静态文件逻辑）
 */
async function handleReferenceApi(req, res) {
  if (req.url.startsWith('/__reference/ping') && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(referenceService.ping()));
    return true;
  }
  if (req.url.startsWith('/__reference/search') && req.method === 'POST') {
    const payload = await readJsonBody(req, MAX_REFERENCE_BODY, res);
    if (payload === undefined) {
      return true;
    }
    // 客户端断开（用户点"停止"）：取消对应上游工作（方案 §9.2 中止传播）。
    // 用 res 的 close 事件而不是 req 的：Node ≥16 下 handler 执行时请求体已读完，
    // req 上再注册 'close' 已错过时机，取消从未生效（缺陷清单 Bug 1.6.6）。
    const upstream = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) {
        upstream.abort(new Error('客户端已断开'));
      }
    });
    try {
      const result = await referenceService.search({
        referenceQuery: payload?.referenceQuery ?? null,
        maxAttempts: payload?.maxAttempts,
        signal: upstream.signal,
      });
      console.log(
        `[reference] 检索 "${result.query?.zh || result.query?.en || '?'}" → raw ${result.rawCandidates.length}` +
          `（pool ${result.poolSize}，cache ${result.cache?.query ?? '-'}）`,
      );
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(result));
    } catch (error) {
      console.error('[reference] 检索失败：', error);
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: `在线检索失败：${error.message}` }));
    }
    return true;
  }
  if (req.url.startsWith('/__reference')) {
    res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: '仅支持 GET /__reference/ping 与 POST /__reference/search' }));
    return true;
  }
  return false;
}

/**
 * 处理城市路网按需获取接口（方案 2026-11-08 §4.3）。
 *
 * - GET  /__city/catalog           目录 + 各城缓存状态
 * - POST /__city/fetch             发起获取 {cityId} → {jobId, reused}
 * - GET  /__city/job/<id>          作业进度（queued/running/done/failed）
 * - GET  /__city/jobs              全部作业摘要
 * - GET  /__city/cache             缓存文件清单
 * - POST /__city/test/source-block {on} 测试开关（仅 DRAWINMAP_CITY_TEST_HOOKS=1 可用）
 *
 * @param {import('node:http').IncomingMessage} req 请求
 * @param {import('node:http').ServerResponse} res 响应
 * @returns {Promise<boolean>} 是否已处理（false 表示交给静态文件逻辑）
 */
async function handleCityApi(req, res) {
  const json = (status, payload) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(payload));
  };
  if (req.url.startsWith('/__city/catalog') && req.method === 'GET') {
    json(200, {
      ok: true,
      presetCityId: cityCatalog.presetCityId,
      fetchHalfSpanDeg: cityCatalog.fetchHalfSpanDeg,
      cities: cityCatalog.cities,
      cache: cityFetchService.cacheStates(),
      jobs: cityFetchService.jobSummaries(),
    });
    return true;
  }
  if (req.url.startsWith('/__city/fetch') && req.method === 'POST') {
    const payload = await readJsonBody(req, MAX_REFERENCE_BODY, res, true);
    if (payload === undefined) {
      return true;
    }
    try {
      const result = cityFetchService.startFetch(String(payload?.cityId ?? ''));
      json(200, { ok: true, ...result });
    } catch (error) {
      json(400, { ok: false, error: error.message });
    }
    return true;
  }
  const jobMatch = req.url.match(/^\/__city\/job\/([\w-]+)$/);
  if (jobMatch && req.method === 'GET') {
    const status = cityFetchService.jobStatus(jobMatch[1]);
    if (!status) {
      json(404, { ok: false, error: `作业不存在：${jobMatch[1]}（服务重启会丢失内存作业）` });
      return true;
    }
    json(200, { ok: true, job: status });
    return true;
  }
  if (req.url.startsWith('/__city/jobs') && req.method === 'GET') {
    json(200, { ok: true, jobs: cityFetchService.jobSummaries() });
    return true;
  }
  if (req.url.startsWith('/__city/cache') && req.method === 'GET') {
    json(200, { ok: true, cache: cityFetchService.cacheStates() });
    return true;
  }
  if (req.url.startsWith('/__city/test/source-block') && req.method === 'POST') {
    const payload = await readJsonBody(req, MAX_REFERENCE_BODY, res, true);
    if (payload === undefined) {
      return true;
    }
    try {
      json(200, { ok: true, ...cityFetchService.setTestBlock(Boolean(payload?.on)) });
    } catch (error) {
      json(400, { ok: false, error: error.message });
    }
    return true;
  }
  if (req.url.startsWith('/__city')) {
    json(405, { ok: false, error: '仅支持 /__city/catalog、/__city/fetch、/__city/job/<id>、/__city/jobs、/__city/cache 与 /__city/test/source-block' });
    return true;
  }
  return false;
}

createServer(async (req, res) => {
  try {
    if (await handleLogApi(req, res)) {
      return;
    }
    if (await handleReferenceApi(req, res)) {
      return;
    }
    if (await handleCityApi(req, res)) {
      return;
    }
    let urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (urlPath.endsWith('/')) {
      urlPath += 'index.html';
    }
    const filePath = normalize(join(root, urlPath));
    if (!filePath.startsWith(root)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const data = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, '127.0.0.1', () => {
  console.log(
    `[server] http://127.0.0.1:${port}/ （Cache-Control: no-store，刷新即最新代码；日志落盘 → web/logs/*.jsonl）`,
  );
});
