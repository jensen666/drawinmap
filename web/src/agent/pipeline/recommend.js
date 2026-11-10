/**
 * recommend 通道（C4 拆分自 controller.js）：executeRecommend 的完整编排
 * （地点解析 → 推荐引擎 → 交付闸门/参考版/失败 → 绿线交付 → 回复）。
 *
 * 依赖显式注入；行为与拆分前逐行一致。
 */

import { DELIVERABLE_SCORE } from '../../engine/quality.js';
import { DEFAULT_SIZE_METERS } from '../intent.js';
import { createLogger } from '../../log/index.js';
import { throwIfAborted } from '../../cancel.js';
import { ROUND_TIME_BUDGET_MS } from './shared.js';
import { buildOutlinePreview, placeTextOf, summarizePlanned } from './deliver.js';

/** 模块 logger：与 controller 同 label（日志归属口径不变） */
const log = createLogger('agent');

/**
 * 创建 recommend 通道运行时。
 *
 * @param {object} deps 依赖
 * @param {object} deps.engine 图形引擎
 * @param {{info: Function, warn: Function, error: Function}} deps.log 日志器
 * @param {(userText: string, assistantText: string) => void} deps.pushHistory 写对话历史
 * @param {object} deps.matching 地点配置的匹配策略
 * @param {Array<string>} deps.recommendShapeKeys 推荐链路的内置图形列表
 * @param {object} deps.replyTemplates 回复模板集合
 * @param {object} deps.runtime 交付/地点/核对 runtime
 *   { deliverReference, askUnresolvedPlace, resolvePlaceToCenter, auditDeliveryObjects }
 * @returns {{executeRecommend: Function}}
 */
export function createRecommendRuntime({
  engine,
  pushHistory,
  matching,
  recommendShapeKeys,
  replyTemplates,
  runtime,
}) {
  const {
    composeReferenceReply,
    composeRecommendReply,
    composeRecommendFailureReply,
    describeShortfall,
  } = replyTemplates;
  const { deliverReference, askUnresolvedPlace, resolvePlaceToCenter, auditDeliveryObjects } = runtime;

  async function executeRecommend(intent, text, onProgress, trace, signal = null, { requestText = null } = {}) {
    // 整轮截止：粗搜 + 三图形精修共享
    const roundDeadline = performance.now() + ROUND_TIME_BUDGET_MS;
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

    // 各图形统一以默认尺寸为搜索基准，档位由全阶梯（0.5~3×）实测自选
    const shapeSizes = {};
    for (const key of recommendShapeKeys) {
      shapeSizes[key] = DEFAULT_SIZE_METERS;
    }
    onProgress({
      text: `基准尺寸 ${DEFAULT_SIZE_METERS}m（全尺寸阶梯 0.5~7.5× 实测自选）`,
      kind: 'step',
    });

    log.info('recommend.request', { center, shapeSizes, allowEnlarge: true });
    let outcome;
    try {
      outcome = await trace.withSpan(
        'engine.recommend',
        () =>
          engine.recommend({
            center,
            shapeSizes,
            allowEnlarge: true,
            deadline: roundDeadline,
            signal,
            onProgress: (p) =>
              onProgress({
                text: `${p.stageLabel || '搜索'}·${p.shapeName || ''} ${p.done}/${p.total}`,
                kind: 'progress',
              }),
          }),
        { center, shapeSizes },
      );
    } catch (error) {
      log.error('recommend.failed', { center, shapeSizes }, error);
      throw new Error(`路线规划失败：${error.message}`);
    }
    if (outcome.status === 'ok') {
      const d = outcome.drawn;
      onProgress({
        text: `选定：${d.shapeName} · 路线贴合 ${d.score} · 尺寸 ${d.sizeMeters}m · 朝向 ${d.rotationDeg}°`,
        kind: 'step',
      });
    }
    log.info('recommend.result', summarizePlanned(outcome));

    const placeText = placeTextOf(center, intent.place);
    if (outcome.status === 'failed') {
      // 推荐链路同样支持"最像的一版参考版"：从各图形 bests 里取评分最高者
      let fallback = null;
      for (const candidate of Object.values(outcome.bests || {})) {
        if (candidate?.result?.routeLatLngs?.length > 0 && (!fallback || candidate.score > fallback.score)) {
          fallback = candidate;
        }
      }
      // bests 候选未带 shapeKey（按 key 记录），反查兜底图形用于点序列图
      const fallbackShapeKey = fallback
        ? Object.keys(outcome.bests || {}).find((key) => outcome.bests[key] === fallback) || null
        : null;
      if (fallback) {
        // 交付对象一致性审计（推荐链路此前误引用 executePlan 作用域内的 objectAudit，
        // 触发未声明变量 ReferenceError；此处按推荐链路自身的语义重算：推荐无显式目标，
        // target 恒为 null）。
        const objectAudit = auditDeliveryObjects({ intent, target: null });
        return deliverReference({
          text, signal, candidate: fallback,
          commitOptions: { reference: true, score: fallback.score, deliveredObjects: objectAudit?.deliveredObjects ?? [] },
          compose: () => composeReferenceReply({ intent, placeNote, candidate: fallback, reason: describeShortfall(fallback) }),
          planned: { ...outcome, status: 'reference' },
          outline: buildOutlinePreview({ customShape: null, shapeKey: fallbackShapeKey, rotationDeg: fallback?.rotationDeg ?? null }),
          logEvent: 'deliver.reference',
          logPayload: { reason: '推荐无达标候选，退回最像的一版', score: fallback.score, stage: outcome.stage, stageLabel: outcome.stageLabel, triedCount: outcome.triedCount, placeText },
        });
      }
      throwIfAborted(signal, '已停止');
      engine.clearDraw();
      const reply = composeRecommendFailureReply({ intent, outcome, placeText, placeNote, placeSource });
      pushHistory(text, reply);
      return { reply, planned: outcome };
    }
    // 交付闸门：推荐链路与 plan 链路使用同一个 DELIVERABLE_SCORE，避免
    // "单图形 50 分拒绝、推荐 50 分却画出来"的规则不一致
    if (outcome.drawn.score < DELIVERABLE_SCORE) {
      if (outcome.drawn?.result?.routeLatLngs?.length > 0) {
        return deliverReference({
          text, signal, candidate: outcome.drawn,
          compose: () => composeReferenceReply({ intent, placeNote, candidate: outcome.drawn, reason: describeShortfall(outcome.drawn) }),
          planned: { ...outcome, status: 'reference' },
          outline: buildOutlinePreview({ customShape: null, shapeKey: outcome.drawn.shapeKey, rotationDeg: outcome.drawn.rotationDeg ?? null }),
          logEvent: 'deliver.reference',
          logPayload: { reason: '推荐候选评分低于交付闸门', score: outcome.drawn.score, threshold: DELIVERABLE_SCORE, shapeName: outcome.drawn.shapeName, placeText },
        });
      }
      throwIfAborted(signal, '已停止');
      engine.clearDraw();
      const shapeName = outcome.drawn.shapeName;
      log.warn('deliver.rejected', {
        reason: '推荐候选评分低于交付闸门且无可用候选',
        score: outcome.drawn.score,
        threshold: DELIVERABLE_SCORE,
        shapeName,
        placeText,
      });
      const reply = [
        intent.reply,
        placeNote,
        `${placeText}实测下来，最像的「${shapeName}」路线贴合也只有 ${outcome.drawn.score} 分（不够像），没有硬画——画出来你也不会满意。`,
        '换个地点（路网方正的商圈更容易）或换个图形再试试。',
      ]
        .filter(Boolean)
        .join('\n');
      pushHistory(text, reply);
      return { reply, planned: { ...outcome, status: 'failed' }, outline: buildOutlinePreview({ customShape: null, shapeKey: outcome.drawn.shapeKey, rotationDeg: outcome.drawn.rotationDeg ?? null }) };
    }
    // 通过交付闸门：只绘制最终选定的这一个候选（搜索阶段无副作用）
    throwIfAborted(signal, '已停止');
    const shape = engine.commitDraw(outcome.drawn.result, { score: outcome.drawn.score });
    const reply = composeRecommendReply({ intent, outcome, placeNote, placeSource });
    pushHistory(text, reply);
    return {
      reply,
      planned: outcome,
      outline: buildOutlinePreview({ customShape: null, shapeKey: outcome.drawn.shapeKey, rotationDeg: outcome.drawn.rotationDeg ?? null }),
      shape,
    };
  }

  return { executeRecommend };
}
