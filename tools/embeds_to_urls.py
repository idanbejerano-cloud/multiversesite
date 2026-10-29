#!/usr/bin/env python3
"""One-time: replace stored embed HTML in posts with the plain link it came from.
build.py turns such links back into players, and the posts become safe to edit in the visual editor."""
import glob
import html
import re
import sys

def yt(m):
    vid, start = m.group(1), m.group(2)
    return f'https://www.youtube.com/watch?v={vid}' + (f'&amp;t={start}s' if start else '')

RULES = [
    (re.compile(r'<div class="embed-wrap embed-16-9"><iframe loading="lazy" src="https://www\.youtube\.com/embed/([\w-]+)\?rel=0(?:&amp;start=(\d+))?"[^>]*></iframe></div>'), yt),
    (re.compile(r'<div class="embed-wrap embed-16-9"><iframe loading="lazy" src="https://player\.vimeo\.com/video/(\d+)"[^>]*></iframe></div>'),
     lambda m: f'https://vimeo.com/{m.group(1)}'),
    (re.compile(r'<div class="embed-wrap embed-16-9"><iframe loading="lazy" src="https://videopress\.com/embed/(\w+)\?hd=1"[^>]*></iframe></div>'),
     lambda m: f'https://videopress.com/v/{m.group(1)}'),
    (re.compile(r'<div class="embed-wrap embed-16-9"><iframe loading="lazy" src="https://www\.dailymotion\.com/embed/video/(\w+)"[^>]*></iframe></div>'),
     lambda m: f'https://www.dailymotion.com/video/{m.group(1)}'),
    (re.compile(r'<blockquote class="twitter-tweet"[^>]*><p><a href="([^"]+)">[^<]*</a></p></blockquote>'), lambda m: m.group(1)),
    (re.compile(r'<blockquote class="instagram-media" data-instgrm-permalink="([^"]+)"[^>]*><a [^>]*>[^<]*</a></blockquote>'), lambda m: m.group(1)),
    (re.compile(r'<div class="fb-embed"><div class="fb-(?:post|video)" data-href="([^"]+)"[^>]*><blockquote><a [^>]*>[^<]*</a></blockquote></div></div>'), lambda m: m.group(1)),
    (re.compile(r'<audio class="wp-audio-shortcode" controls preload="none" src="([^"]+)"><a [^>]*>[^<]*</a></audio>'), lambda m: m.group(1)),
    (re.compile(r'<video class="wp-video-shortcode" controls preload="metadata" src="([^"]+)"><a [^>]*>[^<]*</a></video>'), lambda m: m.group(1)),
]

total = 0
for f in glob.glob('content/posts/**/*.html', recursive=True) + glob.glob('content/pages/*.html'):
    s = open(f, encoding='utf-8').read()
    n0 = s
    for rx, fn in RULES:
        s, n = rx.subn(fn, s)
        total += n
    if s != n0:
        open(f, 'w', encoding='utf-8').write(s)
print('embeds replaced by links:', total)
