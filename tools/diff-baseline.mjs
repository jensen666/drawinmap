/**
 * 基线对比工具（清理方案 2026-11-09 阶段 0，T-B1a）。
 *
 * 用途：B 批等价去重 / C 批巨石拆分前后，对同一命令产出的两份 JSON 做
 * **递归逐字段**对比，`exit 0` 才算行为等价。默认严格 `===`（不做数值容差），
 * 唯一放行口是显式 `--ignore` 白名单——每条忽略路径都必须在方案/实施记录里
 * 写清理由（例如 D2 修复只允许 `metrics.searchStats.*` 变化）。
 *
 * 用法：
 *   node tools/diff-baseline.mjs before.json after.json
 *   node tools/diff-baseline.mjs before.json after.json --ignore=metrics.searchStats,generatedAt
 *   node tools/diff-baseline.mjs before.json after.json --ignore=a.b --ignore=legs[0].routeMeters
 *
 * 忽略路径语法：点分路径，数组下标写 `[0]`（也接受纯数字段 `legs.0.x`）；
 * `*` 匹配任意单个路径段。忽略某路径 = 忽略该节点整棵子树。
 *
 * 退出码：0 = 无差异（等价）；1 = 有差异；2 = 参数/文件读取错误。
 *
 * 也可作为模块导入：`diffJson(before, after, { ignore: [...] })`。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 输出给用户的值预览最大长度 */
const VALUE_PREVIEW_MAX = 160;

/**
 * 把路径段数组格式化为可读路径：`a.b[0].c`。
 *
 * @param {Array<string>} segments 路径段（对象键为字符串、数组下标为数字字符串）
 * @returns {string} 可读路径
 */
export function formatPath(segments) {
  let out = '';
  for (const segment of segments) {
    if (/^\d+$/.test(segment)) {
      out += `[${segment}]`;
    } else {
      out += out === '' ? segment : `.${segment}`;
    }
  }
  return out === '' ? '(root)' : out;
}

/**
 * 把忽略表达式解析为路径段数组。
 *
 * 支持 `a.b`、`a[0].b`、`legs.0.x`、`a.*.b`；空段忽略。
 *
 * @param {string} pattern 忽略表达式
 * @returns {Array<string>} 路径段
 */
export function parsePathPattern(pattern) {
  const segments = [];
  for (const part of String(pattern).split('.')) {
    if (part === '') continue;
    const tokenRe = /([^[\]]+)|\[([^\]]*)\]/g;
    let match = tokenRe.exec(part);
    while (match) {
      if (match[1] !== undefined) {
        segments.push(match[1]);
      } else {
        segments.push(match[2] === '' ? '*' : match[2]);
      }
      match = tokenRe.exec(part);
    }
  }
  return segments;
}

/**
 * 判断某路径是否命中忽略白名单（命中 = 忽略该节点整棵子树）。
 *
 * @param {Array<string>} pathSegments 当前路径段
 * @param {Array<Array<string>>} ignorePatterns 已解析的忽略路径段
 * @returns {boolean} 是否忽略
 */
export function isIgnoredPath(pathSegments, ignorePatterns) {
  for (const pattern of ignorePatterns) {
    if (pattern.length === 0 || pattern.length > pathSegments.length) continue;
    let matched = true;
    for (let i = 0; i < pattern.length; i += 1) {
      if (pattern[i] !== '*' && pattern[i] !== pathSegments[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

/**
 * 判断是否为普通对象（排除 null / 数组）。
 *
 * @param {unknown} value 值
 * @returns {boolean} 是否普通对象
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 值预览：基本类型原样，对象/数组用 JSON 串并截断。
 *
 * @param {unknown} value 值
 * @returns {string} 预览串
 */
function preview(value) {
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(value).slice(0, VALUE_PREVIEW_MAX);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined) text = String(value);
  return text.length > VALUE_PREVIEW_MAX ? `${text.slice(0, VALUE_PREVIEW_MAX)}…` : text;
}

/**
 * 递归对比两份 JSON 值，收集差异。
 *
 * 语义：
 * - 类型必须一致（数组 vs 对象、null vs 对象等都算差异）；
 * - 数组按元素逐项比，长度不同分别报"缺失/多余"；
 * - 对象按并集键逐项比，多键/少键分别报；
 * - 数值严格 `===`（不做容差；需要容差请在调用侧预处理）；
 * - 命中 `ignore` 的路径整棵子树跳过，只统计跳过的路径数。
 *
 * @param {unknown} before 改前值（JSON.parse 后的数据）
 * @param {unknown} after 改后值
 * @param {{ignore?: Array<string>, maxDifferences?: number}} [options] 选项
 * @returns {{equal: boolean, differences: Array<{path: string, before: string, after: string}>, totalDifferences: number, ignoredCount: number}} 对比结果
 */
export function diffJson(before, after, options = {}) {
  const ignorePatterns = (options.ignore || []).map(parsePathPattern).filter((item) => item.length > 0);
  const maxDifferences = Number.isInteger(options.maxDifferences) ? options.maxDifferences : 100;
  const differences = [];
  let totalDifferences = 0;
  let ignoredCount = 0;

  /**
   * 记录一处差异（超出 maxDifferences 后只计数不存明细）。
   *
   * @param {Array<string>} path 路径段
   * @param {unknown} beforeValue before 侧值
   * @param {unknown} afterValue after 侧值
   */
  function record(path, beforeValue, afterValue) {
    totalDifferences += 1;
    if (differences.length >= maxDifferences) return;
    differences.push({
      path: formatPath(path),
      before: preview(beforeValue),
      after: preview(afterValue),
    });
  }

  /**
   * 递归比较。
   *
   * @param {unknown} beforeValue before 侧值
   * @param {unknown} afterValue after 侧值
   * @param {Array<string>} path 当前路径段
   */
  function walk(beforeValue, afterValue, path) {
    if (isIgnoredPath(path, ignorePatterns)) {
      ignoredCount += 1;
      return;
    }
    // 引用/原始值严格相等（含同一个字符串、布尔、数字、null、undefined）
    if (beforeValue === afterValue) return;

    const beforeIsArray = Array.isArray(beforeValue);
    const afterIsArray = Array.isArray(afterValue);
    if (beforeIsArray && afterIsArray) {
      const length = Math.max(beforeValue.length, afterValue.length);
      for (let i = 0; i < length; i += 1) {
        if (i >= beforeValue.length) {
          record([...path, String(i)], undefined, afterValue[i]);
        } else if (i >= afterValue.length) {
          record([...path, String(i)], beforeValue[i], undefined);
        } else {
          walk(beforeValue[i], afterValue[i], [...path, String(i)]);
        }
      }
      return;
    }

    const beforeIsObject = isPlainObject(beforeValue);
    const afterIsObject = isPlainObject(afterValue);
    if (beforeIsObject && afterIsObject) {
      const keys = [...new Set([...Object.keys(beforeValue), ...Object.keys(afterValue)])].sort();
      for (const key of keys) {
        const inBefore = Object.prototype.hasOwnProperty.call(beforeValue, key);
        const inAfter = Object.prototype.hasOwnProperty.call(afterValue, key);
        if (!inBefore) {
          record([...path, key], undefined, afterValue[key]);
        } else if (!inAfter) {
          record([...path, key], beforeValue[key], undefined);
        } else {
          walk(beforeValue[key], afterValue[key], [...path, key]);
        }
      }
      return;
    }

    // 类型不同，或两侧都不是容器 → 直接记差异
    record(path, beforeValue, afterValue);
  }

  walk(before, after, []);
  return {
    equal: totalDifferences === 0,
    differences,
    totalDifferences,
    ignoredCount,
  };
}

/**
 * 解析命令行参数。
 *
 * @param {Array<string>} argv 参数（不含 node / 脚本名）
 * @returns {{help: boolean, positional: Array<string>, ignore: Array<string>, maxDifferences: number}} 解析结果
 * @throws {Error} 参数非法
 */
export function parseArgs(argv) {
  const options = { help: false, positional: [], ignore: [], maxDifferences: 100 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg.startsWith('--ignore=')) {
      options.ignore.push(
        ...arg
          .slice('--ignore='.length)
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
      );
    } else if (arg === '--ignore') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error('--ignore 缺少路径参数');
      i += 1;
      options.ignore.push(
        ...value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
      );
    } else if (arg.startsWith('--max-differences=')) {
      const value = Number(arg.slice('--max-differences='.length));
      if (!Number.isInteger(value) || value <= 0) throw new Error('--max-differences 必须是正整数');
      options.maxDifferences = value;
    } else if (arg.startsWith('-')) {
      throw new Error(`未知参数：${arg}`);
    } else {
      options.positional.push(arg);
    }
  }
  return options;
}

/** 用法说明 */
const USAGE = [
  '用法：node tools/diff-baseline.mjs <before.json> <after.json> [--ignore=path1,path2] [--max-differences=N]',
  '',
  '递归逐字段对比两份 JSON；退出码 0 = 无差异（等价），1 = 有差异，2 = 参数/文件错误。',
  '忽略路径语法：点分路径，数组下标写 [0]（也接受纯数字段），* 匹配任意单段；忽略即跳过整棵子树。',
].join('\n');

/**
 * 读取并解析 JSON 文件。
 *
 * @param {string} file 路径
 * @param {string} label 显示名（before/after）
 * @returns {unknown} 解析结果
 * @throws {Error} 读取或解析失败
 */
function readJsonFile(file, label) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`${label} 文件读取失败：${file}（${error.message}）`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} 文件不是合法 JSON：${file}（${error.message}）`);
  }
}

/**
 * CLI 主流程。
 *
 * @param {Array<string>} argv 参数
 * @returns {number} 退出码
 */
export function runCli(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`[diff-baseline] ${error.message}`);
    console.error(USAGE);
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  if (options.positional.length !== 2) {
    console.error(`[diff-baseline] 需要 2 个 JSON 文件参数，实际 ${options.positional.length} 个`);
    console.error(USAGE);
    return 2;
  }

  const [beforePath, afterPath] = options.positional;
  let before;
  let after;
  try {
    before = readJsonFile(beforePath, 'before');
    after = readJsonFile(afterPath, 'after');
  } catch (error) {
    console.error(`[diff-baseline] ${error.message}`);
    return 2;
  }

  const result = diffJson(before, after, {
    ignore: options.ignore,
    maxDifferences: options.maxDifferences,
  });
  const ignoreNote = options.ignore.length > 0 ? `（--ignore 白名单 ${options.ignore.length} 条，跳过 ${result.ignoredCount} 处路径）` : '';
  console.log(`[diff-baseline] before=${beforePath}`);
  console.log(`[diff-baseline] after =${afterPath}`);
  if (result.equal) {
    console.log(`[diff-baseline] 0 差异${ignoreNote} -> 等价（exit 0）`);
    return 0;
  }
  for (const difference of result.differences) {
    console.log(`[diff] ${difference.path}: before=${difference.before} after=${difference.after}`);
  }
  if (result.totalDifferences > result.differences.length) {
    console.log(`[diff] …… 另有 ${result.totalDifferences - result.differences.length} 处差异未列出（--max-differences=${options.maxDifferences}）`);
  }
  console.log(
    `[diff-baseline] 共 ${result.totalDifferences} 处差异${ignoreNote} -> 不等价（exit 1）`,
  );
  return 1;
}

// 仅在作为 CLI 直接执行时跑主流程；被测试 import 时不执行
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath !== null && invokedPath === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = runCli(process.argv.slice(2));
}
