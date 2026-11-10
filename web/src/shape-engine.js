import * as L from '../vendor/leaflet.esm.js';
import { loadRoadData } from './road-data.js';
import {
  buildEdgeIndex,
  buildNodeIndex,
  buildWalkGraph,
  findLargestComponent,
  graphBounds,
  pointInBounds,
} from './engine/graph.js';
import { SHAPES } from './engine/shapes.js';
import { collectRouteTopologyMetrics } from './engine/route-topology.js';
import { recommendShapes, searchWithEscalation } from './engine/candidates.js';
import { captureGeometry, restoreGeometry } from './session/geometry.js';
import { offsetDescription } from './geo-text.js';
import { createLogger } from './log/index.js';

/** 模块 logger（自动归属当前对话 trace） */
const log = createLogger('engine');

/** 引擎结果里的指标摘要（日志用，字段较多时保持可读） */
function metricsSummary(metrics) {
  if (!metrics) {
    return null;
  }
  return {
    routeMeters: Math.round(metrics.routeMeters),
    walkMinutes: Math.round(metrics.walkMinutes),
    detourRatio: metrics.detourRatio,
    coverage: metrics.coverage,
    failedLegs: metrics.failedLegs,
    snapMaxMeters: metrics.snapMaxMeters,
    outlineMeanMeters: metrics.outlineMeanMeters,
    outlineMaxMeters: metrics.outlineMaxMeters,
    // 路线拓扑诊断（方案 2026-11-01 阶段 0）：唯一交叉与重复道路比例
    uniqueCrossingCount: metrics.uniqueCrossingCount ?? null,
    reusedEdgeRatio: metrics.reusedEdgeRatio ?? null,
  };
}

/** 自定义图形摘要（完整点列由方案里的 outline/constraint 字段记录） */
function customShapeSummary(customShape) {
  if (!customShape) {
    return null;
  }
  return {
    name: customShape.name,
    outlinePoints: customShape.outlinePoints.length,
    constraintPoints: customShape.constraintPoints.length,
    parts: customShape.parts?.length ?? 1,
  };
}

/**
 * 图形路线引擎：路网图懒加载、图形规划（含尽力链/实测推荐）与结果绘制，无自有界面，由智能体调用。
 * 搜索与绘制分离（交付一致性）：plan()/recommend() 只做无副作用搜索；编排层在候选比较、
 * 交付闸门判定后，对最终选定结果调用 commitDraw(result) 统一绘制一次，失败/拒绝交付时
 * 调用 clearDraw() 清除旧图层——保证"回复里的结果、指标、地图上的线"永远是同一个候选。
 *
 * @param {object} options
 * @param {L.Map} options.map Leaflet 地图实例
 * @returns {{plan: Function, recommend: Function, commitDraw: Function, clearDraw: Function, formatMinutes: Function, getPlaceContext: Function}} 引擎接口
 */
export function createShapeEngine({ map }) {
  let graph = null;
  let nodeIndex = null;
  let edgeIndex = null;
  let overlay = null;
  /** 路网覆盖包围盒（数据只覆盖配置城市的裁剪范围） */
  let coverage = null;
  /** 当前路网归属的城市 id（快照城市归属守卫与切换日志用；缺省 null = 启动城市） */
  let cityId = null;

  /** 从一份道路数组重建图与索引（ensureGraph 与 useCity 共用） */
  function buildFromRoads(roads) {
    const startedAt = performance.now();
    graph = buildWalkGraph(roads);
    // 只在主连通分量上吸附，避免顶点落到封闭小区等孤立路网
    const mainComponent = findLargestComponent(graph);
    nodeIndex = buildNodeIndex(graph, 0.005, mainComponent);
    edgeIndex = buildEdgeIndex(graph, 0.005, mainComponent);
    coverage = graphBounds(graph);
    log.info('graph.ready', {
      cityId,
      durationMs: Math.round(performance.now() - startedAt),
      roads: roads.length,
      nodes: graph.nodeCount,
      edges: graph.edgeCount,
      mainComponentNodes: mainComponent.size,
      coverage,
    });
  }

  /** 懒加载路网数据并构建步行图 */
  async function ensureGraph() {
    if (graph) {
      return;
    }
    const roads = await loadRoadData();
    buildFromRoads(roads);
  }

  /**
   * 按城市重建路网图（城市切换时由 city store 调用）：
   * 同步重建 graph/nodeIndex/edgeIndex/coverage，并清掉上一城市的残留图形——
   * 保证切换后地图与规划用的都是新城路网（需求 R3：不拿上一座城市的路网出图）。
   *
   * @param {{id: string, label: string}} cityConfig 新活动城市配置
   * @param {Array} roads 该城路网数组
   */
  function useCity(cityConfig, roads) {
    cityId = cityConfig?.id ?? null;
    clearOverlay();
    buildFromRoads(roads);
    log.info('city.graph.switched', {
      cityId,
      label: cityConfig?.label ?? null,
      nodes: graph.nodeCount,
      coverage,
    });
  }

  /**
   * 只读地点上下文：复用已建图数据供 places.js 解析覆盖中心（不重复建图、不增加模型调用）。
   * @returns {Promise<{graph: object, nodeIndex: object, coverage: object|null}>} 路网图/主分量节点索引/覆盖包围盒
   */
  async function getPlaceContext() {
    await ensureGraph();
    log.info('place.context.ready', { nodes: graph.nodeCount, coverage });
    return { graph, nodeIndex, coverage };
  }

  /**
   * 规划中心范围预检：中心明显在路网覆盖外（郊区/邻市或视野在数据范围外）时直接失败——
   * 路网只覆盖配置城市的核心区，硬搜只会得到"几百个候选全都无路"的误导性结论（实测教训：覆盖外地点）。
   *
   * @returns {boolean} true = 超出覆盖（调用方按 outside-coverage 失败）
   */
  function outsideCoverage(center) {
    return coverage !== null && !pointInBounds(coverage, center, 0.01);
  }

  /**
   * 把引擎结果归一成"绘制用几何"（轮廓/路线/吸附点），绘制与聚焦共用同一份结构。
   *
   * @param {object} result 规划结果
   * @returns {{outlineParts: Array|null, outline: Array, route: Array, snapped: Array}} 绘制几何
   */
  function geometryOf(result) {
    return {
      outlineParts: Array.isArray(result.outlineParts) && result.outlineParts.length > 0
        ? result.outlineParts
        : null,
      outline: result.outlineLatLngs || [],
      route: result.routeLatLngs || [],
      snapped: result.snapped || [],
    };
  }

  /**
   * 绘制规划结果：图形轮廓 + 吸附点 + 路线 + 起点。
   *
   * @param {object} geometry 绘制几何（geometryOf 的结果）
   * @param {{reference?: boolean}} [options] reference=true 时按"非合格参考版"样式（橙色路线）绘制
   */
  function drawGeometry(geometry, { reference = false } = {}) {
    if (overlay) {
      map.removeLayer(overlay);
    }
    overlay = L.layerGroup();
    const routeColor = reference ? '#f59e0b' : '#16a34a';

    // 图形轮廓：多部分图形（群岛等）逐部分画环，单部分整体画
    if (geometry.outlineParts?.length) {
      for (const part of geometry.outlineParts) {
        L.polygon(part, {
          color: '#7c3aed',
          weight: 2,
          opacity: 0.9,
          dashArray: '6 5',
          fill: false,
        }).addTo(overlay);
      }
    } else {
      L.polygon(geometry.outline || [], {
        color: '#7c3aed',
        weight: 2,
        opacity: 0.9,
        dashArray: '6 5',
        fill: false,
      }).addTo(overlay);
    }

    for (const point of geometry.snapped) {
      L.circleMarker([point.lat, point.lng], {
        radius: 3,
        color: '#7c3aed',
        fillColor: '#7c3aed',
        fillOpacity: 1,
        weight: 1,
      }).addTo(overlay);
    }

    if (!geometry.route?.length) {
      overlay.addTo(map);
      return;
    }

    L.polyline(geometry.route, {
      color: '#ffffff',
      weight: 9,
      opacity: 0.85,
      interactive: false,
    }).addTo(overlay);
    L.polyline(geometry.route, {
      color: routeColor,
      weight: 5,
      opacity: 0.95,
      lineCap: 'round',
      lineJoin: 'round',
      dashArray: reference ? '10 6' : null,
    }).addTo(overlay);

    L.circleMarker(geometry.route[0], {
      radius: 6,
      color: routeColor,
      weight: 3,
      fillColor: '#ffffff',
      fillOpacity: 1,
    }).addTo(overlay);

    overlay.addTo(map);
  }

  /** 清除已绘制的图层 */
  function clearOverlay() {
    if (overlay) {
      map.removeLayer(overlay);
      overlay = null;
    }
  }

  /** 格式化分钟数 */
  function formatMinutes(minutes) {
    const total = Math.round(minutes);
    if (total < 60) {
      return `${total} 分钟`;
    }
    const hours = Math.floor(total / 60);
    const rest = total % 60;
    return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分`;
  }

  /**
   * 聚焦到"理想轮廓 ∪ 实际路线"：只按轮廓聚焦会把扩大范围的连接段/绕行路线裁出视野。
   *
   * @param {object} geometry 绘制几何
   */
  function fitGeometry(geometry) {
    const points = [...(geometry.outline || []), ...(geometry.route || [])];
    if (points.length === 0) {
      return;
    }
    map.fitBounds(L.latLngBounds(points), {
      padding: [80, 80],
      maxZoom: 15,
    });
  }

  /**
   * 提交绘制：只由编排层在"最终选定 + 通过交付闸门"后调用一次，保证图上画的就是回复里的候选。
   *
   * 返回图形快照（几何 + 样式标记），供会话存储保存——刷新后仍可原样重绘。
   *
   * @param {object} result 规划结果（含 outlineLatLngs/routeLatLngs/snapped）
   * @param {{reference?: boolean, score?: number, deliveredObjects?: Array<object>}} [options]
   *   reference=true 表示"非合格参考版"（橙色虚线）；score 为本轮路线贴合分；
   *   deliveredObjects 为结构化交付身份（方案 2026-11-08 §4.2），随快照留痕供 E2E 断言
   * @returns {object} 图形快照
   */
  function commitDraw(result, { reference = false, score = null, deliveredObjects = null } = {}) {
    const geometry = geometryOf(result);
    drawGeometry(geometry, { reference });
    fitGeometry(geometry);
    log.info(reference ? 'plan.reference.committed' : 'plan.committed', {
      shapeName: result.shapeName,
      sizeMeters: result.sizeMeters,
      rotationDeg: result.rotationDeg,
      routePoints: result.routeLatLngs?.length ?? 0,
      deliveredObjects: Array.isArray(deliveredObjects) ? deliveredObjects : undefined,
    });
    return {
      shapeName: result.shapeName ?? null,
      sizeMeters: result.sizeMeters ?? null,
      rotationDeg: result.rotationDeg ?? null,
      score,
      reference,
      // 快照城市归属（方案 2026-11-08 §6.3）：翻看/恢复时 cityId 与当前城市不符不绘制
      cityId,
      // 结构化交付身份（方案 2026-11-08 §4.2）：实际交付了哪些对象，一一对应可核对
      deliveredObjects: Array.isArray(deliveredObjects) ? deliveredObjects : [],
      // 路线拓扑诊断随交付留痕（缺陷清单 2026-11-06 Bug 4.4：先统计不设门）——
      // 唯一交叉数与重复道路比例进入会话图形快照与交付结果 JSON，形成可回归指标；
      // 是否加门待真实分布统计后再定（阶段 0 口径不变：不参与任何门禁）
      uniqueCrossingCount: Number.isFinite(result.metrics?.uniqueCrossingCount)
        ? result.metrics.uniqueCrossingCount
        : null,
      reusedEdgeRatio: Number.isFinite(result.metrics?.reusedEdgeRatio)
        ? result.metrics.reusedEdgeRatio
        : null,
      geometry: captureGeometry(result),
    };
  }

  /**
   * 按已保存的图形快照重绘（需求 R2/R3：切换对话或前后翻看历史图形时，
   * 样式与当时一致——合格绿线 / 非合格橙色参考版）。
   *
   * 城市归属守卫（方案 2026-11-08 §6.3）：快照带 cityId 且与当前路网城市不符时
   * 不绘制——换城后不残留上一座城市的结果冒充当前结果。
   *
   * @param {object} shape 图形快照（含 geometry 与 reference）
   * @returns {boolean} 是否绘制成功
   */
  function drawSnapshot(shape) {
    if (!shape?.geometry) {
      return false;
    }
    if (shape.cityId && cityId && shape.cityId !== cityId) {
      log.info('plan.snapshot.city.mismatch', {
        shapeCityId: shape.cityId,
        currentCityId: cityId,
        shapeName: shape.shapeName ?? null,
      });
      return false;
    }
    const geometry = restoreGeometry(shape.geometry);
    if (!geometry.route?.length && !geometry.outline?.length) {
      return false;
    }
    drawGeometry(geometry, { reference: Boolean(shape.reference) });
    fitGeometry(geometry);
    log.info('plan.snapshot.drawn', {
      shapeName: shape.shapeName ?? null,
      reference: Boolean(shape.reference),
      routePoints: geometry.route.length,
      outlinePoints: geometry.outline.length,
    });
    return true;
  }

  /** 清除已绘制图层（失败/拒绝交付时由编排层调用，避免旧图形残留） */
  function clearDraw() {
    clearOverlay();
  }

  /**
   * 规划图形路线（无副作用搜索，不绘制）：自动选址走"尽力链"（近场 → 扩大范围 → 放大尺寸），
   * 找不到达标候选返回 status='failed' 并附诊断——画不出来就说画不出来，不硬画；绘制由编排层完成。
   *
   * @param {object} options
   * @param {string} [options.shapeKey] 内置图形标识（star/heart/rect）
   * @param {{name: string, constraintPoints: Array, outlinePoints: Array}} [options.customShape] 自定义图形（优先于 shapeKey）
   * @param {number} options.sizeMeters 图形外接尺寸（米）
   * @param {number} [options.rotationDeg] 旋转角度（度）
   * @param {{lat: number, lng: number}} [options.center] 规划中心，缺省为地图当前中心
   * @param {number[]|null} [options.rotations] 自动选址搜索的朝向集合；缺省用图形自带搜索集
   * @param {object|null} [options.constraintContract] 显式约束契约（方案 2026-11-08 §3.2）：
   *   显式尺寸/朝向下搜索层只生成满足约束的候选，整个搜索过程不得静默改变约束
   * @param {boolean} [options.allowEnlarge] 尽力链是否允许放大尺寸级
   * @param {(progress: object) => void} [options.onProgress] 搜索进度回调
   * @param {AbortSignal} [options.signal] 中止信号（用户点"停止"）：搜索立刻中断
   * @returns {Promise<{status: 'ok'|'failed', result: object|null, best: object|null, stage?: number, stageLabel?: string, triedCount?: number, offset?: object}>}
   */
  async function plan({
    shapeKey,
    customShape = null,
    sizeMeters,
    rotationDeg = 0,
    center = null,
    rotations = null,
    constraintContract = null,
    allowEnlarge = true,
    deadline = null,
    onProgress = null,
    signal = null,
  }) {
    await ensureGraph();
    const planCenter = center || map.getCenter();
    const shapeName = customShape ? customShape.name : SHAPES[shapeKey].name;
    log.info('plan.begin', {
      shapeName,
      shapeKey: shapeKey ?? null,
      customShape: customShapeSummary(customShape),
      sizeMeters,
      rotationDeg,
      center: { lat: planCenter.lat, lng: planCenter.lng },
      allowEnlarge,
      rotations,
    });

    // 覆盖预检：中心在路网数据范围外，直接诚实失败（不空烧候选数）
    if (outsideCoverage({ lat: planCenter.lat, lng: planCenter.lng })) {
      log.warn('plan.outside.coverage', {
        center: { lat: planCenter.lat, lng: planCenter.lng },
        coverage,
      });
      return {
        status: 'failed',
        result: null,
        best: null,
        stage: 0,
        stageLabel: '数据范围校验',
        triedCount: 0,
        reason: 'outside-coverage',
      };
    }

    const escalation = await searchWithEscalation({
      graph,
      edgeIndex,
      shapeKey,
      customShape,
      center: { lat: planCenter.lat, lng: planCenter.lng },
      baseSizeMeters: sizeMeters,
      rotations: rotations && rotations.length ? rotations : undefined,
      constraintContract,
      allowEnlarge,
      deadline,
      onProgress,
      signal,
    });

    if (escalation.status === 'failed') {
      // 画不出来：不绘制（地图由编排层按交付结论处理），诚实说明
      log.warn('plan.failed', {
        shapeName,
        sizeMeters,
        stage: escalation.stage,
        stageLabel: escalation.stageLabel,
        triedCount: escalation.triedCount,
        budgetExhausted: escalation.budgetExhausted,
        bestScore: escalation.best?.score ?? null,
        bestMetrics: metricsSummary(escalation.best?.result?.metrics),
      });
      return { status: 'failed', result: null, best: escalation.best, ...escalation };
    }

    const best = escalation.best;
    // 候选数取自尽力链实际尝试总数（searchBestCandidate 的 best 不带该字段）
    best.candidateCount = escalation.triedCount;
    const offset = offsetDescription(planCenter, best.center);
    // 路线拓扑诊断指标（方案 2026-11-01 阶段 0）：唯一交叉 + 重复道路比例。
    // 只对最终选定的候选计算——交叉统计是二次复杂度，放进候选热路径会拖慢搜索；
    // 两项指标在阶段 0 只作诊断记录，不参与任何门禁（阈值待阶段 2 校准）。
    const topology = collectRouteTopologyMetrics({
      legs: best.result?.legs,
      metrics: best.result?.metrics,
    });
    if (best.result?.metrics) {
      best.result.metrics.uniqueCrossingCount = topology.crossings.count;
      best.result.metrics.reusedEdgeRatio = topology.reuse.reusedEdgeRatio;
    }
    log.info('plan.topology', {
      shapeName,
      uniqueCrossingCount: topology.crossings.count,
      reusedEdgeRatio: topology.reuse.reusedEdgeRatio,
      reusedEdgeMeters: topology.reuse.reusedEdgeMeters,
      routeMeters: topology.reuse.routeMeters,
    });
    log.info('plan.selected', {
      mode: 'autoSearch',
      shapeName,
      score: best.score,
      adjustedScore: best.adjustedScore ?? null,
      sizeMeters: best.sizeMeters,
      rotationDeg: best.rotationDeg,
      center: best.center,
      offset: { meters: Math.round(offset.meters), text: offset.text },
      // 来源阶段口径（方案 2026-11-05 §5.2）：stage 只表示粗搜来源级别；
      // 「是否精修」「粗搜候选尺寸」「最终尺寸」分别记录，报告不再拿 stage 反推来源。
      stage: escalation.stage,
      stageLabel: escalation.stageLabel,
      refined: escalation.refined ?? false,
      sourceStage: escalation.sourceStage ?? escalation.stage ?? null,
      sourceStageLabel: escalation.sourceStageLabel ?? escalation.stageLabel ?? null,
      sourceSizeMeters: escalation.sourceSizeMeters ?? null,
      finalSource: escalation.finalSource ?? null,
      finalStage: escalation.finalStage ?? null,
      finalStageLabel: escalation.finalStageLabel ?? null,
      triedCount: escalation.triedCount,
      budgetExhausted: escalation.budgetExhausted,
      metrics: metricsSummary(best.result.metrics),
    });
    return { status: 'ok', result: best.result, best, offset, ...escalation };
  }

  /**
   * 只给条件（地点/时间）时的实测推荐（无副作用搜索，不绘制）：对多种内置图形分别跑尽力链
   * 候选搜索返回推荐集；全部不达标返回 status='failed' 并附诊断，绘制由编排层在选定后完成。
   *
   * @param {{lat: number, lng: number}} [options.center] 规划中心，缺省为地图当前中心
   * @param {Object<string, number>} options.shapeSizes 各图形基准尺寸（米），key 为 SHAPES 的 key
   * @param {boolean} [options.allowEnlarge] 尽力链是否允许放大尺寸级
   * @param {(progress: object) => void} [options.onProgress] 搜索进度回调（附 shapeName/stage）
   * @param {AbortSignal} [options.signal] 中止信号（用户点"停止"）：搜索立刻中断
   * @returns {Promise<{status: 'ok'|'failed', recommendations: Array, drawn: object|null, best: object|null, stage: number, stageLabel: string, triedCount: number, bests: object, offset?: object}>}
   */
  async function recommend({
    center = null,
    shapeSizes,
    allowEnlarge = true,
    deadline = null,
    onProgress = null,
    signal = null,
  }) {
    await ensureGraph();
    const planCenter = center || map.getCenter();
    log.info('recommend.begin', {
      center: { lat: planCenter.lat, lng: planCenter.lng },
      shapeSizes,
      allowEnlarge,
    });

    // 覆盖预检：三种图形都无从谈起，直接诚实失败
    if (outsideCoverage({ lat: planCenter.lat, lng: planCenter.lng })) {
      log.warn('recommend.outside.coverage', {
        center: { lat: planCenter.lat, lng: planCenter.lng },
        coverage,
      });
      return {
        status: 'failed',
        recommendations: [],
        drawn: null,
        best: null,
        stage: 0,
        stageLabel: '数据范围校验',
        triedCount: 0,
        budgetExhausted: false,
        bests: {},
        reason: 'outside-coverage',
      };
    }

    const outcome = await recommendShapes({
      graph,
      edgeIndex,
      center: { lat: planCenter.lat, lng: planCenter.lng },
      shapeSizes,
      allowEnlarge,
      deadline,
      onProgress,
      signal,
    });

    if (outcome.status === 'failed') {
      // 三种图形都画不出来：不绘制，诚实说明（由调用方转述）
      log.warn('recommend.failed', {
        shapeSizes,
        triedCount: outcome.triedCount,
        stage: outcome.stage,
        stageLabel: outcome.stageLabel,
        budgetExhausted: outcome.budgetExhausted,
        bestScores: Object.fromEntries(
          Object.entries(outcome.bests || {}).map(([key, value]) => [key, value?.score ?? null]),
        ),
      });
      return { ...outcome, drawn: null, best: null };
    }

    const drawn = outcome.recommendations[0];
    // best 直接用选中候选自身字段（bests 里可能是别的高分未达标候选）；候选数取三种图形实际尝试总数
    const best = {
      result: drawn.result,
      score: drawn.score,
      center: drawn.center,
      sizeMeters: drawn.sizeMeters,
      rotationDeg: drawn.rotationDeg,
      candidateCount: outcome.triedCount,
    };
    const offset = offsetDescription(planCenter, best.center);
    log.info('recommend.selected', {
      shapeName: drawn.shapeName,
      score: drawn.score,
      adjustedScore: drawn.adjustedScore ?? null,
      sizeMeters: drawn.sizeMeters,
      rotationDeg: drawn.rotationDeg,
      center: drawn.center,
      offset: { meters: Math.round(offset.meters), text: offset.text },
      stage: outcome.stage,
      stageLabel: outcome.stageLabel,
      triedCount: outcome.triedCount,
      budgetExhausted: outcome.budgetExhausted,
      metrics: metricsSummary(drawn.result.metrics),
      recommendations: outcome.recommendations.map((item) => ({
        shapeName: item.shapeName,
        score: item.score,
        sizeMeters: item.sizeMeters,
      })),
    });
    return { ...outcome, drawn, best, offset };
  }

  return {
    plan,
    recommend,
    commitDraw,
    clearDraw,
    drawSnapshot,
    formatMinutes,
    getPlaceContext,
    useCity,
    currentCityId: () => cityId,
  };
}
