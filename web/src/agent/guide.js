/**
 * 引导式需求确认：用户输入缺地点时以选项方式补齐，然后执行规划。
 *
 * 设计要点：
 * - 引导由本地状态机完成，不额外消耗 LLM 调用；自由文本回答由控制器走 LLM 重解析后合并进来；
 * - 时间维度已移除（尺寸由全尺寸阶梯搜索裁决），槽位只剩地点；
 * - 地点选项来自地点配置（当前城市的地标），代码内不写死地名；
 * - 选项精确匹配才本地填充，匹配不上返回 null，交控制器走 LLM 合并。
 *
 * 纯函数/纯状态（state 为普通对象，函数原地修改它），Node 可直接测试。
 */

import { getActiveCity } from '../place-config.js';

/** "当前视野中心"选项的回传文本 */
export const CENTER_OPTION_VALUE = '就在当前视野中心画';

/** 引导追问中最多展示的地标选项数 */
const PLACE_OPTION_LIMIT = 4;

/**
 * 生成地点选项：当前城市前 N 个地标 + 当前视野中心。
 *
 * @param {object} placeConfig 归一化地点配置
 * @param {number} [limit] 地标选项上限（默认 4）
 * @returns {Array<{label: string, value: string}>} 选项列表
 */
export function createPlaceOptions(placeConfig, limit = PLACE_OPTION_LIMIT) {
  const city = getActiveCity(placeConfig);
  const pois = (city?.pois ?? []).slice(0, Math.max(0, limit));
  return [
    ...pois.map((poi) => ({ label: poi.name, value: poi.name })),
    { label: '当前视野中心', value: CENTER_OPTION_VALUE },
  ];
}

/**
 * 创建引导状态。
 *
 * @param {object} intent 归一化意图（plan/recommend）
 * @param {object} [options]
 * @param {boolean} [options.sizeLocked] 用户原文给过显式尺寸（锁定基准，不被覆盖）
 * @param {string|null} [options.sourceText] 发起引导的原始用户文本（参考候选匹配用：
 *   地点经选项补齐后，参考通道要匹配的是"画一匹马"而不是选项里的地点名词）
 * @returns {{intent: object, placeCenterChosen: boolean, sizeLocked: boolean, sourceText: string|null}}
 */
export function createGuideState(intent, { sizeLocked = false, sourceText = null } = {}) {
  return {
    intent: { ...intent },
    placeCenterChosen: false,
    sizeLocked,
    sourceText: typeof sourceText === 'string' && sourceText ? sourceText : null,
  };
}

/**
 * 下一个待补槽位。
 *
 * @param {object} state 引导状态
 * @returns {'place'|null} null 表示需求已明确
 */
export function nextMissingSlot(state) {
  if (!state.placeCenterChosen && !state.intent.place) {
    return 'place';
  }
  return null;
}

/**
 * 槽位对应的引导问题与选项。
 *
 * @param {'place'} slot 槽位
 * @param {object} placeConfig 归一化地点配置
 * @returns {{question: string, options: Array<{label: string, value: string}>}}
 */
export function questionFor(slot, placeConfig) {
  return {
    question: '想在哪里画？点选一个地点，或直接输入别的地点。',
    options: createPlaceOptions(placeConfig),
  };
}

/**
 * 用选项精确匹配填充当前槽位（本地完成，不调 LLM）。
 *
 * @param {object} state 引导状态
 * @param {string} text 用户回传文本（选项的 label 或 value）
 * @param {object} placeConfig 归一化地点配置
 * @returns {{ack: string}|null} 消费成功返回确认语；匹配不上返回 null
 */
export function fillFromOption(state, text, placeConfig) {
  const t = (text || '').trim();
  const slot = nextMissingSlot(state);
  if (!slot || !t) {
    return null;
  }

  if (t === CENTER_OPTION_VALUE || t === '当前视野中心') {
    state.intent.place = null;
    state.placeCenterChosen = true;
    return { ack: '好的，就在当前地图视野中心画。' };
  }
  const option = createPlaceOptions(placeConfig).find(
    (item) => item.value !== CENTER_OPTION_VALUE && (item.label === t || item.value === t),
  );
  if (!option) {
    return null;
  }
  state.intent.place = option.label;
  return { ack: `好的，地点：${option.label}。` };
}

/**
 * 把引导中自由文本的 LLM 重解析结果合并进引导状态（新非空字段优先，缺省继承）。
 *
 * @param {object} state 引导状态
 * @param {object} next 新一轮归一化意图
 * @param {object} [options]
 * @param {boolean} [options.sizeLocked] 本轮原文给过显式尺寸
 * @returns {object} state
 */
export function mergeIntentInto(state, next, { sizeLocked = false } = {}) {
  const intent = state.intent;
  // 图像描摹目标锁定（方案 2026-11-01 §3）：引导中用户自由文本重解析只能补地点/尺寸
  // 等其余需求，不得替换从图片描出的 T（否则"图像描摹"目标会被 LLM 猜测覆盖）。
  if (intent.customShape?.source === 'traced') {
    if (next.place) {
      intent.place = next.place;
      state.placeCenterChosen = false;
    }
    if (sizeLocked) {
      state.sizeLocked = true;
      if (next.sizeMeters !== null && next.sizeMeters !== undefined) {
        intent.sizeMeters = next.sizeMeters;
        // 尺寸来自用户原文 → 显式标记必须跟着走（方案 2026-11-08 §3.1）：
        // 否则显式尺寸会被当成系统自选，约束闸门不生效
        intent.sizeExplicit = true;
        intent.sizeToleranceMeters = next.sizeToleranceMeters ?? intent.sizeToleranceMeters ?? null;
      }
    }
    return state;
  }
  if (next.shapeSpec) {
    // 规则图形参数化规格：替换图形通道（parseIntentWithRecovery 已生成 procedural T
    // 进 next.customShape），旧点列/内置图形/参考图命中不再适用
    intent.shapeSpec = next.shapeSpec;
    intent.shapeSpecError = null;
    intent.planBlocked = null;
    intent.customShape = next.customShape;
    intent.shapeKey = null;
    intent.referenceSource = null;
  } else if (next.customShape) {
    intent.customShape = next.customShape;
    intent.shapeKey = null;
    intent.shapeSpec = null;
    intent.shapeSpecError = null;
    intent.planBlocked = null;
    // 图形被自由文本重新解析替换：旧参考图命中不再适用（点序列图来源改标 LLM）
    intent.referenceSource = null;
  } else if (next.shapeKey) {
    intent.shapeKey = next.shapeKey;
    intent.customShape = null;
    intent.shapeSpec = null;
    intent.shapeSpecError = null;
    intent.planBlocked = null;
    intent.referenceSource = null;
  }
  if (next.userConstraints?.length) {
    intent.userConstraints = next.userConstraints;
  }
  if (next.place) {
    intent.place = next.place;
    state.placeCenterChosen = false;
  }
  if (sizeLocked) {
    state.sizeLocked = true;
    if (next.sizeMeters !== null && next.sizeMeters !== undefined) {
      intent.sizeMeters = next.sizeMeters;
      // 尺寸来自用户原文 → 显式标记必须跟着走（方案 2026-11-08 §3.1）：
      // 否则显式尺寸会被当成系统自选，约束闸门不生效
      intent.sizeExplicit = true;
      intent.sizeToleranceMeters = next.sizeToleranceMeters ?? intent.sizeToleranceMeters ?? null;
    }
  }
  return state;
}

/**
 * 需求已明确：定稿意图——重算 action（有图形 → plan，否则 recommend）与尺寸基准。
 *
 * @param {object} state 引导状态
 * @returns {object} 可执行的意图
 */
export function finalizeIntent(state) {
  const intent = state.intent;
  intent.action =
    intent.customShape || intent.shapeKey || intent.shapeSpec || intent.shapeSpecError
      ? 'plan'
      : 'recommend';
  if (intent.action === 'recommend') {
    intent.sizeMeters = null; // 推荐模式尺寸由控制器按图形分别设定
  }
  return intent;
}
