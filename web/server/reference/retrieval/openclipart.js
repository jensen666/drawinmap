/**
 * Openclipart 检索适配（公有领域素材，适合非生物对象）。
 *
 * 站点没有可直接匿名调用的搜索 API，因此解析 server-rendered 搜索页：
 *   搜索页 → /detail/<id>/<slug> → /download/<id>（SVG 原件）
 * 详情页提供标题/作者；Openclipart 作品按站点许可为公有领域。
 */

export const OPENCLIPART_BASE = 'https://openclipart.org';
export const OPENCLIPART_LICENSE = 'Public-Domain';
export const OPENCLIPART_LICENSE_URL = 'https://openclipart.org/license';

/** 构造搜索 URL */
export function buildSearchUrl(term, baseUrl = OPENCLIPART_BASE) {
  return `${baseUrl}/search/?query=${encodeURIComponent(String(term))}`;
}

/** 构造详情页 URL */
export function buildDetailUrl(id, slug = '', baseUrl = OPENCLIPART_BASE) {
  return `${baseUrl}/detail/${id}${slug ? `/${slug}` : ''}`;
}

/** 构造 SVG 下载 URL */
export function buildDownloadUrl(id, baseUrl = OPENCLIPART_BASE) {
  return `${baseUrl}/download/${id}`;
}

/** 解码少量 HTML 实体 */
function decodeEntities(text) {
  return String(text)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/** 解析搜索页里的 /detail/<id>/<slug> 链接，按出现顺序去重 */
export function parseSearch(html) {
  const seen = new Set();
  const results = [];
  const pattern = /\/detail\/(\d+)\/([a-z0-9-]+)/g;
  let match;
  while ((match = pattern.exec(String(html || '')))) {
    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const slug = match[2];
    results.push({
      id,
      slug,
      title: slug.replace(/-/g, ' '),
      detailUrl: buildDetailUrl(id, slug),
    });
  }
  return results;
}

/** 解析详情页的标题与作者 */
export function parseDetail(html) {
  const text = String(html || '');
  const titleMatch = text.match(/<title>([^<]*)<\/title>/i);
  let title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s*-\s*Openclipart\s*$/i, '') : '';
  const authorMatch = text.replace(/<[^>]+>/g, ' ').match(/\bby\s+([A-Za-z0-9_@.\-]+)\s*-\s*uploaded/i);
  return {
    title: title.trim(),
    author: authorMatch ? authorMatch[1] : null,
  };
}

/** 标题与查询词的相关性：先要求查询词都出现，再按多余词数从少到多排序 */
export function relevanceScore(title, term) {
  const tokens = (String(title).toLowerCase().match(/[a-z0-9]+/g) || []);
  const target = (String(term).toLowerCase().match(/[a-z0-9]+/g) || []);
  if (target.length === 0) return 10;
  if (!target.every((token) => tokens.includes(token))) return 20;
  return Math.max(0, tokens.length - target.length);
}

/** 标题排序分：更像“剪影/图标/单轮廓”的优先 */
export function titleScore(title) {
  const text = String(title || '').toLowerCase();
  let score = 0;
  if (text.includes('silhouette')) score -= 4;
  if (text.includes('icon')) score -= 2;
  if (text.includes('outline')) score -= 2;
  if (text.includes('simple')) score -= 1;
  if (text.includes('flat')) score -= 1;
  if (text.includes('color') || text.includes('colour')) score += 1;
  if (text.includes('photo') || text.includes('realistic')) score += 2;
  return score;
}

/** 把搜索+详情结果转成统一候选结构 */
export function buildCandidate(result, detail) {
  return {
    uuid: `oc-${result.id}`,
    title: detail?.title || result.title,
    scientificName: null,
    generalNode: null,
    license: OPENCLIPART_LICENSE,
    licenseUrl: OPENCLIPART_LICENSE_URL,
    licenseAllowed: true,
    attributionRequired: false,
    attribution: detail?.author || null,
    vectorUrl: buildDownloadUrl(result.id),
    rasterUrl: `${OPENCLIPART_BASE}/image/2000px/${result.id}`,
    rasterWidth: 2000,
    sourceUrl: result.detailUrl,
    sourceName: 'Openclipart',
    sourceId: result.id,
  };
}
