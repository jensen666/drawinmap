/**
 * 多比例尺卡片点选的用户可见提示文案（纯函数、无 DOM、无副作用）。
 *
 * 背景（交互修正 2026-11-09）：点选卡片属于"就地切换"操作，不再往对话流追加
 * "点选 X km 卡片"用户消息与切换回复；切换结果改用面板轻提示即时告知，消息区
 * 滚动位置保持不动。提示里的数字与卡片/交付回复同源，缺失项不编造。
 */

/**
 * 比例尺文本（一位小数 km，与卡片展示口径一致）。
 *
 * @param {number} sizeMeters 目标尺寸（米）
 * @returns {string} 文本（非法值返回空串）
 */
function formatSizeKm(sizeMeters) {
  const meters = Number(sizeMeters);
  if (!Number.isFinite(meters)) {
    return '';
  }
  return `${(meters / 1000).toFixed(1)} km`;
}

/**
 * 成功切换提示：`已切换到 1.5 km 版 · 里程 6.45 km · 约 1 小时 26 分 · 路线贴合 65`。
 *
 * @param {object} card 卡片摘要（sizeMeters 必填；routeMeters/walkMinutes/score 可选）
 * @param {(minutes: number) => string} [formatMinutes] 时长格式化（与引擎回复同一口径）
 * @returns {string} 提示文本
 */
export function formatScaleSwitchNotice(card, formatMinutes) {
  const parts = [];
  const size = formatSizeKm(card?.sizeMeters);
  parts.push(size ? `已切换到 ${size} 版` : '已切换到该版');
  if (Number.isFinite(card?.routeMeters)) {
    parts.push(`里程 ${(card.routeMeters / 1000).toFixed(2)} km`);
  }
  if (Number.isFinite(card?.walkMinutes)) {
    const duration = typeof formatMinutes === 'function'
      ? formatMinutes(card.walkMinutes)
      : `${Math.round(card.walkMinutes)} 分钟`;
    if (duration) {
      parts.push(`约 ${duration}`);
    }
  }
  if (Number.isFinite(card?.score)) {
    parts.push(`路线贴合 ${card.score}`);
  }
  return parts.join(' · ');
}

/**
 * 点当前版提示（控制器不重绘，只确认状态）：`当前就是这一版（1.5 km · 路线贴合 65），地图没有重画`。
 *
 * @param {object} card 卡片摘要（sizeMeters/score 可选）
 * @returns {string} 提示文本
 */
export function formatScaleCurrentNotice(card) {
  const details = [];
  const size = formatSizeKm(card?.sizeMeters);
  if (size) {
    details.push(size);
  }
  if (Number.isFinite(card?.score)) {
    details.push(`路线贴合 ${card.score}`);
  }
  const suffix = details.length > 0 ? `（${details.join(' · ')}）` : '';
  return `当前就是这一版${suffix}，地图没有重画`;
}

/** 候选池在点击间隙失效（新输入/切会话/切城市等）：如实说明，不报未捕获错误 */
export const SCALE_POOL_STALE_NOTICE = '该轮的比例尺候选已失效（新输入/切换会话或城市后不可再切换），重新发一次规划请求即可。';

/** 切换前复核未过原交付标准：说明并保持当前版不变 */
export const SCALE_SWITCH_REFUSED_NOTICE = '那一版复核没有过交付标准，保持当前版不变。';
