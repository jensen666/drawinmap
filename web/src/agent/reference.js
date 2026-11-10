/**
 * Agent 层参考图适配：参考素材 → 统一候选（customShape + contentHash）。
 *
 * 方案 2026-10-31 §5.2 两层返回结构：
 * - raw 层（本地 browser.js / 在线 server.mjs）：{ asset, conversion.T, matchedAlias,
 *   sourceSha256, origin, reviewStatus } —— conversion.T 是 convertSvg 输出，不是 customShape；
 * - 浏览器共享适配器（本模块）调用 normalizeCustomShape 产生统一候选：
 *   { candidateId, choiceId, asset, customShape, conversion, matchedAlias, origin,
 *     reviewStatus, sourceSha256, contentHash }。
 *
 * §5.3 归一化失败补位：浏览器按服务端排序逐个归一化 raw candidates，成功满
 * limit 个即停止；失败的消耗一个候选池位置并追加到 failures，不再次请求服务端补货。
 *
 * 服务端不返回 customShape，也不 import Agent 的意图归一化模块（§5.2）。
 */

import { createLocalReferenceSource } from '../reference/browser.js';
import { createOnlineReferenceClient } from '../reference/online-client.js';
import { computeReferenceContentHash } from '../reference/hash.js';
import { normalizeCustomShape } from './intent.js';

/** 展示候选上限（三张并排卡） */
export const REFERENCE_CHOICE_LIMIT = 3;

/**
 * 把 raw candidate 归一化为统一候选（§5.2/§5.3）。
 *
 * @param {object} raw raw candidate（asset/conversion/matchedAlias/sourceSha256/origin/reviewStatus）
 * @returns {{candidate: object|null, failure: object|null}} 归一化失败返回 failure
 */
export function normalizeRawReferenceCandidate(raw) {
  const conversion = raw.conversion;
  if (!conversion?.T?.points?.length) {
    return { candidate: null, failure: { assetId: raw.asset?.id ?? raw.asset?.uuid ?? '?', reason: 'conversion-missing' } };
  }
  const asset = trimAsset(raw.asset);
  const name = asset.displayName;
  const customShape = normalizeCustomShape({ name, points: conversion.T.points });
  if (!customShape) {
    return { candidate: null, failure: { assetId: asset.id, reason: 'normalize-failed' } };
  }
  const contentHash = computeReferenceContentHash({
    sourceSha256: raw.sourceSha256 ?? null,
    conversionOptions: {},
    customShape,
  });
  return {
    candidate: {
      asset,
      customShape,
      // conversion 只保留状态/T/指标（R 是 4000 点精修环，不进候选与上下文）
      conversion: {
        status: conversion.status,
        T: conversion.T,
        metrics: conversion.metrics ?? null,
      },
      matchedAlias: raw.matchedAlias ?? null,
      origin: raw.origin ?? 'local',
      reviewStatus: raw.reviewStatus ?? 'unreviewed',
      sourceSha256: raw.sourceSha256 ?? null,
      contentHash,
    },
    failure: null,
  };
}

/** 精简素材元数据：本地为 manifest 条目，在线为候选元数据 */
function trimAsset(asset) {
  const id = asset?.id ?? asset?.uuid ?? 'unknown';
  const displayName =
    asset?.names?.zh?.[0] || asset?.names?.en?.[0] || asset?.title || asset?.scientificName || id;
  if (asset?.names) {
    return { ...asset, displayName };
  }
  return {
    id,
    displayName,
    title: asset?.title ?? null,
    scientificName: asset?.scientificName ?? null,
    source: {
      name: asset?.sourceName ?? 'online',
      url: asset?.sourceUrl ?? null,
      license: asset?.license ?? null,
      attribution: asset?.attribution ?? null,
    },
  };
}

/**
 * 归一化并补位（§5.3）：按顺序归一化 raw candidates，成功满 limit 个停止；
 * 失败消耗池位置并记入 failures。candidateId/choiceId 由控制器创建选择快照时补齐。
 *
 * @param {Array<object>} rawCandidates 原始候选池（已按序）
 * @param {{limit?: number}} [options]
 * @returns {{candidates: Array<object>, failures: Array<object>}}
 */
export function buildReferenceCandidates(rawCandidates, { limit = REFERENCE_CHOICE_LIMIT } = {}) {
  const candidates = [];
  const failures = [];
  for (const raw of rawCandidates || []) {
    if (candidates.length >= limit) {
      break;
    }
    const { candidate, failure } = normalizeRawReferenceCandidate(raw);
    if (candidate) {
      candidates.push(candidate);
    } else {
      failures.push(failure);
    }
  }
  return { candidates, failures };
}

/**
 * 创建"用户文本 → 参考候选"解析源（本地 + 可选在线补漏）。
 *
 * 降级顺序（方案 §9.4）：本地候选 → 在线候选 → 调用方回退原 LLM 自由轮廓链路。
 * 本地已有合格候选时不并发在线检索（§2.2）。
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {string|URL} [options.manifestUrl]
 * @param {string|URL} [options.baseUrl]
 * @param {object|null} [options.online] 在线客户端（缺省浏览器环境自动创建；传 null 禁用）
 * @returns {{resolveCandidates: (text: string, options?: object) => Promise<object>}}
 */
export function createReferenceCandidateSource({ fetchImpl, manifestUrl, baseUrl, online } = {}) {
  const local = createLocalReferenceSource({ fetchImpl, manifestUrl, baseUrl });
  const onlineClient =
    online === null
      ? null
      : online || (typeof window !== 'undefined' ? createOnlineReferenceClient({ fetchImpl }) : null);

  async function searchOnline(text, { intent, limit, signal }) {
    if (!onlineClient) {
      return { status: 'miss', origin: 'online', rawCandidates: [], failures: [], poolSize: 0, attempts: [] };
    }
    const capability = await onlineClient.probe({ signal });
    if (!capability) {
      // 接口不可用（静态托管/旧进程）：在线能力自动关闭，静默回退，不误报"在线无素材"
      return { status: 'offline', origin: 'online', rawCandidates: [], failures: [], poolSize: 0, attempts: [] };
    }
    const query = intent?.referenceQuery
      ? { ...intent.referenceQuery }
      : { zh: null, en: null, scientificNames: [], searchTerms: [], traits: [] };
    const result = await onlineClient.search({ referenceQuery: query, maxAttempts: 6, signal });
    // 服务端失败可见化（缺陷清单 Bug 1.6.2/1.6.3）：ok=false 按失败种类分流——
    // no-match（上游真没有素材）保持 miss 语义（调用方按"无素材"回退），
    // 其余（filtered/conversion-failed/download-failed/上游错误）为 failed，
    // failureKind/filteredOut/attempts 原样透传，不再全部混成"miss"。
    if (result.ok === false) {
      const failureKind = result.failureKind ?? 'failed';
      return {
        status: failureKind === 'no-match' ? 'miss' : 'failed',
        origin: 'online',
        rawCandidates: [],
        failures: [],
        poolSize: result.poolSize ?? 0,
        attempts: result.attempts ?? [],
        cache: result.cache,
        sources: result.sources,
        failureKind,
        filteredOut: result.filteredOut ?? null,
        error: failureKind === 'no-match' ? null : result.error ?? '在线检索失败',
        text,
      };
    }
    return {
      status: result.rawCandidates.length > 0 ? 'ok' : 'miss',
      origin: 'online',
      rawCandidates: result.rawCandidates,
      failures: [],
      poolSize: result.poolSize,
      attempts: result.attempts,
      filteredOut: result.filteredOut ?? null,
      cache: result.cache,
      sources: result.sources,
      text,
    };
  }

  /** 参考查询的图形名与姿态特征（本地/在线两路共用，避免两路取到不一致的查询线索）。 */
  function referenceQueryOf(intent) {
    return {
      shapeName: intent?.customShape?.name ?? intent?.shapeSpec?.name ?? null,
      traits: Array.isArray(intent?.referenceQuery?.traits) ? intent.referenceQuery.traits : [],
    };
  }

  /**
   * 本地素材候选（三路并发的本地一路，方案 2026-11-01 §2）。
   *
   * 与在线路互相独立：本地命中与否都返回本路结论，不触发在线检索；
   * 调用方把两路同时发起，由到达顺序决定卡片追加。
   *
   * @param {string} text 用户文本
   * @param {{intent?: object|null, limit?: number, signal?: AbortSignal|null}} [options]
   * @returns {Promise<{status: 'ok'|'miss'|'multi'|'collision'|'failed', origin: 'local',
   *   candidates: Array<object>, failures: Array<object>, rawCount?: number,
   *   poolSize: number, attempts: Array<object>, objects?: string[], reason?: string,
   *   error?: string|null}>}
   */
  /**
   * 本地源结果 → Agent 层统一候选结构（单对象 / 多对象 / 碰撞 / 未命中）。
   *
   * 多对象命中按对象分组返回统一候选（方案 2026-11-05 §4.2）：调用方据此判断
   * 「是否所有请求对象都有候选」——部分命中时不得单候选自动规划，
   * 也不能把整条通道让位丢掉命中信息。
   *
   * @param {object} localResult local.resolveCandidates 的结果
   * @param {number} limit 单对象展示上限
   * @returns {object} Agent 层统一结果
   */
  function adaptLocalResult(localResult, limit = REFERENCE_CHOICE_LIMIT) {
    if (localResult.status === 'ok' && localResult.rawCandidates.length > 0) {
      const built = buildReferenceCandidates(localResult.rawCandidates, { limit });
      return {
        status: built.candidates.length > 0 ? 'ok' : 'failed',
        origin: 'local',
        candidates: built.candidates,
        failures: built.failures,
        rawCount: localResult.rawCandidates.length,
        poolSize: localResult.poolSize,
        attempts: localResult.attempts,
        error: built.candidates.length === 0 ? '候选归一化全部失败' : null,
      };
    }
    if (localResult.status === 'multi') {
      const objectGroups = (localResult.objectGroups || []).map((group) => {
        const built = buildReferenceCandidates(group.rawCandidates || [], { limit });
        return {
          objectKey: group.objectKey,
          objectName: group.objectName,
          aliases: Array.isArray(group.aliases) ? group.aliases : [],
          candidates: built.candidates,
          failures: built.failures,
          candidateCount: built.candidates.length,
        };
      });
      return {
        status: 'multi',
        origin: 'local',
        candidates: objectGroups.flatMap((group) => group.candidates),
        failures: objectGroups.flatMap((group) => group.failures),
        objectGroups,
        objects: (localResult.objects ?? []).slice(),
        rawCount: localResult.rawCandidates.length,
        poolSize: localResult.poolSize,
        attempts: localResult.attempts,
        reason: localResult.reason ?? 'multi-object',
        error: null,
      };
    }
    if (localResult.status === 'collision') {
      // 同一区间对应不同对象：配置碰撞，不得任选其一
      return {
        status: 'collision',
        origin: 'local',
        candidates: [],
        failures: [],
        poolSize: localResult.poolSize ?? 0,
        attempts: localResult.attempts ?? [],
        objects: localResult.objects ?? [],
        collision: localResult.collision ?? null,
        reason: localResult.reason ?? 'alias-collision',
        error: null,
      };
    }
    return {
      status: localResult.status === 'miss' ? 'miss' : 'failed',
      origin: 'local',
      candidates: [],
      failures: localResult.failures ?? [],
      poolSize: localResult.poolSize ?? 0,
      attempts: localResult.attempts ?? [],
      error: localResult.error ?? null,
    };
  }

  async function resolveLocalCandidates(text, { intent = null, limit = REFERENCE_CHOICE_LIMIT, signal = null } = {}) {
    const { shapeName, traits } = referenceQueryOf(intent);
    const localResult = await local.resolveCandidates(text, { shapeName, traits, signal });
    return adaptLocalResult(localResult, limit);
  }

  /**
   * 在线原始结果 → Agent 层统一候选结构（resolveOnlineCandidates 与 resolveCandidates
   * 的 miss/failed 入口共用；同一 payload 经不同入口返回逐字段一致的结构，T-B2c）。
   *
   * 非 ok（miss/offline/failed）原样透传失败可见化字段；ok 但归一化全败统一记
   * failureKind='normalize-failed'，不再由各入口各自手写。
   *
   * @param {object} onlineResult searchOnline 的结果
   * @param {number} limit 单对象展示上限
   * @returns {object} Agent 层统一结果
   */
  function adaptOnlineResult(onlineResult, limit = REFERENCE_CHOICE_LIMIT) {
    if (onlineResult.status !== 'ok') {
      return { ...onlineResult, candidates: [], failures: [] };
    }
    const built = buildReferenceCandidates(onlineResult.rawCandidates, { limit });
    const base = {
      origin: 'online',
      candidates: built.candidates,
      failures: built.failures,
      rawCount: onlineResult.rawCandidates.length,
      poolSize: onlineResult.poolSize,
      attempts: onlineResult.attempts,
      cache: onlineResult.cache,
      sources: onlineResult.sources,
    };
    if (built.candidates.length > 0) {
      return { status: 'ok', ...base, error: null };
    }
    return {
      status: 'failed',
      ...base,
      candidates: [],
      failureKind: 'normalize-failed',
      error: '在线候选归一化全部失败',
    };
  }

  /**
   * 多对象请求按清单逐对象匹配（缺陷清单 2026-11-06 Bug 4.3.4.2）。
   *
   * 整段原文扫描的词边界规则对「单字别名 + 连词」组合失效（"画猫和兔子"里
   * "猫"不命中），而意图层已经给出 requestObjects 清单——把每个对象名单独
   * 送入匹配器（单独输入 = 词边界天然成立），不再依赖整段文本的连词位置。
   *
   * @param {Array<{name: string, aliases?: string[]}>} objects 意图层请求对象清单
   * @param {{intent?: object|null, limit?: number, signal?: AbortSignal|null}} [options]
   * @returns {Promise<object>} 与 resolveLocalCandidates 同构的结果（status:
   *   'multi' 命中 ≥1 个对象；'miss' 一个都没命中）
   */
  async function resolveLocalCandidatesForObjects(objects, { intent = null, limit = REFERENCE_CHOICE_LIMIT, signal = null } = {}) {
    const names = (Array.isArray(objects) ? objects : [])
      .map((item) => (typeof item === 'string' ? item : item?.name))
      .filter((name) => typeof name === 'string' && name.trim());
    if (names.length === 0) {
      return { status: 'miss', origin: 'local', candidates: [], failures: [], poolSize: 0, attempts: [], error: null };
    }
    const objectGroups = [];
    const rawCandidates = [];
    const failures = [];
    let poolSize = 0;
    for (const name of names) {
      // 每个对象名单独匹配：单独输入语境（词边界 + 语境守卫都天然成立），
      // 不受连词/其他对象名干扰；也不受原文其他词劫持（"人民广场"不会命中"人"）
      const localResult = await local.resolveCandidates(name, { shapeName: name, traits: [], signal });
      poolSize += localResult.poolSize ?? 0;
      if (localResult.status === 'ok' && Array.isArray(localResult.rawCandidates) && localResult.rawCandidates.length > 0) {
        rawCandidates.push(...localResult.rawCandidates);
        objectGroups.push({
          objectKey: name,
          objectName: name,
          aliases: [name],
          rawCandidates: localResult.rawCandidates,
          poolSize: localResult.poolSize ?? localResult.rawCandidates.length,
          attempts: localResult.attempts ?? [],
        });
      }
    }
    if (objectGroups.length === 0) {
      return {
        status: 'miss',
        origin: 'local',
        candidates: [],
        failures,
        objectGroups: [],
        objects: [],
        rawCount: 0,
        poolSize,
        attempts: [],
        reason: 'multi-object',
        error: null,
      };
    }
    return adaptLocalResult(
      {
        status: 'multi',
        objectGroups,
        objects: objectGroups.map((group) => group.objectName),
        rawCandidates,
        poolSize,
        attempts: [],
      },
      limit,
    );
  }

  /**
   * 在线检索候选（三路并发的在线一路，方案 2026-11-01 §2）。
   *
   * @param {string} text 用户文本
   * @param {{intent?: object|null, limit?: number, signal?: AbortSignal|null}} [options]
   * @returns {Promise<{status: 'ok'|'miss'|'offline'|'failed', origin: 'online',
   *   candidates: Array<object>, failures: Array<object>, rawCount?: number,
   *   poolSize: number, attempts: Array<object>, cache?: object, sources?: string[],
   *   error?: string|null}>}
   */
  async function resolveOnlineCandidates(text, { intent = null, limit = REFERENCE_CHOICE_LIMIT, signal = null } = {}) {
    return adaptOnlineResult(await searchOnline(text, { intent, limit, signal }), limit);
  }

  /**
   * 解析参考候选（旧串行接口，本地优先、命中即不查在线；三路并发编排不走本函数）。
   *
   * @param {string} text 用户文本
   * @param {object} [options]
   * @param {object} [options.intent] 归一化意图（取 customShape?.name ?? shapeSpec?.name 与 referenceQuery.traits）
   * @param {number} [options.limit] 展示上限（默认 3）
   * @param {AbortSignal} [options.signal] 中止信号
   * @returns {Promise<{status: 'ok'|'miss'|'multi'|'collision'|'offline'|'failed',
   *   origin: 'local'|'online', candidates: Array<object>, failures: Array<object>,
   *   rawCount?: number, poolSize: number, attempts: Array<object>, objects?: string[],
   *   cache?: object, sources?: string[], error?: string|null}>}
   *   candidates 为统一候选（已归一化 + contentHash；candidateId 待快照补齐）
   */
  async function resolveCandidates(text, { intent = null, limit = REFERENCE_CHOICE_LIMIT, signal = null } = {}) {
    const { shapeName, traits } = referenceQueryOf(intent);
    const localResult = await local.resolveCandidates(text, { shapeName, traits, signal });
    if (localResult.status === 'ok' && localResult.rawCandidates.length > 0) {
      // 与 resolveLocalCandidates 共用同一适配（本地 ok 分支只有一份）
      return adaptLocalResult(localResult, limit);
    }
    if (localResult.status === 'multi' || localResult.status === 'collision') {
      // 多对象命中 / 配置碰撞：结构化返回，调用方决定组合或追问
      const adapted = adaptLocalResult(localResult, limit);
      return { ...adapted, candidates: [], failures: adapted.failures ?? [] };
    }
    // 本地无合格候选 → 在线补漏（§9.4 降级顺序）；在线不可用/无候选时回退调用方
    if (localResult.status === 'miss') {
      return adaptOnlineResult(await searchOnline(text, { intent, limit, signal }), limit);
    }
    // 本地转换全败（failed）：同样尝试在线补漏；在线仍无合格候选则保持本地 failed 语义
    const adapted = adaptOnlineResult(await searchOnline(text, { intent, limit, signal }), limit);
    if (adapted.status === 'ok') {
      return adapted;
    }
    return {
      status: 'failed',
      origin: 'local',
      candidates: [],
      failures: [],
      poolSize: localResult.poolSize,
      attempts: localResult.attempts,
      error: localResult.error ?? '本地候选转换失败',
    };
  }

  return { resolveCandidates, resolveLocalCandidates, resolveLocalCandidatesForObjects, resolveOnlineCandidates };
}

/**
 * 旧单命中函数（兼容包装）：把 legacy "text → {customShape, asset, ...}" 函数
 * 适配为新 resolveCandidates 接口（单本地候选直走路径，测试与迁移期使用）。
 *
 * @param {(text: string) => Promise<object|null>} legacySource
 */
export function wrapLegacyReferenceSource(legacySource) {
  return {
    async resolveCandidates(text) {
      const hit = await legacySource(text);
      if (!hit?.customShape) {
        return { status: 'miss', origin: 'local', candidates: [], failures: [], poolSize: 0, attempts: [] };
      }
      const contentHash = computeReferenceContentHash({
        sourceSha256: hit.asset?.sha256 ?? null,
        conversionOptions: {},
        customShape: hit.customShape,
      });
      return {
        status: 'ok',
        origin: 'local',
        candidates: [
          {
            asset: { ...(hit.asset || {}), displayName: hit.asset?.names?.zh?.[0] || hit.asset?.id || '图形' },
            customShape: hit.customShape,
            conversion: hit.conversion ?? null,
            matchedAlias: hit.matchedAlias ?? null,
            origin: 'local',
            reviewStatus: 'curated',
            sourceSha256: hit.asset?.sha256 ?? null,
            contentHash,
          },
        ],
        failures: [],
        poolSize: 1,
        attempts: [],
      };
    },
  };
}

/**
 * 创建"用户文本 → 参考图 customShape"的旧单命中解析函数（迁移期兼容，
 * 内部走多候选源取第一项）。
 *
 * @param {object} [options] 透传给 createLocalReferenceSource（fetchImpl/manifestUrl/baseUrl）
 * @returns {(text: string) => Promise<{customShape: object, asset: object, matchedAlias: string,
 *   conversion: object}|null>}
 */
export function createReferenceShapeSource(options = {}) {
  const source = createLocalReferenceSource(options);
  return async function resolveReferenceShape(text) {
    const hit = await source.resolve(text);
    if (!hit?.conversion?.T?.points?.length) return null;
    const name = hit.asset.names?.zh?.[0] || hit.asset.names?.en?.[0] || hit.asset.id;
    const customShape = normalizeCustomShape({ name, points: hit.conversion.T.points });
    if (!customShape) return null;
    return {
      customShape,
      asset: hit.asset,
      matchedAlias: hit.matchedAlias,
      conversion: hit.conversion,
    };
  };
}
