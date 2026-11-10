/**
 * 错误分类测试（Node 直接运行，mock fetch，不发真实网络请求）。
 *
 * 背景：方案 3.4 要求重试耗尽后的超时使用现有友好句，且控制器不得另造一套
 * 字符串分类。llm.js 因此导出 classifyError 纯函数，并在 chatCompletion 最终
 * 抛出的错误对象上保留 kind / httpStatus。
 *
 * 覆盖：
 * - classifyError 六个分支：timeout / network / http / truncated / parse / unknown；
 * - httpStatus 为 null 时不因消息含「模型接口错误」误判为 http（分类只认状态码）；
 * - chatCompletion 超时（mock fetch 立即抛 AbortError 风格错误）：最终错误
 *   kind==='timeout'、httpStatus===null、message 含「超时」与「180 秒」，
 *   仍为 1 次请求 + 2 次重试（3 次尝试，重试次数未变）；
 * - 响应成功但正文不是 JSON：kind==='parse'、httpStatus 保留 200；
 * - finish_reason 为 length：kind==='truncated'；
 * - 不可重试 HTTP 4xx：立即抛出（1 次请求）、kind==='http'、httpStatus 保留状态码；
 * - 网络错误重试耗尽：kind==='network'、httpStatus===null；
 * - llm.error 日志继续记录 kind: 'timeout'，解析失败的日志 kind 修正为 'parse'。
 *
 * 运行：node test/llm-errors.mjs
 */

import { chatCompletion, classifyError } from '../web/src/agent/llm.js';
import { getEntries, initLogging } from '../web/src/log/index.js';

let failures = 0;

/**
 * 断言工具：记录并通过/失败计数。
 *
 * @param {string} label 断言名
 * @param {boolean} condition 是否通过
 * @param {string} [detail] 失败详情
 */
function check(label, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) {
    failures += 1;
  }
  console.log(`[check] ${label} -> ${ok ? 'PASS' : `FAIL ${detail}`}`);
}

// ---------- classifyError 纯函数分支 ----------

/** AbortError 风格超时错误（chatCompletion 会转成含「超时」的中文消息） */
const abortLikeError = new Error('模型请求超时（180 秒）');
abortLikeError.name = 'AbortError';

check('classifyError：AbortError 风格超时消息 -> timeout', classifyError(abortLikeError, null) === 'timeout');
check(
  'classifyError：网络错误消息 -> network',
  classifyError(new Error('模型接口网络错误：fetch failed'), null) === 'network',
);
check(
  'classifyError：httpStatus 非 null -> http',
  classifyError(new Error('模型接口错误 HTTP 500（可重试）：oops'), 500) === 'http',
);
check(
  'classifyError：截断消息 -> truncated',
  classifyError(new Error('输出被 max_tokens 截断（已加倍至 20000 重试）'), null) === 'truncated',
);
check('classifyError：模型返回消息 -> parse', classifyError(new Error('模型返回不是有效 JSON'), null) === 'parse');
check('classifyError：其它消息 -> unknown', classifyError(new Error('未识别的失败原因'), null) === 'unknown');
check(
  'classifyError：httpStatus 为 null 不因消息含「模型接口错误」误判',
  classifyError(new Error('模型接口错误 HTTP 500：未传状态码'), null) === 'unknown',
);
// 纯函数语义保持：HTTP 状态优先于消息（chatCompletion 只在 HTTP 层失败时传入状态）
check(
  'classifyError：HTTP 状态优先于超时消息',
  classifyError(new Error('模型请求超时（180 秒）'), 504) === 'http',
);

// ---------- chatCompletion 最终错误字段（mock fetch，不联网） ----------

/** 保存真实 fetch，测试结束后恢复 */
const realFetch = globalThis.fetch;

// 日志只留 error 级、禁用 storage/server，避免测试产生真实请求
initLogging({ server: false, storage: false, level: 'error' });

/**
 * 构造成功响应桩（HTTP 200，正文由 json() 返回）。
 *
 * @param {object} payload chat/completions 响应体
 * @returns {object} fetch 响应桩
 */
function makeOkResponse(payload) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => payload,
  };
}

/**
 * 构造 HTTP 错误响应桩。
 *
 * @param {number} status HTTP 状态码
 * @param {string} detail 响应正文
 * @returns {object} fetch 响应桩
 */
function makeHttpErrorResponse(status, detail) {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    text: async () => detail,
  };
}

/**
 * 用 fetch 桩运行一次 chatCompletion，返回最终错误与请求次数。
 *
 * @param {() => (object|never)} responder 每次请求的响应桩；直接抛错即模拟网络/超时
 * @returns {Promise<{error: Error|null, calls: number}>} 最终错误与 fetch 调用次数
 */
async function runChatCompletion(responder) {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return responder();
  };
  try {
    // 同时兼容「正常返回」与「抛错」：本测试只关心 chatCompletion 抛出的最终错误
    const error = await chatCompletion({ messages: [{ role: 'user', content: '测试' }] }).then(
      () => null,
      (reason) => reason,
    );
    return { error, calls };
  } finally {
    globalThis.fetch = realFetch;
  }
}

// --- 超时：fetch 立即抛 AbortError（重试耗尽后仍是超时友好错误） ---
const timeoutRun = await runChatCompletion(() => {
  const error = new Error('This operation was aborted');
  error.name = 'AbortError';
  throw error;
});
check('超时：最终抛出 Error', timeoutRun.error instanceof Error);
check('超时：kind === timeout', timeoutRun.error?.kind === 'timeout', `实际 ${timeoutRun.error?.kind}`);
check('超时：httpStatus === null', timeoutRun.error?.httpStatus === null, `实际 ${timeoutRun.error?.httpStatus}`);
check('超时：message 含「超时」', timeoutRun.error?.message.includes('超时') === true);
check('超时：message 含「180 秒」', timeoutRun.error?.message.includes('180 秒') === true);
check('超时：仍为 3 次尝试（1 次请求 + 2 次重试）', timeoutRun.calls === 3, `实际 ${timeoutRun.calls}`);

// --- 响应成功但正文不是 JSON：parse ---
const parseRun = await runChatCompletion(() =>
  makeOkResponse({
    choices: [{ message: { content: '这不是 JSON' }, finish_reason: 'stop' }],
    usage: {},
  }),
);
check('解析失败：kind === parse', parseRun.error?.kind === 'parse', `实际 ${parseRun.error?.kind}`);
check('解析失败：httpStatus === 200（响应成功）', parseRun.error?.httpStatus === 200, `实际 ${parseRun.error?.httpStatus}`);
check('解析失败：message 含「模型返回」', parseRun.error?.message.includes('模型返回') === true);
check('解析失败：重试 3 次后抛出', parseRun.calls === 3, `实际 ${parseRun.calls}`);

// --- finish_reason 为 length：truncated ---
const truncatedRun = await runChatCompletion(() =>
  makeOkResponse({
    choices: [{ message: { content: '{"action":"chat"' }, finish_reason: 'length' }],
    usage: {},
  }),
);
check('截断：kind === truncated', truncatedRun.error?.kind === 'truncated', `实际 ${truncatedRun.error?.kind}`);
check('截断：httpStatus === 200（响应成功）', truncatedRun.error?.httpStatus === 200);
check('截断：message 含「截断」', truncatedRun.error?.message.includes('截断') === true);
check('截断：重试 3 次后抛出', truncatedRun.calls === 3, `实际 ${truncatedRun.calls}`);

// --- 截断重试：max_tokens 必须真正翻倍（方案 5.6：max_tokens 状态移出重试循环体） ---
{
  const bodies = [];
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls += 1;
    bodies.push(JSON.parse(options.body));
    if (calls === 1) {
      // 第一次：推理链耗尽预算，正文半截被截断
      return makeOkResponse({
        choices: [{ message: { content: '{"action":"chat"' }, finish_reason: 'length' }],
        usage: {},
      });
    }
    // 第二次：预算翻倍后正常返回
    return makeOkResponse({
      choices: [
        { message: { content: JSON.stringify({ action: 'chat', reply: '好的' }) }, finish_reason: 'stop' },
      ],
      usage: {},
    });
  };
  let result = null;
  let error = null;
  try {
    result = await chatCompletion({ messages: [{ role: 'user', content: '画个轮廓' }] });
  } catch (reason) {
    error = reason;
  } finally {
    globalThis.fetch = realFetch;
  }
  check('截断重试：第 2 次成功返回（不再抛错）', result !== null && error === null, `error=${error?.message}`);
  check('截断重试：共 2 次请求', calls === 2, `实际 ${calls}`);
  check(
    '截断重试：第 1 次 max_tokens = 32000（配置初值）',
    bodies[0]?.max_tokens === 32000,
    `实际 ${bodies[0]?.max_tokens}`,
  );
  check(
    '截断重试：第 2 次 max_tokens = 64000（请求体真正翻倍，封顶 64000）',
    bodies[1]?.max_tokens === 64000,
    `实际 ${bodies[1]?.max_tokens}`,
  );
}

// --- 不可重试 HTTP 401：立即抛出，kind === http ---
const httpRun = await runChatCompletion(() => makeHttpErrorResponse(401, 'Unauthorized'));
check('HTTP 401：不可重试，立即抛出（1 次请求）', httpRun.calls === 1, `实际 ${httpRun.calls}`);
check('HTTP 401：kind === http', httpRun.error?.kind === 'http', `实际 ${httpRun.error?.kind}`);
check('HTTP 401：httpStatus === 401', httpRun.error?.httpStatus === 401, `实际 ${httpRun.error?.httpStatus}`);
check('HTTP 401：message 含「HTTP 401」', httpRun.error?.message.includes('HTTP 401') === true);

// --- 网络错误：重试耗尽后 kind === network ---
const networkRun = await runChatCompletion(() => {
  throw new Error('socket hang up');
});
check('网络错误：重试耗尽（3 次请求）', networkRun.calls === 3, `实际 ${networkRun.calls}`);
check('网络错误：kind === network', networkRun.error?.kind === 'network', `实际 ${networkRun.error?.kind}`);
check('网络错误：httpStatus === null', networkRun.error?.httpStatus === null, `实际 ${networkRun.error?.httpStatus}`);
check('网络错误：message 含「网络错误」', networkRun.error?.message.includes('网络错误') === true);

// ---------- 日志口径 ----------

const llmErrorRecords = getEntries({ level: 'error', module: 'agent/llm' });
const countKind = (kind) => llmErrorRecords.filter((record) => record.data?.kind === kind).length;
check('llm.error 日志继续记录 kind: timeout（3 条）', countKind('timeout') === 3, `实际 ${countKind('timeout')}`);
check('llm.error 日志解析失败 kind 修正为 parse（3 条）', countKind('parse') === 3, `实际 ${countKind('parse')}`);
check(
  'llm.error 日志网络错误 / HTTP 错误 kind 正确',
  countKind('network') === 3 && countKind('http') === 1,
  `network=${countKind('network')} http=${countKind('http')}`,
);

// ---------- 收尾 ----------
check('测试结束已恢复 globalThis.fetch', globalThis.fetch === realFetch);

console.log(failures === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${failures} checks)`);
process.exitCode = failures === 0 ? 0 : 1;
