# النشر التلقائي لخادم المدرّب الذكي على Cloudflare

جهزنا سير عمل GitHub Actions لنشر **Cloudflare Worker فقط** من هذا المستودع التجريبي. لا يغيّر هذا الملف واجهة التطبيق، ولا ينشر تلقائيًا إلى أن تُدمج التغييرات في `main` وتُضاف أسرار Cloudflare إلى إعدادات المستودع.

## ما الذي سيحدث؟

- عند دمج تغيير في `worker.js` أو `wrangler.toml` إلى `main`، سيحاول GitHub نشر Worker باسم `shadowbox-nox-coach`.
- يمكن تشغيله يدويًا من تبويب **Actions** بعد إعداد الأسرار.
- لا يجري النشر من الفروع التجريبية، ولا يجري عند فتح Pull Request فقط.
- مفتاح OpenAI لا يوضع في GitHub أو في أي ملف من المستودع؛ يبقى سرًا داخل Cloudflare Worker.

## إعداد مطلوب مرة واحدة من صاحب الحساب

1. أنشئ Cloudflare API Token بصلاحية **Edit Cloudflare Workers**، ومقيّدًا بحساب Cloudflare الصحيح. لا تستخدم صلاحية Full access العامة.
2. في GitHub افتح المستودع **Settings → Secrets and variables → Actions → New repository secret**.
3. أضف سرين:
   - `CLOUDFLARE_API_TOKEN`: قيمة التوكن. لا ترسلها في المحادثة ولا تضعها في ملف.
   - `CLOUDFLARE_ACCOUNT_ID`: معرّف حساب Cloudflare.
4. أضف سر `OPENAI_API_KEY` داخل إعدادات Worker في Cloudflare (وليس ضمن أسرار GitHub الخاصة بالنشر إلا إذا اخترنا إعدادًا مختلفًا).
5. قبل تشغيل المدرّب، تأكد أن متغير `ALLOWED_ORIGINS` في `wrangler.toml` يطابق عنوان الموقع المنشور الفعلي، وأن عنوان API في واجهة التطبيق مضبوط على رابط Worker الصحيح.

## حدود مهمة

- هذا الإعداد ينشر **الخادم الخلفي فقط**. واجهة HTML الحالية منفصلة عن Worker.
- إضافة سير العمل لا تعني أن Cloudflare اتصلت بالفعل بحسابك؛ يجب إضافة الأسرار مرة واحدة ثم نجاح أول عملية نشر.
- لا تدمج هذا التغيير في المستودع الأساسي `ShadowBoxNox`؛ العمل هنا مخصص للمستودع التجريبي `Nox`.
