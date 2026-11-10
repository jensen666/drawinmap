/**
 * 用户原文"疑似显式约束"检测（缺陷清单 2026-11-06 Bug 4.1）。
 *
 * 背景：userConstraints 由 LLM 从用户原文解析进 intent，是目标验收的否决项。
 * LLM 漏记时（2026-11-05 H06 实测：原文含"要奔跑的样子"，userConstraints=[]），
 * `summarizeConstraints` 在 required 为空时直接 ok——"没核对"被当成"通过"（fail-open），
 * 用户明确的要求被静默丢掉且验收认为通过。
 *
 * 本模块从 userText 独立检测"原文像提了约束"：意图漏解析时验收据此降级
 * （不给绿线），把"闸门是否存在"从"LLM 这一轮有没有解析出来"的抽奖里解耦。
 *
 * 口径：**精度优先于召回**。检测只是兜底信号，误报会让没有约束的请求被降级
 * （橙色参考版），因此触发词全部要求显式的"要求式表达"；尺寸请求（大一点/
 * 小一点）、绘图动词（我要画/画得像）必须排除。
 */

/** 否定式约束：不要/不能/不许/别把…。排除疑问/意图表达——"要不要画""能不能画"
 * 里的"不要/不能"不是约束（2026-11-07 复核实测误报）。 */
const NEGATIVE_PATTERN = /(?<!要)不要|(?<!能)不能|不许|不得(?!了)|别把|别画|别弄|千万别/;

/** 显式要求词：必须/一定要/得有/要有/务必要/切记。后接绘图动词时是意图表达
 * （"一定要画个大一点的心形"）而非约束，排除（2026-11-07 复核实测误报）。 */
const REQUIRE_PATTERN = /必须(?!画|绘|描|生成|规划|来看|来说)|一定要(?!画|绘|描|生成|规划|来看|来说|看到|见到)|务必要(?!画|绘|描|生成|规划)|切记|得有|要有/;

/** "X要Y"式约束：尾巴要翘、马要奔跑、要红色的。"要"前是普通汉字（且不是需要/
 * 必要/重要/主要/只要/关要的尾字）或子句开头（前面是标点/空白），"要"后不是
 * 绘图动词/量词/功能词/尺寸词——排除"我要画""要生成一个""要大一点"这类意图
 * 与尺寸表达。 */
const SUBJECT_REQUIRE_PATTERN = /(?:[\u4e00-\u9fff](?<![需必重主只关想])|[,，;；。！？\s])要(?![画绘描生成规划个只匹条头张群是说想去来求我你他她它大更几多一])[\u4e00-\u9fff]/;

/** "要…的样子/的模样"式表达："要奔跑的样子"。"的样子"单独出现只是普通描述
 * （"画个地标的样子"是目标本身不是可核对约束，2026-11-07 复核实测误报）——
 * 必须带"要/得/务必/必须"类要求前缀才触发；"的姿态/的姿势/的动作"信号强，
 * 保持独立触发（"站立的姿态"是真约束）。 */
const MANNER_PATTERN = /(?:要|得|务必|必须|一定要)[^，。！？；，\s]{0,8}的样子|(?:要|得)[^，。！？；，\s]{0,8}的模样|的姿态|的姿势|的动作/;

/**
 * 检测用户原文是否"疑似包含显式图形约束"。
 *
 * @param {string|null} userText 用户原文（原始请求文本，不是引导回答）
 * @returns {{suspected: boolean, cues: string[]}} suspected=疑似包含约束；cues 为
 *   命中的触发片段（去重，最多 3 条，供降级回复与日志引用）
 */
export function detectPossibleConstraintText(userText) {
  const text = typeof userText === 'string' ? userText : '';
  if (!text.trim()) {
    return { suspected: false, cues: [] };
  }
  const cues = [];
  const pushCue = (match) => {
    // 子句开头的"要"前面会带进标点，剪掉再入 cue
    const trimmed = typeof match === 'string' ? match.replace(/^[,，;；。！？\s]+/, '') : match;
    if (trimmed && !cues.includes(trimmed)) {
      cues.push(trimmed);
    }
  };
  const negative = text.match(NEGATIVE_PATTERN);
  if (negative) {
    pushCue(negative[0]);
  }
  const requireWord = text.match(REQUIRE_PATTERN);
  if (requireWord) {
    pushCue(requireWord[0]);
  }
  const subjectRequire = text.match(SUBJECT_REQUIRE_PATTERN);
  if (subjectRequire) {
    pushCue(subjectRequire[0]);
  }
  const manner = text.match(MANNER_PATTERN);
  if (manner) {
    pushCue(manner[0]);
  }
  return { suspected: cues.length > 0, cues: cues.slice(0, 3) };
}
