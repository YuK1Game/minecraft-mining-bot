'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { stageChecks } = require('../src/modes/player-stage-checks')

test('the iron stage shows the house batch it is waiting on: ores to mine, ingots to smelt, then the kit', () => {
  const items = [{ name: 'minecraft:raw_iron', count: 24 }, { name: 'minecraft:stick', count: 4 }]
  const rows = stageChecks({ id: 'iron', reached: false }, items, null, { early: { reserveIron: { target: 63, rawTarget: 30 } } })
  const value = label => rows.find(row => row.label.startsWith(label))?.value
  assert.equal(value('いまの作業 1'), '24 / 30 個')
  assert.equal(value('いまの作業 2'), '0 / 63 個')
  assert.ok(value('いまの作業 3'))
})

test('without a house batch the iron stage shows only the pickaxe and its parts', () => {
  const rows = stageChecks({ id: 'iron', reached: false }, [{ name: 'minecraft:raw_iron', count: 3 }], null, {})
  assert.equal(rows.length, 2)
})
