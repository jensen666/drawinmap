/**
 * 硬失败归因的纯判定。
 *
 * 不读路网、不改规划。输入是每个约束点到三张图的最近距离，
 * 以及（可选）全城仍然吸不上去的点落在哪类 OSM 面上。
 *
 * 三张图：
 * - sample：语料实际拿去搜索的那张图（合成网，或被窗口/屏障改过的真实分区）
 * - region：同一真实窗口、去掉人工屏障之后的图；合成网没有这张图
 * - city：产品用的全城可步行主连通分量
 */

/** 与 quality.js 的 SNAP_HARD_GATE_METERS 一致；调用方应传入同一常量 */
export const DEFAULT_SNAP_METERS = 120;

/** 可通行面候选：公园、广场、步行区。草皮和球场单独算，不并进「该加可通行面」。 */
const WALKABLE_KINDS = new Set(['park', 'square']);

/** 明确不该穿的面：水面、建成区。 */
const BLOCKED_KINDS = new Set(['water', 'built']);

/**
 * 取一组数的最大值；空数组返回 0。
 *
 * @param {number[]} values 距离
 * @returns {number} 最大值
 */
function maxOf(values) {
  let max = 0;
  for (const value of values) {
    if (value > max) {
      max = value;
    }
  }
  return max;
}

/**
 * 统计 OSM 种类。
 *
 * @param {Array<{osm: string|null}>} points 点
 * @returns {Record<string, number>} 种类 → 个数
 */
function countKinds(points) {
  const counts = {};
  for (const point of points) {
    const kind = point.osm || 'none';
    counts[kind] = (counts[kind] || 0) + 1;
  }
  return counts;
}

/**
 * 在平票时按固定优先级选一个种类，避免水面被草皮盖住。
 *
 * @param {Record<string, number>} counts 种类计数
 * @returns {string} 胜出种类
 */
function majorityKind(counts) {
  const order = ['water', 'built', 'square', 'park', 'recreation', 'grass', 'none'];
  let best = 'none';
  let bestCount = -1;
  for (const kind of order) {
    const count = counts[kind] || 0;
    if (count > bestCount) {
      best = kind;
      bestCount = count;
    }
  }
  return best;
}

/**
 * 判定一次放置为什么过不了吸附硬门。
 *
 * @param {{synthetic: boolean, severed: boolean}} meta 语料图来源
 * @param {Array<{distSample: number, distRegion: number, distCity: number, outsideBbox: boolean, osm?: string|null}>} points 约束点
 * @param {number} [snapMeters] 吸附硬门（米）
 * @returns {object} 归因
 */
export function classifyPlacement(meta, points, snapMeters = DEFAULT_SNAP_METERS) {
  const snapSample = maxOf(points.map((point) => point.distSample));
  const snapRegion = maxOf(points.map((point) => point.distRegion));
  const snapCity = maxOf(points.map((point) => point.distCity));
  const farCity = points.filter((point) => point.distCity > snapMeters);
  const farInside = farCity.filter((point) => !point.outsideBbox);
  const farOutside = farCity.filter((point) => point.outsideBbox);

  let corpus = 'replay-mismatch';
  if (snapSample > snapMeters) {
    if (meta.synthetic) {
      corpus = 'synthetic';
    } else if (snapCity <= snapMeters) {
      corpus = meta.severed && snapRegion <= snapMeters ? 'corpus-sever' : 'corpus-window';
    } else if (farInside.length === 0) {
      corpus = 'outside-coverage';
    } else {
      corpus = 'centerline-gap';
    }
  }

  const product = snapCity > snapMeters ? 'city-snap-fail' : 'city-snap-ok';
  const osmUnmeasured = farInside.some((point) => point.osm === 'unmeasured');
  const osmCounts = countKinds(farInside);
  const osmMajority = osmUnmeasured ? 'unmeasured' : farInside.length > 0 ? majorityKind(osmCounts) : null;
  let gapBucket = null;
  if (osmUnmeasured && farInside.length > 0) {
    gapBucket = 'unmeasured';
  } else if (corpus === 'centerline-gap' || (product === 'city-snap-fail' && farInside.length > 0)) {
    if (WALKABLE_KINDS.has(osmMajority)) {
      gapBucket = 'walkable-surface';
    } else if (BLOCKED_KINDS.has(osmMajority)) {
      gapBucket = osmMajority === 'water' ? 'water' : 'built';
    } else if (osmMajority === 'grass' || osmMajority === 'recreation') {
      gapBucket = 'ambiguous-open';
    } else if (osmMajority === 'none') {
      gapBucket = 'unlabeled';
    } else if (osmMajority === null) {
      gapBucket = null;
    } else {
      gapBucket = 'unlabeled';
    }
  }

  return {
    corpus,
    product,
    snapSample,
    snapRegion,
    snapCity,
    farCity: farCity.length,
    farInside: farInside.length,
    farOutside: farOutside.length,
    osmCounts,
    osmMajority,
    gapBucket,
  };
}

/**
 * 汇总多条归因，供报告使用。
 *
 * @param {Array<{corpus: string, product: string, gapBucket: string|null}>} rows 样本归因
 * @returns {object} 计数
 */
export function summarizeAttributions(rows) {
  const corpus = {};
  const product = {};
  const gapBucket = {};
  for (const row of rows) {
    corpus[row.corpus] = (corpus[row.corpus] || 0) + 1;
    product[row.product] = (product[row.product] || 0) + 1;
    if (row.gapBucket) {
      gapBucket[row.gapBucket] = (gapBucket[row.gapBucket] || 0) + 1;
    }
  }
  return {
    count: rows.length,
    corpus,
    product,
    gapBucket,
  };
}
