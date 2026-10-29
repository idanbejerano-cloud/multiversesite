#!/usr/bin/env python3
"""Copy the site's images from a WordPress uploads folder into static/, shrunk for the web.

Usage: python3 tools/optimize_media.py <uploads-dir> [--all]

Only files that posts actually use (data/used_uploads.txt) are copied unless --all.
Photos are resized to at most MAX_W pixels wide and saved as WebP; animated GIFs,
videos and other files are copied unchanged. data/media-map.json records every
file whose name changed (e.g. 2015/02/x.jpg -> 2015/02/x.webp) so build.py can
point the posts at the new file.
"""
import json
import os
import shutil
import sys
from concurrent.futures import ProcessPoolExecutor

from PIL import Image, ImageOps

Image.MAX_IMAGE_PIXELS = 200_000_000
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEST = os.path.join(ROOT, 'static', 'wp-content', 'uploads')
MAX_W = 1200
QUALITY = 74
MAX_COPY = 90 * 1024 * 1024        # GitHub refuses files over 100 MB
PHOTO = {'.jpg', '.jpeg', '.png', '.webp', '.avif', '.tif', '.tiff', '.bmp'}


def process(job):
    src_root, rel = job
    src = os.path.join(src_root, rel)
    base, ext = os.path.splitext(rel)
    ext = ext.lower()
    try:
        size = os.path.getsize(src)
        if ext == '.gif':
            with Image.open(src) as im:
                animated = getattr(im, 'is_animated', False)
            if animated:
                return copy(src, rel, size)
        if ext in PHOTO or ext == '.gif':
            out_rel = base + '.webp'
            if ext == '.webp':
                out_rel = rel
            with Image.open(src) as im:
                im = ImageOps.exif_transpose(im)
                if im.mode in ('P', 'LA', 'PA'):
                    im = im.convert('RGBA')
                elif im.mode not in ('RGB', 'RGBA'):
                    im = im.convert('RGB')
                if im.mode == 'RGBA' and im.getextrema()[3][0] == 255:
                    im = im.convert('RGB')
                if im.width > MAX_W:
                    im = im.resize((MAX_W, max(1, round(im.height * MAX_W / im.width))), Image.LANCZOS)
                dst = os.path.join(DEST, out_rel)
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                im.save(dst, 'WEBP', quality=QUALITY, method=4)
            new_size = os.path.getsize(dst)
            # tiny originals that got bigger: keep the original file instead
            if new_size >= size and ext in ('.jpg', '.jpeg', '.png') and size < 400_000:
                os.remove(dst)
                return copy(src, rel, size)
            return rel, out_rel, new_size, 'webp'
        return copy(src, rel, size)
    except Exception as e:  # noqa: BLE001
        return rel, None, 0, f'error: {e}'


def copy(src, rel, size):
    if size > MAX_COPY:
        return rel, None, 0, 'too-big'
    dst = os.path.join(DEST, rel)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copy2(src, dst)
    return rel, rel, size, 'copy'


def main():
    src_root = sys.argv[1]
    want_all = '--all' in sys.argv
    used = {l.strip() for l in open(os.path.join(ROOT, 'data', 'used_uploads.txt'), encoding='utf-8') if l.strip()}
    available = set()
    for dp, _, files in os.walk(src_root):
        for fn in files:
            available.add(os.path.relpath(os.path.join(dp, fn), src_root).replace(os.sep, '/'))
    todo = sorted(available if want_all else (used & available))
    missing = sorted(used - available)
    print(f'{len(available)} files in backup, {len(used)} used by posts, processing {len(todo)}, missing {len(missing)}')

    map_path = os.path.join(ROOT, 'data', 'media-map.json')
    mapping = json.load(open(map_path, encoding='utf-8')) if os.path.exists(map_path) else {}
    stats, total = {}, 0
    with ProcessPoolExecutor() as ex:
        for i, (rel, out_rel, size, how) in enumerate(ex.map(process, [(src_root, r) for r in todo], chunksize=16)):
            kind = how.split(':')[0]
            stats[kind] = stats.get(kind, 0) + 1
            total += size
            if out_rel and out_rel != rel:
                mapping[rel] = out_rel
            if kind in ('error', 'too-big'):
                print(rel, how, file=sys.stderr)
            if i % 500 == 0:
                print(f'  {i}/{len(todo)}  {total / 1e6:.0f} MB', flush=True)
    with open(map_path, 'w', encoding='utf-8') as f:
        json.dump(mapping, f, ensure_ascii=False, indent=0, sort_keys=True)
    with open(os.path.join(ROOT, 'data', 'missing_uploads.txt'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(missing) + '\n')
    print(stats, f'{total / 1e6:.0f} MB written')


if __name__ == '__main__':
    main()
