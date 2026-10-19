# -*- coding: utf-8 -*-
"""提取官网实际会渲染的全部文字，生成子集字符表 charset.txt。

来源：JS bundle 字符串字面量、pet-rig.js、index.html 可见文本。
另含 ASCII 全集与常用中文标点兜底。
"""
import re
import os

BASE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(BASE, "charset.txt")

def strings_from(path):
    s = open(path, encoding="utf-8", errors="ignore").read()
    # 双引号 / 单引号 / 模板字符串字面量（粗粒度，宁多勿缺）
    parts = re.findall(r'"((?:[^"\\\n]|\\.)*)"', s)
    parts += re.findall(r"'((?:[^'\\\n]|\\.)*)'", s)
    parts += re.findall(r"`((?:[^`\\]|\\.)*)`", s)
    text = " ".join(parts)
    # 还原常见转义
    text = text.replace("\\n", " ").replace("\\t", " ").replace('\\"', '"').replace("\\'", "'").replace("\\\\", "\\")
    return text

chars = set()
chars |= set(strings_from(os.path.join(BASE, "assets", "index-Ck2UvqR3.js")))
chars |= set(strings_from(os.path.join(BASE, "pet-rig.js")))

html = open(os.path.join(BASE, "index.html"), encoding="utf-8").read()
body = re.sub(r"<[^>]+>", " ", html)
chars |= set(re.findall(r"[^\s]+", body) and body)

# ASCII 可打印字符全集 + 常用中文标点/符号兜底
chars |= {chr(c) for c in range(0x20, 0x7F)}
chars |= set("，。、；：？！“”‘’（）《》〈〉【】—…·～￥%＋－×÷＝°℃ⅠⅡⅢⅣⅤ①②③④⑤⑥⑦⑧⑨⑩■□●○▲△★☆♀♂✓✗→←↑↓")

# 去掉控制字符与代理区
final = sorted(c for c in chars if c.isprintable() and not (0xD800 <= ord(c) <= 0xDFFF) and ord(c) >= 0x20)

with open(OUT, "w", encoding="utf-8") as fh:
    fh.write("".join(final))

cjk = sum(1 for c in final if ord(c) > 0x2E7F)
print("总字符数:", len(final), "| 其中 CJK 等: ", cjk)
print("已写入:", OUT)
