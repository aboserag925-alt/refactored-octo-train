// ============================================================
// أبو سراج - Orchestrator كامل في ملف واحد - CommonJS
// يحتوي: contracts + RiskGate + StateHandoff + RecoveryRouter
// + SkillRegistry + SkillDiscovery + SkillTaskAdapter
// + location-resolver (دورتين)
// متوافق مع Node.js 20+ و node --test
// ============================================================

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// -------------------- contracts.js --------------------
const ORCHESTRATOR_STATES = Object.freeze({
  CONTINUE: "CONTINUE",
  ENOUGH: "ENOUGH",
  DEBUG: "DEBUG",
  REPLAN: "REPLAN",
  BLOCKED: "BLOCKED",
  NEED_APPROVAL: "NEED_APPROVAL",
});
const RISK_LEVELS = Object.freeze({
  READ_ONLY: "read-only",
  WRITE: "write",
  LOCATION_SENSITIVE: "location-sensitive",
  EXTERNAL_COMMUNICATION: "external-communication",
  DEPLOY: "deploy",
  DESTRUCTIVE: "destructive",
});
const EXTERNAL_CHANNELS = Object.freeze(["whatsapp", "telegram", "gmail"]);
// ترتيب الشدة: المانيفست والسجل المركزي يرفعان الخطر فقط ولا يخفضانه
const RISK_ORDER = Object.freeze([
  RISK_LEVELS.READ_ONLY,
  RISK_LEVELS.WRITE,
  RISK_LEVELS.LOCATION_SENSITIVE,
  RISK_LEVELS.EXTERNAL_COMMUNICATION,
  RISK_LEVELS.DEPLOY,
  RISK_LEVELS.DESTRUCTIVE,
]);
function isKnownRisk(r) { return RISK_ORDER.includes(r); }
function maxRisk(...risks) {
  let best = RISK_LEVELS.READ_ONLY;
  for (const r of risks) {
    if (r === undefined || r === null) continue;
    if (!isKnownRisk(r)) return r; // مجهول يبقى مجهولًا ليفشل مغلقًا في RiskGate
    if (RISK_ORDER.indexOf(r) > RISK_ORDER.indexOf(best)) best = r;
  }
  return best;
}
const SKILL_STATUS = Object.freeze({
  COMPLETED: "completed",
  FAILED: "failed",
  BLOCKED: "blocked",
});
function validateManifest(manifest) {
  const required = ["name", "description", "triggers"];
  for (const field of required) {
    if (!manifest[field]) throw new Error(`Manifest missing required field: ${field}`);
  }
  return true;
}
function createHandoff({
  skill,
  status = SKILL_STATUS.COMPLETED,
  summary = "",
  artifacts = [],
  findings = [],
  verification = { passed: false },
  decision = { state: ORCHESTRATOR_STATES.CONTINUE, reason: "", confidence: 1.0 },
  next = null,
}) {
  if (!Object.values(ORCHESTRATOR_STATES).includes(decision.state)) {
    throw new Error(`Invalid decision.state: ${decision.state}`);
  }
  return {
    skill,
    status,
    summary,
    artifacts,
    findings,
    verification,
    decision,
    next,
    timestamp: new Date().toISOString(),
  };
}

// -------------------- core.js --------------------
class RiskGate {
  static evaluate(risk) {
    switch (risk) {
      case RISK_LEVELS.READ_ONLY:
        return { allowed: true, decision: "continue", risk };
      case RISK_LEVELS.WRITE:
        return {
          allowed: false,
          decision: ORCHESTRATOR_STATES.NEED_APPROVAL,
          risk,
          reason: "Write actions require explicit approval",
          ui: "approval_card",
          approvalType: "write",
        };
      case RISK_LEVELS.LOCATION_SENSITIVE:
        return {
          allowed: false,
          decision: ORCHESTRATOR_STATES.NEED_APPROVAL,
          risk,
          reason: "Location access requires explicit user consent via device geolocation",
          ui: "location_permission_card",
          approvalType: "location",
        };
      case RISK_LEVELS.EXTERNAL_COMMUNICATION:
        return {
          allowed: false,
          decision: ORCHESTRATOR_STATES.NEED_APPROVAL,
          risk,
          reason: "External communication (send or read) requires explicit approval",
          ui: "approval_card",
          approvalType: "external-communication",
          channels: EXTERNAL_CHANNELS,
        };
      case RISK_LEVELS.DEPLOY:
      case RISK_LEVELS.DESTRUCTIVE:
        return {
          allowed: false,
          decision: ORCHESTRATOR_STATES.NEED_APPROVAL,
          risk,
          reason: `Risk level ${risk} requires explicit approval`,
          ui: "approval_card",
          approvalType: risk,
        };
      default: // فشل مغلق: أي قيمة مجهولة أو غائبة تحتاج موافقة
        return {
          allowed: false,
          decision: ORCHESTRATOR_STATES.NEED_APPROVAL,
          risk,
          reason: "Unknown risk level requires explicit approval",
          ui: "approval_card",
          approvalType: "unknown",
        };
    }
  }
}

// -------------------- Approvals (كائنية، مرة واحدة، مرتبطة بالمهارة والمعطيات) --------------------
const APPROVAL_SECRET = crypto.randomBytes(32);
const consumedApprovals = new Set();
function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
}
function hashArgs(args) {
  return crypto.createHash("sha256").update(stableStringify(args === undefined ? {} : args)).digest("hex");
}
function approvalSig(a) {
  return crypto.createHmac("sha256", APPROVAL_SECRET).update(`${a.id}|${a.skill}|${a.argsHash}|${a.expiresAt}`).digest("hex");
}
// تُستدعى فقط من معالج موافقة المستخدم (الواجهة)، لا من المهارات
function issueApproval(skill, args, { ttlMs = 5 * 60 * 1000, now = Date.now() } = {}) {
  const a = { id: crypto.randomUUID(), skill, argsHash: hashArgs(args), expiresAt: now + ttlMs, singleUse: true };
  a.sig = approvalSig(a);
  return a;
}
function checkApproval(approval, skill, args, now = Date.now()) {
  if (!approval || typeof approval !== "object") return { ok: false, reason: "No approval object" };
  if (approval.skill !== skill) return { ok: false, reason: "Approval is for a different skill" };
  if (approval.argsHash !== hashArgs(args)) return { ok: false, reason: "Approval does not match the arguments" };
  if (!Number.isFinite(approval.expiresAt) || approval.expiresAt <= now) return { ok: false, reason: "Approval expired" };
  if (typeof approval.sig !== "string" || approval.sig !== approvalSig(approval)) return { ok: false, reason: "Approval signature invalid" };
  if (consumedApprovals.has(approval.id)) return { ok: false, reason: "Approval already used" };
  return { ok: true };
}
function consumeApproval(approval) { consumedApprovals.add(approval.id); }
class StateHandoff {
  static normalize(rawOutput) {
    if (!rawOutput.decision || !Object.values(ORCHESTRATOR_STATES).includes(rawOutput.decision.state)) {
      throw new Error("Handoff must contain valid decision.state from ORCHESTRATOR_STATES");
    }
    return rawOutput;
  }
}
class RecoveryRouter {
  static route(handoff) {
    const state = handoff.decision.state;
    switch (state) {
      case ORCHESTRATOR_STATES.DEBUG:
        return { action: "route_to_debug", skill: "debugger", reason: handoff.decision.reason };
      case ORCHESTRATOR_STATES.REPLAN:
        return { action: "replan", reason: handoff.decision.reason };
      case ORCHESTRATOR_STATES.BLOCKED:
        return { action: "blocked", reason: handoff.decision.reason };
      case ORCHESTRATOR_STATES.NEED_APPROVAL:
        return { action: "await_approval", reason: handoff.decision.reason, approvalType: handoff.decision.approvalType };
      case ORCHESTRATOR_STATES.ENOUGH:
        return { action: "stop", reason: handoff.decision.reason };
      case ORCHESTRATOR_STATES.CONTINUE:
        return { action: "continue", next: handoff.next };
      default: // حالة مجهولة: لا نكمل
        return { action: "blocked", reason: `Unknown state: ${state}` };
    }
  }
}

// -------------------- SkillRegistry.js --------------------
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
function stripUnsafe(v) {
  if (Array.isArray(v)) return v.map(stripUnsafe);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v)) if (!UNSAFE_KEYS.has(k)) out[k] = stripUnsafe(v[k]);
    return out;
  }
  return v;
}
class SkillRegistry {
  // riskRegistry: سجل مركزي { اسم_المهارة: خطر } مستقل عن المانيفست، والمانيفست لا يخفضه
  constructor(skillsRoot = ".agents/skills", { workspaceRoot = process.cwd(), riskRegistry = {}, yamlParser = null } = {}) {
    this.skillsRoot = skillsRoot;
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.riskRegistry = new Map(Object.entries(riskRegistry));
    this.yamlParser = yamlParser;
    this.skills = new Map();
    this.graph = new Map();
    this.errors = [];
  }
  _parse(raw) {
    if (this.yamlParser) return this.yamlParser(raw);
    const yaml = require("js-yaml");
    // js-yaml 4: load آمن. js-yaml 3: safeLoad
    return typeof yaml.safeLoad === "function" ? yaml.safeLoad(raw) : yaml.load(raw);
  }
  effectiveRisk(manifest) {
    const declared = manifest.policy?.risk ?? manifest.risk;
    const central = this.riskRegistry.get(manifest.name);
    // غائب = write (يحتاج موافقة)، والمجهول يبقى مجهولًا فيفشل مغلقًا
    return maxRisk(declared === undefined ? RISK_LEVELS.WRITE : declared, central);
  }
  loadAll() {
    const root = path.resolve(this.workspaceRoot, this.skillsRoot);
    if (root !== this.workspaceRoot && !root.startsWith(this.workspaceRoot + path.sep)) {
      throw new Error(`skillsRoot escapes the workspace: ${this.skillsRoot}`);
    }
    if (!fs.existsSync(root)) return this;
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      if (d.isSymbolicLink() || !d.isDirectory()) continue; // رفض الروابط الرمزية
      const dir = d.name;
      const manifestPath = path.join(root, dir, "manifest.yaml");
      try {
        if (!fs.existsSync(manifestPath)) continue;
        if (fs.lstatSync(manifestPath).isSymbolicLink()) throw new Error("manifest is a symlink");
        const real = fs.realpathSync(manifestPath);
        if (!real.startsWith(fs.realpathSync(root) + path.sep)) throw new Error("manifest escapes skills root");
        const parsed = stripUnsafe(this._parse(fs.readFileSync(manifestPath, "utf8")));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("manifest is not an object");
        if (parsed.name !== dir) throw new Error(`manifest name "${parsed.name}" must equal folder name "${dir}"`);
        const risk = parsed.policy?.risk ?? parsed.risk;
        if (risk !== undefined && !isKnownRisk(risk)) throw new Error(`unknown risk "${risk}"`);
        this._store({
          name: parsed.name,
          description: parsed.description,
          triggers: parsed.triggers,
          inputs: parsed.inputs,
          outputs: parsed.outputs,
          policy: parsed.policy,
          risk: parsed.risk,
        });
      } catch (e) {
        this.errors.push({ skill: dir, error: e.message }); // لا نبتلع الخطأ، والمهارة المرفوضة لا تُحمَّل
      }
    }
    return this;
  }
  _store(manifest) {
    validateManifest(manifest);
    if (typeof manifest.name !== "string" || UNSAFE_KEYS.has(manifest.name)) throw new Error(`Invalid skill name: ${manifest.name}`);
    const declared = manifest.policy?.risk ?? manifest.risk;
    if (declared !== undefined && !isKnownRisk(declared)) throw new Error(`Unknown risk level: ${declared}`);
    if (this.skills.has(manifest.name)) throw new Error(`Duplicate skill name: ${manifest.name}`);
    this.skills.set(manifest.name, manifest);
    this.graph.set(manifest.name, {
      requires: manifest.inputs?.requires || [],
      produces: manifest.outputs?.produces || [],
      may_transition_to: manifest.outputs?.may_transition_to || [],
      risk: this.effectiveRisk(manifest),
    });
  }
  getDiscoveryView() {
    return Array.from(this.skills.values()).map(m => ({
      name: m.name,
      description: m.description,
      triggers: m.triggers || [],
      risk: this.effectiveRisk(m),
    }));
  }
  get(name) { return this.skills.get(name); }
  getRisk(name) { const m = this.skills.get(name); return m ? this.effectiveRisk(m) : undefined; }
  getGraph() { return this.graph; }
  // للاختبار اليدوي بدون ملفات
  register(manifest) {
    this._store(manifest);
    return this;
  }
}

// -------------------- SkillDiscovery.js --------------------
class SkillDiscovery {
  constructor(discoveryView) {
    this.view = discoveryView;
  }
  discover(goal, triggersFromUser = []) {
    const goalLower = (goal || "").toLowerCase();
    const scored = [];
    for (const skill of this.view) {
      let score = 0;
      let reason = [];
      for (const t of (skill.triggers || [])) {
        if (typeof t !== "string" || t.trim() === "") continue; // trigger فارغ لا يطابق كل شيء
        if (goalLower.includes(t.toLowerCase())) {
          score += 3;
          reason.push(`trigger match: "${t}"`);
        }
      }
      for (const t of triggersFromUser) {
        if (typeof t !== "string" || t.trim() === "") continue;
        if ((skill.triggers || []).includes(t)) {
          score += 2;
          reason.push(`user trigger: "${t}"`);
        }
      }
      if (score > 0) {
        scored.push({
          name: skill.name,
          description: skill.description,
          risk: skill.risk,
          score,
          reason: reason.join(", "),
        });
      }
    }
    return scored.sort((a, b) => b.score - a.score);
  }
}

// -------------------- SkillTaskAdapter.js --------------------
class SkillTaskAdapter {
  constructor(registry, agentLoop, { allowMock = false } = {}) {
    this.registry = registry;
    this.agentLoop = agentLoop;
    this.allowMock = allowMock;
  }
  _blocked(skillName, risk, riskCheck, extraReason) {
    const reason = extraReason ? `${riskCheck.reason} (${extraReason})` : riskCheck.reason;
    return createHandoff({
      skill: skillName,
      status: "blocked",
      summary: reason,
      verification: { passed: false },
      decision: { state: ORCHESTRATOR_STATES.NEED_APPROVAL, reason, confidence: 1.0, approvalType: riskCheck.approvalType },
      artifacts: [{
        type: "approval_request",
        approvalType: riskCheck.approvalType,
        skill: skillName,
        risk,
        ...(riskCheck.ui ? { ui: riskCheck.ui } : {}),
        ...(riskCheck.channels ? { channels: riskCheck.channels } : {}),
      }],
    });
  }
  // context.args: معطيات التنفيذ، context.approval: كائن من issueApproval
  async executeSkill(skillName, context = {}) {
    const manifest = this.registry.get(skillName);
    if (!manifest) {
      return createHandoff({
        skill: skillName,
        status: "failed",
        summary: `Skill not found: ${skillName}`,
        verification: { passed: false },
        decision: { state: ORCHESTRATOR_STATES.DEBUG, reason: `Skill not found: ${skillName}`, confidence: 1.0 },
      });
    }
    const risk = this.registry.getRisk(skillName);
    const riskCheck = RiskGate.evaluate(risk);
    let approval = null;
    if (!riskCheck.allowed) {
      if (risk === RISK_LEVELS.LOCATION_SENSITIVE && !(context.artifacts || []).some(a => a && a.type === "location")) {
        return this._blocked(skillName, risk, riskCheck);
      }
      const chk = checkApproval(context.approval, skillName, context.args);
      if (!chk.ok) return this._blocked(skillName, risk, riskCheck, chk.reason);
      approval = context.approval;
      consumeApproval(approval); // استخدام واحد فقط
    }
    try {
      const raw = await this.agentLoop.executeSkill(skillName, context);
      return this.normalizeToHandoff(skillName, raw);
    } catch (err) {
      return createHandoff({
        skill: skillName,
        status: "failed",
        summary: err.message,
        verification: { passed: false },
        decision: { state: ORCHESTRATOR_STATES.DEBUG, reason: err.message, confidence: 0.9 },
      });
    }
  }
  normalizeToHandoff(skillName, raw) {
    if (!raw || typeof raw !== "object") {
      return createHandoff({
        skill: skillName,
        status: "failed",
        summary: "Skill returned no result",
        verification: { passed: false },
        decision: { state: ORCHESTRATOR_STATES.DEBUG, reason: "Empty skill output", confidence: 0.9 },
      });
    }
    if (raw.mock === true && !this.allowMock) {
      return createHandoff({
        skill: skillName,
        status: "failed",
        summary: "Mock output rejected outside tests",
        verification: { passed: false },
        decision: { state: ORCHESTRATOR_STATES.DEBUG, reason: "Mock output is not a real result", confidence: 1.0 },
      });
    }
    const verified = !!(raw.verification && raw.verification.passed === true);
    const hasState = raw.decision && Object.values(ORCHESTRATOR_STATES).includes(raw.decision.state);
    if (hasState) {
      StateHandoff.normalize(raw);
      if (verified) return raw;
      // قرار صالح بلا تحقق: لا يُعتبر مكتملًا ومتحققًا منه
      const state = raw.decision.state === ORCHESTRATOR_STATES.ENOUGH ? ORCHESTRATOR_STATES.REPLAN : raw.decision.state;
      return { ...raw, verification: { ...(raw.verification || {}), passed: false }, decision: { ...raw.decision, state } };
    }
    return createHandoff({
      skill: skillName,
      status: raw.status || "completed",
      summary: raw.summary || "",
      artifacts: raw.artifacts || [],
      findings: raw.findings || [],
      verification: verified ? raw.verification : { ...(raw.verification || {}), passed: false },
      decision: raw.decision || { state: ORCHESTRATOR_STATES.CONTINUE, reason: "Skill completed", confidence: 1.0 },
      next: raw.next || null,
    });
  }
}

// -------------------- location-resolver Skill --------------------
class LocationResolverSkill {
  static isValidCoordinates(lat, lng) {
    return typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng) &&
      lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
  }
  static buildGoogleMapsUrl(lat, lng) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lat)},${encodeURIComponent(lng)}`;
  }
  static buildDirectionsUrl(lat, lng) {
    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(lat)},${encodeURIComponent(lng)}`;
  }
  static requestApproval() {
    return createHandoff({
      skill: "location-resolver",
      status: "blocked",
      summary: "Location permission required via device",
      verification: { passed: false },
      decision: {
        state: ORCHESTRATOR_STATES.NEED_APPROVAL,
        reason: "Requesting location via navigator.geolocation on client device",
        confidence: 1.0,
        approvalType: "location",
      },
      artifacts: [{ type: "approval_request", approvalType: "location", provider: "google-maps" }],
    });
  }
  // يتطلب كائن موافقة صالحًا للمهارة والإحداثيات نفسها، ويستهلكه
  static resolveWithCoordinates({ latitude, longitude, accuracy, approval } = {}) {
    const chk = checkApproval(approval, "location-resolver", { latitude, longitude });
    if (!chk.ok) {
      const h = LocationResolverSkill.requestApproval();
      h.summary = `Location permission required via device (${chk.reason})`;
      return h;
    }
    consumeApproval(approval);
    if (!LocationResolverSkill.isValidCoordinates(latitude, longitude)) {
      return createHandoff({
        skill: "location-resolver",
        status: "failed",
        summary: "Invalid coordinates from client",
        verification: { passed: false },
        decision: { state: ORCHESTRATOR_STATES.DEBUG, reason: "Client returned empty or invalid coordinates", confidence: 0.9 },
      });
    }
    return createHandoff({
      skill: "location-resolver",
      status: "completed",
      summary: `Location resolved: ${latitude}, ${longitude}`,
      verification: { passed: true },
      decision: { state: ORCHESTRATOR_STATES.ENOUGH, reason: "Location resolved", confidence: 1.0 },
      artifacts: [
        { type: "location", latitude, longitude, accuracy: Number.isFinite(accuracy) ? accuracy : null },
        {
          type: "maps_action",
          provider: "google-maps",
          url: LocationResolverSkill.buildGoogleMapsUrl(latitude, longitude),
          directionsUrl: LocationResolverSkill.buildDirectionsUrl(latitude, longitude),
        },
      ],
    });
  }
}

// -------------------- Example Usage --------------------
// const registry = new SkillRegistry();
// registry.register({
//   name: "location-resolver",
//   description: "Request user location and open in Google Maps",
//   triggers: ["حدد موقعي", "موقعي الحالي", "open google map", "my location"],
//   risk: "location-sensitive",
//   policy: { risk: "location-sensitive" }
// });
// const discovery = new SkillDiscovery(registry.getDiscoveryView());
// console.log(discovery.discover("حدد موقعي وافتح الخريطة"));

module.exports = {
  ORCHESTRATOR_STATES,
  RISK_LEVELS,
  EXTERNAL_CHANNELS,
  SKILL_STATUS,
  issueApproval,
  hashArgs,
  validateManifest,
  createHandoff,
  RiskGate,
  StateHandoff,
  RecoveryRouter,
  SkillRegistry,
  SkillDiscovery,
  SkillTaskAdapter,
  LocationResolverSkill,
};
