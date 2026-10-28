'use strict';

const fs = require('node:fs/promises');
const { resolveWriteTarget, MAX_WRITE_BYTES } = require('./writeFileTool');

// edit_file: replace exactly one occurrence of old_text with new_text in an
// existing UTF-8 file inside the workspace. Path safety (resolve + parent
// realpath check + symlink refusal) is reused from write_file.

const editFileTool = {
  name: 'edit_file',
  description:
    'Edit part of an existing UTF-8 text file inside the Abu Siraj workspace by replacing ' +
    'exactly one occurrence of old_text with new_text. Use it to change a few lines and keep ' +
    'the rest of the file untouched. Do not use it to create a new file or rewrite a whole ' +
    'file (use write_file), and read the file first so old_text matches exactly. If old_text ' +
    'is missing or appears more than once, nothing is changed and an error explains why.',
  risk: 'medium',
  permissions: ['workspace.write'],
  requiresApproval: true,

  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: {
        type: 'string',
        minLength: 1,
        description: 'Relative path of an existing file inside the workspace, e.g. "notes/todo.md".',
      },
      old_text: {
        type: 'string',
        minLength: 1,
        description: 'Exact text to replace. Must appear exactly once. Include enough surrounding lines to make it unique.',
      },
      new_text: {
        type: 'string',
        description: 'Replacement text. May be empty to delete old_text.',
      },
    },
    required: ['path', 'old_text', 'new_text'],
  },

  returns: '{ path, size, replaced: 1, edited: true }',

  validateInput(input) {
    if (!input || typeof input.path !== 'string' || !input.path.trim()) {
      return { ok: false, error: 'path is required' };
    }
    if (input.path.includes('\0')) {
      return { ok: false, error: 'path contains an invalid null byte' };
    }
    if (typeof input.old_text !== 'string' || input.old_text.length === 0) {
      return { ok: false, error: 'old_text must be a non-empty string' };
    }
    if (typeof input.new_text !== 'string') {
      return { ok: false, error: 'new_text must be a string' };
    }
    if (Buffer.byteLength(input.new_text, 'utf8') > MAX_WRITE_BYTES) {
      return { ok: false, error: `new_text exceeds ${MAX_WRITE_BYTES} bytes` };
    }
    return { ok: true };
  },

  async execute(input, context = {}) {
    if (!context.workspaceRoot) {
      throw new Error('workspaceRoot is required in tool context');
    }

    const { target, relative } = await resolveWriteTarget(context.workspaceRoot, input.path.trim());

    let original;
    try {
      original = await fs.readFile(target, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`File not found: ${relative}`);
      throw error;
    }

    const first = original.indexOf(input.old_text);
    if (first === -1) {
      throw new Error('old_text was not found in the file; nothing was changed');
    }
    if (original.indexOf(input.old_text, first + input.old_text.length) !== -1) {
      throw new Error('old_text appears more than once; add surrounding context to make it unique. Nothing was changed');
    }

    // Function replacer so "$&" etc. in new_text are literal.
    const updated = original.slice(0, first) + input.new_text + original.slice(first + input.old_text.length);
    if (Buffer.byteLength(updated, 'utf8') > MAX_WRITE_BYTES) {
      throw new Error(`Result would exceed ${MAX_WRITE_BYTES} bytes; nothing was changed`);
    }

    // Same-directory temp file then rename, so a failure never leaves a half-written file.
    const path = require('node:path');
    const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
    const { mode } = await fs.stat(target);
    try {
      await fs.writeFile(temp, updated, { encoding: 'utf8', flag: 'wx', mode });
      await fs.rename(temp, target);
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => {});
      throw error;
    }

    return { path: relative, size: Buffer.byteLength(updated, 'utf8'), replaced: 1, edited: true };
  },
};

module.exports = { editFileTool };
