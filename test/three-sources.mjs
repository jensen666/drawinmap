/**
 * 三种轮廓同一轮（方案 2026-11-01 §2）与自由轮廓质量闸门（§3）的能力验证。
 *
 * 覆盖 §5.1「三路终态 / 不像不入场 / 点数 / 修正次数」与 §5.2 点选前后的关键约束：
 * - 三路终态四种分支：本地唯一+在线失败+自由轮廓失败 → 直接规划；本地+在线 → 出卡；
 *   本地+自由轮廓通过 → 出卡；三路都失败 → 无卡、无规划、回复「没有可用轮廓」；
 * - 卡片随结果到达追加，不等最慢一路（出卡时剩余路后台继续，追加到快照）；
 * - 点选前引擎调用次数为 0；点选后立刻取消未返回路；
 * - 自由轮廓只有质检通过（含单次修正与复检）那一版进卡；不像/修正失败/复检不像 → 不入场；
 * - 复杂剪影（features ≥ 3）分级放行：79 点 + 质检 like 进卡、59 点硬拒、80 达标接受；简单图形 8~20 接受；
 * - 修正请求只发一次（retries=0：可重试错误也只调用一次 fetch）。
 *
 * 不发真实模型请求、不打开浏览器、不走路网：参考源、渲染器、引擎全部注入 fake，
 * chat/completions 由本地 fetch mock 响应（与页面同一条 controller 链路）。
 *
 * 运行：node test/three-sources.mjs
 */

import { createAgentController } from '../web/src/agent/controller.js';
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

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 圆环点列（n 点；无凹口时 features 检测为 0） */
function circlePoints(n, radius = 0.4) {
  return Array.from({ length: n }, (_, index) => {
    const angle = (2 * Math.PI * index) / n;
    return [Math.sin(angle) * radius, Math.cos(angle) * radius];
  });
}

const placeConfig = {
  version: 1,
  activeCityId: 'test-city',
  matching: { unresolvedPlace: 'ask' },
  activeCity: {
    id: 'test-city',
    label: '测试城',
    names: ['测试城'],
    title: '测试城',
    subtitle: '',
    mapAriaLabel: '地图',
    view: { center: { lat: 23.12, lng: 113.32 }, zoom: 12 },
    coverage: {
      description: '测试范围',
      hint: '换地点',
      bbox: { minLat: 22.9, maxLat: 23.4, minLng: 113.0, maxLng: 113.6 },
    },
    examples: ['画个五角星'],
    roads: { dataUrl: '/data/guangzhou-roads.json' },
    pois: [{ name: '广州塔', lat: 23.1066, lng: 113.3246 }],
    districts: [],
    aliases: [],
  },
};

// ---------------------------------------------------------------------------
// LLM fetch mock：按 system 提示识别请求类型（意图解析 / 视觉质检 / 修正生成）
// ---------------------------------------------------------------------------

const llm = {
  intent: null,
  /** 质检与复检结论队列（like/unlike/unknown），按调用顺序消费 */
  verdicts: [],
  /** 修正响应队列：{ json } | { http: 500 } | { abort: true } */
  revisions: [],
  /** 质检响应闸门（存在时质检请求等待该 promise 再返回；用于控制到达时序） */
  verdictGate: null,
  calls: { intent: 0, verdict: 0, revision: 0 },
};

function resetLlm({ intent = null, verdicts = [], revisions = [], verdictGate = null } = {}) {
  llm.intent = intent;
  llm.verdicts = [...verdicts];
  llm.revisions = [...revisions];
  llm.verdictGate = verdictGate;
  llm.calls = { intent: 0, verdict: 0, revision: 0 };
}

function jsonResponse(content) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({
      id: 'mock',
      model: 'mock',
      choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }],
      usage: {},
    }),
    text: async () => '',
  };
}

globalThis.fetch = async (url, options = {}) => {
  const href = String(url);
  if (href.includes('/chat/completions')) {
    const body = JSON.parse(options.body || '{}');
    const messages = body.messages || [];
    const system = typeof messages[0]?.content === 'string' ? messages[0].content : '';
    if (system.includes('图形路线规划助手')) {
      llm.calls.intent += 1;
      return jsonResponse(llm.intent || { action: 'chat', reply: '收到' });
    }
    if (system.includes('目标轮廓质检员')) {
      llm.calls.verdict += 1;
      if (llm.verdictGate) {
        await llm.verdictGate.promise;
      }
      const verdict = llm.verdicts.shift() ?? 'unlike';
      return jsonResponse({
        verdict,
        seen: '一只动物',
        issues: verdict === 'unlike' ? ['四条腿呈方波'] : [],
      });
    }
    if (system.includes('你为 DrawInMap 生成')) {
      llm.calls.revision += 1;
      const next = llm.revisions.shift() ?? { http: 500 };
      if (next.abort) {
        const error = new Error('模拟修正请求超时中断');
        error.name = 'AbortError';
        throw error;
      }
      if (next.http) {
        return {
          ok: false,
          status: next.http,
          headers: { get: () => null },
          text: async () => 'mock failure',
        };
      }
      return jsonResponse(next.json);
    }
    return jsonResponse({});
  }
  if (href.includes('/data/guangzhou-roads.json')) {
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ roads: [] }) };
  }
  return { ok: false, status: 404, text: async () => '' };
};

// ---------------------------------------------------------------------------
// 注入替身：参考源（本地/在线独立入口）、渲染器、引擎
// ---------------------------------------------------------------------------

function makeLocalCandidate({ id = 'swan', name = '天鹅', alias = '天鹅', points = 24 } = {}) {
  const sha = 'a'.repeat(64);
  const customShape = normalizeCustomShape({ name, points: circlePoints(points) });
  return {
    asset: {
      id,
      displayName: name,
      names: { zh: [name], en: [] },
      source: { name: 'PhyloPic', license: 'CC0-1.0', url: 'https://example.com/swan', attribution: 'Tester' },
      tags: [],
      review: { status: 'approved', visual: 'like', reviewedAt: '2026-11-01', sha256: sha },
    },
    customShape,
    conversion: { status: 'accepted', T: { points: customShape.outlinePoints }, metrics: null },
    matchedAlias: alias,
    origin: 'local',
    reviewStatus: 'curated',
    sourceSha256: sha,
    contentHash: 'b'.repeat(64),
  };
}

function makeOnlineCandidate({ id = 'oc-swan', name = '天鹅', points = 24 } = {}) {
  const customShape = normalizeCustomShape({ name, points: circlePoints(points) });
  return {
    asset: {
      id,
      displayName: name,
      names: { zh: [name], en: [] },
      source: { name: 'PhyloPic', license: 'CC0-1.0', url: 'https://example.com/oc-swan', attribution: 'Tester' },
      tags: [],
      review: null,
    },
    customShape,
    conversion: { status: 'accepted', T: { points: customShape.outlinePoints }, metrics: null },
    matchedAlias: null,
    origin: 'online',
    reviewStatus: 'unreviewed',
    sourceSha256: 'c'.repeat(64),
    contentHash: 'd'.repeat(64),
  };
}

const okResult = (origin, candidates) => ({ status: 'ok', origin, candidates, failures: [], poolSize: candidates.length, attempts: [] });
const missResult = (origin) => ({ status: 'miss', origin, candidates: [], failures: [], poolSize: 0, attempts: [] });

/**
 * 三路参考源（生产默认源的新接口：本地/在线独立入口）。
 * 每个入口可以是值、函数（可读 options.signal，用于断言"点选取消真的中止了未返回路"）
 * 或 deferred 结果；返回 Promise 时 controller 按到达顺序追加。
 */
function makeThreeSource({ local = missResult('local'), online = missResult('online') } = {}) {
  const calls = { local: 0, online: 0 };
  return {
    calls,
    async resolveLocalCandidates(text, options = {}) {
      calls.local += 1;
      return typeof local === 'function' ? await local(options) : local;
    },
    async resolveOnlineCandidates(text, options = {}) {
      calls.online += 1;
      return typeof online === 'function' ? await online(options) : online;
    },
  };
}

function makePlanned({ score = 85 } = {}) {
  const result = {
    shapeName: '天鹅',
    routeLatLngs: [[23.12, 113.32], [23.121, 113.321]],
    outlineLatLngs: [[23.12, 113.32], [23.121, 113.321]],
    metrics: {
      routeMeters: 1000,
      walkMinutes: 15,
      detourRatio: 1.2,
      coverage: 100,
      failedLegs: 0,
      snapMaxMeters: 20,
      keyCoverage: 1,
      collapsedKeyCount: 0,
      keyMaxOffsetRatio: 0.01,
      orderedOutlineMeanMeters: 20,
      orderedOutlineMaxMeters: 40,
      outlineMeanMeters: 20,
      outlineMaxMeters: 40,
    },
  };
  return {
    status: 'ok',
    result,
    best: { result, score, adjustedScore: score, sizeMeters: 1200, rotationDeg: 0, center: { lat: 23.12, lng: 113.32 } },
    offset: { meters: 0, text: '' },
    stage: 1,
    stageLabel: '近场搜索',
    triedCount: 100,
  };
}

function makeEngine() {
  const calls = [];
  return {
    calls,
    planCalls: () => calls.filter((call) => call.type === 'plan'),
    commitCalls: () => calls.filter((call) => call.type === 'commitDraw'),
    plan: async (options) => {
      calls.push({ type: 'plan', options });
      return makePlanned();
    },
    recommend: async () => makePlanned(),
    commitDraw: (result, options) => calls.push({ type: 'commitDraw', result, options }),
    clearDraw: () => calls.push({ type: 'clearDraw' }),
    formatMinutes: (minutes) => `${Math.round(minutes)} 分钟`,
  };
}

function makeController({ source, engine = makeEngine(), textPlace = '广州塔' } = {}) {
  return createAgentController({
    map: {},
    engine,
    placeConfig,
    referenceSource: source,
    shapeReviewDeps: { renderOutline: () => 'data:image/png;base64,FAKE' },
  });
}

/** 意图：自由轮廓（LLM 生成的天鹅点列） */
function swanIntent({ points = 84, featureCount = 0, place = '广州塔', name = '天鹅' } = {}) {
  const declaredFeatures = Array.from({ length: featureCount }, (_, index) => ({
    name: `特征${index + 1}`,
    points: [circlePoints(points)[index]],
  }));
  return {
    action: 'plan',
    shape: null,
    customShape: {
      name,
      ...(declaredFeatures.length ? { features: declaredFeatures } : {}),
      points: circlePoints(points),
    },
    place,
    rotationDeg: null,
    reply: `画一只${name}`,
  };
}

const toPunctuationFree = (text) => String(text ?? '').replace(/[，。！？、,.!?\s]/g, '');

// ===========================================================================
// 场景 1：三路终态分支
// ===========================================================================
console.log('\n=== 场景 1：三路终态 ===');

// 1a. 唯一本地整词 + 在线失败 + 自由轮廓失败 → 直接规划（不弹卡）
{
  resetLlm({ intent: swanIntent(), verdicts: ['unlike'], revisions: [{ http: 500 }] });
  const localCandidate = makeLocalCandidate();
  const source = makeThreeSource({ local: okResult('local', [localCandidate]), online: missResult('online') });
  const engine = makeEngine();
  const controller = makeController({ source, engine });
  const result = await controller.send({ text: '在广场画一只天鹅' });
  const planCall = engine.planCalls()[0];
  check('1a 唯一本地整词且其余两路失败：直接规划（不弹卡）', !result.referenceChoice && result.planned?.status === 'ok');
  check('1a 引擎只调用一次 plan', engine.planCalls().length === 1, String(engine.planCalls().length));
  check(
    '1a 规划 T 是本地素材版本，contentHash 与候选一致',
    planCall?.options?.customShape?.name === '天鹅' && planCall?.options?.customShape?.contentHash === localCandidate.contentHash,
  );
  check('1a 自由轮廓失败：修正只请求一次（HTTP 500 不重试）', llm.calls.revision === 1, String(llm.calls.revision));
  check('1a 自由轮廓失败：没有产出自由轮廓候选', !controller.exportContext().referenceChoice);
}

// 1b. 唯一本地 + 在线候选 → 出卡（点选前 0 次引擎调用）
{
  resetLlm({ intent: swanIntent(), verdicts: ['unlike'], revisions: [{ http: 500 }] });
  const localCandidate = makeLocalCandidate();
  const onlineCandidate = makeOnlineCandidate();
  const source = makeThreeSource({ local: okResult('local', [localCandidate]), online: okResult('online', [onlineCandidate]) });
  const engine = makeEngine();
  const controller = makeController({ source, engine });
  const sent = await controller.send({ text: '在广场画一只天鹅' });
  check('1b 有在线候选：返回待选而不是直接规划', Boolean(sent.referenceChoice) && sent.planned === null && sent.shape === null);
  check('1b 出卡包含本地与在线两张', sent.referenceChoice?.candidates?.length >= 2 && sent.referenceChoice.candidates.some((item) => item.origin === 'local') && sent.referenceChoice.candidates.some((item) => item.origin === 'online'));
  check('1b 点选前引擎 0 次调用', engine.calls.length === 0, String(engine.calls.length));
  const localCard = sent.referenceChoice.candidates.find((item) => item.origin === 'local');
  await controller.chooseReferenceCandidate(
    { choiceId: sent.referenceChoice.choiceId, candidateId: localCard.candidateId, contentHash: localCard.contentHash },
    () => {},
    {},
  );
  const planCall = engine.planCalls()[0];
  check('1b 点本地卡后正式规划一次', engine.planCalls().length === 1);
  check('1b plan.request.customShape.contentHash 等于被点中的候选', planCall?.options?.customShape?.contentHash === localCard.contentHash, String(planCall?.options?.customShape?.contentHash));
}

// 1c. 唯一本地 + 质检通过的自由轮廓 → 出卡；点自由轮廓卡复用质检结论
{
  resetLlm({ intent: swanIntent(), verdicts: ['like'] });
  const localCandidate = makeLocalCandidate();
  const source = makeThreeSource({ local: okResult('local', [localCandidate]), online: missResult('online') });
  const engine = makeEngine();
  const controller = makeController({ source, engine });
  const sent = await controller.send({ text: '在广场画一只天鹅' });
  const freeformCard = sent.referenceChoice?.candidates?.find((item) => item.origin === 'freeform');
  check('1c 本地 + 自由轮廓通过：出卡 2 张', sent.referenceChoice?.candidates?.length === 2, String(sent.referenceChoice?.candidates?.length));
  check('1c 自由轮廓卡只在质检通过时出现', Boolean(freeformCard) && freeformCard.reviewStatus === 'freeform-reviewed');
  check('1c 自由轮廓卡带复检结论', freeformCard?.review?.verdict === 'like' && freeformCard?.review?.available === true);
  const verdictCallsBefore = llm.calls.verdict;
  await controller.chooseReferenceCandidate(
    { choiceId: sent.referenceChoice.choiceId, candidateId: freeformCard.candidateId, contentHash: freeformCard.contentHash },
    () => {},
    {},
  );
  const planCall = engine.planCalls()[0];
  check('1c 点自由轮廓卡：不重复调用质检', llm.calls.verdict === verdictCallsBefore, `${verdictCallsBefore} -> ${llm.calls.verdict}`);
  check('1c 点自由轮廓卡：plan.request.customShape.contentHash 等于候选', planCall?.options?.customShape?.contentHash === freeformCard.contentHash);
  check('1c 点自由轮廓卡：正式规划一次', engine.planCalls().length === 1);
}

// 1d. 三路都失败 → 无卡、无规划、回复「没有可用轮廓」
{
  resetLlm({ intent: swanIntent(), verdicts: ['unlike'], revisions: [{ http: 500 }] });
  const source = makeThreeSource({ local: missResult('local'), online: missResult('online') });
  const engine = makeEngine();
  const controller = makeController({ source, engine });
  const result = await controller.send({ text: '在广场画一只天鹅' });
  check('1d 三路都失败：无候选卡', !result.referenceChoice);
  check('1d 三路都失败：不规划、不画线', engine.planCalls().length === 0 && engine.commitCalls().length === 0);
  check('1d 三路都失败：回复点明目标与主要原因（方案 2026-11-08 §5.2：不再是笼统固定句）',
    result.reply.includes('天鹅') && /不像|质检|约束/.test(result.reply),
    result.reply);
  check('1d 回复给出与原因对应的下一步', /重新|换个|再试|简化|重画|具体一点|先只画/.test(result.reply), result.reply);
  check('1d 不展示点序列图', result.outline === null);
  // 缺陷 D1 回归（T-D1）：同一轮回复只能写一次历史，否则下一轮 LLM 上下文里
  // 同一问一答重复出现（浪费 token，可能影响意图解析）。
  const ctx = controller.exportContext();
  check('1d 失败轮 history 只增 2 条（D1：同一回复被写两遍历史）', ctx.history.length === 2, `history=${ctx.history.length}`);
  check(
    '1d history 结构为一问一答',
    ctx.history[0]?.role === 'user'
      && ctx.history[1]?.role === 'assistant'
      && ctx.history.filter((item) => item.role === 'assistant').length === 1,
    JSON.stringify(ctx.history.map((item) => item.role)),
  );
}

// ===========================================================================
// 场景 2：卡片随结果到达追加（不等最慢一路）
// ===========================================================================
{
  const verdictGate = deferred();
  resetLlm({ intent: swanIntent(), verdicts: ['like'], verdictGate });
  const localCandidate = makeLocalCandidate();
  const onlineCandidate = makeOnlineCandidate();
  // 在线路立即返回候选；自由轮廓质检被闸门挡住
  const source = makeThreeSource({ local: okResult('local', [localCandidate]), online: okResult('online', [onlineCandidate]) });
  const engine = makeEngine();
  const snapshots = [];
  const controller = makeController({ source, engine });
  const sent = await controller.send(
    { text: '在广场画一只天鹅' },
    () => {},
    { onReferenceCandidate: (snapshot) => snapshots.push(snapshot) },
  );
  check('2 出卡时不等自由轮廓：先返回 2 张（本地+在线）', sent.referenceChoice?.candidates?.length === 2, String(sent.referenceChoice?.candidates?.length));
  check('2 自由轮廓仍在跑时引擎 0 次调用', engine.planCalls().length === 0);
  verdictGate.resolve();
  for (let index = 0; index < 20; index += 1) {
    await tick(10);
    if (controller.exportContext().referenceChoice?.candidates?.length === 3) {
      break;
    }
  }
  const latest = controller.exportContext().referenceChoice;
  check('2 自由轮廓通过后追加第 3 张卡', latest?.candidates?.length === 3, String(latest?.candidates?.length));
  check('2 追加通过回调通知 UI', snapshots.some((snapshot) => snapshot.candidates.length === 3));
  check('2 追加卡来源为自由轮廓', latest?.candidates?.[2]?.origin === 'freeform');
  // 追加后仍需人点：引擎调用保持 0
  check('2 追加卡后仍未自动规划', engine.planCalls().length === 0);
}

// ===========================================================================
// 场景 3：点选立刻取消尚未返回的一路（M5：必须断言 signal 真的被 abort，
// 把 cancelThreeSourceSession 改成空操作时本用例必须失败）
// ===========================================================================
{
  resetLlm({ intent: swanIntent(), verdicts: ['like'] });
  const firstLocal = makeLocalCandidate({ id: 'swan-a', name: '天鹅A' });
  const secondLocal = makeLocalCandidate({ id: 'swan-b', name: '天鹅B', points: 20 });
  secondLocal.contentHash = 'e'.repeat(64);
  const onlineStarted = deferred();
  const onlineAborted = deferred();
  let onlineAbortObserved = false;
  const online = (options = {}) => {
    onlineStarted.resolve();
    // 只有 controller 真正 abort 内部 signal 时，这个 Promise 才会结束；
    // 记录事件供断言（取消被移出实现时不会触发 → 断言失败）。
    options.signal?.addEventListener(
      'abort',
      () => {
        onlineAbortObserved = true;
        onlineAborted.resolve();
      },
      { once: true },
    );
    return new Promise((resolve) => {
      onlineAborted.promise.then(() =>
        resolve({ status: 'cancelled', origin: 'online', candidates: [], failures: [], poolSize: 0, attempts: [] }),
      );
    });
  };
  const source = makeThreeSource({ local: okResult('local', [firstLocal, secondLocal]), online });
  const engine = makeEngine();
  const controller = makeController({ source, engine });
  const sent = await controller.send({ text: '在广场画一只天鹅' });
  await onlineStarted.promise;
  check('3 本地多候选先出卡，不等在线', sent.referenceChoice?.candidates?.length === 2 && sent.referenceChoice.origin === 'local');
  const chosen = sent.referenceChoice.candidates[0];
  const chosenTurn = controller.chooseReferenceCandidate(
    { choiceId: sent.referenceChoice.choiceId, candidateId: chosen.candidateId, contentHash: chosen.contentHash },
    () => {},
    {},
  );
  await tick(0);
  check(
    '3 点选触发取消：未返回在线路的 signal 被 abort（取消不是空操作）',
    onlineAbortObserved,
    'onlineAbortObserved=false：cancelThreeSourceSession 没有中止未返回路',
  );
  // 兜底结束在线 Promise（取消失效的回归场景下让用例能收尾并显式失败，而不是挂死）
  onlineAborted.resolve();
  await chosenTurn;
  await tick(20);
  check('3 点选后正式规划一次', engine.planCalls().length === 1);
  check('3 点选后选中快照只保留被点中的候选', controller.exportContext().referenceChoice?.status === 'selected');
}

// ===========================================================================
// 场景 4：不像不入场（质检 unlike + 修正抛错/超时/复检仍 unlike）
// ===========================================================================
console.log('\n=== 场景 4：不像不入场 ===');

const unlikeBranches = [
  ['修正抛错（HTTP 500）', { verdicts: ['unlike'], revisions: [{ http: 500 }] }],
  ['修正超时（请求被中止）', { verdicts: ['unlike'], revisions: [{ abort: true }] }],
  ['复检仍 unlike', { verdicts: ['unlike', 'unlike'], revisions: [{ json: { name: '天鹅B', points: circlePoints(84) } }] }],
  ['质检结论不明（unknown，按未验收处理）', { verdicts: ['unknown'], revisions: [] }],
];

for (const [label, config] of unlikeBranches) {
  resetLlm({ intent: swanIntent(), ...config });
  const onlineCandidate = makeOnlineCandidate();
  const source = makeThreeSource({ local: missResult('local'), online: okResult('online', [onlineCandidate]) });
  const engine = makeEngine();
  const controller = makeController({ source, engine });
  const sent = await controller.send({ text: '在广场画一只天鹅' });
  const freeformCards = (sent.referenceChoice?.candidates || []).filter((item) => item.origin === 'freeform');
  check(`4 ${label}：没有自由轮廓候选`, freeformCards.length === 0, String(freeformCards.length));
  check(`4 ${label}：出卡（有在线候选），点选前不规划`, Boolean(sent.referenceChoice) && engine.planCalls().length === 0);
  check(`4 ${label}：修正请求不超过 1 次`, llm.calls.revision <= 1, String(llm.calls.revision));
  check(`4 ${label}：没有把第一版自由轮廓交出去`, !(sent.referenceChoice?.candidates || []).some((item) => item.name === '天鹅'));
  // 等自由轮廓后台路收尾（避免影响下一个场景）
  await tick(30);
}

// ===========================================================================
// 场景 5：复杂剪影点数下限 80（79 拒绝、80 接受）、简单图形 8~20 接受
// ===========================================================================
console.log('\n=== 场景 5：点数闸门 ===');

{
  // 缺陷清单 2026-11-06 Bug 4.2 分级放行：79 点 + 质检 like → 进卡（tiered），
  // 用户点选后可规划；59 点（低于分级放行硬下限 60）→ 拒绝，不进卡
  resetLlm({ intent: swanIntent({ points: 79, featureCount: 3 }), verdicts: ['like'] });
  const source = makeThreeSource({ local: missResult('local'), online: missResult('online') });
  const engine = makeEngine();
  const controller = makeController({ source, engine });
  const result = await controller.send({ text: '在广场画一只天鹅' });
  const releasedCard = result.referenceChoice?.candidates?.find((item) => item.origin === 'freeform');
  check('5 复杂剪影 79 点 + 质检 like：分级放行进卡', Boolean(releasedCard) && releasedCard.customShape.outlinePoints.length === 79, `card=${Boolean(releasedCard)}`);

  resetLlm({ intent: swanIntent({ points: 59, featureCount: 3 }), verdicts: ['like'] });
  const source59 = makeThreeSource({ local: missResult('local'), online: missResult('online') });
  const engine59 = makeEngine();
  const controller59 = makeController({ source: source59, engine: engine59 });
  const result59 = await controller59.send({ text: '在广场画一只天鹅' });
  check('5 复杂剪影 59 点：低于硬下限不进卡', !result59.referenceChoice);
  check('5 复杂剪影 59 点：不规划且回复说明点数原因', engine59.planCalls().length === 0 && /点数/.test(result59.reply), result59.reply);
}

{
  // 80 点 + 声明 3 个特征 → 复杂剪影 → 接受，进卡
  resetLlm({ intent: swanIntent({ points: 80, featureCount: 3 }), verdicts: ['like'] });
  const source = makeThreeSource({ local: missResult('local'), online: missResult('online') });
  const engine = makeEngine();
  const controller = makeController({ source, engine });
  const result = await controller.send({ text: '在广场画一只天鹅' });
  const freeformCard = result.referenceChoice?.candidates?.find((item) => item.origin === 'freeform');
  check('5 复杂剪影 80 点：进卡', Boolean(freeformCard) && freeformCard.customShape.outlinePoints.length === 80);
}

{
  // 简单图形（无凹口、features<3）8~20 点：接受，进卡
  resetLlm({ intent: swanIntent({ points: 20 }), verdicts: ['like'] });
  const source = makeThreeSource({ local: missResult('local'), online: missResult('online') });
  const engine = makeEngine();
  const controller = makeController({ source, engine });
  const result = await controller.send({ text: '在广场画一个圆' });
  const freeformCard = result.referenceChoice?.candidates?.find((item) => item.origin === 'freeform');
  check(
    '5 简单图形 20 点：接受进卡',
    Boolean(freeformCard)
      && freeformCard.customShape.outlinePoints.length === 20
      && freeformCard.customShape.features.length < 3,
    `points=${freeformCard?.customShape?.outlinePoints?.length} features=${freeformCard?.customShape?.features?.length}`,
  );
}

// ===========================================================================
// 场景 6：修正只发一次（retries=0）——可重试错误也只请求一次
// ===========================================================================
{
  resetLlm({ intent: swanIntent(), verdicts: ['unlike'], revisions: [{ http: 500 }, { json: { name: '天鹅B', points: circlePoints(84) } }] });
  const source = makeThreeSource({ local: missResult('local'), online: missResult('online') });
  const engine = makeEngine();
  const controller = makeController({ source, engine });
  const result = await controller.send({ text: '在广场画一只天鹅' });
  check('6 修正请求只发一次（HTTP 500 不重试，队列里的第二项未被消费）', llm.calls.revision === 1, String(llm.calls.revision));
  check('6 修正失败 → 自由轮廓这一路失败 → 回复说明真实原因（不像/质检）',
    result.reply.includes('天鹅') && /不像|质检/.test(result.reply), result.reply);
}

console.log(`\nRESULT: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}  (${checks - failures} passed, ${failures} failed)`);
process.exit(failures === 0 ? 0 : 2);
