#!/usr/bin/env python3
"""Refresh the "most viewed" sidebar list from the site statistics (GoatCounter).

Run daily by .github/workflows/top-posts.yml. Needs the GoatCounter API key in GOATCOUNTER_API_KEY
(GoatCounter → Settings → API → a key with "Read statistics"). The GoatCounter site code comes from
the `goatcounter` setting in site.yml.
Writes data/top_posts.json (only when the list changed); build.py shows those posts in the widget.
"""
import datetime as dt
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

import yaml

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'top_posts.json')
DAYS = 30
KEEP = 20
POST_PATH = re.compile(r'^/\d{4}/\d{2}/\d{2}/[^/]+/$')


def site_code():
    cfg = yaml.safe_load(open(os.path.join(ROOT, 'site.yml'), encoding='utf-8')) or {}
    gc = str(cfg.get('goatcounter') or '').strip().lower()
    m = re.search(r'([a-z0-9][a-z0-9-]*)\.goatcounter\.com', gc)
    return m.group(1) if m else (gc if re.fullmatch(r'[a-z0-9][a-z0-9-]{1,49}', gc) else '')


def main():
    key = (os.environ.get('GOATCOUNTER_API_KEY') or '').strip().strip('"\'').split()[-1:] or ['']
    key = key[0]
    code = site_code()
    if not key or not code:
        print('No GoatCounter key or site code – nothing to do.')
        return
    if '--check' in sys.argv:        # connection check: status codes and error messages only
        for path in ('/api/v0/me', '/api/v0/stats/hits?limit=5'):
            r2 = urllib.request.Request(f'https://{code}.goatcounter.com{path}', headers={
                'Authorization': f'Bearer {key}', 'Content-Type': 'application/json', 'User-Agent': 'multiversesite-top-posts'})
            try:
                with urllib.request.urlopen(r2, timeout=60) as r:
                    body = json.load(r)
                    print(f'::warning::{path} -> {r.status}, keys: {sorted(body)[:6]}, hits: {len(body.get("hits") or [])}')
            except urllib.error.HTTPError as e:
                print(f'::warning::{path} -> {e.code} {e.read().decode("utf-8", "replace")[:200]}')
        return
    end = dt.datetime.now(dt.timezone.utc).replace(minute=0, second=0, microsecond=0)
    start = end - dt.timedelta(days=DAYS)
    # the times go in as they are: GoatCounter answers 404 when the colons are percent-encoded
    q = f'start={start:%Y-%m-%dT%H:%M:%SZ}&end={end:%Y-%m-%dT%H:%M:%SZ}&limit=100'
    req = urllib.request.Request(f'https://{code}.goatcounter.com/api/v0/stats/hits?{q}', headers={
        'Authorization': f'Bearer {key}', 'Content-Type': 'application/json', 'User-Agent': 'multiversesite-top-posts'})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            data = json.load(r)
    except urllib.error.HTTPError as e:
        detail = e.read().decode('utf-8', 'replace')[:300]
        print(f'::error::GoatCounter request failed: {e} {detail}')
        sys.exit(1)
    except Exception as e:  # noqa: BLE001
        print(f'::error::GoatCounter request failed: {e}')
        sys.exit(1)

    counts = {}
    for h in data.get('hits') or []:
        if h.get('event'):
            continue
        path = urllib.parse.unquote(str(h.get('path') or '')).split('?')[0].split('#')[0]
        if not path.endswith('/'):
            path += '/'
        if POST_PATH.match(path):
            counts[path] = counts.get(path, 0) + int(h.get('count') or 0)
    posts = [p for p, _ in sorted(counts.items(), key=lambda kv: -kv[1])][:KEEP]
    print(f'{len(posts)} posts with views in the last {DAYS} days')
    for p in posts[:8]:
        print(f'  {counts[p]:6}  {p}')

    try:
        old = json.load(open(OUT, encoding='utf-8')).get('posts')
    except (OSError, ValueError):
        old = None
    if posts == old:
        print('List unchanged.')
        return
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump({'updated': end.strftime('%Y-%m-%d'), 'days': DAYS, 'posts': posts}, f, ensure_ascii=False, indent=1)
        f.write('\n')
    print('Updated', os.path.relpath(OUT, ROOT))


if __name__ == '__main__':
    main()
