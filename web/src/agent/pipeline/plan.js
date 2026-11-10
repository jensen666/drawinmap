/**
 * plan 通道（C4 拆分自 controller.js）：executePlan 完整编排，依赖显式注入，
 * 行为与拆分前逐行一致。
 */

import { DELIVERABLE_SCORE } from '../../engine/quality.js';
import {
  buildConstraintContract,
  describeConstraintViolations,
  evaluateConstraintContract,
} from '../../engine/constraint-contract.js';
import { measureFeatureArcs } from '../../engine/feature-arcs.js';
import { createLogger } from '../../log/index.js';
import { isTargetQualified } from '../target-acceptance.js';
import { nearestPoi } from '../places.js';
import { composeObjectShortfallReply } from '../request-objects.js';
import { throwIfAborted } from '../../cancel.js';
import { ROUND_TIME_BUDGET_MS } from './shared.js';
import {
  buildOutlinePreview,
  placeTextOf,
  summarizeIntent,
  summarizePlanned,
  summarizeShape,
} from './deliver.js';

/** 模块 logger：与 controller 同 label（日志归属口径不变） */
const log = createLogger('agent');
/**
 * 创建 plan 通道运行时。
 *
 * @param {object} deps 依赖：engine/pushHistory/getCity/matching/待交付状态读写访问器/
 *   replyTemplates/pickPromisedAlternative/runtime（deliverReference 等交付与地点函数）
 * @returns {{executePlan: Function}}
 */
export function createPlanRuntime({
  engine,
  pushHistory,
  getCity,
  matching,
  getPendingAlternative,
  setPendingAlternative,
  getScaleCandidatePool,
  replyTemplates,
  pickPromisedAlternative,
  runtime,
}) {
  const {
    composeTargetBlockedReply,
    composeReferenceReply,
    composeConstraintViolationReply,
    composeFailureReply,
    composeReply,
    composeTargetFailureReply,
    composeDiagnosticReferenceReply,
    describeShortfall,
    shapeNameOf,
  } = replyTemplates;
  const { deliverReference, buildScaleCandidatePool, askUnresolvedPlace, resolvePlaceToCenter, auditDeliveryObjects } = runtime;

  async function executePlan(intent, text, onProgress, trace, imageDataUrl = null, target = null, signal = null, { requestText = null } = {}) {
    // 整轮截止：第一版搜索与局部精修共享
    const roundDeadline = performance.now() + ROUND_TIME_BUDGET_MS;

    // 目标闸门第一分支：规格无法生成合法 T → 完全不调用路网引擎（方案 §8.5 第一行）
    if (target?.blocked) {
      throwIfAborted(signal, '已停止');
      engine.clearDraw();
      const reply = composeTargetBlockedReply({ intent, blocked: target.blocked });
      pushHistory(text, reply);
      log.warn('deliver.targetBlocked', {
        blocked: target.blocked,
        shapeSpec: intent.shapeSpec,
        shapeSpecError: intent.shapeSpecError ?? null,
      });
      return { reply, planned: null, outline: null };
    }

    // 交付对象一致性闸门（方案 2026-11-05 §4.3）：请求对象 = 实际交付对象。
    // 多对象请求缺对象 → 不规划、不画线、不承诺，列出已命中与缺失对象追问。
    const objectAudit = auditDeliveryObjects({ intent, target });
    if (objectAudit.blocking) {
      throwIfAborted(signal, '已停止');
      engine.clearDraw();
      const reply = composeObjectShortfallReply({
        requested: objectAudit.requested,
        delivered: objectAudit.deliveredNames,
        missing: objectAudit.missing,
      });
      pushHistory(text, reply);
      log.warn('deliver.objectMismatch', {
        requested: objectAudit.requested.map((item) => item.name),
        delivered: objectAudit.deliveredNames,
        missing: objectAudit.missing.map((item) => item.name),
        deliveredPartCount: objectAudit.deliveredPartCount,
      });
      trace.info('agent.reply', { reply, plannedStatus: null, objectMismatch: true });
      return { reply, planned: null, outline: null };
    }
    if (objectAudit.checked && !objectAudit.ok) {
      // 单对象命名差异：记录差异，并抑制 LLM 开场白里的未兑现承诺
      log.warn('deliver.objectNameDiff', {
        requested: objectAudit.requested.map((item) => item.name),
        delivered: objectAudit.deliveredNames,
      });
    }

    onProgress({ text: '解析地点…', kind: 'step' });
    const { center, placeNote, placeSource, unresolved } = await resolvePlaceToCenter(intent.place, intent.centerChosen);
    if (unresolved && matching.unresolvedPlace !== 'view-center') {
      // 追问后的引导状态必须保留原始请求文本（requestText）：否则下一轮参考匹配
      // 与质检 userText 退化成引导回答（缺陷清单 Bug 2.4 第 4 条）
      return askUnresolvedPlace(intent, text, placeNote, { sourceText: requestText || text });
    }
    if (placeNote) {
      onProgress({ text: placeNote, kind: 'step' });
    }
    if (intent.sizeMeters) {
      onProgress({ text: `尺寸基准 ${intent.sizeMeters}m（阶梯 0.5~7.5× 实测自选）`, kind: 'step' });
    }

    /**
     * 显式约束契约（方案 2026-11-08 §3.1/§3.2）：
     * 用户显式说出的尺寸/朝向在这里归一成一份契约，随规划一路传到搜索层，
     * 并在最终提交前用同一口径复核"实际产物 vs 请求约束"。
     */
    const constraintContract = buildConstraintContract({
      sizeMeters: intent.sizeMeters,
      sizeExplicit: intent.sizeExplicit === true,
      rotationDeg: intent.rotationDeg,
      rotationExplicit: intent.rotationExplicit === true,
    });

    /**
     * 跑一次引擎规划（外层包 span，记录参数与耗时）。
     *
     * @param {object|null} customShape 目标轮廓 T（合格后固定不变）
     * @param {string} progressPrefix 进度前缀
     * @param {'formal'|'diagnostic'} purpose 规划用途（正式规划 / 诊断性参考规划）
     * @returns {Promise<object>} 引擎结果
     */
    const planOnce = (customShape, progressPrefix, purpose) =>
      trace.withSpan(
        purpose === 'diagnostic' ? 'engine.plan.diagnostic' : 'engine.plan',
        () =>
          engine.plan({
            shapeKey: intent.shapeKey,
            customShape,
            sizeMeters: intent.sizeMeters,
            rotationDeg: intent.rotationDeg,
            // 用户明确指定朝向时只搜该朝向；未指定时传 null 用默认朝向集合
            // （注意不能判 rotationDeg !== null——normalizeIntent 未指定时返回默认 0）
            rotations: intent.rotationExplicit ? [intent.rotationDeg] : null,
            // 显式约束契约：搜索层据此锁定尺寸/朝向（§3.2），并在提交前复核（§3.3）
            constraintContract,
            center,
            // 时间维度已移除：始终放开全尺寸阶梯（0.5~7.5×），档位按相对均方根现选
            allowEnlarge: true,
            deadline: roundDeadline,
            signal,
            onProgress: (p) =>
              onProgress({
                // 显示当前搜索尺寸：用户能看到系统在调整比例尺（细节反推后大档优先）
                text: `${progressPrefix}${p.stageLabel || '规划'}${
                  Number.isFinite(p.sizeMeters) ? ` · ${Math.round(p.sizeMeters)}m` : ''
                } ${p.done}/${p.total}`,
                kind: 'progress',
              }),
          }),
        {
          shapeKey: intent.shapeKey,
          customShapeName: customShape?.name ?? null,
          center,
          sizeMeters: intent.sizeMeters,
          rotationDeg: intent.rotationDeg,
          constraintContract,
          purpose,
        },
      );

    const placeText = placeTextOf(center, intent.place);

    // 目标闸门第二分支：拓扑合法但目标不合格/未验收 → 不进入正式规划；
    // 只做一次诊断性参考规划（结果固定为非合格参考版）或诚实失败（方案 §8.5）
    if (target && !isTargetQualified(target.acceptance)) {
      const purpose = 'diagnostic';
      log.info('plan.request', {
        ...summarizeIntent(intent),
        center,
        purpose,
        targetVerdict: target.acceptance.verdict,
        targetReasons: target.acceptance.reasons,
        targetVersion: target.targetVersion,
        customShape: summarizeShape(target.customShape),
      });
      onProgress({
        text: `目标验收未通过（${(target.acceptance.reasons || [])[0] || '不符合图形语义'}），做一次诊断性参考…`,
        kind: 'step',
      });
      let diagnostic;
      try {
        diagnostic = await planOnce(target.customShape, '诊断·', purpose);
      } catch (error) {
        log.error('plan.diagnostic.failed', { ...summarizeIntent(intent), center }, error);
        throw new Error(`路线规划失败：${error.message}`);
      }
      const drawable =
        diagnostic.status === 'ok' ? diagnostic.best : diagnostic.bestOverall || diagnostic.best;
      // 点序列图（展示当前目标长什么样）；无候选朝向时不旋转
      const outlinePreview = buildOutlinePreview({
        customShape: target.customShape,
        shapeKey: intent.shapeKey,
        referenceSource: intent.referenceSource || null,
        rotationDeg: drawable?.rotationDeg ?? null,
      });
      if (drawable?.result?.routeLatLngs?.length >= 2) {
        return deliverReference({
          text, signal, candidate: drawable,
          commitOptions: { reference: true, score: drawable.score, deliveredObjects: objectAudit?.deliveredObjects ?? [] },
          compose: () => composeDiagnosticReferenceReply({ intent, target, placeNote, candidate: drawable }),
          planned: { ...diagnostic, status: 'diagnostic-reference' },
          outline: outlinePreview,
          logEvent: 'deliver.diagnosticReference',
          logPayload: { reason: '目标验收未通过，非合格参考版', targetVerdict: target.acceptance.verdict, targetReasons: target.acceptance.reasons, targetVersion: target.targetVersion, routeScore: drawable.score, placeText },
        });
      }
      throwIfAborted(signal, '已停止');
      engine.clearDraw();
      log.warn('deliver.targetFailed', {
        reason: '目标验收未通过且无可绘制路线',
        targetVerdict: target.acceptance.verdict,
        targetReasons: target.acceptance.reasons,
        targetVersion: target.targetVersion,
        placeText,
      });
      const reply = composeTargetFailureReply({ intent, target, placeText, placeNote });
      pushHistory(text, reply);
      return { reply, planned: null, outline: outlinePreview };
    }

    // 正式规划：目标验收已通过，T 在整个路网搜索与重试期间固定不变
    // （方案 §9.3/§9.4——旧"路线分低就重画 T"的质量追击已按方案 §9.2 取消）。
    // 规划/预览/弧计算必须用同一版 T：自由轮廓修正被采纳时 target.customShape
    // 是复检通过的 v2，intent.customShape 仍是 v1（评审 🔴1——不能用 v1 规划）。
    const purpose = 'formal';
    const finalTargetShape = target?.customShape ?? intent.customShape;
    onProgress({ text: '在真实路网上搜索最像的走法…', kind: 'step' });
    log.info('plan.request', {
      ...summarizeIntent(intent),
      center,
      purpose,
      targetVersion: target?.targetVersion ?? null,
      customShape: summarizeShape(finalTargetShape),
    });

    let planned;
    try {
      planned = await planOnce(finalTargetShape, '', purpose);
    } catch (error) {
      log.error('plan.failed', { ...summarizeIntent(intent), center }, error);
      throw new Error(`路线规划失败：${error.message}`);
    }
    log.info('plan.result', summarizePlanned(planned));
    if (planned.status === 'ok' && planned.best) {
      onProgress({
        text: `选定：路线贴合 ${planned.best.score} · 尺寸 ${planned.best.sizeMeters}m · 朝向 ${planned.best.rotationDeg}°`,
        kind: 'step',
      });
    }

    // 点序列图预览：以本轮通过验收的目标轮廓为准（修正版采纳时为修正版），
    // 成功/参考版/失败交付都随回复展示同一张目标形状；
    // 朝向跟随最终交付候选（与地图紫色虚线同一刚体旋转），无候选朝向时不旋转
    const deliveredRotationDeg =
      planned.status === 'ok'
        ? planned.best?.rotationDeg ?? null
        : planned.bestOverall?.rotationDeg ?? planned.best?.rotationDeg ?? null;
    const outlinePreview = buildOutlinePreview({
      customShape: target?.customShape ?? intent.customShape,
      shapeKey: intent.shapeKey,
      referenceSource: intent.referenceSource || null,
      rotationDeg: deliveredRotationDeg,
    });

    // 部位弧偏差：搜索与精修全部结束后，只对最终选定候选（失败但交付橙色参考版时
    // 用最终参考候选）计算一次，写独立 trace 事件 plan.feature.arcs；
    // 不写 metrics、不进 scoreRoute、不改变绿色/橙色判定。
    const arcCandidate = planned.status === 'ok' ? planned.best : planned.bestOverall || planned.best;
    const arcShape = target?.customShape ?? intent.customShape;
    if (arcShape?.features?.length && arcCandidate?.result?.routeLatLngs?.length > 0) {
      log.info(
        'plan.feature.arcs',
        measureFeatureArcs({
          customShape: arcShape,
          result: arcCandidate.result,
          score: arcCandidate.score,
        }),
      );
    }

    // 交付闸门：路线走得出但不够像（<60 分）→ 不硬画；用户要求"画不出来时
    // 给最像的一版参考、标注非合格"——有可绘制结果就画成橙色参考版，否则清空
    if (planned.status === 'ok' && planned.best.score < DELIVERABLE_SCORE) {
      const shapeName = shapeNameOf(intent) || '图形';
      const candidate = planned.best;
      // 退化候选防御：路线点 <2 无法成线（0 km），不提交橙色参考版，走诚实失败
      if (candidate?.result?.routeLatLngs?.length >= 2) {
        return deliverReference({
          text, signal, candidate,
          commitOptions: { reference: true, score: candidate.score, deliveredObjects: objectAudit?.deliveredObjects ?? [] },
          compose: () => composeReferenceReply({ intent, placeNote, candidate, reason: describeShortfall(candidate) }),
          planned: { ...planned, status: 'reference' },
          outline: outlinePreview,
          logEvent: 'deliver.reference',
          logPayload: { reason: '路线贴合低于交付闸门（目标验收已通过）', score: candidate.score, threshold: DELIVERABLE_SCORE, shapeName, placeText, targetVersion: target?.targetVersion ?? null, metrics: summarizePlanned(planned) },
        });
      }
      throwIfAborted(signal, '已停止');
      engine.clearDraw();
      log.warn('deliver.rejected', {
        reason: '路线贴合低于交付闸门且无可用候选（目标验收已通过）',
        score: planned.best.score,
        threshold: DELIVERABLE_SCORE,
        shapeName,
        placeText,
      });
      const reply = [
        intent.reply,
        placeNote,
        `${placeText}画得出可走的「${shapeName}」路线，但路线贴合最高也只有 ${planned.best.score} 分（不够像），没有硬画——画出来你也不会满意。`,
        '换个地点（路网方正的商圈更容易）、或直接指定更大的尺寸（如"画个 2 公里的星"）再试。',
      ]
        .filter(Boolean)
        .join('\n');
      pushHistory(text, reply);
      return { reply, planned: { ...planned, status: 'failed' }, outline: outlinePreview };
    }

    // 显式约束闸门（方案 2026-11-08 §3.3）：绿线交付前比较"请求约束"与"最终候选实际值"。
    // 只比意图没有意义——必须比**实际产物**（历史缺陷：请求 800 米交付 6000 米、
    // 请求旋转 90° 精修后交付 100°）。约束不符时不得绿线：降级为橙色诊断参考并
    // 明确写出差异，只有用户确认后才允许改变约束并正式交付。
    if (planned.status === 'ok' && planned.best) {
      const compliance = evaluateConstraintContract(constraintContract, {
        sizeMeters: planned.best.sizeMeters,
        rotationDeg: planned.best.rotationDeg,
      });
      if (!compliance.ok) {
        log.warn('deliver.constraintViolation', {
          reason: '最终候选违反用户显式约束，不给绿线',
          violations: compliance.violations,
          requestedSizeMeters: constraintContract.size.requestedMeters,
          deliveredSizeMeters: planned.best.sizeMeters,
          requestedRotationDeg: constraintContract.rotation.requestedDeg,
          deliveredRotationDeg: planned.best.rotationDeg,
          score: planned.best.score,
        });
        if (planned.best?.result?.routeLatLngs?.length >= 2) {
          return deliverReference({
            text, signal, candidate: planned.best,
            commitOptions: { reference: true, score: planned.best.score, deliveredObjects: objectAudit.deliveredObjects },
            compose: () => composeConstraintViolationReply({
              intent,
              placeNote,
              placeText,
              candidate: planned.best,
              compliance,
              contract: constraintContract,
            }),
            planned: { ...planned, status: 'reference' },
            outline: outlinePreview,
          });
        }
        throwIfAborted(signal, '已停止');
        engine.clearDraw();
        const reply = [
          intent.reply,
          placeNote,
          `你要的${constraintContract.size.explicit ? ` ${constraintContract.size.requestedMeters} 米` : ''}` +
            `${constraintContract.rotation.explicit ? ` ${constraintContract.rotation.requestedDeg}° 朝向` : ''}` +
            `这一带画不出合格路线（${describeConstraintViolations(compliance.violations)}），没有硬画。`,
          '换个地点（路网方正的商圈更容易）或调整要求再试。',
        ]
          .filter(Boolean)
          .join('\n');
        pushHistory(text, reply);
        return { reply, planned: { ...planned, status: 'failed' }, outline: outlinePreview };
      }
    }

    // 画不出来：有"最像的一版"就画成橙色参考版（标注非合格），否则诚实失败
    if (planned.status === 'failed') {
      const fallback = planned.bestOverall || planned.best;
      // 退化候选防御：路线点 <2 无法成线（0 km），不提交橙色参考版，走诚实失败
      if (fallback?.result?.routeLatLngs?.length >= 2) {
        return deliverReference({
          text, signal, candidate: fallback,
          commitOptions: { reference: true, score: fallback.score, deliveredObjects: objectAudit?.deliveredObjects ?? [] },
          compose: () => composeReferenceReply({ intent, placeNote, candidate: fallback, reason: describeShortfall(fallback) }),
          planned: { ...planned, status: 'reference' },
          outline: outlinePreview,
          logEvent: 'deliver.reference',
          logPayload: { reason: '无达标候选，退回最像的一版（目标验收已通过，T 保持不变）', score: fallback.score, stage: planned.stage, stageLabel: planned.stageLabel, triedCount: planned.triedCount, targetVersion: target?.targetVersion ?? null, placeText },
        });
      }
      throwIfAborted(signal, '已停止');
      engine.clearDraw();
      log.warn('deliver.failed', { ...summarizePlanned(planned), placeText });
      // 地点解析失败回退视野中心时，明确说"当前视野"而不是用户要的地名
      const reply = composeFailureReply({ intent, escalation: planned, placeText, placeNote, placeSource });
      pushHistory(text, reply);
      return { reply, planned, outline: outlinePreview };
    }

    // 通过交付闸门（绿线 = 目标验收通过 + 路线验收通过）：先提交绘制（地图只画
    // 最终选定的这一版），再生成回复，保证"回复、指标、地图"三者一致
    throwIfAborted(signal, '已停止');
    const shape = engine.commitDraw(planned.result, {
      score: planned.best.score,
      // 结构化交付身份随图形快照一起留痕（方案 2026-11-08 §4.2）：
      // E2E 与生产共用同一份"实际交付对象"证据，不再靠拼接显示名反推。
      deliveredObjects: objectAudit.deliveredObjects,
    });

    // 画出来了：偏移超 800m 时找最近地标命名区域，回复里明说
    let areaName = null;
    if (planned.offset && planned.offset.meters > 800) {
      areaName = nearestPoi(planned.best.center, getCity().pois)?.poi?.name || null;
    }
    // 多比例尺候选池（需求 2026-11-09）：绿线交付后把本次规划全部可交付比例尺档
    // 挂成卡片池（不重搜：best + alternatives 即引擎达标池全量），供回复下方卡片点选切换
    buildScaleCandidatePool({
      planned,
      intent,
      target,
      constraintContract,
      objectAudit,
      placeNote,
      placeSource,
      trace,
    });
    // 备选保留（缺陷清单 Bug 5）：回复会承诺"想换这一版直接说"，系统必须能兑现——
    // 保存备选（含完整几何）与交付上下文，下一次输入命中切换短语时直接提交对应候选，
    // 不再重新 LLM 解析 + 全量重规划。无备选时清掉旧快照，避免过期承诺。
    if ((planned.alternatives || []).some((item) => item?.result?.routeLatLngs?.length >= 2)) {
      setPendingAlternative({
        best: planned.best,
        alternatives: planned.alternatives.filter((item) => item?.result?.routeLatLngs?.length >= 2),
        // 承诺版本：回复文案里"另有一版…"列出的那一版（pickPromisedAlternative 同源）。
        // 用户照做切换时优先交付它——不是方向极值（复核发现承诺 7.2km 实际切到 0.9km）
        promised: pickPromisedAlternative(planned.best, planned.alternatives),
        intent: JSON.parse(JSON.stringify({ ...intent, customShape: target?.customShape ?? intent.customShape ?? null })),
        placeNote,
        placeSource,
        offset: planned.offset,
        nearBest: planned.nearBest,
        stage: planned.stage,
        refined: planned.refined === true,
        at: Date.now(),
      });
    } else {
      setPendingAlternative(null);
    }
    const reply = composeReply({
      intent,
      result: planned.result,
      best: planned.best,
      placeNote,
      placeSource,
      nearBest: planned.nearBest,
      offset: planned.offset,
      areaName,
      stage: planned.stage,
      alternatives: planned.alternatives || [],
      suppressIntentReply: objectAudit.checked && !objectAudit.ok,
      refined: planned.refined === true,
      scaleCardCount: getScaleCandidatePool() ? getScaleCandidatePool().cards.length : 0,
    });
    pushHistory(text, reply);
    log.info('plan.delivered', {
      score: planned.best.score,
      stage: planned.stage,
      stageLabel: planned.stageLabel,
      triedCount: planned.triedCount,
      offsetMeters: planned.offset ? Math.round(planned.offset.meters) : 0,
      areaName,
      targetVerdict: target?.acceptance?.verdict ?? null,
      targetVersion: target?.targetVersion ?? null,
      // 实际交付对象（结构化身份，一一对应可核对；方案 2026-11-08 §4.2）
      deliveredObjects: objectAudit.deliveredObjects,
      requestedObjects: objectAudit.requested.map((item) => item.name),
      missingObjects: objectAudit.missing.map((item) => item.name),
      reply,
    });
    return { reply, planned, outline: outlinePreview, shape };
  }

  return { executePlan };
}
