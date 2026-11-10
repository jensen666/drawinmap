/**
 * 整图联合精修：离散候选 + 整块路线评价的坐标下降（不是穷举全局最优）。
 *
 * 背景：规划器对每个约束只吸附"最近的一条道路边"，逐段最优拼起来可能整体次优
 * （某个关键点的最近边导致整段绕行/偏航，而第二近的边能让整条路线更贴目标）。
 * 本模块在局部精修选定的候选基础上，保持中心/尺寸/朝向/目标轮廓不变，
 * 逐约束尝试"第 2~K 近"的道路边，每次都用 planShapeRoute 重算**完整路线**，
 * 只接受"失败门槛变少，或 Fréchet 下降且其余软门槛不退步"的试验结果；
 * 吸附无改进后，再对最差路段尝试少量引导档位。找不到更优结果时原样返回基线，
 * 不返回半条路线。
 *
 * 与既有链路的关系：
 * - 不复制规划器：吸附组合通过 planShapeRoute 的 snapOverrides、单段档位通过
 *   legProfiles 注入，同边劈边/普通点合并/关键点塌缩/多部分连接腿/指标计算全部复用；
 * - 预算共享：evaluations 计入上层候选数、A* 扩展数计入上层工作量、deadline 共用；
 * - 确定性：相同输入与预算下结果一致（评价缓存 + 固定处理顺序）。
 */

import { buildShapeModel } from './shape-model.js';
import { planShapeRoute, projectShape } from './planner.js';
import { nearbyEdges } from './graph.js';
import { qualityGateReport, scoreRoute } from './quality.js';
import { createLogger } from '../log/index.js';
import { isAborted } from '../cancel.js';
import { yieldToUi } from './util/yield.js';

const log = createLogger('engine/joint-refine');

/** 关键约束的吸附候选数（前 K 近） */
const KEY_SNAP_CANDIDATES = 5;
/** 普通约束的吸附候选数 */
const NORMAL_SNAP_CANDIDATES = 3;
/** 吸附扫描轮数上限 */
const MAX_ROUNDS = 2;
/** 单次联合精修最多完整评价次数（预估值，实测后校准）。
 * 导出给 candidates.js 复用：近失精修的预算守卫与 maxEvaluations 必须同一口径。 */
export const DEFAULT_MAX_EVALUATIONS = 120;
/** 最差路段可尝试的引导档位（通用，不针对具体图形） */
const LEG_PROFILES = [
  { name: '强引导', guideGain: 4, corridorSizeRatio: 0.12 },
  { name: '强引导窄走廊', guideGain: 4, corridorSizeRatio: 0.08 },
];
/** 软门槛 excess 比较容差：Fréchet 需"严格下降"、其它门槛需"不变差"，容差吸收浮点噪声 */
const SOFT_EXCESS_EPSILON = 1e-9;
/** Fréchet 软门槛在 qualityGateReport 中的 key（接受规则的定向改善基准） */
const FRECHET_GATE_KEY = 'frechetMax';

/**
 * 整图比较器：a 是否严格优于 b。
 * 先比修正后的 scoreRoute；同分依次比特征覆盖率、最大/平均有序偏差、
 * Fréchet。几何打平就保持当前候选，不拿绕行比（路线更短）决胜。
 *
 * @returns {boolean} true = a 更优
 */
function isBetter(a, b) {
  if (a.score !== b.score) {
    return a.score > b.score;
  }
  const am = a.metrics;
  const bm = b.metrics;
  const aFeature = am.featureCoverage ?? 1;
  const bFeature = bm.featureCoverage ?? 1;
  if (aFeature !== bFeature) {
    return aFeature > bFeature;
  }
  if (am.orderedOutlineMaxRatio !== bm.orderedOutlineMaxRatio) {
    return am.orderedOutlineMaxRatio < bm.orderedOutlineMaxRatio;
  }
  if (am.orderedOutlineMeanRatio !== bm.orderedOutlineMeanRatio) {
    return am.orderedOutlineMeanRatio < bm.orderedOutlineMeanRatio;
  }
  const aFrechet = am.frechetMaxRatio ?? 0;
  const bFrechet = bm.frechetMaxRatio ?? 0;
  if (aFrechet !== bFrechet) {
    return aFrechet < bFrechet;
  }
  return false;
}

/** 把门槛报告转成"软门槛 key → excess"映射（excess 越小越好，higherIsBetter 门槛已在报告内换算） */
function softExcessByKey(report) {
  const map = new Map();
  for (const gate of report.softGates) {
    map.set(gate.key, gate.excess);
  }
  return map;
}

/** 取门槛报告里的 Fréchet 超出量（>0 即不达标，负数表示还有多少余量） */
function frechetExcessOf(report) {
  return softExcessByKey(report).get(FRECHET_GATE_KEY);
}

/**
 * 联合精修接受规则：trial 是否值得替换当前 best（纯函数，便于单测）。
 *
 * 判定优先级（硬门槛 → 失败软门槛数量 → 同数量定向改善）：
 * 1. trial 有任一硬门槛失败（无路/塌缩/覆盖不全等，局部吸附修不了）→ 拒绝；
 * 2. best 有硬门槛失败而 trial 没有 → 接受（先把"画不出来"救成"画得出来"）；
 * 3. trial 失败的软门槛数量更少 → 接受，更多 → 拒绝；
 * 4. 数量相同且都为 0（都已达标）→ 沿用整图比较器 isBetter
 *    （修正分优先，同分比特征覆盖/有序偏差/Fréchet；几何打平不因路线更短而替换）；
 * 5. 数量相同且 >0 → 只接受"Fréchet excess 严格下降，且其它所有软门槛 excess
 *    都不变差"的定向改善（避免按下葫芦浮起瓢：Fréchet 好一点、有序偏差崩一截）。
 *
 * @param {{metrics: object, score: number}} trial 试验候选（含规划指标与评分）
 * @param {{metrics: object, score: number}} best 当前最优候选
 * @returns {boolean} true = 用 trial 替换 best
 */
export function isRefinementImprovement(trial, best) {
  const trialReport = qualityGateReport(trial?.metrics);
  const bestReport = qualityGateReport(best?.metrics);
  // 1. 硬门槛：试算失败候选（含指标缺失）直接拒绝
  if (trialReport.hardFailures.length > 0) {
    return false;
  }
  // 2. 当前最优仍有硬伤：试算能画出来就是进步
  if (bestReport.hardFailures.length > 0) {
    return true;
  }
  // 3. 失败的软门槛数量变少即接受
  if (trialReport.softCount !== bestReport.softCount) {
    return trialReport.softCount < bestReport.softCount;
  }
  // 4. 都已达标：沿用整图比较器，保证展示分不退化
  if (trialReport.softCount === 0) {
    return isBetter(trial, best);
  }
  // 5. 同样差几道软门槛：只认"Fréchet 严格下降 + 其余门槛不退步"的定向改善
  const trialExcess = softExcessByKey(trialReport);
  const bestExcess = softExcessByKey(bestReport);
  if (!(trialExcess.get(FRECHET_GATE_KEY) < bestExcess.get(FRECHET_GATE_KEY) - SOFT_EXCESS_EPSILON)) {
    return false;
  }
  for (const [key, excess] of trialExcess) {
    if (key === FRECHET_GATE_KEY) {
      continue;
    }
    if (excess > bestExcess.get(key) + SOFT_EXCESS_EPSILON) {
      return false;
    }
  }
  return true;
}

/**
 * 整图联合精修。
 *
 * @param {object} options
 * @param {{nodes: Map, adj: Map}} options.graph 步行路网图
 * @param {{grid: Map, cell: number, edges: Array}} options.edgeIndex 道路线段索引
 * @param {string} [options.shapeKey] 内置图形标识
 * @param {{name: string, constraintPoints: Array, outlinePoints: Array}} [options.customShape] 自定义图形
 * @param {object} options.base 局部精修后的候选（含 result/score/center/sizeMeters/rotationDeg；
 *   允许本身未达标——联合精修把它往"失败门槛更少"的方向拉）
 * @param {number|null} [options.deadline] 整轮截止（performance.now() 口径）
 * @param {number} [options.maxEvaluations] 最多完整评价次数
 * @param {(progress: object) => void} [options.onProgress] 进度回调
 * @returns {Promise<{best: object, evaluated: number, expandedNodes: number, improved: boolean}>}
 *   best 为精修后候选（可能是 base 本身，结构同入参 base 并附 result/metrics）
 */
export async function jointRefine({
  graph,
  edgeIndex,
  shapeKey,
  customShape = null,
  base,
  deadline = null,
  maxEvaluations = DEFAULT_MAX_EVALUATIONS,
  onProgress = undefined,
  signal = null,
}) {
  const model = buildShapeModel({ shapeKey, customShape });
  const center = base.center;
  const sizeMeters = base.sizeMeters;
  const rotationDeg = base.rotationDeg;
  const constraintLatLngs = projectShape(
    model.constraints.map((constraint) => constraint.point),
    center,
    sizeMeters,
    rotationDeg,
  );

  // 1. 预计算每个约束的吸附候选（关键点前 5、普通点前 3）
  const snapCandidates = constraintLatLngs.map(([lat, lng], index) =>
    nearbyEdges(edgeIndex, graph, lng, lat, {
      count: model.constraints[index].key ? KEY_SNAP_CANDIDATES : NORMAL_SNAP_CANDIDATES,
    }),
  );
  if (snapCandidates.some((list) => list.length === 0)) {
    // 有约束找不到任何道路边：无法联合精修，原样返回基线
    return { best: base, evaluated: 0, expandedNodes: 0, improved: false };
  }

  /** 当前吸附选择（每个约束一条边的投影，初始为最近边） */
  let currentSnap = snapCandidates.map((list) => list[0]);
  let evaluated = 0;
  let expandedNodes = 0;
  /** 评价缓存：吸附索引组合 + 档位组合 → 结果 */
  const cache = new Map();

  const budgetExceeded = () =>
    evaluated >= maxEvaluations ||
    (deadline !== null && performance.now() >= deadline) ||
    // 用户点"停止"：联合精修同样立刻中断（需求 R5）
    isAborted(signal);

  /**
   * 用指定吸附/档位组合重算完整路线。
   *
   * @param {Array} snapChoice 每个约束选第几个吸附候选（索引）
   * @param {Array|null} legProfiles 单段档位（按形状腿序号，null 表示默认）
   * @returns {Promise<object|null>} { result, score, metrics, snapChoice, legProfiles }；预算耗尽返回 null
   */
  const evaluate = async (snapChoice, legProfiles = null) => {
    const cacheKey = `${snapChoice.join(',')}#${legProfiles ? JSON.stringify(legProfiles) : ''}`;
    if (cache.has(cacheKey)) {
      return cache.get(cacheKey);
    }
    if (budgetExceeded()) {
      return null;
    }
    const snapOverrides = snapChoice.map((candidateIndex, index) =>
      snapCandidates[index][candidateIndex] || null,
    );
    let result;
    try {
      result = planShapeRoute({
        graph,
        edgeIndex,
        shapeKey,
        customShape,
        center,
        sizeMeters,
        rotationDeg,
        snapOverrides,
        legProfiles,
      });
    } catch {
      evaluated += 1;
      return null;
    }
    evaluated += 1;
    expandedNodes += result.metrics?.searchStats?.expandedNodes || 0;
    const entry = {
      result,
      score: scoreRoute(result.metrics),
      metrics: result.metrics,
      snapChoice: [...snapChoice],
      legProfiles,
    };
    cache.set(cacheKey, entry);
    if (onProgress && evaluated % 10 === 0) {
      onProgress({
        stageLabel: '联合精修',
        done: evaluated,
        total: maxEvaluations,
        score: entry.score,
      });
    }
    // 每 10 次评价让出主线程，避免长时间阻塞页面
    if (evaluated % 10 === 0) {
      await yieldToUi();
    }
    return entry;
  };

  // 2. 基线：全部用最近边重放（与局部精修候选一致）
  const initialChoice = snapCandidates.map(() => 0);
  const baseline = await evaluate(initialChoice, null);
  if (!baseline) {
    return { best: base, evaluated, expandedNodes, improved: false };
  }
  let best = baseline;

  // 3. 约束处理顺序：关键/特征约束优先，其余按轮廓顺序
  const order = model.constraints
    .map((constraint, index) => ({ index, key: Boolean(constraint.key) }))
    .sort((a, b) => (b.key ? 1 : 0) - (a.key ? 1 : 0) || a.index - b.index);

  // 4. 坐标下降：逐约束尝试第 2~K 近吸附，接受整图更优者
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    let improvedThisRound = false;
    for (const { index } of order) {
      if (budgetExceeded()) {
        break;
      }
      const candidateCount = snapCandidates[index].length;
      for (let candidateIndex = 1; candidateIndex < candidateCount; candidateIndex += 1) {
        if (budgetExceeded()) {
          break;
        }
        const trialChoice = [...best.snapChoice];
        trialChoice[index] = candidateIndex;
        const trial = await evaluate(trialChoice, best.legProfiles || null);
        if (!trial) {
          continue;
        }
        if (isRefinementImprovement(trial, best)) {
          best = trial;
          improvedThisRound = true;
          break; // 该约束接受后进入下一个约束
        }
      }
    }
    if (!improvedThisRound) {
      // 5. 吸附无改进：对最差路段尝试引导档位（每次仍重算完整路线）
      const worstLeg = best.metrics?.worstLegIndex;
      if (Number.isInteger(worstLeg) && worstLeg >= 0 && !budgetExceeded()) {
        for (const profile of LEG_PROFILES) {
          if (budgetExceeded()) {
            break;
          }
          const legProfiles = new Array(worstLeg + 1).fill(null);
          legProfiles[worstLeg] = profile;
          const trial = await evaluate(best.snapChoice, legProfiles);
          if (!trial) {
            continue;
          }
          if (isRefinementImprovement(trial, best)) {
            best = trial;
            improvedThisRound = true;
            break;
          }
        }
      }
      if (!improvedThisRound) {
        break;
      }
    }
  }

  const improved = best !== baseline;
  const baselineReport = qualityGateReport(baseline.metrics);
  const finalReport = qualityGateReport(best.metrics);
  log.info('joint.refine.done', {
    shapeName: model.name,
    evaluations: evaluated,
    expandedNodes,
    improved,
    baselineScore: baseline.score,
    finalScore: best.score,
    // 门槛报告：baseline 可能本身就差软门槛，用 softCount/Fréchet excess 定位精修是否真进步
    baselinePasses: baselineReport.passes,
    finalPasses: finalReport.passes,
    baselineHardFailures: baselineReport.hardFailures,
    finalHardFailures: finalReport.hardFailures,
    baselineSoftCount: baselineReport.softCount,
    finalSoftCount: finalReport.softCount,
    baselineFrechetExcess: frechetExcessOf(baselineReport),
    finalFrechetExcess: frechetExcessOf(finalReport),
    changedConstraints: best.snapChoice
      .map((candidateIndex, index) => (candidateIndex !== 0 ? index : -1))
      .filter((index) => index >= 0),
    changedLegs: best.legProfiles
      ? best.legProfiles.map((profile, index) => (profile ? index : -1)).filter((index) => index >= 0)
      : [],
  });

  return { best, evaluated, expandedNodes, improved };
}
