/**
 * agent 编排共享无状态工具（C4 拆分：跨模块复用，不含闭包状态）。
 */

import { createAbortError, isAbortError, isAborted } from '../../cancel.js';
import { classifyError } from '../llm.js';

/**
 * 用户中止/超时中断的统一上抛（缺陷修复配套 A6：原 8 处 `if (isAbortError…) throw` 复制）。
 *
 * 中止错误必须原样上抛，不能被下游 catch 当成普通失败降级成一次正常回复
 * （否则用户点了"停止"却收到一条追问/失败说明）。统一走 cancel.js 的
 * createAbortError 规范化错误形状，调用方 catch 里一行 `rethrowIfAborted(error, signal)` 即可。
 *
 * @param {*} error 捕获到的错误
 * @param {AbortSignal|null|undefined} signal 本轮请求的取消信号
 * @throws {Error} 中止错误（由 createAbortError 规范化，message 为「已停止」）
 */
export function rethrowIfAborted(error, signal) {
  if (isAbortError(error) || isAborted(signal)) {
    throw createAbortError('已停止');
  }
}

/** 整轮规划总时间预算（毫秒）：与引擎单图形搜索预算一致（C4 从 controller 移入）。 */
export const ROUND_TIME_BUDGET_MS = 180000;

/** 解析型失败（超时/正文无法解析/输出截断）统一使用同一句友好提示，不把原始错误甩给用户 */
/** 解析型失败（超时/正文无法解析/输出截断）统一使用同一句友好提示，不把原始错误甩给用户 */
const PARSE_FAILURE_KINDS = new Set(['timeout', 'parse', 'truncated']);
export const UNPARSABLE_REPLY = '这个我没能理解或生成出来。可以换个说法试试。';


/**
 * 读取错误分类：优先用 llm.js 在最终错误上保留的 kind，
 * 缺失时复用同一套纯函数分类（不允许控制器另造一套字符串判断）。
 *
 * @param {Error} error 错误
 * @returns {'timeout'|'network'|'http'|'truncated'|'parse'|'unknown'} 分类
 */
export function errorKindOf(error) {
  if (error && typeof error === 'object' && typeof error.kind === 'string') {
    return error.kind;
  }
  return classifyError(error, error?.httpStatus ?? null);
}

/**
 * 是否属于"解析型失败"：超时、模型返回无法解析、输出截断 → 用友好提示，不暴露原始错误。
 *
 * @param {Error} error 错误
 * @returns {boolean} 是否走友好提示
 */
export function isParseFailure(error) {
  return PARSE_FAILURE_KINDS.has(errorKindOf(error));
}

/**
 * 包装错误并保留分类，外层（UI/日志）无需再猜类别。
 *
 * @param {Error} error 错误
 * @param {string} kind 分类
 * @returns {Error} 同一错误对象
 */
export function withErrorKind(error, kind) {
  if (error && typeof error === 'object') {
    error.kind = kind;
  }
  return error;
}
