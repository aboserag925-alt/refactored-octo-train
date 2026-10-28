"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const vm = require("node:vm");
const { spawn } = require("node:child_process");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aboserag-agent-tests-"));
test.after(() => {
  const candidate = path.resolve(testRoot), tempRoot = path.resolve(os.tmpdir()) + path.sep;
  if (!candidate.startsWith(tempRoot)) throw new Error("Refusing to clean a test path outside the system temp folder.");
  fs.rmSync(candidate, { recursive: true, force: true });
});
process.env.NODE_ENV = "test";
process.env.ABOSERAG_DATA_DIR = path.join(testRoot, "unit-data");
process.env.ABOSERAG_WORKSPACE_DIR = path.join(testRoot, "unit-workspace");
process.env.OPENAI_PROJECT_ID = "proj_pztv7NZUGVHEzy2suKX5KU3N";
process.env.OPENAI_MODEL = "gpt-6-astra";
process.env.OPENAI_API_KEY = "put_your_key_here";
process.env.ENABLE_SHELL = "0";
process.env.ACCESS_PASSWORD = "";
process.env.HOST = "127.0.0.1";
process.env.GOOGLE_CLIENT_ID = "";
process.env.GOOGLE_CLIENT_SECRET = "";

const {
  CONFIG,
  FUNCTION_TOOLS,
  safeWorkspacePath,
  executeTool,
  actionNeedsApproval,
  guardedFetch,
  taintedSessions,
} = require("../server.js");

test("saved agent configuration keeps aboserag, model, project, and web search", () => {
  assert.equal(CONFIG.name, "aboserag");
  assert.equal(CONFIG.model, "gpt-6-astra");
  assert.equal(process.env.OPENAI_PROJECT_ID, "proj_pztv7NZUGVHEzy2suKX5KU3N");
  assert.ok(CONFIG.tools.some(tool => tool.type === "web_search"));
  assert.ok(CONFIG.tools.some(tool => tool.type === "function" && tool.name === "gmail_read"));
  assert.equal(CONFIG.multi_agent.enabled, false);
  assert.equal(FUNCTION_TOOLS.some(tool => tool.name === "run_command"), false);
});

test("browser JavaScript parses and the HTML keeps the installable app shell", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, "inline app script exists");
  assert.doesNotThrow(() => new vm.Script(match[1]));
  assert.match(html, /id="gmailBtn"/);
  assert.match(html, /id="loginOverlay"/);
  assert.match(html, /id="installBtn"/);
});

test("workspace tools read and write only within the isolated workspace", async () => {
  const outside = path.join(testRoot, "outside.txt");
  assert.throws(() => safeWorkspacePath("../../outside.txt"), /inside workspace/i);
  await executeTool("write_file", { path: "notes/check.txt", content: "hello" }, "unit-session");
  assert.equal(await executeTool("read_file", { path: "notes/check.txt" }, "unit-session"), "hello");
  assert.match(await executeTool("list_files", { path: "notes" }, "unit-session"), /check\.txt/);
  assert.equal(fs.existsSync(outside), false);
});

test("durable notes support remember, recall, and forget without storing secrets", async () => {
  const saved = await executeTool("remember", { text: "يفضل الرد بالعربية" }, "unit-session");
  assert.match(saved, /Saved note #1/);
  assert.match(await executeTool("recall", {}, "unit-session"), /يفضل الرد بالعربية/);
  assert.equal(await executeTool("forget", { id: 1 }, "unit-session"), "Note deleted.");
  assert.equal(await executeTool("recall", {}, "unit-session"), "(no saved notes)");
});

test("approval gates cover writes, optional shell, and URLs after email", () => {
  const sessionId = "tainted-test-session";
  assert.equal(actionNeedsApproval({ name: "write_file" }, sessionId), true);
  assert.equal(actionNeedsApproval({ name: "run_command" }, sessionId), true);
  assert.equal(actionNeedsApproval({ name: "fetch_url" }, sessionId), false);
  taintedSessions.add(sessionId);
  assert.equal(actionNeedsApproval({ name: "fetch_url" }, sessionId), true);
  taintedSessions.delete(sessionId);
});

test("URL reader rejects private network targets and Gmail stays optional", async () => {
  await assert.rejects(guardedFetch("http://127.0.0.1/"), /private and local/i);
  await assert.rejects(executeTool("gmail_search", { query: "is:unread" }, "unit-session"), /Gmail is not connected/i);
});

test("HTTP smoke: app shell, PWA assets, login, protected routes, and missing-key response", async t => {
  const port = await freePort();
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "aboserag-http-tests-"));
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      HOST: "127.0.0.1",
      ACCESS_PASSWORD: "test-password-123",
      OPENAI_API_KEY: "put_your_key_here",
      ABOSERAG_DATA_DIR: path.join(runtimeDir, "data"),
      ABOSERAG_WORKSPACE_DIR: path.join(runtimeDir, "workspace"),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let startupOutput = "";
  child.stdout.setEncoding("utf8").on("data", chunk => startupOutput += chunk);
  child.stderr.setEncoding("utf8").on("data", chunk => startupOutput += chunk);
  child.startupOutput = () => startupOutput;
  t.after(async () => {
    child.kill();
    await Promise.race([new Promise(resolve => child.once("exit", resolve)), delay(1500)]);
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  await waitForHealth(base, child);

  const health = await fetch(`${base}/api/health`).then(response => response.json());
  assert.equal(health.ok, true);
  assert.equal(health.apiKeyConfigured, false);
  assert.equal(health.loginRequired, true);
  assert.equal(health.authenticated, false);
  assert.equal(health.agentName, undefined, "unauthenticated health must not expose agent, project, model or shell details");
  assert.equal(health.projectId, undefined);
  assert.equal(health.shellEnabled, undefined);

  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /manifest\.webmanifest/);
  const manifest = await fetch(`${base}/manifest.webmanifest`).then(response => response.json());
  assert.equal(manifest.lang, "ar");
  assert.equal(manifest.display, "standalone");
  assert.equal((await fetch(`${base}/sw.js`)).status, 200);
  assert.equal((await fetch(`${base}/server.js`)).status, 404);

  assert.equal((await fetch(`${base}/api/integrations`)).status, 401);
  const wrongLogin = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "wrong" }) });
  assert.equal(wrongLogin.status, 401);
  const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test-password-123" }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  assert.equal((await fetch(`${base}/api/integrations`, { headers: { cookie } })).status, 200);
  const pending = await fetch(`${base}/api/pending?sessionId=fake-session`, { headers: { cookie } }).then(response => response.json());
  assert.equal(pending.pending, null);
  const noApproval = await fetch(`${base}/api/approve`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ sessionId: "fake-session", approve: true }) });
  assert.equal(noApproval.status, 409);
  const missingKey = await fetch(`${base}/api/chat`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ message: "اختبار بلا مفتاح" }) });
  assert.equal(missingKey.status, 503);
  const logout = await fetch(`${base}/api/logout`, { method: "POST", headers: { cookie } });
  assert.equal(logout.status, 200);
});

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => socket.once("error", reject).listen(0, "127.0.0.1", resolve));
  const { port } = socket.address();
  await new Promise(resolve => socket.close(resolve));
  return port;
}
async function waitForHealth(base, child) {
  const end = Date.now() + 8000;
  let lastError;
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error(`App exited before listening (code ${child.exitCode}): ${child.startupOutput()}`);
    try { const response = await fetch(`${base}/api/health`); if (response.ok) return; }
    catch (error) { lastError = error; }
    await delay(100);
  }
  throw new Error(`App did not become ready: ${lastError?.message || "timeout"}${lastError?.cause?.code ? ` (${lastError.cause.code})` : ""}. ${child.startupOutput()}`);
}
