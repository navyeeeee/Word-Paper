/**
 * 把修好的 web 文件重新打包进桌面版 app.asar。
 *
 * 用法：node pack.js            （只生成 app.asar.new 并自检）
 *       node pack.js --apply    （备份原文件后写入安装目录）
 *
 * asar 结构（与 electron/asar 一致）：
 *   [u32 4][u32 headerBuf.length][headerBuf][各文件内容依次拼接]
 *   headerBuf = [u32 payloadSize][u32 strLen][json][补零到 4 字节对齐]
 *   文件 offset 相对 base = 8 + headerBuf.length；每个文件带 sha256 integrity。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const APP_DIR = 'D:/a7777/新建文件夹/新建文件夹/baizhi-danci/resources';
const ASAR = path.join(APP_DIR, 'app.asar');
const SRC = 'C:/Users/a7777/Desktop/白纸单词';
const APPLY = process.argv.indexOf('--apply') !== -1;

/* 用本地新文件替换 asar 里的对应条目 */
const REPLACE = {
  'web/words_paper.html': path.join(SRC, 'index.html'),
  'web/script.js': path.join(SRC, 'script.js'),
  'web/style.css': path.join(SRC, 'style.css'),
  'web/skill.md': path.join(SRC, 'skill.md'),
  'web/change.md': path.join(SRC, 'README.md')
};

/* ---------- 1. 读原 asar ---------- */
const buf = fs.readFileSync(ASAR);
const size = buf.readUInt32LE(4);
const headerBuf = buf.subarray(8, 8 + size);
const strLen = headerBuf.readUInt32LE(4);
const header = JSON.parse(headerBuf.subarray(8, 8 + strLen).toString('utf8'));
const base = 8 + size;

const entries = [];   // { path, size, content }
function walk(node, rel) {
  if (node.files) {
    Object.keys(node.files).forEach(function (k) { walk(node.files[k], rel ? rel + '/' + k : k); });
  } else if (node.offset !== undefined) {
    entries.push({ path: rel, size: Number(node.size), offset: Number(node.offset) });
  }
}
walk(header, '');
console.log('原包内文件数 =', entries.length);

/* ---------- 2. 取内容（本地替换优先） ---------- */
const local = {};
Object.keys(REPLACE).forEach(function (key) {
  local[key] = fs.readFileSync(REPLACE[key]);
  console.log('替换', key, '<-', REPLACE[key], local[key].length, '字节');
});

let delta = 0;
const out = entries.map(function (e) {
  let content = buf.subarray(base + e.offset, base + e.offset + e.size);
  if (local[e.path]) {
    delta += local[e.path].length - e.size;
    content = local[e.path];
  }
  return { path: e.path, content: content };
});

/* ---------- 3. 重算 offset 与 integrity ---------- */
let cursor = 0;
const newTree = { files: {} };
function ensureDir(parts) {
  let node = newTree;
  parts.forEach(function (p) {
    if (!node.files[p]) node.files[p] = { files: {} };
    node = node.files[p];
  });
  return node;
}
out.forEach(function (e) {
  const hash = crypto.createHash('sha256').update(e.content).digest('hex');
  e.offset = cursor;
  cursor += e.content.length;
  const parts = e.path.split('/');
  const name = parts.pop();
  ensureDir(parts).files[name] = {
    size: e.content.length,
    offset: String(e.offset),
    integrity: { algorithm: 'SHA256', hash: hash, blockSize: 4194304, blocks: [hash] }
  };
});

/* ---------- 4. 序列化 ---------- */
const json = Buffer.from(JSON.stringify(newTree), 'utf8');
const pad = (4 - (json.length % 4)) % 4;
const payload = Buffer.concat([u32(json.length), json, Buffer.alloc(pad)]);
const newHeader = Buffer.concat([u32(payload.length), payload]);
const archive = Buffer.concat([u32(4), u32(newHeader.length), newHeader].concat(out.map(function (e) { return e.content; })));

function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; }

const dest = ASAR + '.new';
fs.writeFileSync(dest, archive);
console.log('已生成', dest, archive.length, '字节（原', buf.length, '，体积差', delta, '）');

/* ---------- 5. 自检：重新解析并逐字节比对 ---------- */
const check = fs.readFileSync(dest);
const cSize = check.readUInt32LE(4);
const cHeaderBuf = check.subarray(8, 8 + cSize);
const cStrLen = cHeaderBuf.readUInt32LE(4);
const cHeader = JSON.parse(cHeaderBuf.subarray(8, 8 + cStrLen).toString('utf8'));
const cBase = 8 + cSize;
let bad = 0, count = 0;
const flat = [];
(function w(node, rel) {
  if (node.files) { Object.keys(node.files).forEach(function (k) { w(node.files[k], rel ? rel + '/' + k : k); }); }
  else { flat.push({ path: rel, node: node }); }
})(cHeader, '');
flat.forEach(function (f) {
  count++;
  const got = check.subarray(cBase + Number(f.node.offset), cBase + Number(f.node.offset) + Number(f.node.size));
  const h = crypto.createHash('sha256').update(got).digest('hex');
  if (h !== f.node.integrity.hash) { bad++; console.log('!! 校验失败', f.path); }
  if (f.path === 'web/script.js' || f.path === 'web/style.css' || f.path === 'web/words_paper.html') {
    const want = fs.readFileSync(REPLACE[f.path]);
    if (!got.equals(want)) { bad++; console.log('!! 内容与本地不一致', f.path); }
    else console.log('   OK', f.path, got.length, '字节');
  }
});
console.log('自检：文件数', count, '，异常', bad);

/* ---------- 6. 写入安装目录（需 --apply） ---------- */
if (!APPLY) {
  console.log('\n未加 --apply，仅生成 .new。确认无误后执行：node pack.js --apply');
  process.exit(bad ? 1 : 0);
}
if (bad) { console.log('自检未通过，拒绝写入'); process.exit(1); }

const stamp = new Date().toISOString().slice(0, 10);
const backup = path.join(APP_DIR, 'app.asar.bak-' + stamp);
if (!fs.existsSync(backup)) {
  fs.copyFileSync(ASAR, backup);
  console.log('已备份原包 →', backup);
} else {
  console.log('备份已存在，跳过备份 →', backup);
}
fs.copyFileSync(dest, ASAR);
fs.unlinkSync(dest);
console.log('已写入', ASAR, fs.statSync(ASAR).size, '字节');
