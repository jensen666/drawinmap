/**
 * 取消（"停止"）能力的统一工具。
 *
 * 需求 R5：停止必须是**真正中断**——模型请求与路网搜索都要停下来，而不是只隐藏
 * 等待状态。因此中断信号（AbortSignal）需要贯穿三层：
 *
 * 1. LLM 请求层（agent/llm.js）：把外部信号与超时信号联动，fetch 立刻中断；
 * 2. 引擎搜索层（engine/candidates.js、engine/joint-refine.js）：候选循环逐个检查
 *    信号，停止后立刻跳出搜索（不再空烧 CPU）；
 * 3. 编排层（agent/controller.js）：交付前检查信号，被停止的轮次不绘制、不交付，
 *    迟到结果不回填界面。
 *
 * 本模块不依赖浏览器 API，Node 测试可直接导入。
 */

/** 中止错误的分类标记（与 llm.js 的 classifyError 分类并列） */
const ABORT_KIND = 'aborted';

/**
 * 信号是否已中止。
 *
 * @param {AbortSignal|null|undefined} signal 中止信号
 * @returns {boolean} 是否已中止
 */
export function isAborted(signal) {
  return Boolean(signal && signal.aborted);
}

/**
 * 构造统一的中止错误（name=AbortError，带 kind 标记）。
 *
 * @param {string} [message] 错误文案
 * @returns {Error} 中止错误
 */
export function createAbortError(message = '已停止') {
  const error = new Error(message);
  error.name = 'AbortError';
  error.kind = ABORT_KIND;
  error.aborted = true;
  return error;
}

/**
 * 信号已中止时抛出统一中止错误。
 *
 * @param {AbortSignal|null|undefined} signal 中止信号
 * @param {string} [message] 错误文案
 */
export function throwIfAborted(signal, message = '已停止') {
  if (isAborted(signal)) {
    throw createAbortError(message);
  }
}

/**
 * 是否属于中止类错误（控制器/界面据此把该轮标记为"已停止"，而不是失败）。
 *
 * @param {unknown} error 错误对象
 * @returns {boolean} 是否中止错误
 */
export function isAbortError(error) {
  if (!error || typeof error !== 'object') {
    return false;
  }
  return error.name === 'AbortError' || error.kind === ABORT_KIND || error.aborted === true;
}

/**
 * 把外部信号与内部控制器联动：外部中止时内部一并中止。
 *
 * fetch 的 signal 只能有一个，因此超时用内部控制器、外部"停止"用外部信号，
 * 这里把两者合并到一个内部控制器上。
 *
 * @param {AbortSignal|null|undefined} external 外部信号（用户点"停止"）
 * @param {AbortController} internal 内部控制器（超时用）
 * @returns {() => void} 解绑函数（调用后不再联动）
 */
export function linkSignals(external, internal) {
  if (!external || typeof external.addEventListener !== 'function') {
    return () => {};
  }
  if (external.aborted) {
    internal.abort();
    return () => {};
  }
  const onAbort = () => internal.abort();
  external.addEventListener('abort', onAbort, { once: true });
  return () => external.removeEventListener('abort', onAbort);
}
