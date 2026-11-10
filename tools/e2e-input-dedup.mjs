/**
 * 用例输入去重/溯源校验工具（只读，不调用 LLM、不启动浏览器）。
 *
 * 用途：
 * - 新增「历史从未出现过」的 E2E 用例时，证明输入原文确实没在仓库历史里出现过；
 * - 新增「历史弱例复测」用例时，证明每条输入都能在历史用例/报告/生产日志里找到出处。
 *
 * 历史原文来源（存在才扫）：
 * - test/**\/*.mjs 与 tools/**\/*.mjs 里的 input / text / userText / requestText 字符串字面量；
 * - docs/测试报告/**\/*.json 结果文件里的同名字段；
 * - web/logs/**\/*.jsonl 的 trace.start.data.text、guide.freeText.data.text（运行日志，gitignore）。
 *
 * 用法：
 *   node tools/e2e-input-dedup.mjs --cases-file test/e2e-real-llm-20-new-complex-cases.mjs
 *   node tools/e2e-input-dedup.mjs --cases-file test/e2e-real-llm-20-history-cases.mjs --require-history
 *
 * 跑批场景（避免把本次 E2E 自己产生的日志/结果当成「历史」）：
 *   # 跑批前先快照历史原文
 *   node tools/e2e-input-dedup.mjs --snapshot-out .tmp/history-inputs.json
 *   # 跑批后对快照做去重/溯源校验
 *   node tools/e2e-input-dedup.mjs --cases-file <用例文件> --history-file .tmp/history-inputs.json
 *
 * 退出码：0 = 全部符合期望；1 = 有重复 / 有输入在历史里找不到。
 */

import { readFileSync, readdirSync, existsSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 读取命令行参数 */
function argOf(name, fallback = null) {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

const CASES_FILE = argOf('cases-file');
const SNAPSHOT_OUT = argOf('snapshot-out');
const HISTORY_FILE = argOf('history-file');
/** 逗号分隔的仓库相对路径前缀：这些目录/文件不计入历史（例如本次跑批的产物目录） */
const EXCLUDES = (argOf('exclude', '') || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
/** 只把该时间点之前的运行日志算历史（ISO8601；用于跑批后补齐日志扫描） */
const LOG_BEFORE = argOf('log-before') ? Date.parse(argOf('log-before')) : null;
const REQUIRE_HISTORY = process.argv.includes('--require-history');

if (!CASES_FILE && !SNAPSHOT_OUT) {
  console.error('用法：node tools/e2e-input-dedup.mjs --cases-file <用例文件> [--require-history] [--history-file <快照>] [--exclude <前缀,...>] [--log-before <ISO>]');
  process.exit(1);
}
const casesPath = CASES_FILE ? path.resolve(ROOT, CASES_FILE) : null;

/** 是否被排除（按仓库相对路径前缀匹配） */
function isExcluded(filePath) {
  const relative = path.relative(ROOT, filePath).replace(/\\/g, '/');
  return EXCLUDES.some((prefix) => relative === prefix || relative.startsWith(`${prefix}/`) || relative.startsWith(prefix));
}

/** 历史输入文本 → 来源集合 */
const history = new Map();

/** 记录一条历史文本 */
function addHistory(text, source) {
  if (typeof text !== 'string') {
    return;
  }
  const trimmed = text.trim();
  if (!/[\u4e00-\u9fa5]/.test(trimmed) || trimmed.length < 2 || trimmed.length > 200 || trimmed.includes('\n')) {
    return;
  }
  if (!history.has(trimmed)) {
    history.set(trimmed, new Set());
  }
  history.get(trimmed).add(source);
}

/** 扫描 JS 文件里的用例输入字面量 */
function scanJs(filePath) {
  if (isExcluded(filePath)) {
    return;
  }
  const relative = path.relative(ROOT, filePath);
  if (casesPath && path.resolve(filePath) === casesPath) {
    return; // 不把被检查的用例文件自己算进历史
  }
  let source;
  try {
    source = readFileSync(filePath, 'utf8');
  } catch {
    return;
  }
  const literal = /(?:^|[\s{,;])(?:input|text|userText|requestText)\s*:\s*(['"`])([\s\S]*?)\1\s*[,}\n]/g;
  for (const match of source.matchAll(literal)) {
    addHistory(match[2], relative);
  }
}

/** 递归扫描 JSON 结果文件 */
function scanJson(filePath) {
  if (isExcluded(filePath)) {
    return;
  }
  const relative = path.relative(ROOT, filePath);
  let data;
  try {
    data = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return;
  }
  const visit = (node) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== 'object') {
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (['input', 'text', 'userText', 'requestText'].includes(key) && typeof value === 'string') {
        addHistory(value, relative);
      } else if (value && typeof value === 'object') {
        visit(value);
      }
    }
  };
  visit(data);
}

/** 扫描运行日志 JSONL 里的真实用户输入 */
function scanJsonl(filePath) {
  if (isExcluded(filePath)) {
    return;
  }
  const relative = path.relative(ROOT, filePath);
  let lines;
  try {
    lines = readFileSync(filePath, 'utf8').split('\n');
  } catch {
    return;
  }
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      continue;
    }
    if (LOG_BEFORE && Number(item.ts) >= LOG_BEFORE) {
      continue; // 跑批开始后的日志不算历史
    }
    if (item.event === 'trace.start' && item.data?.text) {
      addHistory(item.data.text, relative);
    }
    if (item.event === 'guide.freeText' && item.data?.text) {
      addHistory(item.data.text, relative);
    }
  }
}

/** 递归遍历目录 */
function walk(directory, onFile) {
  if (!existsSync(directory)) {
    return;
  }
  for (const name of readdirSync(directory)) {
    const full = path.join(directory, name);
    let info;
    try {
      info = statSync(full);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      if (['node_modules', '.git', '.tmp', 'vendor'].includes(name)) {
        continue;
      }
      walk(full, onFile);
    } else {
      onFile(full);
    }
  }
}

// 跑批前快照模式：只采集并写出历史原文，供跑批后复核使用
if (SNAPSHOT_OUT) {
  walk(path.join(ROOT, 'test'), (file) => file.endsWith('.mjs') && scanJs(file));
  walk(path.join(ROOT, 'tools'), (file) => file.endsWith('.mjs') && scanJs(file));
  walk(path.join(ROOT, 'docs', '测试报告'), (file) => file.endsWith('.json') && scanJson(file));
  walk(path.join(ROOT, 'web', 'logs'), (file) => file.endsWith('.jsonl') && scanJsonl(file));
  const snapshot = [...history.entries()].map(([text, sources]) => ({ text, sources: [...sources] }));
  const snapshotPath = path.resolve(ROOT, SNAPSHOT_OUT);
  writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf8');
  console.log(`历史原文快照：${snapshot.length} 条 → ${path.relative(ROOT, snapshotPath)}`);
  process.exit(0);
}

// 收集历史原文：优先用跑批前快照，避免把本次跑批自己产生的日志/结果当成历史
if (HISTORY_FILE) {
  const snapshotPath = path.resolve(ROOT, HISTORY_FILE);
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  const list = Array.isArray(snapshot) ? snapshot : (snapshot.all ?? []);
  for (const item of list) {
    if (typeof item === 'string') {
      addHistory(item, path.relative(ROOT, snapshotPath));
    } else if (item && typeof item.text === 'string') {
      addHistory(item.text, (item.sources ?? []).join(', ') || path.relative(ROOT, snapshotPath));
    }
  }
} else {
  walk(path.join(ROOT, 'test'), (file) => file.endsWith('.mjs') && scanJs(file));
  walk(path.join(ROOT, 'tools'), (file) => file.endsWith('.mjs') && scanJs(file));
  walk(path.join(ROOT, 'docs', '测试报告'), (file) => file.endsWith('.json') && scanJson(file));
  walk(path.join(ROOT, 'web', 'logs'), (file) => file.endsWith('.jsonl') && scanJsonl(file));
}

// 读取待校验用例
const caseModule = await import(pathToFileURL(casesPath).href);
const cases = caseModule.CASES ?? caseModule.default;
if (!Array.isArray(cases) || cases.length === 0) {
  console.error(`[fatal] 用例文件未导出 CASES 数组：${CASES_FILE}`);
  process.exit(1);
}

let duplicated = 0;
let missingHistory = 0;
console.log(`历史输入原文（去重后）：${history.size} 条`);
console.log(`待校验用例：${cases.length} 条（${path.relative(ROOT, casesPath)}）\n`);
for (const item of cases) {
  const text = String(item.input ?? '').trim();
  const sources = history.get(text);
  if (REQUIRE_HISTORY) {
    const ok = Boolean(sources);
    if (!ok) {
      missingHistory += 1;
    }
    console.log(`[${ok ? 'OK' : 'MISS'}] ${item.id} 历史出处：${ok ? [...sources].join(', ') : '未找到'}｜${text}`);
  } else {
    const ok = !sources;
    if (!ok) {
      duplicated += 1;
    }
    console.log(`[${ok ? 'OK' : 'DUP'}] ${item.id} ${ok ? '历史未出现过' : `重复于 ${[...sources].slice(0, 3).join(', ')}`}｜${text}`);
  }
}

if (REQUIRE_HISTORY) {
  console.log(`\n结果：${cases.length - missingHistory}/${cases.length} 条输入能在历史中找到原文，缺失 ${missingHistory} 条`);
  process.exitCode = missingHistory === 0 ? 0 : 1;
} else {
  console.log(`\n结果：${cases.length - duplicated}/${cases.length} 条输入为历史未出现，重复 ${duplicated} 条`);
  process.exitCode = duplicated === 0 ? 0 : 1;
}
