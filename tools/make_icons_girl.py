r"""Generate the launcher icon from the whale-girl "peeking" sticker.

Source: `dsh-meme/memes/dafeiyu-001/memes/shy/toukan.jpg` (365x365) — the whale-girl with both
hands resting on a dark whale, peeking over the top of it. The user picked this one, from the
meme plugin, over the plain bust an earlier version used.

Notes that shaped the code:

  * 365 px is the largest copy available on this machine, and the adaptive foreground needs 432
    px, so the artwork is upscaled with Lanczos. A chibi line drawing survives that; the result
    is still checked by eye at 48 px before shipping.
  * The sticker is a JPEG on white. Cropping alone would leave the JPEG's off-white noise, which
    reads as a grey halo once the icon sits on the navy plate — so near-neutral bright pixels are
    faded into the plate colour instead.
  * The subject already fills the frame, so the crop is gentle.
"""

import os
import sys

from PIL import Image, ImageDraw, ImageFilter

BASE = r"D:\DSHcode\dsh-mobile\apk\res"
SOURCE = (r"C:\Users\30147\.dsh\profiles\desktop\node_modules\dsh-meme"
          r"\memes\dafeiyu-001\memes\shy\toukan.jpg")

# The subject already fills the frame; this trims a little of the sticker's own margin.
CROP = (0.03, 0.01, 0.97, 0.95)

LEGACY_SIZES = {
    "mipmap-mdpi": 48,
    "mipmap-hdpi": 72,
    "mipmap-xhdpi": 96,
    "mipmap-xxhdpi": 144,
    "mipmap-xxxhdpi": 192,
}
BACKGROUND = (44, 62, 118)  # navy, taken from the character's hair shadow


def is_sticker_white(r, g, b):
    """Near-white and near-neutral: candidate background."""
    return min(r, g, b) >= 228 and max(r, g, b) - min(r, g, b) <= 30


def clean_background(art):
    """Replace the sticker's white background with the plate colour, keeping the artwork's own
    bright areas.

    A colour threshold alone cannot do this, and two attempts proved it: at 235 the JPEG's
    off-white speckles survived as grey dots, and loosening it further started eating the
    character's pale cheeks and the white headband. What separates them is not brightness but
    extent — the background is one large connected region touching the border, while the cheeks,
    eye whites and headband are small regions enclosed by dark line art.

    So: label the bright regions, keep the ones that do not touch the border and are either
    reasonably large or fully enclosed, and fill the rest with the plate colour.
    """
    from collections import deque

    width, height = art.size
    px = art.load()
    bright = bytearray(width * height)
    for y in range(height):
        for x in range(width):
            r, g, b, a = px[x, y]
            if a > 40 and is_sticker_white(r, g, b):
                bright[y * width + x] = 1

    seen = bytearray(width * height)
    kept = 0
    removed = 0
    for start_y in range(height):
        for start_x in range(width):
            index = start_y * width + start_x
            if not bright[index] or seen[index]:
                continue
            # Flood this region and note whether it reaches the border.
            queue = deque([(start_x, start_y)])
            seen[index] = 1
            region = []
            touches_border = False
            while queue:
                x, y = queue.popleft()
                region.append((x, y))
                if x == 0 or y == 0 or x == width - 1 or y == height - 1:
                    touches_border = True
                for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                    if 0 <= nx < width and 0 <= ny < height:
                        ni = ny * width + nx
                        if bright[ni] and not seen[ni]:
                            seen[ni] = 1
                            queue.append((nx, ny))
            # A bright region is the artwork only if the character's line art encloses it —
            # cheeks, eye whites, the headband. Anything touching the sticker's border is
            # background, however large it is, and that includes the JPEG's speckles because the
            # flood reaches them through the connecting white.
            #
            # The first version of this rule kept large border-touching regions "in case they
            # were artwork" and removed nothing at all (reported 0 px), which is how the speckles
            # survived two attempts.
            keep = not touches_border
            for (x, y) in region:
                if keep:
                    kept += 1
                    continue
                removed += 1
                px[x, y] = BACKGROUND + (255,)
    return kept, removed


def build_square(source):
    width, height = source.size
    box = (int(width * CROP[0]), int(height * CROP[1]),
           int(width * CROP[2]), int(height * CROP[3]))
    art = source.crop(box)
    kept, removed = clean_background(art)
    print('  background: kept %d bright px (artwork), replaced %d px with the plate'
          % (kept, removed))

    side = max(art.size)
    square = Image.new('RGBA', (side, side), BACKGROUND + (255,))
    square.paste(art, ((side - art.width) // 2, (side - art.height) // 2), art)
    return square


def apply_rounded_mask(image):
    """Bake in a rounded-square silhouette.

    A mask here rather than relying on the launcher: some launchers apply their own shape, some
    draw the bitmap as-is, and a square with hard corners looks unfinished on the latter. The
    radius matches the familiar launcher shape, so on a launcher that masks it as well the
    difference is invisible.
    """
    size = image.width
    mask = Image.new('L', (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1),
                                           radius=max(2, int(size * 0.21)), fill=255)
    out = image.copy()
    out.putalpha(mask)
    return out


def main():
    if not os.path.exists(SOURCE):
        print('source artwork not found: ' + SOURCE)
        return 1
    source = Image.open(SOURCE).convert('RGBA')
    print('source %s, crop %s' % (source.size, CROP))
    square = build_square(source)

    # No adaptive icon. This is deliberate, and it is the second attempt at this decision.
    #
    # The adaptive version (mipmap-anydpi-v26/ic_launcher.xml + a foreground PNG) is the modern
    # way and renders correctly on Xiaomi/HyperOS — but on the vivo (OriginOS) launcher the
    # foreground was ignored entirely and the icon came out as a flat blue rounded square: the
    # background colour layer, no character. Verified by building twice and comparing the home
    # screen: with the adaptive XML the icon is empty, without it the character appears.
    #
    # So the shipped icon is a plain bitmap in every density bucket. A rounded-square mask is
    # baked in, so it still looks deliberate on launchers that apply their own shape — the mask
    # just sits inside theirs.
    for bucket, size in LEGACY_SIZES.items():
        out_dir = os.path.join(BASE, bucket)
        os.makedirs(out_dir, exist_ok=True)
        small = square.resize((size, size), Image.LANCZOS)
        if size < square.width:
            # Only where the result is smaller than the source: keeps the line art from going
            # soft at 48 px, which is the size a launcher draws most often.
            small = small.filter(ImageFilter.UnsharpMask(radius=1.2, percent=55, threshold=3))
        small = apply_rounded_mask(small)
        small.save(os.path.join(out_dir, 'ic_launcher.png'))
        print('  wrote %s/ic_launcher.png (%dpx, rounded)' % (bucket, size))

    fg_dir = os.path.join(BASE, 'mipmap-anydpi-v26')
    if os.path.isdir(fg_dir):
        # Left over from an earlier build; its presence is what broke the icon on vivo.
        import shutil
        shutil.rmtree(fg_dir)
        print('  removed mipmap-anydpi-v26/ (the adaptive icon vivo ignored)')

    preview_dir = r'D:\DSHcode\dsh-mobile\devtest'
    os.makedirs(preview_dir, exist_ok=True)
    sheet = Image.new('RGBA', (48 + 72 + 96 + 144 + 192 + 40, 222), (238, 240, 244, 255))
    x = 10
    for size in (48, 72, 96, 144, 192):
        icon = apply_rounded_mask(square.resize((size, size), Image.LANCZOS))
        sheet.paste(icon, (x, 15), icon)
        x += size + 8
    sheet.save(os.path.join(preview_dir, 'icon-girl-preview.png'))
    print('  wrote devtest/icon-girl-preview.png')
    return 0


if __name__ == '__main__':
    sys.exit(main())
