'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { departPlayer } = require('../src/modes/player-departure')
const { createRuntimeOperations } = require('../src/runtime/runtime-operations')

function deferred () {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

// The departure uses the real Runtime travel operation, including its saved
// route read and cancellation check. Only unrelated mode attachment, disk I/O
// and the final travel actor are replaced; no Bot or Realm is involved.
function fixture (options = {}) {
  const shared = { botMode: 'player', playerWanted: true }, events = [], starts = []
  const input = { destination: { x: 96, y: 64, z: 0 } }
  const saved = { destination: { ...input.destination }, phase: 'travelling', legs: 2 }
  const aborted = () => shared.playerWanted !== true
  const runtime = {
    host: { shared },
    require: name => {
      if (name === './modes/mode-runtime') return { attachModeOperations () {} }
      if (name === './modes/dragon-ports') return { createDragonRuntimePorts: () => ({}) }
      if (name === './modes/player-workstation-runtime') return { createPlayerWorkstationRuntime: () => ({}) }
      assert.equal(name, 'node:fs/promises')
      return { readFile: async () => { events.push('read-route'); return options.read ? options.read() : JSON.stringify(saved) } }
    },
    travelRuntime: { longTravelFile: () => 'unused-player-departure-route.json' },
    ensureLongTravel: () => ({ start: request => { events.push('start-travel'); starts.push(request); return { busy: true } } })
  }
  const { operations } = createRuntimeOperations(runtime)
  const ports = {
    input, aborted,
    canPack: () => options.canPack !== false,
    pack: async () => { events.push('pack'); return options.pack?.() },
    leave: async () => { events.push('leave'); return options.leave?.() },
    dry: async () => { events.push('dry'); return options.dry?.() },
    waterNeeded: () => options.waterNeeded === true,
    travel: (target, travelOptions) => {
      events.push('request-travel')
      assert.equal(target, input, 'The original destination request reaches Runtime')
      assert.equal(travelOptions.aborted, aborted, 'Runtime receives the same live cancellation predicate')
      return operations.quarry.travelTo(target, travelOptions)
    }
  }
  return { shared, events, starts, saved, ports, run: () => departPlayer(ports) }
}

test('player departure packs, leaves and dries once before actual Runtime travel resumes its saved route', async () => {
  const f = fixture()
  assert.deepEqual(await f.run(), { busy: true })
  assert.deepEqual(f.events, ['pack', 'leave', 'dry', 'request-travel', 'read-route', 'start-travel'])
  assert.equal(f.starts.length, 1)
  assert.deepEqual(f.starts[0], { destination: f.ports.input.destination, resume: f.saved })
})

test('manual stop during the final station recovery save prevents all departure operations', async () => {
  const entered = deferred(), saved = deferred()
  const f = fixture({ pack: () => { entered.resolve(); return saved.promise } })
  const pending = f.run()
  await entered.promise
  // Recovery has picked the table up and is awaiting its final durable save.
  // A completed recovery result after /stop must not authorize a new trip.
  f.shared.playerWanted = false
  saved.resolve([{ phase: 'completed', collected: true, serverConfirmed: true }])
  await assert.rejects(pending, { code: 'LONG_TRAVEL_CANCELLED' })
  assert.deepEqual(f.events, ['pack'], 'No leave, dry, travel request or travel actor starts after stop')
  assert.equal(f.starts.length, 0)
})

for (const stage of ['leave', 'dry']) {
  test(`manual stop while ${stage} is pending prevents the next departure operation`, async () => {
    const entered = deferred(), finished = deferred()
    const f = fixture({ [stage]: () => { entered.resolve(); return finished.promise } })
    const pending = f.run()
    await entered.promise
    f.shared.playerWanted = false
    finished.resolve(true)
    await assert.rejects(pending, { code: 'LONG_TRAVEL_CANCELLED' })
    assert.deepEqual(f.events, stage === 'leave' ? ['pack', 'leave'] : ['pack', 'leave', 'dry'])
    assert.equal(f.starts.length, 0)
  })
}

test('manual stop during actual Runtime saved-route loading cannot start the travel actor', async () => {
  const entered = deferred(), loaded = deferred()
  const f = fixture({ read: () => { entered.resolve(); return loaded.promise } })
  const pending = f.run()
  await entered.promise
  f.shared.playerWanted = false
  loaded.resolve(JSON.stringify(f.saved))
  await assert.rejects(pending, { code: 'LONG_TRAVEL_CANCELLED' })
  assert.deepEqual(f.events, ['pack', 'leave', 'dry', 'request-travel', 'read-route'])
  assert.equal(f.starts.length, 0)
})

test('an already stopped player starts no packing, exit, water or travel work', async () => {
  const f = fixture()
  f.shared.playerWanted = false
  await assert.rejects(f.run(), { code: 'LONG_TRAVEL_CANCELLED' })
  assert.deepEqual(f.events, [])
  assert.equal(f.starts.length, 0)
})

test('an emergency departure skips optional station packing and still starts travel once', async () => {
  const f = fixture({ canPack: false, pack: () => assert.fail('An emergency must not wait for a table') })
  assert.deepEqual(await f.run(), { busy: true })
  assert.deepEqual(f.events, ['leave', 'dry', 'request-travel', 'read-route', 'start-travel'])
  assert.equal(f.starts.length, 1)
})

test('an ordinary house exit refusal still permits departure, while a stop during that refusal does not', async () => {
  const exitError = new Error('house exit is unavailable')
  const normal = fixture({ leave: () => { throw exitError } })
  assert.deepEqual(await normal.run(), { busy: true })
  assert.equal(normal.starts.length, 1)

  const entered = deferred(), refused = deferred()
  const stopped = fixture({ leave: () => { entered.resolve(); return refused.promise } })
  const pending = stopped.run()
  await entered.promise
  stopped.shared.playerWanted = false
  refused.reject(exitError)
  await assert.rejects(pending, { code: 'LONG_TRAVEL_CANCELLED' })
  assert.deepEqual(stopped.events, ['pack', 'leave'])
  assert.equal(stopped.starts.length, 0)
})

test('remaining in water after the exit blocks the actual travel request', async () => {
  const f = fixture({ waterNeeded: true })
  await assert.rejects(f.run(), { code: 'WATER_EXIT_FAILED' })
  assert.deepEqual(f.events, ['pack', 'leave', 'dry'])
  assert.equal(f.starts.length, 0)
})
