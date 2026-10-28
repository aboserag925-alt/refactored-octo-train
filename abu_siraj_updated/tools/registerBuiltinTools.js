'use strict';

const { readFileTool } = require('./readFileTool');
const { writeFileTool } = require('./writeFileTool');
const { editFileTool } = require('./editFileTool');

function registerBuiltinTools(toolManager) {
  toolManager.registerMany([readFileTool, writeFileTool, editFileTool]);
  return toolManager;
}

module.exports = { registerBuiltinTools };
