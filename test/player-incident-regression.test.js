'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createReturnSteps } = require('../src/modes/return/return-steps')
const { completed, failed } = require('../src/modes/return/return-result')
const { newGoal } = require('../src/modes/return/return-goal')

test('return verify marks CONTAINER_OPEN_REFUSED chest as unopened and falls back to spare chest', async () => {
  const base = { x: 9880, y: 65, z: 10139 }
  const spare = { x: 9882, y: 65, z: 10139 }
  const goal = newGoal({ id: 'inc1', reason: 'test', base, scope: 's1', now: 1000 })
  goal.stage = 'verify'
  goal.target = base

  const withdrawnFrom = []
  let swordTaken = false
  const blocks = new Map([
    [`${base.x},${base.y},${base.z}`, { known: true, name: 'minecraft:chest', boundingBox: 'block' }],
    [`${spare.x},${spare.y},${spare.z}`, { known: true, name: 'minecraft:chest', boundingBox: 'block' }]
  ])
  const steps = createReturnSteps({
    goal: () => goal,
    ports: {
      getBlock: (x, y, z) => blocks.get(`${x},${y},${z}`) ?? { known: true, name: 'minecraft:air', boundingBox: 'empty' },
      getPosition: () => ({ x: 9880.5, y: 66.62, z: 10140.5 }),
      getFeet: () => ({ x: 9880.5, y: 65, z: 10140.5 }),
      getInventory: () => ({ known: true, items: swordTaken ? [{ slot: 0, name: 'minecraft:iron_sword', count: 1 }] : [] }),
      policy: {
        cargo: () => [],
        restockWanted: () => !swordTaken,
        restock: slots => swordTaken ? [] : (slots ?? []).filter(s => s.name === 'minecraft:iron_sword').map(s => ({ chestSlot: s.slot, name: s.name, count: 1 }))
      },
      moves: { water: { needed: () => false }, house: { inside: () => false } },
      chests: {
        spares: () => [spare],
        all: () => [base, spare],
        hands: {
          access: () => null,
          contents: pos => pos.x === spare.x ? [{ known: true, slot: 0, name: 'minecraft:iron_sword', count: 1 }] : [{ known: true, slot: 0, name: 'minecraft:iron_sword', count: 1 }],
          take: async () => 0,
          withdraw: async pos => {
            withdrawnFrom.push(`${pos.x},${pos.y},${pos.z}`)
            if (pos.x === base.x) return failed('CONTAINER_OPEN_REFUSED', { evidence: { chest: pos } })
            swordTaken = true
            return completed('KIT_TAKEN', { progress: { confirmedTransferred: 1 }, evidence: { chest: pos } })
          }
        }
      }
    },
    flow: { ok: () => true, interrupter: () => null, say: () => {}, now: () => 2000, sleep: async () => {} }
  })

  const out = await steps.verify()
  assert.equal(out.status, 'completed')
  assert.equal(out.code, 'RETURN_DONE')
  assert.deepEqual(withdrawnFrom, ['9880,65,10139', '9882,65,10139'])
  assert.deepEqual(goal.unopened, [base])

  // A second verify call does not retry the unopened base chest.
  swordTaken = false
  const second = await steps.verify()
  assert.equal(second.status, 'completed')
  assert.deepEqual(withdrawnFrom, ['9880,65,10139', '9882,65,10139', '9882,65,10139'])
})
