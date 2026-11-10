/**
 * T-B4a：server.mjs 请求体读取 4→1 的等价性集成测试（清理方案 2026-11-09 §3.2 B4）。
 *
 * 背景：`web/server.mjs` 的 4 个 POST 接口（/__log、/__reference/search、/__city/fetch、
 * /__city/test/source-block）此前各手抄一遍"读体 → JSON.parse → 413/400 响应"；
 * 抽取 `readJsonBody()` 后必须保持：**状态码、错误文案、响应头**与抽取前一致，
 * 且合法 JSON 继续进入各自业务分支。
 *
 * 做法：spawn 真实 `web/server.mjs`（端口用随机空闲端口，**不占用 5173**），
 * 用真实 http fetch 打接口；测试结束 kill 并等退出。不 mock 任何服务端点、不访问外网
 * （合法 JSON 用 `referenceQuery:null`，服务端直接返回空候选，不触发上游检索）。
 *
 * 运行：node test/server-body.mjs
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

let checks = 0;
let failures = 0;

/**
 * 断言工具：记录通过/失败计数（失败必须体现在退出码里）。
 *
 * @param {string} label 断言描述
 * @param {boolean} condition 是否通过
 * @param {string} [detail] 失败详情
 */
function check(label, condition, detail = '') {
  checks += 1;
  const ok = Boolean(condition);
  if (!ok) {
    failures += 1;
  }
  console.log(`[check] ${label} -> ${ok ? 'PASS' : `FAIL ${detail}`}`);
}

/**
 * 取一个随机空闲端口（listen(0) 后立即释放；避免与 5173 / 现有用例端口冲突）。
 *
 * @returns {Promise<number>} 端口号
 */
function findFreePort() {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.once('error', rejectPort);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

/**
 * 等待服务器 /__log/ping 就绪（轮询真实 HTTP，不靠固定 sleep）。
 *
 * @param {string} baseUrl 服务根地址
 * @param {import('node:child_process').ChildProcess} child 服务器进程
 * @param {() => string} outputOf 读取已捕获输出
 * @param {number} [timeoutMs] 超时
 * @returns {Promise<void>}
 */
async function waitForServer(baseUrl, child, outputOf, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`服务器提前退出（exit=${child.exitCode}）：${outputOf()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/__log/ping`);
      if (response.ok) {
        return;
      }
    } catch {
      // 尚未监听：继续轮询
    }
    if (Date.now() > deadline) {
      throw new Error(`服务器启动超时：${outputOf()}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
}

/**
 * POST JSON 文本并解析响应。
 *
 * @param {string} url 地址
 * @param {string} body 请求体文本
 * @returns {Promise<{status: number, headers: Headers, json: any, text: string}>} 响应
 */
async function postBody(url, body) {
  const response = await fetch(url, { method: 'POST', body });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, json, text };
}

const port = await findFreePort();
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [join(ROOT, 'web/server.mjs'), String(port)], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (chunk) => {
  output += String(chunk);
});
child.stderr.on('data', (chunk) => {
  output += String(chunk);
});

try {
  await waitForServer(baseUrl, child, () => output);

  // ---------- 探测与目录接口（只读，不触发业务写盘/外网） ----------
  {
    const ping = await fetch(`${baseUrl}/__log/ping`);
    const body = await ping.json();
    check('GET /__log/ping → 200 且 ok=true', ping.status === 200 && body.ok === true, JSON.stringify(body));
  }
  {
    const catalog = await fetch(`${baseUrl}/__city/catalog`);
    const body = await catalog.json();
    check(
      'GET /__city/catalog → 200 且 JSON 可解析（297 城目录）',
      catalog.status === 200 &&
        body.ok === true &&
        Array.isArray(body.cities) &&
        body.cities.length === 297 &&
        body.presetCityId === 'guangzhou',
      `status=${catalog.status} cities=${body?.cities?.length}`,
    );
  }

  // ---------- /__reference/search：读体抽取点 1（jsonErrorResponder 口径） ----------
  {
    const bad = await postBody(`${baseUrl}/__reference/search`, '{not json');
    check(
      'POST /__reference/search 非法 JSON → 400 + 统一错误文案',
      bad.status === 400 && bad.json?.ok === false && bad.json?.error === '请求体不是有效 JSON',
      `status=${bad.status} body=${bad.text.slice(0, 120)}`,
    );
    check(
      '/__reference/search 错误响应头与改前一致（JSON、无 Cache-Control）',
      String(bad.headers.get('content-type') || '').includes('application/json') &&
        bad.headers.get('cache-control') === null,
      `content-type=${bad.headers.get('content-type')} cache-control=${bad.headers.get('cache-control')}`,
    );

    const huge = await postBody(`${baseUrl}/__reference/search`, JSON.stringify({ pad: 'x'.repeat(100 * 1024) }));
    check(
      'POST /__reference/search 请求体超 64KB 上限 → 413 + 超限文案',
      huge.status === 413 && huge.json?.ok === false && String(huge.json?.error).includes('超过上限'),
      `status=${huge.status} body=${huge.text.slice(0, 120)}`,
    );

    const valid = await postBody(`${baseUrl}/__reference/search`, JSON.stringify({ referenceQuery: null }));
    check(
      'POST /__reference/search 合法 JSON → 2xx（进入业务分支，无效查询返回空候选）',
      valid.status === 200 && valid.json?.ok === true && Array.isArray(valid.json?.rawCandidates) && valid.json.rawCandidates.length === 0,
      `status=${valid.status} body=${valid.text.slice(0, 160)}`,
    );
  }

  // ---------- /__log：读体抽取点 2（jsonErrorResponder 口径；不写日志文件） ----------
  {
    const bad = await postBody(`${baseUrl}/__log`, '{not json');
    check(
      'POST /__log 非法 JSON → 400 + 统一错误文案',
      bad.status === 400 && bad.json?.error === '请求体不是有效 JSON',
      `status=${bad.status} body=${bad.text.slice(0, 120)}`,
    );
    const noRecords = await postBody(`${baseUrl}/__log`, '{}');
    check(
      'POST /__log 合法 JSON 但缺 records → 400 业务错误（证明已通过解析分支）',
      noRecords.status === 400 && noRecords.json?.error === '缺少 records 数组',
      `status=${noRecords.status} body=${noRecords.text.slice(0, 120)}`,
    );
  }

  // ---------- /__city/fetch：读体抽取点 3（jsonError 口径，带 no-store） ----------
  {
    const bad = await postBody(`${baseUrl}/__city/fetch`, '{not json');
    check(
      'POST /__city/fetch 非法 JSON → 400 + 统一错误文案',
      bad.status === 400 && bad.json?.error === '请求体不是有效 JSON',
      `status=${bad.status} body=${bad.text.slice(0, 120)}`,
    );
    const huge = await postBody(`${baseUrl}/__city/fetch`, JSON.stringify({ pad: 'x'.repeat(100 * 1024) }));
    check(
      'POST /__city/fetch 请求体超上限 → 413',
      huge.status === 413 && huge.json?.ok === false && String(huge.json?.error).includes('超过上限'),
      `status=${huge.status} body=${huge.text.slice(0, 120)}`,
    );
    check(
      '/__city/fetch 错误响应头与改前一致（JSON + no-store）',
      String(bad.headers.get('content-type') || '').includes('application/json') &&
        bad.headers.get('cache-control') === 'no-store',
      `content-type=${bad.headers.get('content-type')} cache-control=${bad.headers.get('cache-control')}`,
    );
    const emptyCity = await postBody(`${baseUrl}/__city/fetch`, JSON.stringify({ cityId: '' }));
    check(
      'POST /__city/fetch 合法 JSON → 进入业务分支（空 cityId 返回 400 业务错误）',
      emptyCity.status === 400 && emptyCity.json?.error !== '请求体不是有效 JSON' && Boolean(emptyCity.json?.error),
      `status=${emptyCity.status} body=${emptyCity.text.slice(0, 160)}`,
    );
  }

  // ---------- /__city/test/source-block：读体抽取点 4（测试开关默认关闭） ----------
  {
    const bad = await postBody(`${baseUrl}/__city/test/source-block`, '{not json');
    check(
      'POST /__city/test/source-block 非法 JSON → 400 + 统一错误文案',
      bad.status === 400 && bad.json?.error === '请求体不是有效 JSON',
      `status=${bad.status} body=${bad.text.slice(0, 120)}`,
    );
    const valid = await postBody(`${baseUrl}/__city/test/source-block`, JSON.stringify({ on: false }));
    check(
      'POST /__city/test/source-block 合法 JSON → 进入业务分支（开关未启用返回 400 业务错误）',
      valid.status === 400 && valid.json?.error !== '请求体不是有效 JSON' && Boolean(valid.json?.error),
      `status=${valid.status} body=${valid.text.slice(0, 160)}`,
    );
  }
} catch (error) {
  failures += 1;
  console.log(`[fatal] ${error?.stack || error}`);
} finally {
  child.kill();
  await new Promise((resolveExit) => {
    const timer = setTimeout(() => resolveExit(), 5000);
    child.once('close', () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
}

console.log(`\n[summary] checks=${checks} failures=${failures}`);
if (failures > 0) {
  process.exitCode = 1;
}
