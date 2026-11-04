'use strict'

// QuarryCombatBridge (spec v1.2 §9): which hostiles interrupt quarrying, the
// fixed combat anchor with its 8m movement bound, the 3s threat-free settle
// and the post-combat resume gate. The existing combat coordinator keeps its
// own 53-rule profiles, weapons, HP retreat and attacker memory; this bridge
// only narrows target selection and movement while a quarry job is active.

const copy = value => structuredClone(value)
const finite = p => p && ['x', 'y', 'z'].every(k => Number.isFinite(p[k]))
const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const distH = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
const FEET = 1.62

// Attack characteristic, not the bot's sword/bow choice (§9.1).
const RANGED = new Set(['minecraft:skeleton', 'minecraft:stray', 'minecraft:bogged', 'minecraft:pillager', 'minecraft:blaze', 'minecraft:ghast', 'minecraft:witch', 'minecraft:breeze', 'minecraft:shulker', 'minecraft:evocation_illager', 'minecraft:evoker', 'minecraft:llama', 'minecraft:trader_llama', 'minecraft:piglin'])
const PROJECTILES = /^minecraft:(arrow|small_fireball|fireball|wither_skull|shulker_bullet|trident|breeze_wind_charge_projectile|wind_charge_projectile|splash_potion|lingering_potion|llama_spit|thrown_trident)$/
const classOf = type => type === 'minecraft:creeper' ? 'creeper' : RANGED.has(type) ? 'ranged' : 'melee'

const DEFAULTS = { enterDistance: { melee: 10, creeper: 16, ranged: 24 }, releaseDistance: { melee: 12, creeper: 20, ranged: 28 }, normalMovementRadiusFromAnchor: 8, threatFreeSecondsBeforeRecovery: 3, attackerMemoryMs: 5000, immediateRadius: 3, projectileRadius: 8, resumeHealthRatio: 0.9, minFoodLevel: 18 }

function createQuarryCombatBridge ({ now = Date.now, config = {} } = {}) {
  const cfg = { ...DEFAULTS, ...config, enterDistance: { ...DEFAULTS.enterDistance, ...config.enterDistance }, releaseDistance: { ...DEFAULTS.releaseDistance, ...config.releaseDistance } }
  for (const c of ['melee', 'creeper', 'ranged']) if (!(cfg.enterDistance[c] > 0 && cfg.releaseDistance[c] >= cfg.enterDistance[c])) throw new Error('Quarry combat distances need release >= enter > 0')
  // Active only while a quarry job owns work; otherwise every guard is a pass.
  let active = null // { jobId, epoch, travel(p) -> bool }
  let anchor = null
  let held = new Map() // threat key -> { class, since }
  let settleSince = null
  let lastInterruption = null
  const metrics = { interruptions: 0, lastSwitch: null, maxAnchorDistance: 0, lastThreatClearedAt: null, lastResumeAt: null, lastResumeFailure: null }

  const feetOf = s => ({ x: s.position.x, y: s.position.y - FEET, z: s.position.z })
  const threatKey = e => `${e.runtimeId}:${e.uniqueId}:${e.entityType}`

  function activate ({ jobId, epoch, travel = () => true }) { active = { jobId, epoch, travel }; return snapshot() }
  function deactivate () { active = null; anchor = null; held.clear(); settleSince = null; return snapshot() }

  // Distance between normalised feet positions (§9.1).
  function distanceTo (state, e) { return dist3(feetOf(state), e.position) }

  // Evidence the hostile can hurt the bot now or after the next dig: a route,
  // a line of fire, a fall onto the bot, or an explicit immediate danger.
  // evidence = { route: bool|null, sight: bool|null } from the caller; null is
  // "unknown" and never counts as safe (§9.2).
  function threatens (state, e, evidence = {}) {
    const c = classOf(e.entityType)
    const recent = evidence.provoked === true
    const d = distanceTo(state, e)
    if (recent || e.primed === true && c === 'creeper' || d <= cfg.immediateRadius) return { threat: true, immediate: true, class: c, distance: d }
    const route = evidence.route; const sight = evidence.sight
    const fallsOnto = Number.isFinite(e.position?.y) && e.position.y > feetOf(state).y + 1 && distH(feetOf(state), e.position) <= 3
    if (c === 'melee') return { threat: route !== false || fallsOnto, class: c, distance: d, uncertain: route == null }
    if (c === 'creeper') return { threat: route !== false || sight !== false || fallsOnto, class: c, distance: d, uncertain: route == null && sight == null }
    return { threat: sight !== false, class: c, distance: d, uncertain: sight == null }
  }

  // §9.1/9.2: may this hostile interrupt quarrying, or (already held) stay a
  // combat target? Enter distance for new candidates, release for held ones.
  function canSelectTarget (target, state, evidence = {}) {
    if (!active) return { allowed: true, reason: 'NO_QUARRY_JOB' }
    if (!target?.position || !finite(state?.position)) return { allowed: false, reason: 'UNKNOWN_POSITION' }
    const t = threatens(state, target, evidence)
    const k = threatKey(target)
    const wasHeld = held.has(k)
    const limit = wasHeld ? cfg.releaseDistance[t.class] : cfg.enterDistance[t.class]
    if (t.immediate) { held.set(k, { class: t.class, since: held.get(k)?.since ?? now() }); return { allowed: true, reason: 'IMMEDIATE_DANGER', ...t } }
    if (!t.threat) { held.delete(k); return { allowed: false, reason: 'NO_ROUTE_OR_SIGHT', ...t } }
    // Enter at <= enter distance; a held threat is released only beyond the
    // release distance, so the boundary band does not flap (§9.1, T29).
    if (!(t.distance <= limit)) { held.delete(k); return { allowed: false, reason: wasHeld ? 'OUTSIDE_RELEASE_DISTANCE' : 'OUTSIDE_ENTER_DISTANCE', limit, ...t } }
    // A target that can only be fought by leaving the anchor radius is not
    // chased (§9.3, T44); close threats are still answered.
    if (anchor && distH(anchor, target.position) > cfg.normalMovementRadiusFromAnchor + 4.5 && t.distance > 6 && t.class !== 'ranged' && t.class !== 'creeper') return { allowed: false, reason: 'BEYOND_ANCHOR_REACH', ...t }
    held.set(k, { class: t.class, since: held.get(k)?.since ?? now() })
    return { allowed: true, reason: 'QUARRY_THREAT', limit, ...t }
  }

  // Per-poll check for a bound target: still a quarry threat (release
  // distance) and the bot still inside the anchor radius (§9.3, T34).
  function canContinue (target, state, evidence = {}) {
    if (!active) return { allowed: true, reason: 'NO_QUARRY_JOB' }
    if (anchor && finite(state?.position) && !evidence.retreating && distH(anchor, feetOf(state)) > cfg.normalMovementRadiusFromAnchor + 0.5) return { allowed: false, reason: 'ANCHOR_LIMIT' }
    return canSelectTarget(target, state, evidence)
  }

  // Interruption: fixes the anchor once and keeps it until work resumes (§9.3).
  function interrupt (state, context = {}) {
    if (!active) return null
    if (!anchor) {
      const f = feetOf(state)
      anchor = context.anchor ?? { x: Math.floor(f.x) + 0.5, y: Math.round(f.y), z: Math.floor(f.z) + 0.5 }
      metrics.interruptions++
      lastInterruption = { jobId: active.jobId, epoch: active.epoch, at: now(), anchor: copy(anchor), ...copy(context) }
      metrics.lastSwitch = { at: now(), reason: context.reason ?? null, enemy: context.enemy ?? null, distance: context.distance ?? null }
    }
    settleSince = null
    return copy(lastInterruption)
  }

  // §9.3: normal combat movement stays within 8m (horizontal) of the anchor,
  // along the whole route and inside travel permission. Emergency escapes are
  // a separate class and keep their own safety rules.
  function canMoveTo (position, { reason = 'combat', waypoints = [] } = {}) {
    if (!active || !anchor) return { allowed: true, reason: 'NO_QUARRY_ANCHOR' }
    if (reason === 'emergency_escape') return { allowed: true, reason: 'EMERGENCY_ESCAPE', emergency: true }
    for (const p of [...waypoints, position]) {
      if (!finite(p)) return { allowed: false, reason: 'UNKNOWN_WAYPOINT' }
      const h = distH(anchor, p)
      if (h > cfg.normalMovementRadiusFromAnchor) return { allowed: false, reason: 'BEYOND_ANCHOR_RADIUS', distance: h }
      if (Math.abs(p.y - anchor.y) > 1.5) return { allowed: false, reason: 'OTHER_LAYER' }
      if (!active.travel({ x: Math.floor(p.x), y: Math.floor(p.y + 1e-3), z: Math.floor(p.z) })) return { allowed: false, reason: 'OUTSIDE_TRAVEL_REGION' }
    }
    return { allowed: true, reason: 'WITHIN_ANCHOR_RADIUS' }
  }
  function observeMovement (state) {
    if (anchor && finite(state?.position)) metrics.maxAnchorDistance = Math.max(metrics.maxAnchorDistance, distH(anchor, feetOf(state)))
  }

  // §9.5: 3s of fresh observations with no interrupting threat, no projectile
  // nearby, no unresolved attacker in the 5s memory, no immediate hazard.
  function settle (state, entities, { evidenceFor = () => ({}), recentDamageAt = null, hazard = false } = {}) {
    const t = now()
    const reasons = []
    if (!finite(state?.position) || state.dead) reasons.push('NO_LIVE_OBSERVATION')
    if (hazard) reasons.push('IMMEDIATE_HAZARD')
    if (Number.isFinite(recentDamageAt) && t - recentDamageAt >= 0 && t - recentDamageAt <= cfg.attackerMemoryMs) reasons.push('RECENT_ATTACKER')
    for (const e of entities ?? []) {
      if (!e?.position || e.positionKnown === false) continue
      if (typeof e.entityType === 'string' && PROJECTILES.test(e.entityType) && distanceTo(state, e) <= cfg.projectileRadius) { reasons.push('PROJECTILE_NEARBY'); continue }
      if (e.kind !== 'mob' || e.hostile !== true || e.alive === false) continue
      const ev = evidenceFor(e)
      const th = threatens(state, e, ev)
      const limit = cfg.enterDistance[th.class]
      if (th.immediate || th.threat && th.distance <= limit) reasons.push(`THREAT:${e.entityType}`)
      else if (th.uncertain && th.distance <= limit) reasons.push(`UNCERTAIN:${e.entityType}`)
    }
    if (reasons.length) { settleSince = null; return { settled: false, reasons, remainingMs: cfg.threatFreeSecondsBeforeRecovery * 1000 } }
    settleSince ??= t
    const elapsed = t - settleSince
    const done = elapsed >= cfg.threatFreeSecondsBeforeRecovery * 1000
    if (done) metrics.lastThreatClearedAt = t
    return { settled: done, reasons: [], remainingMs: Math.max(0, cfg.threatFreeSecondsBeforeRecovery * 1000 - elapsed) }
  }

  // §9.6: resume needs HP >= 90%, food >= 18 and no harmful effect.
  function resumeGate (state, { harmfulEffect = false } = {}) {
    const max = Number.isFinite(state?.maxHealth) && state.maxHealth > 0 ? state.maxHealth : 20
    const food = state?.food ?? state?.hunger ?? null
    const missing = []
    if (!(state?.health / max >= cfg.resumeHealthRatio)) missing.push('HEALTH')
    if (!(Number.isFinite(food) && food >= cfg.minFoodLevel)) missing.push('FOOD')
    if (harmfulEffect) missing.push('HARMFUL_EFFECT')
    return { ready: missing.length === 0, missing }
  }

  function resumed () { metrics.lastResumeAt = now(); anchor = null; held.clear(); settleSince = null; lastInterruption = null }
  function snapshot () { return { active: active ? { jobId: active.jobId, epoch: active.epoch } : null, anchor: copy(anchor), held: [...held.keys()], settleSince, interruption: copy(lastInterruption), metrics: copy(metrics), config: copy(cfg) } }
  return { activate, deactivate, canSelectTarget, canContinue, interrupt, canMoveTo, observeMovement, settle, resumeGate, resumed, snapshot, classOf, isActive: () => !!active, anchor: () => copy(anchor), failResume: reason => { metrics.lastResumeFailure = { at: now(), reason } } }
}

module.exports = { createQuarryCombatBridge, classOf }
