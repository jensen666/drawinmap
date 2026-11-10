/**
 * 素材许可地址：泛化 CC 首页必须换成具体许可页，且已入库的 manifest 不得再出现首页地址。
 *
 * 运行：node test/license-url.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  canonicalLicenseUrl,
  normalizeSourceLicense,
  replaceGenericLicenseUrls,
  renderAttributionMarkdown,
} from '../tools/reference/license-url.mjs';

let failures = 0;

/**
 * 打印一条断言。
 *
 * @param {string} label 描述
 * @param {boolean} condition 是否通过
 * @param {string} [detail] 失败详情
 */
function check(label, condition, detail = '') {
  if (!condition) failures += 1;
  console.log(`[check] ${label} -> ${condition ? 'PASS' : `FAIL ${detail}`}`);
}

check('CC0 具体地址', canonicalLicenseUrl('CC0-1.0') === 'https://creativecommons.org/publicdomain/zero/1.0/');
check('PDM 具体地址', canonicalLicenseUrl('PDM-1.0') === 'https://creativecommons.org/publicdomain/mark/1.0/');
check('CC-BY 具体地址', canonicalLicenseUrl('CC-BY-4.0') === 'https://creativecommons.org/licenses/by/4.0/');
check('未知许可不猜测', canonicalLicenseUrl('CC-BY-NC-4.0') === null);
let unknownThrew = false;
try {
  normalizeSourceLicense({ license: 'CC-BY-NC-4.0', licenseUrl: 'https://creativecommons.org/licenses/' });
} catch (error) {
  unknownThrew = String(error.message).includes('CC-BY-NC-4.0');
}
check('未知许可配泛化地址时抛错', unknownThrew);

const generic = { license: 'CC0-1.0', licenseUrl: 'https://creativecommons.org/licenses/', attribution: 'A' };
const normalized = normalizeSourceLicense(generic);
check('泛化首页按许可替换', normalized.licenseUrl.endsWith('/publicdomain/zero/1.0/') && normalized.attribution === 'A');
check('原对象不被修改', generic.licenseUrl.endsWith('/licenses/'));

const specific = { license: 'CC-BY-4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/' };
check('已是具体地址则保持', normalizeSourceLicense(specific) === specific);

const sample = [
  '        "license": "CC-BY-4.0",',
  '        "licenseUrl": "https://creativecommons.org/licenses/",',
].join('\n');
const replaced = replaceGenericLicenseUrls(sample);
check('按上一行 license 替换文本', replaced.replaced === 1 && replaced.text.includes('/licenses/by/4.0/'));
check('不把首页误换成半截地址', !replaced.text.includes('licenses/",'));

const attribution = renderAttributionMarkdown({
  assets: [{
    id: 'fa-demo',
    names: { zh: ['示例'] },
    source: { name: 'Font Awesome', license: 'CC-BY-4.0', attribution: 'Font Awesome Free 6.7.2', url: 'https://example.com/a' },
  }],
});
check('署名页含 id 与署名', attribution.includes('fa-demo') && attribution.includes('Font Awesome Free 6.7.2'));
check('署名页声明不适用 MIT', attribution.includes('不适用'));

const manifests = [
  '../web/data/shapes/manifest.json',
  '../test/fixtures/e2e-shapes/manifest.json',
];
for (const relative of manifests) {
  const full = fileURLToPath(new URL(relative, import.meta.url));
  const text = readFileSync(full, 'utf8');
  const data = JSON.parse(text);
  const items = data.assets || data.entries || [];
  const genericLeft = items.filter((item) => {
    const url = item.source?.licenseUrl || '';
    return url === 'https://creativecommons.org/licenses/' || url === 'https://creativecommons.org/licenses';
  });
  check(`${relative} 没有泛化许可首页`, genericLeft.length === 0, `仍有 ${genericLeft.length} 条`);
  const mismatched = items.filter((item) => {
    const license = item.source?.license;
    const url = item.source?.licenseUrl || '';
    if (license === 'CC0-1.0') return !url.includes('/publicdomain/zero/1.0/');
    if (license === 'PDM-1.0') return !url.includes('/publicdomain/mark/1.0/');
    if (license === 'CC-BY-4.0') return !url.includes('/licenses/by/4.0/');
    if (license === 'Public-Domain') return !url.includes('openclipart.org/');
    return true;
  });
  check(`${relative} 许可标记与地址一致`, mismatched.length === 0, mismatched.slice(0, 3).map((item) => item.id).join(','));
}

if (failures > 0) {
  console.log(`[license-url] FAIL ${failures}`);
  process.exit(1);
}
console.log('[license-url] PASS');
