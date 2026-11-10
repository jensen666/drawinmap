/**
 * LLM 配置功能 E2E 验收（真实浏览器 + 真实 LLM + 真实链路，需求 2026-11-09 §7）。
 *
 * 14 例：E2E-01 ～ E2E-14（逐例断言见需求 §7.5 表格原文 + 追加需求「获取模型」；本工具不 mock、不拦截、
 * 不替换请求响应、不用固定回复凑通过；每例独立会话并清空浏览器中的页面配置）。
 *
 * 运行：
 *   node tools/e2e-llm-config.mjs                      # 全量 13 例（E2E-12 排在最后）
 *   node tools/e2e-llm-config.mjs --list               # 列出用例
 *   node tools/e2e-llm-config.mjs --cases E2E-01,E2E-02
 *   node tools/e2e-llm-config.mjs --keep-open --keep-server
 *
 * 前置：
 * - 本地服务（默认自起 5191；已在跑则复用）：`node web/server.mjs 5191`；
 * - `web/src/agent/agent-config.js`（含真实密钥，gitignored）；
 * - Edge/Chrome（自动探测，可用 --browser 指定）；独立 CDP 调试端口（默认 9339）。
 *
 * 产物（截图 png / 结果 json 均被 .gitignore 忽略）：
 *   docs/测试报告/2026-11-09-LLM配置功能验收/result-llm-config.json
 *   docs/测试报告/2026-11-09-LLM配置功能验收/E2E-xx-*.png
 *
 * 安全：真实密钥只在 Node 内存与浏览器页面内使用——不写进结果 JSON、截图、
 * 控制台、URL 或任何文件；所有落盘文本统一经 deepRedact() 脱敏。
 *
 * 第二套配置（需求 §7.3 允许「同一端点不同模型名」）：
 *   端点同文件配置，模型 gemini-3.1-flash-lite（已实测 JSON 模式与真实画图链路可用）。
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Cdp, launchBrowser, resolveBrowser, findFreePort, sleep } from './lib/cdp-driver.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 命令行参数 */
const argv = process.argv.slice(2);
const argOf = (name, fallback = null) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const hasFlag = (name) => argv.includes(`--${name}`);
const LIST_ONLY = hasFlag('list');
const KEEP_OPEN = hasFlag('keep-open');
const KEEP_SERVER = hasFlag('keep-server');
const NO_SERVER = hasFlag('no-server');

/** 独立服务端口（不占用别人可能使用的 5173；可用 --http-port 覆盖） */
const HTTP_PORT = Number(argOf('http-port', '5191'));
const APP_URL = process.env.DRAWINMAP_E2E_URL || `http://127.0.0.1:${HTTP_PORT}/`;
/** 独立 CDP 调试端口（可用 --port 覆盖；被占用时自动顺延） */
const CDP_PORT = Number(argOf('port', '9339'));
/** 单轮等待上限（毫秒；复杂自由轮廓 + 质检 + 路网搜索） */
const TURN_TIMEOUT = Number(argOf('turn-timeout', '300000'));
/** 结果文件名与产物目录 */
const RESULT_NAME = argOf('out', 'result-llm-config.json');
const ARTIFACT_DIR = path.resolve(
  ROOT,
  argOf('artifact-dir', 'docs/测试报告/2026-11-09-LLM配置功能验收'),
);
/** 用例筛选：--cases E2E-01,E2E-03 或 E2E-01-E2E-05 */
const CASE_FILTER = argOf('cases', null);
/** 第二套配置模型名（同端点不同模型；已实测可用） */
const SECOND_MODEL = argOf('second-model', 'gemini-3.1-flash-lite');
/** 是否对"真实 LLM 波动"类失败自动复跑一次（需求 §7.6；不改断言） */
const RETRY_FLUCTUATION = !hasFlag('no-retry');

const VIEW = { width: 1440, height: 900 };
const APP_AGENT_CONFIG = path.join(ROOT, 'web', 'src', 'agent', 'agent-config.js');
/** E2E-08 备份路径（.tmp 已 gitignore） */
const TMP_DIR = path.join(ROOT, '.tmp');
const AGENT_CONFIG_BACKUP = path.join(TMP_DIR, 'agent-config.e2e08.bak.js');
/** E2E-12 回归产物目录 */
const REGRESSION_DIR = path.join(ARTIFACT_DIR, 'regression');

// ============================== 基础工具 ==============================

/**
 * 脱敏：把真实密钥明文替换为 ***（落盘、控制台、错误详情统一走这里）。
 *
 * @param {string} text 文本
 * @returns {string} 脱敏文本
 */
function redactText(text) {
  let output = typeof text === 'string' ? text : String(text ?? '');
  const secret = FILE_CONFIG?.apiKey;
  if (typeof secret === 'string' && secret.length > 0) {
    output = output.split(secret).join('***');
  }
  return output;
}

/**
 * 递归脱敏任意 JSON 值（结果文件落盘前最后一道保险）。
 *
 * @param {*} value 任意值
 * @returns {*} 脱敏后的值
 */
function deepRedact(value) {
  if (typeof value === 'string') {
    return redactText(value);
  }
  if (Array.isArray(value)) {
    return value.map(deepRedact);
  }
  if (value && typeof value === 'object') {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = deepRedact(item);
    }
    return output;
  }
  return value;
}

/** 控制台输出（统一脱敏） */
function logLine(...parts) {
  console.log(...parts.map((part) => redactText(typeof part === 'string' ? part : JSON.stringify(part))));
}

/**
 * 解析用例筛选表达式（支持逗号分隔与 `E2E-01-E2E-05` 区间）。
 *
 * @param {string|null} filter 表达式
 * @returns {Set<string>|null} id 集合（null=全量）
 */
function parseFilter(filter) {
  if (!filter) {
    return null;
  }
  const ids = new Set();
  for (const raw of filter.split(',')) {
    const part = raw.trim();
    if (!part) {
      continue;
    }
    const range = part.match(/^E2E-(\d+)-E2E-(\d+)$/);
    if (range) {
      for (let index = Number(range[1]); index <= Number(range[2]); index += 1) {
        ids.add(`E2E-${String(index).padStart(2, '0')}`);
      }
    } else {
      ids.add(part.toUpperCase().startsWith('E2E-') ? part.toUpperCase() : `E2E-${part.padStart(2, '0')}`);
    }
  }
  return ids;
}

/**
 * 计算文件 SHA256（E2E-08 文件恢复校验）。
 *
 * @param {string} filePath 文件路径
 * @returns {Promise<string|null>} 哈希（不存在返回 null）
 */
async function sha256Of(filePath) {
  try {
    const content = await readFile(filePath);
    return createHash('sha256').update(content).digest('hex');
  } catch {
    return null;
  }
}

/** 文件名安全化（截图名） */
function safeName(name) {
  return String(name).replace(/[<>:"/\\|?*\r\n]/g, '-');
}

// ============================== 文件配置与密钥 ==============================

/**
 * 读取真实文件配置（web/src/agent/agent-config.js）。
 *
 * 返回对象含 apiKey，**只在内存中使用**：不打印、不落盘（落盘前 deepRedact）。
 *
 * @returns {Promise<object>} 文件配置投影
 */
async function readFileConfig() {
  const text = await readFile(APP_AGENT_CONFIG, 'utf8');
  const pick = (pattern) => {
    const matched = text.match(pattern);
    return matched ? matched[1] : null;
  };
  return {
    path: 'web/src/agent/agent-config.js',
    baseUrl: pick(/baseUrl:\s*'([^']+)'/),
    apiKey: pick(/apiKey:\s*'([^']+)'/),
    model: pick(/model:\s*'([^']+)'/),
    timeoutMs: Number(pick(/timeoutMs:\s*(\d+)/) ?? 0),
    maxTokens: Number(pick(/maxTokens:\s*(\d+)/) ?? 0),
  };
}

/** 文件配置（内存单例；缺文件时为 null） */
let FILE_CONFIG = null;
/** 第二套配置（同端点不同模型；其余字段沿用文件配置，避免额外变量） */
function secondConfig() {
  return {
    baseUrl: FILE_CONFIG?.baseUrl ?? null,
    model: SECOND_MODEL,
    timeoutMs: FILE_CONFIG?.timeoutMs ?? 180000,
    maxTokens: FILE_CONFIG?.maxTokens ?? 32000,
  };
}

/**
 * 结果中可公开的文件配置投影（不含密钥）。
 *
 * @returns {object} 投影
 */
function publicFileConfig() {
  if (!FILE_CONFIG) {
    return null;
  }
  return {
    path: FILE_CONFIG.path,
    baseUrl: FILE_CONFIG.baseUrl,
    model: FILE_CONFIG.model,
    timeoutMs: FILE_CONFIG.timeoutMs,
    maxTokens: FILE_CONFIG.maxTokens,
    hasApiKey: typeof FILE_CONFIG.apiKey === 'string' && FILE_CONFIG.apiKey.length > 0,
    apiKeyLength: typeof FILE_CONFIG.apiKey === 'string' ? FILE_CONFIG.apiKey.length : 0,
  };
}

// ============================== 服务端 ==============================

/** 服务端管理状态 */
const serverState = { child: null, startedByUs: false, log: [] };

/**
 * 探测服务端是否可用。
 *
 * @returns {Promise<boolean>} 是否可用
 */
async function probeServer() {
  try {
    const response = await fetch(`${APP_URL}__log/ping`);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * 确保本地服务可用（不可用时自起 `node web/server.mjs <port>`）。
 *
 * @returns {Promise<boolean>} 是否就绪
 */
async function ensureServer() {
  if (await probeServer()) {
    logLine(`[env] 复用已运行的服务 ${APP_URL}`);
    return true;
  }
  if (NO_SERVER) {
    return false;
  }
  const child = spawn(process.execPath, ['web/server.mjs', String(HTTP_PORT)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => serverState.log.push(redactText(String(chunk))));
  child.stderr.on('data', (chunk) => serverState.log.push(redactText(String(chunk))));
  serverState.child = child;
  serverState.startedByUs = true;
  for (let index = 0; index < 60; index += 1) {
    if (await probeServer()) {
      logLine(`[env] 已启动服务 ${APP_URL}（pid=${child.pid}）`);
      return true;
    }
    await sleep(250);
  }
  return false;
}

/** 停止自起的服务端（--keep-server 时保留） */
async function stopServer() {
  if (!serverState.startedByUs || KEEP_SERVER || !serverState.child) {
    return;
  }
  try {
    serverState.child.kill();
  } catch {
    // 忽略
  }
  await sleep(300);
}

// ============================== 浏览器 ==============================

/** 浏览器管理状态 */
const browserState = { kill: null, profileDir: null };

/**
 * 启动无头浏览器并连接页面 CDP。
 *
 * @param {string} browserPath 浏览器可执行文件
 * @returns {Promise<{cdp: Cdp, port: number, browserVersion: string|null}>} 连接结果
 */
async function startBrowser(browserPath) {
  const port = await findFreePort(CDP_PORT);
  const profileDir = path.join(os.tmpdir(), `drawinmap-e2e-llmconfig-${Date.now()}`);
  const { kill } = await launchBrowser({ browserPath, port, userDataDir: profileDir });
  browserState.kill = kill;
  browserState.profileDir = profileDir;
  let version = null;
  for (let index = 0; index < 60; index += 1) {
    try {
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      if (version?.webSocketDebuggerUrl) {
        break;
      }
    } catch {
      // 调试端口尚未就绪
    }
    await sleep(250);
  }
  if (!version) {
    throw new Error('浏览器 DevTools 端点未就绪');
  }
  // 取 about:blank 页面 target（没有就新建一个）
  let targets = [];
  try {
    targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  } catch {
    targets = [];
  }
  let page = Array.isArray(targets) ? targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl) : null;
  if (!page) {
    page = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  }
  const cdp = new Cdp(page.webSocketDebuggerUrl, { artifactDir: ARTIFACT_DIR, timeoutMs: 300000 });
  await cdp.open();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  logLine(`[env] 浏览器 ${version.Browser} · CDP ${port} · ${browserPath}`);
  return { cdp, port, browserVersion: version.Browser ?? null };
}

/** 关闭浏览器 */
async function stopBrowser(cdp) {
  try {
    cdp?.close();
  } catch {
    // 忽略
  }
  if (KEEP_OPEN || !browserState.kill) {
    return;
  }
  try {
    browserState.kill();
  } catch {
    // 忽略
  }
  await sleep(500);
  if (browserState.profileDir) {
    await rm(browserState.profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ============================== 页面表达式 ==============================

/**
 * 页面内求值用表达式集合（全部为只读或等价真实用户操作，不拦截任何网络请求）。
 *
 * 注意：密钥只在 E2E-08 填写表单时经 JSON 注入页面；其它表达式一律不返回密钥明文。
 */
const EXPR = {
  /** 应用就绪：发送按钮 + 欢迎消息已渲染 */
  ready: `!!(document.getElementById('agent-send') && document.querySelector('#agent-messages .agent-msg'))`,

  /** 打开智能体面板（真实点击「智能体」按钮） */
  openAgentPanel: `(() => {
    const panel = document.getElementById('agent-panel');
    if (!panel) return { ok: false, reason: 'no-panel' };
    if (panel.hasAttribute('hidden')) document.getElementById('agent-btn')?.click();
    return { ok: !panel.hasAttribute('hidden') };
  })()`,

  /** 点击某按钮 */
  click: (id) => `(() => {
    const el = document.getElementById(${JSON.stringify(id)});
    if (!el) return { ok: false, reason: 'missing' };
    el.click();
    return { ok: true };
  })()`,

  /** 设置/对话界面状态快照（配置界面全部字段、来源、提示、错误行、布局） */
  configState: `(() => {
    const byId = (id) => document.getElementById(id);
    const text = (el) => (el ? (el.textContent || '').trim() : '');
    const val = (id) => { const el = byId(id); return el ? el.value : null; };
    const err = (id) => {
      const el = byId(id);
      if (!el) return null;
      return { text: text(el), hidden: el.hasAttribute('hidden') };
    };
    const config = byId('agent-config');
    const panel = byId('agent-panel');
    const keyInput = byId('llm-api-key');
    const messages = byId('agent-messages');
    return {
      ready: Boolean(byId('agent-send')),
      panelOpen: Boolean(panel) && !panel.hasAttribute('hidden'),
      panelConfigOpenClass: Boolean(panel) && panel.classList.contains('is-config-open'),
      configOpen: Boolean(config) && !config.hasAttribute('hidden'),
      source: text(byId('llm-config-source')),
      sourceData: byId('llm-config-source') ? byId('llm-config-source').getAttribute('data-source') : null,
      notice: { text: text(byId('llm-config-notice')), hidden: Boolean(byId('llm-config-notice')?.hasAttribute('hidden')) },
      testResult: { text: text(byId('llm-config-test-result')), hidden: Boolean(byId('llm-config-test-result')?.hasAttribute('hidden')) },
      required: {
        text: text(byId('agent-config-required')),
        hidden: Boolean(byId('agent-config-required')?.hasAttribute('hidden')),
        hasButton: Boolean(byId('agent-config-required-open')),
      },
      fields: {
        endpoint: val('llm-endpoint'), model: val('llm-model'),
        timeout: val('llm-timeout'), maxTokens: val('llm-max-tokens'),
        apiKeyType: keyInput ? keyInput.type : null,
        apiKeyLength: keyInput && typeof keyInput.value === 'string' ? keyInput.value.length : 0,
      },
      errors: {
        endpoint: err('llm-endpoint-error'), apiKey: err('llm-api-key-error'), model: err('llm-model-error'),
        timeout: err('llm-timeout-error'), maxTokens: err('llm-max-tokens-error'),
      },
      buttons: {
        testDisabled: Boolean(byId('llm-config-test')?.disabled),
        testLabel: text(byId('llm-config-test')),
        saveDisabled: Boolean(byId('llm-config-save')?.disabled),
        saveLabel: text(byId('llm-config-save')),
        restoreHidden: Boolean(byId('llm-config-restore')?.hasAttribute('hidden')),
        confirmHidden: Boolean(byId('llm-config-restore-confirm')?.hasAttribute('hidden')),
        confirmText: text(byId('llm-config-restore-confirm')),
        toggleLabel: text(byId('llm-api-key-toggle')),
      },
      securityNote: Boolean(config) ? config.textContent.includes('明文') : false,
      messagesScrollTop: messages ? Math.round(messages.scrollTop) : null,
      // 获取模型（追加需求 2026-11-10）：按钮 / 结果区 / 下拉选择
      models: {
        fetchExists: Boolean(byId('llm-models-fetch')),
        fetchDisabled: Boolean(byId('llm-models-fetch')?.disabled),
        fetchLabel: text(byId('llm-models-fetch')),
        resultText: text(byId('llm-models-result')),
        resultHidden: Boolean(byId('llm-models-result')?.hasAttribute('hidden')),
        selectExists: Boolean(byId('llm-models-select')),
        selectHidden: Boolean(byId('llm-models-select')?.hasAttribute('hidden')),
        optionCount: byId('llm-models-select') ? byId('llm-models-select').options.length : 0,
        options: byId('llm-models-select')
          ? Array.from(byId('llm-models-select').options).map((option) => ({ value: option.value, text: (option.textContent || '').trim(), disabled: Boolean(option.disabled) }))
          : [],
        selectedValue: byId('llm-models-select') ? byId('llm-models-select').value : null,
      },
      messageCount: document.querySelectorAll('#agent-messages .agent-msg').length,
      inputValue: byId('agent-input') ? byId('agent-input').value : null,
      agentSendLabel: text(byId('agent-send')),
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    };
  })()`,

  /** 填写配置表单（真实 input/change 事件）。apiKey 仅在 E2E-08 传入 */
  fill: (values) => `(() => {
    const payload = ${JSON.stringify(values)};
    const setValue = (id, value) => {
      const el = document.getElementById(id);
      if (!el) return false;
      el.focus();
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };
    const mapping = [['llm-endpoint', 'endpoint'], ['llm-api-key', 'apiKey'], ['llm-model', 'model'],
      ['llm-timeout', 'timeout'], ['llm-max-tokens', 'maxTokens']];
    const applied = {};
    for (const [id, key] of mapping) {
      if (Object.prototype.hasOwnProperty.call(payload, key) && payload[key] !== null && payload[key] !== undefined) {
        applied[key] = setValue(id, String(payload[key]));
      }
    }
    return { ok: true, applied };
  })()`,

  /** 设置字段值（不兼容旧 DOM 时兜底：直接按 id 写并派发事件） */
  setField: (id, value) => `(() => {
    const el = document.getElementById(${JSON.stringify(id)});
    if (!el) return { ok: false };
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  })()`,

  /** 发送一条真实用户输入（等价输入后点「发送」） */
  send: (text) => `(() => {
    const input = document.getElementById('agent-input');
    if (!input) return { ok: false, reason: 'no-input' };
    input.value = ${JSON.stringify(text)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const button = document.getElementById('agent-send');
    if (!button) return { ok: false, reason: 'no-send' };
    const label = button.textContent.trim();
    if (label !== '发送') return { ok: false, reason: 'busy', label };
    button.click();
    return { ok: true, label };
  })()`,

  /** 轮次开始（按钮变「停止」或有 pending 消息） */
  turnStarted: `(() => {
    const button = document.getElementById('agent-send');
    if (!button) return false;
    const pending = Boolean(document.querySelector('.agent-msg-agent.is-pending'));
    return button.textContent.trim() === '停止' || pending;
  })()`,

  /** 轮次结束（按钮回到「发送」且无 pending） */
  turnFinished: (sentAt) => `(() => {
    const button = document.getElementById('agent-send');
    if (!button) return false;
    const busy = button.textContent.trim() === '停止';
    const pending = Boolean(document.querySelector('.agent-msg-agent.is-pending'));
    return !busy && !pending && (Date.now() - ${Number(sentAt)}) > 500;
  })()`,

  /** 测试连接完成（按钮恢复可点 + 结果区非空） */
  testFinished: `(() => {
    const button = document.getElementById('llm-config-test');
    const result = document.getElementById('llm-config-test-result');
    if (!button || !result) return false;
    return !button.disabled && (result.textContent || '').trim().length > 0;
  })()`,

  /** 保存/恢复后提示区出现文本 */
  noticeAppeared: `(() => {
    const notice = document.getElementById('llm-config-notice');
    return Boolean(notice) && !notice.hasAttribute('hidden') && (notice.textContent || '').trim().length > 0;
  })()`,

  /** 会话与地图快照（消息、图形几何、绿/橙线、状态栏） */
  agentSnapshot: `(() => {
    const readStore = () => {
      try {
        const raw = localStorage.getItem('drawinmap.sessions.v1');
        if (!raw) return { activeId: null, sessionCount: 0, messageCount: 0, messages: [], shapes: [] };
        const state = JSON.parse(raw);
        const session = state.sessions.find((item) => item.id === state.activeId) || null;
        if (!session) return { activeId: state.activeId, sessionCount: state.sessions.length, messageCount: 0, messages: [], shapes: [] };
        return {
          activeId: state.activeId,
          sessionCount: state.sessions.length,
          messageCount: session.messages.length,
          messages: session.messages.map((message) => ({
            id: message.id,
            role: message.role,
            kind: message.kind ?? null,
            status: message.status ?? null,
            action: message.action ?? null,
            traceId: message.traceId ?? null,
            text: typeof message.text === 'string' ? message.text.slice(0, 2000) : '',
          })),
          shapes: session.shapes.map((shape) => ({
            id: shape.id,
            shapeName: shape.shapeName ?? null,
            reference: Boolean(shape.reference),
            sizeMeters: shape.sizeMeters ?? null,
            deliveredObjects: Array.isArray(shape.deliveredObjects) ? shape.deliveredObjects : null,
            geometry: shape.geometry
              ? { route: shape.geometry.route ?? null, outline: shape.geometry.outline ?? null }
              : null,
          })),
        };
      } catch (error) {
        return { error: String(error && error.message ? error.message : error) };
      }
    };
    const store = readStore();
    const overlayPaths = Array.from(document.querySelectorAll('.leaflet-overlay-pane path'));
    const strokes = overlayPaths.map((item) => item.getAttribute('stroke')).filter(Boolean);
    const agentTexts = Array.from(document.querySelectorAll('.agent-msg-agent .agent-msg-text'));
    const errorTexts = Array.from(document.querySelectorAll('.agent-msg-error')).map((el) => (el.textContent || '').trim());
    // 页面上可能有多个 .agent-toast 容器（不同的提示通道），取第一个有文本的作为当前提示
    const toastTexts = Array.from(document.querySelectorAll('.agent-toast'))
      .map((el) => (el.textContent || '').trim())
      .filter((text) => text.length > 0);
    return {
      store,
      dom: {
        strokes,
        green: strokes.includes('#16a34a'),
        orange: strokes.includes('#f59e0b'),
        overlayCount: overlayPaths.length,
        lastAgentText: agentTexts.length ? agentTexts[agentTexts.length - 1].textContent : '',
        errorTexts,
        messageCount: document.querySelectorAll('#agent-messages .agent-msg').length,
        indicator: (document.getElementById('shape-indicator') || {}).textContent?.trim() ?? '',
        center: (document.getElementById('status-center') || {}).textContent?.trim() ?? '',
        zoom: (document.getElementById('status-zoom') || {}).textContent?.trim() ?? '',
        toast: toastTexts[0] ?? '',
        toastTexts,
        toastVisible: toastTexts.length > 0,
        busy: (document.getElementById('agent-send') || {}).textContent?.trim() === '停止',
        inputValue: (document.getElementById('agent-input') || {}).value ?? null,
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      },
    };
  })()`,

  /** 地图瓦片与缩放动画稳定（截图前等待，失败不阻断） */
  mapSettled: `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const tilesOk = () => Array.from(document.querySelectorAll('.leaflet-tile')).every(
      (tile) => tile.classList.contains('leaflet-tile-loaded') && (tile.tagName !== 'IMG' || tile.complete),
    );
    const start = Date.now();
    let stable = 0;
    while (Date.now() - start < 8000) {
      const animating = Boolean(document.querySelector('.leaflet-container.leaflet-zoom-anim'));
      if (!animating && tilesOk()) stable += 1; else stable = 0;
      if (stable >= 2) return true;
      await sleep(250);
    }
    return false;
  })()`,

  /** 读取页面日志记录（全量，供按 ts 过滤统计真实请求） */
  logs: `(() => {
    const api = window.DrawInMapLog;
    if (!api || typeof api.entries !== 'function') return null;
    const wanted = new Set([
      'llm.request', 'llm.response', 'llm.error', 'llm.retry', 'llm.truncated', 'llm.aborted',
      'llm.config', 'llm.config.saved', 'llm.config.restored', 'llm.config.corrupt',
      'llm.config.storage.failed', 'llm.config.failed',
      'llm.config.test.request', 'llm.config.test.success', 'llm.config.test.failed',
      'llm.panel.open', 'llm.panel.close', 'llm.panel.save.start', 'llm.panel.save.invalid',
      'llm.panel.save.failed', 'llm.panel.saved', 'llm.panel.restore.confirm', 'llm.panel.restored',
      'llm.panel.test.start', 'llm.panel.test.success', 'llm.panel.test.rejected',
      'llm.panel.test.failed', 'llm.panel.key.visibility', 'llm.panel.refresh',
      'ui.send.blocked.unconfigured', 'window.error', 'window.unhandledrejection',
      'agent.abort', 'agent.turn.abort', 'ui.stop', 'llm.config.unconfigured',
    ]);
    try {
      return api.entries({ level: 'debug', limit: 0 })
        .filter((record) => record && (wanted.has(record.event) || String(record.event ?? '').startsWith('llm.')))
        .map((record) => {
          const data = record.data && typeof record.data === 'object' ? { ...record.data } : record.data ?? null;
          if (data && typeof data === 'object') {
            delete data.messages;
            if (typeof data.content === 'string') data.content = data.content.slice(0, 200);
            if (typeof data.reasoningContent === 'string') data.reasoningContent = '[长度 ' + data.reasoningContent.length + ']';
            if (typeof data.detail === 'string') data.detail = data.detail.slice(0, 400);
          }
          return {
            ts: record.ts ?? null,
            level: record.level ?? null,
            module: record.module ?? null,
            event: record.event ?? null,
            traceId: record.traceId ?? null,
            durationMs: record.durationMs ?? null,
            data,
            error: record.error ? { name: record.error.name ?? null, message: record.error.message ?? null } : null,
          };
        });
    } catch (error) {
      return { error: String(error && error.message ? error.message : error) };
    }
  })()`,

  /** 导出页面日志 JSONL（密钥脱敏检索用；不落盘） */
  exportJsonl: `(() => {
    const api = window.DrawInMapLog;
    if (!api || typeof api.exportJsonl !== 'function') return null;
    return api.exportJsonl();
  })()`,

  /** 页面可见文本（密钥脱敏检索用；不落盘） */
  domText: `(() => (document.body ? document.body.innerText : '') + '\\n' + Array.from(document.querySelectorAll('input'))
    .filter((input) => input.type !== 'password')
    .map((input) => input.value || '').join('\\n'))()`,

  /** 本地存储探测：配置键是否存在及内容（不含密钥明文；返回结构化投影） */
  storageProbe: (key) => `(() => {
    try {
      const raw = localStorage.getItem(${JSON.stringify(key)});
      if (raw === null) return { exists: false };
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch (error) { return { exists: true, parsed: false, rawLength: raw.length, error: String(error.message) }; }
      return {
        exists: true,
        parsed: true,
        rawLength: raw.length,
        version: parsed && parsed.version !== undefined ? parsed.version : null,
        baseUrl: parsed && typeof parsed.baseUrl === 'string' ? parsed.baseUrl : null,
        model: parsed && typeof parsed.model === 'string' ? parsed.model : null,
        timeoutMs: parsed && parsed.timeoutMs !== undefined ? parsed.timeoutMs : null,
        maxTokens: parsed && parsed.maxTokens !== undefined ? parsed.maxTokens : null,
        hasApiKey: Boolean(parsed && typeof parsed.apiKey === 'string' && parsed.apiKey.length > 0),
        apiKeyLength: parsed && typeof parsed.apiKey === 'string' ? parsed.apiKey.length : 0,
        savedAt: parsed && parsed.savedAt !== undefined ? parsed.savedAt : null,
      };
    } catch (error) {
      return { exists: false, error: String(error.message) };
    }
  })()`,

  /** 写入本地存储（构造损坏配置用） */
  writeStorage: (key, value) => `(() => {
    try { localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)}); return { ok: true }; }
    catch (error) { return { ok: false, error: String(error.message) }; }
  })()`,

  /** 读取本地存储原始值长度（不返回明文） */
  storageRawLength: (key) => `(() => { const raw = localStorage.getItem(${JSON.stringify(key)}); return raw === null ? -1 : raw.length; })()`,

  /** 本地存储键清单（探测配置键用） */
  storageKeys: `(() => { try { return Object.keys(localStorage); } catch (error) { return []; } })()`,

  /** 探测配置存储键：优先模块导出常量，其次扫描键名 */
  storageKeyProbe: `(async () => {
    const exported = [];
    try {
      const module = await import('/src/agent/llm-config.js');
      for (const name of ['LLM_CONFIG_STORAGE_KEY', 'STORAGE_KEY', 'CONFIG_STORAGE_KEY', 'LLM_CONFIG_KEY']) {
        if (typeof module[name] === 'string' && module[name]) exported.push(module[name]);
      }
    } catch (error) {
      // 模块未提供常量：走键名扫描
    }
    let scanned = [];
    try {
      scanned = Object.keys(localStorage).filter((key) => /llm.*config|config.*llm/i.test(key));
    } catch {
      scanned = [];
    }
    return { exported, scanned };
  })()`,

  /** 资源计时：统计发往 /chat/completions 的真实请求数（用于"校验拦截不发请求"） */
  chatRequestCount: `(() => {
    try {
      return performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/chat/completions')).length;
    } catch {
      return -1;
    }
  })()`,

  /** 资源计时：统计发往 /models 的真实请求（获取模型；含 URL 与耗时） */
  modelsRequestInfo: `(() => {
    try {
      const entries = performance.getEntriesByType('resource').filter((entry) => /\\/models(?:\\?|$)/.test(entry.name));
      return {
        count: entries.length,
        urls: entries.map((entry) => entry.name),
        initiatorTypes: [...new Set(entries.map((entry) => entry.initiatorType))],
        durations: entries.map((entry) => Math.round(entry.duration)),
      };
    } catch (error) {
      return { count: -1, error: String(error && error.message ? error.message : error) };
    }
  })()`,

  /** 读取页面错误气泡文本 */
  errorTexts: `(() => Array.from(document.querySelectorAll('.agent-msg-error')).map((el) => (el.textContent || '').trim()))()`,
};

// ============================== 页面操作封装 ==============================

/**
 * 真实页面操作封装（全部走真实 DOM 事件，不做任何网络拦截）。
 */
class App {
  /**
   * @param {Cdp} cdp CDP 客户端
   */
  constructor(cdp) {
    this.cdp = cdp;
    /** 配置存储键（缓存；来自页面模块导出或骨架） */
    this.storageKey = null;
  }

  /** 页面表达式求值 */
  async evaluate(expression) {
    return this.cdp.evaluate(expression);
  }

  /** 等待页面条件 */
  async waitFor(expression, timeoutMs, label, intervalMs = 300) {
    return this.cdp.waitFor(expression, timeoutMs, label, intervalMs);
  }

  /** 截图（先等地图稳定，失败不阻断） */
  async shot(name) {
    try {
      await this.evaluate(EXPR.mapSettled);
    } catch {
      // 地图等待失败不阻断截图
    }
    await sleep(250);
    return this.cdp.screenshot(safeName(name));
  }

  /** 打开智能体面板 */
  async openPanel() {
    const result = await this.evaluate(EXPR.openAgentPanel);
    if (!result?.ok) {
      throw new Error(`打开智能体面板失败：${JSON.stringify(result)}`);
    }
    await this.waitFor(`!document.getElementById('agent-panel').hasAttribute('hidden')`, 8000, '智能体面板打开');
    return result;
  }

  /** 打开设置界面（真实点击「设置」） */
  async openConfig() {
    const clicked = await this.evaluate(EXPR.click('agent-config-open'));
    if (!clicked?.ok) {
      throw new Error('设置入口缺失（#agent-config-open）——实现可能未完成');
    }
    const opened = await this.waitFor(`(() => {
      const config = document.getElementById('agent-config');
      return Boolean(config) && !config.hasAttribute('hidden');
    })()`, 15000, '设置界面打开');
    if (!opened) {
      throw new Error('设置界面未打开（#agent-config 仍隐藏）');
    }
    // 等来源徽标/字段回显（resolveEffectiveConfig 是异步的）
    await sleep(600);
    return true;
  }

  /** 关闭设置界面（真实点击「关闭」） */
  async closeConfig() {
    const clicked = await this.evaluate(EXPR.click('llm-config-close'));
    if (!clicked?.ok) {
      return false;
    }
    await this.waitFor(`(() => {
      const config = document.getElementById('agent-config');
      return Boolean(config) && config.hasAttribute('hidden');
    })()`, 8000, '设置界面关闭');
    await sleep(400);
    return true;
  }

  /** 设置界面与面板状态快照 */
  async state() {
    return this.evaluate(EXPR.configState);
  }

  /** 会话与地图快照 */
  async snapshot() {
    return this.evaluate(EXPR.agentSnapshot);
  }

  /**
   * 填写配置表单。
   *
   * @param {object} values {endpoint, apiKey, model, timeout, maxTokens}
   * @returns {Promise<object>} 填写结果
   */
  async fill(values) {
    return this.evaluate(EXPR.fill(values));
  }

  /** 点击保存并等待结果（成功→提示非空；失败→字段错误或提示非空） */
  async save({ timeoutMs = 15000 } = {}) {
    const clicked = await this.evaluate(EXPR.click('llm-config-save'));
    if (!clicked?.ok) {
      throw new Error('保存按钮缺失（#llm-config-save）');
    }
    await this.waitFor(
      `(() => {
        const notice = document.getElementById('llm-config-notice');
        const noticeOk = Boolean(notice) && !notice.hasAttribute('hidden') && (notice.textContent || '').trim().length > 0;
        const errors = Array.from(document.querySelectorAll('.llm-field-error')).some((el) => !el.hasAttribute('hidden') && (el.textContent || '').trim());
        return noticeOk || errors;
      })()`,
      timeoutMs,
      '保存结果提示出现',
    );
    await sleep(300);
    return this.state();
  }

  /** 点击「恢复默认」→ 断言二次确认 → 点「确认恢复」→ 等回落提示 */
  async restoreToDefault({ confirmTimeoutMs = 10000, doneTimeoutMs = 15000 } = {}) {
    const clicked = await this.evaluate(EXPR.click('llm-config-restore'));
    if (!clicked?.ok) {
      return { ok: false, reason: '恢复默认按钮缺失' };
    }
    const confirmShown = await this.waitFor(`(() => {
      const confirmEl = document.getElementById('llm-config-restore-confirm');
      return Boolean(confirmEl) && !confirmEl.hasAttribute('hidden');
    })()`, confirmTimeoutMs, '恢复默认二次确认出现');
    const confirmState = await this.state();
    if (!confirmShown) {
      return { ok: false, reason: '二次确认未出现', confirmState };
    }
    const confirmed = await this.evaluate(EXPR.click('llm-config-restore-ok'));
    if (!confirmed?.ok) {
      return { ok: false, reason: '确认恢复按钮缺失', confirmState };
    }
    await this.waitFor(`(() => {
      const notice = document.getElementById('llm-config-notice');
      const source = document.getElementById('llm-config-source');
      const noticeOk = Boolean(notice) && !notice.hasAttribute('hidden') && (notice.textContent || '').trim().length > 0;
      const sourceOk = Boolean(source) && source.getAttribute('data-source') !== 'page';
      return noticeOk && sourceOk;
    })()`, doneTimeoutMs, '恢复默认后来源回落');
    await sleep(400);
    return { ok: true, confirmState, state: await this.state() };
  }

  /** 点击「测试连接」并等结果（成功或失败都会显示结果区文本） */
  async testConnection({ timeoutMs = 120000 } = {}) {
    const clicked = await this.evaluate(EXPR.click('llm-config-test'));
    if (!clicked?.ok) {
      return { ok: false, reason: '测试连接按钮缺失' };
    }
    const finished = await this.waitFor(EXPR.testFinished, timeoutMs, '测试连接结果出现', 300);
    await sleep(250);
    const state = await this.state();
    return { ok: finished, state };
  }

  /** 发送一轮真实对话（真实输入 + 真实点击发送） */
  async send(text) {
    const result = await this.evaluate(EXPR.send(text));
    if (!result?.ok) {
      throw new Error(`发送失败：${JSON.stringify(result)}`);
    }
    return result;
  }

  /** 等待轮次开始 */
  async waitTurnStart(timeoutMs = 20000) {
    return this.waitFor(EXPR.turnStarted, timeoutMs, '轮次开始', 150);
  }

  /**
   * 执行一轮真实对话并等待完成。
   *
   * @param {string} text 用户输入
   * @param {{turnTimeoutMs?: number}} [options] 选项
   * @returns {Promise<{sentAt: number, started: boolean, finished: boolean, durationMs: number}>} 轮次结果
   */
  async runTurn(text, { turnTimeoutMs = TURN_TIMEOUT } = {}) {
    const sentAt = Date.now();
    await this.send(text);
    const started = await this.waitTurnStart(20000);
    const finished = await this.waitFor(EXPR.turnFinished(sentAt), turnTimeoutMs, '一轮完成', 400);
    if (finished) {
      await sleep(900); // 等 UI 重绘 / 会话存储落盘 / 日志 flush
    }
    return { sentAt, started, finished, durationMs: Date.now() - sentAt };
  }

  /** 读取页面日志（结构化投影） */
  async logs() {
    const rows = await this.evaluate(EXPR.logs);
    return Array.isArray(rows) ? rows : [];
  }

  /** 导出页面日志 JSONL 文本（不落盘） */
  async exportJsonl() {
    return this.evaluate(EXPR.exportJsonl);
  }

  /** 页面可见文本（不落盘） */
  async domText() {
    return this.evaluate(EXPR.domText);
  }

  /** 配置存储键探测（模块导出 → 键名扫描 → 兜底常量） */
  async resolveStorageKey() {
    if (this.storageKey) {
      return this.storageKey;
    }
    let probe = null;
    try {
      probe = await this.evaluate(EXPR.storageKeyProbe);
    } catch {
      probe = null;
    }
    const candidates = [
      ...(Array.isArray(probe?.exported) ? probe.exported : []),
      ...(Array.isArray(probe?.scanned) ? probe.scanned.filter((key) => /llm-config|llmConfig/i.test(key)) : []),
    ];
    if (candidates.length > 0) {
      this.storageKey = candidates.find((key) => /llm-config\.v1/.test(key)) ?? candidates[0];
      return this.storageKey;
    }
    // Node 侧兜底：读源码里的存储键常量/字符串
    try {
      const source = await readFile(path.join(ROOT, 'web', 'src', 'agent', 'llm-config.js'), 'utf8');
      const matched = source.match(/['"](drawinmap\.llm-config[\w.-]*)['"]/);
      if (matched) {
        this.storageKey = matched[1];
        return this.storageKey;
      }
    } catch {
      // 源码尚未就绪
    }
    this.storageKey = 'drawinmap.llm-config.v1';
    return this.storageKey;
  }

  /** 读配置存储投影 */
  async storageProbe() {
    const key = await this.resolveStorageKey();
    return this.evaluate(EXPR.storageProbe(key));
  }

  /** 写配置存储（构造损坏配置） */
  async writeStorage(value) {
    const key = await this.resolveStorageKey();
    return this.evaluate(EXPR.writeStorage(key, value));
  }

  /** 设置浏览器视口 */
  async setViewport(width, height, { mobile = false, scale = 1 } = {}) {
    await this.cdp.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: scale, mobile,
    });
    await sleep(500);
  }

  /** 取消视口模拟 */
  async clearViewport() {
    await this.cdp.send('Emulation.clearDeviceMetricsOverride');
    await sleep(300);
  }

  /** 当前 /chat/completions 资源请求数（校验拦截"不发请求"证据） */
  async chatRequestCount() {
    return this.evaluate(EXPR.chatRequestCount);
  }

  /** 当前 /models 资源请求信息（获取模型的真实请求证据） */
  async modelsRequestInfo() {
    const info = await this.evaluate(EXPR.modelsRequestInfo);
    return info && typeof info === 'object' ? info : { count: -1, urls: [] };
  }

  /** 等待「获取模型」完成（按钮恢复可点且结果区/下拉框已有内容） */
  async waitModelsFetched(timeoutMs = 120000) {
    return this.waitFor(
      `(() => {
        const button = document.getElementById('llm-models-fetch');
        const result = document.getElementById('llm-models-result');
        const select = document.getElementById('llm-models-select');
        if (!button) return false;
        const label = (button.textContent || '').trim();
        const fetching = button.disabled || /获取中/.test(label);
        const resultReady = Boolean(result) && (result.textContent || '').trim().length > 0 && !result.hasAttribute('hidden');
        const selectReady = Boolean(select) && !select.hasAttribute('hidden') && select.options.length > 1;
        return !fetching && (resultReady || selectReady);
      })()`,
      timeoutMs,
      '获取模型完成',
      300,
    );
  }

  /** 在「获取模型」下拉框选择模型（真实 change 事件，等价用户选择） */
  async selectModel(value) {
    return this.evaluate(`(() => {
      const select = document.getElementById('llm-models-select');
      if (!select) return { ok: false, reason: 'no-select' };
      const targetText = ${JSON.stringify(value)};
      const option = Array.from(select.options).find(
        (item) => item.value === targetText || (item.textContent || '').trim() === targetText,
      );
      if (!option) {
        return { ok: false, reason: 'no-option', optionCount: select.options.length, sample: Array.from(select.options).slice(0, 8).map((item) => item.value) };
      }
      select.focus();
      select.value = option.value;
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, value: option.value, text: (option.textContent || '').trim(), optionCount: select.options.length };
    })()`);
  }

  /** 刷新页面并等就绪 */
  async reload({ timeoutMs = 60000 } = {}) {
    await this.cdp.send('Page.reload');
    const ready = await this.waitFor(EXPR.ready, timeoutMs, '刷新后应用就绪');
    await sleep(900);
    return ready;
  }

  /**
   * 用例隔离：离开页面 → 清空同源 localStorage → 回到页面（打开面板）。
   *
   * 注意必须"先离开页面再清"，否则 pagehide 时旧会话会被写回。
   *
   * @param {{clearStorage?: boolean}} [options] 选项
   * @returns {Promise<boolean>} 是否就绪
   */
  async reset({ clearStorage = true } = {}) {
    await this.cdp.send('Page.navigate', { url: 'about:blank' });
    await sleep(500);
    if (clearStorage) {
      const origin = new URL(APP_URL).origin;
      await this.cdp.send('Storage.clearDataForOrigin', {
        origin,
        storageTypes: 'local_storage',
      });
    }
    await this.cdp.send('Page.navigate', { url: APP_URL });
    const ready = await this.waitFor(EXPR.ready, 60000, '页面就绪');
    await sleep(1000);
    return ready;
  }
}

// ============================== 交付判定与通用断言 ==============================

/** 断言中的 POI 范围（真实广州地点；容差在判定函数里统一加） */
const POI = {
  yuexiu: { name: '越秀公园', minLat: 23.1, maxLat: 23.18, minLng: 113.22, maxLng: 113.32 },
  cantonTower: { name: '广州塔', minLat: 23.07, maxLat: 23.15, minLng: 113.28, maxLng: 113.37 },
  flowerCitySquare: { name: '花城广场', minLat: 23.08, maxLat: 23.15, minLng: 113.28, maxLng: 113.36 },
};

/** 诚实失败的可读文案特征（真实链路失败而不是假绿线） */
const HONEST_FAILURE_RE = /画不出|无法|抱歉|没能|没有找到|失败|做不到|无法保证|换一个|建议|暂不支持|不支持/;

/**
 * 从会话/地图快照提取交付视图。
 *
 * @param {object} snapshot agentSnapshot 返回值
 * @returns {object} 交付视图
 */
function deliveryView(snapshot) {
  const store = snapshot?.store ?? {};
  const shapes = Array.isArray(store.shapes) ? store.shapes : [];
  const messages = Array.isArray(store.messages) ? store.messages : [];
  const lastShape = shapes.length > 0 ? shapes[shapes.length - 1] : null;
  const points = [];
  for (const segment of [lastShape?.geometry?.route, lastShape?.geometry?.outline]) {
    if (!Array.isArray(segment)) {
      continue;
    }
    for (const point of segment) {
      if (Array.isArray(point) && point.length >= 2 && Number.isFinite(point[0]) && Number.isFinite(point[1])) {
        points.push(point);
      }
    }
  }
  const lastAgent = [...messages].reverse().find((message) => message.role === 'agent') ?? null;
  const errorMessages = messages.filter((message) => message.role === 'error');
  /** 点集经纬度包围盒（定位断言失败时快速判断是落点偏了还是坐标序问题） */
  let bounds = null;
  if (points.length > 0) {
    const lats = points.map((point) => point[0]);
    const lngs = points.map((point) => point[1]);
    bounds = {
      minLat: Math.round(Math.min(...lats) * 1e5) / 1e5,
      maxLat: Math.round(Math.max(...lats) * 1e5) / 1e5,
      minLng: Math.round(Math.min(...lngs) * 1e5) / 1e5,
      maxLng: Math.round(Math.max(...lngs) * 1e5) / 1e5,
    };
  }
  return {
    shapes,
    lastShape,
    points,
    bounds,
    delivered: shapes.length > 0,
    green: Boolean(snapshot?.dom?.green),
    orange: Boolean(snapshot?.dom?.orange),
    lastAgent,
    reply: typeof lastAgent?.text === 'string' ? lastAgent.text : '',
    errorMessages,
    messageCount: messages.length,
    overlayCount: snapshot?.dom?.overlayCount ?? 0,
  };
}

/**
 * 点集是否落在 bbox 内（容差 ~1.5km，路网吸附会越过 POI 边界几百米）。
 *
 * @param {Array<Array<number>>} points [lat,lng]
 * @param {{minLat:number,maxLat:number,minLng:number,maxLng:number}} bbox 范围
 * @param {number} [tolerance] 容差（度）
 * @returns {boolean} 是否全部在内
 */
function pointsInBbox(points, bbox, tolerance = 0.02) {
  return (
    Array.isArray(points) &&
    points.length > 0 &&
    points.every(
      ([lat, lng]) =>
        lat >= bbox.minLat - tolerance &&
        lat <= bbox.maxLat + tolerance &&
        lng >= bbox.minLng - tolerance &&
        lng <= bbox.maxLng + tolerance,
    )
  );
}

/**
 * 断言本轮真实交付结果（绿线/参考版 或 诚实失败），并核对图形与落点。
 *
 * @param {object} ctx 用例上下文
 * @param {object} snapshot 会话/地图快照
 * @param {object} options {label, expectShapeName, bbox, tags}
 * @returns {object} 交付结论
 */
function assertDelivery(ctx, snapshot, { label, expectShapeName = null, bbox = null } = {}) {
  const view = deliveryView(snapshot);
  const reply = view.reply;
  ctx.check(`${label}：真实对话回复非空`, reply.trim().length > 0, reply.slice(0, 160));
  ctx.check(
    `${label}：无错误气泡（错误消息数 0）`,
    view.errorMessages.length === 0,
    JSON.stringify(view.errorMessages.map((item) => String(item.text).slice(0, 120))),
  );
  const consistent = view.delivered ? view.green || view.orange : !view.green && !view.orange;
  ctx.check(
    `${label}：地图线色与图形快照一致（绿=合格 / 橙=参考版 / 无图形=无线）`,
    consistent,
    `green=${view.green} orange=${view.orange} shapes=${view.shapes.length} overlays=${view.overlayCount}`,
  );
  let kind = 'unknown';
  if (view.delivered && (view.green || view.orange)) {
    kind = view.green ? 'green' : 'orange';
    ctx.check(`${label}：真实链路完成交付（${kind === 'green' ? '绿线' : '参考版橙线'}）`, true);
  } else {
    const honest = HONEST_FAILURE_RE.test(reply);
    kind = honest ? 'honest-failure' : 'no-delivery';
    ctx.check(`${label}：未交付时为诚实失败（有可读说明且无虚假绿线）`, honest, reply.slice(0, 200));
  }
  if (expectShapeName) {
    const favorite = String(view.lastShape?.shapeName ?? '');
    const objects = JSON.stringify(view.lastShape?.deliveredObjects ?? '');
    ctx.check(
      `${label}：交付图形为「${expectShapeName}」`,
      view.delivered && (favorite.includes(expectShapeName) || objects.includes(expectShapeName)),
      `shapeName=${favorite}`,
    );
  }
  if (bbox) {
    const inBbox = pointsInBbox(view.points, bbox);
    // 现有交付标准允许"近场路网画不出时扩大搜索范围并如实说明"（回复里会写明实际落点）；
    // 因此落点断言 = 在指定 POI 范围内，或在回复中如实披露了扩大范围后的实际落点。
    const disclosed = /扩大范围|近场|一带画|附近找不到|无法在原地|画在原地|西约|东约|北约|南约|搬到/.test(reply);
    ctx.check(
      `${label}：路线落点在「${bbox.name}」范围，或回复如实说明扩大范围后的实际落点`,
      inBbox || disclosed,
      `points=${view.points.length} bounds=${JSON.stringify(view.bounds)} reply=${reply.slice(0, 160)}`,
    );
    ctx.record.extra = ctx.record.extra && typeof ctx.record.extra === 'object' ? ctx.record.extra : {};
    ctx.record.extra.location = { poi: bbox.name, inBbox, disclosed, bounds: view.bounds };
  }
  ctx.record.extra = ctx.record.extra && typeof ctx.record.extra === 'object' ? ctx.record.extra : {};
  ctx.record.extra.deliveryBounds = view.bounds;
  return { kind, view };
}

/**
 * 从日志记录投影出真实 LLM 请求。
 *
 * @param {Array<object>} rows 日志投影
 * @returns {Array<object>} 请求列表
 */
function requestsOf(rows) {
  return rows
    .filter((row) => row.event === 'llm.request')
    .map((row) => ({
      ts: row.ts,
      traceId: row.traceId,
      model: row.data?.model ?? null,
      baseUrl: row.data?.baseUrl ?? null,
      attempt: row.data?.attempt ?? null,
      maxTokens: row.data?.maxTokens ?? null,
      timeoutMs: row.data?.timeoutMs ?? null,
      jsonMode: row.data?.jsonMode ?? null,
    }));
}

/**
 * 从日志记录投影出真实 LLM 响应。
 *
 * @param {Array<object>} rows 日志投影
 * @returns {Array<object>} 响应列表
 */
function responsesOf(rows) {
  return rows
    .filter((row) => row.event === 'llm.response')
    .map((row) => ({
      ts: row.ts,
      traceId: row.traceId,
      responseModel: row.data?.responseModel ?? null,
      durationMs: row.data?.durationMs ?? null,
      httpStatus: row.data?.httpStatus ?? null,
      finishReason: row.data?.finishReason ?? null,
      contentLength: row.data?.contentLength ?? null,
    }));
}

/**
 * 从日志记录投影出测试连接事件。
 *
 * @param {Array<object>} rows 日志投影
 * @returns {object} {requests, successes, failures}
 */
function testConnectionEvents(rows) {
  return {
    requests: rows.filter((row) => row.event === 'llm.config.test.request').map((row) => row.data ?? {}),
    successes: rows.filter((row) => row.event === 'llm.config.test.success').map((row) => row.data ?? {}),
    failures: rows.filter((row) => row.event === 'llm.config.test.failed').map((row) => row.data ?? {}),
  };
}

// ============================== 用例执行框架 ==============================

/**
 * 创建一条用例上下文（步骤/断言/截图/延迟日志断言）。
 *
 * @param {App} app 页面操作封装
 * @param {object} record 用例记录
 * @returns {object} 上下文
 */
function createCaseContext(app, record) {
  const ctx = {
    app,
    record,
    env: null,
    /**
     * 记录一条操作步骤（报告用）。
     *
     * @param {string} action 动作
     * @param {string} [detail] 细节
     */
    step(action, detail = '') {
      record.steps.push({ at: new Date().toISOString(), action, detail: redactText(detail) });
      logLine(`  · ${action}${detail ? `：${detail}` : ''}`);
    },
    /**
     * 记录一条断言。
     *
     * @param {string} label 断言描述
     * @param {boolean} condition 断言条件
     * @param {string} [detail] 失败详情
     * @returns {boolean} 是否通过
     */
    check(label, condition, detail = '') {
      const ok = Boolean(condition);
      record.checks.push({
        label: redactText(label),
        ok,
        detail: ok ? '' : redactText(String(detail ?? '')).slice(0, 600),
      });
      logLine(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` → ${redactText(String(detail ?? '')).slice(0, 300)}`}`);
      return ok;
    },
    /**
     * 截图（产物目录内 png）。
     *
     * @param {string} name 文件名
     * @returns {Promise<string>} 文件名
     */
    async shot(name) {
      const file = await app.shot(name);
      record.screenshots.push(file);
      return file;
    },
    /**
     * 读取本用例开始后的页面日志（每次调用都取最新）。
     *
     * @param {number} [sinceTs] 起始时间戳（默认用例开始）
     * @returns {Promise<Array<object>>} 日志投影
     */
    async collectLogs(sinceTs = record.startedAtMs) {
      const rows = await app.logs();
      return rows.filter((row) => Number.isFinite(row.ts) && row.ts >= sinceTs);
    },
  };
  return ctx;
}

/**
 * 执行一条用例（含失败重跑：仅"真实 LLM 波动"类用例允许复跑一次，不改断言）。
 *
 * @param {object} caseDef 用例定义
 * @param {App} app 页面操作封装
 * @param {object} env 环境（文件配置/第二套配置等）
 * @returns {Promise<object>} 用例记录
 */
async function runCase(caseDef, app, env) {
  logLine(`\n=== ${caseDef.id} ${caseDef.title} ===`);
  const attempts = [];
  let record = null;
  const maxAttempts = caseDef.retryable && RETRY_FLUCTUATION ? 2 : 1;
  for (let attemptNo = 1; attemptNo <= maxAttempts; attemptNo += 1) {
    record = {
      id: caseDef.id,
      title: caseDef.title,
      requirements: caseDef.requirements,
      expected: caseDef.expected,
      startedAt: new Date().toISOString(),
      startedAtMs: Date.now(),
      durationMs: 0,
      status: 'running',
      attempt: attemptNo,
      steps: [],
      checks: [],
      screenshots: [],
      traceIds: [],
      llm: null,
      testConnections: null,
      delivery: null,
      config: null,
      extra: {},
    };
    const ctx = createCaseContext(app, record);
    ctx.env = env;
    const started = Date.now();
    try {
      await caseDef.run(ctx, env);
      record.status = record.checks.every((item) => item.ok) ? 'pass' : 'fail';
    } catch (error) {
      record.status = 'error';
      record.error = redactText(error?.message ?? String(error));
      logLine(`  [error] ${record.error}`);
      try {
        record.screenshots.push(await app.shot(`${caseDef.id}-异常.png`));
      } catch {
        // 异常截图失败忽略
      }
    } finally {
      record.durationMs = Date.now() - started;
      try {
        const rows = await ctx.collectLogs();
        record.llm = {
          requestCount: rows.filter((row) => row.event === 'llm.request').length,
          requests: requestsOf(rows),
          responses: responsesOf(rows),
          configEvents: rows
            .filter((row) => ['llm.config', 'llm.config.saved', 'llm.config.restored', 'llm.config.corrupt', 'llm.config.storage.failed', 'llm.config.failed'].includes(row.event))
            .map((row) => ({ event: row.event, traceId: row.traceId, data: row.data ?? null })),
          panelEvents: rows
            .filter((row) => String(row.event).startsWith('llm.panel.'))
            .map((row) => ({ event: row.event, data: row.data ?? null })),
          errorEvents: rows
            .filter((row) => ['llm.error', 'llm.config.failed', 'window.error', 'window.unhandledrejection', 'llm.aborted', 'llm.config.storage.failed', 'ui.send.blocked.unconfigured'].includes(row.event))
            .map((row) => ({ event: row.event, traceId: row.traceId, data: row.data ?? null, error: row.error })),
          allEvents: rows.map((row) => ({ ts: row.ts, level: row.level, module: row.module, event: row.event, traceId: row.traceId, data: row.data, error: row.error })),
        };
        record.testConnections = testConnectionEvents(rows);
      } catch (error) {
        record.llm = { error: redactText(error?.message ?? String(error)) };
      }
      logLine(
        `  [case] ${record.id} 第 ${attemptNo} 次 → ${record.status}（${record.checks.filter((item) => item.ok).length}/${record.checks.length}，${(record.durationMs / 1000).toFixed(1)}s）`,
      );
      attempts.push(record);
    }
    if (record.status === 'pass') {
      break;
    }
    if (attemptNo < maxAttempts) {
      logLine(`  [retry] ${caseDef.id} 首次未通过，按需求 §7.6 复跑一次（不改断言）`);
      record.retryReason = '首次未通过，按 §7.6 复跑';
    }
  }
  const finalRecord = attempts[attempts.length - 1];
  finalRecord.attempts = attempts.length;
  if (attempts.length > 1) {
    finalRecord.previousAttempt = attempts[0];
  }
  return finalRecord;
}

// ============================== 用例定义（E2E-01 ～ E2E-07） ==============================

/**
 * 把配置界面状态里可入库的字段投影出来（不含密钥明文）。
 *
 * @param {object} state 配置界面状态
 * @returns {object} 投影
 */
function configProjection(state) {
  if (!state) {
    return null;
  }
  return {
    configOpen: state.configOpen,
    source: state.source,
    sourceData: state.sourceData,
    notice: state.notice?.text ?? '',
    testResult: state.testResult?.text ?? '',
    fields: {
      endpoint: state.fields?.endpoint ?? null,
      model: state.fields?.model ?? null,
      timeout: state.fields?.timeout ?? null,
      maxTokens: state.fields?.maxTokens ?? null,
      apiKeyType: state.fields?.apiKeyType ?? null,
      apiKeyLength: state.fields?.apiKeyLength ?? null,
    },
    errors: state.errors,
    buttons: state.buttons,
    required: state.required,
    securityNote: state.securityNote,
  };
}

/** 用例表（按需求 §7.5 原文逐例实现；E2E-12 由主流程排在最后执行） */
const CASES = [
  {
    id: 'E2E-01',
    title: '设置界面打开 / 来源=文件配置 / 回显 / 密钥隐藏 / 关闭不破坏对话状态',
    requirements: 'R1/R2/R3',
    expected:
      '设置界面打开；来源=文件配置；回显文件配置值；密钥默认隐藏；关闭后对话历史与面板状态不变',
    retryable: false,
    async run(ctx, env) {
      const { app } = ctx;
      ctx.step('清空浏览器页面配置并刷新（独立会话）');
      const ready = await app.reset();
      ctx.check('页面刷新后应用就绪', ready);
      await app.openPanel();
      const typed = 'E2E-01 未发送的输入内容';
      await app.evaluate(`(() => { const el = document.getElementById('agent-input'); el.value = ${JSON.stringify(typed)}; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
      const before = await app.state();
      ctx.check('对话面板已打开且能看到对话消息', before.panelOpen === true && before.messageCount > 0, JSON.stringify(before.messageCount));
      await ctx.shot('E2E-01-对话面板.png');

      ctx.step('点击面板标题栏「设置」打开 LLM 配置界面');
      await app.openConfig();
      const opened = await app.state();
      ctx.check('设置界面已打开（#agent-config 可见）', opened.configOpen === true);
      ctx.check('面板进入设置视图（#agent-panel.is-config-open）', opened.panelConfigOpenClass === true);
      ctx.check('来源标识=文件配置', String(opened.source).includes('文件配置') && opened.sourceData === 'file', `source=${opened.source} data=${opened.sourceData}`);
      ctx.check('端点回显=文件配置 baseUrl', opened.fields.endpoint === env.fileConfig.baseUrl, `${opened.fields.endpoint}`);
      ctx.check('模型回显=文件配置 model', opened.fields.model === env.fileConfig.model, `${opened.fields.model}`);
      ctx.check('单次超时回显=文件配置 timeoutMs', opened.fields.timeout === String(env.fileConfig.timeoutMs), `${opened.fields.timeout}`);
      ctx.check('最大输出回显=文件配置 maxTokens', opened.fields.maxTokens === String(env.fileConfig.maxTokens), `${opened.fields.maxTokens}`);
      ctx.check('密钥默认隐藏（type=password）且已回显', opened.fields.apiKeyType === 'password' && opened.fields.apiKeyLength > 0, `type=${opened.fields.apiKeyType} length=${opened.fields.apiKeyLength}`);
      const keyMatch = await app.evaluate(`(async () => {
        try {
          const module = await import('/src/agent/agent-config.js');
          const key = module.AGENT_LLM ? module.AGENT_LLM.apiKey : null;
          const input = document.getElementById('llm-api-key');
          return { matched: typeof key === 'string' && key.length > 0 && input.value === key, fileKeyLength: typeof key === 'string' ? key.length : -1, fieldLength: input.value.length };
        } catch (error) {
          return { error: String(error && error.message ? error.message : error) };
        }
      })()`);
      ctx.check('密钥回显值与文件配置一致（页面内比较，不回传明文）', keyMatch?.matched === true, JSON.stringify(keyMatch));
      ctx.check('常驻安全提示（明文保存风险）可见', opened.securityNote === true);
      await ctx.shot('E2E-01-设置界面-文件配置.png');

      ctx.step('点击「显示」/「隐藏」切换密钥显示');
      await app.evaluate(EXPR.click('llm-api-key-toggle'));
      const shown = await app.state();
      ctx.check('点击「显示」后密钥输入框转为 type=text', shown.fields.apiKeyType === 'text', `type=${shown.fields.apiKeyType}`);
      ctx.check('显示切换不改变已回显密钥长度', shown.fields.apiKeyLength === opened.fields.apiKeyLength, `${shown.fields.apiKeyLength} vs ${opened.fields.apiKeyLength}`);
      await app.evaluate(EXPR.click('llm-api-key-toggle'));
      const hiddenAgain = await app.state();
      ctx.check('再次点击恢复隐藏（type=password）', hiddenAgain.fields.apiKeyType === 'password', `type=${hiddenAgain.fields.apiKeyType}`);

      ctx.step('关闭设置界面，核对对话历史与面板状态不变');
      await app.closeConfig();
      const closed = await app.state();
      ctx.check('设置界面已关闭', closed.configOpen === false);
      ctx.check('关闭后回到对话视图（is-config-open 已移除）', closed.panelConfigOpenClass === false);
      ctx.check('关闭后智能体面板保持打开', closed.panelOpen === true);
      ctx.check('关闭后对话消息数不变', closed.messageCount === before.messageCount, `${before.messageCount} → ${closed.messageCount}`);
      ctx.check('关闭后未发送的输入内容保留（不清空输入）', closed.inputValue === typed, JSON.stringify(closed.inputValue));
      ctx.check('关闭后消息区滚动位置恢复打开前位置', closed.messagesScrollTop === before.messagesScrollTop, `${before.messagesScrollTop} → ${closed.messagesScrollTop}`);
      await ctx.shot('E2E-01-关闭设置后对话.png');
      ctx.record.config = {
        source: opened.source,
        sourceData: opened.sourceData,
        fields: configProjection(opened)?.fields,
      };
    },
  },

  {
    id: 'E2E-02',
    title: '文件配置真实对话「在越秀公园画个五角星」全链路交付',
    requirements: 'R3/R4/§7.4',
    expected: '完成真实链路并正确交付；真实请求与响应对应文件配置；记录实际模型标识',
    retryable: true,
    async run(ctx, env) {
      const { app } = ctx;
      ctx.step('清空浏览器页面配置并刷新（独立会话，来源应为文件配置）');
      const ready = await app.reset();
      ctx.check('页面刷新后应用就绪', ready);
      await app.openPanel();
      const prompt = '在越秀公园画个五角星';
      ctx.step('真实输入并发送对话', prompt);
      const turn = await app.runTurn(prompt);
      ctx.check('轮次在超时前完成', turn.finished, `started=${turn.started} durationMs=${turn.durationMs}`);
      ctx.check('轮次开始被观测到（发送按钮进入进行中）', turn.started);
      const snap = await app.snapshot();
      const delivery = assertDelivery(ctx, snap, {
        label: 'E2E-02',
        expectShapeName: '五角星',
        bbox: POI.yuexiu,
      });
      const traceId = delivery.view.lastAgent?.traceId ?? null;
      ctx.record.traceIds.push(traceId);
      ctx.record.delivery = { kind: delivery.kind, shapeName: delivery.view.lastShape?.shapeName ?? null, pointCount: delivery.view.points.length, reply: delivery.view.reply.slice(0, 600) };
      ctx.check('取得本轮真实链路 traceId', Boolean(traceId), String(traceId));
      await ctx.shot('E2E-02-越秀公园-五角星.png');

      ctx.step('核对本轮运行记录中的真实请求/响应与文件配置逐项一致');
      const rows = await ctx.collectLogs();
      const requests = requestsOf(rows).filter((item) => !traceId || item.traceId === traceId);
      const responses = responsesOf(rows).filter((item) => !traceId || item.traceId === traceId);
      ctx.check('本轮存在真实 LLM 请求记录', requests.length > 0, `count=${requests.length}`);
      ctx.check('真实请求 model=文件配置模型', requests.length > 0 && requests.every((item) => item.model === env.fileConfig.model), JSON.stringify(requests.map((item) => item.model)));
      ctx.check('真实请求 baseUrl=文件配置端点', requests.length > 0 && requests.every((item) => item.baseUrl === env.fileConfig.baseUrl), JSON.stringify(requests.map((item) => item.baseUrl)));
      ctx.check('收到真实 LLM 响应并含响应模型标识', responses.length > 0 && responses.some((item) => typeof item.responseModel === 'string' && item.responseModel.length > 0), JSON.stringify(responses.map((item) => item.responseModel)));
      ctx.check('真实响应耗时被记录', responses.some((item) => Number.isFinite(item.durationMs)), JSON.stringify(responses.map((item) => item.durationMs)));
      ctx.record.extra.requestSummary = {
        requestCount: requests.length,
        responseCount: responses.length,
        models: [...new Set(requests.map((item) => item.model))],
        responseModels: [...new Set(responses.map((item) => item.responseModel).filter(Boolean))],
        durationsMs: responses.map((item) => (Number.isFinite(item.durationMs) ? Math.round(item.durationMs) : null)),
        traceId,
      };
    },
  },

  {
    id: 'E2E-03',
    title: '页面填写第二套配置→保存（提示含模型名）→不刷新立即真实对话→请求走新配置',
    requirements: 'R2/R3/R4/§7.4',
    expected:
      '保存提示含模型名；来源=页面配置；下一轮真实请求确实走新配置；真实链路交付成功；配置↔请求↔交付一致',
    retryable: true,
    async run(ctx, env) {
      const { app } = ctx;
      ctx.step('清空浏览器页面配置并刷新（独立会话）');
      const ready = await app.reset();
      ctx.check('页面刷新后应用就绪', ready);
      await app.openPanel();
      await app.openConfig();
      const initial = await app.state();
      ctx.check('初始来源=文件配置', initial.sourceData === 'file', `data=${initial.sourceData}`);

      ctx.step('在设置界面填写第二套配置（同端点不同模型）', `model=${env.second.model}`);
      await app.fill({ model: env.second.model });
      const filled = await app.state();
      ctx.check('模型字段已填入第二套模型名', filled.fields.model === env.second.model, `${filled.fields.model}`);
      const saved = await app.save();
      ctx.check('保存成功提示含生效模型名', String(saved.notice.text).includes(env.second.model), saved.notice.text);
      ctx.check('保存后来源标识立即变为页面配置', String(saved.source).includes('页面配置') && saved.sourceData === 'page', `source=${saved.source} data=${saved.sourceData}`);
      const stored = await app.storageProbe();
      ctx.check('页面配置已写入浏览器 localStorage（可持久化）', stored.exists === true && stored.parsed === true && stored.model === env.second.model, JSON.stringify(stored));
      ctx.check('页面配置端点=第二套端点', stored.baseUrl === env.second.baseUrl, `${stored.baseUrl}`);
      await ctx.shot('E2E-03-保存第二套配置.png');

      ctx.step('不刷新页面，立即发起真实对话', '在广州塔附近画个心形');
      const turn = await app.runTurn('在广州塔附近画个心形');
      ctx.check('轮次在超时前完成', turn.finished, `started=${turn.started}`);
      const snap = await app.snapshot();
      const delivery = assertDelivery(ctx, snap, {
        label: 'E2E-03',
        expectShapeName: '心形',
        bbox: POI.cantonTower,
      });
      const traceId = delivery.view.lastAgent?.traceId ?? null;
      ctx.record.traceIds.push(traceId);
      ctx.record.delivery = { kind: delivery.kind, shapeName: delivery.view.lastShape?.shapeName ?? null, pointCount: delivery.view.points.length, reply: delivery.view.reply.slice(0, 600) };
      await ctx.shot('E2E-03-广州塔-心形.png');

      ctx.step('核对本轮真实请求 model/baseUrl 与新配置逐项一致');
      const rows = await ctx.collectLogs();
      const requests = requestsOf(rows).filter((item) => !traceId || item.traceId === traceId);
      const responses = responsesOf(rows).filter((item) => !traceId || item.traceId === traceId);
      ctx.check('本轮存在真实 LLM 请求记录', requests.length > 0, `count=${requests.length}`);
      ctx.check('真实请求 model=第二套模型（配置真实生效）', requests.length > 0 && requests.every((item) => item.model === env.second.model), JSON.stringify(requests.map((item) => item.model)));
      ctx.check('真实请求 baseUrl=新配置端点', requests.length > 0 && requests.every((item) => item.baseUrl === env.second.baseUrl), JSON.stringify(requests.map((item) => item.baseUrl)));
      ctx.check('真实请求 maxTokens 与页面配置一致', requests.every((item) => item.maxTokens === env.second.maxTokens), JSON.stringify(requests.map((item) => item.maxTokens)));
      ctx.check('收到真实响应并含响应模型标识', responses.length > 0 && responses.some((item) => typeof item.responseModel === 'string' && item.responseModel.length > 0), JSON.stringify(responses.map((item) => item.responseModel)));
      ctx.record.config = {
        source: saved.source,
        sourceData: saved.sourceData,
        savedNotice: saved.notice.text,
        expected: env.second,
        actualRequest: requests[0] ?? null,
        responseModels: [...new Set(responses.map((item) => item.responseModel).filter(Boolean))],
        matched: requests.length > 0 && requests.every((item) => item.model === env.second.model && item.baseUrl === env.second.baseUrl),
      };
      ctx.record.extra.requestSummary = {
        requestCount: requests.length,
        responseCount: responses.length,
        durationsMs: responses.map((item) => (Number.isFinite(item.durationMs) ? Math.round(item.durationMs) : null)),
        traceId,
      };
    },
  },

  {
    id: 'E2E-04',
    title: '刷新页面后来源仍页面配置、真实对话仍走新配置并交付',
    requirements: 'R4',
    expected: '来源仍为页面配置、字段回显新配置；真实对话仍走新配置并交付成功',
    retryable: true,
    async run(ctx, env) {
      const { app } = ctx;
      ctx.step('打开智能体面板与设置界面（若前置无页面配置则先保存第二套）');
      await app.openPanel();
      await app.openConfig();
      let state = await app.state();
      if (!(state.sourceData === 'page' && state.fields.model === env.second.model)) {
        ctx.step('（前置）保存第二套页面配置', `model=${env.second.model}`);
        await app.fill({ model: env.second.model });
        await app.save();
        state = await app.state();
      }
      ctx.check('刷新前来源=页面配置', state.sourceData === 'page', `data=${state.sourceData}`);
      ctx.check('刷新前模型回显=第二套模型', state.fields.model === env.second.model, `${state.fields.model}`);
      await app.closeConfig();
      await ctx.shot('E2E-04-刷新前.png');

      ctx.step('刷新页面（真实 Page.reload）');
      const ready = await app.reload();
      ctx.check('刷新后应用就绪', ready);
      const storedAfterReload = await app.storageProbe();
      ctx.check('刷新后页面配置仍在浏览器 localStorage', storedAfterReload.exists === true && storedAfterReload.model === env.second.model, JSON.stringify(storedAfterReload));
      await app.openPanel();
      await app.openConfig();
      const after = await app.state();
      ctx.check('刷新后来源仍为页面配置', after.sourceData === 'page' && String(after.source).includes('页面配置'), `source=${after.source}`);
      ctx.check('刷新后字段回显第二套模型', after.fields.model === env.second.model, `${after.fields.model}`);
      ctx.check('刷新后字段回显第二套端点', after.fields.endpoint === env.second.baseUrl, `${after.fields.endpoint}`);
      await ctx.shot('E2E-04-刷新后设置界面.png');
      await app.closeConfig();

      ctx.step('发起真实对话', '在越秀公园画个五角星');
      const turn = await app.runTurn('在越秀公园画个五角星');
      ctx.check('轮次在超时前完成', turn.finished, `started=${turn.started}`);
      const snap = await app.snapshot();
      const delivery = assertDelivery(ctx, snap, {
        label: 'E2E-04',
        expectShapeName: '五角星',
        bbox: POI.yuexiu,
      });
      const traceId = delivery.view.lastAgent?.traceId ?? null;
      ctx.record.traceIds.push(traceId);
      ctx.record.delivery = { kind: delivery.kind, shapeName: delivery.view.lastShape?.shapeName ?? null, pointCount: delivery.view.points.length, reply: delivery.view.reply.slice(0, 600) };
      await ctx.shot('E2E-04-刷新后真实对话.png');

      const rows = await ctx.collectLogs();
      const requests = requestsOf(rows).filter((item) => !traceId || item.traceId === traceId);
      const responses = responsesOf(rows).filter((item) => !traceId || item.traceId === traceId);
      ctx.check('刷新后真实请求仍走第二套模型', requests.length > 0 && requests.every((item) => item.model === env.second.model), JSON.stringify(requests.map((item) => item.model)));
      ctx.check('刷新后真实请求仍走第二套端点', requests.length > 0 && requests.every((item) => item.baseUrl === env.second.baseUrl), JSON.stringify(requests.map((item) => item.baseUrl)));
      ctx.check('刷新后收到真实响应', responses.length > 0 && responses.some((item) => typeof item.responseModel === 'string' && item.responseModel.length > 0));
      ctx.record.extra.requestSummary = {
        requestCount: requests.length,
        responseCount: responses.length,
        durationsMs: responses.map((item) => (Number.isFinite(item.durationMs) ? Math.round(item.durationMs) : null)),
        traceId,
      };
    },
  },

  {
    id: 'E2E-05',
    title: '恢复默认二次确认→来源文件配置→真实对话走文件配置→localStorage 已清除',
    requirements: 'R6',
    expected: '来源变为文件配置；下一轮真实对话走文件配置；浏览器中页面配置已清除；对话真实成功',
    retryable: true,
    async run(ctx, env) {
      const { app } = ctx;
      ctx.step('打开智能体面板与设置界面（若前置无页面配置则先保存第二套）');
      await app.openPanel();
      await app.openConfig();
      let state = await app.state();
      if (state.sourceData !== 'page') {
        ctx.step('（前置）保存第二套页面配置', `model=${env.second.model}`);
        await app.fill({ model: env.second.model });
        await app.save();
        state = await app.state();
      }
      ctx.check('恢复前来源=页面配置', state.sourceData === 'page', `data=${state.sourceData}`);
      ctx.check('恢复前「恢复默认」按钮可见', state.buttons.restoreHidden === false);
      const storedBefore = await app.storageProbe();
      ctx.check('恢复前浏览器中存在页面配置', storedBefore.exists === true, JSON.stringify({ exists: storedBefore.exists }));

      ctx.step('点击「恢复默认」并核对二次确认文案');
      const trigger = await app.evaluate(EXPR.click('llm-config-restore'));
      ctx.check('「恢复默认」按钮可点击', trigger?.ok === true);
      const confirmShown = await app.waitFor(`(() => { const el = document.getElementById('llm-config-restore-confirm'); return Boolean(el) && !el.hasAttribute('hidden'); })()`, 10000, '恢复默认二次确认出现');
      const confirmState = await app.state();
      ctx.check('恢复默认出现行内二次确认', confirmShown);
      const confirmText = confirmState.buttons.confirmText || '';
      ctx.check('二次确认文案明确「将删除浏览器中的配置，回落到文件配置」', confirmText.includes('删除浏览器中的配置') && confirmText.includes('文件配置'), confirmText);
      await ctx.shot('E2E-05-恢复默认二次确认.png');

      ctx.step('点击「确认恢复」并核对来源回落');
      const confirmed = await app.evaluate(EXPR.click('llm-config-restore-ok'));
      ctx.check('「确认恢复」按钮可点击', confirmed?.ok === true);
      await app.waitFor(
        `(() => {
          const notice = document.getElementById('llm-config-notice');
          const source = document.getElementById('llm-config-source');
          return Boolean(notice) && !notice.hasAttribute('hidden') && (notice.textContent || '').trim().length > 0 &&
            Boolean(source) && source.getAttribute('data-source') !== 'page';
        })()`,
        15000,
        '恢复默认后来源回落',
      );
      await sleep(400);
      const restored = await app.state();
      ctx.check('恢复后来源=文件配置', restored.sourceData === 'file' && String(restored.source).includes('文件配置'), `source=${restored.source}`);
      ctx.check('恢复后有明确界面反馈（非静默）', restored.notice.text.length > 0, restored.notice.text);
      ctx.check('恢复后「恢复默认」按钮隐藏', restored.buttons.restoreHidden === true);
      ctx.check('恢复后字段回显文件配置模型', restored.fields.model === env.fileConfig.model, `${restored.fields.model}`);
      const storedAfter = await app.storageProbe();
      ctx.check('浏览器中页面配置已清除（localStorage 已删除）', storedAfter.exists === false, JSON.stringify(storedAfter));
      await ctx.shot('E2E-05-恢复后来源文件配置.png');
      await app.closeConfig();

      ctx.step('发起真实对话', '在越秀公园画个五角星');
      const turn = await app.runTurn('在越秀公园画个五角星');
      ctx.check('轮次在超时前完成', turn.finished, `started=${turn.started}`);
      const snap = await app.snapshot();
      const delivery = assertDelivery(ctx, snap, {
        label: 'E2E-05',
        expectShapeName: '五角星',
        bbox: POI.yuexiu,
      });
      const traceId = delivery.view.lastAgent?.traceId ?? null;
      ctx.record.traceIds.push(traceId);
      ctx.record.delivery = { kind: delivery.kind, shapeName: delivery.view.lastShape?.shapeName ?? null, pointCount: delivery.view.points.length, reply: delivery.view.reply.slice(0, 600) };
      await ctx.shot('E2E-05-恢复后真实对话.png');

      const rows = await ctx.collectLogs();
      const requests = requestsOf(rows).filter((item) => !traceId || item.traceId === traceId);
      const responses = responsesOf(rows).filter((item) => !traceId || item.traceId === traceId);
      ctx.check('恢复后真实请求走文件配置模型', requests.length > 0 && requests.every((item) => item.model === env.fileConfig.model), JSON.stringify(requests.map((item) => item.model)));
      ctx.check('恢复后真实请求走文件配置端点', requests.length > 0 && requests.every((item) => item.baseUrl === env.fileConfig.baseUrl), JSON.stringify(requests.map((item) => item.baseUrl)));
      ctx.check('恢复后收到真实响应', responses.length > 0 && responses.some((item) => typeof item.responseModel === 'string' && item.responseModel.length > 0));
      ctx.record.config = {
        beforeSource: state.source,
        afterSource: restored.source,
        cleared: storedAfter.exists === false,
        notice: restored.notice.text,
      };
      ctx.record.extra.requestSummary = {
        requestCount: requests.length,
        responseCount: responses.length,
        durationsMs: responses.map((item) => (Number.isFinite(item.durationMs) ? Math.round(item.durationMs) : null)),
        traceId,
      };
    },
  },

  {
    id: 'E2E-06',
    title: '测试连接成功显示真实模型与耗时；对话消息数/地图不变；有运行日志',
    requirements: 'R5',
    expected: '显示真实响应的模型与耗时；不新增对话消息、不触发画图、不改变地图；有真实响应记录',
    retryable: false,
    async run(ctx, env) {
      const { app } = ctx;
      ctx.step('清空页面配置并刷新（独立会话），打开设置界面');
      const ready = await app.reset();
      ctx.check('页面刷新后应用就绪', ready);
      await app.openPanel();
      await app.openConfig();
      ctx.step('填写第二套配置（不保存）', `model=${env.second.model}`);
      await app.fill({ model: env.second.model });
      const before = await app.state();
      const beforeSnap = await app.snapshot();
      const reqBefore = await app.chatRequestCount();

      ctx.step('点击「测试连接」，真实请求第二套配置端点');
      const test = await app.testConnection({ timeoutMs: 150000 });
      ctx.check('测试连接返回结果', test.ok === true, JSON.stringify(test.reason ?? ''));
      const resultText = test.state.testResult.text;
      ctx.check('测试结果显示真实响应模型', resultText.includes(env.second.model), resultText);
      ctx.check('测试结果显示真实耗时（ms/毫秒/秒）', /\d+(\.\d+)?\s*(ms|毫秒|秒)/.test(resultText), resultText);
      ctx.check('测试连接未被判为失败', !/连接失败/.test(resultText), resultText);
      await ctx.shot('E2E-06-测试连接成功.png');

      const after = await app.state();
      const afterSnap = await app.snapshot();
      ctx.check('测试连接不新增对话消息', after.messageCount === before.messageCount, `${before.messageCount} → ${after.messageCount}`);
      ctx.check('测试连接不触发画图（地图 overlay 数不变）', afterSnap.dom.overlayCount === beforeSnap.dom.overlayCount, `${beforeSnap.dom.overlayCount} → ${afterSnap.dom.overlayCount}`);
      ctx.check('测试连接不改变地图视野（中心/缩放不变）', afterSnap.dom.center === beforeSnap.dom.center && afterSnap.dom.zoom === beforeSnap.dom.zoom, `${beforeSnap.dom.center}/${beforeSnap.dom.zoom} → ${afterSnap.dom.center}/${afterSnap.dom.zoom}`);
      ctx.check('测试连接不新增图形快照', (afterSnap.store?.shapes ?? []).length === (beforeSnap.store?.shapes ?? []).length, `${(beforeSnap.store?.shapes ?? []).length} → ${(afterSnap.store?.shapes ?? []).length}`);
      ctx.check('测试连接不保存配置（来源仍=文件配置）', after.sourceData === 'file', `data=${after.sourceData}`);
      ctx.check('测试连接未写页面配置 localStorage', (await app.storageProbe()).exists === false);
      const afterReq = await app.chatRequestCount();
      ctx.check('页面资源计时观测到真实 POST /chat/completions', afterReq > reqBefore, `${reqBefore} → ${afterReq}`);

      ctx.step('核对运行日志中的测试连接真实请求/响应记录');
      const rows = await ctx.collectLogs();
      const events = testConnectionEvents(rows);
      const llmRequests = requestsOf(rows);
      ctx.check('运行记录含测试连接请求事件（端点/模型）', events.requests.length >= 1 && events.requests.every((item) => item.model === env.second.model), JSON.stringify(events.requests));
      ctx.check('运行记录含测试连接成功事件（真实耗时）', events.successes.length >= 1 && events.successes.some((item) => Number.isFinite(item.durationMs)), JSON.stringify(events.successes));
      ctx.check('测试连接有真实响应模型记录', events.successes.some((item) => typeof item.model === 'string' && item.model.length > 0), JSON.stringify(events.successes));
      ctx.check('测试连接不触发对话 LLM 轮次（无 llm.request）', llmRequests.length === 0, `llm.request=${llmRequests.length}`);
      ctx.record.testConnections = {
        uiText: resultText,
        requests: events.requests,
        successes: events.successes,
        failures: events.failures,
      };
      ctx.record.extra.chatRequests = { before: reqBefore, after: afterReq };
    },
  },

  {
    id: 'E2E-07',
    title: '错误密钥 / 不存在模型 / 非法端点 / 空模型 四组错误处理',
    requirements: 'R5/边界',
    expected:
      '错误密钥与不存在模型给出对应可读错误（有真实错误依据）；非法端点与空模型被校验拦截且不发请求；均不崩溃、不误报成功',
    retryable: false,
    async run(ctx, env) {
      const { app } = ctx;

      // ---------- A 组：错误密钥（真实鉴权失败） ----------
      ctx.step('A 组 错误密钥：重置页面并打开设置界面');
      const ready = await app.reset();
      ctx.check('A 组：页面就绪', ready);
      await app.openPanel();
      await app.openConfig();
      const fakeKey = 'test-placeholder-key-e2e';
      await app.fill({ apiKey: fakeKey, model: env.second.model });
      const groupA = Date.now();
      ctx.step('A 组：点击「测试连接」（真实打到配置端点）');
      const testA = await app.testConnection({ timeoutMs: 150000 });
      const textA = testA.state.testResult.text;
      ctx.check('A 组 错误密钥：测试连接给出失败结果', testA.ok === true && /失败/.test(textA), textA);
      ctx.check('A 组 错误密钥：真实鉴权失败依据（鉴权/401/密钥无效）', /鉴权失败|401|密钥无效|无权限/.test(textA), textA);
      await ctx.shot('E2E-07-A-错误密钥.png');
      const rowsA = await ctx.collectLogs(groupA);
      const failedA = rowsA.filter((row) => row.event === 'llm.config.test.failed').map((row) => row.data ?? {});
      ctx.check('A 组 错误密钥：真实 HTTP 鉴权失败被记录', failedA.length >= 1 && (failedA.some((item) => item.kind === 'auth') || failedA.some((item) => [401, 403].includes(item.httpStatus))), JSON.stringify(failedA));
      ctx.check('A 组 错误密钥：未误报成功', !/连接成功/.test(textA));

      // ---------- B 组：不存在模型（真实 4xx） ----------
      ctx.step('B 组 不存在模型：刷新页面重新打开设置界面');
      const readyB = await app.reload();
      ctx.check('B 组：刷新后页面就绪', readyB);
      await app.openPanel();
      await app.openConfig();
      const missingModel = 'no-such-model-e2e-0001';
      await app.fill({ model: missingModel });
      const groupB = Date.now();
      ctx.step('B 组：点击「测试连接」使用不存在的模型名');
      const testB = await app.testConnection({ timeoutMs: 150000 });
      const textB = testB.state.testResult.text;
      ctx.check('B 组 不存在模型：测试连接给出失败结果', testB.ok === true && /失败/.test(textB), textB);
      ctx.check('B 组 不存在模型：可读分类为「端点或模型不存在」', /端点或模型不存在/.test(textB), textB);
      ctx.check('B 组 不存在模型：真实错误依据含服务端 model_not_found/does not exist 摘要', /model_not_found|does not exist|unknown provider|模型/i.test(textB), textB);
      await ctx.shot('E2E-07-B-不存在模型.png');
      const rowsB = await ctx.collectLogs(groupB);
      const failedB = rowsB.filter((row) => row.event === 'llm.config.test.failed').map((row) => row.data ?? {});
      ctx.check('B 组 不存在模型：真实 4xx 错误依据被记录', failedB.length >= 1 && failedB.some((item) => Number.isFinite(item.httpStatus) && item.httpStatus >= 400), JSON.stringify(failedB));
      ctx.check('B 组 不存在模型：分类 kind=not-found（T1 修复后口径）', failedB.some((item) => item.kind === 'not-found'), JSON.stringify(failedB));
      ctx.check('B 组 不存在模型：未误报成功', !/连接成功/.test(textB));

      // ---------- C 组：非法端点（本地校验拦截，不发请求） ----------
      ctx.step('C 组 非法端点：刷新页面重新打开设置界面');
      const readyC = await app.reload();
      ctx.check('C 组：刷新后页面就绪', readyC);
      await app.openPanel();
      await app.openConfig();
      await app.fill({ endpoint: 'file:///etc/passwd' });
      const groupC = Date.now();
      const reqCountC = await app.chatRequestCount();
      ctx.step('C 组：点击「测试连接」（应在本地校验阶段被拦截）');
      const testC = await app.testConnection({ timeoutMs: 15000 });
      const stateC = testC.state;
      ctx.check('C 组 非法端点：测试连接给出「本地校验未过（未发请求）」可读原因', /本地校验/.test(stateC.testResult.text) && /未发请求|未发起请求/.test(stateC.testResult.text), stateC.testResult.text);
      ctx.check('C 组 非法端点：可读原因指出端点必须 http(s)', /http|端点/.test(stateC.testResult.text), stateC.testResult.text);
      ctx.check('C 组 非法端点：测试结果不是成功', !/连接成功/.test(stateC.testResult.text), stateC.testResult.text);
      await ctx.shot('E2E-07-C-非法端点.png');
      const rowsC = await ctx.collectLogs(groupC);
      ctx.check('C 组 非法端点：未发出测试连接请求', rowsC.filter((row) => row.event === 'llm.config.test.request').length === 0, JSON.stringify(rowsC.filter((row) => row.event === 'llm.config.test.request').map((row) => row.data)));
      ctx.check('C 组 非法端点：资源计时无新增 /chat/completions 请求', (await app.chatRequestCount()) === reqCountC, `${reqCountC} → ${await app.chatRequestCount()}`);
      ctx.step('C 组：再点「保存」，确认同样被校验拦截');
      const savedC = await app.save();
      ctx.check('C 组 非法端点：保存被校验拦截（不提示成功）', !/已保存并生效/.test(savedC.notice.text), savedC.notice.text);
      ctx.check('C 组 非法端点：字段错误仍标红', Boolean(savedC.errors.endpoint) && savedC.errors.endpoint.hidden === false);
      ctx.check('C 组 非法端点：来源仍为文件配置（未写入页面配置）', savedC.sourceData === 'file', `data=${savedC.sourceData}`);
      ctx.check('C 组 非法端点：页面未崩溃（应用就绪）', savedC.ready === true);

      // ---------- D 组：空模型（本地校验拦截，不发请求） ----------
      ctx.step('D 组 空模型：刷新页面重新打开设置界面');
      const readyD = await app.reload();
      ctx.check('D 组：刷新后页面就绪', readyD);
      await app.openPanel();
      await app.openConfig();
      await app.fill({ model: '   ' });
      const groupD = Date.now();
      const reqCountD = await app.chatRequestCount();
      ctx.step('D 组：点击「测试连接」（空模型应在本地校验阶段被拦截）');
      const testD = await app.testConnection({ timeoutMs: 15000 });
      const stateD = testD.state;
      ctx.check('D 组 空模型：测试连接给出「本地校验未过（未发请求）」可读原因', /本地校验/.test(stateD.testResult.text) && /未发请求|未发起请求/.test(stateD.testResult.text), stateD.testResult.text);
      ctx.check('D 组 空模型：可读原因指出模型不能为空', /模型/.test(stateD.testResult.text), stateD.testResult.text);
      ctx.check('D 组 空模型：测试结果不是成功', !/连接成功/.test(stateD.testResult.text), stateD.testResult.text);
      await ctx.shot('E2E-07-D-空模型.png');
      const rowsD = await ctx.collectLogs(groupD);
      ctx.check('D 组 空模型：未发出测试连接请求', rowsD.filter((row) => row.event === 'llm.config.test.request').length === 0);
      ctx.check('D 组 空模型：资源计时无新增 /chat/completions 请求', (await app.chatRequestCount()) === reqCountD);
      ctx.step('D 组：再点「保存」，确认同样被校验拦截');
      const savedD = await app.save();
      ctx.check('D 组 空模型：保存被校验拦截（不提示成功）', !/已保存并生效/.test(savedD.notice.text), savedD.notice.text);
      ctx.check('D 组 空模型：字段错误仍标红', Boolean(savedD.errors.model) && savedD.errors.model.hidden === false);
      ctx.check('D 组 空模型：页面未崩溃（应用就绪）', savedD.ready === true);

      // ---------- 全程：无脚本异常 ----------
      const rowsAll = await ctx.collectLogs();
      const windowErrors = rowsAll.filter((row) => row.event === 'window.error' || row.event === 'window.unhandledrejection');
      ctx.check('四组全程无未捕获脚本错误', windowErrors.length === 0, JSON.stringify(windowErrors.map((row) => row.event)));
      ctx.record.groups = {
        wrongKey: { text: textA, failures: failedA },
        missingModel: { text: textB, failures: failedB },
        invalidEndpoint: { endpointError: stateC.errors.endpoint, testText: stateC.testResult.text, saveText: savedC.notice.text },
        emptyModel: { modelError: stateD.errors.model, testText: stateD.testResult.text, saveText: savedD.notice.text },
      };
      // 观察记录（不改变断言口径）：服务端对"不存在模型"返回 HTTP 400 + model_not_found，
      // T1 修复后应归类 kind='not-found'（修复前曾误判 incompatible，已按缺陷处理并复验）。
      const kindB = failedB[0]?.kind ?? null;
      ctx.record.extra.classificationObservation = {
        missingModel: {
          httpStatus: failedB[0]?.httpStatus ?? null,
          kind: kindB,
          text: textB,
          note: kindB === 'not-found' ? '分类为端点或模型不存在（符合需求 R5 分类要求）' : '分类仍非 not-found，需复核',
        },
      };
    },
  },

  {
    id: 'E2E-08',
    title: '临时移除文件配置→未配置提示+去配置→页面保存→真实对话成功（结束恢复文件）',
    requirements: 'R7',
    expected: '未配置时提示明确且带入口，其它功能正常；保存后来源=页面配置，真实对话走新配置并交付成功',
    retryable: true,
    async run(ctx, env) {
      const { app } = ctx;
      const beforeHash = await sha256Of(APP_AGENT_CONFIG);
      ctx.check('前置：文件配置 agent-config.js 存在', Boolean(beforeHash));
      ctx.step('备份文件配置到 .tmp/ 后临时移除', 'web/src/agent/agent-config.js');
      await mkdir(TMP_DIR, { recursive: true });
      await copyFile(APP_AGENT_CONFIG, AGENT_CONFIG_BACKUP);
      const backupHash = await sha256Of(AGENT_CONFIG_BACKUP);
      ctx.check('文件配置已备份且哈希一致', backupHash === beforeHash, `${beforeHash} vs ${backupHash}`);
      await rm(APP_AGENT_CONFIG, { force: true });
      ctx.check('文件配置已临时移除', !existsSync(APP_AGENT_CONFIG));
      let restoreInfo = null;
      try {
        ctx.step('刷新页面（文件配置缺失，来源应为未配置）');
        const ready = await app.reset();
        ctx.check('未配置状态下页面不白屏、应用就绪', ready);
        const basics = await app.evaluate(`(() => ({
          mapTiles: document.querySelectorAll('.leaflet-tile').length,
          cityLabel: (document.getElementById('city-btn-label') || {}).textContent ?? null,
          hasCityBtn: Boolean(document.getElementById('city-btn')),
          hasLogBtn: Boolean(document.getElementById('log-btn')),
          hasRoadsArea: document.querySelectorAll('.leaflet-overlay-pane').length >= 0,
        }))()`);
        ctx.check('未配置时地图/城市/日志等其它功能正常', basics.mapTiles > 0 && basics.cityLabel === '广州' && basics.hasCityBtn && basics.hasLogBtn, JSON.stringify(basics));
        await app.openPanel();
        const unconfigured = await app.state();
        ctx.check('未配置引导条可见且文案明确', unconfigured.required.hidden === false && /尚未配置/.test(unconfigured.required.text), JSON.stringify(unconfigured.required));
        ctx.check('引导条带「去配置」入口按钮', unconfigured.required.hasButton === true);
        ctx.check('设置来源=未配置', unconfigured.sourceData === 'none' && String(unconfigured.source).includes('未配置'), `source=${unconfigured.source}`);
        await ctx.shot('E2E-08-未配置提示.png');

        ctx.step('尝试发送对话（应被未配置闸门拦截）', '在越秀公园画个五角星');
        const beforeBlocked = await app.snapshot();
        await app.evaluate(EXPR.send('在越秀公园画个五角星'));
        await sleep(1500);
        const blocked = await app.snapshot();
        ctx.check('未配置时发送被拦截（不新增对话消息）', blocked.store.messageCount === beforeBlocked.store.messageCount, `${beforeBlocked.store.messageCount} → ${blocked.store.messageCount}`);
        ctx.check('未配置时输入内容不被清空', blocked.dom.inputValue === '在越秀公园画个五角星', JSON.stringify(blocked.dom.inputValue));
        const blockedState = await app.state();
        ctx.check('未配置时对话有明确提示（toast/引导条含「尚未配置」「去配置」）', /尚未配置/.test(blocked.dom.toast) || /尚未配置/.test(blockedState.required.text) || /去配置/.test(blocked.dom.toast), JSON.stringify({ toast: blocked.dom.toast, required: blockedState.required.text }));
        const rowsBlocked = await ctx.collectLogs();
        ctx.check('未配置时未发起任何真实 LLM 请求', requestsOf(rowsBlocked).length === 0, String(requestsOf(rowsBlocked).length));
        await ctx.shot('E2E-08-未配置发送被拦截.png');

        ctx.step('清空输入并点击提示中的「去配置」入口');
        await app.evaluate(`(() => { const el = document.getElementById('agent-input'); el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        const requiredClick = await app.evaluate(EXPR.click('agent-config-required-open'));
        ctx.check('「去配置」入口可点击', requiredClick?.ok === true);
        const openedByRequired = await app.waitFor(`(() => { const el = document.getElementById('agent-config'); return Boolean(el) && !el.hasAttribute('hidden'); })()`, 15000, '去配置打开设置界面');
        await sleep(600);
        const opened = await app.state();
        ctx.check('「去配置」直接打开设置界面', openedByRequired === true && opened.configOpen === true);
        ctx.check('未配置时设置来源=未配置', opened.sourceData === 'none', `data=${opened.sourceData}`);
        ctx.check('未配置时端点/密钥/模型为空', !opened.fields.endpoint && !opened.fields.model && opened.fields.apiKeyLength === 0, JSON.stringify({ endpoint: opened.fields.endpoint, model: opened.fields.model, keyLength: opened.fields.apiKeyLength }));
        ctx.check('未配置时超时/最大输出使用默认值（180000/32000）', opened.fields.timeout === '180000' && opened.fields.maxTokens === '32000', `${opened.fields.timeout}/${opened.fields.maxTokens}`);
        await ctx.shot('E2E-08-去配置填写界面.png');

        ctx.step('填写页面配置并保存（文件配置缺失，页面配置是唯一来源）', `endpoint=${env.fileConfig.baseUrl} model=${env.second.model}`);
        await app.fill({ endpoint: env.fileConfig.baseUrl, apiKey: env.fileConfig.apiKey, model: env.second.model });
        const saved = await app.save();
        ctx.check('保存成功提示含生效模型名', String(saved.notice.text).includes(env.second.model), saved.notice.text);
        ctx.check('保存后来源=页面配置', saved.sourceData === 'page', `data=${saved.sourceData}`);
        const stored = await app.storageProbe();
        ctx.check('页面配置已写入 localStorage 且模型正确', stored.exists === true && stored.parsed === true && stored.model === env.second.model, JSON.stringify({ exists: stored.exists, model: stored.model }));
        await ctx.shot('E2E-08-页面保存配置.png');
        await app.closeConfig();

        ctx.step('发起真实对话', '在越秀公园画个五角星');
        const turn = await app.runTurn('在越秀公园画个五角星');
        ctx.check('轮次在超时前完成', turn.finished, `started=${turn.started}`);
        const snap = await app.snapshot();
        const delivery = assertDelivery(ctx, snap, { label: 'E2E-08', expectShapeName: '五角星', bbox: POI.yuexiu });
        const traceId = delivery.view.lastAgent?.traceId ?? null;
        ctx.record.traceIds.push(traceId);
        ctx.record.delivery = { kind: delivery.kind, shapeName: delivery.view.lastShape?.shapeName ?? null, pointCount: delivery.view.points.length, reply: delivery.view.reply.slice(0, 600) };
        await ctx.shot('E2E-08-页面配置真实对话.png');
        ctx.check('对话期间文件配置仍不存在（页面配置为唯一配置来源）', !existsSync(APP_AGENT_CONFIG));
        const rows = await ctx.collectLogs();
        const requests = requestsOf(rows).filter((item) => !traceId || item.traceId === traceId);
        const responses = responsesOf(rows).filter((item) => !traceId || item.traceId === traceId);
        ctx.check('真实请求 model=页面保存的第二套模型', requests.length > 0 && requests.every((item) => item.model === env.second.model), JSON.stringify(requests.map((item) => item.model)));
        ctx.check('真实请求 baseUrl=页面保存端点', requests.length > 0 && requests.every((item) => item.baseUrl === env.second.baseUrl), JSON.stringify(requests.map((item) => item.baseUrl)));
        ctx.check('收到真实响应', responses.length > 0 && responses.some((item) => typeof item.responseModel === 'string' && item.responseModel.length > 0));
        ctx.record.extra.requestSummary = {
          requestCount: requests.length,
          responseCount: responses.length,
          durationsMs: responses.map((item) => (Number.isFinite(item.durationMs) ? Math.round(item.durationMs) : null)),
          traceId,
        };
      } finally {
        if (!existsSync(APP_AGENT_CONFIG)) {
          await copyFile(AGENT_CONFIG_BACKUP, APP_AGENT_CONFIG);
        }
        const afterHash = await sha256Of(APP_AGENT_CONFIG);
        restoreInfo = { beforeHash, backupHash, afterHash, equals: afterHash === beforeHash };
        ctx.record.extra.fileRestore = restoreInfo;
        ctx.step('恢复文件配置并校验 SHA256', `after=${afterHash}`);
      }
      ctx.check('E2E-08 结束文件配置已恢复且 SHA256 与验收前一致', restoreInfo?.equals === true, JSON.stringify(restoreInfo));
      ctx.check('恢复后文件配置存在', existsSync(APP_AGENT_CONFIG));
    },
  },

  {
    id: 'E2E-09',
    title: '真实密钥全文检索：页面导出 JSONL / web/logs / DOM 提示 0 命中；配置确实保存',
    requirements: 'R8',
    expected: '运行记录、导出文件与提示中密钥 0 命中；配置确实保存在浏览器中；配置变更动作可追溯（不含密钥）',
    retryable: true,
    async run(ctx, env) {
      const { app } = ctx;
      ctx.step('清空页面配置并刷新（独立会话），打开设置界面');
      const ready = await app.reset();
      ctx.check('页面刷新后应用就绪', ready);
      await app.openPanel();
      await app.openConfig();
      ctx.step('保存第二套页面配置（密钥沿用文件配置回显，不落任何产物）', `model=${env.second.model}`);
      await app.fill({ model: env.second.model });
      const saved1 = await app.save();
      ctx.check('第一次保存成功（提示含模型名）', /已保存并生效/.test(saved1.notice.text) && saved1.notice.text.includes(env.second.model), saved1.notice.text);

      ctx.step('测试连接（真实请求，留下运行记录）');
      const test = await app.testConnection({ timeoutMs: 150000 });
      ctx.check('测试连接真实成功（显示模型与耗时）', /连接成功/.test(test.state.testResult.text) && /\d/.test(test.state.testResult.text), test.state.testResult.text);
      await sleep(1200);

      ctx.step('恢复默认（产生 llm.config.restored 留痕）');
      const trigger = await app.evaluate(EXPR.click('llm-config-restore'));
      ctx.check('恢复默认按钮可点击', trigger?.ok === true);
      await app.waitFor(`(() => { const el = document.getElementById('llm-config-restore-confirm'); return Boolean(el) && !el.hasAttribute('hidden'); })()`, 10000, '恢复默认二次确认出现');
      await app.evaluate(EXPR.click('llm-config-restore-ok'));
      await app.waitFor(`(() => { const el = document.getElementById('llm-config-source'); return Boolean(el) && el.getAttribute('data-source') !== 'page'; })()`, 15000, '恢复默认来源回落');
      await sleep(500);
      const restored = await app.state();
      ctx.check('恢复默认后来源回落文件配置', restored.sourceData === 'file', `data=${restored.sourceData}`);

      ctx.step('重新保存第二套页面配置（产生 llm.config.saved 留痕，供对话使用）', `model=${env.second.model}`);
      await app.fill({ model: env.second.model });
      const saved2 = await app.save();
      ctx.check('重新保存成功且来源=页面配置', saved2.sourceData === 'page' && /已保存并生效/.test(saved2.notice.text), saved2.notice.text);
      await ctx.shot('E2E-09-配置已保存.png');
      await app.closeConfig();

      ctx.step('发起真实对话（当轮真实密钥即该配置密钥）', '在越秀公园画个五角星');
      const turn = await app.runTurn('在越秀公园画个五角星');
      ctx.check('轮次在超时前完成', turn.finished, `started=${turn.started}`);
      const snap = await app.snapshot();
      const delivery = assertDelivery(ctx, snap, { label: 'E2E-09', expectShapeName: '五角星', bbox: POI.yuexiu });
      const traceId = delivery.view.lastAgent?.traceId ?? null;
      ctx.record.traceIds.push(traceId);
      await ctx.shot('E2E-09-页面配置真实对话.png');
      await sleep(2500); // 等服务端日志落盘 flush

      ctx.step('以当轮真实密钥全文检索：页面导出 JSONL / 服务端日志 / DOM 提示');
      const rows = await ctx.collectLogs();
      const configEvents = rows.filter((row) => row.event === 'llm.config.saved' || row.event === 'llm.config.restored');
      const savedEvents = configEvents.filter((row) => row.event === 'llm.config.saved');
      const restoredEvents = configEvents.filter((row) => row.event === 'llm.config.restored');
      ctx.check('配置变更留痕 llm.config.saved 存在', savedEvents.length >= 1, `count=${savedEvents.length}`);
      ctx.check('配置变更留痕 llm.config.restored 存在', restoredEvents.length >= 1, `count=${restoredEvents.length}`);
      const configText = JSON.stringify(configEvents);
      ctx.check('配置变更留痕不含真实密钥', countOccurrences(configText, env.fileConfig.apiKey) === 0, `length=${configText.length}`);
      ctx.check('配置变更留痕记录端点/模型（可追溯）', savedEvents.some((row) => row.data?.model === env.second.model) && restoredEvents.some((row) => row.data?.previousSource === 'page' || row.data?.source === 'file'), JSON.stringify(configEvents.map((row) => row.event)));

      const stored = await app.storageProbe();
      ctx.check(
        '浏览器中确实保存了页面配置（证明持久化发生，密钥长度一致）',
        stored.exists === true && stored.parsed === true && stored.hasApiKey === true && stored.apiKeyLength === env.fileConfig.apiKey.length && stored.model === env.second.model,
        JSON.stringify({ exists: stored.exists, hasApiKey: stored.hasApiKey, apiKeyLength: stored.apiKeyLength, expectedLength: env.fileConfig.apiKey.length, model: stored.model }),
      );

      const jsonl = await app.exportJsonl();
      ctx.check('页面运行记录可导出 JSONL（非空）', typeof jsonl === 'string' && jsonl.length > 0, `length=${typeof jsonl === 'string' ? jsonl.length : -1}`);
      const jsonlHits = typeof jsonl === 'string' ? countOccurrences(jsonl, env.fileConfig.apiKey) : -1;
      ctx.check('页面导出 JSONL 中真实密钥 0 命中', jsonlHits === 0, `hits=${jsonlHits} length=${typeof jsonl === 'string' ? jsonl.length : -1}`);

      const domText = await app.domText();
      const domHits = typeof domText === 'string' ? countOccurrences(domText, env.fileConfig.apiKey) : -1;
      ctx.check('页面 DOM 文本/错误提示中真实密钥 0 命中', domHits === 0, `hits=${domHits}`);

      const serverScan = await scanServerLogs(env.fileConfig.apiKey);
      ctx.check(
        `服务端落盘日志 web/logs/*.jsonl 中真实密钥 0 命中（扫描 ${serverScan.files} 文件 / ${serverScan.lines} 行 / ${serverScan.bytes} 字节）`,
        serverScan.hits === 0 && serverScan.files > 0,
        `hits=${serverScan.hits} files=${serverScan.files} lines=${serverScan.lines}${serverScan.error ? ` error=${serverScan.error}` : ''}`,
      );
      ctx.record.leaks = {
        jsonlHits,
        jsonlLength: typeof jsonl === 'string' ? jsonl.length : null,
        domHits,
        serverHits: serverScan.hits,
        serverFiles: serverScan.files,
        serverLines: serverScan.lines,
        note: '真实密钥全文检索（0 命中才通过）；密钥只应存在于浏览器 localStorage 与内存',
      };
      ctx.record.config = {
        saved: savedEvents.map((row) => ({ model: row.data?.model ?? null, source: row.data?.source ?? null, baseUrl: row.data?.baseUrl ?? null })),
        restored: restoredEvents.map((row) => ({ source: row.data?.source ?? null, previousSource: row.data?.previousSource ?? null, previousModel: row.data?.previousModel ?? null })),
        stored: { exists: stored.exists, model: stored.model, hasApiKey: stored.hasApiKey, apiKeyLength: stored.apiKeyLength },
      };
    },
  },

  {
    id: 'E2E-10',
    title: '损坏页面配置→刷新→忽略并回落文件配置提示→真实对话成功→重新保存修复',
    requirements: 'R7/边界',
    expected: '忽略损坏配置、回落文件配置并提示；对话真实成功；可重新保存修复',
    retryable: true,
    async run(ctx, env) {
      const { app } = ctx;
      ctx.step('清空页面配置并刷新（独立会话），打开设置界面');
      const ready = await app.reset();
      ctx.check('页面刷新后应用就绪', ready);
      await app.openPanel();
      await app.openConfig();
      const initial = await app.state();
      ctx.check('构造损坏配置前来源=文件配置', initial.sourceData === 'file', `data=${initial.sourceData}`);
      await app.closeConfig();
      const key = await app.resolveStorageKey();
      ctx.check('取得页面配置存储键（用于构造损坏数据）', Boolean(key), String(key));
      ctx.step('在浏览器 localStorage 构造损坏的页面配置', '非法 JSON 文本');
      const write = await app.writeStorage('{"version":1,"baseUrl":"not-a-url","apiKey":');
      ctx.check('损坏配置写入 localStorage 成功', write?.ok === true, JSON.stringify(write));

      ctx.step('刷新页面，核对忽略损坏配置并回落文件配置');
      const readyReload = await app.reload();
      ctx.check('页面不白屏（刷新后应用就绪）', readyReload);
      // 面板 toast（T2：损坏配置在初始化时浮出一次）——最多等 4s 捕获，随后再核对设置界面 notice
      const toastShown = await app.waitFor(
        `(() => {
          const texts = Array.from(document.querySelectorAll('.agent-toast')).map((el) => (el.textContent || '').trim());
          return texts.some((text) => /损坏/.test(text) || /已忽略/.test(text));
        })()`,
        5000,
        '损坏配置面板 toast',
        200,
      );
      const toastSnap = await app.snapshot();
      ctx.check('损坏配置在面板浮出提示 toast（初始化一次）', toastShown || /损坏/.test(toastSnap.dom.toast), JSON.stringify({ text: toastSnap.dom.toast, visible: toastSnap.dom.toastVisible }));
      const basics = await app.evaluate(`(() => ({ mapTiles: document.querySelectorAll('.leaflet-tile').length, cityLabel: (document.getElementById('city-btn-label') || {}).textContent ?? null }))()`);
      ctx.check('损坏配置下地图等其它功能不中断', basics.mapTiles > 0 && basics.cityLabel === '广州', JSON.stringify(basics));
      await app.openPanel();
      await app.openConfig();
      const state = await app.state();
      ctx.check('来源回落=文件配置', state.sourceData === 'file', `data=${state.sourceData}`);
      ctx.check('提示「配置已损坏，已忽略（可重新保存）」', /配置已损坏/.test(state.notice.text) && /已忽略/.test(state.notice.text), state.notice.text);
      const rowsCorrupt = await ctx.collectLogs();
      ctx.check('运行记录含损坏检测事件', rowsCorrupt.some((row) => String(row.event).includes('llm.config.corrupt') || String(row.event).includes('corrupt')), JSON.stringify(rowsCorrupt.filter((row) => String(row.event).includes('corrupt')).map((row) => row.event)));
      await ctx.shot('E2E-10-损坏配置提示.png');
      await app.closeConfig();

      ctx.step('损坏配置回落状态下发起真实对话（应走文件配置）', '在广州塔附近画个心形');
      const turn = await app.runTurn('在广州塔附近画个心形');
      ctx.check('轮次在超时前完成', turn.finished, `started=${turn.started}`);
      const snap = await app.snapshot();
      const delivery = assertDelivery(ctx, snap, { label: 'E2E-10', expectShapeName: '心形', bbox: POI.cantonTower });
      const traceId = delivery.view.lastAgent?.traceId ?? null;
      ctx.record.traceIds.push(traceId);
      ctx.record.delivery = { kind: delivery.kind, shapeName: delivery.view.lastShape?.shapeName ?? null, pointCount: delivery.view.points.length, reply: delivery.view.reply.slice(0, 600) };
      await ctx.shot('E2E-10-回落文件配置真实对话.png');
      const rows = await ctx.collectLogs();
      const requests = requestsOf(rows).filter((item) => !traceId || item.traceId === traceId);
      ctx.check('损坏配置下真实请求走文件配置模型', requests.length > 0 && requests.every((item) => item.model === env.fileConfig.model), JSON.stringify(requests.map((item) => item.model)));
      ctx.check('损坏配置下真实请求走文件配置端点', requests.length > 0 && requests.every((item) => item.baseUrl === env.fileConfig.baseUrl), JSON.stringify(requests.map((item) => item.baseUrl)));

      ctx.step('重新保存第二套配置修复损坏状态');
      await app.openConfig();
      await app.fill({ model: env.second.model });
      const saved = await app.save();
      ctx.check('重新保存成功且提示含模型名', /已保存并生效/.test(saved.notice.text) && saved.notice.text.includes(env.second.model), saved.notice.text);
      ctx.check('修复后来源=页面配置', saved.sourceData === 'page', `data=${saved.sourceData}`);
      const stored = await app.storageProbe();
      ctx.check('修复后 localStorage 配置为合法 JSON 且模型正确', stored.exists === true && stored.parsed === true && stored.model === env.second.model, JSON.stringify({ exists: stored.exists, parsed: stored.parsed, model: stored.model }));
      await ctx.shot('E2E-10-重新保存修复.png');

      ctx.step('再次刷新，确认修复持久生效');
      const readyFinal = await app.reload();
      ctx.check('修复后刷新应用就绪', readyFinal);
      await app.openPanel();
      await app.openConfig();
      const finalState = await app.state();
      ctx.check('修复后来源=页面配置', finalState.sourceData === 'page', `data=${finalState.sourceData}`);
      ctx.check('修复后回显第二套模型', finalState.fields.model === env.second.model, `${finalState.fields.model}`);
      ctx.check('修复后不再提示配置损坏', !/配置已损坏/.test(finalState.notice.text), finalState.notice.text);
      await ctx.shot('E2E-10-修复后刷新仍生效.png');
      ctx.record.config = {
        corruptNotice: state.notice.text,
        corruptToast: toastSnap.dom.toast,
        fallbackSource: state.source,
        repairedSource: finalState.source,
        stored: { exists: stored.exists, parsed: stored.parsed, model: stored.model },
      };
      ctx.record.extra.requestSummary = {
        requestCount: requests.length,
        responseCount: responsesOf(rows).filter((item) => !traceId || item.traceId === traceId).length,
        traceId,
      };
    },
  },

  {
    id: 'E2E-11',
    title: '文件配置画图轮次进行中保存第二套→当前轮不中断仍走旧配置→下一轮走新配置',
    requirements: 'R4/边界',
    expected: '当前轮不中断、仍按旧配置完成；下一轮走新配置；与停止功能不冲突',
    retryable: true,
    async run(ctx, env) {
      const { app } = ctx;
      ctx.step('清空页面配置并刷新（独立会话），确认来源=文件配置');
      const ready = await app.reset();
      ctx.check('页面刷新后应用就绪', ready);
      await app.openPanel();
      await app.openConfig();
      const initial = await app.state();
      ctx.check('初始来源=文件配置（本轮走文件配置）', initial.sourceData === 'file', `data=${initial.sourceData}`);
      await app.closeConfig();

      const firstPrompt = '在花城广场画一只猫的自由轮廓，要能认出来';
      ctx.step('用文件配置发起真实画图轮次（较复杂，便于生成中保存）', firstPrompt);
      const sendAt = Date.now();
      await app.send(firstPrompt);
      const started = await app.waitTurnStart(20000);
      ctx.check('第一轮真实轮次已开始', started);
      await sleep(1200);

      ctx.step('生成中打开设置界面并保存第二套配置', `model=${env.second.model}`);
      const openedMid = await app.openConfig();
      ctx.check('轮次进行中可打开设置界面', openedMid === true);
      const midState = await app.state();
      ctx.check('轮次进行中发送按钮仍为「停止」（轮次未中断）', midState.agentSendLabel === '停止', midState.agentSendLabel);
      ctx.check('轮次进行中保存按钮未禁用', midState.buttons.saveDisabled === false);
      await app.fill({ model: env.second.model });
      const savedMid = await app.save();
      const saveAt = Date.now();
      ctx.check('生成中保存成功且提示含新模型名', /已保存并生效/.test(savedMid.notice.text) && savedMid.notice.text.includes(env.second.model), savedMid.notice.text);
      ctx.check('生成中保存后来源=页面配置', savedMid.sourceData === 'page', `data=${savedMid.sourceData}`);
      await ctx.shot('E2E-11-生成中保存第二套配置.png');
      await app.closeConfig();

      ctx.step('等待第一轮完成（保存后不打断）');
      const finished1 = await app.waitFor(EXPR.turnFinished(sendAt), 600000, 'E2E-11 第一轮完成', 500);
      ctx.check('保存配置后当前轮不中断、正常完成', finished1);
      await sleep(1200);
      const snap1 = await app.snapshot();
      const trace1 = deliveryView(snap1).lastAgent?.traceId ?? null;
      ctx.record.traceIds.push(trace1);
      const reply1 = deliveryView(snap1).reply;
      ctx.check('第一轮有真实回复', reply1.trim().length > 0, reply1.slice(0, 160));
      const view1 = deliveryView(snap1);
      ctx.check('第一轮交付行为一致（绿/橙线 或 无虚假线）', view1.delivered ? view1.green || view1.orange : !view1.green && !view1.orange, `green=${view1.green} orange=${view1.orange} shapes=${view1.shapes.length}`);
      await ctx.shot('E2E-11-第一轮完成.png');

      const rows = await ctx.collectLogs();
      const reqRound1 = requestsOf(rows).filter((item) => !trace1 || item.traceId === trace1);
      const postSaveRequests = reqRound1.filter((item) => item.ts > saveAt);
      const abortEvents = rows.filter((row) => ['llm.aborted', 'agent.abort', 'agent.turn.abort', 'ui.stop'].includes(row.event));
      ctx.check('第一轮存在真实 LLM 请求记录', reqRound1.length > 0, `count=${reqRound1.length}`);
      ctx.check('第一轮全部真实请求仍使用文件配置模型（本轮快照未被保存改写）', reqRound1.length > 0 && reqRound1.every((item) => item.model === env.fileConfig.model), JSON.stringify(reqRound1.map((item) => item.model)));
      ctx.check('保存之后第一轮仍有真实请求发出（证明是保存前创建的轮次快照）', postSaveRequests.length > 0, `postSave=${postSaveRequests.length} saveAt=${saveAt} reqTs=${JSON.stringify(reqRound1.map((item) => item.ts))}`);
      ctx.check('第一轮没有中止/停止记录（保存未打断当前轮）', abortEvents.length === 0, JSON.stringify(abortEvents.map((row) => row.event)));
      ctx.check('第一轮保存前后轮次未完成（保存发生在轮次结束前）', finished1 === true);

      ctx.step('发起第二轮真实对话（应走保存后的新配置）', '在越秀公园画个五角星');
      const turn2 = await app.runTurn('在越秀公园画个五角星');
      ctx.check('第二轮在超时前完成', turn2.finished, `started=${turn2.started}`);
      const snap2 = await app.snapshot();
      const delivery2 = assertDelivery(ctx, snap2, { label: 'E2E-11 第二轮', expectShapeName: '五角星', bbox: POI.yuexiu });
      const trace2 = delivery2.view.lastAgent?.traceId ?? null;
      ctx.record.traceIds.push(trace2);
      await ctx.shot('E2E-11-第二轮走新配置.png');
      const rows2 = await ctx.collectLogs();
      const reqRound2 = requestsOf(rows2).filter((item) => !trace2 || item.traceId === trace2);
      ctx.check('第二轮真实请求走保存后的新配置模型', reqRound2.length > 0 && reqRound2.every((item) => item.model === env.second.model), JSON.stringify(reqRound2.map((item) => item.model)));
      ctx.check('第二轮真实请求 baseUrl=新配置端点', reqRound2.length > 0 && reqRound2.every((item) => item.baseUrl === env.second.baseUrl), JSON.stringify(reqRound2.map((item) => item.baseUrl)));

      ctx.step('第三轮：点击「停止」验证配置变更/设置入口与停止功能不冲突', '在花城广场画个心形');
      const stopSendAt = Date.now();
      await app.send('在花城广场画个心形');
      const stopStarted = await app.waitTurnStart(20000);
      ctx.check('停止验证轮次已开始', stopStarted);
      await sleep(600);
      const beforeStop = await app.state();
      ctx.check('停止按钮可点击（配置保存后停止功能仍可用）', beforeStop.agentSendLabel === '停止', `label=${beforeStop.agentSendLabel}`);
      const stopClick = await app.evaluate(EXPR.click('agent-send'));
      const stopAt = Date.now();
      ctx.check('点击停止按钮成功', stopClick?.ok === true, JSON.stringify(stopClick));
      const stopFinished = await app.waitFor(EXPR.turnFinished(stopSendAt), 60000, '停止后轮次结束', 300);
      ctx.check('点击停止后轮次结束（不挂死）', stopFinished);
      await sleep(1200);
      const stopSnap = await app.snapshot();
      const stopLast = [...(stopSnap.store?.messages ?? [])].reverse().find((message) => message.role !== 'user') ?? null;
      ctx.check('停止后消息状态标记为已停止（不误报成功）', Boolean(stopLast && (stopLast.status === 'stopped' || /停止/.test(stopLast.text ?? ''))), JSON.stringify({ status: stopLast?.status ?? null, text: (stopLast?.text ?? '').slice(0, 120) }));
      const stopRows = await ctx.collectLogs();
      const afterStopRequests = requestsOf(stopRows).filter((item) => item.ts > stopAt + 1500);
      ctx.check('停止后不再自动发起新的真实请求（不自动重试）', afterStopRequests.length === 0, JSON.stringify(afterStopRequests.map((item) => item.ts)));
      await ctx.shot('E2E-11-第三轮停止验证.png');

      ctx.record.extra.timing = {
        sendAt,
        saveAt,
        saveAfterSendMs: saveAt - sendAt,
        round1: {
          traceId: trace1,
          requestCount: reqRound1.length,
          postSaveRequestCount: postSaveRequests.length,
          models: [...new Set(reqRound1.map((item) => item.model))],
          reply: reply1.slice(0, 400),
        },
        round2: {
          traceId: trace2,
          requestCount: reqRound2.length,
          models: [...new Set(reqRound2.map((item) => item.model))],
        },
        stopConflict: {
          abortEvents: abortEvents.map((row) => row.event),
          stopTest: {
            clicked: beforeStop.agentSendLabel,
            clickOk: stopClick?.ok === true,
            finished: stopFinished,
            lastStatus: stopLast?.status ?? null,
            afterStopRequests: afterStopRequests.length,
          },
        },
      };
      ctx.record.delivery = { kind: delivery2.kind, shapeName: delivery2.view.lastShape?.shapeName ?? null, pointCount: delivery2.view.points.length };
    },
  },

  {
    id: 'E2E-13',
    title: '375px 窄屏：打开设置/填写/保存/真实测试连接，无横向溢出',
    requirements: 'R1/窄屏',
    expected: '无横向溢出；可正常操作；真实测试连接成功；保存后对话可用',
    retryable: true,
    async run(ctx, env) {
      const { app } = ctx;
      ctx.step('清空页面配置并刷新（独立会话），设置 375px 视口（Emulation.setDeviceMetricsOverride）');
      const ready = await app.reset();
      ctx.check('页面刷新后应用就绪', ready);
      await app.setViewport(375, 812);
      const readyNarrow = await app.reload();
      ctx.check('375px 视口下应用就绪', readyNarrow);
      const layout0 = await app.evaluate(`(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }))()`);
      ctx.check('375px 视口下页面默认无横向溢出', layout0.scrollWidth <= layout0.innerWidth, JSON.stringify(layout0));
      try {
        ctx.step('375px 视口打开智能体面板与设置界面');
        await app.openPanel();
        await app.openConfig();
        const opened = await app.state();
        ctx.check('375px 视口设置界面可打开', opened.configOpen === true);
        ctx.check('375px 视口设置界面无横向溢出', opened.scrollWidth <= opened.innerWidth, `${opened.scrollWidth} vs ${opened.innerWidth}`);
        await ctx.shot('E2E-13-375px-设置界面.png');

        ctx.step('375px 视口填写第二套配置并保存', `model=${env.second.model}`);
        await app.fill({ model: env.second.model });
        const saved = await app.save();
        ctx.check('375px 视口保存成功且提示含模型名', /已保存并生效/.test(saved.notice.text) && saved.notice.text.includes(env.second.model), saved.notice.text);
        ctx.check('375px 视口保存后来源=页面配置', saved.sourceData === 'page', `data=${saved.sourceData}`);
        ctx.check('375px 视口保存后无横向溢出', saved.scrollWidth <= saved.innerWidth, `${saved.scrollWidth} vs ${saved.innerWidth}`);
        await ctx.shot('E2E-13-375px-保存配置.png');

        ctx.step('375px 视口点击「测试连接」（真实请求）');
        const test = await app.testConnection({ timeoutMs: 150000 });
        const testText = test.state.testResult.text;
        ctx.check('375px 视口真实测试连接成功', /连接成功/.test(testText), testText);
        ctx.check('375px 视口测试连接显示真实模型与耗时', testText.includes(env.second.model) && /\d+(\.\d+)?\s*(ms|毫秒|秒)/.test(testText), testText);
        ctx.check('375px 视口测试连接后无横向溢出', test.state.scrollWidth <= test.state.innerWidth, `${test.state.scrollWidth} vs ${test.state.innerWidth}`);
        await ctx.shot('E2E-13-375px-测试连接成功.png');
        await app.closeConfig();

        ctx.step('375px 视口发起真实对话（保存后对话可用）', '在越秀公园画个五角星');
        const turn = await app.runTurn('在越秀公园画个五角星');
        ctx.check('375px 视口真实对话在超时前完成', turn.finished, `started=${turn.started}`);
        const snap = await app.snapshot();
        const delivery = assertDelivery(ctx, snap, { label: 'E2E-13', expectShapeName: '五角星', bbox: POI.yuexiu });
        const traceId = delivery.view.lastAgent?.traceId ?? null;
        ctx.record.traceIds.push(traceId);
        ctx.record.delivery = { kind: delivery.kind, shapeName: delivery.view.lastShape?.shapeName ?? null, pointCount: delivery.view.points.length, reply: delivery.view.reply.slice(0, 600) };
        await ctx.shot('E2E-13-375px-真实对话.png');
        const layoutAfter = await app.evaluate(`(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }))()`);
        ctx.check('375px 视口真实对话后仍无横向溢出', layoutAfter.scrollWidth <= layoutAfter.innerWidth, JSON.stringify(layoutAfter));
        const rows = await ctx.collectLogs();
        const requests = requestsOf(rows).filter((item) => !traceId || item.traceId === traceId);
        ctx.check('375px 视口真实对话请求走页面配置模型', requests.length > 0 && requests.every((item) => item.model === env.second.model), JSON.stringify(requests.map((item) => item.model)));
        ctx.record.extra.layout = { viewport: '375x812', default: layout0, opened: { scrollWidth: opened.scrollWidth, innerWidth: opened.innerWidth }, saved: { scrollWidth: saved.scrollWidth, innerWidth: saved.innerWidth }, afterDialogue: layoutAfter };
      } finally {
        await app.clearViewport();
      }
    },
  },

  {
    id: 'E2E-14',
    title: '获取模型：无密钥本地拦截；有密钥真实 GET /models→真实列表→选择→保存→测试连接成功',
    requirements: '追加需求（获取模型 2026-11-10）/R2/R5/§7.4',
    expected:
      '无密钥点「获取模型」被本地校验拦截且不发请求、密钥字段标红；有密钥时真实 GET {baseUrl}/models 成功，结果区显示真实数量、下拉 option 数=N+1 且含真实模型；选择后 #llm-model 被填入；保存成功来源=页面配置并含模型名；测试连接真实成功；不写消息/不画图/不改地图；密钥 0 泄漏',
    retryable: true,
    async run(ctx, env) {
      const { app } = ctx;
      const modelA = 'deepseek-v4.1-flash';
      const modelB = env.second.model;
      ctx.step('清空页面配置并刷新（独立会话），打开设置界面');
      const ready = await app.reset();
      ctx.check('页面刷新后应用就绪', ready);
      await app.openPanel();
      await app.openConfig();
      const initial = await app.state();
      ctx.check('初始来源=文件配置且密钥已回显', initial.sourceData === 'file' && initial.fields.apiKeyLength > 0, JSON.stringify({ source: initial.sourceData, keyLength: initial.fields.apiKeyLength }));
      ctx.check('「获取模型」按钮存在（追加需求契约）', initial.models.fetchExists === true);
      ctx.check('初始未展示模型下拉框', initial.models.selectHidden === true || initial.models.selectExists === false, JSON.stringify({ exists: initial.models.selectExists, hidden: initial.models.selectHidden }));

      // ---------- 负向：无密钥时本地校验拦截、不发请求 ----------
      ctx.step('负向：清空密钥后点击「获取模型」（应被本地校验拦截、不发请求）');
      const negStart = Date.now();
      const beforeNegModels = await app.modelsRequestInfo();
      const beforeNegChat = await app.chatRequestCount();
      await app.fill({ apiKey: '' });
      const cleared = await app.state();
      ctx.check('负向：密钥字段已清空', cleared.fields.apiKeyLength === 0, String(cleared.fields.apiKeyLength));
      await app.evaluate(EXPR.click('llm-models-fetch'));
      await sleep(1500);
      const negState = await app.state();
      ctx.check('负向：密钥字段错误可见且提示密钥必填', Boolean(negState.errors.apiKey) && negState.errors.apiKey.hidden === false && /密钥/.test(negState.errors.apiKey.text), JSON.stringify(negState.errors.apiKey));
      const afterNegModels = await app.modelsRequestInfo();
      const afterNegChat = await app.chatRequestCount();
      ctx.check('负向：未发出 /models 真实请求（Resource Timing 无新增）', afterNegModels.count === beforeNegModels.count, `${beforeNegModels.count} → ${afterNegModels.count}`);
      ctx.check('负向：未发出 /chat/completions 请求', afterNegChat === beforeNegChat);
      const negRows = await ctx.collectLogs(negStart);
      ctx.check('负向：运行记录无 llm.config.models.request（未发请求）', negRows.filter((row) => row.event === 'llm.config.models.request').length === 0, JSON.stringify(negRows.filter((row) => String(row.event).includes('models')).map((row) => row.event)));
      ctx.check('负向：未触发任何对话 LLM 请求', requestsOf(negRows).length === 0);
      ctx.check('负向：模型下拉框未出现', negState.models.selectHidden === true || negState.models.selectExists === false, JSON.stringify({ exists: negState.models.selectExists, hidden: negState.models.selectHidden }));
      await ctx.shot('E2E-14-空密钥被拦截.png');

      // ---------- 正向：回填密钥后真实 GET /models ----------
      ctx.step('回填密钥后重试「获取模型」（真实 GET 配置端点的 /models）');
      await app.fill({ apiKey: env.fileConfig.apiKey });
      const backFilled = await app.state();
      ctx.check('回填密钥成功（长度与文件配置一致）', backFilled.fields.apiKeyLength === env.fileConfig.apiKey.length, `${backFilled.fields.apiKeyLength}`);
      const posStart = Date.now();
      const beforePosSnap = await app.snapshot();
      const beforePosModels = await app.modelsRequestInfo();
      const beforePosChat = await app.chatRequestCount();
      await app.evaluate(EXPR.click('llm-models-fetch'));
      const fetched = await app.waitModelsFetched(120000);
      await sleep(800);
      ctx.check('正向：获取模型完成（按钮恢复、结果/下拉框有内容）', fetched);
      const state = await app.state();
      const afterPosModels = await app.modelsRequestInfo();
      const newModelUrls = afterPosModels.urls.filter((url) => !beforePosModels.urls.includes(url));
      ctx.check('正向：Resource Timing 观测到真实 GET /models 请求', afterPosModels.count > beforePosModels.count, JSON.stringify({ before: beforePosModels.count, after: afterPosModels.count }));
      ctx.check('正向：请求 URL 为配置端点的 /models', newModelUrls.some((url) => url.replace(/\/+$/, '').endsWith('/models')), JSON.stringify(newModelUrls));
      ctx.check('正向：获取模型期间未请求 /chat/completions', (await app.chatRequestCount()) === beforePosChat, `${beforePosChat} → ${await app.chatRequestCount()}`);
      const rows = await ctx.collectLogs(posStart);
      const modelsRequestEvents = rows.filter((row) => row.event === 'llm.config.models.request');
      const modelsSuccessEvents = rows.filter((row) => row.event === 'llm.config.models.success');
      ctx.check('正向：运行记录含 llm.config.models.request（真实请求留痕）', modelsRequestEvents.length >= 1, JSON.stringify(modelsRequestEvents.map((row) => row.data)));
      ctx.check('正向：运行记录含 llm.config.models.success（真实响应留痕）', modelsSuccessEvents.length >= 1, JSON.stringify(modelsSuccessEvents.map((row) => row.data)));

      const countFromText = Number((state.models.resultText.match(/(\d+)\s*个/) ?? [])[1] ?? NaN);
      const logCountRaw = modelsSuccessEvents[0]?.data?.modelCount ?? modelsSuccessEvents[0]?.data?.count ?? modelsSuccessEvents[0]?.data?.modelsCount ?? null;
      const logCount = Number(logCountRaw);
      const optionCount = state.models.optionCount;
      const realCount = [logCount, countFromText].find((value) => Number.isFinite(value) && value > 0) ?? (optionCount > 1 ? optionCount - 1 : NaN);
      ctx.check('正向：结果区显示真实模型数量 N>0', Number.isFinite(realCount) && realCount > 0, `resultText=${state.models.resultText} logCount=${logCountRaw} countFromText=${countFromText}`);
      ctx.check('正向：下拉框出现且 option 数 = N+1（含占位项）', state.models.selectExists === true && state.models.selectHidden === false && optionCount === realCount + 1, `options=${optionCount} N=${realCount}`);
      const optionValues = state.models.options.map((item) => item.value);
      const placeholder = state.models.options[0]?.text ?? '';
      ctx.check(`正向：下拉选项含真实响应模型「${modelA}」`, optionValues.includes(modelA), `sample=${JSON.stringify(optionValues.slice(0, 10))}`);
      ctx.check(`正向：下拉选项含真实响应模型「${modelB}」`, optionValues.includes(modelB));
      ctx.check('正向：首项为占位「选择模型（共 N 个）」', optionValues[0] === '' && /选择模型/.test(placeholder) && placeholder.includes(String(realCount)), placeholder);
      ctx.check('正向：结果区文本含真实数量', Number.isFinite(realCount) && state.models.resultText.includes(String(realCount)), state.models.resultText);
      ctx.check('正向：日志中的模型数量与界面数量一致或至少一方可核对', !Number.isFinite(logCount) || !Number.isFinite(countFromText) || logCount === countFromText, JSON.stringify({ logCount, countFromText, optionCount }));
      await ctx.shot('E2E-14-获取模型列表.png');

      // ---------- 选择 → 回填 → 保存 ----------
      ctx.step('下拉选择真实模型并回填 #llm-model', modelA);
      const selected = await app.selectModel(modelA);
      ctx.check('下拉选择成功', selected?.ok === true, JSON.stringify(selected));
      await sleep(500);
      const selectedState = await app.state();
      ctx.check('#llm-model 被填入所选模型名', selectedState.fields.model === modelA, `${selectedState.fields.model}`);
      ctx.step('保存配置并核对来源/提示');
      const saved = await app.save();
      ctx.check('保存成功提示含所选模型名', /已保存并生效/.test(saved.notice.text) && saved.notice.text.includes(modelA), saved.notice.text);
      ctx.check('保存后来源=页面配置', saved.sourceData === 'page', `data=${saved.sourceData}`);
      const stored = await app.storageProbe();
      ctx.check('页面配置已写入 localStorage 且模型=所选模型', stored.exists === true && stored.model === modelA, JSON.stringify({ exists: stored.exists, model: stored.model }));
      await ctx.shot('E2E-14-选择模型并保存.png');

      // ---------- 测试连接（真实请求） ----------
      ctx.step('点击「测试连接」（真实请求所选模型）');
      const test = await app.testConnection({ timeoutMs: 150000 });
      const testText = test.state.testResult.text;
      ctx.check('测试连接真实成功', /连接成功/.test(testText), testText);
      ctx.check('测试连接显示所选模型与真实耗时', testText.includes(modelA) && /\d+(\.\d+)?\s*(ms|毫秒|秒)/.test(testText), testText);

      // ---------- 无副作用 ----------
      const afterSnap = await app.snapshot();
      ctx.check('获取模型/选择/保存不写对话消息', afterSnap.store.messageCount === beforePosSnap.store.messageCount, `${beforePosSnap.store.messageCount} → ${afterSnap.store.messageCount}`);
      ctx.check('不触发画图（地图 overlay 数不变）', afterSnap.dom.overlayCount === beforePosSnap.dom.overlayCount, `${beforePosSnap.dom.overlayCount} → ${afterSnap.dom.overlayCount}`);
      ctx.check('不改变地图视野（中心/缩放不变）', afterSnap.dom.center === beforePosSnap.dom.center && afterSnap.dom.zoom === beforePosSnap.dom.zoom, `${beforePosSnap.dom.center}/${beforePosSnap.dom.zoom} → ${afterSnap.dom.center}/${afterSnap.dom.zoom}`);

      // ---------- 密钥 0 泄漏 ----------
      ctx.step('密钥 0 泄漏自检（运行记录 JSON / 导出 JSONL / DOM 文本）');
      const allRows = await ctx.collectLogs();
      const rowsText = JSON.stringify(allRows);
      const jsonl = await app.exportJsonl();
      const domText = await app.domText();
      const hits = {
        rows: countOccurrences(rowsText, env.fileConfig.apiKey),
        jsonl: countOccurrences(String(jsonl ?? ''), env.fileConfig.apiKey),
        dom: countOccurrences(String(domText ?? ''), env.fileConfig.apiKey),
      };
      ctx.check('运行记录/导出 JSONL/DOM 中真实密钥 0 命中', hits.rows === 0 && hits.jsonl === 0 && hits.dom === 0, JSON.stringify(hits));

      ctx.record.modelsApi = {
        requestCount: Math.max(0, afterPosModels.count - beforePosModels.count),
        urls: newModelUrls,
        initiatorTypes: afterPosModels.initiatorTypes,
        realModelCount: Number.isFinite(realCount) ? realCount : null,
        logModelCount: Number.isFinite(logCount) ? logCount : null,
        countFromText: Number.isFinite(countFromText) ? countFromText : null,
        optionCount,
        placeholder,
        selectedModel: modelA,
        negative: {
          blocked: true,
          keyError: negState.errors.apiKey?.text ?? '',
          modelsRequestDelta: afterNegModels.count - beforeNegModels.count,
          chatRequestDelta: afterNegChat - beforeNegChat,
        },
      };
      ctx.record.extra.modelsFetch = { ...ctx.record.modelsApi, resultText: state.models.resultText, saveNotice: saved.notice.text, testText, keyLeakHits: hits };
      ctx.record.extra.requestSummary = { requestCount: 0, responseCount: 0, modelsRequests: ctx.record.modelsApi.requestCount, testConnectionRequests: 1 };
    },
  },
];

// ============================== 回归与辅助流程（E2E-12、结果落盘、主流程） ==============================

/**
 * 统计一段文本里子串出现次数。
 *
 * @param {string} text 文本
 * @param {string} needle 子串
 * @returns {number} 次数
 */
function countOccurrences(text, needle) {
  if (typeof text !== 'string' || typeof needle !== 'string' || needle.length === 0) {
    return 0;
  }
  let count = 0;
  let index = text.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * 全文检索服务端落盘日志（web/logs/*.jsonl）中的密钥出现次数。
 *
 * @param {string} secret 真实密钥
 * @returns {Promise<object>} 扫描结果
 */
async function scanServerLogs(secret) {
  const logDir = path.join(ROOT, 'web', 'logs');
  const result = { files: 0, lines: 0, bytes: 0, hits: 0, fileList: [] };
  let entries = [];
  try {
    entries = await readdir(logDir);
  } catch (error) {
    return { ...result, error: `日志目录不可用：${error?.message ?? error}` };
  }
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) {
      continue;
    }
    try {
      const content = await readFile(path.join(logDir, name), 'utf8');
      result.files += 1;
      result.bytes += Buffer.byteLength(content, 'utf8');
      result.lines += content.split('\n').filter((line) => line.trim().length > 0).length;
      result.hits += countOccurrences(content, secret);
      result.fileList.push(name);
    } catch (error) {
      result.error = result.error ?? `读取 ${name} 失败：${error?.message ?? error}`;
    }
  }
  return result;
}

/**
 * 运行一个 Node 子进程（用于 E2E-12 全量单测与冒烟集）。
 *
 * @param {string[]} args 参数（相对 ROOT）
 * @param {{env?: object, timeoutMs?: number}} [options] 选项
 * @returns {Promise<{code:number, stdout:string, stderr:string, durationMs:number, tail:string}>} 结果
 */
function runChild(args, { env = {}, timeoutMs = 600000 } = {}) {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let killedByTimeout = false;
    const timer = setTimeout(() => {
      killedByTimeout = true;
      try {
        child.kill();
      } catch {
        // 忽略
      }
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => stdout.push(String(chunk)));
    child.stderr?.on('data', (chunk) => stderr.push(String(chunk)));
    child.on('close', (code) => {
      clearTimeout(timer);
      const out = stdout.join('');
      const err = stderr.join('');
      const tail = redactText(`${out}\n${err}`).split('\n').filter((line) => line.trim().length > 0).slice(-40).join('\n');
      resolvePromise({ code: killedByTimeout ? 124 : code ?? 1, stdout: out, stderr: err, durationMs: Date.now() - started, tail, killedByTimeout });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolvePromise({ code: 1, stdout: stdout.join(''), stderr: `${stderr.join('')}\n${error?.message ?? error}`, durationMs: Date.now() - started, tail: String(error?.message ?? error), killedByTimeout: false });
    });
  });
}

/** 读取冒烟结果文件的用例结论（id/status）
 *
 * 注意：三种轮廓的结果文件是**合并产物**（checks 含 caseId，cases 里可能有 status 为空的旧条目），
 * 必须优先用 checks 统计；否则会把空 status 误判为 fail（本次验收踩过）。
 */
async function readSmokeCases(file) {
  try {
    const json = JSON.parse(await readFile(file, 'utf8'));
    if (Array.isArray(json.checks) && json.checks.some((item) => item.caseId)) {
      const byCase = new Map();
      for (const item of json.checks) {
        if (!byCase.has(item.caseId)) {
          byCase.set(item.caseId, { id: item.caseId, ok: true });
        }
        if (!item.ok) {
          byCase.get(item.caseId).ok = false;
        }
      }
      return [...byCase.values()].map((item) => ({ id: item.id, status: item.ok ? 'pass' : 'fail' }));
    }
    if (Array.isArray(json.cases)) {
      return json.cases
        .filter((item) => item && item.id)
        .map((item) => ({
          id: item.id,
          status: item.status ?? (item.ok === true ? 'pass' : item.ok === false ? 'fail' : 'unknown'),
        }));
    }
    return [];
  } catch (error) {
    return { error: `${file}：${error?.message ?? error}` };
  }
}

/** 只读读取对照基线（主检出目录改动前冒烟结果） */
async function readBaseline(candidates) {
  const output = [];
  for (const file of candidates) {
    try {
      const json = JSON.parse(await readFile(file, 'utf8'));
      // 三种轮廓结果文件是扁平 checks（含 caseId），30例结果文件是 cases（含 status）
      if (Array.isArray(json.checks) && json.checks.some((item) => item.caseId)) {
        const byCase = new Map();
        for (const item of json.checks) {
          if (!byCase.has(item.caseId)) {
            byCase.set(item.caseId, { id: item.caseId, ok: true });
          }
          if (!item.ok) {
            byCase.get(item.caseId).ok = false;
          }
        }
        output.push({ file, cases: [...byCase.values()] });
      } else {
        const cases = Array.isArray(json.cases)
          ? json.cases.map((item) => ({ id: item.id, status: item.status }))
          : [];
        output.push({ file, cases });
      }
    } catch (error) {
      output.push({ file, error: `${error?.message ?? error}` });
    }
  }
  return output;
}

// ============================== E2E-12（回归）用例 ==============================

CASES.push({
  id: 'E2E-12',
  title: '默认状态：全量单测 + 真实 LLM 冒烟集回归，与改动前基线对比',
  requirements: '回归',
  expected: '冒烟结果与改动前一致（6/6 通过）；全量单测通过；既有行为不回归',
  retryable: false,
  async run(ctx) {
    const { app } = ctx;
    ctx.step('确认默认状态（无页面配置，来源=文件配置）');
    const ready = await app.reset();
    ctx.check('默认状态下页面就绪', ready);
    await app.openPanel();
    await app.openConfig();
    const state = await app.state();
    ctx.check('默认状态无页面配置（来源=文件配置）', state.sourceData === 'file', `data=${state.sourceData}`);
    await app.closeConfig();
    await ctx.shot('E2E-12-默认状态.png');

    ctx.step('运行全量单测：node tools/run-tests.mjs');
    const tests = await runChild(['tools/run-tests.mjs'], { timeoutMs: 900000 });
    ctx.check('全量单测退出码 0', tests.code === 0, `exit=${tests.code}\n${tests.tail}`);
    const testsPassLine = (tests.tail.match(/通过[^\n]*/g) ?? []).slice(-2).join(' / ');
    ctx.record.extra.unitTests = { code: tests.code, durationMs: tests.durationMs, passLine: testsPassLine, tail: tests.tail };

    ctx.step('运行真实 LLM 冒烟集：node tools/run-e2e-smoke.mjs（含 A1/B1/F1/G2/TS01/S01）');
    const smokeArtifact = path.join(REGRESSION_DIR, 'smoke-latest');
    const smoke = await runChild(
      ['tools/run-e2e-smoke.mjs', '--artifact-dir', path.relative(ROOT, smokeArtifact).split(path.sep).join('/')],
      { timeoutMs: 2400000 },
    );
    ctx.check('冒烟集退出码 0', smoke.code === 0, `exit=${smoke.code}\n${smoke.tail}`);
    ctx.check('冒烟集 6/6 通过', /6\/6\s*通过/.test(smoke.stdout) || /6\/6\s*通过/.test(smoke.stderr), `exit=${smoke.code}\n${smoke.tail}`);

    const currentSmokeFiles = {
      smoke: path.join(smokeArtifact, 'smoke', 'result-smoke.json'),
      scale: path.join(smokeArtifact, 'smoke-scale', 'result-smoke-scale.json'),
      threeSources: path.join(ROOT, 'docs', '测试报告', '2026-11-01-三种轮廓人选与自由轮廓质量验收', '20例', 'result-20.json'),
    };
    const currentSmoke = {
      smoke: await readSmokeCases(currentSmokeFiles.smoke),
      scale: await readSmokeCases(currentSmokeFiles.scale),
      threeSources: (await readSmokeCases(currentSmokeFiles.threeSources)),
    };
    const baseline = await readBaseline([
      'D:/code/DrawInMap/docs/测试报告/2026-11-09-清理验证/final3/smoke/result-smoke-p2.json',
      'D:/code/DrawInMap/docs/测试报告/2026-11-09-清理验证/smoke-latest/smoke/result-smoke.json',
      'D:/code/DrawInMap/docs/测试报告/2026-11-09-清理验证/smoke-latest/smoke-scale/result-smoke-scale.json',
      'D:/code/DrawInMap/docs/测试报告/2026-11-01-三种轮廓人选与自由轮廓质量验收/20例/result-20.json',
    ]);
    ctx.record.extra.smoke = {
      code: smoke.code,
      durationMs: smoke.durationMs,
      tail: smoke.tail,
      current: currentSmoke,
      baseline,
      artifactDir: path.relative(ROOT, smokeArtifact).split(path.sep).join('/'),
    };
    // 逐例对比：当前 6 例是否与基线一致（基线用例通过 → 当前也通过）
    const baselineFlat = [];
    for (const item of baseline) {
      for (const entry of item.cases ?? []) {
        if (entry.id) baselineFlat.push({ id: entry.id, ok: entry.status ? entry.status === 'pass' : Boolean(entry.ok) });
      }
    }
    const merged = [
      ...(Array.isArray(currentSmoke.smoke) ? currentSmoke.smoke : []),
      ...(Array.isArray(currentSmoke.scale) ? currentSmoke.scale : []),
      ...(Array.isArray(currentSmoke.threeSources) ? currentSmoke.threeSources : []),
    ];
    const currentMap = new Map(merged.map((item) => [String(item.id), item.status ?? (item.ok ? 'pass' : 'fail')]));
    const baselineMap = new Map(baselineFlat.map((item) => [String(item.id), item.ok]));
    const compared = [...new Set([...currentMap.keys(), ...baselineMap.keys()])].sort().map((id) => ({
      id,
      baseline: baselineMap.get(id) ?? null,
      current: currentMap.get(id) ?? null,
      same: baselineMap.has(id) ? (baselineMap.get(id) === (currentMap.get(id) === 'pass')) : null,
    }));
    const regressions = compared.filter((item) => item.same === false);
    ctx.check('当前冒烟 6 例与改动前基线逐例一致（无回归）', regressions.length === 0, JSON.stringify(regressions));
    ctx.record.extra.baselineComparison = compared;
    ctx.record.extra.smokeArtifactRelative = path.relative(ROOT, smokeArtifact).split(path.sep).join('/');
    ctx.record.testConnections = null;
  },
});

// ============================== 结果汇总与主流程 ==============================

/**
 * 计算总体汇总。
 *
 * @param {object} result 结果对象
 * @returns {object} 汇总
 */
function summarizeResult(result) {
  const cases = result.cases ?? [];
  const assertionsTotal = cases.reduce((sum, item) => sum + item.checks.length, 0);
  const assertionsPassed = cases.reduce((sum, item) => sum + item.checks.filter((check) => check.ok).length, 0);
  const requestCount = cases.reduce((sum, item) => sum + (item.llm?.requestCount ?? 0), 0);
  const responses = cases.flatMap((item) => item.llm?.responses ?? []);
  const llmDurationMs = responses.reduce((sum, item) => sum + (Number.isFinite(item.durationMs) ? item.durationMs : 0), 0);
  const testSuccesses = cases.reduce((sum, item) => sum + (item.testConnections?.successes?.length ?? 0), 0);
  const testFailures = cases.reduce((sum, item) => sum + (item.testConnections?.failures?.length ?? 0), 0);
  const screenshotCount = cases.reduce((sum, item) => sum + item.screenshots.length, 0);
  const traceIds = cases.flatMap((item) => item.traceIds ?? []).filter(Boolean);
  return {
    total: cases.length,
    passed: cases.filter((item) => item.status === 'pass').length,
    failed: cases.filter((item) => item.status === 'fail').length,
    errored: cases.filter((item) => item.status === 'error').length,
    retried: cases.filter((item) => (item.attempts ?? 1) > 1).length,
    assertions: { total: assertionsTotal, passed: assertionsPassed, failed: assertionsTotal - assertionsPassed },
    realLlm: {
      requestCount,
      responseCount: responses.length,
      totalDurationMs: Math.round(llmDurationMs),
      totalDurationSec: Math.round(llmDurationMs / 100) / 10,
    },
    testConnection: { successEvents: testSuccesses, failedEvents: testFailures },
    screenshots: screenshotCount,
    traceIds,
    wallClockMs: result.startedAt ? Date.now() - Date.parse(result.startedAt) : null,
  };
}

/**
 * 结果落盘（统一脱敏）。
 *
 * @param {object} result 结果对象
 */
async function writeResult(result) {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  const safe = deepRedact(result);
  await writeFile(path.join(ARTIFACT_DIR, RESULT_NAME), `${JSON.stringify(safe, null, 2)}\n`, 'utf8');
}

/** 主流程 */
async function main() {
  // 读取真实文件配置（含密钥，只在内存使用）
  try {
    FILE_CONFIG = await readFileConfig();
  } catch (error) {
    console.error(`[fatal] 读取 web/src/agent/agent-config.js 失败：${error?.message ?? error}`);
    process.exit(1);
  }
  if (!FILE_CONFIG?.apiKey || !FILE_CONFIG?.baseUrl || !FILE_CONFIG?.model) {
    console.error('[fatal] agent-config.js 缺少 baseUrl/apiKey/model，无法做真实 LLM 验收');
    process.exit(1);
  }

  const filter = parseFilter(CASE_FILTER);
  let selected = filter ? CASES.filter((item) => filter.has(item.id)) : [...CASES];
  // 保证 E2E-12 最后执行（避免回归冒烟与验收用例的真实 LLM 请求并发）
  selected = selected.filter((item) => item.id !== 'E2E-12').concat(selected.filter((item) => item.id === 'E2E-12'));
  if (selected.length === 0) {
    console.error(`[fatal] 用例筛选结果为空：${CASE_FILTER}`);
    process.exit(1);
  }
  if (LIST_ONLY) {
    for (const item of selected) {
      console.log(`${item.id}\t${item.title}\t${item.requirements}`);
    }
    return;
  }

  await mkdir(ARTIFACT_DIR, { recursive: true });
  await mkdir(REGRESSION_DIR, { recursive: true });

  const serverReady = await ensureServer();
  if (!serverReady) {
    console.error(`[fatal] 本地服务不可用：${APP_URL}（可先手动启动 node web/server.mjs ${HTTP_PORT}）`);
    process.exit(1);
  }

  const browserPath = resolveBrowser(argOf('browser'));
  const { cdp, browserVersion } = await startBrowser(browserPath);
  const app = new App(cdp);
  const result = {
    title: 'LLM 配置功能真实浏览器 + 真实 LLM E2E 验收（E2E-01 ～ E2E-14，含追加需求「获取模型」）',
    requirement: 'docs/需求/2026-11-09-LLM配置功能需求.md §7',
    design: 'docs/方案设计/2026-11-09-LLM配置功能方案.md',
    startedAt: new Date().toISOString(),
    appUrl: APP_URL,
    browser: browserPath,
    browserVersion,
    node: process.version,
    fileConfig: publicFileConfig(),
    secondConfig: {
      baseUrl: secondConfig().baseUrl,
      model: secondConfig().model,
      timeoutMs: secondConfig().timeoutMs,
      maxTokens: secondConfig().maxTokens,
      note: '需求 §7.3 允许的第二套配置：同一端点不同可用模型名（gemini-3.1-flash-lite 已实测 JSON 模式 + 真实画图链路可用）',
    },
    cases: [],
    evidenceNotes: [
      '每例独立会话：先离开页面再清空同源 localStorage（页面配置/会话/日志），再回页面。',
      '真实请求判定：页面运行记录 llm.request 的 model/baseUrl + llm.response 的 responseModel/durationMs，并核对页面资源计时 /chat/completions。',
      '密钥脱敏：E2E-09 以当轮真实密钥全文检索页面导出 JSONL、web/logs/*.jsonl、DOM 文本；结果文件落盘前统一 deepRedact。',
      '第二套配置为同一端点不同模型名（需求 §7.3 允许口径），报告不夸大为跨端点验证。',
      'E2E-08 临时移除 web/src/agent/agent-config.js（先备份 .tmp/），finally 恢复并校验 SHA256。',
    ],
    screenshotsDir: path.relative(ROOT, ARTIFACT_DIR).split(path.sep).join('/'),
  };
  logLine(`[env] 用例：${selected.map((item) => item.id).join('、')}（${selected.length} 例）`);
  let fatalError = null;
  try {
    await cdp.send('Page.navigate', { url: APP_URL });
    const booted = await app.waitFor(EXPR.ready, 60000, '应用启动');
    logLine(`[env] 应用启动：${booted ? '就绪' : '未就绪'}`);
    for (const caseDef of selected) {
      const record = await runCase(caseDef, app, {
        fileConfig: FILE_CONFIG,
        second: secondConfig(),
        publicFileConfig: publicFileConfig(),
      });
      result.cases.push(record);
      result.summary = summarizeResult({ ...result, finishedAt: new Date().toISOString() });
      await writeResult({ ...result, updatedAt: new Date().toISOString() });
      logLine(`[progress] ${record.id} → ${record.status}（已落盘）`);
    }
  } catch (error) {
    fatalError = redactText(error?.message ?? String(error));
    logLine(`[fatal] ${fatalError}`);
  } finally {
    await stopBrowser(cdp);
    await stopServer();
  }
  result.finishedAt = new Date().toISOString();
  if (fatalError) {
    result.fatalError = fatalError;
  }
  result.summary = summarizeResult(result);
  result.passed = result.cases.length > 0 && result.cases.every((item) => item.status === 'pass');
  await writeResult(result);
  // 控制台汇总
  console.log('\n========== E2E 汇总 ==========');
  for (const record of result.cases) {
    const failedLabels = record.checks.filter((item) => !item.ok).map((item) => item.label);
    console.log(`  ${record.status === 'pass' ? 'PASS' : 'FAIL'}  ${record.id}  ${record.title}${failedLabels.length ? `\n        失败断言：${failedLabels.join('；')}` : ''}`);
  }
  const summary = result.summary;
  console.log(
    `\n用例 ${summary.passed}/${summary.total} 通过；断言 ${summary.assertions.passed}/${summary.assertions.total}；` +
      `真实 LLM 请求 ${summary.realLlm.requestCount} 次（响应 ${summary.realLlm.responseCount} 个，累计 ${summary.realLlm.totalDurationSec}s）；` +
      `测试连接成功 ${summary.testConnection.successEvents} 次 / 失败 ${summary.testConnection.failedEvents} 次；截图 ${summary.screenshots} 张。`,
  );
  console.log(`结果文件：${path.join(ARTIFACT_DIR, RESULT_NAME)}`);
  if (fatalError) {
    console.error(`致命错误：${fatalError}`);
  }
  process.exitCode = result.passed ? 0 : 1;
}

main().catch((error) => {
  console.error('[fatal]', redactText(error?.message ?? String(error)));
  process.exit(1);
});
