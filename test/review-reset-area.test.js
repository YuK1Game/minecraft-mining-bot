'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const { setImmediate: turn } = require('node:timers/promises')
const { observedScope } = require('../src/server-position-verifier')
const file = require.resolve('./quarry-v22-reset-complete.test.js'), loaded = new Module(file, module)
loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file))
loaded._compile(fs.readFileSync(file, 'utf8').split('\ntest(')[0] + '\nmodule.exports = { fixture }\n', file)
const { fixture: scene } = loaded.exports
const confirm = 'REPLACE_SURFACE_CHEST_AND_CLEAR_INVENTORY'
const selected = { x1: 0, z1: 0, x2: 0, z2: 0 }
const copy = value => structuredClone(value)
const key = p => [p.x, p.y, p.z].join(',')
function fixture () {
  const f = scene({ occupied: true }), confirmations = [], acquisitions = []
  f.adapter.acquire = id => { acquisitions.push(id) }
  f.adapter.confirmArea = async (area, options) => { confirmations.push({ area: copy(area), options }); return { serverConfirmed: true, scope: observedScope(f.state) } }
  return { ...f, confirmations, acquisitions }
}
const untouched = f => ({ bag: copy(f.bag), armor: copy(f.armor), offhand: copy(f.offhand), world: copy(f.world) })

test('selected area is canonical, bound to the receipt, and revalidated at execution before clearing', async () => {
  const f = fixture(), reversed = { x1: 1, z1: 0, x2: 0, z2: 0 }, canonical = { x1: 0, z1: 0, x2: 1, z2: 0 }
  const before = untouched(f), preview = await f.reset.prepare({ area: reversed })
  assert.deepEqual(preview.area, canonical)
  assert.deepEqual(f.confirmations.map(row => row.area), [canonical])
  assert.deepEqual(untouched(f), before); assert.deepEqual(f.steps, []); assert.deepEqual(f.acquisitions, [])
  f.reset.start({ token: preview.token, confirm, area: canonical })
  await f.reset.drain()
  assert.equal(f.reset.status().phase, 'completed', JSON.stringify(f.reset.status().error))
  assert.equal(f.reset.status().serverConfirmed, true)
  assert.deepEqual(f.confirmations.map(row => row.area), [canonical, canonical])
  assert.ok(f.confirmations[1].options.signal instanceof AbortSignal)
  assert.ok(f.journal.every(doc => JSON.stringify(doc.selectedArea) === JSON.stringify(canonical)))
})

test('feet outside the selected area are refused before any position request or reset receipt', async () => {
  const f = fixture(), before = untouched(f)
  await assert.rejects(f.reset.prepare({ area: { x1: 1, z1: 0 } }), { code: 'RESET_OUTSIDE_SELECTED_CHUNKS' })
  assert.deepEqual(f.confirmations, []); assert.deepEqual(f.steps, []); assert.deepEqual(f.journal, [])
  assert.deepEqual(untouched(f), before)
  assert.throws(() => f.reset.start({ token: 'no-receipt', confirm, area: selected }), { code: 'RESET_CONFIRMATION_REQUIRED' })
})

test('an older registered stage outside the selected chunk cannot be adopted by an area-bound reset', async () => {
  const f = fixture()
  f.state.position = { x: 15.5, y: 66.62, z: 8.5 }
  const home = { position: { x: 14, y: 65, z: 8 }, other: { x: 13, y: 65, z: 8 }, stand: { x: 15, y: 65, z: 8 }, stage: { x: 16, y: 65, z: 8 }, chunk: { x: 0, z: 0 } }
  for (const p of [home.position, home.other]) f.world.set(key(p), { known: true, name: 'minecraft:chest', boundingBox: 'block', extra: [] })
  f.adapter.load = async () => ({ phase: 'completed', world: JSON.stringify(['bot', '42', 'overworld']), home })
  const before = untouched(f)
  await assert.rejects(f.reset.prepare({ area: selected }), { code: 'RESET_SITE_OUTSIDE_SELECTED_CHUNKS' })
  assert.equal(f.confirmations.length, 1); assert.deepEqual(f.steps, []); assert.deepEqual(f.acquisitions, [])
  assert.deepEqual(untouched(f), before)
})

for (const area of [undefined, { x1: 1, z1: 0 }, { x1: 0, z1: 0, x2: 1, z2: 0 }]) test(`missing or changed start selection consumes the old receipt: ${JSON.stringify(area)}`, async () => {
  const f = fixture(), preview = await f.reset.prepare({ area: selected }), before = untouched(f)
  assert.throws(() => f.reset.start({ token: preview.token, confirm, ...(area ? { area } : {}) }), { code: 'RESET_SELECTION_CHANGED' })
  assert.throws(() => f.reset.start({ token: preview.token, confirm, area: selected }), { code: 'RESET_CONFIRMATION_REQUIRED' })
  assert.deepEqual(f.acquisitions, []); assert.deepEqual(f.steps, []); assert.deepEqual(untouched(f), before)
})

for (const receipt of [null, { serverConfirmed: false }, { serverConfirmed: true, scope: 'other-scope' }]) test(`unconfirmed prepare position cannot issue a usable receipt: ${JSON.stringify(receipt)}`, async () => {
  const f = fixture(), before = untouched(f)
  f.adapter.confirmArea = async () => receipt
  await assert.rejects(f.reset.prepare({ area: selected }), { code: 'RESET_POSITION_UNCONFIRMED' })
  assert.throws(() => f.reset.start({ token: 'no-receipt', confirm, area: selected }), { code: 'RESET_CONFIRMATION_REQUIRED' })
  assert.deepEqual(f.acquisitions, []); assert.deepEqual(f.steps, []); assert.deepEqual(f.journal, [])
  assert.deepEqual(untouched(f), before)
})

test('a failed second position confirmation preserves inventory and prevents every destructive command', async () => {
  const f = fixture(), before = untouched(f), preview = await f.reset.prepare({ area: selected })
  f.adapter.confirmArea = async () => ({ serverConfirmed: false })
  f.reset.start({ token: preview.token, confirm, area: selected })
  await f.reset.drain()
  assert.equal(f.reset.status().phase, 'failed'); assert.equal(f.reset.status().error.code, 'RESET_POSITION_UNCONFIRMED')
  assert.equal(f.reset.status().serverConfirmed, false)
  assert.deepEqual(f.steps, [], 'even the privilege probe follows the selected-area witness')
  assert.deepEqual(untouched(f), before); assert.equal(f.adapter.jobIdentity(), 'job:paused')
  assert.equal(f.acquisitions.length, 1); assert.equal(f.released(), 1)
  assert.ok(f.journal.every(doc => doc.serverConfirmed !== true))
})

for (const mode of ['generation', 'job']) test(`${mode} changing during the awaited prepare witness invalidates confirmation`, async () => {
  const f = fixture(), before = untouched(f)
  f.adapter.confirmArea = async () => {
    await turn()
    if (mode === 'generation') f.nextGeneration(); else f.setJob('other-job:paused')
    return { serverConfirmed: true, scope: observedScope(f.state) }
  }
  await assert.rejects(f.reset.prepare({ area: selected }), { code: 'RESET_PREVIEW_STALE' })
  assert.deepEqual(f.acquisitions, []); assert.deepEqual(f.steps, []); assert.deepEqual(f.journal, [])
  assert.deepEqual(untouched(f), before)
})

test('legacy core callers without area remain compatible and do not require the new confirmation port', async () => {
  const f = scene({ occupied: true })
  assert.equal(f.adapter.confirmArea, undefined)
  const preview = await f.reset.prepare()
  assert.equal(preview.area, undefined)
  f.reset.start({ token: preview.token, confirm })
  await f.reset.drain()
  assert.equal(f.reset.status().phase, 'completed', JSON.stringify(f.reset.status().error))
  assert.equal(f.reset.status().serverConfirmed, true)
})

test('an area cannot be grafted onto a legacy receipt prepared without a selection', async () => {
  const f = fixture(), preview = await f.reset.prepare()
  assert.throws(() => f.reset.start({ token: preview.token, confirm, area: selected }), { code: 'RESET_SELECTION_CHANGED' })
  assert.deepEqual(f.acquisitions, []); assert.deepEqual(f.steps, [])
})
