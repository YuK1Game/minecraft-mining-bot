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
  return vm.runInNewContext(source + '\narea()', { $: id => inputs[id], BLOCK_MIN: -30000000, BLOCK_MAX: 29999999, chunkOf: block => Math.floor(block / 16) })
}

test('dashboard-control-ui: negative and reverse rectangle coordinates use inclusive chunk counts', () => {
  // Fields are block coordinates: any block selects the chunk that contains it.
  const single = selection({ x1: -50, z1: 47 })
  assert.equal(single.count, 1); assert.equal(single.valid, true); assert.equal(single.x1, -4); assert.equal(single.z1, 2)
  assert.equal(selection({ x1: -1, z1: 15 }).x1, -1); assert.equal(selection({ x1: 0, z1: 16 }).z1, 1)
  const square = selection({ x1: -33, z1: 63, x2: -64, z2: 32 })
  assert.equal(square.count, 4); assert.equal(square.width, 2); assert.equal(square.depth, 2); assert.equal(square.valid, true)
  const strip = selection({ x1: -64, z1: -1, x2: -1 })
  assert.equal(strip.count, 4); assert.equal(strip.valid, true)
})
test('dashboard-control-ui: incomplete, fractional, out-of-world and oversized ranges cannot enable planning', () => {
  for (const input of [{}, { x1: 0 }, { x1: 0.5, z1: 0 }, { x1: -30000001, z1: 0 }, { x1: 30000000, z1: 0 }, { x1: 0, z1: 0, x2: 64 }]) {
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
    for (const input of Object.values(inputs)) assert.ok(input.value >= ctx.MIN * 16 && input.value <= ctx.MAX * 16 + 15)
    assert.equal(inputs.x2.value - inputs.x1.value, 31)
    assert.equal(inputs.z2.value - inputs.z1.value, 31)
  }
})
test('dashboard-control-ui: presentation keeps explicit actions, field labels and visible safety result regions', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1])
  assert.equal(new Set(ids).size, ids.length, 'duplicate HTML IDs')
  for (const name of ['profile', 'world', 'realms', 'connect', 'disconnect', 'plan', 'start', 'pause', 'resume', 'cancel', 'plan-summary', 'job-reason', 'auth-code']) assert.ok(ids.includes('control-' + name), name)
  assert.match(section, /aria-label="採掘範囲の選択"/)
  assert.match(section, /aria-label="開始 X（ブロック座標）"/)
  assert.match(section, /aria-label="開始 Z（ブロック座標）"/)
  assert.match(section, /id="control-job-reason"[^>]*role="status"/)
  assert.doesNotMatch(section, /control-hint|既存の認証を使う場合|入力はブロック座標ではなく|安全確認はBot本体/)
  assert.match(script, /p\.issues, 'blocked', '停止理由'/)
  assert.match(script, /NO_CARGO_SHULKER: '収納用シュルカーなし'/)
  assert.match(script, /p\.warnings, 'warning', '注意'/)
  assert.match(script, /diagnosticLabels\[code\] \|\| clean\(code\)/)
  assert.match(script, /ArrowLeft: -1, ArrowRight: 1, ArrowUp: -5, ArrowDown: 5/)
})
test('dashboard-control-ui: plan expiry and changing the live session keep the start gate closed', () => {
  assert.match(script, /plan\.expiresAt <= Date\.now\(\)/)
  assert.match(script, /plan\.state\.session !== live\?\.session/)
  assert.match(script, /plan\.plan\.jobId !== q\?\.jobId/)
  assert.doesNotMatch(script, /開始しますか|\['resume', 'cancel'\]\.includes\(button\) && !confirm/, 'start and resume act on the click without a browser prompt (user request 2026-11-13)')
  assert.match(script, /button === 'cancel' && !confirm\(/)
  assert.match(script, /plan = null; \$\('plan-results'\)\.hidden = true/)
  assert.doesNotMatch(script, /innerHTML|insertAdjacentHTML|\/api\/action|\/agent\/start/)
  new vm.Script(script)
})
test('dashboard-control-ui: every plan issue and warning code the quarry job can raise has a Japanese label', () => {
  const job = fs.readFileSync(path.join(root, 'src/quarry-job.js'), 'utf8')
  const labels = script.slice(script.indexOf('  const diagnosticLabels = {'), script.indexOf('  function showPlan ('))
  const codes = new Set([...job.matchAll(/issues\.push\('([A-Z0-9_]+)'\)/g), ...job.matchAll(/warnings\.push\(\{ code: '([A-Z0-9_]+)'/g)].map(match => match[1]))
  assert.ok(codes.has('LOADOUT_CHEST_INSIDE_QUARRY') && codes.size > 20)
  // Shown as a fact row, not as a chip.
  codes.delete('INITIAL_LOADOUT_ON_START')
  for (const code of codes) assert.match(labels, new RegExp('\\b' + code + ": '[^']*[\\u3040-\\u30ff\\u4e00-\\u9fff]"), code)
})
