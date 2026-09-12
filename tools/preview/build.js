/**
 * 界面验证用预览站点生成器（配合本机 Edge/Chrome 无头模式出图）
 *
 *   node tools/preview/build.js      # 生成 tools/preview/site
 *   node tools/preview/serve.js      # 起 http://localhost:8799
 *   然后：
 *     msedge --headless=new --window-size=500,940 --virtual-time-budget=9000 \
 *       --screenshot=shot.png "http://localhost:8799/frame.html?w=390&h=844&u=index.html%3Fn%3D40%26mode%3Dentry"
 *   想看尺寸数字（而不是图）：把上面 URL 里的 index.html 换成 measure.html，用 --dump-dom 抓 #out。
 *
 * 把桌面版源文件同步到截图用站点，并注入：
 *   · 假数据 + URL 参数驱动（dark / mode / panel / n / papers）
 *   · measure.html 专用的一次性尺寸测量脚本
 * 每次改完源码都要先跑一遍这个，否则看到的是旧副本。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '..', '..');   // 仓库根目录
const SITE = path.join(__dirname, 'site');

fs.mkdirSync(SITE, { recursive: true });
['style.css', 'script.js', 'wordbooks.js', 'slice.mp3'].forEach(function (f) {
  fs.copyFileSync(path.join(SRC, f), path.join(SITE, f));
});
// 注意：不要用 fs.cpSync({recursive:true}) —— 本机 Node 22.22.2 在 Windows 上会直接崩（0xC0000409）
fs.mkdirSync(path.join(SITE, 'assets'), { recursive: true });
['blade-drawn.png', 'blade-slash.png'].forEach(function (f) {
  fs.copyFileSync(path.join(SRC, 'assets', f), path.join(SITE, 'assets', f));
});

const SEED = `
  <!-- 仅用于截图验证：注入假数据 + 按 URL 参数驱动界面 -->
  <script>
  (function () {
    var q = new URLSearchParams(location.search);
    var n = parseInt(q.get('n') || '0', 10);
    var ws = ['ability', 'abandon', 'aboriginal', 'abhor', 'absurd', 'abundance'];
    var ds = ['n.能力；本领', 'vt.丢弃；放弃，抛弃', 'adj.久远的，古老的', 'vt.憎恶，厌恶', 'adj.荒谬的，可笑的', 'n.丰富，充裕'];
    var words = [];
    for (var i = 0; i < n; i++) {
      words.push({ id: 'w' + i, word: ws[i % 6], definition: ds[i % 6], x: 0.5, y: 0.5, createdAt: i, recallCount: i % 7 });
    }
    var papers = q.get('papers') === '3'
      ? [{ id: 'p1', name: '四级词汇', createdAt: 1, words: words },
         { id: 'p2', name: '手写生词', createdAt: 2, words: words.slice(0, 4) },
         { id: 'p3', name: '未命名白纸', createdAt: 3, words: [] }]
      : [{ id: 'p1', name: '四级词汇', createdAt: 1, words: words }];
    localStorage.setItem('paper-papers', JSON.stringify({ papers: papers, activeId: 'p1' }));
    // 主题显式写死，避免复用浏览器 profile 时被上一次的 dark 状态串味
    localStorage.setItem('paper-theme', q.get('dark') === '1' ? 'dark' : 'light');
  })();
  <\/script>
`;

const DRIVE = `
  <script>
  (function () {
    var q = new URLSearchParams(location.search);
    if (q.get('showdel') === '1') {
      var st = document.createElement('style');
      st.textContent = '.word-card .word-del{opacity:1 !important;transform:scale(1) !important;pointer-events:auto !important}';
      document.head.appendChild(st);
    }
    var m = q.get('mode'), panel = q.get('panel');
    if (panel === 'wordbook') { document.getElementById('shelf-books').click(); return; }
    if (!m) return;
    document.getElementById('home-entry').click();
    if (m !== 'entry') document.getElementById('mode-' + m).click();
    if (panel === 'stats') setTimeout(function () { document.getElementById('btn-stats').click(); }, 200);
    if (m === 'recall') setTimeout(function () {
      document.getElementById('paper').dispatchEvent(new MouseEvent('click', { clientX: 195, clientY: 420, bubbles: true }));
    }, 300);
  })();
  <\/script>
`;

function build(name, extra) {
  let h = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
  h = h.replace('  <script src="wordbooks.js"></script>', SEED + '  <script src="wordbooks.js"></script>');
  h = h.replace('</body>', (extra || '') + DRIVE + '</body>');
  fs.writeFileSync(path.join(SITE, name), h);
}

const MEASURE = `
  <script>
  window.addEventListener('load', function () {
    setTimeout(function () {
      var out = ['.toolbar', '.toolbar-left', '.controls', '.mode-switch', '.mode-btn', '.icon-btn', '.count',
        '.game-hud', '.game-combo']
        .map(function (sel) {
          var e = document.querySelector(sel);
          if (!e) return sel + ' = MISSING';
          var r = e.getBoundingClientRect();
          return sel + ' = x' + r.x.toFixed(1) + ' w' + r.width.toFixed(1) + ' h' + r.height.toFixed(1);
        });
      out.unshift('viewport=' + window.innerWidth + 'x' + window.innerHeight + ' dpr=' + window.devicePixelRatio);
      var vw = window.innerWidth, bad = [];
      document.querySelectorAll('.toolbar *').forEach(function (e) {
        var r = e.getBoundingClientRect();
        if (r.width && (r.right > vw + 1 || r.left < -1)) bad.push(e.className + ' 溢出 right=' + r.right.toFixed(0));
      });
      out.push('溢出检查: ' + (bad.length ? bad.join(' | ') : '无溢出'));
      var small = [];
      document.querySelectorAll('.controls button, .stat-del, .word-del, .word-speak, .panel-close, .game-level-btn').forEach(function (e) {
        var r = e.getBoundingClientRect();
        if (r.width && r.height < 38) small.push(e.className + ' ' + r.width.toFixed(0) + 'x' + r.height.toFixed(0));
      });
      out.push('触摸目标 <38px: ' + (small.length ? small.join(' | ') : '无'));
      out.push('统计行数: ' + document.querySelectorAll('.stat-row').length + ' / 删除键: ' + document.querySelectorAll('.stat-del').length);
      out.push('HUD 底边: ' + (function(){ var e=document.querySelector('.game-hud'); var r=e.getBoundingClientRect(); return r.bottom.toFixed(0); })()
        + ' | 连击顶边: ' + (function(){ var e=document.querySelector('.game-combo'); return e.getBoundingClientRect().top.toFixed(0); })());
      document.body.innerHTML = '<pre id="res">' + out.join('\\n') + '</pre>';
    }, 700);
  });
  <\/script>
`;

build('index.html');
build('measure.html', MEASURE);

/* 外层套一个固定尺寸的 iframe —— Edge/Chrome 无头模式下 --window-size 不等于视口宽度，
   只有 iframe 才能精确模拟「390x844 的手机视口」 */
fs.writeFileSync(path.join(SITE, 'frame.html'), `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>frame</title>
<style>html,body{margin:0;padding:0;background:#c9c9c9}iframe{position:absolute;left:0;top:0;border:0;display:block;background:#fff}</style>
</head><body><iframe id="f"></iframe><pre id="out"></pre>
<script>
var q = new URLSearchParams(location.search);
var f = document.getElementById('f');
f.width = parseInt(q.get('w') || '390', 10);
f.height = parseInt(q.get('h') || '740', 10);
f.src = q.get('u') || 'index.html';
/* 把 iframe 内测量脚本写下的 #res 复制到父文档，便于 --dump-dom 抓取 */
var tries = 0;
var timer = setInterval(function () {
  tries++;
  try {
    var d = f.contentDocument;
    var r = d && d.getElementById('res');
    if (r) { document.getElementById('out').textContent = r.textContent; clearInterval(timer); }
  } catch (e) {}
  if (tries > 60) clearInterval(timer);
}, 100);
<\/script></body></html>
`);

console.log('站点已同步到 tools/preview/site：index.html / measure.html / frame.html');
