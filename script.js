/**
 * 白纸单词 —— 简约单词记忆网站
 *
 * 核心逻辑：
 *  1) 多白纸：localStorage 键 `paper-papers`，值为
 *     { papers:[{ id, name, createdAt, words:[...] }], activeId }
 *     每张「白纸」是独立的一张纸，持有自己的单词数组；单词对象
 *     { id, word, definition, x, y, createdAt, recallCount }
 *     兼容旧版 `paper-words`（单词数组）→ 自动迁移为一张「我的白纸」
 *  2) 录入模式：点击纸张弹出浮动卡片 → 保存后写入当前白纸
 *  3) 记忆模式：点击空白浮现随机单词，点击单词切换释义显隐
 *  4) 白纸管理：首页「白纸夹」新建 / 切换 / 重命名 / 删除；工具栏名字即「保存白纸」
 *  5) 单词本：内置词库（wordbooks.js → window.WORDBOOKS）一键导入成一张普通白纸，
 *     与手写白纸同构，功能完全一致
 *  6) 动画：CSS animation，移除元素时清理定时器/监听，防止泄漏
 */
(function () {
  'use strict';

  /* ============ 常量 ============ */
  var PAPERS_KEY = 'paper-papers';
  var THEME_KEY = 'paper-theme';
  var SOUND_KEY = 'paper-sound';    // 音效开关（'off' 为静音，其余/缺省为开启）
  var SPEAK_KEY = 'paper-speak';    // 自动朗读开关（'off' 为关闭，其余/缺省为开启）
  var LEGACY_KEY = 'paper-words';   // 旧版（单词数组）兼容键

  /* 游戏模式常量 */
  var GAME_DURATION = 60;        // 单局时长（秒）
  var GAME_GRAVITY = 900;        // 重力加速度（px/s²）——配合抛高，飞得高且留白约 2 秒可读
  var COMBO_WINDOW = 1600;       // 连击判定窗口（毫秒）
  // 难度挡位：慢 / 标准 / 快 —— 控制生成间隔与同屏上限
  var GAME_LEVELS = [
    { label: '慢',   intervalMin: 1.10, intervalMax: 1.55, maxFruits: 4 },
    { label: '标准', intervalMin: 0.62, intervalMax: 1.00, maxFruits: 6 },
    { label: '快',   intervalMin: 0.38, intervalMax: 0.62, maxFruits: 8 }
  ];

  /* 切词音效常量（合成气声层：Web Audio 实时生成，无需任何音频文件） */
  var SOUND_F0 = 1000;        // 基准频率（Hz），combo=1 时的带通中心频率
  var SOUND_SWEEP = 2.6;      // 扫频冲高倍数：f0 → f0*2.6，制造「嗖」的划过感
  var SOUND_SWEEP_END = 2.2;  // 收尾回落到 f0*2.2
  var SOUND_MAX_SEMI = 12;    // 连击升调上限：12 半音 = 一个八度
  var SOUND_GAIN = 0.30;      // 基准峰值音量（合成气声层）
  var SOUND_DUR = 0.08;       // 单次音效时长（秒）
  var SOUND_CEIL_HZ = 11000;  // 扫频最高频率兜顶，防止高连击时刺耳

  /* 切词音效：真实挥刀采样 slice.mp3（与 html 同目录）
     用 <audio> 池播放而非 fetch + decodeAudioData —— 后者在 file:// 下会被 CORS 拦掉。
     采样缺失 / 播放失败时自动退回纯合成气声，功能不降级。 */
  var SLICE_SRC = 'slice.mp3';
  var SLICE_POOL = 5;         // 同时发声上限：连击密集时轮转复用
  var SLICE_VOLUME = 0.6;     // 采样基准音量
  var SLICE_AIR_MIX = 0.55;   // 采样已在响时，合成气声层的音量折减（垫底而非抢戏）
  var SLICE_RATE_STEP = 0.028;// 连击每 +1，采样升速（音高）步长
  var SLICE_RATE_STEPS = 10;  // 升速封顶步数，防止高连击变「花栗鼠」

  /* 朗读（Web Speech API）常量 */
  var SPEAK_LANG = 'en-US';       // 单词按英语朗读（释义不读，中文交给系统语音不稳）
  var SPEAK_RATE = 0.92;          // 语速：略慢于默认，便于跟读
  var SPEAK_PITCH = 1;            // 音高
  var SPEAK_VOLUME = 1;

  /* 连击段位：越高越「烫」，同时驱动配色、火花密度与刀气颜色 */
  var COMBO_TIERS = [
    { min: 12, tier: 5, label: '入神', sparks: 14 },
    { min: 9,  tier: 4, label: '疾风', sparks: 11 },
    { min: 6,  tier: 3, label: '凌厉', sparks: 8 },
    { min: 4,  tier: 2, label: '流畅', sparks: 6 },
    { min: 2,  tier: 1, label: '顺手', sparks: 4 }
  ];

  /* 刀气（滑动轨迹）常量 */
  var BLADE_TTL = 150;        // 轨迹点存活时长（毫秒）：决定拖尾长度与消散速度
  var BLADE_MAX_POINTS = 30;  // 轨迹点上限，超出丢弃最旧的
  var BLADE_W_MIN = 20;       // 刀身最细宽度（px）
  var BLADE_W_MAX = 46;       // 刀身最宽宽度（px）

  /* ============ 状态 ============ */
  var mode = null;             // 'entry' 录入 | 'recall' 记忆
  var papers = [];             // 所有白纸
  var activePaperId = null;    // 当前白纸 id
  var words = [];              // 当前白纸的单词数组（引用）
  var currentEntryCard = null;
  var currentWordEl = null;
  var lastWordId = null;

  /* 音效状态：ctx 懒创建（须在用户手势里），audioDead 为不支持/出错后的永久降级标记 */
  var audioCtx = null;
  var noiseBuffer = null;
  var soundOn = true;
  var audioDead = false;

  /* 挥刀采样状态：池化 <audio>，primed 标记是否已在手势里预解锁过 */
  var slicePool = [];
  var slicePoolIdx = 0;
  var slicePrimed = false;
  var sliceUnavailable = false;

  /* 朗读状态 */
  var speakOn = true;          // 用户开关（持久化到 SPEAK_KEY）
  var speakSupported = false;  // 浏览器是否支持 Web Speech API
  var speakVoice = null;       // 选定的英语发音人（异步加载，选定后缓存）
  var speakCurrentEl = null;   // 正在朗读的单词卡片元素（用于加 .speaking 反馈）
  var speakDead = false;       // 出错后的永久降级标记

  /* 游戏模式状态 */
  var game = {
    running: false,
    timeLeft: 0,
    score: 0,
    spawnedCount: 0,
    level: 1,               // 当前难度挡位索引（0 慢 / 1 标准 / 2 快）
    fruits: [],
    debris: [],
    spawnTimer: 0,
    slicedIds: [],
    combo: 0,               // 当前连击数
    bestCombo: 0,           // 本局最高连击（结算展示）
    lastSliceTs: 0,         // 上次斩开时间戳（毫秒）
    lastTs: 0,
    pointerDown: false,
    reduced: false,
    bladePoints: [],
    // —— 生命周期追踪：所有异步资源都要能被 stopGame() 一次性作废 ——
    token: 0,           // 世代令牌：每次 start/stop 自增，用于作废旧倒计时与旧动画帧
    loopToken: 0,       // 当前有效主循环所属的世代
    finished: false,    // 是否已打完一局（决定再点「游戏」是重开还是忽略）
    rafId: 0,           // requestAnimationFrame 句柄
    countdownTimer: 0,  // 开场倒计时的 setTimeout 句柄
    timers: []          // 其余延时任务（释义浮现、+1 飘字）的句柄
  };
  var bladeLayer = null;
  var bladeGrad = null;
  var bladeHalo = null;
  var bladeGlow = null;
  var bladeRibbon = null;
  var bladeCore = null;
  var bladeTip = null;
  var bladeEdge = null;

  /* ============ DOM 引用 ============ */
  var paper = document.getElementById('paper');
  var hintEl = document.getElementById('hint');
  var wordCountEl = document.getElementById('word-count');
  var modeEntryBtn = document.getElementById('mode-entry');
  var modeRecallBtn = document.getElementById('mode-recall');
  var clearBtn = document.getElementById('btn-clear');
  var exportBtn = document.getElementById('btn-export');
  var importBtn = document.getElementById('btn-import');
  var importFileInput = document.getElementById('import-file');
  var statsBtn = document.getElementById('btn-stats');
  var themeBtn = document.getElementById('btn-theme');
  var soundBtn = document.getElementById('btn-sound');
  var speakBtn = document.getElementById('btn-speak');
  var statsPanel = document.getElementById('stats-panel');
  var statsList = document.getElementById('stats-list');
  var statsClose = document.getElementById('stats-close');
  var toastEl = document.getElementById('toast');
  var tplEntryCard = document.getElementById('tpl-entry-card');
  var tplWordCard = document.getElementById('tpl-word-card');
  var homeEl = document.getElementById('home');
  var appEl = document.getElementById('app');
  var homeEntryBtn = document.getElementById('home-entry');
  var homeRecallBtn = document.getElementById('home-recall');
  var homeCount = document.getElementById('home-count');
  var brandBtn = document.getElementById('btn-home');
  // 白纸管理相关
  var shelfList = document.getElementById('shelf-list');
  var shelfNewBtn = document.getElementById('shelf-new');
  var paperNameBtn = document.getElementById('btn-paper-name');
  var paperNameTextEl = document.getElementById('paper-name-text');
  var paperDialog = document.getElementById('paper-dialog');
  var paperDialogInput = document.getElementById('paper-dialog-name');
  var paperDialogSave = document.getElementById('paper-dialog-save');
  var paperDialogCancel = document.getElementById('paper-dialog-cancel');
  var paperDialogClose = document.getElementById('paper-dialog-close');

  // 单词本（内置词库）相关
  var shelfBooksBtn = document.getElementById('shelf-books');
  var wordbookPanel = document.getElementById('wordbook-panel');
  var wordbookList = document.getElementById('wordbook-list');
  var wordbookCloseBtn = document.getElementById('wordbook-close');

  // 游戏模式相关
  var modeGameBtn = document.getElementById('mode-game');
  var gameHud = document.getElementById('game-hud');
  var gameTimerEl = document.getElementById('game-timer');
  var gameScoreEl = document.getElementById('game-score');
  var gameTimebar = document.getElementById('game-timebar');
  var gameTimebarFill = document.getElementById('game-timebar-fill');
  var gameCountdown = document.getElementById('game-countdown');
  var gameCountdownValue = document.getElementById('game-countdown-value');
  var gameOverPanel = document.getElementById('game-over-panel');
  var gameOverBody = document.getElementById('game-over-body');
  var gameOverClose = document.getElementById('game-over-close');
  var gameAgain = document.getElementById('game-again');
  var gameExit = document.getElementById('game-exit');
  var gameLevelBtns = document.querySelectorAll('.game-level-btn');
  var gameCombo = document.getElementById('game-combo');
  var gameComboCount = document.getElementById('game-combo-count');
  var comboTierEl = document.getElementById('combo-tier');
  var comboSparks = document.getElementById('combo-sparks');

  /* ============ 通用工具 ============ */
  function makeId() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }
  function makePaper(name) {
    return { id: makeId(), name: name || '', createdAt: Date.now(), words: [] };
  }
  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }
  function randomX() { return 40 + Math.random() * (window.innerWidth - 80); }
  function randomY() { return 120 + Math.random() * (window.innerHeight - 220); }
  /** 写 CSS 自定义属性；无 style.setProperty 的环境（如测试桩）静默跳过 */
  function setCssVar(el, name, value) {
    if (el && el.style && typeof el.style.setProperty === 'function') {
      el.style.setProperty(name, String(value));
    }
  }
  /** 取连击所属段位（COMOB_TIERS 按 min 从大到小排列，取第一个满足的） */
  function comboTier(n) {
    for (var i = 0; i < COMBO_TIERS.length; i++) {
      if (n >= COMBO_TIERS[i].min) return COMBO_TIERS[i];
    }
    return { min: 2, tier: 1, label: '顺手', sparks: 4 };
  }

  /* ============ 数据存储（多白纸） ============ */
  function loadPapers() {
    // 1) 优先读取新格式
    try {
      var raw = localStorage.getItem(PAPERS_KEY);
      if (raw) {
        var data = JSON.parse(raw);
        if (data && Array.isArray(data.papers)) {
          return { papers: data.papers, activeId: data.activeId || null };
        }
      }
    } catch (e) { console.warn('读取白纸数据失败', e); }
    // 2) 迁移旧版单词数组 → 一张白纸
    try {
      var legacy = localStorage.getItem(LEGACY_KEY);
      if (legacy) {
        var arr = JSON.parse(legacy);
        if (Array.isArray(arr)) {
          var p = makePaper('我的白纸');
          p.words = arr;
          localStorage.removeItem(LEGACY_KEY);
          localStorage.setItem(PAPERS_KEY, JSON.stringify({ papers: [p], activeId: p.id }));
          return { papers: [p], activeId: p.id };
        }
      }
    } catch (e) { console.warn('迁移旧数据失败', e); }
    return { papers: [], activeId: null };
  }

  function activePaper() {
    for (var i = 0; i < papers.length; i++) {
      if (papers[i].id === activePaperId) return papers[i];
    }
    return papers[0] || null;
  }
  function findPaper(id) {
    for (var i = 0; i < papers.length; i++) if (papers[i].id === id) return papers[i];
    return null;
  }

  // 将 words 引用同步到当前白纸，并更新工具栏名称
  function syncActiveWords() {
    var p = activePaper();
    words = p ? p.words : [];
    paperNameTextEl.textContent = (p && p.name) ? p.name : '未命名白纸';
  }

  // 持久化整份白纸数据；words 是对 activePaper.words 的引用，原地修改即可
  function savePapers() {
    try {
      localStorage.setItem(PAPERS_KEY, JSON.stringify({ papers: papers, activeId: activePaperId }));
    } catch (e) {
      console.warn('写入 localStorage 失败', e);
      // 词库存了全量后，单词多的白纸可能撑满配额，给出可操作的提示
      var quota = e && (e.name === 'QuotaExceededError' ||
        e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22 || e.code === 1014);
      showToast(quota ? '浏览器存储已满：请删掉部分白纸再导入' : '保存失败：浏览器存储不可用');
    }
    updateCount();
    renderShelf();
  }

  // 兼容旧调用点：任何单词变更都走 savePapers
  function saveWords() { savePapers(); }

  function updateCount() {
    var n = words.length;
    wordCountEl.textContent = n + ' 个单词';
    wordCountEl.setAttribute('aria-label', '当前白纸 ' + n + ' 个单词');

    var totalWords = 0;
    for (var i = 0; i < papers.length; i++) totalWords += papers[i].words.length;
    homeCount.textContent = papers.length > 0
      ? '共 ' + papers.length + ' 张白纸 · ' + totalWords + ' 个单词'
      : '还没有白纸，点击下方「新建」开始';
  }

  /* ============ 白纸管理 ============ */
  function findPaperByName(name) {
    for (var i = 0; i < papers.length; i++) if (papers[i].name === name) return true;
    return false;
  }
  function nextPaperName() {
    var base = papers.length + 1;
    var name = '白纸 ' + base;
    while (findPaperByName(name)) { base += 1; name = '白纸 ' + base; }
    return name;
  }

  function createPaper(name) {
    var p = makePaper(name || nextPaperName());
    papers.push(p);
    activePaperId = p.id;
    syncActiveWords();
    savePapers();
    return p;
  }
  function ensurePaper() {
    if (!activePaper()) createPaper();
  }

  function switchPaper(id) {
    if (activePaperId === id) return;
    dismissWord();
    cancelEntry(false);
    activePaperId = id;
    syncActiveWords();
    savePapers();
  }

  function renamePaper(id, name) {
    var p = findPaper(id);
    if (!p) return;
    p.name = name;
    syncActiveWords();
    savePapers();
  }

  function deletePaper(id) {
    var idx = -1;
    for (var i = 0; i < papers.length; i++) if (papers[i].id === id) { idx = i; break; }
    if (idx === -1) return;
    var p = papers[idx];
    var label = p.name || '未命名白纸';
    if (!window.confirm('确定要删除「' + label + '」及其 ' + p.words.length + ' 个单词吗？此操作不可恢复。')) return;

    papers.splice(idx, 1);
    if (activePaperId === id) {
      var next = papers[idx] || papers[idx - 1] || null;
      activePaperId = next ? next.id : null;
    }
    syncActiveWords();
    savePapers();
    if (!activePaperId) goHome(); // 全部删除后回到首页空状态
  }

  /* ---------- 白纸夹渲染（首页） ---------- */
  var ICON_PENCIL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>';
  var ICON_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>';

  function renderShelf() {
    shelfList.innerHTML = '';

    if (papers.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'shelf-empty';
      empty.textContent = '还没有白纸，点击右上「新建」创建第一张';
      shelfList.appendChild(empty);
      return;
    }

    papers.forEach(function (p) {
      var card = document.createElement('div');
      card.className = 'paper-card' + (p.id === activePaperId ? ' active' : '');
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      card.setAttribute('aria-label', '打开白纸「' + (p.name || '未命名白纸') + '」，' + p.words.length + ' 个单词');

      var nameEl = document.createElement('div');
      nameEl.className = 'paper-card-name';
      nameEl.textContent = p.name || '未命名白纸';

      var countEl = document.createElement('div');
      countEl.className = 'paper-card-count';
      countEl.textContent = p.words.length + ' 个单词';

      var actions = document.createElement('div');
      actions.className = 'paper-card-actions';

      var renameBtn = document.createElement('button');
      renameBtn.className = 'paper-icon-btn';
      renameBtn.setAttribute('aria-label', '重命名「' + (p.name || '未命名白纸') + '」');
      renameBtn.innerHTML = ICON_PENCIL;
      renameBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        openPaperDialog(p.id);
      });

      var delBtn = document.createElement('button');
      delBtn.className = 'paper-icon-btn';
      delBtn.setAttribute('aria-label', '删除「' + (p.name || '未命名白纸') + '」');
      delBtn.innerHTML = ICON_TRASH;
      delBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        deletePaper(p.id);
      });

      actions.appendChild(renameBtn);
      actions.appendChild(delBtn);

      card.appendChild(nameEl);
      card.appendChild(countEl);
      card.appendChild(actions);

      card.addEventListener('click', function () {
        switchPaper(p.id);
        enterApp('entry');
      });
      card.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          switchPaper(p.id);
          enterApp('entry');
        }
      });

      shelfList.appendChild(card);
    });
  }

  /* ---------- 保存白纸（命名）对话框 ---------- */
  var renameTargetId = null;
  function openPaperDialog(id) {
    renameTargetId = id || activePaperId;
    var p = findPaper(renameTargetId);
    if (!p) return;
    paperDialogInput.value = p.name || '';
    paperDialog.classList.add('open');
    paperDialog.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(function () { paperDialogInput.focus(); paperDialogInput.select(); });
  }
  function closePaperDialog() {
    paperDialog.classList.remove('open');
    paperDialog.setAttribute('aria-hidden', 'true');
    renameTargetId = null;
  }
  function commitPaperName() {
    var name = paperDialogInput.value.trim();
    if (!name) {
      paperDialogInput.focus();
      showToast('白纸名称不能为空');
      return;
    }
    renamePaper(renameTargetId, name);
    closePaperDialog();
    showToast('已保存白纸「' + name + '」');
  }

  /* ============ 单词本（内置词库 → 导入成白纸） ============ */
  // 词库由 wordbooks.js 注入到 window.WORDBOOKS：{ id, name, tag, desc, count, data }
  // data 为紧凑文本，每行 "word|释义"。导入后生成的就是一张普通白纸，
  // 与用户手写的白纸共用同一数据结构，因此录入/记忆/游戏全部功能一致。
  function getWordbooks() {
    var raw = (typeof window !== 'undefined' && window.WORDBOOKS) || [];
    return Array.isArray(raw) ? raw : [];
  }

  /** 解析词库紧凑数据 → 标准单词对象数组（含网格定位，避免完全重叠） */
  function parseBookWords(book) {
    var text = (book && book.data) || '';
    if (!text) return [];
    var lines = text.split('\n');
    var cols = 6;
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line) continue;
      var bar = line.indexOf('|');
      var w = (bar === -1 ? line : line.slice(0, bar)).trim();
      if (!w) continue;
      var d = bar === -1 ? '' : line.slice(bar + 1);
      var col = i % cols;
      var row = Math.floor(i / cols) % 5;
      out.push({
        id: makeId(),
        word: w,
        definition: d,
        x: clamp(0.12 + col * 0.15 + (Math.random() - 0.5) * 0.04, 0.04, 0.96),
        y: clamp(0.22 + row * 0.14 + (Math.random() - 0.5) * 0.04, 0.06, 0.94),
        createdAt: Date.now(),
        recallCount: 0
      });
    }
    return out;
  }

  /** 同名白纸自动加序号，避免覆盖已有白纸 */
  function uniquePaperName(base) {
    var name = base || '单词本';
    if (!findPaperByName(name)) return name;
    var n = 2;
    while (findPaperByName(name + ' ' + n)) n++;
    return name + ' ' + n;
  }

  /** 导入一本词库：新建一张白纸并直接进入录入模式 */
  function importWordbook(book) {
    if (!book) return;
    var list = parseBookWords(book);
    if (!list.length) { showToast('这个词库没有可导入的单词'); return; }
    var p = makePaper(uniquePaperName(book.name));
    p.words = list;
    p.source = 'wordbook:' + (book.id || '');
    papers.push(p);
    activePaperId = p.id;
    syncActiveWords();
    savePapers();
    closeWordbookPanel();
    homeEl.classList.add('leaving');
    appEl.classList.add('active');
    setMode('entry');
    showToast('已导入「' + p.name + '」· ' + list.length + ' 个单词');
  }

  function renderWordbooks() {
    if (!wordbookList) return;
    wordbookList.innerHTML = '';
    var books = getWordbooks();
    if (!books.length) {
      var empty = document.createElement('div');
      empty.className = 'wordbook-empty';
      empty.textContent = '暂无可导入的词库';
      wordbookList.appendChild(empty);
      return;
    }

    // 词库变多后按 group 分组呈现（group 缺省归入「其他」）
    var lastGroup = null;
    books.forEach(function (book) {
      var group = book.group || '其他';
      if (group !== lastGroup) {
        lastGroup = group;
        var groupNum = 0;
        for (var gi = 0; gi < books.length; gi++) {
          if ((books[gi].group || '其他') === group) groupNum++;
        }
        var groupHead = document.createElement('div');
        groupHead.className = 'wordbook-group';
        var groupName = document.createElement('span');
        groupName.className = 'wordbook-group-name';
        groupName.textContent = group;
        var groupCount = document.createElement('span');
        groupCount.className = 'wordbook-group-num';
        groupCount.textContent = groupNum + ' 本';
        groupHead.appendChild(groupName);
        groupHead.appendChild(groupCount);
        wordbookList.appendChild(groupHead);
      }

      var card = document.createElement('div');
      card.className = 'wordbook-card';

      var badge = document.createElement('div');
      badge.className = 'wordbook-badge';
      badge.textContent = book.tag || '词库';

      var info = document.createElement('div');
      info.className = 'wordbook-info';

      var nameEl = document.createElement('div');
      nameEl.className = 'wordbook-name';
      nameEl.textContent = book.name || '未命名词库';

      var count = (typeof book.count === 'number') ? book.count : parseBookWords(book).length;
      info.appendChild(nameEl);
      if (book.desc) {
        var descEl = document.createElement('div');
        descEl.className = 'wordbook-desc';
        descEl.textContent = book.desc;
        info.appendChild(descEl);
      }
      var countEl = document.createElement('div');
      countEl.className = 'wordbook-count';
      countEl.textContent = count + ' 个单词';
      info.appendChild(countEl);

      var importBtn = document.createElement('button');
      importBtn.type = 'button';
      importBtn.className = 'wordbook-import';
      importBtn.textContent = '导入';
      importBtn.setAttribute('aria-label', '导入「' + (book.name || '词库') + '」为白纸');
      importBtn.addEventListener('click', function () { importWordbook(book); });

      card.appendChild(badge);
      card.appendChild(info);
      card.appendChild(importBtn);
      wordbookList.appendChild(card);
    });
  }

  function openWordbookPanel() {
    renderWordbooks();
    wordbookPanel.classList.add('open');
    wordbookPanel.setAttribute('aria-hidden', 'false');
  }
  function closeWordbookPanel() {
    wordbookPanel.classList.remove('open');
    wordbookPanel.setAttribute('aria-hidden', 'true');
  }

  /* ============ 点击涟漪 ============ */
  function spawnRipple(clientX, clientY) {
    var ripple = document.createElement('span');
    ripple.className = 'ripple';
    ripple.style.left = clientX + 'px';
    ripple.style.top = clientY + 'px';
    paper.appendChild(ripple);
    ripple.addEventListener('animationend', function () { ripple.remove(); });
  }

  /* ============ Toast 提示 ============ */
  var toastTimer = null;
  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 1800);
  }

  /* ============ 淡出移除（含回退定时器，防泄漏） ============ */
  function fadeOutAndRemove(el, animClass, animName, duration) {
    el.classList.add(animClass);
    var onEnd = function (ev) {
      if (ev.animationName === animName) {
        clearTimeout(el._removeTimer);
        el.remove();
      }
    };
    el.addEventListener('animationend', onEnd);
    el._removeTimer = setTimeout(function () { el.remove(); }, duration + 60);
  }

  /* ============ 模式切换 ============ */
  // 三个模式按钮互斥：同一时刻只有一个是 active / aria-pressed=true
  function syncModeButtons() {
    modeEntryBtn.classList.toggle('active', mode === 'entry');
    modeEntryBtn.setAttribute('aria-pressed', String(mode === 'entry'));
    modeRecallBtn.classList.toggle('active', mode === 'recall');
    modeRecallBtn.setAttribute('aria-pressed', String(mode === 'recall'));
    modeGameBtn.classList.toggle('active', mode === 'game');
    modeGameBtn.setAttribute('aria-pressed', String(mode === 'game'));
  }

  function setMode(next) {
    if (mode === next) return;
    if (next === 'game' && words.length === 0) {
      showToast('这张白纸还没有单词，请先录入一些单词');
      return;
    }

    var prev = mode;
    if (prev === 'game') stopGame();
    if (prev === 'recall') stopSpeaking();   // 离开记忆模式时别让语音继续念

    mode = next;
    syncModeButtons();

    if (mode === 'entry') {
      hintEl.textContent = '点击纸张任意位置录入单词';
      dismissWord();
    } else if (mode === 'recall') {
      hintEl.textContent = '点击空白处浮现单词 · 点击单词查看释义';
      cancelEntry(false);
    } else if (mode === 'game') {
      hintEl.textContent = '滑动划开单词 · 斩断后浮现释义';
      dismissWord();
      cancelEntry(false);
      enterGame();
    }
  }

  /* ============ 首页 / 应用切换 ============ */
  function enterApp(nextMode) {
    ensurePaper();
    if (nextMode === 'recall' && words.length === 0) {
      showToast('这张白纸还没有单词，请先录入一些单词');
      homeEntryBtn.classList.remove('shake');
      void homeEntryBtn.offsetWidth; // 强制重排以重新触发抖动动画
      homeEntryBtn.classList.add('shake');
      return;
    }
    homeEl.classList.add('leaving');
    appEl.classList.add('active');
    setMode(nextMode);
  }

  function goHome() {
    stopGame();
    dismissWord();
    cancelEntry(false);
    closeStats();
    closePaperDialog();
    closeWordbookPanel();
    stopSpeaking();
    appEl.classList.remove('active');
    homeEl.classList.remove('leaving');
    renderShelf();
  }

  /* ============ 录入模式 ============ */
  function openEntryCard(clientX, clientY) {
    cancelEntry(false);

    var card = tplEntryCard.content.firstElementChild.cloneNode(true);
    currentEntryCard = card;
    paper.appendChild(card);
    card.classList.add('appearing');

    var w = card.offsetWidth;
    var h = card.offsetHeight;
    card.style.left = clamp(clientX - w / 2, 8, window.innerWidth - w - 8) + 'px';
    card.style.top = clamp(clientY - h / 2, 8, window.innerHeight - h - 8) + 'px';

    var wordInput = card.querySelector('.entry-word');
    var defInput = card.querySelector('.entry-def');
    var saveBtn = card.querySelector('.save-btn');
    var cancelBtn = card.querySelector('.cancel-btn');

    requestAnimationFrame(function () { wordInput.focus(); });

    function saveEntry() {
      var word = wordInput.value.trim();
      var definition = defInput.value.trim();
      if (!word) { wordInput.focus(); return; } // 单词必填，释义可空

      words.push({
        id: makeId(),
        word: word,
        definition: definition,
        x: clientX / window.innerWidth,   // 相对宽度比例 0~1
        y: clientY / window.innerHeight,   // 相对高度比例 0~1
        createdAt: Date.now(),
        recallCount: 0
      });
      saveWords();
      closeEntryCard(card);
    }

    saveBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      saveEntry();
    });
    cancelBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      cancelEntry(true);
    });

    [wordInput, defInput].forEach(function (input) {
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          saveEntry();
        } else if (e.key === 'Escape') {
          e.stopPropagation();
          cancelEntry(true);
        }
      });
    });
  }

  function cancelEntry(animated) {
    if (!currentEntryCard) return;
    var card = currentEntryCard;
    currentEntryCard = null;
    if (animated) {
      fadeOutAndRemove(card, 'closing', 'card-out', 220);
    } else {
      card.remove();
    }
  }

  function closeEntryCard(card) {
    if (currentEntryCard === card) currentEntryCard = null;
    fadeOutAndRemove(card, 'closing', 'card-out', 220);
  }

  /* ============ 记忆模式 ============ */
  function revealNextWord(clientX, clientY) {
    if (words.length === 0) {
      showToast('这张白纸还没有单词，请先切换到「录入」模式添加');
      return;
    }

    dismissWord();

    var word = pickWord();
    lastWordId = word.id;

    var card = tplWordCard.content.firstElementChild.cloneNode(true);
    card.querySelector('.word-text').textContent = word.word;
    card.querySelector('.definition').textContent = word.definition;
    card.dataset.id = word.id;

    currentWordEl = card;
    paper.appendChild(card);

    var w = card.offsetWidth;
    var h = card.offsetHeight;
    var dx = (Math.random() * 24) - 12;
    var dy = (Math.random() * 16) - 8;
    card.style.left = clamp(clientX - w / 2 + dx, 8, window.innerWidth - w - 8) + 'px';
    card.style.top = clamp(clientY - h / 2 + dy, 8, window.innerHeight - h - 8) + 'px';

    requestAnimationFrame(function () { card.classList.add('appearing'); });

    // 自动朗读：单词一浮现就读出来，形成"看到即听到"的记忆绑定。
    // force=true 跳过冷却 —— 记忆模式是用户主动唤出单词，节奏由人控制，不该被冷却吞掉。
    speakWord(word.word, card);

    card.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleDefinition(card);
      }
    });

    // 卡片上的「重听」按钮：主动再读一遍，不影响释义显隐
    var speakBtnOnCard = card.querySelector('.word-speak');
    if (speakBtnOnCard) {
      speakBtnOnCard.addEventListener('click', function (e) {
        e.stopPropagation();
        speakWord(word.word, card);
      });
    }

    word.recallCount = (word.recallCount || 0) + 1;
    saveWords();
  }

  function pickWord() {
    if (words.length === 1) return words[0];
    var pool = words.filter(function (w) { return w.id !== lastWordId; });
    if (pool.length === 0) pool = words;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function dismissWord() {
    if (!currentWordEl) return;
    var el = currentWordEl;
    currentWordEl = null;
    fadeOutAndRemove(el, 'fading', 'word-out', 450);
  }

  function toggleDefinition(card) {
    var willOpen = !card.classList.contains('open');
    card.classList.toggle('open', willOpen);
    card.setAttribute('aria-expanded', String(willOpen));
    if (willOpen) {
      card.addEventListener('transitionend', function onEnd(ev) {
        if (ev.propertyName === 'max-height') {
          ensureVisible(card);
          card.removeEventListener('transitionend', onEnd);
        }
      });
    }
  }

  function ensureVisible(el) {
    var rect = el.getBoundingClientRect();
    var dy = 0;
    if (rect.bottom > window.innerHeight - 10) dy = (window.innerHeight - 10) - rect.bottom;
    if (rect.top < 10) dy = 10 - rect.top;
    if (dy !== 0) el.style.top = (el.offsetTop + dy) + 'px';
  }

  /* ============ 纸张点击分发 ============ */
  paper.addEventListener('click', function (e) {
    if (mode === 'game') return;
    spawnRipple(e.clientX, e.clientY);

    if (mode === 'entry') {
      if (currentEntryCard && currentEntryCard.contains(e.target)) return;
      openEntryCard(e.clientX, e.clientY);
    } else {
      var wordCard = e.target.closest('.word-card');
      if (wordCard) {
        if (wordCard.classList.contains('fading')) return;
        toggleDefinition(wordCard);
        return;
      }
      revealNextWord(e.clientX, e.clientY);
    }
  });

  /* ============ 键盘快捷键 ============ */
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && statsPanel.classList.contains('open')) {
      closeStats();
      return;
    }
    if (e.key === 'Escape' && paperDialog.classList.contains('open')) {
      closePaperDialog();
      return;
    }
    if (e.key === 'Escape' && wordbookPanel.classList.contains('open')) {
      closeWordbookPanel();
      return;
    }

    if (mode === 'game') {
      if (e.key === 'Escape') setMode('entry');
      return;
    }

    var isTyping = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');

    if (mode === 'entry') {
      if (e.key === 'Escape' && !isTyping) cancelEntry(true);
      return;
    }

    if (e.key === 'Escape') {
      dismissWord();
    } else if (e.key === ' ' && !isTyping) {
      var onWord = e.target.closest ? e.target.closest('.word-card') : null;
      if (!onWord) {
        e.preventDefault();
        revealNextWord(randomX(), randomY());
      }
    }
  });

  /* ============ 首页按钮 / 返回首页 ============ */
  homeEntryBtn.addEventListener('click', function () { enterApp('entry'); });
  homeRecallBtn.addEventListener('click', function () { enterApp('recall'); });
  brandBtn.addEventListener('click', goHome);

  /* ============ 白纸管理事件 ============ */
  shelfNewBtn.addEventListener('click', function () {
    createPaper();
    enterApp('entry');
  });
  shelfBooksBtn.addEventListener('click', openWordbookPanel);
  wordbookCloseBtn.addEventListener('click', closeWordbookPanel);
  wordbookPanel.addEventListener('click', function (e) { if (e.target === wordbookPanel) closeWordbookPanel(); });
  paperNameBtn.addEventListener('click', function () { openPaperDialog(activePaperId); });
  paperDialogSave.addEventListener('click', commitPaperName);
  paperDialogCancel.addEventListener('click', closePaperDialog);
  paperDialogClose.addEventListener('click', closePaperDialog);
  paperDialog.addEventListener('click', function (e) { if (e.target === paperDialog) closePaperDialog(); });
  paperDialogInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitPaperName();
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      closePaperDialog();
    }
  });

  /* ============ 工具栏：模式切换 ============ */
  modeEntryBtn.addEventListener('click', function () { setMode('entry'); });
  modeRecallBtn.addEventListener('click', function () { setMode('recall'); });
  modeGameBtn.addEventListener('click', function () {
    unlockAudio(); // 真实用户手势里唤醒 AudioContext（倒计时约 2s，足够解锁）
    unlockSpeech(); // 同一个手势里顺便解锁语音合成（iOS 要求）
    // 打完一局后再点「游戏」= 重开；倒计时/游玩中的重复点击忽略，避免重复触发
    if (mode === 'game' && game.finished) { closeGameOver(); enterGame(); return; }
    setMode('game');
  });

  /* ============ 游戏模式：结算面板按钮 ============ */
  gameAgain.addEventListener('click', function () { closeGameOver(); enterGame(); });
  gameExit.addEventListener('click', function () { closeGameOver(); setMode('entry'); });
  gameOverClose.addEventListener('click', function () { closeGameOver(); setMode('entry'); });

  /* ============ 工具栏：清除（当前白纸） ============ */
  clearBtn.addEventListener('click', function () {
    if (words.length === 0) { showToast('当前白纸还没有单词可清除'); return; }
    var label = (activePaper() && activePaper().name) || '未命名白纸';
    if (window.confirm('确定要清除「' + label + '」的 ' + words.length + ' 个单词吗？此操作不可恢复。')) {
      words.length = 0; // 原地清空，保持对 activePaper.words 的引用
      saveWords();
      dismissWord();
      showToast('已清除「' + label + '」的所有单词');
    }
  });

  /* ============ 工具栏：导出 / 导入（当前白纸） ============ */
  exportBtn.addEventListener('click', function () {
    if (words.length === 0) { showToast('当前白纸暂无数据可导出'); return; }
    var label = (activePaper() && activePaper().name) || 'paper';
    var blob = new Blob([JSON.stringify(words, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = label + '-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast('已导出「' + label + '」的 ' + words.length + ' 个单词');
  });

  importBtn.addEventListener('click', function () { importFileInput.click(); });

  importFileInput.addEventListener('change', function (e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(reader.result);
        if (!Array.isArray(data)) throw new Error('格式错误');
        var imported = data.filter(function (w) { return w && typeof w.word === 'string'; });
        imported.forEach(function (w) {
          words.push({
            id: w.id || makeId(),
            word: w.word,
            definition: w.definition || '',
            x: Number(w.x) || 0,
            y: Number(w.y) || 0,
            createdAt: w.createdAt || Date.now(),
            recallCount: Number(w.recallCount) || 0
          });
        });
        saveWords();
        showToast('已导入 ' + imported.length + ' 个单词到当前白纸');
      } catch (err) {
        showToast('导入失败：文件格式不正确');
      }
    };
    reader.readAsText(file);
    e.target.value = ''; // 允许重复选择同一文件
  });

  /* ============ 工具栏：统计面板（当前白纸） ============ */
  statsBtn.addEventListener('click', function () {
    if (statsPanel.classList.contains('open')) closeStats();
    else openStats();
  });
  statsClose.addEventListener('click', closeStats);
  statsPanel.addEventListener('click', function (e) {
    if (e.target === statsPanel) closeStats();
  });

  function openStats() {
    renderStats();
    statsPanel.classList.add('open');
    statsPanel.setAttribute('aria-hidden', 'false');
  }
  function closeStats() {
    statsPanel.classList.remove('open');
    statsPanel.setAttribute('aria-hidden', 'true');
  }

  function renderStats() {
    statsList.innerHTML = '';
    if (words.length === 0) {
      statsList.innerHTML = '<div class="empty">当前白纸还没有单词</div>';
      return;
    }
    var sorted = words.slice().sort(function (a, b) {
      return (b.recallCount || 0) - (a.recallCount || 0);
    });
    sorted.forEach(function (w) {
      var row = document.createElement('div');
      row.className = 'stat-row';

      var wordSpan = document.createElement('span');
      wordSpan.className = 'stat-word';
      wordSpan.textContent = w.word;

      var defSpan = document.createElement('span');
      defSpan.className = 'stat-def';
      defSpan.textContent = w.definition;

      var countSpan = document.createElement('span');
      countSpan.className = 'stat-count';
      countSpan.textContent = (w.recallCount || 0) + ' 次';

      row.appendChild(wordSpan);
      row.appendChild(defSpan);
      row.appendChild(countSpan);
      statsList.appendChild(row);
    });
  }

  /* ============ 工具栏：夜间模式 ============ */
  // 图标通过 CSS（body.dark 显隐 .icon-moon/.icon-sun）切换，JS 只负责状态与无障碍标签
  function applyTheme() {
    var dark = localStorage.getItem(THEME_KEY) === 'dark';
    document.body.classList.toggle('dark', dark);
    themeBtn.setAttribute('aria-label', dark ? '切换到日间模式' : '切换到夜间模式');
  }
  themeBtn.addEventListener('click', function () {
    var dark = document.body.classList.toggle('dark');
    localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light');
    themeBtn.setAttribute('aria-label', dark ? '切换到日间模式' : '切换到夜间模式');
  });

  /* ============ 工具栏：音效开关（切词音效 · Web Audio 实时合成） ============ */
  // 不依赖任何音频文件：白噪声经带通滤波扫频，做出刀锋划过的「嗖」声。
  // 图标通过 CSS（body.sound-off 显隐 .icon-sound-on/.icon-sound-off）切换。

  /** 懒创建 AudioContext 并缓存噪声 buffer；不支持或出错时返回 null 并永久降级。
      已存在但处于 suspended（多数浏览器自动播放策略所致）时主动 resume，避免气声哑火 */
  function getAudioCtx() {
    if (audioDead) return null;
    if (audioCtx) {
      if (audioCtx.state === 'suspended') { try { audioCtx.resume(); } catch (e) {} }
      return audioCtx;
    }
    var Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) { audioDead = true; return null; }
    try {
      audioCtx = new Ctor();
      // 0.1s 白噪声，只生成一次，之后每次播放复用同一个 buffer
      var len = Math.floor(audioCtx.sampleRate * 0.1);
      noiseBuffer = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
      var data = noiseBuffer.getChannelData(0);
      for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    } catch (e) {
      audioDead = true;
      audioCtx = null;
      noiseBuffer = null;
    }
    return audioCtx;
  }

  /* ---------- 挥刀采样（slice.mp3） ---------- */
  /** 建池：5 个 <audio> 轮转，让密集连击也能叠着响而不互相打断 */
  function initSliceSound() {
    if (slicePool.length || sliceUnavailable) return;
    if (typeof window.Audio !== 'function') { sliceUnavailable = true; return; }
    try {
      for (var i = 0; i < SLICE_POOL; i++) {
        var a = new window.Audio(SLICE_SRC);
        a.preload = 'auto';
        a.volume = SLICE_VOLUME;
        // 任一元素加载失败 → 标记采样不可用，退回纯合成气声（满音量）
        a.addEventListener('error', function () { sliceUnavailable = true; });
        slicePool.push(a);
      }
    } catch (e) {
      sliceUnavailable = true;
      slicePool = [];
    }
  }

  /** 在用户手势里静音空放一次，绕过 Safari/iOS 的自动播放限制 */
  function primeSliceSound() {
    if (!soundOn || slicePrimed || sliceUnavailable) return;
    initSliceSound();
    if (!slicePool.length) return;
    slicePrimed = true;
    try {
      var a = slicePool[0];
      var vol = a.volume;
      a.volume = 0;
      a.currentTime = 0;
      var p = a.play();
      if (p && p.then) {
        p.then(function () { a.pause(); a.currentTime = 0; a.volume = vol; })
          .catch(function () { a.volume = vol; });
      } else {
        a.pause();
        a.volume = vol;
      }
    } catch (e) { /* 预解锁失败不影响游戏，真到切开时还会再试 */ }
  }

  /** 播放一次挥刀采样；combo 越高音高（播放速率）越高。返回是否真的响起来了 */
  function playSliceSample(combo) {
    if (!soundOn || sliceUnavailable) return false;
    initSliceSound();
    if (!slicePool.length) return false;

    var a = slicePool[slicePoolIdx];
    slicePoolIdx = (slicePoolIdx + 1) % slicePool.length;
    if (!a) return false;
    try {
      var step = Math.min(Math.max(combo, 1) - 1, SLICE_RATE_STEPS);
      a.currentTime = 0;
      a.playbackRate = 1 + step * SLICE_RATE_STEP;                       // 1.00 → 1.28
      a.volume = Math.min(SLICE_VOLUME + step * 0.012, 0.8);            // 连击越高越有劲
      var p = a.play();
      if (p && p.catch) p.catch(function () {});
      return true;
    } catch (e) {
      return false;
    }
  }

  /** 在用户手势里唤醒 AudioContext；必须在同步栈内调用，iOS 才认 */
  function unlockAudio() {
    primeSliceSound();
    if (!soundOn || audioDead) return;
    var ctx = getAudioCtx();
    if (!ctx || ctx.state !== 'suspended') return;
    try {
      var p = ctx.resume();
      if (p && p.catch) p.catch(function () {}); // 老浏览器返回 undefined
    } catch (e) { /* 解锁失败就静默，游戏照常 */ }
  }

  /**
   * 切开单词的完整音效：真实挥刀采样 + 合成气声垫底。
   * 采样缺失时气声自动补到满音量，听感不至于断档。
   */
  function playSliceSound(combo) {
    if (!soundOn) return;
    var sampled = playSliceSample(combo);
    playSliceAir(combo, sampled ? SLICE_AIR_MIX : 1);
  }

  /** 合成「嗖」声层；combo 为当前连击数（>=1），音高随连击递增 */
  function playSliceAir(combo, mix) {
    if (!soundOn || audioDead) return;
    var ctx = getAudioCtx();
    if (!ctx || !noiseBuffer) return;
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }

    try {
      var t = ctx.currentTime;
      // 连击每 +1 升一个半音，上限一个八度；升调同时压低音量避免刺耳
      var semi = Math.min(Math.max(combo, 1) - 1, SOUND_MAX_SEMI);
      var f0 = SOUND_F0 * Math.pow(2, semi / 12);
      var fUp = Math.min(f0 * SOUND_SWEEP, SOUND_CEIL_HZ);
      var fEnd = Math.min(f0 * SOUND_SWEEP_END, SOUND_CEIL_HZ);
      var peak = SOUND_GAIN * (1 - 0.4 * semi / SOUND_MAX_SEMI) * (mix == null ? 1 : mix);

      var src = ctx.createBufferSource();
      src.buffer = noiseBuffer;

      var filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.Q.value = 1.8;
      filter.frequency.setValueAtTime(f0, t);
      filter.frequency.exponentialRampToValueAtTime(fUp, t + 0.055);
      filter.frequency.exponentialRampToValueAtTime(fEnd, t + 0.085);

      var gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.linearRampToValueAtTime(peak, t + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + SOUND_DUR);

      src.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);

      src.start(t);
      src.stop(t + SOUND_DUR + 0.01);
      src.onended = function () {
        src.disconnect();
        filter.disconnect();
        gain.disconnect();
      };
    } catch (e) {
      /* 单次播放失败仅跳过，不永久静音，下一刀仍会再试 */
    }
  }

  function applySound() {
    soundOn = localStorage.getItem(SOUND_KEY) !== 'off';
    document.body.classList.toggle('sound-off', !soundOn);
    soundBtn.setAttribute('aria-label', soundOn ? '关闭音效' : '开启音效');
    // 悬停提示写清「这个按钮 + 当前状态」，与可见文字标签「音效」互相印证
    soundBtn.setAttribute('title', soundOn ? '音效：开（点击静音）' : '音效：已静音（点击开启）');
  }
  soundBtn.addEventListener('click', function () {
    soundOn = !soundOn;
    localStorage.setItem(SOUND_KEY, soundOn ? 'on' : 'off');
    applySound();
    if (soundOn) unlockAudio();
  });

  /* ============ 单词朗读（Web Speech API） ============ */
  // 零依赖：用浏览器内置的 speechSynthesis 念英文单词，不引任何音频文件/接口。
  // 关键约束（都是踩过的坑）：
  //   · 多数浏览器在第一次用户手势之前不允许发声 → 在 enterGame / 模式按钮里 unlockSpeech()；
  //   · getVoices() 是异步的，首调可能返回空数组 → 监听 voiceschanged 再选一次；
  //   · 每次 speak() 会排队，连续切开会把队列堆长 → 一律先 cancel() 再 speak()；
  //   · Safari/iOS 上长 utterance 有自动截断 → 单词很短，这里不受影响。

  /** 挑一个最合适的英语发音人：优先本地离线女声（发音更清晰），其次任意 en 语音 */
  function pickVoice() {
    if (!speakSupported) return null;
    var voices;
    try { voices = window.speechSynthesis.getVoices() || []; } catch (e) { return null; }
    if (!voices.length) return null;

    var en = voices.filter(function (v) {
      return v && v.lang && /^en(\b|-|_)/i.test(String(v.lang).replace('_', '-'));
    });
    if (!en.length) return null;

    // 优先级：本地服务 > 名称里带"女声/清晰/自然"特征的常见发音人 > 任意本地 > 第一个
    var prefer = /samantha|zira|susan|karen|google us english|natural|female/i;
    var local = en.filter(function (v) { return v.localService; });
    var pool = local.length ? local : en;
    for (var i = 0; i < pool.length; i++) {
      if (prefer.test(pool[i].name || '')) return pool[i];
    }
    return pool[0];
  }

  /** 初始化语音列表（异步）：拿到列表后挑一次并缓存 */
  function initSpeech() {
    speakSupported = !!(window.speechSynthesis && window.SpeechSynthesisUtterance);
    if (!speakSupported) return;
    speakVoice = pickVoice();
    if (!speakVoice && typeof window.speechSynthesis.addEventListener === 'function') {
      window.speechSynthesis.addEventListener('voiceschanged', function () {
        if (!speakVoice) speakVoice = pickVoice();
      });
    }
  }

  /** 在用户手势里"空触发"一次朗读，解锁 iOS/Safari 的语音权限 */
  function unlockSpeech() {
    if (!speakSupported || speakDead || !speakOn) return;
    try {
      var u = new window.SpeechSynthesisUtterance(' ');
      u.volume = 0;
      u.lang = SPEAK_LANG;
      window.speechSynthesis.speak(u);
      window.speechSynthesis.cancel();
    } catch (e) { /* 解锁失败不致命，真到朗读时还会再试 */ }
  }

  /** 标记某张单词卡为"正在发音"，并自动在结束时清除标记 */
  function markSpeaking(el) {
    if (speakCurrentEl && speakCurrentEl !== el) {
      speakCurrentEl.classList.remove('speaking');
    }
    speakCurrentEl = el || null;
    if (el && el.classList) el.classList.add('speaking');
  }
  function clearSpeakingMark() {
    if (speakCurrentEl && speakCurrentEl.classList) speakCurrentEl.classList.remove('speaking');
    speakCurrentEl = null;
  }

  /**
   * 读一个单词（仅记忆模式使用：浮现单词 / 点重听按钮）。
   * @param {string} text  要读的文本
   * @param {Element|null} el  关联的卡片（用于发音反馈），可为空
   */
  function speakWord(text, el) {
    if (!speakOn || !speakSupported || speakDead) return false;
    if (!text) return false;
    return doSpeak(text, el);
  }

  /** 真正发声：先 cancel 掉上一条，保证当前单词读完整 */
  function doSpeak(text, el) {
    try {
      window.speechSynthesis.cancel();
      var u = new window.SpeechSynthesisUtterance(text);
      u.lang = SPEAK_LANG;
      u.rate = SPEAK_RATE;
      u.pitch = SPEAK_PITCH;
      u.volume = SPEAK_VOLUME;
      if (speakVoice) u.voice = speakVoice;

      markSpeaking(el);
      u.onend = function () { if (speakCurrentEl === el) clearSpeakingMark(); };
      u.onerror = function () { if (speakCurrentEl === el) clearSpeakingMark(); };

      window.speechSynthesis.speak(u);
      return true;
    } catch (e) {
      speakDead = true;   // 永久降级：不打断游戏，只是不再朗读
      clearSpeakingMark();
      return false;
    }
  }

  /** 立刻停止朗读（切换模式 / 离开页面时调用，避免语音还在念而界面已走） */
  function stopSpeaking() {
    clearSpeakingMark();
    if (!speakSupported) return;
    try { window.speechSynthesis.cancel(); } catch (e) {}
  }

  function applySpeak() {
    speakOn = localStorage.getItem(SPEAK_KEY) !== 'off';
    document.body.classList.toggle('speak-off', !speakOn);
    speakBtn.setAttribute('aria-label', speakOn ? '关闭自动朗读' : '开启自动朗读');
    // 悬停提示写清「这个按钮 + 当前状态」，与可见文字标签「朗读」互相印证
    speakBtn.setAttribute('title', speakOn ? '朗读：开（点击静音）' : '朗读：已静音（点击开启）');
    if (!speakOn) stopSpeaking();
  }
  speakBtn.addEventListener('click', function () {
    speakOn = !speakOn;
    localStorage.setItem(SPEAK_KEY, speakOn ? 'on' : 'off');
    applySpeak();
    // 只做两件事：切开关、在当前用户手势里「静默」解锁语音权限（iOS/Safari 需要）。
    // 这里绝不能顺手读一个单词 —— 在录入/游戏模式下会凭空冒出声音，
    // 用户根本不知道声音从哪来（曾经踩过的坑，已回归测试覆盖）。
    if (speakOn) unlockSpeech();
  });

  /* ============ 游戏模式（切单词 · 60 秒） ============ */
  // 从当前白纸随机取一个单词（区别于记忆模式的 pickWord，可重复且允许同屏多个）
  function pickRandomWord() {
    return words[Math.floor(Math.random() * words.length)];
  }

  /* ---------- 异步任务登记：任何延时任务都要能被 stopGame() 取消 ---------- */
  function setGameTimer(fn, ms) {
    var id = setTimeout(function () {
      var idx = game.timers.indexOf(id);
      if (idx !== -1) game.timers.splice(idx, 1);
      fn();
    }, ms);
    game.timers.push(id);
    return id;
  }
  function clearGameTimers() {
    for (var i = 0; i < game.timers.length; i++) clearTimeout(game.timers[i]);
    game.timers.length = 0;
    if (game.countdownTimer) { clearTimeout(game.countdownTimer); game.countdownTimer = 0; }
  }
  function cancelGameFrame() {
    if (game.rafId) { cancelAnimationFrame(game.rafId); game.rafId = 0; }
  }
  /** 一次性清掉所有游戏产物：在飞单词、碎片、释义飘字、+1 飘字、刀光 */
  function clearGameSurface() {
    paper.querySelectorAll('.fruit-word, .slice-half, .def-pop, .score-pop, .slash-flash')
      .forEach(function (el) { el.remove(); });
  }

  /* ---------- 开场倒计时 ---------- */
  function runCountdown(done) {
    var myToken = game.token;   // 捕获当前世代：一旦被 stopGame() 自增，整条链立即作废
    gameCountdown.classList.add('active');
    gameCountdown.setAttribute('aria-hidden', 'false');
    var steps = ['3', '2', '1', '开始'];
    var i = 0;
    function step() {
      if (game.token !== myToken) return; // 已切换模式或重开，放弃这次倒计时
      if (i >= steps.length) {
        game.countdownTimer = 0;
        gameCountdown.classList.remove('active');
        gameCountdown.setAttribute('aria-hidden', 'true');
        done();
        return;
      }
      gameCountdownValue.textContent = steps[i];
      gameCountdownValue.classList.remove('pop');
      void gameCountdownValue.offsetWidth; // 强制重排以重触发动画
      gameCountdownValue.classList.add('pop');
      i++;
      game.countdownTimer = setTimeout(step, 520);
    }
    step();
  }

  /* ---------- 进入 / 开始 / 停止 / 结束 ---------- */
  function enterGame() {
    stopGame(); // 先彻底清场：作废旧世代、取消倒计时/动画帧/延时任务、移除残留元素
    paper.classList.add('paper--game');
    gameHud.classList.add('active');
    gameHud.setAttribute('aria-hidden', 'false');
    gameTimebar.classList.add('active');
    game.reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    ensureBladeLayer();
    runCountdown(startGame);
  }

  function startGame() {
    // 开新局：自增世代，保证只有这一局的循环能存活
    game.token++;
    game.loopToken = game.token;
    game.running = true;
    game.finished = false;
    game.timeLeft = GAME_DURATION;
    game.score = 0;
    game.spawnedCount = 0;
    game.fruits = [];
    game.debris = [];
    game.slicedIds = [];
    game.spawnTimer = 0.3;
    game.lastTs = 0;
    game.combo = 0;
    game.bestCombo = 0;
    game.lastSliceTs = 0;
    game.bladePoints = [];
    hideCombo();
    updateGameScore();
    updateGameHud();
    cancelGameFrame();
    game.rafId = requestAnimationFrame(gameLoop);
  }

  // 彻底停止游戏：作废世代 → 取消帧/定时器 → 清空状态 → 收起所有游戏 UI
  function stopGame() {
    game.token++;                 // 作废旧倒计时与旧主循环，杜绝「切换后仍继续抛词」
    game.running = false;
    game.finished = false;
    game.pointerDown = false;
    cancelGameFrame();
    clearGameTimers();
    clearGameSurface();
    game.fruits = [];
    game.debris = [];
    game.slicedIds = [];
    game.bladePoints = [];
    game.combo = 0;
    game.bestCombo = 0;
    game.lastSliceTs = 0;
    game.lastTs = 0;
    game.timeLeft = 0;
    game.spawnTimer = 0;
    if (bladeLayer) {
      bladeLayer.remove();
      bladeLayer = null;
      bladeGrad = null;
      bladeHalo = null;
      bladeGlow = null;
      bladeRibbon = null;
      bladeCore = null;
      bladeTip = null;
      bladeEdge = null;
    }
    paper.classList.remove('paper--game');
    gameHud.classList.remove('active', 'low');
    gameHud.setAttribute('aria-hidden', 'true');
    gameTimebar.classList.remove('active');
    gameCountdown.classList.remove('active');
    gameCountdown.setAttribute('aria-hidden', 'true');
    hideCombo();
    closeGameOver();
  }

  function endGame() {
    game.running = false;
    game.finished = true;
    cancelGameFrame();
    stopSpeaking();   // 收尾时停掉可能还在念的语音
    // 清除仍在飞行 / 下落的单词与碎片，以及残留的释义、+1 飘字
    clearGameTimers();
    game.fruits.forEach(function (f) { f.el.remove(); });
    game.debris.forEach(function (d) { d.el.remove(); });
    clearGameSurface();
    game.fruits = [];
    game.debris = [];
    game.bladePoints = [];
    endBlade();
    paper.classList.remove('paper--game');
    gameHud.classList.remove('active', 'low');
    gameHud.setAttribute('aria-hidden', 'true');
    gameTimebar.classList.remove('active');
    hideCombo();                      // bestCombo 保留到 renderGameOver 读取后再重置

    // 斩开的单词 recallCount +1，游戏结束后统一持久化一次
    var seen = {};
    game.slicedIds.forEach(function (id) { seen[id] = true; });
    var touched = 0;
    for (var i = 0; i < words.length; i++) {
      if (seen[words[i].id]) { words[i].recallCount = (words[i].recallCount || 0) + 1; touched++; }
    }
    if (touched > 0) savePapers();

    renderGameOver();
    openGameOver();
  }

  /* ---------- 主循环 ---------- */
  function gameLoop(ts) {
    if (!game.running || game.token !== game.loopToken) return; // 世代已作废：停止这一帧
    if (!game.lastTs) game.lastTs = ts;
    var dt = Math.min((ts - game.lastTs) / 1000, 0.05);
    game.lastTs = ts;

    game.timeLeft -= dt;
    updateFruits(dt);
    updateDebris(dt);
    renderBlade();          // 每帧重绘：即便停手，拖尾也会按 BLADE_TTL 自然消散
    updateGameHud();

    var lv = GAME_LEVELS[game.level];
    game.spawnTimer -= dt;
    if (game.spawnTimer <= 0 && game.fruits.length < lv.maxFruits) {
      spawnFruit();
      game.spawnTimer = lv.intervalMin + Math.random() * (lv.intervalMax - lv.intervalMin);
    }

    // 连击超时复位：环形倒计时流空 → 收起连击、火花、刀气热度
    if (game.combo > 0 && Date.now() - game.lastSliceTs > COMBO_WINDOW) {
      game.combo = 0;
      hideCombo();
    }

    if (game.timeLeft <= 0) {
      endGame();
      return;
    }
    game.rafId = requestAnimationFrame(gameLoop);
  }

  /* ---------- 生成单词（向上抛出） ---------- */
  function spawnFruit() {
    var word = pickRandomWord();
    var el = document.createElement('div');
    el.className = 'fruit-word';
    el.textContent = word.word;
    paper.appendChild(el);

    var w = el.offsetWidth;
    var h = el.offsetHeight;
    // 目标抛高取视口高度的 55%–75%，由初速度反推，让单词冲到屏幕中上部
    var peakH = (0.55 + Math.random() * 0.20) * window.innerHeight;
    var v0 = game.reduced ? 0 : Math.sqrt(2 * GAME_GRAVITY * peakH);
    var fruit = {
      el: el,
      word: word,
      x: 70 + Math.random() * (window.innerWidth - 140),
      y: window.innerHeight + h / 2 + 20,
      vx: game.reduced ? 0 : (Math.random() * 180 - 90),
      vy: -v0,
      rot: game.reduced ? 0 : (Math.random() * 12 - 6),
      r: Math.max(w, h) * 0.62,
      sliced: false
    };
    if (game.reduced) {
      // 减少动态：静置于随机位置，轻淡入，供点按切开
      fruit.y = 120 + Math.random() * (window.innerHeight - 260);
      fruit.vy = 0;
    }
    game.fruits.push(fruit);
    game.spawnedCount++;
    placeFruit(fruit);
    el.style.opacity = '0';
    el.style.transition = 'opacity .25s ease-out';
    requestAnimationFrame(function () { el.style.opacity = '1'; });
  }

  function placeFruit(f) {
    f.el.style.left = f.x + 'px';
    f.el.style.top = f.y + 'px';
    f.el.style.transform = 'translate(-50%, -50%) rotate(' + f.rot + 'deg)';
  }

  function updateFruits(dt) {
    var list = game.fruits;
    for (var i = list.length - 1; i >= 0; i--) {
      var f = list[i];
      if (!game.reduced) f.vy += GAME_GRAVITY * dt;
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      placeFruit(f);
      // 落下超出屏幕底部 → 漏掉
      if (f.y > window.innerHeight + f.el.offsetHeight) {
        f.el.remove();
        list.splice(i, 1);
      }
    }
  }

  function updateDebris(dt) {
    var list = game.debris;
    for (var i = list.length - 1; i >= 0; i--) {
      var d = list[i];
      d.life += dt;
      d.vy += GAME_GRAVITY * 0.95 * dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.rot += d.rotSpeed * dt;
      d.el.style.left = d.x + 'px';
      d.el.style.top = d.y + 'px';
      d.el.style.transform = 'translate(-50%, -50%) rotate(' + d.rot + 'deg)';
      d.el.style.opacity = Math.max(0, 1 - d.life / 0.7);
      if (d.life > 0.7) {
        d.el.remove();
        list.splice(i, 1);
      }
    }
  }

  /* ---------- 切开单词 ---------- */
  function sliceFruit(f, angleDeg) {
    if (f.sliced) return;
    f.sliced = true;
    game.score++;
    game.slicedIds.push(f.word.id);
    updateGameScore();
    updateCombo();
    playSliceSound(game.combo); // 此刻 combo 已更新，音高与连击数同步

    var cx = f.x;
    var cy = f.y;
    var idx = game.fruits.indexOf(f);
    if (idx !== -1) game.fruits.splice(idx, 1);
    f.el.remove();

    if (!game.reduced) {
      makeHalves(f, cx, cy);
      spawnSlash(cx, cy, angleDeg == null ? -18 : angleDeg);
    }
    showDefinition(cx, cy, f.word);
    spawnScorePop(cx, cy);
  }

  function makeHalves(f, cx, cy) {
    var top = document.createElement('div');
    top.className = 'slice-half top';
    top.textContent = f.word.word;
    var bottom = document.createElement('div');
    bottom.className = 'slice-half bottom';
    bottom.textContent = f.word.word;
    paper.appendChild(top);
    paper.appendChild(bottom);

    [top, bottom].forEach(function (el) {
      el.style.left = cx + 'px';
      el.style.top = cy + 'px';
      el.style.transform = 'translate(-50%, -50%)';
    });

    var up = {
      el: top, x: cx, y: cy,
      vx: -110 - Math.random() * 80, vy: -90 - Math.random() * 70,
      rot: 0, rotSpeed: -170 - Math.random() * 160, life: 0
    };
    var down = {
      el: bottom, x: cx, y: cy,
      vx: 110 + Math.random() * 80, vy: 50 + Math.random() * 90,
      rot: 0, rotSpeed: 170 + Math.random() * 160, life: 0
    };
    game.debris.push(up, down);
  }

  function showDefinition(cx, cy, word) {
    if (!word.definition) return;
    var pop = document.createElement('div');
    pop.className = 'def-pop';
    var text = document.createElement('div');
    text.className = 'def-pop-text';
    text.textContent = word.definition;
    pop.appendChild(text);
    pop.style.left = cx + 'px';
    pop.style.top = cy + 'px';
    paper.appendChild(pop);

    requestAnimationFrame(function () {
      requestAnimationFrame(function () { pop.classList.add('show'); });
    });
    setGameTimer(function () { pop.classList.remove('show'); pop.classList.add('hide'); }, 1250);
    setGameTimer(function () { pop.remove(); }, 1650);
  }

  function spawnScorePop(cx, cy) {
    var s = document.createElement('div');
    s.className = 'score-pop';
    s.textContent = '+1';
    s.style.left = cx + 'px';
    s.style.top = cy + 'px';
    paper.appendChild(s);
    requestAnimationFrame(function () { s.classList.add('show'); });
    setGameTimer(function () { s.remove(); }, 720);
  }

  /* ---------- HUD 更新 ---------- */
  function updateGameScore() {
    gameScoreEl.textContent = game.score;
  }
  function updateGameHud() {
    var s = Math.max(0, Math.ceil(game.timeLeft));
    gameTimerEl.textContent = s;
    gameTimebarFill.style.width = (Math.max(0, game.timeLeft) / GAME_DURATION * 100) + '%';
    gameHud.classList.toggle('low', s <= 10);
  }

  /* ---------- 连击 / 难度挡位 ---------- */
  /** 按段位在连击环上迸溅火花 */
  function spawnComboSparks(info) {
    if (game.reduced || !comboSparks) return;
    var n = Math.min(info.sparks, 16);
    for (var i = 0; i < n; i++) {
      var s = document.createElement('span');
      s.className = 'combo-spark';
      var ang = (360 / n) * i + Math.random() * 18 - 9;
      var dist = 58 + Math.random() * 34 + info.tier * 4;
      setCssVar(s, '--a', ang + 'deg');
      setCssVar(s, '--dist', dist + 'px');
      setCssVar(s, '--dur', (0.5 + Math.random() * 0.28).toFixed(2) + 's');
      comboSparks.appendChild(s);
      // 动画结束即回收；另设兜底定时器，避免 animationend 未触发时泄漏
      s.addEventListener('animationend', (function (node) {
        return function () { node.remove(); };
      })(s));
    }
    // 火花统一在连击断开或游戏停止时清空，这里只兜底
    if (comboSparks.children.length > 40) {
      while (comboSparks.children.length > 20) comboSparks.removeChild(comboSparks.children[0]);
    }
  }

  function clearComboSparks() {
    if (comboSparks) comboSparks.innerHTML = '';
  }

  function hideCombo() {
    gameCombo.classList.remove('active', 'pop');
    clearComboSparks();
    setBladeHeat(0);
  }

  function updateCombo() {
    var now = Date.now();
    game.combo = (now - game.lastSliceTs < COMBO_WINDOW) ? game.combo + 1 : 1;
    game.lastSliceTs = now;
    if (game.combo > game.bestCombo) game.bestCombo = game.combo;
    if (game.combo < 2) return;

    var info = comboTier(game.combo);
    gameComboCount.textContent = String(game.combo);
    if (comboTierEl) comboTierEl.textContent = info.label;

    // 段位配色互斥：只留当前 tier-*
    for (var t = 1; t <= 5; t++) gameCombo.classList.toggle('tier-' + t, t === info.tier);
    gameCombo.classList.add('active');
    gameCombo.classList.remove('pop');
    void gameCombo.offsetWidth;   // 强制重排以重触发 pop（数字弹跳 + 环形倒计时重置）
    gameCombo.classList.add('pop');

    clearComboSparks();
    spawnComboSparks(info);
    setBladeHeat(info.tier);
  }
  function setGameLevel(level) {
    game.level = level;
    gameLevelBtns.forEach(function (b) {
      var on = Number(b.dataset.level) === level;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
  }
  gameLevelBtns.forEach(function (btn) {
    btn.addEventListener('click', function () { setGameLevel(Number(btn.dataset.level)); });
  });

  /* ---------- 刀气（滑动轨迹） ---------- */
  // 参考 CCBlade（Fruit Ninja 的刀光实现）与各类 TrailRenderer 做法的核心思路：
  // 都是「把滑动轨迹点连成一条带宽度的条带，再叠几层不同模糊/透明度做发光」。
  // 这里用 SVG 路径做同样的条带，但叠了 6 层：
  //   外晕 → 柔光 → 刀身缎带 → 内芯高光 → 刀尖辉光 → 刀锋锐线
  // 轨迹点带时间戳，超过 BLADE_TTL(130ms) 自动脱落 —— 滑到哪儿停，刀气就自然消散。
  function ensureBladeLayer() {
    if (bladeLayer) return;
    var svgNS = 'http://www.w3.org/2000/svg';
    function mk(tag, cls) {
      var el = document.createElementNS(svgNS, tag);
      el.setAttribute('class', cls);
      return el;
    }

    bladeLayer = mk('svg', 'blade-layer');
    bladeLayer.setAttribute('width', '100%');
    bladeLayer.setAttribute('height', '100%');
    bladeLayer.setAttribute('aria-hidden', 'true');
    bladeLayer.setAttribute('data-hot', '');

    var defs = mk('defs', 'blade-defs');

    // 沿轨迹方向的渐变：尾端全透明 → 中段半实 → 刀尖白热
    // 四段停靠点是"能量沿刀路流动"的关键：原来的三段让中段显得发死。
    bladeGrad = mk('linearGradient', 'blade-grad');
    bladeGrad.setAttribute('id', 'bladeFade');
    bladeGrad.setAttribute('gradientUnits', 'userSpaceOnUse');
    var stops = [['0', 'blade-fade-0'], ['0.42', 'blade-fade-1'],
                 ['0.78', 'blade-fade-2'], ['1', 'blade-fade-3']];
    for (var i = 0; i < stops.length; i++) {
      var st = mk('stop', stops[i][1]);
      st.setAttribute('offset', stops[i][0]);
      bladeGrad.appendChild(st);
    }

    // 两档模糊：宽模糊给外晕撑气场，窄模糊给柔光收边缘
    var filterWide = mk('filter', 'blade-filter-wide');
    filterWide.setAttribute('id', 'bladeBlurWide');
    filterWide.setAttribute('x', '-80%');
    filterWide.setAttribute('y', '-80%');
    filterWide.setAttribute('width', '260%');
    filterWide.setAttribute('height', '260%');
    var blurWide = mk('feGaussianBlur', 'blade-blur-wide');
    blurWide.setAttribute('stdDeviation', '6');
    filterWide.appendChild(blurWide);

    var filter = mk('filter', 'blade-filter');
    filter.setAttribute('id', 'bladeBlur');
    filter.setAttribute('x', '-70%');
    filter.setAttribute('y', '-70%');
    filter.setAttribute('width', '240%');
    filter.setAttribute('height', '240%');
    var blur = mk('feGaussianBlur', 'blade-blur');
    blur.setAttribute('stdDeviation', '2.2');
    filter.appendChild(blur);

    defs.appendChild(bladeGrad);
    defs.appendChild(filterWide);
    defs.appendChild(filter);
    bladeLayer.appendChild(defs);

    // 按「从后到前」的绘制顺序挂载：外晕在最底，刀锋锐线在最上
    bladeHalo = mk('path', 'blade-halo');
    bladeGlow = mk('path', 'blade-glow');
    bladeRibbon = mk('path', 'blade-ribbon');
    bladeCore = mk('path', 'blade-core');
    bladeTip = mk('circle', 'blade-tip');
    bladeEdge = mk('path', 'blade-edge');
    bladeTip.setAttribute('r', '0');

    bladeLayer.appendChild(bladeHalo);
    bladeLayer.appendChild(bladeGlow);
    bladeLayer.appendChild(bladeRibbon);
    bladeLayer.appendChild(bladeCore);
    bladeLayer.appendChild(bladeEdge);
    bladeLayer.appendChild(bladeTip);
    paper.appendChild(bladeLayer);
  }

  /** 由中心线生成「尾细头宽」的闭合缎带路径。
      参考 CCBlade 的做法：条带宽度的关键是"沿路径渐变"，而不是等宽。
      这里在宽度曲线上再叠一层「外弧」——让刀身背侧比刃侧更宽，
      看起来像一把有厚度的刀，而不是一根管子。 */
  function bladeRibbonPath(pts, width) {
    var n = pts.length;
    var left = [];
    var right = [];
    for (var i = 0; i < n; i++) {
      var p = pts[i];
      var prev = pts[i - 1] || p;
      var next = pts[i + 1] || p;
      var dx = next.x - prev.x;
      var dy = next.y - prev.y;
      var len = Math.sqrt(dx * dx + dy * dy) || 1;
      var nx = -dy / len;                       // 单位法线
      var ny = dx / len;
      var t = n === 1 ? 1 : i / (n - 1);        // 0 = 尾，1 = 头
      // 沿路径的宽度曲线：起步就有一定宽度，越靠刀尖越宽
      var w = width * 0.5 * (0.45 + 0.55 * Math.pow(t, 0.7));
      // 外弧：背侧（left）加宽 35%，刃侧（right）略收 12%，形成刀刃的方向感
      var wBack = w * 1.35;
      var wEdge = w * 0.88;
      left.push((p.x + nx * wBack) + ' ' + (p.y + ny * wBack));
      right.push((p.x - nx * wEdge) + ' ' + (p.y - ny * wEdge));
    }
    right.reverse();
    return 'M' + left.join(' L') + ' L' + right.join(' L') + ' Z';
  }

  function startBlade(x, y) {
    game.bladePoints = [{ x: x, y: y, t: Date.now() }];
    if (!bladeLayer) return;
    bladeLayer.style.transition = 'none';
    bladeLayer.style.opacity = '1';
    renderBlade();
  }
  function moveBlade(x, y) {
    game.bladePoints.push({ x: x, y: y, t: Date.now() });
    if (game.bladePoints.length > BLADE_MAX_POINTS) game.bladePoints.shift();
    renderBlade();
  }
  function endBlade() {
    if (!bladeLayer) return;
    bladeLayer.style.transition = 'opacity .2s ease-out';
    bladeLayer.style.opacity = '0';
  }

  /** 连击越高刀气越烫：tier 1→原色，2→橙铜，3→赤金，4/5→白热金 */
  function setBladeHeat(tier) {
    if (!bladeLayer) return;
    var hot = tier >= 4 ? '3' : (tier === 3 ? '2' : (tier === 2 ? '1' : ''));
    bladeLayer.setAttribute('data-hot', hot);
  }

  function renderBlade() {
    if (!bladeLayer || !bladeRibbon) return;
    var now = Date.now();
    var pts = game.bladePoints;

    // 超时的点脱落（停手即消散），再按上限截断
    while (pts.length && now - pts[0].t > BLADE_TTL) pts.shift();
    if (pts.length > BLADE_MAX_POINTS) pts.splice(0, pts.length - BLADE_MAX_POINTS);

    if (pts.length < 2) {
      bladeHalo.setAttribute('d', '');
      bladeGlow.setAttribute('d', '');
      bladeRibbon.setAttribute('d', '');
      bladeCore.setAttribute('d', '');
      bladeEdge.setAttribute('d', '');
      bladeTip.setAttribute('r', '0');
      // 只在「还按着」时收起；抬手后的淡出由 endBlade 负责，别把正在消失的刀气重新点亮
      if (game.pointerDown) bladeLayer.style.opacity = '0';
      return;
    }

    var n = pts.length;
    var head = pts[n - 1];
    var tail = pts[0];
    var prev = pts[n - 2];
    var speed = Math.sqrt(Math.pow(head.x - prev.x, 2) + Math.pow(head.y - prev.y, 2));
    // 手速决定刀气宽度：甩得越快，刀越"宽"、气越足
    var width = clamp(BLADE_W_MIN + speed * 0.35, BLADE_W_MIN, BLADE_W_MAX);

    var d = bladeRibbonPath(pts, width);
    var line = 'M' + tail.x + ' ' + tail.y;
    for (var i = 1; i < n; i++) line += ' L' + pts[i].x + ' ' + pts[i].y;

    // 渐变沿「尾 → 头」铺开，保证拖尾永远朝手后方消隐
    bladeGrad.setAttribute('x1', tail.x);
    bladeGrad.setAttribute('y1', tail.y);
    bladeGrad.setAttribute('x2', head.x);
    bladeGrad.setAttribute('y2', head.y);

    bladeHalo.setAttribute('d', d);
    bladeGlow.setAttribute('d', d);
    bladeRibbon.setAttribute('d', d);
    bladeCore.setAttribute('d', line);
    // 刀锋锐线：从刀身 78% 处到刀尖的一小段，把末端收成尖
    var edgeFrom = n >= 4 ? pts[Math.floor(n * 0.78)] : tail;
    bladeEdge.setAttribute('d', 'M' + edgeFrom.x + ' ' + edgeFrom.y + ' L' + head.x + ' ' + head.y);
    bladeTip.setAttribute('cx', head.x);
    bladeTip.setAttribute('cy', head.y);
    // 刀尖光点随宽度缩放，手快时更亮更大
    bladeTip.setAttribute('r', String(width * 0.28));
    if (game.pointerDown) bladeLayer.style.opacity = '1';
  }

  /** 斩击瞬间沿刀路炸开的一道白光 */
  function spawnSlash(cx, cy, angleDeg) {
    if (game.reduced) return;
    var s = document.createElement('div');
    s.className = 'slash-flash';
    s.style.left = cx + 'px';
    s.style.top = cy + 'px';
    setCssVar(s, '--ang', angleDeg + 'deg');
    paper.appendChild(s);
    setGameTimer(function () { s.remove(); }, 340);
  }

  /* ---------- 命中判定 ---------- */
  function hitTestFruit(x, y) {
    for (var i = game.fruits.length - 1; i >= 0; i--) {
      var f = game.fruits[i];
      var dx = x - f.x, dy = y - f.y;
      if (dx * dx + dy * dy <= f.r * f.r) return f;
    }
    return null;
  }
  function distToSegment(px, py, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay;
    var len2 = dx * dx + dy * dy;
    var t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    var cx = ax + t * dx, cy = ay + t * dy;
    var ex = px - cx, ey = py - cy;
    return Math.sqrt(ex * ex + ey * ey);
  }

  /* ---------- 滑动 / 点按 切开 ---------- */
  paper.addEventListener('pointerdown', function (e) {
    if (mode !== 'game' || !game.running) return;
    unlockAudio(); // 移动端兜底：部分浏览器要等到真实触摸才放行
    game.pointerDown = true;
    startBlade(e.clientX, e.clientY);
    var f = hitTestFruit(e.clientX, e.clientY);
    // 按下即命中时还没有刀路方向，给一个略微上扬的默认角度
    if (f) sliceFruit(f, -18 + Math.random() * 36);
    if (e.cancelable) e.preventDefault();
  });
  paper.addEventListener('pointermove', function (e) {
    if (mode !== 'game' || !game.running || !game.pointerDown) return;
    var last = game.bladePoints[game.bladePoints.length - 1];
    var ax = last.x, ay = last.y;
    var bx = e.clientX, by = e.clientY;
    moveBlade(bx, by);
    // 刀路方向（度）：斩击白光与刀身走向一致
    var ang = Math.atan2(by - ay, bx - ax) * 180 / Math.PI;
    for (var i = game.fruits.length - 1; i >= 0; i--) {
      var f = game.fruits[i];
      if (distToSegment(f.x, f.y, ax, ay, bx, by) < f.r) sliceFruit(f, ang);
    }
  });
  function endPointerBlade() {
    if (mode !== 'game') return;
    game.pointerDown = false;
    endBlade();
  }
  paper.addEventListener('pointerup', endPointerBlade);
  paper.addEventListener('pointercancel', endPointerBlade);

  /* ---------- 结算面板 ---------- */
  function openGameOver() {
    gameOverPanel.classList.add('open');
    gameOverPanel.setAttribute('aria-hidden', 'false');
  }
  function closeGameOver() {
    gameOverPanel.classList.remove('open');
    gameOverPanel.setAttribute('aria-hidden', 'true');
  }
  function renderGameOver() {
    gameOverBody.innerHTML = '';
    var seen = {};
    game.slicedIds.forEach(function (id) { seen[id] = true; });
    var slicedWords = words.filter(function (w) { return seen[w.id]; });
    var missed = game.spawnedCount - game.score;

    var hero = document.createElement('div');
    hero.className = 'game-result-hero';
    var num = document.createElement('div');
    num.className = 'game-result-score';
    num.textContent = game.score;
    var label = document.createElement('div');
    label.className = 'game-result-label';
    label.textContent = '斩开单词';
    hero.appendChild(num);
    hero.appendChild(label);
    gameOverBody.appendChild(hero);

    var sub = document.createElement('div');
    sub.className = 'game-result-sub';
    sub.textContent = missed > 0 ? '漏掉 ' + missed + ' 个 · 共 ' + game.spawnedCount + ' 个' : '一个不落，漂亮！';
    gameOverBody.appendChild(sub);

    var comboLine = document.createElement('div');
    comboLine.className = 'game-result-combo';
    comboLine.textContent = game.bestCombo >= 2
      ? '最高连击 ×' + game.bestCombo + ' · ' + comboTier(game.bestCombo).label
      : '最高连击 ×' + game.bestCombo;
    gameOverBody.appendChild(comboLine);

    if (slicedWords.length) {
      var list = document.createElement('ul');
      list.className = 'game-recap';
      slicedWords.forEach(function (w) {
        var li = document.createElement('li');
        li.className = 'game-recap-item';
        var wd = document.createElement('span');
        wd.className = 'game-recap-word';
        wd.textContent = w.word;
        var df = document.createElement('span');
        df.className = 'game-recap-def';
        df.textContent = w.definition || '—';
        li.appendChild(wd);
        li.appendChild(df);
        list.appendChild(li);
      });
      gameOverBody.appendChild(list);
    } else {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '一个单词都没切开，再来一次吧';
      gameOverBody.appendChild(empty);
    }
  }

  /* ============ 初始化 ============ */
  function init() {
    var loaded = loadPapers();
    papers = loaded.papers;
    activePaperId = loaded.activeId;
    syncActiveWords();
    applyTheme();
    applySound();
    initSpeech();
    applySpeak();
    // 连击窗口只有一个真源：CSS 里的环形倒计时时长由 JS 常量注入
    setCssVar(gameCombo, '--combo-window', COMBO_WINDOW + 'ms');
    updateCount();
    renderShelf();
    setMode('entry'); // 初始为录入模式
  }
  init();

  // 页面隐藏/卸载时立刻闭嘴，避免切走后语音还在后台念
  window.addEventListener('pagehide', stopSpeaking);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stopSpeaking();
  });
})();
