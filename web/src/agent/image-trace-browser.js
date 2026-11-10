/**
 * 图像描摹浏览器入口（controller 调用）：data URL → Image → canvas → ImageData → 纯函数描摹。
 *
 * 方案依据：docs/方案设计/2026-11-01-长尾图形轮廓来源与贴路上限方案.md §3。
 * 与页面共用 web/src/agent/image-trace.js 的同一套二值化/轮廓函数；本文件只负责
 * 解码与画布取样（浏览器 API），Node 下不可用 canvas 时返回 rejected `no-canvas`，
 * 不抛异常（"停止"信号除外：已中止时抛统一 AbortError，交给控制器记为已停止）。
 */

import { throwIfAborted } from '../cancel.js';
import {
  IMAGE_TRACE_IOU_MIN,
  binarizeImageData,
  computeMaskIou,
  traceMask,
} from './image-trace.js';

/** 画布最长边：不放大图片，大图缩到该尺寸以控制解码与描摹耗时 */
const TRACE_MAX_SIDE = 1024;

/**
 * 构造 rejected 结果。
 *
 * @param {string} code 拒绝码
 * @param {string} message 中文说明
 * @param {object} [diagnostics] 诊断信息
 * @returns {{status: string, reasons: Array<{code: string, message: string}>, points: null, diagnostics: object}}
 */
function rejected(code, message, diagnostics = {}) {
  return { status: 'rejected', reasons: [{ code, message }], points: null, diagnostics };
}

/**
 * 用 Image 解码 data URL（成功/失败都 settle，不抛未捕获异常）。
 *
 * @param {string} dataUrl 图片 data URL
 * @returns {Promise<HTMLImageElement>} 解码后的图片
 */
function decodeImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('图片解码失败'));
    image.src = dataUrl;
  });
}

/**
 * 描摹图片 data URL 的外轮廓。
 *
 * 流程：signal 中止检查 → Image 解码 → canvas drawImage（长边 ≤ 1024，不放大，
 * 先垫白底避免透明 PNG 被当黑前景）→ getImageData → binarizeImageData → traceMask
 * （传入 signal 与 iouMin，traceMask 内部先执行 IoU 闸门）→ 再独立算一次
 * computeMaskIou 做入口闸门（双保险）→ IoU < iouMin 判 rejected `iou-too-low`。
 * 成功时 diagnostics 含 iou、imageWidth、imageHeight、background、pointCount 等。
 *
 * @param {string} imageDataUrl 图片 data URL（data:image/...）
 * @param {object} [options] { signal, iouMin, maxSide, ...image-trace 参数 }
 * @returns {Promise<{status: 'ok'|'rejected', reasons: Array<{code: string, message: string}>,
 *   points: Array<[number, number]>|null, diagnostics: object}>} 描摹结果
 * @throws {Error} signal 已中止时抛统一 AbortError（name=AbortError）
 */
export async function traceImageDataUrl(imageDataUrl, options = {}) {
  const {
    signal = null,
    iouMin = IMAGE_TRACE_IOU_MIN,
    maxSide = TRACE_MAX_SIDE,
    ...maskOptions
  } = options || {};
  throwIfAborted(signal, '已停止');
  if (typeof document === 'undefined' || typeof Image === 'undefined') {
    return rejected('no-canvas', '当前环境没有可用的 canvas，无法描摹图片');
  }
  if (typeof imageDataUrl !== 'string' || !imageDataUrl.startsWith('data:image/')) {
    return rejected('decode-failed', '图片数据为空或不是合法的 data URL');
  }
  let image;
  try {
    image = await decodeImage(imageDataUrl);
  } catch (error) {
    return rejected('decode-failed', `图片解码失败：${error instanceof Error ? error.message : '未知原因'}`);
  }
  throwIfAborted(signal, '已停止');
  try {
    // 不放大：只把超过 maxSide 的长边等比缩小
    const scale = Math.min(1, maxSide / Math.max(image.width || 1, image.height || 1));
    const imageWidth = Math.max(1, Math.round((image.width || 1) * scale));
    const imageHeight = Math.max(1, Math.round((image.height || 1) * scale));
    const canvas = document.createElement('canvas');
    canvas.width = imageWidth;
    canvas.height = imageHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
      return rejected('no-canvas', '当前环境无法创建 canvas 2D 上下文，无法描摹图片');
    }
    // 先按原样画一次，检测图片是否带透明通道：透明像素直接参与二值化会被当黑前景，
    // 因此统一在画布上垫白底重画。这是统一的画布预处理，不区分图片种类、不做照片分类。
    context.drawImage(image, 0, 0, imageWidth, imageHeight);
    let imageData = context.getImageData(0, 0, imageWidth, imageHeight);
    let paddedWhiteBackground = false;
    for (let offset = 3; offset < imageData.data.length; offset += 4) {
      if (imageData.data[offset] < 255) {
        paddedWhiteBackground = true;
        break;
      }
    }
    if (paddedWhiteBackground) {
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, imageWidth, imageHeight);
      context.drawImage(image, 0, 0, imageWidth, imageHeight);
      imageData = context.getImageData(0, 0, imageWidth, imageHeight);
    }
    throwIfAborted(signal, '已停止');
    const binarized = binarizeImageData(imageData.data, imageWidth, imageHeight, maskOptions);
    const baseDiagnostics = {
      imageWidth,
      imageHeight,
      paddedWhiteBackground,
      background: binarized.diagnostics.background,
    };
    if (binarized.status !== 'ok') {
      return {
        status: 'rejected',
        reasons: binarized.reasons,
        points: null,
        diagnostics: { ...binarized.diagnostics, ...baseDiagnostics },
      };
    }
    const traced = traceMask(binarized.mask, imageWidth, imageHeight, { ...maskOptions, iouMin, signal });
    throwIfAborted(signal, '已停止');
    const diagnostics = { ...traced.diagnostics, ...baseDiagnostics };
    if (traced.status !== 'ok') {
      return { status: 'rejected', reasons: traced.reasons, points: null, diagnostics };
    }
    // 描摹点列对"填充后外轮廓"再算一次 IoU 做闸门：低于 0.90 视为抽不出可信轮廓
    const iou = computeMaskIou(traced.points, traced.filledMask, imageWidth, imageHeight);
    diagnostics.iou = iou;
    if (!(iou >= iouMin)) {
      return rejected(
        'iou-too-low',
        `描摹点列与填充后外轮廓的 IoU ${iou.toFixed(3)} 低于 ${iouMin}，抽不出可信轮廓`,
        diagnostics,
      );
    }
    return { status: 'ok', reasons: [], points: traced.points, diagnostics };
  } catch (error) {
    // "停止"必须原样抛出，控制器据此把本轮标记为已停止；其余浏览器异常降级为 rejected
    if (error && (error.name === 'AbortError' || error.kind === 'aborted')) throw error;
    return rejected('decode-failed', `图片处理失败：${error instanceof Error ? error.message : '未知原因'}`);
  }
}
