"""
청약도우미 PWA 아이콘 생성
레퍼런스: 2점 투시도법 아파트 실루엣 두 동 (인디고 배경 + 골드 건물)
"""
from PIL import Image, ImageDraw, ImageFont
import os

SIZE = 512
BG   = (30, 27, 100)      # 인디고
GOLD = (205, 165, 53)      # 골드
GOLD_DIM = (160, 125, 35)  # 어두운 골드 (측면)
WHITE = (255, 255, 255)

def make_icon(size=512):
    img = Image.new("RGBA", (size, size), BG)
    d   = ImageDraw.Draw(img)
    s   = size / 512  # scale factor

    def p(x, y):
        return (round(x * s), round(y * s))

    def poly(pts, fill):
        d.polygon([p(x, y) for x, y in pts], fill=fill)

    def rect_win(pts, fill, rows, cols):
        """pts: parallelogram 4 꼭짓점 (TL, TR, BR, BL), 내부에 창문 격자"""
        tl, tr, br, bl = pts
        # 창문은 약간 안쪽에, 일정 간격으로
        pad_u = 0.12
        pad_d = 0.08
        pad_l = 0.10
        pad_r = 0.10
        for r in range(rows):
            for c in range(cols):
                # bilinear interpolation
                u0 = pad_l + c * (1 - pad_l - pad_r) / cols + 0.01
                u1 = pad_l + (c + 0.75) * (1 - pad_l - pad_r) / cols
                v0 = pad_u + r * (1 - pad_u - pad_d) / rows + 0.01
                v1 = pad_u + (r + 0.65) * (1 - pad_u - pad_d) / rows

                def lerp2(u, v):
                    top = (tl[0] + u*(tr[0]-tl[0]), tl[1] + u*(tr[1]-tl[1]))
                    bot = (bl[0] + u*(br[0]-bl[0]), bl[1] + u*(br[1]-bl[1]))
                    return (top[0] + v*(bot[0]-top[0]), top[1] + v*(bot[1]-top[1]))

                w_tl = lerp2(u0, v0)
                w_tr = lerp2(u1, v0)
                w_br = lerp2(u1, v1)
                w_bl = lerp2(u0, v1)
                d.polygon([p(*w_tl), p(*w_tr), p(*w_br), p(*w_bl)], fill=fill)

    # ── 뒤쪽 건물 (왼쪽, 더 작음) ──────────────────────────────────────
    # 정면 (앞면) — 세로 평행사변형
    # 2점 투시: 왼쪽으로 약간 기울어진 직사각형
    back_front = [
        (110, 165),   # TL
        (215, 148),   # TR
        (215, 380),   # BR
        (110, 395),   # BL
    ]
    poly(back_front, GOLD)
    # 창문 (4행 3열)
    rect_win(back_front, BG, 4, 3)

    # 측면 (오른쪽 옆면) — 우측 소실점 방향
    back_side = [
        (215, 148),   # TL (=정면 TR)
        (268, 163),   # TR
        (268, 390),   # BR
        (215, 380),   # BL (=정면 BR)
    ]
    poly(back_side, GOLD_DIM)
    # 창문 (4행 1열)
    rect_win(back_side, BG, 4, 1)

    # 지붕 (마름모꼴)
    back_roof = [
        (110, 165),   # L
        (215, 148),   # front-top-R
        (268, 163),   # R
        (163, 180),   # back
    ]
    poly(back_roof, GOLD)

    # ── 앞쪽 건물 (오른쪽, 더 큼) ──────────────────────────────────────
    # 정면 — 2점 투시 앞면
    front_front = [
        (224, 118),   # TL
        (370, 98),    # TR
        (370, 400),   # BR
        (224, 415),   # BL
    ]
    poly(front_front, GOLD)
    rect_win(front_front, BG, 5, 4)

    # 측면
    front_side = [
        (370, 98),    # TL
        (430, 120),   # TR
        (430, 410),   # BR
        (370, 400),   # BL
    ]
    poly(front_side, GOLD_DIM)
    rect_win(front_side, BG, 5, 1)

    # 지붕
    front_roof = [
        (224, 118),   # L
        (370, 98),    # front-R
        (430, 120),   # far-R
        (284, 140),   # back-L
    ]
    poly(front_roof, GOLD)

    # ── 텍스트 "청약도우미" ───────────────────────────────────────────
    font_paths = [
        "C:/Windows/Fonts/malgunbd.ttf",
        "C:/Windows/Fonts/malgun.ttf",
        "C:/Windows/Fonts/NanumGothicBold.ttf",
    ]
    font = None
    for fp in font_paths:
        if os.path.exists(fp):
            try:
                font = ImageFont.truetype(fp, round(38 * s))
                break
            except Exception:
                pass

    text = "청약도우미"
    if font:
        bbox = d.textbbox((0, 0), text, font=font)
        tw = bbox[2] - bbox[0]
        tx = (size - tw) // 2
        ty = round(430 * s)
        d.text((tx, ty), text, font=font, fill=GOLD)
    else:
        d.text((size//2 - 60, round(430*s)), text, fill=GOLD)

    return img

def main():
    out_dir = r"C:\Claude_content\cheongyak\public\icons"
    os.makedirs(out_dir, exist_ok=True)

    base = make_icon(512)
    base.save(os.path.join(out_dir, "icon_512.png"))
    base.resize((192, 192), Image.LANCZOS).save(os.path.join(out_dir, "icon_192.png"))
    base.resize((180, 180), Image.LANCZOS).save(os.path.join(out_dir, "icon_180.png"))
    base.resize((32,  32),  Image.LANCZOS).save(os.path.join(out_dir, "favicon.png"))
    print("아이콘 생성 완료!")

if __name__ == "__main__":
    main()
