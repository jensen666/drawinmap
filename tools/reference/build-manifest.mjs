#!/usr/bin/env node
/**
 * 素材扩容合并工具：把 7 个生产 seed 与 100 个 E2E fixture 合并成正式素材库。
 *
 * 方案：docs/方案设计/2026-10-31-参考图素材扩容与多候选在线检索方案.md §4。
 *
 * 职责（数量服从去重与审核结果，不设"必须恰好 100 份"硬指标）：
 * 1. 以 sha256File() 同一换行归一化口径计算全部素材哈希，相同 SHA 去重（seed 优先保留）；
 * 2. 应用人工审核结论（tools/reference/review-verdicts.json）：visual=like 才入库；
 * 3. 应用名称覆盖（如 fa-cross 的中文别名改为「十字架」，避免「十字路口」误劫持）；
 * 4. 应用口语全称封闭表（方案 2026-11-01 §4 / §5.1）：中文名是单字的 fixture 素材
 *    追加表内口语全称，表外不新增（与手改正式 manifest 保持同一张表）；
 * 5. 拒绝与内置图形（星/心/矩形）语义冲突的素材；
 * 6. 全量重跑 convertSvg → normalizeCustomShape，转换不过的素材不入库；
 * 7. 产出：正式 manifest（--write 时写入 web/data/shapes/manifest.json）、
 *    审核报告 report.json（保留/去重/拒绝 id 与原因）、视觉审核图库 gallery.html。
 *
 * 用法：
 *   node tools/reference/build-manifest.mjs            # 生成报告 + 图库，不写正式 manifest
 *   node tools/reference/build-manifest.mjs --write    # 同时写入正式 manifest
 */

import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { convertSvg } from "./lib/index.js";
import { normalizeCustomShape } from "../../web/src/agent/intent.js";
import { sha256File } from "./lib/manifest.js";
import { normalizeSourceLicense, renderAttributionMarkdown } from "./license-url.mjs";

const ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const SEED_MANIFEST = resolve(ROOT, "web/data/shapes/manifest.json");
const FIXTURE_MANIFEST = resolve(ROOT, "test/fixtures/e2e-shapes/manifest.json");
const OUT_DIR = resolve(ROOT, "tools/reference/out-merge");
const LIBRARY_DIR = resolve(ROOT, "web/data/shapes/library");
const VERDICTS_PATH = resolve(ROOT, "tools/reference/review-verdicts.json");

/** 与方案 §4.2 示例一致的审核批次日期 */
const REVIEW_DATE = "2026-11-01";

/**
 * 拒绝入库清单（id → 原因）。审核结论绑定素材哈希；这里按内容语义拒绝，
 * 不是凑数的删除——星/心是内置图形通道（engine/shapes.js），参考图不得覆盖它们
 * （方案 §4.3 负例："内置星/心/矩形不被参考图覆盖"）。
 */
const REJECT_IDS = Object.freeze({
  heart: "与内置图形「心形」语义冲突：内置星/心/矩形不被参考图覆盖（方案 §4.3 负例）",
  "fa-star": "与内置图形「五角星」语义冲突：内置星/心/矩形不被参考图覆盖（方案 §4.3 负例）",
});

/**
 * 名称覆盖：只修正审核中确认的误劫持风险与明显的英文名错位，不编造别名。
 * - fa-cross：中文别名「十字」会裸子串命中「十字路口」（高频地点词，方案 §4.3
 *   "多字别名不得因扩容新增明显地点误劫持"），改为「十字架」。
 * - 学名式英文名移入 scientificName，en 恢复通用名（排序与在线检索都需要通用名）。
 */
const NAME_OVERRIDES = Object.freeze({
  "fa-cross": { zh: ["十字架"] },
  goat: { en: ["goat"], scientificName: "Capra hircus" },
  donkey: { en: ["donkey"], scientificName: "Equus asinus" },
  squirrel: { en: ["squirrel"], scientificName: "Sciurus vulgaris" },
  hedgehog: { en: ["hedgehog"], scientificName: "Erinaceus europaeus" },
  bat: { en: ["bat"], scientificName: "Pteropus vampyrus" },
  seal: { en: ["seal"], scientificName: "Phoca vitulina" },
  otter: { en: ["otter"], scientificName: "Lutra lutra" },
  flamingo: { en: ["flamingo"], scientificName: "Phoenicopterus roseus" },
  parrot: { en: ["parrot"], scientificName: "Psittaciformes" },
  lizard: { en: ["lizard"], scientificName: "Lacertilia" },
  jellyfish: { en: ["jellyfish"], scientificName: "Medusozoa" },
  triceratops: { en: ["triceratops"], scientificName: "Triceratops" },
  stegosaurus: { en: ["stegosaurus"], scientificName: "Stegosaurus" },
});

/**
 * 口语全称封闭表（方案 2026-11-01 §4 / §5.1）：中文名是单字的素材补一个口语全称。
 * 只登记表内 7 个词，性别/年龄/品种不登记，不在代码里加后缀规则。
 * 必须与 web/data/shapes/manifest.json 的人工改动保持同一张表——fixture 素材的
 * aliases 由 names 重新生成，--write 重新生成时不能丢这 7 条扩展别名。
 */
const ORAL_FULL_NAME_BY_CHAR = Object.freeze({
  兔: "兔子",
  鸭: "鸭子",
  猴: "猴子",
  鼠: "老鼠",
  龟: "乌龟",
  鹰: "老鹰",
  鲸: "鲸鱼",
});

/**
 * 按素材中文名的首字查口语全称：只认 names.zh[0] 恰好一个汉字的素材，表外返回 null。
 * @param {string[]} zh 素材中文名
 * @returns {string|null}
 */
export function oralFullNameOf(zh) {
  const first = Array.isArray(zh) && zh.length > 0 ? String(zh[0]) : "";
  if (first.length !== 1) return null;
  return ORAL_FULL_NAME_BY_CHAR[first] ?? null;
}

/**
 * fixture 素材的别名生成：中文名 + 英文名 + 封闭表口语全称（去重、顺序稳定）。
 * seed 素材不走这里（保留原 aliases，不重排）；--write 重新生成 fixture 条目时
 * 靠它保住 7 条口语全称别名。
 * @param {string[]} zh 中文名
 * @param {string[]} en 英文名
 * @returns {string[]}
 */
export function buildFixtureAliases(zh, en) {
  const oralFullName = oralFullNameOf(zh);
  return [...new Set([...zh, ...en, ...(oralFullName ? [oralFullName] : [])])];
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** HTML 转义 */
function escapeHtml(text) {
  return String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 把 T 轮廓渲染成内联 SVG（审核图库用） */
function renderTargetSvg(points, size = 190) {
  if (!points?.length) return `<div class="empty">无 T</div>`;
  const padding = 14;
  const inner = size - padding * 2;
  const pixel = points
    .map(([x, y]) => `${(padding + (x + 0.5) * inner).toFixed(1)},${(padding + (0.5 - y) * inner).toFixed(1)}`)
    .join(" ");
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><rect width="${size}" height="${size}" fill="#fff"/><polygon points="${pixel}" fill="#111"/></svg>`;
}

function main() {
  const doWrite = process.argv.includes("--write");
  const seedManifest = readJson(SEED_MANIFEST);
  const fixtureManifest = readJson(FIXTURE_MANIFEST);
  let verdicts = {};
  if (existsSync(VERDICTS_PATH)) {
    const parsed = readJson(VERDICTS_PATH);
    verdicts = parsed?.verdicts && typeof parsed.verdicts === "object" ? parsed.verdicts : parsed;
  }

  const report = {
    generatedAt: new Date().toISOString(),
    reviewDate: REVIEW_DATE,
    seedCount: seedManifest.assets.length,
    fixtureCount: fixtureManifest.entries.length,
    kept: [],
    deduped: [],
    rejected: [],
    unreviewed: [],
  };

  /** 已保留资产的 sha → id（去重索引，seed 先建索引） */
  const shaIndex = new Map();
  const assets = [];

  // ---------- 1. seed 条目：保留元数据，补 tags 与 review ----------
  for (const asset of seedManifest.assets) {
    const sha = sha256File(resolve(ROOT, "web/data/shapes", asset.file));
    if (sha !== asset.sha256) {
      throw new Error(`seed 素材哈希不匹配：${asset.id}（manifest ${asset.sha256?.slice(0, 8)} 实际 ${sha.slice(0, 8)}）`);
    }
    shaIndex.set(sha, asset.id);
    const verdict = verdicts[asset.id] || {};
    assets.push({
      ...asset,
      source: normalizeSourceLicense(asset.source),
      tags: Array.isArray(verdict.tags) ? verdict.tags : [],
      review: { status: "approved", visual: "like", reviewedAt: REVIEW_DATE, sha256: sha },
    });
    report.kept.push({ id: asset.id, sha256: sha, origin: "seed" });
  }

  // ---------- 2. fixture 条目：去重 → 拒绝 → 审核 → 转换校验 → 入库 ----------
  mkdirSync(LIBRARY_DIR, { recursive: true });
  for (const entry of fixtureManifest.entries) {
    const sourceFile = resolve(ROOT, "test/fixtures/e2e-shapes", entry.file);
    if (!existsSync(sourceFile)) {
      report.rejected.push({ id: entry.id, reason: `素材文件不存在：${entry.file}` });
      continue;
    }
    const sha = sha256File(sourceFile);

    // 字节等价重复：与已入库资产同 SHA → 去重（保留 seed 版本）
    if (shaIndex.has(sha)) {
      report.deduped.push({ id: entry.id, duplicateOf: shaIndex.get(sha), sha256: sha });
      continue;
    }

    // 明确拒绝清单（内置图形冲突等）
    if (REJECT_IDS[entry.id]) {
      report.rejected.push({ id: entry.id, reason: REJECT_IDS[entry.id] });
      continue;
    }

    // 人工审核结论：visual=like 才入库；没有结论 = 待审核不入库（不凑数）
    const verdict = verdicts[entry.id];
    if (!verdict || verdict.visual !== "like") {
      report.unreviewed.push({ id: entry.id, zh: entry.zh, hasVerdict: Boolean(verdict) });
      continue;
    }

    // 转换校验：convertSvg → normalizeCustomShape 必须双通过（方案 §4.2 条件 4）
    const svgText = readFileSync(sourceFile, "utf8");
    const conversion = convertSvg(svgText);
    if (conversion.status !== "accepted" || !conversion.T) {
      report.rejected.push({
        id: entry.id,
        reason: `convertSvg 未通过：${(conversion.reasons || []).map((r) => r.code).join(",")}`,
      });
      continue;
    }
    const shape = normalizeCustomShape({ name: entry.zh, points: conversion.T.points });
    if (!shape) {
      report.rejected.push({ id: entry.id, reason: "normalizeCustomShape 未通过" });
      continue;
    }

    // 复制素材文件到正式库目录
    const targetRel = `library/${entry.id}.svg`;
    copyFileSync(sourceFile, resolve(ROOT, "web/data/shapes", targetRel));
    shaIndex.set(sha, entry.id);

    const override = NAME_OVERRIDES[entry.id] || {};
    const zh = override.zh || [entry.zh].filter(Boolean);
    const en = override.en || [entry.en].filter(Boolean);
    assets.push({
      id: entry.id,
      names: { zh, en },
      // 口语全称封闭表（方案 2026-11-01 §4/§5.1）：追加在 aliases 末尾，
      // 与手改正式 manifest 的写法、顺序保持一致（--write 重生成不丢扩展别名）。
      aliases: buildFixtureAliases(zh, en),
      group: entry.group || "object",
      file: targetRel,
      source: normalizeSourceLicense(entry.source),
      ...(override.scientificName || entry.scientificName
        ? { scientificName: override.scientificName || entry.scientificName }
        : {}),
      notes: `2026-11-01 审核批次：由 E2E 素材库（test/fixtures/e2e-shapes）合并入正式库。`,
      sha256: sha,
      tags: Array.isArray(verdict.tags) ? verdict.tags : [],
      review: { status: "approved", visual: "like", reviewedAt: REVIEW_DATE, sha256: sha },
    });
    report.kept.push({ id: entry.id, sha256: sha, origin: "fixture" });
  }

  report.counts = {
    total: report.kept.length,
    seed: report.kept.filter((item) => item.origin === "seed").length,
    fixture: report.kept.filter((item) => item.origin === "fixture").length,
    deduped: report.deduped.length,
    rejected: report.rejected.length,
    unreviewed: report.unreviewed.length,
  };

  // ---------- 3. 产出 ----------
  mkdirSync(OUT_DIR, { recursive: true });
  writeJson(resolve(OUT_DIR, "report.json"), report);

  // 审核图库：原始 SVG 与实际 T 并排（方案 §4.2 条件 5 的对照材料）
  const cards = [];
  const allForGallery = [
    ...seedManifest.assets.map((asset) => ({ asset, svgPath: resolve(ROOT, "web/data/shapes", asset.file), origin: "seed" })),
    ...fixtureManifest.entries.map((entry) => ({ asset: { id: entry.id, zh: entry.zh, en: entry.en, source: entry.source }, svgPath: resolve(ROOT, "test/fixtures/e2e-shapes", entry.file), origin: "fixture" })),
  ];
  for (const item of allForGallery) {
    let tSvg = `<div class="empty">转换失败</div>`;
    let origSvg = "";
    let maxDev = "-";
    try {
      const raw = readFileSync(item.svgPath, "utf8");
      origSvg = `<img class="orig" alt="原始 SVG" src="data:image/svg+xml;base64,${Buffer.from(raw, "utf8").toString("base64")}"/>`;
      const conversion = convertSvg(raw);
      if (conversion.status === "accepted" && conversion.T) {
        tSvg = renderTargetSvg(conversion.T.points);
        maxDev = `${conversion.metrics.sourceToTargetMaxPct}%`;
      }
    } catch {
      tSvg = `<div class="empty">转换异常</div>`;
    }
    const verdict = verdicts[item.asset.id];
    const kept = report.kept.some((row) => row.id === item.asset.id);
    const state = kept ? "kept" : REJECT_IDS[item.asset.id] ? "rejected" : verdict ? "rejected" : "unreviewed";
    cards.push(`<article class="card" data-id="${escapeHtml(item.asset.id)}">
      <header><h2>${escapeHtml(item.asset.zh || item.asset.names?.zh?.[0] || item.asset.id)} <span class="en">${escapeHtml(item.asset.en || item.asset.names?.en?.[0] || "")}</span></h2>
      <span class="state ${state}">${state}</span></header>
      <p class="meta">${escapeHtml(item.asset.id)} · ${escapeHtml(item.asset.source?.license || "")} · 最大偏差 ${maxDev}</p>
      <div class="figures">
        <figure>${origSvg || '<div class="empty">无原始</div>'}<figcaption>原始 SVG</figcaption></figure>
        <figure>${tSvg}<figcaption>T 轮廓</figcaption></figure>
      </div>
    </article>`);
  }
  const gallery = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/><title>素材审核图库（T 轮廓）</title>
<style>
*{box-sizing:border-box}body{margin:0;padding:24px;background:#f1f5f9;color:#172033;font-family:"Microsoft YaHei",sans-serif}
h1{margin:0 0 4px;font-size:22px}.summary{color:#526078;margin:0 0 16px;font-size:13px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px}
.card{background:#fff;border:1px solid #d7deea;border-radius:10px;padding:10px}
.card header{display:flex;align-items:center;gap:8px}.card h2{margin:0;font-size:16px}.en{color:#94a3b8;font-size:12px}
.state{margin-left:auto;padding:2px 8px;border-radius:999px;font-size:11px}
.state.kept{background:#dcfce7;color:#166534}.state.rejected{background:#fee2e2;color:#991b1b}.state.unreviewed{background:#fef9c3;color:#854d0e}
.meta{margin:4px 0;color:#526078;font-size:11px;word-break:break-all}
.figures{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:6px}
figure{margin:0}figcaption{text-align:center;color:#64748b;font-size:11px}
.empty{display:flex;align-items:center;justify-content:center;height:150px;background:#f8fafc;color:#94a3b8;border-radius:8px;font-size:12px}
svg{display:block;margin:0 auto}
img.orig{width:100%;height:150px;object-fit:contain;background:#fff;border:1px solid #eef2f7;border-radius:8px}
</style></head><body>
<h1>素材审核图库（T 轮廓对照）</h1>
<p class="summary">共 ${allForGallery.length} 个候选素材。审核标准：T 轮廓一眼可认出是标注的对象、姿态清晰、没有明显转换崩坏（碎裂/多环/细刺）。
原始 SVG 对照可用开发服务器打开 <code>/data/shapes/…</code> 或 <code>test/fixtures/e2e-shapes/…</code> 下的同名文件。</p>
<div class="grid">${cards.join("\n")}</div>
</body></html>`;
  writeFileSync(resolve(OUT_DIR, "gallery.html"), gallery, "utf8");

  if (doWrite) {
    const manifest = {
      version: 1,
      description: "参考图素材库：seed 与 E2E 素材合并、SHA 去重、人工审核（review 绑定素材哈希）后入库；同对象多版本构成参考候选。",
      licensePolicy: seedManifest.licensePolicy,
      assets,
    };
    writeJson(SEED_MANIFEST, manifest);
    const attributionPath = resolve(ROOT, "web/data/shapes/ATTRIBUTION.md");
    writeFileSync(attributionPath, renderAttributionMarkdown(manifest), "utf8");
    console.log(`[merge] 已写入正式 manifest：${assets.length} 份资产 → web/data/shapes/manifest.json`);
    console.log(`[merge] 已写入署名：web/data/shapes/ATTRIBUTION.md`);
  }

  console.log(`[merge] 保留 ${report.counts.total}（seed ${report.counts.seed} + fixture ${report.counts.fixture}）；去重 ${report.counts.deduped}；拒绝 ${report.counts.rejected}；待审核 ${report.counts.unreviewed}`);
  console.log(`[merge] 报告与图库：${OUT_DIR}`);
  if (report.unreviewed.length > 0 && doWrite) {
    console.warn(`[merge] 警告：${report.unreviewed.length} 个素材没有审核结论，未写入正式 manifest`);
  }
}

// 仅直接运行（node tools/reference/build-manifest.mjs）时执行主流程；
// 被测试/校验脚本 import 时只取纯函数（oralFullNameOf / buildFixtureAliases），不产生副作用。
const isDirectRun = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main();
}
