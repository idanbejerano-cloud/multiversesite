# מולטיוורס – multiversesite.com

האתר הסטטי של מולטיוורס: כל הפוסטים, התגובות והתמונות מהאתר המקורי בוורדפרס,
בעיצוב של האתר המקורי (Twenty Fourteen בצבעי האתר).

## איך זה עובד
- `content/posts/` – פוסט אחד לכל קובץ (כותרת, תאריך, קטגוריות ותגיות בראש הקובץ, ואחריהם ה-HTML).
- `content/pages/` – העמודים (אודות, גיקאאוט).
- `content/comments/` – התגובות הקיימות.
- `static/wp-content/uploads/` – התמונות.
- `site.yml` – שם האתר, התפריט, הרשומות הנצפות בסרגל הצד.
- `build.py` – בונה את האתר לתיקייה `_site/`.

כל שינוי שנדחף ל-`main` נבנה ומתפרסם אוטומטית ב-GitHub Pages (`.github/workflows/deploy.yml`).

## אפליקציית הניהול לטלפון
`manage/` – אפליקציה למסך הבית (עם הלוגו) שמרכזת את כל הניהול: תגובות, טיוטות ופרסום, פוסט חדש עם תמונה,
מצב האתר, הסוכן מפייסבוק, צפיות וקישורים לכל השירותים. כתובת: https://multiverse-manage.multiversesite.workers.dev/
(גם `multiversesite.com/manage/` מעביר אליה). פרטים ב-`manage/README.md`.

## עריכה בממשק חזותי (Pages CMS)
נכנסים ל-https://app.pagescms.org עם חשבון ה-GitHub, בוחרים את המאגר `multiversesite`, ושם יש "פוסטים" ו"עמודים":
כותרת, תאריך, כותב, קטגוריות, תגיות, תמונה ראשית ועורך טקסט. שמירה מעדכנת את האתר תוך כמה דקות.
סרטון/ציוץ/פוסט פייסבוק: מדביקים את הקישור לבד בשורה, והאתר מציג אותו כנגן.
ב"הגדרות האתר" אפשר לשנות את שם האתר, תמונת הראש, התפריט, סרגל הצד (וידג'טים לפי הסדר) והפוסטים ב"הנצפים ביותר".
עורכים נוספים: מזמינים אותם במייל מתוך Pages CMS (לא צריך חשבון GitHub).
ההגדרות של הממשק נמצאות בקובץ `.pages.yml`.

### טיוטות ופרסום
- פוסט חדש נשמר עם `draft: true`: Save שומר אותו בלי שיופיע באתר (build.py מדלג על טיוטות).
- הכפתור "פרסום" בראש עמוד הפוסט מפעיל את `.github/workflows/publish.yml` (`tools/publish_post.py`):
  `draft: false`, תאריך ושעה של עכשיו בפרסום ראשון, העברה לתיקיית השנה ב-`content/posts/<שנה>/`, ובנייה של האתר.
  "החזרה לטיוטה" מחזיר `draft: true` ומוריד את הפוסט מהאתר.
- כל פוסט שקיים באתר מסומן `draft: false` במפורש. חשוב: Pages CMS ממלא שדה חסר בברירת המחדל, כך שפוסט בלי
  `draft` יהפוך לטיוטה בשמירה הבאה. לכן גם `tools/add_post.py` כותב `draft: false`.

### כותבים וקטגוריות
- הרשימות נמצאות ב-`data/authors.yml` ו-`data/categories.yml`, ועורכים אותן ב-Pages CMS ("כותבים", "קטגוריות").
- `active: false` מסתיר כותב או קטגוריה מהבחירה בפוסט חדש, אבל הפוסטים הישנים ממשיכים להציג אותם.
- `.github/workflows/cms-lists.yml` מריץ את `tools/update_cms_lists.py` אחרי כל שינוי: משלים `slug` חסר מהשם ומעדכן את
  אפשרויות הבחירה ב-`.pages.yml` (בין הסימונים `# BEGIN` / `# END`).

### "הנצפים ביותר"
- `.github/workflows/top-posts.yml` רץ כל לילה, קורא מ-GoatCounter את הפוסטים הנצפים ב-30 הימים האחרונים
  (`tools/top_posts.py`, סוד `GOATCOUNTER_API_KEY`) וכותב את `data/top_posts.json`. הרשימה ב-`site.yml` היא גיבוי.

## תגובות של קוראים
- הטופס בתחתית כל פוסט שולח את התגובה לשירות קטן ב-Cloudflare Workers (`worker/`), שכותב אותה כקובץ
  ל-`content/comments/new/` עם `approved: false` (ואם הוגדר – שולח מייל התראה דרך Brevo).
- מאשרים ב-Pages CMS: "תגובות" ← התגובה ← מסמנים "מאושר – להציג באתר" ← שמירה. רק תגובות מאושרות מוצגות.
  תגובה לא רצויה פשוט מוחקים.
- הטופס מוצג רק כש-`comments_endpoint` ב-`site.yml` מכיל את כתובת השירות.
- הפריסה של השירות: `.github/workflows/comments-worker.yml`, לפי הסודות במאגר
  `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `COMMENTS_GITHUB_TOKEN`, ולהתראות במייל `BREVO_API_KEY`, `NOTIFY_EMAIL`.

## הוספת פוסט ידנית (בלי הממשק)
יוצרים קובץ חדש ב-`content/posts/<שנה>/`, למשל `content/posts/2026/2026-11-01-900001.html`:

```
---
id: 900001
title: כותרת הפוסט
date: '2026-11-01 12:00:00'
url: /2026/11/01/my-post/
author: idanb
categories:
- קולנוע
tags: []
image: /wp-content/uploads/2026/11/header.webp
---
<p>פסקה ראשונה (מופיעה בעמוד הבית)</p>

<!--more-->

<p>המשך הפוסט…</p>
```

## בנייה מקומית
```
pip install jinja2 pyyaml pillow
python build.py
python -m http.server -d _site
```
