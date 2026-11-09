'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const root = path.resolve(__dirname, '..')
const script = fs.readFileSync(path.join(root, 'dashboard/control.js'), 'utf8')
const html = fs.readFileSync(path.join(root, 'dashboard/index.html'), 'utf8')
const section = html.slice(html.indexOf('<details class="panel control-panel'), html.indexOf('<div class="inventory-layout'))

// Evaluate the production coordinate helper, with native input validity supplied
// by this bounded fixture. Browser interaction is separately tested offline.
function selection (values = {}) {
  const inputs = Object.fromEntries(['x1', 'z1', 'x2', 'z2'].map(id => {
    const value = String(values[id] ?? '')
    return [id, { value, validity: { valid: !value || /^-?\d+$/.test(value) } }]
  }))
  const source = script.slice(script.indexOf('  function area () {'), script.indexOf('  function renderArea () {'))
  return vm.runInNewContext(source + '\narea()', { $: id => inputs[id], MIN: -1875000, MAX: 1874999 })
}

test('dashboard-control-ui: negative and reverse rectangle coordinates use inclusive chunk counts', () => {
  const single = selection({ x1: -4, z1: 2 })
  assert.equal(single.count, 1); assert.equal(single.valid, true)
  const square = selection({ x1: -3, z1: 3, x2: -4, z2: 2 })
  assert.equal(square.count, 4); assert.equal(square.width, 2); assert.equal(square.depth, 2); assert.equal(square.valid, true)
  const strip = selection({ x1: -4, z1: -1, x2: -1 })
  assert.equal(strip.count, 4); assert.equal(strip.valid, true)
})
test('dashboard-control-ui: incomplete, fractional, out-of-world and oversized ranges cannot enable planning', () => {
  for (const input of [{}, { x1: 0 }, { x1: 0.5, z1: 0 }, { x1: -1875001, z1: 0 }, { x1: 1875000, z1: 0 }, { x1: 0, z1: 0, x2: 4 }]) {
    assert.equal(selection(input).valid, false, JSON.stringify(input))
  }
  assert.match(script, /\$\('plan'\)\.disabled = !idle \|\| !ready \|\| !a\.valid/)
})
test('dashboard-control-ui: presets cannot overflow either edge of the world', () => {
  const source = script.slice(script.indexOf('  function selectArea ('), script.indexOf("  $('grid').addEventListener('click'"))
  for (const origin of [-1875000, 1874999]) {
    const inputs = Object.fromEntries(['x1', 'z1', 'x2', 'z2'].map(id => [id, { value: '' }]))
    let edits = 0
    const ctx = { $: id => inputs[id], MIN: -1875000, MAX: 1874999, gridOrigin: null, current: null, area: () => ({}), invalidate: () => { edits++ } }
    vm.runInNewContext(source + `\nselectArea(${origin}, ${origin}, 2)`, ctx)
    assert.equal(edits, 1)
    for (const input of Object.values(inputs)) assert.ok(input.value >= ctx.MIN && input.value <= ctx.MAX)
    assert.equal(inputs.x2.value - inputs.x1.value, 1)
    assert.equal(inputs.z2.value - inputs.z1.value, 1)
  }
})
test('dashboard-control-ui: presentation keeps explicit actions, field labels and visible safety result regions', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1])
  assert.equal(new Set(ids).size, ids.length, 'duplicate HTML IDs')
  for (const name of ['profile', 'world', 'realms', 'connect', 'disconnect', 'plan', 'start', 'pause', 'resume', 'emergency', 'cancel', 'plan-summary', 'job-reason', 'auth-code']) assert.ok(ids.includes('control-' + name), name)
  assert.match(section, /aria-label="チャンク座標の選択"/)
  assert.match(section, /aria-label="開始チャンク X"/)
  assert.match(section, /aria-label="開始チャンク Z"/)
  assert.match(section, /id="control-job-reason"[^>]*role="status"/)
  assert.doesNotMatch(section, /control-hint|既存の認証を使う場合|入力はブロック座標ではなく|安全確認はBot本体/)
  assert.match(script, /p\.issues\.map\(/)
  assert.match(script, /NO_CARGO_SHULKER.*clean\(x\)/)
  assert.match(script, /p\.warnings\.map\(clean\)/)
  assert.match(script, /ArrowLeft: -1, ArrowRight: 1, ArrowUp: -5, ArrowDown: 5/)
})
test('dashboard-control-ui: plan expiry and changing the live session keep the start gate closed', () => {
  assert.match(script, /plan\.expiresAt <= Date\.now\(\)/)
  assert.match(script, /plan\.state\.session !== live\?\.session/)
  assert.match(script, /plan\.plan\.jobId !== q\?\.jobId/)
  assert.match(script, /if \(!confirm\(`/)
  assert.match(script, /plan = null; \$\('plan-results'\)\.hidden = true/)
  assert.doesNotMatch(script, /innerHTML|insertAdjacentHTML|\/api\/action|\/agent\/start/)
  new vm.Script(script)
})
