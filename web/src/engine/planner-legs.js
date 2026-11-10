/**
 * 步行序列与走廊上限（清理方案 2026-11-09 C3：从 planner.js 纯移动拆出，行为零变化）。
 *
 * 职责：identity 浅凹段的走廊上限解析、按约束顺序构建步行段序列
 * （单部分闭环 / 多部分"主体 + 岛 excursion"）、部分内轮廓切片。
 * 寻路本身与指标计算仍由 planner.js / planner-result.js 负责。
 */

import { distanceMeters } from './graph.js';

/**
 * identity 浅凹所在段的走廊上限（方案 5.3）：高密有机轮廓的浅凹（人形后背/
 * 手臂分界）深度换算成米后通常远小于默认走廊上限 240m——走廊过宽时 A* 会
 * 贴外侧直路滑过浅凹。凹底所在形状腿的走廊上限收紧为 min(240m, 凹深米数)，
 * 下限仍 60m；2.5 倍放宽与纯最短路回退不变（偏差由有序指标如实呈现）。
 *
 * @param {object} options
 * @param {object|null} options.customShape 自定义图形（取 identity features）
 * @param {object} options.model 图形模型（含 partRanges）
 * @param {number} options.sizeMeters 图形外接尺寸（米）
 * @returns {(fromIndex: number, toIndex: number) => number} 形状腿走廊上限解析器
 *   （米；无 identity 覆盖时返回 Infinity）
 */
export function buildLegCorridorCap({ customShape, model, sizeMeters }) {
  const identityCaps = [];
  for (const feature of customShape?.features || []) {
    if (feature.kind !== 'identity') {
      continue;
    }
    const deepestLocal = feature.indices?.[1];
    if (!Number.isInteger(deepestLocal) || !(feature.depthRatio > 0)) {
      continue;
    }
    const range = model.partRanges?.[feature.partIndex ?? 0] ?? null;
    identityCaps.push({
      outlineIndex: range ? range.outlineStart + deepestLocal : deepestLocal,
      depthMeters: feature.depthRatio * sizeMeters,
    });
  }
  /** 环形前向区间 [from, to]（沿行走方向）是否覆盖 index */
  const ringRangeContains = (from, to, index) => {
    if (from <= to) {
      return index >= from && index <= to;
    }
    return index >= from || index <= to;
  };
  /** 形状腿 [fromIndex, toIndex] 的走廊上限（米；无 identity 覆盖时为 Infinity） */
  return (fromIndex, toIndex) => {
    let cap = Number.POSITIVE_INFINITY;
    for (const item of identityCaps) {
      if (ringRangeContains(fromIndex, toIndex, item.outlineIndex)) {
        cap = Math.min(cap, item.depthMeters);
      }
    }
    return cap;
  };
}

/**
 * 步行序列：逐段走廊引导 A* 的分段定义。
 *
 * 多部分图形（群岛等）：主体沿外轮廓顺序走，走到离某岛最近的海岸位置时
 * "连接去 → 绕岛一整圈 → 连接回"，再继续走海岸线——整条路线始终贴着外轮廓 +
 * 短促的岛 excursion，不在图形中间拉弦。单部分图形按约束顺序成环。
 *
 * @param {object} options
 * @param {object} options.model 图形模型（含 partRanges）
 * @param {Array} options.kept 合并后的约束序列
 * @returns {Array<{from: object, to: object, kind: string, part: number}>} 步行段序列
 */
export function buildWalkLegs({ model, kept }) {
  const walkLegs = [];
  if ((model.partRanges?.length ?? 0) > 1) {
    const byPart = model.partRanges.map((_, partIndex) =>
      kept.filter((item) => item.partIndex === partIndex),
    );
    const base = byPart[0]; // parts[0] 是主体
    // 每个分离部分：附着点 = 主体上离岛质心最近的约束；入环点 = 岛上离附着点最近的约束
    const islands = [];
    for (let p = 1; p < byPart.length; p += 1) {
      const list = byPart[p];
      let cx = 0;
      let cy = 0;
      for (const it of list) {
        cx += it.lat;
        cy += it.lng;
      }
      cx /= list.length;
      cy /= list.length;
      let att = 0;
      let attD = Infinity;
      base.forEach((it, i) => {
        const d = distanceMeters(it.lat, it.lng, cx, cy);
        if (d < attD) {
          attD = d;
          att = i;
        }
      });
      let entry = 0;
      let entryD = Infinity;
      list.forEach((it, i) => {
        const d = distanceMeters(it.lat, it.lng, base[att].lat, base[att].lng);
        if (d < entryD) {
          entryD = d;
          entry = i;
        }
      });
      islands.push({ part: p, list, att, entry });
    }
    // 岛按附着点在主体轮廓上的先后排序（沿行走方向顺路绕岛，不走回头路）
    islands.sort((a, b) => a.att - b.att);
    let pos = 0;
    for (const isl of islands) {
      // 主体弧段：上一次离开的位置 → 本岛的附着点（开弧，不闭合）
      for (let i = pos; i < isl.att; i += 1) {
        walkLegs.push({ from: base[i], to: base[i + 1], kind: 'shape', part: 0 });
      }
      // 连接去 → 绕岛一整圈（自入环点起闭环）→ 连接回同一附着点
      walkLegs.push({ from: base[isl.att], to: isl.list[isl.entry], kind: 'connector' });
      for (let i = 0; i < isl.list.length; i += 1) {
        walkLegs.push({
          from: isl.list[(isl.entry + i) % isl.list.length],
          to: isl.list[(isl.entry + i + 1) % isl.list.length],
          kind: 'shape',
          part: isl.part,
        });
      }
      walkLegs.push({ from: isl.list[isl.entry], to: base[isl.att], kind: 'connector' });
      pos = isl.att;
    }
    // 主体收尾：最后附着点 → 起点约束（闭合成完整外轮廓）
    for (let i = pos; i < base.length; i += 1) {
      walkLegs.push({ from: base[i], to: base[(i + 1) % base.length], kind: 'shape', part: 0 });
    }
    return walkLegs;
  }
  for (let i = 0; i < kept.length; i += 1) {
    walkLegs.push({ from: kept[i], to: kept[(i + 1) % kept.length], kind: 'shape', part: 0 });
  }
  return walkLegs;
}

/**
 * 部分内轮廓切片（索引在部分范围内回绕，不跨部分）。
 *
 * @param {{outlineStart: number, outlineCount: number}} range 部分轮廓范围
 * @param {Array<[number, number]>} outlineLatLngs 扁平轮廓
 * @param {number} startIdx 起始索引（全局）
 * @param {number} endIdx 结束索引（全局）
 * @returns {Array<[number, number]>} 轮廓切片
 */
export function slicePartOutline(range, outlineLatLngs, startIdx, endIdx) {
  const start = range.outlineStart;
  const count = range.outlineCount;
  const s = (((startIdx - start) % count) + count) % count;
  const e = (((endIdx - start) % count) + count) % count;
  const slice = [outlineLatLngs[start + s]];
  let i = s;
  while (i !== e) {
    i = (i + 1) % count;
    slice.push(outlineLatLngs[start + i]);
  }
  return slice;
}
