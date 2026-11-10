/**
 * DrawInMap 真实浏览器 E2E 用例共享断言/流程库（只给 test/e2e-real-llm-*.mjs 用例文件使用）。
 *
 * 设计口径（与 2026-11-02 的 20 例套件一致，并按本轮发现补强）：
 * - 三层证据：页面落盘状态（localStorage 会话）→ 地图图层颜色/目标点序列图 → 页面日志 API
 *   里的真实链路事件（agent.intent / place.resolved / deliver.* / target.* / recommend.*）。
 * - 交付分三态，不能混为一谈：
 *   green  = 绿线合格交付（目标验收 + 路线验收都过）；
 *   orange = 橙色诊断参考版（目标/路线未过，产品明确标注「非合格」）；
 *   none   = 未交付（必须诚实说明原因，不允许静默）。
 * - 新增「退化交付」硬断言：只要地图上有图形快照，最近一条快照必须
 *   sizeMeters > 0 且 score > 0。历史上大量「记 PASS 实为 0.0 km 橙版」的轮次
 *   就是漏了这条（根因见 2026-11-04 提交「恢复路径补齐尺寸基准」）。
 * - 每例允许产品定义的合法分支（参考图可单候选直走或弹候选卡；自由轮廓可交付/橙版/
 *   诚实失败；缺地点可追问），但「结果正确性」不允许放宽：交付的名称/来源必须对得上，
 *   未交付必须有原因，橙版必须是非合格说明。
 *
 * 依赖：tools/e2e-real-llm-30.mjs 提供的 ctx（send/waitTurn/snapshot/logs/check/...）。
 */

import { __testHelpers } from './e2e-real-llm-30-cases.mjs';
import {
  evaluateDeliveryReport,
  detectScopeWidening,
} from '../tools/lib/delivery-report.js';
import { checkDeliveryObjectConsistency } from '../web/src/agent/request-objects.js';

const { lastOutline, lastReply, latestTraceId, findLog } = __testHelpers;

/** 未交付时必须出现的原因词（诚实失败，不静默） */
const HONEST_MARKERS = [
  '没有画',
  '没画出来',
  '画不出',
  '没能生成',
  '没有可用轮廓',
  '不能开始正式规划',
  '没有硬画',
  '都画不出',
  '目标验收没有通过',
  '已尽力尝试',
  '仅供参考',
  '没法',
  '超出',
  '没有可用轮廓',
  '没能',
  '生成失败',
  '校验',
  '不让画',
  '先不画',
  '不绘制',
];

/** 橙色诊断参考版必须出现的「非合格」提示词 */
const REFERENCE_MARKERS = ['参考', '仅供参考', '没有通过', '不合格', '不建议', '非合格', '最接近'];

/** chat（拒绝/闲聊）分支必须出现的「说明原因/给替代」提示词 */
const CHAT_REASON_MARKERS = ['难', '没法', '无法', '不适合', '建议', '换成', '简化', '辨认', '不闭合', '不硬画', '只能', '抱歉'];

/** 判断文本是否包含任一 marker */
function includesAny(text, markers) {
  const haystack = String(text ?? '');
  return markers.some((marker) => haystack.includes(marker));
}

/**
 * 契约维度事实收集器（方案 2026-11-05 §5.1）。
 *
 * 契约维度 = 回复健康 + 绘制状态与图形快照一致 + 交付非退化 + 未交付时诚实说明。
 * 这些事实单独收集，用于计算 contractPass——不再用"地图为绿"代表全部结论。
 *
 * @returns {{add: (name: string, ok: boolean) => void, pass: () => boolean, facts: Array<object>}}
 */
function contractGate() {
  const facts = [];
  return {
    add(name, ok) {
      facts.push({ name, ok: Boolean(ok) });
    },
    pass() {
      return facts.length > 0 && facts.every((item) => item.ok);
    },
    facts,
  };
}

/** 从快照取最近一条已交付图形（shapes 数组尾部） */
function lastShape(snap) {
  const shapes = snap?.store?.session?.shapes ?? [];
  return shapes.length ? shapes[shapes.length - 1] : null;
}

/** 取本轮最后一条智能体回复（含 error 消息） */
function replyOf(snap) {
  return lastReply(snap) ?? '';
}

/** 断言基础回复健康：无错误气泡 + 回复非空 */
export function checkBasicReply(ctx, snap, prefix = '', gate = null) {
  const noError = !snap?.dom?.errorText;
  ctx.check(`${prefix}无错误气泡`, noError, String(snap?.dom?.errorText ?? ''));
  const reply = replyOf(snap);
  const replyOk = Boolean(reply.trim());
  ctx.check(`${prefix}回复非空`, replyOk, reply.slice(0, 200));
  if (gate) {
    gate.add('reply-no-error', noError);
    gate.add('reply-non-empty', replyOk);
  }
  return reply;
}

/**
 * 读取本轮真实链路日志里的最后一个事件 data。
 *
 * @param {object} ctx 用例上下文
 * @param {string|null} traceId 本轮 traceId
 * @param {string} event 事件名
 * @returns {Promise<object|null>} 事件 data
 */
export async function logOf(ctx, traceId, event) {
  if (!traceId) {
    return null;
  }
  return findLog(await ctx.logs(traceId), event);
}

/**
 * 把一句话发出去并等本轮结束，返回首轮快照与意图证据。
 *
 * @param {object} ctx 用例上下文
 * @param {string} text 用户输入
 * @returns {Promise<{snap: object, traceId: string|null, intent: object|null}>} 首轮结果
 */
async function sendAndWait(ctx, text) {
  await ctx.send(text);
  const finished = await ctx.waitTurn();
  ctx.check('轮次在超时前完成', finished, '页面在单轮等待上限内未回到空闲');
  const snap = await ctx.snapshot();
  ctx.capture('turn1', snap);
  const traceId = latestTraceId(snap);
  const intent = findLog(await ctx.logs(traceId), 'agent.intent');
  return { snap, traceId, intent };
}

/**
 * 若首轮出现候选卡则点第一张并等选择轮结束。
 *
 * 注意：点选后的规划轮按设计不重进 LLM 解析，其 trace 里没有 agent.intent；
 * 意图证据必须用点选前的 trace（候选轮）读取。
 *
 * @param {object} ctx 用例上下文
 * @param {object} snap 首轮快照
 * @returns {Promise<{snap: object, clicked: boolean, cards: Array<object>, finalTraceId: string|null}>} 选择后快照
 */
async function selectFirstCardIfAny(ctx, snap) {
  const cards = snap?.dom?.refCards ?? [];
  if (cards.length === 0) {
    return { snap, clicked: false, cards, finalTraceId: latestTraceId(snap) };
  }
  ctx.check(
    '候选卡带实际 T 小图与点数',
    cards.every((card) => card.hasImage && card.pointCount > 0),
    JSON.stringify(cards),
  );
  ctx.check('候选卡不超过产品上限（≤4）', cards.length <= 4, String(cards.length));
  const clicked = await ctx.clickRefCard(0);
  ctx.check('点击候选卡进入规划轮', clicked?.ok === true, JSON.stringify(clicked));
  const finished = await ctx.waitTurn();
  ctx.check('选择轮在超时前完成', finished, '选择轮等待超时');
  const next = await ctx.snapshot();
  ctx.capture('selected', next);
  return { snap: next, clicked: true, cards, finalTraceId: latestTraceId(next) };
}

/**
 * 交付三态判定：green / orange / none + 一致性 + 退化检查。
 *
 * @param {object} ctx 用例上下文
 * @param {object} snap 终态快照
 * @param {string} reply 回复文本
 * @returns {Promise<{delivery: object, mode: 'green'|'orange'|'none'}>} 交付信息
 */
async function inspectDelivery(ctx, snap, reply, gate = null) {
  const delivery = await ctx.delivery(snap);
  ctx.check(
    '地图颜色与图形快照一致（绿=合格 / 橙=参考版 / 失败无线）',
    delivery.consistent,
    `delivered=${delivery.delivered} green=${delivery.green} orange=${delivery.orange} shapes=${JSON.stringify(delivery.shapes)} strokes=${JSON.stringify(delivery.strokes)}`,
  );
  if (gate) {
    gate.add('draw-state-consistent', delivery.consistent);
  }
  let mode = 'none';
  if (delivery.green) {
    mode = 'green';
  } else if (delivery.orange) {
    mode = 'orange';
  }
  if (delivery.delivered) {
    const shape = lastShape(snap);
    const nonDegenerate = Number(shape?.sizeMeters) > 0 && Number(shape?.score) > 0;
    ctx.check(
      '交付图形非退化（sizeMeters>0 且 score>0）',
      nonDegenerate,
      JSON.stringify(shape),
    );
    const outline = lastOutline(snap);
    ctx.check('交付轮带目标点序列图元数据', Boolean(outline), JSON.stringify(outline ?? null));
    if (gate) {
      gate.add('shape-non-degenerate', nonDegenerate);
      gate.add('outline-present', Boolean(outline));
    }
  }
  if (mode === 'orange') {
    const labeled = includesAny(reply, REFERENCE_MARKERS);
    ctx.check(
      '橙色诊断参考版明确标注非合格（reply 含参考/未通过等）',
      labeled,
      reply.slice(0, 400),
    );
    if (gate) {
      gate.add('reference-labeled', labeled);
    }
  }
  return { delivery, mode };
}

/** 判断是否属于「未交付时的诚实说明」 */
export function checkHonestFailure(ctx, reply, prefix = '', gate = null) {
  const honest = includesAny(reply, HONEST_MARKERS);
  ctx.check(
    `${prefix}未交付时回复明确说明原因（诚实失败，不静默）`,
    honest,
    reply.slice(0, 400),
  );
  if (gate) {
    gate.add('honest-failure', honest);
  }
}

/**
 * 校验交付目标名称与来源是否符合用例期望。
 *
 * @param {object} ctx 用例上下文
 * @param {object} snap 终态快照
 * @param {string} reply 回复
 * @param {object} expect 用例期望
 */
function checkTarget(ctx, snap, reply, expect, delivery) {
  const outline = lastOutline(snap);
  const shape = lastShape(snap);
  const deliveredName = String(shape?.shapeName ?? '');
  const outlineName = String(outline?.name ?? '');
  const names = [deliveredName, outlineName].filter(Boolean);
  const forbidden = expect.forbidNameExact ?? [];
  if (forbidden.length && names.length) {
    for (const name of names) {
      ctx.check(`不得把目标错误画成「${forbidden.join('/')}」`, !forbidden.includes(name), JSON.stringify({ deliveredName, outlineName }));
    }
  }
  // 未交付且没有目标点序列图时（诚实失败/引导），名称断言不适用；
  // 结果正确性由「诚实失败/引导」断言保证。
  const hasTarget = Boolean(outline) || Boolean(delivery?.delivered);
  if (expect.nameIncludes?.length && hasTarget) {
    // 2026-11-08 §6.1：目标名称**只**看实际交付身份（交付名 / 点序列名），
    // 不再允许回复里的原始目标词兜底冒充交付身份（那会把没交付的对象算成交付了）。
    const hit = expect.nameIncludes.some((keyword) => names.some((name) => name.includes(keyword)));
    ctx.check(
      `目标名称含「${expect.nameIncludes.join('|')}」（交付名/点序列名）`,
      hit,
      JSON.stringify({ deliveredName, outlineName }),
    );
  }
  if (expect.outlineSources?.length && outline) {
    ctx.check(
      `目标来源 ∈ {${expect.outlineSources.join('|')}}`,
      expect.outlineSources.includes(outline.source),
      JSON.stringify(outline),
    );
  }
  // 通用断言：回复必须包含的原文片段（用于"必须明确列出已命中/缺失对象"这类要求）
  if (expect.replyIncludes?.length) {
    const missing = expect.replyIncludes.filter((keyword) => !String(reply ?? '').includes(keyword));
    ctx.check(
      `回复含「${expect.replyIncludes.join('|')}」`,
      missing.length === 0,
      JSON.stringify({ missing, reply: String(reply ?? '').slice(0, 300) }),
    );
  }
  // 多对象请求的结果正确性：交付目标必须包含用户点名的全部对象（或明确诚实失败）
  if (expect.multiObjectKeywords?.length && delivery.delivered) {
    const name = String(lastShape(snap)?.shapeName ?? lastOutline(snap)?.name ?? '');
    // 复合目标的名字是「A+B+C」：多段时逐段比对（允许"鸭"↔"鸭子"这类全称/简称差异，
    // 但**不**用整串子串比对——那会把「猫头鹰+猫头鹰」当成包含「猫头鹰+猫」的合法交付，
    // 放走重复部件缺陷；重复/缺失由生产侧的一对一身份匹配（targetPass）负责拦截）。
    const segments = name.split('+').map((item) => item.trim()).filter(Boolean);
    const segmentMatches = (segment, keyword) =>
      segment === keyword || segment.includes(keyword) || keyword.includes(segment);
    const missing = expect.multiObjectKeywords.filter((keyword) =>
      segments.length > 1
        ? !segments.some((segment) => segmentMatches(segment, keyword))
        : !name.includes(keyword),
    );
    ctx.check(
      `多对象交付必须包含全部对象「${expect.multiObjectKeywords.join('+')}」`,
      missing.length === 0,
      JSON.stringify({ deliveredName: name, segments, missing, reply: reply.slice(0, 240) }),
    );
  }

  if (outline) {
    ctx.check('目标点数有效（≥3）', Number(outline.pointCount) >= 3, JSON.stringify(outline));
  }
}

/**
 * 最终产物断言（方案 2026-11-08 §6.1）。
 *
 * 断言的是**实际交付的产物**（图形快照），不是意图：
 * - 显式尺寸：最终交付尺寸一致或在声明容差内；
 * - 显式朝向：最终交付朝向一致或在声明容差内；
 * - 多对象：实际交付的组成部分与请求对象一一对应（用结构化 deliveredObjects）。
 *
 * @param {object} ctx 用例上下文
 * @param {object} snap 终态快照
 * @param {object} expect 用例期望
 * @param {object} delivery 交付状态
 */
function checkDeliveredArtifact(ctx, snap, expect, delivery) {
  const shape = lastShape(snap);
  const hasArtifactExpectation =
    Boolean(expect.deliveredSizeMeters) ||
    expect.deliveredRotationDeg != null ||
    Boolean(expect.deliveredObjects?.length);
  if (!hasArtifactExpectation) {
    return;
  }
  // 未交付是**合法**结果之一（诚实失败/请求确认）：此时尺寸/朝向/对象断言不适用，
  // 由「诚实失败」与「交付结果类别」断言兜住（方案 2026-11-08 §8.3 的验收点：
  // "正式交付必须为 800m 或声明容差内；否则诚实失败/请求确认"）。
  if (!delivery?.delivered || !shape) {
    return;
  }
  // 显式尺寸
  if (expect.deliveredSizeMeters) {
    const tolerance = Number.isFinite(expect.deliveredSizeToleranceMeters)
      ? expect.deliveredSizeToleranceMeters
      : Math.max(60, Math.round(expect.deliveredSizeMeters * 0.12));
    const actual = Number(shape.sizeMeters);
    ctx.check(
      `最终交付尺寸=${expect.deliveredSizeMeters}m ±${tolerance}m`,
      Number.isFinite(actual) && Math.abs(actual - expect.deliveredSizeMeters) <= tolerance,
      JSON.stringify({ actual, tolerance }),
    );
  }
  // 显式朝向
  if (expect.deliveredRotationDeg != null) {
    const tolerance = Number.isFinite(expect.deliveredRotationToleranceDeg)
      ? expect.deliveredRotationToleranceDeg
      : 5;
    const actual = Number(shape.rotationDeg);
    const diff = Number.isFinite(actual)
      ? Math.abs(((actual - expect.deliveredRotationDeg + 540) % 360) - 180)
      : Infinity;
    ctx.check(
      `最终交付朝向=${expect.deliveredRotationDeg}° ±${tolerance}°`,
      Number.isFinite(actual) && diff <= tolerance,
      JSON.stringify({ actual, diff, tolerance }),
    );
  }
  // 多对象：实际交付组成部分与请求对象一一对应
  if (expect.deliveredObjects?.length) {
    const delivered = Array.isArray(shape.deliveredObjects) ? shape.deliveredObjects : [];
    const deliveredNames = delivered.map((item) => String(item?.name ?? '')).filter(Boolean);
    // 名称匹配：相等或互为子串（"鸭" ↔ "鸭子"），不接受完全无关的名字
    const matches = (keyword, name) => name === keyword || name.includes(keyword) || keyword.includes(name);
    const missing = expect.deliveredObjects.filter((keyword) =>
      !deliveredNames.some((name) => matches(keyword, name)),
    );
    ctx.check(
      `实际交付对象逐个对应「${expect.deliveredObjects.join('+')}」`,
      deliveredNames.length > 0 && missing.length === 0,
      JSON.stringify({ deliveredNames, missing }),
    );
    // 身份必须可核实：不得出现"数量对得上但身份没核实"的顶替
    if (expect.requireVerifiedObjects) {
      const unverified = delivered.filter((item) => item?.identified === false);
      ctx.check(
        '实际交付对象身份均已核实（没有未识别的部分顶替）',
        unverified.length === 0,
        JSON.stringify({ unverified }),
      );
    }
  }
}

/**
 * 用户显式约束的核验断言（方案 2026-11-08 §4.1/§8.4）。
 *
 * 绿线交付时，用户显式约束必须**已核验**（constraintResults 里的 user-constraint
 * 条目不得是 unavailable）；"无法核验"必须降级为橙色参考或诚实失败，不得绿线。
 *
 * @param {object} ctx 用例上下文
 * @param {Array<object>} logs 本轮日志
 * @param {Array<object>} candidateLogs 候选轮日志
 * @param {object} expect 用例期望
 * @param {object} delivery 交付状态
 */
function checkVerifiedConstraints(ctx, logs, candidateLogs, expect, delivery, mode = null) {
  if (!expect.expectVerifiedConstraints) {
    return;
  }
  const targetLog =
    findLog(logs, 'target.accepted') ??
    findLog(logs, 'target.rejected') ??
    findLog(candidateLogs, 'target.accepted') ??
    findLog(candidateLogs, 'target.rejected');
  const results = Array.isArray(targetLog?.constraintResults) ? targetLog.constraintResults : [];
  const userResults = results.filter((item) => item?.kind === 'user-constraint');
  const unverified = userResults.filter((item) => item?.status === 'unavailable');
  const failed = userResults.filter((item) => item?.status === 'fail');
  if (!delivery?.delivered) {
    // 未交付：约束核验结论由「诚实失败」断言保证，不在这里判失败
    return;
  }
  // 只有**绿线**交付才允许"约束已核验且已满足"；
  // 橙色参考版正是"约束没满足/没核验"的诚实降级产物，不在此处判失败。
  if (mode !== 'green') {
    return;
  }
  ctx.check(
    '绿线交付时用户显式约束已核验（无 unavailable 条目）',
    unverified.length === 0,
    JSON.stringify({ unverified, results }),
  );
  ctx.check(
    '绿线交付时用户显式约束均已满足（无 fail 条目）',
    failed.length === 0,
    JSON.stringify({ failed, results }),
  );
}

/**
 * 校验意图字段（动作/尺寸/朝向/用户约束/地点）。
 *
 * @param {object} ctx 用例上下文
 * @param {object|null} intent agent.intent 数据
 * @param {object} expect 用例期望
 * @param {object} logs 本轮日志（取 place.resolved）
 * @param {string} reply 回复
 */
function checkIntent(ctx, intent, expect, logs, reply) {
  if (!intent) {
    ctx.check('意图解析成功（本轮有 agent.intent）', false, '本轮日志没有 agent.intent');
    return;
  }
  if (expect.actions?.length) {
    ctx.check(
      `动作 ∈ {${expect.actions.join('|')}}`,
      expect.actions.includes(intent.action),
      JSON.stringify({ action: intent.action }),
    );
  }
  if (expect.intentSizeMeters != null) {
    ctx.check(`意图显式尺寸=${expect.intentSizeMeters}`, intent.sizeMeters === expect.intentSizeMeters, String(intent.sizeMeters));
  }
  if (expect.intentSizeIn?.length) {
    ctx.check(
      `意图显式尺寸 ∈ {${expect.intentSizeIn.join('|')}}（产品尺寸钳制/默认基准的合法口径）`,
      expect.intentSizeIn.includes(intent.sizeMeters),
      String(intent.sizeMeters),
    );
  }
  if (expect.intentHasSize) {
    ctx.check('意图尺寸基准非空（防尺寸阶梯全 0）', Number(intent.sizeMeters) > 0, String(intent.sizeMeters));
  }
  if (expect.intentRotationDeg != null) {
    ctx.check(
      `意图显式朝向=${expect.intentRotationDeg}±5`,
      Math.abs(Number(intent.rotationDeg) - expect.intentRotationDeg) <= 5,
      String(intent.rotationDeg),
    );
  }
  if (expect.userConstraintIncludes) {
    const constraints = Array.isArray(intent.userConstraints) ? intent.userConstraints.join('|') : '';
    // 用户显式要求也可能被解析进 referenceQuery.traits（素材检索线索）——
    // 约束被记下来才算"可核验"，落在哪一层不改变验收口径。
    const traits = Array.isArray(intent.referenceQuery?.traits) ? intent.referenceQuery.traits.join('|') : '';
    ctx.check(
      `意图记录用户显式特征「${expect.userConstraintIncludes}」`,
      `${constraints}|${traits}`.includes(expect.userConstraintIncludes),
      JSON.stringify({ userConstraints: intent.userConstraints ?? null, traits: intent.referenceQuery?.traits ?? null }),
    );
  }
  if (expect.placeIncludes?.length && intent.action !== 'chat') {
    const placeLog = findLog(logs, 'place.resolved');
    const placeText = `${intent.place ?? ''}|${placeLog?.label ?? ''}|${reply}`;
    ctx.check(
      `地点证据含「${expect.placeIncludes.join('|')}」`,
      expect.placeIncludes.some((keyword) => placeText.includes(keyword)),
      JSON.stringify({ intentPlace: intent.place ?? null, placeLabel: placeLog?.label ?? null }),
    );
  }
  if (expect.intentShapeIncludes?.length) {
    const shapeText = JSON.stringify({
      name: intent.customShape?.name ?? null,
      spec: intent.shapeSpec?.summary ?? null,
      family: intent.shapeSpec?.family ?? null,
    });
    ctx.check(
      `意图图形含「${expect.intentShapeIncludes.join('|')}」`,
      expect.intentShapeIncludes.some((keyword) => shapeText.includes(keyword)),
      shapeText,
    );
  }
  // 参数化实际规格断言（方案 2026-11-08 §6.1）：内/外半径比必须与要求一致
  if (expect.expectSpecInnerOuterRatio != null) {
    // 规格既可能是标量（innerRadii=0.5），也可能是逐尖数组（六角星 [0.5×6]）
    const outerRaw = intent.shapeSpec?.outerRadii;
    const innerRaw = intent.shapeSpec?.innerRadii;
    const outerList = Array.isArray(outerRaw) ? outerRaw : [outerRaw];
    const innerList = Array.isArray(innerRaw) ? innerRaw : [innerRaw];
    const ratios = outerList.map((outer, index) => {
      const inner = innerList[Math.min(index, innerList.length - 1)];
      return Number.isFinite(Number(outer)) && Number(outer) > 0 && Number.isFinite(Number(inner))
        ? Number(inner) / Number(outer)
        : null;
    });
    const usable = ratios.filter((item) => item !== null);
    const tolerance = expect.expectSpecRatioTolerance ?? 0.02;
    const ok =
      usable.length > 0 &&
      usable.every((ratio) => Math.abs(ratio - expect.expectSpecInnerOuterRatio) <= tolerance);
    ctx.check(
      `参数化实际规格 innerRadii/outerRadii=${expect.expectSpecInnerOuterRatio}`,
      ok,
      JSON.stringify({
        outerRadii: outerRaw ?? null,
        innerRadii: innerRaw ?? null,
        ratios,
        tolerance,
      }),
    );
  }
  // 参数化规格必须通过几何不变量（目标验收结论）
  if (expect.expectSpecInvariants) {
    const targetLog = findLog(logs, 'target.accepted') ?? findLog(logs, 'target.rejected');
    const structure = (targetLog?.constraintResults ?? []).find((item) => item?.kind === 'structure');
    ctx.check(
      '参数化规格的几何不变量复验通过',
      structure?.status === 'pass',
      JSON.stringify({ structure, verdict: targetLog?.verdict ?? null, reasons: targetLog?.reasons ?? null }),
    );
  }
}

/**
 * 自由轮廓验收证据断言（方案 2026-11-08 §5.1/§8.3）。
 *
 * 要求：候选轮的 `agent.threeSources.freeform` 事件必须带**实际**验收证据
 * （pointCount / pointGate / visual），不得出现"已执行但 checks 为空"；
 * 失败时必须能读出原因（语义不像 / 点数不合格 / 截断 / 拓扑非法）。
 *
 * @param {object} ctx 用例上下文
 * @param {Array<object>} logs 本轮日志（最终轮）
 * @param {Array<object>} candidateLogs 候选轮日志
 * @param {object} expect 用例期望
 */
function checkFreeformEvidence(ctx, logs, candidateLogs, expect) {
  if (!expect.expectFreeformChecks && !expect.expectFreeformReason) {
    return;
  }
  const event =
    findLog(logs, 'agent.threeSources.freeform') ??
    findLog(candidateLogs, 'agent.threeSources.freeform');
  if (!event) {
    // 本轮没有自由轮廓这一路（走的是参考素材/内置图形通道）→ 验收证据改看
    // 目标验收事件：它的 constraintResults 同样是逐条可读的结论。
    const targetLog =
      findLog(logs, 'target.accepted') ??
      findLog(logs, 'target.rejected') ??
      findLog(candidateLogs, 'target.accepted') ??
      findLog(candidateLogs, 'target.rejected');
    if (!targetLog) {
      // 本轮根本没走到目标验收阶段（生成阶段就诚实失败了，如点列两轮不合法）：
      // 没有"已执行但证据为空"的问题，诚实失败断言负责这一轮。
      return;
    }
    if (expect.expectFreeformChecks) {
      const results = Array.isArray(targetLog?.constraintResults) ? targetLog.constraintResults : [];
      ctx.check(
        '目标验收留痕含逐条约束结论（constraintResults 非空）',
        results.length > 0,
        JSON.stringify({ verdict: targetLog?.verdict ?? null, results }),
      );
    }
    return;
  }
  const checks = event.checks ?? {};
  if (expect.expectFreeformChecks) {
    ctx.check(
      '自由轮廓验收留痕含实际点数（checks.pointCount）',
      Number.isFinite(checks.pointCount) && checks.pointCount > 0,
      JSON.stringify({ checks }),
    );
    ctx.check(
      '自由轮廓验收留痕含点数门档位（checks.pointGate）',
      typeof checks.pointGate === 'string' && checks.pointGate.length > 0,
      JSON.stringify({ pointGate: checks.pointGate }),
    );
    ctx.check(
      '自由轮廓验收留痕含视觉结论（checks.visual 非空）',
      checks.visual !== undefined && checks.visual !== null,
      JSON.stringify({ visual: checks.visual }),
    );
  }
  if (expect.expectFreeformReason) {
    const hasReason = Array.isArray(event.reasons) && event.reasons.length > 0;
    const terminated = Boolean(event.terminatedWith || event.failureKind);
    ctx.check(
      '自由轮廓未通过时给出可读原因（reasons / 终止原因）',
      event.qualified === true || hasReason || terminated,
      JSON.stringify({ reasons: event.reasons, terminatedWith: event.terminatedWith, failureKind: event.failureKind }),
    );
  }
}

/**
 * 通用单轮用例执行器：发一句话 →（可选）处理候选卡/引导 → 断言交付、目标、意图、诚实性。
 *
 * @param {object} ctx 用例上下文
 * @param {object} spec 用例定义（见两个用例文件）
 */
async function runSpec(ctx, spec) {
  const started = Date.now();
  const gate = contractGate();
  const first = await sendAndWait(ctx, spec.input);
  let snap = first.snap;
  const candidateTraceId = first.traceId;
  let intent = first.intent;
  let finalTraceId = candidateTraceId;

  // 候选卡：点第一张（参考图多候选 / 自由轮廓已质检都会走这里）
  const selected = await selectFirstCardIfAny(ctx, snap);
  snap = selected.snap;
  finalTraceId = selected.finalTraceId;
  const cards = selected.cards;

  // 缺地点引导：按用例要求点选一个地点，再等第二轮
  const guideLabels = snap?.dom?.guideLabels ?? [];
  let guidePicked = null;
  if (guideLabels.length > 0 && spec.guidePick) {
    ctx.check('缺地点时给出可点选项（且只有一处可点行）', guideLabels.length >= 1, JSON.stringify(guideLabels));
    const picked = await ctx.clickGuide(spec.guidePick.index ?? 0, spec.guidePick.label);
    ctx.check('点选引导选项', picked?.ok === true, JSON.stringify(picked));
    guidePicked = picked?.picked ?? null;
    const finished = await ctx.waitTurn();
    ctx.check('补地点后轮次在超时前完成', finished, '补地点轮等待超时');
    snap = await ctx.snapshot();
    ctx.capture('guide-selected', snap);
    finalTraceId = latestTraceId(snap);
    // 补地点后 LLM 会二次解析并合并意图，以新一轮的意图为准
    intent = findLog(await ctx.logs(finalTraceId), 'agent.intent') ?? intent;
  }

  const reply = checkBasicReply(ctx, snap, '', gate);
  const finalLogs = await ctx.logs(finalTraceId);
  const candidateLogs = candidateTraceId && candidateTraceId !== finalTraceId
    ? await ctx.logs(candidateTraceId)
    : finalLogs;
  const { delivery, mode } = await inspectDelivery(ctx, snap, reply, gate);

  // 引导态断言：如果产品仍在追问且用例没有要求补地点，则不应有图形
  const stillGuide = (snap?.dom?.guideLabels ?? []).length > 0;
  if (stillGuide) {
    ctx.check('引导追问轮不规划、不绘制', !delivery.delivered, JSON.stringify(delivery.shapes));
    ctx.check('引导追问轮回复明确询问地点', /哪里|地点|点选|输入/.test(reply), reply.slice(0, 300));
  }

  // 推荐链断言语义
  if (spec.expect.requireRecommend) {
    const recommendLog = findLog(finalLogs, 'recommend.result') ?? findLog(finalLogs, 'recommend.failed');
    ctx.check('推荐链产生 recommend.result / recommend.failed 事件', Boolean(recommendLog), JSON.stringify(finalLogs));
    ctx.check('推荐回复说明「推荐/画不出」', /推荐|画不出|没有/.test(reply), reply.slice(0, 300));
  }

  // 意图断言：点选卡时意图在候选轮，其余在本轮
  const intentLogs = cards.length > 0 ? candidateLogs : finalLogs;
  checkIntent(ctx, intent, spec.expect, intentLogs, reply);
  checkTarget(ctx, snap, reply, spec.expect, delivery);
  // 最终产物断言（方案 2026-11-08 §6.1）：尺寸/朝向/对象一律看实际交付的图形快照
  checkDeliveredArtifact(ctx, snap, spec.expect, delivery);
  // 自由轮廓验收证据（方案 2026-11-08 §5.1）：checks 不得为空、失败原因可读
  checkFreeformEvidence(ctx, finalLogs, candidateLogs, spec.expect);
  // 用户显式约束核验（方案 §4.1）：绿线交付时不得有未核验/未满足的约束
  checkVerifiedConstraints(ctx, finalLogs, candidateLogs, spec.expect, delivery, mode);

  /** 本轮收尾：记录实际结果并截图 */
  const finalize = async () => {
    const durationMs = Date.now() - started;
    if (spec.expect.maxDurationMs) {
      ctx.check(
        `本轮耗时不超过 ${Math.round(spec.expect.maxDurationMs / 1000)}s`,
        durationMs <= spec.expect.maxDurationMs,
        `${Math.round(durationMs / 1000)}s`,
      );
    }
    const shape = lastShape(snap);
    const outline = lastOutline(snap);
    // 分维度评定（方案 2026-11-05 §5.1）：落点/路线成本从真实链路日志取值，
    // 来源阶段用 candidates.chosen（粗搜级别 + 是否精修），不再拿 plan.selected.stage 反推。
    const selectedLog = findLog(finalLogs, 'plan.selected') ?? findLog(candidateLogs, 'plan.selected');
    const chosenLog = findLog(finalLogs, 'candidates.chosen') ?? findLog(candidateLogs, 'candidates.chosen');
    const metrics = selectedLog?.metrics ?? null;
    const targetCheck = evaluateTargetDimension({
      logs: finalLogs,
      candidateLogs,
      intent,
      snap,
      expect: spec.expect,
      delivery: { ...delivery, mode },
    });
    const scopeWidened = spec.expect.allowScopeWidening === true || detectScopeWidening(spec.input);
    // 验收证据（方案 2026-11-08 §8.5：每例至少保存真实 LLM 响应的 finishReason、
    // 目标验收 checks、实际交付对象、最终尺寸/朝向、路线质量、结果类别和耗时）
    const freeformEvent =
      findLog(finalLogs, 'agent.threeSources.freeform') ??
      findLog(candidateLogs, 'agent.threeSources.freeform');
    const targetEvent =
      findLog(finalLogs, 'target.accepted') ??
      findLog(finalLogs, 'target.rejected') ??
      findLog(candidateLogs, 'target.accepted') ??
      findLog(candidateLogs, 'target.rejected');
    const acceptanceEvidence = {
      targetVerdict: targetEvent?.verdict ?? null,
      targetReasons: targetEvent?.reasons ?? null,
      targetChecks: targetEvent?.checks ?? freeformEvent?.checks ?? null,
      constraintResults:
        targetEvent?.constraintResults ?? freeformEvent?.constraintResults ?? null,
      freeformChecks: freeformEvent?.checks ?? null,
      freeformTerminatedWith: freeformEvent?.terminatedWith ?? null,
      freeformFailureKind: freeformEvent?.failureKind ?? null,
      llmResponses: (freeformEvent?.llmResponses ?? []).map((item) => ({
        phase: item.phase,
        finishReason: item.finishReason,
        contentLength: item.contentLength,
        reasoningTokens: item.reasoningTokens,
        completionTokens: item.completionTokens,
      })),
    };
    // 显式约束是否全部满足（方案 2026-11-08 §3.3）：读取交付事件里的约束核验结论
    const deliveredLog = findLog(finalLogs, 'plan.delivered') ?? findLog(candidateLogs, 'plan.delivered');
    const constraintViolation = findLog(finalLogs, 'deliver.constraintViolation');
    const constraintCompliant = !constraintViolation;
    const deliveryReport = evaluateDeliveryReport({
      contractPass: gate.pass(),
      contractDetails: { facts: gate.facts },
      targetPass: targetCheck.pass,
      targetDetails: targetCheck.details,
      offsetMeters: selectedLog?.offset?.meters ?? null,
      sizeMeters: shape?.sizeMeters ?? selectedLog?.sizeMeters ?? null,
      routeMeters: metrics?.routeMeters ?? null,
      walkMinutes: metrics?.walkMinutes ?? null,
      scopeWidened,
      delivered: delivery.delivered,
      reference: mode === 'orange',
      constraintCompliant,
      covered: !stillGuide,
    });
    // 交付结果类别（方案 2026-11-08 §6.3）：六类之一，独立于 overallPass
    const deliveryOutcome = deliveryReport.deliveryOutcome;
    if (spec.expect.expectDeliveryOutcome) {
      ctx.check(
        `交付结果类别 = ${spec.expect.expectDeliveryOutcome}`,
        deliveryOutcome === spec.expect.expectDeliveryOutcome,
        JSON.stringify({ deliveryOutcome, reasons: deliveryReport.deliveryOutcomeReasons }),
      );
    }
    if (spec.expect.expectDeliveryOutcomeIn?.length) {
      ctx.check(
        `交付结果类别 ∈ {${spec.expect.expectDeliveryOutcomeIn.join('|')}}`,
        spec.expect.expectDeliveryOutcomeIn.includes(deliveryOutcome),
        JSON.stringify({ deliveryOutcome, reasons: deliveryReport.deliveryOutcomeReasons }),
      );
    }
    // 条件断言：本轮确实产生了"当前不支持的拓扑"（嵌套孔洞）时，不得绿线交付
    // （方案 2026-11-08 §8.3 A9；没产生嵌套时该断言不适用）
    if (spec.expect.expectNoQualifiedWhenUnsupported) {
      const nested = [...finalLogs, ...candidateLogs].find(
        (item) =>
          item?.event === 'shape.recovery.start' &&
          typeof item?.data?.reason === 'string' &&
          item.data.reason.includes('嵌套'),
      );
      if (nested) {
        ctx.check(
          '本轮产生了不支持的拓扑（嵌套孔洞）→ 不得绿线交付',
          deliveryOutcome !== 'qualified-delivery',
          JSON.stringify({ deliveryOutcome, reason: nested.data.reason }),
        );
      }
    }
    ctx.setActual({
      traceId: finalTraceId,
      candidateTraceId,
      action: intent?.action ?? null,
      intentShape: intent?.customShape?.name ?? intent?.shapeSpec?.summary ?? null,
      intentPoints: intent?.customShape?.outlinePoints ?? null,
      intentSizeMeters: intent?.sizeMeters ?? null,
      intentRotationDeg: intent?.rotationDeg ?? null,
      intentPlace: intent?.place ?? null,
      intentRequestObjects: intent?.requestObjects ?? null,
      userConstraints: intent?.userConstraints ?? null,
      cards: cards.length,
      clickedCard: selected.clicked,
      guideLabels: guideLabels.length ? guideLabels : null,
      guidePicked,
      mode,
      delivered: delivery.delivered,
      outline,
      // 来源阶段口径（方案 2026-11-05 §5.2）：粗搜级别、是否精修、尺寸分开记录
      sourceStage: chosenLog?.stage ?? selectedLog?.sourceStage ?? null,
      sourceStageLabel: chosenLog?.stageLabel ?? selectedLog?.sourceStageLabel ?? null,
      refined: chosenLog?.refined ?? selectedLog?.refined ?? false,
      sourceSizeMeters: chosenLog?.sourceSizeMeters ?? selectedLog?.sourceSizeMeters ?? null,
      finalSizeMeters: chosenLog?.sizeMeters ?? shape?.sizeMeters ?? null,
      offsetMeters: selectedLog?.offset?.meters ?? null,
      routeMeters: metrics?.routeMeters ?? null,
      walkMinutes: metrics?.walkMinutes ?? null,
      deliveryReport,
      // 交付结果类别（方案 2026-11-08 §6.3）：与 overallPass 并存的独立字段
      deliveryOutcome,
      deliveryOutcomeReasons: deliveryReport.deliveryOutcomeReasons ?? [],
      deliveredObjects: shape?.deliveredObjects ?? null,
      requestedObjects: (intent?.requestObjects ?? []).map((item) => item?.name ?? null),
      missingObjects: targetCheck.details?.missingObjects ?? null,
      constraintCompliant,
      // 验收证据（方案 §8.5：随结果 JSON 一起落盘，证据不再只存在页面日志里）
      acceptanceEvidence,
      shape: shape
        ? {
            shapeName: shape.shapeName,
            sizeMeters: shape.sizeMeters,
            score: shape.score,
            rotationDeg: shape.rotationDeg,
            reference: shape.reference,
            label: shape.label,
            // 结构化交付身份（方案 2026-11-08 §4.2）
            deliveredObjects: shape.deliveredObjects ?? [],
            // 路线拓扑诊断随交付结果 JSON 留痕（缺陷清单 Bug 4.4：先统计不设门）
            uniqueCrossingCount: shape.uniqueCrossingCount ?? null,
            reusedEdgeRatio: shape.reusedEdgeRatio ?? null,
          }
        : null,
      durationMs,
      reply: reply.slice(0, 600),
    });
    if (spec.shot) {
      await ctx.shot(spec.shot);
    }
  };

  // chat（拒绝/闲聊）分支：产品明确不画时必须说明原因并给替代（合法分支，不按失败处理）
  if (intent?.action === 'chat' && spec.expect.allowChat) {
    ctx.check('chat/拒绝分支说明原因并给替代', includesAny(reply, CHAT_REASON_MARKERS), reply.slice(0, 400));
    ctx.check('chat/拒绝分支不规划、不绘制', !delivery.delivered, JSON.stringify(delivery.shapes));
    await finalize();
    return;
  }

  // 用例要求必须出图（参考图命中/规则图形这类确定性通道），未交付即失败
  if (spec.expect.requireDelivery) {
    ctx.check('该通道应交付图形（要求必须出图）', delivery.delivered, JSON.stringify({ mode, cards: cards.length, reply: reply.slice(0, 300) }));
  }
  // 用例要求不得出图（例如"部分命中必须追问、不得单候选自动规划"）
  if (spec.expect.noDelivery) {
    ctx.check(
      '本例按设计不得交付图形（应走追问/诚实失败分支）',
      !delivery.delivered,
      JSON.stringify({ mode, reply: reply.slice(0, 300) }),
    );
  }
  // 未交付时必须诚实说明（引导态另有断言）
  if (!delivery.delivered && !stillGuide) {
    checkHonestFailure(ctx, reply, '', gate);
  }

  await finalize();
}

/**
 * 目标维度评定（方案 2026-11-05 §5.1）：请求对象与目标语义是否完整。
 *
 * 三条证据：
 * 1. 产品自己报告的对象不一致（多对象部分命中 / 交付缺对象）→ 不通过；
 * 2. 用例声明的多对象关键词必须全部出现在交付名里；
 * 3. 意图里的 requestObjects 与实际交付对象逐项比对（请求对象 = 实际交付对象）。
 *
 * @param {object} input
 * @param {Array<object>} input.logs 本轮真实链路日志
 * @param {Array<object>} input.candidateLogs 候选轮日志
 * @param {object|null} input.intent 本轮意图
 * @param {object} input.snap 终态快照
 * @param {object} input.expect 用例期望
 * @param {object} input.delivery 交付状态
 * @returns {{pass: boolean, details: object}}
 */
function evaluateTargetDimension({ logs, candidateLogs, intent, snap, expect, delivery }) {
  const allLogs = [...(logs || []), ...(candidateLogs || [])];
  const hasEvent = (event) => allLogs.some((item) => item?.event === event);
  const details = {
    objectMismatchReported: hasEvent('deliver.objectMismatch'),
    multiPartialReported: hasEvent('agent.reference.multi.partial'),
    multiUsed: hasEvent('agent.reference.multi.used'),
    requestedObjects: intent?.requestObjects ?? null,
    missingObjects: null,
    keywordMissing: null,
    deliveredObjects: null,
    unverifiedCount: 0,
  };
  if (details.objectMismatchReported || details.multiPartialReported) {
    return { pass: false, details };
  }
  // 用例声明的多对象关键词
  if (expect?.multiObjectKeywords?.length && delivery?.delivered) {
    const name = String(lastShape(snap)?.shapeName ?? lastOutline(snap)?.name ?? '');
    const missing = expect.multiObjectKeywords.filter((keyword) => !name.includes(keyword));
    details.keywordMissing = missing;
    if (missing.length > 0) {
      return { pass: false, details };
    }
  }
  // 意图的请求对象 vs 实际交付对象
  const requested = Array.isArray(intent?.requestObjects) ? intent.requestObjects : [];
  if (requested.length > 0 && delivery?.delivered) {
    // 2026-11-08 §4.2：实际交付必须携带**结构化**的部分身份（deliveredObjects），
    // 只靠拼接显示名（"猫+狗+兔子"）无法区分"猫+狗+狗"这种重复交付。
    const shape = lastShape(snap);
    const deliveredObjects = Array.isArray(shape?.deliveredObjects) ? shape.deliveredObjects : [];
    const consistency = checkDeliveryObjectConsistency({
      requested,
      customShape: {
        name: shape?.shapeName ?? lastOutline(snap)?.name ?? null,
        parts: deliveredObjects.map((item) => ({ name: item?.name })),
      },
      deliveredObjects: deliveredObjects.length > 0 ? deliveredObjects : null,
    });
    details.missingObjects = consistency.missing.map((item) => item.name);
    details.deliveredObjects = consistency.deliveredObjects ?? null;
    details.unverifiedCount = consistency.unverifiedCount ?? 0;
    // 橙色诊断参考版**本来就是**"目标没通过"的诚实降级（产品已明说非合格）：
    // 身份对不上正是它被降级的原因，不按"错误交付"计。
    const isDiagnosticReference = delivery.mode === 'orange';
    if (!consistency.ok && !isDiagnosticReference) {
      return { pass: false, details };
    }
  }
  return { pass: true, details };
}

/**
 * 把用例定义（纯数据）包装成驱动可执行的 CASES 条目。
 *
 * @param {object} spec 用例定义
 * @returns {object} 驱动用例对象
 */
export function makeCase(spec) {
  return {
    id: spec.id,
    category: spec.category,
    title: spec.title,
    input: spec.input,
    expected: spec.expected,
    async run(ctx) {
      await runSpec(ctx, spec);
    },
  };
}
