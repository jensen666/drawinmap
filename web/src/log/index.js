/**
 * 日志系统公共入口（页面运行时单例）。
 *
 * 业务模块统一从这里取 logger / 开链路，写入内存缓冲、控制台、localStorage
 * 与本地开发服务端（web/logs/*.jsonl）。初始化前调用也安全（退化为控制台 + 内存）。
 *
 * 控制台调试入口：window.DrawInMapLog
 *   entries(filter)  查询记录
 *   stats()          会话/输出端状态
 *   exportJsonl()    取 JSONL 文本
 *   download()       下载 JSONL 文件
 *   clear()          清空（内存 + localStorage）
 *   trace()          当前 traceId
 *   level('debug')   运行期切换级别（off 关闭）
 */

import { serializeRecord, LEVEL_NAMES } from './core.js';
import { createLogSystem } from './system.js';

/** 当前日志系统（initLogging 前为最小可用实例） */
let system = null;
/** 是否已安装全局错误捕获 */
let globalHandlersInstalled = false;

/**
 * 获取日志系统；未初始化时创建"仅控制台 + 内存"的最小实例。
 *
 * @returns {object} 日志系统
 */
function getSystem() {
  if (!system) {
    system = createLogSystem({ storage: false, server: false, level: 'info' });
  }
  return system;
}

/** 从 URL 读取日志级别开关：?log=debug / ?log=off（便于现场复现时提高日志密度） */
function resolveLevelFromUrl() {
  if (typeof location === 'undefined') {
    return null;
  }
  try {
    const value = new URLSearchParams(location.search).get('log');
    if (!value) {
      return null;
    }
    const normalized = value.toLowerCase();
    if (normalized === 'off') {
      return 'off';
    }
    return LEVEL_NAMES.includes(normalized) ? normalized : null;
  } catch {
    return null;
  }
}

/** 安装未捕获异常/未处理 Promise 拒绝的日志捕获（只装一次） */
function installGlobalHandlers(targetSystem) {
  if (globalHandlersInstalled || typeof window === 'undefined') {
    return;
  }
  globalHandlersInstalled = true;
  window.addEventListener('error', (event) => {
    const error = event.error instanceof Error ? event.error : new Error(event.message || '脚本错误');
    targetSystem.log('app', 'error', 'window.error', {
      message: event.message || '',
      filename: event.filename || '',
      lineno: event.lineno ?? null,
      colno: event.colno ?? null,
    }, error);
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const error = reason instanceof Error ? reason : new Error(String(reason));
    targetSystem.log('app', 'error', 'window.unhandledrejection', {
      reason: reason instanceof Error ? reason.message : String(reason),
    }, error);
  });
}

/**
 * 初始化日志系统（页面启动时调用一次，可重复调用）。
 *
 * @param {object} [options]
 * @param {boolean} [options.server] 是否启用服务端落盘（默认启用，不可用时自动降级）
 * @param {boolean} [options.storage] 是否启用 localStorage（默认启用）
 * @param {string} [options.level] 最低级别；缺省读 URL ?log=（默认 info）
 * @param {string|null} [options.version] 版本标记（排查"旧代码"问题）
 * @param {number} [options.maxRecords] 内存缓冲上限
 * @returns {object} 日志系统
 */
export function initLogging({
  server = true,
  storage = true,
  level = null,
  version = null,
  maxRecords,
} = {}) {
  if (system && system.initialized) {
    return system;
  }
  const resolvedLevel = level || resolveLevelFromUrl() || 'info';
  system = createLogSystem({ server, storage, level: resolvedLevel, version, maxRecords });
  system.initialized = true;
  installGlobalHandlers(system);
  // 启动记录同步写入（探测服务端在后台异步进行，不阻塞页面）
  void system.start();
  if (typeof window !== 'undefined') {
    window.DrawInMapLog = createConsoleApi(system);
    // 页面关闭前把残余日志冲出去（sendBeacon 在服务端 sink 内部处理）
    window.addEventListener('pagehide', () => {
      void system.flush();
    });
    // 切后台/最小化时也冲刷一次：移动端切 App 常常不触发 pagehide，日志可能滞留内存
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        void system.flush();
      }
    });
  }
  return system;
}

/**
 * 创建模块 logger（自动归属当前 trace/span）。
 *
 * 注意：这里必须"惰性"取当前系统——业务模块在 import 阶段就会创建 logger，
 * 而 initLogging() 在其后执行（会替换系统实例）；若在此处捕获实例，
 * 初始化前的模块日志会写进被丢弃的临时系统（实测缺陷：LLM/引擎日志全丢）。
 *
 * @param {string} module 模块名，如 agent/llm、engine、ui
 * @returns {{debug: Function, info: Function, warn: Function, error: Function, step: Function, event: Function}}
 */
export function createLogger(module) {
  /** 每次写入时解析当前系统 */
  const log = (levelName, event, data, error) => getSystem().log(module, levelName, event, data, error);
  return {
    debug: (event, data) => log('debug', event, data),
    info: (event, data) => log('info', event, data),
    warn: (event, data) => log('warn', event, data),
    error: (event, data, error) => log('error', event, data, error),
    /** 用户可见的推理过程步骤（与对话面板同步） */
    step: (text, data) => log('info', 'step', { step: text, ...(data || {}) }),
    event: (levelName, event, data) => log(levelName, event, data),
  };
}

/**
 * 开启一轮可追溯链路（结束时自动清理当前链路）。
 *
 * @param {string} name 链路名（turn/startup…）
 * @param {object} [data] 起始上下文
 * @returns {object} trace（startSpan/withSpan/step/end/fail）
 */
export function beginTrace(name, data) {
  return getSystem().beginTrace(name, data);
}

/**
 * 查询日志记录（时间升序）。
 *
 * @param {object} [filter] {level, module, traceId, keyword, limit}
 * @returns {Array<object>} 记录
 */
export function getEntries(filter) {
  return getSystem().entries(filter);
}

/**
 * 订阅新日志记录。
 *
 * @param {(record: object) => void} listener 回调
 * @returns {() => void} 取消订阅
 */
export function subscribe(listener) {
  return getSystem().subscribe(listener);
}

/** 运行统计（含输出端状态） */
export function getStats() {
  return getSystem().stats();
}

/**
 * 运行期切换日志级别。
 *
 * @param {string} level debug/info/warn/error/off
 * @returns {boolean} 是否设置成功
 */
export function setLevel(level) {
  return getSystem().setLevel(level);
}

/**
 * 导出 JSONL 文本。
 *
 * @param {object} [filter] 过滤条件（默认全部记录）
 * @returns {string} JSONL
 */
export function exportJsonl(filter) {
  return getSystem().exportJsonl(filter);
}

/** 清空内存与 localStorage 中的日志（服务端已落盘文件保留） */
export function clearLogs() {
  getSystem().clear();
}

/** 生成导出文件名（本地时间，精确到秒） */
function exportFileName() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const stamp =
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `drawinmap-log-${stamp}.jsonl`;
}

/**
 * 浏览器内下载 JSONL 日志文件。
 *
 * @param {object} [filter] 导出过滤条件
 * @returns {string} 生成的文件名（无 document 环境返回空串）
 */
export function downloadJsonl(filter = {}) {
  const jsonl = exportJsonl(filter);
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof Blob === 'undefined') {
    return '';
  }
  const filename = exportFileName();
  const blob = new Blob([jsonl], { type: 'application/x-ndjson;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // 稍后释放，避免个别浏览器下载未开始就被回收
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return filename;
}

/**
 * 控制台调试 API（window.DrawInMapLog）。
 *
 * @param {object} targetSystem 日志系统
 * @returns {object} 控制台可用的方法集合
 */
function createConsoleApi(targetSystem) {
  return {
    entries: (filter = {}) => targetSystem.entries(filter),
    all: () => targetSystem.entries({ level: 'debug', limit: 0 }),
    stats: () => targetSystem.stats(),
    server: () => targetSystem.serverStatus(),
    trace: () => targetSystem.getCurrentTraceId(),
    exportJsonl: (filter = {}) => targetSystem.exportJsonl(filter),
    download: (filter = {}) => downloadJsonl(filter),
    clear: () => targetSystem.clear(),
    level: (next) => (next ? targetSystem.setLevel(next) : targetSystem.level),
  };
}

export { LEVEL_NAMES, serializeRecord };
