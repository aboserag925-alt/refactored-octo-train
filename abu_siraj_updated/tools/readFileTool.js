'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_FILE_BYTES = 1024 * 1024;

function resolveInsideWorkspace(workspaceRoot, requestedPath) {
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(root, requestedPath);
  const relative = path.relative(root, target);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Path is outside the workspace');
  }

  return { root, target, relative };
}

const readFileTool = {
  name: 'read_file',
  description: 'Read a UTF-8 text file from the Abu Siraj workspace',
  risk: 'low',
  permissions: ['workspace.read'],
  requiresApproval: false,

  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string', minLength: 1 },
    },
    required: ['path'],
  },

  validateInput(input) {
    if (!input || typeof input.path !== 'string' || !input.path.trim()) {
      return { ok: false, error: 'path is required' };
    }
    if (input.path.includes('\0')) {
      return { ok: false, error: 'path contains an invalid null byte' };
    }
    return { ok: true };
  },

  async execute(input, context = {}) {
    if (!context.workspaceRoot) {
      throw new Error('workspaceRoot is required in tool context');
    }

    const { root, target, relative } = resolveInsideWorkspace(
      context.workspaceRoot,
      input.path.trim()
    );

    // realpath checks prevent a symlink inside workspace from escaping it.
    const [realRoot, realTarget] = await Promise.all([
      fs.realpath(root),
      fs.realpath(target),
    ]);
    const realRelative = path.relative(realRoot, realTarget);
    if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
      throw new Error('Resolved path is outside the workspace');
    }

    const stat = await fs.stat(realTarget);
    if (!stat.isFile()) {
      throw new Error('Requested path is not a file');
    }
    if (stat.size > MAX_FILE_BYTES) {
      throw new Error(`File is too large; maximum is ${MAX_FILE_BYTES} bytes`);
    }

    const content = await fs.readFile(realTarget, 'utf8');

    return {
      path: relative || path.basename(realTarget),
      size: stat.size,
      encoding: 'utf8',
      content,
    };
  },
};

module.exports = { readFileTool, resolveInsideWorkspace, MAX_FILE_BYTES };
