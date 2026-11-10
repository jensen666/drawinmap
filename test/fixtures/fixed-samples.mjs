/**
 * 固定样本与改前基线（第 0 步准备，供固定候选定点回放回归测试与弧偏差测试共用）。
 *
 * 样本 A：手造合法轮廓（带腿剪影）+ 显式声明特征（尖耳/长脸/翘尾），
 *   用于验证声明特征的部位弧偏差；固定候选 北京路 1500m / 60°，改前为绿色交付。
 * 样本 B：历史马轮廓，从 web/logs/2026-10-26.jsonl 的 trace `t-ojeieu3lo9n`
 *   的 `llm.response.data.content` 解析出的原始 `customShape.points`（26 点）；
 *   原始对象只有 name/points、没有 features，只用于验证 detectFeatures 检出的 notch。
 *   注意：不能取 plan.request.customShape.outlinePoints（日志会把重复引用写成
 *   [Circular] 而非完整点列），也不能拿历史 74 分当预期（旧指标）。
 *   固定候选沿用历史选定参数：center 23.1367832554797/113.3246，2400m，15°。
 *
 * 基线口径（改前实测，固定候选定点回放；不是历史日志分数）：
 * - 样本 A：score 73、meetsQualityBar true → 绿色交付、reference false；
 * - 样本 B：score 60、meetsQualityBar false → 橙色参考版、reference true。
 * 改后 scoreRoute / meetsQualityBar / 交付状态 / reference 必须与上表一致。
 */

/** 样本 B 历史马轮廓（trace t-ojeieu3lo9n，26 点，原始无 features） */
export const SAMPLE_B_HORSE_POINTS = [
  [0.46, 0.26],
  [0.38, 0.34],
  [0.33, 0.44],
  [0.26, 0.36],
  [0.14, 0.32],
  [0.02, 0.24],
  [-0.1, 0.21],
  [-0.24, 0.21],
  [-0.33, 0.13],
  [-0.36, 0.08],
  [-0.48, 0],
  [-0.4, -0.08],
  [-0.3, -0.06],
  [-0.29, -0.2],
  [-0.29, -0.42],
  [-0.19, -0.43],
  [-0.17, -0.18],
  [-0.04, -0.11],
  [0.03, -0.22],
  [0.03, -0.43],
  [0.14, -0.43],
  [0.15, -0.2],
  [0.17, -0.04],
  [0.26, 0.06],
  [0.36, 0.14],
  [0.45, 0.18],
];

/** 样本 A 轮廓：矩形主体 + 底部两条腿（腿间是凹口），外加显式声明特征 */
export const SAMPLE_A_POINTS = [
  [-0.5, 0.4],
  [0.5, 0.4],
  [0.5, -0.2],
  [0.2, -0.2],
  [0.2, -0.45],
  [0.1, -0.45],
  [0.1, -0.2],
  [-0.1, -0.2],
  [-0.1, -0.45],
  [-0.2, -0.45],
  [-0.2, -0.2],
  [-0.5, -0.2],
];

/** 样本 A 原始 customShape（声明特征必须来自 features，不能只靠几何检测） */
export const SAMPLE_A_RAW = {
  name: '样本马A',
  points: SAMPLE_A_POINTS,
  features: [
    { name: '尖耳', points: [[0.42, 0.38]] },
    { name: '长脸', points: [[0.34, -0.2]] },
    { name: '翘尾', points: [[-0.46, 0.3]] },
  ],
};

/** 样本 B 原始 customShape（历史对象没有 features 字段） */
export const SAMPLE_B_RAW = { name: '马', points: SAMPLE_B_HORSE_POINTS };

/**
 * 闭合折线等分加密（每条边插 perEdge 个点，几何不变、点数增加）。
 * 方案 2026-11-01 §3 规定复杂剪影（features 不少于 3 个）点数下限 80：
 * 控制器链路测试里的自由轮廓目标必须满足该闸门，因此提供加密版样本；
 * 引擎定点回放基线（fixed-candidates / feature-arcs）继续使用原版样本——
 * 点数闸门在编排层，不影响引擎层回放口径。
 *
 * @param {Array<[number, number]>} points 闭合折线顶点
 * @param {number} perEdge 每条边的细分段数
 * @returns {Array<[number, number]>} 加密后的点列
 */
export function densifyClosedLoop(points, perEdge) {
  const out = [];
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    for (let step = 0; step < perEdge; step += 1) {
      out.push([a[0] + ((b[0] - a[0]) * step) / perEdge, a[1] + ((b[1] - a[1]) * step) / perEdge]);
    }
  }
  return out;
}

/** 样本 A 加密版（84 点；12 顶点每条边 7 段）：控制器自由轮廓链路用 */
export const SAMPLE_A_FREEFORM_RAW = {
  ...SAMPLE_A_RAW,
  points: densifyClosedLoop(SAMPLE_A_POINTS, 7),
};

/** 样本 B 加密版（104 点；26 顶点每条边 4 段）：控制器自由轮廓链路用 */
export const SAMPLE_B_FREEFORM_RAW = {
  ...SAMPLE_B_RAW,
  points: densifyClosedLoop(SAMPLE_B_HORSE_POINTS, 4),
};

/** 样本 A 固定候选（改前定点回放实测分数 73，绿色交付） */
export const SAMPLE_A_CANDIDATE = {
  center: { lat: 23.1249, lng: 113.2653 },
  sizeMeters: 1500,
  rotationDeg: 60,
};

/** 样本 B 固定候选（历史选定参数，改前定点回放实测分数 60） */
export const SAMPLE_B_CANDIDATE = {
  center: { lat: 23.1367832554797, lng: 113.3246 },
  sizeMeters: 2400,
  rotationDeg: 15,
};

/** 改前基线（固定候选定点回放，改后必须逐项一致） */
export const SAMPLE_BASELINES = {
  A: {
    score: 73,
    meetsQualityBar: true,
    planStatus: 'ok',
    delivery: 'green',
    reference: false,
    outlinePoints: 24,
    constraintPoints: 18,
    features: { total: 8, notch: 3, gap: 2, declared: 3 },
  },
  B: {
    score: 60,
    meetsQualityBar: false,
    planStatus: 'failed',
    delivery: 'orange-reference',
    reference: true,
    outlinePoints: 26,
    constraintPoints: 20,
    features: { total: 4, notch: 2, gap: 2, declared: 0 },
  },
};
