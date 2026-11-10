/**
 * 真实链路 E2E：参考图多候选挑选（浏览器 + 真实 LLM + 真实广州路网，无 mock）。
 *
 * 覆盖（方案 2026-10-31 §11.4 真实链路验收的本地参考素材部分）：
 * 1. 马 → 三张候选卡并排（实际 T 渲染），待选期间不规划（无图形快照）；
 * 2. 点击第二张 → 正式规划，回复目标点序列与所选卡点数一致；
 * 3. 候选轮/规划轮双 trace（两条消息 traceId 不同）+ choiceId 关联（消息 referenceChoiceId
 *    = context.referenceChoice.choiceId）+ 选择消息留痕（selectedCandidateId）；
 * 4. 单版本对象（鸽子）不弹卡直接规划；
 * 5. 刷新后待选恢复（猫两张卡刷新后仍在，可继续点击完成规划）；
 * 6. 375px 窄屏候选卡无页面级横向溢出。
 *
 * 依赖：
 * - 本地开发服务器已启动：`node web/server.mjs 5173`（含 /__reference 接口）
 * - Edge/Chrome（默认自动探测，可用 --browser 指定）
 * - `web/src/agent/agent-config.js` 已配置可用的 LLM 接口（真实网络调用）
 *
 * 运行：node tools/e2e-reference-choice.mjs [--port 9343] [--keep-open]
 * 产物：docs/测试报告/2026-11-01-参考图多候选真实链路验收/*.png + result.json
 * 说明：本脚本会真实消耗模型额度；失败时保留 JSON 结果与截图便于定位。
 */

import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_URL = 'http://127.0.0.1:5173/';
const ARTIFACT_DIR = path.join(ROOT, 'docs', '测试报告', '2026-11-01-参考图多候选真实链路验收');

const argv = process.argv.slice(2);
const argOf = (name, fallback = null) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const KEEP_OPEN = argv.includes('--keep-open');

const checks = [];
function check(label, condition, detail = '') {
  const ok = Boolean(condition);
  checks.push({ label, ok, detail: ok ? '' : String(detail) });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` → ${detail}`}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function findFreePort(start) {
  for (let port = start; port < start + 20; port += 1) {
    const free = await new Promise((resolve) => {
      const server = createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => server.close(() => resolve(true)));
      server.listen(port, '127.0.0.1');
    });
    if (free) {
      return port;
    }
  }
  throw new Error('找不到可用调试端口');
}

function resolveBrowser(explicit) {
  if (explicit) {
    return explicit;
  }
  const candidates = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ];
  const found = candidates.find((item) => existsSync(item));
  if (!found) {
    throw new Error('未找到 Edge/Chrome，请用 --browser 指定可执行文件路径');
  }
  return found;
}

/** 极简 CDP 客户端（与 tools/e2e-real-llm.mjs 同一套实现） */
class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) {
          reject(new Error(`${message.error.message} (${JSON.stringify(message.error.data ?? '')})`));
        } else {
          resolve(message.result);
        }
      }
    });
  }

  async open() {
    if (this.ws.readyState === WebSocket.OPEN) {
      return;
    }
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true });
    });
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 调用超时：${method}`));
        }
      }, 120000);
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      const text = result.exceptionDetails.exception?.description
        || result.exceptionDetails.text
        || '页面表达式异常';
      throw new Error(`页面执行失败：${text.slice(0, 300)}`);
    }
    return result.result?.value;
  }

  async waitFor(expression, timeoutMs, label) {
    const started = Date.now();
    let lastError = null;
    while (Date.now() - started < timeoutMs) {
      try {
        if (await this.evaluate(expression)) {
          return true;
        }
      } catch (error) {
        lastError = error;
      }
      await sleep(250);
    }
    console.log(`[wait] ${label} 超时（${Math.round(timeoutMs / 1000)}s）${lastError ? `，最后错误：${lastError.message}` : ''}`);
    return false;
  }

  async screenshot(name) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    await mkdir(ARTIFACT_DIR, { recursive: true });
    const file = path.join(ARTIFACT_DIR, name);
    await writeFile(file, Buffer.from(data, 'base64'));
    console.log(`[shot] ${file}`);
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // 忽略关闭异常
    }
  }
}

/** 页面内读取的辅助表达式 */
const EXPR = {
  liveCards: `document.querySelectorAll('.agent-reference-choice.is-live .agent-ref-card').length`,
  cardSummaries: `Array.from(document.querySelectorAll('.agent-reference-choice.is-live .agent-ref-card')).map((card) => ({
    name: card.querySelector('.agent-ref-name')?.textContent ?? '',
    meta: card.querySelector('.agent-ref-meta')?.textContent ?? '',
    badge: card.querySelector('.agent-ref-badge')?.textContent ?? '',
    hasImage: Boolean(card.querySelector('img')?.src?.startsWith('data:image')),
    pointCount: Number((card.querySelector('.agent-ref-meta')?.textContent ?? '').match(/(\\d+) 点/)?.[1] ?? 0),
  }))`,
  sendButtonText: `document.getElementById('agent-send').textContent.trim()`,
  overlayPaths: `document.querySelectorAll('.leaflet-overlay-pane path').length`,
  lastOutlineCaption: `(() => {
    const list = document.querySelectorAll('.agent-outline-caption');
    return list.length ? list[list.length - 1].textContent : '';
  })()`,
  lastAgentText: `(() => {
    const list = document.querySelectorAll('.agent-msg-agent .agent-msg-text');
    return list.length ? list[list.length - 1].textContent : '';
  })()`,
  /** 会话落盘状态：消息/图形/上下文待选/候选消息关联 */
  readState: `(() => {
    const raw = localStorage.getItem('drawinmap.sessions.v1');
    if (!raw) return null;
    const state = JSON.parse(raw);
    const session = state.sessions.find((item) => item.id === state.activeId) || null;
    if (!session) return null;
    const refCandidates = session.messages.filter((m) => m.kind === 'reference-candidates');
    const refSelections = session.messages.filter((m) => m.kind === 'reference-selection');
    const lastFinal = [...session.messages].reverse().find((m) => m.kind === 'chat' && m.role === 'agent') || null;
    return {
      shapes: session.shapes.map((s) => ({ shapeName: s.shapeName, reference: s.reference })),
      refCandidates: refCandidates.map((m) => ({ id: m.referenceChoiceId, traceId: m.traceId })),
      refSelections: refSelections.map((m) => ({ choiceId: m.referenceChoiceId, candidateId: m.selectedCandidateId })),
      contextChoice: session.context?.referenceChoice ? {
        choiceId: session.context.referenceChoice.choiceId,
        status: session.context.referenceChoice.status,
        candidateCount: (session.context.referenceChoice.candidates || []).length,
        candidateIds: (session.context.referenceChoice.candidates || []).map((c) => c.candidateId),
        selectedCandidateId: session.context.referenceChoice.selectedCandidateId ?? null,
      } : null,
      lastAgentTraceId: lastFinal?.traceId ?? null,
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  })()`,
};

async function main() {
  const browserPath = resolveBrowser(argOf('browser'));
  const port = await findFreePort(Number(argOf('port', '9343')));
  const profileDir = path.join(os.tmpdir(), `drawinmap-e2e-ref-${Date.now()}`);
  console.log(`[env] browser=${browserPath}`);
  console.log(`[env] devtoolsPort=${port} profile=${profileDir}`);

  const browser = spawn(browserPath, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--mute-audio',
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    '--window-size=1440,900',
    'about:blank',
  ], { stdio: 'ignore' });

  let cdp = null;
  const result = { checks, startedAt: new Date().toISOString() };
  try {
    let version = null;
    for (let i = 0; i < 80; i += 1) {
      try {
        version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
        break;
      } catch {
        await sleep(250);
      }
    }
    if (!version) {
      throw new Error('浏览器 DevTools 端点未就绪');
    }
    console.log(`[env] ${version.Browser}`);

    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    await cdp.send('Page.navigate', { url: APP_URL });
    const ready = await cdp.waitFor(
      `!!(document.getElementById('agent-send') && document.querySelector('#agent-messages .agent-msg'))`,
      30000,
      '应用启动',
    );
    check('浏览器启动并渲染对话面板', ready);

    const sendText = (text) => cdp.evaluate(`(() => {
      const input = document.getElementById('agent-input');
      input.value = ${JSON.stringify(text)};
      document.getElementById('agent-send').click();
      return true;
    })()`);
    const waitTurn = (timeoutMs) => cdp.waitFor(
      `document.getElementById('agent-send').textContent.trim() === '发送'`,
      timeoutMs,
      '一轮完成',
    );
    const waitCards = (count, timeoutMs, label) => cdp.waitFor(
      `document.querySelectorAll('.agent-reference-choice.is-live .agent-ref-card').length === ${count}`,
      timeoutMs,
      label,
    );

    // ---------- 用例 1：马 → 三张候选卡 → 点第二张 → 规划与所选 T 一致 ----------
    await sendText('在广州塔画一匹马');
    const cards1 = await waitCards(3, 120000, '马的三张候选卡');
    check('马：三张候选卡并排出现', cards1, String(await cdp.evaluate(EXPR.liveCards)));
    const summaries1 = await cdp.evaluate(EXPR.cardSummaries);
    console.log(`[cards] ${JSON.stringify(summaries1)}`);
    check('马：候选卡带实际 T 小图（canvas dataURL）', summaries1.length === 3 && summaries1.every((card) => card.hasImage && card.pointCount > 0));
    check('马：候选卡标注"本地精选"', summaries1.every((card) => card.badge === '本地精选'));

    const stateAwaiting = await cdp.evaluate(EXPR.readState);
    check('待选：引擎未被调用（无图形快照）', stateAwaiting.shapes.length === 0, JSON.stringify(stateAwaiting.shapes));
    check('待选：候选消息带 referenceChoiceId + 候选轮 traceId', stateAwaiting.refCandidates.length >= 1 && Boolean(stateAwaiting.refCandidates.at(-1)?.id) && Boolean(stateAwaiting.refCandidates.at(-1)?.traceId));
    check('待选：context.referenceChoice 状态 awaiting（3 候选）', stateAwaiting.contextChoice?.status === 'awaiting-selection' && stateAwaiting.contextChoice.candidateCount === 3, JSON.stringify(stateAwaiting.contextChoice));
    check('待选：候选消息 referenceChoiceId 与 context choiceId 一致', stateAwaiting.refCandidates.at(-1)?.id === stateAwaiting.contextChoice?.choiceId);
    await cdp.screenshot('ref-01-马三张候选卡.png');

    // 点击第二张（站姿马），记录其点数用于规划一致性核对
    const clickedMeta = await cdp.evaluate(`(() => {
      const cards = document.querySelectorAll('.agent-reference-choice.is-live .agent-ref-card');
      if (cards.length < 2) return null;
      const card = cards[1];
      const meta = card.querySelector('.agent-ref-meta')?.textContent ?? '';
      card.click();
      return { meta, pointCount: Number(meta.match(/(\\d+) 点/)?.[1] ?? 0) };
    })()`);
    check('选择：第二张卡可点击（候选轮结束）', Boolean(clickedMeta), JSON.stringify(clickedMeta));
    const turn1 = await waitTurn(300000);
    check('选择后规划在 5 分钟内完成', turn1);
    const outline1 = await cdp.evaluate(EXPR.lastOutlineCaption);
    console.log(`[plan] outline=${outline1}`);
    check('规划：回复目标点序列与所选卡点数一致', outline1.includes(`· ${clickedMeta.pointCount} 点 ·`) && outline1.includes('参考图命中'), `所选 ${clickedMeta.pointCount} 点 vs ${outline1}`);
    check('规划：真实交付图形（地图有图层）', (await cdp.evaluate(EXPR.overlayPaths)) > 0);

    const stateSelected = await cdp.evaluate(EXPR.readState);
    console.log(`[selected] ${JSON.stringify(stateSelected)}`);
    check('选择：reference-selection 消息留痕（selectedCandidateId）', stateSelected.refSelections.length >= 1 && Boolean(stateSelected.refSelections.at(-1)?.candidateId));
    check('选择：context.referenceChoice 转 selected（只留选中候选）', stateSelected.contextChoice?.status === 'selected' && stateSelected.contextChoice.candidateCount === 1 && stateSelected.contextChoice.selectedCandidateId === stateSelected.refSelections.at(-1)?.candidateId, JSON.stringify(stateSelected.contextChoice));
    check('双 trace：候选轮与规划轮 traceId 不同', stateSelected.refCandidates.at(-1)?.traceId && stateSelected.lastAgentTraceId && stateSelected.refCandidates.at(-1).traceId !== stateSelected.lastAgentTraceId, `${stateSelected.refCandidates.at(-1)?.traceId} vs ${stateSelected.lastAgentTraceId}`);
    check('双 trace：choiceId 串联（选择消息与候选消息同一 choiceId）', stateSelected.refSelections.at(-1)?.choiceId === stateSelected.refCandidates.at(-1)?.id, `${stateSelected.refSelections.at(-1)?.choiceId} vs ${stateSelected.refCandidates.at(-1)?.id}`);
    await cdp.screenshot('ref-02-选择后规划交付.png');

    // ---------- 用例 2：单版本对象（鸽子）不弹卡直接规划 ----------
    await sendText('在广州塔画一只鸽子');
    const turn2 = await waitTurn(300000);
    check('鸽子：一轮直接完成（无待选）', turn2);
    const cards2 = await cdp.evaluate(EXPR.liveCards);
    check('鸽子：不弹候选卡', cards2 === 0, String(cards2));
    const outline2 = await cdp.evaluate(EXPR.lastOutlineCaption);
    check('鸽子：直接规划出参考命中轮廓', outline2.includes('参考图命中') && /\d+ 点/.test(outline2), outline2);
    const statePigeon = await cdp.evaluate(EXPR.readState);
    check('鸽子：新增图形快照（直走规划）', statePigeon.shapes.length >= 2, JSON.stringify(statePigeon.shapes));
    await cdp.screenshot('ref-03-单候选直接规划.png');

    // ---------- 用例 3：刷新恢复待选（猫两张卡 → 刷新 → 继续选择） ----------
    await sendText('在天河画只猫');
    const cards3 = await waitCards(2, 120000, '猫的两张候选卡');
    check('猫：两张候选卡出现', cards3, String(await cdp.evaluate(EXPR.liveCards)));
    const beforeReload = await cdp.evaluate(EXPR.readState);
    check('猫：待选快照 awaiting（2 候选）', beforeReload.contextChoice?.status === 'awaiting-selection' && beforeReload.contextChoice.candidateCount === 2, JSON.stringify(beforeReload.contextChoice));

    await cdp.send('Page.reload');
    const reloadReady = await cdp.waitFor(
      `document.querySelectorAll('.agent-reference-choice.is-live .agent-ref-card').length === 2`,
      60000,
      '刷新后待选卡恢复',
    );
    check('刷新：待选候选卡恢复可点', reloadReady, String(await cdp.evaluate(EXPR.liveCards)));
    const stateReloaded = await cdp.evaluate(EXPR.readState);
    check('刷新：choiceId 不变（待选快照原样恢复）', stateReloaded.contextChoice?.choiceId === beforeReload.contextChoice?.choiceId, JSON.stringify(stateReloaded.contextChoice));
    await cdp.screenshot('ref-04-刷新后待选恢复.png');

    const clicked2 = await cdp.evaluate(`(() => {
      const cards = document.querySelectorAll('.agent-reference-choice.is-live .agent-ref-card');
      if (cards.length < 1) return null;
      const meta = cards[0].querySelector('.agent-ref-meta')?.textContent ?? '';
      cards[0].click();
      return { meta, pointCount: Number(meta.match(/(\\d+) 点/)?.[1] ?? 0) };
    })()`);
    const turn3 = await waitTurn(300000);
    check('刷新后选择可继续完成规划', turn3);
    const outline3 = await cdp.evaluate(EXPR.lastOutlineCaption);
    check('刷新后规划与所选 T 一致', outline3.includes(`· ${clicked2.pointCount} 点 ·`), `所选 ${clicked2.pointCount} 点 vs ${outline3}`);
    await cdp.screenshot('ref-05-刷新后选择完成.png');

    // ---------- 用例 4：375px 窄屏候选卡无横向溢出 ----------
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 375,
      height: 700,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await sleep(800);
    await sendText('在越秀公园画只狗');
    const cards4 = await waitCards(3, 120000, '狗的三张候选卡（窄屏）');
    check('窄屏：狗三张候选卡出现', cards4, String(await cdp.evaluate(EXPR.liveCards)));
    const overflow = await cdp.evaluate(`(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }))()`);
    check('375px：候选卡无页面级横向溢出', overflow.scrollWidth <= overflow.clientWidth + 2, JSON.stringify(overflow));
    await cdp.screenshot('ref-06-窄屏候选卡.png');

    // ---------- 汇总 ----------
    result.finishedAt = new Date().toISOString();
    result.passed = checks.filter((item) => item.ok).length;
    result.failed = checks.filter((item) => !item.ok).length;
    console.log(`\\n[summary] ${result.passed}/${checks.length} 通过，失败 ${result.failed}`);
    await mkdir(ARTIFACT_DIR, { recursive: true });
    await writeFile(path.join(ARTIFACT_DIR, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
    process.exitCode = result.failed === 0 ? 0 : 1;
  } catch (error) {
    result.error = error?.message ?? String(error);
    result.finishedAt = new Date().toISOString();
    result.passed = checks.filter((item) => item.ok).length;
    result.failed = checks.filter((item) => !item.ok).length;
    console.log(`[error] ${result.error}`);
    try {
      if (cdp) {
        await cdp.screenshot('ref-error.png');
      }
    } catch {
      // 截图失败忽略
    }
    await mkdir(ARTIFACT_DIR, { recursive: true });
    await writeFile(path.join(ARTIFACT_DIR, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
    process.exitCode = 1;
  } finally {
    cdp?.close();
    if (!KEEP_OPEN) {
      browser.kill();
      await sleep(500);
      await rm(profileDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

main().catch((error) => {
  console.error('[fatal]', error);
  process.exit(1);
});
