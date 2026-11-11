// מולטיוורס – ניהול האתר מהטלפון.
// A small app (no build step, no libraries) served by a Cloudflare Worker on its own address
// (see manage/README.md). People sign in with an email code (Cloudflare Access); the Worker keeps the
// GitHub key and the GoatCounter key and passes the app's requests on (/api/gh/..., /api/gc/...),
// so nobody keeps a key on their phone.
// What it does:
// comments waiting for approval, drafts and publishing, a quick new post, the site build status,
// the Facebook-group agent's log and the GoatCounter statistics, plus links to every other service.

const OWNER = 'idanbejerano-cloud';
const REPO = 'multiversesite';
const BRANCH = window.MV_BRANCH || 'main';
const API = '/api/gh';
const RP = `/repos/${OWNER}/${REPO}`;
const SITE = 'https://multiversesite.com';
const CMS = `https://app.pagescms.org/${OWNER}/${REPO}/${encodeURIComponent(BRANCH)}`;
const GC_CODE = 'multiversesite';
const GC = `https://${GC_CODE}.goatcounter.com`;
const FB_GROUP = 'https://www.facebook.com/groups/ulammale';
const FB_PAGE = 'https://www.facebook.com/multiversesite';
const AGENT_URL = 'https://claude.ai/code/routines/trig_01QHhVbZUUZjz6tv82GMThdE';
const AGENT_EVERY_HOURS = 3;     // the agent runs at minute 34 of every third hour (UTC 0, 3, 6, ...)
const AGENT_MINUTE = 34;
const TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new?' + new URLSearchParams({
  name: 'Multiverse management app', description: 'Kept in Cloudflare by the management app (multiverse-manage)',
  target_name: OWNER, expires_in: 'none', contents: 'write', actions: 'write',
});
const WORKFLOW_NAMES = {
  'deploy.yml': 'בניית האתר', 'publish.yml': 'פרסום פוסט', 'top-posts.yml': 'עדכון "הנצפים ביותר"',
  'cms-lists.yml': 'עדכון רשימות הכותבים והקטגוריות', 'comments-worker.yml': 'עדכון שירות התגובות',
};

// ------------------------------------------------------------------ storage
const store = {
  get(k, d = null) { try { const v = localStorage.getItem('mv.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('mv.' + k, JSON.stringify(v)); } catch { /* full or blocked */ } },
  del(k) { try { localStorage.removeItem('mv.' + k); } catch { /* blocked */ } },
};

for (const k of ['token', 'gcKey', 'user']) store.del(k);      // keys from the first version, which kept them on the phone

const S = {
  me: null, block: '', name: store.get('myName', ''),
  tab: 'home', loaded: false, loading: false, error: '',
  head: '', commits: [], runs: [], comments: [], posts: [], authors: [], categories: [],
  fbSeen: {}, fbCfg: {}, fbLast: null, top: null, loadedAt: 0,
  stats: null, statsError: '', statsLoading: false, index: null, indexLoading: false,
  postsMode: 'drafts', commentsMode: 'pending', query: '', busy: new Set(), watchUntil: 0, installEvt: null,
};
const blobCache = store.get('blobs', {});

// ------------------------------------------------------------------ small helpers
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const str = (v) => (v == null ? '' : String(v).trim());
const arr = (v) => (Array.isArray(v) ? v.map(str).filter(Boolean) : (v ? [str(v)] : []));
const plural = (n, one, many) => (n === 1 ? one : `${n} ${many}`);
const safeUrl = (u) => (/^https?:\/\//i.test(u) ? u : '#');
const dec = (u) => { try { return decodeURI(u); } catch { return String(u); } };
const siteUrl = (path) => (path ? SITE + encodeURI(dec(path)) : SITE);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function el(tag, props, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'html') n.innerHTML = v;            // only for the app's own icons
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'style') n.setAttribute('style', v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
}

const ICONS = {
  home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 9.5V20h13V9.5"/><path d="M10 20v-5.5h4V20"/>',
  posts: '<path d="M6 3h9l4 4v14H6z"/><path d="M14.5 3v4.5H19"/><path d="M9 12h7M9 15.5h7M9 8.5h3"/>',
  comments: '<path d="M4 5h16v11H11l-4.5 4v-4H4z"/><path d="M8 9.5h8M8 12.5h5"/>',
  stats: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  more: '<circle cx="6" cy="6" r="2.2"/><circle cx="18" cy="6" r="2.2"/><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="18" r="2.2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v6H4V6h6"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  trash: '<path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/>',
  share: '<circle cx="18" cy="5.5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="18.5" r="2.5"/><path d="m8.2 10.8 7.6-4.1M8.2 13.2l7.6 4.1"/>',
  edit: '<path d="M4 20h4L19.5 8.5l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  eye: '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  send: '<path d="M21 3 3 10.5l7.5 3L21 3zM10.5 13.5 13.5 21 21 3"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  image: '<rect x="3" y="4.5" width="18" height="15" rx="1.5"/><circle cx="9" cy="10" r="1.8"/><path d="m21 16-5-5-8.5 8.5"/>',
  hide: '<path d="M3 3l18 18"/><path d="M10.6 5.6A9.6 9.6 0 0 1 12 5.5c6.4 0 10 6.5 10 6.5a17 17 0 0 1-3.2 3.9M6.6 6.6C3.7 8.4 2 12 2 12s3.6 6.5 10 6.5a9.4 9.4 0 0 0 4.4-1.1"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>',
};
const icon = (name, cls = '') => el('span', { class: `ic ${cls}`, 'aria-hidden': 'true', html: `<svg viewBox="0 0 24 24">${ICONS[name] || ''}</svg>` });

// dates ---------------------------------------------------------------
function parseLocal(s) {                     // '2026-11-09 20:30:00' (Israel time, as the site writes it)
  const m = /^(\d{4})-(\d\d)-(\d\d)(?:[ T](\d\d):(\d\d)(?::(\d\d))?)?/.exec(str(s));
  return m ? new Date(+m[1], m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) : null;
}
function ago(d) {                               // Hebrew relative time ("לפני שעתיים"), past or future
  if (!d || isNaN(d)) return '';
  const s = (d.getTime() - Date.now()) / 1000;
  const a = Math.abs(s);
  if (a < 50) return 'עכשיו';
  let t;
  if (a < 3600) { const n = Math.round(a / 60); t = n === 1 ? 'דקה' : `${n} דקות`; }
  else if (a < 86400) { const n = Math.round(a / 3600); t = n === 1 ? 'שעה' : n === 2 ? 'שעתיים' : `${n} שעות`; }
  else if (a < 6 * 86400) {
    const n = Math.round(a / 86400);
    if (n === 1) return s < 0 ? 'אתמול' : 'מחר';
    t = n === 2 ? 'יומיים' : `${n} ימים`;
  } else return dayMonth(d);
  return s < 0 ? `לפני ${t}` : `בעוד ${t}`;
}
const dayMonth = (d) => d.toLocaleDateString('he-IL', { day: 'numeric', month: 'long', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
const clock = (d) => d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
function israelNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { Y: parts.year, M: parts.month, D: parts.day, h: parts.hour, m: parts.minute, s: parts.second };
}
function nextAgentRun(now = new Date()) {
  const t = new Date(now);
  t.setUTCSeconds(0, 0);
  for (let i = 0; i < 24 * 60; i++) {
    t.setUTCMinutes(t.getUTCMinutes() + 1);
    if (t.getUTCMinutes() === AGENT_MINUTE && t.getUTCHours() % AGENT_EVERY_HOURS === 0) return t;
  }
  return null;
}

// ------------------------------------------------------------------ YAML (the small subset the site's files use)
function parseYAML(src) {
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  const ind = (l) => l.match(/^ */)[0].length;
  const blank = (l) => /^\s*(#.*)?$/.test(l);
  const skip = () => { while (i < lines.length && blank(lines[i])) i++; };
  const KEY = /^(\s*)("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"][^:#]*?|[^\s:#][^:]*?)\s*:(?:\s+(.*))?$/;

  function scalar(rest, base) {
    rest = rest.trim();
    if (/^[|>][+-]?\d*$/.test(rest)) {                      // block scalar
      const fold = rest[0] === '>';
      const chomp = rest.includes('-') ? '-' : rest.includes('+') ? '+' : '';
      const out = [];
      let bi = -1;
      while (i < lines.length && (blank(lines[i]) || ind(lines[i]) > base)) {
        const l = lines[i];
        if (bi < 0 && !blank(l)) bi = ind(l);
        out.push(blank(l) && l.trim() === '' ? '' : l.slice(Math.max(bi, 0)));
        i++;
      }
      let text;
      if (fold) {
        text = '';
        out.forEach((l, k) => { text += l === '' ? '\n' : (k && out[k - 1] !== '' ? ' ' : '') + l; });
      } else text = out.join('\n');
      text = text.replace(/\n+$/, '');
      return chomp === '-' ? text : text + '\n';
    }
    if (rest[0] === '"' || rest[0] === "'") {                // quoted, maybe over several lines
      const q = rest[0];
      let buf = rest;
      const closed = (b) => (q === '"' ? /^"(?:[^"\\]|\\.)*"\s*(#.*)?$/.test(b) : /^'(?:[^']|'')*'\s*(#.*)?$/.test(b));
      while (!closed(buf) && i < lines.length) { buf += ' ' + lines[i].trim(); i++; }
      buf = buf.replace(/\s*(#.*)?$/, (m0) => (closed(buf) ? '' : m0));
      const inner = buf.slice(1, buf.lastIndexOf(q));
      if (q === "'") return inner.replace(/''/g, "'");
      try { return JSON.parse('"' + inner.replace(/\\\//g, '/').replace(/\t/g, '\\t') + '"'); } catch { return inner.replace(/\\"/g, '"').replace(/\\n/g, '\n'); }
    }
    let val = rest.replace(/\s+#.*$/, '');
    while (i < lines.length && !blank(lines[i]) && ind(lines[i]) > base) { val += ' ' + lines[i].trim(); i++; }
    if (val === '' || val === '~' || val === 'null') return null;
    if (val === 'true') return true;
    if (val === 'false') return false;
    if (val === '[]') return [];
    if (val === '{}') return {};
    if (/^-?\d+$/.test(val) && val.length < 16) return Number(val);
    if (/^\[.*\]$/.test(val)) return val.slice(1, -1).split(',').map((s) => s.trim().replace(/^(['"])(.*)\1$/, '$2')).filter(Boolean);
    return val;
  }

  function node(minInd) {
    skip();
    if (i >= lines.length) return null;
    const n = ind(lines[i]);
    if (n < minInd) return null;
    return /^\s*-(\s|$)/.test(lines[i]) ? list(n) : map(n);
  }

  function value(rest, base) {
    if (rest != null && rest.trim() !== '') return scalar(rest, base);
    skip();
    if (i >= lines.length) return null;
    const n = ind(lines[i]);
    if (n > base) return node(n);
    if (n === base && /^\s*-(\s|$)/.test(lines[i])) return list(n);
    return null;
  }

  function map(n) {
    const obj = {};
    for (;;) {
      skip();
      if (i >= lines.length) break;
      const l = lines[i];
      if (ind(l) !== n || /^\s*-(\s|$)/.test(l)) break;
      const m = KEY.exec(l);
      if (!m) { i++; continue; }
      let key = m[2];
      if (/^["']/.test(key)) key = key.slice(1, -1);
      i++;
      obj[key] = value(m[3], n);
    }
    return obj;
  }

  function list(n) {
    const out = [];
    for (;;) {
      skip();
      if (i >= lines.length) break;
      const l = lines[i];
      if (ind(l) !== n || !/^\s*-(\s|$)/.test(l)) break;
      const content = l.slice(n + 1).replace(/^ +/, '');
      const off = l.length - content.length;
      if (content === '') { i++; out.push(node(n + 1)); continue; }
      if (KEY.test(' '.repeat(off) + content) && !/^["']/.test(content)) {
        lines[i] = ' '.repeat(off) + content;           // "- key: value" starts a map at the item's column
        out.push(map(off));
        continue;
      }
      i++;
      out.push(scalar(content, n));
    }
    return out;
  }

  return node(0);
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const stripTags = (h) => String(h).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/\s+/g, ' ').trim();

function slugify(text) {                       // same as slugify() in build.py
  const t = String(text).trim().toLowerCase().replace(/[\s_/]+/g, '-');
  return t.replace(/[^\p{L}\p{N}_\-א-ת]/gu, '').replace(/^-+|-+$/g, '') || 'post';
}

function parsePost(text) {
  const m = FM_RE.exec(text);
  if (!m) return { title: '', broken: true };
  let fm = {};
  try { fm = parseYAML(m[1]) || {}; } catch { fm = {}; }
  const body = m[2] || '';
  return {
    title: str(fm.title), draft: fm.draft === true, date: str(fm.date), author: str(fm.author), authorName: str(fm.author_name),
    categories: arr(fm.categories), image: str(fm.image), slug: str(fm.slug), url: str(fm.url),
    excerpt: str(fm.excerpt), preview: stripTags(body.split('<!--more-->')[0]).slice(0, 200), source: str(fm.source),
  };
}

function postUrl(p, file) {                    // the address build.py gives the post
  if (p.url) return p.url;
  const d = parseLocal(p.date);
  if (!d) return '';
  const stem = file.replace(/\.html$/, '').replace(/^\d{4}-\d\d-\d\d-/, '');
  const pad = (n) => String(n).padStart(2, '0');
  return `/${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${slugify(p.slug || p.title || stem)}/`;
}

// ------------------------------------------------------------------ GitHub API
class ApiError extends Error {
  constructor(status, message, data) { super(message); this.status = status; this.data = data; }
}

function explain(status, data, path, method) {
  const msg = str(data && data.message);
  if (status === 401) return 'המפתח של GitHub ששמור ב-Cloudflare לא תקין או שפג תוקפו.';
  if (status === 403 && /rate limit/i.test(msg)) return 'GitHub הגביל לרגע את מספר הבקשות. נסו שוב בעוד כמה דקות.';
  if ((status === 403 || status === 404) && method !== 'GET') {
    const what = path.includes('/actions/') ? 'Actions' : 'Contents';
    return `למפתח של GitHub שב-Cloudflare אין הרשאת כתיבה ל-${what}. צריך מפתח עם Contents ו-Actions במצב Read and write למאגר multiversesite.`;
  }
  if (status === 409 || status === 422) return 'מישהו שינה את האתר באותו רגע. רעננו ונסו שוב.';
  if (status >= 500) return 'GitHub לא זמין כרגע. נסו שוב בעוד דקה.';
  return `GitHub החזיר שגיאה ${status}${msg ? `: ${msg}` : ''}`;
}

// Errors from the app's own Worker that stop everything until something is set up or signed in again.
const BLOCKS = {
  no_access: 'הכניסה עם מייל עוד לא הופעלה לאפליקציה.',
  bad_access_token: 'הכניסה לאפליקציה פגה. צריך להתחבר שוב.',
  signin: 'הכניסה לאפליקציה פגה. צריך להתחבר שוב.',
  access_needs_config: 'הכניסה עם מייל פועלת, אבל חסרות שתי הגדרות ב-Cloudflare.',
  no_github_token: 'עוד לא נשמר ב-Cloudflare המפתח של GitHub.',
  github_token_bad: 'המפתח של GitHub ששמור ב-Cloudflare לא תקין או שפג תוקפו.',
};
function block(kind) {
  S.block = kind === 'bad_access_token' ? 'signin' : kind;
  return new ApiError(401, BLOCKS[kind] || 'צריך להתחבר שוב.');
}

async function apiFetch(url, init = {}) {
  let res;
  try {
    res = await fetch(url, { ...init, cache: 'no-store', redirect: 'manual', credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'אין חיבור לאינטרנט, או שהשרת לא עונה. נסו שוב בעוד רגע.');
  }
  if (res.type === 'opaqueredirect' || res.status === 0) throw block('signin');     // Access wants a new sign-in
  return res;
}

async function gh(path, { method = 'GET', body, raw = false, okMissing = false } = {}) {
  const headers = { Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json' };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await apiFetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 404 && okMissing) return null;
  if (!res.ok) {
    let data = null;
    try { data = await res.json(); } catch { /* not json */ }
    if (data && BLOCKS[data.error]) throw block(data.error);
    if (res.status === 401) throw block('github_token_bad');
    throw new ApiError(res.status, explain(res.status, data, path, method), data);
  }
  if (res.status === 204) return null;
  return raw ? res.text() : res.json();
}

async function loadMe() {
  const res = await apiFetch('/api/me');
  let data = null;
  try { data = await res.json(); } catch { /* not json */ }
  if (!res.ok) throw (data && BLOCKS[data.error]) ? block(data.error) : new ApiError(res.status, 'השרת של האפליקציה החזיר שגיאה.');
  S.me = data;
  if (!data.ready.github) throw block('no_github_token');
  if (!S.name) S.name = str(data.name) || str(data.email).replace(/@.*$/, '');
  S.block = '';
  return data;
}

const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');
const readFile = (path, ref) => gh(`${RP}/contents/${encPath(path)}?ref=${ref}`, { raw: true, okMissing: true });
const listTree = async (expr) => ((await gh(`${RP}/git/trees/${encPath(expr)}`, { okMissing: true })) || { tree: [] }).tree;

function b64(bytes) {
  let s = '';
  for (let k = 0; k < bytes.length; k += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(k, k + 0x8000));
  return btoa(s);
}

// One commit with any number of files. prepare(headSha) returns
// [{path, text} | {path, bytes} | {path, remove: true}], read against that head; on a race it runs again.
async function commitFiles(message, prepare) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const ref = await gh(`${RP}/git/ref/heads/${encodeURIComponent(BRANCH)}`);
    const head = ref.object.sha;
    const [commit, changes] = await Promise.all([gh(`${RP}/git/commits/${head}`), prepare(head)]);
    if (!changes.length) return null;
    const tree = [];
    for (const c of changes) {
      if (c.remove) tree.push({ path: c.path, mode: '100644', type: 'blob', sha: null });
      else if (c.bytes) {
        const b = await gh(`${RP}/git/blobs`, { method: 'POST', body: { content: b64(c.bytes), encoding: 'base64' } });
        tree.push({ path: c.path, mode: '100644', type: 'blob', sha: b.sha });
      } else tree.push({ path: c.path, mode: '100644', type: 'blob', content: c.text });
    }
    const t = await gh(`${RP}/git/trees`, { method: 'POST', body: { base_tree: commit.tree.sha, tree } });
    const nc = await gh(`${RP}/git/commits`, { method: 'POST', body: { message, tree: t.sha, parents: [head] } });
    try {
      await gh(`${RP}/git/refs/heads/${encodeURIComponent(BRANCH)}`, { method: 'PATCH', body: { sha: nc.sha, force: false } });
      S.head = nc.sha;
      return nc;
    } catch (e) {
      if (e.status === 422 && attempt < 2) { await sleep(600); continue; }
      throw e;
    }
  }
  return null;
}

const dispatch = (file, inputs) => gh(`${RP}/actions/workflows/${file}/dispatches`, {
  method: 'POST', body: inputs ? { ref: BRANCH, inputs } : { ref: BRANCH },
});

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let k = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (k < items.length) { const j = k++; out[j] = await fn(items[j], j); }
  }));
  return out;
}

async function blob(sha, parse) {
  if (blobCache[sha]) return blobCache[sha];
  const text = await gh(`${RP}/git/blobs/${sha}`, { raw: true });
  const v = parse(text);
  blobCache[sha] = v;
  return v;
}

// ------------------------------------------------------------------ loading everything
async function load({ quiet = false } = {}) {
  if (S.loading) return;
  const wasLoaded = S.loaded;
  S.loading = true;
  S.error = '';
  if (!quiet && !wasLoaded) render(); else paintTopbar();
  try {
    const year = new Date().getFullYear();
    if (!S.me) await loadMe();
    const [commits, runs] = await Promise.all([
      gh(`${RP}/commits?sha=${encodeURIComponent(BRANCH)}&per_page=12`),
      gh(`${RP}/actions/runs?per_page=30`),
    ]);
    const head = commits[0].sha;
    const [cTree, rootTree, yTree, pyTree, dTree, fbCommits] = await Promise.all([
      listTree(`${head}:content/comments/new`), listTree(`${head}:content/posts`),
      listTree(`${head}:content/posts/${year}`), listTree(`${head}:content/posts/${year - 1}`),
      listTree(`${head}:data`),
      gh(`${RP}/commits?sha=${encodeURIComponent(BRANCH)}&path=data/facebook_seen.json&per_page=1`).catch(() => []),
    ]);
    const keep = new Set();
    const commentFiles = cTree.filter((e) => e.type === 'blob' && /\.ya?ml$/.test(e.path));
    const postFiles = [
      ...rootTree.filter((e) => e.type === 'blob' && e.path.endsWith('.html')).map((e) => ({ ...e, full: `content/posts/${e.path}` })),
      ...yTree.filter((e) => e.type === 'blob' && e.path.endsWith('.html')).map((e) => ({ ...e, full: `content/posts/${year}/${e.path}` })),
      ...pyTree.filter((e) => e.type === 'blob' && e.path.endsWith('.html')).map((e) => ({ ...e, full: `content/posts/${year - 1}/${e.path}` })),
    ];
    const data = Object.fromEntries(dTree.map((e) => [e.path, e.sha]));
    const dataBlob = async (name, parse) => {
      if (!data[name]) return null;
      keep.add(data[name]);
      try { return await blob(data[name], parse); } catch { return null; }
    };
    const [comments, posts, authors, categories, fbSeen, fbCfg, top] = await Promise.all([
      pool(commentFiles, 6, async (e) => {
        keep.add(e.sha);
        const c = await blob(e.sha, (t) => { try { return parseYAML(t) || {}; } catch { return {}; } });
        return { ...c, path: `content/comments/new/${e.path}`, sha: e.sha };
      }),
      pool(postFiles, 6, async (e) => {
        keep.add(e.sha);
        const p = await blob(e.sha, parsePost);
        return { ...p, path: e.full, file: e.path, sha: e.sha, url: postUrl(p, e.path) };
      }),
      dataBlob('authors.yml', (t) => (parseYAML(t) || {}).authors || []),
      dataBlob('categories.yml', (t) => (parseYAML(t) || {}).categories || []),
      dataBlob('facebook_seen.json', (t) => JSON.parse(t)),
      dataBlob('facebook.json', (t) => JSON.parse(t)),
      dataBlob('top_posts.json', (t) => JSON.parse(t)),
    ]);
    for (const k of Object.keys(blobCache)) if (!keep.has(k)) delete blobCache[k];
    store.set('blobs', blobCache);

    Object.assign(S, {
      head, loaded: true, loadedAt: Date.now(), block: '',
      commits: commits.map((c) => ({
        sha: c.sha, url: c.html_url, message: str(c.commit.message.split('\n')[0]),
        who: str(c.commit.author && c.commit.author.name) || (c.author && c.author.login) || '',
        date: new Date((c.commit.author && c.commit.author.date) || (c.commit.committer && c.commit.committer.date)),
      })),
      runs: runs.workflow_runs || [],
      comments: comments.map((c) => ({ ...c, when: parseLocal(c.date) })).sort((a, b) => (b.when || 0) - (a.when || 0)),
      posts: posts.filter((p) => !p.broken).map((p) => ({ ...p, when: parseLocal(p.date) }))
        .sort((a, b) => (b.when || 0) - (a.when || 0)),
      authors: authors || [], categories: categories || [], fbSeen: fbSeen || {}, fbCfg: fbCfg || {}, top,
      fbLast: fbCommits && fbCommits[0] ? new Date(fbCommits[0].commit.committer.date) : null,
    });
    setBadge();
    if (statsReady() && !S.stats && !S.statsLoading) loadStats();
    watchRuns();
  } catch (e) {
    S.error = e.message || String(e);
  } finally {
    S.loading = false;
    if (wasLoaded) paint(); else render();
  }
}

async function refreshRuns() {
  try {
    const runs = await gh(`${RP}/actions/runs?per_page=30`);
    const before = latestDeploy();
    S.runs = runs.workflow_runs || [];
    const after = latestDeploy();
    if (before && after && before.id === after.id && before.status !== 'completed' && after.status === 'completed') {
      if (after.conclusion === 'success') toast('האתר עודכן. השינויים כבר באוויר.');
      else if (after.conclusion === 'failure') toast('בניית האתר נכשלה. אפשר לראות את הפרטים בכרטיס "האתר".', 'bad');
    }
    paintPanelsOnly();
  } catch { /* the next refresh will tell */ }
}

let runTimer = 0;
function watchRuns() {
  clearTimeout(runTimer);
  const active = S.runs.some((r) => r.status !== 'completed') || Date.now() < S.watchUntil;
  if (!active || document.hidden) return;
  runTimer = setTimeout(async () => { await refreshRuns(); watchRuns(); }, 8000);
}

function latestDeploy() {
  return S.runs.find((r) => r.path && r.path.endsWith('/deploy.yml') && r.head_branch === 'main' && r.conclusion !== 'cancelled')
    || S.runs.find((r) => r.path && r.path.endsWith('/deploy.yml'));
}
const wfName = (r) => WORKFLOW_NAMES[(r.path || '').split('/').pop()] || r.name;

function siteStatus() {
  const d = latestDeploy();
  if (!d) return { state: 'unknown', title: 'לא ידוע', text: 'אין עדיין נתונים על בניית האתר.' };
  const when = new Date(d.updated_at || d.created_at);
  if (d.status !== 'completed') return { state: 'busy', title: 'מתעדכן', text: `בנייה התחילה ${ago(new Date(d.run_started_at || d.created_at))}`, run: d };
  if (d.conclusion === 'success') return { state: 'ok', title: 'באוויר', text: `עודכן ${ago(when)}`, run: d };
  return { state: 'bad', title: 'הבנייה נכשלה', text: `הניסיון האחרון ${ago(when)}`, run: d };
}

const pending = () => S.comments.filter((c) => c.approved !== true);
const approvedRecent = () => S.comments.filter((c) => c.approved === true).slice(0, 25);
const drafts = () => S.posts.filter((p) => p.draft);
const authorName = (slug, fallback) => {
  const a = S.authors.find((x) => str(x.slug) === slug || slugify(x.name) === slug);
  return (a && str(a.name)) || fallback || slug || '';
};

function setBadge() {
  const n = pending().length;
  try { if (navigator.setAppBadge) { if (n) navigator.setAppBadge(n); else navigator.clearAppBadge(); } } catch { /* not supported */ }
}

// ------------------------------------------------------------------ GoatCounter
const gcTime = (d) => `${d.toISOString().slice(0, 13)}:00:00Z`;   // GoatCounter wants the colons as they are
const statsReady = () => Boolean(S.me && S.me.ready && S.me.ready.stats);
async function gc(path) {                                   // through the Worker, which holds the GoatCounter key
  const res = await apiFetch('/api/gc' + path);
  if (res.status === 401 || res.status === 403) throw new Error('GoatCounter לא קיבל את המפתח ששמור ב-Cloudflare (GOATCOUNTER_API_KEY).');
  if (!res.ok) throw new Error(`GoatCounter החזיר שגיאה ${res.status}.`);
  return res.json();
}

async function loadStats() {
  if (!statsReady()) return;
  S.statsLoading = true;
  S.statsError = '';
  paintIf('stats');
  try {
    const end = new Date(Date.now() + 3600e3);
    const start = new Date(Date.now() - 29 * 86400e3);
    start.setUTCHours(0, 0, 0, 0);
    const week = new Date(Date.now() - 7 * 86400e3);
    const [total, hits] = await Promise.all([
      gc(`/stats/total?start=${gcTime(start)}&end=${gcTime(end)}`),
      gc(`/stats/hits?start=${gcTime(week)}&end=${gcTime(end)}&limit=12`),
    ]);
    const days = (total.stats || []).map((d) => ({ day: d.day, n: d.daily || 0 }));
    S.stats = {
      days, total: total.total || 0, today: days.length ? days[days.length - 1].n : 0,
      week: days.slice(-7).reduce((a, d) => a + d.n, 0),
      top: (hits.hits || []).filter((h) => !h.event).map((h) => ({ path: h.path, title: h.title, n: h.count })),
      at: Date.now(),
    };
  } catch (e) {
    S.statsError = e.message;
  } finally {
    S.statsLoading = false;
    paintTopbar();
    paintIf('stats');
    paintIf('home');
  }
}

// ------------------------------------------------------------------ search index of the live site (all published posts)
async function loadIndex() {
  if (S.index || S.indexLoading) return;
  S.indexLoading = true;
  try {
    const res = await fetch(`${SITE}/search-index.json`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(String(res.status));
    S.index = (await res.json()).map((x) => ({
      title: x.t, url: x.u, when: parseLocal(x.d), image: x.i, cats: x.c, tags: x.g, excerpt: x.x,
      norm: norm(`${x.t} ${x.c} ${x.g}`),
    }));
  } catch {
    S.index = [];
    toast('לא הצלחתי לטעון את רשימת כל הפוסטים מהאתר.', 'bad');
  } finally {
    S.indexLoading = false;
    if (S.tab === 'posts') paintPostResults();
  }
}
const norm = (s) => String(s).toLowerCase().replace(/[֑-ׇ]/g, '').replace(/["'״׳\-–_.,:!?()]/g, ' ').replace(/\s+/g, ' ');

// the file of an older post (not in this year's or last year's folder), found by its address
async function resolvePath(post) {
  if (post.path) return post.path;
  const known = S.posts.find((x) => x.path && (x.url === post.url || dec(x.url) === dec(post.url)));
  if (known) return known.path;
  const cache = store.get('paths', {});
  if (cache[post.url]) return cache[post.url];
  const m = /^\/(\d{4})\/(\d\d)\/(\d\d)\//.exec(post.url || '');
  if (!m) return '';
  const files = (await listTree(`${BRANCH}:content/posts/${m[1]}`))
    .filter((e) => e.type === 'blob' && e.path.startsWith(`${m[1]}-${m[2]}-${m[3]}-`));
  for (const e of files) {
    const p = parsePost(await gh(`${RP}/git/blobs/${e.sha}`, { raw: true }));
    if (postUrl(p, e.path) === post.url || dec(postUrl(p, e.path)) === dec(post.url)) {
      const path = `content/posts/${m[1]}/${e.path}`;
      cache[post.url] = path;
      store.set('paths', cache);
      return path;
    }
  }
  return '';
}

// ------------------------------------------------------------------ actions
async function busy(key, fn) {
  if (S.busy.has(key)) return;
  S.busy.add(key);
  paint();
  try { return await fn(); } catch (e) { toast(e.message || String(e), 'bad'); if (S.block) render(); } finally { S.busy.delete(key); paint(); }
}
const who = () => S.name || 'האפליקציה';
const byApp = () => `(מאפליקציית הניהול, ${who()})`;

async function approveComments(list, approved = true) {
  const n = list.length;
  const headline = n === 1
    ? `${approved ? 'אישור' : 'הסתרת'} תגובה: ${str(list[0].author) || 'אנונימי'} על "${str(list[0].post_title).slice(0, 60)}"`
    : `${approved ? 'אישור' : 'הסתרת'} ${n} תגובות`;
  await commitFiles(`${headline} ${byApp()}`, async (head) => {
    const out = [];
    for (const c of list) {
      const text = await readFile(c.path, head);
      if (text == null) continue;
      const line = `approved: ${approved}`;
      const next = /^approved:.*$/m.test(text) ? text.replace(/^approved:.*$/m, line) : `${line}\n${text}`;
      if (next !== text) out.push({ path: c.path, text: next });
    }
    return out;
  });
  for (const c of list) c.approved = approved;
  setBadge();
  toast(approved
    ? (n === 1 ? 'התגובה אושרה. היא תופיע באתר בעוד כ-3 דקות.' : `${n} תגובות אושרו. הן יופיעו באתר בעוד כ-3 דקות.`)
    : 'התגובה הוסתרה. היא תרד מהאתר בעוד כ-3 דקות.');
  S.watchUntil = Date.now() + 120e3;
  setTimeout(() => { refreshRuns(); watchRuns(); }, 4000);
}

async function deleteComment(c) {
  await commitFiles(`מחיקת תגובה: ${str(c.author) || 'אנונימי'} על "${str(c.post_title).slice(0, 60)}" ${byApp()}`, async (head) => {
    const text = await readFile(c.path, head);
    return text == null ? [] : [{ path: c.path, remove: true }];
  });
  S.comments = S.comments.filter((x) => x !== c);
  setBadge();
  toast('התגובה נמחקה.');
}

async function publishPost(post, action) {
  const path = await resolvePath(post);
  if (!path) throw new Error('לא מצאתי את הקובץ של הפוסט במאגר.');
  await dispatch('publish.yml', {
    payload: JSON.stringify({
      action: { name: action }, context: { type: 'collection', name: 'posts', path },
      triggeredBy: { name: `${who()} (אפליקציית הניהול)` },
    }),
  });
  if (action === 'publish') { post.draft = false; post.pendingPublish = true; } else { post.draft = true; }
  toast(action === 'publish' ? 'הפוסט בדרך לאתר. הוא יופיע שם בעוד כ-3 דקות.' : 'הפוסט יורד מהאתר וחוזר לטיוטות. זה ייקח כ-3 דקות.');
  S.watchUntil = Date.now() + 180e3;
  setTimeout(() => { refreshRuns(); watchRuns(); }, 3000);
  setTimeout(() => load({ quiet: true }), 75e3);
}

async function rebuildSite() {
  await dispatch('deploy.yml');
  toast('בניית האתר התחילה. זה לוקח בערך 3 דקות.');
  S.watchUntil = Date.now() + 120e3;
  setTimeout(() => { refreshRuns(); watchRuns(); }, 3000);
}

async function refreshTopPosts() {
  await dispatch('top-posts.yml');
  toast('רשימת "הנצפים ביותר" מתעדכנת עכשיו מהסטטיסטיקות.');
  S.watchUntil = Date.now() + 120e3;
  setTimeout(() => { refreshRuns(); watchRuns(); }, 3000);
}

async function sharePost(post) {
  const url = siteUrl(post.url);
  if (navigator.share) {
    try { await navigator.share({ title: post.title, url }); } catch { /* cancelled */ }
    return;
  }
  try { await navigator.clipboard.writeText(url); toast('הקישור הועתק.'); } catch { prompt('הקישור לפוסט:', url); }
}

// ------------------------------------------------------------------ UI: layer (sheets, confirm) and toast
let toastTimer = 0;
function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, kind === 'bad' ? 6500 : 4200);
}

function openSheet(content, { full = false, onClose } = {}) {
  const layer = $('#layer');
  const back = el('div', { class: 'backdrop', onclick: () => close() });
  const sheet = el('div', { class: `sheet${full ? ' full' : ''}`, role: 'dialog', 'aria-modal': 'true' }, content);
  const wrap = el('div', { class: 'sheet-wrap' }, back, sheet);
  layer.append(wrap);
  document.body.classList.add('locked');
  requestAnimationFrame(() => wrap.classList.add('open'));
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  function close() {
    document.removeEventListener('keydown', onKey);
    wrap.classList.remove('open');
    setTimeout(() => { wrap.remove(); if (!layer.children.length) document.body.classList.remove('locked'); }, 220);
    if (onClose) onClose();
  }
  return close;
}

function confirmSheet({ title, text, ok, danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); close(); } };
    const close = openSheet(el('div', { class: 'confirm' },
      el('h3', { text: title }),
      text ? el('p', { text }) : null,
      el('div', { class: 'row-actions' },
        el('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => finish(true) }, ok),
        el('button', { class: 'btn ghost', onclick: () => finish(false) }, 'ביטול'))), { onClose: () => { if (!done) { done = true; resolve(false); } } });
  });
}

// ------------------------------------------------------------------ UI: frame
const TABS = [
  ['home', 'בית', 'home'], ['posts', 'פוסטים', 'posts'], ['comments', 'תגובות', 'comments'],
  ['stats', 'צפיות', 'stats'], ['more', 'כלים', 'more'],
];

function render() {
  const app = $('#app');
  app.replaceChildren();
  if (S.block) { app.append(blockView()); return; }
  app.append(topbar(), el('main', { class: `view view-${S.tab}`, id: 'view' }, viewFor(S.tab)), tabbar());
}
function paint() {                                // redraw the current tab and the frame, keep the scroll position
  if (S.block) return render();
  const y = window.scrollY;
  const v = $('#view');
  if (!v) return render();
  v.className = `view view-${S.tab}`;
  v.replaceChildren(viewFor(S.tab));
  paintTopbar();
  $('.tabs')?.replaceWith(tabbar());
  window.scrollTo(0, y);
}
const paintIf = (tab) => { if (S.tab === tab && $('#view')) paint(); };
function paintPanelsOnly() { if (S.tab === 'home' || S.tab === 'more') paint(); }
function paintTopbar() { $('.topbar')?.replaceWith(topbar()); }

function viewFor(tab) {
  if (!S.loaded) {
    if (S.error) return errorCard(S.error);
    return el('div', { class: 'loading-screen' }, el('div', { class: 'spinner' }), el('p', { text: 'טוען את האתר…' }));
  }
  return ({ home: homeView, posts: postsView, comments: commentsView, stats: statsView, more: moreView }[tab] || homeView)();
}

function topbar() {
  return el('header', { class: 'topbar' },
    el('img', { src: 'icons/icon-192.png', alt: '', width: 30, height: 30 }),
    el('div', { class: 'brand' }, 'מולטיוורס', el('small', { text: 'ניהול האתר' })),
    el('button', { class: `icon-btn${S.loading || S.statsLoading ? ' spin' : ''}`, 'aria-label': 'רענון', title: 'רענון', onclick: () => {
      load({ quiet: true });
      if (statsReady() && (S.tab === 'stats' || S.tab === 'home')) loadStats();
    } }, icon('refresh')));
}

function tabbar() {
  const n = pending().length;
  return el('nav', { class: 'tabs', 'aria-label': 'ניווט' }, TABS.map(([id, label, ic]) => el('a', {
    href: `#${id}`, class: `tab${S.tab === id ? ' on' : ''}`, 'aria-current': S.tab === id ? 'page' : null,
  }, el('span', { class: 'tab-ic' }, icon(ic), id === 'comments' && n ? el('b', { class: 'badge', text: n > 99 ? '99+' : n }) : null), el('span', { text: label }))));
}

function errorCard(msg) {
  return el('div', { class: 'panel error-card' },
    el('h3', { text: 'משהו לא נטען' }), el('p', { text: msg }),
    el('button', { class: 'btn primary', onclick: () => load() }, icon('refresh'), 'לנסות שוב'));
}

const ext = (href, label, sub, ic = 'external') => el('a', { class: 'link-row', href: safeUrl(href), target: '_blank', rel: 'noopener' },
  el('span', { class: 'link-text' }, el('b', { text: label }), sub ? el('small', { text: sub }) : null), icon(ic));

// ------------------------------------------------------------------ views: home
function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'לילה טוב' : h < 12 ? 'בוקר טוב' : h < 17 ? 'צהריים טובים' : h < 22 ? 'ערב טוב' : 'לילה טוב';
}

function homeView() {
  const p = pending();
  const d = drafts();
  const st = siteStatus();
  let head;
  let sub = '';
  if (p.length) {
    head = p.length === 1 ? 'תגובה אחת מחכה לאישור' : `${p.length} תגובות מחכות לאישור`;
    if (d.length) sub = d.length === 1 ? 'ויש טיוטה אחת שעוד לא פורסמה.' : `ויש ${d.length} טיוטות שעוד לא פורסמו.`;
  } else if (d.length) {
    head = d.length === 1 ? 'טיוטה אחת מחכה לפרסום' : `${d.length} טיוטות מחכות לפרסום`;
  } else {
    head = 'הכול מטופל';
    sub = 'אין תגובות או טיוטות שמחכות לך.';
  }
  const cover = el('section', { class: 'cover' },
    el('p', { class: 'cover-hello', text: greeting() }),
    el('h1', { class: 'cover-head', text: head }),
    sub ? el('p', { class: 'cover-sub', text: sub }) : null,
    el('p', { class: `cover-status s-${st.state}` }, el('i', { class: 'dot' }), el('span', null, `האתר ${st.title}`, st.text ? el('span', { class: 'when', text: `, ${st.text}` }) : null)),
    el('div', { class: 'cover-actions' },
      el('a', { class: 'btn ink', href: '#new' }, icon('plus'), 'פוסט חדש'),
      p.length ? el('a', { class: 'btn outline', href: '#comments' }, icon('comments'), 'לתגובות')
        : d.length ? el('a', { class: 'btn outline', href: '#posts' }, icon('posts'), 'לטיוטות')
          : el('a', { class: 'btn outline', href: SITE, target: '_blank', rel: 'noopener' }, icon('external'), 'לאתר')));

  return el('div', null, cover, el('div', { class: 'panels' },
    sitePanel(st), draftsPanel(d), agentPanel(), statsPanel(), activityPanel()));
}

function sitePanel(st) {
  const running = S.runs.filter((r) => r.status !== 'completed');
  return el('section', { class: `panel p-site s-${st.state}` },
    el('h2', { text: 'האתר' }),
    el('p', { class: 'big', text: st.title }),
    el('p', { class: 'muted', text: st.text }),
    running.length ? el('ul', { class: 'runs' }, running.map((r) => el('li', null, el('i', { class: 'mini-spin' }), wfName(r)))) : null,
    st.state === 'bad' && st.run ? el('a', { class: 'text-link', href: st.run.html_url, target: '_blank', rel: 'noopener', text: 'מה השתבש' }) : null,
    el('div', { class: 'panel-actions' },
      el('a', { class: 'btn small', href: SITE, target: '_blank', rel: 'noopener' }, icon('eye'), 'פתיחה'),
      el('button', { class: 'btn small ghost', disabled: S.busy.has('rebuild'), onclick: () => busy('rebuild', rebuildSite) }, icon('refresh'), 'בנייה מחדש')));
}

function draftsPanel(d) {
  return el('a', { class: 'panel p-drafts', href: '#posts', onclick: () => { S.postsMode = 'drafts'; } },
    el('h2', { text: 'טיוטות' }),
    el('p', { class: 'big', text: String(d.length) }),
    d.length ? el('p', { class: 'muted clamp2', text: d[0].title || 'טיוטה בלי כותרת' }) : el('p', { class: 'muted', text: 'אין טיוטות פתוחות' }));
}

function seenEntries() {
  return Object.entries(S.fbSeen || {}).map(([id, v]) => {
    const added = typeof v === 'string' && v.startsWith('/');
    const post = added ? S.posts.find((p) => p.url === v || dec(p.url) === dec(v)) : null;
    return { id, added, url: added ? v : '', reason: added ? '' : String(v).replace(/^skipped:\s*/, ''), title: post ? post.title : '' };
  }).sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1));
}

function agentPanel() {
  const e = seenEntries();
  const added = e.filter((x) => x.added);
  const last = added.find((x) => x.title) || added[0];
  const next = nextAgentRun();
  const since = parseLocal(S.fbCfg.start_date);
  return el('section', { class: 'panel p-agent wide' },
    el('h2', { text: 'הסוכן מקבוצת הפייסבוק' }),
    el('p', { class: 'agent-line' }, `סורק את "אולם ומלואו" כל ${AGENT_EVERY_HOURS} שעות.`, next ? ` הסריקה הבאה ב-${clock(next)}.` : ''),
    last ? el('a', { class: 'agent-last', href: siteUrl(last.url), target: '_blank', rel: 'noopener' },
      el('small', { text: 'הפוסט האחרון שהעביר לאתר' }), last.title ? el('b', { class: 'clamp2', text: last.title }) : el('bdi', { dir: 'ltr', text: dec(last.url) })) : null,
    el('p', { class: 'muted' }, `${added.length} פוסטים הועברו ו-${e.length - added.length} דולגו`, since ? ` מאז ${dayMonth(since)}` : '',
      S.fbLast ? `. שינוי אחרון ${ago(S.fbLast)}.` : '.'),
    el('div', { class: 'panel-actions' },
      el('button', { class: 'btn small', onclick: openAgentLog }, icon('posts'), 'היומן'),
      el('a', { class: 'btn small ghost', href: AGENT_URL, target: '_blank', rel: 'noopener' }, icon('external'), 'הסוכן ב-Claude'),
      el('a', { class: 'btn small ghost', href: FB_GROUP, target: '_blank', rel: 'noopener' }, icon('external'), 'הקבוצה')));
}

function openAgentLog() {
  const e = seenEntries();
  openSheet(el('div', { class: 'sheet-body' },
    el('div', { class: 'sheet-head' }, el('h3', { text: 'יומן הסוכן' }), el('p', { class: 'muted', text: 'כל פוסט של גל פלודה ושל עידן בז\'רנו שהסוכן ראה בקבוצה, מהחדש לישן.' })),
    el('ul', { class: 'log' }, e.map((x) => el('li', { class: x.added ? 'added' : 'skipped' },
      el('span', { class: 'log-mark', text: x.added ? 'הועבר' : 'דולג' }),
      x.added
        ? (x.title ? el('a', { href: siteUrl(x.url), target: '_blank', rel: 'noopener', text: x.title })
          : el('span', { class: 'gone' }, 'הפוסט כבר לא באתר ', el('bdi', { dir: 'ltr', text: dec(x.url) })))
        : el('span', { text: x.reason || 'דולג' }),
      el('a', { class: 'log-fb', href: `${FB_GROUP}/posts/${x.id}/`, target: '_blank', rel: 'noopener', 'aria-label': 'הפוסט בפייסבוק' }, icon('external'))))),
    el('a', { class: 'btn ghost wide', href: AGENT_URL, target: '_blank', rel: 'noopener' }, icon('external'), 'ההגדרות וההרצות של הסוכן ב-Claude')));
}

function bars(days, { height = 64 } = {}) {            // right to left: the oldest day on the right, today on the left
  const max = Math.max(1, ...days.map((d) => d.n));
  const w = 300;
  const bw = w / Math.max(days.length, 1);
  const svg = `<svg viewBox="0 0 ${w} ${height}" preserveAspectRatio="none" role="img" aria-label="צפיות ב-${days.length} הימים האחרונים">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fe6505"/><stop offset="1" stop-color="#d90e68"/></linearGradient></defs>
    ${days.map((d, k) => {
    const h = Math.max(2, (d.n / max) * (height - 4));
    return `<rect x="${((days.length - 1 - k) * bw + 1).toFixed(1)}" y="${(height - h).toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" fill="${k === days.length - 1 ? 'url(#g)' : 'currentColor'}"><title>${esc(d.day)}: ${d.n}</title></rect>`;
  }).join('')}</svg>`;
  return el('div', { class: 'bars', html: svg });
}

function statsPanel() {
  if (!statsReady()) {
    return el('a', { class: 'panel p-stats wide connect', href: '#stats' },
      el('h2', { text: 'צפיות' }), el('p', { text: 'הסטטיסטיקות עוד לא מחוברות לאפליקציה.' }));
  }
  const s = S.stats;
  return el('a', { class: 'panel p-stats wide', href: '#stats' },
    el('h2', { text: 'צפיות' }),
    s ? el('div', { class: 'stat-row' },
      el('div', null, el('b', { class: 'num', text: s.today.toLocaleString('he-IL') }), el('small', { text: 'היום' })),
      el('div', null, el('b', { class: 'num', text: s.week.toLocaleString('he-IL') }), el('small', { text: '7 ימים' })),
      el('div', null, el('b', { class: 'num', text: s.total.toLocaleString('he-IL') }), el('small', { text: '30 יום' }))) : null,
    s ? bars(s.days, { height: 44 }) : el('p', { class: 'muted', text: S.statsError || 'טוען…' }));
}

const CMS_VERB = { Create: 'יצירת', Update: 'עדכון', Delete: 'מחיקת' };
function cmsThing(path) {
  const p = S.posts.find((x) => x.path === path || x.path.endsWith('/' + path.split('/').pop()));
  if (path.startsWith('content/posts/')) return p && p.title ? `פוסט: ${p.title}` : 'פוסט';
  if (path.startsWith('content/comments/')) return 'תגובה';
  if (path.startsWith('content/pages/')) return 'עמוד';
  if (path.startsWith('static/wp-content/uploads/')) return 'תמונה';
  return { 'site.yml': 'הגדרות האתר', 'data/authors.yml': 'רשימת הכותבים', 'data/categories.yml': 'רשימת הקטגוריות' }[path] || path;
}
function humanize(msg) {
  const m = msg.replace(/\s*\[skip ci\]\s*/g, ' ').trim();
  let r;
  if (/^Facebook sync: no new posts/i.test(m) || /^Add 0 posts from the Facebook group/i.test(m)) return 'הסוכן מפייסבוק: אין פוסטים חדשים';
  if ((r = /^Add (\d+) posts? from the Facebook group/i.exec(m))) return r[1] === '1' ? 'הסוכן מפייסבוק: פוסט חדש באתר' : `הסוכן מפייסבוק: ${r[1]} פוסטים חדשים באתר`;
  if ((r = /^Skip (\d+) posts? from the Facebook group/i.exec(m))) return `הסוכן מפייסבוק: דילג על ${r[1] === '1' ? 'פוסט אחד' : `${r[1]} פוסטים`}`;
  if (/^Most viewed posts: updated/i.test(m)) return 'עדכון "הנצפים ביותר" מהסטטיסטיקות';
  if (/^Writer and category choices updated/i.test(m)) return 'עדכון רשימות הכותבים והקטגוריות בעורך';
  if ((r = /^(Create|Update|Delete) (.+?) \(via Pages CMS\)$/.exec(m))) return `${CMS_VERB[r[1]]} ${cmsThing(r[2])} (Pages CMS)`;
  return m;
}
const whoName = (n) => ({ 'Most viewed updater': 'עדכון אוטומטי', 'Pages CMS publish': 'Pages CMS', 'Pages CMS lists': 'Pages CMS' }[n] || n.replace(/@.*$/, ''));

function activityPanel() {
  return el('section', { class: 'panel p-activity wide' },
    el('h2', { text: 'מה השתנה באתר' }),
    el('ul', { class: 'activity' }, S.commits.slice(0, 7).map((c) => el('li', null,
      el('a', { href: c.url, target: '_blank', rel: 'noopener' }, el('span', { class: 'clamp2', text: humanize(c.message) })),
      el('small', { text: `${whoName(c.who)}, ${ago(c.date)}` })))),
    el('a', { class: 'text-link', href: `https://github.com/${OWNER}/${REPO}/commits/${BRANCH}`, target: '_blank', rel: 'noopener', text: 'כל השינויים ב-GitHub' }));
}

// ------------------------------------------------------------------ views: posts
function postsResults() {
  const d = drafts();
  const q = norm(S.query).trim();
  let list;
  let empty;
  if (q) {
    if (!S.index) { loadIndex(); list = null; } else {
      const words = q.split(' ');
      const local = S.posts.filter((p) => p.draft && words.every((w) => norm(p.title).includes(w)));
      list = [...local, ...S.index.filter((x) => words.every((w) => x.norm.includes(w))).slice(0, 60)];
      empty = 'לא נמצאו פוסטים עם המילים האלה.';
    }
  } else if (S.postsMode === 'drafts') {
    list = d;
    empty = 'אין טיוטות. פוסט שנשמר בלי לפרסם יופיע כאן, ואפשר יהיה לפרסם אותו בלחיצה.';
  } else {
    list = S.posts.filter((p) => !p.draft).slice(0, 40);
    empty = 'אין פוסטים מהשנה האחרונה.';
  }
  return el('div', { id: 'post-results' },
    q ? null : el('div', { class: 'seg', role: 'tablist' },
      el('button', { class: S.postsMode === 'drafts' ? 'on' : '', role: 'tab', onclick: () => { S.postsMode = 'drafts'; paintPostResults(); } }, `טיוטות (${d.length})`),
      el('button', { class: S.postsMode === 'recent' ? 'on' : '', role: 'tab', onclick: () => { S.postsMode = 'recent'; paintPostResults(); } }, 'פורסמו לאחרונה')),
    list == null ? el('div', { class: 'loading-inline' }, el('div', { class: 'spinner small' }), 'טוען את כל הפוסטים מהאתר…')
      : list.length ? el('ul', { class: 'post-list' }, list.map(postRow)) : el('p', { class: 'empty', text: empty }));
}
const paintPostResults = () => { $('#post-results')?.replaceWith(postsResults()); };

let searchTimer = 0;
function postsView() {
  const search = el('input', {
    class: 'search', type: 'search', placeholder: 'חיפוש בכל הפוסטים באתר', value: S.query, 'aria-label': 'חיפוש פוסטים', enterkeyhint: 'search',
    oninput: (e) => { S.query = e.target.value; clearTimeout(searchTimer); searchTimer = setTimeout(paintPostResults, 200); },
    onfocus: () => loadIndex(),
  });
  return el('div', { class: 'page' },
    el('div', { class: 'page-head' }, el('h1', { text: 'פוסטים' }), el('a', { class: 'btn primary small', href: '#new' }, icon('plus'), 'פוסט חדש')),
    search, postsResults());
}

function thumbFor(p) {
  if (!p.image) return el('span', { class: 'thumb none' }, icon('posts'));
  const src = /^https?:/.test(p.image) ? p.image : SITE + encodeURI(dec(p.image.startsWith('/') ? p.image : '/' + p.image));
  return el('span', { class: 'thumb' }, el('img', { src, alt: '', loading: 'lazy', onerror: (e) => e.target.remove() }));
}

function postRow(p) {
  const name = p.path ? authorName(p.author, p.authorName) : '';
  const meta = [p.draft ? 'טיוטה' : null, name || null, p.when ? dayMonth(p.when) : null].filter(Boolean).join(', ');
  return el('li', null, el('button', { class: `post-row${p.draft ? ' is-draft' : ''}`, onclick: () => openPost(p) },
    thumbFor(p),
    el('span', { class: 'post-text' }, el('b', { class: 'clamp2', text: p.title || 'בלי כותרת' }), el('small', { text: meta }),
      p.pendingPublish ? el('small', { class: 'tag-live', text: 'בדרך לאתר' }) : null)));
}

function openPost(p) {
  let close;
  const cmsHref = (path) => `${CMS}/collection/posts/edit/${encodeURIComponent(path)}`;
  const cmsLink = (path) => el('a', { class: 'btn ghost wide', href: cmsHref(path), target: '_blank', rel: 'noopener' }, icon('edit'), 'עריכה מלאה ב-Pages CMS');
  let cmsBtn;
  if (p.path) cmsBtn = cmsLink(p.path);
  else {                                   // an older post: find its file first, then offer the link
    cmsBtn = el('span', { class: 'btn ghost wide', 'aria-disabled': 'true' }, el('i', { class: 'mini-spin' }), 'מאתר את הקובץ לעריכה…');
    resolvePath(p).then((path) => { p.path = path; cmsBtn.replaceWith(path ? cmsLink(path) : el('span', { class: 'btn ghost wide', 'aria-disabled': 'true' }, 'לא מצאתי את הקובץ לעריכה')); })
      .catch(() => cmsBtn.replaceWith(el('a', { class: 'btn ghost wide', href: `${CMS}/collection/posts`, target: '_blank', rel: 'noopener' }, icon('edit'), 'לרשימת הפוסטים ב-Pages CMS')));
  }
  const actions = p.draft
    ? [
      el('button', { class: 'btn primary wide', onclick: async () => {
        if (!(await confirmSheet({ title: 'לפרסם את הפוסט?', text: `"${p.title}" יעלה לאתר עם התאריך והשעה של עכשיו.`, ok: 'פרסום' }))) return;
        close();
        busy('publish', () => publishPost(p, 'publish'));
      } }, icon('send'), 'פרסום באתר'),
      cmsBtn,
    ]
    : [
      el('a', { class: 'btn primary wide', href: siteUrl(p.url), target: '_blank', rel: 'noopener' }, icon('eye'), 'צפייה באתר'),
      el('button', { class: 'btn ghost wide', onclick: () => sharePost(p) }, icon('share'), 'שיתוף'),
      cmsBtn,
      el('button', { class: 'btn ghost wide danger-text', onclick: async () => {
        if (!(await confirmSheet({ title: 'להוריד את הפוסט מהאתר?', text: 'הוא יחזור לטיוטות, ואפשר יהיה לפרסם אותו שוב בכל עת.', ok: 'החזרה לטיוטה', danger: true }))) return;
        close();
        busy('publish', () => publishPost(p, 'unpublish'));
      } }, icon('undo'), 'החזרה לטיוטה'),
    ];
  const meta = [p.path ? authorName(p.author, p.authorName) : '', p.when ? dayMonth(p.when) : ''].filter(Boolean).join(', ');
  close = openSheet(el('div', { class: 'sheet-body' },
    p.image ? el('div', { class: 'sheet-hero' }, thumbFor(p)) : null,
    el('div', { class: 'sheet-head' }, el('h3', { text: p.title || 'בלי כותרת' }), meta ? el('p', { class: 'muted', text: meta }) : null),
    (p.excerpt || p.preview) ? el('p', { class: 'preview', text: (p.excerpt || p.preview).slice(0, 220) }) : null,
    el('div', { class: 'stack' }, actions)));
}

// ------------------------------------------------------------------ views: comments
function commentsView() {
  const p = pending();
  const a = approvedRecent();
  const showPending = S.commentsMode === 'pending';
  const list = showPending ? p : a;
  return el('div', { class: 'page' },
    el('div', { class: 'page-head' }, el('h1', { text: 'תגובות' }),
      showPending && p.length > 1 ? el('button', { class: 'btn primary small', disabled: S.busy.has('approve-all'), onclick: async () => {
        if (!(await confirmSheet({ title: `לאשר את כל ${p.length} התגובות?`, text: 'כולן יופיעו באתר בעוד כ-3 דקות.', ok: 'אישור של כולן' }))) return;
        busy('approve-all', () => approveComments(p));
      } }, icon('check'), 'אישור של כולן') : null),
    el('div', { class: 'seg', role: 'tablist' },
      el('button', { class: showPending ? 'on' : '', role: 'tab', onclick: () => { S.commentsMode = 'pending'; paint(); } }, `ממתינות (${p.length})`),
      el('button', { class: showPending ? '' : 'on', role: 'tab', onclick: () => { S.commentsMode = 'approved'; paint(); } }, 'אושרו')),
    list.length ? el('ul', { class: 'comment-list' }, list.map((c) => commentCard(c, showPending)))
      : el('p', { class: 'empty', text: showPending ? 'אין תגובות שמחכות לאישור. תגובה חדשה מהאתר תופיע כאן.' : 'עוד לא אושרו תגובות מהטופס באתר.' }));
}

function commentCard(c, isPending) {
  const key = `c:${c.path}`;
  const working = S.busy.has(key);
  return el('li', { class: `comment${working ? ' working' : ''}` },
    el('div', { class: 'comment-who' }, el('b', { text: str(c.author) || 'אנונימי' }), el('small', { text: c.when ? ago(c.when) : '' }),
      c.parent ? el('small', { class: 'reply-mark', text: 'תשובה לתגובה' }) : null),
    el('div', { class: 'bubble', text: str(c.text) }),
    el('p', { class: 'comment-on' }, 'על ', el('a', { href: siteUrl(c.post_url), target: '_blank', rel: 'noopener', text: str(c.post_title) || c.post_url }),
      c.email ? el('a', { class: 'mail', href: `mailto:${encodeURIComponent(str(c.email))}`, text: str(c.email) }) : null),
    el('div', { class: 'row-actions' },
      isPending
        ? el('button', { class: 'btn primary', disabled: working, onclick: () => busy(key, () => approveComments([c])) }, icon('check'), 'אישור')
        : el('button', { class: 'btn ghost', disabled: working, onclick: () => busy(key, () => approveComments([c], false)) }, icon('hide'), 'הסתרה מהאתר'),
      el('button', { class: 'btn ghost danger-text', disabled: working, onclick: async () => {
        if (!(await confirmSheet({ title: 'למחוק את התגובה?', text: 'התגובה תימחק לגמרי ולא תופיע באתר.', ok: 'מחיקה', danger: true }))) return;
        busy(key, () => deleteComment(c));
      } }, icon('trash'), 'מחיקה')));
}

// ------------------------------------------------------------------ views: stats
function statsView() {
  const page = el('div', { class: 'page' }, el('div', { class: 'page-head' }, el('h1', { text: 'צפיות' }),
    S.stats ? el('small', { class: 'muted', text: `עודכן ${ago(new Date(S.stats.at))}` }) : null));
  if (!statsReady()) {
    page.append(el('section', { class: 'panel setup-card' },
      el('h2', { text: 'הסטטיסטיקות עוד לא מחוברות' }),
      el('p', { class: 'muted', text: 'האפליקציה לוקחת את המפתח של GoatCounter מהסוד GOATCOUNTER_API_KEY ב-GitHub, כשהיא מתעדכנת ב-Cloudflare. אם הסוד קיים, הפעלה אחת של "Deploy management app" ב-GitHub Actions מחברת אותן.' }),
      ext(`https://github.com/${OWNER}/${REPO}/actions/workflows/manage-app.yml`, 'הפעלת העדכון ב-GitHub Actions', 'Run workflow')));
    page.append(topListPanel());
    return page;
  }
  const s = S.stats;
  if (!s) {
    page.append(S.statsError ? el('section', { class: 'panel error-card' }, el('p', { text: S.statsError }), el('button', { class: 'btn primary', onclick: () => loadStats() }, 'לנסות שוב'))
      : el('div', { class: 'loading-inline' }, el('div', { class: 'spinner small' }), 'טוען מ-GoatCounter…'));
    return page;
  }
  page.append(
    el('section', { class: 'panel stats-hero' },
      el('div', { class: 'stat-row big' },
        el('div', null, el('b', { class: 'num', text: s.today.toLocaleString('he-IL') }), el('small', { text: 'היום' })),
        el('div', null, el('b', { class: 'num', text: s.week.toLocaleString('he-IL') }), el('small', { text: '7 ימים' })),
        el('div', null, el('b', { class: 'num', text: s.total.toLocaleString('he-IL') }), el('small', { text: '30 יום' }))),
      bars(s.days, { height: 96 }),
      el('div', { class: 'axis' }, el('small', { text: s.days[0] ? dayMonth(new Date(s.days[0].day)) : '' }), el('small', { text: 'היום' }))),
    el('section', { class: 'panel' },
      el('h2', { text: 'הכי נקראים השבוע' }),
      s.top.length ? el('ol', { class: 'top-list' }, s.top.map((h) => el('li', null,
        el('a', { href: siteUrl(h.path), target: '_blank', rel: 'noopener' }, el('span', { class: 'clamp2', text: cleanTitle(h.title) || dec(h.path) })),
        el('b', { class: 'num', text: h.n.toLocaleString('he-IL') })))) : el('p', { class: 'muted', text: 'עוד אין צפיות השבוע.' })),
    el('section', { class: 'panel links' },
      ext(GC, 'הלוח המלא ב-GoatCounter', 'מקורות תנועה, מדינות, דפדפנים'),
      ext('https://dash.cloudflare.com/?to=/:account/web-analytics', 'Cloudflare Web Analytics', 'מדידה שנייה של הכניסות')));
  return page;
}
const cleanTitle = (t) => str(t).replace(/\s*[|–-]\s*מולטיוורס\s*$/, '');

function topListPanel() {
  const t = S.top;
  if (!t || !t.posts || !t.posts.length) return null;
  return el('section', { class: 'panel' },
    el('h2', { text: 'הנצפים ביותר ב-30 הימים האחרונים' }),
    el('p', { class: 'muted', text: `הרשימה שבסרגל הצד באתר, מתעדכנת כל לילה${t.updated ? ` (עודכנה ב-${dayMonth(parseLocal(t.updated))})` : ''}.` }),
    el('ol', { class: 'top-list' }, t.posts.slice(0, 10).map((u) => {
      const p = S.posts.find((x) => x.url === u || dec(x.url) === dec(u));
      const fallback = dec(u).replace(/^\/\d{4}\/\d\d\/\d\d\//, '').replace(/\/$/, '').replace(/-/g, ' ');
      return el('li', null, el('a', { href: siteUrl(u), target: '_blank', rel: 'noopener' }, el('span', { class: 'clamp2', text: p ? p.title : fallback })));
    })));
}

// ------------------------------------------------------------------ views: more (every other service)
function moreView() {
  const group = (title, ...rows) => el('section', { class: 'panel links' }, el('h2', { text: title }), rows);
  const installBlock = isStandalone() ? null : group('התקנה במסך הבית',
    S.installEvt ? el('button', { class: 'btn primary wide', onclick: async () => { S.installEvt.prompt(); S.installEvt = null; paint(); } }, icon('plus'), 'הוספה למסך הבית') : null,
    el('p', { class: 'muted', text: 'באייפון: בספארי לוחצים על כפתור השיתוף ואז "הוספה למסך הבית". באנדרואיד: בכרום פותחים את התפריט ⋮ ובוחרים "הוספה למסך הבית" או "התקנת האפליקציה". הסמל יהיה הלוגו של מולטיוורס.' }));
  return el('div', { class: 'page' },
    el('div', { class: 'page-head' }, el('h1', { text: 'כלים' })),
    installBlock,
    group('פעולות מהירות',
      el('button', { class: 'link-row', disabled: S.busy.has('rebuild'), onclick: () => busy('rebuild', rebuildSite) },
        el('span', { class: 'link-text' }, el('b', { text: 'בנייה מחדש של האתר' }), el('small', { text: 'כשמשהו לא התעדכן באתר. לוקח כ-3 דקות.' })), icon('refresh')),
      el('button', { class: 'link-row', disabled: S.busy.has('top'), onclick: () => busy('top', refreshTopPosts) },
        el('span', { class: 'link-text' }, el('b', { text: 'עדכון "הנצפים ביותר" עכשיו' }), el('small', { text: 'בדרך כלל זה קורה לבד כל לילה' })), icon('bolt')),
      el('a', { class: 'link-row', href: '#new' }, el('span', { class: 'link-text' }, el('b', { text: 'פוסט חדש מהטלפון' }), el('small', { text: 'כותרת, תמונה, טקסט ופרסום' })), icon('plus'))),
    group('עריכה ב-Pages CMS',
      ext(`${CMS}/collection/posts`, 'כל הפוסטים', 'עריכה מלאה עם עורך טקסט עשיר'),
      ext(`${CMS}/collection/posts/new`, 'פוסט חדש בעורך המלא'),
      ext(`${CMS}/collection/pages`, 'עמודים', 'אודות, גיקאאוט'),
      ext(`${CMS}/media/images`, 'תמונות', 'העלאה וניהול של כל התמונות'),
      ext(`${CMS}/file/authors`, 'כותבים'),
      ext(`${CMS}/file/categories`, 'קטגוריות'),
      ext(`${CMS}/file/settings`, 'הגדרות האתר', 'שם, באנר, תפריט, סרגל הצד'),
      ext(`${CMS}/collaborators`, 'עורכים נוספים', 'הזמנה במייל, בלי חשבון GitHub')),
    group('האתר',
      ext(SITE, 'multiversesite.com'),
      ext(`${SITE}/search/`, 'חיפוש באתר'),
      ext(`${SITE}/feed/`, 'פיד RSS', 'ממנו יוצא הניוזלטר')),
    group('פייסבוק והסוכן',
      ext(FB_GROUP, 'קבוצת אולם ומלואו'),
      ext(FB_PAGE, 'עמוד מולטיוורס בפייסבוק'),
      ext(AGENT_URL, 'הסוכן ב-Claude', 'הרצות, הפעלה ועצירה')),
    group('ניוזלטר ושירותים',
      ext('https://app.brevo.com/', 'Brevo', 'נרשמים לניוזלטר ומיילים'),
      ext(GC, 'GoatCounter', 'סטטיסטיקות'),
      ext('https://dash.cloudflare.com/', 'Cloudflare', 'שירות התגובות ו-Web Analytics'),
      ext('https://wordpress.com/domains/manage', 'WordPress.com', 'הדומיין multiversesite.com'),
      ext(`https://github.com/${OWNER}/${REPO}`, 'GitHub', 'המאגר של האתר'),
      ext(`https://github.com/${OWNER}/${REPO}/actions`, 'GitHub Actions', 'כל הבניות וההרצות האוטומטיות')),
    group('האפליקציה',
      el('p', { class: 'muted', text: S.me && S.me.email ? `נכנסת בתור ${S.me.email}.` : 'נכנסת עם קוד למייל.' }),
      el('button', { class: 'link-row', onclick: () => {
        const v = prompt('השם שיופיע ליד השינויים שתעשה באתר:', S.name);
        if (v == null) return;
        S.name = v.trim() || (S.me ? str(S.me.email).replace(/@.*$/, '') : '');
        store.set('myName', S.name);
        paint();
      } }, el('span', { class: 'link-text' }, el('b', { text: `השם בשינויים: ${S.name || '—'}` }), el('small', { text: 'נרשם ליד כל שינוי שנעשה מהאפליקציה' })), icon('edit')),
      el('a', { class: 'link-row', href: '/cdn-cgi/access/logout' },
        el('span', { class: 'link-text' }, el('b', { text: 'יציאה' }), el('small', { text: 'בכניסה הבאה יישלח קוד חדש למייל' })), icon('close')),
      ext('https://one.dash.cloudflare.com/', 'מי יכול להיכנס', 'Cloudflare Zero Trust: כתובות המייל המורשות')));
}

// ------------------------------------------------------------------ sign-in and one-time setup screens
const CF_WORKERS = 'https://dash.cloudflare.com/?to=/:account/workers-and-pages';
const CF_ZT = 'https://one.dash.cloudflare.com/';
const link = (href, text) => el('a', { href, target: '_blank', rel: 'noopener', text });
const ui = (text) => el('bdi', { class: 'ui', dir: 'ltr', text });              // a label on a Cloudflare/GitHub screen
const pathOf = (...labels) => el('span', { class: 'ui-path' }, labels.map((t, k) => (k ? [el('span', { class: 'arr', text: ' ← ' }), ui(t)] : ui(t))));

function blockView() {
  const kind = S.block;
  const again = el('button', { class: 'btn ink wide', onclick: () => location.reload() }, kind === 'signin' ? 'כניסה' : 'בדיקה שוב');
  const cover = el('div', { class: 'setup-cover' },
    el('img', { src: 'icons/icon-192.png', alt: 'מולטיוורס', width: 88, height: 88 }),
    el('h1', { text: 'ניהול מולטיוורס' }),
    el('p', { text: 'תגובות, טיוטות, פרסום, הסוכן מפייסבוק והצפיות. הכול במקום אחד, בלי לחפש בין אתרים.' }));
  if (kind === 'signin') {
    return el('div', { class: 'setup' }, cover, el('section', { class: 'panel setup-card' },
      el('h2', { text: 'צריך להתחבר' }),
      el('p', { text: 'הכניסה לאפליקציה פגה. בלחיצה על הכפתור ייפתח מסך הכניסה, ושם מקבלים קוד למייל.' }), again));
  }
  const accessDone = kind !== 'no_access';
  const tokenDone = !['no_access', 'no_github_token', 'github_token_bad'].includes(kind);
  const step = (n, title, done, current, body) => el('section', { class: `panel setup-card${done ? ' done' : ''}` },
    el('h2', null, `${n}. ${title}`, done ? el('span', { class: 'step-ok' }, icon('check'), 'בוצע') : null),
    current ? body : null);
  const accessSteps = el('ol', { class: 'steps' },
    el('li', null, 'פותחים את ', link(CF_ZT, 'Cloudflare Zero Trust'), '. בפעם הראשונה בוחרים שם לצוות ואת התוכנית החינמית ', ui('Free'), '.'),
    el('li', null, 'יוצרים את רשימת המורשים: ', pathOf('Access controls', 'Policies', 'Add a policy'),
      el('ul', { class: 'fields' },
        el('li', null, ui('Policy name'), ' צוות מולטיוורס'),
        el('li', null, ui('Action'), ' ', ui('Allow')),
        el('li', null, pathOf('Include', 'Emails'), ' כתובות המייל של מי שמותר לו להיכנס, שלך ושל העוזרים'),
        el('li', null, ui('Session duration'), ' חודש'))),
    el('li', null, 'ב-', link(CF_WORKERS, 'Workers & Pages'), ': ', pathOf('multiverse-manage', 'Access', 'Protect this Worker behind Access'),
      '. בוחרים ', ui('All traffic'), ' ואת "צוות מולטיוורס", ולוחצים ', ui('Apply Access'), '.'),
    el('li', { text: 'חוזרים לכאן ולוחצים "בדיקה שוב". ייפתח מסך כניסה שבו מקבלים קוד למייל.' }));
  const tokenSteps = el('ol', { class: 'steps' },
    el('li', null, el('a', { class: 'btn primary small', href: TOKEN_URL, target: '_blank', rel: 'noopener' }, icon('external'), 'יצירת מפתח ב-GitHub'),
      el('span', { class: 'step-note', text: 'השם וההרשאות כבר ממולאים.' })),
    el('li', null, 'תחת ', ui('Repository access'), ' בוחרים ', pathOf('Only select repositories', 'multiversesite'), ', לוחצים ', ui('Generate token'), ' ומעתיקים את המפתח.'),
    el('li', null, 'ב-', link(CF_WORKERS, 'Workers & Pages'), ': ', pathOf('multiverse-manage', 'Settings', 'Variables and Secrets', 'Add'),
      el('ul', { class: 'fields' },
        el('li', null, ui('Type'), ' ', ui('Secret')),
        el('li', null, ui('Variable name'), ' ', ui('GITHUB_TOKEN')),
        el('li', null, ui('Value'), ' המפתח שהעתקתם'),
        el('li', null, 'ושומרים עם ', ui('Deploy')))),
    el('li', { text: 'חוזרים לכאן ולוחצים "בדיקה שוב".' }));
  const parts = [cover];
  if (kind === 'access_needs_config') {
    parts.push(el('section', { class: 'panel setup-card' },
      el('h2', { text: 'עוד שתי הגדרות לכניסה' }),
      el('p', { class: 'muted', text: 'הכניסה עם מייל פועלת, אבל השרת של האפליקציה צריך לדעת לזהות אותה.' }),
      el('ol', { class: 'steps' },
        el('li', null, 'ב-', link(CF_ZT, 'Zero Trust'), ': ', pathOf('Access controls', 'Applications', 'multiverse-manage'), ' ומעתיקים את ', ui('Application Audience (AUD) Tag'), '.'),
        el('li', null, 'ב-Zero Trust ', pathOf('Settings'), ' מעתיקים את ', ui('Team domain'), ' (משהו כמו ', ui('name.cloudflareaccess.com'), ').'),
        el('li', null, 'ב-', link(CF_WORKERS, 'Workers & Pages'), ': ', pathOf('multiverse-manage', 'Settings', 'Variables and Secrets'),
          ' מוסיפים שני סודות מסוג ', ui('Secret'), ': ', ui('ACCESS_AUD'), ' ו-', ui('ACCESS_TEAM_DOMAIN'), '.')),
      again));
  } else {
    parts.push(
      el('p', { class: 'setup-lead', text: kind === 'github_token_bad' ? BLOCKS.github_token_bad : 'הגדרה של פעם אחת ב-Cloudflare, ואחריה כל מי שברשימה נכנס עם קוד למייל, בלי מפתחות בטלפון.' }),
      step(1, 'כניסה עם מייל', accessDone, !accessDone, accessSteps),
      step(2, 'המפתח של GitHub', tokenDone, accessDone && !tokenDone, tokenSteps),
      again);
  }
  if (!isStandalone()) {
    parts.push(el('section', { class: 'panel setup-card' },
      el('h2', { text: 'הוספה למסך הבית' }),
      el('p', { class: 'muted', text: 'באייפון: בספארי לוחצים על כפתור השיתוף ואז "הוספה למסך הבית". באנדרואיד: בכרום פותחים את התפריט ⋮ ובוחרים "הוספה למסך הבית". הסמל יהיה הלוגו של מולטיוורס.' })));
  }
  return el('div', { class: 'setup' }, parts);
}

// ------------------------------------------------------------------ new post
const EMBED_HOST = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com|vimeo\.com|dailymotion\.com|dai\.ly|twitter\.com|x\.com|instagram\.com|instagr\.am|facebook\.com|fb\.watch|spotify\.com|soundcloud\.com|videopress\.com|giphy\.com)$/i;
function linkify(line) {
  return esc(line).replace(/https?:\/\/[^\s<>"']+/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
}
function toHtml(text) {
  return text.replace(/\r\n?/g, '\n').trim().split(/\n\s*\n/).map((para) => {
    const lines = para.split('\n').map((l) => l.trim()).filter(Boolean);
    return '<p>' + lines.map((l) => {
      if (/^https?:\/\/\S+$/.test(l)) {
        let host = '';
        try { host = new URL(l).hostname.replace(/^(www|m)\./, ''); } catch { /* not a url */ }
        if (EMBED_HOST.test(host) || /\.(mp3|mp4|m4a|ogg|wav|webm)(\?|$)/i.test(l)) return esc(l);   // the site shows it as a player
      }
      return linkify(l);
    }).join('<br />\n') + '</p>';
  }).join('\n');
}

async function prepareImage(file) {
  if (file.type === 'image/gif') return { bytes: new Uint8Array(await file.arrayBuffer()), ext: 'gif' };
  let src;
  try { src = await createImageBitmap(file); } catch {
    src = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('לא הצלחתי לקרוא את התמונה.')); im.src = URL.createObjectURL(file); });
  }
  const scale = Math.min(1, 1600 / src.width);
  const c = document.createElement('canvas');
  c.width = Math.round(src.width * scale);
  c.height = Math.round(src.height * scale);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  const toBlob = (type, q) => new Promise((r) => c.toBlob(r, type, q));
  let out = await toBlob('image/webp', 0.84);
  let ext = 'webp';
  if (!out || out.type !== 'image/webp') { out = await toBlob('image/jpeg', 0.86); ext = 'jpg'; }
  return { bytes: new Uint8Array(await out.arrayBuffer()), ext };
}

function openComposer() {
  const saved = store.get('composer', {});
  const st = {
    title: saved.title || '', body: saved.body || '', excerpt: saved.excerpt || '', tags: saved.tags || '', slug: saved.slug || '',
    author: saved.author || store.get('lastAuthor', 'idanb'), cats: saved.cats || [], file: null, preview: '',
  };
  const save = () => store.set('composer', { title: st.title, body: st.body, excerpt: st.excerpt, tags: st.tags, slug: st.slug, author: st.author, cats: st.cats });
  const authors = S.authors.filter((a) => a.active !== false).map((a) => ({ value: str(a.slug) || slugify(a.name), label: str(a.name) }));
  if (!authors.some((a) => a.value === st.author) && authors.length) st.author = authors.some((a) => a.value === 'idanb') ? 'idanb' : authors[0].value;
  const cats = S.categories.filter((c) => c.active !== false).map((c) => ({ value: str(c.slug) || slugify(c.name), label: str(c.name), child: !!str(c.parent) }));

  const grow = (t) => { t.style.height = 'auto'; t.style.height = `${t.scrollHeight + 4}px`; };
  const title = el('textarea', { class: 'field title-field', rows: 1, placeholder: 'כותרת', 'aria-label': 'כותרת', enterkeyhint: 'next', oninput: (e) => { st.title = e.target.value.replace(/\n/g, ' '); if (e.target.value !== st.title) e.target.value = st.title; grow(e.target); save(); } });
  title.value = st.title;
  const body = el('textarea', { class: 'field body-field', rows: 10, 'aria-label': 'תוכן',
    placeholder: 'הטקסט של הפוסט. שורה ריקה מתחילה פסקה חדשה. קישור ליוטיוב, לפייסבוק או ל-X בשורה נפרדת יוצג באתר כנגן.',
    oninput: (e) => { st.body = e.target.value; grow(e.target); save(); } });
  body.value = st.body;
  const fileInput = el('input', { type: 'file', accept: 'image/*', hidden: true, onchange: (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    st.file = f;
    if (st.preview) URL.revokeObjectURL(st.preview);
    st.preview = URL.createObjectURL(f);
    paintImage();
  } });
  const imageBox = el('div', { class: 'image-pick' });
  function paintImage() {
    imageBox.replaceChildren(st.file
      ? el('div', { class: 'image-chosen' }, el('img', { src: st.preview, alt: '' }),
        el('button', { class: 'icon-btn on-image', 'aria-label': 'הסרת התמונה', onclick: () => { st.file = null; fileInput.value = ''; paintImage(); } }, icon('close')))
      : el('button', { class: 'image-empty', onclick: () => fileInput.click() }, icon('image'), el('span', { text: 'תמונה ראשית' }), el('small', { text: 'מהגלריה או מהמצלמה' })));
  }
  paintImage();
  const authorSel = el('select', { class: 'field', 'aria-label': 'כותב', onchange: (e) => { st.author = e.target.value; save(); } },
    authors.map((a) => el('option', { value: a.value, selected: a.value === st.author ? true : null, text: a.label })));
  const chips = el('div', { class: 'chips' }, cats.map((c) => el('button', {
    class: `chip${st.cats.includes(c.value) ? ' on' : ''}${c.child ? ' child' : ''}`, type: 'button', 'aria-pressed': st.cats.includes(c.value) ? 'true' : 'false',
    onclick: (e) => {
      st.cats = st.cats.includes(c.value) ? st.cats.filter((x) => x !== c.value) : [...st.cats, c.value];
      e.currentTarget.classList.toggle('on');
      e.currentTarget.setAttribute('aria-pressed', st.cats.includes(c.value) ? 'true' : 'false');
      save();
    },
  }, c.label)));
  const excerpt = el('textarea', { class: 'field', rows: 2, placeholder: 'תקציר לכרטיס בדף הבית (לא חובה)', oninput: (e) => { st.excerpt = e.target.value; save(); } });
  excerpt.value = st.excerpt;
  const tags = el('input', { class: 'field', placeholder: 'תגיות, מופרדות בפסיק', oninput: (e) => { st.tags = e.target.value; save(); } });
  tags.value = st.tags;
  const slug = el('input', { class: 'field', dir: 'ltr', placeholder: 'dune-part-three-review', oninput: (e) => { st.slug = e.target.value; save(); } });
  slug.value = st.slug;
  const status = el('p', { class: 'compose-status', role: 'status' });
  const draftBtn = el('button', { class: 'btn ghost', onclick: () => submit(false) }, 'שמירה כטיוטה');
  const pubBtn = el('button', { class: 'btn primary', onclick: () => submit(true) }, icon('send'), 'פרסום');

  async function submit(publish) {
    st.title = title.value.trim();
    if (!st.title) { title.focus(); toast('צריך כותרת.', 'bad'); return; }
    if (publish && !body.value.trim()) { body.focus(); toast('אין עדיין טקסט לפרסם.', 'bad'); return; }
    if (publish && !(await confirmSheet({ title: 'לפרסם עכשיו?', text: 'הפוסט יעלה לאתר בעוד כ-3 דקות, ומשם גם לניוזלטר.', ok: 'פרסום' }))) return;
    draftBtn.disabled = pubBtn.disabled = true;
    try {
      const t = israelNow();
      const file = `${t.Y}-${t.M}-${t.D}-${t.h}${t.m}${t.s}.html`;
      const path = publish ? `content/posts/${t.Y}/${file}` : `content/posts/${file}`;
      const changes = [];
      let image = '';
      if (st.file) {
        status.textContent = 'מכין את התמונה…';
        const img = await prepareImage(st.file);
        const base = (st.file.name || '').replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'post';
        const name = `${base}-${t.h}${t.m}${t.s}.${img.ext}`;
        changes.push({ path: `static/wp-content/uploads/${t.Y}/${t.M}/${name}`, bytes: img.bytes });
        image = `/wp-content/uploads/${t.Y}/${t.M}/${name}`;
      }
      const q = (s) => JSON.stringify(s);
      const tagList = st.tags.split(/[,\n،]/).map((x) => x.trim()).filter(Boolean);
      const fm = [
        `draft: ${publish ? 'false' : 'true'}`,
        `title: ${q(st.title)}`,
        st.slug.trim() ? `slug: ${q(st.slug.trim())}` : null,
        `date: '${t.Y}-${t.M}-${t.D} ${t.h}:${t.m}:${t.s}'`,
        `author: ${q(st.author)}`,
        st.cats.length ? `categories:\n${st.cats.map((c) => `  - ${q(c)}`).join('\n')}` : 'categories: []',
        tagList.length ? `tags:\n${tagList.map((x) => `  - ${q(x)}`).join('\n')}` : 'tags: []',
        image ? `image: ${image}` : null,
        st.excerpt.trim() ? `excerpt: ${q(st.excerpt.trim())}` : null,
      ].filter(Boolean).join('\n');
      const text = `---\n${fm}\n---\n${toHtml(body.value)}\n`;
      changes.unshift({ path, text });
      status.textContent = 'שומר באתר…';
      await commitFiles(`${publish ? 'פוסט חדש' : 'טיוטה חדשה'}: ${st.title.slice(0, 80)} ${byApp()}`, async () => changes);
      store.del('composer');
      store.set('lastAuthor', st.author);
      const post = { ...parsePost(text), path, file, when: parseLocal(`${t.Y}-${t.M}-${t.D} ${t.h}:${t.m}`), pendingPublish: publish };
      post.url = postUrl(post, file);
      S.posts.unshift(post);
      close();
      toast(publish ? 'הפוסט פורסם. הוא יופיע באתר בעוד כ-3 דקות.' : 'הטיוטה נשמרה. אפשר לפרסם אותה מכאן או להמשיך לערוך ב-Pages CMS.');
      if (publish) { S.watchUntil = Date.now() + 180e3; setTimeout(() => { refreshRuns(); watchRuns(); }, 4000); }
      S.postsMode = publish ? 'recent' : 'drafts';
      location.hash = '#posts';
      paint();
    } catch (e) {
      status.textContent = '';
      toast(e.message || String(e), 'bad');
      draftBtn.disabled = pubBtn.disabled = false;
    }
  }

  const close = openSheet(el('div', { class: 'composer' },
    el('div', { class: 'composer-bar' },
      el('button', { class: 'icon-btn', 'aria-label': 'סגירה', onclick: () => close() }, icon('close')),
      el('h3', { text: 'פוסט חדש' }),
      el('span', { class: 'saved-note', text: 'הטקסט נשמר בטלפון בזמן הכתיבה' })),
    el('div', { class: 'composer-body' },
      title, imageBox, fileInput,
      el('label', { class: 'lbl' }, 'כותב', authorSel),
      el('div', { class: 'lbl' }, 'קטגוריות', chips),
      body,
      el('details', { class: 'more-opts' }, el('summary', { text: 'אפשרויות נוספות' }),
        el('label', { class: 'lbl' }, 'תקציר', excerpt),
        el('label', { class: 'lbl' }, 'תגיות', tags),
        el('label', { class: 'lbl' }, 'כתובת קצרה באנגלית (לא חובה)', slug))),
    el('div', { class: 'composer-foot' }, status, el('div', { class: 'row-actions' }, pubBtn, draftBtn))), {
    full: true, onClose: () => { if (location.hash === '#new') history.replaceState(null, '', `#${S.tab}`); },
  });
  setTimeout(() => { grow(title); grow(body); if (!st.title) title.focus(); }, 250);
}

// ------------------------------------------------------------------ routing and start
function route() {
  const h = location.hash.replace('#', '');
  if (h === 'new') {
    if (!S.block && S.loaded) openComposer();
    else S.pendingNew = true;
    return;
  }
  const tab = TABS.some(([id]) => id === h) ? h : 'home';
  if (tab !== S.tab) { S.tab = tab; render(); window.scrollTo(0, 0); }
  if (tab === 'stats' && statsReady() && !S.stats && !S.statsLoading) loadStats();
}

window.addEventListener('hashchange', route);
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.installEvt = e; paintIf('more'); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (!S.block && Date.now() - S.loadedAt > 60e3) load({ quiet: true }); else watchRuns();
});

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

(async function start() {
  const h = location.hash.replace('#', '');
  S.tab = TABS.some(([id]) => id === h) ? h : 'home';
  render();
  await load();
  if (h === 'new' || S.pendingNew) { S.pendingNew = false; if (S.loaded) openComposer(); }
})();
