'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const script = fs.readFileSync(path.resolve(__dirname, '../dashboard/control.js'), 'utf8')
const html = fs.readFileSync(path.resolve(__dirname, '../dashboard/index.html'), 'utf8')
function excerpt (start, end) {
  const first = script.indexOf(start), last = script.indexOf(end, first)
  assert.ok(first >= 0 && last > first, 'load the actual UI block: ' + start)
  return script.slice(first, last)
}
const source = excerpt('  const clean =', '  async function request (') +
  excerpt('  const element =', '  const diagnosticLabels =') +
  excerpt('  const fields =', "  $('world').addEventListener") +
  script.split('\n').find(line => line.includes("$('here').addEventListener")) + '\n' +
  excerpt('  function selectedArea () {', '  function closeStorage () {')
const plain = value => JSON.parse(JSON.stringify(value))

function fixture ({ values = {}, inside = true, capability = true } = {}) {
  let now = 10000, deferredPreview = null, delayPreview = false, document
  function node (tag = 'div') {
    const listeners = new Map(), attributes = {}, classes = new Set()
    let value = '', text = ''
    const flatten = nodes => nodes.flatMap(child => child.tag === 'fragment' ? child.children : [child])
    return { tag, children: [], dataset: {}, hidden: false, disabled: false, open: false, closed: 0,
      get value () { return value }, set value (next) { value = String(next) },
      get validity () { return { valid: value === '' || /^-?\d+$/.test(value) } }, checkValidity () { return this.validity.valid },
      get textContent () { return text + this.children.map(child => child.textContent).join('') }, set textContent (next) { text = String(next); this.children = [] },
      get firstElementChild () { return this.children[0] },
      append (...children) { this.children.push(...flatten(children)) }, replaceChildren (...children) { this.children = flatten(children) },
      setAttribute (name, next) { attributes[name] = String(next) }, getAttribute: name => attributes[name], removeAttribute: name => { delete attributes[name] },
      contains (target) { return this === target || this.children.some(child => child.contains(target)) },
      querySelector (selector) { return this.children.find(child => selector === '[tabindex="0"]' ? child.tabIndex === 0 : child.className?.split(' ').includes(selector.slice(1))) ?? null },
      closest () { return this.tag === 'button' && this.dataset.x != null ? this : null }, focus () { document.activeElement = this },
      classList: { toggle (name, force) { const add = force ?? !classes.has(name); if (add) classes.add(name); else classes.delete(name); return add }, contains: name => classes.has(name) },
      addEventListener (name, listener) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(listener) },
      dispatch (name, extra = {}) { for (const listener of listeners.get(name) ?? []) listener({ type: name, target: this, preventDefault () {}, ...extra }) },
      click () { if (!this.disabled) this.dispatch('click') }, showModal () { this.open = true }, close () { this.open = false; this.closed++; this.dispatch('close') }
    }
  }
  document = { activeElement: null, createElement: node, createDocumentFragment: () => node('fragment') }
  const nodes = new Map([...html.matchAll(/\bid="control-([^"]+)"/g)].map(match => [match[1], node()]))
  const $ = id => { assert.ok(nodes.has(id), 'production element exists: ' + id); return nodes.get(id) }
  for (const [id, value] of Object.entries({ x1: '0', z1: '0', x2: '', z2: '', top: '', bottom: '', ...values })) $(id).value = value
  const live = { session: 'live-session', ready: true, phase: 'spawned', chunk: { x: 0, z: 0 }, position: { x: 8, y: 63, z: 8 },
    loadout: { busy: false, phase: 'idle' }, storage: { busy: false }, quarry: null,
    chunkMove: capability ? { available: true, busy: false, phase: 'idle', operationId: null, serverConfirmed: false } : undefined,
    positionProof: { confirmed: inside, feet: { x: inside ? 8 : 40, y: 63, z: 8 }, radius: 0.12, session: 'live-session', generation: 7, source: 'server_position_verifier', observedAt: 1000 } }
  const calls = [], context = vm.createContext({ $, document, current: { live }, token: 'csrf-token', busy: 0, version: 0, gridOrigin: null, preset: 1, plan: null, resetPreview: null,
    Date: { now: () => now, parse: Date.parse }, MIN: -1875000, MAX: 1874999, itemNames: {}, enchantNames: {}, showLoadoutKit () {},
    render: () => { context.renderArea(); context.renderReset(); context.renderChunkMove() },
    act: (kind, route, payload, success) => {
      calls.push({ kind, route, payload: plain(payload) })
      if (payload.command === 'resetPreview') {
        const result = { state: structuredClone(context.current.live), resetPreview: { token: 'reset-token', expiresAt: now + 120000,
          target: { realm: 'Test Realm', player: 'Bot' }, stage: { x: 7, y: 63, z: 8 }, manifest: { armor: [], tools: [] } } }
        const complete = () => { success(result); context.render() }
        if (delayPreview) deferredPreview = complete
        else complete()
      } else { success?.({}); context.render() }
    }
  })
  vm.runInContext(source, context, { filename: 'dashboard/control.js:chunk-move', timeout: 1000 })
  context.render()
  return { $, calls, context, live: () => context.current.live, render: context.render,
    edit: (id, value) => { $(id).value = value; $(id).dispatch('input') },
    advance: ms => { now += ms }, delayPreview: () => { delayPreview = true }, finishPreview: () => deferredPreview() }
}

test('selection and page rendering never move or reset; one explicit click sends only the fixed move command', () => {
  const f = fixture({ inside: false })
  assert.equal(f.$('move').textContent, 'Botを移動させる')
  assert.equal(f.$('move').disabled, false); assert.equal(f.$('reset').disabled, true)
  f.edit('x1', '1'); f.edit('x1', '0')
  assert.deepEqual(f.calls, [])
  f.$('move').click()
  assert.deepEqual(f.calls, [{ kind: 'move', route: 'quarry', payload: { command: 'moveToChunk', session: 'live-session', area: { x1: 0, z1: 0, x2: 0, z2: 0 } } }])
  assert.ok(!JSON.stringify(f.calls).match(/group|options|resetStart|"start"|"top"|"bottom"/))
})

test('acceptance and predicted arrival do not enable reset; actual scoped arrival does without starting it', () => {
  const f = fixture({ inside: false }); f.$('move').click()
  Object.assign(f.live().chunkMove, { busy: true, phase: 'moving', operationId: 'move-1' }); f.live().position = { x: 8, y: 63, z: 8 }; f.live().chunk = { x: 0, z: 0 }
  f.live().positionSource = 'client_prediction'; f.render()
  assert.equal(f.$('move').textContent, '移動中'); assert.equal(f.$('reset').disabled, true)
  Object.assign(f.live().chunkMove, { busy: false, phase: 'completed', serverConfirmed: true }); f.render()
  assert.equal(f.$('reset').disabled, true)
  f.live().positionProof.confirmed = true; f.live().positionProof.feet.x = 8; f.render()
  assert.equal(f.$('reset').disabled, false)
  assert.equal(f.$('move-message').textContent, '到着確認済み')
  assert.equal(f.calls.length, 1, 'arrival cannot automatically request a reset or start mining')
})

test('movement locks the selected area and cancellation targets the currently observed operation', () => {
  const f = fixture(), before = plain(f.context.selectedArea())
  Object.assign(f.live().chunkMove, { busy: true, phase: 'moving', operationId: 'old-operation' }); f.render()
  for (const id of ['x1', 'z1', 'x2', 'z2', 'size-one', 'size-four', 'here']) assert.equal(f.$(id).disabled, true, id)
  assert.ok(f.$('grid').children.every(cell => cell.disabled))
  f.$('size-four').dispatch('click'); f.$('grid').dispatch('click', { target: f.$('grid').children[0] })
  assert.deepEqual(plain(f.context.selectedArea()), before)
  assert.equal(f.$('move-cancel').hidden, false)
  f.live().chunkMove.operationId = 'current-operation'; f.$('move-cancel').click()
  assert.deepEqual(f.calls, [{ kind: 'move', route: 'quarry', payload: { command: 'cancelChunkMove', session: 'live-session', operationId: 'current-operation' } }])
  Object.assign(f.live().chunkMove, { busy: false, phase: 'cancelled' }); f.live().positionProof.confirmed = false; f.render()
  assert.equal(f.$('move-cancel').hidden, true); assert.equal(f.$('reset').disabled, true)
})

test('reset preview and confirmation use the same canonical multi-chunk area and token', () => {
  const f = fixture({ values: { x1: '-1', z1: '0', x2: '-2', z2: '-1' } })
  f.live().positionProof.feet = { x: -8, y: 63, z: 8 }; f.render()
  assert.equal(f.$('reset').disabled, false)
  f.$('reset').click()
  assert.equal(f.$('reset-dialog').open, true)
  const area = { x1: -2, z1: -1, x2: -1, z2: 0 }
  assert.deepEqual(f.calls[0].payload, { command: 'resetPreview', session: 'live-session', area })
  f.$('reset-confirm').click()
  assert.deepEqual(f.calls[1].payload, { command: 'resetStart', session: 'live-session', resetToken: 'reset-token', area, confirm: 'REPLACE_SURFACE_CHEST_AND_CLEAR_INVENTORY' })
  assert.equal(f.$('reset-dialog').open, false)
})

test('field, preset and grid changes discard old reset confirmation even on a programmatic confirm click', () => {
  for (const change of [f => f.edit('x1', '1'), f => f.$('size-four').click(), f => f.$('grid').dispatch('click', { target: f.$('grid').children[0] })]) {
    const f = fixture(); f.$('reset').click(); assert.equal(f.$('reset-dialog').open, true)
    change(f)
    assert.equal(f.$('reset-dialog').open, false); assert.equal(f.context.resetPreview, null)
    f.$('reset-confirm').dispatch('click')
    assert.equal(f.calls.length, 1)
  }
})

test('an edited and restored area cannot revive an in-flight preview response', () => {
  const f = fixture(); f.delayPreview(); f.$('reset').click()
  f.edit('x1', '1'); f.edit('x1', '0'); f.finishPreview()
  assert.equal(f.$('reset-dialog').open, false); assert.equal(f.context.resetPreview, null)
  f.$('reset-confirm').dispatch('click'); assert.equal(f.calls.length, 1)
})

test('missing old-server capability and unknown, predicted or malformed proof never fall back to displayed coordinates', () => {
  const changes = [f => { f.live().chunkMove = undefined }, f => { f.live().chunkMove.available = false }, f => { f.live().positionProof = null },
    f => { f.live().positionProof.confirmed = false }, f => { f.live().positionProof.session = 'old-session' }, f => { f.live().positionProof.source = 'client_prediction' },
    f => { f.live().positionProof.feet.x = NaN }, f => { f.live().positionProof.radius = 2 }, f => { f.live().positionProof.generation = undefined }, f => { f.live().positionProof.observedAt = 'unknown' }]
  for (const change of changes) {
    const f = fixture(); change(f); f.render()
    assert.equal(f.$('reset').disabled, true)
    f.$('reset').dispatch('click'); assert.deepEqual(f.calls, [])
  }
})

test('proof circles respect negative coordinates, exclusive chunk edges and their complete radius', () => {
  for (const [chunk, x, radius, inside] of [[0, 15.8, .12, true], [0, 15.9, .12, false], [0, 16, 0, false], [0, 0, 0, true], [0, .01, .12, false], [-1, -.01, 0, true], [-1, -16, 0, true], [-2, -16.01, 0, true], [-1, -16.01, 0, false]]) {
    const f = fixture({ values: { x1: String(chunk) } }); Object.assign(f.live().positionProof, { feet: { x, y: 63, z: 8 }, radius }); f.render()
    assert.equal(f.$('reset').disabled, !inside, JSON.stringify({ chunk, x, radius }))
  }
})

test('invalid selections and existing busy work block movement without changing quarry or storage actions', () => {
  for (const values of [{ x1: '' }, { x1: '.5' }, { x1: '0', x2: '4' }, { x1: '1875000' }]) {
    const f = fixture({ values }); assert.equal(f.$('move').disabled, true); assert.equal(f.$('reset').disabled, true)
    f.$('move').dispatch('click'); f.$('reset').dispatch('click'); assert.deepEqual(f.calls, [])
  }
  for (const change of [f => { f.context.busy = 1 }, f => { f.live().storage.busy = true }, f => { f.live().loadout.busy = true }, f => { f.live().quarry = { state: 'MINE' } }]) {
    const f = fixture(); change(f); f.render(); assert.equal(f.$('move').disabled, true)
    f.$('move').dispatch('click'); assert.deepEqual(f.calls, [])
  }
})

test('session, code generation, position, busy state and expiry changes reject a cached reset token', () => {
  for (const change of [f => { f.live().session = 'new-session' }, f => { f.live().positionProof.generation++ }, f => { f.live().positionProof.feet.x = 40 },
    f => { f.live().chunkMove.busy = true }, f => { f.live().storage.busy = true }, f => { f.live().loadout.busy = true }, f => f.advance(120001)]) {
    const f = fixture(); f.$('reset').click(); change(f)
    f.$('reset-confirm').dispatch('click'); assert.equal(f.calls.length, 1)
    f.render(); assert.equal(f.$('reset-confirm').disabled, true)
  }
})

test('a movement failure stays visible without granting arrival or automatically starting another operation', () => {
  const f = fixture({ inside: false })
  Object.assign(f.live().chunkMove, { phase: 'failed', error: { code: 'MOVE_BLOCKED', message: '安全な移動先を確認できません。' } }); f.render()
  assert.equal(f.$('move-message').textContent, '安全な移動先を確認できません。')
  assert.equal(f.$('move-message').classList.contains('error'), true)
  assert.equal(f.$('reset').disabled, true); assert.deepEqual(f.calls, [])
})

test('a cancelled movement reports interruption even when its cancellation reason is an error', () => {
  for (const phase of ['cancelled', 'canceled']) {
    const f = fixture({ inside: false })
    Object.assign(f.live().chunkMove, { phase, error: { code: 'COMBAT_PRIORITY', message: '移動を完了できませんでした。現在位置と経路を確認してください。' } }); f.render()
    assert.equal(f.$('move-message').textContent, '中断しました')
    assert.equal(f.$('move-message').classList.contains('error'), false)
    assert.equal(f.$('move-cancel').hidden, true)
    assert.equal(f.$('reset').disabled, true); assert.deepEqual(f.calls, [])
  }
})

test('the current-location selection and grid marker use actual proof instead of stale raw or predicted display coordinates', () => {
  const f = fixture()
  f.live().chunk = { x: 7, z: 7 }; f.live().position = { x: 120, y: 63, z: 120 }; f.render()
  const marker = f.$('grid').children.find(cell => cell.className.includes(' bot'))
  assert.deepEqual([marker.dataset.x, marker.dataset.z], [0, 0])
  f.$('here').click()
  assert.deepEqual(plain(f.context.selectedArea()), { x1: 0, z1: 0, x2: 0, z2: 0 })
  f.live().positionProof = null; f.render()
  assert.equal(f.$('here').disabled, true)
  assert.equal(f.$('grid').children.some(cell => cell.className.includes(' bot')), false)
  assert.deepEqual(f.calls, [])
})
