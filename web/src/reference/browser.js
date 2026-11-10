/**
 * 浏览器端本地参考图源：加载 web/data/shapes/manifest.json + 素材 SVG，
 * 按用户文本里的别名匹配 → convertSvg → T 点序列。
 *
 * 方案 2026-10-31（多候选）：
 * - matchReferenceAssets 返回同一对象的全部素材版本（马 3 / 狗 3 / 猫 2…），
 *   单命中 matchReferenceAsset 保留为兼容包装；
 * - manifest 浏览器加载时拒绝非 approved 条目（方案 §4.2，Node 校验负责强制检查）；
 * - resolveCandidates 走共享编排 resolveReferenceCandidates（§5.1），
 *   本地排序按 §5.5（shapeName 精确 > traits∩tags > 转换偏差 > id 稳定）；
 * - 在线检索不在此文件内（web/src/reference/online-client.js + server.mjs）。
 *
 * 方案 2026-11-01（长尾图形轮廓来源与贴路上限）§2「A 词边界」：
 * - 单字中文别名必须占满它所在的连续汉字词：取「别名 + 右侧紧邻连续汉字」构成的串，
 *   串等于别名、或等于同一素材已登记的长别名才算词边界命中；否则该位置不命中；
 * - 词边界与原有单字语境守卫（单独输入 / 绘图动词量词前缀 / 形状后缀）是合取关系；
 * - 多字别名、地名后缀守卫、嵌套归并、ASCII 词边界维持现状。
 *
 * 方案 2026-11-05（交付正确性）§4.1「匹配区间归并」：
 * - 别名命中从布尔扩展为**实际匹配区间**（start/end），不再用「别名长度」判断归属；
 * - 归并规则：短命中区间**真正被**更长命中区间包含时才算嵌套（同一位置），
 *   并列且不相交的命中一律保留——不因别名长度不同而删掉另一个对象；
 * - 同一区间的多个命中若分属不同对象 → 返回 collision（配置碰撞），
 *   绝不按 manifest 排列顺序任选一个；
 * - 同一对象的多个素材版本仍是合法候选（按对象分组，不误判为多对象）。
 *
 * 只依赖 fetch 与 DOM-free 的 convert.js；不引入 node:fs。
 */

import { convertSvg } from "./convert.js";
import { resolveReferenceCandidates, REFERENCE_CANDIDATE_LIMIT, REFERENCE_MAX_ATTEMPTS } from "./retrieval/resolve.js";
import { sha256NormalizedText } from "./hash.js";
import { ALLOWED_REFERENCE_LICENSES } from "./licenses.js";

/** 正式 seed manifest 的默认地址（从 web/src/reference/ 指向 web/data/shapes/） */
const DEFAULT_MANIFEST_URL = new URL("../../data/shapes/manifest.json", import.meta.url);

/** 轻量 manifest 校验（浏览器端不做 sha256，Node 测试/构建阶段负责）。
 * 结构性错误整表拒绝；非 approved 条目按方案 §4.2 过滤（不入候选池）。 */
function validateBrowserManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || !Array.isArray(manifest.assets)) {
    throw new Error("参考图 manifest 缺少 assets");
  }
  const approved = [];
  for (const asset of manifest.assets) {
    if (!asset?.id || !asset.file || typeof asset.file !== "string" || asset.file.includes("..")) {
      throw new Error(`参考图 manifest 条目非法：${asset?.id || "?"}`);
    }
    if (!ALLOWED_REFERENCE_LICENSES.includes(asset.source?.license)) {
      throw new Error(`参考图许可不在白名单：${asset.id} ${asset.source?.license}`);
    }
    if (asset.review?.status === "approved") {
      approved.push(asset);
    }
  }
  return { ...manifest, assets: approved };
}

/** 文本归一化（小写、去首尾空白） */
function normalizeText(text) {
  return String(text || "").toLowerCase().trim();
}

/** 纯 ASCII 别名（英文匹配需要词边界，防止 cat ⊂ category 这类误劫持） */
function isAsciiAlias(needle) {
  return /^[a-z0-9][a-z0-9 \-'&.]*$/.test(needle);
}

function isWordChar(ch) {
  return /[a-z0-9]/i.test(ch || "");
}

/**
 * ASCII 别名的全部命中区间（词边界两侧不能是字母/数字）。
 *
 * @param {string} haystack 归一化文本
 * @param {string} needle 归一化别名
 * @returns {Array<{start: number, end: number}>} 命中区间（半开区间 [start, end)）
 */
function asciiAliasIntervals(haystack, needle) {
  const out = [];
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    const before = index > 0 ? haystack[index - 1] : "";
    const after = index + needle.length < haystack.length ? haystack[index + needle.length] : "";
    if (!isWordChar(before) && !isWordChar(after)) {
      out.push({ start: index, end: index + needle.length });
    }
    index = haystack.indexOf(needle, index + 1);
  }
  return out;
}

/** 绘图动词/量词前缀正则：单字别名只有紧邻“直接绘图动词”（画/绘/描）或
 * “绘图/路线动词 + 量词”（画个/走个/跑个/来只/画匹/规划一条等）才认定是图形请求。
 * 绝不把裸量词（个/只）单独当触发前缀——否则“个人觉得”“一个人”“两只狗旁边的路”
 * 会把非图形词误劫持为参考图。 */
const SINGLE_CHAR_PREFIX_PATTERN =
  /(?:(?:画|绘|描)|(?:画|绘|描|走|跑|来|生成|规划)(?:一个|一只|一匹|一条|一头|一群|一张|个|只|匹|条|头|群|张))$/;

/** 形状名后缀正则：单字别名紧邻这些后缀（人形/马状/人剪影/人轮廓）等同图形请求 */
const SINGLE_CHAR_SUFFIX_PATTERN = /^(?:形|状|型|图|剪影|轮廓|字形)/;

/** 是否单字中文别名（只对它做语境过滤；多字别名裸子串语义足够强） */
function isSingleCjkAlias(needle) {
  return needle.length === 1 && /[\u4e00-\u9fff]/.test(needle);
}

/** 汉字字符（词边界取串用，与单字别名的汉字判定口径一致） */
const CJK_CHAR_PATTERN = /[\u4e00-\u9fff]/;

/** 并连词字符（缺陷清单 2026-11-06 Bug 4.3）：单字别名向右取串时遇到即截断——
 * 「猫和兔子」里"猫"的右取串此前会吞掉「和兔子」导致词边界不命中。
 * 注意「、」「，」不是汉字（U+3001/U+FF0C 不在 一-鿿），本来就截断。 */
const CONJUNCTIVE_CHARS = new Set(['和', '与', '及', '跟', '同', '或', '并', '加']);

/**
 * 单字别名词边界判断（方案 2026-11-01 §2）：在 index 处取「别名 + 右侧紧邻连续汉字」
 * 构成的串（遇到非汉字字符或并连词停止；左侧不参与取串）。
 * - 串 == 别名本身 → 通过；
 * - 串 == 同一素材已登记的更长别名 → 通过；
 * - 串比别名长且不是同一素材已登记别名 → 该位置不通过。
 * 右侧多出来的字是什么不看，不设「子 / 公 / 母」这类后缀白名单。
 * 并连词截断（缺陷清单 Bug 4.3.4.1）：「猫和兔子」的"猫"取串在「和」处停止 →
 * 词 = "猫" → 命中；「人民广场」的"人"右取串仍是「人民广场」→ 不命中（不过度匹配）。
 *
 * @param {string} haystack 归一化文本
 * @param {number} index 当前别名出现位置
 * @param {string} needle 单字中文别名（已归一化）
 * @param {Set<string>} registeredAliases 同一素材已登记别名集合（已归一化）
 * @returns {boolean}
 */
function singleCharWordFits(haystack, index, needle, registeredAliases) {
  let end = index + needle.length;
  while (end < haystack.length && CJK_CHAR_PATTERN.test(haystack[end]) && !CONJUNCTIVE_CHARS.has(haystack[end])) {
    end += 1;
  }
  const word = haystack.slice(index, end);
  return word === needle || registeredAliases.has(word);
}

/**
 * 单字别名的全部命中区间：逐个出现位置检查，该位置必须同时满足（合取）：
 * 1) 词边界（方案 2026-11-01 §2）：见 singleCharWordFits，别名的词被更长未登记串占据则不命中；
 * 2) 图形请求语境（方案 5.6，维持原实现）：单独输入、紧邻绘图动词/量词前缀
 *    （画只猫/画匹马/走个人形）、或后接形状后缀（人形）三者之一。
 * "人民广场画个人"里首个"人"无语境，但"画个"后的"人"两者都通过。
 *
 * @param {string} haystack 归一化文本
 * @param {string} needle 单字中文别名（已归一化）
 * @param {Set<string>} registeredAliases 同一素材已登记别名集合（已归一化）
 * @returns {Array<{start: number, end: number}>} 命中区间
 */
function singleCharAliasIntervals(haystack, needle, registeredAliases) {
  const out = [];
  for (let index = haystack.indexOf(needle); index >= 0; index = haystack.indexOf(needle, index + 1)) {
    if (!singleCharWordFits(haystack, index, needle, registeredAliases)) {
      continue; // 词边界不通过：该出现位置不命中（方案 §2）
    }
    const before = haystack.slice(0, index);
    const after = haystack.slice(index + needle.length);
    if (before === "" && after === "") {
      out.push({ start: index, end: index + needle.length }); // 单独输入
      continue;
    }
    if (SINGLE_CHAR_PREFIX_PATTERN.test(before) || SINGLE_CHAR_SUFFIX_PATTERN.test(after)) {
      out.push({ start: index, end: index + needle.length });
    }
  }
  return out;
}

/**
 * 单个别名是否命中文本（按别名类型分派匹配规则）。
 */
/** 地名后缀守卫（方案 §4.3：多字别名不得因扩容新增明显地点误劫持）：
 * 「月亮湾」「苹果园」这类"对象名 + 地名后缀"是地点而非画图请求，
 * 多字别名紧邻这些后缀时不命中（单字别名已有绘图语境守卫，不需要这层）。 */
const PLACE_SUFFIX_CHARS = new Set(
  ['湾', '岛', '山', '江', '河', '湖', '路', '街', '村', '镇', '港', '洲', '巷', '桥', '站', '园', '城', '门', '场', '口', '滩', '岗', '塔', '楼'],
);

/**
 * 多字别名的全部命中区间：逐个出现位置检查，紧邻地名后缀的出现位置不算。
 *
 * @param {string} haystack 归一化文本
 * @param {string} needle 归一化别名
 * @returns {Array<{start: number, end: number}>} 命中区间
 */
function multiCharAliasIntervals(haystack, needle) {
  const out = [];
  for (let index = haystack.indexOf(needle); index >= 0; index = haystack.indexOf(needle, index + 1)) {
    const after = haystack[index + needle.length];
    if (after && PLACE_SUFFIX_CHARS.has(after)) {
      continue;
    }
    out.push({ start: index, end: index + needle.length });
  }
  return out;
}

/**
 * 单个别名的全部命中区间（按别名类型分派匹配规则）。
 *
 * @param {string} haystack 归一化文本
 * @param {string} needle 归一化别名
 * @param {Set<string>} registeredAliases 同一素材已登记别名集合（单字中文别名词边界需要）
 * @returns {Array<{start: number, end: number}>} 命中区间（半开区间）
 */
function aliasIntervals(haystack, needle, registeredAliases) {
  if (isAsciiAlias(needle)) {
    return asciiAliasIntervals(haystack, needle);
  }
  if (isSingleCjkAlias(needle)) {
    return singleCharAliasIntervals(haystack, needle, registeredAliases);
  }
  return multiCharAliasIntervals(haystack, needle);
}

/** 对象的规范键（同一对象的不同素材版本共用）：中文名优先，缺省用素材 id */
function objectKeyOf(asset) {
  return normalizeText(asset?.names?.zh?.[0] ?? asset?.id ?? "");
}

/** 对象的展示名 */
function objectNameOf(asset) {
  return normalizeText(asset?.names?.zh?.[0] ?? asset?.names?.en?.[0] ?? asset?.id ?? "");
}

/**
 * 在素材里找出文本命中的全部素材版本（方案 2026-10-31 §5 多候选 + 2026-11-05 §4.1 区间归并）。
 *
 * 命中消歧规则（2026-11-05 §4.1，按匹配区间而不是别名长度）：
 * 1. 每个有效命中记录 start/end、素材、对象与别名；
 * 2. 短命中区间**真正被**更长命中区间包含时按嵌套归并（同一位置才算包含）；
 * 3. 并列且不相交的命中一律保留——不因别名长度不同而删掉另一个对象；
 * 4. 同一对象的多个素材版本是合法候选，按对象分组而不是按素材计对象数；
 * 5. 同一区间分属不同对象 → status='collision'（配置碰撞），不按 manifest 顺序任选一个。
 *
 * 状态：
 * - 'ok'：只命中一个对象（matches 为该对象的全部素材版本）；
 * - 'multi'：命中多个对象（matches 为全部命中，objectGroups 按对象分组）；
 * - 'collision'：同一区间对应不同对象（配置冲突，不得任选其一）；
 * - 'miss'：没有命中。
 *
 * @param {string} text 用户文本
 * @param {Array<object>} assets manifest 素材（已过滤 approved）
 * @returns {{status: 'ok'|'miss'|'multi'|'collision',
 *   matches: Array<{asset: object, matchedAlias: string, start: number, end: number,
 *     objectKey: string, objectName: string}>,
 *   objects?: string[], objectGroups?: Array<{objectKey: string, objectName: string, matches: Array<object>}>,
 *   reason?: string, collision?: {start: number, end: number, objects: string[]}}}
 */
export function matchReferenceAssets(text, assets) {
  const haystack = normalizeText(text);
  if (!haystack) {
    return { status: "miss", matches: [], reason: "empty-text" };
  }

  /** @type {Array<{asset: object, matchedAlias: string, start: number, end: number, objectKey: string, objectName: string}>} */
  const rawHits = [];
  for (const asset of assets || []) {
    // 同一素材已登记别名集合（names.zh + names.en + aliases 归一化）：
    // 单字中文别名做词边界时用它判定「更长的串是不是本素材已登记别名」（方案 2026-11-01 §2）。
    const names = [
      ...(asset.names?.zh || []),
      ...(asset.names?.en || []),
      ...(asset.aliases || []),
    ]
      .map((name) => normalizeText(name))
      .filter(Boolean);
    const registeredAliases = new Set(names);
    const objectKey = objectKeyOf(asset);
    const objectName = objectNameOf(asset);
    for (const needle of registeredAliases) {
      for (const interval of aliasIntervals(haystack, needle, registeredAliases)) {
        rawHits.push({
          asset,
          matchedAlias: needle,
          start: interval.start,
          end: interval.end,
          objectKey,
          objectName,
        });
      }
    }
  }
  if (rawHits.length === 0) {
    return { status: "miss", matches: [], reason: "no-hit" };
  }

  // 同一素材同一区间可能被多条别名命中（如「兔」与「兔子」都登记在同一素材上）：
  // 保留最长别名，区间不变。
  const byAssetInterval = new Map();
  for (const hit of rawHits) {
    const key = `${hit.asset.id} ${hit.start} ${hit.end}`;
    const prev = byAssetInterval.get(key);
    if (!prev || hit.matchedAlias.length > prev.matchedAlias.length) {
      byAssetInterval.set(key, hit);
    }
  }
  const hits = [...byAssetInterval.values()];

  // 嵌套归并：区间 a 被区间 b 真正包含（b.start ≤ a.start 且 a.end ≤ b.end 且区间不等）
  // 时，a 并入 b。并列/相交的命中不算包含关系，一律保留。
  const survivors = hits.filter(
    (hit) =>
      !hits.some(
        (other) =>
          other !== hit &&
          other.start <= hit.start &&
          hit.end <= other.end &&
          !(other.start === hit.start && other.end === hit.end),
      ),
  );

  // 同一区间对应不同对象 → 配置碰撞：不得按 manifest 顺序任选一个。
  const byInterval = new Map();
  for (const hit of survivors) {
    const key = `${hit.start} ${hit.end}`;
    if (!byInterval.has(key)) {
      byInterval.set(key, []);
    }
    byInterval.get(key).push(hit);
  }
  for (const group of byInterval.values()) {
    const objectKeys = new Set(group.map((hit) => hit.objectKey));
    if (objectKeys.size > 1) {
      return {
        status: "collision",
        matches: [],
        reason: "alias-collision",
        objects: [...new Set(group.map((hit) => hit.objectName))].filter(Boolean),
        collision: {
          start: group[0].start,
          end: group[0].end,
          objects: [...new Set(group.map((hit) => hit.objectName))].filter(Boolean),
        },
      };
    }
  }

  // 按对象分组：同一对象的多个素材版本是合法候选，不算多对象。
  const groups = new Map();
  for (const hit of survivors) {
    if (!groups.has(hit.objectKey)) {
      groups.set(hit.objectKey, { objectKey: hit.objectKey, objectName: hit.objectName, hits: [] });
    }
    groups.get(hit.objectKey).hits.push(hit);
  }
  const objectGroups = [...groups.values()].map((group) => ({
    objectKey: group.objectKey,
    objectName: group.objectName,
    aliases: [...new Set(group.hits.flatMap((hit) => (hit.asset?.aliases || []).map((alias) => normalizeText(alias)).filter(Boolean)))],
    matches: dedupeMatches(group.hits),
  }));
  const objects = objectGroups.map((group) => group.objectName).filter(Boolean);

  if (objectGroups.length > 1) {
    // 命中多个对象：结构化返回（命中对象 + 分组），由调用方决定是组合还是追问，
    // 不靠 manifest 排列顺序挑一个，也不整条通道让位丢掉信息。
    return {
      status: "multi",
      matches: objectGroups.flatMap((group) => group.matches),
      objects,
      objectGroups,
      reason: "multi-object",
    };
  }
  return { status: "ok", matches: objectGroups[0].matches, objects, objectGroups };
}

/** 同一素材可能以多条命中出现（别名互嵌套），保留最长别名 */
function dedupeMatches(matches) {
  const byAsset = new Map();
  for (const match of matches) {
    const prev = byAsset.get(match.asset.id);
    if (!prev || match.matchedAlias.length > prev.matchedAlias.length) {
      byAsset.set(match.asset.id, match);
    }
  }
  return [...byAsset.values()];
}

/**
 * 旧单命中入口（兼容包装）：多命中里按 §5.5 排序取第一。
 */
export function matchReferenceAsset(text, assets) {
  const match = matchReferenceAssets(text, assets);
  if (match.status !== "ok" || match.matches.length === 0) {
    return null;
  }
  const ranked = rankLocalReferenceAssets(match.matches, {});
  return { asset: ranked[0].asset, matchedAlias: ranked[0].matchedAlias };
}

/**
 * 本地候选排序（方案 §5.5 全部分层，一次实现）：
 * 1. shapeName 与资产中文/英文名精确匹配优先于普通别名包含；无 shapeName 时跳过；
 * 2. referenceQuery.traits ∩ asset.tags 数量多者优先；任一侧无标签时整层跳过；
 * 3. R→T 最大转换偏差较小者优先（conversions 未提供时整层跳过——编排只完成
 *    下载/转换后调用方再带 conversions 重排一次）；
 * 4. 以上相同按资产 id 稳定排序。
 *
 * @param {Array<{asset: object, matchedAlias: string}>} matches 命中素材
 * @param {{shapeName?: string|null, traits?: string[], conversions?: Map<string, object>|null}} [options]
 * @returns {Array<{asset: object, matchedAlias: string}>} 排序后的新数组
 */
export function rankLocalReferenceAssets(matches, { shapeName = null, traits = [], conversions = null } = {}) {
  const shapeKey = normalizeText(shapeName);
  const traitList = (Array.isArray(traits) ? traits : []).map((trait) => normalizeText(trait)).filter(Boolean);
  const exactShapeRank = (asset) => {
    if (!shapeKey) {
      return 0; // 无 shapeName：跳过该层（所有候选相等）
    }
    const names = [
      ...(asset.names?.zh || []),
      ...(asset.names?.en || []),
      ...(asset.aliases || []),
    ].map((name) => normalizeText(name));
    return names.includes(shapeKey) ? 0 : 1;
  };
  const traitOverlap = (asset) => {
    if (traitList.length === 0 || !Array.isArray(asset.tags) || asset.tags.length === 0) {
      return 0; // 任一侧无标签：整层跳过
    }
    const tags = asset.tags.map((tag) => normalizeText(tag));
    return traitList.filter((trait) => tags.includes(trait)).length;
  };
  const deviationOf = (asset, conversion) => {
    if (!conversions) {
      return 0; // 无转换结果：跳过偏差层
    }
    const value = conversion?.metrics?.sourceToTargetMaxPct;
    return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
  };
  return matches
    .slice()
    .sort((a, b) => {
      const ca = conversions?.get(a.asset.id) ?? null;
      const cb = conversions?.get(b.asset.id) ?? null;
      return (
        exactShapeRank(a.asset) - exactShapeRank(b.asset) ||
        traitOverlap(b.asset) - traitOverlap(a.asset) ||
        deviationOf(a.asset, ca) - deviationOf(b.asset, cb) ||
        String(a.asset.id).localeCompare(String(b.asset.id))
      );
    });
}

/**
 * 创建浏览器端本地参考图源。
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {string|URL} [options.manifestUrl]
 * @param {string|URL} [options.baseUrl] 素材根路径，缺省取 manifest 所在目录
 * @returns {{resolve: (text: string) => Promise<object|null>,
 *   resolveCandidates: (text: string, options?: object) => Promise<object>}}
 */
export function createLocalReferenceSource({ fetchImpl = globalThis.fetch, manifestUrl = DEFAULT_MANIFEST_URL, baseUrl = null } = {}) {
  const manifestHref = String(manifestUrl);
  const assetBase = baseUrl ? new URL(String(baseUrl)) : new URL(".", manifestHref);
  let manifestPromise = null;
  const svgCache = new Map();
  const conversionCache = new Map();

  async function loadManifest() {
    if (!manifestPromise) {
      manifestPromise = (async () => {
        const response = await fetchImpl(manifestHref);
        if (!response.ok) throw new Error(`参考图 manifest 加载失败：HTTP ${response.status}`);
        return validateBrowserManifest(await response.json());
      })();
    }
    return manifestPromise;
  }

  async function loadSvg(asset) {
    if (!svgCache.has(asset.id)) {
      svgCache.set(
        asset.id,
        (async () => {
          const response = await fetchImpl(new URL(asset.file, assetBase).href);
          if (!response.ok) throw new Error(`参考图素材加载失败：${asset.id} HTTP ${response.status}`);
          return response.text();
        })(),
      );
    }
    return svgCache.get(asset.id);
  }

  async function conversionOf(asset) {
    if (!conversionCache.has(asset.id)) {
      conversionCache.set(
        asset.id,
        (async () => {
          const svgText = await loadSvg(asset);
          const conversion = convertSvg(svgText);
          return conversion.status === "accepted" && conversion.T ? conversion : null;
        })(),
      );
    }
    return conversionCache.get(asset.id);
  }

  /** 旧单命中（兼容）：命中排序第一且转换成功的素材 */
  async function resolve(text) {
    const manifest = await loadManifest();
    const match = matchReferenceAsset(text, manifest.assets);
    if (!match) return null;
    const conversion = await conversionOf(match.asset);
    if (!conversion) return null;
    return { asset: match.asset, matchedAlias: match.matchedAlias, conversion };
  }

  /**
   * 下载 + 转换 + §5.5 重排一组素材，返回 raw candidates（未归一化）。
   *
   * @param {Array<object>} matches 命中素材（每项含 asset/matchedAlias）
   * @param {{shapeName?: string|null, traits?: string[], maxAttempts?: number, signal?: AbortSignal|null}} options
   * @returns {Promise<{rawCandidates: Array<object>, attempts: Array<object>, poolSize: number, error: any}>}
   */
  async function convertMatchedAssets(matches, { shapeName = null, traits = [], maxAttempts = REFERENCE_MAX_ATTEMPTS, signal = null } = {}) {
    const ranked = rankLocalReferenceAssets(matches, { shapeName, traits });
    const aliasById = new Map(matches.map((item) => [item.asset.id, item.matchedAlias]));
    const contentByAsset = new Map();
    const result = await resolveReferenceCandidates({
      query: {
        zh: ranked[0]?.asset.names?.zh?.[0] ?? null,
        en: ranked[0]?.asset.names?.en?.[0] ?? null,
      },
      listCandidates: async () => ranked.map((match) => match.asset),
      rank: null, // 本地排序已在 rankLocalReferenceAssets 完成（§5.5）
      downloadSvg: async (asset) => {
        const svgText = await loadSvg(asset);
        contentByAsset.set(asset.id, svgText);
        return svgText;
      },
      convert: (svgText) => convertSvg(svgText),
      toRawCandidate: (asset, conversion) => ({
        asset,
        conversion,
        matchedAlias: aliasById.get(asset.id) ?? null,
        // 实际下载内容的哈希（与 manifest 条目同口径）；contentHash 据此计算
        sourceSha256: sha256NormalizedText(contentByAsset.get(asset.id) ?? ""),
        origin: "local",
        reviewStatus: "curated",
      }),
      maxAttempts,
      signal,
    });
    // §5.5 完整分层重排：转换已完成，带上偏差层（shapeName > traits > 偏差 > id）
    const conversions = new Map(
      result.rawCandidates.map((raw) => [raw.asset.id, raw.conversion]),
    );
    const ordered = rankLocalReferenceAssets(
      result.rawCandidates.map((raw) => ({ asset: raw.asset, matchedAlias: raw.matchedAlias })),
      { shapeName, traits, conversions },
    ).map((match) => result.rawCandidates.find((raw) => raw.asset.id === match.asset.id));
    return {
      rawCandidates: ordered,
      attempts: result.attempts,
      poolSize: result.poolSize,
      error: result.error,
    };
  }

  /**
   * 多对象命中：每个命中的对象各自下载/转出候选，按对象分组返回。
   *
   * 方案 2026-11-05 §4.2：参考通道只命中部分请求对象时，调用方需要知道
   * 「命中了哪些对象、每个对象有哪些候选」，才能决定是组合 multi-part 目标
   * 还是追问缺失对象——而不是静默丢掉命中信息或替用户挑一个对象。
   *
   * @param {object} match matchReferenceAssets 的 'multi' 结果
   * @param {object} options 同 resolveCandidates
   */
  async function resolveMultiObjectCandidates(match, options) {
    const groups = [];
    const rawCandidates = [];
    const attempts = [];
    for (const group of match.objectGroups || []) {
      const built = await convertMatchedAssets(group.matches, options);
      attempts.push(...(built.attempts || []));
      groups.push({
        objectKey: group.objectKey,
        objectName: group.objectName,
        rawCandidates: built.rawCandidates,
        candidateCount: built.rawCandidates.length,
      });
      rawCandidates.push(...built.rawCandidates);
    }
    return {
      status: "multi",
      origin: "local",
      rawCandidates,
      objectGroups: groups,
      objects: groups.map((group) => group.objectName).filter(Boolean),
      attempts,
      poolSize: rawCandidates.length,
      failures: [],
      error: null,
      reason: match.reason,
    };
  }

  /**
   * 多候选解析（方案 2026-10-31 §5）：本地命中的同对象素材版本 → 共享编排
   * 下载/转换（最多 maxAttempts 个），返回全部成功的 raw candidates（未归一化）。
   *
   * 多对象请求（方案 2026-11-05 §4.1/§4.2）：命中的多个对象各自转出候选，
   * 按对象分组返回（objectGroups），并带上对象名——调用方据此判断
   * 「是否所有请求对象都有候选」，而不是把整条通道让位丢掉命中信息。
   *
   * @param {string} text 用户文本
   * @param {object} [options]
   * @param {string|null} [options.shapeName] 图形名（intent.customShape?.name ?? intent.shapeSpec?.name）
   * @param {string[]} [options.traits] 用户明确说出的姿态/特征（referenceQuery.traits）
   * @param {number} [options.maxAttempts] 下载/转换尝试上限（默认 6）
   * @param {AbortSignal} [options.signal] 中止信号
   */
  async function resolveCandidates(text, { shapeName = null, traits = [], maxAttempts = REFERENCE_MAX_ATTEMPTS, signal = null } = {}) {
    const manifest = await loadManifest();
    const match = matchReferenceAssets(text, manifest.assets);
    if (match.status === "collision") {
      // 同一区间对应不同对象：配置碰撞，不得任选其一（方案 2026-11-05 §4.1 第 5 条）
      return {
        status: "collision",
        origin: "local",
        rawCandidates: [],
        attempts: [],
        poolSize: 0,
        failures: [],
        error: null,
        reason: match.reason,
        objects: match.objects ?? [],
        collision: match.collision ?? null,
      };
    }
    if (match.status === "multi") {
      return resolveMultiObjectCandidates(match, { shapeName, traits, maxAttempts, signal });
    }
    if (match.status !== "ok" || match.matches.length === 0) {
      return { status: "miss", origin: "local", rawCandidates: [], attempts: [], poolSize: 0, failures: [], error: null };
    }
    const result = await convertMatchedAssets(match.matches, { shapeName, traits, maxAttempts, signal });
    return {
      status: result.rawCandidates.length > 0 ? "ok" : "failed",
      origin: "local",
      rawCandidates: result.rawCandidates,
      attempts: result.attempts,
      poolSize: result.poolSize,
      failures: [],
      error: result.error,
    };
  }

  return { resolve, resolveCandidates };
}

export { REFERENCE_CANDIDATE_LIMIT };
