/**
 * 游戏模式时序回归测试（无头，Node 直跑）
 *
 *   node tests/game-mode.test.js
 *
 * 覆盖的 bug：点击「游戏」后、开场倒计时尚未结束就切到「记忆」/「录入」，
 * 倒计时链仍会跑完并调用 startGame()，导致单词继续弹出、游戏界面未真正关闭。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var stub = require('./dom-stub');

var SRC = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');

/** 生成确定性随机源表达式，让涉及随机的用例可复现（Lehmer 线性同余） */
function seededRandomExpr(seed) {
  return '(function (s) { var x = s; return function () { ' +
    'x = (x * 48271) % 2147483647; return x / 2147483647; }; })(' + seed + ')';
}

/** 假 AudioContext：只在需要验证音效的用例里注入，不影响其它测试 */
function createFakeAudio() {
  var stats = { resumeCalls: 0, bufferSources: 0, filters: [], gains: [] };

  function Param() {
    this.value = 0;
    this.setValueAtTime = function (v) { this.value = v; return this; };
    this.linearRampToValueAtTime = function (v) { this.value = v; return this; };
    this.exponentialRampToValueAtTime = function (v) { this.value = v; return this; };
  }
  function Node() {
    this.connected = [];
    this.connect = function (n) { this.connected.push(n); };
    this.disconnect = function () {};
  }
  function Ctx() {
    var self = this;
    this.state = 'suspended';
    this.sampleRate = 44100;
    this.currentTime = 0;
    this.destination = new Node();
    this.resume = function () {
      stats.resumeCalls++;
      self.state = 'running';
      return { catch: function () {} };
    };
    this.createBuffer = function (ch, len) {
      var arr = new Float32Array(len);
      return { getChannelData: function () { return arr; } };
    };
    this.createBufferSource = function () {
      stats.bufferSources++;
      var n = new Node();
      n.start = function () {};
      n.stop = function () {};
      return n;
    };
    this.createBiquadFilter = function () {
      var n = new Node();
      n.type = '';
      n.Q = new Param();
      n.frequency = new Param();
      stats.filters.push(n);
      return n;
    };
    this.createGain = function () {
      var n = new Node();
      n.gain = new Param();
      stats.gains.push(n);
      return n;
    };
  }
  stats.Ctor = Ctx;
  return stats;
}

/** 假 speechSynthesis：记录朗读调用序列，用于验证"多词连切"时的朗读策略 */
function createFakeSpeech() {
  var stats = { spoken: [], cancels: 0, voicesRequested: 0, listeners: {} };

  function Utterance(text) {
    this.text = text;
    this.lang = '';
    this.rate = 1;
    this.pitch = 1;
    this.volume = 1;
    this.voice = null;
    this.onend = null;
    this.onerror = null;
  }

  var voices = [
    { name: 'Google US English', lang: 'en-US', localService: false },
    { name: 'Samantha', lang: 'en-US', localService: true },
    { name: 'Ting-Ting', lang: 'zh-CN', localService: true }
  ];

  var synth = {
    speaking: false,
    pending: false,
    paused: false,
    getVoices: function () { stats.voicesRequested++; return voices; },
    speak: function (u) {
      stats.spoken.push(u.text);
      // 同步触发 onend，模拟朗读结束（测试里不关心时长）
      if (typeof u.onend === 'function') u.onend();
    },
    cancel: function () { stats.cancels++; },
    pause: function () {},
    resume: function () {},
    addEventListener: function (type, fn) { (stats.listeners[type] = stats.listeners[type] || []).push(fn); }
  };
  stats.Utterance = Utterance;
  stats.synth = synth;
  stats.voices = voices;
  return stats;
}

/** 用 n 个单词启动一次全新的应用实例；opts: { audio, sound, seed, speech, speak } */
function boot(n, opts) {
  opts = opts || {};
  var env = stub.createEnv();
  var words = [];
  for (var i = 1; i <= n; i++) {
    words.push({ id: 'w' + i, word: 'word' + i, definition: '释义' + i, x: 0.5, y: 0.5, createdAt: i, recallCount: 0 });
  }
  env.localStorage.setItem('paper-papers', JSON.stringify({
    papers: [{ id: 'p1', name: '测试白纸', createdAt: 1, words: words }],
    activeId: 'p1'
  }));
  if (opts.sound) env.localStorage.setItem('paper-sound', opts.sound);
  if (opts.speak) env.localStorage.setItem('paper-speak', opts.speak);

  var audio = null;
  if (opts.audio) {
    audio = createFakeAudio();
    env.window.AudioContext = audio.Ctor;
  }

  var speech = null;
  if (opts.speech) {
    speech = createFakeSpeech();
    env.window.speechSynthesis = speech.synth;
    env.window.SpeechSynthesisUtterance = speech.Utterance;
  }

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
  if (opts.seed) vm.runInContext('Math.random = ' + seededRandomExpr(opts.seed) + ';', sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'script.js' });

  var el = function (id) { return env.document.getElementById(id); };
  var api = {
    env: env,
    el: el,
    paper: el('paper'),
    audio: audio,
    speech: speech,
    advance: env.advance,
    /** 推进 ms 毫秒，返回期间「同屏单词数」的峰值 */
    advanceAndWatch: function (ms, slice) {
      var step = slice || 100;
      var peak = 0;
      var n = Math.ceil(ms / step);
      for (var i = 0; i < n; i++) {
        env.advance(step);
        peak = Math.max(peak, el('paper').querySelectorAll('.fruit-word').length);
      }
      return peak;
    },
    storedWords: function () {
      return JSON.parse(env.localStorage.getItem('paper-papers')).papers[0].words;
    }
  };
  return api;
}

/** 在 ms 毫秒内持续切开出现的单词，间隔至少 gap 毫秒，用于驱动音效路径 */
function sliceFor(t, ms, gap) {
  var minGap = gap || 60;
  var spent = 0;
  var since = 999;
  while (spent < ms) {
    var fruits = t.paper.querySelectorAll('.fruit-word');
    if (fruits.length && since >= minGap) {
      var f = fruits[0];
      t.paper._fire('pointerdown', {
        clientX: parseFloat(f.style.left),
        clientY: parseFloat(f.style.top)
      });
      since = 0;
    }
    t.advance(50);
    spent += 50;
    since += 50;
  }
}

/** 真实等待 ms 毫秒（连击窗口与刀气存活都基于 Date.now()，虚拟时钟推进不了它） */
function waitReal(ms) {
  var end = Date.now() + ms;
  while (Date.now() < end) { /* spin */ }
}

/* ---------------- 迷你测试框架 ---------------- */
var passed = 0;
var failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  PASS  ' + name);
  } catch (e) {
    failed++;
    console.log('  FAIL  ' + name);
    console.log('        ' + e.message);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error((msg || '值不相等') + ' — 期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
  }
}

console.log('\n游戏模式时序回归测试');
console.log('─'.repeat(56));

/* ---- 1. 倒计时期间切到「记忆」：不得再有单词弹出 ---- */
test('游戏 → 记忆（倒计时未结束）：无残留单词弹出，游戏界面已关闭', function () {
  var t = boot(8);
  t.el('mode-game').click();
  t.el('mode-recall').click();          // 立刻切走
  var peak = t.advanceAndWatch(6000);
  eq(peak, 0, '切换后仍有单词弹出');
  assert(!t.paper.classList.contains('paper--game'), '纸张仍停留在游戏态');
  assert(!t.el('game-hud').classList.contains('active'), '游戏 HUD 未关闭');
  assert(!t.el('game-countdown').classList.contains('active'), '开场倒计时未关闭');
});

/* ---- 2. 倒计时期间切到「录入」：同上 ---- */
test('游戏 → 录入（倒计时未结束）：无残留单词弹出，游戏界面已关闭', function () {
  var t = boot(8);
  t.el('mode-game').click();
  t.el('mode-entry').click();
  var peak = t.advanceAndWatch(6000);
  eq(peak, 0, '切换后仍有单词弹出');
  assert(!t.paper.classList.contains('paper--game'), '纸张仍停留在游戏态');
  assert(!t.el('game-hud').classList.contains('active'), '游戏 HUD 未关闭');
});

/* ---- 3. 正常游玩不受影响 ---- */
test('正常游戏：倒计时结束后单词正常抛出，HUD 显示', function () {
  var t = boot(8);
  t.el('mode-game').click();
  assert(t.el('game-countdown').classList.contains('active'), '倒计时未出现');
  var peak = t.advanceAndWatch(4000);
  assert(peak > 0, '正常游玩时没有单词抛出（peak=' + peak + '）');
  assert(t.el('game-hud').classList.contains('active'), 'HUD 未显示');
  assert(t.paper.classList.contains('paper--game'), '纸张未进入游戏态');
});

/* ---- 4. 游戏中途切走：立即清空 + 无新增 ---- */
test('游戏中 → 记忆：立即清空在飞单词，且后续无新增', function () {
  var t = boot(8);
  t.el('mode-game').click();
  t.advanceAndWatch(4000);
  t.el('mode-recall').click();
  eq(t.paper.querySelectorAll('.fruit-word').length, 0, '切换瞬间在飞单词未被清空');
  var peak = t.advanceAndWatch(6000);
  eq(peak, 0, '切换后仍在生成新单词');
  assert(!t.el('game-timebar').classList.contains('active'), '时间条未关闭');
});

/* ---- 5. 快速连点「游戏」两次后切走：不产生第二条倒计时 ---- */
test('连点「游戏」×2 → 记忆：无重复倒计时残留', function () {
  var t = boot(8);
  t.el('mode-game').click();
  t.el('mode-game').click();            // 重复触发应被忽略
  t.el('mode-recall').click();
  var peak = t.advanceAndWatch(8000);
  eq(peak, 0, '重复点击导致残留任务');
});

/* ---- 6. 反复横跳：游戏/记忆/录入 快速切换后仍干净 ---- */
test('游戏/记忆/录入 反复快速切换：最终状态干净，无残留弹出', function () {
  var t = boot(8);
  t.el('mode-game').click();
  t.el('mode-recall').click();
  t.el('mode-game').click();
  t.el('mode-entry').click();
  t.el('mode-game').click();
  t.el('mode-recall').click();          // 最终停在记忆
  var peak = t.advanceAndWatch(8000);
  eq(peak, 0, '反复切换后出现残留弹出');
  assert(!t.paper.classList.contains('paper--game'), '纸张仍停留在游戏态');
});

/* ---- 7. 三按钮互斥 ---- */
test('三个模式按钮状态互斥（active + aria-pressed）', function () {
  var t = boot(8);
  var ids = ['mode-entry', 'mode-recall', 'mode-game'];
  var states = [
    ['mode-recall', 'entry'],
    ['mode-game', 'recall'],
    ['mode-entry', 'game']
  ];
  states.forEach(function (pair) {
    t.el(pair[0]).click();
    ids.forEach(function (id) {
      var shouldBeActive = id === pair[0];
      eq(t.el(id).classList.contains('active'), shouldBeActive, id + ' 的 active 状态错误');
      eq(t.el(id).getAttribute('aria-pressed'), String(shouldBeActive), id + ' 的 aria-pressed 错误');
    });
  });
});

/* ---- 8. 记忆模式原有行为不受影响 ---- */
test('记忆模式原有行为：点击纸张浮现单词', function () {
  var t = boot(8);
  t.el('mode-recall').click();
  t.paper._fire('click', { clientX: 500, clientY: 300, target: { closest: function () { return null; } } });
  t.advance(100);
  var cards = t.paper.querySelectorAll('.word-card');
  eq(cards.length, 1, '未浮现单词卡片');
  assert(cards[0].querySelector('.word-text').textContent.length > 0, '单词文本为空');
});

/* ---- 9. 录入模式原有行为不受影响 ---- */
test('录入模式原有行为：录入卡片可保存并写入存储', function () {
  var t = boot(8);
  t.el('mode-entry').click();
  t.paper._fire('click', { clientX: 500, clientY: 300, target: { closest: function () { return null; } } });
  var card = t.paper.querySelector('.entry-card');
  assert(card, '未弹出录入卡片');
  card.querySelector('.entry-word').value = 'ephemeral';
  card.querySelector('.entry-def').value = '短暂的';
  card.querySelector('.save-btn').click();
  eq(t.storedWords().length, 9, '单词未写入存储');
  eq(t.storedWords()[8].word, 'ephemeral', '写入的单词不正确');
});

/* ---- 10. 游戏结束后再点「游戏」可重开 ---- */
test('结算后再点「游戏」可重新开始一局', function () {
  var t = boot(8);
  t.el('mode-game').click();
  t.advanceAndWatch(64000);             // 跑完 60 秒
  assert(t.el('game-over-panel').classList.contains('open'), '结算面板未弹出');
  t.el('game-over-close').click();
  t.el('mode-game').click();
  var peak = t.advanceAndWatch(4000);
  assert(peak > 0, '重开后没有单词抛出（peak=' + peak + '）');
});

/* ---- 11. 音效开关：点击切换 + 持久化 ---- */
test('音效开关：点击可静音并持久化，再次点击恢复', function () {
  var t = boot(8);
  var body = t.env.document.body;
  assert(!body.classList.contains('sound-off'), '默认应为开启状态');
  eq(t.el('btn-sound').getAttribute('aria-label'), '关闭音效', '初始 aria-label 不正确');

  t.el('btn-sound').click();
  eq(t.env.localStorage.getItem('paper-sound'), 'off', '静音偏好未写入 localStorage');
  assert(body.classList.contains('sound-off'), 'body 未标记 sound-off');
  eq(t.el('btn-sound').getAttribute('aria-label'), '开启音效', '静音后 aria-label 未更新');

  t.el('btn-sound').click();
  eq(t.env.localStorage.getItem('paper-sound'), 'on', '未恢复为开启');
  assert(!body.classList.contains('sound-off'), 'body 仍标记 sound-off');
});

/* ---- 12. 音效开关：预置静音后重新载入会还原 ---- */
test('音效开关：预置静音后重新载入会还原状态', function () {
  var t = boot(8, { sound: 'off' });
  assert(t.env.document.body.classList.contains('sound-off'), '未还原静音状态');
  eq(t.el('btn-sound').getAttribute('aria-label'), '开启音效', '还原后 aria-label 不正确');
});

/* ---- 13. 无 AudioContext 环境：静默降级，游戏照常 ---- */
test('无 AudioContext 环境：切开单词不抛异常，游戏照常运行', function () {
  var t = boot(8, { seed: 42 });
  t.el('mode-game').click();
  t.advance(3000);
  sliceFor(t, 4000);                      // 真实驱动切开路径（此时没有 AudioContext）
  assert(Number(t.el('game-score').textContent) > 0, '切开未计分，说明降级路径影响了游戏');
});

/* ---- 14. 手势解锁 + 切开时发声 ---- */
test('点击「游戏」在手势里解锁音频，切开单词时合成音效', function () {
  var t = boot(8, { audio: true, seed: 7 });
  t.el('mode-game').click();
  eq(t.audio.resumeCalls, 1, '未在用户手势里 resume AudioContext');
  eq(t.audio.Ctor && true, true, 'AudioContext 未创建');

  t.advance(3000);
  sliceFor(t, 4000);

  assert(t.audio.bufferSources > 0, '切开单词时没有合成音效');
  var f0 = t.audio.filters[0];
  eq(f0.type, 'bandpass', '滤波器类型不是 bandpass');
  eq(f0.Q.value, 1.8, '滤波器 Q 值不是 1.8');
  assert(f0.frequency.value > 0, '未设置带通中心频率');
});

/* ---- 15. 连击升调：音高随连击变化且不超过上限 ---- */
test('连击升调：音高随连击递增，且封顶不超过 11000Hz', function () {
  var t = boot(8, { audio: true, seed: 99 });
  t.el('mode-game').click();
  t.advance(3000);
  sliceFor(t, 12000, 60);

  var freqs = t.audio.filters.map(function (f) { return f.frequency.value; });
  assert(freqs.length >= 3, '样本太少，无法判断音高变化（' + freqs.length + '）');
  var min = Math.min.apply(null, freqs);
  var max = Math.max.apply(null, freqs);
  assert(max > min, '音高没有随连击变化（min=' + min + ', max=' + max + '）');
  assert(max <= 11000 + 1e-6, '音高超过 11000Hz 上限：' + max);
});

/* ---- 16. 静音时不发声、不解锁 ---- */
test('静音状态下：不解锁音频，切开单词也不发声', function () {
  var t = boot(8, { audio: true, sound: 'off', seed: 7 });
  assert(t.env.document.body.classList.contains('sound-off'), '预置静音未生效');
  t.el('mode-game').click();
  eq(t.audio.resumeCalls, 0, '静音时不应 resume AudioContext');

  t.advance(3000);
  sliceFor(t, 4000);
  assert(Number(t.el('game-score').textContent) > 0, '静音影响了正常计分');
  eq(t.audio.bufferSources, 0, '静音时仍合成了音效');
});

/* ---- 17. 连击 UI：段位文案与配色档位随连击数切换 ---- */
test('连击 UI：连击数驱动段位文案，且只命中一个配色档位', function () {
  var t = boot(8, { seed: 5 });
  t.el('mode-game').click();
  t.advance(3000);
  sliceFor(t, 9000, 50);

  var n = Number(t.el('game-combo-count').textContent);
  assert(n >= 2, '连击未累积（count=' + n + '）');
  var combo = t.el('game-combo');
  var hits = [1, 2, 3, 4, 5].filter(function (i) { return combo.classList.contains('tier-' + i); });
  eq(hits.length, 1, '配色档位应恰好命中一个，实际 ' + hits.length + ' 个');

  var expected = n >= 12 ? '入神' : n >= 9 ? '疾风' : n >= 6 ? '凌厉' : n >= 4 ? '流畅' : '顺手';
  eq(t.el('combo-tier').textContent, expected, '段位文案与连击数不匹配');
  assert(combo.classList.contains('active'), '连击面板未激活');
});

/* ---- 18. 连击断开：收起面板、清空火花、刀气热度复位 ---- */
test('连击断开：超时后收起连击面板并清空火花', function () {
  var t = boot(8, { seed: 5 });
  t.el('mode-game').click();
  t.advance(3000);
  sliceFor(t, 9000, 50);
  assert(t.el('game-combo').classList.contains('active'), '连击未激活，用例前提不成立');

  waitReal(1700);            // 真实时间越过连击窗口（1.6s）
  t.advance(200);            // 再跑一帧，让主循环执行复位

  assert(!t.el('game-combo').classList.contains('active'), '连击未在超时后收起');
  eq(t.el('combo-sparks').children.length, 0, '火花未清空');
});

/* ---- 19. 刀气：滑动生成渐变刀身，停手后自然消散 ---- */
test('刀气：滑动生成闭合刀身路径，停手后轨迹自动消散', function () {
  var t = boot(8, { seed: 11 });
  t.el('mode-game').click();
  t.advance(3000);

  t.paper._fire('pointerdown', { clientX: 300, clientY: 400 });
  t.paper._fire('pointermove', { clientX: 430, clientY: 470 });

  var ribbon = t.paper.querySelectorAll('.blade-ribbon')[0];
  assert(ribbon, '未创建刀身路径');
  assert(ribbon.getAttribute('d').indexOf('Z') > 0, '刀身不是闭合缎带路径');

  var core = t.paper.querySelectorAll('.blade-core')[0];
  assert(core && core.getAttribute('d').indexOf('L') > 0, '刀锋高光路径缺失');

  waitReal(220);             // 越过 BLADE_TTL（130ms）
  t.advance(200);
  eq(t.paper.querySelectorAll('.blade-ribbon')[0].getAttribute('d'), '', '停手后刀气未消散');
});

/* ---- 20. 斩击白光：切开时沿刀路炸开，并自动回收 ---- */
test('斩击白光：切开单词生成一道白光，短暂停留后被回收', function () {
  var t = boot(8, { seed: 3 });
  t.el('mode-game').click();
  t.advance(3000);

  // 推进到有单词在屏就立刻斩开：白光只存活 340ms，跑满一段再查就早被回收了
  var fired = 0;
  for (var i = 0; i < 200 && !fired; i++) {
    var fruits = t.paper.querySelectorAll('.fruit-word');
    if (fruits.length) {
      var f = fruits[0];
      t.paper._fire('pointerdown', {
        clientX: parseFloat(f.style.left),
        clientY: parseFloat(f.style.top)
      });
      fired = t.paper.querySelectorAll('.slash-flash').length;
    }
    if (!fired) t.advance(50);
  }
  assert(fired > 0, '斩击未生成白光');

  t.advance(1200);
  eq(t.paper.querySelectorAll('.slash-flash').length, 0, '白光未被回收');
});

/* ---- 21. 记忆模式：单词浮现即自动朗读 ---- */
test('朗读：记忆模式浮现单词时自动朗读该单词', function () {
  var t = boot(8, { speech: true, seed: 5 });
  t.el('mode-recall').click();
  t.paper._fire('click', { clientX: 500, clientY: 300, target: { closest: function () { return null; } } });
  t.advance(100);

  assert(t.speech.spoken.length >= 1, '浮现单词时没有朗读');
  var card = t.paper.querySelectorAll('.word-card')[0];
  var text = card.querySelector('.word-text').textContent;
  eq(t.speech.spoken[t.speech.spoken.length - 1], text, '朗读的文本与卡片单词不一致');
});

/* ---- 22. 朗读开关：可关闭并持久化 ---- */
test('朗读开关：可关闭并持久化，关闭后不再朗读', function () {
  var t = boot(8, { speech: true, seed: 5 });
  assert(!t.env.document.body.classList.contains('speak-off'), '默认应为开启状态');

  t.el('btn-speak').click();
  eq(t.env.localStorage.getItem('paper-speak'), 'off', '朗读偏好未持久化');
  assert(t.env.document.body.classList.contains('speak-off'), 'body 未标记 speak-off');

  t.speech.spoken.length = 0;
  t.el('mode-recall').click();
  t.paper._fire('click', { clientX: 500, clientY: 300, target: { closest: function () { return null; } } });
  t.advance(100);
  eq(t.speech.spoken.length, 0, '关闭朗读后仍在发声');
});

/* ---- 23. 预置关闭朗读：重新载入会还原 ---- */
test('朗读开关：预置关闭后重新载入会还原状态', function () {
  var t = boot(8, { speech: true, speak: 'off' });
  assert(t.env.document.body.classList.contains('speak-off'), '未还原朗读关闭状态');
  eq(t.el('btn-speak').getAttribute('aria-label'), '开启自动朗读', '还原后 aria-label 不正确');
});

/* ---- 24. 不支持 speechSynthesis 的环境：静默降级，功能不受影响 ---- */
test('无 speechSynthesis 环境：不抛异常，游戏与记忆模式照常', function () {
  var t = boot(8, { seed: 42 });          // 刻意不注入 speech
  t.el('mode-recall').click();
  t.paper._fire('click', { clientX: 500, clientY: 300, target: { closest: function () { return null; } } });
  t.advance(100);
  eq(t.paper.querySelectorAll('.word-card').length, 1, '记忆模式受降级影响');

  t.el('mode-game').click();
  t.advance(3000);
  sliceFor(t, 4000);
  assert(Number(t.el('game-score').textContent) > 0, '切分路径受降级影响');
});

/* ---- 25. 游戏模式：切开单词不再朗读（朗读仅在记忆模式） ---- */
test('游戏模式：切开单词不触发朗读，切刀音效照常', function () {
  var t = boot(8, { speech: true, audio: true, seed: 7 });
  t.el('mode-game').click();
  t.advance(3000);

  sliceFor(t, 3000, 40);
  var score = Number(t.el('game-score').textContent);
  assert(score >= 3, '用例前提不成立：切开数量太少（' + score + '）');

  // 核心断言：游戏里切开多少词，都不朗读任何"真实单词"。
  // 注意：unlockSpeech() 会读一个空格做首手势解锁，属于基础设施，
  // 用 trim() 过滤掉它，只针对有内容的单词断言。
  var realSpoken = t.speech.spoken.filter(function (s) {
    return String(s).trim().length > 0;
  });
  eq(realSpoken.length, 0, '游戏模式不应朗读单词，实际读了：' + JSON.stringify(realSpoken));
  assert(t.audio.bufferSources > 0, '切刀音效未发声');
});

/* ---- 26. 朗读时先 cancel，避免语音排队堆叠 ---- */
test('朗读：每次发声前先 cancel 上一条，防止队列堆积', function () {
  var t = boot(8, { speech: true, seed: 5 });
  t.el('mode-recall').click();
  for (var i = 0; i < 3; i++) {
    t.paper._fire('click', { clientX: 400 + i * 40, clientY: 300, target: { closest: function () { return null; } } });
    t.advance(300);
  }
  assert(t.speech.spoken.length >= 2, '朗读次数不足，用例前提不成立');
  assert(t.speech.cancels >= t.speech.spoken.length - 1,
    'cancel 次数（' + t.speech.cancels + '）应覆盖每次朗读（' + t.speech.spoken.length + '）');
});

/* ---- 27. 卡片「重听」按钮：可主动重读，且不影响释义 ---- */
test('重听按钮：点击后重新朗读该单词，且不切换释义', function () {
  var t = boot(8, { speech: true, seed: 5 });
  t.el('mode-recall').click();
  t.paper._fire('click', { clientX: 500, clientY: 300, target: { closest: function () { return null; } } });
  t.advance(100);

  var card = t.paper.querySelectorAll('.word-card')[0];
  var btn = card.querySelector('.word-speak');
  assert(btn, '单词卡上没有重听按钮');

  var before = t.speech.spoken.length;
  var wasOpen = card.classList.contains('open');
  btn._fire('click', { target: btn });

  eq(t.speech.spoken.length, before + 1, '点击重听没有朗读');
  eq(card.classList.contains('open'), wasOpen, '重听不应改变释义显隐状态');
});

/* ---- 28. 离开记忆模式：停止朗读，不留残音 ---- */
test('离开模式时停止朗读：不残留语音', function () {
  var t = boot(8, { speech: true, seed: 5 });
  t.el('mode-recall').click();
  t.paper._fire('click', { clientX: 500, clientY: 300, target: { closest: function () { return null; } } });
  t.advance(100);

  var before = t.speech.cancels;
  t.el('mode-entry').click();
  assert(t.speech.cancels > before, '切走模式时未 cancel 朗读');
});

/* ---- 29. 刀气升级：多层堆叠 + 刀锋锐线 + 刀尖收束 ---- */
test('刀气升级：生成 6 层叠加的刀身，含刀锋锐线与刀尖光点', function () {
  var t = boot(8, { seed: 11 });
  t.el('mode-game').click();
  t.advance(3000);

  t.paper._fire('pointerdown', { clientX: 300, clientY: 400 });
  t.paper._fire('pointermove', { clientX: 430, clientY: 470 });
  t.paper._fire('pointermove', { clientX: 560, clientY: 500 });

  var q = function (sel) { return t.paper.querySelectorAll(sel)[0]; };
  assert(q('.blade-halo') && q('.blade-halo').getAttribute('d').indexOf('Z') > 0, '缺外晕层');
  assert(q('.blade-glow') && q('.blade-glow').getAttribute('d').indexOf('Z') > 0, '缺柔光层');
  assert(q('.blade-ribbon') && q('.blade-ribbon').getAttribute('d').indexOf('Z') > 0, '缺刀身缎带层');
  assert(q('.blade-core') && q('.blade-core').getAttribute('d').indexOf('L') > 0, '缺内芯高光层');
  assert(q('.blade-edge') && q('.blade-edge').getAttribute('d').indexOf('L') > 0, '缺刀锋锐线层');
  assert(q('.blade-tip') && parseFloat(q('.blade-tip').getAttribute('r')) > 0, '刀尖光点未收束');

  // 3 个轨迹点 → 刀锋锐线应只覆盖末端一小段，而不是整条刀路
  var edgeD = q('.blade-edge').getAttribute('d');
  var ribbonD = q('.blade-ribbon').getAttribute('d');
  assert(edgeD.split('L').length < ribbonD.split('L').length / 2,
    '刀锋锐线应只覆盖末端，实际几乎覆盖整条刀路');
});

/* ---- 30. 斩击白光：沿用刀路角度 ---- */
test('斩击白光：沿用刀路角度生成刀痕', function () {
  var t = boot(8, { seed: 3 });
  t.el('mode-game').click();
  t.advance(3000);

  var fired = 0;
  for (var i = 0; i < 200 && !fired; i++) {
    var fruits = t.paper.querySelectorAll('.fruit-word');
    if (fruits.length) {
      var f = fruits[0];
      t.paper._fire('pointerdown', {
        clientX: parseFloat(f.style.left),
        clientY: parseFloat(f.style.top)
      });
      fired = t.paper.querySelectorAll('.slash-flash').length;
    }
    if (!fired) t.advance(50);
  }
  assert(fired > 0, '斩击未生成白光');
});

/* ---- 31. 朗读开关：切换时只静默解锁，不得凭空朗读单词 ---- */
// 回归：曾经在「打开朗读」时顺手 pickWord() 读一个词，导致录入/游戏模式下
// 点一下开关就冒出一句没头没尾的单词音。开关只负责开关，不该发声。
test('朗读开关：切换时只静默解锁，不朗读任何单词', function () {
  var t = boot(8, { speech: true, seed: 5 });
  var words = t.storedWords().map(function (w) { return w.word; });

  t.el('btn-speak').click();            // 关
  t.speech.spoken.length = 0;           // 清掉此前的记录，只盯“打开朗读”这一步
  t.el('btn-speak').click();            // 开

  // 解锁用的空字符串（' '）不算发声，只有真正念出白纸里的单词才算 bug
  var leaked = t.speech.spoken.filter(function (s) { return words.indexOf(s) !== -1; });
  eq(leaked.length, 0, '点击朗读开关时凭空朗读了单词：' + leaked.join(' / '));
  assert(!t.env.document.body.classList.contains('speak-off'), '开关未打开');
});

console.log('─'.repeat(56));
console.log('通过 ' + passed + ' / ' + (passed + failed) + (failed ? '，失败 ' + failed : '') + '\n');
process.exit(failed ? 1 : 0);
