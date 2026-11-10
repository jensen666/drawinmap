/**
 * 智能体对话面板：消息列表、文本/图片输入、发送与停止、快捷示例。
 *
 * 数据流（需求 R1/R3/R4/R5）：
 * - 消息与图形的**唯一真相源是会话存储**（session/store.js）：本模块只渲染，
 *   不再自己维护第二份消息列表；刷新页面后由存储恢复，界面原样重绘。
 * - 一轮对话 = 一条用户消息 + 一条智能体消息；用户消息**发送瞬间**写入存储
 *   （刷新不丢用户输入），智能体消息在回复到达后写入。
 * - "停止"用 AbortController 真正中断模型请求与图形搜索；被停止的轮次标记
 *   "已停止"，保留已产生的推理过程，且不向地图交付任何结果。
 * - 图形快照随回复一起写入存储，之后可随时切回地图查看（详见 session/ui.js）。
 *
 * DOM 骨架在 index.html（#agent-panel），本模块负责绑定与渲染。
 */

import { createAgentController } from './controller.js';
import { createLogger } from '../log/index.js';
import { createLlmConfigPanel } from './llm-config-panel.js';
import { createPanelToast } from './toast.js';
import { appendErrorMessage, renderChipRow, renderMessage, renderPendingGuide } from './ui-render.js';
import { appendScaleCards, renderPendingReferenceChoice } from './ui-cards.js';
import { createSendFlow } from './ui-send.js';
import { createReferenceFlow } from './ui-reference.js';

/** 模块 logger：用户操作（发送/停止/图片附件）与界面失败 */
const log = createLogger('agent/ui');

/** 图片压缩上限（长边像素）与 JPEG 质量 */
const IMAGE_MAX_SIDE = 1024;
const IMAGE_JPEG_QUALITY = 0.85;

/**
 * 把图片文件压缩为 data URL（长边 ≤ IMAGE_MAX_SIDE，JPEG）。
 *
 * @param {File} file 图片文件
 * @returns {Promise<string>} data URL
 */
function readAndDownscaleImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(image.width, image.height));
      const width = Math.max(1, Math.round(image.width * scale));
      const height = Math.max(1, Math.round(image.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(image, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', IMAGE_JPEG_QUALITY));
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片读取失败'));
    };
    image.src = url;
  });
}

/**
 * 初始化智能体面板。
 *
 * @param {object} options
 * @param {L.Map} options.map Leaflet 地图实例
 * @param {{plan: Function, recommend: Function, commitDraw: Function, clearDraw: Function, formatMinutes: Function}} options.engine 图形引擎接口
 * @param {object} options.placeConfig 归一化地点配置（示例问法、欢迎语都从这里取）
 * @param {object} options.store 会话存储（历史对话/消息/图形）
 * @param {(busy: boolean) => void} [options.onBusyChange] 轮次状态变化回调
 *   （进行中禁用会话切换/图形切换等操作，停止或完成后统一恢复）
 * @param {object|null} [options.cityStore] 城市状态机（方案 2026-11-08：对话点名城市路由用；测试可缺省）
 *   （进行中禁用会话切换/图形切换等操作，停止或完成后统一恢复）
 * @returns {object} 智能体面板接口（供会话界面调用）
 */
export function initAgent({ map, engine, placeConfig, store, onBusyChange = () => {}, cityStore = null }) {
  if (!placeConfig?.activeCity) {
    throw new Error('initAgent 需要地点配置 placeConfig（由 place-config.js 加载）');
  }
  const city = placeConfig.activeCity;
  const examples = city.examples ?? [];
  // 欢迎语（示例问法来自地点配置，代码内不写死地名）
  const firstExample = examples[0] ? `比如"${examples[0]}"` : '';
  const recommendExample = examples[2] ? `（比如"${examples[2]}"）` : '';
  const welcomeText = `你好，我是画图智能体。告诉我想画什么图形、在哪里，我来在真实路网上规划一条能走出来的路线（尺寸自动多档实测选最像的，想指定大小就说"画个1公里的星星"）。也可以只说地点${recommendExample}，我会实测推荐这里画得出来的图形。还可以上传一张图片，我直接描摹它的外轮廓来画（只接受线稿、剪影、白底或纯色底图标；得到的是实心外轮廓，中间的空洞不会保留）。${
    firstExample ? `试试：${firstExample}。` : ''
  }`;
  const panel = document.getElementById('agent-panel');
  const toggleBtn = document.getElementById('agent-btn');
  const collapseBtn = document.getElementById('agent-collapse');
  const messagesEl = document.getElementById('agent-messages');
  const examplesEl = document.getElementById('agent-examples');
  const attachBar = document.getElementById('agent-attach');
  const attachThumb = document.getElementById('agent-attach-thumb');
  const attachRemove = document.getElementById('agent-attach-remove');
  const imageBtn = document.getElementById('agent-image-btn');
  const imageInput = document.getElementById('agent-image-input');
  const inputEl = document.getElementById('agent-input');
  const sendBtn = document.getElementById('agent-send');

  // 面板内轻提示：点选比例尺卡片等就地操作的即时反馈（进不了对话消息，也不改变滚动位置）
  const panelToast = createPanelToast(panel);
  const controller = createAgentController({ map, engine, placeConfig, cityStore });
  /** 面板可变状态（跨模块共享；模块通过显式依赖对象读写，禁止模块级全局变量） */
  const panelState = {
    /** 当前待发送的图片 data URL */
    pendingImage: null,
    /** 是否正在等待回复（轮次进行中） */
    sending: false,
    /** 当前轮次的中止控制器（"停止"用） */
    turnController: null,
    /** 当前会话待补的引导选项（切换对话时随上下文一起保存/恢复） */
    pendingGuide: null,
    /** 当前会话待选的参考候选（方案 2026-10-31 §6.4；几何来自 context.referenceChoice，
     *  与该会话的 pendingGuide 分开渲染；消息里不重复保存候选几何） */
    pendingReferenceChoice: null,
    /** 当前活跃的多比例尺候选池视图（需求 2026-11-09；池本体在 controller 内存）。
     *  poolId 与消息 scalePoolId 匹配的卡片行才可点；null = 无活池，历史卡片行全部
     *  渲染为静态灰卡（刷新/新输入/切会话/切城市后均不可点、点了无反应）。 */
    pendingScalePool: null,
    /** 渲染抑制标记：批量写存储时避免重复整表重绘 */
    suppressRender: false,
    /** 进行中轮次的实时推理气泡（只存在于 DOM，不写存储；整表重绘时要接回去） */
    liveBubble: null,
    /** 已展开的"推理过程"折叠块（消息 id → true），重绘后恢复展开状态 */
    expandedReasoning: new Set(),
  };
  /** 滚动消息区到底部 */
  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // LLM 配置设置界面（R1/R3/R4）：入口在标题栏；轮次进行中也可打开/保存，不打断当前轮
  const configPanel = createLlmConfigPanel({ panel, isBusy: () => panelState.sending });

  /** 点选类交互控制器（ui-reference.js；switchScale 需被卡片依赖延迟引用，先声明） */
  let referenceFlow = null;

  /**
   * 卡片渲染依赖（显式注入 ui-cards.js）：面板状态 + 切换回调 + 用时格式化。
   * 回调用箭头延迟取用，保证装配顺序不影响初始化。
   */
  const cardDeps = {
    state: panelState,
    switchScale: (message, card) => referenceFlow.switchScale(message, card),
    formatMinutes: engine.formatMinutes,
  };

  /** 渲染依赖（显式注入 ui-render.js，渲染模块不持有面板状态） */
  const renderDeps = {
    state: panelState,
    appendScaleCards: (item, message) => appendScaleCards(item, message, cardDeps),
    openConfigPanel: () => void configPanel.open(),
  };

  /**
   * 发送流程依赖（显式注入 ui-send.js）：面板状态 + 存储/控制器 + DOM 引用 + 收尾回调。
   * renderAll/saveContext 是闭包内函数声明（提升），直接引用；实际调用发生在装配完成后。
   */
  const sendFlow = createSendFlow({
    state: panelState,
    store,
    controller,
    elements: { messagesEl, inputEl, imageBtn, sendBtn, attachBar, imageInput },
    onBusyChange,
    renderAll,
    saveContext,
    scrollToBottom,
    panelToast,
    configPanel,
  });
  const {
    sendText, doSend, stopTurn, beginLiveTurn, finishTurn, appendTurnOutcome,
    commitTurn, appendAgentReply, setSending, clearPendingImage, resizeInput,
  } = sendFlow;

  /**
   * 待补引导行依赖（禁用态 + 点击发送 + 滚动到底部）。
   *
   * @returns {{sending: boolean, onPick: Function, scrollToBottom: Function}} 引导行依赖
   */
  function guideRowDeps() {
    return {
      sending: panelState.sending,
      onPick: (option) => void sendText(option.value, option.label),
      scrollToBottom,
    };
  }

  /**
   * 待选参考候选卡依赖（显式注入 ui-cards.js）。
   *
   * @returns {{state: object, selectReferenceCandidate: Function, scrollToBottom: Function}} 候选卡依赖
   */
  function referenceRowDeps() {
    return {
      state: panelState,
      selectReferenceCandidate: (choice, candidate, name) => selectReferenceCandidate(choice, candidate, name),
      scrollToBottom,
    };
  }

  /** 点选类交互依赖（显式注入 ui-reference.js）：比卡片依赖多引擎/轻提示/发送流程 */
  referenceFlow = createReferenceFlow({
    state: panelState,
    store,
    controller,
    engine,
    elements: { messagesEl },
    panelToast,
    sendFlow,
    renderAll,
    saveContext,
    renderDeps,
  });
  const { switchScale, selectReferenceCandidate } = referenceFlow;

  /** 当前所在会话 id */
  function activeSessionId() {
    return store.getActiveId();
  }

  /** 整表重绘当前会话的消息（切换对话 / 存储变化时） */
  function renderAll() {
    const sessionId = store.getActiveId();
    const session = sessionId ? store.getSession(sessionId) : null;
    messagesEl.textContent = '';
    const messages = session ? session.messages : [];
    if (session) {
      for (const message of messages) {
        messagesEl.appendChild(renderMessage(message, messages, renderDeps));
      }
    } else {
      // 删除当前对话后的空对话状态：只显示欢迎语占位，不创建会话（发送消息时才创建）
      messagesEl.appendChild(
        renderMessage(
          { id: 'welcome-placeholder', role: 'agent', kind: 'welcome', text: welcomeText, status: 'done' },
          [],
          renderDeps,
        ),
      );
    }
    // 进行中的实时气泡（推理过程实时显示）：整表重绘后要接回去，否则会被抹掉
    if (panelState.liveBubble) {
      messagesEl.appendChild(panelState.liveBubble);
    }
    renderPendingGuide(messagesEl, panelState.pendingGuide, guideRowDeps());
    renderPendingReferenceChoice(messagesEl, panelState.pendingReferenceChoice, referenceRowDeps());
    scrollToBottom();
  }

  /**
   * 保存当前会话的上下文快照（对话历史 + 引导状态）到存储。
   */
  function saveContext() {
    const sessionId = activeSessionId();
    if (!sessionId) {
      return;
    }
    const context = controller.exportContext();
    store.setContext(sessionId, { ...context, guide: panelState.pendingGuide });
  }

  // 面板开关
  toggleBtn.addEventListener('click', () => {
    const willShow = panel.hasAttribute('hidden');
    if (willShow) {
      panel.removeAttribute('hidden');
    } else {
      panel.setAttribute('hidden', '');
    }
    toggleBtn.classList.toggle('is-active', willShow);
  });
  collapseBtn.addEventListener('click', () => {
    panel.setAttribute('hidden', '');
    toggleBtn.classList.remove('is-active');
  });

  // 默认展开：页面加载即显示面板（"收起"或右下按钮可关闭）
  panel.removeAttribute('hidden');
  toggleBtn.classList.add('is-active');

  // 快捷示例：点击填入输入框（示例问法来自地点配置；城市切换后按当前城市重挂）
  function renderExamples() {
    examplesEl.replaceChildren();
    const examples = placeConfig.activeCity?.examples ?? [];
    renderChipRow(examplesEl, null, examples.map((label) => ({ label, value: label })), {
      onPick: (item) => {
        inputEl.value = item.value;
        inputEl.focus();
      },
    });
  }
  renderExamples();

  // 图片附件
  imageBtn.addEventListener('click', () => imageInput.click());
  imageInput.addEventListener('change', async () => {
    const file = imageInput.files && imageInput.files[0];
    if (!file) {
      return;
    }
    try {
      panelState.pendingImage = await readAndDownscaleImage(file);
      attachThumb.src = panelState.pendingImage;
      attachBar.removeAttribute('hidden');
      log.info('ui.image.ready', { name: file.name, bytes: file.size, dataUrlLength: panelState.pendingImage.length });
    } catch (error) {
      appendErrorMessage(messagesEl, error.message, scrollToBottom);
      clearPendingImage();
    }
  });
  attachRemove.addEventListener('click', clearPendingImage);

  // 发送 / 停止：同一个按钮（进行中变成"停止"，停止后立即可继续输入）
  sendBtn.addEventListener('click', () => {
    if (panelState.sending) {
      stopTurn();
      return;
    }
    void doSend();
  });
  inputEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void doSend();
    }
  });

  inputEl.addEventListener('input', resizeInput);

  // 存储变化：切换对话时重绘消息与引导选项；新增消息时立即重绘
  // （用户消息发送即落盘 → 气泡必须立刻可见，不能等回复回来）
  store.subscribe((event) => {
    if (panelState.suppressRender) {
      return;
    }
    if (event.type === 'active') {
      // 这里不能用 getActiveSession()：它在 activeId 为 null 时会自动新建会话，
      // 会让"删除当前对话"变成"删一个补一个"（历史列表删不掉）
      const sessionId = store.getActiveId();
      const session = sessionId ? store.getSession(sessionId) : null;
      if (!session) {
        // 删除当前对话后的空对话状态：重置上下文并显示欢迎语占位，等发消息时再建会话
        panelState.pendingGuide = null;
        panelState.pendingReferenceChoice = null;
        panelState.pendingScalePool = null;
        controller.importContext(null);
        renderAll();
        return;
      }
      const context = store.getContext(session.id);
      panelState.pendingGuide = context?.guide || null;
      // 待选候选随会话上下文恢复（刷新/切换后继续选择；已选定/过期的快照不恢复成可点状态）
      panelState.pendingReferenceChoice =
        context?.referenceChoice?.status === 'awaiting-selection' ? context.referenceChoice : null;
      // 多比例尺候选池不随会话切换恢复（需求 R5）：池属于上一会话的交付上下文，
      // 切回后旧卡片按静态历史渲染，不可点
      panelState.pendingScalePool = null;
      controller.importContext(context || null);
      ensureWelcome(session);
      renderAll();
      return;
    }
    if (event.type === 'messages') {
      renderAll();
    }
  });

  /**
   * 确保会话里有欢迎语（没有消息的新会话补一条；避免重复添加）。
   *
   * @param {object} session 会话
   */
  function ensureWelcome(session) {
    if (session.messages.some((item) => item.kind === 'welcome')) {
      return;
    }
    store.appendMessage(session.id, {
      role: 'agent',
      text: welcomeText,
      kind: 'welcome',
      status: 'done',
    });
  }

  // 初始化当前会话：没有当前会话（首次进入 / 删除当前对话后刷新）时保持空对话，
  // 不在启动时预建空会话（否则历史列表会凭空出现一条空对话；发送消息时再创建）
  const initialSessionId = store.getActiveId();
  const initialSession = initialSessionId ? store.getSession(initialSessionId) : null;
  if (initialSession) {
    ensureWelcome(initialSession);
    const context = store.getContext(initialSession.id);
    panelState.pendingGuide = context?.guide || null;
    panelState.pendingReferenceChoice =
      context?.referenceChoice?.status === 'awaiting-selection' ? context.referenceChoice : null;
    controller.importContext(context || null);
  }
  renderAll();
  log.info('ui.panel.ready', { sessionId: initialSessionId });

  return {
    /** 导出当前上下文（切换对话时存回存储；含待补引导选项） */
    exportContext: () => ({ ...controller.exportContext(), guide: panelState.pendingGuide }),
    /** 导入上下文（切换对话时恢复） */
    importContext: (context) => controller.importContext(context),
    /** 重绘消息区 */
    renderMessages: renderAll,
    /** 是否轮次进行中 */
    isBusy: () => panelState.sending,
    /** 城市切换通知（city store 完成切换后调用）：刷新活动城市、示例话术与按城市缓存 */
    onCitySwitched: () => {
      controller.onCitySwitched();
      // 上一城市的比例尺候选池一并失效：卡片行转静态，不把旧城市结果切到当前地图（需求 R5）
      panelState.pendingScalePool = null;
      renderAll();
      renderExamples();
    },
    /** 停止当前轮次 */
    stop: stopTurn,
  };
}
