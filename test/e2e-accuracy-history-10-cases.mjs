/**
 * A 组：10 个历史问题例（方案 2026-11-08 §8.3）。
 *
 * 输入原文**保持不改**——全部来自 2026-11-07 历史 40 例真实 LLM 浏览器 E2E
 * 及其对应 trace/结果 JSON。问题证据：
 *
 * | ID | 历史问题 | 本方案验收点 |
 * | --- | --- | --- |
 * | A1 | 800m 最终交付为 6000m | 正式交付必须为 800m 或声明容差内；否则诚实失败/请求确认 |
 * | A2 | 400m 最终交付为 2400m | 正式交付必须遵守 400m 口径；没有合格候选时允许诚实失败 |
 * | A3 | 1200m 最终交付为 7200m | 正式交付必须为 1200m 或声明容差内，且仍过路线质量门 |
 * | A4 | 粗搜 90°，精修后交付 100° | 最终实际朝向必须为 90° 或声明容差内 |
 * | A5 | 未直接断言实际半径比，出现 target.constraints.unchecked | 实际 innerRadii/outerRadii=0.5 且不变量通过 |
 * | A6 | "兔子/兔"字符串断言误报；数量短路漏报风险 | 猫/狗/兔子各对应一个不同实际组成部分 |
 * | A7 | 34 点低于硬下限，只回复"没有可用轮廓" | 点数门与"长尾巴"约束证据可读，失败原因具体 |
 * | A8 | 语义 unlike + 修正响应 finishReason=length | 语义失败与截断分别留痕；回复对应真实原因 |
 * | A9 | 嵌套孔洞仍进入一次无效恢复 | 识别能力边界并停止无效恢复；不得绿线 |
 * | A10 | 点数证据为空但 pointGateExecuted=true | 候选轮必须有实际 pointCount/pointGate/visual |
 *
 * 合法结果可以是合格交付、橙色诊断或诚实失败，但必须符合对应验收点。
 * **不能把历史未交付一律改判为失败，也不能把诚实未交付计为合格出图。**
 */

import { makeCase } from './e2e-case-lib.mjs';

/** 尺寸容差：与生产口径一致（max(60m, 12%)，上限 300m） */
const SIZE_TOLERANCE = (meters) => Math.min(300, Math.max(60, Math.round(meters * 0.12)));

export const CASES = [
  makeCase({
    id: 'A1',
    category: 'A1 显式尺寸·800 米心形',
    title: '小蛮腰 800 米心形（历史交付 6000m）',
    input: '在小蛮腰画个 800 米的心形',
    expected:
      'plan；地点小蛮腰；显式尺寸 800 米；正式交付必须是 800m ±96m，不得静默放大到 6000m；没有合格候选时诚实失败或请求确认',
    shot: 'a1-heart-800m',
    expect: {
      actions: ['plan'],
      placeIncludes: ['小蛮腰'],
      intentSizeMeters: 800,
      deliveredSizeMeters: 800,
      deliveredSizeToleranceMeters: SIZE_TOLERANCE(800),
      nameIncludes: ['心'],
      outlineSources: ['builtin', 'reference', 'llm', 'procedural'],
      // 交付可选（诚实失败合法），但交付了就必须满足尺寸
      expectDeliveryOutcomeIn: [
        'qualified-delivery',
        'authorized-compromise',
        'diagnostic-reference',
        'honest-no-delivery',
        'not-covered',
      ],
    },
  }),
  makeCase({
    id: 'A2',
    category: 'A2 显式尺寸·400 米矩形',
    title: '北京路 400 米矩形（历史交付 2400m）',
    input: '在北京路画个周正的矩形，边长 400 米',
    expected:
      'plan；地点北京路；显式尺寸 400 米；正式交付必须遵守 400m 口径；没有合格候选时允许诚实失败，不得换大尺寸冒充成功',
    shot: 'a2-rect-400m',
    expect: {
      actions: ['plan'],
      placeIncludes: ['北京路'],
      intentSizeMeters: 400,
      deliveredSizeMeters: 400,
      deliveredSizeToleranceMeters: SIZE_TOLERANCE(400),
      nameIncludes: ['矩', '方'],
      outlineSources: ['builtin', 'procedural', 'reference', 'llm'],
      expectDeliveryOutcomeIn: [
        'qualified-delivery',
        'authorized-compromise',
        'diagnostic-reference',
        'honest-no-delivery',
        'not-covered',
      ],
    },
  }),
  makeCase({
    id: 'A3',
    category: 'A3 显式尺寸·1200 米五角星',
    title: '广州塔 1200 米五角星（历史交付 7200m）',
    input: '在广州塔画个 1200 米的五角星',
    expected:
      'plan；地点广州塔；显式尺寸 1200 米；正式交付必须为 1200m ±144m 且仍通过现有路线质量门',
    shot: 'a3-star-1200m',
    expect: {
      actions: ['plan'],
      placeIncludes: ['广州塔'],
      intentSizeMeters: 1200,
      deliveredSizeMeters: 1200,
      deliveredSizeToleranceMeters: SIZE_TOLERANCE(1200),
      nameIncludes: ['星'],
      outlineSources: ['builtin', 'procedural', 'reference', 'llm'],
      expectDeliveryOutcomeIn: [
        'qualified-delivery',
        'authorized-compromise',
        'diagnostic-reference',
        'honest-no-delivery',
        'not-covered',
      ],
    },
  }),
  makeCase({
    id: 'A4',
    category: 'A4 显式朝向·90 度',
    title: '花城广场五角星旋转 90 度（历史精修后交付 100°）',
    input: '在花城广场画个五角星，整体旋转 90 度',
    expected:
      'plan；地点花城广场；显式朝向 90°；最终实际交付朝向必须为 90° ±5°（精修不得破坏显式朝向）',
    shot: 'a4-star-rotation-90',
    expect: {
      actions: ['plan'],
      placeIncludes: ['花城广场'],
      intentRotationDeg: 90,
      deliveredRotationDeg: 90,
      deliveredRotationToleranceDeg: 5,
      nameIncludes: ['星'],
      outlineSources: ['builtin', 'procedural', 'reference', 'llm'],
      expectDeliveryOutcomeIn: [
        'qualified-delivery',
        'authorized-compromise',
        'diagnostic-reference',
        'honest-no-delivery',
        'not-covered',
      ],
    },
  }),
  makeCase({
    id: 'A5',
    category: 'A5 参数化结构约束·六角星内外半径',
    title: '陈家祠六角星（内侧尖角比外尖角短一半）',
    input: '在陈家祠画个六角星，内侧的尖角要比外尖角短一半',
    expected:
      'plan；地点陈家祠；参数化规格实际 innerRadii/outerRadii=0.5（±0.05）且几何不变量复验通过；无法核验时不得绿线',
    shot: 'a5-hexagram-inner-ratio',
    expect: {
      actions: ['plan'],
      placeIncludes: ['陈家祠'],
      expectSpecInnerOuterRatio: 0.5,
      expectSpecRatioTolerance: 0.05,
      expectSpecInvariants: true,
      userConstraintIncludes: '尖角',
      outlineSources: ['procedural'],
      expectDeliveryOutcomeIn: [
        'qualified-delivery',
        'authorized-compromise',
        'diagnostic-reference',
        'honest-no-delivery',
        'not-covered',
      ],
    },
  }),
  makeCase({
    id: 'A6',
    category: 'A6 多对象一对一·猫狗兔',
    title: '北京路 猫 + 狗 + 兔子（历史字符串断言误报）',
    input: '在北京路画一只猫、一只狗和一只兔子',
    expected:
      'plan；地点北京路；猫、狗、兔子各对应一个**不同**的实际组成部分（别名不误报、重复/缺失不漏报）',
    shot: 'a6-cat-dog-rabbit',
    expect: {
      actions: ['plan'],
      placeIncludes: ['北京路'],
      multiObjectKeywords: ['猫', '狗', '兔子'],
      deliveredObjects: ['猫', '狗', '兔子'],
      requireVerifiedObjects: true,
      outlineSources: ['reference', 'llm'],
      expectDeliveryOutcomeIn: [
        'qualified-delivery',
        'authorized-compromise',
        'diagnostic-reference',
        'honest-no-delivery',
        'not-covered',
      ],
    },
  }),
  makeCase({
    id: 'A7',
    category: 'A7 自由轮廓·点数门与约束证据',
    title: '珠江新城 拖着长尾巴的彗星（历史 34 点被拒且回复笼统）',
    input: '在珠江新城画一颗拖着长尾巴的彗星',
    expected:
      'plan；地点珠江新城；自由轮廓候选轮必须留下实际点数/点数门/视觉结论证据；若仍拒绝，失败原因必须可读（点数或约束），不得只有笼统失败',
    shot: 'a7-comet-freeform',
    expect: {
      actions: ['plan'],
      placeIncludes: ['珠江新城'],
      userConstraintIncludes: '尾巴',
      expectFreeformChecks: true,
      expectVerifiedConstraints: true,
      expectFreeformReason: true,
      expectDeliveryOutcomeIn: [
        'qualified-delivery',
        'authorized-compromise',
        'diagnostic-reference',
        'honest-no-delivery',
        'not-covered',
      ],
    },
  }),
  makeCase({
    id: 'A8',
    category: 'A8 自由轮廓·语义失败与截断留痕',
    title: '北京路 龙舟（历史语义 unlike + 修正截断后笼统失败）',
    input: '在北京路画一条龙舟',
    expected:
      'plan；地点北京路；语义失败与输出截断分别留痕（checks.visual / 终止原因 / 响应元数据），最终回复对应真实原因，不把截断伪装成"没有素材"',
    shot: 'a8-dragon-boat',
    expect: {
      actions: ['plan'],
      placeIncludes: ['北京路'],
      expectFreeformChecks: true,
      expectVerifiedConstraints: true,
      expectFreeformReason: true,
      expectDeliveryOutcomeIn: [
        'qualified-delivery',
        'authorized-compromise',
        'diagnostic-reference',
        'honest-no-delivery',
        'not-covered',
      ],
    },
  }),
  makeCase({
    id: 'A9',
    category: 'A9 不支持拓扑·同心圆',
    title: '越秀公园 同心圆（历史仍进入一次无效恢复）',
    input: '在越秀公园画一个同心圆',
    expected:
      'plan；地点越秀公园；嵌套孔洞属当前不支持的拓扑，必须识别能力边界并停止无效恢复；不得绿线交付',
    shot: 'a9-concentric-circles',
    expect: {
      actions: ['plan'],
      placeIncludes: ['越秀公园'],
      // 合法结果：诚实失败 / 诊断参考 / 未覆盖；条件断言：本轮真的产生了嵌套孔洞时不得绿线
      expectDeliveryOutcomeIn: [
        'qualified-delivery',
        'authorized-compromise',
        'diagnostic-reference',
        'honest-no-delivery',
        'not-covered',
      ],
      expectNoQualifiedWhenUnsupported: true,
    },
  }),
  makeCase({
    id: 'A10',
    category: 'A10 自由轮廓·验收证据不得为空',
    title: '花城广场 独角兽（历史"已执行但 checks 为空"）',
    input: '在花城广场画一只独角兽',
    expected:
      'plan；地点花城广场；候选轮必须有实际 pointCount/pointGate/visual；截断有证据；不得出现"已执行但 checks 为空"',
    shot: 'a10-unicorn',
    expect: {
      actions: ['plan'],
      placeIncludes: ['花城广场'],
      expectFreeformChecks: true,
      expectVerifiedConstraints: true,
      expectFreeformReason: true,
      expectDeliveryOutcomeIn: [
        'qualified-delivery',
        'authorized-compromise',
        'diagnostic-reference',
        'honest-no-delivery',
        'not-covered',
      ],
    },
  }),
];

export const SUITE_TITLE = '准确性优先·历史 10 例（真实 LLM 浏览器 E2E）';
