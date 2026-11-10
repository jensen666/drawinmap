/**
 * DrawInMap 真实浏览器 E2E：20 个「历史跑不出 / 跑得不好」的复杂例子复测。
 *
 * 选例口径（证据见 docs/测试报告/2026-11-04-真实LLM-E2E-40例/ 报告 §3）：
 * - 全部输入原文均来自仓库历史（E2E 用例库、报告或 web/logs 生产 trace），未改写；
 * - 优先选「真实失败 / 退化交付 / 极慢 / 点数门拒绝 / 拓扑失败」的复杂例；
 * - 单轮文本可闭合（图片入口、多轮 UI 序列、程序化语料不在本套件内）。
 *
 * 相比历史套件，本套件补了两条硬断言（见 test/e2e-case-lib.mjs）：
 * 1. 交付图形必须非退化（sizeMeters>0 且 score>0），堵住历史「橙色 0.0 km 记 PASS」；
 * 2. 交付三态（绿线/橙色参考版/未交付）分开断言，橙色必须明说非合格。
 *
 * 运行入口：
 *   node tools/e2e-real-llm-30.mjs --cases-file test/e2e-real-llm-20-history-cases.mjs \
 *     --artifact-dir "docs/测试报告/2026-11-04-真实LLM-E2E-40例/历史复测" \
 *     --out result-past.json --turn-timeout 420000
 */

import { makeCase } from '../../test/e2e-case-lib.mjs';

export const CASES = [
  // ============ 一、尺寸基准丢失（11-04 刚修，只有离线复现，无浏览器证据） ============
  makeCase({
    id: 'H01',
    category: 'H1 尺寸基准回归',
    title: '长颈鹿·广州塔（生产失败 trace t-0wg0g71b5eu0）',
    input: '在广州塔附近走长颈鹿',
    expected:
      'plan；地点广州塔；参考图/自由轮廓目标；意图必须有正数尺寸基准（agent.sizeFallback 修复点）；交付绿线或非退化橙色；不得再出现 0.0 km 退化参考版',
    shot: 'giraffe-guangzhou-tower',
    expect: {
      actions: ['plan'],
      placeIncludes: ['广州塔'],
      nameIncludes: ['长颈鹿'],
      outlineSources: ['reference', 'llm'],
      intentHasSize: true,
      requireDelivery: true,
    },
  }),
  makeCase({
    id: 'H02',
    category: 'H1 尺寸基准回归',
    title: '海豚·花城广场（同输入历史三态：两次 0 分、一次绿线）',
    input: '在花城广场画一只海豚',
    expected:
      'plan；参考图海豚；意图尺寸基准非空；交付非退化（size>0、score>0）；允许绿线或明说非合格的橙版',
    shot: 'dolphin-huacheng',
    expect: {
      actions: ['plan'],
      placeIncludes: ['花城广场'],
      nameIncludes: ['海豚'],
      outlineSources: ['reference'],
      intentHasSize: true,
      requireDelivery: true,
    },
  }),
  makeCase({
    id: 'H03',
    category: 'H1 尺寸基准回归',
    title: '大象·陈家祠（吸附干净仍 0 分的除零样本）',
    input: '在陈家祠画一头大象',
    expected:
      'plan；参考图大象；交付非退化；参考图 317 点高密度轮廓 + 大象腿间隙特征；失败必须诚实',
    shot: 'elephant-chenjiaci',
    expect: {
      actions: ['plan'],
      placeIncludes: ['陈家祠'],
      nameIncludes: ['大象'],
      outlineSources: ['reference'],
      intentHasSize: true,
      requireDelivery: true,
    },
  }),

  // ============ 二、历史「记 PASS 实为退化/大尺寸」的参考图例 ============
  makeCase({
    id: 'H04',
    category: 'H2 参考图多候选',
    title: '猫·广州塔（2 张本地候选；历史交付 5.4 km / 偏移 7.2 km）',
    input: '在广州塔附近走个猫',
    expected:
      'plan；本地参考图 2 候选 → 点选第一张 → 目标验收通过；交付非退化；尺寸/偏移过大只记录不判失败',
    shot: 'cat-guangzhou-tower',
    expect: {
      actions: ['plan'],
      placeIncludes: ['广州塔'],
      nameIncludes: ['猫'],
      outlineSources: ['reference'],
      requireDelivery: true,
    },
  }),
  makeCase({
    id: 'H05',
    category: 'H2 参考图多候选',
    title: '马·广州塔（3 张本地候选；历史 5.4 km / 50.12 km 路线 / 11 小时）',
    input: '在广州塔附近走个马',
    expected: 'plan；3 张本地候选 → 点选第一张；交付非退化；记录交付尺寸与路线代价',
    shot: 'horse-guangzhou-tower',
    expect: {
      actions: ['plan'],
      placeIncludes: ['广州塔'],
      nameIncludes: ['马'],
      outlineSources: ['reference'],
      requireDelivery: true,
    },
  }),
  makeCase({
    id: 'H06',
    category: 'H2 参考图多候选 + 显式特征',
    title: '马·奔跑（3 张候选；用户显式特征必须记录）',
    input: '在花城广场画一匹马，要奔跑的样子',
    expected: 'plan；意图记录用户特征「奔跑」；点选候选后规划；交付非退化（不得 0.0 km）',
    shot: 'horse-running',
    expect: {
      actions: ['plan'],
      placeIncludes: ['花城广场'],
      nameIncludes: ['马'],
      outlineSources: ['reference'],
      userConstraintIncludes: '奔跑',
      requireDelivery: true,
    },
  }),
  makeCase({
    id: 'H07',
    category: 'H2 参考图多候选 + 显式特征',
    title: '狗·卷毛（历史回归轮 212.5s，最慢之一）',
    input: '在珠江新城画一只狗，毛要卷卷的',
    expected: 'plan；意图记录「卷」特征；多候选点选后规划；交付非退化；记录耗时',
    shot: 'dog-curly',
    expect: {
      actions: ['plan'],
      placeIncludes: ['珠江新城'],
      nameIncludes: ['狗'],
      outlineSources: ['reference'],
      userConstraintIncludes: '卷',
      requireDelivery: true,
    },
  }),
  makeCase({
    id: 'H08',
    category: 'H2 参考图单候选',
    title: '狮子·广州塔（生产日志先 0 分后 79 分）',
    input: '在广州塔画一只狮子',
    expected: 'plan；参考图狮子；单候选直走；交付非退化；允许绿线或明说非合格的橙版',
    shot: 'lion-guangzhou-tower',
    expect: {
      actions: ['plan'],
      placeIncludes: ['广州塔'],
      nameIncludes: ['狮子'],
      outlineSources: ['reference'],
      intentHasSize: true,
      requireDelivery: true,
    },
  }),

  // ============ 三、自由轮廓点数门（4 例全部历史诚实失败） ============
  makeCase({
    id: 'H09',
    category: 'H3 自由轮廓点数门',
    title: '向日葵（历史 58 点 <80，质检 like 仍拒）',
    input: '在珠江新城画一朵向日葵',
    expected:
      'plan；本地/在线 miss → 自由轮廓；点数达 80 可进卡/交付，不达则诚实说明且不绘制；不得静默',
    shot: 'sunflower',
    expect: {
      actions: ['plan'],
      placeIncludes: ['珠江新城'],
      nameIncludes: ['向日葵'],
      outlineSources: ['llm', 'reference'],
      allowNoDelivery: true,
    },
  }),
  makeCase({
    id: 'H10',
    category: 'H3 自由轮廓点数门',
    title: '帆船（历史 25 点，点数门最极端）',
    input: '在花城广场画一艘帆船',
    expected: 'plan；自由轮廓；点数 25~34 历史全拒；本轮达 80 才能交付，否则诚实失败',
    shot: 'sailboat',
    expect: {
      actions: ['plan'],
      placeIncludes: ['花城广场'],
      nameIncludes: ['帆船'],
      outlineSources: ['llm', 'reference'],
      allowNoDelivery: true,
    },
  }),
  makeCase({
    id: 'H11',
    category: 'H3 自由轮廓点数门',
    title: '雪人（历史同输入四态：36 点进卡交付/32/44/48 点被拒）',
    input: '在白云山画一个雪人',
    expected: 'plan；自由轮廓；无论进卡还是诚实失败，行为必须自洽（进卡则选择后规划，失败则说明原因）',
    shot: 'snowman',
    expect: {
      actions: ['plan'],
      placeIncludes: ['白云山'],
      nameIncludes: ['雪人'],
      outlineSources: ['llm', 'reference'],
      allowNoDelivery: true,
    },
  }),
  makeCase({
    id: 'H12',
    category: 'H3 自由轮廓点数门',
    title: '风筝（历史首跑 24 点进卡、复跑 36 点被拒）',
    input: '在越秀公园画一个风筝',
    expected: 'plan；自由轮廓；允许候选卡分支；交付须非退化，未交付须诚实',
    shot: 'kite',
    expect: {
      actions: ['plan'],
      placeIncludes: ['越秀公园'],
      nameIncludes: ['风筝'],
      outlineSources: ['llm', 'reference'],
      allowNoDelivery: true,
    },
  }),
  makeCase({
    id: 'H13',
    category: 'H3 自由轮廓点数门',
    title: '风车（历史 189.3s 极慢 + 质检 unlike 逆修正超时）',
    input: '在花城广场画一座风车',
    expected: 'plan；自由轮廓；四叶结构与五角星易混；记录耗时；交付非退化或诚实失败',
    shot: 'windmill',
    expect: {
      actions: ['plan'],
      placeIncludes: ['花城广场'],
      nameIncludes: ['风车'],
      outlineSources: ['llm', 'reference'],
      allowNoDelivery: true,
      maxDurationMs: 300000,
    },
  }),

  // ============ 四、别名召回 / 拓扑失败 / 主观图形 ============
  makeCase({
    id: 'H14',
    category: 'H4 别名与拓扑',
    title: '龙虾（历史唯一 FAIL：被单字「龙」劫持画成龙）',
    input: '在珠江新城画一只龙虾',
    expected:
      'plan；本地不得命中「龙」（词边界回归）；允许在线补漏/自由轮廓/橙版/固定句；绝不交付参考图「龙」',
    shot: 'lobster',
    expect: {
      actions: ['plan'],
      placeIncludes: ['珠江新城'],
      nameIncludes: ['龙虾'],
      forbidNameExact: ['龙'],
      outlineSources: ['llm', 'reference'],
      allowNoDelivery: true,
    },
  }),
  makeCase({
    id: 'H15',
    category: 'H4 别名与拓扑',
    title: '独角兽（历史点列两轮自交 → planBlocked）',
    input: '在广州塔画一只独角兽',
    expected: 'plan；自由轮廓；允许 planBlocked 具体原因或交付；交付非退化；不得静默',
    shot: 'unicorn',
    expect: {
      actions: ['plan'],
      placeIncludes: ['广州塔'],
      nameIncludes: ['独角兽'],
      outlineSources: ['llm', 'reference'],
      allowNoDelivery: true,
    },
  }),
  makeCase({
    id: 'H16',
    category: 'H4 别名与拓扑',
    title: '中国地图（11-04 生产轮自交 planBlocked；国家级多部分轮廓）',
    input: '在广州画个中国地图',
    expected: 'plan；多部分/自交高发；允许 planBlocked 具体原因或交付；交付非退化；不得静默',
    shot: 'china-map',
    expect: {
      actions: ['plan'],
      placeIncludes: ['广州'],
      nameIncludes: ['中国地图', '中国'],
      outlineSources: ['llm', 'reference'],
      allowNoDelivery: true,
    },
  }),
  makeCase({
    id: 'H17',
    category: 'H4 别名与拓扑',
    title: '蒙娜丽莎（生产：两轮质检 unlike + 54 点 <80 → 没有可用轮廓）',
    input: '在珠江新城附近画个蒙娜丽莎',
    expected:
      'plan（自由轮廓→点数门→诚实失败）或 chat（直接说明无法表达并给替代）；两条合法分支都不许假绿线；记录本轮实际走了哪条',
    shot: 'mona-lisa',
    expect: {
      actions: ['plan', 'chat'],
      allowChat: true,
      placeIncludes: ['珠江新城'],
      nameIncludes: ['蒙娜丽莎'],
      outlineSources: ['llm', 'reference'],
      allowNoDelivery: true,
    },
  }),
  makeCase({
    id: 'H18',
    category: 'H4 别名与拓扑',
    title: '美女（生产：质检 unlike ×2 + 63 点 <80 → 没有可用轮廓）',
    input: '广州画个美女',
    expected: 'plan；开放式主观描述；允许诚实失败；回复必须说明不可用轮廓的原因',
    shot: 'beauty',
    expect: {
      actions: ['plan'],
      placeIncludes: ['广州'],
      nameIncludes: ['美女', '人'],
      outlineSources: ['llm', 'reference'],
      allowNoDelivery: true,
    },
  }),
  makeCase({
    id: 'H19',
    category: 'H4 别名与拓扑',
    title: '奥迪标（生产：四环多孔拓扑不可表达 + 修正输出结构非法）',
    input: '在越秀公园画个奥迪标',
    expected: 'plan；多孔环形在单闭环贴路模型下不可表达；允许诚实失败；不得把四环画成实心块后当合格交付',
    shot: 'audi-logo',
    expect: {
      actions: ['plan'],
      placeIncludes: ['越秀公园'],
      nameIncludes: ['奥迪'],
      outlineSources: ['llm', 'reference'],
      allowNoDelivery: true,
    },
  }),

  // ============ 五、多对象 / 极慢 ============
  makeCase({
    id: 'H20',
    category: 'H5 多对象',
    title: '猫 + 狗（多对象参考图让位；历史 192~228s）',
    input: '在越秀公园画只猫，旁边再画只狗',
    expected:
      'plan；参考图通道因多对象歧义让位；允许合并目标（名称含猫/狗）或诚实失败；不得静默只画一只还说成功',
    shot: 'cat-and-dog',
    expect: {
      actions: ['plan'],
      placeIncludes: ['越秀公园'],
      nameIncludes: ['猫', '狗'],
      multiObjectKeywords: ['猫', '狗'],
      outlineSources: ['llm', 'reference'],
      allowNoDelivery: true,
    },
  }),
];
