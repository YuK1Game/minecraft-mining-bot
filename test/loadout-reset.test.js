'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const { fixture, empty } = require('./helpers/loadout-sim')
const { manifest, summary } = require('../src/loadout-manifest')
const { matches, inventoryFingerprint } = require('../src/loadout-reset')
const { randomUUID } = require('node:crypto')
const confirm = (reset, p) => reset.start({ token: p.token, confirm: 'REPLACE_INITIAL_INVENTORY' })

test('loadout: standard v1 has 20 cargo + 4 full supply boxes, compatible enchants and exactly 36 slots', () => {
  const m = manifest(), used = [...Array(9).keys(), ...m.cargo.map(x => x.slot), ...m.supplies.map(x => x.slot), ...m.emptySlots]
  assert.equal(new Set(used).size, 36); assert.equal(used.length, 36)
  assert.equal(m.cargo.length, 20); assert.equal(m.supplies.length, 4)
  assert.ok(m.supplies.every(s => s.contents.length === 27))
  assert.deepEqual(m.supplies.map(s => s.contents.reduce((n, i) => n + i.count, 0)), [27, 27, 1728, 1728])
  assert.equal(m.hotbar[3].enchants.infinity, 1); assert.ok(!m.hotbar[3].enchants.mending)
  assert.ok(!(m.hotbar[1].enchants.silk_touch && m.hotbar[1].enchants.fortune))
  assert.deepEqual(summary().hand, { bread: 64, dirt: 192, arrows: 64 })
  const data = require('minecraft-data')('bedrock_1.26.60')
  for (const spec of [...m.hotbar, ...m.armor, ...m.supplies.flatMap(b => b.contents)]) {
    assert.ok(data.itemsByName[spec.name.replace('minecraft:', '')], spec.name)
    for (const [name, level] of Object.entries(spec.enchants)) {
      const def = data.enchantmentsArray.find(e => e.name === name)
      assert.ok(def, name); assert.ok(level <= def.maxLevel, name)
    }
  }
})
test('loadout: preview is read-only and unknown contents never become proof of success', async () => {
  const f = fixture(), p = await f.reset.prepare()
  assert.equal(p.manifest.cargoBoxes, 20); assert.equal(p.target.player, 'ResetBot')
  assert.equal(f.commandsSent.length, 0); assert.equal(f.saves.length, 0); assert.equal(f.calls.length, 0)
  const wanted = manifest().cargo[0]
  assert.equal(matches({ known: true, name: wanted.name, count: 1, metadata: 0, empty: false, enchantmentsKnown: true, enchantments: [], container: { known: false } }, wanted), false)
})
test('loadout: complete offline reset requires received slot contents, every enchant and normal acknowledged transfers', async () => {
  const f = fixture(); const started = await f.start()
  assert.equal(started.busy, true); assert.equal(started.serverConfirmed, false)
  await f.reset.drain(); const s = f.reset.status(), m = manifest()
  assert.equal(s.phase, 'completed', JSON.stringify(s)); assert.equal(s.serverConfirmed, true); assert.equal(s.busy, false)
  assert.equal(s.suppliesCompleted, 4); assert.equal(f.lease(), null)
  assert.equal(f.commandsSent.filter(c => c === '/clear @s').length, 1)
  assert.equal(f.calls.filter(c => c === 'deposit').length, 54)
  assert.equal(f.commandsSent.filter(c => c.startsWith('/loot ')).length, 4)
  assert.equal(f.commandsSent.filter(c => c.startsWith('/execute ')).length, 4)
  assert.ok(m.supplies.every(b => matches(f.view.slots[b.slot], b)))
  assert.ok(m.armor.every((b, i) => matches(f.view.armor.slots[i], b)))
  assert.ok(m.hotbar.every((b, i) => matches(f.view.slots[i], b)))
  assert.equal(f.saves.at(-1).phase, 'completed'); assert.equal(f.saves.at(-1).serverConfirmed, true)
  assert.equal(f.blocks.size, 0); assert.ok(!JSON.stringify(f.reset.status()).includes('inventoryBefore'))
  assert.deepEqual(f.calls.filter(x => /start|resume/i.test(x)), [])
})
for (const variant of ['confirmation', 'expiry', 'realm', 'life', 'position', 'inventory', 'generation', 'job', 'stage']) test(`loadout: ${variant} invalidates preview before destructive work`, async () => {
  const f = fixture(), p = await f.reset.prepare()
  if (variant === 'expiry') f.time(120001)
  if (variant === 'realm') f.state.realm.id = '43'
  if (variant === 'life') f.state.lifecycle.deathId++
  if (variant === 'position') f.state.position.x++
  if (variant === 'inventory') f.view.slots[0].count++
  if (variant === 'generation') f.generation()
  if (variant === 'job') f.job('other')
  if (variant === 'stage') f.blocks.set(`${p.stage.x},${p.stage.y},${p.stage.z}`, { known: true, name: 'minecraft:chest', boundingBox: 'block', extra: [] })
  assert.throws(() => f.reset.start({ token: p.token, confirm: variant === 'confirmation' ? 'yes' : 'REPLACE_INITIAL_INVENTORY' }))
  assert.equal(f.commandsSent.length, 0); assert.equal(f.calls.length, 0)
  assert.throws(() => confirm(f.reset, p), { code: 'RESET_CONFIRMATION_REQUIRED' })
})
for (const variant of ['unknownInventory', 'unknownArmor', 'unknownOffhand', 'wet', 'notIdle']) test(`loadout: unsafe ${variant} cannot prepare a reset`, async () => {
  const f = fixture({ busy: variant === 'notIdle' })
  if (variant === 'unknownInventory') f.view.known = false
  if (variant === 'unknownArmor') f.view.armor.known = false
  if (variant === 'unknownOffhand') f.view.offhand.known = false
  if (variant === 'wet') f.blocks.set('0,64,0', { known: true, name: 'minecraft:water', boundingBox: 'empty' })
  await assert.rejects(f.reset.prepare()); assert.equal(f.commandsSent.length, 0)
})
test('loadout: duplicate start, canceled preview and synchronous lease failure cannot close foreign containers', async () => {
  const failed = fixture({ acquireError: true }), p = await failed.reset.prepare()
  assert.throws(() => confirm(failed.reset, p), /acquire failed/)
  assert.deepEqual(failed.calls, []); assert.equal(failed.reset.status().busy, false)
  const f = fixture(), preview = await f.reset.prepare(); confirm(f.reset, preview)
  assert.throws(() => confirm(f.reset, preview), { code: 'RESET_BUSY' })
  f.reset.cancel(); await f.reset.drain()
  assert.equal(f.commandsSent.length, 0); assert.equal(f.reset.status().serverConfirmed, false)
  const next = await f.reset.prepare(); f.reset.cancel()
  assert.throws(() => confirm(f.reset, next), { code: 'RESET_CONFIRMATION_REQUIRED' })
})
test('loadout: lost command output is never retried, never called complete, and leaves journaled recovery coordinates', async () => {
  const f = fixture({ hooks: { afterSend: (text) => { if (text.startsWith('/setblock')) throw Object.assign(new Error('lost output'), { code: 'RESET_COMMAND_TIMEOUT' }) } } })
  await f.start(); await f.reset.drain()
  const s = f.reset.status(); assert.equal(s.phase, 'failed'); assert.equal(s.serverConfirmed, false)
  assert.equal(f.commandsSent.filter(c => c.startsWith('/setblock')).length, 1)
  assert.ok(f.saves.at(-1).pending); assert.ok(s.stage); assert.equal(f.blocks.size, 1)
  await assert.rejects(f.reset.prepare(), { code: 'RESET_STAGING_RECOVERY_REQUIRED' })
})
test('loadout: full contents are required; a successful loot response alone never allows deleting the template', async () => {
  const f = fixture({ hooks: { afterSend: text => { if (text.startsWith('/loot')) f.view.slots[29].container.known = false } } })
  await f.start(); await f.reset.drain()
  assert.equal(f.reset.status().phase, 'failed'); assert.equal(f.reset.status().error.code, 'RESET_OBSERVATION_UNCONFIRMED')
  assert.equal(f.commandsSent.filter(c => c.startsWith('/execute')).length, 0)
  assert.equal(f.commandsSent.filter(c => /slot.container \d+ minecraft:air/.test(c)).length, 0)
})
for (const variant of ['death', 'scope', 'generation']) test(`loadout: ${variant} during the reset stops further mutation`, async () => {
  const f = fixture({ hooks: { afterSend: (text, n) => { if (n === 4) {
    if (variant === 'death') { f.state.health = 0; f.state.dead = true }
    if (variant === 'scope') f.state.connectionId = 'two'
    if (variant === 'generation') f.generation()
  } } } })
  await f.start(); await f.reset.drain()
  assert.equal(f.reset.status().phase, 'failed'); assert.equal(f.commandsSent.length, 4); assert.equal(f.lease(), null)
})
test('loadout: persistence failure before dispatch does not clear anything', async () => {
  const f = fixture({ hooks: { save: () => { throw new Error('disk full') } } })
  await f.start(); await f.reset.drain()
  assert.equal(f.commandsSent.length, 0); assert.equal(f.reset.status().phase, 'failed'); assert.equal(f.view.slots[0].count, 20)
})
test('loadout: final persistence must settle before any public success', async () => {
  let resolve, entered
  const blocked = new Promise(r => { resolve = r }), ready = new Promise(r => { entered = r })
  const f = fixture({ hooks: { save: async d => { if (d.phase === 'completed') { entered(); await blocked; throw new Error('final disk full') } } } })
  await f.start(); await ready
  assert.equal(f.reset.status().serverConfirmed, false); assert.equal(f.reset.status().busy, true)
  resolve(); await f.reset.drain()
  assert.equal(f.reset.status().phase, 'failed'); assert.equal(f.reset.status().serverConfirmed, false)
})
test('loadout: observation timestamps alone do not change confirmation identity', () => {
  const f = fixture(), a = inventoryFingerprint(f.view)
  f.view.observedAt = Date.now(); f.view.armor.observedAt = Date.now()
  assert.equal(inventoryFingerprint(f.view), a)
  f.view.slots[0] = empty(0); assert.notEqual(inventoryFingerprint(f.view), a)
})

for (const variant of ['players', 'hostiles', 'unknownActors', 'fire', 'damage']) test(`loadout: debug reset completes with ${variant} before and during confirmation`, async () => {
  const f = fixture({ hooks: { afterSend: (_text, n) => { if (n === 5) { f.state.resetThreats = true; f.state.onFire = true; f.state.health = 17 } } } })
  f.state.resetThreats = variant === 'unknownActors' ? undefined : true
  f.state.onFire = variant === 'fire'
  const p = await f.reset.prepare()
  f.state.health = 19
  confirm(f.reset, p); await f.reset.drain()
  assert.equal(f.reset.status().phase, 'completed', JSON.stringify(f.reset.status()))
  assert.equal(f.reset.status().serverConfirmed, true)
  assert.equal(f.commandsSent.filter(c => c === '/clear @s').length, 1)
  assert.equal(f.lease(), null)
})
test('loadout: inventory changes while combat drains require a new confirmation before clearing', async () => {
  const f = fixture(); const p = await f.reset.prepare()
  confirm(f.reset, p); f.view.slots[0].count++
  await f.reset.drain()
  assert.equal(f.commandsSent.length, 0)
  assert.equal(f.reset.status().error.code, 'RESET_PREVIEW_STALE')
  assert.equal(f.reset.status().serverConfirmed, false)
})
