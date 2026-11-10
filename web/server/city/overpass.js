/**
 * Overpass API 数据源适配（仅 Node 服务端使用）：
 * 查询构造、多镜像轮换、重试退避、流式字节计数。
 *
 * 实测（2026-11-08，本机网络）：
 * - overpass-api.de 可用但波动（1.6s~45s，偶发 502/504），重试可恢复；
 * - overpass.osm.ch 对中国 bbox 返回 200 但 elements 为空（瑞士数据实例）——
 *   因此“HTTP 200 + 0 道路”必须判为无效数据，不能当成功；
 * - 瓦片级查询实测 153s / 1.5MB(gzip) / 10341 way，超时预算按此校准。
 */

import { HIGHWAY_KEEP } from './overpass-convert.js';

/** 默认镜像表（按序尝试；DRAWINMAP_OVERPASS_URLS 环境变量可整体覆盖） */
const DEFAULT_OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.osm.jp/api/interpreter',
];

/** 单次尝试超时（毫秒）：瓦片实测最长 ~153s，留出排队余量 */
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 300_000;

/** 镜像轮换全失败的退避序列（毫秒）与总轮数 */
const RETRY_BACKOFF_MS = [2_000, 8_000, 20_000];

/** 简短 UA：公共实例要求可识别的 UA */
const USER_AGENT = 'DrawInMap/1.0 (local prototype; on-demand city roads)';

/** 保留的道路类型正则：由 overpass-convert.js 的 `HIGHWAY_KEEP` 单一源生成
 * （查询层预过滤减少传输，转换层复核；此前两处各抄一份 21 类清单，易漂移）。 */
const HIGHWAY_FILTER_RE = `^(${[...HIGHWAY_KEEP].join('|')})$`;

/**
 * 构造一个 bbox 的道路查询。
 *
 * @param {{minLat: number, minLng: number, maxLat: number, maxLng: number}} bbox 范围
 * @param {{mode: 'geom'|'count', timeoutSec?: number}} [options] geom=取全量；count=只取数量
 * @returns {string} Overpass QL 查询
 */
export function buildBboxQuery(bbox, { mode = 'geom', timeoutSec = 180 } = {}) {
  const bboxText = `${bbox.minLat},${bbox.minLng},${bbox.maxLat},${bbox.maxLng}`;
  const body = `way["highway"~"${HIGHWAY_FILTER_RE}"](${bboxText});`;
  const out = mode === 'count' ? 'out count;' : 'out geom;';
  return `[out:json][timeout:${timeoutSec}];${body}${out}`;
}

/**
 * 从环境变量读取镜像表（逗号分隔；未设置用默认表）。
 *
 * @param {string|undefined} envValue DRAWINMAP_OVERPASS_URLS
 * @returns {string[]} 镜像 URL 列表
 */
export function resolveOverpassUrls(envValue) {
  const trimmed = typeof envValue === 'string' ? envValue.trim() : '';
  if (!trimmed) {
    return [...DEFAULT_OVERPASS_URLS];
  }
  const urls = trimmed
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);
  return urls.length > 0 ? urls : [...DEFAULT_OVERPASS_URLS];
}

/**
 * sleep（毫秒）。
 *
 * @param {number} ms 毫秒
 * @param {import('node:events').AbortSignal} [signal] 中止信号
 * @returns {Promise<void>}
 */
function sleepMs(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 单次 Overpass 请求（不做重试）：返回 JSON 并统计字节数。
 *
 * @param {object} options
 * @param {string} options.url 镜像地址
 * @param {string} options.query QL 查询
 * @param {number} options.timeoutMs 超时
 * @param {(bytes: number) => void} [options.onBytes] 收到字节回调（流式进度）
 * @param {import('node:events').AbortSignal} [options.signal] 外部中止信号
 * @returns {Promise<{json: object, host: string, bytes: number, ms: number}>}
 */
async function attemptFetch({ url, query, timeoutMs, onBytes, signal }) {
  const startedAt = Date.now();
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
    },
    body: `data=${encodeURIComponent(query)}`,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  // 流式读取：真实进度（已接收字节）+ 大响应不一次性进内存
  let bytes = 0;
  const reader = response.body.getReader();
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      chunks.push(value);
      bytes += value.length;
      onBytes?.(bytes);
    }
  }
  const text = new TextDecoder('utf-8').decode(Buffer.concat(chunks));
  let json;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`响应不是有效 JSON（可能是截断/HTML 错误页）: ${error.message}`);
  }
  return { json, host: new URL(url).host, bytes, ms: Date.now() - startedAt };
}

/**
 * 带多镜像轮换 + 退避重试的 Overpass 请求。
 *
 * 失败重试顺序：镜像表逐个尝试 → 全失败后按退避序列再来一轮（最多 RETRY_BACKOFF_MS.length 轮）。
 * 外部 signal 中止立即抛出。
 *
 * @param {object} options
 * @param {string[]} options.urls 镜像 URL 列表
 * @param {string} options.query QL 查询
 * @param {number} [options.timeoutMs] 单次尝试超时
 * @param {(info: {bytes: number}) => void} [options.onBytes] 字节进度回调
 * @param {(info: {attempt: number, url: string, error: string, waitMs: number|null}) => void} [options.onRetry]
 *   每次失败回调（日志/进度用；waitMs 非 null 表示本轮镜像耗尽将退避重试）
 * @param {import('node:events').AbortSignal} [options.signal] 外部中止信号
 * @returns {Promise<{json: object, host: string, bytes: number, ms: number, attempts: Array<object>}>}
 */
export async function fetchOverpass({ urls, query, timeoutMs = DEFAULT_ATTEMPT_TIMEOUT_MS, onBytes, onRetry, signal }) {
  const attempts = [];
  let lastError = null;
  for (let round = 0; round <= RETRY_BACKOFF_MS.length; round += 1) {
    for (const url of urls) {
      try {
        const result = await attemptFetch({ url, query, timeoutMs, onBytes, signal });
        attempts.push({ url, ok: true, bytes: result.bytes, ms: result.ms });
        return { ...result, attempts };
      } catch (error) {
        if (signal?.aborted) {
          throw error;
        }
        lastError = error;
        attempts.push({ url, ok: false, error: String(error?.message ?? error) });
      }
    }
    if (round < RETRY_BACKOFF_MS.length) {
      const waitMs = RETRY_BACKOFF_MS[round];
      onRetry?.({ attempt: attempts.length, url: 'all-mirrors', error: String(lastError?.message ?? lastError), waitMs });
      await sleepMs(waitMs, signal);
    }
  }
  throw new Error(`所有 Overpass 镜像均失败：${String(lastError?.message ?? lastError)}`);
}

/**
 * 获取一个 bbox 的道路 elements（out geom）。
 *
 * @param {object} options
 * @param {{minLat: number, minLng: number, maxLat: number, maxLng: number}} options.bbox 范围
 * @param {string[]} options.urls 镜像表
 * @param {number} [options.timeoutSec] Overpass 服务端超时（默认 180）
 * @param {number} [options.timeoutMs] 客户端单次尝试超时
 * @param {(bytes: number) => void} [options.onBytes]
 * @param {(info: object) => void} [options.onRetry]
 * @param {import('node:events').AbortSignal} [options.signal]
 * @returns {Promise<{elements: Array, host: string, bytes: number, ms: number, attempts: Array, query: string}>}
 */
export async function fetchRoadsInBbox({ bbox, urls, timeoutSec = 180, timeoutMs, onBytes, onRetry, signal }) {
  const query = buildBboxQuery(bbox, { mode: 'geom', timeoutSec });
  const result = await fetchOverpass({ urls, query, timeoutMs, onBytes, onRetry, signal });
  const elements = Array.isArray(result.json?.elements) ? result.json.elements : [];
  // 诚实闸门：0 条记录（空数据实例对中国 bbox 返回 200+空数组）或带 remark（超时/截断）
  // 都判失败——半份数据会静默劣化路网图，绝不能落盘当成功。
  if (elements.length === 0) {
    throw new Error(
      `数据源返回 0 条记录${result.json?.remark ? `（remark: ${result.json.remark}）` : ''}`,
    );
  }
  if (result.json?.remark) {
    throw new Error(`数据源响应带 remark，结果可能不完整：${result.json.remark}`);
  }
  return { elements, host: result.host, bytes: result.bytes, ms: result.ms, attempts: result.attempts, query };
}
