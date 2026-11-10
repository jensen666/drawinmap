/**
 * 分片让出主线程（清理方案 2026-11-09 §5.4-3.3：从 candidates.js / joint-refine.js
 * 两份逐字重复的实现里抽出，并修掉"共享单例 onmessage 被覆盖"的并发缺陷）。
 *
 * 为什么用 MessageChannel 而非 setTimeout：后台标签页/失焦窗格的 setTimeout 会被
 * 浏览器钳到约 1s（实测 12s 搜索预算只跑了 42 个候选），MessageChannel 的
 * postMessage 不受定时器节流，让出开销稳定在亚毫秒。
 *
 * 修掉的缺陷：原实现两处都用「模块级共享 channel + 每次调用覆盖 port1.onmessage」。
 * 两次 yield 重叠时，后一次覆盖了前一次的 onmessage，前一个 Promise 永远不 resolve
 * ——表现为搜索随机卡死（伪死锁）。这里改成「一个 channel + 解析器 FIFO 队列」：
 * 消息按 postMessage 顺序到达，每次取一个解析器，调用之间互不覆盖。
 */

/** 待让出的解析器队列（FIFO） */
const pending = [];

/** 共享的 MessageChannel（懒创建） */
let channel = null;

/**
 * 取（或创建）共享 channel。
 *
 * @returns {{port1: object, port2: object}} MessageChannel 端口对
 */
function ensureChannel() {
  if (!channel) {
    channel = new MessageChannel();
    const { port1, port2 } = channel;
    port1.onmessage = () => {
      const resolve = pending.shift();
      if (resolve) {
        resolve();
      }
    };
  }
  return channel;
}

/**
 * 让出主线程一拍（异步）。
 *
 * @returns {Promise<void>} 让出后 resolve
 */
export function yieldToUi() {
  return new Promise((resolve) => {
    pending.push(resolve);
    const { port2 } = ensureChannel();
    port2.postMessage(null);
  });
}
