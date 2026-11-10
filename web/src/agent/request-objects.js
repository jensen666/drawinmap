/**
 * 请求对象集合与交付对象集合（方案 2026-11-05 §4.2/§4.3、2026-11-08 §4.2）。
 *
 * 目的：把「用户要画哪些对象」从"最终名称字符串猜测"变成**结构化集合**，
 * 并在交付前核对「请求对象 = 实际交付对象」：
 * - 意图层输出 requestObjects（LLM 解析），归一化后随意图流转；
 * - 参考通道命中的对象按对象分组返回（objectGroups），可与请求集合逐项比对；
 * - 交付前用同一套判定核对覆盖率：缺对象就诚实说明并追问，不硬画、不承诺。
 *
 * 2026-11-08 修订：最终验收改为**一对一身份匹配**。
 * 此前"已交付部分数 ≥ 请求对象数就算完整"的数量短路会把
 * 「请求 猫/狗/兔、实际交付 猫/狗/狗」判成完整（漏报），也会让
 * 「请求 猫头鹰+猫」被顺序贪心误判成缺对象（误报）。现在按
 * "每个请求对象匹配一个**不同的**实际组成部分"核对。
 *
 * 纯函数模块：不依赖 DOM/网络，Node 可直接单测。
 */

/** 请求对象数量上限（更多按"多对象"处理意义不大，且会挤爆目标轮廓） */
export const MAX_REQUEST_OBJECTS = 4;
/** 单个对象名长度上限 */
const OBJECT_NAME_MAX = 20;
/** 单个对象的别名数量上限 */
const OBJECT_ALIAS_MAX = 6;

/** 归一化对象名：去空白与常见标点、小写 */
function normalizeName(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[\s·・、,，.。;；:：!！?？"'“”‘’()（）\[\]【】<>《》]/g, "");
}

/** 是否单字中文（单字中文在口语里常是简称，匹配放宽） */
function isSingleCjk(value) {
  return value.length === 1 && /[\u4e00-\u9fff]/.test(value);
}

/**
 * 名称匹配核心（宽松/严格两种口径共用，避免两处重复实现漂移）：
 * - 完全相同 → 匹配；
 * - 一方包含另一方，且较短一方长度 ≥ 2 → 匹配（如"长颈鹿"↔"鹿"）；
 * - 宽松口径额外允许较短一方是单字中文（口语简称，如"小狗"↔"狗"）；
 * - 其余不匹配（单字英文/数字的包含关系不算覆盖，避免 "cat" ⊂ "cattle"）。
 *
 * @param {string} a 名称 A
 * @param {string} b 名称 B
 * @param {boolean} [allowSingleCjk] 是否放宽单字中文（宽松口径）
 * @returns {boolean}
 */
function namesMatch(a, b, { allowSingleCjk = false } = {}) {
  const left = normalizeName(a);
  const right = normalizeName(b);
  if (!left || !right) {
    return false;
  }
  if (left === right) {
    return true;
  }
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  if (!longer.includes(shorter)) {
    return false;
  }
  return shorter.length >= 2 || (allowSingleCjk && isSingleCjk(shorter));
}

/**
 * 名称覆盖判定（宽松但有方向）：
 * - 完全相同 → 覆盖；
 * - 一方包含另一方，且较短一方长度 ≥ 2 → 覆盖（如"长颈鹿"↔"鹿"）；
 * - 一方包含另一方，且较短一方是单字中文 → 覆盖（口语简称，如"小狗"↔"狗"）；
 * - 其余不覆盖（单字英文/数字的包含关系不算覆盖，避免 "cat" ⊂ "cattle"）。
 *
 * @param {string} a 名称 A
 * @param {string} b 名称 B
 * @returns {boolean}
 */
export function namesCover(a, b) {
  return namesMatch(a, b, { allowSingleCjk: true });
}

/**
 * 请求对象名是否被已交付的名称集合覆盖（考虑别名）。
 *
 * @param {{name: string, aliases?: string[]}} requested 请求对象
 * @param {string[]} deliveredNames 已交付的名称集合（整体名 + 各部分名）
 * @returns {boolean}
 */
export function requestedObjectCovered(requested, deliveredNames) {
  const names = Array.isArray(deliveredNames) ? deliveredNames.filter(Boolean) : [];
  if (names.length === 0) {
    return false;
  }
  const candidates = [requested?.name, ...(requested?.aliases || [])].filter(Boolean);
  return names.some((delivered) => candidates.some((candidate) => namesCover(candidate, delivered)));
}

/**
 * 归一化 LLM 返回的请求对象集合。
 *
 * 接受两种形态：
 * - ["马", "狗"]
 * - [{"name": "马", "aliases": ["马匹"]}, ...]
 *
 * @param {*} raw LLM 返回的 requestObjects 字段
 * @returns {Array<{name: string, aliases: string[]}>} 归一化后的请求对象集合
 */
export function normalizeRequestObjects(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const name = typeof item === "string" ? item.trim() : typeof item?.name === "string" ? item.name.trim() : "";
    if (!name) {
      continue;
    }
    const key = normalizeName(name);
    if (!key || seen.has(key)) {
      continue;
    }
    const aliases = (Array.isArray(item?.aliases) ? item.aliases : [])
      .filter((alias) => typeof alias === "string" && alias.trim())
      .map((alias) => alias.trim().slice(0, OBJECT_NAME_MAX))
      .filter((alias) => normalizeName(alias) !== key)
      .slice(0, OBJECT_ALIAS_MAX);
    seen.add(key);
    out.push({ name: name.slice(0, OBJECT_NAME_MAX), aliases });
    if (out.length >= MAX_REQUEST_OBJECTS) {
      break;
    }
  }
  return out;
}

/**
 * 派生「实际交付对象」的身份单元（方案 2026-11-08 §4.2）。
 *
 * 身份单元 = 交付物里**可以独立认领一个请求对象**的部分：
 * - 多部分目标：每个 part 一个单元（整体名只是展示名，不能替代身份）；
 * - 单部分目标：整体名即该单元的身份（没有部分名时用整体名兜底）。
 *
 * 参考通道命中的对象名/别名属于**同一个**交付对象的其它叫法，合并为该单元的别名；
 * 参考复合目标（多素材）的各部分名按下标补进对应部分（部分没名字时用素材名）。
 *
 * @param {object} [input]
 * @param {object|null} [input.customShape] 实际交付目标（归一化 customShape）
 * @param {string|null} [input.displayName] 交付物的名称（内置图形/参数化图形没有
 *   customShape 时用图形注册名或规格名作为单部分交付的身份）
 * @param {Array<{name?: string}>} [input.referenceParts] 参考复合目标的部分名
 * @param {string[]} [input.referenceNames] 参考命中名/别名（同一对象的其它叫法）
 * @returns {Array<{name: string, partIndex: number, identified: boolean, aliases: string[]}>}
 */
export function buildDeliveredObjectUnits({
  customShape = null,
  displayName = null,
  referenceParts = [],
  referenceNames = [],
} = {}) {
  const parts = Array.isArray(customShape?.parts) ? customShape.parts : [];
  const refParts = Array.isArray(referenceParts) ? referenceParts : [];
  const aliasNames = (Array.isArray(referenceNames) ? referenceNames : []).filter(Boolean);
  const units = [];
  if (parts.length > 1) {
    parts.forEach((part, index) => {
      const refPart = refParts[index] ?? null;
      const name = part?.name || refPart?.name || '';
      units.push({
        name,
        partIndex: index,
        identified: Boolean(name),
        aliases: [],
      });
    });
    return units;
  }
  // 单部分（无 parts 或只有一个）：整体名就是该对象的身份
  // （内置图形没有 customShape，用图形注册名/规格名兜底）
  const name = parts[0]?.name || customShape?.name || displayName || '';
  units.push({
    name,
    partIndex: 0,
    identified: Boolean(name),
    aliases: aliasNames.filter((alias) => alias !== name),
  });
  return units;
}

/**
 * 请求对象 ↔ 交付身份的一对一匹配（最大二分匹配）。
 *
 * 为什么不用「逐个贪心」：请求「猫头鹰」与「猫」、交付「猫头鹰」与「猫」两个单元时，
 * 贪心会让先到的请求认领「猫头鹰」，把另一个挤成缺失（误报）。增广路径能
 * 找到「猫→猫、猫头鹰→猫头鹰」这样的最大匹配。
 *
 * 身份未知的部分（没有名字）不能凭名字认领请求，但可以在**已命名部分匹配完之后**
 * 顶替一个仍未被认领的请求——这类匹配标记为 unverified（数量对得上但身份没核实），
 * 调用方据此在结果里显式暴露「未核实」，不得把它当成「已核实通过」。
 *
 * @param {object} input
 * @param {Array<{name: string, aliases?: string[]}>} input.requested 请求对象集合
 * @param {Array<{name?: string, aliases?: string[], identified?: boolean}>} input.units 交付身份单元
 * @returns {{total: number, covered: Array<object>, missing: Array<object>, complete: boolean,
 *   assignments: Array<{requested: object, unit: object|null, verified: boolean}>, unverifiedCount: number}}
 */
export function matchDeliveredObjects({ requested = [], units = [], overallName = null } = {}) {
  const list = Array.isArray(requested) ? requested : [];
  const pool = Array.isArray(units) ? units : [];
  if (list.length === 0) {
    return { total: 0, covered: [], missing: [], complete: true, assignments: [], unverifiedCount: 0 };
  }
  // 单对象请求：交付物**整体**就是那个对象（整体名可作为身份）。
  // 多部分形状（风车的四片叶子、自行车的两个轮子）是一个对象的组成部分，
  // 不是"多个对象"——用整体名认领，否则会把"四叶风车"判成缺对象。
  if (list.length === 1) {
    // 单对象请求：交付物**整体**就是那个对象（整体名可作为身份）。
    // 多部分形状（风车的四片叶子、自行车的两个轮子）是一个对象的组成部分，
    // 不是"多个对象"——用整体名认领，否则会把"四叶风车"判成缺对象。
    const candidates = [list[0]?.name, ...(list[0]?.aliases || [])].filter(Boolean);
    if (overallName && candidates.some((candidate) => namesCover(candidate, overallName))) {
      return {
        total: 1,
        covered: [list[0]],
        missing: [],
        complete: true,
        assignments: [{ requested: list[0], unit: { name: overallName, partIndex: -1, identified: true }, verified: true }],
        unverifiedCount: 0,
      };
    }
    // 名字对不上但只有**一个**请求对象：这是"叫法不同"，不是"交付了别的对象"
    // （例如用户说"正方形"、内置图形的名字是"矩形"）。名字不足以判错，
    // 语义对不对由视觉质检/目标验收负责——这里记为"未核实"，不得当成缺对象。
    const onlyUnit = pool[0];
    if (pool.length > 0) {
      return {
        total: 1,
        covered: [list[0]],
        missing: [],
        complete: true,
        assignments: [{ requested: list[0], unit: onlyUnit, verified: false }],
        unverifiedCount: 1,
        nameMismatch: true,
      };
    }
  }
  if (pool.length === 0) {
    return {
      total: list.length,
      covered: [],
      missing: [...list],
      complete: false,
      assignments: list.map((item) => ({ requested: item, unit: null, verified: false })),
      unverifiedCount: 0,
    };
  }

  /** 某个请求是否能被某个交付单元认领（名字/别名双向包含判定） */
  const canClaim = (requestItem, unit) => {
    const candidates = [requestItem?.name, ...(requestItem?.aliases || [])].filter(Boolean);
    const unitNames = [unit?.name, ...(unit?.aliases || [])].filter(Boolean);
    if (candidates.length === 0 || unitNames.length === 0) {
      return false;
    }
    return candidates.some((candidate) => unitNames.some((name) => namesCover(candidate, name)));
  };

  /** 可凭名字认领的已识别单元 */
  const claimableUnits = pool
    .map((unit, index) => ({ unit, index }))
    .filter((entry) => entry.unit?.identified !== false && entry.unit?.name);

  // 最大二分匹配（Kuhn 增广路径）：保证「请求数 = 单元数」时不因顺序产生误报
  const unitToRequest = new Map();
  const requestToUnit = new Map();
  const tryAssign = (requestIndex, visited) => {
    const item = list[requestIndex];
    for (const entry of claimableUnits) {
      if (visited.has(entry.index)) {
        continue;
      }
      // 该请求必须**能**认领这个单元（名字/别名覆盖），否则不得占位
      if (!canClaim(item, entry.unit)) {
        continue;
      }
      visited.add(entry.index);
      const occupant = unitToRequest.get(entry.index);
      if (occupant === undefined || tryAssign(occupant, visited)) {
        unitToRequest.set(entry.index, requestIndex);
        requestToUnit.set(requestIndex, entry.index);
        return true;
      }
    }
    return false;
  };
  list.forEach((item, index) => {
    tryAssign(index, new Set());
  });

  const covered = [];
  const missing = [];
  const assignments = [];
  let unverifiedCount = 0;
  list.forEach((item, index) => {
    const unitIndex = requestToUnit.get(index);
    if (unitIndex !== undefined) {
      covered.push(item);
      assignments.push({ requested: item, unit: pool[unitIndex], verified: true });
      return;
    }
    // 身份未知的部分顶替一个仍未被认领的请求（标记未核实，不算「已核实通过」）
    const unidentifiedIndex = pool.findIndex(
      (unit, unitIdx) =>
        unit?.identified === false &&
        !(unit?.aliases || []).length &&
        !unitToRequest.has(unitIdx),
    );
    if (unidentifiedIndex >= 0) {
      unitToRequest.set(unidentifiedIndex, index);
      covered.push(item);
      unverifiedCount += 1;
      assignments.push({ requested: item, unit: pool[unidentifiedIndex], verified: false });
      return;
    }
    missing.push(item);
    assignments.push({ requested: item, unit: null, verified: false });
  });

  return {
    total: list.length,
    covered,
    missing,
    complete: missing.length === 0,
    assignments,
    unverifiedCount,
  };
}

/**
 * 交付覆盖率判定：请求对象集合与实际交付对象集合的差异。
 *
 * 判定原则（方案 2026-11-08 §4.2，修订 2026-11-05 §4.2 的「数量足够即通过」）：
 * - **一对一身份匹配**：每个请求对象必须匹配一个**不同的**实际组成部分；
 *   同一个部分不得重复认领两个请求对象；
 * - **不得**再用「已交付部分数 ≥ 请求对象数」替代身份核对——那会把
 *   「请求 猫/狗/兔、实际交付 猫/狗/狗」判成完整（历史漏报来源）；
 * - 名称判定沿用别名集合与 namesCover（兔 ↔ 兔子、猫 ↔ 猫头鹰 这类要能覆盖）。
 *
 * @param {object} input
 * @param {Array<{name: string, aliases?: string[]}>} input.requested 请求对象集合
 * @param {string[]} [input.deliveredNames] 已交付的名称集合（整体名 + 各部分名）
 * @param {number} [input.deliveredPartCount] 已交付的部分数（兼容旧调用方，仅记录）
 * @param {Array<object>|null} [input.deliveredObjects] 结构化交付身份单元（优先）
 * @param {string|string[]} [input.overallName] 交付物整体名（单对象请求时作为身份）
 * @returns {{total: number, covered: Array<object>, missing: Array<object>,
 *   complete: boolean, assignments: Array<object>, unverifiedCount: number,
 *   deliveredPartCount: number}}
 */
export function evaluateObjectCoverage({
  requested = [],
  deliveredNames = [],
  deliveredPartCount = 0,
  deliveredObjects = null,
  overallName = null,
} = {}) {
  const list = Array.isArray(requested) ? requested : [];
  const names = Array.isArray(deliveredNames) ? deliveredNames.filter(Boolean) : [];
  const parts = Number.isFinite(deliveredPartCount) ? deliveredPartCount : 0;
  if (list.length === 0) {
    return {
      total: 0,
      covered: [],
      missing: [],
      complete: true,
      assignments: [],
      unverifiedCount: 0,
      deliveredPartCount: parts,
    };
  }
  // 交付名称为空 = 没有可核对的交付物（由调用方按「未交付」处理）
  if (names.length === 0 && !(Array.isArray(deliveredObjects) && deliveredObjects.length > 0)) {
    return {
      total: list.length,
      covered: [],
      missing: [...list],
      complete: false,
      assignments: [],
      unverifiedCount: 0,
      deliveredPartCount: parts,
    };
  }
  // 身份单元：优先用结构化的 deliveredObjects；否则把名称集合逐个当作独立身份
  // （「只有显示名」时的降级口径：每个名字认领一个请求，不做数量短路）。
  const units = Array.isArray(deliveredObjects) && deliveredObjects.length > 0
    ? deliveredObjects
    : names.map((name, index) => ({ name, partIndex: index, identified: true }));
  const matched = matchDeliveredObjects({
    requested: list,
    units,
    overallName: Array.isArray(overallName) ? overallName[0] : overallName ?? null,
  });
  return {
    total: list.length,
    covered: matched.covered,
    missing: matched.missing,
    complete: matched.complete,
    assignments: matched.assignments,
    unverifiedCount: matched.unverifiedCount,
    deliveredPartCount: parts,
  };
}

/**
 * 严格名称匹配（用于「请求对象 ↔ 参考命中对象」比对）。
 *
 * 与 namesCover 的区别：**不放宽单字中文**。否则请求「猫」会被素材对象「猫头鹰」
 * 认领（`'猫' ⊂ '猫头鹰'`），多对象复合目标就会用同一素材拼出两份。
 *
 * @param {string} a 名称 A
 * @param {string} b 名称 B
 * @returns {boolean}
 */
export function namesMatchStrict(a, b) {
  return namesMatch(a, b);
}

/**
 * 请求对象 → 命中对象比对：返回命中的与缺失的（供参考通道部分命中判定）。
 *
 * 比对用**严格**口径（见 namesMatchStrict）：请求「猫」不能被素材对象「猫头鹰」
 * 认领，否则会以为命中了两个对象、实际拿同一个素材拼两份。
 *
 * @param {Array<{name: string, aliases?: string[]}>} requested 请求对象集合
 * @param {Array<{objectName: string, aliases?: string[]}>} available 可用对象（参考通道命中）
 * @returns {{hit: Array<object>, missing: Array<object>, hitAvailable: Array<object>}}
 */
export function matchRequestedObjects(requested = [], available = []) {
  const list = Array.isArray(requested) ? requested : [];
  const pool = Array.isArray(available) ? available : [];
  const hit = [];
  const missing = [];
  const hitAvailable = [];
  for (const item of list) {
    const found = pool.find((entry) => {
      const candidates = [item?.name, ...(item?.aliases || [])].filter(Boolean);
      const entryNames = [entry?.objectName, ...(entry?.aliases || [])].filter(Boolean);
      return candidates.some((candidate) => entryNames.some((name) => namesMatchStrict(candidate, name)));
    });
    if (found) {
      hit.push(item);
      hitAvailable.push(found);
    } else {
      missing.push(item);
    }
  }
  return { hit, missing, hitAvailable };
}

/**
 * 缺对象的诚实回复（方案 2026-11-05 §4.2）：明确列出已命中与缺失对象，
 * 并追问是替代还是只画已命中的部分——不承诺未交付的对象。
 *
 * @param {object} input
 * @param {Array<{name: string}>} input.requested 请求对象集合
 * @param {Array<{name: string}>} input.delivered 已交付对象名
 * @param {Array<{name: string}>} input.missing 缺失对象名
 * @param {string} [input.placeText] 地点文本
 * @returns {string} 回复文本
 */
export function composeObjectShortfallReply({ requested = [], delivered = [], missing = [], placeText = '' } = {}) {
  const requestedNames = requested.map((item) => item?.name).filter(Boolean);
  const deliveredNames = delivered.filter(Boolean);
  const missingNames = missing.map((item) => item?.name).filter(Boolean);
  const lines = [];
  if (deliveredNames.length > 0) {
    lines.push(`已找到「${deliveredNames.join('」「')}」的可用轮廓。`);
  }
  if (missingNames.length > 0) {
    lines.push(`但「${missingNames.join('」「')}」还没有找到可用轮廓。`);
  }
  lines.push(
    `你要的是「${requestedNames.join('」「')}」${placeText ? `（${placeText}）` : ''}，这轮我没有硬画没找到的对象。`,
  );
  lines.push(
    missingNames.length > 0
      ? '想怎么办：换一个说法让我重新找（比如换成更常见的叫法），还是先只画已找到的那部分？'
      : '如果想调整，告诉我改画哪一个就行。',
  );
  return lines.join('\n');
}

/**
 * 交付前的对象一致性核对（方案 2026-11-05 §4.3、2026-11-08 §4.2）：
 * 「请求对象 = 实际交付对象」，回复不得额外承诺未交付对象。
 *
 * 核对按**实际组成部分的一对一身份匹配**进行：整体拼接显示名只用于展示，
 * 不能替代对象身份（否则「猫+狗+狗」这类重复交付会被整体名掩盖）。
 *
 * @param {object} input
 * @param {Array<{name: string, aliases?: string[]}>} input.requested 请求对象集合
 * @param {{name?: string, parts?: Array<{name?: string}>}|null} input.customShape 实际交付目标
 * @param {string[]} [input.extraNames] 额外的已交付名称（参考命中名/命中别名等）
 * @param {Array<object>|null} [input.deliveredObjects] 结构化交付身份单元（优先于推导）
 * @returns {{ok: boolean, missing: Array<object>, deliveredNames: string[],
 *   deliveredPartCount: number, deliveredObjects: Array<object>,
 *   assignments: Array<object>, unverifiedCount: number}}
 */
export function checkDeliveryObjectConsistency({
  requested = [],
  customShape = null,
  extraNames = [],
  deliveredObjects = null,
} = {}) {
  const parts = Array.isArray(customShape?.parts) ? customShape.parts : [];
  const extra = (Array.isArray(extraNames) ? extraNames : []).filter(Boolean);
  const units = Array.isArray(deliveredObjects) && deliveredObjects.length > 0
    ? deliveredObjects
    : buildDeliveredObjectUnits({
        customShape,
        // 参考复合目标的部分名按下标补进对应部分
        referenceParts: parts.length > 1 ? [] : [],
        referenceNames: parts.length > 1 ? [] : extra,
      });
  const deliveredNames = [
    ...(customShape?.name ? [customShape.name] : []),
    ...parts.map((part) => part?.name).filter(Boolean),
    ...extra,
  ];
  const coverage = evaluateObjectCoverage({
    requested,
    deliveredNames,
    deliveredPartCount: parts.length,
    deliveredObjects: units,
    // 单对象请求时整体名就是该对象的身份（多部分形状是一个对象的组成部分）
    overallName: customShape?.name ?? null,
  });
  return {
    ok: coverage.complete,
    missing: coverage.missing,
    deliveredNames,
    deliveredPartCount: parts.length,
    deliveredObjects: units,
    assignments: coverage.assignments,
    unverifiedCount: coverage.unverifiedCount,
  };
}
