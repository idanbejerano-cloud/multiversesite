#!/usr/bin/env python3
"""Convert the animated GIFs in static/ to animated WebP (much smaller) and record them in data/media-map.json."""
import json, os, sys
from concurrent.futures import ProcessPoolExecutor
from PIL import Image, ImageSequence

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UP = os.path.join(ROOT, 'static', 'wp-content', 'uploads')


def conv(rel):
    src = os.path.join(UP, rel)
    dst_rel = rel[:-4] + '.webp'
    dst = os.path.join(UP, dst_rel)
    with Image.open(src) as im:
        frames, durations = [], []
        for fr in ImageSequence.Iterator(im):
            f = fr.convert('RGBA')
            if f.width > 640:
                f = f.resize((640, round(f.height * 640 / f.width)), Image.LANCZOS)
            frames.append(f)
            durations.append(fr.info.get('duration', im.info.get('duration', 80)) or 80)
    frames[0].save(dst, 'WEBP', save_all=True, append_images=frames[1:], duration=durations, loop=0,
                   quality=60, method=4, minimize_size=True)
    a, b = os.path.getsize(src), os.path.getsize(dst)
    if b < a:
        os.remove(src)
        return rel, dst_rel, a, b
    os.remove(dst)
    return rel, None, a, a


if __name__ == '__main__':
    gifs = [os.path.relpath(os.path.join(dp, f), UP).replace(os.sep, '/')
            for dp, _, fs in os.walk(UP) for f in fs if f.lower().endswith('.gif')]
    mp = os.path.join(ROOT, 'data', 'media-map.json')
    mapping = json.load(open(mp, encoding='utf-8'))
    tot_a = tot_b = 0
    with ProcessPoolExecutor() as ex:
        for rel, new, a, b in ex.map(conv, gifs):
            tot_a += a; tot_b += b
            if new:
                mapping[rel] = new
    json.dump(mapping, open(mp, 'w', encoding='utf-8'), ensure_ascii=False, indent=0, sort_keys=True)
    print(f'{len(gifs)} gifs: {tot_a/1e6:.0f} MB -> {tot_b/1e6:.0f} MB')
