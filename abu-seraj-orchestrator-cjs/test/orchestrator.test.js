"use strict";
// اختبارات المحرك أبو سراج - تغطي السلوك الفعلي للملف abu-seraj-all-in-one.js كما هو
// تشغيل: node --test abu-seraj-orchestrator-cjs/test/

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");

const O = require(path.join(__dirname, "..", "abu-seraj-all-in-one.js"));
const {
  ORCHESTRATOR_STATES,
  RISK_LEVELS,
  SKILL_STATUS,
  validateManifest,
  createHandoff,
  RiskGate,
  StateHandoff,
  RecoveryRouter,
  SkillRegistry,
  SkillDiscovery,
  SkillTaskAdapter,
  LocationResolverSkill,
  EXTERNAL_CHANNELS,
  issueApproval,
} = O;
const fs = require("fs");
const os = require("os");

// ---------- contracts ----------
test("ORCHESTRATOR_STATES و RISK_LEVELS و SKILL_STATUS قيم مجمدة ومتوقعة", () => {
  assert.deepEqual(Object.values(ORCHESTRATOR_STATES), ["CONTINUE", "ENOUGH", "DEBUG", "REPLAN", "BLOCKED", "NEED_APPROVAL"]);
  assert.deepEqual(Object.values(RISK_LEVELS), ["read-only", "write", "location-sensitive", "external-communication", "deploy", "destructive"]);
  assert.deepEqual(Object.values(SKILL_STATUS), ["completed", "failed", "blocked"]);
  assert.ok(Object.isFrozen(ORCHESTRATOR_STATES));
  assert.ok(Object.isFrozen(RISK_LEVELS));
  assert.ok(Object.isFrozen(SKILL_STATUS));
});

test("validateManifest يقبل المانيفست الكامل ويرفض الناقص", () => {
  const ok = { name: "s", description: "d", triggers: ["t"] };
  assert.strictEqual(validateManifest(ok), true);
  for (const field of ["name", "description", "triggers"]) {
    const bad = { ...ok };
    delete bad[field];
    assert.throws(() => validateManifest(bad), new RegExp(`Manifest missing required field: ${field}`));
  }
});

test("createHandoff يطبق القيم الافتراضية ويرفض state غير صالح", () => {
  const h = createHandoff({ skill: "x" });
  assert.strictEqual(h.skill, "x");
  assert.strictEqual(h.status, "completed");
  assert.strictEqual(h.summary, "");
  assert.deepEqual(h.artifacts, []);
  assert.deepEqual(h.findings, []);
  assert.deepEqual(h.verification, { passed: false }); // الافتراضي: غير متحقق منه
  assert.strictEqual(h.decision.state, "CONTINUE");
  assert.strictEqual(h.next, null);
  assert.ok(typeof h.timestamp === "string");
  assert.throws(() => createHandoff({ skill: "x", decision: { state: "NOT_A_STATE", reason: "", confidence: 1 } }),
    /Invalid decision\.state: NOT_A_STATE/);
});

// ---------- RiskGate ----------
test("RiskGate.evaluate: read-only فقط يسمح، والباقي يحتاج موافقة", () => {
  assert.deepEqual(RiskGate.evaluate("read-only"), { allowed: true, decision: "continue", risk: "read-only" });
  const w = RiskGate.evaluate("write");
  assert.strictEqual(w.allowed, false);
  assert.strictEqual(w.decision, "NEED_APPROVAL");
  assert.strictEqual(w.approvalType, "write");
  const loc = RiskGate.evaluate("location-sensitive");
  assert.strictEqual(loc.allowed, false);
  assert.strictEqual(loc.ui, "location_permission_card");
  assert.strictEqual(loc.approvalType, "location");
  for (const r of ["deploy", "destructive"]) {
    const d = RiskGate.evaluate(r);
    assert.strictEqual(d.allowed, false);
    assert.strictEqual(d.decision, "NEED_APPROVAL");
    assert.strictEqual(d.approvalType, r);
  }
});

test("إصلاح 2: قيمة risk مجهولة أو غائبة تفشل مغلقة", () => {
  for (const r of ["Deploy", "anything-else", undefined, null, "", "WRITE"]) {
    const d = RiskGate.evaluate(r);
    assert.strictEqual(d.allowed, false, String(r));
    assert.strictEqual(d.decision, "NEED_APPROVAL");
    assert.strictEqual(d.approvalType, "unknown");
  }
});

test("external-communication: كل قناة تحتاج موافقة وليست location", () => {
  assert.deepEqual([...EXTERNAL_CHANNELS], ["whatsapp", "telegram", "gmail"]);
  const d = RiskGate.evaluate(RISK_LEVELS.EXTERNAL_COMMUNICATION);
  assert.strictEqual(d.allowed, false);
  assert.strictEqual(d.decision, "NEED_APPROVAL");
  assert.strictEqual(d.approvalType, "external-communication");
  assert.notStrictEqual(d.approvalType, "location");
  assert.deepEqual([...d.channels], ["whatsapp", "telegram", "gmail"]);
});

// ---------- StateHandoff ----------
test("StateHandoff.normalize يعيد نفس الكائن للصالح ويرفض الناقص", () => {
  const raw = { decision: { state: "CONTINUE", reason: "", confidence: 1 } };
  assert.strictEqual(StateHandoff.normalize(raw), raw);
  assert.throws(() => StateHandoff.normalize({}), /Handoff must contain valid decision\.state/);
  assert.throws(() => StateHandoff.normalize({ decision: { state: "NOPE" } }), /Handoff must contain valid decision\.state/);
});

// ---------- RecoveryRouter ----------
test("RecoveryRouter.route يحول كل حالة إلى الإجراء الصحيح", () => {
  const h = (state, extra = {}) => ({ decision: { state, reason: "r", ...extra }, next: "next-skill" });
  assert.deepEqual(RecoveryRouter.route(h("DEBUG")), { action: "route_to_debug", skill: "debugger", reason: "r" });
  assert.deepEqual(RecoveryRouter.route(h("REPLAN")), { action: "replan", reason: "r" });
  assert.deepEqual(RecoveryRouter.route(h("BLOCKED")), { action: "blocked", reason: "r" });
  assert.deepEqual(RecoveryRouter.route(h("NEED_APPROVAL", { approvalType: "location" })), { action: "await_approval", reason: "r", approvalType: "location" });
  assert.deepEqual(RecoveryRouter.route(h("ENOUGH")), { action: "stop", reason: "r" });
  assert.deepEqual(RecoveryRouter.route(h("CONTINUE")), { action: "continue", next: "next-skill" });
  // إصلاح 7: حالة مجهولة تُحجب
  assert.strictEqual(RecoveryRouter.route(h("WHATEVER")).action, "blocked");
});

// ---------- SkillRegistry ----------
test("SkillRegistry.register يخزن المهارة والرسم البياني ويكشف عرض الاكتشاف", () => {
  const reg = new SkillRegistry();
  reg.register({
    name: "location-resolver",
    description: "Request user location",
    triggers: ["my location", "open google map"],
    risk: "location-sensitive",
    policy: { risk: "location-sensitive" },
    inputs: { requires: ["user"] },
    outputs: { produces: ["coords"], may_transition_to: ["maps"] },
  });
  reg.register({ name: "reader", description: "قراءة", triggers: ["اقرا"] });
  assert.strictEqual(reg.get("location-resolver").name, "location-resolver");
  assert.strictEqual(reg.get("nope"), undefined);
  const g = reg.getGraph().get("location-resolver");
  assert.deepEqual(g, { requires: ["user"], produces: ["coords"], may_transition_to: ["maps"], risk: "location-sensitive" });
  assert.deepEqual(reg.getGraph().get("reader"), { requires: [], produces: [], may_transition_to: [], risk: "write" }); // غائب = write
  const view = reg.getDiscoveryView();
  assert.strictEqual(view.length, 2);
  const loc = view.find(v => v.name === "location-resolver");
  assert.strictEqual(loc.risk, "location-sensitive");
  assert.deepEqual(loc.triggers, ["my location", "open google map"]);
  const reader = view.find(v => v.name === "reader");
  assert.strictEqual(reader.risk, "write");
  assert.throws(() => reg.register({ name: "bad" }), /Manifest missing required field: description/);
});

test("SkillRegistry.loadAll مع مجلد غير موجود يعود بأمان دون مهارات", () => {
  const reg = new SkillRegistry(path.join(__dirname, "no-such-dir"));
  const ret = reg.loadAll();
  assert.strictEqual(ret, reg);
  assert.strictEqual(reg.getDiscoveryView().length, 0);
});

// ---------- SkillDiscovery ----------
test("SkillDiscovery.discover يحسب 3 لكل مطابقة trigger و2 لـ trigger المستخدم ويرتب تنازليًا", () => {
  const view = [
    { name: "a", description: "da", triggers: ["my location", "weather"], risk: "location-sensitive" },
    { name: "b", description: "db", triggers: ["weather"], risk: "read-only" },
    { name: "c", description: "dc", triggers: ["شيء بعيد"], risk: "read-only" },
  ];
  const d = new SkillDiscovery(view);
  const res = d.discover("What is my location and the weather?", ["weather"]);
  assert.strictEqual(res[0].name, "a");
  assert.strictEqual(res[0].score, 8);
  assert.strictEqual(res[0].reason, 'trigger match: "my location", trigger match: "weather", user trigger: "weather"');
  assert.strictEqual(res[1].name, "b");
  assert.strictEqual(res[1].score, 5);
  assert.strictEqual(res[1].reason, 'trigger match: "weather", user trigger: "weather"');
  assert.strictEqual(res.length, 2);
  assert.deepEqual(d.discover("لا يوجد شيء"), []);
  assert.deepEqual(d.discover(""), []);
  // إصلاح 7: trigger فارغ لا يطابق كل هدف
  assert.deepEqual(new SkillDiscovery([{ name: "e", description: "", triggers: ["", "  "], risk: "read-only" }]).discover("أي شيء", [""]), []);
  const one = new SkillDiscovery(view).discover("weather now", ["my location"]);
  assert.strictEqual(one[0].name, "a");
  assert.strictEqual(one[0].score, 5);
  assert.strictEqual(one.length, 2);
});

// ---------- SkillTaskAdapter ----------
function makeLoop() {
  return {
    calls: [],
    async executeSkill(name, ctx) {
      this.calls.push({ name, ctx });
      if (ctx && ctx.boom) throw new Error("boom");
      return ctx && ctx.raw;
    },
  };
}
function makeReg() {
  const reg = new SkillRegistry();
  reg.register({ name: "reader", description: "d", triggers: ["t"], policy: { risk: "read-only" } });
  reg.register({ name: "writer", description: "d", triggers: ["t"], policy: { risk: "write" } });
  reg.register({ name: "locator", description: "d", triggers: ["t"], policy: { risk: "location-sensitive" } });
  reg.register({ name: "deployer", description: "d", triggers: ["t"], policy: { risk: "deploy" } });
  return reg;
}

test("executeSkill: مهارة غير موجودة ترجع failed مع DEBUG", async () => {
  const loop = makeLoop();
  const out = await new SkillTaskAdapter(makeReg(), loop).executeSkill("ghost");
  assert.strictEqual(out.status, "failed");
  assert.strictEqual(out.summary, "Skill not found: ghost");
  assert.strictEqual(out.decision.state, "DEBUG");
  assert.strictEqual(out.verification.passed, false);
  assert.strictEqual(loop.calls.length, 0);
});

const OK = { verification: { passed: true }, summary: "done" };

test("executeSkill: read-only ينفذ مباشرة عبر agentLoop", async () => {
  const loop = makeLoop();
  const out = await new SkillTaskAdapter(makeReg(), loop).executeSkill("reader", { raw: OK });
  assert.strictEqual(loop.calls.length, 1);
  assert.strictEqual(out.status, "completed");
  assert.strictEqual(out.summary, "done");
  assert.strictEqual(out.decision.state, "CONTINUE");
  assert.strictEqual(out.verification.passed, true);
});

test("إصلاح 1: write يحتاج موافقة ولا ينفذ بدونها", async () => {
  const loop = makeLoop();
  const ad = new SkillTaskAdapter(makeReg(), loop);
  const out = await ad.executeSkill("writer", { raw: OK });
  assert.strictEqual(out.status, "blocked");
  assert.strictEqual(out.decision.state, "NEED_APPROVAL");
  assert.strictEqual(out.decision.approvalType, "write");
  assert.strictEqual(loop.calls.length, 0);
  const ok = await ad.executeSkill("writer", { raw: OK, args: { f: 1 }, approval: issueApproval("writer", { f: 1 }) });
  assert.strictEqual(ok.status, "completed");
  assert.strictEqual(loop.calls.length, 1);
});

test("إصلاح 3: approved:true العام لم يعد يمرر أي شيء", async () => {
  const loop = makeLoop();
  const ad = new SkillTaskAdapter(makeReg(), loop);
  for (const name of ["writer", "deployer", "locator"]) {
    const out = await ad.executeSkill(name, { approved: true, artifacts: [{ type: "location" }], raw: OK });
    assert.strictEqual(out.status, "blocked", name);
  }
  assert.strictEqual(loop.calls.length, 0);
});

test("إصلاح 3: الموافقة مرتبطة بالمهارة والمعطيات ومرة واحدة وتنتهي", async () => {
  const loop = makeLoop();
  const ad = new SkillTaskAdapter(makeReg(), loop);
  const args = { path: "a.txt" };
  // مهارة أخرى
  let r = await ad.executeSkill("writer", { raw: OK, args, approval: issueApproval("deployer", args) });
  assert.strictEqual(r.status, "blocked");
  // معطيات أخرى
  r = await ad.executeSkill("writer", { raw: OK, args: { path: "b.txt" }, approval: issueApproval("writer", args) });
  assert.strictEqual(r.status, "blocked");
  // منتهية
  r = await ad.executeSkill("writer", { raw: OK, args, approval: issueApproval("writer", args, { ttlMs: 10, now: Date.now() - 1000 }) });
  assert.strictEqual(r.status, "blocked");
  // مزورة
  const forged = { ...issueApproval("writer", args), expiresAt: Date.now() + 9e9 };
  r = await ad.executeSkill("writer", { raw: OK, args, approval: forged });
  assert.strictEqual(r.status, "blocked");
  // صالحة مرة واحدة
  const good = issueApproval("writer", args);
  r = await ad.executeSkill("writer", { raw: OK, args, approval: good });
  assert.strictEqual(r.status, "completed");
  r = await ad.executeSkill("writer", { raw: OK, args, approval: good });
  assert.strictEqual(r.status, "blocked");
  assert.match(r.summary, /already used/);
  assert.strictEqual(loop.calls.length, 1);
});

test("executeSkill: location-sensitive بدون إحداثيات يرجع blocked مع بطاقة الموقع", async () => {
  const loop = makeLoop();
  const out = await new SkillTaskAdapter(makeReg(), loop).executeSkill("locator", {});
  assert.strictEqual(out.status, "blocked");
  assert.strictEqual(out.decision.approvalType, "location");
  assert.strictEqual(out.artifacts[0].ui, "location_permission_card");
  assert.strictEqual(loop.calls.length, 0);
});

test("executeSkill: location-sensitive مع إحداثيات وموافقة كائنية ينفذ", async () => {
  const loop = makeLoop();
  const ad = new SkillTaskAdapter(makeReg(), loop);
  const art = [{ type: "location", latitude: 1, longitude: 2 }];
  const no = await ad.executeSkill("locator", { artifacts: art, raw: OK });
  assert.strictEqual(no.status, "blocked");
  const ok = await ad.executeSkill("locator", { artifacts: art, raw: OK, approval: issueApproval("locator", undefined) });
  assert.strictEqual(ok.status, "completed");
});

test("executeSkill: deploy بدون موافقة blocked، ومع موافقة كائنية ينفذ", async () => {
  const loop = makeLoop();
  const ad = new SkillTaskAdapter(makeReg(), loop);
  const blocked = await ad.executeSkill("deployer", {});
  assert.strictEqual(blocked.status, "blocked");
  assert.strictEqual(blocked.decision.approvalType, "deploy");
  assert.strictEqual(blocked.artifacts[0].risk, "deploy");
  const ok = await ad.executeSkill("deployer", { raw: OK, approval: issueApproval("deployer", undefined) });
  assert.strictEqual(ok.status, "completed");
  assert.strictEqual(loop.calls.length, 1);
});

test("external-communication عبر المحول يحتاج موافقة", async () => {
  const reg = new SkillRegistry();
  reg.register({ name: "mailer", description: "d", triggers: ["t"], policy: { risk: "external-communication" } });
  const loop = makeLoop();
  const out = await new SkillTaskAdapter(reg, loop).executeSkill("mailer", { approved: true, raw: OK });
  assert.strictEqual(out.status, "blocked");
  assert.strictEqual(out.decision.approvalType, "external-communication");
  assert.deepEqual([...out.artifacts[0].channels], ["whatsapp", "telegram", "gmail"]);
  assert.strictEqual(loop.calls.length, 0);
});

test("إصلاح 2/3: risk مجهول في المانيفست يرفض التسجيل، والسجل المركزي يرفع الخطر ولا يخفضه", async () => {
  const reg = new SkillRegistry(".agents/skills", { riskRegistry: { sneaky: "deploy", honest: "read-only" } });
  assert.throws(() => reg.register({ name: "typo", description: "d", triggers: ["t"], risk: "Deploy" }), /Unknown risk level/);
  reg.register({ name: "sneaky", description: "d", triggers: ["t"], policy: { risk: "read-only" } });
  reg.register({ name: "honest", description: "d", triggers: ["t"], policy: { risk: "write" } });
  assert.strictEqual(reg.getRisk("sneaky"), "deploy");
  assert.strictEqual(reg.getRisk("honest"), "write");
  const loop = makeLoop();
  const out = await new SkillTaskAdapter(reg, loop).executeSkill("sneaky", { raw: OK });
  assert.strictEqual(out.status, "blocked");
  assert.strictEqual(loop.calls.length, 0);
  assert.throws(() => reg.register({ name: "sneaky", description: "d", triggers: ["t"] }), /Duplicate skill name/);
  assert.throws(() => reg.register({ name: "__proto__", description: "d", triggers: ["t"] }), /Invalid skill name/);
});

test("executeSkill: خطأ من agentLoop يرجع failed مع DEBUG ورسالة الخطأ", async () => {
  const out = await new SkillTaskAdapter(makeReg(), makeLoop()).executeSkill("reader", { boom: true });
  assert.strictEqual(out.status, "failed");
  assert.strictEqual(out.summary, "boom");
  assert.strictEqual(out.decision.state, "DEBUG");
  assert.strictEqual(out.decision.confidence, 0.9);
});

test("إصلاح 4: ناتج بلا تحقق لا يُعتبر متحققًا", async () => {
  const ad = new SkillTaskAdapter(makeReg(), makeLoop());
  let out = await ad.executeSkill("reader", { raw: { summary: "x" } });
  assert.strictEqual(out.verification.passed, false);
  out = await ad.executeSkill("reader", { raw: { summary: "x", verification: {} } });
  assert.strictEqual(out.verification.passed, false);
  // decision صالح بلا تحقق: ENOUGH لا يمر كمكتمل
  out = await ad.executeSkill("reader", { raw: { decision: { state: "ENOUGH", reason: "كفى", confidence: 1 } } });
  assert.strictEqual(out.verification.passed, false);
  assert.strictEqual(out.decision.state, "REPLAN");
  // decision صالح مع تحقق حقيقي يمر كما هو
  const raw = { decision: { state: "ENOUGH", reason: "كفى", confidence: 1 }, verification: { passed: true } };
  out = await ad.executeSkill("reader", { raw });
  assert.strictEqual(out, raw);
  // ناتج فارغ
  out = await ad.executeSkill("reader", { raw: undefined });
  assert.strictEqual(out.status, "failed");
});

test("إصلاح 4: ناتج mock مرفوض خارج الاختبارات ومقبول فقط بالتصريح", async () => {
  const raw = { mock: true, verification: { passed: true }, summary: "fake" };
  let out = await new SkillTaskAdapter(makeReg(), makeLoop()).executeSkill("reader", { raw });
  assert.strictEqual(out.status, "failed");
  assert.strictEqual(out.verification.passed, false);
  out = await new SkillTaskAdapter(makeReg(), makeLoop(), { allowMock: true }).executeSkill("reader", { raw });
  assert.strictEqual(out.status, "completed");
});

// ---------- إصلاح 5: تحميل المهارات من القرص ----------
function mkWorkspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "orch-"));
  fs.mkdirSync(path.join(ws, "skills"));
  return ws;
}
function addSkill(ws, dir, yaml) {
  fs.mkdirSync(path.join(ws, "skills", dir), { recursive: true });
  fs.writeFileSync(path.join(ws, "skills", dir, "manifest.yaml"), yaml);
}
const JSONP = raw => JSON.parse(raw); // محلل بديل للاختبار دون مكتبة خارجية

test("loadAll: يحمّل مانيفست سليمًا من القرص", () => {
  const ws = mkWorkspace();
  addSkill(ws, "reader", JSON.stringify({ name: "reader", description: "d", triggers: ["t"], policy: { risk: "read-only" } }));
  const reg = new SkillRegistry("skills", { workspaceRoot: ws, yamlParser: JSONP }).loadAll();
  assert.strictEqual(reg.getRisk("reader"), "read-only");
  assert.deepEqual(reg.errors, []);
});

test("loadAll: يرفض skillsRoot خارج مجلد العمل", () => {
  const ws = mkWorkspace();
  assert.throws(() => new SkillRegistry("../../etc", { workspaceRoot: ws }).loadAll(), /escapes the workspace/);
  assert.throws(() => new SkillRegistry("/etc", { workspaceRoot: ws }).loadAll(), /escapes the workspace/);
});

test("loadAll: يرفض مانيفست فاسد أو بلا risk صالح أو اسمه لا يطابق المجلد، ولا يبتلع الخطأ", () => {
  const ws = mkWorkspace();
  addSkill(ws, "broken", "{not json");
  addSkill(ws, "typo", JSON.stringify({ name: "typo", description: "d", triggers: ["t"], risk: "Deploy" }));
  addSkill(ws, "impostor", JSON.stringify({ name: "reader", description: "d", triggers: ["t"] }));
  addSkill(ws, "proto", '{"name":"proto","description":"d","triggers":["t"],"__proto__":{"polluted":true},"constructor":{"x":1}}');
  addSkill(ws, "norisk", JSON.stringify({ name: "norisk", description: "d", triggers: ["t"] }));
  const reg = new SkillRegistry("skills", { workspaceRoot: ws, yamlParser: JSONP }).loadAll();
  const bad = reg.errors.map(e => e.skill).sort();
  assert.deepEqual(bad, ["broken", "impostor", "typo"]);
  assert.strictEqual(reg.get("reader"), undefined);
  assert.strictEqual(({}).polluted, undefined);
  assert.strictEqual(reg.get("proto").constructor, Object);
  // مانيفست بلا risk يصبح write وليس read-only
  assert.strictEqual(reg.getRisk("norisk"), "write");
});

test("loadAll: يتجاهل الروابط الرمزية للمجلدات", () => {
  const ws = mkWorkspace();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
  fs.writeFileSync(path.join(outside, "manifest.yaml"), JSON.stringify({ name: "evil", description: "d", triggers: ["t"], risk: "read-only" }));
  fs.symlinkSync(outside, path.join(ws, "skills", "evil"));
  const reg = new SkillRegistry("skills", { workspaceRoot: ws, yamlParser: JSONP }).loadAll();
  assert.strictEqual(reg.get("evil"), undefined);
});

// ---------- LocationResolverSkill ----------
test("LocationResolverSkill يبني روابط خرائط جوجل الصحيحة", () => {
  assert.strictEqual(LocationResolverSkill.buildGoogleMapsUrl(30.0444, 31.2357), "https://www.google.com/maps/search/?api=1&query=30.0444,31.2357");
  assert.strictEqual(LocationResolverSkill.buildDirectionsUrl(30.0444, 31.2357), "https://www.google.com/maps/dir/?api=1&destination=30.0444,31.2357");
});

test("LocationResolverSkill.requestApproval يرجع blocked مع NEED_APPROVAL", () => {
  const h = LocationResolverSkill.requestApproval();
  assert.strictEqual(h.status, "blocked");
  assert.strictEqual(h.decision.state, "NEED_APPROVAL");
  assert.strictEqual(h.artifacts[0].provider, "google-maps");
  assert.strictEqual(h.verification.passed, false);
});

test("إصلاح 6: resolveWithCoordinates لا يعمل بدون موافقة كائنية مطابقة للإحداثيات", () => {
  const c = { latitude: 30.0444, longitude: 31.2357 };
  assert.strictEqual(LocationResolverSkill.resolveWithCoordinates(c).status, "blocked");
  assert.strictEqual(LocationResolverSkill.resolveWithCoordinates({ ...c, approval: issueApproval("location-resolver", { latitude: 1, longitude: 2 }) }).status, "blocked");
  const ap = issueApproval("location-resolver", c);
  const ok = LocationResolverSkill.resolveWithCoordinates({ ...c, accuracy: 15, approval: ap });
  assert.strictEqual(ok.status, "completed");
  assert.strictEqual(ok.decision.state, "ENOUGH");
  assert.strictEqual(ok.artifacts[0].accuracy, 15);
  assert.strictEqual(ok.artifacts[1].url, "https://www.google.com/maps/search/?api=1&query=30.0444,31.2357");
  assert.strictEqual(LocationResolverSkill.resolveWithCoordinates({ ...c, approval: ap }).status, "blocked"); // مرة واحدة
});

test("إصلاح 6: الصفر صالح، والنطاق والنوع والحقن مرفوضة", () => {
  const run = (latitude, longitude) => LocationResolverSkill.resolveWithCoordinates({ latitude, longitude, approval: issueApproval("location-resolver", { latitude, longitude }) });
  assert.strictEqual(run(0, 0).status, "completed");
  assert.strictEqual(run(0, 31).status, "completed");
  assert.strictEqual(run(30, 0).status, "completed");
  for (const [la, lo] of [[null, 1], [91, 0], [0, 181], [-91, 0], [NaN, 1], [Infinity, 1], ["1&x=", 2], ["30", "31"], [undefined, undefined]]) {
    const r = run(la, lo);
    assert.strictEqual(r.status, "failed", `${la},${lo}`);
    assert.strictEqual(r.decision.state, "DEBUG");
  }
  assert.ok(!LocationResolverSkill.buildGoogleMapsUrl("1&x=", 2).includes("&x="));
});

// ---------- سلامة الصادرات ----------
test("module.exports يصدّر الأعضاء المتوقعة دون زيادة", () => {
  assert.deepEqual(Object.keys(O).sort(), [
    "EXTERNAL_CHANNELS", "LocationResolverSkill", "ORCHESTRATOR_STATES", "hashArgs", "issueApproval", "RISK_LEVELS", "RecoveryRouter",
    "SKILL_STATUS", "SkillDiscovery", "SkillRegistry", "SkillTaskAdapter",
    "StateHandoff", "RiskGate", "createHandoff", "validateManifest",
  ].sort());
});
