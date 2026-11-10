/**
 * 引导选项的展示判定（纯函数，不碰 DOM）。
 *
 * 同一组选项只出现一处：
 * - 还在等用户选、且就是当前待补引导：只由消息区底部的可点行展示，气泡内不再画一套；
 * - 这条追问之后已经有用户消息：选项收起（回复输出过程中也不再留着）；
 * - 问题还没答、但当前没有可点引导（例如切走后引导状态丢失）：气泡内只留不可点记录。
 */

/**
 * 两组选项是否同一组（标签与取值按顺序一致）。
 *
 * @param {Array<{label: string, value: string}>|null|undefined} left 左侧选项
 * @param {Array<{label: string, value: string}>|null|undefined} right 右侧选项
 * @returns {boolean} 是否同一组
 */
export function sameGuideOptions(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || left.length === 0) {
    return false;
  }
  return left.every(
    (option, index) => option?.label === right[index]?.label && option?.value === right[index]?.value,
  );
}

/**
 * 这条引导消息之后是否已经有用户回复。
 * 回复一出现，这组选项就算被回答，不能再当可选项留在界面上。
 *
 * @param {Array<{id: string, role: string}>} messages 当前会话消息（按时间正序）
 * @param {string} messageId 引导消息 id
 * @returns {boolean} 是否已有后续用户消息
 */
export function guideQuestionAnswered(messages, messageId) {
  if (!Array.isArray(messages)) {
    return false;
  }
  const index = messages.findIndex((item) => item?.id === messageId);
  if (index < 0) {
    return false;
  }
  return messages.slice(index + 1).some((item) => item?.role === 'user');
}

/**
 * 回复气泡内是否还要渲染不可点的历史选项。
 * 当前待补引导返回 false：那一组只由底部可点行展示，避免两套都像能点。
 *
 * @param {object} params
 * @param {{id: string, options?: Array<{label: string, value: string}>|null}} params.message 待判定消息
 * @param {Array<{id: string, role: string}>} params.messages 当前会话消息
 * @param {{options?: Array<{label: string, value: string}>}|null} params.pendingGuide 当前待补引导
 * @returns {boolean} true 表示在气泡内展示不可点记录
 */
export function shouldShowHistoryOptions({ message, messages, pendingGuide }) {
  const options = message?.options;
  if (!Array.isArray(options) || options.length === 0) {
    return false;
  }
  if (guideQuestionAnswered(messages, message.id)) {
    return false;
  }
  if (pendingGuide && sameGuideOptions(options, pendingGuide.options)) {
    return false;
  }
  return true;
}
