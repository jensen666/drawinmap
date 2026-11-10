/**
 * 参考图模块公共入口（独立模块，不改变现有生产链路）。
 *
 * 职责：
 * - SVG 素材 → R（高保真参考轮廓）→ T（可画目标轮廓）；
 * - 素材清单（来源/许可/署名/sha256）校验；
 * - R/T 叠加预览与 JSON 报告。
 *
 * 不在本模块内：路网规划、路线评分、页面 UI、在线检索（后续阶段）。
 */

export { parseSvgDocument } from "../../../web/src/reference/svg-document.js";
export { parsePathData, parsePointsAttribute } from "../../../web/src/reference/path-data.js";
export { parseTransform, multiply, applyMatrix, IDENTITY } from "../../../web/src/reference/svg-transform.js";
export { classifyRings } from "../../../web/src/reference/rings.js";
export {
  bbox,
  polylineLength,
  resampleClosed,
  normalizationParams,
  applyNormalization,
  dedupeClosedRing,
  normalizeClosedRing,
  distanceToClosedPolyline,
  distanceStats,
  isClosedWithin,
} from "../../../web/src/reference/geometry.js";
export { CONVERSION_DEFAULTS, convertSvg } from "../../../web/src/reference/convert.js";
export { convertAsset } from "./convert-asset.js";
export {
  DEFAULT_ALLOWED_LICENSES,
  ATTRIBUTION_LICENSES,
  REVIEW_STATUSES,
  sha256File,
  validateManifest,
  loadManifest,
  ringArea,
} from "./manifest.js";
export { renderOverlaySvg, buildReport } from "./report.js";
export {
  CONVERTER_VERSION,
  NORMALIZER_VERSION,
  REFERENCE_CANDIDATE_SCHEMA,
  sha256Hex,
  sha256NormalizedText,
  normalizeLineBreaks,
  stableStringify,
  computeReferenceContentHash,
} from "../../../web/src/reference/hash.js";
export {
  PHYLOPIC_BASE,
  ALLOWED_ONLINE_LICENSES,
  licenseFromUrl,
  licenseRank,
  buildNodeSearchUrl,
  buildImagesUrl,
  resolveApiUrl,
  parseNodeSearch,
  parseImages,
  rankCandidates,
  fetchJson,
} from "../../../web/src/reference/retrieval/phylopic.js";
export {
  resolveReferenceShape,
  resolveReferenceCandidates,
  REFERENCE_CANDIDATE_LIMIT,
  REFERENCE_MAX_ATTEMPTS,
} from "../../../web/src/reference/retrieval/resolve.js";
export { createOnlineReferenceClient } from "../../../web/src/reference/online-client.js";
export { createOnlineReferenceService, normalizeOnlineQuery } from "../../../web/server/reference/online-service.js";
export { matchReferenceAssets, matchReferenceAsset, rankLocalReferenceAssets } from "../../../web/src/reference/browser.js";
export { validateSimplePolygon } from "../../../web/src/agent/shape-validate.js";
export {
  OPENCLIPART_BASE,
  OPENCLIPART_LICENSE,
  OPENCLIPART_LICENSE_URL,
  buildSearchUrl,
  buildDetailUrl,
  buildDownloadUrl,
  parseSearch,
  parseDetail,
  relevanceScore,
  titleScore,
  buildCandidate,
} from "../../../web/server/reference/retrieval/openclipart.js";
