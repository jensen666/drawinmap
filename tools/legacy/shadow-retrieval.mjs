#!/usr/bin/env node
/**
 * 在线检索 shadow：对冻结查询集跑 PhyloPic / Openclipart 检索 → 候选 → SVG 下载 → R/T 转换 → 自动选择。
 *
 * 本脚本只做“独立模块 shadow”，不接生产；下载物进 web/data/shapes/cache（gitignore），
 * 结果与预览页进 tools/reference/out-shadow（gitignore）。
 *
 * 用法：
 *   node tools/reference/shadow-retrieval.mjs --limit 10          # 先跑 10 条冒烟
 *   node tools/reference/shadow-retrieval.mjs                     # 全量（有缓存会复用）
 *   node tools/reference/shadow-retrieval.mjs --refresh           # 忽略查询/图片缓存
 *   node tools/reference/shadow-retrieval.mjs --delay 80 --max-candidates 4
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildCandidate as buildOpenclipartCandidate,
  buildDetailUrl,
  buildImagesUrl,
  buildNodeSearchUrl,
  buildSearchUrl,
  convertSvg,
  fetchJson,
  licenseRank,
  parseDetail,
  parseImages,
  parseNodeSearch,
  parseSearch as parseOpenclipartSearch,
  rankCandidates,
  relevanceScore,
  resolveReferenceShape,
  titleScore,
} from "../reference/lib/index.js";

const ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const DEFAULT = {
  queries: resolve(ROOT, "web/data/shapes/queries.json"),
  cache: resolve(ROOT, "web/data/shapes/cache"),
  out: resolve(ROOT, "tools/reference/out-shadow"),
  limit: 0,
  maxCandidates: 6,
  delayMs: 120,
  refresh: false,
  ids: null,
};

/** 解析 CLI 参数 */
function parseArgs(argv) {
  const args = { ...DEFAULT };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--queries") args.queries = resolve(process.cwd(), argv[++i]);
    else if (arg === "--cache") args.cache = resolve(process.cwd(), argv[++i]);
    else if (arg === "--out") args.out = resolve(process.cwd(), argv[++i]);
    else if (arg === "--limit") args.limit = Number(argv[++i]) || 0;
    else if (arg === "--max-candidates") args.maxCandidates = Number(argv[++i]) || 3;
    else if (arg === "--delay") args.delayMs = Number(argv[++i]) || 0;
    else if (arg === "--refresh") args.refresh = true;
    else if (arg === "--id") args.ids = String(argv[++i]).split(",").map((id) => id.trim()).filter(Boolean);
    else if (arg === "--help" || arg === "-h") {
      console.log("用法：node tools/reference/shadow-retrieval.mjs [--limit N] [--refresh] [--delay ms] [--max-candidates N]");
      process.exit(0);
    }
  }
  return args;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const REJECT_TTL_DAYS = 30;

/** 读取/写入 JSON */
function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

/** 加载未过期拒绝记录（坏候选不反复进入下载/转换流程） */
function loadRejects(path) {
  const raw = readJson(path, {}) || {};
  const now = Date.now();
  const ttl = REJECT_TTL_DAYS * 24 * 3600 * 1000;
  const fresh = {};
  for (const [uuid, entry] of Object.entries(raw)) {
    const at = Date.parse(entry?.at || 0);
    if (Number.isFinite(at) && now - at <= ttl) fresh[uuid] = entry;
  }
  return fresh;
}

/** 记录转换被拒的候选 */
function recordRejects(path, rejects, attempts) {
  let changed = false;
  for (const attempt of attempts) {
    if (attempt.status !== "conversion-rejected" && attempt.status !== "convert-failed") continue;
    const uuid = attempt.candidate?.uuid;
    if (!uuid) continue;
    rejects[uuid] = {
      uuid,
      scientificName: attempt.candidate.scientificName || attempt.candidate.title || "",
      license: attempt.candidate.license || "",
      reasons: attempt.reasons || [],
      at: new Date().toISOString(),
    };
    changed = true;
  }
  if (changed) writeJson(path, rejects);
  return changed;
}

/** 带超时的 fetch 文本 */
async function fetchText(url, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

/** 候选摘要（报告用，不塞 SVG） */
function summarizeCandidate(candidate) {
  return {
    uuid: candidate.uuid,
    scientificName: candidate.scientificName || candidate.title,
    title: candidate.title || null,
    generalNode: candidate.generalNode || null,
    license: candidate.license,
    attribution: candidate.attribution,
    sourceUrl: candidate.sourceUrl,
    vectorUrl: candidate.vectorUrl,
    sourceName: candidate.sourceName || "PhyloPic",
    sourceId: candidate.sourceId || candidate.uuid,
  };
}

/** 选中候选与查询的语义匹配级别（客观、可复核；不等于视觉评审）
 *
 * 只有命中“主学名”（scientificNames[0]）才算 exact；
 * 命中后续兜底的属名/支系名只算 genus-or-clade，避免把兜底当精确命中。
 */
function matchLevel(candidate, query) {
  const names = (query.scientificNames || []).map((name) => String(name).toLowerCase());
  if (names.length === 0) return "not-applicable";
  const primary = names[0] || "";
  const title = String(candidate.scientificName || candidate.title || "").toLowerCase();
  const general = String(candidate.generalNode || "").toLowerCase();
  if (!title) return "mismatch";
  if (primary && (title === primary || title.startsWith(`${primary} `))) return "exact";
  const genusOrFallback = names.some((name) => {
    if (!name) return false;
    if (title === name || title.startsWith(`${name} `)) return true;
    const genus = name.split(" ")[0];
    return (
      (genus && title.startsWith(`${genus} `)) ||
      general === name ||
      (genus && general.startsWith(`${genus} `))
    );
  });
  return genusOrFallback ? "genus-or-clade" : "mismatch";
}

/** 从 images 响应中取候选（节点 → 支系依次尝试） */
async function fetchImagesForNode(node, build, cacheTrace) {
  for (const clade of [false, true]) {
    try {
      const meta = await fetchJson(buildImagesUrl({ nodeUuid: node.uuid, build, clade }));
      const total = meta.totalItems || 0;
      cacheTrace.push({ node: node.title, mode: clade ? "clade" : "node", total });
      if (total === 0) continue;
      const page = await fetchJson(buildImagesUrl({ nodeUuid: node.uuid, build, clade, page: 0, embed: true }));
      const images = parseImages(page);
      if (images.length > 0) return images;
    } catch (error) {
      cacheTrace.push({ node: node.title, mode: clade ? "clade" : "node", error: String(error.message || error) });
    }
  }
  return [];
}

/** 主流程 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.cache, { recursive: true });
  mkdirSync(args.out, { recursive: true });
  const queryCacheDir = resolve(args.cache, "queries");
  const imageCacheDir = resolve(args.cache, "phylopic");
  const openclipartDir = resolve(args.cache, "openclipart");
  const openclipartMetaDir = resolve(openclipartDir, "meta");
  const rejectsPath = resolve(args.cache, "rejects.json");
  const rejects = loadRejects(rejectsPath);
  mkdirSync(queryCacheDir, { recursive: true });
  mkdirSync(imageCacheDir, { recursive: true });
  mkdirSync(openclipartMetaDir, { recursive: true });

  /** Openclipart：搜索页 → 详情页 → 候选（公有领域对象素材） */
  async function searchOpenclipart(query, trace) {
    const terms = (query.searchTerms || []).filter(Boolean).slice(0, 3);
    if (terms.length === 0) terms.push(query.en || query.zh);
    const found = new Map();
    for (const term of terms.slice(0, 2)) {
      try {
        await sleep(args.delayMs);
        const html = await fetchText(buildSearchUrl(term));
        const results = parseOpenclipartSearch(html);
        trace.push({ step: "openclipart-search", term, count: results.length });
        for (const item of results) {
          if (!found.has(item.id)) found.set(item.id, { ...item, term });
        }
      } catch (error) {
        trace.push({ step: "openclipart-search", term, error: String(error.message || error) });
      }
    }
    const relevanceTerm = query.en || query.zh || "";
    const ordered = [...found.values()]
      .sort((a, b) => relevanceScore(a.title, relevanceTerm) - relevanceScore(b.title, relevanceTerm) || titleScore(a.title) - titleScore(b.title))
      .slice(0, 8);
    const candidates = [];
    for (const item of ordered) {
      try {
        const metaPath = resolve(openclipartMetaDir, `${item.id}.json`);
        let detail = args.refresh ? null : readJson(metaPath);
        if (!detail) {
          await sleep(args.delayMs);
          detail = parseDetail(await fetchText(item.detailUrl));
          writeJson(metaPath, detail);
        }
        if (rejects[`oc-${item.id}`]) continue;
        candidates.push(buildOpenclipartCandidate(item, detail));
      } catch (error) {
        trace.push({ step: "openclipart-detail", id: item.id, error: String(error.message || error) });
      }
    }
    trace.push({ step: "openclipart-candidates", count: candidates.length });
    return candidates;
  }

  const queries = readJson(args.queries)?.queries || [];
  let selectedQueries = args.limit > 0 ? queries.slice(0, args.limit) : queries;
  if (args.ids) selectedQueries = selectedQueries.filter((query) => args.ids.includes(query.id));
  console.log(`[shadow] 查询 ${selectedQueries.length} 条；缓存 ${args.cache}`);
  const build = (await fetchJson("https://api.phylopic.org")).build;
  console.log(`[shadow] PhyloPic build=${build}`);

  const results = [];
  for (let index = 0; index < selectedQueries.length; index += 1) {
    const query = selectedQueries[index];
    const cachePath = resolve(queryCacheDir, `${query.id}.json`);
    const cached = !args.refresh ? readJson(cachePath) : null;
    if (cached) {
      // 缓存记录可能来自旧版统计口径，加载时按当前规则重算 matchLevel / source
      cached.source = cached.source || query.source || "phylopic";
      if (cached.selected) cached.selected.matchLevel = matchLevel(cached.selected.candidate, query);
      console.log(`[${index + 1}/${selectedQueries.length}] ${query.id} 命中缓存（${cached.status}）`);
      results.push(cached);
      continue;
    }
    console.log(`[${index + 1}/${selectedQueries.length}] ${query.id} (${query.zh})`);
    const searchTrace = [];
    const started = Date.now();
    const searchCandidates = async (q) => {
      if ((q.source || "phylopic") === "openclipart") return searchOpenclipart(q, searchTrace);
      const names = q.scientificNames || [];
      if (names.length === 0) {
        searchTrace.push({ step: "no-scientific-name" });
        return [];
      }
      const nodesSeen = new Map();
      for (const name of names) {
        const meta = await fetchJson(buildNodeSearchUrl({ name, build }));
        const total = meta.totalItems || 0;
        searchTrace.push({ step: "node-search", name: name.toLowerCase(), total });
        if (total === 0) continue;
        const nodePage = await fetchJson(buildNodeSearchUrl({ name, build, page: 0 }));
        const nodes = parseNodeSearch(nodePage);
        searchTrace[searchTrace.length - 1].nodes = nodes.map((node) => node.title);
        for (const node of nodes) nodesSeen.set(node.uuid, node);
      }
      // 先精确匹配学名，再属/支系，最后其余；所有节点都收候选，避免"第一个节点有图就停"
      const normalized = names.map((name) => name.toLowerCase());
      const nodeScore = (node) => {
        const title = String(node.title || "").toLowerCase();
        if (normalized.includes(title)) return 0;
        if (normalized.some((name) => title.startsWith(`${name} `) || name.startsWith(`${title} `))) return 1;
        if (normalized.some((name) => title.startsWith(name.split(" ")[0]))) return 1;
        return 2;
      };
      const orderedNodes = [...nodesSeen.values()].sort((a, b) => nodeScore(a) - nodeScore(b));
      const candidates = [];
      const seen = new Set();
      for (const node of orderedNodes) {
        const images = await fetchImagesForNode(node, build, searchTrace);
        for (const candidate of images) {
          if (seen.has(candidate.uuid) || rejects[candidate.uuid]) continue;
          seen.add(candidate.uuid);
          candidates.push(candidate);
        }
      }
      return candidates;
    };
    const downloadSvg = async (candidate) => {
      const isOpenclipart = candidate.sourceName === "Openclipart";
      const cacheDir = isOpenclipart ? openclipartDir : imageCacheDir;
      const filePath = resolve(cacheDir, `${candidate.uuid}.svg`);
      if (!args.refresh && existsSync(filePath)) return readFileSync(filePath, "utf8");
      await sleep(args.delayMs);
      const svg = await fetchText(candidate.vectorUrl);
      writeFileSync(filePath, svg, "utf8");
      writeJson(resolve(cacheDir, `${candidate.uuid}.json`), {
        ...summarizeCandidate(candidate),
        downloadedAt: new Date().toISOString(),
      });
      return svg;
    };
    let resolved;
    try {
      resolved = await resolveReferenceShape({
        query,
        searchCandidates,
        downloadSvg,
        convert: (svg) => convertSvg(svg),
        maxCandidates: args.maxCandidates,
      });
    } catch (error) {
      resolved = { status: "failed", query, selected: null, attempts: [], error: `shadow 异常：${error.message || error}` };
    }
    const record = {
      id: query.id,
      zh: query.zh,
      en: query.en,
      group: query.group,
      source: query.source || "phylopic",
      scientificNames: query.scientificNames || [],
      status: resolved.status,
      poolSize: resolved.poolSize ?? 0,
      selected: resolved.selected
        ? {
            candidate: summarizeCandidate(resolved.selected.candidate),
            matchLevel: matchLevel(resolved.selected.candidate, query),
            aspect: resolved.selected.conversion.T?.aspect ?? null,
            pointCount: resolved.selected.conversion.T?.pointCount ?? null,
            maxDeviationPct: resolved.selected.conversion.metrics?.sourceToTargetMaxPct ?? null,
            simplification: resolved.selected.conversion.T?.simplification ?? null,
            points: resolved.selected.conversion.T?.points ?? null,
          }
        : null,
      attempts: resolved.attempts.map((attempt) => ({
        candidate: summarizeCandidate(attempt.candidate),
        status: attempt.status,
        reasons: attempt.reasons,
        conversionStatus: attempt.conversion?.status ?? null,
        maxDeviationPct: attempt.conversion?.metrics?.sourceToTargetMaxPct ?? null,
      })),
      searchTrace,
      error: resolved.error,
      elapsedMs: Date.now() - started,
    };
    recordRejects(rejectsPath, rejects, resolved.attempts || []);
    writeJson(cachePath, record);
    results.push(record);
  }

  // 汇总
  const summary = {
    totalQueries: results.length,
    withScientificName: results.filter((item) => item.scientificNames.length > 0).length,
    withoutScientificName: results.filter((item) => item.scientificNames.length === 0).length,
    searchedWithNode: results.filter((item) => item.searchTrace.some((entry) => entry.step === "node-search" && (entry.nodes?.length || 0) > 0)).length,
    queriesWithCandidates: results.filter((item) => item.attempts.length > 0).length,
    queriesWithPool: results.filter((item) => item.poolSize > 0).length,
    totalCandidatePool: results.reduce((sum, item) => sum + (item.poolSize || 0), 0),
    knownBadCandidates: Object.keys(rejects).length,
    selected: results.filter((item) => item.status === "ok").length,
    failed: results.filter((item) => item.status !== "ok").length,
    geometryAutoSelectRate: null,
    semanticReview: "pending（自动选择只按节点/许可/几何转换排序，不代表语义正确）",
    licenseCounts: {},
    failureReasons: {},
    generatedAt: new Date().toISOString(),
    phylopicBuild: build,
  };
  const withCandidates = results.filter((item) => item.attempts.length > 0).length;
  summary.geometryAutoSelectRate = withCandidates > 0 ? Number((summary.selected / withCandidates * 100).toFixed(1)) : null;
  const selectedItems = results.filter((item) => item.status === "ok");
  summary.selectedExact = selectedItems.filter((item) => item.selected?.matchLevel === "exact").length;
  summary.selectedGenusOrClade = selectedItems.filter((item) => item.selected?.matchLevel === "genus-or-clade").length;
  summary.selectedMismatch = selectedItems.filter((item) => item.selected?.matchLevel === "mismatch").length;
  summary.selectedNotApplicable = selectedItems.filter((item) => item.selected?.matchLevel === "not-applicable").length;
  summary.exactSelectionRate = selectedItems.length > 0 ? Number((summary.selectedExact / selectedItems.length * 100).toFixed(1)) : null;

  // 按来源 / 类型统计
  summary.bySource = {};
  summary.byGroup = {};
  for (const item of results) {
    const sourceKey = item.source || "phylopic";
    const groupKey = item.group || "unknown";
    summary.bySource[sourceKey] ||= { total: 0, selected: 0 };
    summary.byGroup[groupKey] ||= { total: 0, selected: 0 };
    summary.bySource[sourceKey].total += 1;
    summary.byGroup[groupKey].total += 1;
    if (item.status === "ok") {
      summary.bySource[sourceKey].selected += 1;
      summary.byGroup[groupKey].selected += 1;
    }
  }

  for (const item of results) {
    for (const attempt of item.attempts) {
      const license = attempt.candidate.license || "UNKNOWN";
      summary.licenseCounts[license] = (summary.licenseCounts[license] || 0) + 1;
    }
    if (item.status !== "ok") {
      const key = item.error || "unknown";
      summary.failureReasons[key] = (summary.failureReasons[key] || 0) + 1;
    }
  }

  writeJson(resolve(args.out, "report.json"), { summary, results });
  writeFileSync(resolve(args.out, "index.html"), renderHtml(results, summary, args), "utf8");
  console.table(results.map((item) => ({
    id: item.id,
    zh: item.zh,
    source: item.source || "phylopic",
    status: item.status,
    pool: item.poolSize,
    candidates: item.attempts.length,
    selected: item.selected?.candidate.scientificName || item.selected?.candidate.title || "-",
    license: item.selected?.candidate.license ?? "-",
    elapsedMs: item.elapsedMs,
    error: item.error ?? "-",
  })));
  console.log(`[shadow] 选中 ${summary.selected}/${summary.totalQueries}；几何/许可口径自动选择率 ${summary.geometryAutoSelectRate}%；语义匹配 exact ${summary.selectedExact} / genus-or-clade ${summary.selectedGenusOrClade} / mismatch ${summary.selectedMismatch} / 非生物 n/a ${summary.selectedNotApplicable}（视觉评审仍待人工）`);
  console.log(`[shadow] 预览：${resolve(args.out, "index.html")}`);
}

/** 渲染 T 轮廓为内联 SVG */
function renderTargetSvg(record, size = 220) {
  const points = record?.selected?.points;
  if (!record || record.status !== "ok" || !points) return `<div class="empty">无选中结果</div>`;
  const padding = 12;
  const inner = size - padding * 2;
  const pixel = points.map(([x, y]) => `${(padding + (x + 0.5) * inner).toFixed(1)},${(padding + (0.5 - y) * inner).toFixed(1)}`).join(" ");
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><rect width="${size}" height="${size}" fill="#fff"/><polygon points="${pixel}" fill="#111"/></svg>`;
}

/** 简化 HTML 转义 */
function html(text) {
  return String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 渲染 shadow 预览页 */
function renderHtml(results, summary, args) {
  const cards = results.map((record) => {
    const attempts = record.attempts
      .map(
        (attempt) =>
          `<li><code>${html(attempt.status)}</code> ${html(attempt.candidate.scientificName || attempt.candidate.title || attempt.candidate.uuid)} · ${html(attempt.candidate.license)}${attempt.reasons.length ? ` · ${html(attempt.reasons.join(","))}` : ""}</li>`,
      )
      .join("");
    const selected = record.selected
      ? `<p class="meta">选中：${html(record.selected.candidate.scientificName || record.selected.candidate.title || record.selected.candidate.uuid)} · ${html(record.selected.candidate.license)} · <b>${html(record.selected.matchLevel)}</b> · aspect ${record.selected.aspect} · ${record.selected.pointCount} 点 · 偏差 ${record.selected.maxDeviationPct}%</p>
         <p class="meta"><a href="${html(record.selected.candidate.sourceUrl)}" target="_blank" rel="noreferrer">来源</a>${record.selected.simplification ? ` · RDP ε=${record.selected.simplification.epsilon}` : ""}</p>`
      : `<p class="meta error">失败：${html(record.error)}</p>`;
    return `<article class="card">
      <header><h2>${html(record.zh)} <span class="en">${html(record.en)}</span></h2><span class="status ${record.status}">${record.status}</span></header>
      <p class="meta">来源：${html(record.source || "phylopic")} · ${html(record.scientificNames.join(" / ") || "（非生物对象，无学名）")} · 候选池 ${record.poolSize} · ${record.elapsedMs}ms</p>
      <div class="body"><figure>${renderTargetSvg(record)}<figcaption>T 轮廓</figcaption></figure>
      <div class="details">${selected}<ul class="attempts">${attempts || "<li>无候选</li>"}</ul>
      <details><summary>检索轨迹</summary><pre>${html(JSON.stringify(record.searchTrace, null, 1))}</pre></details></div></div>
    </article>`;
  }).join("\n");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/><title>在线检索 shadow</title>
<style>
*{box-sizing:border-box}body{margin:0;padding:26px;background:#f1f5f9;color:#172033;font-family:"Microsoft YaHei",sans-serif}
h1{margin:0 0 6px;font-size:24px}.summary{color:#526078;margin:0 0 18px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(560px,1fr));gap:16px}
.card{background:#fff;border:1px solid #d7deea;border-radius:12px;padding:14px}.card header{display:flex;align-items:center;gap:10px}
.card h2{margin:0;font-size:18px}.en{color:#94a3b8;font-size:13px}.status{margin-left:auto;padding:2px 8px;border-radius:999px;font-size:12px}
.status.ok{background:#dcfce7;color:#166534}.status.failed{background:#fee2e2;color:#991b1b}
.body{display:grid;grid-template-columns:240px 1fr;gap:14px;margin-top:10px}figure{margin:0}figcaption{text-align:center;color:#64748b;font-size:12px}
.meta{margin:4px 0;color:#526078;font-size:12px;word-break:break-all}.error{color:#991b1b}
.attempts{margin:8px 0;padding-left:18px;font-size:12px;color:#334155}.attempts code{color:#7c3aed}
details{font-size:12px;color:#64748b}pre{white-space:pre-wrap;font-size:11px;background:#f8fafc;padding:8px;border-radius:8px;max-height:180px;overflow:auto}
.empty{display:flex;align-items:center;justify-content:center;width:100%;height:220px;background:#f8fafc;color:#94a3b8;border-radius:8px;font-size:13px}
</style></head><body>
<h1>在线检索 shadow（PhyloPic + Openclipart）</h1>
<p class="summary">查询 ${summary.totalQueries} 条；选中 ${summary.selected} 条；有候选池查询 ${summary.queriesWithPool} 条；几何/许可口径自动选择率 ${summary.geometryAutoSelectRate}%；build ${summary.phylopicBuild}。
按来源：${Object.entries(summary.bySource || {}).map(([key, value]) => `${key} ${value.selected}/${value.total}`).join("；")}。
语义匹配：exact ${summary.selectedExact} / genus-or-clade ${summary.selectedGenusOrClade} / mismatch ${summary.selectedMismatch} / 非生物 n/a ${summary.selectedNotApplicable}。
<b>语义是否真的“像”仍需人工/视觉抽检</b>——自动选择只按节点匹配、许可与几何转换排序，不代表语义正确。</p>
<div class="grid">${cards}</div>
</body></html>`;
}

main().catch((error) => {
  console.error(`[shadow] 失败：${error.stack || error}`);
  process.exit(1);
});
