// Run in the built-in browser on https://www.facebook.com/groups/<group>/posts/<id>/ (javascript_tool).
// Returns {author, text, images} for the post itself (not the comments).
(async () => {
  await new Promise(r => setTimeout(r, 1500));
  const dialogs = [...document.querySelectorAll('[role="dialog"]')].sort((a, b) => b.innerText.length - a.innerText.length);
  const root = dialogs[0] || document.querySelector('[role="main"]') || document;
  const pick = () => [...root.querySelectorAll('[data-ad-rendering-role="story_message"], [data-ad-preview="message"], [data-ad-comet-preview="message"]')]
    .find(m => !m.closest('[role="article"]') || m.closest('[role="article"]') === root.querySelector('[role="article"]'));
  let msg = pick();
  const more = msg && [...msg.querySelectorAll('[role="button"]')].find(b => /^(See more|ראה עוד|הצג עוד)$/.test(b.innerText.trim()));
  if (more) { more.click(); await new Promise(r => setTimeout(r, 1200)); msg = pick(); }
  const userLink = [...root.querySelectorAll('a[href*="/user/"]')].find(x => (x.innerText || '').trim());
  const images = [...root.querySelectorAll('img')]
    .filter(i => i.naturalWidth >= 300 && /fbcdn\.net/.test(i.src) && !i.closest('[role="article"] [role="article"]'))
    .filter(i => !i.closest('ul, [aria-label*="omment"], [aria-label*="תגוב"]'))
    .map(i => i.src);
  const moreImages = [...root.querySelectorAll('div')].some(d => /^\+\d+$/.test((d.innerText || '').trim()));
  return {
    author: userLink ? userLink.innerText.trim() : null,
    text: msg ? msg.innerText.replace(/\n?(See less|ראה פחות)\s*$/,'').trim() : null,
    images: [...new Set(images)].slice(0, 8),
    more_images_hidden: moreImages,
    url: location.href.split('?')[0]
  };
})()
