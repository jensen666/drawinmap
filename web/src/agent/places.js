/**
 * 地点解析：把用户提到的地名解析为地图坐标（纯算法，代码内不写死任何城市/地名）。
 *
 * 数据来源：`place-config.js` 归一化的地点配置（城市名、地标、别名、行政区、匹配策略），
 * 以及 `loadRoadData()` 构建的道路名索引。解析顺序：
 *   别名精确 → 地标精确 → 城市名（需地点上下文）→ 行政区全名（需地点上下文）
 *   → 行政区简称（仅配置了的简称）→ 地标包含 → 道路名精确 → 道路名包含。
 *
 * 准确率策略全部来自配置（`matching`），代码只实现通用规则：
 * - 短查询（2 字城市/地名，如配置里未单独声明的简称）不参与包含匹配，避免子串误命中到 POI/道路；
 * - 需要更短包含匹配的歧义地名，在配置里显式声明别名或短名，而不是放宽全局阈值；
 * - 地点未解析时由上层按 `matching.unresolvedPlace` 决定是否追问，不再默认画到视野中心。
 */

import { graphBounds, nearestNode, pointInBounds } from '../engine/graph.js';
import { METERS_PER_DEG_LAT, metersPerDegLng as metersPerDegLngAt } from '../engine/geo.js';
import { createLogger } from '../log/index.js';

/** 模块 logger */
const log = createLogger('agent/places');

/**
 * 构建路网道路名索引。
 *
 * @param {Array<{n?: string, c?: number[][]}>} roads 道路数组
 * @returns {Map<string, {lat: number, lng: number, segments: number}>} 名称 → 代表坐标（各段坐标均值）
 */
export function createPlaceIndex(roads) {
  const index = new Map();
  for (const road of roads) {
    const name = road.n;
    if (!name || !Array.isArray(road.c) || road.c.length === 0) {
      continue;
    }
    let entry = index.get(name);
    if (!entry) {
      entry = { latSum: 0, lngSum: 0, points: 0, segments: 0 };
      index.set(name, entry);
    }
    entry.segments += 1;
    for (const [lon, lat] of road.c) {
      entry.latSum += lat;
      entry.lngSum += lon;
      entry.points += 1;
    }
  }
  const result = new Map();
  for (const [name, entry] of index) {
    result.set(name, {
      lat: entry.latSum / entry.points,
      lng: entry.lngSum / entry.points,
      segments: entry.segments,
    });
  }
  log.info('place.index.ready', { names: result.size, roads: roads.length });
  return result;
}

/**
 * 找距离某点最近的地标（用于把偏移后的位置说成"「某地标」一带"）。
 *
 * @param {{lat: number, lng: number}} center 目标点
 * @param {Array<{name: string, lat: number, lng: number}>} pois 地标列表（来自地点配置）
 * @returns {{poi: object, meters: number}|null} 最近地标与距离（米）；无地标时 null
 */
export function nearestPoi(center, pois) {
  if (!center || !Array.isArray(pois) || pois.length === 0) {
    return null;
  }
  const metersPerDegLng = metersPerDegLngAt(center.lat);
  let best = null;
  for (const poi of pois) {
    const meters = Math.hypot(
      (poi.lat - center.lat) * METERS_PER_DEG_LAT,
      (poi.lng - center.lng) * metersPerDegLng,
    );
    if (!best || meters < best.meters) {
      best = { poi, meters };
    }
  }
  return best;
}

/**
 * 计算覆盖中心：路网包围盒中点 → 主连通分量上的最近节点。
 * 裸包围盒中点可能落在江面/未建图区域，规划中心必须吸附到真实节点；
 * 包围盒为空、图无节点或最近节点缺失时返回 null（表示未解析，调用方不得回退包含匹配）。
 *
 * @param {{graph: object, nodeIndex: object}} placeContext 只读地点上下文
 * @param {string} centerLabel 覆盖中心展示名（来自城市配置）
 * @returns {{lat: number, lng: number, label: string, source: 'coverage-center'}|null}
 *   覆盖中心坐标（最近节点坐标，不是裸中点）；无法计算返回 null
 */
function coverageCenter(placeContext, centerLabel) {
  const { graph, nodeIndex } = placeContext || {};
  const bounds = graph && graph.nodes ? graphBounds(graph) : null;
  if (!bounds) {
    log.warn('place.coverage-center.failed', { reason: 'empty-bounds', hasGraph: Boolean(graph) });
    return null;
  }
  if (!nodeIndex) {
    log.warn('place.coverage-center.failed', { reason: 'missing-node-index' });
    return null;
  }
  const midLat = (bounds.minLat + bounds.maxLat) / 2;
  const midLng = (bounds.minLng + bounds.maxLng) / 2;
  const nearest = nearestNode(nodeIndex, graph, midLng, midLat);
  if (nearest.id === null) {
    log.warn('place.coverage-center.failed', { reason: 'no-nearest-node', midLat, midLng });
    return null;
  }
  const [lng, lat] = graph.nodes.get(nearest.id);
  log.info('place.coverage-center', {
    lat,
    lng,
    midLat,
    midLng,
    snapMeters: Math.round(nearest.distance),
  });
  // label 明说"覆盖中心"，不把整个市域冒充成已知坐标
  return { lat, lng, label: centerLabel, source: 'coverage-center' };
}

/**
 * 解析行政区（只在有覆盖数据时给出结论，不猜覆盖内外）：
 * - 代表点在覆盖内 → 覆盖中心（不声称整个区已定位）；覆盖中心算不出来则返回未解析，
 *   不回退区代表点（否则用户会以为系统按该区定位了）；
 * - 代表点在覆盖外 → 保留代表点并标 source='district'，交给规划返回 outside-coverage；
 * - coverage 缺失 → 无法判断覆盖内外，返回未解析（不把"未知"当成"已证明覆盖外"）。
 *
 * @param {string} name 行政区名（配置中的全名）
 * @param {{lat: number, lng: number}} point 配置代表点
 * @param {object} placeContext 只读地点上下文
 * @param {{marginDeg: number, centerLabel: string}} options 覆盖边距与覆盖中心展示名
 * @returns {{lat: number, lng: number, label: string, source: 'coverage-center'|'district'}|null}
 */
function resolveDistrict(name, point, placeContext, { marginDeg, centerLabel }) {
  const coverage = placeContext?.coverage ?? null;
  if (!coverage) {
    log.warn('place.district.coverage-missing', { name });
    return null;
  }
  const inside = pointInBounds(coverage, point, marginDeg);
  if (!inside) {
    log.info('place.district', { name, source: 'district', inside, lat: point.lat, lng: point.lng });
    return { lat: point.lat, lng: point.lng, label: name, source: 'district' };
  }
  const center = coverageCenter(placeContext, centerLabel);
  if (!center) {
    log.warn('place.district.coverage-center-failed', { name });
    return null;
  }
  log.info('place.district', { name, source: 'coverage-center', inside });
  return { ...center, label: name };
}

/**
 * 道路查询：精确命中优先；包含匹配受配置的最小查询长度/最小路段数约束。
 *
 * @param {Map<string, {lat: number, lng: number, segments: number}>|null} roadIndex 道路名索引
 * @param {string} name 查询文本
 * @param {{allowContainment: boolean, minQueryLength: number, minSegments: number}} options 策略
 * @returns {{lat: number, lng: number, label: string, source: 'road'}|null} 解析结果
 */
function lookupRoad(roadIndex, name, { allowContainment, minQueryLength, minSegments }) {
  if (!roadIndex) {
    return null;
  }
  const exact = roadIndex.get(name);
  if (exact) {
    return { lat: exact.lat, lng: exact.lng, label: name, source: 'road' };
  }
  if (!allowContainment || name.length < minQueryLength) {
    return null;
  }
  let best = null;
  for (const [roadName, entry] of roadIndex) {
    if (entry.segments < minSegments) {
      continue;
    }
    if (!(roadName.includes(name) || name.includes(roadName))) {
      continue;
    }
    if (!best || entry.segments > best.entry.segments) {
      best = { roadName, entry };
    }
  }
  if (!best) {
    return null;
  }
  log.info('place.road.containment', { query: name, roadName: best.roadName, segments: best.entry.segments });
  return { lat: best.entry.lat, lng: best.entry.lng, label: best.roadName, source: 'road' };
}

/**
 * 解析地名为坐标。
 *
 * @param {string} query 用户提到的地名（原文）
 * @param {object} options
 * @param {object} options.config 归一化地点配置（normalizePlaceConfig 结果）
 * @param {Map} [options.roadIndex] createPlaceIndex 构建的道路名索引
 * @param {{graph: object, nodeIndex: object, coverage: object|null}|null} [options.placeContext]
 *   引擎 getPlaceContext() 返回的只读地点上下文；缺省时城市/行政区逻辑不参与
 * @returns {{lat: number, lng: number, label: string, source: 'poi'|'road'|'district'|'coverage-center'}|null}
 *   解析结果，未找到返回 null
 */
export function resolvePlace(query, { config, roadIndex = null, placeContext = null } = {}) {
  if (!query || typeof query !== 'string') {
    return null;
  }
  const name = query.trim();
  if (!name) {
    return null;
  }
  const city = config?.activeCity;
  if (!city) {
    log.warn('place.config.missing', { query: name });
    return null;
  }
  const matching = config.matching || {};
  const marginDeg = matching.coverageMarginDeg ?? 0.01;
  const centerLabel = city.coverage?.centerLabel ?? '覆盖中心';
  const poiByName = new Map((city.pois || []).map((poi) => [poi.name, poi]));
  const districtByName = new Map((city.districts || []).map((district) => [district.name, district]));
  const districtByShort = new Map(
    (city.districts || [])
      .filter((district) => district.shortName)
      .map((district) => [district.shortName, district]),
  );
  const aliasByText = new Map((city.aliases || []).map((alias) => [alias.text, alias]));

  /** 解析别名目标（地标/行政区/道路） */
  function resolveAliasTarget(target) {
    if (target.type === 'poi') {
      const poi = poiByName.get(target.name);
      return poi ? { lat: poi.lat, lng: poi.lng, label: poi.name, source: 'poi' } : null;
    }
    if (target.type === 'district') {
      const district = districtByName.get(target.name);
      return district
        ? resolveDistrict(district.name, district.point, placeContext, { marginDeg, centerLabel })
        : null;
    }
    // 道路别名：显式配置的查询，允许比全局阈值更短的包含匹配（用于配置里声明的歧义短名）
    return lookupRoad(roadIndex, target.name, {
      allowContainment: true,
      minQueryLength: 0,
      minSegments: 1,
    });
  }

  // 1. 别名精确匹配（含指向道路的别名）
  const alias = aliasByText.get(name);
  if (alias) {
    const resolved = resolveAliasTarget(alias.target);
    if (resolved) {
      log.info('place.resolved', { query: name, source: resolved.source, label: resolved.label, via: 'alias' });
      return resolved;
    }
  }

  // 2. 地标精确匹配
  const exactPoi = poiByName.get(name);
  if (exactPoi) {
    log.info('place.resolved', { query: name, source: 'poi', label: exactPoi.name, via: 'poi-exact' });
    return { lat: exactPoi.lat, lng: exactPoi.lng, label: exactPoi.name, source: 'poi' };
  }

  // 3. 城市名精确匹配（需要地点上下文判覆盖）
  if (placeContext && (city.names || []).includes(name)) {
    const center = coverageCenter(placeContext, centerLabel);
    if (center) {
      log.info('place.resolved', { query: name, source: 'coverage-center', label: center.label });
    }
    return center;
  }

  // 4. 行政区全名匹配（需要地点上下文判覆盖）
  if (placeContext) {
    const district = districtByName.get(name);
    if (district) {
      const resolved = resolveDistrict(district.name, district.point, placeContext, { marginDeg, centerLabel });
      if (resolved) {
        log.info('place.resolved', { query: name, source: resolved.source, label: resolved.label, via: 'district' });
      }
      return resolved;
    }
    // 5. 行政区简称匹配（只认配置声明过的简称，不做「任意名字 + 区」的猜测）
    const shortDistrict = districtByShort.get(name);
    if (shortDistrict) {
      const resolved = resolveDistrict(shortDistrict.name, shortDistrict.point, placeContext, {
        marginDeg,
        centerLabel,
      });
      if (resolved) {
        log.info('place.resolved', {
          query: name,
          source: resolved.source,
          label: resolved.label,
          via: 'district-short',
        });
      }
      return resolved;
    }
  }

  // 6. 地标包含匹配：短查询不参与（避免 2 字城市名被子串命中到更长的地标名），
  //    确有歧义短名时在配置别名里显式声明
  const poiMinLength = matching.poiContainmentMinQueryLength ?? 3;
  if (name.length >= poiMinLength) {
    const containPoi = (city.pois || []).find(
      (poi) => poi.name.includes(name) || name.includes(poi.name),
    );
    if (containPoi) {
      log.info('place.resolved', {
        query: name,
        source: 'poi',
        label: containPoi.name,
        via: 'poi-containment',
      });
      return { lat: containPoi.lat, lng: containPoi.lng, label: containPoi.name, source: 'poi' };
    }
  }

  // 7. 道路名精确匹配
  const exactRoad = lookupRoad(roadIndex, name, { allowContainment: false, minQueryLength: 0, minSegments: 1 });
  if (exactRoad) {
    log.info('place.resolved', { query: name, source: 'road', label: exactRoad.label, via: 'road-exact' });
    return exactRoad;
  }

  // 8. 道路名包含匹配：同样受最小查询长度/最小路段数约束（配置驱动）
  const roadMinLength = matching.roadContainmentMinQueryLength ?? 3;
  const road = lookupRoad(roadIndex, name, {
    allowContainment: true,
    minQueryLength: roadMinLength,
    minSegments: matching.roadContainmentMinSegments ?? 1,
  });
  if (road) {
    log.info('place.resolved', { query: name, source: 'road', label: road.label, via: 'road-containment' });
    return road;
  }
  return null;
}
