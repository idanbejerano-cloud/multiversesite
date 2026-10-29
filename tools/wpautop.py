"""Python port of WordPress's wpautop() (wp-includes/formatting.php).

Turns double line breaks into <p> paragraphs and single line breaks into <br />,
exactly the way WordPress renders classic-editor posts.
"""
import re

ALLBLOCKS = (r'(?:table|thead|tfoot|caption|col|colgroup|tbody|tr|td|th|div|dl|dd|dt|ul|ol|li|pre|'
             r'form|map|area|blockquote|address|style|p|h[1-6]|hr|fieldset|legend|section|article|'
             r'aside|hgroup|header|footer|nav|figure|figcaption|details|menu|summary)')

_TAG_OR_COMMENT = re.compile(r'<!--.*?-->|<[^<>]*>', re.S)


def _replace_in_html_tags(text, mapping):
    def repl(m):
        s = m.group(0)
        for a, b in mapping.items():
            s = s.replace(a, b)
        return s
    return _TAG_OR_COMMENT.sub(repl, text)


def wpautop(text, br=True):
    if text.strip() == '':
        return ''
    text = text + "\n"

    pre_tags = {}
    if '<pre' in text:
        parts = text.split('</pre>')
        last = parts.pop()
        text = ''
        for i, part in enumerate(parts):
            start = part.find('<pre')
            if start == -1:
                text += part
                continue
            name = f'<pre wp-pre-tag-{i}></pre>'
            pre_tags[name] = part[start:] + '</pre>'
            text += part[:start] + name
        text += last

    text = re.sub(r'<br\s*/?>\s*<br\s*/?>', "\n\n", text)
    text = re.sub(r'(<' + ALLBLOCKS + r'[\s/>])', r"\n\n\1", text)
    text = re.sub(r'(</' + ALLBLOCKS + r'>)', r"\1\n\n", text)
    text = re.sub(r'(<hr\s*?/?>)', r"\1\n\n", text)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = _replace_in_html_tags(text, {"\n": " <!-- wpnl --> "})

    if '<option' in text:
        text = re.sub(r'\s*<option', '<option', text)
        text = re.sub(r'</option>\s*', '</option>', text)
    if '</object>' in text:
        text = re.sub(r'(<object[^>]*>)\s*', r'\1', text)
        text = re.sub(r'\s*</object>', '</object>', text)
        text = re.sub(r'\s*(</?(?:param|embed)[^>]*>)\s*', r'\1', text)
    if '<source' in text or '<track' in text:
        text = re.sub(r'([<\[](?:audio|video)[^>\]]*[>\]])\s*', r'\1', text)
        text = re.sub(r'\s*([<\[]/(?:audio|video)[>\]])', r'\1', text)
        text = re.sub(r'\s*(<(?:source|track)[^>]*>)\s*', r'\1', text)
    if '<figcaption' in text:
        text = re.sub(r'\s*(<figcaption[^>]*>)', r'\1', text)
        text = re.sub(r'</figcaption>\s*', '</figcaption>', text)

    text = re.sub(r"\n\n+", "\n\n", text)
    pees = [p for p in re.split(r'\n\s*\n', text) if p != '']
    text = ''
    for tinkle in pees:
        text += '<p>' + tinkle.strip("\n") + "</p>\n"

    text = re.sub(r'<p>\s*</p>', '', text)
    text = re.sub(r'<p>([^<]+)</(div|address|form)>', r"<p>\1</p></\2>", text)
    text = re.sub(r'<p>\s*(</?' + ALLBLOCKS + r'[^>]*>)\s*</p>', r'\1', text)
    text = re.sub(r'<p>(<li.+?)</p>', r'\1', text)
    text = re.sub(r'<p><blockquote([^>]*)>', r'<blockquote\1><p>', text, flags=re.I)
    text = text.replace('</blockquote></p>', '</p></blockquote>')
    text = re.sub(r'<p>\s*(</?' + ALLBLOCKS + r'[^>]*>)', r'\1', text)
    text = re.sub(r'(</?' + ALLBLOCKS + r'[^>]*>)\s*</p>', r'\1', text)

    if br:
        text = re.sub(r'<(script|style|svg|math).*?</\1>',
                      lambda m: m.group(0).replace("\n", '<WPPreserveNewline />'), text, flags=re.S)
        text = text.replace('<br>', '<br />').replace('<br/>', '<br />')
        text = re.sub(r'(?<!<br />)\s*\n', "<br />\n", text)
        text = text.replace('<WPPreserveNewline />', "\n")

    text = re.sub(r'(</?' + ALLBLOCKS + r'[^>]*>)\s*<br />', r'\1', text)
    text = re.sub(r'<br />(\s*</?(?:p|li|div|dl|dd|dt|th|pre|td|ul|ol)[^>]*>)', r'\1', text)
    text = re.sub(r"\n</p>$", '</p>', text)

    for name, html in pre_tags.items():
        text = text.replace(name, html)

    if '<!-- wpnl -->' in text:
        text = text.replace(' <!-- wpnl --> ', "\n").replace('<!-- wpnl -->', "\n")
    return text
