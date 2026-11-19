# -*- coding: utf-8 -*-
"""生成打赏收款码占位图。用户用自己的微信收款码替换 images/reward-qr.png 即可。"""
import random
from PIL import Image, ImageDraw, ImageFont

W = H = 750
img = Image.new('RGB', (W, H), '#ffffff')
d = ImageDraw.Draw(img)

font_path = 'C:/Windows/Fonts/msyhbd.ttc'
font_path_reg = 'C:/Windows/Fonts/msyh.ttc'
font_title = ImageFont.truetype(font_path, 46)
font_sub = ImageFont.truetype(font_path_reg, 30)
font_small = ImageFont.truetype(font_path_reg, 24)

# 顶部提示
def center_text(text, y, font, fill):
    bbox = d.textbbox((0, 0), text, font=font)
    w = bbox[2] - bbox[0]
    d.text(((W - w) / 2, y), text, font=font, fill=fill)

center_text('请替换为你的微信收款码', 60, font_title, '#1a1a1a')
center_text('Replace with your WeChat QR code', 130, font_sub, '#888888')

# 画一个二维码样式的占位图案（非真实可扫码）
random.seed(20261119)
qr_x0, qr_y0, cell, n = 137, 210, 19, 25
for r in range(n):
    for c in range(n):
        # 三个定位角
        corner = (
            (r < 7 and c < 7) or
            (r < 7 and c >= n - 7) or
            (r >= n - 7 and c < 7)
        )
        if corner:
            # 定位方块外框 + 内芯
            in_block = (
                (r < 7 and c < 7) or
                (r < 7 and c >= n - 7) or
                (r >= n - 7 and c < 7)
            )
            rr = r % 7 if c < 7 else r
            cc = c if c < 7 else c - (n - 7)
            if rr < 7:
                edge = rr in (0, 6) or cc in (0, 6)
                core = 2 <= rr <= 4 and 2 <= cc <= 4
                on = edge or core
            else:
                on = random.random() > 0.5
        else:
            on = random.random() > 0.5
        if on:
            x = qr_x0 + c * cell
            y = qr_y0 + r * cell
            d.rectangle([x, y, x + cell - 2, y + cell - 2], fill='#1a1a1a')

# 底部提示（二维码区约到 y=685，提示放在其下方空白处）
center_text('（此图为占位示意，不可扫码）', 700, font_small, '#c0392b')

out = 'images/reward-qr.png'
img.save(out)
print('saved', out, img.size)
