'use strict'

const { isDeepStrictEqual } = require('node:util')
const { continuationScope } = require('./base-continuation')

// The installed Bedrock 1.26.60 codec names the modify event "update".
const events = new Map([[1, 'add'], ['add', 'add'], [2, 'update'], ['update', 'update'], [3, 'remove'], ['remove', 'remove']])
const RESISTANCE = 11
// Observed on the 1.26.60 Realm after /effect @s slow_falling 600 1 true:
// own mob_effect update, ID 27, amplifier 1, duration 12000, tick 9247927.
// The named effects table in minecraft-data reports a different (Java) ID.
const SLOW_FALLING = 27

function createSelfEffect (effectId, { getState, now = Date.now }) {
  let receipt = null, sequence = 0, lastNumberedTick = null
  function clear () { receipt = null; lastNumberedTick = null }
  function observe (packet, { replaying = false } = {}) {
    if (replaying || packet?.effect_id !== effectId) return false
    const scope = continuationScope(getState())
    if (!scope || String(packet.runtime_entity_id) !== scope.runtimeEntityId) return false
    const event = events.get(packet.event_id), receivedAt = now()
    const tick = String(packet.tick ?? '')
    if (!event || !/^\d+$/.test(tick) || !Number.isSafeInteger(receivedAt) || receivedAt < 0 || !Number.isInteger(packet.amplifier) || packet.amplifier < 0 || packet.amplifier > 255 || !Number.isSafeInteger(packet.duration) || (event !== 'remove' && packet.duration <= 0)) { clear(); return false }
    if (!receipt || !isDeepStrictEqual(receipt.scope, scope)) lastNumberedTick = null
    // Vanilla can send tick 0. Such packets use receive order; a remove
    // always revokes protection, even when its tick precedes the last update.
    const numberedTick = BigInt(tick)
    if (numberedTick > 0n) {
      if (event !== 'remove' && lastNumberedTick !== null && numberedTick < lastNumberedTick) return false
      if (lastNumberedTick === null || numberedTick > lastNumberedTick) lastNumberedTick = numberedTick
    }
    receipt = { source: 'own_mob_effect', effectId, sequence: ++sequence, scope, event, amplifier: packet.amplifier, durationTicks: packet.duration, tick, receivedAt }
    return true
  }
  function snapshot () {
    const scope = continuationScope(getState())
    if (!scope || !receipt || !isDeepStrictEqual(receipt.scope, scope)) return { serverConfirmed: false, active: null, reason: 'NO_CURRENT_RECEIPT', sequence, scope }
    const value = structuredClone(receipt), elapsed = now() - receipt.receivedAt
    if (!Number.isFinite(elapsed) || elapsed < 0) return { ...value, serverConfirmed: false, active: null, reason: 'CLOCK_UNCONFIRMED' }
    if (value.event === 'remove') return { ...value, serverConfirmed: true, active: false, remainingMsEstimate: 0 }
    const remainingMsEstimate = Math.max(0, value.durationTicks * 50 - elapsed)
    if (remainingMsEstimate === 0) return { ...value, serverConfirmed: false, active: null, remainingMsEstimate, reason: 'RECEIPT_EXPIRED' }
    return { ...value, serverConfirmed: true, active: true, remainingMsEstimate }
  }
  return { observe, snapshot, clear }
}

const createSelfResistance = options => createSelfEffect(RESISTANCE, options)
const createSelfSlowFalling = options => createSelfEffect(SLOW_FALLING, options)

// Bounded observations of self packets only. The numeric ID is reported
// verbatim and is deliberately not interpreted as a protection guarantee.
function createSelfEffectEvents ({ getState, now = Date.now }) {
  let scope = null, sequence = 0, recent = []
  function clear () { scope = null; recent = [] }
  function observe (packet, { replaying = false } = {}) {
    if (replaying || !Number.isInteger(packet?.effect_id) || packet.effect_id < 1 || packet.effect_id > 255) return false
    const current = continuationScope(getState()), event = events.get(packet.event_id), receivedAt = now()
    if (!current || String(packet.runtime_entity_id) !== current.runtimeEntityId || !event || !Number.isInteger(packet.amplifier) || packet.amplifier < 0 || packet.amplifier > 255 || !Number.isSafeInteger(packet.duration) || !/^\d+$/.test(String(packet.tick ?? '')) || !Number.isSafeInteger(receivedAt)) return false
    if (!isDeepStrictEqual(scope, current)) { scope = current; recent = [] }
    recent.push({ sequence: ++sequence, source: 'own_mob_effect', receivedAt, event, effectId: packet.effect_id, amplifier: packet.amplifier, durationTicks: packet.duration, tick: String(packet.tick) })
    if (recent.length > 16) recent.shift()
    return true
  }
  function snapshot () {
    const current = continuationScope(getState())
    return { scope: current, sequence, events: current && isDeepStrictEqual(current, scope) ? structuredClone(recent) : [] }
  }
  return { clear, observe, snapshot }
}

module.exports = { createSelfResistance, createSelfSlowFalling, createSelfEffectEvents }
