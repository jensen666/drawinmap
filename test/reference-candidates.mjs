/**
 * 参考候选编排测试（Node 直接运行，无网络）。
 *
 * 覆盖（方案 2026-10-31 §5/§11.1）：
 * - resolveReferenceCandidates：收集全部成功、maxAttempts 上限、全失败/检索失败、
 *   许可过滤、中止信号；
 * - buildReferenceCandidates（浏览器归一化补位）：limit 截断、归一化失败消耗池位置、
 *   contentHash 稳定性与敏感性；
 * - 本地多候选（真实 manifest）：猫 2 版本 / 马 3 版本、§5.5 分层排序
 *   （shapeName 缺失跳层、traits∩tags、转换偏差）、歧义与 miss。
 *
 * 运行：node test/reference-candidates.mjs
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLocalReferenceSource, matchReferenceAssets } from '../web/src/reference/browser.js';
import { resolveReferenceCandidates } from '../web/src/reference/retrieval/resolve.js';
import { buildReferenceCandidates, normalizeRawReferenceCandidate } from '../web/src/agent/reference.js';
import { computeReferenceContentHash, sha256NormalizedText } from '../web/src/reference/hash.js';
import { normalizeCustomShape } from '../web/src/agent/intent.js';

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

// ---------- resolveReferenceCandidates：共享编排 ----------
{
  const good = (id, deviationPct) => async (candidate) => `svg:${candidate.id || candidate.uuid}`;
  const convertOk = (svgText, candidate) => ({
    status: 'accepted',
    T: { points: [[-0.4, -0.4], [0.4, -0.4], [0.4, 0.4], [-0.4, 0.4]] },
    metrics: { sourceToTargetMaxPct: candidate.deviationPct ?? 1 },
  });
  const convertReject = () => ({ status: 'rejected', reasons: [{ code: 'multi-part' }] });

  // 收集全部成功（不在成功 3 个时提前停止——§5.3）
  {
    const candidates = [1, 2, 3, 4, 5].map((id) => ({ id: `c${id}`, licenseAllowed: true, vectorUrl: 'https://x/y.svg' }));
    const result = await resolveReferenceCandidates({
      query: {},
      listCandidates: async () => candidates,
      rank: null,
      downloadSvg: good(),
      convert: convertOk,
      maxAttempts: 6,
    });
    check('编排：收集全部成功候选（不因成功 3 个提前停止）', result.status === 'ok' && result.rawCandidates.length === 5 && result.attempts.length === 5, JSON.stringify({ raw: result.rawCandidates.length, attempts: result.attempts.length }));
  }

  // maxAttempts 上限（§5.3：最多尝试 6 个）
  {
    const candidates = Array.from({ length: 9 }, (_, i) => ({ id: `c${i}`, licenseAllowed: true, vectorUrl: 'u' }));
    const result = await resolveReferenceCandidates({
      query: {},
      listCandidates: async () => candidates,
      rank: null,
      downloadSvg: good(),
      convert: convertOk,
      maxAttempts: 6,
    });
    check('编排：maxAttempts=6 上限生效', result.rawCandidates.length === 6 && result.attempts.length === 6);
  }

  // 下载/转换失败收集 + 全失败
  {
    const candidates = [1, 2, 3].map((id) => ({ id: `c${id}`, licenseAllowed: true, vectorUrl: 'u' }));
    const result = await resolveReferenceCandidates({
      query: {},
      listCandidates: async () => candidates,
      rank: null,
      downloadSvg: async (candidate) => {
        if (candidate.id === 'c1') throw new Error('HTTP 500');
        return 'svg';
      },
      convert: (svg, candidate) => (candidate.id === 'c2' ? convertReject() : convertOk(svg, candidate)),
      maxAttempts: 6,
    });
    check('编排：下载失败记录 download-failed', result.attempts[0].status === 'download-failed');
    check('编排：转换拒绝记录 conversion-rejected', result.attempts[1].status === 'conversion-rejected' && result.attempts[1].reasons.includes('multi-part'));
    check('编排：成功候选照常收集', result.status === 'ok' && result.rawCandidates.length === 1);
    const allFail = await resolveReferenceCandidates({
      query: {},
      listCandidates: async () => candidates,
      rank: null,
      downloadSvg: good(),
      convert: convertReject,
      maxAttempts: 6,
    });
    check('编排：全部转换失败 → failed + 原因', allFail.status === 'failed' && allFail.rawCandidates.length === 0 && allFail.error.includes('转换'));
  }

  // 检索失败 / 许可过滤
  {
    const failed = await resolveReferenceCandidates({
      query: {},
      listCandidates: async () => {
        throw new Error('网络断开');
      },
      rank: null,
      downloadSvg: good(),
      convert: convertOk,
    });
    check('编排：检索失败 → failed', failed.status === 'failed' && failed.error.includes('检索失败'));
    const filtered = await resolveReferenceCandidates({
      query: {},
      listCandidates: async () => [
        { id: 'bad', licenseAllowed: false, vectorUrl: 'u' },
        { id: 'good', licenseAllowed: true, vectorUrl: 'u' },
      ],
      rank: null,
      downloadSvg: good(),
      convert: convertOk,
    });
    check('编排：许可不可用候选被过滤', filtered.poolSize === 1 && filtered.rawCandidates[0].asset.id === 'good');
  }

  // 中止信号（§9.2 传播）
  {
    const controller = new AbortController();
    const candidates = [1, 2, 3].map((id) => ({ id: `c${id}`, licenseAllowed: true, vectorUrl: 'u' }));
    let aborted = false;
    await resolveReferenceCandidates({
      query: {},
      listCandidates: async () => candidates,
      rank: null,
      downloadSvg: async (candidate) => {
        if (candidate.id === 'c2') {
          controller.abort();
          aborted = true;
        }
        return 'svg';
      },
      convert: convertOk,
      signal: controller.signal,
    }).then(
      () => check('编排：中止信号上抛 AbortError', false, '未抛出'),
      (error) => check('编排：中止信号上抛 AbortError', aborted && error.name === 'AbortError'),
    );
  }
}

// ---------- buildReferenceCandidates：归一化补位 + contentHash ----------
{
  const shapeOf = (name) => normalizeCustomShape({ name, points: [[-0.4, -0.4], [0.4, -0.4], [0.4, 0.4], [-0.4, 0.4], [-0.1, 0.1]] });
  const rawOf = (id, customShape) => ({
    asset: { id, names: { zh: [nameOf(id)] }, source: { license: 'CC0-1.0' } },
    conversion: { status: 'accepted', T: { points: pointsOf(customShape) }, metrics: {} },
    matchedAlias: '测试',
    sourceSha256: sha256NormalizedText(`svg:${id}`),
    origin: 'local',
    reviewStatus: 'curated',
  });
  const pointsOf = (shape) => shape.outlinePoints.map((p) => [p[0], p[1]]);
  const nameOf = (id) => id;

  // limit 截断
  {
    const raws = ['a', 'b', 'c', 'd', 'e'].map((id) => rawOf(id, shapeOf(id)));
    const { candidates, failures } = buildReferenceCandidates(raws, { limit: 3 });
    check('归一化：limit=3 截断', candidates.length === 3 && failures.length === 0);
    check('归一化：candidate 结构完整（contentHash/origin/reviewStatus）', candidates.every((c) => c.contentHash && c.origin === 'local' && c.reviewStatus === 'curated' && c.customShape.outlinePoints.length > 0));
  }

  // 归一化失败补位（§5.3）：失败消耗池位置、追加 failures、后续候选顶上
  {
    const badRaw = {
      asset: { id: 'bad', names: { zh: ['坏'] } },
      conversion: { status: 'accepted', T: { points: [[0, 0], [0.01, 0], [0.02, 0]] }, metrics: {} },
      sourceSha256: 'x',
      origin: 'local',
      reviewStatus: 'curated',
    };
    const raws = [badRaw, rawOf('b', shapeOf('b')), badRaw, rawOf('d', shapeOf('d')), rawOf('e', shapeOf('e'))];
    const { candidates, failures } = buildReferenceCandidates(raws, { limit: 3 });
    check('归一化：失败候选消耗池位置并记 failures', failures.length === 2 && failures.every((f) => f.reason === 'normalize-failed'));
    check('归一化：后续候选顶上补位到 limit', candidates.length === 3 && candidates.map((c) => c.asset.id).join(',') === 'b,d,e');
  }

  // contentHash 稳定与敏感性（§7.2）
  {
    const shapeA = normalizeCustomShape({ name: 'a', points: [[-0.4, -0.4], [0.4, -0.4], [0.4, 0.4], [-0.4, 0.4], [-0.1, 0.1]] });
    const shapeB = normalizeCustomShape({ name: 'a', points: [[-0.45, -0.35], [0.35, -0.4], [0.45, 0.35], [-0.35, 0.4], [-0.12, 0.08]] });
    const rawA = rawOf('a', shapeA);
    const built1 = normalizeRawReferenceCandidate(rawA).candidate;
    const built2 = normalizeRawReferenceCandidate(rawOf('a', shapeA)).candidate;
    check('contentHash：同输入稳定', built1.contentHash === built2.contentHash);
    check('contentHash：素材哈希变化 → 变化', built1.contentHash !== normalizeRawReferenceCandidate({ ...rawA, sourceSha256: 'other' }).candidate.contentHash);
    check('contentHash：customShape 变化 → 变化', built1.contentHash !== normalizeRawReferenceCandidate(rawOf('a', shapeB)).candidate.contentHash);
    check(
      'contentHash：公式 = SHA-256(stableStringify({schema, sourceSha256, converterVersion, conversionOptions, normalizerVersion, customShape}))',
      built1.contentHash === computeReferenceContentHash({ sourceSha256: rawA.sourceSha256, conversionOptions: {}, customShape: built1.customShape }),
    );
  }
}

// ---------- 本地多候选（真实 manifest） ----------
{
  const root = resolve(fileURLToPath(import.meta.url), '..', '..');
  const dataDir = resolve(root, 'web/data/shapes');
  const manifest = JSON.parse(readFileSync(resolve(dataDir, 'manifest.json'), 'utf8'));
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.endsWith('/manifest.json')) {
      return { ok: true, status: 200, json: async () => manifest, text: async () => JSON.stringify(manifest) };
    }
    const match = href.match(/http:\/\/reference\.test\/(.+)$/);
    if (match) {
      return { ok: true, status: 200, text: async () => readFileSync(resolve(dataDir, match[1]), 'utf8') };
    }
    return { ok: false, status: 404, text: async () => '' };
  };
  const source = createLocalReferenceSource({ fetchImpl, manifestUrl: 'http://reference.test/manifest.json', baseUrl: 'http://reference.test/' });

  // 猫 2 版本 / 马 3 版本
  const cats = await source.resolveCandidates('画只猫');
  check('本地多候选：猫返回 2 个 raw 候选', cats.status === 'ok' && cats.rawCandidates.length === 2, JSON.stringify(cats.rawCandidates?.map((r) => r.asset.id)));
  const horses = await source.resolveCandidates('画匹马');
  check('本地多候选：马返回 3 个 raw 候选', horses.status === 'ok' && horses.rawCandidates.length === 3);
  check(
    '本地多候选：raw 结构（origin=local / reviewStatus=curated / sourceSha256 与 manifest 一致）',
    horses.rawCandidates.every(
      (raw) =>
        raw.origin === 'local' &&
        raw.reviewStatus === 'curated' &&
        raw.sourceSha256 === manifest.assets.find((asset) => asset.id === raw.asset.id).sha256,
    ),
  );
  check('本地多候选：raw 只带 conversion.T（无 customShape，§5.2）', horses.rawCandidates.every((raw) => raw.conversion.T?.points?.length > 0 && !raw.conversion.customShape));

  // §5.5 分层：traits ∩ tags 优先，同层内按转换偏差
  {
    const dogs = await source.resolveCandidates('画只狗', { traits: ['站姿'] });
    const ids = dogs.rawCandidates.map((raw) => raw.asset.id);
    const tagsOf = (id) => manifest.assets.find((asset) => asset.id === id).tags;
    const overlap0 = ids.filter((id) => !(tagsOf(id) || []).includes('站姿'));
    check('本地排序：traits∩tags 命中者排在未命中者之前', overlap0.length > 0 && ids.indexOf(overlap0[0]) === ids.length - 1, JSON.stringify(ids));
    const first = dogs.rawCandidates[0];
    const second = dogs.rawCandidates[1];
    const sameTier = (tagsOf(first.asset.id) || []).includes('站姿') && (tagsOf(second.asset.id) || []).includes('站姿');
    if (sameTier) {
      check(
        '本地排序：同 traits 层内转换偏差较小者优先',
        first.conversion.metrics.sourceToTargetMaxPct <= second.conversion.metrics.sourceToTargetMaxPct,
        `${first.asset.id}:${first.conversion.metrics.sourceToTargetMaxPct} vs ${second.asset.id}:${second.conversion.metrics.sourceToTargetMaxPct}`,
      );
    }
  }

  // 无 shapeName / 无 traits：排序稳定（全部同层时按 id）
  {
    const dogsNoTraits = await source.resolveCandidates('画只狗');
    const ids = dogsNoTraits.rawCandidates.map((raw) => raw.asset.id);
    const sorted = [...ids].sort((a, b) => a.localeCompare(b));
    const devs = dogsNoTraits.rawCandidates.map((raw) => raw.conversion.metrics.sourceToTargetMaxPct);
    const devSorted = [...devs].sort((a, b) => a - b);
    check('本地排序：无 traits 时按偏差+id 稳定排序', JSON.stringify(ids) === JSON.stringify(sorted) || JSON.stringify(devs) === JSON.stringify(devSorted), JSON.stringify(ids));
  }

  // 归一化后统一候选
  {
    const { buildReferenceCandidates: build } = await import('../web/src/agent/reference.js');
    const built = build(horses.rawCandidates, { limit: 3 });
    check('本地多候选：归一化后 3 个统一候选', built.candidates.length === 3 && built.failures.length === 0);
    check('本地多候选：统一候选带 contentHash 与 trim 后 conversion（无 R 环）', built.candidates.every((c) => c.contentHash && c.conversion && !c.conversion.R));
  }

  // 歧义 / miss
  {
    // 方案 2026-11-01 §2 词边界：无标点连写时「马匹画只狗」会被并入同一连续汉字串，
    // 故测试文本带标点（逗号是非汉字，词边界在「马」处停止），以保留多对象语义。
    // 方案 2026-11-05 §4.1/§4.2：多对象命中不再整条通道让位（'ambiguous'），
    // 而是按对象分组结构化返回（'multi'），调用方据此判断是否有缺失对象。
    const multi = await source.resolveCandidates('画匹马，画只狗');
    check(
      '本地多候选：多对象 → multi（按对象分组，不静默丢对象）',
      multi.status === 'multi'
        && multi.rawCandidates.length > 0
        && Array.isArray(multi.objectGroups)
        && multi.objectGroups.length === 2
        && multi.objectGroups.every((group) => group.rawCandidates.length > 0),
      JSON.stringify({ status: multi.status, groups: multi.objectGroups?.length ?? null }),
    );
    const miss = await source.resolveCandidates('推荐一条散步路线');
    check('本地多候选：无关文本 → miss', miss.status === 'miss');
  }

  // maxAttempts 传透（猫 2 候选 + maxAttempts 1 → 只尝试 1 个）
  {
    const cats = await source.resolveCandidates('画只猫', { maxAttempts: 1 });
    check('本地多候选：maxAttempts 传透', cats.attempts.length === 1 && cats.rawCandidates.length === 1);
  }
}

// ---------- matchReferenceAssets 消歧补充 ----------
{
  const root = resolve(fileURLToPath(import.meta.url), '..', '..');
  const manifest = JSON.parse(readFileSync(resolve(root, 'web/data/shapes/manifest.json'), 'utf8'));
  const nested = matchReferenceAssets('画只猫头鹰', manifest.assets);
  check('消歧：猫头鹰单对象（嵌套的「猫」被归并）', nested.status === 'ok' && nested.matches.length === 1 && nested.matches[0].asset.names.zh[0] === '猫头鹰', JSON.stringify(nested));
  const horseOnly = matchReferenceAssets('珠江新城旁边画只猫头鹰和星', manifest.assets);
  check('消歧：珠江新城（含「江」地名）不干扰', horseOnly.status === 'ok' && horseOnly.matches.length === 1);
}

console.log(`\nRESULT: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}  (${checks - failures} passed, ${failures} failed)`);
process.exit(failures === 0 ? 0 : 2);
