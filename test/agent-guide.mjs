/**
 * 引导状态机测试（Node 直接运行，不依赖浏览器与网络）。
 *
 * 时间维度已移除：槽位只剩地点。覆盖：
 * - nextMissingSlot：地点槽位判定
 * - fillFromOption：选项精确填充、当前视野中心、非选项文本返回 null
 * - mergeIntentInto：自由文本 LLM 重解析合并（新非空字段优先）；图形被重新解析替换时
 *   清掉旧参考图命中（referenceSource），避免点序列图错标"参考图命中"
 * - finalizeIntent：action 重算（有图形 plan / 无图形 recommend）与尺寸基准定稿
 * - 地点选项来自地点配置（数量/内容随配置变化，测试从配置推导，不抄一份地名表）
 *
 * 运行：node test/agent-guide.mjs
 */

import {
  CENTER_OPTION_VALUE,
  createPlaceOptions,
  createGuideState,
  fillFromOption,
  finalizeIntent,
  mergeIntentInto,
  nextMissingSlot,
  questionFor,
} from '../web/src/agent/guide.js';
import { placeConfig } from './fixtures/place-config.mjs';

let failures = 0;

/** 断言工具：记录并通过/失败计数 */
function check(label, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) {
    failures += 1;
  }
  console.log(`[check] ${label} -> ${ok ? 'PASS' : `FAIL ${detail}`}`);
}

const POIS = placeConfig.activeCity.pois;
const EXPECTED_OPTIONS = Math.min(4, POIS.length) + 1;

// ---------- 场景一：plan 只给图形（"画个心形"）→ 问地点 → 补齐后定稿 ----------
const s1 = createGuideState({
  action: 'plan', shapeKey: 'heart', customShape: null, place: null, sizeMeters: 1200,
});
check('只给图形：先问地点', nextMissingSlot(s1) === 'place');
check('非选项文本不消费（交 LLM）', fillFromOption(s1, '随便啦', placeConfig) === null);
check('时间文本不再是选项（交 LLM）', fillFromOption(s1, '1 小时', placeConfig) === null);
const firstPoiLabel = POIS[0].name;
const f1 = fillFromOption(s1, firstPoiLabel, placeConfig);
check('地点选项填充', f1 !== null && s1.intent.place === firstPoiLabel);
check('地点已填：无缺槽（不再问时间）', nextMissingSlot(s1) === null);
check('定稿 action=plan 且保留尺寸基准', finalizeIntent(s1).action === 'plan');

// ---------- 场景二：当前视野中心（recommend） ----------
const s2 = createGuideState({
  action: 'recommend', shapeKey: null, customShape: null, place: null, sizeMeters: null,
});
const fCenter = fillFromOption(s2, CENTER_OPTION_VALUE, placeConfig);
check('选当前视野中心：消费成功', fCenter !== null);
check('选当前视野中心：place 仍 null 但已标记', s2.intent.place === null && s2.placeCenterChosen === true);
check('中心已选：无缺槽', nextMissingSlot(s2) === null);
const final2 = finalizeIntent(s2);
check('无图形定稿为 recommend 且 sizeMeters=null', final2.action === 'recommend' && final2.sizeMeters === null);

// ---------- 场景三：显式尺寸锁定 ----------
const s3 = createGuideState(
  { action: 'plan', shapeKey: 'star', customShape: null, place: POIS[0].name, sizeMeters: 1000 },
  { sizeLocked: true },
);
check('地点齐全：无需追问', nextMissingSlot(s3) === null);
check('sizeLocked 定稿保留显式尺寸', finalizeIntent(s3).sizeMeters === 1000);

// ---------- 场景四：地点已给（原来会问时间，现在直接齐全） ----------
const s4 = createGuideState({
  action: 'plan', shapeKey: 'rect', customShape: null, place: POIS[1].name, sizeMeters: 1200,
});
check('地点已给：直接齐全（时间维度已移除）', nextMissingSlot(s4) === null);

// ---------- 场景五：自由文本合并（用户在地点追问下输入"某地标 + 五角星"） ----------
const s5 = createGuideState({
  action: 'recommend', shapeKey: null, customShape: null, place: null, sizeMeters: null,
});
mergeIntentInto(s5, {
  action: 'plan', shapeKey: 'star', customShape: null, place: POIS[1].name, sizeMeters: null, rotationDeg: 0,
});
check('合并后地点与图形都有', s5.intent.place === POIS[1].name && s5.intent.shapeKey === 'star');
check('合并后无缺槽', nextMissingSlot(s5) === null);
const final5 = finalizeIntent(s5);
check('合并定稿：plan + 五角星', final5.action === 'plan' && final5.shapeKey === 'star');

// ---------- 场景六：引导中自由文本换图形 → 旧参考图命中必须清掉（点序列图来源不能错标） ----------
const REFERENCE_SOURCE = { id: 'horse-phylopic', name: '马', license: 'CC0-1.0', matchedAlias: '马', pointCount: 320 };
const s6 = createGuideState({
  action: 'plan',
  shapeKey: null,
  customShape: { name: '参考马' },
  place: null,
  sizeMeters: 1200,
  referenceSource: REFERENCE_SOURCE,
});
// 只回答地点：图形没有变，参考图命中应保留（来源仍标"参考图命中"）
mergeIntentInto(s6, { action: 'plan', shapeKey: null, customShape: null, place: POIS[0].name });
check(
  '仅补地点：参考图命中保留',
  s6.intent.referenceSource === REFERENCE_SOURCE && s6.intent.customShape?.name === '参考马',
);
// 自由文本重新解析出另一个自定义图形（如"画个猫"）：轮廓被替换，旧参考图命中必须清掉
mergeIntentInto(s6, { action: 'plan', shapeKey: null, customShape: { name: 'LLM猫' } });
check('换自定义图形：参考图命中被清掉', s6.intent.referenceSource === null && s6.intent.customShape?.name === 'LLM猫');
check('换自定义图形：shapeKey 保持为空', s6.intent.shapeKey === null);

// 内置图形分支：参考图命中状态被新 shapeKey 替换时同样清掉
const s7 = createGuideState({
  action: 'plan',
  shapeKey: null,
  customShape: { name: '参考马' },
  place: POIS[0].name,
  sizeMeters: 1200,
  referenceSource: REFERENCE_SOURCE,
});
mergeIntentInto(s7, { action: 'plan', shapeKey: 'star', customShape: null });
check(
  '换内置图形：参考图命中被清掉',
  s7.intent.referenceSource === null && s7.intent.shapeKey === 'star' && s7.intent.customShape === null,
);

// ---------- 问题与选项结构（从配置推导，不写死） ----------
const placeQ = questionFor('place', placeConfig);
check(
  '地点问题选项 = 前 4 个配置地标 + 视野中心',
  placeQ.options.length === EXPECTED_OPTIONS &&
    placeQ.options.slice(0, -1).every((option, index) => option.label === POIS[index].name) &&
    placeQ.options.some((option) => option.value === CENTER_OPTION_VALUE),
  JSON.stringify(placeQ.options.map((option) => option.label)),
);
check('createPlaceOptions 可显式限制地标数', createPlaceOptions(placeConfig, 2).length === 3);
check(
  '没有地标配置时仍有视野中心选项',
  createPlaceOptions({ activeCity: { pois: [] } }).length === 1,
);

console.log(failures === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${failures} checks)`);
process.exit(failures === 0 ? 0 : 2);
