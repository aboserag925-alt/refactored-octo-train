"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ToolManager } = require("../tools/ToolManager");
const { readFileTool } = require("../tools/readFileTool");
const { writeFileTool } = require("../tools/writeFileTool");

function tempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "abu-siraj-tools-"));
}

test("registers read_file and write_file", () => {
  const manager = new ToolManager({ logger: { error() {} } });
  manager.registerMany([readFileTool, writeFileTool]);
  assert.equal(manager.has("read_file"), true);
  assert.equal(manager.has("write_file"), true);
});

test("read_file reads UTF-8 only inside workspace", async () => {
  const root = tempWorkspace();
  fs.writeFileSync(path.join(root, "hello.txt"), "مرحبا أبو سراج", "utf8");
  const manager = new ToolManager({ logger: { error() {} } });
  manager.register(readFileTool);

  const result = await manager.execute("read_file", { path: "hello.txt" }, { workspaceRoot: root });
  assert.equal(result.ok, true);
  assert.equal(result.data.content, "مرحبا أبو سراج");

  const escaped = await manager.execute("read_file", { path: "../outside.txt" }, { workspaceRoot: root });
  assert.equal(escaped.ok, false);
});

test("read_file blocks symlink escape", async () => {
  const root = tempWorkspace();
  const outside = tempWorkspace();
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret", "utf8");
  fs.symlinkSync(outside, path.join(root, "escape"));
  const manager = new ToolManager({ logger: { error() {} } });
  manager.register(readFileTool);

  const result = await manager.execute("read_file", { path: "escape/secret.txt" }, { workspaceRoot: root });
  assert.equal(result.ok, false);
});

test("write_file requires approval", async () => {
  const root = tempWorkspace();
  const manager = new ToolManager({ logger: { error() {} } });
  manager.register(writeFileTool);

  const result = await manager.execute("write_file", { path: "a.txt", content: "x" }, { workspaceRoot: root });
  assert.equal(result.ok, false);
  assert.equal(result.code, "APPROVAL_REQUIRED");
  assert.equal(fs.existsSync(path.join(root, "a.txt")), false);
});

test("approved write_file writes inside workspace", async () => {
  const root = tempWorkspace();
  const manager = new ToolManager({ logger: { error() {} } });
  manager.register(writeFileTool);

  const result = await manager.execute(
    "write_file",
    { path: "notes/hello.txt", content: "v3" },
    { workspaceRoot: root, approved: true }
  );
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(path.join(root, "notes/hello.txt"), "utf8"), "v3");
});

test("write_file blocks traversal and symlink escape", async () => {
  const root = tempWorkspace();
  const outside = tempWorkspace();
  fs.symlinkSync(outside, path.join(root, "escape"));
  const manager = new ToolManager({ logger: { error() {} } });
  manager.register(writeFileTool);

  const traversal = await manager.execute(
    "write_file", { path: "../bad.txt", content: "bad" }, { workspaceRoot: root, approved: true }
  );
  assert.equal(traversal.ok, false);

  const symlink = await manager.execute(
    "write_file", { path: "escape/bad.txt", content: "bad" }, { workspaceRoot: root, approved: true }
  );
  assert.equal(symlink.ok, false);
  assert.equal(fs.existsSync(path.join(outside, "bad.txt")), false);
});

test("write_file rejects content larger than one MiB", async () => {
  const root = tempWorkspace();
  const manager = new ToolManager({ logger: { error() {} } });
  manager.register(writeFileTool);
  const content = "x".repeat(1024 * 1024 + 1);
  const result = await manager.execute(
    "write_file", { path: "large.txt", content }, { workspaceRoot: root, approved: true }
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_INPUT");
});
