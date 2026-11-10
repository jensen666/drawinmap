/**
 * 从页面运行日志里补齐 E2E 结果 JSON 的验收证据（方案 2026-11-08 §8.5）。
 *
 * 背景：结果 JSON 里每例都带 traceId，真实链路事件（目标验收结论、自由轮廓验收证据、
 * 每次 LLM 响应的 finishReason/正文长度/推理 token）都落在 web/logs/*.jsonl 里，
 * 按 traceId 可以精确取回。本工具把这段证据**补进**结果 JSON，让产物自洽，
 * 不需要重跑真实 LLM（也不伪造任何数据——只搬运日志里已有的事件）。
 *
 * 用法：
 *   node tools/e2e-attach-evidence.mjs \
 *     --result "docs/测试报告/<目录>/result-merged.json" \
 *     --logs "web/logs"
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function argOf(name, fallback = null) {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

const RESULT = argOf('result');
const LOGS_DIR = path.resolve(ROOT, argOf('logs', 'web/logs'));
if (!RESULT) {
  console.error('用法：node tools/e2e-attach-evidence.mjs --result <结果.json> [--logs web/logs]');
  process.exit(1);
}

/** 读取全部日志行，按 traceId 归档（只保留需要的字段，避免内存爆掉） */
const byTrace = new Map();
if (existsSync(LOGS_DIR)) {
  for (const name of readdirSync(LOGS_DIR)) {
    if (!name.endsWith('.jsonl')) {
      continue;
    }
    for (const line of readFileSync(path.join(LOGS_DIR, name), 'utf8').split('\n')) {
      if (!line.trim()) {
        continue;
      }
      let item;
      try {
        item = JSON.parse(line);
      } catch {
        continue;
      }
      const traceId = item?.traceId;
      if (!traceId) {
        continue;
      }
      if (!byTrace.has(traceId)) {
        byTrace.set(traceId, []);
      }
      const event = item.event;
      if (
        event === 'target.accepted' ||
        event === 'target.rejected' ||
        event === 'agent.threeSources.freeform' ||
        event === 'llm.response'
      ) {
        byTrace.get(traceId).push(item);
      }
    }
  }
}

const resultPath = path.resolve(ROOT, RESULT);
const result = JSON.parse(readFileSync(resultPath, 'utf8'));

let attached = 0;
let missing = 0;
for (const item of result.cases || []) {
  const traceId = item.actual?.traceId;
  const events = traceId ? byTrace.get(traceId) || [] : [];
  if (events.length === 0) {
    missing += 1;
    continue;
  }
  const target = [...events].reverse().find((e) => e.event === 'target.accepted' || e.event === 'target.rejected');
  const freeform = [...events].reverse().find((e) => e.event === 'agent.threeSources.freeform');
  const responses = events
    .filter((e) => e.event === 'llm.response')
    .map((e) => ({
      finishReason: e.data?.finishReason ?? null,
      contentLength: e.data?.contentLength ?? null,
      reasoningTokens: e.data?.reasoningTokens ?? null,
      completionTokens: e.data?.usage?.completion_tokens ?? null,
      durationMs: e.data?.durationMs ?? null,
    }));
  item.actual = {
    ...item.actual,
    acceptanceEvidence: {
      targetVerdict: target?.data?.verdict ?? null,
      targetReasons: target?.data?.reasons ?? null,
      targetChecks: target?.data?.checks ?? freeform?.data?.checks ?? null,
      constraintResults: target?.data?.constraintResults ?? freeform?.data?.constraintResults ?? null,
      freeformChecks: freeform?.data?.checks ?? null,
      freeformTerminatedWith: freeform?.data?.terminatedWith ?? null,
      freeformFailureKind: freeform?.data?.failureKind ?? null,
      llmResponses: responses,
    },
  };
  attached += 1;
}

writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf8');
console.log(`已补齐验收证据：${attached} 例（无日志 ${missing} 例）→ ${path.relative(ROOT, resultPath)}`);
