/**
 * 无约束请求同口径 A/B 对照（2026-11-08）。
 *
 * 读优化前/后两侧的 result.json（同一冻结用例集 test/legacy/e2e-ab-unconstrained-20-cases.mjs），
 * 按口径文档 §4 计算三主指标（合格交付率、最低图形分、平均图形分，分母 = 主指标组 C01~C16）
 * 并输出逐例对照表与判定。波动组（W*）只列对照不进判定。
 *
 * 运行：
 *   node tools/e2e-ab-unconstrained-compare.mjs \
 *     --before "docs/测试报告/2026-11-08-无约束A-B对照/优化前/result.json" \
 *     --after  "docs/测试报告/2026-11-08-无约束A-B对照/优化后/result.json"
 *
 * 判定（冻结，跑完不得改）：after 三项主指标均 ≥ before 即通过；任一项下降 = 不通过。
 */

import { readFileSync } from 'node:fs';
import { argv } from 'node:process';

const argOf = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const BEFORE_PATH = argOf('before');
const AFTER_PATH = argOf('after');
if (!BEFORE_PATH || !AFTER_PATH) {
  console.error('用法：node tools/e2e-ab-unconstrained-compare.mjs --before <result.json> --after <result.json>');
  process.exit(2);
}

const OUTCOME_SHORT = {
  'qualified-delivery': '绿线',
  'diagnostic-reference': '橙色',
  'honest-no-delivery': '未交付',
  'error-timeout': '超时',
};

function load(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const byId = new Map();
  for (const c of raw.cases ?? []) {
    const a = c.actual ?? {};
    const delivered = a.deliveryOutcome === 'qualified-delivery';
    byId.set(c.id, {
      id: c.id,
      input: c.input ?? '',
      category: c.category ?? '',
      status: c.status ?? '-',
      checks: c.checks ? `${c.checks.filter((x) => x.ok).length}/${c.checks.length}` : '-',
      outcome: a.deliveryOutcome ?? 'no-record',
      score: delivered && a.shape && Number.isFinite(a.shape.score) ? a.shape.score : null,
      size: a.finalSizeMeters ?? null,
      stage: a.sourceStageLabel ?? null,
      durationMs: a.durationMs ?? c.durationMs ?? null,
    });
  }
  return byId;
}

const before = load(BEFORE_PATH);
const after = load(AFTER_PATH);
const ids = [...new Set([...before.keys(), ...after.keys()])];
const isMain = (row) => row && /主指标/.test(row.category);
const mainIds = ids.filter((id) => isMain(before.get(id)) || isMain(after.get(id)));
const watchIds = ids.filter((id) => !mainIds.includes(id));

function metrics(rows) {
  const delivered = rows.filter((r) => r.outcome === 'qualified-delivery');
  const scores = delivered.map((r) => r.score).filter((s) => s != null);
  return {
    total: rows.length,
    rate: rows.length ? delivered.length / rows.length : 0,
    delivered: delivered.length,
    min: scores.length ? Math.min(...scores) : null,
    avg: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
  };
}

const mBefore = metrics(mainIds.map((id) => before.get(id)).filter(isMain));
const mAfter = metrics(mainIds.map((id) => after.get(id)).filter(isMain));

console.log(`=== 逐例对照（同一冻结输入 ${ids.length} 例）===`);
console.log('ID | 输入 | before 结果/分/尺寸 | after 结果/分/尺寸 | 分差 | 断言(前/后) | 耗时(前→后)');
for (const id of ids) {
  const b = before.get(id);
  const a = after.get(id);
  const fmt = (r) => r
    ? `${OUTCOME_SHORT[r.outcome] ?? r.outcome}/${r.score ?? '-'}/${r.size ?? '-'}`
    : '缺失';
  const dScore = b?.score != null && a?.score != null ? a.score - b.score : '-';
  console.log(
    [
      id,
      (b?.input ?? a?.input ?? '').slice(0, 22),
      fmt(b),
      fmt(a),
      dScore,
      `${b?.checks ?? '-'}/${a?.checks ?? '-'}`,
      b?.durationMs != null || a?.durationMs != null
        ? `${Math.round((b?.durationMs ?? 0) / 1000)}→${Math.round((a?.durationMs ?? 0) / 1000)}s`
        : '-',
    ].join(' | '),
  );
}

console.log('\n=== 主指标（分母 = 主指标组 ' + mBefore.total + '/' + mAfter.total + ' 例）===');
const cmp = (b, a, fmt) => `${fmt(b)} → ${fmt(a)}  ${a >= b ? '✅' : '❌ 下降'}`;
const rateFmt = (m) => `${(m.rate * 100).toFixed(1)}%（${m.delivered}/${m.total}）`;
console.log(`1. 合格交付率  ${cmp(mBefore, mAfter, rateFmt)}`);
console.log(`2. 最低图形分  ${cmp(mBefore.min ?? 0, mAfter.min ?? 0, (v) => (mBefore.min == null && mAfter.min == null ? 'N/A' : v))}`);
console.log(`3. 平均图形分  ${cmp(mBefore.avg ?? 0, mAfter.avg ?? 0, (v) => (mBefore.avg == null && mAfter.avg == null ? 'N/A' : v.toFixed(1)))}`);

const pass = mAfter.rate >= mBefore.rate && (mAfter.min ?? 0) >= (mBefore.min ?? 0) && (mAfter.avg ?? 0) >= (mBefore.avg ?? 0);
console.log(`\n判定：${pass ? '✅ 通过 —— 三项主指标均不低于优化前' : '❌ 不通过 —— 存在下降项，按方案 §8.6 停止并定位'}`);
if (watchIds.length) {
  console.log('\n=== 波动观察组（只作线索，不进判定）===');
  for (const id of watchIds) {
    const b = before.get(id);
    const a = after.get(id);
    const flip = b && a && b.outcome !== a.outcome;
    console.log(`${id} | ${(b?.input ?? '').slice(0, 18)} | before ${OUTCOME_SHORT[b?.outcome] ?? b?.outcome}/${b?.score ?? '-'} | after ${OUTCOME_SHORT[a?.outcome] ?? a?.outcome}/${a?.score ?? '-'}${flip ? '  ⚠️ outcome 翻转' : ''}`);
  }
}
process.exit(pass ? 0 : 1);
