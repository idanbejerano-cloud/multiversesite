# Facebook group → מולטיוורס: instructions for the scheduled agent

Goal: copy new posts written by the authors listed in `data/facebook.json` in the Facebook group
"אולם ומלואו" into the site, then publish. **Only read Facebook. Never post, comment, react, share,
accept, invite or change anything there.**

## 0. Repository
- Attach `idanbejerano-cloud/multiversesite` with push access (add_repo) if it isn't attached,
  clone it to `/home/claude/multiversesite`, then `git pull`. Work from that folder.
- Read `data/facebook.json` (authors, `after_id`, feed URL) and `data/facebook_seen.json`.

## 1. Collect the newest posts (built-in browser, `mcp__remote-devices__Claude_Browser__*`)
1. Open `feed_url` (`?sorting_setting=CHRONOLOGICAL`). If you see a log-in form, stop and tell
   the owner that Facebook must be logged in again in the Claude app browser.
2. Run the contents of `tools/fb/grab.js` with javascript_tool. It returns the posts on screen.
3. Repeat up to 15 times: `computer` scroll down 5 ticks over the feed (a real wheel scroll —
   `window.scrollTo` does not load more posts), then run `window.__grab()`.
   Stop early once the list contains a post whose numeric id is `<= after_id`.
4. Candidates = posts whose `author` equals an author's `facebook_name` or one of its `aliases`,
   whose id is numerically greater than `after_id`, and which aren't in `facebook_seen.json`.
5. Remember the largest post id you saw (any author) — it becomes the new `after_id` at the end.

## 2. Each candidate
1. Open `https://www.facebook.com/groups/ulammale/posts/<id>/` and run `tools/fb/extract_post.js`.
   It returns `{author, text, images, more_images_hidden}` for the post itself.
2. Decide whether it belongs on the site. Keep the author's own writing about movies, TV, comics,
   games or pop culture (reviews, news, opinion pieces, lists, recommendations, trailers with real
   commentary). Skip: off-topic posts, group housekeeping (welcoming new members, rules, polls about
   the group), job ads, a bare share or link with fewer than ~2 sentences of the author's own text,
   and scheduled posts that aren't published yet ("in 18 hours" etc.).
   For a skipped post run `python3 tools/add_post.py --skip "<short reason>" <id>`.
3. Images (up to 6): `curl -sL -o /tmp/fbimg/<id>-<n>.jpg "<url>"` for each URL from step 1.
   If the download fails (the fbcdn.net domain may be blocked for this environment), continue
   without images — never invent or substitute images.
4. Categories — slugs from `data/categories.json`:
   movie review → `["ביקורות-קולנוע", "קולנוע"]`, movie news/trailer → `["חדשות-קולנוע", "קולנוע"]`,
   TV review → `["ביקורות-טלוויזיה", "טלוויזיה"]`, TV news → `["חדשות-טלוויזיה", "טלוויזיה"]`,
   comics review → `["ביקורות-קומיקס", "קומיקס"]`, comics news → `["חדשות-קומיקס", "קומיקס"]`,
   otherwise `["כללי"]`.
5. Write `/tmp/fbpost-<id>.json`:
   ```json
   {"fb_id": "<id>", "fb_url": "https://www.facebook.com/groups/ulammale/posts/<id>/",
    "author": "<author as shown on Facebook>", "date": "<now, Israel time, YYYY-MM-DD HH:MM:SS>",
    "text": "<the post text exactly as returned, line breaks kept>",
    "images": ["/tmp/fbimg/<id>-1.jpg", "..."], "categories": ["..."]}
   ```
   The first line of the text becomes the title. Only if that first line is longer than 90
   characters, also add `"title"`: a short title (≤ 80 characters) taken from the post's own words.
   Do not rewrite, translate, summarise or add to the author's text.
6. `python3 tools/add_post.py /tmp/fbpost-<id>.json` — prints the new URL or `SKIP <reason>`.

## 3. Publish
1. Set `after_id` in `data/facebook.json` to the largest id from step 1.5 (only if it is larger).
2. `python3 build.py` to make sure the site still builds (it should print "Built …").
3. `git add -A && git commit -m "Add <n> posts from the Facebook group"` (include the
   attribution lines the session asks for), then `git push`. GitHub rebuilds the site automatically.
4. Report in one or two lines: titles and addresses of the posts added, and what was skipped and why.
   If nothing new was found, say so briefly.
