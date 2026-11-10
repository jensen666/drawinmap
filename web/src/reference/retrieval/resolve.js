/**
 * 参考候选获取编排（纯函数，依赖全部注入，Node / 浏览器通用）。
 *
 * 方案 2026-10-31 §5.1：以单命中 resolveReferenceShape 为基础扩展出
 * resolveReferenceCandidates——保留"候选池 → 许可过滤 → 排序 → 最多 N 次下载/转换
 * → attempts"的职责，但收集多个转换成功的候选而不是第一个成功后立即返回。
 *
 * 返回的是**未经过 normalizeCustomShape 的原始转换候选**（raw candidates，§5.2）：
 * conversion.T 是 convertSvg 的输出，不是 customShape；浏览器/调用方再统一归一化，
 * 归一化失败按 §5.3 用同一候选池补位（本模块不负责归一化）。
 */

import { rankCandidates } from "./phylopic.js";
import { throwIfAborted } from "../../cancel.js";

/** 默认展示候选数（三张并排卡） */
export const REFERENCE_CANDIDATE_LIMIT = 3;

/** 默认下载/转换尝试上限（§5.3：limit=3、maxAttempts=6 口径） */
export const REFERENCE_MAX_ATTEMPTS = 6;

/**
 * 收集一个查询的多个原始转换候选。
 *
 * @param {object} options
 * @param {object} options.query 查询（zh/en/学名，仅供检索器与日志使用）
 * @param {(query: object) => Promise<Array<object>>} options.listCandidates 检索候选池
 *   （返回前调用方已完成来源主排序：本地为 §5.5 规则，在线为适配器排序）
 * @param {(candidate: object) => Promise<string>} options.downloadSvg 下载候选 SVG 文本
 * @param {(svgText: string, candidate: object) => object} options.convert 转换（返回 convertSvg 结果）
 * @param {(candidate: object, conversion: object) => object} [options.toRawCandidate]
 *   把 (候选, 转换结果) 映射为 raw candidate（补充 origin/reviewStatus/sourceSha256 等）
 * @param {(candidates: Array<object>, query: object) => Array<object>} [options.rank]
 *   许可过滤后的排序函数（在线默认用 PhyloPic 学名/许可排序；本地已在 §5.5 排序时传恒等。
 *   注意：编排层只做"来源主排序"——本地 §5.5 的转换偏差层需要转换结果，由调用方在
 *   收集完成后统一执行，见 browser.js 的 resolveCandidates）
 * @param {(candidate: object) => boolean} [options.filterCandidate] 进入尝试前的资格过滤
 *   （如在线候选须有 vectorUrl；缺省不过滤）
 * @param {number} [options.maxAttempts] 最多尝试的素材数（默认 6；§5.3：尝试用完即按
 *   实际数量返回，收集全部成功候选——不在"成功 3 个"时提前停止，展示层 limit 由
 *   浏览器归一化补位阶段执行）
 * @param {AbortSignal} [options.signal] 中止信号（浏览器"停止"）
 * @returns {Promise<{
 *   status: 'ok'|'failed',
 *   query: object,
 *   rawCandidates: Array<object>,
 *   attempts: Array<object>,
 *   poolSize: number,
 *   error: string|null
 * }>}
 */
export async function resolveReferenceCandidates({
  query,
  listCandidates,
  downloadSvg,
  convert,
  toRawCandidate = (candidate, conversion) => ({ asset: candidate, conversion }),
  rank = rankCandidates,
  filterCandidate = null,
  maxAttempts = REFERENCE_MAX_ATTEMPTS,
  signal = null,
}) {
  const attempts = [];
  let candidates = [];
  try {
    candidates = (await listCandidates(query)) || [];
  } catch (error) {
    return {
      status: "failed",
      query,
      rawCandidates: [],
      attempts,
      poolSize: 0,
      error: `检索失败：${error?.message || error}`,
    };
  }
  const usable = candidates.filter((candidate) => candidate && candidate.licenseAllowed !== false);
  const ranked = rank ? rank(usable, { scientificNames: query.scientificNames || [] }) : usable;
  const eligible = filterCandidate ? ranked.filter(filterCandidate) : ranked;
  const poolSize = eligible.length;
  const shortlist = eligible.slice(0, Math.max(1, maxAttempts));
  if (shortlist.length === 0) {
    // 失败可见化（缺陷清单 Bug 1.6.2；2026-11-07 复核补充）：把过滤拆成两段计数，
    // 错误信息如实区分"上游没有候选 / 许可不可用 / 矢量或来源不可用"——
    // 此前笼统的"候选均无矢量文件或许可不可用"把许可过滤误报成矢量问题
    const licenseDropped = candidates.length - usable.length;
    const eligibilityDropped = usable.length - eligible.length;
    let reason;
    if (candidates.length === 0) {
      reason = "检索无候选";
    } else if (licenseDropped > 0 && eligibilityDropped === 0) {
      reason = `候选 ${candidates.length} 个全部许可不可用（许可白名单外），未进入下载`;
    } else if (eligibilityDropped > 0 && licenseDropped === 0) {
      reason = `候选 ${candidates.length} 个全部缺矢量文件或来源/标识不可用，未进入下载`;
    } else {
      reason = `候选 ${candidates.length} 个全部未通过资格过滤（许可 ${licenseDropped} 个、矢量/来源 ${eligibilityDropped} 个）`;
    }
    return {
      status: "failed",
      query,
      rawCandidates: [],
      attempts,
      poolSize,
      error: reason,
    };
  }
  /** @type {Array<{candidate: object, conversion: object, attempt: object}>} */
  const accepted = [];
  for (const candidate of shortlist) {
    throwIfAborted(signal, "已停止");
    const attempt = { candidate, status: "skipped", reasons: [], conversion: null };
    attempts.push(attempt);
    let svgText;
    try {
      svgText = await downloadSvg(candidate);
    } catch (error) {
      attempt.status = "download-failed";
      attempt.reasons = [`下载失败：${error?.message || error}`];
      continue;
    }
    try {
      const converted = convert(svgText, candidate);
      attempt.conversion = converted;
      if (converted?.status === "accepted" && converted.T) {
        attempt.status = "accepted";
        accepted.push({ candidate, conversion: converted, attempt });
        continue;
      }
      attempt.status = "conversion-rejected";
      attempt.reasons = (converted?.reasons || []).map((reason) => reason.code);
    } catch (error) {
      attempt.status = "convert-failed";
      attempt.reasons = [`转换异常：${error?.message || error}`];
    }
  }
  throwIfAborted(signal, "已停止");
  if (accepted.length === 0) {
    return {
      status: "failed",
      query,
      rawCandidates: [],
      attempts,
      poolSize,
      error: `尝试的 ${shortlist.length} 个候选均未通过转换`,
    };
  }
  return {
    status: "ok",
    query,
    rawCandidates: accepted.map(({ candidate, conversion }) => toRawCandidate(candidate, conversion)),
    attempts,
    poolSize,
    error: null,
  };
}

/**
 * 旧单命中入口（迁移期兼容包装，方案 §5.1）：取新多候选编排的第一项。
 * shadow 检索工具（tools/reference/shadow-retrieval.mjs）继续使用；
 * 生产主路径切换到 resolveReferenceCandidates 后随旧单命中主路径一起删除。
 *
 * @param {object} options 与 resolveReferenceCandidates 相同（maxCandidates 语义保留）
 * @returns {Promise<{status: 'ok'|'failed', query: object, selected: {candidate: object, conversion: object}|null,
 *   attempts: Array<object>, poolSize: number, error: string|null}>}
 */
export async function resolveReferenceShape({
  query,
  searchCandidates,
  downloadSvg,
  convert,
  maxCandidates = 3,
  signal = null,
}) {
  const result = await resolveReferenceCandidates({
    query,
    listCandidates: searchCandidates,
    downloadSvg,
    convert,
    filterCandidate: (candidate) => Boolean(candidate.vectorUrl),
    maxAttempts: Math.max(1, maxCandidates),
    signal,
  });
  return {
    status: result.status,
    query: result.query,
    selected: result.rawCandidates.length > 0
      ? { candidate: result.rawCandidates[0].asset, conversion: result.rawCandidates[0].conversion }
      : null,
    attempts: result.attempts,
    poolSize: result.poolSize,
    error: result.error,
  };
}
