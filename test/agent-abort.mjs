/**
 * "停止"（中止）链路测试：LLM 请求阶段/响应体阶段的真中断，以及超时不被误判为停止。
 *
 * 背景（需求 R5）：停止必须是真中断——模型请求立刻中断、停止后不再自动重试，
 * 且停止不是失败（不落成"超时"或"网络错误"）。本文件用 mock fetch 覆盖：
 * 1. 预中止信号：不发起任何请求，直接抛统一中止错误；
 * 2. 请求阶段中止：fetch 被中断，只尝试 1 次（不进入重试）；
 * 3. 响应头已到、正文读取阶段中止：仍按"已停止"中断且不重试（不得报成超时）；
 * 4. 内部超时：归一为可重试的超时错误（kind=timeout），不得误报"已停止"。
 *
 * 运行：node test/agent-abort.mjs（不联网、不发真实请求）
 */

import { chatCompletion } from '../web/src/agent/llm.js';
import { isAbortError } from '../web/src/cancel.js';
import { initLogging } from '../web/src/log/index.js';

/**
 * 配置对象：本用例要临时改 `timeoutMs`（第 4 段：内部超时 30ms），必须拿到
 * **llm.js 实际在用的那一份**。
 *
 * 取法按优先级：
 * 1. `globalThis.__AGENT_LLM_CONFIG__`——runner 用 `--import` 预加载
 *    `test/lib/llm-test-config.mjs` 注入（干净克隆里没有真实配置，注入的是占位骨架）；
 * 2. 真实配置文件（动态 import）：直接跑本文件时用；用静态 import 会让**干净克隆
 *    一启动就 ERR_MODULE_NOT_FOUND**（该文件含密钥、被 .gitignore 排除）。
 */
const config = globalThis.__AGENT_LLM_CONFIG__
  ?? (await import('../web/src/agent/agent-config.js').catch(() => null))?.AGENT_LLM
  ?? { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'test-placeholder-key', model: 'test-mock-model', timeoutMs: 180000, maxTokens: 32000 };
// llm.js 优先读这个全局量，保证"改的就是它用的那份"
globalThis.__AGENT_LLM_CONFIG__ = config;

let failures = 0;

/**
 * 断言工具。
 *
 * @param {string} label 断言描述
 * @param {boolean} condition 断言条件
 * @param {string} [detail] 失败详情
 */
function check(label, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) {
    failures += 1;
  }
  console.log(`[check] ${label} -> ${ok ? 'PASS' : `FAIL ${detail}`}`);
}

/** 保存真实 fetch，测试结束后恢复 */
const realFetch = globalThis.fetch;
// 日志只留 error 级、禁用 storage/server，避免测试产生真实请求或落盘
initLogging({ server: false, storage: false, level: 'error' });

const messages = [{ role: 'user', content: '画个心形' }];

/**
 * 构造成功的 chat/completions 响应。
 *
 * @param {object} content 响应 JSON 正文
 * @returns {object} fetch Response 形状
 */
function jsonResponse(content) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({
      id: 'mock',
      model: 'mock',
      choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }],
      usage: {},
    }),
  };
}

/* ---------------- 1. 预中止：不发起请求 ---------------- */
{
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return jsonResponse({ action: 'chat', reply: '不应该被调用' });
  };
  const controller = new AbortController();
  controller.abort();
  let error = null;
  try {
    await chatCompletion({ messages, signal: controller.signal });
  } catch (caught) {
    error = caught;
  }
  check('预中止：抛统一中止错误', isAbortError(error), String(error));
  check('预中止：不发起任何模型请求', calls === 0, String(calls));
}

/* ---------------- 2. 请求阶段中止：中断且不重试 ---------------- */
{
  let calls = 0;
  const controller = new AbortController();
  globalThis.fetch = (url, init) => {
    calls += 1;
    return new Promise((resolve, reject) => {
      init.signal.addEventListener(
        'abort',
        () => {
          const error = new Error('The operation was aborted');
          error.name = 'AbortError';
          reject(error);
        },
        { once: true },
      );
      setTimeout(() => controller.abort(), 10);
    });
  };
  let error = null;
  try {
    await chatCompletion({ messages, signal: controller.signal });
  } catch (caught) {
    error = caught;
  }
  check('请求阶段停止：识别为中止错误', isAbortError(error), String(error));
  check('请求阶段停止：只发 1 次请求（不自动重试）', calls === 1, String(calls));
}

/* ---------------- 3. 响应体读取阶段中止：不误判超时、不重试 ---------------- */
{
  let calls = 0;
  const controller = new AbortController();
  globalThis.fetch = async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => {
        // 响应头已到，正文读取期间用户点"停止"
        setTimeout(() => controller.abort(), 5);
        await new Promise((resolve) => setTimeout(resolve, 20));
        const error = new Error('body aborted');
        error.name = 'AbortError';
        throw error;
      },
    };
  };
  let error = null;
  try {
    await chatCompletion({ messages, signal: controller.signal });
  } catch (caught) {
    error = caught;
  }
  check('响应体阶段停止：识别为中止错误', isAbortError(error), String(error));
  check('响应体阶段停止：不被当成超时（kind 不是 timeout）', error?.kind !== 'timeout', `kind=${error?.kind}`);
  check('响应体阶段停止：不自动重试（只发 1 次）', calls === 1, String(calls));
}

/* ---------------- 4. 内部超时：不得误报"已停止" ---------------- */
{
  const previousTimeout = config.timeoutMs;
  config.timeoutMs = 30;
  let calls = 0;
  globalThis.fetch = (url, init) => {
    calls += 1;
    // 永远不返回，等内部超时计时器 abort
    return new Promise((resolve, reject) => {
      init.signal.addEventListener(
        'abort',
        () => {
          const error = new Error('The operation was aborted');
          error.name = 'AbortError';
          reject(error);
        },
        { once: true },
      );
    });
  };
  let error = null;
  try {
    await chatCompletion({ messages, retries: 0 });
  } catch (caught) {
    error = caught;
  } finally {
    config.timeoutMs = previousTimeout;
  }
  check('内部超时：不被误判为"已停止"', !isAbortError(error), String(error));
  check('内部超时：保留超时语义（kind=timeout + 友好文案）', error?.kind === 'timeout' && /超时/.test(error?.message ?? ''), String(error?.message));
  check('内部超时：确实发起过请求', calls === 1, String(calls));
}

globalThis.fetch = realFetch;
console.log(failures === 0 ? '\n[agent-abort] 全部通过' : `\n[agent-abort] ${failures} 项失败`);
if (failures > 0) {
  process.exit(1);
}
