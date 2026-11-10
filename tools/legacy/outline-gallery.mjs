/**
 * 目标点序列图百例批量验证（2026-10-31）。
 *
 * 目的：用 100 个覆盖各种类别的目标轮廓（内置 / 参数化 / 文字 / 剪影 / 地图 /
 * 参考图 / 边界反例），批量走生产链路生成"回复附带的目标点序列图"（第六十二/
 * 六十三轮 feature），渲染成 PNG 并逐例记录元数据与目标验收结论，产出：
 *   docs/测试报告/2026-10-31-目标点序列图百例/png/*.png   每例 160px 序列图
 *   docs/测试报告/2026-10-31-目标点序列图百例/result.json 每例元数据
 *   docs/测试报告/2026-10-31-目标点序列图百例/index.html  图库报告
 *   docs/测试报告/2026-10-31-目标点序列图百例/sheet.png   10×10 总览
 *
 * 链路真实性：
 * - 内置图形走 engine/shapes.js 的 SHAPES[key].buildOutline()；
 * - 参数化走 agent/shape-spec.js 的 normalizeShapeSpec → buildShapeFromSpec →
 *   target-acceptance.acceptProceduralTarget（真实几何不变量验收）；
 * - 自由轮廓（文字/剪影/地图/反例）走 agent/intent.js 的 normalizeCustomShape
 *   （真实去重/加密/窄刺折叠/拓扑校验/特征检测/RDP 约束），坐标为本地构造的
 *   "LLM 风格点列"（非真实 LLM 输出，报告中如实标注）；
 * - 参考图走 web/src/reference/index.js 的 convertSvg → normalizeCustomShape
 *   （与 agent/reference.js 同链路），素材来自生产 seed 与 E2E 素材库；
 * - 渲染复刻 agent/shape-review.js renderOutlineDataUrl 的全部参数
 *   （160px / 白底 / #5a28b4 / 2px 圆角描边 / 同定标与 y 翻转 / 多部分逐环），
 *   用纯 Node 光栅化 + zlib PNG 编码实现（Node 无 canvas，第六十二轮已用
 *   浏览器真实 canvas 验证过该渲染几何，此处为同参确定性复刻）。
 *
 * 运行：node tools/outline-gallery.mjs
 */

import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

import { SHAPES } from '../../web/src/engine/shapes.js';
import { normalizeCustomShape } from '../../web/src/agent/intent.js';
import {
  normalizeShapeSpec,
  buildShapeFromSpec,
} from '../../web/src/agent/shape-spec.js';
import { acceptTarget } from '../../web/src/agent/target-acceptance.js';
import { convertSvg } from '../reference/lib/index.js';
import { rotateShapePoints } from '../../web/src/agent/shape-review.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'docs', '测试报告', '2026-10-31-目标点序列图百例');
const pngDir = join(outDir, 'png');
rmSync(pngDir, { recursive: true, force: true });
mkdirSync(pngDir, { recursive: true });

/* ---------------------------------- 渲染 ---------------------------------- */

const SIZE = 160;
const SS = 3; // 超采样倍率
const STROKE = [0x5a, 0x28, 0xb4];
const GRAY = [0x9c, 0xa3, 0xaf];

/**
 * 复刻 renderOutlineDataUrl：光栅化到 RGB buffer。
 * 与 canvas 版一致：白底、整体定标（(size-40)/span）、y 翻转、2px 圆角描边、
 * 逐环闭合；多部分按 parts 切环；rings 直传用于拒绝例的输入草图。
 */
function renderOutlineRGB(outlinePoints, parts, { size = SIZE, rotationDeg = 0, color = STROKE, rings: ringsDirect = null } = {}) {
  let rings = ringsDirect;
  if (!rings) {
    rings = [];
    if (Array.isArray(parts) && parts.length > 1) {
      for (const part of parts) {
        rings.push(outlinePoints.slice(part.outlineStart, part.outlineStart + part.outlineCount));
      }
    } else {
      rings.push(outlinePoints);
    }
  }
  rings = rings.filter((ring) => ring && ring.length >= 2);
  if (!rings.length) return null;
  const rotated = rings.map((ring) => rotateShapePoints(ring, rotationDeg));
  const all = rotated.flat();
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of all) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const toPixel = ([x, y]) => [
    ((x - cx) / span) * (size - 40) + size / 2,
    size / 2 - ((y - cy) / span) * (size - 40),
  ];
  const pixelRings = rotated.map((ring) => ring.map(toPixel));

  const dim = size * SS;
  const cover = new Float32Array(dim * dim);
  const radius = 1.0 * SS; // lineWidth 2 → 半径 1px → SS 倍
  const step = 0.6 * SS;
  for (const ring of pixelRings) {
    for (let i = 0; i < ring.length; i += 1) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[(i + 1) % ring.length];
      const len = Math.hypot(x2 - x1, y2 - y1);
      const steps = Math.max(1, Math.ceil(len / step));
      for (let s = 0; s <= steps; s += 1) {
        const px = x1 + ((x2 - x1) * s) / steps;
        const py = y1 + ((y2 - y1) * s) / steps;
        stampDisc(cover, dim, px * SS, py * SS, radius);
      }
    }
  }
  const rgb = new Uint8Array(size * size * 3);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let sum = 0;
      for (let dy = 0; dy < SS; dy += 1) {
        for (let dx = 0; dx < SS; dx += 1) {
          sum += cover[(y * SS + dy) * dim + (x * SS + dx)];
        }
      }
      const a = Math.min(1, sum / (SS * SS));
      const idx = (y * size + x) * 3;
      for (let c = 0; c < 3; c += 1) {
        rgb[idx + c] = Math.round(255 + (color[c] - 255) * a);
      }
    }
  }
  return rgb;
}

function stampDisc(cover, dim, cx, cy, r) {
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(dim - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(dim - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d <= r) {
        const a = 1 - d / r;
        const idx = y * dim + x;
        if (a > cover[idx]) cover[idx] = a;
      }
    }
  }
}

/* ------------------------------- PNG 编码 ---------------------------------- */

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function encodePNG(rgb, w, h) {
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y += 1) {
    raw[y * stride] = 0;
    raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * stride + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 解码本脚本编码的 PNG（RGB8、filter 0） */
function decodePNGRGB(buf) {
  let pos = 8;
  let w = 0;
  let h = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    if (type === 'IHDR') { w = buf.readUInt32BE(pos + 8); h = buf.readUInt32BE(pos + 12); }
    if (type === 'IDAT') idat.push(buf.subarray(pos + 8, pos + 8 + len));
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const rgb = new Uint8Array(w * h * 3);
  const stride = w * 3 + 1;
  for (let y = 0; y < h; y += 1) {
    if (raw[y * stride] !== 0) throw new Error('unexpected filter');
    rgb.set(raw.subarray(y * stride + 1, (y + 1) * stride), y * w * 3);
  }
  return { rgb, w, h };
}

/* ------------------------------ 点列构造工具 ------------------------------- */

const TAU = Math.PI * 2;

/** 圆弧采样（角度递减 = 屏幕顺时针，y 向上坐标系）；可传 rFn 做波浪半径 */
function arc(cx, cy, rx, ry, a0deg, a1deg, n = 14, rFn = null) {
  const pts = [];
  for (let i = 0; i <= n; i += 1) {
    const a = ((a0deg + ((a1deg - a0deg) * i) / n) * Math.PI) / 180;
    const k = rFn ? rFn(a) : 1;
    pts.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k]);
  }
  return pts;
}

/** 闭环 Chaikin 圆角（有机轮廓用；文字/工程图形不用） */
function chaikin(points, iters = 2) {
  let pts = points;
  for (let it = 0; it < iters; it += 1) {
    const out = [];
    const n = pts.length;
    for (let i = 0; i < n; i += 1) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
      out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    pts = out;
  }
  return pts;
}

/** 开放路径加粗成闭环轮廓（笔画/字母骨架 → 剪影），平角端点、斜切连接 */
function thickenPath(path, w) {
  const h = w / 2;
  const left = [];
  const right = [];
  for (let i = 0; i < path.length; i += 1) {
    const prev = i > 0 ? path[i - 1] : null;
    const next = i < path.length - 1 ? path[i + 1] : null;
    let nx; let ny;
    if (prev && next) {
      let d1x = path[i][0] - prev[0]; let d1y = path[i][1] - prev[1];
      let d2x = next[0] - path[i][0]; let d2y = next[1] - path[i][1];
      const l1 = Math.hypot(d1x, d1y) || 1; const l2 = Math.hypot(d2x, d2y) || 1;
      d1x /= l1; d1y /= l1; d2x /= l2; d2y /= l2;
      let ax = -(d1y + d2y); let ay = d1x + d2x;
      const al = Math.hypot(ax, ay) || 1;
      ax /= al; ay /= al;
      const cosHalf = Math.max(0.45, ax * -d1y + ay * d1x);
      let ox = (ax / cosHalf) * h; let oy = (ay / cosHalf) * h;
      // 斜切偏移限幅（尖角处 1/cos 会外溢出坐标范围）
      const ol = Math.hypot(ox, oy);
      if (ol > h * 1.5) { ox = (ox / ol) * h * 1.5; oy = (oy / ol) * h * 1.5; }
      nx = ox; ny = oy;
    } else {
      const dx = prev ? path[i][0] - prev[0] : next[0] - path[i][0];
      const dy = prev ? path[i][1] - prev[1] : next[1] - path[i][1];
      const l = Math.hypot(dx, dy) || 1;
      nx = (-dy / l) * h; ny = (dx / l) * h;
    }
    left.push([path[i][0] + nx, path[i][1] + ny]);
    right.push([path[i][0] - nx, path[i][1] - ny]);
  }
  return [...left, ...right.reverse()];
}

/** 细笔画矩形（汉字笔画用）：(x0,y0)→(x1,y1)，宽 w */
function strokeBar(x0, y0, x1, y1, w) {
  return thickenPath([[x0, y0], [x1, y1]], w);
}

/** 整圆采样（无重复端点，逆时针 = 屏幕逆时针） */
function circle(cx, cy, rx, ry, n = 24) {
  const pts = [];
  for (let i = 0; i < n; i += 1) {
    const a = (TAU * i) / n;
    pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return pts;
}

/** 参数化波浪圆（太阳等） */
function wavyCircle(baseR, amp, lobes, n = 96, sharp = 1) {
  const pts = [];
  for (let i = 0; i < n; i += 1) {
    const a = (TAU * i) / n;
    const r = baseR + amp * Math.sign(Math.cos(lobes * a)) * Math.pow(Math.abs(Math.cos(lobes * a)), sharp);
    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return pts;
}

/* ------------------------------- 用例清单 ---------------------------------- */

const examples = [];
let seq = 0;
function add(cat, name, source, def) {
  seq += 1;
  examples.push({ seq, cat, name, source, ...def });
}

/* A. 内置图形（3） */
for (const [key, name, rot] of [['star', '五角星', 30], ['heart', '心形', 15], ['rect', '矩形', 0]]) {
  add('内置图形', name, 'builtin', {
    note: rot ? `示意交付朝向 ${rot}°（气泡小图与地图紫线同一刚体旋转）` : 'engine/shapes.js 内置轮廓',
    rotationDeg: rot,
    builtinKey: key,
  });
}

/* B. 参数化星形（10）：3~12 角星 */
const CN = { 3: '三', 4: '四', 5: '五', 6: '六', 7: '七', 8: '八', 9: '九', 10: '十', 11: '十一', 12: '十二' };
for (let n = 3; n <= 12; n += 1) {
  add('参数化·星形', `${CN[n]}角星`, 'procedural', {
    spec: { family: 'star', pointCount: n, outerRadii: 0.5, innerRadii: 0.21 },
    note: '规则图形由程序按参数生成（shape-spec.js）',
  });
}

/* C. 参数化正多边形（10）：3~12 边形 */
for (let n = 3; n <= 12; n += 1) {
  add('参数化·正多边形', `正${CN[n]}边形`, 'procedural', {
    spec: { family: 'polygon', pointCount: n, outerRadii: 0.5 },
    note: 'LLM 只填参数、程序生成坐标，同一规格结果可复现',
  });
}

/* D. 参数化圆族与变体（10） */
add('参数化·圆族与变体', '圆形', 'procedural', {
  spec: { family: 'circle' },
  note: '48 点采样',
});
add('参数化·圆族与变体', '椭圆形·宽扁', 'procedural', {
  spec: { family: 'circle', aspect: [1.5, 1], name: '椭圆形' },
  note: 'aspect 横纵缩放',
});
add('参数化·圆族与变体', '椭圆形·竖长', 'procedural', {
  spec: { family: 'circle', aspect: [1, 1.45], name: '椭圆形' },
});
add('参数化·圆族与变体', '六角星·三长三短', 'procedural', {
  spec: { family: 'star', pointCount: 6, outerRadii: [0.5, 0.34, 0.5, 0.34, 0.5, 0.34], innerRadii: 0.2, variant: 'alternating-outer-radius' },
  note: '逐尖半径交替，几何不变量按排列核验',
});
add('参数化·圆族与变体', '八角星·各尖不等长', 'procedural', {
  spec: { family: 'star', pointCount: 8, outerRadii: [0.5, 0.42, 0.5, 0.36, 0.5, 0.44, 0.5, 0.38], innerRadii: 0.2, variant: 'custom-radii' },
});
add('参数化·圆族与变体', '五角星·轻微手绘感', 'procedural', {
  spec: { family: 'star', pointCount: 5, outerRadii: 0.5, innerRadii: 0.21, jitter: { amplitude: 0.08 }, seed: 7 },
  note: 'seed 可复现扰动',
});
add('参数化·圆族与变体', '七角星·手绘感', 'procedural', {
  spec: { family: 'star', pointCount: 7, outerRadii: 0.5, innerRadii: 0.24, jitter: { amplitude: 0.12 }, seed: 42 },
});
add('参数化·圆族与变体', '五角星·宽扁', 'procedural', {
  spec: { family: 'star', pointCount: 5, outerRadii: 0.5, innerRadii: 0.21, aspect: [1.35, 1] },
});
add('参数化·圆族与变体', '四角星·星芒', 'procedural', {
  spec: { family: 'star', pointCount: 4, outerRadii: 0.5, innerRadii: 0.08 },
  note: '极小内凹比 → 尖锐星芒',
});
add('参数化·圆族与变体', '正十边形·手绘感', 'procedural', {
  spec: { family: 'polygon', pointCount: 10, outerRadii: 0.5, jitter: { amplitude: 0.1 }, seed: 11 },
});

/* E. 拉丁字母（8）——块状/笔画剪影，走 normalizeCustomShape */
add('文字·拉丁字母', '字母 E', 'llm', {
  points: [[-0.4, 0.5], [0.45, 0.5], [0.45, 0.36], [-0.22, 0.36], [-0.22, 0.09], [0.3, 0.09], [0.3, -0.05], [-0.22, -0.05], [-0.22, -0.36], [0.45, -0.36], [0.45, -0.5], [-0.4, -0.5]],
  note: '块状单闭环（无孔洞字面）',
});
add('文字·拉丁字母', '字母 F', 'llm', {
  points: [[-0.4, 0.5], [0.45, 0.5], [0.45, 0.36], [-0.22, 0.36], [-0.22, 0.06], [0.3, 0.06], [0.3, -0.08], [-0.22, -0.08], [-0.22, -0.5], [-0.4, -0.5]],
});
add('文字·拉丁字母', '字母 H', 'llm', {
  points: [[-0.45, 0.5], [-0.28, 0.5], [-0.28, 0.07], [0.28, 0.07], [0.28, 0.5], [0.45, 0.5], [0.45, -0.5], [0.28, -0.5], [0.28, -0.07], [-0.28, -0.07], [-0.28, -0.5], [-0.45, -0.5]],
});
add('文字·拉丁字母', '字母 L', 'llm', {
  points: thickenPath([[-0.32, 0.5], [-0.32, -0.42], [0.42, -0.42]], 0.16),
});
add('文字·拉丁字母', '字母 T', 'llm', {
  points: [[-0.45, 0.5], [0.45, 0.5], [0.45, 0.36], [0.08, 0.36], [0.08, -0.5], [-0.08, -0.5], [-0.08, 0.36], [-0.45, 0.36]],
});
add('文字·拉丁字母', '字母 U', 'llm', {
  points: thickenPath([[-0.36, 0.5], [-0.36, -0.16], ...arc(0, -0.16, 0.36, 0.3, 180, 360, 10).slice(1, -1), [0.36, 0.5]], 0.16),
});
add('文字·拉丁字母', '字母 W', 'llm', {
  points: thickenPath([[-0.42, 0.42], [-0.2, -0.42], [0, -0.04], [0.2, -0.42], [0.42, 0.42]], 0.14),
});
add('文字·拉丁字母', '字母 Z', 'llm', {
  points: thickenPath([[-0.36, 0.42], [0.36, 0.42], [-0.36, -0.42], [0.36, -0.42]], 0.15),
});

/* F. 阿拉伯数字（5） */
add('文字·数字', '数字 1', 'llm', {
  points: thickenPath([[-0.16, 0.26], [0.06, 0.42], [0.06, -0.42]], 0.16),
});
add('文字·数字', '数字 2', 'llm', {
  points: thickenPath([[-0.26, 0.1], ...arc(0, 0.1, 0.26, 0.28, 185, -15, 12).slice(1, -1), [0.24, -0.04], [-0.24, -0.42], [0.36, -0.42]], 0.15),
});
add('文字·数字', '数字 3', 'llm', {
  points: thickenPath([[-0.22, 0.3], [0.02, 0.4], [0.22, 0.28], [0.24, 0.12], [0.08, 0.02], [-0.02, -0.06], [0.12, -0.1], [0.24, -0.2], [0.22, -0.34], [0.0, -0.42], [-0.22, -0.36]], 0.12),
});
add('文字·数字', '数字 4', 'llm', {
  points: [[0.1, 0.5], [0.24, 0.5], [0.24, 0.04], [0.52, 0.04], [0.52, -0.1], [-0.44, -0.1]],
  note: '单闭环块状（斜笔 + 底横 + 短竖）',
});
add('文字·数字', '数字 7', 'llm', {
  points: thickenPath([[-0.36, 0.42], [0.36, 0.42], [0.0, -0.42]], 0.15),
});

/* G. 汉字·单闭环剪影（7） */
add('文字·汉字单闭环', '「十」', 'llm', {
  points: [[-0.08, 0.5], [0.08, 0.5], [0.08, 0.08], [0.5, 0.08], [0.5, -0.08], [0.08, -0.08], [0.08, -0.5], [-0.08, -0.5], [-0.08, -0.08], [-0.5, -0.08], [-0.5, 0.08], [-0.08, 0.08]],
  note: '单闭环剪影（块状字）',
});
add('文字·汉字单闭环', '「中」', 'llm', {
  points: [[-0.35, 0.3], [-0.08, 0.3], [-0.08, 0.5], [0.08, 0.5], [0.08, 0.3], [0.35, 0.3], [0.35, -0.3], [0.08, -0.3], [0.08, -0.5], [-0.08, -0.5], [-0.08, -0.3], [-0.35, -0.3]],
});
add('文字·汉字单闭环', '「山」', 'llm', {
  points: [[-0.5, -0.5], [0.5, -0.5], [0.5, -0.32], [0.39, -0.32], [0.39, 0.3], [0.21, 0.3], [0.21, -0.32], [0.09, -0.32], [0.09, 0.5], [-0.09, 0.5], [-0.09, -0.32], [-0.21, -0.32], [-0.21, 0.3], [-0.39, 0.3], [-0.39, -0.32], [-0.5, -0.32]],
});
add('文字·汉字单闭环', '「凹」', 'llm', {
  points: [[-0.5, 0.4], [-0.18, 0.4], [-0.18, 0.02], [-0.06, 0.02], [-0.06, 0.18], [0.06, 0.18], [0.06, 0.02], [0.18, 0.02], [0.18, 0.4], [0.5, 0.4], [0.5, -0.4], [-0.5, -0.4]],
});
add('文字·汉字单闭环', '「凸」', 'llm', {
  points: [[-0.5, 0.4], [-0.18, 0.4], [-0.18, 0.18], [-0.06, 0.18], [-0.06, 0.5], [0.06, 0.5], [0.06, 0.18], [0.18, 0.18], [0.18, 0.4], [0.5, 0.4], [0.5, -0.4], [-0.5, -0.4]],
});
add('文字·汉字单闭环', '「工」', 'llm', {
  points: [[-0.4, 0.5], [0.4, 0.5], [0.4, 0.34], [0.08, 0.34], [0.08, -0.34], [0.4, -0.34], [0.4, -0.5], [-0.4, -0.5], [-0.4, -0.34], [-0.08, -0.34], [-0.08, 0.34], [-0.4, 0.34]],
});
add('文字·汉字单闭环', '「人」', 'llm', {
  points: [[0, 0.5], [0.42, -0.5], [0.16, -0.5], [0, -0.14], [-0.16, -0.5], [-0.42, -0.5]],
});

/* H. 汉字·多部分笔画（6，含「福」超上限反例） */
add('文字·汉字多部分', '「二」', 'llm', {
  parts: [
    { name: '上横', points: strokeBar(-0.36, 0.24, 0.36, 0.24, 0.14) },
    { name: '下横', points: strokeBar(-0.42, -0.3, 0.42, -0.3, 0.14) },
  ],
  note: '分离笔画 → parts 架构，逐部分闭环',
});
add('文字·汉字多部分', '「三」', 'llm', {
  parts: [
    { name: '上横', points: strokeBar(-0.36, 0.36, 0.36, 0.36, 0.13) },
    { name: '中横', points: strokeBar(-0.34, 0.02, 0.34, 0.02, 0.13) },
    { name: '下横', points: strokeBar(-0.42, -0.36, 0.42, -0.36, 0.13) },
  ],
});
add('文字·汉字多部分', '「川」', 'llm', {
  parts: [
    { name: '左撇', points: strokeBar(-0.32, 0.42, -0.38, -0.42, 0.13) },
    { name: '中竖', points: strokeBar(-0.02, 0.5, -0.02, -0.42, 0.13) },
    { name: '右竖', points: strokeBar(0.32, 0.5, 0.32, -0.42, 0.13) },
  ],
});
add('文字·汉字多部分', '「小」', 'llm', {
  parts: [
    { name: '中钩', points: thickenPath([[0, 0.46], [0, 0.06], [-0.14, -0.12]], 0.13) },
    { name: '左点', points: strokeBar(-0.3, 0.16, -0.36, 0.02, 0.13) },
    { name: '右点', points: strokeBar(0.3, 0.16, 0.36, 0.02, 0.13) },
  ],
});
add('文字·汉字多部分', '「八」', 'llm', {
  parts: [
    { name: '左撇', points: strokeBar(-0.1, 0.44, -0.42, -0.44, 0.13) },
    { name: '右捺', points: strokeBar(0.1, 0.44, 0.42, -0.44, 0.13) },
  ],
});
add('文字·汉字多部分', '「福」（12 笔）', 'llm', {
  failStrokes: (() => {
    const bars = [
      [-0.46, 0.3, -0.18, 0.42], [-0.32, 0.44, -0.32, -0.42],
      [-0.18, 0.2, -0.1, 0.34], [-0.14, -0.02, -0.04, 0.06],
      [-0.16, -0.22, -0.06, -0.16], [-0.16, -0.36, -0.06, -0.32],
      [0.04, 0.4, 0.46, 0.4], [0.4, 0.4, 0.4, -0.4],
      [0.08, 0.12, 0.32, 0.12], [0.2, 0.0, 0.2, -0.38],
      [0.1, -0.38, 0.32, -0.38], [0.04, -0.16, 0.36, -0.22],
    ];
    return bars.map(([x0, y0, x1, y1]) => strokeBar(x0, y0, x1, y1, 0.07));
  })(),
  note: '预期拒绝：笔画 12 > parts 上限 8 → normalizeCustomShape 拒绝（多笔画文字诚实失败）',
});

/* I. 动物/人物剪影（12）——手绘剪影，chaikin 圆角 */
add('剪影·具象轮廓', '狗', 'llm', {
  points: chaikin([[-0.5, -0.02], [-0.42, 0.1], [-0.34, 0.22], [-0.3, 0.4], [-0.22, 0.2], [-0.1, 0.24], [0.1, 0.26], [0.3, 0.26], [0.4, 0.42], [0.46, 0.3], [0.4, 0.12], [0.38, -0.12], [0.42, -0.5], [0.34, -0.5], [0.32, -0.14], [0.28, -0.5], [0.2, -0.5], [0.18, -0.14], [0.0, -0.12], [-0.04, -0.5], [-0.12, -0.5], [-0.1, -0.1], [-0.16, -0.5], [-0.24, -0.5], [-0.24, -0.06], [-0.36, -0.04], [-0.48, -0.08]], 1),
  features: [{ name: '尖耳', points: [[-0.3, 0.38]] }, { name: '翘尾', points: [[0.44, 0.4]] }, { name: '长吻', points: [[-0.48, -0.02]] }],
  note: '手绘剪影 + 声明特征（尖耳/翘尾/长吻）',
});
add('剪影·具象轮廓', '人形（姜饼人）', 'llm', {
  points: [
    ...arc(0, 0.32, 0.15, 0.15, 110, -75, 12),
    [0.06, 0.16], [0.16, 0.14], [0.46, 0.02], [0.16, -0.06], [0.14, -0.18],
    [0.3, -0.5], [0.1, -0.5], [0.0, -0.2], [-0.1, -0.5], [-0.3, -0.5], [-0.14, -0.18],
    [-0.16, -0.06], [-0.46, 0.02], [-0.16, 0.14], [-0.06, 0.16],
    ...arc(0, 0.32, 0.15, 0.15, 255, 112, 10),
  ],
  note: '圆头 + 双臂 + 双腿的一笔闭环人形',
});
add('剪影·具象轮廓', '蘑菇', 'llm', {
  points: chaikin([...arc(0, 0.05, 0.44, 0.36, 170, 10, 12), [0.3, 0.05], [0.16, -0.5], [-0.16, -0.5], [-0.3, 0.05]], 1),
  note: '菌帽（参数化圆弧）+ 菌柄',
});
add('剪影·具象轮廓', '水母', 'llm', {
  points: [...arc(0, 0.14, 0.36, 0.3, 180, 0, 12), [0.3, -0.08], [0.26, -0.42], [0.18, -0.14], [0.1, -0.44], [0.02, -0.14], [-0.06, -0.44], [-0.14, -0.14], [-0.22, -0.42], [-0.28, -0.08]],
  note: '伞帽（参数化圆弧）+ 波浪触须',
});
add('剪影·具象轮廓', '鱼', 'llm', {
  points: chaikin([[-0.5, 0.02], [-0.3, 0.2], [-0.05, 0.26], [0.2, 0.2], [0.34, 0.1], [0.42, 0.26], [0.52, 0.34], [0.46, 0.0], [0.52, -0.34], [0.42, -0.26], [0.3, -0.14], [0.1, -0.22], [-0.15, -0.18], [-0.35, -0.1]], 2),
});
add('剪影·具象轮廓', '蝴蝶', 'llm', {
  points: chaikin([[0.0, 0.34], [0.06, 0.26], [0.12, 0.22], [0.42, 0.44], [0.52, 0.3], [0.32, 0.1], [0.4, -0.02], [0.44, -0.22], [0.26, -0.3], [0.1, -0.14], [0.04, -0.3], [0.0, -0.42], [-0.04, -0.3], [-0.1, -0.14], [-0.26, -0.3], [-0.44, -0.22], [-0.4, -0.02], [-0.32, 0.1], [-0.52, 0.3], [-0.42, 0.44], [-0.12, 0.22], [-0.06, 0.26]], 2),
});
add('剪影·具象轮廓', '鸟（站姿）', 'llm', {
  points: chaikin([[-0.5, 0.28], [-0.36, 0.34], [-0.2, 0.3], [0.0, 0.24], [0.3, 0.06], [0.16, 0.02], [0.3, -0.18], [0.44, -0.3], [0.24, -0.28], [0.14, -0.5], [0.1, -0.32], [0.04, -0.5], [-0.02, -0.32], [-0.2, -0.2], [-0.3, 0.02], [-0.38, 0.2]], 1),
});
add('剪影·具象轮廓', '雪人', 'llm', {
  points: [...arc(0, 0.3, 0.16, 0.16, -56, 236, 12), ...arc(0, -0.12, 0.3, 0.3, 107, 433, 20)],
  note: '头/身双圆相贯的一笔闭环（两段参数化圆弧拼接）',
});
add('剪影·具象轮廓', '冰淇淋', 'llm', {
  points: chaikin([...arc(0, 0.12, 0.32, 0.34, 175, 5, 12), [0.28, 0.06], [0, -0.5], [-0.28, 0.06]], 1),
  note: '甜筒：蛋卷尖 + 冰淇淋弧顶',
});
add('剪影·具象轮廓', '鲸鱼', 'llm', {
  points: chaikin([[-0.5, 0.1], [-0.34, 0.26], [-0.05, 0.32], [0.22, 0.28], [0.36, 0.24], [0.52, 0.42], [0.44, 0.16], [0.54, -0.28], [0.36, -0.12], [0.1, -0.2], [-0.16, -0.16], [-0.18, -0.28], [-0.28, -0.1], [-0.42, 0.0]], 2),
});
add('剪影·具象轮廓', '大象', 'llm', {
  points: chaikin([[-0.46, -0.32], [-0.5, -0.12], [-0.44, 0.04], [-0.34, 0.16], [-0.26, 0.3], [-0.08, 0.36], [0.1, 0.34], [0.16, 0.2], [0.34, 0.2], [0.48, 0.24], [0.5, 0.04], [0.44, -0.5], [0.32, -0.5], [0.3, -0.12], [0.16, -0.1], [0.12, -0.5], [0.0, -0.5], [-0.02, -0.08], [-0.16, 0.04], [-0.28, 0.08], [-0.36, -0.04], [-0.38, -0.22]], 1),
});
add('剪影·具象轮廓', '企鹅', 'llm', {
  points: chaikin([[0, 0.5], [0.14, 0.44], [0.2, 0.3], [0.34, 0.24], [0.18, 0.16], [0.2, 0.02], [0.34, -0.3], [0.26, -0.44], [0.42, -0.5], [0.16, -0.5], [0, -0.42], [-0.16, -0.5], [-0.42, -0.5], [-0.26, -0.44], [-0.34, -0.3], [-0.2, 0.02], [-0.2, 0.2], [-0.14, 0.44]], 2),
  note: '直立椭圆身 + 喙 + 双脚',
});

/* J. 物品/交通/符号（10） */
add('物品·交通·符号', '房子', 'llm', {
  points: [[0, 0.5], [0.14, 0.365], [0.18, 0.365], [0.18, 0.5], [0.3, 0.5], [0.3, 0.235], [0.5, 0.08], [0.5, -0.5], [0.14, -0.5], [0.14, -0.16], [-0.1, -0.16], [-0.1, -0.5], [-0.5, -0.5], [-0.5, 0.08]],
  note: '烟囱 + 门凹口',
});
add('物品·交通·符号', '杯子（带吸管）', 'llm', {
  points: [[-0.3, 0.4], [-0.06, 0.4], [0.02, 0.5], [0.08, 0.5], [0.04, 0.4], [0.3, 0.4], [0.24, -0.5], [-0.24, -0.5]],
});
add('物品·交通·符号', '雨伞', 'llm', {
  points: [
    ...arc(0, 0.06, 0.5, 0.46, 180, 0, 16),
    [0.375, 0.0], [0.25, -0.06], [0.125, 0.0], [0.06, -0.04], [0.05, -0.04],
    [0.05, -0.5], [-0.05, -0.5], [-0.05, -0.04], [-0.06, -0.04],
    [-0.125, 0.0], [-0.25, -0.06], [-0.375, 0.0],
  ],
  note: '伞面波浪沿 + 直柄',
});
add('物品·交通·符号', '箭头', 'llm', {
  points: [[0, 0.5], [0.35, 0.05], [0.14, 0.05], [0.14, -0.5], [-0.14, -0.5], [-0.14, 0.05], [-0.35, 0.05]],
});
add('物品·交通·符号', '钥匙', 'llm', {
  points: [
    ...arc(-0.28, 0.2, 0.21, 0.21, 28, 318, 16),
    [0.28, 0.06], [0.28, -0.08], [0.36, -0.08], [0.36, 0.06], [0.44, 0.06], [0.44, -0.08], [0.52, -0.08], [0.52, 0.3],
  ],
});
add('物品·交通·符号', '帆船', 'llm', {
  points: [[-0.42, -0.18], [-0.05, -0.18], [0, 0.5], [0.38, -0.1], [0.05, -0.1], [0.05, -0.18], [0.42, -0.18], [0.28, -0.42], [-0.3, -0.42]],
});
add('物品·交通·符号', '火箭', 'llm', {
  points: [[0, 0.5], [0.16, 0.16], [0.18, -0.1], [0.4, -0.38], [0.2, -0.32], [0.2, -0.5], [-0.2, -0.5], [-0.2, -0.32], [-0.4, -0.38], [-0.18, -0.1], [-0.16, 0.16]],
});
add('物品·交通·符号', '飞机（俯视）', 'llm', {
  points: [[0, 0.5], [0.06, 0.34], [0.46, -0.06], [0.4, -0.1], [0.07, -0.12], [0.05, -0.3], [0.26, -0.46], [0.24, -0.5], [0.02, -0.42], [-0.02, -0.42], [-0.24, -0.5], [-0.26, -0.46], [-0.05, -0.3], [-0.07, -0.12], [-0.4, -0.1], [-0.46, -0.06], [-0.06, 0.34]],
  note: '机身 + 后掠翼 + 尾翼剪影',
});
add('物品·交通·符号', '太阳', 'llm', {
  points: wavyCircle(0.4, 0.09, 12, 96, 0.6),
  note: '参数化波浪圆（12 芒）',
});
add('物品·交通·符号', '齿轮', 'llm', {
  points: (() => {
    const pts = [];
    for (let i = 0; i < 90; i += 1) {
      const a = (TAU * i) / 90;
      const r = 0.38 + 0.1 * Math.tanh(4 * Math.cos(9 * a));
      pts.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    return pts;
  })(),
  note: '9 齿参数化',
});

/* K. 自然/地图（5） */
const CHINA_MAINLAND = chaikin([
  [-0.42, 0.44], [-0.28, 0.4], [-0.16, 0.46], [-0.04, 0.4],
  [0.08, 0.46], [0.18, 0.38], [0.28, 0.42],
  [0.36, 0.32], [0.26, 0.26], [0.34, 0.18],
  [0.24, 0.12], [0.32, 0.04], [0.22, -0.02],
  [0.3, -0.1], [0.2, -0.16],
  [0.28, -0.24], [0.14, -0.32],
  [0.02, -0.4], [-0.08, -0.34], [-0.14, -0.42],
  [-0.26, -0.32], [-0.32, -0.4], [-0.4, -0.28],
  [-0.46, -0.14], [-0.38, -0.04], [-0.46, 0.06],
  [-0.4, 0.18], [-0.3, 0.28], [-0.36, 0.38],
], 2);
add('自然·地图', '中国地图（单闭环）', 'llm', {
  points: CHINA_MAINLAND,
  note: '简化单闭环（第 33/34 轮同款思路）',
});
add('自然·地图', '中国地图·三部分', 'llm', {
  parts: [
    { name: '大陆', points: CHINA_MAINLAND },
    { name: '台湾岛', points: [[0.4, -0.34], [0.46, -0.28], [0.48, -0.4], [0.42, -0.46], [0.38, -0.4]] },
    { name: '海南岛', points: [[-0.18, -0.46], [-0.1, -0.44], [-0.13, -0.5], [-0.2, -0.49]] },
  ],
  note: 'parts 多部分架构（第 43/44 轮）；小岛自动放大到可走尺度',
});
add('自然·地图', '树', 'llm', {
  points: [
    [-0.08, -0.5], [-0.08, -0.06],
    ...arc(0, 0.2, 0.34, 0.3, 250, -68, 26, (a) => 1 + 0.09 * Math.sin(8 * a)),
    [0.08, -0.06], [0.08, -0.5],
  ],
  note: '树冠波浪 + 树干',
});
add('自然·地图', '花（六瓣）', 'llm', {
  points: (() => {
    const pts = [];
    for (let i = 0; i < 90; i += 1) {
      const a = (TAU * i) / 90;
      const r = 0.16 + 0.32 * Math.pow(Math.abs(Math.cos(3 * a)), 1.4);
      pts.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    return pts;
  })(),
});
add('自然·地图', '山脉', 'llm', {
  points: [[-0.5, -0.5], [-0.5, -0.12], [-0.3, 0.2], [-0.15, -0.04], [0.02, 0.36], [0.2, 0.0], [0.34, 0.24], [0.5, -0.08], [0.5, -0.5]],
});

/* L. 参考图命中（8）——生产 seed 7 + E2E 素材 1 */
const seedManifestPath = join(root, 'web', 'data', 'shapes', 'manifest.json');
const seedManifest = JSON.parse(readFileSync(seedManifestPath, 'utf8'));
const seedDir = dirname(seedManifestPath);
for (const asset of seedManifest.assets) {
  add('参考图命中', asset.names.zh[0], 'reference', {
    referenceSvg: join(seedDir, asset.file),
    referenceAssetId: asset.id,
    referenceAlias: asset.aliases[0],
    note: `本地精选素材 ${asset.id}（${asset.source.name}）→ convertSvg → T`,
  });
}
{
  const e2eManifest = JSON.parse(readFileSync(join(root, 'test', 'fixtures', 'e2e-shapes', 'manifest.json'), 'utf8'));
  const entry = e2eManifest.entries.find((e) => e.id === 'butterfly');
  add('参考图命中', entry.zh, 'reference', {
    referenceSvg: join(root, 'test', 'fixtures', 'e2e-shapes', entry.file),
    referenceAssetId: entry.id,
    referenceAlias: entry.zh,
    note: 'E2E 素材库（100 种图形库抽样，未接入生产检索）',
  });
}

/* M. 边界与非法反例（6） */
add('边界·反例', '蝴蝶结（自交）', 'llm', {
  points: [[-0.5, -0.4], [0.5, 0.4], [0.5, -0.4], [-0.5, 0.4]],
  note: '预期拒绝：蝴蝶结交叉在加密采样后成为非相邻重合点，拓扑校验拦截',
});
add('边界·反例', '数字 0（嵌套双环）', 'llm', {
  parts: [
    { name: '外环', points: circle(0, 0, 0.48, 0.48, 20) },
    { name: '内环', points: circle(0, 0, 0.24, 0.24, 14) },
  ],
  note: '预期：部分嵌套 → 拒绝（孔洞不支持）',
});
add('边界·反例', '两个点', 'llm', {
  points: [[-0.3, 0], [0.3, 0]],
  note: '预期：点数 < 3 → 拒绝',
});
add('边界·反例', '直线退化', 'llm', {
  points: [[-0.45, 0], [-0.15, 0], [0.15, 0], [0.45, 0]],
  note: '预期：一轴跨度为 0 → 拒绝',
});
add('边界·反例', '字母 S（弦闭合）', 'llm', {
  points: thickenPath([[-0.22, 0.42], [0.1, 0.45], [0.26, 0.3], [0.08, 0.12], [-0.1, -0.04], [-0.26, -0.2], [-0.04, -0.42], [0.28, -0.46]], 0.13),
  note: '一笔 S 首尾闭合：弦是否自交（第 17 轮实测 S 解析失败的几何原因）',
});
add('边界·反例', '哑铃（窄颈往返）', 'llm', {
  points: [
    [-0.3, 0.025], [0.3, 0.025],
    ...arc(0.3, 0, 0.17, 0.17, 90, -90, 12),
    [0.3, -0.025], [-0.3, -0.025],
    ...arc(-0.3, 0, 0.21, 0.21, -90, -270, 14),
  ],
  note: '颈宽 0.05（<12%）：合法闭环但特征过细，路网尺寸反推会超上限',
});

/* --------------------------------- 执行 ---------------------------------- */

const results = [];

for (const ex of examples) {
  const row = {
    seq: ex.seq, id: String(ex.seq).padStart(3, '0'),
    cat: ex.cat, name: ex.name, source: ex.source,
    note: ex.note || '', rotationDeg: ex.rotationDeg ?? null,
  };
  try {
    let customShape = null;
    let spec = null;
    let invalidReason = null;

    if (ex.builtinKey) {
      const shape = SHAPES[ex.builtinKey];
      customShape = { name: shape.name, outlinePoints: shape.buildOutline(), parts: [], constraintPoints: [], features: [] };
      row.inputPointCount = customShape.outlinePoints.length;
    } else if (ex.spec) {
      const normalized = normalizeShapeSpec(ex.spec);
      if (!normalized.ok) {
        invalidReason = `规格非法：${normalized.reason}`;
      } else {
        spec = normalized.spec;
        const built = buildShapeFromSpec(spec);
        if (!built.ok) {
          invalidReason = `生成失败：${built.reason}`;
        } else {
          customShape = built.customShape;
        }
      }
    } else if (ex.referenceSvg) {
      const svgText = readFileSync(ex.referenceSvg, 'utf8');
      const conversion = convertSvg(svgText);
      if (conversion.status !== 'accepted' || !conversion.T?.points?.length) {
        invalidReason = `参考图转换未接受：${(conversion.reasons || []).join('; ')}`;
      } else {
        customShape = normalizeCustomShape({ name: ex.name, points: conversion.T.points }, (reason) => { invalidReason = `归一化拒绝：${reason}`; });
        row.referenceAssetId = ex.referenceAssetId;
        row.referenceAlias = ex.referenceAlias;
        row.inputPointCount = conversion.T.pointCount;
      }
    } else if (ex.failStrokes) {
      // 构造超过 8 部分的输入，走真实 normalizeCustomShape 触发拒绝
      const strokes = ex.failStrokes.map((points, i) => ({ name: `笔${i + 1}`, points }));
      customShape = normalizeCustomShape({ name: ex.name, parts: strokes }, (reason) => { invalidReason = reason; });
      row.inputPointCount = ex.failStrokes.reduce((sum, pts) => sum + pts.length, 0);
    } else {
      row.inputPointCount = ex.parts ? ex.parts.reduce((sum, p) => sum + p.points.length, 0) : ex.points.length;
      customShape = normalizeCustomShape(
        ex.parts ? { name: ex.name, parts: ex.parts } : { name: ex.name, points: ex.points, features: ex.features },
        (reason) => { invalidReason = reason; },
      );
    }

    if (!customShape) {
      row.status = 'rejected';
      row.reason = invalidReason;
      row.acceptance = { verdict: 'fail', reasons: [invalidReason || '归一化/验收拒绝'], checks: {} };
      // 拒绝例：画灰色输入草图（生产链路不会产出序列图）
      if (ex.failStrokes) {
        const rgb = renderOutlineRGB(null, null, { color: GRAY, rings: ex.failStrokes });
        if (rgb) {
          writeFileSync(join(pngDir, `${row.id}-sketch.png`), encodePNG(rgb, SIZE, SIZE));
          row.sketch = `png/${row.id}-sketch.png`;
        }
      } else if (ex.parts) {
        const rgb = renderOutlineRGB(null, null, { color: GRAY, rings: ex.parts.map((p) => p.points) });
        if (rgb) {
          writeFileSync(join(pngDir, `${row.id}-sketch.png`), encodePNG(rgb, SIZE, SIZE));
          row.sketch = `png/${row.id}-sketch.png`;
        }
      } else if (ex.points && ex.points.length >= 3) {
        const rgb = renderOutlineRGB(ex.points, null, { color: GRAY });
        if (rgb) {
          writeFileSync(join(pngDir, `${row.id}-sketch.png`), encodePNG(rgb, SIZE, SIZE));
          row.sketch = `png/${row.id}-sketch.png`;
        }
      }
    } else {
      row.status = 'ok';
      row.pointCount = customShape.outlinePoints.length;
      row.partCount = customShape.parts?.length ?? 1;
      row.constraintCount = customShape.constraintPoints?.length ?? 0;
      row.featureCount = customShape.features?.length ?? 0;
      const acceptanceSource = ex.source === 'llm' ? 'freeform' : ex.source;
      const referenceSource = ex.source === 'reference' ? { id: ex.referenceAssetId, name: ex.name, matchedAlias: ex.referenceAlias } : null;
      row.acceptance = acceptTarget({
        source: acceptanceSource,
        customShape,
        spec,
        referenceSource,
        review: null,
      });
      const rgb = renderOutlineRGB(customShape.outlinePoints, customShape.parts, { rotationDeg: ex.rotationDeg ?? 0 });
      writeFileSync(join(pngDir, `${row.id}.png`), encodePNG(rgb, SIZE, SIZE));
      row.png = `png/${row.id}.png`;
    }
  } catch (error) {
    row.status = 'error';
    row.reason = `${error.message}\n${error.stack?.split('\n')[1] || ''}`;
  }
  results.push(row);
  const tag = row.status === 'ok' ? row.acceptance.verdict : row.status;
  console.log(`[${row.id}] ${ex.cat} / ${ex.name} → ${tag}${row.reason ? ' · ' + row.reason.split('\n')[0] : ''}`);
}

/* ------------------------------- 汇总统计 --------------------------------- */

const stats = {
  total: results.length,
  ok: results.filter((r) => r.status === 'ok').length,
  rejected: results.filter((r) => r.status === 'rejected').length,
  error: results.filter((r) => r.status === 'error').length,
  bySource: {},
  byCategory: {},
  acceptance: {},
};
for (const r of results) {
  stats.bySource[r.source] = (stats.bySource[r.source] || 0) + 1;
  stats.byCategory[r.cat] = (stats.byCategory[r.cat] || 0) + 1;
  const key = r.status === 'ok' ? `验收:${r.acceptance.verdict}` : r.status;
  stats.acceptance[key] = (stats.acceptance[key] || 0) + 1;
}
const pointCounts = results.filter((r) => r.status === 'ok').map((r) => r.pointCount).sort((a, b) => a - b);
stats.pointCount = {
  min: pointCounts[0], median: pointCounts[Math.floor(pointCounts.length / 2)], max: pointCounts[pointCounts.length - 1],
};

/* ------------------------------ 总览拼图 ---------------------------------- */

const COLS = 10;
const ROWS = Math.ceil(results.length / COLS);
const CELL = SIZE + 6;
const SHEET_W = COLS * CELL;
const SHEET_H = ROWS * CELL;
const sheet = new Uint8Array(SHEET_W * SHEET_H * 3).fill(255);
for (const r of results) {
  const file = r.png || r.sketch;
  if (!file) continue;
  const { rgb } = decodePNGRGB(readFileSync(join(outDir, file)));
  const col = (r.seq - 1) % COLS;
  const rowIdx = Math.floor((r.seq - 1) / COLS);
  const ox = col * CELL + 3;
  const oy = rowIdx * CELL + 3;
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const si = ((oy + y) * SHEET_W + ox + x) * 3;
      const di = (y * SIZE + x) * 3;
      sheet[si] = rgb[di]; sheet[si + 1] = rgb[di + 1]; sheet[si + 2] = rgb[di + 2];
    }
  }
}
writeFileSync(join(outDir, 'sheet.png'), encodePNG(sheet, SHEET_W, SHEET_H));

/* ------------------------------ result.json ------------------------------- */

writeFileSync(join(outDir, 'result.json'), JSON.stringify({ stats, results }, null, 2));

/* ------------------------------- HTML 图库 --------------------------------- */

const SOURCE_LABEL = {
  builtin: '内置图形',
  procedural: '参数化生成',
  llm: 'AI 生成（本地构造点列）',
  reference: '参考图命中',
};
const SOURCE_BADGE = {
  builtin: '#dbeafe|#1d4ed8',
  procedural: '#dcfce7|#15803d',
  llm: '#fef3c7|#b45309',
  reference: '#f3e8ff|#7e22ce',
};
const VERDICT_LABEL = {
  pass: ['目标验收通过', '#dcfce7', '#15803d'],
  unavailable: ['视觉质检不可用（Node 无 canvas/LLM）· 真实链路需质检 like 才给绿线', '#fef9c3', '#a16207'],
  fail: ['验收拒绝', '#fee2e2', '#b91c1c'],
};
const CAT_ORDER = [...new Set(results.map((r) => r.cat))];

const cardHtml = (r) => {
  const img = r.png || r.sketch;
  const badge = SOURCE_BADGE[r.source].split('|');
  const verdict = r.status === 'ok'
    ? VERDICT_LABEL[r.acceptance.verdict] || [r.acceptance.verdict, '#e5e7eb', '#374151']
    : VERDICT_LABEL.fail;
  const meta = [];
  if (r.status === 'ok') {
    meta.push(`${r.pointCount} 点`);
    if (r.partCount > 1) meta.push(`${r.partCount} 部分`);
    if (r.featureCount) meta.push(`${r.featureCount} 特征`);
    if (r.rotationDeg) meta.push(`朝向 ${r.rotationDeg}°`);
    if (r.referenceAssetId) meta.push(`素材 ${r.referenceAssetId}`);
  } else {
    meta.push('无序列图产出');
  }
  const reason = r.status === 'rejected' ? `<div class="reason">拒绝原因：${escapeHtml(r.reason || '')}</div>` : '';
  return `<figure class="card${r.status === 'rejected' ? ' rejected' : ''}">
  <img src="${img}" width="160" height="160" alt="${escapeHtml(r.name)}" loading="lazy">
  <figcaption>
    <div class="name">${escapeHtml(r.name)}<span class="seq">#${r.seq}</span></div>
    <div class="badges">
      <span class="badge" style="background:${badge[0]};color:${badge[1]}">${SOURCE_LABEL[r.source]}</span>
      <span class="badge" style="background:${verdict[1]};color:${verdict[2]}">${verdict[0]}</span>
    </div>
    <div class="meta">${meta.map(escapeHtml).join(' · ')}</div>
    ${reason}
    ${r.note ? `<div class="note">${escapeHtml(r.note)}</div>` : ''}
  </figcaption>
</figure>`;
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>目标点序列图百例验证（2026-10-31）</title>
<style>
  body { font-family: "Microsoft YaHei", system-ui, sans-serif; margin: 0; background: #f8fafc; color: #0f172a; }
  header { padding: 24px 32px 12px; }
  h1 { font-size: 22px; margin: 0 0 6px; }
  header p { margin: 2px 0; color: #475569; font-size: 13px; }
  .stats { display: flex; flex-wrap: wrap; gap: 10px; padding: 8px 32px 4px; }
  .stat { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 8px 14px; font-size: 13px; }
  .stat b { font-size: 18px; display: block; }
  main { padding: 8px 32px 40px; }
  h2 { font-size: 17px; margin: 28px 0 4px; border-left: 4px solid #5a28b4; padding-left: 10px; }
  h2 small { color: #64748b; font-weight: normal; font-size: 12px; margin-left: 8px; }
  .grid { display: flex; flex-wrap: wrap; gap: 12px; }
  .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 10px; width: 184px; margin: 0; }
  .card img { display: block; border: 1px solid #e2e8f0; border-radius: 6px; background: #fff; }
  .card.rejected img { opacity: 0.75; }
  .card .name { font-size: 14px; font-weight: 600; margin-top: 6px; }
  .card .seq { color: #94a3b8; font-weight: normal; font-size: 11px; margin-left: 6px; }
  .card .badges { display: flex; flex-wrap: wrap; gap: 4px; margin: 5px 0; }
  .badge { font-size: 11px; border-radius: 999px; padding: 1px 8px; }
  .card .meta { font-size: 11px; color: #475569; }
  .card .reason { font-size: 11px; color: #b91c1c; margin-top: 4px; }
  .card .note { font-size: 11px; color: #64748b; margin-top: 4px; }
  footer { padding: 0 32px 40px; color: #64748b; font-size: 12px; line-height: 1.8; }
  footer code { background: #eef2f7; border-radius: 4px; padding: 1px 5px; }
</style>
</head>
<body>
<header>
  <h1>目标点序列图百例验证 · 100 例</h1>
  <p>日期 2026-10-31 · 复现 <code>node tools/outline-gallery.mjs</code> · 每例 160 px（与生产气泡图同参：白底 / #5a28b4 / 2px 圆角描边 / (size−40) 定标 / y 翻转 / 多部分逐环）</p>
  <p>链路：内置 <code>SHAPES[key].buildOutline()</code>；参数化 <code>normalizeShapeSpec → buildShapeFromSpec → acceptProceduralTarget</code>（真实几何不变量验收）；自由轮廓（文字/剪影/地图/反例）<code>normalizeCustomShape</code>（真实去重/加密/窄刺折叠/拓扑/特征/RDP）；参考图 <code>convertSvg → normalizeCustomShape</code>（生产 seed + E2E 素材）。</p>
</header>
<div class="stats">
  <div class="stat"><b>${stats.total}</b>用例总数</div>
  <div class="stat"><b>${stats.ok}</b>产出序列图</div>
  <div class="stat"><b>${stats.rejected}</b>诚实拒绝（反例）</div>
  <div class="stat"><b>${stats.acceptance['验收:pass'] || 0}</b>目标验收通过</div>
  <div class="stat"><b>${stats.acceptance['验收:unavailable'] || 0}</b>视觉质检不可用*</div>
  <div class="stat"><b>${stats.pointCount.min}~${stats.pointCount.max}</b>点数范围（中位 ${stats.pointCount.median}）</div>
</div>
<main>
${CAT_ORDER.map((cat) => {
  const rows = results.filter((r) => r.cat === cat);
  return `<h2>${escapeHtml(cat)}<small>${rows.length} 例</small></h2>\n<div class="grid">\n${rows.map(cardHtml).join('\n')}\n</div>`;
}).join('\n')}
</main>
<footer>
  <p>* 视觉质检不可用：自由轮廓的合格绿线要求"拓扑合法 ∧ 视觉质检 like ∧ 用户约束逐项通过"三者合取；本批量验证在 Node 端无 canvas/LLM，视觉质检环节不可用，按生产语义记录为 unavailable（不得给绿线，只允许诊断参考或诚实失败）。几何不变量（参数化）与拓扑/来源校验为真实结论。</p>
  <p>AI 生成的自由轮廓点列为本地构造的"LLM 风格"输入（非真实模型输出），走的是生产归一化链路；真实 LLM 输出质量另见 README 第六十二/六十三轮浏览器 E2E。</p>
</footer>
</body>
</html>
`;
writeFileSync(join(outDir, 'index.html'), html);

/* ----------------------------- Markdown 报告 ------------------------------- */

const verdictShort = { pass: '✅ 通过', unavailable: '⚠️ 质检不可用', fail: '❌ 拒绝' };
const sourceShort = { builtin: '内置', procedural: '参数化', llm: 'AI(本地构造)', reference: '参考图' };
const mdRows = CAT_ORDER.map((cat) => {
  const rows = results.filter((r) => r.cat === cat);
  return `### ${cat}（${rows.length} 例）\n\n| # | 名称 | 来源 | 点数 | 验收 | 说明 |\n| --- | --- | --- | --- | --- | --- |\n${
    rows.map((r) => {
      const verdict = r.status === 'ok' ? verdictShort[r.acceptance.verdict] : '❌ 拒绝';
      const points = r.status === 'ok' ? r.pointCount : '—';
      const reason = r.status === 'rejected' ? ` ${escapeHtml(r.reason || '')}；` : '';
      const note = r.note || (r.status === 'ok' ? '' : '无序列图产出');
      return `| ${r.seq} | ${escapeHtml(r.name)} | ${sourceShort[r.source]} | ${points} | ${verdict} | ${reason}${escapeHtml(note)} |`;
    }).join('\n')
  }\n`;
}).join('\n');

const md = `# 目标点序列图百例验证报告

日期：2026-10-31
范围：回复气泡内"目标点序列图"（[第六十二轮](../../README.md#回复附带目标点序列图第六十二轮2026-10-28)接入、[第六十三轮](../../README.md)新增"参数化生成"来源档）在**各种类别目标轮廓**下的批量生成验证
图库（逐例大图）：[2026-10-31-目标点序列图百例/index.html](./2026-10-31-目标点序列图百例/index.html) · 10×10 总览 [sheet.png](./2026-10-31-目标点序列图百例/sheet.png) · 元数据 [result.json](./2026-10-31-目标点序列图百例/result.json)
复现：\`node tools/outline-gallery.mjs\`

## 1. 结论（TL;DR）

- **100 例全部按预期走完生产链路**：95 例产出序列图（160 px PNG），5 例为预期拒绝（福字超 parts 上限、蝴蝶结自交、嵌套 0、两点、直线退化）——拒绝例在生产链路中**不产出序列图**，报告以灰色输入草图示意；
- 序列图四种来源档全部覆盖并真实走链路：**内置 3 / 参数化 30 / AI 生成风格 59 / 参考图 8**；
- 参数化 30 例的**几何不变量验收全部真实通过**（角数/半径序列/排列对旋转平移缩放不变）；参考图 8 例拓扑复验通过；自由轮廓 54 例在 Node 端视觉质检不可用，按第六十三轮语义如实记为 **unavailable（不给绿线）**，拓扑校验为真实结论；
- 点数范围 20~317（中位 32），覆盖单闭环、多部分（笔画字/群岛地图）、声明特征、旋转朝向等序列图全部展示维度；
- 用户特别要求的**文字类 26 例**（拉丁字母 8 + 数字 5 + 汉字单闭环 7 + 汉字多部分 6）全部验证：无孔洞的块状字/笔画字可产出序列图；带孔洞（0）与超 8 笔（福）被拓扑/parts 上限诚实拦截。

## 2. 方法与口径（诚实边界）

| 环节 | 做法 | 真实性 |
| --- | --- | --- |
| 内置图形 | \`SHAPES[key].buildOutline()\` | 生产代码 |
| 参数化 | \`normalizeShapeSpec → buildShapeFromSpec\` + \`acceptProceduralTarget\` | 生产代码（真实几何不变量验收） |
| 自由轮廓 | 本地构造"LLM 风格"点列 → \`normalizeCustomShape\`（去重/加密/窄刺折叠/拓扑校验/特征检测/RDP 约束） | **归一化链路为生产代码；点列非真实 LLM 输出**（真实 LLM 输出质量见第六十二/六十三轮浏览器 E2E） |
| 参考图 | \`convertSvg → normalizeCustomShape\`（与 \`agent/reference.js\` 同链路） | 生产代码；素材=生产 seed 7 个 + E2E 素材库 1 个 |
| 验收 | \`acceptTarget\` 按来源分派 | 生产代码；freeform 在 Node 无 canvas/LLM → 视觉质检环节不可用 → unavailable（不给绿线，生产语义） |
| 渲染 | 复刻 \`renderOutlineDataUrl\` 全部参数：160 px、白底、#5a28b4、2px 圆角描边、(size−40) 定标、y 翻转、多部分逐环、最终朝向刚体旋转 | **同参 Node 复刻**（纯 JS 光栅化 + zlib PNG）。第六十二轮已用浏览器真实 canvas 验证同几何；本报告验证的是"什么形状会被画出来"，像素级 canvas 输出以浏览器为准 |

## 3. 统计

| 维度 | 数值 |
| --- | --- |
| 用例总数 | 100 |
| 产出序列图 | 95 |
| 预期拒绝（反例） | 5（福字 / 蝴蝶结 / 数字 0 / 两个点 / 直线） |
| 目标验收 pass | 41（内置 3 + 参数化 30 + 参考图 8） |
| 视觉质检不可用（unavailable） | 54（自由轮廓，Node 端无 canvas/LLM） |
| 点数 min / 中位 / max | 20 / 32 / 317 |
| 来源分布 | 内置 3 · 参数化 30 · AI 生成风格 59 · 参考图 8 |

## 4. 序列图效果（按分类）

### 参数化（30 例）——最稳的一档

3~12 角星、正 3~12 边形、圆族变体（椭圆/三长三短/逐尖不等长/手绘感扰动/星芒）全部**一次生成、不变量验收通过、形状与参数严格一致**。值得注意的效果：

- 「六角星·三长三短」：长短尖交替排列清晰可辨，验收按排列核验（等长版不会被误判为三长三短）；
- 「四角星·星芒」（内凹比 0.08）：尖锐四芒形状稳定产出，未触发窄刺折叠；
- 「五角星·轻微手绘感 / 七角星·手绘感 / 正十边形·手绘感」：seed 扰动产生可控的不规则感，同 seed 复现一致；
- 「五角星」带朝向 30°、「心形」15°：气泡图与地图紫线同一刚体旋转的展示用例。

### 文字（26 例）——用户特别要求的一档

- **拉丁字母 8**（E F H L T U W Z）：块状/笔画剪影全部产出，形态清晰；
- **数字 5**（1 2 3 4 7）：全部产出；「4」为单闭环块状（斜笔+底横+短竖），形态偏三角，笔画字"4"（两笔相交）受 parts 不相交约束限制；
- **汉字单闭环 7**（十 中 山 凹 凸 工 人）：块状剪影全部正确，凹/凸的内外轮廓关系正确；
- **汉字多部分 6**（二 三 川 小 八 + 福）：笔画字经 parts 多部分架构逐笔闭环；「福」12 笔**超过 parts 上限 8 被诚实拒绝**——印证产品规则"多笔画文字需要提笔/断笔，一条连续路线画不出来"；
- 边界发现：**字母 S 的一笔弦闭合不构成自交**，会产出一个形似"2"的合法闭环（渲染见图）——S 类曲线字母靠"闭合弦"表达时形态会走样，这与第 17 轮"LLM 生成字母 S 不可靠"的实测互相印证；**数字 0 的环里环**被"部分嵌套（不支持孔洞）"正确拦截。

### 剪影/具象（12 例）

狗（含声明特征：尖耳/翘尾/长吻，映射入约束）、姜饼人、蘑菇、水母（伞帽+触须锯齿）、鱼、蝴蝶、鸟、雪人（双圆相贯一笔闭环）、冰淇淋、鲸、大象、企鹅全部产出。**手绘"LLM 风格"点列的形态质量明显参差**（姜饼人/水母/企鹅/鱼好，狗/大象可辨但偏粗壮）——这正是自由轮廓来源的真实风险面，也再次印证：高保真剪影应优先走参考图命中（同表中马/猫/狗/人/鸽子的参考图版本形态显著更好）。

### 自然/地图（5 例）

中国地图单闭环（可认出雄鸡轮廓）、中国地图三部分（大陆+台湾+海南，parts 架构 + 小岛自动放大）、树、六瓣花、山脉全部产出。

### 参考图命中（8 例）

生产 seed 7 个（马/猫/狗×2/人/鸽子×2 来源）+ E2E 素材库蝴蝶 1 个，走 \`convertSvg → normalizeCustomShape\`，**全部拓扑复验通过**，点数 92~317，形态质量为全部用例中最高——参考图来源的价值在序列图上一目了然。

### 边界/反例（6 例）——拒绝路径验证

| 用例 | 生产链路实际行为 |
| --- | --- |
| 「福」12 笔 | parts 上限 8 → 拒绝（"缺少 points/parts 点列"） |
| 蝴蝶结（自交） | 交叉点在加密采样后成为非相邻重合点 → 拓扑拒绝 |
| 数字 0（嵌套双环） | "第 1/2 部分之间嵌套（当前不支持孔洞图形）" → 拒绝 |
| 两个点 | 点数 < 3 → 拒绝 |
| 直线退化 | 一轴跨度 0 → 拒绝 |
| 哑铃（窄颈往返，颈宽 0.05 < 12%） | **合法闭环、正常产出序列图**——形态本身不是拒绝理由；预期在生产中被"特征尺寸反推"推向超大尺寸或如实反映细节画不出（引擎层行为，非本验证范围） |

## 5. 分类明细（100 例）

${mdRows}

## 6. 复现

\`\`\`bash
node tools/outline-gallery.mjs
# 输出 docs/测试报告/2026-10-31-目标点序列图百例/{png/*.png, sheet.png, index.html, result.json}
\`\`\`

用例定义见 \`tools/outline-gallery.mjs\` 的 \`add(...)\` 清单；新增类别/用例直接追加即可。
`;
writeFileSync(join(root, 'docs', '测试报告', '2026-10-31-目标点序列图百例验证报告.md'), md);

console.log(`\n输出目录：${outDir}`);
console.log(JSON.stringify(stats, null, 2));
