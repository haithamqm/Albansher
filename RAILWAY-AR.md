# نشر البنشر الذكي على Railway — بدون قاعدة بيانات خارجية

هذه النسخة لا تحتاج PostgreSQL ولا `DATABASE_URL`؛ لذلك لا تضف رابط `localhost` ولا مرجع `Postgres.DATABASE_URL` لهذه النسخة.

1. فك ضغط ZIP.
2. انسخ **محتويات المجلد** إلى مجلد المشروع الحالي المرتبط بمستودع GitHub.
3. ارفع التعديلات إلى نفس المستودع والفرع المرتبط بـ Railway.
4. من Railway افتح خدمة التطبيق > Variables وأضف `ADMIN_PASSWORD` بكلمة مرور قوية خاصة بك. (اختياري: `ADMIN_NAME=مدير البنشر الذكي`).
5. تأكد أن أمر التشغيل `npm start` وأن healthcheck هو `/health`؛ الملف `railway.json` يحدد ذلك.
6. بعد نجاح النشر افتح `/health` ثم `/admin.html`.
7. لضمان بقاء ملف البيانات بعد إعادة النشر، أضف Volume واربطه بالمسار `/app/data`، ثم أضف `DATA_DIR=/app/data` في Variables.

إذا ظهر Crash رغم ذلك، انسخ آخر 20 سطرًا من Logs. هذه النسخة لا تعتمد على الاتصال بـ PostgreSQL؛ ظهور خطأ اتصال PostgreSQL يعني أن Railway لا يزال يشغّل نسخة قديمة أو أن متغير Start Command/Source Directory يشير إلى ملفات أخرى.
