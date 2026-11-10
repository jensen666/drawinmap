/**
 * 参考素材许可策略：**唯一白名单**（本地 manifest 校验与在线检索共用）。
 *
 * 第一阶段只收"无义务（CC0-1.0 / PDM-1.0 / Public-Domain）或仅需署名（CC-BY-4.0）"
 * 的开放许可；CC-BY-SA / CC-BY-NC 等带传染或非商用限制的一律拒绝
 * （URL → SPDX 映射见 retrieval/phylopic.js 的 licenseFromUrl）。
 *
 * 清理方案 2026-11-09 §3.2 B4：此前 reference/browser.js 与 retrieval/phylopic.js
 * 各写一份逐字相同的白名单，任意一处漏改就会让"本地能进、在线不能进"口径漂移。
 */

/** 允许进入参考候选池的许可标记（顺序即校验/展示顺序） */
export const ALLOWED_REFERENCE_LICENSES = Object.freeze([
  'CC0-1.0',
  'PDM-1.0',
  'Public-Domain',
  'CC-BY-4.0',
]);
