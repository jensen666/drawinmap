/**
 * 静态模块图闸门（清理方案 2026-11-09 阶段 0，T-C1）。
 *
 * 目的：C 批巨石拆分（controller/ui/planner/candidates/store）最容易引入两类
 * 结构退化，靠人工 review 挡不住：
 * 1. **循环依赖**——拆分时两个新模块互相 import，Node 照样跑但初始化顺序脆弱；
 * 2. **生产不可达 / 浏览器侧 node: 泄漏**——搬文件后忘了接线，或把服务端代码
 *    误 import 进浏览器图（浏览器没有 node: 内置模块，页面直接白屏）。
 *
 * 做法：静态解析 `web/src` + `web/server` 的 import/export-from（不做动态 import
 * 可达性——`web/src/agent/llm.js` 按需 `import('./agent-config.js')` 是刻意的
 * 动态密钥注入），从两个入口做可达性：
 * - 浏览器入口 `web/src/main.js`；
 * - 服务端入口 `web/server.mjs`。
 *
 * 断言（任一不满足 exit 1）：
 * 1. 0 循环依赖；
 * 2. 0 生产不可达文件（白名单：`web/src/agent/agent-config.js`，含密钥、动态注入）；
 * 3. 浏览器可达文件中 0 个 `node:` import；
 * 4. 所有相对 import 都能解析到真实文件（防搬文件后路径写错）。
 *
 * 用法：node tools/check-module-graph.mjs
 * 退出码：全部通过 0；有违规 1；内部错误 1（打印原因）。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** 浏览器入口（HTML 加载的唯一 ESM 入口） */
const BROWSER_ENTRY = 'web/src/main.js';
/** 服务端入口 */
const SERVER_ENTRY = 'web/server.mjs';

/** 扫描范围：生产代码目录（不含 vendor/node_modules/data/logs） */
const SCAN_DIRS = ['web/src', 'web/server'];

/** 白名单：允许"静态不可达"的文件及原因（新增项必须带理由，不能静默放行） */
const UNREACHABLE_WHITELIST = new Map([
  [
    'web/src/agent/agent-config.js',
    '含密钥的本机 LLM 配置，由 llm.js 动态 import（干净克隆里不存在；不参与静态图）',
  ],
]);

/** 跳过的目录名 */
const SKIP_DIRS = new Set(['vendor', 'node_modules', 'data', 'logs']);

/**
 * 收集待扫描的生产 JS 文件（仓库相对路径，正斜杠）。
 *
 * @returns {Array<string>} 文件相对路径（排序后）
 */
function collectFiles() {
  const files = [];
  /**
   * 递归扫描目录。
   *
   * @param {string} dir 绝对目录
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
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(full);
      } else if (/\.(js|mjs)$/.test(entry.name)) {
        files.push(relative(ROOT, full).split(sep).join('/'));
      }
    }
  }
  for (const dir of SCAN_DIRS) walk(join(ROOT, dir));
  // 服务端入口自身在 web/ 根下，单独补入
  if (existsSync(join(ROOT, SERVER_ENTRY))) files.push(SERVER_ENTRY);
  return [...new Set(files)].sort();
}

/**
 * 把注释替换为空格（保留换行，行号不变）。
 *
 * 不做这一步会把 JSDoc 里的 `import('node:http')` 类型注解误当成运行时动态
 * import（web/server.mjs 与 overpass.js 有多处），也会把注释里的示例代码
 * 当成真实 import。字符串/模板字符串内的内容原样保留。
 *
 * @param {string} source 源码
 * @returns {string} 去注释后的源码（长度与行数不变）
 */
function stripComments(source) {
  let output = '';
  let state = 'code'; // code | line | block | single | double | template
  let escaped = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (state === 'line') {
      if (char === '\n') {
        state = 'code';
        output += char;
      } else {
        output += ' ';
      }
      continue;
    }
    if (state === 'block') {
      if (char === '*' && next === '/') {
        output += '  ';
        i += 1;
        state = 'code';
      } else {
        output += char === '\n' ? '\n' : ' ';
      }
      continue;
    }
    if (state === 'single' || state === 'double' || state === 'template') {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (
        (state === 'single' && char === "'") ||
        (state === 'double' && char === '"') ||
        (state === 'template' && char === '`')
      ) {
        state = 'code';
      }
      continue;
    }
    // state === 'code'
    if (char === '/' && next === '/') {
      output += '  ';
      i += 1;
      state = 'line';
    } else if (char === '/' && next === '*') {
      output += '  ';
      i += 1;
      state = 'block';
    } else {
      if (char === "'") state = 'single';
      else if (char === '"') state = 'double';
      else if (char === '`') state = 'template';
      output += char;
    }
  }
  return output;
}

/**
 * 解析源码中的静态 import / export-from（注释已剔除）。
 *
 * 只认 `import ... from 'spec'`、`import 'spec'`、`export ... from 'spec'`、
 * `export * from 'spec'`；不匹配 `import(...)`（动态）与 `import.meta`。
 *
 * @param {string} source 源码
 * @returns {Array<{specifier: string, line: number}>} 导入记录
 */
function parseStaticImports(source) {
  const stripped = stripComments(source);
  const records = [];
  const pattern = /(?:^|[\n;])\s*(?:import|export)\s+(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
  let match = pattern.exec(stripped);
  while (match) {
    const line = stripped.slice(0, match.index).split('\n').length;
    records.push({ specifier: match[1], line });
    match = pattern.exec(stripped);
  }
  return records;
}

/**
 * 解析源码中的动态 import（只做展示与浏览器 node: 泄漏检查，不参与静态可达性）。
 *
 * @param {string} source 源码
 * @returns {Array<{specifier: string, line: number}>} 动态导入记录
 */
function parseDynamicImports(source) {
  const stripped = stripComments(source);
  const records = [];
  const pattern = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let match = pattern.exec(stripped);
  while (match) {
    const line = stripped.slice(0, match.index).split('\n').length;
    records.push({ specifier: match[1], line });
    match = pattern.exec(stripped);
  }
  return records;
}

/**
 * 判断 import 说明符是否为相对路径（静态图中只有相对路径能解析到仓库文件）。
 *
 * @param {string} specifier 说明符
 * @returns {boolean} 是否相对路径
 */
function isRelative(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

/**
 * 把相对 import 解析为仓库相对文件路径。
 *
 * @param {string} fromFile import 所在文件的仓库相对路径
 * @param {string} specifier import 说明符
 * @returns {string|null} 命中的仓库相对路径（不存在返回 null）
 */
function resolveImport(fromFile, specifier) {
  const clean = specifier.replace(/[?#].*$/, '');
  const base = resolve(ROOT, dirname(fromFile), clean);
  const candidates = [base, `${base}.js`, `${base}.mjs`, join(base, 'index.js'), join(base, 'index.mjs')];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return relative(ROOT, candidate).split(sep).join('/');
    }
  }
  return null;
}

/**
 * 从入口做 BFS 可达性。
 *
 * @param {string} entry 入口仓库相对路径
 * @param {Map<string, Array<string>>} edges 邻接表（仅仓库内文件）
 * @returns {Set<string>} 可达文件集合（含入口）
 */
function reachableFrom(entry, edges) {
  const reached = new Set();
  if (!existsSync(join(ROOT, entry))) return reached;
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (reached.has(file)) continue;
    reached.add(file);
    for (const next of edges.get(file) || []) {
      if (!reached.has(next)) queue.push(next);
    }
  }
  return reached;
}

/**
 * DFS 找循环依赖，返回去重后的循环路径列表。
 *
 * @param {Array<string>} nodes 节点（排序后）
 * @param {Map<string, Array<string>>} edges 邻接表
 * @returns {Array<Array<string>>} 循环路径（首尾同一节点）
 */
function findCycles(nodes, edges) {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map(nodes.map((node) => [node, WHITE]));
  const stack = [];
  const cycles = [];
  const seenCycles = new Set();

  /**
   * 深度优先遍历。
   *
   * @param {string} node 当前节点
   */
  function visit(node) {
    color.set(node, GRAY);
    stack.push(node);
    for (const next of edges.get(node) || []) {
      if (!color.has(next)) continue;
      const state = color.get(next);
      if (state === WHITE) {
        visit(next);
      } else if (state === GRAY) {
        const start = stack.indexOf(next);
        const cycle = [...stack.slice(start), next];
        // 规范化：从字典序最小节点开始，避免同一环因入口不同重复上报
        const body = cycle.slice(0, -1);
        const minIndex = body.indexOf([...body].sort()[0]);
        const canonical = [...body.slice(minIndex), ...body.slice(0, minIndex)];
        const key = canonical.join(' -> ');
        if (!seenCycles.has(key)) {
          seenCycles.add(key);
          cycles.push([...canonical, canonical[0]]);
        }
      }
    }
    stack.pop();
    color.set(node, BLACK);
  }

  for (const node of nodes) {
    if (color.get(node) === WHITE) visit(node);
  }
  return cycles;
}

/**
 * 主流程：解析图、跑四类断言、打印明细。
 *
 * @returns {number} 退出码
 */
function main() {
  const files = collectFiles();
  const fileSet = new Set(files);
  const edges = new Map();
  const brokenImports = [];
  const externalLeaves = [];
  const nodeImports = new Map(); // file -> [{module, line}]（静态 node: import）
  const dynamicImports = [];
  const dynamicNodeImports = [];

  for (const file of files) {
    const source = readFileSync(join(ROOT, file), 'utf8');
    const deps = [];
    for (const record of parseStaticImports(source)) {
      if (isRelative(record.specifier)) {
        const resolved = resolveImport(file, record.specifier);
        if (resolved === null) {
          brokenImports.push({ file, line: record.line, specifier: record.specifier });
          continue;
        }
        if (!fileSet.has(resolved)) {
          // 扫描范围外的真实文件（如 web/vendor/leaflet.esm.js）：作为叶子节点，
          // 不参与可达性/循环判定，但路径必须真实存在
          externalLeaves.push({ file, line: record.line, specifier: record.specifier, resolved });
          continue;
        }
        deps.push(resolved);
      } else if (record.specifier.startsWith('node:')) {
        if (!nodeImports.has(file)) nodeImports.set(file, []);
        nodeImports.get(file).push({ module: record.specifier, line: record.line });
      }
    }
    edges.set(file, [...new Set(deps)].sort());
    for (const record of parseDynamicImports(source)) {
      dynamicImports.push({ file, line: record.line, specifier: record.specifier });
      if (record.specifier.startsWith('node:')) {
        dynamicNodeImports.push({ file, line: record.line, specifier: record.specifier });
      }
    }
  }

  const browserReachable = reachableFrom(BROWSER_ENTRY, edges);
  const serverReachable = reachableFrom(SERVER_ENTRY, edges);
  const allReachable = new Set([...browserReachable, ...serverReachable]);
  const unreachable = files.filter((file) => !allReachable.has(file) && !UNREACHABLE_WHITELIST.has(file));
  const whitelistedUnreachable = files.filter((file) => !allReachable.has(file) && UNREACHABLE_WHITELIST.has(file));
  const cycles = findCycles(files, edges);
  const browserNodeImports = [...nodeImports.entries()].filter(([file]) => browserReachable.has(file));
  const serverNodeImports = [...nodeImports.entries()].filter(([file]) => !browserReachable.has(file));
  const browserDynamicNodeImports = dynamicNodeImports.filter((item) => browserReachable.has(item.file));

  // ---------- 打印明细 ----------
  console.log(`[module-graph] 扫描生产文件 ${files.length} 个（${SCAN_DIRS.join(' + ')}）`);
  console.log(
    `[module-graph] 浏览器入口 ${BROWSER_ENTRY} 可达 ${browserReachable.size} 个；` +
      `服务端入口 ${SERVER_ENTRY} 可达 ${serverReachable.size} 个`,
  );
  const edgeCount = [...edges.values()].reduce((sum, list) => sum + list.length, 0);
  console.log(`[module-graph] 静态依赖边 ${edgeCount} 条`);
  if (dynamicImports.length > 0) {
    console.log('[module-graph] 动态 import（不参与静态可达性）：');
    for (const item of dynamicImports) {
      console.log(`  ${item.file}:${item.line} -> ${item.specifier}`);
    }
  }
  if (whitelistedUnreachable.length > 0) {
    console.log('[module-graph] 白名单允许的静态不可达：');
    for (const file of whitelistedUnreachable) {
      console.log(`  ${file}（${UNREACHABLE_WHITELIST.get(file)}）`);
    }
  }
  console.log(
    `[module-graph] 服务端可达文件中的 node: import ${serverNodeImports.reduce((sum, [, list]) => sum + list.length, 0)} 处（合法）`,
  );
  if (externalLeaves.length > 0) {
    const leaves = [...new Set(externalLeaves.map((item) => item.resolved))];
    console.log(`[module-graph] 扫描范围外的真实依赖（叶子，不参与可达性/循环）：${leaves.join(', ')}`);
  }

  const failures = [];
  if (brokenImports.length > 0) {
    failures.push(`相对 import 无法解析 ${brokenImports.length} 处`);
    for (const item of brokenImports) {
      console.log(`  [FAIL] 断链 import ${item.file}:${item.line} -> ${item.specifier}`);
    }
  }
  if (cycles.length > 0) {
    failures.push(`循环依赖 ${cycles.length} 个`);
    for (const cycle of cycles) {
      console.log(`  [FAIL] 循环依赖：${cycle.join(' -> ')}`);
    }
  }
  if (unreachable.length > 0) {
    failures.push(`生产不可达文件 ${unreachable.length} 个`);
    for (const file of unreachable) {
      console.log(`  [FAIL] 生产不可达：${file}（未从两个入口静态可达，且不在白名单）`);
    }
  }
  if (browserNodeImports.length > 0 || browserDynamicNodeImports.length > 0) {
    failures.push(
      `浏览器图 node: import ${browserNodeImports.reduce((sum, [, list]) => sum + list.length, 0) + browserDynamicNodeImports.length} 处`,
    );
    for (const [file, list] of browserNodeImports) {
      for (const item of list) {
        console.log(`  [FAIL] 浏览器图 node: import：${file}:${item.line} -> ${item.module}`);
      }
    }
    for (const item of browserDynamicNodeImports) {
      console.log(`  [FAIL] 浏览器图动态 node: import：${item.file}:${item.line} -> ${item.specifier}`);
    }
  }

  if (failures.length > 0) {
    console.log(`\n[module-graph] 闸门不通过（exit 1）：${failures.join('；')}`);
    return 1;
  }
  console.log(
    `[module-graph] 闸门通过（exit 0）：0 循环、0 生产不可达、浏览器图 0 个 node: import、0 断链 import`,
  );
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`[module-graph] 内部错误：${error.stack || error.message}`);
  process.exitCode = 1;
}
