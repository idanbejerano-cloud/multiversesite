#!/usr/bin/env python3
"""Posts written on the site (not imported from the Facebook group) that should be shared in the group.

  python3 tools/fb/site_to_group.py list
      JSON list of posts waiting to be offered: published, not from Facebook, dated on or after `since`,
      and not yet in data/facebook_shared.json. Each item has the ready-made group post text.
  python3 tools/fb/site_to_group.py mark <post id> asked|shared|pending|declined [facebook post url] [--group <key>]
      Records what happened to a post (in one group with --group), so it is offered only once.
  python3 tools/fb/site_to_group.py groups
      The numbered list of groups to offer (data/facebook.json `share_groups`), with a note on each.

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


def groups():
    cfg = json.load(open(os.path.join(ROOT, 'data', 'facebook.json'), encoding='utf-8'))
    return cfg.get('share_groups') or [{'key': 'ulammale', 'name': 'אולם ומלואו', 'url': cfg.get('group_url'), 'note': ''}]


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in ('list', 'mark', 'groups'):
        sys.exit(__doc__)
    if sys.argv[1] == 'list':
        print(json.dumps(candidates(), ensure_ascii=False, indent=1))
        return
    if sys.argv[1] == 'groups':
        for i, g in enumerate(groups(), 1):
            print(f"{i}. {g['name']}" + (f" – {g['note']}" if g.get('note') else '') + f"  [{g['key']}] {g['url']}")
        return
    args = sys.argv[2:]
    group = None
    if '--group' in args:
        i = args.index('--group')
        group = args[i + 1] if i + 1 < len(args) else None
        args = args[:i] + args[i + 2:]
        if group not in {g['key'] for g in groups()}:
            sys.exit(f'unknown group key: {group}')
    if len(args) < 2 or args[1] not in ('asked', 'shared', 'pending', 'declined'):
        sys.exit('usage: mark <post id> asked|shared|pending|declined [facebook post url] [--group <key>]')
    pid, status = args[0], args[1]
    state = load_state()
    entry = state.setdefault('posts', {}).setdefault(pid, {})
    now = dt.datetime.now().strftime('%Y-%m-%d %H:%M')
    if group:
        g = entry.setdefault('groups', {}).setdefault(group, {})
        g.update({'status': status, 'date': now})
        if len(args) > 2:
            g['facebook_url'] = args[2]
        if status in ('shared', 'pending') or entry.get('status') in (None, 'asked'):
            entry['status'] = 'shared' if status in ('shared', 'pending') else status
        if group == 'ulammale' and len(args) > 2:
            entry['facebook_url'] = args[2]      # the home group's post: used to recognise it later
    else:
        entry['status'] = status
        if len(args) > 2:
            entry['facebook_url'] = args[2]
    entry['date'] = now
    save_state(state)
    print(f'{pid}: {status}' + (f' in {group}' if group else ''))


if __name__ == '__main__':
    main()
