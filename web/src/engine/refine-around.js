/**
 * 局部精修（清理方案 2026-11-09 C3：从 candidates.js 纯移动拆出，行为零变化）。
 *
 * 粗搜的三层格点都很粗——位置步长 = 基准×0.5（600m 级）、朝向 15° 一档、
 * 尺寸 25~50% 一档——最好的摆法往往落在格点之间。精修以选定候选为中心：
 * 位置 ±1 步（步长 = 尺寸×0.18，3×3）、朝向 ±10°（5° 一档，5 档）、尺寸保持不变，
 * 共 45 个候选，按"近且像"选最优；不比原候选更优就不换。
 */

import { planShapeRoute } from './planner.js';
import { meetsQualityBar, scoreRoute } from './quality.js';
import { comparePassingCandidates, adjustedScoreOf } from './selection.js';
import { yieldToUi } from './util/yield.js';
import { METERS_PER_DEG_LAT, metersPerDegLng } from './geo.js';
import { isAborted } from '../cancel.js';
import { sizeSatisfiesConstraint } from './constraint-contract.js';

/** 分片粒度：每约 12ms 让出一次主线程（与 candidate-search.js 同口径，独立定义避免循环依赖） */
const SLICE_MS = 12;

/** 精修位置步长相对候选尺寸的比例（与粗搜步长错开，补到格点之间的摆法）。 */
const REFINE_SPACING_RATIO = 0.18;

/**
 * 局部精修：在已选定候选周围用细格点再搜一轮（位置 × 朝向 × 尺寸）。
 *
 * 粗搜的三层格点都很粗——位置步长 = 基准×0.5（600m 级）、朝向 15° 一档、
 * 尺寸 25~50% 一档——最好的摆法往往落在格点之间。精修以选定候选为中心：
 * 位置 ±1 步（步长 = 尺寸×0.18，3×3）、朝向 ±10°（5° 一档，5 档）、尺寸保持不变，
 * 共 45 个候选，按均方根选最优；不比原候选更优就不换。
 *
 * @param {object} options
 * @param {{nodes: Map, adj: Map}} options.graph 步行路网图
 * @param {{grid: Map, cell: number, edges: Array}} options.edgeIndex 道路线段索引
 * @param {string} [options.shapeKey] 内置图形标识
 * @param {{name: string, constraintPoints: Array, outlinePoints: Array}} [options.customShape]
 * @param {object} options.base 选定候选（含 center/sizeMeters/rotationDeg/adjustedScore）
 * @param {{lat: number, lng: number}} options.origin 请求中心（偏移惩罚基准）
 * @param {number|null} [options.maxSizeMeters] 精修尺寸硬上限（米）：禁止放大
 *   （allowEnlarge: false）时不得越过近场最大档（1.5 × 基准尺寸），null 不限
 * @param {number|null} [options.deadline] 整轮截止（与粗搜共享），null 不限
 * @param {(progress: object) => void} [options.onProgress] 进度回调
 * @param {object|null} [options.constraintContract] 显式约束契约（方案 2026-11-08 §3.2）：
 *   显式朝向时精修**不得**再做 ±10° 扰动（历史缺陷：粗搜 90°、精修后交付 100°）
 * @returns {Promise<{best: object, candidateCount: number, expandedNodes: number}>}
 *   精修后最优候选（可能是原候选）、实试数与扩展节点数
 */
export async function refineAround({
  graph,
  edgeIndex,
  shapeKey,
  customShape,
  base,
  origin,
  maxSizeMeters = null,
  deadline = null,
  onProgress = undefined,
  signal = null,
  constraintContract = null,
}) {
  // 朝向集合：显式朝向时只保留基线朝向（方案 2026-11-08 §3.2）——
  // 精修的 ±10° 扰动会把用户明确要求的 90° 改成 100°，属于静默违约。
  const rotations = constraintContract?.rotation?.explicit
    ? [base.rotationDeg]
    : [-10, -5, 0, 5, 10].map((d) => (base.rotationDeg + d + 360) % 360);
  // 尺寸：精修只在阶梯里选（factors 恒为 1），不再用 ±8% 把 9000 米推到 9720 米；
  // 显式尺寸时基线尺寸已由粗搜锁定在请求值，精修不得改写（方案 2026-11-08 §3.2）。
  // 禁止放大时把越过近场上限的尺寸档整档剔除（含该档的全部位置×朝向组合）：
  // 精修的 1.08 倍会把 1800m 基准顶到 1944m（实测三角形路线最大偏差 162m 反超近场），
  // 交付尺寸上限由粗搜阶梯约束，精修不得变相放大。
  const factors = [1];
  const spacing = base.sizeMeters * REFINE_SPACING_RATIO;
  const dLatPerM = 1 / METERS_PER_DEG_LAT;
  const dLngPerM = 1 / metersPerDegLng(base.center.lat);
  const total = factors.length * 9 * rotations.length;

  let best = base;
  let done = 0;
  let expandedNodes = 0;
  let lastYield = performance.now();
  let stopped = false;
  // 基线候选本身违反显式约束时不做精修：精修不改变尺寸/朝向，
  // 精修出来的仍是不合规候选（方案 2026-11-08 §3.2"约束贯穿所有可能改变结果的阶段"）。
  if (!sizeSatisfiesConstraint(base.sizeMeters, constraintContract)) {
    return { best: base, candidateCount: 0, expandedNodes: 0 };
  }
  for (const factor of factors) {
    const sizeMeters = Math.round(base.sizeMeters * factor);
    for (let dx = -1; dx <= 1 && !stopped; dx += 1) {
      for (let dy = -1; dy <= 1 && !stopped; dy += 1) {
        const candidateCenter = {
          lat: base.center.lat + dy * spacing * dLatPerM,
          lng: base.center.lng + dx * spacing * dLngPerM,
        };
        for (const rotationDeg of rotations) {
          done += 1;
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
            expandedNodes += result.metrics?.searchStats?.expandedNodes || 0;
            const score = scoreRoute(result.metrics);
            if (meetsQualityBar(result.metrics)) {
              const adjustedScore = adjustedScoreOf(score, candidateCenter, origin);
              // 精修同样"近且像优先"：与当前最优走同一比较器（调整分 → 原始分 → 尺寸），
              // 更靠近请求中心且仍达标的摆法可以替换"稍远但分略高"的原候选
              const candidate = {
                result,
                score,
                adjustedScore,
                center: candidateCenter,
                sizeMeters,
                rotationDeg,
              };
              if (comparePassingCandidates(candidate, best) < 0) {
                best = candidate;
              }
            }
          } catch {
            // 精修落点偶发无路属常态，跳过
          }
          if (onProgress) {
            onProgress({ done, total, sizeMeters, rotationDeg, stageLabel: '局部精修' });
          }
          // 与粗搜共享截止与工作量预算：精修是搜索的一部分，不能无限拖住页面
          if (deadline !== null && performance.now() >= deadline) {
            stopped = true;
            break;
          }
          // 用户点"停止"：精修同样立刻中断
          if (isAborted(signal)) {
            stopped = true;
            break;
          }
          // 分片让出主线程，避免 135 个候选连续执行造成页面无响应
          if (performance.now() - lastYield >= SLICE_MS) {
            await yieldToUi();
            lastYield = performance.now();
          }
        }
      }
    }
    if (stopped) {
      break;
    }
  }
  return { best, candidateCount: done, expandedNodes };
}
