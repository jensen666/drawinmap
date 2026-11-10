/**
 * 参考图模块：真实素材转换与报告测试（Node 直接运行，无网络）。
 *
 * 覆盖：
 * - 7 个精选素材全部 accepted，R→T 最大偏差 ≤ 2%，T 通过现有拓扑校验；
 * - 多部分/碎片化真实反例（坐猫、霸王龙）被明确拒绝；
 * - buildReport 输出 report.json / index.html / 每个素材的 R-T 叠加 SVG。
 *
 * 运行：node test/reference-convert.mjs
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  buildReport,
  convertAsset,
  convertSvg,
  loadManifest,
} from '../tools/reference/lib/index.js';
import { validateSimplePolygon } from '../web/src/agent/shape-validate.js';

let failures = 0;

function check(label, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`[check] ${label} -> ${ok ? 'PASS' : `FAIL ${detail}`}`);
}

const manifestPath = 'web/data/shapes/manifest.json';
const manifest = loadManifest(manifestPath);
check('manifest：校验通过', manifest.ok, JSON.stringify(manifest.errors));
// 素材扩容后以审核清单为准（方案 §4.1），冻结断言见 test/reference-library.mjs
check('manifest：素材数量与文件一致', manifest.assets.length === manifest.manifest.assets.length && manifest.assets.length > 7);
check('manifest：无校验 warning', manifest.warnings.length === 0, JSON.stringify(manifest.warnings));

/** 原 7 个 seed 的冻结偏差上限（改代码前冻结） */
const SEED_MAX_DEVIATION_PCT = 2;
/** 扩容素材的冻结偏差上限（2026-11-01 审核批次实测最大 dragon 2.3061，冻结 2.4 挡恶化） */
const LIBRARY_MAX_DEVIATION_PCT = 2.4;
const SEED_IDS = new Set(['human-phylopic', 'horse-phylopic', 'horse-openclipart', 'cat-phylopic', 'dog-phylopic', 'dog-openclipart', 'pigeon-phylopic']);
const rows = [];
for (const asset of manifest.assets) {
  const { result, bytes } = convertAsset(asset, manifest.rootDir);
  const prefix = asset.id;
  check(`${prefix}：accepted`, result.status === 'accepted', JSON.stringify(result.reasons));
  if (result.status !== 'accepted') {
    rows.push({ id: prefix, status: result.status, maxPct: '-', points: '-', aspect: '-', bytes });
    continue;
  }
  const { T, metrics, diagnostics } = result;
  const maxDeviationPct = SEED_IDS.has(asset.id) ? SEED_MAX_DEVIATION_PCT : LIBRARY_MAX_DEVIATION_PCT;
  check(`${prefix}：R→T 最大偏差 ≤ ${maxDeviationPct}%`, metrics.sourceToTargetMaxPct <= maxDeviationPct, String(metrics.sourceToTargetMaxPct));
  check(`${prefix}：T 点数 3~512`, T.pointCount >= 3 && T.pointCount <= 512, String(T.pointCount));
  check(`${prefix}：T 坐标在 [-0.5, 0.5]`, T.points.every(([x, y]) => Math.abs(x) <= 0.500001 && Math.abs(y) <= 0.500001));
  check(`${prefix}：T 通过现有拓扑校验`, validateSimplePolygon(T.points).ok, validateSimplePolygon(T.points).reason || '');
  check(`${prefix}：宽高比记录一致`, Math.abs(T.aspect - metrics.aspect) <= 0.0001, `${T.aspect} vs ${metrics.aspect}`);
  check(`${prefix}：主外轮廓闭合`, diagnostics.mainClosed === true);
  check(`${prefix}：至少一条 R 环`, result.R.main.length >= 3);
  rows.push({
    id: prefix,
    status: result.status,
    maxPct: metrics.sourceToTargetMaxPct,
    points: T.pointCount,
    aspect: T.aspect,
    bytes,
    simplification: T.simplification ? T.simplification.epsilon : 0,
  });
}

// 需要 RDP 才能通过拓扑校验的真实素材（Openclipart 马有细毛刺）
const horseClipArt = rows.find((row) => row.id === 'horse-openclipart');
check('horse-openclipart：经过小容差 RDP 简化', Boolean(horseClipArt && horseClipArt.simplification > 0), JSON.stringify(horseClipArt));

// 真实反例：多部分 / 碎片化必须明确拒绝
const catRejected = convertSvg(readFileSync(resolve('test/fixtures/unsupported/cat-openclipart.svg'), 'utf8'));
check(
  '反例·多部分坐猫被拒绝',
  catRejected.status === 'rejected' && catRejected.reasons.some((reason) => reason.code === 'multi-part'),
  JSON.stringify(catRejected.reasons),
);
const trexRejected = convertSvg(readFileSync(resolve('test/fixtures/unsupported/trex-phylopic.svg'), 'utf8'));
check(
  '反例·碎片化霸王龙被拒绝',
  trexRejected.status === 'rejected' && trexRejected.reasons.some((reason) => reason.code === 'fragmented-paths'),
  JSON.stringify(trexRejected.reasons),
);

// 报告输出
const outDir = mkdtempSync(join(tmpdir(), 'drawinmap-reference-'));
try {
  const built = buildReport({ manifestPath, outDir });
  const total = manifest.assets.length;
  check(
    '报告：summary 为全量通过 / 0 拒绝',
    built.report.summary.total === total && built.report.summary.accepted === total && built.report.summary.rejected === 0,
    JSON.stringify(built.report.summary),
  );
  check('报告：index.html 存在', existsSync(built.indexHtmlPath));
  check('报告：report.json 存在', existsSync(join(outDir, 'report.json')));
  const reportJson = JSON.parse(readFileSync(join(outDir, 'report.json'), 'utf8'));
  check('报告：JSON 含全部素材', reportJson.assets.length === total);
  const overlayCount = reportJson.assets.filter((asset) => existsSync(join(outDir, 'r-t', `${asset.id}.svg`))).length;
  check('报告：全部 R/T 叠加 SVG', overlayCount === total, String(overlayCount));
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

console.log('\n素材汇总：');
console.table(rows);
if (failures > 0) {
  console.error(`\nFAILED: ${failures} 项未通过`);
  process.exitCode = 1;
} else {
  console.log('\nPASS: reference-convert 全部断言通过');
}
