# أمان swarm.finaly.py وتشغيله في حاوية معزولة

## ما تغيّر
- فحص الكود المولّد صار بقائمة سماح (swarm_security.py): أي وحدة أو دالة خارج القائمة مرفوضة، ومنها importlib وgetattr وopen وpathlib وos.
- التأكيد y/n قبل تشغيل أي أداة هو الافتراضي. المتغير القديم SWARM_AUTORUN=1 لم يعد يعمل.
- الوضع الوهمي (mock) لا يمرّر أي اختبار ولا يحفظ أداة ولا يشغّلها، وكل ناتجه موسوم [MOCK].
- المفاتيح من متغيرات البيئة فقط (GEMINI_API_KEY أو META_API_KEY / TOGETHER_API_KEY). غيابها مع وضع gemini أو meta أو hybrid يوقف التشغيل برسالة واضحة.

## تنبيه
الفحص طبقة دفاع وليس sandbox. الكود المولّد من نموذج غير موثوق. شغّل دائما داخل حاوية.

## تشغيل آمن (Docker)
```
docker run --rm -it \
  --network none --read-only --tmpfs /tmp \
  --cap-drop ALL --security-opt no-new-privileges \
  --pids-limit 128 --memory 512m --cpus 1 \
  --user 65534:65534 \
  -v "$PWD":/app:ro -v swarm_ws:/work -w /app \
  -e SWARM_WORKSPACE=/work \
  python:3.11-slim python swarm.finaly.py
```
- وضع mock لا يحتاج شبكة. لاستخدام نموذج حقيقي احذف `--network none` (الشبكة مطلوبة للنموذج) ومرّر المفتاح من بيئتك بلا كتابته في ملف: `-e GEMINI_API_KEY` (القيمة تؤخذ من صدفتك) مع `-e SWARM_MODE=gemini`. ثبّت requests داخل صورة جاهزة.
- لا تضع أي مفتاح في الكود أو الملفات أو سجل git.
- التشغيل التلقائي بلا تأكيد (SWARM_AUTORUN_I_UNDERSTAND_THE_RISK=yes) يُستخدم فقط داخل الحاوية أعلاه وبلا شبكة.
