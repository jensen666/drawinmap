/**
 * 准确性优先验收套件：20 例（A 组 10 历史问题例 + B 组 10 冻结全新例）。
 *
 * 方案 2026-11-08 §8.2 的硬性规模：至少 20 个**不同输入**的真实浏览器 E2E，
 * A/B 两组分别不少于 10 个。运行入口：
 *
 *   node web/server.mjs 5173
 *   node tools/e2e-real-llm-30.mjs \
 *     --cases-file test/e2e-accuracy-20-cases.mjs \
 *     --artifact-dir "docs/测试报告/<本轮真实LLM-E2E-20例验收>" \
 *     --out result.json \
 *     --turn-timeout 420000
 *
 * 单浏览器连跑出现卡死时可按每段不超过 10 例分段（A/B 各一段），每段独立浏览器；
 * 合并结果必须包含全部段落并重算断言统计。
 */

import { CASES as HISTORY_CASES } from './e2e-accuracy-history-10-cases.mjs';
import { CASES as NEW_CASES } from './e2e-accuracy-new-10-cases.mjs';

export const CASES = [...HISTORY_CASES, ...NEW_CASES];

export const SUITE_TITLE = '准确性优先·约束一致性与生成可靠性 20 例验收';
