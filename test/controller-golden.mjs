/**
 * controller 10 场景 golden 特征化基线（清理方案 2026-11-09 阶段 0，T-B2d）。
 *
 * 目的：B2 agent 编排去重 / C 批 controller 拆分（交付出口、pending 状态、
 * templates、multi-part、比例尺池、备选切换……）前后，用 **10 个固定场景**
 * 把 controller 对外可见行为钉住：`reply` 全文、`status`、`shape`、`outline`、
 * `commitDraw` 参数（以及候选卡/比例尺池/引导追问的结构摘要）逐字段一致。
 *
 * 10 个场景（与方案 §6.3 T-B2d 清单一致）：
 * 1. local-hit        本地参考命中：唯一本地候选 + 其余两路失败 → 直接规划绿线交付
 * 2. online-hit       在线命中：出候选卡 → 用户点选在线卡 → 正式规划交付
 * 3. freeform-pass    自由轮廓通过视觉质检：出卡 → 点选 → 规划交付
 * 4. all-source-fail  三路都失败：无卡、无规划、回复点明目标与原因
 * 5. multi-object     多对象全部命中：组合 multi-part 目标 → 规划交付（交付对象核对）
 * 6. scale-pick       多比例尺卡片：交付挂 3 档池 → 点选 3.6 km 卡切换（不重规划）
 * 7. alternative-switch 备选切换：交付 5.4 km + 备选 9 km → 短语"要大一点"切到 9 km
 * 8. plan-reference   参考版回退：plan 低于交付闸门 → 橙色参考版（reference=true）
 * 9. recommend-fallback 推荐失败回退：推荐失败但有可回退候选 → 参考版交付
 * 10. guide-question  引导追问：缺地点 → 出选项 → 用户点选地点 → 规划交付
 *
 * 装配全部来自 `test/lib/controller-harness.mjs`（fake 引擎 / fake 三路 / fetch mock）。
 * 摘要里不含 createId/时间戳等随机值；`reply` 只允许 traceId/时间戳类字段被
 * `sanitizeText` 归一化，其余文本逐字比较。
 *
 * 用法：
 *   node test/controller-golden.mjs            # 与 fixture 逐字段对比（CI 用）
 *   node test/controller-golden.mjs --update   # 在当前 HEAD 代码上重生成 fixture
 */

import './lib/llm-test-config.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { diffJson } from '../tools/diff-baseline.mjs';
import { initLogging } from '../web/src/log/index.js';
import {
  captureSwitch,
  captureTurn,
  createLlmMock,
  makeBuiltinIntent,
  makeCandidateEntry,
  makeController,
  makeFailedRecommend,
  makeFakeEngine,
  makeFreeformIntent,
  makeLocalCandidate,
  makeMetrics,
  makeObjectGroupsResult,
  makeOnlineCandidate,
  makePlanOutcome,
  makePlannedResult,
  makeThreeSource,
  okResult,
  sanitizeText,
} from './lib/controller-harness.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const FIXTURE_PATH = join(ROOT, 'test', 'fixtures', 'controller-golden.json');

/** 每轮捕获结果的固定字段（顺序即 fixture 键顺序） */
const CAPTURE_KEYS = ['reply', 'status', 'shape', 'outline', 'commitDraw', 'referenceChoice', 'scalePool', 'guide'];

let checks = 0;
let failures = 0;

/**
 * 断言工具：记录并通过/失败计数。
 *
 * @param {string} label 断言标签
 * @param {boolean} condition 断言条件
 * @param {string} [detail] 失败详情
 */
function check(label, condition, detail = '') {
  checks += 1;
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`[check] ${label} -> ${ok ? 'PASS' : `FAIL ${detail}`}`);
}

/** LLM fetch mock（全局安装一次；各场景只 reset 队列） */
/**
 * 屏蔽日志镜像：log 的 trace 通道直接写 console，不参与级别过滤（生产代码现状），
 * 会把 golden 输出淹没。只丢弃 `[log] ` 前缀行，其余 console 输出原样保留。
 */
function silenceLogMirror() {
  for (const method of ['log', 'info', 'debug', 'warn', 'error']) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      if (typeof args[0] === 'string' && args[0].startsWith('[log] ')) return;
      original(...args);
    };
  }
}
initLogging({ server: false, storage: false, level: 'error' });
silenceLogMirror();
const llm = createLlmMock();
const restoreFetch = llm.install();

/**
 * 构造一个达标（绿线）plan 结果。
 *
 * @param {{shapeName?: string, score?: number, sizeMeters?: number, rotationDeg?: number,
 *   routeMeters?: number, alternatives?: Array<object>, nearBest?: object|null}} [options] 选项
 * @returns {object} 引擎 plan 返回值
 */
function plannedOk({
  shapeName = '马',
  score = 78,
  sizeMeters = 1200,
  rotationDeg = 0,
  routeMeters = 1000,
  alternatives = [],
  nearBest = null,
} = {}) {
  const result = makePlannedResult({
    shapeName,
    sizeMeters,
    rotationDeg,
    metrics: makeMetrics({ routeMeters, sizeMeters }),
  });
  const best = makeCandidateEntry({ result, score, sizeMeters, rotationDeg });
  return makePlanOutcome({ best, alternatives, nearBest });
}

// ---------------------------------------------------------------------------
// 10 个固定场景
// ---------------------------------------------------------------------------

const SCENARIOS = [
  {
    id: 'local-hit',
    title: '本地参考命中：唯一本地候选 + 其余两路失败 → 直接规划（不弹卡）',
    async run() {
      llm.reset({ intents: [makeFreeformIntent()], verdicts: ['unlike'], revisions: [{ http: 500 }] });
      const source = makeThreeSource({ local: okResult('local', [makeLocalCandidate()]) });
      const engine = makeFakeEngine({ planQueue: [plannedOk({ shapeName: '天鹅', score: 85 })] });
      const controller = makeController({ engine, source });
      const result = await controller.send({ text: '在广州塔画一只天鹅' });
      return [captureTurn(result, engine)];
    },
  },
  {
    id: 'online-hit',
    title: '在线命中：出候选卡（点选前引擎 0 次调用）→ 点选在线卡后正式规划交付',
    async run() {
      llm.reset({ intents: [makeFreeformIntent()], verdicts: ['unlike'], revisions: [{ http: 500 }] });
      const source = makeThreeSource({ online: okResult('online', [makeOnlineCandidate()]) });
      const engine = makeFakeEngine({ planQueue: [plannedOk({ shapeName: '天鹅', score: 85 })] });
      const controller = makeController({ engine, source });
      const sent = await controller.send({ text: '在广州塔画一只天鹅' });
      const captures = [captureTurn(sent, engine)];
      const card = (sent.referenceChoice?.candidates ?? []).find((item) => item.origin === 'online') ?? null;
      const chosen = card
        ? await controller.chooseReferenceCandidate(
            {
              choiceId: sent.referenceChoice.choiceId,
              candidateId: card.candidateId,
              contentHash: card.contentHash,
            },
            () => {},
            {},
          )
        : null;
      captures.push(captureTurn(chosen, engine));
      return captures;
    },
  },
  {
    id: 'freeform-pass',
    title: '自由轮廓通过视觉质检：出 1 张自由轮廓卡 → 点选 → 规划交付（复用质检结论）',
    async run() {
      llm.reset({ intents: [makeFreeformIntent({ points: 84 })], verdicts: ['like'] });
      const source = makeThreeSource();
      const engine = makeFakeEngine({ planQueue: [plannedOk({ shapeName: '天鹅', score: 80 })] });
      const controller = makeController({ engine, source });
      const sent = await controller.send({ text: '在广州塔画一只天鹅' });
      const captures = [captureTurn(sent, engine)];
      const card = (sent.referenceChoice?.candidates ?? []).find((item) => item.origin === 'freeform') ?? null;
      const chosen = card
        ? await controller.chooseReferenceCandidate(
            {
              choiceId: sent.referenceChoice.choiceId,
              candidateId: card.candidateId,
              contentHash: card.contentHash,
            },
            () => {},
            {},
          )
        : null;
      captures.push(captureTurn(chosen, engine));
      return captures;
    },
  },
  {
    id: 'all-source-fail',
    title: '三路都失败：无候选卡、不规划、不画线，回复点明目标与主要原因',
    async run() {
      llm.reset({ intents: [makeFreeformIntent()], verdicts: ['unlike'], revisions: [{ http: 500 }] });
      const source = makeThreeSource();
      const engine = makeFakeEngine();
      const controller = makeController({ engine, source });
      const result = await controller.send({ text: '在广州塔画一只天鹅' });
      return [captureTurn(result, engine)];
    },
  },
  {
    id: 'multi-object',
    title: '多对象全部命中：组合 2 部分 multi-part 目标 → 规划交付（交付对象=请求对象）',
    async run() {
      llm.reset({
        intents: [
          {
            action: 'plan',
            shape: null,
            customShape: null,
            place: '广州塔',
            rotationDeg: null,
            reply: '好的，我给你画一匹马和一只狗',
            requestObjects: [{ name: '马' }, { name: '狗' }],
          },
        ],
      });
      const source = makeThreeSource({
        local: makeObjectGroupsResult([
          { name: '马', candidates: [makeLocalCandidate({ id: 'horse-phylopic', name: '马', alias: '马', points: 24 })] },
          { name: '狗', candidates: [makeLocalCandidate({ id: 'dog-phylopic', name: '狗', alias: '狗', points: 20 })] },
        ]),
      });
      const result = makePlannedResult({ shapeName: '马+狗', sizeMeters: 1200, metrics: makeMetrics({ sizeMeters: 1200 }) });
      const best = makeCandidateEntry({ result, score: 78, sizeMeters: 1200 });
      const engine = makeFakeEngine({ planQueue: [makePlanOutcome({ best })] });
      const controller = makeController({ engine, source });
      const sent = await controller.send({ text: '在广州塔画一匹马和一只狗' });
      return [captureTurn(sent, engine)];
    },
  },
  {
    id: 'scale-pick',
    title: '多比例尺点选：绿线交付挂 3 档池 → 点选 3.6 km 卡切换（不重规划）',
    async run() {
      llm.reset({ intents: [makeBuiltinIntent({ shape: 'star' })] });
      const best = makeCandidateEntry({ score: 75, sizeMeters: 1800, rotationDeg: 0 });
      const alternatives = [
        makeCandidateEntry({ score: 68, sizeMeters: 900, rotationDeg: 15 }),
        makeCandidateEntry({ score: 72, sizeMeters: 3600, rotationDeg: 0, stage: 2, stageLabel: '扩大范围' }),
      ];
      const engine = makeFakeEngine({ planQueue: [makePlanOutcome({ best, alternatives })] });
      const controller = makeController({ engine });
      const sent = await controller.send({ text: '在广州塔画个心形' });
      const captures = [captureTurn(sent, engine)];
      const target = (sent.scalePool?.cards ?? []).find((card) => card.sizeMeters === 3600) ?? null;
      const switched = target
        ? controller.switchScaleCandidate({ poolId: sent.scalePool.poolId, cardId: target.id })
        : null;
      captures.push(captureSwitch(switched, engine));
      return captures;
    },
  },
  {
    id: 'alternative-switch',
    title: '备选切换：交付 5.4 km 版 + 备选 9 km 版 → 短语"要大一点的那版"切到 9 km（不重规划）',
    async run() {
      llm.reset({ intents: [makeBuiltinIntent({ shape: 'heart' })] });
      const best = makeCandidateEntry({ score: 70, sizeMeters: 5400 });
      const alternative = makeCandidateEntry({ score: 77, sizeMeters: 9000 });
      const engine = makeFakeEngine({ planQueue: [makePlanOutcome({ best, alternatives: [alternative] })] });
      const controller = makeController({ engine });
      const first = await controller.send({ text: '在广州塔画个心形' });
      const captures = [captureTurn(first, engine)];
      const second = await controller.send({ text: '要大一点的那版' });
      captures.push(captureTurn(second, engine));
      return captures;
    },
  },
  {
    id: 'plan-reference',
    title: '参考版回退：plan 低于 60 分交付闸门 → 橙色参考版（reference=true），不绿线',
    async run() {
      llm.reset({
        intents: [
          {
            action: 'plan',
            shape: null,
            customShape: { name: '马A', points: [[-0.4, -0.4], [0.4, -0.4], [0.4, 0.4], [-0.4, 0.4]] },
            place: '广州塔',
            rotationDeg: null,
            reply: '画马',
          },
        ],
        verdicts: ['like'],
      });
      const best = makeCandidateEntry({ score: 55 });
      const engine = makeFakeEngine({ planQueue: [makePlanOutcome({ best })] });
      const controller = makeController({ engine });
      const result = await controller.send({ text: '在广州塔画个马' });
      return [captureTurn(result, engine)];
    },
  },
  {
    id: 'recommend-fallback',
    title: '推荐失败回退：推荐失败但 bests 有可回退候选 → 参考版交付（reference=true）',
    async run() {
      llm.reset({
        intents: [
          { action: 'recommend', shape: null, customShape: null, place: '珠江新城', rotationDeg: null, reply: '看看能画什么' },
        ],
      });
      const engine = makeFakeEngine({ recommendQueue: [makeFailedRecommend()] });
      const controller = makeController({ engine });
      const result = await controller.send({ text: '看看能画什么' });
      return [captureTurn(result, engine)];
    },
  },
  {
    id: 'guide-question',
    title: '引导追问：意图缺地点 → 出 5 个地点选项；用户点选广州塔 → 规划交付',
    async run() {
      llm.reset({ intents: [makeBuiltinIntent({ shape: 'star', place: null, reply: '好的。' })] });
      const engine = makeFakeEngine({ planQueue: [plannedOk({ shapeName: '五角星', score: 78 })] });
      const controller = makeController({ engine });
      const first = await controller.send({ text: '画个五角星' });
      const captures = [captureTurn(first, engine)];
      const second = await controller.send({ text: '广州塔' });
      captures.push(captureTurn(second, engine));
      return captures;
    },
  },
];

// ---------------------------------------------------------------------------
// 场景契约断言（不依赖 fixture；--update 时也会跑，保证场景确实覆盖目标分支）
// ---------------------------------------------------------------------------

/** 场景契约：返回 [标签, 条件, 详情] 列表 */
const SCENARIO_CONTRACTS = {
  'local-hit': ([turn]) => [
    ['本地命中：直接规划绿线并提交一次', turn.status === 'ok' && turn.commitDraw?.count === 1 && turn.commitDraw.reference === false],
  ],
  'online-hit': ([card, chosen]) => [
    ['在线命中：先出待选卡（引擎 0 次提交）', card.referenceChoice?.status === 'awaiting-selection' && card.commitDraw === null],
    ['在线命中：点选后正式规划并交付一次', chosen.status === 'ok' && chosen.commitDraw?.count === 1 && chosen.commitDraw.reference === false],
  ],
  'freeform-pass': ([card, chosen]) => [
    ['自由轮廓通过：出 1 张自由轮廓卡（点选前 0 次提交）', card.referenceChoice?.candidateCount === 1 && card.referenceChoice?.origins?.[0] === 'freeform' && card.commitDraw === null],
    ['自由轮廓通过：点选后规划交付一次', chosen.status === 'ok' && chosen.commitDraw?.count === 1],
  ],
  'all-source-fail': ([turn]) => [
    ['三路失败：无卡、无交付、不画线', turn.referenceChoice === null && turn.commitDraw === null && turn.shape === null],
    ['三路失败：回复点名目标并要求换法', /天鹅/.test(turn.reply) && /重新|换个|再试|简化|重画|具体一点|先只画/.test(turn.reply)],
  ],
  'multi-object': ([turn]) => [
    ['多对象：绿线交付一次且交付对象=请求对象', turn.status === 'ok' && turn.commitDraw?.count === 1 && Array.isArray(turn.commitDraw.deliveredObjects) && turn.commitDraw.deliveredObjects.join(',') === '马,狗'],
  ],
  'scale-pick': ([sent, switched]) => [
    ['比例尺：交付挂 3 档池（升序、当前版 1800）', sent.scalePool?.cardCount === 3 && sent.scalePool.currentSizeMeters === 1800 && sent.scalePool.sizes.join(',') === '900,1800,3600' && sent.commitDraw?.count === 1],
    ['比例尺：点选 3.6 km 卡切换并提交对应候选', switched.status === 'switched' && switched.commitDraw?.sizeMeters === 3600 && switched.commitDraw?.score === 72],
  ],
  'alternative-switch': ([first, second]) => [
    ['备选切换：首轮交付 5.4 km 版', first.status === 'ok' && first.shape?.sizeMeters === 5400 && first.commitDraw?.count === 1],
    ['备选切换：短语切到 9 km 版（提交对应候选）', second.status === 'ok' && second.shape?.sizeMeters === 9000 && second.commitDraw?.sizeMeters === 9000],
  ],
  'plan-reference': ([turn]) => [
    ['参考版回退：交付橙色参考版且状态 reference', turn.status === 'reference' && turn.commitDraw?.reference === true && /非合格/.test(turn.reply)],
  ],
  'recommend-fallback': ([turn]) => [
    ['推荐失败回退：交付参考版且状态 reference', turn.status === 'reference' && turn.commitDraw?.reference === true && /参考/.test(turn.reply)],
  ],
  'guide-question': ([question, answered]) => [
    ['引导追问：出地点槽位与 5 个选项', question.status === 'guide' && question.guide?.slot === 'place' && question.guide.options.length === 5 && question.commitDraw === null],
    ['引导追问：点选地点后规划交付', answered.status === 'ok' && answered.commitDraw?.count === 1],
  ],
};

// ---------------------------------------------------------------------------
// 生成 → 契约断言 → 更新/对比
// ---------------------------------------------------------------------------

/** 依次跑全部场景（每个场景独立 controller，互不污染） */
async function generate() {
  const sections = [];
  for (const scenario of SCENARIOS) {
    const captures = await scenario.run();
    sections.push({ id: scenario.id, title: scenario.title, captures });
  }
  return sections;
}

const updateMode = process.argv.includes('--update');

// 白名单自检：reply 只允许 traceId/时间戳类字段被归一化，其它文本不得放宽
check('reply 白名单：traceId 归一化', sanitizeText('复制定位：t-9et2n62hmot') === '复制定位：<id>', sanitizeText('复制定位：t-9et2n62hmot'));
check(
  'reply 白名单：ISO / 时间戳归一化',
  sanitizeText('2026-11-09T23:26:04.123Z 开始 12:00:01') === '<timestamp> 开始 <timestamp>',
  sanitizeText('2026-11-09T23:26:04.123Z 开始 12:00:01'),
);
check(
  'reply 白名单：普通文本逐字保留',
  sanitizeText('已规划「五角星」路线：1.00 km · 路线贴合 78') === '已规划「五角星」路线：1.00 km · 路线贴合 78',
);

let generatedSections;
try {
  generatedSections = await generate();
} finally {
  restoreFetch();
}

check('场景数量固定为 10', generatedSections.length === 10, String(generatedSections.length));

// 契约断言：证明每个场景确实覆盖目标分支（不是"跑通即通过"）
for (const section of generatedSections) {
  const contract = SCENARIO_CONTRACTS[section.id];
  const shortId = section.id;
  if (typeof contract !== 'function') {
    check(`${shortId}：已登记场景契约`, false, '未登记 SCENARIO_CONTRACTS');
    continue;
  }
  for (const [label, ok] of contract(section.captures)) {
    check(label, ok, JSON.stringify(section.captures).slice(0, 400));
  }
}

// 结构断言：每轮捕获的字段口径固定（防止摘要漂移）
for (const section of generatedSections) {
  for (let index = 0; index < section.captures.length; index += 1) {
    const keys = Object.keys(section.captures[index]);
    check(
      `${section.id}[${index}]：捕获字段口径固定`,
      JSON.stringify(keys) === JSON.stringify(CAPTURE_KEYS),
      keys.join(','),
    );
  }
}

const generatedFixture = {
  _meta: {
    description:
      'controller 10 场景 golden 基线（T-B2d）。由 `node test/controller-golden.mjs --update` 生成；reply 已归一化 traceId/时间戳，其余字段逐字比较。',
    generatedFromCommit: currentCommit(),
  },
  scenarios: generatedSections,
};

if (updateMode) {
  writeFileSync(FIXTURE_PATH, `${JSON.stringify(generatedFixture, null, 2)}\n`, 'utf8');
  console.log(`\n[update] 已写入 ${FIXTURE_PATH}`);
  for (const section of generatedSections) {
    console.log(`  ${section.id}: ${section.captures.length} 轮 · status=${section.captures.map((turn) => turn.status).join(' / ')}`);
  }
} else if (!existsSync(FIXTURE_PATH)) {
  check('fixture 已入库', false, `缺少 ${FIXTURE_PATH}，请先运行 node test/controller-golden.mjs --update`);
} else {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
  const golden = Array.isArray(fixture.scenarios) ? fixture.scenarios : [];
  check('fixture：含 10 个固定场景', golden.length === generatedSections.length && golden.length === 10,
    `golden=${golden.length} generated=${generatedSections.length}`);
  const goldenIds = golden.map((item) => item.id);
  const generatedIds = generatedSections.map((item) => item.id);
  check('fixture：场景 id 与顺序一致', JSON.stringify(goldenIds) === JSON.stringify(generatedIds),
    `golden=${goldenIds.join(',')} generated=${generatedIds.join(',')}`);

  const result = diffJson({ scenarios: golden }, { scenarios: generatedSections });
  check('fixture：10 个场景逐字段 ===（0 差异）', result.equal === true,
    result.equal ? '' : `差异 ${result.totalDifferences} 处：${JSON.stringify(result.differences.slice(0, 6))}`);
  for (const difference of result.differences) {
    console.log(`  [diff] ${difference.path}: golden=${difference.before} current=${difference.after}`);
  }
  if (!result.equal) {
    console.log('\n提示：若差异是本方案预期的行为变化（B2 去重 / C 拆分的白名单差异），');
    console.log('      先确认变更理由后运行 `node test/controller-golden.mjs --update` 重生成基线并评审 diff。');
  }
  console.log(
    `\n[fixture] 生成于 commit ${fixture._meta?.generatedFromCommit ?? 'unknown'}；对比 ${generatedSections.length} 个场景 / ` +
      `${generatedSections.reduce((sum, section) => sum + section.captures.length, 0)} 轮`,
  );
}

/**
 * 取当前 HEAD 短 hash（仅 --update 写 meta 用；对比阶段不参与）。
 *
 * @returns {string} 短 hash 或 unknown
 */
function currentCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

console.log(`\nRESULT: ${checks - failures}/${checks} 项通过，失败 ${failures} 项`);
if (failures > 0) {
  process.exitCode = 1;
}
