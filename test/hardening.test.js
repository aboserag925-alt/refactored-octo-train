"use strict";
// اختبارات للإصلاحات: نص الرد، مسار البث حسب الوثائق، حذف الجلسة، CSRF، DNS rebinding، حفظ الـtaint.
// تستخدم curl مزيّفًا يحاكي أشكال الأحداث الموثّقة في Agents API؛ لا تحتاج مفتاحًا ولا شبكة.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const http = require("node:http");
const { spawn } = require("node:child_process");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "aboserag-hardening-"));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const delay = ms => new Promise(r => setTimeout(r, ms));

test("collectText keeps only output text, once, ignoring reasoning summaries", () => {
  process.env.NODE_ENV = "test"; process.env.ABOSERAG_DATA_DIR = path.join(root, "unit-data"); process.env.ABOSERAG_WORKSPACE_DIR = path.join(root, "unit-ws");
  process.env.ACCESS_PASSWORD = ""; process.env.HOST = "127.0.0.1";
  const { collectText, taintedSessions, persistTaint } = require("../server.js");
  const st = { answer: "", parts: new Map() };
  for (const e of [
    { type: "agent.session.turn.reasoning_summary_text.delta", delta: "thinking about it" },
    { type: "agent.session.turn.reasoning_summary_text.done", text: "thinking about it" },
    { type: "agent.session.turn.output_text.delta", item_id: "m1", content_index: 0, delta: "Hel" },
    { type: "agent.session.turn.output_text.delta", item_id: "m1", content_index: 0, delta: "lo" },
    { type: "agent.session.turn.output_text.done", item_id: "m1", content_index: 0, text: "Hello" },
    { type: "agent.session.turn.output_text.done", item_id: "m2", content_index: 0, text: "Second" },
  ]) collectText(st, e);
  assert.equal(st.answer, "Hello\n\nSecond");
  taintedSessions.add("sess_taint"); persistTaint();
  assert.match(fs.readFileSync(path.join(root, "unit-data", "tainted.json"), "utf8"), /sess_taint/);
});

test("end to end with a fake curl: streaming answer, live stream URL per docs, remote delete, CSRF and Host guards", async t => {
  const bin = path.join(root, "bin"), log = path.join(root, "curl.log"); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "curl"), `#!/usr/bin/env node
const fs = require("fs"); const a = process.argv.slice(2);
const url = a.find(x => /^https?:/.test(x)); const mi = a.indexOf("-X"); const method = mi >= 0 ? a[mi + 1] : "GET";
const accept = a.some((x, i) => x === "-H" && /^Accept: text\\/event-stream$/i.test(a[i + 1] || ""));
fs.appendFileSync(process.env.FAKE_CURL_LOG, JSON.stringify({ method, url, accept }) + "\\n");
const sse = list => process.stdout.write(list.map(e => "data: " + JSON.stringify(e) + "\\n\\n").join(""));
const out = (o) => process.stdout.write(JSON.stringify(o));
const u = new URL(url), p = u.pathname;
if (method === "POST" && p === "/v1/agents") out({ id: "agent_1" });
else if (method === "POST" && p === "/v1/agents/sessions") sse([
  { type: "agent.session.created", id: "sess_1" },
  { type: "agent.session.turn.reasoning_summary_text.delta", delta: "thinking" },
  { type: "agent.session.turn.output_text.delta", item_id: "m1", content_index: 0, delta: "Hel" },
  { type: "agent.session.turn.output_text.delta", item_id: "m1", content_index: 0, delta: "lo" },
  { type: "agent.session.turn.output_text.done", item_id: "m1", content_index: 0, text: "Hello" },
  { type: "agent.session.turn.completed", turn: { subagent_id: null } }]);
else if (method === "GET" && p === "/v1/agents/sessions/sess_1/events") {
  if (u.searchParams.get("stream") !== "true" || !accept) out({ data: [] });
  else sse([{ type: "agent.session.turn.output_text.done", item_id: "m2", content_index: 0, text: "Again" }, { type: "agent.session.turn.completed", turn: { subagent_id: null } }]);
} else out({ ok: true });
`, { mode: 0o755 });
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { cwd: path.join(__dirname, ".."), env: { ...process.env, NODE_ENV: "", PORT: String(port), HOST: "127.0.0.1", ACCESS_PASSWORD: "", OPENAI_API_KEY: "sk-test", PATH: bin + path.delimiter + process.env.PATH, FAKE_CURL_LOG: log, ABOSERAG_DATA_DIR: path.join(root, "e2e-data"), ABOSERAG_WORKSPACE_DIR: path.join(root, "e2e-ws") }, stdio: "ignore" });
  t.after(() => child.kill());
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 40; i++) { try { if ((await fetch(base + "/api/health")).ok) break; } catch {} await delay(100); }
  const frames = text => text.split("\n\n").map(f => ({ ev: (f.match(/^event: (.*)$/m) || [])[1], data: (f.match(/^data: (.*)$/m) || [])[1] })).filter(f => f.ev && f.data).map(f => ({ ev: f.ev, data: JSON.parse(f.data) }));
  const chat = async body => { const r = await fetch(base + "/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return frames(await r.text()); };

  const first = await chat({ message: "hi" });
  assert.equal(first.find(f => f.ev === "done").data.answer, "Hello");
  assert.equal(first.find(f => f.ev === "done").data.sessionId, "sess_1");
  const second = await chat({ message: "again", sessionId: "sess_1" });
  assert.equal(second.find(f => f.ev === "done").data.answer, "Again");
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  const live = calls.find(c => c.method === "GET" && c.url.includes("/sessions/sess_1/events"));
  assert.ok(live && live.url.includes("stream=true") && live.accept, "live stream must use ?stream=true and Accept: text/event-stream");

  await fetch(base + "/api/reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: "sess_1" }) });
  await delay(400);
  assert.ok(fs.readFileSync(log, "utf8").includes('"method":"DELETE"'), "reset must delete the remote session");

  const evil = await fetch(base + "/api/chat", { method: "POST", headers: { "content-type": "application/json", origin: "http://evil.example" }, body: JSON.stringify({ message: "x" }) });
  assert.equal(evil.status, 403);
  const simple = await fetch(base + "/api/chat", { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ message: "x" }) });
  assert.equal(simple.status, 415);
  const rebinding = await new Promise(resolve => http.get({ host: "127.0.0.1", port, path: "/api/integrations", headers: { host: "evil.example" } }, res => { res.resume(); resolve(res.statusCode); }));
  assert.equal(rebinding, 403);
});
