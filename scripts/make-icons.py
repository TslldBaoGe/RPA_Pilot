"""
生成 RPA_Pilot 的图标资源。

设计：
  圆角方块 + 对角渐变（#1D4ED8 → #0EA5E9）+ 白色播放三角。
  播放三角 = 「执行任务」，是这个产品最核心的动作，在 16px 下也认得出来。

为什么按尺寸原生绘制、而不是把 256 缩下去：
  16/20/24 这些尺寸下，细线条和细节会糊成一团。所以每个尺寸单独渲染，
  小尺寸把三角加粗、去掉内高光，保证托盘里一眼能认出。

为什么 .ico 里的条目格式要分开：
  Windows 对 ICO 的兼容性要求 —— 小尺寸条目必须是 32 位 DIB（BMP）格式，
  只有 256×256 才推荐用 PNG 压缩。之前那个图标整份就是「一个 PNG 塞进 ICO」，
  任务栏里显示效果很差。这里按规范生成。
"""
import io
import os
import struct

import numpy as np
from PIL import Image, ImageDraw

OUT_DIR = r'D:\RPA_Pilot\resources'

# 主题色：深蓝 → 亮青，专业感和辨识度兼顾
C_START = (0x1D, 0x4E, 0xD8)
C_END = (0x0E, 0xA5, 0xE9)

SUPERSAMPLE = 4


def make_icon(size: int) -> Image.Image:
    """按目标尺寸原生绘制一枚图标（先 4 倍超采样再缩，得到平滑边缘）"""
    W = size * SUPERSAMPLE

    # ── 对角渐变 ──
    yy, xx = np.mgrid[0:W, 0:W]
    t = (xx + yy) / (2 * (W - 1)) if W > 1 else np.zeros((W, W))
    c1 = np.array(C_START, dtype=float)[None, None, :]
    c2 = np.array(C_END, dtype=float)[None, None, :]
    rgb = c1 * (1 - t[..., None]) + c2 * t[..., None]
    alpha = np.full((W, W, 1), 255.0)
    grad = Image.fromarray(np.concatenate([rgb, alpha], axis=2).astype(np.uint8), 'RGBA')

    # ── 圆角方块遮罩 ──
    radius = max(1, int(round(W * 0.22)))
    mask = Image.new('L', (W, W), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, W - 1, W - 1], radius=radius, fill=255)

    tile = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    tile.paste(grad, (0, 0), mask)

    draw = ImageDraw.Draw(tile)

    # ── 大尺寸加一圈内高光，做出玻璃质感；小尺寸加了反而脏 ──
    if size >= 48:
        inset = max(1, int(round(W * 0.012)))
        width = max(1, int(round(W * 0.012)))
        draw.rounded_rectangle(
            [inset, inset, W - 1 - inset, W - 1 - inset],
            radius=max(1, radius - inset),
            outline=(255, 255, 255, 46),
            width=width,
        )

    # ── 白色播放三角（视觉居中：三角形重心偏左，所以整体右移一点）──
    if size <= 24:
        half_w, half_h, shift = W * 0.235, W * 0.265, W * 0.020
    else:
        half_w, half_h, shift = W * 0.195, W * 0.225, W * 0.028

    cx = W / 2 + shift
    cy = W / 2
    draw.polygon(
        [(cx - half_w, cy - half_h), (cx - half_w, cy + half_h), (cx + half_w, cy)],
        fill=(255, 255, 255, 255),
    )

    return tile.resize((size, size), Image.LANCZOS)


def bmp_entry(img: Image.Image) -> bytes:
    """ICO 内的 32 位 DIB 条目：BITMAPINFOHEADER + 自下而上的 BGRA + AND 掩码"""
    w, h = img.size
    px = np.array(img.convert('RGBA'))
    bgra = px[..., [2, 1, 0, 3]][::-1]           # RGBA -> BGRA，并翻转成自下而上
    xor = bgra.tobytes()
    header = struct.pack('<IiiHHIIiiII', 40, w, h * 2, 1, 32, 0, len(xor), 0, 0, 0, 0)
    # 32 位图靠 alpha 通道透明，AND 掩码全 0 即可，但结构上必须存在且按 4 字节对齐
    row_bytes = ((w + 31) // 32) * 4
    return header + xor + (b'\x00' * row_bytes * h)


def png_entry(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, 'PNG', optimize=True)
    return buf.getvalue()


def write_ico(path: str, images: dict[int, Image.Image], png_sizes=(256,)) -> None:
    entries = []
    for size in sorted(images):
        data = png_entry(images[size]) if size in png_sizes else bmp_entry(images[size])
        entries.append((size, data))

    out = struct.pack('<HHH', 0, 1, len(entries))   # 保留位, 类型=1(图标), 数量
    offset = 6 + 16 * len(entries)
    dirs, blobs = b'', b''
    for size, data in entries:
        # 宽高为 0 表示 256
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

    # 应用图标 / 任务栏 / 安装包：全尺寸
    app_sizes = [16, 24, 32, 48, 64, 128, 256]
    app_images = {s: make_icon(s) for s in app_sizes}
    write_ico(os.path.join(OUT_DIR, 'icon.ico'), app_images)

    # 通用 PNG（窗口图标、文档里展示用）
    app_images[256].save(os.path.join(OUT_DIR, 'icon.png'), 'PNG', optimize=True)

    # 托盘专用：Windows 会按当前 DPI 从 ICO 里挑最合适的那一档
    tray_sizes = [16, 20, 24, 32]
    tray_images = {s: make_icon(s) for s in tray_sizes}
    write_ico(os.path.join(OUT_DIR, 'tray.ico'), tray_images, png_sizes=())

    # 托盘 PNG 兜底（非 Windows 或 ICO 读取失败时用）
    make_icon(32).save(os.path.join(OUT_DIR, 'tray.png'), 'PNG', optimize=True)

    for name in ('icon.ico', 'icon.png', 'tray.ico', 'tray.png'):
        p = os.path.join(OUT_DIR, name)
        print(f'  {name:<12} {os.path.getsize(p):>7} 字节')

    # 预览图：把所有实际尺寸摆成一条，方便肉眼确认 16px 下是否还认得出
    # 放到 docs/ 而不是 resources/ —— 它只是给人看的，不该进安装包
    preview = Image.new('RGBA', (860, 200), (255, 255, 255, 255))
    x = 30
    for s in [16, 20, 24, 32, 48, 64, 128]:
        preview.alpha_composite(make_icon(s), (x, 90 - s // 2))
        x += s + 34
    docs_dir = os.path.join(os.path.dirname(OUT_DIR), 'docs')
    os.makedirs(docs_dir, exist_ok=True)
    preview_path = os.path.join(docs_dir, 'icon-preview.png')
    preview.save(preview_path, 'PNG')
    print(f'  {"icon-preview.png":<12} (预览 -> docs/)')


if __name__ == '__main__':
    main()
