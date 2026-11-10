/**
 * 推荐链路"失败回退参考版"分支的回归测试（清理方案 2026-11-09 §2.10-1）。
 *
 * 缺陷：`controller.js` 的 `executeRecommend` 在"推荐失败 → 退回最像的一版参考版"
 * 分支里引用了 `objectAudit`，但该变量**只在 `executePlan` 作用域内声明**，
 * 推荐链路作用域没有这个标识符 → 可选链 `objectAudit?.deliveredObjects` 保护不了
 * 未声明标识符，该分支**必现 ReferenceError**（用户看到"路线规划失败"类异常）。
 *
 * 本测试构造"引擎推荐失败、但 bests 里有可回退候选"的场景：
 * - 修复前：send() 抛 ReferenceError（用例失败）；
 * - 修复后：正常回退参考版，提交一次 reference=true，并带上交付对象身份。
 *
 * 运行：node test/controller-recommend-fallback.mjs
 */

import { createAgentController } from '../web/src/agent/controller.js';
import { placeConfig } from './fixtures/place-config.mjs';

let failures = 0;

/** 断言工具 */
function check(label, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) {
    failures += 1;
  }
  console.log(`[check] ${label} -> ${ok ? 'PASS' : `FAIL ${detail}`}`);
}

/** 构造一次规划结果（metrics 覆盖回复文案用到的字段） */
function makePlannedResult({ score, shapeName = '心形', tag }) {
  return {
    shapeName,
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
      orderedOutlineMeanRatio: 0.02,
      orderedOutlineMaxRatio: 0.04,
      orderedRouteMeanRatio: 0.02,
      orderedRouteMaxRatio: 0.05,
      outlineMeanMeters: 20,
      outlineMaxMeters: 40,
      featureCount: 0,
      featureCoveredCount: 0,
      featureCoverage: 1,
      frechetMaxRatio: 0.1,
      aspectDistortionRatio: 0.1,
      featureGapRetainRatio: 1,
    },
    __tag: tag,
  };
}

/** LLM 意图返回队列 */
let intentQueue = [];

globalThis.fetch = async (url, options) => {
  // 路网数据请求：返回空路网（地点解析走 POI 别名表即可命中）
  if (typeof url === 'string' && url.includes('/data/guangzhou-roads.json')) {
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ roads: [] }),
    };
  }
  const payload = intentQueue.shift() || {
    action: 'chat',
    shape: null,
    customShape: null,
    place: null,
    rotationDeg: null,
    reply: '收到',
  };
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
};

/**
 * 跑一轮推荐对话。
 *
 * @param {object} options 选项
 * @param {object} options.outcome 引擎 recommend 返回值
 * @param {object} options.intent LLM 意图
 * @returns {Promise<{result: object, calls: Array<object>}>} 结果
 */
async function runTurn({ outcome, intent }) {
  intentQueue = [intent];
  const calls = [];
  const engine = {
    plan: async (options) => {
      calls.push({ type: 'plan', options });
      return null;
    },
    recommend: async (options) => {
      calls.push({ type: 'recommend', options });
      return outcome;
    },
    commitDraw: (result, options) => {
      calls.push({ type: 'commitDraw', result, options });
      return { id: 'shape-1' };
    },
    clearDraw: () => calls.push({ type: 'clearDraw' }),
    formatMinutes: (minutes) => `${Math.round(minutes)} 分钟`,
  };
  const map = { getCenter: () => ({ lat: 23.12, lng: 113.32 }) };
  const controller = createAgentController({ map, engine, placeConfig });
  const result = await controller.send({ text: intent.reply || '看看能画什么' });
  return { result, calls };
}

// ---------- 场景 1：推荐失败 + 有可回退候选 → 回退参考版（缺陷复现点） ----------
{
  const result = makePlannedResult({ score: 55, tag: 'FALLBACK' });
  const outcome = {
    status: 'failed',
    drawn: null,
    best: null,
    stage: 3,
    stageLabel: '大档补搜',
    triedCount: 800,
    bests: {
      heart: {
        score: 55,
        adjustedScore: 55,
        sizeMeters: 1200,
        rotationDeg: 0,
        center: { lat: 23.12, lng: 113.32 },
        result,
      },
    },
    offset: { meters: 0, text: '' },
  };

  let thrown = null;
  let turn = null;
  try {
    turn = await runTurn({
      outcome,
      intent: {
        action: 'recommend',
        shape: null,
        customShape: null,
        place: '珠江新城',
        rotationDeg: null,
        reply: '看看能画什么',
      },
    });
  } catch (error) {
    thrown = error;
  }

  check(
    '推荐失败回退参考版：不抛异常（修复前必现 ReferenceError）',
    thrown === null,
    thrown ? `${thrown.name}: ${thrown.message}` : '',
  );

  if (turn) {
    const commits = turn.calls.filter((call) => call.type === 'commitDraw');
    const clears = turn.calls.filter((call) => call.type === 'clearDraw');
    check('推荐失败回退参考版：提交参考版一次', commits.length === 1 && commits[0].options?.reference === true, `commit ${commits.length}`);
    check('推荐失败回退参考版：不清空图层', clears.length === 0, `clear ${clears.length}`);
    check(
      '推荐失败回退参考版：提交携带 deliveredObjects（数组，不抛错）',
      Array.isArray(commits[0]?.options?.deliveredObjects),
      JSON.stringify(commits[0]?.options?.deliveredObjects),
    );
    check(
      '推荐失败回退参考版：回复标注非合格参考',
      typeof turn.result.reply === 'string' && turn.result.reply.includes('参考'),
      turn.result.reply?.slice(0, 120),
    );
    check(
      '推荐失败回退参考版：planned.status = reference',
      turn.result.planned?.status === 'reference',
      JSON.stringify(turn.result.planned?.status),
    );
  }
}

// ---------- 场景 2：推荐失败 + 无可回退候选 → 诚实失败（对照，不回退） ----------
{
  const outcome = {
    status: 'failed',
    drawn: null,
    best: null,
    stage: 3,
    stageLabel: '大档补搜',
    triedCount: 800,
    bests: {
      heart: {
        score: 55,
        adjustedScore: 55,
        sizeMeters: 1200,
        rotationDeg: 0,
        center: { lat: 23.12, lng: 113.32 },
        // 无路线 → 不可回退
        result: { ...makePlannedResult({ score: 55, tag: 'NO-ROUTE' }), routeLatLngs: [] },
      },
    },
    offset: { meters: 0, text: '' },
  };

  let thrown = null;
  let turn = null;
  try {
    turn = await runTurn({
      outcome,
      intent: {
        action: 'recommend',
        shape: null,
        customShape: null,
        place: '珠江新城',
        rotationDeg: null,
        reply: '看看能画什么',
      },
    });
  } catch (error) {
    thrown = error;
  }

  check('推荐失败无回退候选：不抛异常', thrown === null, thrown ? `${thrown.name}: ${thrown.message}` : '');
  if (turn) {
    const commits = turn.calls.filter((call) => call.type === 'commitDraw');
    check('推荐失败无回退候选：不提交任何图形', commits.length === 0, `commit ${commits.length}`);
    check(
      '推荐失败无回退候选：诚实失败（planned.status = failed）',
      turn.result.planned?.status === 'failed',
      JSON.stringify(turn.result.planned?.status),
    );
  }
}

// ---------- 汇总 ----------
console.log('');
console.log(failures === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${failures} checks)`);
process.exitCode = failures === 0 ? 0 : 1;
