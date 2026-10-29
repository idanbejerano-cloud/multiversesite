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
    window.__seen.set(m[1], { id: m[1], author: u ? (u.innerText || u.getAttribute('aria-label')).trim() : '',
                              preview: msg ? msg.innerText.slice(0, 80) : '' });
  });
  return [...window.__seen.values()];
};
window.__grab();
