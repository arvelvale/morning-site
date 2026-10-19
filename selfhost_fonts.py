# -*- coding: utf-8 -*-
"""自托管 LXGW WenKai Screen：只下载官网用字覆盖到的 woff2 切片并生成本地 CSS。

做法：
  1. 拉 CDN 的 lxgwwenkaiscreen.css（97 个 @font-face，各带 unicode-range）
  2. 用 charset.txt（extract_charset.py 产物）算出需要哪些切片
  3. 从 jsdelivr 下载这些切片到 assets/fonts/files/
  4. 生成本地 assets/fonts/lxgw-wenkai-screen.css（仅含用到的 face，路径改写为相对路径）
"""
import os
import re
import urllib.request

BASE = os.path.dirname(os.path.abspath(__file__))
FONT_DIR = os.path.join(BASE, "assets", "fonts")
FILES_DIR = os.path.join(FONT_DIR, "files")
CDN = "https://cdn.jsdelivr.net/npm/lxgw-wenkai-screen-webfont@1.7.0/"

os.makedirs(FILES_DIR, exist_ok=True)

import time

def fetch(url, tries=8):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            return urllib.request.urlopen(req, timeout=60).read()
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(1.5 * (i + 1))
    raise RuntimeError(f"下载失败: {url} -> {last}")

_css_cache = os.path.join(BASE, "cdn_lxgwwenkaiscreen.css")
if os.path.exists(_css_cache):
    css = open(_css_cache, encoding="utf-8").read()
else:
    css = fetch(CDN + "lxgwwenkaiscreen.css").decode()
    with open(_css_cache, "w", encoding="utf-8") as fh:
        fh.write(css)

faces = []
for block in re.findall(r"@font-face\s*\{([^}]+)\}", css):
    fam = re.search(r"font-family:\s*'([^']+)'", block).group(1)
    weight = re.search(r"font-weight:\s*(\d+)", block).group(1)
    fname = re.search(r"url\('\./files/([^']+\.woff2)'\)", block).group(1)
    ur = re.search(r"unicode-range:\s*(.+)", block).group(1).strip()
    faces.append({"family": fam, "weight": weight, "file": fname, "range": ur})

def parse_ranges(ur):
    """'U+1f1e9-1f1f5, U+1f21a' -> set[int]"""
    out = set()
    for tok in ur.split(","):
        tok = tok.strip().upper().replace("U+", "")
        if not tok:
            continue
        if "-" in tok:
            a, b = tok.split("-")
            out.update(range(int(a, 16), int(b, 16) + 1))
        elif "?" in tok:
            out.update(int(tok.replace("?", "0"), 16) * 1)  # 粗略，本项目切片无通配
        else:
            out.add(int(tok, 16))
    return out

charset = open(os.path.join(BASE, "charset.txt"), encoding="utf-8").read()
cps = {ord(c) for c in charset}

need = []
covered = set()
for f in faces:
    rs = parse_ranges(f["range"])
    hit = cps & rs
    if hit:
        need.append(f)
        covered |= hit

missing = cps - covered
print(f"切片总数 {len(faces)}，需要下载 {len(need)} 个；字符覆盖率 {len(covered)}/{len(cps)}")
uncovered_cjk = [chr(c) for c in missing if c > 0x2E7F]
if uncovered_cjk:
    print("未覆盖的 CJK 字符（将回退到楷体）:", "".join(uncovered_cjk))

# 下载切片（fetch 已在上方定义，带重试）
total = 0
for f in need:
    dest = os.path.join(FILES_DIR, f["file"])
    if os.path.exists(dest):
        size = os.path.getsize(dest)
    else:
        data = fetch(CDN + "files/" + f["file"])
        with open(dest, "wb") as fh:
            fh.write(data)
        size = len(data)
    total += size
    f["size"] = size
print(f"下载完成，共 {len(need)} 个文件，{total/1024:.0f} KB")

# 生成本地 CSS
lines = ["/* LXGW WenKai Screen 自托管切片（仅含官网用字覆盖的切片，源: v1.7.0） */"]
for f in need:
    lines.append(
        "@font-face {\n"
        f"  font-family: '{f['family']}';\n"
        "  font-style: normal;\n"
        f"  font-weight: {f['weight']};\n"
        "  font-display: swap;\n"
        f"  src: url('./files/{f['file']}') format('woff2');\n"
        f"  unicode-range: {f['range']}\n"
        "}\n"
    )
out_css = os.path.join(FONT_DIR, "lxgw-wenkai-screen.css")
with open(out_css, "w", encoding="utf-8", newline="\n") as fh:
    fh.write("\n".join(lines))
print("CSS 已生成:", out_css)

# 最大的 3 个切片（供 preload 参考）
big = sorted(need, key=lambda x: -x["size"])[:3]
for f in big:
    print(f"  preload 候选: {f['file']}  {f['size']/1024:.0f} KB")
