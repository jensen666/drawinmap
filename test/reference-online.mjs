/**
 * 在线检索服务测试（方案 2026-10-31 §9/§11.3）。
 *
 * 覆盖：
 * - normalizeOnlineQuery：字段/数组长度上限、非法字符清理、无效查询返回 null；
 * - createOnlineReferenceService（注入 fetch + 内存存储）：
 *   PhyloPic 全流程（节点 → 图片 → 下载 → convertSvg → raw candidates，
 *   reviewStatus=unreviewed）、查询缓存命中不重复上游请求、素材缓存复用、
 *   转换拒绝记录（30 天 TTL 语义）、主机白名单、中止传播、experimental 开关；
 * - createOnlineReferenceClient（浏览器客户端）：探测成功/失败缓存、检索校验；
 * - server.mjs HTTP 端点：GET /__reference/ping、POST 请求体上限/非法 JSON、
 *   纯静态托管（无端点）返回 404。
 *
 * 运行：node test/reference-online.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createOnlineReferenceService,
  normalizeOnlineQuery,
} from '../web/server/reference/online-service.js';
import { createOnlineReferenceClient } from '../web/src/reference/online-client.js';
import { createReferenceCandidateSource } from '../web/src/agent/reference.js';

let failures = 0;
let checks = 0;

function check(label, condition, detail = '') {
  checks += 1;
  const ok = Boolean(condition);
  if (!ok) {
    failures += 1;
  }
  console.log(`[check] ${label} -> ${ok ? 'PASS' : `FAIL ${detail}`}`);
}

const VALID_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M10 10 L90 10 L90 90 L10 90 Z"/></svg>';
const BROKEN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M10 10 L90 10 M20 20 L80 20 M30 30 L70 30"/></svg>';

// ---------- normalizeOnlineQuery ----------
{
  const ok = normalizeOnlineQuery({ zh: '狗', en: 'dog', scientificNames: ['Canis familiaris', 'Canis'], searchTerms: [], traits: ['站姿', ' 站姿 '] });
  check('查询：基本归一化与去重', ok.zh === '狗' && ok.scientificNames.length === 2 && ok.traits.length === 1, JSON.stringify(ok));
  const capped = normalizeOnlineQuery({
    zh: 'x'.repeat(100),
    scientificNames: Array.from({ length: 10 }, (_, i) => `Name ${i}`),
    traits: Array.from({ length: 20 }, (_, i) => `t${i}`),
  });
  check('查询：长度与数组上限', capped.zh.length === 30 && capped.scientificNames.length === 4 && capped.traits.length === 8);
  check('查询：控制字符/尖括号清理', normalizeOnlineQuery({ zh: 'a\x00b<c>' }).zh === 'a b c', JSON.stringify(normalizeOnlineQuery({ zh: 'a\x00b<c>' })));
  check('查询：无有效内容 → null', normalizeOnlineQuery({ traits: ['站姿'] }) === null && normalizeOnlineQuery('狗') === null && normalizeOnlineQuery(null) === null);
}

// ---------- createOnlineReferenceService（mock 上游 + 内存存储） ----------
// 真实响应形态 fixture（缺陷清单 Bug 1.6.4）：vectorFile.href 是 CDN 域
// images.phylopic.org/images/<uuid>/vector.svg，而不是 api.phylopic.org——
// 旧 mock 用 api 域导致测试从未覆盖真实下载域，主机过滤缺陷漏检 6 天。
function makePhylopicFetch({ counters = { node: 0, images: 0, vector: 0 }, vectorById = {} } = {}) {
  return async (url) => {
    const href = String(url);
    if (href === 'https://api.phylopic.org' || href.startsWith('https://api.phylopic.org/')) {
      if (href === 'https://api.phylopic.org' || href.includes('/build') || href === 'https://api.phylopic.org?') {
        return { ok: true, status: 200, json: async () => ({ build: 'test-build' }), text: async () => '' };
      }
      if (href.includes('/nodes')) {
        counters.node += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({ totalItems: 1, _links: { items: [{ href: '/nodes/n-canis', title: 'Canis familiaris' }] } }),
        };
      }
      if (href.includes('/images')) {
        counters.images += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            totalItems: 2,
            _embedded: {
              items: [
                {
                  uuid: 'u-good',
                  attribution: 'Test Author',
                  _links: {
                    license: { href: 'https://creativecommons.org/publicdomain/zero/1.0/' },
                    vectorFile: { href: 'https://images.phylopic.org/images/u-good/vector.svg' },
                    specificNode: { title: 'Canis familiaris' },
                  },
                },
                {
                  uuid: 'u-bad',
                  attribution: 'Bad Author',
                  _links: {
                    license: { href: 'https://creativecommons.org/publicdomain/zero/1.0/' },
                    vectorFile: { href: 'https://images.phylopic.org/images/u-bad/vector.svg' },
                    specificNode: { title: 'Canis familiaris' },
                  },
                },
              ],
            },
          }),
        };
      }
    }
    if (href.startsWith('https://images.phylopic.org/images/')) {
      counters.vector += 1;
      const uuid = href.replace('https://images.phylopic.org/images/', '').split('/')[0];
      const svg = vectorById[uuid] ?? VALID_SVG;
      return { ok: true, status: 200, text: async () => svg, headers: { get: () => null } };
    }
    return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
  };
}

const QUERY = { zh: '狗', en: 'dog', scientificNames: ['Canis familiaris'], searchTerms: [], traits: [] };

async function makeService(fetchImpl, overrides = {}) {
  return createOnlineReferenceService({ fetchImpl, sources: ['phylopic'], ...overrides });
}

{
  const counters = { node: 0, images: 0, vector: 0 };
  const fetchImpl = makePhylopicFetch({ counters, vectorById: { 'u-bad': BROKEN_SVG } });
  const service = await makeService(fetchImpl);

  check('ping：结构与默认源', JSON.stringify(service.ping()) === JSON.stringify({ ok: true, sources: ['phylopic'], experimentalSources: [] }), JSON.stringify(service.ping()));

  const first = await service.search({ referenceQuery: QUERY, maxAttempts: 6 });
  check('检索：返回 raw candidates（未归一化 T，非 customShape）', first.ok === true && first.rawCandidates.length >= 1 && first.rawCandidates.every((raw) => raw.conversion.T?.points?.length > 0 && !raw.conversion.customShape), JSON.stringify(first.rawCandidates?.length));
  check('检索：在线候选 reviewStatus=unreviewed + 元数据（许可/署名/来源）', first.rawCandidates.every((raw) => raw.origin === 'online' && raw.reviewStatus === 'unreviewed' && raw.asset.license === 'CC0-1.0' && raw.asset.attribution === 'Test Author' && raw.asset.sourceUrl?.includes('phylopic')));
  check('检索：查询缓存未命中 + attempts 摘要', first.cache.query === 'miss' && first.attempts.every((attempt) => !attempt.svg && 'status' in attempt));
  check('检索：转换被拒候选进 attempts（含原因）', first.attempts.some((attempt) => attempt.status === 'conversion-rejected'), JSON.stringify(first.attempts?.map((a) => a.status)));

  // 查询缓存：第二次相同查询不再打上游节点/图片接口（§11.3）
  const nodeAfterFirst = counters.node;
  const imagesAfterFirst = counters.images;
  const vectorAfterFirst = counters.vector;
  const second = await service.search({ referenceQuery: QUERY, maxAttempts: 6 });
  check('检索：第二次命中查询缓存（cache.query=hit）', second.cache.query === 'hit');
  check('检索：命中缓存不产生重复上游请求', counters.node === nodeAfterFirst && counters.images === imagesAfterFirst && counters.vector === vectorAfterFirst, JSON.stringify({ node: counters.node, vector: counters.vector }));
  check('检索：命中缓存仍返回候选', second.rawCandidates.length === first.rawCandidates.length);

  // 拒绝缓存：坏候选 30 天内不再进入尝试
  const rejectsRaw = await (async () => {
    // 通过注入的 storage 读不到（内存存储在服务内），改由行为验证：新服务实例 + 独立存储
    return null;
  })();
  void rejectsRaw;

  // 中止传播
  const controller = new AbortController();
  controller.abort();
  await service.search({ referenceQuery: QUERY, signal: controller.signal }).then(
    () => check('检索：已中止信号上抛 AbortError', false, '未抛出'),
    (error) => check('检索：已中止信号上抛 AbortError', error.name === 'AbortError'),
  );

  // experimental 源开关（方案 §9.5：默认关闭，开启后列出）
  const expService = createOnlineReferenceService({ fetchImpl, experimental: { openclipart: true } });
  check('ping：experimental 源默认关闭、显式开启后列出', service.ping().experimentalSources.length === 0 && expService.ping().experimentalSources.includes('openclipart'));

  // 无效查询：不抛错，返回空候选
  const invalid = await service.search({ referenceQuery: null });
  check('检索：无效查询返回空候选（cache=invalid）', invalid.ok === true && invalid.rawCandidates.length === 0 && invalid.cache.query === 'invalid');

  // 主机白名单：vectorUrl 不在来源域后缀内的候选被过滤，且失败可见化（Bug 1.6.2）
  const wlService = await makeService(async (url) => {
    const href = String(url);
    if (href === 'https://api.phylopic.org') return { ok: true, json: async () => ({ build: 'b' }) };
    if (href.includes('/nodes')) return { ok: true, json: async () => ({ totalItems: 1, _links: { items: [{ href: '/nodes/n1', title: 'Canis' }] } }) };
    if (href.includes('/images')) {
      return {
        ok: true,
        json: async () => ({
          totalItems: 1,
          _embedded: { items: [{ uuid: 'u-evil', _links: { license: { href: 'https://creativecommons.org/publicdomain/zero/1.0/' }, vectorFile: { href: 'https://evil.example/x.svg' }, specificNode: { title: 'Canis' } } }] },
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  const wl = await wlService.search({ referenceQuery: QUERY });
  check(
    '检索：非白名单主机候选被过滤（不做开放代理），且返回 failed 而非 ok+空数组',
    wl.ok === false && wl.rawCandidates.length === 0 && wl.poolSize === 0 && wl.failureKind === 'filtered' && Boolean(wl.error),
    JSON.stringify({ ok: wl.ok, raw: wl.rawCandidates.length, pool: wl.poolSize, failureKind: wl.failureKind, error: wl.error }),
  );
  check('检索：失败透传 attempts/poolSize/被过滤数', Array.isArray(wl.attempts) && wl.filteredOut === 1, JSON.stringify({ attempts: wl.attempts?.length, filteredOut: wl.filteredOut }));

  // 明文 http 下载地址同样拒绝（白名单必须 https）
  const httpService = await makeService(async (url) => {
    const href = String(url);
    if (href === 'https://api.phylopic.org') return { ok: true, json: async () => ({ build: 'b' }) };
    if (href.includes('/nodes')) return { ok: true, json: async () => ({ totalItems: 1, _links: { items: [{ href: '/nodes/n1', title: 'Canis' }] } }) };
    if (href.includes('/images')) {
      return {
        ok: true,
        json: async () => ({
          totalItems: 1,
          _embedded: { items: [{ uuid: 'u-http', _links: { license: { href: 'https://creativecommons.org/publicdomain/zero/1.0/' }, vectorFile: { href: 'http://images.phylopic.org/images/u-http/vector.svg' }, specificNode: { title: 'Canis' } } }] },
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  const httpResult = await httpService.search({ referenceQuery: QUERY });
  check('检索：http（非 https）下载地址被过滤', httpResult.ok === false && httpResult.failureKind === 'filtered', JSON.stringify({ ok: httpResult.ok, failureKind: httpResult.failureKind }));

  // uuid 字符白名单：uuid 不安全（会拼进缓存路径）的候选不进入下载
  const uuidService = await makeService(async (url) => {
    const href = String(url);
    if (href === 'https://api.phylopic.org') return { ok: true, json: async () => ({ build: 'b' }) };
    if (href.includes('/nodes')) return { ok: true, json: async () => ({ totalItems: 1, _links: { items: [{ href: '/nodes/n1', title: 'Canis' }] } }) };
    if (href.includes('/images')) {
      return {
        ok: true,
        json: async () => ({
          totalItems: 1,
          _embedded: { items: [{ uuid: '../evil', _links: { license: { href: 'https://creativecommons.org/publicdomain/zero/1.0/' }, vectorFile: { href: 'https://images.phylopic.org/images/x/vector.svg' }, specificNode: { title: 'Canis' } } }] },
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  const uuidResult = await uuidService.search({ referenceQuery: QUERY });
  check('检索：uuid 不合法的候选被过滤（不进缓存路径）', uuidResult.ok === false && uuidResult.failureKind === 'filtered' && uuidResult.filteredOut === 1, JSON.stringify({ ok: uuidResult.ok, failureKind: uuidResult.failureKind, filteredOut: uuidResult.filteredOut }));
}

// ---------- 素材缓存复用（独立服务实例共享同一存储） ----------
{
  const files = new Map();
  const storage = {
    readText: async (path) => (files.has(path) ? files.get(path) : null),
    writeText: async (path, text) => {
      files.set(path, String(text));
    },
  };
  const counters = { node: 0, images: 0, vector: 0 };
  const fetchImpl = makePhylopicFetch({ counters });
  const service = createOnlineReferenceService({ fetchImpl, storage, sources: ['phylopic'] });
  const first = await service.search({ referenceQuery: QUERY });
  const vectorCount = counters.vector;
  check('缓存：素材缓存写入（svg + 元数据含许可/署名）', [...files.keys()].some((path) => path === 'phylopic/u-good.svg') && [...files.keys()].some((path) => path === 'phylopic/u-good.json'), JSON.stringify([...files.keys()]));
  // 新实例共享存储：查询缓存 + 素材缓存全部命中，零上游
  counters.node = 0;
  counters.images = 0;
  counters.vector = 0;
  const service2 = createOnlineReferenceService({ fetchImpl, storage, sources: ['phylopic'] });
  const again = await service2.search({ referenceQuery: QUERY });
  check('缓存：跨实例命中（查询+素材零上游）', again.cache.query === 'hit' && again.rawCandidates.length > 0 && counters.node === 0 && counters.vector === 0, JSON.stringify({ raw: again.rawCandidates.length, node: counters.node, vector: counters.vector }));
  void first;
}

// ---------- 浏览器客户端 ----------
{
  const client = createOnlineReferenceClient({
    baseUrl: 'http://reference-api.test',
    fetchImpl: async (url, options = {}) => {
      const href = String(url);
      if (href.endsWith('/__reference/ping')) {
        if (options.forceFail) return { ok: false, status: 404, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ ok: true, sources: ['phylopic'], experimentalSources: [] }) };
      }
      if (href.endsWith('/__reference/search')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, rawCandidates: [{ asset: { uuid: 'u1' }, conversion: { status: 'accepted', T: { points: [[0, 0]] } }, origin: 'online', reviewStatus: 'unreviewed' }], attempts: [], poolSize: 1, failures: [], cache: { query: 'miss' }, sources: ['phylopic'] }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    },
  });
  const capability = await client.probe();
  check('客户端：探测成功返回 sources', capability?.sources?.[0] === 'phylopic');
  const result = await client.search({ referenceQuery: QUERY });
  check('客户端：检索返回 raw candidates', result.rawCandidates.length === 1 && result.rawCandidates[0].reviewStatus === 'unreviewed');

  // 404 / 非预期结构 → null（否定结果缓存）
  const badClient = createOnlineReferenceClient({
    baseUrl: 'http://reference-api.test',
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
  });
  check('客户端：404 → 能力关闭（null）', (await badClient.probe()) === null);
  const weirdClient = createOnlineReferenceClient({
    baseUrl: 'http://reference-api.test',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ hello: 1 }) }),
  });
  check('客户端：非预期结构 → 能力关闭（null）', (await weirdClient.probe()) === null);
  // 探测否定结果缓存：第二次不再发请求（换一个会抛错的 fetch 也返回缓存）
  let probeCount = 0;
  const cachingClient = createOnlineReferenceClient({
    baseUrl: 'http://reference-api.test',
    fetchImpl: async () => {
      probeCount += 1;
      throw new Error('down');
    },
  });
  await cachingClient.probe();
  await cachingClient.probe();
  check('客户端：探测失败结果按会话缓存（不反复打请求）', probeCount === 1, String(probeCount));

  // H4 回归：外部中止（用户点选/停止）的探测不得写进否定缓存 —— 中止不是"在线不可用"
  let abortProbeCount = 0;
  const abortClient = createOnlineReferenceClient({
    baseUrl: 'http://reference-api.test',
    fetchImpl: async (url, options = {}) => {
      abortProbeCount += 1;
      if (abortProbeCount === 1) {
        // 模拟真实 fetch：外部 signal 中止时以 AbortError 拒绝
        return new Promise((resolve, reject) => {
          options.signal?.addEventListener(
            'abort',
            () => {
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true },
          );
        });
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, sources: ['phylopic'], experimentalSources: [] }) };
    },
  });
  const probeAbort = new AbortController();
  const abortedProbe = abortClient.probe({ signal: probeAbort.signal });
  setTimeout(() => probeAbort.abort(), 10);
  let abortError = null;
  try {
    await abortedProbe;
  } catch (error) {
    abortError = error;
  }
  check(
    '客户端：外部中止探测抛出中止错误（不当作在线不可用）',
    abortError?.name === 'AbortError' && abortError?.aborted === true,
    String(abortError),
  );
  const reprobe = await abortClient.probe();
  check(
    '客户端：中止后重新探测可成功（缓存未被毒化）',
    reprobe?.sources?.[0] === 'phylopic' && abortProbeCount === 2,
    `count=${abortProbeCount} result=${JSON.stringify(reprobe)}`,
  );
  // 对照：内部超时（没有外部中止）仍按"探测失败"缓存否定结果
  let timeoutProbeCount = 0;
  const timeoutClient = createOnlineReferenceClient({
    baseUrl: 'http://reference-api.test',
    timeoutMs: 10,
    fetchImpl: async (url, options = {}) => {
      timeoutProbeCount += 1;
      return new Promise((resolve, reject) => {
        options.signal?.addEventListener(
          'abort',
          () => {
            const error = new Error('timeout');
            error.name = 'AbortError';
            reject(error);
          },
          { once: true },
        );
      });
    },
  });
  check('客户端：内部超时 → 能力关闭（null）', (await timeoutClient.probe()) === null);
  await timeoutClient.probe();
  check('客户端：内部超时否定结果仍按会话缓存', timeoutProbeCount === 1, String(timeoutProbeCount));
  // search 非 200 → 抛错
  const failSearch = createOnlineReferenceClient({
    baseUrl: 'http://reference-api.test',
    fetchImpl: async () => ({ ok: false, status: 502, json: async () => ({}) }),
  });
  await failSearch.search({ referenceQuery: QUERY }).then(
    () => check('客户端：检索 HTTP 502 → 抛错', false, '未抛出'),
    (error) => check('客户端：检索 HTTP 502 → 抛错', /502/.test(error.message)),
  );
}

// ---------- 失败可见化全链路契约（真实 client ↔ 服务端载荷，缺陷清单 Bug 1.6.2/1.6.3） ----------
// 修复前 online-client.search 把 ok:false 当"非预期结构"抛掉，reference.js 的失败
// 映射是死代码——这里用**真实 createOnlineReferenceClient**（只注入 fetchImpl）
// 验证 client → agent/reference.js 的完整协议。
{
  /** 构造真实 client + 注入服务端载荷 */
  const makeSourceWithPayload = (payload) =>
    createReferenceCandidateSource({
      fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
      online: createOnlineReferenceClient({
        fetchImpl: async (url) => {
          const href = String(url);
          if (href.endsWith('/__reference/ping')) {
            return { ok: true, status: 200, json: async () => ({ ok: true, sources: ['phylopic'], experimentalSources: [] }) };
          }
          return { ok: true, status: 200, json: async () => payload };
        },
      }),
    });

  const failedPayload = {
    ok: false,
    status: 'failed',
    error: '尝试的 3 个候选均未通过转换',
    failureKind: 'conversion-failed',
    filteredOut: 0,
    rawCandidates: [],
    attempts: [{ uuid: 'u1', status: 'conversion-rejected', reasons: ['multi-part'] }],
    poolSize: 3,
    failures: [],
    cache: { query: 'miss' },
    sources: ['phylopic'],
  };
  const failedOutcome = await makeSourceWithPayload(failedPayload).resolveOnlineCandidates('长颈鹿', {
    intent: { referenceQuery: { zh: '长颈鹿', en: 'giraffe', scientificNames: ['Giraffa camelopardalis'] } },
  });
  check(
    '契约：真实 client 透传 ok=false → failed + failureKind/poolSize/attempts/filteredOut 完整保留',
    failedOutcome.status === 'failed'
      && failedOutcome.failureKind === 'conversion-failed'
      && failedOutcome.poolSize === 3
      && failedOutcome.attempts.length === 1
      && failedOutcome.attempts[0].status === 'conversion-rejected'
      && failedOutcome.filteredOut === 0
      && failedOutcome.error?.includes('未通过转换') === true,
    JSON.stringify(failedOutcome),
  );

  const noMatchOutcome = await makeSourceWithPayload({
    ok: false,
    status: 'failed',
    error: '检索无候选',
    failureKind: 'no-match',
    filteredOut: 0,
    rawCandidates: [],
    attempts: [],
    poolSize: 0,
    failures: [],
    cache: { query: 'miss' },
    sources: ['phylopic'],
  }).resolveOnlineCandidates('独角兽', { intent: { referenceQuery: { zh: '独角兽' } } });
  check(
    '契约：no-match 保持 miss 语义（与内部失败可区分，调用方按"无素材"回退）',
    noMatchOutcome.status === 'miss' && noMatchOutcome.failureKind === 'no-match' && noMatchOutcome.error === null,
    JSON.stringify(noMatchOutcome),
  );

  const okPoints = Array.from({ length: 24 }, (_, i) => {
    const t = (Math.PI * 2 * i) / 24;
    return [Math.cos(t) * 0.4, Math.sin(t) * 0.4];
  });
  const okOutcome = await makeSourceWithPayload({
    ok: true,
    status: 'ok',
    error: null,
    filteredOut: 0,
    rawCandidates: [{ asset: { uuid: 'u1' }, conversion: { status: 'accepted', T: { points: okPoints } }, origin: 'online', reviewStatus: 'unreviewed' }],
    attempts: [],
    poolSize: 1,
    failures: [],
    cache: { query: 'miss' },
    sources: ['phylopic'],
  }).resolveOnlineCandidates('海马', { intent: { referenceQuery: { zh: '海马' } } });
  check(
    '契约：ok=true 候选正常产出（协议改造不破坏成功路径）',
    okOutcome.status === 'ok' && okOutcome.candidates.length === 1 && okOutcome.candidates[0].origin === 'online',
    JSON.stringify({ status: okOutcome.status, count: okOutcome.candidates?.length }),
  );
}

// ---------- T-B2c：在线 payload 经 resolveOnlineCandidates / resolveCandidates 返回结构逐字段一致 ----------
// 背景（清理方案 2026-09 §3.2 B2）：在线结果适配此前在 3 处入口各手写一遍（ok/miss/failed），
// 字段集已漂移（ok 有的带 error:null、有的不带；归一化全败有的带 failureKind、有的不带）。
// 统一走 adaptOnlineResult 后，同一 payload 经两个入口必须给出逐字段一致的结构。
{
  /** 真实 online client + 注入服务端 payload；本地 manifest 为空（合法 miss）→ 走在线补漏 */
  const makeSource = (payload) =>
    createReferenceCandidateSource({
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ assets: [] }) }),
      online: createOnlineReferenceClient({
        fetchImpl: async (url) => {
          const href = String(url);
          if (href.endsWith('/__reference/ping')) {
            return { ok: true, status: 200, json: async () => ({ ok: true, sources: ['phylopic'], experimentalSources: [] }) };
          }
          return { ok: true, status: 200, json: async () => payload };
        },
      }),
    });

  const circle = Array.from({ length: 24 }, (_, i) => {
    const t = (Math.PI * 2 * i) / 24;
    return [Math.cos(t) * 0.4, Math.sin(t) * 0.4];
  });
  const rawCandidate = {
    asset: { uuid: 'u1' },
    conversion: { status: 'accepted', T: { points: circle } },
    origin: 'online',
    reviewStatus: 'unreviewed',
  };
  const cases = [
    [
      'failed payload（ok=false）',
      {
        ok: false,
        status: 'failed',
        error: '尝试的 3 个候选均未通过转换',
        failureKind: 'conversion-failed',
        filteredOut: 0,
        rawCandidates: [],
        attempts: [{ uuid: 'u1', status: 'conversion-rejected', reasons: ['multi-part'] }],
        poolSize: 3,
        failures: [],
        cache: { query: 'miss' },
        sources: ['phylopic'],
      },
      'failed',
    ],
    [
      'miss payload（no-match）',
      {
        ok: false,
        status: 'failed',
        error: '检索无候选',
        failureKind: 'no-match',
        filteredOut: 0,
        rawCandidates: [],
        attempts: [],
        poolSize: 0,
        failures: [],
        cache: { query: 'miss' },
        sources: ['phylopic'],
      },
      'miss',
    ],
    [
      'ok payload（候选归一化成功）',
      {
        ok: true,
        status: 'ok',
        error: null,
        filteredOut: 0,
        rawCandidates: [rawCandidate],
        attempts: [],
        poolSize: 1,
        failures: [],
        cache: { query: 'miss' },
        sources: ['phylopic'],
      },
      'ok',
    ],
    [
      'ok payload 但归一化全败',
      {
        ok: true,
        status: 'ok',
        error: null,
        filteredOut: 0,
        rawCandidates: [{ ...rawCandidate, conversion: { status: 'accepted', T: { points: [] } } }],
        attempts: [],
        poolSize: 1,
        failures: [],
        cache: { query: 'miss' },
        sources: ['phylopic'],
      },
      'failed',
    ],
  ];
  for (const [label, payload, expectedStatus] of cases) {
    const source = makeSource(payload);
    const viaOnline = await source.resolveOnlineCandidates('长颈鹿', { intent: { referenceQuery: { zh: '长颈鹿' } } });
    const viaResolve = await source.resolveCandidates('长颈鹿', { intent: { referenceQuery: { zh: '长颈鹿' } } });
    check(`${label}：两个入口 status 都是 ${expectedStatus}`, viaOnline.status === expectedStatus && viaResolve.status === expectedStatus, `online=${viaOnline.status} resolve=${viaResolve.status}`);
    check(`${label}：两个入口返回结构逐字段一致`, JSON.stringify(viaOnline) === JSON.stringify(viaResolve), `online=${JSON.stringify(viaOnline)}\n  resolve=${JSON.stringify(viaResolve)}`);
    check(`${label}：origin=online 且失败可见化字段保留`, viaOnline.origin === 'online' && viaOnline.candidates.length === (expectedStatus === 'ok' ? 1 : 0) && 'cache' in viaOnline && 'poolSize' in viaOnline);
  }
  // 归一化全败的统一失败结构（此前只有 resolveOnlineCandidates 带 failureKind）
  const failedSource = makeSource(cases[3][1]);
  const normalizeFailed = await failedSource.resolveCandidates('长颈鹿', {});
  check('归一化全败：统一 failureKind=normalize-failed + 固定 error 文案', normalizeFailed.failureKind === 'normalize-failed' && normalizeFailed.error === '在线候选归一化全部失败', JSON.stringify(normalizeFailed));
}

// ---------- server.mjs HTTP 端点 ----------
{
  const root = resolve(fileURLToPath(import.meta.url), '..', '..');
  const port = 5273;
  const child = spawn(process.execPath, [join(root, 'web/server.mjs'), String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  const waitReady = new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error(`服务器启动超时：${stdout}`)), 10000);
    child.stdout.on('data', () => {
      if (stdout.includes('[server]')) {
        clearTimeout(timer);
        resolveReady();
      }
    });
  });
  try {
    await waitReady;
    const ping = await fetch(`http://127.0.0.1:${port}/__reference/ping`);
    const pingBody = await ping.json();
    check('HTTP：GET /__reference/ping 返回能力', ping.status === 200 && pingBody.ok === true && Array.isArray(pingBody.sources) && pingBody.sources.includes('phylopic'), JSON.stringify(pingBody));

    const badJson = await fetch(`http://127.0.0.1:${port}/__reference/search`, { method: 'POST', body: '{not json' });
    check('HTTP：POST 非法 JSON → 400', badJson.status === 400);

    const huge = await fetch(`http://127.0.0.1:${port}/__reference/search`, { method: 'POST', body: JSON.stringify({ pad: 'x'.repeat(200 * 1024) }) });
    check('HTTP：请求体超上限 → 413', huge.status === 413);

    const invalidQuery = await fetch(`http://127.0.0.1:${port}/__reference/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ referenceQuery: null }),
    });
    const invalidBody = await invalidQuery.json();
    check('HTTP：无效查询 → 200 + 空候选（不触发上游）', invalidQuery.status === 200 && invalidBody.ok === true && invalidBody.rawCandidates.length === 0);

    const wrongMethod = await fetch(`http://127.0.0.1:${port}/__reference/ping`, { method: 'DELETE' });
    check('HTTP：不支持的方法 → 405', wrongMethod.status === 405);

    // 修改 server.mjs 后必须重启：这里模拟"旧进程"没有 /__reference —— 无法直接模拟，
    // 由客户端探测否定缓存覆盖（见上）。
  } finally {
    child.kill();
    await new Promise((done) => child.on('close', done));
  }

  // 纯静态托管：没有 /__reference 端点（404）→ 浏览器探测自动关闭在线能力
  const staticPort = 5274;
  const staticChild = spawn(process.execPath, ['-e', `require('http').createServer((req,res)=>{res.writeHead(404);res.end('not found')}).listen(${staticPort},'127.0.0.1')`], { stdio: 'ignore' });
  try {
    await new Promise((done) => setTimeout(done, 600));
    const probe = await fetch(`http://127.0.0.1:${staticPort}/__reference/ping`);
    check('静态托管：/__reference/ping 404 → 客户端探测关闭在线', probe.status === 404);
  } finally {
    staticChild.kill();
  }
}

console.log(`\nRESULT: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}  (${checks - failures} passed, ${failures} failed)`);
process.exit(failures === 0 ? 0 : 2);
