/**
 * 素材许可地址：把泛化的 Creative Commons 首页换成与 SPDX 标记对应的具体许可页。
 *
 * 正式库与 E2E 夹具里有一批 PhyloPic 条目把 licenseUrl 写成了
 * https://creativecommons.org/licenses/ （许可首页，不是某一份许可）。
 * 再分发时无法据此判断 CC0 / PDM / CC-BY。本模块是唯一的替换规则，
 * build-manifest 重生成时也走这里，避免再写回首页地址。
 */

/** 泛化许可首页（带或不带结尾斜杠） */
const GENERIC_LICENSE_HOMEPAGE = new Set([
  'https://creativecommons.org/licenses',
  'https://creativecommons.org/licenses/',
]);

/**
 * SPDX 标记 → 具体许可页。
 * Public-Domain 没有 CC 法律文本，Openclipart 的分享说明页是这批素材的来源声明。
 *
 * @param {string} license manifest 里的 source.license
 * @returns {string|null} 具体地址；未知标记返回 null
 */
export function canonicalLicenseUrl(license) {
  switch (license) {
    case 'CC0-1.0':
      return 'https://creativecommons.org/publicdomain/zero/1.0/';
    case 'PDM-1.0':
      return 'https://creativecommons.org/publicdomain/mark/1.0/';
    case 'CC-BY-4.0':
      return 'https://creativecommons.org/licenses/by/4.0/';
    case 'Public-Domain':
      return 'https://openclipart.org/share';
    default:
      return null;
  }
}

/**
 * 仅当 licenseUrl 是泛化首页时，替换成与 license 对应的具体地址。
 * 已经是具体地址的原样返回（不覆盖作者给出的更精确链接）。
 *
 * @param {object} source 素材的 source 对象
 * @returns {object} 原对象或替换 licenseUrl 后的浅拷贝
 */
export function normalizeSourceLicense(source) {
  if (!source || typeof source !== 'object') return source;
  const url = String(source.licenseUrl || '');
  if (!GENERIC_LICENSE_HOMEPAGE.has(url)) return source;
  const canonical = canonicalLicenseUrl(source.license);
  if (!canonical) {
    throw new Error(`许可 ${source.license} 使用了泛化 licenseUrl，但没有对应的具体地址`);
  }
  return { ...source, licenseUrl: canonical };
}

/**
 * 在保持原文件换行的前提下，把紧挨着 "license" 字段的泛化 licenseUrl 换成具体地址。
 * 不整文件 JSON.stringify，避免把 manifest 的格式化全部打散。
 *
 * @param {string} text manifest 原文
 * @returns {{text: string, replaced: number}} 替换后的文本与条数
 */
export function replaceGenericLicenseUrls(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  let replaced = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].includes('"licenseUrl": "https://creativecommons.org/licenses/"')
      && !lines[i].includes('"licenseUrl": "https://creativecommons.org/licenses"')) {
      continue;
    }
    const previous = lines[i - 1] || '';
    const licenseMatch = previous.match(/"license": "([^"]+)"/);
    if (!licenseMatch) {
      throw new Error(`第 ${i + 1} 行是泛化 licenseUrl，上一行不是 license 字段`);
    }
    const canonical = canonicalLicenseUrl(licenseMatch[1]);
    if (!canonical) {
      throw new Error(`第 ${i + 1} 行许可 ${licenseMatch[1]} 没有具体地址`);
    }
    const next = lines[i]
      .replace('"licenseUrl": "https://creativecommons.org/licenses/"', `"licenseUrl": "${canonical}"`)
      .replace('"licenseUrl": "https://creativecommons.org/licenses"', `"licenseUrl": "${canonical}"`);
    if (next === lines[i]) {
      throw new Error(`第 ${i + 1} 行未能替换 licenseUrl`);
    }
    lines[i] = next;
    replaced += 1;
  }
  return { text: lines.join(eol), replaced };
}

/**
 * 由正式 manifest 生成署名页正文。
 *
 * @param {{assets?: Array<object>}} manifest 正式素材库
 * @returns {string} Markdown
 */
export function renderAttributionMarkdown(manifest) {
  const assets = Array.isArray(manifest?.assets) ? manifest.assets : [];
  const lines = [
    '# 参考素材署名',
    '',
    '本目录（`web/data/shapes/`）的 SVG **不适用**仓库根目录 MIT 许可。',
    '每条素材保持其原许可：CC0-1.0、PDM-1.0、Public-Domain 或 CC-BY-4.0。',
    'CC-BY-4.0 必须保留署名。Font Awesome 图标的署名是 “Font Awesome Free 6.7.2”。',
    '',
    '| id | 中文名 | 来源 | 许可 | 署名 | 源链接 |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const asset of assets) {
    const source = asset.source || {};
    const zh = Array.isArray(asset.names?.zh) ? asset.names.zh[0] || '' : '';
    lines.push([
      '',
      `\`${asset.id}\``,
      escapeCell(zh),
      escapeCell(source.name || ''),
      escapeCell(source.license || ''),
      escapeCell(source.attribution || ''),
      source.url ? `[链接](${source.url})` : '',
      '',
    ].join(' | ').trim());
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * 表格单元格里的竖线会拆列，换成转义。
 *
 * @param {string} value 单元格原文
 * @returns {string} 可放进 Markdown 表格的文本
 */
function escapeCell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}
