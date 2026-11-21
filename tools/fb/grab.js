// Run once on the group feed (javascript_tool). Installs window.__grab(), which records every post
// currently on screen. Call window.__grab() again after each real mouse-wheel scroll.
window.__seen = window.__seen || new Map();
window.__grab = () => {
  document.querySelectorAll('a[href*="post_insights/"], a[href*="/posts/"], a[href*="/permalink/"]').forEach(a => {
    const m = (a.getAttribute('href') || '').match(/(?:post_insights|posts|permalink)\/(\d{10,})/);
    if (!m || window.__seen.has(m[1])) return;
    const box = a.closest('[aria-posinset]') || a.closest('[role="article"]');
    if (!box) return;
    const u = [...box.querySelectorAll('a[href*="/user/"]')].find(x => (x.innerText || x.getAttribute('aria-label') || '').trim());
    const msg = box.querySelector('[data-ad-rendering-role="story_message"], [data-ad-preview="message"], [data-ad-comet-preview="message"]');
    // links to the site (straight or through Facebook's l.php redirect) and the post's own text with
    // its link-preview card, so tools/fb/find_shared.js can tell whether a site post was already shared
    const site = [...box.querySelectorAll('a[href]')].map(x => {
      let h = x.getAttribute('href') || '';
      const r = h.match(/[?&]u=([^&]+)/);
      if (/l\.facebook\.com\/l\.php/.test(h) && r) { try { h = decodeURIComponent(r[1]); } catch (e) {} }
      const s = h.match(/multiversesite\.com(\/[^?#\s]*)/i);
      return s ? decodeURI(s[1]) : null;
    }).filter(Boolean);
    const text = (box.innerText || '').replace(/\S\u034f\s?/g, '')      // Facebook's scrambled filler letters
      .replace(/(Facebook\s*)+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1500);
    window.__seen.set(m[1], { id: m[1], author: u ? (u.innerText || u.getAttribute('aria-label')).trim() : '',
                              preview: msg ? msg.innerText.slice(0, 80) : '', site: [...new Set(site)], text });
  });
  return [...window.__seen.values()].map(({ text, ...rest }) => rest);
};
window.__grab();
