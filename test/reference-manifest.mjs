/**
 * 参考图模块：manifest 校验测试（Node 直接运行，无网络）。
 *
 * 覆盖：正常清单、重复 id、sha256 不匹配、非法许可、CC-BY 缺署名、
 * 路径穿越、错误版本、aliases 类型错误、非法 JSON。
 *
 * 运行：node test/reference-manifest.mjs
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { loadManifest, sha256File, validateManifest } from '../tools/reference/lib/index.js';

let failures = 0;

function check(label, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`[check] ${label} -> ${ok ? 'PASS' : `FAIL ${detail}`}`);
}

const manifestPath = 'web/data/shapes/manifest.json';
const rootDir = dirname(resolve(manifestPath));
const loaded = loadManifest(manifestPath);
check('正常清单：通过', loaded.ok, JSON.stringify(loaded.errors));
// 素材扩容后数量以审核清单为准（方案 §4.1），见 test/reference-library.mjs 的冻结断言
check('正常清单：素材数量与文件一致', loaded.assets.length === loaded.manifest.assets.length && loaded.assets.length > 7);
check('正常清单：sha256 与文件一致', sha256File(loaded.assets[0].filePath) === loaded.manifest.assets[0].sha256);

/** 深拷贝当前 manifest */
function clone() {
  return JSON.parse(JSON.stringify(loaded.manifest));
}

const duplicateId = clone();
duplicateId.assets[1].id = duplicateId.assets[0].id;
const duplicateResult = validateManifest(duplicateId, { rootDir });
check('重复 id 被拒绝', !duplicateResult.ok && duplicateResult.errors.some((error) => error.includes('重复')), JSON.stringify(duplicateResult.errors));

const badHash = clone();
badHash.assets[0].sha256 = '0'.repeat(64);
const badHashResult = validateManifest(badHash, { rootDir });
check('sha256 不匹配被拒绝', !badHashResult.ok && badHashResult.errors.some((error) => error.includes('sha256')), JSON.stringify(badHashResult.errors));

const badLicense = clone();
badLicense.assets[0].source.license = 'CC-BY-NC-4.0';
const badLicenseResult = validateManifest(badLicense, { rootDir });
check('非法许可被拒绝', !badLicenseResult.ok && badLicenseResult.errors.some((error) => error.includes('license')), JSON.stringify(badLicenseResult.errors));

const missingAttribution = clone();
missingAttribution.assets[0].source.license = 'CC-BY-4.0';
missingAttribution.assets[0].source.attribution = null;
const missingAttributionResult = validateManifest(missingAttribution, { rootDir });
check('CC-BY 缺署名被拒绝', !missingAttributionResult.ok && missingAttributionResult.errors.some((error) => error.includes('attribution')), JSON.stringify(missingAttributionResult.errors));

const traversal = clone();
traversal.assets[0].file = '../outside.svg';
const traversalResult = validateManifest(traversal, { rootDir });
check('路径穿越被拒绝', !traversalResult.ok && traversalResult.errors.some((error) => error.includes('相对路径')), JSON.stringify(traversalResult.errors));

const badVersion = clone();
badVersion.version = 2;
const badVersionResult = validateManifest(badVersion, { rootDir });
check('错误版本被拒绝', !badVersionResult.ok && badVersionResult.errors.some((error) => error.includes('version')), JSON.stringify(badVersionResult.errors));

const badAliases = clone();
badAliases.assets[0].aliases = 'horse';
const badAliasesResult = validateManifest(badAliases, { rootDir });
check('aliases 非数组被拒绝', !badAliasesResult.ok && badAliasesResult.errors.some((error) => error.includes('aliases')), JSON.stringify(badAliasesResult.errors));

const missingZh = clone();
missingZh.assets[0].names.zh = [];
const missingZhResult = validateManifest(missingZh, { rootDir });
check('缺少中文名被拒绝', !missingZhResult.ok && missingZhResult.errors.some((error) => error.includes('names.zh')), JSON.stringify(missingZhResult.errors));

// 结构校验（不查文件）
const structureOnly = validateManifest(loaded.manifest, { rootDir: null, checkHashes: false });
check('仅结构校验通过', structureOnly.ok, JSON.stringify(structureOnly.errors));

// 非法 JSON
const tempDir = mkdtempSync(join(tmpdir(), 'drawinmap-manifest-'));
try {
  const badJsonPath = join(tempDir, 'manifest.json');
  writeFileSync(badJsonPath, '{ not json', 'utf8');
  const badJson = loadManifest(badJsonPath);
  check('非法 JSON 被拒绝', !badJson.ok && badJson.errors.some((error) => error.includes('JSON')), JSON.stringify(badJson.errors));
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

// 保证测试读取的是真实文件，而不是空对象
check('manifest 文件非空', readFileSync(manifestPath, 'utf8').length > 500);

if (failures > 0) {
  console.error(`\nFAILED: ${failures} 项未通过`);
  process.exitCode = 1;
} else {
  console.log('\nPASS: reference-manifest 全部断言通过');
}
