'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { recoverDragon } = require('../src/modes/dragon-recovery')

function setup (dimension = 'overworld') {
  const position = { x: 0.5, y: 66.62, z: 0.5 }
  const raw = { dimension, position, health: 20, inventory: { known: true, items: [] } }
  const pos = { x: 1, y: 65, z: 0 }, calls = [], actors = []
  const record = { stage: 'end', early: { reserveReady: true }, stronghold: { outpostChest: pos }, recovery: { dimension: 'end', position: { ...position }, at: Date.now(), repeated: false } }
  const ctx = {
    runtime: { raw: () => raw, host: () => ({ entities: { snapshot: () => actors } }) },
    getBlock: (x, y, z) => Math.abs(x) > 4 || Math.abs(z) > 4 ? { known: false } : { known: true, name: y < 65 ? 'minecraft:end_stone' : 'minecraft:air', boundingBox: y < 65 ? 'block' : 'empty' },
    getFeet: () => ({ ...position, y: 65 }), hands: { walk: async p => calls.push(['walk', p]) },
    supplies: { reserve: async (p, options) => { calls.push(['reserve', options]); return { done: true } } },
    shared: {}, cancelled: () => false
  }
  return { ctx, record, raw, calls, actors }
}

test('withdraw at respawn outpost, never walk to same XYZ in the wrong world; skip last reserve on repeated death', async () => {
  const { ctx, record, calls } = setup()
  await recoverDragon(ctx, record)
  assert.equal(calls[0][0], 'reserve')
  assert.equal(calls[0][1].kit, 'end')
  assert.equal(record.recovery, null)
  assert.equal(record.lootRecovery.dimension, 'end')
  assert.equal((await recoverDragon(ctx, record)).done, true)
  assert.equal(calls.length, 1)
  record.recovery = { repeated: true, dimension: 'end', at: Date.now() }
  await recoverDragon(ctx, record)
  assert.equal(calls.at(-1)[1].keepReserve, true)
})

test('near a safe death drop, normal pickup requires an actual inventory increase; skip hazardous ground and nearby enemies', async () => {
  const { ctx, record, calls, raw, actors } = setup('end')
  const drop = { kind: 'item', dimension: 'end', name: 'minecraft:diamond_sword', count: 1, uniqueId: '12', alive: true, positionKnown: true, position: { x: 2.2, y: 65, z: 0.5 } }
  actors.push(drop)
  await recoverDragon(ctx, record)
  assert.equal(calls[0][0], 'walk')
  assert.equal(record.lootRecovery.pending.before, 0)
  actors.pop()
  assert.match((await recoverDragon(ctx, record)).reason, /待っています/)
  raw.inventory.items.push({ name: drop.name, count: 1 })
  assert.match((await recoverDragon(ctx, record)).reason, /確認しました/)
  assert.equal(calls.length, 1)
  record.lootRecovery = { dimension: 'end', position: raw.position, at: Date.now() }
  actors.push(drop, { dimension: 'end', hostile: true, alive: true, positionKnown: true, position: raw.position })
  await recoverDragon(ctx, record)
  assert.equal(record.lootRecovery, null)
  assert.equal(calls.length, 1)
  actors.pop()
  record.lootRecovery = { dimension: 'end', position: raw.position, at: Date.now(), cause: 'death.attack.outOfWorld' }
  await recoverDragon(ctx, record)
  assert.equal(calls.length, 1)
})
