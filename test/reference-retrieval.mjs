/**
 * 参考图模块：在线检索适配 / 自动选择编排 单元测试（Node 直接运行，无网络）。
 *
 * 运行：node test/reference-retrieval.mjs
 */

import {
  buildCandidate,
  buildImagesUrl,
  buildNodeSearchUrl,
  buildSearchUrl,
  fetchJson,
  licenseFromUrl,
  licenseRank,
  parseDetail,
  parseImages,
  parseNodeSearch,
  parseSearch,
  rankCandidates,
  resolveApiUrl,
  resolveReferenceShape,
  titleScore,
} from '../tools/reference/lib/index.js';

let failures = 0;
function check(label, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`[check] ${label} -> ${ok ? 'PASS' : `FAIL ${detail}`}`);
}

// ---------- 许可 ----------
check('许可：CC0 允许', licenseFromUrl('https://creativecommons.org/publicdomain/zero/1.0/').allowed);
check('许可：PDM 允许', licenseFromUrl('https://creativecommons.org/publicdomain/mark/1.0/').allowed);
check('许可：CC-BY 需要署名', licenseFromUrl('https://creativecommons.org/licenses/by/4.0/').attributionRequired);
check('许可：CC-BY-SA 拒绝', !licenseFromUrl('https://creativecommons.org/licenses/by-sa/3.0/').allowed);
check('许可：CC-BY-NC 拒绝', !licenseFromUrl('https://creativecommons.org/licenses/by-nc/3.0/').allowed);
check('许可排序：CC0 < CC-BY', licenseRank('CC0-1.0') < licenseRank('CC-BY-4.0'));

// ---------- URL ----------
const nodeUrl = buildNodeSearchUrl({ name: 'Equus ferus caballus', build: 560 });
check('URL：节点搜索含 build/filter_name', nodeUrl.includes('build=560') && nodeUrl.includes('filter_name=equus+ferus+caballus'));
check('URL：节点搜索默认不带 page', !nodeUrl.includes('page='));
const nodeUrlPage = buildNodeSearchUrl({ name: 'Equus', build: 560, page: 0 });
check('URL：节点搜索可指定 page', nodeUrlPage.includes('page=0'));
const imagesUrl = buildImagesUrl({ nodeUuid: 'abc', build: 560, clade: true });
check('URL：支系图片含 filter_clade', imagesUrl.includes('filter_clade=abc'));
const imagesPageUrl = buildImagesUrl({ nodeUuid: 'abc', build: 560, clade: true, page: 0, embed: true });
check('URL：图片分页可带 embed_items', imagesPageUrl.includes('page=0') && imagesPageUrl.includes('embed_items=true'));
check('URL：相对 href 补全', resolveApiUrl('/images/abc?build=560') === 'https://api.phylopic.org/images/abc?build=560');

// ---------- 解析 ----------
const nodes = parseNodeSearch({
  _links: { items: [{ href: '/nodes/aaa?build=560', title: 'Equus' }, { href: '/nodes/bbb?build=560', title: 'Equus ferus' }] },
});
check('解析：节点 UUID 与标题', nodes.length === 2 && nodes[0].uuid === 'aaa' && nodes[1].title === 'Equus ferus');

const imagePayload = {
  _embedded: {
    items: [
      {
        uuid: 'img-1',
        attribution: 'A',
        _links: {
          specificNode: { title: 'Equus ferus caballus' },
          license: { href: 'https://creativecommons.org/publicdomain/zero/1.0/' },
          vectorFile: { href: 'https://example.com/v.svg' },
          rasterFiles: [{ href: 'https://example.com/r512.png', sizes: '512x288' }, { href: 'https://example.com/r2048.png', sizes: '2048x1000' }],
        },
      },
      {
        uuid: 'img-2',
        attribution: 'B',
        _links: {
          specificNode: { title: 'Equus' },
          license: { href: 'https://creativecommons.org/licenses/by/4.0/' },
          vectorFile: { href: 'https://example.com/v2.svg' },
        },
      },
    ],
  },
};
const parsed = parseImages(imagePayload);
check('解析：图片候选数量', parsed.length === 2);
check('解析：许可/署名/矢量链接', parsed[0].license === 'CC0-1.0' && parsed[0].attribution === 'A' && parsed[0].vectorUrl.endsWith('v.svg'));
check('解析：raster 选 400+ 的最宽', parsed[0].rasterWidth === 2048);

// ---------- 排序 ----------
const ranked = rankCandidates(parsed, { scientificNames: ['Equus ferus caballus'] });
check('排序：精确节点优先', ranked[0].uuid === 'img-1');
const rankedLicense = rankCandidates(
  [
    { uuid: 'by', scientificName: 'Equus', license: 'CC-BY-4.0', vectorUrl: 'x', rasterWidth: 100 },
    { uuid: 'cc0', scientificName: 'Equus', license: 'CC0-1.0', vectorUrl: 'x', rasterWidth: 100 },
  ],
  { scientificNames: ['Equus'] },
);
check('排序：同节点下许可义务少优先', rankedLicense[0].uuid === 'cc0');
const rankedSubspecies = rankCandidates(
  [
    { uuid: 'other-species', scientificName: 'Homo longi', license: 'CC0-1.0', vectorUrl: 'x', rasterWidth: 512 },
    { uuid: 'subspecies', scientificName: 'Homo sapiens njarasensis', license: 'CC0-1.0', vectorUrl: 'x', rasterWidth: 512 },
  ],
  { scientificNames: ['Homo sapiens'] },
);
check('排序：亚种优先于同属其他物种', rankedSubspecies[0].uuid === 'subspecies');

// ---------- resolveReferenceShape ----------
const query = { id: 'horse', scientificNames: ['Equus ferus caballus'] };
const candidate = { uuid: 'ok', scientificName: 'Equus ferus caballus', license: 'CC0-1.0', licenseAllowed: true, vectorUrl: 'v' };
const resolved = await resolveReferenceShape({
  query,
  searchCandidates: async () => [candidate],
  downloadSvg: async () => '<svg/>',
  convert: () => ({ status: 'accepted', T: { points: [] } }),
});
check('编排：首个候选接受 → ok', resolved.status === 'ok' && resolved.selected.candidate.uuid === 'ok');

const secondTry = await resolveReferenceShape({
  query,
  searchCandidates: async () => [candidate, { ...candidate, uuid: 'second' }],
  downloadSvg: async (item) => {
    if (item.uuid === 'ok') throw new Error('network');
    return '<svg/>';
  },
  convert: () => ({ status: 'accepted', T: { points: [] } }),
});
check('编排：下载失败自动尝试下一个', secondTry.status === 'ok' && secondTry.selected.candidate.uuid === 'second');

const rejected = await resolveReferenceShape({
  query,
  searchCandidates: async () => [candidate],
  downloadSvg: async () => '<svg/>',
  convert: () => ({ status: 'rejected', reasons: [{ code: 'topology' }] }),
});
check('编排：全部拒绝 → failed 且带原因', rejected.status === 'failed' && rejected.attempts[0].status === 'conversion-rejected');

const noCandidates = await resolveReferenceShape({
  query,
  searchCandidates: async () => [],
  downloadSvg: async () => '',
  convert: () => ({}),
});
check('编排：无候选 → failed', noCandidates.status === 'failed' && noCandidates.error.includes('无候选'));

const searchError = await resolveReferenceShape({
  query,
  searchCandidates: async () => {
    throw new Error('boom');
  },
  downloadSvg: async () => '',
  convert: () => ({}),
});
check('编排：检索异常 → failed', searchError.status === 'failed' && searchError.error.includes('检索失败'));

// ---------- fetchJson 重试 ----------
let attempts = 0;
const retried = await fetchJson('https://example.com', {
  fetchImpl: async () => {
    attempts += 1;
    if (attempts < 2) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  },
  retries: 2,
  delayMs: 1,
});
check('fetchJson：失败后重试成功', retried.ok === true && attempts === 2);

let failureAttempts = 0;
try {
  await fetchJson('https://example.com', {
    fetchImpl: async () => {
      failureAttempts += 1;
      return { ok: false, status: 429, json: async () => ({}) };
    },
    retries: 1,
    delayMs: 1,
  });
  check('fetchJson：持续失败抛出', false);
} catch (error) {
  check('fetchJson：持续失败抛出', failureAttempts === 2 && String(error.message).includes('HTTP 429'));
}

// ---------- Openclipart ----------
const searchHtml = '<a href="/detail/100/house-silhouette">a</a><a href="/detail/200/car">b</a><a href="/detail/100/house-silhouette">dup</a>';
const ocResults = parseSearch(searchHtml);
check('Openclipart：解析 detail 链接并去重', ocResults.length === 2 && ocResults[0].id === '100' && ocResults[0].slug === 'house-silhouette');
check('Openclipart：搜索 URL 编码', buildSearchUrl('house silhouette').includes('house%20silhouette'));
const detail = parseDetail('<title>House Silhouette - Openclipart</title><p>Check House by j4p4n - uploaded on today</p>');
check('Openclipart：详情页标题/作者', detail.title === 'House Silhouette' && detail.author === 'j4p4n');
check('Openclipart：剪影标题优先', titleScore('house silhouette') < titleScore('colorful house photo'));
const ocCandidate = buildCandidate(
  { id: '100', slug: 'house-silhouette', title: 'house silhouette', detailUrl: 'https://openclipart.org/detail/100/house-silhouette' },
  { title: 'House Silhouette', author: 'j4p4n' },
);
check('Openclipart：候选许可/下载链接', ocCandidate.license === 'Public-Domain' && ocCandidate.licenseAllowed && ocCandidate.vectorUrl.includes('/download/100'));
check('Openclipart：候选来源标记', ocCandidate.sourceName === 'Openclipart' && ocCandidate.sourceId === '100');

if (failures > 0) {
  console.error(`\nFAILED: ${failures} 项未通过`);
  process.exitCode = 1;
} else {
  console.log('\nPASS: reference-retrieval 全部断言通过');
}
