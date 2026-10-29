#!/usr/bin/env python3
"""Static site generator for multiversesite.

    python3 build.py            -> builds the site into _site/

Environment:
    BASE_PATH  path prefix when the site is served from a sub-folder
               (e.g. /multiversesite on github.io). Empty for a custom domain.
    SITE_URL   absolute address used in feeds/sitemap (defaults to site.yml url + BASE_PATH).
"""
import datetime as dt
import html
import json
import os
import re
import shutil
import sys
from collections import defaultdict
from urllib.parse import quote

import yaml
from jinja2 import Environment, FileSystemLoader, select_autoescape
from markupsafe import Markup

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, '_site')
CFG = yaml.safe_load(open(os.path.join(ROOT, 'site.yml'), encoding='utf-8'))
BASE = os.environ.get('BASE_PATH', '').rstrip('/')
SITE_URL = (os.environ.get('SITE_URL') or (CFG['url'].rstrip('/') + BASE)).rstrip('/')
PER_PAGE = int(CFG.get('per_page', 20))
FALLBACK = CFG.get('media_fallback') or ''
HEB_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר',
              'נובמבר', 'דצמבר']


def jload(name):
    with open(os.path.join(ROOT, 'data', name), encoding='utf-8') as f:
        return json.load(f)


AUTHORS = jload('authors.json')
CATS = jload('categories.json')
TAGS = jload('tags.json')
REDIRECTS = jload('redirects.json')
REDIRECTS.update(CFG.get('extra_redirects') or {})

# ------------------------------------------------------------------ helpers
UPLOADS_DIR = os.path.join(ROOT, 'static', 'wp-content', 'uploads')
LOCAL_UPLOADS = set()
for dp, _, files in os.walk(UPLOADS_DIR):
    for fn in files:
        LOCAL_UPLOADS.add(os.path.relpath(os.path.join(dp, fn), UPLOADS_DIR).replace(os.sep, '/'))
missing_media = set()


def u(path):
    """Site-relative link -> link that works under BASE_PATH."""
    if not path:
        return BASE + '/'
    if path.startswith('/wp-content/uploads/'):
        return media(path)
    return BASE + path if path.startswith('/') and not path.startswith('//') else path


MEDIA_MAP = {}
if os.path.exists(os.path.join(ROOT, 'data', 'media-map.json')):
    MEDIA_MAP = jload('media-map.json')


def media(path):
    """/wp-content/uploads/... -> the optimised local copy, or the old server while it's missing."""
    from urllib.parse import unquote
    rel, _, frag = path[len('/wp-content/uploads/'):].partition('#')
    orig = unquote(rel.split('?')[0])
    dec = MEDIA_MAP.get(orig, orig)
    if dec in LOCAL_UPLOADS or not FALLBACK:
        return BASE + '/wp-content/uploads/' + quote(dec, safe="/-._~!$&'()*+,;=:@")
    missing_media.add(orig)
    return FALLBACK + quote(orig)


ATTR_RE = re.compile(r'((?:href|src|poster)=["\'])(/(?!/)[^"\']*)')


def fix_body(h):
    return ATTR_RE.sub(lambda m: m.group(1) + u(m.group(2)), h)


SITE_ORIGIN = SITE_URL[:-len(BASE)] if BASE and SITE_URL.endswith(BASE) else SITE_URL


def absolute(h):
    """Body HTML with absolute links (for the RSS feed)."""
    return re.sub(r'((?:href|src)=["\'])/(?!/)', lambda m: m.group(1) + SITE_ORIGIN + '/', fix_body(h))


def heb_date(d):
    return f'{d.day} ב{HEB_MONTHS[d.month - 1]} {d.year}'


def strip_tags(h):
    h = re.sub(r'<(script|style|iframe|blockquote)[^>]*>.*?</\1>', ' ', h, flags=re.S)
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', h))).strip()


def summary_text(p):
    if p.get('_summary') is None:
        text = p.get('excerpt') or strip_tags(p['teaser'] or p['rest'])
        words = text.split()
        p['_summary'] = ' '.join(words[:40]) + ('&hellip;' if len(words) > 40 else '')
    return p['_summary']


THUMBS_DIR = os.path.join(ROOT, 'static', 'thumbs')
THUMB_SIZE = (480, 266)
_thumb_cache = {}


def thumb(p):
    """Small cropped copy of a post's image for list pages (made once, kept in static/thumbs)."""
    if not p.get('image'):
        return None
    pid = p['id']
    if pid in _thumb_cache:
        return _thumb_cache[pid]
    name = f'{pid}.webp'
    dst = os.path.join(THUMBS_DIR, name)
    if not os.path.exists(dst):
        from urllib.parse import unquote
        rel = unquote(p['image'][len('/wp-content/uploads/'):])
        src = os.path.join(UPLOADS_DIR, MEDIA_MAP.get(rel, rel))
        if os.path.exists(src):
            try:
                from PIL import Image, ImageOps
                os.makedirs(THUMBS_DIR, exist_ok=True)
                with Image.open(src) as im:
                    ImageOps.fit(im.convert('RGB'), THUMB_SIZE, Image.LANCZOS).save(dst, 'WEBP', quality=72, method=4)
            except Exception as e:  # noqa: BLE001
                print('thumb failed', src, e, file=sys.stderr)
    url = f'{BASE}/thumbs/{name}' if os.path.exists(dst) else media(p['image'])
    _thumb_cache[pid] = url
    return url


def cat_chain(slug):
    chain = []
    while slug and slug in CATS and slug not in chain:
        chain.insert(0, slug)
        slug = CATS[slug].get('parent')
    return chain


def cat_url(slug):
    return '/category/' + '/'.join(cat_chain(slug) or [slug]) + '/'


def tag_url(slug):
    return f'/tag/{slug}/'


def author_url(login):
    return f'/author/{login}/'


# ------------------------------------------------------------------ content
FM_RE = re.compile(r'^---\n(.*?)\n---\n(.*)$', re.S)


class Post(dict):
    __getattr__ = dict.get


def load_items(kind):
    items = []
    base = os.path.join(ROOT, 'content', kind)
    for dp, _, files in os.walk(base):
        for fn in sorted(files):
            if not fn.endswith('.html'):
                continue
            text = open(os.path.join(dp, fn), encoding='utf-8').read()
            m = FM_RE.match(text)
            if not m:
                print('skipping (no front matter):', fn, file=sys.stderr)
                continue
            p = Post(yaml.safe_load(m.group(1)))
            body = m.group(2).strip()
            if '<!--more-->' in body:
                teaser, rest = body.split('<!--more-->', 1)
                p['has_more'] = True
            else:
                teaser, rest = body, ''
                p['has_more'] = False
            p['teaser'] = teaser.strip()
            p['rest'] = rest.strip()
            p['dt'] = dt.datetime.strptime(str(p['date'])[:19], '%Y-%m-%d %H:%M:%S')
            p['kind'] = kind
            p.setdefault('categories', [])
            p.setdefault('tags', [])
            p['comments'] = int(p.get('comments') or 0)
            items.append(p)
    return items


def comments_for(pid):
    path = os.path.join(ROOT, 'content', 'comments', f'{pid}.json')
    if not os.path.exists(path):
        return []
    flat = json.load(open(path, encoding='utf-8'))
    by_parent = defaultdict(list)
    ids = {c['id'] for c in flat}
    for c in flat:
        c['dt'] = dt.datetime.strptime(c['date'][:19], '%Y-%m-%d %H:%M:%S')
        c['html'] = Markup(fix_body(c['html']))
        by_parent[c['parent'] if c['parent'] in ids else 0].append(c)

    def tree(parent):
        out = []
        for c in by_parent.get(parent, []):
            c['children'] = tree(c['id'])
            out.append(c)
        return out
    return tree(0)


# ------------------------------------------------------------------ render
env = Environment(loader=FileSystemLoader(os.path.join(ROOT, 'templates')),
                  autoescape=select_autoescape(['html', 'xml']), trim_blocks=True, lstrip_blocks=True)
env.globals.update(u=u, media=media, summary_text=summary_text, thumb=thumb, heb_date=heb_date, cat_url=cat_url, tag_url=tag_url,
                   author_url=author_url, CATS=CATS, TAGS=TAGS, AUTHORS=AUTHORS, cfg=CFG, BASE=BASE,
                   SITE_URL=SITE_URL)
env.filters['body'] = lambda h: Markup(fix_body(h))
written = 0


def out_path(url):
    url = url.split('#')[0]
    p = os.path.join(OUT, url.strip('/'))
    if url.endswith('/') or url == '':
        p = os.path.join(p, 'index.html')
    return p


def write(url, content):
    global written
    p = out_path(url)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, 'w', encoding='utf-8') as f:
        f.write(content)
    written += 1


def paginate_links(cur, total, base_url):
    def page_url(n):
        return base_url if n == 1 else f'{base_url}page/{n}/'
    links = []
    if cur > 1:
        links.append(('prev', page_url(cur - 1), '→ הקודם'))
    dots = False
    for n in range(1, total + 1):
        if n == cur:
            links.append(('current', None, str(n)))
            dots = True
        elif n <= 1 or n > total - 1 or abs(n - cur) <= 1:
            links.append(('num', page_url(n), str(n)))
            dots = True
        elif dots:
            links.append(('dots', None, '…'))
            dots = False
    if cur < total:
        links.append(('next', page_url(cur + 1), 'הבא ←'))
    return links


def render_list(base_url, posts, title=None, kind='home', description=None, body_class='home blog', summary=False):
    tpl = env.get_template('list.html')
    total = max(1, (len(posts) + PER_PAGE - 1) // PER_PAGE)
    for n in range(1, total + 1):
        chunk = posts[(n - 1) * PER_PAGE:n * PER_PAGE]
        flags = set()
        for p in chunk:
            flags.update(p.get('embeds') or [])
        url = base_url if n == 1 else f'{base_url}page/{n}/'
        page_title = title or ''
        if n > 1:
            page_title = (page_title + ' | ' if page_title else '') + f'עמוד {n}'
        write(url, tpl.render(posts=chunk, archive_title=title, archive_description=description,
                              page_title=page_title, pagination=paginate_links(n, total, base_url) if total > 1 else [],
                              embeds=set(), body_class=body_class, canonical=url, page_num=n,
                              is_list=True,
                              summary=summary))


def main():
    t0 = dt.datetime.now()
    if os.path.exists(OUT):
        shutil.rmtree(OUT)
    os.makedirs(OUT)

    posts = sorted(load_items('posts'), key=lambda p: (p['dt'], p['id']), reverse=True)
    pages = load_items('pages')
    by_url = {p['url']: p for p in posts + pages}

    # taxonomies
    cat_posts, tag_posts, auth_posts = defaultdict(list), defaultdict(list), defaultdict(list)
    month_posts, year_posts = defaultdict(list), defaultdict(list)
    for p in posts:
        seen = set()
        for c in p['categories']:
            for anc in cat_chain(c) or [c]:
                if anc not in seen:
                    cat_posts[anc].append(p)
                    seen.add(anc)
        for tg in p['tags']:
            tag_posts[tg].append(p)
        auth_posts[p['author']].append(p)
        month_posts[(p['dt'].year, p['dt'].month)].append(p)
        year_posts[p['dt'].year].append(p)

    # sidebar & header are the same on every page: render once
    top = []
    thumbs_dir = os.path.join(OUT, 'assets', 'thumbs')
    os.makedirs(thumbs_dir, exist_ok=True)
    for url in CFG.get('top_posts') or []:
        p = by_url.get(url)
        if not p:
            continue
        img = media(p['image']) if p.get('image') else None
        if p.get('image'):
            from urllib.parse import unquote
            rel = unquote(p['image'][len('/wp-content/uploads/'):])
            src = os.path.join(UPLOADS_DIR, MEDIA_MAP.get(rel, rel))
            if os.path.exists(src):
                try:
                    from PIL import Image, ImageOps
                    im = ImageOps.fit(Image.open(src).convert('RGB'), (200, 200))
                    name = f'{p["id"]}.jpg'
                    im.save(os.path.join(thumbs_dir, name), quality=82, optimize=True, progressive=True)
                    img = f'{BASE}/assets/thumbs/{name}'
                except Exception as e:  # noqa: BLE001
                    print('thumb failed', src, e, file=sys.stderr)
        top.append({'url': p['url'], 'title': p['title'], 'img': img})
    months = [{'y': y, 'm': m, 'name': f'{HEB_MONTHS[m - 1]} {y}', 'count': len(v), 'url': f'/{y}/{m:02d}/'}
              for (y, m), v in sorted(month_posts.items(), reverse=True)]
    menu = []
    for item in CFG['menu']:
        def entry(it):
            if 'cat' in it:
                return {'title': it.get('title') or CATS.get(it['cat'], {}).get('name', it['cat']),
                        'url': cat_url(it['cat'])}
            return {'title': it['title'], 'url': it['page']}
        e = entry(item)
        e['children'] = [entry(c) for c in item.get('children', [])]
        menu.append(e)
    env.globals['sidebar'] = Markup(env.get_template('_sidebar.html').render(top=top, recent=posts[:10], months=months))
    env.globals['menu'] = menu

    # singles
    single = env.get_template('single.html')
    for i, p in enumerate(posts):
        prev_p = posts[i + 1] if i + 1 < len(posts) else None
        next_p = posts[i - 1] if i > 0 else None
        write(p['url'], single.render(post=p, prev=prev_p, next=next_p, comments=comments_for(p['id']),
                                      embeds=set(p.get('embeds') or []), page_title=p['title'],
                                      body_class='single single-post', canonical=p['url'], is_singular=True))
    for p in pages:
        write(p['url'], single.render(post=p, comments=[], embeds=set(p.get('embeds') or []), page_title=p['title'],
                                      body_class='page', canonical=p['url'], is_page=True, is_singular=True))

    # lists
    render_list('/', posts)
    for slug, lst in cat_posts.items():
        name = CATS.get(slug, {}).get('name', slug)
        render_list(cat_url(slug), lst, title=f'ארכיון קטגוריה: {name}', body_class='archive category')
    for slug, lst in tag_posts.items():
        render_list(tag_url(slug), lst, title=f'ארכיון תגית: {TAGS.get(slug, slug)}', body_class='archive tag', summary=True)
    for login, lst in auth_posts.items():
        render_list(author_url(login), lst, title=f'כל הפוסטים של {AUTHORS.get(login, login)}',
                    body_class='archive author', summary=True)
    for (y, m), lst in month_posts.items():
        render_list(f'/{y}/{m:02d}/', lst, title=f'ארכיון חודשי: {HEB_MONTHS[m - 1]} {y}', body_class='archive date', summary=True)
    for y, lst in year_posts.items():
        render_list(f'/{y}/', lst, title=f'ארכיון שנתי: {y}', body_class='archive date', summary=True)

    # search index
    idx = []
    for p in posts:
        text = p.get('excerpt') or strip_tags(p['teaser'] or p['rest'])
        idx.append({'t': p['title'], 'u': p['url'], 'd': p['dt'].strftime('%Y-%m-%d'),
                    'x': text[:180], 'c': ' '.join(CATS.get(c, {}).get('name', c) for c in p['categories']),
                    'g': ' '.join(TAGS.get(t, t) for t in p['tags']),
                    'i': p.get('image') and media(p['image'])})
    with open(os.path.join(OUT, 'search-index.json'), 'w', encoding='utf-8') as f:
        json.dump(idx, f, ensure_ascii=False, separators=(',', ':'))
    write('/search/', env.get_template('search.html').render(page_title='חיפוש', body_class='search', canonical='/search/', is_list=True))
    write('/404.html', env.get_template('404.html').render(page_title='הדף לא נמצא', body_class='error404'))

    # redirects
    redir = env.get_template('redirect.html')
    for src, dst in REDIRECTS.items():
        if os.path.exists(out_path(src)):
            continue
        write(src if src.endswith('/') else src + '/', redir.render(target=u(dst)))

    # feed + sitemap + robots
    feed = env.get_template('feed.xml').render(posts=posts[:20], absolute=absolute, now=dt.datetime.now(dt.timezone.utc))
    write('/feed/', feed)
    write('/feed.xml', feed)
    sm = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
          f'<url><loc>{SITE_URL}/</loc></url>']
    for p in pages + posts:
        sm.append(f'<url><loc>{html.escape(SITE_URL + quote(p["url"]))}</loc><lastmod>{p["dt"]:%Y-%m-%d}</lastmod></url>')
    for slug in cat_posts:
        sm.append(f'<url><loc>{html.escape(SITE_URL + quote(cat_url(slug)))}</loc></url>')
    sm.append('</urlset>')
    write('/sitemap.xml', '\n'.join(sm))
    write('/robots.txt', f'User-agent: *\nAllow: /\nSitemap: {SITE_URL}/sitemap.xml\n')
    write('/.nojekyll', '')
    if os.environ.get('CNAME'):
        write('/CNAME', os.environ['CNAME'].strip() + '\n')

    # static files (hard-link when possible, it's fast and saves space)
    src_static = os.path.join(ROOT, 'static')
    for dp, _, files in os.walk(src_static):
        rel = os.path.relpath(dp, src_static)
        dst_dir = os.path.join(OUT, rel)
        os.makedirs(dst_dir, exist_ok=True)
        for fn in files:
            s, d = os.path.join(dp, fn), os.path.join(dst_dir, fn)
            try:
                os.link(s, d)
            except OSError:
                shutil.copy2(s, d)

    print(f'Built {written} pages, {len(posts)} posts, {len(pages)} pages in '
          f'{(dt.datetime.now() - t0).total_seconds():.1f}s; images loaded from old server: {len(missing_media)}')


if __name__ == '__main__':
    main()
