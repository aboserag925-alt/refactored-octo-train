# أبو سراج — الوكيل الشخصي

## تشغيل سريع (كتطبيق)
- **أندرويد (Termux):** افتح Termux داخل مجلد المشروع واكتب `bash install-android.sh` مرة واحدة (بيثبّت المتطلبات ويسألك عن مفتاح OpenAI وكلمة سر). بعدها يشتغل بـ`bash start-android.sh`. سيب Termux مفتوح.
- **ويندوز:** دبل كليك على `start-windows.bat` (بيفتح `.env` أول مرة تكتب فيه المفتاح).
- **تثبيته كأيقونة تطبيق:** افتح `http://localhost:3000` في Chrome ← القائمة ← **تثبيت التطبيق**.


تطبيق ويب عربي قابل للتثبيت كتطبيق PWA، يستخدم **OpenAI Agents API** عبر أوامر `curl`، ويحفظ تعريف الوكيل القابل لإعادة الاستخدام باسم `aboserag`. ينشئ جلسات Agents API مستقلة للمحادثات ويعرض أحداثها أثناء وصولها.

## التشغيل على الكمبيوتر

1. ثبّت Node.js 18+ و`curl`.
2. انسخ `.env.example` إلى `.env`.
3. ضع مفتاح API الخاص بالمشروع بعد `OPENAI_API_KEY=`. لا ترسله في المحادثة أو تضعه في المتصفح.
4. عدّل `ACCESS_PASSWORD` لكلمة قوية إذا أردت حماية التطبيق على localhost، ثم شغّل:

```powershell
npm start
```

افتح `http://localhost:3000` واترك نافذة الخادم مفتوحة. خطوات مفتاح API بالتفصيل في [API_SETUP_AR.md](API_SETUP_AR.md).

## استخدامه على الهاتف

نزّل Termux من F-Droid، وانقل `aboserag-agent-project.zip` إلى الهاتف. في Termux ثبّت Node وcurl وunzip، ثم فك الضغط وشغّل `npm start`. افتح Chrome على `http://localhost:3000` واختر **تثبيت التطبيق** أو **إضافة إلى الشاشة الرئيسية**. المفتاح لا يأتي داخل ZIP؛ أضفه محليًا داخل `.env` في الهاتف.

```sh
pkg update -y && pkg install -y nodejs-lts curl unzip
termux-setup-storage
cd ~/storage/downloads
unzip aboserag-agent-project.zip -d abu-siraj
cd abu-siraj
cp .env.example .env
nano .env
npm start
```

على iPhone يلزم عنوان HTTPS مستضاف قبل الإضافة للشاشة الرئيسية. لم يتم نشر الخادم على الإنترنت.

## الأدوات المدمجة

- بحث ويب مباشر من Agents API.
- قراءة وكتابة الملفات داخل `workspace/` فقط؛ الكتابة تتطلب موافقتك داخل الواجهة.
- ذاكرة طويلة المدى بأدوات `remember` و`recall` و`forget`، محفوظة محليًا في `data/notes.json`.
- قراءة صفحات HTTP/HTTPS عامة مع حظر العناوين الداخلية. بعد قراءة بريد، فتح رابط يحتاج موافقتك.
- Gmail اختياري وبصلاحية القراءة فقط. يحتاج بيانات OAuth من Google واتباع [GMAIL_SETUP_AR.md](GMAIL_SETUP_AR.md).
- أدوات الهاتف (موقع، SMS، جهات اتصال، إشعارات، فتح رابط) عبر Termux:API: معطّلة افتراضيًا، وتحتاج `ENABLE_PHONE=1` والخادم على الموبايل نفسه، وكل قراءة حساسة أو إرسال بموافقتك. الشرح في [PHONE_SETUP_AR.md](PHONE_SETUP_AR.md).
- `run_command` معطّل افتراضيًا. تفعيله يتطلب `ENABLE_SHELL=1`، وكل أمر يحتاج موافقة؛ الأوامر تعمل بصلاحيات مستخدم الخادم.

## الإعدادات

المشروع الافتراضي هو `proj_pztv7NZUGVHEzy2suKX5KU3N`، والوكيل `aboserag` يستخدم `gpt-6-astra` واستدلالًا متوسطًا. التطبيق يحفظ معرّف تعريف الوكيل في `.agent-state.json`؛ مفاتيح API ورموز Gmail لا تدخل ملف ZIP.

`HOST` افتراضيًا `127.0.0.1`. إذا غيّرته لعنوان يستقبل اتصالات من خارج الجهاز، يجب إعداد `ACCESS_PASSWORD` لا يقل عن 8 أحرف. استخدم HTTPS عند نشره خارج جهازك.
## الاختبار المحلي

من مجلد المشروع شغّل:

```powershell
npm test
```

يشغّل الاختبارات المدمجة عبر `node --test`: إعداد الوكيل، صياغة الواجهة، أدوات workspace والذاكرة، بوابات الموافقة، حظر عناوين الشبكات الداخلية، وHTTP/PWA وتسجيل الدخول. الاختبارات لا تحتاج مفتاح API ولا ترسل طلبات إلى OpenAI. لاختبار جلسة Agents API الحقيقية، أضف مفتاحًا صالحًا إلى `.env`، ثم شغّل `npm start` وأرسل رسالة من الواجهة.


