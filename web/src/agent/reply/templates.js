/**
 * 回复文案与摘要模板（清理方案 2026-11-09 §5.4-3.1.1：从 controller.js 抽出；
 * B2 再合并内部四对双份：指标行、失败回复、参考版回复、切换回复）。
 *
 * 这里只有"拼字符串"和"读指标"，没有编排副作用（不调用 LLM、不画线、不写历史）；
 * 需要的上下文（时长格式化、备选版本挑选、推荐图形列表）由工厂入参显式传入，
 * 因此本模块可独立测试，也不再让 controller.js 的闭包无限膨胀。
 */

import { distanceMeters } from '../../engine/graph.js';
import {
  DELIVERABLE_SCORE,
  QUALITY_ASPECT_DISTORTION,
  QUALITY_FEATURE_COVERAGE,
  QUALITY_FEATURE_GAP_RETAIN,
  QUALITY_FRECHET_MAX_RATIO,
  QUALITY_ORDERED_ROUTE_MAX_RATIO,
} from '../../engine/quality.js';
import { describeConstraintViolations } from '../../engine/constraint-contract.js';
import { describeShapeSpec } from '../shape-spec.js';
import { nearestPoi } from '../places.js';
import {
  composeOffsetNotice,
  describeNearFieldFailure,
  pickNearRepresentative,
} from '../offset-reason.js';

/**
 * 创建回复文案模板集合。
 *
 * @param {object} deps 依赖
 * @param {{formatMinutes: (minutes: number) => string}} deps.engine 引擎（只用 formatMinutes）
 * @param {(bests: Array, current: object|null) => object|null} deps.pickPromisedAlternative 承诺备选版本挑选
 * @param {Array<string>} deps.recommendShapeKeys 推荐链路的内置图形列表
 * @param {() => object} deps.getCity 取当前城市配置（**取值函数**：城市可切换，不能快照）
 * @returns {object} 各文案函数
 */
export function createReplyTemplates({ engine, pickPromisedAlternative, recommendShapeKeys, getCity }) {
  /** 失败结果的 reason 读取（plan/recommend 返回结构不同，统一取法） */
  function escalationLikeReason(outcome) {
    return outcome?.reason || null;
  }
  /** 示例问法（取自地点配置；无配置时给通用图形示例，不写死地名） */
  function exampleHint() {
    return getCity().examples?.[0] || '画个五角星';
  }
  /** 诊断"画不出来"的原因（供失败/偏移说明用） */
  function diagnoseReason(metrics) {
    if (!metrics) {
      return '附近路网不完整';
    }
    if (metrics.snapMaxMeters > 120) {
      return '图形部分区域落在水面或无路区（比如跨江），无路可走';
    }
    return '这一带路网形状与图形差太多，硬画出来会不像';
  }
  /** 搜索范围的通俗描述（失败时让用户看到"范围/朝向/比例尺都试过了"） */
  function triedScopeText(stage, count) {
    const stages = ['近场', '扩大范围', '放大尺寸', '更大比例尺'].slice(0, Math.max(1, stage)).join(' → ');
    const sizeRange = stage >= 4 ? '0.5~7.5 倍' : stage >= 3 ? '0.5~3 倍' : stage >= 2 ? '0.6~1.7 倍' : '0.75~1.5 倍';
    return `${stages}，位置由近到远 × 多朝向 × 尺寸 ${sizeRange}多档，共 ${count} 个候选`;
  }
  /** 回复开头（LLM 开场白 + 地点说明）：7 个 compose* 共用同一口径，避免手写漂移 */
  function replyHead(intent, placeNote, suppressIntentReply = false) {
    const lines = [];
    // LLM 开场白只在没有对象不一致时原样带出（方案 2026-11-05 §4.3）：
    // 它可能承诺未交付的对象，交付与回复必须一致。
    if (intent.reply && !suppressIntentReply) {
      lines.push(intent.reply);
    }
    if (placeNote) {
      lines.push(placeNote);
    }
    return lines;
  }
  /** 有序分段贴合文本：展示与评分使用同一套有序指标（第 N 段只与第 N 段比），避免
   * "评分用有序、回复用全局"两套口径；全局指标在多部分图形上含跨部分假边，仅供日志诊断。
   * 指标缺失时返回空串（不编造 NaN），由调用方省略该段。 */
  function fidelityTextOf(metrics) {
    if (!Number.isFinite(metrics?.orderedOutlineMeanMeters)) {
      return '';
    }
    return `贴合 平均 ${Math.round(metrics.orderedOutlineMeanMeters)} m / 最大 ${Math.round(metrics.orderedOutlineMaxMeters)} m`;
  }
  /** 关键特征覆盖文本（featureCount=0 时返回空串：无特征检查就不编造"走出 0 个"） */
  function featureCoverageText(metrics) {
    return metrics.featureCount > 0
      ? `关键特征 ${metrics.featureCoveredCount}/${metrics.featureCount} 走出`
      : '';
  }
  /**
   * 单条路线的指标文本（plan/recommend/参考版回复共用同一数字口径）。
   * @param {object} result 候选结果（含 metrics）
   * @param {string} [extra] 插在贴合指标之后的附加段（自带 " · " 前缀）
   */
  function metricsText(result, extra = '') {
    const metrics = result.metrics;
    const km = (metrics.routeMeters / 1000).toFixed(2);
    const duration = engine.formatMinutes(metrics.walkMinutes);
    const fidelityText = fidelityTextOf(metrics);
    const detour = metrics.detourRatio.toFixed(2);
    const coverage =
      metrics.coverage >= 100 ? '覆盖全部顶点' : `覆盖 ${metrics.coverage.toFixed(0)}% 顶点`;
    const reachable = metrics.failedLegs === 0 ? '全程可走' : `${metrics.failedLegs} 段不可达`;
    return `${km} km · 约 ${duration}${fidelityText ? ` · ${fidelityText}` : ''}${extra} · 绕行 ${detour}× · ${coverage} · ${reachable}`;
  }
  /** 覆盖中心来源不能说成"您指定的地方/这一带"：它就是已加载路网的覆盖中心 */
  function placeSubjectOf(placeText, placeSource) {
    return placeSource === 'coverage-center' ? '按已加载路网的覆盖中心' : placeText;
  }
  /** "画不出来"的诊断句（失败/推荐失败共用；无候选时用调用方给的兜底说明） */
  function diagnosisOf(best, emptyText = '附近几乎没有可步行道路') {
    if (!best) {
      return emptyText;
    }
    const bestMean = best.result.metrics.outlineMeanMeters;
    return Number.isFinite(bestMean)
      ? `最接近的候选平均偏差仍有 ${Math.round(bestMean)} m（不像）`
      : '最近的候选顶点就落在无路区，连贴上路都做不到';
  }
  /** 各图形最优候选里评分最高者（推荐失败时取它做诊断） */
  function bestByScore(bests) {
    let bestAny = null;
    for (const candidate of Object.values(bests || {})) {
      if (candidate && (!bestAny || candidate.score > bestAny.score)) {
        bestAny = candidate;
      }
    }
    return bestAny;
  }
  /** 参考版/诊断版的指标句（橙色虚线非合格；带特征时把特征段插在贴合之前） */
  function referenceMetricsText(candidate, { featureText = '' } = {}) {
    const metrics = candidate.result.metrics;
    const km = (metrics.routeMeters / 1000).toFixed(2);
    const duration = engine.formatMinutes(metrics.walkMinutes);
    return `${km} km · 约 ${duration} · ${featureText ? `${featureText} · ` : ''}路线贴合 ${candidate.score}` +
      ` · 尺寸 ${(candidate.sizeMeters / 1000).toFixed(1)} km · 朝向 ${candidate.rotationDeg}°`;
  }
  /** 切换后中心偏移说明（超过阈值才写，避免静默换位置） */
  function centerOffsetNote(movedMeters, threshold) {
    return Number.isFinite(movedMeters) && movedMeters > threshold
      ? `（中心距上一版约 ${(movedMeters / 1000).toFixed(1)} km）`
      : '';
  }
  /** 切换回复的指标句（比例尺/备选切换共用：与交付回复同一指标口径） */
  function switchSummaryText(candidate, { fidelityText = '', positionNote = '' } = {}) {
    const metrics = candidate.result.metrics;
    const km = (metrics.routeMeters / 1000).toFixed(2);
    const duration = engine.formatMinutes(metrics.walkMinutes);
    return `${km} km · 约 ${duration}${fidelityText ? ` · ${fidelityText}` : ''} · 路线贴合 ${candidate.score}${positionNote}。`;
  }
  /** 拼接"画不出来"的诚实回复（附尝试记录与建议；placeNote 必须带上——
   * 地点解析失败回退视野中心时不说清楚，用户会以为是在他要的地方失败的） */
  function composeFailureReply({ intent, escalation, placeText, placeNote, placeSource }) {
    const lines = replyHead(intent, placeNote);
    const shapeName = shapeNameOf(intent) || '心形';
    const placeSubject = placeSubjectOf(placeText, placeSource);
    // 覆盖预检拦截：中心超出路网数据范围（数据只覆盖当前城市核心区）——
    // 直接说清"没数据"，不谈"像不像"（正方形在任何有路的城区都画得出）
    if (escalation.reason === 'outside-coverage') {
      lines.push(
        `${placeText === '当前视野这一带' ? '当前地图位置' : `「${intent.place}」`}超出了我的路网数据范围（目前只覆盖${getCity().coverage.description}），那里我确实无路可规划。换${getCity().coverage.hint}的地点就行。`,
      );
      return lines.join('\n');
    }
    const tried = triedScopeText(escalation.stage, escalation.triedCount);
    const diagnosis = diagnosisOf(
      escalation.best,
      '附近几乎没有可步行道路（可能超出路网数据覆盖或落在无路区）',
    );
    // 图像描摹目标：目标验收已通过、只是路网贴不出这条外轮廓——必须写"路网贴不出"，
    // 不得写成"描摹失败"/"抽不出轮廓"（方案 2026-11-01 §3 两件事分开）
    if (intent.customShape?.source === 'traced') {
      lines.push(
        `${placeSubject}路网贴不出这条外轮廓：${diagnoseReason(
          escalation.best ? escalation.best.result.metrics : null,
        )}。我已尽力尝试（${tried}），${diagnosis}，所以没有画——画出来也不会像。`,
      );
    } else {
      lines.push(
        `${placeSubject}画不出像样的「${shapeName}」：${diagnoseReason(
          escalation.best ? escalation.best.result.metrics : null,
        )}。我已尽力尝试（${tried}），${diagnosis}，所以没有画——画出来也不会像。`,
      );
    }
    lines.push('建议：换个地点（路网方正的商圈更容易）、换个图形（矩形/五角星更贴合街道）、或直接指定更大的尺寸（如"画个 2 公里的心形"）。');
    return lines.join('\n');
  }
  /** 失败/不达标原因简述（参考版回复用：让用户知道差在哪） */
  function describeShortfall(candidate) {
    const metrics = candidate.result.metrics;
    const reasons = [];
    if (candidate.score < DELIVERABLE_SCORE) {
      reasons.push(`路线贴合 ${candidate.score} 低于交付线 ${DELIVERABLE_SCORE}`);
    }
    if ((metrics.featureCoverage ?? 1) < QUALITY_FEATURE_COVERAGE) {
      reasons.push(`关键特征只走出 ${metrics.featureCoveredCount}/${metrics.featureCount}`);
    }
    if (
      Number.isFinite(metrics.frechetMaxRatio) &&
      metrics.frechetMaxRatio > QUALITY_FRECHET_MAX_RATIO
    ) {
      reasons.push(
        `保序偏差 ${(metrics.frechetMaxRatio * 100).toFixed(1)}% 超过 ${(QUALITY_FRECHET_MAX_RATIO * 100).toFixed(0)}%`,
      );
    }
    if (
      Number.isFinite(metrics.orderedRouteMaxRatio) &&
      metrics.orderedRouteMaxRatio > QUALITY_ORDERED_ROUTE_MAX_RATIO
    ) {
      reasons.push(
        `局部偏差 ${(metrics.orderedRouteMaxRatio * 100).toFixed(1)}% 超过 ${(QUALITY_ORDERED_ROUTE_MAX_RATIO * 100).toFixed(1)}%`,
      );
    }
    if ((metrics.aspectDistortionRatio ?? 0) > QUALITY_ASPECT_DISTORTION) {
      reasons.push('整体比例失真');
    }
    if (
      Number.isFinite(metrics.featureGapRetainRatio) &&
      metrics.featureGapRetainRatio < QUALITY_FEATURE_GAP_RETAIN
    ) {
      reasons.push('腿间隙被路线跨过');
    }
    if (reasons.length === 0) {
      reasons.push('质量门槛未通过');
    }
    return reasons.join('、');
  }
  /**
   * 拼接"非合格参考版"回复：用户要求"画不出来时给最像的一版，标注非合格供参考"。
   * 必须明确：橙色虚线不是达标交付，仅供参考、不建议照走。
   */
  function composeReferenceReply({ intent, placeNote, candidate, reason }) {
    const metrics = candidate.result.metrics;
    const lines = replyHead(intent, placeNote);
    const featureText = featureCoverageText(metrics) || '无特征检查';
    // 图像描摹目标：目标验收已通过、只是这一带路网贴不出这条外轮廓（不得写成描摹失败）
    if (intent.customShape?.source === 'traced') {
      lines.push(`这一带的路网贴不出这条外轮廓：${reason}。`);
    } else {
      lines.push(`这一带画不出达标的「${candidate.result.shapeName}」路线：${reason}。`);
    }
    lines.push(
      `给你一版最接近的参考（地图上橙色虚线，非合格）：${referenceMetricsText(candidate, { featureText })}。`,
    );
    lines.push(
      '这版仅供参考，不建议按它走；换地点（路网方正的商圈）、换尺寸或换个图形可能更好。',
    );
    return lines.join('\n');
  }
  /**
   * 拼接"约束不符"的降级回复（方案 2026-11-08 §3.3）：
   * 最终产物违反了用户明确提出的尺寸/朝向 → 不得绿线交付。
   * 这里给橙色诊断参考，并**明确写出差异**（请求 vs 实际），
   * 只有用户确认后才允许改变约束并正式交付。
   */
  function composeConstraintViolationReply({
    intent,
    placeNote,
    placeText,
    candidate,
    compliance,
    contract,
  }) {
    const lines = replyHead(intent, placeNote);
    const requested = [];
    if (contract?.size?.explicit) {
      requested.push(`尺寸 ${contract.size.requestedMeters} 米`);
    }
    if (contract?.rotation?.explicit) {
      requested.push(`朝向 ${contract.rotation.requestedDeg}°`);
    }
    const actual = [];
    if (Number.isFinite(candidate?.sizeMeters)) {
      actual.push(`尺寸 ${Math.round(candidate.sizeMeters)} 米`);
    }
    if (Number.isFinite(candidate?.rotationDeg)) {
      actual.push(`朝向 ${Math.round(candidate.rotationDeg)}°`);
    }
    lines.push(
      `你要的是${requested.join('、') || '明确的要求'}，但这一带按同样要求只能做出${actual.join('、') || '不符合要求的版本'}——` +
        `${describeConstraintViolations(compliance.violations)}。`,
    );
    lines.push(
      `地图上这版是橙色虚线（非合格参考）：路线贴合 ${candidate?.score ?? '—'} 分 · ${actual.join(' · ')}。`,
    );
    lines.push(
      '我没有擅自改你的要求。要么换个地点在同样要求下重画，要么你确认改用这个尺寸/朝向我再正式画一条。',
    );
    return lines.join('\n');
  }
  function composeReply({ intent, result, best, placeNote, placeSource, nearBest, offset, areaName, stage, alternatives = [], suppressIntentReply = false, refined = false, scaleCardCount = 0 }) {
    const metrics = result.metrics;
    const lines = replyHead(intent, placeNote, suppressIntentReply);
    // 偏移明说：指定地点画不出来，扩大范围后画在别处——绝不假装在原地成功。
    // 原因必须用近场（第一级）候选的证据，不得拿最终远处候选的 metrics 解释近场失败。
    if (offset && offset.meters > 800) {
      const reason = describeNearFieldFailure(nearBest);
      lines.push(
        composeOffsetNotice({
          kind: 'plan',
          reason,
          placeSource,
          offsetText: offset.text,
          areaName,
        }),
      );
    } else if (stage === 6) {
      // 尺寸轴大档胜出（方案 §5）：同一中心按更大尺寸重走了一遍——如实说明事实，
      // 不夸大成"更大所以细节更好"（该结论要看实际误差，回复里的备选文案已给米数）
      lines.push('（这一版按更大尺寸走了一遍，中心不变，路程会稍长一些。）');
    } else if (stage > 1) {
      lines.push('（近处不太理想，已扩大范围/调整尺寸找到更贴合的位置。）');
    }
    // 局部精修说明（方案 2026-11-05 §5.2）：精修不再改写来源阶段，
    // 有精修就如实说明，不用"第 4 级"这种一词二义的标签代替。
    if (refined) {
      lines.push('（这一版在找到的位置附近又精修了一遍细节，路程会略长一点。）');
    }
    // 超时/丝滑提示已随时间维度移除：尺寸由全阶梯搜索按"近且像"现选，
    // 实际走时（walkMinutes）仍如实展示
    const scoreText = best
      ? `路线贴合 ${best.score} · 尺寸 ${(best.sizeMeters / 1000).toFixed(1)} km · 朝向 ${best.rotationDeg}°`
      : `尺寸 ${(intent.sizeMeters / 1000).toFixed(1)} km`;
    // 参数化变体简述实际采用的关键规格（方案 §10：如「六角星 · 三长三短」）
    const specSummary =
      intent.customShape?.source === 'procedural' && intent.customShape?.spec
        ? describeShapeSpec(intent.customShape.spec)
        : null;
    const shapeDisplay = specSummary && specSummary !== result.shapeName
      ? `「${result.shapeName}」（${specSummary}）`
      : `「${result.shapeName}」`;
    // 细节特征单独披露：整体贴合达标不代表腿间隙/耳根被走出来，单独报覆盖数
    const featureText = featureCoverageText(metrics) ? ` · ${featureCoverageText(metrics)}` : '';
    lines.push(`已规划${shapeDisplay}路线：${metricsText(result, featureText)}（${scoreText}）`);
    // 多候选：给出不同尺寸的另一版，让用户自己选"更精细但更长 / 更简单但更近"
    // （承诺哪版由 pickPromisedAlternative 统一决定——切换与文案同源，Bug 5）
    if (best && alternatives.length > 0) {
      const other = pickPromisedAlternative(best, alternatives);
      if (other) {
        const otherMetrics = other.result.metrics;
        const otherKm = (otherMetrics.routeMeters / 1000).toFixed(1);
        const otherMinutes = engine.formatMinutes(otherMetrics.walkMinutes);
        // 备选文案如实给出实际贴合分与形状最大偏差（方案 §9.2）：
        // 不再统一说"更大所以细节更好"——大档未必更准，用米数让用户自己判断
        const envelopeText = Number.isFinite(other.envelopeMeters)
          ? ` · 形状最大偏差 ${Math.round(other.envelopeMeters)} m`
          : '';
        const relation = other.sizeMeters > best.sizeMeters ? '尺寸更大、路程更长' : '尺寸更小、路程更短';
        const switchHint = scaleCardCount >= 2
          ? '想换这一版点下方比例尺卡片，或直接说'
          : '想换这一版直接说';
        lines.push(
          `另有一版${relation}（${(other.sizeMeters / 1000).toFixed(1)} km）：` +
            `${otherKm} km · 约 ${otherMinutes} · 路线贴合 ${other.score}${envelopeText}。` +
            `${switchHint}"要${other.sizeMeters > best.sizeMeters ? '大' : '小'}一点的那版"。`,
        );
      }
    }
    lines.push('绿色线就是要走的路线，紫色虚线是图形轮廓；想调整位置、大小或换个图形，直接说就行。');
    return lines.join('\n');
  }
  /** 拼接推荐成功的回复：推荐图形+理由+指标，备选图形一并列出，偏移照旧明说。
   * 生成失败的图形不再走此路径（诚实失败，见 parseIntentWithRecovery）——
   * 能走到这里说明用户本来就没点名图形，实测推荐即用户所求。 */
  function composeRecommendReply({ intent, outcome, placeNote, placeSource, shapeKeys = recommendShapeKeys }) {
    const drawn = outcome.drawn;
    const lines = replyHead(intent, placeNote);
    // 偏移明说：指定地点什么都画不出来，扩大范围后画在别处——绝不假装在原地成功。
    // 原因只用第一级（近场）代表候选的证据，不声称三种图形都因同一原因失败。
    if (outcome.offset && outcome.offset.meters > 800) {
      const areaName = nearestPoi(outcome.best.center, getCity().pois)?.poi?.name || null;
      const representative = pickNearRepresentative(outcome.nearBests, shapeKeys);
      lines.push(
        composeOffsetNotice({
          kind: 'recommend',
          reason: describeNearFieldFailure(representative),
          placeSource,
          offsetText: outcome.offset.text,
          areaName,
        }),
      );
    } else if (outcome.stage > 1) {
      lines.push('（近处不太理想，已扩大范围/调整尺寸找到更贴合的位置。）');
    }
    lines.push(
      `我对这一带实测了五角星/心形/矩形，推荐「${drawn.shapeName}」：` +
        `${metricsText(drawn.result)}（路线贴合 ${drawn.score} · 尺寸 ${(drawn.sizeMeters / 1000).toFixed(1)} km · 朝向 ${drawn.rotationDeg}°）`,
    );
    const alternatives = outcome.recommendations.slice(1);
    if (alternatives.length > 0) {
      const altText = alternatives
        .map(
          (a) =>
            `${a.shapeName}（路线贴合 ${a.score} · ${(a.result.metrics.routeMeters / 1000).toFixed(1)} km · 约 ${engine.formatMinutes(a.result.metrics.walkMinutes)}）`,
        )
        .join('、');
      lines.push(`这里还能画：${altText}。想换图形直接说一声。`);
    } else {
      lines.push('其他两种图形在这一带实测不达标，没有硬画。想画别的（如圆形）可以直接说。');
    }
    lines.push('绿色线就是要走的路线，紫色虚线是图形轮廓；想调整位置、大小或换个图形，直接说就行。');
    return lines.join('\n');
  }
  /** 拼接推荐失败的诚实回复：三种图形都画不出来 + 尝试记录 + 建议 */
  function composeRecommendFailureReply({ intent, outcome, placeText, placeNote, placeSource }) {
    const lines = replyHead(intent, placeNote);
    if (escalationLikeReason(outcome) === 'outside-coverage') {
      lines.push(`这一带超出了我的路网数据范围（目前只覆盖${getCity().coverage.description}），没有可实测的路线。换${getCity().coverage.hint}的地点就行。`);
      return lines.join('\n');
    }
    const placeSubject = placeSubjectOf(placeText, placeSource);
    const tried = `${triedScopeText(outcome.stage, outcome.triedCount)}（三种图形合计）`;
    const bestAny = bestByScore(outcome.bests);
    lines.push(
      `${placeSubject}实测下来，五角星/心形/矩形都画不出像样的：${diagnoseReason(
        bestAny ? bestAny.result.metrics : null,
      )}。我已尽力尝试（${tried}），${diagnosisOf(bestAny)}，所以没有画——画出来也不会像。`,
    );
    lines.push('建议：换个地点（路网方正的商圈更容易），或直接指定更大的尺寸（如"画个 2 公里的五角星"）。');
    return lines.join('\n');
  }
  /** 图形显示名（内置/自定义） */
  function shapeNameOf(intent) {
    if (intent.customShape) {
      return intent.customShape.name;
    }
    return { star: '五角星', heart: '心形', rect: '矩形' }[intent.shapeKey] || null;
  }
  /** 引导完成时的需求确认语（"最后明确画图需求"） */
  function confirmLine(intent, state) {
    const parts = [
      state.placeCenterChosen ? '当前视野中心' : `「${intent.place}」`,
      shapeNameOf(intent) ? `画「${shapeNameOf(intent)}」` : '图形由我实测推荐',
    ];
    if (state.sizeLocked && Number.isFinite(intent.sizeMeters)) {
      parts.push(`尺寸 ${(intent.sizeMeters / 1000).toFixed(1)} km`);
    }
    return `需求明确：${parts.join(' · ')}。开始规划：`;
  }
  /** 目标规格无法生成合法图形时的诚实失败回复（完全不调用路网引擎，方案 §8.5）。
   * 不使用 LLM 的乐观开场白（它在生成失败前就已生成，与失败事实矛盾）。 */
  function composeTargetBlockedReply({ intent, blocked }) {
    const shapeName = intent.shapeBlockedName || intent.shapeSpec?.name || shapeNameOf(intent) || '图形';
    return [
      `「${shapeName}」这次没能生成出来：${blocked}。`,
      '可以再描述一次让我重新生成（越具体越容易生成，比如「六角星」「三长三短的六角星」）；',
      '如果想看看这一带实测画得出什么，直接说「实测推荐」。',
    ].join('\n');
  }
  /** 目标验收上下文（失败/诊断参考回复共用：图形名、未过原因、是否图像描摹） */
  function targetFailureContext(target, intent) {
    return {
      shapeName: target.customShape?.name || shapeNameOf(intent) || '图形',
      reason: (target.acceptance.reasons || []).join('；') || '目标轮廓不符合您要的图形',
      traced: target.customShape?.source === 'traced',
    };
  }
  /** 目标验收未通过且无可绘制路线时的诚实失败回复（与"路网画不出"分开说明）。
   * 图像描摹目标额外说明"轮廓来自这张图"（方案 2026-11-01 §3：两件事必须分开）。 */
  function composeTargetFailureReply({ intent, target, placeText, placeNote }) {
    const { shapeName, reason, traced } = targetFailureContext(target, intent);
    // 图像描摹目标：轮廓确实来自用户上传的图，只是验收没过——不能说成"画不出"或"描摹失败"
    if (traced) {
      return [
        intent.reply,
        placeNote,
        `轮廓来自这张图，但目标验收没过（${reason}），所以没有开始正式规划，这次没有画。`,
        '可以换一张线稿/剪影更清楚、四周留白更多的图，或直接换个地点再试。',
      ]
        .filter(Boolean)
        .join('\n');
    }
    return [
      intent.reply,
      placeNote,
      `「${shapeName}」的目标验收没有通过（${reason}），所以不能开始正式规划——画出来也不是您要的图形。这次没有画。`,
      '想调整图形细节（如尖角长短、比例）或换个说法再试一次。',
    ]
      .filter(Boolean)
      .join('\n');
  }
  /**
   * 诊断性参考版回复（方案 §8.5）：目标验收未通过但路线上可绘制时，给一版
   * 明确标注"目标未通过"的非合格参考。路线分再高也不能转绿、不能改写目标结论。
   * 图像描摹目标额外说明"轮廓来自这张图，但目标验收没过"（点列仍是描摹结果）。
   */
  function composeDiagnosticReferenceReply({ intent, target, placeNote, candidate }) {
    const { shapeName, reason, traced } = targetFailureContext(target, intent);
    const lines = replyHead(intent, placeNote);
    if (traced) {
      lines.push(`先说明：轮廓来自这张图，但目标验收没过（${reason}），所以下面不是合格路线。`);
    } else {
      lines.push(`先说明：「${shapeName}」的目标验收没有通过（${reason}），所以下面不是合格路线。`);
    }
    lines.push(
      `给你一版诊断性参考（地图上橙色虚线，非合格）：${referenceMetricsText(candidate)}。`,
    );
    lines.push(
      traced
        ? '这版的点列仍是这张图描出的外轮廓，仅供对照当前目标的样子，不建议按它走；换一张更清晰的线稿/剪影图或换个地点，目标验收通过后才会有绿色路线。'
        : '这版仅供对照当前目标的样子，不建议按它走；调整图形描述重新生成、并通过目标验收后才会有绿色路线。',
    );
    return lines.join('\n');
  }
  /** 切换回复（复用交付回复的指标口径，不重复 LLM 开场白）。 */
  function composeAlternativeSwitchReply({ pending, candidate, direction, promisedDelivered }) {
    const fidelityText = fidelityTextOf(candidate.result.metrics);
    const shapeName = shapeNameOf(pending.intent) || '图形';
    // 备选中心可能与上一版不同：偏移超 800m 时如实说明（复核意见：静默换位置）
    let movedMeters = null;
    if (pending.best?.center && candidate.center) {
      movedMeters = distanceMeters(
        pending.best.center.lat,
        pending.best.center.lng,
        candidate.center.lat,
        candidate.center.lng,
      );
    }
    const positionNote = centerOffsetNote(movedMeters, 800);
    const lines = [
      `已切换到${direction === 'bigger' ? '更大' : '更小'}的一版「${shapeName}」：${switchSummaryText(candidate, { fidelityText, positionNote })}`,
    ];
    lines.push('绿色线就是要走的路线，想再换尺寸直接说"要大一点/小一点的那版"，或直接说明目标尺寸。');
    return lines.join('\n');
  }

  return {
    escalationLikeReason,
    exampleHint,
    diagnoseReason,
    triedScopeText,
    composeFailureReply,
    describeShortfall,
    composeReferenceReply,
    composeConstraintViolationReply,
    composeReply,
    composeRecommendReply,
    composeRecommendFailureReply,
    shapeNameOf,
    confirmLine,
    composeTargetBlockedReply,
    composeTargetFailureReply,
    composeDiagnosticReferenceReply,
    composeAlternativeSwitchReply,
    // 供单元测试直接验证的纯文本 helper（T-B2a；固定输入 → 固定输出）
    fidelityTextOf,
    metricsText,
    replyHead,
  };
}
