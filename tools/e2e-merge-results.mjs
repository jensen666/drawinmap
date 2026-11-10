/**
 * 合并多段真实 LLM E2E 结果（方案 2026-11-08 §8.5）。
 *
 * 用法：
 *   node tools/e2e-merge-results.mjs \
 *     --out "docs/测试报告/<目录>/result.json" \
 *     --in "docs/测试报告/<目录>/A组-历史10例/result.json" \
 *     --in "docs/测试报告/<目录>/B组-全新10例/result.json" \
 *     --in "docs/测试报告/<目录>/B组-补充段/result.json"
 *
 * 规则（方案 §8.5）：
 * - 合并**全部**段落，不得只保留成功段或最好的一次重跑；
 * - 同一 id 出现多次时，全部保留（`segments` 字段列出该 id 的各段结论），
 *   统计按"段"计（`segmentsTotal`），用例级去重统计单列；
 * - 断言统计**重算**：passedChecks/failedChecks/totalChecks 由所有段的断言重新累加；
 * - 交付结果类别分布按段重新汇总（同一输入的多段结果都计入，便于看到波动）。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function argOf(name, fallback = null) {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

/** 收集 --in（可重复） */
function argsOfAll(name) {
  const argv = process.argv.slice(2);
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === `--${name}` && argv[i + 1]) {
      out.push(argv[i + 1]);
      i += 1;
    }
  }
  return out;
}

const OUT = argOf('out');
const INPUTS = argsOfAll('in');
if (!OUT || INPUTS.length === 0) {
  console.error('用法：node tools/e2e-merge-results.mjs --out <合并结果.json> --in <段1.json> [--in <段2.json> ...]');
  process.exit(1);
}

const segments = [];
for (const input of INPUTS) {
  const file = path.resolve(ROOT, input);
  const data = JSON.parse(readFileSync(file, 'utf8'));
  segments.push({ file: input, data });
}

const cases = [];
for (const segment of segments) {
  for (const item of segment.data.cases || []) {
    cases.push({ ...item, __segment: segment.file });
  }
}

/** 同一 id 的多段结论（便于看波动，不做择优） */
const byId = new Map();
for (const item of cases) {
  if (!byId.has(item.id)) {
    byId.set(item.id, []);
  }
  byId.get(item.id).push({
    segment: item.__segment,
    status: item.status,
    passed: item.passed ?? 0,
    failed: item.failed ?? 0,
    deliveryOutcome: item.actual?.deliveryOutcome ?? null,
    durationMs: item.durationMs ?? null,
  });
}

// 断言统计重算（按段累加，不去重）
let totalChecks = 0;
let passedChecks = 0;
let failedChecks = 0;
for (const item of cases) {
  totalChecks += item.checks?.length ?? 0;
  passedChecks += item.checks?.filter((check) => check.ok).length ?? 0;
  failedChecks += item.checks?.filter((check) => !check.ok).length ?? 0;
}

// 交付结果类别分布（按段汇总）
const outcomeCounts = {};
for (const item of cases) {
  const outcome = item.actual?.deliveryOutcome ?? (item.status === 'error' ? 'error-timeout' : 'unknown');
  outcomeCounts[outcome] = (outcomeCounts[outcome] ?? 0) + 1;
}

// 用例级去重统计（同 id 取"最好"的一段的结论仅用于报数，明细仍全量保留）
const caseLevel = [];
for (const [id, runs] of byId.entries()) {
  const passed = runs.filter((run) => run.status === 'pass').length;
  caseLevel.push({
    id,
    runs: runs.length,
    passedRuns: passed,
    allPassed: passed === runs.length,
    latest: runs[runs.length - 1],
  });
}

const merged = {
  title: `${segments[0].data.title ?? '真实 LLM E2E'}（合并 ${segments.length} 段 / ${cases.length} 段用例 / ${byId.size} 个不同输入）`,
  mergedAt: new Date().toISOString(),
  appUrl: segments[0].data.appUrl ?? null,
  browser: segments[0].data.browser ?? null,
  segments: segments.map((segment) => ({
    file: segment.file,
    title: segment.data.title ?? null,
    total: segment.data.total ?? segment.data.cases?.length ?? 0,
    passed: segment.data.passed ?? 0,
    failed: segment.data.failed ?? 0,
  })),
  // 用例级（按 id 去重）与段级（不丢任何一段）两份明细
  caseLevel,
  cases,
  total: cases.length,
  distinctInputs: byId.size,
  passed: caseLevel.filter((item) => item.latest.status === 'pass').length,
  failed: caseLevel.filter((item) => item.latest.status !== 'pass').length,
  segmentsTotal: cases.length,
  segmentsPassed: cases.filter((item) => item.status === 'pass').length,
  segmentsFailed: cases.filter((item) => item.status !== 'pass').length,
  totalChecks,
  passedChecks,
  failedChecks,
  outcomeCounts,
  dimensions: segments[0].data.dimensions ?? null,
};

const outPath = path.resolve(ROOT, OUT);
writeFileSync(outPath, JSON.stringify(merged, null, 2), 'utf8');

console.log(`合并 ${segments.length} 段 → ${path.relative(ROOT, outPath)}`);
console.log(`段级用例：${merged.segmentsPassed}/${merged.segmentsTotal} 通过（断言 ${passedChecks}/${totalChecks}）`);
console.log(`不同输入：${merged.distinctInputs} 个，其中最近一段通过 ${merged.passed}/${merged.distinctInputs}`);
console.log(`交付结果类别：${JSON.stringify(outcomeCounts)}`);
for (const item of caseLevel.filter((entry) => !entry.allPassed)) {
  console.log(
    `  [非全过] ${item.id}：${item.runs} 段中 ${item.passedRuns} 段通过（最新：${item.latest.status}）`,
  );
}
