// Run on the post page (javascript_tool) AFTER extract_post.js. Downloads the post's images inside
// the browser and returns them as base64 between MVIMG markers. The result is deliberately large, so
// the tool saves it to a file and tells you the path; then run:
//   python3 tools/fb/save_images.py <that file> /tmp/fbimg/<post id>
(async () => {
  const dialogs = [...document.querySelectorAll('[role="dialog"]')].sort((a, b) => b.innerText.length - a.innerText.length);
  const root = dialogs[0] || document.querySelector('[role="main"]') || document;
  const urls = [...new Set([...root.querySelectorAll('img')]
    .filter(i => i.naturalWidth >= 300 && /fbcdn\.net/.test(i.src) && !i.closest('[role="article"] [role="article"]'))
    .filter(i => !i.closest('ul, [aria-label*="omment"], [aria-label*="תגוב"]'))
    .map(i => i.src))].slice(0, 6);
  let out = '';
  for (let n = 0; n < urls.length; n++) {
    try {
      const blob = await fetch(urls[n]).then(r => r.blob());
      const data = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
      out += `MVIMG:${n + 1}:${data}:END\n`;
    } catch (e) { out += `MVERR:${n + 1}:${e}\n`; }
  }
  return `images found: ${urls.length}\n` + out + '#'.repeat(130000);
})()
