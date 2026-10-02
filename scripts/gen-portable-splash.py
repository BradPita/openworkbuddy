#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 Windows 免安装版解压时显示的那张图（build/portable-splash.bmp）。

免安装版每次双击都要先把一万多个文件解压到 %TEMP% 才能启动，没这张图时这段时间屏幕上什么都没有：
用户报上来的「双击没反应」就是它，等不及再双击一次，第二份还会跟第一份抢同一个目录。
electron-builder 的 portable.splashImage 只认 24 位 BMP，解压完、拉起应用前自动关掉。

图上的字是烤进去的，Windows 那边不用有中文字体。图没有窗框，所以自己画一圈细边。
NSIS 按物理像素显示它，150% 缩放的屏上会小一圈，所以字号比 dmg 背景图大。

跑法：python3 scripts/gen-portable-splash.py
"""
import os
from PIL import Image, ImageDraw, ImageFont

W, H = 600, 210
BG = (250, 250, 251)
INK = (22, 22, 29)
DIM = (112, 112, 126)
LINE = (226, 226, 232)

FONT = "/System/Library/Fonts/Hiragino Sans GB.ttc"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W - 1, H - 1], outline=LINE)

    icon = Image.open(os.path.join(ROOT, "build", "icon.png")).convert("RGBA").resize((88, 88), Image.LANCZOS)
    img.paste(icon, (40, (H - 88) // 2), icon)

    f = lambda size, bold=False: ImageFont.truetype(FONT, size, index=2 if bold else 0)
    x = 156
    d.text((x, 48), "正在打开 OpenWorkBuddy…", font=f(24, True), fill=INK)
    d.text((x, 92), "免安装版每次打开都要先解压，可能要一两分钟", font=f(16), fill=INK)
    d.text((x, 118), "解压完窗口会自己出来，不用再双击", font=f(16), fill=INK)
    d.text((x, 156), "常用的话装 win-setup.exe 安装版，打开快得多", font=f(13), fill=DIM)

    p = os.path.join(ROOT, "build", "portable-splash.bmp")
    img.save(p)  # RGB 存 BMP 就是 24 位，不带 alpha
    print("写好", p, img.size, img.mode)


if __name__ == "__main__":
    main()
