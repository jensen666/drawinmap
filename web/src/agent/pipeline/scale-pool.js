/**
 * 多比例尺候选池生命周期（C4 拆分自 controller.js）：池构建/视图/绑定消息/
 * 卡片点选切换/备选快照重建，以及弃池清理。
 *
 * 边界：三套待交付状态（referenceChoice/pendingAlternative/scaleCandidatePool）的
 * 可变存储仍在 controller.js，本模块通过访问器读写；文案与 toast 单源不变。
 */

import {
  SCALE_CANDIDATE_DISPLAY_LIMIT,
  buildScaleCard,
  buildScaleCardSummary,
  buildScaleCards,
  isDeliverableScaleCandidate,
  reapplyDisplayLimit,
} from '../scale-candidates.js';
import { createId } from '../../log/core.js';
import { buildOutlinePreview } from './deliver.js';

/**
 * 创建多比例尺候选池运行时（可变状态用访问器注入）。
 *
 * @param {object} deps 依赖
 * @param {object} deps.engine 引擎（点选切换时 commitDraw）
 * @param {{info: Function, warn: Function}} deps.log 日志器
 * @param {(intent: object) => string|null} deps.shapeNameOf 图形显示名
 * @param {(best: object, alternatives: Array<object>) => object|null} deps.pickPromisedAlternative 承诺备选挑选
 * @param {() => object|null} deps.getPendingAlternative 取待切换备选
 * @param {(value: object|null) => void} deps.setPendingAlternative 写待切换备选
 * @param {() => object|null} deps.getScaleCandidatePool 取多比例尺池
 * @param {(value: object|null) => void} deps.setScaleCandidatePool 写多比例尺池
 * @returns {object} 池生命周期函数集合
 */
export function createScalePool({
  engine,
  log,
  shapeNameOf,
  pickPromisedAlternative,
  getPendingAlternative,
  setPendingAlternative,
  getScaleCandidatePool,
  setScaleCandidatePool,
}) {
  /** 丢弃待切换备选（新输入/切会话时；当轮已交付的绿线不受影响） */
  function discardPendingAlternative(reason) {
    const current = getPendingAlternative();
    if (current) {
      log.info('deliver.alternativeSwitch.discarded', {
        reason,
        currentSizeMeters: current.best?.sizeMeters ?? null,
      });
      setPendingAlternative(null);
    }
  }

  /** 丢弃多比例尺候选池（新输入/切会话/切城市时；当轮已交付的绿线不受影响）。
   *  消息里的卡片摘要随 renderAll 变回静态灰卡，不可点、不报错。 */
  function discardScaleCandidates(reason) {
    const current = getScaleCandidatePool();
    if (current) {
      log.info('deliver.scalePool.discarded', {
        reason,
        poolId: current.poolId,
        currentSizeMeters: current.cards.find((card) => card.id === current.currentCardId)?.sizeMeters ?? null,
      });
    }
    setScaleCandidatePool(null);
  }

  /** 池的对外视图（消息摘要形态）：不含路线几何，供 UI 渲染与消息落盘 */
  function scalePoolView(pool) {
    if (!pool) {
      return null;
    }
    return {
      poolId: pool.poolId,
      traceId: pool.traceId,
      ownerMessageId: pool.ownerMessageId,
      shapeName: pool.shapeName,
      currentCardId: pool.currentCardId,
      hiddenCount: pool.hiddenCount,
      cards: pool.cards.map((card) => buildScaleCardSummary(card)),
    };
  }

  /** 当前池视图（send/chooseReferenceCandidate 返回值统一带出，null = 无活池） */
  function currentScalePoolView() {
    return scalePoolView(getScaleCandidatePool());
  }

  /**
   * 绿线交付后构建多比例尺候选池（需求 R1/R4）：best + alternatives 即本次规划
   * 完整达标候选池（引擎达标池全量透出，不重搜），按比例尺去重、升序、截断。
   * 档位数 < 2 不建池（单档无可选，按现状交付；橙版/诚实失败路径不走这里）。
   */
  function buildScaleCandidatePool({ planned: delivery, intent: poolIntent, target: deliveryTarget, constraintContract, objectAudit, placeNote: deliveryPlaceNote, placeSource: deliveryPlaceSource, trace: deliveryTrace }) {
    // 防御性清理：正常流程新输入时已丢弃，这里保证池永远只属于最近一次绿线交付
    discardScaleCandidates('rebuild');
    const { cards, hiddenCount, rawCount, tierCount } = buildScaleCards({
      candidates: [delivery.best, ...(delivery.alternatives || [])],
      constraintContract,
      current: delivery.best,
    });
    if (cards.length < 2) {
      log.info('deliver.scalePool.skipped', {
        reason: 'single-deliverable-tier',
        tierCount: cards.length,
        rawCount,
      });
      return;
    }
    const pool = {
      poolId: createId('scp'),
      traceId: deliveryTrace.id,
      ownerMessageId: null,
      shapeName: shapeNameOf(poolIntent) ?? '图形',
      cards,
      currentCardId: cards.find((card) => card.result === delivery.best.result)?.id ?? cards[0].id,
      hiddenCount,
      rawCount,
      tierCount,
      intent: JSON.parse(JSON.stringify({ ...poolIntent, customShape: deliveryTarget?.customShape ?? poolIntent.customShape ?? null })),
      contract: constraintContract,
      deliveredObjects: objectAudit?.deliveredObjects ?? [],
      placeNote: deliveryPlaceNote,
      placeSource: deliveryPlaceSource,
      offset: delivery.offset,
      nearBest: delivery.nearBest,
      stage: delivery.stage,
      refined: delivery.refined === true,
      at: Date.now(),
    };
    setScaleCandidatePool(pool);
    // E2E"四个数字"取证（需求 §5.4）：原始候选数/档位数/展示数/未展示数都在这一条
    log.info('deliver.scalePool', {
      poolId: pool.poolId,
      rawCount,
      tierCount,
      shownCount: cards.length,
      hiddenCount,
      limit: SCALE_CANDIDATE_DISPLAY_LIMIT,
      currentSizeMeters: delivery.best.sizeMeters,
      sizes: cards.map((card) => Math.round(card.sizeMeters)),
    });
  }

  /** 池内 intent 深拷贝在 buildScaleCandidatePool 内完成（intent 是 handleSend 局部量，参数传入） */

  /** 绑定池的归属消息（UI 在回复消息落盘后调用）：卡片行渲染在该消息内 */
  function attachScalePoolMessage(poolId, messageId) {
    const pool = getScaleCandidatePool();
    if (!pool || pool.poolId !== poolId || typeof messageId !== 'string' || !messageId) {
      return currentScalePoolView();
    }
    if (!pool.ownerMessageId) {
      pool.ownerMessageId = messageId;
    }
    return currentScalePoolView();
  }

  /** 卡片 → 备选切换候选形态（deliverAlternativeSwitch / pendingAlternative 用） */
  function cardToAlternative(card) {
    return {
      result: card.result,
      score: card.score,
      adjustedScore: null,
      center: card.center,
      sizeMeters: card.sizeMeters,
      rotationDeg: card.rotationDeg,
      stage: null,
      stageLabel: null,
    };
  }

  /** 用池重建待切换备选快照：点选切换后"要大一点/小一点的那版"继续可用且方向正确 */
  function rebuildPendingAlternativeFromPool(pool, currentCard) {
    const best = cardToAlternative(currentCard);
    const alternatives = pool.cards.filter((card) => card.id !== currentCard.id).map(cardToAlternative);
    setPendingAlternative({
      best,
      alternatives,
      promised: pickPromisedAlternative(best, alternatives),
      intent: pool.intent,
      placeNote: pool.placeNote,
      placeSource: pool.placeSource,
      offset: pool.offset,
      nearBest: pool.nearBest,
      stage: pool.stage,
      refined: pool.refined === true,
      at: Date.now(),
    });
  }

  /** 文字切换交付后同步池：改当前版；切到被截断隐藏的档位时补建卡片并重新截断 */
  function syncScalePoolAfterSwitch(candidate) {
    const pool = getScaleCandidatePool();
    if (!pool || !candidate?.result) {
      return;
    }
    let card = pool.cards.find((item) => item.result === candidate.result);
    if (!card) {
      card = buildScaleCard(candidate, createId('sc'));
      const sameTierIndex = pool.cards.findIndex(
        (item) => Math.round(item.sizeMeters / 10) === Math.round(candidate.sizeMeters / 10),
      );
      if (sameTierIndex >= 0) {
        pool.cards.splice(sameTierIndex, 1, card);
      } else {
        pool.cards.push(card);
      }
    }
    pool.currentCardId = card.id;
    const limited = reapplyDisplayLimit(pool.cards, card.id);
    pool.cards = limited.cards;
    pool.hiddenCount = limited.hiddenCount;
    log.info('deliver.scalePool.synced', {
      poolId: pool.poolId,
      currentSizeMeters: candidate.sizeMeters,
      shownCount: pool.cards.length,
      hiddenCount: pool.hiddenCount,
    });
  }

  /**
   * 点选比例尺卡片切换（需求 R2）：不调 LLM、不重新规划，直接提交池内对应候选。
   * 切换前按原交付标准复核（60 分闸门 + 质量门槛 + 显式约束契约，与备选切换同口径）；
   * 点当前版不重绘、明确提示。切换后地图/卡片状态/历史图形三处指向同一版。
   *
   * 文案单源（B2 S7）：本函数**只返回数据**，不构造回复、不写对话历史——
   * 点选是本地状态机交互（UI 不产生对话消息），提示文案统一由 `scale-notice.js`
   * 的 toast 摘要生成（`formatScaleSwitchNotice` / `formatScaleCurrentNotice` /
   * `SCALE_SWITCH_REFUSED_NOTICE`），避免 controller/templates 双源漂移。
   *
   * @param {{poolId: string, cardId: string}} selection 卡片点选
   * @returns {{ok: boolean, reason?: string, alreadyCurrent?: boolean, refused?: boolean,
   *   traceId?: string, shape?: object, outline?: object, cardId?: string,
   *   scalePool: object|null}} 切换结果（无 reply 字段）
   */
  function switchScaleCandidate({ poolId, cardId }) {
    const pool = getScaleCandidatePool();
    if (!pool || pool.poolId !== poolId) {
      return { ok: false, reason: 'pool-gone', scalePool: null };
    }
    const card = pool.cards.find((item) => item.id === cardId);
    if (!card) {
      return { ok: false, reason: 'card-gone', scalePool: scalePoolView(pool) };
    }
    const currentCard = pool.cards.find((item) => item.id === pool.currentCardId) ?? null;
    if (card.id === pool.currentCardId) {
      log.info('deliver.scaleSwitch.current', {
        poolId,
        cardId,
        sizeMeters: card.sizeMeters,
        score: card.score,
      });
      return {
        ok: true,
        alreadyCurrent: true,
        traceId: pool.traceId,
        scalePool: scalePoolView(pool),
      };
    }
    // 切换前复核（需求 R2"按原交付标准复核"）：池构建时已过滤，这里是防御性再核
    if (!isDeliverableScaleCandidate(card, pool.contract)) {
      log.warn('deliver.scaleSwitch.refused', {
        poolId,
        cardId,
        sizeMeters: card.sizeMeters,
        score: card.score,
      });
      return {
        ok: true,
        alreadyCurrent: false,
        refused: true,
        traceId: pool.traceId,
        scalePool: scalePoolView(pool),
      };
    }
    const shape = engine.commitDraw(card.result, {
      score: card.score,
      deliveredObjects: pool.deliveredObjects,
    });
    log.info('deliver.scaleSwitched', {
      poolId,
      cardId,
      noReplan: true,
      from: currentCard
        ? { sizeMeters: currentCard.sizeMeters, score: currentCard.score }
        : null,
      to: { sizeMeters: card.sizeMeters, score: card.score, rotationDeg: card.rotationDeg ?? null },
    });
    pool.currentCardId = card.id;
    const limited = reapplyDisplayLimit(pool.cards, card.id);
    pool.cards = limited.cards;
    pool.hiddenCount = limited.hiddenCount;
    rebuildPendingAlternativeFromPool(pool, card);
    const outlinePreview = buildOutlinePreview({
      customShape: pool.intent.customShape ?? null,
      shapeKey: pool.intent.shapeKey ?? null,
      referenceSource: pool.intent.referenceSource || null,
      rotationDeg: card.rotationDeg ?? null,
    });
    return {
      ok: true,
      alreadyCurrent: false,
      traceId: pool.traceId,
      shape,
      outline: outlinePreview,
      cardId: card.id,
      scalePool: scalePoolView(pool),
    };
  }


  return {
    discardPendingAlternative,
    discardScaleCandidates,
    scalePoolView,
    currentScalePoolView,
    buildScaleCandidatePool,
    attachScalePoolMessage,
    cardToAlternative,
    rebuildPendingAlternativeFromPool,
    syncScalePoolAfterSwitch,
    switchScaleCandidate,
  };
}
