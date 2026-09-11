# 白纸单词 - 开发技能指南

## 目标
构建一个极简、温暖的单词记忆工具，模拟在白纸上记录和回忆单词的体验。

## 技术选型
- **HTML5 + CSS3 + Vanilla JavaScript**（推荐，避免复杂构建）
- 如需框架，可使用 Vue 3（通过 CDN 引入）但保持简单
- 数据持久化：`localStorage`
- 动画：CSS `transition` / `keyframes`，必要时使用 `requestAnimationFrame`

## 数据结构
```js
// localStorage 中的键：'paper-words'
// 值为 JSON 数组：
[
  {
    "id": "uuid",
    "word": "serendipity",
    "definition": "意外发现美好事物的运气",
    "x": 0.35,   // 相对页面宽度的比例（0~1），用于响应式定位
    "y": 0.42    // 相对页面高度的比例
  }
]
```

## 界面结构

html

```
<body class="paper">
  <header class="mode-switch">按钮：录入 / 记忆</header>
  <main id="paper-area">
    <!-- 动态生成的单词元素和输入框 -->
  </main>
</body>
```



### 视觉风格

- 背景颜色：`#fdf6e3` 或 `#f9f3e3`（暖黄）
- 纸张纹理：可使用 CSS 渐变或 subtle 图案（如 `repeating-linear-gradient` 模拟纸纹）
- 字体：单词 `font-family: 'Georgia', serif;`，释义 `font-family: 'Arial', sans-serif;`
- 单词颜色：`#4a3f35`（深棕），释义颜色：`#8a7f72`（浅棕灰）
- 输入框：背景透明或半透明白，边框 `1px solid #d9cfc1`，圆角 `4px`，聚焦时边框变深

## 核心交互逻辑

### 录入模式

- 监听 `#paper-area` 的 `click` 事件。
- 在点击位置创建一个浮动输入卡片（绝对定位），包含两个输入框（单词、释义）和保存按钮。
- 点击保存：验证非空，创建单词对象（生成唯一 id，计算相对坐标），存入 localStorage，移除输入卡片。
- 点击页面其他区域或按 Esc 可取消录入（不保存）。
- 录入的单词在录入模式下**不可见**（即隐藏在白纸中）。

### 记忆模式

- 维护一个当前显示的单词元素（唯一）。
- 点击 `#paper-area`：
  1. 判断点击目标是否为当前显示的单词元素。
     - 如果是：切换该单词的释义显示/隐藏。
     - 如果不是（空白处）：
       - 如果已有显示单词，先执行淡出动画并移除。
       - 从 localStorage 中随机选取一个单词（排除当前显示的）。
       - 在点击位置（或随机位置）创建单词元素，执行淡入动画。
       - 单词元素绝对定位，使用点击处的相对坐标（或随机坐标，确保不超出边界）。
- 单词元素包含单词文本，初始不显示释义；释义元素默认隐藏，点击单词时在下方显示。
- 动画：使用 CSS 类 `.fade-in` 和 `.fade-out`，过渡时间约 0.5s。

## 关键代码片段（伪代码）

javascript

```
// 切换到记忆模式时
let currentWordEl = null;

paperArea.addEventListener('click', (e) => {
  if (mode !== 'memory') return;
  
  const clickedWord = e.target.closest('.word-item');
  if (clickedWord) {
    // 点击单词：切换释义
    clickedWord.classList.toggle('show-definition');
    return;
  }
  
  // 点击空白
  if (currentWordEl) {
    currentWordEl.classList.add('fade-out');
    setTimeout(() => currentWordEl.remove(), 500);
  }
  
  const words = getStoredWords();
  if (words.length === 0) return;
  const randomWord = words[Math.floor(Math.random() * words.length)];
  
  const x = e.clientX / window.innerWidth;
  const y = e.clientY / window.innerHeight;
  
  currentWordEl = createWordElement(randomWord, x, y);
  paperArea.appendChild(currentWordEl);
  // 触发 reflow 后添加 fade-in 类
  requestAnimationFrame(() => currentWordEl.classList.add('fade-in'));
});
```



## 设计原则

1. **留白**：页面大部分区域保持空白，单词是唯一焦点。
2. **平滑**：所有动画时长 300-500ms，缓动函数 `ease-out`。
3. **一致性**：录入和记忆模式共享相同纸张背景，模式切换仅改变交互行为。
4. **可访问性**：按钮和输入框有清晰的焦点样式，单词元素可点击区域足够大（至少 24px）。

## 游戏模式补充（切单词）

### 切开音效
- 主音色：`slice.mp3`（与 `words_paper.html` 同目录的真实挥刀采样，约 1.1s）。
- 播放方式：**`<audio>` 元素池**（5 个轮转），不用 `fetch + decodeAudioData` —— 后者在 `file://` 下会被 CORS 拦掉。
- 连击表现：`playbackRate` 随连击升速（1.00 → 1.28，封顶 10 步），音量小幅递增。
- 垫底层：原有 Web Audio 合成的「嗖」声，采样在响时折减到 45%；采样缺失/失败时自动补到 100%，功能不降级。
- 首次用户手势里会静音空放一次做预解锁（Safari / iOS）。

### 连击 UI
- 结构：环形倒计时 + 放射刀芒 + 冲击波 + 数字 + 段位文案 + 迸溅火花。
- 环一圈流空的时长 = `COMBO_WINDOW`（1.6s），由 JS 注入 CSS 变量 `--combo-window`，**真源只有 JS 常量一处**。
- 段位：`×2 顺手 / ×4 流畅 / ×6 凌厉 / ×9 疾风 / ×12 入神`，各自一套配色（`tier-1` ~ `tier-5`）。
- 本局最高连击会在结算面板展示。

### 记忆模式朗读（Web Speech API）
- **零依赖**：用浏览器原生 `speechSynthesis` 念英文单词，不引任何音频文件/接口；无 `speechSynthesis` 时静默降级。
- 开关：工具栏 `#btn-speak`，状态持久化到 `localStorage.paper-speak`；关闭时 body 加 `.speak-off` 并立即 `stopSpeaking()`。
- **按钮标识**：`#btn-sound` / `#btn-speak` 均带可见文字标签（`span.icon-label`：`音效` / `朗读`），
  避免两个纯图标开关混淆；关闭态标签加删除线，并补 `title` 悬停提示（`applySound` / `applySpeak` 内设置）。
- **开关不发声（v1.4.2 起）**：`#btn-speak` 的点击回调只做「切状态 + `unlockSpeech()` 静默解锁」，
  **不得调 `speakWord`**；否则在录入/游戏模式下会凭空冒出单词音（已加回归测试）。
- 发音人：`pickVoice()` 优先本地离线女声（`samantha/zira/…`），`getVoices()` 异步 → 监听 `voiceschanged` 再选一次。
- 播放前一律 `cancel()` 旧条目，避免连续切词时队列堆积；每次发声回调里清 `.speaking` 标记。
- iOS/Safari 需用户手势解锁 → 在「游戏」按钮与朗读开关的同步栈里调 `unlockSpeech()`。
- 离开记忆模式 / 返回首页 / 收尾 / 页面隐藏时统一 `stopSpeaking()`，不残留语音。

### 刀气（滑动轨迹）
- **6 层**同轨迹叠加（由底到顶）：外晕 `blade-halo`（宽模糊 `bladeBlurWide`）→ 柔光 `blade-glow` → 刀身缎带 `blade-ribbon` → 内芯高光 `blade-core` → 刀锋锐线 `blade-edge` → 刀尖辉光 `blade-tip`。
- 渐变 4 段停靠（`blade-fade-0..3`）：尾透明 → 中段半实 → 刀尖白热，能量感沿刀路流动。
- 刀身非对称剖面：由中心线生成闭合缎带，**背侧加宽 35%、刃侧收窄 12%**，像一把有厚度的刀而非管子。
- 轨迹点带时间戳，超过 `BLADE_TTL`(150ms) 自动脱落，因此停手会自然消散；主循环每帧调用 `renderBlade()`。
- 手速决定刀气宽度（`BLADE_W_MIN` 20 → `BLADE_W_MAX` 46），颜色随连击段位升温（`data-hot` 1/2/3）。
- 斩击瞬间沿刀路炸开一道白光 `.slash-flash`，用 `clip-path` 收成**两头尖的刀痕**，340ms 后回收。

## 单词本（词库导入为白纸）

### 目标
内置 9 本词库（四级 / 六级 / 考研 / 专四专八 / 托福 / GRE / 中考 / 高中 / COCA 高频），
一键导入成一张**普通白纸**。导入结果与用户手写的白纸使用完全相同的
`{id,name,createdAt,words:[...]}` 结构，因此录入 / 记忆 / 游戏 / 统计 / 导出等全部功能天然一致。

### 数据结构
- 词库文件 `wordbooks.js`（由 `tools/gen_wordbooks.py` 产出，**勿手改**），挂到 `window.WORDBOOKS`：
  ```js
  window.WORDBOOKS = [
    { id:'cet4', name:'四级词汇', tag:'CET-4', group:'大学考试', desc:'…（全量 4539 词）', count:4539,
      data:'abandon|vt.丢弃；放弃，抛弃\nability|n.能力；能耐，本领\n…' }
  ];
  ```
- `data` 为紧凑文本，每行 `word|释义`，运行时按 `\n` 与 `|` 拆解（`parseBookWords`）。
- `group` 用于面板分组（大学考试 / 出国留学 / 中学 / 词频），缺省归入「其他」。

### 词库清单（全量，共 50258 词）
| id | 名称 | 徽章 | 分组 | 词数 |
|---|---|---|---|---|
| cet4 | 四级词汇 | CET-4 | 大学考试 | 4539 |
| cet6 | 六级词汇 | CET-6 | 大学考试 | 2220 |
| kaoyan | 考研词汇 | 考研 | 大学考试 | 5392 |
| tem48 | 专四专八 | TEM-4/8 | 大学考试 | 12540 |
| toefl | 托福词汇 | TOEFL | 出国留学 | 4510 |
| gre | GRE 词汇 | GRE | 出国留学 | 7728 |
| zhongkao | 中考词汇 | 中考 | 中学 | 1894 |
| gaozhong | 高中词汇 | 高考 | 中学 | 5643 |
| coca | COCA 高频 | 词频 | 词频 | 5792 |

### 词库生成（`tools/gen_wordbooks.py`）
- 词源：开源词表 `mahavivo/english-wordlists`（GitHub，经 jsDelivr 拉取；直连 GitHub 不通）。
- 依赖：`pip install opencc-python-reimplemented`（繁体释义转简体）。
- 用法：`python tools/gen_wordbooks.py`（下载带缓存）/ `--no-download`（只用缓存改规则重跑）/ `--list`。
- 清洗规则：剥离音标（方括号式 + 斜杠式）与义项编号 → 繁体转简体 → 释义截断 28 字 →
  按词形小写去重（**同形异义词合并义项**而非丢弃）。
- 词头切分要点（易踩坑，见 `trim_head()`）：源文件格式杂乱，需同时避开
  ① 贴合的词性缩写（`charm nJv.` / `may v.aux.`）、② 同形异义编号（`attribute 1`）、
  ③ 残缺音标残片（`continual kənˈtɪnjʊəl /adj.`，源文件丢了开头的 `[`），
  同时**不能误伤**真词组（`computer game` / `according to` / `ad hoc`）与并列变体（`adapter, adaptor`）。

### 交互
- 首页「我的白纸」标题栏新增「单词本」按钮 → 打开单词本面板（`#wordbook-panel`）。
- 面板按 `group` 分组，每组一个标题（组名 + 本数），列表可滚动（`.wordbook-panel-card .panel-body`）。
- 每本词库一张卡片（标签徽章 / 名称 / 说明 / 词数 / 导入按钮）。
- 点「导入」：`importWordbook()` 新建白纸 → 词条转标准单词对象（网格 + 抖动定位）→
  设为当前白纸 → 落盘 → 关面板 → 直接进入录入模式。同名白纸自动加序号（如「四级词汇 2」）。
- `window.WORDBOOKS` 缺失时面板显示空态，不影响其它功能。

### 容量提醒
词库收了全量后，单词多的白纸（如专四专八 1.2 万词）单张约占 1.5MB localStorage。
`savePapers()` 在配额写满时会区分提示「浏览器存储已满：请删掉部分白纸再导入」。
界面不会一次性渲染全部单词（记忆/游戏模式都是随机取一个），因此大词库不影响渲染性能。

## 测试清单

- □ 

  录入多个单词后，刷新页面数据仍存在。

- □ 

  录入位置在不同屏幕尺寸下大致对应。

- □ 

  记忆模式点击空白正确浮现新单词，旧单词消失。

- □ 

  点击单词显示/隐藏释义。

- □ 

  动画流畅，无闪烁。

- □ 

  移动端触摸正常工作。

- □ 

  模式切换无数据丢失。

- □ 

  单词本导入：选一本词库导入后生成白纸，词数/内容正确，可直接录入/记忆/游戏，与手写白纸一致。

- □ 

  重复导入同一词库，白纸名称自动加序号、不覆盖已有白纸。

- □ 

  单词本面板按分组显示（大学考试 / 出国留学 / 中学 / 词频），每组标题带本数；书目多时可滚动。

- □ 

  导入一本上万词的词库（如专四专八）后，仍能正常录入 / 记忆 / 游戏；localStorage 写满时提示明确。

- □ 

  记忆模式浮现单词时自动朗读；关闭朗读开关后不再朗读，刷新后开关状态保持。

- □ 

  单词卡「重听」按钮可重复朗读，且不改变释义显隐；游戏中切开单词不朗读、只出切刀音效。

- □ 

  点击「朗读」开关本身**不发出任何声音**（录入 / 游戏模式下点也不该响）；想试听走记忆模式或「重听」。

- □ 

  连续快速切换单词时不会「念串」（每次发声前先 cancel 上一条）；离开记忆模式/返回首页语音立即停止。

- □ 

  刀气为 6 层叠加（外晕→柔光→刀身→内芯→刀锋锐线→刀尖光点），停手后自然消散；斩击白光为双尖刀痕。

## 版本记录

### v1.4.2（2026-09-11）· 朗读开关误发声修复
- **Bug**：点「朗读」开关会凭空念一个随机单词（录入/游戏模式下也响）。
- **根因**：开关回调里「顺手」演示朗读 —— `unlockSpeech(); var w = pickWord(); if (w) speakWord(w.word, currentWordEl);`，
  而 `pickWord()` 从整张白纸随机取词，与当前模式、屏上是否有卡片无关。
- **修复**：开关只做「切状态 + 静默解锁」（`unlockSpeech()` 是 `volume = 0` 的空 utterance），**不再朗读任何单词**。
- **约束（写代码时守住）**：`#btn-speak` 的点击回调里**永远不要调 `speakWord`**。要试听请走记忆模式自动朗读或卡片「重听」。
- **回归测试**：`game-mode.test.js` 新增第 31 条，断言点开朗读不会念出白纸里的任何单词；该用例在旧代码上实测失败（「凭空朗读了单词：word1」）。
- **测试**：**39 条全绿**（game-mode 31 + wordbook 8）。

### v1.4.1（2026-09-11）· 开关标识修复
- **问题**：工具栏 `#btn-sound`（切词音效）与 `#btn-speak`（自动朗读）都是纯图标按钮，图标相近且无文字，用户分不清归属、也看不出开关状态。
- **修复**：两个按钮内各加可见文字标签 `span.icon-label`（`音效` / `朗读`），与其他文字按钮风格统一。
- **状态线索三叠加**：图标切换（喇叭/带叉喇叭、声波/声波加斜杠）+ 标签关闭态 `line-through` + 整钮 `opacity: .55`。
- **无障碍**：`aria-label` 契约不变（`关闭音效` / `开启音效` / `关闭自动朗读` / `开启自动朗读`），新增 `title` 悬停提示。
- **改动**：`words_paper.html`（2 处标签）、`style.css`（`.icon-label` + 关闭态删除线）、`script.js`（`applySound` / `applySpeak` 补 `title`）。
- **测试**：**38 条全绿**（`aria-label` 未变，测试无需改）。

### v1.4.0（2026-09-11）· 融合版
- **两条开发线合并**：以 v1.1.0 为共同基线做三方合并，把**协作者线（v1.2.1）**的功能
  并入本机线（v1.3.0），结果 `v1.4.0 ⊇ v1.2.1 ∪ v1.3.0`。
- **并入协作者功能**：记忆模式自动朗读（Web Speech API，零依赖）+ 朗读开关（持久化）+ 单词卡「重听」按钮；
  刀气由 3 层升级为 **6 层**（halo / glow / ribbon / core / tip / edge），刀身非对称剖面，
  斩击白光改**双尖刀痕**（`clip-path`）。游戏模式不朗读（仅切刀音效）。
- **保留本机功能**：单词本（9 本 50258 词）、分组面板、生成脚本、存储兜底，全部原样保留。
- **合并冲突 2 处**：`<meta name="version">`（取 v1.4.0）；`goHome()` 内新增行（`closeWordbookPanel()` 与
  `stopSpeaking()` **两行都保留**）。`style.css` 零冲突。
- **测试**：`game-mode.test.js` 采用协作者版 **30 条** + `wordbook.test.js` **8 条** = **38 条全绿**。
- **变更日志**：新增 `change.md`（记录 v1.1.0 → v1.4.0 完整演进与融合边界）。

### v1.3.0（2026-09-11）
- **词库补全**：内置词库由 6 本 9956 词扩到 **9 本 50258 词**，且每本均为**全量**
  （四级 4539 / 六级 2220 / 考研 5392 / 专四专八 12540 / 托福 4510 / GRE 7728 / 中考 1894 / 高中 5643 / COCA 高频 5792）。
  新增「专四专八」「高中词汇」「COCA 高频」三本；原「考研·托福·GRE·中考」由各 800 补到全量。
- **词头切分修复**：源词表格式杂乱，修掉三类污染 —— 词性缩写被吃进词头（`a art.` → `a`）、
  同形异义编号（`attribute 1/2`）、残缺音标残片（`continual kənˈtɪnjʊəl /adj.`）；
  同时保住了真词组（`computer game` / `according to`）与并列变体（`adapter, adaptor`）。
- **繁体转简体**：新增对繁体词表（高中 / 牛津高阶）的 opencc 简体化处理。
- **面板分组**：`WORDBOOKS` 新增 `group` 字段，单词本面板按「大学考试 / 出国留学 / 中学 / 词频」分组渲染，列表可滚动。
- **生成脚本入库**：新增 `tools/gen_wordbooks.py`（自包含：下载 → 清洗 → 生成），词库可复现、可增删。
- **存储兜底**：`savePapers()` 区分配额写满，提示「浏览器存储已满：请删掉部分白纸再导入」。
- **测试**：`tests/wordbook.test.js` 由 6 条增至 8 条（新增分组渲染、真实 wordbooks.js 结构完整性校验）；连同 game-mode 共 **28 条全绿**。

### v1.2.0（2026-09-11）
- **单词本（新功能）**：新增 `wordbooks.js`（`window.WORDBOOKS`），内置 6 本词库共 9956 词
  （四级 4537 全量 / 六级 2219 全量 / 考研·托福·GRE·中考 各 800）；首页新增「单词本」入口与面板，
  一键导入即生成一张与手写白纸**同构同功能**的白纸，同名自动加序号。
- **音效修复**：见 v1.1.0 补充 —— 修掉 AudioContext 卡 `suspended` 与一次性错误永久静音两处导致「没声音」的 bug。
- **测试**：新增 `tests/wordbook.test.js` 6 条用例（渲染 / 导入 / 同功能 / 重名 / 空词库 / 无词库），
  连同 `tests/game-mode.test.js` 20 条，全量 26/26 通过。

### v1.1.0（2026-09-11）
- **切开音效**：新增 `slice.mp3`（真实挥刀采样），以 5 个 `<audio>` 轮转播放；连击升速（`playbackRate` 1.00→1.28 封顶 10 步），原合成「嗖」声保留为垫底层。
- **连击 UI 重做**：环形倒计时（时长=连击窗口）+ 放射刀芒 + 冲击波 + 78px 弹跳数字 + 五档段位配色（顺手/流畅/凌厉/疾风/入神），结算面板新增最高连击与段位。
- **刀气美化**：三层同轨迹（外晕→渐变刀身→高光刀锋）+ 刀尖光点；轨迹点带时间戳自然消散；斩击沿刀路炸开白光。
- **测试**：`tests/game-mode.test.js` 新增段位切换、断连清理、刀气生成/消散、白光回收 4 条用例，全量 20/20 通过。

## 交付物

一个完整的 `index.html`（内联 CSS/JS）或分离的三个文件，可本地直接运行。代码应包含清晰注释，便于后续修改。

text

```

```