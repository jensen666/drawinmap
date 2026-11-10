/**
 * 自定义图形拓扑合法性校验——**兼容入口**。
 *
 * 纯几何实现已下沉 `web/src/engine/polygon.js`（清理方案 2026-11-09 §3.2 B4：
 * 消除 `reference/*` 反向 import `agent/*` 的分层倒挂，共享层只保留唯一实现）。
 * 本文件只做 re-export，保留既有导出名与签名；新代码请直接从 `engine/polygon.js` 取。
 */

export {
  isUnsupportedTopologyCode,
  pointInPolygon,
  polygonArea,
  polygonSignedArea,
  validateDisjointParts,
  validateSimplePolygon,
} from '../engine/polygon.js';
