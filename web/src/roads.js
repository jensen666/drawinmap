import * as L from '../vendor/leaflet.esm.js';
import { loadRoadData } from './road-data.js';
import { createLogger } from './log/index.js';

/** 模块 logger */
const log = createLogger('roads');

/**
 * 路网分组：按道路类型分色绘制为参考图层，避免遮挡底图。
 */
const ROAD_GROUPS = [
  {
    key: 'major',
    label: '主干道',
    types: new Set([
      'motorway', 'trunk', 'primary', 'secondary',
      'motorway_link', 'trunk_link', 'primary_link', 'secondary_link',
    ]),
    style: { color: '#1e293b', weight: 2, opacity: 0.85 },
  },
  {
    key: 'minor',
    label: '支路',
    types: new Set([
      'tertiary', 'tertiary_link', 'residential', 'unclassified',
      'living_street', 'service', 'road',
    ]),
    style: { color: '#94a3b8', weight: 1.2, opacity: 0.8 },
  },
  {
    key: 'slow',
    label: '慢行',
    types: new Set(['pedestrian', 'footway', 'path', 'cycleway', 'steps', 'track']),
    style: { color: '#60a5fa', weight: 1, opacity: 0.7 },
  },
];

/**
 * 加载本地路网数据，绘制为可叠加的参考图层。
 *
 * 数据地址来自地点配置的 `roads.dataUrl`（由 main.js 启动时 configureRoadData 注入），
 * 页面通过静态服务器访问该 JSON（与其他模块共享缓存）。
 *
 * @param {L.Map} map Leaflet 地图实例
 * @returns {Promise<{layer: L.LayerGroup, roadCount: number, pointCount: number}>} 路网图层与统计
 */
export async function createRoadLayer(map) {
  const roads = await loadRoadData();

  const segmentsByKey = new Map();
  let pointCount = 0;
  for (const road of roads) {
    if (!Array.isArray(road.c) || road.c.length < 2) {
      continue;
    }
    const groupDef = ROAD_GROUPS.find((item) => item.types.has(road.h)) || ROAD_GROUPS[1];
    const latlngs = road.c.map(([lon, lat]) => [lat, lon]);
    pointCount += latlngs.length;
    if (!segmentsByKey.has(groupDef.key)) {
      segmentsByKey.set(groupDef.key, []);
    }
    segmentsByKey.get(groupDef.key).push(latlngs);
  }

  const layer = L.layerGroup();
  for (const groupDef of ROAD_GROUPS) {
    const segments = segmentsByKey.get(groupDef.key);
    if (!segments || segments.length === 0) {
      continue;
    }
    // 多段折线合并为单个 Path，避免 2 万多个独立图层带来的性能问题
    L.polyline(segments, {
      ...groupDef.style,
      interactive: false,
      smoothFactor: 1.2,
    }).addTo(layer);
  }

  log.info('roads.layer.ready', { roads: roads.length, points: pointCount });

  return { layer, roadCount: roads.length, pointCount };
}
