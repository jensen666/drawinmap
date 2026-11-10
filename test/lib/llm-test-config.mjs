/**
 * 测试引导：给不联网的确定性测试准备一份可用的 LLM 配置。
 *
 * 背景：这批测试自己 mock 了 `globalThis.fetch`，**不需要真密钥**；但
 * `web/src/agent/llm.js` 在发请求前会动态 import `web/src/agent/agent-config.js`
 * （含密钥，被 `.gitignore` 排除）。干净克隆里该文件不存在 → 动态 import 抛错 →
 * 测试在"根本还没发出请求"时就挂了（实测干净克隆 51 个可执行用例里红 17 个）。
 *
 * 解决：runner 用 `node --import` 预加载本模块，在任何测试代码之前把配置对象放进
 * `globalThis.__AGENT_LLM_CONFIG__`；`llm.js` 优先使用它。
 *
 * 取值优先级：
 * 1. 真实配置 `web/src/agent/agent-config.js`（本机有密钥时）——**同一个模块实例**，
 *    因此像 `agent-abort.mjs` 那样临时改 `timeoutMs` 的用例改的就是 llm.js 在用的那份；
 * 2. 入库的占位骨架——干净克隆里没有真实配置时用。
 *
 * 浏览器路径**完全不受影响**：浏览器里没有这个全局量，仍然走
 * "缺少 agent-config.js → 友好报错"的老路。
 *
 * 用法（一般由 tools/run-tests.mjs 自动带上）：
 *   node --import ./test/lib/llm-test-config.mjs test/xxx.mjs
 */
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 仓库根目录（本文件在 test/lib/ 下） */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * 占位骨架：
 * - `baseUrl` 指向本机不可路由端口，万一有请求没被 mock 住也会立刻失败（不出网）；
 * - `timeoutMs` / `maxTokens` 与 README 记录的真实默认值一致——部分用例断言的是
 *   "按真实配置算出来的值"（如截断重试第 1 次 max_tokens=32000、翻倍后 64000），
 *   占位值必须对得上，否则断言会假红。
 */
const PLACEHOLDER = {
  baseUrl: 'http://127.0.0.1:9/v1',
  apiKey: 'test-placeholder-key',
  model: 'deepseek-v4.1-flash',
  timeoutMs: 180000,
  maxTokens: 32000,
};

let config = null;
try {
  const module = await import(pathToFileURL(join(ROOT, 'web/src/agent/agent-config.js')).href);
  if (module?.AGENT_LLM) {
    config = module.AGENT_LLM;
  }
} catch {
  // 干净克隆：没有真实配置，用占位骨架
}

globalThis.__AGENT_LLM_CONFIG__ = config ?? { ...PLACEHOLDER };
