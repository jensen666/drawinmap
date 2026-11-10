/**
 * 目标轮廓视觉质检闭环（生成 → 质检 → 修正 → 复检）。
 *
 * 背景（2026-10-27 实测取证）：LLM 一次生成的目标轮廓质量波动大——5 个剪影
 * 请求采样中 2 个自交被整图拒收（用户要小狗/猫，实际被静默换成内置推荐）、
 * 其余带"方波腿/细环尾/方塔耳"等机械病理；而评分只考核"路线贴不贴轮廓"，
 * 轮廓本身不像时照样高分交付（第 47/49/51 轮确认的"目标保真度"遗留层）。
 *
 * 本模块把"像不像"的判断提前到规划之前（方案 §8：目标语义验收先于正式路网
 * 规划与绿线交付），两段式（实测：带图长输出会触发端点 vision+长生成卡死，
 * 短输出 4.7s 正常；修正走纯文本 25s）：
 *   1) 视觉质检：轮廓渲染成小图（canvas）+ 用户原文（含参考图）→ 模型输出
 *      {verdict, seen, issues, constraints?} 短 JSON；verdict 必须明确为
 *      like/unlike——缺失或未知值一律记为 unknown，按"验收不可用"处理，
 *      不再 fail-open（方案 §8.1：只有 seen 文案看似合理但结论缺失或不明，
 *      不算通过）。
 *   2) 带反馈修正：verdict=unlike 时，把问题清单发回模型纯文本重生成一版点列，
 *      本地归一化校验通过才采纳；采纳后必须重新视觉复检（方案 §8.5：每次
 *      修正后的 T 都必须重新执行完整目标验收），复检不像/不可用时同样不得
 *      给合格绿线，只允许诊断性参考规划。
 *
 * 用户显式约束（userConstraints）逐项核对：verdict 消息要求模型对每条约束
 * 单独给出 pass/fail/unsure；不通过或必要项无法判定时不得给合格绿线（方案 §8.3）。
 * LLM 自行声明的 features（generatorGuides）不进入本清单——它们没有目标否决权。
 *
 * 渲染器与 LLM 调用全部注入：Node 无 document 自动跳过（renderOutline 返回
 * null），测试注入 fake 即可覆盖全部分支。
 */

import { normalizeCustomShape } from './intent.js';
import { freeformPointRuleText } from './point-budget.js';

/** 质检前至少剩余的预算（毫秒）：不够就不发起，避免挤占引擎搜索 */
const VERDICT_MIN_BUDGET_MS = 8000;
/** 修正前至少剩余的预算（毫秒）：修正需要完整生成一版点列 */
const REVISE_MIN_BUDGET_MS = 12000;
/** 复检前至少剩余的预算（毫秒）：复检是一轮短输出质检 */
const REREVIEW_MIN_BUDGET_MS = 8000;

/**
 * 目标验收结论对象的固定键集（B2：11 处返回分支统一由 outcomeOf 构造，键集不再
 * 手写漂移；测试 T-B2b 用它对全部返回分支做键集断言）。
 */
export const OUTCOME_KEYS = [
  'available',
  'verdict',
  'seen',
  'issues',
  'constraints',
  'constraintSummary',
  'adopted',
  'customShape',
  'attempts',
];


/**
 * 把归一化轮廓点绕原点旋转（方案 5.5：气泡点序列使用最终交付朝向）。
 * 与 planner.projectShape 使用同一旋转矩阵（x' = x·cosθ − y·sinθ，
 * y' = x·sinθ + y·cosθ）——同一刚体旋转保证气泡小图与地图紫色虚线朝向一致。
 *
 * @param {Array<[number, number]>} points 归一化轮廓点
 * @param {number} [rotationDeg] 旋转角度（度，缺省 0 = 原样返回）
 * @returns {Array<[number, number]>} 旋转后的点列
 */
export function rotateShapePoints(points, rotationDeg = 0) {
  const rotation = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  return points.map(([x, y]) => [x * cos - y * sin, x * sin + y * cos]);
}

/**
 * 把归一化轮廓画成小 PNG data URL（视觉质检输入）。
 * Node（无 document）返回 null——调用方据此跳过视觉质检。
 *
 * @param {object} customShape 归一化 customShape（outlinePoints + parts 范围）
 * @param {{size?: number, rotationDeg?: number}} [options] 画布边长（像素）与
 *   旋转角度（度；气泡点序列图传最终交付朝向，与地图紫线同一刚体旋转）
 * @returns {string|null} PNG data URL；环境不支持返回 null
 */
export function renderOutlineDataUrl(customShape, { size = 256, rotationDeg = 0 } = {}) {
  if (typeof document === 'undefined' || !customShape?.outlinePoints?.length) {
    return null;
  }
  const rings = [];
  const parts = customShape.parts || [];
  if (parts.length > 1) {
    for (const part of parts) {
      rings.push(customShape.outlinePoints.slice(part.outlineStart, part.outlineStart + part.outlineCount));
    }
  } else {
    rings.push(customShape.outlinePoints);
  }
  try {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return null;
    }
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    // 多部分共用同一归一化坐标系：整体定标（保持部分间相对位置）；
    // 旋转在定标前应用（与 projectShape 一致：先旋转后投影）
    const rotatedRings = rings.map((ring) => rotateShapePoints(ring, rotationDeg));
    const all = rotatedRings.flat();
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
    ctx.strokeStyle = '#5a28b4';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    for (const ring of rotatedRings) {
      ctx.beginPath();
      ring.forEach((point, i) => {
        const [px, py] = toPixel(point);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.closePath();
      ctx.stroke();
    }
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

/**
 * 质检消息（带图短输出）：只判像不像 + 问题清单 + 逐项约束核对，不输出点列。
 *
 * @param {object} options
 * @param {string} options.userText 用户原文
 * @param {string} options.shapeName LLM 命名的图形名
 * @param {string} options.outlineDataUrl 轮廓渲染图
 * @param {string|null} [options.referenceDataUrl] 用户上传的参考图（可选，帮助对照）
 * @param {string[]} [options.userConstraints] 用户显式约束清单（可选；逐项核对）
 * @returns {Array<object>} chat 消息
 */
export function verdictMessages({ userText, shapeName, outlineDataUrl, referenceDataUrl = null, userConstraints = [] }) {
  const images = [{ type: 'image_url', image_url: { url: outlineDataUrl } }];
  if (referenceDataUrl) {
    images.push({ type: 'image_url', image_url: { url: referenceDataUrl } });
  }
  const constraints = Array.isArray(userConstraints) ? userConstraints.filter((item) => typeof item === 'string' && item.trim()) : [];
  const constraintRule = constraints.length
    ? `\n用户显式提出了以下约束（必须逐项核对，不得合并、不得遗漏）：\n${constraints
        .map((item, index) => `${index + 1}. ${item}`)
        .join('\n')}\n输出 constraints 数组，每条对应 {"text":"约束原文","result":"pass|fail|unsure"}；任何一条不确定就写 unsure，不要猜。`
    : '';
  return [
    {
      role: 'system',
      content: `你是 DrawInMap 的目标轮廓质检员。附图是系统按用户描述生成的、要在真实路网上"用脚走出来"的图形轮廓（白底紫线，归一化坐标 [-0.5,0.5]，y 向上）。轮廓会被忠实贴合到街道，所以轮廓本身不像，路线就不像。
判断要点：整体比例是否真实（长宽比）、鲜明特征是否齐全且形态自然（有没有被画成机械的方齿/方塔/等宽梳齿、细环尾巴、自交交叉）。
verdict 必须明确给出 "like" 或 "unlike"：拿不准时给 unlike 并在 issues 里写清原因，绝不允许省略 verdict 字段或用其他词代替。${constraintRule}
只输出 JSON（不要输出点列）：{"verdict":"like|unlike","seen":"图中实际看到的东西（一句话）","issues":["问题1","问题2"]${constraints.length ? ',"constraints":[{"text":"约束原文","result":"pass|fail|unsure"}]' : ''}}`,
    },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `用户想画：${userText}（图形名：${shapeName || '未命名'}）。${referenceDataUrl ? '第二张图是用户给的参考。' : ''}请质检附图轮廓。`,
        },
        ...images,
      ],
    },
  ];
}

/**
 * 修正消息（纯文本长输出）：带质检问题/校验失败原因重生成一版完整点列。
 *
 * 生成要求与 prompt.js 的自由轮廓原则一致（方案 §3）：目标点列按剪影画，路网的
 * 12% 特征尺度只留在贴路逻辑，不再写进修正提示；点数按 LLM 声明特征（features
 * 里的 declared）分档——复杂剪影（声明特征不少于 3 个）80~120 点、简单图形
 * 8~20 点；**与验收点数闸门同源**（point-budget.js，多部分按部分数放宽上限）。
 *
 * @param {object} options
 * @param {string} options.userText 用户原文
 * @param {string} options.shapeName 原图形名
 * @param {string[]} options.feedback 修正依据（质检问题清单或校验失败原因）
 * @param {string} [options.extra] 附加要求（如"上一版因自交被拒收"）
 * @param {string[]} [options.userConstraints] 用户显式约束（修正版必须保留）
 * @returns {Array<object>} chat 消息
 */
export function reviseMessages({ userText, shapeName, feedback, extra = '', userConstraints = [], mode = 'full' }) {
  const constraints = Array.isArray(userConstraints) ? userConstraints.filter((item) => typeof item === 'string' && item.trim()) : [];
  const constraintLine = constraints.length
    ? `\n用户显式约束（新版必须完整保留，缺一即不合格）：\n${constraints.map((item) => `- ${item}`).join('\n')}`
    : '';
  // 低上下文/局部修复模式（方案 2026-11-08 §5.3 的独立 A/B 实验项）：
  // 只要求重画被指出的问题所在的部分，其余部分沿用原样——上下文更小、推理更省。
  const local = mode === 'local';
  return [
    {
      role: 'system',
      content: local
        ? `你是 DrawInMap 的图形轮廓局部修复器。质检指出的问题只涉及轮廓的某一部分。` +
          `只重画需要修的那一部分（其余部分保持原样），并输出**完整**的轮廓 JSON：` +
          `{"name":"图形名","features":[{"name":"特征名","points":[[x,y]]}],"parts":[{"name":"部分名","features":[...],"points":[[x,y],...]}]} 或 ` +
          `{"name":"图形名","features":[...],"points":[[x,y],...]}。归一化坐标 [-0.5,0.5]，y 向上，闭环。`
        : `你为 DrawInMap 生成"用脚在真实路网上走出来的图形轮廓"点列。归一化坐标 [-0.5,0.5]，y 向上，按轮廓顺序采样，首尾自动闭合；分离部分（群岛等）用 parts 数组、共用同一坐标系。
生成原则：复杂剪影先列鲜明特征（3~8 个，写入 features）再描轮廓，简单图形不要硬凑 features（0~2 个或省略）；真实长宽比；四肢/重复部位要有粗细与方向变化，禁止画成等宽矩形梳齿或方波；细长往返结构（细尾巴/细脖子/细凸出）禁止细环，改画短粗形状；点数由图形复杂度决定：${freeformPointRuleText()}。`,
    },
    {
      role: 'user',
      content: `用户想画：${userText}（图形名：${shapeName || '未命名'}）。${constraintLine}
${extra ? extra + '\n' : ''}必须修正的问题：
${feedback.map((item) => `- ${item}`).join('\n')}

请生成一版明显更像、且拓扑合法（不自交、不退化）的完整轮廓。只输出 JSON：{"name":"图形名","features":[{"name":"特征名","points":[[x,y]]}],"points":[[x,y],...]}`,
    },
  ];
}

/**
 * 从模型返回里严格取出质检结论（方案 §8.1：取消 fail-open）。
 * verdict 缺失、非 like/unlike 一律记为 unknown → 验收不可用，不得给合格绿线。
 *
 * @param {object} raw 模型返回的 JSON 对象
 * @param {number} [expectedConstraintCount] 要求逐项核对的约束条数（0 = 不要求）
 * @returns {{
 *   verdict: 'like'|'unlike'|'unknown',
 *   seen: string,
 *   issues: string[],
 *   constraints: Array<{text: string, result: string}>|null
 * }} 结论；constraints 为 null 表示要求核对但模型未返回逐项结果
 */
export function parseVerdict(raw, expectedConstraintCount = 0) {
  const verdict = raw?.verdict === 'unlike' ? 'unlike' : raw?.verdict === 'like' ? 'like' : 'unknown';
  const seen = typeof raw?.seen === 'string' ? raw.seen : '';
  const issues = Array.isArray(raw?.issues)
    ? raw.issues.filter((item) => typeof item === 'string' && item.trim()).slice(0, 6)
    : [];
  let constraints = null;
  if (expectedConstraintCount > 0) {
    if (Array.isArray(raw?.constraints)) {
      constraints = raw.constraints
        .filter((item) => item && typeof item === 'object' && typeof item.text === 'string')
        .map((item) => ({
          text: item.text.trim().slice(0, 40),
          result: item.result === 'pass' ? 'pass' : item.result === 'fail' ? 'fail' : 'unsure',
        }))
        .slice(0, 8);
      if (constraints.length === 0) {
        constraints = null;
      }
    }
  }
  return { verdict, seen, issues, constraints };
}

/**
 * 汇总约束逐项结论：全部 pass 才算通过；任一 fail/unsure 或缺失结果都算未通过。
 *
 * @param {Array<{text: string, result: string}>|null} constraints 逐项结论
 * @param {string[]} userConstraints 用户显式约束清单
 * @returns {{ok: boolean, unavailable: boolean, failed: string[]}} unavailable=true 表示
 *   必要项无法判定（模型未返回逐项结果）；failed 为不通过/未判定的约束原文
 */
export function summarizeConstraints(constraints, userConstraints) {
  const required = (userConstraints || []).filter((item) => typeof item === 'string' && item.trim());
  if (required.length === 0) {
    return { ok: true, unavailable: false, failed: [] };
  }
  if (!constraints || constraints.length === 0) {
    return { ok: false, unavailable: true, failed: required };
  }
  const failed = [];
  for (const item of required) {
    const match = constraints.find((entry) => entry.text === item) || constraints.find((entry) => item.includes(entry.text) || entry.text.includes(item));
    if (!match || match.result !== 'pass') {
      failed.push(item);
    }
  }
  return { ok: failed.length === 0, unavailable: false, failed };
}

/**
 * 执行一次目标轮廓质检闭环（质检 → 按需修正 → 复检）。
 *
 * 可用性语义（方案 §8.5）：available=false 表示"必要语义验收不可用/结论不明/
 * 未完成"，调用方不得据此给合格绿线，只能诊断性参考规划或诚实失败。
 *
 * @param {object} options
 * @param {string} options.userText 用户原文
 * @param {object} options.customShape 归一化后的 customShape（第一版）
 * @param {string|null} [options.referenceDataUrl] 用户参考图
 * @param {string[]} [options.userConstraints] 用户显式约束（逐项核对）
 * @param {(messages: Array<object>, options?: {phase: 'verdict'|'revision'|'re-review'}) => Promise<object>} options.callLlm
 *   LLM 调用（返回解析后的 JSON）；第二参数带阶段：'verdict' 初检、'revision' 修正、
 *   're-review' 复检——调用方可据此给修正请求传 retries=0 与独立超时（方案 §3），
 *   旧注入函数只声明 messages 时忽略第二参数即可
 * @param {(customShape: object, options?: object) => string|null} options.renderOutline 轮廓渲染
 * @param {number} [options.deadlineAt] 本环节截止时间戳（performance.now() 口径）
 * @param {() => number} [options.now] 时钟（测试注入）
 * @param {(event: object) => void} [options.onEvent] 日志回调
 * @param {(step: object) => void} [options.onProgress] 推理过程回调
 * @param {boolean} [options.allowRevision] 是否允许"按质检反馈重生成轮廓"（默认 true）。
 *   false = 只质检不修正：素材/内置图形的 T 不能由模型重新生成（改了就不是那个素材了），
 *   这类来源只借质检能力**核对用户显式约束**（方案 2026-11-08 §4.1）。
 * @returns {Promise<object>} {available, verdict, seen, issues, constraints,
 *   constraintSummary, adopted, customShape, attempts, skipped?}
 *   attempts 记录每版 T 的结论（version 从 1 起；修正版复检为 version 2）
 */
export async function reviewTargetShape({
  userText,
  customShape,
  referenceDataUrl = null,
  userConstraints = [],
  callLlm,
  renderOutline,
  deadlineAt = null,
  now = () => performance.now(),
  onEvent = null,
  onProgress = null,
  allowRevision = true,
  recoveryMode = 'full',
}) {
  /** 每版 T 的质检结论（含复检），供 trace 与目标版本记录 */
  const attempts = [];
  const constraintCount = (userConstraints || []).filter((item) => typeof item === 'string' && item.trim()).length;
  /**
   * 构造统一的目标验收结论对象（固定键集 OUTCOME_KEYS，防 11 处手写对象漂移）。
   * 默认从某一版质检结论（first/second）取值，并按其约束清单算 constraintSummary；
   * 分支差异（available/issues/adopted/customShape/skipped 等）走 overrides 覆盖或追加。
   * @param {{verdict: string, seen: string, issues: Array, constraints: Array|null}} verdictLike 质检结论
   * @param {object} [overrides] 覆盖或追加字段
   * @returns {object} {available, verdict, seen, issues, constraints, constraintSummary,
   *   adopted, customShape, attempts} + 分支附加字段
   */
  const outcomeOf = (verdictLike, overrides = {}) => ({
    available: true,
    verdict: verdictLike.verdict,
    seen: verdictLike.seen,
    issues: verdictLike.issues,
    constraints: verdictLike.constraints,
    constraintSummary: summarizeConstraints(verdictLike.constraints, userConstraints),
    adopted: false,
    customShape: null,
    attempts,
    ...overrides,
  });

  if (typeof callLlm !== 'function' || typeof renderOutline !== 'function') {
    return { available: false, verdict: 'unknown', attempts, skipped: 'not-available' };
  }
  if (typeof deadlineAt === 'number' && now() > deadlineAt - VERDICT_MIN_BUDGET_MS) {
    onEvent?.({ skipped: 'deadline', phase: 'verdict' });
    return { available: false, verdict: 'unknown', attempts, skipped: 'deadline' };
  }
  const outlineDataUrl = renderOutline(customShape);
  if (!outlineDataUrl) {
    onEvent?.({ skipped: 'no-render', phase: 'verdict' });
    return { available: false, verdict: 'unknown', attempts, skipped: 'no-render' };
  }

  /** 跑一轮质检（带图短输出） */
  const runVerdictRound = async (shape, phase) => {
    const startedAt = now();
    let raw;
    try {
      // 阶段参数（方案 §3 接口约定）：'verdict' 初检 / 're-review' 复检；
      // 调用方按阶段决定重试与超时（修正阶段要求 retries=0、180 秒截止即停）
      raw = await callLlm(
        verdictMessages({ userText, shapeName: shape.name, outlineDataUrl: renderOutline(shape), referenceDataUrl, userConstraints }),
        { phase },
      );
    } catch (error) {
      // 用户点"停止"：中止必须上抛，不能被当成"质检调用失败"继续跑诊断规划链路
      if (error?.name === 'AbortError' || error?.kind === 'aborted' || error?.aborted === true) {
        throw error;
      }
      onEvent?.({
        skipped: 'llm-error',
        phase,
        kind: error?.kind ?? 'unknown',
        message: error?.message,
      });
      return {
        verdict: 'unknown',
        seen: '',
        issues: [],
        constraints: null,
        skipped: 'llm-error',
        failureKind: error?.kind ?? 'unknown',
        failureMessage: error?.message ?? String(error),
      };
    }
    const parsed = parseVerdict(raw, constraintCount);
    onEvent?.({
      phase,
      verdict: parsed.verdict,
      seen: parsed.seen,
      issues: parsed.issues,
      constraints: parsed.constraints,
      durationMs: Math.round(now() - startedAt),
    });
    return parsed;
  };

  onProgress?.({ text: '自检目标轮廓…', kind: 'step' });
  const first = await runVerdictRound(customShape, 'verdict');
  attempts.push({ version: 1, verdict: first.verdict, seen: first.seen, issues: first.issues, constraints: first.constraints });

  if (first.verdict === 'unknown') {
    onProgress?.({ text: first.skipped === 'llm-error' ? '轮廓自检不可用（质检调用失败），按未验收处理' : '轮廓自检没有给出明确结论，按未验收处理', kind: 'step' });
    return outcomeOf(first, {
      available: false,
      skipped: first.skipped || 'unknown-verdict',
    });
  }

  const constraintSummary = summarizeConstraints(first.constraints, userConstraints);
  if (first.verdict === 'like') {
    onProgress?.({
      text: `轮廓自检：像${first.seen ? `（看着是${first.seen}）` : ''}${
        !constraintSummary.ok ? `，但用户约束未全部确认` : ''
      }`,
      kind: 'step',
    });
    if (!constraintSummary.ok) {
      // 整体像但约束未全过/未判定：合取不通过（方案 §8.1 自由轮廓合格判定）
      return outcomeOf(first, { constraintFailed: true });
    }
    return outcomeOf(first);
  }

  // verdict=unlike：整体不像，或像但约束未全过 → 都需要修正
  const reviseIssues = [...first.issues];
  if (!constraintSummary.ok) {
    reviseIssues.push(
      constraintSummary.unavailable
        ? '质检没有逐项核对用户约束，请在新版中保留全部约束特征'
        : `用户约束未满足：${constraintSummary.failed.join('、')}`,
    );
  }
  // 只质检不修正的来源（素材/内置图形）：T 不能由模型重新生成，按质检结论如实裁决。
  // 不通过 → fail/unavailable（不得绿线），由编排层降级为橙色参考或诚实失败。
  if (!allowRevision) {
    onEvent?.({ phase: 'verdict', revisionSkipped: 'not-allowed' });
    if (first.verdict === 'like' && constraintSummary.ok) {
      return outcomeOf(first);
    }
    return outcomeOf(first, {
      available: first.verdict !== 'unknown',
      issues: reviseIssues,
      constraintFailed: first.verdict === 'like' && !constraintSummary.ok,
    });
  }
  if (reviseIssues.length === 0) {
    // 判"不像"却没说问题：无从修正，保留原版
    onEvent?.({ skipped: 'no-issues', phase: 'revision' });
    onProgress?.({ text: '轮廓自检：不像（未说明问题），按原轮廓继续', kind: 'step' });
    return outcomeOf(first, { issues: [] });
  }
  if (typeof deadlineAt === 'number' && now() > deadlineAt - REVISE_MIN_BUDGET_MS) {
    onEvent?.({ skipped: 'deadline', phase: 'revision' });
    onProgress?.({ text: `轮廓自检：不像（${reviseIssues[0]}），但本轮时间不够重生成，按原轮廓继续`, kind: 'step' });
    return outcomeOf(first, { issues: reviseIssues });
  }

  onProgress?.({ text: `轮廓自检：不像（${reviseIssues.slice(0, 2).join('；')}）→ 按问题重生成…`, kind: 'step' });
  const reviseStartedAt = now();
  let revisedRaw;
  try {
    // 修正阶段只发一次：phase='revision' 供调用方传 retries=0 / 180 秒超时，
    // 本函数不会在修正失败后自动再发第二次
    revisedRaw = await callLlm(
      reviseMessages({ userText, shapeName: customShape.name, feedback: reviseIssues, userConstraints, mode: recoveryMode }),
      { phase: 'revision' },
    );
  } catch (error) {
    // 失败原因分类要留痕：截断（推理预算耗尽）与普通调用失败不是一回事
    // （方案 2026-11-08 §5.2：截断必须给不同的结构化原因）
    onEvent?.({
      skipped: 'llm-error',
      phase: 'revision',
      kind: error?.kind ?? 'unknown',
      message: error?.message,
    });
    return outcomeOf(first, {
      issues: reviseIssues,
      skipped: 'llm-error',
      failureKind: error?.kind ?? 'unknown',
      failureMessage: error?.message ?? String(error),
      terminatedWith: error?.kind === 'truncated' ? 'revision-truncated' : 'revision-failed',
    });
  }
  const revisedShape = normalizeCustomShape(
    revisedRaw,
    (reason) => onEvent?.({ skipped: 'invalid-revision', phase: 'revision', reason }),
  );
  if (!revisedShape) {
    onProgress?.({ text: '重生成的轮廓仍不合法，保留原轮廓继续', kind: 'step' });
    return outcomeOf(first, { issues: reviseIssues });
  }
  onEvent?.({
    phase: 'revision',
    adopted: true,
    pointCount: revisedShape.outlinePoints.length,
    durationMs: Math.round(now() - reviseStartedAt),
  });
  onProgress?.({ text: `轮廓已按自检问题重生成（${revisedShape.outlinePoints.length} 点）→ 复检…`, kind: 'step' });

  // 修正版必须重新执行完整目标验收（复检），未复检/复检不可用都不得给合格绿线
  //（方案 §8.5 修正版复检）
  if (typeof deadlineAt === 'number' && now() > deadlineAt - REREVIEW_MIN_BUDGET_MS) {
    onEvent?.({ skipped: 'deadline', phase: 're-review' });
    onProgress?.({ text: '本轮时间不够复检修正版，按未验收处理', kind: 'step' });
    attempts.push({ version: 2, verdict: 'unknown', seen: '', issues: [], skipped: 'deadline' });
    return outcomeOf(first, {
      available: false,
      verdict: 'unknown',
      issues: reviseIssues,
      adopted: true,
      customShape: revisedShape,
      reReviewSkipped: 'deadline',
    });
  }
  const second = await runVerdictRound(revisedShape, 're-review');
  attempts.push({ version: 2, verdict: second.verdict, seen: second.seen, issues: second.issues, constraints: second.constraints });
  const secondConstraintSummary = summarizeConstraints(second.constraints, userConstraints);
  const qualified = second.verdict === 'like' && secondConstraintSummary.ok;
  onProgress?.({
    text: qualified
      ? `修正版复检通过${second.seen ? `（看着是${second.seen}）` : ''}`
      : `修正版复检未通过（${second.verdict === 'like' ? '约束未全部确认' : second.issues[0] || '仍不像'}），不得正式交付`,
    kind: 'step',
  });
  return outcomeOf(second, {
    available: second.verdict !== 'unknown',
    constraintSummary: secondConstraintSummary,
    adopted: true,
    customShape: revisedShape,
    constraintFailed: second.verdict === 'like' && !secondConstraintSummary.ok,
  });
}

/**
 * 只质检、不修正的约束核验（方案 2026-11-08 §4.1）。
 *
 * 用于**目标不可由模型重新生成**的来源：参考图素材、内置图形、图像描摹。
 * 这些来源无法"按反馈重生成"，但仍可借视觉质检能力逐项核对用户显式约束——
 * 核验不了就不给绿线（保持橙色参考或诚实失败），不得假装已验收。
 *
 * @param {object} options 与 reviewTargetShape 同参
 * @returns {Promise<object>} 质检结论（结构同 reviewTargetShape，adopted 恒为 false）
 */
export async function verifyConstraintsByReview(options) {
  return reviewTargetShape({ ...options, allowRevision: false });
}
