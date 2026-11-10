/**
 * Node 端素材文件读取 + 转换（浏览器端请直接用 convertSvg）。
 *
 * 与 convert.js 分开，保证浏览器导入 reference/convert.js 时不会带上 node:fs。
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { convertSvg } from "../../../web/src/reference/convert.js";

/**
 * 读取素材文件并转换（不校验 manifest / sha；由 manifest 层负责）。
 *
 * @param {{id: string, file: string}} asset 素材条目
 * @param {string} baseDir 素材根目录
 * @param {object} [options] 转换选项
 * @returns {object} 转换结果
 */
export function convertAsset(asset, baseDir, options = {}) {
  const filePath = resolve(baseDir, asset.file);
  const svgText = readFileSync(filePath, "utf8");
  return {
    assetId: asset.id,
    file: asset.file,
    filePath,
    bytes: Buffer.byteLength(svgText, "utf8"),
    result: convertSvg(svgText, options),
  };
}
