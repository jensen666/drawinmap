/**
 * 城市路网按需获取服务（仅 Node 服务端）：
 * 作业队列（同一时刻最多一个 running）→ 瓦片拆分下载（并发 2）→ 合并转换 →
 * 校验 → 原子落盘 web/data/city-roads/<cityId>.json（跨用户持久缓存）。
 *
 * 设计要点（方案 §4.2）：
 * - 获取 bbox 从目录锚点推导（±0.055°纬 / 0.070°经），2×2 拆瓦片 + 0.01° 重叠：
 *   Overpass 对"与 bbox 相交的 way"返回完整 way，重叠保证跨界道路至少在一个瓦片里
 *   完整出现，按 way id 去重后无边界断链；
 * - 全部成功才落盘：任何瓦片失败 / 道路数低于阈值 / 总超时，作业失败且不写缓存；
 * - meta.tiles 记录每次获取的瓦片 bbox、镜像 host、耗时、字节数——当次真实获取的机内证据；
 * - 测试开关（仅 DRAWINMAP_CITY_TEST_HOOKS=1 启动时可用）：打开后每次数据源访问立即失败，
 *   用于 E2E-06 制造"获取失败 → 重试成功"链路，重试关闭开关后走真实下载。
 */

import { open, rename, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { fetchRoadsInBbox, resolveOverpassUrls, DEFAULT_ATTEMPT_TIMEOUT_MS } from './overpass.js';
import {
  overpassElementsToRoads,
  buildCityRoadsPayload,
  assertRoadCount,
} from './overpass-convert.js';

/** 瓦片间重叠（度）：保证跨界 way 在相邻瓦片完整出现 */
const TILE_OVERLAP_DEG = 0.01;

/** 瓦片下载并发数（公共实例友好；实测单瓦片 ~153s，4 瓦片约 5 分钟） */
const TILE_CONCURRENCY = 2;

/** 单城整体截止（毫秒） */
const JOB_DEADLINE_MS = 15 * 60_000;

/** 缓存目录文件名 */
const cacheFileName = (cityId) => `${cityId}.json`;

/**
 * 把获取 bbox 拆成 2×2 瓦片（带重叠）。
 *
 * @param {{minLat: number, minLng: number, maxLat: number, maxLng: number}} bbox 获取范围
 * @returns {Array<{minLat: number, minLng: number, maxLat: number, maxLng: number}>} 4 个瓦片
 */
export function splitTiles(bbox) {
  const midLat = (bbox.minLat + bbox.maxLat) / 2;
  const midLng = (bbox.minLng + bbox.maxLng) / 2;
  const m = TILE_OVERLAP_DEG;
  return [
    { minLat: bbox.minLat, minLng: bbox.minLng, maxLat: midLat + m, maxLng: midLng + m },
    { minLat: bbox.minLat, minLng: midLng - m, maxLat: midLat + m, maxLng: bbox.maxLng },
    { minLat: midLat - m, minLng: bbox.minLng, maxLat: bbox.maxLat, maxLng: midLng + m },
    { minLat: midLat - m, minLng: midLng - m, maxLat: bbox.maxLat, maxLng: bbox.maxLng },
  ];
}

/** 目录条目 → 获取 bbox（± halfSpan） */
function fetchBboxOf(city, halfSpanDeg) {
  const { lat, lng } = city.center;
  return {
    minLat: Math.round((lat - halfSpanDeg.lat) * 1e6) / 1e6,
    maxLat: Math.round((lat + halfSpanDeg.lat) * 1e6) / 1e6,
    minLng: Math.round((lng - halfSpanDeg.lng) * 1e6) / 1e6,
    maxLng: Math.round((lng + halfSpanDeg.lng) * 1e6) / 1e6,
  };
}

/**
 * 从缓存文件头部读出 meta（meta 固定在 JSON 最前，读到 `,"roads":` 标记即可整段解析，
 * 只读文件头 64KB，避免 10MB+ 文件整体进内存）。
 *
 * @param {string} filePath 缓存文件路径
 * @returns {Promise<object|null>} meta（解析失败/文件异常返回 null）
 */
async function readCacheMetaHead(filePath) {
  try {
    const handle = await open(filePath, 'r');
    try {
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(64 * 1024), 0, 64 * 1024, 0);
      const head = buffer.toString('utf8', 0, bytesRead);
      const marker = head.indexOf(',"roads":');
      if (marker < 0) {
        return null;
      }
      // head[0..marker) 是 `{"meta":...}`（marker 指向 roads 前的逗号），补一个外层右括号即可解析
      return JSON.parse(`${head.slice(0, marker)}}`).meta ?? null;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/**
 * 创建城市路网获取服务。
 *
 * @param {object} options
 * @param {string} options.cacheDir 缓存目录（web/data/city-roads）
 * @param {object} options.catalog 城市目录（city-catalog.json 解析结果）
 * @param {string[]} [options.urls] Overpass 镜像表（缺省读环境变量/默认表）
 * @param {number} [options.minRoads] 最低道路数闸门（默认 1000）
 * @param {boolean} [options.testHooksEnabled] 是否允许测试开关
 * @param {(...args: Array) => void} [options.onLog] 日志回调（console）
 * @returns {object} 服务接口
 */
export async function createCityFetchService({
  cacheDir,
  catalog,
  urls = resolveOverpassUrls(process.env.DRAWINMAP_OVERPASS_URLS),
  minRoads = 1000,
  testHooksEnabled = false,
  onLog = () => {},
} = {}) {
  const halfSpanDeg = catalog.fetchHalfSpanDeg ?? { lat: 0.055, lng: 0.07 };
  const cityById = new Map(catalog.cities.map((city) => [city.id, city]));

  /** 作业表与串行队列 */
  const jobs = new Map();
  let jobSeq = 0;
  let runningJobId = null;
  const queue = [];

  /** 测试开关：打开后每次数据源访问立即失败 */
  let testBlock = false;

  /** 缓存摘要（cityId → {cityId, roadCount, generatedAt, bytes, mtimeMs}），启动扫描 + 写盘后更新 */
  const cacheSummary = new Map();

  async function scanCache() {
    cacheSummary.clear();
    let names = [];
    try {
      names = await readdir(cacheDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) {
        continue;
      }
      const cityId = name.slice(0, -5);
      const filePath = join(cacheDir, name);
      const meta = await readCacheMetaHead(filePath);
      const info = await stat(filePath).catch(() => null);
      cacheSummary.set(cityId, {
        cityId,
        roadCount: meta?.road_count ?? null,
        generatedAt: meta?.generated_at ?? null,
        bytes: info?.size ?? null,
        mtimeMs: info?.mtimeMs ?? null,
      });
    }
  }

  /** 公开状态：每城是否已有缓存 */
  function cacheStates() {
    return [...cacheSummary.values()].sort((a, b) => a.cityId.localeCompare(b.cityId));
  }

  function jobStatus(jobId) {
    const job = jobs.get(jobId);
    if (!job) {
      return null;
    }
    return {
      jobId: job.jobId,
      cityId: job.cityId,
      cityLabel: job.cityLabel,
      status: job.status,
      tilesDone: job.tilesDone,
      tilesTotal: job.tilesTotal,
      roads: job.roads,
      bytes: job.bytes,
      currentHost: job.currentHost,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      error: job.error ?? null,
    };
  }

  function jobSummaries() {
    return [...jobs.values()].map((job) => jobStatus(job.jobId));
  }

  /** 测试开关（E2E-06 专用）：返回当前状态 */
  function setTestBlock(on) {
    if (!testHooksEnabled) {
      throw new Error('测试开关未启用（需要 DRAWINMAP_CITY_TEST_HOOKS=1 启动服务器）');
    }
    testBlock = Boolean(on);
    return { on: testBlock };
  }

  /**
   * 发起获取：同城已有未完成作业则复用；preset 城市（当前默认城市）不允许获取。
   *
   * @param {string} cityId 城市 id
   * @returns {{jobId: string, reused: boolean}} 作业 id
   */
  function startFetch(cityId) {
    const city = cityById.get(cityId);
    if (!city) {
      throw new Error(`城市不存在：${cityId}`);
    }
    if (city.preset) {
      throw new Error(`${city.label}路网已随页面提供，无需获取`);
    }
    const existing = [...jobs.values()].find(
      (job) => job.cityId === cityId && (job.status === 'queued' || job.status === 'running'),
    );
    if (existing) {
      return { jobId: existing.jobId, reused: true };
    }
    jobSeq += 1;
    const job = {
      jobId: `cityfetch-${Date.now()}-${jobSeq}`,
      cityId,
      cityLabel: city.label,
      status: 'queued',
      tilesDone: 0,
      tilesTotal: 4,
      roads: 0,
      bytes: 0,
      currentHost: null,
      startedAt: null,
      finishedAt: null,
      error: null,
    };
    jobs.set(job.jobId, job);
    queue.push(job.jobId);
    onLog(`[city] 排队获取 ${city.label}（job ${job.jobId}）`);
    pump();
    return { jobId: job.jobId, reused: false };
  }

  function pump() {
    if (runningJobId !== null) {
      return;
    }
    const nextId = queue.shift();
    if (!nextId) {
      return;
    }
    const job = jobs.get(nextId);
    if (!job) {
      return;
    }
    runningJobId = job.jobId;
    job.status = 'running';
    job.startedAt = Date.now();
    runJob(job)
      .catch((error) => {
        job.status = 'failed';
        job.error = String(error?.message ?? error);
        job.finishedAt = Date.now();
        onLog(`[city] 获取失败 ${job.cityLabel}：${job.error}`);
      })
      .finally(() => {
        runningJobId = null;
        pump();
      });
  }

  /** 单瓦片下载（含测试开关与轮内去重）。onBytes 供作业侧做跨瓦片累计进度 */
  async function fetchTile(job, tile, signal, { onTileBytes = null } = {}) {
    if (testBlock) {
      throw new Error('数据源已断开（测试开关）');
    }
    const result = await fetchRoadsInBbox({
      bbox: tile,
      urls,
      timeoutMs: DEFAULT_ATTEMPT_TIMEOUT_MS,
      onBytes: (bytes) => {
        onTileBytes?.(bytes);
      },
      onRetry: (info) => {
        onLog(`[city] ${job.cityLabel} 瓦片重试：attempt=${info.attempt} error=${info.error} wait=${info.waitMs ?? 0}ms`);
      },
      signal,
    });
    job.currentHost = result.host;
    const tileRoads = overpassElementsToRoads(result.elements);
    onLog(
      `[city] ${job.cityLabel} 瓦片完成：${tileRoads.length} 道路 / ${(result.bytes / 1e6).toFixed(1)}MB / ${result.host} / ${(result.ms / 1000).toFixed(0)}s`,
    );
    return { roads: tileRoads, host: result.host, bytes: result.bytes, ms: result.ms, attempts: result.attempts, query: result.query };
  }

  async function runJob(job) {
    const city = cityById.get(job.cityId);
    const bbox = fetchBboxOf(city, halfSpanDeg);
    const tiles = splitTiles(bbox);
    job.tilesTotal = tiles.length;
    const deadline = Date.now() + JOB_DEADLINE_MS;
    const controller = new AbortController();
    const deadlineTimer = setTimeout(() => controller.abort(new Error('获取总时长超过 15 分钟')), JOB_DEADLINE_MS);
    try {
      const mergedRoads = [];
      const seenIds = new Set();
      const tileRecords = [];
      let firstHost = null;

      /** 简易并发池：顺序发瓦片，同时最多 TILE_CONCURRENCY 个在途 */
      let nextTile = 0;
      /** 各瓦片已接收字节：job.bytes 用跨瓦片累计值做进度（单瓦片峰值会误导） */
      const tileBytes = new Array(tiles.length).fill(0);
      async function worker() {
        while (nextTile < tiles.length) {
          const index = nextTile;
          nextTile += 1;
          if (Date.now() > deadline) {
            throw new Error('获取总时长超过 15 分钟');
          }
          const tile = tiles[index];
          const tileResult = await fetchTile(job, tile, controller.signal, {
            onTileBytes: (bytes) => {
              tileBytes[index] = bytes;
              job.bytes = tileBytes.reduce((sum, value) => sum + value, 0);
            },
          });
          if (!firstHost) {
            firstHost = tileResult.host;
          }
          for (const road of tileResult.roads) {
            if (seenIds.has(road.id)) {
              continue;
            }
            seenIds.add(road.id);
            mergedRoads.push(road);
          }
          tileRecords.push({
            index,
            bbox: [tile.minLng, tile.minLat, tile.maxLng, tile.maxLat],
            ways: tileResult.roads.length,
            bytes: tileResult.bytes,
            ms: tileResult.ms,
            host: tileResult.host,
            attempts: tileResult.attempts,
          });
          job.tilesDone = tileRecords.length;
          job.roads = mergedRoads.length;
        }
      }
      // 并发池：任一瓦片失败即中止全部在途请求（作业失败不落盘）
      try {
        await Promise.all(
          Array.from({ length: Math.min(TILE_CONCURRENCY, tiles.length) }, () => worker()),
        );
      } catch (error) {
        controller.abort(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }

      // mergedRoads 在 worker 合并时已按 way id 去重（seenIds），此处不再二次去重
      assertRoadCount(mergedRoads, minRoads);
      const payload = buildCityRoadsPayload({
        cityId: job.cityId,
        roads: mergedRoads,
        bbox: [bbox.minLng, bbox.minLat, bbox.maxLng, bbox.maxLat],
        tiles: tileRecords.sort((a, b) => a.index - b.index),
        sourceHost: firstHost ?? 'unknown',
        generatedAt: new Date().toISOString(),
      });
      await mkdir(cacheDir, { recursive: true });
      const finalPath = join(cacheDir, cacheFileName(job.cityId));
      const tmpPath = `${finalPath}.tmp`;
      await writeFile(tmpPath, JSON.stringify(payload), 'utf8');
      await rename(tmpPath, finalPath);
      const info = await stat(finalPath);
      cacheSummary.set(job.cityId, {
        cityId: job.cityId,
        roadCount: payload.meta.road_count,
        generatedAt: payload.meta.generated_at,
        bytes: info.size,
        mtimeMs: info.mtimeMs,
      });
      job.status = 'done';
      job.roads = payload.meta.road_count;
      job.bytes = info.size;
      job.finishedAt = Date.now();
      onLog(
        `[city] 获取完成 ${job.cityLabel}：${payload.meta.road_count} 道路 → data/city-roads/${job.cityId}.json（${(info.size / 1e6).toFixed(1)}MB）`,
      );
    } finally {
      clearTimeout(deadlineTimer);
    }
  }

  await scanCache();

  return {
    startFetch,
    jobStatus,
    jobSummaries,
    cacheStates,
    setTestBlock,
    testHooksEnabled,
    cityById,
    /** 重新扫描缓存目录（外部删除文件后调用） */
    rescanCache: scanCache,
  };
}
