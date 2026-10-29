#!/usr/bin/env python3
"""One-time importer: WordPress (WXR) export -> content files for build.py.

Usage: python3 tools/import_wp.py <export.xml> <repo-root>

Writes:
  content/posts/YYYY/YYYY-MM-DD-<id>.html   front matter + HTML body
  content/pages/<slug>.html
  content/comments/<post-id>.json
  data/authors.json, data/categories.json, data/tags.json, data/redirects.json
Author e-mails and commenter e-mails/IPs from the export are never written.
"""
import html
import json
import os
import re
import sys
from collections import defaultdict, Counter
from urllib.parse import unquote, urlparse
import xml.etree.ElementTree as ET

import yaml

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wpautop import wpautop  # noqa: E402
import embeds  # noqa: E402

NS = {
    'wp': 'http://wordpress.org/export/1.2/',
    'content': 'http://purl.org/rss/1.0/modules/content/',
    'excerpt': 'http://wordpress.org/export/1.2/excerpt/',
    'dc': 'http://purl.org/dc/elements/1.1/',
}
SITE_HOSTS = r'(?:www\.)?multiversesite\.(?:com|wordpress\.com)'


def t(el, path):
    return el.findtext(path, namespaces=NS) or ''


def metas(item):
    out = defaultdict(list)
    for m in item.findall('wp:postmeta', NS):
        out[t(m, 'wp:meta_key')].append(t(m, 'wp:meta_value'))
    return out


SAFE_ASCII = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/-._~!$&'()*+,;=:@")


def norm_path(p):
    """Percent-decode a URL path to readable Unicode, re-escaping only unsafe ASCII."""
    try:
        d = unquote(p, errors='strict')
    except UnicodeDecodeError:
        return p
    return ''.join(c if (ord(c) > 127 or c in SAFE_ASCII or c == '%') else '%%%02X' % ord(c) for c in d)


def upload_path(url):
    """https://multiversesite.com/wp-content/uploads/2015/02/x.jpg -> 2015/02/x.jpg (decoded)."""
    m = re.search(r'/wp-content/uploads/([^?#]+)', url) or re.search(r'files\.wordpress\.com/([^?#]+)', url)
    return unquote(m.group(1)) if m else None


# ---------------------------------------------------------------- shortcodes
ATT_RE = re.compile(r'([\w-]+)\s*=\s*"([^"]*)"(?:\s|$)|([\w-]+)\s*=\s*\'([^\']*)\'(?:\s|$)|'
                    r'([\w-]+)\s*=\s*([^\s\'"]+)(?:\s|$)|"([^"]*)"(?:\s|$)|\'([^\']*)\'(?:\s|$)|(\S+)(?:\s|$)')


def parse_atts(s):
    s = html.unescape(s.replace(' ', ' ').replace('​', ' ')).strip()
    named, pos = {}, []
    for m in ATT_RE.finditer(s):
        if m.group(1):
            named[m.group(1).lower()] = m.group(2)
        elif m.group(3):
            named[m.group(3).lower()] = m.group(4)
        elif m.group(5):
            named[m.group(5).lower()] = m.group(6)
        elif m.group(7) is not None:
            pos.append(m.group(7))
        elif m.group(8) is not None:
            pos.append(m.group(8))
        elif m.group(9):
            pos.append(m.group(9))
    return named, pos


class Converter:
    def __init__(self, attachments, children, known_paths):
        self.att = attachments          # id -> dict(path, caption, title)
        self.children = children        # post id -> [attachment ids]
        self.known = known_paths        # set of internal page paths
        self.att_paths = {a['path'] for a in attachments.values() if a['path']}
        self.flags_by_post = {}
        self.stats = Counter()

    # -- url rewriting
    def rewrite_urls(self, h):
        def upl(m):
            p = unquote(m.group(1))
            if p not in self.att_paths:
                orig = re.sub(r'-\d+x\d+(\.\w+)$', r'\1', p)
                if orig in self.att_paths:
                    p = orig
            return '/wp-content/uploads/' + norm_path(p)
        tail = r'([^"\'\s?#)<>\]]+)(?:\?[^"\'\s)<>\]]*)?'
        h = re.sub(r'https?://i[0-3]\.wp\.com/' + SITE_HOSTS + r'/wp-content/uploads/' + tail, upl, h)
        h = re.sub(r'https?://' + SITE_HOSTS + r'/wp-content/uploads/' + tail, upl, h)
        h = re.sub(r'https?://multiversesite\.files\.wordpress\.com/' + tail, upl, h)
        h = re.sub(r'(?<=["\'])/wp-content/uploads/' + tail, upl, h)

        def link(m):
            path = m.group(3) or '/'
            path, _, frag = path.partition('#')
            path, _, query = path.partition('?')
            query = '&'.join(q for q in query.split('&') if q and not q.startswith(('fbclid', 'amp;fbclid', 'utm_')))
            path = norm_path(path)
            return f'{m.group(1)}={m.group(2)}{path}{"?" + query if query else ""}{"#" + frag if frag else ""}{m.group(2)}'
        h = re.sub(r'(href|src)=(["\'])https?://' + SITE_HOSTS + r'(/[^"\']*)?\2', link, h)
        h = re.sub(r'(href)=(["\'])(/[^"\']*)\2', link, h)

        # links from an image to its WordPress "attachment page" -> link to the image file instead
        def att_link(m):
            href = m.group(2)
            bare = href.split('#')[0].split('?')[0]
            if ('attachment_id=' in href or (href.startswith('/') and not href.startswith('/wp-content/')
                                              and bare not in self.known and re.match(r'/\d{4}/\d\d/\d\d/', bare))):
                self.stats['attachment_links'] += 1
                return f'<a{m.group(1)}href="{m.group(4)}"{m.group(3)}>{m.group(5)}'
            return m.group(0)
        h = re.sub(r'<a([^>]*?)href="([^"]+)"([^>]*)>(?=\s*<img[^>]+src="([^"]+)")(\s*<img)', att_link, h)
        h = re.sub(r'\s(?:srcset|sizes|data-orig-file|data-orig-size|data-comments-opened|data-image-meta|'
                   r'data-image-title|data-image-description|data-image-caption|data-medium-file|data-large-file|'
                   r'data-permalink|data-attachment-id|data-recalc-dims|data-lazy-src|data-lazy-srcset|'
                   r'data-orig-height|data-orig-width)=("[^"]*"|\'[^\']*\')', '', h)
        return h

    # -- shortcodes
    def shortcodes(self, h, post_id, put, flags):
        def caption(m):
            named, _ = parse_atts(m.group(1))
            inner = m.group(2)
            mm = re.match(r'^\s*((?:<a [^>]+>\s*)?<img [^>]+>(?:\s*</a>)?)(.*)$', inner, re.S | re.I)
            img, cap = (mm.group(1), mm.group(2).strip()) if mm else (inner, '')
            cap = cap or named.get('caption', '')
            width = named.get('width', '')
            style = f' style="width: {int(width)}px"' if width.isdigit() and int(width) > 1 else ''
            ident = f' id="{html.escape(named["id"], quote=True)}"' if named.get('id') else ''
            align = html.escape(named.get('align', 'alignnone'), quote=True)
            figcap = f'<figcaption class="wp-caption-text">{cap}</figcaption>' if cap else ''
            self.stats['caption'] += 1
            return put(f'<figure{ident} class="wp-caption {align}"{style}>{img}{figcap}</figure>')
        h = re.sub(r'\[caption([^\]]*)\](.*?)\[/caption\]', caption, h, flags=re.S | re.I)

        def embed_sc(m):
            url = m.group(2).strip()
            e = embeds.embed_html(url, flags)
            return put(e) if e else f'<a href="{html.escape(url, quote=True)}">{html.escape(url)}</a>'
        h = re.sub(r'\[embed([^\]]*)\](.*?)\[/embed\]', embed_sc, h, flags=re.S | re.I)

        def generic(m):
            name, raw = m.group(1).lower(), m.group(2)
            if raw.startswith('='):               # WP.com legacy: [youtube=URL]
                raw = raw[1:]
            named, pos = parse_atts(raw)
            self.stats[name] += 1
            if name == 'gallery':
                return put(self.gallery(named, post_id))
            if name in ('audio', 'video'):
                src = (named.get('src') or named.get('mp3') or named.get('m4a') or named.get('ogg')
                       or named.get('wav') or named.get('mp4') or named.get('webm') or named.get('mov')
                       or (pos[0].split('|')[0] if pos else ''))
                if not src:
                    return ''
                src = self.rewrite_urls(f'"{src}"').strip('"')
                return put(embeds.audio(src) if name == 'audio' else embeds.video(src))
            if name == 'vimeo':
                val = named.get('id') or (pos[0] if pos else '')
                mm = re.search(r'(\d{5,})', val)
                return put(embeds.vimeo(mm.group(1))) if mm else ''
            if name == 'youtube':
                val = pos[0] if pos else (named.get('url') or raw)
                vid, start = embeds.youtube_id(val.split('&w=')[0])
                return put(embeds.youtube(vid, start)) if vid else ''
            if name in ('wpvideo', 'videopress'):
                guid = pos[0] if pos else named.get('guid', '')
                return put(embeds.videopress(guid)) if guid else ''
            if name == 'googleapps':
                src = f'https://{named.get("domain", "docs")}.google.com/{named.get("dir", "")}'
                if named.get('query'):
                    src += '?' + named['query']
                return put(f'<div class="embed-wrap embed-doc"><iframe loading="lazy" src="{html.escape(src, quote=True)}" '
                           f'title="Google"></iframe></div>')
            return m.group(0)
        h = re.sub(r'\[(gallery|audio|video|vimeo|youtube|wpvideo|videopress|googleapps)(?=[\s\]=/])([^\]]*?)/?\]',
                   generic, h, flags=re.I)
        return h

    def gallery(self, named, post_id):
        ids = [int(x) for x in re.findall(r'\d+', named.get('ids', '') or named.get('include', ''))]
        if not ids:
            ids = self.children.get(post_id, [])
        cols = named.get('columns', '3')
        cols = int(cols) if cols.isdigit() and 0 < int(cols) < 10 else 3
        link = named.get('link', '')
        items = []
        for i in ids:
            a = self.att.get(i)
            if not a or not a['path']:
                continue
            src = '/wp-content/uploads/' + norm_path(a['path'])
            alt = html.escape(a['title'], quote=True)
            img = f'<img loading="lazy" src="{src}" alt="{alt}">'
            if link != 'none':
                img = f'<a href="{src}">{img}</a>'
            cap = f'<figcaption class="wp-caption-text gallery-caption">{html.escape(a["caption"])}</figcaption>' if a['caption'] else ''
            items.append(f'<figure class="gallery-item"><div class="gallery-icon">{img}</div>{cap}</figure>')
        return f'<div class="gallery gallery-columns-{cols}">' + ''.join(items) + '</div>'

    # -- the_content
    def convert(self, raw, post_id, footnotes_json=''):
        flags = set()
        holders = []

        def put(s):
            holders.append(s)
            return f'@@PH{len(holders) - 1}@@'

        is_blocks = '<!-- wp:' in raw
        h = raw.replace('\r\n', '\n')
        # premium-content: keep the subscriber view, drop log-in prompts
        h = re.sub(r'<!-- wp:premium-content/logged-out-view.*?<!-- /wp:premium-content/logged-out-view -->', '', h, flags=re.S)
        h = re.sub(r'<!-- wp:jetpack/recurring-payments.*?<!-- /wp:jetpack/recurring-payments -->', '', h, flags=re.S)
        if '<!-- wp:footnotes' in h:
            try:
                notes = json.loads(footnotes_json) if footnotes_json else []
            except ValueError:
                notes = []
            lis = ''.join(f'<li id="{html.escape(n.get("id", ""), quote=True)}">{n.get("content", "")} '
                          f'<a href="#{html.escape(n.get("id", ""), quote=True)}-link" aria-label="חזרה לטקסט">↩︎</a></li>'
                          for n in notes)
            h = re.sub(r'<!-- wp:footnotes\b[^>]*?/-->', (f'<ol class="wp-block-footnotes">{lis}</ol>' if lis else ''), h)
        h = self.rewrite_urls(h)
        h = self.shortcodes(h, post_id, put, flags)

        def auto_line(m):
            e = embeds.embed_html(m.group(2), flags)
            if e is None:
                u = m.group(2)
                return f'{m.group(1)}<a href="{html.escape(html.unescape(u), quote=True)}">{u}</a>{m.group(3)}'
            self.stats['autoembed'] += 1
            return m.group(1) + put(e) + m.group(3)
        # WordPress autoembed: a URL alone on its line, or alone in a paragraph
        h = re.sub(r'(<p(?: [^>]*)?>\s*)(https?://[^\s<>"]+)(\s*</p>)', auto_line, h, flags=re.I)
        h = re.sub(r'^(\s*)(https?://[^\s<>"]+)(\s*)$', auto_line, h, flags=re.M)

        if not is_blocks:
            h = wpautop(h)
            # shortcode_unautop: a placeholder alone in a paragraph is not wrapped
            h = re.sub(r'<p>\s*(@@PH\d+@@)\s*</p>', r'\1', h)
            h = re.sub(r'<p>\s*(@@PH\d+@@)\s*<br />\s*', r'\1<p>', h)
            h = re.sub(r'<br />\s*(@@PH\d+@@)\s*</p>', r'</p>\1', h)
        h = re.sub(r'<!-- /?wp:[^>]*?-->\n?', '', h)
        h = re.sub(r'<p>\s*</p>', '', h)
        for _ in range(3):  # placeholders can nest (caption inside gallery etc.)
            h = re.sub(r'@@PH(\d+)@@', lambda m: holders[int(m.group(1))], h)
        h = re.sub(r'<img(?![^>]*\bloading=)', '<img loading="lazy" decoding="async"', h)
        h = re.sub(r'\n{3,}', '\n\n', h).strip()
        return h, flags


def main(xml_path, root):
    tree = ET.parse(xml_path)
    ch = tree.getroot().find('channel')
    items = ch.findall('item')

    authors = {t(a, 'wp:author_login'): t(a, 'wp:author_display_name') for a in ch.findall('wp:author', NS)}

    cats = {}
    for c in ch.findall('wp:category', NS):
        slug = unquote(t(c, 'wp:category_nicename'))
        cats[slug] = {'name': html.unescape(t(c, 'wp:cat_name')), 'parent': unquote(t(c, 'wp:category_parent')) or None}
    tags = {}
    for tg in ch.findall('wp:tag', NS):
        tags[unquote(t(tg, 'wp:tag_slug'))] = html.unescape(t(tg, 'wp:tag_name'))

    attachments, children = {}, defaultdict(list)
    for i in items:
        if t(i, 'wp:post_type') != 'attachment':
            continue
        aid = int(t(i, 'wp:post_id'))
        attachments[aid] = {
            'path': upload_path(t(i, 'wp:attachment_url')),
            'title': html.unescape(t(i, 'title')),
            'caption': html.unescape(t(i, 'excerpt:encoded')).strip(),
            'order': int(t(i, 'wp:menu_order') or 0),
        }
        parent = int(t(i, 'wp:post_parent') or 0)
        if parent:
            children[parent].append(aid)
    for p in children:
        children[p].sort(key=lambda a: (attachments[a]['order'], a))

    published = [i for i in items if t(i, 'wp:post_type') in ('post', 'page') and t(i, 'wp:status') == 'publish']
    known = set()
    for i in published:
        known.add(norm_path(urlparse(t(i, 'link')).path))

    conv = Converter(attachments, children, known)
    os.makedirs(f'{root}/content/posts', exist_ok=True)
    os.makedirs(f'{root}/content/pages', exist_ok=True)
    os.makedirs(f'{root}/content/comments', exist_ok=True)
    os.makedirs(f'{root}/data', exist_ok=True)

    redirects = {}
    used_uploads = set()
    n_posts = n_pages = n_comments = 0
    for i in published:
        pid = int(t(i, 'wp:post_id'))
        ptype = t(i, 'wp:post_type')
        meta = metas(i)
        raw = t(i, 'content:encoded')
        url = norm_path(urlparse(t(i, 'link')).path)
        date = t(i, 'wp:post_date')
        fn_json = (meta.get('footnotes') or [''])[0]

        m = re.search(r'<!--more(.*?)?-->', raw)
        if m:
            teaser_raw, rest_raw = raw[:m.start()], raw[m.end():]
            # drop the paragraph wrapper block editors put around the more tag
            teaser_raw = re.sub(r'<p>\s*$', '', teaser_raw)
            rest_raw = re.sub(r'^\s*</p>', '', rest_raw)
            teaser, f1 = conv.convert(teaser_raw, pid, fn_json)
            rest, f2 = conv.convert(rest_raw, pid, fn_json)
            body = teaser + '\n\n<!--more-->\n\n' + rest
            flags = f1 | f2
        else:
            body, flags = conv.convert(raw, pid, fn_json)

        thumb = None
        tid = (meta.get('_thumbnail_id') or [''])[0]
        if tid.isdigit() and int(tid) in attachments and attachments[int(tid)]['path']:
            thumb = '/wp-content/uploads/' + norm_path(attachments[int(tid)]['path'])
            used_uploads.add(attachments[int(tid)]['path'])
        for u in re.findall(r'/wp-content/uploads/([^"\'\s<>)]+)', body):
            used_uploads.add(unquote(u))

        fm = {
            'id': pid,
            'title': html.unescape(t(i, 'title')),
            'date': date,
            'url': url,
            'author': t(i, 'dc:creator'),
        }
        if ptype == 'post':
            pcats = [unquote(c.get('nicename')) for c in i.findall('category') if c.get('domain') == 'category']
            ptags = [unquote(c.get('nicename')) for c in i.findall('category') if c.get('domain') == 'post_tag']
            fm['categories'] = pcats
            fm['tags'] = ptags
        if thumb:
            fm['image'] = thumb
        if flags:
            fm['embeds'] = sorted(flags)
        excerpt = html.unescape(t(i, 'excerpt:encoded')).strip()
        if excerpt:
            fm['excerpt'] = excerpt
        seo = (meta.get('advanced_seo_description') or [''])[0]
        if seo:
            fm['description'] = seo

        # comments (no e-mails / IPs)
        comments = []
        for c in i.findall('wp:comment', NS):
            if t(c, 'wp:comment_approved') != '1' or t(c, 'wp:comment_type') not in ('', 'comment'):
                continue
            curl = t(c, 'wp:comment_author_url')
            comments.append({
                'id': int(t(c, 'wp:comment_id')),
                'parent': int(t(c, 'wp:comment_parent') or 0),
                'author': html.unescape(t(c, 'wp:comment_author')),
                'url': curl if curl.startswith(('http://', 'https://')) else '',
                'date': t(c, 'wp:comment_date'),
                'html': conv.rewrite_urls(wpautop(t(c, 'wp:comment_content'))),
            })
        comments.sort(key=lambda c: (c['date'], c['id']))
        if comments:
            fm['comments'] = len(comments)
            with open(f'{root}/content/comments/{pid}.json', 'w', encoding='utf-8') as f:
                json.dump(comments, f, ensure_ascii=False, indent=1)
            n_comments += len(comments)

        front = yaml.safe_dump(fm, allow_unicode=True, sort_keys=False, width=10000)
        if ptype == 'post':
            y = date[:4]
            os.makedirs(f'{root}/content/posts/{y}', exist_ok=True)
            path = f'{root}/content/posts/{y}/{date[:10]}-{pid}.html'
            n_posts += 1
            # redirects for old slugs / old dates
            d = date[:10].replace('-', '/')
            slug = url.rstrip('/').split('/')[-1]
            for old in meta.get('_wp_old_slug', []):
                redirects[f'/{d}/{norm_path(old)}/'] = url
            for od in meta.get('_wp_old_date', []):
                redirects[f'/{od.replace("-", "/")}/{slug}/'] = url
        else:
            path = f'{root}/content/pages/{url.strip("/").replace("/", "_") or "index"}.html'
            n_pages += 1
        with open(path, 'w', encoding='utf-8') as f:
            f.write('---\n' + front + '---\n' + body + '\n')

    # links into multi-page posts (/post/2/) and old comment pages (/post/comment-page-1/)
    for i in published:
        url = norm_path(urlparse(t(i, 'link')).path)
        pages_n = t(i, 'content:encoded').count('<!--nextpage-->')
        for n in range(2, pages_n + 2):
            redirects[f'{url}{n}/'] = url
        if any(t(c, 'wp:comment_approved') == '1' for c in i.findall('wp:comment', NS)):
            redirects[f'{url}comment-page-1/'] = url + '#comments'
    redirects = {k: v for k, v in redirects.items() if k not in known and k != v}
    for name, obj in (('authors', authors), ('categories', cats), ('tags', tags), ('redirects', redirects)):
        with open(f'{root}/data/{name}.json', 'w', encoding='utf-8') as f:
            json.dump(obj, f, ensure_ascii=False, indent=1, sort_keys=True)
    with open(f'{root}/data/used_uploads.txt', 'w', encoding='utf-8') as f:
        f.write('\n'.join(sorted(used_uploads)) + '\n')
    print(f'posts {n_posts}, pages {n_pages}, comments {n_comments}, redirects {len(redirects)}, '
          f'uploads referenced {len(used_uploads)}')
    print(dict(conv.stats))


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
