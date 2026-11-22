'use strict'

// The real expedition owner, supplies and mining entry. Only the server's terrain request is a stand-in:
// unknown ground stays unknown. The former entry left the house for an arbitrary ore-search heading instead.
const test = require('node:test')
const assert = require('node:assert/strict')
const { createWorld, PICK } = require('./helpers/dragon-goal-world')
const { enterMine } = require('../src/modes/mining/mine-route')

test('the expedition asks the planned mine to observe unknown terrain before acquiring iron', async t => {
  const observed = [], trips = [], digs = []
  const unknown = () => ({ known: false })
  const w = await createWorld(t, {
    items: [PICK], getBlock: unknown,
    step: ctx => ctx.supplies.acquire('raw_iron', 4),
    ports: () => ({ getBlock: unknown,
      travelTo: async input => { trips.push(input); return false },
      hands: { block: unknown, canMine: () => false, mine: async at => { digs.push(at); return false } },
      minePorts: { observe: async cells => { observed.push(cells); return { status: 'blocked', code: 'TERRAIN_UNKNOWN' } } }
    })
  })
  w.raw.runtimeEntityId = '1'
  await w.pass(2000, { tickMs: 2000 })
  assert.equal(trips.length, 0, 'an ore shortage does not start the old arbitrary search trip')
  assert.equal(digs.length, 0, 'unknown terrain is not excavated')
  assert.ok(observed.length > 0, 'the actual mining controller requested the missing terrain')
  assert.equal(w.raw.inventory.items.some(row => row.name === 'minecraft:raw_iron'), false)
})

test('when an ordinary surface hop fails, a bounded route still requires a received entrance position', async () => {
  const to = { x: 16.5, y: 64, z: 0.5 }
  const branch = { plan: { shaft: { columns: [{ x: 16, z: 1 }], approach: to } } }
  const state = { profile: 'test', realm: { id: 'one' }, dimension: 'overworld', connectionId: 'a', startedAt: 'start',
    runtimeEntityId: '1', lifecycle: { deathId: 0 }, phase: 'spawned', health: 20 }
  let feet = { x: 0.5, y: 64, z: 0.5 }, arrivalConfirmed = false
  const saved = [], walks = []
  const receipt = async target => ({ status: 'completed',
    serverConfirmed: arrivalConfirmed && ['x', 'y', 'z'].every(axis => feet[axis] === target[axis]) })
  const getBlock = (x, y, z) => ({
    known: y === 63 || y === 64 || y === 65,
    name: y === 63 ? 'minecraft:stone' : 'minecraft:air',
    boundingBox: y === 63 ? 'block' : 'empty'
  })
  const ctx = {
    runtime: { raw: () => state, inventory: () => ({ known: true, items: [] }) },
    getFeet: () => feet, getBlock, cancelled: () => false,
    saveMine: async () => { saved.push(branch.intent && structuredClone(branch.intent)); return true },
    hands: {
      feet: () => feet, block: getBlock, approach: async () => false,
      walk: async target => { walks.push(target); feet = target; return true }
    },
    minePorts: { confirmPosition: receipt, walk: receipt }
  }
  const unconfirmed = await enterMine(ctx, branch)
  assert.ok(walks.length >= 2, 'the route used short steps to cross the distance: ' + JSON.stringify(unconfirmed))
  assert.deepEqual(feet, to)
  assert.equal(unconfirmed.serverConfirmed, false)
  assert.equal(saved[0].purpose, 'mine_entry', 'the exact approach is saved before movement')
  assert.equal(branch.intent.purpose, 'mine_entry', 'the originally sent movement remains awaiting proof')
  arrivalConfirmed = true
  assert.equal((await enterMine(ctx, branch)).serverConfirmed, true)
  assert.equal(branch.intent, undefined)
})

test('returning from distant supplies travels to the fixed site, then verifies the exact entrance', async () => {
  const to = { x: 96.5, y: 64, z: 24.5 }, branch = { plan: { shaft: { approach: to } } }
  const state = { profile: 'test', realm: { id: 'one' }, dimension: 'overworld', connectionId: 'a', startedAt: 'start',
    runtimeEntityId: '1', lifecycle: { deathId: 0 }, phase: 'spawned', health: 20 }
  let feet = { x: 0.5, y: 58, z: 24.5 }
  const calls = []
  const ctx = {
    runtime: { raw: () => state, inventory: () => ({ known: true, items: [] }) },
    getFeet: () => feet, cancelled: () => false, saveMine: async () => true,
    travelTo: async (input, { aborted }) => {
      calls.push(['travel', input.destination])
      assert.equal(aborted(), false)
      feet = { ...to, x: to.x - 19 }
      return { phase: 'arrived' }
    },
    hands: { approach: async point => { calls.push(['approach', point]); feet = { ...point, x: point.x - 1 }; return true } },
    minePorts: { walk: async point => { calls.push(['walk', point]); feet = point; return { status: 'completed', serverConfirmed: true } } }
  }
  const result = await enterMine(ctx, branch)
  assert.deepEqual(calls, [['travel', { x: 96, z: 24 }], ['approach', to], ['walk', to]])
  assert.equal(result.serverConfirmed, true)
  assert.equal(branch.intent, undefined)
})

test('a confirmed clear entrance can be walked after a recorded workstation is broken even if pickup is pending', async () => {
  const to = { x: 2.5, y: 64, z: 0.5 }, at = { x: 2, y: 64, z: 0 }
  const branch = { plan: { shaft: { approach: to } } }
  const state = { profile: 'test', realm: { id: 'one' }, dimension: 'overworld', connectionId: 'a', startedAt: 'start',
    runtimeEntityId: '1', lifecycle: { deathId: 0 }, phase: 'spawned', health: 20 }
  let feet = { x: 0.5, y: 64, z: 0.5 }, block = 'crafting_table', clear = false
  const calls = []
  const ctx = {
    runtime: { raw: () => state, inventory: () => ({ known: true, items: [] }) },
    getFeet: () => feet, cancelled: () => false, saveMine: async () => true,
    getBlock: () => ({ known: true, name: 'minecraft:' + block }),
    operations: { playerWorkstations: { recoverAt: async target => {
      calls.push(['recover', target])
      if (clear) block = 'air'
      return { phase: 'deferred', code: clear ? 'STATION_PICKUP_UNREACHABLE' : 'STATION_MINING_DENIED', collected: false }
    } } },
    minePorts: { walk: async point => { calls.push(['walk', point]); feet = point; return { status: 'completed', serverConfirmed: true } } }
  }
  assert.equal((await enterMine(ctx, branch)).code, 'MINE_ENTRY_UNREACHABLE')
  assert.deepEqual(calls, [['recover', at]])
  clear = true
  assert.equal((await enterMine(ctx, branch)).serverConfirmed, true)
  assert.deepEqual(calls, [['recover', at], ['recover', at], ['walk', to]])
})
