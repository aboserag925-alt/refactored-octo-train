'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_WRITE_BYTES = 1024 * 1024;

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function resolveWriteTarget(workspaceRoot, requestedPath) {
  const root = await fs.realpath(path.resolve(workspaceRoot));
  const candidate = path.resolve(root, requestedPath);

  if (!isInside(root, candidate)) {
    throw new Error('Path is outside the workspace');
  }

  // Validate the nearest existing parent with realpath. This blocks escaping
  // through a symlinked directory while still allowing creation of new files.
  let parent = path.dirname(candidate);
  while (true) {
    try {
      const realParent = await fs.realpath(parent);
      if (!isInside(root, realParent)) {
        throw new Error('Resolved parent is outside the workspace');
      }
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const next = path.dirname(parent);
      if (next === parent) throw new Error('No valid workspace parent found');
      parent = next;
    }
  }

  // If the destination already exists, reject symlinks and directories.
  try {
    const stat = await fs.lstat(candidate);
    if (stat.isSymbolicLink()) throw new Error('Refusing to write through a symbolic link');
    if (!stat.isFile()) throw new Error('Destination is not a regular file');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  return { root, target: candidate, relative: path.relative(root, candidate) };
}

async function atomicWrite(target, content) {
  const directory = path.dirname(target);
  await fs.mkdir(directory, { recursive: true });

  const temp = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`
  );

  try {
    await fs.writeFile(temp, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

const writeFileTool = {
  name: 'write_file',
  description: 'Safely write a UTF-8 text file inside the Abu Siraj workspace',
  risk: 'medium',
  permissions: ['workspace.write'],
  requiresApproval: true,

  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string', minLength: 1 },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
  },

  validateInput(input) {
    if (!input || typeof input.path !== 'string' || !input.path.trim()) {
      return { ok: false, error: 'path is required' };
    }
    if (input.path.includes('\0')) {
      return { ok: false, error: 'path contains an invalid null byte' };
    }
    if (typeof input.content !== 'string') {
      return { ok: false, error: 'content must be a string' };
    }
    if (Buffer.byteLength(input.content, 'utf8') > MAX_WRITE_BYTES) {
      return { ok: false, error: `content exceeds ${MAX_WRITE_BYTES} bytes` };
    }
    return { ok: true };
  },

  async execute(input, context = {}) {
    if (!context.workspaceRoot) {
      throw new Error('workspaceRoot is required in tool context');
    }

    const { target, relative } = await resolveWriteTarget(
      context.workspaceRoot,
      input.path.trim()
    );

    await atomicWrite(target, input.content);

    return {
      path: relative,
      size: Buffer.byteLength(input.content, 'utf8'),
      encoding: 'utf8',
      written: true,
    };
  },
};

module.exports = { writeFileTool, resolveWriteTarget, MAX_WRITE_BYTES };
