/**
 * 日志系统装配：内存缓冲 + 控制台 + 本地存储 + 本地服务端落盘 + 链路追踪。
 *
 * 对外只有一个 system 对象：页面运行时由 index.js 持有单例；
 * 测试可直接 createLogSystem({...}) 构造独立实例（禁用存储/服务端或注入 fetch）。
 */

import {
  DEFAULTS,
  LEVELS,
  LEVEL_NAMES,
  LogStore,
  createId,
  createRecord,
  filterRecords,
  serializeRecord,
} from './core.js';
import { createConsoleSink, createServerSink, createStorageSink } from './sinks.js';
import { createTraceFactory } from './trace.js';

/**
 * 创建一套日志系统。
 *
 * @param {object} [options]
 * @param {string} [options.level] 最低级别：debug/info/warn/error/off
 * @param {number} [options.maxRecords] 内存缓冲上限
 * @param {boolean} [options.storage] 是否启用 localStorage（浏览器内默认启用）
 * @param {boolean|object} [options.server] 是否启用服务端落盘；传对象可自定义 endpoint 等参数
 * @param {boolean} [options.console] 是否镜像到控制台
 * @param {string|null} [options.version] 版本标记（随 log.init 记录）
 * @param {object} [options.storageOptions] 传给 storage sink 的参数（测试注入 storage）
 * @param {object} [options.serverOptions] 传给 server sink 的参数（测试注入 fetch）
 * @returns {object} 日志系统 API
 */
export function createLogSystem({
  level = 'info',
  maxRecords = DEFAULTS.maxRecords,
  storage = typeof localStorage !== 'undefined',
  server = typeof window !== 'undefined',
  console: consoleEnabled = true,
  version = null,
  storageOptions = {},
  serverOptions = {},
} = {}) {
  const sessionId = createId('s');
  const startedAt = Date.now();
  const state = {
    level: LEVEL_NAMES.includes(level) || level === 'off' ? level : 'info',
    sessionId,
    startedAt,
    version,
  };
  const store = new LogStore({ maxRecords, startedAt });
  const sinks = [];
  /** 当前活跃链路（页面同一时刻只处理一轮对话；长搜索也在同一异步链内） */
  let activeTrace = null;

  const { beginTrace: createTrace } = createTraceFactory({
    emit: (input) => writeRecord(createRecord({ ...input, sessionId: state.sessionId })),
  });

  /** 是否放行某级别的记录（off 全部关闭；过滤在写入前完成，避免无谓开销） */
  function accepted(levelName) {
    if (state.level === 'off') {
      return false;
    }
    return (LEVELS[levelName] ?? 0) >= (LEVELS[state.level] ?? LEVELS.info);
  }

  /** 写入一条记录：内存缓冲 + 各 sink（每个 sink 独立容错） */
  function writeRecord(record) {
    store.push(record);
    for (const sink of sinks) {
      try {
        sink.write(record);
      } catch {
        // sink 异常不影响业务
      }
    }
    return record;
  }

  // ---------- 输出端装配 ----------
  if (consoleEnabled && typeof console !== 'undefined') {
    sinks.push(createConsoleSink());
  }
  let storageSink = null;
  if (storage) {
    storageSink = createStorageSink(storageOptions);
    if (storageSink.status().enabled) {
      // 恢复上次会话日志：只进内存缓冲，不重新写盘/上报，避免重复
      store.restore(storageSink.restore());
      sinks.push(storageSink);
    } else {
      storageSink = null;
    }
  }
  let serverSink = null;
  if (server) {
    serverSink = createServerSink(typeof server === 'object' ? server : serverOptions);
    sinks.push(serverSink);
  }

  // ---------- 公共 API ----------
  const system = {
    sessionId,
    get level() {
      return state.level;
    },

    /** 设置最低级别（debug/info/warn/error/off） */
    setLevel(nextLevel) {
      if (LEVEL_NAMES.includes(nextLevel) || nextLevel === 'off') {
        state.level = nextLevel;
        return true;
      }
      return false;
    },

    /**
     * 写入一条日志（模块 logger 与 trace 共用）。
     *
     * @returns {object|null} 记录（被级别过滤时为 null）
     */
    log(module, levelName, event, data, error) {
      if (!accepted(levelName)) {
        return null;
      }
      return writeRecord(
        createRecord({
          level: levelName,
          module,
          event,
          data,
          error,
          sessionId,
          traceId: activeTrace ? activeTrace.id : null,
          spanId: activeTrace ? activeTrace.currentSpanId() : null,
        }),
      );
    },

    /**
     * 创建模块 logger。
     *
     * @param {string} module 模块名（如 agent/llm、engine）
     * @returns {{debug: Function, info: Function, warn: Function, error: Function, step: Function, event: Function}}
     */
    createLogger(module) {
      const log = (levelName, event, data, error) => system.log(module, levelName, event, data, error);
      return {
        debug: (event, data) => log('debug', event, data),
        info: (event, data) => log('info', event, data),
        warn: (event, data) => log('warn', event, data),
        error: (event, data, error) => log('error', event, data, error),
        /** 用户可见的推理过程步骤（与对话面板同步） */
        step: (text, data) => log('info', 'step', { step: text, ...(data || {}) }),
        event: (levelName, event, data) => log(levelName, event, data),
      };
    },

    /**
     * 开启一轮链路；结束（end/fail）后自动清空"当前链路"并立即冲刷输出端。
     *
     * 为什么结束时冲刷：一轮对话的结尾恰是最关键的结论（plan.selected/agent.reply/
     * trace.end）；若只靠定时冲刷，用户随手关页面/切标签可能丢掉尾部日志
     * （实测：E2E 关闭浏览器后规划轮结论未落盘）。这里结束时主动冲刷一次。
     *
     * @param {string} name 链路名
     * @param {object} [data] 起始上下文
     * @returns {object} trace
     */
    beginTrace(name, data) {
      const trace = createTrace(name, data);
      activeTrace = trace;
      const originalEnd = trace.end;
      const originalFail = trace.fail;
      trace.end = (result) => {
        originalEnd.call(trace, result);
        if (activeTrace === trace) {
          activeTrace = null;
        }
        void system.flush().catch(() => {});
      };
      trace.fail = (error, result) => {
        originalFail.call(trace, error, result);
        if (activeTrace === trace) {
          activeTrace = null;
        }
        void system.flush().catch(() => {});
      };
      return trace;
    },

    /** 当前活跃 trace id（无则为 null） */
    getCurrentTraceId() {
      return activeTrace ? activeTrace.id : null;
    },

    /**
     * 查询记录（时间升序）。
     *
     * @param {object} [filter] 见 core.filterRecords
     * @returns {Array<object>} 记录副本
     */
    entries(filter) {
      return filterRecords(store.records, filter).slice();
    },

    /** 记录总数（含已滚出内存缓冲的累计计数见 stats） */
    get size() {
      return store.size;
    },

    /**
     * 订阅新记录。
     *
     * @param {(record: object) => void} listener 回调
     * @returns {() => void} 取消订阅
     */
    subscribe(listener) {
      return store.subscribe(listener);
    },

    /** 清空内存与本地存储中的日志（服务端已落盘文件不清） */
    clear() {
      store.clear();
      if (storageSink) {
        storageSink.clear();
      }
    },

    /**
     * 导出为 JSONL 文本。
     *
     * @param {object} [filter] 过滤条件（默认全部记录）
     * @returns {string} 每行一条 JSON
     */
    exportJsonl(filter = {}) {
      const records = filterRecords(store.records, { ...filter, limit: 0 });
      return records.map(serializeRecord).join('\n');
    },

    /** 运行统计（UI 状态栏用） */
    stats() {
      return {
        sessionId,
        level: state.level,
        startedAt,
        version,
        total: store.total,
        stored: store.size,
        byLevel: { ...store.byLevel },
        server: serverSink ? serverSink.status() : { enabled: false, status: 'disabled' },
        storage: storageSink
          ? storageSink.status()
          : { enabled: false, entries: 0, bytes: 0, lastSavedAt: null },
      };
    },

    /** 服务端落盘状态 */
    serverStatus() {
      return serverSink ? serverSink.status() : { enabled: false, status: 'disabled' };
    },

    /** 启动输出端（服务端探测异步进行，不阻塞页面） */
    async start() {
      if (!accepted('info')) {
        return;
      }
      writeRecord(
        createRecord({
          level: 'info',
          module: 'log',
          event: 'log.init',
          data: {
            sessionId,
            level: state.level,
            version,
            storageEnabled: Boolean(storageSink),
            serverEnabled: Boolean(serverSink),
            userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'node',
            href: typeof location !== 'undefined' ? location.href : null,
          },
          sessionId,
        }),
      );
      if (serverSink) {
        await serverSink.start();
        system.log(
          'log',
          serverSink.status().status === 'available' ? 'info' : 'warn',
          serverSink.status().status === 'available' ? 'log.server.ready' : 'log.server.unavailable',
          serverSink.status(),
        );
      }
    },

    /** 冲刷所有输出端（页面隐藏/测试结束时调用） */
    async flush() {
      for (const sink of sinks) {
        try {
          if (sink.id === 'server') {
            await sink.flush();
          } else if (typeof sink.flush === 'function') {
            sink.flush();
          }
        } catch {
          // 忽略冲刷异常
        }
      }
    },

    /** 释放定时器与监听（测试/页面卸载） */
    dispose() {
      for (const sink of sinks) {
        try {
          if (typeof sink.dispose === 'function') {
            sink.dispose();
          }
        } catch {
          // 忽略释放异常
        }
      }
      activeTrace = null;
    },
  };

  return system;
}
