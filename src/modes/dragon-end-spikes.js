'use strict'

const { air, distance } = require('./dragon-end-terrain')

// Nominal neighborhoods guide the survey only. A tower exists in the ledger
// only after receipt of the actual bedrock cap on an obsidian column.
const neighborhoods = Array.from({ length: 10 }, (_, i) => ({
  x: Math.floor(Math.cos(i * Math.PI / 5) * 42), z: Math.floor(Math.sin(i * Math.PI / 5) * 42)
}))
const is = (block, name) => block?.known === true && block.name === `minecraft:${name}`
const at = (get, p, dy) => get(p.x, p.y + dy, p.z)
const nearCap = (a, p) => Math.abs(a.position.x - (p.x + .5)) < 2 && Math.abs(a.position.z - (p.z + .5)) < 2 && Math.abs(a.position.y - p.y - 1) <= 3
function findCap (get, hint) {
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
    const x = hint.x + dx, z = hint.z + dz
    if (!is(get(x, 70, z), 'obsidian')) continue
    for (let y = 74; y <= 118; y++) {
      if (is(get(x, y, z), 'bedrock') && is(get(x, y - 1, z), 'obsidian')) return { x, y, z }
    }
  }
  return null
}

function observeSpikes (ctx, record, crystals, now = Date.now()) {
  const get = ctx.getBlock, state = ctx.runtime.raw()
  const raw = state.rawServerPosition ?? (state.positionSource !== 'client_prediction' && state.position)
  const feet = raw && distance(raw, ctx.getFeet()) <= 0.2 ? raw : null
  const pub = state.chunkPublisher, visible = p => pub?.dimension === 'end' &&
    distance(p, pub.center) < Math.min(32, pub.radius - 8) && distance(p, ctx.getFeet()) < 28
  const ledger = record.spikes ??= {}
  const scope = JSON.stringify([state.connectionId, state.startedAt, ctx.runtime.host().getLife?.()?.deathId])
  const removed = ctx.runtime.host().entities.snapshotRemoved?.() ?? []
  for (let i = 0; i < neighborhoods.length; i++) {
    let spike = ledger[i]
    if (!spike) {
      const cap = findCap(get, neighborhoods[i])
      if (!cap) continue
      spike = ledger[i] = { cap }
    }
    const p = spike.cap
    if (!is(at(get, p, 0), 'bedrock') || !is(at(get, p, -1), 'obsidian')) continue
    const actor = crystals.find(a => nearCap(a, p))
    if (actor) {
      spike.actor = { runtimeId: actor.runtimeId, uniqueId: actor.uniqueId, scope }
      delete spike.cleared; delete spike.empty
      continue
    }
    if (spike.cleared) continue
    const capSpace = at(get, p, 1), above = at(get, p, 2)
    // In the End a live crystal continuously lights the block above its cap.
    // Confirm a previously cleared cap only in a nearby, received simulation
    // neighborhood. A missing entity in a distant or unloaded chunk is unknown.
    if (!(feet && distance(feet, p) <= 28 || visible(p)) || !air(above)) { delete spike.empty; continue }
    const removal = spike.actor?.scope === scope && removed.some(a => a.runtimeId === spike.actor.runtimeId && a.uniqueId === spike.actor.uniqueId && a.position && nearCap(a, p))
    if (removal && air(capSpace)) { spike.cleared = 'bound_removal_and_empty_cap'; delete spike.empty; continue }
    if (!air(capSpace)) { delete spike.empty; continue }
    if (spike.empty?.scope === scope && now - spike.empty.at >= 1600) { spike.cleared = 'nearby_received_empty_cap'; delete spike.empty }
    else if (spike.empty?.scope !== scope) spike.empty = { scope, at: now }
  }
  const pending = neighborhoods.map((hint, i) => ({ aim: ledger[i]?.cap ?? hint, spike: ledger[i] })).filter(v => !v.spike?.cleared)
  pending.sort((a,b) => distance(a.aim, ctx.getFeet()) - distance(b.aim, ctx.getFeet()))
  return { complete: !pending.length, pending, cleared: 10 - pending.length }
}

module.exports = { observeSpikes, findCap, neighborhoods }
