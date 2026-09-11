/**
 * 单词本（词库导入 → 生成白纸）回归测试（无头，Node 直跑）
 *
 *   node tests/wordbook.test.js
 *
 * 覆盖：词库读取与渲染、按 group 分组、一键导入生成白纸、导入白纸与手写白纸同构（可进游戏）、
 *       重复导入自动改名、无内置词库时不崩、真实 wordbooks.js 结构完整性。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var stub = require('./dom-stub');

var SRC = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');

/** 假的 window.WORDBOOKS，用于隔离测试（不依赖真实约 2MB 的词库文件） */
var FAKE_BOOKS = [
  { id: 't1', name: '测试词库', tag: 'TEST', desc: '单元测试用', count: 3, data: 'apple|n.苹果\nbook|n.书\ncat|n.猫' },
  { id: 't2', name: '空词库', tag: 'EMPTY', desc: '无词', count: 0, data: '' }
];

/**
 * 启动一个应用实例。
 * opts.books：注入 window.WORDBOOKS；opts.seedWords：初始白纸单词数。
 */
function boot(opts) {
  opts = opts || {};
  var env = stub.createEnv();

  var words = [];
  var n = opts.seedWords || 0;
  for (var i = 1; i <= n; i++) {
    words.push({ id: 'w' + i, word: 'word' + i, definition: '释义' + i, x: 0.5, y: 0.5, createdAt: i, recallCount: 0 });
  }
  env.localStorage.setItem('paper-papers', JSON.stringify({
    papers: [{ id: 'p1', name: '手写白纸', createdAt: 1, words: words }],
    activeId: 'p1'
  }));

  if (opts.books) env.window.WORDBOOKS = opts.books;

  var sandbox = {
    document: env.document,
    window: env.window,
    localStorage: env.localStorage,
    console: env.console,
    requestAnimationFrame: env.requestAnimationFrame,
    cancelAnimationFrame: env.cancelAnimationFrame,
    setTimeout: env.setTimeout,
    clearTimeout: env.clearTimeout
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'script.js' });

  var el = function (id) { return env.document.getElementById(id); };
  return {
    env: env,
    el: el,
    advance: env.advance,
    papers: function () { return JSON.parse(env.localStorage.getItem('paper-papers')); },
    cards: function () { return el('wordbook-list').querySelectorAll('.wordbook-card'); },
    imports: function () { return el('wordbook-list').querySelectorAll('.wordbook-import'); }
  };
}

/* ---------------- 迷你测试框架 ---------------- */
var passed = 0;
var failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { failed++; console.log('  FAIL  ' + name); console.log('        ' + e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function eq(a, b, msg) {
  if (a !== b) throw new Error((msg || '值不相等') + ' — 期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a));
}

console.log('\n单词本（词库导入）回归测试');
console.log('─'.repeat(56));

/* ---- 1. 打开单词本：按 window.WORDBOOKS 渲染词库卡片 ---- */
test('打开单词本：渲染出全部词库卡片', function () {
  var t = boot({ books: FAKE_BOOKS });
  t.el('shelf-books').click();
  assert(t.el('wordbook-panel').classList.contains('open'), '单词本面板未打开');
  eq(t.cards().length, 2, '词库卡片数量不对');
  eq(t.el('wordbook-list').querySelectorAll('.wordbook-name')[0].textContent, '测试词库', '首个词库名不对');
});

/* ---- 2. 一键导入：生成一张命名为词库名的白纸，内容正确 ---- */
test('导入词库：新增白纸，名称/词数/内容正确', function () {
  var t = boot({ books: FAKE_BOOKS });
  t.el('shelf-books').click();
  t.imports()[0].click();

  var data = t.papers();
  eq(data.papers.length, 2, '未新增白纸');
  var p = data.papers[1];
  eq(p.name, '测试词库', '白纸名未取词库名');
  eq(p.words.length, 3, '导入词数不对');
  eq(p.words[0].word, 'apple', '首个单词不对');
  eq(p.words[0].definition, 'n.苹果', '首个释义不对');
  eq(p.words[2].word, 'cat', '末个单词不对');
  // 单词对象结构需与手写白纸一致（游戏/记忆模式依赖这些字段）
  ['id', 'word', 'definition', 'x', 'y', 'createdAt', 'recallCount'].forEach(function (k) {
    assert(k in p.words[0], '导入单词缺少字段：' + k);
  });
  assert(!t.el('wordbook-panel').classList.contains('open'), '导入后未关闭单词本面板');
  assert(t.el('app').classList.contains('active'), '导入后未进入应用');
});

/* ---- 3. 导入的白纸与手写白纸功能一致：可直接开游戏并对齐 HUD ---- */
test('导入的白纸：可进入游戏模式并抛出单词', function () {
  var t = boot({ books: FAKE_BOOKS });
  t.el('shelf-books').click();
  t.imports()[0].click();

  t.el('mode-game').click();
  // 倒计时约 3s 后开始抛出
  var peak = 0;
  for (var i = 0; i < 60; i++) {
    t.advance(100);
    peak = Math.max(peak, t.el('paper').querySelectorAll('.fruit-word').length);
  }
  assert(peak > 0, '导入白纸进入游戏后没有单词抛出（peak=' + peak + '）');
  assert(t.el('game-hud').classList.contains('active'), '游戏 HUD 未激活');
});

/* ---- 4. 重复导入：自动改名，不覆盖已有白纸 ---- */
test('重复导入同一词库：名称自动加序号', function () {
  var t = boot({ books: FAKE_BOOKS });
  t.el('shelf-books').click();
  t.imports()[0].click();
  t.el('shelf-books').click();
  t.imports()[0].click();

  var data = t.papers();
  eq(data.papers.length, 3, '未生成第二张导入白纸');
  eq(data.papers[1].name, '测试词库', '第一张名不对');
  eq(data.papers[2].name, '测试词库 2', '第二张未自动改名');
});

/* ---- 5. 无内置词库 / 空词库：不崩，显示空态或提示 ---- */
test('无内置词库：面板显示空态且不抛错', function () {
  var t = boot({}); // 不注入 window.WORDBOOKS
  t.el('shelf-books').click();
  assert(t.el('wordbook-panel').classList.contains('open'), '面板未打开');
  eq(t.cards().length, 0, '不应有词库卡片');
  assert(t.el('wordbook-list').querySelectorAll('.wordbook-empty').length === 1, '未显示空态');
});

test('空词库：点击导入给出提示且不新增白纸', function () {
  var t = boot({ books: FAKE_BOOKS });
  t.el('shelf-books').click();
  t.imports()[1].click(); // 「空词库」
  eq(t.papers().papers.length, 1, '空词库不应新增白纸');
  assert(t.el('toast').classList.contains('show'), '空词库未给出提示');
});

/* ---- 6. 分组：词库带 group 时按组渲染标题，同组只出现一次 ---- */
var GROUPED_BOOKS = [
  { id: 'g1', name: '甲', tag: 'A', group: '第一组', count: 1, data: 'one|一' },
  { id: 'g2', name: '乙', tag: 'B', group: '第一组', count: 1, data: 'two|二' },
  { id: 'g3', name: '丙', tag: 'C', group: '第二组', count: 1, data: 'three|三' },
  { id: 'g4', name: '丁', tag: 'D', count: 1, data: 'four|四' } // 无 group → 其他
];

test('分组：按 group 渲染分组标题，数量与组名正确', function () {
  var t = boot({ books: GROUPED_BOOKS });
  t.el('shelf-books').click();

  var heads = t.el('wordbook-list').querySelectorAll('.wordbook-group');
  eq(heads.length, 3, '分组标题数量不对（应为 第一组/第二组/其他）');
  var names = t.el('wordbook-list').querySelectorAll('.wordbook-group-name');
  eq(names[0].textContent, '第一组', '首个组名不对');
  eq(names[1].textContent, '第二组', '第二个组名不对');
  eq(names[2].textContent, '其他', '无 group 的词库未归入「其他」');
  var nums = t.el('wordbook-list').querySelectorAll('.wordbook-group-num');
  eq(nums[0].textContent, '2 本', '第一组本数不对');
  eq(t.cards().length, 4, '分组后卡片数不应变化');
});

/* ---- 7. 真实词库文件：结构完整性（防止生成脚本出错） ---- */
test('真实 wordbooks.js：各库 count 与实际词条数一致且无空释义', function () {
  var p = path.join(__dirname, '..', 'wordbooks.js');
  if (!fs.existsSync(p)) { console.log('        （跳过：未找到 wordbooks.js）'); return; }
  var box = { window: {} };
  vm.createContext(box);
  vm.runInContext(fs.readFileSync(p, 'utf8'), box, { filename: 'wordbooks.js' });

  var books = box.window.WORDBOOKS;
  assert(Array.isArray(books) && books.length > 0, 'window.WORDBOOKS 不是非空数组');
  eq(books.length, 9, '词库本数不是 9');

  books.forEach(function (b) {
    assert(b.id && b.name && b.tag && b.group, b.id + ' 缺少 id/name/tag/group');
    var lines = b.data.split('\n').filter(Boolean);
    eq(b.count, lines.length, b.name + ' 的 count 与实际词条数不一致');
    assert(b.count > 500, b.name + ' 词数异常偏少：' + b.count);
    lines.forEach(function (l) {
      var i = l.indexOf('|');
      if (i <= 0 || !l.slice(i + 1).trim()) {
        throw new Error(b.name + ' 存在空词或空释义：' + l);
      }
    });
  });

  var total = books.reduce(function (s, b) { return s + b.count; }, 0);
  assert(total > 40000, '词条总量异常：' + total);
});

console.log('─'.repeat(56));
console.log('通过 ' + passed + ' / ' + (passed + failed) + (failed ? '，失败 ' + failed : '') + '\n');
process.exit(failed ? 1 : 0);
