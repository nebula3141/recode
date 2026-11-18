'use strict';
const os = require('os');
const path = require('path');

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const APP_DIR = path.resolve(__dirname, '..');
const DATA_DIR = process.env.LAUNCHER_DATA_DIR || path.join(APP_DIR, 'data');

module.exports = {
  CLAUDE_DIR,
  PROJECTS_DIR: path.join(CLAUDE_DIR, 'projects'),
  LIVE_DIR: path.join(CLAUDE_DIR, 'sessions'),
  HISTORY_FILE: path.join(CLAUDE_DIR, 'history.jsonl'),
  // Claude Code keeps .claude.json inside CLAUDE_CONFIG_DIR when that is set.
  CLAUDE_JSON: process.env.CLAUDE_CONFIG_DIR ? path.join(CLAUDE_DIR, '.claude.json') : path.join(os.homedir(), '.claude.json'),
  APP_DIR,
  DATA_DIR,
  PUBLIC_DIR: path.join(APP_DIR, 'public'),
};
