/**
 * E2E-S 冒烟集一键执行（清理方案 2026-11-09 §5.6.4.1）。
 *
 * E2E-S = **6 例**：`A1`（内置图形+显式尺寸）、`B1`（本地参考图命中）、`F1`（推荐链路）、
 * `G2`（进行中停止）、`TS01`（三路取齐/候选卡）、`S01`（多比例尺卡片）。
 *
 * 方案 §5.6.4.1 要求"每批改动后必跑"，但它写成 3 条命令、结果散在 3 个文件里，
 * 很容易只跑其中一条就当作"跑过了"。本脚本把 3 条命令串起来，统一判定 **6/6**。
 *
 * 前置（缺一不可）：
 * 1. `node web/server.mjs 5173`（改过 server.mjs 必须重启）；
 * 2. 真实 LLM 密钥：`web/src/agent/agent-config.js`（含密钥，不入库）；
 * 3. Edge / Chrome（自动探测，探测不到用 `--browser <路径>`）。
 *
 * 用法：
 *   node tools/run-e2e-smoke.mjs
 *   node tools/run-e2e-smoke.mjs --artifact-dir docs/测试报告/2026-11-09-清理验证/smoke-latest
 *   node tools/run-e2e-smoke.mjs --check-only   # 只复核已有结果文件，不重跑
 *
 * 退出码：6/6 通过 → 0；有失败 → 1。
 */

import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** 冒烟产物目录（默认；docs/测试报告 不入库） */
function argOf(name, fallback) {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

/** 只复核已有结果文件（不重跑） */
const CHECK_ONLY = process.argv.includes('--check-only');

const ARTIFACT_ROOT = resolve(ROOT, argOf('artifact-dir', 'docs/测试报告/2026-11-09-清理验证/smoke-latest'));
const BROWSER = argOf('browser', '');

/**
 * 3 条命令 = 6 例。
 *
 * `summarize` 把各自的结果文件归一成 { id, ok, detail } 列表，便于统一判定。
 */
const STEPS = [
  {
    label: '主链路 A1/B1/F1/G2',
    cases: ['A1', 'B1', 'F1', 'G2'],
    args: [
      'tools/e2e-real-llm-30.mjs',
      '--cases', 'A1,B1,F1,G2',
      '--out', 'result-smoke.json',
      '--artifact-dir', join(ARTIFACT_ROOT, 'smoke'),
      '--turn-timeout', '300000',
    ],
    resultFile: () => join(ARTIFACT_ROOT, 'smoke', 'result-smoke.json'),
    summarize: (json) => (json.cases ?? []).map((item) => ({
      id: item.id,
      ok: item.status === 'pass',
      detail: item.status === 'pass' ? '' : `status=${item.status}${item.error ? `（${item.error}）` : ''}`,
    })),
  },
  {
    label: '三路取齐 TS01',
    cases: ['TS01'],
    args: ['tools/e2e-three-sources-suite.mjs', '--only', 'TS01'],
    resultFile: () => join(ROOT, 'docs', '测试报告', '2026-11-01-三种轮廓人选与自由轮廓质量验收', '20例', 'result-20.json'),
    summarize: (json) => {
      // three-sources 的结果只有扁平断言列表，按 caseId 归组判定
      const byCase = new Map();
      for (const item of json.checks ?? []) {
        if (!byCase.has(item.caseId)) byCase.set(item.caseId, []);
        byCase.get(item.caseId).push(item);
      }
      return [...byCase.entries()].map(([id, list]) => ({
        id,
        ok: list.length > 0 && list.every((item) => item.ok),
        detail: list.length > 0 && list.every((item) => item.ok) ? '' : `断言 ${list.filter((item) => !item.ok).length}/${list.length} 失败`,
      }));
    },
  },
  {
    label: '多比例尺 S01',
    cases: ['S01'],
    args: [
      'tools/e2e-real-llm-30.mjs',
      '--cases-file', 'test/e2e-real-llm-scale-cases.mjs',
      '--cases', 'S01',
      '--out', 'result-smoke-scale.json',
      '--artifact-dir', join(ARTIFACT_ROOT, 'smoke-scale'),
    ],
    resultFile: () => join(ARTIFACT_ROOT, 'smoke-scale', 'result-smoke-scale.json'),
    summarize: (json) => (json.cases ?? []).map((item) => ({
      id: item.id,
      ok: item.status === 'pass',
      detail: item.status === 'pass' ? '' : `status=${item.status}${item.error ? `（${item.error}）` : ''}`,
    })),
  },
];

/**
 * 跑一条命令（继承 stdio，实时输出）。
 *
 * @param {string[]} args 参数
 * @returns {Promise<number>} 退出码
 */
function runCommand(args) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
    child.on('close', (code) => resolvePromise(code ?? 1));
  });
}

/** 主流程 */
async function main() {
  await mkdir(ARTIFACT_ROOT, { recursive: true });
  const results = [];

  for (const step of STEPS) {
    const args = BROWSER ? [...step.args, '--browser', BROWSER] : step.args;
    let code = 0;
    if (CHECK_ONLY) {
      console.log(`\n========== E2E-S · ${step.label}（--check-only：不重跑） ==========`);
    } else {
      console.log(`\n========== E2E-S · ${step.label} ==========`);
      code = await runCommand(args);
    }

    let cases = [];
    try {
      const json = JSON.parse(await readFile(step.resultFile(), 'utf8'));
      cases = step.summarize(json);
    } catch (error) {
      console.error(`[warn] 读不到结果文件 ${step.resultFile()}：${error?.message ?? error}`);
    }
    // 只认本步该跑的用例：结果文件可能是**合并过的**（如 three-sources 的 result-20.json
    // 会保留历史轮次的其它用例），不按 id 过滤会把上一轮的用例也算进来。
    const byId = new Map(cases.map((item) => [item.id, item]));
    const expected = step.cases.map((id) => byId.get(id) ?? { id, ok: false, detail: '结果文件里没有该用例' });
    cases = expected;
    // 结果文件缺失或该步命令直接失败 → 该步所有用例判失败
    if (cases.length === 0) {
      cases = step.cases.map((id) => ({ id, ok: false, detail: `命令退出码 ${code}，且没有结果文件` }));
    } else if (code !== 0) {
      cases = cases.map((item) => (item.ok ? { ...item, ok: false, detail: `命令退出码 ${code}` } : item));
    }
    results.push(...cases);
    const passed = cases.filter((item) => item.ok).length;
    console.log(`[e2e-s] ${step.label}：${passed}/${cases.length} 通过`);
  }

  const passed = results.filter((item) => item.ok).length;
  console.log('\n========== E2E-S 汇总 ==========');
  for (const item of results) {
    console.log(`  ${item.ok ? 'PASS' : 'FAIL'}  ${item.id}${item.detail ? `  —— ${item.detail}` : ''}`);
  }
  console.log(`\nE2E-S：${passed}/${results.length} 通过（冒烟通过判定：${results.length === 6 && passed === 6 ? '通过 ✅' : '未通过 ❌'}）`);
  process.exitCode = passed === results.length && results.length === 6 ? 0 : 1;
}

await main();
