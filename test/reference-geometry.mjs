/**
 * T-B4c：bbox 4→1 收敛 + reference 分层倒挂修复的**等价性**测试（清理方案 2026-11-09 §3.2 B4）。
 *
 * 背景：
 * - `reference/geometry.js:13`、`path-data.js:107-117`、`rings.js:66-75`、`convert.js:179-187`
 *   各手抄一份 min/max 扫描；收敛到 `engine/geo.js` 的 `bboxOf` 后，四个调用方必须与
 *   **改前逐点/逐字段一致**（不是"看起来一样"）。
 * - `reference/{geometry,rings,convert}.js` 此前反向 import `agent/shape-validate.js` 的纯几何函数；
 *   现下沉 `engine/polygon.js`，agent 侧保留同名薄 re-export。本测试同时用静态断言锁住方向。
 *
 * 期望值口径：FIXTURE 是**改动前**（HEAD 965efd9）用原实现跑同一批 fixture 生成并固化的
 * golden（`tools` 外的临时生成脚本已删除）；改后断言逐字段相等。fixture 里的
 * `"Infinity"` / `"-Infinity"` 字符串是空点集包围盒的非有限值编码（JSON 不支持 Infinity）。
 *
 * 运行：node test/reference-geometry.mjs
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

import { bboxOf } from '../web/src/engine/geo.js';
import { bbox, normalizeClosedRing, normalizationParams } from '../web/src/reference/geometry.js';
import { parsePathData } from '../web/src/reference/path-data.js';
import { classifyRings } from '../web/src/reference/rings.js';
import { convertSvg } from '../web/src/reference/convert.js';

let checks = 0;
let failures = 0;

/**
 * 断言工具：记录通过/失败计数（失败必须体现在退出码里）。
 *
 * @param {string} label 断言描述
 * @param {() => void} fn 断言体（throw 即失败）
 */
function check(label, fn) {
  checks += 1;
  try {
    fn();
    console.log(`[check] ${label} -> PASS`);
  } catch (error) {
    failures += 1;
    console.log(`[check] ${label} -> FAIL ${error.message}`);
  }
}

/**
 * 数值编码：非有限值转为字符串（与改前 fixture 生成脚本同口径）。
 *
 * @param {number} value 数值
 * @returns {number|string}
 */
function expr(value) {
  if (!Number.isFinite(value)) return value > 0 ? 'Infinity' : '-Infinity';
  return value;
}

const round = (value, digits = 9) => Number(Number(value).toFixed(digits));
const ptsOut = (points) => points.map(([x, y]) => [round(x), round(y)]);

/**
 * 包围盒编码（六字段，与旧实现返回结构一致）。
 *
 * @param {{minX: number, minY: number, maxX: number, maxY: number, width: number, height: number}} box 包围盒
 * @returns {object} 可比较对象
 */
function bboxOut(box) {
  return {
    minX: expr(box.minX),
    minY: expr(box.minY),
    maxX: expr(box.maxX),
    maxY: expr(box.maxY),
    width: expr(box.width),
    height: expr(box.height),
  };
}

// ---------- 改前 golden（HEAD 965efd9 生成，勿手改数值） ----------
const FIXTURE = {
  "bbox": {
    "quad": {"minX":0,"minY":0,"maxX":10,"maxY":5,"width":10,"height":5},
    "negative": {"minX":-3.5,"minY":-2.25,"maxX":1.5,"maxY":7.75,"width":5,"height":10},
    "decimals": {"minX":-0.5,"minY":-0.125,"maxX":0.875,"maxY":0.75,"width":1.375,"height":0.875},
    "single": {"minX":2,"minY":3,"maxX":2,"maxY":3,"width":0,"height":0},
    "empty": {
      "minX": "Infinity",
      "minY": "Infinity",
      "maxX": "-Infinity",
      "maxY": "-Infinity",
      "width": "-Infinity",
      "height": "-Infinity",
    },
    "collinear": {"minX":0,"minY":0,"maxX":2,"maxY":2,"width":2,"height":2},
    "large": {"minX":1000000,"minY":-1000000,"maxX":1000003,"maxY":-999998,"width":3,"height":2},
  },
  "pathData": {
    "explicitClose": {"subpaths":[{"points":[[10,10],[90,10],[90,90],[10,90]],"closed":true}],"warningCount":0},
    "implicitClose": {"subpaths":[{"points":[[0,0],[10,0],[10,10],[0,10]],"closed":true}],"warningCount":0},
    "open": {"subpaths":[{"points":[[0,0],[10,0],[10,10]],"closed":false}],"warningCount":0},
    "closeWithinTolerance": {"subpaths":[{"points":[[0,0],[10,0],[10,10],[0.00001,0]],"closed":false}],"warningCount":0},
    "farFromClose": {"subpaths":[{"points":[[0,0],[100,0],[100,100],[0,0.001]],"closed":false}],"warningCount":0},
    "twoSubpaths": {
      "subpaths": [
        {"points":[[0,0],[10,0],[10,10]],"closed":true},
        {"points":[[20,20],[30,20],[30,30]],"closed":true},
      ],
      "warningCount": 0,
    },
    "withCurves": {
      "subpaths": [
        {
          "points": [
            [0,0],
            [2.72,0.28],
            [4.96,1.04],
            [6.84,2.16],
            [8.48,3.52],
            [10,5],
            [11.52,6.48],
            [13.16,7.84],
            [15.04,8.96],
            [17.28,9.72],
            [20,10],
            [22.653061224,10.204081633],
            [24.897959184,10.816326531],
            [26.734693878,11.836734694],
            [28.163265306,13.265306122],
            [29.183673469,15.102040816],
            [29.795918367,17.346938776],
            [30,20],
          ],
          "closed": true,
        },
      ],
      "warningCount": 0,
    },
    "singlePointSubpath": {"subpaths":[{"points":[[0,0],[4,0],[4,4]],"closed":true}],"warningCount":0},
    "relativeAndHV": {"subpaths":[{"points":[[0,0],[10,0],[10,10],[0,10]],"closed":true}],"warningCount":0},
  },
  "rings": {
    "outerWithHole": {
      "rings": [
        {
          "index": 0,
          "closed": true,
          "area": 10000,
          "bbox": {"minX":0,"minY":0,"maxX":100,"maxY":100,"width":100,"height":100},
          "depth": 0,
          "parents": [],
          "role": "main",
        },
        {
          "index": 1,
          "closed": true,
          "area": 3600,
          "bbox": {"minX":20,"minY":20,"maxX":80,"maxY":80,"width":60,"height":60},
          "depth": 1,
          "parents": [0],
          "role": "hole",
        },
      ],
      "main": 0,
      "holes": [1],
      "parts": [],
      "strays": [],
      "warningCount": 0,
    },
    "outerWithPart": {
      "rings": [
        {
          "index": 0,
          "closed": true,
          "area": 10000,
          "bbox": {"minX":0,"minY":0,"maxX":100,"maxY":100,"width":100,"height":100},
          "depth": 0,
          "parents": [],
          "role": "main",
        },
        {
          "index": 1,
          "closed": true,
          "area": 1600,
          "bbox": {"minX":200,"minY":0,"maxX":240,"maxY":40,"width":40,"height":40},
          "depth": 0,
          "parents": [],
          "role": "part",
        },
      ],
      "main": 0,
      "holes": [],
      "parts": [1],
      "strays": [],
      "warningCount": 0,
    },
    "outerWithStray": {
      "rings": [
        {
          "index": 0,
          "closed": true,
          "area": 10000,
          "bbox": {"minX":0,"minY":0,"maxX":100,"maxY":100,"width":100,"height":100},
          "depth": 0,
          "parents": [],
          "role": "main",
        },
        {
          "index": 1,
          "closed": true,
          "area": 9,
          "bbox": {"minX":200,"minY":0,"maxX":203,"maxY":3,"width":3,"height":3},
          "depth": 0,
          "parents": [],
          "role": "stray",
        },
      ],
      "main": 0,
      "holes": [],
      "parts": [],
      "strays": [1],
      "warningCount": 1,
    },
    "degenerateAndOpen": {
      "rings": [
        {
          "index": 1,
          "closed": false,
          "area": 100,
          "bbox": {"minX":0,"minY":0,"maxX":10,"maxY":10,"width":10,"height":10},
          "depth": 0,
          "parents": [],
          "role": "main",
        },
        {
          "index": 2,
          "closed": true,
          "area": 25,
          "bbox": {"minX":50,"minY":50,"maxX":55,"maxY":55,"width":5,"height":5},
          "depth": 0,
          "parents": [],
          "role": "part",
        },
      ],
      "main": 1,
      "holes": [],
      "parts": [2],
      "strays": [],
      "warningCount": 1,
    },
  },
  "svg": {
    "square": {
      "status": "accepted",
      "reasonCodes": [],
      "degenerateMessage": null,
      "warningCount": 0,
      "diagnostics": {
        "subpathCount": 1,
        "ringCount": 1,
        "outerRingCount": 1,
        "holeCount": 0,
        "partCount": 0,
        "strayCount": 0,
        "mainArea": 6400,
        "mainClosed": true,
        "holeAreaRatio": 0,
      },
      "R": {"sourcePointCount":4,"mainLength":4000},
      "T": {
        "pointCount": 320,
        "aspect": 1,
        "area": 1,
        "bounds": {"minX":-0.5,"minY":-0.5,"maxX":0.5,"maxY":0.5},
        "simplification": null,
      },
      "metrics": {
        "sourceToTargetMeanPct": 0,
        "sourceToTargetMaxPct": 0,
        "targetToSourceMaxPct": 0,
        "refinementEpsilon": 0,
        "aspect": 1,
        "area": 1,
        "targetPointCount": 320,
        "refinePointCount": 4000,
      },
    },
    "bowtie": {
      "status": "rejected",
      "reasonCodes": ["no-outer-contour"],
      "degenerateMessage": null,
      "warningCount": 2,
      "diagnostics": {
        "subpathCount": 1,
        "ringCount": 0,
        "outerRingCount": 0,
        "holeCount": 0,
        "partCount": 0,
        "strayCount": 0,
        "mainArea": 0,
        "mainClosed": false,
        "holeAreaRatio": 0,
      },
      "R": null,
      "T": null,
      "metrics": null,
    },
    "multiPart": {
      "status": "rejected",
      "reasonCodes": ["multi-part"],
      "degenerateMessage": null,
      "warningCount": 0,
      "diagnostics": {
        "subpathCount": 2,
        "ringCount": 2,
        "outerRingCount": 2,
        "holeCount": 0,
        "partCount": 1,
        "strayCount": 0,
        "mainArea": 600,
        "mainClosed": true,
        "holeAreaRatio": 0,
      },
      "R": {"sourcePointCount":4,"mainLength":4000},
      "T": null,
      "metrics": {
        "sourceToTargetMeanPct": 0,
        "sourceToTargetMaxPct": 0,
        "targetToSourceMaxPct": 0,
        "refinementEpsilon": 0,
        "aspect": 0.6667,
        "area": 0.666667,
        "targetPointCount": 320,
        "refinePointCount": 4000,
      },
    },
    "triangle": {
      "status": "accepted",
      "reasonCodes": [],
      "degenerateMessage": null,
      "warningCount": 0,
      "diagnostics": {
        "subpathCount": 1,
        "ringCount": 1,
        "outerRingCount": 1,
        "holeCount": 0,
        "partCount": 0,
        "strayCount": 0,
        "mainArea": 1250,
        "mainClosed": true,
        "holeAreaRatio": 0,
      },
      "R": {"sourcePointCount":3,"mainLength":4000},
      "T": {
        "pointCount": 320,
        "aspect": 0.9965,
        "area": 0.500504,
        "bounds": {"minX":-0.5,"minY":-0.49825593574668253,"maxX":0.5,"maxY":0.49825593574668253},
        "simplification": null,
      },
      "metrics": {
        "sourceToTargetMeanPct": 0.1239,
        "sourceToTargetMaxPct": 0.2753,
        "targetToSourceMaxPct": 0.1744,
        "refinementEpsilon": 0,
        "aspect": 0.9965,
        "area": 0.500504,
        "targetPointCount": 320,
        "refinePointCount": 4000,
      },
    },
    "unclosed": {
      "status": "rejected",
      "reasonCodes": ["unclosed-contour"],
      "degenerateMessage": null,
      "warningCount": 0,
      "diagnostics": {
        "subpathCount": 1,
        "ringCount": 1,
        "outerRingCount": 1,
        "holeCount": 0,
        "partCount": 0,
        "strayCount": 0,
        "mainArea": 6400,
        "mainClosed": false,
        "holeAreaRatio": 0,
      },
      "R": {"sourcePointCount":4,"mainLength":4000},
      "T": null,
      "metrics": {
        "sourceToTargetMeanPct": 0,
        "sourceToTargetMaxPct": 0,
        "targetToSourceMaxPct": 0,
        "refinementEpsilon": 0,
        "aspect": 1,
        "area": 1,
        "targetPointCount": 320,
        "refinePointCount": 4000,
      },
    },
    "tiny": {
      "status": "accepted",
      "reasonCodes": [],
      "degenerateMessage": null,
      "warningCount": 0,
      "diagnostics": {
        "subpathCount": 1,
        "ringCount": 1,
        "outerRingCount": 1,
        "holeCount": 0,
        "partCount": 0,
        "strayCount": 0,
        "mainArea": 0.00040000000035433914,
        "mainClosed": true,
        "holeAreaRatio": 0,
      },
      "R": {"sourcePointCount":4,"mainLength":4000},
      "T": {
        "pointCount": 320,
        "aspect": 1,
        "area": 1,
        "bounds": {
          "minX": -0.5000000000001776,
          "minY": -0.49999999999982236,
          "maxX": 0.49999999999982236,
          "maxY": 0.5000000000001776,
        },
        "simplification": null,
      },
      "metrics": {
        "sourceToTargetMeanPct": 0,
        "sourceToTargetMaxPct": 0,
        "targetToSourceMaxPct": 0,
        "refinementEpsilon": 0,
        "aspect": 1,
        "area": 1,
        "targetPointCount": 320,
        "refinePointCount": 4000,
      },
    },
  },
  "normalize": {
    "quad": {
      "params": {
        "centerX": 5,
        "centerY": 2.5,
        "span": 10,
        "bbox": {"minX":0,"minY":0,"maxX":10,"maxY":5,"width":10,"height":5},
      },
      "aspect": 0.5,
      "area": 0.5,
      "signedArea": -0.5,
      "firstPoints": [[-0.5,0.25],[0.5,0.25]],
      "lastPoints": [[0.5,-0.25],[-0.5,-0.25]],
      "pointCount": 4,
      "roundedCount": 4,
    },
    "negative": {
      "params": {
        "centerX": -1,
        "centerY": 2.75,
        "span": 10,
        "bbox": {"minX":-3.5,"minY":-2.25,"maxX":1.5,"maxY":7.75,"width":5,"height":10},
      },
      "aspect": 0.5,
      "area": 0.5,
      "signedArea": -0.5,
      "firstPoints": [[-0.25,0.5],[0.25,0.5]],
      "lastPoints": [[0.25,-0.5],[-0.25,-0.5]],
      "pointCount": 4,
      "roundedCount": 4,
    },
    "decimals": {
      "params": {
        "centerX": 0.1875,
        "centerY": 0.3125,
        "span": 1.375,
        "bbox": {"minX":-0.5,"minY":-0.125,"maxX":0.875,"maxY":0.75,"width":1.375,"height":0.875},
      },
      "aspect": 0.636363636,
      "area": 0.194214876,
      "signedArea": -0.194214876,
      "firstPoints": [[-0.045454545,-0.318181818],[-0.5,-0.136363636]],
      "lastPoints": [[-0.5,-0.136363636],[0.5,0.318181818]],
      "pointCount": 3,
      "roundedCount": 3,
    },
    "collinear": {
      "params": {
        "centerX": 1,
        "centerY": 1,
        "span": 2,
        "bbox": {"minX":0,"minY":0,"maxX":2,"maxY":2,"width":2,"height":2},
      },
      "aspect": 1,
      "area": 0,
      "signedArea": 0,
      "firstPoints": [[-0.5,0.5],[0,0]],
      "lastPoints": [[0,0],[0.5,-0.5]],
      "pointCount": 3,
      "roundedCount": 3,
    },
  },
};

// ---------- 输入点集 / path 数据 / 子轮廓 / SVG（与改前 fixture 生成脚本逐字一致） ----------
const POINT_SETS = {
  quad: [[0, 0], [10, 0], [10, 5], [0, 5]],
  negative: [[-3.5, -2.25], [1.5, -2.25], [1.5, 7.75], [-3.5, 7.75]],
  decimals: [[0.125, 0.75], [-0.5, 0.5], [0.875, -0.125]],
  single: [[2, 3]],
  empty: [],
  collinear: [[0, 0], [1, 1], [2, 2]],
  large: [[1e6, -1e6], [1e6 + 3, -1e6 + 2]],
};

const PATH_DATA_CASES = {
  explicitClose: 'M10 10 L90 10 L90 90 L10 90 Z',
  implicitClose: 'M0 0 L10 0 L10 10 L0 10 L0 0',
  open: 'M0 0 L10 0 L10 10',
  closeWithinTolerance: 'M0 0 L10 0 L10 10 L0.00001 0',
  farFromClose: 'M0 0 L100 0 L100 100 L0 0.001',
  twoSubpaths: 'M0 0 L10 0 L10 10 Z M20 20 L30 20 L30 30 Z',
  withCurves: 'M0 0 C10 0 10 10 20 10 Q30 10 30 20 Z',
  singlePointSubpath: 'M5 5 M0 0 L4 0 L4 4 Z',
  relativeAndHV: 'm0 0 h10 v10 h-10 z',
};

const RING_CASES = {
  outerWithHole: [
    { points: [[0, 0], [100, 0], [100, 100], [0, 100]], closed: true },
    { points: [[20, 20], [20, 80], [80, 80], [80, 20]], closed: true },
  ],
  outerWithPart: [
    { points: [[0, 0], [100, 0], [100, 100], [0, 100]], closed: true },
    { points: [[200, 0], [240, 0], [240, 40], [200, 40]], closed: true },
  ],
  outerWithStray: [
    { points: [[0, 0], [100, 0], [100, 100], [0, 100]], closed: true },
    { points: [[200, 0], [203, 0], [203, 3], [200, 3]], closed: true },
  ],
  degenerateAndOpen: [
    { points: [[0, 0], [1, 1], [2, 2]], closed: true },
    { points: [[0, 0], [10, 0], [10, 10], [0, 10]], closed: false },
    { points: [[50, 50], [55, 50], [55, 55], [50, 55]], closed: true },
  ],
};

const SVG_CASES = {
  square: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M10 10 L90 10 L90 90 L10 90 Z"/></svg>',
  bowtie: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M10 10 L90 90 L90 10 L10 90 Z"/></svg>',
  multiPart:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M10 10 L30 10 L30 30 L10 30 Z M60 10 L90 10 L90 30 L60 30 Z"/></svg>',
  triangle: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60"><path d="M5 55 L30 5 L55 55 Z"/></svg>',
  unclosed: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M10 10 L90 10 L90 90 L10 90"/></svg>',
  tiny: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M50 50 L50.02 50 L50.02 50.02 L50 50.02 Z"/></svg>',
};

const NORMALIZE_CASES = {
  quad: POINT_SETS.quad,
  negative: POINT_SETS.negative,
  decimals: POINT_SETS.decimals,
  collinear: POINT_SETS.collinear,
};

/**
 * 子轮廓分类输出 → 紧凑可比较对象（与改前 fixture 生成脚本同口径）。
 *
 * @param {Array<{points: Array<[number, number]>, closed: boolean}>} subpaths 子路径
 * @returns {object} 分类结果
 */
function classifyOut(subpaths) {
  const result = classifyRings(subpaths);
  return {
    rings: result.rings.map((ring) => ({
      index: ring.index,
      closed: ring.closed,
      area: round(ring.area),
      bbox: bboxOut(ring.bbox),
      depth: ring.depth,
      parents: [...ring.parents],
      role: ring.role ?? null,
    })),
    main: result.main ? result.main.index : null,
    holes: result.holes.map((ring) => ring.index),
    parts: result.parts.map((ring) => ring.index),
    strays: result.strays.map((ring) => ring.index),
    warningCount: result.warnings.length,
  };
}

/**
 * SVG 转换结果 → 紧凑可比较对象（与改前 fixture 生成脚本同口径）。
 *
 * @param {string} svgText SVG 源码
 * @returns {object} 转换结果摘要
 */
function svgOut(svgText) {
  const result = convertSvg(svgText);
  return {
    status: result.status,
    reasonCodes: result.reasons.map((reason) => reason.code),
    // 退化原因文案里嵌 bbox 推导出的 span 数值，是 bbox 语义的直接证据
    degenerateMessage: result.reasons.find((reason) => reason.code === 'degenerate')?.message ?? null,
    warningCount: result.warnings.length,
    diagnostics: {
      subpathCount: result.diagnostics.subpathCount,
      ringCount: result.diagnostics.ringCount,
      outerRingCount: result.diagnostics.outerRingCount,
      holeCount: result.diagnostics.holeCount,
      partCount: result.diagnostics.partCount,
      strayCount: result.diagnostics.strayCount,
      mainArea: result.diagnostics.mainArea,
      mainClosed: result.diagnostics.mainClosed,
      holeAreaRatio: result.diagnostics.holeAreaRatio,
    },
    R: result.R ? { sourcePointCount: result.R.sourcePointCount, mainLength: result.R.main.length } : null,
    T: result.T
      ? {
          pointCount: result.T.pointCount,
          aspect: result.T.aspect,
          area: result.T.area,
          bounds: result.T.bounds,
          simplification: result.T.simplification,
        }
      : null,
    metrics: result.metrics
      ? {
          sourceToTargetMeanPct: result.metrics.sourceToTargetMeanPct,
          sourceToTargetMaxPct: result.metrics.sourceToTargetMaxPct,
          targetToSourceMaxPct: result.metrics.targetToSourceMaxPct,
          refinementEpsilon: result.metrics.simplificationEpsilon,
          aspect: result.metrics.aspect,
          area: result.metrics.area,
          targetPointCount: result.metrics.targetPointCount,
          refinePointCount: result.metrics.refinePointCount,
        }
      : null,
  };
}

/**
 * 归一化结果 → 紧凑可比较对象（与改前 fixture 生成脚本同口径）。
 *
 * @param {Array<[number, number]>} points 源坐标闭环
 * @returns {object} 归一化结果摘要
 */
function normalizeOut(points) {
  const params = normalizationParams(points);
  const normalized = normalizeClosedRing(points);
  return {
    params: {
      centerX: round(params.centerX),
      centerY: round(params.centerY),
      span: round(params.span),
      bbox: bboxOut(params.bbox),
    },
    aspect: round(normalized.aspect),
    area: round(normalized.area),
    signedArea: round(normalized.signedArea),
    firstPoints: ptsOut(normalized.points.slice(0, 2)),
    lastPoints: ptsOut(normalized.points.slice(-2)),
    pointCount: normalized.points.length,
    roundedCount: normalized.rounded.length,
  };
}

// ---------- 1. bboxOf：七个点集与改前逐字段一致（含空集非有限值口径） ----------
for (const [name, points] of Object.entries(POINT_SETS)) {
  check(`bbox 收敛：${name} 点集与改前逐字段一致`, () => {
    assert.deepEqual(bboxOut(bboxOf(points)), FIXTURE.bbox[name]);
  });
  check(`bbox 兼容导出名：geometry.bbox(${name}) 与 bboxOf 同输出`, () => {
    assert.deepEqual(bboxOut(bbox(points)), bboxOut(bboxOf(points)));
  });
}

// ---------- 2. path-data：闭合判定（含 scale 容差边界）与改前一致 ----------
for (const [name, d] of Object.entries(PATH_DATA_CASES)) {
  check(`path-data 调用方：${name} 子路径与改前逐点一致`, () => {
    const result = parsePathData(d);
    assert.deepEqual(
      {
        subpaths: result.subpaths.map((subpath) => ({
          points: ptsOut(subpath.points),
          closed: subpath.closed,
        })),
        warningCount: result.warnings.length,
      },
      FIXTURE.pathData[name],
    );
  });
}

// ---------- 3. rings：分类结果与 bbox 逐字段一致 ----------
for (const [name, subpaths] of Object.entries(RING_CASES)) {
  check(`rings 调用方：${name} 分类与 bbox 与改前一致`, () => {
    assert.deepEqual(classifyOut(subpaths), FIXTURE.rings[name]);
  });
}

// ---------- 4. convert：T.bounds / 退化跨度文案 / metrics 与改前一致 ----------
for (const [name, svgText] of Object.entries(SVG_CASES)) {
  check(`convert 调用方：${name} 转换结果与改前一致`, () => {
    assert.deepEqual(svgOut(svgText), FIXTURE.svg[name]);
  });
}

// ---------- 5. normalizationParams / normalizeClosedRing 内部 bbox 与改前一致 ----------
for (const [name, points] of Object.entries(NORMALIZE_CASES)) {
  check(`归一化调用方：${name} 参数与面积与改前一致`, () => {
    assert.deepEqual(normalizeOut(points), FIXTURE.normalize[name]);
  });
}

// ---------- 6. 结构断言：bbox 只剩一处实现、reference 不再反向依赖 agent ----------
/**
 * 读取 web/src 下的模块源码。
 *
 * @param {string} relative web/src 下的相对路径
 * @returns {string} 源码
 */
function sourceOf(relative) {
  return readFileSync(new URL(`../web/src/${relative}`, import.meta.url), 'utf8');
}

check('结构：4 处内联 min/max 扫描全部消失（bboxOf 单点）', () => {
  for (const relative of [
    'reference/geometry.js',
    'reference/path-data.js',
    'reference/rings.js',
    'reference/convert.js',
  ]) {
    const source = sourceOf(relative);
    assert.ok(!source.includes('let minX = Infinity'), `${relative} 仍有内联包围盒扫描`);
    assert.ok(source.includes('bboxOf'), `${relative} 未复用 engine/geo.js 的 bboxOf`);
  }
});

check('结构：reference/{geometry,rings,convert}.js 不再反向 import agent/shape-validate.js', () => {
  for (const relative of ['reference/geometry.js', 'reference/rings.js', 'reference/convert.js']) {
    assert.ok(!sourceOf(relative).includes('shape-validate'), `${relative} 仍反向依赖 agent 层`);
  }
});

check('结构：纯几何实现唯一源在 engine/polygon.js，shape-validate.js 为薄 re-export', () => {
  const polygon = sourceOf('engine/polygon.js');
  const shapeValidate = sourceOf('agent/shape-validate.js');
  assert.ok(polygon.includes('export function polygonSignedArea'));
  assert.ok(polygon.includes('export function validateSimplePolygon'));
  assert.ok(shapeValidate.includes("from '../engine/polygon.js'"), 'shape-validate 未 re-export 共享层');
  assert.ok(!shapeValidate.includes('export function'), 'shape-validate 仍有重复实现');
});

// ---------- 汇总 ----------
console.log(`\n[summary] checks=${checks} failures=${failures}`);
if (failures > 0) {
  process.exitCode = 1;
}
