/**
 * 真实链路 E2E（30 例）：浏览器 + 真实 LLM + 真实广州路网，无 mock。
 *
 * 目的：用 30 个"之前没有生成过"的复杂/多样用户输入，验证智能体完整链路：
 * 意图解析 → 引导/地点解析 → 参考图/参数化/自由轮廓目标 → 目标语义验收 → 真实路网规划
 * → 交付绿线 / 橙色参考版 / 诚实失败 → 回复与落盘状态一致。
 *
 * 依赖：
 * - 本地开发服务器已启动：`node web/server.mjs 5173`（页面、路网、日志与 /__reference 都来自它）
 * - Edge/Chrome（默认自动探测，可用 --browser 指定）
 * - web/src/agent/agent-config.js 已配置可用的 LLM 接口（真实网络调用，会消耗模型额度）
 *
 * 运行：
 *   node tools/e2e-real-llm-30.mjs                 # 全部 30 例
 *   node tools/e2e-real-llm-30.mjs --cases A1,B1   # 只跑指定用例
 *   node tools/e2e-real-llm-30.mjs --list          # 列出用例
 *   node tools/e2e-real-llm-30.mjs --keep-open     # 失败时保留浏览器进程便于调试
 * 产物：
 *   docs/测试报告/2026-11-01-真实LLM-E2E-30例/<caseId>-<slug>.png（截图证据）
 *   docs/测试报告/2026-11-01-真实LLM-E2E-30例/result-*.json（结构化结果）
 *
 * 说明：本脚本会真实消耗模型额度；每例执行前清空会话存储并刷新页面，保证用例互相独立。
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { summarizeDeliveryReports } from './lib/delivery-report.js';
import { Cdp, resolveBrowser, findFreePort, launchBrowser, sleep } from './lib/cdp-driver.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_URL = process.env.DRAWINMAP_E2E_URL || 'http://127.0.0.1:5173/';

/** 命令行参数 */
const argv = process.argv.slice(2);
const argOf = (name, fallback = null) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const KEEP_OPEN = argv.includes('--keep-open');
const LIST_ONLY = argv.includes('--list');
/** 用例筛选：--cases A1,B1 或 --cases A1-A5 */
const CASE_FILTER = argOf('cases', null);
/** 单轮等待上限（毫秒，默认 5 分钟：复杂自由轮廓 + 目标质检 + 路网搜索） */
const TURN_TIMEOUT = Number(argOf('turn-timeout', '300000'));
/** 结果文件名（便于分段跑后合并） */
const RESULT_NAME = argOf('out', 'result.json');
/** 用例文件（同一 schema：导出 CASES 数组；默认 30 例库，可指向其它用例文件） */
const CASES_FILE = argOf('cases-file', null);
/** 产物目录（截图与结果 JSON；默认 30 例验收目录，可指向新报告目录） */
const ARTIFACT_DIR = path.resolve(ROOT, argOf('artifact-dir', 'docs/测试报告/2026-11-01-真实LLM-E2E-30例'));
/** 结果集标题 */
const SUITE_TITLE = argOf('title', '浏览器真实 LLM E2E');

/** 截图时统一尺寸 */
const VIEW = { width: 1440, height: 900 };

/** 断言收集 */
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

/** 页面内读取的辅助表达式（一次往返取全部断言所需信息） */
const EXPR = {
  /** 应用就绪：对话面板 + 欢迎消息已渲染（地点配置/控制器初始化完成） */
  ready: `!!(document.getElementById('agent-send') && document.querySelector('#agent-messages .agent-msg'))`,
  /** 地图瓦片就绪：交付后 fitBounds 变焦，立刻截图会拍到旧层级瓦片被拉伸的模糊画面。
   *  等待条件：缩放动画结束 + 所有瓦片 img 已加载并标记 loaded，连续两轮轮询稳定；最多 8s。 */
  mapSettled: `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const tilesOk = () => {
      const tiles = Array.from(document.querySelectorAll('.leaflet-tile'));
      return tiles.every((tile) => tile.classList.contains('leaflet-tile-loaded') && (tile.tagName !== 'IMG' || tile.complete));
    };
    const start = Date.now();
    let stable = 0;
    while (Date.now() - start < 8000) {
      const animating = Boolean(document.querySelector('.leaflet-container.leaflet-zoom-anim'));
      if (!animating && tilesOk()) {
        stable += 1;
      } else {
        stable = 0;
      }
      if (stable >= 2) {
        return true;
      }
      await sleep(250);
    }
    return false;
  })()`,
  /** 状态快照：会话落盘状态 + DOM 状态 + 地图图层 */
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
          outline: m.outline ? {
            name: m.outline.name ?? null,
            source: m.outline.source ?? null,
            pointCount: m.outline.pointCount ?? null,
            rotationDeg: m.outline.rotationDeg ?? null,
            rendered: Boolean(m.outline.dataUrl),
          } : null,
          shapeId: m.shapeId || null,
          // 多比例尺候选卡片摘要（需求 2026-11-09）：随消息落盘的数字字段
          scaleCandidates: Array.isArray(m.scaleCandidates)
            ? m.scaleCandidates.map((c) => ({
                id: c.id ?? null,
                sizeMeters: c.sizeMeters ?? null,
                score: c.score ?? null,
                routeMeters: c.routeMeters ?? null,
                walkMinutes: c.walkMinutes ?? null,
                centerOffsetMeters: null,
              }))
            : null,
          scalePoolId: m.scalePoolId || null,
          scaleCurrentCardId: m.scaleCurrentCardId || null,
          scaleHiddenCount: m.scaleHiddenCount ?? null,
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
          // 结构化交付身份（方案 2026-11-08 §4.2）：实际交付了哪些对象、逐个可核对。
          // 生产与断言共用这一份，不再靠拼接显示名反推。
          deliveredObjects: Array.isArray(s.deliveredObjects) ? s.deliveredObjects : [],
          // 路线拓扑诊断随交付结果 JSON 留痕（缺陷清单 Bug 4.4）
          uniqueCrossingCount: s.uniqueCrossingCount ?? null,
          reusedEdgeRatio: s.reusedEdgeRatio ?? null,
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
        overlayCount: overlayPaths.length,
        routeStrokes: overlayPaths.map((p) => p.getAttribute('stroke')).filter(Boolean),
        indicator: (document.getElementById('shape-indicator') || {}).textContent?.trim() ?? '',
        switcherHidden: (document.getElementById('shape-switcher') || { hasAttribute: () => true }).hasAttribute('hidden'),
        switcherRect: (() => {
          const el = document.getElementById('shape-switcher');
          if (!el || el.hasAttribute('hidden')) return null;
          const rect = el.getBoundingClientRect();
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width };
        })(),
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        reasoningSteps: document.querySelectorAll('.agent-reasoning-steps li').length,
        refChoiceVisible: document.querySelectorAll('.agent-reference-choice.is-live .agent-ref-card').length > 0,
        guideVisible: document.querySelectorAll('.agent-options.is-live .agent-chip').length > 0,
        // 多比例尺候选卡片行（需求 2026-11-09）：活/静态、每卡尺寸/选中态/可用性
        scaleRows: Array.from(document.querySelectorAll('.agent-scale-cards')).map((row) => ({
          live: row.classList.contains('is-live'),
          stale: row.classList.contains('is-stale'),
          caption: row.querySelector('.agent-scale-caption')?.textContent ?? '',
          cards: Array.from(row.querySelectorAll('.agent-scale-card')).map((card) => ({
            text: card.textContent,
            current: card.classList.contains('is-current'),
            disabled: card.disabled,
          })),
        })),
        // 面板轻提示（交互修正 2026-11-09：点选卡片就地切换，不再追加对话消息）
        scaleToast: document.querySelector('.agent-toast')?.textContent ?? '',
        scaleToastVisible: Boolean(document.querySelector('.agent-toast.is-visible')),
        // 消息区滚动位置（点选切换不得把用户正在看的位置冲到底部）
        messagesScrollTop: (() => {
          const el = document.getElementById('agent-messages');
          return el ? Math.round(el.scrollTop) : null;
        })(),
      },
    };
  })()`,
  /** 发送一轮文本（等价用户输入后点发送） */
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
  /** 点引导选项（优先按下标，其次按文本包含） */
  clickGuide: (index, label) => `(() => {
    const chips = Array.from(document.querySelectorAll('.agent-options.is-live .agent-chip'));
    const labels = chips.map((c) => c.textContent.trim());
    const target = chips[${Number(index)}] || (${JSON.stringify(label ?? null)} ? chips.find((c) => c.textContent.includes(${JSON.stringify(label ?? '')})) : null);
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
  /** 点多比例尺候选卡（按下标；sizeText 为卡片主行文本，供断言点选目标） */
  clickScaleCard: (index) => `(() => {
    const rows = Array.from(document.querySelectorAll('.agent-scale-cards.is-live'));
    const cards = rows.flatMap((row) => Array.from(row.querySelectorAll('.agent-scale-card')));
    const target = cards[${Number(index)}];
    if (!target) return { ok: false, count: cards.length };
    const sizeText = target.querySelector('.agent-scale-size')?.textContent?.trim() ?? '';
    const isCurrent = target.classList.contains('is-current');
    const messagesBefore = document.querySelectorAll('.agent-msg').length;
    const scrollBefore = (() => {
      const el = document.getElementById('agent-messages');
      return el ? Math.round(el.scrollTop) : null;
    })();
    target.click();
    return {
      ok: true,
      count: cards.length,
      sizeText,
      isCurrent,
      messagesBefore,
      messagesAfter: document.querySelectorAll('.agent-msg').length,
      toast: document.querySelector('.agent-toast')?.textContent ?? '',
      scrollBefore,
      scrollAfter: (() => {
        const el = document.getElementById('agent-messages');
        return el ? Math.round(el.scrollTop) : null;
      })(),
    };
  })()`,
  /** 清空会话存储（用例隔离） */
  clearStore: `(() => {
    localStorage.removeItem('drawinmap.sessions.v1');
    return true;
  })()`,
  /** 历史列表开关与条目（真实用户操作路径） */
  openHistory: `(() => {
    const btn = document.getElementById('agent-history-toggle');
    if (!btn) return { ok: false };
    if (document.getElementById('session-panel')?.hasAttribute('hidden')) btn.click();
    return { ok: true };
  })()`,
  switchHistory: (index) => `(() => {
    const rows = Array.from(document.querySelectorAll('#session-list .session-item-main'));
    if (!rows[${Number(index)}]) return { ok: false, count: rows.length };
    rows[${Number(index)}].click();
    return { ok: true, count: rows.length };
  })()`,
  closeHistory: `(() => {
    const btn = document.getElementById('session-close');
    if (btn) btn.click();
    return true;
  })()`,
  clickNewSession: `(() => {
    const btn = document.getElementById('agent-new-session');
    if (!btn) return { ok: false };
    btn.click();
    return { ok: true };
  })()`,
  clickShapeNav: (which) => `(() => {
    const id = ${JSON.stringify(which)} === 'prev' ? 'shape-prev' : ${JSON.stringify(which)} === 'next' ? 'shape-next' : 'shape-latest';
    const btn = document.getElementById(id);
    if (!btn) return { ok: false };
    btn.click();
    return { ok: true };
  })()`,
};

/**
 * 解析用例筛选参数。
 *
 * @param {string|null} filter 筛选表达式
 * @returns {Set<string>|null} 用例 id 集合（null=全跑）
 */
function parseFilter(filter) {
  if (!filter) {
    return null;
  }
  const ids = new Set();
  for (const part of filter.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    const range = trimmed.match(/^([A-Z]+)(\d+)-([A-Z]+)?(\d+)$/);
    if (range) {
      const prefix = range[1];
      const start = Number(range[2]);
      const end = Number(range[4]);
      for (let index = start; index <= end; index += 1) {
        ids.add(`${prefix}${index}`);
      }
    } else {
      ids.add(trimmed);
    }
  }
  return ids;
}

/**
 * 执行一个用例（每例独立：清空会话存储 → 刷新 → 发送真实输入 → 断言）。
 *
 * @param {Cdp} cdp CDP 客户端
 * @param {object} caseDef 用例定义
 * @returns {Promise<object>} 用例结果
 */
async function runCase(cdp, caseDef) {
  console.log(`\n=== ${caseDef.id} ${caseDef.title} ===`);
  console.log(`  input: ${caseDef.input}`);
  const started = Date.now();
  const caseChecks = [];
  const caseStarted = checks.length;
  /** 用例级上下文 */
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
    /** 已知失败标记：用例定义里写了 knownFail 就是"存量失败"，不计入回归 */
    knownFail: caseDef.knownFail ?? null,
  };
  /** 每次 send 前重置断言收集器：今天工具函数使用外部 checks 数组，这里做切片 */
  function takeCaseChecks() {
    const slice = checks.slice(caseStarted);
    return slice;
  }
  const ctx = {
    /** 发送真实用户输入 */
    async send(text) {
      const result = await cdp.evaluate(EXPR.send(text));
      if (!result?.ok) {
        throw new Error(`发送失败：${JSON.stringify(result)}`);
      }
      record.snapshots.push({ step: 'send', text, at: Date.now() });
    },
    /** 等待本轮结束（发送按钮回到"发送"且没有实时推理气泡） */
    async waitTurn(timeoutMs = TURN_TIMEOUT) {
      const sent = Date.now();
      const done = await cdp.waitFor(
        `(() => {
          const button = document.getElementById('agent-send');
          if (!button) return false;
          const busy = button.textContent.trim() === '停止';
          const pending = Boolean(document.querySelector('.agent-msg-agent.is-pending'));
          return !busy && !pending && ${'Date.now()'} - ${sent} > 400;
        })()`,
        timeoutMs,
        '一轮完成',
        400,
      ).catch(() => false);
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
    /** 点击发送/停止按钮（同一个按钮，按当前文本决定行为） */
    async clickSend() {
      return cdp.evaluate(`(() => {
        const button = document.getElementById('agent-send');
        if (!button) return { ok: false, reason: 'no-button' };
        const label = button.textContent.trim();
        button.click();
        return { ok: true, label };
      })()`);
    },
    /** 点击引导选项 */
    async clickGuide(index, label) {
      return cdp.evaluate(EXPR.clickGuide(index, label));
    },
    /** 点击参考候选卡 */
    async clickRefCard(index) {
      return cdp.evaluate(EXPR.clickRefCard(index));
    },
    /** 点多比例尺候选卡（需求 2026-11-09） */
    async clickScaleCard(index) {
      return cdp.evaluate(EXPR.clickScaleCard(index));
    },
    /** 页面内任意只读求值（用例内自定义探测，如全局日志计数） */
    async evaluate(expression) {
      return cdp.evaluate(expression);
    },
    /** 刷新页面并等就绪 */
    async reload() {
      await cdp.send('Page.reload');
      const ready = await cdp.waitFor(EXPR.ready, 60000, '刷新后应用就绪');
      await sleep(800);
      return ready;
    },
    /** 清空会话存储 + 刷新（用例隔离）。注意：store 在 pagehide 会 flush 旧数据，
     *  所以必须"先离开页面 → 清 origin 存储 → 再进页面"，否则旧会话会被写回。 */
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
    async uploadImageBase64(base64, name = 'star.png') {
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
    /** 设置浏览器视口（窄屏布局验证） */
    async setViewport(width, height, { mobile = false, scale = 1 } = {}) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: scale,
        mobile,
      });
      await sleep(500);
    },
    /** 清除视口模拟 */
    async clearViewport() {
      await cdp.send('Emulation.clearDeviceMetricsOverride');
      await sleep(300);
    },
    /** 打开历史对话列表 */
    async openHistory() {
      return cdp.evaluate(EXPR.openHistory);
    },
    /** 切换历史会话（按列表下标） */
    async switchHistory(index) {
      return cdp.evaluate(EXPR.switchHistory(index));
    },
    /** 关闭历史对话列表 */
    async closeHistory() {
      return cdp.evaluate(EXPR.closeHistory);
    },
    /** 新建对话 */
    async newSession() {
      return cdp.evaluate(EXPR.clickNewSession);
    },
    /** 图形切换控件：prev / next / latest */
    async shapeNav(which) {
      return cdp.evaluate(EXPR.clickShapeNav(which));
    },
    /** 读取本轮真实链路日志（页面日志 API，真实 trace 证据：意图/地点/引擎/交付判定） */
    async logs(traceId) {
      if (!traceId) {
        return { unavailable: true, reason: 'no-trace-id' };
      }
      return cdp.evaluate(`(() => {
        const api = window.DrawInMapLog;
        if (!api || typeof api.entries !== 'function') return { unavailable: true };
        const wanted = new Set([
          'agent.intent', 'agent.reply', 'agent.chat', 'guide.question', 'guide.option', 'guide.freeText',
          'guide.done', 'place.resolved', 'place.unresolved.ask', 'plan.begin', 'plan.selected',
          'plan.failed', 'deliver.rejected', 'deliver.reference', 'deliver.recommended',
          'target.accepted', 'target.rejected', 'recommend.result', 'recommend.failed',
          'reference.candidates', 'reference.choice', 'llm.error', 'agent.intent.failed',
          // 来源阶段的唯一真相：粗搜级别 + 是否精修（方案 2026-11-05 §5.2）。
          // 不加这一条就只能拿 plan.selected.stage 反推来源——那个值一词二义。
          'candidates.chosen',
          // 多对象请求的命中/缺失对象（方案 2026-11-05 §4.2）
          'agent.reference.multi', 'agent.reference.multi.partial', 'agent.reference.multi.used',
          'agent.reference.multi.perObject',
          'deliver.objectMismatch',
          // 三路通道可见化 + 在线补漏验收（缺陷清单 Bug 1）
          'agent.threeSources.path',
          // 自由轮廓验收证据（方案 2026-11-08 §5.1）：点数门/拓扑/视觉/约束结论、
          // 每版 T 的分别结论、终止原因（截断 vs 普通失败）、原始与修正响应的元数据
          'agent.threeSources.freeform', 'agent.freeform.qualityFailed', 'agent.freeform.qualified',
          'shape.review',
          // 显式约束核验与交付闸门（方案 2026-11-08 §3.3/§4.1）
          'plan.delivered', 'deliver.constraintViolation', 'deliver.objectNameDiff',
          'target.constraints.checked', 'target.constraints.suspected',
          // 不支持拓扑的提前终止（方案 2026-11-08 §5.2）
          'shape.recovery.skipped', 'shape.recovery.start',
          // 目标质检请求原文（缺陷清单 Bug 2：核对「用户想画」与原始请求一致）
          'llm.request',
          // 备选切换（缺陷清单 Bug 5）
          'deliver.alternativeSwitched',
          // 拓扑诊断留痕（缺陷清单 Bug 4.4）
          'plan.topology',
          // 多比例尺候选卡片（需求 2026-11-09）：池构建/点选切换/当前版提示/失效丢弃；
          // ui.scaleCard.* 是交互修正 2026-11-09 的就地切换证据（不新增消息、不重规划）
          'deliver.scalePool', 'deliver.scalePool.skipped', 'deliver.scalePool.discarded',
          'deliver.scalePool.synced', 'deliver.scaleSwitched', 'deliver.scaleSwitch.current',
          'deliver.scaleSwitch.refused',
          'ui.scaleCard.click', 'ui.scaleCard.applied', 'ui.scaleCard.current',
          'ui.scaleCard.refused', 'ui.scaleCard.stale',
        ]);
        try {
          const list = api.entries({ traceId: ${JSON.stringify(traceId)} }) || [];
          return list
            .filter((item) => item && wanted.has(item.event))
            .map((item) => ({ event: item.event, module: item.module ?? null, data: item.data ?? null }));
        } catch (error) {
          return { error: String(error && error.message ? error.message : error) };
        }
      })()`);
    },
    /** 记录一条断言 */
    check(label, condition, detail) {
      check(`${label}`, condition, detail);
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
    /** 截图（先尽力等地图瓦片加载完成，失败不阻断用例） */
    async shot(slug) {
      try {
        await cdp.evaluate(EXPR.mapSettled);
      } catch {
        // 瓦片等待超时不阻断用例，照常截图
      }
      await sleep(300);
      const name = `${caseDef.id.toLowerCase()}-${slug}.png`.replace(/[<>:"/\\|?*]/g, '-');
      await cdp.screenshot(name);
      record.screenshots.push(name);
    },
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
    // 已知失败：用例定义里标了 knownFail → 标成 known-fail（单独统计，不掩盖回归）。
    // 反过来，如果它这次**通过**了，记 knownFailFixed，提醒把标记去掉。
    if (record.knownFail && record.status !== 'pass') {
      record.status = 'known-fail';
    } else if (record.knownFail && record.status === 'pass') {
      record.knownFailFixed = true;
    }
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

/**
 * 主流程。
 */
async function main() {
  const caseModule = CASES_FILE
    ? await import(pathToFileURL(path.resolve(ROOT, CASES_FILE)).href)
    : await import('../test/e2e-real-llm-30-cases.mjs');
  const CASES = caseModule.CASES ?? caseModule.default;
  if (!Array.isArray(CASES) || CASES.length === 0) {
    console.error(`[fatal] 用例文件未导出 CASES 数组：${CASES_FILE ?? 'test/e2e-real-llm-30-cases.mjs'}`);
    process.exit(1);
  }
  if (LIST_ONLY) {
    for (const item of CASES) {
      console.log(`${item.id}\t${item.category}\t${item.title}\t${item.input}`);
    }
    return;
  }
  const filter = parseFilter(CASE_FILTER);
  const selected = filter ? CASES.filter((item) => filter.has(item.id)) : CASES;
  if (selected.length === 0) {
    console.error(`[fatal] 用例筛选结果为空：${CASE_FILTER}`);
    process.exit(1);
  }
  const browserPath = resolveBrowser(argOf('browser'));
  const port = await findFreePort(Number(argOf('port', '9353')));
  const profileDir = path.join(os.tmpdir(), `drawinmap-e2e-30-${Date.now()}`);
  console.log(`[env] browser=${browserPath}`);
  console.log(`[env] devtoolsPort=${port} profile=${profileDir}`);
  console.log(`[env] app=${APP_URL}`);
  console.log(`[env] cases=${selected.map((item) => item.id).join(',')}（${selected.length} 例）`);

  let launched = null;
  let cdp = null;
  const result = {
    title: `${SUITE_TITLE}（${selected.length} 例）`,
    startedAt: new Date().toISOString(),
    appUrl: APP_URL,
    browser: browserPath,
    cases: [],
  };
  try {
    // 启动段统一走 tools/lib/cdp-driver.mjs 的 launchBrowser（禁用扩展/同步/静音为公共默认参数）
    launched = await launchBrowser({
      browserPath,
      port,
      userDataDir: profileDir,
      windowSize: VIEW,
      openPage: true,
    });
    console.log(`[env] ${launched.version.Browser}`);
    cdp = new Cdp(launched.wsUrl, { artifactDir: ARTIFACT_DIR });
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
    // 已知失败单独成一档：不算回归失败，但必须在报告里显式列出，
    // 否则"存量失败"会把真回归一起掩盖掉。
    result.knownFailed = result.cases.filter((item) => item.status === 'known-fail');
    result.knownFailFixed = result.cases.filter((item) => item.knownFailFixed);
    result.failed = result.cases.filter((item) => item.status !== 'pass' && item.status !== 'known-fail').length;
    result.totalChecks = result.cases.reduce((sum, item) => sum + item.checks.length, 0);
    result.passedChecks = result.cases.reduce((sum, item) => sum + item.passed, 0);
    // 分维度汇总（方案 2026-11-05 §5.1）：整体通过不得只由地图为绿色推出——
    // 契约、目标、落点、成本四个维度分别统计，越界清单单独列出。
    result.dimensions = summarizeDeliveryReports(
      result.cases.map((item) => item.actual?.deliveryReport).filter(Boolean),
    );
    console.log(`\n[summary] 用例 ${result.passed}/${result.total} 通过，失败 ${result.failed}；断言 ${result.passedChecks}/${result.totalChecks}`);
    if (result.knownFailed.length > 0) {
      console.log(`[known-fail] 已知失败 ${result.knownFailed.length} 例（不计入回归）：`);
      for (const item of result.knownFailed) {
        console.log(`  ${item.id} ${item.title} —— ${item.knownFail}`);
      }
    }
    if (result.knownFailFixed.length > 0) {
      console.log(`[known-fail] 已修复（本次通过，可去掉 knownFail 标记）：`);
      for (const item of result.knownFailFixed) {
        console.log(`  ${item.id} ${item.title}`);
      }
    }
    if (result.dimensions.total > 0) {
      console.log(
        `[dimensions] 契约 ${result.dimensions.contractPass}/${result.dimensions.total} · ` +
          `目标 ${result.dimensions.targetPass}/${result.dimensions.total} · ` +
          `整体 ${result.dimensions.overallPass}/${result.dimensions.total} · ` +
          `落点越界 ${result.dimensions.locationOver}（授权 ${result.dimensions.locationAuthorized}） · ` +
          `成本越界 ${result.dimensions.routeCostOver}（授权 ${result.dimensions.routeCostAuthorized}）`,
      );
    }
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
    }
  }
}

main().catch((error) => {
  console.error('[fatal]', error);
  process.exit(1);
});
