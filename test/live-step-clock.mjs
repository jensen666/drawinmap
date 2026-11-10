/**
 * 推理过程等待计时测试（Node 直接运行，注入假时钟与假定时器，无 DOM、无网络）。
 *
 * 背景：用户反馈「理解需求…」一步卡很久（实测 17~65 秒），原因是非流式模型调用
 * 期间推理过程没有新行。修复方案让进行中步骤行尾每秒刷新「已等待 Ns」，
 * 步骤完成冻结为「用时 Ns」。计时状态机单独成模块，本文件验证：
 * 开始/每秒刷新/完成冻结/停止清理/格式文案，以及定时器不泄漏。
 *
 * 运行：node test/live-step-clock.mjs
 */

import { createStepClock, formatElapsedSuffix } from '../web/src/agent/live-step-clock.js';

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

/** 假时钟 + 假定时器：可手动推进时间、手动触发 tick、统计清理次数 */
function makeHarness() {
  let currentTime = 0;
  let scheduled = null;
  let clearedCount = 0;
  const ticks = [];
  const clock = createStepClock({
    onTick: (elapsedMs, phase) => ticks.push({ elapsedMs, phase }),
    now: () => currentTime,
    setIntervalFn: (fn, ms) => {
      scheduled = { fn, ms };
      return 1;
    },
    clearIntervalFn: (id) => {
      clearedCount += 1;
      scheduled = null;
      return id;
    },
  });
  return {
    clock,
    ticks,
    get clearedCount() {
      return clearedCount;
    },
    get scheduled() {
      return scheduled;
    },
    advance(ms) {
      currentTime += ms;
    },
    /** 触发一次定时器回调（模拟 1 秒到点） */
    tick() {
      scheduled?.fn();
    },
  };
}

// ---------- 场景 1：格式化文案 ----------
{
  check('格式：进行中 0 秒', formatElapsedSuffix(0) === '（已等待 0s）', formatElapsedSuffix(0));
  check('格式：进行中 18.9 秒向下取整', formatElapsedSuffix(18900) === '（已等待 18s）', formatElapsedSuffix(18900));
  check('格式：完成态', formatElapsedSuffix(64900, 'done') === '（用时 64s）', formatElapsedSuffix(64900, 'done'));
  check('格式：非法耗时按 0 处理', formatElapsedSuffix(Number.NaN) === '（已等待 0s）', formatElapsedSuffix(Number.NaN));
  check('格式：负数按 0 处理', formatElapsedSuffix(-500, 'done') === '（用时 0s）', formatElapsedSuffix(-500, 'done'));
}

// ---------- 场景 2：开始 → 每秒刷新 ----------
{
  const harness = makeHarness();
  harness.clock.start();
  check('开始：立即回调一次 running 0ms', harness.ticks.length === 1 && harness.ticks[0].elapsedMs === 0 && harness.ticks[0].phase === 'running', JSON.stringify(harness.ticks));
  check('开始：注册 1000ms 定时器', harness.scheduled?.ms === 1000);
  check('开始：running=true', harness.clock.running === true);

  harness.advance(1000);
  harness.tick();
  check('刷新：1 秒后 running 1000ms', harness.ticks.at(-1).elapsedMs === 1000 && harness.ticks.at(-1).phase === 'running', JSON.stringify(harness.ticks.at(-1)));
  harness.advance(500);
  harness.tick();
  check('刷新：1.5 秒后 running 1500ms', harness.ticks.at(-1).elapsedMs === 1500, JSON.stringify(harness.ticks.at(-1)));
}

// ---------- 场景 3：完成冻结「用时」并清定时器 ----------
{
  const harness = makeHarness();
  harness.clock.start();
  harness.advance(27615);
  const elapsed = harness.clock.finish();
  check('完成：返回真实耗时', elapsed === 27615, `实际 ${elapsed}`);
  check('完成：回调 once done', harness.ticks.at(-1).elapsedMs === 27615 && harness.ticks.at(-1).phase === 'done', JSON.stringify(harness.ticks.at(-1)));
  check('完成：定时器已清', harness.scheduled === null && harness.clearedCount === 1, `cleared=${harness.clearedCount}`);
  check('完成：running=false', harness.clock.running === false);
  check('完成：重复 finish 不再回调', harness.clock.finish() === 0 && harness.ticks.at(-1).phase === 'done', JSON.stringify(harness.ticks));
}

// ---------- 场景 4：dispose 停表且不再回调（轮次结束/停止） ----------
{
  const harness = makeHarness();
  harness.clock.start();
  harness.advance(3000);
  harness.tick();
  const before = harness.ticks.length;
  harness.clock.dispose();
  harness.tick();
  harness.advance(5000);
  harness.tick();
  check('停止：dispose 后定时器已清', harness.scheduled === null && harness.clearedCount === 1, `cleared=${harness.clearedCount}`);
  check('停止：dispose 后无新回调', harness.ticks.length === before, `新增 ${harness.ticks.length - before}`);
  check('停止：dispose 后 running=false', harness.clock.running === false);
  check('停止：dispose 后 finish 无回调', harness.clock.finish() === 0 && harness.ticks.length === before);
}

// ---------- 场景 5：连续两步不叠加定时器（新步骤前先 finish） ----------
{
  const harness = makeHarness();
  harness.clock.start();
  harness.advance(10000);
  harness.clock.finish();
  harness.clock.start();
  harness.advance(3000);
  harness.tick();
  check('连续步骤：第二步耗时从 0 重新计', harness.ticks.at(-1).elapsedMs === 3000, JSON.stringify(harness.ticks.at(-1)));
  check('连续步骤：只保留一个定时器', harness.scheduled !== null && harness.clearedCount === 1, `cleared=${harness.clearedCount}`);
  harness.clock.dispose();
}

console.log(`\n[summary] ${checks - failures}/${checks} 项通过，失败 ${failures} 项`);
if (failures > 0) {
  process.exitCode = 1;
}
