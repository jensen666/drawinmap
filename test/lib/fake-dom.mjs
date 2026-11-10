/**
 * 最小 fake DOM + 假定时器（UI 类测试共用底座，零依赖、不引入 jsdom）。
 *
 * 抽取自 `test/panel-toast.mjs`（清理方案 2026-11-09 §6.3 T-B3a 的测试基建重构）。
 * 设计约束：
 * 1. **innerHTML 读写一律抛错**——生产 UI 的既有纪律是"0 innerHTML、全 textContent"，
 *    这里把它变成 fake DOM 的硬约束：一旦被测模块回退到 innerHTML，测试立刻红，
 *    不需要额外断言。需要读取渲染文本时请走 `textContent`。
 * 2. 只实现被测模块真正用到的接口（`createElement` / classList / setAttribute /
 *    appendChild / insertBefore / remove 等），不做完整 DOM 模拟；新增能力按需补，
 *    补的时候在本文件集中维护，避免各测试各写一套 fake DOM。
 *
 * 用法：
 *   import { createFakeDocument, createFakeTimers } from './lib/fake-dom.mjs';
 *   const document = createFakeDocument();
 *   const timers = createFakeTimers();
 *   globalThis.document = document;
 *   globalThis.setTimeout = timers.setTimeoutFn;
 *   globalThis.clearTimeout = timers.clearTimeoutFn;
 *   const { createXxx } = await import('../web/src/...');  // 注入后再动态 import
 */

/** innerHTML 的抛错信息（统一文案，便于测试定位回退点） */
const INNER_HTML_ERROR = 'fake DOM 禁止使用 innerHTML：生产 UI 必须走 textContent（清理方案 §6.3 T-B3a）';

/**
 * 最小 fake 元素。
 *
 * `textContent` 语义对齐真实 DOM：
 * - 写入：清空子节点并保存文本；
 * - 读取：自身文本 + 子节点 textContent 拼接。
 */
class FakeElement {
  /**
   * @param {string} tag 标签名（如 'div' / 'section'）
   */
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.id = '';
    this.className = '';
    this.attributes = new Map();
    this.children = [];
    this.parent = null;
    this.offsetWidth = 0;
    /** 自身文本（不含子节点） */
    this._text = '';
    const classSet = () => new Set(String(this.className).split(/\s+/).filter(Boolean));
    this.classList = {
      add: (...names) => {
        const set = classSet();
        for (const name of names) set.add(name);
        this.className = [...set].join(' ');
      },
      remove: (...names) => {
        const set = classSet();
        for (const name of names) set.delete(name);
        this.className = [...set].join(' ');
      },
      contains: (name) => classSet().has(name),
      toggle: (name, force) => {
        const set = classSet();
        const shouldAdd = force === undefined ? !set.has(name) : Boolean(force);
        if (shouldAdd) set.add(name);
        else set.delete(name);
        this.className = [...set].join(' ');
        return shouldAdd;
      },
    };
  }

  /** 自身文本 + 子节点文本（真实 DOM textContent 语义） */
  get textContent() {
    return `${this._text}${this.children.map((child) => child.textContent ?? '').join('')}`;
  }

  set textContent(value) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this._text = value === null || value === undefined ? '' : String(value);
  }

  /** 禁止读取 innerHTML（反向断言：UI 必须走 textContent） */
  get innerHTML() {
    throw new Error(`${INNER_HTML_ERROR}（读 ${this.tagName}）`);
  }

  /** 禁止写入 innerHTML（反向断言：UI 必须走 textContent） */
  set innerHTML(_value) {
    throw new Error(`${INNER_HTML_ERROR}（写 ${this.tagName}）`);
  }

  /** 首个子节点（真实 DOM 语义） */
  get firstChild() {
    return this.children.length > 0 ? this.children[0] : null;
  }

  /** 子节点数组别名 */
  get childNodes() {
    return this.children;
  }

  /**
   * 设置属性。
   *
   * @param {string} name 属性名
   * @param {unknown} value 属性值（按真实 DOM 转字符串）
   */
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  /**
   * 读取属性。
   *
   * @param {string} name 属性名
   * @returns {string|null} 属性值
   */
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  /**
   * 是否有某属性。
   *
   * @param {string} name 属性名
   * @returns {boolean} 是否存在
   */
  hasAttribute(name) {
    return this.attributes.has(name);
  }

  /**
   * 移除属性。
   *
   * @param {string} name 属性名
   */
  removeAttribute(name) {
    this.attributes.delete(name);
  }

  /**
   * 在末尾追加子节点。
   *
   * @param {FakeElement} child 子节点
   * @returns {FakeElement} 被追加的节点
   */
  appendChild(child) {
    this.children.push(child);
    child.parent = this;
    return child;
  }

  /**
   * 在参考节点前插入子节点（参考节点不存在时退化为追加）。
   *
   * @param {FakeElement} child 子节点
   * @param {FakeElement|null} reference 参考节点
   * @returns {FakeElement} 被插入的节点
   */
  insertBefore(child, reference) {
    const index = reference ? this.children.indexOf(reference) : -1;
    if (index === -1) {
      this.children.push(child);
    } else {
      this.children.splice(index, 0, child);
    }
    child.parent = this;
    return child;
  }

  /**
   * 移除指定子节点。
   *
   * @param {FakeElement} child 子节点
   * @returns {FakeElement} 被移除的节点
   */
  removeChild(child) {
    this.children = this.children.filter((item) => item !== child);
    child.parent = null;
    return child;
  }

  /** 从父节点移除自身 */
  remove() {
    if (this.parent) {
      this.parent.removeChild(this);
    }
  }
}

/**
 * 创建 fake document（只提供 `createElement`，按需扩展）。
 *
 * @returns {{createElement: (tag: string) => FakeElement}} fake document
 */
export function createFakeDocument() {
  return {
    createElement: (tag) => new FakeElement(tag),
  };
}

/**
 * 创建假定时器：记录注册/清理，支持手动到点。
 *
 * @returns {{
 *   setTimeoutFn: (fn: Function, ms: number) => number,
 *   clearTimeoutFn: (id: number) => void,
 *   size: number,
 *   pending: Array<{id: number, ms: number}>,
 *   delays: () => Array<number>,
 *   flush: () => void
 * }} 假定时器
 */
export function createFakeTimers() {
  const scheduled = new Map();
  let seq = 0;
  return {
    setTimeoutFn: (fn, ms) => {
      seq += 1;
      scheduled.set(seq, { fn, ms });
      return seq;
    },
    clearTimeoutFn: (id) => {
      scheduled.delete(id);
    },
    get size() {
      return scheduled.size;
    },
    /** 在途定时器明细（id + 时长） */
    get pending() {
      return [...scheduled.entries()].map(([id, entry]) => ({ id, ms: entry.ms }));
    },
    /** 在途定时器时长列表（断言自定义时长用） */
    delays() {
      return [...scheduled.values()].map((entry) => entry.ms);
    },
    /** 触发全部到点回调（模拟时间流逝） */
    flush() {
      const entries = [...scheduled.values()];
      scheduled.clear();
      for (const entry of entries) entry.fn();
    },
  };
}
