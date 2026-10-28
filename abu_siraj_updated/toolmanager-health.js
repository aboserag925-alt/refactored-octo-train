'use strict';

const fs = require('node:fs/promises');
const REQUIRED_TOOLS = ['read_file', 'write_file'];

function validateToolDefinition(toolManager, name) {
  const tool = toolManager.get(name);
  if (!tool) return { ok: false, registered: false };
  const issues = [];
  if (typeof tool.execute !== 'function') issues.push('execute_missing');
  if (!Array.isArray(tool.permissions)) issues.push('permissions_invalid');
  if (!['low', 'medium', 'high'].includes(tool.risk)) issues.push('risk_invalid');
  if (name === 'read_file' && !tool.permissions.includes('workspace.read')) issues.push('workspace_read_missing');
  if (name === 'write_file') {
    if (!tool.permissions.includes('workspace.write')) issues.push('workspace_write_missing');
    if (tool.requiresApproval !== true) issues.push('approval_not_required');
  }
  return { ok: issues.length === 0, registered: true, issues };
}

async function checkToolManagerHealth(toolManager, workspaceRoot) {
  let workspace = { ok: false, readable: false };
  try {
    const stat = await fs.stat(workspaceRoot);
    await fs.access(workspaceRoot, fs.constants.R_OK);
    workspace = { ok: stat.isDirectory(), readable: true, directory: stat.isDirectory() };
  } catch (error) {
    workspace = { ok: false, readable: false, error: error.code || 'WORKSPACE_CHECK_FAILED' };
  }
  const tools = Object.fromEntries(REQUIRED_TOOLS.map(name => [name, validateToolDefinition(toolManager, name)]));
  const ok = workspace.ok && REQUIRED_TOOLS.every(name => tools[name].ok);
  return { ok, workspace, tools };
}

module.exports = { checkToolManagerHealth, validateToolDefinition, REQUIRED_TOOLS };
