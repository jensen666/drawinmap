/**
 * 语料装配：轮廓 × 路网 → 样本，并按几何分层做确定性划分。
 *
 * 划分口径（方案 §10.2）：
 * - 校准集（calibration）与留出集（holdout）按"几何分层"分层抽样：每个分层内
 *   按确定性哈希排序后逐个交替归入两集，不使用随机数；
 * - 最终留出集（final）额外包含"未见过的轮廓形态"与"未见过的路网区域"，
 *   它们在 calibration/holdout 中完全不出现。
 *
 * 语料只按几何属性与路网属性分层，不含任何图形名称/对象类别/地点语义；
 * 生产逻辑也不读取样本身份（样本身份只在本目录的夹具与回放脚本里使用）。
 */

import { createRandom, deriveSeed, hashString } from './random.mjs';
import { measureGeometry, pointDensityTag } from './geometry-metrics.mjs';
import { OUTLINE_FAMILIES, generateOutline } from './outline-generator.mjs';
import { allNetworkInstances, buildNetwork } from './roadnet.mjs';

/** 语料主种子（改动即整批语料变更，必须显式记录） */
export const CORPUS_MASTER_SEED = 20261101;

/** 语料版本标记：写进基线报告，便于区分不同阶段的冻结语料 */
export const CORPUS_VERSION = 'phase0';

/** 几何分层维度（每维一个取值） */
export const GEOMETRY_DIMENSIONS = [
  'dominant',
  'regularity',
  'notch',
  'gap',
  'protrusion',
  'curvature',
  'perimeterSpan',
  'constraintDensity',
  'parts',
  'noise',
  'pointDensity',
  'localScale',
];

/** 路网分层维度（每维一个取值） */
export const NETWORK_DIMENSIONS = ['density', 'orientation', 'connectivity', 'integrity'];

/** 约束密度分档：约束点数 / 包围盒对角线 */
const CONSTRAINT_DENSITY_LOW = 7;

/** 基准尺寸候选（米） */
const BASE_SIZES = [700, 900, 1100, 1300, 1600];

/** 窄间隙样本的基准尺寸（米）：必须让尺寸阶梯能表达该间隙（150m / widthRatio） */
const GAP_BASE_SIZE = 1500;

/**
 * 由约束点数与轮廓尺度给出约束密度分层。
 *
 * @param {number} constraintCount 约束点数
 * @param {number} diagonal 包围盒对角线（归一化单位）
 * @returns {string} low | high
 */
function constraintDensityTagOf(constraintCount, diagonal) {
  const ratio = constraintCount / Math.max(1e-9, diagonal);
  return ratio <= CONSTRAINT_DENSITY_LOW ? 'low' : 'high';
}

/**
 * 生成全部轮廓实例（按族 × 实例序号派生 seed）。
 *
 * @returns {Array<object>} 轮廓实例数组
 */
function buildOutlineInstances() {
  const instances = [];
  for (const family of OUTLINE_FAMILIES) {
    for (let index = 0; index < family.instances; index += 1) {
      const seed = deriveSeed(CORPUS_MASTER_SEED, 'outline', family.id, String(index));
      const outline = generateOutline({
        archetype: family.archetype,
        params: family.params,
        profile: family.profile,
        constraintLevel: family.constraintLevel,
        seed,
      });
      const measured = measureGeometry(outline.outlinePoints);
      const tags = {
        ...measured.tags,
        constraintDensity: constraintDensityTagOf(
          outline.constraintPoints.length,
          measured.measured.diagonal,
        ),
        parts: outline.parts && outline.parts.length > 1 ? 'multi' : 'single',
        pointDensity: pointDensityTag(outline.outlinePoints.length),
      };
      instances.push({
        id: `${family.id}#${index}`,
        family: family.id,
        archetype: family.archetype,
        reserved: Boolean(family.reserved),
        seed,
        outline,
        measured: measured.measured,
        tags,
      });
    }
  }
  return instances;
}

/**
 * 生成样本中心（在路网范围内做确定性抖动）。
 *
 * @param {object} network 路网实例
 * @param {number} seed 样本种子
 * @returns {{lat:number,lng:number}} 中心坐标
 */
function sampleCenterOf(network, seed) {
  const rand = createRandom(seed ^ 0x5bf03635);
  const isReal = network.kind === 'real';
  const latJitter = isReal ? 0.0025 : 0.0022;
  const lngJitter = isReal ? 0.0025 : 0.0022;
  return {
    lat: network.center.lat + (rand() * 2 - 1) * latJitter,
    lng: network.center.lng + (rand() * 2 - 1) * lngJitter,
  };
}

/**
 * 按"分层内确定性哈希"把样本分到校准集与留出集。
 *
 * 做法：每个样本属于若干个分层（几何维 × 取值、路网维 × 取值）；
 * 逐个处理样本时，看它在每个分层里"哪一侧当前更空"，取多数票决定归属，
 * 少数票平手时看它所属的最稀有分层。整个过程只看确定性哈希与计数器，
 * 不使用随机数，结果可复现。
 *
 * @param {Array<object>} samples 样本数组（需已带 layers 字段）
 * @returns {Map<string, string>} 样本 id → 集合名
 */
function assignCalibrationHoldout(samples) {
  const layerMembers = new Map();
  for (const sample of samples) {
    for (const layer of sample.layers) {
      if (!layerMembers.has(layer)) {
        layerMembers.set(layer, []);
      }
      layerMembers.get(layer).push(sample.id);
    }
  }
  const layerCounts = new Map();
  for (const [layer, members] of layerMembers) {
    layerCounts.set(layer, { calibration: 0, holdout: 0, size: members.length });
  }

  const assignment = new Map();
  const ordered = [...samples].sort((a, b) => hashString(a.id) - hashString(b.id));
  for (const sample of ordered) {
    let calibrationVotes = 0;
    let holdoutVotes = 0;
    let rarestLayer = null;
    let rarestSize = Infinity;
    for (const layer of sample.layers) {
      const counts = layerCounts.get(layer);
      const preference = counts.calibration <= counts.holdout ? 'calibration' : 'holdout';
      if (preference === 'calibration') {
        calibrationVotes += 1;
      } else {
        holdoutVotes += 1;
      }
      if (counts.size < rarestSize) {
        rarestSize = counts.size;
        rarestLayer = layer;
      }
    }
    let target;
    if (calibrationVotes !== holdoutVotes) {
      target = calibrationVotes > holdoutVotes ? 'calibration' : 'holdout';
    } else {
      const counts = layerCounts.get(rarestLayer);
      target = counts.calibration <= counts.holdout ? 'calibration' : 'holdout';
    }
    assignment.set(sample.id, target);
    for (const layer of sample.layers) {
      layerCounts.get(layer)[target] += 1;
    }
  }
  return assignment;
}

/**
 * 构建完整语料（样本数组 + 集合划分 + 分层清单）。
 *
 * @returns {{samples:Array, sets:{calibration:Array,holdout:Array,final:Array}, layerIndex:object}} 语料
 */
export function buildCorpus() {
  const outlineInstances = buildOutlineInstances();
  const networkInstances = allNetworkInstances();
  const usableNetworks = networkInstances.filter((instance) => !instance.reserved);
  const reservedNetworks = networkInstances.filter((instance) => instance.reserved);
  // 网络顺序按 id 哈希排序（确定性），再轮转分配给样本
  const rotated = [...usableNetworks].sort((a, b) => hashString(a.id) - hashString(b.id));

  // 留出集归属：预留轮廓族（未见过的轮廓形态）或预留路网（未见过的路网区域）
  const reservedStride = 9;
  const reservedOffset = 4;
  const samples = [];
  // 轮转游标独立推进：普通样本与"未见轮廓族"样本共用普通路网，
  // 保证每个普通路网都会出现在 calibration/holdout 里（不因取模同余被整体跳过）
  let usableCursor = 0;
  let reservedCursor = 0;
  outlineInstances.forEach((instance, index) => {
    const useReservedNetwork = !instance.reserved && index % reservedStride === reservedOffset;
    const networkInstance = useReservedNetwork
      ? reservedNetworks[reservedCursor++ % reservedNetworks.length]
      : rotated[usableCursor++ % rotated.length];
    const network = buildNetwork(networkInstance);
    const seed = deriveSeed(CORPUS_MASTER_SEED, 'sample', instance.id);
    const rand = createRandom(seed);
    const hasGap = instance.outline.features.some((feature) => feature.kind === 'gap');
    const baseSizeMeters = hasGap
      ? GAP_BASE_SIZE
      : BASE_SIZES[Math.floor(rand() * BASE_SIZES.length)];
    const layers = [
      ...GEOMETRY_DIMENSIONS.map((dimension) => `geo:${dimension}=${instance.tags[dimension]}`),
      ...NETWORK_DIMENSIONS.map((dimension) => `net:${dimension}=${network.tags[dimension]}`),
      // 路网实例本身也参与分层：保证每个路网实例在校准集与留出集里都出现
      `net:instance=${network.id}`,
    ];
    samples.push({
      id: `C${String(samples.length + 1).padStart(3, '0')}`,
      seed,
      family: instance.family,
      archetype: instance.archetype,
      outline: instance.outline,
      geometryTags: { ...instance.tags },
      geometryMeasured: instance.measured,
      networkId: network.id,
      networkKind: network.kind,
      networkTags: { ...network.tags },
      networkProps: network.props,
      networkReserved: network.reserved,
      baseSizeMeters,
      center: sampleCenterOf(network, seed),
      layers,
      reserved: instance.reserved || network.reserved,
    });
  });

  const finalSamples = samples.filter((sample) => sample.reserved);
  const splitSamples = samples.filter((sample) => !sample.reserved);
  const assignment = assignCalibrationHoldout(splitSamples);
  for (const sample of samples) {
    sample.set = sample.reserved ? 'final' : assignment.get(sample.id);
  }

  const sets = {
    calibration: samples.filter((sample) => sample.set === 'calibration'),
    holdout: samples.filter((sample) => sample.set === 'holdout'),
    final: samples.filter((sample) => sample.set === 'final'),
  };

  const layerIndex = buildLayerIndex(samples);
  return { samples, sets, layerIndex };
}

/**
 * 统计每个分层（维度 × 取值）的样本数。
 *
 * @param {Array<object>} samples 样本数组
 * @returns {object} 分层 → 样本数
 */
function buildLayerIndex(samples) {
  const index = {};
  for (const sample of samples) {
    for (const layer of sample.layers) {
      index[layer] = (index[layer] || 0) + 1;
    }
  }
  return index;
}

let cachedCorpus = null;

/**
 * 获取（并缓存）完整语料。
 *
 * @returns {{samples:Array, sets:{calibration:Array,holdout:Array,final:Array}, layerIndex:object}} 语料
 */
export function getCorpus() {
  if (!cachedCorpus) {
    cachedCorpus = buildCorpus();
  }
  return cachedCorpus;
}

/**
 * 按集合名取样本。
 *
 * @param {'calibration'|'holdout'|'final'|'all'} name 集合名
 * @returns {Array<object>} 样本数组
 */
export function getSamples(name) {
  const { sets } = getCorpus();
  if (name === 'all') {
    return [...sets.calibration, ...sets.holdout, ...sets.final];
  }
  return sets[name] || [];
}
