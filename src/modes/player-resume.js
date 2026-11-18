'use strict'

// Whether the player was playing survives a restart of the Bot process in
// .local/player-play.json (live 2026-11-16 03:48 JST: the server closed the
// connection, the Bot reconnected in player mode and stood idle "not started").
// A deliberate stop is saved as "not playing". A start managed by the
// dashboard (restore disabled) never resumes by itself.
const fs = require('node:fs')
const path = require('node:path')
const { writeDurableJson } = require('../common/durable-json')
const { normalizeMode } = require('./bot-mode')

const playFile = root => path.resolve(root, '.local', 'player-play.json')

function loadPlayingSync (filename, { io = fs } = {}) {
  try { return JSON.parse(String(io.readFileSync(filename, 'utf8')).replace(/^﻿/, ''))?.playing === true } catch { return false }
}

function createPlayerResume ({ file, shared, getMode, log = () => {}, load = loadPlayingSync, write = writeDurableJson, now = Date.now }) {
  let saved = null, saving = false
  // First runtime of this process only: later runtimes keep what shared holds.
  function restore () {
    if (typeof shared.playerWanted === 'boolean') { saved = load(file); return false }
    saved = load(file)
    const resume = (saved || shared.autoWanted === true) && normalizeMode(getMode()) === 'player' && shared.quarryRestoreDisabled !== true
    shared.playerWanted = resume
    if (!resume) return false
    // Idle protection belongs to playing, as in a normal start.
    if (!shared.safetyWanted) { shared.safetyEnableEpoch = (shared.safetyEnableEpoch ?? 0) + 1; shared.safetyWanted = true }
    log('プレイヤーモード: 再起動の前にプレイ中だったので、続きから再開します')
    return true
  }
  // Called on the mode timer: writes only when the wish changed.
  async function note () {
    const playing = shared.playerWanted === true
    if (saving || playing === saved) return false
    saving = true
    try { await write(file, { version: 1, playing, savedAt: new Date(now()).toISOString() }); saved = playing; return true } catch { return false } finally { saving = false }
  }
  return { restore, note }
}

module.exports = { playFile, loadPlayingSync, createPlayerResume }
