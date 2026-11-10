/**
 * 智能体消息区的卡片渲染（从 ui.js 拆出，C1 纯移动：字段映射/文案/DOM 结构未改）。
 *
 * 职责：
 * - 多比例尺候选卡片行（appendScaleCards / renderScaleCard）：按尺寸升序展示、
 *   当前交付版选中标识、活池可点切换、失效轮静态灰卡；
 * - 参考候选卡（renderPendingReferenceChoice / renderReferenceCard）：待选快照渲染、
 *   来源/许可徽标、署名外链。
 *
 * 依赖约定：不持有可变状态，也不直接访问 controller/store；面板状态与交互回调
 * 由 ui.js 通过显式 `deps` 注入（禁止模块级全局变量）：
 * - appendScaleCards(item, message, { state, switchScale, formatMinutes })
 * - renderScaleCard(message, card, live, 同上)
 * - renderPendingReferenceChoice(messagesEl, choice, { state, selectReferenceCandidate, scrollToBottom })
 * - renderReferenceCard(choice, candidate, { state, selectReferenceCandidate })
 */

import { renderOutlineDataUrl } from './shape-review.js';
import { SCALE_OFFSET_NOTE_METERS, scaleCardOffsetMeters } from './scale-candidates.js';
import { createCardShell } from './ui-render.js';

/**
 * 追加多比例尺候选卡片行（需求 2026-11-09，方案 §4）：
 * 本次规划所有可交付比例尺档按尺寸升序展示，当前交付版有选中标识。
 * 活池（state.pendingScalePool.poolId 匹配）时卡片可点、点击切换交付；
 * 否则（历史轮/刷新后/新输入后/发送中）静态灰卡，点了无反应、不报错。
 *
 * @param {HTMLElement} item 消息节点（拥有 scaleCandidates 字段的智能体回复）
 * @param {object} message 消息记录
 * @param {{state: object, switchScale: Function, formatMinutes: Function}} deps 显式依赖（装配时注入）
 */
export function appendScaleCards(item, message, deps) {
  const cards = message.scaleCandidates ?? [];
  if (cards.length < 2) {
    return;
  }
  const pool = deps.state.pendingScalePool;
  const live = Boolean(pool && pool.poolId === message.scalePoolId);
  const row = document.createElement('div');
  row.className = live ? 'agent-scale-cards is-live' : 'agent-scale-cards is-stale';
  const caption = document.createElement('div');
  caption.className = 'agent-scale-caption';
  const shapeLabel = pool?.poolId === message.scalePoolId ? pool.shapeName : null;
  caption.textContent =
    `${shapeLabel ? `「${shapeLabel}」· ` : ''}本次实测 ${cards.length} 个比例尺` +
    (Number.isFinite(message.scaleHiddenCount) && message.scaleHiddenCount > 0
      ? `，还有 ${message.scaleHiddenCount} 档未展示`
      : '') +
    (live ? '' : '（该轮候选已失效，仅回顾）');
  row.appendChild(caption);
  for (const card of cards) {
    row.appendChild(renderScaleCard(message, card, live, deps));
  }
  item.appendChild(row);
}

/**
 * 构建一张比例尺卡片按钮：主行尺寸 + 路线贴合，次行里程/用时，
 * 可选行贴合偏差/覆盖顶点/关键特征/中心偏移——只展示已有指标，不编造数值。
 *
 * @param {object} message 拥有卡片行的消息（活态判定与失效提示用）
 * @param {object} card 卡片摘要（消息持久化形态，无几何）
 * @param {boolean} live 是否可点（当前活跃池）
 * @param {{state: object, switchScale: Function, formatMinutes: Function}} deps 显式依赖（装配时注入）
 * @returns {HTMLButtonElement} 卡片按钮
 */
export function renderScaleCard(message, card, live, deps) {
  const pool = deps.state.pendingScalePool;
  const currentCardId = live ? pool?.currentCardId : message.scaleCurrentCardId;
  const isCurrent = card.id === currentCardId;
  const cardEl = createCardShell({
    className: isCurrent ? 'agent-scale-card is-current' : 'agent-scale-card',
    disabled: !live || deps.state.sending,
    title: live ? null : '该轮候选已失效，仅回顾',
    onClick: live ? () => void deps.switchScale(message, card) : null,
  });
  const sizeLine = document.createElement('span');
  sizeLine.className = 'agent-scale-size';
  const sizeText = document.createElement('b');
  sizeText.textContent = `${(card.sizeMeters / 1000).toFixed(1)} km`;
  sizeLine.appendChild(sizeText);
  if (isCurrent) {
    const badge = document.createElement('span');
    badge.className = 'agent-scale-badge';
    badge.textContent = '当前';
    sizeLine.appendChild(badge);
  }
  cardEl.appendChild(sizeLine);
  const mainLine = document.createElement('span');
  mainLine.className = 'agent-scale-line';
  mainLine.textContent = `路线贴合 ${card.score}`;
  cardEl.appendChild(mainLine);
  const metaParts = [];
  if (Number.isFinite(card.routeMeters)) {
    metaParts.push(`里程 ${(card.routeMeters / 1000).toFixed(2)} km`);
  }
  if (Number.isFinite(card.walkMinutes)) {
    metaParts.push(`约 ${deps.formatMinutes(card.walkMinutes)}`);
  }
  if (metaParts.length > 0) {
    const metaLine = document.createElement('span');
    metaLine.className = 'agent-scale-line is-meta';
    metaLine.textContent = metaParts.join(' · ');
    cardEl.appendChild(metaLine);
  }
  const auxParts = [];
  if (Number.isFinite(card.meanMeters) && Number.isFinite(card.maxMeters)) {
    auxParts.push(`贴合 平均 ${Math.round(card.meanMeters)} / 最大 ${Math.round(card.maxMeters)} m`);
  }
  if (Number.isFinite(card.coverage)) {
    auxParts.push(card.coverage >= 100 ? '覆盖全部顶点' : `覆盖 ${card.coverage.toFixed(0)}% 顶点`);
  }
  if (Number.isFinite(card.featureCount) && card.featureCount > 0) {
    auxParts.push(`关键特征 ${card.featureCoveredCount}/${card.featureCount} 走出`);
  }
  if (auxParts.length > 0) {
    const auxLine = document.createElement('span');
    auxLine.className = 'agent-scale-line is-aux';
    auxLine.textContent = auxParts.join(' · ');
    cardEl.appendChild(auxLine);
  }
  // 中心偏移（>800m 才说，沿用现有偏移说明口径）：与当前版比，切换后随当前版更新
  const currentCard = live && pool
    ? pool.cards.find((item) => item.id === pool.currentCardId)
    : null;
  const offsetMeters = currentCard ? scaleCardOffsetMeters(card, currentCard) : null;
  if (Number.isFinite(offsetMeters) && offsetMeters > SCALE_OFFSET_NOTE_METERS) {
    const offsetLine = document.createElement('span');
    offsetLine.className = 'agent-scale-line is-offset';
    offsetLine.textContent = `中心偏移约 ${(offsetMeters / 1000).toFixed(1)} km`;
    cardEl.appendChild(offsetLine);
  }
  return cardEl;
}

/**
 * 渲染待选参考候选卡（方案 §6.4，与 pending guide 分开渲染）：
 * 卡片展示实际归一化 T（不保存 base64 候选图，刷新后按待选几何重渲染）、
 * 名称/姿态、点数、来源/许可（本地精选 / 在线未审核），CC-BY 可查看署名。
 *
 * @param {HTMLElement} messagesEl 消息区容器
 * @param {object|null} choice 待选快照（context.referenceChoice）
 * @param {{state: object, selectReferenceCandidate: Function, scrollToBottom: Function}} deps 显式依赖（装配时注入）
 */
export function renderPendingReferenceChoice(messagesEl, choice, deps) {
  // 移除旧的可点候选行（避免和新的叠成两套）
  messagesEl.querySelectorAll('.agent-reference-choice.is-live').forEach((el) => el.remove());
  if (
    !choice
    || choice.status !== 'awaiting-selection'
    || !Array.isArray(choice.candidates)
    || choice.candidates.length === 0
  ) {
    return;
  }
  const row = document.createElement('div');
  row.className = 'agent-reference-choice is-live';
  for (const candidate of choice.candidates) {
    row.appendChild(renderReferenceCard(choice, candidate, deps));
  }
  messagesEl.appendChild(row);
  deps.scrollToBottom();
}

/**
 * 构建单个候选卡（点击 → reference-selection 消息 + chooseReferenceCandidate）。
 *
 * @param {object} choice 待选快照
 * @param {object} candidate 候选
 * @param {{state: object, selectReferenceCandidate: Function}} deps 显式依赖（装配时注入）
 * @returns {HTMLButtonElement} 候选卡按钮
 */
export function renderReferenceCard(choice, candidate, deps) {
  const name = candidate.asset?.displayName || candidate.asset?.names?.zh?.[0] || '图形';
  const tags = Array.isArray(candidate.asset?.tags) && candidate.asset.tags.length
    ? candidate.asset.tags.join(' · ')
    : null;
  const pointCount = candidate.customShape?.outlinePoints?.length ?? 0;
  const freeform = candidate.origin === 'freeform' || candidate.reviewStatus === 'freeform-reviewed';
  const curated = !freeform && (candidate.origin === 'local' || candidate.reviewStatus === 'curated');
  const license = candidate.asset?.source?.license || null;
  const attribution = candidate.asset?.source?.attribution || null;
  const sourceUrl = candidate.asset?.source?.url || null;
  const card = createCardShell({
    className: 'agent-ref-card',
    disabled: deps.state.sending,
    onClick: () => void deps.selectReferenceCandidate(choice, candidate, name),
  });
  const badge = document.createElement('span');
  badge.className = `agent-ref-badge ${freeform ? 'is-freeform' : curated ? 'is-curated' : 'is-unreviewed'}`;
  badge.textContent = freeform ? '自由轮廓 · 已质检' : curated ? '本地精选' : '在线未审核';
  const img = document.createElement('img');
  const dataUrl = renderOutlineDataUrl(candidate.customShape, { size: 120 });
  if (dataUrl) {
    img.src = dataUrl;
  }
  img.alt = `候选目标轮廓：${name}`;
  const nameEl = document.createElement('span');
  nameEl.className = 'agent-ref-name';
  nameEl.textContent = name;
  const meta = document.createElement('span');
  meta.className = 'agent-ref-meta';
  // 自由轮廓候选没有素材许可字段：标注"已过视觉质检"（方案 2026-11-01 §2/§3）
  meta.textContent = freeform
    ? `${pointCount} 点 · 已过视觉质检`
    : `${pointCount} 点 · ${license || '许可见来源'}`;
  card.append(badge, img, nameEl);
  if (tags) {
    const tagsEl = document.createElement('span');
    tagsEl.className = 'agent-ref-tags';
    tagsEl.textContent = tags;
    card.appendChild(tagsEl);
  }
  card.appendChild(meta);
  // 在线候选=署名入口、本地精选=来源入口（点击卡片=选择；外链阻止冒泡单独打开）
  if (attribution && sourceUrl) {
    const link = document.createElement('a');
    link.className = 'agent-ref-attribution';
    link.textContent = `${curated ? '来源' : '署名'}：${attribution}`;
    link.href = sourceUrl;
    link.target = '_blank';
    link.rel = 'noreferrer noopener';
    link.addEventListener('click', (event) => event.stopPropagation());
    card.appendChild(link);
  }
  return card;
}
