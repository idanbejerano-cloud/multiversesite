#!/usr/bin/env python3
"""Add a post to the site from a Facebook group post (used by the scheduled group agent).

Usage:
    python3 tools/add_post.py post.json

post.json:
{
  "fb_id": "1234567890",                 # the Facebook post id (used to avoid duplicates)
  "fb_url": "https://www.facebook.com/groups/.../posts/1234567890/",
  "author": "שם הכותב כפי שמופיע בפייסבוק",
  "date": "2026-11-01 14:05:00",         # local Israel time of the Facebook post
  "title": "optional title",             # default: first line of the text
  "text": "the post text, as plain text (line breaks kept)",
  "images": ["/path/to/img1.jpg", ...]   # local files, optional
}

Prints the new post's URL, or "SKIP <reason>" when the post was already added
or its author isn't on the list in data/facebook.json.
"""
import datetime as dt
import html
import json
import os
import re
import sys

import yaml
from PIL import Image, ImageOps

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
import embeds  # noqa: E402

CONFIG = os.path.join(ROOT, 'data', 'facebook.json')
SEEN = os.path.join(ROOT, 'data', 'facebook_seen.json')


def load(path, default):
    if os.path.exists(path):
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    return default


def norm_name(s):
    return re.sub(r'\s+', ' ', s or '').strip().casefold()


def text_to_html(text, flags):
    out = []
    for block in re.split(r'\n\s*\n', text.strip()):
        lines = [l.strip() for l in block.split('\n') if l.strip()]
        if len(lines) == 1 and re.fullmatch(r'https?://\S+', lines[0]):
            e = embeds.embed_html(lines[0], flags)
            if e:
                out.append(e)
                continue
        parts = []
        for line in lines:
            esc = html.escape(line)
            esc = re.sub(r'(https?://[^\s<]+)', lambda m: f'<a href="{m.group(1)}">{m.group(1)}</a>', esc)
            parts.append(esc)
        out.append('<p>' + '<br />\n'.join(parts) + '</p>')
    return out


def save_image(src, rel_base):
    with Image.open(src) as im:
        im = ImageOps.exif_transpose(im).convert('RGB')
        if im.width > 1200:
            im = im.resize((1200, round(im.height * 1200 / im.width)), Image.LANCZOS)
        rel = rel_base + '.webp'
        dst = os.path.join(ROOT, 'static', 'wp-content', 'uploads', rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        im.save(dst, 'WEBP', quality=78, method=4)
        return rel, im.width, im.height


def main(path):
    with open(path, encoding='utf-8') as f:
        post = json.load(f)
    cfg = load(CONFIG, {})
    seen = load(SEEN, {})
    fb_id = str(post['fb_id']).strip()
    if fb_id in seen:
        print('SKIP already added', seen[fb_id])
        return

    people = {norm_name(p['facebook_name']): p for p in cfg.get('authors', [])}
    person = people.get(norm_name(post.get('author')))
    if not person:
        print('SKIP author not on the list:', post.get('author'))
        return
    login = person.get('site_author') or re.sub(r'[^a-z0-9]', '', fb_id)[:12]
    authors_path = os.path.join(ROOT, 'data', 'authors.json')
    authors = load(authors_path, {})
    if login not in authors:
        authors[login] = person.get('display_name') or post['author']
        with open(authors_path, 'w', encoding='utf-8') as f:
            json.dump(authors, f, ensure_ascii=False, indent=1, sort_keys=True)

    date = dt.datetime.strptime(post['date'][:19], '%Y-%m-%d %H:%M:%S')
    text = post.get('text', '').strip()
    first = next((l.strip() for l in text.split('\n') if l.strip()), '')
    title = (post.get('title') or first or 'פוסט מהקבוצה').strip()
    if len(title) > 90:
        title = title[:87].rsplit(' ', 1)[0] + '…'
    body_text = text
    if not post.get('title') and first and len(first) <= 90:
        body_text = text.split(first, 1)[1]   # first line became the title

    flags = set()
    blocks = text_to_html(body_text, flags) if body_text.strip() else []
    imgs = []
    for n, src in enumerate(post.get('images') or [], 1):
        rel, w, h = save_image(src, f'{date:%Y/%m}/fb-{fb_id}-{n}')
        imgs.append((rel, w, h))
    figures = [f'<figure class="wp-block-image aligncenter size-large"><img loading="lazy" decoding="async" '
               f'src="/wp-content/uploads/{rel}" width="{w}" height="{h}" alt=""></figure>' for rel, w, h in imgs[1:]]
    if not blocks and imgs:
        blocks = []
    teaser = blocks[:1]
    rest = blocks[1:] + figures
    body = '\n'.join(teaser)
    if rest:
        body += '\n\n<!--more-->\n\n' + '\n'.join(rest)
    if post.get('fb_url') and cfg.get('link_back', True):
        body += (f'\n<p class="fb-source"><a href="{html.escape(post["fb_url"], quote=True)}" target="_blank" '
                 f'rel="noopener">לפוסט המקורי בקבוצת הפייסבוק</a></p>')

    pid = 900000 + len(seen) + 1
    while any(os.path.exists(os.path.join(ROOT, 'content', 'posts', str(y), f'{date:%Y-%m-%d}-{pid}.html'))
              for y in (date.year,)):
        pid += 1
    url = f'/{date:%Y/%m/%d}/fb-{fb_id}/'
    fm = {'id': pid, 'title': title, 'date': date.strftime('%Y-%m-%d %H:%M:%S'), 'url': url, 'author': login,
          'categories': cfg.get('categories') or ['כללי'], 'tags': cfg.get('tags') or []}
    if imgs:
        fm['image'] = f'/wp-content/uploads/{imgs[0][0]}'
    if flags:
        fm['embeds'] = sorted(flags)
    fm['source'] = 'facebook'
    fm['fb_id'] = fb_id

    out_dir = os.path.join(ROOT, 'content', 'posts', str(date.year))
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, f'{date:%Y-%m-%d}-{pid}.html'), 'w', encoding='utf-8') as f:
        f.write('---\n' + yaml.safe_dump(fm, allow_unicode=True, sort_keys=False, width=10000) + '---\n' + body + '\n')
    seen[fb_id] = url
    with open(SEEN, 'w', encoding='utf-8') as f:
        json.dump(seen, f, ensure_ascii=False, indent=1, sort_keys=True)
    print(url)


if __name__ == '__main__':
    main(sys.argv[1])
