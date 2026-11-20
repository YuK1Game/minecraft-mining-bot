'use strict'

// Low health among several close hostiles (combat-coordinator.js `crowdedLowHp`): the fight ends only while nothing
// is in reach. "In reach" must not flip on the knockback of one hit, the Bot's own or the one it took.
// Live 2026-11-20 15:39:56-15:40:00 JST (a skeleton and two zombies, stone sword, health 5.9 → 0.64): three sword
// bursts ended 「HP_DISENGAGE」 59-332 ms after their first hit, at 2.3-2.9 m, and the fourth right after the hit the
// Bot took at 2.6 m. Three hits went out in 3.4 s; the Bot died nine seconds later.
// The real coordinator; the sword controller, the mobs and the clock are played.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { setImmediate: turn } = require('node:timers/promises')
const { createCombatCoordinator } = require('../src/combat/combat-coordinator')
const { KNOCKBACK_MS, KNOCKBACK_M, createContactHold } = require('../src/combat/knockback-reach')

const REACH = 3, SWING_MS = 150, KNOCK_M = 0.9
function fight ({ health = 5.9, range = 2.6, other = 4.8, walksBack = true, knock = KNOCK_M, mobHealth = 20, firstSwingMs = 0, struck = null } = {}) {
  let time = 1000, cancelled = null
  const state = { phase: 'spawned', profile: 'bot', realm: { id: '1' }, connectionId: 'a', startedAt: 'b', runtimeEntityId: '1', dimension: 'overworld', health, position: { x: 0.5, y: 66.62, z: 0.5 }, lifecycle: { deathId: 3 }, inventory: { known: true, items: [{ name: 'minecraft:stone_sword', count: 1 }] } }
  const mob = (id, type, x, z) => ({ runtimeId: String(id), uniqueId: String(-id), kind: 'mob', entityType: `minecraft:${type}`, hostile: true, alive: true, positionKnown: true, dimension: 'overworld', position: { x, y: 65, z } })
  const flat = d => Math.sqrt(d * d - 0.72 * 0.72)
  const target = mob(70, 'skeleton', 0.5 + flat(range), 0.5), second = mob(71, 'zombie', 0.5, 0.5 + flat(other))
  const actors = [target, second], hits = [], ends = [], approaches = []
  const far = actor => Math.hypot(state.position.x - actor.position.x, state.position.y - actor.position.y - 0.9, state.position.z - actor.position.z)
  let left = mobHealth, lastHit = -Infinity, taken = false, sent = 0, swinging = false
  const began = time
  // The mobs between two looks: the one that was hit walks back in (a zombie does; a skeleton stays where it landed).
  const step = ms => {
    time += ms
    // The hit the Bot takes: its health drops and it is thrown back, away from the target.
    if (struck && !taken && time - began >= struck.at) { taken = true; state.health = struck.health; state.position.x -= struck.metres }
    if (walksBack && target.alive && far(target) > 1.8 && time - lastHit > 100) target.position.x = Math.max(state.position.x + flat(1.8), target.position.x - 2.3 * ms / 1000)
  }
  const sleep = async ms => { step(ms); await turn() }
  const result = (code, extra = {}) => ({ code, targetRuntimeId: target.runtimeId, targetUniqueId: target.uniqueId, targetDead: false, serverConfirmed: false, hitsRequested: 0, ...extra })
  // The sword: a swing every SWING_MS while the target is in reach; after its own hit it waits for the target to come
  // back, as melee-combat.js does (0.6 s, 1.5 m).
  const melee = {
    preview: () => ({ ready: far(target) <= REACH, code: far(target) <= REACH ? null : 'OUT_OF_REACH' }),
    survey: () => ({ ready: false, code: 'RANGE' }),
    engage: async (_id, { signal } = {}) => {
      sent = 0; cancelled = null; swinging = true
      try { for (;;) {
        if (cancelled || signal?.aborted) return result(cancelled ?? 'CANCELLED', { hitsRequested: sent })
        const d = far(target)
        if (d <= REACH && time - lastHit >= SWING_MS && time - began >= firstSwingMs) {
          sent++; lastHit = time; left -= 6; hits.push({ at: time, distance: d })
          if (left <= 0) { target.alive = false; target.lastEvent = { event: 'death_animation' }; return result('TARGET_DEAD', { hitsRequested: sent, targetDead: true, serverConfirmed: true }) }
          target.position.x += knock
        } else if (d > REACH && !(sent > 0 && time - lastHit <= 600 && d <= REACH + 1.5)) return result('OUT_OF_REACH', { outcome: 'out_of_reach', hitsRequested: sent })
        await sleep(10)
      } } finally { swinging = false }
    },
    cancel: (_reason, code) => { cancelled = code ?? 'CANCELLED' }, drain: async () => {}, snapshot: () => ({ cleanupUnconfirmed: false, phase: swinging ? 'cooldown' : 'idle', hitsRequested: swinging ? sent : 0 })
  }
  const ranged = { preview: () => ({ ready: false, code: 'RANGE' }), survey: () => ({ ready: false, code: 'RANGE' }), engage: async () => result('RANGE'), cancel: () => {}, drain: async () => {}, snapshot: () => ({ cleanupUnconfirmed: false, phase: 'idle' }) }
  const coordinator = createCombatCoordinator({ getState: () => state, entities: { snapshot: () => structuredClone(actors), snapshotRemoved: () => [] }, melee, ranged, canAct: () => true, canEngage: () => true, canAcquireMeleeApproach: () => true,
    acquire: async () => ({ acquired: true, token: 't' }), resume: async () => {},
    approach: async target => { approaches.push({ at: time, distance: far(target) }); return { ready: false, reason: 'No known bounded melee stance' } },
    log: message => { const end = /戦闘終了: target=(\w+) code=(\w+)/.exec(message); if (end) ends.push({ at: time, target: end[1], code: end[2] }) },
    now: () => time, sleep })
  const run = async ms => { const until = time + ms; let last = null; while (time < until) { last = await coordinator.tick() ?? last; step(10) } return last }
  return { state, target, second, hits, ends, approaches, coordinator, run, far, clock: () => time, began }
}

test('at low health among two hostiles, the knockback of the own hit does not end the burst: the hostile in reach is fought down', async () => {
  const f = fight()
  await f.run(3000)
  assert.equal(f.target.alive, false, JSON.stringify({ hits: f.hits, ends: f.ends }))
  assert.equal(f.hits.length, 4, 'stone sword, 20 health')
  assert.deepEqual(f.ends.map(end => end.code), ['TARGET_DEAD'], JSON.stringify({ hits: f.hits, ends: f.ends }))
  assert.ok(f.hits[3].at - f.hits[0].at <= 2500, String(f.hits[3].at - f.hits[0].at))
})

test('a hostile that stays where the hit threw it, out of reach, is left as before once the hold is over', async () => {
  const f = fight({ walksBack: false })
  await f.run(3000)
  assert.equal(f.hits.length, 1)
  assert.equal(f.ends[0].code, 'HP_DISENGAGE', JSON.stringify(f.ends))
  assert.ok(f.ends[0].at - f.hits[0].at >= KNOCKBACK_MS && f.ends[0].at - f.hits[0].at <= KNOCKBACK_MS + 200, JSON.stringify({ hits: f.hits, ends: f.ends }))
  assert.equal(f.ends.length, 1, 'and nothing new is started while nothing is in reach')
})

test('a hostile thrown beyond the slack is not in reach at once', async () => {
  const f = fight({ walksBack: false, knock: KNOCKBACK_M + 0.8 })
  await f.run(1500)
  assert.equal(f.hits.length, 1)
  assert.equal(f.ends[0].code, 'HP_DISENGAGE')
  assert.ok(f.ends[0].at - f.hits[0].at <= 150, String(f.ends[0].at - f.hits[0].at))
})

test('the hit the Bot takes, which throws it back and takes it under the retreat line, does not end the fight at that instant', async () => {
  // Live 15:39:56.647-56.727: the sword came into reach at 2.6 m; 40 ms later health 8.12 → 5.9; 「OUT_OF_REACH hits=0」
  // 37 ms after that and 「HP_DISENGAGE」 3 ms later.
  const f = fight({ health: 8.12, firstSwingMs: 80, struck: { at: 40, health: 5.9, metres: 0.8 } })
  await f.run(3000)
  assert.equal(f.state.health, 5.9)
  assert.equal(f.ends.some(end => end.code === 'HP_DISENGAGE'), false, JSON.stringify({ hits: f.hits, ends: f.ends }))
  assert.equal(f.target.alive, false, JSON.stringify({ hits: f.hits, ends: f.ends }))
  assert.ok(f.hits[0].at - f.began <= 700, 'the first swing follows as soon as the hostile is back in reach: ' + (f.hits[0].at - f.began))
})

test('low health among two hostiles with nothing in reach starts nothing, as before', async () => {
  const f = fight({ range: 4.2, walksBack: false })
  await f.run(1500)
  assert.equal(f.hits.length, 0)
  assert.equal(f.approaches.length, 0)
  assert.equal(f.ends.length, 0)
})

test('at healthy health nothing changes: the burst goes on through the knockback', async () => {
  const f = fight({ health: 18 })
  await f.run(3000)
  assert.equal(f.target.alive, false)
  assert.equal(f.hits.length, 4)
})

test('the hold itself: seen in reach, then within the slack for the hold time, and not longer or farther', () => {
  let time = 0
  const hold = createContactHold({ reach: 3, clock: () => time })
  assert.equal(hold.touching([3.4, 5]), false, 'never seen in reach')
  assert.equal(hold.touching([2.9, 5]), true)
  time += KNOCKBACK_MS
  assert.equal(hold.touching([3 + KNOCKBACK_M, 5]), true)
  assert.equal(hold.touching([3 + KNOCKBACK_M + 0.01]), false, 'farther than the slack')
  time += 1
  assert.equal(hold.touching([3.2]), false, 'longer than the hold')
  assert.equal(hold.touching([]), false, 'nothing there')
  assert.equal(hold.touching([3.0]), true, 'and in reach again starts it again')
})
