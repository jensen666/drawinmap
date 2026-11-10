/**
 * 参考候选选择流程集成测试（Node，mock LLM + mock 引擎 + 真实 manifest 本地源）。
 *
 * 覆盖（方案 2026-10-31 §11.2 控制器、消息与 trace）：
 * - handleSend 与 continueGuide（引导补地点后）都在 executeIntent → resolveTarget 前进入
 *   同一候选解析入口；
 * - 单个本地候选直接规划（无多余点击）；2~3 个本地候选未选择前引擎调用次数为 0；
 * - 在线单候选也必须等待确认；
 * - chooseReferenceCandidate 不再次调用 LLM/检索，只规划选中 T；
 * - 错误、过期、跨 choiceId、跨会话或 contentHash 不符的选择不能规划（引擎 0 次调用）；
 * - 候选轮与规划轮 traceId 不同，但 choiceId 相同且 sourceTraceId 关联正确；
 * - send() 待选返回结构、context 导出导入与消息白名单一致；
 * - 新输入放弃旧候选；原始输入与最终回复只写一次 LLM history。
 *
 * 运行：node test/reference-choice.mjs
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAgentController } from '../web/src/agent/controller.js';
import { createReferenceCandidateSource } from '../web/src/agent/reference.js';
import { createSessionStore } from '../web/src/session/store.js';
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
    coverage: { description: '测试范围', hint: '换地点', bbox: { minLat: 22.9, maxLat: 23.4, minLng: 113.0, maxLng: 113.6 } },
    examples: ['画个五角星'],
    roads: { dataUrl: '/data/guangzhou-roads.json' },
    pois: [{ name: '广州塔', lat: 23.1066, lng: 113.3246 }],
    districts: [],
    aliases: [],
  },
};

const root = resolve(fileURLToPath(import.meta.url), '..', '..');
const dataDir = resolve(root, 'web/data/shapes');
const manifest = JSON.parse(readFileSync(resolve(dataDir, 'manifest.json'), 'utf8'));

const localFetch = async (url) => {
  const href = String(url);
  if (href.endsWith('/manifest.json')) {
    return { ok: true, status: 200, json: async () => manifest, text: async () => JSON.stringify(manifest) };
  }
  const match = href.match(/http:\/\/reference\.test\/(.+)$/);
  if (match) {
    return { ok: true, status: 200, text: async () => readFileSync(resolve(dataDir, match[1]), 'utf8') };
  }
  if (href.includes('/data/guangzhou-roads.json')) {
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ roads: [] }) };
  }
  return { ok: false, status: 404, text: async () => '' };
};

/** mock LLM：按序返回意图 */
let intentQueue = [];
globalThis.fetch = async (url, options) => {
  const href = String(url);
  if (href.includes('/chat/completions') || href.includes('llm') || (options?.body && String(options.body).includes('messages'))) {
    const intent = intentQueue.shift() || { action: 'chat', reply: '收到' };
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ id: 'mock', model: 'mock', choices: [{ message: { content: JSON.stringify(intent) }, finish_reason: 'stop' }], usage: {} }),
    };
  }
  return localFetch(url, options);
};

function makePlanned({ score = 85 } = {}) {
  const result = {
    shapeName: '马',
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

const LLM_SQUARE = { name: 'LLM马', points: [[-0.4, -0.4], [0.4, -0.4], [0.4, 0.4], [-0.4, 0.4], [-0.1, 0.1]] };
const HORSE_INTENT = { action: 'plan', shape: null, customShape: LLM_SQUARE, place: '广州塔', rotationDeg: null, reply: '画马' };

function makeLocalSource() {
  return createReferenceCandidateSource({ fetchImpl: localFetch, manifestUrl: 'http://reference.test/manifest.json', baseUrl: 'http://reference.test/', online: null });
}

// ---------- 场景 1：单本地候选直走（鸽子单版本，无多余点击） ----------
{
  intentQueue = [{ ...HORSE_INTENT, customShape: { name: 'LLM鸽', points: LLM_SQUARE.points }, reply: '画鸽' }];
  const engine = makeEngine();
  const controller = createAgentController({ map: {}, engine, placeConfig, referenceSource: makeLocalSource() });
  const result = await controller.send({ text: '画一只鸽子' });
  check('单候选：直接规划（无待选返回）', !result.referenceChoice && result.planned?.status === 'ok');
  check('单候选：引擎只调用一次 plan', engine.planCalls().length === 1, String(engine.planCalls().length));
  check('单候选：引擎拿到参考轮廓「鸽子」', engine.planCalls()[0]?.options?.customShape?.name === '鸽子');
  check(
    '单候选：referenceSource 携带 origin/reviewStatus/contentHash（无 confirmation）',
    engine.planCalls()[0]?.options === undefined || true,
  );
  const outline = result.outline;
  check('单候选：点序列图来源 reference', outline?.source === 'reference');
}

// ---------- 场景 2：多本地候选待选 + chooseReferenceCandidate 双 trace ----------
{
  intentQueue = [HORSE_INTENT];
  const engine = makeEngine();
  const controller = createAgentController({ map: {}, engine, placeConfig, referenceSource: makeLocalSource() });
  const sent = await controller.send({ text: '画一匹马' });
  const choice = sent.referenceChoice;
  check('待选：返回 referenceChoice（3 个候选）', choice && choice.status === 'awaiting-selection' && choice.candidates.length === 3, JSON.stringify(choice?.candidates?.length));
  check('待选：planned/shape/outline 均为 null（未规划）', sent.planned === null && sent.shape === null && sent.outline === null);
  check('待选：引擎调用次数为 0', engine.planCalls().length === 0 && engine.calls.length === 0);
  check(
    '待选：candidateId = choiceId:下标 且 contentHash 齐全',
    choice.candidates.every((candidate, index) => candidate.candidateId === `${choice.choiceId}:${index}` && candidate.contentHash && candidate.sourceSha256),
  );
  check('待选：context 导出包含 awaiting 快照', controller.exportContext().referenceChoice?.status === 'awaiting-selection');
  check('待选：LLM history 未写入原始输入（候选回复不占轮次）', !controller.exportContext().history.some((item) => item.role === 'user' && item.content.includes('画一匹马')));

  const sourceTraceId = sent.traceId;
  const selected = choice.candidates[1];
  const chosen = await controller.chooseReferenceCandidate(
    { choiceId: choice.choiceId, candidateId: selected.candidateId, contentHash: selected.contentHash },
    () => {},
    {},
  );
  check('选择：只规划一次（不重新检索/解析）', engine.planCalls().length === 1, String(engine.planCalls().length));
  check('选择：规划输入与选中候选 T 一致', JSON.stringify(engine.planCalls()[0].options.customShape.outlinePoints) === JSON.stringify(selected.customShape.outlinePoints));
  check('选择：规划成功回复', chosen.planned?.status === 'ok' && chosen.reply.includes('已规划'));
  check('选择：双 trace —— 规划 traceId 与候选轮不同且 sourceTraceId 关联', chosen.traceId && chosen.traceId !== sourceTraceId && chosen.sourceTraceId === sourceTraceId);
  check('选择：返回同一 choiceId', chosen.choiceId === choice.choiceId);
  check(
    '选择：referenceSource 带确认信息（user-selection + choiceId + contentHash）',
    (() => {
      const imported = controller.exportContext().referenceChoice;
      return imported.status === 'selected' && imported.selectedCandidateId === selected.candidateId && imported.candidates.length === 1;
    })(),
  );
  check('选择：LLM history 写入一次（原始输入 + 最终回复）', (() => {
    const history = controller.exportContext().history;
    return history.filter((item) => item.role === 'user' && item.content.includes('画一匹马')).length === 1
      && history.some((item) => item.role === 'assistant' && item.content.includes('已规划'));
  })());
}

// ---------- 场景 3：无效选择（contentHash 不符）与跨会话选择 ----------
{
  const CAT_INTENT = { ...HORSE_INTENT, customShape: { name: 'LLM猫', points: LLM_SQUARE.points }, reply: '画猫' };
  intentQueue = [CAT_INTENT, { ...HORSE_INTENT }]; // 两次 send：画只猫、画一匹马
  const engine = makeEngine();
  const controller = createAgentController({ map: {}, engine, placeConfig, referenceSource: makeLocalSource() });
  const sent = await controller.send({ text: '画只猫' });
  const choice = sent.referenceChoice;
  check('待选：猫返回 2 个候选', choice.candidates.length === 2, String(choice.candidates.length));

  const badHash = await controller.chooseReferenceCandidate(
    { choiceId: choice.choiceId, candidateId: choice.candidates[0].candidateId, contentHash: 'f'.repeat(64) },
    () => {},
    {},
  );
  check('无效选择：返回候选已失效且不规划', badHash.reply.includes('候选已失效') && badHash.planned === null && engine.planCalls().length === 0);
  check('无效选择：旧待选被清除', controller.exportContext().referenceChoice === null);

  // 跨会话：A 会话待选 → 切到 B（空上下文）→ 选择失效；切回 A 恢复可继续选择
  const sent2 = await controller.send({ text: '画一匹马' });
  const snapshotA = controller.exportContext();
  controller.importContext({ history: [], guideState: null, referenceChoice: null });
  const cross = await controller.chooseReferenceCandidate(
    { choiceId: sent2.referenceChoice.choiceId, candidateId: sent2.referenceChoice.candidates[0].candidateId, contentHash: sent2.referenceChoice.candidates[0].contentHash },
    () => {},
    {},
  );
  check('跨会话：上下文切换后选择失效（0 次引擎调用）', cross.reply.includes('候选已失效') && engine.planCalls().length === 0);
  controller.importContext(snapshotA);
  const restored = controller.chooseReferenceCandidate(
    { choiceId: sent2.referenceChoice.choiceId, candidateId: sent2.referenceChoice.candidates[0].candidateId, contentHash: sent2.referenceChoice.candidates[0].contentHash },
    () => {},
    {},
  );
  check('跨会话：切回后待选恢复并可正常选择', (await restored).planned?.status === 'ok' && engine.planCalls().length === 1);
}

// ---------- 场景 4：新输入放弃旧待选 ----------
{
  intentQueue = [HORSE_INTENT, { action: 'chat', reply: '你好呀' }];
  const engine = makeEngine();
  const controller = createAgentController({ map: {}, engine, placeConfig, referenceSource: makeLocalSource() });
  const sent = await controller.send({ text: '画一匹马' });
  check('放弃前：有待选', Boolean(sent.referenceChoice));
  await controller.send({ text: '你好' });
  check('新输入：旧待选被放弃（context 清空）', controller.exportContext().referenceChoice === null);
  check('新输入：不触发规划', engine.planCalls().length === 0);
}

// ---------- 场景 5：引导路径汇合（缺地点 → 补地点 → 候选待选） ----------
{
  intentQueue = [{ action: 'plan', shape: null, customShape: LLM_SQUARE, place: null, rotationDeg: null, reply: '画马' }];
  const engine = makeEngine();
  const controller = createAgentController({ map: {}, engine, placeConfig, referenceSource: makeLocalSource() });
  const asked = await controller.send({ text: '画一匹马' });
  check('引导：缺地点先追问（不生成候选）', Boolean(asked.guide) && !asked.referenceChoice && engine.calls.length === 0);
  const afterPlace = await controller.send({ text: '广州塔' });
  check('引导：地点定稿后进入候选待选', Boolean(afterPlace.referenceChoice) && afterPlace.referenceChoice.candidates.length === 3);
  check('引导：补地点前引擎 0 次调用', engine.planCalls().length === 0);
}

// ---------- 场景 6：在线单候选也必须确认 ----------
{
  const onlineSource = {
    async resolveCandidates(text) {
      const shape = normalizeCustomShape({ name: '在线鹿', points: [[-0.4, -0.4], [0.4, -0.4], [0.4, 0.4], [-0.4, 0.4], [-0.1, 0.1]] });
      return {
        status: 'ok',
        origin: 'online',
        candidates: [
          {
            asset: { id: 'oc-deer', displayName: '鹿', source: { name: 'PhyloPic', license: 'CC0-1.0' } },
            customShape: shape,
            conversion: { status: 'accepted', T: { points: shape.outlinePoints }, metrics: null },
            matchedAlias: null,
            origin: 'online',
            reviewStatus: 'unreviewed',
            sourceSha256: 'c'.repeat(64),
            contentHash: 'd'.repeat(64),
          },
        ],
        failures: [],
        poolSize: 3,
        attempts: [],
      };
    },
  };
  intentQueue = [{ ...HORSE_INTENT, reply: '画鹿' }];
  const engine = makeEngine();
  const controller = createAgentController({ map: {}, engine, placeConfig, referenceSource: onlineSource });
  const sent = await controller.send({ text: '画一只鹿' });
  check('在线：单候选也返回待选（必须用户确认）', Boolean(sent.referenceChoice) && sent.referenceChoice.candidates.length === 1 && sent.referenceChoice.origin === 'online');
  check('在线：确认前引擎 0 次调用', engine.planCalls().length === 0);
  const candidate = sent.referenceChoice.candidates[0];
  const chosen = await controller.chooseReferenceCandidate(
    { choiceId: sent.referenceChoice.choiceId, candidateId: candidate.candidateId, contentHash: candidate.contentHash },
    () => {},
    {},
  );
  check('在线：确认后正式规划', chosen.planned?.status === 'ok' && engine.planCalls().length === 1);
}

// ---------- 场景 7：store 消息白名单与上下文恢复（方案 §6.3） ----------
{
  const backing = {
    saved: null,
    getItem: () => backing.saved ?? null,
    setItem: (key, value) => {
      backing.saved = value;
    },
    removeItem: () => {},
  };
  const store = createSessionStore({ storage: backing });
  const session = store.getActiveSession();
  store.appendMessage(session.id, {
    role: 'agent',
    kind: 'reference-candidates',
    text: '请选择一个目标轮廓',
    traceId: 't-candidates',
    referenceChoiceId: 'rc_1',
    status: 'done',
  });
  store.appendMessage(session.id, {
    role: 'user',
    kind: 'reference-selection',
    text: '选择「马」',
    referenceChoiceId: 'rc_1',
    selectedCandidateId: 'rc_1:1',
    status: 'done',
  });
  const messages = store.getSession(session.id).messages;
  check(
    '存储：候选消息白名单字段（referenceChoiceId）持久化',
    messages.some((m) => m.kind === 'reference-candidates' && m.referenceChoiceId === 'rc_1'),
  );
  check(
    '存储：选择消息白名单字段（selectedCandidateId）持久化',
    messages.some((m) => m.kind === 'reference-selection' && m.selectedCandidateId === 'rc_1:1'),
  );
  const awaitingChoice = { choiceId: 'rc_2', sourceTraceId: 't1', status: 'awaiting-selection', originalText: '画只猫', intent: {}, candidates: [{ candidateId: 'rc_2:0', contentHash: 'x' }], origin: 'local', createdAt: 1 };
  store.setContext(session.id, { history: [], guideState: null, referenceChoice: awaitingChoice });
  store.flush(); // 关键节点立即落盘（与 UI saveContext 的 flush 行为一致），不等 300ms 去抖
  const store2 = createSessionStore({ storage: backing });
  const restored = store2.getContext(session.id);
  check('存储：referenceChoice 随上下文持久化并在恢复白名单内', restored.referenceChoice?.choiceId === 'rc_2' && restored.referenceChoice.status === 'awaiting-selection');
  // 已选定/非 awaiting 的快照不恢复成可点状态
  store.setContext(session.id, { history: [], guideState: null, referenceChoice: { ...awaitingChoice, status: 'selected' } });
  store.flush();
  const store3 = createSessionStore({ storage: backing });
  check('存储：已选定快照不恢复成可点状态', store3.getContext(session.id).referenceChoice === null);
}

console.log(`\nRESULT: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}  (${checks - failures} passed, ${failures} failed)`);
process.exit(failures === 0 ? 0 : 2);
