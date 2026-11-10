/**
 * 会话（对话）存储：历史对话列表、消息、图形快照与本地持久化。
 *
 * 需求对应：R1 历史对话列表（新建/删除/空态，按最近活跃倒序）；R2/R3 每个对话内保留
 * 全部生成过的图形、可随时切回查看；R4 刷新不丢（localStorage，无法持久化时只降级并
 * 明确提示）；边界情况"存储容量持续增长"由五重上限 + 超限清理最旧兜底。
 *
 * 设计要点：
 * - 存储层是**唯一真相源**：界面从 store 读消息与图形，不再自己维护第二份；
 * - 写入按 300ms 去抖合并，关键节点（用户消息、轮次结果）由调用方 flush() 立即落盘；
 * - 任何存储异常（隐私模式、配额满）都不影响正常对话与画图，只降级为"仅内存"，
 *   并通过事件把状态告诉界面（界面提示"历史不会保存"）。
 *
 * 模块拆分（清理方案 2026-11-09 §3.3 C2，纯移动、行为零变化）：
 * - `store-persist.js`：序列化、localStorage 读写、去抖/字节裁剪、配额降级、恢复；
 * - `store-limits.js`：五重上限与级联瘦身（trimOldestOnce/enforceLimits）；
 * - 本文件：会话 records（会话/消息/图形/上下文 CRUD）与公开 API、事件广播、装配。
 *
 * 不直接依赖浏览器 API（storage 可注入），Node 测试可直接导入。
 */

import { createId } from '../log/core.js';
import { createLogger } from '../log/index.js';
import { DEFAULT_LIMITS, createSessionLimits } from './store-limits.js';
import { createSessionPersistence, createEmptyContext, clone, resolveStorage } from './store-persist.js';

/** 模块 logger：恢复/裁剪/降级等关键路径留痕（界面无感，排查时按 session.* 搜索） */
const log = createLogger('session/store');

/** 对话标题最大长度（首条用户消息截断） */
const TITLE_MAX_LENGTH = 24;

/**
 * 生成对话标题：取首条用户消息，超长截断。
 *
 * @param {string} text 首条用户消息
 * @returns {string} 标题
 */
export function titleFromFirstMessage(text) {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  if (!clean) {
    return '新对话';
  }
  return clean.length > TITLE_MAX_LENGTH ? `${clean.slice(0, TITLE_MAX_LENGTH)}…` : clean;
}

/**
 * 创建会话存储。
 *
 * @param {object} [options]
 * @param {Storage|null|undefined} [options.storage] 存储实现（缺省自动取 localStorage；
 *   显式传 null 表示禁用持久化——测试"不可持久化"降级路径用）
 * @param {string} [options.key] 存储键名
 * @param {object} [options.limits] 容量上限覆盖
 * @returns {object} 会话存储接口
 */
export function createSessionStore({ storage = undefined, key = undefined, limits = {} } = {}) {
  const store = resolveStorage(storage);
  const cap = { ...DEFAULT_LIMITS, ...limits };
  /** @type {Map<string, object>} 会话表（保持插入顺序，排序在 listSessions 里做） */
  const sessions = new Map();
  /** 当前所在对话 id */
  let activeId = null;
  /** 订阅者集合 */
  const listeners = new Set();
  /** 会话创建序号（updatedAt 同一毫秒内的稳定排序依据） */
  let sessionSeq = 0;

  /** 广播事件（订阅者异常不影响其它订阅者与业务）。 @param {object} event 事件 */
  function emit(event) {
    for (const listener of Array.from(listeners)) {
      try {
        listener(event);
      } catch {
        // 订阅者异常不影响其它订阅者与业务
      }
    }
  }

  /** 标记会话为最近活跃（列表按此倒序）。 @param {object} session 会话 */
  function touch(session) {
    session.updatedAt = Date.now();
  }

  /** 读当前会话 id（传给持久化/上限模块，避免它们直接持有 activeId） */
  function getActiveId() {
    return activeId;
  }

  /** 写当前会话 id（同上） */
  function setActiveId(id) {
    activeId = id;
  }

  /** 新建一个会话记录。 @param {{title?: string}} [options] @returns {object} 会话 */
  function makeSession({ title = '新对话' } = {}) {
    const now = Date.now();
    sessionSeq += 1;
    return {
      id: createId('s'),
      seq: sessionSeq,
      title,
      createdAt: now,
      updatedAt: now,
      messages: [],
      shapes: [],
      /** 当前查看的图形 id（null = 最新） */
      activeShapeId: null,
      /** 智能体上下文快照（对话历史 + 引导状态 + 待选候选快照） */
      context: createEmptyContext(),
    };
  }

  /**
   * 判断会话记录是否为"空对话"（除欢迎语外没有任何消息，也没有图形）。
   * 用于"点新对话时复用当前空对话"，避免历史列表凭空叠出两个空对话。
   *
   * @param {object|null|undefined} session 会话记录
   * @returns {boolean} 是否空对话
   */
  function isEmptySessionRecord(session) {
    if (!session) {
      return false;
    }
    if (session.shapes.length > 0) {
      return false;
    }
    return !session.messages.some((message) => message && message.kind !== 'welcome');
  }

  // 持久化与上限修剪装配（两个子模块都通过回调读写本文件的唯一真相源）
  const { enforceLimits, trimOldestOnce } = createSessionLimits({
    sessions,
    cap,
    listSessions,
    getSession,
    getActiveId,
    setActiveId,
    log,
  });
  const persistence = createSessionPersistence({
    storage: store,
    key,
    cap,
    sessions,
    makeSession,
    getActiveId,
    setActiveId,
    bumpSessionSeq: (seq) => {
      sessionSeq = Math.max(sessionSeq, seq);
    },
    trimOldestOnce,
    enforceLimits,
    emit,
    log,
  });
  const { restore, scheduleSave, flush } = persistence;

  /** 会话列表（按最近活跃倒序）。 @returns {Array<object>} 会话数组（字段浅拷贝） */
  function listSessions() {
    return Array.from(sessions.values())
      // 最近活跃倒序；updatedAt 同一毫秒内用创建序号兜底（稳定、可预期）
      .sort((a, b) => b.updatedAt - a.updatedAt || (b.seq ?? 0) - (a.seq ?? 0))
      .map((session) => ({
        id: session.id,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        // 欢迎语不计入"消息数"（它是面板的开场白，不是用户的一轮对话）
        messageCount: session.messages.filter((item) => item && item.kind !== 'welcome').length,
        shapeCount: session.shapes.length,
        activeShapeId: session.activeShapeId,
      }));
  }

  /** 取会话（内部记录）。 @param {string} id 会话 id @returns {object|null} */
  function getSession(id) {
    return sessions.get(id) || null;
  }

  /** 当前所在会话（没有则新建一个空会话）。 @returns {object} 会话 */
  function getActiveSession() {
    let session = activeId ? sessions.get(activeId) : null;
    if (!session) {
      session = makeSession();
      sessions.set(session.id, session);
      activeId = session.id;
      emit({ type: 'sessions' });
      emit({ type: 'active', sessionId: activeId });
      scheduleSave();
    }
    return session;
  }

  /**
   * 新建对话并切换过去（旧对话完整保留）。
   * reuseEmpty 为 true 时按"空对话不叠加"处理：当前是空对话则复用；当前无对话
   * （删除当前对话后的空态）返回 null，由调用方保持空对话，等用户真正发消息再创建。
   *
   * @param {{title?: string, reuseEmpty?: boolean}} [options] 标题/是否复用空对话
   * @returns {object|null} 新会话（复用时为当前空对话；无当前对话且复用模式返回 null）
   */
  function createSession({ title = '新对话', reuseEmpty = false } = {}) {
    if (reuseEmpty) {
      const current = activeId ? sessions.get(activeId) : null;
      if (!current) {
        // 空对话状态（无当前会话）：不创建，调用方保持空对话
        log.debug('session.create.keep-empty');
        return null;
      }
      if (isEmptySessionRecord(current)) {
        // 当前就是空对话：复用，不产生第二个空对话
        log.debug('session.create.reused', { sessionId: current.id });
        return current;
      }
    }
    const session = makeSession({ title });
    sessions.set(session.id, session);
    activeId = session.id;
    enforceLimits();
    emit({ type: 'sessions' });
    emit({ type: 'active', sessionId: activeId });
    scheduleSave();
    return session;
  }

  /** 切换到指定对话。 @param {string} id 会话 id @returns {object|null} 目标会话 */
  function switchSession(id) {
    if (!sessions.has(id) || id === activeId) {
      return sessions.get(id) || null;
    }
    activeId = id;
    emit({ type: 'active', sessionId: activeId });
    emit({ type: 'sessions' });
    scheduleSave();
    return sessions.get(id);
  }

  /** 删除对话（不可恢复）；删掉当前对话时停留在空对话。 @param {string} id @returns {boolean} */
  function deleteSession(id) {
    if (!sessions.has(id)) {
      return false;
    }
    sessions.delete(id);
    if (activeId === id) {
      activeId = null;
    }
    enforceLimits();
    emit({ type: 'sessions' });
    if (activeId === null) {
      emit({ type: 'active', sessionId: null });
    }
    scheduleSave();
    return true;
  }

  /** 追加消息。 @param {string} sessionId @param {object} message @returns {object|null} */
  function appendMessage(sessionId, message) {
    const session = getSession(sessionId);
    if (!session) {
      return null;
    }
    const record = {
      id: message.id || createId('m'),
      role: message.role || 'agent',
      kind: message.kind || 'chat',
      text: typeof message.text === 'string' ? message.text : '',
      image: message.image || null,
      steps: Array.isArray(message.steps) ? message.steps : [],
      traceId: message.traceId || null,
      outline: message.outline || null,
      options: Array.isArray(message.options) ? message.options : null,
      // 未配置兜底气泡的「去配置」入口标记（方案 §5.3，仅白名单字符串，旧数据缺省 null）
      action: typeof message.action === 'string' ? message.action : null,
      shapeId: message.shapeId || null,
      // 参考候选消息白名单（方案 §6.3）：候选回复与点击选择只留 id 关联，
      // 不在消息里重复保存候选几何（待选几何在 context.referenceChoice）
      referenceChoiceId: typeof message.referenceChoiceId === 'string' ? message.referenceChoiceId : null,
      selectedCandidateId: typeof message.selectedCandidateId === 'string' ? message.selectedCandidateId : null,
      // 多比例尺候选卡片摘要（需求 2026-11-09）：消息内持久化卡片数字字段（无路线几何），
      // 刷新后静态可见、不可点；活池在 controller 内存，随新输入/切会话/切城市失效
      scaleCandidates: Array.isArray(message.scaleCandidates) && message.scaleCandidates.length > 0
        ? message.scaleCandidates
        : null,
      scalePoolId: typeof message.scalePoolId === 'string' ? message.scalePoolId : null,
      scaleCurrentCardId: typeof message.scaleCurrentCardId === 'string' ? message.scaleCurrentCardId : null,
      scaleHiddenCount: Number.isFinite(message.scaleHiddenCount) ? message.scaleHiddenCount : null,
      status: message.status || 'done',
      at: Number(message.at) || Date.now(),
    };
    session.messages.push(record);
    // 标题取首条用户消息
    if (!session.titleLocked && record.role === 'user') {
      const first = session.messages.find((item) => item.role === 'user');
      if (first) {
        session.title = titleFromFirstMessage(first.text);
        session.titleLocked = true;
      }
    }
    touch(session);
    // 消息数上限必须在写入路径就生效：只在建/删会话时检查会让纯聊天会话无限增长
    enforceLimits();
    emit({ type: 'messages', sessionId });
    emit({ type: 'sessions' });
    scheduleSave();
    return record;
  }

  /** 更新消息（推理过程、状态、图形 id 等）。 @param {string} sessionId @param {string} messageId @param {object} patch @returns {object|null} */
  function updateMessage(sessionId, messageId, patch) {
    const session = getSession(sessionId);
    if (!session) {
      return null;
    }
    const message = session.messages.find((item) => item.id === messageId);
    if (!message) {
      return null;
    }
    Object.assign(message, patch);
    touch(session);
    emit({ type: 'messages', sessionId });
    scheduleSave();
    return message;
  }

  /** 追加图形快照。 @param {string} sessionId @param {object} shape @returns {object|null} */
  function appendShape(sessionId, shape) {
    const session = getSession(sessionId);
    if (!session) {
      return null;
    }
    const record = {
      id: shape.id || createId('sh'),
      turnId: shape.turnId || null,
      label: shape.label || '图形',
      shapeName: shape.shapeName || null,
      sizeMeters: shape.sizeMeters ?? null,
      rotationDeg: shape.rotationDeg ?? null,
      score: shape.score ?? null,
      reference: Boolean(shape.reference),
      // 结构化交付身份（方案 2026-11-08 §4.2）：实际交付了哪些对象、逐个可核对。
      // 随快照持久化，E2E 与交付结果 JSON 直接读这一份（不再靠拼接显示名反推）。
      deliveredObjects: Array.isArray(shape.deliveredObjects) ? shape.deliveredObjects : [],
      // 路线拓扑诊断留痕（缺陷清单 2026-11-06 Bug 4.4）：随快照进交付结果 JSON，
      // 真实链路自交率可统计（先记录不设门）
      uniqueCrossingCount: Number.isFinite(shape.uniqueCrossingCount) ? shape.uniqueCrossingCount : null,
      reusedEdgeRatio: Number.isFinite(shape.reusedEdgeRatio) ? shape.reusedEdgeRatio : null,
      geometry: shape.geometry || { outline: [], outlineParts: null, route: [], snapped: [] },
      at: Number(shape.at) || Date.now(),
    };
    session.shapes.push(record);
    session.activeShapeId = record.id;
    touch(session);
    enforceLimits();
    emit({ type: 'shapes', sessionId });
    emit({ type: 'sessions' });
    scheduleSave();
    return record;
  }

  /** 设置当前查看的图形（null = 回到最新）。 @param {string} sessionId @param {string|null} shapeId */
  function setActiveShape(sessionId, shapeId) {
    const session = getSession(sessionId);
    if (!session) {
      return;
    }
    session.activeShapeId = shapeId;
    emit({ type: 'active-shape', sessionId, shapeId });
    scheduleSave();
  }

  /** 当前查看的图形记录（null = 取最新一个）。 @param {string} sessionId @returns {object|null} */
  function getActiveShape(sessionId) {
    const session = getSession(sessionId);
    if (!session) {
      return null;
    }
    if (session.activeShapeId) {
      const found = session.shapes.find((item) => item.id === session.activeShapeId);
      if (found) {
        return found;
      }
    }
    return session.shapes.length > 0 ? session.shapes[session.shapes.length - 1] : null;
  }

  /**
   * 该对话**最近一次实际生成**的图形（需求 R2 的"最新"）。与 getActiveShape 的区别：
   * getActiveShape 记的是"用户上次查看哪一个"（会话内翻看历史图形时会变），R2 要求的是
   * "最近一次画出来的图形"——与最后一轮对话成败无关（最后一轮失败或被停止时仍指向此前）。
   *
   * @param {string} sessionId 会话 id
   * @returns {object|null} 图形记录
   */
  function getLatestShape(sessionId) {
    const session = getSession(sessionId);
    if (!session || session.shapes.length === 0) {
      return null;
    }
    return session.shapes[session.shapes.length - 1];
  }

  /** 保存智能体上下文快照（历史对话 + 引导状态 + 待选候选）。 @param {string} sessionId @param {object} context */
  function setContext(sessionId, context) {
    const session = getSession(sessionId);
    if (!session) {
      return;
    }
    session.context = {
      history: Array.isArray(context?.history) ? clone(context.history) : [],
      guide: context?.guide ? clone(context.guide) : null,
      guideState: context?.guideState ? clone(context.guideState) : null,
      referenceChoice: context?.referenceChoice ? clone(context.referenceChoice) : null,
    };
    scheduleSave();
  }

  /** 读取智能体上下文快照。 @param {string} sessionId @returns {object} */
  function getContext(sessionId) {
    return getSession(sessionId)?.context || createEmptyContext();
  }

  /** 清空全部历史（页面"清空历史"入口/测试用）。 */
  function clearAll() {
    sessions.clear();
    activeId = null;
    emit({ type: 'sessions' });
    emit({ type: 'active', sessionId: null });
    scheduleSave();
  }

  // 恢复历史（损坏/版本不符时由持久化层降级，不影响启动）
  restore();

  return {
    listSessions, // 会话列表（按最近活跃倒序）
    getSession, // 取会话内部记录
    getActiveSession, // 当前所在会话（没有则新建）
    isSessionEmpty: (id) => isEmptySessionRecord(sessions.get(id)), // 是否空对话（除欢迎语外无消息、无图形）
    getActiveId, // 当前所在会话 id
    createSession, // 新建对话
    switchSession, // 切换对话
    deleteSession, // 删除对话
    appendMessage, // 追加消息
    updateMessage, // 更新消息
    appendShape, // 追加图形
    setActiveShape, // 设置当前查看的图形
    getActiveShape, // 取当前查看的图形
    getLatestShape, // 取最近一次实际生成的图形（R2 的"最新"）
    setContext, // 保存上下文快照
    getContext, // 读取上下文快照
    clearAll, // 清空全部历史
    flush, // 立即落盘
    isStorageEnabled: persistence.isStorageEnabled, // 存储是否可用（界面据此提示"历史不会保存"）
    getStorageError: persistence.getStorageError, // 存储错误信息
    /** 订阅事件（返回取消订阅函数） */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
