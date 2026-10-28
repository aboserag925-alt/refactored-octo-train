'use strict';

/**
 * Provider-agnostic Tool Manager for Abu Siraj v3.
 * CommonJS to match the current package.json (no "type": "module").
 */
class ToolManager {
  constructor({ permissionManager = null, approvalManager = null, logger = console } = {}) {
    this.tools = new Map();
    this.permissionManager = permissionManager;
    this.approvalManager = approvalManager;
    this.logger = logger;
  }

  register(tool) {
    this.#validateTool(tool);

    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }

    this.tools.set(tool.name, Object.freeze({
      risk: 'low',
      permissions: [],
      inputSchema: null,
      ...tool,
    }));

    return this;
  }

  registerMany(tools = []) {
    for (const tool of tools) this.register(tool);
    return this;
  }

  unregister(name) {
    return this.tools.delete(name);
  }

  has(name) {
    return this.tools.has(name);
  }

  get(name) {
    return this.tools.get(name) || null;
  }

  list() {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description || '',
      risk: tool.risk,
      permissions: [...tool.permissions],
      inputSchema: tool.inputSchema,
    }));
  }

  async execute(name, input = {}, context = {}) {
    const tool = this.get(name);
    if (!tool) {
      return this.#failure(name, 'TOOL_NOT_FOUND', `Unknown tool: ${name}`);
    }

    try {
      this.#validateInputShape(input);

      if (typeof tool.validateInput === 'function') {
        const validation = await tool.validateInput(input, context);
        if (validation === false) {
          return this.#failure(name, 'INVALID_INPUT', 'Tool input was rejected');
        }
        if (validation && validation.ok === false) {
          return this.#failure(name, 'INVALID_INPUT', validation.error || 'Invalid tool input');
        }
      }

      if (this.permissionManager) {
        const permission = await this.permissionManager.check({
          tool: name,
          permissions: tool.permissions,
          risk: tool.risk,
          input,
          context,
        });

        if (permission === false || permission?.allowed === false) {
          return this.#failure(name, 'PERMISSION_DENIED', permission?.reason || 'Permission denied');
        }
      }

      if (this.#requiresApproval(tool) && !context.approved) {
        if (!this.approvalManager) {
          return {
            ok: false,
            tool: name,
            code: 'APPROVAL_REQUIRED',
            requiresApproval: true,
            risk: tool.risk,
            input,
          };
        }

        const approval = await this.approvalManager.request({
          tool: name,
          description: tool.description || '',
          risk: tool.risk,
          permissions: tool.permissions,
          input,
          context,
        });

        if (approval !== true && approval?.approved !== true) {
          return this.#failure(name, 'APPROVAL_DENIED', approval?.reason || 'User approval was not granted');
        }
      }

      const startedAt = Date.now();
      const data = await tool.execute(input, context);

      return {
        ok: true,
        tool: name,
        data,
        meta: { durationMs: Date.now() - startedAt },
      };
    } catch (error) {
      this.logger?.error?.(`[ToolManager] ${name}:`, error);
      return this.#failure(name, 'TOOL_EXECUTION_FAILED', error?.message || String(error));
    }
  }

  #requiresApproval(tool) {
    if (typeof tool.requiresApproval === 'boolean') return tool.requiresApproval;
    return tool.risk === 'medium' || tool.risk === 'high';
  }

  #validateTool(tool) {
    if (!tool || typeof tool !== 'object') throw new TypeError('Tool must be an object');
    if (!/^[a-z][a-z0-9_.-]*$/.test(tool.name || '')) {
      throw new TypeError('Tool name must use lowercase letters, numbers, _, . or -');
    }
    if (typeof tool.execute !== 'function') throw new TypeError(`Tool ${tool.name} must define execute()`);
    if (tool.permissions !== undefined && !Array.isArray(tool.permissions)) {
      throw new TypeError(`Tool ${tool.name} permissions must be an array`);
    }
    if (tool.risk !== undefined && !['low', 'medium', 'high'].includes(tool.risk)) {
      throw new TypeError(`Tool ${tool.name} has an invalid risk level`);
    }
  }

  #validateInputShape(input) {
    if (input === null || Array.isArray(input) || typeof input !== 'object') {
      throw new TypeError('Tool input must be an object');
    }
  }

  #failure(tool, code, error) {
    return { ok: false, tool, code, error };
  }
}

module.exports = { ToolManager };
