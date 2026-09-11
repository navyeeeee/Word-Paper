/**
 * 极简 DOM / 定时器桩，用于在 Node 中无头运行 script.js。
 *
 * 目的：为「游戏模式时序 bug」提供可复现、可留仓的回归测试。
 * 只实现 script.js 实际用到的那一小撮 DOM API，不做通用实现。
 *
 * 时间由虚拟时钟驱动：advance(ms) 以 16ms 为步长推进，
 * 每个 tick 先触发到期 setTimeout，再触发待执行的 requestAnimationFrame。
 */
'use strict';

/* ---------------- 虚拟时钟 ---------------- */
var clock = { now: 0 };
var seq = 0;
var timers = new Map();
var rafs = new Map();

function fakeSetTimeout(fn, ms) {
  var id = ++seq;
  timers.set(id, { time: clock.now + (Number(ms) || 0), fn: fn });
  return id;
}
function fakeClearTimeout(id) { timers.delete(id); }
function fakeRaf(fn) {
  var id = ++seq;
  rafs.set(id, fn);
  return id;
}
function fakeCancelRaf(id) { rafs.delete(id); }

/** 推进虚拟时间；每 16ms 一个 tick，模拟 60fps */
function advance(ms) {
  var steps = Math.ceil(ms / 16);
  for (var i = 0; i < steps; i++) {
    clock.now += 16;
    var due = [];
    timers.forEach(function (t, id) { if (t.time <= clock.now) due.push(id); });
    due.sort(function (a, b) { return timers.get(a).time - timers.get(b).time; });
    due.forEach(function (id) {
      var t = timers.get(id);
      if (t) { timers.delete(id); t.fn(); }
    });
    var batch = [];
    rafs.forEach(function (fn) { batch.push(fn); });
    rafs.clear();
    batch.forEach(function (fn) { fn(clock.now); });
  }
}

/* ---------------- DOM 桩 ---------------- */
function makeClassList() {
  var set = new Set();
  return {
    _set: set,
    add: function () { for (var i = 0; i < arguments.length; i++) set.add(arguments[i]); },
    remove: function () { for (var i = 0; i < arguments.length; i++) set.delete(arguments[i]); },
    contains: function (c) { return set.has(c); },
    toggle: function (c, force) {
      if (force === undefined) { set.has(c) ? set.delete(c) : set.add(c); }
      else { force ? set.add(c) : set.delete(c); }
      return set.has(c);
    }
  };
}

function El(tag) {
  this.tagName = String(tag || 'div').toUpperCase();
  this.children = [];
  this.parentNode = null;
  this.style = {};
  this.dataset = {};
  this.attrs = {};
  this.classList = makeClassList();
  this._listeners = {};
  this._text = '';
  this._html = '';
  this._content = null;
  this.value = '';
  this.offsetWidth = 80;
  this.offsetHeight = 30;
}

Object.defineProperty(El.prototype, 'className', {
  get: function () { return Array.from(this.classList._set).join(' '); },
  set: function (v) {
    this.classList._set.clear();
    String(v).split(/\s+/).filter(Boolean).forEach(function (c) { this.classList._set.add(c); }, this);
  }
});
Object.defineProperty(El.prototype, 'textContent', {
  get: function () { return this._text; },
  set: function (v) { this._text = String(v); }
});
Object.defineProperty(El.prototype, 'innerHTML', {
  get: function () { return this._html; },
  set: function (v) { this._html = String(v); if (v === '') this.children = []; }
});
Object.defineProperty(El.prototype, 'firstElementChild', {
  get: function () { return this.children[0] || null; }
});
Object.defineProperty(El.prototype, 'content', {
  get: function () { return this._content; },
  set: function (v) { this._content = v; }
});

El.prototype.appendChild = function (child) {
  if (child.parentNode) child.parentNode.removeChild(child);
  child.parentNode = this;
  this.children.push(child);
  return child;
};
El.prototype.removeChild = function (child) {
  var i = this.children.indexOf(child);
  if (i !== -1) { this.children.splice(i, 1); child.parentNode = null; }
  return child;
};
El.prototype.remove = function () { if (this.parentNode) this.parentNode.removeChild(this); };
El.prototype.contains = function (node) {
  var n = node;
  while (n) { if (n === this) return true; n = n.parentNode; }
  return false;
};
El.prototype.setAttribute = function (k, v) { this.attrs[k] = String(v); if (k === 'class') this.className = v; };
El.prototype.getAttribute = function (k) { return k in this.attrs ? this.attrs[k] : null; };
El.prototype.addEventListener = function (type, fn) {
  (this._listeners[type] = this._listeners[type] || []).push(fn);
};
El.prototype.removeEventListener = function (type, fn) {
  var list = this._listeners[type] || [];
  var i = list.indexOf(fn);
  if (i !== -1) list.splice(i, 1);
};
El.prototype.querySelectorAll = function (sel) {
  var tokens = String(sel).split(',').map(function (s) { return s.trim().replace(/^\./, ''); }).filter(Boolean);
  var out = [];
  (function walk(node) {
    node.children.forEach(function (c) {
      if (tokens.some(function (t) { return c.classList.contains(t); })) out.push(c);
      walk(c);
    });
  })(this);
  return out;
};
El.prototype.querySelector = function (sel) { return this.querySelectorAll(sel)[0] || null; };
El.prototype.closest = function (sel) {
  var t = String(sel).replace(/^\./, '');
  var n = this;
  while (n) { if (n.classList && n.classList.contains(t)) return n; n = n.parentNode; }
  return null;
};
El.prototype.getBoundingClientRect = function () {
  return { top: 0, bottom: 30, left: 0, right: 80, width: 80, height: 30 };
};
El.prototype.focus = function () {};
El.prototype.select = function () {};
El.prototype.cloneNode = function () {
  var copy = new El(this.tagName.toLowerCase());
  copy.className = this.className;
  copy._text = this._text;
  copy._html = this._html;
  this.children.forEach(function (c) { copy.appendChild(c.cloneNode(true)); });
  return copy;
};
/** 触发注册在该元素上的事件；ev 可覆盖 target / clientX / clientY */
El.prototype._fire = function (type, ev) {
  var self = this;
  var base = {
    target: this,
    cancelable: true,
    clientX: 0,
    clientY: 0,
    stopPropagation: function () {},
    preventDefault: function () {}
  };
  var e = Object.assign(base, ev || {});
  if (!e.target || e.target === this) { e.target = this; }
  ((self._listeners[type] || []).slice()).forEach(function (fn) { fn(e); });
  return e;
};
El.prototype.click = function () { return this._fire('click'); };

/* ---------------- 模板内容 ---------------- */
function buildTemplateContent(kind) {
  var root = new El('div');
  if (kind === 'entry') {
    root.className = 'entry-card';
    ['entry-word', 'entry-def'].forEach(function (c) {
      var i = new El('input'); i.className = c; root.appendChild(i);
    });
    var acts = new El('div'); acts.className = 'entry-actions';
    var cb = new El('button'); cb.className = 'cancel-btn';
    var sb = new El('button'); sb.className = 'save-btn';
    acts.appendChild(cb); acts.appendChild(sb); root.appendChild(acts);
  } else {
    root.className = 'word-card';
    var a = new El('span'); a.className = 'word-text';
    var b = new El('span'); b.className = 'definition';
    var sp = new El('button'); sp.className = 'word-speak';   // 卡片上的「重听」按钮
    root.appendChild(a); root.appendChild(b); root.appendChild(sp);
  }
  return { firstElementChild: root };
}

/* ---------------- document / window / storage ---------------- */
function createEnv() {
  var byId = {};
  var document = {
    body: new El('body'),
    getElementById: function (id) {
      if (!byId[id]) {
        var el = new El('div');
        if (id === 'tpl-entry-card') el.content = buildTemplateContent('entry');
        if (id === 'tpl-word-card') el.content = buildTemplateContent('word');
        byId[id] = el;
      }
      return byId[id];
    },
    createElement: function (tag) { return new El(tag); },
    createElementNS: function (ns, tag) { return new El(tag); },
    addEventListener: function () {},
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; }
  };

  var store = {};
  var localStorage = {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem: function (k, v) { store[k] = String(v); },
    removeItem: function (k) { delete store[k]; },
    _store: store
  };

  var window = {
    innerWidth: 1200,
    innerHeight: 800,
    matchMedia: function () { return { matches: false }; },
    confirm: function () { return true; },
    _listeners: {},
    addEventListener: function (type, fn) {
      (this._listeners[type] = this._listeners[type] || []).push(fn);
    },
    removeEventListener: function (type, fn) {
      var list = this._listeners[type] || [];
      var i = list.indexOf(fn);
      if (i !== -1) list.splice(i, 1);
    }
  };

  var consoleStub = { log: function () {}, warn: function () {}, error: function () {} };

  return {
    document: document,
    window: window,
    localStorage: localStorage,
    console: consoleStub,
    requestAnimationFrame: fakeRaf,
    cancelAnimationFrame: fakeCancelRaf,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    _clock: clock,
    _timers: timers,
    _rafs: rafs,
    advance: advance,
    resetClock: function () {
      clock.now = 0; timers.clear(); rafs.clear();
    }
  };
}

module.exports = { createEnv: createEnv, El: El };
