/**
 * 正式素材库全量回归（方案 2026-10-31 §11.1：素材与排序）。
 *
 * 合并后的生产 manifest（seed + E2E 素材、SHA 去重、人工审核入库）必须满足：
 * - 全部条目通过结构、许可、署名、审核哈希校验；
 * - 文件级 sha256 与 review.sha256 与实际文件一致（审核绑定当前素材版本）；
 * - 全部条目 convertSvg → normalizeCustomShape 双通过（转换与归一化门槛一致）；
 * - 无重复 SHA（字节级去重）；
 * - 同对象版本数与审核清单一致：马 3、狗 3、猫 2，其余对象单版本；
 * - 数量等于审核清单（不断言恰好 100）。
 *
 * 运行：node test/reference-library.mjs
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { convertSvg, loadManifest, sha256File } from '../tools/reference/lib/index.js';
import { normalizeCustomShape } from '../web/src/agent/intent.js';

let failures = 0;
let checks = 0;

function check(label, condition, detail = '') {
  checks += 1;
  const ok = Boolean(condition);
  if (!ok) {
    failures += 1;
  }
  console.log(`[check] ${label} -> ${ok ? 'PASS' : `FAIL ${detail}`}`);
}

const root = resolve(fileURLToPath(import.meta.url), '..', '..');
const manifestPath = resolve(root, 'web/data/shapes/manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const loaded = loadManifest(manifestPath);

// ---------- 结构与元数据 ----------
check('manifest 校验通过（结构/许可/署名/审核哈希）', loaded.ok, JSON.stringify(loaded.errors).slice(0, 400));
const assets = loaded.assets;
check('素材数量与审核清单一致（102 份）', assets.length === 102, `实际 ${assets.length}`);

const seenSha = new Map();
for (const asset of assets) {
  const sha = sha256File(asset.filePath);
  const label = `${asset.id}`;
  check(`${label}：文件 sha256 与条目一致`, sha === asset.sha256);
  check(`${label}：review 绑定当前素材哈希`, asset.review?.sha256 === asset.sha256);
  check(`${label}：审核通过（approved + like）`, asset.review?.status === 'approved' && asset.review?.visual === 'like');
  if (asset.source?.license === 'CC-BY-4.0') {
    check(`${label}：CC-BY 署名非空`, Boolean(asset.source.attribution?.trim()));
  }
  if (seenSha.has(asset.sha256)) {
    check(`${label}：SHA 未重复（首次出现于 ${seenSha.get(asset.sha256)}）`, false);
  } else {
    seenSha.set(asset.sha256, asset.id);
  }
}

// ---------- 全量转换回归：convertSvg → normalizeCustomShape 双通过 ----------
let converted = 0;
for (const asset of assets) {
  const svgText = readFileSync(asset.filePath, 'utf8');
  const conversion = convertSvg(svgText);
  if (conversion.status !== 'accepted' || !conversion.T) {
    check(`${asset.id}：convertSvg accepted`, false, JSON.stringify((conversion.reasons || []).map((r) => r.code)));
    continue;
  }
  const shape = normalizeCustomShape({ name: asset.names.zh[0], points: conversion.T.points });
  check(`${asset.id}：normalizeCustomShape 被接受`, shape !== null);
  if (shape) {
    converted += 1;
  }
}
check('全量转换回归：全部条目双通过', converted === assets.length, `${converted}/${assets.length}`);

// ---------- 同对象版本数与审核清单一致 ----------
const byObject = new Map();
for (const asset of assets) {
  const key = asset.names.zh[0];
  if (!byObject.has(key)) byObject.set(key, []);
  byObject.get(key).push(asset.id);
}
const FROZEN_VERSIONS = { 马: ['horse-openclipart', 'horse-phylopic', 'horse'], 狗: ['dog-openclipart', 'dog-phylopic', 'dog'], 猫: ['cat-phylopic', 'cat'] };
for (const [zh, ids] of Object.entries(FROZEN_VERSIONS)) {
  const actual = (byObject.get(zh) || []).sort();
  check(`${zh}：版本数与审核清单一致（${ids.length}）`, actual.length === ids.length && JSON.stringify(actual) === JSON.stringify([...ids].sort()), JSON.stringify(actual));
}
const singleVersionObjects = [...byObject.values()].filter((ids) => ids.length === 1).length;
check('其余对象全部单版本', singleVersionObjects === byObject.size - Object.keys(FROZEN_VERSIONS).length, `${singleVersionObjects}/${byObject.size}`);
check('对象总数 97（马/狗/猫各多版本，其余单版本）', byObject.size === 97, `实际 ${byObject.size}`);

console.log(`\nRESULT: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}  (${checks - failures} passed, ${failures} failed)`);
process.exit(failures === 0 ? 0 : 2);
