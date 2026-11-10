/**
 * 单轮候选搜索（清理方案 2026-11-09 C3：从 candidates.js 纯移动拆出）。
 *
 * 职责：给定网格/朝向/尺寸档做一轮完整候选搜索，返回原始最高分、达标最优与
 * 近失候选。四级尽力链在 escalation.js，局部精修在 refine-around.js，
 * 多图形推荐在 recommend-shapes.js；candidates.js 保留导出门面兼容既有 import 路径。
 *
 * 评分与质量门槛在 quality.js，选优规则在 selection.js；本模块不改变评分口径。
 * 双重预算（候选数 + 时间）：预算耗尽如实标记 budgetExhausted；
 * 候选循环分片异步（约 12ms 让出一次主线程），长搜索期间页面保持可操作。
 */

import { planShapeRoute } from './planner.js';
import { SHAPES } from './shapes.js';
import { meetsQualityBar, scoreRoute } from './quality.js';
import { comparePassingCandidates, isRefinableNearMiss, adjustedScoreOf } from './selection.js';
import { yieldToUi } from './util/yield.js';
import { createLogger } from '../log/index.js';
import { METERS_PER_DEG_LAT, metersPerDegLng } from './geo.js';
import { isAborted } from '../cancel.js';

/** 模块 logger：候选搜索阶段汇总（逐候选不刷日志，避免几千条记录淹没关键信息） */
const log = createLogger('engine/candidates');

/** 自定义图形（无对称性假设）的默认搜索朝向：15° 一档（-15°~45°）。
 * 直边多边形（五边形/三角/菱形等 LLM 常见产出）的边要贴合路网走向，
 * 30° 一档会让边-路错位最大 15°（500m 边上 ≈130m 偏差，超出走廊被硬过滤）；
 * 15° 一档实测达标候选数约翻倍（五边形 3→8、密集路网区 80→136）。 */
const CUSTOM_SHAPE_ROTATIONS = [345, 0, 15, 30, 45];

/** 尽力链级别定义：近场 → 扩大范围 → 比例尺兜底 → 更大比例尺。
 * 四级都会搜。每一级内部的尺寸、位置、朝向也全部搜完，不因某一格分数够了就停。 */
export const ESCALATION_STAGES = [
  { stage: 1, label: '近场搜索', gridRadius: 3, spacingRatio: 0.5, sizeFactors: [1.5, 1, 0.75] },
  { stage: 2, label: '扩大范围', gridRadius: 3, spacingRatio: 1.4, sizeFactors: [1.7, 1.25, 0.9, 0.6] },
  { stage: 3, label: '比例尺兜底', gridRadius: 3, spacingRatio: 1.4, sizeFactors: [3, 2.5, 2, 0.5] },
  // 7×7 网格、间距随该档尺寸，把 2~7.5× 都实测一遍。
  {
    stage: 4,
    label: '更大比例尺',
    gridRadius: 3,
    spacingRatio: 0.4,
    sizeFactors: [7.5, 6, 4.5],
    alwaysRun: true,
    spacingBySize: true,
  },
];

/** 单档尺寸上限（米）。已加载路网大约 16×14 公里，再大的图形会探出数据范围。 */
const SCALE_SEARCH_MAX_METERS = 10000;

/** 尺寸基准兜底（米）：调用方漏传/传 null 时，尺寸阶梯会整体退化成 0 米。
 * 0 尺寸把图形投影成一个点（全部轮廓点重合），贴合偏差除以 0 得 Infinity、评分恒 0，
 * 四级全搜的每个候选都是废候选——实测 trace t-0wg0g71b5eu0「长颈鹿」：
 * 1960 个候选、路线 0.86 km、路线贴合 0、尺寸 0.0 km，用户看到的就是"没画出来"。
 * 与 agent/intent.js 的 DEFAULT_SIZE_METERS 同值；引擎层不反向依赖编排层。 */
const FALLBACK_BASE_SIZE_METERS = 1200;

/** "够像"评分线：达标候选达到该分即早退（不必再搜更大范围/尺寸）。
 * 60 分的路线实测是肉眼明显歪扭的（用户原话"这一点都不像"）——早退线
 * 提到 70：宁可多搜一级，也不把刚过门槛的候选当"画好了"交付。 */
export const GOOD_ENOUGH_SCORE = 70;

/** 单图形搜索默认预算：候选数硬上限 / 时间硬上限（毫秒）。
 * 候选数上限是主要约束。五角星四级全量：7×7 位置 × 5 朝向 × 14 个尺寸档 = 3430，
 * 再加局部精修。时间上限盖住慢机器，避免同样的输入有时搜完、有时被掐断。 */
export const SINGLE_SEARCH_MAX_CANDIDATES = 5000;
export const SINGLE_SEARCH_TIME_BUDGET_MS = 180000;

/** 细节特征在路网上可表达的最小尺度（米）：真实街道间距约 100~300m，
 * 特征宽度（腿间隙/耳宽）低于该值时会被路网抹掉。尺寸反推据此给出下限：
 * sizeMeters ≥ MIN_FEATURE_METERS / featureMinWidthRatio。
 * 取 200m：实测马腿间隙（归一化 0.06~0.15）反推 1300~3300m，落在尺寸阶梯内；
 * 取 260m 会把多数动物剪影顶到 4000m+（超出阶梯上限、里程失控）。 */
export const MIN_FEATURE_METERS = 150;

/** 分片粒度：每约 12ms 让出一次主线程，进度文案有机会渲染 */
const SLICE_MS = 12;

/** 近场（第一级）尺寸阶梯的最大倍率：禁止放大（allowEnlarge=false）时，
 * 局部精修尺寸不得越过该档。与 ESCALATION_STAGES[0] 联动，避免两处数字漂移。 */
export const NEAR_FIELD_MAX_SIZE_FACTOR = ESCALATION_STAGES[0].sizeFactors[0];

/** 单候选局部精修的候选数（3×3 位置 × 5 朝向 = 45）：预算预留按它检查，
 * 避免进入精修后撑爆候选数上限。 */
export const REFINE_CANDIDATES_PER_CANDIDATE = 45;


/**
 * 单轮候选搜索（分片异步）：给定网格/朝向/尺寸档，返回原始最高分与达标最高分。
 *
 * 同时记录三种最优，避免相互遮蔽：
 * - best：原始分最高（诊断用，失败时说明"最接近的候选差多少"）；
 * - bestPassing：达标候选里"近且像"最优（交付用，调整分优先）；
 * - bestNearMiss：不达标但只差一道软门槛的近失候选（全失败时交给联合精修一搏）。
 *
 * @param {object} options
 * @param {{nodes: Map, adj: Map}} options.graph 步行路网图
 * @param {{grid: Map, cell: number, edges: Array}} options.edgeIndex 道路线段索引
 * @param {string} [options.shapeKey] 内置图形标识
 * @param {{name: string, constraintPoints: Array, outlinePoints: Array}} [options.customShape]
 * @param {{lat: number, lng: number}} options.center 搜索中心
 * @param {number} options.baseSizeMeters 基准图形尺寸（米）
 * @param {number[]} [options.rotations] 朝向集合，缺省取图形自带搜索集
 * @param {number[]} [options.sizeFactors] 尺寸倍率档
 * @param {number} [options.gridRadius] 位置网格半径（2=5×5，3=7×7）
 * @param {number} [options.spacingRatio] 候选间距相对基准尺寸的比例
 * @param {(progress: object) => void} [options.onProgress] 进度回调
 * @param {number|null} [options.deadline] 时间预算截止（performance.now() 口径），null 不限
 * @param {number|null} [options.maxCandidates] 候选数硬上限（null 不限），超限即停
 * @param {object|null} [options.constraintContract] 显式约束契约（方案 2026-11-08 §3.2）：
 *   显式尺寸只生成"允许的尺寸集合"（请求尺寸本身），显式朝向只搜允许朝向——
 *   尺寸阶梯的其它档位**不得**混进来（"800 米的心形交付 6000 米"就是这么来的）
 * @returns {Promise<{best: object|null, bestPassing: object|null, topPassing: Array, topScorePassing: Array, bestNearMiss: object|null, candidateCount: number, budgetExhausted: boolean, expandedNodes: number}>}
 */
export async function searchBestCandidate({
  graph,
  edgeIndex,
  shapeKey,
  customShape = null,
  center,
  baseSizeMeters,
  rotations,
  sizeFactors = [0.75, 1, 1.5],
  gridRadius = 3,
  spacingRatio = 0.8,
  onProgress,
  deadline = null,
  maxCandidates = null,
  signal = null,
  spacingBySize = false,
  constraintContract = null,
}) {
  const shape = customShape || SHAPES[shapeKey];
  if (!shape) {
    throw new Error(`未知图形：${shapeKey}`);
  }
  // 尺寸基准必须是正的有限数：编排层的自定义点列恢复路径曾把 sizeMeters=null 传进来，
  // 乘尺寸倍率后得到 0 尺寸候选（见 FALLBACK_BASE_SIZE_METERS 注释）。缺省/非法值
  // 一律按默认基准算，绝不让"0 米图形"进入搜索。
  const effectiveBaseSizeMeters =
    Number.isFinite(baseSizeMeters) && baseSizeMeters > 0 ? baseSizeMeters : FALLBACK_BASE_SIZE_METERS;
  // 朝向集合（方案 2026-11-08 §3.2）：显式朝向只搜允许朝向，不掺入默认朝向集合。
  // 契约优先级高于调用方传入的 rotations——契约来自用户原文，是硬要求。
  const rotationSet = constraintContract?.rotation?.explicit
    ? [constraintContract.rotation.requestedDeg]
    : rotations && rotations.length
      ? rotations
      : customShape
        ? CUSTOM_SHAPE_ROTATIONS
        : shape.searchRotations;
  const latRad = (center.lat * Math.PI) / 180;
  const dLatPerM = 1 / METERS_PER_DEG_LAT;
  const dLonPerM = 1 / (METERS_PER_DEG_LAT * Math.cos(latRad));

  // 细节反推尺寸：特征宽度（归一化）× sizeMeters ≥ MIN_FEATURE_METERS 才能被
  // 路网表达出来。低于该下限的尺寸档直接跳过。
  // 兜底：若反推下限比所有档位都大（特征特别细，如人形手指 0.034 → 4377m），
  // 不能只留 1 个最大档——那样尺寸维度消失、搜索空间骤减；改为保留最大的 2 个
  // 档位，由评分/特征覆盖率如实反映"细节画不出来"。
  // identity 浅凹不参与起搜尺寸反推（方案 3.3 / 5.2）：只看 notch 与 gap。
  const featureMinWidthRatio = (customShape?.features || []).reduce(
    (min, feature) =>
      (feature.kind === 'notch' || feature.kind === 'gap') &&
      feature.widthRatio > 0 &&
      feature.widthRatio < min
        ? feature.widthRatio
        : min,
    Number.POSITIVE_INFINITY,
  );
  const requiredMinSizeMeters = Number.isFinite(featureMinWidthRatio)
    ? MIN_FEATURE_METERS / featureMinWidthRatio
    : 0;
  const allSizes = sizeFactors.map((factor) => Math.round(effectiveBaseSizeMeters * factor));
  const effectiveSizes = allSizes.filter((sizeMeters) => sizeMeters >= requiredMinSizeMeters);
  // 显式尺寸约束（方案 2026-11-08 §3.2）：用户显式给了尺寸时，只生成"允许的尺寸集合"
  // ——即请求尺寸本身。尺寸阶梯的其它档位**不得**混进来："800 米的心形"交付 6000 米
  // 正是这个缺口造成的（粗搜 1.5/1/0.75…7.5× 全部试过，挑了分高的）。
  //
  // 特征反推下限（requiredMinSizeMeters）**不**用于剔除显式尺寸：尺寸太小画不出细节时，
  // 正确结论是"这个尺寸下没有合格候选"（诚实失败/诊断参考），而不是偷偷换成更大的尺寸。
  const sizesToTry = (
    constraintContract?.size?.explicit
      ? [constraintContract.size.requestedMeters]
      : effectiveSizes.length > 0
        ? effectiveSizes
        : [...allSizes].sort((a, b) => b - a).slice(0, Math.min(2, allSizes.length))
  ).filter(
    (sizeMeters) =>
      Number.isFinite(sizeMeters) && sizeMeters > 0 && sizeMeters <= SCALE_SEARCH_MAX_METERS,
  );
  const total = (gridRadius * 2 + 1) ** 2 * rotationSet.length * sizesToTry.length;

  let best = null;
  let bestPassing = null;
  /** 本轮分数 top 3 达标候选（缺陷清单 Bug 3：入池用，防高分候选被 RMS 截断） */
  let topScorePassing = [];
  /** 本轮达标候选 top 3（供多候选精修：调整分排序后仍保留 3 个，精修潜力大的不被直接淘汰） */
  const topPassing = [];
  /** 本轮最佳"近失候选"（只差一道软门槛、评分够高，失败前可交给联合精修一搏） */
  let bestNearMiss = null;
  let done = 0;
  let failedCount = 0;
  let budgetExhausted = false;
  /** 是否被用户"停止"中断（与预算耗尽区分：中断不产出任何交付） */
  let aborted = false;
  let lastYield = performance.now();
  /** 本轮累计 A* 扩展节点数（工作量预算：复杂图形段数多，单候选成本会放大） */
  let expandedNodes = 0;

  // 位置网格按"离请求中心由近到远"排序（中心 → 一圈 → 外圈）：
  // 行优先从角落扫起会把 2km 外的候选排在中心之前，早退时交付远处的
  // 勉强达标候选（实测五角星选中 2.1km 外 60 分候选的教训）。
  // 稳定排序保证同环内顺序确定，同分时先试的（更近的）候选胜出。
  const offsets = [];
  for (let dx = -gridRadius; dx <= gridRadius; dx += 1) {
    for (let dy = -gridRadius; dy <= gridRadius; dy += 1) {
      offsets.push([dx, dy]);
    }
  }
  offsets.sort((a, b) => a[0] ** 2 + a[1] ** 2 - (b[0] ** 2 + b[1] ** 2));

  outer: for (const sizeMeters of sizesToTry) {
    const spacing = spacingBySize
      ? sizeMeters * spacingRatio
      : effectiveBaseSizeMeters * spacingRatio;
    for (const [dx, dy] of offsets) {
      const candidateCenter = {
        lat: center.lat + dy * spacing * dLatPerM,
        lng: center.lng + dx * spacing * dLonPerM,
      };
      for (const rotationDeg of rotationSet) {
        try {
          const result = planShapeRoute({
            graph,
            edgeIndex,
            shapeKey,
            customShape,
            center: candidateCenter,
            sizeMeters,
            rotationDeg,
          });
          const score = scoreRoute(result.metrics);
          const adjustedScore = adjustedScoreOf(score, candidateCenter, center);
          expandedNodes += result.metrics?.searchStats?.expandedNodes || 0;
          const candidate = {
            result,
            score,
            adjustedScore,
            center: candidateCenter,
            sizeMeters,
            rotationDeg,
          };
          if (!best || score > best.score) {
            best = candidate;
          }
          // 达标候选选优：近且像优先（调整分 → 原始分 → 尺寸），比较器见 selection.js
          if (meetsQualityBar(result.metrics)) {
            if (!bestPassing || comparePassingCandidates(candidate, bestPassing) < 0) {
              bestPassing = candidate;
            }
            // 保留本轮 top 3 达标候选（多候选精修用）：按近且像排序，调整分靠前优先
            topPassing.push(candidate);
            topPassing.sort(comparePassingCandidates);
            if (topPassing.length > 3) {
              topPassing.pop();
            }
            // 缺陷清单 Bug 3（2026-11-07 复核补充）：另存分数 top 3——此前建池只留
            // RMS top3，"分数明显更高但 RMS 略差"的候选进不了达标池，最终分档选优
            // 根本看不到它们。与 topPassing 取并集入池（内存有界：每级 ≤ ~7 个）
            topScorePassing.push(candidate);
            topScorePassing.sort((a, b) => b.score - a.score);
            if (topScorePassing.length > 3) {
              topScorePassing.pop();
            }
          } else if (isRefinableNearMiss(candidate)) {
            // 不达标但只差一道软门槛：记为近失候选，全部失败时供联合精修一搏
            if (!bestNearMiss || comparePassingCandidates(candidate, bestNearMiss) < 0) {
              bestNearMiss = candidate;
            }
          }
        } catch {
          // 候选中心落在无路区等情况属搜索常态，计数即可，不逐条刷日志
          failedCount += 1;
        }
        done += 1;
        if (onProgress) {
          onProgress({ done, total, sizeMeters, rotationDeg });
        }
        // 同一尺寸档不因分数够了就停：位置和朝向都要搜完，再按均方根留最好的。
        // 预算检查（候选数 + 扩展节点工作量 + 时间，任一超限即停）
        if (maxCandidates !== null && done >= maxCandidates) {
          budgetExhausted = true;
          break outer;
        }
        if (deadline !== null && performance.now() >= deadline) {
          budgetExhausted = true;
          break outer;
        }
        // 用户点"停止"：立刻跳出搜索（需求 R5：图形搜索也要真正停下来）
        if (isAborted(signal)) {
          aborted = true;
          break outer;
        }
        // 分片让出主线程
        if (performance.now() - lastYield >= SLICE_MS) {
          await yieldToUi();
          lastYield = performance.now();
        }
      }
    }
  }
  if (failedCount > 0) {
    log.info('candidates.round', {
      done,
      total,
      failed: failedCount,
      skipped: total - done,
      bestScore: best?.score ?? null,
      bestPassingScore: bestPassing?.score ?? null,
      bestPassingAdjusted: bestPassing?.adjustedScore ?? null,
      bestNearMissScore: bestNearMiss?.score ?? null,
      bestNearMissAdjusted: bestNearMiss?.adjustedScore ?? null,
      budgetExhausted,
      aborted,
    });
  }
  return {
    best,
    bestPassing,
    topPassing,
    topScorePassing,
    bestNearMiss,
    candidateCount: done,
    budgetExhausted,
    aborted,
    expandedNodes,
  };
}

