/**
 * 在线检索服务端逻辑（方案 2026-10-31 §9.2/§9.4）。
 *
 * 浏览器只请求同源 /__reference/*，不直接访问外部素材站；本模块负责查询校验、
 * 源适配（PhyloPic 默认，Openclipart experimental 默认关闭）、外部请求、下载缓存、
 * 拒绝记录与超时。纯逻辑 + 注入 fetch/storage，Node 测试可直接导入；
 * server.mjs 负责端口接线与请求体上限。
 *
 * 缓存（web/data/shapes/cache/）：
 * - queries/<hash>.json  查询缓存（规范化查询 + 候选元数据，24 小时有效）；
 * - <source>/<uuid>.svg/.json  原始素材缓存（按来源 id 复用，许可与来源元数据不可丢）；
 * - rejects.json  转换拒绝记录（30 天 TTL，坏候选不反复进入下载/转换）。
 * 缓存中的在线素材仍为 unreviewed，命中缓存不等于人工审核通过（§9.4）。
 *
 * 输出是 §5.2 的 raw candidates（conversion.T 是 convertSvg 输出，不是 customShape；
 * 不 import Agent 的意图归一化模块），浏览器统一归一化并补位（§5.3）。
 */

import {
  buildImagesUrl,
  buildNodeSearchUrl,
  fetchJson,
  parseImages,
  parseNodeSearch,
  rankCandidates,
  resolveApiUrl,
  PHYLOPIC_BASE,
} from '../../src/reference/retrieval/phylopic.js';
import {
  buildCandidate as buildOpenclipartCandidate,
  buildDetailUrl,
  buildSearchUrl,
  parseDetail,
  parseSearch as parseOpenclipartSearch,
  relevanceScore,
  titleScore,
  OPENCLIPART_BASE,
} from './retrieval/openclipart.js';
import { resolveReferenceCandidates, REFERENCE_MAX_ATTEMPTS } from '../../src/reference/retrieval/resolve.js';
import { convertSvg } from '../../src/reference/convert.js';
import { sha256NormalizedText } from '../../src/reference/hash.js';
import { linkSignals } from '../../src/cancel.js';

/** 查询缓存有效期（毫秒，方案 §9.4：初版 24 小时） */
const QUERY_CACHE_TTL_MS = 24 * 3600 * 1000;

/** 转换拒绝缓存有效期（30 天，与 shadow 工具一致） */
const REJECT_TTL_MS = 30 * 24 * 3600 * 1000;

/** 单个 SVG 素材字节数上限（防异常大文件打爆内存/响应） */
const MAX_SVG_BYTES = 3 * 1024 * 1024;

/** 主机白名单后缀（方案 §9.2：不把任意 URL 转发做成开放代理，源与下载地址必须来自
 * 固定适配器的来源域）。按来源域后缀匹配而不是固定主机名枚举：PhyloPic 的矢量文件
 * 实际托管在 images.phylopic.org（CDN 子域可能变化），按后缀匹配避免子域变化再次
 * 静默打挂整条在线通道（2026-11-06 缺陷清单 Bug 1 主因）。协议仍必须 https。 */
const HOST_SUFFIX_ALLOWLIST = Object.freeze(['phylopic.org', 'openclipart.org']);

/** 查询字段上限（与浏览器 normalizeReferenceQuery 同口径的独立实现——
 * 服务端不 import Agent 的意图归一化模块，方案 §5.2） */
const QUERY_LIMITS = Object.freeze({
  zh: 30,
  en: 40,
  scientificName: 60,
  searchTerm: 40,
  trait: 20,
  scientificNames: 4,
  searchTerms: 4,
  traits: 8,
});

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[\u0000-\u001f<>"]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
  return cleaned || null;
}

function cleanList(list, maxItems, maxLength) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    const cleaned = cleanText(item, maxLength);
    if (cleaned && !out.includes(cleaned)) out.push(cleaned);
    if (out.length >= maxItems) break;
  }
  return out;
}

/**
 * 校验并规范化在线检索查询（非法输入按空处理，不抛错——坏查询返回"无候选"而不是 500）。
 *
 * @param {*} raw 请求体里的 referenceQuery
 * @returns {object|null} 规范化查询；无有效内容返回 null
 */
export function normalizeOnlineQuery(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const zh = cleanText(raw.zh, QUERY_LIMITS.zh);
  const en = cleanText(raw.en, QUERY_LIMITS.en);
  const scientificNames = cleanList(raw.scientificNames, QUERY_LIMITS.scientificNames, QUERY_LIMITS.scientificName);
  const searchTerms = cleanList(raw.searchTerms, QUERY_LIMITS.searchTerms, QUERY_LIMITS.searchTerm);
  const traits = cleanList(raw.traits, QUERY_LIMITS.traits, QUERY_LIMITS.trait);
  if (!zh && !en && scientificNames.length === 0 && searchTerms.length === 0) return null;
  return { zh, en, scientificNames, searchTerms, traits };
}

/** 下载 URL 主机是否在白名单（方案 §9.2：固定适配器 + 来源域后缀白名单，不做开放代理；
 * 必须 https——在线素材下载不该降级到明文）。 */
function hostAllowed(urlText) {
  try {
    const url = new URL(String(urlText));
    if (url.protocol !== 'https:') {
      return false;
    }
    const hostname = url.hostname.toLowerCase();
    return HOST_SUFFIX_ALLOWLIST.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

/** 上游素材 uuid 字符白名单：uuid 直接拼进缓存路径，非 [A-Za-z0-9_-] 一律不进下载
 * （方案 §9.2 路径校验；此前 startsWith 缺分隔符 + uuid 未校验两层都要补） */
function candidateUuidSafe(uuid) {
  return typeof uuid === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(uuid);
}

/** 带超时与外部中止传播的 fetch 文本 */
async function fetchText(url, { fetchImpl = globalThis.fetch, timeoutMs = 20000, signal = null } = {}) {
  if (!hostAllowed(url)) {
    throw new Error(`下载地址不在主机白名单：${new URL(url).hostname}`);
  }
  const controller = new AbortController();
  const unlink = linkSignals(signal, controller);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const length = Number(response.headers?.get?.('content-length') || 0);
    if (length > MAX_SVG_BYTES) {
      throw new Error(`素材超过 ${MAX_SVG_BYTES} 字节上限`);
    }
    const text = await response.text();
    if (text.length > MAX_SVG_BYTES) {
      throw new Error(`素材超过 ${MAX_SVG_BYTES} 字节上限`);
    }
    return text;
  } finally {
    clearTimeout(timer);
    unlink();
  }
}

/** 内存存储（测试用）；server.mjs 注入 node:fs 实现 */
function memoryStorage() {
  const files = new Map();
  return {
    async readText(path) {
      return files.has(path) ? files.get(path) : null;
    },
    async writeText(path, text) {
      files.set(path, String(text));
    },
  };
}

/**
 * 创建在线检索服务。
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl] 外部请求实现（默认 globalThis.fetch）
 * @param {{readText: (path: string) => Promise<string|null>,
 *   writeText: (path: string, text: string) => Promise<void>}} [options.storage]
 *   缓存存储（相对 cache 根的路径；缺省内存存储 = 无缓存能力）
 * @param {string[]} [options.sources] 启用的生产源（默认 ['phylopic']）
 * @param {{openclipart?: boolean}} [options.experimental] experimental 源开关
 *   （方案 §9.5：Openclipart 依赖 HTML 解析，默认关闭，项目负责人明确接受后才启用）
 * @param {number} [options.timeoutMs] 单请求超时
 * @param {number} [options.maxAttempts] 下载/转换尝试上限（默认 6）
 * @param {number} [options.delayMs] 上游请求间隔（礼貌抓取）
 * @returns {{ping: () => object, search: (input: object) => Promise<object>}}
 */
export function createOnlineReferenceService({
  fetchImpl = globalThis.fetch,
  storage = memoryStorage(),
  sources = ['phylopic'],
  experimental = {},
  timeoutMs = 20000,
  maxAttempts = REFERENCE_MAX_ATTEMPTS,
  delayMs = 0,
} = {}) {
  const enabledSources = (Array.isArray(sources) && sources.includes('phylopic') ? ['phylopic'] : []).slice();
  const experimentalSources = experimental?.openclipart ? ['openclipart'] : [];
  const sleep = (ms) => (ms > 0 ? new Promise((done) => setTimeout(done, ms)) : Promise.resolve());

  /** 能力探测（方案 §9.1）：浏览器在本地无候选后才探测 */
  function ping() {
    return {
      ok: true,
      sources: enabledSources,
      experimentalSources,
    };
  }

  /** 拒绝记录（30 天 TTL） */
  async function loadRejects() {
    const raw = await storage.readText('rejects.json');
    if (!raw) return {};
    let parsed = {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {};
    }
    const now = Date.now();
    const fresh = {};
    for (const [uuid, entry] of Object.entries(parsed || {})) {
      const at = Date.parse(entry?.at || 0);
      if (Number.isFinite(at) && now - at <= REJECT_TTL_MS) {
        fresh[uuid] = entry;
      }
    }
    return fresh;
  }

  async function recordRejects(rejects, attempts) {
    let changed = false;
    for (const attempt of attempts) {
      if (attempt.status !== 'conversion-rejected' && attempt.status !== 'convert-failed') continue;
      const uuid = attempt.candidate?.uuid;
      if (!uuid || rejects[uuid]) continue;
      rejects[uuid] = {
        uuid,
        scientificName: attempt.candidate.scientificName || attempt.candidate.title || '',
        license: attempt.candidate.license || '',
        reasons: attempt.reasons || [],
        at: new Date().toISOString(),
      };
      changed = true;
    }
    if (changed) {
      await storage.writeText('rejects.json', JSON.stringify(rejects, null, 2));
    }
  }

  /** 原始素材缓存读取/下载（许可与来源元数据不可丢，方案 §9.4） */
  async function loadOrDownloadSvg(candidate, { signal, cacheDir }) {
    if (!candidateUuidSafe(candidate.uuid)) {
      throw new Error(`候选 uuid 不合法，拒绝拼进缓存路径：${String(candidate.uuid).slice(0, 20)}`);
    }
    const file = `${cacheDir}/${candidate.uuid}.svg`;
    const metaFile = `${cacheDir}/${candidate.uuid}.json`;
    const cached = await storage.readText(file);
    if (cached !== null) {
      return cached;
    }
    const vectorUrl = resolveApiUrl(candidate.vectorUrl, candidate.sourceName === 'Openclipart' ? OPENCLIPART_BASE : PHYLOPIC_BASE);
    if (!vectorUrl || !hostAllowed(vectorUrl)) {
      throw new Error(vectorUrl ? `下载地址不在主机白名单` : '候选没有矢量文件');
    }
    await sleep(delayMs);
    const svg = await fetchText(vectorUrl, { fetchImpl, timeoutMs, signal });
    await storage.writeText(file, svg);
    await storage.writeText(
      metaFile,
      JSON.stringify(
        {
          uuid: candidate.uuid,
          title: candidate.title ?? null,
          scientificName: candidate.scientificName ?? null,
          license: candidate.license ?? null,
          licenseUrl: candidate.licenseUrl ?? null,
          attribution: candidate.attribution ?? null,
          sourceUrl: candidate.sourceUrl ?? null,
          sourceName: candidate.sourceName ?? 'PhyloPic',
          sha256: sha256NormalizedText(svg),
          downloadedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    return svg;
  }

  /** PhyloPic 检索：学名/通用名 → 节点 → 图片列表（节点 → 支系） */
  async function searchPhylopic(query, { signal, rejects, trace }) {
    const names = (query.scientificNames || []).slice();
    if (names.length === 0 && query.en) {
      names.push(query.en); // 通用名兜底（可能查不到，不强造学名）
    }
    if (names.length === 0) {
      trace.push({ step: 'no-query-name' });
      return [];
    }
    const meta = await fetchJson(PHYLOPIC_BASE, { fetchImpl, timeoutMs, signal });
    const build = meta.build;
    trace.push({ step: 'phylopic-build', build });
    const nodesSeen = new Map();
    for (const name of names) {
      const nodeMeta = await fetchJson(buildNodeSearchUrl({ name, build }), { fetchImpl, timeoutMs, signal });
      const total = nodeMeta.totalItems || 0;
      trace.push({ step: 'node-search', name: String(name).toLowerCase(), total });
      if (total === 0) continue;
      const nodePage = await fetchJson(buildNodeSearchUrl({ name, build, page: 0 }), { fetchImpl, timeoutMs, signal });
      for (const node of parseNodeSearch(nodePage)) {
        nodesSeen.set(node.uuid, node);
      }
    }
    const normalized = names.map((name) => String(name).toLowerCase());
    const nodeScore = (node) => {
      const title = String(node.title || '').toLowerCase();
      if (normalized.includes(title)) return 0;
      if (normalized.some((name) => title.startsWith(`${name} `) || name.startsWith(`${title} `))) return 1;
      if (normalized.some((name) => title.startsWith(name.split(' ')[0]))) return 1;
      return 2;
    };
    const orderedNodes = [...nodesSeen.values()].sort((a, b) => nodeScore(a) - nodeScore(b));
    const candidates = [];
    const seen = new Set();
    for (const node of orderedNodes) {
      for (const clade of [false, true]) {
        try {
          const imagesMeta = await fetchJson(
            buildImagesUrl({ nodeUuid: node.uuid, build, clade }),
            { fetchImpl, timeoutMs, signal },
          );
          const total = imagesMeta.totalItems || 0;
          if (total === 0) continue;
          const page = await fetchJson(
            buildImagesUrl({ nodeUuid: node.uuid, build, clade, page: 0, embed: true }),
            { fetchImpl, timeoutMs, signal },
          );
          for (const candidate of parseImages(page)) {
            if (seen.has(candidate.uuid) || rejects[candidate.uuid]) continue;
            seen.add(candidate.uuid);
            candidates.push(candidate);
          }
          if (candidates.length >= 24) break;
        } catch (error) {
          trace.push({ step: 'images-failed', node: node.title, mode: clade ? 'clade' : 'node', error: String(error.message || error) });
        }
      }
      if (candidates.length >= 24) break;
    }
    return candidates;
  }

  /** Openclipart 检索（experimental，HTML 解析，默认关闭——方案 §9.5） */
  async function searchOpenclipart(query, { signal, rejects, trace }) {
    const terms = (query.searchTerms || []).filter(Boolean).slice(0, 2);
    if (terms.length === 0 && query.en) terms.push(query.en);
    if (terms.length === 0) return [];
    const found = new Map();
    for (const term of terms) {
      try {
        await sleep(delayMs);
        const html = await fetchText(buildSearchUrl(term), { fetchImpl, timeoutMs, signal });
        for (const item of parseOpenclipartSearch(html)) {
          if (!found.has(item.id)) found.set(item.id, item);
        }
        trace.push({ step: 'openclipart-search', term, count: found.size });
      } catch (error) {
        trace.push({ step: 'openclipart-search', term, error: String(error.message || error) });
      }
    }
    const relevanceTerm = query.en || query.zh || '';
    const ordered = [...found.values()]
      .sort(
        (a, b) =>
          relevanceScore(a.title, relevanceTerm) - relevanceScore(b.title, relevanceTerm) ||
          titleScore(a.title) - titleScore(b.title),
      )
      .slice(0, 8);
    const candidates = [];
    for (const item of ordered) {
      try {
        const metaFile = `openclipart/meta/${item.id}.json`;
        let detail = null;
        const cachedMeta = await storage.readText(metaFile);
        if (cachedMeta !== null) {
          try {
            detail = JSON.parse(cachedMeta);
          } catch {
            detail = null;
          }
        }
        if (!detail) {
          await sleep(delayMs);
          detail = parseDetail(await fetchText(buildDetailUrl(item.id, item.slug), { fetchImpl, timeoutMs, signal }));
          await storage.writeText(metaFile, JSON.stringify(detail, null, 2));
        }
        if (rejects[`oc-${item.id}`]) continue;
        candidates.push(buildOpenclipartCandidate(item, detail));
      } catch (error) {
        trace.push({ step: 'openclipart-detail', id: item.id, error: String(error.message || error) });
      }
    }
    return candidates;
  }

  /** 查询缓存键：规范化查询 + 尝试上限（素材/转换算法变化由 contentHash 在浏览器侧兜底）。
   * v2（缺陷清单 Bug 1.6.5）：修复 images.phylopic.org 主机过滤后升版本，
   * 旧缓存（候选从未进入下载）不再干扰修复验证。 */
  function queryCacheKey(query) {
    return sha256NormalizedText(JSON.stringify({ v: 2, query, maxAttempts, sources: enabledSources, experimental: experimentalSources }));
  }

  /**
   * 在线检索（POST /__reference/search 主体）。
   *
   * @param {{referenceQuery: object, maxAttempts?: number, signal?: AbortSignal}} input
   * @returns {Promise<{ok: true, rawCandidates: Array<object>, attempts: Array<object>,
   *   poolSize: number, failures: Array<object>, cache: object, sources: string[], query: object}>}
   */
  async function search({ referenceQuery, maxAttempts: maxAttemptsInput, signal = null }) {
    const query = normalizeOnlineQuery(referenceQuery);
    if (!query) {
      return {
        ok: true,
        rawCandidates: [],
        attempts: [],
        poolSize: 0,
        failures: [],
        cache: { query: 'invalid' },
        sources: enabledSources,
        query: null,
      };
    }
    const attemptsCap = Math.max(1, Math.min(REFERENCE_MAX_ATTEMPTS, Number(maxAttemptsInput) || maxAttempts));
    const trace = [];
    const rejects = await loadRejects();

    // 查询缓存命中：不产生重复上游请求（方案 §11.3），素材从缓存重放转换
    const cacheKey = queryCacheKey(query);
    const cacheFile = `queries/${cacheKey}.json`;
    let cachedQuery = null;
    const cachedRaw = await storage.readText(cacheFile);
    if (cachedRaw !== null) {
      try {
        const parsed = JSON.parse(cachedRaw);
        if (parsed?.cachedAt && Date.now() - Date.parse(parsed.cachedAt) <= QUERY_CACHE_TTL_MS && Array.isArray(parsed.candidates)) {
          cachedQuery = parsed;
        }
      } catch {
        cachedQuery = null;
      }
    }

    /** @type {Array<object>} 候选元数据（无 SVG） */
    let candidatePool = [];
    let cacheState = 'miss';
    if (cachedQuery) {
      cacheState = 'hit';
      trace.push({ step: 'query-cache-hit', candidates: cachedQuery.candidates.length });
      // 元数据缓存里的 uuid 命中拒绝记录的不再进入尝试（缓存写入后新拒绝仍生效）
      candidatePool = cachedQuery.candidates.filter((candidate) => !rejects[candidate.uuid]);
    } else {
      if (enabledSources.includes('phylopic')) {
        try {
          candidatePool.push(...(await searchPhylopic(query, { signal, rejects, trace })));
        } catch (error) {
          trace.push({ step: 'phylopic-failed', error: String(error.message || error) });
        }
      }
      if (experimentalSources.includes('openclipart')) {
        try {
          candidatePool.push(...(await searchOpenclipart(query, { signal, rejects, trace })));
        } catch (error) {
          trace.push({ step: 'openclipart-failed', error: String(error.message || error) });
        }
      }
      // 写查询缓存（只存候选元数据，不存 SVG）
      await storage.writeText(
        cacheFile,
        JSON.stringify({ query, cachedAt: new Date().toISOString(), candidates: candidatePool }, null, 2),
      );
    }

    const ranked = rankCandidates(candidatePool, { scientificNames: query.scientificNames || [] });
    const svgByUuid = new Map();
    // 资格过滤统计（缺陷清单 Bug 1.6.2 失败可见化）：候选总数、进入尝试数、被过滤数，
    // 上游"有候选但全部被许可/主机/uuid 过滤"不再伪装成"无素材"
    const filterCandidate = (candidate) =>
      Boolean(candidate.vectorUrl) && hostAllowed(candidate.vectorUrl) && candidateUuidSafe(candidate.uuid);
    // 被过滤数与 resolveReferenceCandidates 的两段过滤同口径：许可白名单 +
    // 矢量/来源域/uuid（2026-11-07 复核：此前漏计许可过滤，全许可不可用时
    // 出现 poolSize=0 而 filteredOut=0 的矛盾账目）
    const filteredOutCount = ranked.filter(
      (candidate) => candidate?.licenseAllowed === false || !filterCandidate(candidate),
    ).length;
    const result = await resolveReferenceCandidates({
      query,
      listCandidates: async () => ranked,
      rank: null, // 排序已在 rankCandidates 完成（来源语义主排序）
      filterCandidate,
      downloadSvg: async (candidate) => {
        const svg = await loadOrDownloadSvg(candidate, {
          signal,
          cacheDir: candidate.sourceName === 'Openclipart' ? 'openclipart' : 'phylopic',
        });
        svgByUuid.set(candidate.uuid, svg);
        return svg;
      },
      convert: (svgText) => convertSvg(svgText),
      toRawCandidate: (candidate, conversion) => ({
        asset: {
          uuid: candidate.uuid,
          id: candidate.uuid,
          title: candidate.title ?? null,
          scientificName: candidate.scientificName ?? null,
          license: candidate.license ?? null,
          licenseUrl: candidate.licenseUrl ?? null,
          licenseAllowed: candidate.licenseAllowed !== false,
          attribution: candidate.attribution ?? null,
          sourceUrl: candidate.sourceUrl ?? null,
          sourceName: candidate.sourceName ?? 'PhyloPic',
        },
        conversion,
        matchedAlias: null,
        sourceSha256: sha256NormalizedText(svgByUuid.get(candidate.uuid) ?? ''),
        origin: 'online',
        reviewStatus: 'unreviewed',
      }),
      maxAttempts: attemptsCap,
      signal,
    });
    await recordRejects(rejects, result.attempts);

    // attempts 摘要化（不回传完整 SVG / 大对象）
    const attempts = result.attempts.map((attempt) => ({
      uuid: attempt.candidate?.uuid ?? null,
      title: attempt.candidate?.title ?? null,
      scientificName: attempt.candidate?.scientificName ?? null,
      license: attempt.candidate?.license ?? null,
      status: attempt.status,
      reasons: attempt.reasons ?? [],
      maxDeviationPct: attempt.conversion?.metrics?.sourceToTargetMaxPct ?? null,
    }));
    const baseResult = {
      rawCandidates: result.rawCandidates,
      attempts,
      poolSize: result.poolSize,
      failures: [],
      cache: {
        query: cacheState,
        rejects: Object.keys(rejects).length,
        materials: svgByUuid.size,
      },
      sources: enabledSources,
      query,
      trace,
    };
    // 失败可见化（缺陷清单 Bug 1.6.2）：编排层 failed（检索无候选/全部被过滤/全部转换
    // 失败）不再用 ok:true + 空数组掩盖——状态、错误、attempts、poolSize、被过滤数全部
    // 透传，前端据此区分 no-match / filtered / conversion-failed。
    if (result.status !== 'ok') {
      return {
        ok: false,
        status: result.status,
        error: result.error ?? '在线检索未产出候选',
        failureKind: classifyOnlineFailureKind({ rankedCount: ranked.length, result }),
        filteredOut: filteredOutCount,
        ...baseResult,
      };
    }
    return {
      ok: true,
      status: 'ok',
      error: null,
      filteredOut: filteredOutCount,
      ...baseResult,
    };
  }

  /**
   * 在线检索失败分类（缺陷清单 Bug 1.6.3：前端日志据此区分失败种类，不再把
   * "上游失败/被过滤"与"真的没有素材"混为一谈）。
   *
   * @param {{rankedCount: number, result: {poolSize: number, attempts: Array<object>, error: string|null}}} input
   * @returns {'no-match'|'filtered'|'conversion-failed'|'download-failed'|'failed'} 失败种类
   */
  function classifyOnlineFailureKind({ rankedCount, result }) {
    if (rankedCount === 0) {
      return 'no-match';
    }
    if (result.poolSize === 0) {
      return 'filtered';
    }
    const statuses = new Set((result.attempts || []).map((attempt) => attempt.status));
    if (statuses.size > 0 && [...statuses].every((status) => status === 'download-failed' || status === 'skipped')) {
      return 'download-failed';
    }
    if (statuses.size > 0) {
      return 'conversion-failed';
    }
    return 'failed';
  }

  return { ping, search };
}
