/**
 * 生产文件行数闸门（清理方案 2026-11-09 阶段 4）。
 *
 * 项目规范：单个生产代码文件 ≤500 行（AGENTS.md）。此前没有 lint/CI 拦截，
 * controller.js 从 849 → 1,585 → 4,953 行一路无人阻塞（方案 §2.11 根因之一）。
 *
 * 口径：
 * - 扫描 `web/src/**` 与 `web/server.mjs`（生产代码），不含 CSS；
 * - `tools/`、`test/`、`web/vendor/` 豁免（工具与测试不计入生产行数）；
 * - `EXEMPT` 是已记录的豁免项（附原因），用于把"当前已知的超限文件"变成
 *   **显式清单**而不是默默超限——新增超限文件一律 fail。
 *
 * 退出码：有未豁免的超限文件 → 1；否则 0。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 行数上限 */
const LIMIT = 500;

/**
 * 已记录的豁免（文件 → { 原因, maxLines }）。
 *
 * `maxLines` = 登记当天的行数 + 少量余量（上限 ≤ 当前行数的 +3% 或 +20 行，取大者，
 * 再向上取整到 10 行）。**豁免不是空白支票**：文件一旦长过 `maxLines` 闸门就 fail，
 * 必须先拆分、或显式上调 `maxLines` 并写清理由——这样"再长一个巨石"会被真正拦下，
 * 而不是只拦"新增超限文件"。
 *
 * 新增超限文件不在此列 → fail。
 */
const EXEMPT = new Map([
  ['web/src/agent/controller.js', { maxLines: 1735, reason: '编排层：C4 已拆出 pipeline/*（4412→1720）；余下为三路时序/目标验收/引导状态机等强闭包耦合部分（继续拆需状态机接口化）' }],
  ['web/src/engine/planner.js', { maxLines: 575, reason: '单图形规划：C3 已拆 planner-snap/legs/result（1081→565）；余下 planShapeRoute 主流程与腿循环' }],
  ['web/src/agent/target-acceptance.js', { maxLines: 930, reason: '目标验收规则表（四态约束语义密集，拆分收益低）' }],
  ['web/src/agent/shape-spec.js', { maxLines: 910, reason: '参数化规格校验与不变量' }],
  ['web/src/reference/browser.js', { maxLines: 670, reason: '本地素材匹配与本地参考源' }],
  ['web/src/agent/shape-review.js', { maxLines: 575, reason: '视觉质检闭环（B2 已抽 outcomeOf，620→566）' }],
  ['web/src/shape-engine.js', { maxLines: 625, reason: '引擎对外门面' }],
  ['web/server/reference/online-service.js', { maxLines: 610, reason: '服务端在线检索服务（查询校验与检索编排可再拆）' }],
  ['web/src/agent/reply/templates.js', { maxLines: 560, reason: '回复文案模板（B2 已合并四对双份，587→552）' }],
  ['web/src/agent/reference.js', { maxLines: 530, reason: '参考候选源（B2 已抽 adaptOnlineResult/adaptLocalResult，568→520）' }],
  ['web/src/agent/request-objects.js', { maxLines: 555, reason: '多对象身份匹配（A 批 namesMatch 合并后 546）' }],
]);

/** 扫描目录 */
const SCAN_DIRS = ['web/src', 'web/server'];

/** 收集生产代码文件 */
const files = [];
/**
 * 递归收集目录下的 js/mjs。
 *
 * @param {string} dir 目录（绝对路径）
 */
function collect(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['vendor', 'node_modules', 'data', 'logs'].includes(entry.name)) continue;
      collect(path);
    } else if (/\.(js|mjs)$/.test(entry.name)) {
      files.push(path);
    }
  }
}
for (const dir of SCAN_DIRS) collect(join(ROOT, dir));

/** 统计 */
const over = [];
const underLimit = [];
for (const file of files) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const lines = readFileSync(file, 'utf8').split(/\r?\n/).length;
  const entry = EXEMPT.get(rel) || null;
  if (lines > LIMIT) over.push({ rel, lines, exempt: entry });
  else if (entry) underLimit.push({ rel, lines });
}

over.sort((a, b) => b.lines - a.lines);

console.log(`生产代码文件 ${files.length} 个，行数上限 ${LIMIT}`);
if (over.length === 0) {
  console.log('全部在上限内 ✅');
} else {
  console.log(`\n超限 ${over.length} 个：`);
  for (const item of over) {
    const mark = item.exempt ? '（已豁免）' : '← 未豁免';
    console.log(`  ${String(item.lines).padStart(5)} 行  ${item.rel}  ${mark}`);
    if (item.exempt) {
      console.log(`             原因：${item.exempt.reason}`);
      console.log(`             豁免上限：${item.exempt.maxLines} 行（超出即 fail）`);
    }
  }
}

if (underLimit.length > 0) {
  console.log('\n已降到上限内、可从豁免清单移除的文件：');
  for (const item of underLimit) {
    console.log(`  ${String(item.lines).padStart(5)} 行  ${item.rel}`);
  }
}

const violations = over.filter((item) => !item.exempt);
const grown = over.filter((item) => item.exempt && item.lines > item.exempt.maxLines);

if (violations.length > 0) {
  console.log(`\n未豁免的超限文件 ${violations.length} 个 —— 闸门不通过`);
  process.exitCode = 1;
} else if (grown.length > 0) {
  console.log(`\n豁免文件超上限 ${grown.length} 个 —— 闸门不通过（必须拆分，或显式上调 maxLines 并写明理由）`);
  for (const item of grown) {
    console.log(`  ${item.rel}：${item.lines} 行 > 上限 ${item.exempt.maxLines} 行（超出 ${item.lines - item.exempt.maxLines} 行）`);
  }
  process.exitCode = 1;
} else {
  console.log('\n闸门通过 ✅（超限项均已登记豁免，且未超过各自 maxLines）');
}
