#!/usr/bin/env python3
"""Posts written on the site (not imported from the Facebook group) that should be shared in the group.

  python3 tools/fb/site_to_group.py list
      JSON list of posts waiting to be offered: published, not from Facebook, dated on or after `since`,
      and not yet in data/facebook_shared.json. Each item has the ready-made group post text.
  python3 tools/fb/site_to_group.py mark <post id> asked|shared|declined [facebook post url]
      Records what happened to a post, so it is offered only once.

The text is made from the post itself (title, its opening, writer, link); nothing is invented.
Posting in the group happens only after Idan approves that exact text in the conversation (AGENT.md §4).
"""
import datetime as dt
import json
import os
import re
import sys
from urllib.parse import quote

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
STATE = os.path.join(ROOT, 'data', 'facebook_shared.json')
SITE = 'https://multiversesite.com'
EXCERPT_CHARS = 280


def load_state():
    try:
        return json.load(open(STATE, encoding='utf-8'))
    except (OSError, ValueError):
        return {'since': dt.date.today().isoformat(), 'posts': {}}


def save_state(state):
    with open(STATE, 'w', encoding='utf-8') as f:
        json.dump(state, f, ensure_ascii=False, indent=1)
        f.write('\n')


def opening(text):
    """The first sentences of the post, up to about EXCERPT_CHARS characters."""
    text = re.sub(r'\s+', ' ', text).strip()
    if len(text) <= EXCERPT_CHARS:
        return text
    cut = text[:EXCERPT_CHARS]
    end = max(cut.rfind('. '), cut.rfind('! '), cut.rfind('? '))
    return (cut[:end + 1] if end > 120 else cut.rsplit(' ', 1)[0] + '…').strip()


def candidates():
    import build  # the site's own loader: same urls, writers and drafts handling as the site
    state = load_state()
    since = state.get('since') or dt.date.today().isoformat()
    done = state.get('posts') or {}
    out = []
    for p in build.load_items('posts'):
        if p.get('source') == 'facebook' or p.get('fb_id'):
            continue
        if p['dt'].date().isoformat() < since or str(p['id']) in done:
            continue
        author = p.get('author_name') or build.AUTHORS.get(p.get('author') or '', '')
        body = p.get('excerpt') or build.strip_tags(p['teaser'] or p['rest'])
        url = SITE + quote(p['url'])
        lines = [p['title'], '', opening(body), '']
        if author:
            lines.append(f'מאת {author}')
        lines.append(f'לכתבה המלאה באתר מולטיוורס: {url}')
        out.append({'id': p['id'], 'title': p['title'], 'url': url, 'date': p['dt'].strftime('%Y-%m-%d %H:%M'),
                    'author': author, 'text': '\n'.join(lines)})
    out.sort(key=lambda x: x['date'])
    return out


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in ('list', 'mark'):
        sys.exit(__doc__)
    if sys.argv[1] == 'list':
        print(json.dumps(candidates(), ensure_ascii=False, indent=1))
        return
    if len(sys.argv) < 4 or sys.argv[3] not in ('asked', 'shared', 'declined'):
        sys.exit('usage: mark <post id> asked|shared|declined [facebook post url]')
    state = load_state()
    entry = state.setdefault('posts', {}).setdefault(sys.argv[2], {})
    entry['status'] = sys.argv[3]
    entry['date'] = dt.datetime.now().strftime('%Y-%m-%d %H:%M')
    if len(sys.argv) > 4:
        entry['facebook_url'] = sys.argv[4]
    save_state(state)
    print(f'{sys.argv[2]}: {sys.argv[3]}')


if __name__ == '__main__':
    main()
