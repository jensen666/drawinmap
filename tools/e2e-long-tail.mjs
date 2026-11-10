/**
 * 长尾图形轮廓来源与贴路上限 · 真实链路 E2E 驱动（L1~L6）。
 *
 * 方案：docs/方案设计/2026-11-01-长尾图形轮廓来源与贴路上限方案.md
 *   §2 A 词边界、§3 B 图片描摹、§4.1 能力验证、§4.2 链路验收、§1 两个计数。
 * 用例：test/long-tail-e2e-cases.mjs（本驱动只负责浏览器/CDP、fixture 解码、独立 IoU 校验、日志与计数）。
 *
 * 真实性（与 30 例 E2E 同一环境，无 mock）：
 * - 浏览器：Edge/Chrome headless + CDP，真实 DOM 输入/点击/上传；
 * - LLM：页面 web/src/agent/agent-config.js 的真实接口（真实网络调用，会消耗额度）；
 * - 路网：node web/server.mjs 5173 提供的真实 guangzhou-roads.json；
 * - 断言证据：页面落盘状态（localStorage 会话）→ 地图图层颜色/目标点序列图 → 页面日志 API
 *   （window.DrawInMapLog.entries 的 agent.* / reference.* / plan.* / target.* / deliver.* / llm.request）。
 *
 * 独立 IoU 校验（方案 §4.2 要求，禁止复用页面描摹函数）：
 * - 本文件用 node:zlib inflateSync 自实现最小 PNG 解码（8-bit 灰度/RGB/RGBA、filter 0~4、无交错）；
 * - 与白底差异阈值取前景掩膜 → 孔洞填充 → 前景外接框；
 * - 把页面 store 里落盘的 outline.points（归一化 [-0.5,0.5]，y 向上）按外接框映射回像素坐标，
 *   用独立扫描线栅格化多边形，计算与填充后掩膜的 IoU；并检查点列内部无孔。
 *
 * 运行：
 *   node tools/e2e-long-tail.mjs                      # 跑全部可执行用例（L6 为统计项跳过）
 *   node tools/e2e-long-tail.mjs --list               # 列出用例
 *   node tools/e2e-long-tail.mjs --cases L1,L2        # 只跑指定用例
 *   node tools/e2e-long-tail.mjs --cases L4           # 前缀：跑 L4-1..L4-8
 *   node tools/e2e-long-tail.mjs --cases L1..L3       # 区间
 *   node tools/e2e-long-tail.mjs --turn-timeout 300000 --out result.json
 *   node tools/e2e-long-tail.mjs --keep-open          # 失败/调试时保留浏览器进程
 *   node tools/e2e-long-tail.mjs --counts             # 两次跑完后统计 §1 两个计数并写回 result.json
 *
 * 产物：
 *   docs/测试报告/2026-11-01-长尾图形轮廓来源与贴路上限验收/<caseId>-<slug>.png（截图证据）
 *   docs/测试报告/2026-11-01-长尾图形轮廓来源与贴路上限验收/result.json（逐例断言/耗时/截图）
 *   docs/测试报告/2026-11-01-长尾图形轮廓来源与贴路上限验收/result-counts.json（§1 计数）
 *
 * 说明：每例先导航离开页面（让 pagehide 把旧会话 flush 完）→ 清 origin localStorage → 重新进入，
 * 保证用例互相独立；profile 目录放项目 .tmp/ 下（不用 os.tmpdir()，历史失败原因之一）。
 */

import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

/** 长尾用例定义与断言 */
import { CASES } from '../test/long-tail-e2e-cases.mjs';
/** 30 例回归定义（L6-a 计数需要其 input 文本；本驱动不执行 30 例） */
import { CASES as REGRESSION_CASES } from '../test/e2e-real-llm-30-cases.mjs';
import { Cdp, resolveBrowser, findFreePort, launchBrowser, sleep } from './lib/cdp-driver.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_URL = process.env.DRAWINMAP_E2E_URL || 'http://127.0.0.1:5173/';
/** 本套用例产物目录（截图 + result.json） */
const ARTIFACT_DIR = path.join(ROOT, 'docs', '测试报告', '2026-11-01-长尾图形轮廓来源与贴路上限验收');
/** 30 例回归产物目录（--counts 读取其 result 文件的运行窗口） */
const REGRESSION_ARTIFACT_DIR = path.join(ROOT, 'docs', '测试报告', '2026-11-01-真实LLM-E2E-30例');
/** 页面日志服务端落盘目录（--counts 统计 b 用） */
const LOG_DIR = path.join(ROOT, 'web', 'logs');
/** 参考素材 manifest（L6-a 独立复算本地命中用） */
const MANIFEST_PATH = path.join(ROOT, 'web', 'data', 'shapes', 'manifest.json');
/** fixture 目录（8 张白底剪影 + 1 张照片样本） */
const FIXTURE_DIR = path.join(ROOT, 'test', 'fixtures', 'trace-images');

/** 命令行参数 */
const argv = process.argv.slice(2);
const argOf = (name, fallback = null) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const KEEP_OPEN = argv.includes('--keep-open');
const LIST_ONLY = argv.includes('--list');
const COUNTS_MODE = argv.includes('--counts');
/** 用例筛选：--cases L1,L2 或 --cases L4 或 --cases L1..L3 */
const CASE_FILTER = argOf('cases', null);
/** 单轮等待上限（毫秒，默认 5 分钟：描摹 + LLM + 目标验收 + 路网搜索） */
const TURN_TIMEOUT = Number(argOf('turn-timeout', '300000'));
/** 结果文件名 */
const RESULT_NAME = argOf('out', 'result.json');
/** 30 例回归结果文件名（--counts 用；由 30 例驱动 --out 指定） */
const REGRESSION_RESULT_NAME = argOf('regression-result', 'result-30-regression.json');
/** 截图时统一尺寸 */
const VIEW = { width: 1440, height: 900 };

/** 断言收集（全局；每例按切片归属） */
const checks = [];

/**
 * 记录一条断言。
 *
 * @param {string} label 断言描述
 * @param {boolean} condition 断言条件
 * @param {string} [detail] 失败详情
 */
function check(label, condition, detail = '') {
  const ok = Boolean(condition);
  checks.push({ label, ok, detail: ok ? '' : String(detail) });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` → ${detail}`}`);
}

/* ============================ 页面表达式 ============================ */

/** 页面内读取的辅助表达式（一次往返取全部断言所需信息） */
const EXPR = {
  /** 应用就绪：对话面板 + 欢迎消息已渲染（地点配置/控制器初始化完成） */
  ready: `!!(document.getElementById('agent-send') && document.querySelector('#agent-messages .agent-msg'))`,
  /**
   * 状态快照：会话落盘状态（含完整 outline：name/source/pointCount/rotationDeg/contentHash/points）
   * + DOM 状态（候选卡/引导选项/气泡图注/上传提示/地图图层）。
   */
  snapshot: `(() => {
    const readStore = () => {
      try {
        const raw = localStorage.getItem('drawinmap.sessions.v1');
        if (!raw) return null;
        const state = JSON.parse(raw);
        const session = state.sessions.find((item) => item.id === state.activeId) || null;
        if (!session) {
          return { activeId: state.activeId, sessionCount: state.sessions.length, session: null };
        }
        const trimOutline = (outline) => (outline ? {
          name: outline.name ?? null,
          source: outline.source ?? null,
          pointCount: outline.pointCount ?? null,
          rotationDeg: outline.rotationDeg ?? null,
          contentHash: outline.contentHash ?? null,
          points: Array.isArray(outline.points) ? outline.points : null,
          rendered: Boolean(outline.dataUrl),
        } : null);
        const messages = session.messages.map((m) => ({
          id: m.id,
          role: m.role,
          kind: m.kind || null,
          status: m.status || null,
          hasImage: Boolean(m.image),
          text: typeof m.text === 'string' ? m.text.slice(0, 1200) : '',
          traceId: m.traceId || null,
          referenceChoiceId: m.referenceChoiceId || null,
          selectedCandidateId: m.selectedCandidateId || null,
          options: Array.isArray(m.options) ? m.options.map((o) => o.label ?? o.value ?? '') : null,
          outline: trimOutline(m.outline),
          shapeId: m.shapeId || null,
        }));
        const shapes = session.shapes.map((s) => ({
          id: s.id,
          shapeName: s.shapeName ?? null,
          reference: Boolean(s.reference),
          sizeMeters: s.sizeMeters ?? null,
          rotationDeg: s.rotationDeg ?? null,
          score: s.score ?? null,
          label: s.label ?? null,
          turnId: s.turnId ?? null,
        }));
        const ctx = session.context || {};
        return {
          activeId: state.activeId,
          sessionCount: state.sessions.length,
          sessions: state.sessions.map((item) => ({
            id: item.id,
            title: item.title,
            messageCount: item.messages.filter((m) => m.kind !== 'welcome').length,
            shapeCount: item.shapes.length,
            shapeNames: item.shapes.map((s) => s.shapeName),
            active: item.id === state.activeId,
          })),
          session: {
            id: session.id,
            title: session.title,
            messageCount: messages.length,
            messages,
            shapes,
            activeShapeId: session.activeShapeId ?? null,
            context: {
              guide: ctx.guide ? { slot: ctx.guide.slot, options: (ctx.guide.options || []).map((o) => o.label ?? o.value ?? '') } : null,
              referenceChoice: ctx.referenceChoice ? {
                choiceId: ctx.referenceChoice.choiceId ?? null,
                status: ctx.referenceChoice.status ?? null,
                candidateCount: (ctx.referenceChoice.candidates || []).length,
                candidateIds: (ctx.referenceChoice.candidates || []).map((c) => c.candidateId ?? null),
                selectedCandidateId: ctx.referenceChoice.selectedCandidateId ?? null,
              } : null,
            },
          },
        };
      } catch (error) {
        return { error: String(error && error.message ? error.message : error) };
      }
    };
    const overlayPaths = Array.from(document.querySelectorAll('.leaflet-overlay-pane path'));
    const welcomeTexts = Array.from(document.querySelectorAll('#agent-messages .agent-msg-agent .agent-msg-text'))
      .map((el) => el.textContent || '')
      .join('\\n');
    const imageBtn = document.getElementById('agent-image-btn');
    const agentBtn = document.getElementById('agent-btn');
    const inputEl = document.getElementById('agent-input');
    return {
      store: readStore(),
      dom: {
        sendText: (document.getElementById('agent-send') || {}).textContent?.trim() ?? null,
        guideLabels: Array.from(document.querySelectorAll('.agent-options.is-live .agent-chip')).map((b) => b.textContent.trim()),
        refCards: Array.from(document.querySelectorAll('.agent-reference-choice.is-live .agent-ref-card')).map((card) => ({
          name: card.querySelector('.agent-ref-name')?.textContent ?? '',
          meta: card.querySelector('.agent-ref-meta')?.textContent ?? '',
          badge: card.querySelector('.agent-ref-badge')?.textContent ?? '',
          tags: card.querySelector('.agent-ref-tags')?.textContent ?? '',
          hasImage: Boolean(card.querySelector('img')?.src?.startsWith('data:image')),
          pointCount: Number((card.querySelector('.agent-ref-meta')?.textContent ?? '').match(/(\\d+)\\s*点/)?.[1] ?? 0),
        })),
        lastAgentText: (() => {
          const list = document.querySelectorAll('.agent-msg-agent .agent-msg-text');
          return list.length ? list[list.length - 1].textContent : '';
        })(),
        lastUserText: (() => {
          const list = document.querySelectorAll('.agent-msg-user .agent-msg-text');
          return list.length ? list[list.length - 1].textContent : '';
        })(),
        outlineCaption: (() => {
          const list = document.querySelectorAll('.agent-outline-caption');
          return list.length ? list[list.length - 1].textContent : '';
        })(),
        reasoningTexts: Array.from(document.querySelectorAll('.agent-reasoning-steps li')).map((li) => li.textContent),
        errorText: (() => {
          const el = document.querySelector('.agent-msg-error');
          return el ? el.textContent : null;
        })(),
        attachVisible: !document.getElementById('agent-attach')?.hasAttribute('hidden'),
        overlayCount: overlayPaths.length,
        routeStrokes: overlayPaths.map((p) => p.getAttribute('stroke')).filter(Boolean),
        indicator: (document.getElementById('shape-indicator') || {}).textContent?.trim() ?? '',
        switcherHidden: (document.getElementById('shape-switcher') || { hasAttribute: () => true }).hasAttribute('hidden'),
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        reasoningSteps: document.querySelectorAll('.agent-reasoning-steps li').length,
        refChoiceVisible: document.querySelectorAll('.agent-reference-choice.is-live .agent-ref-card').length > 0,
        guideVisible: document.querySelectorAll('.agent-options.is-live .agent-chip').length > 0,
        uiTextAll: [
          welcomeTexts,
          imageBtn?.title ?? '',
          agentBtn?.title ?? '',
          inputEl?.placeholder ?? '',
          document.getElementById('agent-image-input')?.title ?? '',
        ].filter(Boolean).join('\\n'),
      },
    };
  })()`,
  /** 发送一轮文本（等价用户输入后点发送；文本可为空——图片轮） */
  send: (text) => `(() => {
    const input = document.getElementById('agent-input');
    if (!input) return { ok: false, reason: 'no-input' };
    input.value = ${JSON.stringify(text)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const button = document.getElementById('agent-send');
    if (!button || button.textContent.trim() !== '发送') return { ok: false, reason: 'busy', label: button ? button.textContent.trim() : null };
    button.click();
    return { ok: true };
  })()`,
  /** 点引导选项（按文本包含匹配；label 可为 null 时用 index） */
  clickGuide: (label, index) => `(() => {
    const chips = Array.from(document.querySelectorAll('.agent-options.is-live .agent-chip'));
    const labels = chips.map((c) => c.textContent.trim());
    const want = ${JSON.stringify(label ?? null)};
    const target = want ? chips.find((c) => c.textContent.includes(want)) : chips[${Number(index) || 0}];
    if (!target) return { ok: false, labels };
    target.click();
    return { ok: true, picked: target.textContent.trim(), labels };
  })()`,
  /** 点参考候选卡 */
  clickRefCard: (index) => `(() => {
    const cards = Array.from(document.querySelectorAll('.agent-reference-choice.is-live .agent-ref-card'));
    if (!cards[${Number(index)}]) return { ok: false, count: cards.length };
    const meta = cards[${Number(index)}].querySelector('.agent-ref-meta')?.textContent ?? '';
    const name = cards[${Number(index)}].querySelector('.agent-ref-name')?.textContent ?? '';
    cards[${Number(index)}].click();
    return { ok: true, count: cards.length, name, meta, pointCount: Number(meta.match(/(\\d+)\\s*点/)?.[1] ?? 0) };
  })()`,
  /** 点击发送/停止按钮（同一个按钮，按当前文本决定行为） */
  clickSend: `(() => {
    const button = document.getElementById('agent-send');
    if (!button) return { ok: false, reason: 'no-button' };
    const label = button.textContent.trim();
    button.click();
    return { ok: true, label };
  })()`,
  /**
   * 读取本轮真实链路日志（按 traceId）：事件过滤 + llm.request 图片输入摘要。
   * 只保留断言所需事件，避免把整轮日志（含大对象）搬回 Node。
   */
  logs: (traceId) => `(() => {
    const api = window.DrawInMapLog;
    if (!api || typeof api.entries !== 'function') return { unavailable: true };
    const wanted = new Set([
      'agent.intent', 'agent.reply', 'agent.chat', 'agent.reference.miss', 'agent.reference.used',
      'agent.reference.failed', 'reference.candidates', 'reference.choice', 'reference.selection.required',
      'agent.imageTrace.used', 'agent.imageTrace.rejected', 'agent.imageTrace.failed',
      'plan.request', 'plan.result', 'plan.begin', 'plan.failed', 'plan.diagnostic.failed',
      'target.accepted', 'target.rejected', 'target.blocked',
      'guide.question', 'guide.done', 'place.resolved', 'place.unresolved.ask',
      'llm.request', 'llm.response', 'llm.error', 'llm.retry',
      'agent.intent.failed', 'agent.intent.unparsable', 'ui.send.failed', 'ui.image.ready',
    ]);
    /** 只摘要 llm.request 的图片输入判定（消息原文本可能很大） */
    const summarizeLlmRequest = (data) => {
      const messages = Array.isArray(data?.messages) ? data.messages : [];
      let hasImageInput = false;
      let imageInputCount = 0;
      const walk = (value, depth) => {
        if (depth > 6 || value === null || value === undefined) return;
        if (typeof value === 'string') {
          if (value.includes('data:image') || value.includes('图片 dataURL 已省略')) hasImageInput = true;
          return;
        }
        if (Array.isArray(value)) {
          for (const item of value) walk(item, depth + 1);
          return;
        }
        if (typeof value === 'object') {
          if (value.type === 'image_url') {
            hasImageInput = true;
            imageInputCount += 1;
          }
          for (const item of Object.values(value)) walk(item, depth + 1);
        }
      };
      walk(messages, 0);
      return {
        model: data?.model ?? null,
        attempt: data?.attempt ?? null,
        messageCount: messages.length,
        hasImageInput,
        imageInputCount,
      };
    };
    try {
      const records = api.entries({ traceId: ${JSON.stringify(traceId)}, level: 'debug', limit: 0 }) || [];
      const entries = [];
      for (const record of records) {
        if (!record) continue;
        const event = record.event;
        if (!wanted.has(event) && !String(event).startsWith('deliver.')) continue;
        let data = record.data ?? null;
        if (event === 'llm.request') data = summarizeLlmRequest(data);
        entries.push({ event, level: record.level, module: record.module, spanId: record.spanId ?? null, data });
      }
      return { entries };
    } catch (error) {
      return { error: String(error && error.message ? error.message : error) };
    }
  })()`,
};

/* ============================ PNG 独立解码（Node 侧） ============================ */

/**
 * Paeth 预测器（PNG filter 4）。
 *
 * @param {number} a 左
 * @param {number} b 上
 * @param {number} c 左上
 * @returns {number} 预测值
 */
function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * 最小 PNG 解码器：支持 8-bit 灰度/灰度+Alpha/RGB/RGBA、filter 0~4、无交错。
 * 不依赖任何第三方库（方案要求 Node 侧独立解码，不复用页面代码）。
 *
 * @param {Buffer} buffer PNG 文件内容
 * @returns {{width: number, height: number, channels: number, colorType: number, pixels: Buffer}} 解码结果
 */
function decodePng(buffer) {
  if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47) {
    throw new Error('不是 PNG 文件（签名不符）');
  }
  let offset = 8;
  let header = null;
  const idatChunks = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) {
      throw new Error(`PNG 块 ${type} 越界（文件损坏）`);
    }
    if (type === 'IHDR') {
      header = {
        width: buffer.readUInt32BE(dataStart),
        height: buffer.readUInt32BE(dataStart + 4),
        bitDepth: buffer[dataStart + 8],
        colorType: buffer[dataStart + 9],
        compression: buffer[dataStart + 10],
        filter: buffer[dataStart + 11],
        interlace: buffer[dataStart + 12],
      };
    } else if (type === 'IDAT') {
      idatChunks.push(buffer.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      break;
    }
    offset = dataEnd + 4; // 跳过 CRC
  }
  if (!header) {
    throw new Error('PNG 缺少 IHDR');
  }
  if (header.bitDepth !== 8) {
    throw new Error(`仅支持 8-bit PNG（实际 bitDepth=${header.bitDepth}）`);
  }
  if (header.compression !== 0) {
    throw new Error(`不支持的 PNG 压缩方式 ${header.compression}`);
  }
  if (header.filter !== 0) {
    throw new Error('不支持的 PNG 行过滤方式（应为 0）');
  }
  if (header.interlace !== 0) {
    throw new Error('不支持交错 PNG（interlace=1）');
  }
  const channelsByColorType = { 0: 1, 2: 3, 4: 2, 6: 4 };
  const channels = channelsByColorType[header.colorType];
  if (!channels) {
    throw new Error(`不支持的 PNG colorType=${header.colorType}（仅灰度/灰度+Alpha/RGB/RGBA）`);
  }
  const { width, height } = header;
  if (!(width > 0) || !(height > 0)) {
    throw new Error(`PNG 尺寸非法：${width}x${height}`);
  }
  const idat = Buffer.concat(idatChunks);
  if (idat.length === 0) {
    throw new Error('PNG 缺少 IDAT 数据');
  }
  const raw = zlib.inflateSync(idat);
  const rowBytes = width * channels;
  const expected = height * (rowBytes + 1);
  if (raw.length < expected) {
    throw new Error(`PNG 解压数据不足：${raw.length} < ${expected}`);
  }
  const pixels = Buffer.alloc(rowBytes * height);
  let previous = Buffer.alloc(rowBytes);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (rowBytes + 1);
    const filterType = raw[rowStart];
    const row = raw.subarray(rowStart + 1, rowStart + 1 + rowBytes);
    const recon = Buffer.alloc(rowBytes);
    for (let x = 0; x < rowBytes; x += 1) {
      const left = x >= channels ? recon[x - channels] : 0;
      const up = previous[x];
      const upLeft = x >= channels ? previous[x - channels] : 0;
      let value;
      switch (filterType) {
        case 0:
          value = row[x];
          break;
        case 1:
          value = row[x] + left;
          break;
        case 2:
          value = row[x] + up;
          break;
        case 3:
          value = row[x] + ((left + up) >> 1);
          break;
        case 4:
          value = row[x] + paethPredictor(left, up, upLeft);
          break;
        default:
          throw new Error(`不支持的 PNG filter=${filterType}（第 ${y} 行）`);
      }
      recon[x] = value & 0xff;
    }
    recon.copy(pixels, y * rowBytes);
    previous = recon;
  }
  return { width, height, channels, colorType: header.colorType, pixels };
}

/**
 * 取 PNG 像素的 RGB 分量（灰度/RGB 统一口径）。
 *
 * @param {object} png 解码结果
 * @param {number} index 像素下标
 * @returns {[number, number, number]} RGB
 */
function pixelRgb(png, index) {
  const offset = index * png.channels;
  const pixels = png.pixels;
  if (png.channels <= 2) {
    const gray = pixels[offset];
    return [gray, gray, gray];
  }
  return [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
}

/**
 * 估计背景色（四条边像素逐通道中位数）+ 与背景差异阈值取前景掩膜。
 *
 * @param {object} png 解码结果
 * @param {number} [tolerance] 最大通道差阈值
 * @returns {{mask: Uint8Array, background: [number, number, number], foregroundRatio: number}} 掩膜结果
 */
function buildForegroundMask(png, tolerance = 48) {
  const { width, height } = png;
  const border = [[], [], []];
  const pushBorder = (x, y) => {
    const rgb = pixelRgb(png, y * width + x);
    border[0].push(rgb[0]);
    border[1].push(rgb[1]);
    border[2].push(rgb[2]);
  };
  for (let x = 0; x < width; x += 1) {
    pushBorder(x, 0);
    pushBorder(x, height - 1);
  }
  for (let y = 1; y < height - 1; y += 1) {
    pushBorder(0, y);
    pushBorder(width - 1, y);
  }
  const median = (list) => {
    const sorted = list.slice().sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };
  const background = [median(border[0]), median(border[1]), median(border[2])];
  const mask = new Uint8Array(width * height);
  let foreground = 0;
  for (let index = 0; index < width * height; index += 1) {
    const [r, g, b] = pixelRgb(png, index);
    const diff = Math.max(Math.abs(r - background[0]), Math.abs(g - background[1]), Math.abs(b - background[2]));
    if (diff > tolerance) {
      mask[index] = 1;
      foreground += 1;
    }
  }
  return { mask, background, foregroundRatio: foreground / (width * height) };
}

/**
 * 求掩膜外接框与前景像素数。
 *
 * @param {Uint8Array} mask 掩膜
 * @param {number} width 宽
 * @param {number} height 高
 * @returns {{minX: number, maxX: number, minY: number, maxY: number, width: number, height: number, count: number}} 外接框
 */
function maskBounds(mask, width, height) {
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;
  let count = 0;
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x += 1) {
      if (!mask[rowOffset + x]) continue;
      count += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return {
    minX,
    maxX,
    minY,
    maxY,
    width: count > 0 ? maxX - minX + 1 : 0,
    height: count > 0 ? maxY - minY + 1 : 0,
    count,
  };
}

/**
 * 用 4 邻接泛洪标记「与图像边界连通的背景」。
 *
 * @param {Uint8Array} mask 前景掩膜（1=前景）
 * @param {number} width 宽
 * @param {number} height 高
 * @returns {Uint8Array} reachable（1=与边界连通的背景）
 */
function floodFillOutside(mask, width, height) {
  const reachable = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  let top = 0;
  const push = (index) => {
    if (index < 0 || index >= mask.length) return;
    if (mask[index] || reachable[index]) return;
    reachable[index] = 1;
    stack[top] = index;
    top += 1;
  };
  for (let x = 0; x < width; x += 1) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    push(y * width);
    push(y * width + width - 1);
  }
  while (top > 0) {
    top -= 1;
    const index = stack[top];
    const x = index % width;
    if (x > 0) push(index - 1);
    if (x < width - 1) push(index + 1);
    push(index - width);
    push(index + width);
  }
  return reachable;
}

/**
 * 填充掩膜内部的孔洞（不与边界连通的背景 = 孔洞）。
 *
 * @param {Uint8Array} mask 前景掩膜
 * @param {number} width 宽
 * @param {number} height 高
 * @returns {{filled: Uint8Array, holes: number}} 填充结果与孔洞像素数
 */
function fillMaskHoles(mask, width, height) {
  const reachable = floodFillOutside(mask, width, height);
  const filled = Uint8Array.from(mask);
  let holes = 0;
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index] && !reachable[index]) {
      filled[index] = 1;
      holes += 1;
    }
  }
  return { filled, holes };
}

/**
 * 统计栅格化多边形内部的孔洞像素数（用于"孔不保留"独立校验）。
 *
 * @param {Uint8Array} polygonMask 多边形栅格化掩膜
 * @param {number} width 宽
 * @param {number} height 高
 * @returns {number} 内部孔洞像素数（应为 0）
 */
function countMaskHoles(polygonMask, width, height) {
  const reachable = floodFillOutside(polygonMask, width, height);
  let holes = 0;
  for (let index = 0; index < polygonMask.length; index += 1) {
    if (!polygonMask[index] && !reachable[index]) holes += 1;
  }
  return holes;
}

/**
 * 扫描线栅格化多边形（像素中心在内部则填充），返回掩膜与面积。
 *
 * @param {Array<[number, number]>} pixelPoints 像素坐标点列（首尾自动闭合）
 * @param {number} width 宽
 * @param {number} height 高
 * @returns {{mask: Uint8Array, area: number}} 栅格化结果
 */
function rasterizePolygon(pixelPoints, width, height) {
  const mask = new Uint8Array(width * height);
  if (pixelPoints.length < 3) {
    return { mask, area: 0 };
  }
  const edges = [];
  let minY = Infinity;
  let maxY = -Infinity;
  for (let index = 0; index < pixelPoints.length; index += 1) {
    const a = pixelPoints[index];
    const b = pixelPoints[(index + 1) % pixelPoints.length];
    if (!Number.isFinite(a[0]) || !Number.isFinite(a[1]) || !Number.isFinite(b[0]) || !Number.isFinite(b[1])) {
      return { mask, area: 0 };
    }
    if (a[1] === b[1]) continue; // 水平边不参与扫描线交点
    edges.push([a[0], a[1], b[0], b[1]]);
    minY = Math.min(minY, a[1], b[1]);
    maxY = Math.max(maxY, a[1], b[1]);
  }
  if (edges.length < 2) {
    return { mask, area: 0 };
  }
  const rowStart = Math.max(0, Math.floor(minY - 0.5));
  const rowEnd = Math.min(height - 1, Math.ceil(maxY - 0.5));
  const intersections = [];
  let area = 0;
  for (let y = rowStart; y <= rowEnd; y += 1) {
    const scanY = y + 0.5;
    intersections.length = 0;
    for (const [x1, y1, x2, y2] of edges) {
      if ((y1 <= scanY && y2 > scanY) || (y2 <= scanY && y1 > scanY)) {
        intersections.push(x1 + ((scanY - y1) * (x2 - x1)) / (y2 - y1));
      }
    }
    if (intersections.length < 2) continue;
    intersections.sort((a, b) => a - b);
    const rowOffset = y * width;
    for (let index = 0; index + 1 < intersections.length; index += 2) {
      // 像素中心 x+0.5 落在交点区间内则填充
      const from = Math.max(0, Math.ceil(intersections[index] - 0.5));
      const to = Math.min(width - 1, Math.ceil(intersections[index + 1] - 0.5) - 1);
      for (let x = from; x <= to; x += 1) {
        if (!mask[rowOffset + x]) {
          mask[rowOffset + x] = 1;
          area += 1;
        }
      }
    }
  }
  return { mask, area };
}

/**
 * 把页面归一化点列（[-0.5,0.5]，y 向上）按参考掩膜外接框映射回像素并计算 IoU/孔洞。
 *
 * 逆变换（与拼图描摹归一化互逆，本文件独立实现）：
 *   px = centerX + x * span，py = centerY - y * span；span = 外接框最长边。
 *
 * @param {Array<[number, number]>} points 归一化点列
 * @param {Uint8Array} referenceMask 参考掩膜（已填充孔洞）
 * @param {number} width 宽
 * @param {number} height 高
 * @returns {{iou: number, holes: number, polygonArea: number, referenceArea: number, intersection: number, union: number, bounds: object}} 校验结果
 */
function compareNormalizedPointsWithMask(points, referenceMask, width, height) {
  if (!Array.isArray(points) || points.length < 3) {
    throw new Error('点列不足 3 点，无法校验');
  }
  const bounds = maskBounds(referenceMask, width, height);
  if (bounds.count === 0) {
    throw new Error('参考掩膜没有前景像素');
  }
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  const span = Math.max(bounds.width, bounds.height, 1);
  const pixelPoints = points.map(([x, y]) => [centerX + Number(x) * span, centerY - Number(y) * span]);
  const { mask: polygonMask, area: polygonArea } = rasterizePolygon(pixelPoints, width, height);
  let intersection = 0;
  let union = 0;
  for (let index = 0; index < polygonMask.length; index += 1) {
    const a = polygonMask[index];
    const b = referenceMask[index] ? 1 : 0;
    if (a && b) intersection += 1;
    if (a || b) union += 1;
  }
  return {
    iou: union > 0 ? intersection / union : 0,
    holes: countMaskHoles(polygonMask, width, height),
    polygonArea,
    referenceArea: bounds.count,
    intersection,
    union,
    bounds,
  };
}

/**
 * 统计掩膜的连通分量数（8 邻接）与最大分量占比（fixture 前置条件自检用）。
 *
 * @param {Uint8Array} mask 前景掩膜
 * @param {number} width 宽
 * @param {number} height 高
 * @returns {{components: number, mainRatio: number}} 分量统计
 */
function countMaskComponents(mask, width, height) {
  const visited = new Uint8Array(mask.length);
  const stack = new Int32Array(mask.length);
  let components = 0;
  let total = 0;
  let largest = 0;
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;
    components += 1;
    let top = 0;
    stack[top] = start;
    top += 1;
    visited[start] = 1;
    let size = 0;
    while (top > 0) {
      top -= 1;
      const index = stack[top];
      size += 1;
      const x = index % width;
      const y = (index - x) / width;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const next = ny * width + nx;
          if (mask[next] && !visited[next]) {
            visited[next] = 1;
            stack[top] = next;
            top += 1;
          }
        }
      }
    }
    total += size;
    if (size > largest) largest = size;
  }
  return { components, mainRatio: total > 0 ? largest / total : 0 };
}

/* ============================ fixture 加载（缓存） ============================ */

/** fixture 缓存：name → 解码结果或错误 */
const fixtureCache = new Map();

/**
 * 加载并缓存一张 fixture PNG（解码 + 前景掩膜 + 孔洞填充）。
 *
 * @param {string} name fixture 名（不含 .png）
 * @returns {object} fixture 数据（ok=false 表示缺失/解码失败）
 */
function loadFixture(name) {
  if (fixtureCache.has(name)) {
    return fixtureCache.get(name);
  }
  const file = path.join(FIXTURE_DIR, `${name}.png`);
  let result;
  try {
    if (!existsSync(file)) {
      throw new Error(`fixture 不存在：${path.relative(ROOT, file)}`);
    }
    const base64 = readFileSync(file).toString('base64');
    const png = decodePng(readFileSync(file));
    const { mask, background, foregroundRatio } = buildForegroundMask(png);
    const { filled, holes } = fillMaskHoles(mask, png.width, png.height);
    const components = countMaskComponents(mask, png.width, png.height);
    result = {
      ok: true,
      name,
      file,
      base64,
      width: png.width,
      height: png.height,
      channels: png.channels,
      background,
      foregroundRatio,
      holesInRawMask: holes,
      components: components.components,
      mainComponentRatio: components.mainRatio,
      mask,
      filledMask: filled,
    };
  } catch (error) {
    result = { ok: false, name, file, error: error?.message ?? String(error) };
  }
  fixtureCache.set(name, result);
  return result;
}

/** 预加载全部 fixture（缺失时打印警告，用例内会逐条断言失败） */
function preloadFixtures() {
  const names = [
    'piglet-peppa', 'windmill', 'lighthouse', 'bicycle',
    'train', 'sailboat', 'helicopter', 'cactus', 'photo-like',
  ];
  for (const name of names) {
    const fixture = loadFixture(name);
    if (fixture.ok) {
      console.log(
        `[fixture] ${name}.png ${fixture.width}x${fixture.height} 前景占比 ${(fixture.foregroundRatio * 100).toFixed(1)}% 分量数=${fixture.components} 主分量占比=${(fixture.mainComponentRatio * 100).toFixed(1)}% 原始孔洞像素=${fixture.holesInRawMask}`,
      );
    } else {
      console.log(`[fixture] ${name}.png 不可用：${fixture.error}`);
    }
  }
}

/* ============================ 本地规则复算（L6-a） ============================ */

/** 单字中文别名的绘图语境前缀（旧规则；2026-11-01 前的 browser.js 语义，等价实现） */
const OLD_SINGLE_CHAR_PREFIX_PATTERN =
  /(?:(?:画|绘|描)|(?:画|绘|描|走|跑|来|生成|规划)(?:一个|一只|一匹|一条|一头|一群|一张|个|只|匹|条|头|群|张))$/;
/** 单字中文别名的形状后缀（旧规则） */
const OLD_SINGLE_CHAR_SUFFIX_PATTERN = /^(?:形|状|型|图|剪影|轮廓|字形)/;
/** 多字别名的地名后缀守卫（旧/新规则一致） */
const PLACE_SUFFIX_CHARS = new Set([
  '湾', '岛', '山', '江', '河', '湖', '路', '街', '村', '镇', '港', '洲', '巷', '桥', '站', '园', '城', '门', '场', '口', '滩', '岗', '塔', '楼',
]);

/** 文本归一化（小写 + 去首尾空白） */
function normalizeRuleText(text) {
  return String(text || '').toLowerCase().trim();
}

/** 是否纯 ASCII 别名 */
function isAsciiAlias(needle) {
  return /^[a-z0-9][a-z0-9 \-'&.]*$/.test(needle);
}

/** 是否 ASCII 单词字符 */
function isWordChar(ch) {
  return /[a-z0-9]/i.test(ch || '');
}

/** ASCII 别名词边界匹配 */
function asciiAliasHit(haystack, needle) {
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    const before = index > 0 ? haystack[index - 1] : '';
    const after = index + needle.length < haystack.length ? haystack[index + needle.length] : '';
    if (!isWordChar(before) && !isWordChar(after)) return true;
    index = haystack.indexOf(needle, index + 1);
  }
  return false;
}

/** 是否单字中文别名 */
function isSingleCjkAlias(needle) {
  return needle.length === 1 && /[\u4e00-\u9fff]/.test(needle);
}

/**
 * 旧规则：单字别名语境守卫（方案 2026-11-01 之前的语义，用于 L6-a 对比）。
 *
 * @param {string} haystack 归一化文本
 * @param {string} needle 别名
 * @returns {boolean} 是否命中
 */
function oldSingleCharInContext(haystack, needle) {
  for (let index = haystack.indexOf(needle); index >= 0; index = haystack.indexOf(needle, index + 1)) {
    const before = haystack.slice(0, index);
    const after = haystack.slice(index + needle.length);
    if (before === '' && after === '') return true;
    if (OLD_SINGLE_CHAR_PREFIX_PATTERN.test(before) || OLD_SINGLE_CHAR_SUFFIX_PATTERN.test(after)) return true;
  }
  return false;
}

/**
 * 新规则词边界：取「别名 + 右侧紧邻连续汉字」构成的串，必须等于别名或该素材已登记更长别名。
 * （方案 2026-11-01 §2；用于 L6-a 复算与 browser.js 结果交叉验证）
 *
 * @param {string} haystack 归一化文本
 * @param {string} needle 单字别名
 * @param {Set<string>} registeredAliases 同一素材已登记别名集合
 * @returns {boolean} 词边界是否通过
 */
function newWordBoundaryFits(haystack, needle, registeredAliases) {
  for (let index = haystack.indexOf(needle); index >= 0; index = haystack.indexOf(needle, index + 1)) {
    let end = index + needle.length;
    while (end < haystack.length && /[\u4e00-\u9fff]/.test(haystack[end])) end += 1;
    const run = haystack.slice(index, end);
    if (run === needle || registeredAliases.has(run)) return true;
  }
  return false;
}

/** 多字别名命中（地名后缀守卫） */
function multiCharAliasHit(haystack, needle) {
  for (let index = haystack.indexOf(needle); index >= 0; index = haystack.indexOf(needle, index + 1)) {
    const after = haystack[index + needle.length];
    if (after && PLACE_SUFFIX_CHARS.has(after)) continue;
    return true;
  }
  return false;
}

/**
 * 取素材的全部别名（归一化；与 browser.js 同口径）。
 *
 * @param {object} asset manifest 素材
 * @returns {string[]} 别名列表
 */
function assetAliases(asset) {
  return [
    ...(asset.names?.zh || []),
    ...(asset.names?.en || []),
    ...(asset.aliases || []),
  ].map(normalizeRuleText).filter(Boolean);
}

/**
 * 旧规则匹配（无词边界）：等价于 2026-11-01 前 browser.js 的 matchReferenceAssets。
 *
 * @param {string} text 用户文本
 * @param {Array<object>} assets manifest 素材（已过滤 approved）
 * @returns {{status: 'ok'|'miss'|'ambiguous', matches: Array<{assetId: string, name: string, matchedAlias: string}>, objects?: string[]}} 匹配结果
 */
function matchAssetsOld(text, assets) {
  const haystack = normalizeRuleText(text);
  if (!haystack) {
    return { status: 'miss', matches: [] };
  }
  const hits = [];
  for (const asset of assets) {
    let bestAlias = null;
    for (const needle of assetAliases(asset)) {
      if (!needle) continue;
      let hit;
      if (isAsciiAlias(needle)) {
        hit = asciiAliasHit(haystack, needle);
      } else if (isSingleCjkAlias(needle)) {
        hit = oldSingleCharInContext(haystack, needle);
      } else {
        hit = multiCharAliasHit(haystack, needle);
      }
      if (hit && (!bestAlias || needle.length > bestAlias.length)) {
        bestAlias = needle;
      }
    }
    if (bestAlias) {
      hits.push({ assetId: asset.id, name: asset.names?.zh?.[0] ?? asset.id, matchedAlias: bestAlias });
    }
  }
  if (hits.length === 0) {
    return { status: 'miss', matches: [] };
  }
  if (hits.length > 1) {
    const longest = hits.reduce((max, hit) => Math.max(max, hit.matchedAlias.length), 0);
    const longestAlias = hits.find((hit) => hit.matchedAlias.length === longest).matchedAlias;
    const nested = hits.filter(
      (hit) => hit.matchedAlias.length === longest || hit.matchedAlias.includes(longestAlias),
    );
    const survivors = nested.length > 0 ? nested : hits;
    const objects = new Set(survivors.map((hit) => hit.name));
    if (objects.size > 1) {
      return { status: 'ambiguous', matches: [], objects: [...objects] };
    }
    return { status: 'ok', matches: survivors };
  }
  return { status: 'ok', matches: hits };
}

/**
 * 新规则匹配（单字别名必须占满连续汉字词 + 原有语境守卫；自实现，用于交叉验证 browser.js）。
 *
 * @param {string} text 用户文本
 * @param {Array<object>} assets manifest 素材（已过滤 approved）
 * @returns {{status: 'ok'|'miss'|'ambiguous', matches: Array<object>, objects?: string[]}} 匹配结果
 */
function matchAssetsNew(text, assets) {
  const haystack = normalizeRuleText(text);
  if (!haystack) {
    return { status: 'miss', matches: [] };
  }
  const hits = [];
  for (const asset of assets) {
    const registered = new Set(assetAliases(asset));
    let bestAlias = null;
    for (const needle of assetAliases(asset)) {
      if (!needle) continue;
      let hit;
      if (isAsciiAlias(needle)) {
        hit = asciiAliasHit(haystack, needle);
      } else if (isSingleCjkAlias(needle)) {
        hit = oldSingleCharInContext(haystack, needle) && newWordBoundaryFits(haystack, needle, registered);
      } else {
        hit = multiCharAliasHit(haystack, needle);
      }
      if (hit && (!bestAlias || needle.length > bestAlias.length)) {
        bestAlias = needle;
      }
    }
    if (bestAlias) {
      hits.push({ assetId: asset.id, name: asset.names?.zh?.[0] ?? asset.id, matchedAlias: bestAlias });
    }
  }
  if (hits.length === 0) {
    return { status: 'miss', matches: [] };
  }
  if (hits.length > 1) {
    const longest = hits.reduce((max, hit) => Math.max(max, hit.matchedAlias.length), 0);
    const longestAlias = hits.find((hit) => hit.matchedAlias.length === longest).matchedAlias;
    const nested = hits.filter(
      (hit) => hit.matchedAlias.length === longest || hit.matchedAlias.includes(longestAlias),
    );
    const survivors = nested.length > 0 ? nested : hits;
    const objects = new Set(survivors.map((hit) => hit.name));
    if (objects.size > 1) {
      return { status: 'ambiguous', matches: [], objects: [...objects] };
    }
    return { status: 'ok', matches: survivors };
  }
  return { status: 'ok', matches: hits };
}

/** 参考素材（已过滤 approved）与浏览器端新规则匹配函数（懒加载） */
let manifestAssets = null;
let browserMatcher = null;

/** 读取 manifest 中 approved 素材（缓存） */
function loadManifestAssets() {
  if (!manifestAssets) {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
    manifestAssets = (manifest.assets || []).filter((asset) => asset.review?.status === 'approved');
  }
  return manifestAssets;
}

/** 懒加载页面同源的参考匹配函数（用于 L6-a 交叉验证；失败返回 null） */
async function loadBrowserMatcher() {
  if (browserMatcher !== null) {
    return browserMatcher;
  }
  try {
    const module = await import('../web/src/reference/browser.js');
    browserMatcher = typeof module.matchReferenceAssets === 'function' ? module.matchReferenceAssets : false;
  } catch (error) {
    console.log(`[warn] 无法加载 web/src/reference/browser.js 的匹配函数：${error?.message ?? error}`);
    browserMatcher = false;
  }
  return browserMatcher;
}

/**
 * 独立复算一条文本的本地命中（旧规则 / 新规则 / 页面同源新规则）。
 *
 * @param {string} text 用户文本
 * @returns {Promise<object>} 复算结果
 */
async function computeLocalRule(text) {
  const assets = loadManifestAssets();
  const oldResult = matchAssetsOld(text, assets);
  const newResult = matchAssetsNew(text, assets);
  const matcher = await loadBrowserMatcher();
  let pageResult = null;
  if (matcher) {
    pageResult = matcher(text, assets);
  }
  const toSummary = (result) => ({
    status: result?.status ?? null,
    matches: (result?.matches ?? []).map((item) => ({
      assetId: item.assetId ?? item.asset?.id ?? null,
      name: item.name ?? item.asset?.names?.zh?.[0] ?? null,
      matchedAlias: item.matchedAlias ?? null,
    })),
    objects: result?.objects ?? null,
  });
  const oldHit = oldResult.status === 'ok' && oldResult.matches.length > 0;
  const newHit = newResult.status === 'ok' && newResult.matches.length > 0;
  const pageHit = pageResult ? pageResult.status === 'ok' && (pageResult.matches?.length ?? 0) > 0 : null;
  return {
    text,
    oldHit,
    newHit,
    pageHit,
    consistent: pageHit === null ? null : pageHit === newHit,
    old: toSummary(oldResult),
    new: toSummary(newResult),
    page: pageResult ? toSummary(pageResult) : null,
  };
}

/* ============================ 用例执行 ============================ */

/**
 * 解析用例筛选参数（支持逗号、前缀 L4、区间 L1..L3）。
 *
 * @param {string|null} filter 筛选表达式
 * @returns {Set<string>} 筛选 token 集合
 */
function parseFilter(filter) {
  const tokens = new Set();
  if (!filter) return tokens;
  for (const part of filter.split(',')) {
    const trimmed = part.trim();
    if (trimmed) tokens.add(trimmed);
  }
  return tokens;
}

/**
 * 根据筛选 token 选择用例（支持前缀与区间）。
 *
 * @param {Set<string>} tokens 筛选 token
 * @returns {Array<object>} 选中用例
 */
function selectCases(tokens) {
  if (tokens.size === 0) {
    return CASES.slice();
  }
  const wanted = new Set();
  const prefixes = [];
  for (const token of tokens) {
    const range = token.match(/^(.+?)\.\.(.+)$/);
    if (range) {
      const startMatch = range[1].match(/^(.*?)(\d+)$/);
      const endMatch = range[2].match(/^(.*?)(\d+)$/);
      if (startMatch && endMatch && startMatch[1] === endMatch[1]) {
        const base = startMatch[1];
        for (let index = Number(startMatch[2]); index <= Number(endMatch[2]); index += 1) {
          wanted.add(`${base}${index}`);
        }
        continue;
      }
    }
    wanted.add(token);
    prefixes.push(token);
  }
  return CASES.filter((caseDef) => {
    if (wanted.has(caseDef.id)) return true;
    return prefixes.some((prefix) => caseDef.id.startsWith(`${prefix}-`));
  });
}

/**
 * 执行一个用例（每例独立：清空会话存储 → 刷新 → 操作 → 断言）。
 *
 * @param {Cdp} cdp CDP 客户端
 * @param {object} caseDef 用例定义
 * @returns {Promise<object>} 用例结果
 */
async function runCase(cdp, caseDef) {
  console.log(`\n=== ${caseDef.id} ${caseDef.title} ===`);
  console.log(`  input: ${caseDef.input ? JSON.stringify(caseDef.input) : '（空文本/图片轮）'}`);
  const started = Date.now();
  const caseChecks = [];
  const caseStarted = checks.length;
  const record = {
    id: caseDef.id,
    category: caseDef.category,
    title: caseDef.title,
    input: caseDef.input,
    expected: caseDef.expected,
    startedAt: new Date().toISOString(),
    status: 'running',
    durationMs: 0,
    checks: [],
    actual: {},
    snapshots: [],
    screenshots: [],
  };

  /** 取本用例新增的断言（全局 checks 切片） */
  function takeCaseChecks() {
    return checks.slice(caseStarted);
  }

  const ctx = {
    /** 发送真实用户输入（文本可为空——图片轮） */
    async send(text) {
      const result = await cdp.evaluate(EXPR.send(text));
      if (!result?.ok) {
        throw new Error(`发送失败：${JSON.stringify(result)}`);
      }
      record.snapshots.push({ step: 'send', text, at: Date.now() });
    },
    /** 点击发送/停止按钮（空文本图片轮用） */
    async clickSend() {
      const result = await cdp.evaluate(EXPR.clickSend);
      record.snapshots.push({ step: 'clickSend', at: Date.now() });
      return result;
    },
    /** 等待本轮结束（发送按钮回到"发送"且没有实时推理气泡） */
    async waitTurn(timeoutMs = TURN_TIMEOUT) {
      const sent = Date.now();
      const done = await cdp
        .waitFor(
          `(() => {
            const button = document.getElementById('agent-send');
            if (!button) return false;
            const busy = button.textContent.trim() === '停止';
            const pending = Boolean(document.querySelector('.agent-msg-agent.is-pending'));
            return !busy && !pending && Date.now() - ${sent} > 400;
          })()`,
          timeoutMs,
          '一轮完成',
          400,
        )
        .catch(() => false);
      if (done) {
        await sleep(500); // 等 UI 重绘 / 存储落盘完成
      }
      return done;
    },
    /** 等待引导选项出现 */
    async waitGuide(timeoutMs = 60000) {
      return cdp.waitFor(
        `document.querySelectorAll('.agent-options.is-live .agent-chip').length > 0`,
        timeoutMs,
        '引导选项',
      );
    },
    /** 等待参考候选卡出现 */
    async waitRefCards(timeoutMs = 180000) {
      return cdp.waitFor(
        `document.querySelectorAll('.agent-reference-choice.is-live .agent-ref-card').length > 0`,
        timeoutMs,
        '参考候选卡',
      );
    },
    /** 状态快照（存储 + DOM + 地图） */
    async snapshot() {
      return cdp.evaluate(EXPR.snapshot);
    },
    /** 页面条件轮询等待（用例内自定义等待） */
    async waitFor(expression, timeoutMs, label) {
      return cdp.waitFor(expression, timeoutMs, label);
    },
    /** 点击引导选项（按文本包含匹配） */
    async clickGuide(label, index = 0) {
      return cdp.evaluate(EXPR.clickGuide(label, index));
    },
    /** 点击参考候选卡 */
    async clickRefCard(index) {
      return cdp.evaluate(EXPR.clickRefCard(index));
    },
    /** 刷新页面并等就绪 */
    async reload() {
      await cdp.send('Page.reload');
      const ready = await cdp.waitFor(EXPR.ready, 60000, '刷新后应用就绪');
      await sleep(800);
      return ready;
    },
    /**
     * 清空会话存储 + 刷新（用例隔离）。注意：store 在 pagehide 会 flush 旧数据，
     * 所以必须"先离开页面 → 清 origin 存储 → 再进页面"，否则旧会话会被写回（早期实测坑）。
     */
    async reset() {
      await cdp.send('Page.navigate', { url: 'about:blank' });
      await sleep(600);
      await cdp.send('Storage.clearDataForOrigin', {
        origin: new URL(APP_URL).origin,
        storageTypes: 'local_storage',
      });
      await cdp.send('Page.navigate', { url: APP_URL });
      const ready = await cdp.waitFor(EXPR.ready, 60000, '用例初始化');
      await sleep(800);
      return ready;
    },
    /** 通过真实 file input 的 change 事件上传图片（等价用户点"图片"选择文件） */
    async uploadImageBase64(base64, name = 'image.png') {
      await cdp.evaluate(`(async () => {
        const bin = atob(${JSON.stringify(base64)});
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
        const file = new File([bytes], ${JSON.stringify(name)}, { type: 'image/png' });
        const input = document.getElementById('agent-image-input');
        const transfer = new DataTransfer();
        transfer.items.add(file);
        input.files = transfer.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
      return cdp.waitFor(
        `!document.getElementById('agent-attach').hasAttribute('hidden')`,
        30000,
        '图片待发送预览',
      );
    },
    /** 读取本轮真实链路日志（页面日志 API） */
    async logs(traceId) {
      if (!traceId) {
        return { unavailable: true, reason: 'no-trace-id' };
      }
      return cdp.evaluate(EXPR.logs(traceId));
    },
    /** 独立复算本地命中（旧规则/新规则/页面同源规则） */
    async localRule(text) {
      return computeLocalRule(text);
    },
    /** fixture 的 base64（上传用） */
    fixtureBase64(name) {
      const fixture = loadFixture(name);
      if (!fixture.ok) throw new Error(fixture.error);
      return fixture.base64;
    },
    /** fixture 元信息（尺寸/前景占比/原始孔洞像素数） */
    fixtureInfo(name) {
      const fixture = loadFixture(name);
      if (!fixture.ok) throw new Error(fixture.error);
      return {
        name: fixture.name,
        file: path.relative(ROOT, fixture.file),
        width: fixture.width,
        height: fixture.height,
        channels: fixture.channels,
        background: fixture.background,
        foregroundRatio: fixture.foregroundRatio,
        holesInRawMask: fixture.holesInRawMask,
        components: fixture.components,
        mainComponentRatio: fixture.mainComponentRatio,
      };
    },
    /** 页面点列 vs fixture 填充后外轮廓的独立 IoU/孔洞校验 */
    compareOutlineWithFixture(name, points) {
      const fixture = loadFixture(name);
      if (!fixture.ok) throw new Error(fixture.error);
      return compareNormalizedPointsWithMask(points, fixture.filledMask, fixture.width, fixture.height);
    },
    /** 记录一条断言 */
    check(label, condition, detail) {
      check(label, condition, detail);
    },
    /** 保存快照到记录 */
    capture(step, snap) {
      record.snapshots.push({ step, at: Date.now(), snap });
    },
    /** 设置用例实际结果 */
    setActual(actual) {
      record.actual = { ...record.actual, ...actual };
    },
    /** 读取交付一致性（绿线/橙线/图形快照三者互相一致，失败时无残留线） */
    async delivery(snap = null) {
      const state = snap ?? (await this.snapshot());
      const shapes = state.store?.session?.shapes ?? [];
      const strokes = state.dom.routeStrokes ?? [];
      const green = strokes.includes('#16a34a');
      const orange = strokes.includes('#f59e0b');
      const delivered = shapes.length > 0;
      const referenceShape = shapes.some((item) => item.reference);
      const consistent = delivered
        ? (green || orange) && green !== orange && referenceShape === orange
        : !green && !orange;
      return { snap: state, shapes, strokes, green, orange, delivered, consistent };
    },
    /** 截图（<caseId>-<slug>.png） */
    async shot(slug) {
      const name = `${caseDef.id.toLowerCase()}-${slug}.png`.replace(/[<>:"/\\|?*]/g, '-');
      await cdp.screenshot(name);
      record.screenshots.push(name);
    },
    /** 等待 */
    sleep,
  };

  try {
    const resetOk = await ctx.reset();
    caseChecks.push({ label: '用例初始状态就绪（会话已清空并刷新）', ok: resetOk, detail: resetOk ? '' : '应用未就绪' });
    if (!resetOk) {
      throw new Error('页面刷新后未就绪');
    }
    const initial = await ctx.snapshot();
    caseChecks.push({
      label: '初始会话为空（独立隔离）',
      ok: !initial.store?.session || initial.store.session.messageCount <= 1,
      detail: JSON.stringify(initial.store?.session?.messageCount),
    });
    await caseDef.run.call(caseDef, ctx);
    record.status = caseChecks.every((item) => item.ok) && takeCaseChecks().every((item) => item.ok) ? 'pass' : 'fail';
  } catch (error) {
    record.error = error?.message ?? String(error);
    record.status = 'error';
    console.log(`  [error] ${record.error}`);
    try {
      await ctx.shot('error');
    } catch {
      // 截图失败忽略
    }
  } finally {
    record.durationMs = Date.now() - started;
    record.checks = [...caseChecks, ...takeCaseChecks()];
    record.passed = record.checks.filter((item) => item.ok).length;
    record.failed = record.checks.filter((item) => !item.ok).length;
    record.finishedAt = new Date().toISOString();
    console.log(`  [case] ${record.id} → ${record.status}（${record.passed}/${record.checks.length}，${(record.durationMs / 1000).toFixed(1)}s）`);
  }
  return record;
}

/* ============================ §1 计数（--counts） ============================ */

/**
 * 读取结果文件中的运行窗口（startedAt/finishedAt → ms）。
 *
 * @param {object} result 结果对象
 * @param {string} label 窗口标签
 * @returns {object|null} { label, startMs, endMs }
 */
function windowOfResult(result, label) {
  const startMs = Date.parse(result?.startedAt ?? '');
  const endMs = Date.parse(result?.finishedAt ?? '');
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return null;
  }
  return { label, startMs, endMs };
}

/**
 * 判断时间戳是否落在任一窗口内（前后各留少量余量，覆盖日志 2s 攒批与收尾）。
 *
 * @param {number} ts 时间戳
 * @param {Array<object>} windows 窗口
 * @returns {boolean} 是否命中
 */
function inWindows(ts, windows) {
  for (const window of windows) {
    if (ts >= window.startMs - 5000 && ts <= window.endMs + 20000) return true;
  }
  return false;
}

/**
 * 扫描 web/logs/*.jsonl，统计「本地 miss 之后在线返回候选的请求数 / 本地 miss 请求数」。
 *
 * 统计口径（写进报告）：
 * - 一轮 = 一个 traceId；只统计窗口内的记录；
 * - 本地 miss 请求 = 日志出现 agent.reference.miss 且 status 为 miss/offline 的轮次，
 *   以及在线返回候选（reference.candidates origin/choiceOrigin=online）的轮次——
 *   后者本地必然未给出可用候选（在线检索只发生在本地 miss/转换失败之后）；
 * - 在线返回候选 = 该轮出现 reference.candidates 且 origin/choiceOrigin=online。
 *
 * @param {Array<object>} windows 运行窗口
 * @returns {Promise<object>} 统计结果
 */
async function computeOnlineCounts(windows) {
  const files = existsSync(LOG_DIR)
    ? readdirSync(LOG_DIR).filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    : [];
  /** traceId → 聚合信息 */
  const traceMap = new Map();
  let scannedRecords = 0;
  let matchedRecords = 0;
  for (const file of files) {
    let text;
    try {
      text = readFileSync(path.join(LOG_DIR, file), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      scannedRecords += 1;
      if (!Number.isFinite(record?.ts) || !inWindows(record.ts, windows)) continue;
      matchedRecords += 1;
      const traceId = record.traceId;
      if (!traceId) continue;
      let entry = traceMap.get(traceId);
      if (!entry) {
        entry = {
          traceId,
          text: null,
          hasImage: false,
          turnName: null,
          missStatuses: [],
          onlineCandidates: 0,
          localCandidates: 0,
          imageTraceUsed: 0,
          targets: [],
        };
        traceMap.set(traceId, entry);
      }
      const data = record.data;
      switch (record.event) {
        case 'trace.start':
          entry.turnName = data?.name ?? null;
          if (typeof data?.text === 'string') entry.text = data.text;
          entry.hasImage = Boolean(data?.hasImage);
          break;
        case 'agent.reference.miss':
          entry.missStatuses.push(data?.status ?? null);
          break;
        case 'reference.candidates': {
          const origin = data?.choiceOrigin ?? data?.origin ?? null;
          if (origin === 'online') {
            entry.onlineCandidates += 1;
          } else if (origin === 'local') {
            entry.localCandidates += 1;
          }
          break;
        }
        case 'agent.imageTrace.used':
          entry.imageTraceUsed += 1;
          break;
        case 'target.accepted':
        case 'target.rejected':
          entry.targets.push({ event: record.event, source: data?.checks?.source ?? data?.source ?? null });
          break;
        default:
          break;
      }
    }
  }
  // 输入文本 → 用例 id（跨两套用例；同一文本可能有多个 id，如 C1/L1）
  const textToIds = new Map();
  for (const caseDef of [...CASES.filter((item) => !item.summaryOnly), ...REGRESSION_CASES]) {
    if (!caseDef.input) continue;
    if (!textToIds.has(caseDef.input)) textToIds.set(caseDef.input, []);
    textToIds.get(caseDef.input).push(caseDef.id);
  }
  const attempts = [];
  let missRequests = 0;
  let onlineAfterMiss = 0;
  const statusCounter = {};
  for (const entry of traceMap.values()) {
    const isLocalMiss = entry.missStatuses.some((status) => status === 'miss' || status === 'offline');
    const isAttempt = isLocalMiss || entry.onlineCandidates > 0;
    if (!isAttempt) continue;
    attempts.push({
      traceId: entry.traceId,
      text: entry.text,
      caseIds: entry.text ? (textToIds.get(entry.text) ?? []) : [],
      hasImage: entry.hasImage,
      missStatuses: entry.missStatuses,
      onlineCandidates: entry.onlineCandidates,
      imageTraceUsed: entry.imageTraceUsed,
      targets: entry.targets,
    });
    for (const status of entry.missStatuses) {
      const key = status ?? 'null';
      statusCounter[key] = (statusCounter[key] ?? 0) + 1;
    }
    missRequests += 1;
    if (entry.onlineCandidates > 0) onlineAfterMiss += 1;
  }
  return {
    windows: windows.map((window) => ({
      label: window.label,
      start: new Date(window.startMs).toISOString(),
      end: new Date(window.endMs).toISOString(),
    })),
    logFiles: files,
    scannedRecords,
    matchedRecords,
    traces: traceMap.size,
    localMissRequests: missRequests,
    onlineAfterLocalMiss: onlineAfterMiss,
    ratio: missRequests > 0 ? Number((onlineAfterMiss / missRequests).toFixed(4)) : null,
    missStatusDistribution: statusCounter,
    attempts,
  };
}

/**
 * 计算 L6-a：旧规则命中 / 新规则不命中的请求数（覆盖本套 + 30 例回归全部 input）。
 *
 * @returns {Promise<object>} 统计结果
 */
async function computeRuleCounts() {
  const assets = loadManifestAssets();
  const matcher = await loadBrowserMatcher();
  const rows = [];
  const add = (suite, caseDef) => {
    if (typeof caseDef.input !== 'string' || !caseDef.input.trim()) {
      rows.push({ suite, id: caseDef.id, input: caseDef.input ?? '', skip: true, oldHit: false, newHit: false });
      return;
    }
    const oldResult = matchAssetsOld(caseDef.input, assets);
    const independentResult = matchAssetsNew(caseDef.input, assets);
    const newResult = matcher ? matcher(caseDef.input, assets) : independentResult;
    const oldHit = oldResult.status === 'ok' && oldResult.matches.length > 0;
    const newHit = newResult?.status === 'ok' && (newResult.matches?.length ?? 0) > 0;
    const independentHit = independentResult.status === 'ok' && independentResult.matches.length > 0;
    rows.push({
      suite,
      id: caseDef.id,
      input: caseDef.input,
      oldHit,
      newHit,
      independentHit,
      consistent: independentHit === newHit,
      oldStatus: oldResult.status,
      newStatus: newResult?.status ?? null,
      oldMatches: oldResult.matches.map((item) => `${item.assetId}:${item.matchedAlias}`),
      newMatches: (newResult?.matches ?? []).map((item) => {
        if (item.assetId) return `${item.assetId}:${item.matchedAlias}`;
        return `${item.asset?.id ?? '?'}:${item.matchedAlias}`;
      }),
      diff: oldHit && newHit === false,
    });
  };
  for (const caseDef of CASES.filter((item) => !item.summaryOnly)) add('long-tail', caseDef);
  for (const caseDef of REGRESSION_CASES) add('30-regression', caseDef);
  const diffRows = rows.filter((row) => row.diff);
  const mismatchRows = rows.filter((row) => !row.skip && row.consistent === false);
  return {
    rule: {
      old: '2026-11-01 前的单字别名规则：仅绘图语境守卫（单独输入 / 绘图动词+量词前缀 / 形状后缀），无词边界',
      new: '方案 §2：单字别名必须占满连续汉字词（串=别名或该素材已登记更长别名）+ 原有语境守卫（合取）',
      matcher: matcher ? 'web/src/reference/browser.js#matchReferenceAssets' : '脚本内等价实现',
    },
    total: rows.length,
    skipped: rows.filter((row) => row.skip).length,
    oldHitCount: rows.filter((row) => row.oldHit).length,
    newHitCount: rows.filter((row) => row.newHit).length,
    mismatchCount: mismatchRows.length,
    mismatchRows,
    diffRequestCount: diffRows.length,
    diffUniqueInputCount: new Set(diffRows.map((row) => row.input)).size,
    diffIds: diffRows.map((row) => row.id),
    diffRows,
    rows,
  };
}

/**
 * `--counts` 模式：两次跑完后统计 §1 两个计数，写 result-counts.json 并回写 result.json 的 L6 记录。
 *
 * @returns {Promise<void>}
 */
async function runCountsMode() {
  // 结果文件解析顺序：--out 指定名 → result-long-tail.json → result.json（兼容不同跑法）
  const candidateNames = [...new Set([RESULT_NAME, 'result-long-tail.json', 'result.json'])];
  const resultName = candidateNames.find((name) => existsSync(path.join(ARTIFACT_DIR, name)));
  if (!resultName) {
    throw new Error(
      `找不到长尾用例结果（尝试过 ${candidateNames.join(' / ')}）：先跑 node tools/e2e-long-tail.mjs --out result-long-tail.json`,
    );
  }
  const resultPath = path.join(ARTIFACT_DIR, resultName);
  console.log(`[counts] 读取长尾用例结果：${path.relative(ROOT, resultPath)}`);
  const result = JSON.parse(readFileSync(resultPath, 'utf8'));
  const windows = [];
  const longTailWindow = windowOfResult(result, 'long-tail');
  if (longTailWindow) windows.push(longTailWindow);
  const regressionPath = path.join(REGRESSION_ARTIFACT_DIR, REGRESSION_RESULT_NAME);
  let regressionFound = false;
  if (existsSync(regressionPath)) {
    const regression = JSON.parse(readFileSync(regressionPath, 'utf8'));
    const window = windowOfResult(regression, '30-regression');
    if (window) {
      windows.push(window);
      regressionFound = true;
    }
  }
  if (!regressionFound) {
    console.log(`[warn] 未找到 30 例回归结果：${path.relative(ROOT, regressionPath)}（L6-b 只统计长尾窗口）`);
  }
  console.log(`[counts] 统计窗口：${windows.map((window) => `${window.label} ${new Date(window.startMs).toISOString()} ~ ${new Date(window.endMs).toISOString()}`).join('；')}`);
  const rules = await computeRuleCounts();
  const online = await computeOnlineCounts(windows);
  const counts = {
    generatedAt: new Date().toISOString(),
    ruleCounts: rules,
    onlineCounts: online,
  };
  await mkdir(ARTIFACT_DIR, { recursive: true });
  await writeFile(path.join(ARTIFACT_DIR, 'result-counts.json'), JSON.stringify(counts, null, 2), 'utf8');

  // 回写 result.json：更新 counts + L6 统计项记录
  const checksL6 = [
    {
      label: 'a) 旧规则会命中、新规则不命中的请求数已统计并列出用例 id',
      ok: Number.isInteger(rules.diffRequestCount) && rules.diffRequestCount > 0,
      detail: JSON.stringify({ count: rules.diffRequestCount, ids: rules.diffIds }),
    },
    {
      label: 'a) 新规则复算（脚本独立实现）与页面同源匹配函数全输入一致',
      ok: rules.mismatchCount === 0,
      detail: JSON.stringify(rules.mismatchRows.map((row) => ({ id: row.id, newHit: row.newHit, independentHit: row.independentHit }))),
    },
    {
      label: 'b) 本地 miss 后在线返回候选的请求数 / 本地 miss 请求数已统计',
      ok: Number.isInteger(online.localMissRequests) && Number.isInteger(online.onlineAfterLocalMiss),
      detail: JSON.stringify({ numerator: online.onlineAfterLocalMiss, denominator: online.localMissRequests }),
    },
    {
      label: 'b) 统计窗口覆盖 30 例回归（真实日志）',
      ok: regressionFound,
      detail: regressionFound ? '' : `缺少 ${path.relative(ROOT, regressionPath)}`,
    },
    {
      label: 'b) 本地 miss 请求数与在线候选请求数来自真实页面日志（trace 级聚合）',
      ok: online.traces > 0 && online.matchedRecords > 0,
      detail: JSON.stringify({ traces: online.traces, matchedRecords: online.matchedRecords }),
    },
  ];
  for (const item of checksL6) {
    console.log(`[L6] [${item.ok ? 'PASS' : 'FAIL'}] ${item.label}${item.ok ? '' : ` → ${item.detail}`}`);
  }
  const l6Record = {
    id: 'L6',
    category: 'C 计数',
    title: '§1 两个计数（整轮结束后统计，无浏览器操作）',
    input: '（统计项：本套用例 + 30 例回归全部请求）',
    expected: 'a) 旧规则会命中、新规则不命中的请求数（列出用例 id）；b) 本地 miss 之后在线返回候选的请求数 / 本地 miss 请求数',
    startedAt: counts.generatedAt,
    finishedAt: counts.generatedAt,
    status: checksL6.every((item) => item.ok) ? 'pass' : 'fail',
    durationMs: 0,
    checks: checksL6,
    passed: checksL6.filter((item) => item.ok).length,
    failed: checksL6.filter((item) => !item.ok).length,
    actual: {
      ruleCounts: {
        total: rules.total,
        oldHitCount: rules.oldHitCount,
        newHitCount: rules.newHitCount,
        diffRequestCount: rules.diffRequestCount,
        diffUniqueInputCount: rules.diffUniqueInputCount,
        diffIds: rules.diffIds,
      },
      onlineCounts: {
        localMissRequests: online.localMissRequests,
        onlineAfterLocalMiss: online.onlineAfterLocalMiss,
        ratio: online.ratio,
        missStatusDistribution: online.missStatusDistribution,
        windows: online.windows,
      },
    },
    snapshots: [],
    screenshots: [],
  };
  const casesWithoutL6 = (result.cases || []).filter((item) => item.id !== 'L6');
  casesWithoutL6.push(l6Record);
  const patched = {
    ...result,
    cases: casesWithoutL6,
    counts,
    finishedAt: result.finishedAt ?? counts.generatedAt,
  };
  patched.total = patched.cases.length;
  patched.passed = patched.cases.filter((item) => item.status === 'pass').length;
  patched.failed = patched.cases.filter((item) => item.status !== 'pass').length;
  patched.totalChecks = patched.cases.reduce((sum, item) => sum + (item.checks?.length ?? 0), 0);
  patched.passedChecks = patched.cases.reduce((sum, item) => sum + (item.passed ?? 0), 0);
  await writeFile(resultPath, JSON.stringify(patched, null, 2), 'utf8');
  console.log(`\n[counts] a) 旧规则命中/新规则不命中：${rules.diffRequestCount} 个请求（唯一输入 ${rules.diffUniqueInputCount} 条；${rules.diffIds.join('、')}）`);
  console.log(`[counts] b) 本地 miss 后在线返回候选：${online.onlineAfterLocalMiss} / ${online.localMissRequests}（${online.ratio === null ? 'n/a' : `${(online.ratio * 100).toFixed(1)}%`}）`);
  console.log(`[counts] 结果：${path.relative(ROOT, path.join(ARTIFACT_DIR, 'result-counts.json'))}；已回写 ${path.relative(ROOT, resultPath)}`);
  process.exitCode = l6Record.status === 'pass' ? 0 : 1;
}

/* ============================ 主流程 ============================ */

/**
 * 确保链路验收素材存在（test/fixtures/trace-images/ 不入库，可幂等重新生成）。
 * 缺失时自动调用 tools/make-trace-fixtures.mjs，避免 clone 仓库后直接跑 E2E 失败。
 */
function ensureTraceFixtures() {
  const required = [
    'piglet-peppa.png',
    'windmill.png',
    'lighthouse.png',
    'bicycle.png',
    'train.png',
    'sailboat.png',
    'helicopter.png',
    'cactus.png',
    'photo-like.png',
  ];
  const missing = required.filter((name) => !existsSync(path.join(FIXTURE_DIR, name)));
  if (missing.length === 0) {
    return;
  }
  console.log(`[fixtures] 缺少 ${missing.length} 个链路验收素材，正在幂等重新生成…`);
  execFileSync(process.execPath, [path.join(ROOT, 'tools', 'make-trace-fixtures.mjs')], {
    cwd: ROOT,
    stdio: 'inherit',
  });
}

/**
 * 主流程。
 * @returns {Promise<void>}
 */
async function main() {
  if (COUNTS_MODE) {
    await runCountsMode();
    return;
  }
  if (LIST_ONLY) {
    for (const item of CASES) {
      console.log(`${item.id}\t${item.category}\t${item.title}\t${item.input || '（图片/空文本）'}`);
    }
    return;
  }
  const filterTokens = parseFilter(CASE_FILTER);
  const selected = selectCases(filterTokens).filter((item) => !item.summaryOnly);
  if (selected.length === 0) {
    console.error(`[fatal] 用例筛选结果为空：${CASE_FILTER}`);
    process.exit(1);
  }
  ensureTraceFixtures();
  preloadFixtures();
  await loadBrowserMatcher();

  const browserPath = resolveBrowser(argOf('browser'));
  const port = await findFreePort(Number(argOf('port', '9355')));
  /** profile 目录放项目 .tmp/ 下（方案要求；不要用 os.tmpdir()） */
  const profileDir = path.join(ROOT, '.tmp', `e2e-long-tail-${Date.now()}`);
  console.log(`[env] browser=${browserPath}`);
  console.log(`[env] devtoolsPort=${port} profile=${profileDir}`);
  console.log(`[env] app=${APP_URL}`);
  console.log(`[env] cases=${selected.map((item) => item.id).join(',')}（${selected.length} 例）`);

  let launched = null;
  let cdp = null;
  const result = {
    title: '长尾图形轮廓来源与贴路上限 · 浏览器真实链路 E2E',
    startedAt: new Date().toISOString(),
    appUrl: APP_URL,
    browser: browserPath,
    node: process.version,
    gitHead: (() => {
      try {
        return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
      } catch {
        return null;
      }
    })(),
    cases: [],
  };
  try {
    // 启动段统一走 tools/lib/cdp-driver.mjs 的 launchBrowser
    launched = await launchBrowser({
      browserPath,
      port,
      userDataDir: profileDir,
      windowSize: VIEW,
      openPage: true,
    });
    result.browserVersion = launched.version.Browser ?? null;
    console.log(`[env] ${launched.version.Browser}`);
    // 超时默认值沿用本驱动旧实现（180s）
    cdp = new Cdp(launched.wsUrl, { artifactDir: ARTIFACT_DIR, timeoutMs: 180000 });
    await cdp.open();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');

    await cdp.send('Page.navigate', { url: APP_URL });
    check('浏览器启动并渲染对话面板', await cdp.waitFor(EXPR.ready, 60000, '应用启动'));

    for (const caseDef of selected) {
      const record = await runCase(cdp, caseDef);
      result.cases.push(record);
      // 每例结束即落盘，长跑中断也不丢已完成结果
      await mkdir(ARTIFACT_DIR, { recursive: true });
      await writeFile(
        path.join(ARTIFACT_DIR, RESULT_NAME),
        JSON.stringify({ ...result, updatedAt: new Date().toISOString() }, null, 2),
        'utf8',
      );
    }

    result.finishedAt = new Date().toISOString();
    result.total = result.cases.length;
    result.passed = result.cases.filter((item) => item.status === 'pass').length;
    result.failed = result.cases.filter((item) => item.status !== 'pass').length;
    result.totalChecks = result.cases.reduce((sum, item) => sum + item.checks.length, 0);
    result.passedChecks = result.cases.reduce((sum, item) => sum + item.passed, 0);
    result.countsPending = '§1 两个计数在两次跑完后运行 node tools/e2e-long-tail.mjs --counts';
    console.log(`\n[summary] 用例 ${result.passed}/${result.total} 通过，失败 ${result.failed}；断言 ${result.passedChecks}/${result.totalChecks}`);
    console.log(`[summary] 截图与结果目录：${path.relative(ROOT, ARTIFACT_DIR)}`);
    await mkdir(ARTIFACT_DIR, { recursive: true });
    await writeFile(path.join(ARTIFACT_DIR, RESULT_NAME), JSON.stringify(result, null, 2), 'utf8');
    process.exitCode = result.failed === 0 ? 0 : 1;
  } catch (error) {
    result.error = error?.message ?? String(error);
    result.finishedAt = new Date().toISOString();
    console.log(`[error] ${result.error}`);
    try {
      if (cdp) {
        await cdp.screenshot('suite-error.png');
      }
    } catch {
      // 截图失败忽略
    }
    await mkdir(ARTIFACT_DIR, { recursive: true });
    await writeFile(path.join(ARTIFACT_DIR, RESULT_NAME), JSON.stringify(result, null, 2), 'utf8');
    process.exitCode = 1;
  } finally {
    cdp?.close();
    if (!KEEP_OPEN) {
      launched?.kill();
      await sleep(500);
      await rm(profileDir, { recursive: true, force: true }).catch(() => {});
    } else {
      console.log(`[env] --keep-open：浏览器与 profile 保留（${profileDir}）`);
    }
  }
}

/** 供独立自检/其它脚本复用的纯函数（PNG 解码、掩膜、栅格化、规则复算） */
export {
  decodePng,
  buildForegroundMask,
  maskBounds,
  fillMaskHoles,
  countMaskHoles,
  rasterizePolygon,
  compareNormalizedPointsWithMask,
  loadFixture,
  matchAssetsOld,
  matchAssetsNew,
  computeLocalRule,
  computeRuleCounts,
  computeOnlineCounts,
};

/** 仅作为 CLI 直接运行时执行主流程（被 import 时只导出函数，便于自检） */
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((error) => {
    console.error('[fatal]', error);
    process.exit(1);
  });
}
