'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createSightStanceSearch } = require('../src/sight-stance-search')

function orderedCandidates (state, target, actors, velocity) {
  const feet = { x: state.position.x, y: Math.round(state.position.y - 1.62), z: state.position.z }
  const lead = velocity && Number.isFinite(velocity.x) && Number.isFinite(velocity.z) ? 10 : 0
  const body = { x: target.position.x + (lead ? velocity.x * lead : 0), z: target.position.z + (lead ? velocity.z * lead : 0) }
  const creeper = target.entityType === 'minecraft:creeper', minRange = creeper ? 8 : 6
  const others = actors.filter(e => e.hostile === true && e.alive !== false && e.position && String(e.runtimeId) !== String(target.runtimeId))
  const result = []
  for (let ox = -16; ox <= 16; ox++) for (let oz = -16; oz <= 16; oz++) for (const dy of [2, 1, 0, -1, -2]) {
    const radius = Math.hypot(ox, oz); if (radius < 1 || radius > 16) continue
    const p = { x: Math.floor(feet.x) + ox + 0.5, y: feet.y + dy, z: Math.floor(feet.z) + oz + 0.5 }
    const range = Math.hypot(p.x - body.x, p.z - body.z)
    if (range < (creeper && Math.abs(target.position.y - p.y) >= 1.5 ? 6.5 : minRange) || range > 30) continue
    result.push({ p, score: radius - dy * 1.5 + others.filter(e => Math.hypot(e.position.x - p.x, e.position.z - p.z) < 8).length * 2 })
  }
  return result.sort((a, b) => a.score - b.score).map(item => item.p)
}

function fixture ({ type = 'minecraft:zombie', targetY = 65, pauseMs = 0, routeAt = Infinity, routeCost = 0, onYield = null, inspectionBudgetMs = 100000, block = null } = {}) {
  let time = 0, blocks = 0, revision = 1, validLease = true
  const state = { profile: 'bot', realm: { id: 1 }, connectionId: 'a', startedAt: 'a', runtimeEntityId: '1', dimension: 'overworld', lifecycle: { deathId: 0 }, position: { x: 0.5, y: 66.62, z: 0.5 } }
  const target = { runtimeId: '70', uniqueId: '-70', entityType: type, dimension: 'overworld', hostile: true, alive: true, positionKnown: true, position: { x: 12.5, y: targetY, z: 0.5 } }
  const velocity = { x: 0.04, z: -0.01 }
  const actors = [target, { ...target, runtimeId: '71', uniqueId: '-71', position: { x: -4.5, y: 65, z: 3.5 } }]
  const routes = [], moves = [], events = [], abort = new AbortController(), context = { signal: abort.signal }
  const details = { state, target, actors, velocity, routes, moves, events, abort, context, changeWorld: () => { revision++ }, expireLease: () => { validLease = false } }
  const search = createSightStanceSearch({
    requireLease: () => { if (!validLease) throw new Error('lease expired'); return state },
    getTarget: () => target, getActors: () => actors, getVelocity: () => velocity, getWorldRevision: () => revision,
    // Admit every generated point here; geometry safety has separate cases.
    getBlock: block ?? (() => ++blocks % 3 === 0 ? { known: true, boundingBox: 'block', name: 'minecraft:stone' } : { known: true, boundingBox: 'empty', name: 'minecraft:air' }),
    sightClear: () => true, standingClear: () => true,
    previewRoute: p => { routes.push({ ...p }); events.push('route'); time += routeCost; return { ready: routes.length - 1 === routeAt } },
    move: async p => { moves.push({ ...p }); events.push('move'); return { ready: true, serverConfirmed: true, targetReached: true } },
    now: () => { time += 0.03; return time },
    yieldControl: async () => { events.push('yield'); time += pauseMs; onYield?.(details) },
    inspectionBudgetMs
  })
  return { ...details, search }
}

test('cooperative candidates retain every legacy stable-sort position and score order for ordinary and elevated creeper targets', async () => {
  for (const args of [{}, { type: 'minecraft:creeper' }, { type: 'minecraft:creeper', targetY: 68 }]) {
    const f = fixture(args), expected = orderedCandidates(f.state, f.target, f.actors, f.velocity)
    const result = await f.search(f.target, f.context)
    assert.deepEqual(f.routes, expected)
    assert.equal(result.search.total, expected.length); assert.equal(result.search.tried, expected.length)
    assert.ok(result.search.yields > 0); assert.ok(result.search.maxSliceMs < 9)
    assert.equal(f.moves.length, 0)
  }
})

test('scheduler wait time does not consume the inspection budget or change the selected stance', async () => {
  const outcomes = []
  for (const pauseMs of [0, 1000]) {
    const f = fixture({ pauseMs, routeAt: 7, inspectionBudgetMs: 60 })
    const expected = orderedCandidates(f.state, f.target, f.actors, f.velocity)[7]
    const result = await f.search(f.target, f.context)
    assert.deepEqual(f.moves, [expected]); assert.equal(result.code, 'SIGHT_STANCE')
    assert.equal(result.serverConfirmed, false); assert.equal(result.targetReached, false)
    assert.ok(result.search.activeMs > result.search.inspectionMs, 'candidate generation is included in active work')
    if (pauseMs) assert.ok(result.search.elapsedMs - result.search.activeMs > 1000)
    outcomes.push(result.search.inspectionMs)
  }
  assert.ok(Math.abs(outcomes[0] - outcomes[1]) < 0.001)
})

test('every yield revalidates target identity, life, pose, priming, shooter, terrain and control before any move', async () => {
  for (const change of [
    f => { f.target.uniqueId = '-other' },
    f => { f.target.entityType = 'minecraft:creeper' },
    f => { f.target.dimension = 'nether' },
    f => { f.target.position.x++ },
    f => { f.target.alive = false },
    f => { f.target.positionKnown = false },
    f => { f.target.primed = true },
    f => { f.state.position.x++ },
    f => { f.state.connectionId = 'other' },
    f => f.changeWorld(),
    f => f.expireLease(),
    f => f.abort.abort()
  ]) {
    let changed = false
    const f = fixture({ routeAt: 0, onYield: f => { if (!changed) { changed = true; change(f) } } })
    const result = await f.search(f.target, f.context)
    assert.equal(result.code, 'SIGHT_STALE'); assert.equal(result.ready, false)
    assert.equal(f.routes.length, 0); assert.equal(f.moves.length, 0)
  }
})

test('a route-preview overrun yields and revalidates before applying the ready route', async () => {
  const f = fixture({ routeAt: 0, routeCost: 20, onYield: f => { if (f.routes.length) f.changeWorld() } })
  const result = await f.search(f.target, f.context)
  assert.equal(result.code, 'SIGHT_STALE'); assert.equal(f.routes.length, 1); assert.equal(f.moves.length, 0)
  assert.equal(f.events[f.events.indexOf('route') + 1], 'yield')
  assert.ok(result.search.maxSliceMs >= 20, 'an indivisible route callback is measured rather than claimed to fit the slice')
})

test('unknown or wet body cells remain inadmissible', async () => {
  for (const block of [{ known: false, name: 'minecraft:air', boundingBox: 'empty' }, { known: true, name: 'minecraft:water', boundingBox: 'empty' }]) {
    const f = fixture({ routeAt: 0, block: () => block })
    const result = await f.search(f.target, f.context)
    assert.equal(result.ready, false); assert.equal(f.routes.length, 0); assert.equal(f.moves.length, 0)
  }
})
