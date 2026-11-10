/**
 * B 组：10 个冻结的全新例（方案 2026-11-08 §8.4）。
 *
 * 这 10 条在写入本方案时已通过仓库现有去重工具检查，均未在既有测试、工具、
 * 测试报告 JSON 或运行日志中出现。**实施时先写入正式用例文件并冻结，再开始运行。**
 *
 * 覆盖能力：
 * | ID | 全新输入 | 覆盖能力与合法结果 |
 * | --- | --- | --- |
 * | B1 | 正八边形 600 米 旋转 30 度 | 显式尺寸 + 朝向 + 参数化；必须同时满足，否则诚实失败/请求确认 |
 * | B2 | 700 米心形，顶部凹陷必须保留 | 显式尺寸 + 内置/参考约束；尺寸与凹陷均核验，无法核验不得绿线 |
 * | B3 | 四叶风车，四片叶子必须等长 | 自由轮廓结构 + 数量/等长约束；逐项核验或明确降级 |
 * | B4 | 抬头站立、尾巴下垂的狗 | 参考/自由轮廓 + 姿态约束；不能只因命中任意狗素材就给绿线 |
 * | B5 | 鸭子和猴子，鸭子必须在左边 | 多对象一对一 + 空间关系；无法核验时不得声称完整合格 |
 * | B6 | 张开双翅、左右对称的鸟 | 姿态 + 对称约束；逐项核验或明确降级 |
 * | B7 | 车身低、两个轮子大小相同的自行车 | 多部分 + 结构约束；支持则逐项验收，不支持则明确能力边界 |
 * | B8 | 有对称鱼鳍和分叉尾鳍的鱼 | 自由/参考轮廓 + 多个语义特征；全部核验或诚实失败 |
 * | B9 | 三个彼此分离、大小相同的圆，排成三角形 | 多部分数量/尺寸/布局约束；不支持时提前说明 |
 * | B10 | 一个正方形 | 无显式尺寸/朝向的普通对照例；不得被新约束闸门误伤 |
 */

import { makeCase } from './e2e-case-lib.mjs';

/** 尺寸容差：与生产口径一致（max(60m, 12%)，上限 300m） */
const SIZE_TOLERANCE = (meters) => Math.min(300, Math.max(60, Math.round(meters * 0.12)));

/** 合法结果集合：合格交付 / 授权折中 / 诊断参考 / 诚实未交付 / 分支未覆盖 */
const LEGAL_OUTCOMES = [
  'qualified-delivery',
  'authorized-compromise',
  'diagnostic-reference',
  'honest-no-delivery',
  'not-covered',
];

export const CASES = [
  makeCase({
    id: 'B1',
    category: 'B1 尺寸+朝向+参数化',
    title: '珠江新城 正八边形 600 米 旋转 30 度',
    input: '在珠江新城画一个正八边形，整体尺寸 600 米，旋转 30 度',
    expected:
      'plan；地点珠江新城；显式尺寸 600 米 + 显式朝向 30°；正式交付必须同时满足（尺寸 ±72m、朝向 ±5°），否则诚实失败/请求确认',
    shot: 'b1-octagon-600m-30deg',
    expect: {
      actions: ['plan'],
      placeIncludes: ['珠江新城'],
      intentSizeMeters: 600,
      deliveredSizeMeters: 600,
      deliveredSizeToleranceMeters: SIZE_TOLERANCE(600),
      intentRotationDeg: 30,
      deliveredRotationDeg: 30,
      deliveredRotationToleranceDeg: 5,
      nameIncludes: ['八', '角', '多边'],
      outlineSources: ['procedural', 'builtin'],
      expectDeliveryOutcomeIn: LEGAL_OUTCOMES,
    },
  }),
  makeCase({
    id: 'B2',
    category: 'B2 尺寸+结构约束·心形顶部凹陷',
    title: '广州塔 700 米心形（顶部凹陷必须保留）',
    input: '在广州塔画一个 700 米的心形，顶部凹陷必须保留',
    expected:
      'plan；地点广州塔；显式尺寸 700 米 + "顶部凹陷必须保留"；尺寸与凹陷均须核验，无法核验不得绿线',
    shot: 'b2-heart-700m-notch',
    expect: {
      actions: ['plan'],
      placeIncludes: ['广州塔'],
      intentSizeMeters: 700,
      deliveredSizeMeters: 700,
      deliveredSizeToleranceMeters: SIZE_TOLERANCE(700),
      userConstraintIncludes: '凹陷',
      outlineSources: ['builtin', 'reference', 'llm'],
      expectVerifiedConstraints: true,
      expectDeliveryOutcomeIn: LEGAL_OUTCOMES,
    },
  }),
  makeCase({
    id: 'B3',
    category: 'B3 自由轮廓结构+等长约束',
    title: '花城广场 四叶风车（四片叶子等长）',
    input: '在花城广场画一座四叶风车，四片叶子必须等长',
    expected:
      'plan；地点花城广场；自由轮廓结构 + 数量/等长约束必须逐项核验或明确降级，不得笼统通过',
    shot: 'b3-windmill-equal-leaves',
    expect: {
      actions: ['plan'],
      placeIncludes: ['花城广场'],
      userConstraintIncludes: '等长',
      expectFreeformChecks: true,

      expectFreeformReason: true,

      expectVerifiedConstraints: true,
      expectDeliveryOutcomeIn: LEGAL_OUTCOMES,
    },
  }),
  makeCase({
    id: 'B4',
    category: 'B4 参考/自由轮廓+姿态约束',
    title: '越秀公园 抬头站立尾巴下垂的狗',
    input: '在越秀公园画一只抬头站立、尾巴下垂的狗',
    expected:
      'plan；地点越秀公园；姿态约束必须核验——不能只因命中任意狗素材就给绿线',
    shot: 'b4-dog-posture',
    expect: {
      actions: ['plan'],
      placeIncludes: ['越秀公园'],
      userConstraintIncludes: '尾巴',
      expectFreeformChecks: true,

      expectFreeformReason: true,

      expectVerifiedConstraints: true,
      expectDeliveryOutcomeIn: LEGAL_OUTCOMES,
    },
  }),
  makeCase({
    id: 'B5',
    category: 'B5 多对象一对一+空间关系',
    title: '北京路 鸭子和猴子（鸭子必须在左边）',
    input: '在北京路画一只鸭子和一只猴子，鸭子必须在左边',
    expected:
      'plan；地点北京路；鸭子与猴子各对应一个不同组成部分；左右关系无法核验时不得声称完整合格',
    shot: 'b5-duck-monkey-left',
    expect: {
      actions: ['plan'],
      placeIncludes: ['北京路'],
      multiObjectKeywords: ['鸭子', '猴子'],
      deliveredObjects: ['鸭子', '猴子'],
      requireVerifiedObjects: true,
      expectFreeformReason: true,
      expectDeliveryOutcomeIn: LEGAL_OUTCOMES,
    },
  }),
  makeCase({
    id: 'B6',
    category: 'B6 姿态+对称约束',
    title: '陈家祠 张开双翅左右对称的鸟',
    input: '在陈家祠画一只张开双翅、左右对称的鸟',
    expected:
      'plan；地点陈家祠；姿态与对称约束逐项核验或明确降级；无法核验不得绿线',
    shot: 'b6-bird-symmetry',
    expect: {
      actions: ['plan'],
      placeIncludes: ['陈家祠'],
      userConstraintIncludes: '对称',
      expectFreeformChecks: true,

      expectFreeformReason: true,

      expectVerifiedConstraints: true,
      expectDeliveryOutcomeIn: LEGAL_OUTCOMES,
    },
  }),
  makeCase({
    id: 'B7',
    category: 'B7 多部分+结构约束·自行车',
    title: '珠江新城 车身低两个轮子等大的自行车',
    input: '在珠江新城画一辆车身低、两个轮子大小相同的自行车',
    expected:
      'plan；地点珠江新城；多部分 + 结构约束：支持则逐项验收，不支持则明确能力边界（不得笼统失败）',
    shot: 'b7-bicycle-two-wheels',
    expect: {
      actions: ['plan'],
      placeIncludes: ['珠江新城'],
      userConstraintIncludes: '轮',
      expectFreeformReason: true,
      expectDeliveryOutcomeIn: LEGAL_OUTCOMES,
    },
  }),
  makeCase({
    id: 'B8',
    category: 'B8 多个语义特征·鱼',
    title: '白云山 有对称鱼鳍和分叉尾鳍的鱼',
    input: '在白云山画一条有对称鱼鳍和分叉尾鳍的鱼',
    expected:
      'plan；地点白云山；所有显式语义特征均须核验或诚实失败，不得只凭"像条鱼"就绿线',
    shot: 'b8-fish-fins',
    expect: {
      actions: ['plan'],
      placeIncludes: ['白云山'],
      userConstraintIncludes: '鳍',
      expectFreeformChecks: true,

      expectFreeformReason: true,

      expectVerifiedConstraints: true,
      expectDeliveryOutcomeIn: LEGAL_OUTCOMES,
    },
  }),
  makeCase({
    id: 'B9',
    category: 'B9 多部分数量/尺寸/布局约束',
    title: '花城广场 三个等大分离圆排成三角形',
    input: '在花城广场画三个彼此分离、大小相同的圆，排成一个三角形',
    expected:
      'plan；地点花城广场；多部分数量/尺寸/布局约束：不支持时提前说明能力边界，不做无效恢复',
    shot: 'b9-three-circles-triangle',
    expect: {
      actions: ['plan'],
      placeIncludes: ['花城广场'],
      userConstraintIncludes: '三角',
      expectFreeformReason: true,
      expectDeliveryOutcomeIn: LEGAL_OUTCOMES,
    },
  }),
  makeCase({
    id: 'B10',
    category: 'B10 普通对照例（无显式尺寸/朝向）',
    title: '珠江新城 一个正方形',
    input: '在珠江新城画一个正方形',
    expected:
      'plan；地点珠江新城；无显式尺寸/朝向的普通对照例——不得被新约束闸门误伤；与基线比较准确性与交付状态',
    shot: 'b10-square-control',
    expect: {
      actions: ['plan'],
      placeIncludes: ['珠江新城'],
      // 用户说"正方形"，产品用的是内置"矩形"（几何上就是正方形）——两种叫法都接受
      nameIncludes: ['矩形', '正方'],
      outlineSources: ['builtin', 'procedural'],
      // 对照例：合法结果是合格交付/诊断参考/诚实未交付；**不得**是错误交付
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

export const SUITE_TITLE = '准确性优先·全新 10 例（真实 LLM 浏览器 E2E）';
