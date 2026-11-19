'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createCoverPorts } = require('../src/modes/cover-ports')

function bench (over = {}) {
  const calls = []
  const world = { owns: false, busy: false, trip: false, combat: false, clock: 0, ...over }
  const ports = createCoverPorts({
    expedition: { owns: () => world.owns, busy: () => world.busy },
    cancelExpedition: () => { calls.push('cancel expedition'); world.ending = 2 },
    agent: { stop: reason => calls.push(`agent stop: ${reason}`) }, agentRunning: () => false,
    travelStatus: () => ({ busy: world.trip }),
    walk: async target => { calls.push(`walk ${target.x} trip=${world.trip} busy=${world.busy}`); return true },
    reachable: () => true, combatOwns: () => world.combat,
    now: () => world.clock,
    sleep: async ms => { world.clock += ms; if (world.ending && --world.ending === 0) { world.trip = false; world.busy = false } }
  })
  return { ports, calls, world }
}

test('under the expedition the cover ends the expedition action and its trip, and walks once both ended', async () => {
  const { ports, calls } = bench({ owns: true, busy: true, trip: true })
  assert.equal(ports.tripBlocks(), false, 'the expedition trip does not block the cover')
  assert.equal(ports.agent.running(), true)
  ports.agent.stop('弓の敵の射線から外れます。')
  assert.equal(await ports.walk({ x: 5 }), true)
  assert.deepEqual(calls, ['cancel expedition', 'walk 5 trip=false busy=false'])
})

test('outside the expedition nothing changes: the agent is stopped and another trip blocks the cover', async () => {
  const { ports, calls } = bench({ trip: true })
  assert.equal(ports.tripBlocks(), true)
  ports.agent.stop('x')
  assert.deepEqual(calls, ['agent stop: x'])
})

test('an archer with a route is left to the fight only while the fight holds the input', () => {
  const { ports, world } = bench()
  assert.equal(ports.reachable({}), false, 'no fight: nobody deals with it, so the cover does')
  world.combat = true
  ports.sample()
  world.combat = false
  world.clock += 1500
  assert.equal(ports.reachable({}), true, 'the fight held the input 1.5 s ago')
  world.clock += 1000
  assert.equal(ports.reachable({}), false, 'the fight ended 2.5 s ago (no stance): cover')
})

test('a walk that never gets free still starts after three seconds', async () => {
  const { ports, calls, world } = bench({ owns: true, busy: true, trip: true })
  await ports.walk({ x: 1 })
  assert.equal(world.clock, 3000)
  assert.equal(calls.length, 1)
})

// Live 2026-11-19 15:18:36-15:18:44 JST: four sword hits on a skeleton at 3.9 m; the cover then read the same skeleton
// at 4.9 m as "cannot be walked to", ended the fight (PLAYER_FLEE) and the Bot died two seconds later.
test('an archer the running fight has closed on is left to the fight, whatever the route check says', () => {
  const world = { combat: true, clock: 0 }
  const ports = createCoverPorts({
    expedition: { owns: () => false, busy: () => false }, cancelExpedition: () => {}, agent: { stop: () => {} }, agentRunning: () => false,
    travelStatus: () => ({ busy: false }), walk: async () => true,
    reachable: () => false, combatOwns: () => world.combat, getFeet: () => ({ x: 0, y: 78, z: 0 }), now: () => world.clock
  })
  assert.equal(ports.reachable({ position: { x: 4.9, y: 78, z: 0 } }), true, 'within 6 m of a fight that holds the input')
  assert.equal(ports.reachable({ position: { x: 13.5, y: 78, z: 0 } }), false, 'a far archer with no known route is still left')
  world.combat = false
  world.clock = 2500
  assert.equal(ports.reachable({ position: { x: 4.9, y: 78, z: 0 } }), false, 'no fight for two seconds: nobody is fighting it')
})
