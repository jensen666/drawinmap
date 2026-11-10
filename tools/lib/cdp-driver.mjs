/**
 * 公共 CDP 驱动（清理方案 2026-11-09 §5.5-3）。
 *
 * 此前 8 个真实浏览器驱动各自内置一份"极简 CDP 客户端"（连接 / send / evaluate /
 * waitFor / screenshot），彼此 0 互引、约 5,300 行重复基建；其中"共享单例 onmessage
 * 被覆盖"式的缺陷要修 N 遍。这里抽成单一实现，各驱动按需复用。
 *
 * 用法：
 *   const { Cdp, resolveBrowser, findFreePort, launchBrowser } = await import('../lib/cdp-driver.mjs');
 *   const { browser, wsUrl, version, kill } = await launchBrowser({
 *     browserPath, port, userDataDir, windowSize: { width: 1440, height: 900 }, openPage: true,
 *   });
 *   const cdp = new Cdp(wsUrl, { artifactDir, timeoutMs: 180000 });
 *   await cdp.open();
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';

/** 探测浏览器可执行文件。
 *
 * @param {string|null} explicit 显式路径
 * @returns {string} 浏览器路径
 */
export function resolveBrowser(explicit) {
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

/**
 * 找可用端口。
 *
 * @param {number} start 起始端口
 * @returns {Promise<number>} 可用端口
 */
export async function findFreePort(start) {
  for (let port = start; port < start + 30; port += 1) {
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
 * 等待一小段时间。
 *
 * @param {number} ms 毫秒
 * @returns {Promise<void>} resolve
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 极简 CDP 客户端（Node 自带 WebSocket） */
export class Cdp {
  /**
   * @param {string} wsUrl 浏览器调试 WebSocket 地址
   * @param {{artifactDir?: string, timeoutMs?: number}} [options] 选项
   */
  constructor(wsUrl, { artifactDir = null, timeoutMs = 120000 } = {}) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.artifactDir = artifactDir;
    this.timeoutMs = timeoutMs;
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) {
          reject(new Error(`${message.error.message} (${JSON.stringify(message.error.data ?? '')})`));
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
      this.ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true });
    });
  }

  /**
   * 发送一条 CDP 命令。
   *
   * 超时定时器**必须在 settle 时清掉**：否则每次成功调用都会留下一个
   * `timeoutMs`（默认 120s）的空转定时器，进程在用例跑完后还要再挂两分钟才退出，
   * 自动化里会被误判成"跑超时"。
   *
   * @param {string} method 方法名
   * @param {object} [params] 参数
   * @returns {Promise<object>} 结果
   */
  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 调用超时：${method}`));
        }
      }, this.timeoutMs);
      /** 结算时统一清定时器 */
      const settle = (fn) => (value) => {
        clearTimeout(timer);
        fn(value);
      };
      this.pending.set(id, {
        resolve: settle(resolve),
        reject: settle(reject),
        timer,
      });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
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
      const text = result.exceptionDetails.exception?.description
        || result.exceptionDetails.text
        || '页面表达式异常';
      throw new Error(`页面执行失败：${text.slice(0, 400)}`);
    }
    return result.result?.value;
  }

  /**
   * 轮询等待页面条件成立。
   *
   * @param {string} expression 返回真/假的表达式
   * @param {number} timeoutMs 超时
   * @param {string} label 等待对象（报错用）
   * @param {number} [intervalMs] 轮询间隔
   * @returns {Promise<boolean>} 是否等到
   */
  async waitFor(expression, timeoutMs, label, intervalMs = 300) {
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
      await sleep(intervalMs);
    }
    console.log(`  [wait] ${label} 超时（${Math.round(timeoutMs / 1000)}s）${lastError ? `，最后错误：${lastError.message}` : ''}`);
    return false;
  }

  /**
   * 截屏保存（证据）。
   *
   * @param {string} name 文件名
   * @returns {Promise<string>} 文件名
   */
  async screenshot(name) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    if (!this.artifactDir) {
      return name;
    }
    await mkdir(this.artifactDir, { recursive: true });
    const file = join(this.artifactDir, name);
    await writeFile(file, Buffer.from(data, 'base64'));
    console.log(`  [shot] ${basename(file)}`);
    return basename(file);
  }

  /** 关闭连接（并清掉在途调用的超时定时器，避免进程被吊住） */
  close() {
    for (const [, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      try {
        entry.reject(new Error('CDP 连接已关闭'));
      } catch {
        // 忽略
      }
    }
    this.pending.clear();
    try {
      this.ws.close();
    } catch {
      // 忽略关闭异常
    }
  }
}

/**
 * 启动浏览器并等待调试端口就绪。
 *
 * 四个 E2E 驱动的"启动段"统一收口到这里（清理方案 2026-11-09 §3.2 B5）：
 * - 固定带上各驱动原本都相同的 禁用扩展 / 禁用同步 / 静音 参数；
 * - `windowSize` 支持窗口尺寸（原 4 个驱动都写死 `--window-size=1440,900`）；
 * - `openPage` 为 true 时额外创建一个 about:blank 页面 target，并把 `wsUrl` 指向
 *   页面级 WS 地址——原驱动连的都是 `/json/new` 出来的 page target，不是浏览器级 target；
 * - 返回 `version`（`/json/version` 的解析结果），供驱动打印 `version.Browser`。
 *
 * @param {object} options 选项
 * @param {string} options.browserPath 浏览器可执行文件
 * @param {number} options.port 调试端口
 * @param {string} [options.userDataDir] 用户数据目录（不传则用临时目录）
 * @param {{width: number, height: number}|null} [options.windowSize] 窗口尺寸（不传则用浏览器默认）
 * @param {boolean} [options.openPage] 是否创建 about:blank 页面 target
 * @returns {Promise<{browser: object, wsUrl: string, browserWsUrl: string, version: object, userDataDir: string, kill: () => void}>} 浏览器句柄
 */
export async function launchBrowser({
  browserPath,
  port,
  userDataDir = null,
  windowSize = null,
  openPage = false,
}) {
  const dataDir = userDataDir || join(process.env.TEMP || '.', `drawinmap-cdp-${port}`);
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--mute-audio',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${dataDir}`,
  ];
  if (windowSize) {
    args.push(`--window-size=${windowSize.width},${windowSize.height}`);
  }
  args.push('about:blank');
  const browser = spawn(browserPath, args, { stdio: 'ignore' });

  // 等调试端口起来
  let browserWsUrl = null;
  let version = null;
  for (let i = 0; i < 100; i += 1) {
    await sleep(200);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      const info = await res.json();
      if (info.webSocketDebuggerUrl) {
        browserWsUrl = info.webSocketDebuggerUrl;
        version = info;
        break;
      }
    } catch {
      // 还没起来，继续等
    }
  }
  if (!browserWsUrl) {
    browser.kill();
    throw new Error('浏览器调试端口未就绪');
  }

  // 需要连页面级 target 的驱动：新建 about:blank 页（与旧驱动 `/json/new` 行为一致）
  let pageWsUrl = null;
  if (openPage) {
    try {
      const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
      pageWsUrl = target.webSocketDebuggerUrl ?? null;
    } catch {
      pageWsUrl = null;
    }
    if (!pageWsUrl) {
      browser.kill();
      throw new Error('浏览器页面 target 创建失败');
    }
  }

  return {
    browser,
    wsUrl: pageWsUrl || browserWsUrl,
    browserWsUrl,
    version,
    userDataDir: dataDir,
    kill: () => {
      try {
        browser.kill();
      } catch {
        // 忽略
      }
    },
  };
}
