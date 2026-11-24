# اركب – ARKAB | المناقل — 0.2.0
نسخة مصدر اختبارية مرتبطة بإعدادات Supabase الفعلية (المفتاح عام publishable، وليس مفتاحاً سرياً). تمت مطابقة profiles/drivers/vehicles/rides/ride_offers وRPCs مع المشروع الحالي. لا تعِد تطبيق مخطط SQL القديم.

## التشغيل والبناء
- Node 22: npm install ثم npx expo install --fix ثم npx expo-doctor ثم npx expo start.
- تفعيل Phone Auth ومزود SMS يدعم السودان في Supabase، واعتماد السائق ومركبته من لوحة الإدارة الرسمية قبل اختبار العروض.
- npx eas-cli login ثم npx eas-cli init ثم npx eas-cli build --platform android --profile preview. يلزم مشروع Expo مرتبط وحساب مصادق عليه.
- ملف eas.json يحدد APK للمعاينة وAAB للإنتاج.

## حدود النسخة
تم فحص صياغة JSX فقط؛ لم يتم تثبيت التبعيات أو اختبار الهاتف أو إنشاء APK. لم تنفذ الخرائط وGPS وPIN والتسعير حسب المسافة والمدفوعات والعمولات ولوحة الإدارة الفعلية وخط Cairo بعد. تحديث الطلبات يعتمد على Realtime مع استطلاع دوري. الاعتماد إداري يدوياً.
