'use strict'

// A remembered danger zone is avoided by long travel, except a zone that holds
// the trip's own destination: the trip could never arrive otherwise (live
// 2026-11-17 21:24-21:27 JST: a base trip stopped 94 m short of the base chest,
// every leg refused with CHUNK_TRAVEL_DANGER_ZONE, because a skeleton zone was
// recorded beside the house).
// A zone of ordinary shooters (skeletons and the like) is forgotten after an
// hour: they wander or burn; pillager zones (outposts, patrols) stay.
const FORGET_MS = 3600000
const lasting = zone => /pillager|vindicator|evoker/.test(String(zone?.kind ?? ''))
const fresh = (zone, now) => { const at = Date.parse(zone?.at ?? ''); return lasting(zone) || !Number.isFinite(at) || now - at < FORGET_MS }

function inZone (zones, x, z, destination = null, now = Date.now()) {
  const goal = destination && Number.isFinite(destination.x) && Number.isFinite(destination.z) ? destination : null
  return (zones ?? []).some(zone => fresh(zone, now) && Math.hypot(zone.x - x, zone.z - z) < zone.r && !(goal && Math.hypot(zone.x - goal.x, zone.z - goal.z) < zone.r))
}

module.exports = { inZone, FORGET_MS }
