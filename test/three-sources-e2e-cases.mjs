/**
 * 三种轮廓同一轮 + 自由轮廓质量：真实链路 E2E 用例定义（20 例不同输入）。
 *
 * 每例都在真实浏览器 + 真实 LLM + 真实广州路网下运行（禁止 mock 模型/路网），
 * 清空 localStorage 后发送输入，按日志终态执行对应断言并保留截图。
 *
 * 用例类型（kind）：
 * - reference-direct：本地唯一参考命中 + 在线/自由轮廓失败 → 直接规划（无候选卡）；
 * - cards-select：本地多候选（同对象多版本）→ 出卡 → 点选后用选中 candidate 规划，
 *   `plan.request.customShape.contentHash` 必须等于被点中的候选；
 * - no-local：库外对象（本地必然 miss）→ 允许两种合法终态：
 *   A 自由轮廓/在线候选进卡（点选前不规划），或 C 三路都没有可用轮廓（回复「没有可用轮廓。」）；
 * - procedural：规则图形参数化（不参与三路）→ 直接规划、无候选卡、日志带 shapeSpec；
 * - recommend：只给条件 → 实测推荐链路（不参与三路）；
 * - guide：缺地点 → 先追问（选项只出现一处）→ 点选项补地点 → 继续三路。
 *
 * 字段：
 * - id/input/kind：用例编号、用户输入、断言类型；
 * - expect：{ assetId?, matchedAlias?, minCards?, pickIndex?, followUp? } 期望值；
 * - note：用例意图说明。
 */

export const THREE_SOURCE_E2E_CASES = [
  {
    id: 'TS01',
    input: '在越秀公园画一只天鹅',
    kind: 'reference-direct',
    expect: { assetId: 'swan', matchedAlias: '天鹅' },
    note: '方案 §5.2 固定输入基线：本地唯一参考命中 → 不弹卡直接规划',
  },
  {
    id: 'TS02',
    input: '在广州塔画一只鸽子',
    kind: 'reference-direct',
    expect: { assetId: 'pigeon-phylopic', matchedAlias: '鸽子' },
    note: '多字别名 + 单版本对象：词边界命中后直接规划',
  },
  {
    id: 'TS03',
    input: '在广州塔画一只狮子',
    kind: 'reference-direct',
    expect: { assetId: 'lion', matchedAlias: '狮子' },
    note: '单版本野生动物参考：三路并行后本地唯一命中直接规划',
  },
  {
    id: 'TS04',
    input: '在越秀公园画一只熊猫',
    kind: 'reference-direct',
    expect: { assetId: 'panda', matchedAlias: '熊猫' },
    note: '单版本对象 + 公园地点：验证地点解析与参考命中链路',
  },
  {
    id: 'TS05',
    input: '在越秀公园画一只兔子',
    kind: 'reference-direct',
    expect: { assetId: 'rabbit', matchedAlias: '兔子' },
    note: '§4 口语全称：兔子是本次新增别名，必须命中 rabbit 并直接规划',
  },
  {
    id: 'TS06',
    input: '在越秀公园画一只老鹰',
    kind: 'reference-direct',
    expect: { assetId: 'eagle', matchedAlias: '老鹰' },
    note: '§4 口语全称：老鹰是本次新增别名；不得被「猫头鹰」等更长词误劫持',
  },
  {
    id: 'TS07',
    input: '在越秀公园画一只鲸鱼',
    kind: 'reference-direct',
    expect: { assetId: 'whale', matchedAlias: '鲸鱼' },
    note: '§4 口语全称：鲸鱼是本次新增别名；不得命中「金鱼」等负面词路径',
  },
  {
    id: 'TS08',
    input: '在越秀公园画一只龙',
    kind: 'reference-direct',
    expect: { assetId: 'dragon', matchedAlias: '龙' },
    note: '单字整词：单字别名占满连续汉字词才命中（上一份方案词边界回归）',
  },
  {
    id: 'TS09',
    input: '在广州塔画一匹马',
    kind: 'cards-select',
    expect: { minCards: 2, pickIndex: 1 },
    note: '本地同对象 3 个版本 → 出卡（点选前引擎 0 次）→ 点第 2 张 → contentHash 贯通',
  },
  {
    id: 'TS10',
    input: '在广州塔画一只狗',
    kind: 'cards-select',
    expect: { minCards: 2, pickIndex: 0 },
    note: '本地 3 个版本 → 出卡 → 点第 1 张 → 规划 T 与选中候选一致',
  },
  {
    id: 'TS11',
    input: '在广州塔画只猫',
    kind: 'cards-select',
    expect: { minCards: 2, pickIndex: 1 },
    note: '本地 2 个版本 → 出卡 → 点第 2 张；验证多候选而非单候选直走',
  },
  {
    id: 'TS12',
    input: '在广州塔画一只风车',
    kind: 'no-local',
    expect: { forbidAssetIds: ['dragon'] },
    note: '库外对象：本地必然 miss；终态只能是「自由轮廓/在线进卡」或「没有可用轮廓」',
  },
  {
    id: 'TS13',
    input: '在广州塔画一只独角兽',
    kind: 'no-local',
    expect: { forbidAssetIds: ['horse-phylopic', 'horse', 'horse-openclipart'] },
    note: '库外对象且提示词含「马」：不得因别名子串误命中马的素材',
  },
  {
    id: 'TS14',
    input: '在广州塔画一只陀螺',
    kind: 'no-local',
    expect: {},
    note: '库外日常物品：本地/在线均无，仅自由轮廓可能通过质检',
  },
  {
    id: 'TS15',
    input: '在珠江新城画一只龙虾',
    kind: 'no-local',
    expect: { forbidAssetIds: ['dragon'] },
    note: '负面词：单字「龙」不得在「龙虾」里命中 dragon（上一份方案词边界回归）',
  },
  {
    id: 'TS16',
    input: '在越秀公园画个六角星',
    kind: 'procedural',
    expect: { shapeFamily: 'star' },
    note: '规则图形参数化：不参与三路、不弹卡，LLM 填 shapeSpec 后程序生成 T',
  },
  {
    id: 'TS17',
    input: '在广州塔画个正八边形',
    kind: 'procedural',
    expect: { shapeFamily: 'polygon' },
    note: '正多边形参数化：验证确定性生成与非三路分支',
  },
  {
    id: 'TS18',
    input: '在珠江新城画个圆',
    kind: 'procedural',
    expect: { shapeFamily: 'circle' },
    note: '圆参数化：验证简单图形不进入自由轮廓质量门',
  },
  {
    id: 'TS19',
    input: '画一只鲸鱼',
    kind: 'guide',
    expect: { followUp: '越秀公园', assetId: 'whale', matchedAlias: '鲸鱼' },
    note: '缺地点 → 引导追问（选项只出现一处）→ 补地点后仍走三路并参考命中',
  },
  {
    id: 'TS20',
    input: '在越秀公园能画什么',
    kind: 'recommend',
    expect: {},
    note: '只给条件：实测推荐链路（对内置图形逐一实测），不参与三路',
  },
];

/** 每种用例类型说明（报告/日志用） */
export const CASE_KIND_LABELS = {
  'reference-direct': '本地唯一参考命中直接规划',
  'cards-select': '本地多候选出卡并点选',
  'no-local': '库外对象（自由轮廓/无可用轮廓）',
  procedural: '规则图形参数化（不参与三路）',
  recommend: '条件实测推荐（不参与三路）',
  guide: '缺地点引导后继续三路',
};
