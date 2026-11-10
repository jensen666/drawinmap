/**
 * 请求对象集合与交付对象一致性（方案 2026-11-05 §4.2/§4.3）单元测试。
 *
 * 运行：node test/request-objects.mjs
 */

import {
  buildDeliveredObjectUnits,
  checkDeliveryObjectConsistency,
  composeObjectShortfallReply,
  evaluateObjectCoverage,
  matchDeliveredObjects,
  matchRequestedObjects,
  namesCover,
  namesMatchStrict,
  normalizeRequestObjects,
  requestedObjectCovered,
  MAX_REQUEST_OBJECTS,
} from '../web/src/agent/request-objects.js';
import { normalizeIntent } from '../web/src/agent/intent.js';

let failures = 0;
let checks = 0;
function check(label, condition, detail = '') {
  checks += 1;
  if (!condition) {
    failures += 1;
  }
  console.log(`[check] ${label} -> ${condition ? 'PASS' : `FAIL ${detail}`}`);
}

// ---------- 归一化 ----------
check(
  '归一化：字符串数组 → 对象列表',
  JSON.stringify(normalizeRequestObjects(['马', '狗'])) ===
    JSON.stringify([{ name: '马', aliases: [] }, { name: '狗', aliases: [] }]),
  JSON.stringify(normalizeRequestObjects(['马', '狗'])),
);
check(
  '归一化：对象数组保留别名',
  JSON.stringify(normalizeRequestObjects([{ name: '马', aliases: ['马匹', '骏马'] }])) ===
    JSON.stringify([{ name: '马', aliases: ['马匹', '骏马'] }]),
);
check('归一化：非数组 → 空', normalizeRequestObjects(null).length === 0 && normalizeRequestObjects('马').length === 0);
check('归一化：同名去重', normalizeRequestObjects(['马', '马']).length === 1);
check(
  '归一化：超过上限被截断',
  normalizeRequestObjects(['a', 'b', 'c', 'd', 'e']).length === MAX_REQUEST_OBJECTS,
  String(normalizeRequestObjects(['a', 'b', 'c', 'd', 'e']).length),
);

// ---------- 名称覆盖 ----------
check('覆盖：完全相同', namesCover('马', '马'));
check('覆盖：长含短（≥2 字）', namesCover('长颈鹿', '鹿'));
check('覆盖：短含长（≥2 字）', namesCover('鹿', '长颈鹿'));
check('覆盖：单字中文包含（口语简称）', namesCover('小狗', '狗'));
check('不覆盖：单字符英文包含（只放宽单字中文）', !namesCover('category', 'c'), '英文单字符不按子串覆盖');
check('覆盖：多字符英文包含（≥2 字符按包含覆盖）', namesCover('category', 'cat'));
check('不覆盖：完全不同', !namesCover('马', '狗'));
check('不覆盖：空串', !namesCover('', '马') && !namesCover('马', ''));

// ---------- 覆盖率 ----------
{
  const requested = normalizeRequestObjects(['马', '狗']);
  const ok = evaluateObjectCoverage({
    requested,
    deliveredNames: ['马', '狗'],
    deliveredPartCount: 2,
  });
  check('覆盖：两对象都交付 → complete', ok.complete && ok.missing.length === 0, JSON.stringify(ok));

  const partial = evaluateObjectCoverage({
    requested,
    deliveredNames: ['马'],
    deliveredPartCount: 1,
  });
  check(
    '覆盖：只交付一个 → 缺失一个（X14 场景）',
    !partial.complete && partial.missing.length === 1 && partial.missing[0].name === '狗',
    JSON.stringify(partial),
  );

  const combined = evaluateObjectCoverage({
    requested,
    deliveredNames: ['马和狗'],
    deliveredPartCount: 1,
  });
  // 2026-11-08 §4.2：一个组成部分不得重复认领两个请求对象——
  // 「马和狗」合成一体只算交付了一个对象，另一个必须报缺失（旧口径按名字包含判过）。
  check(
    '覆盖：合成一体（一个部分）→ 只能认领一个对象，另一个缺失',
    !combined.complete && combined.missing.length === 1,
    JSON.stringify(combined),
  );

  // 2026-11-08 §4.2：去掉「部分数够就算完整」的数量短路。
  // 请求 猫/狗/兔、实际交付 猫/狗/狗 —— 兔缺失必须被报出来（旧口径会判成完整）。
  const countSuffices = evaluateObjectCoverage({
    requested: normalizeRequestObjects(['猫', '狗', '兔']),
    deliveredNames: ['猫', '狗', '狗'],
    deliveredPartCount: 3,
  });
  check(
    '覆盖：部分数够但身份对不上 → 不再算完整（兔缺失）',
    !countSuffices.complete && countSuffices.missing.length === 1 && countSuffices.missing[0].name === '兔',
    JSON.stringify(countSuffices),
  );

  const none = evaluateObjectCoverage({ requested, deliveredNames: [], deliveredPartCount: 0 });
  check('覆盖：没有交付物 → 全部缺失', !none.complete && none.missing.length === 2);

  const empty = evaluateObjectCoverage({ requested: [], deliveredNames: [], deliveredPartCount: 0 });
  check('覆盖：没有请求对象 → complete', empty.complete);
}

// ---------- 别名参与匹配 ----------
check(
  '覆盖：别名命中',
  requestedObjectCovered({ name: '狗', aliases: ['家犬'] }, ['家犬']),
);
check('覆盖：别名不命中', !requestedObjectCovered({ name: '狗', aliases: ['家犬'] }, ['猫']));

// ---------- 请求 vs 可用对象 ----------
{
  const requested = normalizeRequestObjects(['马', '狗']);
  const available = [
    { objectName: '马', aliases: ['马匹'] },
    { objectName: '狗', aliases: ['小狗'] },
  ];
  const full = matchRequestedObjects(requested, available);
  check('比对：全部命中', full.missing.length === 0 && full.hit.length === 2, JSON.stringify(full));

  const partial = matchRequestedObjects(requested, [available[0]]);
  check(
    '比对：部分命中（缺狗）',
    partial.missing.length === 1 && partial.missing[0].name === '狗',
    JSON.stringify(partial),
  );

  // 回归：请求「猫」不得被素材对象「猫头鹰」认领（'猫' ⊂ '猫头鹰'）。
  // 放行会导致复合目标用同一素材拼出两份（E2E N03 实测「猫头鹰+猫头鹰」）。
  const nested = matchRequestedObjects(
    normalizeRequestObjects(['猫头鹰', '猫']),
    [{ objectName: '猫头鹰', aliases: ['owl'] }],
  );
  check(
    '比对：请求「猫」不被「猫头鹰」认领（严格口径）',
    nested.missing.length === 1 && nested.missing[0].name === '猫',
    JSON.stringify(nested),
  );
  check('严格匹配：单字不按子串覆盖', !namesMatchStrict('猫', '猫头鹰'));
  check('严格匹配：完全相同', namesMatchStrict('猫', '猫'));
  check(
    '严格匹配：多字包含算覆盖（丛林猫 ⊃ 丛林）',
    namesMatchStrict('长颈鹿', '长颈鹿') && namesMatchStrict('丛林猫', '丛林'),
  );
  check(
    '严格匹配：不同对象不互相认领（长颈鹿 ≠ 鹿）',
    !namesMatchStrict('长颈鹿', '鹿'),
  );
  check(
    '严格匹配：别名精确命中（兔子 ↔ 兔素材的别名「兔子」）',
    namesMatchStrict('兔子', '兔子'),
  );
}

// ---------- 交付一致性核对 ----------
{
  const requested = normalizeRequestObjects(['马', '狗']);
  const missing = checkDeliveryObjectConsistency({
    requested,
    customShape: { name: '马', parts: [{ name: '马' }] },
  });
  check('一致性：缺对象 → ok=false 且列出缺失', !missing.ok && missing.missing.length === 1, JSON.stringify(missing));

  const ok = checkDeliveryObjectConsistency({
    requested,
    customShape: { name: '马+狗', parts: [{ name: '马' }, { name: '狗' }] },
  });
  check('一致性：两对象都在 → ok=true', ok.ok && ok.deliveredPartCount === 2, JSON.stringify(ok));

  const single = checkDeliveryObjectConsistency({
    requested: normalizeRequestObjects(['狗']),
    customShape: { name: '小狗', parts: [] },
    extraNames: ['小狗'],
  });
  check('一致性：单对象 + 参考命中别名 → ok=true', single.ok, JSON.stringify(single));
}

// ---------- 一对一身份匹配（方案 2026-11-08 §4.2） ----------
{
  // 别名：请求「兔子」交付「兔」→ 覆盖（不误报）
  const aliasCase = matchDeliveredObjects({
    requested: normalizeRequestObjects(['兔子']),
    units: [{ name: '兔', partIndex: 0, identified: true }],
  });
  check('一对一：别名覆盖（兔子 ↔ 兔）→ 完整', aliasCase.complete, JSON.stringify(aliasCase));

  // 嵌套名称正例：请求「猫头鹰」+「猫」，交付两个单元 → 两个都认领到，不被拆
  const nested = matchDeliveredObjects({
    requested: normalizeRequestObjects(['猫头鹰', '猫']),
    units: [
      { name: '猫头鹰', partIndex: 0, identified: true },
      { name: '猫', partIndex: 1, identified: true },
    ],
  });
  check(
    '一对一：猫头鹰+猫 嵌套名称 → 两个都认领到（不误拆）',
    nested.complete && nested.assignments.every((item) => item.verified),
    JSON.stringify(nested),
  );

  // 重复组成部分：请求 猫/狗/兔，交付 猫/狗/狗 → 兔缺失（不漏报）
  const duplicate = matchDeliveredObjects({
    requested: normalizeRequestObjects(['猫', '狗', '兔']),
    units: [
      { name: '猫', partIndex: 0, identified: true },
      { name: '狗', partIndex: 1, identified: true },
      { name: '狗', partIndex: 2, identified: true },
    ],
  });
  check(
    '一对一：重复组成部分 → 缺对象被报出（不漏报）',
    !duplicate.complete && duplicate.missing.length === 1 && duplicate.missing[0].name === '兔',
    JSON.stringify(duplicate),
  );

  // 同一部分不得重复认领两个请求：请求 猫+猫，交付一个猫 → 缺一个
  const samePart = matchDeliveredObjects({
    requested: normalizeRequestObjects(['猫', '猫头鹰']),
    units: [{ name: '猫', partIndex: 0, identified: true }],
  });
  check(
    '一对一：同一部分不得认领两个请求 → 第二个请求缺失',
    !samePart.complete && samePart.missing.length === 1,
    JSON.stringify(samePart),
  );

  // 身份未知的部分：数量对得上但身份没核实 → 标 unverified，不算已核实通过
  const unnamed = matchDeliveredObjects({
    requested: normalizeRequestObjects(['猫', '狗']),
    units: [
      { name: '猫', partIndex: 0, identified: true },
      { name: '', partIndex: 1, identified: false },
    ],
  });
  check(
    '一对一：无名部分顶替 → 标记未核实（unverifiedCount=1）',
    unnamed.complete && unnamed.unverifiedCount === 1,
    JSON.stringify(unnamed),
  );

  // 派生身份单元：多部分用部分名（整体名只是展示名）
  const units = buildDeliveredObjectUnits({
    customShape: { name: '猫+狗+兔子', parts: [{ name: '猫' }, { name: '狗' }, { name: '兔子' }] },
  });
  check(
    '身份单元：多部分取各部分名（不把整体显示名当身份）',
    units.length === 3 && units[2].name === '兔子',
    JSON.stringify(units),
  );

  // 一致性核对走结构化身份：三个对象三个不同部分 → 完整
  const triple = checkDeliveryObjectConsistency({
    requested: normalizeRequestObjects(['猫', '狗', '兔子']),
    customShape: { name: '猫+狗+兔子', parts: [{ name: '猫' }, { name: '狗' }, { name: '兔子' }] },
  });
  check(
    '一致性：三个对象三个不同部分 → ok=true 且身份逐个认领',
    triple.ok && triple.assignments.length === 3 && triple.assignments.every((item) => item.verified),
    JSON.stringify(triple),
  );

  // 单对象请求 + 多部分形状（风车的四片叶子）：整体就是那个对象，
  // 不能因为"部分名都不是风车"而判成缺对象（2026-11-08 B3 实测）。
  const singleMultiPart = checkDeliveryObjectConsistency({
    requested: normalizeRequestObjects(['四叶风车']),
    customShape: { name: '四叶风车', parts: [{ name: '叶片1' }, { name: '叶片2' }, { name: '叶片3' }, { name: '叶片4' }] },
  });
  check(
    '一致性：单对象 + 多部分形状 → 整体名即身份（不判缺对象）',
    singleMultiPart.ok && singleMultiPart.missing.length === 0,
    JSON.stringify(singleMultiPart),
  );

  // 多对象请求仍必须一一对应：整体名不能替两个请求对象背书
  const twoObjectsOneShape = checkDeliveryObjectConsistency({
    requested: normalizeRequestObjects(['猫', '狗']),
    customShape: { name: '猫和狗', parts: [{ name: '猫' }, { name: '狗' }] },
  });
  check(
    '一致性：多对象仍按部分一对一（整体名不顶替两个对象）',
    twoObjectsOneShape.ok && twoObjectsOneShape.assignments.length === 2,
    JSON.stringify(twoObjectsOneShape),
  );

  // 单对象 + 叫法不同（用户说"正方形"、内置图形名是"矩形"）：
  // 名字不足以判"交付了别的对象"——记为"未核实"，语义对不对由目标验收负责。
  const naming = checkDeliveryObjectConsistency({
    requested: normalizeRequestObjects(['正方形']),
    customShape: { name: '矩形', parts: [{ name: '矩形' }] },
  });
  check(
    '一致性：单对象叫法不同 → 记未核实，不判缺对象',
    naming.ok && naming.missing.length === 0 && naming.unverifiedCount === 1,
    JSON.stringify(naming),
  );
}

// ---------- 缺对象回复 ----------
{
  const reply = composeObjectShortfallReply({
    requested: normalizeRequestObjects(['马', '狗']),
    delivered: ['马'],
    missing: normalizeRequestObjects(['狗']),
  });
  check('回复：列出已命中对象', reply.includes('马'), reply);
  check('回复：列出缺失对象', reply.includes('狗'), reply);
  check('回复：不承诺未交付对象', !/已规划/.test(reply), reply);
}

// ---------- 意图层贯通 ----------
{
  const intent = normalizeIntent({
    action: 'plan',
    customShape: { name: '马', points: [[0, 0], [0.5, 0], [0, 0.5]] },
    requestObjects: [{ name: '马', aliases: ['马匹'] }, { name: '狗' }],
  });
  check(
    '意图：requestObjects 归一化后随意图流转',
    Array.isArray(intent.requestObjects) && intent.requestObjects.length === 2 && intent.requestObjects[0].aliases[0] === '马匹',
    JSON.stringify(intent.requestObjects),
  );
  const noObjects = normalizeIntent({ action: 'plan', customShape: { name: '马', points: [[0, 0], [0.5, 0], [0, 0.5]] } });
  check('意图：未给 requestObjects → 空数组', Array.isArray(noObjects.requestObjects) && noObjects.requestObjects.length === 0);
}

if (failures > 0) {
  console.error(`\nFAILED: ${failures}/${checks} 项未通过`);
  process.exitCode = 1;
} else {
  console.log(`\nPASS: request-objects 全部断言通过（${checks} 项）`);
}
