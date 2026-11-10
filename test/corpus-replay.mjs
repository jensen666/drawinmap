/**
 * 语料基线回放脚本（Node 直接运行，不依赖浏览器/网络）。
 *
 * 用途（方案 §10 / §11 阶段 0）：对冻结的分层语料跑一遍当前引擎，把"当前版本的
 * 真实表现"记录成可复现的基线报告，作为后续双闸修复与视觉门改动的对照。
 *
 * 记录内容：status / score / adjustedScore / sizeMeters / rotationDeg /
 * offsetMeters / 质量门明细（qualityGateReport）/ 形状绝对误差包络 E_shape
 * （orderedOutlineMaxMeters、orderedRouteMaxMeters、frechetMaxMeters，缺字段记 null）/
 * 路线拓扑诊断（唯一交叉数、重复道路比例）/ 整体形态米制指标 /
 * triedCount / budgetExhausted。
 *
 * 拓扑与整体形态指标（2026-11-02 判别实验补充）：方案阶段 2「最小全局视觉门」
 * 是否值得做，取决于"已交付样本里有多少是逐段贴路但整体不像的虚假绿线"。
 * 这需要先能测出交付样本的跨段交叉与重复道路，故本脚本在回放时补记
 * route-topology.js 的诊断指标——它们此前只作诊断、不设门，不改变任何交付判定。
 *
 * 用法：
 *   node test/corpus-replay.mjs --set=calibration --limit=5
 *   node test/corpus-replay.mjs --set=holdout
 *   node test/corpus-replay.mjs --set=all --out=test/fixtures/corpus/baseline-phase0.json
 *
 * 参数：
 *   --set=calibration|holdout|final|all   跑哪一组（默认 calibration）
 *   --limit=N                             只跑前 N 个样本（默认全部）
 *   --out=<路径>                          报告输出路径（默认 test/fixtures/corpus/baseline-<tag>-<set>.json）
 *   --tag=<版本标记>                      报告版本标记（默认 phase0）
 *   --time-budget=<毫秒>                 每个样本的时间预算（默认沿用引擎默认 30000）
 *   --max-candidates=<个数>               每个样本的候选数上限（默认沿用引擎默认 2200）
 *   --verbose                             保留引擎日志输出（默认关闭，日志只进内存）
 *
 * 约束：必须真实调用引擎的 planShapeRoute / searchWithEscalation，不使用任何 mock 路线；
 * 语料由固定 seed 的程序化生成器产出，同一 seed 必然得到同一份语料与同一份基线。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchWithEscalation } from '../web/src/engine/candidates.js';
import { qualityGateReport } from '../web/src/engine/quality.js';
import { distanceMeters } from '../web/src/engine/graph.js';
import { collectRouteTopologyMetrics } from '../web/src/engine/route-topology.js';
import { setLevel } from '../web/src/log/index.js';
import {
  CORPUS_MASTER_SEED,
  CORPUS_VERSION,
  GEOMETRY_DIMENSIONS,
  NETWORK_DIMENSIONS,
  getCorpus,
} from './fixtures/corpus/corpus.mjs';
import { buildNetwork, networkInstanceById } from './fixtures/corpus/roadnet.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 默认报告目录 */
const DEFAULT_REPORT_DIR = path.join(HERE, 'fixtures', 'corpus');

/**
 * 解析命令行参数。
 *
 * @param {string[]} argv 进程参数
 * @returns {object} 参数对象
 */
export function parseArgs(argv) {
  const options = {
    set: 'calibration',
    limit: null,
    out: null,
    tag: CORPUS_VERSION,
    timeBudgetMs: null,
    maxCandidates: null,
    verbose: false,
  };
  for (const raw of argv) {
    const [key, value] = raw.includes('=') ? raw.split(/=(.*)/s) : [raw, null];
    switch (key) {
      case '--set':
        options.set = value || 'calibration';
        break;
      case '--limit':
        options.limit = Number(value);
        break;
      case '--out':
        options.out = value;
        break;
      case '--tag':
        options.tag = value || CORPUS_VERSION;
        break;
      case '--time-budget':
        options.timeBudgetMs = Number(value);
        break;
      case '--max-candidates':
        options.maxCandidates = Number(value);
        break;
      case '--verbose':
        options.verbose = true;
        break;
      default:
        break;
    }
  }
  if (!Number.isFinite(options.limit) || options.limit <= 0) {
    options.limit = null;
  }
  return options;
}

/**
 * 有限数值转 null（缺失/非有限一律记 null，不做缺省放行）。
 *
 * @param {unknown} value 原始值
 * @returns {number|null} 有限数值或 null
 */
function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

/**
 * 百分位（输入需已排序）。
 *
 * @param {number[]} sorted 已排序的数值数组
 * @param {number} p 百分位（0~1）
 * @returns {number|null} 百分位数值（空数组返回 null）
 */
function percentile(sorted, p) {
  if (!sorted.length) {
    return null;
  }
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[index];
}

/**
 * 把一个样本跑一遍当前引擎，取出基线指标。
 *
 * @param {object} sample 语料样本
 * @param {object} options 回放参数
 * @returns {Promise<object>} 样本基线记录
 */
async function replaySample(sample, options) {
  const started = performance.now();
  const networkInstance = networkInstanceById(sample.networkId);
  const network = buildNetwork(networkInstance);
  const outline = sample.outline;
  const customShape = {
    // 名称只作诊断用（生产逻辑不读形状名）；用样本 id，避免任何对象语义
    name: sample.id,
    constraintPoints: outline.constraintPoints,
    outlinePoints: outline.outlinePoints,
  };
  if (outline.parts && outline.parts.length > 0) {
    customShape.parts = outline.parts;
  }
  if (outline.features && outline.features.length > 0) {
    customShape.features = outline.features;
  }

  const searchOptions = {
    graph: network.graph,
    edgeIndex: network.edgeIndex,
    customShape,
    center: sample.center,
    baseSizeMeters: sample.baseSizeMeters,
  };
  if (Number.isFinite(options.timeBudgetMs)) {
    searchOptions.timeBudgetMs = options.timeBudgetMs;
  }
  if (Number.isFinite(options.maxCandidates)) {
    searchOptions.maxCandidates = options.maxCandidates;
  }

  const record = {
    id: sample.id,
    set: sample.set,
    family: sample.family,
    geometryTags: sample.geometryTags,
    networkId: sample.networkId,
    networkTags: sample.networkTags,
    baseSizeMeters: sample.baseSizeMeters,
    center: sample.center,
    status: 'failed',
    score: null,
    adjustedScore: null,
    sizeMeters: null,
    rotationDeg: null,
    offsetMeters: null,
    qualityGate: { hardFailures: [], softFailures: [], softCount: 0, passes: false },
    eShape: {
      orderedOutlineMaxMeters: null,
      orderedRouteMaxMeters: null,
      frechetMaxMeters: null,
      maxMeters: null,
    },
    // 路线拓扑诊断（只作诊断，不设门）：唯一交叉数 + 重复道路比例
    topology: {
      uniqueCrossingCount: null,
      reusedEdgeRatio: null,
      reusedEdgeMeters: null,
      routeMeters: null,
    },
    // 整体形态米制指标：用于判断"逐段贴路但整体不像"
    shape: {
      orderedOutlineMeanMeters: null,
      orderedRouteMeanMeters: null,
      frechetMeanMeters: null,
      keyMaxOffsetMeters: null,
      featureMaxOffsetMeters: null,
      snapMaxMeters: null,
      aspectDistortionRatio: null,
      featureGapRetainRatio: null,
    },
    triedCount: 0,
    budgetExhausted: false,
    durationMs: 0,
    error: null,
  };

  try {
    const result = await searchWithEscalation(searchOptions);
    const best = result.best || null;
    const metrics = best?.result?.metrics || null;
    const gate = metrics
      ? qualityGateReport(metrics)
      : { hardFailures: ['metrics-missing'], softFailures: [], softCount: 0, passes: false };
    const orderedOutlineMaxMeters = finiteOrNull(metrics?.orderedOutlineMaxMeters);
    const orderedRouteMaxMeters = finiteOrNull(metrics?.orderedRouteMaxMeters);
    const frechetMaxMeters = finiteOrNull(metrics?.frechetMaxMeters);
    const allPresent =
      orderedOutlineMaxMeters !== null && orderedRouteMaxMeters !== null && frechetMaxMeters !== null;

    record.status = result.status;
    record.score = finiteOrNull(best?.score);
    record.adjustedScore = finiteOrNull(best?.adjustedScore);
    record.sizeMeters = finiteOrNull(best?.sizeMeters);
    record.rotationDeg = finiteOrNull(best?.rotationDeg);
    record.offsetMeters =
      best?.center
        ? finiteOrNull(
            distanceMeters(sample.center.lat, sample.center.lng, best.center.lat, best.center.lng),
          )
        : null;
    record.qualityGate = {
      hardFailures: gate.hardFailures,
      softFailures: gate.softFailures.map((item) => item.key),
      softCount: gate.softCount,
      passes: gate.passes,
    };
    record.eShape = {
      orderedOutlineMaxMeters,
      orderedRouteMaxMeters,
      frechetMaxMeters,
      maxMeters: allPresent
        ? Math.max(orderedOutlineMaxMeters, orderedRouteMaxMeters, frechetMaxMeters)
        : null,
    };
    // 路线拓扑诊断：唯一交叉（非相邻段交叉）与重复道路比例。
    // 只对最终选定的候选统计，与 shape-engine.js 的口径一致（同一模块、同一函数）。
    const topology = collectRouteTopologyMetrics({ legs: best?.result?.legs, metrics });
    record.topology = {
      uniqueCrossingCount: Number.isFinite(topology.crossings.count) ? topology.crossings.count : null,
      reusedEdgeRatio: finiteOrNull(topology.reuse.reusedEdgeRatio),
      reusedEdgeMeters: finiteOrNull(topology.reuse.reusedEdgeMeters),
      routeMeters: finiteOrNull(topology.reuse.routeMeters),
    };
    record.shape = {
      orderedOutlineMeanMeters: finiteOrNull(metrics?.orderedOutlineMeanMeters),
      orderedRouteMeanMeters: finiteOrNull(metrics?.orderedRouteMeanMeters),
      frechetMeanMeters: finiteOrNull(metrics?.frechetMeanMeters),
      keyMaxOffsetMeters: finiteOrNull(metrics?.keyMaxOffsetMeters),
      featureMaxOffsetMeters: finiteOrNull(metrics?.featureMaxOffsetMeters),
      snapMaxMeters: finiteOrNull(metrics?.snapMaxMeters),
      aspectDistortionRatio: finiteOrNull(metrics?.aspectDistortionRatio),
      featureGapRetainRatio: finiteOrNull(metrics?.featureGapRetainRatio),
    };
    record.triedCount = result.triedCount ?? 0;
    record.budgetExhausted = Boolean(result.budgetExhausted);
  } catch (error) {
    record.error = error?.message ? String(error.message) : String(error);
  }
  record.durationMs = Math.round((performance.now() - started) * 10) / 10;
  return record;
}

/**
 * 汇总一个分层的统计（通过率与分数分位）。
 *
 * @param {Array<object>} records 样本基线记录
 * @returns {object} 分层统计
 */
function summarizeStratum(records) {
  const scores = records.map((record) => record.score).filter((value) => value !== null).sort((a, b) => a - b);
  const shapes = records
    .map((record) => record.eShape.maxMeters)
    .filter((value) => value !== null)
    .sort((a, b) => a - b);
  const passed = records.filter((record) => record.status === 'ok').length;
  // 通过样本的拓扑诊断分位：用于判别"已交付样本里有多少是虚假绿线"
  const passedRecords = records.filter((record) => record.status === 'ok');
  const crossingCounts = passedRecords
    .map((record) => record.topology.uniqueCrossingCount)
    .filter((value) => value !== null)
    .sort((a, b) => a - b);
  const reuseRatios = passedRecords
    .map((record) => record.topology.reusedEdgeRatio)
    .filter((value) => value !== null)
    .sort((a, b) => a - b);
  return {
    count: records.length,
    passed,
    failed: records.length - passed,
    passRate: records.length > 0 ? Math.round((passed / records.length) * 1000) / 10 : null,
    scoreP50: percentile(scores, 0.5),
    scoreP90: percentile(scores, 0.9),
    scoreP95: percentile(scores, 0.95),
    scoreMin: scores.length ? scores[0] : null,
    scoreMax: scores.length ? scores[scores.length - 1] : null,
    shapeP50: percentile(shapes, 0.5),
    shapeP90: percentile(shapes, 0.9),
    shapeP95: percentile(shapes, 0.95),
    passedWithCrossing: passedRecords.filter(
      (record) => (record.topology.uniqueCrossingCount ?? 0) > 0,
    ).length,
    passedCrossingP50: percentile(crossingCounts, 0.5),
    passedCrossingP90: percentile(crossingCounts, 0.9),
    passedCrossingMax: crossingCounts.length ? crossingCounts[crossingCounts.length - 1] : null,
    passedReuseRatioP50: percentile(reuseRatios, 0.5),
    passedReuseRatioP90: percentile(reuseRatios, 0.9),
    passedReuseRatioMax: reuseRatios.length ? reuseRatios[reuseRatios.length - 1] : null,
  };
}

/**
 * 主流程：跑语料 → 汇总 → 写报告 → 打印分层统计。
 *
 * @returns {Promise<number>} 进程退出码
 */
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.verbose) {
    // 引擎日志默认只进内存缓冲（不落盘、不刷屏），需要排查时用 --verbose 打开
    setLevel('off');
  }

  const corpus = getCorpus();
  const pool =
    options.set === 'all'
      ? [...corpus.sets.calibration, ...corpus.sets.holdout, ...corpus.sets.final]
      : corpus.sets[options.set] || [];
  const selected = options.limit ? pool.slice(0, options.limit) : pool;

  console.log(
    `[corpus] 版本 ${CORPUS_VERSION} / 主种子 ${CORPUS_MASTER_SEED} / 集合 ${options.set} / ` +
      `样本 ${selected.length}（语料全量 ${corpus.samples.length}）`,
  );

  const records = [];
  for (let index = 0; index < selected.length; index += 1) {
    const sample = selected[index];
    const record = await replaySample(sample, options);
    records.push(record);
    console.log(
      `  [${index + 1}/${selected.length}] ${record.id} ${record.family} → ${record.status} ` +
        `分 ${record.score ?? '-'} 尺寸 ${record.sizeMeters ?? '-'}m 偏移 ${record.offsetMeters ?? '-'}m ` +
        `E_shape ${record.eShape.maxMeters ?? '-'}m ` +
        `交叉 ${record.topology.uniqueCrossingCount ?? '-'} 重复 ${record.topology.reusedEdgeRatio ?? '-'} ` +
        `试 ${record.triedCount} 用时 ${record.durationMs}ms` +
        (record.error ? ` 错误 ${record.error}` : ''),
    );
  }

  // 分层统计：几何维与路网维各出一份
  const strata = {};
  const dimensionValues = { geo: GEOMETRY_DIMENSIONS, net: NETWORK_DIMENSIONS };
  for (const [prefix, dimensions] of Object.entries(dimensionValues)) {
    for (const dimension of dimensions) {
      const values = new Set(records.map((record) => record[prefix === 'geo' ? 'geometryTags' : 'networkTags'][dimension]));
      for (const value of values) {
        const bucket = records.filter(
          (record) => record[prefix === 'geo' ? 'geometryTags' : 'networkTags'][dimension] === value,
        );
        strata[`${prefix}:${dimension}=${value}`] = summarizeStratum(bucket);
      }
    }
  }

  // 失败类型分布：硬门槛与软门槛分开统计
  const failureTypes = {};
  for (const record of records) {
    if (record.status === 'ok') {
      continue;
    }
    for (const key of record.qualityGate.hardFailures) {
      const name = `hard:${key}`;
      failureTypes[name] = (failureTypes[name] || 0) + 1;
    }
    for (const key of record.qualityGate.softFailures) {
      const name = `soft:${key}`;
      failureTypes[name] = (failureTypes[name] || 0) + 1;
    }
    if (record.qualityGate.hardFailures.length === 0 && record.qualityGate.softFailures.length === 0) {
      failureTypes['hard:no-candidate'] = (failureTypes['hard:no-candidate'] || 0) + 1;
    }
  }

  const passed = records.filter((record) => record.status === 'ok').length;
  // 交付样本的拓扑诊断汇总（判别实验）：虚假绿线到底有多少
  const passedRecords = records.filter((record) => record.status === 'ok');
  const passedCrossings = passedRecords
    .map((record) => record.topology.uniqueCrossingCount)
    .filter((value) => value !== null)
    .sort((a, b) => a - b);
  const passedReuse = passedRecords
    .map((record) => record.topology.reusedEdgeRatio)
    .filter((value) => value !== null)
    .sort((a, b) => a - b);
  const passedDiagnostics = {
    count: passedRecords.length,
    /** 有跨段交叉的交付样本数（非相邻腿真实相交） */
    withCrossing: passedRecords.filter(
      (record) => (record.topology.uniqueCrossingCount ?? 0) > 0,
    ).length,
    crossingP50: percentile(passedCrossings, 0.5),
    crossingP90: percentile(passedCrossings, 0.9),
    crossingMax: passedCrossings.length ? passedCrossings[passedCrossings.length - 1] : null,
    reusedRatioP50: percentile(passedReuse, 0.5),
    reusedRatioP90: percentile(passedReuse, 0.9),
    reusedRatioMax: passedReuse.length ? passedReuse[passedReuse.length - 1] : null,
    /**
     * 启发式参考线（未按 §10 校准，只用于看趋势、不作门禁）：
     * 重复道路比例 > 0.2 视为"大量叠线/异常折返"的候选形态。
     */
    reusedRatioOver20pct: passedRecords.filter(
      (record) => (record.topology.reusedEdgeRatio ?? 0) > 0.2,
    ).length,
  };
  const report = {
    version: options.tag,
    corpusVersion: CORPUS_VERSION,
    corpusMasterSeed: CORPUS_MASTER_SEED,
    generatedAt: new Date().toISOString(),
    node: process.version,
    params: {
      set: options.set,
      limit: options.limit,
      timeBudgetMs: options.timeBudgetMs ?? null,
      maxCandidates: options.maxCandidates ?? null,
    },
    counts: {
      total: records.length,
      passed,
      failed: records.length - passed,
      passRate: records.length > 0 ? Math.round((passed / records.length) * 1000) / 10 : null,
    },
    strata,
    failureTypes,
    passedDiagnostics,
    samples: records,
  };

  // 默认输出带 set 名（2026-11-07 复核修正）：此前固定 baseline-<tag>.json，
  // 跑 test/*.mjs 全量回归时默认 calibration 集会**覆写**提交入库的 all 集基线
  // baseline-phase0.json（159 例 → 66 例），A/B 对照产物被静默污染
  const outPath = options.out
    ? path.resolve(HERE, options.out)
    : path.join(DEFAULT_REPORT_DIR, `baseline-${options.tag}-${options.set}.json`);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  // 打印分层统计与失败类型
  console.log('');
  console.log(`[汇总] 样本 ${report.counts.total} / 通过 ${report.counts.passed} / 失败 ${report.counts.failed} / 通过率 ${report.counts.passRate}%`);
  console.log('');
  console.log('[分层统计]');
  for (const [key, stat] of Object.entries(strata)) {
    console.log(
      `  ${key.padEnd(34)} 样本 ${String(stat.count).padStart(3)}  通过率 ${String(stat.passRate ?? '-').padStart(5)}%  ` +
        `分位 P50 ${stat.scoreP50 ?? '-'} / P90 ${stat.scoreP90 ?? '-'} / P95 ${stat.scoreP95 ?? '-'}  ` +
        `E_shape P50 ${stat.shapeP50 ?? '-'} / P90 ${stat.shapeP90 ?? '-'}  ` +
        `交付样本 有交叉 ${stat.passedWithCrossing ?? '-'}  ` +
        `交叉P50 ${stat.passedCrossingP50 ?? '-'}  重复P50 ${stat.passedReuseRatioP50 ?? '-'}`,
    );
  }
  console.log('');
  console.log('[交付样本拓扑诊断]（判别实验：虚假绿线有多少）');
  console.log(
    `  交付样本 ${passedDiagnostics.count}  有跨段交叉 ${passedDiagnostics.withCrossing}  ` +
      `交叉 P50 ${passedDiagnostics.crossingP50 ?? '-'} / P90 ${passedDiagnostics.crossingP90 ?? '-'} / 最大 ${passedDiagnostics.crossingMax ?? '-'}`,
  );
  console.log(
    `  重复道路比例 P50 ${passedDiagnostics.reusedRatioP50 ?? '-'} / P90 ${passedDiagnostics.reusedRatioP90 ?? '-'} / 最大 ${passedDiagnostics.reusedRatioMax ?? '-'}` +
      `  比例>0.2（启发式参考线，未校准） ${passedDiagnostics.reusedRatioOver20pct}`,
  );
  console.log('');
  console.log('[失败类型]');
  const failureEntries = Object.entries(failureTypes).sort((a, b) => b[1] - a[1]);
  if (failureEntries.length === 0) {
    console.log('  （无失败样本）');
  } else {
    for (const [name, count] of failureEntries) {
      console.log(`  ${name.padEnd(34)} ${count}`);
    }
  }
  console.log('');
  console.log(`[报告] ${outPath}`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
    // 引擎的分片让出会留下 MessageChannel 句柄，Node 不会自动退出；
    // 等 stdout 冲刷完再主动结束，保证管道场景下输出完整且退出码正确。
    process.stdout.write('', () => process.exit(code));
  })
  .catch((error) => {
    console.error('[corpus-replay] 执行失败：', error);
    process.exitCode = 1;
    process.stdout.write('', () => process.exit(1));
  });
