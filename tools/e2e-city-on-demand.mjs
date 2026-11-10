/**
 * 按需获取全国城市路网 E2E 验收（需求 §5：真实浏览器 + 真实 LLM + 真实下载，无 mock）。
 *
 * 六个用例（E2E-01 ~ E2E-06）：
 * - E2E-01 默认广州直画（R1：启动不下载任何其他城市路网，也不为广州再下载）；
 * - E2E-02/03/04 选择深圳/北京/成都 → 看见获取过程 → 完成进入新城 → 真实模型画图
 *   → 路线落在该城范围且不在广州核心区（R2/R4）；
 * - E2E-05 再选深圳：零获取作业，直接可画（R3）；
 * - E2E-06 未缓存城市（韶关）：测试开关制造获取失败 → 失败可见/城市不可画/当前仍停在
 *   切换前的城市 → 关闭开关重试 → 成功后画图（R2 失败与重试链路）。
 *
 * 证据：每例地图截图、画图轮 traceId（.agent-trace-copy）、/__city/cache 里该城
 * generated_at 在当次开跑之后（真实获取证据）、服务器日志落盘。
 *
 * 运行：node tools/e2e-city-on-demand.mjs [--port 9339] [--keep-server] [--browser path]
 * 前置：Edge/Chrome 可用；web/src/agent/agent-config.js 已配置真实 LLM；
 *       脚本自起独立端口服务器（DRAWINMAP_CITY_TEST_HOOKS=1）并在开跑前清空
 *       web/data/city-roads/（满足"深圳/北京/成都开始前环境里没有这三城路网"）。
 * 产物：docs/测试报告/2026-11-08-按需获取全国城市路网验收/（截图 + result-city-on-demand.json）
 */

import { spawn } from 'node:child_process';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Cdp, resolveBrowser, launchBrowser, sleep } from './lib/cdp-driver.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACT_DIR = path.join(ROOT, 'docs', '测试报告', '2026-11-08-按需获取全国城市路网验收');
const CACHE_DIR = path.join(ROOT, 'web', 'data', 'city-roads');
const SERVER_PORT = 5189;

/** 命令行参数 */
const argv = process.argv.slice(2);
const argOf = (name, fallback = null) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const CDP_PORT = Number(argOf('port', '9339'));
const KEEP_SERVER = argv.includes('--keep-server');

/** 验收抽样城市与路线范围（需求 §5 表格原文口径；geometry 点序为 [lat, lng]） */
const CASE_CITIES = [
  { id: 'shenzhen', label: '深圳', input: '在深圳画个五角星', shape: '五角星', bbox: { minLat: 22.4, maxLat: 22.9, minLng: 113.7, maxLng: 114.6 } },
  { id: 'beijing', label: '北京', input: '在北京画个心形', shape: '心形', bbox: { minLat: 39.4, maxLat: 41.1, minLng: 115.4, maxLng: 117.5 } },
  { id: 'chengdu', label: '成都', input: '在成都画个矩形', shape: '矩形', bbox: { minLat: 30.1, maxLat: 31.4, minLng: 103.0, maxLng: 104.9 } },
];

/** 广州核心区（E2E-01 路线应落在此范围；抽样城市路线应不在此范围） */
const GZ_CORE = { minLat: 23.06, maxLat: 23.17, minLng: 113.22, maxLng: 113.36 };

/** E2E-06 用的未缓存城市（不在抽样三城内，避免把"已缓存"误当成失败恢复） */
const FAILURE_CASE_CITY = { id: 'shaoguan', label: '韶关', input: '在韶关画个五角星', bbox: { minLat: 24.3, maxLat: 25.3, minLng: 113.0, maxLng: 114.2 } };

/** 断言记录 */
const checks = [];
function check(label, condition, detail = '') {
  const ok = Boolean(condition);
  checks.push({ label, ok, detail: ok ? '' : String(detail).slice(0, 400) });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` → ${String(detail).slice(0, 300)}`}`);
  return ok;
}

/** 从服务器取缓存清单 */
async function serverCache() {
  const response = await fetch(`http://127.0.0.1:${SERVER_PORT}/__city/cache`);
  const payload = await response.json();
  return payload?.cache ?? [];
}

/** 从服务器取作业列表 */
async function serverJobs() {
  const response = await fetch(`http://127.0.0.1:${SERVER_PORT}/__city/jobs`);
  const payload = await response.json();
  return payload?.jobs ?? [];
}

/** 测试开关（E2E-06 失败制造） */
async function setSourceBlock(on) {
  const response = await fetch(`http://127.0.0.1:${SERVER_PORT}/__city/test/source-block`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ on }),
  });
  return response.json();
}

async function main() {
  const browserPath = resolveBrowser(argOf('browser'));
  await mkdir(ARTIFACT_DIR, { recursive: true });

  // ===== 环境准备：清空城市缓存（满足"开始前没有这三城路网"），自起服务器 =====
  let cacheFilesBefore = [];
  try {
    cacheFilesBefore = (await readdir(CACHE_DIR)).filter((name) => name.endsWith('.json'));
  } catch {
    // 目录不存在
  }
  console.log(`[env] 清空前缓存文件：${cacheFilesBefore.join('、') || '（无）'}`);
  await rm(CACHE_DIR, { recursive: true, force: true });
  await mkdir(CACHE_DIR, { recursive: true });

  const server = spawn(process.execPath, ['web/server.mjs', String(SERVER_PORT)], {
    cwd: ROOT,
    env: { ...process.env, DRAWINMAP_CITY_TEST_HOOKS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverLog = [];
  server.stdout.on('data', (chunk) => serverLog.push(String(chunk)));
  server.stderr.on('data', (chunk) => serverLog.push(String(chunk)));
  let serverUp = false;
  for (let i = 0; i < 50 && !serverUp; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${SERVER_PORT}/__city/cache`);
      serverUp = response.ok;
    } catch {
      await sleep(300);
    }
  }
  if (!serverUp) {
    console.error('[env] 服务器未就绪，日志尾部：', serverLog.slice(-10).join(''));
    process.exit(1);
  }
  console.log(`[env] 服务器 http://127.0.0.1:${SERVER_PORT}/（DRAWINMAP_CITY_TEST_HOOKS=1）`);
  const runStartedAt = new Date().toISOString();

  // ===== 浏览器（启动段统一走 tools/lib/cdp-driver.mjs 的 launchBrowser） =====
  const profileDir = path.join(os.tmpdir(), `drawinmap-e2e-city-${Date.now()}`);
  const results = { startedAt: runStartedAt, cases: [] };
  let launched = null;
  let cdp = null;
  try {
    launched = await launchBrowser({
      browserPath,
      port: CDP_PORT,
      userDataDir: profileDir,
      windowSize: { width: 1440, height: 900 },
      openPage: true,
    });
    // 超时默认值沿用本驱动旧实现（240s：城市获取 + 真实模型画图单轮可能很长）
    cdp = new Cdp(launched.wsUrl, { artifactDir: ARTIFACT_DIR, timeoutMs: 240000 });
    await cdp.open();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${SERVER_PORT}/` });
    const ready = await cdp.waitFor(
      `document.getElementById('city-btn-label')?.textContent === '广州'`,
      30000,
      '应用启动（默认广州）',
    );
    check('前置：打开页面默认城市为广州', ready, await cdp.evaluate(`document.getElementById('city-btn-label')?.textContent`));
    // 打开智能体面板（对话与截图需要）
    await cdp.evaluate(`(() => { const panel = document.getElementById('agent-panel'); if (panel?.hidden) document.getElementById('agent-btn')?.click(); })()`);
    await sleep(500);

    /** 页面观测助手（与既有 e2e 工具同一套观测点） */
    const cityBtnLabel = () => cdp.evaluate(`document.getElementById('city-btn-label')?.textContent`);
    const lastAgentText = () => cdp.evaluate(`(() => {
      const list = document.querySelectorAll('.agent-msg-agent .agent-msg-text');
      return list.length ? list[list.length - 1].textContent : '';
    })()`);
    const lastTraceId = () => cdp.evaluate(`(() => {
      const list = document.querySelectorAll('.agent-trace-copy');
      return list.length ? list[list.length - 1].textContent.trim() : null;
    })()`);
    const sendText = (text) => cdp.evaluate(`(() => {
      const input = document.getElementById('agent-input');
      input.value = ${JSON.stringify(text)};
      document.getElementById('agent-send').click();
      return true;
    })()`);
    const waitTurn = async (timeoutMs, label) => {
      // 两段式：先确认轮次开始（按钮变"停止"，避免极快完成误判），再等轮次结束（变回"发送"）
      await cdp.waitFor(
        `document.getElementById('agent-send') && document.getElementById('agent-send').textContent.trim() === '停止'`,
        15000,
        `${label} 轮次开始`,
      );
      return cdp.waitFor(
        `document.getElementById('agent-send') && document.getElementById('agent-send').textContent.trim() === '发送'`,
        timeoutMs,
        `${label} 轮次完成`,
      );
    };
    /** 当前会话最新图形的几何点（[lat, lng]；来自会话存储落盘） */
    const latestShapePoints = () => cdp.evaluate(`(() => {
      const raw = localStorage.getItem('drawinmap.sessions.v1');
      if (!raw) return null;
      const state = JSON.parse(raw);
      const session = state.sessions.find((item) => item.id === state.activeId) || null;
      const shape = session?.shapes ? session.shapes[session.shapes.length - 1] : null;
      if (!shape?.geometry) return null;
      return {
        cityId: shape.cityId ?? null,
        shapeName: shape.shapeName ?? null,
        points: [...(shape.geometry.route ?? []), ...(shape.geometry.outline ?? [])],
      };
    })()`);
    /** 范围断言容差：路网数据边缘的路段会跨越裁剪 bbox（道路是连续折线），
     *  个别路线点可能落在 bbox 外几十~几百米；0.003° ≈ 330m 吸附带，不算出界 */
    const BBOX_TOLERANCE = 0.003;
    const pointsInBbox = (points, bbox) =>
      Array.isArray(points)
        && points.length > 0
        && points.every(([lat, lng]) => lat >= bbox.minLat - BBOX_TOLERANCE && lat <= bbox.maxLat + BBOX_TOLERANCE && lng >= bbox.minLng - BBOX_TOLERANCE && lng <= bbox.maxLng + BBOX_TOLERANCE);
    const pointsOverlapBbox = (points, bbox) =>
      Array.isArray(points)
        && points.some(([lat, lng]) => lat >= bbox.minLat - BBOX_TOLERANCE && lat <= bbox.maxLat + BBOX_TOLERANCE && lng >= bbox.minLng - BBOX_TOLERANCE && lng <= bbox.maxLng + BBOX_TOLERANCE);
    const openCityPanel = () => cdp.evaluate(`(() => { const panel = document.getElementById('city-panel'); if (panel?.hidden) document.getElementById('city-btn')?.click(); })()`);
    const closeCityPanel = () => cdp.evaluate(`document.getElementById('city-close')?.click()`);
    const clickCityRow = (cityId) => cdp.evaluate(`(() => { document.querySelector('.city-row[data-city-id="${cityId}"]')?.click(); })()`);
    const cityRowStatus = (cityId) => cdp.evaluate(`(() => document.querySelector('.city-row[data-city-id="${cityId}"] .city-status')?.textContent ?? null)()`);
    const retryCity = (cityId) => cdp.evaluate(`(() => {
      const row = document.querySelector('.city-row[data-city-id="${cityId}"]');
      const retry = row?.querySelector('.city-retry');
      (retry ?? row)?.click();
    })()`);

    /** 等某城缓存落盘（真实获取完成） */
    async function waitCityReady(cityId, timeoutMs, label) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        const cache = await serverCache();
        const hit = cache.find((item) => item.cityId === cityId);
        if (hit) {
          return hit;
        }
        await sleep(2000);
      }
      console.log(`[wait] ${label} 超时`);
      return null;
    }

    /** 画图轮通用断言（回复 + traceId + 地图截图） */
    async function drawAndAssert(caseId, inputText, { expectedBbox, forbiddenBbox = null, expectedShapeName = null, shotName, cityLabelForLog }) {
      await sendText(inputText);
      const turnDone = await waitTurn(300000, `${caseId} 一轮完成（真实 LLM）`);
      check(`${caseId}：真实模型返回回复`, turnDone);
      const reply = await lastAgentText();
      console.log(`[${caseId}] reply=${reply.slice(0, 100).replace(/\n/g, ' / ')}`);
      check(`${caseId}：回复非空`, reply.trim().length > 0, reply.slice(0, 80));
      await sleep(3000); // 等绘制/聚焦/存储落盘
      await cdp.screenshot(shotName);
      const traceId = await lastTraceId();
      check(`${caseId}：取得画图轮 traceId`, Boolean(traceId), String(traceId));
      const shape = await latestShapePoints();
      if (expectedBbox) {
        check(
          `${caseId}：路线落在${cityLabelForLog}范围（${expectedBbox.minLat}–${expectedBbox.maxLat}N, ${expectedBbox.minLng}–${expectedBbox.maxLng}E）`,
          pointsInBbox(shape?.points, expectedBbox),
          `points=${shape?.points?.length ?? 0} cityId=${shape?.cityId ?? 'null'}`,
        );
      }
      if (forbiddenBbox) {
        check(
          `${caseId}：路线不落在禁区（广州核心区 23.06–23.17N, 113.22–113.36E）`,
          shape?.points ? !pointsOverlapBbox(shape.points, forbiddenBbox) : false,
          `points=${shape?.points?.length ?? 0}`,
        );
      }
      if (expectedShapeName) {
        check(`${caseId}：快照 shapeName=${expectedShapeName}`, shape?.shapeName === expectedShapeName, String(shape?.shapeName));
      }
      return { traceId, shape, reply };
    }

    // ===== E2E-01 默认广州直画（R1） =====
    {
      const jobsAtStart = await serverJobs();
      check('E2E-01：页面打开后没有任何城市获取作业', jobsAtStart.length === 0, JSON.stringify(jobsAtStart));
      const cacheAtStart = await serverCache();
      check('E2E-01：页面打开后缓存目录没有任何城市路网（也不为广州下载）', cacheAtStart.length === 0, JSON.stringify(cacheAtStart));
      const { traceId } = await drawAndAssert('E2E-01', '在广州画个五角星', {
        expectedBbox: GZ_CORE,
        expectedShapeName: '五角星',
        shotName: 'E2E-01-广州-五角星.png',
        cityLabelForLog: '广州核心区',
      });
      results.cases.push({ id: 'E2E-01', traceId });
    }

    // ===== E2E-02/03/04 深圳/北京/成都 =====
    for (let index = 0; index < CASE_CITIES.length; index += 1) {
      const cityCase = CASE_CITIES[index];
      const caseId = `E2E-0${index + 2}`;
      await openCityPanel();
      await cdp.waitFor(`!document.getElementById('city-panel').hidden`, 5000, `${caseId} 城市面板打开`);
      const rowCount = await cdp.evaluate(`document.querySelectorAll('.city-row').length`);
      check(`${caseId}：城市面板渲染全国城市（≥297 行）`, rowCount >= 297, String(rowCount));

      // 选择城市 → 出现获取中状态（获取过程可见），当前城市不变
      await clickCityRow(cityCase.id);
      const sawFetching = await cdp.waitFor(
        `(() => {
          const s = document.querySelector('.city-row[data-city-id="${cityCase.id}"] .city-status')?.textContent ?? '';
          return s.includes('正在获取') || s.includes('排队') || s.includes('获取');
        })()`,
        20000,
        `${caseId} 出现获取中状态`,
      );
      check(`${caseId}：获取过程可见（状态徽标出现"正在获取/排队"）`, sawFetching, await cityRowStatus(cityCase.id));
      await cdp.screenshot(`${caseId}-${cityCase.label}-获取中.png`);
      check(`${caseId}：获取完成前当前城市仍是切换前的城市`, (await cityBtnLabel()) !== cityCase.label, await cityBtnLabel());

      const cacheHit = await waitCityReady(cityCase.id, 20 * 60_000, `${caseId} ${cityCase.label} 获取完成`);
      check(`${caseId}：${cityCase.label}路网获取完成（缓存落盘）`, Boolean(cacheHit), JSON.stringify(cacheHit));
      check(
        `${caseId}：缓存 generated_at 在当次验收开跑之后（真实下载证据）`,
        Boolean(cacheHit?.generatedAt && cacheHit.generatedAt > runStartedAt),
        `${cacheHit?.generatedAt} vs ${runStartedAt}`,
      );

      // 完成后自动进入新城（R2"完成后，地图进入该城市"）
      const entered = await cdp.waitFor(`document.getElementById('city-btn-label')?.textContent === '${cityCase.label}'`, 30000, `${caseId} 进入${cityCase.label}`);
      check(`${caseId}：完成后地图进入${cityCase.label}`, entered, await cityBtnLabel());
      await closeCityPanel();

      const { traceId } = await drawAndAssert(caseId, cityCase.input, {
        expectedBbox: cityCase.bbox,
        forbiddenBbox: GZ_CORE,
        shotName: `${caseId}-${cityCase.label}-${cityCase.shape}.png`,
        cityLabelForLog: cityCase.label,
      });
      results.cases.push({ id: caseId, city: cityCase.id, traceId, generatedAt: cacheHit?.generatedAt ?? null });
    }

    // ===== E2E-05 再选深圳（零获取，直接可画；R3） =====
    {
      const cacheBefore = await serverCache();
      const szGeneratedAt = cacheBefore.find((item) => item.cityId === 'shenzhen')?.generatedAt ?? null;
      await openCityPanel();
      // 当前在成都（上一例结束城市）：先切回广州，再"再次选择深圳"
      await clickCityRow('guangzhou');
      const backGz = await cdp.waitFor(`document.getElementById('city-btn-label')?.textContent === '广州'`, 30000, 'E2E-05 切回广州');
      check('E2E-05：切回广州（预备步骤）', backGz, await cityBtnLabel());
      await clickCityRow('shenzhen');
      const entered = await cdp.waitFor(`document.getElementById('city-btn-label')?.textContent === '深圳'`, 30000, 'E2E-05 再次进入深圳');
      check('E2E-05：再次选择深圳直接进入（不等待获取）', entered, await cityBtnLabel());

      // 零新获取：generated_at 未变、无新增未完成作业
      await sleep(2000);
      const cacheAfter = await serverCache();
      const jobsAfter = await serverJobs();
      const szGeneratedAtAfter = cacheAfter.find((item) => item.cityId === 'shenzhen')?.generatedAt ?? null;
      check('E2E-05：不再向数据源重新获取（generated_at 未变）', Boolean(szGeneratedAt) && szGeneratedAt === szGeneratedAtAfter, `${szGeneratedAt} → ${szGeneratedAtAfter}`);
      check('E2E-05：没有深圳的新获取作业', !jobsAfter.some((job) => job.cityId === 'shenzhen' && (job.status === 'queued' || job.status === 'running')), JSON.stringify(jobsAfter));
      await closeCityPanel();

      const { traceId } = await drawAndAssert('E2E-05', '在深圳画个五角星', {
        expectedBbox: CASE_CITIES[0].bbox,
        forbiddenBbox: GZ_CORE,
        shotName: 'E2E-05-深圳-五角星-再次.png',
        cityLabelForLog: '深圳',
      });
      results.cases.push({ id: 'E2E-05', traceId });
    }

    // ===== E2E-06 失败与重试（韶关，未缓存；当前在切换前城市=深圳） =====
    {
      const cityBefore = await cityBtnLabel();
      await openCityPanel();
      await setSourceBlock(true);
      await clickCityRow(FAILURE_CASE_CITY.id);
      const sawFailed = await cdp.waitFor(
        `(() => (document.querySelector('.city-row[data-city-id="${FAILURE_CASE_CITY.id}"] .city-status')?.textContent ?? '').includes('获取失败'))`,
        180000,
        'E2E-06 出现获取失败状态',
      );
      check('E2E-06：获取失败在界面可见（状态徽标"获取失败·可重试"）', sawFailed, await cityRowStatus(FAILURE_CASE_CITY.id));
      await cdp.screenshot('E2E-06-韶关-获取失败.png');
      check(
        'E2E-06：失败后当前城市仍是切换前的城市（不切换、不出错城出图）',
        (await cityBtnLabel()) === cityBefore,
        `${await cityBtnLabel()}（切换前=${cityBefore}）`,
      );
      check('E2E-06：失败后韶关没有缓存（该城不可用）', !(await serverCache()).some((item) => item.cityId === FAILURE_CASE_CITY.id), JSON.stringify(await serverCache()));

      // 点名失败城市：诚实回复（等待/失败/引导），不画线
      await closeCityPanel();
      await sendText(FAILURE_CASE_CITY.input);
      await waitTurn(300000, 'E2E-06 点名失败城市的回复');
      const mentionReply = await lastAgentText();
      check('E2E-06：点名失败城市得到诚实回复（失败说明+可重试指引）', /失败|重试|城市面板/.test(mentionReply), mentionReply.slice(0, 160));
      const noForeignRoute = await cdp.evaluate(`(() => {
        const raw = localStorage.getItem('drawinmap.sessions.v1');
        if (!raw) return true;
        const state = JSON.parse(raw);
        const session = state.sessions.find((item) => item.id === state.activeId) || null;
        const shape = session?.shapes ? session.shapes[session.shapes.length - 1] : null;
        if (!shape?.geometry) return true;
        const pts = [...(shape.geometry.route ?? []), ...(shape.geometry.outline ?? [])];
        // 最新图形不落在韶关 bbox（点名未画出——失败城市不出图）
        return !pts.some(([lat, lng]) => lat >= ${FAILURE_CASE_CITY.bbox.minLat} && lat <= ${FAILURE_CASE_CITY.bbox.maxLat} && lng >= ${FAILURE_CASE_CITY.bbox.minLng} && lng <= ${FAILURE_CASE_CITY.bbox.maxLng});
      })()`);
      check('E2E-06：失败期间韶关没有路线（不画线）', noForeignRoute === true, JSON.stringify(noForeignRoute));

      // 关闭开关 → 面板重试 → 成功后画图
      await setSourceBlock(false);
      await openCityPanel();
      await retryCity(FAILURE_CASE_CITY.id);
      const cacheHit = await waitCityReady(FAILURE_CASE_CITY.id, 20 * 60_000, 'E2E-06 重试获取完成');
      check('E2E-06：重试后获取成功（缓存落盘）', Boolean(cacheHit), JSON.stringify(cacheHit));
      check(
        'E2E-06：重试获取 generated_at 在当次验收开跑之后（真实下载证据）',
        Boolean(cacheHit?.generatedAt && cacheHit.generatedAt > runStartedAt),
        `${cacheHit?.generatedAt} vs ${runStartedAt}`,
      );
      const entered = await cdp.waitFor(`document.getElementById('city-btn-label')?.textContent === '${FAILURE_CASE_CITY.label}'`, 30000, 'E2E-06 重试成功后进入韶关');
      check('E2E-06：重试成功后地图进入韶关', entered, await cityBtnLabel());
      await closeCityPanel();

      const { traceId } = await drawAndAssert('E2E-06', FAILURE_CASE_CITY.input, {
        expectedBbox: FAILURE_CASE_CITY.bbox,
        shotName: 'E2E-06-韶关-五角星-重试成功.png',
        cityLabelForLog: '韶关',
      });
      results.cases.push({ id: 'E2E-06', city: FAILURE_CASE_CITY.id, traceId, generatedAt: cacheHit?.generatedAt ?? null });
    }

    // ===== 服务器日志留证 =====
    const logTail = serverLog.join('').split('\n').slice(-80).join('\n');
    await writeFile(path.join(ARTIFACT_DIR, 'server-log-tail.log'), logTail, 'utf8');
  } finally {
    // 公共 Cdp.close 会清掉在途调用的超时定时器并 reject 未决 Promise（D4）
    cdp?.close();
    launched?.kill();
    if (!KEEP_SERVER) {
      server.kill();
    }
  }

  // ===== 汇总 =====
  const failed = checks.filter((item) => !item.ok);
  results.checks = checks;
  results.finishedAt = new Date().toISOString();
  const resultFile = path.join(ARTIFACT_DIR, 'result-city-on-demand.json');
  await writeFile(resultFile, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
  console.log('\n===== E2E 汇总 =====');
  console.log(`断言 ${checks.length - failed.length}/${checks.length} 通过`);
  if (failed.length > 0) {
    console.log('失败断言：');
    for (const item of failed) {
      console.log(`  - ${item.label}: ${item.detail}`);
    }
  }
  console.log(`结果：${resultFile}`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('E2E-FAIL:', error);
  process.exit(1);
});
