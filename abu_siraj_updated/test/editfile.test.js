"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ToolManager } = require("../tools/ToolManager");
const { editFileTool } = require("../tools/editFileTool");

function tempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "abu-siraj-edit-"));
}
function manager() {
  const m = new ToolManager({ logger: { error() {} } });
  m.register(editFileTool);
  return m;
}
const approved = root => ({ workspaceRoot: root, approved: true });

test("edit_file requires approval and changes nothing without it", async () => {
  const root = tempWorkspace();
  fs.writeFileSync(path.join(root, "a.txt"), "one two", "utf8");
  const r = await manager().execute("edit_file", { path: "a.txt", old_text: "one", new_text: "1" }, { workspaceRoot: root });
  assert.equal(r.ok, false);
  assert.equal(r.code, "APPROVAL_REQUIRED");
  assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "one two");
});

test("edit_file replaces exactly one occurrence and keeps the rest", async () => {
  const root = tempWorkspace();
  fs.writeFileSync(path.join(root, "a.txt"), "مرحبا\nسطر ثاني\nآخر سطر\n", "utf8");
  const r = await manager().execute("edit_file", { path: "a.txt", old_text: "سطر ثاني", new_text: "سطر $& جديد" }, approved(root));
  assert.equal(r.ok, true);
  assert.equal(r.data.replaced, 1);
  assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "مرحبا\nسطر $& جديد\nآخر سطر\n");
});

test("edit_file errors clearly when old_text is not found", async () => {
  const root = tempWorkspace();
  fs.writeFileSync(path.join(root, "a.txt"), "hello", "utf8");
  const r = await manager().execute("edit_file", { path: "a.txt", old_text: "nope", new_text: "x" }, approved(root));
  assert.equal(r.ok, false);
  assert.match(r.error, /not found/);
  assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "hello");
});

test("edit_file refuses duplicated old_text and changes nothing", async () => {
  const root = tempWorkspace();
  fs.writeFileSync(path.join(root, "a.txt"), "x = 1\nx = 1\n", "utf8");
  const r = await manager().execute("edit_file", { path: "a.txt", old_text: "x = 1", new_text: "x = 2" }, approved(root));
  assert.equal(r.ok, false);
  assert.match(r.error, /more than once/);
  assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "x = 1\nx = 1\n");
});

test("edit_file blocks path traversal and symlink escape", async () => {
  const root = tempWorkspace();
  const outside = tempWorkspace();
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret", "utf8");
  fs.symlinkSync(outside, path.join(root, "escape"));
  const m = manager();

  const up = await m.execute("edit_file", { path: "../" + path.basename(outside) + "/secret.txt", old_text: "secret", new_text: "x" }, approved(root));
  assert.equal(up.ok, false);
  const link = await m.execute("edit_file", { path: "escape/secret.txt", old_text: "secret", new_text: "x" }, approved(root));
  assert.equal(link.ok, false);
  assert.equal(fs.readFileSync(path.join(outside, "secret.txt"), "utf8"), "secret");
});

test("edit_file does not create missing files", async () => {
  const root = tempWorkspace();
  const r = await manager().execute("edit_file", { path: "missing.txt", old_text: "a", new_text: "b" }, approved(root));
  assert.equal(r.ok, false);
  assert.equal(fs.existsSync(path.join(root, "missing.txt")), false);
});
