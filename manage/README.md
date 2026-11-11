# ניהול מולטיוורס – אפליקציה לטלפון

אפליקציית ווב (PWA) לניהול האתר מהטלפון, עם הלוגו של מולטיוורס כסמל במסך הבית.

**הכתובת:** https://multiverse-manage.multiversesite.workers.dev/ (וגם `multiversesite.com/manage/` מעביר אליה).

נכנסים עם קוד שנשלח למייל (Cloudflare Access), רק מי שהמייל שלו ברשימה. אף אחד לא שומר מפתח בטלפון:
המפתח של GitHub והמפתח של GoatCounter שמורים פעם אחת ב-Cloudflare.

## מה יש בה
- **בית:** כמה תגובות וטיוטות מחכות, האם האתר באוויר או מתעדכן (וכפתור לבנייה מחדש), הסוכן מקבוצת הפייסבוק
  (מתי הסריקה הבאה, מה הועבר ומה דולג), הצפיות של היום ושל השבוע, ומה השתנה לאחרונה.
- **פוסטים:** טיוטות ופרסום בלחיצה, פוסטים אחרונים, חיפוש בכל הפוסטים באתר, שיתוף, החזרה לטיוטה,
  וקישור ישיר לעריכה של כל פוסט ב-Pages CMS.
- **פוסט חדש:** כותרת, תמונה ראשית (מוקטנת בטלפון ל-WebP), כותב, קטגוריות, טקסט, תקציר ותגיות.
  "פרסום" מעלה לאתר מיד, "שמירה כטיוטה" שומר ב-`content/posts/` כמו Pages CMS. הטקסט נשמר בטלפון בזמן הכתיבה.
- **תגובות:** אישור, אישור של כולן במכה אחת, הסתרה ומחיקה.
- **צפיות:** נתונים מ-GoatCounter.
- **כלים:** קישורים לכל השאר – Pages CMS, פייסבוק, הסוכן ב-Claude, Brevo, GoatCounter, Cloudflare, WordPress.com, GitHub;
  והשם שנרשם ליד השינויים של כל משתמש.

## הגדרה חד-פעמית (בעל האתר)
האפליקציה עצמה מציגה את השלבים האלה, ומסמנת מה כבר בוצע.
1. **כניסה עם מייל:** ב-Cloudflare Zero Trust (בפעם הראשונה: שם לצוות ותוכנית Free) יוצרים ב-Access controls > Policies
   מדיניות "צוות מולטיוורס": Action: Allow, Include: Emails עם כתובות המייל המורשות, Session duration: חודש.
   אחר כך ב-Workers & Pages > multiverse-manage > Access > Protect this Worker behind Access > All traffic, בוחרים את המדיניות > Apply Access.
2. **מפתח GitHub:** מפתח fine-grained רק למאגר `multiversesite`, עם Contents ו-Actions במצב Read and write.
   שומרים אותו ב-Workers & Pages > multiverse-manage > Settings > Variables and Secrets כ-Secret בשם `GITHUB_TOKEN`.
3. **צפיות:** אין מה לעשות – תהליך הפריסה מעתיק לבד את הסוד `GOATCOUNTER_API_KEY` מ-GitHub ל-Cloudflare.

להוסיף או להוריד אדם: עורכים את רשימת המיילים במדיניות "צוות מולטיוורס" ב-Zero Trust.

## איך זה עובד
- `public/` – האפליקציה: HTML, CSS ו-JavaScript בלי ספריות ובלי שלב בנייה.
- `src/worker.js` – ה-Worker: מגיש את קבצי האפליקציה (`bundle.mjs` אורז אותם ל-`src/assets.js` לפני כל פריסה),
  ומעביר בקשות של האפליקציה ל-GitHub (`/api/gh/...`, רק למאגר הזה) ול-GoatCounter (`/api/gc/...`, רק סטטיסטיקות) עם המפתחות ששמורים בו.
- ה-API עונה רק לבקשה שעברה דרך Cloudflare Access: `ctx.access` של Workers, או – אם הוא לא זמין – אימות של
  `Cf-Access-Jwt-Assertion` מול `ACCESS_TEAM_DOMAIN` ו-`ACCESS_AUD` (סודות נוספים שצריך רק במקרה הזה). בלי זה ה-API מסרב,
  כך שגם אם הכניסה עם מייל תכובה בטעות, אי אפשר לשנות את האתר דרך האפליקציה.
- כל שינוי הוא commit אחד ל-`main`, עם שם המשתמש בהודעה, ולכן האתר נבנה מחדש לבד. "פרסום" של טיוטה ו"החזרה לטיוטה"
  מפעילים את אותו `publish.yml` שהכפתורים ב-Pages CMS מפעילים.
- האפליקציה בכתובת נפרדת מהאתר, כדי שהסקריפטים שהאתר טוען (פייסבוק, X, אינסטגרם, Brevo) לא יגיעו אליה.
- הפריסה: `.github/workflows/manage-app.yml` (אורז, מריץ `wrangler deploy`, ומעתיק את מפתח GoatCounter), עם הסודות
  `CLOUDFLARE_API_TOKEN` ו-`CLOUDFLARE_ACCOUNT_ID` של שירות התגובות.
- הגופנים IBM Plex Sans Hebrew ו-Karantina (רישיון SIL OFL, ב-`public/fonts/`).

## בדיקה מקומית
```
python3 -m http.server -d manage/public 8765
```
ופותחים http://127.0.0.1:8765/ – הממשק נטען, אבל בלי ה-Worker אין נתונים (הבקשות ל-`/api` נכשלות).
