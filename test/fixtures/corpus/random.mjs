/**
 * 语料生成的确定性伪随机工具。
 *
 * 语料必须可复现：同一份代码、同一 seed 必须逐点产出同一条轮廓与同一批样本，
 * 因此这里只使用自带的确定性伪随机数发生器（mulberry32）与 FNV-1a 字符串哈希，
 * 不使用 Math.random，也不依赖系统时间。
 */

/**
 * FNV-1a 32 位字符串哈希：用于样本排序、分层分配与 seed 派生。
 *
 * @param {string} text 参与哈希的字符串
 * @returns {number} 32 位无符号整数
 */
export function hashString(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * mulberry32 伪随机数发生器：同一 seed 必然产生同一序列。
 *
 * @param {number} seed 32 位种子
 * @returns {() => number} 返回 [0,1) 区间的伪随机数
 */
export function createRandom(seed) {
  let state = (seed >>> 0) || 1;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 由主种子与路径派生一个子种子（确定性、可追溯）。
 *
 * @param {number} masterSeed 主种子
 * @param {...string} parts 路径片段
 * @returns {number} 32 位子种子
 */
export function deriveSeed(masterSeed, ...parts) {
  return hashString(`${masterSeed >>> 0}|${parts.join('/')}`);
}
