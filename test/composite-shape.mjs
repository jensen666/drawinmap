/**
 * 多对象复合目标（方案 2026-11-05 §4.2）单元测试。
 *
 * 用真实素材（马/狗/猫）验证：组合后的 multi-part 目标拓扑合法、
 * 各部分分离、共用同一坐标系且整体落在 [-0.5, 0.5] 内。
 *
 * 运行：node test/composite-shape.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { composeMultiPartShape, MAX_COMPOSITE_PARTS } from '../web/src/agent/composite-shape.js';
import { convertSvg } from '../web/src/reference/convert.js';
import { validateSimplePolygon, validateDisjointParts } from '../web/src/agent/shape-validate.js';

let failures = 0;
let checks = 0;
function check(label, condition, detail = '') {
  checks += 1;
  if (!condition) {
    failures += 1;
  }
  console.log(`[check] ${label} -> ${condition ? 'PASS' : `FAIL ${detail}`}`);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(root, 'web/data/shapes');
const manifest = JSON.parse(readFileSync(resolve(dataDir, 'manifest.json'), 'utf8'));

/** 取某个对象的转换后 T 点列 */
function targetOf(zhName) {
  const asset = manifest.assets.find((item) => item.names?.zh?.[0] === zhName);
  if (!asset) {
    throw new Error(`素材库没有「${zhName}」`);
  }
  const svg = readFileSync(resolve(dataDir, asset.file), 'utf8');
  const conversion = convertSvg(svg);
  return conversion.T.points;
}

const horse = targetOf('马');
const dog = targetOf('狗');
const cat = targetOf('猫');

// ---------- 基本组合 ----------
{
  const result = composeMultiPartShape([
    { name: '马', points: horse },
    { name: '狗', points: dog },
  ]);
  check('两对象组合成功', result.ok === true, result.reason ?? '');
  if (result.ok) {
    const shape = result.customShape;
    check('部分数 = 2', shape.parts.length === 2, String(shape.parts.length));
    check('部分名保留对象名', shape.parts.map((part) => part.name).join(',') === '马,狗', shape.parts.map((part) => part.name).join(','));
    check('有约束点（路线可贴）', shape.constraintPoints.length > 0, String(shape.constraintPoints.length));
    const xs = shape.outlinePoints.map((point) => point[0]);
    const ys = shape.outlinePoints.map((point) => point[1]);
    const spanX = Math.max(...xs) - Math.min(...xs);
    const spanY = Math.max(...ys) - Math.min(...ys);
    check(
      '整体轮廓在 [-0.5,0.5] 归一化框内',
      xs.every((x) => Math.abs(x) <= 0.5005) && ys.every((y) => Math.abs(y) <= 0.5005),
      `x[${Math.min(...xs)},${Math.max(...xs)}] y[${Math.min(...ys)},${Math.max(...ys)}]`,
    );
    check('整体最长边归一化到 1', Math.abs(Math.max(spanX, spanY) - 1) < 0.01, `${spanX}×${spanY}`);
    check('两轴跨度都达标（≥0.2）', spanX >= 0.2 && spanY >= 0.2, `${spanX}×${spanY}`);
  }
}

// ---------- 三/四个对象 ----------
{
  const three = composeMultiPartShape([
    { name: '马', points: horse },
    { name: '狗', points: dog },
    { name: '猫', points: cat },
  ]);
  check('三对象组合成功', three.ok === true, three.reason ?? '');
  if (three.ok) {
    check('三对象 → 3 个部分', three.customShape.parts.length === 3);
    const xs = three.customShape.outlinePoints.map((point) => point[0]);
    const ys = three.customShape.outlinePoints.map((point) => point[1]);
    check(
      '三对象组合仍在归一化框内',
      xs.every((x) => Math.abs(x) <= 0.5005) && ys.every((y) => Math.abs(y) <= 0.5005),
    );
  }
  const four = composeMultiPartShape([
    { name: '马', points: horse },
    { name: '狗', points: dog },
    { name: '猫', points: cat },
    { name: '猫2', points: cat },
  ]);
  check('四对象组合成功', four.ok === true, four.reason ?? '');
  if (four.ok) {
    check('四对象 → 4 个部分', four.customShape.parts.length === 4);
  }
}

// ---------- 拓扑：各部分必须是分离的简单闭环 ----------
{
  const result = composeMultiPartShape([
    { name: '马', points: horse },
    { name: '狗', points: dog },
  ]);
  if (result.ok) {
    const shape = result.customShape;
    const loops = shape.parts.map((part) =>
      shape.outlinePoints.slice(part.outlineStart, part.outlineStart + part.outlineCount),
    );
    check(
      '各部分是合法简单闭环',
      loops.every((loop) => validateSimplePolygon(loop).ok),
      JSON.stringify(loops.map((loop) => validateSimplePolygon(loop).reason)),
    );
    check(
      '各部分互不相交（分离部分）',
      validateDisjointParts(loops[0], loops[1]).ok,
      validateDisjointParts(loops[0], loops[1]).reason,
    );
  }
}

// ---------- 非法输入 ----------
{
  check('少于两个部分 → 失败', composeMultiPartShape([{ name: '马', points: horse }]).ok === false);
  const tooMany = composeMultiPartShape(
    Array.from({ length: MAX_COMPOSITE_PARTS + 1 }, (_, index) => ({ name: `x${index}`, points: cat })),
  );
  check('超过部分上限 → 失败', tooMany.ok === false, tooMany.reason);
  const degenerate = composeMultiPartShape([
    { name: '马', points: horse },
    { name: '线', points: [[0, 0], [0.5, 0], [1, 0]] },
  ]);
  check('退化部分 → 失败', degenerate.ok === false, degenerate.reason);
  const tooFew = composeMultiPartShape([
    { name: '马', points: horse },
    { name: '点', points: [[0, 0]] },
  ]);
  check('点数不足的部分 → 失败', tooFew.ok === false, tooFew.reason);
}

if (failures > 0) {
  console.error(`\nFAILED: ${failures}/${checks} 项未通过`);
  process.exitCode = 1;
} else {
  console.log(`\nPASS: composite-shape 全部断言通过（${checks} 项）`);
}
