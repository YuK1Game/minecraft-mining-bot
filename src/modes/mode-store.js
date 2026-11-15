'use strict'

// The selected mode survives a restart in .local/mode.json. A missing or
// damaged file means the default mode, never an error at startup.
const fs = require('node:fs')
const path = require('node:path')
const { writeDurableJson } = require('../common/durable-json')
const { DEFAULT_MODE, isMode } = require('./bot-mode')

const modeFile = root => path.resolve(root, '.local', 'mode.json')

function loadModeSync (filename, { io = fs } = {}) {
  try {
    const value = JSON.parse(String(io.readFileSync(filename, 'utf8')).replace(/^﻿/, ''))
    return isMode(value?.mode) ? value.mode : DEFAULT_MODE
  } catch { return DEFAULT_MODE }
}

async function saveMode (filename, mode, { write = writeDurableJson, now = Date.now } = {}) {
  if (!isMode(mode)) throw Object.assign(new Error('Unknown mode'), { code: 'INVALID_MODE' })
  await write(filename, { version: 1, mode, savedAt: new Date(now()).toISOString() })
  return mode
}

module.exports = { modeFile, loadModeSync, saveMode }
