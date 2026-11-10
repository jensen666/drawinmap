/**
 * 自定义图形拓扑校验与整体归一化测试（Node 直接运行，不依赖浏览器与网络）。
 *
 * 覆盖：
 * - validateSimplePolygon：合法三角形 / 自交（蝴蝶结）/ 非相邻重复点 / 退化面积
 * - validateDisjointParts：分离部分 / 边相交 / 嵌套（孔洞）
 * - normalizeCustomShape：整体居中 + 等比归一化（包围盒中心在原点、最长边为 1）
 * - 非法拓扑进入 normalizeCustomShape 一律返回 null（不静默按岛处理）
 *
 * 运行：node test/shape-topology.mjs
 */

import { normalizeCustomShape } from '../web/src/agent/intent.js';
import {
  polygonArea,
  validateDisjointParts,
  validateSimplePolygon,
} from '../web/src/agent/shape-validate.js';

let failures = 0;

/** 断言工具：记录并通过/失败计数 */
function check(label, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) {
    failures += 1;
  }
  console.log(`[check] ${label} -> ${ok ? 'PASS' : `FAIL ${detail}`}`);
}

/** 包围盒（归一化坐标） */
function boundsOf(points) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return {
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
    spanX: maxX - minX,
    spanY: maxY - minY,
    longest: Math.max(maxX - minX, maxY - minY),
  };
}

// ---------- validateSimplePolygon ----------
const triangle = [
  [0, 0],
  [0.4, 0],
  [0.2, 0.35],
];
check('简单多边形：三角形合法', validateSimplePolygon(triangle).ok);
check('简单多边形：面积 > 0', polygonArea(triangle) > 0.05);

// 蝴蝶结：两条边交叉
const bowtie = [
  [0, 0],
  [0.4, 0.4],
  [0.4, 0],
  [0, 0.4],
];
check('自交：蝴蝶结被拒绝', !validateSimplePolygon(bowtie).ok);

// 非相邻重复点
const repeated = [
  [0, 0],
  [0.4, 0],
  [0.4, 0.4],
  [0, 0],
  [0, 0.4],
];
check('重复点：非相邻点重合被拒绝', !validateSimplePolygon(repeated).ok);

// 退化面积（几乎一条线）
const degenerate = [
  [0, 0],
  [0.4, 0],
  [0.2, 0.0001],
];
check('退化：面积过小被拒绝', !validateSimplePolygon(degenerate).ok);

// ---------- validateDisjointParts ----------
const left = [
  [-0.45, -0.1],
  [-0.25, -0.1],
  [-0.35, 0.1],
];
const right = [
  [0.25, -0.1],
  [0.45, -0.1],
  [0.35, 0.1],
];
check('分离部分：互不相交合法', validateDisjointParts(left, right).ok);

const crossing = [
  [-0.4, -0.15],
  [-0.2, -0.15],
  [-0.3, 0.15],
];
check('部分相交：边交叉被拒绝', !validateDisjointParts(left, crossing).ok);

const inner = [
  [-0.38, -0.02],
  [-0.32, -0.02],
  [-0.35, 0.02],
];
check('部分嵌套：小环在外环内被拒绝（当前不支持孔洞）', !validateDisjointParts(left, inner).ok);

// ---------- normalizeCustomShape：整体居中 + 等比归一化 ----------
// 偏在右上角、跨度 0.36 的三角形（历史实测失真输入：中心 [0.25,0.15]、跨度 0.36）
const offCenter = normalizeCustomShape({
  name: '偏心三角',
  points: [
    [0.07, 0.07],
    [0.43, 0.07],
    [0.25, 0.43],
  ],
});
check('归一化：偏心图形被接受', offCenter !== null);
if (offCenter) {
  const b = boundsOf(offCenter.outlinePoints);
  check('归一化：包围盒中心移到原点', Math.abs(b.centerX) < 1e-9 && Math.abs(b.centerY) < 1e-9,
    `center=${b.centerX.toFixed(6)},${b.centerY.toFixed(6)}`);
  check('归一化：最长边缩放到 1', Math.abs(b.longest - 1) < 1e-9, `longest=${b.longest}`);
  const cb = boundsOf(offCenter.constraintPoints);
  check('归一化：约束点与轮廓同步变换', Math.abs(cb.centerX) < 1e-9 && Math.abs(cb.centerY) < 1e-9);
  check('归一化：点全部落在 [-0.5,0.5]',
    offCenter.outlinePoints.every(([x, y]) => Math.abs(x) <= 0.500001 && Math.abs(y) <= 0.500001));
}

// 多部分：整体归一化保持部分间相对位置（两圆间距按同一比例缩放）
// 圆半径 0.125、圆心 ±0.3 → 整体 y 跨度 0.25（满足整体跨度下限 0.2）
const circlePoints = [];
for (let i = 0; i < 12; i += 1) {
  const angle = (i / 12) * Math.PI * 2;
  circlePoints.push([Math.cos(angle) * 0.25, Math.sin(angle) * 0.25]);
}
const multi = normalizeCustomShape({
  name: '双环',
  parts: [
    { name: '左', points: circlePoints.map(([x, y]) => [x * 0.5 - 0.3, y * 0.5]) },
    { name: '右', points: circlePoints.map(([x, y]) => [x * 0.5 + 0.3, y * 0.5]) },
  ],
});
check('归一化：多部分图形被接受', multi !== null);
if (multi) {
  const b = boundsOf(multi.outlinePoints);
  check('归一化：多部分包围盒中心在原点', Math.abs(b.centerX) < 1e-9 && Math.abs(b.centerY) < 1e-9);
  check('归一化：多部分最长边为 1', Math.abs(b.longest - 1) < 1e-9, `longest=${b.longest}`);
  const part0 = multi.outlinePoints.slice(0, multi.parts[0].outlineCount);
  const part1 = multi.outlinePoints.slice(
    multi.parts[1].outlineStart,
    multi.parts[1].outlineStart + multi.parts[1].outlineCount,
  );
  const c0 = boundsOf(part0);
  const c1 = boundsOf(part1);
  check('归一化：两部分关于原点对称（相对位置保持）',
    Math.abs(c0.centerX + c1.centerX) < 1e-6 && Math.abs(c0.centerY + c1.centerY) < 1e-6);
}

// ---------- 非法拓扑进入 normalizeCustomShape 一律 null ----------
check(
  '非法拓扑：自交轮廓返回 null',
  normalizeCustomShape({
    name: '蝴蝶结',
    points: [[-0.4, -0.4], [0.4, 0.4], [0.4, -0.4], [-0.4, 0.4]],
  }) === null,
);
check(
  '非法拓扑：部分相交返回 null',
  normalizeCustomShape({
    name: '相交双环',
    parts: [
      { points: [[-0.5, -0.1], [-0.2, -0.1], [-0.35, 0.2]] },
      { points: [[-0.35, -0.1], [-0.05, -0.1], [-0.2, 0.2]] },
    ],
  }) === null,
);
check(
  '非法拓扑：部分嵌套返回 null',
  normalizeCustomShape({
    name: '嵌套',
    parts: [
      { points: [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]] },
      { points: [[-0.1, -0.1], [0.1, -0.1], [0.1, 0.1], [-0.1, 0.1]] },
    ],
  }) === null,
);

process.exit(failures === 0 ? 0 : 2);
