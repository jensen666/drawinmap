/**
 * 会话存储的容量上限与级联瘦身（由 `session/store.js` 拆出 · 清理方案 2026-11-09 §3.3 C2）。
 *
 * 职责（纯数据操作，不碰 localStorage、不广播事件）：
 * - 五重上限常量：会话数 / 单会话消息数 / 单会话图形数 / 全部会话合计图形数 / 持久化字节数；
 * - `enforceLimits`：创建/删除会话、追加消息/图形时按上限修剪（最旧先走）；
 * - `trimOldestOnce`：字节裁剪与配额重试共用的"裁一份"（丢最旧图形 → 丢一半消息 → 删最旧会话），
 *   含唯一会话保护（B3 行为修正：任何裁剪路径都不删当前唯一会话）。
 *
 * 级联瘦身必须与图形引用清理成对发生（dropOldestShape → forgetShapeRefs）：被删图形的
 * 消息里若还留着 shapeId，"查看此图形"按钮点了会没反应。
 *
 * 依赖注入约定：会话表、排序/取会话函数、activeId 读写与 logger 都由 store.js 传入，
 * 保证"存储层是唯一真相源"——本模块不持有第二份状态，也不直接依赖浏览器 API。
 */

/** 默认容量上限（边界情况：存储容量持续增长） */
export const DEFAULT_LIMITS = Object.freeze({
  /** 最多保留的对话数 */
  maxSessions: 20,
  /** 单个对话最多保留的消息数 */
  maxMessagesPerSession: 120,
  /** 单个对话最多保留的图形数 */
  maxShapesPerSession: 30,
  /** 全部对话合计最多保留的图形数 */
  maxTotalShapes: 120,
  /** 持久化最大字节数（近似 UTF-16 长度），超出先清理最旧 */
  maxBytes: 3.5 * 1024 * 1024,
});

/**
 * 创建容量上限与级联瘦身控制器。
 *
 * @param {object} options
 * @param {Map<string, object>} options.sessions 会话表（store.js 持有的唯一真相源）
 * @param {object} options.cap 生效上限（DEFAULT_LIMITS 与调用方覆盖合并后）
 * @param {() => Array<object>} options.listSessions 会话列表（按最近活跃倒序）
 * @param {(id: string) => object|null} options.getSession 取会话内部记录
 * @param {() => string|null} options.getActiveId 读当前会话 id
 * @param {(id: string|null) => void} options.setActiveId 写当前会话 id
 * @param {(...args: Array) => void} options.log 模块 logger（沿用 session/store 模块名）
 * @returns {{enforceLimits: () => boolean, trimOldestOnce: () => boolean}} 修剪入口
 */
export function createSessionLimits({ sessions, cap, listSessions, getSession, getActiveId, setActiveId, log }) {
  /**
   * 清掉消息里对已删除图形的引用（与图形删除必须成对发生，避免"查看此图形"按钮点了没反应）。
   *
   * @param {object} session 会话
   * @param {string} removedId 被删图形的 id
   */
  function forgetShapeRefs(session, removedId) {
    for (const message of session.messages) {
      if (message && message.shapeId === removedId) {
        message.shapeId = null;
      }
    }
    if (session.activeShapeId === removedId) {
      session.activeShapeId = null;
    }
  }

  /**
   * 删除会话里最旧的图形（含消息引用清理）。
   *
   * @param {object} session 会话
   * @returns {boolean} 是否删掉了
   */
  function dropOldestShape(session) {
    if (!session || session.shapes.length === 0) {
      return false;
    }
    const removed = session.shapes.shift();
    forgetShapeRefs(session, removed.id);
    return true;
  }

  /**
   * 修剪超出上限的数据（最旧的先走）。
   *
   * @returns {boolean} 本次是否发生了修剪
   */
  function enforceLimits() {
    let trimmed = false;
    // 会话数：按最近活跃倒序，保留最新的 N 个（每轮重新排序，避免重复删同一个）
    while (sessions.size > cap.maxSessions) {
      const ordered = listSessions();
      if (ordered.length === 0) {
        break;
      }
      sessions.delete(ordered[ordered.length - 1].id);
      trimmed = true;
    }
    // 单会话消息数/图形数
    for (const session of sessions.values()) {
      while (session.messages.length > cap.maxMessagesPerSession) {
        session.messages.shift();
        trimmed = true;
      }
      while (session.shapes.length > cap.maxShapesPerSession) {
        dropOldestShape(session);
        trimmed = true;
      }
    }
    // 全部会话合计图形数：从最旧会话开始削
    let totalShapes = 0;
    for (const session of sessions.values()) {
      totalShapes += session.shapes.length;
    }
    while (totalShapes > cap.maxTotalShapes) {
      const orderedSessions = listSessions();
      let removedAny = false;
      for (let i = orderedSessions.length - 1; i >= 0; i -= 1) {
        const session = sessions.get(orderedSessions[i].id);
        if (!session || session.shapes.length === 0) {
          continue;
        }
        dropOldestShape(session);
        totalShapes -= 1;
        removedAny = true;
        trimmed = true;
        break;
      }
      if (!removedAny) {
        break;
      }
    }
    if (trimmed) {
      log.debug('session.limits.trimmed', {
        sessions: sessions.size,
        totalShapes,
        limits: { maxSessions: cap.maxSessions, maxMessages: cap.maxMessagesPerSession, maxShapes: cap.maxShapesPerSession, maxTotalShapes: cap.maxTotalShapes },
      });
    }
    return trimmed;
  }

  /**
   * 从最旧会话裁掉一份数据（丢图形 → 丢一半消息 → 删会话），供字节裁剪与配额重试共用。
   *
   * 唯一会话保护（行为修正，B3）：删会话只发生在"存在多个会话"时——此前字节裁剪路径
   * 会把唯一会话删掉，导致用户正在用的对话凭空消失；现在两条裁剪路径行为一致。
   * 图形删除必须走 dropOldestShape（同步清空消息里的引用），否则"查看此图形"会点了没反应。
   *
   * @returns {boolean} 是否发生了裁剪（false = 已经没有可裁的数据）
   */
  function trimOldestOnce() {
    const ordered = listSessions();
    const oldest = ordered[ordered.length - 1];
    if (!oldest) {
      return false;
    }
    const session = getSession(oldest.id);
    if (session && session.shapes.length > 0) {
      dropOldestShape(session);
      return true;
    }
    if (session && session.messages.length > 1) {
      session.messages.splice(0, Math.ceil(session.messages.length / 2));
      return true;
    }
    // 只剩一个会话（或会话已不存在）：不删当前唯一会话
    if (ordered.length > 1) {
      sessions.delete(oldest.id);
      if (getActiveId() === oldest.id) {
        setActiveId(null);
      }
      return true;
    }
    return false;
  }

  return { enforceLimits, trimOldestOnce };
}
