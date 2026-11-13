'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const root = path.resolve(__dirname, '..')
const script = fs.readFileSync(path.join(root, 'dashboard/control.js'), 'utf8')
const html = fs.readFileSync(path.join(root, 'dashboard/index.html'), 'utf8')
const planBegin = script.indexOf('  const diagnosticLabels =')
const planEnd = script.indexOf('  function render () {', planBegin)
const startBegin = script.indexOf("  $('start').addEventListener('click'")
const startEnd = script.indexOf('  for (const [button, command, label]', startBegin)
assert.ok(planBegin >= 0 && planEnd > planBegin && startBegin >= 0 && startEnd > startBegin)
const helpers = script.slice(script.indexOf('  const clean ='), script.indexOf('  async function request ('))
const element = script.slice(script.indexOf('  const element ='), script.indexOf('  function area () {'))
const source = helpers + element + script.slice(planBegin, planEnd) + script.slice(startBegin, startEnd)
const plain = value => JSON.parse(JSON.stringify(value))

function node (tag = 'div') {
  let text = ''
  const classes = new Set(), handlers = new Map()
  return { tag, children: [], attributes: {}, hidden: false, disabled: false, title: '', className: '',
    get textContent () { return text + this.children.map(child => child.textContent).join('') },
    set textContent (value) { text = String(value); this.children = [] },
    append (...children) { this.children.push(...children) }, replaceChildren (...children) { text = ''; this.children = [...children] },
    setAttribute (name, value) { this.attributes[name] = String(value) },
    classList: { toggle (name, force) { const add = force ?? !classes.has(name); if (add) classes.add(name); else classes.delete(name); return add }, contains: name => classes.has(name) },
    querySelector (selector) { return this.children.find(child => child.className.split(' ').includes(selector.slice(1))) ?? null },
    addEventListener (name, handler) { handlers.set(name, handler) }, click () { if (!this.disabled) handlers.get('click')?.() }
  }
}
function fixture ({ ready = true, warnings = ['INITIAL_LOADOUT_ON_START', 'LARGE_FLUID_IN_TARGET', 'Y_TOP_PROVISIONAL'], issues = [] } = {}) {
  const nodes = new Map(['plan-summary', 'plan-title', 'plan-results', 'start', 'action-message'].map(id => {
    assert.ok(html.includes(`id="control-${id}"`), 'use the actual plan result elements')
    return [id, node()]
  }))
  const check = node('span'); check.className = 'plan-check'; nodes.get('plan-results').append(check)
  const result = { planToken: 'original-one-use-token', expiresAt: 121000,
    state: { session: 'original-session', realm: { name: 'Test Realm' }, inventory: { known: true, items: [] } },
    plan: { jobId: 'fixture-plan', ready, chunks: [{ x: 127, z: 126 }], yTop: 63, yBottom: -59, warnings: [...warnings], issues: [...issues] } }
  const calls = [], prompts = [], $ = id => { assert.ok(nodes.has(id), `unexpected plan element ${id}`); return nodes.get(id) }
  const context = vm.createContext({ $, document: { createElement: node }, plan: result,
    confirm: text => { prompts.push(text); return true },
    act: (kind, route, payload, success) => { calls.push({ kind, route, payload: plain(payload) }); success?.({}) }
  })
  vm.runInContext(source, context, { filename: 'dashboard/control.js:plan', timeout: 1000 })
  context.showPlan(result)
  const groups = () => $('plan-summary').children.filter(child => child.className.startsWith('plan-diagnostics'))
  const facts = () => $('plan-summary').children.filter(child => child.className === 'plan-fact')
  return { $, check, result, context, calls, prompts, groups, facts }
}

test('the initial-loadout annotation is a short fact while real fluid and terrain warnings remain warnings', () => {
  const f = fixture(), facts = f.facts(), groups = f.groups()
  assert.deepEqual(facts.map(row => row.children.map(child => child.textContent)), [
    ['ワールド', 'Test Realm'], ['範囲', 'X 2032〜2047 / Z 2016〜2031'], ['高さ', 'Y 63 → -59'], ['初期セット', '開始時にチェストから受領']
  ])
  assert.equal(groups.length, 1); assert.equal(groups[0].className, 'plan-diagnostics warning')
  assert.deepEqual(groups[0].children.map(chip => chip.textContent), ['△ 水・溶岩あり', '△ 上限Y 未確定'])
  assert.deepEqual(groups[0].children.map(chip => chip.title), ['LARGE_FLUID_IN_TARGET', 'Y_TOP_PROVISIONAL'])
  assert.ok(!f.$('plan-summary').textContent.includes('INITIAL_LOADOUT_ON_START'))
  assert.equal(f.$('plan-title').textContent, '計画確認済み'); assert.equal(f.check.textContent, '✓')
})

test('an initial-loadout fact alone creates no triangle warning or invented cargo and tool requirements', () => {
  const f = fixture({ warnings: ['INITIAL_LOADOUT_ON_START'] })
  assert.equal(f.groups().length, 0)
  const displayed = f.$('plan-summary').textContent
  for (const text of ['△', '収納用シュルカーなし', 'ツルハシなし', '食料なし', '土・止水材なし', 'NO_CARGO_SHULKER', 'NO_PICKAXE']) assert.ok(!displayed.includes(text), text)
  assert.equal(f.result.plan.ready, true)
  assert.deepEqual(f.result.plan.issues, [])
  assert.deepEqual(f.result.state.inventory.items, [])
  assert.deepEqual(f.calls, [])
})

test('rendering the startup fact preserves the original plan confirmation and the real start handler uses its token', () => {
  const f = fixture(), before = structuredClone(f.result)
  f.context.showPlan(f.result)
  assert.deepEqual(f.result, before)
  assert.strictEqual(f.context.plan, f.result)
  assert.equal(f.result.planToken, 'original-one-use-token'); assert.equal(f.result.plan.ready, true)
  f.$('start').click()
  assert.deepEqual(f.calls, [{ kind: 'action', route: 'quarry', payload: { command: 'start', session: 'original-session', planToken: 'original-one-use-token' } }])
  assert.equal(f.context.plan, null)
  assert.equal(f.$('plan-results').hidden, true)
  assert.equal(f.prompts.length, 1)
  assert.deepEqual(f.result, before, 'display and starting cannot rewrite the server plan or token')
})

test('a startup fact cannot turn a blocked plan into a ready plan or hide its real issues', () => {
  const f = fixture({ ready: false, issues: ['INVENTORY_UNKNOWN'] })
  assert.equal(f.result.plan.ready, false)
  assert.equal(f.$('plan-title').textContent, '開始不可'); assert.equal(f.check.textContent, '!')
  assert.equal(f.$('plan-results').classList.contains('blocked'), true)
  const blocked = f.groups().find(group => group.className === 'plan-diagnostics blocked')
  assert.deepEqual(blocked.children.map(chip => chip.textContent), ['× 所持品 未受信'])
  assert.equal(f.groups().find(group => group.className === 'plan-diagnostics warning').children.length, 2)
  assert.equal(f.result.planToken, 'original-one-use-token'); assert.deepEqual(f.calls, [])
})

test('ordinary warning-only plans keep their diagnostics without creating an initial-loadout fact', () => {
  const f = fixture({ warnings: ['LARGE_FLUID_IN_TARGET'] })
  assert.equal(f.facts().length, 3)
  assert.ok(!f.$('plan-summary').textContent.includes('初期セット'))
  assert.deepEqual(f.groups()[0].children.map(chip => chip.textContent), ['△ 水・溶岩あり'])
  assert.equal(f.result.plan.ready, true); assert.equal(f.check.textContent, '✓')
})
