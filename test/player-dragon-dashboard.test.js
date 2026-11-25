'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const fs = require('node:fs')
const path = require('node:path')
const { createDashboardControl } = require('../src/host/dashboard-control')
const { playerStages } = require('../src/modes/player-stages')
const { playerStageView } = require('../src/modes/player-stage-view')
const { createMineGeometry, mineSteps } = require('../src/modes/mining/mine-geometry')

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
  assert.equal(find('target-heading').following.children[0].children[0].textContent, '遠征完了')
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
  const mine = player.stages.find(stage => stage.id === 'branch_mine')
  assert.equal(mine.label, 'ブランチマイニング場の作成')
  assert.equal(mine.reached, false)
  assert.deepEqual(mine.checks.map(check => check.status), ['pending', 'pending', 'pending'])
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

test('stage details list exact transition item requirements and live received counts within view limits', () => {
  const plan = createMineGeometry({
    scope: { profile: 'test', realmId: '1', dimension: 'overworld' },
    anchor: { x: 0, z: 0 }, surfaceY: 64
  })
  const storageSteps = mineSteps(plan, { layer: 'upper' }).findIndex(step => step.kind === 'main')
  const pairs = Object.fromEntries(plan.storage.flatMap(room => room.pairs).map(pair => [pair.id, { positions: pair.positions, slots: 54 }]))
  const site = {
    plan,
    progress: { upper: { cursor: storageSteps + 3, confirmedSteps: storageSteps + 3 } },
    shaft: { landings: { upper: true } },
    storage: { pairs },
    request: { resource: 'raw_iron', targetHeld: 33, requester: 'home_reserve' }
  }
  const inventory = {
    known: true,
    items: [
      { name: 'minecraft:iron_pickaxe', count: 1 },
      { name: 'minecraft:raw_iron', count: 9 },
      { name: 'minecraft:iron_ingot', count: 4 },
      { name: 'minecraft:cooked_beef', count: 6 },
      { name: 'minecraft:diamond', count: 5 },
      { name: 'minecraft:diamond_pickaxe', count: 1 },
      { name: 'minecraft:arrow', count: 12 },
      { name: 'minecraft:cobblestone', count: 40 },
      { name: 'minecraft:obsidian', count: 3 },
      { name: 'minecraft:blaze_rod', count: 3 },
      { name: 'minecraft:ender_pearl', count: 7 }
    ]
  }
  const worn = { known: true, worn: [{ name: 'minecraft:iron_helmet' }], offhand: { name: 'minecraft:shield' } }
  const house = { origin: { x: 0, y: 64, z: 0 }, built: true }
  const record = { early: { spawnReady: true, reserveIron: { target: 42, rawTarget: 33 }, mine: { branch: site } } }
  const shared = {
    dragonReserveSeen: {
      counts: { iron_pickaxe: 1, iron_helmet: 1, shield: 1, food: 8 }
    }
  }
  const result = playerStages(inventory, worn, house, record, shared)
  const viewStages = playerStageView(result.stages)
  assert.equal(viewStages.length, result.stages.length)
  for (const stage of result.stages) {
    assert.ok(stage.checks.length <= 12, `${stage.id} exceeded 12 checks: ${stage.checks.length}`)
    for (const check of stage.checks) {
      assert.ok(check.label.length <= 100, `${stage.id} label too long: ${check.label}`)
      if (check.value != null) assert.ok(check.value.length <= 40, `${stage.id} value too long: ${check.value}`)
    }
  }

  const mine = viewStages.find(s => s.id === 'branch_mine')
  assert.equal(mine.reached, true)
  const expectedPairs = plan.storage.find(room => room.layer === 'upper').pairs.length
  assert.equal(mine.checks[1].value, `${expectedPairs} / ${expectedPairs} 組`)
  assert.equal(mine.checks[2].value, '3 / 1 区間')

  const reserve = viewStages.find(s => s.id === 'home_reserve')
  assert.equal(reserve.checks.length, 12)
  assert.equal(reserve.checks[1].value, '9 / 33 個')
  assert.equal(reserve.checks[2].value, '4 / 42 個')
  assert.deepEqual(reserve.checks.find(c => c.label.includes('鉄のツルハシ')), {
    label: '鉄のツルハシ（予備1＋携行1本）',
    status: 'done',
    value: '箱 1/1・持 2/1'
  })
  assert.deepEqual(reserve.checks.find(c => c.label.includes('盾')), {
    label: '盾（予備1＋携行1個）',
    status: 'done',
    value: '箱 1/1・持 1/1'
  })
  assert.deepEqual(reserve.checks.find(c => c.label.includes('調理済み食料')), {
    label: '調理済み食料（予備8＋携行8個）',
    status: 'pending',
    value: '箱 8/8・持 6/8'
  })

  // Without received chest contents, never claim the chest is confirmed.
  const withoutChest = playerStages(inventory, worn, house, record).stages.find(s => s.id === 'home_reserve')
  const pickWithoutChest = withoutChest.checks.find(c => c.label.includes('鉄のツルハシ'))
  assert.equal(pickWithoutChest.status, 'pending')
  assert.match(pickWithoutChest.value, /箱未確認/)

  const diamond = viewStages.find(s => s.id === 'diamond')
  assert.equal(diamond.checks[0].value, '所持 5 / 残り 26 個')

  const nether = viewStages.find(s => s.id === 'nether')
  assert.equal(nether.checks.find(c => c.label.includes('矢')).value, '12 / 32 本')
  assert.equal(nether.checks.find(c => c.label.includes('黒曜石')).value, '3 / 10 個')

  const rods = viewStages.find(s => s.id === 'rods')
  assert.equal(rods.checks.find(c => c.label.includes('アイ 20 個分')).value, '6 / 20 個分')

  const stronghold = viewStages.find(s => s.id === 'stronghold')
  assert.equal(stronghold.checks[0].value, 'アイ 0/20（玉7）')
})
