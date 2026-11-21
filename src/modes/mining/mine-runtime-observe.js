'use strict'

// Asking for a section is not receiving it. World's zero-packet response
// cannot distinguish an unannounced column from in-flight suppression.
const results = require('../return/return-result')
const { mineLiveScope } = require('./mine-state')
const { cell, key } = require('./mine-observed')
const recent = new WeakMap()
const sectionOf = p => ({ x: Math.floor(p.x / 16), y: Math.floor(p.y / 16), z: Math.floor(p.z / 16) })

async function observeMineRuntime (rt, { cells = [] } = {}, { signal } = {}) {
  const world = rt.host?.world, before = mineLiveScope(rt.quarryState?.())
  const current = () => !signal?.aborted && before && before === mineLiveScope(rt.quarryState?.())
  if (!current()) return results.interrupted('MINE_INTERRUPTED')
  if (typeof world?.getBlock !== 'function' || typeof rt.requestQuarryTerrain !== 'function') return results.blocked('MINE_OBSERVATION_UNAVAILABLE', { kind: 'owner_released' })
  const points = [...new Map((Array.isArray(cells) ? cells : []).filter(cell).slice(0, 128).map(p => [key(p), p])).values()]
  if (!points.length) return results.blocked('MINE_OBSERVATION_EMPTY', { kind: 'terrain_received' })
  const missing = () => points.filter(p => world.getBlock(p.x, p.y, p.z)?.known !== true)
  let unknown = missing()
  const evidence = { known: points.length - unknown.length, missing: unknown.length, requested: 0, packets: 0, sectionRequests: 0, waiting: 0, unannounced: null, reason: null }
  const done = () => ({ ...results.completed('MINE_TERRAIN_RECEIVED', { evidence: { ...evidence, known: points.length, missing: 0, serverConfirmed: true } }), serverConfirmed: true })
  if (!unknown.length) return done()
  let history = recent.get(rt)
  if (history?.scope !== before) { history = { scope: before, sections: new Map() }; recent.set(rt, history) }
  const wanted = new Map(unknown.map(p => { const s = sectionOf(p); return [key(s), s] }))
  const sent = new Set()
  for (const section of [...wanted.values()].slice(0, 8)) {
    if (!current()) return results.interrupted('MINE_INTERRUPTED', { evidence })
    let out
    try {
      out = await rt.requestQuarryTerrain({ config: { dimension: 'overworld', target: { chunks: [{ x: section.x, z: section.z }] } },
        yBottom: Math.max(-64, section.y * 16), yTop: Math.min(319, section.y * 16 + 15) }, { signal })
    } catch (error) { evidence.reason = String(error.code ?? error.message).slice(0, 120); break }
    if (!current()) return results.interrupted('MINE_INTERRUPTED', { evidence })
    evidence.packets += Number.isSafeInteger(out?.packets) ? out.packets : 0
    evidence.sectionRequests += Number.isSafeInteger(out?.sectionRequests) ? out.sectionRequests : 0
    for (const packet of out?.requests ?? []) for (const offset of packet.requests ?? []) {
      if (!cell(packet.origin) || !cell(offset)) continue
      const id = key({ x: packet.origin.x + offset.x, y: packet.origin.y + offset.y, z: packet.origin.z + offset.z })
      history.sections.set(id, Date.now())
      if (wanted.has(id)) sent.add(id)
    }
    if (out?.reason) { evidence.reason = String(out.reason).slice(0, 120); break }
  }
  for (const [id, time] of history.sections) if (Date.now() - time >= 5000) history.sections.delete(id)
  while (history.sections.size > 256) history.sections.delete(history.sections.keys().next().value)
  unknown = missing(); evidence.known = points.length - unknown.length; evidence.missing = unknown.length
  if (!unknown.length) return done()
  evidence.requested = sent.size
  evidence.waiting = [...wanted.keys()].filter(id => history.sections.has(id) && !sent.has(id)).length
  if (evidence.reason) return results.blocked('MINE_TERRAIN_REQUEST_REFUSED', { kind: evidence.reason === 'TERRAIN_REQUEST_BUSY' ? 'owner_released' : 'terrain_received' }, { evidence })
  if (sent.size) return results.blocked('MINE_TERRAIN_REQUESTED', { kind: 'terrain_received' }, { evidence })
  if (evidence.waiting) return results.blocked('MINE_TERRAIN_WAITING', { kind: 'terrain_received' }, { evidence })
  evidence.reason = 'unannounced_or_pending'
  return results.blocked('MINE_TERRAIN_UNREQUESTABLE', { kind: 'position_changed' }, { evidence })
}

module.exports = { observeMineRuntime }
