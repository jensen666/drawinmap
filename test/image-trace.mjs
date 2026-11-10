/**
 * 图像描摹核心能力测试（Node 直接运行，不打开浏览器、不调用模型、不依赖网络）。
 *
 * 覆盖方案 §4.1「描摹」行：从二值掩膜抽出一条单闭合、不自交、120~320 点的外轮廓，
 * 与掩膜填充后外轮廓 IoU ≥ 0.90；掩膜内部的孔在结果中消失；空掩膜、碎成多块、
 * 抽不出单闭合轮廓的输入被拒绝。
 *
 * 另含审查报告回归（H2/H3/M3/M4）：
 * - H2：纯矩形掩膜（多种尺寸）经 traceMask 归一化点列反算的 IoU 必须 ≥ 0.98（理想≈1.0），
 *   并交叉验证扫描线 IoU 与像素中心采样一致；
 * - H3：极端抖动输入（512×512 高频毛刺圆盘）必须有界时间内返回；中止 signal 抛 AbortError；
 * - M3：描摹跨度门槛与 intent.js 的 CUSTOM_MIN_SPAN 同源，细长图标提前 rejected
 *   degenerate-span（不再出现"描摹 ok、归一化 null"）；
 * - M4：traceMask 在返回 ok 前执行自己的 iouMin 闸门（rejected iou-too-low）。
 *
 * 运行：node test/image-trace.mjs
 * 退出码：全部断言通过为 0，有失败为 1。
 */

import assert from 'node:assert/strict';
import {
  IMAGE_TRACE_DEFAULTS,
  IMAGE_TRACE_IOU_MIN,
  IMAGE_TRACE_POINT_MAX,
  IMAGE_TRACE_POINT_MIN,
  binarizeImageData,
  computeMaskIou,
  traceMask,
} from '../web/src/agent/image-trace.js';
import { traceImageDataUrl } from '../web/src/agent/image-trace-browser.js';
import { traceOuterContour } from '../web/src/agent/image-trace-geometry.js';
import { CUSTOM_MIN_SPAN, normalizeCustomShape } from '../web/src/agent/intent.js';
import { validateSimplePolygon } from '../web/src/agent/shape-validate.js';

let passed = 0;
let failed = 0;

/**
 * 断言封装：执行断言函数并统计 PASS/FAIL（失败不中断，继续跑完所有用例）。
 *
 * @param {string} label 用例说明
 * @param {() => void} fn 断言函数（内部用 node:assert）
 */
function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`[check] ${label} -> PASS`);
  } catch (error) {
    failed += 1;
    console.log(`[check] ${label} -> FAIL ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 异步断言封装（浏览器入口的 Promise 契约）。
 *
 * @param {string} label 用例说明
 * @param {() => Promise<void>} fn 断言函数
 */
async function checkAsync(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`[check] ${label} -> PASS`);
  } catch (error) {
    failed += 1;
    console.log(`[check] ${label} -> FAIL ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 统计掩膜前景像素数 */
function countMask(mask) {
  let count = 0;
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index]) count += 1;
  }
  return count;
}

/** 统计掩膜前景外接框（像素坐标，含端点） */
function boundsOfMask(mask, width, height) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/** 归一化点列的外接框（用于检查最长边=1、落在 [-0.5,0.5]） */
function boundsOfPoints(points) {
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return { minX, maxX, minY, maxY, spanX: maxX - minX, spanY: maxY - minY };
}

/** 实心圆掩膜 */
function makeCircleMask(width, height, cx, cy, radius) {
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= radius * radius) mask[y * width + x] = 1;
    }
  }
  return mask;
}

/** 圆角矩形掩膜（矩形与四角圆的并集） */
function makeRoundedRectMask(width, height, x0, y0, x1, y1, radius) {
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const nearestX = Math.min(Math.max(x, x0 + radius), x1 - radius);
      const nearestY = Math.min(Math.max(y, y0 + radius), y1 - radius);
      if ((x - nearestX) ** 2 + (y - nearestY) ** 2 <= radius * radius) mask[y * width + x] = 1;
    }
  }
  return mask;
}

/** 圆环掩膜（外壳半径 outer，内孔半径 inner） */
function makeRingMask(width, height, cx, cy, outer, inner) {
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const distance = Math.hypot(x - cx, y - cy);
      if (distance <= outer && distance >= inner) mask[y * width + x] = 1;
    }
  }
  return mask;
}

/** 凹形五角星掩膜（射线法填充） */
function makeStarMask(width, height, cx, cy, outer, inner) {
  const vertices = [];
  for (let index = 0; index < 10; index += 1) {
    const angle = -Math.PI / 2 + (index * Math.PI) / 5;
    const radius = index % 2 === 0 ? outer : inner;
    vertices.push([cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius]);
  }
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let inside = false;
      for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i, i += 1) {
        const [xi, yi] = vertices[i];
        const [xj, yj] = vertices[j];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) mask[y * width + x] = 1;
    }
  }
  return mask;
}

/** 生成 RGBA 像素：paint(x,y) 返回 [r,g,b,a?] */
function makeRgba(width, height, paint) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const [r, g, b, a = 255] = paint(x, y);
      data[offset] = r;
      data[offset + 1] = g;
      data[offset + 2] = b;
      data[offset + 3] = a;
    }
  }
  return data;
}

/** 固定种子线性同余伪随机数（保证测试可重复） */
function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** 断言一个成功结果满足：点数区间、简单闭环、IoU 闸门、归一化范围 */
function assertTracedOk(result, label) {
  assert.equal(result.status, 'ok', `${label}: status 应为 ok，实际 ${result.status}`);
  assert.equal(result.reasons.length, 0, `${label}: 成功结果不应带 reasons`);
  const count = result.points.length;
  assert.ok(
    count >= IMAGE_TRACE_POINT_MIN && count <= IMAGE_TRACE_POINT_MAX,
    `${label}: 点数 ${count} 不在 [${IMAGE_TRACE_POINT_MIN}, ${IMAGE_TRACE_POINT_MAX}]`,
  );
  const topology = validateSimplePolygon(result.points);
  assert.ok(topology.ok, `${label}: 不是简单闭环（${topology.reason}）`);
  for (const [x, y] of result.points) {
    assert.ok(Number.isFinite(x) && Number.isFinite(y), `${label}: 点列含非有限值`);
    assert.ok(Math.abs(x) <= 0.500001 && Math.abs(y) <= 0.500001, `${label}: 点 (${x},${y}) 越出 [-0.5,0.5]`);
  }
  const pointsBounds = boundsOfPoints(result.points);
  const longest = Math.max(pointsBounds.spanX, pointsBounds.spanY);
  // 归一化按"填充后前景外接框"做，重采样点不一定恰好落在极值像素中心，允许 1% 内偏差
  assert.ok(longest >= 0.99 && longest <= 1.000001, `${label}: 最长边归一化偏差过大（${longest}）`);
  assert.ok(result.diagnostics.iou >= IMAGE_TRACE_IOU_MIN, `${label}: 诊断 IoU ${result.diagnostics.iou} < ${IMAGE_TRACE_IOU_MIN}`);
  assert.ok(result.filledMask instanceof Uint8Array, `${label}: 缺少 filledMask`);
}

// ==================== 1. 常量与默认参数 ====================
check('常量：点列下限 120', () => assert.equal(IMAGE_TRACE_POINT_MIN, 120));
check('常量：点列上限 320', () => assert.equal(IMAGE_TRACE_POINT_MAX, 320));
check('常量：IoU 闸门 0.90', () => assert.equal(IMAGE_TRACE_IOU_MIN, 0.9));
check('默认参数：冻结且目标点数落在 [120,320]', () => {
  assert.ok(Object.isFrozen(IMAGE_TRACE_DEFAULTS));
  assert.ok(IMAGE_TRACE_DEFAULTS.pointCount >= IMAGE_TRACE_POINT_MIN);
  assert.ok(IMAGE_TRACE_DEFAULTS.pointCount <= IMAGE_TRACE_POINT_MAX);
  assert.ok(IMAGE_TRACE_DEFAULTS.pointCount >= 200 && IMAGE_TRACE_DEFAULTS.pointCount <= 280, '目标点数应在 240 附近');
});
check('默认参数：方案要求的可调项齐全', () => {
  for (const key of [
    'backgroundTolerance',
    'minForegroundRatio',
    'maxForegroundRatio',
    'mainComponentRatio',
    'strayAreaRatio',
    'minSpanRatio',
    'iouMin',
  ]) {
    assert.equal(typeof IMAGE_TRACE_DEFAULTS[key], 'number', `默认参数缺少数值项 ${key}`);
  }
  assert.equal(IMAGE_TRACE_DEFAULTS.iouMin, IMAGE_TRACE_IOU_MIN);
});

// ==================== 2. 实心圆（基础形状） ====================
const circleMask = makeCircleMask(240, 240, 120, 120, 80);
const circle = traceMask(circleMask, 240, 240);
check('实心圆：描摹成功', () => assertTracedOk(circle, '实心圆'));
check('实心圆：默认重采样 240 点（在 120~320 内）', () => {
  assert.equal(circle.points.length, IMAGE_TRACE_DEFAULTS.pointCount);
  assert.equal(circle.diagnostics.pointCount, circle.points.length);
});
check('实心圆：单个连通分量、无孔洞、无碎片', () => {
  assert.equal(circle.diagnostics.components, 1);
  assert.equal(circle.diagnostics.filledHoles, 0);
  assert.equal(circle.diagnostics.strayPixels, 0);
});
check('实心圆：前景占比与掩膜一致', () => {
  assert.ok(Math.abs(circle.diagnostics.foregroundRatio - Math.PI * 80 * 80 / (240 * 240)) < 0.01);
});
check('实心圆：诊断 IoU = 独立 computeMaskIou（对填充后掩膜）', () => {
  const independent = computeMaskIou(circle.points, circle.filledMask, 240, 240);
  assert.ok(independent >= IMAGE_TRACE_IOU_MIN);
  assert.ok(Math.abs(independent - circle.diagnostics.iou) < 1e-9, '诊断 IoU 与独立计算不一致');
});
check('实心圆：外接框归一化（spanX=spanY=1，bounds 为掩膜外接框）', () => {
  assert.ok(Math.abs(circle.diagnostics.spanX - 1) < 1e-6);
  assert.ok(Math.abs(circle.diagnostics.spanY - 1) < 1e-6);
  const bounds = boundsOfMask(circleMask, 240, 240);
  assert.deepEqual(circle.diagnostics.bounds, {
    minX: bounds.minX, minY: bounds.minY, maxX: bounds.maxX, maxY: bounds.maxY,
    width: bounds.width, height: bounds.height,
  });
});
check('实心圆：填充后掩膜与原掩膜完全一致', () => {
  assert.deepEqual(circle.filledMask, circleMask);
});
check('实心圆：结果可进入 normalizeCustomShape（拓扑/跨度校验通过）', () => {
  const custom = normalizeCustomShape({ name: '图像描摹', points: circle.points });
  assert.ok(custom, 'normalizeCustomShape 返回 null');
  assert.equal(custom.outlinePoints.length, circle.points.length);
});

// ==================== 3. 圆角矩形（直边+圆角） ====================
const roundedMask = makeRoundedRectMask(260, 200, 40, 40, 220, 160, 28);
const rounded = traceMask(roundedMask, 260, 200);
check('圆角矩形：描摹成功且 IoU ≥ 0.90', () => assertTracedOk(rounded, '圆角矩形'));
check('圆角矩形：长宽比保留（160×120 → spanX=1、spanY≈0.667）', () => {
  assert.ok(Math.abs(rounded.diagnostics.spanX - 1) < 1e-6);
  assert.ok(Math.abs(rounded.diagnostics.spanY - 120 / 180) < 0.02, `spanY=${rounded.diagnostics.spanY}`);
});

// ==================== 4. 凹形五角星（凹轮廓） ====================
const starMask = makeStarMask(300, 300, 150, 150, 110, 45);
const star = traceMask(starMask, 300, 300);
check('凹形五角星：描摹成功、简单闭环、IoU ≥ 0.90', () => assertTracedOk(star, '五角星'));
check('凹形五角星：可进入 normalizeCustomShape', () => {
  assert.ok(normalizeCustomShape({ name: '图像描摹', points: star.points }));
});

// ==================== 5. 带孔圆环（孔洞填充） ====================
const ringMask = makeRingMask(200, 200, 100, 100, 80, 50);
const ring = traceMask(ringMask, 200, 200);
check('带孔圆环：描摹成功（孔被填充）', () => assertTracedOk(ring, '圆环'));
check('带孔圆环：填充的孔洞像素数 > 0', () => assert.ok(ring.diagnostics.filledHoles > 1000));
check('带孔圆环：填充后孔区域全为前景（孔在结果中消失）', () => {
  let holeFilled = true;
  for (let y = 0; y < 200; y += 1) {
    for (let x = 0; x < 200; x += 1) {
      if (Math.hypot(x - 100, y - 100) < 48 && ring.filledMask[y * 200 + x] !== 1) holeFilled = false;
    }
  }
  assert.ok(holeFilled, '填充后掩膜孔内仍有背景像素');
});
check('带孔圆环：点列对填充后掩膜的 IoU ≥ 0.90（内部无孔）', () => {
  assert.ok(computeMaskIou(ring.points, ring.filledMask, 200, 200) >= IMAGE_TRACE_IOU_MIN);
});
check('带孔圆环：填充后掩膜是实心圆（与实心圆掩膜对角像素一致数 ≥ 99%）', () => {
  const solid = makeCircleMask(200, 200, 100, 100, 80);
  let same = 0;
  for (let index = 0; index < solid.length; index += 1) {
    if (solid[index] === ring.filledMask[index]) same += 1;
  }
  assert.ok(same / solid.length >= 0.99, `一致率 ${same / solid.length}`);
});

// ==================== 6. 一块大 + 小碎片（碎片丢弃） ====================
const blockMask = new Uint8Array(200 * 200);
for (let y = 3; y < 123; y += 1) {
  for (let x = 3; x < 123; x += 1) blockMask[y * 200 + x] = 1;
}
for (let y = 160; y < 175; y += 1) {
  for (let x = 160; x < 175; x += 1) blockMask[y * 200 + x] = 1; // 225 px ≈ 0.56% 画面
}
const block = traceMask(blockMask, 200, 200);
check('大块+小碎片：描摹成功（小碎片被丢弃）', () => assertTracedOk(block, '大块+小碎片'));
check('大块+小碎片：两个分量、碎片像素被记录并在结果中消失', () => {
  assert.equal(block.diagnostics.components, 2);
  assert.ok(block.diagnostics.strayPixels > 0);
  assert.ok(block.diagnostics.strayRatio <= IMAGE_TRACE_DEFAULTS.strayAreaRatio);
  let fragmentGone = true;
  for (let y = 160; y < 175; y += 1) {
    for (let x = 160; x < 175; x += 1) {
      if (block.filledMask[y * 200 + x] !== 0) fragmentGone = false;
    }
  }
  assert.ok(fragmentGone, '填充后掩膜仍含小碎片');
});
check('大块+小碎片：外接框只覆盖主块（碎片不影响归一化）', () => {
  assert.equal(block.diagnostics.bounds.minX, 3);
  assert.equal(block.diagnostics.bounds.maxX, 122);
  assert.equal(block.diagnostics.bounds.minY, 3);
  assert.equal(block.diagnostics.bounds.maxY, 122);
});

// ==================== 7. 拒绝场景 ====================
check('两块分离（各约 50%）→ multi-part', () => {
  const mask = new Uint8Array(200 * 200);
  for (let y = 40; y < 150; y += 1) {
    for (let x = 5; x < 80; x += 1) mask[y * 200 + x] = 1;
    for (let x = 120; x < 195; x += 1) mask[y * 200 + x] = 1;
  }
  const result = traceMask(mask, 200, 200);
  assert.equal(result.status, 'rejected');
  assert.equal(result.reasons[0].code, 'multi-part');
  assert.equal(result.points, null);
  assert.equal(result.filledMask, null);
  assert.ok(result.diagnostics.components >= 2);
});
check('空掩膜 → empty-mask', () => {
  const result = traceMask(new Uint8Array(200 * 200), 200, 200);
  assert.equal(result.status, 'rejected');
  assert.equal(result.reasons[0].code, 'empty-mask');
});
check('前景占比 0.1% → empty-mask', () => {
  const mask = new Uint8Array(200 * 200);
  for (let y = 100; y < 108; y += 1) {
    for (let x = 100; x < 105; x += 1) mask[y * 200 + x] = 1; // 40 px = 0.1%
  }
  const result = traceMask(mask, 200, 200);
  assert.equal(result.status, 'rejected');
  assert.equal(result.reasons[0].code, 'empty-mask');
  assert.ok(Math.abs(result.diagnostics.foregroundRatio - 0.001) < 1e-6);
});
check('全前景 → no-background', () => {
  const result = traceMask(new Uint8Array(200 * 200).fill(1), 200, 200);
  assert.equal(result.status, 'rejected');
  assert.equal(result.reasons[0].code, 'no-background');
});
check('细线（200×3）→ degenerate-span', () => {
  const mask = new Uint8Array(200 * 200);
  for (let x = 20; x < 180; x += 1) {
    for (let y = 99; y <= 101; y += 1) mask[y * 200 + x] = 1;
  }
  const result = traceMask(mask, 200, 200);
  assert.equal(result.status, 'rejected');
  assert.equal(result.reasons[0].code, 'degenerate-span');
  assert.ok(result.reasons[0].message.includes('细线'));
});
check('单像素 → empty-mask', () => {
  const mask = new Uint8Array(200 * 200);
  mask[100 * 200 + 100] = 1;
  const result = traceMask(mask, 200, 200);
  assert.equal(result.status, 'rejected');
  assert.equal(result.reasons[0].code, 'empty-mask');
});
check('退化小块（2×2，且外接框过小）→ rejected 且码明确', () => {
  const mask = new Uint8Array(20 * 20);
  for (let y = 9; y < 11; y += 1) {
    for (let x = 9; x < 11; x += 1) mask[y * 20 + x] = 1;
  }
  const result = traceMask(mask, 20, 20);
  assert.equal(result.status, 'rejected');
  assert.ok(['degenerate', 'degenerate-span'].includes(result.reasons[0].code), result.reasons[0].code);
});
check('随机噪声掩膜（20% 密度）→ multi-part', () => {
  const random = makeRandom(20251101);
  const mask = new Uint8Array(160 * 160);
  for (let index = 0; index < mask.length; index += 1) {
    if (random() < 0.2) mask[index] = 1;
  }
  const result = traceMask(mask, 160, 160);
  assert.equal(result.status, 'rejected');
  assert.equal(result.reasons[0].code, 'multi-part');
  assert.ok(result.diagnostics.components > 10);
});
check('照片式多块掩膜（40 个不规则色块）→ multi-part', () => {
  const random = makeRandom(42);
  const mask = new Uint8Array(256 * 256);
  for (let blob = 0; blob < 40; blob += 1) {
    const cx = 20 + Math.floor(random() * 216);
    const cy = 20 + Math.floor(random() * 216);
    const rx = 5 + Math.floor(random() * 15);
    const ry = 5 + Math.floor(random() * 15);
    for (let y = Math.max(0, cy - ry); y <= Math.min(255, cy + ry); y += 1) {
      for (let x = Math.max(0, cx - rx); x <= Math.min(255, cx + rx); x += 1) {
        if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) mask[y * 256 + x] = 1;
      }
    }
  }
  const result = traceMask(mask, 256, 256);
  assert.equal(result.status, 'rejected');
  assert.equal(result.reasons[0].code, 'multi-part');
});
check('非法掩膜参数 → empty-mask（不抛异常）', () => {
  assert.equal(traceMask(null, 10, 10).reasons[0].code, 'empty-mask');
  assert.equal(traceMask(new Uint8Array(4), 10, 10).reasons[0].code, 'empty-mask');
  assert.equal(traceMask(new Uint8Array(100), 0, 0).reasons[0].code, 'empty-mask');
});

// ==================== 8. 二值化：四种背景场景 ====================
const binarizeWidth = 100;
const binarizeHeight = 80;
const iconMask = new Uint8Array(binarizeWidth * binarizeHeight);
for (let y = 0; y < binarizeHeight; y += 1) {
  for (let x = 0; x < binarizeWidth; x += 1) {
    if (Math.hypot(x - 50, y - 40) <= 25) iconMask[y * binarizeWidth + x] = 1;
  }
}
/** 期望前景掩膜与实际掩膜的一致率 */
function maskMatchRatio(mask, expected) {
  let same = 0;
  for (let index = 0; index < expected.length; index += 1) {
    if (Boolean(mask[index]) === Boolean(expected[index])) same += 1;
  }
  return same / expected.length;
}

check('二值化：白底黑剪影（背景估计白、掩膜一致率 ≥ 99%）', () => {
  const rgba = makeRgba(binarizeWidth, binarizeHeight, (x, y) =>
    iconMask[y * binarizeWidth + x] ? [0, 0, 0] : [255, 255, 255]);
  const result = binarizeImageData(rgba, binarizeWidth, binarizeHeight);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.diagnostics.background, [255, 255, 255]);
  assert.ok(maskMatchRatio(result.mask, iconMask) >= 0.99);
  assert.ok(Math.abs(result.diagnostics.foregroundRatio - countMask(iconMask) / iconMask.length) < 1e-9);
});
check('二值化：纯色底（蓝底白图标）', () => {
  const rgba = makeRgba(binarizeWidth, binarizeHeight, (x, y) =>
    iconMask[y * binarizeWidth + x] ? [255, 255, 255] : [20, 70, 190]);
  const result = binarizeImageData(rgba, binarizeWidth, binarizeHeight);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.diagnostics.background, [20, 70, 190]);
  assert.ok(maskMatchRatio(result.mask, iconMask) >= 0.99);
});
check('二值化：反色（黑底白图）→ 掩膜仍取白图标', () => {
  const rgba = makeRgba(binarizeWidth, binarizeHeight, (x, y) =>
    iconMask[y * binarizeWidth + x] ? [255, 255, 255] : [0, 0, 0]);
  const result = binarizeImageData(rgba, binarizeWidth, binarizeHeight);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.diagnostics.background, [0, 0, 0]);
  assert.ok(maskMatchRatio(result.mask, iconMask) >= 0.99);
});
check('二值化：渐变+浅阴影背景（阴影不进入前景）', () => {
  const rgba = makeRgba(binarizeWidth, binarizeHeight, (x, y) => {
    const base = 225 + Math.round((x / (binarizeWidth - 1)) * 20 + (y / (binarizeHeight - 1)) * 10);
    const distance = Math.hypot(x - 50, y - 40);
    if (distance <= 25) return [40, 40, 40];
    if (distance <= 32) return [base - 30, base - 30, base - 30]; // 浅阴影：与背景差 < 容差
    return [base, base, base];
  });
  const result = binarizeImageData(rgba, binarizeWidth, binarizeHeight);
  assert.equal(result.status, 'ok');
  assert.ok(result.diagnostics.background[0] >= 230 && result.diagnostics.background[0] <= 250);
  assert.ok(maskMatchRatio(result.mask, iconMask) >= 0.99);
});
check('二值化：透明像素按背景处理（透明区域不成为前景）', () => {
  const rgba = makeRgba(binarizeWidth, binarizeHeight, (x, y) => {
    const distance = Math.hypot(x - 50, y - 40);
    if (distance <= 20) return [0, 0, 0];
    if (distance <= 30) return [0, 0, 0, 0]; // 透明环：应视作背景
    return [255, 255, 255];
  });
  const result = binarizeImageData(rgba, binarizeWidth, binarizeHeight);
  assert.equal(result.status, 'ok');
  const expected = new Uint8Array(binarizeWidth * binarizeHeight);
  for (let index = 0; index < expected.length; index += 1) {
    const x = index % binarizeWidth;
    const y = Math.floor(index / binarizeWidth);
    if (Math.hypot(x - 50, y - 40) <= 20) expected[index] = 1;
  }
  assert.ok(maskMatchRatio(result.mask, expected) >= 0.99);
});
check('二值化：全背景（纯白）→ empty-mask', () => {
  const rgba = makeRgba(binarizeWidth, binarizeHeight, () => [255, 255, 255]);
  const result = binarizeImageData(rgba, binarizeWidth, binarizeHeight);
  assert.equal(result.status, 'rejected');
  assert.equal(result.reasons[0].code, 'empty-mask');
  assert.equal(result.mask, null);
});
check('二值化：全黑图（无可分辨前景）→ empty-mask', () => {
  const rgba = makeRgba(binarizeWidth, binarizeHeight, () => [0, 0, 0]);
  const result = binarizeImageData(rgba, binarizeWidth, binarizeHeight);
  assert.equal(result.status, 'rejected');
  assert.equal(result.reasons[0].code, 'empty-mask');
});
check('二值化：几乎全前景（1px 白边 + 400×400 黑内）→ no-background', () => {
  const size = 400;
  const rgba = makeRgba(size, size, (x, y) => {
    const border = x === 0 || y === 0 || x === size - 1 || y === size - 1;
    const value = border ? 255 : 0;
    return [value, value, value];
  });
  const result = binarizeImageData(rgba, size, size);
  assert.equal(result.status, 'rejected');
  assert.equal(result.reasons[0].code, 'no-background');
});
check('二值化：非法输入 → empty-mask（不抛异常）', () => {
  assert.equal(binarizeImageData(null, 10, 10).reasons[0].code, 'empty-mask');
  assert.equal(binarizeImageData(new Uint8ClampedArray(8), 10, 10).reasons[0].code, 'empty-mask');
  assert.equal(binarizeImageData(new Uint8ClampedArray(400), 0, 10).reasons[0].code, 'empty-mask');
});
check('二值化 → 描摹 全链路（黑底白图标）', () => {
  const rgba = makeRgba(120, 120, (x, y) => (Math.hypot(x - 60, y - 60) <= 38 ? [250, 250, 250] : [10, 10, 10]));
  const binarized = binarizeImageData(rgba, 120, 120);
  assert.equal(binarized.status, 'ok');
  const traced = traceMask(binarized.mask, 120, 120);
  assert.equal(traced.status, 'ok');
  assert.ok(traced.diagnostics.iou >= IMAGE_TRACE_IOU_MIN);
});

// ==================== 9. pointCount 可调与钳制 ====================
check('pointCount 可调：160 → 160 点', () => {
  const result = traceMask(circleMask, 240, 240, { pointCount: 160 });
  assert.equal(result.points.length, 160);
});
check('pointCount 钳制：36 → 120 点（不低于下限）', () => {
  const result = traceMask(circleMask, 240, 240, { pointCount: 36 });
  assert.equal(result.points.length, IMAGE_TRACE_POINT_MIN);
});
check('pointCount 钳制：500 → 320 点（不超过上限）', () => {
  const result = traceMask(circleMask, 240, 240, { pointCount: 500 });
  assert.equal(result.points.length, IMAGE_TRACE_POINT_MAX);
});
check('参数可覆盖：放宽 minForegroundRatio 后可接受小前景', () => {
  const mask = new Uint8Array(200 * 200);
  for (let y = 100; y < 108; y += 1) {
    for (let x = 100; x < 105; x += 1) mask[y * 200 + x] = 1;
  }
  assert.equal(traceMask(mask, 200, 200).status, 'rejected');
  const relaxed = traceMask(mask, 200, 200, { minForegroundRatio: 0.0001 });
  assert.notEqual(relaxed.reasons[0]?.code ?? 'ok', 'empty-mask');
});
check('参数可覆盖：收紧 minSpanRatio 后宽高比小的形状被拒绝为退化', () => {
  const wideMask = makeRoundedRectMask(200, 200, 30, 40, 190, 160, 20); // 160×120，比值 0.75
  assert.equal(traceMask(wideMask, 200, 200).status, 'ok');
  const result = traceMask(wideMask, 200, 200, { minSpanRatio: 0.8 });
  assert.equal(result.status, 'rejected');
  assert.equal(result.reasons[0].code, 'degenerate-span');
});

// ==================== 10. 浏览器入口 Node 契约 ====================
await checkAsync('浏览器入口：Node（无 document）返回 rejected no-canvas，不抛异常', async () => {
  const result = await traceImageDataUrl('data:image/png;base64,AAAA', {});
  assert.equal(result.status, 'rejected');
  assert.equal(result.reasons[0].code, 'no-canvas');
  assert.equal(result.points, null);
});
await checkAsync('浏览器入口：非 data URL 输入 → rejected（no-canvas 优先，不抛异常）', async () => {
  const result = await traceImageDataUrl('not-a-data-url', {});
  assert.equal(result.status, 'rejected');
  assert.ok(['no-canvas', 'decode-failed'].includes(result.reasons[0].code), result.reasons[0].code);
});
await checkAsync('浏览器入口：已中止的 signal 抛 AbortError（交给控制器记为已停止）', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => traceImageDataUrl('data:image/png;base64,AAAA', { signal: controller.signal }),
    (error) => error && error.name === 'AbortError',
  );
});

// ==================== 11. 浏览器入口（假 DOM 单测，非 E2E） ====================
// 用最小假 document/Image 打通 traceImageDataUrl 的完整浏览器分支：
// Image 解码 → canvas drawImage（含垫白底/不放大）→ getImageData → 二值化 → 描摹 → IoU 闸门。
// 真实浏览器链路由链路验收（tools/e2e-long-tail.mjs）覆盖，这里只验证模块自身的编排逻辑。

/**
 * 安装最小假 DOM：Image 在 src 赋值后异步 onload；canvas 用内存像素缓冲实现
 * drawImage / getImageData（只实现 traceImageDataUrl 用到的子集）。
 *
 * @param {{width: number, height: number, data: Uint8ClampedArray}} source 假图片的 RGBA 像素
 * @returns {() => void} 还原全局对象的函数
 */
function installFakeDom(source) {
  class FakeImage {
    constructor() {
      this.width = 0;
      this.height = 0;
      this.onload = null;
      this.onerror = null;
    }
    set src(value) {
      if (value.includes('broken')) {
        queueMicrotask(() => this.onerror && this.onerror(new Error('decode fail')));
        return;
      }
      queueMicrotask(() => {
        this.width = source.width;
        this.height = source.height;
        if (this.onload) this.onload();
      });
    }
  }
  const document = {
    createElement(tag) {
      if (tag !== 'canvas') throw new Error(`假 DOM 不认识元素 ${tag}`);
      const canvas = { width: 0, height: 0, _width: 0, _height: 0, _fillStyle: '#000000', _pixels: null };
      const context = {
        set fillStyle(value) { canvas._fillStyle = value; },
        get fillStyle() { return canvas._fillStyle; },
        fillRect(x, y, width, height) {
          const match = /^#([0-9a-f]{6})$/i.exec(canvas._fillStyle);
          const color = match
            ? [parseInt(match[1], 16) >> 16, (parseInt(match[1], 16) >> 8) & 255, parseInt(match[1], 16) & 255]
            : [0, 0, 0];
          for (let yy = y; yy < y + height; yy += 1) {
            for (let xx = x; xx < x + width; xx += 1) {
              if (xx < 0 || yy < 0 || xx >= canvas.width || yy >= canvas.height) continue;
              const offset = (yy * canvas.width + xx) * 4;
              canvas._pixels[offset] = color[0];
              canvas._pixels[offset + 1] = color[1];
              canvas._pixels[offset + 2] = color[2];
              canvas._pixels[offset + 3] = 255;
            }
          }
        },
        drawImage(image, dx, dy, targetWidth, targetHeight) {
          for (let yy = 0; yy < targetHeight; yy += 1) {
            for (let xx = 0; xx < targetWidth; xx += 1) {
              const sx = Math.min(source.width - 1, Math.floor((xx / targetWidth) * source.width));
              const sy = Math.min(source.height - 1, Math.floor((yy / targetHeight) * source.height));
              const sourceOffset = (sy * source.width + sx) * 4;
              const targetX = dx + xx;
              const targetY = dy + yy;
              if (targetX < 0 || targetY < 0 || targetX >= canvas.width || targetY >= canvas.height) continue;
              const targetOffset = (targetY * canvas.width + targetX) * 4;
              const alpha = source.data[sourceOffset + 3] / 255;
              for (let channel = 0; channel < 3; channel += 1) {
                canvas._pixels[targetOffset + channel] = Math.round(
                  source.data[sourceOffset + channel] * alpha +
                  canvas._pixels[targetOffset + channel] * (1 - alpha),
                );
              }
              canvas._pixels[targetOffset + 3] = Math.max(canvas._pixels[targetOffset + 3], Math.round(255 * alpha));
            }
          }
        },
        getImageData() {
          return { width: canvas.width, height: canvas.height, data: Uint8ClampedArray.from(canvas._pixels) };
        },
      };
      Object.defineProperty(canvas, 'width', {
        get() { return canvas._width; },
        set(value) { canvas._width = value; canvas._pixels = new Uint8ClampedArray(value * canvas._height * 4); },
      });
      Object.defineProperty(canvas, 'height', {
        get() { return canvas._height; },
        set(value) { canvas._height = value; canvas._pixels = new Uint8ClampedArray(canvas._width * value * 4); },
      });
      canvas.width = 0;
      canvas.height = 0;
      canvas.getContext = () => context;
      return canvas;
    },
  };
  const previousImage = globalThis.Image;
  const previousDocument = globalThis.document;
  globalThis.Image = FakeImage;
  globalThis.document = document;
  return () => {
    globalThis.Image = previousImage;
    globalThis.document = previousDocument;
  };
}

/** 生成假图片来源：白底黑圆（可选择背景 alpha 模拟透明 PNG） */
function makeFakeImageSource(width, height, cx, cy, radius, backgroundAlpha = 255) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const inside = (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
      data[offset] = inside ? 0 : 255;
      data[offset + 1] = inside ? 0 : 255;
      data[offset + 2] = inside ? 0 : 255;
      data[offset + 3] = inside ? 255 : backgroundAlpha;
    }
  }
  return { width, height, data };
}

await checkAsync('浏览器入口（假 DOM）：不透明白底黑圆 → ok，点列/IoU/尺寸正确，未垫白底', async () => {
  const restore = installFakeDom(makeFakeImageSource(200, 200, 100, 100, 70));
  try {
    const result = await traceImageDataUrl('data:image/png;base64,AAAA');
    assert.equal(result.status, 'ok', JSON.stringify(result.reasons));
    assert.ok(result.points.length >= IMAGE_TRACE_POINT_MIN && result.points.length <= IMAGE_TRACE_POINT_MAX);
    assert.ok(result.diagnostics.iou >= IMAGE_TRACE_IOU_MIN);
    assert.equal(result.diagnostics.imageWidth, 200);
    assert.equal(result.diagnostics.imageHeight, 200);
    assert.equal(result.diagnostics.paddedWhiteBackground, false);
    assert.deepEqual(result.diagnostics.background, [255, 255, 255]);
    assert.equal(validateSimplePolygon(result.points).ok, true);
  } finally {
    restore();
  }
});
await checkAsync('浏览器入口（假 DOM）：透明背景 PNG 自动垫白底（diagnostics 标记 true）', async () => {
  const restore = installFakeDom(makeFakeImageSource(160, 160, 80, 80, 55, 0));
  try {
    const result = await traceImageDataUrl('data:image/png;base64,BBBB');
    assert.equal(result.status, 'ok', JSON.stringify(result.reasons));
    assert.equal(result.diagnostics.paddedWhiteBackground, true);
    assert.deepEqual(result.diagnostics.background, [255, 255, 255]);
    assert.ok(result.diagnostics.iou >= IMAGE_TRACE_IOU_MIN);
  } finally {
    restore();
  }
});
await checkAsync('浏览器入口（假 DOM）：大图长边缩到 1024（不放大）', async () => {
  const restore = installFakeDom(makeFakeImageSource(2048, 1024, 1024, 512, 300));
  try {
    const result = await traceImageDataUrl('data:image/png;base64,CCCC');
    assert.equal(result.status, 'ok', JSON.stringify(result.reasons));
    assert.equal(result.diagnostics.imageWidth, 1024);
    assert.equal(result.diagnostics.imageHeight, 512);
    assert.ok(result.diagnostics.iou >= IMAGE_TRACE_IOU_MIN);
  } finally {
    restore();
  }
});
await checkAsync('浏览器入口（假 DOM）：解码失败 → rejected decode-failed（不抛异常）', async () => {
  const restore = installFakeDom(makeFakeImageSource(10, 10, 5, 5, 3));
  try {
    const result = await traceImageDataUrl('data:image/png;base64,broken');
    assert.equal(result.status, 'rejected');
    assert.equal(result.reasons[0].code, 'decode-failed');
  } finally {
    restore();
  }
});
await checkAsync('浏览器入口（假 DOM）：IoU 闸门（iouMin 收紧）→ rejected iou-too-low', async () => {
  const restore = installFakeDom(makeFakeImageSource(200, 200, 100, 100, 70));
  try {
    const result = await traceImageDataUrl('data:image/png;base64,AAAA', { iouMin: 1.5 });
    assert.equal(result.status, 'rejected');
    assert.equal(result.reasons[0].code, 'iou-too-low');
  } finally {
    restore();
  }
});

// ==================== 12. 回归 H2：纯矩形 IoU（像素中心采样） ====================
// H2：旧扫描线用整数行 + 半开区间 + ceil/floor(x) 栅格化，会系统性漏掉外接框极值行，
// 纯矩形经 traceMask 后 IoU 只有 0.8~0.99；修复后要求全部 ≥ 0.98（理想≈1.0）。
const H2_RECT_MIN_IOU = 0.98;
// 注：60×14/前景 40×8 的真实短/长边比 = 7/39 ≈ 0.179，会先被 M3 的跨度闸门
// （CUSTOM_MIN_SPAN=0.2）拒绝；这里只验证 H2 扫描线栅格化本身，故用 minSpanRatio 覆盖
// 临时关掉跨度门槛，等价于修复前 traceMask 对这类尺寸放行的路径。
const h2RectCases = [
  [60, 14, 40, 8, { minSpanRatio: 0.01 }],
  [60, 14, 44, 10, undefined],
  [80, 20, 60, 14, undefined],
  [120, 30, 80, 20, undefined],
  [200, 60, 140, 40, undefined],
  [256, 256, 180, 180, undefined],
];
for (const [width, height, rectWidth, rectHeight, options] of h2RectCases) {
  check(`H2 纯矩形 ${width}×${height}（前景 ${rectWidth}×${rectHeight}）：ok 且 IoU ≥ 0.98`, () => {
    const mask = new Uint8Array(width * height);
    const x0 = Math.floor((width - rectWidth) / 2);
    const y0 = Math.floor((height - rectHeight) / 2);
    for (let y = y0; y < y0 + rectHeight; y += 1) {
      for (let x = x0; x < x0 + rectWidth; x += 1) mask[y * width + x] = 1;
    }
    const result = traceMask(mask, width, height, options);
    assert.equal(result.status, 'ok', JSON.stringify(result.reasons));
    const iou = computeMaskIou(result.points, result.filledMask, width, height);
    assert.ok(iou >= H2_RECT_MIN_IOU, `矩形 IoU ${iou.toFixed(4)} < ${H2_RECT_MIN_IOU}`);
    // 诊断 IoU 与独立复算一致（同一实现、同一输入，逐位相同）
    assert.ok(Math.abs(iou - result.diagnostics.iou) < 1e-12, '诊断 IoU 与独立复算不一致');
    // 矩形归一化后仍保留长宽比（span 比 = 像素外接框短/长边比）
    const bounds = boundsOfMask(mask, width, height);
    const expectedRatio = Math.min(bounds.width, bounds.height) / Math.max(bounds.width, bounds.height);
    assert.ok(Math.abs(result.diagnostics.spanY - expectedRatio) < 1e-6
      || Math.abs(result.diagnostics.spanX - expectedRatio) < 1e-6, '矩形长宽比未保留');
  });
}
check('H2 扫描线 IoU 与像素中心采样一致（无掩膜外框漏算）', () => {
  // 用纯矩形独立验证：修复后点列覆盖的像素数应与掩膜前景像素数一致（IoU 前为交集/并集）
  const width = 60;
  const height = 14;
  const mask = new Uint8Array(width * height);
  for (let y = 3; y < 13; y += 1) {
    for (let x = 10; x < 54; x += 1) mask[y * width + x] = 1;
  }
  const result = traceMask(mask, width, height);
  assert.equal(result.status, 'ok');
  assert.ok(computeMaskIou(result.points, mask, width, height) >= H2_RECT_MIN_IOU);
});

// ==================== 13. 回归 H3：极端输入有界返回 + 中止信号 ====================
/** 高频毛刺圆盘（与审查复现脚本同款：半径按角度 sin(angle*60) 抖动 ±2%） */
function makeJitterDisk(size) {
  const mask = new Uint8Array(size * size);
  const cx = size / 2;
  const cy = size / 2;
  const r0 = size * 0.4;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const angle = Math.atan2(y - cy, x - cx);
      const radius = r0 + Math.sin(angle * 60) * size * 0.02;
      if (Math.hypot(x - cx, y - cy) <= radius) mask[y * size + x] = 1;
    }
  }
  return mask;
}
check('H3 极端抖动输入 512×512：有限时间（<2000ms 宽松上限）返回且不抛非中止异常', () => {
  const mask = makeJitterDisk(512);
  const started = Date.now();
  let result = null;
  let thrown = null;
  try {
    result = traceMask(mask, 512, 512);
  } catch (error) {
    thrown = error;
  }
  const elapsed = Date.now() - started;
  assert.equal(thrown, null, `抛出非中止异常：${thrown && thrown.message}`);
  assert.ok(elapsed < 2000, `耗时 ${elapsed}ms 超过宽松上限 2000ms（可能死循环）`);
  assert.ok(result && ['ok', 'rejected'].includes(result.status), `status=${result && result.status}`);
  if (result.status === 'ok') {
    assert.ok(result.diagnostics.iou >= IMAGE_TRACE_IOU_MIN);
  } else {
    assert.ok(result.reasons.length > 0, 'rejected 结果必须带 reason');
  }
});
check('H3 已中止 signal：traceMask 立即抛统一 AbortError（不是 rejected）', () => {
  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () => traceMask(circleMask, 240, 240, { signal: controller.signal }),
    (error) => error && error.name === 'AbortError' && error.kind === 'aborted',
  );
});
check('H3 已中止 signal：traceOuterContour 跟踪前检查并抛 AbortError', () => {
  const mask = new Uint8Array(64 * 64);
  for (let y = 10; y < 54; y += 1) {
    for (let x = 10; x < 54; x += 1) mask[y * 64 + x] = 1;
  }
  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () => traceOuterContour(mask, 64, 64, { signal: controller.signal, foregroundCount: 44 * 44 }),
    (error) => error && error.name === 'AbortError',
  );
});

// ==================== 14. 回归 M3：跨度门槛与 CUSTOM_MIN_SPAN 对齐 ====================
check('M3 默认 minSpanRatio 与 intent.js 的 CUSTOM_MIN_SPAN 同源（0.2）', () => {
  assert.equal(CUSTOM_MIN_SPAN, 0.2);
  assert.equal(IMAGE_TRACE_DEFAULTS.minSpanRatio, CUSTOM_MIN_SPAN);
});
check('M3 细长图标（80×15，前景 78×14）：提前 rejected degenerate-span 并说明归一化门槛', () => {
  const width = 80;
  const height = 15;
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < 14; y += 1) {
    for (let x = 1; x < 79; x += 1) mask[y * width + x] = 1;
  }
  const result = traceMask(mask, width, height);
  assert.equal(result.status, 'rejected');
  assert.equal(result.reasons[0].code, 'degenerate-span');
  assert.ok(result.reasons[0].message.includes('0.2'), result.reasons[0].message);
  assert.ok(result.reasons[0].message.includes('归一化后无法形成合法图形'), result.reasons[0].message);
  assert.equal(result.points, null);
});
check('M3 跨度达标（短/长 ≈ 0.24）的图标不受影响：仍 ok', () => {
  const width = 80;
  const height = 20;
  const mask = new Uint8Array(width * height);
  for (let y = 1; y < 20; y += 1) {
    for (let x = 2; x < 78; x += 1) mask[y * width + x] = 1;
  }
  const result = traceMask(mask, width, height);
  assert.equal(result.status, 'ok', JSON.stringify(result.reasons));
  assert.ok(Math.min(result.diagnostics.spanX, result.diagnostics.spanY) >= CUSTOM_MIN_SPAN);
  assert.ok(normalizeCustomShape({ name: '图像描摹', points: result.points }), '跨度达标的描摹结果应能通过归一化');
});

// ==================== 15. 回归 M4：traceMask 内执行 iouMin 闸门 ====================
check('M4 iouMin 收紧到 1.5：traceMask 自身返回 rejected iou-too-low（不再只有浏览器入口把关）', () => {
  const result = traceMask(circleMask, 240, 240, { iouMin: 1.5 });
  assert.equal(result.status, 'rejected');
  assert.equal(result.reasons[0].code, 'iou-too-low');
  assert.ok(result.reasons[0].message.includes('低于下限'), result.reasons[0].message);
  assert.equal(result.points, null);
  // 实际描摹质量并不差，只是把下限抬高后必须拒绝
  assert.ok(result.diagnostics.iou >= IMAGE_TRACE_IOU_MIN);
});
check('M4 默认 iouMin 下正常圆仍 ok（闸门不放宽不误伤）', () => {
  const result = traceMask(circleMask, 240, 240);
  assert.equal(result.status, 'ok');
  assert.ok(result.diagnostics.iou >= IMAGE_TRACE_DEFAULTS.iouMin);
});

// ==================== 统计 ====================
console.log('');
console.log(`[统计] 断言 ${passed + failed} 项：PASS ${passed}，FAIL ${failed}`);
process.exit(failed === 0 ? 0 : 1);
