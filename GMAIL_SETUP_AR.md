# ربط جيميل بأبو سراج (قراءة فقط)

أبو سراج مش بياخد كلمة سر جيميل. بتدخل بتسجيل جوجل الرسمي وبتدّيه صلاحية **قراءة فقط**، وتقدر تلغيها في أي وقت من زر "جيميل ✓" أو من myaccount.google.com/permissions.

## الإعداد (مرة واحدة)
1. افتح console.cloud.google.com وأنشئ مشروع جديد.
2. من APIs & Services ← Library فعّل **Gmail API**.
3. من OAuth consent screen: النوع External، واكتب اسم التطبيق، وأضف بريدك في **Test users**.
4. من Credentials ← Create credentials ← OAuth client ID ← **Web application**.
5. في Authorized redirect URIs اكتب بالظبط: `http://localhost:3000/auth/google/callback` (أو `PUBLIC_URL` بتاعك + `/auth/google/callback` لو منشور على HTTPS).
6. انسخ Client ID وClient secret في `.env` (`GOOGLE_CLIENT_ID` و`GOOGLE_CLIENT_SECRET`)، وأعد تشغيل `npm start`.
7. افتح الصفحة واضغط "ربط جيميل" ووافق.

## ملاحظات
- طالما التطبيق في وضع Testing، جوجل بتنهي الربط كل 7 أيام تقريباً، فاضغط "ربط جيميل" تاني لما ينتهي.
- هيظهر تحذير "Google hasn't verified this app" لأن التطبيق بتاعك. اضغط Advanced ← Continue.
- بعد ما أبو سراج يقرأ إيميل، فتح أي رابط بيحتاج موافقتك (حماية من إيميل مفخخ بتعليمات).
