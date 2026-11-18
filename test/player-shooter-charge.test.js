'use strict'
// Live 2026-11-19 06:00:47-06:01:09 JST: a skeleton at 13.5 m put five arrows into the Bot in 22 s (health 18 to
// 0). Combat never selected it: the approach beyond four blocks was admitted only for zombies and spiders.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { shooterCharge, SHOOTERS } = require('../src/combat/shooter-charge')
const { createCombatCoordinator } = require('../src/combat/combat-coordinator')

const base = { playing: true, sword: true, bow: false, entityType: 'minecraft:skeleton', range: 13.5, health: 14, hurtAt: 99000, now: 100000 }

test('a shooter that just hit the playing Bot is charged with the sword', () => {
  assert.equal(shooterCharge(base), true)
  for (const entityType of SHOOTERS) assert.equal(shooterCharge({ ...base, entityType }), true, entityType)
})

test('not without a sword, with a bow, outside play, for a walker, far away, at low health, or without a recent hit', () => {
  assert.equal(shooterCharge({ ...base, sword: false }), false)
  assert.equal(shooterCharge({ ...base, bow: true }), false)
  assert.equal(shooterCharge({ ...base, playing: false }), false)
  assert.equal(shooterCharge({ ...base, entityType: 'minecraft:zombie' }), false)
  assert.equal(shooterCharge({ ...base, entityType: 'minecraft:creeper' }), false)
  assert.equal(shooterCharge({ ...base, range: 20.5 }), false)
  assert.equal(shooterCharge({ ...base, range: NaN }), false)
  assert.equal(shooterCharge({ ...base, health: 7.9 }), false)
  assert.equal(shooterCharge({ ...base, hurtAt: 89000 }), false, 'the hit is older than ten seconds')
  assert.equal(shooterCharge({ ...base, hurtAt: undefined }), false)
  assert.equal(shooterCharge({ ...base, hurtAt: 100500 }), false, 'a time in the future is not a hit')
})

test('the combat coordinator asks the runtime for this permission', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/runtime/user-control-runtime.js'), 'utf8')
  assert.match(source, /canAcquireMeleeApproach: \(target, state\) => canAcquireStuckMeleeApproach\(target, state\) \|\| canAcquireHealthyMeleeApproach\(target, state\) \|\| canChargeShooter\(target, state\)/)
  assert.match(source, /shooter-charge'\)\.shooterCharge\(\{ playing: rt\.host\.shared\.playerWanted === true, sword: knownUserSword\(state\), bow: userHasBowAndAmmo\(state\)/)
  assert.equal(typeof createCombatCoordinator, 'function')
})
