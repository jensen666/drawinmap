/**
 * 在线检索浏览器客户端（方案 2026-10-31 §9.1）：只请求同源 /__reference/*，
 * 不直接访问外部素材站。
 *
 * - 探测（GET /__reference/ping）在本地无候选后才发起或复用结果；接口不可用、
 *   404 或返回非预期结构时，在线能力自动关闭（纯静态托管场景，方案 §9.1）；
 *   探测失败按会话缓存，不反复打无谓请求，也不把"旧进程缺接口"误判为"在线无素材"
 *   ——调用方据此只记日志、静默回退，不给用户"在线无素材"的错误结论；
 * - 检索（POST /__reference/search）返回 raw candidates（未归一化 T），
 *   归一化在浏览器侧统一执行（§5.2/§5.3）。
 */

/** 探测与检索的默认超时（毫秒） */
const DEFAULT_TIMEOUT_MS = 15000;

/** 带超时与外部中止的 fetch（fetchImpl 可注入，Node 测试用） */
async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } catch (error) {
    // 外部中止（用户点选候选 / 停止 / 新输入）不是"在线不可用"：向上抛带 aborted
    // 标记的中止错误，调用方按中止语义处理且不得写进探测缓存（修复 H4）。
    // 内部超时/网络失败才属于"探测失败"，由 probe 缓存否定结果。
    if (options.signal?.aborted) {
      const abortError = new Error("在线探测已中止");
      abortError.name = "AbortError";
      abortError.aborted = true;
      throw abortError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * 创建同源在线检索客户端。
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl] 注入 fetch（Node 测试用）
 * @param {string} [options.baseUrl] 同源基址（缺省当前页面源）
 * @param {number} [options.timeoutMs] 请求超时（毫秒）
 * @returns {{probe: (options?: object) => Promise<object|null>,
 *   search: (input: object) => Promise<object>,
 *   reset: () => void}}
 */
export function createOnlineReferenceClient({ fetchImpl = globalThis.fetch, baseUrl = "", timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  /** 探测结果会话缓存（含否定结果：null = 不可用） */
  let probePromise = null;

  /**
   * 探测在线检索能力。可用时返回 { sources, experimentalSources }；不可用返回 null。
   *
   * @param {{force?: boolean, signal?: AbortSignal}} [options]
   */
  async function probe({ force = false, signal = null } = {}) {
    if (!probePromise || force) {
      probePromise = (async () => {
        try {
          const response = await fetchWithTimeout(
            `${baseUrl}/__reference/ping`,
            { signal },
            timeoutMs,
            fetchImpl,
          );
          if (!response.ok) {
            return null;
          }
          const data = await response.json();
          if (data?.ok !== true || !Array.isArray(data.sources)) {
            return null;
          }
          return {
            sources: data.sources.filter((name) => typeof name === "string"),
            experimentalSources: Array.isArray(data.experimentalSources)
              ? data.experimentalSources.filter((name) => typeof name === "string")
              : [],
          };
        } catch (error) {
          // 外部中止不是"在线不可用"：清掉探测缓存在案（probePromise 在上层已赋值，
          // 这里同步置空，下一次 probe() 会重新探测），并抛中止错误给调用方。
          // 404/网络失败/内部超时/非预期结构仍按方案缓存否定结果（自动关闭在线）。
          if (error?.aborted === true) {
            probePromise = null;
            throw error;
          }
          // 404/网络失败/非预期结构：在线能力自动关闭（缓存否定结果）
          return null;
        }
      })();
    }
    return probePromise;
  }

  /**
   * 在线检索 raw candidates。
   *
   * @param {object} input
   * @param {object} input.referenceQuery 规范化查询（intent.referenceQuery）
   * @param {number} [input.maxAttempts] 服务端下载/转换尝试上限
   * @param {AbortSignal} [input.signal] 中止信号
   * @returns {Promise<{rawCandidates: Array<object>, attempts: Array<object>, poolSize: number,
   *   failures: Array<object>, cache: object, sources: string[]}>}
   */
  async function search({ referenceQuery, maxAttempts = 6, signal = null }) {
    const response = await fetchWithTimeout(
      `${baseUrl}/__reference/search`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ referenceQuery, maxAttempts }),
        signal,
      },
      timeoutMs * 2, // 检索含上游下载/转换，超时放宽一档
      fetchImpl,
    );
    if (!response.ok) {
      throw new Error(`在线检索失败：HTTP ${response.status}`);
    }
    const data = await response.json();
    if (!data || typeof data !== "object" || !Array.isArray(data.rawCandidates)) {
      throw new Error("在线检索返回了非预期结构");
    }
    // 服务端失败可见化（缺陷清单 Bug 1.6.2）：ok=false 表示上游失败/候选被过滤，
    // 必须原样透传 payload（status/error/failureKind/filteredOut/attempts/poolSize），
    // 由调用方区分 no-match / filtered / conversion-failed——不得在这里抛掉或吞成
    // "非预期结构"（修复前 ok:false 会被当异常抛出，失败原因全部丢失）。
    if (data.ok === false) {
      return data;
    }
    return {
      ok: true,
      rawCandidates: data.rawCandidates,
      attempts: Array.isArray(data.attempts) ? data.attempts : [],
      poolSize: Number(data.poolSize) || 0,
      failures: Array.isArray(data.failures) ? data.failures : [],
      cache: data.cache && typeof data.cache === "object" ? data.cache : {},
      sources: Array.isArray(data.sources) ? data.sources : [],
    };
  }

  return {
    probe,
    search,
    /** 测试/重试用：清除探测缓存 */
    reset: () => {
      probePromise = null;
    },
  };
}
