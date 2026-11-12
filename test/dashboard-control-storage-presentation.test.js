'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const root = path.resolve(__dirname, '..')
const script = fs.readFileSync(path.join(root, 'dashboard/control.js'), 'utf8')
const html = fs.readFileSync(path.join(root, 'dashboard/index.html'), 'utf8')
const begin = script.indexOf('  function closeStorage () {')
const end = script.indexOf("\n  request('session')", begin)
assert.ok(begin >= 0 && end > begin, 'load the production storage functions and event bindings')
const helpers = script.slice(script.indexOf('  const clean ='), script.indexOf('  async function request ('))
const source = helpers + script.slice(begin, end)
const plain = value => JSON.parse(JSON.stringify(value))

function node () {
  const events = new Map(), classes = new Set()
  let text = ''
  return {
    disabled: false, hidden: false, open: false, max: 1, value: 0, opened: 0, closed: 0,
    get textContent () { return text }, set textContent (value) { text = String(value) },
    classList: { toggle (name, force) { const add = force ?? !classes.has(name); if (add) classes.add(name); else classes.delete(name); return add }, contains: name => classes.has(name) },
    addEventListener (name, handler) { if (!events.has(name)) events.set(name, []); events.get(name).push(handler) },
    dispatch (name) { for (const handler of events.get(name) ?? []) handler({ type: name, target: this }) },
    click () { if (!this.disabled) this.dispatch('click') },
    showModal () { this.open = true; this.opened++ },
    close () { this.open = false; this.closed++; this.dispatch('close') },
    cancel () { this.dispatch('cancel'); this.close() }
  }
}
function fixture ({ storage = { available: true, busy: false, phase: 'idle', operationId: null, transferredStacks: 0, remainingStacks: 41 } } = {}) {
  let now = 1000
  const nodes = new Map([...html.matchAll(/\bid="control-(storage(?:-[a-z-]+)?)"/g)].map(match => [match[1], node()]))
  const calls = [], $ = id => { assert.ok(nodes.has(id), `storage element ${id} exists in production HTML`); return nodes.get(id) }
  const preview = { token: 'one-use-storage-token', expiresAt: 121000, operationId: 'operation-1', position: { x: -3, y: 96, z: 18 }, slotCount: 54, resume: false,
    stacks: { main: 36, armor: 4, offhand: 1, total: 41 }, target: { position: { x: -3, y: 96, z: 18 }, realm: 'Test Realm', player: 'HouchiChan', dimension: 'overworld' } }
  const current = { live: { session: 'current-session', ready: true, storage, loadout: { busy: false }, quarry: { state: 'PAUSED' } } }
  const context = vm.createContext({ $, Date: { now: () => now }, current, token: 'csrf-token', busy: 0, storagePreview: null,
    act: (kind, route, payload, success) => {
      calls.push({ kind, route, payload: plain(payload) })
      if (payload.command === 'storagePreview') success?.({ storagePreview: structuredClone(preview), state: { session: context.current.live.session } })
      else success?.({})
      context.renderStorage()
    }
  })
  vm.runInContext(source, context, { filename: 'dashboard/control.js:storage', timeout: 1000 })
  const render = () => context.renderStorage()
  render()
  return { $, calls, preview, context, render, live: () => context.current.live, advance: ms => { now += ms } }
}

test('dashboard storage UI opens only a storage preview and shows all 41 received stacks and the destination', () => {
  const f = fixture()
  assert.equal(f.$('storage').disabled, false)
  f.$('storage').click()
  assert.deepEqual(f.calls, [{ kind: 'storage', route: 'storage', payload: { command: 'storagePreview', session: 'current-session' } }])
  assert.equal(f.$('storage-dialog').open, true)
  assert.equal(f.$('storage-dialog').opened, 1)
  assert.equal(f.$('storage-world').textContent, 'Test Realm')
  assert.equal(f.$('storage-player').textContent, 'HouchiChan')
  assert.equal(f.$('storage-position').textContent, 'X -3 / Y 96 / Z 18')
  assert.deepEqual(['main', 'armor', 'offhand', 'total'].map(key => f.$('storage-' + key).textContent), ['36', '4', '1', '41'])
  assert.equal(f.$('storage-target-state').textContent, '空')
  assert.equal(f.$('storage-time').textContent, '120s')
  assert.equal(f.$('storage-confirm').disabled, false)
  assert.ok(f.calls.every(call => call.route !== 'loadout' && !call.payload.command.startsWith('reset')))
})

test('dashboard storage UI sends the preview token and exact storage confirmation once', () => {
  const f = fixture(); f.$('storage').click(); f.$('storage-confirm').click()
  assert.deepEqual(f.calls[1], { kind: 'storage', route: 'storage', payload: { command: 'storageStart', session: 'current-session', storageToken: 'one-use-storage-token', confirm: 'STORE_ALL_IN_EMPTY_CHEST' } })
  assert.equal(f.$('storage-dialog').open, false)
  assert.equal(f.context.storagePreview, null)
  assert.equal(f.$('storage-confirm').disabled, true)
  f.$('storage-confirm').dispatch('click')
  assert.equal(f.calls.length, 2, 'a stale confirm click cannot send a second transfer')
  assert.ok(!JSON.stringify(f.calls).includes('REPLACE_SURFACE_CHEST_AND_CLEAR_INVENTORY'))
  assert.ok(!JSON.stringify(f.calls).includes('resetToken'))
})

for (const changed of ['expiry', 'session']) test(`dashboard storage UI closes a ${changed}-invalidated preview and sends no transfer`, () => {
  const f = fixture(); f.$('storage').click()
  if (changed === 'expiry') f.advance(120000)
  else f.live().session = 'new-session'
  f.$('storage-confirm').dispatch('click')
  assert.equal(f.calls.length, 1, 'the handler also refuses invalid confirmation before the next render')
  f.render()
  assert.equal(f.$('storage-dialog').open, false)
  assert.equal(f.context.storagePreview, null)
  assert.equal(f.$('storage-confirm').disabled, true)
  assert.equal(f.$('storage-message').hidden, false)
  assert.equal(f.$('storage-message').classList.contains('error'), true)
  f.$('storage-confirm').click()
  assert.equal(f.calls.length, 1)
})

for (const dismissal of ['storage-back', 'storage-close', 'cancel', 'close']) test(`dashboard storage UI ${dismissal} discards confirmation without a transfer or reset`, () => {
  const f = fixture(); f.$('storage').click()
  if (dismissal === 'cancel') f.$('storage-dialog').cancel()
  else if (dismissal === 'close') f.$('storage-dialog').close()
  else f.$(dismissal).click()
  assert.equal(f.$('storage-dialog').open, false)
  assert.equal(f.context.storagePreview, null)
  f.$('storage-confirm').dispatch('click')
  assert.deepEqual(f.calls.map(call => call.payload.command), ['storagePreview'])
})

test('dashboard storage UI displays server progress and cancels the current busy operation through the storage route', () => {
  const f = fixture({ storage: { available: true, busy: true, phase: 'running', operationId: 'operation-old', transferredStacks: 12, remainingStacks: 29 } })
  assert.equal(f.$('storage').disabled, true)
  assert.equal(f.$('storage-progress').hidden, false)
  assert.equal(f.$('storage-state').textContent, '収納中')
  assert.equal(f.$('storage-meter').max, 41); assert.equal(f.$('storage-meter').value, 12)
  assert.equal(f.$('storage-count').textContent, '12 / 41')
  assert.equal(f.$('storage-cancel').hidden, false)
  f.live().storage.operationId = 'operation-current'
  f.$('storage-cancel').click()
  assert.deepEqual(f.calls, [{ kind: 'storage', route: 'storage', payload: { command: 'storageCancel', session: 'current-session', operationId: 'operation-current' } }])
  f.context.busy = 1; f.render(); f.$('storage-cancel').click()
  assert.equal(f.calls.length, 1, 'an outstanding request disables another cancellation')
})

test('dashboard storage UI resume previews the saved operation and displays the currently remaining stacks', () => {
  const f = fixture({ storage: { available: true, busy: false, phase: 'paused', operationId: 'saved-operation', transferredStacks: 39, remainingStacks: 2 } })
  f.preview.resume = true; f.preview.stacks = { main: 2, armor: 0, offhand: 0, total: 2 }
  assert.equal(f.$('storage-resume').hidden, false); assert.equal(f.$('storage-resume').disabled, false)
  f.$('storage-resume').click()
  assert.deepEqual(f.calls, [{ kind: 'storage', route: 'storage', payload: { command: 'storagePreview', session: 'current-session', operationId: 'saved-operation' } }])
  assert.equal(f.$('storage-total').textContent, '2')
  assert.equal(f.$('storage-target-state').textContent, '再開')
  assert.equal(f.$('storage-dialog').open, true)
})

test('dashboard storage UI stays disabled on old backends and never falls back to the debug operation', () => {
  for (const storage of [undefined, null, { available: false, busy: false, phase: 'unavailable' }]) {
    const f = fixture(); f.live().storage = storage; f.render()
    assert.equal(f.$('storage').disabled, true)
    assert.equal(f.$('storage-confirm').disabled, true)
    f.$('storage').click(); f.$('storage-confirm').click()
    assert.deepEqual(f.calls, [])
    assert.equal(f.$('storage-dialog').open, false)
  }
})

test('dashboard storage UI disables a new preview while another operation, reset or active quarry owns work', () => {
  for (const change of [f => { f.context.busy = 1 }, f => { f.context.token = null }, f => { f.live().ready = false },
    f => { f.live().loadout.busy = true }, f => { f.live().quarry.state = 'MINE' }, f => { f.live().storage.busy = true }]) {
    const f = fixture(); change(f); f.render()
    assert.equal(f.$('storage').disabled, true)
    f.$('storage').click()
    assert.deepEqual(f.calls, [])
  }
})

for (const action of ['preview', 'resume']) test(`dashboard storage UI permits read-only ${action} with unknown main inventory but keeps transfers disabled`, () => {
  const f = fixture({ storage: { available: true, ready: true, busy: false, phase: action === 'resume' ? 'paused' : 'idle', operationId: action === 'resume' ? 'saved-operation' : null } })
  f.live().ready = false; f.live().inventory = { known: false, uncertain: true }; f.render()
  const button = action === 'resume' ? 'storage-resume' : 'storage'
  assert.equal(f.$(button).disabled, false)
  f.$(button).click()
  assert.deepEqual(f.calls, [{ kind: 'storage', route: 'storage', payload: { command: 'storagePreview', session: 'current-session', ...(action === 'resume' ? { operationId: 'saved-operation' } : {}) } }])
  assert.equal(f.$('storage-dialog').open, true)
  assert.equal(f.$('storage-confirm').disabled, true)
  f.$('storage-confirm').click()
  f.$('storage-confirm').dispatch('click')
  assert.equal(f.calls.length, 1, 'a programmatic click also cannot transfer while inventory is unknown')
  f.live().ready = true; f.live().inventory = { known: true }; f.render()
  assert.equal(f.$('storage-confirm').disabled, false)
  f.$('storage-confirm').click()
  assert.equal(f.calls[1].payload.command, 'storageStart')
})

test('dashboard storage UI honors an explicit false preparation gate even when ordinary work is ready', () => {
  const f = fixture({ storage: { available: true, ready: false, busy: false, phase: 'paused', operationId: 'saved-operation' } })
  assert.equal(f.live().ready, true)
  assert.equal(f.$('storage').disabled, true); assert.equal(f.$('storage-resume').disabled, true)
  f.$('storage').click(); f.$('storage-resume').click()
  assert.deepEqual(f.calls, [])
})
