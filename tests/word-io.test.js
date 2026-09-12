/**
 * 导入 / 导出 / 删除 / 释义框边界 回归测试（无头，Node 直跑）
 *
 *   node tests/word-io.test.js
 *
 * 对应四处实际体验问题：
 *   1) 导出原本是 .json，改回「单词|释义」逐行的 .txt（导入同时兼容旧 .json）
 *   2) 统计面板与记忆模式单词卡上的删除按钮
 *   3) 游戏中单词贴屏幕边缘被切开时，释义框必须整体留在视口内
 *      （旧实现里绝对定位盒子的可用宽度 = 视口宽 - left，贴右缘时可用宽度只剩几十像素，
 *        盒子被压成窄条 → 释义被挤成多行。测试用 240px 宽的假释义框复现）
 */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var stub = require('./dom-stub');

var SRC = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');

/**
 * 启动一个应用实例。相比 game-mode 的 boot，这里额外补上
 * Blob / URL / FileReader 三个浏览器 API（导出下载与导入读文件要用），
 * 并把导出结果与下载文件名捕获下来供断言。
 */
function boot(n, opts) {
  opts = opts || {};
  var env = stub.createEnv();

  var words = [];
  for (var i = 1; i <= n; i++) {
    words.push({
      id: 'w' + i,
      word: 'word' + i,
      definition: opts.emptyDef ? '' : '释义' + i,
      x: 0.5, y: 0.5, createdAt: i, recallCount: 0
    });
  }
  env.localStorage.setItem('paper-papers', JSON.stringify({
    papers: [{ id: 'p1', name: '测试白纸', createdAt: 1, words: words }],
    activeId: 'p1'
  }));

  var captured = { blob: null, download: '', revoked: 0 };

  // 抓住导出时创建的 <a>，才能核对下载文件名
  var realCreate = env.document.createElement;
  env.document.createElement = function (tag) {
    var node = realCreate(tag);
    if (String(tag).toLowerCase() === 'a') captured.anchor = node;
    return node;
  };

  function Blob(parts, options) {
    this.parts = parts;
    this.type = (options || {}).type || '';
  }
  var URLStub = {
    createObjectURL: function (b) { captured.blob = b; return 'blob:test'; },
    revokeObjectURL: function () { captured.revoked++; }
  };
  function FileReaderStub() {
    var self = this;
    this.readAsText = function (file) {
      self.result = file && file._text;
      if (typeof self.onload === 'function') self.onload();
    };
  }

  var sandbox = {
    document: env.document,
    window: env.window,
    localStorage: env.localStorage,
    console: env.console,
    requestAnimationFrame: env.requestAnimationFrame,
    cancelAnimationFrame: env.cancelAnimationFrame,
    setTimeout: env.setTimeout,
    clearTimeout: env.clearTimeout,
    Blob: Blob,
    URL: URLStub,
    FileReader: FileReaderStub
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'script.js' });

  var el = function (id) { return env.document.getElementById(id); };
  return {
    env: env,
    el: el,
    paper: el('paper'),
    captured: captured,
    advance: env.advance,
    run: function (code) { return vm.runInContext(code, sandbox); },
    storedWords: function () {
      return JSON.parse(env.localStorage.getItem('paper-papers')).papers[0].words;
    },
    /** 模拟「选择文件」：把文本当成文件内容触发 #import-file 的 change */
    importText: function (text) {
      el('import-file')._fire('change', { target: { files: [{ _text: text }], value: '' } });
    }
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

console.log('\n导入 / 导出 / 删除 / 释义框边界 回归测试');
console.log('─'.repeat(56));

/* ---- 1. 导出：.txt，每行「单词|释义」，带 BOM ---- */
test('导出：下载 .txt，逐行「单词|释义」，带 UTF-8 BOM', function () {
  var t = boot(3);
  t.el('btn-export').click();
  assert(t.captured.blob, '没有生成导出文件');
  var text = String(t.captured.blob.parts[0]);
  eq(text.charAt(0), '\ufeff', '缺少 BOM，Windows 记事本打开中文会乱码');
  eq(text.slice(1), 'word1|释义1\nword2|释义2\nword3|释义3', '导出内容不是逐行「单词|释义」');
  var name = t.captured.anchor && t.captured.anchor.download || '';
  assert(/\.txt$/.test(name), '文件名不是 .txt：' + name);
  eq(t.captured.blob.type.indexOf('text/plain'), 0, 'MIME 不是 text/plain');
  eq(t.captured.revoked, 1, '临时 URL 未回收');
});

/* ---- 2. 导出：空白纸只提示、不下载 ---- */
test('导出：当前白纸没有单词时只提示，不产生下载', function () {
  var t = boot(0);
  t.el('btn-export').click();
  eq(t.captured.blob, null, '空白纸不应生成文件');
  assert(t.el('toast').textContent.indexOf('暂无数据') !== -1, '未提示无可导出数据');
});

/* ---- 3. 导入 txt ---- */
test('导入 txt：逐行解析「单词|释义」并追加到当前白纸', function () {
  var t = boot(0);
  t.importText('apple|n.苹果\nbook|n.书\n');
  var w = t.storedWords();
  eq(w.length, 2, '导入的单词数不对');
  eq(w[0].word, 'apple');
  eq(w[0].definition, 'n.苹果');
  eq(w[1].word, 'book');
  eq(t.el('word-count').textContent, '2 个单词', '工具栏计数未刷新');
});

/* ---- 4. 导入：与已手写的白纸合并，不覆盖 ---- */
test('导入 txt：追加到现有白纸而非覆盖', function () {
  var t = boot(2);
  t.importText('cat|n.猫');
  var w = t.storedWords();
  eq(w.length, 3, '导入未追加到现有白纸');
  eq(w[0].word, 'word1');
  eq(w[2].word, 'cat');
});

/* ---- 5. 导入：兼容旧版 JSON 备份 ---- */
test('导入旧版 .json 备份：字段仍完整还原', function () {
  var t = boot(1);
  t.importText(JSON.stringify([
    { id: 'x1', word: 'cat', definition: 'n.猫', x: 0.3, y: 0.4, recallCount: 5 },
    { word: 'dog' }
  ]));
  var w = t.storedWords();
  eq(w.length, 3, 'json 导入的条目数不对');
  eq(w[1].word, 'cat');
  eq(w[1].x, 0.3, '已有坐标应保留');
  eq(w[1].recallCount, 5, '记忆次数应保留');
  eq(w[2].word, 'dog');
  eq(w[2].definition, '', '缺省释义应补为空串');
});

/* ---- 6. 导入容错：空行 / 注释 / 制表符 / 全角竖线 / 无分隔符 ---- */
test('导入容错：空行、注释、制表符、全角竖线、无分隔符都能正确处理', function () {
  var t = boot(0);
  t.importText('# 我的单词\nalpha｜甲的\n\nbeta\t乙\nno-sep\n');
  var w = t.storedWords();
  eq(w.length, 3, '行数解析不对（应跳过空行与注释、保留无分隔符的行）');
  eq(w[0].word, 'alpha');
  eq(w[0].definition, '甲的');
  eq(w[1].word, 'beta');
  eq(w[1].definition, '乙');
  eq(w[2].word, 'no-sep');
  eq(w[2].definition, '', '无分隔符时应只有单词、释义为空');
});

/* ---- 7. 导入：空文件只提示，不动数据 ---- */
test('导入空文件：提示失败且数据不变', function () {
  var t = boot(1);
  t.importText('   \n\n');
  eq(t.storedWords().length, 1, '空文件不应改变数据');
  eq(t.el('toast').textContent.indexOf('导入失败'), 0, '未提示导入失败');
});

/* ---- 8. 删除：统计面板 ---- */
test('删除：统计面板每行都有删除按钮，删后数据与计数同步', function () {
  var t = boot(3);
  t.el('btn-stats').click();
  eq(t.el('stats-list').querySelectorAll('.stat-row').length, 3, '统计行数量不对');
  var delBtns = t.el('stats-list').querySelectorAll('.stat-del');
  eq(delBtns.length, 3, '每行都应有一个删除按钮');

  delBtns[1].click();                       // 删掉 word2
  var left = t.storedWords();
  eq(left.length, 2, '删除后白纸里的单词数不对');
  eq(left.filter(function (w) { return w.word === 'word2'; }).length, 0, '被删的单词仍在数据里');
  eq(t.el('stats-list').querySelectorAll('.stat-row').length, 2, '统计面板未重新渲染');
  eq(t.el('word-count').textContent, '2 个单词', '工具栏计数未刷新');
});

/* ---- 9. 删除：确认框取消时不删 ---- */
test('删除：确认框选「取消」时不删除任何数据', function () {
  var t = boot(2);
  t.env.window.confirm = function () { return false; };
  t.el('btn-stats').click();
  t.el('stats-list').querySelectorAll('.stat-del')[0].click();
  eq(t.storedWords().length, 2, '取消后仍被删除');
});

/* ---- 10. 删除：记忆模式单词卡 ---- */
test('删除：记忆模式单词卡上的删除按钮，卡片与数据一起消失', function () {
  var t = boot(3);
  t.el('mode-recall').click();
  t.paper._fire('click', { clientX: 400, clientY: 400 });
  var card = t.paper.querySelectorAll('.word-card')[0];
  assert(card, '记忆模式没有浮现单词卡');
  var delBtn = card.querySelector('.word-del');
  assert(delBtn, '单词卡上没有删除按钮');

  delBtn.click();
  eq(t.storedWords().length, 2, '数据未删除');
  t.advance(800);                            // 等淡出动画走完
  eq(t.paper.querySelectorAll('.word-card').length, 0, '被删的单词卡仍留在屏上');
});

/* ---- 11. 释义框：贴屏幕右缘切开时不越界（回归 #4 多行变形） ---- */
test('游戏释义框：单词贴右缘被切开时整体留在视口内', function () {
  var t = boot(4);
  // 固定随机源 → 抛出的单词一律出现在最右侧（x ≈ 1129 / 视口宽 1200）
  t.run('Math.random = function () { return 0.9999; };');
  t.el('mode-game').click();
  t.advance(4000);                           // 跳过开场倒计时，让单词抛出来

  var fruits = t.paper.querySelectorAll('.fruit-word');
  assert(fruits.length > 0, '游戏没有抛出单词');
  var f = fruits[0];
  t.paper._fire('pointerdown', {
    clientX: parseFloat(f.style.left),
    clientY: parseFloat(f.style.top)
  });

  var pops = t.paper.querySelectorAll('.def-pop');
  eq(pops.length, 1, '切开后没有浮现释义框');
  var bw = pops[0].offsetWidth;
  var left = parseFloat(pops[0].style.left);
  assert(left + bw / 2 <= 1200 - 10 + 0.01,
    '释义框右侧溢出视口（旧版会因此被压成窄条、文字排成多行）：left=' + left + ' 宽=' + bw);
  assert(left - bw / 2 >= 10 - 0.01, '释义框左侧溢出视口：left=' + left);
});

/* ---- 12. 释义框：没有释义的单词不弹空框 ---- */
test('游戏释义框：单词没有释义时不弹空框', function () {
  var t = boot(4, { emptyDef: true });
  t.run('Math.random = function () { return 0.9999; };');

  t.el('mode-game').click();
  t.advance(4000);
  var fruits = t.paper.querySelectorAll('.fruit-word');
  assert(fruits.length > 0, '游戏没有抛出单词');
  t.paper._fire('pointerdown', {
    clientX: parseFloat(fruits[0].style.left),
    clientY: parseFloat(fruits[0].style.top)
  });
  eq(t.paper.querySelectorAll('.def-pop').length, 0, '空释义不应该弹出释义框');
});

console.log('─'.repeat(56));
console.log('通过 ' + passed + ' / ' + (passed + failed) + (failed ? '，失败 ' + failed : '') + '\n');
process.exit(failed ? 1 : 0);
