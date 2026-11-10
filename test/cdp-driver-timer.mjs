/**
 * 公共 CDP 驱动定时器生命周期测试（清理方案 2026-11-09 §6.3 T-D4）。
 *
 * 覆盖缺陷 D4：旧驱动 `send()` 的超时定时器在成功 resolve 后从不 `clearTimeout`，
 * 每次调用都留一个 180s/240s/400s 的空转定时器，进程跑完还要多挂 3–6.7 分钟。
 * 收口到 `tools/lib/cdp-driver.mjs` 后，本文件用 FakeWebSocket + 假定时器钉住：
 * - `send()` resolve 后 0 个在途定时器；
 * - CDP error 响应 / 底层 `ws.send` 抛错 / 超时路径同样清掉定时器；
 * - `close()` 清空在途定时器，并 reject 未决 Promise（不再吊住事件循环）。
 *
 * 假定时器写法参照 `test/panel-toast.mjs`：覆写全局 `setTimeout/clearTimeout`，
 * 用 Map 统计在途定时器、手动 flush 模拟到点，不引入真实等待。
 *
 * 运行：node test/cdp-driver-timer.mjs
 * 退出码：0 全部通过；1 有断言失败。
 */

/** 假 WebSocket：记录发出的帧、可手工派发 message/open，便于精确控制结算时机 */
class FakeWebSocket {
  static OPEN = 1;

  static CONNECTING = 0;

  static CLOSED = 3;

  /** 本测试脚本创建的实例（按创建顺序），便于拿到 Cdp 内部那个 socket */
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.listeners = new Map();
    this.sent = [];
    this.closed = false;
    this.throwOnSend = false;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  dispatch(type, event) {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }

  send(data) {
    if (this.throwOnSend) throw new Error('send 失败（模拟连接已断）');
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatch('close', {});
  }

  /** 派发 open 事件（连接建立） */
  emitOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatch('open', {});
  }

  /** 派发一条 CDP 响应（result 或 error） */
  reply(message) {
    this.dispatch('message', { data: JSON.stringify(message) });
  }
}

/** 假定时器：记录注册/清理，支持手动到点（到点回调模拟"超时"） */
function makeFakeTimers() {
  const scheduled = new Map();
  let seq = 0;
  return {
    setTimeoutFn: (fn, ms) => {
      seq += 1;
      scheduled.set(seq, { fn, ms });
      return seq;
    },
    clearTimeoutFn: (id) => {
      scheduled.delete(id);
    },
    get size() {
      return scheduled.size;
    },
    /** 当前在途定时器的时长列表（断言 timeoutMs 选项生效） */
    pendingMs() {
      return [...scheduled.values()].map((entry) => entry.ms);
    },
    /** 触发全部到点回调（模拟时间流逝） */
    flush() {
      const entries = [...scheduled.values()];
      scheduled.clear();
      for (const entry of entries) entry.fn();
    },
  };
}

const fakeTimers = makeFakeTimers();
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

let checks = 0;
let failures = 0;

/**
 * 记录一条断言。
 *
 * @param {string} label 断言描述
 * @param {boolean} condition 断言条件
 * @param {string} [detail] 失败详情
 */
function check(label, condition, detail = '') {
  checks += 1;
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`[check] ${label} -> ${ok ? 'PASS' : `FAIL ${detail}`}`);
}

/**
 * 等待 Promise 被 reject，并断言错误信息。
 *
 * @param {Promise<*>} promise 目标 Promise
 * @param {RegExp} matcher 错误信息匹配
 * @param {string} label 断言描述
 * @returns {Promise<Error|null>} 捕获到的错误
 */
async function expectReject(promise, matcher, label) {
  try {
    const value = await promise;
    check(label, false, `未 reject，实际值：${JSON.stringify(value)}`);
    return null;
  } catch (error) {
    check(label, matcher.test(error.message), error.message);
    return error;
  }
}

globalThis.WebSocket = FakeWebSocket;
globalThis.setTimeout = fakeTimers.setTimeoutFn;
globalThis.clearTimeout = fakeTimers.clearTimeoutFn;

const { Cdp } = await import('../tools/lib/cdp-driver.mjs');

try {
  // ---------- 场景 1：成功路径 —— send resolve 后定时器必须清零（D4 回归点） ----------
  {
    const cdp = new Cdp('ws://fake/success', { timeoutMs: 180000 });
    const socket = FakeWebSocket.instances.at(-1);
    socket.readyState = FakeWebSocket.OPEN;
    await cdp.open();
    check('成功路径：open() 就绪后不注册定时器', fakeTimers.size === 0, String(fakeTimers.size));

    const pending = cdp.send('Runtime.evaluate', { expression: '1+1' });
    check('成功路径：send 在途时注册 1 个超时定时器', fakeTimers.size === 1, String(fakeTimers.size));
    check('成功路径：定时器时长取 timeoutMs 选项', fakeTimers.pendingMs()[0] === 180000, JSON.stringify(fakeTimers.pendingMs()));
    check(
      '成功路径：send 帧含 id/method/params',
      socket.sent.length === 1 && socket.sent[0].id === 1 && socket.sent[0].method === 'Runtime.evaluate',
      JSON.stringify(socket.sent),
    );

    socket.reply({ id: 1, result: { result: { type: 'number', value: 2 } } });
    const result = await pending;
    check('成功路径：resolve 透传 CDP result', result.result.value === 2, JSON.stringify(result));
    check('成功路径：resolve 后 0 个在途定时器（D4 泄漏已修）', fakeTimers.size === 0, String(fakeTimers.size));

    fakeTimers.flush();
    check('成功路径：结算后 flush 无残留定时器', fakeTimers.size === 0, String(fakeTimers.size));
    cdp.close();
    check('成功路径：close 后仍 0 个在途定时器', fakeTimers.size === 0, String(fakeTimers.size));
  }

  // ---------- 场景 2：CDP error 响应 —— reject 且清定时器 ----------
  {
    const cdp = new Cdp('ws://fake/error');
    const socket = FakeWebSocket.instances.at(-1);
    socket.readyState = FakeWebSocket.OPEN;
    const pending = cdp.send('Page.navigate', { url: 'about:blank' });
    check('错误响应：在途 1 个定时器', fakeTimers.size === 1, String(fakeTimers.size));
    socket.reply({ id: 1, error: { message: '方法不存在', data: { code: -32601 } } });
    await expectReject(pending, /方法不存在/, '错误响应：reject 且带 CDP 错误信息');
    check('错误响应：reject 后 0 个在途定时器', fakeTimers.size === 0, String(fakeTimers.size));
    cdp.close();
  }

  // ---------- 场景 3：超时路径 —— 到点 reject，且迟到响应被忽略 ----------
  {
    const cdp = new Cdp('ws://fake/timeout', { timeoutMs: 240000 });
    const socket = FakeWebSocket.instances.at(-1);
    socket.readyState = FakeWebSocket.OPEN;
    const pending = cdp.send('Runtime.evaluate', { expression: 'await new Promise(() => {})' });
    check('超时路径：超时前有 1 个定时器', fakeTimers.size === 1, String(fakeTimers.size));
    fakeTimers.flush();
    await expectReject(pending, /CDP 调用超时：Runtime\.evaluate/, '超时路径：到点 reject（错误信息含方法名）');
    check('超时路径：reject 后 0 个在途定时器', fakeTimers.size === 0, String(fakeTimers.size));
    let lateThrew = null;
    try {
      socket.reply({ id: 1, result: { result: { value: 1 } } });
    } catch (error) {
      lateThrew = error;
    }
    check('超时路径：迟到响应被安全忽略', lateThrew === null, lateThrew ? lateThrew.message : '');
    cdp.close();
  }

  // ---------- 场景 4：close() —— 清空在途定时器并 reject 未决 Promise ----------
  {
    const cdp = new Cdp('ws://fake/close', { timeoutMs: 400000 });
    const socket = FakeWebSocket.instances.at(-1);
    socket.readyState = FakeWebSocket.OPEN;
    const first = cdp.send('Page.enable');
    const second = cdp.send('Runtime.enable');
    check('close 前：两个在途调用 → 2 个定时器', fakeTimers.size === 2, String(fakeTimers.size));
    const firstSettled = first.then(() => null, (error) => error);
    const secondSettled = second.then(() => null, (error) => error);
    cdp.close();
    const [firstError, secondError] = await Promise.all([firstSettled, secondSettled]);
    check('close：第一个未决调用 reject', firstError instanceof Error && /CDP 连接已关闭/.test(firstError.message), String(firstError?.message));
    check('close：第二个未决调用 reject', secondError instanceof Error && /CDP 连接已关闭/.test(secondError.message), String(secondError?.message));
    check('close：在途定时器全部清空', fakeTimers.size === 0, String(fakeTimers.size));
    check('close：底层 WebSocket 已 close', socket.closed === true, String(socket.closed));
    let closeAgainThrew = null;
    try {
      cdp.close();
    } catch (error) {
      closeAgainThrew = error;
    }
    check('close：重复调用幂等不抛错', closeAgainThrew === null, closeAgainThrew ? closeAgainThrew.message : '');
  }

  // ---------- 场景 5：底层 ws.send 抛错 —— reject 且清定时器 ----------
  {
    const cdp = new Cdp('ws://fake/send-throw');
    const socket = FakeWebSocket.instances.at(-1);
    socket.readyState = FakeWebSocket.OPEN;
    socket.throwOnSend = true;
    const pending = cdp.send('Runtime.evaluate');
    await expectReject(pending, /send 失败/, '发送异常：底层 ws.send 抛错 → reject');
    check('发送异常：reject 后 0 个在途定时器', fakeTimers.size === 0, String(fakeTimers.size));
    cdp.close();
  }

  // ---------- 场景 6：open() 事件路径 —— 不注册定时器 ----------
  {
    const cdp = new Cdp('ws://fake/open', { timeoutMs: 120000 });
    const socket = FakeWebSocket.instances.at(-1);
    check('连接建立：open() 等待期间无定时器', fakeTimers.size === 0, String(fakeTimers.size));
    const opening = cdp.open();
    socket.emitOpen();
    await opening;
    check('连接建立：open 事件后 resolve', socket.readyState === FakeWebSocket.OPEN);
    check('连接建立：open() 不留下定时器', fakeTimers.size === 0, String(fakeTimers.size));
    cdp.close();
  }

  check('全局：全部场景结束后 0 个在途定时器', fakeTimers.size === 0, String(fakeTimers.size));
} finally {
  // 还原全局，避免影响其它（被 run-tests 串跑）测试进程内的真实定时器
  globalThis.WebSocket = undefined;
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
}

console.log(`\n[summary] ${checks - failures}/${checks} 项通过，失败 ${failures} 项`);
if (failures > 0) {
  process.exitCode = 1;
}
