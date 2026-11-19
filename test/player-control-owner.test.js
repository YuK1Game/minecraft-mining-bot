'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createControlOwner, standsDown, inContact, fightOf, SETTLED_MS, GAP_MS, FAIL_MS } = require('../src/modes/control-owner')
const { createPlayerFlee } = require('../src/modes/player-flee')

// Combat's snapshot as the coordinator publishes it.
const busy = id => ({ busy: true, claim: { claimId: id } })
const idle = (id, code) => ({ busy: false, claim: null, lastResult: id == null ? null : { claimId: id, code } })
function bench () {
  const world = { clock: 100000, combat: idle(null), held: false, shared: {} }
  const owner = createControlOwner({ shared: world.shared, fight: () => world.combat, held: () => world.held, now: () => world.clock })
  return { world, owner }
}

test('unarmed, or with no claim of combat, nothing is a fight', () => {
  const { world, owner } = bench()
  assert.equal(owner.fighting(true), false)
  world.combat = busy(1)
  assert.equal(owner.fighting(false), false, 'nothing to fight with')
  assert.equal(owner.fighting(undefined), false, 'an unreceived inventory is not a weapon')
  assert.equal(owner.fighting(true), true)
})

test('a first claim counts at once; between two targets of a fight the input is still the fight\'s', () => {
  const { world, owner } = bench()
  world.combat = busy(1)
  assert.equal(owner.fighting(true), true)
  world.clock += 5000
  owner.sample()
  world.clock += 200
  world.combat = idle(1, 'TARGET_DEAD')
  assert.equal(owner.fighting(true), true, 'the target died a moment ago')
  world.clock += GAP_MS - 200
  assert.equal(owner.fighting(true), true)
  world.clock += 1
  assert.equal(owner.fighting(true), false, 'no next target was taken: the fight is over')
})

// Live 2026-11-19 17:19:16.800-17:19:17.150 JST: TARGET_DEAD, the next skeleton claimed, health 6.5, and the
// flee started 326 ms after the kill.
test('the claim on the next target, right after a kill, is the same fight', () => {
  const { world, owner } = bench()
  world.combat = busy(1)
  owner.sample()
  world.clock += 300
  world.combat = { ...busy(2), lastResult: { claimId: 1, code: 'TARGET_DEAD' } }
  assert.equal(owner.fighting(true), true)
})

test('claims that end at once are not a fight; one that lasts is', () => {
  const { world, owner } = bench()
  world.combat = busy(1)
  owner.sample()
  world.clock += 100
  world.combat = idle(1, 'APPROACH_NOT_READY')
  assert.equal(owner.fighting(true), false, 'ended on "no stance": nobody is fighting')
  world.clock += 450
  world.combat = { ...busy(2), lastResult: { claimId: 1, code: 'APPROACH_NOT_READY' } }
  assert.equal(owner.fighting(true), false, 'a new claim right after a failed one has to last first')
  world.clock += SETTLED_MS
  assert.equal(owner.fighting(true), true, 'it lasted')
  // After a quiet time a new claim counts at once again.
  world.combat = idle(2, 'NO_PROGRESS')
  owner.sample()
  world.clock += FAIL_MS + 1
  world.combat = { ...busy(3), lastResult: { claimId: 2, code: 'NO_PROGRESS' } }
  assert.equal(owner.fighting(true), true)
})

test('combat\'s own low-health end lets the walk start at once', () => {
  for (const code of ['HP_RETREAT', 'HP_DISENGAGE']) {
    const { world, owner } = bench()
    world.combat = busy(1)
    owner.sample()
    world.clock += 2000
    assert.equal(owner.fighting(true), true)
    world.clock += 50
    world.combat = idle(1, code)
    assert.equal(owner.fighting(true), false, code)
  }
})

test('a walk\'s claim holds combat off, except from a hostile in contact while armed', () => {
  const { world, owner } = bench()
  const state = { position: { x: 0, y: 65.62, z: 0 } }
  const near = { position: { x: 2, y: 64, z: 0 } }, far = { position: { x: 7.8, y: 64, z: 0 } }
  assert.equal(standsDown({ shared: world.shared, target: far, state, armed: true, now: world.clock }), false, 'no claim')
  owner.claim('flee', 9000)
  assert.equal(owner.walking(), 'flee')
  assert.equal(standsDown({ shared: world.shared, target: far, state, armed: true, now: world.clock }), true)
  assert.equal(standsDown({ shared: world.shared, target: near, state, armed: () => true, now: world.clock }), false)
  assert.equal(standsDown({ shared: world.shared, target: near, state, armed: () => false, now: world.clock }), true)
  let asked = 0
  standsDown({ shared: world.shared, target: far, state, armed: () => { asked++; return true }, now: world.clock })
  assert.equal(asked, 0, 'the weapon is only asked in contact')
  assert.equal(standsDown({ shared: world.shared, target: far, state, armed: true, now: world.clock + 9001 }), false, 'the claim ran out')
  owner.release('cover')
  assert.equal(owner.walking(), 'flee', 'only the walk that claimed releases')
  owner.release('flee')
  assert.equal(owner.walking(), null)
  assert.equal(inContact(near, state), true)
  assert.equal(inContact(far, state), false)
  assert.equal(inContact({ position: null }, state), false)
})

test('the expedition reads the raw hold of combat from the same owner', () => {
  const { world, owner } = bench()
  assert.equal(owner.held(), false)
  world.held = true
  assert.equal(owner.held(), true)
  assert.equal(fightOf(null), null)
  assert.deepEqual(fightOf({ busy: true, claim: { claimId: 4 }, lastResult: { claimId: 3, code: 'TARGET_DEAD' } }), { busy: true, claimId: 4, endedId: 3, code: 'TARGET_DEAD' })
})

// The 17:19 death as the flee saw it: health 6.5, a stone sword, the fight on a skeleton 7.8 m away.
function fleeScene (combat) {
  const s = { clock: 100000, shared: { playerWanted: true }, combat, stops: [], logs: [], steps: 0 }
  const owner = createControlOwner({ shared: s.shared, fight: () => s.combat, now: () => s.clock })
  s.flee = createPlayerFlee({
    getMode: () => 'player', shared: s.shared, owner, log: text => s.logs.push(text), now: () => s.clock, sleep: async ms => { s.clock += ms },
    agent: { running: () => true, stop: reason => s.stops.push(reason) },
    getState: () => ({ health: 6.5, position: { x: 0, y: 65.62, z: 0 }, totem: false, inventory: { items: [{ name: 'minecraft:stone_sword', count: 1 }] } }),
    hostiles: () => [{ entityType: 'minecraft:skeleton', hostile: true, position: { x: 7.8, y: 64, z: 0 } }],
    retreat: async () => { s.steps++; s.clock += 1000; return true }
  })
  return s
}

test('at health 6.5 with a sword, the flee does not take the input from a fight that is on', async () => {
  const s = fleeScene({ ...busy(2), lastResult: { claimId: 1, code: 'TARGET_DEAD' } })
  assert.equal(await s.flee.tick(), false)
  assert.equal(s.flee.status().skip, 'fighting')
  assert.deepEqual(s.stops, [])
  assert.equal(s.steps, 0)
  assert.equal(s.shared.playerFlee, undefined, 'combat was never told to stand down')
})

test('once combat has let go for low health, the same flee starts', async () => {
  const s = fleeScene(busy(2))
  assert.equal(await s.flee.tick(), false)
  s.clock += 500
  s.combat = idle(2, 'HP_RETREAT')
  assert.equal(await s.flee.tick(), true)
  assert.ok(s.steps > 0)
  assert.match(s.logs[0], /体力が少ないため敵から離れます（体力 6\.5、skeleton 7\.8m）/)
  assert.equal(s.shared.playerFlee, null)
})

// Live 2026-11-19 01:08-01:09 JST: every fight with the skeleton ended on "no stance"; nobody dealt with it.
test('fights that keep ending at once do not hold the flee back', async () => {
  const s = fleeScene(idle(1, 'APPROACH_NOT_READY'))
  s.flee.status()
  s.clock += 400
  s.combat = { ...busy(2), lastResult: { claimId: 1, code: 'APPROACH_NOT_READY' } }
  assert.equal(await s.flee.tick(), true)
})

// The owner against the real coordinator: its snapshot while a fight holds the input, and after the target died.
test('the real combat coordinator\'s snapshot reads as a fight, then as a fight that ended well', async () => {
  const { setImmediate: turn } = require('node:timers/promises')
  const { createCombatCoordinator } = require('../src/combat/combat-coordinator')
  let time = 1000, finish = null, moving = true
  const state = { phase: 'spawned', profile: 'bot', realm: { id: '1' }, connectionId: 'c', startedAt: 's', runtimeEntityId: '1', dimension: 'overworld', health: 20, position: { x: 0.5, y: 66.62, z: 0.5 }, lifecycle: { deathId: 0, phase: 'alive' }, inventory: { known: true, items: [] } }
  const target = { runtimeId: '70', uniqueId: '-700', kind: 'mob', entityType: 'minecraft:zombie', hostile: true, alive: true, positionKnown: true, dimension: 'overworld', position: { x: 2.2, y: 65, z: 0.5 } }
  const controller = name => ({
    preview: () => ({ ready: !moving && name === 'melee', code: moving ? 'BUSY' : 'LOS_BLOCKED' }), survey: () => ({ ready: name === 'melee', code: 'LOS_BLOCKED' }),
    engage: () => new Promise(resolve => { finish = () => resolve({ phase: 'completed', code: 'TARGET_DEAD', targetRuntimeId: '70', targetUniqueId: '-700', targetDead: true, serverConfirmed: true, confirmedBy: 'fixture' }) }),
    cancel: () => {}, drain: async () => {}, snapshot: () => ({ cleanupUnconfirmed: false, lastResult: null })
  })
  const coordinator = createCombatCoordinator({ getState: () => state, entities: { snapshot: () => [structuredClone(target)], snapshotRemoved: () => [] }, melee: controller('melee'), ranged: controller('ranged'), acquire: async () => { moving = false; return { acquired: true, token: 't' } }, resume: async () => {}, canAct: () => true, now: () => time, sleep: async ms => { time += ms; await turn() } })
  const clock = { at: 100000 }
  const owner = createControlOwner({ shared: {}, fight: () => coordinator.snapshot(), now: () => clock.at })
  assert.equal(owner.fighting(true), false)
  const done = coordinator.tick()
  for (let i = 0; i < 20 && !finish; i++) await turn()
  assert.ok(finish, 'the melee controller was engaged')
  const held = fightOf(coordinator.snapshot())
  assert.equal(held.busy, true)
  assert.notEqual(held.claimId, null)
  assert.equal(owner.fighting(true), true)
  finish()
  await done
  const after = fightOf(coordinator.snapshot())
  assert.deepEqual({ busy: after.busy, endedId: after.endedId, code: after.code }, { busy: false, endedId: held.claimId, code: 'TARGET_DEAD' })
  clock.at += 300
  assert.equal(owner.fighting(true), true, 'between two targets')
  clock.at += GAP_MS + 1
  assert.equal(owner.fighting(true), false)
})
