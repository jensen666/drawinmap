/**
 * DrawInMap 真实链路 E2E（长尾图形轮廓来源与贴路上限）：L1~L6 用例定义与断言。
 *
 * 方案：docs/方案设计/2026-11-01-长尾图形轮廓来源与贴路上限方案.md §4.2（链路验收）、§1（计数）
 * 驱动：tools/e2e-long-tail.mjs（本文件只定义用例与断言）
 *
 * 设计口径（与方案一致）：
 * - 断言围绕真实用户任务与结果正确性：本地词边界是否生效、图像描摹点列是否就是页面采用的点列、
 *   描不出是否诚实拒绝、交付颜色与验收结论是否一致；不验证"能跑通"。
 * - 点列 IoU 使用 Node 侧独立实现（PNG 解码 + 栅格化），**不复用页面描摹函数**，由驱动提供
 *   ctx.compareOutlineWithFixture(name, points) 计算；用例只消费结果并断言。
 * - 每例独立清空 localStorage（驱动 runCase 统一处理）。
 * - 图片用例的截图证据名：l4-1-piglet 等（驱动 ctx.shot 生成 <caseId>-<slug>.png）。
 */

/** 8 张白底剪影 fixture（顺序即 L4-1..L4-8） */
export const TRACE_FIXTURES = [
  { file: 'piglet-peppa', label: '小猪佩奇剪影', slug: 'piglet' },
  { file: 'windmill', label: '风车剪影', slug: 'windmill' },
  { file: 'lighthouse', label: '灯塔剪影', slug: 'lighthouse' },
  { file: 'bicycle', label: '自行车剪影', slug: 'bicycle' },
  { file: 'train', label: '火车剪影', slug: 'train' },
  { file: 'sailboat', label: '帆船剪影', slug: 'sailboat' },
  { file: 'helicopter', label: '直升机剪影', slug: 'helicopter' },
  { file: 'cactus', label: '仙人掌剪影', slug: 'cactus' },
];

/** 描不出样本（照片式输入） */
export const PHOTO_FIXTURE = { file: 'photo-like', label: '照片样本' };

/** 点位区间（方案 §3：重采样到 120~320 点） */
const POINT_MIN = 120;
const POINT_MAX = 320;

/** 独立 IoU 阈值（方案 §4.2：页面点列与填充后外轮廓 IoU ≥ 0.90） */
const IOU_MIN = 0.9;

/** 描不出固定回复（方案 §3：只接受线稿、剪影、白底或纯色底图标。） */
const REJECT_REPLY = '只接受线稿、剪影、白底或纯色底图标。';

/** 贴路失败允许出现的说法（方案 §3：写明是路网贴不出，不得写成描摹失败） */
const FIT_FAIL_MARKERS = ['路网贴不出', '这一带画不出', '画不出像样', '没有画'];
/** 描摹本身失败的说法（出现即违反方案 §3，任何 traced 用例都不得出现） */
const TRACE_FAIL_WORDS = ['描摹失败', '抽不出轮廓', '抽不出外轮廓', '无法描摹'];

/** 诚实失败可接受的原因标记（复用 30 例口径） */
const HONEST_FAIL_MARKERS = [
  '没有画',
  '画不出',
  '没能生成',
  '不能开始正式规划',
  '没有硬画',
  '都画不出',
  '目标验收没有通过',
  '目标验收没过',
  '轮廓来自这张图',
  '已尽力尝试',
  '仅供参考',
  '路网贴不出',
  '这一带画不出',
  '没法',
  '超出',
  // 2026-11-01 三种轮廓同一轮（§2）：三路都没有可用轮廓时回复固定句「没有可用轮廓。」，
  // 同属"明确说明原因、不静默失败"的诚实失败口径（该行为变化后 L1 仍必须通过）。
  '没有可用轮廓',
];

/** 点序列图来源标签（ui.js OUTLINE_SOURCE_LABELS） */
const SOURCE_LABELS = {
  reference: '参考图命中',
  procedural: '参数化生成',
  traced: '图像描摹',
  llm: 'AI 生成',
  builtin: '内置图形',
};

/* ============================ 通用读取辅助 ============================ */

/**
 * 取最后一条带目标点序列图的消息的 outline（完整对象：含 contentHash/points）。
 *
 * @param {object} snap 状态快照
 * @returns {object|null} outline
 */
function lastOutline(snap) {
  const messages = snap?.store?.session?.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].outline) {
      return messages[index].outline;
    }
  }
  return null;
}

/**
 * 取最后一条带 traceId 的消息的 traceId。
 *
 * @param {object} snap 状态快照
 * @returns {string|null} traceId
 */
function latestTraceId(snap) {
  const messages = snap?.store?.session?.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].traceId) {
      return messages[index].traceId;
    }
  }
  return null;
}

/**
 * 收集快照消息里出现过的全部 traceId（去重，按出现顺序）。
 *
 * @param {object} snap 状态快照
 * @returns {string[]} traceId 列表
 */
function allTraceIds(snap) {
  const messages = snap?.store?.session?.messages ?? [];
  const seen = [];
  for (const message of messages) {
    if (message.traceId && !seen.includes(message.traceId)) {
      seen.push(message.traceId);
    }
  }
  return seen;
}

/**
 * 取本轮最后一条智能体回复（error 消息也算，便于查看失败原因）。
 *
 * @param {object} snap 状态快照
 * @returns {string} 回复文本
 */
function lastReply(snap) {
  const messages = snap?.store?.session?.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'agent' && message.kind !== 'welcome') {
      return message.text || '';
    }
    if (message.role === 'error') {
      return message.text || '';
    }
  }
  return '';
}

/**
 * 合并所有消息文本（断言地点/图形名等关键词用）。
 *
 * @param {object} snap 状态快照
 * @returns {string} 全部文本
 */
function allText(snap) {
  const messages = snap?.store?.session?.messages ?? [];
  return messages.map((message) => message.text || '').join('\n');
}

/**
 * 归一化回复文本：去掉标点/空白，用于"固定句允许标点差异"的比对。
 *
 * @param {string} text 文本
 * @returns {string} 仅保留汉字/字母/数字
 */
function normalizeReply(text) {
  return String(text || '').replace(/[^\u4e00-\u9fff0-9a-zA-Z]/g, '');
}

/**
 * 从日志结果里取事件数组。
 *
 * @param {object} logs ctx.logs 返回
 * @returns {Array<object>} 事件列表
 */
function logEntries(logs) {
  return Array.isArray(logs?.entries) ? logs.entries : [];
}

/**
 * 查找日志事件（返回最后一个）。
 *
 * @param {object|Array} logs 日志结果或事件数组
 * @param {string} event 事件名
 * @returns {object|null} 事件的 data
 */
function findLog(logs, event) {
  const entries = Array.isArray(logs) ? logs : logEntries(logs);
  return entries.filter((item) => item.event === event).at(-1)?.data ?? null;
}

/**
 * 查找日志事件（返回全部 data）。
 *
 * @param {object|Array} logs 日志结果或事件数组
 * @param {string} event 事件名
 * @returns {Array<object>} 事件 data 列表
 */
function findAllLogs(logs, event) {
  const entries = Array.isArray(logs) ? logs : logEntries(logs);
  return entries.filter((item) => item.event === event).map((item) => item.data);
}

/**
 * 合并多组 trace 日志（图片用例两轮：描摹轮 + 规划轮）。
 *
 * @param {Array<object>} logsList ctx.logs 结果列表
 * @returns {{entries: Array<object>, unavailable: boolean}} 合并结果
 */
function mergeLogs(logsList) {
  const entries = [];
  let unavailable = false;
  for (const logs of logsList) {
    if (logs?.unavailable) {
      unavailable = true;
      continue;
    }
    entries.push(...logEntries(logs));
  }
  return { entries, unavailable };
}

/**
 * 断言"无错误气泡 + 回复非空"。
 *
 * @param {object} ctx 用例上下文
 * @param {object} snap 状态快照
 * @param {string} [prefix] 断言前缀
 * @returns {string} 回复文本
 */
function checkBasicReply(ctx, snap, prefix = '') {
  ctx.check(`${prefix}无错误气泡`, !snap.dom.errorText, snap.dom.errorText);
  const reply = lastReply(snap);
  ctx.check(`${prefix}回复非空`, Boolean(reply && reply.trim().length > 0), reply.slice(0, 200));
  return reply;
}

/**
 * 断言地图交付与图形快照一致（绿线=合格 / 橙线=参考版 / 失败无线）。
 *
 * @param {object} ctx 用例上下文
 * @param {object} snap 状态快照
 * @param {string} [prefix] 断言前缀
 * @returns {Promise<object>} 交付信息
 */
async function checkDelivery(ctx, snap, prefix = '') {
  const info = await ctx.delivery(snap);
  ctx.check(
    `${prefix}地图颜色与图形快照一致（绿=合格 / 橙=参考版 / 失败无线）`,
    info.consistent,
    `delivered=${info.delivered} green=${info.green} orange=${info.orange} shapes=${JSON.stringify(info.shapes)} strokes=${JSON.stringify(info.strokes)}`,
  );
  return info;
}

/**
 * 断言未交付时回复必须诚实说明原因（不允许静默失败）。
 *
 * @param {object} ctx 用例上下文
 * @param {string} reply 回复文本
 * @param {string} [prefix] 断言前缀
 */
function checkHonestFailure(ctx, reply, prefix = '') {
  ctx.check(
    `${prefix}未交付时回复明确说明原因（诚实失败，不静默）`,
    HONEST_FAIL_MARKERS.some((marker) => reply.includes(marker)),
    reply.slice(0, 400),
  );
}

/**
 * 断言回复不出现"描摹失败/抽不出轮廓"等把路网问题写成描摹问题的说法。
 *
 * @param {object} ctx 用例上下文
 * @param {string} reply 回复文本
 * @param {string} [prefix] 断言前缀
 */
function checkNoTraceFailureWording(ctx, reply, prefix = '') {
  const hit = TRACE_FAIL_WORDS.find((word) => reply.includes(word));
  ctx.check(`${prefix}回复不把路网问题写成描摹失败（不出现「描摹失败/抽不出轮廓」）`, !hit, `${hit ?? ''} · ${reply.slice(0, 300)}`);
}

/**
 * 从参考候选日志里找在线来源的事件（本地 miss 只能靠线上候选/日志间接证明）。
 *
 * @param {object|Array} logs 日志
 * @returns {Array<object>} 在线候选事件 data
 */
function onlineCandidateLogs(logs) {
  const entries = Array.isArray(logs) ? logs : logEntries(logs);
  return entries
    .filter((item) => item.event === 'reference.candidates')
    .map((item) => item.data)
    .filter((data) => data && (data.origin === 'online' || data.choiceOrigin === 'online'));
}

/**
 * 断言交付分支与回复一致（traced 用例共用）。
 *
 * 方案 §3/§4.2 允许的三态：
 * - 绿线：目标验收通过 **且** 路线验收通过（shape.reference=false）；
 * - 橙线：两种合法来源——① 目标验收未过、诊断性参考版（target.rejected）；
 *   ② 目标验收通过但这一带路网贴不出达标路线、退回最像的一版（target.accepted，
 *   回复必须写「路网贴不出/这一带画不出」）；两者都要求 shape.reference=true；
 * - 诚实失败：无图形、无线、回复明确说明原因（目标验收未过或路网贴不出）。
 * 任何分支都不得把路网问题写成"描摹失败/抽不出轮廓"。
 *
 * @param {object} ctx 用例上下文
 * @param {object} snap 最终快照
 * @param {object} info 交付信息
 * @param {object} logs 合并日志
 * @param {string} [prefix] 断言前缀
 * @returns {string} 交付分支：green / orange-diagnostic / orange-reference / failed
 */
function checkTracedDelivery(ctx, snap, info, logs, prefix = '') {
  const reply = lastReply(snap);
  const targetAccepted = Boolean(findLog(logs, 'target.accepted'));
  const targetRejected = Boolean(findLog(logs, 'target.rejected'));
  let branch = 'failed';
  if (info.delivered) {
    // 结果正确性：交付的必须是真实路线（有尺寸、有评分），不能把引擎退化的 0 分候选当"参考版"提交
    ctx.check(
      `${prefix}交付的图形快照是真实路线（尺寸>0、评分>0，不是退化候选）`,
      info.shapes.every((shape) => (shape.sizeMeters ?? 0) > 0 && (shape.score ?? 0) > 0),
      JSON.stringify(info.shapes),
    );
  }
  if (info.green) {
    branch = 'green';
    ctx.check(
      `${prefix}绿线交付：目标验收通过且路线验收通过`,
      info.delivered && !info.shapes.some((item) => item.reference) && targetAccepted,
      JSON.stringify({ shapes: info.shapes, targetAccepted }),
    );
  } else if (info.orange) {
    // 橙线两种合法来源：目标验收未过（诊断参考）或目标验收过了但路线贴不出（最接近参考版）
    const diagnostic = targetRejected;
    const reference = targetAccepted;
    branch = diagnostic ? 'orange-diagnostic' : 'orange-reference';
    ctx.check(
      `${prefix}橙线交付：目标验收有结论（通过/未过）+ 非合格参考版`,
      info.delivered && info.shapes.some((item) => item.reference) && (targetRejected || targetAccepted),
      JSON.stringify({ shapes: info.shapes, targetAccepted, targetRejected }),
    );
    if (diagnostic) {
      ctx.check(`${prefix}橙线回复说明轮廓来自这张图/目标验收没过`, /轮廓来自这张图|目标验收/.test(reply), reply.slice(0, 400));
    } else {
      ctx.check(
        `${prefix}橙线回复写明是路网贴不出这条外轮廓（不是描摹失败）`,
        /路网贴不出|这一带画不出|贴不出/.test(reply),
        reply.slice(0, 400),
      );
    }
  } else {
    ctx.check(`${prefix}未交付时不画绿线/橙线`, !info.green && !info.orange && !info.delivered, JSON.stringify(info.strokes));
    checkHonestFailure(ctx, reply, prefix);
  }
  checkNoTraceFailureWording(ctx, reply, prefix);
  return branch;
}

/* ============================ 词边界用例 ============================ */

/**
 * L1：更长未登记词（「龙虾」里的「龙」不得被当成单字整词命中）。
 */
const L1 = {
  id: 'L1',
  category: 'A 词边界',
  title: '更长未登记词·龙虾（不得交付龙/不得本地误命中）',
  input: '在珠江新城画一只龙虾',
  expected:
    '旧规则命中单字「龙」→ 新规则不命中；不得交付「龙」；日志无 dragon 的 agent.reference.used；本地候选卡不得出现；其后在线候选（在线未审核）或回退自由轮廓/诚实失败按现有顺序走，行为一致、无错误气泡',
  async run(ctx) {
    // 0) 独立复算：该输入在本地素材库里必须是 miss（新规则），旧规则曾是命中
    const local = await ctx.localRule(this.input);
    ctx.check('独立复算：新规则下本地为 miss（旧规则曾命中）', local.oldHit === true && local.newHit === false, JSON.stringify(local));

    await ctx.send(this.input);
    ctx.check('轮次在超时前完成', await ctx.waitTurn());
    let snap = await ctx.snapshot();
    ctx.capture('state', snap);
    const reply0 = checkBasicReply(ctx, snap);

    // 本地候选卡不得出现：卡片若存在只能是「在线未审核」
    const localCards = (snap.dom.refCards ?? []).filter((card) => card.badge !== '在线未审核');
    ctx.check('本地候选卡不得出现（本地必须 miss）', localCards.length === 0, JSON.stringify(localCards));

    const logs0 = await ctx.logs(latestTraceId(snap));
    const missLog = findLog(logs0, 'agent.reference.miss');
    const onlineCands = onlineCandidateLogs(logs0);
    const missEvidence = Boolean(missLog) || onlineCands.length > 0;
    ctx.check('本地 miss 可观测（agent.reference.miss 或在线候选事件）', missEvidence, JSON.stringify({ missLog, onlineEvents: onlineCands.length }));
    if (missLog) {
      ctx.check('本地 miss 日志 status 为 miss/offline（未命中，不是命中）', ['miss', 'offline'].includes(missLog.status), JSON.stringify(missLog));
    }

    const dragonUsed = findAllLogs(logs0, 'agent.reference.used').filter(
      (data) => data && (/dragon/i.test(String(data.assetId ?? '')) || String(data.matchedAlias ?? '') === '龙'),
    );
    ctx.check('日志不得有 dragon 素材的 agent.reference.used', dragonUsed.length === 0, JSON.stringify(dragonUsed));

    // 1) 分叉：在线候选卡（点第 1 张）或回退自由轮廓/诚实失败
    const cards = snap.dom.refCards ?? [];
    let finalSnap = snap;
    let branch = 'fallback';
    if (cards.length > 0) {
      branch = 'online-choice';
      ctx.check('在线候选卡全部标注「在线未审核」', cards.every((card) => card.badge === '在线未审核'), JSON.stringify(cards.map((card) => card.badge)));
      ctx.check('待选期间不规划（无图形快照）', (snap.store?.session?.shapes ?? []).length === 0, JSON.stringify(snap.store?.session?.shapes));
      const clicked = await ctx.clickRefCard(0);
      ctx.check('点击在线候选卡', clicked?.ok === true, JSON.stringify(clicked));
      ctx.check('在线选择后规划完成', await ctx.waitTurn());
      finalSnap = await ctx.snapshot();
      ctx.capture('planned', finalSnap);
      checkBasicReply(ctx, finalSnap, '选择轮 ');
      const outline = lastOutline(finalSnap);
      ctx.check('在线候选规划来源=参考图命中', outline?.source === 'reference', JSON.stringify(outline));
      ctx.check('在线候选目标为虾类（不是「龙」）', /龙虾|虾/.test(outline?.name ?? ''), JSON.stringify(outline));
      const delivery = await ctx.delivery(finalSnap);
      if (!delivery.delivered) {
        checkHonestFailure(ctx, lastReply(finalSnap));
      }
      ctx.setActual({ branch, localRule: local, missLog: missLog?.status ?? null, outline, delivered: delivery.delivered });
    } else {
      branch = 'fallback';
      const outline = lastOutline(finalSnap);
      const shapes = finalSnap.store?.session?.shapes ?? [];
      ctx.check('回退路径不交付「龙」', shapes.every((shape) => shape.shapeName !== '龙'), JSON.stringify(shapes));
      if (outline) {
        ctx.check('回退路径目标不是参考图「龙」', !(outline.source === 'reference' && /^龙$/.test(outline.name ?? '')), JSON.stringify(outline));
        ctx.check('回退路径目标为虾类或其它正确对象（不是「龙」）', outline.name !== '龙', JSON.stringify(outline));
      }
      const delivery = await ctx.delivery(finalSnap);
      if (!delivery.delivered) {
        ctx.check('回退未交付时不画绿线', !finalSnap.dom.routeStrokes.includes('#16a34a'), JSON.stringify(finalSnap.dom.routeStrokes));
        checkHonestFailure(ctx, lastReply(finalSnap) || reply0);
      } else {
        ctx.check('回退交付时目标来源不是参考图「龙」', outline?.source !== 'reference' || outline.name !== '龙', JSON.stringify(outline));
      }
      ctx.setActual({ branch, localRule: local, missLog: missLog?.status ?? null, outline, delivered: delivery.delivered });
    }
    await ctx.shot('lobster-long-word');
  },
};

/**
 * L2：单字整词（「画一只龙」末尾是整词「龙」，仍直接规划）。
 */
const L2 = {
  id: 'L2',
  category: 'A 词边界',
  title: '单字整词·龙（唯一候选直接规划、不弹卡）',
  input: '画一只龙',
  expected:
    '与改前相同：「龙」右侧无汉字、位于整词末尾 → 词边界命中；本地唯一候选直接规划、不弹候选卡；outline.source=reference、名称含龙；交付行为一致（绿线/橙线/诚实失败与验收结论一致）',
  async run(ctx) {
    const local = await ctx.localRule(this.input);
    ctx.check('独立复算：新规则下「龙」整词命中', local.newHit === true, JSON.stringify(local));

    await ctx.send(this.input);
    ctx.check('首轮（缺地点引导）在超时前完成', await ctx.waitTurn());
    const guided = await ctx.snapshot();
    ctx.capture('guide', guided);
    checkBasicReply(ctx, guided, '引导轮 ');
    ctx.check('缺地点时进入地点引导', guided.dom.guideVisible === true, JSON.stringify(guided.dom.guideLabels));
    ctx.check('引导选项含「当前视野中心」', (guided.dom.guideLabels ?? []).some((label) => label.includes('当前视野中心')), JSON.stringify(guided.dom.guideLabels));
    ctx.check('引导轮不规划（无图形快照）', (guided.store?.session?.shapes ?? []).length === 0, JSON.stringify(guided.store?.session?.shapes));
    const guideTraceId = latestTraceId(guided);

    const picked = await ctx.clickGuide('当前视野中心');
    ctx.check('点选「当前视野中心」', picked?.ok === true, JSON.stringify(picked));
    ctx.check('选项轮在超时前完成', await ctx.waitTurn());
    const snap = await ctx.snapshot();
    ctx.capture('state', snap);
    const reply = checkBasicReply(ctx, snap);

    ctx.check('单候选直走：未弹参考候选卡', (snap.dom.refCards ?? []).length === 0, JSON.stringify(snap.dom.refCards));
    const outline = lastOutline(snap);
    ctx.check('目标点序列图来源=参考图命中', outline?.source === 'reference', JSON.stringify(outline));
    ctx.check('目标图形名称含「龙」', (outline?.name ?? '').includes('龙'), JSON.stringify(outline));
    ctx.check('目标点数有效', (outline?.pointCount ?? 0) >= 20, JSON.stringify(outline));
    ctx.check('气泡图注标注「参考图命中」', snap.dom.outlineCaption.includes('参考图命中'), snap.dom.outlineCaption);

    const logs = mergeLogs([await ctx.logs(guideTraceId), await ctx.logs(latestTraceId(snap))]);
    const used = findAllLogs(logs, 'agent.reference.used');
    ctx.check('单候选直接规划：日志有 agent.reference.used', used.length >= 1, JSON.stringify(used));
    ctx.check('命中的是龙素材', used.some((data) => /dragon/i.test(String(data.assetId ?? '')) || String(data.matchedAlias ?? '') === '龙'), JSON.stringify(used));
    const candidatesEvents = findAllLogs(logs, 'reference.candidates').filter((data) => Array.isArray(data?.candidates));
    ctx.check('本地候选数=1（唯一候选直接规划）', candidatesEvents.some((data) => data.candidates.length === 1 && data.candidates[0]?.origin === 'local'), JSON.stringify(candidatesEvents));

    const delivery = await checkDelivery(ctx, snap);
    if (!delivery.delivered) {
      checkHonestFailure(ctx, reply);
    }
    ctx.setActual({ localRule: local, outline, delivered: delivery.delivered, used: used.at(-1) ?? null });
    await ctx.shot('single-char-long');
  },
};

/**
 * L3：多字整词（「天鹅」，不弹候选卡、直接规划）。
 */
const L3 = {
  id: 'L3',
  category: 'A 词边界',
  title: '多字整词·天鹅（直接规划、参考图命中）',
  input: '在越秀公园画一只天鹅',
  expected: 'plan；本地素材库命中天鹅（单候选直走，不弹候选卡）；outline.source=reference、名称含天鹅；交付行为一致',
  async run(ctx) {
    await ctx.send(this.input);
    ctx.check('轮次在超时前完成', await ctx.waitTurn());
    const snap = await ctx.snapshot();
    ctx.capture('state', snap);
    const reply = checkBasicReply(ctx, snap);
    ctx.check('单候选直走：未弹参考候选卡', (snap.dom.refCards ?? []).length === 0, JSON.stringify(snap.dom.refCards));
    const outline = lastOutline(snap);
    ctx.check('目标点序列图来源=参考图命中', outline?.source === 'reference', JSON.stringify(outline));
    ctx.check('目标图形名称含「天鹅」', (outline?.name ?? '').includes('天鹅'), JSON.stringify(outline));
    ctx.check('气泡图注标注「参考图命中」', snap.dom.outlineCaption.includes('参考图命中'), snap.dom.outlineCaption);
    const logs = await ctx.logs(latestTraceId(snap));
    const used = findAllLogs(logs, 'agent.reference.used');
    ctx.check('单候选直接规划：日志有 agent.reference.used', used.length >= 1, JSON.stringify(used));
    ctx.check('命中的是天鹅素材', used.some((data) => /swan/i.test(String(data.assetId ?? '')) || String(data.matchedAlias ?? '') === '天鹅'), JSON.stringify(used));
    const delivery = await checkDelivery(ctx, snap);
    if (!delivery.delivered) {
      checkHonestFailure(ctx, reply);
    }
    ctx.setActual({ outline, delivered: delivery.delivered });
    await ctx.shot('multi-char-swan');
  },
};

/* ============================ 图像描摹 8 图 ============================ */

/**
 * 构造单个描摹用例（L4-1..L4-8）。
 *
 * 流程（方案 §3 + 接入实现）：上传白底剪影（文本为空）→ 发送 → 描摹成功 → 缺地点引导
 * （选项含「当前视野中心」）→ 点选后规划交付。
 *
 * @param {{file: string, label: string, slug: string}} fixture fixture 描述
 * @param {number} index 序号（从 1 开始）
 * @returns {object} 用例定义
 */
function buildTraceCase(fixture, index) {
  return {
    id: `L4-${index}`,
    category: 'B 图像描摹',
    title: `描摹 ${index}/8·${fixture.label}（${fixture.file}）`,
    input: '',
    expected:
      'outline.source=traced、名称含「图像描摹」、点数 120~320；页面点列与 fixture 填充后外轮廓独立 IoU ≥ 0.90；outline.contentHash = agent.imageTrace.used.contentHash = plan.request.customShape.contentHash；无带图片的 llm.request、无 agent.reference.used；孔不保留；绿线仅在目标+路线验收都通过时出现，否则橙线或诚实失败且点列仍是描摹结果',
    fixture,
    async run(ctx) {
      const name = fixture.file;
      // 0) fixture 必须存在且可独立解码（Node 侧自实现 PNG 解码）
      let info;
      try {
        info = ctx.fixtureInfo(name);
      } catch (error) {
        ctx.check(`fixture 可独立解码：${name}.png`, false, error?.message ?? String(error));
        return;
      }
      ctx.check(`fixture 可独立解码：${name}.png`, Boolean(info && info.width > 0 && info.height > 0), JSON.stringify(info));
      ctx.check('fixture 前景占比在 15%~45% 之间（白底剪影样本口径）', info.foregroundRatio >= 0.1 && info.foregroundRatio <= 0.6, JSON.stringify(info));
      ctx.check(
        'fixture 前景为单连通主分量（描摹前置条件：主分量占比 ≥ 98%）',
        info.mainComponentRatio >= 0.98,
        JSON.stringify({ components: info.components, mainComponentRatio: info.mainComponentRatio, holesInRawMask: info.holesInRawMask }),
      );

      // 1) 真实 file input 上传（等价用户点「图片」选择文件）
      const uploadReady = await ctx.uploadImageBase64(ctx.fixtureBase64(name), `${name}.png`);
      ctx.check('图片进入待发送预览', uploadReady);
      const attached = await ctx.snapshot();
      ctx.check('预览缩略图已渲染', Boolean(attached.dom.attachVisible), JSON.stringify(attached.dom.attachVisible));

      // 2) 发送（文本为空）
      await ctx.send('');
      ctx.check('描摹轮在超时前完成', await ctx.waitTurn());
      const first = await ctx.snapshot();
      ctx.capture('trace-turn', first);
      checkBasicReply(ctx, first, '描摹轮 ');
      const traceId1 = latestTraceId(first);
      const logs1 = await ctx.logs(traceId1);
      const usedLog = findLog(logs1, 'agent.imageTrace.used');
      ctx.check('日志有 agent.imageTrace.used（描摹成功）', Boolean(usedLog), JSON.stringify(logEntries(logs1).map((item) => item.event)));
      ctx.check('日志无 agent.imageTrace.rejected（描摹未失败）', findLog(logs1, 'agent.imageTrace.rejected') === null, JSON.stringify(findLog(logs1, 'agent.imageTrace.rejected')));
      ctx.check('描摹日志 contentHash 非空', Boolean(usedLog?.contentHash), JSON.stringify(usedLog));
      ctx.check('描摹日志点数在 120~320', Number(usedLog?.pointCount) >= POINT_MIN && Number(usedLog?.pointCount) <= POINT_MAX, JSON.stringify(usedLog));

      // 3) 缺地点 → 点「当前视野中心」继续规划；若实现直接规划则直接取首轮结果
      let snap = first;
      let traceIds = traceId1 ? [traceId1] : [];
      const guideLabels = first.dom.guideLabels ?? [];
      if (first.dom.guideVisible) {
        ctx.check('缺地点进入引导，选项含「当前视野中心」', guideLabels.some((label) => label.includes('当前视野中心')), JSON.stringify(guideLabels));
        const picked = await ctx.clickGuide('当前视野中心');
        ctx.check('点选「当前视野中心」', picked?.ok === true, JSON.stringify(picked));
        ctx.check('点选后规划轮在超时前完成', await ctx.waitTurn());
        snap = await ctx.snapshot();
        ctx.capture('plan-turn', snap);
        checkBasicReply(ctx, snap, '规划轮 ');
        traceIds.push(latestTraceId(snap));
      } else {
        ctx.check('无地点引导时直接规划（也可接受）', (snap.store?.session?.shapes ?? []).length > 0, JSON.stringify(snap.store?.session?.shapes));
      }
      const logs = mergeLogs(await Promise.all(traceIds.filter(Boolean).map((traceId) => ctx.logs(traceId))));

      // 4) 页面点列（真实落盘 outline）与 fixture 独立 IoU
      const outline = lastOutline(snap);
      ctx.check('目标点序列图存在', Boolean(outline), JSON.stringify(outline && { name: outline.name, source: outline.source }));
      ctx.check('目标来源=图像描摹（traced）', outline?.source === 'traced', JSON.stringify(outline && { name: outline.name, source: outline.source }));
      ctx.check('目标名称含「图像描摹」', (outline?.name ?? '').includes('图像描摹'), JSON.stringify(outline?.name));
      const pointCount = Number(outline?.pointCount ?? 0);
      ctx.check('目标点数 120~320', pointCount >= POINT_MIN && pointCount <= POINT_MAX, String(pointCount));
      const points = Array.isArray(outline?.points) ? outline.points : [];
      ctx.check('落盘 outline 携带完整归一化点列', points.length > 0 && points.length === pointCount, JSON.stringify({ points: points.length, pointCount }));
      ctx.check(
        '归一化点列坐标都在 [-0.5, 0.5]',
        points.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) <= 0.5005 && Math.abs(y) <= 0.5005),
        JSON.stringify(points.slice(0, 3)),
      );

      let compare = null;
      try {
        compare = ctx.compareOutlineWithFixture(name, points);
      } catch (error) {
        ctx.check('独立 IoU 校验可执行', false, error?.message ?? String(error));
      }
      if (compare) {
        ctx.check(
          `页面点列与该图填充后外轮廓独立 IoU ≥ ${IOU_MIN}`,
          compare.iou >= IOU_MIN,
          `iou=${compare.iou} polygonArea=${compare.polygonArea} referenceArea=${compare.referenceArea} intersection=${compare.intersection}`,
        );
        ctx.check('点列栅格化后内部无孔（孔不保留）', compare.holes === 0, `holes=${compare.holes}`);
      }

      // 5) 内容哈希链：页面点列 = 描摹结果 = 贴路 T 是同一版
      ctx.check('outline.contentHash 非空', Boolean(outline?.contentHash), JSON.stringify(outline?.contentHash));
      ctx.check('outline.contentHash === agent.imageTrace.used.contentHash', Boolean(outline?.contentHash) && outline.contentHash === usedLog?.contentHash, `${outline?.contentHash} vs ${usedLog?.contentHash}`);
      const planRequests = findAllLogs(logs, 'plan.request');
      ctx.check('本轮有规划请求（plan.request）', planRequests.length >= 1, JSON.stringify(planRequests.map((data) => data?.purpose)));
      const planHash = planRequests.map((data) => data?.customShape?.contentHash).filter(Boolean).at(-1) ?? null;
      ctx.check('plan.request.customShape.contentHash === outline.contentHash（贴路 T 与页面点列同一版）', Boolean(planHash) && planHash === outline?.contentHash, `${planHash} vs ${outline?.contentHash}`);

      // 6) 不得把图片交给模型估点、不得走参考通道
      const llmRequests = findAllLogs(logs, 'llm.request');
      const imageInputs = llmRequests.filter((data) => data?.hasImageInput === true);
      ctx.check('日志没有带图片输入的 llm.request（不把图交给模型估点）', imageInputs.length === 0, JSON.stringify(imageInputs));
      ctx.check('日志没有 agent.reference.used（描摹目标不走参考通道）', findAllLogs(logs, 'agent.reference.used').length === 0, JSON.stringify(findAllLogs(logs, 'agent.reference.used')));
      ctx.check('日志没有 reference.candidates（描摹目标不查参考库）', findAllLogs(logs, 'reference.candidates').length === 0, JSON.stringify(findAllLogs(logs, 'reference.candidates').map((data) => data?.choiceOrigin)));

      // 7) UI 提示：上传得到的是实心外轮廓，空洞不保留
      const uiText = `${snap.dom.uiTextAll ?? ''}\n${first.dom.uiTextAll ?? ''}`;
      ctx.check(
        'UI 上传提示/欢迎语含「空洞不会保留」或「实心外轮廓」',
        uiText.includes('空洞不会保留') || uiText.includes('实心外轮廓'),
        uiText.slice(0, 300),
      );

      // 8) 交付一致性 + 分支断言（绿线只在目标+路线验收都通过时出现）
      const delivery = await checkDelivery(ctx, snap);
      const branch = checkTracedDelivery(ctx, snap, delivery, logs);
      // 点列仍是描摹结果：交付与否都不影响上面已断言的 traced/points/contentHash

      ctx.setActual({
        fixture: name,
        fixtureInfo: { width: info.width, height: info.height, foregroundRatio: info.foregroundRatio, components: info.components, mainComponentRatio: info.mainComponentRatio, holesInRawMask: info.holesInRawMask },
        used: usedLog ?? null,
        outline: outline ? { name: outline.name, source: outline.source, pointCount, contentHash: outline.contentHash } : null,
        iou: compare?.iou ?? null,
        holes: compare?.holes ?? null,
        planHash,
        branch,
        delivered: delivery.delivered,
      });
      await ctx.shot(fixture.slug);
    },
  };
}

/* ============================ 描不出 ============================ */

/**
 * L5：照片式输入描不出——不规划、不画线、固定一句回复。
 */
const L5 = {
  id: 'L5',
  category: 'B 图像描摹',
  title: '描不出·照片样本（不规划/不画线/固定句回复）',
  input: '',
  fixture: PHOTO_FIXTURE,
  expected:
    '描摹失败：不调用模型补点、不规划、不画线（无图形快照、地图无绿/橙线）；无 llm.request（为这张图）；日志 agent.imageTrace.rejected；回复为固定句「只接受线稿、剪影、白底或纯色底图标。」（允许标点差异）',
  async run(ctx) {
    const name = PHOTO_FIXTURE.file;
    let info;
    try {
      info = ctx.fixtureInfo(name);
    } catch (error) {
      ctx.check(`fixture 可独立解码：${name}.png`, false, error?.message ?? String(error));
      return;
    }
    ctx.check(`fixture 可独立解码：${name}.png`, Boolean(info && info.width > 0), JSON.stringify(info));

    const uploadReady = await ctx.uploadImageBase64(ctx.fixtureBase64(name), `${name}.png`);
    ctx.check('图片进入待发送预览', uploadReady);
    await ctx.send('');
    ctx.check('描摹轮在超时前完成', await ctx.waitTurn());
    const snap = await ctx.snapshot();
    ctx.capture('state', snap);
    const reply = checkBasicReply(ctx, snap);

    const shapes = snap.store?.session?.shapes ?? [];
    ctx.check('描不出时不规划（无图形快照）', shapes.length === 0, JSON.stringify(shapes));
    ctx.check('描不出时无目标点序列图', lastOutline(snap) === null, JSON.stringify(lastOutline(snap)));
    ctx.check('描不出时地图不画任何线（无绿/橙线）', !snap.dom.routeStrokes.includes('#16a34a') && !snap.dom.routeStrokes.includes('#f59e0b'), JSON.stringify(snap.dom.routeStrokes));
    ctx.check('描不出时无地点引导（直接拒绝）', snap.dom.guideVisible === false, JSON.stringify(snap.dom.guideLabels));

    const logs = await ctx.logs(latestTraceId(snap));
    const rejected = findLog(logs, 'agent.imageTrace.rejected');
    ctx.check('日志有 agent.imageTrace.rejected（描不出被拒绝）', Boolean(rejected), JSON.stringify(logEntries(logs).map((item) => item.event)));
    ctx.check('日志无 agent.imageTrace.used（没有描摹成功）', findLog(logs, 'agent.imageTrace.used') === null, JSON.stringify(findLog(logs, 'agent.imageTrace.used')));
    const llmRequests = findAllLogs(logs, 'llm.request');
    ctx.check('描不出时不调用 LLM（无 llm.request）', llmRequests.length === 0, JSON.stringify(llmRequests.map((data) => ({ attempt: data?.attempt, messageCount: data?.messageCount }))));
    ctx.check('描不出时无规划请求（plan.request）', findAllLogs(logs, 'plan.request').length === 0, JSON.stringify(findAllLogs(logs, 'plan.request').length));
    ctx.check('描不出时无参考通道事件', findAllLogs(logs, 'reference.candidates').length === 0, JSON.stringify(findAllLogs(logs, 'reference.candidates').length));

    const normalized = normalizeReply(reply);
    ctx.check(
      '回复为固定句「只接受线稿、剪影、白底或纯色底图标。」（允许标点差异）',
      normalized === normalizeReply(REJECT_REPLY),
      JSON.stringify(reply),
    );

    ctx.setActual({ reply, rejected: Boolean(rejected), delivered: false });
    await ctx.shot('photo-rejected');
  },
};

/* ============================ 计数（汇总项） ============================ */

/**
 * L6：§1 两个计数（整轮结束由驱动 `--counts` 统计并写入 result.json）。
 * 本项不操作浏览器：输入集合 = 本套 L1~L5 + 30 例回归全部 input。
 */
const L6 = {
  id: 'L6',
  category: 'C 计数',
  title: '§1 两个计数（整轮结束后统计，无浏览器操作）',
  input: '（统计项：本套用例 + 30 例回归全部请求）',
  summaryOnly: true,
  expected:
    'a) 旧规则会命中、新规则不命中的请求数（列出用例 id）；b) 本地 miss 之后在线返回候选的请求数 / 本地 miss 请求数。由驱动 --counts 模式从真实日志统计并写入 result.json',
};

/** 用例定义：L1~L3、L4-1..L4-8、L5、L6 */
export const CASES = [
  L1,
  L2,
  L3,
  ...TRACE_FIXTURES.map((fixture, index) => buildTraceCase(fixture, index + 1)),
  L5,
  L6,
];

/** 供驱动引用的辅助函数（断言口径统一） */
export const __testHelpers = {
  lastOutline,
  lastReply,
  latestTraceId,
  allTraceIds,
  allText,
  findLog,
  findAllLogs,
  normalizeReply,
  TRACE_FAIL_WORDS,
  FIT_FAIL_MARKERS,
  REJECT_REPLY,
  SOURCE_LABELS,
};
