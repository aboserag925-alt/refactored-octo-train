// ============================================================
// أبو سراج - Orchestrator كامل في ملف واحد - CommonJS
// يحتوي: contracts + RiskGate + StateHandoff + RecoveryRouter
// + SkillRegistry + SkillDiscovery + SkillTaskAdapter
// + location-resolver (دورتين)
// متوافق مع Node.js 20+ و node --test
// ============================================================

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
  DEPLOY: "deploy",
  DESTRUCTIVE: "destructive",
});
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
  verification = { passed: true },
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
      case "read-only":
        return { allowed: true, decision: "continue", risk };
      case RISK_LEVELS.WRITE:
      case "write":
        return { allowed: true, decision: "policy_check", risk, note: "Apply PolicyEngine" };
      case RISK_LEVELS.LOCATION_SENSITIVE:
      case "location-sensitive":
        return {
          allowed: false,
          decision: ORCHESTRATOR_STATES.NEED_APPROVAL,
          risk,
          reason: "Location access requires explicit user consent via device geolocation",
          ui: "location_permission_card",
          approvalType: "location",
        };
      case RISK_LEVELS.DEPLOY:
      case "deploy":
      case RISK_LEVELS.DESTRUCTIVE:
      case "destructive":
        return {
          allowed: false,
          decision: ORCHESTRATOR_STATES.NEED_APPROVAL,
          risk,
          reason: `Risk level ${risk} requires explicit approval`,
          ui: "approval_card",
          approvalType: risk,
        };
      default:
        return { allowed: true, decision: "continue", risk };
    }
  }
}
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
      default:
        return { action: "continue", next: handoff.next };
    }
  }
}

// -------------------- SkillRegistry.js --------------------
class SkillRegistry {
  constructor(skillsRoot = ".agents/skills") {
    this.skillsRoot = skillsRoot;
    this.skills = new Map();
    this.graph = new Map();
  }
  loadAll() {
    const fs = require("fs");
    const path = require("path");
    if (!fs.existsSync(this.skillsRoot)) return this;
    const dirs = fs.readdirSync(this.skillsRoot, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
    for (const dir of dirs) {
      const manifestPath = path.join(this.skillsRoot, dir, "manifest.yaml");
      if (!fs.existsSync(manifestPath)) continue;
      const raw = fs.readFileSync(manifestPath, "utf8");
      let manifest = { name: dir, description: raw, triggers: [], policy: { risk: "read-only" } };
      try {
        const yaml = require("js-yaml");
        const parsed = yaml.load(raw);
        Object.assign(manifest, parsed);
      } catch (e) {}
      this.skills.set(manifest.name, manifest);
      this.graph.set(manifest.name, {
        requires: manifest.inputs?.requires || [],
        produces: manifest.outputs?.produces || [],
        may_transition_to: manifest.outputs?.may_transition_to || [],
        risk: manifest.policy?.risk || "read-only",
      });
    }
    return this;
  }
  getDiscoveryView() {
    return Array.from(this.skills.values()).map(m => ({
      name: m.name,
      description: m.description,
      triggers: m.triggers || [],
      risk: m.policy?.risk || m.risk || "read-only",
    }));
  }
  get(name) { return this.skills.get(name); }
  getGraph() { return this.graph; }
  // للاختبار اليدوي بدون ملفات
  register(manifest) {
    validateManifest(manifest);
    this.skills.set(manifest.name, manifest);
    this.graph.set(manifest.name, {
      requires: manifest.inputs?.requires || [],
      produces: manifest.outputs?.produces || [],
      may_transition_to: manifest.outputs?.may_transition_to || [],
      risk: manifest.policy?.risk || "read-only",
    });
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
        if (goalLower.includes(t.toLowerCase())) {
          score += 3;
          reason.push(`trigger match: "${t}"`);
        }
      }
      for (const t of triggersFromUser) {
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
  constructor(registry, agentLoop) {
    this.registry = registry;
    this.agentLoop = agentLoop;
  }
  async executeSkill(skillName, context = {}) {
    const manifest = this.registry.get(skillName);
    if (!manifest) {
      return createHandoff({
        skill: skillName,
        status: "failed",
        summary: `Skill not found: ${skillName}`,
        verification: { passed: false },
        decision: {
          state: ORCHESTRATOR_STATES.DEBUG,
          reason: `Skill not found: ${skillName}`,
          confidence: 1.0,
        },
      });
    }
    const risk = manifest.policy?.risk || manifest.risk || "read-only";
    const riskCheck = RiskGate.evaluate(risk);
    if (risk === "location-sensitive") {
      if (!context.artifacts || !context.artifacts.find(a => a.type === "location")) {
        return createHandoff({
          skill: skillName,
          status: "blocked",
          summary: riskCheck.reason,
          verification: { passed: false },
          decision: {
            state: ORCHESTRATOR_STATES.NEED_APPROVAL,
            reason: riskCheck.reason,
            confidence: 1.0,
            approvalType: "location",
          },
          artifacts: [{
            type: "approval_request",
            approvalType: "location",
            skill: skillName,
            risk: "location-sensitive",
            ui: "location_permission_card",
          }],
        });
      }
    }
    if (!riskCheck.allowed && !context.approved) {
      return createHandoff({
        skill: skillName,
        status: "blocked",
        summary: riskCheck.reason,
        verification: { passed: false },
        decision: {
          state: ORCHESTRATOR_STATES.NEED_APPROVAL,
          reason: riskCheck.reason,
          confidence: 1.0,
          approvalType: riskCheck.approvalType,
        },
        artifacts: [{
          type: "approval_request",
          approvalType: riskCheck.approvalType,
          skill: skillName,
          risk,
        }],
      });
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
        decision: {
          state: ORCHESTRATOR_STATES.DEBUG,
          reason: err.message,
          confidence: 0.9,
        },
      });
    }
  }
  normalizeToHandoff(skillName, raw) {
    if (raw.decision && Object.values(ORCHESTRATOR_STATES).includes(raw.decision.state)) {
      return StateHandoff.normalize(raw);
    }
    return createHandoff({
      skill: skillName,
      status: raw.status || "completed",
      summary: raw.summary || "",
      artifacts: raw.artifacts || [],
      findings: raw.findings || [],
      verification: raw.verification || { passed: true },
      decision: raw.decision || {
        state: ORCHESTRATOR_STATES.CONTINUE,
        reason: "Skill completed",
        confidence: 1.0,
      },
      next: raw.next || null,
    });
  }
}

// -------------------- location-resolver Skill --------------------
class LocationResolverSkill {
  static buildGoogleMapsUrl(lat, lng) {
    return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
  }
  static buildDirectionsUrl(lat, lng) {
    return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
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
  static resolveWithCoordinates({ latitude, longitude, accuracy }) {
    if (!latitude || !longitude) {
      return createHandoff({
        skill: "location-resolver",
        status: "failed",
        summary: "Invalid coordinates from client",
        verification: { passed: false },
        decision: {
          state: ORCHESTRATOR_STATES.DEBUG,
          reason: "Client returned empty coordinates",
          confidence: 0.9,
        },
      });
    }
    return createHandoff({
      skill: "location-resolver",
      status: "completed",
      summary: `Location resolved: ${latitude}, ${longitude}`,
      verification: { passed: true },
      decision: {
        state: ORCHESTRATOR_STATES.ENOUGH,
        reason: "Location resolved",
        confidence: 1.0,
      },
      artifacts: [
        { type: "location", latitude, longitude, accuracy: accuracy || null },
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
};
