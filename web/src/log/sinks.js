/**
 * 日志输出端（sink）：控制台、浏览器本地存储、本地开发服务端落盘。
 *
 * 约定：
 * - 每个 sink 独立容错，任何一个失败都不能影响页面运行与其它 sink；
 * - 服务端 sink 先探测接口（GET /__log/ping），不可用时自动降级为仅浏览器记录；
 * - 本地存储与内存缓冲都有容量上限，写失败时主动裁剪，绝不抛到业务代码。
 */

import { DEFAULTS } from './core.js';

/** 控制台里单条记录最多展示的上下文字符数（完整内容在日志面板/文件里） */
const CONSOLE_DETAIL_MAX = 1500;

/**
 * 控制台 sink：把结构化记录镜像成一行可读日志，保持现有开发习惯。
 *
 * @param {{maxDetail?: number}} [options]
 * @returns {{id: string, write: (record: object) => void}}
 */
export function createConsoleSink({ maxDetail = CONSOLE_DETAIL_MAX } = {}) {
  return {
    id: 'console',
    write(record) {
      const traceTag = record.traceId ? `[${record.traceId}]` : '[-]';
      const durationTag = Number.isFinite(record.durationMs) ? ` (${Math.round(record.durationMs)}ms)` : '';
      const head = `${traceTag} [${record.module}] ${record.event}${durationTag}`;
      const details = [];
      if (record.data !== undefined && !(record.data && record.data.name === record.event)) {
        let text = '';
        try {
          text = JSON.stringify(record.data);
        } catch {
          text = String(record.data);
        }
        details.push(text.length > maxDetail ? `${text.slice(0, maxDetail)}…` : text);
      }
      if (record.error) {
        details.push(`${record.error.name}: ${record.error.message}`);
      }
      const method =
        record.level === 'error'
          ? console.error
          : record.level === 'warn'
            ? console.warn
            : record.level === 'debug'
              ? console.debug
              : console.info;
      if (details.length > 0) {
        method.call(console, `[log] ${head}`, ...details);
      } else {
        method.call(console, `[log] ${head}`);
      }
    },
  };
}

/**
 * 本地存储 sink：刷新页面后仍能看到最近一段时间的日志（上次会话的历史记录）。
 * 恢复的记录只进入内存缓冲，不重新上报服务端（避免重复落盘）。
 *
 * @param {object} [options]
 * @param {string} [options.key] localStorage 键名
 * @param {number} [options.maxRecords] 最多保留记录数
 * @param {number} [options.maxBytes] 最大序列化字节（近似按字符数）
 * @param {number} [options.debounceMs] 攒批写入间隔
 * @param {object} [options.storage] 注入 storage（测试用，默认 localStorage）
 * @returns {{
 *   id: string,
 *   restore: () => Array<object>,
 *   write: (record: object) => void,
 *   flush: () => void,
 *   status: () => {enabled: boolean, entries: number, bytes: number, lastSavedAt: number|null},
 *   dispose: () => void
 * }}
 */
export function createStorageSink({
  key = 'drawinmap.logs.v1',
  maxRecords = DEFAULTS.storageRecords,
  maxBytes = DEFAULTS.storageBytes,
  debounceMs = 800,
  storage = null,
} = {}) {
  const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  /** 本地缓存副本（与内存缓冲解耦，避免每次全量序列化 5000 条） */
  let buffer = [];
  let timer = null;
  let lastSavedAt = null;
  let bytes = 0;
  const status = { enabled: Boolean(store), entries: 0, bytes: 0, lastSavedAt: null, error: null };

  /** 尝试解析本地存储里的历史记录（失败则忽略） */
  function restore() {
    if (!store) {
      return [];
    }
    try {
      const raw = store.getItem(key);
      if (!raw) {
        return [];
      }
      const payload = JSON.parse(raw);
      const records = Array.isArray(payload) ? payload : payload?.records;
      if (!Array.isArray(records)) {
        return [];
      }
      buffer = records.slice(-maxRecords);
      bytes = raw.length;
      status.entries = buffer.length;
      status.bytes = bytes;
      lastSavedAt = Number(payload?.savedAt) || null;
      status.lastSavedAt = lastSavedAt;
      return buffer.slice();
    } catch (error) {
      status.error = error instanceof Error ? error.message : String(error);
      return [];
    }
  }

  /** 真正写入 localStorage（超限时从最旧记录开始裁剪） */
  function save() {
    if (!store) {
      return;
    }
    try {
      let payload = JSON.stringify({ v: 1, savedAt: Date.now(), records: buffer });
      while (payload.length > maxBytes && buffer.length > 20) {
        buffer = buffer.slice(Math.ceil(buffer.length * 0.2));
        payload = JSON.stringify({ v: 1, savedAt: Date.now(), records: buffer });
      }
      store.setItem(key, payload);
      bytes = payload.length;
      lastSavedAt = Date.now();
      status.entries = buffer.length;
      status.bytes = bytes;
      status.lastSavedAt = lastSavedAt;
      status.error = null;
    } catch (error) {
      // 配额满/隐私模式：丢最旧的一半后重试一次；仍失败则只保留内存日志
      status.error = error instanceof Error ? error.message : String(error);
      buffer = buffer.slice(Math.ceil(buffer.length / 2));
      try {
        store.setItem(key, JSON.stringify({ v: 1, savedAt: Date.now(), records: buffer }));
        status.entries = buffer.length;
      } catch {
        status.enabled = false;
      }
    }
  }

  /** 延迟攒批写入（日志密集时不每个事件都序列化整份历史） */
  function scheduleSave() {
    if (!store || timer !== null) {
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      save();
    }, debounceMs);
  }

  return {
    id: 'storage',
    restore,
    write(record) {
      if (!store) {
        return;
      }
      buffer.push(record);
      if (buffer.length > maxRecords) {
        buffer.splice(0, buffer.length - maxRecords);
      }
      scheduleSave();
    },
    flush() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      save();
    },
    /** 清空本地存储里的历史记录（页面"清空日志"按钮） */
    clear() {
      buffer = [];
      if (!store) {
        return;
      }
      try {
        store.removeItem(key);
        bytes = 0;
        status.entries = 0;
        status.bytes = 0;
        status.lastSavedAt = null;
      } catch (error) {
        status.error = error instanceof Error ? error.message : String(error);
      }
    },
    status() {
      return { ...status };
    },
    dispose() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

/**
 * 本地开发服务端 sink：把日志按天追加到 web/logs/*.jsonl，刷新/重开浏览器后可追溯。
 * 接口不存在（用其它静态服务器打开）时自动降级，不影响页面。
 *
 * @param {object} [options]
 * @param {string} [options.endpoint] 接收日志的接口
 * @param {string} [options.pingEndpoint] 探测接口
 * @param {number} [options.batchSize] 单批条数
 * @param {number} [options.flushIntervalMs] 定时冲刷间隔
 * @param {number} [options.probeTimeoutMs] 探测超时
 * @param {number} [options.maxQueue] 队列上限（超出丢最旧）
 * @param {number} [options.maxConsecutiveFailures] 连续失败多少次后停用
 * @param {typeof fetch|null} [options.fetchImpl] 注入 fetch（测试用）
 * @returns {{
 *   id: string,
 *   start: () => Promise<void>,
 *   write: (record: object) => void,
 *   flush: () => Promise<void>,
 *   flushBeacon: () => void,
 *   status: () => object,
 *   dispose: () => void
 * }}
 */
export function createServerSink({
  endpoint = '/__log',
  pingEndpoint = '/__log/ping',
  batchSize = 40,
  flushIntervalMs = 2000,
  probeTimeoutMs = 1500,
  maxQueue = 800,
  maxConsecutiveFailures = 3,
  fetchImpl = null,
} = {}) {
  const fetchFn = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  /**
   * 是否启用：浏览器内自动启用；非浏览器环境（Node 测试）只有显式注入 fetchImpl 才启用，
   * 避免静态导入时在无 window 的环境里误发请求。
   */
  const enabled = Boolean(fetchFn) && (typeof window !== 'undefined' || Boolean(fetchImpl));
  /** 队列与状态 */
  const queue = [];
  const state = {
    enabled,
    status: 'idle', // idle | probing | available | unavailable | error
    sent: 0,
    failed: 0,
    dropped: 0,
    endpoint,
    error: null,
  };
  let timer = null;
  /** 进行中的冲刷任务（并发 flush 调用会等待它，避免尾批滞留） */
  let activeFlush = null;
  let consecutiveFailures = 0;
  let disposed = false;
  let pagehideHandler = null;

  /** 入队（探测中/可用时缓冲，不可用时直接丢弃） */
  function enqueue(record) {
    if (!state.enabled || disposed) {
      return;
    }
    if (state.status === 'unavailable') {
      return;
    }
    queue.push(record);
    if (queue.length > maxQueue) {
      const overflow = queue.length - maxQueue;
      queue.splice(0, overflow);
      state.dropped += overflow;
    }
    if ((state.status === 'available' || state.status === 'error') && queue.length >= batchSize) {
      void flush();
    }
  }

  /** 探测接口是否可用（一次，失败即降级） */
  async function probe() {
    if (!state.enabled) {
      return;
    }
    state.status = 'probing';
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), probeTimeoutMs) : null;
    try {
      const response = await fetchFn(pingEndpoint, {
        method: 'GET',
        cache: 'no-store',
        signal: controller ? controller.signal : undefined,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      state.status = 'available';
      state.error = null;
      if (queue.length > 0) {
        void flush();
      }
    } catch (error) {
      state.enabled = false;
      state.status = 'unavailable';
      state.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (timeout !== null) {
        clearTimeout(timeout);
      }
    }
  }

  /**
   * 发送当前队列的一批。
   * error 状态（上一批失败但未达停用阈值）允许重试——否则一次瞬时失败后
   * flush 停在 error、定时冲刷再也不发，整轮日志滞留丢失（2026-10-31 E2E 实测）。
   * 连续失败仍按 maxConsecutiveFailures 升级为 unavailable 停用。
   */
  async function sendBatch() {
    if (queue.length === 0 || !fetchFn || disposed) {
      return false;
    }
    if (state.status !== 'available' && state.status !== 'error') {
      return false;
    }
    const batch = queue.splice(0, batchSize);
    try {
      const body = JSON.stringify({ v: 1, sessionId: batch[0]?.sessionId ?? null, records: batch });
      const response = await fetchFn(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        // 不用 keepalive：部分环境（内嵌浏览器）对 keepalive 请求一律
        // "Failed to fetch"，且全局 64KB 配额会让大批次（含完整 LLM 请求体
        // 的日志）静默失败；页面卸载兜底由 pagehide 的 sendBeacon 承担。
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      state.sent += batch.length;
      consecutiveFailures = 0;
      state.status = 'available';
      state.error = null;
      return true;
    } catch (error) {
      // 失败批次塞回队首（maxQueue 溢出时自然淘汰最旧），瞬时失败不丢日志；
      // 连续失败仍会升级为 unavailable 停用，不会无限重试拖垮页面。
      // 投递语义为 at-least-once：若服务端已处理本批但响应丢失/出错，客户端会
      // 重发同一批 → 日志文件可能出现重复行（按行统计时需注意）。换取的是
      // 瞬时故障下诊断日志不丢；head 版本是 at-most-once（失败即丢批）。
      queue.unshift(...batch);
      if (queue.length > maxQueue) {
        const overflow = queue.length - maxQueue;
        queue.splice(0, overflow);
        state.dropped += overflow;
      }
      state.failed += batch.length;
      consecutiveFailures += 1;
      state.status = consecutiveFailures >= maxConsecutiveFailures ? 'unavailable' : 'error';
      state.error = error instanceof Error ? error.message : String(error);
      if (state.status === 'unavailable') {
        state.enabled = false;
      }
      return false;
    }
  }

  /**
   * 冲刷队列（可并发调用：后到者等待上一轮结束后继续把剩余队列发完，
   * 避免"探测触发的首批冲刷还在飞，手动 flush 直接返回导致尾部日志滞留"）。
   */
  async function flush() {
    if (!state.enabled || disposed) {
      return;
    }
    if (activeFlush) {
      await activeFlush;
    }
    if (queue.length === 0 || (state.status !== 'available' && state.status !== 'error')) {
      return;
    }
    activeFlush = (async () => {
      while (queue.length > 0 && (state.status === 'available' || state.status === 'error') && !disposed) {
        const sentOk = await sendBatch();
        if (!sentOk) {
          break;
        }
      }
    })();
    try {
      await activeFlush;
    } finally {
      activeFlush = null;
    }
  }

  /** 页面隐藏/卸载时用 sendBeacon 把残余队列带出去 */
  function flushBeacon() {
    if (!state.enabled || typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') {
      return;
    }
    if (queue.length === 0 || state.status !== 'available') {
      return;
    }
    const batch = queue.splice(0, Math.min(queue.length, 200));
    try {
      const body = JSON.stringify({ v: 1, sessionId: batch[0]?.sessionId ?? null, records: batch });
      navigator.sendBeacon(endpoint, new Blob([body], { type: 'application/json' }));
      state.sent += batch.length;
    } catch {
      state.failed += batch.length;
    }
  }

  return {
    id: 'server',
    async start() {
      if (!state.enabled) {
        return;
      }
      if (timer === null) {
        timer = setInterval(() => {
          void flush();
        }, flushIntervalMs);
        timer.unref?.();
      }
      if (typeof window !== 'undefined' && !pagehideHandler) {
        pagehideHandler = () => flushBeacon();
        window.addEventListener('pagehide', pagehideHandler);
      }
      await probe();
    },
    write: enqueue,
    flush,
    flushBeacon,
    status() {
      return {
        ...state,
        pending: queue.length,
        batchSize,
        flushIntervalMs,
      };
    },
    dispose() {
      disposed = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      if (pagehideHandler && typeof window !== 'undefined') {
        window.removeEventListener('pagehide', pagehideHandler);
        pagehideHandler = null;
      }
      queue.length = 0;
    },
  };
}
