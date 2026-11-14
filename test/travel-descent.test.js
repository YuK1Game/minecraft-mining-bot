'use strict'
// Long travel (coordinator 2026-11-14, choice A): to get down from a canopy the
// bot may break only the leaves directly under its feet, only during long
// travel; the night pit uses the same under-the-feet mining. The quarry rules
// (no leaves) are unchanged.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { createMining } = require('../src/mining')

function fixture (t, allowed, under = 'oak_leaves') {
  const state = { phase: 'spawned', profile: 'bot', realm: { id: '42' }, connectionId: 'connection', startedAt: '2026-11-05T01:30:00.000Z', runtimeEntityId: '41', dimension: 'overworld', lifecycle: { deathId: 3 }, gameMode: 'survival', health: 20, position: { x: 0.5, y: 81.62, z: 0.5 }, inventory: { known: true, items: [] }, onGround: true }
  const blocks = new Map()
  const set = (p, name) => blocks.set(`${p.x},${p.y},${p.z}`, { position: { ...p }, known: true, name: `minecraft:${name}`, runtimeId: 5, boundingBox: 'block', properties: {}, extra: [] })
  set({ x: 0, y: 79, z: 0 }, under)
  set({ x: 1, y: 80, z: 0 }, 'oak_leaves')
  const world = { getBlock: (x, y, z) => blocks.get(`${x},${y},${z}`) ?? { known: true, position: { x, y, z }, name: 'minecraft:air', boundingBox: 'empty', runtimeId: 0, extra: [] } }
  const input = { lookAt () {}, start () {}, stop () {}, sendAction () {}, stats: () => ({ running: false }) }
  const mining = createMining({ getState: () => state, world, getInput: () => input, travelDownAllowance: () => allowed })
  t.after(() => mining.stop('cleanup'))
  return mining
}
const reasons = preview => (preview.errors ?? []).map(String).join(' | ') + ' ' + String(preview.reason ?? '')

test('the leaf under the feet passes only as travel descent during long travel', t => {
  const on = fixture(t, true)
  assert.doesNotMatch(reasons(on.preview([{ x: 0, y: 79, z: 0, accessPreparation: 'travel_down' }])), /LEAF_HARVEST_DISABLED|足元|Travel descent|対象外/)
  assert.match(reasons(on.preview([{ x: 0, y: 79, z: 0 }])), /足元|LEAF_HARVEST_DISABLED/, 'without the travel flag the feet stay protected')
  const off = fixture(t, false)
  assert.match(reasons(off.preview([{ x: 0, y: 79, z: 0, accessPreparation: 'travel_down' }])), /only during long travel/)
})

test('travel descent never reaches a leaf beside the feet', t => {
  const on = fixture(t, true)
  assert.match(reasons(on.preview([{ x: 1, y: 80, z: 0, accessPreparation: 'travel_down' }])), /directly under the feet/)
  assert.match(reasons(on.preview([{ x: 1, y: 80, z: 0 }])), /LEAF_HARVEST_DISABLED/)
})

test('the night pit mines the block under the feet as travel descent', t => {
  const on = fixture(t, true, 'dirt')
  assert.doesNotMatch(reasons(on.preview([{ x: 0, y: 79, z: 0, accessPreparation: 'travel_down' }])), /足元|Travel descent/)
})

test('the runtime grants travel descent briefly, checks the fall on received ground, and resumes a trip after a reload', () => {
  const src = fs.readFileSync(require.resolve('../src/runtime'), 'utf8')
  assert.match(src, /travelDownAllowance: \(\) => Date\.now\(\) < \(host\.shared\.travelDownUntil \?\? 0\)/)
  const esc = src.slice(src.indexOf('  async function travelLeafEscape (signal) {'), src.indexOf('  async function travelBeforeLeg (signal) {'))
  assert.match(esc, /if \(b\?\.known !== true\) return null/, 'unreceived cells below refuse the spot')
  assert.match(esc, /health - d\.damage >= 6/)
  assert.match(esc, /accessPreparation: 'travel_down'/)
  assert.doesNotMatch(esc, /pickup|command_request/)
  assert.match(src, /host\.shared\.longTravelResume = \{ destination:/)
  assert.match(src, /operations\.quarry\.travelTo\(\{ destination: r\.destination \}\)/)
  assert.match(src, /\['moving', 'cancelled'\]\.includes\(doc\?\.phase\) && doc\.realmId != null && doc\.realmId === String\(raw\(\)\.realm\?\.id \?\? ''\) && doc\.profile === \(raw\(\)\.profile \?\? null\) && doc\.destination && Date\.now\(\) - Date\.parse\(doc\.savedAt\) < 900000/, 'a reconnect resumes a recent trip that was moving or cancelled by a reload')
  assert.match(src, /doc\.phase = 'stopped'; doc\.reason = 'MANUAL_STOP'/, 'a manual stop is never resumed')
  const retreat = src.slice(src.indexOf('  async function travelShooterRetreat (signal) {'), src.indexOf('  async function travelMakeBoat (signal) {'))
  assert.match(retreat, /<= 20\)/)
  assert.match(retreat, /if \(!hurt && nearest > 16\) return false/)
  assert.match(retreat, /if \(low && !covered\(t\)/)
  assert.match(src, /const group = shooters\.filter\(o => Math\.hypot\(o\.x - q\.x, o\.z - q\.z\) <= 16\)\.length >= 3/)
  assert.match(src, /if \(!route\.ready\) \{ const stairs = await planRoute\(\{ faceStairs: true/)
  assert.match(src, /process\.env\.NODE_TEST_CONTEXT\) travelFileChecked = true/, 'a test runner never resumes the live trip')
  assert.doesNotMatch(retreat, /command_request/)
})

// Coordinator 2026-11-14: drowned are fought on land as melee enemies; water is
// avoided by the route; a kit is gathered before the trip.
test('drowned are fought on land, never from the water; the route prices water higher; the kit is made from received items', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/runtime'), 'utf8')
  assert.match(src, /function drownedOnLand \(target, state\) \{ return \/drowned\/\.test\(String\(target\?\.entityType \?\? target\?\.name \?\? ''\)\) && state\?\.isInWater !== true/)
  assert.match(src, /if \(!drownedOnLand\(target, state\) && !require\('\.\/learning-health'\)\.emptyHandedTargetAllowed\(state, target\)\)/)
  const route = require('node:fs').readFileSync(require.resolve('../src/coarse-route'), 'utf8')
  assert.match(route, /\(s\.water \? 10 : 1\)/)
  const kit = src.slice(src.indexOf('      prepKit: async (input = {}) => {'), src.indexOf('      // Read-only: why the empty-handed preparation flag is on or off.'))
  assert.match(kit, /wool: 3/)
  assert.match(kit, /wooden_sword/)
  assert.match(kit, /minecraft:bed/)
  assert.doesNotMatch(kit, /command_request|\/give/)
})

// Live 2026-11-14: long-trip walks in water had every frame rejected while any
// hostile was listed; they now use the chunk-move admission rule (attack access
// along the step), as chunk travel already does.
test('long-trip walks use the combat-aware water frame guard', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/runtime'), 'utf8')
  assert.match(src, /preparedPortableOptions = normalWaterMovementOptions\(portableMovementOptions\(target, options\), \{ combatAware: !!longTravel\?\.status\?\.\(\)\.busy \}\)/)
  const guard = src.slice(src.indexOf('  function normalWaterMovementOptions ('), src.indexOf('  function startMotion ('))
  assert.match(guard, /else if \(combatAware\) \{\s+if \(!chunkTravelThreatsClear\(/)
})

// Coordinator 2026-11-14: a few totems and a tool from a supply box before the
// trip; the box is broken only under this placement's own record, combat waits
// from the break until it is back, and it goes back into the home chest.
test('the supply-box step keeps ownership, the combat hold and the received checks', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/runtime'), 'utf8')
  const step = src.slice(src.indexOf('  async function travelSupplyBoxTake ('), src.indexOf('  async function travelMakeBoat (signal) {'))
  assert.match(step, /if \(armorThreatNear\(\)\) throw/)
  assert.match(step, /accessPreparation: 'owned_shulker', expectedName: boxName, ownershipKey: host\.shared\.travelShulker\.key/)
  assert.match(step, /host\.shared\.travelShulkerHold = \{/)
  assert.match(step, /finally \{ host\.shared\.travelShulkerHold = null \}/)
  assert.match(step, /depositItem\(\{ sourceSlot: back\.slot, count: 1, chestSlot, expectedName: boxName \}\)/)
  assert.doesNotMatch(step, /command_request|\/give|\/clear/)
  assert.match(src, /if \(!hold && host\.shared\.travelShulkerHold\) hold = host\.shared\.travelShulkerHold/)
  assert.match(src, /rec\.life !== actualLifeId\(\)/)
})
