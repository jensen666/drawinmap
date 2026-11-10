/**
 * 意图归一化与参数换算（纯函数，Node 可直接测试）。
 *
 * 把 LLM 返回的 JSON 校验/钳制为引擎可用参数。
 * 时间维度已移除：尺寸只来自原文显式尺寸或缺省基准，
 * 具体档位由引擎的全尺寸阶梯（0.5~7.5×）搜索现场裁决。
 */

import { SHAPES } from '../engine/shapes.js';
import { normalizeShapeSpec } from './shape-spec.js';
import { normalizeRequestObjects } from './request-objects.js';
import { sizeToleranceMeters } from '../engine/constraint-contract.js';
import { normalizeCustomShape } from './custom-shape.js';


/** 图形尺寸钳制范围（米） */
/** 自定义图形归一化已独立到 custom-shape.js；这里保留转出，既有 import 面不变。 */
export { normalizeCustomShape } from './custom-shape.js';
export { CUSTOM_MIN_SPAN } from './custom-shape.js';

export const MIN_SIZE_METERS = 300;
export const MAX_SIZE_METERS = 3000;

/** 默认图形尺寸（米），作为尺寸阶梯的搜索基准 */
export const DEFAULT_SIZE_METERS = 1200;

/** 自定义图形点列约束 */

/**
 * 从用户原文中提取显式图形尺寸（米）。
 * 只认"数字+单位+图形语境"（如"画个1公里的星星""尺寸800米"），
 * 避免把"走2公里"这类路线长度误当图形尺寸。
 *
 * @param {string} text 用户原文
 * @returns {number|null} 显式尺寸（米），未提及返回 null
 */
export function extractExplicitSizeMeters(text) {
  if (!text || typeof text !== 'string') {
    return null;
  }
  // 语境一：数字+单位+的（"1公里的星星""500米的心形"）
  // 语境二：大小/尺寸/边长+数字+单位（"尺寸1.2公里"）
  const pattern = /(\d+(?:\.\d+)?)\s*(公里|千米|km|米|m)\s*的|(?:大小|尺寸|边长|直径|半径)[^0-9]{0,4}(\d+(?:\.\d+)?)\s*(公里|千米|km|米|m)/i;
  const match = text.match(pattern);
  if (!match) {
    return null;
  }
  const value = Number(match[1] ?? match[3]);
  const unit = match[2] ?? match[4];
  if (!Number.isFinite(value) || !unit) {
    return null;
  }
  const meters = /公里|千米|km/i.test(unit) ? value * 1000 : value;
  return Math.min(MAX_SIZE_METERS, Math.max(MIN_SIZE_METERS, Math.round(meters)));
}

/** 把值钳制到 [min, max]，非有限数返回 null。
 * null/undefined 必须显式返回 null——Number(null) === 0，不拦住的话"未指定朝向"
 * 会被当成"显式指定 0°"，rotationExplicit 恒为 true，多朝向阶梯搜索被锁死在
 * 单一朝向（2026-10-31 评审发现的既有 bug：历史上 plan.begin 的 rotations 全是 [0]）。 */
function clampNumber(value, min, max) {
  if (value === null || value === undefined) {
    return null;
  }
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return null;
  }
  return Math.min(max, Math.max(min, num));
}

/**
 * 用户显式约束清单（方案 §8.2 userConstraints）：只保留合法字符串条目。
 * 这些约束来自用户原文/参考图/用户确认，具有目标否决权——与 LLM 自行声明的
 * features（generatorGuides，无否决权）严格区分。
 *
 * @param {object} input LLM 返回的意图 JSON
 * @returns {string[]} 规范化后的约束清单（≤ 8 条，每条 ≤ 40 字）
 */
function normalizeUserConstraints(input) {
  if (!Array.isArray(input.userConstraints)) {
    return [];
  }
  return input.userConstraints
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => item.trim().slice(0, 40))
    .slice(0, 8);
}

/** referenceQuery 各字段长度上限（方案 2026-10-31 §9.3：短查询，不带地点/动词/客气话） */
const REFERENCE_QUERY_LIMITS = Object.freeze({
  zh: 30,
  en: 40,
  scientificName: 60,
  searchTerm: 40,
  trait: 20,
  scientificNames: 4,
  searchTerms: 4,
  traits: 8,
});

/** 查询文本清理：去控制字符/尖括号与多余空白并限长（非法字符按空格折叠） */
function cleanQueryText(value, maxLength) {
  if (typeof value !== 'string') {
    return null;
  }
  const cleaned = value
    .replace(/[\u0000-\u001f<>"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
  return cleaned || null;
}

/** 查询数组清理：逐项限长去重，限项数 */
function cleanQueryList(list, maxItems, maxLength) {
  if (!Array.isArray(list)) {
    return [];
  }
  const out = [];
  for (const item of list) {
    const cleaned = cleanQueryText(item, maxLength);
    if (cleaned && !out.includes(cleaned)) {
      out.push(cleaned);
    }
    if (out.length >= maxItems) {
      break;
    }
  }
  return out;
}

/**
 * 归一化可选素材检索查询（方案 2026-10-31 §9.3 referenceQuery）。
 * 只保留与目标对象有关的短查询；没有可靠英文/学名时 LLM 不该编造——
 * 归一化只做长度/数组/非法字符限制，不替 LLM 补内容。
 *
 * @param {*} raw LLM 返回的 referenceQuery 字段
 * @returns {object|null} { zh, en, scientificNames, searchTerms, traits }；无有效内容返回 null
 */
export function normalizeReferenceQuery(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const zh = cleanQueryText(raw.zh, REFERENCE_QUERY_LIMITS.zh);
  const en = cleanQueryText(raw.en, REFERENCE_QUERY_LIMITS.en);
  const scientificNames = cleanQueryList(
    raw.scientificNames,
    REFERENCE_QUERY_LIMITS.scientificNames,
    REFERENCE_QUERY_LIMITS.scientificName,
  );
  const searchTerms = cleanQueryList(
    raw.searchTerms,
    REFERENCE_QUERY_LIMITS.searchTerms,
    REFERENCE_QUERY_LIMITS.searchTerm,
  );
  const traits = cleanQueryList(raw.traits, REFERENCE_QUERY_LIMITS.traits, REFERENCE_QUERY_LIMITS.trait);
  if (!zh && !en && scientificNames.length === 0 && searchTerms.length === 0) {
    return null;
  }
  return { zh, en, scientificNames, searchTerms, traits };
}

/**
 * 归一化 LLM 返回的意图 JSON（时间维度已移除）。
 *
 * @param {object} raw LLM 返回并解析出的 JSON 对象
 * @param {object} [options]
 * @param {number} [options.defaultSize] plan 且未给显式尺寸时的搜索基准（米）
 * @param {number} [options.defaultRotation] 未指定旋转时的兜底（度）
 * @param {number|null} [options.explicitSizeMeters] 从用户原文本地提取的显式尺寸（作为搜索基准）
 * @returns {{
 *   action: 'chat'|'plan'|'recommend',
 *   shapeKey: string|null,
 *   customShape: {name: string, constraintPoints: Array, outlinePoints: Array}|null,
 *   shapeSpec: object|null, shapeSpecError: string|null,
 *   userConstraints: string[],
 *   requestObjects: Array<{name: string, aliases: string[]}>,
 *   place: string|null,
 *   sizeMeters: number|null,
 *   sizeExplicit: boolean,
 *   sizeToleranceMeters: number|null,
 *   rotationDeg: number,
 *   rotationExplicit: boolean,
 *   reply: string,
 *   notes: string[]
 * }} 归一化意图（recommend 时 shapeKey/customShape/shapeSpec/sizeMeters 均为 null；
 * notes 记录发生的回退，便于排查）
 */
export function normalizeIntent(
  raw,
  {
    defaultSize = DEFAULT_SIZE_METERS,
    defaultRotation = 0,
    explicitSizeMeters = null,
  } = {},
) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const notes = [];

  // action：缺省时按是否给出规划要素推断（有图形 → plan；只有条件 → recommend）
  let action = ['chat', 'plan', 'recommend'].includes(input.action) ? input.action : null;
  if (!action) {
    if (input.shape || input.customShape) {
      action = 'plan';
    } else {
      action = input.place ? 'recommend' : 'chat';
    }
    notes.push(`action 缺省，推断为 ${action}`);
  }

  // customShape：LLM 生成的任意图形点列（通用通道，无图形专项逻辑）
  let customShape = null;
  if (input.customShape !== null && input.customShape !== undefined) {
    customShape = normalizeCustomShape(input.customShape);
    if (!customShape) {
      notes.push('customShape 校验未通过（点列不合法），已忽略');
    }
  }

  // shapeSpec：规则图形参数化规格（方案 §4/§5）。LLM 填参数、本地校验/规范化，
  // 坐标由参数化生成器产生。校验失败不静默换图形：记录 shapeSpecError 供编排层
  // 恢复或诚实失败（方案 §4 分派约束 3）。
  let shapeSpec = null;
  let shapeSpecError = null;
  if (input.shapeSpec !== null && input.shapeSpec !== undefined) {
    const specResult = normalizeShapeSpec(input.shapeSpec);
    if (specResult.ok) {
      shapeSpec = specResult.spec;
    } else {
      shapeSpecError = specResult.reason;
      notes.push(`shapeSpec 校验未通过：${specResult.reason}`);
    }
  }
  // 同时给了有效 shapeSpec 与 customShape：规则图形走参数化（方案 §4 首选生成方式），
  // 点列忽略并记录；规格校验失败但点列合法时保留点列走自由通道（不丢用户要的图形）
  if (shapeSpec && customShape) {
    customShape = null;
    notes.push('同时给出 shapeSpec 与 customShape，按参数化规格生成（点列已忽略）');
  } else if (shapeSpecError && customShape) {
    shapeSpecError = null;
    notes.push('shapeSpec 校验未通过，但点列合法：按自由轮廓生成');
  }

  // userConstraints：用户显式约束（具有目标否决权）；与 LLM features 分离保存。
  // shapeSpec.userConstraints 合并进来（评审 🟠4：否则只存在 spec 里、到不了验收
  // 闸门，否决权空转）——prompt 允许 LLM 把几何约束写进规格，合并后统一走
  // 逐项验收记录；顶层与规格内重复的约束去重。
  const userConstraints = normalizeUserConstraints(input);
  if (shapeSpec?.userConstraints?.length) {
    for (const constraint of shapeSpec.userConstraints) {
      if (typeof constraint?.text === 'string' && constraint.text.trim()
          && !userConstraints.includes(constraint.text.trim())) {
        userConstraints.push(constraint.text.trim());
      }
    }
    userConstraints.splice(8);
  }

  // shape：校验取值
  let shapeKey = null;
  if (typeof input.shape === 'string' && SHAPES[input.shape]) {
    shapeKey = input.shape;
  } else if (input.shape !== null && input.shape !== undefined) {
    notes.push(`非法 shape「${input.shape}」已忽略`);
  }

  // action 与图形的双向兜底：图形优先（给了图形就按 plan 画）；
  // plan 但没给图形 → 转 recommend（系统实测推荐，不再由 LLM 盲挑兜底图形）。
  // shapeSpec 存在时按 plan 处理（即使规格校验失败——恢复/诚实失败由编排层负责，
  // 不静默换成推荐，方案 §4 分派约束 3）。
  const hasShape = Boolean(shapeKey || customShape || shapeSpec || shapeSpecError);
  if (action === 'recommend' && hasShape) {
    action = 'plan';
    notes.push('标了 recommend 但带有图形，按 plan 处理（图形优先）');
  } else if (action === 'plan' && !hasShape) {
    action = 'recommend';
    notes.push('plan 但未指定图形，转 recommend（系统实测推荐）');
  }

  if (action === 'plan') {
    if (customShape) {
      // 自定义图形优先于内置图形字段
      shapeKey = null;
    }
    if (shapeSpec) {
      // 参数化规格优先于内置图形字段
      shapeKey = null;
    }
  } else {
    customShape = null;
    shapeSpec = null;
    shapeSpecError = null;
  }

  // place：非空字符串才保留
  const place =
    typeof input.place === 'string' && input.place.trim() ? input.place.trim() : null;

  // 时间维度已移除：LLM 即使返回 minutes 也一律忽略（尺寸与时间无关）
  if (input.minutes !== null && input.minutes !== undefined) {
    notes.push('minutes 已忽略（时间维度已移除，尺寸由全阶梯搜索裁决）');
  }
  // LLM 的 sizeMeters 字段不可信（模型会编造），一律忽略并记录
  const llmSize = clampNumber(input.sizeMeters, MIN_SIZE_METERS, MAX_SIZE_METERS);
  if (llmSize !== null) {
    notes.push(`LLM sizeMeters=${llmSize} 已忽略（尺寸只信用户原文）`);
  }
  // 尺寸来源：用户原文显式尺寸 > 默认基准（作为阶梯搜索的基准，最终档位由搜索定）
  // sizeExplicit：尺寸是否**来自用户原文**（方案 2026-11-08 §3.1）。
  // LLM 的 sizeMeters 一律忽略，只有本地从原文提取到的尺寸才算显式要求——
  // 这是"用户要 800 米"与"系统自己挑 800 米"的唯一可判别依据。
  let sizeMeters = null;
  let sizeExplicit = false;
  if (action === 'plan') {
    if (explicitSizeMeters !== null && Number.isFinite(explicitSizeMeters)) {
      sizeMeters = Math.min(MAX_SIZE_METERS, Math.max(MIN_SIZE_METERS, Math.round(explicitSizeMeters)));
      sizeExplicit = true;
      notes.push(`采用用户原文显式尺寸 ${sizeMeters} m（作为搜索基准）`);
    } else {
      sizeMeters = defaultSize;
      notes.push(`尺寸基准 ${defaultSize} m（未给显式尺寸，阶梯搜索 0.5~7.5× 现选）`);
    }
  }
  // 显式尺寸的工程容差（米）：交付前核验"实际尺寸 vs 请求尺寸"用同一口径。
  const sizeTolerance = sizeExplicit ? sizeToleranceMeters(sizeMeters) : null;

  let rotationDeg = defaultRotation;
  const rotation = clampNumber(input.rotationDeg, 0, 345);
  // 用户/LLM 是否明确指定了朝向：rotationDeg 恒为数字（未指定时是默认 0），
  // 不能再用 rotationDeg !== null 判断——否则自动搜索会被锁死在 0°，只搜一个朝向。
  let rotationExplicit = rotation !== null;
  if (rotationExplicit) {
    rotationDeg = Math.round(rotation / 15) * 15;
  }
  // 规格朝向并入意图级旋转（方案 §6.1：旋转复用现有链路在投影时统一施加，
  // 不烘焙进 T）。仅当意图级未显式指定时采纳，用户/意图级朝向优先。
  if (!rotationExplicit && shapeSpec && shapeSpec.rotationDeg > 0) {
    rotationDeg = Math.round(shapeSpec.rotationDeg / 15) * 15 % 360;
    rotationExplicit = true;
    notes.push(`采用规格朝向 ${rotationDeg}°`);
  }

  // referenceQuery：可选素材检索查询（方案 2026-10-31 §9.3）。
  // 只影响参考素材检索与候选排序，不替代 customShape，也不改变用户显式约束。
  const referenceQuery = normalizeReferenceQuery(input.referenceQuery);
  if (input.referenceQuery && !referenceQuery) {
    notes.push('referenceQuery 无有效内容，已忽略');
  } else if (referenceQuery) {
    notes.push(`referenceQuery: ${JSON.stringify(referenceQuery)}`);
  }

  // requestObjects：用户这一轮请求的对象集合（方案 2026-11-05 §4.2）。
  // 结构化表达，不靠最终名称字符串猜测——交付前用它核对"请求对象 = 实际交付对象"。
  const requestObjects = normalizeRequestObjects(input.requestObjects);
  if (input.requestObjects && requestObjects.length === 0) {
    notes.push('requestObjects 无有效内容，已忽略');
  }

  const reply = typeof input.reply === 'string' ? input.reply.trim() : '';

  return {
    action,
    shapeKey,
    customShape,
    shapeSpec,
    shapeSpecError,
    userConstraints,
    referenceQuery,
    requestObjects,
    place,
    sizeMeters,
    sizeExplicit,
    sizeToleranceMeters: sizeTolerance,
    rotationDeg,
    rotationExplicit,
    reply,
    notes,
  };
}
