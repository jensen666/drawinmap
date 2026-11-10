/**
 * DrawInMap 真实浏览器 E2E：16 个「本次新增、此前从未运行过」的验收例（全新集 B）。
 *
 * 选例口径（方案 2026-11-05 §9.1）：
 * - 每个输入都在**本次任何基线/候选运行之前**生成并冻结；
 * - 历史原文快照（docs/测试报告/2026-11-05-交付正确性验收/history-snapshot-before.json）
 *   于本文件创建**之前**采集，验收时用 --history-file 校验"本次用例不在历史里"；
 * - **不是**换地点/换量词/换同义词规避去重：每例都是历史跑批没覆盖过的**新场景**
 *   （多对象完整性、混合目标、参数化新变体、尺寸与自由轮廓组合、授权扩大范围等）；
 * - 2026-11-04 的 40 例已经运行过，其输入只能归入历史集，不能计入本全新集。
 *
 * 预期与合法分支在跑批前冻结（方案 §9.2）：跑批后不得因结果差而删改本文件。
 *
 * 运行入口：
 *   node tools/e2e-real-llm-30.mjs --cases-file test/e2e-real-llm-16-new-cases.mjs \
 *     --artifact-dir "docs/测试报告/2026-11-05-交付正确性验收/全新集" \
 *     --out result-new.json --turn-timeout 420000
 *
 * 输入溯源校验：
 *   node tools/e2e-input-dedup.mjs --cases-file test/e2e-real-llm-16-new-cases.mjs \
 *     --history-file docs/测试报告/2026-11-05-交付正确性验收/history-snapshot-before.json
 */

import { makeCase } from '../../test/e2e-case-lib.mjs';

export const CASES = [
  // ============ 一、多对象完整性（方案 A 核心场景，历史跑批全部没有） ============
  makeCase({
    id: 'N01',
    category: 'N1 多对象完整性',
    title: '猫+鸵鸟·沙面（鸵鸟不在素材库 → 部分命中必须追问，不得单候选自动规划）',
    input: '在沙面画一只猫和一只鸵鸟',
    expected:
      'plan；地点沙面；参考库命中猫、鸵鸟无素材 → 必须明确列出已命中（猫）与缺失（鸵鸟）并追问；' +
      '严禁只交付猫却宣称完成两个对象；不得承诺未交付的对象',
    shot: 'cat-ostrich-partial',
    expect: {
      actions: ['plan'],
      placeIncludes: ['沙面'],
      replyIncludes: ['猫', '鸵鸟'],
      multiObjectKeywords: ['猫', '鸵鸟'],
    },
  }),
  makeCase({
    id: 'N02',
    category: 'N1 多对象完整性',
    title: '猫+狗+兔·北京路（三对象复合目标，历史只有两对象）',
    input: '在北京路画一只猫、一只狗和一只兔子',
    expected:
      'plan；地点北京路；三个对象都在素材库 → 允许生成 3 部分 multi-part 目标并交付（交付名含「猫+狗+兔」）；' +
      '若复合目标不合法则诚实说明；交付时不得缺任何一个对象',
    shot: 'three-objects',
    expect: {
      actions: ['plan'],
      placeIncludes: ['北京路'],
      multiObjectKeywords: ['猫', '狗', '兔'],
      replyIncludes: ['猫', '狗', '兔'],
    },
  }),
  makeCase({
    id: 'N03',
    category: 'N1 多对象完整性',
    title: '猫头鹰+猫·白云山（嵌套别名：区间归并不得把猫当第二个对象吞掉，也不得反过来）',
    input: '在白云山画一只猫头鹰和一只猫',
    expected:
      'plan；地点白云山；猫头鹰与猫是两个对象 → 允许交付 2 部分复合目标（交付名含「猫头鹰+猫」）；' +
      '按别名长度归并的实现会把猫吞掉，本例专门验证区间归并',
    shot: 'owl-and-cat-nested',
    expect: {
      actions: ['plan'],
      placeIncludes: ['白云山'],
      multiObjectKeywords: ['猫头鹰', '猫'],
      replyIncludes: ['猫头鹰', '猫'],
    },
  }),
  makeCase({
    id: 'N04',
    category: 'N1 多对象完整性',
    title: '小狗+猫·花城广场（别名长度不同：旧的长度归并会丢掉一个对象）',
    input: '在花城广场画一只小狗和一只猫',
    expected:
      'plan；地点花城广场；小狗命中「狗」对象、猫命中「猫」对象 → 允许交付 2 部分复合目标（交付名含「狗+猫」）；' +
      '旧实现按别名长度归并会静默丢掉一个对象',
    shot: 'puppy-and-cat',
    expect: {
      actions: ['plan'],
      placeIncludes: ['花城广场'],
      multiObjectKeywords: ['狗', '猫'],
      replyIncludes: ['狗', '猫'],
    },
  }),
  makeCase({
    id: 'N05',
    category: 'N1 多对象完整性',
    title: '马+狗·珠江新城（多对象 + 显式尺寸 2 公里，历史无此组合）',
    input: '在珠江新城画一匹马和一只狗，尺寸 2 公里',
    expected:
      'plan；地点珠江新城；显式尺寸解析为 2000m；多对象复合目标或诚实说明；不得只交付一个对象',
    shot: 'horse-dog-with-size',
    expect: {
      actions: ['plan'],
      placeIncludes: ['珠江新城'],
      intentSizeMeters: 2000,
      multiObjectKeywords: ['马', '狗'],
      replyIncludes: ['马', '狗'],
    },
  }),
  makeCase({
    id: 'N06',
    category: 'N1 多对象完整性',
    title: '长颈鹿+鸵鸟·陈家祠（部分命中 + 显式尺寸 1.5 公里）',
    input: '在陈家祠画一只长颈鹿和一只鸵鸟，尺寸 1.5 公里',
    expected:
      'plan；地点陈家祠；显式尺寸 1500m；鸵鸟无素材 → 必须列出已命中（长颈鹿）与缺失（鸵鸟）并追问，不得单候选自动规划',
    shot: 'giraffe-ostrich-with-size',
    expect: {
      actions: ['plan'],
      placeIncludes: ['陈家祠'],
      intentSizeMeters: 1500,
      replyIncludes: ['长颈鹿', '鸵鸟'],
      multiObjectKeywords: ['长颈鹿', '鸵鸟'],
    },
  }),
  makeCase({
    id: 'N07',
    category: 'N1 多对象完整性',
    title: '五角星+猫·海珠区（规则图形 + 素材对象混合，历史无混合目标）',
    input: '在海珠区画个五角星和一只猫',
    expected:
      'plan；地点海珠区；五角星是规则图形、猫是素材对象 → 当前不支持混合复合目标时，' +
      '必须诚实列出已命中（猫）与缺失（五角星）并追问，不得只交付其中一个却声称完成两个',
    shot: 'star-and-cat-mixed',
    expect: {
      actions: ['plan'],
      placeIncludes: ['海珠区'],
      replyIncludes: ['五角星', '猫'],
      multiObjectKeywords: ['五角星', '猫'],
    },
  }),

  // ============ 二、规则图形新变体（历史只测过三长三短/钝尖/曲边） ============
  makeCase({
    id: 'N08',
    category: 'N2 规则图形新变体',
    title: '正十边形·珠江新城（顶点数 10 + 边长 + 朝向三要素齐备）',
    input: '在珠江新城画个正十边形，边长 350 米，旋转 15 度',
    expected:
      'plan；地点珠江新城；边长 350m 与朝向 15° 都应被解析（十边形历史上从未跑过）；' +
      '交付非退化或诚实失败',
    shot: 'decagon-350m-15deg',
    expect: {
      actions: ['plan'],
      placeIncludes: ['珠江新城'],
      intentSizeMeters: 350,
      intentRotationDeg: 15,
      nameIncludes: ['十边形'],
    },
  }),
  makeCase({
    id: 'N09',
    category: 'N2 规则图形新变体',
    title: '六角星内半径比·陈家祠（内侧尖角短一半，历史无此参数）',
    input: '在陈家祠画个六角星，内侧的尖角要比外尖角短一半',
    expected:
      'plan；地点陈家祠；六角星内侧尖角应为外尖角的一半（innerRadii≈0.5×outerRadii）；' +
      '参数化生成或诚实失败，不得交付成普通六角星',
    shot: 'hexagram-inner-ratio',
    expect: {
      actions: ['plan'],
      placeIncludes: ['陈家祠'],
      intentShapeIncludes: ['六角星'],
      nameIncludes: ['六角星'],
    },
  }),

  // ============ 三、自由轮廓 + 尺寸/约束（历史自由轮廓都没带尺寸与硬约束） ============
  makeCase({
    id: 'N10',
    category: 'N3 自由轮廓新组合',
    title: '犀牛·越秀公园（自由轮廓 + 显式尺寸 1 公里）',
    input: '在越秀公园画一只犀牛，尺寸 1 公里',
    expected:
      'plan；地点越秀公园；显式尺寸 1000m；素材库有犀牛 → 参考图命中优先；交付非退化或诚实失败',
    shot: 'rhinoceros-1km',
    expect: {
      actions: ['plan'],
      placeIncludes: ['越秀公园'],
      intentSizeMeters: 1000,
      nameIncludes: ['犀牛'],
    },
  }),
  makeCase({
    id: 'N11',
    category: 'N3 自由轮廓新组合',
    title: '天鹅·珠江新城（自由轮廓 + 几何硬约束「脖子要细长」，历史约束都在规则图形上）',
    input: '在珠江新城画只天鹅，脖子要细长一点',
    expected:
      'plan；地点珠江新城；用户显式约束必须进入 userConstraints（几何硬约束，目标验收有否决权）；' +
      '交付非退化或诚实失败，不得丢掉约束',
    shot: 'swan-with-constraint',
    expect: {
      actions: ['plan'],
      placeIncludes: ['珠江新城'],
      nameIncludes: ['天鹅'],
      userConstraintIncludes: '脖子',
    },
  }),

  // ============ 四、尺寸 + 约束 + 朝向四要素齐备 / 大尺寸 + 非规则目标 ============
  makeCase({
    id: 'N12',
    category: 'N4 组合与边界',
    title: '五角星·沙面（尖角钝 + 旋转 30° + 尺寸 600m 四要素齐备）',
    input: '在沙面画个五角星，尖角要钝一点，旋转 30 度，尺寸 600 米',
    expected:
      'plan；地点沙面；尺寸 600m、朝向 30°、尖角钝约束都要被解析；交付非退化或诚实失败',
    shot: 'star-four-factors',
    expect: {
      actions: ['plan'],
      placeIncludes: ['沙面'],
      intentSizeMeters: 600,
      intentRotationDeg: 30,
      nameIncludes: ['五角星'],
    },
  }),
  makeCase({
    id: 'N13',
    category: 'N4 组合与边界',
    title: '孔雀·海珠区（大尺寸 4 公里 + 复杂剪影，历史大尺寸只测过规则五角星）',
    input: '在海珠区画一只孔雀，尺寸 4 公里',
    expected:
      'plan；地点海珠区；显式尺寸 4 公里超产品上限 3000m → 按上限口径解析；交付非退化或诚实失败',
    shot: 'peacock-4km',
    expect: {
      actions: ['plan'],
      placeIncludes: ['海珠区'],
      intentSizeIn: [1200, 3000],
      nameIncludes: ['孔雀'],
    },
  }),
  makeCase({
    id: 'N14',
    category: 'N4 组合与边界',
    title: '中国地图·黄埔区（大尺寸 3 公里 + 多部分目标，历史中国地图都没带尺寸）',
    input: '在黄埔区画个中国地图，尺寸 3 公里',
    expected:
      'plan；地点黄埔区；显式尺寸 3 公里（3000m，上限）；多部分目标（大陆+岛屿）；交付非退化或诚实失败',
    shot: 'china-map-3km',
    expect: {
      actions: ['plan'],
      placeIncludes: ['黄埔区'],
      intentSizeIn: [1200, 3000],
      nameIncludes: ['中国地图', '地图'],
    },
  }),

  // ============ 五、落点授权与地点追问（方案 B 的 authorized 分支 + 全新地点分支） ============
  makeCase({
    id: 'N15',
    category: 'N5 落点与推荐',
    title: '黄埔区推荐（用户明确授权扩大范围 → 落点越界降级为提示而非缺陷）',
    input: '在黄埔区附近能画什么？范围大一点也行',
    expected:
      'recommend；地点黄埔区；实测推荐本区画得出来的图形；用户已明确授权扩大范围，' +
      '因此落点越界只作提示不判缺陷（报告维度 locationStatus=authorized）',
    shot: 'recommend-huangpu-scope',
    expect: {
      requireRecommend: true,
      placeIncludes: ['黄埔区'],
      allowScopeWidening: true,
    },
  }),
  makeCase({
    id: 'N16',
    category: 'N5 落点与推荐',
    title: '狐狸·火星市区（地点完全不存在 → 必须追问，不得在别处乱画）',
    input: '在火星市区画只狐狸',
    expected:
      'plan；地点火星市区无法解析 → 走缺地点追问分支，不规划、不绘制；回复明确询问地点',
    shot: 'fox-unknown-place',
    expect: {
      actions: ['plan'],
      placeIncludes: ['火星'],
      nameIncludes: ['狐狸'],
    },
  }),
];
