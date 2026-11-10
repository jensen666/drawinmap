/**
 * 测试用地点配置 fixture：读取并归一化真实配置文件（web/config/place-gazetteer.json）。
 *
 * 测试断言尽量从配置取值（而不是在测试里再抄一份地名表），验证"解析行为由配置驱动"。
 */

import { readFileSync } from 'node:fs';
import { normalizePlaceConfig } from '../../web/src/place-config.js';

/** 原始配置 JSON */
export const RAW_PLACE_CONFIG = JSON.parse(
  readFileSync(new URL('../../web/config/place-gazetteer.json', import.meta.url), 'utf8'),
);

/** 归一化后的配置（与浏览器加载结果一致） */
export const placeConfig = normalizePlaceConfig(RAW_PLACE_CONFIG);

/**
 * 克隆原始配置并覆盖 matching 字段（用于测试不同匹配策略，不污染全局配置）。
 *
 * @param {object} [patch] 覆盖项
 * @param {object} [patch.matching] 匹配策略覆盖
 * @returns {object} 归一化克隆配置
 */
export function clonePlaceConfig(patch = {}) {
  const raw = structuredClone(RAW_PLACE_CONFIG);
  if (patch.matching) {
    raw.matching = { ...(raw.matching || {}), ...patch.matching };
  }
  return normalizePlaceConfig(raw);
}
