"""Turn a bare media URL into embed HTML, the way WordPress auto-embeds links
that sit alone on a line (YouTube, Vimeo, X/Twitter, Facebook, Instagram, ...)."""
import html
import re
from urllib.parse import urlparse, parse_qs, quote


def _iframe(src, ratio='16-9', title='', allow=''):
    allow = allow or 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share'
    return (f'<div class="embed-wrap embed-{ratio}"><iframe loading="lazy" src="{html.escape(src, quote=True)}" '
            f'title="{html.escape(title, quote=True)}" allow="{allow}" allowfullscreen></iframe></div>')


def youtube_id(url):
    u = urlparse(html.unescape(url))
    host = (u.hostname or '').lower()
    vid = None
    if host.endswith('youtu.be'):
        vid = u.path.strip('/').split('/')[0]
    elif 'youtube' in host:
        q = parse_qs(u.query)
        if 'v' in q:
            vid = q['v'][0]
        else:
            m = re.match(r'/(?:embed|shorts|v|live)/([^/?#]+)', u.path)
            if m:
                vid = m.group(1)
    if not vid:
        return None, 0
    vid = re.sub(r'[^A-Za-z0-9_-]', '', vid)[:11]
    q = parse_qs(u.query)
    t = (q.get('t') or q.get('start') or ['0'])[0]
    m = re.match(r'(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$', t)
    start = 0
    if m:
        start = int(m.group(1) or 0) * 3600 + int(m.group(2) or 0) * 60 + int(m.group(3) or 0)
    return vid or None, start


def youtube(vid, start=0):
    src = f'https://www.youtube.com/embed/{vid}?rel=0' + (f'&start={start}' if start else '')
    return _iframe(src, title='YouTube')


def vimeo(vid):
    return _iframe(f'https://player.vimeo.com/video/{vid}', title='Vimeo')


def videopress(guid):
    guid = re.sub(r'[^A-Za-z0-9]', '', guid)
    return _iframe(f'https://videopress.com/embed/{guid}?hd=1', title='VideoPress')


IMG_EXT = re.compile(r'\.(?:jpe?g|png|gif|webp|avif)(?:\?.*)?$', re.I)
AUD_EXT = re.compile(r'\.(?:mp3|m4a|ogg|wav)(?:\?.*)?/?$', re.I)
VID_EXT = re.compile(r'\.(?:mp4|webm|mov|m4v)(?:\?.*)?$', re.I)


def audio(src):
    src = src.rstrip('/')
    s = html.escape(src, quote=True)
    return f'<audio class="wp-audio-shortcode" controls preload="none" src="{s}"><a href="{s}">{s}</a></audio>'


def video(src):
    s = html.escape(src, quote=True)
    return f'<video class="wp-video-shortcode" controls preload="metadata" src="{s}"><a href="{s}">{s}</a></video>'


def embed_html(url, flags=None):
    """Return embed HTML for url, or None if the URL isn't an embeddable provider."""
    if flags is None:
        flags = set()
    raw = html.unescape(url.strip())
    u = urlparse(raw)
    host = (u.hostname or '').lower().removeprefix('www.').removeprefix('m.')
    esc = html.escape(raw, quote=True)

    if host in ('youtube.com', 'youtu.be', 'youtube-nocookie.com', 'music.youtube.com'):
        vid, start = youtube_id(raw)
        if vid:
            return youtube(vid, start)
    if host in ('vimeo.com', 'player.vimeo.com'):
        m = re.search(r'/(\d+)', u.path)
        if m:
            return vimeo(m.group(1))
    if host in ('dailymotion.com', 'dai.ly'):
        m = re.search(r'/(?:video/)?([a-z0-9]+)', u.path)
        if m:
            return _iframe(f'https://www.dailymotion.com/embed/video/{m.group(1).split("_")[0]}', title='Dailymotion')
    if host in ('twitter.com', 'x.com', 'mobile.twitter.com') and '/status' in u.path:
        flags.add('twitter')
        clean = f'https://twitter.com{u.path}'
        return (f'<blockquote class="twitter-tweet" data-dnt="true" data-lang="he"><p>'
                f'<a href="{html.escape(clean, quote=True)}">{html.escape(clean)}</a></p></blockquote>')
    if host in ('instagram.com', 'instagr.am') and re.match(r'/(?:p|reel|tv)/', u.path):
        flags.add('instagram')
        clean = f'https://www.instagram.com{u.path}'
        return (f'<blockquote class="instagram-media" data-instgrm-permalink="{html.escape(clean, quote=True)}" '
                f'data-instgrm-version="14"><a href="{html.escape(clean, quote=True)}">{html.escape(clean)}</a></blockquote>')
    if host in ('facebook.com', 'fb.watch', 'business.facebook.com', 'web.facebook.com'):
        flags.add('facebook')
        kind = 'fb-video' if ('/videos/' in u.path or host == 'fb.watch' or 'video.php' in u.path) else 'fb-post'
        clean = raw.split('?__')[0]
        return (f'<div class="fb-embed"><div class="{kind}" data-href="{html.escape(clean, quote=True)}" data-width="auto" '
                f'data-show-text="true"><blockquote><a href="{html.escape(clean, quote=True)}">{html.escape(clean)}</a>'
                f'</blockquote></div></div>')
    if host == 'open.spotify.com':
        return _iframe('https://open.spotify.com/embed' + u.path, ratio='spotify', title='Spotify',
                       allow='autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture')
    if host == 'soundcloud.com':
        return _iframe('https://w.soundcloud.com/player/?url=' + quote(raw, safe=''), ratio='audio', title='SoundCloud')
    if host == 'videopress.com':
        m = re.match(r'/(?:v|embed)/([A-Za-z0-9]+)', u.path)
        if m:
            return videopress(m.group(1))
    if host.endswith('giphy.com') and '/gifs/' in u.path:
        gid = u.path.rstrip('/').split('-')[-1].split('/')[-1]
        return f'<img class="aligncenter" loading="lazy" src="https://media.giphy.com/media/{gid}/giphy.gif" alt="">'
    if IMG_EXT.search(u.path):
        return f'<img loading="lazy" src="{esc}" alt="">'
    if AUD_EXT.search(u.path):
        return audio(raw)
    if VID_EXT.search(u.path):
        return video(raw)
    return None
