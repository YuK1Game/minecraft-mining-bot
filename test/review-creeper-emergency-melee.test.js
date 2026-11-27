'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createCombatCoordinator } = require('../src/combat/combat-coordinator')

test('cornered creeper emergency strike uses melee effectiveMode, enforces 1-hit PROFILE_HIT_LIMIT, and avoids engaging_null or forced approach', async () => {
  let creeperDist = 4.5
  let clockMs = 0
  const logs = []
  let engageCalls = 0
  let approachCalls = 0
  const creeper = () => ({
    kind: 'mob',
    runtimeId: '8442',
    uniqueId: '-798863908742',
    entityType: 'minecraft:creeper',
    dimension: 'overworld',
    alive: true,
    hostile: true,
    positionKnown: true,
    position: { x: creeperDist, y: 65, z: 0 }
  })
  const state = () => ({
    phase: 'spawned',
    gameMode: 'survival',
    dimension: 'overworld',
    health: 20,
    maxHealth: 20,
    dead: false,
    profile: 'bot',
    realm: { id: '42' },
    connectionId: 'c1',
    startedAt: '2026-11-27T00:00:00.000Z',
    runtimeEntityId: '1',
    lifecycle: { deathId: 0 },
    position: { x: 0, y: 66.62, z: 0 },
    inventory: { known: true, items: [{ slot: 0, name: 'minecraft:iron_sword', count: 1 }] }
  })
  const melee = {
    snapshot: () => ({ busy: false, hitsRequested: engageCalls }),
    preview: () => ({ ready: true }),
    engage: async () => {
      engageCalls++
      // Knock creeper back to 3.0m so next loop has g.mode === null while cornered emergency strike is still in 3.5m.
      creeperDist = 3.0
      return { code: 'HIT_LIMIT', hitsRequested: 1 }
    },
    cancel: async () => {},
    drain: async () => {}
  }
  const ranged = {
    snapshot: () => ({ busy: false }),
    preview: () => ({ ready: false, code: 'NO_BOW' }),
    engage: async () => ({ code: 'NO_BOW' }),
    cancel: async () => {},
    drain: async () => {}
  }
  const coordinator = createCombatCoordinator({
    getState: state,
    entities: { snapshot: () => [creeper()] },
    melee,
    ranged,
    acquire: async () => ({ acquired: true, token: 't1' }),
    resume: async () => {},
    canAct: () => true,
    retreat: async () => ({ ready: false, code: 'NO_ROUTE' }),
    approach: async () => { approachCalls++; return { ready: false, code: 'NO_ROUTE' } },
    canAcquireMeleeApproach: () => true,
    now: () => clockMs,
    sleep: async ms => { clockMs += ms },
    log: line => logs.push(String(line))
  })
  // First tick at 4.5m with failed evade marks this creeper cornered.
  await coordinator.tick()
  clockMs += 1500
  approachCalls = 0
  creeperDist = 2.3
  const out = await coordinator.tick()
  assert.equal(engageCalls, 1, 'creeper must only be hit once per claim even when knocked into 3.0m emergency reach')
  assert.equal(approachCalls, 0, 'must not force-approach creeper after hitting PROFILE_HIT_LIMIT')
  assert.equal(out?.code, 'PROFILE_HIT_LIMIT')
  assert.equal(logs.some(line => line.includes('engaging_null') || line.includes('mode=null')), false, logs.join('\n'))
})
