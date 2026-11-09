'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { fixture } = require('./helpers/loadout-sim')
const { knownInventory, matches } = require('../src/loadout-reset')
const { manifest } = require('../src/loadout-manifest')
const unknownSlot = slot => ({ slot, known: false, empty: false, name: null, count: null })
const confirm = (f, p) => f.reset.start({ token: p.token, confirm: 'REPLACE_INITIAL_INVENTORY' })
function unknown (view, part) {
  const window = part === 'main' ? view : view[part]
  window.known = false
  window.slots = window.slots.map((_, slot) => unknownSlot(slot))
}

for (const part of ['main', 'armor', 'offhand', 'all']) {
  test(`loadout-receipt: missing initial ${part} can be confirmed and replaced using received updates`, async () => {
    const f = fixture()
    for (const target of part === 'all' ? ['main', 'armor', 'offhand'] : [part]) unknown(f.view, target)
    const p = await f.reset.prepare()
    assert.equal(f.commandsSent.length, 0, 'preview is always read-only')
    assert.equal(knownInventory(f.view), false, 'preview never fabricates an empty old inventory')
    if (part === 'main' || part === 'all') assert.equal(p.replaces.main, null)
    if (part === 'armor' || part === 'all') assert.equal(p.replaces.armor, null)
    confirm(f, p); await f.reset.drain()
    const status = f.reset.status(), m = manifest()
    assert.equal(status.phase, 'completed', JSON.stringify(status))
    assert.equal(status.serverConfirmed, true)
    assert.equal(knownInventory(f.view), true)
    assert.ok(m.armor.every((piece, i) => matches(f.view.armor.slots[i], piece)))
    assert.ok(m.supplies.every(box => matches(f.view.slots[box.slot], box)))
    assert.equal(f.view.offhand.slots[0].empty, true)
    assert.equal(f.commandsSent[0], '/testfor @s')
    const clear = f.commandsSent.indexOf('/clear @s')
    assert.ok(clear > 0)
    const seed = f.commandsSent.slice(1, clear)
    assert.equal(seed.filter(x => /slot\.armor\./.test(x)).length, part === 'armor' || part === 'all' ? 4 : 0)
    assert.equal(seed.filter(x => /slot\.weapon\.offhand/.test(x)).length, part === 'offhand' || part === 'all' ? 1 : 0)
    assert.equal(seed.filter(x => /slot\.(hotbar|inventory) /.test(x)).length, part === 'main' || part === 'all' ? 36 : 0)
    assert.equal(f.saves.at(-1).phase, 'completed')
    assert.equal(f.lease(), null)
  })
}

for (const [part, label] of [['main', '所持品'], ['armor', '防具'], ['offhand', 'オフハンド']]) {
  test(`loadout-receipt: command acknowledgments without ${part} observations time out, never complete`, async () => {
    const f = fixture()
    unknown(f.view, part)
    // Keep command acknowledgments but discard the corresponding received slots.
    f.hooks.afterSend = command => { if (command.startsWith('/replaceitem entity')) unknown(f.view, part) }
    const p = await f.reset.prepare()
    confirm(f, p); await f.reset.drain()
    const status = f.reset.status()
    assert.equal(status.phase, 'failed')
    assert.equal(status.error.code, 'RESET_OBSERVATION_UNCONFIRMED')
    assert.ok(status.error.message.includes(label), status.error.message)
    assert.equal(status.serverConfirmed, false)
    assert.equal(status.busy, false)
    assert.equal(knownInventory(f.view), false)
    assert.ok(!f.commandsSent.some(c => c === '/clear @s' || c.startsWith('/setblock')))
    assert.equal(f.commandsSent.length, 1 + (part === 'main' ? 36 : part === 'armor' ? 4 : 1))
    assert.equal(f.lease(), null)
  })
}

test('loadout-receipt: cancelled preview does not seed or clear missing equipment', async () => {
  const f = fixture(); unknown(f.view, 'armor'); unknown(f.view, 'offhand')
  const p = await f.reset.prepare(); f.reset.cancel()
  assert.throws(() => confirm(f, p), { code: 'RESET_CONFIRMATION_REQUIRED' })
  assert.equal(f.commandsSent.length, 0)
  assert.equal(f.view.armor.known, false)
})

test('loadout-receipt: operator denial with missing equipment never reaches bootstrap mutation', async () => {
  const f = fixture({ hooks: { beforeSend: () => { throw Object.assign(Error('denied'), { code: 'RESET_COMMAND_REJECTED' }) } } })
  unknown(f.view, 'armor'); unknown(f.view, 'offhand')
  await f.start(); await f.reset.drain()
  assert.deepEqual(f.commandsSent, ['/testfor @s'])
  assert.equal(f.reset.status().error.code, 'RESET_COMMAND_REJECTED')
  assert.equal(f.view.armor.known, false)
})

test('loadout-receipt: cancellation while seeding leaves partial evidence and never continues automatically', async () => {
  const f = fixture()
  unknown(f.view, 'armor'); unknown(f.view, 'offhand')
  f.hooks.afterSend = text => { if (text.includes('slot.armor.head')) f.reset.cancel() }
  await f.start(); await f.reset.drain()
  assert.equal(f.reset.status().serverConfirmed, false)
  assert.equal(f.reset.status().error.code, 'RESET_CANCELLED')
  assert.equal(f.commandsSent.length, 2)
  assert.equal(f.commandsSent.at(-1), '/replaceitem entity @s slot.armor.head 0 minecraft:diamond_helmet 1')
  assert.equal(f.lease(), null)
  assert.equal(f.saves.at(-1).phase, 'failed')
})

test('loadout-receipt: receiving equipment after preview invalidates that preview before mutation', async () => {
  const f = fixture(), old = structuredClone(f.view.armor)
  unknown(f.view, 'armor')
  const p = await f.reset.prepare()
  f.view.armor = old
  assert.throws(() => confirm(f, p), { code: 'RESET_PREVIEW_STALE' })
  assert.equal(f.commandsSent.length, 0)
})

test('loadout-receipt: unresolved transfers are not the same as a missing initial window', async () => {
  for (const target of ['state', 'view']) {
    const f = fixture(); unknown(f.view, 'offhand')
    if (target === 'state') f.state.inventory.uncertain = true
    else f.view.uncertain = true
    await assert.rejects(f.reset.prepare(), { code: 'RESET_INVENTORY_UNCERTAIN' })
    assert.equal(f.commandsSent.length, 0)
  }
})
