/**
 * 面板轻提示（toast）状态机测试（Node 直接运行，零依赖 fake DOM + 假定时器）。
 *
 * 背景（交互修正 2026-11-09）：点选比例尺卡片改为就地切换，反馈用面板轻提示，
 * 不进入会话消息。toast.js 负责"显示—自动消失—连续触发重置计时—销毁"，
 * 本文件用最小 fake DOM 验证这些行为，不引入 jsdom。
 *
 * fake DOM / 假定时器已抽到 `test/lib/fake-dom.mjs` 共用（清理方案 §6.3 T-B3a）：
 * 该 lib 的 innerHTML 读写会抛错，反向保证生产 UI 全走 textContent。
 *
 * 运行：node test/panel-toast.mjs
 */

import { createFakeDocument, createFakeTimers } from './lib/fake-dom.mjs';

const fakeDocument = createFakeDocument();
const fakeTimers = createFakeTimers();
globalThis.document = fakeDocument;
globalThis.setTimeout = fakeTimers.setTimeoutFn;
globalThis.clearTimeout = fakeTimers.clearTimeoutFn;

const { createPanelToast } = await import('../web/src/agent/toast.js');

let failures = 0;
let checks = 0;

function check(label, condition, detail = '') {
  checks += 1;
  const ok = Boolean(condition);
  if (!ok) {
    failures += 1;
  }
  console.log(`[check] ${label} -> ${ok ? 'PASS' : `FAIL ${detail}`}`);
}

// ---------- 场景 1：挂载与无障碍属性 ----------
{
  const host = fakeDocument.createElement('section');
  const toast = createPanelToast(host);
  check('挂载：宿主内出现 .agent-toast', host.children.length === 1 && host.children[0] === toast.element);
  check('挂载：默认不显示（无 is-visible）', !toast.element.classList.contains('is-visible'), toast.element.className);
  check('无障碍：role=status', toast.element.getAttribute('role') === 'status', toast.element.getAttribute('role'));
  check('无障碍：aria-live=polite', toast.element.getAttribute('aria-live') === 'polite', toast.element.getAttribute('aria-live'));

  // ---------- 场景 2：显示 → 自动消失 ----------
  toast.show('已切换到 1.5 km 版 · 路线贴合 65');
  check('显示：文本写入', toast.element.textContent === '已切换到 1.5 km 版 · 路线贴合 65', toast.element.textContent);
  check('显示：is-visible 生效', toast.element.classList.contains('is-visible'), toast.element.className);
  check('显示：默认 info 类型', toast.element.classList.contains('is-info'), toast.element.className);
  check('显示：注册一个自动消失计时器', fakeTimers.size === 1, String(fakeTimers.size));
  fakeTimers.flush();
  check('自动消失：is-visible 移除', !toast.element.classList.contains('is-visible'), toast.element.className);
  check('自动消失：文本保留（便于 E2E/无障碍读取）', toast.element.textContent === '已切换到 1.5 km 版 · 路线贴合 65', toast.element.textContent);

  // ---------- 场景 3：连续触发只保留一条计时、文本更新 ----------
  toast.show('已切换到 2.4 km 版');
  toast.show('已切换到 3.6 km 版');
  check('连续触发：计时器不叠加', fakeTimers.size === 1, String(fakeTimers.size));
  check('连续触发：文本为最新一条', toast.element.textContent === '已切换到 3.6 km 版', toast.element.textContent);
  fakeTimers.flush();
  check('连续触发：到点后隐藏', !toast.element.classList.contains('is-visible'), toast.element.className);

  // ---------- 场景 4：类型样式与空文本 ----------
  toast.show('那一版复核没有过交付标准，保持当前版不变。', { kind: 'warn' });
  check('类型：warn 样式', toast.element.classList.contains('is-warn') && !toast.element.classList.contains('is-info'), toast.element.className);
  toast.show('候选已失效', { kind: 'error' });
  check('类型：error 样式并清掉旧类型', toast.element.classList.contains('is-error') && !toast.element.classList.contains('is-warn'), toast.element.className);
  toast.show('未知类型按 info', { kind: 'bogus' });
  check('类型：未列出类型回退 info', toast.element.classList.contains('is-info'), toast.element.className);
  const textBefore = toast.element.textContent;
  toast.show('');
  check('空文本：忽略、不清空已有提示', toast.element.textContent === textBefore, toast.element.textContent);

  // ---------- 场景 5：hide 与 dispose ----------
  toast.show('已切换到 1.5 km 版');
  toast.hide();
  check('hide：立即隐藏并清计时', !toast.element.classList.contains('is-visible') && fakeTimers.size === 0, `${toast.element.className} timers=${fakeTimers.size}`);
  toast.show('再次显示');
  check('hide 后仍可显示', toast.element.classList.contains('is-visible'), toast.element.className);
  toast.dispose();
  check('dispose：从宿主移除', host.children.length === 0, String(host.children.length));
  check('dispose：清理计时器', fakeTimers.size === 0, String(fakeTimers.size));

  // ---------- 场景 6：自定义消失时长 ----------
  const host2 = fakeDocument.createElement('section');
  const custom = createPanelToast(host2, { durationMs: 500 });
  custom.show('短提示');
  check(
    '自定义时长：注册 500ms',
    fakeTimers.size === 1 && fakeTimers.delays()[0] === 500,
    `timers=${fakeTimers.size} delays=${JSON.stringify(fakeTimers.delays())}`,
  );
  fakeTimers.flush();
  check('自定义时长：到点隐藏', !custom.element.classList.contains('is-visible'), custom.element.className);
  custom.dispose();
}

// ---------- 场景 8：fake DOM / 假定时器底座自检（test/lib/fake-dom.mjs 复用能力） ----------
{
  const element = fakeDocument.createElement('div');
  element.textContent = '纯文本';
  let innerHtmlThrew = 0;
  try {
    void element.innerHTML;
  } catch {
    innerHtmlThrew += 1;
  }
  try {
    element.innerHTML = '<b>x</b>';
  } catch {
    innerHtmlThrew += 1;
  }
  check(
    'fake DOM：innerHTML 读写均抛错（反向断言全 textContent）',
    innerHtmlThrew === 2,
    `threw=${innerHtmlThrew}`,
  );

  const child = fakeDocument.createElement('span');
  child.textContent = '子';
  element.appendChild(child);
  check('fake DOM：textContent 读取拼接子节点', element.textContent === '纯文本子', element.textContent);
  check(
    'fake DOM：appendChild 建立父子关系',
    child.parent === element && element.children.length === 1 && element.firstChild === child,
    `parent=${child.parent === element} children=${element.children.length}`,
  );

  const timers = createFakeTimers();
  const timerId = timers.setTimeoutFn(() => {}, 42);
  check(
    '假定时器：记录时长与在途明细',
    timers.size === 1 && timers.delays()[0] === 42 && timers.pending[0].id === timerId,
    JSON.stringify(timers.pending),
  );
  timers.clearTimeoutFn(timerId);
  check('假定时器：clear 后在途归零', timers.size === 0 && timers.pending.length === 0);
}

// ---------- 场景 7：缺宿主直接报错（不静默失败） ----------
{
  let threw = null;
  try {
    createPanelToast(null);
  } catch (error) {
    threw = error;
  }
  check('缺宿主：抛错并说明原因', threw instanceof Error && threw.message.includes('挂载容器'), threw ? threw.message : '未抛错');
}

console.log(`\n[summary] ${checks - failures}/${checks} 项通过，失败 ${failures} 项`);
if (failures > 0) {
  process.exitCode = 1;
}
