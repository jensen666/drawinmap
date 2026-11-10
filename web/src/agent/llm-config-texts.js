/**
 * LLM 配置界面共用文案（追加需求 2026-11-10）。
 *
 * 设置面板（测试连接）与「获取模型」子视图共用同一套失败分类文案，
 * 避免 UI 层出现两套 kind→中文映射；文案不含密钥，调用方保证 message 已由核心模块脱敏。
 */

/** 测试连接/获取模型失败类别 → 可读中文前缀（与 llm-config.js 的 kind 对应） */
export const TEST_KIND_LABELS = {
  validation: '本地校验未过（未发请求）', network: '网络错误或跨域被拒', timeout: '请求超时',
  auth: '鉴权失败', 'not-found': '端点或模型不存在', 'rate-limit': '触发限流',
  server: '服务端错误', incompatible: '接口不兼容', unconfigured: '尚未配置', unknown: '未知错误',
};

/**
 * 拼接失败文案：前缀 + 分类中文 + 原因 +（建议）+（补充提示）。
 *
 * @param {string} prefix 文案前缀（如「连接失败」「获取模型失败」）
 * @param {{kind?: string, message?: string, suggestion?: string}} result 核心模块失败结果
 * @param {string} [extraHint] 追加提示（如鉴权失败时提醒核对密钥）
 * @returns {string} 可读中文失败文案
 */
export function formatFailureText(prefix, result = {}, extraHint = '') {
  const kind = result?.kind ?? 'unknown';
  const label = TEST_KIND_LABELS[kind] ?? TEST_KIND_LABELS.unknown;
  const suggestion = typeof result?.suggestion === 'string' && result.suggestion ? `（${result.suggestion}）` : '';
  return `${prefix}（${label}）：${result?.message ?? '未提供原因'}${suggestion}${extraHint}`;
}
