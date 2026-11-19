'use strict'
// Who holds the input near enemies, from the start decision to the operation that is called
// (control-owner.js, defense-walks.js). The walks are built as mode-runtime.js builds them; what
// is counted is what reaches the runtime's operations (`sent`), and what the layer below them
// had to refuse because a movement was already in flight (`lower`): a run that the owner
// keeps out never gets that far.
const test = require('node:test')
const assert = require('node:assert/strict')
const { createDefenseWalks } = require('../src/modes/defense-walks')
const { createScaffoldPorts } = require('../src/modes/player-scaffold-ports')
const { createDragonExpedition } = require('../src/modes/dragon-expedition')
const { walkableCells } = require('../src/modes/player-drops')
const { createCombatExposure } = require('../src/combat/combat-exposure')
const { standsDown, holderOf, HANDOFF_MS } = require('../src/modes/control-owner')

// Flat stone floor at y=63 and a wall two high along x=3 for z=-1..1: behind it a skeleton in the west sees nothing.
const getBlock = (x, y, z) => {
  if (y <= 63) return { known: true, name: 'minecraft:stone', boundingBox: 'block' }
  if (x === 3 && z >= -1 && z <= 1 && y <= 65) return { known: true, name: 'minecraft:stone', boundingBox: 'block' }
  return { known: true, name: 'minecraft:air', boundingBox: 'empty' }
}
const skeleton = (x, z = 0.5) => ({ entityType: 'minecraft:skeleton', runtimeId: 7, hostile: true, alive: true, position: { x, y: 64, z } })
const SWORD = { known: true, items: [{ name: 'minecraft:stone_sword', count: 1 }] }

function bench (over = {}) {
  const w = {
    clock: 100000, health: 9, position: { x: 0.5, y: 65.62, z: 0.5 }, inventory: SWORD, hostiles: [skeleton(-10.5)],
    motion: { phase: 'idle' }, walkMs: 2000, sent: [], lower: [], asked: 0, pendingStop: 0, logs: [], hooks: [], gate: null,
    agentRunning: false, trip: false, tripEndsOnCancel: true, combat: null, combatOwns: false, life: 'life-1', mode: 'player', disposed: false,
    expedition: { owns: false, sending: false }, ...over
  }
  const shared = { playerWanted: true, recentDamageNoPrimary: { at: w.clock - 500 } }
  const arrive = () => { if (w.motion.phase === 'moving' && w.clock >= w.motion.done) { Object.assign(w.position, { x: w.motion.target.x, y: w.motion.target.y + 1.62, z: w.motion.target.z }); w.motion = { phase: 'idle' } } }
  // Time passes only in the sleeps of the code under test; a test hooks in there, or holds a run at its sleep.
  const sleep = async ms => {
    w.clock += ms
    arrive()
    for (const hook of w.hooks.splice(0)) { if (w.clock >= hook.at) hook.run(); else w.hooks.push(hook) }
    w.onSleep?.()
    if (w.gate) await w.gate
  }
  // The runtime's operations: the boundary. A movement started while another is in flight is the lower lock's refusal.
  const start = (label, target) => {
    w.asked++
    // The runtime still ends the previous operation (requireIdle): the caller waits and tries again.
    if (w.pendingStop > 0) { w.pendingStop--; throw new Error('前の操作の終了処理を待ってください。') }
    if (w.motion.phase === 'moving') { w.lower.push(label); throw new Error('前の操作が完了するまで待ってください。') }
    w.sent.push(label)
    w.motion = { phase: 'moving', target, done: w.clock + w.walkMs }
  }
  const operations = {
    movement: {
      start: target => start(`movement.start ${target.x},${target.z}`, target),
      stop: () => { w.sent.push('movement.stop'); w.motion = { phase: 'idle' } },
      settle: () => {}
    }
  }
  const runtime = {
    raw: () => ({ health: w.health, inventory: w.inventory }), inventory: () => w.inventory, hostiles: () => w.hostiles, totem: () => false,
    motion: () => w.motion, combatFight: () => w.combat, combatOwns: () => w.combatOwns,
    // One step straight away, as long-travel-runtime.js retreatStep: nothing once the signal says the input is gone.
    travel: () => ({
      retreatFromHostiles: async signal => {
        if (signal?.aborted) return false
        try { start('retreat step', { x: w.position.x + 8, y: 64, z: w.position.z }) } catch { return false }
        while (w.motion.phase === 'moving') await sleep(200)
        return true
      }
    })
  }
  const walks = createDefenseWalks({
    shared, getMode: () => w.mode, log: text => w.logs.push(text), disposed: () => w.disposed, runtime, now: () => w.clock, sleep,
    agent: { stop: reason => { w.sent.push('agent.stop'); w.agentRunning = false; if (w.motion.phase === 'moving') w.motion = { phase: 'idle' } } },
    agentStatus: () => ({ running: w.agentRunning }),
    quarry: { travelStatus: () => ({ busy: w.trip }), cancelTravel: async () => { w.sent.push('trip.cancel'); if (w.tripEndsOnCancel) w.trip = false } },
    where: () => w.position, hunger: () => 20,
    expedition: () => ({ owns: () => w.expedition.owns, sending: () => w.expedition.sending }),
    cancelExpedition: () => { w.sent.push('expedition.cancel'); w.expedition.sending = false },
    hands: lease => createScaffoldPorts({ operations: lease.guard(operations), disposed: () => w.disposed || !lease.live(), getBlock, getFeet: () => ({ x: w.position.x, y: w.position.y - 1.62, z: w.position.z }), getInventory: () => w.inventory, getMotion: () => w.motion, pillarStep: async () => ({}), sleep, now: () => w.clock }),
    stopMotion: reason => operations.movement.stop(reason), scope: () => w.life, unreachable: () => false,
    exposure: options => createCombatExposure({ world: { getBlock }, entities: {}, scopeOf: () => null, ...options }),
    cells: position => walkableCells(position, getBlock).values()
  })
  return { w, shared, ...walks, at: (ms, run) => w.hooks.push({ at: w.clock + ms, run }) }
}
// The nearest cell the skeleton in the west does not see: behind the wall.
const WALK = 'movement.start 4.5,1.5'
const starts = w => w.sent.filter(text => /^movement\.start|^retreat step/.test(text))

// A1. Before: the flee overwrote the cover's claim, stopped the work again and asked for its own step while
// the cover walked; its three steps were refused by the movement lock and it ended "no way to leave", resting 30 s.
test('A1: a cover that started at health 9 keeps the input when health falls to 7 during its walk; the flee sends nothing', async () => {
  const { w, shared, flee, cover, at } = bench({ agentRunning: true })
  let during = null, holder = null
  at(900, () => { w.health = 7; shared.recentDamageNoPrimary = { at: w.clock }; holder = shared.playerFlee.id; during = flee.tick() })
  assert.equal(await cover.tick(), true)
  assert.equal(await during, false, 'the flee did not run')
  assert.equal(flee.status().skip, 'cover_walking')
  assert.match(holder, /^cover#\d+$/)
  // One stop of the work and one walk: nothing of the flee reached the operations, and nothing was left to the lock below.
  assert.deepEqual(w.sent, ['agent.stop', WALK])
  assert.deepEqual(w.lower, [])
  assert.equal(cover.status().last.code, 'COVERED')
  assert.equal(cover.status().last.evidence.lease, holder)
  assert.equal(shared.playerFlee, null, 'released by the run that acquired it')
  assert.ok(!w.logs.some(text => /離れる経路がない|離れ直しません/.test(text)), 'the flee drew no conclusion about the way')
  // Afterwards the flee is not kept out by the owner any more (behind the wall the skeleton is no threat).
  assert.equal(await flee.tick(), false)
  assert.equal(flee.status().skip, 'no_threat')
})

test('A1: the other way round, a flee in progress keeps the input from the cover', async () => {
  const { w, flee, cover, at } = bench({ health: 7, hostiles: [skeleton(-10.5), { entityType: 'minecraft:zombie', runtimeId: 9, hostile: true, alive: true, position: { x: -6.5, y: 64, z: 0.5 } }] })
  let during = null
  at(400, () => { during = cover.tick() })
  assert.equal(await flee.tick(), true)
  assert.equal(await during, false)
  assert.equal(cover.status().skip, 'fleeing')
  assert.ok(starts(w).length >= 1 && starts(w).every(text => text === 'retreat step'))
  assert.deepEqual(w.lower, [])
})

// A2. Before: fifteen waits of 200 ms, then the walk was called whether or not the trip and the expedition had ended.
test('A2: while the old trip can still send after the deadline, no walk is called and the answer is HANDOFF_INCOMPLETE', async () => {
  const { w, shared, cover } = bench({ expedition: { owns: true, sending: true }, trip: true, tripEndsOnCancel: false })
  const from = w.clock
  assert.equal(await cover.tick(), false)
  assert.equal(w.clock - from, HANDOFF_MS)
  assert.deepEqual(w.sent, ['expedition.cancel', 'trip.cancel'], 'the expedition and its trip were asked to stop; no movement was sent')
  const last = cover.status().last
  assert.equal(last.status, 'blocked')
  assert.equal(last.code, 'HANDOFF_INCOMPLETE')
  assert.deepEqual(last.evidence.holding, ['trip'])
  assert.deepEqual(last.retry, { kind: 'owner_released' })
  assert.equal(shared.playerFlee, null)
  assert.match(w.logs.at(-1), /前の操作（trip）がまだ入力を持っているため、射線から外れる歩きを始めません（HANDOFF_INCOMPLETE、操作権 cover#\d+）/)
})

test('A2: an old job that only saves or cleans up does not hold the handoff back', async () => {
  // The expedition's step has returned and its save is still pending (dragon-expedition.js).
  let saved = null
  const expedition = createDragonExpedition({
    state: { observe: async () => {}, record: () => ({ stage: 'nether' }), save: () => new Promise(resolve => { saved = resolve }) },
    raw: () => ({ phase: 'spawned', health: 20, dimension: 'overworld', inventory: { known: true } }), active: () => true, legacyNeeded: () => false, legacyBusy: () => false, legacyIdle: () => true, stopLegacy: () => {},
    run: async record => { record.touched = true; return { phase: 'working', reason: 'x' } }
  })
  expedition.tick()
  for (let i = 0; i < 20 && !saved; i++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(typeof saved, 'function', 'the step is at its save')
  assert.equal(expedition.busy(), true)
  assert.equal(expedition.sending(), false, 'a step at its save sends nothing')
  const { w, cover } = bench({ expedition: { owns: true, sending: expedition.sending() } })
  const from = w.clock
  assert.equal(await cover.tick(), true)
  assert.deepEqual(w.sent, [WALK], 'walked at once, the expedition was not cancelled for it')
  assert.ok(w.clock - from < HANDOFF_MS)
  saved(true)
})

test('A2: a movement in flight is stopped by the ordinary stop and seen stopped before the walk', async () => {
  const { w, cover } = bench({ motion: { phase: 'moving', target: { x: -3.5, y: 64, z: 0.5 }, done: Infinity } })
  assert.equal(await cover.tick(), true)
  assert.deepEqual(w.sent, ['movement.stop', WALK])
  assert.deepEqual(w.lower, [], 'the walk did not run into the movement lock')
})

// A3. An old run that comes back after a new holder started.
test('A3: an old run cannot clear the new holder, and the operation it sends next is refused where it is called', async () => {
  const { w, shared, flee, cover } = bench({ pendingStop: 1 })
  // The cover's first start is answered "the previous operation is still ending"; its run waits to try again, and is held there.
  let open = null
  w.gate = new Promise(resolve => { open = resolve })
  const old = cover.tick()
  for (let i = 0; i < 20 && w.asked < 1; i++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(w.asked, 1)
  assert.deepEqual(w.sent, [])
  const first = shared.playerFlee.id
  // Its lease runs out (a run that does not return), health falls, and the flee becomes the holder and walks.
  w.gate = null
  w.clock += 15000
  w.health = 7
  shared.recentDamageNoPrimary = { at: w.clock }
  let hold = null
  w.onSleep = () => { if (!hold && w.sent.includes('retreat step')) w.gate = new Promise(resolve => { hold = resolve }) }
  const next = flee.tick()
  for (let i = 0; i < 50 && !hold; i++) await new Promise(resolve => setImmediate(resolve))
  const second = shared.playerFlee.id
  assert.match(second, /^flee#\d+$/)
  assert.notEqual(second, first)
  assert.deepEqual(w.sent, ['retreat step'])
  assert.equal(w.asked, 2)
  // The old run comes back and tries its start again: refused by its lease, before the runtime's operation is called.
  open()
  assert.equal(await old, false)
  assert.equal(w.asked, 2, 'the old run\'s start never reached the operations')
  assert.deepEqual(w.lower, [], 'and so was not left to the movement lock')
  assert.equal(cover.status().last.status, 'interrupted')
  assert.equal(cover.status().last.code, 'LEASE_REPLACED')
  assert.equal(shared.playerFlee.id, second, 'the old run released nothing of the new holder')
  w.onSleep = null
  w.gate = null
  w.motion = { phase: 'idle' }
  w.hostiles = []
  hold()
  await next
  assert.equal(shared.playerFlee, null)
})

test('A3: a motion the old run left in flight is stopped, and seen stopped, before the new holder\'s first step', async () => {
  const { w, shared, flee, cover } = bench({ walkMs: Infinity })
  let open = null
  w.gate = new Promise(resolve => { open = resolve })
  const old = cover.tick()
  for (let i = 0; i < 20 && !starts(w).length; i++) await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(w.sent, [WALK])
  w.gate = null
  w.clock += 15000
  w.health = 7
  shared.recentDamageNoPrimary = { at: w.clock }
  w.walkMs = 2000
  let steps = 0
  w.onSleep = () => { if (w.sent.filter(text => text === 'retreat step').length > steps) { steps++; w.hostiles = [] } }
  assert.equal(await flee.tick(), true)
  assert.deepEqual(w.sent, [WALK, 'movement.stop', 'retreat step'])
  assert.deepEqual(w.lower, [])
  open()
  assert.equal(await old, false)
  assert.deepEqual(starts(w), [WALK, 'retreat step'], 'no operation of the old run after the new holder started')
  assert.equal(shared.playerFlee, null)
})

test('A3: the lease itself: release and send of a replaced run', () => {
  const { w, shared, owner } = bench()
  const a = owner.acquire('cover', { ms: 14000 }).lease
  w.clock += 14001
  assert.equal(a.lost(), 'LEASE_EXPIRED')
  assert.equal(owner.walking(), null, 'every reader sees the same: nobody holds it')
  assert.equal(standsDown({ shared, target: skeleton(-10.5), state: { position: w.position }, armed: true, now: w.clock, scope: w.life }), false)
  const b = owner.acquire('flee', { ms: 12000 }).lease
  assert.equal(b.gen, a.gen + 1)
  assert.equal(a.lost(), 'LEASE_REPLACED')
  assert.equal(a.release(), false)
  assert.equal(a.renew(14000), false)
  assert.equal(shared.playerFlee.id, b.id)
  let called = 0
  assert.throws(() => a.send(() => { called++ }), { code: 'LEASE_REPLACED' })
  assert.throws(() => a.guard({ movement: { start: () => { called++ } } }).movement.start({}), { code: 'LEASE_REPLACED' })
  assert.equal(a.signal().aborted, true)
  assert.equal(called, 0)
  assert.equal(b.send(() => 'sent'), 'sent')
  assert.equal(b.release(), true)
})

// A4. Combat's own acquisition cancels the input at once and waits for nobody's save
// (user-control-runtime.js acquireUserControl; test/review-chunk-travel-runtime.test.js,
// test/review-manual-chest-runtime.test.js). Here: the walk's side of the same switch.
test('A4: the fight takes the input in contact while the walk\'s run is still busy; nothing waits for that run', async () => {
  const { w, shared, flee } = bench({ health: 7 })
  // The flee's first step is in flight and its run is held (an old job that is slow to end).
  let open = null
  w.onSleep = () => { if (!open && w.sent.includes('retreat step')) w.gate = new Promise(resolve => { open = resolve }) }
  const next = flee.tick()
  for (let i = 0; i < 50 && !open; i++) await new Promise(resolve => setImmediate(resolve))
  w.onSleep = null
  // A zombie reaches the Bot: combat may pick it at once (rule 2), while the flee's run has not ended.
  const zombie = { entityType: 'minecraft:zombie', hostile: true, position: { x: w.position.x + 1.5, y: 64, z: w.position.z } }
  w.hostiles = [zombie]
  assert.equal(flee.status().active, true)
  assert.equal(standsDown({ shared, target: zombie, state: { position: w.position }, armed: () => true, now: w.clock, scope: w.life }), false)
  w.combatOwns = true
  w.motion = { phase: 'idle' }
  const before = starts(w).length
  w.gate = null
  open()
  await next
  assert.equal(flee.status().last.status, 'interrupted')
  assert.equal(flee.status().last.code, 'FIGHT_HOLDS_INPUT')
  assert.equal(starts(w).length, before, 'the flee sent no further step once the fight held the input')
  assert.equal(shared.playerFlee, null)
  assert.ok(!w.logs.some(text => /離れる経路がない/.test(text)))
})

// A5. Before: arriving at the planned cell was "out of the line of fire".
test('A5: the archer moves during the walk: arriving is not cover, the Bot plans again from where both are now', async () => {
  const { w, cover, at } = bench()
  // While the Bot walks behind the wall's east side, the skeleton comes round to the east as well.
  at(600, () => { w.hostiles = [skeleton(14.5)] })
  assert.equal(await cover.tick(), true)
  assert.equal(starts(w)[0], WALK)
  assert.equal(starts(w).length, 2, 'a second walk, to the side the skeleton does not see now')
  const feet = { x: w.position.x, y: w.position.y - 1.62, z: w.position.z }
  assert.ok(feet.x < 3, 'west of the wall')
  assert.equal(cover.status().last.code, 'COVERED')
  assert.deepEqual(cover.status().last.progress, { walks: 2 })
  assert.equal(w.logs.filter(text => /射線から外れました/.test(text)).length, 1)
})

test('A5: arrived where an archer still sees the body, with no other place: said as it is, not as cover', async () => {
  const { w, cover, at } = bench()
  // A second skeleton appears in the east, and one in the north-west sees the west side: no cell is hidden from all three.
  at(600, () => { w.hostiles = [skeleton(-10.5), skeleton(14.5), skeleton(4.5, -12.5), skeleton(4.5, 13.5), skeleton(2.5, -12.5), skeleton(2.5, 13.5)] })
  assert.equal(await cover.tick(), false)
  assert.equal(cover.status().last.status, 'failed')
  assert.equal(cover.status().last.code, 'STILL_EXPOSED')
  assert.ok(!w.logs.some(text => /射線から外れました/.test(text)))
  assert.match(w.logs.at(-1), /歩いた先でも skeleton の射線が通っています/)
})

test('A5: an unread position after the walk is not cover', async () => {
  const { w, cover, at } = bench()
  at(600, () => { w.inventory = null })
  assert.equal(await cover.tick(), false)
  assert.equal(cover.status().last.code, 'COVER_UNKNOWN')
  assert.ok(!w.logs.some(text => /射線から外れました/.test(text)))
})

// A6. A lease belongs to one connection, dimension and life, one play and one code generation.
for (const [name, change, code] of [
  ['death or reconnect or dimension change', w => { w.life = 'life-2' }, 'SCOPE_CHANGED'],
  ['a manual stop', (w, shared) => { shared.playerWanted = false }, 'NOT_ACTIVE'],
  ['a mode switch', w => { w.mode = 'quarry' }, 'NOT_ACTIVE'],
  ['a hot reload', w => { w.disposed = true }, 'NOT_ACTIVE']
]) {
  test(`A6: across ${name} the old run sends nothing more, and the next run acquires anew`, async () => {
    const { w, shared, owner, cover, at } = bench()
    let lease = null
    at(600, () => { lease = shared.playerFlee.id; change(w, shared) })
    assert.equal(await cover.tick(), false)
    assert.deepEqual(starts(w), [WALK], 'the walk in flight was the last operation of that run')
    assert.equal(cover.status().last.status, 'interrupted')
    assert.equal(cover.status().last.code, code)
    if (code === 'SCOPE_CHANGED') {
      // Readers of the old record agree at once, before anybody released it.
      assert.equal(holderOf({ playerFlee: { who: 'cover', id: 'cover#1', scope: 'life-1', until: w.clock + 9000 } }, { now: w.clock, scope: 'life-2' }), null)
    }
    assert.equal(shared.playerFlee, null)
    // In the current connection and life, in play again: a new lease with a new generation.
    w.mode = 'player'; w.disposed = false; shared.playerWanted = true
    w.motion = { phase: 'idle' }
    const again = owner.acquire('cover', { ms: 14000 })
    assert.equal(again.acquired, true)
    assert.notEqual(again.lease.id, lease)
    assert.equal(again.lease.live(), true)
    again.lease.release()
  })
}

test('A6: a record left by a holder of another life is cleared by the owner, and no walk starts while play is off', () => {
  const { w, shared, owner } = bench()
  const lease = owner.acquire('flee', { ms: 12000 }).lease
  w.life = 'life-2'
  assert.equal(owner.walking(), null)
  owner.sample()
  assert.equal(shared.playerFlee, null)
  assert.equal(lease.release(), false)
  shared.playerWanted = false
  assert.deepEqual(owner.acquire('flee', { ms: 12000 }), { acquired: false, code: 'NOT_ACTIVE', holder: null })
})

// The same contract for the fight: acquire answers FIGHT_ON, and nothing is recorded.
test('an armed fight that is on: neither walk acquires, neither sends', async () => {
  const { w, shared, flee, cover } = bench({ health: 7, combat: { busy: true, claim: { claimId: 3 }, lastResult: null }, combatOwns: true })
  assert.equal(await flee.tick(), false)
  assert.equal(flee.status().skip, 'fighting')
  assert.equal(await cover.tick(), false)
  assert.equal(cover.status().skip, 'fighting')
  assert.deepEqual(w.sent, [])
  assert.equal(shared.playerFlee, undefined)
})
