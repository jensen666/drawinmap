/**
 * 语料盲评材料生成（2026-11-02）——"逐段贴路但整体不像"的虚假绿线人工盲评。
 *
 * 目的：回答方案阶段 2「最小全局视觉门」是否值得做——现有交付里到底有多少
 *       "每段都贴着路走、整体却不像目标形状"的虚假绿线。本脚本只负责**生产盲评材料**，
 *       人工判读与事后统计由 Lead 组织。
 *
 * 链路真实性：
 * - 输入取阶段 0 基线（test/fixtures/corpus/baseline-phase0.json）中 status==="ok"
 *   的 59 个"已交付通过"样本；样本按 **id** 与 getCorpus() 对齐，不按数组下标对齐；
 * - 每个样本**真实复跑** web/src/engine/candidates.js 的 searchWithEscalation
 *   （真实路网 buildNetwork + 真实 planShapeRoute 规划，无任何 mock/占位）；
 * - 路线几何取自 result.best.result.routeLatLngs ——生产地图上真正画的那条折线
 *   （web/src/session/geometry.js 的 route 字段同源），**不用轮廓点冒充路线**；
 * - 复跑不再 status==="ok" 的样本如实记为"复跑未通过"并跳过渲染，
 *   **不用旧基线结果顶替**。
 *
 * 渲染：
 * - 纯 Node 光栅化 + zlib PNG 编码（无 canvas、无任何 npm 依赖，仓库本身零第三方依赖）；
 * - 复用 tools/outline-gallery.mjs 的 PNG 编码（crc32/chunk/encodePNG）与
 *   超采样覆盖度光栅化（stampDisc + 降采样反走样）思路；
 * - 每张 PNG **只画实际路线**：白底、深色实线 #1f2937、线宽 2.5px、留白边、
 *   路线整体缩放居中（最长边占画布 80%）、320×320；不画目标轮廓/参考图/任何文字标注。
 *
 * 盲评：
 * - PNG 文件名只带匿名编号（case-NN.png），匿名顺序与真实样本顺序**随机打散**
 *   （固定 seed 的 Fisher-Yates，可复现）；
 * - index.html 为盲评页（网格 + 「像/不像」+ 备注输入框 + 结果导出），
 *   **不加载** manifest.json，页面上不含任何样本身份/几何标签/路网标签/分数；
 * - manifest.json 为事后解码表（匿名编号 ↔ 真实样本 id + 真实指标）。
 *
 * 运行：node tools/corpus-blind-review.mjs
 */

import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

import { searchWithEscalation } from '../../web/src/engine/candidates.js';
import { qualityGateReport } from '../../web/src/engine/quality.js';
import { distanceMeters } from '../../web/src/engine/graph.js';
import { collectRouteTopologyMetrics } from '../../web/src/engine/route-topology.js';
import { setLevel } from '../../web/src/log/index.js';

import {
  CORPUS_MASTER_SEED,
  CORPUS_VERSION,
  getCorpus,
} from '../../test/fixtures/corpus/corpus.mjs';
import { buildNetwork, networkInstanceById } from '../../test/fixtures/corpus/roadnet.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'docs', '测试报告', '2026-11-02-尺寸轴判别盲评');
const pngDir = join(outDir, 'png');
const baselinePath = join(root, 'test', 'fixtures', 'corpus', 'baseline-phase0.json');

/* ------------------------------- 渲染参数 ------------------------------- */

const PNG_SIZE = 320;      // 画布边长（像素）
const SS = 3;              // 超采样倍率
const STROKE_RGB = [0x1f, 0x29, 0x37]; // 路线深色（#1f2937）
const LINE_WIDTH = 2.5;    // 线宽（最终像素）
const SCAN_RATIO = 0.8;    // 路线最长边占画布比例（其余为留白边）
const ANON_SEED = 20261102; // 匿名编号打散 seed（固定 → 可复现）

/**
 * 目标形状语义名（family → 中文说法）。
 *
 * 盲评需要"评判者知道这团线该像什么"，所以页面必须显示目标形状名——
 * 藏的是**理想轮廓图与指标**，不是目标语义（方案 §1 成功标准 3：
 * "隐藏理想轮廓后仍能保持整体形态"）。
 * 页面只出现中文名，英文 family / 样本 id / 分数 / E_shape / 尺寸 /
 * 几何分层标签 / 路网标签 / 交叉数 / 重复比例一律不出现。
 */
const SHAPE_NAME_ZH = {
  'polygon-regular': '正多边形',
  'polygon-regular-dense': '密集正多边形',
  'polygon-irregular': '不规则多边形',
  'polygon-irregular-sparse': '稀疏不规则多边形',
  'lobes-regular': '规则分叶形',
  'lobes-shallow': '浅分叶形',
  'lobes-irregular': '不规则分叶形',
  'blob-smooth': '平滑团块',
  'blob-irregular': '不规则团块',
  'notch-shallow': '浅缺口形',
  'notch-deep': '深缺口形',
  'fork-narrow': '窄叉形',
  'spike-body': '带尖刺主体',
  'serpentine': '蛇形带',
  'comb-lattice': '梳齿格',
  'cluster-parts': '多簇分离块',
  'cluster-parts-dense': '密集多簇分离块',
  'spiral-band': '螺旋带',
  'hook-band': '钩形带',
  'arc-band-smooth': '平滑弧带',
  'arc-band-tight': '紧凑弧带',
};

/* ------------------------------- PNG 编码 ------------------------------- */
/* 与 tools/outline-gallery.mjs 同实现：crc32 + chunk + zlib deflate，RGB8/filter0 */

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** 把 RGB 像素缓冲编码成 PNG 字节。 */
function encodePNG(rgb, w, h) {
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y += 1) {
    raw[y * stride] = 0;
    raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * stride + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 解码本脚本编码的 PNG（用于"落盘后回读校验"，确保统计的是真实文件内容）。 */
function decodePNGRGB(buf) {
  let pos = 8;
  let w = 0;
  let h = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    if (type === 'IHDR') { w = buf.readUInt32BE(pos + 8); h = buf.readUInt32BE(pos + 12); }
    if (type === 'IDAT') idat.push(buf.subarray(pos + 8, pos + 8 + len));
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const rgb = new Uint8Array(w * h * 3);
  const stride = w * 3 + 1;
  for (let y = 0; y < h; y += 1) {
    if (raw[y * stride] !== 0) throw new Error('unexpected PNG filter');
    rgb.set(raw.subarray(y * stride + 1, (y + 1) * stride), y * w * 3);
  }
  return { rgb, w, h };
}

/* ------------------------------- 光栅化 ------------------------------- */

/** 在覆盖度缓冲上盖一个软边圆盘（中心软化，alpha = 1 - d/r）。 */
function stampDisc(cover, dim, cx, cy, r) {
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(dim - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(dim - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d <= r) {
        const a = 1 - d / r;
        const idx = y * dim + x;
        if (a > cover[idx]) cover[idx] = a;
      }
    }
  }
}

/**
 * 把真实路线折线渲染成 RGB 缓冲（白底 + 深色实线）。
 *
 * 投影：经纬度 → 以路线包围盒中心为原点的局部米制平面（等距近似，
 * 经度按 cos(lat) 折算米）→ 缩放居中（最长边占画布 scaleRatio）→ y 翻转（北在上）。
 *
 * @param {Array<[number, number]>} routeLatLngs 路线点列 [lat, lng]
 * @param {object} [options]
 * @returns {Uint8Array|null} RGB 像素缓冲；输入不可用时返回 null
 */
function renderRouteRGB(routeLatLngs, options = {}) {
  const size = options.size ?? PNG_SIZE;
  const color = options.color ?? STROKE_RGB;
  const lineWidth = options.lineWidth ?? LINE_WIDTH;
  const scaleRatio = options.scaleRatio ?? SCAN_RATIO;
  if (!Array.isArray(routeLatLngs) || routeLatLngs.length < 2) {
    return null;
  }

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const point of routeLatLngs) {
    const lat = point?.[0];
    const lng = point?.[1];
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }

  // 局部米制平面（原点 = 路线包围盒中心）
  const lat0 = (minLat + maxLat) / 2;
  const lng0 = (minLng + maxLng) / 2;
  const metersPerDegLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const local = routeLatLngs.map(([lat, lng]) => [
    (lng - lng0) * metersPerDegLng,
    (lat - lat0) * 111320,
  ]);

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of local) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const span = Math.max(maxX - minX, maxY - minY);
  if (!(span > 0)) return null;

  const scale = (size * scaleRatio) / span;
  const pixels = local.map(([x, y]) => [size / 2 + x * scale, size / 2 - y * scale]);

  // 覆盖度光栅化（超采样）
  const dim = size * SS;
  const cover = new Float32Array(dim * dim);
  const radius = (lineWidth / 2) * SS;
  const step = 0.5; // 沿线采样步长（最终像素单位）
  for (let i = 0; i + 1 < pixels.length; i += 1) {
    const [x1, y1] = pixels[i];
    const [x2, y2] = pixels[i + 1];
    const len = Math.hypot(x2 - x1, y2 - y1);
    const steps = Math.max(1, Math.ceil(len / step));
    for (let s = 0; s <= steps; s += 1) {
      const px = x1 + ((x2 - x1) * s) / steps;
      const py = y1 + ((y2 - y1) * s) / steps;
      stampDisc(cover, dim, px * SS, py * SS, radius);
    }
  }

  // 降采样 → RGB
  const rgb = new Uint8Array(size * size * 3).fill(255);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let sum = 0;
      for (let dy = 0; dy < SS; dy += 1) {
        for (let dx = 0; dx < SS; dx += 1) {
          sum += cover[(y * SS + dy) * dim + (x * SS + dx)];
        }
      }
      const a = Math.min(1, sum / (SS * SS));
      const idx = (y * size + x) * 3;
      for (let c = 0; c < 3; c += 1) {
        rgb[idx + c] = Math.round(255 + (color[c] - 255) * a);
      }
    }
  }
  return rgb;
}

/**
 * 统计一张图的"墨迹"像素占比（用于排除空白图假通过）。
 *
 * @param {Uint8Array} rgb 像素缓冲
 * @param {number} w 宽
 * @param {number} h 高
 * @returns {{nonWhite:number,strong:number,total:number,nonWhiteRatio:number,strongRatio:number}}
 */
function inkStats(rgb, w, h) {
  let nonWhite = 0;
  let strong = 0;
  const total = w * h;
  for (let i = 0; i < total; i += 1) {
    const r = rgb[i * 3];
    const g = rgb[i * 3 + 1];
    const b = rgb[i * 3 + 2];
    if (r !== 255 || g !== 255 || b !== 255) nonWhite += 1;
    if ((r + g + b) / 3 < 200) strong += 1;
  }
  return {
    nonWhite,
    strong,
    total,
    nonWhiteRatio: nonWhite / total,
    strongRatio: strong / total,
  };
}

/* ------------------------------ 语料与基线 ------------------------------ */

/**
 * 读取阶段 0 基线，取出 status==="ok" 的样本 id 集合与基线记录。
 *
 * @returns {{okIds: string[], byId: Map<string, object>, report: object}} 基线视图
 */
function loadBaseline() {
  const report = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const byId = new Map();
  const okIds = [];
  for (const record of report.samples || []) {
    byId.set(record.id, record);
    if (record.status === 'ok') okIds.push(record.id);
  }
  return { okIds, byId, report };
}

/**
 * 把基线的 ok 样本按 id 对齐到 getCorpus() 的样本对象（不按下标对齐）。
 *
 * @param {string[]} okIds 基线通过的样本 id
 * @returns {Array<object>} 语料样本对象
 */
function alignSamples(okIds) {
  const corpus = getCorpus();
  const byId = new Map(corpus.samples.map((sample) => [sample.id, sample]));
  const aligned = [];
  const missing = [];
  for (const id of okIds) {
    const sample = byId.get(id);
    if (sample) aligned.push(sample);
    else missing.push(id);
  }
  if (missing.length) {
    throw new Error(`基线样本在语料中找不到（id 对齐失败）：${missing.join(', ')}`);
  }
  return aligned;
}

/* -------------------------------- 复跑 -------------------------------- */

/**
 * 真实复跑一个样本：真实路网 + searchWithEscalation，返回真实指标。
 *
 * @param {object} sample 语料样本
 * @returns {Promise<object>} 复跑记录
 */
async function rerunSample(sample) {
  const started = performance.now();
  const record = {
    status: 'failed',
    score: null,
    adjustedScore: null,
    sizeMeters: null,
    rotationDeg: null,
    offsetMeters: null,
    qualityGate: { hardFailures: [], softFailures: [], softCount: 0, passes: false },
    eShape: {
      orderedOutlineMaxMeters: null,
      orderedRouteMaxMeters: null,
      frechetMaxMeters: null,
      maxMeters: null,
    },
    triedCount: 0,
    budgetExhausted: false,
    routeLatLngs: [],
    routePointCount: 0,
    routeMeters: null,
    uniqueCrossingCount: null,
    reusedEdgeRatio: null,
    reusedEdgeMeters: null,
    reusedEdgeCount: null,
    error: null,
    reason: null,
  };

  try {
    const networkInstance = networkInstanceById(sample.networkId);
    const network = buildNetwork(networkInstance);
    const outline = sample.outline;
    const customShape = {
      // 名称只作诊断用（生产逻辑不读形状名）；用样本 id，避免任何对象语义
      name: sample.id,
      constraintPoints: outline.constraintPoints,
      outlinePoints: outline.outlinePoints,
    };
    if (outline.parts && outline.parts.length > 0) {
      customShape.parts = outline.parts;
    }
    if (outline.features && outline.features.length > 0) {
      customShape.features = outline.features;
    }

    const outcome = await searchWithEscalation({
      graph: network.graph,
      edgeIndex: network.edgeIndex,
      customShape,
      center: sample.center,
      baseSizeMeters: sample.baseSizeMeters,
    });

    const best = outcome.best || null;
    const metrics = best?.result?.metrics || null;
    const gate = metrics
      ? qualityGateReport(metrics)
      : { hardFailures: ['metrics-missing'], softFailures: [], softCount: 0, passes: false };

    const finite = (value) => (Number.isFinite(value) ? value : null);
    const orderedOutlineMaxMeters = finite(metrics?.orderedOutlineMaxMeters);
    const orderedRouteMaxMeters = finite(metrics?.orderedRouteMaxMeters);
    const frechetMaxMeters = finite(metrics?.frechetMaxMeters);
    const allPresent =
      orderedOutlineMaxMeters !== null &&
      orderedRouteMaxMeters !== null &&
      frechetMaxMeters !== null;

    record.status = outcome.status;
    record.score = finite(best?.score);
    record.adjustedScore = finite(best?.adjustedScore);
    record.sizeMeters = finite(best?.sizeMeters);
    record.rotationDeg = finite(best?.rotationDeg);
    record.offsetMeters = best?.center
      ? finite(distanceMeters(sample.center.lat, sample.center.lng, best.center.lat, best.center.lng))
      : null;
    record.qualityGate = {
      hardFailures: gate.hardFailures,
      softFailures: gate.softFailures.map((item) => item.key),
      softCount: gate.softCount,
      passes: gate.passes,
    };
    record.eShape = {
      orderedOutlineMaxMeters,
      orderedRouteMaxMeters,
      frechetMaxMeters,
      maxMeters: allPresent
        ? Math.max(orderedOutlineMaxMeters, orderedRouteMaxMeters, frechetMaxMeters)
        : null,
    };
    record.triedCount = outcome.triedCount ?? 0;
    record.budgetExhausted = Boolean(outcome.budgetExhausted);
    // 真实路线点列（生产地图上画的那条折线）——渲染只用它，绝不用轮廓点冒充
    record.routeLatLngs = best?.result?.routeLatLngs ?? [];
    record.routePointCount = record.routeLatLngs.length;
    record.routeMeters = finite(metrics?.routeMeters);
    // 路线拓扑诊断（与 web/src/shape-engine.js 同口径）：
    // 唯一交叉数 + 重复道路比例，用于事后把人工盲评结果与机器指标对照。
    const topology = collectRouteTopologyMetrics({
      legs: best?.result?.legs,
      metrics,
    });
    record.uniqueCrossingCount = topology.crossings.count;
    record.reusedEdgeRatio = topology.reuse.reusedEdgeRatio;
    record.reusedEdgeMeters = topology.reuse.reusedEdgeMeters;
    record.reusedEdgeCount = topology.reuse.reusedEdgeCount;

    if (outcome.status !== 'ok') {
      record.reason = best
        ? `复跑未通过（硬门槛 ${record.qualityGate.hardFailures.join('/') || '无'}；软门槛 ${record.qualityGate.softFailures.join('/') || '无'}；最高分 ${record.score ?? '-'}）`
        : '复跑未通过（无任何候选产出）';
    } else if (!best?.result?.routeLatLngs || best.result.routeLatLngs.length < 2) {
      record.reason = '复跑通过但路线点列不足 2 点，无法渲染';
    }
  } catch (error) {
    record.status = 'error';
    record.error = error?.message ? String(error.message) : String(error);
    record.reason = `复跑异常：${record.error}`;
  }

  record.durationMs = Math.round((performance.now() - started) * 10) / 10;
  return record;
}

/* ------------------------------- 匿名编号 ------------------------------- */

/** mulberry32 伪随机（确定性、可复现）。 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fisher-Yates 打散：让匿名编号与真实样本顺序无关联。
 *
 * @param {Array} items 待打散数组（原地打散）
 * @param {number} seed 随机种子
 * @returns {Array} 打散后的数组
 */
function shuffle(items, seed) {
  const rand = mulberry32(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/* ------------------------------ 盲评页 HTML ------------------------------ */

/**
 * 生成盲评页（只含匿名编号；不加载解码表；不含任何身份/标签/分数）。
 *
 * @param {Array<object>} cases 已渲染的用例（按匿名编号升序）
 * @returns {string} HTML 文本
 */
function buildIndexHtml(cases) {
  const cards = cases
    .map((item) => {
      const label = `案例 ${String(item.caseNumber).padStart(2, '0')}`;
      const targetName = SHAPE_NAME_ZH[item.sample.family] || '未知形状';
      return `<figure class="card" data-case="${item.caseId}">
  <img src="png/${item.caseId}.png" width="${PNG_SIZE}" height="${PNG_SIZE}" alt="${label}" loading="lazy">
  <figcaption>
    <div class="case">${label} · 目标形状：<b data-target="${item.caseId}">${targetName}</b></div>
    <div class="judge">
      <label><input type="radio" name="judge-${item.caseId}" value="像"> 像</label>
      <label><input type="radio" name="judge-${item.caseId}" value="不像"> 不像</label>
    </div>
    <textarea class="note" data-note="${item.caseId}" rows="2" placeholder="备注（可选）"></textarea>
  </figcaption>
</figure>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>路线盲评（2026-11-02）</title>
<style>
  body { font-family: "Microsoft YaHei", system-ui, sans-serif; margin: 0; background: #f8fafc; color: #0f172a; }
  header { padding: 24px 28px 8px; }
  h1 { font-size: 21px; margin: 0 0 8px; }
  header p { margin: 3px 0; color: #475569; font-size: 13px; line-height: 1.7; }
  .toolbar { display: flex; gap: 10px; align-items: center; padding: 10px 28px; flex-wrap: wrap; }
  button { font-size: 13px; padding: 7px 14px; border-radius: 8px; border: 1px solid #cbd5e1; background: #fff; cursor: pointer; }
  button:hover { background: #eef2f7; }
  #progress { font-size: 13px; color: #475569; }
  main { display: flex; flex-wrap: wrap; gap: 14px; padding: 6px 28px 40px; }
  .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 10px; margin: 0; width: 344px; }
  .card img { display: block; border: 1px solid #e2e8f0; border-radius: 6px; background: #fff; }
  .case { font-size: 14px; font-weight: 600; margin: 8px 0 6px; }
  .judge { display: flex; gap: 16px; font-size: 14px; margin-bottom: 6px; }
  .judge label { cursor: pointer; }
  textarea { width: 100%; box-sizing: border-box; font-family: inherit; font-size: 12px; padding: 5px 6px; border: 1px solid #e2e8f0; border-radius: 6px; resize: vertical; }
  footer { padding: 0 28px 40px; color: #64748b; font-size: 12px; line-height: 1.8; }
</style>
</head>
<body>
<header>
  <h1>路线盲评</h1>
  <p>每一格是一条<b>实际走出来的路线</b>（真实路网上的折线）。<b>没有画出目标轮廓做对照</b>，请只凭这条线本身判断：它看起来像不像上面写的那个目标形状？</p>
  <p>对每一例选择「像」或「不像」；不像的可以补一句备注（例如"整体是个长条"、"边角没走出来"、"中间断开"）。全部评完后点「导出结果」保存 JSON 交回。</p>
  <p>材料为随机编号，页面不显示任何评分与来源信息；编号与真实样本的对应关系在盲评结束后另行提供。</p>
</header>
<div class="toolbar">
  <button id="export" type="button">导出结果（JSON）</button>
  <button id="copy" type="button">复制结果（文本）</button>
  <span id="progress">已评 0 / ${cases.length}</span>
</div>
<main>
${cards}
</main>
<footer>
  <p>评完之后请把导出的 JSON 回传；如有疑问，联系发起本轮评审的同学。</p>
</footer>
<script>
  (function () {
    var cards = Array.prototype.slice.call(document.querySelectorAll('.card'));
    function collect() {
      var rows = [];
      cards.forEach(function (card) {
        var caseId = card.getAttribute('data-case');
        var picked = card.querySelector('input[name="judge-' + caseId + '"]:checked');
        var note = card.querySelector('textarea[data-note="' + caseId + '"]');
        rows.push({
          caseId: caseId,
          verdict: picked ? picked.value : '',
          note: note ? note.value.trim() : ''
        });
      });
      return rows;
    }
    function refresh() {
      var done = collect().filter(function (r) { return r.verdict !== ''; }).length;
      document.getElementById('progress').textContent = '已评 ' + done + ' / ' + cards.length;
    }
    document.addEventListener('change', function (event) {
      if (event.target && event.target.type === 'radio') refresh();
    });
    document.getElementById('export').addEventListener('click', function () {
      var payload = { reviewedAt: new Date().toISOString(), cases: collect() };
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'blind-review-results.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });
    document.getElementById('copy').addEventListener('click', function () {
      var text = collect().map(function (r) {
        return r.caseId + '\\t' + (r.verdict || '-') + '\\t' + r.note;
      }).join('\\n');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
      }
    });
    refresh();
  })();
</script>
</body>
</html>
`;
}

/**
 * 汇总全部用例的路线拓扑诊断：唯一交叉数分布 + 重复道路比例分位。
 *
 * @param {Array<object>} cases 用例数组（每项含 record）
 * @returns {object} 汇总
 */
function summarizeTopology(cases) {
  const ok = cases.filter((item) => item.record.status === 'ok');
  const crossings = ok
    .filter((item) => Number.isFinite(item.record.uniqueCrossingCount))
    .map((item) => item.record.uniqueCrossingCount);
  const ratios = ok
    .filter((item) => Number.isFinite(item.record.reusedEdgeRatio))
    .map((item) => item.record.reusedEdgeRatio);
  const sortedCrossings = [...crossings].sort((a, b) => a - b);
  const sortedRatios = [...ratios].sort((a, b) => a - b);
  const pick = (arr, p) =>
    arr.length ? arr[Math.min(arr.length - 1, Math.max(0, Math.round((arr.length - 1) * p)))] : null;
  const histogram = {};
  for (const value of crossings) {
    histogram[value] = (histogram[value] || 0) + 1;
  }
  return {
    uniqueCrossingCount: {
      count: crossings.length,
      min: sortedCrossings[0] ?? null,
      p25: pick(sortedCrossings, 0.25),
      p50: pick(sortedCrossings, 0.5),
      p75: pick(sortedCrossings, 0.75),
      p90: pick(sortedCrossings, 0.9),
      max: sortedCrossings[sortedCrossings.length - 1] ?? null,
      histogram,
    },
    reusedEdgeRatio: {
      count: ratios.length,
      min: sortedRatios[0] ?? null,
      p50: pick(sortedRatios, 0.5),
      p90: pick(sortedRatios, 0.9),
      max: sortedRatios[sortedRatios.length - 1] ?? null,
      zeroCount: ratios.filter((value) => value === 0).length,
      aboveZeroCount: ratios.filter((value) => value > 0).length,
    },
  };
}

/* ------------------------------ 泄露自查 ------------------------------ */

/**
 * 盲评页泄露自查：确认页面里没有任何样本身份 / 几何标签 / 路网标签 / 指标字段，
 * 且盲评页**不加载**解码表。
 *
 * 两张词表：
 * - 严格词表（对整页 HTML 检查）：样本 id / 族名 / 路网 id / 指标字段名 /
 *   分层维度键 / 分层取值 / 'manifest'——这些词在任何位置出现都是泄露；
 * - 宽松词表（只对"去掉 style/script 后的可见内容"检查）：'family'、'blob'
 *   之类在 CSS（font-family）与浏览器 API（new Blob）里必然出现的普通词，
 *   对可见内容检查即可，既不误报也不放过真实泄露。
 *
 * @param {string} html 盲评页文本
 * @param {Array<object>} samples 参与盲评的语料样本
 * @returns {{hits: Array<{token: string, count: number, scope: string}>, checked: number, badSources: string[]}}
 */
function checkLeak(html, samples) {
  const strict = new Set([
    'manifest', 'calibration', 'holdout',
    'score', 'adjustedScore', 'sizeMeters', 'rotationDeg', 'offsetMeters',
    'eShape', 'frechetMaxMeters', 'orderedOutlineMaxMeters', 'orderedRouteMaxMeters',
    'qualityGate', 'geometryTags', 'networkTags', 'baseSizeMeters',
    'dominant', 'regularity', 'notch', 'protrusion', 'curvature', 'perimeterSpan',
    'constraintDensity', 'pointDensity', 'localScale', 'integrity', 'connectivity',
    'orientation', 'density',
    // 几何分层取值 / 路网分层取值（可能泄露答案的间接线索）
    'straight', 'curved', 'regular', 'irregular', 'none', 'shallow', 'deep',
    'narrow', 'slender', 'single', 'multi', 'sparse', 'medium', 'dense',
    'clean', 'noisy', 'uniform', 'varied',
    'concentrated', 'diverse', 'connected', 'fragmented', 'broken', 'intact',
  ]);
  const generic = new Set(['family', 'blob', 'lobes', 'spike', 'fork', 'spiral']);
  for (const sample of samples) {
    strict.add(sample.id);
    strict.add(sample.family);
    strict.add(sample.networkId);
  }

  // 可见内容 = 去掉 style/script 后的 HTML（属性与正文都保留）
  const visible = html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ');

  const hits = [];
  const scan = (tokens, target, scope) => {
    for (const token of tokens) {
      const escaped = token.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
      const pattern = new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'gi');
      const found = target.match(pattern);
      if (found && found.length > 0) {
        hits.push({ token, count: found.length, scope });
      }
    }
  };
  scan(strict, html, 'full');
  scan(generic, visible, 'visible');

  // 盲评页只能加载 PNG：任何非 .png 的 src 都是越界加载
  const badSources = [];
  const srcPattern = /\ssrc\s*=\s*"([^"]*)"/gi;
  let match = srcPattern.exec(html);
  while (match) {
    if (!/\.png$/i.test(match[1])) {
      badSources.push(match[1]);
    }
    match = srcPattern.exec(html);
  }

  return { hits, checked: strict.size + generic.size, badSources };
}

/* --------------------------------- 主流程 --------------------------------- */

async function main() {
  setLevel('off'); // 引擎日志默认只进内存缓冲，不刷屏

  const baseline = loadBaseline();
  const samples = alignSamples(baseline.okIds);
  console.log(
    `[盲评] 基线 status==="ok" 样本 ${samples.length} 例（语料版本 ${CORPUS_VERSION} / 主种子 ${CORPUS_MASTER_SEED}）`,
  );

  // 1) 真实复跑
  const runs = [];
  const globalStart = performance.now();
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    const record = await rerunSample(sample);
    runs.push({ sample, record });
    console.log(
      `  [${String(index + 1).padStart(2)}/${samples.length}] ${sample.id} → ${record.status} ` +
        `分 ${record.score ?? '-'} 尺寸 ${record.sizeMeters ?? '-'}m 偏移 ${record.offsetMeters ?? '-'}m ` +
        `E_shape ${record.eShape.maxMeters ?? '-'}m 路线点 ${record.routePointCount} 用时 ${record.durationMs}ms` +
        (record.reason ? ` · ${record.reason}` : ''),
    );
  }
  const totalDurationMs = Math.round((performance.now() - globalStart) * 10) / 10;

  // 2) 匿名编号打散
  const order = shuffle(runs.map((_, index) => index), ANON_SEED);
  const cases = order.map((runIndex, position) => {
    const { sample, record } = runs[runIndex];
    return {
      caseNumber: position + 1,
      caseId: `case-${String(position + 1).padStart(2, '0')}`,
      sample,
      record,
    };
  });

  // 3) 渲染（只画真实路线）
  rmSync(pngDir, { recursive: true, force: true });
  mkdirSync(pngDir, { recursive: true });
  const rendered = [];
  const renderFailures = [];
  for (const item of cases) {
    const { sample, record } = item;
    if (record.status !== 'ok') {
      renderFailures.push({
        caseId: item.caseId,
        sampleId: sample.id,
        reason: record.reason || record.error || '复跑未通过',
      });
      continue;
    }
    // 只画真实路线：record.routeLatLngs 来自本轮真实规划结果
    const rgb = renderRouteRGB(record.routeLatLngs);
    if (!rgb) {
      renderFailures.push({
        caseId: item.caseId,
        sampleId: sample.id,
        reason: '路线点列无法光栅化（点数 < 2 / 坐标非法 / 跨度为 0）',
      });
      continue;
    }
    const file = join(pngDir, `${item.caseId}.png`);
    writeFileSync(file, encodePNG(rgb, PNG_SIZE, PNG_SIZE));
    item.png = `png/${item.caseId}.png`;
    rendered.push(item);
  }

  // 4) 落盘回读校验（统计的是真实文件内容，不是内存缓冲）
  const inkRows = [];
  for (const item of rendered) {
    const file = join(pngDir, `${item.caseId}.png`);
    const bytes = readFileSync(file);
    const { rgb, w, h } = decodePNGRGB(bytes);
    const stats = inkStats(rgb, w, h);
    item.ink = stats;
    item.pngBytes = bytes.length;
    inkRows.push({ caseId: item.caseId, ...stats });
  }

  // 5) manifest（解码表：匿名编号 ↔ 真实样本 id + 真实指标）
  const manifest = {
    note: '解码用文件：盲评页不加载本文件；请在盲评结束后再打开。',
    generatedAt: new Date().toISOString(),
    tool: 'tools/corpus-blind-review.mjs',
    node: process.version,
    corpus: { version: CORPUS_VERSION, masterSeed: CORPUS_MASTER_SEED },
    baseline: {
      file: 'test/fixtures/corpus/baseline-phase0.json',
      okCount: baseline.okIds.length,
      totalCount: baseline.report.counts?.total ?? null,
    },
    rerun: {
      totalDurationMs,
      targetCount: samples.length,
      rerunOk: runs.filter((run) => run.record.status === 'ok').length,
      rerunFailed: runs.filter((run) => run.record.status !== 'ok').length,
      rendered: rendered.length,
      renderFailed: renderFailures.length,
    },
    ink: summarizeInk(inkRows),
    aggregate: {
      topology: summarizeTopology(cases),
    },
    cases: cases.map((item) => {
      const base = baseline.byId.get(item.sample.id);
      const entry = {
        caseId: item.caseId,
        caseNumber: item.caseNumber,
        png: item.png || null,
        // ---- 解码信息（真实身份）----
        sampleId: item.sample.id,
        set: item.sample.set,
        family: item.sample.family,
        targetShapeName: SHAPE_NAME_ZH[item.sample.family] || null,
        geometryTags: item.sample.geometryTags,
        networkId: item.sample.networkId,
        networkTags: item.sample.networkTags,
        baseSizeMeters: item.sample.baseSizeMeters,
        // ---- 本轮真实复跑指标 ----
        rerun: {
          status: item.record.status,
          durationMs: item.record.durationMs,
          triedCount: item.record.triedCount,
          budgetExhausted: item.record.budgetExhausted,
          score: item.record.score,
          adjustedScore: item.record.adjustedScore,
          sizeMeters: item.record.sizeMeters,
          rotationDeg: item.record.rotationDeg,
          offsetMeters: item.record.offsetMeters,
          eShape: item.record.eShape,
          qualityGate: item.record.qualityGate,
          routePointCount: item.record.routePointCount,
          routeMeters: item.record.routeMeters,
          // 路线拓扑诊断（与 shape-engine.js 同口径）：唯一交叉数 + 重复道路比例
          uniqueCrossingCount: item.record.uniqueCrossingCount,
          reusedEdgeRatio: item.record.reusedEdgeRatio,
          reusedEdgeMeters: item.record.reusedEdgeMeters,
          reusedEdgeCount: item.record.reusedEdgeCount,
          reason: item.record.reason,
          error: item.record.error,
        },
        baseline: base
          ? {
            status: base.status,
            score: base.score,
            sizeMeters: base.sizeMeters,
            offsetMeters: base.offsetMeters,
            eShapeMaxMeters: base.eShape?.maxMeters ?? null,
          }
          : null,
        render: item.ink
          ? {
            nonWhiteRatio: item.ink.nonWhiteRatio,
            strongRatio: item.ink.strongRatio,
            nonWhitePixels: item.ink.nonWhite,
            strongPixels: item.ink.strong,
            totalPixels: item.ink.total,
            pngBytes: item.pngBytes,
            pngWidth: PNG_SIZE,
            pngHeight: PNG_SIZE,
          }
          : null,
      };
      return entry;
    }),
    renderFailures,
  };
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  // 6) 盲评页
  const html = buildIndexHtml(rendered);
  writeFileSync(join(outDir, 'index.html'), html, 'utf8');

  // 7) 自检：空白图假通过 / 泄露字段
  const problems = [];
  if (rendered.length === 0) {
    problems.push('没有任何 PNG 产出（渲染全失败）——拒绝报成功');
  }
  const blank = inkRows.filter((row) => row.strongRatio <= 0.001);
  if (blank.length) {
    problems.push(`发现 ${blank.length} 张几乎空白的图（强墨迹占比 ≤ 0.1%）：${blank.map((r) => r.caseId).join(', ')}`);
  }
  const allWhite = inkRows.filter((row) => row.nonWhite === 0);
  if (allWhite.length) {
    problems.push(`发现 ${allWhite.length} 张全白图：${allWhite.map((r) => r.caseId).join(', ')}`);
  }
  const leak = checkLeak(html, samples);
  if (leak.hits.length) {
    problems.push(`盲评页存在泄露字段：${leak.hits.map((h) => `${h.token}(${h.count}, ${h.scope})`).join(', ')}`);
  }
  if (leak.badSources.length) {
    problems.push(`盲评页加载了非 PNG 资源（不得加载解码表）：${leak.badSources.join(', ')}`);
  }
  // 每张图必须带目标形状语义名（否则评判者无从判断"像不像"）
  const labelCount = (html.match(/data-target="/g) || []).length;
  if (labelCount !== rendered.length) {
    problems.push(`盲评页目标形状名数量 ${labelCount} ≠ 渲染用例数 ${rendered.length}`);
  }
  // 拓扑诊断字段必须齐全（事后要把人工盲评结果与机器指标对照）
  const missingTopology = cases.filter(
    (item) => item.record.status === 'ok' &&
      (!Number.isFinite(item.record.uniqueCrossingCount) || !Number.isFinite(item.record.reusedEdgeRatio)),
  );
  if (missingTopology.length) {
    problems.push(`拓扑诊断字段缺失 ${missingTopology.length} 例：${missingTopology.map((i) => i.sample.id).join(', ')}`);
  }
  // PNG 二进制里不应出现样本 id
  const pngLeaks = [];
  for (const item of rendered) {
    const text = readFileSync(join(pngDir, `${item.caseId}.png`)).toString('latin1');
    if (text.includes(item.sample.id)) {
      pngLeaks.push(item.caseId);
    }
  }
  if (pngLeaks.length) {
    problems.push(`PNG 二进制含样本 id：${pngLeaks.join(', ')}`);
  }

  // 8) 打印统计
  const inkSorted = inkRows.map((r) => r.strongRatio).sort((a, b) => a - b);
  const nonWhiteSorted = inkRows.map((r) => r.nonWhiteRatio).sort((a, b) => a - b);
  console.log('');
  console.log('[自检汇总]');
  console.log(`  目标样本（基线 status==="ok"）      ${samples.length}`);
  console.log(`  实际复跑通过                        ${manifest.rerun.rerunOk}`);
  console.log(`  复跑未通过                          ${manifest.rerun.rerunFailed}`);
  console.log(`  渲染成功                            ${manifest.rerun.rendered}`);
  console.log(`  渲染失败                            ${manifest.rerun.renderFailed}`);
  console.log(`  复跑总耗时                          ${(totalDurationMs / 1000).toFixed(1)}s`);
  if (renderFailures.length) {
    console.log('  失败明细：');
    for (const failure of renderFailures) {
      console.log(`    - ${failure.caseId} (${failure.sampleId})：${failure.reason}`);
    }
  }
  console.log('');
  console.log('[墨迹统计（落盘回读）]');
  console.log(`  强墨迹占比（亮度<200） min/中位/max = ` +
    `${fmtRatio(inkSorted[0])} / ${fmtRatio(inkSorted[Math.floor(inkSorted.length / 2)])} / ${fmtRatio(inkSorted[inkSorted.length - 1])}`);
  console.log(`  非白像素占比（≠纯白）  min/中位/max = ` +
    `${fmtRatio(nonWhiteSorted[0])} / ${fmtRatio(nonWhiteSorted[Math.floor(nonWhiteSorted.length / 2)])} / ${fmtRatio(nonWhiteSorted[nonWhiteSorted.length - 1])}`);
  console.log(`  抽样（前 3 例）      ${inkRows.slice(0, 3).map((r) => `${r.caseId}=${fmtRatio(r.strongRatio)}`).join('  ')}`);
  console.log('');
  console.log(`[泄露自查] 检查 ${leak.checked} 个敏感 token（严格词表查整页 / 宽松词表查可见内容），命中 ${leak.hits.length} 项；非 PNG 资源引用 ${leak.badSources.length} 项`);
  if (leak.hits.length) {
    for (const hit of leak.hits) {
      console.log(`  ! ${hit.token} × ${hit.count}（${hit.scope}）`);
    }
  }
  const topo = manifest.aggregate.topology;
  console.log('');
  console.log('[路线拓扑诊断（全部用例）]');
  console.log(`  唯一交叉数 min/中位/P90/max = ${topo.uniqueCrossingCount.min} / ${topo.uniqueCrossingCount.p50} / ${topo.uniqueCrossingCount.p90} / ${topo.uniqueCrossingCount.max}`);
  console.log(`  唯一交叉数分布 = ${JSON.stringify(topo.uniqueCrossingCount.histogram)}`);
  console.log(`  重复道路比例 min/中位/P90/max = ${topo.reusedEdgeRatio.min} / ${topo.reusedEdgeRatio.p50} / ${topo.reusedEdgeRatio.p90} / ${topo.reusedEdgeRatio.max}（为 0 的 ${topo.reusedEdgeRatio.zeroCount} 例）`);
  console.log(`[产出] ${outDir}`);

  if (problems.length) {
    console.error('');
    console.error('[失败] 自检未通过：');
    for (const problem of problems) {
      console.error(`  - ${problem}`);
    }
    return 1;
  }
  return 0;
}

/** 比例格式化（百分比，2 位小数）。 */
function fmtRatio(value) {
  return `${(value * 100).toFixed(2)}%`;
}

/**
 * 墨迹统计汇总（min / 中位 / max）。
 *
 * @param {Array<object>} rows 逐例墨迹统计
 * @returns {object} 汇总
 */
function summarizeInk(rows) {
  if (!rows.length) {
    return { count: 0, strong: null, nonWhite: null };
  }
  const strong = rows.map((r) => r.strongRatio).sort((a, b) => a - b);
  const nonWhite = rows.map((r) => r.nonWhiteRatio).sort((a, b) => a - b);
  const pick = (arr, p) => arr[Math.min(arr.length - 1, Math.max(0, Math.round((arr.length - 1) * p)))];
  return {
    count: rows.length,
    strong: { min: strong[0], median: pick(strong, 0.5), max: strong[strong.length - 1] },
    nonWhite: { min: nonWhite[0], median: pick(nonWhite, 0.5), max: nonWhite[nonWhite.length - 1] },
  };
}

/** 直接运行时才执行主流程（被 import 时只导出纯函数，便于自检脚本复用）。 */
const invokedDirectly =
  Boolean(process.argv[1]) && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

export { renderRouteRGB, encodePNG, decodePNGRGB, inkStats, checkLeak, buildIndexHtml };

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
      // 引擎分片让出会留下 MessageChannel 句柄，Node 不会自动退出；
      // 等 stdout 冲刷完再主动结束，保证管道场景下输出完整且退出码正确。
      process.stdout.write('', () => process.exit(code));
    })
    .catch((error) => {
      console.error('[corpus-blind-review] 执行失败：', error);
      process.exitCode = 1;
      process.stdout.write('', () => process.exit(1));
    });
}