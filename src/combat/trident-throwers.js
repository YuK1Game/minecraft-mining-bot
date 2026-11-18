'use strict'

// Which drowned throw tridents. Most drowned carry nothing and only walk, so
// the long travel and the step out of the line of fire leave drowned out of
// the shooters (every pond would close the way). One with a trident throws it
// from 10 m for 8 damage without armour (real Realm 2026-11-19 07:44:18-07:44:21
// JST: 95 m south-east of the house, on the water's edge, two drowned took
// the Bot from 20 to 0 with three tridents in four seconds; the trip had
// walked it to them, the cover step answered `no_archer_4_20m`).
// The server does not tell what a drowned holds in a way the Bot keeps, but a
// thrown trident is a received entity and stays where it lands for a while.
// A drowned with a received thrown trident within RADIUS_M of it counts as a
// thrower. Received entities only; nothing is guessed about the others.
const RADIUS_M = 24
const typeOf = actor => String(actor?.entityType ?? actor?.name ?? '')
const isTrident = actor => /^minecraft:thrown_trident$/.test(typeOf(actor)) && !!actor.position
const isDrowned = actor => /^minecraft:drowned$/.test(typeOf(actor)) && !!actor.position && actor.alive !== false

function throwers (actors, radius = RADIUS_M) {
  const all = actors ?? [], tridents = all.filter(isTrident)
  if (!tridents.length) return new Set()
  return new Set(all.filter(actor => isDrowned(actor) && tridents.some(t => Math.hypot(t.position.x - actor.position.x, t.position.z - actor.position.z) <= radius)))
}

// The same list with `tridentThrower: true` on those drowned.
function mark (actors) {
  const found = throwers(actors)
  if (!found.size) return actors ?? []
  return actors.map(actor => found.has(actor) ? { ...actor, tridentThrower: true } : actor)
}

module.exports = { throwers, mark, RADIUS_M }
