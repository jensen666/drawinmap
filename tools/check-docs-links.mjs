/**
 * 文档链接检查（清理方案 2026-11-09 阶段 2）。
 *
 * 逐条解析仓库内 Markdown 的相对链接与图片引用，判定：
 * - 断链：目标文件在仓库里不存在；
 * - 指向未跟踪文件：目标存在于本机但没入库（`.gitignore` 忽略或根本不在 git 里）。
 *
 * 退出码：有断链 1；无断链 0。
 *
 * 用法：
 *   node tools/check-docs-links.mjs            # 列出问题
 *   node tools/check-docs-links.mjs --warn     # 只提示，不改退出码
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** 扫描的文档范围（仓库内全部已跟踪 Markdown，篇数随仓库变化，不写死） */
const DOC_ROOTS = [
  'docs',
  'README.md',
  'process.md',
  'idea.md',
  'mapdata/README.md',
  'test/README.md',
  'test/fixtures',
  'web/data/shapes/README.md',
  'web/src/reference/README.md',
];

/** 跳过的目录名（任意层级） */
const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor']);

/**
 * 跳过的目录路径（仓库相对路径前缀）。
 *
 * `docs/测试报告/` 是**本机验收产物目录**（截图 / 结果 JSON，`.gitignore` 不入库），
 * 里面的文件在本机存在、在克隆里不存在，扫描它只会产生噪音。归档目录里的
 * `测试报告` 子目录是**已入库的正文**，必须扫。
 */
const SKIP_PATHS = new Set(['docs/测试报告']);

/** 已跟踪文件集合（core.quotepath=false：非 ASCII 路径不转义） */
const tracked = new Set(
  execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  })
    .split(/\r?\n/)
    .filter(Boolean)
    .map((p) => p.replace(/\\/g, '/')),
);

/** 已跟踪目录集合（目录内含至少一个已跟踪文件即视为入库） */
const trackedDirs = new Set();
for (const file of tracked) {
  const parts = file.split('/');
  for (let i = 1; i < parts.length; i += 1) {
    trackedDirs.add(parts.slice(0, i).join('/'));
  }
}

/**
 * 收集待检查的 Markdown 文件。
 *
 * @param {string} target 目录或文件
 * @param {Array<string>} out 收集结果
 */
function collectMarkdown(target, out) {
  const full = join(ROOT, target);
  if (!existsSync(full)) return;
  if (statSync(full).isFile()) {
    if (target.endsWith('.md')) out.push(full);
    return;
  }
  for (const entry of readdirSync(full, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const rel = relative(ROOT, join(full, entry.name)).replace(/\\/g, '/');
    if (SKIP_PATHS.has(rel)) continue;
    if (entry.isDirectory()) collectMarkdown(rel, out);
    else if (entry.name.endsWith('.md')) out.push(join(ROOT, rel));
  }
}

const docs = [];
for (const target of DOC_ROOTS) collectMarkdown(target, docs);

const broken = [];
const untracked = [];

/** 提取 Markdown 里的链接与图片 */
const LINK_RE = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

for (const doc of docs) {
  const docRel = relative(ROOT, doc).replace(/\\/g, '/');
  const text = readFileSync(doc, 'utf8');
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const m of line.matchAll(LINK_RE)) {
      const target = m[1];
      // 跳过外链、锚点、邮件
      if (/^(https?:|mailto:|#|data:)/.test(target)) continue;
      // 去掉锚点与查询串
      const clean = target.split('#')[0].split('?')[0];
      if (!clean) continue;
      const abs = resolve(dirname(doc), decodeURIComponent(clean));
      const rel = relative(ROOT, abs).replace(/\\/g, '/');
      const exists = existsSync(abs);
      const isTracked = tracked.has(rel) || trackedDirs.has(rel);
      if (!exists) {
        broken.push({ doc: docRel, line: index + 1, target, resolved: rel });
      } else if (!isTracked) {
        untracked.push({ doc: docRel, line: index + 1, target, resolved: rel });
      }
    }
  });
}

console.log(`扫描文档 ${docs.length} 个（已跟踪文件 ${tracked.size} 个）`);

if (broken.length) {
  console.log(`\n断链 ${broken.length} 条（目标文件不存在）：`);
  for (const b of broken) {
    console.log(`  ${b.doc}:${b.line}  →  ${b.target}   (解析为 ${b.resolved})`);
  }
} else {
  console.log('\n断链：0 ✅');
}

if (untracked.length) {
  console.log(`\n指向未跟踪文件 ${untracked.length} 条（目标存在但未入库）：`);
  for (const u of untracked) {
    console.log(`  ${u.doc}:${u.line}  →  ${u.target}   (解析为 ${u.resolved})`);
  }
} else {
  console.log('指向未跟踪文件：0 ✅');
}

if (broken.length === 0 && untracked.length === 0) {
  console.log('\n文档链接检查通过 ✅');
} else if (broken.length === 0) {
  console.log('\n无断链；但有指向未跟踪文件的引用（需人工确认是否可接受）');
}

process.exitCode = broken.length === 0 ? 0 : 1;
