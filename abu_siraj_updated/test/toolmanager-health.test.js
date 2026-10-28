"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ToolManager } = require("../tools/ToolManager");
const { registerBuiltinTools } = require("../tools/registerBuiltinTools");
const { checkToolManagerHealth } = require("../toolmanager-health");

test("health uses the live manager without filesystem side effects", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "abu-health-"));
  const manager = registerBuiltinTools(new ToolManager({ logger: { error() {} } }));
  const before = fs.readdirSync(root);
  const health = await checkToolManagerHealth(manager, root);
  assert.equal(health.ok, true);
  assert.deepEqual(fs.readdirSync(root), before);
});

test("health fails when live manager misses a required tool", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "abu-health-"));
  const manager = registerBuiltinTools(new ToolManager({ logger: { error() {} } }));
  manager.unregister("write_file");
  const health = await checkToolManagerHealth(manager, root);
  assert.equal(health.ok, false);
  assert.equal(health.tools.write_file.ok, false);
});
