"""
生成 RPA_Pilot 的图标资源。

设计：渐变圆角方块 + 白色机器人头。
  为什么是机器人头：这个产品是「机器人流程自动化」类工具（RPA），
  机器人脸是这件事最直白的视觉符号 —— 比播放三角强得多，
  而且 16px 下「一个方块 + 两只眼睛」依然能认出是张脸。

为什么按尺寸原生绘制、而不是把 256 缩下去：
  16/20/24 这些尺寸下，细线条和细节会糊。所以每个尺寸单独渲染：
  小尺寸把脸和眼睛整体放大、去掉天线和嘴，保证托盘里一眼能认出来。

为什么 .ico 里的条目格式要分开：
  Windows 的兼容性要求 —— 小尺寸条目必须是 32 位 DIB（BMP），
  只有 256×256 才推荐用 PNG 压缩。
"""
import io
import os
import struct

import numpy as np
from PIL import Image, ImageChops, ImageDraw

OUT_DIR = r'D:\RPA_Pilot\resources'

# 主题色：深蓝 → 亮青，专业感和辨识度兼顾
C_START = (0x1D, 0x4E, 0xD8)
C_END = (0x0E, 0xA5, 0xE9)

SUPERSAMPLE = 4


def make_icon(size: int) -> Image.Image:
    """按目标尺寸原生绘制一枚图标（4 倍超采样再缩，得到平滑边缘）"""
    W = size * SUPERSAMPLE
    small = size <= 24

    # ── 对角渐变底 ──
    yy, xx = np.mgrid[0:W, 0:W]
    t = (xx + yy) / (2 * (W - 1)) if W > 1 else np.zeros((W, W))
    c1 = np.array(C_START, dtype=float)[None, None, :]
    c2 = np.array(C_END, dtype=float)[None, None, :]
    rgb = c1 * (1 - t[..., None]) + c2 * t[..., None]
    alpha = np.full((W, W, 1), 255.0)
    grad = Image.fromarray(np.concatenate([rgb, alpha], axis=2).astype(np.uint8), 'RGBA')

    # ── 圆角方块 ──
    radius = max(1, int(round(W * 0.22)))
    mask = Image.new('L', (W, W), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, W - 1, W - 1], radius=radius, fill=255)
    tile = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    tile.paste(grad, (0, 0), mask)
    draw = ImageDraw.Draw(tile)

    # ── 白色机器人头（单独一层，最后整体合成）──
    face_layer = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    fd = ImageDraw.Draw(face_layer)

    if small:
        # 小尺寸：脸和眼睛整体放大，去掉天线与嘴 —— 细节在这个尺度下只会糊成一团
        fx0, fy0, fx1, fy1 = 0.195 * W, 0.255 * W, 0.805 * W, 0.785 * W
        f_radius = 0.155 * W
        eye_w, eye_h = 0.170 * W, 0.170 * W
        eye_radius = 0.055 * W
        eye_cy = 0.475 * W
        eye_dx = 0.135 * W
    else:
        # 大尺寸：加天线，比例收一点，显得精致
        fx0, fy0, fx1, fy1 = 0.235 * W, 0.330 * W, 0.765 * W, 0.760 * W
        f_radius = 0.115 * W
        eye_w, eye_h = 0.115 * W, 0.115 * W
        eye_radius = 0.035 * W
        eye_cy = 0.505 * W
        eye_dx = 0.105 * W

    fd.rounded_rectangle([fx0, fy0, fx1, fy1], radius=f_radius, fill=(255, 255, 255, 255))

    # 眼睛做成「镂空」 —— 让底下的渐变透出来，比画两个深色点更干净
    eye_holes = Image.new('L', (W, W), 0)
    ed = ImageDraw.Draw(eye_holes)
    for sign in (-1, 1):
        cx = 0.5 * W + sign * eye_dx
        ed.rounded_rectangle(
            [cx - eye_w / 2, eye_cy - eye_h / 2, cx + eye_w / 2, eye_cy + eye_h / 2],
            radius=eye_radius,
            fill=255,
        )
    face_alpha = ImageChops.subtract(face_layer.split()[3], eye_holes)
    face_layer.putalpha(face_alpha)
    tile.alpha_composite(face_layer)

    # ── 天线（只有大尺寸才画）──
    if not small:
        stem_w = 0.048 * W
        draw.rounded_rectangle(
            [0.5 * W - stem_w / 2, 0.245 * W, 0.5 * W + stem_w / 2, fy0 + 0.02 * W],
            radius=stem_w / 2,
            fill=(255, 255, 255, 255),
        )
        dot_r = 0.062 * W
        draw.ellipse(
            [0.5 * W - dot_r, 0.205 * W - dot_r, 0.5 * W + dot_r, 0.205 * W + dot_r],
            fill=(255, 255, 255, 255),
        )

    # ── 嘴（只有大尺寸才画，小尺寸画了就是一团脏）──
    if size >= 48:
        mouth_w = 0.048 * W
        draw.rounded_rectangle(
            [0.405 * W, 0.650 * W - mouth_w / 2, 0.595 * W, 0.650 * W + mouth_w / 2],
            radius=mouth_w / 2,
            fill=(255, 255, 255, 255),
        )

    # ── 内高光（只有大尺寸加，做出一点玻璃质感）──
    if size >= 48:
        inset = max(1, int(round(W * 0.012)))
        width = max(1, int(round(W * 0.012)))
        draw.rounded_rectangle(
            [inset, inset, W - 1 - inset, W - 1 - inset],
            radius=max(1, radius - inset),
            outline=(255, 255, 255, 46),
            width=width,
        )

    return tile.resize((size, size), Image.LANCZOS)


def bmp_entry(img: Image.Image) -> bytes:
    """ICO 内的 32 位 DIB 条目：BITMAPINFOHEADER + 自下而上的 BGRA + AND 掩码"""
    w, h = img.size
    px = np.array(img.convert('RGBA'))
    bgra = px[..., [2, 1, 0, 3]][::-1]
    xor = bgra.tobytes()
    header = struct.pack('<IiiHHIIiiII', 40, w, h * 2, 1, 32, 0, len(xor), 0, 0, 0, 0)
    row_bytes = ((w + 31) // 32) * 4
    return header + xor + (b'\x00' * row_bytes * h)


def png_entry(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, 'PNG', optimize=True)
    return buf.getvalue()


def write_ico(path: str, images: dict, png_sizes=(256,)) -> None:
    entries = []
    for size in sorted(images):
        data = png_entry(images[size]) if size in png_sizes else bmp_entry(images[size])
        entries.append((size, data))

    out = struct.pack('<HHH', 0, 1, len(entries))
    offset = 6 + 16 * len(entries)
    dirs, blobs = b'', b''
    for size, data in entries:
        dirs += struct.pack('<BBBBHHII',
                            0 if size >= 256 else size,
                            0 if size >= 256 else size,
                            0, 0, 1, 32, len(data), offset)
        blobs += data
        offset += len(data)
    with open(path, 'wb') as f:
        f.write(out + dirs + blobs)


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)

    app_sizes = [16, 20, 24, 32, 48, 64, 128, 256]
    app_images = {s: make_icon(s) for s in app_sizes}
    write_ico(os.path.join(OUT_DIR, 'icon.ico'), app_images)
    app_images[256].save(os.path.join(OUT_DIR, 'icon.png'), 'PNG', optimize=True)

    tray_sizes = [16, 20, 24, 32]
    write_ico(os.path.join(OUT_DIR, 'tray.ico'), {s: make_icon(s) for s in tray_sizes}, png_sizes=())
    make_icon(32).save(os.path.join(OUT_DIR, 'tray.png'), 'PNG', optimize=True)

    for name in ('icon.ico', 'icon.png', 'tray.ico', 'tray.png'):
        p = os.path.join(OUT_DIR, name)
        print(f'  {name:<12} {os.path.getsize(p):>7} bytes')

    # 预览图：把各尺寸摆成一条，确认 16px 下还认得出是机器人脸
    preview = Image.new('RGBA', (900, 220), (255, 255, 255, 255))
    x = 26
    for s in [16, 20, 24, 32, 48, 64, 128]:
        preview.alpha_composite(make_icon(s), (x, 100 - s // 2))
        x += s + 34
    docs_dir = os.path.join(os.path.dirname(OUT_DIR), 'docs')
    os.makedirs(docs_dir, exist_ok=True)
    preview.save(os.path.join(docs_dir, 'icon-preview.png'), 'PNG')
    print('  icon-preview.png  (preview -> docs/)')


if __name__ == '__main__':
    main()
