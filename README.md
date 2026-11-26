# أركب ARKAB | المناقل

تطبيق Android واحد بواجهتين حسب نوع الحساب:
- **الراكب:** إنشاء طلب، مشاهدة المركبات القريبة، استقبال عروض الكباتن، متابعة الرحلة، التقييم والدعم.
- **الكابتن:** التسجيل وإضافة المركبة، انتظار الاعتماد الإداري، تشغيل/إيقاف التوفر، استقبال الطلبات وإرسال العروض وتحديث مراحل الرحلة.

## التقنية الحالية
- Expo SDK 54 / React Native 0.81.
- Supabase Auth + PostgreSQL + Realtime + Edge Functions.
- MapLibre للخرائط.
- Expo Location وTaskManager لتحديث الموقع في الخلفية وفق الأذونات.
- Expo Notifications لإشعارات الرحلات.
- Cairo للواجهات العربية، مع بصمة اختيارية عبر Android Biometric.

## بيئة المشروع
- Expo owner: `omer123mnm`
- Expo project ID: `653d655f-1c9e-4b85-b8b6-ccc819b2943b`
- Android application ID: `com.arkab.managil`
- Supabase project ref: `hfhkscqmsmxsxzjfxzew`
- فرع العمل الحالي: `feat/arkab-premium-ui`

## المصادقة والحسابات
التسجيل الحالي بالبريد الإلكتروني وكلمة المرور مع رمز تأكيد البريد. رقم الهاتف يُحفظ كوسيلة تواصل بصيغة السودان (+249)، لكنه **ليس موثقاً عبر SMS** في التدفق الحالي. اختيار دور الراكب أو الكابتن يتم عند إكمال الملف الشخصي، واعتماد الكابتن والمركبة إداري قبل استقبال الرحلات.

## التتبع والإشعارات
- تتبع الكابتن أثناء الرحلة يعتمد على إذن الموقع في الخلفية وخدمة foreground على Android.
- ظهور المركبة للكباتن المتاحين يعتمد على تفعيل حالة التوفر ومشاركة الموقع.
- إشعارات الرحلات تمر عبر trigger في قاعدة البيانات ثم Edge Function ثم Expo Push.
- يلزم إعداد بيانات FCM V1 لمشروع Expo واختبار الإشعارات على هاتف Android حقيقي قبل النشر.

## إعداد المشروع محلياً
يتطلب Node.js وAndroid SDK/JDK عند البناء المحلي.

```bash
npm ci
npx expo-doctor
```

للتطوير على جهاز Android مع الوحدات الأصلية مثل MapLibre استخدم Development Build أو البناء الأصلي، ولا تعتمد على Expo Go وحده.

## ملفات البناء
- `preview`: APK داخلي للتثبيت والاختبار على الهاتف.
- `production`: Android App Bundle (AAB) مخصص للرفع إلى Google Play.
- `app.json` يثبت compileSdkVersion وtargetSdkVersion على API 36.

```bash
eas build --platform android --profile preview
eas build --platform android --profile production
```

## ملاحظات قبل الإصدار العام
لا تعتبر هذه النسخة منشورة أو معتمدة للإنتاج قبل إغلاق قائمة التحقق في [PRODUCTION_READINESS.md](./PRODUCTION_READINESS.md)، بما فيها اختبار هاتفين، إعداد FCM V1، التحقق من خدمة التوجيه، مراجعة أمان Supabase، وسياسة الخصوصية ومتطلبات Google Play.

لا تضع مفاتيح الخدمة السرية أو ملفات حسابات Google/Firebase داخل Git. استخدم أسرار الخدمات المعتمدة فقط.
