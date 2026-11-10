/**
 * 生成图像描摹链路验收用的 9 张固定 fixtures（白底黑剪影 8 张 + 照片式 1 张）。
 *
 * 方案依据：docs/方案设计/2026-11-01-长尾图形轮廓来源与贴路上限方案.md §4.2「描摹」「描不出」两行。
 *
 * 产物：test/fixtures/trace-images/
 *   piglet-peppa.png / windmill.png / lighthouse.png / bicycle.png / train.png /
 *   sailboat.png / helicopter.png / cactus.png（512×512、白底黑剪影、单连通、前景 15%~45%）
 *   photo-like.png（彩色渐变+随机噪点+不规则色块，二值化后碎成多块，用于「描不出」样本）
 *   README.md（生成方式、前景外接框、用途、重生成命令）
 *
 * 实现约束：只用 Node 内置模块（自写 PNG 编码：zlib.deflateSync + CRC32，8-bit RGB、
 * filter 0、无交错；解码同理自写，用于自检 + 模拟页面上传的 JPEG 压缩）。不引入第三方包。
 * 脚本幂等：固定种子的伪随机数 + 确定性 zlib 压缩，重复运行产生完全相同的文件。
 *
 * 运行：node tools/make-trace-fixtures.mjs
 * 退出码：全部约束通过为 0，有失败为 1（失败不写文件，先打印原因）。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  IMAGE_TRACE_DEFAULTS,
  IMAGE_TRACE_IOU_MIN,
  IMAGE_TRACE_POINT_MAX,
  IMAGE_TRACE_POINT_MIN,
  binarizeImageData,
  computeMaskIou,
  traceMask,
} from '../web/src/agent/image-trace.js';
import { maskBounds } from '../web/src/agent/image-trace-geometry.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'test', 'fixtures', 'trace-images');
const WIDTH = 512;
const HEIGHT = 512;
/** 四周最小留白（像素）：方案要求 ≥30，这里构造值统一留到 ≥54 */
const MIN_MARGIN = 30;
/** 笔画厚度构造下限（像素）：方案要求最细笔画 ≥6，所有图元厚度都 ≥12 */
const MIN_STROKE = 12;
/** 页面上传流程 JPEG 压缩质量（web/src/agent/ui.js: IMAGE_JPEG_QUALITY = 0.85） */
const JPEG_QUALITY = 0.85;

// ==================== 基础图元（RGB 帧缓冲，白底黑剪影） ====================

/** 新建 RGB 帧缓冲并填充背景色 */
function createImage(width, height, background = [255, 255, 255]) {
  const data = new Uint8Array(width * height * 3);
  for (let index = 0; index < width * height; index += 1) {
    data[index * 3] = background[0];
    data[index * 3 + 1] = background[1];
    data[index * 3 + 2] = background[2];
  }
  return { width, height, data };
}

/** 写单个像素（越界忽略） */
function setPixel(image, x, y, color) {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
  const offset = (y * image.width + x) * 3;
  image.data[offset] = color[0];
  image.data[offset + 1] = color[1];
  image.data[offset + 2] = color[2];
}

/** 取单个像素 RGB */
function getPixel(image, x, y) {
  const offset = (y * image.width + x) * 3;
  return [image.data[offset], image.data[offset + 1], image.data[offset + 2]];
}

/** 填充矩形（含端点） */
function fillRect(image, x0, y0, x1, y1, color = [0, 0, 0]) {
  for (let y = Math.max(0, y0); y <= Math.min(image.height - 1, y1); y += 1) {
    for (let x = Math.max(0, x0); x <= Math.min(image.width - 1, x1); x += 1) {
      setPixel(image, x, y, color);
    }
  }
}

/** 填充圆（含端点） */
function fillCircle(image, cx, cy, radius, color = [0, 0, 0]) {
  for (let dy = -radius; dy <= radius; dy += 1) {
    const halfWidth = Math.floor(Math.sqrt(radius * radius - dy * dy));
    fillRect(image, cx - halfWidth, cy + dy, cx + halfWidth, cy + dy, color);
  }
}

/** 填充椭圆 */
function fillEllipse(image, cx, cy, rx, ry, color = [0, 0, 0]) {
  for (let dy = -ry; dy <= ry; dy += 1) {
    const ratio = 1 - (dy * dy) / (ry * ry);
    if (ratio < 0) continue;
    const halfWidth = Math.floor(rx * Math.sqrt(ratio));
    fillRect(image, cx - halfWidth, cy + dy, cx + halfWidth, cy + dy, color);
  }
}

/** 填充圆环（inner 以内为孔，环厚 = outer-inner） */
function fillRing(image, cx, cy, outer, inner, color = [0, 0, 0]) {
  for (let dy = -outer; dy <= outer; dy += 1) {
    for (let dx = -outer; dx <= outer; dx += 1) {
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq <= outer * outer && distanceSq > inner * inner) {
        setPixel(image, cx + dx, cy + dy, color);
      }
    }
  }
}

/** 填充凸/凹多边形（扫描线，含端点近似） */
function fillPolygon(image, vertices, color = [0, 0, 0]) {
  const minY = Math.max(0, Math.floor(Math.min(...vertices.map((point) => point[1]))));
  const maxY = Math.min(image.height - 1, Math.ceil(Math.max(...vertices.map((point) => point[1]))));
  for (let y = minY; y <= maxY; y += 1) {
    const intersections = [];
    for (let index = 0; index < vertices.length; index += 1) {
      const [x1, y1] = vertices[index];
      const [x2, y2] = vertices[(index + 1) % vertices.length];
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
        intersections.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1));
      }
    }
    intersections.sort((a, b) => a - b);
    for (let index = 0; index + 1 < intersections.length; index += 2) {
      fillRect(
        image,
        Math.ceil(intersections[index]),
        y,
        Math.floor(intersections[index + 1]),
        y,
        color,
      );
    }
  }
}

/**
 * 线段加粗成粗笔画（厚度 thickness，几何上为到线段距离 ≤ thickness/2 的像素集合）。
 * 用于车架/桅杆/旋翼等"细长但 ≥ MIN_STROKE"的图元。
 */
function strokeSegment(image, x0, y0, x1, y1, thickness, color = [0, 0, 0]) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const lengthSq = dx * dx + dy * dy;
  const half = thickness / 2;
  const minX = Math.max(0, Math.floor(Math.min(x0, x1) - half - 1));
  const maxX = Math.min(image.width - 1, Math.ceil(Math.max(x0, x1) + half + 1));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1) - half - 1));
  const maxY = Math.min(image.height - 1, Math.ceil(Math.max(y0, y1) + half + 1));
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      let ratio = 0;
      if (lengthSq > 0) {
        ratio = ((x - x0) * dx + (y - y0) * dy) / lengthSq;
        ratio = Math.max(0, Math.min(1, ratio));
      }
      const distance = Math.hypot(x - (x0 + ratio * dx), y - (y0 + ratio * dy));
      if (distance <= half + 0.25) setPixel(image, x, y, color);
    }
  }
}

// ==================== 8 张白底黑剪影 ====================

/** 小猪佩奇风格剪影：大圆头 + 双三角耳 + 左侧突出的圆鼻子 */
function drawPigletPeppa(image) {
  fillEllipse(image, 268, 250, 118, 135); // 头
  fillPolygon(image, [[180, 150], [225, 58], [272, 132]]); // 左耳
  fillPolygon(image, [[298, 128], [345, 55], [372, 150]]); // 右耳
  fillEllipse(image, 152, 296, 62, 46); // 突出的鼻子
}

/** 风车：四叶十字 + 中心轴 + 梯形塔身（单连通） */
function drawWindmill(image) {
  fillPolygon(image, [[206, 250], [306, 250], [356, 430], [156, 430]]); // 塔身
  strokeSegment(image, 256, 210, 114, 210, 34); // 水平叶片（左右两叶）
  strokeSegment(image, 256, 210, 398, 210, 34);
  strokeSegment(image, 256, 210, 256, 68, 34); // 竖直叶片（上下两叶）
  strokeSegment(image, 256, 210, 256, 352, 34);
  fillCircle(image, 256, 210, 38); // 轮毂
}

/** 灯塔：底座 + 梯形塔身 + 灯室 + 尖顶 */
function drawLighthouse(image) {
  fillRect(image, 146, 430, 366, 448); // 底座
  fillPolygon(image, [[208, 190], [304, 190], [344, 430], [168, 430]]); // 塔身
  fillRect(image, 188, 130, 324, 190); // 灯室
  fillPolygon(image, [[184, 130], [328, 130], [256, 58]]); // 尖顶
}

/** 自行车：两个厚轮胎（孔洞）+ 车架粗管 + 车座/车把 */
function drawBicycle(image) {
  fillRing(image, 150, 350, 86, 56); // 后轮（轮胎厚 30）
  fillRing(image, 368, 350, 86, 56); // 前轮
  strokeSegment(image, 256, 330, 150, 350, 14); // 后下叉
  strokeSegment(image, 256, 330, 215, 225, 14); // 立管
  strokeSegment(image, 215, 225, 150, 350, 12); // 后上叉
  strokeSegment(image, 256, 330, 336, 236, 14); // 下管
  strokeSegment(image, 215, 225, 340, 214, 14); // 上管
  strokeSegment(image, 368, 350, 340, 214, 14); // 前叉
  strokeSegment(image, 215, 240, 215, 200, 14); // 座管（把车座接到立管上）
  strokeSegment(image, 168, 200, 252, 200, 22); // 车座
  strokeSegment(image, 340, 236, 340, 186, 14); // 把立（把车把接到前叉上）
  strokeSegment(image, 300, 186, 382, 186, 18); // 车把
  fillCircle(image, 256, 330, 18); // 中轴
}

/** 火车：底盘 + 锅炉 + 驾驶室 + 烟囱 + 轮子 */
function drawTrain(image) {
  fillRect(image, 56, 300, 452, 340); // 底盘
  fillRect(image, 100, 190, 280, 305); // 锅炉
  fillCircle(image, 140, 247, 58); // 锅炉圆头
  fillRect(image, 280, 150, 410, 305); // 驾驶室
  fillRect(image, 110, 90, 162, 195); // 烟囱
  fillRect(image, 100, 90, 172, 116); // 烟囱口沿
  fillCircle(image, 230, 168, 26); // 汽包
  fillCircle(image, 190, 355, 48); // 大轮
  fillCircle(image, 300, 355, 48); // 大轮
  fillCircle(image, 95, 360, 36); // 前小轮
}

/** 帆船：梯形船体 + 桅杆 + 主帆/前帆三角 */
function drawSailboat(image) {
  fillPolygon(image, [[100, 395], [412, 395], [360, 450], [150, 450]]); // 船体
  fillRect(image, 248, 110, 264, 430); // 桅杆
  fillPolygon(image, [[264, 130], [264, 380], [420, 380]]); // 主帆
  fillPolygon(image, [[248, 150], [248, 380], [95, 380]]); // 前帆
}

/** 直升机：主旋翼 + 机身 + 尾梁 + 尾桨 + 起落橇 */
function drawHelicopter(image) {
  fillRect(image, 60, 128, 452, 150); // 主旋翼
  fillRect(image, 246, 150, 266, 205); // 旋翼轴
  fillEllipse(image, 265, 240, 122, 60); // 机身
  fillRect(image, 360, 214, 452, 240); // 尾梁
  fillRect(image, 442, 170, 458, 280); // 尾桨
  fillRect(image, 175, 315, 355, 327); // 左/右起落橇横杆（两根并排占位，下面再补）
  fillRect(image, 175, 300, 190, 327); // 左橇前撑
  fillRect(image, 340, 300, 355, 327); // 右橇后撑
  fillRect(image, 200, 285, 212, 315); // 机身左撑杆
  fillRect(image, 318, 285, 330, 315); // 机身右撑杆
}

/** 仙人掌：主干 + 左右两条 L 形分支（单连通） */
function drawCactus(image) {
  fillRect(image, 212, 140, 300, 440); // 主干
  fillCircle(image, 256, 140, 44); // 主干圆顶
  fillRect(image, 118, 250, 220, 292); // 左臂横段
  fillRect(image, 118, 168, 160, 292); // 左臂竖段
  fillCircle(image, 139, 168, 21); // 左臂圆顶
  fillRect(image, 292, 300, 392, 342); // 右臂横段
  fillRect(image, 350, 210, 392, 342); // 右臂竖段
  fillCircle(image, 371, 210, 21); // 右臂圆顶
}

/** 固定种子伪随机数（线性同余，保证 fixture 可重复生成） */
function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * 照片式样本：浅色渐变背景 + 逐像素噪点 + 若干不规则彩色色块。
 *
 * 目标：二值化后前景碎成多块（没有占绝对多数的主块），traceMask 判 multi-part 拒绝，
 * 用于「描不出」链路样本（页面回复"只接受线稿、剪影、白底或纯色底图标"，不规划不画线）。
 * 背景变化幅度被压到低于二值化容差，保证只有彩色块成为前景；块之间留 ≥8px 间隔，
 * JPEG 压缩模糊后仍然彼此分离。
 */
function drawPhotoLike(image) {
  const random = makeRandom(20261101);
  // 1) 浅色渐变背景（蓝灰调，逐像素小幅晃动，幅度 < 背景容差 60）
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const base = 206 + Math.round(10 * Math.sin(x / 71) + 6 * Math.cos(y / 53));
      const noise = Math.round((random() - 0.5) * 22);
      setPixel(image, x, y, [base + noise, base + 3 + noise, base + 12 + noise]);
    }
  }
  // 2) 不规则彩色色块：数量多、大小相近，单个块只占前景很小比例
  const palette = [
    [200, 70, 40], [30, 120, 200], [220, 180, 30], [60, 160, 80], [160, 60, 170],
    [240, 120, 60], [20, 90, 140], [190, 40, 90], [70, 80, 200], [130, 170, 40],
  ];
  for (let blob = 0; blob < 46; blob += 1) {
    const cx = 24 + Math.floor(random() * (image.width - 48));
    const cy = 24 + Math.floor(random() * (image.height - 48));
    const rx = 9 + Math.floor(random() * 22);
    const ry = 8 + Math.floor(random() * 18);
    const color = palette[Math.floor(random() * palette.length)];
    const wobble = random() * Math.PI * 2;
    for (let y = -ry; y <= ry; y += 1) {
      for (let x = -rx; x <= rx; x += 1) {
        const angle = Math.atan2(y, x) + wobble;
        const edge = 1 + 0.18 * Math.sin(angle * 3); // 不规则轮廓
        if (((x / (rx * edge)) ** 2 + (y / (ry * edge)) ** 2) <= 1) {
          setPixel(image, cx + x, cy + y, color);
        }
      }
    }
  }
  // 3) 再叠一层强噪声（模拟照片颗粒；单点噪声不会成为独立前景块，但会加大碎裂）
  for (let index = 0; index < 9000; index += 1) {
    const x = Math.floor(random() * image.width);
    const y = Math.floor(random() * image.height);
    const [r, g, b] = getPixel(image, x, y);
    const shift = Math.round((random() - 0.5) * 30);
    setPixel(image, x, y, [
      Math.max(0, Math.min(255, r + shift)),
      Math.max(0, Math.min(255, g + shift)),
      Math.max(0, Math.min(255, b + shift)),
    ]);
  }
}

/** fixture 定义表：文件名、内容说明、绘制函数、是否照片式、是否预期有孔洞 */
const FIXTURES = [
  { file: 'piglet-peppa.png', title: '小猪佩奇风格剪影（圆头+双耳+鼻子突出）', draw: drawPigletPeppa, photo: false, expectHoles: false },
  { file: 'windmill.png', title: '风车（四叶+塔架，单连通）', draw: drawWindmill, photo: false, expectHoles: false },
  { file: 'lighthouse.png', title: '灯塔（塔身+灯室+尖顶）', draw: drawLighthouse, photo: false, expectHoles: false },
  { file: 'bicycle.png', title: '自行车（两轮+车架，轮胎内孔会被填充）', draw: drawBicycle, photo: false, expectHoles: true },
  { file: 'train.png', title: '火车（车头+烟囱+驾驶室+轮子）', draw: drawTrain, photo: false, expectHoles: false },
  { file: 'sailboat.png', title: '帆船（船体+主帆+前帆）', draw: drawSailboat, photo: false, expectHoles: false },
  { file: 'helicopter.png', title: '直升机（主旋翼+机身+尾梁+尾桨+起落橇）', draw: drawHelicopter, photo: false, expectHoles: false },
  { file: 'cactus.png', title: '仙人掌（主干+两侧分支）', draw: drawCactus, photo: false, expectHoles: false },
  { file: 'photo-like.png', title: '照片式样本（彩色渐变+噪点+不规则色块）', draw: drawPhotoLike, photo: true, expectHoles: false },
];

// ==================== PNG 编码（自写，zlib + CRC32） ====================

/** CRC32 查表（PNG 规范多项式 0xEDB88320） */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** 计算 CRC32 */
function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 写 32 位大端整数 */
function writeUint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0, 0);
  return buffer;
}

/** 组装一个 PNG chunk（长度 + 类型 + 数据 + CRC） */
function makeChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuffer, data]);
  return Buffer.concat([writeUint32(data.length), body, writeUint32(crc32(body))]);
}

/**
 * 把 RGB 帧缓冲编码为 PNG（8-bit RGB、filter 0、无交错）。
 *
 * @param {{width: number, height: number, data: Uint8Array}} image RGB 帧缓冲
 * @returns {Buffer} PNG 文件字节
 */
function encodePng(image) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8; // 位深 8
  header[9] = 2; // 颜色类型 2 = RGB
  header[10] = 0; // 压缩方法
  header[11] = 0; // 过滤方法
  header[12] = 0; // 无交错
  // 每行前缀 filter 字节 0（None），随后是 RGB 像素
  const raw = Buffer.alloc(image.height * (1 + image.width * 3));
  for (let y = 0; y < image.height; y += 1) {
    const rowStart = y * (1 + image.width * 3);
    raw[rowStart] = 0;
    image.data.subarray(y * image.width * 3, (y + 1) * image.width * 3)
      .forEach((value, index) => {
        raw[rowStart + 1 + index] = value;
      });
  }
  return Buffer.concat([
    signature,
    makeChunk('IHDR', header),
    makeChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * 解码自写 PNG（用于自检与 JPEG 模拟；支持 8-bit RGB、filter 0、无交错，并校验 CRC）。
 *
 * @param {Buffer} buffer PNG 文件字节
 * @returns {{width: number, height: number, data: Uint8Array}} RGB 帧缓冲
 */
function decodePng(buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.length < signature.length || !buffer.subarray(0, 8).equals(signature)) {
    throw new Error('PNG 签名不合法');
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  const idatParts = [];
  let sawHeader = false;
  let sawEnd = false;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = buffer.readUInt32BE(offset + 8 + length);
    const actualCrc = crc32(Buffer.concat([buffer.subarray(offset + 4, offset + 8), data]));
    if (actualCrc !== expectedCrc) throw new Error(`PNG chunk ${type} CRC 校验失败`);
    offset += 12 + length;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      const colorType = data[9];
      const interlace = data[12];
      if (bitDepth !== 8 || colorType !== 2) throw new Error(`不支持的 PNG 格式：位深=${bitDepth} 颜色类型=${colorType}`);
      if (interlace !== 0) throw new Error('不支持交错 PNG');
      sawHeader = true;
    } else if (type === 'IDAT') {
      idatParts.push(data);
    } else if (type === 'IEND') {
      sawEnd = true;
      break;
    }
  }
  if (!sawHeader || !sawEnd || idatParts.length === 0) throw new Error('PNG 结构不完整（缺 IHDR/IDAT/IEND）');
  const raw = zlib.inflateSync(Buffer.concat(idatParts));
  const stride = 1 + width * 3;
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * stride;
    if (raw[rowStart] !== 0) throw new Error(`第 ${y} 行 filter=${raw[rowStart]}，仅支持 filter 0`);
    for (let x = 0; x < width; x += 1) {
      const source = rowStart + 1 + x * 3;
      const target = (y * width + x) * 3;
      data[target] = raw[source];
      data[target + 1] = raw[source + 1];
      data[target + 2] = raw[source + 2];
    }
  }
  return { width, height, data };
}

// ==================== 分析 / 自检 ====================

/** RGB 帧缓冲转 RGBA（alpha 255），交给二值化 */
function toRgba(image) {
  const rgba = new Uint8ClampedArray(image.width * image.height * 4);
  for (let index = 0; index < image.width * image.height; index += 1) {
    rgba[index * 4] = image.data[index * 3];
    rgba[index * 4 + 1] = image.data[index * 3 + 1];
    rgba[index * 4 + 2] = image.data[index * 3 + 2];
    rgba[index * 4 + 3] = 255;
  }
  return rgba;
}

/**
 * 模拟页面 JPEG 压缩（长边 ≤1024 不缩放，质量 0.85）的退化：
 * 3×3 高斯平滑 + 逐像素量化噪声 + 8×8 分块亮度偏移。用于验证剪影抗 JPEG 噪声。
 *
 * @param {{width: number, height: number, data: Uint8Array}} image 原图
 * @param {number} seed 伪随机种子（固定 → 幂等）
 * @returns {{width: number, height: number, data: Uint8Array}} 退化后的帧缓冲
 */
function simulateJpegArtifacts(image, seed) {
  const random = makeRandom(seed);
  const { width, height } = image;
  const source = Uint8Array.from(image.data);
  const data = new Uint8Array(width * height * 3);
  const weights = [1, 2, 1, 2, 4, 2, 1, 2, 1];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      for (let channel = 0; channel < 3; channel += 1) {
        let sum = 0;
        let weightSum = 0;
        let weightIndex = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const weight = weights[weightIndex];
            weightIndex += 1;
            const nx = Math.min(width - 1, Math.max(0, x + dx));
            const ny = Math.min(height - 1, Math.max(0, y + dy));
            sum += source[(ny * width + nx) * 3 + channel] * weight;
            weightSum += weight;
          }
        }
        const blockShift = ((Math.floor(x / 8) * 7 + Math.floor(y / 8) * 13) % 5) - 2;
        const quantized = Math.round(sum / weightSum / 4) * 4;
        const value = quantized + Math.round((random() - 0.5) * 16) + blockShift;
        data[(y * width + x) * 3 + channel] = Math.max(0, Math.min(255, value));
      }
    }
  }
  return { width, height, data };
}

/**
 * 分析一张剪影：二值化 → 描摹，返回前景占比、外接框、留白、连通分量、孔洞、IoU 等。
 *
 * @param {{width: number, height: number, data: Uint8Array}} image RGB 帧缓冲
 * @returns {object} 指标
 */
function analyzeSilhouette(image) {
  const rgba = toRgba(image);
  const binarized = binarizeImageData(rgba, image.width, image.height);
  const metrics = {
    binarizeStatus: binarized.status,
    binarizeCode: binarized.reasons[0]?.code ?? null,
    foregroundRatio: binarized.diagnostics.foregroundRatio,
    foregroundPixels: 0,
    bounds: null,
    margins: null,
    trace: null,
  };
  if (binarized.status !== 'ok') return metrics;
  const bounds = maskBounds(binarized.mask, image.width, image.height);
  metrics.foregroundPixels = bounds.count;
  metrics.bounds = { minX: bounds.minX, minY: bounds.minY, maxX: bounds.maxX, maxY: bounds.maxY, width: bounds.width, height: bounds.height };
  metrics.margins = {
    left: bounds.minX,
    top: bounds.minY,
    right: image.width - 1 - bounds.maxX,
    bottom: image.height - 1 - bounds.maxY,
  };
  const traced = traceMask(binarized.mask, image.width, image.height);
  metrics.trace = traced;
  return metrics;
}

/**
 * 模拟"页面上传压 JPEG 后再描摹"并计算与原始剪影（填充后掩膜）的 IoU。
 *
 * @param {{width: number, height: number, data: Uint8Array}} image 原图
 * @param {object} originalMetrics analyzeSilhouette 的结果（含 trace.filledMask）
 * @returns {{ok: boolean, status: string, code: string|null, iou: number}} 结果
 */
function checkJpegRobustness(image, originalMetrics) {
  const degraded = simulateJpegArtifacts(image, 20261101);
  const binarized = binarizeImageData(toRgba(degraded), degraded.width, degraded.height);
  if (binarized.status !== 'ok') {
    return { ok: false, status: binarized.status, code: binarized.reasons[0]?.code ?? null, iou: 0 };
  }
  const traced = traceMask(binarized.mask, degraded.width, degraded.height);
  if (traced.status !== 'ok') {
    return { ok: false, status: traced.status, code: traced.reasons[0]?.code ?? null, iou: 0 };
  }
  // 与页面链路一致：页面点列 vs 原始剪影掩膜（E2E 用原图独立校验）
  const iou = computeMaskIou(traced.points, originalMetrics.trace.filledMask, degraded.width, degraded.height);
  return { ok: iou >= IMAGE_TRACE_IOU_MIN, status: traced.status, code: null, iou };
}

/**
 * 分析照片式样本：二值化 + 描摹，返回拒绝码（期望被拒绝，不产出点列）。
 *
 * @param {{width: number, height: number, data: Uint8Array}} image RGB 帧缓冲
 * @param {number} [seed] 非空时先做 JPEG 退化再分析（模拟页面上传链路）
 * @returns {{status: string, code: string|null, message: string|null, components: number, foregroundRatio: number}} 结论
 */
function analyzePhoto(image, seed = null) {
  const source = seed === null ? image : simulateJpegArtifacts(image, seed);
  const binarized = binarizeImageData(toRgba(source), source.width, source.height);
  if (binarized.status !== 'ok') {
    return {
      status: binarized.status,
      code: binarized.reasons[0].code,
      message: binarized.reasons[0].message,
      components: 0,
      foregroundRatio: binarized.diagnostics.foregroundRatio,
    };
  }
  const traced = traceMask(binarized.mask, source.width, source.height);
  return {
    status: traced.status,
    code: traced.reasons[0]?.code ?? null,
    message: traced.reasons[0]?.message ?? null,
    components: traced.diagnostics.components,
    foregroundRatio: traced.diagnostics.foregroundRatio,
  };
}

// ==================== 主流程 ====================

/** 收集失败原因（不中断，跑完统一报告） */
const failures = [];

/** 记录一条约束失败 */
function fail(message) {
  failures.push(message);
  console.log(`[失败] ${message}`);
}

/** 格式化百分比 */
function percent(value) {
  return `${(value * 100).toFixed(2)}%`;
}

/**
 * 检查并打印一张剪影的所有硬约束；返回写 README 用的指标行。
 *
 * @param {object} fixture fixture 定义
 * @param {{width: number, height: number, data: Uint8Array}} image RGB 帧缓冲
 * @returns {object} 指标行
 */
function validateSilhouette(fixture, image) {
  const metrics = analyzeSilhouette(image);
  const label = fixture.file;
  if (metrics.binarizeStatus !== 'ok') {
    fail(`${label}: 二值化被拒绝（${metrics.binarizeCode}），剪影必须可二值化`);
    return { metrics, jpeg: null };
  }
  const traced = metrics.trace;
  if (traced.status !== 'ok') {
    fail(`${label}: 描摹被拒绝（${traced.reasons[0]?.code}：${traced.reasons[0]?.message}）`);
    return { metrics, jpeg: null };
  }
  const diagnostics = traced.diagnostics;
  if (metrics.foregroundRatio < 0.15 || metrics.foregroundRatio > 0.45) {
    fail(`${label}: 前景占比 ${percent(metrics.foregroundRatio)} 不在 15%~45%`);
  }
  for (const [side, value] of Object.entries(metrics.margins)) {
    if (value < MIN_MARGIN) fail(`${label}: ${side} 留白 ${value}px < ${MIN_MARGIN}px`);
  }
  if (diagnostics.components !== 1) fail(`${label}: 连通分量 ${diagnostics.components} 个，要求单连通`);
  if (diagnostics.strayPixels !== 0) fail(`${label}: 仍有 ${diagnostics.strayPixels} 个碎片像素，要求单连通无碎片`);
  const aspect = Math.min(metrics.bounds.width, metrics.bounds.height) / Math.max(metrics.bounds.width, metrics.bounds.height);
  if (aspect < 0.3) fail(`${label}: 长短边比 ${aspect.toFixed(3)} < 0.3（normalizeCustomShape 会拒绝）`);
  if (diagnostics.iou < IMAGE_TRACE_IOU_MIN) fail(`${label}: 描摹 IoU ${diagnostics.iou.toFixed(4)} < ${IMAGE_TRACE_IOU_MIN}`);
  if (diagnostics.pointCount < IMAGE_TRACE_POINT_MIN || diagnostics.pointCount > IMAGE_TRACE_POINT_MAX) {
    fail(`${label}: 点数 ${diagnostics.pointCount} 不在 [${IMAGE_TRACE_POINT_MIN}, ${IMAGE_TRACE_POINT_MAX}]`);
  }
  if (fixture.expectHoles && diagnostics.filledHoles === 0) {
    fail(`${label}: 预期含孔洞（轮胎内圈）但填充孔洞数为 0`);
  }
  const jpeg = checkJpegRobustness(image, metrics);
  if (!jpeg.ok) {
    fail(`${label}: JPEG 模拟后描摹不可用（${jpeg.status}/${jpeg.code}，IoU ${jpeg.iou.toFixed(4)}）`);
  }
  console.log(
    `[fixture] ${label}: ${image.width}×${image.height} 前景 ${metrics.foregroundPixels} px (${percent(metrics.foregroundRatio)}) ` +
    `外接框 ${metrics.bounds.width}×${metrics.bounds.height} 留白 ${metrics.margins.left}/${metrics.margins.top}/${metrics.margins.right}/${metrics.margins.bottom} ` +
    `分量 ${diagnostics.components} 孔 ${diagnostics.filledHoles} 点 ${diagnostics.pointCount} IoU ${diagnostics.iou.toFixed(4)} JPEG模拟IoU ${jpeg.iou.toFixed(4)}`,
  );
  return { metrics, jpeg };
}

/**
 * 检查并打印照片式样本的"必须被拒绝"结论；返回写 README 用的指标行。
 *
 * @param {object} fixture fixture 定义
 * @param {{width: number, height: number, data: Uint8Array}} image RGB 帧缓冲
 * @returns {object} 指标行
 */
function validatePhoto(fixture, image) {
  const label = fixture.file;
  const raw = analyzePhoto(image);
  const degraded = analyzePhoto(image, 20261101);
  if (raw.status !== 'rejected') fail(`${label}: 原始图未被拒绝（status=${raw.status}），照片式样本必须描不出`);
  if (degraded.status !== 'rejected') fail(`${label}: JPEG 模拟后未被拒绝（status=${degraded.status}），照片式样本必须描不出`);
  if (raw.status === 'rejected' && raw.code !== 'multi-part') {
    console.log(`[提示] ${label}: 原始图拒绝码为 ${raw.code}（期望 multi-part，但不是硬性要求）`);
  }
  const bounds = maskBounds(
    binarizeImageData(toRgba(image), image.width, image.height).mask ?? new Uint8Array(image.width * image.height),
    image.width,
    image.height,
  );
  console.log(
    `[fixture] ${label}: ${image.width}×${image.height} 前景约 ${percent(raw.foregroundRatio)} 分量 ${raw.components} ` +
    `→ 原始图拒绝 ${raw.code}；JPEG 模拟拒绝 ${degraded.code}（前景外接框 ${bounds.width}×${bounds.height}）`,
  );
  return { raw, degraded, bounds };
}

/** 把 fixture 指标写成 README.md（每次生成覆盖） */
function buildReadme(rows) {
  const lines = [];
  lines.push('# 图像描摹链路验收 fixtures');
  lines.push('');
  lines.push('本目录的 9 张 PNG 是「B 图片描摹」链路验收的固定输入（方案 §4.2「描摹」「描不出」两行），');
  lines.push('由 `tools/make-trace-fixtures.mjs` 用**纯 Node、零第三方依赖**生成，**不要手工修改 PNG**；');
  lines.push('改动形状请改生成脚本后重跑，保证能力测试与链路验收的输入可复现。');
  lines.push('');
  lines.push('## 重新生成');
  lines.push('');
  lines.push('```bash');
  lines.push('node tools/make-trace-fixtures.mjs');
  lines.push('```');
  lines.push('');
  lines.push('脚本幂等（固定种子伪随机 + 确定性 zlib 压缩），重复运行产生完全相同的字节；');
  lines.push('脚本内置自检：PNG 编码→解码往返、CRC 校验、二值化→描摹 IoU、JPEG 压缩模拟鲁棒性，');
  lines.push('任何一张不满足约束都会打印失败原因并以退出码 1 结束（不会写入半成品）。');
  lines.push('');
  lines.push('## 生成方式');
  lines.push('');
  lines.push('- 编码：自写 PNG 写入器（`node:zlib` 的 `deflateSync` + 自写 CRC32），8-bit RGB（color type 2）、');
  lines.push('  每行 filter 0（None）、无交错（interlace 0）；解码器同样自写，用于自检与 JPEG 模拟。');
  lines.push(`- 画布：${WIDTH}×${HEIGHT} 像素，白底 \`#ffffff\`、黑剪影 \`#000000\`，硬边缘无抗锯齿。`);
  lines.push('- 图元：圆 / 椭圆 / 圆环 / 凸凹多边形 / 粗线段（车架、桅杆、旋翼等）的并集；');
  lines.push(`  8 张剪影均为**单连通**（无碎片），四周边距 ≥ ${MIN_MARGIN}px（实际留白见下表），前景占比约 15%~45%，`);
  lines.push(`  最细笔画构造下限 ${MIN_STROKE}px（远高于方案要求的 6px，抗 JPEG 压缩模糊）。`);
  lines.push('- 页面上传流程会先把图片压成 JPEG（长边 ≤ 1024、质量 0.85）再描摹，生成脚本对每张剪影做了');
  lines.push('  「3×3 平滑 + 量化噪声 + 8×8 分块偏移」的 JPEG 退化模拟，并断言退化后描摹点列与原图填充掩膜 IoU ≥ 0.90。');
  lines.push('');
  lines.push('## 文件清单');
  lines.push('');
  lines.push('| 文件 | 内容 / 用途 | 前景像素 | 前景占比 | 前景外接框 | 四周留白(左/上/右/下) | 连通分量 | 填充孔洞 | 描摹点数 | 描摹 IoU | JPEG 模拟 IoU |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const row of rows) {
    lines.push(
      `| \`${row.file}\` | ${row.title} | ${row.foregroundPixels} | ${row.foregroundRatioText} | ` +
      `${row.boundsText} | ${row.marginsText} | ${row.components} | ${row.holes} | ${row.points} | ${row.iouText} | ${row.jpegIouText} |`,
    );
  }
  lines.push('');
  const photo = rows.find((row) => row.file === 'photo-like.png');
  lines.push('## photo-like.png（描不出样本）');
  lines.push('');
  lines.push('彩色渐变背景 + 逐像素噪点 + 46 个不规则彩色色块，模拟"照片"：二值化后前景碎成多块、');
  lines.push('没有占绝对多数的主块，`traceMask` 判 `multi-part` 拒绝（抽不出单条闭合外轮廓）。');
  lines.push('链路验收用它断言：页面**不规划、不画线、不调用模型估点**，回复固定句');
  lines.push('「只接受线稿、剪影、白底或纯色底图标。」并记录 `agent.imageTrace.rejected`。');
  lines.push('');
  lines.push('## 链路验收用法');
  lines.push('');
  lines.push('8 张剪影对应方案 §4.2 的「描摹」行：上传后点「当前视野中心」，断言页面点列与');
  lines.push('本图**填充后外轮廓** IoU ≥ 0.90、点数 120~320、来源为图像描摹、孔不保留；');
  lines.push('`photo-like.png` 对应「描不出」行。9 张图的文件名与内容是固定契约，链路验收脚本按文件名引用。');
  lines.push('');
  lines.push('> 说明：图片上传后页面会统一压成 JPEG 再描摹，这是所有图片共用的画布预处理（不区分图片种类、');
  lines.push('> 不做照片分类）；描摹只取一张图的实心外轮廓，中间空洞不保留。');
  lines.push('');
  return `${lines.join('\n')}`;
}

/** 主函数：生成全部 fixture、自检、写盘、打印汇总 */
function main() {
  console.log(`[生成] 输出目录：${path.relative(ROOT, OUT_DIR)}`);
  console.log(`[生成] 画布 ${WIDTH}×${HEIGHT}，白底黑剪影，PNG 8-bit RGB / filter 0 / 无交错，JPEG 质量 ${JPEG_QUALITY}`);
  const startTime = Date.now();
  const files = new Map();
  const rows = [];
  for (const fixture of FIXTURES) {
    const image = createImage(WIDTH, HEIGHT);
    fixture.draw(image);
    const png = encodePng(image);
    // 编码→解码往返自检：解码结果必须与原帧缓冲逐字节一致（同时校验 PNG 结构与 CRC）
    const decoded = decodePng(png);
    if (decoded.width !== WIDTH || decoded.height !== HEIGHT) {
      fail(`${fixture.file}: PNG 解码尺寸 ${decoded.width}×${decoded.height} 与预期不符`);
    }
    if (decoded.data.length !== image.data.length) fail(`${fixture.file}: PNG 解码像素长度不符`);
    for (let index = 0; index < image.data.length; index += 1) {
      if (decoded.data[index] !== image.data[index]) {
        fail(`${fixture.file}: PNG 编解码往返第 ${index} 字节不一致`);
        break;
      }
    }
    if (fixture.photo) {
      const photo = validatePhoto(fixture, image);
      rows.push({
        file: fixture.file,
        title: fixture.title,
        foregroundPixels: Math.round(photo.raw.foregroundRatio * WIDTH * HEIGHT),
        foregroundRatioText: percent(photo.raw.foregroundRatio),
        boundsText: `${photo.bounds.width}×${photo.bounds.height}`,
        marginsText: '—',
        components: photo.raw.components,
        holes: '—',
        points: '—',
        iouText: `—（拒绝 ${photo.raw.code}）`,
        jpegIouText: `—（拒绝 ${photo.degraded.code}）`,
      });
    } else {
      const validated = validateSilhouette(fixture, image);
      const { metrics, jpeg } = validated;
      const traceDiagnostics = metrics.trace?.diagnostics ?? null;
      rows.push({
        file: fixture.file,
        title: fixture.title,
        foregroundPixels: metrics.foregroundPixels,
        foregroundRatioText: percent(metrics.foregroundRatio),
        boundsText: metrics.bounds ? `${metrics.bounds.width}×${metrics.bounds.height}` : '—',
        marginsText: metrics.margins
          ? `${metrics.margins.left}/${metrics.margins.top}/${metrics.margins.right}/${metrics.margins.bottom}`
          : '—',
        components: traceDiagnostics ? traceDiagnostics.components : '—',
        holes: traceDiagnostics ? traceDiagnostics.filledHoles : '—',
        points: traceDiagnostics ? traceDiagnostics.pointCount : '—',
        iouText: traceDiagnostics ? traceDiagnostics.iou.toFixed(4) : '—',
        jpegIouText: jpeg ? jpeg.iou.toFixed(4) : '—',
      });
    }
    files.set(fixture.file, png);
  }
  if (failures.length > 0) {
    console.log('');
    console.log(`[失败] 共 ${failures.length} 项约束未通过，未写入任何文件：`);
    for (const message of failures) console.log(`  - ${message}`);
    process.exitCode = 1;
    return;
  }
  // 全部通过才写盘；已存在且字节一致说明幂等
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let identical = 0;
  let rewritten = 0;
  for (const [file, buffer] of files) {
    const target = path.join(OUT_DIR, file);
    if (fs.existsSync(target) && fs.readFileSync(target).equals(buffer)) {
      identical += 1;
    } else {
      fs.writeFileSync(target, buffer);
      rewritten += 1;
    }
  }
  // 从磁盘回读并再次解码，确认真实落盘文件可被独立解码（PNG 结构合法）
  for (const fixture of FIXTURES) {
    const target = path.join(OUT_DIR, fixture.file);
    const decoded = decodePng(fs.readFileSync(target));
    if (decoded.width !== WIDTH || decoded.height !== HEIGHT) {
      fail(`${fixture.file}: 落盘回读尺寸异常`);
    }
  }
  const readme = buildReadme(rows);
  const readmePath = path.join(OUT_DIR, 'README.md');
  const readmeSame = fs.existsSync(readmePath) && fs.readFileSync(readmePath, 'utf8') === readme;
  if (!readmeSame) fs.writeFileSync(readmePath, readme);
  if (failures.length > 0) {
    console.log('[失败] 落盘回读校验未通过');
    process.exitCode = 1;
    return;
  }
  console.log('');
  console.log(`[完成] 9 张 PNG + README.md 已就绪（${path.relative(ROOT, OUT_DIR)}），耗时 ${Date.now() - startTime}ms`);
  console.log(`[幂等] 重复运行字节一致：PNG ${identical}/9 未改动、${rewritten} 张新写入；README.md ${readmeSame ? '未改动' : '已重写'}`);
  for (const [file, buffer] of files) {
    console.log(`  - ${file}  ${buffer.length} 字节`);
  }
}

main();
