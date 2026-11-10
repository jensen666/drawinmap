/**
 * 参考图模块报告与预览：把转换结果渲染成 R/T 叠加 SVG、JSON 报告和 HTML 预览页。
 *
 * 预览页不依赖浏览器 API 之外的东西：内联 SVG + 相对路径引用原素材，
 * （原 build-preview.mjs 已随一次性工具下线；本报告由 tools/reference/build-manifest.mjs 产出的清单驱动。）
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { convertAsset } from "./convert-asset.js";
import { loadManifest } from "./manifest.js";

/** 把归一化坐标 [-0.5,0.5] 映射到 SVG 像素坐标 */
function toPixel([x, y], size, padding) {
  const inner = size - padding * 2;
  return [padding + (x + 0.5) * inner, padding + (0.5 - y) * inner];
}

/**
 * 生成 R/T 叠加 SVG。
 *
 * @param {object} conversion convertSvg 结果
 * @param {{size?: number, padding?: number}} [options]
 * @returns {string} SVG 字符串
 */
export function renderOverlaySvg(conversion, { size = 440, padding = 20 } = {}) {
  const pieces = [];
  const rMain = conversion.R?.main || [];
  const tPoints = conversion.T?.points || [];
  if (rMain.length >= 3) {
    const points = rMain.map((point) => toPixel(point, size, padding).map((value) => value.toFixed(2)).join(",")).join(" ");
    pieces.push(
      `<polyline points="${points}" fill="none" stroke="#8b5cf6" stroke-width="1.4" stroke-dasharray="6 4" stroke-linejoin="round" />`,
    );
  }
  if (tPoints.length >= 3) {
    const points = tPoints.map((point) => toPixel(point, size, padding).map((value) => value.toFixed(2)).join(",")).join(" ");
    pieces.push(
      `<polygon points="${points}" fill="#2563eb" fill-opacity="0.18" stroke="#2563eb" stroke-width="1.6" stroke-linejoin="round" />`,
    );
  }
  const empty = pieces.length === 0 ? '<text x="50%" y="50%" text-anchor="middle" fill="#94a3b8" font-size="14">无可预览轮廓</text>' : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="R/T 叠加轮廓">
  <rect width="${size}" height="${size}" fill="#ffffff" />
  <line x1="${padding}" y1="${size / 2}" x2="${size - padding}" y2="${size / 2}" stroke="#eef2f7" stroke-width="1" />
  <line x1="${size / 2}" y1="${padding}" x2="${size / 2}" y2="${size - padding}" stroke="#eef2f7" stroke-width="1" />
  ${pieces.join("\n")}
  ${empty}
</svg>`;
}

/** HTML 转义 */
function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 状态徽标 */
function statusBadge(status) {
  return status === "accepted"
    ? '<span class="badge ok">accepted</span>'
    : '<span class="badge bad">rejected</span>';
}

/** 把转换结果渲染成 HTML 卡片 */
function renderCard(item, { outDir, rootDir }) {
  const { asset, conversion } = item;
  const assetPath = relative(outDir, resolve(rootDir, asset.file)).replace(/\\/g, "/");
  const metrics = conversion.metrics
    ? `
      <dl class="metrics">
        <div><dt>宽高比</dt><dd>${conversion.T?.aspect ?? "—"}</dd></div>
        <div><dt>目标点数</dt><dd>${conversion.T?.pointCount ?? "—"}</dd></div>
        <div><dt>R→T 平均/最大</dt><dd>${conversion.metrics.sourceToTargetMeanPct.toFixed(3)}% / ${conversion.metrics.sourceToTargetMaxPct.toFixed(3)}%</dd></div>
        <div><dt>T→R 平均</dt><dd>${conversion.metrics.targetToSourceMeanPct.toFixed(3)}%</dd></div>
        <div><dt>面积</dt><dd>${conversion.T?.area ?? "—"}</dd></div>
        <div><dt>子轮廓/孔洞/部分</dt><dd>${conversion.diagnostics.subpathCount} / ${conversion.diagnostics.holeCount} / ${conversion.diagnostics.partCount}</dd></div>
      </dl>`
    : "";
  const reasons = conversion.reasons.length
    ? `<ul class="reasons">${conversion.reasons.map((reason) => `<li><code>${escapeHtml(reason.code)}</code> ${escapeHtml(reason.message)}</li>`).join("")}</ul>`
    : "";
  const warnings = conversion.warnings.length
    ? `<details class="warnings"><summary>warnings（${conversion.warnings.length}）</summary><ul>${conversion.warnings
        .map((warning) => `<li>${escapeHtml(warning)}</li>`)
        .join("")}</ul></details>`
    : "";
  return `<article class="card">
    <header>
      <h2>${escapeHtml(asset.names?.zh?.[0] || asset.id)}</h2>
      ${statusBadge(conversion.status)}
      <span class="id">${escapeHtml(asset.id)}</span>
    </header>
    <div class="figures">
      <figure class="source"><img src="${assetPath}" alt="${escapeHtml(asset.id)} 原素材" /><figcaption>原素材（${escapeHtml(asset.source.license)}）</figcaption></figure>
      <figure class="overlay">${renderOverlaySvg(conversion)}<figcaption>R（紫虚线） / T（蓝实线）</figcaption></figure>
    </div>
    <p class="source-line">来源：${escapeHtml(asset.source.name)} · ${escapeHtml(asset.source.license)}${asset.source.attribution ? ` · ${escapeHtml(asset.source.attribution)}` : ""} · <a href="${escapeHtml(asset.source.url)}" target="_blank" rel="noreferrer">源链接</a></p>
    ${metrics}
    ${reasons}
    ${warnings}
  </article>`;
}

/**
 * 生成完整报告：JSON + 每个素材的叠加 SVG + index.html。
 *
 * @param {{manifestPath: string, outDir: string, conversionOptions?: object}} options
 * @returns {{report: object, outDir: string, indexHtmlPath: string}}
 */
export function buildReport({ manifestPath, outDir, conversionOptions = {} }) {
  const manifest = loadManifest(manifestPath);
  if (!manifest.ok) {
    throw new Error(`manifest 校验失败：\n- ${manifest.errors.join("\n- ")}`);
  }
  const items = [];
  for (const asset of manifest.assets) {
    const converted = convertAsset(asset, manifest.rootDir, conversionOptions);
    items.push({ asset, conversion: converted.result, bytes: converted.bytes });
  }
  const summary = {
    total: items.length,
    accepted: items.filter((item) => item.conversion.status === "accepted").length,
    rejected: items.filter((item) => item.conversion.status === "rejected").length,
    generatedAt: new Date().toISOString(),
  };
  const report = {
    generatedAt: summary.generatedAt,
    manifest: manifestPath,
    summary,
    assets: items.map(({ asset, conversion, bytes }) => ({
      id: asset.id,
      names: asset.names,
      file: asset.file,
      bytes,
      source: asset.source,
      status: conversion.status,
      reasons: conversion.reasons,
      warnings: conversion.warnings,
      diagnostics: conversion.diagnostics,
      metrics: conversion.metrics,
      target: conversion.T,
    })),
  };
  mkdirSync(outDir, { recursive: true });
  const overlayDir = resolve(outDir, "r-t");
  mkdirSync(overlayDir, { recursive: true });
  for (const item of items) {
    writeFileSync(resolve(overlayDir, `${item.asset.id}.svg`), renderOverlaySvg(item.conversion), "utf8");
  }
  writeFileSync(resolve(outDir, "report.json"), JSON.stringify(report, null, 2), "utf8");
  const cards = items
    .map((item) => renderCard(item, { outDir, rootDir: manifest.rootDir }))
    .join("\n");
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>参考图模块 · R/T 转换预览</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 28px; background: #f1f5f9; color: #172033; font-family: "Microsoft YaHei", "PingFang SC", sans-serif; }
  h1 { margin: 0 0 6px; font-size: 26px; }
  .summary { color: #526078; margin: 0 0 22px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(520px, 1fr)); gap: 20px; }
  .card { background: #fff; border: 1px solid #d7deea; border-radius: 14px; padding: 16px; }
  .card header { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
  .card h2 { margin: 0; font-size: 19px; }
  .badge { padding: 2px 8px; border-radius: 999px; font-size: 12px; }
  .badge.ok { background: #dcfce7; color: #166534; }
  .badge.bad { background: #fee2e2; color: #991b1b; }
  .id { color: #94a3b8; font-size: 12px; }
  .figures { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  figure { margin: 0; }
  figure img, figure svg { display: block; width: 100%; height: 300px; object-fit: contain; background: #fff; border: 1px solid #edf0f5; border-radius: 10px; }
  figure svg { height: 300px; }
  figcaption { color: #64748b; font-size: 12px; padding-top: 4px; text-align: center; }
  .source-line { color: #526078; font-size: 12px; margin: 10px 0; word-break: break-all; }
  .metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px 12px; margin: 8px 0; }
  .metrics div { border-top: 1px solid #eef2f7; padding-top: 4px; }
  dt { color: #64748b; font-size: 11px; }
  dd { margin: 2px 0 0; font-size: 13px; }
  .reasons { margin: 8px 0; padding-left: 18px; color: #991b1b; font-size: 13px; }
  .warnings { color: #a15c00; font-size: 12px; }
  .warnings ul { margin: 6px 0; padding-left: 18px; }
</style>
</head>
<body>
  <h1>参考图模块 · R/T 转换预览</h1>
  <p class="summary">共 ${summary.total} 个素材：${summary.accepted} 个通过，${summary.rejected} 个拒绝。R 为紫虚线，T 为蓝色半透明轮廓；数据来自 <code>report.json</code>。</p>
  <div class="grid">
    ${cards}
  </div>
</body>
</html>`;
  const indexHtmlPath = resolve(outDir, "index.html");
  writeFileSync(indexHtmlPath, html, "utf8");
  return { report, outDir, indexHtmlPath };
}
