#!/usr/bin/env python3
"""Publish or unpublish a post. Run by .github/workflows/publish.yml when someone presses
"פרסום" or "החזרה לטיוטה" on a post in Pages CMS.

Reads the JSON that Pages CMS sends (env PAYLOAD): which action, which file, who pressed it.
Publish: draft -> false; a post published for the first time gets the current date and time
(so it is the newest post on the site and in the newsletter feed) and moves into its year folder.
Unpublish: draft -> true.
Writes the commit message to $COMMIT_MSG_FILE. Changes nothing when there is nothing to change.
"""
import datetime as dt
import json
import os
import re
import subprocess
import sys
from zoneinfo import ZoneInfo

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PATH_RE = re.compile(r'^content/posts/(?:\d{4}/)?[A-Za-z0-9][A-Za-z0-9._-]*\.html$')
FM_RE = re.compile(r'\A---\r?\n(.*?\r?\n)---\r?\n', re.S)


def fail(msg):
    print('::error::' + msg)
    sys.exit(1)


def set_key(fm, key, value):
    """Replace the line `key: ...` in the front matter, or add it at the top."""
    line = f'{key}: {value}'
    pat = re.compile(rf'^{re.escape(key)}:.*$', re.M)
    if pat.search(fm):
        return pat.sub(lambda _: line, fm, count=1)
    return line + '\n' + fm


def main():
    try:
        payload = json.loads(os.environ.get('PAYLOAD') or '{}')
    except ValueError:
        fail('The request from Pages CMS could not be read.')
    action = (payload.get('action') or {}).get('name')
    ctx = payload.get('context') or {}
    path = (ctx.get('path') or '').strip().lstrip('/')
    who = ((payload.get('triggeredBy') or {}).get('name') or '').strip()[:80]
    if action not in ('publish', 'unpublish'):
        fail(f'Unknown action: {action!r}')
    if not PATH_RE.match(path) or '..' in path:
        fail(f'Not a post file: {path!r}')
    full = os.path.join(ROOT, path)
    if not os.path.isfile(full):
        fail(f'The post file {path} was not found. Was it saved, or moved since?')

    text = open(full, encoding='utf-8').read()
    m = FM_RE.match(text)
    if not m:
        fail(f'{path} has no front matter.')
    fm, body = m.group(1), text[m.end():]
    title_m = re.search(r'^title:\s*(.*)$', fm, re.M)
    raw = title_m.group(1).strip() if title_m else os.path.basename(path)
    try:
        title = json.loads(raw) if raw.startswith('"') else raw.strip("'")
    except ValueError:
        title = raw.strip('"\'')
    title = str(title)[:90]
    was_draft = bool(re.search(r'^draft:\s*true\s*$', fm, re.M))

    if action == 'publish':
        fm = set_key(fm, 'draft', 'false')
        if was_draft:
            now = dt.datetime.now(ZoneInfo('Asia/Jerusalem'))
            fm = set_key(fm, 'date', now.strftime('%Y-%m-%d %H:%M:%S'))
        verb = 'פרסום'
    else:
        fm = set_key(fm, 'draft', 'true')
        verb = 'החזרה לטיוטה'

    new_text = '---\n' + fm + '---\n' + body
    new_path = path
    if action == 'publish' and path.count('/') == 2:       # content/posts/<file>: move into its year folder
        date_m = re.search(r'^date:\s*["\']?(\d{4})-', fm, re.M)
        year = date_m.group(1) if date_m else str(dt.date.today().year)
        new_path = f'content/posts/{year}/{os.path.basename(path)}'
        if os.path.exists(os.path.join(ROOT, new_path)):
            new_path = path                                 # never overwrite another post

    if new_text == text and new_path == path:
        print(f'Nothing to change: "{title}" is already {"published" if action == "publish" else "a draft"}.')
        return
    open(full, 'w', encoding='utf-8').write(new_text)
    if new_path != path:
        os.makedirs(os.path.dirname(os.path.join(ROOT, new_path)), exist_ok=True)
        subprocess.run(['git', 'mv', path, new_path], cwd=ROOT, check=True)
    subprocess.run(['git', 'add', '--', new_path], cwd=ROOT, check=True)
    msg = f'{verb}: {title}' + (f' (על ידי {who})' if who else '')
    with open(os.environ.get('COMMIT_MSG_FILE') or os.path.join(ROOT, '.commit-msg'), 'w', encoding='utf-8') as f:
        f.write(msg + '\n')
    print(msg, '->', new_path)


if __name__ == '__main__':
    main()
