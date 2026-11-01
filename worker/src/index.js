// Multiverse comments: a tiny endpoint that stores new comments in the site's
// GitHub repository as "waiting for approval". Nothing is published until the
// site owner ticks "מאושר" in the editing interface (Pages CMS).
//
// Secrets (set by the deploy workflow): COMMENTS_GITHUB_TOKEN (required),
// BREVO_API_KEY + NOTIFY_EMAIL (optional: an email for each new comment).

const MAX_TEXT = 5000;

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

function clean(value, max) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .slice(0, max);
}

function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function israelTime(d) {
  // "YYYY-MM-DD HH:MM:SS" in Israel time
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export default {
  async fetch(request, env, ctx) {
    const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : (allowed[0] || '*'),
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return new Response('Multiverse comments service', { headers: cors });
    if (!allowed.includes(origin)) return json({ ok: false, error: 'origin' }, 403, cors);

    let d;
    try { d = await request.json(); } catch { return json({ ok: false, error: 'bad_request' }, 400, cors); }

    // spam traps: a hidden field people never fill, and a minimum time on the page
    if (clean(d.website, 200)) return json({ ok: true }, 200, cors);
    const ts = Number(d.ts);
    if (!ts || Date.now() - ts < 3000) return json({ ok: false, error: 'too_fast' }, 400, cors);

    const author = clean(d.author, 80);
    const email = clean(d.email, 120);
    const text = clean(d.text, MAX_TEXT);
    const postId = parseInt(d.post_id, 10);
    const parent = parseInt(d.parent, 10) || 0;
    const postUrl = clean(d.post_url, 300);
    const postTitle = clean(d.post_title, 300);
    if (author.length < 2) return json({ ok: false, error: 'author' }, 400, cors);
    if (text.length < 2) return json({ ok: false, error: 'text' }, 400, cors);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ ok: false, error: 'email' }, 400, cors);
    if (!postId || !postUrl.startsWith('/')) return json({ ok: false, error: 'post' }, 400, cors);
    if ((text.match(/https?:\/\//g) || []).length > 4) return json({ ok: false, error: 'links' }, 400, cors);
    if (!env.COMMENTS_GITHUB_TOKEN) return json({ ok: false, error: 'not_configured' }, 503, cors);

    const id = Date.now();
    const now = new Date(id);
    const date = israelTime(now);
    // JSON strings are valid YAML scalars, so this is a safe way to write YAML
    const yaml = [
      `id: ${id}`,
      `approved: false`,
      `post_id: ${postId}`,
      `post_title: ${JSON.stringify(postTitle)}`,
      `post_url: ${JSON.stringify(postUrl)}`,
      `parent: ${parent}`,
      `author: ${JSON.stringify(author)}`,
      `email: ${JSON.stringify(email)}`,
      `date: ${JSON.stringify(date)}`,
      `text: ${JSON.stringify(text)}`,
    ].join('\n') + '\n';
    const path = `content/comments/new/${date.slice(0, 10)}-${id}.yml`;

    const gh = await fetch(`https://api.github.com/repos/${env.REPO}/contents/${path}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${env.COMMENTS_GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'multiverse-comments',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: `תגובה חדשה ממתינה לאישור: ${postTitle || postUrl} [skip ci]`,
        content: toBase64(yaml),
        branch: env.BRANCH || 'main',
      }),
    });
    if (!gh.ok) {
      console.log('github error', gh.status, await gh.text());
      return json({ ok: false, error: 'storage' }, 502, cors);
    }

    if (env.BREVO_API_KEY && env.NOTIFY_EMAIL) {
      const site = env.SITE_URL || '';
      const html = `<div dir="rtl" style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6">
<p><b>${escapeHtml(author)}</b> כתב/ה תגובה על <a href="${site}${encodeURI(postUrl)}">${escapeHtml(postTitle || postUrl)}</a>:</p>
<blockquote style="border-right:3px solid #044774;margin:0;padding:4px 12px;white-space:pre-wrap">${escapeHtml(text)}</blockquote>
<p>התגובה תופיע באתר אחרי שתסמנו אותה "מאושר" בממשק העריכה, תחת "תגובות":<br>
<a href="https://app.pagescms.org/">app.pagescms.org</a></p></div>`;
      ctx.waitUntil(fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': env.BREVO_API_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
          sender: { name: 'מולטיוורס – תגובות', email: env.NOTIFY_FROM || 'news@multiversesite.com' },
          to: [{ email: env.NOTIFY_EMAIL }],
          ...(email ? { replyTo: { email, name: author } } : {}),
          subject: `תגובה חדשה ממתינה לאישור: ${postTitle || postUrl}`,
          htmlContent: html,
        }),
      }).then(r => { if (!r.ok) return r.text().then(t => console.log('brevo error', r.status, t)); })
        .catch(e => console.log('brevo error', String(e))));
    }

    return json({ ok: true }, 200, cors);
  },
};
