/**
 * 推理过程「当前步骤等待计时」状态机（不碰 DOM，便于 Node 单测）。
 *
 * 背景：一轮对话里「理解需求…」等步骤内部会串 1~2 次非流式模型调用
 * （实测单次 10~50 秒，叠加轮廓重生成可到 65 秒），期间推理过程不产生新行，
 * 界面看起来像卡死。本模块只负责按秒产出耗时；ui.js 负责把耗时写进
 * 当前步骤行尾的后缀里。
 *
 * 约定：
 * - 同一时刻只计一步：追加新步骤前先 finish()，给上一步冻结「用时」；
 * - 定时器由本模块自己停，轮次结束/停止必须调 dispose()，避免泄漏；
 * - onTick(elapsedMs, phase)：phase='running' 在开始与每个刷新 tick 回调；
 *   phase='done' 在 finish 时回调一次。
 */

/**
 * 把耗时格式化成步骤行尾的后缀文案。
 *
 * @param {number} elapsedMs 已耗时（毫秒）
 * @param {'running'|'done'} [phase] running=还在等；done=已结束
 * @returns {string} 形如「（已等待 18s）」/「（用时 27s）」
 */
export function formatElapsedSuffix(elapsedMs, phase = 'running') {
  const value = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  const seconds = Math.floor(value / 1000);
  return phase === 'done' ? `（用时 ${seconds}s）` : `（已等待 ${seconds}s）`;
}

/**
 * 创建步骤等待计时器。
 *
 * @param {object} [options]
 * @param {(elapsedMs: number, phase: 'running'|'done') => void} [options.onTick] 计时回调
 * @param {() => number} [options.now] 时钟（测试注入）
 * @param {(fn: Function, ms: number) => any} [options.setIntervalFn] 定时器（测试注入）
 * @param {(id: any) => void} [options.clearIntervalFn] 清定时器（测试注入）
 * @param {number} [options.intervalMs] 刷新间隔（毫秒）
 * @returns {{start: Function, finish: Function, dispose: Function, elapsedMs: Function, running: boolean}}
 */
export function createStepClock({
  onTick = null,
  now = () => Date.now(),
  setIntervalFn = (fn, ms) => setInterval(fn, ms),
  clearIntervalFn = (id) => clearInterval(id),
  intervalMs = 1000,
} = {}) {
  let startedAt = null;
  let timer = null;
  const emit = (phase) => {
    if (typeof onTick === 'function') {
      onTick(elapsedMs(), phase);
    }
  };
  /** 当前已耗时；未开始计时返回 0 */
  function elapsedMs() {
    return startedAt === null ? 0 : Math.max(0, now() - startedAt);
  }
  /** 清掉内部定时器（不影响 startedAt） */
  function stopTimer() {
    if (timer !== null) {
      clearIntervalFn(timer);
      timer = null;
    }
  }
  /** 开始为新步骤计时（重复调用会先停掉上一个定时器，不产生 done 回调） */
  function start() {
    stopTimer();
    startedAt = now();
    emit('running');
    timer = setIntervalFn(() => {
      if (startedAt !== null) {
        emit('running');
      }
    }, intervalMs);
  }
  /** 结束当前步骤计时：冻结用时、回调 done，返回已耗时毫秒 */
  function finish() {
    if (startedAt === null) {
      return 0;
    }
    const ms = elapsedMs();
    stopTimer();
    startedAt = null;
    if (typeof onTick === 'function') {
      onTick(ms, 'done');
    }
    return ms;
  }
  /** 轮次结束/停止：停表，不再回调 */
  function dispose() {
    stopTimer();
    startedAt = null;
  }
  return { start, finish, dispose, elapsedMs, get running() { return startedAt !== null; } };
}
