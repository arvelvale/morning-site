# -*- coding: utf-8 -*-
"""生成官网分享卡 og-image.png（1200x630，微信/Twitter 标准 OG 尺寸）。

用法（在隔离 venv 中运行）：
  C:/Users/19160/.workbuddy/binaries/python/envs/default/Scripts/python.exe make_og_image.py
"""
import os
from PIL import Image, ImageDraw, ImageFilter

BASE = os.path.dirname(os.path.abspath(__file__))
PET = os.path.join(BASE, "assets", "pets", "miro-idle.png")
OUT = os.path.join(BASE, "assets", "og-image.png")

W, H = 1200, 630
BG = (245, 239, 226)        # #F5EFE2 官网 theme-color
INK = (74, 59, 42)          # 深棕文字
ACCENT = (224, 122, 95)     # 暖橘点缀
SOFT = (235, 224, 201)      # 比底色深一档的柔色圆

img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)

# 背景柔色大圆（装饰，右侧偏移）
circ = Image.new("L", (900, 900), 0)
ImageDraw.Draw(circ).ellipse((0, 0, 900, 900), fill=255)
img.paste(Image.new("RGB", (900, 900), SOFT), (640, -135), circ.filter(ImageFilter.GaussianBlur(2)))

# 角色：米露 600x600 透明底，放到右侧圆内，略微放大
pet = Image.open(PET).convert("RGBA")
pet = pet.resize((620, 620), Image.LANCZOS)
img.paste(pet, (790, 95), pet)
d = ImageDraw.Draw(img)

# 文本（微软雅黑；标题加粗）
FB = os.path.join(r"C:\Windows\Fonts", "msyhbd.ttc")
FR = os.path.join(r"C:\Windows\Fonts", "msyh.ttc")
from PIL import ImageFont
f_title = ImageFont.truetype(FB, 96)
f_sub = ImageFont.truetype(FR, 40)
f_tag = ImageFont.truetype(FR, 30)

tx, ty = 90, 168
d.text((tx, ty), "喵灵", font=f_title, fill=INK)
w_mei = d.textlength("喵灵", font=f_title)
d.text((tx + w_mei + 22, ty + 26), "Morning", font=ImageFont.truetype(FB, 64), fill=ACCENT)

d.text((tx, ty + 178), "有些事情，不必一个人想完", font=f_sub, fill=INK)
d.text((tx, ty + 262), "以桌宠为入口的 AI 情感陪伴伙伴", font=f_tag, fill=(128, 112, 92))

# 底部小色条点缀
d.rounded_rectangle((tx, 548, tx + 132, 556), radius=4, fill=ACCENT)

img.save(OUT, "PNG", optimize=True)
print("saved:", OUT, os.path.getsize(OUT) // 1024, "KB")
