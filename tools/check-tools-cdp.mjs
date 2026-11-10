/**
 * 静态闸门：tools 脚本禁止再自带一份 CDP 基建（清理方案 2026-11-09 §6.3 T-D4）。
 *
 * 背景（§2 D4）：此前 3 个 E2E 驱动各自内嵌一份"极简 CDP 客户端"，`send()` 的超时
 * 定时器成功 resolve 后从不 `clearTimeout`，跑完进程多挂 3–6.7 分钟；修 bug 要改 N 遍。
 * 收口到 `tools/lib/cdp-driver.mjs` 之后，用本闸门保证不会有人再复制回去。
 *
 * 口径：
 * - 递归扫 `tools/**\/*.mjs`，排除 `tools/lib/`（公共实现）与 `tools/legacy/`（归档）；
 * - 命中任一禁用词即失败：`new WebSocket(`、`class Cdp`、`WebSocket.OPEN`；
 * - 失败时逐条打印 `文件:行号 [禁用词]`，退出码 1；全部干净退出码 0。
 *
 * 用法：node tools/check-tools-cdp.mjs
 * 退出码：0 通过；1 命中禁用词（新增/删除文件后必须仍为 0）。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TOOLS_DIR = join(ROOT, 'tools');

/** 不扫描的子目录：lib = 公共实现（唯一允许出现 CDP 基建的地方），legacy = 归档 */
const SKIP_DIRS = new Set(['lib', 'legacy']);

/** 禁止内嵌 CDP 基建的写法（出现任一即视为又复制了一份实现） */
const FORBIDDEN_TOKENS = ['new WebSocket(', 'class Cdp', 'WebSocket.OPEN'];

/**
 * 递归收集待扫描的 .mjs 脚本。
 *
 * @param {string} dir 目录绝对路径
 * @returns {string[]} 文件绝对路径
 */
function collectScripts(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      found.push(...collectScripts(full));
      continue;
    }
    if (!entry.name.endsWith('.mjs')) continue;
    // 本闸门自身包含禁用词常量（用于检测），跳过自检
    if (entry.name === 'check-tools-cdp.mjs') continue;
    found.push(full);
  }
  return found;
}

/** 命中记录 */
const violations = [];
const scripts = collectScripts(TOOLS_DIR);

for (const file of scripts) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    for (const token of FORBIDDEN_TOKENS) {
      if (lines[index].includes(token)) {
        violations.push({ rel, line: index + 1, token, text: lines[index].trim() });
      }
    }
  }
}

console.log(`CDP 基建静态闸门：扫描 ${scripts.length} 个 tools 脚本（排除 tools/lib/、tools/legacy/）`);
if (violations.length === 0) {
  console.log('未发现内嵌 CDP 基建（new WebSocket( / class Cdp / WebSocket.OPEN）✅');
} else {
  console.log(`\n发现 ${violations.length} 处内嵌 CDP 基建 —— 闸门不通过：`);
  for (const item of violations) {
    console.log(`  ${item.rel}:${item.line} [${item.token}] ${item.text}`);
  }
  console.log('\n修复：改用 tools/lib/cdp-driver.mjs 的 Cdp / resolveBrowser / findFreePort / launchBrowser。');
  process.exitCode = 1;
}
