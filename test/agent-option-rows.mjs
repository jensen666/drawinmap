/**
 * 引导选项展示判定（Node 直接运行，不依赖浏览器）。
 *
 * 覆盖：
 * - 当前待补引导与气泡内选项是同一组 → 气泡内不重复展示
 * - 追问之后已有用户消息 → 选项收起（回复输出中也不留）
 * - 引导状态丢失且问题未答 → 气泡内保留不可点记录
 * - 空选项、标签/取值不一致、用户消息在追问之前，都不误判
 *
 * 运行：node test/agent-option-rows.mjs
 */

import {
  guideQuestionAnswered,
  sameGuideOptions,
  shouldShowHistoryOptions,
} from '../web/src/agent/option-rows.js';

let failures = 0;

/** 断言工具：记录并通过/失败计数 */
function check(label, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) {
    failures += 1;
  }
  console.log(`[check] ${label} -> ${ok ? 'PASS' : `FAIL ${detail}`}`);
}

const OPTIONS = [
  { label: '地标甲', value: '地标甲' },
  { label: '地标乙', value: '地标乙' },
  { label: '当前视野中心', value: '__center__' },
];

const guideMessage = { id: 'agent-1', role: 'agent', options: OPTIONS };
const pending = { slot: 'place', options: OPTIONS.map((item) => ({ ...item })) };

check('同一组选项：顺序与标签取值一致', sameGuideOptions(OPTIONS, pending.options));
check('空数组不是同一组', sameGuideOptions([], []) === false);
check('null 不是同一组', sameGuideOptions(null, OPTIONS) === false);
check(
  '标签相同但取值不同不是同一组',
  sameGuideOptions(OPTIONS, [{ label: '地标甲', value: '地标甲' }, { label: '地标乙', value: '其他' }, OPTIONS[2]]) === false,
);
check(
  '少一项不是同一组',
  sameGuideOptions(OPTIONS, OPTIONS.slice(0, 2)) === false,
);

const beforeReply = [guideMessage];
check(
  '未回答：追问之后没有用户消息',
  guideQuestionAnswered(beforeReply, 'agent-1') === false,
);
check(
  '追问之前的用户消息不算已回答',
  guideQuestionAnswered(
    [{ id: 'user-0', role: 'user' }, guideMessage],
    'agent-1',
  ) === false,
);
check(
  '追问之后的智能体消息不算已回答',
  guideQuestionAnswered(
    [guideMessage, { id: 'agent-2', role: 'agent', text: '还在想' }],
    'agent-1',
  ) === false,
);
const afterReply = [
  guideMessage,
  { id: 'user-1', role: 'user', text: '当前视野中心' },
];
check('已回答：追问之后有用户消息', guideQuestionAnswered(afterReply, 'agent-1') === true);
check('消息不在列表里不算已回答', guideQuestionAnswered(afterReply, 'missing') === false);
check('消息列表不是数组不算已回答', guideQuestionAnswered(null, 'agent-1') === false);

check(
  '待补中：气泡内不重复画选项',
  shouldShowHistoryOptions({ message: guideMessage, messages: beforeReply, pendingGuide: pending }) === false,
);
check(
  '已点选、回复还在输出：气泡内选项收起',
  shouldShowHistoryOptions({ message: guideMessage, messages: afterReply, pendingGuide: null }) === false,
);
check(
  '已点选且待补状态还没清掉：仍然收起',
  shouldShowHistoryOptions({ message: guideMessage, messages: afterReply, pendingGuide: pending }) === false,
);
check(
  '引导状态丢失且未回答：气泡内保留不可点记录',
  shouldShowHistoryOptions({ message: guideMessage, messages: beforeReply, pendingGuide: null }) === true,
);
check(
  '另一组待补引导：这条未答追问仍保留不可点记录',
  shouldShowHistoryOptions({
    message: guideMessage,
    messages: beforeReply,
    pendingGuide: { slot: 'place', options: [{ label: '别的', value: '别的' }] },
  }) === true,
);
check(
  '没有选项的消息不展示历史芯片',
  shouldShowHistoryOptions({
    message: { id: 'agent-0', role: 'agent', text: '你好' },
    messages: [{ id: 'agent-0', role: 'agent', text: '你好' }],
    pendingGuide: pending,
  }) === false,
);
check(
  'options 为空数组不展示',
  shouldShowHistoryOptions({
    message: { id: 'agent-0', role: 'agent', options: [] },
    messages: [],
    pendingGuide: null,
  }) === false,
);
check(
  'pendingGuide 没有 options 字段、问题未答：保留不可点记录',
  shouldShowHistoryOptions({
    message: guideMessage,
    messages: beforeReply,
    pendingGuide: { slot: 'place' },
  }) === true,
);

console.log(failures === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${failures} checks)`);
process.exit(failures === 0 ? 0 : 2);
