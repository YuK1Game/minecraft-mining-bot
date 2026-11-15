'use strict'
// Player mode may cut natural trees for logs (the quarry rule stays): the real
// survival plan answers "no wood, wait", and in player mode that becomes the
// real base plan's log work.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { nextBootstrapAction } = require('../src/survival/planner')
const { nextSurvivalAction } = require('../src/survival/survival-planner')
const { logsAllowed, withPlayerWood } = require('../src/modes/player-wood')

function emptyHandedByATree () {
  const state = { phase: 'spawned', gameMode: 'survival', health: 20, position: { x: 0.5, y: 66.62, z: 0.5 }, version: '1.26.60', world: { initialized: true, loadedSections: 1, version: '1.26.60' },
    inventory: { known: true, items: [] }, selectedSlot: 0, heldItem: null, capabilities: { mining: true, movement: true } }
  const map = new Map()
  const set = (x, y, z, name) => map.set(`${x},${y},${z}`, { known: true, name: `minecraft:${name}`, position: { x, y, z }, extra: [] })
  for (let x = -2; x <= 7; x++) for (let y = 63; y <= 71; y++) for (let z = -2; z <= 3; z++) set(x, y, z, y <= 64 ? 'stone' : 'air')
  for (let y = 65; y <= 68; y++) set(2, y, 0, 'oak_log')
  set(2, 69, 0, 'oak_leaves')
  const observations = { blocks: [...map.values()], capabilities: { craft: true, place_block: true, equip: true, use_table: true, scan_blocks: true, collect_drops: true }, crafting: { previews: {} } }
  return { state, observations }
}

test('player mode turns the wood wait of the real survival plan into log work on a natural tree', () => {
  const { state, observations } = emptyHandedByATree()
  const waiting = nextSurvivalAction(state, observations, { firstWoodenSwordOnly: true })
  assert.equal(waiting.code, 'wood_harvest_disabled')
  const planLogs = () => nextBootstrapAction(state, observations, { allowLogs: true, logCount: 10 })
  assert.equal(withPlayerWood({ mode: 'quarry', decision: waiting, planLogs }), waiting)
  const work = withPlayerWood({ mode: 'player', decision: waiting, planLogs })
  assert.notEqual(work.code, 'wood_harvest_disabled')
  assert.ok(work.type === 'gather_logs' || work.resource === 'logs')
  assert.match(JSON.stringify(work), /"x":2/)
})

test('player mode keeps other decisions, and keeps the wait when the base plan has no log work', () => {
  const other = { type: 'move_to', resource: 'stone' }, wait = { type: 'wait', code: 'wood_harvest_disabled' }
  assert.equal(withPlayerWood({ mode: 'player', decision: other, planLogs: () => { throw new Error('unused') } }), other)
  assert.equal(withPlayerWood({ mode: 'player', decision: wait, planLogs: () => ({ type: 'complete' }) }), wait)
  assert.equal(withPlayerWood({ mode: 'player', decision: wait, planLogs: () => { throw new Error('no plan') } }), wait)
})

test('logs may be cut in player mode, or in quarry mode only under the unexpired long-trip allowance', () => {
  assert.equal(logsAllowed({ botMode: 'player' }), true)
  assert.equal(logsAllowed({ botMode: 'quarry' }), false)
  assert.equal(logsAllowed({}), false)
  assert.equal(logsAllowed({ botMode: 'quarry', woodHarvestAllowance: { purpose: 'long_travel_prep', expiresAt: 2000 } }, 1000), true)
  assert.equal(logsAllowed({ botMode: 'quarry', woodHarvestAllowance: { purpose: 'long_travel_prep', expiresAt: 2000 } }, 3000), false)
  assert.equal(logsAllowed({ botMode: 'quarry', woodHarvestAllowance: { purpose: 'other', expiresAt: 2000 } }, 1000), false)
})
