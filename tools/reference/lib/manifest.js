/**
 * 素材清单（manifest）读取与校验：来源、许可、署名、sha256、文件存在性。
 *
 * 原则：进入正式库的素材必须"可追溯、可复现、许可清楚"。
 * 校验失败不抛异常，返回 errors 列表，由 CLI / 测试决定如何处理。
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { polygonArea } from "../../../web/src/agent/shape-validate.js";

/** 默认允许的许可（第一阶段：只收无义务或仅需署名的开放许可） */
export const DEFAULT_ALLOWED_LICENSES = Object.freeze([
  "CC0-1.0",
  "PDM-1.0",
  "Public-Domain",
  "CC-BY-4.0",
]);

/** 需要署名的许可 */
export const ATTRIBUTION_LICENSES = Object.freeze(["CC-BY-4.0"]);

/** 正式素材的审核状态（方案 2026-10-31 §4.2：审核通过且哈希绑定才入库） */
export const REVIEW_STATUSES = Object.freeze(["approved", "pending", "rejected"]);

/** 计算文件 sha256（统一换行，避免 Windows/Unix checkout 的 CRLF/LF 差异误判素材被篡改） */
export function sha256File(filePath) {
  const content = readFileSync(filePath, "utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const hash = createHash("sha256");
  hash.update(content, "utf8");
  return hash.digest("hex");
}

/** 检查字符串字段 */
function requireString(value, field, errors, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && value.trim() === "")) {
    errors.push(`${field} 必须是非空字符串`);
    return false;
  }
  return true;
}

/**
 * 校验 manifest 对象（不读文件时可只做结构校验）。
 *
 * @param {object} manifest manifest 对象
 * @param {object} [options]
 * @param {string} [options.rootDir] manifest 所在目录（用于检查文件与 sha）
 * @param {boolean} [options.checkHashes] 是否校验 sha256（默认 true，需 rootDir）
 * @returns {{ok: boolean, errors: string[], warnings: string[], assets: Array<object>}}
 */
export function validateManifest(manifest, { rootDir = null, checkHashes = true } = {}) {
  const errors = [];
  const warnings = [];
  const assets = [];
  if (!manifest || typeof manifest !== "object") {
    return { ok: false, errors: ["manifest 不是对象"], warnings, assets };
  }
  if (manifest.version !== 1) errors.push(`不支持的 manifest.version：${manifest.version}`);
  const allowed = Array.isArray(manifest.licensePolicy?.allowed)
    ? manifest.licensePolicy.allowed
    : DEFAULT_ALLOWED_LICENSES;
  if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) {
    errors.push("manifest.assets 必须是非空数组");
  }
  const ids = new Set();
  const files = new Set();
  for (let index = 0; index < (manifest.assets || []).length; index += 1) {
    const asset = manifest.assets[index];
    const prefix = `assets[${index}]`;
    if (!asset || typeof asset !== "object") {
      errors.push(`${prefix} 不是对象`);
      continue;
    }
    if (!requireString(asset.id, `${prefix}.id`, errors)) continue;
    if (ids.has(asset.id)) errors.push(`${prefix}.id 重复：${asset.id}`);
    ids.add(asset.id);
    requireString(asset.file, `${prefix}.file`, errors);
    if (asset.file) {
      const normalizedFile = asset.file.replace(/\\/g, "/");
      if (normalizedFile.startsWith("/") || normalizedFile.includes("..")) {
        errors.push(`${prefix}.file 必须是 manifest 目录内的相对路径：${asset.file}`);
      }
      if (files.has(normalizedFile)) warnings.push(`${prefix}.file 重复：${asset.file}`);
      files.add(normalizedFile);
    }
    if (!asset.names || typeof asset.names !== "object") {
      errors.push(`${prefix}.names 必须是对象（至少含 zh/en）`);
    } else {
      if (!Array.isArray(asset.names.zh) || asset.names.zh.length === 0) {
        errors.push(`${prefix}.names.zh 必须是非空数组`);
      }
      if (!Array.isArray(asset.names.en) || asset.names.en.length === 0) {
        errors.push(`${prefix}.names.en 必须是非空数组`);
      }
    }
    if (asset.aliases !== undefined) {
      if (!Array.isArray(asset.aliases)) {
        errors.push(`${prefix}.aliases 必须是字符串数组`);
      } else {
        for (const alias of asset.aliases) {
          if (typeof alias !== "string" || alias.trim() === "") {
            warnings.push(`${prefix}.aliases 存在空值/非字符串，已忽略`);
          }
        }
      }
    }
    // 人工姿态/特征标签（可选）：只允许字符串数组，排序用（方案 §4.2）
    if (asset.tags !== undefined) {
      if (!Array.isArray(asset.tags) || asset.tags.some((tag) => typeof tag !== "string" || !tag.trim())) {
        errors.push(`${prefix}.tags 必须是非空字符串数组`);
      }
    }
    // 人工审核块（方案 §4.2）：审核结论与素材哈希绑定；哈希不一致 = 素材已变、审核失效
    if (!asset.review || typeof asset.review !== "object") {
      errors.push(`${prefix}.review 必须是对象（人工审核结论）`);
    } else {
      if (!REVIEW_STATUSES.includes(asset.review.status)) {
        errors.push(`${prefix}.review.status 非法：${asset.review.status}`);
      }
      if (asset.review.status === "approved") {
        if (!requireString(asset.review.visual, `${prefix}.review.visual`, errors)) {
          // 已记录
        } else if (asset.review.visual !== "like") {
          errors.push(`${prefix}.review.visual 必须 like 才能正式入库`);
        }
        requireString(asset.review.reviewedAt, `${prefix}.review.reviewedAt`, errors);
        if (requireString(asset.review.sha256, `${prefix}.review.sha256`, errors) && asset.sha256) {
          if (asset.review.sha256 !== asset.sha256) {
            errors.push(`${prefix}.review.sha256 与素材 sha256 不一致（审核未绑定当前素材版本）`);
          }
        }
      }
    }
    if (!asset.source || typeof asset.source !== "object") {
      errors.push(`${prefix}.source 必须是对象`);
    } else {
      requireString(asset.source.name, `${prefix}.source.name`, errors);
      requireString(asset.source.url, `${prefix}.source.url`, errors);
      requireString(asset.source.license, `${prefix}.source.license`, errors);
      if (asset.source.license && !allowed.includes(asset.source.license)) {
        errors.push(`${prefix}.source.license 不在允许列表：${asset.source.license}`);
      }
      if (ATTRIBUTION_LICENSES.includes(asset.source.license)) {
        requireString(asset.source.attribution, `${prefix}.source.attribution`, errors);
      }
    }
    let filePath = null;
    if (asset.file && rootDir) {
      filePath = resolve(rootDir, asset.file);
      if (!existsSync(filePath)) {
        errors.push(`${prefix}.file 不存在：${asset.file}`);
      } else if (!statSync(filePath).isFile()) {
        errors.push(`${prefix}.file 不是文件：${asset.file}`);
      } else if (checkHashes) {
        if (!requireString(asset.sha256, `${prefix}.sha256`, errors)) {
          // 已记录错误
        } else {
          const actual = sha256File(filePath);
          if (actual !== asset.sha256) {
            errors.push(`${prefix}.sha256 不匹配（实际 ${actual.slice(0, 12)}…）`);
          }
        }
      }
    } else if (checkHashes && !rootDir) {
      warnings.push("未提供 rootDir，跳过文件存在性与 sha256 校验");
    }
    assets.push({ ...asset, filePath });
  }
  return { ok: errors.length === 0, errors, warnings, assets };
}

/**
 * 读取 manifest 文件并校验。
 *
 * @param {string} manifestPath manifest 文件路径
 * @returns {{ok: boolean, manifest: object|null, rootDir: string|null, assets: Array<object>, errors: string[], warnings: string[]}}
 */
export function loadManifest(manifestPath) {
  const rootDir = dirname(resolve(manifestPath));
  if (!existsSync(manifestPath)) {
    return {
      ok: false,
      manifest: null,
      rootDir,
      assets: [],
      errors: [`manifest 不存在：${manifestPath}`],
      warnings: [],
    };
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return {
      ok: false,
      manifest: null,
      rootDir,
      assets: [],
      errors: [`manifest 不是合法 JSON：${error.message}`],
      warnings: [],
    };
  }
  const validation = validateManifest(manifest, { rootDir, checkHashes: true });
  return { ...validation, manifest, rootDir };
}

/** 计算一个闭环点列的归一化面积（供报告/测试复用） */
export function ringArea(points) {
  return polygonArea(points);
}
