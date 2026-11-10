/**
 * 剪贴板写入工具（对话面板"复制 traceId"等交互共用）。
 *
 * 设计约束：
 * - 优先异步 Clipboard API（安全上下文 https / localhost 可用）；
 * - 不可用或被拒绝时降级为隐藏 textarea + document.execCommand('copy')（局域网 http、老浏览器）；
 * - 两条路径都失败返回 false，由调用方给用户可见反馈，不抛错（复制失败不能影响主流程）；
 * - 依赖可注入（clipboard / doc），便于 Node 测试覆盖各分支。
 */

/**
 * 把文本写入剪贴板。
 *
 * @param {string} text 要复制的文本
 * @param {{clipboard?: {writeText?: Function}|null, doc?: Document|null}} [options] 依赖注入（测试用）
 * @returns {Promise<boolean>} 是否复制成功
 */
export async function copyText(text, options = {}) {
  const clipboard = 'clipboard' in options ? options.clipboard : globalThis.navigator?.clipboard ?? null;
  const doc = 'doc' in options ? options.doc : globalThis.document ?? null;
  if (typeof text !== 'string' || text.length === 0) {
    return false;
  }

  // 1) 异步 Clipboard API：安全上下文可用；权限被拒/非安全上下文会 reject，继续降级
  if (clipboard && typeof clipboard.writeText === 'function') {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // 降级到 execCommand
    }
  }

  // 2) 降级：隐藏 textarea + execCommand（同步复制，老浏览器/非安全上下文可用）
  if (!doc || typeof doc.createElement !== 'function' || typeof doc.execCommand !== 'function' || !doc.body) {
    return false;
  }
  let area = null;
  try {
    area = doc.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-9999px';
    area.style.left = '-9999px';
    doc.body.appendChild(area);
    if (typeof area.select === 'function') {
      area.select();
    }
    return doc.execCommand('copy') === true;
  } catch {
    return false;
  } finally {
    // 无论成功失败都清理临时节点，避免焦点/滚动位置被残留节点影响
    if (area) {
      if (area.parentNode) {
        area.parentNode.removeChild(area);
      } else if (typeof area.remove === 'function') {
        area.remove();
      }
    }
  }
}
