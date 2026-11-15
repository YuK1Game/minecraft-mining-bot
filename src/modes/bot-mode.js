'use strict'

// The Bot runs in exactly one mode. This file holds the mode names and the
// rules for switching and starting; it reads no world state and has no I/O.
const MODES = Object.freeze(['quarry', 'player'])
const DEFAULT_MODE = 'quarry'
const LABELS = Object.freeze({ quarry: '露天掘り', player: 'プレイヤー' })
const refusal = (code, message) => ({ code, message })
const isMode = value => MODES.includes(value)
const normalizeMode = value => isMode(value) ? value : DEFAULT_MODE

// A quarry job that is absent, idle, paused or finished does no work.
function quarryStopped (status) {
  if (!status?.jobId) return true
  return ['IDLE', 'PAUSED', 'FINISHED'].includes(status.state) && status.draining !== true
}
const playerStopped = agent => agent?.running !== true

// null when the switch is allowed, otherwise the one reason it is refused.
// Switching never starts or cancels work: the other mode must already be stopped.
function switchRefusal ({ from, to, quarry = null, agent = null, busy = false } = {}) {
  if (!isMode(to)) return refusal('INVALID_MODE', 'モードは quarry か player を指定してください。')
  if (from === to) return null
  if (busy) return refusal('MODE_BUSY', '移動・収納・デバッグ操作の終了を待ってからモードを切り替えてください。')
  if (!quarryStopped(quarry)) return refusal('QUARRY_RUNNING', '露天掘りを一時停止してからモードを切り替えてください。')
  if (!playerStopped(agent)) return refusal('PLAYER_RUNNING', 'プレイヤーモードを停止してからモードを切り替えてください。')
  return null
}

// Work of one mode starts only while that mode is selected.
function startRefusal (mode, work) {
  if (mode === work) return null
  return refusal('MODE_MISMATCH', `現在は${LABELS[normalizeMode(mode)]}モードです。${LABELS[work]}モードへ切り替えてから開始してください。`)
}

module.exports = { MODES, DEFAULT_MODE, LABELS, isMode, normalizeMode, quarryStopped, playerStopped, switchRefusal, startRefusal }
