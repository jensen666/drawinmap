/**
 * 会话存储的持久化层（由 `session/store.js` 拆出 · 清理方案 2026-11-09 §3.3 C2）。
 *
 * 职责：
 * - 序列化（顶层 `{v, savedAt, activeId, sessions}`，结构与旧版逐字一致）；
 * - localStorage 读写：300ms 去抖合并、`flush()` 立即落盘、字节超限先裁剪；
 * - 配额异常（隐私模式/容量满）降级：尽量瘦身后重试，仍失败只降级为"仅内存"，
 *   绝不清空当前对话；
 * - 恢复：损坏/版本不符时忽略（版本不符先备份原始数据），恢复后按上限修剪。
 *
 * 不直接依赖浏览器 API（storage 可注入），Node 测试可直接导入。会话表、记录工厂、
 * 上限修剪与事件广播都由 store.js 注入——本模块不持有第二份会话数据。
 */

/** localStorage 键名 */
export const STORAGE_KEY = 'drawinmap.sessions.v1';

/** 持久化格式版本（字段结构变化时递增） */
export const STORAGE_VERSION = 1;

/**
 * 解析存储实现：显式传入优先；未传时探测 localStorage。
 *
 * 部分浏览器在隐私模式下访问 window.localStorage 属性本身会抛 SecurityError：
 * 必须兜住，否则整个页面启动失败（R4：无法持久化不影响正常对话与画图）。
 *
 * @param {Storage|null|undefined} storage 调用方显式传入的存储（null = 禁用持久化）
 * @returns {Storage|null} 实际使用的存储（null = 仅内存）
 */
export function resolveStorage(storage = undefined) {
  if (storage !== undefined) {
    return storage;
  }
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/**
 * 空上下文快照（历史对话 + 引导状态 + 待选候选的初始值/兜底值）。
 * 每次都返回新对象：调用方拿到后可能整体替换或读取，不共享引用以避免串会话。
 *
 * @returns {{history: Array, guide: object|null, guideState: object|null, referenceChoice: object|null}} 空上下文
 */
export function createEmptyContext() {
  return { history: [], guide: null, guideState: null, referenceChoice: null };
}

/**
 * 深拷贝（结构化克隆，退化时用 JSON）——避免存储里的对象被外部改坏。
 *
 * @param {*} value 任意可序列化数据
 * @returns {*} 副本
 */
export function clone(value) {
  if (value === null || value === undefined) {
    return value;
  }
  try {
    if (typeof structuredClone === 'function') {
      return structuredClone(value);
    }
  } catch {
    // 含函数等不可克隆内容时退回复制
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

/**
 * 创建持久化控制器。
 *
 * @param {object} options
 * @param {Storage|null} options.storage 存储实现（null = 禁用持久化）
 * @param {string} options.key 存储键名
 * @param {object} options.cap 生效容量上限（含 maxBytes）
 * @param {Map<string, object>} options.sessions 会话表（store.js 持有的唯一真相源）
 * @param {() => object} options.makeSession 新建会话记录（恢复时复用其默认字段）
 * @param {() => string|null} options.getActiveId 读当前会话 id
 * @param {(id: string|null) => void} options.setActiveId 写当前会话 id
 * @param {(seq: number) => void} options.bumpSessionSeq 恢复时同步会话创建序号
 * @param {() => boolean} options.trimOldestOnce 级联瘦身一次（裁剪/配额重试共用）
 * @param {() => boolean} options.enforceLimits 按上限修剪
 * @param {(event: object) => void} options.emit 广播事件
 * @param {(...args: Array) => void} options.log 模块 logger（沿用 session/store 模块名）
 * @returns {{
 *   restore: () => void,
 *   scheduleSave: () => void,
 *   flush: () => void,
 *   isStorageEnabled: () => boolean,
 *   getStorageError: () => string|null
 * }} 持久化接口
 */
export function createSessionPersistence({
  storage,
  key = STORAGE_KEY,
  cap,
  sessions,
  makeSession,
  getActiveId,
  setActiveId,
  bumpSessionSeq,
  trimOldestOnce,
  enforceLimits,
  emit,
  log,
}) {
  /** 存储是否可用（不可用时降级为"仅内存"） */
  let storageEnabled = Boolean(storage);
  /** 存储错误信息（界面上提示"历史不会保存"） */
  let storageError = null;
  /** 去抖保存计时器 */
  let saveTimer = null;

  /**
   * 广播存储状态变化（可用/不可用）。
   */
  function emitStorage() {
    emit({ type: 'storage', enabled: storageEnabled, error: storageError });
  }

  /**
   * 序列化当前状态。
   *
   * @returns {object} 持久化载荷
   */
  function serialize() {
    return {
      v: STORAGE_VERSION,
      savedAt: Date.now(),
      activeId: getActiveId(),
      sessions: Array.from(sessions.values()),
    };
  }

  /**
   * 真正写入存储（超限/配额异常时降级或裁剪）。
   */
  function writeNow() {
    if (!storageEnabled || !storage) {
      return;
    }
    let payload = JSON.stringify(serialize());
    // 字节超限：先削最旧会话的图形，再削最旧会话（每轮重新排序）。
    // 与配额重试共用 trimOldestOnce：被削图形的消息引用同步清空、唯一会话受保护，
    // 裁剪后要广播，否则界面仍显示已被删掉的会话/图形。
    let trimmedByBytes = false;
    if (payload.length > cap.maxBytes) {
      let guard = 0;
      while (payload.length > cap.maxBytes && guard < 200) {
        guard += 1;
        if (!trimOldestOnce()) {
          break;
        }
        trimmedByBytes = true;
        payload = JSON.stringify(serialize());
      }
      if (trimmedByBytes) {
        log.warn('session.store.trimmed', { maxBytes: cap.maxBytes, bytes: payload.length });
      }
    }
    try {
      storage.setItem(key, payload);
      storageError = null;
    } catch (error) {
      // 配额满/隐私模式：先尽量瘦身（丢最旧图形 → 丢最旧消息 → 丢最旧会话）再重试；
      // 仍失败则只降级为"仅内存"，**不清空当前对话**（用户正在用的内容不能因写盘失败消失）。
      let lastError = error;
      let recovered = false;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        if (!trimOldestOnce()) {
          break;
        }
        try {
          storage.setItem(key, JSON.stringify(serialize()));
          recovered = true;
          break;
        } catch (retryError) {
          lastError = retryError;
        }
      }
      if (recovered) {
        storageError = '存储空间不足，已清理最旧数据';
        log.warn('session.store.quota.recovered', { maxBytes: cap.maxBytes });
      } else {
        storageEnabled = false;
        storageError = lastError instanceof Error ? lastError.message : String(lastError);
        log.error('session.store.degraded', { message: storageError }, lastError);
      }
      // 内存被瘦身过（或已降级）：广播让历史列表与图形切换控件与真实数据一致
      emit({ type: 'sessions' });
      if (getActiveId() === null) {
        emit({ type: 'active', sessionId: null });
      }
      emitStorage();
    }
    // 内存数据被字节裁剪过（即使写盘成功）：广播一次，保证历史列表/图形切换控件
    // 与真实数据一致（被裁掉的图形，其消息里的"查看此图形"引用已在上面同步清空）
    if (trimmedByBytes) {
      emit({ type: 'sessions' });
      if (getActiveId() === null) {
        emit({ type: 'active', sessionId: null });
      }
    }
  }

  /**
   * 去抖保存（写入密集时合并）。
   */
  function scheduleSave() {
    if (!storageEnabled || !storage) {
      return;
    }
    if (saveTimer !== null) {
      return;
    }
    saveTimer = setTimeout(() => {
      saveTimer = null;
      writeNow();
    }, 300);
  }

  /**
   * 从存储恢复（损坏/版本不符时忽略，保持空历史）。
   */
  function restore() {
    if (!storage) {
      return;
    }
    let raw = null;
    try {
      raw = storage.getItem(key);
    } catch (error) {
      storageEnabled = false;
      storageError = error instanceof Error ? error.message : String(error);
      emitStorage();
      return;
    }
    if (!raw) {
      return;
    }
    let payload = null;
    try {
      payload = JSON.parse(raw);
    } catch {
      storageError = '历史数据无法解析，已忽略';
      log.warn('session.restore.corrupt', { bytes: raw.length });
      emitStorage();
      return;
    }
    if (!payload || payload.v !== STORAGE_VERSION || !Array.isArray(payload.sessions)) {
      // 版本不符/结构损坏：保留一份原始数据备份再忽略，避免下一次写入把旧数据彻底覆盖
      storageError = `历史数据版本不兼容（v=${payload?.v ?? 'unknown'}），已忽略并备份`;
      log.warn('session.restore.version-mismatch', { version: payload?.v ?? null, expected: STORAGE_VERSION });
      try {
        storage.setItem(`${key}.bak`, raw);
      } catch {
        // 备份失败不影响主流程
      }
      emitStorage();
      return;
    }
    for (const item of payload.sessions) {
      if (!item || typeof item.id !== 'string') {
        continue;
      }
      const session = makeSession();
      session.id = item.id;
      session.seq = Number(item.seq) || session.seq;
      session.title = typeof item.title === 'string' ? item.title : '新对话';
      // 已有标题视为已锁定：首条用户消息被上限裁掉后，标题不会漂移成后来的消息
      session.titleLocked = Boolean(item.title);
      session.createdAt = Number(item.createdAt) || session.createdAt;
      session.updatedAt = Number(item.updatedAt) || session.updatedAt;
      // 逐条过滤非法记录（跨版本/手工损坏的 null 条目会让渲染与计数抛错）
      session.messages = Array.isArray(item.messages)
        ? item.messages.filter((message) => message && typeof message === 'object')
        : [];
      session.shapes = Array.isArray(item.shapes)
        ? item.shapes.filter((shape) => shape && typeof shape === 'object')
        : [];
      session.activeShapeId = item.activeShapeId ?? null;
      session.context =
        item.context && typeof item.context === 'object'
          ? {
              history: Array.isArray(item.context.history) ? item.context.history : [],
              guide: item.context.guide ?? null,
              guideState: item.context.guideState ?? null,
              // 待选参考候选快照（方案 §6.3：上下文恢复白名单接受该字段；
              // 已选定/结构非法的快照只留历史意义，不恢复成可点击状态）
              referenceChoice:
                item.context.referenceChoice && item.context.referenceChoice.status === 'awaiting-selection'
                  ? item.context.referenceChoice
                  : null,
            }
          : createEmptyContext();
      // 刷新时正在等待回复的用户消息：标记为"未完成"，不留"思考中"残影
      for (const message of session.messages) {
        if (message && message.status === 'waiting') {
          message.status = 'interrupted';
        }
      }
      sessions.set(session.id, session);
      bumpSessionSeq(session.seq);
    }
    setActiveId(
      typeof payload.activeId === 'string' && sessions.has(payload.activeId) ? payload.activeId : null,
    );
    enforceLimits();
    log.info('session.restore', { sessions: sessions.size, activeId: getActiveId(), bytes: raw.length });
  }

  /**
   * 立即落盘（页面隐藏/卸载时调用，避免去抖窗口内丢数据）。
   */
  function flush() {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    writeNow();
  }

  return {
    restore,
    scheduleSave,
    flush,
    /** 存储是否可用（不可用时界面提示"历史不会保存"） */
    isStorageEnabled: () => storageEnabled,
    /** 存储错误信息 */
    getStorageError: () => storageError,
  };
}
