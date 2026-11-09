#!/usr/bin/env python3
"""Keep the writer and category choices in Pages CMS in step with data/authors.yml and
data/categories.yml (both edited in Pages CMS: "כותבים", "קטגוריות").

- fills in a missing `slug` from the name (the same rule build.py uses);
- rewrites the choices of the "כותב" and "קטגוריות" fields in .pages.yml, between the
  `# BEGIN …` / `# END …` markers, with the entries marked active, in the order of the file.
Entries that are not active stay in the data files, so older posts keep their writer's name
and category, but they are no longer offered when writing a post.
Run by .github/workflows/cms-lists.yml; prints what changed.
"""
import os
import re
import sys

import yaml

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGES = os.path.join(ROOT, '.pages.yml')


def slugify(text):            # same as build.py
    text = re.sub(r'[\s_/]+', '-', str(text).strip().lower())
    return re.sub(r'[^\w\-א-ת]', '', text).strip('-') or 'post'


def load(name, key):
    path = os.path.join(ROOT, 'data', name)
    data = yaml.safe_load(open(path, encoding='utf-8')) or {}
    return path, data, data.get(key) or []


def fix_slugs(items, path, data):
    """Fill missing slugs; returns True when the file was rewritten."""
    changed, seen = False, set()
    for it in items:
        name = str(it.get('name') or '').strip()
        slug = str(it.get('slug') or '').strip()
        if name and not slug:
            slug = slugify(name)
            base, n = slug, 2
            while slug in seen:
                slug, n = f'{base}-{n}', n + 1
            it['slug'] = slug
            changed = True
        if 'active' not in it:
            it['active'] = True
            changed = True
        seen.add(slug)
    if changed:
        with open(path, 'w', encoding='utf-8') as f:
            yaml.safe_dump(data, f, allow_unicode=True, sort_keys=False, width=10000)
    return changed


def choices(items, indent):
    pad = ' ' * indent
    out, seen = [], set()
    for it in items:
        name = str(it.get('name') or '').strip()
        slug = str(it.get('slug') or '').strip() or slugify(name)
        if not name or it.get('active') is False or slug in seen:
            continue
        seen.add(slug)
        out.append(f'{pad}- name: {yaml.safe_dump(slug, allow_unicode=True).strip().removesuffix("...").strip()}\n')
        out.append(f'{pad}  label: {yaml.safe_dump(name, allow_unicode=True).strip().removesuffix("...").strip()}\n')
    return ''.join(out)


def replace_block(text, key, body):
    pat = re.compile(rf'^(?P<pad>[ \t]*)# BEGIN {key}\b[^\n]*\n.*?^[ \t]*# END {key}\b[^\n]*\n', re.M | re.S)
    m = pat.search(text)
    if not m:
        sys.exit(f'.pages.yml: no "# BEGIN {key}" … "# END {key}" markers')
    pad = m.group('pad')
    new = (f'{pad}# BEGIN {key} – made from data/{key}.yml by tools/update_cms_lists.py, do not edit here\n'
           + body + f'{pad}# END {key}\n')
    return text[:m.start()] + new + text[m.end():]


def main():
    a_path, a_data, authors = load('authors.yml', 'authors')
    c_path, c_data, cats = load('categories.yml', 'categories')
    if fix_slugs(authors, a_path, a_data):
        print('filled in missing slugs in data/authors.yml')
    if fix_slugs(cats, c_path, c_data):
        print('filled in missing slugs in data/categories.yml')

    text = open(PAGES, encoding='utf-8').read()
    for key, items in (('authors', authors), ('categories', cats)):
        m = re.search(rf'^([ \t]*)# BEGIN {key}\b', text, re.M)
        indent = len(m.group(1)) if m else 6
        text = replace_block(text, key, choices(items, indent))
    yaml.safe_load(text)          # must still be valid YAML
    if text != open(PAGES, encoding='utf-8').read():
        open(PAGES, 'w', encoding='utf-8').write(text)
        print('updated the choices in .pages.yml')


if __name__ == '__main__':
    main()
