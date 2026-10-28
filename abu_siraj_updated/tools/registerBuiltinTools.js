'use strict';

const { readFileTool } = require('./readFileTool');
const { writeFileTool } = require('./writeFileTool');

function registerBuiltinTools(toolManager) {
  toolManager.registerMany([readFileTool, writeFileTool]);
  return toolManager;
}

module.exports = { registerBuiltinTools };
