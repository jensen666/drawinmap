/**
 * DrawInMap 真实浏览器 E2E：20 个「历史从未出现过」的全新复杂例子。
 *
 * 去重口径（2026-11-04）：
 * - 输入原文与仓库内全部历史输入（测试用例、工具内联文本、docs 结果 JSON、web/logs 生产
 *   trace）逐一比对，20 条全部 0 重复（校验脚本与结果见报告 §3.2）；
 * - 图形/地点组合尽量取历史未画过的对象（摩天轮/海马/丹顶鹤/树懒/霸王龙/披萨/龙舟/
 *   热气球/同心圆等），并覆盖参考图、自由轮廓、参数化、引导、覆盖外、推荐、多对象、
 *   显式尺寸、多孔拓扑等不同失败面。
 *
 * 设计意图：这些例子在「复杂剪影自由轮廓 / 参考图召回 / 大尺寸搜索 / 地点解析」上
 * 都故意踩压力点，用真实 LLM + 真实广州路网跑，观察哪些能画出来、哪些只能诚实失败。
 *
 * 运行入口：
 *   node tools/e2e-real-llm-30.mjs --cases-file test/e2e-real-llm-20-new-complex-cases.mjs \
 *     --artifact-dir "docs/测试报告/2026-11-04-真实LLM-E2E-40例/全新复杂例" \
 *     --out result-new.json --turn-timeout 420000
 */

import { makeCase } from '../../test/e2e-case-lib.mjs';

export const CASES = [
  // ============ 一、参考图命中（新地点/新组合，检验召回与尺寸搜索） ============
  makeCase({
    id: 'X01',
    category: 'X1 参考图',
    title: '鲨鱼·花城广场（本地素材，新地点组合）',
    input: '在花城广场画一条鲨鱼',
    expected: 'plan；本地参考图鲨鱼命中；交付非退化；记录交付尺寸与朝向',
    shot: 'shark-huacheng',
    expect: {
      actions: ['plan'],
      placeIncludes: ['花城广场'],
      nameIncludes: ['鲨鱼'],
      outlineSources: ['reference'],
      intentHasSize: true,
      requireDelivery: true,
    },
  }),
  makeCase({
    id: 'X02',
    category: 'X1 参考图',
    title: '孔雀·沙面（本地素材，历史只画过越秀公园）',
    input: '在沙面画一只孔雀',
    expected: 'plan；本地参考图孔雀命中；单候选直走或候选卡点选；交付非退化',
    shot: 'peacock-shamian',
    expect: {
      actions: ['plan'],
      placeIncludes: ['沙面'],
      nameIncludes: ['孔雀'],
      outlineSources: ['reference'],
      intentHasSize: true,
      requireDelivery: true,
    },
  }),
  makeCase({
    id: 'X03',
    category: 'X1 参考图',
    title: '火烈鸟·花城广场（本地素材，全新对象）',
    input: '在花城广场画一只火烈鸟',
    expected: 'plan；本地参考图火烈鸟命中（细长腿/长颈剪影）；交付非退化',
    shot: 'flamingo-huacheng',
    expect: {
      actions: ['plan'],
      placeIncludes: ['花城广场'],
      nameIncludes: ['火烈鸟'],
      outlineSources: ['reference'],
      intentHasSize: true,
      requireDelivery: true,
    },
  }),
  makeCase({
    id: 'X04',
    category: 'X1 参考图',
    title: '螃蟹·珠江新城（本地素材，全新对象）',
    input: '在珠江新城画一只螃蟹',
    expected: 'plan；本地参考图螃蟹命中（多腿多钳剪影）；交付非退化',
    shot: 'crab-zhujiang',
    expect: {
      actions: ['plan'],
      placeIncludes: ['珠江新城'],
      nameIncludes: ['螃蟹'],
      outlineSources: ['reference'],
      intentHasSize: true,
      requireDelivery: true,
    },
  }),

  // ============ 二、自由轮廓（本地/在线都 miss，必须 LLM 生成 + 质检 + 点数门） ============
  makeCase({
    id: 'X05',
    category: 'X2 自由轮廓',
    title: '摩天轮·珠江新城（圆环 + 辐条，单闭环难表达）',
    input: '在珠江新城画一座摩天轮',
    expected: 'plan；本地/在线 miss → 自由轮廓；允许交付/候选卡/诚实失败；不得画成方框冒充',
    shot: 'ferris-wheel',
    expect: {
      actions: ['plan'],
      placeIncludes: ['珠江新城'],
      nameIncludes: ['摩天轮'],
      outlineSources: ['llm', 'reference'],
      allowNoDelivery: true,
    },
  }),
  makeCase({
    id: 'X06',
    category: 'X2 自由轮廓',
    title: '海马·越秀公园（单字「马」别名长词误命中的压力样本）',
    input: '在越秀公园画一只海马',
    expected: 'plan；「海马」不得被单字别名「马」劫持成本地参考马；走自由轮廓或诚实失败',
    shot: 'seahorse',
    expect: {
      actions: ['plan'],
      placeIncludes: ['越秀公园'],
      nameIncludes: ['海马'],
      forbidNameExact: ['马'],
      outlineSources: ['llm', 'reference'],
      allowNoDelivery: true,
    },
  }),
  makeCase({
    id: 'X07',
    category: 'X2 自由轮廓',
    title: '丹顶鹤·白云山（长颈长腿，特征≥3 触发 80 点门）',
    input: '在白云山画一只丹顶鹤',
    expected: 'plan；自由轮廓；复杂剪影需 80~120 点；不达则诚实失败',
    shot: 'red-crowned-crane',
    expect: {
      actions: ['plan'],
      placeIncludes: ['白云山'],
      nameIncludes: ['丹顶鹤', '鹤'],
      outlineSources: ['llm', 'reference'],
      allowNoDelivery: true,
    },
  }),
  makeCase({
    id: 'X08',
    category: 'X2 自由轮廓',
    title: '树懒·广州塔（树懒含单字「树」别名，词边界回归）',
    input: '在广州塔画一只树懒',
    expected: 'plan；「树懒」不得命中本地参考「树/橡树」；走自由轮廓或诚实失败',
    shot: 'sloth',
    expect: {
      actions: ['plan'],
      placeIncludes: ['广州塔'],
      nameIncludes: ['树懒'],
      forbidNameExact: ['树'],
      outlineSources: ['llm', 'reference'],
      allowNoDelivery: true,
    },
  }),
  makeCase({
    id: 'X09',
    category: 'X2 自由轮廓',
    title: '霸王龙·珠江新城（含「龙」，不得画成中国龙）',
    input: '在珠江新城画一只霸王龙',
    expected: 'plan；不得命中本地参考「龙」（词边界回归）；自由轮廓或诚实失败；交付名不得为「龙」',
    shot: 'tyrannosaurus',
    expect: {
      actions: ['plan'],
      placeIncludes: ['珠江新城'],
      nameIncludes: ['霸王龙', '暴龙'],
      forbidNameExact: ['龙'],
      outlineSources: ['llm', 'reference'],
      allowNoDelivery: true,
    },
  }),
  makeCase({
    id: 'X10',
    category: 'X2 自由轮廓',
    title: '龙舟·北京路（含「龙」；细长多桨结构）',
    input: '在北京路画一条龙舟',
    expected: 'plan；不得命中本地参考「龙」；自由轮廓/诚实失败；交付名不得为「龙」',
    shot: 'dragon-boat',
    expect: {
      actions: ['plan'],
      placeIncludes: ['北京路'],
      nameIncludes: ['龙舟'],
      forbidNameExact: ['龙'],
      outlineSources: ['llm', 'reference'],
      allowNoDelivery: true,
    },
  }),
  makeCase({
    id: 'X11',
    category: 'X2 自由轮廓',
    title: '圣诞树·越秀公园（含单字「树」；三角分层结构）',
    input: '在越秀公园画一棵圣诞树',
    expected: 'plan；不得命中本地参考「树/橡树」；自由轮廓/诚实失败；交付名不得为「树」',
    shot: 'christmas-tree',
    expect: {
      actions: ['plan'],
      placeIncludes: ['越秀公园'],
      nameIncludes: ['圣诞树'],
      forbidNameExact: ['树'],
      outlineSources: ['llm', 'reference'],
      allowNoDelivery: true,
    },
  }),
  makeCase({
    id: 'X12',
    category: 'X2 自由轮廓',
    title: '热气球·珠江新城（球体 + 吊篮，上下细连接）',
    input: '在珠江新城画一个热气球',
    expected: 'plan；自由轮廓；允许交付/候选卡/诚实失败；交付非退化',
    shot: 'hot-air-balloon',
    expect: {
      actions: ['plan'],
      placeIncludes: ['珠江新城'],
      nameIncludes: ['热气球'],
      outlineSources: ['llm', 'reference'],
      allowNoDelivery: true,
    },
  }),
  makeCase({
    id: 'X13',
    category: 'X2 自由轮廓',
    title: '同心圆·越秀公园（多环/孔洞，单闭环贴路模型的边界）',
    input: '在越秀公园画一个同心圆',
    expected: 'plan；多环结构在单闭环模型下不可表达；允许参数化圆/诚实失败；不得把双环画成单环还当成功',
    shot: 'concentric-circles',
    expect: {
      actions: ['plan'],
      placeIncludes: ['越秀公园'],
      nameIncludes: ['同心圆', '圆'],
      allowNoDelivery: true,
    },
  }),

  // ============ 三、多对象 / 推荐 / 显式尺寸 / 地点 ============
  makeCase({
    id: 'X14',
    category: 'X3 多对象与推荐',
    title: '猫 + 兔子·花城广场（多对象歧义，参考图通道让位）',
    input: '在花城广场画只猫，旁边再画只兔子',
    expected: 'plan；多对象参考图让位；允许合并目标或诚实失败；不得静默只画一只还说成功',
    shot: 'cat-and-rabbit',
    expect: {
      actions: ['plan'],
      placeIncludes: ['花城广场'],
      nameIncludes: ['猫', '兔子'],
      multiObjectKeywords: ['猫', '兔'],
      outlineSources: ['llm', 'reference'],
      allowNoDelivery: true,
    },
  }),
  makeCase({
    id: 'X15',
    category: 'X3 多对象与推荐',
    title: '半小时·珠江新城实测推荐（新时间表述，时间不参与规划）',
    input: '我只有半个小时，在珠江新城附近能画什么？',
    expected: 'recommend；实测三图形；推荐结果或诚实说明；时间条件按设计不参与规划，记录推荐时长是否超出',
    shot: 'recommend-half-hour',
    expect: {
      actions: ['recommend'],
      placeIncludes: ['珠江新城'],
      requireRecommend: true,
      allowNoDelivery: true,
    },
  }),
  makeCase({
    id: 'X16',
    category: 'X3 多对象与推荐',
    title: '宽 3 公里、高 600 米椭圆·珠江新城（显式长宽比）',
    input: '在珠江新城画一个宽 3 公里、高 600 米的椭圆',
    expected: 'plan；意图必须解析出显式尺寸（至少一个维度）；交付椭圆或诚实失败；记录实际尺寸',
    shot: 'wide-ellipse',
    expect: {
      actions: ['plan'],
      placeIncludes: ['珠江新城'],
      nameIncludes: ['椭圆'],
      intentShapeIncludes: ['椭圆'],
      intentHasSize: true,
      outlineSources: ['builtin', 'procedural', 'llm'],
      allowNoDelivery: true,
    },
  }),
  makeCase({
    id: 'X17',
    category: 'X3 多对象与推荐',
    title: '5 公里五角星·白云山（显式大尺寸 + 稀疏路网）',
    input: '在白云山画个很大的五角星，大概 5 公里',
    expected:
      'plan；口语化尺寸「大概 5 公里」可被解析（钳到产品上限 3000m）或未解析回退 1200m 基准，两者都是当前合法口径（记入显式尺寸观察）；交付非退化，不得悄悄缩到 1/5 还称 5 公里',
    shot: 'five-km-star',
    expect: {
      actions: ['plan'],
      placeIncludes: ['白云山'],
      nameIncludes: ['五角星'],
      intentSizeIn: [1200, 3000],
      outlineSources: ['builtin', 'procedural'],
      allowNoDelivery: true,
    },
  }),
  makeCase({
    id: 'X18',
    category: 'X3 多对象与推荐',
    title: '200 米五角星·珠江新城（显式小尺寸，产品下限 300m）',
    input: '在珠江新城画个 200 米的五角星',
    expected:
      'plan；意图显式尺寸按产品钳制范围 [300,3000] 取 300m（用户 200m 低于下限）；交付非退化或诚实失败；记录实际交付尺寸',
    shot: 'two-hundred-meter-star',
    expect: {
      actions: ['plan'],
      placeIncludes: ['珠江新城'],
      nameIncludes: ['五角星'],
      intentSizeMeters: 300,
      outlineSources: ['builtin', 'procedural'],
      allowNoDelivery: true,
    },
  }),
  makeCase({
    id: 'X19',
    category: 'X3 多对象与推荐',
    title: '二沙岛五角星（地点配置外 → 缺地点追问 → 点选后规划）',
    input: '在二沙岛画个五角星',
    expected: 'plan；二沙岛不在配置 → 追问可点地点（不静默画到视野中心）；点选后正常规划交付',
    shot: 'ersha-island-star',
    guidePick: { index: 0 },
    expect: {
      actions: ['plan'],
      placeIncludes: ['二沙岛', '广州塔'],
      nameIncludes: ['五角星'],
      outlineSources: ['builtin', 'procedural'],
      requireDelivery: true,
    },
  }),
  makeCase({
    id: 'X20',
    category: 'X3 多对象与推荐',
    title: '广州南站心形（地点配置外 → 缺地点追问）',
    input: '在广州南站画个心形',
    expected: 'plan；广州南站不在配置 → 追问；点选后规划；不得静默按视野中心画',
    shot: 'guangzhou-south-station-heart',
    guidePick: { index: 0 },
    expect: {
      actions: ['plan'],
      placeIncludes: ['广州南站', '广州塔'],
      nameIncludes: ['心形'],
      outlineSources: ['builtin', 'procedural'],
      requireDelivery: true,
    },
  }),
];
