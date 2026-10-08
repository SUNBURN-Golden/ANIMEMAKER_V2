#!/usr/bin/env python3
"""
V2 런처 아이콘 · 시작 화면 만들기 (Python 3 + Pillow + numpy 필요)

데스크톱 아이콘(../build/icon.png, 512px) 의 그림(박수판 + 재생 버튼 + V2 딱지 + 반짝이)을 배경(하늘색 → 보라 그라데이션)에서
떼어 내서 안드로이드 이미지들을 만든다.

  android/app/src/main/res/mipmap-*dpi/ic_launcher_{background,foreground,monochrome}.png   적응형 아이콘 (API 26+) 층 세 장
  android/app/src/main/res/mipmap-*dpi/ic_launcher.png, ic_launcher_round.png                옛 아이콘 (API 24~25)
  android/app/src/main/res/drawable/splash.png, drawable-{port,land}-*dpi/splash.png          시작 화면 (안드로이드 11 이하)

적응형 아이콘 규칙: 캔버스 108dp 중 가운데 지름 66dp 원 안이 안전 영역 → 그림 전체가 그 원 안에 들어가게 크기를 정한다.
실행: python3 mobile/tools/make-icons.py   (저장소 어디서 실행해도 된다)
"""
import math
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
MOBILE = os.path.dirname(HERE)
REPO = os.path.dirname(MOBILE)
SRC = os.path.join(REPO, 'build', 'icon.png')
FONT = os.path.join(REPO, 'src', 'renderer', 'assets', 'fonts', 'Pretendard-Bold.otf')
RES = os.path.join(MOBILE, 'android', 'app', 'src', 'main', 'res')

DENSITIES = {'mdpi': 1.0, 'hdpi': 1.5, 'xhdpi': 2.0, 'xxhdpi': 3.0, 'xxxhdpi': 4.0}
SAFE_DIAMETER_DP = 66.0   # 적응형 아이콘 안전 영역 지름
ART_DIAMETER_DP = 65.0    # 그림을 감싸는 원 지름 (안전 영역보다 조금 작게: 반올림 오차 여유)
CANVAS_DP = 108.0         # 적응형 아이콘 전체 크기
VISIBLE_DP = 72.0         # 마스크(원·둥근 사각형)에 가려지고 남는 보이는 크기


def load_source():
    """원본 → (BG 한 줄 색표, 그림 RGBA(색 복원 + 알파), 판 모양 알파)"""
    im = np.array(Image.open(SRC).convert('RGBA')).astype(np.float64)
    h, w, _ = im.shape
    samples = {}
    for y in range(h):
        if 70 <= y <= 440:
            samples[y] = im[y, 40, :3]          # 판 왼쪽 가장자리 (그림이 없는 곳)
        elif 16 <= y < 70:
            samples[y] = im[y, w // 2, :3]       # 위쪽은 가운데 (박수판이 시작하기 전)
    ys = sorted(samples)
    cols = np.array([samples[y] for y in ys])
    rows = np.arange(h)
    bg = np.stack([np.interp(rows, ys, cols[:, c]) for c in range(3)], axis=1)   # h x 3 (그라데이션은 세로로만 변한다)
    a = im[:, :, 3:4] / 255.0
    flat = a * im[:, :, :3] + (1 - a) * bg[:, None, :]       # 배경 위에 얹어 본 모습 (흰색 칸이 약간 투명하다)
    d = np.sqrt(((flat - bg[:, None, :]) ** 2).sum(axis=2))
    plate = im[:, :, 3] > 10
    alpha = np.clip((d - 12.0) / (60.0 - 12.0), 0, 1) * plate
    with np.errstate(divide='ignore', invalid='ignore'):
        color = (flat - (1 - alpha[:, :, None]) * bg[:, None, :]) / alpha[:, :, None]
    color = np.clip(np.nan_to_num(color), 0, 255)
    art = np.dstack([color, alpha * 255.0]).astype(np.uint8)
    return bg, ys[0], art, flat, d, plate


BG, _Y0, ART, FLAT, DIST, PLATE = load_source()
SRC_H = ART.shape[0]
PLATE_TOP, PLATE_BOTTOM = 16, 496     # 판이 위아래로 차지하는 줄 (원본 512px 기준)


def gradient_color(t):
    """t=0(위) ~ 1(아래) → 원본 판의 그라데이션 색"""
    y = PLATE_TOP + np.clip(t, 0, 1) * (PLATE_BOTTOM - PLATE_TOP)
    ys = np.arange(SRC_H)
    return np.array([np.interp(y, ys, BG[:, c]) for c in range(3)]).T


def gradient_image(w, h, y0=0.0, y1=1.0):
    """w x h 세로 그라데이션. y0..y1 = 이미지 위·아래 끝이 판의 어느 위치(0~1)에 해당하는지 (범위 밖은 끝 색으로 늘림)"""
    t = y0 + (np.arange(h) + 0.5) / h * (y1 - y0)
    col = gradient_color(t)                           # h x 3
    arr = np.repeat(col[:, None, :], w, axis=1)
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), 'RGB').convert('RGBA')


def enclosing_circle(mask):
    """알파가 있는 점들을 감싸는 가장 작은 원 (중심 x, y, 반지름) — 볼록 껍질의 점들로 근사 후 중심을 조금씩 옮겨 줄인다"""
    ys, xs = np.nonzero(mask)
    pts = np.stack([xs, ys], axis=1).astype(np.float64)
    c = (pts.min(axis=0) + pts.max(axis=0)) / 2
    best = np.sqrt(((pts - c) ** 2).sum(axis=1)).max()
    step = 16.0
    while step > 0.25:
        improved = False
        for dx, dy in ((step, 0), (-step, 0), (0, step), (0, -step), (step, step), (-step, -step), (step, -step), (-step, step)):
            cc = c + (dx, dy)
            r = np.sqrt(((pts - cc) ** 2).sum(axis=1)).max()
            if r < best - 1e-9:
                best, c, improved = r, cc, True
        if not improved:
            step /= 2
    return c[0], c[1], best


# 그림 모양 (알파 > 0.35 인 점들) 을 감싸는 원: 안전 영역에 맞출 때 쓴다
CX, CY, CR = enclosing_circle(ART[:, :, 3] > 0.35 * 255)


def mono_mask():
    """한 가지 색 아이콘(테마 아이콘)용 실루엣: 그림 모양에서 박수판 줄무늬·재생 삼각형·V2 글씨를 구멍으로 뺀다"""
    f = ART[:, :, :3].astype(np.int32)
    alpha = ART[:, :, 3] > 0.5 * 255
    white = f.min(axis=2) > 215
    coral = (f[:, :, 0] > 200) & (f[:, :, 1] < 150) & (f[:, :, 2] < 170)
    yy, xx = np.mgrid[0:SRC_H, 0:ART.shape[1]]
    stripes = white & (yy < 216)                                   # 박수판 위쪽의 흰 줄무늬
    play = coral & (yy >= 216) & (yy <= 400) & (xx >= 108) & (xx <= 405)   # 카드 가운데 재생 삼각형
    badge_text = white & (yy >= 396) & (xx <= 340)                 # 주황 딱지 안의 흰 'V2'
    m = alpha & ~stripes & ~play & ~badge_text
    img = Image.fromarray((m * 255).astype(np.uint8), 'L').filter(ImageFilter.GaussianBlur(0.7))
    return img


def art_layer(size_px, scale_dp_circle=ART_DIAMETER_DP, mono=False):
    """size_px x size_px 투명 캔버스 가운데에 그림을 얹은 RGBA (그림을 감싸는 원 지름 = scale_dp_circle dp)"""
    s = size_px / CANVAS_DP
    k = (scale_dp_circle / 2 * s) / CR                       # 원본 px → 출력 px 배율
    src = Image.fromarray(ART, 'RGBA')
    if mono:
        m = mono_mask()
        src = Image.merge('RGBA', (Image.new('L', m.size, 255), Image.new('L', m.size, 255), Image.new('L', m.size, 255), m))
    pre = src.convert('RGBa')                                  # 미리 곱한 알파로 줄여야 가장자리 색이 번지지 않는다
    nw, nh = max(1, round(src.width * k)), max(1, round(src.height * k))
    small = pre.resize((nw, nh), Image.LANCZOS).convert('RGBA')
    canvas = Image.new('RGBA', (size_px, size_px), (0, 0, 0, 0))
    ox = round(size_px / 2 - CX * k)
    oy = round(size_px / 2 - CY * k)
    layer = Image.new('RGBA', canvas.size, (0, 0, 0, 0))
    layer.paste(small, (ox, oy))          # 음수 위치도 잘려서 들어간다 (투명한 곳 위라 덮어써도 같다)
    canvas.alpha_composite(layer)
    return canvas


def adaptive_background(size_px):
    """배경층: 보이는 창(72dp)에 판의 그라데이션 전체(위 하늘색 → 아래 보라)가 들어오게 늘린다"""
    s = size_px / CANVAS_DP
    top_dp = (CANVAS_DP - VISIBLE_DP) / 2
    y0 = -top_dp / VISIBLE_DP
    y1 = (CANVAS_DP - top_dp) / VISIBLE_DP
    return gradient_image(size_px, size_px, y0, y1)


def rounded_mask(size, radius, supersample=4):
    big = Image.new('L', (size * supersample, size * supersample), 0)
    ImageDraw.Draw(big).rounded_rectangle([0, 0, size * supersample - 1, size * supersample - 1], radius=radius * supersample, fill=255)
    return big.resize((size, size), Image.LANCZOS)


def circle_mask(size, supersample=4):
    big = Image.new('L', (size * supersample, size * supersample), 0)
    ImageDraw.Draw(big).ellipse([0, 0, size * supersample - 1, size * supersample - 1], fill=255)
    return big.resize((size, size), Image.LANCZOS)


def legacy_icon(px, round_shape, art_scale=0.92):
    """API 24~25 용 옛 아이콘: 적응형 층을 겹쳐 보이는 창(72dp)만 잘라 둥근 사각형/원 마스크를 씌운다"""
    big = round(px * CANVAS_DP / VISIBLE_DP)
    base = adaptive_background(big)
    base.alpha_composite(art_layer(big, ART_DIAMETER_DP * art_scale))
    off = (big - px) // 2
    crop = base.crop((off, off, off + px, off + px))
    mask = circle_mask(px) if round_shape else rounded_mask(px, round(px * 0.2))
    out = Image.new('RGBA', (px, px), (0, 0, 0, 0))
    out.paste(crop, (0, 0), mask)
    return out


def save(img, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, optimize=True)


def make_launcher():
    for dens, scale in DENSITIES.items():
        d = os.path.join(RES, f'mipmap-{dens}')
        layer_px = round(CANVAS_DP * scale)
        save(adaptive_background(layer_px), os.path.join(d, 'ic_launcher_background.png'))
        save(art_layer(layer_px), os.path.join(d, 'ic_launcher_foreground.png'))
        save(art_layer(layer_px, mono=True), os.path.join(d, 'ic_launcher_monochrome.png'))
        px = round(48 * scale)
        save(legacy_icon(px, False), os.path.join(d, 'ic_launcher.png'))
        save(legacy_icon(px, True), os.path.join(d, 'ic_launcher_round.png'))


def wordmark_font(px):
    try:
        return ImageFont.truetype(FONT, px)
    except OSError:
        return ImageFont.load_default()


def splash_image(w, h):
    img = gradient_image(w, h, 0.0, 1.0)
    short = min(w, h)
    # 그림: 감싸는 원 지름이 짧은 변의 40%
    size = round(short * 0.44)
    k = (short * 0.40 / 2) / CR
    pre = Image.fromarray(ART, 'RGBA').convert('RGBa')
    art = pre.resize((round(ART.shape[1] * k), round(ART.shape[0] * k)), Image.LANCZOS).convert('RGBA')
    text = 'AnimeMaker V2'
    font = wordmark_font(round(short * 0.075))
    tb = ImageDraw.Draw(img).textbbox((0, 0), text, font=font)
    tw, th = tb[2] - tb[0], tb[3] - tb[1]
    gap = round(short * 0.035)
    art_cx, art_cy = CX * k, CY * k
    group_h = round(short * 0.40) + gap + th
    top = (h - group_h) // 2
    ox = round(w / 2 - art_cx)
    oy = round(top + short * 0.40 / 2 - art_cy)
    layer = Image.new('RGBA', img.size, (0, 0, 0, 0))
    layer.paste(art, (ox, oy))
    img.alpha_composite(layer)
    draw = ImageDraw.Draw(img)
    tx = (w - tw) // 2 - tb[0]
    ty = top + round(short * 0.40) + gap - tb[1]
    draw.text((tx + max(1, round(short * 0.004)), ty + max(1, round(short * 0.006))), text, font=font, fill=(30, 20, 90, 110))
    draw.text((tx, ty), text, font=font, fill=(255, 255, 255, 255))
    return img.convert('RGB')


def make_splash():
    sizes = {
        'port': {'mdpi': (320, 480), 'hdpi': (480, 800), 'xhdpi': (720, 1280), 'xxhdpi': (960, 1600), 'xxxhdpi': (1280, 1920)},
        'land': {'mdpi': (480, 320), 'hdpi': (800, 480), 'xhdpi': (1280, 720), 'xxhdpi': (1600, 960), 'xxxhdpi': (1920, 1280)},
    }
    for orient, table in sizes.items():
        for dens, (w, h) in table.items():
            save(splash_image(w, h), os.path.join(RES, f'drawable-{orient}-{dens}', 'splash.png'))
    save(splash_image(480, 320), os.path.join(RES, 'drawable', 'splash.png'))


def contact_sheet(out):
    """눈으로 확인용: 여러 마스크·크기로 늘어놓은 그림 (저장소에는 넣지 않는다)"""
    sheet = Image.new('RGB', (900, 520), (225, 225, 230))
    x = 12
    for px in (48, 72, 96, 144, 192):
        sheet.paste(legacy_icon(px, False), (x, 12), legacy_icon(px, False))
        sheet.paste(legacy_icon(px, True), (x, 12 + px + 8), legacy_icon(px, True))
        x += px + 12
    big = 432
    comp = adaptive_background(big)
    comp.alpha_composite(art_layer(big))
    crop = comp.crop(((big - 288) // 2, (big - 288) // 2, (big + 288) // 2, (big + 288) // 2))
    sheet.paste(crop.convert('RGB'), (12, 220))
    ml = art_layer(big, mono=True)
    dark = Image.new('RGBA', (big, big), (40, 40, 60, 255))
    tint = Image.new('RGBA', (big, big), (255, 215, 160, 255))
    tint.putalpha(ml.getchannel('A'))
    dark.alpha_composite(tint)
    sheet.paste(dark.convert('RGB').crop(((big - 288) // 2, (big - 288) // 2, (big + 288) // 2, (big + 288) // 2)), (320, 220))
    sheet.save(out)


if __name__ == '__main__':
    if '--preview' in sys.argv:
        contact_sheet(sys.argv[sys.argv.index('--preview') + 1])
    else:
        make_launcher()
        make_splash()
        print('ok: launcher icons + splash written under', RES)
