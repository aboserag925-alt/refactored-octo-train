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
} = O;

// ---------- contracts ----------
test("ORCHESTRATOR_STATES و RISK_LEVELS و SKILL_STATUS قيم مجمدة ومتوقعة", () => {
  assert.deepEqual(Object.values(ORCHESTRATOR_STATES), ["CONTINUE", "ENOUGH", "DEBUG", "REPLAN", "BLOCKED", "NEED_APPROVAL"]);
  assert.deepEqual(Object.values(RISK_LEVELS), ["read-only", "write", "location-sensitive", "deploy", "destructive"]);
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
  assert.deepEqual(h.verification, { passed: true });
  assert.strictEqual(h.decision.state, "CONTINUE");
  assert.strictEqual(h.next, null);
  assert.ok(typeof h.timestamp === "string");
  assert.throws(() => createHandoff({ skill: "x", decision: { state: "NOT_A_STATE", reason: "", confidence: 1 } }),
    /Invalid decision\.state: NOT_A_STATE/);
});

// ---------- RiskGate ----------
test("RiskGate.evaluate: read-only و write يسمح، والباقي يحتاج موافقة", () => {
  assert.deepEqual(RiskGate.evaluate("read-only"), { allowed: true, decision: "continue", risk: "read-only" });
  assert.deepEqual(RiskGate.evaluate(RISK_LEVELS.READ_ONLY), { allowed: true, decision: "continue", risk: "read-only" });
  const w = RiskGate.evaluate("write");
  assert.strictEqual(w.allowed, true);
  assert.strictEqual(w.decision, "policy_check");
  assert.strictEqual(w.note, "Apply PolicyEngine");
  const loc = RiskGate.evaluate("location-sensitive");
  assert.strictEqual(loc.allowed, false);
  assert.strictEqual(loc.decision, "NEED_APPROVAL");
  assert.strictEqual(loc.ui, "location_permission_card");
  assert.strictEqual(loc.approvalType, "location");
  assert.strictEqual(loc.reason, "Location access requires explicit user consent via device geolocation");
  for (const r of ["deploy", "destructive"]) {
    const d = RiskGate.evaluate(r);
    assert.strictEqual(d.allowed, false);
    assert.strictEqual(d.decision, "NEED_APPROVAL");
    assert.strictEqual(d.approvalType, r);
    assert.strictEqual(d.reason, `Risk level ${r} requires explicit approval`);
  }
  assert.deepEqual(RiskGate.evaluate("anything-else"), { allowed: true, decision: "continue", risk: "anything-else" });
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
  assert.deepEqual(reg.getGraph().get("reader"), { requires: [], produces: [], may_transition_to: [], risk: "read-only" });
  const view = reg.getDiscoveryView();
  assert.strictEqual(view.length, 2);
  const loc = view.find(v => v.name === "location-resolver");
  assert.strictEqual(loc.risk, "location-sensitive");
  assert.deepEqual(loc.triggers, ["my location", "open google map"]);
  const reader = view.find(v => v.name === "reader");
  assert.strictEqual(reader.risk, "read-only");
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

test("executeSkill: read-only ينفذ مباشرة عبر agentLoop", async () => {
  const loop = makeLoop();
  const out = await new SkillTaskAdapter(makeReg(), loop).executeSkill("reader", { raw: { summary: "done" } });
  assert.strictEqual(loop.calls.length, 1);
  assert.strictEqual(out.status, "completed");
  assert.strictEqual(out.summary, "done");
  assert.strictEqual(out.decision.state, "CONTINUE");
  assert.strictEqual(out.decision.reason, "Skill completed");
  assert.strictEqual(out.verification.passed, true);
});

test("executeSkill: write ينفذ دون موافقة مسبقة (قرار policy_check فقط)", async () => {
  const loop = makeLoop();
  const out = await new SkillTaskAdapter(makeReg(), loop).executeSkill("writer", { raw: {} });
  assert.strictEqual(loop.calls.length, 1);
  assert.strictEqual(out.status, "completed");
});

test("executeSkill: location-sensitive بدون إحداثيات ولا موافقة يرجع blocked مع طلب موافقة", async () => {
  const loop = makeLoop();
  const out = await new SkillTaskAdapter(makeReg(), loop).executeSkill("locator", {});
  assert.strictEqual(out.status, "blocked");
  assert.strictEqual(out.decision.state, "NEED_APPROVAL");
  assert.strictEqual(out.decision.approvalType, "location");
  assert.strictEqual(out.artifacts[0].type, "approval_request");
  assert.strictEqual(out.artifacts[0].ui, "location_permission_card");
  assert.strictEqual(loop.calls.length, 0);
});

test("executeSkill: location-sensitive مع إحداثيات لكن بدون موافقة صريحة يظل blocked", async () => {
  const loop = makeLoop();
  const out = await new SkillTaskAdapter(makeReg(), loop)
    .executeSkill("locator", { artifacts: [{ type: "location", latitude: 1, longitude: 2 }] });
  assert.strictEqual(out.status, "blocked");
  assert.strictEqual(out.decision.state, "NEED_APPROVAL");
  assert.strictEqual(out.artifacts[0].ui, undefined);
  assert.strictEqual(loop.calls.length, 0);
});

test("executeSkill: location-sensitive مع إحداثيات وموافقة ينفذ", async () => {
  const loop = makeLoop();
  const out = await new SkillTaskAdapter(makeReg(), loop)
    .executeSkill("locator", { approved: true, artifacts: [{ type: "location" }], raw: { summary: "ok" } });
  assert.strictEqual(loop.calls.length, 1);
  assert.strictEqual(out.status, "completed");
});

test("executeSkill: deploy بدون موافقة blocked، ومع موافقة ينفذ", async () => {
  const loop = makeLoop();
  const ad = new SkillTaskAdapter(makeReg(), loop);
  const blocked = await ad.executeSkill("deployer", {});
  assert.strictEqual(blocked.status, "blocked");
  assert.strictEqual(blocked.decision.approvalType, "deploy");
  assert.strictEqual(blocked.artifacts[0].type, "approval_request");
  assert.strictEqual(blocked.artifacts[0].risk, "deploy");
  assert.strictEqual(loop.calls.length, 0);
  const ok = await ad.executeSkill("deployer", { approved: true, raw: {} });
  assert.strictEqual(ok.status, "completed");
  assert.strictEqual(loop.calls.length, 1);
});

test("executeSkill: خطأ من agentLoop يرجع failed مع DEBUG ورسالة الخطأ", async () => {
  const out = await new SkillTaskAdapter(makeReg(), makeLoop()).executeSkill("reader", { boom: true });
  assert.strictEqual(out.status, "failed");
  assert.strictEqual(out.summary, "boom");
  assert.strictEqual(out.decision.state, "DEBUG");
  assert.strictEqual(out.decision.confidence, 0.9);
});

test("normalizeToHandoff: raw فيه decision صالح يمر كما هو", async () => {
  const raw = { decision: { state: "ENOUGH", reason: "كفى", confidence: 1 }, status: "completed" };
  const out = await new SkillTaskAdapter(makeReg(), makeLoop()).executeSkill("reader", { raw });
  assert.strictEqual(out, raw);
  assert.strictEqual(out.decision.state, "ENOUGH");
  assert.strictEqual(out.decision.reason, "كفى");
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

test("LocationResolverSkill.resolveWithCoordinates: إحداثيات فاضية تفشل، والصحيحة تنجح مع ENOUGH", () => {
  const bad = LocationResolverSkill.resolveWithCoordinates({ latitude: null, longitude: 1 });
  assert.strictEqual(bad.status, "failed");
  assert.strictEqual(bad.decision.state, "DEBUG");
  assert.strictEqual(bad.summary, "Invalid coordinates from client");
  const ok = LocationResolverSkill.resolveWithCoordinates({ latitude: 30.0444, longitude: 31.2357, accuracy: 15 });
  assert.strictEqual(ok.status, "completed");
  assert.strictEqual(ok.decision.state, "ENOUGH");
  assert.strictEqual(ok.summary, "Location resolved: 30.0444, 31.2357");
  assert.strictEqual(ok.artifacts[0].type, "location");
  assert.strictEqual(ok.artifacts[0].accuracy, 15);
  assert.strictEqual(ok.artifacts[1].type, "maps_action");
  assert.strictEqual(ok.artifacts[1].url, "https://www.google.com/maps/search/?api=1&query=30.0444,31.2357");
  assert.strictEqual(ok.artifacts[1].directionsUrl, "https://www.google.com/maps/dir/?api=1&destination=30.0444,31.2357");
  const noAcc = LocationResolverSkill.resolveWithCoordinates({ latitude: 1, longitude: 2 });
  assert.strictEqual(noAcc.artifacts[0].accuracy, null);
});

// ---------- سلامة الصادرات ----------
test("module.exports يصدّر الأعضاء الاثني عشر المتوقعة دون زيادة", () => {
  assert.deepEqual(Object.keys(O).sort(), [
    "LocationResolverSkill", "ORCHESTRATOR_STATES", "RISK_LEVELS", "RecoveryRouter",
    "SKILL_STATUS", "SkillDiscovery", "SkillRegistry", "SkillTaskAdapter",
    "StateHandoff", "RiskGate", "createHandoff", "validateManifest",
  ].sort());
});
