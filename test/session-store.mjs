/**
 * 会话存储 + 图形快照 + 取消工具 单元测试（无浏览器、无网络）。
 *
 * 运行：node test/session-store.mjs
 */

import { createSessionStore, titleFromFirstMessage } from '../web/src/session/store.js';
import { DEFAULT_LIMITS } from '../web/src/session/store-limits.js';
import { STORAGE_KEY, STORAGE_VERSION, createEmptyContext, clone } from '../web/src/session/store-persist.js';
import { captureGeometry, restoreGeometry, compactPoints, geometryPointCount } from '../web/src/session/geometry.js';
import { createAbortError, isAborted, isAbortError, linkSignals, throwIfAborted } from '../web/src/cancel.js';

let failures = 0;
function check(label, condition, detail = '') {
  if (!condition) failures += 1;
  console.log(`[check] ${label} -> ${condition ? 'PASS' : `FAIL ${detail}`}`);
}

/** 内存版 Storage（模拟 localStorage，可选配额异常） */
function createMemoryStorage({ quotaBytes = Infinity } = {}) {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      if (value.length > quotaBytes) {
        const error = new Error('QuotaExceededError');
        error.name = 'QuotaExceededError';
        throw error;
      }
      map.set(key, value);
    },
    removeItem: (key) => map.delete(key),
    get size() {
      return map.size;
    },
  };
}

/* ---------------- 标题 ---------------- */

check('标题取首条用户消息', titleFromFirstMessage('在广州塔附近走个心形') === '在广州塔附近走个心形');
check('标题超长截断', titleFromFirstMessage('a'.repeat(40)).length === 25);
check('标题空白回退', titleFromFirstMessage('   ') === '新对话');

/* ---------------- 会话与消息 ---------------- */

{
  const storage = createMemoryStorage();
  const store = createSessionStore({ storage });
  const session = store.getActiveSession();
  store.appendMessage(session.id, { role: 'user', text: '画个心形' });
  store.appendMessage(session.id, { role: 'agent', text: '好的' });

  const list = store.listSessions();
  check('历史列表含 1 个对话', list.length === 1, `实际 ${list.length}`);
  check('标题取首条用户消息', list[0].title === '画个心形', list[0].title);
  check('消息数正确', list[0].messageCount === 2, String(list[0].messageCount));

  // 新建对话：旧对话完整保留
  const second = store.createSession();
  check('新建后有 2 个对话', store.listSessions().length === 2);
  check('切换到新对话', store.getActiveId() === second.id);
  const back = store.listSessions().find((item) => item.id === session.id);
  check('旧对话消息仍在', back && back.messageCount === 2);

  // 切换对话
  store.switchSession(session.id);
  check('切回旧对话成功', store.getActiveId() === session.id);

  // 删除对话
  store.deleteSession(second.id);
  check('删除后剩 1 个对话', store.listSessions().length === 1);
}

/* ---------------- 空对话复用：空态点"新对话"不叠加空对话 ---------------- */

{
  const store = createSessionStore({ storage: createMemoryStorage() });
  // 智能体面板启动：没有当前会话时保持空对话（不预建空会话）
  check('无当前会话时 activeId 为 null', store.getActiveId() === null);
  check('无当前会话时列表为空', store.listSessions().length === 0);

  // 无当前会话点"新对话"：保持空对话，不创建会话
  const none = store.createSession({ reuseEmpty: true });
  check('空对话状态点新对话不创建会话', none === null && store.listSessions().length === 0);

  // 已有当前空对话（只有欢迎语）时点"新对话"：复用，不叠加
  const session = store.getActiveSession();
  store.appendMessage(session.id, { role: 'agent', text: '欢迎语', kind: 'welcome' });
  check('仅欢迎语的会话是空对话', store.isSessionEmpty(session.id) === true);
  const reused = store.createSession({ reuseEmpty: true });
  check('空对话点新对话复用当前会话', Boolean(reused) && reused.id === session.id);
  check('空对话点新对话不增加列表条数', store.listSessions().length === 1, String(store.listSessions().length));

  // 有真实消息后点"新对话"：正常新建
  store.appendMessage(session.id, { role: 'user', text: '画个心形' });
  check('有消息后不再是空对话', store.isSessionEmpty(session.id) === false);
  const created = store.createSession({ reuseEmpty: true });
  check('非空对话点新对话会新建', Boolean(created) && created.id !== session.id);
  check('非空对话点新对话后列表 2 条', store.listSessions().length === 2, String(store.listSessions().length));

  // 有图形也算非空对话
  const shapeOnly = store.createSession();
  store.appendShape(shapeOnly.id, { geometry: { outline: [], outlineParts: null, route: [], snapped: [] } });
  check('有图形不算空对话', store.isSessionEmpty(shapeOnly.id) === false);
}

/* ---------------- 删除当前对话：真正删除，不自动补建空会话 ---------------- */

{
  const store = createSessionStore({ storage: createMemoryStorage() });
  const first = store.getActiveSession();
  store.appendMessage(first.id, { role: 'user', text: '第一段对话' });
  const second = store.createSession();
  store.appendMessage(second.id, { role: 'user', text: '第二段对话' });

  // 删除当前对话：activeId 置空，列表只剩旧对话（不自动补建新会话）
  check('删除当前对话返回成功', store.deleteSession(second.id) === true);
  check('删除当前对话后无当前会话', store.getActiveId() === null);
  check('删除当前对话后列表只剩 1 条', store.listSessions().length === 1, String(store.listSessions().length));

  // 空对话状态再点"新对话"：保持空对话，不补建
  const again = store.createSession({ reuseEmpty: true });
  check('删除当前对话后点新对话不补建', again === null && store.listSessions().length === 1);

  // 删除最后一个对话：列表为空、仍是空对话状态
  store.deleteSession(first.id);
  check('删除最后一个对话后列表为空', store.listSessions().length === 0);
  check('删除最后一个对话后仍是空对话状态', store.getActiveId() === null);
}

/* ---------------- 删除当前对话的事件契约：广播 active(null) 让界面进入空对话 ---------------- */

{
  const store = createSessionStore({ storage: createMemoryStorage() });
  const session = store.getActiveSession();
  store.appendMessage(session.id, { role: 'user', text: '会被删除的对话' });
  const events = [];
  store.subscribe((event) => events.push(event));
  store.deleteSession(session.id);
  check('删除当前对话广播 sessions 事件', events.some((event) => event.type === 'sessions'));
  check(
    '删除当前对话广播 active(null)（界面据此进入空对话）',
    events.some((event) => event.type === 'active' && event.sessionId === null),
  );
}

/* ---------------- 持久化（刷新不丢） ---------------- */

{
  const storage = createMemoryStorage();
  const store = createSessionStore({ storage });
  const session = store.getActiveSession();
  store.appendMessage(session.id, { role: 'user', text: '在心形那轮回复上点查看此图形' });
  store.appendShape(session.id, {
    shapeName: '心形',
    sizeMeters: 1200,
    rotationDeg: 0,
    score: 72,
    reference: false,
    geometry: { outline: [[23.1, 113.3]], outlineParts: null, route: [[23.1, 113.3]], snapped: [] },
  });
  store.flush();

  // 模拟刷新：新建 store 读同一份存储
  const restored = createSessionStore({ storage });
  const list = restored.listSessions();
  check('刷新后历史列表保留', list.length === 1, String(list.length));
  check('刷新后标题保留', list[0].title === '在心形那轮回复上点查看此图形');
  check('刷新后消息保留', list[0].messageCount === 1);
  check('刷新后图形保留', list[0].shapeCount === 1);
  const restoredSession = restored.getActiveSession();
  check('刷新后回到最后所在对话', restoredSession.id === session.id);
  check('刷新后图形可取回', Boolean(restored.getActiveShape(restoredSession.id)));
}

/* ---------------- 等待中的回复：刷新后不留"思考中"残影 ---------------- */

{
  const storage = createMemoryStorage();
  const store = createSessionStore({ storage });
  const session = store.getActiveSession();
  store.appendMessage(session.id, { role: 'user', text: '刷新前发出的消息', status: 'waiting' });
  store.flush();

  const restored = createSessionStore({ storage });
  const restoredSession = restored.getActiveSession();
  const message = restoredSession.messages[0];
  check('用户消息在刷新后保留', Boolean(message));
  check('等待状态转为"未完成"', message.status === 'interrupted', message.status);
  check('不残留"思考中"状态', !restoredSession.messages.some((item) => item.status === 'waiting'));
}

/* ---------------- 容量上限（存储不无限膨胀） ---------------- */

{
  const storage = createMemoryStorage();
  const store = createSessionStore({ storage, limits: { maxSessions: 2, maxShapesPerSession: 2 } });
  const first = store.getActiveSession();
  store.createSession();
  store.createSession();
  check('会话数受上限约束', store.listSessions().length === 2, String(store.listSessions().length));
  check('最旧会话被清理', !store.listSessions().some((item) => item.id === first.id));

  const session = store.getActiveSession();
  // 先让一条消息引用某个图形，再触发图形上限：断言被清理图形的消息引用真的被清空（非空断言）
  const message = store.appendMessage(session.id, { role: 'agent', text: '带图形的回复' });
  const firstShape = store.appendShape(session.id, {
    shapeName: '图形0',
    geometry: { outline: [[23.1, 113.3]], outlineParts: null, route: [], snapped: [] },
  });
  store.updateMessage(session.id, message.id, { shapeId: firstShape.id });
  for (let i = 1; i < 5; i += 1) {
    store.appendShape(session.id, {
      shapeName: `图形${i}`,
      geometry: { outline: [[23.1, 113.3]], outlineParts: null, route: [], snapped: [] },
    });
  }
  const kept = store.getSession(session.id);
  check('单会话图形数受上限约束', kept.shapes.length === 2, String(kept.shapes.length));
  const keptMessage = kept.messages.find((item) => item.id === message.id);
  check(
    '被清理图形的消息引用同步清空（非空断言）',
    Boolean(keptMessage) && keptMessage.shapeId === null,
    String(keptMessage?.shapeId),
  );
  check('被清理图形不在序列里', !kept.shapes.some((item) => item.id === firstShape.id));
}

/* ---------------- 单会话消息数上限：写入路径即生效 ---------------- */

{
  const store = createSessionStore({ storage: createMemoryStorage(), limits: { maxMessagesPerSession: 5 } });
  const session = store.getActiveSession();
  for (let i = 0; i < 9; i += 1) {
    store.appendMessage(session.id, { role: 'user', text: `消息${i}` });
  }
  const messages = store.getSession(session.id).messages;
  check('纯聊天会话消息数受上限约束', messages.length === 5, String(messages.length));
  check('超限时清理最旧消息（保留最新）', messages[messages.length - 1].text === '消息8', messages[messages.length - 1].text);
}

/* ---------------- 存储不可用（隐私模式）：降级为仅内存并给出提示 ---------------- */

{
  const store = createSessionStore({ storage: null });
  const session = store.getActiveSession();
  store.appendMessage(session.id, { role: 'user', text: '没有 localStorage' });
  check('无存储时仍可正常对话', store.getSession(session.id).messages.length === 1);
  check('无存储时标记为不可保存', store.isStorageEnabled() === false);
}

/* ---------------- 存储配额异常：降级而不是抛错 ---------------- */

{
  const storage = createMemoryStorage({ quotaBytes: 200 });
  const store = createSessionStore({ storage });
  const session = store.getActiveSession();
  for (let i = 0; i < 30; i += 1) {
    store.appendMessage(session.id, { role: 'user', text: `第 ${i} 条很长的消息`.repeat(6) });
  }
  // 去抖窗口内尚未真正写盘：必须先 flush 才走到配额失败/降级分支
  store.flush();
  check('配额异常不抛错', store.getSession(session.id) !== null);
  check(
    '配额异常降级为仅内存（明确状态，不留假象）',
    store.isStorageEnabled() === false || Boolean(store.getStorageError()),
    `enabled=${store.isStorageEnabled()} error=${store.getStorageError()}`,
  );
  check('降级后当前对话内容不被清空', store.getSession(session.id).messages.length > 0);
}

/* ---------------- 裁剪路径的唯一会话保护（T-B3b：任何裁剪路径都不删当前会话） ---------------- */

{
  // 路径 1：字节超限裁剪（storage 可写、无配额故障）——单会话且已无可裁数据时不得删当前会话。
  // 改前行为（B3 之前）：字节裁剪路径没有唯一会话保护，会把唯一会话删掉、activeId 置空。
  const storage = createMemoryStorage();
  const store = createSessionStore({ storage, limits: { maxBytes: 128 } });
  const session = store.getActiveSession();
  store.appendMessage(session.id, { role: 'user', text: '这条消息让序列化超过很小的字节上限' });
  store.flush();
  check(
    '字节裁剪：唯一会话不被删除（B3 行为修正）',
    store.getSession(session.id) !== null && store.getActiveId() === session.id,
    `session=${Boolean(store.getSession(session.id))} activeId=${store.getActiveId()}`,
  );
  check(
    '字节裁剪：唯一会话的消息不丢',
    store.getSession(session.id).messages.length === 1,
    String(store.getSession(session.id).messages.length),
  );
}

{
  // 路径 2：配额异常重试裁剪（setItem 抛 QuotaExceededError）——单会话永远保留在内存里
  const storage = createMemoryStorage({ quotaBytes: 200 });
  const store = createSessionStore({ storage });
  const session = store.getActiveSession();
  for (let i = 0; i < 20; i += 1) {
    store.appendMessage(session.id, { role: 'user', text: `第 ${i} 条消息`.repeat(8) });
  }
  store.flush();
  check(
    '配额异常：唯一会话不被删除',
    store.getSession(session.id) !== null && store.getActiveId() === session.id,
    `session=${Boolean(store.getSession(session.id))} activeId=${store.getActiveId()}`,
  );
  check('配额异常：当前对话至少保留一条消息（不清空）', store.getSession(session.id).messages.length >= 1);
}

{
  // 路径 3：多会话时字节裁剪仍正常工作（最旧会话可被裁掉，当前会话与 activeId 保留）
  const storage = createMemoryStorage();
  const store = createSessionStore({ storage, limits: { maxBytes: 300 } });
  const first = store.getActiveSession();
  store.appendMessage(first.id, { role: 'user', text: '旧会话消息'.repeat(10) });
  const second = store.createSession();
  store.appendMessage(second.id, { role: 'user', text: '新会话消息'.repeat(10) });
  store.switchSession(second.id);
  store.flush();
  const ids = store.listSessions().map((item) => item.id);
  check('多会话字节裁剪：仍会裁掉最旧会话', !ids.includes(first.id) && ids.includes(second.id), ids.join(','));
  check('多会话字节裁剪：当前会话保留且 activeId 不变', store.getActiveId() === second.id, String(store.getActiveId()));
}

/* ---------------- 序列化结构 fixture（T-B3b：B3 改动不改变持久化结构） ---------------- */

{
  const storage = createMemoryStorage();
  const store = createSessionStore({ storage });
  const session = store.getActiveSession();
  store.appendMessage(session.id, { id: 'm-fixed', role: 'user', text: '画个心形' });
  store.appendMessage(session.id, { id: 'm-fixed-2', role: 'agent', text: '好的' });
  store.appendShape(session.id, {
    id: 'sh-fixed',
    shapeName: '心形',
    geometry: { outline: [], outlineParts: null, route: [], snapped: [] },
  });
  store.setContext(session.id, { history: [{ role: 'user', content: '画个心形' }] });
  store.flush();
  const payload = JSON.parse(storage.getItem('drawinmap.sessions.v1'));
  check('序列化：顶层键集固定', Object.keys(payload).join(',') === 'v,savedAt,activeId,sessions', Object.keys(payload).join(','));
  const record = payload.sessions[0];
  check(
    '序列化：会话记录键集固定',
    Object.keys(record).join(',') === 'id,seq,title,createdAt,updatedAt,messages,shapes,activeShapeId,context,titleLocked',
    Object.keys(record).join(','),
  );
  check(
    '序列化：消息记录键集固定',
    Object.keys(record.messages[0]).join(',')
      === 'id,role,kind,text,image,steps,traceId,outline,options,action,shapeId,referenceChoiceId,selectedCandidateId,scaleCandidates,scalePoolId,scaleCurrentCardId,scaleHiddenCount,status,at',
    Object.keys(record.messages[0]).join(','),
  );
  check(
    '序列化：图形记录键集固定',
    Object.keys(record.shapes[0]).join(',')
      === 'id,turnId,label,shapeName,sizeMeters,rotationDeg,score,reference,deliveredObjects,uniqueCrossingCount,reusedEdgeRatio,geometry,at',
    Object.keys(record.shapes[0]).join(','),
  );
  check(
    '序列化：上下文键集固定（空 context 收敛不改变结构）',
    Object.keys(record.context).join(',') === 'history,guide,guideState,referenceChoice',
    Object.keys(record.context).join(','),
  );
  check(
    '序列化：上下文历史逐字保留',
    record.context.history.length === 1
      && record.context.history[0].role === 'user'
      && record.context.history[0].content === '画个心形',
    JSON.stringify(record.context.history),
  );
  check(
    '序列化：消息白名单字段值正确',
    record.messages[0].id === 'm-fixed'
      && record.messages[0].role === 'user'
      && record.messages[0].status === 'done'
      && record.messages[0].text === '画个心形',
    JSON.stringify(record.messages[0]),
  );
  check(
    '序列化：图形白名单字段值正确',
    record.shapes[0].id === 'sh-fixed' && record.shapes[0].shapeName === '心形' && record.activeShapeId === 'sh-fixed',
    JSON.stringify(record.shapes[0]),
  );
}

/* ---------------- 图形快照：抽稀与还原 ---------------- */

{
  // 一条 1000 点的直线（冗余点），抽稀后应显著变少且端点保留
  const route = [];
  for (let i = 0; i < 1000; i += 1) {
    route.push([23.1 + i * 0.00001, 113.3]);
  }
  const geometry = captureGeometry({
    outlineLatLngs: [[23.11, 113.31], [23.12, 113.32]],
    routeLatLngs: route,
    snapped: [{ lat: 23.11, lng: 113.31 }],
  });
  check('抽稀后点数显著减少', geometry.route.length < 60, String(geometry.route.length));
  check('抽稀保留首点', geometry.route[0][0] === 23.1, String(geometry.route[0][0]));
  check('抽稀保留末点', geometry.route[geometry.route.length - 1][0] > 23.1099);

  const restored = restoreGeometry(geometry);
  check('还原后路线点数一致', restored.route.length === geometry.route.length);
  check('还原后轮廓仍是二维数组', Array.isArray(restored.outline[0]));
  check('还原后吸附点转成对象', typeof restored.snapped[0].lat === 'number');
  check('还原后键名与绘制层一致', 'route' in restored && 'outline' in restored && 'snapped' in restored);
  check('点数统计正确', geometryPointCount(geometry) > 0);
}

/* ---------------- 图形序列与"最新"语义 ---------------- */

{
  const store = createSessionStore({ storage: createMemoryStorage() });
  const session = store.getActiveSession();
  store.appendShape(session.id, { shapeName: '心形', geometry: { outline: [], outlineParts: null, route: [], snapped: [] } });
  store.appendShape(session.id, { shapeName: '五角星', geometry: { outline: [], outlineParts: null, route: [], snapped: [] } });
  const active = store.getActiveShape(session.id);
  check('默认查看最新图形', active.shapeName === '五角星', active.shapeName);

  const first = store.getSession(session.id).shapes[0];
  store.setActiveShape(session.id, first.id);
  check('可切到指定图形', store.getActiveShape(session.id).shapeName === '心形');
  check('getLatestShape 始终是最近生成的图形（R2 语义）', store.getLatestShape(session.id).shapeName === '五角星');

  // R2：切走再切回/刷新后，进入对话展示"最近一次实际生成的图形"，不是"上次查看的"
  const other = store.createSession();
  store.switchSession(session.id);
  check('切回对话后 getLatestShape 仍为最新图形', store.getLatestShape(session.id).shapeName === '五角星');
  check('查看位置与最新图形是两个概念（active 仍是上次查看）', store.getActiveShape(session.id).shapeName === '心形');
  store.deleteSession(other.id);
}

/* ---------------- 立即落盘（发送时保存，不等去抖窗口） ---------------- */

{
  const storage = createMemoryStorage();
  const store = createSessionStore({ storage });
  const session = store.getActiveSession();
  store.appendMessage(session.id, { role: 'user', text: '发送瞬间就应落盘' });
  // 不调用 flush、也不等 300ms：追加后立即新建 store 读取同一存储
  const reader = createSessionStore({ storage });
  const list = reader.listSessions();
  check('追加消息后未 flush 不保证落盘（去抖语义对照）', list.length === 0 || list[0].messageCount === 0);
  store.flush();
  const reader2 = createSessionStore({ storage });
  check('flush 后立即落盘（刷新不丢用户输入）', reader2.listSessions()[0].messageCount === 1);
}

/* ---------------- 损坏数据 / 版本不符：忽略但备份，不影响启动 ---------------- */

{
  const storage = createMemoryStorage();
  storage.setItem('drawinmap.sessions.v1', '{ 这不是 JSON');
  const store = createSessionStore({ storage });
  check('损坏 JSON 不抛错', store.listSessions().length === 0);
  check('损坏 JSON 给出存储提示', Boolean(store.getStorageError()), store.getStorageError());
  check('损坏 JSON 后仍可正常写入', (() => {
    const session = store.getActiveSession();
    store.appendMessage(session.id, { role: 'user', text: '损坏后继续用' });
    store.flush();
    return store.getSession(session.id).messages.length === 1;
  })());
}

{
  const storage = createMemoryStorage();
  const raw = JSON.stringify({ v: 999, activeId: 's-x', sessions: [{ id: 's-x', messages: [] }] });
  storage.setItem('drawinmap.sessions.v1', raw);
  const store = createSessionStore({ storage });
  check('版本不符不抛错', store.listSessions().length === 0);
  check('版本不符给出提示', Boolean(store.getStorageError()), store.getStorageError());
  check('版本不符保留原始数据备份', storage.getItem('drawinmap.sessions.v1.bak') === raw);
}

{
  const storage = createMemoryStorage();
  storage.setItem(
    'drawinmap.sessions.v1',
    JSON.stringify({
      v: 1,
      activeId: 's-1',
      sessions: [
        { id: 's-1', title: '脏数据', updatedAt: Date.now(), messages: [null, { id: 'm1', role: 'user', text: '有效消息', at: 1 }], shapes: [null] },
      ],
    }),
  );
  const store = createSessionStore({ storage });
  const session = store.getSession('s-1');
  check('非法消息/图形条目被过滤', session.messages.length === 1 && session.shapes.length === 0);
  check('非法条目不影响计数', store.listSessions()[0].messageCount === 1);
}

/* ---------------- 标题锁定：首条用户消息被裁剪后标题不漂移 ---------------- */

{
  const storage = createMemoryStorage();
  const store = createSessionStore({ storage, limits: { maxMessagesPerSession: 2 } });
  const session = store.getActiveSession();
  store.appendMessage(session.id, { role: 'user', text: '标题来自这条消息' });
  store.appendMessage(session.id, { role: 'agent', text: '回复' });
  store.appendMessage(session.id, { role: 'user', text: '第三条会把第一条挤掉' });
  store.flush();
  const restored = createSessionStore({ storage, limits: { maxMessagesPerSession: 2 } });
  restored.appendMessage(restored.getActiveId(), { role: 'user', text: '刷新后的新消息' });
  check('首条消息被裁剪后标题不漂移', restored.listSessions()[0].title === '标题来自这条消息', restored.listSessions()[0].title);
}

/* ---------------- 浏览器禁用 localStorage（属性访问抛错）：不拖垮启动 ---------------- */

{
  let store = null;
  let threw = false;
  try {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError: storage disabled');
      },
    });
    store = createSessionStore();
  } catch {
    threw = true;
  } finally {
    delete globalThis.localStorage;
  }
  check('localStorage 访问抛错不拖垮创建', !threw && store !== null);
  check('localStorage 不可用时降级为仅内存', store.isStorageEnabled() === false);
}

/* ---------------- C2 拆分契约：持久化/上限模块的公开常量、工具与 API 方法集 ---------------- */

{
  // 拆分目标（清理方案 2026-11-09 §3.3 C2）：store-persist.js / store-limits.js 承接
  // 序列化落盘与上限瘦身后，常量与工具只能有**一份**，公开 API 方法集不得因拆分改名/增减。
  check(
    'C2 拆分：默认容量上限单源（5 项）',
    DEFAULT_LIMITS.maxSessions === 20 &&
      DEFAULT_LIMITS.maxMessagesPerSession === 120 &&
      DEFAULT_LIMITS.maxShapesPerSession === 30 &&
      DEFAULT_LIMITS.maxTotalShapes === 120 &&
      DEFAULT_LIMITS.maxBytes === 3.5 * 1024 * 1024,
    JSON.stringify(DEFAULT_LIMITS),
  );
  check(
    'C2 拆分：localStorage 键名与持久化版本不变（迁移逻辑依赖）',
    STORAGE_KEY === 'drawinmap.sessions.v1' && STORAGE_VERSION === 1,
    `${STORAGE_KEY} v${STORAGE_VERSION}`,
  );

  const contextA = createEmptyContext();
  const contextB = createEmptyContext();
  contextA.history.push({ role: 'user' });
  check(
    'C2 拆分：空上下文每次返回独立新对象（避免串会话）',
    contextA.history.length === 1 &&
      contextB.history.length === 0 &&
      contextB.guide === null &&
      contextB.guideState === null &&
      contextB.referenceChoice === null,
    JSON.stringify(contextB),
  );

  const source = { nested: { list: [1, 2] } };
  const copy = clone(source);
  copy.nested.list.push(3);
  check('C2 拆分：clone 深拷贝不污染源（上下文快照隔离）', source.nested.list.length === 2 && copy.nested.list.length === 3);

  const apiKeys = Object.keys(createSessionStore({ storage: null })).sort();
  check(
    'C2 拆分：公开 API 方法集固定（拆分零改名/零增减）',
    apiKeys.join(',') ===
      'appendMessage,appendShape,clearAll,createSession,deleteSession,flush,getActiveId,getActiveSession,' +
        'getActiveShape,getContext,getLatestShape,getSession,getStorageError,isSessionEmpty,isStorageEnabled,' +
        'listSessions,setActiveShape,setContext,subscribe,switchSession,updateMessage',
    apiKeys.join(','),
  );
}

/* ---------------- 取消工具 ---------------- */

{
  const controller = new AbortController();
  check('未中止时 isAborted=false', isAborted(controller.signal) === false);
  controller.abort();
  check('中止后 isAborted=true', isAborted(controller.signal) === true);

  let threw = false;
  try {
    throwIfAborted(controller.signal);
  } catch (error) {
    threw = true;
    check('中止错误 name=AbortError', error.name === 'AbortError');
    check('中止错误可被识别', isAbortError(error) === true);
  }
  check('throwIfAborted 会抛出', threw);

  const inner = new AbortController();
  const outer = new AbortController();
  const unlink = linkSignals(outer.signal, inner);
  outer.abort();
  check('外部信号联动内部信号', inner.signal.aborted === true);
  unlink();

  const inner2 = new AbortController();
  const outer2 = new AbortController();
  outer2.abort();
  linkSignals(outer2.signal, inner2);
  check('已中止的外部信号立即联动', inner2.signal.aborted === true);

  check('createAbortError 带 kind', createAbortError().kind === 'aborted');
  check('compactPoints 处理空数组', compactPoints([], 2, 10).length === 0);
}

console.log(failures === 0 ? '\n[session-store] 全部通过' : `\n[session-store] ${failures} 项失败`);
if (failures > 0) {
  process.exit(1);
}
