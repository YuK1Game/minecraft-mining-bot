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

test('a walk that never gets free still starts after three seconds', async () => {
  const { ports, calls, world } = bench({ owns: true, busy: true, trip: true })
  await ports.walk({ x: 1 })
  assert.equal(world.clock, 3000)
  assert.equal(calls.length, 1)
})

// Whether a fight keeps the input from the cover moved to the owner: test/player-control-owner.test.js.
