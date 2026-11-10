/**
 * 缺陷修复真实 LLM E2E 用例（2026-11-06 缺陷清单全量回归）。
 *
 * 浏览器 + 真实 LLM + 真实广州路网 + 真实 PhyloPic 在线检索，无 mock。
 * 驱动：node tools/e2e-real-llm-30.mjs --cases-file test/legacy/e2e-bugfix-cases.mjs
 *
 * 用例与缺陷对应：
 * - B1 在线补漏通道（Bug 1，P0）：本地无素材对象（海马）→ 在线路必须产出候选
 *   （poolSize>0），且失败可见化字段随日志透传；点选在线候选卡可进入规划；
 * - B2 引导回答 ≠ 质检原文（Bug 2）：缺地点 → 追问 → 回答"当前视野中心"后，
 *   视觉质检 llm.request 的「用户想画」必须是原始请求；
 * - B3 分数分档选优（Bug 3）：candidates.chosen 必须携带 poolTopScore/selectedScore，
 *   且池最高分与交付分差 ≤ 3（准确性优先口径）；
 * - B4 约束漏解析不 fail-open（Bug 4.1）：H06 原文（要奔跑的样子）→ 不允许
 *   "绿线交付 且 userConstraints 为空"；
 * - B5 自由轮廓分级放行（Bug 4.2）：复杂剪影 60~79 点不再被"不在 80"硬拒；
 * - B6 多对象逐对象匹配（Bug 4.3）：画猫和兔子 → 复合交付包含两个对象；
 * - B7 拓扑指标随交付留痕（Bug 4.4）：交付快照与 plan.selected 携带
 *   uniqueCrossingCount/reusedEdgeRatio；
 * - B8 备选可切换（Bug 5）：回复承诺"要大/小一点的那版"后，照做必须直接切换
 *   交付（无 LLM 重解析、无重新规划）。
 */

import { makeCase, checkBasicReply, checkHonestFailure, logOf } from './e2e-case-lib.mjs';
import { __testHelpers } from './e2e-real-llm-30-cases.mjs';

const { lastOutline, lastReply, latestTraceId, findLog } = __testHelpers;

/** 等待首轮结束并返回快照/traceId/回复 */
async function sendAndWait(ctx, text) {
  await ctx.send(text);
  ctx.check('轮次在超时前完成', await ctx.waitTurn());
  const snap = await ctx.snapshot();
  ctx.capture('turn1', snap);
  return { snap, traceId: latestTraceId(snap), reply: lastReply(snap) ?? '' };
}

/** 若出现候选卡则点第一张并等规划轮结束 */
async function selectFirstCardIfAny(ctx, snap) {
  const cards = snap?.dom?.refCards ?? [];
  if (cards.length === 0) {
    return { snap, clicked: false, traceId: latestTraceId(snap) };
  }
  ctx.check('候选卡带实际 T 小图与点数', cards.every((card) => card.hasImage && card.pointCount > 0), JSON.stringify(cards));
  const clicked = await ctx.clickRefCard(0);
  ctx.check('点击候选卡进入规划轮', clicked?.ok === true, JSON.stringify(clicked));
  ctx.check('选择轮在超时前完成', await ctx.waitTurn());
  const next = await ctx.snapshot();
  ctx.capture('selected', next);
  return { snap: next, clicked: true, traceId: latestTraceId(next) };
}

/** 收集 logs 里某事件的全部 data */
function allLogData(logs, event) {
  if (!Array.isArray(logs)) {
    return [];
  }
  return logs.filter((item) => item.event === event).map((item) => item.data ?? {});
}

/** 交付结果摘要（形状快照 + 颜色一致性） */
async function deliveryOf(ctx, snap) {
  const delivery = await ctx.delivery(snap);
  ctx.check(
    '地图颜色与图形快照一致（绿=合格 / 橙=参考版 / 失败无线）',
    delivery.consistent,
    JSON.stringify({ delivered: delivery.delivered, green: delivery.green, orange: delivery.orange }),
  );
  return delivery;
}

export const CASES = [
  // ================= B1 Bug 1：在线补漏通道 =================
  {
    id: 'B1',
    category: '缺陷回归 Bug1 在线补漏',
    title: '本地无素材对象（海马）→ 在线路产出候选（poolSize>0）',
    input: '在花城广场画一只海马',
    expected:
      '三路在线路 status=ok 且 poolSize>0（修复前 168 次 miss/0 ok）；失败可见化字段随日志透传；在线候选卡可点选进入规划，交付或诚实失败',
    async run(ctx) {
      const first = await sendAndWait(ctx, this.input);
      const turn1Logs = await ctx.logs(first.traceId);
      const pathEvents = allLogData(turn1Logs, 'agent.threeSources.path');
      const onlinePath = pathEvents.find((item) => item.path === 'online');
      ctx.check('三路在线路有 agent.threeSources.path 事件', Boolean(onlinePath), JSON.stringify(pathEvents));
      ctx.check(
        '在线路 status=ok 且 poolSize>0（缺陷 Bug 1 主断言：修复前恒 miss/0）',
        onlinePath?.status === 'ok' && Number(onlinePath?.poolSize) > 0,
        JSON.stringify(onlinePath),
      );
      ctx.check(
        '在线路 attempts 已透传（可观测）',
        onlinePath?.attempts === null || Number.isInteger(onlinePath?.attempts),
        JSON.stringify(onlinePath),
      );

      const selected = await selectFirstCardIfAny(ctx, first.snap);
      const finalLogs = await ctx.logs(selected.traceId);
      const reply = lastReply(selected.snap) ?? '';
      const delivery = await deliveryOf(ctx, selected.snap);
      checkBasicReply(ctx, selected.snap, '', null);
      if (!delivery.delivered) {
        checkHonestFailure(ctx, reply, '', null);
      }
      // 点选了在线候选时：规划轮必须真实发生（reference 确认链路），不允许静默无响应
      if (selected.clicked) {
        const hasPlanEvidence =
          allLogData(finalLogs, 'plan.selected').length > 0
          || allLogData(finalLogs, 'deliver.reference').length > 0
          || allLogData(finalLogs, 'deliver.diagnosticReference').length > 0
          || allLogData(finalLogs, 'deliver.failed').length > 0
          || allLogData(finalLogs, 'deliver.targetFailed').length > 0;
        ctx.check('点选后进入真实规划链路（有引擎/交付事件）', hasPlanEvidence, JSON.stringify(finalLogs.map((item) => item.event)));
      }
      ctx.setActual({
        onlinePath,
        clicked: selected.clicked,
        delivered: delivery.delivered,
        mode: delivery.green ? 'green' : delivery.orange ? 'orange' : 'none',
        reply: reply.slice(0, 400),
      });
      await ctx.shot('online-path');
    },
  },

  // ================= B2 Bug 2：引导回答 ≠ 质检原文 =================
  {
    id: 'B2',
    category: '缺陷回归 Bug2 引导质检原文',
    title: '缺地点 → 追问 → 回答视野中心 → 质检 userText = 原始请求',
    input: '生成一个小猪佩奇',
    expected:
      '缺地点触发引导；回答"当前视野中心"后自由轮廓质检的「用户想画」必须是「生成一个小猪佩奇」，不得是引导回答（修复前 2/2 trace 全部错置）',
    async run(ctx) {
      const first = await sendAndWait(ctx, this.input);
      ctx.check('缺地点给出引导选项', (first.snap?.dom?.guideLabels ?? []).length > 0, JSON.stringify(first.snap?.dom?.guideLabels ?? null));

      // 回答"当前视野中心"（选项最后一项；也可以直接发文本，走 fillFromOption）
      const labels = first.snap?.dom?.guideLabels ?? [];
      const centerIndex = labels.findIndex((label) => String(label).includes('当前视野中心'));
      ctx.check('引导选项包含"当前视野中心"', centerIndex >= 0, JSON.stringify(labels));
      const picked = await ctx.clickGuide(centerIndex, labels[centerIndex]);
      ctx.check('点选视野中心选项', picked?.ok === true, JSON.stringify(picked));
      ctx.check('引导后轮次完成', await ctx.waitTurn());
      const snap = await ctx.snapshot();
      ctx.capture('guide-selected', snap);
      const traceId = latestTraceId(snap);
      const logs = await ctx.logs(traceId);

      // 质检请求（llm.request 完整落日志）：messages[0].content 含"质检员"
      const qcRequests = allLogData(logs, 'llm.request').filter((item) =>
        JSON.stringify(item.messages?.[0]?.content ?? '').includes('质检员'),
      );
      ctx.check('本轮发生了目标轮廓视觉质检请求', qcRequests.length > 0, JSON.stringify(allLogData(logs, 'llm.request').map((item) => item.messageCount)));
      if (qcRequests.length > 0) {
        const userTexts = qcRequests.map((item) => {
          const userMessage = (item.messages ?? []).find((message) => message.role === 'user');
          const content = userMessage?.content;
          return Array.isArray(content)
            ? content.filter((part) => part?.type === 'text').map((part) => part.text).join('\n')
            : String(content ?? '');
        });
        ctx.check(
          '质检「用户想画」= 原始请求（不是引导回答）',
          userTexts.every((text) => text.includes('生成一个小猪佩奇')) && userTexts.some((text) => !text.includes('用户想画：就在当前视野中心画')),
          JSON.stringify(userTexts),
        );
        ctx.check(
          '用户选择视野中心时有补充说明（不误判用户否定地点）',
          userTexts.some((text) => text.includes('当前视野中心')),
          JSON.stringify(userTexts.map((text) => text.slice(0, 120))),
        );
      }
      const delivery = await deliveryOf(ctx, snap);
      ctx.setActual({
        delivered: delivery.delivered,
        mode: delivery.green ? 'green' : delivery.orange ? 'orange' : 'none',
        qcRequests: qcRequests.length,
        reply: (lastReply(snap) ?? '').slice(0, 400),
      });
      await ctx.shot('guide-qc-text');
    },
  },

  // ================= B3 Bug 3：分数分档选优 =================
  {
    id: 'B3',
    category: '缺陷回归 Bug3 分数分档选优',
    title: 'candidates.chosen 携带池分与交付分，分差 ≤ 3',
    input: '在广州塔附近画个五角星',
    expected:
      '绿线交付；candidates.chosen 携带 poolTopScore/selectedScore/passingCount；selectedScore ≥ poolTopScore − 3（准确性优先：同池高分候选不得被跳过）',
    async run(ctx) {
      const first = await sendAndWait(ctx, this.input);
      const logs = await ctx.logs(first.traceId);
      const chosen = findLog(logs, 'candidates.chosen');
      ctx.check('产生 candidates.chosen 事件（存在达标候选池）', Boolean(chosen), JSON.stringify(logs.map((item) => item.event)));
      if (chosen) {
        ctx.check('chosen 携带 poolTopScore（Bug 3.5 结果可验证性）', Number.isFinite(chosen.poolTopScore), JSON.stringify(chosen));
        ctx.check('chosen 携带 chosenScore（粗搜池选中者，断言口径）', Number.isFinite(chosen.chosenScore), JSON.stringify(chosen));
        ctx.check('chosen 携带 poolSample（池摘要，A/B 可复核）', Array.isArray(chosen.poolSample) && chosen.poolSample.length > 0, JSON.stringify(chosen.poolSample));
        ctx.check(
          '粗搜池选中分 ≥ 池最高分 − 3（准确性优先；口径=chosenScore 而非精修后的 selectedScore——2026-11-07 复核修正，此前口径天然通过等于没验）',
          Number(chosen.poolTopScore) - Number(chosen.chosenScore) <= 3,
          JSON.stringify({ poolTopScore: chosen.poolTopScore, chosenScore: chosen.chosenScore, selectedScore: chosen.selectedScore }),
        );
        ctx.check(
          '池摘要里确实存在与池顶同档的候选（建池扩容生效，高分候选不再被 RMS top3 截断丢池）',
          chosen.poolSample.some((item) => Number(chosen.poolTopScore) - Number(item.score) <= 3),
          JSON.stringify({ poolTopScore: chosen.poolTopScore, sample: chosen.poolSample }),
        );
      }
      const delivery = await deliveryOf(ctx, first.snap);
      ctx.check('内置五角星应交付（绿线或橙色参考）', delivery.delivered, JSON.stringify({ mode: delivery.green ? 'green' : delivery.orange ? 'orange' : 'none' }));
      ctx.setActual({ chosen, delivered: delivery.delivered, mode: delivery.green ? 'green' : delivery.orange ? 'orange' : 'none' });
      await ctx.shot('selection-tier');
    },
  },

  // ================= B4 Bug 4.1：约束漏解析不 fail-open =================
  {
    id: 'B4',
    category: '缺陷回归 Bug4.1 约束闸门',
    title: 'H06 原文：不允许"绿线交付且 userConstraints 为空"',
    input: '在花城广场画一匹马，要奔跑的样子',
    expected:
      '要么意图记录 userConstraints（含奔跑），要么验收降级（橙色诊断/诚实失败并说明要求未核对）——绝不"无核对绿线交付"（H06 缺陷回归）',
    async run(ctx) {
      const first = await sendAndWait(ctx, this.input);
      const selected = await selectFirstCardIfAny(ctx, first.snap);
      const logs = await ctx.logs(selected.traceId);
      const logs1 = await ctx.logs(first.traceId);
      const intent = findLog(logs, 'agent.intent') ?? findLog(logs1, 'agent.intent');
      const constraints = Array.isArray(intent?.userConstraints) ? intent.userConstraints : [];
      const reply = lastReply(selected.snap) ?? '';
      const delivery = await deliveryOf(ctx, selected.snap);
      const rejected = findLog(logs, 'target.rejected') ?? findLog(logs1, 'target.rejected');
      const diagnostic = allLogData(logs, 'deliver.diagnosticReference').length > 0
        || allLogData(logs1, 'deliver.diagnosticReference').length > 0;

      ctx.check('意图解析 action=plan', intent?.action === 'plan', JSON.stringify(intent));
      if (delivery.green) {
        ctx.check(
          '绿线交付时意图必须记录用户显式约束（不 fail-open）',
          constraints.length > 0,
          JSON.stringify({ userConstraints: constraints }),
        );
      } else {
        // 未绿线：必须有降级证据——target.rejected（含疑似约束/验收原因）或橙色诊断参考
        const downgraded = Boolean(rejected) || diagnostic || delivery.orange;
        ctx.check('未绿线时有明确降级证据（target.rejected / 诊断参考 / 橙色）', downgraded, JSON.stringify({ rejected, diagnostic, orange: delivery.orange }));
        if (delivery.orange) {
          ctx.check('橙色参考版明确标注非合格', /参考|未通过|不合格/.test(reply), reply.slice(0, 300));
        } else if (!diagnostic) {
          checkHonestFailure(ctx, reply, '', null);
        }
      }
      ctx.setActual({
        userConstraints: constraints,
        delivered: delivery.delivered,
        mode: delivery.green ? 'green' : delivery.orange ? 'orange' : 'none',
        targetRejected: rejected,
        reply: reply.slice(0, 400),
      });
      await ctx.shot('constraint-gate');
    },
  },

  // ================= B5 Bug 4.2：自由轮廓分级放行 =================
  {
    id: 'B5',
    category: '缺陷回归 Bug4.2 点数分级放行',
    title: '本地+在线都无素材（独角兽）→ 自由轮廓点数门真实执行且 60~79 点不硬拒',
    input: '在花城广场画一只独角兽',
    expected:
      '自由轮廓质检真实执行（2026-11-07 复核修正：树懒被在线通道命中、点数门从未执行，断言假通过）；点数检查 checks 必须出现；不存在"点数 N（60≤N<80）不在 80~120"类拒绝；交付/诚实失败行为一致',
    async run(ctx) {
      const first = await sendAndWait(ctx, this.input);
      const selected = await selectFirstCardIfAny(ctx, first.snap);
      const logs = [...(await ctx.logs(selected.traceId)), ...(await ctx.logs(first.traceId))];
      const accepted = allLogData(logs, 'target.accepted');
      const rejected = allLogData(logs, 'target.rejected');
      const allChecks = [...accepted, ...rejected].map((item) => item.checks ?? {});
      const pointGateChecks = allChecks.filter(
        (item) => (item.pointGate === 'complex' || item.pointGate === 'tiered') && Number.isFinite(item.pointCount),
      );
      // 硬证据分支（2026-11-07 复核修正：树懒例走 reference 路径假通过；独角兽首轮
      // 生成两轮拓扑不合法 → planBlocked，点数门未到达——LLM 输出质量无确定性）：
      // A) 走到了验收 → 点数门必须真实执行（pointGate 档位 + 点数）；
      // B) 生成两轮失败 → 回复必须是 planBlocked 诚实失败（与点数门无关），在
      //    actual 里明示"本轮未过点数门"，不假造强断言
      const planBlocked = (lastReply(selected.snap) ?? '').includes('没能生成出来');
      if (planBlocked && pointGateChecks.length === 0) {
        ctx.check(
          '分支 B：自由轮廓两轮生成失败 → 诚实失败（planBlocked，未过点数门，明示留痕）',
          !delivery.delivered && /没能生成|重新生成/.test(reply),
          reply.slice(0, 200),
        );
        ctx.setActual({ pointGateExecuted: false, branch: 'planBlocked' });
      } else {
        ctx.check(
          '分支 A：自由轮廓点数门真实执行（checks 含 pointGate 档位与点数）',
          pointGateChecks.length > 0,
          JSON.stringify(allChecks.map((item) => ({ pointGate: item.pointGate, pointCount: item.pointCount, verdict: item.verdict ?? null }))),
        );
        ctx.setActual({ pointGateExecuted: true, branch: 'gate-executed' });
      }
      const oldStyleRejections = [...accepted, ...rejected]
        .flatMap((item) => item.reasons ?? [])
        .filter((reason) => /点数 \d+ 不在 80/.test(String(reason)));
      ctx.check(
        '不存在旧口径"点数 N 不在 80~120"拒绝（Bug 4.2 主断言）',
        oldStyleRejections.length === 0,
        JSON.stringify(oldStyleRejections),
      );
      // 60~79 点进入规划时必须走分级放行（pointGate=tiered），不允许静默放宽
      const tieredDelivered = allChecks.filter((item) => item.pointGate === 'tiered');
      for (const item of tieredDelivered) {
        ctx.check(
          `分级放行留痕：点数 ${item.pointCount} 标记 tiered${item.verdict === 'pass' ? '（含 pointGateRelaxed）' : ''}`,
          item.pointCount >= 60 && item.pointCount < 80,
          JSON.stringify(item),
        );
      }
      const reply = lastReply(selected.snap) ?? '';
      const delivery = await deliveryOf(ctx, selected.snap);
      if (!delivery.delivered) {
        checkHonestFailure(ctx, reply, '', null);
      }
      ctx.setActual({
        delivered: delivery.delivered,
        mode: delivery.green ? 'green' : delivery.orange ? 'orange' : 'none',
        pointGates: allChecks.map((item) => ({ pointGate: item.pointGate, pointCount: item.pointCount, verdict: item.verdict ?? null })),
        reply: reply.slice(0, 400),
      });
      await ctx.shot('freeform-points');
    },
  },

  // ================= B6 Bug 4.3：多对象逐对象匹配 =================
  makeCase({
    id: 'B6',
    category: '缺陷回归 Bug4.3 多对象',
    title: '画猫和兔子 → 两个对象都命中并复合交付',
    input: '在花城广场画猫和兔子',
    expected:
      '逐对象匹配（agent.reference.multi.perObject）→ 全部命中 → 复合交付包含猫与兔子（修复前"猫"被连词吞词、只剩部分命中追问）',
    expect: {
      actions: ['plan'],
      requireDelivery: true,
      multiObjectKeywords: ['猫', '兔子'],
    },
  }),

  // ================= B7 Bug 4.4：拓扑指标随交付留痕 =================
  {
    id: 'B7',
    category: '缺陷回归 Bug4.4 拓扑留痕',
    title: '绿线交付的快照与日志携带 uniqueCrossingCount/reusedEdgeRatio',
    input: '在广州塔画个五角星',
    expected:
      '交付结果（会话图形快照）与 plan.selected 均携带 uniqueCrossingCount 与 reusedEdgeRatio（先统计不设门，形成可回归指标）',
    async run(ctx) {
      const first = await sendAndWait(ctx, this.input);
      const logs = await ctx.logs(first.traceId);
      const selectedLog = findLog(logs, 'plan.selected');
      const delivery = await deliveryOf(ctx, first.snap);
      ctx.check('内置五角星应交付', delivery.delivered, JSON.stringify({ mode: delivery.green ? 'green' : delivery.orange ? 'orange' : 'none' }));
      ctx.check(
        'plan.selected 携带拓扑指标（metrics.uniqueCrossingCount/reusedEdgeRatio 字段存在）',
        Boolean(selectedLog?.metrics) && 'uniqueCrossingCount' in (selectedLog?.metrics ?? {}) && 'reusedEdgeRatio' in (selectedLog?.metrics ?? {}),
        JSON.stringify(selectedLog?.metrics ?? null),
      );
      const shape = (first.snap?.store?.session?.shapes ?? []).at(-1) ?? null;
      ctx.check(
        '交付图形快照携带拓扑指标字段（Bug 4.4 交付结果 JSON 断言）',
        Boolean(shape) && 'uniqueCrossingCount' in (shape ?? {}) && 'reusedEdgeRatio' in (shape ?? {}),
        JSON.stringify(shape ? { uniqueCrossingCount: shape.uniqueCrossingCount, reusedEdgeRatio: shape.reusedEdgeRatio, hasShape: true } : null),
      );
      ctx.setActual({
        delivered: delivery.delivered,
        topology: selectedLog?.metrics
          ? { uniqueCrossingCount: selectedLog.metrics.uniqueCrossingCount, reusedEdgeRatio: selectedLog.metrics.reusedEdgeRatio }
          : null,
      });
      await ctx.shot('topology-json');
    },
  },

  // ================= B8 Bug 5：备选可切换 =================
  {
    id: 'B8',
    category: '缺陷回归 Bug5 备选切换',
    title: '回复承诺备选 → 说"要大/小一点的那版"直接切换交付',
    input: '在珠江新城画个心形',
    expected:
      '绿线交付；若回复承诺"想换这一版直接说"，则照做后必须直接交付对应备选（无 LLM 重解析、无重新规划、尺寸变化、日志有 deliver.alternativeSwitched）；无备选时回复不得出现该承诺',
    async run(ctx) {
      const first = await sendAndWait(ctx, this.input);
      const delivery = await deliveryOf(ctx, first.snap);
      ctx.check('首轮绿线交付（备选只随绿线出现）', delivery.delivered, JSON.stringify({ mode: delivery.green ? 'green' : delivery.orange ? 'orange' : 'none' }));
      const reply = first.reply ?? '';
      const promisedBigger = reply.includes('要大一点的那版');
      const promisedSmaller = reply.includes('要小一点的那版');
      if (!promisedBigger && !promisedSmaller) {
        ctx.check('无备选时不出现切换承诺', !delivery.green || !reply.includes('想换这一版'), reply.slice(-200));
        ctx.setActual({ promised: false, delivered: delivery.delivered });
        await ctx.shot('alternative-none');
        return;
      }
      const direction = promisedBigger ? '要大一点的那版' : '要小一点的那版';
      const firstShape = (first.snap?.store?.session?.shapes ?? []).at(-1) ?? null;

      await ctx.send(direction);
      ctx.check('切换轮完成（不重新规划，应当很快）', await ctx.waitTurn());
      const snap = await ctx.snapshot();
      ctx.capture('switched', snap);
      const traceId = latestTraceId(snap);
      const logs = await ctx.logs(traceId);
      const switchedShape = (snap?.store?.session?.shapes ?? []).at(-1) ?? null;

      ctx.check('切换轮无 LLM 意图解析（不重走全新请求）', allLogData(logs, 'agent.intent').length === 0, JSON.stringify(allLogData(logs, 'agent.intent')));
      ctx.check('切换轮无引擎重新规划', allLogData(logs, 'plan.selected').length === 0 && allLogData(logs, 'candidates.chosen').length === 0, JSON.stringify(logs.map((item) => item.event)));
      const switched = allLogData(logs, 'deliver.alternativeSwitched');
      ctx.check('有 deliver.alternativeSwitched 事件', switched.length === 1, JSON.stringify(logs.map((item) => item.event)));
      ctx.check(
        '切换后交付的尺寸与首轮不同（对应备选）',
        Boolean(switchedShape) && Boolean(firstShape) && Number(switchedShape?.sizeMeters) !== Number(firstShape?.sizeMeters),
        JSON.stringify({ from: firstShape?.sizeMeters, to: switchedShape?.sizeMeters }),
      );
      // 2026-11-07 复核修正：只断言"方向一致"是假通过（真实运行承诺 7.2km 实际切到
      // 0.9km 也满足"更小"）——必须断言交付的就是回复文案承诺的那一版：
      // 从回复解析备选 km（"另有一版…（7.2 km）"），切换后 sizeMeters 必须与其一致
      const promisedKmMatch = reply.match(/另有一版[^（(]*[（(]([0-9.]+) km[）)]/);
      ctx.check('回复文案可解析出被承诺的备选尺寸', Boolean(promisedKmMatch), reply.slice(-200));
      if (promisedKmMatch) {
        const promisedKm = Number(promisedKmMatch[1]);
        ctx.check(
          '切换交付的就是承诺的那一版（sizeMeters ≈ 文案承诺 km，±0.05）',
          Math.abs(Number(switchedShape?.sizeMeters) / 1000 - promisedKm) <= 0.05,
          JSON.stringify({ promisedKm, deliveredSizeMeters: switchedShape?.sizeMeters }),
        );
      }
      ctx.check(
        '切换命中承诺版本（promisedDelivered=true，非方向极值兜底）',
        switched[0]?.promisedDelivered === true,
        JSON.stringify(switched[0]),
      );
      const switchedReply = lastReply(snap) ?? '';
      ctx.check('切换回复说明已切换到对应版本', switchedReply.includes('已切换到'), switchedReply.slice(0, 160));
      ctx.setActual({
        promised: promisedBigger ? 'bigger' : 'smaller',
        from: firstShape?.sizeMeters ?? null,
        to: switchedShape?.sizeMeters ?? null,
        switched: switched[0] ?? null,
      });
      await ctx.shot('alternative-switched');
    },
  },

  // ================= B9 Bug 1：失败可见化全链路（复核补充） =================
  {
    id: 'B9',
    category: '缺陷回归 Bug1 失败可见化',
    title: '长颈鹿（上游全部拒转或许可不可用）→ 失败种类与计数全链路可见',
    input: '在花城广场画一只长颈鹿',
    expected:
      '在线路真实检索到候选但全部不可用（multi-part 拒转 → conversion-failed；或许可白名单外 → filtered，二者随上游结果而定）→ 服务端 ok:false → 客户端透传 → 日志 agent.threeSources.path(status=failed, failureKind∈{conversion-failed,filtered}, attempts>0 或 filteredOut>0，error 可读)——修复前 ok:false 被客户端抛成"非预期结构"，失败原因全部丢失；不得伪装成 no-match/miss',
    async run(ctx) {
      const first = await sendAndWait(ctx, this.input);
      const turn1Logs = await ctx.logs(first.traceId);
      const pathEvents = allLogData(turn1Logs, 'agent.threeSources.path');
      const onlinePath = pathEvents.find((item) => item.path === 'online');
      ctx.check('三路在线路有事件', Boolean(onlinePath), JSON.stringify(pathEvents));
      const kind = onlinePath?.failureKind;
      ctx.check(
        '在线路 status=failed 且 failureKind ∈ {conversion-failed, filtered}（不得伪装成 no-match/miss；贯通：服务端→client→controller）',
        onlinePath?.status === 'failed' && (kind === 'conversion-failed' || kind === 'filtered'),
        JSON.stringify(onlinePath),
      );
      ctx.check(
        '失败有真实计数与可读原因（attempts>0 或 filteredOut>0；error 非空）',
        (Number(onlinePath?.attempts) > 0 || Number(onlinePath?.filteredOut) > 0) && Boolean(onlinePath?.error),
        JSON.stringify(onlinePath),
      );
      const selected = await selectFirstCardIfAny(ctx, first.snap);
      const reply = lastReply(selected.snap) ?? '';
      const delivery = await deliveryOf(ctx, selected.snap);
      checkBasicReply(ctx, selected.snap, '', null);
      if (!delivery.delivered) {
        checkHonestFailure(ctx, reply, '', null);
      }
      ctx.setActual({
        onlinePath,
        clicked: selected.clicked,
        delivered: delivery.delivered,
        reply: reply.slice(0, 400),
      });
      await ctx.shot('online-failure-visible');
    },
  },
];

export const SUITE_TITLE = '缺陷清单 2026-11-06 修复真实 LLM E2E（9 例，2026-11-07 复核修正版）';
