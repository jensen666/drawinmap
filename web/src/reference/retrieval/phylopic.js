/**
 * PhyloPic 在线检索适配（纯函数 + 可注入 fetch，Node / 浏览器通用）。
 *
 * 只负责“查节点 → 列图片 → 解析候选 → 许可/几何排序”，不做下载与转换；
 * 下载/缓存/转换在 tools/reference/shadow-retrieval.mjs 与 convert.js。
 */

import { createAbortError, isAborted, linkSignals, throwIfAborted } from '../../cancel.js';

export const PHYLOPIC_BASE = 'https://api.phylopic.org';

/** 第一阶段允许的在线素材许可（与本地 manifest 共用同一白名单，见 ../licenses.js） */
export { ALLOWED_REFERENCE_LICENSES as ALLOWED_ONLINE_LICENSES } from '../licenses.js';

/** 许可 URL → 内部 SPDX 标记 */
export function licenseFromUrl(url) {
  const text = String(url || '').toLowerCase();
  if (!text) return { spdx: 'UNKNOWN', allowed: false, attributionRequired: false };
  if (text.includes('publicdomain/zero')) return { spdx: 'CC0-1.0', allowed: true, attributionRequired: false };
  if (text.includes('publicdomain/mark')) return { spdx: 'PDM-1.0', allowed: true, attributionRequired: false };
  if (text.includes('licenses/by/4.0')) return { spdx: 'CC-BY-4.0', allowed: true, attributionRequired: true };
  if (text.includes('licenses/by-sa') || text.includes('licenses/by-nc')) {
    return { spdx: 'CC-BY-SA/NC', allowed: false, attributionRequired: true };
  }
  return { spdx: 'UNKNOWN', allowed: false, attributionRequired: false };
}

/** 许可排序：无义务 < 仅署名 < 其余 */
export function licenseRank(spdx) {
  if (spdx === 'CC0-1.0' || spdx === 'PDM-1.0' || spdx === 'Public-Domain') return 0;
  if (spdx === 'CC-BY-4.0') return 1;
  return 2;
}

/** 构造节点搜索 URL（PhyloPic 要求带 build；name 必须小写，否则查询不到） */
export function buildNodeSearchUrl({ name, build, baseUrl = PHYLOPIC_BASE, page = null }) {
  const params = new URLSearchParams({ build: String(build), filter_name: String(name).toLowerCase() });
  if (page !== null) params.set('page', String(page));
  return `${baseUrl}/nodes?${params.toString()}`;
}

/** 构造图片列表 URL（可按节点或支系；page 为 null 时只取列表元数据） */
export function buildImagesUrl({ nodeUuid, build, baseUrl = PHYLOPIC_BASE, clade = false, page = null, embed = false }) {
  const key = clade ? 'filter_clade' : 'filter_node';
  const params = new URLSearchParams({ build: String(build), [key]: String(nodeUuid) });
  if (page !== null) params.set('page', String(page));
  if (embed) params.set('embed_items', 'true');
  return `${baseUrl}/images?${params.toString()}`;
}

/** 把 API 返回的相对 href 补成绝对 URL */
export function resolveApiUrl(href, baseUrl = PHYLOPIC_BASE) {
  if (!href) return null;
  return /^https?:\/\//i.test(href) ? href : `${baseUrl}${href.startsWith('/') ? '' : '/'}${href}`;
}

/** 解析节点搜索结果 */
export function parseNodeSearch(payload) {
  const items = payload?._links?.items || [];
  return items.map((item) => ({ uuid: String(item.href).split('/').pop().split('?')[0], title: item.title || '' }));
}

/** 从 images 响应中挑出可见的 raster/vector 链接 */
function mediaOf(item) {
  const links = item?._links || {};
  const vectorUrl = links.vectorFile?.href || null;
  const rasterFiles = (links.rasterFiles || [])
    .map((file) => {
      const [width, height] = String(file.sizes || '').split('x').map(Number);
      return { url: file.href, width, height };
    })
    .filter((file) => file.url && Number.isFinite(file.width));
  rasterFiles.sort((a, b) => b.width - a.width);
  const raster = rasterFiles.find((file) => file.width >= 400) || rasterFiles[rasterFiles.length - 1] || null;
  return { vectorUrl, raster };
}

/**
 * 解析图片列表响应为候选。
 *
 * @returns {Array<object>} 候选（含许可/署名/来源/科学名/媒体链接）
 */
export function parseImages(payload) {
  const items = payload?._embedded?.items || [];
  return items.map((item) => {
    const links = item?._links || {};
    const license = licenseFromUrl(links.license?.href || '');
    const specificNode = links.specificNode?.title || '';
    const generalNode = links.generalNode?.title || '';
    const media = mediaOf(item);
    return {
      uuid: item.uuid,
      title: specificNode || generalNode || item?.uuid || 'unknown',
      scientificName: specificNode,
      generalNode,
      licenseUrl: links.license?.href || null,
      license: license.spdx,
      licenseAllowed: license.allowed,
      attributionRequired: license.attributionRequired,
      attribution: item.attribution || null,
      vectorUrl: media.vectorUrl,
      rasterUrl: media.raster?.url || null,
      rasterWidth: media.raster?.width || 0,
      sourceUrl: `https://www.phylopic.org/images/${item.uuid}`,
      sourceName: 'PhyloPic',
    };
  });
}

/**
 * 候选排序：节点精确匹配 > 许可义务少 > 有矢量 > raster 宽。
 *
 * @param {Array<object>} candidates 候选
 * @param {{scientificNames?: string[]}} [options]
 * @returns {Array<object>} 排序后的新数组
 */
export function rankCandidates(candidates, { scientificNames = [] } = {}) {
  const normalizedNames = scientificNames.map((name) => String(name).trim().toLowerCase()).filter(Boolean);
  const nodeScore = (candidate) => {
    const title = String(candidate.scientificName || candidate.title || '').toLowerCase();
    if (!title) return 2;
    // 学名精确，或查询名是候选名的前缀（亚种，例如 Homo sapiens → Homo sapiens njarasensis）
    const exact = normalizedNames.some((name) => title === name || title.startsWith(`${name} `));
    if (exact) return 0;
    const partial = normalizedNames.some((name) => title.startsWith(name) || name.startsWith(title));
    if (partial) return 1;
    const genus = normalizedNames.some((name) => {
      const first = name.split(' ')[0];
      return first && title.startsWith(`${first} `);
    });
    return genus ? 1 : 2;
  };
  return candidates
    .slice()
    .sort((a, b) => {
      const node = nodeScore(a) - nodeScore(b);
      if (node !== 0) return node;
      const license = licenseRank(a.license) - licenseRank(b.license);
      if (license !== 0) return license;
      const vector = Number(Boolean(b.vectorUrl)) - Number(Boolean(a.vectorUrl));
      if (vector !== 0) return vector;
      return (b.rasterWidth || 0) - (a.rasterWidth || 0);
    });
}

/** 带超时/重试的 JSON 请求（fetch 可注入，便于测试）。
 * signal（外部中止，如用户点"停止"）与内部超时共同控制：外部中止立即上抛、不重试
 * （缺陷清单 Bug 1.6.6 顺带修——此前用户停止无法中断在线元数据检索）。 */
export async function fetchJson(url, { fetchImpl = globalThis.fetch, timeoutMs = 15000, retries = 2, delayMs = 400, signal = null } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    throwIfAborted(signal, '已停止');
    const controller = new AbortController();
    const unlink = signal ? linkSignals(signal, controller) : null;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      // 外部中止不是可重试失败：立即上抛（内部超时同样是 AbortError，
      // 以外部 signal 是否已 aborted 区分——未 aborted 说明是超时，保持重试旧语义）。
      // 注意不能给原错误赋值 name：真实 fetch 抛的是 DOMException，其 name 是
      // 原型只读访问器，严格模式下赋值会抛 TypeError 掩盖中止——包装新错误并保留原因。
      if (isAborted(signal)) {
        const abortError = createAbortError('在线元数据检索已中止');
        abortError.cause = error;
        throw abortError;
      }
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
      }
    } finally {
      clearTimeout(timer);
      unlink?.();
    }
  }
  throw lastError || new Error('请求失败');
}
