/**
 * 浏览器端参考图源 + Agent 适配 单元测试（无真实网络：fetch 从本地 seed 读取）。
 *
 * 运行：node test/reference-browser.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createReferenceShapeSource } from '../web/src/agent/reference.js';
import { createLocalReferenceSource, matchReferenceAsset, matchReferenceAssets } from '../web/src/reference/browser.js';

let failures = 0;
function check(label, condition, detail = '') {
  if (!condition) failures += 1;
  console.log(`[check] ${label} -> ${condition ? 'PASS' : `FAIL ${detail}`}`);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(root, 'web/data/shapes');
const manifest = JSON.parse(readFileSync(resolve(dataDir, 'manifest.json'), 'utf8'));

const match = matchReferenceAsset('帮我画一匹马', manifest.assets);
check('别名匹配：命中马（任一版本）', match?.asset?.names?.zh?.[0] === '马');
check('别名匹配：无关文本不命中', matchReferenceAsset('推荐一条散步路线', manifest.assets) === null);

const fetched = new Map();
const fetchImpl = async (url) => {
  const href = String(url);
  fetched.set(href, (fetched.get(href) || 0) + 1);
  if (href.endsWith('/manifest.json')) {
    return { ok: true, status: 200, json: async () => manifest, text: async () => JSON.stringify(manifest) };
  }
  if (href.startsWith('http://reference.test/seed/') || href.startsWith('http://reference.test/library/')) {
    const file = href.replace('http://reference.test/', '');
    return { ok: true, status: 200, text: async () => readFileSync(resolve(dataDir, file), 'utf8') };
  }
  return { ok: false, status: 404, text: async () => '' };
};

const source = createLocalReferenceSource({
  fetchImpl,
  manifestUrl: 'http://reference.test/manifest.json',
  baseUrl: 'http://reference.test/',
});

const horse = await source.resolve('帮我画一匹马');
// 多候选扩容后同一对象有多个素材版本（马 3），单命中包装取 §5.5 排序第一（id 稳定）
check('本地源：命中并转出 T（任一马版本）', horse?.asset.names?.zh?.[0] === '马' && horse.conversion.T.points.length === 320);
check('本地源：符合坐标约定', horse.conversion.T.points.every(([x, y]) => Math.abs(x) <= 0.5005 && Math.abs(y) <= 0.5005));
const horseFileUrl = [...fetched.keys()].find((key) => key.includes('.svg') && key.includes('horse'));
const before = fetched.get(horseFileUrl);
await source.resolve('再画一匹马');
check('本地源：同素材只请求一次', fetched.get(horseFileUrl) === before);
// 城堡已入库（102 份素材），改用素材库中不存在的对象验证 miss
check('本地源：未知素材返回 null', (await source.resolve('画一台电梯')) === null);

const resolveCustomShape = createReferenceShapeSource({
  fetchImpl,
  manifestUrl: 'http://reference.test/manifest.json',
  baseUrl: 'http://reference.test/',
});
const customShape = await resolveCustomShape('画一个人');
check('Agent 适配：输出 customShape', customShape?.customShape?.name === '人');
check('Agent 适配：outline 与 constraint 点列合法', customShape?.customShape?.outlinePoints?.length > 0 && customShape?.customShape?.constraintPoints?.length > 0);

// ---------- 单字别名语境规则（方案 5.6：地名/路名里的单字不得劫持参考图） ----------
// 负例：单字别名出现在地名/路名/普通词中，不紧邻绘图动词/量词，也无形状后缀
check('语境：人民广场画五角星（人）不命中', matchReferenceAsset('人民广场画五角星', manifest.assets) === null);
check('语境：马路边画心形（马）不命中', matchReferenceAsset('马路边画心形', manifest.assets) === null);
check('语境：跑马场（马）不命中', matchReferenceAsset('在珠江新城跑马场附近画个五角星', manifest.assets) === null);
check('语境：人群（人）不命中', matchReferenceAsset('广场上人群很多，画个五角星', manifest.assets) === null);
check('语境：裸量词「个人觉得」不命中', matchReferenceAsset('个人觉得画个心形好', manifest.assets) === null);
check('语境：裸量词「一个人去」不命中', matchReferenceAsset('一个人去广州塔画五角星', manifest.assets) === null);
check('语境：裸量词「两只狗旁边的路」不命中', matchReferenceAsset('两只狗旁边的路画五角星', manifest.assets) === null);
// 正例：紧邻绘图动词/动词+量词前缀、形状后缀、单独输入
check('语境：走个人形（个+人 / 人形已登记别名）命中 human', matchReferenceAsset('在广州塔附近走个人形', manifest.assets)?.asset.names?.zh?.[0] === '人');
// 方案 2026-11-01 §2 词边界：单字「人」右侧紧邻连续汉字为「人剪影」——既非别名本身，
// 也不是 human 已登记别名（只登记 人类/人形），该位置不命中；形状后缀语境守卫与词边界是合取。
check('词边界：走人剪影（人剪影 非登记别名）不命中 human', matchReferenceAsset('在广州塔走人剪影', manifest.assets) === null);
check('语境：画只猫（画只+猫）命中猫', matchReferenceAsset('画只猫', manifest.assets)?.asset.names?.zh?.[0] === '猫');
check('语境：画匹马（匹+马）命中马', matchReferenceAsset('画匹马', manifest.assets)?.asset.names?.zh?.[0] === '马');
check('语境：画只鸽（只+鸽）命中鸽子', matchReferenceAsset('在天河画只鸽', manifest.assets)?.asset.names?.zh?.[0] === '鸽子');
check('语境：单独输入「人」命中', matchReferenceAsset('人', manifest.assets)?.asset.names?.zh?.[0] === '人');
check('语境：单独输入「马」命中', matchReferenceAsset('马', manifest.assets)?.asset.names?.zh?.[0] === '马');
// 多字别名不受影响：裸子串仍可命中（小猫/小狗/鸽子/人类/人形）
check('语境：小猫（多字别名）裸子串命中', matchReferenceAsset('体育中心这里来个沙发上的小猫轮廓', manifest.assets)?.asset.names?.zh?.[0] === '猫');
check('语境：画只小狗（小狗别名）命中 dog', matchReferenceAsset('在沙面附近画只小狗', manifest.assets)?.names?.zh?.[0] === '狗' || matchReferenceAsset('在沙面附近画只小狗', manifest.assets)?.asset.names?.zh?.[0] === '狗');
// 无关文本仍不命中
check('语境：无关文本不命中', matchReferenceAsset('推荐一条散步路线', manifest.assets) === null);

// ---------- 多候选匹配（方案 2026-10-31 §5）：同对象多版本 + 消歧 ----------
check('多候选：画只猫命中两个猫版本', matchReferenceAssets('画只猫', manifest.assets).matches.length === 2);
check('多候选：画匹马命中三个马版本', matchReferenceAssets('画匹马', manifest.assets).matches.length === 3);
check(
  '多候选：嵌套别名按最长归并（猫头鹰不被「猫」劫持成猫）',
  matchReferenceAssets('画只猫头鹰', manifest.assets).matches.every((match) => match.asset.names.zh[0] === '猫头鹰'),
);
// 缺陷清单 2026-11-06 Bug 4.3：并连词是单字别名的右边界——「画猫和兔子」的"猫"
// 此前右取串吞掉「和兔子」导致不命中，多对象请求只剩"兔子"命中（部分命中追问）。
check(
  '词边界连词：画猫和兔子 → 猫 + 兔两个对象都命中（multi，此前"猫"被吞词不命中）',
  (() => {
    const multi = matchReferenceAssets('画猫和兔子', manifest.assets);
    const names = (multi.objectGroups ?? multi.matches ?? []).map((group) => group.objectName ?? group.asset?.names?.zh?.[0]).sort();
    return multi.status === 'multi' && names.join(',') === '兔,猫';
  })(),
  JSON.stringify((matchReferenceAssets('画猫和兔子', manifest.assets).objectGroups ?? []).map((group) => group.objectName)),
);
check(
  '词边界连词：画猫头鹰和猫 → 猫头鹰命中且不被"猫"劫持（尾部单字由逐对象匹配补齐）',
  (() => {
    const multi = matchReferenceAssets('画猫头鹰和猫', manifest.assets);
    const names = (multi.objectGroups ?? multi.matches ?? []).map((group) => group.objectName ?? group.asset?.names?.zh?.[0]).sort();
    // 整段扫描命中猫头鹰（词边界不吞"猫头鹰"）；结尾的"猫"受绘图语境守卫限制，
    // 由 controller 的逐对象匹配路径补齐（见 controller-multi-object 场景 4）
    return names.includes('猫头鹰') && !names.includes('猫头鹰和猫');
  })(),
  JSON.stringify((matchReferenceAssets('画猫头鹰和猫', manifest.assets).objectGroups ?? []).map((group) => group.objectName)),
);
check('词边界连词：画只猫仍命中（无连词路径不回归）', matchReferenceAsset('画只猫', manifest.assets)?.asset.names?.zh?.[0] === '猫');
check(
  '词边界连词：画只猫和狗 → 猫命中且词边界不吞"和狗"（无过度扩词）',
  (() => {
    const multi = matchReferenceAssets('画只猫和狗', manifest.assets);
    const names = (multi.objectGroups ?? multi.matches ?? []).map((group) => group.objectName ?? group.asset?.names?.zh?.[0]).sort();
    // 猫命中（前缀语境）；"狗"是尾部单字、前面是连词，整段扫描不命中（语境守卫），
    // 多对象请求由逐对象匹配补齐——这里只锁"连词不再制造错误词"
    return names.includes('猫');
  })(),
  JSON.stringify((matchReferenceAssets('画只猫和狗', manifest.assets).objectGroups ?? []).map((group) => group.objectName)),
);
check(
  '词边界连词：人民广场（无连词、普通词）仍不命中"人"',
  (() => {
    const multi = matchReferenceAssets('人民广场', manifest.assets);
    const names = (multi.objectGroups ?? multi.matches ?? []).map((group) => group.objectName ?? group.asset?.names?.zh?.[0]);
    return (multi.status === 'miss') || names.length === 0;
  })(),
  JSON.stringify(matchReferenceAssets('人民广场', manifest.assets).status),
);

// 方案 2026-11-01 §2 词边界：无标点连写时「马匹画只狗」会被并入同一连续汉字串，
// 故多对象歧义样本带标点（逗号是非汉字，词边界在「马」处停止），测试意图保持「多对象→歧义」。
check(
  '多候选：多对象请求返回结构化多对象结果（马+狗不让参考通道挑一个）',
  matchReferenceAssets('画匹马，画只狗', manifest.assets).status === 'multi',
);
check(
  '多对象：命中对象按对象分组返回（马+狗各自成组）',
  (() => {
    const multi = matchReferenceAssets('画匹马，画只狗', manifest.assets);
    return (
      multi.status === 'multi' &&
      multi.objectGroups.length === 2 &&
      multi.objectGroups.every((group) => group.matches.length > 0) &&
      multi.objects.includes('马') &&
      multi.objects.includes('狗')
    );
  })(),
);
// 方案 2026-11-05 §4.1：归并按**匹配区间包含关系**，不再按别名长度——
// 别名长度不同的两个对象必须都保留（旧实现会静默丢掉一个）。
check(
  '区间归并：别名长度不同的两个对象都保留（旧实现会丢掉一个）',
  (() => {
    const multi = matchReferenceAssets('画只小狗和只斑马', manifest.assets);
    return (
      multi.status === 'multi' &&
      multi.objects.includes('狗') &&
      multi.objects.includes('斑马')
    );
  })(),
);
// 全量不同别名长度组合不得再被长度规则静默丢对象（方案 2026-11-05 §4.3）
{
  const objAliases = new Map();
  for (const asset of manifest.assets) {
    const key = asset.names?.zh?.[0] ?? asset.id;
    if (!objAliases.has(key)) {
      objAliases.set(key, new Set());
    }
    for (const alias of asset.aliases || []) {
      if (alias.length >= 2) {
        objAliases.get(key).add(alias);
      }
    }
  }
  const objects = [...objAliases.entries()].filter(([, aliases]) => aliases.size > 0);
  let pairs = 0;
  let lost = 0;
  for (const [nameA, aliasesA] of objects) {
    for (const [nameB, aliasesB] of objects) {
      if (nameA === nameB) {
        continue;
      }
      for (const aliasA of aliasesA) {
        for (const aliasB of aliasesB) {
          if (aliasA.length === aliasB.length) {
            continue; // 只测「长度不同」的组合（旧规则正是按长度分胜负）
          }
          pairs += 1;
          const result = matchReferenceAssets(`画一个${aliasA}和${aliasB}`, manifest.assets);
          const hit = new Set(result.objects || []);
          if (!hit.has(nameA) || !hit.has(nameB)) {
            lost += 1;
          }
        }
      }
    }
  }
  check(
    `区间归并全表：不同别名长度组合 ${pairs} 组，丢对象 0 组`,
    pairs > 0 && lost === 0,
    `pairs=${pairs} lost=${lost}`,
  );
}
check(
  '多候选：英文词边界（cat 不命中 category）',
  matchReferenceAssets('draw a category diagram', manifest.assets).status === 'miss',
);
check(
  '多候选：英文词边界（独立 cat 命中）',
  matchReferenceAssets('draw a cat', manifest.assets).matches.length >= 1,
);

// ---------- 名称碰撞治理负例（方案 §4.3：先冻结进测试） ----------
check('碰撞：十字路口（高频地点词）不命中十字架', matchReferenceAsset('在十字路口画个五角星', manifest.assets) === null);
check('碰撞：明确要十字架才命中', matchReferenceAssets('画一个十字架', manifest.assets).matches.some((m) => m.asset.id === 'fa-cross'));
check('碰撞：五羊雕像（地名含动物）不命中羊', matchReferenceAsset('在五羊雕像前画个星', manifest.assets) === null);
check('碰撞：白云机场不命中云/月亮', matchReferenceAsset('在白云机场画个星', manifest.assets) === null);
check('碰撞：月亮湾（若为地点）画星不命中月亮', matchReferenceAsset('月亮湾旁边画个星', manifest.assets) === null);
check('碰撞：火箭（fa-rocket）与珠江新城共存正常命中', matchReferenceAssets('珠江新城画个火箭', manifest.assets).matches.some((m) => m.asset.id === 'fa-rocket'));
check('碰撞：书（单字）在地点词「书香」中不命中', matchReferenceAsset('书香雅苑画个星', manifest.assets) === null);

// ---------- A 词边界全表能力断言（方案 2026-11-01 §2、§4.1） ----------
// 规则：单字中文别名的每个出现位置，取「该别名 + 右侧紧邻连续汉字」构成的串——
//   串 == 别名本身 → 命中；
//   串 == 同一素材已登记的更长别名（names.zh + names.en + aliases 归一化）→ 命中；
//   串比别名长且不是同一素材已登记别名 → 该位置不命中（右侧多出来的字是什么不看）。
// 全表扫描 manifest，不维护例外词表。
const CJK_CHAR = /[\u4e00-\u9fff]/;
// 右侧接字用的汉字池：只用于构造「更长且未登记」的串；按固定顺序取，测试可复现
const WORD_CHAR_POOL = '山水木火土金石沙冰雪风雨雷电天地日星辰花鸟虫鱼米田心手足';
const normalizeAlias = (value) => String(value || '').toLowerCase().trim();
const registeredAliasesOf = (asset) =>
  new Set(
    [...(asset.names?.zh || []), ...(asset.names?.en || []), ...(asset.aliases || [])]
      .map(normalizeAlias)
      .filter(Boolean),
  );

const singleCharCases = [];
for (const asset of manifest.assets) {
  const registered = registeredAliasesOf(asset);
  for (const alias of registered) {
    if (alias.length === 1 && CJK_CHAR.test(alias)) {
      singleCharCases.push({ asset, alias, registered });
    }
  }
}
// 全部素材的全部登记别名：构造负例时优先选「与任何素材别名都不冲突」的右侧接字，
// 让「该素材不命中」这条断言只由词边界决定，不夹带其他素材的别名命中。
const allRegisteredAliases = new Set(manifest.assets.flatMap((asset) => [...registeredAliasesOf(asset)]));

const wordBoundary = {
  scanned: singleCharCases.length,
  hit: 0,
  standalone: 0,
  nonCjk: 0,
  rejected: 0,
  longerExpected: 0,
  longerHit: 0,
  skipped: 0,
};
const wordBoundarySkipReasons = [];
const wordBoundaryFailures = [];
/** 词边界全表子断言：失败收集到列表，最后由 check() 汇总（逐条真实断言，避免刷屏） */
function wordBoundaryExpect(label, pass) {
  if (!pass) wordBoundaryFailures.push(label);
}
/** 文本命中的候选里是否包含指定素材（ambiguous 时 matches 为空 → 视为未命中该素材） */
function hitsAsset(text, assetId) {
  return matchReferenceAssets(text, manifest.assets).matches.some((item) => item.asset.id === assetId);
}

for (const { asset, alias, registered } of singleCharCases) {
  // 1) 该字单独成词（位于文本末尾，右侧无汉字）→ 命中该素材
  if (hitsAsset(`画一只${alias}`, asset.id)) {
    wordBoundary.hit += 1;
  } else {
    wordBoundaryExpect(`单独成词未命中：${asset.id}/${alias}`, false);
  }
  // 2) 单独输入该字 → 命中该素材
  if (hitsAsset(alias, asset.id)) {
    wordBoundary.standalone += 1;
  } else {
    wordBoundaryExpect(`单独输入未命中：${asset.id}/${alias}`, false);
  }
  // 3) 右侧接非汉字（句号 / 空格 / ASCII）→ 词边界在别名处停止，仍命中该素材
  for (const text of [`画一只${alias}。`, `画一只${alias} `, `画一只${alias}abc`]) {
    if (hitsAsset(text, asset.id)) {
      wordBoundary.nonCjk += 1;
    } else {
      wordBoundaryExpect(`右侧非汉字未命中：${text}`, false);
    }
  }
  // 4) 右侧接一个汉字、且「别名+该字」不是本素材已登记别名 → 该素材不命中。
  //    首选与任何素材别名都不冲突的接字（见 allRegisteredAliases），避免命中断言被其他素材干扰；
  //    汉字池里一个可用接字都没有时跳过该素材并记录原因（当前 manifest 不会出现）。
  const extraChar = [...WORD_CHAR_POOL].find((char) => !allRegisteredAliases.has(alias + char));
  if (!extraChar) {
    wordBoundary.skipped += 1;
    wordBoundarySkipReasons.push(`${asset.id}/${alias}：汉字池内所有「${alias}+接字」均为某素材已登记别名`);
  } else if (hitsAsset(`画一只${alias}${extraChar}`, asset.id)) {
    wordBoundaryExpect(`右侧接字仍命中（应不命中）：${asset.id}/${alias}+${extraChar}`, false);
  } else {
    wordBoundary.rejected += 1;
  }
  // 5) 同一素材已登记的更长别名（以该字开头、长度 > 1）仍命中（允许由多字别名路径命中）
  for (const longer of registered) {
    if (longer.length > 1 && longer.startsWith(alias)) {
      wordBoundary.longerExpected += 1;
      if (hitsAsset(`画一只${longer}`, asset.id)) {
        wordBoundary.longerHit += 1;
      } else {
        wordBoundaryExpect(`已登记更长别名未命中：${asset.id}/${longer}`, false);
      }
    }
  }
}

check('词边界全表：扫描到 manifest 全部 33 个单字中文别名', wordBoundary.scanned === 33, String(wordBoundary.scanned));
check(`词边界全表：单独成词命中 ${wordBoundary.hit}/${wordBoundary.scanned}`, wordBoundary.hit === wordBoundary.scanned);
check(`词边界全表：单独输入命中 ${wordBoundary.standalone}/${wordBoundary.scanned}`, wordBoundary.standalone === wordBoundary.scanned);
check(`词边界全表：右侧非汉字命中 ${wordBoundary.nonCjk}/${wordBoundary.scanned * 3}`, wordBoundary.nonCjk === wordBoundary.scanned * 3);
check(
  `词边界全表：右侧接字不命中 ${wordBoundary.rejected}/${wordBoundary.scanned}（跳过 ${wordBoundary.skipped}）`,
  wordBoundary.rejected + wordBoundary.skipped === wordBoundary.scanned && wordBoundary.skipped === 0,
  wordBoundarySkipReasons.join('；'),
);
check(
  `词边界全表：已登记更长别名命中 ${wordBoundary.longerHit}/${wordBoundary.longerExpected}`,
  wordBoundary.longerExpected > 0 && wordBoundary.longerHit === wordBoundary.longerExpected,
);
check('词边界全表：全部子断言无失败', wordBoundaryFailures.length === 0, wordBoundaryFailures.slice(0, 8).join('；'));
console.log(
  `[word-boundary] 单字别名 ${wordBoundary.scanned} 个；命中断言 ${wordBoundary.hit + wordBoundary.standalone + wordBoundary.nonCjk + wordBoundary.longerHit} 条；` +
    `右侧接字不命中断言 ${wordBoundary.rejected} 条；已登记更长别名断言 ${wordBoundary.longerHit} 条；跳过 ${wordBoundary.skipped} 个`,
);

// ---------- A 词边界显式样本（方案 §2、§4.1/§4.2 点名样本） ----------
{
  check('样本：画一只龙命中 dragon', matchReferenceAssets('画一只龙', manifest.assets).matches.some((item) => item.asset.id === 'dragon'));
  const lobster = matchReferenceAssets('在珠江新城画一只龙虾', manifest.assets);
  check('样本：在珠江新城画一只龙虾本地 miss', lobster.status === 'miss' && lobster.matches.length === 0);
  check('样本：龙虾不命中 dragon', !lobster.matches.some((item) => item.asset.id === 'dragon'));
  // 方案 2026-11-01 §4/§5.1（口语全称）：rabbit 已登记「兔子」，
  // 「画一只兔子」现在只命中 rabbit 且命中别名是「兔子」（旧断言「不命中」是词边界阶段的期望，按新规则更新）。
  const rabbitWord = matchReferenceAssets('画一只兔子', manifest.assets);
  check(
    '样本：画一只兔子命中 rabbit（口语全称「兔子」）',
    rabbitWord.status === 'ok' &&
      rabbitWord.matches.length === 1 &&
      rabbitWord.matches[0].asset.id === 'rabbit' &&
      rabbitWord.matches[0].matchedAlias === '兔子',
  );
  check('样本：画只兔命中 rabbit（旧单字别名行为不变）', matchReferenceAssets('画只兔', manifest.assets).matches.some((item) => item.asset.id === 'rabbit'));
  check(
    '样本：画只人形命中 human-phylopic（人形为已登记别名）',
    matchReferenceAssets('画只人形', manifest.assets).matches.some((item) => item.asset.id === 'human-phylopic' && item.matchedAlias === '人形'),
  );
  check(
    '样本：画只鸽子命中 pigeon-phylopic（多字别名路径）',
    matchReferenceAssets('画只鸽子', manifest.assets).matches.some((item) => item.asset.id === 'pigeon-phylopic' && item.matchedAlias === '鸽子'),
  );
}

if (failures > 0) {
  console.error(`\nFAILED: ${failures} 项未通过`);
  process.exitCode = 1;
} else {
  console.log('\nPASS: reference-browser 全部断言通过');
}
