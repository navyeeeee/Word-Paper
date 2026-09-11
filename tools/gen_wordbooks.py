# -*- coding: utf-8 -*-
"""
白纸单词 · 单词本词库生成器
============================

从开源词表仓库 mahavivo/english-wordlists 拉取原始词表，清洗后生成
`wordbooks.js`（挂到 window.WORDBOOKS），供「白纸单词」的单词本功能使用。

用法：
    python tools/gen_wordbooks.py                # 下载（带缓存）并生成 wordbooks.js
    python tools/gen_wordbooks.py --no-download  # 只用缓存重新生成（改清洗规则时用）
    python tools/gen_wordbooks.py --list         # 只列出书单，不生成

依赖：opencc-python-reimplemented（繁体释义转简体）
    pip install opencc-python-reimplemented

清洗规则：
    1. 剥离音标（方括号式 [..] 与斜杠式 /../）与义项编号（1. 2) 3、）
    2. 繁体释义统一转简体（opencc t2s）
    3. 释义折叠空白、截断到 DEF_MAX 字符
    4. 词头精确切分：只保留真正的词组（computer game / according to），
       不被词性缩写（charm nJv.）、同形异义编号（attribute 1）、音标残片污染
    5. 按词形小写去重；同形异义词合并义项而非丢弃
"""
import argparse
import os
import re
import sys
import urllib.parse
import urllib.request

try:
    import opencc
except ImportError:
    sys.exit("缺少依赖：请先执行  pip install opencc-python-reimplemented")

BASE = "https://cdn.jsdelivr.net/gh/mahavivo/english-wordlists@master/"
HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, ".cache")
OUT = os.path.join(HERE, "..", "wordbooks.js")

DEF_MAX = 28
cc = opencc.OpenCC("t2s")
CJK = re.compile(r"[\u4e00-\u9fff]")

# (id, 名称, 徽章, 分组, 说明, 源文件)
BOOKS = [
    ("cet4",     "四级词汇",  "CET-4",   "大学考试", "大学英语四级大纲词汇", "CET4_edited.txt"),
    ("cet6",     "六级词汇",  "CET-6",   "大学考试", "大学英语六级大纲词汇", "CET6_edited.txt"),
    ("kaoyan",   "考研词汇",  "考研",    "大学考试", "考研英语大纲词汇", "NPEE_Wordlist.txt"),
    ("tem48",    "专四专八",  "TEM-4/8", "大学考试", "英语专业四、八级词汇", "英语专业四八级词汇表.txt"),
    ("toefl",    "托福词汇",  "TOEFL",   "出国留学", "托福考试核心词汇", "TOEFL.txt"),
    ("gre",      "GRE 词汇",  "GRE",     "出国留学", "GRE 考试词汇（含 8000 核心）", "GRE_8000_Words.txt"),
    ("zhongkao", "中考词汇",  "中考",    "中学",     "中考英语大纲词汇", "中考英语词汇表.txt"),
    ("gaozhong", "高中词汇",  "高考",    "中学",     "高中阶段参考词汇（含超纲标记词）", "台灣高中英文參考詞彙表.txt"),
    ("coca",     "COCA 高频", "词频",    "词频",     "美国当代英语语料库高频词精选", "COCA_abridged.txt"),
]

# ---------- 解析规则 ----------

HEAD = r"[A-Za-z][A-Za-z0-9'’.\- ]*(?:,\s*[A-Za-z][A-Za-z0-9'’.\- ]*)?"
LINE_RE = re.compile(
    r"^[＊*]?\s*(" + HEAD + r")"           # 1 词头（允许前导星号 = 超纲标记）
    r"(?:\s*\([^)]{0,12}\))?"              # 忽略 a (an) 这类括注
    r"\s*(?:\[[^\]]*\]|/[^/]{0,40}/)?"     # 忽略音标（方括号式 / 斜杠式）
    r"\s*(.*)$"                             # 2 释义
)
JUNK_DEF = re.compile(r"^[\s.·,;、()（）\[\]a-z]{0,6}$")
NUM_PREFIX = re.compile(r"\b\d+\s*[.、)]\s*")
NUM_MARK = re.compile(r"(?:^|\s)\d{1,2}[.、)]\s*|(?:^|\s)\d{1,2}\s+(?=[（(])")
SEP = re.compile(r"[./]")                  # 词性标记里的连接符：nJv.  n.X  v./n.
ACRO = re.compile(r"^[A-Za-z]\.$")         # 缩写词头后续字母：A. D.
POS = re.compile(
    r"^(n|v|vt|vi|adj|adv|a|ad|prep|conj|pron|interj|int|num|art|aux|"
    r"pl|abbr|det|part|modal|excl|pref|suf|suff|phr)\.?$", re.I)
# 源文件里少量音标残缺行："continual kənˈtɪnjʊəl /adj. …"（丢了开头的 [）
MALFORMED = re.compile(
    r"^(?P<w>[A-Za-z][A-Za-z'’.\-]*)\s+(?P<ipa>[^\s/]{1,40})\s*/\s*(?P<rest>[a-z]{1,6}\..*)$")


def normalize(s):
    m = MALFORMED.match(s)
    return m.group("w") + " " + m.group("rest") if m else s


def trim_head(word):
    """精确切出词头，避免把词性缩写 / 编号 / 音标残片吃进来"""
    tokens = word.split()
    if not tokens:
        return ""
    out = [tokens[0]]
    for t in tokens[1:]:
        if len(out) >= 3:
            break
        if out[-1].endswith(","):                      # a, an / adapter, adaptor
            out.append(t)
            continue
        if len(out) == 1 and len(out[0]) <= 3 and out[0].endswith(".") and ACRO.match(t):
            out.append(t)                              # A. D.
            continue
        if POS.match(t) or SEP.search(t) or t.isdigit():
            break                                      # 词性 / 编号 → 词头到此为止
        out.append(t)                                  # 真实词组 → 并入
    return " ".join(out).strip(" ,;")


def trunc(s):
    return s if len(s) <= DEF_MAX else s[:DEF_MAX].rstrip(" ;；,，、.。") + "…"


def clean_def(s):
    s = s.replace("|", "/")                # | 是行内分隔符，不能出现在释义里
    s = NUM_MARK.sub(" ", s)               # 去掉 "1. " "2) " "3 " 这类义项编号
    s = NUM_PREFIX.sub("", s)
    s = re.sub(r"\s+", " ", s).strip()
    s = s.strip(" ;；,，、.。/")
    s = cc.convert(s)                      # 繁 → 简
    return trunc(s)


def parse(txt):
    out, index, suspect = [], {}, []
    for line in txt.splitlines():
        s = normalize(line.strip().replace("\u3000", " "))
        if not s or s.startswith(("(", "（")) or "词)" in s[:20] or s.startswith("共"):
            continue
        m = LINE_RE.match(s)
        if not m:
            continue
        word = trim_head(m.group(1).strip())
        d = clean_def(m.group(2) or "")
        if not word or not d or JUNK_DEF.match(d):
            continue
        if len(word) == 1 and not CJK.search(d):
            continue                        # 单字母章节标题（A / B / C …）
        if len(word) > 24:
            suspect.append((word, d))       # 异常长的词头，输出后人工复核
        key = word.lower()
        if key in index:
            i = index[key]                  # 同形异义词合并义项，避免丢释义
            if d not in out[i][1]:
                out[i] = (out[i][0], trunc(out[i][1] + "；" + d))
            continue
        index[key] = len(out)
        out.append((word, d))
    return out, suspect


# ---------- 下载 / 解码 ----------

def fetch(name, no_download=False):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, re.sub(r'[\\/:*?"<>|]', "_", name))
    if no_download and not os.path.exists(path):
        sys.exit("缓存缺失：%s（去掉 --no-download 重新下载）" % name)
    if not os.path.exists(path):
        url = BASE + urllib.parse.quote(name)
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        raw = urllib.request.urlopen(req, timeout=60).read()
        open(path, "wb").write(raw)
        print("  下载 %s（%d 字节）" % (name, len(raw)))
    return path


def decode(path):
    raw = open(path, "rb").read()
    for enc in ("utf-8-sig", "utf-8", "gb18030"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", "replace")


# ---------- 入口 ----------

def main():
    ap = argparse.ArgumentParser(description="生成 wordbooks.js")
    ap.add_argument("--no-download", action="store_true", help="只用缓存，不联网")
    ap.add_argument("--list", action="store_true", help="只列出书单")
    args = ap.parse_args()

    if args.list:
        for bid, name, tag, group, desc, fname in BOOKS:
            print("%-10s %-12s %-8s %-8s %s" % (bid, name, tag, group, fname))
        return

    print("生成 wordbooks.js …\n")
    print("%-10s%-12s%8s%8s   %s" % ("id", "词库", "原始行", "收录", "源文件"))
    print("-" * 74)

    parts, total = [], 0
    for bid, name, tag, group, desc, fname in BOOKS:
        txt = decode(fetch(fname, args.no_download))
        pairs, suspect = parse(txt)
        n = len(pairs)
        total += n
        print("%-10s%-12s%8d%8d   %s%s" % (
            bid, name, len(txt.splitlines()), n, fname,
            "  [需复核 %d 条]" % len(suspect) if suspect else ""))
        for w, d in suspect[:3]:
            print("           ? %r -> %r" % (w, d[:40]))

        def esc(s):
            # 先转义单条文本，再拼装，避免把行分隔符 \n 也一并转义
            return s.replace("\\", "\\\\").replace('"', '\\"')

        data = "\\n".join("%s|%s" % (esc(w), esc(d)) for w, d in pairs)
        parts.append(
            "  {\n"
            '    id: "%s",\n'
            '    name: "%s",\n'
            '    tag: "%s",\n'
            '    group: "%s",\n'
            '    desc: "%s（全量 %d 词）",\n'
            "    count: %d,\n"
            '    data: "%s"\n'
            "  }" % (bid, name, tag, group, desc, n, n, data))

    header = """/**
 * 单词本内置词库 —— 「白纸单词」单词纸功能的词源。
 *
 * 数据来源：开源词表 mahavivo/english-wordlists（GitHub，经 jsDelivr 拉取）。
 * 清洗：剥离音标与义项编号、繁体释义转简体、释义截断至 %d 字、按词形去重
 *       （同形异义词合并义项）。
 * 结构：window.WORDBOOKS = [{ id, name, tag, group, desc, count, data }]，
 *       data 为紧凑文本，每行 "word|释义"，运行时按 \\n 与 | 拆解。
 *
 * 本文件由 tools/gen_wordbooks.py 生成，请勿手改；
 * 增删词库请改脚本里的 BOOKS 列表后重新生成。
 */
""" % DEF_MAX

    path = os.path.normpath(OUT)
    open(path, "w", encoding="utf-8", newline="\n").write(
        header + "window.WORDBOOKS = [\n" + ",\n".join(parts) + "\n];\n")

    size = os.path.getsize(path)
    print("-" * 74)
    print("共 %d 本词库 · %d 词 · 输出 %d 字节（%.0f KB）" % (len(parts), total, size, size / 1024))
    print("落盘：", path)


if __name__ == "__main__":
    main()
