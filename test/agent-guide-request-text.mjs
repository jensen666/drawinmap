/**
 * 引导轮次的质检 userText 回归（缺陷清单 2026-11-06 Bug 2）。
 *
 * 缺陷：引导补地点轮次里，"引导回答"（如「就在当前视野中心画」）被当成"用户原文"
 * 送进目标轮廓视觉质检——质检在错误语境下判定（误杀/误放/越修越偏）。
 * 真实取证：trace t-w7l2rj5ybrx（原始请求「在广州生成中国地图」）、t-x6hqxn183oiw
 * （「生成一个小猪佩奇」），2/2 命中，共 8 次 LLM 请求带着错误 userText。
 *
 * 本文件锁住两条链路的修复：
 * A. 地点未解析 → 追问 → 回答"当前视野中心"（askUnresolvedPlace 重建引导状态
 *    必须保留 sourceText；此前这条链路 100% 丢失原始请求）；
 * B. 正常引导补地点（首轮缺地点 → 引导 → 选项补齐）——resolveTarget 的质检
 *    userText 必须是原始请求（requestText 贯穿 executeIntent/executePlan）。
 *
 * 断言口径（清单 2.6）：shape.review 请求里「用户想画：…」必须等于原始用户请求，
 * 而不是引导回答；用户主动选择视野中心时，userText 需带补充说明（2.5.4）。
 *
 * 运行：node test/agent-guide-request-text.mjs
 */

import { createAgentController } from '../web/src/agent/controller.js';
import { normalizeCustomShape } from '../web/src/agent/intent.js';
import { initLogging } from '../web/src/log/index.js';
import { placeConfig } from './fixtures/place-config.mjs';

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

initLogging({ server: false, storage: false, level: 'error' });

// ---------- 夹具 ----------

/** 中国地图式的自由轮廓（20 点闭环，LLM 生成目标） */
function chinaLikeShape() {
  const points = Array.from({ length: 20 }, (_, i) => {
    const t = (Math.PI * 2 * i) / 20;
    return [Math.cos(t) * 0.4, Math.sin(t) * 0.4];
  });
  return normalizeCustomShape({ name: '中国地图', points });
}

/** 意图队列与质检请求捕获（mock globalThis.fetch） */
let intentQueue = [];
/** 捕获的视觉质检请求（user 文本内容） */
const reviewUserTexts = [];

globalThis.fetch = async (url, options = {}) => {
  const href = String(url);
  if (href.includes('/data/guangzhou-roads.json')) {
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ roads: [] }) };
  }
  const messages = JSON.parse(options.body || '{}')?.messages ?? [];
  const system = messages[0]?.content || '';
  if (system.includes('质检员')) {
    const userContent = messages.find((message) => message.role === 'user')?.content ?? '';
    const text = Array.isArray(userContent)
      ? userContent.filter((part) => part?.type === 'text').map((part) => part.text).join('\n')
      : String(userContent ?? '');
    reviewUserTexts.push(text);
    return llmResponse({ verdict: 'like', seen: '中国地图', issues: [] });
  }
  if (system.includes('DrawInMap')) {
    return llmResponse(intentQueue.shift() ?? { action: 'chat', reply: '收到' });
  }
  return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) };
};

function llmResponse(payload) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({
      id: 'mock',
      model: 'mock',
      choices: [{ message: { content: JSON.stringify(payload) }, finish_reason: 'stop' }],
      usage: {},
    }),
  };
}

const map = { getCenter: () => ({ lat: 23.12, lng: 113.32 }) };

/** 可控参考源：本地/在线都 miss（让自由轮廓一路成为唯一候选来源） */
const referenceSource = {
  async resolveLocalCandidates() {
    return { status: 'miss', origin: 'local', candidates: [], failures: [], poolSize: 0, attempts: [], error: null };
  },
  async resolveOnlineCandidates() {
    return { status: 'miss', origin: 'online', candidates: [], failures: [], poolSize: 0, attempts: [] };
  },
  async resolveCandidates() {
    return { status: 'miss', origin: 'local', candidates: [], failures: [], poolSize: 0, attempts: [] };
  },
};

/** 旧串行链路的参考源（无 resolveOnlineCandidates → 三路不适用，走 resolveTarget +
 * executePlan 原路径——真实 trace t-w7l2rj5ybrx 的出错路径） */
const serialReferenceSource = {
  async resolveCandidates() {
    return { status: 'miss', origin: 'local', candidates: [], failures: [], poolSize: 0, attempts: [] };
  },
};

function makeEngine() {
  return {
    plan: async () => ({ status: 'failed', best: null, stage: 1, stageLabel: '近场', triedCount: 1 }),
    recommend: async () => ({ status: 'failed' }),
    commitDraw: () => null,
    clearDraw: () => {},
    formatMinutes: (minutes) => `${Math.round(minutes)} 分钟`,
    getPlaceContext: async () => null,
  };
}

function makeController({ serial = false } = {}) {
  reviewUserTexts.length = 0;
  return createAgentController({
    map,
    engine: makeEngine(),
    placeConfig,
    referenceSource: serial ? serialReferenceSource : referenceSource,
    shapeReviewDeps: { renderOutline: () => 'data:image/png;base64,FAKE' },
  });
}

// ---------- 场景 A：地点未解析 → 追问 → 回答"当前视野中心"（旧串行链路） ----------

{
  const controller = makeController({ serial: true });
  const ORIGINAL = '在仙女星生成中国地图';
  intentQueue = [
    { action: 'plan', shape: null, customShape: { name: '中国地图', points: chinaLikeShape().outlinePoints }, place: '仙女星', reply: '好的，画中国地图。' },
    // 引导轮的 LLM 重解析（fillFromOption 消费选项时不会走 LLM，这里备用）
    { action: 'plan', shape: null, customShape: { name: '中国地图', points: chinaLikeShape().outlinePoints }, place: null, reply: '好的，画中国地图。' },
  ];
  const first = await controller.send({ text: ORIGINAL });
  check('A 首轮：地点未解析触发追问', Boolean(first.guide?.options?.length), JSON.stringify(first.guide ?? null));

  // 第二轮：引导回答"就在当前视野中心画"——此前这条回答会被当成质检 userText
  const second = await controller.send({ text: '就在当前视野中心画' });
  check('A 二轮：不再追问（引导补齐后执行）', !second.guide, JSON.stringify({ guide: second.guide ?? null, reply: second.reply?.slice(0, 80) }));

  // 二轮的质检调用是第 2 次（首轮在地点追问前已完成一次质检）
  check('A 二轮：视觉质检被再次调用', reviewUserTexts.length >= 2, `调用 ${reviewUserTexts.length} 次`);
  const qcText = reviewUserTexts[reviewUserTexts.length - 1] ?? '';
  check(
    'A 二轮：质检 userText = 原始请求（不是引导回答）',
    qcText.includes(ORIGINAL) && !qcText.includes('用户想画：就在当前视野中心画'),
    qcText.slice(0, 120),
  );
  check(
    'A 二轮：用户主动选视野中心时补充说明（2.5.4）',
    qcText.includes('当前视野中心'),
    qcText.slice(0, 160),
  );
}

// ---------- 场景 B：正常引导补地点（首轮缺地点） ----------

{
  const controller = makeController();
  const ORIGINAL = '生成一个中国地图';
  intentQueue = [
    { action: 'plan', shape: null, customShape: { name: '中国地图', points: chinaLikeShape().outlinePoints }, place: null, reply: '好的，画中国地图。' },
  ];
  const first = await controller.send({ text: ORIGINAL });
  check('B 首轮：缺地点给出引导', Boolean(first.guide?.options?.length), JSON.stringify(first.guide ?? null));

  // 第二轮：点选地点选项（本地状态机补齐，不走 LLM 重解析）
  const poiLabel = placeConfig.activeCity.pois[0].name;
  const second = await controller.send({ text: poiLabel });
  check('B 二轮：补地点后执行（不再追问）', !second.guide, JSON.stringify({ guide: second.guide ?? null, reply: second.reply?.slice(0, 80) }));

  check('B 二轮：视觉质检被调用', reviewUserTexts.length >= 1, `调用 ${reviewUserTexts.length} 次`);
  const qcText = reviewUserTexts[0] ?? '';
  check(
    'B 二轮：质检 userText = 原始请求（不是地点选项文本）',
    qcText.includes(ORIGINAL) && !qcText.startsWith('用户想画：广州塔'),
    qcText.slice(0, 120),
  );
  check(
    'B 二轮：地点由用户正常补齐时不附加"视野中心"说明',
    !qcText.includes('无需再确认地点'),
    qcText.slice(0, 160),
  );
}

console.log(failures === 0 ? `RESULT: PASS (${checks} checks)` : `RESULT: FAIL (${failures}/${checks} checks)`);
process.exit(failures === 0 ? 0 : 2);
