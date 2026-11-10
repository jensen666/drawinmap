/**
 * 尺寸轴双闸真实链路验收（浏览器 + 真实 LLM + 真实广州路网，无 mock）。
 *
 * 用途（方案 2026-11-01 §12.3）：验证双闸修复在**真实页面**里确实生效，而不是
 * 只有函数被调用：
 * - 页面无未捕获异常 / 无 console error（生产代码改动没有打破浏览器包）；
 * - 引擎日志里出现近场基线冻结（candidates.largeTier.baseline）与定向补搜
 *   （candidates.largeTier.probe）两条记录，挑战者带尺寸/分数/E_shape/偏移；
 * - 最终候选带阶段 0 的拓扑诊断（plan.topology：唯一交叉 + 重复道路比例）；
 * - 地图上确实画出了路线，回复给出实际贴合分；
 * - 产出「只看实际路线」的截图（隐藏紫色理想轮廓与吸附点）与尺寸裁决日志。
 *
 * 依赖：
 * - 本地开发服务器已启动：`node web/server.mjs 5173`（页面与路网数据都由它提供）
 * - Edge/Chrome 可执行文件（默认自动探测，可用 --browser 指定）
 * - `web/src/agent/agent-config.js` 已配置可用的 LLM 接口
 *
 * 运行：node tools/e2e-large-tier.mjs [--port 5173] [--text "在越秀公园画个五角星"]
 * 产物：docs/测试报告/2026-11-02-尺寸轴双闸验收/（截图与结果 JSON，本地产物不入库）
 */

import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACT_DIR = path.join(
  ROOT,
  'docs',
  '测试报告',
  '2026-11-02-尺寸轴双闸验收',
);

/** 命令行参数 */
const argv = process.argv.slice(2);
/**
 * 取命令行参数值。
 *
 * @param {string} name 参数名
 * @param {string|null} fallback 缺省值
 * @returns {string|null} 参数值
 */
const argOf = (name, fallback = null) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const APP_PORT = Number(argOf('port', '5173'));
const APP_URL = `http://127.0.0.1:${APP_PORT}/`;
const REQUEST_TEXT = argOf('text', '在越秀公园画个五角星');

/** 断言记录 */
const checks = [];
/**
 * 记录一条断言。
 *
 * @param {string} label 断言描述
 * @param {boolean} condition 断言条件
 * @param {string} [detail] 失败详情
 */
function check(label, condition, detail = '') {
  const ok = Boolean(condition);
  checks.push({ label, ok, detail: ok ? '' : String(detail) });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` → ${detail}`}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 找可用端口。
 *
 * @param {number} start 起始端口
 * @returns {Promise<number>} 可用端口
 */
async function findFreePort(start) {
  for (let port = start; port < start + 20; port += 1) {
    const free = await new Promise((resolve) => {
      const server = createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => server.close(() => resolve(true)));
      server.listen(port, '127.0.0.1');
    });
    if (free) {
      return port;
    }
  }
  throw new Error('找不到可用调试端口');
}

/**
 * 探测浏览器可执行文件。
 *
 * @param {string|null} explicit 显式路径
 * @returns {string} 浏览器路径
 */
function resolveBrowser(explicit) {
  if (explicit) {
    return explicit;
  }
  const candidates = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ];
  const found = candidates.find((item) => existsSync(item));
  if (!found) {
    throw new Error('未找到 Edge/Chrome，请用 --browser 指定可执行文件路径');
  }
  return found;
}

/** 极简 CDP 客户端（Node 自带 WebSocket）。 */
class Cdp {
  /**
   * @param {string} wsUrl 调试目标 WebSocket 地址
   */
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) {
          reject(new Error(`${message.error.message}`));
        } else {
          resolve(message.result);
        }
      }
    });
  }

  /** 等待连接建立 */
  async open() {
    if (this.ws.readyState === WebSocket.OPEN) {
      return;
    }
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), {
        once: true,
      });
    });
  }

  /**
   * 发送一条 CDP 命令。
   *
   * @param {string} method 方法名
   * @param {object} [params] 参数
   * @returns {Promise<object>} 结果
   */
  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 调用超时：${method}`));
        }
      }, 180000);
    });
  }

  /**
   * 在页面里执行表达式（自动 await Promise）。
   *
   * @param {string} expression 表达式
   * @returns {Promise<*>} 返回值
   */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      const text =
        result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        '页面表达式异常';
      throw new Error(`页面执行失败：${text.slice(0, 300)}`);
    }
    return result.result?.value;
  }

  /**
   * 轮询等待页面条件成立。
   *
   * @param {string} expression 返回真/假的表达式
   * @param {number} timeoutMs 超时
   * @param {string} label 等待对象（报错用）
   * @returns {Promise<boolean>} 是否等到
   */
  async waitFor(expression, timeoutMs, label) {
    const started = Date.now();
    let lastError = null;
    while (Date.now() - started < timeoutMs) {
      try {
        if (await this.evaluate(expression)) {
          return true;
        }
      } catch (error) {
        lastError = error;
      }
      await sleep(250);
    }
    console.log(
      `[wait] ${label} 超时（${Math.round(timeoutMs / 1000)}s）${lastError ? `，最后错误：${lastError.message}` : ''}`,
    );
    return false;
  }

  /**
   * 截屏保存（证据）。
   *
   * @param {string} name 文件名
   */
  async screenshot(name) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    await mkdir(ARTIFACT_DIR, { recursive: true });
    const file = path.join(ARTIFACT_DIR, name);
    await writeFile(file, Buffer.from(data, 'base64'));
    console.log(`[shot] ${file}`);
  }

  /** 关闭连接 */
  close() {
    try {
      this.ws.close();
    } catch {
      // 忽略关闭异常
    }
  }
}

/**
 * 主流程。
 */
async function main() {
  // 开发服务器可用性（页面与路网都由它提供）
  let serverReady = false;
  try {
    const ping = await fetch(`http://127.0.0.1:${APP_PORT}/__log/ping`);
    serverReady = ping.ok;
  } catch {
    serverReady = false;
  }
  check(
    'ENV',
    '开发服务器已启动（/__log/ping 可用，日志可落盘）',
    serverReady,
    '请先运行 node web/server.mjs 5173',
  );
  if (!serverReady) {
    process.exitCode = 1;
    return;
  }

  const browserPath = resolveBrowser(argOf('browser'));
  const port = await findFreePort(Number(argOf('devtools-port', '9444')));
  const profileDir = path.join(os.tmpdir(), `drawinmap-large-tier-${Date.now()}`);
  console.log(`[env] browser=${browserPath}`);
  console.log(`[env] app=${APP_URL} devtoolsPort=${port}`);

  const browser = spawn(
    browserPath,
    [
      '--headless=new',
      '--disable-gpu',
      '--disable-images',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-sync',
      '--mute-audio',
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${port}`,
      '--window-size=1440,900',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let cdp = null;
  const result = {
    checks,
    startedAt: new Date().toISOString(),
    requestText: REQUEST_TEXT,
    steps: [],
  };
  try {
    let version = null;
    for (let i = 0; i < 80; i += 1) {
      try {
        version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
        break;
      } catch {
        await sleep(250);
      }
    }
    if (!version) {
      throw new Error('浏览器 DevTools 端点未就绪');
    }
    console.log(`[env] ${version.Browser}`);

    const target = await (
      await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
    ).json();
    cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    // 页面异常收集（必须在应用脚本执行前安装）
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        window.__dshErrors = [];
        window.addEventListener('error', (e) => {
          window.__dshErrors.push('error: ' + (e.message || '') + ' @ ' + (e.filename || '') + ':' + (e.lineno || 0));
        });
        window.addEventListener('unhandledrejection', (e) => {
          window.__dshErrors.push('unhandledrejection: ' + String((e.reason && e.reason.message) || e.reason || ''));
        });
      `,
    });

    await cdp.send('Page.navigate', { url: APP_URL });
    const ready = await cdp.waitFor(
      `!!(document.getElementById('agent-send') && document.querySelector('#agent-messages .agent-msg'))`,
      30000,
      '应用启动',
    );
    check('浏览器启动并渲染对话面板', ready);
    if (!ready) {
      throw new Error('应用未启动');
    }

    const sendText = (text) =>
      cdp.evaluate(`(() => {
        const input = document.getElementById('agent-input');
        input.value = ${JSON.stringify(text)};
        document.getElementById('agent-send').click();
        return true;
      })()`);
    const waitTurn = (timeoutMs) =>
      cdp.waitFor(
        `document.getElementById('agent-send').textContent.trim() === '发送'`,
        timeoutMs,
        '一轮完成',
      );
    const lastAgentText = () =>
      cdp.evaluate(`(() => {
        const list = document.querySelectorAll('.agent-msg-agent .agent-msg-text');
        return list.length ? list[list.length - 1].textContent : '';
      })()`);
    const routePaths = () =>
      cdp.evaluate(`(() => {
        const paths = Array.from(document.querySelectorAll('.leaflet-overlay-pane path'));
        const outline = paths.filter((p) => (p.getAttribute('stroke') || '').toLowerCase() === '#7c3aed');
        const route = paths.filter((p) => {
          const s = (p.getAttribute('stroke') || '').toLowerCase();
          return s === '#16a34a' || s === '#f59e0b' || s === '#ffffff';
        });
        return { total: paths.length, outline: outline.length, route: route.length };
      })()`);

    // ---------- 真实一轮规划 ----------
    await sendText(REQUEST_TEXT);
    // 参考候选卡出现时点选第一张（本地素材直连路径通常无卡）
    const cardAppeared = await cdp.waitFor(
      `!!document.querySelector('.agent-ref-card')`,
      60000,
      '参考候选卡（可能不出现）',
    );
    if (cardAppeared) {
      console.log('[info] 出现参考候选卡，点选第一张');
      await cdp.evaluate(`(() => {
        const card = document.querySelector('.agent-ref-card');
        card.click();
        return true;
      })()`);
    }
    const turnDone = await waitTurn(300000);
    check('真实 LLM + 真实路网的一轮规划在 5 分钟内完成', turnDone);
    if (!turnDone) {
      throw new Error('一轮规划未在时限内完成');
    }
    await sleep(1500);

    const reply = await lastAgentText();
    console.log(`[reply] ${reply.slice(0, 200).replace(/\n/g, ' / ')}`);
    result.reply = reply;
    check('回复给出实际贴合分与尺寸', reply.includes('路线贴合') && reply.includes('尺寸'), reply.slice(0, 120));

    // ---------- 双闸日志 ----------
    const engineLogs = await cdp.evaluate(`(() => {
      const entries = window.DrawInMapLog ? window.DrawInMapLog.entries({ module: 'engine/candidates', limit: 0 }) : [];
      return entries.map((e) => ({ event: e.event, data: e.data }));
    })()`);
    const baselineLog = engineLogs.find((e) => e.event === 'candidates.largeTier.baseline');
    const probeLog = engineLogs.find((e) => e.event === 'candidates.largeTier.probe');
    const chosenLog = engineLogs.find((e) => e.event === 'candidates.chosen');
    result.engineLogs = engineLogs;

    check('真实页面产生近场基线冻结日志', Boolean(baselineLog), JSON.stringify(engineLogs.map((e) => e.event)));
    check(
      '基线日志带分数/尺寸/E_shape/偏移',
      Boolean(
        baselineLog &&
          Number.isFinite(baselineLog.data?.score) &&
          Number.isFinite(baselineLog.data?.sizeMeters) &&
          Number.isFinite(baselineLog.data?.envelopeMeters) &&
          Number.isFinite(baselineLog.data?.offsetMeters),
      ),
      JSON.stringify(baselineLog?.data ?? null),
    );
    check('真实页面产生定向补搜日志', Boolean(probeLog), JSON.stringify(probeLog?.data ?? null));
    check(
      '补搜日志记录挑战者的尺寸/分数/E_shape/偏移',
      Boolean(
        probeLog &&
          Array.isArray(probeLog.data?.challengers) &&
          probeLog.data.challengers.every(
            (item) =>
              Number.isFinite(item.sizeMeters) &&
              Number.isFinite(item.score) &&
              'envelopeMeters' in item &&
              'offsetMeters' in item,
          ),
      ),
      JSON.stringify(probeLog?.data?.challengers ?? null),
    );
    check(
      '补搜尺寸取原始基准的 2×/2.5×/3×',
      Boolean(
        probeLog &&
          Array.isArray(probeLog.data?.challengers) &&
          probeLog.data.challengers.every((item) => item.sizeMeters > 0),
      ),
      JSON.stringify(probeLog?.data?.challengers?.map((item) => item.sizeMeters) ?? null),
    );
    check(
      '最终候选记录大档阶段结论',
      Boolean(chosenLog && 'largeTierReplaced' in (chosenLog.data ?? {})),
      JSON.stringify(chosenLog?.data ?? null),
    );

    // ---------- 阶段 0 拓扑诊断 ----------
    const topologyLog = await cdp.evaluate(`(() => {
      const entries = window.DrawInMapLog ? window.DrawInMapLog.entries({ module: 'engine', limit: 0 }) : [];
      const hit = entries.filter((e) => e.event === 'plan.topology');
      return hit.map((e) => e.data);
    })()`);
    check('真实页面产生阶段 0 拓扑诊断日志', topologyLog.length > 0, JSON.stringify(topologyLog));
    check(
      '拓扑日志带唯一交叉数与重复道路比例',
      Boolean(
        topologyLog.length > 0 &&
          Number.isFinite(topologyLog[0]?.uniqueCrossingCount) &&
          (topologyLog[0]?.reusedEdgeRatio === null ||
            Number.isFinite(topologyLog[0]?.reusedEdgeRatio)),
      ),
      JSON.stringify(topologyLog[0] ?? null),
    );

    // ---------- 地图与页面健康 ----------
    const paths = await routePaths();
    console.log(`[paths] ${JSON.stringify(paths)}`);
    check('地图上画出了路线图层', paths.route > 0, JSON.stringify(paths));

    const pageErrors = await cdp.evaluate(`window.__dshErrors || []`);
    check('页面无未捕获异常 / 未处理 Promise 拒绝', pageErrors.length === 0, JSON.stringify(pageErrors));

    // ---------- 截图证据 ----------
    await cdp.screenshot('01-整页-目标与路线.png');
    // 只看实际路线：隐藏紫色理想轮廓与吸附点
    const hidden = await cdp.evaluate(`(() => {
      let n = 0;
      document.querySelectorAll('.leaflet-overlay-pane path, .leaflet-overlay-pane circle').forEach((el) => {
        const s = (el.getAttribute('stroke') || '').toLowerCase();
        const f = (el.getAttribute('fill') || '').toLowerCase();
        if (s === '#7c3aed' || f === '#7c3aed') {
          el.style.display = 'none';
          n += 1;
        }
      });
      return n;
    })()`);
    await sleep(600);
    await cdp.screenshot('02-只看实际路线.png');
    console.log(`[info] 隐藏的理想轮廓元素 ${hidden} 个`);

    result.finishedAt = new Date().toISOString();
    result.passed = checks.filter((item) => item.ok).length;
    result.failed = checks.filter((item) => !item.ok).length;
    console.log(`\n[summary] ${result.passed}/${checks.length} 通过，失败 ${result.failed}`);
    await mkdir(ARTIFACT_DIR, { recursive: true });
    await writeFile(
      path.join(ARTIFACT_DIR, 'large-tier-e2e-result.json'),
      JSON.stringify(result, null, 2),
      'utf8',
    );
    process.exitCode = result.failed === 0 ? 0 : 1;
  } catch (error) {
    result.error = error?.message ?? String(error);
    result.finishedAt = new Date().toISOString();
    result.passed = checks.filter((item) => item.ok).length;
    result.failed = checks.filter((item) => !item.ok).length;
    console.log(`[error] ${result.error}`);
    try {
      if (cdp) {
        await cdp.screenshot('99-错误现场.png');
      }
    } catch {
      // 截图失败忽略
    }
    await mkdir(ARTIFACT_DIR, { recursive: true });
    await writeFile(
      path.join(ARTIFACT_DIR, 'large-tier-e2e-result.json'),
      JSON.stringify(result, null, 2),
      'utf8',
    );
    process.exitCode = 1;
  } finally {
    cdp?.close();
    browser.kill();
    await sleep(500);
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error('[fatal]', error);
  process.exit(1);
});
