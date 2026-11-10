/**
 * 参考图模块：SVG 解析 / 轮廓分类 / 归一化 单元测试（Node 直接运行，无网络）。
 *
 * 运行：node test/reference-svg.mjs
 */

import { parseSvgDocument } from '../web/src/reference/svg-document.js';
import { parsePathData } from '../web/src/reference/path-data.js';
import { classifyRings } from '../web/src/reference/rings.js';
import { convertSvg } from '../web/src/reference/convert.js';
import { normalizeClosedRing } from '../web/src/reference/geometry.js';
import { parseTransform, multiply, applyMatrix } from '../web/src/reference/svg-transform.js';

let failures = 0;

/** 断言工具：记录并通过/失败计数 */
function check(label, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`[check] ${label} -> ${ok ? 'PASS' : `FAIL ${detail}`}`);
}

/** 包一层 SVG */
function svg(inner, viewBox = '0 0 100 100') {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${inner}</svg>`;
}

/** 近似相等 */
function near(a, b, tolerance = 1e-6) {
  return Math.abs(a - b) <= tolerance;
}

// ---------- path 解析 ----------
const square = parsePathData('M 0 0 L 10 0 L 10 10 L 0 10 Z');
check('path：方形解析出 1 个子路径', square.subpaths.length === 1);
check('path：方形 4 个点', square.subpaths[0].points.length === 4);
check('path：Z 闭合', square.subpaths[0].closed === true);

const implicit = parsePathData('M 0 0 10 0 10 10 0 10 Z');
check('path：M 后隐式 lineto', implicit.subpaths[0].points.length === 4);

const relative = parsePathData('m 0 0 l 10 0 l 0 10 l -10 0 z');
check('path：相对命令闭合', relative.subpaths[0].closed === true);
check('path：相对命令终点回到原点', near(relative.subpaths[0].points[0][0], 0) && near(relative.subpaths[0].points[0][1], 0));

const cubic = parsePathData('M 0 0 C 0 10 10 10 10 0 Z');
check('path：三次贝塞尔加密采样', cubic.subpaths[0].points.length > 6);
check('path：三次贝塞尔包围盒高度约 7.5', near(
  Math.max(...cubic.subpaths[0].points.map((point) => point[1])),
  7.5,
  0.2,
));

const quadratic = parsePathData('M 0 0 Q 5 10 10 0 Z');
check('path：二次贝塞尔采样', quadratic.subpaths[0].points.length > 5);

const arc = parsePathData('M 0 0 A 5 5 0 0 1 10 0 Z');
check('path：圆弧采样', arc.subpaths[0].points.length > 6);
// SVG 是 y 向下坐标系，sweep=1 从左到右画上半圆 → y 为负
check('path：圆弧包围盒高度约 5', near(Math.max(...arc.subpaths[0].points.map((point) => -point[1])), 5, 0.3));

const open = parsePathData('M 0 0 L 10 0 L 10 10 L 0 10');
check('path：无 Z 且首尾不重合 → 未闭合', open.subpaths[0].closed === false);
const closedByRepeat = parsePathData('M 0 0 L 10 0 L 10 10 L 0 10 L 0 0');
check('path：首尾重合但无 Z → 视为闭合', closedByRepeat.subpaths[0].closed === true);
check('path：首尾重合时去掉重复尾点', closedByRepeat.subpaths[0].points.length === 4);

// ---------- transform ----------
const translateScale = multiply(parseTransform('translate(10 20)'), parseTransform('scale(2)'));
const transformed = applyMatrix(translateScale, [5, 5]);
check('transform：translate + scale 顺序正确', near(transformed[0], 20) && near(transformed[1], 30));

const documentWithTransform = parseSvgDocument(
  svg('<g transform="translate(10 20) scale(2)"><path d="M 0 0 L 5 0 L 5 5 L 0 5 Z" /></g>'),
);
const transformedPoints = documentWithTransform.subpaths[0].points;
check('transform：g 变换应用到 path', near(transformedPoints[0][0], 10) && near(transformedPoints[0][1], 20));
check('transform：缩放后右上角坐标', near(transformedPoints[2][0], 20) && near(transformedPoints[2][1], 30));

// ---------- polygon / 基本形状 ----------
const polygonDocument = parseSvgDocument(svg('<polygon points="0,0 10,0 10,10 0,10" />'));
check('polygon：解析为闭合子路径', polygonDocument.subpaths.length === 1 && polygonDocument.subpaths[0].closed);
check('polygon：4 个点', polygonDocument.subpaths[0].points.length === 4);

// ---------- 环分类 ----------
const withHole = parseSvgDocument(
  svg('<path d="M 0 0 L 100 0 L 100 100 L 0 100 Z M 40 40 L 60 40 L 60 60 L 40 60 Z" />'),
);
const holeClass = classifyRings(withHole.subpaths);
check('环分类：主环 + 1 个孔洞', Boolean(holeClass.main) && holeClass.holes.length === 1);
check('环分类：孔洞深度为 1', holeClass.holes[0].depth === 1);

const twoSquares = parseSvgDocument(
  svg('<path d="M 0 0 L 20 0 L 20 20 L 0 20 Z M 40 0 L 60 0 L 60 20 L 40 20 Z" />'),
);
const twoClass = classifyRings(twoSquares.subpaths);
check('环分类：两个独立外环 → 1 个主环 + 1 个部分', Boolean(twoClass.main) && twoClass.parts.length === 1);

// ---------- 归一化 ----------
const rectTarget = normalizeClosedRing([
  [0, 0],
  [100, 0],
  [100, 50],
  [0, 50],
]);
const rectBox = rectTarget.points.reduce(
  (acc, [x, y]) => ({
    minX: Math.min(acc.minX, x),
    maxX: Math.max(acc.maxX, x),
    minY: Math.min(acc.minY, y),
    maxY: Math.max(acc.maxY, y),
  }),
  { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity },
);
check('归一化：x 跨度为 1', near(rectBox.maxX - rectBox.minX, 1));
check('归一化：y 跨度为 0.5', near(rectBox.maxY - rectBox.minY, 0.5));
check('归一化：包围盒居中', near(rectBox.minX + rectBox.maxX, 0) && near(rectBox.minY + rectBox.maxY, 0));
check('归一化：宽高比 0.5', near(rectTarget.aspect, 0.5));

// ---------- convertSvg 行为 ----------
const accepted = convertSvg(svg('<path d="M 0 0 L 100 0 L 100 60 L 0 60 Z" />'));
check('转换：简单矩形通过', accepted.status === 'accepted');
check('转换：目标点数不超过 512', accepted.T.pointCount <= 512);
check('转换：目标轮廓在 [-0.5, 0.5]', accepted.T.points.every(([x, y]) => Math.abs(x) <= 0.500001 && Math.abs(y) <= 0.500001));
check('转换：宽高比 0.6', near(accepted.T.aspect, 0.6, 0.01));

const holeAccepted = convertSvg(
  svg('<path d="M 0 0 L 100 0 L 100 100 L 0 100 Z M 40 40 L 60 40 L 60 60 L 40 60 Z" />'),
);
check('转换：小孔洞被忽略且通过', holeAccepted.status === 'accepted' && holeAccepted.warnings.some((warning) => warning.includes('孔洞')));

const holeRejected = convertSvg(
  svg('<path d="M 0 0 L 100 0 L 100 100 L 0 100 Z M 25 25 L 75 25 L 75 75 L 25 75 Z" />'),
);
check('转换：过大孔洞被拒绝', holeRejected.status === 'rejected' && holeRejected.reasons.some((reason) => reason.code === 'holes-too-large'));

const multiPart = convertSvg(
  svg('<path d="M 0 0 L 20 0 L 20 20 L 0 20 Z M 40 0 L 60 0 L 60 20 L 40 20 Z" />'),
);
check('转换：多部分被拒绝', multiPart.status === 'rejected' && multiPart.reasons.some((reason) => reason.code === 'multi-part'));

const stray = convertSvg(
  svg('<path d="M 0 0 L 100 0 L 100 100 L 0 100 Z M 150 150 L 151 150 L 151 151 L 150 151 Z" />'),
);
check('转换：小杂散被忽略且通过', stray.status === 'accepted' && stray.warnings.some((warning) => warning.includes('杂散')));

const fragmented = convertSvg(
  svg(
    '<path d="M 0 0 L 100 0 L 100 100 L 0 100 Z' +
      Array.from({ length: 10 }, (_, index) => {
        const x = 150 + index * 4;
        const y = 150;
        return ` M ${x} ${y} L ${x + 1} ${y} L ${x + 1} ${y + 1} L ${x} ${y + 1} Z`;
      }).join('') +
      '" />',
  ),
);
check(
  '转换：过多杂散路径被拒绝',
  fragmented.status === 'rejected' && fragmented.reasons.some((reason) => reason.code === 'fragmented-paths'),
  JSON.stringify(fragmented.reasons),
);

const unclosed = convertSvg(svg('<path d="M 0 0 L 100 0 L 100 100 L 0 100" />'));
check('转换：未闭合主轮廓被拒绝', unclosed.status === 'rejected' && unclosed.reasons.some((reason) => reason.code === 'unclosed-contour'));
check('转换：拒绝时不输出 T', unclosed.T === null);

const pentagram = Array.from({ length: 5 }, (_, index) => {
  const angle = ((-90 + index * 144) * Math.PI) / 180;
  return [50 + 45 * Math.cos(angle), 50 + 45 * Math.sin(angle)];
});
const pentagramPath = pentagram.map(([x, y], index) => `${index === 0 ? 'M' : 'L'} ${x.toFixed(3)} ${y.toFixed(3)}`).join(' ');
const selfIntersect = convertSvg(svg(`<path d="${pentagramPath} Z" />`));
check(
  '转换：自交轮廓被拒绝',
  selfIntersect.status === 'rejected' && selfIntersect.reasons.some((reason) => reason.code === 'topology'),
  JSON.stringify(selfIntersect.reasons),
);

const empty = convertSvg(svg('<rect width="0" height="0" />'));
check('转换：无几何 → 明确拒绝', empty.status === 'rejected' && empty.reasons.some((reason) => reason.code === 'no-outer-contour'));

// ---------- 汇总 ----------
if (failures > 0) {
  console.error(`\nFAILED: ${failures} 项未通过`);
  process.exitCode = 1;
} else {
  console.log('\nPASS: reference-svg 全部断言通过');
}
