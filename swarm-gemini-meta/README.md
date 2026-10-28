# سرب Gemini + Meta (نسخة مُصلَحة أمنيًا)

هذه النسخة من سكربت السرب معزولة في مجلدها الخاص ولا تلمس باقي المستودع.

## ما أُصلِح

1. **الأمان:** لا يُنفَّذ أي كود مولَّد داخل العملية الرئيسية. التشغيل في عملية فرعية معزولة (`python -I`) بمهلة زمنية، ولا تشغيل إلا بعد تأكيد تفاعلي صريح (الافتراضي رفض). حُذف متغير `SWARM_AUTORUN` نهائيًا فلا يمكن لأي متغير بيئة إلغاء التأكيد. فحص AST يمنع `os` و`subprocess` و`importlib` و`ctypes` و`pty` و`shutil` و`eval` و`exec` و`compile` و`__import__` و`getattr` على builtins ووصول dunder و`open()` للكتابة أو خارج مجلد العمل.
2. **لا Mock صامت:** طلب وضع حقيقي (gemini/meta/hybrid) بلا مفتاح، أو فشل النماذج الحقيقية، يفشل برسالة عربية واضحة. لا رجوع تلقائي إلى mock. وضع mock يعمل فقط باختيار صراحة، وكل مخرجاته موسومة `[MOCK]` ولا تُحفظ في الذاكرة ولا تُعَد نتيجة اختبار ناجحة.

## الاستخدام

```bash
pip install requests pytest

# وضع gemini
export GEMINI_API_KEY="..."
SWARM_MODE=gemini python final_gemini_meta_swarm.py "مهمتك"

# وضع meta (Together/Groq)
export META_API_KEY="..."
SWARM_MODE=meta python final_gemini_meta_swarm.py "مهمتك"

# وضع mock (صراحةً، للتجربة فقط)
SWARM_MODE=mock python final_gemini_meta_swarm.py "مهمتك"
```

## الاختبارات

```bash
python -m pytest tests/ -v
```

32 اختبارًا تغطي: رفض الكود الخطر، رفض التنفيذ دون موافقة، الفشل الواضح عند غياب المفتاح، ووسم مخرجات Mock.
