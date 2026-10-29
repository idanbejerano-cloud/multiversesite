#!/usr/bin/env python3
"""Decode the images returned by fetch_images.js.

Usage: python3 tools/fb/save_images.py <saved tool-result file> <output prefix, e.g. /tmp/fbimg/123>
Prints the paths of the image files it wrote (one per line)."""
import base64
import os
import re
import sys

src, prefix = sys.argv[1], sys.argv[2]
text = open(src, encoding='utf-8', errors='ignore').read()
text = text.replace('\\n', '\n').replace('\\/', '/')
os.makedirs(os.path.dirname(prefix) or '.', exist_ok=True)
for m in re.finditer(r'MVIMG:(\d+):data:image/(\w+)[^;]*;base64,([A-Za-z0-9+/=]+):END', text):
    ext = {'jpeg': 'jpg'}.get(m.group(2), m.group(2))
    path = f'{prefix}-{m.group(1)}.{ext}'
    with open(path, 'wb') as f:
        f.write(base64.b64decode(m.group(3)))
    print(path)
for m in re.finditer(r'MVERR:(\d+):([^\n]*)', text):
    print(f'image {m.group(1)} failed: {m.group(2)}', file=sys.stderr)
