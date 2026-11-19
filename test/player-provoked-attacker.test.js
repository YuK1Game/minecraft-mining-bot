'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createProvocation, ANGER_MS } = require('../src/combat/provocation')
const { createCombatCoordinator } = require('../src/combat/combat-coordinator')
const { createCombatExposure } = require('../src/combat/combat-exposure')
const { createUserBehaviors } = require('../src/combat/user-behaviors')
const { setImmediate: turn } = require('node:timers/promises')

let serial = 70
const mob = (type, x, extra = {}) => ({ kind: 'mob', entityType: `minecraft:${type}`, hostile: false, alive: true, positionKnown: true, dimension: 'overworld', runtimeId: String(++serial), uniqueId: String(-serial), position: { x, y: 65, z: 0.5 }, ...extra })
const state = () => ({ phase: 'spawned', profile: 'bot', realm: { id: '1' }, connectionId: 'a', startedAt: 'b', runtimeEntityId: '1', dimension: 'overworld', health: 19.5, position: { x: 0.5, y: 66.62, z: 0.5 }, lifecycle: { deathId: 0, phase: 'alive' }, inventory: { known: true, items: [] } })
function setup (actors) {
  const f = { clock: 1e6, hitAt: null, actors }
  f.p = createProvocation({ recentDamageAt: () => f.hitAt, actors: () => f.actors, now: () => f.clock })
  f.hit = () => { f.hitAt = f.clock }
  f.by = actor => f.p.by(state(), actor)
  return f
}

test('a neutral mob is not the attacker for standing near; it is when the Bot loses health beside it with no hostile mob there', () => {
  const enderman = mob('enderman', 2.3), f = setup([enderman])
  assert.equal(f.by(enderman), false)
  f.hit(); f.clock += 100
  assert.equal(f.by(enderman), true)
  f.clock += ANGER_MS - 200
  assert.equal(f.by(enderman), true, 'it stays the attacker between its swings')
  f.clock += 200
  assert.equal(f.by(enderman), false, 'and no longer after its last hit is old')
})

test('a hit with a hostile mob in reach is not blamed on the neutral mob beside it, unless the server sent its attack start', () => {
  const golem = mob('iron_golem', 2.5), zombie = mob('zombie', 1.8, { hostile: true }), f = setup([golem, zombie])
  f.hit(); f.clock += 50
  assert.equal(f.by(golem), false)
  assert.equal(f.by(zombie), true, 'the hostile mob in reach keeps the rule of before')
  const swinging = mob('enderman', 2.8, { lastEvent: { event: 'arm_swing', time: f.clock + 950 } }), g = setup([swinging, zombie])
  g.clock += 1000; g.hit(); g.clock += 50
  assert.equal(g.by(swinging), true)
})

test('only the nearest neutral mob is blamed; one out of reach never is; a known attacker stays one when a zombie walks up', () => {
  const near = mob('enderman', 2.0), far = mob('wolf', 3.5), away = mob('enderman', 7), f = setup([far, near, away])
  f.hit(); f.clock += 50
  assert.deepEqual([f.by(near), f.by(far), f.by(away)], [true, false, false])
  f.actors.push(mob('zombie', 1.5, { hostile: true }))
  f.clock += 3000; f.hit(); f.clock += 50
  assert.equal(f.by(near), true)
  assert.equal(f.by(far), false)
  f.clock += ANGER_MS - 100
  assert.equal(f.by(near), true, 'the second hit renewed it')
})

test('an old health drop, a dead mob and an unknown position blame nobody', () => {
  const enderman = mob('enderman', 2.3), f = setup([enderman])
  f.hit(); f.clock += 6000
  assert.equal(f.by(enderman), false)
  const dead = mob('enderman', 2.3, { alive: false }), g = setup([dead]); g.hit()
  assert.equal(g.by(dead), false)
  const lost = mob('enderman', 2.3, { positionKnown: false }), h = setup([lost]); h.hit()
  assert.equal(h.by(lost), false)
})

// The real coordinator, the real attack-access evaluation and one provocation between them.
function fight ({ actors, wall = false }) {
  const f = { clock: Date.now(), hitAt: null, actors, s: state(), acquisitions: [], engaged: [], stops: [] }
  const air = (x, y, z) => ({ known: true, name: 'minecraft:air', boundingBox: 'empty', position: { x, y, z } }), stone = (x, y, z) => ({ known: true, name: 'minecraft:stone', boundingBox: 'block', position: { x, y, z } })
  const world = { getBlock: (x, y, z) => y < 65 || wall && x === 1 ? stone(x, y, z) : air(x, y, z), revision: () => 1 }
  const entities = { snapshot: () => structuredClone(f.actors), snapshotRemoved: () => [], motion: () => null }
  f.p = createProvocation({ recentDamageAt: () => f.hitAt, actors: () => f.actors })
  const exposure = createCombatExposure({ world, entities, scopeOf: () => 'scope', recentDamageAt: () => f.hitAt, provokedBy: f.p.by })
  const ctl = name => ({ preview: () => ({ ready: true }), survey: () => ({ ready: true }),
    engage: async id => { f.engaged.push([name, id]); return f.result ?? { phase: 'completed', code: 'TARGET_DEAD', targetRuntimeId: id, targetUniqueId: f.actors.find(a => a.runtimeId === id).uniqueId, targetDead: true, serverConfirmed: true } },
    cancel: () => {}, drain: async () => {}, snapshot: () => ({}) })
  let time = 1000
  f.c = createCombatCoordinator({ getState: () => f.s, entities, melee: ctl('melee'), ranged: ctl('ranged'), provoked: f.p.by, getRecentDamageAt: () => f.hitAt,
    canEngage: (target, s) => exposure.evaluate(target, s).intercept === true, withDecision: fn => exposure.withDecision(fn),
    acquire: async a => { f.acquisitions.push(a); return { acquired: true, token: 't' } }, resume: async () => {}, canAct: () => true, now: () => time, sleep: async ms => { time += ms; await turn() } })
  f.exposure = exposure
  f.hit = () => { f.hitAt = Date.now() }
  return f
}

test('live 2026-11-19 23:34:43 JST: an enderman 1.8 m away that hit the Bot is fought; before the hit it is left alone', async () => {
  const enderman = mob('enderman', 2.3), f = fight({ actors: [enderman] })
  await f.c.tick()
  assert.equal(f.acquisitions.length, 0, 'a neutral mob is not fought for standing near')
  f.hit()
  assert.equal(f.exposure.evaluate(enderman, f.s).awareness, 'observed_attack')
  await f.c.tick(); await turn()
  assert.equal(f.acquisitions.length, 1)
  assert.deepEqual(f.engaged, [['melee', enderman.runtimeId]])
})

test('the same hit behind a wall, or with a zombie in reach, starts no fight with the neutral mob', async () => {
  const walled = fight({ actors: [mob('enderman', 2.3)], wall: true })
  walled.hit(); await walled.c.tick(); await turn()
  assert.equal(walled.acquisitions.length, 0)
  const zombie = mob('zombie', 2.0, { hostile: true }), golem = mob('iron_golem', 2.6), f = fight({ actors: [golem, zombie] })
  f.hit(); await f.c.tick(); await turn()
  assert.deepEqual(f.engaged.map(([, id]) => id), [zombie.runtimeId], 'the zombie is fought, the golem is not')
})

// The real composition: the melee controller's own target gate lets the attacker through, and nothing else neutral.
test('the behaviours give the melee controller the attacker as a permitted target', async () => {
  let time = Date.now(), hitAt = null
  const s = { ...state(), playerName: 'P', gameMode: 'survival', rawServerPosition: { x: 0.5, y: 66.62, z: 0.5 }, rawSelectedSlot: 0, rawServerSelectedSlot: 0, selectedSlot: 0, rotation: { yaw: -90, pitch: 0 }, positionSource: 'server_post_move', positionUpdatedAt: time, rawServerPositionUpdatedAt: time }
  const enderman = mob('enderman', 2.3, { positionSource: 'move_entity' }), actors = [enderman]
  const empty = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: { has_nbt: 'false', can_place_on: [], can_destroy: [] } })
  const world = { getBlock: (x, y, z) => ({ known: true, position: { x, y, z }, name: y < 65 ? 'minecraft:grass_block' : 'minecraft:air', boundingBox: y < 65 ? 'block' : 'empty', extra: [] }) }
  const facade = createUserBehaviors({ client: { queue () {} }, getState: () => s, getRawState: () => s, world, entities: { snapshot: () => structuredClone(actors), snapshotRemoved: () => [] },
    crafting: { snapshot: () => ({ authority: true, inventoryKnown: true, inventory: [], pendingRequestId: null }), rawItem: empty }, inventory: { equipForCombat: async slot => ({ slot, serverConfirmed: true }), cancel () {} },
    getInput: () => ({ stats: () => ({ running: false, target: null, sent: 0 }), stop () {}, lookAt () {}, start () {} }), getSelfUniqueId: () => 1n,
    getClock: () => ({ time: 1000, source: 'server_sync_world_clocks' }), getBedMemory: () => null, setBedMemory () {}, placeBed: async () => {}, useBed: async () => {}, wakeBed: async () => {}, mineBed: async () => {}, cancelBedActions: async () => ({ cleaned: true }),
    canAct: () => true, now: () => time, wallNow: () => time, sleep: async () => turn(), acquireControl: async () => ({ acquired: true, token: {} }), resumeControl: async () => ({ resumed: true }),
    coordinatorOptions: { getRecentDamageAt: () => hitAt, canEngage: () => true } })
  assert.equal(typeof facade.provokedBy, 'function')
  assert.equal(facade.provokedBy(s, enderman), false)
  hitAt = time; time += 100
  assert.equal(facade.provokedBy(s, enderman), true)
  await facade.tick(); for (let n = 0; n < 20; n++) await turn()
  const after = facade.snapshot()
  // The real melee controller took the enderman as its target and went on to its input (a stub in this fixture).
  assert.equal(after.melee.lastResult?.targetName, 'minecraft:enderman', JSON.stringify(after.combat.lastResult))
  assert.equal(after.melee.lastResult.code, 'INPUT_UNCONFIRMED', JSON.stringify(after.melee.lastResult))
  facade.cancel('end'); await facade.drain()
})
