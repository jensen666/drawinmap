/**
 * 描摹底层几何工具（纯函数，无 DOM）：掩膜外接框、8 邻接连通分量、
 * 孔洞填充、Moore 邻域外轮廓跟踪、扫描线 IoU 栅格化。
 *
 * 供 web/src/agent/image-trace.js 的二值化/描摹流程复用；单独拆文件是为把
 * 生产模块控制在项目规则的行数上限内（image-trace.js 只保留描摹编排与二值化）。
 * 与 image-trace.js 相同的像素坐标约定：x 向右、y 向下，像素中心坐标为整数。
 */

import { throwIfAborted } from '../cancel.js';

/** 8 邻域偏移，按顺时针排列（屏幕坐标 x 向右、y 向下）；0=西，2=北，4=东，6=南 */
const MOORE_OFFSETS = Object.freeze([
  [-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1],
]);

/**
 * 统计掩膜前景的外接框与像素数。
 *
 * @param {Uint8Array} mask 二值掩膜（非 0 为前景）
 * @param {number} width 宽（像素）
 * @param {number} height 高（像素）
 * @returns {{count: number, minX: number, minY: number, maxX: number, maxY: number,
 *   width: number, height: number}} 外接框（无前景时 count=0、minX=width、maxX=-1）
 */
export function maskBounds(mask, width, height) {
  let count = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x += 1) {
      if (!mask[rowOffset + x]) continue;
      count += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { count, minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/**
 * 8 邻接连通分量标记（迭代式，避免大图递归爆栈）。
 *
 * @param {Uint8Array} mask 二值掩膜（非 0 为前景）
 * @param {number} width 宽（像素）
 * @param {number} height 高（像素）
 * @returns {{labels: Int32Array, sizes: number[]}} labels 0=背景、1..n=分量编号；sizes 按编号-1 对齐
 */
export function labelComponents(mask, width, height) {
  const total = width * height;
  const labels = new Int32Array(total);
  const stack = new Int32Array(total);
  const sizes = [];
  let label = 0;
  for (let start = 0; start < total; start += 1) {
    if (!mask[start] || labels[start]) continue;
    label += 1;
    labels[start] = label;
    let stackSize = 0;
    stack[stackSize] = start;
    stackSize += 1;
    let size = 0;
    while (stackSize > 0) {
      stackSize -= 1;
      const index = stack[stackSize];
      size += 1;
      const x = index % width;
      const y = (index - x) / width;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const next = ny * width + nx;
          if (mask[next] && !labels[next]) {
            labels[next] = label;
            stack[stackSize] = next;
            stackSize += 1;
          }
        }
      }
    }
    sizes.push(size);
  }
  return { labels, sizes };
}

/**
 * 孔洞填充：从图像四边做 4 邻接背景泛洪，没被泛洪到的背景即孔洞，填为前景。
 *
 * 4 邻接（而不是 8）保证对角相邻的前景像素也算屏障，细缝里的背景不会被误判为外部。
 *
 * @param {Uint8Array} mask 单分量二值掩膜（非 0 为前景）
 * @param {number} width 宽（像素）
 * @param {number} height 高（像素）
 * @returns {{mask: Uint8Array, holes: number}} 填充后的新掩膜与填充像素数
 */
export function fillHoles(mask, width, height) {
  const total = width * height;
  const exterior = new Uint8Array(total);
  const stack = new Int32Array(total);
  let stackSize = 0;
  const push = (x, y) => {
    const index = y * width + x;
    if (mask[index] || exterior[index]) return;
    exterior[index] = 1;
    stack[stackSize] = index;
    stackSize += 1;
  };
  for (let x = 0; x < width; x += 1) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 1; y < height - 1; y += 1) {
    push(0, y);
    push(width - 1, y);
  }
  while (stackSize > 0) {
    stackSize -= 1;
    const index = stack[stackSize];
    const x = index % width;
    const y = (index - x) / width;
    if (x > 0) push(x - 1, y);
    if (x < width - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < height - 1) push(x, y + 1);
  }
  const filled = new Uint8Array(mask);
  let holes = 0;
  for (let index = 0; index < total; index += 1) {
    if (!mask[index] && !exterior[index]) {
      filled[index] = 1;
      holes += 1;
    }
  }
  return { mask: filled, holes };
}

/**
 * 8 邻域方向编号（MOORE_OFFSETS 下标）。
 *
 * @param {number} dx x 偏移
 * @param {number} dy y 偏移
 * @returns {number} 方向编号，非法偏移返回 -1
 */
function directionIndex(dx, dy) {
  for (let index = 0; index < MOORE_OFFSETS.length; index += 1) {
    if (MOORE_OFFSETS[index][0] === dx && MOORE_OFFSETS[index][1] === dy) return index;
  }
  return -1;
}

/**
 * Moore 邻域边界跟踪：从光栅顺序第一个前景像素出发，跟踪单条闭合外轮廓。
 *
 * 算法：当前边界像素 b 与"回溯像素" c（进入 b 的方向上的背景像素）；从 c 开始顺时针
 * 扫 b 的 8 邻域，第一个前景像素是新的 b，扫描中最后一个背景像素是新 c。回到起点且
 * 回溯方向与出发时一致（Jacob 停止判据）即闭合。孔洞已填充，因此只得到外轮廓；
 * 异常形状返回 null（上层判 no-outer-contour）。
 *
 * H3 加固（三项）：
 * 1. 步数上限从 4*W*H+8（1024² 约 420 万步）收紧到前景量级：
 *    min(4*W*H+8, max(4096, 前景像素数*4+16))。正常单条闭合外轮廓的步数约等于边界
 *    像素数、不超过前景像素数的量级，因此上限按前景收紧不会误伤正常轮廓，却把最坏
 *    耗时从 O(W*H) 全图降到 O(前景)（小图标前景常只占图面 1%~10%）。
 * 2. visited-state 快速失败：状态 = (当前像素, 回溯方向) 共 8 种方向；同一状态再次
 *    出现说明跟踪进入循环、永远不会闭合，立即返回 null，不必空转到步数上限。
 *    轮廓数组长度同样被步数上限约束，避免异常输入无限 push。
 * 3. signal 周期检查：每 1024 步检查一次 options.signal.aborted，中止时抛统一
 *    AbortError（web/src/cancel.js）。注意 JS 单线程的物理限制——同步函数执行期间
 *    UI 事件（含"停止"按钮回调）无法插入执行，因此 signal 只能让"调用前已中止"或
 *    "外部已先行中止"的场景尽快失败；真正的最坏耗时由上面的步数上限保证可控。
 *
 * @param {Uint8Array} mask 填充后单分量掩膜（非 0 为前景）
 * @param {number} width 宽（像素）
 * @param {number} height 高（像素）
 * @param {{signal?: AbortSignal|null, foregroundCount?: number}} [options]
 *   signal：停止信号（每 1024 步检查，中止抛 AbortError）；
 *   foregroundCount：掩膜前景像素数（用于收紧步数上限，缺省 0 → 使用 4*W*H+8 兜底）
 * @returns {Array<[number, number]>|null} 像素坐标闭环点列（不含重复首点）；失败返回 null
 * @throws {Error} signal 已中止时抛统一 AbortError（name=AbortError）
 */
export function traceOuterContour(mask, width, height, options = {}) {
  const { signal = null, foregroundCount = 0 } = options || {};
  let startX = -1;
  let startY = -1;
  for (let y = 0; y < height && startX < 0; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (mask[y * width + x]) {
        startX = x;
        startY = y;
        break;
      }
    }
  }
  if (startX < 0) return null;
  const contour = [];
  let currentX = startX;
  let currentY = startY;
  // 光栅序第一个前景像素的左侧必为背景（或图外），作为初始回溯像素
  let backX = startX - 1;
  let backY = startY;
  const safeForeground = Number.isFinite(Number(foregroundCount))
    ? Math.max(0, Math.floor(Number(foregroundCount)))
    : 0;
  const stepLimit = Math.min(4 * width * height + 8, Math.max(4096, safeForeground * 4 + 16));
  const visited = new Set();
  let steps = 0;
  while (true) {
    // 每 1024 步检查一次停止信号（同步函数无法被 UI 事件真正打断，见函数注释）
    if ((steps & 1023) === 0) throwIfAborted(signal, '已停止');
    contour.push([currentX, currentY]);
    const backDir = directionIndex(backX - currentX, backY - currentY);
    if (backDir < 0) return null;
    // visited-state：像素 + 回溯方向重复 → 跟踪循环，永远不会闭合，快速失败
    const stateKey = (currentY * width + currentX) * 8 + backDir;
    if (visited.has(stateKey)) return null;
    visited.add(stateKey);
    let foundDir = -1;
    for (let offset = 1; offset < 8; offset += 1) {
      const dir = (backDir + offset) % 8;
      const nextX = currentX + MOORE_OFFSETS[dir][0];
      const nextY = currentY + MOORE_OFFSETS[dir][1];
      if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue;
      if (mask[nextY * width + nextX]) {
        foundDir = dir;
        break;
      }
    }
    if (foundDir < 0) return null; // 孤立前景像素，没有邻域轮廓
    const lastBackgroundDir = (foundDir + 7) % 8;
    backX = currentX + MOORE_OFFSETS[lastBackgroundDir][0];
    backY = currentY + MOORE_OFFSETS[lastBackgroundDir][1];
    currentX += MOORE_OFFSETS[foundDir][0];
    currentY += MOORE_OFFSETS[foundDir][1];
    steps += 1;
    if (currentX === startX && currentY === startY && backX === startX - 1 && backY === startY) break;
    if (steps > stepLimit) return null;
  }
  return contour;
}

/**
 * 计算归一化点列与掩膜的 IoU（扫描线栅格化，O(边数*行数 + 多边形面积)，非 O(W*H*n)）。
 *
 * 点列按掩膜前景外接框逆映射回像素坐标（与 image-trace.js 的归一化互逆）。
 * 像素坐标约定：像素 (ix,iy) 覆盖 [ix,ix+1)×[iy,iy+1)，中心为 (ix+0.5, iy+0.5)，
 * 因此逆映射为 px = centerX + x*span、py = centerY - y*span，其中
 * centerX = (minX+maxX+1)/2、centerY = (minY+maxY+1)/2（外接框中心在"像素中心坐标系"下的位置）。
 *
 * 关键：**按像素中心采样**（H2 回归修复）。扫描线取行中心 yc = iy+0.5，交点 x 的
 * 覆盖判定用 ceil(x-0.5) / floor(x-0.5)（即"像素中心 ix+0.5 落在区间内"）。
 * 旧实现按整数行 y 采样 + 半开区间（y1<=y && y2>y）+ ceil/floor(x) 求覆盖，
 * 会把外接框极值行整体漏掉（例：44×10 纯矩形 IoU 只有 0.80 而不是 1.0）。
 *
 * 数值容差：点列通常是 6 位小数取整后的归一化坐标，逆映射回像素的误差上界为
 * 0.5e-6*span 像素；因此边界判定统一放开 span*1e-6 的容差，让"像素中心恰好落在
 * 外接框极值/边界上"的边界像素仍被算作覆盖（否则极值行列会被系统性漏算）。
 * 该容差远小于 1 像素，不影响非边界像素的判定。
 *
 * 水平边：像素中心网格是半整数，水平边（如矩形的上下边）恰好落在行中心线上，
 * 半开区间规则会把它跳过，整条边上的边界像素会被漏算；因此水平边单独收集，
 * 只在"边所在行"按 x 区间并入覆盖，与扫描线交点区间合并去重。
 *
 * @param {Array<[number, number]>} points 归一化闭环点列（[-0.5,0.5]，y 向上）
 * @param {Uint8Array} mask 参考掩膜（非 0 为前景）
 * @param {number} width 宽（像素）
 * @param {number} height 高（像素）
 * @returns {number} IoU ∈ [0,1]；无前景/参数非法返回 0
 */
export function computeMaskIou(points, mask, width, height) {
  const w = Math.floor(Number(width));
  const h = Math.floor(Number(height));
  if (!Array.isArray(points) || points.length < 3 || !mask || !(w > 0) || !(h > 0) || mask.length < w * h) {
    return 0;
  }
  const bounds = maskBounds(mask, w, h);
  if (bounds.count === 0) return 0;
  // 像素中心坐标下的外接框中心与跨度（span 与归一化时的最长边一致）
  const centerX = (bounds.minX + bounds.maxX + 1) / 2;
  const centerY = (bounds.minY + bounds.maxY + 1) / 2;
  const span = Math.max(bounds.width, bounds.height, 1);
  const eps = Math.max(1e-9, span * 1e-6);
  const pixelPoints = points.map(([x, y]) => [centerX + Number(x) * span, centerY - Number(y) * span]);
  const edges = [];
  const horizontalEdges = [];
  let minY = Infinity;
  let maxY = -Infinity;
  for (let index = 0; index < pixelPoints.length; index += 1) {
    const a = pixelPoints[index];
    const b = pixelPoints[(index + 1) % pixelPoints.length];
    if (!Number.isFinite(a[0]) || !Number.isFinite(a[1]) || !Number.isFinite(b[0]) || !Number.isFinite(b[1])) {
      return 0;
    }
    minY = Math.min(minY, a[1], b[1]);
    maxY = Math.max(maxY, a[1], b[1]);
    if (a[1] === b[1]) {
      // 水平边：不参与奇偶交点，但要按"边所在行"并入边界像素覆盖
      horizontalEdges.push([Math.min(a[0], b[0]), Math.max(a[0], b[0]), a[1]]);
      continue;
    }
    edges.push([a[0], a[1], b[0], b[1]]);
  }
  if (edges.length < 2) return 0;
  // 覆盖行：行中心 yc = iy+0.5 落在多边形 y 范围（含端点数值容差）内的像素行
  const rowStart = Math.max(0, Math.ceil(minY - 0.5 - eps));
  const rowEnd = Math.min(h - 1, Math.floor(maxY - 0.5 + eps));
  const intersections = [];
  const intervals = [];
  let polygonPixels = 0;
  let intersectionPixels = 0;
  /** 累计一行内某个像素区间的覆盖与交集（区间已裁剪到 [0,w-1]） */
  const accumulate = (from, to, rowOffset) => {
    polygonPixels += to - from + 1;
    for (let x = from; x <= to; x += 1) {
      if (mask[rowOffset + x]) intersectionPixels += 1;
    }
  };
  for (let iy = rowStart; iy <= rowEnd; iy += 1) {
    const yc = iy + 0.5;
    if (yc < minY - eps || yc > maxY + eps) continue;
    // 极值行（外接框最上/最下一行）：像素中心与多边形上下边界重合，半开区间规则会把
    // 端点行漏掉（H2 的另一个来源）。把扫描高度向多边形内部收 eps，用内部切片求覆盖；
    // 这样极端行与普通行走同一条奇偶配对逻辑，不产生顶点重复交点。
    let scanY = yc;
    if (yc <= minY + eps) scanY = minY + eps;
    else if (yc >= maxY - eps) scanY = maxY - eps;
    intersections.length = 0;
    for (const [x1, y1, x2, y2] of edges) {
      // 半开区间规则：顶点只算一次、保证交点成对，避免扫描线恰好穿过顶点时重复计数
      if ((y1 <= scanY && y2 > scanY) || (y2 <= scanY && y1 > scanY)) {
        intersections.push(x1 + ((scanY - y1) * (x2 - x1)) / (y2 - y1));
      }
    }
    intersections.sort((a, b) => a - b);
    intervals.length = 0;
    for (let index = 0; index + 1 < intersections.length; index += 2) {
      // 像素 ix 的中心 ix+0.5 落在 [xLeft, xRight] 内（含边界容差）
      const from = Math.max(0, Math.ceil(intersections[index] - 0.5 - eps));
      const to = Math.min(w - 1, Math.floor(intersections[index + 1] - 0.5 + eps));
      if (to >= from) intervals.push([from, to]);
    }
    // 水平边若与当前行中心重合（半整数网格上必然恰好重合），其上的像素中心是边界像素
    for (const [horizontalFrom, horizontalTo, horizontalY] of horizontalEdges) {
      if (Math.abs(horizontalY - yc) > eps) continue;
      const from = Math.max(0, Math.ceil(horizontalFrom - 0.5 - eps));
      const to = Math.min(w - 1, Math.floor(horizontalTo - 0.5 + eps));
      if (to >= from) intervals.push([from, to]);
    }
    if (intervals.length === 0) continue;
    intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const rowOffset = iy * w;
    let mergedFrom = intervals[0][0];
    let mergedTo = intervals[0][1];
    for (let index = 1; index < intervals.length; index += 1) {
      if (intervals[index][0] <= mergedTo) {
        if (intervals[index][1] > mergedTo) mergedTo = intervals[index][1];
        continue;
      }
      accumulate(mergedFrom, mergedTo, rowOffset);
      mergedFrom = intervals[index][0];
      mergedTo = intervals[index][1];
    }
    accumulate(mergedFrom, mergedTo, rowOffset);
  }
  const union = bounds.count + polygonPixels - intersectionPixels;
  return union > 0 ? intersectionPixels / union : 0;
}
