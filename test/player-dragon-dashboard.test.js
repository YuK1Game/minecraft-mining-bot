'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const fs = require('node:fs')
const path = require('node:path')
const { createDashboardControl } = require('../src/host/dashboard-control')
const { playerStages } = require('../src/modes/player-stages')

function view () {
  function createElement () {
    const events = new Map(), attrs = new Map()
    return {
      dataset: {}, children: [], attrs,
      append (...nodes) { this.children.push(...nodes) },
      after (node) { this.following = node }, setAttribute (key, value) { attrs.set(key, value) }, removeAttribute (key) { attrs.delete(key) },
      addEventListener (name, fn) { events.set(name, fn) }, fire (name, event) { events.get(name)?.(event) },
      replaceChildren (...nodes) { this.children = nodes }, querySelector: () => createElement(),
      getBoundingClientRect: () => ({ left: 0, right: 0 }),
      showModal () { this.open = true }, close () { this.open = false; this.fire('close') }
    }
  }
  const elements = new Map()
  const document = { body: createElement(), createElement, getElementById (id) {
    if (!elements.has(id)) elements.set(id, createElement())
    return elements.get(id)
  } }
  let render
  const window = { botControl: { idle: () => true }, addEventListener: (_, fn) => { render = fn } }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../dashboard/mode.js'), 'utf8'), { document, window })
  const find = id => document.getElementById('control-' + id)
  const road = ({ current = 'player', player }) => render({ detail: { ready: true, mode: { current, player } } })
  return { find, road, detail: document.body.children[0] }
}

test('player dashboard distinguishes manual stop, active play, and a completed expedition', () => {
  const { find, road } = view()
  const show = (phase, running) => road({ player: { phase, running, stages: [], reason: '確認済みの進捗' } })
  const badge = find('live'), start = find('start')
  show('idle', false)
  assert.equal(badge.textContent, '停止中')
  assert.equal(start.disabled, false)
  show('working', true)
  assert.equal(badge.textContent, 'プレイ中')
  show('completed', false)
  assert.equal(badge.textContent, '遠征完了')
  assert.equal(badge.title, '確認済みの進捗')
  assert.equal(start.disabled, true)
})

test('the host control snapshot drives selected stage details and updates them during polling', () => {
  const { detail, road, find } = view()
  // Preserve the actual early receipts, including the reserve and the strongest tools.
  const inventory = { known: true, items: ['pickaxe', 'sword', 'helmet', 'chestplate', 'leggings', 'boots'].map(piece => ({ name: 'minecraft:diamond_' + piece, count: 1 })) }
  const house = { done: true }
  const record = { stage: 'end', early: { finished: true, spawnReady: true, reserveReady: true },
    nether: { roundTrip: true, finished: true }, stronghold: { prepared: true },
    end: { dragon: '1', spikes: { 0: { cleared: 'nearby_received_empty_cap' }, 1: { cap: { x: 1, y: 2, z: 3 } } } } }
  const control = createDashboardControl({ getState: () => ({}), getQuarry: () => null,
    getMode: () => ({ status: () => ({ mode: 'player', player: { ...playerStages(inventory, null, house, record), reason: '柱の頂上を確認中' } }) }) })
  const show = () => {
    const snapshot = control.snapshot()
    road(snapshot.mode)
    return snapshot.mode.player
  }
  const player = show()
  const end = player.stages.find(stage => stage.id === 'end')
  assert.equal(end.shortLabel, 'ドラゴン')
  assert.deepEqual(end.checks[1], { label: 'クリスタルのない柱を確認', status: 'pending', value: '1 / 10 本' })
  const stages = find('target-heading').following.children[1].children
  const trigger = stages[player.stages.indexOf(end)].children[0]
  assert.equal(trigger.attrs.get('aria-current'), 'step')
  trigger.fire('click')
  assert.equal(detail.open, true)
  assert.equal(detail.children[0].children[0].textContent, end.label)
  assert.equal(detail.children[2].children[1].children[1].textContent, '1 / 10 本')
  assert.equal(detail.children[3].textContent, '柱の頂上を確認中')
  record.end.spikes[1].cleared = 'nearby_received_empty_cap'
  show()
  assert.equal(detail.children[2].children[1].children[1].textContent, '2 / 10 本')
  assert.equal(find('target-heading').following.children[1].children[player.stages.indexOf(end)].children[0], trigger)
  road({ current: 'quarry', player })
  assert.equal(detail.open, false)
  assert.equal(find('target-heading').following.hidden, true)
})
