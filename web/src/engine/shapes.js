/**
 * 内置图形定义：以中心为原点的局部坐标（归一化到约 [-0.5, 0.5]），
 * 由规划器按目标尺寸（米）、旋转角换算到地图经纬度。
 */

/**
 * 五角星：10 个顶点（外顶点 5 个、内顶点 5 个）。
 *
 * @returns {Array<[number, number]>} 局部坐标点
 */
function buildStar() {
  const points = [];
  for (let i = 0; i < 10; i += 1) {
    const angle = (Math.PI / 5) * i - Math.PI / 2;
    const radius = i % 2 === 0 ? 0.5 : 0.21;
    points.push([Math.cos(angle) * radius, Math.sin(angle) * radius]);
  }
  return points;
}

/**
 * 心形：参数方程采样。约束点少一些（减少路线折返），轮廓点密一些（绘制更平滑）。
 *
 * @param {number} count 采样点数
 * @returns {Array<[number, number]>} 局部坐标点
 */
function buildHeart(count) {
  const points = [];
  for (let i = 0; i < count; i += 1) {
    const t = (Math.PI * 2 * i) / count;
    const x = 16 * Math.sin(t) ** 3;
    const y =
      13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    points.push([x / 32, y / 32]);
  }
  return points;
}

/**
 * 矩形：4 个角点（闭合由规划器处理）。
 *
 * @returns {Array<[number, number]>} 局部坐标点
 */
function buildRect() {
  return [
    [-0.5, -0.5],
    [0.5, -0.5],
    [0.5, 0.5],
    [-0.5, 0.5],
  ];
}

/**
 * 环上加密：每条边等分插入中间点，返回有序点列（不含重复闭合点）。
 * 矩形/五角星的边较长，只在角/顶点处约束会让 A* 在边中段抄别的街（鼓包），
 * 加密后路线被迫沿边走；轮廓加密同时让贴合度采样覆盖边中段。
 *
 * @param {Array<[number, number]>} points 环顶点
 * @param {number} segmentsPerEdge 每条边等分数
 * @returns {Array<[number, number]>} 加密点列
 */
function densifyLoop(points, segmentsPerEdge) {
  const dense = [];
  for (let i = 0; i < points.length; i += 1) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    for (let k = 0; k < segmentsPerEdge; k += 1) {
      dense.push([
        x1 + ((x2 - x1) * k) / segmentsPerEdge,
        y1 + ((y2 - y1) * k) / segmentsPerEdge,
      ]);
    }
  }
  return dense;
}

/** 图形注册表：key → 名称、约束点（吸附用）、轮廓点（绘制用）与自动搜索朝向集 */
export const SHAPES = {
  star: {
    name: '五角星',
    build: buildStar,
    // 轮廓加密到 30 点：贴合度采样覆盖星形边中段
    buildOutline: () => densifyLoop(buildStar(), 3),
    // 五重对称（72° 周期），0~60° 覆盖全部朝向
    searchRotations: [0, 15, 30, 45, 60],
  },
  heart: {
    name: '心形',
    // 约束点少而分散，避免路线在同一条街道上来回；轮廓点密一些保证显示平滑
    build: () => buildHeart(8),
    buildOutline: () => buildHeart(120),
    // 心形无对称性，放倒/倒置后肉眼不认，只搜基本直立的朝向
    searchRotations: [330, 0, 30],
  },
  rect: {
    name: '矩形',
    // 每边 4 段共 16 个约束点：只靠 4 个角会让边中段失控（A* 抄近路鼓包）
    build: () => densifyLoop(buildRect(), 4),
    // 轮廓每边 8 段共 32 点：贴合度采样覆盖边中段
    buildOutline: () => densifyLoop(buildRect(), 8),
    // 90° 对称
    searchRotations: [0, 30, 60],
  },
};
