/**
 * 100 种用户可能画的图形：E2E 转换测试。
 *
 * 输入：test/fixtures/e2e-shapes/manifest.json（100 条，已绑定真实 SVG 素材）
 * 验证：每条都能转换成合法 T 点序列（accepted + 点数/边界/最长边/拓扑）。
 *
 * 运行：node test/reference-e2e.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { convertSvg, validateSimplePolygon } from '../tools/reference/lib/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = resolve(root, 'test/fixtures/e2e-shapes/manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const baseDir = dirname(manifestPath);

let failures = 0;
function check(label, condition, detail = '') {
  if (!condition) failures += 1;
  console.log(`[check] ${label} -> ${condition ? 'PASS' : `FAIL ${detail}`}`);
}

check('输入集：正好 100 条', manifest.entries.length === 100);
check('输入集：中文标签不重复', new Set(manifest.entries.map((entry) => entry.zh)).size === 100);
const allowedLicenses = new Set(['CC0-1.0', 'PDM-1.0', 'Public-Domain', 'CC-BY-4.0']);
check('输入集：许可均在白名单', manifest.entries.every((entry) => allowedLicenses.has(entry.source.license)));
check('输入集：CC-BY 均有署名', manifest.entries.every((entry) => entry.source.license !== 'CC-BY-4.0' || entry.source.attribution));

let accepted = 0;
for (const entry of manifest.entries) {
  const svgText = readFileSync(resolve(baseDir, entry.file), 'utf8');
  const conversion = convertSvg(svgText);
  const points = conversion.T?.points;
  const topology = points ? validateSimplePolygon(points) : { ok: false, reason: '无 T' };
  const first = points?.[0];
  const last = points?.[points.length - 1];
  const noDuplicateClose = !(first && last && first[0] === last[0] && first[1] === last[1]);
  const inBounds = points?.every(([x, y]) => x >= -0.5005 && x <= 0.5005 && y >= -0.5005 && y <= 0.5005);
  const xs = points?.map(([x]) => x) || [];
  const ys = points?.map(([, y]) => y) || [];
  const span = points?.length ? Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) : 0;
  const deviation = conversion.metrics?.sourceToTargetMaxPct ?? Infinity;
  const ok =
    conversion.status === 'accepted' &&
    Array.isArray(points) &&
    points.length >= 3 &&
    points.length <= 512 &&
    noDuplicateClose &&
    inBounds &&
    Math.abs(span - 1) <= 0.002 &&
    deviation <= 3 &&
    topology.ok;
  if (ok) accepted += 1;
  check(`${entry.zh}（${entry.id}）→ T`, ok, `${conversion.status} ${topology.reason || ''}`);
}
check('E2E：100/100 产出 T 点序列', accepted === 100);

if (failures > 0) {
  console.error(`\nFAILED: ${failures} 项未通过`);
  process.exitCode = 1;
} else {
  console.log('\nPASS: reference-e2e 100 种图形全部通过');
}
