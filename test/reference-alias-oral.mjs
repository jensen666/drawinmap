/**
 * 口语全称别名能力测试（方案 2026-11-01 §4「口语全称」、§5.1 能力验证）。
 *
 * 纯 Node、无网络、无模型、无浏览器：
 * - 读取真实 web/data/shapes/manifest.json（不 mock manifest）；
 * - 调用真实 web/src/reference/browser.js 的 matchReferenceAssets（不 mock 匹配函数）；
 * - 不写任何生产代码路径，只做断言。
 *
 * 覆盖 §5.1「口语全称」行的五组能力断言：
 *   a) 封闭表 7 条：`画一只<全称>` 只命中该中文名的素材，且命中别名等于全称；
 *   b) 必须仍然命中、且不算本次新增的旧别名：鸽→鸽子、猫→小猫、狗→小狗、人→人类；
 *   c) 必须不命中的词：龙虾对龙、马蜂对马、公鸡/母鸡对鸡、金鱼对鱼；
 *   d) 通用规则：每个单字中文别名 C，`C虾` 未登记则 `画一只C虾` 不命中该素材，已登记则命中；
 *   e) 单字素材新增的中文别名不多不少就是封闭表：逐素材对比硬编码基线；
 *      表外单字素材的中文别名集合与基线完全一致。
 *
 * 运行：node test/reference-alias-oral.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { matchReferenceAssets } from '../web/src/reference/browser.js';

let checks = 0;
let failures = 0;

/** 单条断言（失败也会继续跑，最后统一汇总退出码） */
function check(label, condition, detail = '') {
  checks += 1;
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`[check] ${label} -> ${ok ? 'PASS' : `FAIL ${detail}`}`);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = resolve(root, 'web/data/shapes/manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const assets = manifest.assets;

/** 文本归一化（与 browser.js 的 normalizeText 同口径：小写 + 去首尾空白） */
function normalize(value) {
  return String(value || '').toLowerCase().trim();
}

/** 汉字判定（与 browser.js 的 CJK_CHAR_PATTERN 同口径） */
const CJK_CHAR = /[\u4e00-\u9fff]/;

/** 素材中文名首名（normalize 后） */
function firstZh(asset) {
  return normalize(asset.names?.zh?.[0] ?? '');
}

/**
 * 素材全部已登记别名集合（names.zh + names.en + aliases，与 browser.js 的
 * registeredAliases 同口径：归一化、去空）。
 */
function registeredAliasesOf(asset) {
  return new Set(
    [...(asset.names?.zh || []), ...(asset.names?.en || []), ...(asset.aliases || [])]
      .map(normalize)
      .filter(Boolean),
  );
}

/** 素材已登记别名中的中文（含 CJK）别名集合 */
function cjkAliasesOf(asset) {
  return [...registeredAliasesOf(asset)].filter((alias) => CJK_CHAR.test(alias));
}

/**
 * 按名字取真实 manifest 素材；找不到直接抛错（测试基线被破坏时立刻暴露）。
 * @param {string} id
 */
function assetOf(id) {
  const asset = assets.find((item) => item.id === id);
  if (!asset) throw new Error(`manifest 中不存在素材：${id}`);
  return asset;
}

// ---------- a) 封闭表 7 条：画一只<口语全称> 只命中该中文名的素材 ----------
/** §5.1 封闭表（单字 → 必须新增的口语全称）与对应素材 id */
const ORAL_TABLE = Object.freeze([
  { id: 'rabbit', zh: '兔', alias: '兔子' },
  { id: 'duck', zh: '鸭', alias: '鸭子' },
  { id: 'monkey', zh: '猴', alias: '猴子' },
  { id: 'mouse', zh: '鼠', alias: '老鼠' },
  { id: 'turtle', zh: '龟', alias: '乌龟' },
  { id: 'eagle', zh: '鹰', alias: '老鹰' },
  { id: 'whale', zh: '鲸', alias: '鲸鱼' },
]);

for (const item of ORAL_TABLE) {
  const text = `画一只${item.alias}`;
  const result = matchReferenceAssets(text, assets);
  // 「只命中该中文名的素材」：status 必须是 ok（ambiguous 会清空 matches，不算只命中），
  // 且全部命中都落在同一素材 id 上。
  const onlyTarget =
    result.status === 'ok' &&
    result.matches.length >= 1 &&
    result.matches.every((match) => match.asset.id === item.id);
  check(
    `封闭表：${text} 只命中 ${item.id}（${item.zh}）`,
    onlyTarget,
    `status=${result.status} matches=${JSON.stringify(result.matches.map((match) => `${match.asset.id}:${match.matchedAlias}`))} objects=${JSON.stringify(result.objects || [])}`,
  );
  const target = result.matches.find((match) => match.asset.id === item.id);
  check(
    `封闭表：${text} 命中别名 = ${item.alias}`,
    target?.matchedAlias === item.alias,
    `matchedAlias=${target?.matchedAlias}`,
  );
}

// ---------- b) 必须仍然命中、且不算本次新增的旧长别名 ----------
/** 本次改动前 manifest 里就已登记的长别名（方案 §5.1：以现有 manifest 为准，本次不新增） */
const LEGACY_LONG_ALIASES = Object.freeze([
  { id: 'pigeon-phylopic', base: '鸽', alias: '鸽子' },
  { id: 'cat-phylopic', base: '猫', alias: '小猫' },
  { id: 'dog-phylopic', base: '狗', alias: '小狗' },
  { id: 'human-phylopic', base: '人', alias: '人类' },
]);

for (const item of LEGACY_LONG_ALIASES) {
  const asset = assetOf(item.id);
  // 「不算本次新增」：这些长别名在基线 manifest 就已登记，本次改动不得碰它们。
  check(
    `旧别名：${item.id} 已登记 ${item.alias}（基线既有，不是本次新增）`,
    registeredAliasesOf(asset).has(item.alias),
    `registered=${JSON.stringify([...registeredAliasesOf(asset)])}`,
  );
  const text = `画一只${item.alias}`;
  const result = matchReferenceAssets(text, assets);
  const target = result.status === 'ok' ? result.matches.find((match) => match.asset.id === item.id) : null;
  check(
    `旧别名：${text} 仍命中 ${item.id} 且命中别名 = ${item.alias}`,
    Boolean(target) && target.matchedAlias === item.alias,
    `status=${result.status} matchedAlias=${target?.matchedAlias}`,
  );
  // 旧别名行为不变：单字仍能独立命中（词边界允许「别名+已登记长别名」通过）
  const single = matchReferenceAssets(`画一只${item.base}`, assets);
  check(
    `旧别名：画一只${item.base} 仍命中 ${item.id}`,
    single.status === 'ok' && single.matches.some((match) => match.asset.id === item.id),
    `status=${single.status}`,
  );
}

// ---------- c) 必须不命中的词（单字别名不得劫持更长词） ----------
/** 负例：更长词里含单字别名，但「别名+接字」不是该素材已登记别名 → 不命中 */
const NEGATIVE_WORDS = Object.freeze([
  { text: '画一只龙虾', base: '龙' },
  { text: '画一只马蜂', base: '马' },
  { text: '画一只公鸡', base: '鸡' },
  { text: '画一只母鸡', base: '鸡' },
  { text: '画一只金鱼', base: '鱼' },
]);

for (const item of NEGATIVE_WORDS) {
  const result = matchReferenceAssets(item.text, assets);
  check(
    `负例：${item.text} 不命中（${item.base} 不劫持更长词）`,
    result.status === 'miss' && result.matches.length === 0,
    `status=${result.status} matches=${JSON.stringify(result.matches.map((match) => `${match.asset.id}:${match.matchedAlias}`))}`,
  );
}

// ---------- d) 通用规则：对每个单字中文别名 C，C虾 未登记 → 画一只C虾 不命中该素材 ----------
{
  let singleAliasCount = 0;
  let registeredExtendCount = 0;
  for (const asset of assets) {
    const registered = registeredAliasesOf(asset);
    const singleCharAliases = [...registered].filter((alias) => alias.length === 1 && CJK_CHAR.test(alias));
    for (const alias of singleCharAliases) {
      singleAliasCount += 1;
      const extended = `${alias}虾`;
      const text = `画一只${extended}`;
      // 规则（方案 §5.1）：`C虾` 不在该素材已登记别名里 → 不命中；已登记 → 命中。
      const expectHit = registered.has(extended);
      if (expectHit) registeredExtendCount += 1;
      // 只针对该素材单独调用真实匹配函数：同字多版本素材（马 3 份）不会因跨素材
      // ambiguous 把 matches 清空，从而精确定位「该素材是否命中」。
      const result = matchReferenceAssets(text, [asset]);
      const hit = result.status === 'ok' && result.matches.some((match) => match.asset.id === asset.id);
      check(
        `通用规则：${asset.id} 的「${alias}」→「${text}」${expectHit ? '命中' : '不命中'}`,
        hit === expectHit,
        `status=${result.status} matches=${JSON.stringify(result.matches.map((match) => `${match.asset.id}:${match.matchedAlias}`))}`,
      );
    }
  }
  console.log(
    `[oral] 通用规则扫描：单字中文别名 ${singleAliasCount} 个；其中「别名+虾」已登记 ${registeredExtendCount} 个（本次 manifest 应为 0，未触发已登记分支）`,
  );
}

// ---------- e) 单字素材新增的中文别名不多不少就是封闭表 ----------
/**
 * 单字素材中文别名基线（本次改动前真实 manifest 的快照，硬编码避免测试依赖 git）。
 * 键 = 素材 id；值 = 该素材（names.zh 首名长度为 1）在本次改动前的全部中文（含 CJK）别名。
 * 若未来 manifest 有意新增/删除单字素材，这里要连同本测试一起更新——这是 §5.1 的冻结基线。
 */
const ORAL_BASELINE_BY_ASSET = Object.freeze({
  'horse-phylopic': ['马', '马匹', '普氏野马'],
  'cat-phylopic': ['猫', '小猫', '丛林猫'],
  'dog-phylopic': ['狗', '小狗', '家犬'],
  'human-phylopic': ['人', '人类', '人形'],
  'horse-openclipart': ['马', '剪影马'],
  'dog-openclipart': ['狗', '站狗'],
  horse: ['马'],
  dog: ['狗'],
  cat: ['猫'],
  chicken: ['鸡'],
  duck: ['鸭'],
  goose: ['鹅'],
  eagle: ['鹰'],
  zebrafish: ['鱼'],
  whale: ['鲸'],
  bear: ['熊'],
  wolf: ['狼'],
  deer: ['鹿'],
  monkey: ['猴'],
  rabbit: ['兔'],
  mouse: ['鼠'],
  cattle: ['牛'],
  sheep: ['羊'],
  pig: ['猪'],
  snake: ['蛇'],
  oak: ['树'],
  turtle: ['龟'],
  donkey: ['驴'],
  dragon: ['龙'],
  book: ['书'],
  'fa-cloud': ['云'],
  'fa-anchor': ['锚'],
});

/** 本次改动允许新增的中文别名（素材 id → 封闭表口语全称） */
const ORAL_ADDED_BY_ASSET = Object.freeze({
  rabbit: '兔子',
  duck: '鸭子',
  monkey: '猴子',
  mouse: '老鼠',
  turtle: '乌龟',
  eagle: '老鹰',
  whale: '鲸鱼',
});

/** 单字素材 = names.zh 首名长度恰好为 1 的素材 */
const singleCharAssets = assets.filter((asset) => firstZh(asset).length === 1);
const singleCharIds = new Set(singleCharAssets.map((asset) => asset.id));
const baselineIds = new Set(Object.keys(ORAL_BASELINE_BY_ASSET));

check(
  '基线：单字素材集合与硬编码基线一致（不多不少）',
  singleCharIds.size === baselineIds.size && [...singleCharIds].every((id) => baselineIds.has(id)),
  `实际 ${[...singleCharIds].sort().join(',')} / 基线 ${[...baselineIds].sort().join(',')}`,
);

for (const asset of singleCharAssets) {
  const baseline = ORAL_BASELINE_BY_ASSET[asset.id];
  const added = ORAL_ADDED_BY_ASSET[asset.id] ? [ORAL_ADDED_BY_ASSET[asset.id]] : [];
  const expected = new Set([...(baseline || []), ...added]);
  const actual = new Set(cjkAliasesOf(asset));
  const actualKey = [...actual].sort().join('|');
  const expectedKey = [...expected].sort().join('|');
  check(
    `基线一致性：${asset.id} 中文别名 = 基线${added.length > 0 ? ` + 封闭表「${added[0]}」` : '（表外，不得新增）'}`,
    actualKey === expectedKey,
    `实际 ${actualKey} / 期望 ${expectedKey}`,
  );
}

// 「不多不少」汇总：扫描全部单字素材，实际相对基线的增量必须恰好等于封闭表
{
  const actualAdded = new Map();
  for (const asset of singleCharAssets) {
    const baseline = new Set(ORAL_BASELINE_BY_ASSET[asset.id] || []);
    const extra = cjkAliasesOf(asset)
      .filter((alias) => !baseline.has(alias))
      .sort();
    if (extra.length > 0) actualAdded.set(asset.id, extra);
  }
  const expectedIds = Object.keys(ORAL_ADDED_BY_ASSET).sort();
  const actualIds = [...actualAdded.keys()].sort();
  const sameIds = actualIds.length === expectedIds.length && actualIds.every((id, index) => id === expectedIds[index]);
  const sameAliases = sameIds && actualIds.every((id) => actualAdded.get(id).join('|') === ORAL_ADDED_BY_ASSET[id]);
  check(
    '封闭表：单字素材新增的中文别名不多不少就是 7 条口语全称',
    sameAliases,
    `实际 ${JSON.stringify(Object.fromEntries(actualAdded))} / 期望 ${JSON.stringify(ORAL_ADDED_BY_ASSET)}`,
  );
}

console.log(`\n[oral] 共 ${checks} 条断言，${checks - failures} 条通过，${failures} 条失败`);
if (failures > 0) {
  console.error(`FAILED: ${failures} 项未通过`);
  process.exitCode = 1;
} else {
  console.log('PASS: reference-alias-oral 全部断言通过');
}
