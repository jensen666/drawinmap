/**
 * 剪贴板写入分支测试（Node 直接运行，注入 fake clipboard/document，不依赖浏览器）。
 *
 * 覆盖：
 * - 优先异步 Clipboard API，成功即返回且不触碰降级路径；
 * - API 被拒/不可用时降级 execCommand('copy')，临时 textarea 必须清理；
 * - 两条路径都失败、execCommand 抛错、空文本/非字符串 → 返回 false 不抛错。
 *
 * 运行：node test/clipboard.mjs
 */

import { copyText } from '../web/src/clipboard.js';

let failures = 0;
let checks = 0;

/**
 * 断言工具：失败计入退出码。
 *
 * @param {string} label 断言描述
 * @param {boolean} condition 断言条件
 * @param {string} [detail] 失败详情
 */
function check(label, condition, detail = '') {
  checks += 1;
  const ok = Boolean(condition);
  if (!ok) {
    failures += 1;
  }
  console.log(`[check] ${label} -> ${ok ? 'PASS' : `FAIL ${detail}`}`);
}

/**
 * 构造可断言的 fake document（记录创建/执行/清理）。
 *
 * @param {{execResult?: boolean, execThrows?: boolean}} [options]
 * @returns {object} fake document
 */
function createFakeDoc({ execResult = true, execThrows = false } = {}) {
  const doc = {
    created: [],
    execCalls: [],
    body: {
      children: [],
      appendChild(node) {
        node.parentNode = this;
        this.children.push(node);
      },
      removeChild(node) {
        const index = this.children.indexOf(node);
        if (index >= 0) {
          this.children.splice(index, 1);
        }
        node.parentNode = null;
      },
    },
    createElement(tagName) {
      const el = {
        tagName,
        value: '',
        attrs: {},
        style: {},
        parentNode: null,
        selectCalls: 0,
        setAttribute(name, value) {
          this.attrs[name] = value;
        },
        select() {
          this.selectCalls += 1;
        },
      };
      doc.created.push(el);
      return el;
    },
    execCommand(command) {
      doc.execCalls.push(command);
      if (execThrows) {
        throw new Error('execCommand failed');
      }
      return execResult;
    },
  };
  return doc;
}

// ---------- 1) Clipboard API 成功：直接返回，不进入降级 ----------
{
  const writeCalls = [];
  const clipboard = {
    writeText: async (text) => {
      writeCalls.push(text);
    },
  };
  const doc = createFakeDoc();
  check('API 成功：返回 true', (await copyText('t-abc123', { clipboard, doc })) === true);
  check('API 成功：写入完整文本', writeCalls.length === 1 && writeCalls[0] === 't-abc123');
  check('API 成功：不触碰 document 降级路径', doc.created.length === 0 && doc.execCalls.length === 0);
}

// ---------- 2) API 被拒 → 降级 execCommand 成功，临时节点清理 ----------
{
  const clipboard = {
    writeText: async () => {
      throw new Error('NotAllowedError');
    },
  };
  const doc = createFakeDoc({ execResult: true });
  check('API 被拒：降级成功返回 true', (await copyText('t-fallback', { clipboard, doc })) === true);
  check('降级：调用 execCommand(copy)', doc.execCalls.length === 1 && doc.execCalls[0] === 'copy');
  check('降级：textarea 带完整文本且只读', doc.created[0]?.value === 't-fallback' && doc.created[0]?.attrs.readonly === '');
  check('降级：选中输入框', doc.created[0]?.selectCalls === 1);
  check('降级：临时节点已从 body 移除', doc.body.children.length === 0 && doc.created[0]?.parentNode === null);
}

// ---------- 3) 两条路径都失败 → false，临时节点同样清理 ----------
{
  const clipboard = {
    writeText: async () => {
      throw new Error('NotAllowedError');
    },
  };
  const doc = createFakeDoc({ execResult: false });
  check('两条路径都失败：返回 false', (await copyText('t-fail', { clipboard, doc })) === false);
  check('失败也清理临时节点', doc.body.children.length === 0);
}

// ---------- 4) execCommand 抛错 → false 且不残留节点 ----------
{
  const doc = createFakeDoc({ execThrows: true });
  check('execCommand 抛错：返回 false', (await copyText('t-throw', { clipboard: null, doc })) === false);
  check('抛错后临时节点已清理', doc.body.children.length === 0 && doc.created[0]?.parentNode === null);
}

// ---------- 5) 空文本/非字符串：直接 false，不调用任何复制通道 ----------
{
  const writeCalls = [];
  const clipboard = {
    writeText: async (text) => {
      writeCalls.push(text);
    },
  };
  check('空文本：返回 false', (await copyText('', { clipboard, doc: null })) === false);
  check('空文本：不调用 clipboard', writeCalls.length === 0);
  check('非字符串：返回 false', (await copyText(null, { clipboard, doc: null })) === false);
  check('非字符串：不调用 clipboard', writeCalls.length === 0);
}

// ---------- 6) 无 clipboard 且无 document → false ----------
check('无可用通道：返回 false', (await copyText('t-none', { clipboard: null, doc: null })) === false);

// ---------- 7) clipboard 对象存在但没有 writeText → 直接降级 ----------
{
  const doc = createFakeDoc({ execResult: true });
  check('无 writeText：降级成功', (await copyText('t-legacy', { clipboard: {}, doc })) === true);
  check('无 writeText：仍清理临时节点', doc.body.children.length === 0);
}

console.log(`\n[summary] ${checks - failures}/${checks} 项通过，失败 ${failures} 项`);
if (failures > 0) {
  process.exitCode = 1;
}
