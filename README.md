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

## עריכה בממשק חזותי (Pages CMS)
נכנסים ל-https://app.pagescms.org עם חשבון ה-GitHub, בוחרים את המאגר `multiversesite`, ושם יש "פוסטים" ו"עמודים":
כותרת, תאריך, כותב, קטגוריות, תגיות, תמונה ראשית ועורך טקסט. שמירה מעדכנת את האתר תוך כמה דקות.
סרטון/ציוץ/פוסט פייסבוק: מדביקים את הקישור לבד בשורה, והאתר מציג אותו כנגן.
ההגדרות של הממשק נמצאות בקובץ `.pages.yml`.

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
