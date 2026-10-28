# abu-seraj-orchestrator-cjs

محرك أبو سراج (Orchestrator) بنمط CommonJS، في ملف واحد: `abu-seraj-all-in-one.js`.

يحتوي الملف على:
- `contracts`: حالات المحرك (ORCHESTRATOR_STATES) ومستويات الخطر (RISK_LEVELS) ووظائف التحقف والـ handoff
- `RiskGate` و`StateHandoff` و`RecoveryRouter`: تقييم الخطر وتطبيع المخرجات وتوجيه الحالات
- `SkillRegistry` و`SkillDiscovery`: تسجيل المهارات واكتشافها بالنقاط
- `SkillTaskAdapter`: تنفيذ مهارة عبر agentLoop مع بوابة موافقة قبل أي خطر غير قراءة
- `LocationResolverSkill`: طلب إذن الموقع وفتح خرائط جوجل

## التشغيل

المحرك بلا أي مكتبات خارجية، يعمل على Node.js 20 أو أحدث. استيراد `js-yaml` اختياري داخل `loadAll` فقط، ومحاط بـ try/catch.

## الاختبارات

```bash
node --test abu-seraj-orchestrator-cjs/test/orchestrator.test.js
```

الاختبارات تغطي السلوك الفعلي: عقود الحالات، كل مستويات الخطر، توجيه الاسترداد، التسجيل والاكتشاف، تنفيذ المهارات مع الموافقات، ومهارة الموقع.
