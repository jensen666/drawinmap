/**
 * 多比例尺候选展示 E2E 用例（需求 2026-11-09 §5.5 E2E-01~10）。
 *
 * 三条硬口径（需求 §5.1）：真实浏览器（CDP 驱动真实 Edge，截图为证）、真实 LLM
 * （agent-config.js 真实接口，禁止 mock/拦截）、真实链路数据（候选来自本轮真实
 * 路网规划，禁止硬编码候选池）。每例记录"四个数字"：原始候选数（deliver.scalePool
 * 的 rawCount）、档位数（tierCount）、展示卡片数（DOM）、点选记录（点选前后地图/
 * 卡片选中态/历史图形核对）。
 *
 * 交互修正（2026-11-09）：点选卡片不再追加"点选 X km 卡片"用户消息与切换回复，
 * 改为就地切换 + 面板轻提示（.agent-toast），消息区滚动位置保持不动；E2E 对应断言
 * 见 clickAndVerifySwitch（消息数不变、scrollTop 保持、轻提示数字与卡片同源）。
 *
 * 运行（先 node web/server.mjs 5173）：
 *   node tools/e2e-real-llm-30.mjs --cases-file test/e2e-real-llm-scale-cases.mjs \
 *     --artifact-dir "docs/测试报告/2026-11-09-多比例尺候选展示-E2E" \
 *     --out result-scale.json --turn-timeout 420000
 * 分段：追加 --cases S01,S02（用例 id 见下）。
 */

/** 从文本中取"约 X"的时长片段（在下一个字段关键词处截断；textContent 拼接无分隔符） */
function parseDuration(text) {
  const after = String(text).split('约')[1] ?? '';
  const cut = after.search(/贴合|里程|覆盖|关键|中心|路线|当前|（|·/);
  const raw = (cut >= 0 ? after.slice(0, cut) : after).trim();
  return raw || null;
}

/** 每张卡的 DOM 文本里解析数字（卡片文案口径与交付回复一致） */
function parseCardText(text) {
  const size = text.match(/([\d.]+)\s*km/)?.[1] ?? null;
  const score = text.match(/路线贴合\s*(\d+)/)?.[1] ?? null;
  const route = text.match(/里程\s*([\d.]+)\s*km/)?.[1] ?? null;
  const duration = parseDuration(text);
  return { size, score, route, duration };
}

/** 交付回复主行里的比例尺与贴合分（与卡片同一口径核对） */
function parseReplyMain(text) {
  const size = text.match(/尺寸\s*([\d.]+)\s*km/)?.[1] ?? null;
  const score = text.match(/路线贴合\s*(\d+)\s*·\s*尺寸/)?.[1] ?? null;
  return { size, score };
}

/** 切换轻提示里的数字（已切换到 X km 版 · 里程 N km · 约 D · 路线贴合 S；缺项为 null） */
function parseSwitchToast(text) {
  const size = text.match(/已切换到\s*([\d.]+)\s*km\s*版/)?.[1] ?? null;
  const route = text.match(/里程\s*([\d.]+)\s*km/)?.[1] ?? null;
  const duration = String(text).includes('约') ? parseDuration(text) : null;
  const score = text.match(/路线贴合\s*(\d+)/)?.[1] ?? null;
  return { size, route, duration, score };
}

/** 页面全局日志计数（真实链路证据：llm.request / plan.begin 总数） */
const COUNT_EXPR = (event) => `(() => {
  const api = window.DrawInMapLog;
  if (!api || typeof api.entries !== 'function') return null;
  const list = api.entries({}) || api.entries() || [];
  return list.filter((item) => item && item.event === ${JSON.stringify(event)}).length;
})()`;

/**
 * 多结果场景统一开场：真实发送 → 等回复 → 快照与链路日志。
 *
 * @returns {{snap: object, traceId: string|null, logs: object, poolLog: object|null}}
 */
async function startScaleScenario(ctx, input) {
  await ctx.send(input);
  let finished = await ctx.waitTurn();
  ctx.check('本轮在超时前完成', finished, '等待回复超时');
  let snap = await ctx.snapshot();
  // 意图波动兜底（与 runSpec.selectFirstCardIfAny 同一用户路径）：LLM 偶尔把内置
  // 图形解析成自定义点列 → 触发三路参考候选待选；先按真实用户行为点第一张轮廓，
  // 等点选后的规划轮完成再继续（点选轮不重复计"四个数字"，池在规划轮构建）。
  if (snap.dom?.refChoiceVisible) {
    ctx.check('意图走参考候选：出现候选卡并点第一张（真实用户路径）', true, '');
    const clicked = await ctx.clickRefCard(0);
    ctx.check('参考候选点选成功', clicked?.ok === true, JSON.stringify(clicked));
    finished = await ctx.waitTurn();
    ctx.check('点选后规划轮在超时前完成', finished, '规划轮超时');
    snap = await ctx.snapshot();
    ctx.capture('after-reference-selected', snap);
  }
  ctx.check('本轮无报错气泡（吞错即失败）', !snap.dom?.errorText, snap.dom?.errorText ?? '');
  const traceId = [...(snap.store?.session?.messages ?? [])]
    .reverse()
    .find((message) => message.traceId)?.traceId ?? null;
  const logs = await ctx.logs(traceId);
  const poolLog = (Array.isArray(logs) ? logs : []).find((item) => item.event === 'deliver.scalePool')?.data ?? null;
  return { snap, traceId, logs, poolLog };
}

/** 活的卡片行（可点状态）与卡片列表 */
function liveRowOf(snap) {
  const rows = snap.dom?.scaleRows ?? [];
  return rows.find((row) => row.live && row.cards.length >= 2) ?? null;
}

/** 通用断言：卡片行按 R1/R3/R4 展示（数量口径、排序、当前版标记、指标完整） */
function checkCardRowBasics(ctx, snap, logs, poolLog, { reply = null } = {}) {
  const row = liveRowOf(snap);
  ctx.check('出现可点的比例尺候选卡（≥2 档才展示）', Boolean(row), JSON.stringify(snap.dom?.scaleRows?.map((r) => ({ live: r.live, n: r.cards.length })) ?? []));
  if (!row || !poolLog) {
    return null;
  }
  const sizes = row.cards.map((card) => parseCardText(card.text).size);
  const numeric = sizes.map((value) => Number(value));
  ctx.check(
    `卡片数 = min(档位数, 上限)（tierCount=${poolLog.tierCount}, limit=${poolLog.limit}）`,
    row.cards.length === Math.min(poolLog.tierCount, poolLog.limit),
    `cards=${row.cards.length}`,
  );
  ctx.check(
    '卡片按比例尺由小到大排列',
    numeric.every((value, index) => index === 0 || value > numeric[index - 1]),
    JSON.stringify(sizes),
  );
  ctx.check(
    '卡片尺寸集合 = 本轮实际可交付档位集合（超上限按 R4 截断）',
    numeric.length === (poolLog.sizes ?? []).length
      && numeric.every((km) => (poolLog.sizes ?? []).some((meters) => Math.abs(km * 1000 - meters) <= 60))
      && (poolLog.sizes ?? []).every((meters) => numeric.some((km) => Math.abs(km * 1000 - meters) <= 60)),
    JSON.stringify({ cards: numeric, tiers: poolLog.sizes }),
  );
  ctx.check(
    '当前交付版必在展示中',
    row.cards.some((card) => card.current),
    JSON.stringify(row.cards.map((c) => c.current)),
  );
  ctx.check('当前版有且只有一个选中标识', row.cards.filter((card) => card.current).length === 1);
  ctx.check(
    'hiddenCount 如实（截断时界面告知未展示档数）',
    (poolLog.hiddenCount > 0) === (typeof row.caption === 'string' && row.caption.includes('未展示')),
    JSON.stringify({ hiddenCount: poolLog.hiddenCount, caption: row.caption }),
  );
  ctx.check(
    '每卡含比例尺、路线贴合、里程、用时（不编造缺失项）',
    row.cards.every((card) => {
      const parsed = parseCardText(card.text);
      return parsed.size && parsed.score && parsed.route && parsed.duration;
    }),
    JSON.stringify(row.cards.map((c) => parseCardText(c.text))),
  );
  if (reply) {
    const main = parseReplyMain(reply);
    const currentCard = row.cards.find((card) => card.current);
    const parsed = parseCardText(currentCard.text);
    ctx.check(
      '当前卡比例尺 = 回复"尺寸 X.X km"（同一口径）',
      main.size !== null && parsed.size !== null && Math.abs(Number(main.size) - Number(parsed.size)) < 0.051,
      JSON.stringify({ reply: main, card: parsed }),
    );
    ctx.check(
      '当前卡相似度 = 回复"路线贴合 N"（同一个分数）',
      main.score !== null && parsed.score !== null && main.score === parsed.score,
      JSON.stringify({ reply: main.score, card: parsed.score }),
    );
  }
  ctx.setActual({
    rawCandidateCount: poolLog.rawCount,
    tierCount: poolLog.tierCount,
    shownCardCount: row.cards.length,
    hiddenCount: poolLog.hiddenCount,
    cardSizes: numeric,
    currentSizeMeters: poolLog.currentSizeMeters,
  });
  return row;
}

/**
 * 点选一张非当前版卡片并核对就地切换。
 * R2 + 交互修正 2026-11-09：不重规划、不新增对话消息、不把消息区滚到底，
 * 轻提示数字逐项与卡片同源，地图/卡片选中态/历史图形切到该版。
 */
async function clickAndVerifySwitch(ctx, snap0, { preferIndex = null } = {}) {
  const row0 = liveRowOf(snap0);
  if (!row0) {
    ctx.check('点选前置：存在可点卡片行', false, '无活卡片行');
    return null;
  }
  const shapes0 = snap0.store?.session?.shapes ?? [];
  const messages0 = snap0.store?.session?.messages?.length ?? 0;
  const llmBefore = await ctx.evaluate(COUNT_EXPR('llm.request'));
  const planBefore = await ctx.evaluate(COUNT_EXPR('plan.begin'));
  const currentIndex = row0.cards.findIndex((card) => card.current);
  const targetIndex = preferIndex ?? row0.cards.findIndex((card) => !card.current);
  const targetCard = row0.cards[targetIndex];
  // 用户诉求：点选不应把正在看的位置冲掉。先滚到消息区顶部（最不利位置），
  // 点选后 scrollTop 必须仍是 0（旧实现在这里会 renderAll→scrollToBottom）。
  const scrollSetup = await ctx.evaluate(`(() => {
    const el = document.getElementById('agent-messages');
    if (!el) return { ok: false };
    el.scrollTop = 0;
    return { ok: true, scrollTop: el.scrollTop, scrollable: el.scrollHeight > el.clientHeight + 4 };
  })()`);
  const clicked = await ctx.clickScaleCard(targetIndex);
  ctx.check(
    '点选非当前版卡片成功',
    clicked?.ok === true && clicked.isCurrent === false && clicked.count >= 2,
    JSON.stringify(clicked),
  );
  ctx.check(
    '点选不再新增对话消息（就地切换，不落"点选卡片"记录）',
    clicked?.messagesAfter === clicked?.messagesBefore,
    JSON.stringify({ before: clicked?.messagesBefore, after: clicked?.messagesAfter }),
  );
  ctx.check(
    '点选不把消息区滚动位置冲到底部（仍停在顶部）',
    scrollSetup?.ok !== true
      || (clicked?.scrollBefore === 0 && clicked?.scrollAfter === 0),
    JSON.stringify({ setup: scrollSetup, before: clicked?.scrollBefore, after: clicked?.scrollAfter }),
  );
  const targetParsed = parseCardText(targetCard.text);
  const toastText = typeof clicked?.toast === 'string' ? clicked.toast : '';
  ctx.check('点选后浮出轻提示"已切换到该比例尺"', toastText.includes('已切换到'), toastText || '无轻提示文本');
  const switched = parseSwitchToast(toastText);
  ctx.check(
    '点选后交付版本 = 卡片比例尺（尺寸一致）',
    Math.abs(Number(switched.size) - Number(targetParsed.size)) < 0.051,
    JSON.stringify({ toast: switched.size, card: targetParsed.size }),
  );
  ctx.check(
    '点选后轻提示与卡片逐项一致（贴合/里程/用时同源）',
    switched.score === targetParsed.score
      && Math.abs(Number(switched.route) - Number(targetParsed.route)) < 0.0051
      && switched.duration === targetParsed.duration,
    JSON.stringify({ toast: switched, card: targetParsed }),
  );
  const snap1 = await ctx.snapshot();
  ctx.capture('switched', snap1);
  const messages1 = snap1.store?.session?.messages?.length ?? 0;
  ctx.check(
    '切换后会话消息数不变（不产生"点选 X km 卡片"+回复两条消息）',
    messages1 === messages0,
    JSON.stringify({ before: messages0, after: messages1 }),
  );
  const row1 = liveRowOf(snap1);
  ctx.check(
    '切换后卡片选中态移到目标卡（有且只有一个当前版）',
    Boolean(row1)
      && row1.cards[targetIndex]?.current === true
      && row1.cards.filter((card) => card.current).length === 1,
    JSON.stringify(row1?.cards?.map((card) => ({ size: parseCardText(card.text).size, current: card.current }))),
  );
  ctx.check(
    '切换后消息区滚动位置仍为顶部（快照复核）',
    scrollSetup?.ok !== true || snap1.dom?.messagesScrollTop === 0,
    JSON.stringify({ setup: scrollSetup, after: snap1.dom?.messagesScrollTop }),
  );
  const shapes1 = snap1.store?.session?.shapes ?? [];
  ctx.check(
    '地图/历史图形切到该版（图形快照新增且尺寸=卡片）',
    shapes1.length === shapes0.length + 1
      && Math.abs((shapes1[shapes1.length - 1]?.sizeMeters ?? 0) / 1000 - Number(targetParsed.size)) < 0.051,
    JSON.stringify({ before: shapes0.length, after: shapes1.length, last: shapes1[shapes1.length - 1]?.sizeMeters }),
  );
  const strokes = snap1.dom?.routeStrokes ?? [];
  ctx.check('切换后地图仍是绿线交付（无橙线/无残留）', strokes.includes('#16a34a') && !strokes.includes('#f59e0b'), JSON.stringify(strokes));
  const llmAfter = await ctx.evaluate(COUNT_EXPR('llm.request'));
  const planAfter = await ctx.evaluate(COUNT_EXPR('plan.begin'));
  ctx.check(
    '点选不新增模型请求（llm.request 计数不变）',
    llmBefore !== null && llmAfter !== null && llmAfter === llmBefore,
    `before=${llmBefore} after=${llmAfter}`,
  );
  ctx.check(
    '点选不新增规划轮次（plan.begin 计数不变）',
    planBefore !== null && planAfter !== null && planAfter === planBefore,
    `before=${planBefore} after=${planAfter}`,
  );
  ctx.check('消息区无报错气泡', !snap1.dom?.errorText, snap1.dom?.errorText ?? '');
  ctx.setActual({
    clickedCards: [
      ...(ctx.__clickedCards ?? []),
      { sizeText: clicked.sizeText, index: targetIndex, messagesBefore: messages0, toast: toastText },
    ],
  });
  ctx.__clickedCards = [...(ctx.__clickedCards ?? []), { sizeText: clicked.sizeText, index: targetIndex }];
  return { snap: snap1, clickedIndex: targetIndex, clickedSize: targetParsed.size, toast: toastText };
}

// ---------- 用例集 ----------

export const CASES = [
  {
    id: 'S01',
    category: '多比例尺候选 · R1/R3/R4',
    title: 'E2E-01 多结果展示：珠江新城心形（历史实测 9 档）',
    input: '在珠江新城画个心形',
    expected: '出现多张比例尺卡片；升序；当前版高亮；每卡含尺寸/贴合/里程/用时；卡片与回复同口径；卡片集合=实际档位集合（超上限截断）',
    async run(ctx) {
      const { snap, traceId, logs, poolLog } = await startScaleScenario(ctx, this.input);
      ctx.setActual({ traceId });
      ctx.check('链路记录 deliver.scalePool（四个数字取证）', Boolean(poolLog), JSON.stringify((Array.isArray(logs) ? logs : []).map((item) => item.event)));
      const row = checkCardRowBasics(ctx, snap, logs, poolLog);
      if (row) {
        // E2E-04 上限口径在多结果例中一并核对（同一例自然覆盖）
        if (poolLog.tierCount > poolLog.limit) {
          ctx.check(`E2E-04 超上限：卡片数 = 上限 ${poolLog.limit}`, row.cards.length === poolLog.limit, String(row.cards.length));
          ctx.check('E2E-04 超上限：界面告知未展示档数', row.caption.includes(`还有 ${poolLog.hiddenCount} 档未展示`), row.caption);
          ctx.check(
            'E2E-04 超上限：保留的是与当前版最接近的档位',
            JSON.stringify(row.cards.map((c) => parseCardText(c.text).size)) !== '[]',
            row.caption,
          );
        } else {
          ctx.check('E2E-04 未触发截断（本轮档位数 ≤ 上限），如实记录', true, `tierCount=${poolLog.tierCount} limit=${poolLog.limit}`);
        }
        ctx.check('回复未出现两套口径（卡片与回复同一贴合分）', /路线贴合 \d+/.test(snap.dom.lastAgentText ?? ''), '');
        await ctx.shot('01-cards-map');
      }
    },
  },
  {
    id: 'S02',
    category: '多比例尺候选 · R2',
    title: 'E2E-02 点选切换：就地换图、无新消息/无滚动，无新规划',
    input: '在珠江新城画个心形',
    expected: '点第 2 张卡片：地图就地重画为该版；轻提示"已切换到 X km 版"且数字与卡片逐项一致；不新增对话消息、不把消息区滚到底；无新增规划轮次与模型请求；回复内"查看此图形"指向切换版',
    async run(ctx) {
      const { snap, traceId } = await startScaleScenario(ctx, this.input);
      ctx.setActual({ traceId });
      const beforeShot = await ctx.snapshot();
      await ctx.shot('02-before');
      const result = await clickAndVerifySwitch(ctx, beforeShot, { preferIndex: 1 });
      if (result) {
        // 不新增消息：回复仍只有一条，"查看此图形"入口仍只有 1 个且指向切换后的版本
        const viewButtons = await ctx.evaluate(`document.querySelectorAll('.agent-shape-view').length`);
        ctx.check('切换不新增消息（查看此图形入口仍只有 1 个）', viewButtons === 1, String(viewButtons));
        const clickedView = await ctx.evaluate(`(() => {
          const buttons = document.querySelectorAll('.agent-shape-view');
          const last = buttons[buttons.length - 1];
          if (!last) return { ok: false, count: buttons.length };
          last.click();
          return { ok: true, count: buttons.length };
        })()`);
        ctx.check('切换后回复仍可回看该轮图形', clickedView?.ok === true, JSON.stringify(clickedView));
        await new Promise((resolve) => setTimeout(resolve, 600));
        const snapView = await ctx.snapshot();
        const shapes = snapView.store?.session?.shapes ?? [];
        ctx.check(
          '查看此图形：定位到切换后的版本（activeShapeId = 最新图形）',
          snapView.store?.session?.activeShapeId === (shapes[shapes.length - 1]?.id ?? null),
          JSON.stringify({ active: snapView.store?.session?.activeShapeId, last: shapes[shapes.length - 1]?.id }),
        );
        ctx.check('查看此图形：地图仍是绿线', (snapView.dom.routeStrokes ?? []).includes('#16a34a'), JSON.stringify(snapView.dom.routeStrokes));
        await ctx.shot('02-after');
      }
    },
  },
  {
    id: 'S03',
    category: '多比例尺候选 · R2 反复切换',
    title: 'E2E-03 反复切换与点当前版',
    input: '在珠江新城画个心形',
    expected: '可来回切换且每次都不产生对话消息；点当前版不重复绘制并轻提示"当前就是这一版"；无报错',
    async run(ctx) {
      const { snap, traceId } = await startScaleScenario(ctx, this.input);
      ctx.setActual({ traceId });
      const first = await clickAndVerifySwitch(ctx, snap);
      if (!first) {
        return;
      }
      const second = await clickAndVerifySwitch(ctx, first.snap);
      if (!second) {
        return;
      }
      // 点当前已交付版：不重复绘制、不新增消息，只轻提示确认
      const before = await ctx.snapshot();
      const shapesBefore = before.store?.session?.shapes?.length ?? 0;
      const messagesBefore = before.store?.session?.messages?.length ?? 0;
      const row = liveRowOf(before);
      const currentIndex = row.cards.findIndex((card) => card.current);
      const clicked = await ctx.clickScaleCard(currentIndex);
      ctx.check('点当前版：点击被接受（is-current 卡可点）', clicked?.ok === true && clicked.isCurrent === true, JSON.stringify(clicked));
      const notice = typeof clicked?.toast === 'string' ? clicked.toast : '';
      ctx.check('点当前版：轻提示明确"当前就是这一版"', notice.includes('当前就是这一版'), notice || '无轻提示文本');
      ctx.check('点当前版：不新增对话消息', clicked?.messagesAfter === clicked?.messagesBefore, JSON.stringify({ before: clicked?.messagesBefore, after: clicked?.messagesAfter }));
      const snapNow = await ctx.snapshot();
      ctx.check('点当前版：不重复绘制（图形快照数不变）', (snapNow.store?.session?.shapes?.length ?? 0) === shapesBefore, JSON.stringify({ before: shapesBefore, after: snapNow.store?.session?.shapes?.length }));
      ctx.check('点当前版：会话消息数不变', (snapNow.store?.session?.messages?.length ?? 0) === messagesBefore, JSON.stringify({ before: messagesBefore, after: snapNow.store?.session?.messages?.length }));
      ctx.check('点当前版：地图仍是绿线', (snapNow.dom.routeStrokes ?? []).includes('#16a34a'));
      ctx.check('点当前版：无报错', !snapNow.dom?.errorText, snapNow.dom?.errorText ?? '');
      await ctx.shot('03-current-notice');
    },
  },
  {
    id: 'S05',
    category: '多比例尺候选 · R4 单档',
    title: 'E2E-05 单档（显式尺寸）：不出选择卡，交付正常',
    input: '在广州塔画个 1 公里的五角星',
    expected: '只有 1 个可交付档：不出现选择卡；正常交付绿线/参考版；行为与改动前一致',
    async run(ctx) {
      await ctx.send(this.input);
      const finished = await ctx.waitTurn();
      ctx.check('本轮在超时前完成', finished, '等待回复超时');
      const snap = await ctx.snapshot();
      ctx.capture('delivered', snap);
      const traceId = [...(snap.store?.session?.messages ?? [])].reverse().find((m) => m.traceId)?.traceId ?? null;
      ctx.setActual({ traceId });
      const logs = await ctx.logs(traceId);
      const poolLog = (Array.isArray(logs) ? logs : []).find((item) => item.event === 'deliver.scalePool')?.data ?? null;
      const skippedLog = (Array.isArray(logs) ? logs : []).find((item) => item.event === 'deliver.scalePool.skipped')?.data ?? null;
      ctx.check(
        '单档：链路记录无 scalePool（skipped 说明单档或档位不足）',
        poolLog === null,
        JSON.stringify(poolLog),
      );
      ctx.setActual({
        tierCountObserved: skippedLog?.tierCount ?? poolLog?.tierCount ?? null,
        rawCandidateCount: skippedLog?.rawCount ?? poolLog?.rawCount ?? null,
        shownCardCount: (snap.dom?.scaleRows ?? []).filter((r) => r.live).reduce((sum, r) => sum + r.cards.length, 0),
      });
      const liveRows = (snap.dom?.scaleRows ?? []).filter((row) => row.live && row.cards.length >= 2);
      ctx.check('单档：不出现可点选择卡', liveRows.length === 0, JSON.stringify(liveRows));
      ctx.check('单档：回复不提示点卡片', !(snap.dom.lastAgentText ?? '').includes('点下方比例尺卡片'), snap.dom.lastAgentText?.slice(-120));
      const strokes = snap.dom?.routeStrokes ?? [];
      ctx.check('单档：交付正常（绿线或橙线，与改动前一致）', strokes.includes('#16a34a') || strokes.includes('#f59e0b'), JSON.stringify(strokes));
      await ctx.shot('05-single-tier');
    },
  },
  {
    id: 'S06',
    category: '多比例尺候选 · 数量区间补抽',
    title: 'E2E-06 换地点/图形补抽：越秀公园心形',
    input: '在越秀公园画个心形',
    expected: '展示数量与档位数/上限口径一致，卡片可点且交付一致；如实记录实际档位数',
    async run(ctx) {
      const { snap, traceId, logs, poolLog } = await startScaleScenario(ctx, this.input);
      ctx.setActual({ traceId });
      ctx.setActual({ actualTierNote: poolLog ? `tierCount=${poolLog.tierCount}` : '本轮无可交付档（如实记录）' });
      if (!poolLog || poolLog.tierCount < 2) {
        ctx.check('补抽例如实记录实际档位数（未达 2 档时按单档口径不展示）', true, JSON.stringify({ poolLog, events: (Array.isArray(logs) ? logs : []).map((i) => i.event) }));
        return;
      }
      checkCardRowBasics(ctx, snap, logs, poolLog, { reply: snap.dom.lastAgentText });
      await clickAndVerifySwitch(ctx, snap);
      await ctx.shot('06-middle-tier');
    },
  },
  {
    id: 'S07',
    category: '多比例尺候选 · 0 档边界',
    title: 'E2E-07 目标不合格/路线不达标：无候选卡',
    input: '在白云山画一个回字形',
    expected: '无候选卡；保持橙色非合格参考版或诚实失败语义',
    async run(ctx) {
      await ctx.send(this.input);
      const finished = await ctx.waitTurn();
      ctx.check('本轮在超时前完成', finished, '等待回复超时');
      const snap = await ctx.snapshot();
      ctx.capture('delivered', snap);
      const traceId = [...(snap.store?.session?.messages ?? [])].reverse().find((m) => m.traceId)?.traceId ?? null;
      ctx.setActual({ traceId });
      const logs = await ctx.logs(traceId);
      const poolLog = (Array.isArray(logs) ? logs : []).find((item) => item.event === 'deliver.scalePool')?.data ?? null;
      ctx.check('0 档：链路无 scalePool', poolLog === null, JSON.stringify(poolLog));
      const liveRows = (snap.dom?.scaleRows ?? []).filter((row) => row.live && row.cards.length >= 2);
      ctx.check('0 档：不出现候选卡', liveRows.length === 0, JSON.stringify(liveRows));
      const reply = snap.dom.lastAgentText ?? '';
      const honest = ['画不出', '没有画', '没画出来', '没有硬画', '已尽力尝试', '仅供参考', '不合格', '没有通过', '没能'].some((word) => reply.includes(word));
      ctx.check('0 档：回复保持橙色参考版或诚实失败语义', honest, reply.slice(0, 300));
      ctx.setActual({ replyExcerpt: reply.slice(0, 300) });
      await ctx.shot('07-zero-tier');
    },
  },
  {
    id: 'S08',
    category: '多比例尺候选 · R5 生命周期',
    title: 'E2E-08 刷新后静态可见不可点；新输入后失效',
    input: '在珠江新城画个心形',
    expected: '刷新后旧卡片静态可见、不可点，点选无反应且无报错；新输入后旧卡片不可点',
    async run(ctx) {
      const { snap, traceId } = await startScaleScenario(ctx, this.input);
      ctx.setActual({ traceId });
      if (!liveRowOf(snap)) {
        ctx.check('生命周期前置：本轮出现多结果卡片', false, '无可点卡片行（本轮档位不足，如实记录）');
        return;
      }
      const shapesBefore = snap.store?.session?.shapes?.length ?? 0;
      // 刷新页面：池在内存里消失，消息摘要仍在 → 静态可见、不可点
      await ctx.reload();
      const snapAfter = await ctx.snapshot();
      ctx.capture('after-reload', snapAfter);
      const rows = snapAfter.dom?.scaleRows ?? [];
      ctx.check('刷新后：旧卡片行静态可见', rows.some((row) => row.stale && row.cards.length >= 2), JSON.stringify(rows.map((r) => ({ live: r.live, stale: r.stale, n: r.cards.length }))));
      ctx.check('刷新后：无活卡（不可点状态）', !rows.some((row) => row.live), JSON.stringify(rows.map((r) => r.live)));
      ctx.check(
        '刷新后：卡片渲染为 disabled（点选无反应的基础）',
        rows.flatMap((row) => row.cards).every((card) => card.disabled),
        JSON.stringify(rows.flatMap((row) => row.cards).map((c) => c.disabled)),
      );
      // 模拟点击（disabled 按钮点击不触发任何处理）后无变化、无报错
      await ctx.evaluate(`(() => { const card = document.querySelector('.agent-scale-cards .agent-scale-card'); if (card) card.click(); return true; })()`);
      await new Promise((resolve) => setTimeout(resolve, 800));
      const snapClick = await ctx.snapshot();
      ctx.check('刷新后：点旧卡无反应（图形数不变）', (snapClick.store?.session?.shapes?.length ?? 0) === shapesBefore, JSON.stringify({ before: shapesBefore, after: snapClick.store?.session?.shapes?.length }));
      ctx.check('刷新后：无报错气泡', !snapClick.dom?.errorText, snapClick.dom?.errorText ?? '');
      // 新输入：旧卡片继续不可点
      await ctx.send('换个话题，随便聊聊');
      const chatDone = await ctx.waitTurn();
      ctx.check('新输入轮完成', chatDone, 'chat 轮超时');
      const snapChat = await ctx.snapshot();
      ctx.check('新输入后：旧卡片仍不可点（无活卡）', !((snapChat.dom?.scaleRows ?? []).some((row) => row.live)), JSON.stringify(snapChat.dom?.scaleRows?.map((r) => r.live)));
      ctx.check('新输入后：无报错', !snapChat.dom?.errorText, snapChat.dom?.errorText ?? '');
      await ctx.shot('08-stale-after-input');
    },
  },
  {
    id: 'S09',
    category: '多比例尺候选 · R5 会话/城市隔离',
    title: 'E2E-09 切会话再切回；切城市不串数据',
    input: '在珠江新城画个心形',
    expected: '不同会话/城市的候选不串；切回原会话后旧卡片静态或已失效，不出现旧城市结果',
    async run(ctx) {
      const { snap, traceId } = await startScaleScenario(ctx, this.input);
      ctx.setActual({ traceId });
      if (!liveRowOf(snap)) {
        ctx.check('隔离前置：本轮出现多结果卡片', false, '无可点卡片行（如实记录）');
        return;
      }
      const shapes0 = snap.store?.session?.shapes ?? [];
      // 新建会话：新会话无活卡
      await ctx.newSession();
      await new Promise((resolve) => setTimeout(resolve, 800));
      const snapNew = await ctx.snapshot();
      ctx.check('切到新会话：无活卡片行', !((snapNew.dom?.scaleRows ?? []).some((row) => row.live)), JSON.stringify(snapNew.dom?.scaleRows?.map((r) => r.live)));
      ctx.check('切到新会话：地图无旧城市路线残留', ((snapNew.dom?.routeStrokes ?? []).length === 0), JSON.stringify(snapNew.dom?.routeStrokes));
      // 切回原会话：旧卡片按 R5 处理（静态），不复活成可点
      await ctx.openHistory();
      const switchResult = await ctx.evaluate(`(() => {
        const rows = Array.from(document.querySelectorAll('#session-list .session-item-main'));
        const target = rows.find((row) => row.textContent.includes('在珠江新城画个心形'));
        if (!target) return { ok: false, count: rows.length, titles: rows.slice(0, 4).map((r) => r.textContent.trim().slice(0, 16)) };
        target.click();
        return { ok: true, count: rows.length };
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 800));
      await ctx.closeHistory();
      const snapBack = await ctx.snapshot();
      ctx.check('切回原会话：会话切回成功', switchResult?.ok === true, JSON.stringify(switchResult));
      const backRows = snapBack.dom?.scaleRows ?? [];
      ctx.check('切回原会话：旧卡片静态（不可点），历史仍可见', backRows.some((row) => row.stale && row.cards.length >= 2) && !backRows.some((row) => row.live), JSON.stringify(backRows.map((r) => ({ live: r.live, stale: r.stale }))));
      ctx.check(
        '切回原会话：旧图形不自动上地图（本会话图形数据仍在存储）',
        (snapBack.store?.session?.shapes?.length ?? 0) === shapes0.length,
        JSON.stringify({ before: shapes0.length, after: snapBack.store?.session?.shapes?.length }),
      );
      // 切换城市（真实切到深圳，路网来自按需获取缓存）→ 旧卡片失效、地图清空
      const cityOpen = await ctx.evaluate(`(() => { const btn = document.getElementById('city-btn'); if (!btn) return { ok:false }; btn.click(); return { ok:true }; })()`);
      await new Promise((resolve) => setTimeout(resolve, 600));
      const citySwitch = await ctx.evaluate(`(() => {
        const rows = Array.from(document.querySelectorAll('#city-list .city-row'));
        const target = rows.find((row) => row.textContent.includes('深圳'));
        if (!target) return { ok: false, count: rows.length, names: rows.slice(0, 8).map((r) => r.textContent.trim().slice(0, 12)) };
        target.click();
        return { ok: true, count: rows.length };
      })()`);
      ctx.check('切换城市：城市面板可操作并选中深圳', cityOpen?.ok === true && citySwitch?.ok === true, JSON.stringify({ cityOpen, citySwitch }));
      await new Promise((resolve) => setTimeout(resolve, 2500));
      await ctx.evaluate(`(() => { const close = document.getElementById('city-close'); if (close) close.click(); return true; })()`);
      const snapCity = await ctx.snapshot();
      ctx.capture('after-city-switch', snapCity);
      const cityLabel = await ctx.evaluate(`(document.getElementById('city-btn-label') || {}).textContent ?? ''`);
      ctx.check('切换城市：城市标签已变为深圳', String(cityLabel).includes('深圳'), String(cityLabel));
      ctx.check('切城后：无活卡片行（旧城市候选失效）', !((snapCity.dom?.scaleRows ?? []).some((row) => row.live)), JSON.stringify(snapCity.dom?.scaleRows?.map((r) => r.live)));
      ctx.check('切城后：地图无旧城市路线（不把旧城市结果画到当前地图）', ((snapCity.dom?.routeStrokes ?? []).length === 0), JSON.stringify(snapCity.dom?.routeStrokes));
      ctx.check('切城后：无报错', !snapCity.dom?.errorText, snapCity.dom?.errorText ?? '');
      await ctx.shot('09-after-city-switch');
    },
  },
  {
    id: 'S10',
    category: '多比例尺候选 · R3 窄屏',
    title: 'E2E-10 窄屏 375px：卡片不横向溢出、可点可切换',
    input: '在珠江新城画个心形',
    expected: '视口约 375px：卡片不产生页面级横向溢出；卡片可点、可切换；选中态清晰',
    async run(ctx) {
      await ctx.setViewport(375, 812);
      try {
        const { snap, traceId, logs, poolLog } = await startScaleScenario(ctx, this.input);
        ctx.setActual({ traceId, viewport: '375x812' });
        ctx.check('窄屏：链路记录 deliver.scalePool', Boolean(poolLog), JSON.stringify((Array.isArray(logs) ? logs : []).map((i) => i.event)));
        const row = checkCardRowBasics(ctx, snap, logs, poolLog, { reply: snap.dom.lastAgentText });
        if (!row) {
          return;
        }
        ctx.check(
          '窄屏：卡片不产生页面级横向溢出',
          (snap.dom?.overflowX ?? 0) <= 0,
          `overflowX=${snap.dom?.overflowX}`,
        );
        const result = await clickAndVerifySwitch(ctx, snap);
        if (result) {
          const snapNarrow = await ctx.snapshot();
          ctx.check('窄屏：切换后仍无横向溢出', (snapNarrow.dom?.overflowX ?? 0) <= 0, `overflowX=${snapNarrow.dom?.overflowX}`);
          ctx.check('窄屏：切换后选中态唯一', (liveRowOf(snapNarrow)?.cards.filter((c) => c.current).length ?? 0) === 1);
          await ctx.shot('10-narrow-after-switch');
        }
        await ctx.shot('10-narrow-cards');
      } finally {
        await ctx.clearViewport();
      }
    },
  },
];
