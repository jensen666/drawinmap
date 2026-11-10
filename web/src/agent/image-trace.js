/**
 * 图像描摹核心：像素 → 二值掩膜 → 单条填充外轮廓 → 归一化点列（纯函数，无 DOM）。
 *
 * 方案依据：docs/方案设计/2026-11-01-长尾图形轮廓来源与贴路上限方案.md §3、§4.1。
 * 处理链路（页面描摹与 Node 能力测试走同一份函数）：
 *   RGBA → binarizeImageData（四边像素中位数估计背景，最大通道差 > 容差为前景）
 *        → traceMask（8 邻接连通分量 → 只保留最大分量、丢弃小碎片 → 填充内部孔洞
 *          → Moore 邻域跟踪单条闭合外轮廓 → RDP 简化 → 弧长均匀重采样到 pointCount
 *          → 以填充后前景外接框归一化到 [-0.5,0.5]、y 向上、最长边为 1）
 *        → computeMaskIou（扫描线栅格化，禁止 O(W*H*n) 暴力）。
 * 图片只取一条实心外轮廓：孔洞不保留；抽不出单闭合轮廓就拒绝，不用模型猜点。
 * 底层掩膜几何（连通分量/孔洞填充/Moore 跟踪/扫描线 IoU）见 image-trace-geometry.js。
 */

import {
  applyNormalization,
  dedupeClosedRing,
  resampleClosed,
  simplifyClosedRdp,
} from '../reference/geometry.js';
import { throwIfAborted } from '../cancel.js';
import { CUSTOM_MIN_SPAN } from './intent.js';
import { validateSimplePolygon } from './shape-validate.js';
import {
  computeMaskIou,
  fillHoles,
  labelComponents,
  maskBounds,
  traceOuterContour,
} from './image-trace-geometry.js';

/** 描摹点列下限（与归一化 customShape 的接受区间一致） */
export const IMAGE_TRACE_POINT_MIN = 120;

/** 描摹点列上限 */
export const IMAGE_TRACE_POINT_MAX = 320;

/** 描摹点列与填充后掩膜的最低 IoU（方案 §4.1：≥ 0.90） */
export const IMAGE_TRACE_IOU_MIN = 0.9;

/**
 * 可调参数默认值（调用方可用 options 覆盖，测试按需放宽/收紧）。
 * - pointCount：目标重采样点数，取 240，落在 [120, 320]；
 * - backgroundTolerance：与背景色的最大通道差超过它才算前景（抗 JPEG 噪声）；
 * - minForegroundRatio / maxForegroundRatio：前景占比下限/上限（空图/无背景拒绝）；
 * - mainComponentRatio：最大连通分量占前景的最低比例，低于即碎成多块（multi-part）；
 * - strayAreaRatio：被丢弃碎片占画面面积的上限，超过说明不是"小碎片"（multi-part）；
 * - minSpanRatio：前景外接框短边/长边下限，低于即退化细线（degenerate-span）。
 *   **与 intent.js 的 CUSTOM_MIN_SPAN 共用同一常量**：归一化 customShape 要求包围盒两轴
 *   跨度都 ≥ 0.2（最长边为 1 时即短边/长边 ≥ 0.2），描摹若不提前按同一门槛拒绝，
 *   就会出现"描摹 ok、归一化返回 null、用户只拿到通用拒绝句"的不一致。
 * - iouMin：描摹点列与填充后掩膜的最低 IoU，traceMask 返回 ok 前强制执行（rejected
 *   `iou-too-low`）；浏览器入口另有同名闸门做双保险；
 * - minContourPoints：外轮廓像素点数下限（低于即退化）；
 * - simplifyEpsilon：RDP 简化容差系数（像素 = 长边*系数，夹在 [0.5,1.5]）。
 */
export const IMAGE_TRACE_DEFAULTS = Object.freeze({
  pointCount: 240,
  backgroundTolerance: 60,
  minForegroundRatio: 0.01,
  maxForegroundRatio: 0.98,
  mainComponentRatio: 0.9,
  strayAreaRatio: 0.03,
  minSpanRatio: CUSTOM_MIN_SPAN,
  iouMin: IMAGE_TRACE_IOU_MIN,
  minContourPoints: 8,
  simplifyEpsilon: 0.003,
});

/**
 * 合并调用方参数与默认值。
 *
 * @param {object|undefined} options 调用方参数
 * @returns {typeof IMAGE_TRACE_DEFAULTS} 合并后的参数
 */
function resolveOptions(options) {
  return { ...IMAGE_TRACE_DEFAULTS, ...(options && typeof options === 'object' ? options : {}) };
}

/**
 * 构造 rejected 结果（binarize/trace 各自补 mask/points 字段为 null）。
 *
 * @param {string} code 拒绝码
 * @param {string} message 中文说明
 * @param {object} diagnostics 诊断信息
 * @returns {{status: string, reasons: Array<{code: string, message: string}>, diagnostics: object}}
 */
function makeRejected(code, message, diagnostics) {
  return { status: 'rejected', reasons: [{ code, message }], diagnostics };
}

/**
 * 中位数（偶数个取中间两值平均）。
 *
 * @param {number[]} values 数值数组
 * @returns {number} 中位数
 */
function median(values) {
  if (values.length === 0) return 0;
  values.sort((a, b) => a - b);
  const mid = values.length >> 1;
  return values.length % 2 === 1 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}

/**
 * 用图像四条边的像素颜色估计背景色（逐通道中位数）。
 *
 * 取中位数而不是均值：边上偶尔有图标碰到边缘或噪点，中位数更稳。
 * 全透明像素不参与估计；整条边都透明时回退白色。
 *
 * @param {Uint8ClampedArray|Uint8Array} rgba RGBA 像素（长度 width*height*4）
 * @param {number} width 宽（像素）
 * @param {number} height 高（像素）
 * @returns {[number, number, number]} 背景色 [r,g,b]
 */
function estimateBackgroundColor(rgba, width, height) {
  const reds = [];
  const greens = [];
  const blues = [];
  const sample = (x, y) => {
    const offset = (y * width + x) * 4;
    if (rgba[offset + 3] < 32) return; // 透明像素按"无背景信息"处理
    reds.push(rgba[offset]);
    greens.push(rgba[offset + 1]);
    blues.push(rgba[offset + 2]);
  };
  for (let x = 0; x < width; x += 1) {
    sample(x, 0);
    if (height > 1) sample(x, height - 1);
  }
  for (let y = 1; y < height - 1; y += 1) {
    sample(0, y);
    if (width > 1) sample(width - 1, y);
  }
  if (reds.length === 0) return [255, 255, 255];
  return [median(reds), median(greens), median(blues)];
}

/**
 * 二值化 ImageData：四边中位数估计背景色，最大通道差 > tolerance 判为前景。
 *
 * 空图/前景过少 → rejected `empty-mask`；前景过多没有背景 → rejected `no-background`。
 * 不区分图片种类（线稿/剪影/图标/照片同一套规则），照片由 traceMask 的碎块判定拒绝。
 *
 * @param {Uint8ClampedArray|Uint8Array} rgba RGBA 像素（长度 width*height*4）
 * @param {number} width 宽（像素）
 * @param {number} height 高（像素）
 * @param {object} [options] 覆盖 IMAGE_TRACE_DEFAULTS 的参数
 * @returns {{status: 'ok'|'rejected', reasons: Array<{code: string, message: string}>,
 *   mask: Uint8Array|null, diagnostics: object}} 二值化结果
 */
export function binarizeImageData(rgba, width, height, options = {}) {
  const opts = resolveOptions(options);
  const w = Math.floor(Number(width));
  const h = Math.floor(Number(height));
  const diagnostics = {
    width: w,
    height: h,
    background: [255, 255, 255],
    backgroundTolerance: opts.backgroundTolerance,
    foregroundRatio: 0,
  };
  if (!rgba || typeof rgba.length !== 'number' || !(w > 0) || !(h > 0) || rgba.length < w * h * 4) {
    return { ...makeRejected('empty-mask', '图像数据为空或尺寸非法，无法二值化', diagnostics), mask: null };
  }
  const background = estimateBackgroundColor(rgba, w, h);
  diagnostics.background = background;
  const mask = new Uint8Array(w * h);
  let foreground = 0;
  for (let index = 0; index < w * h; index += 1) {
    const offset = index * 4;
    if (rgba[offset + 3] < 32) continue; // 透明像素视作背景
    const diff = Math.max(
      Math.abs(rgba[offset] - background[0]),
      Math.abs(rgba[offset + 1] - background[1]),
      Math.abs(rgba[offset + 2] - background[2]),
    );
    if (diff > opts.backgroundTolerance) {
      mask[index] = 1;
      foreground += 1;
    }
  }
  diagnostics.foregroundRatio = foreground / (w * h);
  if (diagnostics.foregroundRatio < opts.minForegroundRatio) {
    return {
      ...makeRejected(
        'empty-mask',
        `前景像素过少（占画面 ${(diagnostics.foregroundRatio * 100).toFixed(2)}%），不是可描摹的图形`,
        diagnostics,
      ),
      mask: null,
    };
  }
  if (diagnostics.foregroundRatio > opts.maxForegroundRatio) {
    return {
      ...makeRejected(
        'no-background',
        `前景像素过多（占画面 ${(diagnostics.foregroundRatio * 100).toFixed(2)}%），找不到可分离的背景`,
        diagnostics,
      ),
      mask: null,
    };
  }
  return { status: 'ok', reasons: [], mask, diagnostics };
}

/**
 * 从二值掩膜提取单条填充外轮廓，重采样并归一化为 customShape 点列。
 *
 * 拒绝码（方案 §4.1「描摹」行）：
 * - `empty-mask`：空掩膜 / 前景占比过低；
 * - `no-background`：前景占比过高，没有背景；
 * - `multi-part`：碎成多块（最大分量不足或小碎片过大）；
 * - `degenerate`：轮廓像素太少 / 不是简单闭合多边形；
 * - `degenerate-span`：前景外接框短边/长边过小（细线、条纹）；阈值与归一化
 *   customShape 的跨度门槛同源（CUSTOM_MIN_SPAN），避免描摹通过但归一化拒绝；
 * - `no-outer-contour`：Moore 跟踪抽不出单条闭合轮廓；
 * - `iou-too-low`：描摹点列与填充后掩膜的 IoU 低于 options.iouMin（M4：本函数
 *   自己执行文档承诺的闸门，浏览器入口另有一道同名闸门做双保险）。
 *
 * options 支持覆盖 IMAGE_TRACE_DEFAULTS 的任意数值项，并额外支持：
 * - `signal`：可选 AbortSignal，各重活阶段边界与轮廓跟踪循环内周期检查，
 *   中止时抛统一 AbortError（name=AbortError），交给上层记为"已停止"。
 *
 * @param {Uint8Array} mask 二值掩膜（非 0 为前景，长度 width*height）
 * @param {number} width 宽（像素）
 * @param {number} height 高（像素）
 * @param {object} [options] 覆盖 IMAGE_TRACE_DEFAULTS 的参数 + 可选 signal
 * @returns {{status: 'ok'|'rejected', reasons: Array<{code: string, message: string}>,
 *   points: Array<[number, number]>|null, filledMask: Uint8Array|null, diagnostics: object}} 描摹结果
 * @throws {Error} options.signal 已中止时抛统一 AbortError（name=AbortError）
 */
export function traceMask(mask, width, height, options = {}) {
  const opts = resolveOptions(options);
  throwIfAborted(opts.signal, '已停止');
  const w = Math.floor(Number(width));
  const h = Math.floor(Number(height));
  const diagnostics = {
    width: w,
    height: h,
    foregroundRatio: 0,
    components: 0,
    mainComponentRatio: 0,
    strayPixels: 0,
    strayRatio: 0,
    filledHoles: 0,
    contourPointCount: 0,
    pointCount: 0,
    iou: 0,
    spanX: 0,
    spanY: 0,
    bounds: null,
  };
  const reject = (code, message) => ({ ...makeRejected(code, message, diagnostics), points: null, filledMask: null });
  if (!mask || typeof mask.length !== 'number' || !(w > 0) || !(h > 0) || mask.length < w * h) {
    return reject('empty-mask', '掩膜为空或尺寸非法，无法描摹');
  }
  const total = w * h;
  const bounds = maskBounds(mask, w, h);
  diagnostics.foregroundRatio = bounds.count / total;
  if (bounds.count === 0 || diagnostics.foregroundRatio < opts.minForegroundRatio) {
    return reject(
      'empty-mask',
      `前景像素过少（占画面 ${(diagnostics.foregroundRatio * 100).toFixed(2)}%），不是可描摹的图形`,
    );
  }
  if (diagnostics.foregroundRatio > opts.maxForegroundRatio) {
    return reject(
      'no-background',
      `前景像素过多（占画面 ${(diagnostics.foregroundRatio * 100).toFixed(2)}%），没有可分离的背景`,
    );
  }
  // 连通分量：最大分量不足说明碎成多块，描不出一条完整轮廓
  throwIfAborted(opts.signal, '已停止');
  const labeled = labelComponents(mask, w, h);
  diagnostics.components = labeled.sizes.length;
  let mainIndex = 0;
  for (let index = 1; index < labeled.sizes.length; index += 1) {
    if (labeled.sizes[index] > labeled.sizes[mainIndex]) mainIndex = index;
  }
  const mainSize = labeled.sizes[mainIndex] || 0;
  diagnostics.mainComponentRatio = bounds.count > 0 ? mainSize / bounds.count : 0;
  if (diagnostics.mainComponentRatio < opts.mainComponentRatio) {
    return reject(
      'multi-part',
      `前景碎成 ${labeled.sizes.length} 块，最大块只占前景 ${(diagnostics.mainComponentRatio * 100).toFixed(1)}%`,
    );
  }
  // 只保留最大分量：小碎片按方案「去掉小碎片」丢弃
  const kept = new Uint8Array(total);
  const mainLabel = mainIndex + 1;
  for (let index = 0; index < total; index += 1) {
    if (labeled.labels[index] === mainLabel) kept[index] = 1;
  }
  diagnostics.strayPixels = bounds.count - mainSize;
  diagnostics.strayRatio = diagnostics.strayPixels / total;
  if (diagnostics.strayRatio > opts.strayAreaRatio) {
    return reject(
      'multi-part',
      `碎片面积占画面 ${(diagnostics.strayRatio * 100).toFixed(2)}%，超过小碎片上限 ${(opts.strayAreaRatio * 100).toFixed(1)}%`,
    );
  }
  // 孔洞填充：不与图像边界连通的背景一律视作孔洞，结果只保留实心外轮廓
  throwIfAborted(opts.signal, '已停止');
  const filled = fillHoles(kept, w, h);
  diagnostics.filledHoles = filled.holes;
  const filledMask = filled.mask;
  const filledBounds = maskBounds(filledMask, w, h);
  const spanX = filledBounds.width;
  const spanY = filledBounds.height;
  const maxSpanPx = Math.max(spanX, spanY);
  const minSpanPx = Math.min(spanX, spanY);
  if (maxSpanPx < 8 || minSpanPx / maxSpanPx < opts.minSpanRatio) {
    return reject(
      'degenerate-span',
      `前景外接框 ${spanX}×${spanY} 像素，短边/长边 ${(minSpanPx / (maxSpanPx || 1)).toFixed(3)} < ${opts.minSpanRatio}`
        + `（短边不足长边的 ${(opts.minSpanRatio * 100).toFixed(0)}%，归一化后无法形成合法图形；细线/条纹退化）`,
    );
  }
  // Moore 邻域跟踪单条闭合外轮廓（孔洞已填充 → 只有外轮廓）：
  // 传入前景像素数用于收紧步数上限，传入 signal 支持中止（H3 加固）
  const contour = traceOuterContour(filledMask, w, h, {
    signal: opts.signal,
    foregroundCount: filledBounds.count,
  });
  if (!contour || contour.length < 3) {
    return reject('no-outer-contour', '抽不出单条闭合外轮廓（轮廓跟踪失败）');
  }
  const ring = dedupeClosedRing(contour);
  diagnostics.contourPointCount = ring.length;
  if (ring.length < opts.minContourPoints) {
    return reject('degenerate', `外轮廓只有 ${ring.length} 个像素点，太稀疏，无法形成有效轮廓`);
  }
  // 简化（RDP，容差随长边自适应）后按弧长均匀重采样到目标点数
  const epsilon = Math.min(1.5, Math.max(0.5, maxSpanPx * opts.simplifyEpsilon));
  const simplified = simplifyClosedRdp(ring, epsilon);
  const pointCount = Math.max(
    IMAGE_TRACE_POINT_MIN,
    Math.min(IMAGE_TRACE_POINT_MAX, Math.round(Number(opts.pointCount) || IMAGE_TRACE_DEFAULTS.pointCount)),
  );
  const resampled = resampleClosed(simplified.length >= 3 ? simplified : ring, pointCount);
  if (resampled.length < 3) {
    return reject('degenerate', '外轮廓重采样点数不足，无法形成有效闭环');
  }
  // 归一化：填充后外接框居中原点、最长边缩放到 1、y 轴翻转向上
  const params = {
    centerX: (filledBounds.minX + filledBounds.maxX) / 2,
    centerY: (filledBounds.minY + filledBounds.maxY) / 2,
    span: Math.max(maxSpanPx, 1),
  };
  const points = applyNormalization(resampled, params);
  diagnostics.pointCount = points.length;
  diagnostics.spanX = spanX / params.span;
  diagnostics.spanY = spanY / params.span;
  diagnostics.bounds = {
    minX: filledBounds.minX,
    minY: filledBounds.minY,
    maxX: filledBounds.maxX,
    maxY: filledBounds.maxY,
    width: filledBounds.width,
    height: filledBounds.height,
  };
  diagnostics.iou = computeMaskIou(points, filledMask, w, h);
  // 最终拓扑复验：规划器只接受简单闭环，抽出的轮廓必须不自交
  const topology = validateSimplePolygon(points);
  if (!topology.ok) {
    return reject('degenerate', `外轮廓不是简单闭合多边形：${topology.reason}`);
  }
  // M4：本函数文档承诺的 iouMin 闸门在返回前执行（浏览器入口另保留同名闸门做双保险）；
  // 用 !(iou >= iouMin) 写法让 NaN/非法下限也按"不达标"处理。
  if (!(diagnostics.iou >= opts.iouMin)) {
    return reject(
      'iou-too-low',
      `描摹点列与填充后掩膜的 IoU ${diagnostics.iou.toFixed(3)} 低于下限 ${opts.iouMin}，抽不出可信轮廓`,
    );
  }
  return { status: 'ok', reasons: [], points, filledMask, diagnostics };
}

// 契约要求 image-trace.js 导出 computeMaskIou：直接转出底层几何实现，调用方无感知
export { computeMaskIou };
