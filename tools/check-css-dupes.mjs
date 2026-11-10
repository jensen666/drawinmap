/**
 * CSS 重复声明体统计闸门（清理方案 2026-11-09 §6.3 T-B3c）。
 *
 * 目标：把"同一份声明体在 style.css 里重复 N 遍"变成可度量的静态指标，
 * 防止 UI 样式继续靠复制粘贴膨胀。只做统计、不做自动合并——合并必须人工逐条
 * 比对声明体（顺序敏感的简写/优先级不能机械合并）。
 *
 * 口径：
 * - 解析 `web/src/style.css`，提取每条规则的「选择器 + 声明体」；
 * - 声明体规范化（去空白、按 `;` 切分、去空项）后完全相同才算"同一声明体"；
 * - 统计"同一声明体出现 ≥2 次"的**组数**与这些组的**块数**（出现次数总和）；
 * - `@media`/`@supports` 内部规则一并统计（上下文不同不影响"声明体相同"的判定，
 *   但合并时仍需人眼确认级联顺序），`@keyframes` 内部帧跳过。
 *
 * 阈值（方案 §6.2 T-B3c）：组数 <5 且 块数 <10；超阈值 exit 1。
 *
 * 用法：
 *   node tools/check-css-dupes.mjs            # 统计并判定（超阈值 exit 1）
 *   node tools/check-css-dupes.mjs --list     # 只列明细，不做阈值判定（exit 0）
 *   node tools/check-css-dupes.mjs --verbose  # 明细里额外打印声明体摘要
 *
 * 退出码：达标 0；超阈值 1；文件缺失/参数错误 2。
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CSS_PATH = join(ROOT, 'web', 'src', 'style.css');

/** 阈值：组数与块数的上限（不含） */
const MAX_GROUPS = 5;
const MAX_BLOCKS = 10;

/** 嵌套整块跳过统计的 at-rule（内部是帧/字体配置，不是可复用声明体） */
const SKIP_AT_RULES = /^@(keyframes|-webkit-keyframes|font-face|property|counter-style|page)\b/i;

/** 容器型 at-rule（内部规则继续统计） */
const CONTAINER_AT_RULES = /^@(media|supports|layer|container)\b/i;

/**
 * 去掉 CSS 注释（替换为等长空白、保留换行，保证行号不变）。
 *
 * @param {string} source 原始 CSS
 * @returns {string} 去注释后的 CSS（长度不变）
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '));
}

/**
 * 规范化声明体：按 `;` 切分、去空项、压缩空白，返回可比较的字符串。
 *
 * @param {string} body 声明体原文（不含外层花括号）
 * @returns {string} 规范化后的声明体
 */
function normalizeDeclarations(body) {
  return body
    .split(';')
    .map((declaration) => declaration.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(';');
}

/**
 * 规范化选择器（仅用于展示/去重，不参与"同一声明体"判定）。
 *
 * @param {string} selector 选择器原文
 * @returns {string} 规范化选择器
 */
function normalizeSelector(selector) {
  return selector
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .trim();
}

/**
 * 解析 CSS 文本，返回所有普通规则（含 at-rule 容器内部的规则）。
 *
 * 扫描方式：维护一个块栈；遇到 `{` 记录选择器起点，遇到 `}` 结算当前块。
 * 顶层以 `;` 结尾的语句（如 `@import ...;`、`@charset ...;`）只更新边界、不产生规则。
 *
 * @param {string} source 已去注释的 CSS
 * @returns {Array<{selector: string, body: string, line: number, media: string}>} 规则列表
 */
function parseRules(source) {
  const rules = [];
  /** 块栈：{selector, bodyStart, line, media, skip} */
  const stack = [];
  let boundary = 0;
  let line = 1;
  let boundaryLine = 1;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '\n') {
      line += 1;
      continue;
    }
    if (ch === '{') {
      const selector = normalizeSelector(source.slice(boundary, i));
      const parent = stack[stack.length - 1] ?? null;
      const parentMedia = parent ? parent.media : '';
      const media = CONTAINER_AT_RULES.test(selector)
        ? `${parentMedia}${parentMedia ? ' > ' : ''}${selector}`
        : parent ? parent.media : '';
      stack.push({
        selector,
        bodyStart: i + 1,
        line: boundaryLine,
        media,
        skip: (parent ? parent.skip : false) || SKIP_AT_RULES.test(selector),
      });
      boundary = i + 1;
      boundaryLine = line;
      continue;
    }
    if (ch === '}') {
      const block = stack.pop();
      if (block) {
        const body = source.slice(block.bodyStart, i);
        const isAtRule = block.selector.startsWith('@');
        const isContainer = CONTAINER_AT_RULES.test(block.selector);
        if (!isAtRule && !block.skip) {
          rules.push({
            selector: block.selector,
            body: normalizeDeclarations(body),
            line: block.line,
            media: block.media,
          });
        } else if (isAtRule && !isContainer && !block.skip) {
          // 其它语句型 at-rule（如 @font-face 已被 skip 覆盖）：不统计
        }
      }
      boundary = i + 1;
      boundaryLine = line;
      continue;
    }
    if (ch === ';' && stack.length === 0) {
      // 顶层语句（@import/@charset 等）：更新边界
      boundary = i + 1;
      boundaryLine = line;
    }
  }
  return rules;
}

/**
 * 按规范化声明体分组，返回重复组。
 *
 * @param {Array<{selector: string, body: string, line: number, media: string}>} rules 规则列表
 * @returns {Array<{declarations: string, entries: Array<object>}>} 重复组（按块数降序）
 */
function findDuplicateGroups(rules) {
  const byBody = new Map();
  for (const rule of rules) {
    if (!rule.body) continue;
    if (!byBody.has(rule.body)) byBody.set(rule.body, []);
    byBody.get(rule.body).push(rule);
  }
  return [...byBody.entries()]
    .filter(([, entries]) => entries.length >= 2)
    .map(([declarations, entries]) => ({ declarations, entries }))
    .sort((a, b) => b.entries.length - a.entries.length || a.entries[0].line - b.entries[0].line);
}

/** 主流程 */
function main() {
  const argv = process.argv.slice(2);
  const listOnly = argv.includes('--list');
  const verbose = argv.includes('--verbose');
  const unknown = argv.filter((arg) => !['--list', '--verbose', '--help', '-h'].includes(arg));
  if (unknown.length > 0) {
    console.error(`未知参数：${unknown.join(' ')}`);
    console.error('用法：node tools/check-css-dupes.mjs [--list] [--verbose]');
    process.exitCode = 2;
    return;
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('用法：node tools/check-css-dupes.mjs [--list] [--verbose]');
    return;
  }
  if (!existsSync(CSS_PATH)) {
    console.error(`缺少样式文件：${relative(ROOT, CSS_PATH).replace(/\\/g, '/')}`);
    process.exitCode = 2;
    return;
  }

  const source = readFileSync(CSS_PATH, 'utf8');
  const rules = parseRules(stripComments(source));
  const groups = findDuplicateGroups(rules);
  const blockCount = groups.reduce((sum, group) => sum + group.entries.length, 0);
  const passed = groups.length < MAX_GROUPS && blockCount < MAX_BLOCKS;

  console.log(`[check-css-dupes] ${relative(ROOT, CSS_PATH).replace(/\\/g, '/')}`);
  console.log(`  规则总数：${rules.length}；重复声明体组数：${groups.length}（阈值 <${MAX_GROUPS}）；重复块数：${blockCount}（阈值 <${MAX_BLOCKS}）`);
  for (const [index, group] of groups.entries()) {
    const preview = group.declarations.length > 96
      ? `${group.declarations.slice(0, 96)}…`
      : group.declarations;
    console.log(`  组 ${index + 1}（${group.entries.length} 块）：${group.entries.map((entry) => `L${entry.line} ${entry.selector}`).join(' | ')}`);
    if (verbose) {
      console.log(`      声明体：${preview}`);
    }
  }

  if (listOnly) {
    console.log('  （--list：只列明细，不做阈值判定）');
    return;
  }
  if (passed) {
    console.log('  PASS：重复声明体已收敛到阈值内');
    return;
  }
  console.log(`  FAIL：重复声明体组数 ${groups.length} / 块数 ${blockCount} 超出阈值（<${MAX_GROUPS} / <${MAX_BLOCKS}），请合并同构声明体`);
  process.exitCode = 1;
}

main();
