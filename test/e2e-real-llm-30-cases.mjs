/**
 * DrawInMap 真实链路 E2E：30 个新用例（浏览器 + 真实 LLM + 真实广州路网，无 mock）。
 *
 * 设计口径：
 * - "之前没有生成过"：以真实浏览器 + 真实 LLM 历史链路（web/logs 与 tools/e2e-*.mjs）为准，
 *   30 例的输入原文均未出现过；图形/地点组合也尽量取历史未用过的（详见报告 §2 对照表）。
 * - 每例的 expected 是"可观测行为契约"：不仅验证跑通，还验证结果正确性——
 *   目标来源（内置/参数化/参考图/LLM）、地点解析、交付颜色（绿=合格 / 橙=参考版）、
 *   失败必须诚实（不绘制、不假绿线）、引导/推荐/闲聊各走各的分支。
 * - 断言证据三层：页面落盘状态（localStorage 会话）→ 地图图层颜色/目标点序列图元数据 →
 *   页面日志 API 中的真实链路事件（agent.intent / place.resolved / deliver.* / target.*）。
 *
 * 运行入口：node tools/e2e-real-llm-30.mjs（本文件只定义用例与断言）。
 */

/** 图片入口用例使用的五角星 PNG（320x320，白底黑星，1.5KB；脚本启动时不落地文件） */export const STAR_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAUAAAAFACAIAAABC8jL9AAAFm0lEQVR42u3dQZLiMBBFQVvB/a8sFlwAE0bWr8pczXLa0nPJNNDnnPMAMg2XAAQMCBgQMAgYEDAgYEDAIGBAwICAQcCAgAEBAwIGAQMCBgQMCLiP8zxdBAEDAuaJ8WsICxgQMCBgrr585RQtYEDA+O0RAkbSCBgEjGGLgBE2AgYBU3TMGsICBgQMCJirJ2SnaAEDAgYEzNWzsVO0gAEB411WCBjBCxgQMMYpAkb2CBgEjEGKgBE/AgYEbIQiYNwCEDAgYMMTAeNGgIBRHQLG7QABg4AxMBEwbgoIGBCwUYmAcWtAwICADUkEjBsEAgYEjPGIgHGbEDC6QsCAgDHtBYyiEDAgYMx8BKwlBAwIGJMfAasIBAwCxvxHwOgHAeMmImCUg4ABAeMsgIA1g4ABAeNEgIDVAgIGAeNcgIDRCQIGAYPTgYBRCAIGBGz8OiMIGBAwIGDnZ/9VAQMCBgTs/Ow/jIBBwGAICxglIGBAwDg7CBgNIGBAwMavH0HAgIABATs/+0EQMFQfA3NOs46SWuzte39IqcDK28pwz4PcQ8G/jtBGMSyYbcPjB+Q+jQ8vIUDua2krXoV2nEa6wb8HNopRb/YbOTSMerPfiaVh1FvhnVgeiZFu8HuhjWLUm/1hBg2j3gofZnCcRrrBHyc0ilFv9ueBNYx6K3we2HEa6QZ/I4dRjHqzv1JHw6i3wlfqOE4j3eAvtTOKsSGzv5VSw9iKFb6V0nEa6QZ/L7RRjI2X/cXuGsaWy/7LDBrGZqvwlxk8EiPd4L+NZBRja2X/cTMNY1NV+ONmjtM0nwfDpUe9ArYA2DyO0I7TSLfVBDaK6bxVhoVBvY7QjtNI1wS2VNgSAtYwTTbDWX6jO05Lt7BhCbH0AraQWHQBW04st2dgj8TSbWJYYCyugC0zltUR2nEa6ZrAFt4iCtjyY/kcoR2nka4JbENgsQRsW1gmR2jHaaRrAtsoWBQB2y6WwxEax2npmsA2EC6+gG0jXHYB20wuuGdgPBJL1wS2vXB5BWyTubA4QjtOS9cEtu1sO5dRwICAHaFdRgEDAgYE7ODnYiJgEDAgYEDAntlcUgQMAgYE7LDnwrqwAgYBAwJ2zMPlFTAgYBAwIGBPaLjIAgYBAwJ2tMOlFjAgYBAwDnUuuIABAQMCBgF7HsNlFzAgYBAwDnIuvoABAQMCdoSzBAIGBAwIGBCwpy8LIWC2N+d0EQp7uQTl0/38wxwzgR3bggdv9Ch29zGBnZmNYhOY/CdeT8WljoqWs8aB7Yd1jPsx7VUT2EvNevAMTJWh5KnYBCb+SGkUC9gD8Op0760uomEnBQEbvOtuCgiY1aNSw36N5PxcIa1tL4UdawIbvDo5/BqJ4iH5JZMJ7PwcPwZ3G8VuKAI+Gv6iyHFawPQNxi+ZBOz8HN/JJv83p2gBy8MoFjBdq9CwgMmOwSgWsAfg+FH21P/fY/DhjRwGr/d7mMB4hvRULOA25+fCj44+biFgg9fL6QjYznafErDzsw29+Q3LKdoENnjduQSM7esWJmC71r0MAT/8BGWzrrwszR+DvRNLut6zZQKjXhdKwLnnZ5vywdcIOo90E9jrVUaxgG1B3P4EHHR+tvO2ug+2PUWbwAavUSxg+wx3RgHbXrjI/jrh/c9LdpVlMoHNBFz2w1sp7SFvvaTrBP5+N6g37jbaMHVHaPV68V/A9gruqgJ+/Pxsi6Q33O0U7UUs6XplywRWL5bMBLYPMIpN4G+fjtRb8hbcKumXVccoNoHVi2X1YYY/n5+la61NYHdoLLQJDJjAIGBAwICAAQGDgAEBAwIGBAwCBgQMCBgEDAgYEDAgYBAwIGBAwICAQcCAgAEBg4ABAQMCBgQMAgYEDAgYBOwSgIABAQMCBgEDAgYEDAgYBAwIGBAwCBgQMCBgQMBQ3Rti3SVaT+xNAwAAAABJRU5ErkJggg==';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 从状态快照取最后一条带目标点序列图的消息的 outline 元数据。
 *
 * @param {object} snap 状态快照
 * @returns {object|null} outline 元数据
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
 * 从状态快照取本轮 traceId（最后一条带 traceId 的消息）。
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
 * 从页面日志事件里取最后一个指定事件的 data。
 *
 * @param {Array<object>|object} logs 日志事件
 * @param {string} event 事件名
 * @returns {object|null} 事件 data
 */
function findLog(logs, event) {
  if (!Array.isArray(logs)) {
    return null;
  }
  return logs.filter((item) => item.event === event).at(-1)?.data ?? null;
}

/**
 * 断言"无错误气泡 + 回复非空"。
 *
 * @param {object} ctx 用例上下文
 * @param {object} snap 状态快照
 * @param {string} [prefix] 断言前缀
 */
function checkBasicReply(ctx, snap, prefix = '') {
  ctx.check(`${prefix}无错误气泡`, !snap.dom.errorText, snap.dom.errorText);
  const reply = lastReply(snap);
  ctx.check(`${prefix}回复非空`, Boolean(reply && reply.trim().length > 0), reply.slice(0, 200));
  return reply;
}

/**
 * 断言目标点序列图来源与名称。
 *
 * @param {object} ctx 用例上下文
 * @param {object|null} outline outline 元数据
 * @param {{source: string, nameIncludes?: string, pointMin?: number}} expect 期望
 */
function checkOutline(ctx, outline, { source, nameIncludes = '', pointMin = 1 }) {
  ctx.check(`目标点序列图来源=${source}`, outline?.source === source, JSON.stringify(outline));
  if (nameIncludes) {
    ctx.check(`目标图形名称含「${nameIncludes}」`, (outline?.name ?? '').includes(nameIncludes), JSON.stringify(outline));
  }
  ctx.check('目标点数有效', (outline?.pointCount ?? 0) >= pointMin, JSON.stringify(outline));
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
  const markers = [
    '没有画',
    '画不出',
    '没能生成',
    '不能开始正式规划',
    '没有硬画',
    '都画不出',
    '目标验收没有通过',
    '已尽力尝试',
    '仅供参考',
    '没法',
    '超出',
  ];
  ctx.check(
    `${prefix}未交付时回复明确说明原因（诚实失败，不静默）`,
    markers.some((marker) => reply.includes(marker)),
    reply.slice(0, 400),
  );
}

/**
 * 参考图命中用例的统一断言（2026-11-01 三路取齐后的产品口径）。
 *
 * 旧口径「本地唯一命中 → 单候选直走、不弹候选卡」**已过期**：现在本地命中与
 * 在线补漏候选**全部进候选卡**，用户点选后才规划；只有"本地唯一命中且在线无候选"
 * 才走单候选直走（controller.js `candidates.length === 1 && origin === 'local'`）。
 *
 * 因此这里按"有没有出候选卡"分两条路断言，但**两条路都必须命中正确素材并交付成功**：
 * - 出卡：待选期间不规划 → 点本地精选卡 → 规划出参考图轮廓；
 * - 不出卡：单候选直走，直接规划。
 *
 * @param {object} ctx 用例上下文
 * @param {{nameIncludes: string, forbidName?: string}} expect 期望
 * @returns {Promise<{outline: object|null, delivered: boolean, cardCount: number}>} 结果
 */
async function checkReferenceHitFlow(ctx, expect) {
  const first = await ctx.snapshot();
  const cards = first.dom?.refCards ?? [];
  let planned = first;

  if (cards.length > 0) {
    ctx.check(
      '待选期间不规划（无图形快照）',
      (first.store?.session?.shapes ?? []).length === 0,
      JSON.stringify(first.store?.session?.shapes),
    );
    const localIndex = cards.findIndex((card) => card.badge === '本地精选');
    const index = localIndex >= 0 ? localIndex : 0;
    const card = cards[index] ?? {};
    ctx.check(
      `候选卡含本地命中（${expect.nameIncludes}）`,
      (card.name ?? '').includes(expect.nameIncludes),
      JSON.stringify(cards),
    );
    const clicked = await ctx.clickRefCard(index);
    ctx.check('点击本地命中候选卡', clicked?.ok === true, JSON.stringify(clicked));
    ctx.check('选择轮在超时前完成', await ctx.waitTurn());
    planned = await ctx.snapshot();
  } else {
    ctx.check('单候选直走（无在线候选，未弹候选卡）', true);
  }

  const outline = lastOutline(planned);
  checkOutline(ctx, outline, { source: 'reference', nameIncludes: expect.nameIncludes, pointMin: 20 });
  ctx.check(
    '气泡图注标注「参考图命中」',
    (planned.dom?.outlineCaption ?? '').includes('参考图命中'),
    planned.dom?.outlineCaption,
  );
  if (expect.forbidName) {
    ctx.check(
      `未误命中单字「${expect.forbidName}」对象（名称不是${expect.forbidName}）`,
      (outline?.name ?? '') !== expect.forbidName,
      JSON.stringify(outline),
    );
  }
  const delivery = await checkDelivery(ctx, planned);
  if (!delivery.delivered) {
    checkHonestFailure(ctx, lastReply(planned));
  }
  return { outline, delivered: delivery.delivered, cardCount: cards.length };
}

/** 用例定义（30 例） */
export const CASES = [
  // ================= A. 内置图形与显式约束（7 例） =================
  {
    id: 'A1',
    category: 'A 内置图形/显式约束',
    title: '内置心形 + 地点别名 + 显式尺寸',
    input: '在小蛮腰画个 800 米的心形',
    expected:
      'plan；地点别名「小蛮腰」解析为广州塔；采用原文显式尺寸 800m；目标=内置心形；交付绿线或诚实失败（行为一致、无错误气泡）',
    async run(ctx) {
      await ctx.send(this.input);
      ctx.check('轮次在超时前完成', await ctx.waitTurn());
      const snap = await ctx.snapshot();
      ctx.capture('state', snap);
      const reply = checkBasicReply(ctx, snap);
      const outline = lastOutline(snap);
      checkOutline(ctx, outline, { source: 'builtin', nameIncludes: '心形' });
      const logs = await ctx.logs(latestTraceId(snap));
      const intent = findLog(logs, 'agent.intent');
      ctx.check('意图 action=plan', intent?.action === 'plan', JSON.stringify(intent));
      ctx.check('显式尺寸 800m 被采用', intent?.sizeMeters === 800, JSON.stringify(intent));
      const place = findLog(logs, 'place.resolved');
      ctx.check('地点别名解析为广州塔（POI）', /广州塔/.test(JSON.stringify(place ?? '')) || allText(snap).includes('广州塔'), JSON.stringify(place));
      const delivery = await checkDelivery(ctx, snap);
      if (!delivery.delivered) {
        checkHonestFailure(ctx, reply);
      }
      ctx.setActual({ outline, sizeMeters: intent?.sizeMeters ?? null, place: place?.label ?? null, delivered: delivery.delivered });
      await ctx.shot('heart-alias-size');
    },
  },
  {
    id: 'A2',
    category: 'A 内置图形/显式约束',
    title: '内置矩形 + 道路名地点 + 显式边长',
    input: '在北京路画个周正的矩形，边长 400 米',
    expected: 'plan；地点解析为北京路；原文尺寸 400m；目标=内置矩形；交付行为一致',
    async run(ctx) {
      await ctx.send(this.input);
      ctx.check('轮次在超时前完成', await ctx.waitTurn());
      const snap = await ctx.snapshot();
      ctx.capture('state', snap);
      const reply = checkBasicReply(ctx, snap);
      const outline = lastOutline(snap);
      checkOutline(ctx, outline, { source: 'builtin', nameIncludes: '矩形' });
      const intent = findLog(await ctx.logs(latestTraceId(snap)), 'agent.intent');
      ctx.check('意图 action=plan', intent?.action === 'plan', JSON.stringify(intent));
      ctx.check('显式尺寸 400m 被采用', intent?.sizeMeters === 400, JSON.stringify(intent));
      const place = findLog(await ctx.logs(latestTraceId(snap)), 'place.resolved');
      ctx.check('地点「北京路」解析成功', Boolean(place?.label || place?.source), JSON.stringify(place));
      const delivery = await checkDelivery(ctx, snap);
      if (!delivery.delivered) {
        checkHonestFailure(ctx, reply);
      }
      ctx.setActual({ outline, sizeMeters: intent?.sizeMeters ?? null, place: place?.label ?? null, delivered: delivery.delivered });
      await ctx.shot('rect-road-size');
    },
  },
  {
    id: 'A3',
    category: 'A 内置图形/显式约束',
    title: '内置五角星 + 显式朝向',
    input: '在花城广场画个五角星，整体旋转 90 度',
    expected:
      'plan；显式朝向被解析为 rotationDeg=90（意图日志）；规则五角星可能走内置或参数化（两者都算规则图形渠道）；交付候选朝向与意图一致（允许 ±15° 档位/微调）',
    async run(ctx) {
      await ctx.send(this.input);
      ctx.check('轮次在超时前完成', await ctx.waitTurn());
      const snap = await ctx.snapshot();
      ctx.capture('state', snap);
      const reply = checkBasicReply(ctx, snap);
      const outline = lastOutline(snap);
      ctx.check('目标图形名称为五角星', /五角星/.test(outline?.name ?? ''), JSON.stringify(outline));
      ctx.check('规则图形渠道为内置或参数化', ['builtin', 'procedural'].includes(outline?.source), JSON.stringify(outline));
      ctx.check('目标点数有效', (outline?.pointCount ?? 0) >= 5, JSON.stringify(outline));
      const intent = findLog(await ctx.logs(latestTraceId(snap)), 'agent.intent');
      ctx.check('显式朝向解析为 90°（意图日志）', intent?.rotationDeg === 90, JSON.stringify(intent));
      if (outline) {
        ctx.check('交付朝向与意图一致（±15° 档位/微调）', Number.isFinite(outline.rotationDeg) && Math.abs(outline.rotationDeg - 90) <= 15, JSON.stringify(outline));
        ctx.check('交付朝向确实被旋转（非 0°）', Math.abs(outline.rotationDeg) > 0, JSON.stringify(outline));
      }
      const delivery = await checkDelivery(ctx, snap);
      if (!delivery.delivered) {
        checkHonestFailure(ctx, reply);
      }
      ctx.setActual({ outline, rotationDeg: intent?.rotationDeg ?? null, delivered: delivery.delivered });
      await ctx.shot('star-rotation');
    },
  },
  {
    id: 'A4',
    category: 'A 内置图形/显式约束',
    title: '参数化正八边形',
    input: '在陈家祠画个正八边形',
    expected: 'plan；shapeSpec 参数化（octagon，pointCount=8）；目标来源=参数化生成；交付行为一致',
    async run(ctx) {
      await ctx.send(this.input);
      ctx.check('轮次在超时前完成', await ctx.waitTurn());
      const snap = await ctx.snapshot();
      ctx.capture('state', snap);
      const reply = checkBasicReply(ctx, snap);
      const outline = lastOutline(snap);
      checkOutline(ctx, outline, { source: 'procedural', nameIncludes: '八边形' });
      const intent = findLog(await ctx.logs(latestTraceId(snap)), 'agent.intent');
      ctx.check('参数化规格 family=polygon', intent?.shapeSpec?.family === 'polygon', JSON.stringify(intent?.shapeSpec));
      ctx.check('参数化规格 pointCount=8', intent?.shapeSpec?.pointCount === 8, JSON.stringify(intent?.shapeSpec));
      const delivery = await checkDelivery(ctx, snap);
      if (!delivery.delivered) {
        checkHonestFailure(ctx, reply);
      }
      ctx.setActual({ outline, shapeSpec: intent?.shapeSpec ?? null, delivered: delivery.delivered });
      await ctx.shot('polygon-octagon');
    },
  },
  {
    id: 'A5',
    category: 'A 内置图形/显式约束',
    title: '参数化十角星',
    input: '在珠江新城画个十角星',
    expected: 'plan；shapeSpec 参数化（star，pointCount=10）；目标来源=参数化生成；交付行为一致',
    async run(ctx) {
      await ctx.send(this.input);
      ctx.check('轮次在超时前完成', await ctx.waitTurn());
      const snap = await ctx.snapshot();
      ctx.capture('state', snap);
      const reply = checkBasicReply(ctx, snap);
      const outline = lastOutline(snap);
      checkOutline(ctx, outline, { source: 'procedural', nameIncludes: '十角星', pointMin: 10 });
      const intent = findLog(await ctx.logs(latestTraceId(snap)), 'agent.intent');
      ctx.check('参数化规格 family=star', intent?.shapeSpec?.family === 'star', JSON.stringify(intent?.shapeSpec));
      ctx.check('参数化规格 pointCount=10', intent?.shapeSpec?.pointCount === 10, JSON.stringify(intent?.shapeSpec));
      const delivery = await checkDelivery(ctx, snap);
      if (!delivery.delivered) {
        checkHonestFailure(ctx, reply);
      }
      ctx.setActual({ outline, shapeSpec: intent?.shapeSpec ?? null, delivered: delivery.delivered });
      await ctx.shot('star-ten');
    },
  },
  {
    id: 'A6',
    category: 'A 内置图形/显式约束',
    title: '参数化横向椭圆',
    input: '在花城广场画个扁扁的椭圆',
    expected: 'plan；shapeSpec 参数化（circle 族 + 宽高比）；目标来源=参数化生成；交付行为一致',
    async run(ctx) {
      await ctx.send(this.input);
      ctx.check('轮次在超时前完成', await ctx.waitTurn());
      const snap = await ctx.snapshot();
      ctx.capture('state', snap);
      const reply = checkBasicReply(ctx, snap);
      const outline = lastOutline(snap);
      ctx.check('目标来源=参数化生成', outline?.source === 'procedural', JSON.stringify(outline));
      ctx.check('目标图形名称含圆/椭圆', /圆|椭圆/.test(outline?.name ?? ''), JSON.stringify(outline));
      const intent = findLog(await ctx.logs(latestTraceId(snap)), 'agent.intent');
      ctx.check('参数化规格 family=circle', intent?.shapeSpec?.family === 'circle', JSON.stringify(intent?.shapeSpec));
      const delivery = await checkDelivery(ctx, snap);
      if (!delivery.delivered) {
        checkHonestFailure(ctx, reply);
      }
      ctx.setActual({ outline, shapeSpec: intent?.shapeSpec ?? null, delivered: delivery.delivered });
      await ctx.shot('ellipse-wide');
    },
  },
  {
    id: 'A7',
    category: 'A 内置图形/显式约束',
    title: '参数化八角星·长短交替',
    input: '在越秀公园画个八角星，尖角一长一短交替',
    expected: 'plan；shapeSpec 参数化交替变体（alternating）；目标来源=参数化生成；交付行为一致',
    async run(ctx) {
      await ctx.send(this.input);
      ctx.check('轮次在超时前完成', await ctx.waitTurn());
      const snap = await ctx.snapshot();
      ctx.capture('state', snap);
      const reply = checkBasicReply(ctx, snap);
      const outline = lastOutline(snap);
      checkOutline(ctx, outline, { source: 'procedural', nameIncludes: '八角星' });
      const intent = findLog(await ctx.logs(latestTraceId(snap)), 'agent.intent');
      const variant = intent?.shapeSpec?.variant ?? '';
      const summary = intent?.shapeSpec?.summary ?? '';
      ctx.check(
        '参数化规格为长短交替变体',
        /alternating/.test(variant) || /交替|长短/.test(summary),
        JSON.stringify({ variant, summary }),
      );
      const delivery = await checkDelivery(ctx, snap);
      if (!delivery.delivered) {
        checkHonestFailure(ctx, reply);
      }
      ctx.setActual({ outline, shapeSpec: intent?.shapeSpec ?? null, delivered: delivery.delivered });
      await ctx.shot('star-alternating');
    },
  },

  // ================= B. 参考图素材（7 例） =================
  {
    id: 'B1',
    category: 'B 参考图素材',
    title: '本地参考图命中·天鹅',
    input: '在越秀公园画一只天鹅',
    expected:
      '本地素材库命中天鹅；有在线候选时本地+在线全部进候选卡（待选不规划），点本地精选卡后规划；无在线候选时单候选直走；目标来源=参考图命中；交付绿线或橙色参考版',
    async run(ctx) {
      await ctx.send(this.input);
      ctx.check('轮次在超时前完成', await ctx.waitTurn());
      const snap = await ctx.snapshot();
      ctx.capture('state', snap);
      checkBasicReply(ctx, snap);
      const result = await checkReferenceHitFlow(ctx, { nameIncludes: '天鹅' });
      ctx.setActual({ outline: result.outline, delivered: result.delivered, cardCount: result.cardCount });
      await ctx.shot('swan-reference');
    },
  },
  {
    id: 'B2',
    category: 'B 参考图素材',
    title: '本地参考图命中·狮子',
    input: '在珠江新城画一头狮子',
    expected:
      '本地素材库命中狮子；有在线候选时出候选卡并点本地精选卡后规划；无在线候选时单候选直走；目标来源=参考图命中；交付行为一致',
    async run(ctx) {
      await ctx.send(this.input);
      ctx.check('轮次在超时前完成', await ctx.waitTurn());
      const snap = await ctx.snapshot();
      ctx.capture('state', snap);
      checkBasicReply(ctx, snap);
      const result = await checkReferenceHitFlow(ctx, { nameIncludes: '狮子' });
      ctx.setActual({ outline: result.outline, delivered: result.delivered, cardCount: result.cardCount });
      await ctx.shot('lion-reference');
    },
  },
  {
    id: 'B3',
    category: 'B 参考图素材',
    title: '本地参考图命中·熊猫',
    input: '在花城广场画只熊猫',
    expected:
      '本地素材库命中熊猫；有在线候选时出候选卡并点本地精选卡后规划；无在线候选时单候选直走；目标来源=参考图命中；交付行为一致',
    async run(ctx) {
      await ctx.send(this.input);
      ctx.check('轮次在超时前完成', await ctx.waitTurn());
      const snap = await ctx.snapshot();
      ctx.capture('state', snap);
      checkBasicReply(ctx, snap);
      const result = await checkReferenceHitFlow(ctx, { nameIncludes: '熊猫' });
      ctx.setActual({ outline: result.outline, delivered: result.delivered, cardCount: result.cardCount });
      await ctx.shot('panda-reference');
    },
  },
  {
    id: 'B4',
    category: 'B 参考图素材',
    title: '本地参考图命中·三角龙',
    input: '在陈家祠画只三角龙',
    expected:
      '本地素材库命中三角龙；有在线候选时出候选卡并点本地精选卡后规划；无在线候选时单候选直走；目标来源=参考图命中；交付行为一致',
    async run(ctx) {
      await ctx.send(this.input);
      ctx.check('轮次在超时前完成', await ctx.waitTurn());
      const snap = await ctx.snapshot();
      ctx.capture('state', snap);
      checkBasicReply(ctx, snap);
      const result = await checkReferenceHitFlow(ctx, { nameIncludes: '三角龙' });
      ctx.setActual({ outline: result.outline, delivered: result.delivered, cardCount: result.cardCount });
      await ctx.shot('triceratops-reference');
    },
  },
  {
    id: 'B5',
    category: 'B 参考图素材',
    title: '本地参考图命中·猫头鹰（嵌套别名守卫）',
    input: '在白云山脚下画一只猫头鹰',
    expected:
      '本地素材库命中猫头鹰（不被单字「猫」拆成猫对象）；有在线候选时出候选卡并点本地精选卡后规划；无在线候选时单候选直走；目标来源=参考图命中；交付行为一致',
    async run(ctx) {
      await ctx.send(this.input);
      ctx.check('轮次在超时前完成', await ctx.waitTurn());
      const snap = await ctx.snapshot();
      ctx.capture('state', snap);
      checkBasicReply(ctx, snap);
      const result = await checkReferenceHitFlow(ctx, { nameIncludes: '猫头鹰', forbidName: '猫' });
      ctx.setActual({ outline: result.outline, delivered: result.delivered, cardCount: result.cardCount });
      await ctx.shot('owl-reference');
    },
  },
  {
    id: 'B6',
    category: 'B 参考图素材',
    title: '参考图多候选·马（选卡后规划）',
    input: '在花城广场画一匹马，要奔跑的样子',
    expected: '候选卡 ≥2（马多版本）；待选期间不规划（无图形快照）；点第 1 张后规划与所选 T 一致；双 trace 串联',
    async run(ctx) {
      await ctx.send(this.input);
      ctx.check('候选轮在超时前完成', await ctx.waitTurn());
      const awaiting = await ctx.snapshot();
      ctx.capture('awaiting', awaiting);
      checkBasicReply(ctx, awaiting, '候选轮 ');
      const cards = awaiting.dom.refCards;
      ctx.check('弹出 2~3 张马候选卡', cards.length >= 2 && cards.length <= 3, JSON.stringify(cards));
      ctx.check('候选卡带实际 T 小图与点数', cards.every((card) => card.hasImage && card.pointCount > 0), JSON.stringify(cards));
      ctx.check('候选卡标注「本地精选」', cards.every((card) => card.badge === '本地精选'), JSON.stringify(cards.map((card) => card.badge)));
      ctx.check('待选期间不规划（无图形快照）', (awaiting.store?.session?.shapes ?? []).length === 0, JSON.stringify(awaiting.store?.session?.shapes));
      ctx.check('待选 context 状态=awaiting-selection', awaiting.store?.session?.context?.referenceChoice?.status === 'awaiting-selection', JSON.stringify(awaiting.store?.session?.context?.referenceChoice));
      const clicked = await ctx.clickRefCard(0);
      ctx.check('点击第 1 张候选卡', clicked?.ok === true, JSON.stringify(clicked));
      ctx.check('选择轮在超时前完成', await ctx.waitTurn());
      const planned = await ctx.snapshot();
      ctx.capture('selected', planned);
      const outline = lastOutline(planned);
      checkOutline(ctx, outline, { source: 'reference', nameIncludes: '马', pointMin: 20 });
      ctx.check('规划点数与所选卡一致', outline?.pointCount === clicked?.pointCount, `所选 ${clicked?.pointCount} vs ${outline?.pointCount}`);
      ctx.check('选择后 context 状态=selected', planned.store?.session?.context?.referenceChoice?.status === 'selected', JSON.stringify(planned.store?.session?.context?.referenceChoice));
      const selectionMessages = (planned.store?.session?.messages ?? []).filter((message) => message.kind === 'reference-selection');
      const candidateMessages = (planned.store?.session?.messages ?? []).filter((message) => message.kind === 'reference-candidates');
      ctx.check('选择留痕：selectedCandidateId 写入', Boolean(selectionMessages.at(-1)?.selectedCandidateId), JSON.stringify(selectionMessages));
      ctx.check('choiceId 串联候选轮与选择轮', Boolean(selectionMessages.at(-1)?.referenceChoiceId) && selectionMessages.at(-1).referenceChoiceId === candidateMessages.at(-1)?.referenceChoiceId, `${selectionMessages.at(-1)?.referenceChoiceId} vs ${candidateMessages.at(-1)?.referenceChoiceId}`);
      ctx.check('双 trace：候选轮与规划轮 traceId 不同', candidateMessages.at(-1)?.traceId && candidateMessages.at(-1).traceId !== planned.store?.session?.messages?.filter((m) => m.outline).at(-1)?.traceId, `${candidateMessages.at(-1)?.traceId}`);
      const delivery = await checkDelivery(ctx, planned);
      if (!delivery.delivered) {
        checkHonestFailure(ctx, lastReply(planned));
      }
      ctx.setActual({ cards: cards.length, clicked: clicked?.pointCount ?? null, outlinePointCount: outline?.pointCount ?? null, delivered: delivery.delivered });
      await ctx.shot('horse-choice');
    },
  },
  {
    id: 'B7',
    category: 'B 参考图素材',
    title: '参考图多候选·狗（选第 3 张）',
    input: '在珠江新城画一只狗，毛要卷卷的',
    expected: '候选卡 ≥2（狗多版本，traits 不影响候选集合）；点最后一张后规划与所选 T 一致；交付行为一致',
    async run(ctx) {
      await ctx.send(this.input);
      ctx.check('候选轮在超时前完成', await ctx.waitTurn());
      const awaiting = await ctx.snapshot();
      ctx.capture('awaiting', awaiting);
      checkBasicReply(ctx, awaiting, '候选轮 ');
      const cards = awaiting.dom.refCards;
      ctx.check('弹出 2~3 张狗候选卡', cards.length >= 2 && cards.length <= 3, JSON.stringify(cards));
      ctx.check('候选卡标注「本地精选」', cards.every((card) => card.badge === '本地精选'), JSON.stringify(cards.map((card) => card.badge)));
      ctx.check('待选期间不规划（无图形快照）', (awaiting.store?.session?.shapes ?? []).length === 0, JSON.stringify(awaiting.store?.session?.shapes));
      const clicked = await ctx.clickRefCard(cards.length - 1);
      ctx.check('点击最后一张候选卡', clicked?.ok === true, JSON.stringify(clicked));
      ctx.check('选择轮在超时前完成', await ctx.waitTurn());
      const planned = await ctx.snapshot();
      ctx.capture('selected', planned);
      const outline = lastOutline(planned);
      checkOutline(ctx, outline, { source: 'reference', nameIncludes: '狗', pointMin: 20 });
      ctx.check('规划点数与所选卡一致', outline?.pointCount === clicked?.pointCount, `所选 ${clicked?.pointCount} vs ${outline?.pointCount}`);
      const delivery = await checkDelivery(ctx, planned);
      if (!delivery.delivered) {
        checkHonestFailure(ctx, lastReply(planned));
      }
      ctx.setActual({ cardCount: cards.length, clickedPointCount: clicked?.pointCount ?? null, outlinePointCount: outline?.pointCount ?? null, delivered: delivery.delivered });
      await ctx.shot('dog-choice');
    },
  },

  // ================= C. 在线检索补漏（1 例） =================
  {
    id: 'C1',
    category: 'C 在线检索补漏',
    title: '本地无素材·龙虾（新词边界下本地 miss → 在线补漏或回退自由轮廓）',
    input: '在珠江新城画一只龙虾',
    expected:
      '新词边界规则下本地单字「龙」不得命中「龙虾」→ 本地 miss（agent.reference.miss status=miss/offline 或在线候选事件），日志无 dragon 素材的 agent.reference.used，不得交付「龙」；在线可用时弹在线未审核候选卡（选卡后规划），在线不可用/无候选时诚实回退自由轮廓或失败；两条路径都必须行为一致、无错误气泡',
    async run(ctx) {
      await ctx.send(this.input);
      ctx.check('轮次在超时前完成', await ctx.waitTurn());
      const snap = await ctx.snapshot();
      ctx.capture('state', snap);
      const reply = checkBasicReply(ctx, snap);
      const localTraceId = latestTraceId(snap);
      // 2026-11-01 A 词边界：本地必须 miss（30 例驱动只暴露 waitFor，直接在页面日志 API 里断言）
      ctx.check(
        '本地为 miss（日志 agent.reference.miss status=miss/offline 或在线候选事件）',
        await ctx.waitFor(`(() => {
          const api = window.DrawInMapLog;
          if (!api || typeof api.entries !== 'function') return false;
          const list = api.entries({ traceId: ${JSON.stringify(localTraceId)}, level: 'debug', limit: 0 }) || [];
          const miss = list.some((item) => item.event === 'agent.reference.miss' && ['miss', 'offline'].includes(item.data?.status));
          const online = list.some((item) => item.event === 'reference.candidates' && (item.data?.choiceOrigin === 'online' || item.data?.origin === 'online'));
          return miss || online;
        })()`, 8000, '本地 miss 日志'),
      );
      ctx.check(
        '日志无 dragon 素材的 agent.reference.used（不得把龙虾当龙交付）',
        await ctx.waitFor(`(() => {
          const api = window.DrawInMapLog;
          if (!api || typeof api.entries !== 'function') return false;
          const list = api.entries({ traceId: ${JSON.stringify(localTraceId)}, level: 'debug', limit: 0 }) || [];
          return !list.some((item) => item.event === 'agent.reference.used' && (/dragon/i.test(String(item.data?.assetId ?? '')) || String(item.data?.matchedAlias ?? '') === '龙'));
        })()`, 8000, '无 dragon 参考命中'),
      );
      const nonOnlineCards = (snap.dom.refCards ?? []).filter((card) => card.badge !== '在线未审核');
      ctx.check('本地候选卡不得出现（本地必须 miss）', nonOnlineCards.length === 0, JSON.stringify(nonOnlineCards));
      const onlineCards = snap.dom.refCards;
      ctx.setActual({ branch: onlineCards.length > 0 ? 'online-choice' : 'fallback' });
      if (onlineCards.length > 0) {
        ctx.check('在线候选卡标注「在线未审核」', onlineCards.every((card) => card.badge === '在线未审核'), JSON.stringify(onlineCards.map((card) => card.badge)));
        ctx.check('待选期间不规划（无图形快照）', (snap.store?.session?.shapes ?? []).length === 0, JSON.stringify(snap.store?.session?.shapes));
        const clicked = await ctx.clickRefCard(0);
        ctx.check('点击在线候选卡', clicked?.ok === true, JSON.stringify(clicked));
        ctx.check('在线选择后规划完成', await ctx.waitTurn());
        const planned = await ctx.snapshot();
        ctx.capture('planned', planned);
        const outline = lastOutline(planned);
        checkOutline(ctx, outline, { source: 'reference' });
        ctx.check('在线候选名称含龙虾/虾类', /龙虾|虾/.test(outline?.name ?? ''), JSON.stringify(outline));
        const delivery = await checkDelivery(ctx, planned);
        if (!delivery.delivered) {
          checkHonestFailure(ctx, lastReply(planned));
        }
        ctx.setActual({ outline, delivered: delivery.delivered });
      } else {
        // 在线不可用 / 无候选 → 回退 LLM 自由轮廓或诚实失败/闲聊
        const outline = lastOutline(snap);
        const delivered = (snap.store?.session?.shapes ?? []).length > 0;
        ctx.check('回退路径不交付「龙」', (snap.store?.session?.shapes ?? []).every((shape) => shape.shapeName !== '龙'), JSON.stringify(snap.store?.session?.shapes));
        if (outline) {
          ctx.check('回退路径目标来源=LLM 自由轮廓', outline.source === 'llm', JSON.stringify(outline));
          ctx.check('回退路径目标名称含龙虾/虾类', /龙虾|虾/.test(outline.name ?? ''), JSON.stringify(outline));
          ctx.check('回退路径目标名称不是「龙」', outline.name !== '龙', JSON.stringify(outline));
          const delivery = await checkDelivery(ctx, snap);
          if (!delivery.delivered) {
            checkHonestFailure(ctx, reply);
          }
          ctx.check('回退路径无在线候选卡时也不静默参考命中', outline.source !== 'reference', JSON.stringify(outline));
          ctx.setActual({ outline, delivered: delivery.delivered });
        } else {
          ctx.check('无候选且无目标时进入闲聊/诚实失败（无图形、无绿线）', delivered === false && !snap.dom.routeStrokes.includes('#16a34a'), JSON.stringify({ delivered, strokes: snap.dom.routeStrokes }));
        }
      }
      await ctx.shot('lobster-online');
    },
  },

  // ================= D. 自由轮廓（LLM 生成点列 + 视觉质检）（3 例） =================
  {
    id: 'D1',
    category: 'D 自由轮廓',
    title: '自由轮廓·风车',
    input: '在花城广场画一座风车',
    expected: 'plan；LLM 生成自由轮廓（来源=AI 生成）；视觉质检闭环后交付绿线/橙色参考版，或目标未通过时诚实失败（不假绿线）',
    async run(ctx) {
      await ctx.send(this.input);
      ctx.check('轮次在超时前完成', await ctx.waitTurn());
      const snap = await ctx.snapshot();
      ctx.capture('state', snap);
      const reply = checkBasicReply(ctx, snap);
      const outline = lastOutline(snap);
      const intent = findLog(await ctx.logs(latestTraceId(snap)), 'agent.intent');
      ctx.check('意图为自由轮廓 customShape', Boolean(intent?.customShape?.name), JSON.stringify(intent?.customShape));
      ctx.check('LLM 解析图形名称含「风车」', /风车/.test(intent?.customShape?.name ?? ''), JSON.stringify(intent?.customShape));
      if (outline) {
        ctx.check('目标来源=AI 生成', outline.source === 'llm', JSON.stringify(outline));
        ctx.check('目标名称含「风车」', /风车/.test(outline.name ?? ''), JSON.stringify(outline));
      }
      const delivery = await checkDelivery(ctx, snap);
      if (!delivery.delivered) {
        checkHonestFailure(ctx, reply);
      }
      ctx.setActual({ outline, decision: intent?.notes ?? null, delivered: delivery.delivered });
      await ctx.shot('windmill-freeform');
    },
  },
  {
    id: 'D2',
    category: 'D 自由轮廓',
    title: '自由轮廓·灯塔',
    input: '在越秀公园画一座灯塔',
    expected: 'plan；LLM 自由轮廓（来源=AI 生成）；目标验收/路网规划按质检结论交付或诚实失败；行为一致',
    async run(ctx) {
      await ctx.send(this.input);
      ctx.check('轮次在超时前完成', await ctx.waitTurn());
      const snap = await ctx.snapshot();
      ctx.capture('state', snap);
      const reply = checkBasicReply(ctx, snap);
      const outline = lastOutline(snap);
      const intent = findLog(await ctx.logs(latestTraceId(snap)), 'agent.intent');
      ctx.check('LLM 解析图形名称含「灯塔」', /灯塔/.test(intent?.customShape?.name ?? ''), JSON.stringify(intent?.customShape));
      if (outline) {
        ctx.check('目标来源=AI 生成', outline.source === 'llm', JSON.stringify(outline));
        ctx.check('目标名称含「灯塔」', /灯塔/.test(outline.name ?? ''), JSON.stringify(outline));
      }
      const delivery = await checkDelivery(ctx, snap);
      if (!delivery.delivered) {
        checkHonestFailure(ctx, reply);
      }
      ctx.setActual({ outline, delivered: delivery.delivered });
      await ctx.shot('lighthouse-freeform');
    },
  },
  {
    id: 'D3',
    category: 'D 自由轮廓',
    title: '自由轮廓·彗星（带特征约束）',
    input: '在珠江新城画一颗拖着长尾巴的彗星',
    expected: 'plan；LLM 自由轮廓且带上用户明说的「长尾巴」约束；按目标验收结论交付或诚实失败；行为一致',
    async run(ctx) {
      await ctx.send(this.input);
      ctx.check('轮次在超时前完成', await ctx.waitTurn());
      const snap = await ctx.snapshot();
      ctx.capture('state', snap);
      const reply = checkBasicReply(ctx, snap);
      const outline = lastOutline(snap);
      const intent = findLog(await ctx.logs(latestTraceId(snap)), 'agent.intent');
      ctx.check('LLM 解析图形名称含「彗星」', /彗星/.test(intent?.customShape?.name ?? ''), JSON.stringify(intent?.customShape));
      const constraints = JSON.stringify(intent?.userConstraints ?? []);
      ctx.check('用户约束「长尾巴」被记录', /长尾巴|尾巴/.test(constraints), JSON.stringify(intent?.userConstraints));
      if (outline) {
        ctx.check('目标来源=AI 生成', outline.source === 'llm', JSON.stringify(outline));
        ctx.check('目标名称含「彗星」', /彗星/.test(outline.name ?? ''), JSON.stringify(outline));
      }
      const delivery = await checkDelivery(ctx, snap);
      if (!delivery.delivered) {
        checkHonestFailure(ctx, reply);
      }
      ctx.setActual({ outline, userConstraints: intent?.userConstraints ?? null, delivered: delivery.delivered });
      await ctx.shot('comet-freeform');
    },
  },

  // ================= E. 引导与地点边界（5 例） =================
  {
    id: 'E1',
    category: 'E 引导/地点边界',
    title: '缺地点引导·点选项补地点',
    input: '画个五角星',
    expected: '首轮进入地点引导（问题+5 个选项：4 地标+视野中心）；点选项后本地填充（不耗 LLM）→ 需求确认 → 规划交付；五角星可走内置或参数化两个规则图形渠道（2026-11-01 修正：与 A3 口径一致，LLM 存在跨轮波动）',
    async run(ctx) {
      await ctx.send(this.input);
      ctx.check('首轮在超时前完成', await ctx.waitTurn());
      const guided = await ctx.snapshot();
      ctx.capture('guide', guided);
      checkBasicReply(ctx, guided, '引导轮 ');
      ctx.check('出现可点引导选项', guided.dom.guideVisible === true, JSON.stringify(guided.dom.guideLabels));
      ctx.check('引导选项为 4 地标 + 视野中心', guided.dom.guideLabels.length === 5, JSON.stringify(guided.dom.guideLabels));
      ctx.check('回复包含引导问题', lastReply(guided).includes('想在哪里画'), lastReply(guided).slice(0, 200));
      ctx.check('context.guide.slot=place', guided.store?.session?.context?.guide?.slot === 'place', JSON.stringify(guided.store?.session?.context?.guide));
      ctx.check('引导轮不规划（无图形快照）', (guided.store?.session?.shapes ?? []).length === 0, JSON.stringify(guided.store?.session?.shapes));
      const picked = await ctx.clickGuide(1);
      ctx.check('点击第 2 个地点选项', picked?.ok === true, JSON.stringify(picked));
      ctx.check('选项轮在超时前完成', await ctx.waitTurn());
      const planned = await ctx.snapshot();
      ctx.capture('planned', planned);
      const reply = checkBasicReply(ctx, planned, '选项轮 ');
      const outline = lastOutline(planned);
      // 2026-11-01 修正（Lead 判定）：五角星是规则图形，可走内置（builtin）或参数化（procedural）
      // 两个合法渠道——产品规则图形优先参数化，A3/A5 用例本就允许两渠道；LLM 解析「画个五角星」
      // 存在跨轮波动（本轮参数化、历史轮内置），断言不得只认 builtin（既有断言口径过窄，非本次改动回归）。
      ctx.check(
        '目标点序列图来源为规则图形渠道（内置 builtin 或参数化 procedural）',
        ['builtin', 'procedural'].includes(outline?.source),
        JSON.stringify(outline),
      );
      ctx.check('目标图形名称含「五角星」', (outline?.name ?? '').includes('五角星'), JSON.stringify(outline));
      ctx.check('目标点数有效', (outline?.pointCount ?? 0) >= 5, JSON.stringify(outline));
      ctx.check('回复包含需求确认语', reply.includes('需求明确'), reply.slice(0, 300));
      ctx.check('用户气泡显示所选地点', (planned.dom.lastUserText || '').includes(picked?.picked ?? ''), planned.dom.lastUserText);
      const delivery = await checkDelivery(ctx, planned);
      if (!delivery.delivered) {
        checkHonestFailure(ctx, reply);
      }
      ctx.setActual({ picked: picked?.picked ?? null, outline, delivered: delivery.delivered });
      await ctx.shot('guide-option');
    },
  },
  {
    id: 'E2',
    category: 'E 引导/地点边界',
    title: '缺地点引导·自由文本补地点',
    input: '画个矩形',
    expected: '首轮引导；自由文本「在沙面岛」经 LLM 重解析合并（非选项本地填充）→ 需求确认 → 规划交付',
    async run(ctx) {
      await ctx.send(this.input);
      ctx.check('首轮在超时前完成', await ctx.waitTurn());
      const guided = await ctx.snapshot();
      ctx.capture('guide', guided);
      ctx.check('出现地点引导', guided.dom.guideVisible === true && guided.store?.session?.context?.guide?.slot === 'place', JSON.stringify(guided.dom.guideLabels));
      await ctx.send('在沙面岛');
      ctx.check('补地点轮在超时前完成', await ctx.waitTurn());
      const planned = await ctx.snapshot();
      ctx.capture('planned', planned);
      const reply = checkBasicReply(ctx, planned, '补地点轮 ');
      const outline = lastOutline(planned);
      checkOutline(ctx, outline, { source: 'builtin', nameIncludes: '矩形' });
      ctx.check('回复包含需求确认语', reply.includes('需求明确'), reply.slice(0, 300));
      const place = findLog(await ctx.logs(latestTraceId(planned)), 'place.resolved');
      ctx.check('自由文本地点解析为沙面岛', /沙面/.test(JSON.stringify(place ?? '')), JSON.stringify(place));
      const delivery = await checkDelivery(ctx, planned);
      if (!delivery.delivered) {
        checkHonestFailure(ctx, reply);
      }
      ctx.setActual({ outline, place: place?.label ?? null, delivered: delivery.delivered });
      await ctx.shot('guide-freetext');
    },
  },
  {
    id: 'E3',
    category: 'E 引导/地点边界',
    title: '未解析地点·追问换地点',
    input: '在火星基地画个五角星',
    expected: '地点未解析 → 按 unresolvedPlace=ask 追问（不画到视野中心、不规划）；回复说明没找到并重新给地点选项',
    async run(ctx) {
      await ctx.send(this.input);
      ctx.check('轮次在超时前完成', await ctx.waitTurn());
      const snap = await ctx.snapshot();
      ctx.capture('state', snap);
      checkBasicReply(ctx, snap);
      ctx.check('出现地点引导选项（重新追问）', snap.dom.guideVisible === true, JSON.stringify(snap.dom.guideLabels));
      ctx.check('context.guide.slot=place', snap.store?.session?.context?.guide?.slot === 'place', JSON.stringify(snap.store?.session?.context?.guide));
      ctx.check('未解析地点不规划（无图形快照）', (snap.store?.session?.shapes ?? []).length === 0, JSON.stringify(snap.store?.session?.shapes));
      ctx.check('未解析地点不绘制任何线', snap.dom.overlayCount === 0, `overlays=${snap.dom.overlayCount} strokes=${JSON.stringify(snap.dom.routeStrokes)}`);
      const reply = lastReply(snap);
      ctx.check('回复包含引导问题（想在哪里画）', reply.includes('想在哪里画'), reply.slice(0, 300));
      const intent = findLog(await ctx.logs(latestTraceId(snap)), 'agent.intent');
      ctx.check('意图保留原地点「火星基地」', /火星基地/.test(JSON.stringify(intent?.place ?? '')), JSON.stringify(intent?.place));
      const unresolvedLog = findLog(await ctx.logs(latestTraceId(snap)), 'place.unresolved.ask');
      ctx.setActual({ place: intent?.place ?? null, unresolvedAsk: Boolean(unresolvedLog), reply: reply.slice(0, 300) });
      await ctx.shot('unresolved-place');
    },
  },
  {
    id: 'E4',
    category: 'E 引导/地点边界',
    title: '覆盖外行政区·诚实失败',
    input: '在从化区画个五角星',
    expected: '地点解析到从化区（覆盖外代表点）→ 覆盖预检拦截；明确告知超出路网数据范围，不绘制、不转推荐',
    async run(ctx) {
      await ctx.send(this.input);
      ctx.check('轮次在超时前完成', await ctx.waitTurn());
      const snap = await ctx.snapshot();
      ctx.capture('state', snap);
      const reply = checkBasicReply(ctx, snap);
      ctx.check('不绘制任何线', snap.dom.overlayCount === 0, `overlays=${snap.dom.overlayCount} strokes=${JSON.stringify(snap.dom.routeStrokes)}`);
      ctx.check('无图形快照', (snap.store?.session?.shapes ?? []).length === 0, JSON.stringify(snap.store?.session?.shapes));
      ctx.check('回复说明超出路网数据范围', /超出了我的路网数据范围|超出.{0,6}路网数据范围/.test(reply), reply.slice(0, 400));
      ctx.check('不误入地点引导（地点已解析）', snap.dom.guideVisible === false, JSON.stringify(snap.dom.guideLabels));
      const logs = await ctx.logs(latestTraceId(snap));
      const failed = findLog(logs, 'plan.failed');
      ctx.setActual({ reason: failed?.reason ?? null, place: findLog(logs, 'place.resolved')?.label ?? null, reply: reply.slice(0, 300) });
      await ctx.shot('outside-coverage');
    },
  },
  {
    id: 'E5',
    category: 'E 引导/地点边界',
    title: '城市名地点·覆盖中心或追问地标',
    input: '在广州画个心形',
    expected:
      '城市名「广州」有两种正确交互：解析为覆盖中心（回复明确覆盖中心定位并规划），或 LLM 认为不够具体而追问地标（不规划）；两种都必须不静默画错地点',
    async run(ctx) {
      await ctx.send(this.input);
      ctx.check('轮次在超时前完成', await ctx.waitTurn());
      const snap = await ctx.snapshot();
      ctx.capture('state', snap);
      const reply = checkBasicReply(ctx, snap);
      const logs = await ctx.logs(latestTraceId(snap));
      const place = findLog(logs, 'place.resolved');
      if (snap.dom.guideVisible) {
        // 分支 A：追问更具体地标——合理交互，不得静默绘制
        ctx.setActual({ branch: 'guide' });
        ctx.check('城市名被视为过宽：追问地标（不规划）', (snap.store?.session?.shapes ?? []).length === 0, JSON.stringify(snap.store?.session?.shapes));
        ctx.check('追问不绘制任何线', snap.dom.overlayCount === 0, `overlays=${snap.dom.overlayCount}`);
        ctx.check('追问回复包含地点引导问题', reply.includes('想在哪里画'), reply.slice(0, 300));
        ctx.check('追问给出地点选项（4 地标+视野中心）', snap.dom.guideLabels.length === 5, JSON.stringify(snap.dom.guideLabels));
        ctx.check('context.guide.slot=place', snap.store?.session?.context?.guide?.slot === 'place', JSON.stringify(snap.store?.session?.context?.guide));
        await ctx.shot('city-center-guide');
        return;
      }
      // 分支 B：城市名解析为覆盖中心 → 规划
      ctx.setActual({ branch: 'coverage-center' });
      ctx.check('地点解析来源=coverage-center', place?.source === 'coverage-center', JSON.stringify(place));
      ctx.check('回复明确说明覆盖中心定位', reply.includes('覆盖中心'), reply.slice(0, 300));
      const outline = lastOutline(snap);
      ctx.check('目标图形名称为心形', /心形/.test(outline?.name ?? ''), JSON.stringify(outline));
      ctx.check('目标来源为规则图形渠道（内置或 LLM 点列）', ['builtin', 'llm'].includes(outline?.source), JSON.stringify(outline));
      const delivery = await checkDelivery(ctx, snap);
      if (!delivery.delivered) {
        checkHonestFailure(ctx, reply);
      }
      ctx.setActual({ outline, place: place?.label ?? null, delivered: delivery.delivered });
      await ctx.shot('city-center');
    },
  },

  // ================= F. 推荐/闲聊/不可画（3 例） =================
  {
    id: 'F1',
    category: 'F 推荐/闲聊/不可画',
    title: '条件实测推荐',
    input: '我只有二十分钟，在花城广场附近能画什么？',
    expected: 'action=recommend；时间条件被忽略（时间维度已移除）；对内置三图形实测后推荐或诚实说明都画不出；不绘制未验收图形',
    async run(ctx) {
      await ctx.send(this.input);
      ctx.check('轮次在超时前完成', await ctx.waitTurn());
      const snap = await ctx.snapshot();
      ctx.capture('state', snap);
      const reply = checkBasicReply(ctx, snap);
      ctx.check('走了实测推荐链路（回复含"实测"）', reply.includes('实测'), reply.slice(0, 400));
      const logs = await ctx.logs(latestTraceId(snap));
      ctx.check('日志存在 recommend 结果事件', Boolean(findLog(logs, 'recommend.result') || findLog(logs, 'recommend.failed')), JSON.stringify(logs?.map?.((item) => item.event)));
      const delivery = await checkDelivery(ctx, snap);
      if (delivery.delivered) {
        const outline = lastOutline(snap);
        ctx.check('推荐图形为内置三图形之一', outline?.source === 'builtin', JSON.stringify(outline));
        ctx.check('回复说明推荐图形与理由', /推荐/.test(reply), reply.slice(0, 400));
      } else {
        checkHonestFailure(ctx, reply);
      }
      ctx.setActual({ delivered: delivery.delivered, reply: reply.slice(0, 500) });
      await ctx.shot('recommend');
    },
  },
  {
    id: 'F2',
    category: 'F 推荐/闲聊/不可画',
    title: '闲聊（不触发规划）',
    input: '你好呀，今天广州天气怎么样？',
    expected: 'action=chat；只回复不规划：无目标点序列图、无图形快照、无引导、地图无线条',
    async run(ctx) {
      await ctx.send(this.input);
      ctx.check('轮次在超时前完成', await ctx.waitTurn());
      const snap = await ctx.snapshot();
      ctx.capture('state', snap);
      const reply = checkBasicReply(ctx, snap);
      ctx.check('闲聊不规划（无图形快照）', (snap.store?.session?.shapes ?? []).length === 0, JSON.stringify(snap.store?.session?.shapes));
      ctx.check('闲聊无目标点序列图', lastOutline(snap) === null, JSON.stringify(lastOutline(snap)));
      ctx.check('闲聊不进入引导', snap.dom.guideVisible === false, JSON.stringify(snap.dom.guideLabels));
      ctx.check('闲聊不绘制任何线', snap.dom.overlayCount === 0, `overlays=${snap.dom.overlayCount}`);
      const intent = findLog(await ctx.logs(latestTraceId(snap)), 'agent.intent');
      ctx.check('意图 action=chat', intent?.action === 'chat', JSON.stringify(intent?.action));
      ctx.check('回复有实质内容（非空且不止标点）', /./.test(reply.trim()) && reply.trim().length >= 5, reply.slice(0, 200));
      ctx.setActual({ reply: reply.slice(0, 300) });
      await ctx.shot('chat');
    },
  },
  {
    id: 'F3',
    category: 'F 推荐/闲聊/不可画',
    title: '不可闭环图形·正弦曲线',
    input: '帮我画一段正弦函数曲线',
    expected: '正弦曲线不是闭环：要么 action=chat 诚实说明，要么进入 plan 但按目标验收结论诚实交付/失败；都不得假绿线、不得错误气泡',
    async run(ctx) {
      await ctx.send(this.input);
      ctx.check('轮次在超时前完成', await ctx.waitTurn());
      const snap = await ctx.snapshot();
      ctx.capture('state', snap);
      const reply = checkBasicReply(ctx, snap);
      const outline = lastOutline(snap);
      const intent = findLog(await ctx.logs(latestTraceId(snap)), 'agent.intent');
      ctx.setActual({ action: intent?.action ?? null, hasOutline: Boolean(outline), reply: reply.slice(0, 400) });
      if (intent?.action === 'chat' || (!outline && (snap.store?.session?.shapes ?? []).length === 0)) {
        ctx.check('非闭环图形走 chat/不规划（无图形、无线条）', (snap.store?.session?.shapes ?? []).length === 0 && snap.dom.overlayCount === 0, JSON.stringify({ shapes: snap.store?.session?.shapes, overlays: snap.dom.overlayCount }));
        ctx.check('回复说明无法/不建议绘制的原因', /不能|无法|没法|闭环|闭合|连续|画不出|建议|去有回|不像/.test(reply), reply.slice(0, 400));
      } else {
        ctx.check('进入规划时有目标点序列图', Boolean(outline), JSON.stringify(outline));
        const delivery = await checkDelivery(ctx, snap);
        if (!delivery.delivered) {
          checkHonestFailure(ctx, reply);
        }
        ctx.setActual({ outline, delivered: delivery.delivered });
      }
      await ctx.shot('sine');
    },
  },

  // ================= G. 交互稳定性综合（4 例） =================
  {
    id: 'G1',
    category: 'G 交互稳定性',
    title: '多轮规划 + 图形切换 + 刷新恢复 + 历史切换 + 窄屏',
    input: '在荔湾区画个矩形 → 在沙面岛画个五角星 → 新建对话 → 历史切回',
    expected: '两轮图形可切换（x/N）；刷新后消息/图形/序号恢复；新建对话独立；历史切回旧对话图形正确；375px 无横向溢出',
    async run(ctx) {
      // 第 1 轮
      await ctx.send('在荔湾区画个矩形');
      ctx.check('第 1 轮在超时前完成', await ctx.waitTurn());
      const first = await ctx.snapshot();
      const firstDelivery = await checkDelivery(ctx, first, '第 1 轮 ');
      ctx.check('第 1 轮产生图形快照', firstDelivery.delivered, JSON.stringify(first.store?.session?.shapes));
      // 第 2 轮
      await ctx.send('在沙面岛画个五角星');
      ctx.check('第 2 轮在超时前完成', await ctx.waitTurn());
      const second = await ctx.snapshot();
      ctx.capture('two-turns', second);
      const shapeCount = second.store?.session?.shapes?.length ?? 0;
      ctx.check('同对话累计 ≥2 个图形', shapeCount >= 2, String(shapeCount));
      ctx.check('图形序号指示为 N/N', second.dom.indicator.includes(`${shapeCount}/${shapeCount}`), second.dom.indicator);
      await ctx.shapeNav('prev');
      const prevIndicator = (await ctx.snapshot()).dom.indicator;
      ctx.check('切到上一个图形（1/N）', prevIndicator.includes(`1/${shapeCount}`), prevIndicator);
      await ctx.shapeNav('latest');
      const latestIndicator = (await ctx.snapshot()).dom.indicator;
      ctx.check('一键"最新"回到 N/N', latestIndicator.includes(`${shapeCount}/${shapeCount}`), latestIndicator);
      // 刷新恢复
      const beforeReload = await ctx.snapshot();
      await ctx.reload();
      const reloadReady = await ctx.waitFor(
        `document.getElementById('shape-indicator').textContent.includes('${shapeCount}/${shapeCount}')`,
        60000,
        '刷新后图形序号恢复',
      );
      ctx.check('刷新后图形序号恢复', reloadReady);
      const afterReload = await ctx.snapshot();
      ctx.check('刷新后消息保留', afterReload.store?.session?.messageCount === beforeReload.store?.session?.messageCount, `${afterReload.store?.session?.messageCount} vs ${beforeReload.store?.session?.messageCount}`);
      ctx.check('刷新后图形数据保留', (afterReload.store?.session?.shapes?.length ?? 0) === shapeCount, String(afterReload.store?.session?.shapes?.length));
      ctx.check('刷新后地图重绘图形', afterReload.dom.overlayCount >= 2, String(afterReload.dom.overlayCount));
      // 新建对话（独立上下文）
      const oldSessionId = afterReload.store?.activeId;
      await ctx.newSession();
      await sleep(1200);
      const freshEmpty = await ctx.snapshot();
      ctx.check('新建对话回到空对话', (freshEmpty.store?.session?.messageCount ?? 0) <= 1, JSON.stringify(freshEmpty.store?.session?.messageCount));
      await ctx.send('在花城广场画个心形');
      ctx.check('新对话轮次在超时前完成', await ctx.waitTurn());
      const fresh = await ctx.snapshot();
      ctx.capture('new-session', fresh);
      ctx.check('新建对话后至少 2 个会话', (fresh.store?.sessions?.length ?? 0) >= 2, JSON.stringify(fresh.store?.sessions));
      ctx.check('新对话上下文独立（图形数=1）', (fresh.store?.session?.shapes?.length ?? 0) === 1, JSON.stringify(fresh.store?.session?.shapes));
      // 历史切回旧对话
      await ctx.openHistory();
      await ctx.waitFor(`document.querySelectorAll('#session-list .session-item-main').length >= 2`, 15000, '历史列表渲染');
      const switched = await ctx.switchHistory(1);
      ctx.check('历史列表可切换回旧对话', switched?.ok === true, JSON.stringify(switched));
      await sleep(1000);
      const back = await ctx.snapshot();
      ctx.capture('history-back', back);
      ctx.check('切回旧对话：消息/图形为旧对话内容', back.store?.activeId === oldSessionId && (back.store?.session?.shapes?.length ?? 0) === shapeCount, JSON.stringify({ active: back.store?.activeId, old: oldSessionId, shapes: back.store?.session?.shapes?.length }));
      // 窄屏 375
      await ctx.setViewport(375, 700, { mobile: true, scale: 2 });
      const narrow = await ctx.snapshot();
      ctx.capture('narrow', narrow);
      ctx.check('375px 无页面级横向溢出', narrow.dom.overflowX <= 2, `overflowX=${narrow.dom.overflowX}`);
      const switcher = narrow.dom.switcherRect;
      ctx.check('375px 图形切换控件在视口内', !switcher || (switcher.right <= 376 && switcher.left >= -1), JSON.stringify(switcher));
      await ctx.clearViewport();
      ctx.setActual({ shapeCount, oldSessionId, sessions: fresh.store?.sessions ?? null });
      await ctx.shot('multi-turn-ui');
    },
  },
  {
    id: 'G2',
    category: 'G 交互稳定性',
    title: '停止进行中的轮次',
    input: '在珠江新城画一只狮子（进行中点击停止）',
    expected: '进行中按钮变「停止」；点击后本轮立即中断：标记「已停止」、不新增图形、地图保持停止前状态、无错误气泡',
    async run(ctx) {
      await ctx.send('在珠江新城画一只狮子');
      const busyStarted = await ctx.waitFor(
        `document.getElementById('agent-send').textContent.trim() === '停止'`,
        30000,
        '轮次进入进行中',
      );
      ctx.check('轮次进入进行中（按钮=停止）', busyStarted);
      if (!busyStarted) {
        const finished = await ctx.snapshot();
        ctx.check('进行中按钮为「停止」', finished.dom.sendText === '停止', finished.dom.sendText);
        return;
      }
      await sleep(1500);
      const busy = await ctx.snapshot();
      ctx.capture('busy', busy);
      ctx.check('点击停止前仍在进行中', busy.dom.sendText === '停止', busy.dom.sendText);
      const stopped = await ctx.clickSend();
      ctx.check('点击停止按钮', Boolean(stopped), JSON.stringify(stopped));
      ctx.check('停止后轮次收尾（≤120s）', await ctx.waitTurn(120000));
      const snap = await ctx.snapshot();
      ctx.capture('stopped', snap);
      const reply = lastReply(snap);
      ctx.check('回复标记「已停止」', reply.includes('已停止'), reply.slice(0, 200));
      const lastUser = (snap.store?.session?.messages ?? []).filter((message) => message.role === 'user').at(-1);
      ctx.check('用户消息状态=stopped', lastUser?.status === 'stopped', JSON.stringify(lastUser?.status));
      ctx.check('停止轮不新增图形', (snap.store?.session?.shapes ?? []).length === 0, JSON.stringify(snap.store?.session?.shapes));
      ctx.check('停止轮地图不绘制新线', snap.dom.overlayCount === 0, `overlays=${snap.dom.overlayCount}`);
      ctx.check('停止不是失败：无错误气泡', !snap.dom.errorText, snap.dom.errorText);
      await ctx.shot('stop');
    },
  },
  {
    id: 'G3',
    category: 'G 交互稳定性',
    title: '图片上传入口·五角星图片（经图像描摹成为目标）',
    input: '上传五角星图片 + 「这张图是什么图形？画在花城广场」',
    expected:
      '图片经 file input 进入待发送预览；图片经图像描摹成为目标（来源=图像描摹），不再让视觉模型识别为内置图形；描摹点数 120~320；日志无带 image_url 的 llm.request、无 agent.reference.used；交付行为一致',
    async run(ctx) {
      const uploadReady = await ctx.uploadImageBase64(STAR_PNG_BASE64, 'star.png');
      ctx.check('图片进入待发送预览', uploadReady);
      await ctx.snapshot();
      ctx.check('预览缩略图已渲染', await ctx.waitFor(`Boolean(document.getElementById('agent-attach-thumb').src)`, 15000, '缩略图渲染'));
      await ctx.send('这张图是什么图形？画在花城广场');
      ctx.check('图片轮在超时前完成', await ctx.waitTurn());
      const snap = await ctx.snapshot();
      ctx.capture('state', snap);
      const reply = checkBasicReply(ctx, snap);
      const userMessages = (snap.store?.session?.messages ?? []).filter((message) => message.role === 'user');
      ctx.check('用户消息带图片', userMessages.some((message) => message.hasImage), JSON.stringify(userMessages.map((message) => message.hasImage)));
      const traceId = latestTraceId(snap);
      const logs = await ctx.logs(traceId);
      const intent = findLog(logs, 'agent.intent');
      ctx.check('意图 action=plan', intent?.action === 'plan', JSON.stringify(intent));
      ctx.check(
        '不再让视觉模型识别为内置图形（意图 shapeKey=null、customShape.source=traced）',
        intent?.shapeKey == null && intent?.customShape?.source === 'traced',
        JSON.stringify(intent && { shapeKey: intent.shapeKey, customShape: intent.customShape }),
      );
      ctx.check(
        '日志有 agent.imageTrace.used（图片经图像描摹成功）',
        await ctx.waitFor(`(() => {
          const api = window.DrawInMapLog;
          if (!api || typeof api.entries !== 'function') return false;
          const list = api.entries({ traceId: ${JSON.stringify(traceId)}, level: 'debug', limit: 0 }) || [];
          return list.some((item) => item.event === 'agent.imageTrace.used' && Boolean(item.data?.contentHash));
        })()`, 8000, '图像描摹日志'),
      );
      ctx.check(
        '日志无带 image_url/data:image 的 llm.request（不把图交给模型估点）',
        await ctx.waitFor(`(() => {
          const api = window.DrawInMapLog;
          if (!api || typeof api.entries !== 'function') return false;
          const list = api.entries({ traceId: ${JSON.stringify(traceId)}, level: 'debug', limit: 0 }) || [];
          return !list.some((item) => item.event === 'llm.request' && JSON.stringify(item.data?.messages ?? []).includes('image_url'));
        })()`, 8000, '无图片输入 LLM'),
      );
      ctx.check(
        '日志无 agent.reference.used（描摹目标不走参考通道）',
        await ctx.waitFor(`(() => {
          const api = window.DrawInMapLog;
          if (!api || typeof api.entries !== 'function') return false;
          const list = api.entries({ traceId: ${JSON.stringify(traceId)}, level: 'debug', limit: 0 }) || [];
          return !list.some((item) => item.event === 'agent.reference.used');
        })()`, 8000, '无参考命中'),
      );
      const outline = lastOutline(snap);
      ctx.check('目标来源=图像描摹（traced）', outline?.source === 'traced', JSON.stringify(outline));
      ctx.check('目标名称含「图像描摹」', (outline?.name ?? '').includes('图像描摹'), JSON.stringify(outline));
      ctx.check('描摹点数 120~320', (outline?.pointCount ?? 0) >= 120 && (outline?.pointCount ?? 0) <= 320, JSON.stringify(outline));
      ctx.check('目标点序列图不是内置图形渠道', outline?.source !== 'builtin', JSON.stringify(outline?.source));
      const delivery = await checkDelivery(ctx, snap);
      if (!delivery.delivered) {
        checkHonestFailure(ctx, reply);
      }
      ctx.setActual({
        shapeKey: intent?.shapeKey ?? null,
        customShape: intent?.customShape ?? null,
        outline,
        delivered: delivery.delivered,
      });
      await ctx.shot('image-upload');
    },
  },
  {
    id: 'G4',
    category: 'G 交互稳定性',
    title: '多对象请求（参考图让位）',
    input: '在越秀公园画只猫，旁边再画只狗',
    expected: '文本同时命中猫/狗两个对象 → 参考图通道让位 LLM（不自动生成单对象候选卡）；不崩溃、不假绿线，回复与行为一致',
    async run(ctx) {
      await ctx.send(this.input);
      ctx.check('轮次在超时前完成', await ctx.waitTurn());
      const snap = await ctx.snapshot();
      ctx.capture('state', snap);
      const reply = checkBasicReply(ctx, snap);
      ctx.check('多对象不自动弹单对象候选卡（参考图让位）', snap.dom.refCards.length === 0, JSON.stringify(snap.dom.refCards));
      const outline = lastOutline(snap);
      const delivered = (snap.store?.session?.shapes ?? []).length > 0;
      if (delivered) {
        ctx.check('交付时有目标点序列图', Boolean(outline), JSON.stringify(outline));
        const delivery = await checkDelivery(ctx, snap);
        ctx.check('多对象交付行为一致', delivery.consistent);
        ctx.setActual({ outline, delivered });
      } else {
        ctx.check('未交付时不绘制任何线', snap.dom.overlayCount === 0, `overlays=${snap.dom.overlayCount}`);
        checkHonestFailure(ctx, reply);
        ctx.setActual({ outline: null, delivered: false });
      }
      await ctx.shot('multi-object');
    },
  },
];

/** 供驱动脚本引用的辅助函数（保持断言口径统一） */
export const __testHelpers = { lastOutline, lastReply, latestTraceId, findLog };
