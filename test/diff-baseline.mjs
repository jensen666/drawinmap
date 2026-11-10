/**
 * 基线对比工具自测（清理方案 2026-11-09 阶段 0，T-B1a 的"工具自测"）。
 *
 * 覆盖两层：
 * 1. 模块层：`diffJson` 的逐字段语义（类型/数组/多键少键/严格数值/忽略白名单/明细上限）；
 * 2. CLI 层：真实 spawn `node tools/diff-baseline.mjs`，断言退出码 0/1/2 与输出。
 *
 * 运行：node test/diff-baseline.mjs
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  diffJson,
  formatPath,
  isIgnoredPath,
  parsePathPattern,
  parseArgs,
} from '../tools/diff-baseline.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TOOL = join(ROOT, 'tools', 'diff-baseline.mjs');

let checks = 0;
let failures = 0;

/**
 * 断言工具：记录并通过/失败计数。
 *
 * @param {string} label 断言标签
 * @param {boolean} condition 断言条件
 * @param {string} [detail] 失败详情
 */
function check(label, condition, detail = '') {
  checks += 1;
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`[check] ${label} -> ${ok ? 'PASS' : `FAIL ${detail}`}`);
}

// ---------- 1. 路径语法：解析 / 格式化 / 忽略匹配 ----------
{
  check('路径：formatPath 数组下标写 [0]', formatPath(['legs', '0', 'x']) === 'legs[0].x', formatPath(['legs', '0', 'x']));
  check('路径：formatPath 根路径', formatPath([]) === '(root)', formatPath([]));
  check(
    '路径：parsePathPattern 支持 a.b / a[0].b / a.*.b / legs.0.x',
    JSON.stringify(parsePathPattern('a.b')) === '["a","b"]' &&
      JSON.stringify(parsePathPattern('a[0].b')) === '["a","0","b"]' &&
      JSON.stringify(parsePathPattern('a.*.b')) === '["a","*","b"]' &&
      JSON.stringify(parsePathPattern('legs.0.x')) === '["legs","0","x"]',
    JSON.stringify([parsePathPattern('a[0].b'), parsePathPattern('a.*.b'), parsePathPattern('legs.0.x')]),
  );
  const patterns = [parsePathPattern('a.b'), parsePathPattern('legs.*.x')];
  check('忽略匹配：精确路径前缀命中', isIgnoredPath(['a', 'b', 'c'], patterns) === true);
  check('忽略匹配：通配单段命中', isIgnoredPath(['legs', '0', 'x'], patterns) === true);
  check('忽略匹配：通配不跨段', isIgnoredPath(['legs', '0', 'y'], patterns) === false);
  check('忽略匹配：路径比模式短不命中', isIgnoredPath(['a'], patterns) === false);
}

// ---------- 2. 模块层：diffJson 逐字段语义 ----------
{
  const identical = diffJson({ a: 1, b: [1, 2], c: { d: 'x' } }, { a: 1, b: [1, 2], c: { d: 'x' } });
  check('同值：equal=true 且 0 差异', identical.equal === true && identical.totalDifferences === 0,
    JSON.stringify(identical));

  const keyOrder = diffJson({ a: 1, b: 2 }, { b: 2, a: 1 });
  check('对象键顺序：不影响等价', keyOrder.equal === true, JSON.stringify(keyOrder));

  const nested = diffJson({ a: { b: 1, c: 2 } }, { a: { b: 1, c: 3 } });
  check(
    '嵌套差异：路径与两边值',
    nested.equal === false &&
      nested.totalDifferences === 1 &&
      nested.differences[0].path === 'a.c' &&
      nested.differences[0].before === '2' &&
      nested.differences[0].after === '3',
    JSON.stringify(nested.differences),
  );

  const arrayDiff = diffJson({ legs: [{ routeMeters: 10 }, { routeMeters: 20 }] }, {
    legs: [{ routeMeters: 10 }, { routeMeters: 21 }],
  });
  check(
    '数组元素差异：路径带下标',
    arrayDiff.totalDifferences === 1 && arrayDiff.differences[0].path === 'legs[1].routeMeters',
    JSON.stringify(arrayDiff.differences),
  );

  const arrayLonger = diffJson({ a: [1, 2] }, { a: [1, 2, 3] });
  check(
    '数组变长：报出多余元素（before=undefined）',
    arrayLonger.totalDifferences === 1 &&
      arrayLonger.differences[0].path === 'a[2]' &&
      arrayLonger.differences[0].before === 'undefined' &&
      arrayLonger.differences[0].after === '3',
    JSON.stringify(arrayLonger.differences),
  );

  const arrayShorter = diffJson({ a: [1, 2, 3] }, { a: [1, 2] });
  check(
    '数组变短：报出缺失元素（after=undefined）',
    arrayShorter.totalDifferences === 1 && arrayShorter.differences[0].path === 'a[2]',
    JSON.stringify(arrayShorter.differences),
  );

  const addedKey = diffJson({ a: 1 }, { a: 1, b: 2 });
  check(
    '对象多键：报出 after 新增',
    addedKey.totalDifferences === 1 &&
      addedKey.differences[0].path === 'b' &&
      addedKey.differences[0].before === 'undefined' &&
      addedKey.differences[0].after === '2',
    JSON.stringify(addedKey.differences),
  );

  const removedKey = diffJson({ a: 1, b: 2 }, { a: 1 });
  check(
    '对象少键：报出 before 缺失',
    removedKey.totalDifferences === 1 &&
      removedKey.differences[0].path === 'b' &&
      removedKey.differences[0].after === 'undefined',
    JSON.stringify(removedKey.differences),
  );

  const typeMismatch = diffJson({ a: 1 }, { a: '1' });
  check(
    '类型不同：直接记差异（不做隐式转换）',
    typeMismatch.totalDifferences === 1 &&
      typeMismatch.differences[0].path === 'a' &&
      typeMismatch.differences[0].after === '"1"',
    JSON.stringify(typeMismatch.differences),
  );

  const containerMismatch = diffJson({ a: {} }, { a: [] });
  check('对象 vs 数组：记差异', containerMismatch.totalDifferences === 1, JSON.stringify(containerMismatch));

  check('数值严格 ===：0.1 与 0.1 等价', diffJson([0.1], [0.1]).equal === true);
  check('数值严格 ===：0.1 与 0.1000001 不等价', diffJson([0.1], [0.1000001]).totalDifferences === 1);
  check('数值严格 ===：1 与 1.0 等价（同一 JS 数值）', diffJson([1], [1.0]).equal === true);

  const maxDiff = diffJson(
    { a: 1, b: 2, c: 3, d: 4, e: 5 },
    { a: 9, b: 9, c: 9, d: 9, e: 9 },
    { maxDifferences: 2 },
  );
  check(
    '明细上限：只存 2 条但总数 5',
    maxDiff.differences.length === 2 && maxDiff.totalDifferences === 5 && maxDiff.equal === false,
    JSON.stringify({ stored: maxDiff.differences.length, total: maxDiff.totalDifferences }),
  );
}

// ---------- 3. 模块层：--ignore 白名单 ----------
{
  const before = { routeMeters: 5, metrics: { searchStats: { expandedNodes: 1, cappedLegs: 0 } } };
  const after = { routeMeters: 5, metrics: { searchStats: { expandedNodes: 9, cappedLegs: 2 } } };

  check('未加忽略：两份基线不等价', diffJson(before, after).equal === false);

  const ignoreSubtree = diffJson(before, after, { ignore: ['metrics.searchStats'] });
  check(
    '忽略子树：整棵跳过、等价',
    ignoreSubtree.equal === true && ignoreSubtree.totalDifferences === 0 && ignoreSubtree.ignoredCount === 1,
    JSON.stringify(ignoreSubtree),
  );

  const ignoreLeaf = diffJson(before, after, { ignore: ['metrics.searchStats.expandedNodes', 'metrics.searchStats.cappedLegs'] });
  check('忽略叶子：两条都忽略、等价', ignoreLeaf.equal === true && ignoreLeaf.ignoredCount === 2, JSON.stringify(ignoreLeaf));

  const oneLeafLeft = diffJson(before, after, { ignore: ['metrics.searchStats.expandedNodes'] });
  check(
    '忽略部分叶子：剩余差异仍被抓到',
    oneLeafLeft.equal === false &&
      oneLeafLeft.totalDifferences === 1 &&
      oneLeafLeft.differences[0].path === 'metrics.searchStats.cappedLegs',
    JSON.stringify(oneLeafLeft.differences),
  );

  const arrayBefore = { legs: [{ x: 1, y: 1 }, { x: 2, y: 2 }] };
  const arrayAfter = { legs: [{ x: 9, y: 1 }, { x: 8, y: 2 }] };
  const ignoreIndexed = diffJson(arrayBefore, arrayAfter, { ignore: ['legs[0].x', 'legs.1.x'] });
  check(
    '忽略数组下标：两种写法都生效',
    ignoreIndexed.equal === true && ignoreIndexed.ignoredCount === 2,
    JSON.stringify(ignoreIndexed),
  );

  const ignoreWildcard = diffJson(arrayBefore, arrayAfter, { ignore: ['legs.*.x'] });
  check('忽略通配段：legs.*.x 命中两个下标', ignoreWildcard.equal === true && ignoreWildcard.ignoredCount === 2,
    JSON.stringify(ignoreWildcard));

  check('忽略白名单：未命中路径不影响判断', diffJson({ a: 1 }, { a: 2 }, { ignore: ['x.y'] }).equal === false);
}

// ---------- 4. CLI：退出码 0/1/2 与输出 ----------
{
  const tempDir = mkdtempSync(join(tmpdir(), 'drawinmap-diff-'));
  try {
    const sameA = join(tempDir, 'same-a.json');
    const sameB = join(tempDir, 'same-b.json');
    writeFileSync(sameA, JSON.stringify({ routeMeters: 1600, legs: [1, 2] }), 'utf8');
    writeFileSync(sameB, JSON.stringify({ legs: [1, 2], routeMeters: 1600 }), 'utf8');

    const diffB = join(tempDir, 'diff-b.json');
    writeFileSync(diffB, JSON.stringify({ routeMeters: 1601, legs: [1, 2] }), 'utf8');

    const ignoredB = join(tempDir, 'ignored-b.json');
    writeFileSync(ignoredB, JSON.stringify({ routeMeters: 1600, legs: [1, 3] }), 'utf8');

    const badJson = join(tempDir, 'bad.json');
    writeFileSync(badJson, '{ not json', 'utf8');

    /**
     * 跑一次 CLI，返回 {status, stdout, stderr}。
     *
     * @param {Array<string>} args 参数
     * @returns {{status: number|null, stdout: string, stderr: string}} 结果
     */
    const run = (args) => {
      const result = spawnSync(process.execPath, [TOOL, ...args], { cwd: ROOT, encoding: 'utf8' });
      return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    };

    const same = run([sameA, sameB]);
    check(
      'CLI：无差异 exit 0 且打印"等价"',
      same.status === 0 && same.stdout.includes('0 差异') && same.stdout.includes('等价'),
      `status=${same.status} stdout=${same.stdout.trim()}`,
    );

    const differ = run([sameA, diffB]);
    check(
      'CLI：有差异 exit 1 且打印差异路径',
      differ.status === 1 && differ.stdout.includes('[diff] routeMeters') && differ.stdout.includes('before=1600') &&
        differ.stdout.includes('after=1601'),
      `status=${differ.status} stdout=${differ.stdout.trim()}`,
    );

    const ignored = run([sameA, ignoredB, '--ignore=legs']);
    check(
      'CLI：--ignore 生效 exit 0',
      ignored.status === 0 && ignored.stdout.includes('跳过 1 处路径'),
      `status=${ignored.status} stdout=${ignored.stdout.trim()}`,
    );

    const ignoredComma = run([sameA, ignoredB, '--ignore=routeMeters,legs']);
    check('CLI：--ignore 逗号分隔多条', ignoredComma.status === 0, `status=${ignoredComma.status}`);

    const missing = run([join(tempDir, 'nope.json'), sameB]);
    check('CLI：文件不存在 exit 2', missing.status === 2, `status=${missing.status}`);

    const badArg = run([sameA]);
    check('CLI：参数不足 exit 2', badArg.status === 2, `status=${badArg.status}`);

    const broken = run([sameA, badJson]);
    check('CLI：非法 JSON exit 2', broken.status === 2, `status=${broken.status}`);

    const unknownFlag = run([sameA, sameB, '--bogus']);
    check('CLI：未知参数 exit 2', unknownFlag.status === 2, `status=${unknownFlag.status}`);

    const help = run(['--help']);
    check('CLI：--help exit 0 且打印用法', help.status === 0 && help.stdout.includes('用法'), `status=${help.status}`);

    // 参数解析本身（模块层）：重复 --ignore 累积
    const parsed = parseArgs(['a.json', 'b.json', '--ignore=x.y', '--ignore=z[0]', '--max-differences=3']);
    check(
      'parseArgs：重复 --ignore 累积且支持 --max-differences',
      parsed.positional.length === 2 &&
        JSON.stringify(parsed.ignore) === '["x.y","z[0]"]' &&
        parsed.maxDifferences === 3,
      JSON.stringify(parsed),
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

console.log(`\nRESULT: ${checks - failures}/${checks} 项通过，失败 ${failures} 项`);
if (failures > 0) {
  process.exitCode = 1;
}
