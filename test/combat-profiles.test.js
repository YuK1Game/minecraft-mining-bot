'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const p = require('../src/combat-profiles')

test('53 enemy profiles from the design are present with their engagement policy', () => {
  assert.ok(Object.keys(p.PROFILES).length >= 53)
  for (const name of ['zombie', 'husk', 'skeleton', 'stray', 'bogged', 'creeper', 'spider', 'witch', 'pillager', 'blaze', 'phantom', 'vindicator', 'evocation_illager', 'slime']) assert.equal(p.profileOf(`minecraft:${name}`).engagement, 'when_needed_and_safe', name)
  assert.equal(p.profileOf('minecraft:warden').engagement, 'do_not_engage')
  assert.equal(p.profileOf('minecraft:skeleton').routine, 'ranged_cover')
  assert.equal(p.profileOf('minecraft:zombie').routine, 'melee_kite')
})

test('only when_needed_and_safe engages automatically; never-types never; neutral types only when provoked nearby', () => {
  assert.equal(p.engagementAllowed('minecraft:zombie'), true)
  for (const name of ['warden', 'ender_dragon', 'wither', 'elder_guardian', 'creaking', 'sulfur_cube']) assert.equal(p.engagementAllowed(`minecraft:${name}`, { distance: 1, provoked: true }), false, name)
  for (const name of ['wolf', 'iron_golem', 'enderman', 'piglin', 'zombie_pigman']) {
    assert.equal(p.engagementAllowed(`minecraft:${name}`, { distance: 2 }), false, name)
    assert.equal(p.engagementAllowed(`minecraft:${name}`, { distance: 2, provoked: true }), true, name)
    assert.equal(p.engagementAllowed(`minecraft:${name}`, { distance: 9, provoked: true }), false, name)
  }
  assert.equal(p.engagementAllowed('minecraft:some_unknown_mob'), false, 'unknown is never treated as safe')
})

test('creeper is never chased: one in-reach hit, evade inside the shot distance, or a bow shot from beyond 8 blocks; enderman is never shot', () => {
  assert.deepEqual(p.allowedModes('minecraft:creeper', { hasBow: true, distance: 2 }), ['melee'])
  assert.deepEqual(p.allowedModes('minecraft:creeper', { hasBow: true, distance: 5 }), ['evade'])
  assert.deepEqual(p.allowedModes('minecraft:creeper', { hasBow: false, distance: 12 }), [])
  assert.deepEqual(p.allowedModes('minecraft:creeper', { hasBow: true, distance: 12 }), ['ranged'])
  assert.equal(p.meleeHitLimit('minecraft:creeper'), 1); assert.equal(p.meleeHitLimit('minecraft:zombie'), null)
  assert.deepEqual(p.allowedModes('minecraft:enderman', { hasBow: true, distance: 10 }), ['melee'])
  assert.ok(p.HP_RETREAT < p.HP_RESUME)
})
test('creeper shot band: 8m on level ground, 6.5m when it stands 1.5+ blocks above or below', () => {
  const p = require('../src/combat-profiles')
  assert.deepEqual(p.allowedModes('minecraft:creeper', { hasBow: true, distance: 7 }), ['evade'])
  assert.deepEqual(p.allowedModes('minecraft:creeper', { hasBow: true, distance: 7, elevated: true }), ['ranged'])
  assert.deepEqual(p.allowedModes('minecraft:creeper', { hasBow: true, distance: 6, elevated: true }), ['evade'])
})

test('live case 2026-11-05: a cornered creeper (no evade standpoint) is fought: knockback in reach, the bow beyond', () => {
  const profiles = require('../src/combat-profiles')
  assert.deepEqual(profiles.allowedModes('minecraft:creeper', { hasBow: true, distance: 5 }), ['evade'], 'not cornered: evade inside the shot distance')
  assert.deepEqual(profiles.allowedModes('minecraft:creeper', { hasBow: true, distance: 5, cornered: true }), ['ranged'])
  assert.deepEqual(profiles.allowedModes('minecraft:creeper', { hasBow: true, distance: 3.8, cornered: true }), ['melee', 'approach'])
  assert.deepEqual(profiles.allowedModes('minecraft:creeper', { hasBow: true, distance: 2, cornered: true }), ['melee'])
  assert.deepEqual(profiles.allowedModes('minecraft:creeper', { hasBow: false, distance: 5, cornered: true }), ['evade'])
})
