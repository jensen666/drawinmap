/**
 * 智能体消息区渲染 / 卡片 / 输入态基元测试（清理方案 §6.3 T-B3a；B3 新增、C1 拆分后扩展）。
 *
 * 覆盖拆分后的纯函数/可注入模块（不依赖 controller / 真实浏览器）：
 * 1. ui-render.js：chip 行三种用途结构一致、消息气泡/推理折叠块/目标点序列图/trace 条/
 *    历史选项/待补引导行、错误提示、实时步骤渲染（step 新行 / progress 原地更新）；
 * 2. ui-cards.js：比例尺卡片（活池可点 / 失效灰卡）、参考候选卡（来源徽标/署名/点击）；
 * 3. ui-send.js：createSendFlow 的输入态与停止基元（setSending/clearPendingImage/stopTurn）；
 * 4. ui-reference.js：createReferenceFlow 的点选守卫（无活池/池不匹配时不动作）。
 * 全部文本走 textContent——fake DOM 的 innerHTML 读写均抛错，一旦回退立即红。
 *
 * 说明：initAgent 装配（DOM 事件绑定/整表重绘/发送主流程）依赖完整 DOM 与 controller，
 * 由既有 UI 测试与 E2E-S 兜底（Lead 统一验收）；本文件负责拆分后各模块的可静态/单测验证。
 *
 * 运行：node test/ui-render.mjs
 */

import { createFakeDocument } from './lib/fake-dom.mjs';

const fakeDocument = createFakeDocument();
const originalCreateElement = fakeDocument.createElement;

/**
 * 包装 fake document：补齐拆分后模块用到的接口（addEventListener / click / append 多参 /
 * replaceChildren / dataset / style / querySelector(All)），并在每个元素上记录监听器，
 * 便于断言"点击回调已挂上且参数正确"。fake-dom.mjs 本体保持最小，本文件只做测试侧扩展。
 */
fakeDocument.createElement = (tag) => {
  const element = originalCreateElement(tag);
  element.listeners = [];
  element.addEventListener = (type, listener) => {
    element.listeners.push({ type, listener });
  };
  element.click = () => {
    for (const { type, listener } of element.listeners) {
      if (type === 'click') {
        listener({ stopPropagation: () => {} });
      }
    }
  };
  element.dataset = {};
  element.style = {};
  element.append = (...nodes) => {
    for (const node of nodes) element.appendChild(node);
  };
  element.replaceChildren = (...nodes) => {
    for (const child of element.children) child.parent = null;
    element.children = [];
    for (const node of nodes) element.appendChild(node);
  };
  /** 实时行清理用：测试可设置 element.liveRows 模拟"已存在的可点行" */
  element.liveRows = [];
  element.querySelectorAll = () => element.liveRows;
  element.querySelector = () => null;
  /** remove 标记：断言"重绘前先清理旧行" */
  const originalRemove = element.remove.bind(element);
  element.removed = false;
  element.remove = () => {
    element.removed = true;
    originalRemove();
  };
  return element;
};
globalThis.document = fakeDocument;

const uiRender = await import('../web/src/agent/ui-render.js');
const {
  renderChipRow,
  createCardShell,
  appendNote,
  appendTraceCopy,
  appendOutlinePreview,
  appendShapeEntry,
  appendErrorMessage,
  createLiveStepRenderer,
  describeShape,
  renderMessage,
  renderPendingGuide,
} = uiRender;
const {
  appendScaleCards,
  renderScaleCard,
  renderPendingReferenceChoice,
  renderReferenceCard,
} = await import('../web/src/agent/ui-cards.js');
const { createSendFlow } = await import('../web/src/agent/ui-send.js');
const { createReferenceFlow } = await import('../web/src/agent/ui-reference.js');

let failures = 0;
let checks = 0;

/**
 * 执行一条断言。
 *
 * @param {string} label 断言说明
 * @param {boolean} condition 断言结果
 * @param {string} [detail] 失败时的实际值
 */
function check(label, condition, detail = '') {
  checks += 1;
  const ok = Boolean(condition);
  if (!ok) {
    failures += 1;
  }
  console.log(`[check] ${label} -> ${ok ? 'PASS' : `FAIL ${detail}`}`);
}

/** 待补引导的选项（含中文与数字，验证文本逐字） */
const GUIDE_OPTIONS = [
  { label: '画一个天鹅', value: '画一个天鹅' },
  { label: '画个 1 公里的星星', value: '画个1公里的星星' },
];

// ---------- 场景 1：待补引导行（可点 button） ----------
{
  const host = fakeDocument.createElement('div');
  const picked = [];
  const row = renderChipRow(host, 'agent-options is-live', GUIDE_OPTIONS, {
    disabled: false,
    onPick: (item) => picked.push(item.value),
  });
  check('引导行：挂载一层 row 容器', host.children.length === 1 && host.children[0] === row, String(host.children.length));
  check('引导行：row class 逐字', row.className === 'agent-options is-live', row.className);
  check('引导行：chip 数量 = 选项数量', row.children.length === GUIDE_OPTIONS.length, String(row.children.length));
  const chip = row.children[0];
  check('引导行：chip 为 button 且 type=button', chip.tagName === 'BUTTON' && chip.type === 'button', `${chip.tagName}/${chip.type}`);
  check('引导行：chip class 逐字', chip.className === 'agent-chip', chip.className);
  check('引导行：文本逐字（中文）', chip.textContent === '画一个天鹅', chip.textContent);
  check('引导行：默认未禁用', chip.disabled === false, String(chip.disabled));
  chip.click();
  check('引导行：点击回传选项 value', picked.length === 1 && picked[0] === '画一个天鹅', JSON.stringify(picked));

  const hostDisabled = fakeDocument.createElement('div');
  const disabledRow = renderChipRow(hostDisabled, 'agent-options is-live', GUIDE_OPTIONS, { disabled: true });
  check(
    '引导行：轮次进行中 disabled 透传到每个 chip',
    disabledRow.children.length === 2 && disabledRow.children.every((item) => item.disabled === true),
    disabledRow.children.map((item) => item.disabled).join(','),
  );
}

// ---------- 场景 2：历史引导选项行（不可点 span + title） ----------
{
  const host = fakeDocument.createElement('div');
  const row = renderChipRow(host, 'agent-options is-history', GUIDE_OPTIONS, {
    asStatic: true,
    title: '历史引导选项（回到该对话后可直接输入文字继续）',
  });
  const chip = row.children[0];
  check('历史行：chip 为 span（非 button）', chip.tagName === 'SPAN', chip.tagName);
  check('历史行：chip class 逐字 is-static', chip.className === 'agent-chip is-static', chip.className);
  check('历史行：文本逐字（中文 + 数字）', row.children[1].textContent === '画个 1 公里的星星', row.children[1].textContent);
  check(
    '历史行：title 逐字',
    chip.title === '历史引导选项（回到该对话后可直接输入文字继续）',
    chip.title,
  );
  check('历史行：无点击监听（不可点）', chip.listeners.length === 0, String(chip.listeners.length));
}

// ---------- 场景 3：快捷示例行（不套 row 容器，芯片直接挂容器） ----------
{
  const host = fakeDocument.createElement('div');
  const examples = ['画个心形', '在广州画个三角形'];
  const picked = [];
  const returned = renderChipRow(
    host,
    null,
    examples.map((label) => ({ label, value: label })),
    { onPick: (item) => picked.push(item.value) },
  );
  check('示例行：不返回 row（芯片直挂容器）', returned === null && host.children.length === 2, String(host.children.length));
  check(
    '示例行：芯片为 button 且文本逐字',
    host.children.every((chip) => chip.tagName === 'BUTTON')
      && host.children[1].textContent === '在广州画个三角形',
    host.children.map((chip) => `${chip.tagName}:${chip.textContent}`).join(' | '),
  );
  host.children[0].click();
  check('示例行：点击回传示例文本', picked.length === 1 && picked[0] === '画个心形', JSON.stringify(picked));
}

// ---------- 场景 4：空选项不渲染（不创建空行，保持原 DOM 结构） ----------
{
  const emptyHost = fakeDocument.createElement('div');
  const returned = renderChipRow(emptyHost, 'agent-options is-live', []);
  check('空选项：不创建空行、不挂任何节点', returned === null && emptyHost.children.length === 0, String(emptyHost.children.length));
}

// ---------- 场景 5：卡片外壳（比例尺卡/参考候选卡共用） ----------
{
  const plain = createCardShell({ className: 'agent-scale-card is-current', disabled: true });
  check(
    '卡片外壳：button + type=button + class 逐字 + disabled',
    plain.tagName === 'BUTTON' && plain.type === 'button' && plain.className === 'agent-scale-card is-current' && plain.disabled === true,
    `${plain.tagName}/${plain.type}/${plain.className}/${plain.disabled}`,
  );
  check('卡片外壳：无 title 参数时不设 title', plain.title === undefined, String(plain.title));
  check('卡片外壳：无 onClick 参数时不挂监听', plain.listeners.length === 0, String(plain.listeners.length));

  let clicked = 0;
  const clickable = createCardShell({
    className: 'agent-ref-card',
    disabled: false,
    title: '该轮候选已失效，仅回顾',
    onClick: () => {
      clicked += 1;
    },
  });
  check('卡片外壳：title 逐字透传', clickable.title === '该轮候选已失效，仅回顾', clickable.title);
  check('卡片外壳：未禁用时 disabled=false', clickable.disabled === false, String(clickable.disabled));
  clickable.click();
  check('卡片外壳：点击回调触发一次', clicked === 1, String(clicked));
}

// ---------- 场景 6：消息状态备注（已停止 / 等待回复 / 回复未完成） ----------
{
  const item = fakeDocument.createElement('div');
  appendNote(item, '本轮已停止，未交付任何结果。');
  check(
    '状态备注：div.agent-msg-note 挂在消息节点下',
    item.children.length === 1 && item.children[0].tagName === 'DIV' && item.children[0].className === 'agent-msg-note',
    item.children.length > 0 ? `${item.children[0].tagName}.${item.children[0].className}` : '无子节点',
  );
  check('状态备注：文本逐字', item.children[0].textContent === '本轮已停止，未交付任何结果。', item.children[0].textContent);
}

// ---------- 场景 7：trace 条 / 目标点序列图 / 查看此图形入口 ----------
{
  const item = fakeDocument.createElement('div');
  appendTraceCopy(item, 't-abc123');
  const row = item.children[0];
  check('trace 条：div.agent-msg-trace', row?.className === 'agent-msg-trace', row?.className);
  check(
    'trace 条：标签与按钮文本逐字',
    row.children[0].className === 'agent-trace-label'
      && row.children[0].textContent === 'trace'
      && row.children[1].className === 'agent-trace-copy'
      && row.children[1].textContent === 't-abc123',
    row.children.map((child) => child.textContent).join('|'),
  );
  const emptyTrace = fakeDocument.createElement('div');
  appendTraceCopy(emptyTrace, null);
  check('trace 条：无 traceId 不渲染', emptyTrace.children.length === 0);

  const item2 = fakeDocument.createElement('div');
  appendOutlinePreview(item2, {
    name: '心形',
    source: 'builtin',
    pointCount: 120,
    rotationDeg: 0,
    dataUrl: 'data:image/png;base64,x',
  });
  const figure = item2.children[0];
  check('序列图：figure.agent-outline', figure.className === 'agent-outline', figure.className);
  check(
    '序列图：图注逐字',
    figure.children[1].className === 'agent-outline-caption'
      && figure.children[1].textContent === '目标点序列「心形」· 120 点 · 内置图形',
    figure.children[1].textContent,
  );
  check('序列图：img alt 逐字', figure.children[0].alt === '目标点序列：心形', figure.children[0].alt);

  const rotated = fakeDocument.createElement('div');
  appendOutlinePreview(rotated, { name: '心形', source: 'llm', pointCount: 5, rotationDeg: 30, dataUrl: 'data:,' });
  check('序列图：带朝向追加后缀', rotated.children[0].children[1].textContent.includes('· 朝向 30°'));

  const shapeItem = fakeDocument.createElement('div');
  appendShapeEntry(shapeItem, 'sh-1');
  check(
    '查看此图形：行/按钮结构与文本',
    shapeItem.children[0].className === 'agent-msg-shape'
      && shapeItem.children[0].children[0].className === 'agent-shape-view'
      && shapeItem.children[0].children[0].textContent === '查看此图形'
      && shapeItem.children[0].children[0].title === '把这轮的图形切到地图上查看',
    shapeItem.children[0].children[0].textContent,
  );
}

// ---------- 场景 8：renderMessage（消息气泡 / 推理折叠块 / 历史选项 / 卡片回调） ----------
{
  const state = { expandedReasoning: new Set(), pendingGuide: null };
  const cardCalls = [];
  const deps = { state, appendScaleCards: (item, message) => cardCalls.push(message) };

  const userItem = renderMessage({ id: 'm1', role: 'user', text: '画个心形', status: 'done', traceId: 't-1' }, [], deps);
  check('renderMessage：用户气泡 class 逐字', userItem.className === 'agent-msg agent-msg-user', userItem.className);
  check('renderMessage：dataset.messageId', userItem.dataset.messageId === 'm1', userItem.dataset.messageId);
  check(
    'renderMessage：正文 textContent 逐字',
    userItem.children[0].className === 'agent-msg-text' && userItem.children[0].textContent === '画个心形',
    userItem.children[0].textContent,
  );
  check('renderMessage：trace 条自动追加', userItem.children.some((child) => child.className === 'agent-msg-trace'));

  const waiting = renderMessage({ id: 'm2', role: 'user', text: '等待', status: 'waiting' }, [], deps);
  check(
    'renderMessage：等待回复备注逐字',
    waiting.children.some((child) => child.className === 'agent-msg-note' && child.textContent === '（等待回复…）'),
    waiting.children.map((child) => child.textContent).join('|'),
  );

  const agentMessage = {
    id: 'm3',
    role: 'agent',
    text: '好的',
    status: 'done',
    traceId: 't-2',
    steps: [{ text: '理解需求…' }, { text: '选点…' }],
    outline: { name: '心形', source: 'procedural', pointCount: 8, rotationDeg: 0, dataUrl: 'data:,' },
    shapeId: 'sh-1',
    scaleCandidates: [{ id: 'c1' }, { id: 'c2' }],
  };
  const agentItem = renderMessage(agentMessage, [agentMessage], deps);
  const details = agentItem.children.find((child) => child.className === 'agent-reasoning');
  check(
    'renderMessage：推理折叠块 summary 逐字',
    details && details.children[0].textContent === '推理过程（2 步）',
    details?.children[0]?.textContent,
  );
  check(
    'renderMessage：步骤列表 li 逐字',
    details && details.children[1].children.map((li) => li.textContent).join('|') === '理解需求…|选点…',
    details?.children[1]?.children.map((li) => li.textContent).join('|'),
  );
  check('renderMessage：卡片行回调被调用（scaleCandidates≥2）', cardCalls.length === 1 && cardCalls[0] === agentMessage);
  check(
    'renderMessage：目标点序列图与查看入口已追加',
    agentItem.children.some((child) => child.className === 'agent-outline')
      && agentItem.children.some((child) => child.className === 'agent-msg-shape'),
  );

  state.expandedReasoning.add('m3');
  check(
    'renderMessage：推理展开状态按消息 id 恢复',
    renderMessage(agentMessage, [agentMessage], deps).children.find((child) => child.className === 'agent-reasoning').open === true,
  );

  const historyMessage = { id: 'm4', role: 'agent', text: '追问', options: GUIDE_OPTIONS, status: 'done' };
  const historyItem = renderMessage(historyMessage, [historyMessage], deps);
  const historyRow = historyItem.children.find((child) => child.className === 'agent-options is-history');
  check(
    'renderMessage：历史选项行结构（静态 span chip + title）',
    historyRow
      && historyRow.children[0].tagName === 'SPAN'
      && historyRow.children[0].className === 'agent-chip is-static'
      && historyRow.children[0].title === '历史引导选项（回到该对话后可直接输入文字继续）',
    historyRow?.children[0]?.className,
  );

  state.pendingGuide = { options: GUIDE_OPTIONS };
  const pendingItem = renderMessage(historyMessage, [historyMessage], deps);
  check(
    'renderMessage：待补引导为同一组时不画历史选项（避免两套可点）',
    !pendingItem.children.some((child) => child.className === 'agent-options is-history'),
  );
}

// ---------- 场景 9：renderPendingGuide（清理旧行 / 禁用透传 / 点击回传 / 滚动） ----------
{
  const messagesEl = fakeDocument.createElement('div');
  const staleRow = fakeDocument.createElement('div');
  messagesEl.liveRows = [staleRow];
  let scrolls = 0;
  const picks = [];
  const deps = {
    sending: true,
    onPick: (option) => picks.push(option.value),
    scrollToBottom: () => {
      scrolls += 1;
    },
  };
  renderPendingGuide(messagesEl, null, deps);
  check('待补引导：空引导只清理旧行、不追加', staleRow.removed === true && messagesEl.children.length === 0, `removed=${staleRow.removed}`);

  renderPendingGuide(messagesEl, { slot: 'shape', options: GUIDE_OPTIONS }, deps);
  const row = messagesEl.children[0];
  check('待补引导：挂载 is-live 行 + 两个可点 chip', row.className === 'agent-options is-live' && row.children.length === 2, row.className);
  check('待补引导：进行中 disabled 透传', row.children.every((chip) => chip.tagName === 'BUTTON' && chip.disabled === true));
  row.children[0].click();
  check('待补引导：点击回传选项 value', picks.length === 1 && picks[0] === '画一个天鹅', JSON.stringify(picks));
  check('待补引导：渲染后滚动到底部', scrolls === 1, String(scrolls));
}

// ---------- 场景 10：appendErrorMessage / describeShape / 实时步骤渲染 ----------
{
  const messagesEl = fakeDocument.createElement('div');
  let scrolled = 0;
  appendErrorMessage(messagesEl, '图片读取失败', () => {
    scrolled += 1;
  });
  check(
    '错误提示：div.agent-msg-error + 文本逐字 + 滚动',
    messagesEl.children[0].className === 'agent-msg agent-msg-error'
      && messagesEl.children[0].textContent === '图片读取失败'
      && scrolled === 1,
    messagesEl.children[0].textContent,
  );

  check(
    'describeShape：全字段拼装',
    describeShape({ shapeName: '心形', sizeMeters: 1200, rotationDeg: 30, reference: true })
      === '心形 · 1.2 km · 朝向 30° · 非合格参考版',
    describeShape({ shapeName: '心形', sizeMeters: 1200, rotationDeg: 30, reference: true }),
  );
  check('describeShape：空对象回退「图形」', describeShape({}) === '图形', describeShape({}));

  // 用假定时器避免真实 setInterval 泄漏
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const intervals = [];
  globalThis.setInterval = (fn, ms) => {
    intervals.push({ fn, ms, cleared: false });
    return intervals.length;
  };
  globalThis.clearInterval = (id) => {
    if (intervals[id - 1]) intervals[id - 1].cleared = true;
  };
  try {
    const stepsList = fakeDocument.createElement('ol');
    const steps = [];
    let stepScrolls = 0;
    const renderer = createLiveStepRenderer(stepsList, steps, () => false, () => {
      stepScrolls += 1;
    });
    renderer.onStep({ text: '理解需求…', kind: 'step' });
    check(
      '实时步骤：新步骤生成 li + 记录 steps + 滚动',
      stepsList.children.length === 1
        && stepsList.children[0].textContent.startsWith('理解需求…')
        && steps.length === 1
        && stepScrolls === 1,
      `li=${stepsList.children.length} steps=${steps.length} scrolls=${stepScrolls}`,
    );
    renderer.onStep({ text: '搜索中…', kind: 'progress' });
    renderer.onStep({ text: '搜索中 50%', kind: 'progress' });
    check(
      '实时步骤：progress 复用同一行原地更新、不新增步骤',
      stepsList.children.length === 2 && stepsList.children[1].textContent === '搜索中 50%' && steps.length === 2,
      `li=${stepsList.children.length} last=${stepsList.children[1]?.textContent} steps=${steps.length}`,
    );
    renderer.dispose();
    check('实时步骤：dispose 清理计时器', intervals.every((entry) => entry.cleared === true), JSON.stringify(intervals.map((i) => i.cleared)));
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  }
}

// ---------- 场景 11：ui-cards（比例尺卡 / 参考候选卡字段映射） ----------
{
  const cards = [
    { id: 'c1', sizeMeters: 1500, score: 70 },
    { id: 'c2', sizeMeters: 2400, score: 65 },
  ];
  const staleState = { pendingScalePool: null, sending: false };
  const staleItem = fakeDocument.createElement('div');
  appendScaleCards(staleItem, { id: 'm', scaleCandidates: cards, scaleCurrentCardId: 'c1', scalePoolId: 'p1' }, {
    state: staleState,
    switchScale: () => {},
    formatMinutes: () => '20 分钟',
  });
  const staleRow = staleItem.children[0];
  check('比例尺卡：失效行 class', staleRow.className === 'agent-scale-cards is-stale', staleRow.className);
  check(
    '比例尺卡：失效说明文案逐字',
    staleRow.children[0].textContent === '本次实测 2 个比例尺（该轮候选已失效，仅回顾）',
    staleRow.children[0].textContent,
  );
  check(
    '比例尺卡：失效卡禁用 + title',
    staleRow.children[1].disabled === true && staleRow.children[1].title === '该轮候选已失效，仅回顾',
    `disabled=${staleRow.children[1].disabled}`,
  );

  const pool = { poolId: 'p1', currentCardId: 'c1', shapeName: '心形', cards };
  let switched = null;
  const liveItem = fakeDocument.createElement('div');
  appendScaleCards(liveItem, { id: 'm', scaleCandidates: cards, scalePoolId: 'p1' }, {
    state: { pendingScalePool: pool, sending: false },
    switchScale: (message, card) => {
      switched = card.id;
    },
    formatMinutes: () => '20 分钟',
  });
  const liveRow = liveItem.children[0];
  check('比例尺卡：活池行 class', liveRow.className === 'agent-scale-cards is-live', liveRow.className);
  check('比例尺卡：说明含形状名', liveRow.children[0].textContent.startsWith('「心形」· 本次实测 2 个比例尺'), liveRow.children[0].textContent);
  check('比例尺卡：当前版选中 class', liveRow.children[1].className === 'agent-scale-card is-current', liveRow.children[1].className);
  liveRow.children[2].click();
  check('比例尺卡：点击切换回调（卡片 id）', switched === 'c2', String(switched));

  const richCard = renderScaleCard(
    { scaleCurrentCardId: 'other' },
    { id: 'c2', sizeMeters: 2400, score: 65, routeMeters: 10800, walkMinutes: 135, meanMeters: 20, maxMeters: 40, coverage: 100 },
    true,
    { state: { pendingScalePool: pool, sending: false }, switchScale: () => {}, formatMinutes: (minutes) => `${minutes} 分钟` },
  );
  const richTexts = richCard.children.map((child) => child.textContent);
  check(
    '比例尺卡：尺寸/贴合/里程/辅助行文案逐字',
    richTexts[0] === '2.4 km'
      && richTexts[1] === '路线贴合 65'
      && richTexts.includes('里程 10.80 km · 约 135 分钟')
      && richTexts.includes('贴合 平均 20 / 最大 40 m · 覆盖全部顶点'),
    richTexts.join(' | '),
  );

  const candidate = {
    candidateId: 'cand1',
    contentHash: 'h1',
    asset: {
      displayName: '天鹅',
      tags: ['A', 'B'],
      source: { license: 'CC-BY', attribution: '作者', url: 'https://example.com' },
    },
    customShape: { outlinePoints: [[0, 0], [1, 1]] },
    origin: 'online',
    reviewStatus: 'unreviewed',
  };
  let selectedName = null;
  const refCard = renderReferenceCard({ choiceId: 'ch1', status: 'awaiting-selection' }, candidate, {
    state: { sending: false },
    selectReferenceCandidate: (choice, cand, name) => {
      selectedName = name;
    },
  });
  check(
    '参考卡：徽标「在线未审核」+ 名称 + meta 逐字',
    refCard.children[0].textContent === '在线未审核'
      && refCard.children[2].textContent === '天鹅'
      && refCard.children[4].textContent === '2 点 · CC-BY',
    refCard.children.map((child) => child.textContent).join('|'),
  );
  check(
    '参考卡：署名外链逐字',
    refCard.children.some((child) => child.tagName === 'A' && child.textContent === '署名：作者'),
    refCard.children.map((child) => child.textContent).join('|'),
  );
  refCard.click();
  check('参考卡：点击回传显示名', selectedName === '天鹅', String(selectedName));

  const messagesEl = fakeDocument.createElement('div');
  let refScrolls = 0;
  const refDeps = { state: { sending: false }, selectReferenceCandidate: () => {}, scrollToBottom: () => {
    refScrolls += 1;
  } };
  renderPendingReferenceChoice(messagesEl, null, refDeps);
  check('待选卡：非等待态不渲染', messagesEl.children.length === 0);
  renderPendingReferenceChoice(
    messagesEl,
    { choiceId: 'ch1', status: 'awaiting-selection', candidates: [candidate] },
    refDeps,
  );
  check(
    '待选卡：等待态挂载候选行并滚动',
    messagesEl.children.length === 1
      && messagesEl.children[0].className === 'agent-reference-choice is-live'
      && refScrolls === 1,
    `children=${messagesEl.children.length} scrolls=${refScrolls}`,
  );
}

// ---------- 场景 12：ui-send 输入态与停止基元 ----------
{
  const state = { pendingImage: 'data:image/png;base64,x', sending: false, turnController: null };
  const elements = {
    messagesEl: fakeDocument.createElement('div'),
    inputEl: fakeDocument.createElement('input'),
    imageBtn: fakeDocument.createElement('button'),
    sendBtn: fakeDocument.createElement('button'),
    attachBar: fakeDocument.createElement('section'),
    imageInput: fakeDocument.createElement('input'),
  };
  const busyCalls = [];
  const flow = createSendFlow({
    state,
    store: {},
    controller: {},
    elements,
    onBusyChange: (value) => busyCalls.push(value),
    renderAll: () => {},
    saveContext: () => {},
    scrollToBottom: () => {},
  });
  flow.setSending(true);
  check(
    'setSending(true)：按钮变「停止」+ is-stop + 输入禁用 + onBusyChange',
    elements.sendBtn.textContent === '停止'
      && elements.sendBtn.classList.contains('is-stop')
      && elements.inputEl.disabled === true
      && busyCalls[0] === true
      && state.sending === true,
    `text=${elements.sendBtn.textContent} disabled=${elements.inputEl.disabled} busy=${busyCalls}`,
  );
  flow.setSending(false);
  check(
    'setSending(false)：按钮回「发送」+ 输入恢复 + onBusyChange',
    elements.sendBtn.textContent === '发送'
      && !elements.sendBtn.classList.contains('is-stop')
      && elements.inputEl.disabled === false
      && busyCalls[1] === false
      && state.sending === false,
    `text=${elements.sendBtn.textContent} busy=${busyCalls}`,
  );
  flow.clearPendingImage();
  check(
    'clearPendingImage：清状态 + 隐藏附件条 + 清 input',
    state.pendingImage === null && elements.attachBar.getAttribute('hidden') === '' && elements.imageInput.value === '',
  );
  flow.stopTurn();
  check('stopTurn：无进行中轮次时不抛错', true);
  state.turnController = new AbortController();
  flow.stopTurn();
  check('stopTurn：中止当前轮次', state.turnController.signal.aborted === true);
}

// ---------- 场景 13：ui-reference 点选守卫（无活池/池不匹配不动作） ----------
{
  const state = { sending: false, pendingScalePool: null, pendingReferenceChoice: null, suppressRender: false };
  let controllerCalls = 0;
  const flow = createReferenceFlow({
    state,
    store: {},
    controller: {
      switchScaleCandidate: () => {
        controllerCalls += 1;
        return { ok: true };
      },
    },
    engine: { formatMinutes: () => 'x' },
    elements: { messagesEl: fakeDocument.createElement('div') },
    panelToast: { show: () => {} },
    sendFlow: {},
    renderAll: () => {},
    saveContext: () => {},
    renderDeps: {},
  });
  flow.switchScale({ scalePoolId: 'p1', id: 'm' }, { id: 'c' });
  check('switchScale 守卫：无活池不调用控制器', controllerCalls === 0, String(controllerCalls));
  state.pendingScalePool = { poolId: 'p2' };
  flow.switchScale({ scalePoolId: 'p1', id: 'm' }, { id: 'c' });
  check('switchScale 守卫：池不匹配不调用控制器', controllerCalls === 0, String(controllerCalls));
}

// ---------- 场景 14：fake DOM innerHTML 反向断言（基元全程 textContent） ----------
{
  const probe = fakeDocument.createElement('div');
  let threw = 0;
  try {
    void probe.innerHTML;
  } catch {
    threw += 1;
  }
  try {
    probe.innerHTML = '<b>x</b>';
  } catch {
    threw += 1;
  }
  check('innerHTML 反向断言：fake DOM 读写均抛错（基元若回退 innerHTML 立即红）', threw === 2, `threw=${threw}`);
}

console.log(`\n[summary] ${checks - failures}/${checks} 项通过，失败 ${failures} 项`);
if (failures > 0) {
  process.exitCode = 1;
}
