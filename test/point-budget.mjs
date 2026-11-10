/**
 * 自由轮廓点数口径一致性（方案 2026-11-05 §7.2）单元测试。
 *
 * 此前生成提示写「每部分最多 240 点」、验收按「每部分 120 点」执行——
 * 两处口径可直接核对且互相矛盾。本测试锁定"提示 / 修正提示 / 验收"三处同源：
 * 提示里出现的数字必须来自 point-budget.js，且不得再出现 240。
 *
 * 运行：node test/point-budget.mjs
 */

import {
  FREEFORM_COMPLEX_FEATURE_MIN,
  FREEFORM_COMPLEX_POINT_MAX,
  FREEFORM_COMPLEX_POINT_MIN,
  FREEFORM_COMPLEX_POINT_RELAXED_MIN,
  FREEFORM_SIMPLE_POINT_MAX,
  FREEFORM_SIMPLE_POINT_MIN,
  freeformPointMax,
  freeformPointRuleText,
} from '../web/src/agent/point-budget.js';
import {
  acceptFreeformTarget,
  FREEFORM_COMPLEX_FEATURE_MIN as ACCEPT_FEATURE_MIN,
  FREEFORM_COMPLEX_POINT_MAX as ACCEPT_POINT_MAX,
  FREEFORM_COMPLEX_POINT_MIN as ACCEPT_POINT_MIN,
  FREEFORM_COMPLEX_POINT_RELAXED_MIN as ACCEPT_POINT_RELAXED_MIN,
} from '../web/src/agent/target-acceptance.js';
import { buildSystemPrompt } from '../web/src/agent/prompt.js';
import { reviseMessages } from '../web/src/agent/shape-review.js';
import { placeConfig } from './fixtures/place-config.mjs';

let failures = 0;
let checks = 0;
function check(label, condition, detail = '') {
  checks += 1;
  if (!condition) {
    failures += 1;
  }
  console.log(`[check] ${label} -> ${condition ? 'PASS' : `FAIL ${detail}`}`);
}

// ---------- 常量同源 ----------
check(
  '验收模块重新导出的常量与 point-budget 一致',
  ACCEPT_FEATURE_MIN === FREEFORM_COMPLEX_FEATURE_MIN &&
    ACCEPT_POINT_MIN === FREEFORM_COMPLEX_POINT_MIN &&
    ACCEPT_POINT_MAX === FREEFORM_COMPLEX_POINT_MAX,
  `${ACCEPT_FEATURE_MIN}/${ACCEPT_POINT_MIN}/${ACCEPT_POINT_MAX}`,
);
check('每部分上限 = 120（不是 240）', FREEFORM_COMPLEX_POINT_MAX === 120, String(FREEFORM_COMPLEX_POINT_MAX));
check('点数下限 = 80', FREEFORM_COMPLEX_POINT_MIN === 80, String(FREEFORM_COMPLEX_POINT_MIN));
check('复杂判定门槛 = 3', FREEFORM_COMPLEX_FEATURE_MIN === 3, String(FREEFORM_COMPLEX_FEATURE_MIN));
check(
  '多部分上限按部分数放宽',
  freeformPointMax(1) === 120 && freeformPointMax(2) === 240 && freeformPointMax(3) === 360,
  `${freeformPointMax(1)}/${freeformPointMax(2)}/${freeformPointMax(3)}`,
);
check('部分数缺省按 1 算', freeformPointMax() === 120 && freeformPointMax(0) === 120);

// ---------- 提示文本 ----------
const ruleText = freeformPointRuleText();
check(
  '规则文本包含复杂剪影区间与每部分上限',
  ruleText.includes(`${FREEFORM_COMPLEX_POINT_MIN}~${FREEFORM_COMPLEX_POINT_MAX}`) &&
    ruleText.includes(`每部分最多 ${FREEFORM_COMPLEX_POINT_MAX} 点`),
  ruleText,
);
check(
  '规则文本包含简单图形区间',
  ruleText.includes(`${FREEFORM_SIMPLE_POINT_MIN}~${FREEFORM_SIMPLE_POINT_MAX}`),
  ruleText,
);

const systemPrompt = buildSystemPrompt(placeConfig);
check('生成提示含规则文本', systemPrompt.includes(ruleText), ruleText);
check('生成提示不含 240 点上限', !systemPrompt.includes('每部分最多 240 点'));

const reviseText = reviseMessages({
  userText: '在广州画个小狗',
  shapeName: '小狗',
  feedback: ['四条腿呈方波'],
})
  .map((message) => (typeof message.content === 'string' ? message.content : ''))
  .join('\n');
check('修正提示含规则文本', reviseText.includes(ruleText), ruleText);
check('修正提示不含 240 点上限', !reviseText.includes('每部分最多 240 点'));

// ---------- 验收闸门与提示一致 ----------
{
  const declaredFeatures = [
    { kind: 'declared', name: 'a', indices: [0] },
    { kind: 'declared', name: 'b', indices: [1] },
    { kind: 'declared', name: 'c', indices: [2] },
  ];
  const makeShape = (pointCount) => ({
    outlinePoints: Array.from({ length: pointCount }, (_, index) => [
      Math.cos((index / pointCount) * Math.PI * 2) * 0.4,
      Math.sin((index / pointCount) * Math.PI * 2) * 0.4,
    ]),
    parts: [{ name: 'x', outlineStart: 0, outlineCount: pointCount, constraintStart: 0, constraintCount: 0 }],
    features: declaredFeatures,
  });
  const review = { available: true, verdict: 'like', issues: [], constraintSummary: { ok: true, unavailable: false, failed: [] } };

  // 缺陷清单 2026-11-06 Bug 4.2：79 点 + 质检 like → 分级放行 pass；
  // 硬下限是 FREEFORM_COMPLEX_POINT_RELAXED_MIN（60），59 点即使质检 like 也 fail
  const relaxed = acceptFreeformTarget(makeShape(FREEFORM_COMPLEX_POINT_MIN - 1), review);
  check(
    '验收：79 点 + 质检 like → 分级放行 pass（pointGate=tiered）',
    relaxed.verdict === 'pass' && relaxed.checks.pointGate === 'tiered',
    JSON.stringify(relaxed.reasons),
  );
  const below = acceptFreeformTarget(makeShape(FREEFORM_COMPLEX_POINT_RELAXED_MIN - 1), review);
  check(
    '验收：低于分级放行硬下限（59 点）→ fail',
    below.verdict === 'fail' && below.reasons.some((reason) => reason.includes(String(FREEFORM_COMPLEX_POINT_RELAXED_MIN - 1))),
    JSON.stringify(below.reasons),
  );

  const atLimit = acceptFreeformTarget(makeShape(FREEFORM_COMPLEX_POINT_MAX), review);
  check('验收：正好到每部分上限 → pass', atLimit.verdict === 'pass', JSON.stringify(atLimit.reasons));

  const above = acceptFreeformTarget(makeShape(FREEFORM_COMPLEX_POINT_MAX + 1), review);
  check(
    '验收：超上限 → fail（提示已要求不超过上限，不会再出现这种产出）',
    above.verdict === 'fail',
    JSON.stringify(above.reasons),
  );
  check(
    '验收：上限口径来自共享常量（每部分 120）',
    atLimit.checks.pointMax === FREEFORM_COMPLEX_POINT_MAX,
    `pointMax=${atLimit.checks.pointMax}`,
  );
}

if (failures > 0) {
  console.error(`\nFAILED: ${failures}/${checks} 项未通过`);
  process.exitCode = 1;
} else {
  console.log(`\nPASS: point-budget 全部断言通过（${checks} 项）`);
}
