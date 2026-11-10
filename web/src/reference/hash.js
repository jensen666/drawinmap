/**
 * 候选 contentHash（方案 2026-10-31 §7.2）。
 *
 * 三类哈希分工（不得互相替代）：
 * - 文件 asset.sha256 / sourceSha256：素材文件身份（sha256File 同口径：CRLF/CR → LF 后哈希）；
 * - review.sha256：人工审核绑定的素材版本；
 * - contentHash：素材哈希 + 转换配置/版本 + 归一化版本 + 实际 customShape 的规范化
 *   序列化——转换或归一化算法变化后旧候选不能串用。
 *
 * 浏览器与 Node 共用：SHA-256 用纯 JS 实现（不依赖 node:crypto / crypto.subtle，
 * 非 https 的局域网部署没有 subtle，纯 JS 同步实现也便于候选选择时同步校验）。
 */

/** convertSvg 行为版本：CONVERSION_DEFAULTS 或转换算法的行为变化时递增 */
export const CONVERTER_VERSION = 1;

/** normalizeCustomShape 行为版本：归一化算法/默认参数变化时递增 */
export const NORMALIZER_VERSION = 1;

/** contentHash 载荷 schema（结构变化时递增） */
export const REFERENCE_CANDIDATE_SCHEMA = "reference-candidate-v1";

/** SHA-256 轮常量 */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (value, bits) => ((value >>> bits) | (value << (32 - bits))) >>> 0;

/**
 * SHA-256（UTF-8 文本 → 64 位十六进制小写）。纯 JS、同步、Node/浏览器通用。
 *
 * @param {string} text 输入文本
 * @returns {string} 十六进制摘要
 */
export function sha256Hex(text) {
  const bytes = new TextEncoder().encode(String(text));
  const length = bytes.length;
  const padded = new Uint8Array((((length + 8) >> 6) + 1) << 6);
  padded.set(bytes);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, length >>> 29);
  view.setUint32(padded.length - 4, (length << 3) >>> 0);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const w = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(offset + i * 4);
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((part) => part.toString(16).padStart(8, "0")).join("");
}

/** 与 sha256File 同一口径的换行归一化（CRLF/CR → LF） */
export function normalizeLineBreaks(text) {
  return String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** 文本哈希（换行归一化后 SHA-256）——素材文件身份在浏览器端的同口径计算 */
export function sha256NormalizedText(text) {
  return sha256Hex(normalizeLineBreaks(text));
}

/**
 * 规范化 JSON 序列化（方案 §7.2）：递归排序对象键，数组保持原顺序，
 * 数字使用实际序列化值；undefined 字段跳过（对象内）或落为 null（数组内）。
 *
 * @param {*} value 任意可 JSON 序列化的值
 * @returns {string} 键序确定的 JSON 文本
 */
export function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item) ?? "null").join(",")}]`;
  }
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key]) ?? "null"}`).join(",")}}`;
}

/**
 * 候选 contentHash（方案 §7.2 公式，浏览器在完成 normalizeCustomShape 后计算）：
 * SHA-256(stableStringify({ schema, sourceSha256, converterVersion, conversionOptions,
 * normalizerVersion, customShape }))
 *
 * @param {object} options
 * @param {string|null} options.sourceSha256 素材文件哈希
 * @param {object} [options.conversionOptions] convertSvg 覆盖项（缺省 {} = 默认配置）
 * @param {object} options.customShape 归一化后的实际 customShape（规划输入）
 * @returns {string} 十六进制摘要
 */
export function computeReferenceContentHash({ sourceSha256, conversionOptions = {}, customShape }) {
  return sha256Hex(
    stableStringify({
      schema: REFERENCE_CANDIDATE_SCHEMA,
      sourceSha256: sourceSha256 ?? null,
      converterVersion: CONVERTER_VERSION,
      conversionOptions: conversionOptions ?? {},
      normalizerVersion: NORMALIZER_VERSION,
      customShape,
    }),
  );
}
