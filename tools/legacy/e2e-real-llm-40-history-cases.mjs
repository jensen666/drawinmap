/**
 * DrawInMap 真实浏览器 E2E：历史 40 例回归（2026-11-07）。
 *
 * 选例口径：全部 40 条输入原文均取自仓库历史用例库（未改写、零新增原文），
 * 覆盖此前 6 轮真实 LLM E2E 的全部用例面，重点回归历史弱例与最近一轮
 * 缺陷修复（2026-11-06 缺陷清单）的修复点是否仍然成立：
 *
 * - R1·30 例库（2026-11-01，test/e2e-real-llm-30-cases.mjs）10 例：
 *   显式尺寸/朝向/参数化/参考图/自由轮廓/未解析地点/推荐；
 * - R2·20 新例库（2026-11-02，test/e2e-real-llm-20-new-cases.mjs）4 例：
 *   多边形参数/大尺寸/参考图/覆盖外地点；
 * - R3·历史弱例（2026-11-04，test/e2e-real-llm-20-history-cases.mjs）10 例：
 *   尺寸基准、多候选、点数门、极慢、别名劫持、自交、多部分、主观不可表达、多孔拓扑、多对象；
 * - R3·复杂新例（2026-11-04，test/e2e-real-llm-20-new-complex-cases.mjs）4 例：
 *   鲨鱼/摩天轮/龙舟/同心圆；
 * - R4·多对象库（2026-11-05，test/e2e-real-llm-16-new-cases.mjs）5 例：
 *   三对象/双对象/双对象+显式尺寸/结构参数/多部分+显式尺寸；
 * - R5·缺陷修复回归（2026-11-07，test/e2e-bugfix-cases.mjs）7 例：
 *   在线补漏、引导质检原文、选优分档、约束闸门、点数分级放行、备选切换、失败可见化。
 *
 * 断言口径：R1/R2 的老用例 run() 写于 2026-11-01/02，不处理后来上线的
 * 「候选卡确认」交互（在线补漏修复后在线/自由轮廓候选更常出现），直接复跑会把
 * 交互演化误报为缺陷。因此 R1/R2 的 14 条**输入原文**统一用当前断言库
 * e2e-case-lib.mjs 的 makeCase 重新包装（与 2026-11-05 轮历史集口径一致）；
 * R3h/R3c/R4/R5 本就是断言库用例，原样引入。输入原文零改写。
 *
 * 溯源校验（只读，不消耗额度）：
 *   node tools/e2e-input-dedup.mjs --cases-file test/e2e-real-llm-40-history-cases.mjs --require-history
 *
 * 运行入口（真实 LLM + 真实路网，会消耗模型额度）：
 *   node web/server.mjs 5173   # 先启动本地服务器
 *   node tools/e2e-real-llm-30.mjs --cases-file test/e2e-real-llm-40-history-cases.mjs \
 *     --artifact-dir "docs/测试报告/2026-11-07-真实LLM-E2E-40例历史回归" \
 *     --out result-history40.json --turn-timeout 420000
 *
 * 稳定性口径（2026-11-07）：单浏览器连跑 40 例出现过页签卡死
 * （CDP Page.navigate 超时），建议按 --cases 分段跑、每段独立浏览器：
 *   node tools/e2e-real-llm-30.mjs ... --cases R1-A1,R1-A2,...（每段 ≤10 例）
 */

import { makeCase } from '../../test/e2e-case-lib.mjs';
import { CASES as R3_HISTORY_CASES } from './e2e-real-llm-20-history-cases.mjs';
import { CASES as R3_COMPLEX_CASES } from './e2e-real-llm-20-new-complex-cases.mjs';
import { CASES as R4_CASES } from './e2e-real-llm-16-new-cases.mjs';
import { CASES as R5_CASES } from '../../test/legacy/e2e-bugfix-cases.mjs';

/** 规则图形（内置/参数化）渠道合集：与 2026-11-04 X18~X20 断言口径一致 */
const RULE_SOURCES = ['builtin', 'procedural'];

/**
 * 从历史用例库挑选并重编 ID（避免跨库撞号），类别前缀标注来源轮次。
 *
 * @param {Array<object>} cases 历史用例库
 * @param {string} round 来源轮次标注（如「R3·历史弱例」）
 * @param {Record<string, string>} picks 用例 id → 新 id 映射（挑选即声明）
 * @returns {Array<object>} 重编后的用例
 */
function pickFrom(cases, round, picks) {
  return Object.entries(picks).map(([oldId, newId]) => {
    const found = cases.find((item) => item.id === oldId);
    if (!found) {
      throw new Error(`用例库缺少 ${oldId}，请核对用例文件`);
    }
    return {
      ...found,
      id: newId,
      category: `${round} · ${found.category}`,
    };
  });
}

export const CASES = [
  // ===== R1·30例库（2026-11-01）：尺寸/朝向/参数化/参考图/自由轮廓/引导/推荐 =====
  // 输入原文不变；断言用当前库 makeCase 重新包装（处理候选卡交互 + 三态交付 + 非退化）
  makeCase({
    id: 'RA1',
    category: 'R1·30例库 · 尺寸别名',
    title: '内置心形 + 地点别名「小蛮腰」+ 显式尺寸 800 米',
    input: '在小蛮腰画个 800 米的心形',
    expected:
      'plan；地点别名「小蛮腰」解析为广州塔；显式尺寸 800m 被采用；目标名称含「心形」（内置/参数化/参考图渠道均合法，候选卡点第一张）；交付非退化',
    shot: 'heart-alias-size',
    expect: {
      actions: ['plan'],
      placeIncludes: ['广州塔'],
      nameIncludes: ['心形'],
      intentSizeMeters: 800,
      outlineSources: [...RULE_SOURCES, 'reference'],
      requireDelivery: true,
    },
  }),
  makeCase({
    id: 'RA2',
    category: 'R1·30例库 · 尺寸别名',
    title: '内置矩形 + 道路名「北京路」+ 显式边长 400 米',
    input: '在北京路画个周正的矩形，边长 400 米',
    expected: 'plan；地点解析为北京路；显式尺寸 400m 被采用；目标名称含「矩形」；交付非退化',
    shot: 'rect-road-size',
    expect: {
      actions: ['plan'],
      placeIncludes: ['北京路'],
      nameIncludes: ['矩形'],
      intentSizeMeters: 400,
      outlineSources: [...RULE_SOURCES, 'reference'],
      requireDelivery: true,
    },
  }),
  makeCase({
    id: 'RA3',
    category: 'R1·30例库 · 显式朝向',
    title: '内置五角星 + 显式朝向 90 度',
    input: '在花城广场画个五角星，整体旋转 90 度',
    expected: 'plan；显式朝向解析为 rotationDeg=90；目标名称含「五角星」；交付非退化',
    shot: 'star-rotation',
    expect: {
      actions: ['plan'],
      placeIncludes: ['花城广场'],
      nameIncludes: ['五角星'],
      intentRotationDeg: 90,
      outlineSources: [...RULE_SOURCES, 'reference'],
      requireDelivery: true,
    },
  }),
  makeCase({
    id: 'RA5',
    category: 'R1·30例库 · 参数化',
    title: '参数化十角星',
    input: '在珠江新城画个十角星',
    expected: 'plan；目标名称含「十角星」（参数化/内置渠道，候选卡点第一张）；交付非退化',
    shot: 'ten-star',
    expect: {
      actions: ['plan'],
      placeIncludes: ['珠江新城'],
      nameIncludes: ['十角星'],
      outlineSources: RULE_SOURCES,
      requireDelivery: true,
    },
  }),
  makeCase({
    id: 'RA6',
    category: 'R1·30例库 · 参数化',
    title: '参数化横向椭圆（扁扁的）',
    input: '在花城广场画个扁扁的椭圆',
    expected: 'plan；目标名称含「椭圆」；交付非退化',
    shot: 'flat-ellipse',
    expect: {
      actions: ['plan'],
      placeIncludes: ['花城广场'],
      nameIncludes: ['椭圆'],
      outlineSources: RULE_SOURCES,
      requireDelivery: true,
    },
  }),
  makeCase({
    id: 'RB3',
    category: 'R1·30例库 · 参考图',
    title: '本地参考图单候选·熊猫',
    input: '在花城广场画只熊猫',
    expected: 'plan；参考图熊猫命中（单候选直走或多候选点选）；交付非退化',
    shot: 'panda-reference',
    expect: {
      actions: ['plan'],
      placeIncludes: ['花城广场'],
      nameIncludes: ['熊猫'],
      outlineSources: ['reference', 'llm'],
      requireDelivery: true,
    },
  }),
  makeCase({
    id: 'RB4',
    category: 'R1·30例库 · 参考图',
    title: '本地参考图单候选·三角龙',
    input: '在陈家祠画只三角龙',
    expected: 'plan；参考图三角龙命中；交付非退化',
    shot: 'triceratops-reference',
    expect: {
      actions: ['plan'],
      placeIncludes: ['陈家祠'],
      nameIncludes: ['三角龙'],
      outlineSources: ['reference', 'llm'],
      requireDelivery: true,
    },
  }),
  makeCase({
    id: 'RD3',
    category: 'R1·30例库 · 自由轮廓',
    title: '自由轮廓·彗星（用户明说「长尾巴」约束）',
    input: '在珠江新城画一颗拖着长尾巴的彗星',
    expected: 'plan；意图记录「尾巴」约束；LLM 自由轮廓按点数门/质检结论交付或诚实失败；行为一致',
    shot: 'comet-freeform',
    expect: {
      actions: ['plan'],
      placeIncludes: ['珠江新城'],
      nameIncludes: ['彗星'],
      userConstraintIncludes: '尾巴',
      outlineSources: ['llm', 'reference'],
      allowNoDelivery: true,
    },
  }),
  makeCase({
    id: 'RE3',
    category: 'R1·30例库 · 地点边界',
    title: '未解析地点·火星基地（追问换地点，不画到视野中心）',
    input: '在火星基地画个五角星',
    expected: 'plan；地点未解析 → 追问（不规划、不绘制）；不得静默画到视野中心',
    shot: 'unresolved-place',
    expect: {
      actions: ['plan'],
      placeIncludes: ['火星基地'],
      noDelivery: true,
    },
  }),
  makeCase({
    id: 'RF1',
    category: 'R1·30例库 · 推荐',
    title: '条件实测推荐（二十分钟能画什么；时间维度已移除）',
    input: '我只有二十分钟，在花城广场附近能画什么？',
    expected: 'recommend；走实测推荐链路（recommend.result/failed）；推荐或诚实说明都画不出；不绘制未验收图形',
    shot: 'recommend',
    expect: {
      requireRecommend: true,
      placeIncludes: ['花城广场'],
      allowNoDelivery: true,
    },
  }),

  // ===== R2·20新例库（2026-11-02）：多边形参数/大尺寸/参考图/覆盖外 =====
  makeCase({
    id: 'M01',
    category: 'R2·20新例库 · 参数化',
    title: '参数化正十二边形 + 白云山',
    input: '在白云山画个正十二边形',
    expected: 'plan；目标名称含「十二边形」；交付非退化',
    shot: 'dodecagon',
    expect: {
      actions: ['plan'],
      placeIncludes: ['白云山'],
      nameIncludes: ['十二边形'],
      outlineSources: RULE_SOURCES,
      requireDelivery: true,
    },
  }),
  makeCase({
    id: 'M03',
    category: 'R2·20新例库 · 大尺寸',
    title: '五角星 + 广州塔 + 显式尺寸 1200 米',
    input: '在广州塔画个 1200 米的五角星',
    expected: 'plan；显式尺寸 1200m 被采用；目标名称含「五角星」；交付非退化',
    shot: 'big-star-1200m',
    expect: {
      actions: ['plan'],
      placeIncludes: ['广州塔'],
      nameIncludes: ['五角星'],
      intentSizeMeters: 1200,
      outlineSources: RULE_SOURCES,
      requireDelivery: true,
    },
  }),
  makeCase({
    id: 'M08',
    category: 'R2·20新例库 · 参考图',
    title: '参考图·企鹅 + 广州塔',
    input: '在广州塔画一只企鹅',
    expected: 'plan；参考图企鹅命中；交付非退化',
    shot: 'penguin-reference',
    expect: {
      actions: ['plan'],
      placeIncludes: ['广州塔'],
      nameIncludes: ['企鹅'],
      outlineSources: ['reference', 'llm'],
      requireDelivery: true,
    },
  }),
  makeCase({
    id: 'M20',
    category: 'R2·20新例库 · 覆盖外',
    title: '覆盖外城市·深圳画五角星（追问或诚实说明，不静默画）',
    input: '在深圳画个五角星',
    expected: 'plan；深圳不在广州路网覆盖内 → 追问换地点或明确说明超出覆盖；不静默画到视野中心、不绘制',
    shot: 'shenzhen-outside',
    expect: {
      actions: ['plan'],
      placeIncludes: ['深圳'],
      noDelivery: true,
    },
  }),

  // ===== R3·历史弱例（2026-11-04）：历史跑不出/跑得不好的复杂例（原样引入） =====
  ...pickFrom(R3_HISTORY_CASES, 'R3·历史弱例', {
    H01: 'H01', // 在广州塔附近走长颈鹿（尺寸基准回归）
    H04: 'H04', // 在广州塔附近走个猫（参考图多候选）
    H09: 'H09', // 在珠江新城画一朵向日葵（自由轮廓点数门）
    H13: 'H13', // 在花城广场画一座风车（历史极慢+质检逆修正超时）
    H14: 'H14', // 在珠江新城画一只龙虾（别名被单字「龙」劫持）
    H15: 'H15', // 在广州塔画一只独角兽（点列两轮自交）
    H16: 'H16', // 在广州画个中国地图（多部分轮廓自交）
    H17: 'H17', // 在珠江新城附近画个蒙娜丽莎（主观不可表达）
    H19: 'H19', // 在越秀公园画个奥迪标（多孔拓扑不可表达）
    H20: 'H20', // 在越秀公园画只猫，旁边再画只狗（多对象）
  }),

  // ===== R3·复杂新例（2026-11-04）：复杂剪影/多孔/贴路压力（原样引入） =====
  ...pickFrom(R3_COMPLEX_CASES, 'R3·复杂新例', {
    X01: 'X01', // 在花城广场画一条鲨鱼
    X05: 'X05', // 在珠江新城画一座摩天轮
    X10: 'X10', // 在北京路画一条龙舟
    X13: 'X13', // 在越秀公园画一个同心圆（多孔拓扑）
  }),

  // ===== R4·多对象库（2026-11-05）：多对象/多参数组合（原样引入） =====
  ...pickFrom(R4_CASES, 'R4·多对象库', {
    N02: 'P02', // 在北京路画一只猫、一只狗和一只兔子（三对象）
    N03: 'P03', // 在白云山画一只猫头鹰和一只猫（嵌套别名）
    N06: 'P06', // 在陈家祠画一只长颈鹿和一只鸵鸟，尺寸 1.5 公里（双对象+显式尺寸）
    N09: 'P09', // 在陈家祠画个六角星，内侧的尖角要比外尖角短一半（结构参数）
    N14: 'P14', // 在黄埔区画个中国地图，尺寸 3 公里（多部分+显式尺寸）
  }),

  // ===== R5·缺陷修复回归（2026-11-07）：2026-11-06 缺陷清单修复点（原样引入） =====
  ...pickFrom(R5_CASES, 'R5·缺陷修复', {
    B1: 'Q1', // 在花城广场画一只海马（Bug1 在线补漏）
    B2: 'Q2', // 生成一个小猪佩奇（Bug2 引导质检原文）
    B3: 'Q3', // 在广州塔附近画个五角星（Bug3 选优分档）
    B4: 'Q4', // 在花城广场画一匹马，要奔跑的样子（Bug4.1 约束闸门）
    B5: 'Q5', // 在花城广场画一只独角兽（Bug4.2 点数分级放行）
    B8: 'Q8', // 在珠江新城画个心形（Bug5 备选切换）
    B9: 'Q9', // 在花城广场画一只长颈鹿（Bug1 失败可见化）
  }),
];

export const SUITE_TITLE = '历史 40 例真实 LLM 浏览器 E2E 回归';
