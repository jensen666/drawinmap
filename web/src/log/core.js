/**
 * 日志内核：级别模型、事件记录、脱敏/截断、环形缓冲与查询过滤。
 *
 * 设计约束：
 * - 不直接依赖浏览器 API（Node 测试可直接导入，localStorage 等由 sinks 模块负责）；
 * - 任何日志内容都先脱敏再落盘：密钥/令牌一律打码，图片 data URL 只保留元信息，
 *   超长字符串与超大对象截断，防止把密钥或 base64 图片写进日志文件；
 * - 容量有界：内存环形缓冲、本地存储双重上限，日志不拖垮页面。
 */

/** 日志记录格式版本（后续字段变更时递增，便于导出文件兼容） */
const LOG_VERSION = 1;

/** 级别数值：过滤时按最小值比较 */
export const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });

/** 级别名称（顺序由低到高，UI 下拉与统计复用） */
export const LEVEL_NAMES = Object.freeze(['debug', 'info', 'warn', 'error']);

/** 默认容量与截断参数 */
export const DEFAULTS = Object.freeze({
  /** 内存环形缓冲最多保留的事件数 */
  maxRecords: 5000,
  /** 单条字符串最大长度（字符） */
  maxString: 20000,
  /** 数组最多保留的项数 */
  maxArray: 200,
  /** 对象最多保留的字段数 */
  maxKeys: 100,
  /** 嵌套最大深度 */
  maxDepth: 8,
  /** 错误堆栈最大长度 */
  maxStack: 8000,
  /** localStorage 持久化的最大记录数与最大字节（近似按 UTF-16 长度算） */
  storageRecords: 600,
  storageBytes: 700 * 1024,
});

/** 敏感字段名（一律打码，避免密钥写入日志） */
const SENSITIVE_KEY = /^(api[-_]?key|authorization|cookie|set-cookie|token|access[-_]?token|refresh[-_]?token|secret|password|passwd|bearer)$/i;

/** 图片 data URL（LLM 视觉输入）识别 */
const IMAGE_DATA_URL = /^data:([\w/+.-]+);base64,/;

let idSeq = 0;

/**
 * 生成短 id（时间基 + 自增 + 随机，够用且可读）。
 *
 * @param {string} prefix 前缀，如 s（会话）/ t（trace）/ sp（span）
 * @returns {string} 形如 t-m8xk2a-3f9
 */
export function createId(prefix) {
  idSeq += 1;
  const time = Date.now().toString(36).slice(-6);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix}-${time}${idSeq.toString(36)}${rand}`;
}

/** 本地时间文本（东八区等任意时区按浏览器/系统本地时区），精确到毫秒 */
function formatLocalTime(tsMs = Date.now()) {
  const date = new Date(tsMs);
  const pad = (value, size = 2) => String(value).padStart(size, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
  );
}

/** 高精度耗时口径（浏览器/Node 均有 performance.now） */
export function nowMs() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/**
 * 提取可序列化的错误信息。
 *
 * @param {unknown} error 任意错误
 * @param {number} [maxStack] 堆栈截断长度
 * @returns {{name: string, message: string, stack?: string, cause?: object}|null}
 */
export function extractError(error, maxStack = DEFAULTS.maxStack) {
  if (error === null || error === undefined) {
    return null;
  }
  if (!(error instanceof Error)) {
    return { name: 'NonError', message: truncateString(String(error), 2000) };
  }
  const info = {
    name: error.name || 'Error',
    message: truncateString(error.message || '', 2000),
  };
  if (error.stack) {
    info.stack = truncateString(error.stack, maxStack);
  }
  if (error.cause && error.cause !== error) {
    const cause = extractError(error.cause, maxStack);
    if (cause) {
      info.cause = cause;
    }
  }
  return info;
}

/** 字符串截断（附带原长，便于判断是否有信息被省略） */
function truncateString(value, maxLength) {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}…[截断，原长 ${value.length} 字符]`;
}

/**
 * 值脱敏与规整：保证结果可 JSON 序列化、无循环引用、无密钥、体量有界。
 *
 * @param {unknown} value 原始值
 * @param {object} [options] 截断参数（见 DEFAULTS）
 * @returns {unknown} 可安全序列化的值
 */
export function sanitize(value, options = {}) {
  const config = { ...DEFAULTS, ...options };
  const seen = new WeakSet();

  const walk = (input, depth) => {
    if (input === null || input === undefined) {
      return null;
    }
    const type = typeof input;
    if (type === 'string') {
      const image = IMAGE_DATA_URL.exec(input);
      if (image) {
        // 图片只留元信息：mime + 字符数（真正排查靠浏览器里重新上传，不入日志明文）
        return `[图片 dataURL 已省略 · ${image[1]} · ${input.length} 字符]`;
      }
      return truncateString(input, config.maxString);
    }
    if (type === 'number') {
      return Number.isFinite(input) ? input : String(input);
    }
    if (type === 'boolean') {
      return input;
    }
    if (type === 'bigint') {
      return `${input}n`;
    }
    if (type === 'function') {
      return '[Function]';
    }
    if (type === 'symbol') {
      return String(input);
    }
    if (input instanceof Error) {
      return extractError(input, config.maxStack);
    }
    if (type !== 'object') {
      return String(input);
    }
    if (depth >= config.maxDepth) {
      return '[MaxDepth]';
    }
    if (seen.has(input)) {
      return '[Circular]';
    }
    seen.add(input);

    if (Array.isArray(input)) {
      const items = input.slice(0, config.maxArray).map((item) => walk(item, depth + 1));
      if (input.length > config.maxArray) {
        items.push(`[+${input.length - config.maxArray} 项]`);
      }
      return items;
    }
    if (input instanceof Date) {
      return input.toISOString();
    }
    if (input instanceof Map) {
      return walk(Object.fromEntries([...input.entries()].slice(0, config.maxKeys)), depth + 1);
    }
    if (input instanceof Set) {
      return walk([...input].slice(0, config.maxArray), depth + 1);
    }

    const output = {};
    let count = 0;
    for (const [key, item] of Object.entries(input)) {
      if (count >= config.maxKeys) {
        output['…'] = `[+${Object.keys(input).length - config.maxKeys} 字段]`;
        break;
      }
      count += 1;
      if (SENSITIVE_KEY.test(key)) {
        output[key] = '***';
        continue;
      }
      output[key] = walk(item, depth + 1);
    }
    return output;
  };

  return walk(value, 0);
}

/**
 * 生成一条日志记录。
 *
 * @param {object} input
 * @param {string} input.level 级别（debug/info/warn/error）
 * @param {string} input.module 模块名，如 agent/llm、engine
 * @param {string} input.event 事件名，如 llm.request
 * @param {unknown} [input.data] 结构化上下文（会脱敏）
 * @param {unknown} [input.error] 错误对象（会提取 name/message/stack）
 * @param {string} input.sessionId 会话 id
 * @param {string|null} [input.traceId] 链路 id
 * @param {string|null} [input.spanId] 阶段 id
 * @param {number} [input.durationMs] 耗时（毫秒）
 * @returns {object} 日志记录
 */
export function createRecord({ level, module, event, data, error, sessionId, traceId = null, spanId = null, durationMs }) {
  const ts = Date.now();
  const record = {
    v: LOG_VERSION,
    ts,
    time: formatLocalTime(ts),
    level,
    module,
    event,
    sessionId,
    traceId,
    spanId,
  };
  if (Number.isFinite(durationMs)) {
    record.durationMs = Math.round(durationMs * 10) / 10;
  }
  if (data !== undefined) {
    record.data = sanitize(data);
  }
  if (error !== undefined && error !== null) {
    record.error = extractError(error);
  }
  return record;
}

/**
 * 单条记录序列化为一行 JSONL（导出与服务端落盘共用）。
 *
 * @param {object} record 日志记录
 * @returns {string} JSON 行
 */
export function serializeRecord(record) {
  return JSON.stringify(record, (_key, value) => (typeof value === 'bigint' ? `${value}n` : value));
}

/**
 * 记录过滤（UI 与服务端导出共用同一套语义）。
 *
 * @param {Array<object>} records 记录列表（时间升序）
 * @param {object} [filter]
 * @param {string} [filter.level] 最低级别（debug/info/warn/error），默认 info
 * @param {string|null} [filter.module] 精确模块名
 * @param {string|null} [filter.traceId] 精确 traceId
 * @param {string} [filter.keyword] 关键词（匹配整条记录 JSON，忽略大小写）
 * @param {number} [filter.limit] 最多返回条数（取最新的 N 条），默认 500
 * @returns {Array<object>} 过滤后的记录
 */
export function filterRecords(records, filter = {}) {
  const { level = 'info', module = null, traceId = null, keyword = '', limit = 500 } = filter;
  const minLevel = LEVELS[level] ?? LEVELS.info;
  const needle = typeof keyword === 'string' ? keyword.trim().toLowerCase() : '';
  const matched = [];
  for (const record of records) {
    if ((LEVELS[record.level] ?? 0) < minLevel) {
      continue;
    }
    if (module && record.module !== module) {
      continue;
    }
    if (traceId && record.traceId !== traceId) {
      continue;
    }
    if (needle && !JSON.stringify(record).toLowerCase().includes(needle)) {
      continue;
    }
    matched.push(record);
  }
  return limit > 0 ? matched.slice(-limit) : matched;
}

/**
 * 日志环形缓冲：有界内存、订阅通知、基础统计。
 * 恢复历史记录（restore）不触发订阅与输出，避免重复写盘/重复上报。
 */
export class LogStore {
  /**
   * @param {{maxRecords?: number, startedAt?: number}} [options]
   */
  constructor({ maxRecords = DEFAULTS.maxRecords, startedAt = Date.now() } = {}) {
    this.records = [];
    this.listeners = new Set();
    this.maxRecords = Math.max(50, maxRecords);
    this.startedAt = startedAt;
    this.total = 0;
    this.byLevel = { debug: 0, info: 0, warn: 0, error: 0 };
  }

  /**
   * 追加一条新记录（触发订阅、清理超限旧记录）。
   *
   * @param {object} record 日志记录
   * @returns {object} 同一记录
   */
  push(record) {
    this.records.push(record);
    this.total += 1;
    this.byLevel[record.level] = (this.byLevel[record.level] || 0) + 1;
    if (this.records.length > this.maxRecords) {
      this.records.splice(0, this.records.length - this.maxRecords);
    }
    for (const listener of this.listeners) {
      try {
        listener(record);
      } catch {
        // 订阅者异常不能影响日志写入
      }
    }
    return record;
  }

  /**
   * 恢复历史记录到缓冲头部（刷新页面后仍可查看上一次会话日志）。
   *
   * @param {Array<object>} records 历史记录（时间升序）
   */
  restore(records) {
    if (!Array.isArray(records) || records.length === 0) {
      return;
    }
    const merged = [...records, ...this.records].slice(-this.maxRecords);
    this.records = merged;
  }

  /** 清空当前缓冲（不重置累计统计，便于 UI 显示"清空后仍有新日志"） */
  clear() {
    this.records = [];
  }

  /**
   * 订阅新记录。
   *
   * @param {(record: object) => void} listener 回调
   * @returns {() => void} 取消订阅函数
   */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 记录数量 */
  get size() {
    return this.records.length;
  }
}
