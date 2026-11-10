/**
 * 链路追踪（trace/span）：把一轮用户操作（或一次启动/搜索）串成可追溯的链路。
 *
 * 记录模型：
 * - trace.start / trace.end（end 带 durationMs）——一轮操作的起止与总耗时；
 * - span.start（debug）/ span.end（带 durationMs）——各阶段的耗时与产出；
 * - step——给用户看的推理过程里程碑（与对话面板"推理过程"同源）；
 * - 每条记录都带 traceId/spanId，可按 trace 时间线定位问题发生在哪一步。
 *
 * 说明：页面同一时刻只处理一轮对话（发送按钮在等待期间禁用），
 * 因此用"当前活跃 trace + span 栈"即可正确归属；引擎内部的长搜索也在同一异步链内。
 */

import { createId, nowMs } from './core.js';

/**
 * 创建 trace 工厂。
 *
 * @param {object} options
 * @param {(input: object) => void} options.emit 日志发射函数（由 system 注入）
 * @param {() => number} [options.perfNow] 高精度计时函数（测试可注入）
 * @returns {{beginTrace: (name: string, data?: object) => object}}
 */
export function createTraceFactory({ emit, perfNow = nowMs }) {
  /**
   * 开启一轮链路。
   *
   * @param {string} name 链路名（turn/startup/search…）
   * @param {object} [data] 起始上下文（会脱敏）
   * @returns {object} trace 对象（见返回结构）
   */
  function beginTrace(name, data = {}) {
    const traceId = createId('t');
    const startedAt = perfNow();
    /** 打开中的 span 栈（栈顶即当前 span） */
    const spans = [];

    /** 当前 span id（无 span 时为 null） */
    const currentSpanId = () => (spans.length ? spans[spans.length - 1].id : null);

    /** 统一的记录入口：自动带上 traceId 与当前 spanId */
    const write = (level, event, eventData, extra = {}) => {
      emit({
        level,
        module: 'trace',
        event,
        traceId,
        spanId: extra.spanId ?? currentSpanId(),
        data: eventData,
        durationMs: extra.durationMs,
        error: extra.error,
      });
    };

    emit({ level: 'info', module: 'trace', event: 'trace.start', traceId, spanId: null, data: { name, ...data } });

    const trace = {
      id: traceId,
      name,
      startedAt,

      /** 记录一条 info 事件（归属当前 span） */
      info(event, eventData) {
        write('info', event, eventData);
      },

      /** 记录一条 warn 事件 */
      warn(event, eventData) {
        write('warn', event, eventData);
      },

      /** 记录一条 error 事件（可附错误对象） */
      error(event, eventData, error) {
        write('error', event, eventData, { error });
      },

      /** 记录一条 debug 事件 */
      debug(event, eventData) {
        write('debug', event, eventData);
      },

      /**
       * 记录推理过程里程碑（与对话面板展示的步骤同源，用户可见）。
       *
       * @param {string} text 步骤文案
       * @param {object} [stepData] 附加数据
       */
      step(text, stepData) {
        write('info', 'step', { step: text, ...(stepData || {}) });
      },

      /**
       * 开启一个 span（阶段耗时统计）。
       *
       * @param {string} spanName 阶段名
       * @param {object} [spanData] 阶段参数
       * @returns {{id: string, end: (endData?: object) => void, fail: (error?: unknown, failData?: object) => void}}
       */
      startSpan(spanName, spanData) {
        const span = { id: createId('sp'), name: spanName, startedAt: perfNow(), closed: false };
        spans.push(span);
        write('debug', 'span.start', { name: spanName, ...(spanData || {}) }, { spanId: span.id });

        /** 关闭 span 并写入耗时（重复关闭忽略） */
        const finish = (level, endData, error) => {
          if (span.closed) {
            return;
          }
          span.closed = true;
          const index = spans.lastIndexOf(span);
          if (index >= 0) {
            spans.splice(index, 1);
          }
          write(
            level,
            'span.end',
            { name: spanName, ...(endData || {}) },
            { spanId: span.id, durationMs: perfNow() - span.startedAt, error },
          );
        };

        return {
          id: span.id,
          /** 正常结束 */
          end(endData) {
            finish('info', endData);
          },
          /** 异常结束（记录错误堆栈） */
          fail(error, failData) {
            finish('error', failData, error);
          },
        };
      },

      /**
       * 包住一段异步逻辑：自动开/关 span，异常时记录错误并继续抛出。
       *
       * @param {string} spanName 阶段名
       * @param {() => Promise<unknown>} fn 逻辑
       * @param {object} [spanData] 阶段参数
       * @returns {Promise<unknown>} fn 的返回值
       */
      async withSpan(spanName, fn, spanData) {
        const span = trace.startSpan(spanName, spanData);
        try {
          const value = await fn(span);
          span.end();
          return value;
        } catch (error) {
          span.fail(error);
          throw error;
        }
      },

      /** 当前 span id（供外部模块归属日志） */
      currentSpanId,

      /** 正常结束链路：结果摘要 + 总耗时 */
      end(result = {}) {
        write('info', 'trace.end', result, { durationMs: perfNow() - startedAt });
        this.finished = true;
      },

      /** 异常结束链路：错误堆栈 + 总耗时 */
      fail(error, result = {}) {
        write('error', 'trace.end', result, { durationMs: perfNow() - startedAt, error });
        this.finished = true;
      },

      /** 是否已结束 */
      finished: false,
    };

    return trace;
  }

  return { beginTrace };
}
