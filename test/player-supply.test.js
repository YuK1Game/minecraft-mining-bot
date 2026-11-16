'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { withPlayerSupply, woodHeld } = require('../src/modes/player-supply')

const inv = (...items) => ({ known: true, items: items.map(([name, count], slot) => ({ name: `minecraft:${name}`, count, slot })) })
const tunnel = { type: 'tunnel', stage: 'diamond', reason: 'ore', target: { x: 0, y: -16, z: 0 }, resourceTarget: { x: 0, y: -16, z: 0 } }
const cut = { type: 'gather_logs', resource: 'logs', reason: '幹と葉を確認した木から、不足する原木を集めます。', target: { x: 3, y: 70, z: 0 } }
const state = inventory => ({ position: { x: 0.5, y: 71.62, z: 0.5 }, inventory })
const run = (extra = {}) => withPlayerSupply({ mode: 'player', playing: true, state: state(inv(['birch_planks', 2], ['stick', 2], ['cobblestone', 64])), decision: tunnel, planLogs: () => cut, ...extra })

test('counts a log, four planks or a crafting table as one', () => {
  assert.equal(woodHeld(inv(['oak_log', 2], ['birch_planks', 9], ['crafting_table', 1], ['stripped_oak_log', 5], ['stick', 8])), 5)
  assert.equal(woodHeld({ known: false, items: [] }), null)
})

test('on the surface, before work far below, wood is gathered first (real Realm 2026-11-16: two planks, two sticks)', () => {
  const next = run()
  assert.equal(next.type, 'gather_logs')
  assert.match(next.reason, /地下へ下りる前に原木を集めます/)
})

test('the plan stays as it is with enough wood, underground, for near work, in quarry mode or when not playing', () => {
  assert.equal(run({ state: state(inv(['oak_log', 9], ['oak_planks', 4])) }), tunnel)
  assert.equal(run({ state: state(inv(['oak_log', 8], ['oak_planks', 4])) }).type, 'gather_logs', 'nine logs\' worth is not enough')
  assert.equal(run({ state: { ...state(inv()), position: { x: 0, y: 31.62, z: 0 } } }), tunnel)
  const near = { ...tunnel, target: { x: 0, y: 66, z: 0 }, resourceTarget: { x: 0, y: 66, z: 0 } }
  assert.equal(run({ decision: near }), near)
  assert.equal(run({ mode: 'quarry' }), tunnel)
  assert.equal(run({ playing: false }), tunnel)
  assert.equal(run({ state: state({ known: false, items: [] }) }), tunnel)
})

test('only wood work replaces the plan: no tree in sight keeps the descent', () => {
  for (const other of [{ type: 'explore', resource: 'logs' }, { type: 'wait', resource: 'logs' }, { type: 'scan_blocks', resource: 'logs' }, { type: 'mine_stone', resource: 'stone' }, null]) assert.equal(run({ planLogs: () => other }), tunnel)
  assert.equal(run({ planLogs: () => { throw new Error('x') } }), tunnel)
  assert.equal(run({ decision: cut }), cut)
})
