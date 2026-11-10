/**
 * ShapeSpec 参数化图形生成测试（Node 直接运行，不依赖浏览器/网络）。
 *
 * 覆盖（方案 §11.1 离线确定性测试的生成器部分）：
 * - Schema 校验：缺失字段、数组长度错误、非有限数、非正半径、非法角数、
 *   退化/自交参数组合（inner ≥ outer、尖刺过细、极端 aspect）全部拒绝
 * - 标准规则图形：N 角星 2N 关键顶点、正多边形 N 顶点、圆采样；点序/半径/角度符合 S
 * - 变换不变量：旋转（含 355°）、平移、缩放后角数、排列、比例判定不变
 * - 三长三短变体：六个外尖齐全、三长三短、顺序与 S 一致；不被验收成标准等长星
 * - 任意半径数组：逐尖不等长按数组生成；数组长度不符拒绝
 * - 可复现扰动：相同 S + seed 生成相同 T；不同 seed 产生允许范围内的差异
 * - 确定性：相同规范化 S 生成相同 T（不含 seed 时也逐位一致）
 * - 规格摘要与图形族注册表
 *
 * 运行：node test/shape-spec.mjs
 */

import {
  SHAPE_FAMILIES,
  buildShapeFromSpec,
  checkSpecInvariants,
  describeShapeSpec,
  expandSpecKeyVertices,
  normalizeShapeSpec,
} from '../web/src/agent/shape-spec.js';
import { normalizeCustomShape } from '../web/src/agent/intent.js';

let failures = 0;
let checks = 0;

function check(label, condition, detail = '') {
  checks += 1;
  const ok = Boolean(condition);
  if (!ok) {
    failures += 1;
  }
  console.log(`[check] ${label} -> ${ok ? 'PASS' : `FAIL ${detail}`}`);
}

/** 构建并校验一步到位：返回 {spec, customShape, invariants} */
function buildSpec(raw) {
  const result = normalizeShapeSpec(raw);
  if (!result.ok) {
    return { spec: null, reason: result.reason };
  }
  const built = buildShapeFromSpec(result.spec);
  if (!built.ok) {
    return { spec: result.spec, reason: built.reason };
  }
  return {
    spec: result.spec,
    customShape: built.customShape,
    invariants: checkSpecInvariants(built.customShape, result.spec),
  };
}

// ---------- Schema 校验：非法参数全部拒绝（方案 §5） ----------
{
  const badCases = [
    ['非对象', 'star'],
    ['缺失 family', { pointCount: 5 }],
    ['未知 family', { family: 'hexagram', pointCount: 6, outerRadii: 0.5, innerRadii: 0.28 }],
    ['缺失 pointCount', { family: 'star', outerRadii: 0.5, innerRadii: 0.28 }],
    ['非法角数（过小）', { family: 'star', pointCount: 2, outerRadii: 0.5, innerRadii: 0.28 }],
    ['非法角数（过大）', { family: 'star', pointCount: 13, outerRadii: 0.5, innerRadii: 0.28 }],
    ['非法角数（非整数）', { family: 'star', pointCount: 5.5, outerRadii: 0.5, innerRadii: 0.28 }],
    ['缺失 outerRadii', { family: 'star', pointCount: 5, innerRadii: 0.28 }],
    ['缺失 innerRadii', { family: 'star', pointCount: 5, outerRadii: 0.5 }],
    ['非正半径', { family: 'star', pointCount: 5, outerRadii: 0, innerRadii: 0.28 }],
    ['负半径', { family: 'star', pointCount: 5, outerRadii: -0.5, innerRadii: 0.28 }],
    ['NaN 半径', { family: 'star', pointCount: 5, outerRadii: NaN, innerRadii: 0.28 }],
    ['Infinity 半径', { family: 'star', pointCount: 5, outerRadii: Infinity, innerRadii: 0.28 }],
    ['数组长度不足', { family: 'star', pointCount: 6, outerRadii: [0.5, 0.5, 0.5], innerRadii: 0.28 }],
    ['数组长度过多', { family: 'star', pointCount: 6, outerRadii: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5], innerRadii: 0.28 }],
    ['数组含非法值', { family: 'star', pointCount: 6, outerRadii: [0.5, 0.5, 0.5, 0.5, 0.5, 'x'], innerRadii: 0.28 }],
    ['inner ≥ outer（退化）', { family: 'star', pointCount: 6, outerRadii: 0.5, innerRadii: 0.6 }],
    ['inner = outer（退化）', { family: 'star', pointCount: 6, outerRadii: 0.5, innerRadii: 0.5 }],
    ['尖刺过细（窄刺折叠会吞尖）', { family: 'star', pointCount: 6, outerRadii: 0.5, innerRadii: 0.005 }],
    ['未知字段', { family: 'star', pointCount: 6, outerRadii: 0.5, innerRadii: 0.28, extra: 1 }],
    ['曲边暂不支持', { family: 'star', pointCount: 6, outerRadii: 0.5, innerRadii: 0.28, curvature: 0.3 }],
    ['jitter 缺 seed（不可复现）', { family: 'star', pointCount: 6, outerRadii: 0.5, innerRadii: 0.28, jitter: { amplitude: 0.1 } }],
    ['jitter 超上限', { family: 'star', pointCount: 6, outerRadii: 0.5, innerRadii: 0.28, jitter: { amplitude: 0.5 }, seed: 1 }],
    ['variant 与数据矛盾', { family: 'star', pointCount: 6, outerRadii: 0.5, innerRadii: 0.28, variant: 'alternating-outer-radius' }],
    ['polygon 带 innerRadii', { family: 'polygon', pointCount: 5, innerRadii: 0.2 }],
    ['circle 带 pointCount', { family: 'circle', pointCount: 6 }],
    ['非法 aspect 长度', { family: 'star', pointCount: 6, outerRadii: 0.5, innerRadii: 0.28, aspect: [1] }],
    ['非法 aspect 值', { family: 'star', pointCount: 6, outerRadii: 0.5, innerRadii: 0.28, aspect: [1, 0] }],
    ['非法 userConstraints 来源', { family: 'star', pointCount: 6, outerRadii: 0.5, innerRadii: 0.28, userConstraints: [{ text: 'x', source: 'llm' }] }],
  ];
  for (const [label, raw] of badCases) {
    const result = normalizeShapeSpec(raw);
    check(`Schema 拒绝：${label}`, result.ok === false && typeof result.reason === 'string', JSON.stringify(result));
  }
}

// ---------- 标准规则图形：关键顶点与点序 ----------
{
  const hexagram = buildSpec({ family: 'star', pointCount: 6, outerRadii: 0.5, innerRadii: 0.2887 });
  check('六角星：生成成功', Boolean(hexagram.customShape));
  check('六角星：默认名', hexagram.spec.name === '六角星', hexagram.spec?.name);
  check('六角星：几何不变量通过', hexagram.invariants.ok === true, hexagram.invariants.reasons?.join(';'));
  check('六角星：角点数 2N=12', hexagram.invariants.cornerCount === 12, `corners=${hexagram.invariants?.cornerCount}`);
  // 轮廓点数 ≥ 2N 且拓扑合法（拓扑校验在生成器内部已做，这里断言规格 T 与手绘链路一致）
  check('六角星：轮廓已加密（≥24 点）', hexagram.customShape.outlinePoints.length >= 24, `pts=${hexagram.customShape.outlinePoints.length}`);
  check('六角星：约束点已生成', hexagram.customShape.constraintPoints.length >= 8);
  check('六角星：T 带 spec 与来源标记', hexagram.customShape.source === 'procedural' && hexagram.customShape.spec.family === 'star');

  const pentagon = buildSpec({ family: 'polygon', pointCount: 5 });
  check('正五边形：几何不变量通过', pentagon.invariants.ok === true && pentagon.invariants.cornerCount === 5, JSON.stringify(pentagon.invariants));
  check('正五边形：默认名', pentagon.spec.name === '正五边形', pentagon.spec?.name);

  const circle = buildSpec({ family: 'circle' });
  check('圆：几何不变量通过', circle.invariants.ok === true, circle.invariants.reasons?.join(';'));
  check('圆：默认名', circle.spec.name === '圆形', circle.spec?.name);

  // 3~12 角星全族扫描：全部可生成且通过不变量
  let allPass = true;
  const details = [];
  for (let n = 3; n <= 12; n += 1) {
    const built = buildSpec({ family: 'star', pointCount: n, outerRadii: 0.5, innerRadii: Math.max(0.05 * 0.5, 0.28) });
    if (!built.customShape || built.invariants.ok !== true) {
      allPass = false;
      details.push(`N=${n}:${built.reason || built.invariants?.reasons?.join(';')}`);
    }
  }
  check('3~12 角星全族可生成且过不变量', allPass, details.join(' | '));
}

// ---------- schema 放行 ⇒ 必定可生成（评审 🟠3 回路锁定） ----------
// 下限表按 N 给出（实测窄刺折叠边界 × 1.15 余量）；任何 schema 放行的内凹比例
// 都必须能走完 buildShapeFromSpec——"schema 收、build 拒"的裂缝不允许再出现。
{
  const { MIN_INNER_OUTER_RATIO_BY_POINTS } = await import('../web/src/agent/shape-spec.js');
  let tableOk = true;
  const tableDetails = [];
  for (let n = 3; n <= 12; n += 1) {
    const floor = MIN_INNER_OUTER_RATIO_BY_POINTS[n];
    const built = buildSpec({ family: 'star', pointCount: n, outerRadii: 0.5, innerRadii: 0.5 * floor });
    if (!built.customShape || built.invariants.ok !== true) {
      tableOk = false;
      tableDetails.push(`N=${n} ratio=${floor}:${built.reason || built.invariants?.reasons?.join(';')}`);
    }
    // 表值以下必须被 schema 拒绝
    const below = normalizeShapeSpec({ family: 'star', pointCount: n, outerRadii: 0.5, innerRadii: 0.5 * (floor - 0.005) });
    if (below.ok) {
      tableOk = false;
      tableDetails.push(`N=${n} ratio=${(floor - 0.005).toFixed(3)} 未被拒`);
    }
  }
  check('每角数下限表：表值可生成、表下被拒（回路闭合）', tableOk, tableDetails.join(' | '));
  // 旧统一 0.05 比例在 N=5（下限 0.07）必须被拒——评审 🟠3 的原始失效场景
  const n5at005 = normalizeShapeSpec({ family: 'star', pointCount: 5, outerRadii: 0.5, innerRadii: 0.5 * 0.05 });
  check('N=5 ratio=0.05 被 schema 拒绝（原评审失效场景）', n5at005.ok === false && n5at005.reason.includes('下限'), JSON.stringify(n5at005.reason));
}

// ---------- 三长三短变体（方案 §6.2） ----------
{
  const alt = buildSpec({
    family: 'star',
    variant: 'alternating-outer-radius',
    pointCount: 6,
    outerRadii: [0.5, 0.32, 0.5, 0.32, 0.5, 0.32],
    innerRadii: 0.25,
  });
  check('三长三短：生成且过不变量', alt.invariants.ok === true, alt.reason || alt.invariants.reasons?.join(';'));
  check('三长三短：规格摘要', describeShapeSpec(alt.spec) === '六角星 · 三长三短', describeShapeSpec(alt.spec));
  check('三长三短：角点数 12', alt.invariants.cornerCount === 12);
  // 不被验收成标准等长星：三长三短 T 交给标准规格必须拒绝
  const regularSpec = normalizeShapeSpec({ family: 'star', pointCount: 6, outerRadii: 0.5, innerRadii: 0.25 }).spec;
  const asRegular = checkSpecInvariants(alt.customShape, regularSpec);
  check('三长三短 T 不被验收成等长星', asRegular.ok === false, JSON.stringify(asRegular.reasons));
  // 标准星也不被验收成三长三短
  const asAlt = checkSpecInvariants(
    buildSpec({ family: 'star', pointCount: 6, outerRadii: 0.5, innerRadii: 0.25 }).customShape,
    alt.spec,
  );
  check('等长星不被验收成三长三短', asAlt.ok === false);
}

// ---------- 任意半径数组（逐尖不等长） ----------
{
  const uneven = buildSpec({
    family: 'star',
    variant: 'custom-radii',
    pointCount: 6,
    outerRadii: [0.5, 0.42, 0.36, 0.48, 0.3, 0.44],
    innerRadii: [0.2, 0.24, 0.22, 0.26, 0.2, 0.25],
  });
  check('逐尖不等长：生成且过不变量', uneven.invariants.ok === true, uneven.reason || uneven.invariants.reasons?.join(';'));
  check('逐尖不等长：摘要标注', describeShapeSpec(uneven.spec).includes('各尖不等长'), describeShapeSpec(uneven.spec));
  // variant=custom-radii 但半径全相等 → 拒绝
  const contradiction = normalizeShapeSpec({ family: 'star', pointCount: 6, outerRadii: 0.5, innerRadii: 0.2, variant: 'custom-radii' });
  check('variant 声明与数据矛盾拒绝', contradiction.ok === false);
}

// ---------- 变换不变量（旋转含 355°、平移、缩放，方案 §8.4/§11.1） ----------
{
  const base = buildSpec({ family: 'star', pointCount: 6, outerRadii: 0.5, innerRadii: 0.28 });
  const loop = base.customShape.outlinePoints;
  const transformed = [];
  for (const [rotationDeg, scale, dx, dy] of [[355, 1, 0, 0], [355, 0.8, 0.1, -0.05], [90, 1.2, -0.3, 0.2], [0, 1, 0.25, 0.25]]) {
    const th = (rotationDeg * Math.PI) / 180;
    const cos = Math.cos(th);
    const sin = Math.sin(th);
    const mapped = loop.map(([x, y]) => [(x * cos - y * sin) * scale + dx, (x * sin + y * cos) * scale + dy]);
    const result = checkSpecInvariants({ outlinePoints: mapped }, base.spec);
    check(
      `变换不变量：旋转 ${rotationDeg}° / 缩放 ${scale} / 平移后判定不变`,
      result.ok === true && result.cornerCount === 12,
      result.reasons?.join(';'),
    );
    transformed.push(result.ok);
  }
  check('全部变换组合通过', transformed.every(Boolean));
  // 参数化 T 自带朝向规格时同样通过（spec.rotationDeg 不烘焙进 T，旋转走现有链路）
  const rotatedSpec = buildSpec({ family: 'star', pointCount: 5, outerRadii: 0.5, innerRadii: 0.22, rotationDeg: 355, aspect: [1.3, 1] });
  check('旋转 + aspect 规格：生成且过不变量', rotatedSpec.invariants.ok === true, rotatedSpec.reason || rotatedSpec.invariants.reasons?.join(';'));
  // 评审 🔴2 锁定：spec.rotationDeg 不烘焙进 T——T 只由其余参数决定，朝向由
  // 意图级 rotationDeg 在投影时统一施加（否则会与意图级朝向叠加成双倍旋转）
  const rot0 = buildSpec({ family: 'star', pointCount: 6, outerRadii: 0.5, innerRadii: 0.28, rotationDeg: 0 });
  const rot90 = buildSpec({ family: 'star', pointCount: 6, outerRadii: 0.5, innerRadii: 0.28, rotationDeg: 90 });
  const rot355 = buildSpec({ family: 'star', pointCount: 6, outerRadii: 0.5, innerRadii: 0.28, rotationDeg: 355 });
  check(
    'spec.rotationDeg 不影响 T（rot 0/90/355 逐位一致）',
    JSON.stringify(rot0.customShape.outlinePoints) === JSON.stringify(rot90.customShape.outlinePoints)
      && JSON.stringify(rot0.customShape.outlinePoints) === JSON.stringify(rot355.customShape.outlinePoints),
  );
}

// ---------- 可复现扰动（jitter + seed） ----------
{
  const raw = { family: 'star', pointCount: 6, outerRadii: 0.5, innerRadii: 0.28, jitter: { amplitude: 0.08 }, seed: 7 };
  const first = buildSpec(raw);
  const second = buildSpec(raw);
  check(
    '相同 S + seed 生成相同 T（逐位一致）',
    JSON.stringify(first.customShape.outlinePoints) === JSON.stringify(second.customShape.outlinePoints),
  );
  check('扰动 T 仍过几何不变量', first.invariants.ok === true, first.invariants.reasons?.join(';'));
  const other = buildSpec({ ...raw, seed: 8 });
  check(
    '不同 seed 产生不同 T',
    JSON.stringify(first.customShape.outlinePoints) !== JSON.stringify(other.customShape.outlinePoints),
  );
  check('不同 seed 的 T 仍过各自不变量', other.invariants.ok === true);
  // 扰动在允许范围内：顶点位置偏离 ≤ 振幅的保守上界（半径 ±amplitude + 角向 ±amplitude/4）
  const unitNoJitter = expandSpecKeyVertices(normalizeShapeSpec({ family: 'star', pointCount: 6, outerRadii: 0.5, innerRadii: 0.28 }).spec);
  const unitJitter = expandSpecKeyVertices(first.spec);
  let maxDelta = 0;
  for (let i = 0; i < unitNoJitter.length; i += 1) {
    maxDelta = Math.max(maxDelta, Math.hypot(unitNoJitter[i][0] - unitJitter[i][0], unitNoJitter[i][1] - unitJitter[i][1]));
  }
  check('扰动幅度在允许范围内（≤ 0.2）', maxDelta <= 0.2, `maxDelta=${maxDelta.toFixed(4)}`);
}

// ---------- 确定性（不含 seed 也逐位一致） ----------
{
  const raw = { family: 'star', pointCount: 6, outerRadii: 0.5, innerRadii: 0.2887, aspect: [1.2, 1] };
  const a = buildSpec(raw);
  const b = buildSpec(raw);
  check(
    '相同 S（无随机）生成相同 T',
    JSON.stringify(a.customShape.outlinePoints) === JSON.stringify(b.customShape.outlinePoints),
  );
}

// ---------- 语义闸门：20 点不规则凹多边形冒充六角星（方案 §11.1） ----------
{
  const fake = [];
  for (let i = 0; i < 20; i += 1) {
    const a = (Math.PI * 2 * i) / 20;
    const rad = 0.3 + 0.15 * Math.sin(3 * a) + 0.05 * Math.cos(7 * a + i);
    fake.push([Math.cos(a) * rad, Math.sin(a) * rad]);
  }
  const spec = normalizeShapeSpec({ family: 'star', pointCount: 6, outerRadii: 0.5, innerRadii: 0.28 }).spec;
  const result = checkSpecInvariants({ outlinePoints: fake }, spec);
  check('不规则凹多边形冒充六角星被拒', result.ok === false && result.reasons.length > 0, JSON.stringify(result.reasons));
  // 自交轮廓被拓扑硬门槛拒绝
  const bowtie = [[-0.4, -0.4], [0.4, 0.4], [0.4, -0.4], [-0.4, 0.4]];
  const topologyResult = checkSpecInvariants({ outlinePoints: bowtie }, spec);
  check('自交轮廓被拓扑硬门槛拒绝', topologyResult.ok === false);
}

// ---------- aspect 与生成范围 ----------
{
  const wide = buildSpec({ family: 'star', pointCount: 6, outerRadii: 0.5, innerRadii: 0.28, aspect: [1.5, 1] });
  check('宽扁六角星：生成且过不变量', wide.invariants.ok === true, wide.reason || wide.invariants.reasons?.join(';'));
  check('宽扁摘要', describeShapeSpec(wide.spec).includes('宽扁'), describeShapeSpec(wide.spec));
  const tooFlat = buildSpec({ family: 'star', pointCount: 6, outerRadii: 0.5, innerRadii: 0.28, aspect: [10, 1] });
  check('极端 aspect 被拒绝（短轴跨度不足）', !tooFlat.customShape && typeof tooFlat.reason === 'string', tooFlat.reason);
}

// ---------- 规格摘要与去重 ----------
{
  const alt = normalizeShapeSpec({
    family: 'star',
    variant: 'alternating-outer-radius',
    pointCount: 6,
    outerRadii: [0.5, 0.32, 0.5, 0.32, 0.5, 0.32],
    innerRadii: 0.25,
  }).spec;
  check('摘要：默认名 + 变体描述', describeShapeSpec(alt) === '六角星 · 三长三短', describeShapeSpec(alt));
  check('摘要：名称已含描述时不重复', describeShapeSpec({ ...alt, name: '六角星（三长三短）' }) === '六角星（三长三短）', describeShapeSpec({ ...alt, name: '六角星（三长三短）' }));
  const wide = normalizeShapeSpec({ family: 'star', pointCount: 6, outerRadii: 0.5, innerRadii: 0.28, aspect: [1.5, 1] }).spec;
  check('摘要：宽扁', describeShapeSpec(wide).includes('宽扁'));
  check('摘要：宽扁名称去重', describeShapeSpec({ ...wide, name: '宽扁六角星' }) === '宽扁六角星', describeShapeSpec({ ...wide, name: '宽扁六角星' }));
}

// ---------- 图形族注册表（按族注册，不按名称特判） ----------
{
  check('注册表含 star/polygon/circle', ['star', 'polygon', 'circle'].every((key) => SHAPE_FAMILIES[key]));
  check('star 需要 innerRadii', SHAPE_FAMILIES.star.needsInnerRadii === true);
  check('每个族都注册了 build 与 checkInvariants', Object.values(SHAPE_FAMILIES).every((family) => typeof family.build === 'function' && typeof family.checkInvariants === 'function'));
  const unknown = checkSpecInvariants({ outlinePoints: [] }, { family: 'unknown' });
  check('未知图形族拒绝', unknown.ok === false);
}

// ---------- 参数化 T 与手绘链路兼容（normalizeCustomShape 同构） ----------
{
  const built = buildSpec({ family: 'star', pointCount: 6, outerRadii: 0.5, innerRadii: 0.28 });
  const shape = built.customShape;
  check('T 结构与 customShape 一致（parts 单部分）', Array.isArray(shape.parts) && shape.parts.length === 1);
  check('T 特征由几何检测产出（detected 角色）', (shape.features || []).every((feature) => feature.role === 'detected'));
  check('T 可再次通过 normalizeCustomShape（幂等进链路）', Boolean(normalizeCustomShape({ name: shape.name, points: shape.outlinePoints })));
}

console.log(`\n[summary] ${checks - failures}/${checks} 项通过，失败 ${failures} 项`);
if (failures > 0) {
  process.exitCode = 1;
}
