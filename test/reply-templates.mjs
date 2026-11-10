/**
 * 回复模板纯函数测试（T-B2a；Node 直接运行，无 DOM、无网络）。
 *
 * 背景（清理方案 2026-11-09 §3.2 B2）：templates.js 内部有四对双份（指标行、
 * 失败回复、参考版回复、切换回复）与 8 份 `const lines = []` 样板。合并后这里把
 * 抽出的 `fidelityTextOf` / `metricsText` / `replyHead` 钉成"固定输入 → 固定输出"，
 * 并给四对合并后的 compose* 各加一条全文断言，防止后续再漂移。
 *
 * 断言口径：
 * - 数字与调用方入参同源（里程两位小数、尺寸一位小数、时长走注入的 formatMinutes）；
 * - 缺项不编造（缺贴合指标 → 整段省略；无关键特征 → 不写"走出"；无开场白/地点说明 → 不写空行）；
 * - 四个合并分支的整段文案逐字固定。
 *
 * 运行：node test/reply-templates.mjs
 */

import { createReplyTemplates } from '../web/src/agent/reply/templates.js';

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

function checkEqual(label, actual, expected) {
  check(label, actual === expected, `\n  实际: ${JSON.stringify(actual)}\n  期望: ${JSON.stringify(expected)}`);
}

/** 与形状引擎同口径的时长格式化（生产实现见 shape-engine.js formatMinutes） */
function formatMinutes(minutes) {
  const total = Math.round(minutes);
  if (total < 60) {
    return `${total} 分钟`;
  }
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
}

const city = {
  examples: ['画个五角星'],
  coverage: { description: '当前城市核心区', hint: '更近' },
  pois: [],
};

const templates = createReplyTemplates({
  engine: { formatMinutes },
  pickPromisedAlternative: () => null,
  recommendShapeKeys: ['star', 'heart', 'rect'],
  getCity: () => city,
});

const metrics = {
  routeMeters: 1234.5,
  walkMinutes: 17.4,
  detourRatio: 1.234,
  coverage: 88.8,
  failedLegs: 0,
  orderedOutlineMeanMeters: 12.6,
  orderedOutlineMaxMeters: 44.4,
  outlineMeanMeters: 20.5,
  snapMaxMeters: 0,
  featureCount: 3,
  featureCoveredCount: 2,
  featureCoverage: 1,
};
const result = { metrics, shapeName: '心形' };

// ---------- fidelityTextOf / metricsText：固定输入 → 固定输出 ----------
{
  checkEqual('fidelityTextOf：有序贴合指标四舍五入', templates.fidelityTextOf(metrics), '贴合 平均 13 m / 最大 44 m');
  checkEqual('fidelityTextOf：缺指标不编造（返回空串）', templates.fidelityTextOf({ routeMeters: 10 }), '');
  checkEqual('fidelityTextOf：metrics 为空也不抛错', templates.fidelityTextOf(null), '');

  checkEqual(
    'metricsText：固定输入逐字',
    templates.metricsText(result),
    '1.23 km · 约 17 分钟 · 贴合 平均 13 m / 最大 44 m · 绕行 1.23× · 覆盖 89% 顶点 · 全程可走',
  );
  checkEqual(
    'metricsText：附加段插在贴合之后',
    templates.metricsText(result, ' · 关键特征 2/3 走出'),
    '1.23 km · 约 17 分钟 · 贴合 平均 13 m / 最大 44 m · 关键特征 2/3 走出 · 绕行 1.23× · 覆盖 89% 顶点 · 全程可走',
  );
  checkEqual(
    'metricsText：缺贴合指标时整段省略（不留 "NaN" 占位）',
    templates.metricsText({ metrics: { ...metrics, orderedOutlineMeanMeters: undefined, orderedOutlineMaxMeters: undefined } }),
    '1.23 km · 约 17 分钟 · 绕行 1.23× · 覆盖 89% 顶点 · 全程可走',
  );
  checkEqual(
    'metricsText：不可达段数如实写',
    templates.metricsText({ metrics: { ...metrics, failedLegs: 2, coverage: 100 } }),
    '1.23 km · 约 17 分钟 · 贴合 平均 13 m / 最大 44 m · 绕行 1.23× · 覆盖全部顶点 · 2 段不可达',
  );
}

// ---------- replyHead：开场白 / 地点说明 / 抑制 ----------
{
  checkEqual('replyHead：开场白 + 地点说明', JSON.stringify(templates.replyHead({ reply: '开场' }, '地点说明')), JSON.stringify(['开场', '地点说明']));
  checkEqual('replyHead：无内容返回空数组', JSON.stringify(templates.replyHead({}, null)), JSON.stringify([]));
  checkEqual('replyHead：suppress 时只留地点说明', JSON.stringify(templates.replyHead({ reply: '开场' }, '地点说明', true)), JSON.stringify(['地点说明']));
}

// ---------- composeReply：指标行与 metricsText 同源 ----------
{
  const reply = templates.composeReply({
    intent: { reply: '开场', shapeKey: 'heart', sizeMeters: 800 },
    result,
    best: { score: 72, sizeMeters: 800, rotationDeg: 30 },
    placeNote: '地点说明',
    offset: null,
    stage: 1,
    alternatives: [],
  });
  const expected = [
    '开场',
    '地点说明',
    '已规划「心形」路线：1.23 km · 约 17 分钟 · 贴合 平均 13 m / 最大 44 m · 关键特征 2/3 走出 · 绕行 1.23× · 覆盖 89% 顶点 · 全程可走（路线贴合 72 · 尺寸 0.8 km · 朝向 30°）',
    '绿色线就是要走的路线，紫色虚线是图形轮廓；想调整位置、大小或换个图形，直接说就行。',
  ].join('\n');
  checkEqual('composeReply：交付回复全文与指标行同源', reply, expected);
}

// ---------- composeRecommendReply：复用 metricsText ----------
{
  const reply = templates.composeRecommendReply({
    intent: {},
    outcome: {
      drawn: { shapeName: '五角星', score: 70, sizeMeters: 800, rotationDeg: 0, result },
      offset: null,
      stage: 1,
      recommendations: [{ shapeName: '五角星', score: 70, result }],
    },
    placeNote: null,
  });
  const expected = [
    '我对这一带实测了五角星/心形/矩形，推荐「五角星」：1.23 km · 约 17 分钟 · 贴合 平均 13 m / 最大 44 m · 绕行 1.23× · 覆盖 89% 顶点 · 全程可走（路线贴合 70 · 尺寸 0.8 km · 朝向 0°）',
    '其他两种图形在这一带实测不达标，没有硬画。想画别的（如圆形）可以直接说。',
    '绿色线就是要走的路线，紫色虚线是图形轮廓；想调整位置、大小或换个图形，直接说就行。',
  ].join('\n');
  checkEqual('composeRecommendReply：推荐回复全文', reply, expected);
}

// ---------- composeReferenceReply / composeDiagnosticReferenceReply：参考版指标句同源 ----------
{
  const candidate = { score: 58, sizeMeters: 800, rotationDeg: 30, result: { ...result, shapeName: '心形' } };
  const reference = templates.composeReferenceReply({
    intent: {},
    placeNote: null,
    candidate,
    reason: '路线贴合 58 低于交付线 60',
  });
  const expectedReference = [
    '这一带画不出达标的「心形」路线：路线贴合 58 低于交付线 60。',
    '给你一版最接近的参考（地图上橙色虚线，非合格）：1.23 km · 约 17 分钟 · 关键特征 2/3 走出 · 路线贴合 58 · 尺寸 0.8 km · 朝向 30°。',
    '这版仅供参考，不建议按它走；换地点（路网方正的商圈）、换尺寸或换个图形可能更好。',
  ].join('\n');
  checkEqual('composeReferenceReply：参考版回复全文', reference, expectedReference);

  const traced = templates.composeReferenceReply({
    intent: { customShape: { source: 'traced' } },
    placeNote: null,
    candidate,
    reason: '路线贴合 58 低于交付线 60',
  });
  check('composeReferenceReply：图像描摹目标写"路网贴不出外轮廓"而非"画不出"', traced.startsWith('这一带的路网贴不出这条外轮廓：'), traced);

  const diagnostic = templates.composeDiagnosticReferenceReply({
    intent: {},
    target: { customShape: { name: '心形' }, acceptance: { reasons: ['整体比例失真'] } },
    placeNote: null,
    candidate,
  });
  const expectedDiagnostic = [
    '先说明：「心形」的目标验收没有通过（整体比例失真），所以下面不是合格路线。',
    '给你一版诊断性参考（地图上橙色虚线，非合格）：1.23 km · 约 17 分钟 · 路线贴合 58 · 尺寸 0.8 km · 朝向 30°。',
    '这版仅供对照当前目标的样子，不建议按它走；调整图形描述重新生成、并通过目标验收后才会有绿色路线。',
  ].join('\n');
  checkEqual('composeDiagnosticReferenceReply：诊断参考版回复全文', diagnostic, expectedDiagnostic);
}

// ---------- composeAlternativeSwitchReply：切换指标句（交付/备选同源） ----------
{
  const alternativeReply = templates.composeAlternativeSwitchReply({
    pending: { intent: { shapeKey: 'heart' }, best: null },
    candidate: { score: 64, center: { lat: 1, lng: 2 }, result: { metrics } },
    direction: 'bigger',
  });
  const expectedAlternative = [
    '已切换到更大的一版「心形」：1.23 km · 约 17 分钟 · 贴合 平均 13 m / 最大 44 m · 路线贴合 64。',
    '绿色线就是要走的路线，想再换尺寸直接说"要大一点/小一点的那版"，或直接说明目标尺寸。',
  ].join('\n');
  checkEqual('composeAlternativeSwitchReply：备选切换回复全文', alternativeReply, expectedAlternative);
}

// ---------- composeFailureReply / composeRecommendFailureReply：失败诊断句同源 ----------
{
  const failure = templates.composeFailureReply({
    intent: { reply: '开场', place: '广州', shapeKey: 'heart' },
    escalation: { stage: 2, triedCount: 120, best: { result: { metrics } }, reason: null },
    placeText: '「广州」这一带',
    placeNote: null,
    placeSource: 'user',
  });
  const expectedFailure = [
    '开场',
    '「广州」这一带画不出像样的「心形」：这一带路网形状与图形差太多，硬画出来会不像。我已尽力尝试（近场 → 扩大范围，位置由近到远 × 多朝向 × 尺寸 0.6~1.7 倍多档，共 120 个候选），最接近的候选平均偏差仍有 21 m（不像），所以没有画——画出来也不会像。',
    '建议：换个地点（路网方正的商圈更容易）、换个图形（矩形/五角星更贴合街道）、或直接指定更大的尺寸（如"画个 2 公里的心形"）。',
  ].join('\n');
  checkEqual('composeFailureReply：失败回复全文（诊断句与推荐失败同源）', failure, expectedFailure);

  const outside = templates.composeFailureReply({
    intent: { place: null },
    escalation: { reason: 'outside-coverage', stage: 0, triedCount: 0, best: null },
    placeText: '当前视野这一带',
    placeNote: null,
    placeSource: 'user',
  });
  checkEqual(
    'composeFailureReply：超出路网覆盖的固定口径',
    outside,
    '当前地图位置超出了我的路网数据范围（目前只覆盖当前城市核心区），那里我确实无路可规划。换更近的地点就行。',
  );

  const recommendFailure = templates.composeRecommendFailureReply({
    intent: { reply: '开场' },
    outcome: { stage: 1, triedCount: 60, bests: { star: { score: 50, result: { metrics } } }, reason: null },
    placeText: '当前视野这一带',
    placeNote: null,
    placeSource: 'user',
  });
  const expectedRecommendFailure = [
    '开场',
    '当前视野这一带实测下来，五角星/心形/矩形都画不出像样的：这一带路网形状与图形差太多，硬画出来会不像。我已尽力尝试（近场，位置由近到远 × 多朝向 × 尺寸 0.75~1.5 倍多档，共 60 个候选（三种图形合计）），最接近的候选平均偏差仍有 21 m（不像），所以没有画——画出来也不会像。',
    '建议：换个地点（路网方正的商圈更容易），或直接指定更大的尺寸（如"画个 2 公里的五角星"）。',
  ].join('\n');
  checkEqual('composeRecommendFailureReply：推荐失败回复全文', recommendFailure, expectedRecommendFailure);
}

// ---------- composeTargetFailureReply：目标验收失败口径 ----------
{
  const reply = templates.composeTargetFailureReply({
    intent: { reply: '开场', shapeKey: 'heart' },
    target: { customShape: null, acceptance: { reasons: ['不符合目标'] } },
    placeText: '这一带',
    placeNote: null,
  });
  const expected = [
    '开场',
    '「心形」的目标验收没有通过（不符合目标），所以不能开始正式规划——画出来也不是您要的图形。这次没有画。',
    '想调整图形细节（如尖角长短、比例）或换个说法再试一次。',
  ].join('\n');
  checkEqual('composeTargetFailureReply：目标验收失败回复全文', reply, expected);
}

console.log(`\nRESULT: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}  (${checks - failures} passed, ${failures} failed)`);
process.exitCode = failures === 0 ? 0 : 2;
