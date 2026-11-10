/**
 * Overpass 响应 → 路网 JSON 转换（纯函数，无任何导入，Node/浏览器均可测试）。
 *
 * 输出 schema 与现网数据完全同构（mapdata/tools/parse_pbf.py 口径）：
 *   road = { id, h, n, c: [[lng,lat]…], r: [nodeId…], b?, t?, ly?, a?, o? }
 *   meta = { cityId, source, license, bbox, generated_at, road_count, highway_types, tiles? }
 *
 * 关键约束（engine/graph.js buildWalkGraph）：`r` 必须是 OSM 节点 id 数组且与 `c`
 * 一一对应——Overpass `out geom` 的 way 元素恰好同时返回 `nodes` 与 `geometry`，
 * 长度不一致（数据异常）的 way 直接丢弃，不给建图层制造半份错误数据。
 */

/** 保留的道路类型（与 mapdata/tools/parse_pbf.py 的 HIGHWAY_KEEP 完全一致） */
export const HIGHWAY_KEEP = new Set([
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary',
  'unclassified', 'residential', 'living_street', 'service', 'road',
  'pedestrian', 'footway', 'path', 'cycleway', 'steps', 'track',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
]);

/** 保留的通行权限标签（与 parse_pbf.py 的 ACCESS_KEYS 一致，oneway 单独存 `o`） */
const ACCESS_KEYS = ['foot', 'access', 'bicycle', 'motor_vehicle', 'motorcar', 'vehicle', 'horse', 'wheelchair'];

/**
 * 把 Overpass elements（way 数组）转换成路网数组。
 *
 * @param {Array<object>} elements Overpass JSON 的 elements
 * @returns {Array<object>} 路网数组（parse_pbf.py 同构 schema）
 */
export function overpassElementsToRoads(elements) {
  const roads = [];
  if (!Array.isArray(elements)) {
    return roads;
  }
  for (const element of elements) {
    if (!element || element.type !== 'way' || typeof element.id !== 'number') {
      continue;
    }
    const tags = element.tags || {};
    const highway = tags.highway;
    if (!HIGHWAY_KEEP.has(highway)) {
      continue;
    }
    const nodes = element.nodes;
    const geometry = element.geometry;
    if (!Array.isArray(nodes) || !Array.isArray(geometry) || nodes.length !== geometry.length) {
      continue;
    }
    if (nodes.length < 2) {
      continue;
    }
    const coords = [];
    const refs = [];
    for (let index = 0; index < nodes.length; index += 1) {
      const point = geometry[index];
      if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lon)) {
        break;
      }
      coords.push([Math.round(point.lon * 1e6) / 1e6, Math.round(point.lat * 1e6) / 1e6]);
      refs.push(nodes[index]);
    }
    if (refs.length !== nodes.length || refs.length < 2) {
      continue;
    }
    const road = { id: element.id, h: highway, n: tags.name ?? '', c: coords, r: refs };
    if (tags.bridge && tags.bridge !== 'no') {
      road.b = tags.bridge;
    }
    if (tags.tunnel && tags.tunnel !== 'no') {
      road.t = tags.tunnel;
    }
    const layerRaw = tags.layer;
    if (layerRaw && /^-?\d+$/.test(layerRaw.trim())) {
      road.ly = Number(layerRaw.trim());
    }
    const access = {};
    for (const key of ACCESS_KEYS) {
      if (tags[key] !== undefined) {
        access[key] = tags[key];
      }
    }
    if (Object.keys(access).length > 0) {
      road.a = access;
    }
    if (tags.oneway !== undefined) {
      road.o = tags.oneway;
    }
    roads.push(road);
  }
  return roads;
}

/**
 * 按 way id 去重（瓦片重叠抓回的同一 way 只保留一份；不做坐标合并）。
 *
 * @param {Array<object>} roads 多瓦片合并的路网数组
 * @returns {Array<object>} 去重后的路网数组
 */
export function dedupeRoadsById(roads) {
  const seen = new Set();
  const result = [];
  for (const road of roads) {
    if (seen.has(road.id)) {
      continue;
    }
    seen.add(road.id);
    result.push(road);
  }
  return result;
}

/**
 * 组装带 meta 的完整路网 JSON（与现网数据文件同构）。
 *
 * @param {object} options
 * @param {string} options.cityId 城市 id
 * @param {Array<object>} options.roads 转换并去重后的路网
 * @param {[number, number, number, number]} options.bbox 实际请求 bbox [minLng, minLat, maxLng, maxLat]
 * @param {Array<object>} options.tiles 瓦片记录（bbox/尝试记录/耗时），进 meta 留痕
 * @param {string} options.sourceHost 实际提供数据的镜像 host（多瓦片取首个成功者）
 * @param {string} options.generatedAt ISO 时间
 * @returns {{meta: object, roads: Array<object>}} 完整路网 JSON
 */
export function buildCityRoadsPayload({ cityId, roads, bbox, tiles, sourceHost, generatedAt }) {
  return {
    meta: {
      cityId,
      source: `OpenStreetMap via Overpass API (${sourceHost})，按需获取`,
      license: 'ODbL 1.0',
      bbox,
      generated_at: generatedAt,
      road_count: roads.length,
      highway_types: [...new Set(roads.map((road) => road.h))].sort(),
      tiles,
    },
    roads,
  };
}

/**
 * 获取结果校验：道路数低于阈值判失败（空实例/锚点错误/数据缺失都不能变成半份缓存）。
 *
 * @param {Array<object>} roads 转换后的路网
 * @param {number} minRoads 最低道路数
 * @throws {Error} 道路数不足
 */
export function assertRoadCount(roads, minRoads) {
  if (!Array.isArray(roads) || roads.length < minRoads) {
    throw new Error(`获取结果仅 ${roads?.length ?? 0} 条道路，低于最低要求 ${minRoads} 条（数据源可能不可用或范围有误）`);
  }
}
