/**
 * 统一测试入口（清理方案 2026-11-09 阶段 0）。
 *
 * 目标：把"跑一次全量测试"变成一条命令，并解决三个长期痛点：
 * 1. 无统一 runner → 逐个 `node test/xxx.mjs` 手工执行，容易漏；
 * 2. 无超时 → 慢测（engine-smoke 117s / corpus-replay 146s）可能挂死；
 * 3. 前置数据缺失直接 ENOENT 崩 → 干净克隆无法跑测试。
 *
 * 前置数据依赖按**本地 import 传递闭包**判定（测试 → 间接依赖的 fixture/模块），
 * 避免"测试文件里没写路径字符串、但它 import 的模块读了数据文件"这类漏判。
 *
 * 用法：
 *   node tools/run-tests.mjs                 # 全量确定性测试
 *   node tools/run-tests.mjs --fast          # 跳过慢测（engine-smoke / corpus-replay）
 *   node tools/run-tests.mjs --only engine    # 只跑文件名含 "engine" 的测试
 *   node tools/run-tests.mjs --check-only    # 只做 node --check 语法检查
 *   node tools/run-tests.mjs --list          # 列出将要执行的测试
 *
 * 退出码：全部通过 0；有失败 1；参数错误 2。
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** 测试目录 */
const TEST_DIR = join(ROOT, 'test');

/**
 * 排除的用例库（只导出 CASES、不自跑；由 tools/e2e-*.mjs 驱动）。
 * 判定口径：有 process.exit / process.exitCode 的是可运行测试，否则是用例库/辅助库。
 */
const CASE_LIB_HINT = /export\s+(?:const|let|var|function)\s+[A-Za-z0-9_]*CASES/;

/** 慢测（放宽超时；--fast 时跳过） */
const SLOW_TESTS = new Set(['engine-smoke.mjs', 'corpus-replay.mjs']);

/** 默认超时（毫秒） */
const DEFAULT_TIMEOUT_MS = 120_000;
/** 慢测超时（毫秒） */
const SLOW_TIMEOUT_MS = 300_000;

/**
 * 前置数据依赖：测试文件 → 缺失时必须跳过（不能崩）的资源。
 * 值为资源说明（用于打印修复提示）。
 */
const DATA_REQUIREMENTS = [
  {
    file: 'mapdata/guangzhou-roads.json',
    hint: '真实路网 JSON（6.7MB，被 .gitignore 忽略）→ 用 mapdata/tools/ 下的脚本从 PBF 重新生成',
  },
  {
    file: 'web/data/guangzhou-roads.json',
    hint: '页面直连的路网副本（6.7MB，被 .gitignore 忽略）→ 从 mapdata/guangzhou-roads.json 复制',
  },
];

/**
 * 判断某测试是否依赖指定数据文件。
 *
 * 口径：**解析测试的本地 import 传递闭包**，而不是只看测试文件自身的源码字符串。
 * 早期版本只做字符串匹配，漏掉了 `test/corpus-replay.mjs` →
 * `test/fixtures/corpus/roadnet.mjs` 这条间接依赖（后者用
 * `new URL('../../../mapdata/guangzhou-roads.json', import.meta.url)` 读路网），
 * 结果干净克隆里跑 corpus-replay 直接 ENOENT 崩。
 *
 * @param {string} testPath 测试文件绝对路径
 * @param {string} relative 数据文件相对路径
 * @returns {string|null} 命中该依赖的文件（未依赖返回 null）
 */
function dependsOn(testPath, relative) {
  const normalized = relative.replace(/\\/g, '/');
  for (const file of dependencyClosure(testPath)) {
    if (readSource(file).includes(normalized)) return file;
  }
  return null;
}

/** 源码里的本地静态 import / re-export（只取相对路径） */
const IMPORT_RE = /(?:^|[\n;])\s*(?:import|export)\s+(?:[^'";]*?\sfrom\s+)?['"](\.[^'"]+)['"]/g;

/**
 * 解析 import 路径对应的真实文件（兼容无扩展名与目录 index）。
 *
 * @param {string} base 绝对路径
 * @returns {string|null} 命中的文件绝对路径
 */
function resolveImport(base) {
  const candidates = [base, `${base}.js`, `${base}.mjs`, join(base, 'index.js'), join(base, 'index.mjs')];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** import 闭包缓存（同一入口只算一次） */
const closureCache = new Map();

/**
 * 计算一个文件的本地 import 传递闭包（含自身）。
 *
 * @param {string} entry 入口文件绝对路径
 * @returns {Set<string>} 闭包内所有文件绝对路径
 */
function dependencyClosure(entry) {
  const cached = closureCache.get(entry);
  if (cached) return cached;
  const seen = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const source = readSource(file);
    for (const match of source.matchAll(IMPORT_RE)) {
      const resolved = resolveImport(resolve(dirname(file), match[1]));
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  closureCache.set(entry, seen);
  return seen;
}

/**
 * 读取测试文件源码（不存在返回空串）。
 *
 * @param {string} path 绝对路径
 * @returns {string} 源码
 */
function readSource(path) {
  if (!existsSync(path)) {
    return '';
  }
  return readFileSync(path, 'utf8');
}

/**
 * 发现确定性测试文件（排除用例库）。
 *
 * @returns {Array<string>} 测试文件名（按字母序）
 */
function discoverTests() {
  return readdirSync(TEST_DIR)
    .filter((name) => name.endsWith('.mjs'))
    .filter((name) => {
      const source = readSource(join(TEST_DIR, name));
      // 可运行测试：自行设置退出码（process.exit / process.exitCode）
      if (!/process\.(exit|exitCode)/.test(source)) {
        return false;
      }
      // 用例库防御：导出 CASES 却不自跑的文件不参与测试
      if (CASE_LIB_HINT.test(source) && !/process\.exit/.test(source)) {
        return false;
      }
      return true;
    })
    .sort();
}

/**
 * 找出所有需要做 node --check 语法检查的脚本。
 *
 * @returns {Array<string>} 相对路径
 */
function discoverScripts() {
  const roots = ['web/src', 'web', 'test', 'tools'];
  const found = [];
  const skipDirs = new Set(['vendor', 'node_modules', 'data', 'fixtures', 'logs', 'out-merge']);
  /**
   * 递归收集脚本。
   *
   * @param {string} dir 目录
   */
  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        walk(full);
      } else if (/\.(mjs|js)$/.test(entry.name)) {
        found.push(full);
      }
    }
  }
  for (const root of roots) {
    walk(join(ROOT, root));
  }
  return [...new Set(found)];
}

/**
 * 解析命令行参数。
 *
 * @param {string[]} argv 参数数组
 * @returns {{fast: boolean, only: string|null, checkOnly: boolean, list: boolean}} 参数
 */
function parseArgs(argv) {
  const options = { fast: false, only: null, checkOnly: false, list: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--fast') {
      options.fast = true;
    } else if (arg === '--check-only') {
      options.checkOnly = true;
    } else if (arg === '--list') {
      options.list = true;
    } else if (arg === '--only') {
      options.only = argv[i + 1] ?? null;
      i += 1;
    } else if (arg.startsWith('--only=')) {
      options.only = arg.slice('--only='.length);
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return options;
}

/**
 * 跑单个测试。
 *
 * 用 `--import` 预加载 `test/lib/llm-test-config.mjs`：给不联网的确定性测试注入
 * 占位 LLM 配置。干净克隆里 `web/src/agent/agent-config.js`（含密钥，已 gitignore）
 * 不存在，而这些测试自己 mock 了 fetch——没有这个预加载，它们会在"还没发请求"时
 * 就因动态 import 失败而红。
 *
 * @param {string} name 测试文件名
 * @param {number} timeoutMs 超时
 * @returns {Promise<{name: string, code: number|null, ms: number, output: string, timedOut: boolean}>} 结果
 */
function runOne(name, timeoutMs) {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const child = spawn(
      process.execPath,
      ['--import', pathToFileURL(join(ROOT, 'test/lib/llm-test-config.mjs')).href, join(TEST_DIR, name)],
      {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      },
    );
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ name, code, ms: Date.now() - started, output, timedOut });
    });
  });
}

/**
 * 全量 node --check 语法检查。
 *
 * @returns {Promise<number>} 失败数
 */
async function runSyntaxCheck() {
  const scripts = discoverScripts();
  const failures = [];
  for (const script of scripts) {
    const result = await new Promise((resolvePromise) => {
      const child = spawn(process.execPath, ['--check', script], { stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      child.stderr.on('data', (chunk) => {
        err += chunk.toString();
      });
      child.on('close', (code) => resolvePromise({ code, err }));
    });
    if (result.code !== 0) {
      failures.push({ script: script.replace(ROOT + '\\', ''), err: result.err.trim() });
    }
  }
  console.log(`\n语法检查（node --check）：${scripts.length - failures.length}/${scripts.length} 通过`);
  for (const failure of failures) {
    console.log(`  FAIL ${failure.script}\n${failure.err}`);
  }
  return failures.length;
}

/** 主流程 */
async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(String(error.message));
    console.error('用法：node tools/run-tests.mjs [--fast] [--only <关键字>] [--check-only] [--list]');
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log('用法：node tools/run-tests.mjs [--fast] [--only <关键字>] [--check-only] [--list]');
    return;
  }

  if (options.checkOnly) {
    const failures = await runSyntaxCheck();
    process.exitCode = failures === 0 ? 0 : 1;
    return;
  }

  let tests = discoverTests();
  if (options.only) {
    tests = tests.filter((name) => name.includes(options.only));
  }
  if (options.fast) {
    tests = tests.filter((name) => !SLOW_TESTS.has(name));
  }

  if (options.list) {
    console.log(`确定性测试 ${tests.length} 个：`);
    for (const name of tests) console.log(`  ${name}`);
    return;
  }

  // 前置数据检测：缺失的测试跳过（不崩），并给出修复提示
  const skipped = [];
  const runnable = [];
  for (const name of tests) {
    const testPath = join(TEST_DIR, name);
    const missing = [];
    for (const req of DATA_REQUIREMENTS) {
      if (existsSync(join(ROOT, req.file))) continue;
      const via = dependsOn(testPath, req.file);
      if (via) missing.push({ ...req, via: relative(ROOT, via).replace(/\\/g, '/') });
    }
    if (missing.length > 0) {
      skipped.push({ name, missing });
    } else {
      runnable.push(name);
    }
  }

  console.log(`确定性测试：${tests.length} 个（可执行 ${runnable.length}，跳过 ${skipped.length}）`);
  for (const item of skipped) {
    console.log(`  SKIP ${item.name}（缺少前置数据）`);
    for (const req of item.missing) {
      console.log(`       缺少 ${req.file}：${req.hint}`);
      console.log(`       依赖来源：${req.via}`);
    }
  }

  const results = [];
  for (const name of runnable) {
    const timeoutMs = SLOW_TESTS.has(name) ? SLOW_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
    process.stdout.write(`  ... ${name}`);
    const result = await runOne(name, timeoutMs);
    results.push(result);
    const seconds = (result.ms / 1000).toFixed(1);
    if (result.timedOut) {
      console.log(`\r  TIMEOUT ${name} (${seconds}s, 超时 ${timeoutMs / 1000}s)`);
    } else if (result.code === 0) {
      console.log(`\r  PASS ${name} (${seconds}s)`);
    } else {
      console.log(`\r  FAIL ${name} (${seconds}s, exit ${result.code})`);
      const lines = result.output.split(/\r?\n/).filter((line) => /FAIL|Error|error:|失败|断言/.test(line));
      for (const line of lines.slice(0, 6)) {
        console.log(`       ${line.trim().slice(0, 160)}`);
      }
    }
  }

  const passed = results.filter((r) => r.code === 0 && !r.timedOut);
  const failed = results.filter((r) => r.code !== 0 || r.timedOut);
  const totalMs = results.reduce((sum, r) => sum + r.ms, 0);

  console.log('');
  console.log(`结果：${passed.length}/${results.length} 通过，用时 ${(totalMs / 1000).toFixed(1)}s`);
  if (skipped.length > 0) {
    console.log(`跳过 ${skipped.length} 个（缺前置数据）`);
  }
  if (failed.length > 0) {
    console.log(`失败 ${failed.length} 个：${failed.map((r) => r.name).join(', ')}`);
    process.exitCode = 1;
  }
}

await main();
