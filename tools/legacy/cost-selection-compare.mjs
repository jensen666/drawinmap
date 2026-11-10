/**
 * 成本感知选优对照实验（方案 2026-11-05 §6）。
 *
 * §6 不预设已验证参数，只定义**公平对照方法**：同一个候选池、同一套流程，
 * 分别跑「当前规则 / 统一容差规则 / 合格候选中的成本优先规则」，然后看整组指标：
 * 交付率、最低分、平均分、尺寸/路线/偏移中位与极端值。
 *
 * 本工具只做对照与采纳判定，**不修改生产默认选优规则**——规则要上线必须
 * 满足 §6 的采纳条件（整组交付率不降、最低分不塌、平均分与中位/极端值同时改善、
 * 留出集与人工视觉复核通过），任何一项不满足即判为未采纳。
 *
 * 用法：
 *   node tools/cost-selection-compare.mjs --set calibration --limit 40
 *   node tools/cost-selection-compare.mjs --candidates dump.json
 *
 * 参数：
 *   --set <name>      语料集（默认 calibration）
 *   --limit <n>       限制样本数（默认不限）
 *   --candidates <f>  已有候选池 JSON（跳过引擎重跑，直接做规则对照）
 *   --tolerance <r>   统一容差规则的相对 RMS 容差（默认 0.1）
 *   --out <file>      报告 JSON 输出路径
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { searchWithEscalation } from '../../web/src/engine/candidates.js';
import { qualityGateReport } from '../../web/src/engine/quality.js';
import { distanceMeters } from '../../web/src/engine/graph.js';
import { selectByRule, SELECTION_RULES } from '../../web/src/engine/selection.js';
import { setLevel } from '../../web/src/log/index.js';
import { getSamples } from '../../test/fixtures/corpus/corpus.mjs';
import { buildNetwork, networkInstanceById } from '../../test/fixtures/corpus/roadnet.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/**
 * 解析命令行参数（同时支持 `--flag value` 与 `--flag=value` 两种写法）。
 *
 * @param {string[]} argv 进程参数
 * @returns {object} 参数对象
 */
export function parseArgs(argv) {
  const options = {
    set: 'calibration',
    limit: null,
    candidates: null,
    tolerance: 0.1,
    out: null,
  };
  const list = Array.isArray(argv) ? argv : [];
  /** 取 flag 的值：优先取等号右侧，否则取下一个参数 */
  const valueOf = (index) => {
    const raw = list[index] ?? '';
    if (raw.includes('=')) {
      return raw.split(/=(.*)/s)[1];
    }
    const next = list[index + 1];
    return next && !next.startsWith('--') ? next : null;
  };
  for (let index = 0; index < list.length; index += 1) {
    const raw = list[index] ?? '';
    const key = raw.includes('=') ? raw.split(/=(.*)/s)[0] : raw;
    switch (key) {
      case '--set':
        options.set = valueOf(index) || 'calibration';
        break;
      case '--limit':
        options.limit = Number(valueOf(index));
        break;
      case '--candidates':
        options.candidates = valueOf(index);
        break;
      case '--tolerance':
        options.tolerance = Number(valueOf(index));
        break;
      case '--out':
        options.out = valueOf(index);
        break;
      default:
        break;
    }
  }
  if (!Number.isFinite(options.limit) || options.limit <= 0) {
    options.limit = null;
  }
  if (!Number.isFinite(options.tolerance) || options.tolerance <= 0) {
    options.tolerance = 0.1;
  }
  return options;
}

/**
 * 中位数（空集返回 null）。
 *
 * @param {number[]} values 数值列表
 * @returns {number|null}
 */
export function median(values) {
  const list = (values || []).filter((value) => Number.isFinite(value)).slice().sort((a, b) => a - b);
  if (list.length === 0) {
    return null;
  }
  const mid = Math.floor(list.length / 2);
  return list.length % 2 === 1 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

/**
 * 一组样本在某条规则下的结果指标（方案 §6 采纳条件用）。
 *
 * @param {Array<object>} samples 每例 { id, selected: {score,sizeMeters,routeMeters,walkMinutes,offsetMeters} }
 * @returns {object} 汇总指标
 */
export function summarizeRule(samples) {
  const delivered = samples.filter((item) => item?.selected);
  const scores = delivered.map((item) => item.selected.score).filter(Number.isFinite);
  const sizes = delivered.map((item) => item.selected.sizeMeters).filter(Number.isFinite);
  const routes = delivered.map((item) => item.selected.routeMeters).filter(Number.isFinite);
  const walks = delivered.map((item) => item.selected.walkMinutes).filter(Number.isFinite);
  const offsets = delivered.map((item) => item.selected.offsetMeters).filter(Number.isFinite);
  const mean = (list) => (list.length ? list.reduce((sum, value) => sum + value, 0) / list.length : null);
  return {
    total: samples.length,
    delivered: delivered.length,
    deliveryRate: samples.length ? delivered.length / samples.length : 0,
    minScore: scores.length ? Math.min(...scores) : null,
    meanScore: mean(scores),
    sizeMedian: median(sizes),
    sizeMax: sizes.length ? Math.max(...sizes) : null,
    routeMedian: median(routes),
    routeMax: routes.length ? Math.max(...routes) : null,
    walkMedian: median(walks),
    walkMax: walks.length ? Math.max(...walks) : null,
    offsetMedian: median(offsets),
    offsetMax: offsets.length ? Math.max(...offsets) : null,
  };
}

/**
 * 采纳条件判定（方案 §6）：只看单个案例、或只改善中位数而极端成本不变，都不算完成。
 *
 * @param {object} baseline 当前规则的汇总
 * @param {object} candidate 候选规则的汇总
 * @returns {{adopted: boolean, reasons: string[], checks: object}}
 */
export function judgeAdoption(baseline, candidate) {
  const checks = {};
  const reasons = [];
  const notWorse = (value, base) => value === null || base === null || value >= base - 1e-9;
  const better = (value, base) => value !== null && base !== null && value < base - 1e-9;

  checks.deliveryRateNotDown = candidate.deliveryRate >= baseline.deliveryRate - 1e-9;
  if (!checks.deliveryRateNotDown) {
    reasons.push(`整组交付率下降：${baseline.deliveryRate.toFixed(3)} → ${candidate.deliveryRate.toFixed(3)}`);
  }
  checks.minScoreNotDown = notWorse(candidate.minScore, baseline.minScore);
  if (!checks.minScoreNotDown) {
    reasons.push(`最低分下降：${baseline.minScore} → ${candidate.minScore}`);
  }
  checks.meanScoreNotDown = notWorse(candidate.meanScore, baseline.meanScore);
  if (!checks.meanScoreNotDown) {
    reasons.push(`平均分下降：${baseline.meanScore?.toFixed(2)} → ${candidate.meanScore?.toFixed(2)}`);
  }
  checks.sizeMedianImproved = better(candidate.sizeMedian, baseline.sizeMedian);
  checks.routeMedianImproved = better(candidate.routeMedian, baseline.routeMedian);
  checks.offsetMedianImproved = better(candidate.offsetMedian, baseline.offsetMedian);
  // 极端值必须同时改善（只改善中位数不算）
  checks.extremeImproved =
    better(candidate.routeMax, baseline.routeMax) || better(candidate.offsetMax, baseline.offsetMax);
  if (!checks.extremeImproved) {
    reasons.push('极端成本未改善（路线/偏移最大值没有下降）');
  }
  if (!checks.sizeMedianImproved && !checks.routeMedianImproved && !checks.offsetMedianImproved) {
    reasons.push('尺寸/路线/偏移中位数均未改善');
  }
  return {
    adopted: reasons.length === 0,
    reasons,
    checks,
  };
}

/**
 * 对一个候选池跑一组规则，返回每条规则的逐例结果。
 *
 * @param {Array<object>} pool 候选池 [{ candidates: [...], center: {lat,lng} }]
 * @param {object} options
 * @returns {object} { rules: { ruleName: {samples, summary} } }
 */
export function compareRulesOnPools(pool, { tolerance = 0.1, rules = SELECTION_RULES } = {}) {
  const result = { rules: {} };
  for (const rule of rules) {
    const samples = pool.map((entry) => {
      const picked = selectByRule(entry.candidates, rule, {
        tolerance,
        origin: entry.center ?? null,
      });
      const metrics = picked?.metrics ?? null;
      return {
        id: entry.id ?? null,
        selected: metrics
          ? {
              score: metrics.score,
              sizeMeters: metrics.sizeMeters,
              routeMeters: metrics.routeMeters,
              walkMinutes: metrics.walkMinutes,
              offsetMeters: metrics.offsetMeters,
              worseSideRms: metrics.worseSideRms,
            }
          : null,
        fallbackUsed: picked?.fallbackUsed ?? false,
      };
    });
    result.rules[rule] = { samples, summary: summarizeRule(samples) };
  }
  return result;
}

/**
 * 用真实引擎跑一遍语料，收集每例的完整达标候选池。
 *
 * @param {object} options
 * @returns {Promise<Array<object>>} 候选池
 */
export async function collectPoolsFromCorpus({ set = 'calibration', limit = null } = {}) {
  const samples = getSamples(set);
  const list = limit ? samples.slice(0, limit) : samples;
  const pools = [];
  for (const sample of list) {
    const network = buildNetwork(networkInstanceById(sample.networkId));
    const customShape = {
      name: sample.id,
      constraintPoints: sample.outline.constraintPoints,
      outlinePoints: sample.outline.outlinePoints,
    };
    if (sample.outline.parts?.length) {
      customShape.parts = sample.outline.parts;
    }
    if (sample.outline.features?.length) {
      customShape.features = sample.outline.features;
    }
    const started = performance.now();
    const result = await searchWithEscalation({
      graph: network.graph,
      edgeIndex: network.edgeIndex,
      customShape,
      center: sample.center,
      baseSizeMeters: sample.baseSizeMeters,
      collectCandidates: true,
    });
    const candidates = result.passingCandidates ?? [];
    process.stdout.write(
      `[样本] ${sample.id} → ${result.status}（达标候选 ${candidates.length} 个，${Math.round(performance.now() - started)}ms）\n`,
    );
    pools.push({
      id: sample.id,
      center: sample.center,
      baseSizeMeters: sample.baseSizeMeters,
      status: result.status,
      durationMs: performance.now() - started,
      qualityGate: candidates.length
        ? qualityGateReport(candidates[0].result?.metrics ?? null).passes
        : false,
      candidates: candidates.map((candidate) => ({
        result: candidate.result,
        score: candidate.score,
        adjustedScore: candidate.adjustedScore,
        center: candidate.center,
        sizeMeters: candidate.sizeMeters,
        rotationDeg: candidate.rotationDeg,
        stage: candidate.stage,
        stageLabel: candidate.stageLabel,
      })),
      best: result.best
        ? {
            score: result.best.score,
            sizeMeters: result.best.sizeMeters,
            offsetMeters: distanceMeters(
              sample.center.lat,
              sample.center.lng,
              result.best.center.lat,
              result.best.center.lng,
            ),
          }
        : null,
    });
  }
  return pools;
}

/**
 * 打印对照表（与方案 §3.2 同结构）。
 *
 * @param {object} comparison 对照结果
 * @param {object} [baseline] 基线规则名
 */
function printTable(comparison, baseline = 'current') {
  const names = Object.keys(comparison.rules);
  const header = ['规则', '交付率', '最低分', '平均分', '尺寸中位(m)', '路线中位(km)', '偏移中位(km)', '路线最大(km)'];
  const rows = names.map((name) => {
    const s = comparison.rules[name].summary;
    // 注意：0 是合法中位数，必须用 != null 判断，不能用真值判断
    const show = (value, format) => (value === null || value === undefined ? '-' : format(value));
    return [
      name,
      s.deliveryRate.toFixed(3),
      show(s.minScore, (v) => String(v)),
      show(s.meanScore, (v) => v.toFixed(2)),
      show(s.sizeMedian, (v) => String(Math.round(v))),
      show(s.routeMedian, (v) => (v / 1000).toFixed(2)),
      show(s.offsetMedian, (v) => (v / 1000).toFixed(2)),
      show(s.routeMax, (v) => (v / 1000).toFixed(2)),
    ];
  });
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...rows.map((row) => String(row[index]).length)),
  );
  const line = (cells) => cells.map((cell, index) => String(cell).padEnd(widths[index])).join('  ');
  console.log(`\n[对照] 规则对照（基线 = ${baseline}）`);
  console.log(line(header));
  console.log(widths.map((width) => '-'.repeat(width)).join('  '));
  for (const row of rows) {
    console.log(line(row));
  }
  for (const name of names) {
    if (name === baseline) {
      continue;
    }
    const judgment = judgeAdoption(
      comparison.rules[baseline].summary,
      comparison.rules[name].summary,
    );
    console.log(
      `[采纳判定] ${name}：${judgment.adopted ? '满足采纳条件' : '不满足（' + judgment.reasons.join('；') + '）'}`,
    );
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  // 引擎日志默认只进内存缓冲（不落盘、不刷屏）：逐候选日志会把整组对照拖慢一个量级
  setLevel('off');
  let pools;
  if (options.candidates) {
    const file = path.isAbsolute(options.candidates)
      ? options.candidates
      : path.resolve(ROOT, options.candidates);
    pools = JSON.parse(readFileSync(file, 'utf8'));
    console.log(`[输入] 读入候选池 ${file}（${pools.length} 例）`);
  } else {
    console.log(`[输入] 跑语料集 ${options.set}${options.limit ? `（前 ${options.limit} 例）` : ''}…`);
    pools = await collectPoolsFromCorpus(options);
    console.log(`[输入] 收集到 ${pools.length} 例候选池`);
  }
  const comparison = compareRulesOnPools(pools, { tolerance: options.tolerance });
  printTable(comparison);
  if (options.out) {
    const file = path.isAbsolute(options.out) ? options.out : path.resolve(ROOT, options.out);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          set: options.set,
          tolerance: options.tolerance,
          sampleCount: pools.length,
          rules: Object.fromEntries(
            Object.entries(comparison.rules).map(([name, value]) => [
              name,
              { summary: value.summary, samples: value.samples },
            ]),
          ),
          judgments: Object.fromEntries(
            Object.keys(comparison.rules)
              .filter((name) => name !== 'current')
              .map((name) => [
                name,
                judgeAdoption(comparison.rules.current.summary, comparison.rules[name].summary),
              ]),
          ),
        },
        null,
        2,
      ),
      'utf8',
    );
    console.log(`\n[输出] 报告已写入 ${file}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(`[error] ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}
