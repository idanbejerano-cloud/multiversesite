// Run on the group feed after grab.js (javascript_tool), then call
//   window.__findShared(<the JSON printed by `python3 tools/fb/site_to_group.py list`>)
// It answers which of those site posts already appear in a group post collected by window.__grab()
// (shared by hand, by the management app's "לקבוצה" button, or by an earlier run): a link to the
// post's address, or the post's title in the text or in the link-preview card.
window.__findShared = (cands) => {
  const norm = (s) => String(s || '').replace(/[׳'’`]/g, "'").replace(/[״"“”״]/g, '"').replace(/\s+/g, ' ').trim();
  const posts = [...(window.__seen || new Map()).values()];
  const found = [];
  for (const c of cands || []) {
    const path = decodeURI(new URL(c.url).pathname);
    const title = norm(c.title);
    const key = title.length > 28 ? title.slice(0, 28) : title;
    const hit = posts.find(p => (p.site || []).some(s => s.replace(/\/?$/, '/') === path.replace(/\/?$/, '/'))
      || (key.length >= 8 && norm(p.text).includes(key)));
    if (hit) found.push({ id: c.id, title: c.title, facebook_url: `https://www.facebook.com/groups/ulammale/posts/${hit.id}/` });
  }
  return found;
};
