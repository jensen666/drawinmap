/**
 * 无约束请求优化前后同口径 A/B 冻结用例集（2026-11-08）。
 *
 * 口径文档（先于任何执行冻结）：docs/测试报告/2026-11-08-无约束A-B对照/README.md
 * - C01~C16 主指标组：内置/参数化 6 + 参考图 10（含多对象 3），确定性通道；
 * - W01~W04 波动观察组：自由轮廓，LLM 生成有非确定性，只作线索不计入主判定。
 *
 * 18 例输入原文复用自 2026-11-07 真实 LLM 40 例历史回归的绿线例（预期重复，
 * 给 before 侧 d80864c 提供历史锚点），C03/C05/C06 为本方案冻结的全新例。
 * 断言只用版本无关字段（动作/地点/来源/交付类别），确保 before 侧
 * （无 deliveredObjects / constraintCompliant 字段）不会因驱动读不到新字段假失败。
 *
 * 运行（双侧同一用例文件、同一驱动、420s 上限）：
 *   DRAWINMAP_E2E_URL=http://127.0.0.1:5174/ node tools/e2e-real-llm-30.mjs \
 *     --cases-file test/legacy/e2e-ab-unconstrained-20-cases.mjs \
 *     --artifact-dir "docs/测试报告/2026-11-08-无约束A-B对照/优化前" \
 *     --out result.json --turn-timeout 420000
 */

import { makeCase } from './e2e-case-lib.mjs';

const MAIN = '无约束A-B · 主指标';
const WATCH = '无约束A-B · 波动观察';

export const CASES = [
  // ---- 主指标组：内置 / 参数化（C01~C06） ----
  makeCase({
    id: 'C01',
    category: `${MAIN} · 内置`,
    title: '广州塔附近五角星（无尺寸无朝向）',
    input: '在广州塔附近画个五角星',
    expected: 'plan；无显式约束；应走默认阶梯并绿线交付',
    shot: 'c01-star-guangzhou-tower',
    expect: {
      actions: ['plan'],
      placeIncludes: ['广州塔'],
      nameIncludes: ['五角星'],
      outlineSources: ['builtin', 'procedural'],
      requireDelivery: true,
      expectDeliveryOutcome: 'qualified-delivery',
    },
  }),
  makeCase({
    id: 'C02',
    category: `${MAIN} · 参数化`,
    title: '珠江新城十角星（无尺寸无朝向）',
    input: '在珠江新城画个十角星',
    expected: 'plan；无显式约束；应走默认阶梯并绿线交付',
    shot: 'c02-ten-star-pearl-river',
    expect: {
      actions: ['plan'],
      placeIncludes: ['珠江新城'],
      nameIncludes: ['十角星'],
      outlineSources: ['builtin', 'procedural'],
      requireDelivery: true,
      expectDeliveryOutcome: 'qualified-delivery',
    },
  }),
  makeCase({
    id: 'C03',
    category: `${MAIN} · 参数化`,
    title: '花城广场椭圆（全新冻结例，无任何修饰）',
    input: '在花城广场画个椭圆',
    expected: 'plan；无显式约束；应走默认阶梯并绿线交付',
    shot: 'c03-ellipse-huacheng',
    expect: {
      actions: ['plan'],
      placeIncludes: ['花城广场'],
      nameIncludes: ['椭圆'],
      outlineSources: ['builtin', 'procedural'],
      requireDelivery: true,
      expectDeliveryOutcome: 'qualified-delivery',
    },
  }),
  makeCase({
    id: 'C04',
    category: `${MAIN} · 参数化`,
    title: '白云山正十二边形（无尺寸）',
    input: '在白云山画个正十二边形',
    expected: 'plan；无显式约束；应走默认阶梯并绿线交付',
    shot: 'c04-dodecagon-baiyun',
    expect: {
      actions: ['plan'],
      placeIncludes: ['白云山'],
      nameIncludes: ['十二边形'],
      outlineSources: ['builtin', 'procedural'],
      requireDelivery: true,
      expectDeliveryOutcome: 'qualified-delivery',
    },
  }),
  makeCase({
    id: 'C05',
    category: `${MAIN} · 参数化`,
    title: '越秀公园正六边形（全新冻结例）',
    input: '在越秀公园画个正六边形',
    expected: 'plan；无显式约束；应走默认阶梯并绿线交付',
    shot: 'c05-hexagon-yuexiu',
    expect: {
      actions: ['plan'],
      placeIncludes: ['越秀公园'],
      nameIncludes: ['六边形'],
      outlineSources: ['builtin', 'procedural'],
      requireDelivery: true,
      expectDeliveryOutcome: 'qualified-delivery',
    },
  }),
  makeCase({
    id: 'C06',
    category: `${MAIN} · 内置`,
    title: '沙面岛心形（全新冻结例）',
    input: '在沙面岛画个心形',
    expected: 'plan；无显式约束；应走默认阶梯并绿线交付',
    shot: 'c06-heart-shamian',
    expect: {
      actions: ['plan'],
      placeIncludes: ['沙面岛'],
      nameIncludes: ['心形'],
      outlineSources: ['builtin', 'procedural'],
      requireDelivery: true,
      expectDeliveryOutcome: 'qualified-delivery',
    },
  }),

  // ---- 主指标组：参考图单对象（C07~C13） ----
  makeCase({
    id: 'C07',
    category: `${MAIN} · 参考图`,
    title: '花城广场熊猫（无姿态无尺寸）',
    input: '在花城广场画只熊猫',
    expected: 'plan；无显式约束；参考图命中后应绿线交付',
    shot: 'c07-panda-huacheng',
    expect: {
      actions: ['plan'],
      placeIncludes: ['花城广场'],
      nameIncludes: ['熊猫'],
      outlineSources: ['reference', 'llm'],
      requireDelivery: true,
      expectDeliveryOutcome: 'qualified-delivery',
    },
  }),
  makeCase({
    id: 'C08',
    category: `${MAIN} · 参考图`,
    title: '陈家祠三角龙（无尺寸）',
    input: '在陈家祠画只三角龙',
    expected: 'plan；无显式约束；参考图命中后应绿线交付',
    shot: 'c08-triceratops-chenjiaci',
    expect: {
      actions: ['plan'],
      placeIncludes: ['陈家祠'],
      nameIncludes: ['三角龙'],
      outlineSources: ['reference', 'llm'],
      requireDelivery: true,
      expectDeliveryOutcome: 'qualified-delivery',
    },
  }),
  makeCase({
    id: 'C09',
    category: `${MAIN} · 参考图`,
    title: '广州塔企鹅（无尺寸）',
    input: '在广州塔画一只企鹅',
    expected: 'plan；无显式约束；参考图命中后应绿线交付',
    shot: 'c09-penguin-guangzhou-tower',
    expect: {
      actions: ['plan'],
      placeIncludes: ['广州塔'],
      nameIncludes: ['企鹅'],
      outlineSources: ['reference', 'llm'],
      requireDelivery: true,
      expectDeliveryOutcome: 'qualified-delivery',
    },
  }),
  makeCase({
    id: 'C10',
    category: `${MAIN} · 参考图`,
    title: '广州塔附近长颈鹿（历史原文「走」照录）',
    input: '在广州塔附近走长颈鹿',
    expected: 'plan；无显式约束；参考图命中后应绿线交付',
    shot: 'c10-giraffe-guangzhou-tower',
    expect: {
      actions: ['plan'],
      placeIncludes: ['广州塔'],
      nameIncludes: ['长颈鹿'],
      outlineSources: ['reference', 'llm'],
      requireDelivery: true,
      expectDeliveryOutcome: 'qualified-delivery',
    },
  }),
  makeCase({
    id: 'C11',
    category: `${MAIN} · 参考图`,
    title: '广州塔附近猫（历史原文「走」照录）',
    input: '在广州塔附近走个猫',
    expected: 'plan；无显式约束；参考图命中后应绿线交付',
    shot: 'c11-cat-guangzhou-tower',
    expect: {
      actions: ['plan'],
      placeIncludes: ['广州塔'],
      nameIncludes: ['猫'],
      outlineSources: ['reference', 'llm'],
      requireDelivery: true,
      expectDeliveryOutcome: 'qualified-delivery',
    },
  }),
  makeCase({
    id: 'C12',
    category: `${MAIN} · 参考图`,
    title: '花城广场鲨鱼（无尺寸）',
    input: '在花城广场画一条鲨鱼',
    expected: 'plan；无显式约束；参考图命中后应绿线交付',
    shot: 'c12-shark-huacheng',
    expect: {
      actions: ['plan'],
      placeIncludes: ['花城广场'],
      nameIncludes: ['鲨鱼'],
      outlineSources: ['reference', 'llm'],
      requireDelivery: true,
      expectDeliveryOutcome: 'qualified-delivery',
    },
  }),
  makeCase({
    id: 'C13',
    category: `${MAIN} · 参考图`,
    title: '珠江新城向日葵（无尺寸）',
    input: '在珠江新城画一朵向日葵',
    expected: 'plan；无显式约束；参考图命中后应绿线交付',
    shot: 'c13-sunflower-pearl-river',
    expect: {
      actions: ['plan'],
      placeIncludes: ['珠江新城'],
      nameIncludes: ['向日葵'],
      outlineSources: ['reference', 'llm'],
      requireDelivery: true,
      expectDeliveryOutcome: 'qualified-delivery',
    },
  }),

  // ---- 主指标组：参考图多对象（C14~C16，无空间/数量约束） ----
  makeCase({
    id: 'C14',
    category: `${MAIN} · 参考图·多对象`,
    title: '北京路猫狗兔三对象（无约束）',
    input: '在北京路画一只猫、一只狗和一只兔子',
    expected: 'plan；无显式约束；多对象一对一核对后应绿线交付',
    shot: 'c14-cat-dog-rabbit-beijing-lu',
    expect: {
      actions: ['plan'],
      placeIncludes: ['北京路'],
      outlineSources: ['reference', 'llm'],
      requireDelivery: true,
      expectDeliveryOutcome: 'qualified-delivery',
    },
  }),
  makeCase({
    id: 'C15',
    category: `${MAIN} · 参考图·多对象`,
    title: '越秀公园猫+狗两对象（无约束）',
    input: '在越秀公园画只猫，旁边再画只狗',
    expected: 'plan；无显式约束；多对象一对一核对后应绿线交付',
    shot: 'c15-cat-dog-yuexiu',
    expect: {
      actions: ['plan'],
      placeIncludes: ['越秀公园'],
      outlineSources: ['reference', 'llm'],
      requireDelivery: true,
      expectDeliveryOutcome: 'qualified-delivery',
    },
  }),
  makeCase({
    id: 'C16',
    category: `${MAIN} · 参考图·多对象`,
    title: '白云山猫头鹰+猫两对象（无约束）',
    input: '在白云山画一只猫头鹰和一只猫',
    expected: 'plan；无显式约束；多对象一对一核对后应绿线交付',
    shot: 'c16-owl-cat-baiyun',
    expect: {
      actions: ['plan'],
      placeIncludes: ['白云山'],
      outlineSources: ['reference', 'llm'],
      requireDelivery: true,
      expectDeliveryOutcome: 'qualified-delivery',
    },
  }),

  // ---- 波动观察组：自由轮廓（W01~W04，不计入主判定） ----
  makeCase({
    id: 'W01',
    category: `${WATCH} · 自由轮廓`,
    title: '花城广场风车（无叶片数约束）',
    input: '在花城广场画一座风车',
    expected: 'plan；无显式约束；自由轮廓质检后应可绿线交付',
    shot: 'w01-windmill-huacheng',
    expect: {
      actions: ['plan'],
      placeIncludes: ['花城广场'],
      nameIncludes: ['风车'],
      outlineSources: ['llm', 'reference'],
      requireDelivery: true,
      expectDeliveryOutcome: 'qualified-delivery',
    },
  }),
  makeCase({
    id: 'W02',
    category: `${WATCH} · 自由轮廓`,
    title: '珠江新城龙虾（无尺寸）',
    input: '在珠江新城画一只龙虾',
    expected: 'plan；无显式约束；自由轮廓质检后应可绿线交付',
    shot: 'w02-lobster-pearl-river',
    expect: {
      actions: ['plan'],
      placeIncludes: ['珠江新城'],
      nameIncludes: ['龙虾'],
      outlineSources: ['llm', 'reference'],
      requireDelivery: true,
      expectDeliveryOutcome: 'qualified-delivery',
    },
  }),
  makeCase({
    id: 'W03',
    category: `${WATCH} · 自由轮廓`,
    title: '广州塔独角兽（无尺寸）',
    input: '在广州塔画一只独角兽',
    expected: 'plan；无显式约束；自由轮廓质检后应可绿线交付',
    shot: 'w03-unicorn-guangzhou-tower',
    expect: {
      actions: ['plan'],
      placeIncludes: ['广州塔'],
      nameIncludes: ['独角兽'],
      outlineSources: ['llm', 'reference'],
      requireDelivery: true,
      expectDeliveryOutcome: 'qualified-delivery',
    },
  }),
  makeCase({
    id: 'W04',
    category: `${WATCH} · 自由轮廓`,
    title: '花城广场海马（无尺寸）',
    input: '在花城广场画一只海马',
    expected: 'plan；无显式约束；自由轮廓质检后应可绿线交付',
    shot: 'w04-seahorse-huacheng',
    expect: {
      actions: ['plan'],
      placeIncludes: ['花城广场'],
      nameIncludes: ['海马'],
      outlineSources: ['llm', 'reference'],
      requireDelivery: true,
      expectDeliveryOutcome: 'qualified-delivery',
    },
  }),
];
