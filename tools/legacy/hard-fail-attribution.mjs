/**
 * 把基线里的吸附硬失败拆开：语料图造成的，还是全城路网也放不下。
 *
 * 不调用候选搜索，不改生产逻辑。放置用基线记下的中心、尺寸、朝向
 * （这 72 个样本的偏移都是 0）。吸附距离与规划器相同：最近可步行边，
 * 主连通分量，最多 8 圈网格。
 *
 * 用法：
 *   node tools/hard-fail-attribution.mjs
 *   node tools/hard-fail-attribution.mjs --areas=.tmp/hard-fail-areas.json
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEdgeIndex, buildWalkGraph, findLargestComponent, nearestEdge } from '../../web/src/engine/graph.js';
import { projectShape } from '../../web/src/engine/planner.js';
import { SNAP_HARD_GATE_METERS } from '../../web/src/engine/quality.js';
import { buildShapeModel } from '../../web/src/engine/shape-model.js';
import { setLevel } from '../../web/src/log/index.js';
import { getCorpus } from '../../test/fixtures/corpus/corpus.mjs';
import { REAL_REGIONS, buildNetwork, loadWalkableRoads, networkInstanceById } from '../../test/fixtures/corpus/roadnet.mjs';
import { classifyPlacement, summarizeAttributions } from '../hard-fail-classify.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MAX_RINGS = 8;
const KIND_PRIORITY = ['water', 'square', 'park', 'recreation', 'grass', 'built'];

/**
 * 读取命令行参数。
 *
 * @param {string[]} argv 参数
 * @returns {{baseline: string, areas: string|null, out: string}} 路径
 */
function parseArgs(argv) {
  const options = {
    baseline: path.join(ROOT, 'test', 'fixtures', 'corpus', 'baseline-phase0.json'),
    areas: null,
    out: path.join(ROOT, '.tmp', 'hard-fail-attribution.json'),
  };
  for (const arg of argv) {
    if (arg.startsWith('--baseline=')) {
      options.baseline = path.resolve(arg.slice('--baseline='.length));
    } else if (arg.startsWith('--areas=')) {
      options.areas = path.resolve(arg.slice('--areas='.length));
    } else if (arg.startsWith('--out=')) {
      options.out = path.resolve(arg.slice('--out='.length));
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return options;
}

/**
 * 道路坐标的外包范围。
 *
 * @param {Array<{c: Array<[number, number]>}>} roads 道路
 * @returns {{minLat: number, maxLat: number, minLng: number, maxLng: number}} 范围
 */
function boundsOfRoads(roads) {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const road of roads) {
    for (const [lon, lat] of road.c) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLng) minLng = lon;
      if (lon > maxLng) maxLng = lon;
    }
  }
  return { minLat, maxLat, minLng, maxLng };
}

/**
 * 点是否落在路网坐标范围外。
 *
 * @param {number} lat 纬度
 * @param {number} lng 经度
 * @param {{minLat: number, maxLat: number, minLng: number, maxLng: number}} bounds 范围
 * @returns {boolean} 是否在范围外
 */
function outsideBounds(lat, lng, bounds) {
  return lat < bounds.minLat || lat > bounds.maxLat || lng < bounds.minLng || lng > bounds.maxLng;
}

/**
 * 最近可步行边的距离（米）。找不到边时记无穷大。
 *
 * @param {object} index 边索引
 * @param {object} graph 路网图
 * @param {number} lat 纬度
 * @param {number} lng 经度
 * @returns {number} 距离
 */
function snapDistance(index, graph, lat, lng) {
  const hit = nearestEdge(index, graph, lng, lat, MAX_RINGS);
  return hit ? hit.distance : Number.POSITIVE_INFINITY;
}

/**
 * 射线法判断点是否在环内。环坐标是 [lon, lat]。
 *
 * @param {Array<[number, number]>} ring 环
 * @param {number} lon 经度
 * @param {number} lat 纬度
 * @returns {boolean} 是否在环内
 */
function ringContains(ring, lon, lat) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const crosses = (yi > lat) !== (yj > lat);
    if (crosses && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * 把多边形按外包矩形放进网格，查询时只看点所在的格子。
 *
 * @param {Array<object>} polygons 多边形
 * @returns {{lookup: (lon: number, lat: number) => string}} 查询器
 */
function buildAreaIndex(polygons) {
  const cell = 0.005;
  const grid = new Map();
  for (const polygon of polygons) {
    const [minLon, minLat, maxLon, maxLat] = polygon.bbox;
    const x0 = Math.floor(minLon / cell);
    const x1 = Math.floor(maxLon / cell);
    const y0 = Math.floor(minLat / cell);
    const y1 = Math.floor(maxLat / cell);
    for (let x = x0; x <= x1; x += 1) {
      for (let y = y0; y <= y1; y += 1) {
        const key = `${x},${y}`;
        const list = grid.get(key);
        if (list) {
          list.push(polygon);
        } else {
          grid.set(key, [polygon]);
        }
      }
    }
  }

  /**
   * 查一个点落在哪类面上。多种重叠时水面优先于公园，公园优先于建成区。
   *
   * @param {number} lon 经度
   * @param {number} lat 纬度
   * @returns {string} 种类；没有命中返回 none
   */
  function lookup(lon, lat) {
    const list = grid.get(`${Math.floor(lon / cell)},${Math.floor(lat / cell)}`) || [];
    const hits = new Set();
    for (const polygon of list) {
      const [minLon, minLat, maxLon, maxLat] = polygon.bbox;
      if (lon < minLon || lat < minLat || lon > maxLon || lat > maxLat) {
        continue;
      }
      if (!ringContains(polygon.outer, lon, lat)) {
        continue;
      }
      const inHole = (polygon.inners || []).some((inner) => ringContains(inner, lon, lat));
      if (!inHole) {
        hits.add(polygon.kind);
      }
    }
    for (const kind of KIND_PRIORITY) {
      if (hits.has(kind)) {
        return kind;
      }
    }
    return 'none';
  }

  return { lookup, polygonCount: polygons.length };
}

/**
 * 去掉人工屏障后的同一窗口。缓存键不能用原 id，否则会拿到被切断的图。
 *
 * @param {object} region 真实分区定义
 * @returns {object} 路网
 */
function openRegionNetwork(region) {
  return buildNetwork({ ...region, id: `${region.id}-open`, sever: false });
}

/**
 * 主流程。
 *
 * @returns {Promise<void>}
 */
async function main() {
  const options = parseArgs(process.argv.slice(2));
  setLevel('off');
  const baseline = JSON.parse(readFileSync(options.baseline, 'utf8'));
  const hard = baseline.samples.filter((sample) => (sample.qualityGate?.hardFailures || []).includes('snap-max'));
  console.log(`[hard-fail] 基线硬失败 ${hard.length} 个，吸附硬门 ${SNAP_HARD_GATE_METERS}m`);

  const corpus = getCorpus();
  const byId = new Map(corpus.samples.map((sample) => [sample.id, sample]));
  const roads = loadWalkableRoads();
  const cityBounds = boundsOfRoads(roads);
  const cityGraph = buildWalkGraph(roads);
  const cityIndex = buildEdgeIndex(cityGraph, 0.005, findLargestComponent(cityGraph));
  console.log(
    `[hard-fail] 全城可步行道路 ${roads.length} 条，范围 ` +
      `${cityBounds.minLat.toFixed(4)},${cityBounds.minLng.toFixed(4)} ~ ` +
      `${cityBounds.maxLat.toFixed(4)},${cityBounds.maxLng.toFixed(4)}`,
  );

  let areas = null;
  if (options.areas) {
    const payload = JSON.parse(readFileSync(options.areas, 'utf8'));
    areas = buildAreaIndex(payload.polygons || []);
    console.log(`[hard-fail] 面数据 ${areas.polygonCount} 个`);
  } else {
    console.log('[hard-fail] 未提供面数据，覆盖内空洞先记为 unmeasured');
  }

  const regionById = new Map(REAL_REGIONS.map((region) => [region.id, region]));
  const rows = [];
  for (let index = 0; index < hard.length; index += 1) {
    const record = hard[index];
    const sample = byId.get(record.id);
    if (!sample) {
      throw new Error(`语料里没有 ${record.id}`);
    }
    const region = regionById.get(sample.networkId) || null;
    const synthetic = sample.networkId.startsWith('S');
    const severed = Boolean(region?.sever);
    const sampleNetwork = buildNetwork(networkInstanceById(sample.networkId));
    const regionNetwork = !synthetic && severed ? openRegionNetwork(region) : sampleNetwork;
    const outline = sample.outline;
    const customShape = {
      name: sample.id,
      constraintPoints: outline.constraintPoints,
      outlinePoints: outline.outlinePoints,
    };
    if (outline.parts?.length) {
      customShape.parts = outline.parts;
    }
    if (outline.features?.length) {
      customShape.features = outline.features;
    }
    const model = buildShapeModel({ customShape });
    const projected = projectShape(
      model.constraints.map((constraint) => constraint.point),
      sample.center,
      record.sizeMeters,
      record.rotationDeg,
    );
    const points = projected.map(([lat, lng], pointIndex) => {
      const distSample = snapDistance(sampleNetwork.edgeIndex, sampleNetwork.graph, lat, lng);
      const distRegion = regionNetwork === sampleNetwork
        ? distSample
        : snapDistance(regionNetwork.edgeIndex, regionNetwork.graph, lat, lng);
      const distCity = snapDistance(cityIndex, cityGraph, lat, lng);
      const outside = outsideBounds(lat, lng, cityBounds);
      let osm = null;
      if (distCity > SNAP_HARD_GATE_METERS && !outside) {
        osm = areas ? areas.lookup(lng, lat) : 'unmeasured';
      }
      return {
        index: pointIndex,
        key: Boolean(model.constraints[pointIndex].key),
        lat,
        lng,
        distSample,
        distRegion,
        distCity,
        outsideBbox: outside,
        osm,
      };
    });
    const attribution = classifyPlacement(
      { synthetic, severed },
      points,
      SNAP_HARD_GATE_METERS,
    );
    const far = points
      .filter((point) => point.distCity > SNAP_HARD_GATE_METERS)
      .map((point) => ({
        lat: Math.round(point.lat * 1e6) / 1e6,
        lng: Math.round(point.lng * 1e6) / 1e6,
        distCity: Math.round(point.distCity * 10) / 10,
        outsideBbox: point.outsideBbox,
        osm: point.osm,
        key: point.key,
      }));
    rows.push({
      id: record.id,
      set: record.set,
      family: record.family,
      networkId: record.networkId,
      networkTags: record.networkTags,
      sizeMeters: record.sizeMeters,
      rotationDeg: record.rotationDeg,
      center: record.center,
      ...attribution,
      farCityPoints: far,
    });
    console.log(
      `  [${index + 1}/${hard.length}] ${record.id} ${record.networkId} ` +
        `${attribution.corpus} / ${attribution.product} ` +
        `语料 ${Math.round(attribution.snapSample)}m 全城 ${Math.round(attribution.snapCity)}m ` +
        (attribution.gapBucket ? attribution.gapBucket : ''),
    );
  }

  const summary = summarizeAttributions(rows);
  const pointKinds = {};
  for (const row of rows) {
    for (const point of row.farCityPoints) {
      if (point.outsideBbox) {
        pointKinds.outside = (pointKinds.outside || 0) + 1;
      } else {
        const kind = point.osm || 'none';
        pointKinds[kind] = (pointKinds[kind] || 0) + 1;
      }
    }
  }
  const payload = {
    generatedAt: new Date().toISOString(),
    snapMeters: SNAP_HARD_GATE_METERS,
    baseline: options.baseline,
    areas: options.areas,
    cityBounds,
    hardCount: hard.length,
    summary,
    pointKinds,
    replayMismatch: rows.filter((row) => row.corpus === 'replay-mismatch').map((row) => row.id),
    rows,
  };
  mkdirSync(path.dirname(options.out), { recursive: true });
  writeFileSync(options.out, JSON.stringify(payload, null, 2));
  console.log(`[hard-fail] 样本归因 ${JSON.stringify(summary)}`);
  console.log(`[hard-fail] 全城超 ${SNAP_HARD_GATE_METERS}m 的点 ${JSON.stringify(pointKinds)}`);
  console.log(`[hard-fail] 写出 ${options.out}`);
  if (payload.replayMismatch.length > 0) {
    console.log(`[hard-fail] 重放对不上基线：${payload.replayMismatch.join(',')}`);
    process.exitCode = 2;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
