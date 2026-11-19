'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createCoverPorts } = require('../src/modes/cover-ports')

// What can still send when the cover takes the input, and how each part is asked to stop.
// The handoff itself (deadline, HANDOFF_INCOMPLETE, no walk): test/player-control-handoff.test.js.
function bench (over = {}) {
  const calls = []
  const world = { owns: false, sending: false, running: false, trip: false, moving: false, held: false, ...over }
  const ports = createCoverPorts({
    expedition: { owns: () => world.owns, sending: () => world.sending },
    cancelExpedition: () => { calls.push('cancel expedition'); world.sending = false },
    agent: { stop: reason => { calls.push(`agent stop: ${reason}`); world.running = false } }, agentRunning: () => world.running,
    travelStatus: () => ({ busy: world.trip }), cancelTrip: async () => { calls.push('cancel trip') },
    motion: { moving: () => world.moving, stop: reason => { calls.push(`motion stop: ${reason}`); world.moving = false } },
    held: () => world.held
  })
  return { ports, calls, world }
}

test('under the expedition: its running step, its trip and a motion in flight hold the input; the step is cancelled, the motion stopped', () => {
  const { ports, calls, world } = bench({ owns: true, sending: true, trip: true, moving: true })
  assert.equal(ports.tripBlocks(), false, 'the expedition trip does not block the cover')
  assert.deepEqual(ports.hold.holding(), ['work', 'trip', 'motion'])
  ports.hold.interrupt(ports.hold.holding(), '弓の敵の射線から外れます。')
  assert.deepEqual(calls, ['cancel expedition', 'cancel trip', 'motion stop: 弓の敵の射線から外れます。'])
  assert.deepEqual(ports.hold.holding(), ['trip'], 'the trip holds until its own loop has ended')
  world.trip = false
  assert.deepEqual(ports.hold.holding(), [])
})

test('an expedition step that was aborted, or only saves, holds nothing', () => {
  const { ports } = bench({ owns: true, sending: false })
  assert.deepEqual(ports.hold.holding(), [])
})

test('outside the expedition: the autonomy is stopped, and another trip blocks the cover', () => {
  const { ports, calls } = bench({ running: true, trip: true })
  assert.equal(ports.tripBlocks(), true)
  ports.hold.interrupt(['work'], 'x')
  assert.deepEqual(calls, ['agent stop: x'])
})

test('a fight that holds the input, and a part that cannot be read, count as holding', () => {
  assert.deepEqual(bench({ held: true }).ports.hold.holding(), ['fight'])
  const broken = createCoverPorts({ expedition: { owns: () => false, sending: () => false }, cancelExpedition: () => {}, agent: { stop () {} }, agentRunning: () => false, travelStatus: () => { throw new Error('unread') } })
  assert.deepEqual(broken.hold.holding(), ['trip'])
})
