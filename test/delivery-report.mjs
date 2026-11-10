/**
 * 交付结果分维度评定（方案 2026-11-05 §5.1）单元测试。
 *
 * 运行：node test/delivery-report.mjs
 */

import {
  DEFAULT_LOCATION_LIMIT_METERS,
  DEFAULT_ROUTE_COST_LIMITS,
  DELIVERY_OUTCOMES,
  classifyDeliveryOutcome,
  detectScopeWidening,
  evaluateDeliveryReport,
  evaluateLocation,
  evaluateRouteCost,
  summarizeDeliveryReports,
} from '../tools/lib/delivery-report.js';

let failures = 0;
let checks = 0;
function check(label, condition, detail = '') {
  checks += 1;
  if (!condition) {
    failures += 1;
  }
  console.log(`[check] ${label} -> ${condition ? 'PASS' : `FAIL ${detail}`}`);
}

// ---------- 落点维度 ----------
check('落点：偏移在限内 → ok', evaluateLocation({ offsetMeters: 500 }).status === 'ok');
check(
  `落点：偏移超 ${DEFAULT_LOCATION_LIMIT_METERS} m → over`,
  evaluateLocation({ offsetMeters: 6100 }).status === 'over',
);
check('落点：无数据 → unknown', evaluateLocation({ offsetMeters: null }).status === 'unknown');
check(
  '落点：用户授权后超限 → authorized（记录事实，不算缺陷）',
  evaluateLocation({ offsetMeters: 6100, authorized: true }).status === 'authorized',
);

// ---------- 成本维度 ----------
check(
  '成本：各指标在限内 → ok',
  evaluateRouteCost({ sizeMeters: 1800, routeMeters: 12000, walkMinutes: 120 }).status === 'ok',
);
check(
  '成本：路线超限 → over',
  evaluateRouteCost({ routeMeters: 30500 }).status === 'over',
);
check(
  '成本：步行超限 → over',
  evaluateRouteCost({ walkMinutes: 406 }).status === 'over',
);
check('成本：无数据 → unknown', evaluateRouteCost({}).status === 'unknown');
check(
  '成本：授权后超限 → authorized',
  evaluateRouteCost({ routeMeters: 30500, authorized: true }).status === 'authorized',
);
check(
  '成本：默认不判尺寸（观察口径不是交付硬门）',
  DEFAULT_ROUTE_COST_LIMITS.sizeMeters === null &&
    evaluateRouteCost({ sizeMeters: 5400 }).status === 'ok',
);
check(
  '成本：超限明细列出具体指标',
  evaluateRouteCost({ routeMeters: 30500, walkMinutes: 406 }).over.length === 2,
);

// ---------- 授权检测 ----------
check('授权：识别「范围大一点」', detectScopeWidening('范围大一点画匹马'));
check('授权：识别「在哪都行」', detectScopeWidening('在哪都行，画个心形'));
check('授权：普通请求不算授权', !detectScopeWidening('在广州塔画匹马'));
check('授权：空文本不算授权', !detectScopeWidening(''));

// ---------- 总体评定 ----------
{
  const good = evaluateDeliveryReport({
    contractPass: true,
    targetPass: true,
    offsetMeters: 300,
    sizeMeters: 1800,
    routeMeters: 12000,
    walkMinutes: 120,
    delivered: true,
  });
  check('总体：全绿 → overallPass', good.overallPass === true, JSON.stringify(good));

  const far = evaluateDeliveryReport({
    contractPass: true,
    targetPass: true,
    offsetMeters: 6100,
    sizeMeters: 5400,
    routeMeters: 30500,
    walkMinutes: 406,
    delivered: true,
  });
  check(
    '总体：地图绿但偏移/成本越界 → overallPass=false',
    far.overallPass === false && far.locationStatus === 'over' && far.routeCostStatus === 'over',
    JSON.stringify(far),
  );
  check('总体：契约维度独立保留', far.contractPass === true && far.targetPass === true);

  const contractFail = evaluateDeliveryReport({
    contractPass: false,
    targetPass: true,
    offsetMeters: 0,
    delivered: true,
  });
  check('总体：契约不过 → overallPass=false', contractFail.overallPass === false);

  const targetFail = evaluateDeliveryReport({
    contractPass: true,
    targetPass: false,
    offsetMeters: 0,
    delivered: true,
  });
  check('总体：目标不完整 → overallPass=false', targetFail.overallPass === false);

  const authorized = evaluateDeliveryReport({
    contractPass: true,
    targetPass: true,
    offsetMeters: 6100,
    routeMeters: 30500,
    walkMinutes: 406,
    scopeWidened: true,
    delivered: true,
  });
  check(
    '总体：用户授权后越界降级为提示',
    authorized.locationStatus === 'authorized' && authorized.routeCostStatus === 'authorized' && authorized.overallPass === true,
    JSON.stringify(authorized),
  );
  check('总体：授权情形仍记录事实', authorized.details.offsetMeters === 6100 && authorized.details.routeMeters === 30500);

  const honestFailure = evaluateDeliveryReport({
    contractPass: true,
    targetPass: true,
    offsetMeters: null,
    delivered: false,
  });
  check(
    '总体：诚实失败（无交付）→ 落点/成本 unknown，不因缺数据判失败',
    honestFailure.locationStatus === 'unknown' && honestFailure.routeCostStatus === 'unknown' && honestFailure.overallPass === true,
    JSON.stringify(honestFailure),
  );
}

// ---------- 汇总 ----------
{
  const reports = [
    evaluateDeliveryReport({ contractPass: true, targetPass: true, offsetMeters: 300, routeMeters: 12000, walkMinutes: 120, delivered: true }),
    evaluateDeliveryReport({ contractPass: true, targetPass: true, offsetMeters: 6100, routeMeters: 30500, walkMinutes: 406, delivered: true }),
    evaluateDeliveryReport({ contractPass: false, targetPass: false, delivered: false }),
  ];
  const summary = summarizeDeliveryReports(reports);
  check('汇总：总数', summary.total === 3);
  check('汇总：契约通过数', summary.contractPass === 2);
  check('汇总：目标通过数', summary.targetPass === 2);
  check('汇总：落点越界数', summary.locationOver === 1);
  check('汇总：成本越界数', summary.routeCostOver === 1);
  check('汇总：整体通过数', summary.overallPass === 1);
  check('汇总：标红清单只列越界例', summary.flagged.length === 1 && summary.flagged[0].offsetMeters === 6100);
}

// ---------- 交付结果类别（方案 2026-11-08 §6.3） ----------
{
  const qualified = classifyDeliveryOutcome({ delivered: true });
  check('类别：绿线且全部通过 → qualified-delivery', qualified.outcome === DELIVERY_OUTCOMES.QUALIFIED, JSON.stringify(qualified));

  const authorized = classifyDeliveryOutcome({ delivered: true, authorized: true });
  check('类别：用户已授权越界 → authorized-compromise', authorized.outcome === DELIVERY_OUTCOMES.AUTHORIZED_COMPROMISE, JSON.stringify(authorized));

  const reference = classifyDeliveryOutcome({ delivered: true, reference: true });
  check('类别：橙色参考版 → diagnostic-reference', reference.outcome === DELIVERY_OUTCOMES.DIAGNOSTIC_REFERENCE, JSON.stringify(reference));

  const honest = classifyDeliveryOutcome({ delivered: false, honestFailure: true });
  check('类别：未交付且如实说明 → honest-no-delivery', honest.outcome === DELIVERY_OUTCOMES.HONEST_NO_DELIVERY, JSON.stringify(honest));

  const wrongObject = classifyDeliveryOutcome({ delivered: true, targetPass: false });
  check('类别：交付了但对象不一致 → incorrect-delivery', wrongObject.outcome === DELIVERY_OUTCOMES.INCORRECT_DELIVERY, JSON.stringify(wrongObject));

  const wrongConstraint = classifyDeliveryOutcome({ delivered: true, constraintCompliant: false });
  check('类别：交付了但约束未满足 → incorrect-delivery', wrongConstraint.outcome === DELIVERY_OUTCOMES.INCORRECT_DELIVERY, JSON.stringify(wrongConstraint));

  const notCovered = classifyDeliveryOutcome({ covered: false });
  check('类别：分支未覆盖 → not-covered', notCovered.outcome === DELIVERY_OUTCOMES.NOT_COVERED, JSON.stringify(notCovered));

  // 报告里带上类别字段（不改写 overallPass 的历史口径）
  const report = evaluateDeliveryReport({ contractPass: true, targetPass: true, delivered: true, reference: false });
  check('报告：带 deliveryOutcome 字段', report.deliveryOutcome === DELIVERY_OUTCOMES.QUALIFIED, JSON.stringify(report.deliveryOutcome));

  const summary = summarizeDeliveryReports([
    evaluateDeliveryReport({ contractPass: true, targetPass: true, delivered: true }),
    evaluateDeliveryReport({ contractPass: true, targetPass: true, delivered: true, reference: true }),
    evaluateDeliveryReport({ contractPass: true, targetPass: true, delivered: false }),
    evaluateDeliveryReport({ contractPass: false, targetPass: false, delivered: false }),
  ]);
  check(
    '汇总：交付结果类别分布',
    summary.qualifiedDelivery === 1 &&
      summary.diagnosticReference === 1 &&
      summary.honestNoDelivery === 1 &&
      summary.notCovered === 1,
    JSON.stringify(summary.outcomeCounts),
  );
  check(
    '汇总：六类计数齐备',
    Object.keys(summary.outcomeCounts).length === 6 &&
      summary.incorrectDelivery === 0 &&
      summary.authorizedCompromise === 0,
    JSON.stringify(summary.outcomeCounts),
  );
}

if (failures > 0) {
  console.error(`\nFAILED: ${failures}/${checks} 项未通过`);
  process.exitCode = 1;
} else {
  console.log(`\nPASS: delivery-report 全部断言通过（${checks} 项）`);
}
