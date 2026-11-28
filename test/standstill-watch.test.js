'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createStandstillWatch, classifyStandstill } = require('../src/modes/standstill-watch')

test('standstill-watch: logs exact cause after 20s stationary, throttles follow-ups, and resets on movement', () => {
  let clock = 10000
  let feet = { x: 100.5, y: 64, z: 200.5 }
  let snap = { playerReason: '採掘場の確認を続けます（MINE_TERRAIN_REQUESTED）。' }
  const logs = []

  const watch = createStandstillWatch({
    active: () => true,
    getFeet: () => feet,
    inspect: () => snap,
    log: line => logs.push(line),
    now: () => clock
  })

  // 0s..19s: no log yet
  for (let s = 0; s < 20; s++) {
    assert.equal(watch.tick(), null)
    clock += 1000
  }
  // 20s: logs terrain wait cause
  const r20 = watch.tick()
  assert.ok(r20)
  assert.equal(r20.elapsedSec, 20)
  assert.match(logs[0], /立ち止まり検知: 20秒/)
  assert.match(logs[0], /地下チャンク受信待ち（MINE_TERRAIN_REQUESTED）/)

  // 21s..29s: throttled
  for (let s = 21; s < 30; s++) {
    clock += 1000
    assert.equal(watch.tick(), null)
  }
  // 30s: next milestone
  clock += 1000
  const r30 = watch.tick()
  assert.ok(r30)
  assert.equal(r30.elapsedSec, 30)
  assert.equal(logs.length, 2)

  // Move > 0.25m: resets counter
  feet = { x: 101.2, y: 64, z: 200.5 }
  clock += 1000
  assert.equal(watch.tick(), null)
  assert.equal(watch.state().seconds, 0)

  // Stay 20s at new spot with moving phase stuck -> reports movement stall
  snap = { motionPhase: 'moving', playerReason: '移動中' }
  clock += 20000
  const rMoved = watch.tick()
  assert.ok(rMoved)
  assert.match(logs[2], /歩行入力中だが位置が進まない/)
})

test('classifyStandstill distinguishes combat, mining, furnace, craft, chest, food, inventory sync, and idle', () => {
  assert.match(classifyStandstill({ combatActive: true }).cause, /戦闘中/)
  assert.match(classifyStandstill({ miningPhase: 'mining', miningTarget: '1,2,3' }).cause, /ブロック採掘中（1,2,3）/)
  assert.match(classifyStandstill({ furnaceActive: true }).cause, /かまど精錬中/)
  assert.match(classifyStandstill({ craftActive: true }).cause, /クラフト中/)
  assert.match(classifyStandstill({ chestActive: true }).cause, /チェスト操作中/)
  assert.match(classifyStandstill({ foodActive: true }).cause, /食事中/)
  assert.match(classifyStandstill({ inventoryUncertain: true }).cause, /持ち物同期待ち/)
  assert.match(classifyStandstill({}).cause, /アイドル待機/)
})
