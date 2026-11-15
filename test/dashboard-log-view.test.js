'use strict'

// The live log panel of the dashboard, run from the page's own code. Live
// 2026-11-15: the time column was always empty (the Bot writes
// "[HH:MM:SS.mmm JST]"), about half of all lines were one repeated combat
// diagnostic, and every combat line ended in a long machine context.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const html = fs.readFileSync(path.resolve(__dirname, '../dashboard/index.html'), 'utf8').replace(/\r\n/g, '\n')
const from = html.indexOf('const logHost=$('), to = html.indexOf("for(const b of document.querySelectorAll('[data-log-filter]'))", from)
assert.ok(from >= 0 && to > from, 'the page has its log code')

function panel () {
  const el = (tag = 'div', cls = '') => {
    let own = ''
    return { tag, className: cls, children: [], hidden: false, title: '', removed: false,
      get textContent () { return own + this.children.map(child => child.textContent).join('') }, set textContent (value) { own = String(value); this.children = [] },
      append (...nodes) { this.children.push(...nodes.flatMap(n => n.tag === 'fragment' ? n.children : [n])) },
      prepend (...nodes) { this.children.unshift(...nodes.flatMap(n => n.tag === 'fragment' ? n.children : [n])) },
      remove () { this.removed = true } }
  }
  const ids = { 'log-view': Object.assign(el(), { scrollTop: 0, scrollHeight: 0 }), 'follow-log': { checked: true }, 'log-search': { value: '' }, 'log-count': el() }
  const context = vm.createContext({ $: id => ids[id], document: { createDocumentFragment: () => el('fragment') },
    node: (tag, cls, v) => { const e = el(tag, cls); if (v !== undefined) e.textContent = v; return e },
    set: (id, v) => { ids[id].textContent = v }, fmt: v => String(v), clean: v => v, time: v => v, setTimeout, clearTimeout })
  vm.runInContext(html.slice(from, to), context)
  const push = (...texts) => JSON.parse(vm.runInContext(`pending.push(...${JSON.stringify(texts)}); flushLogs(); JSON.stringify(lines.map(r => ({ time: r.at.textContent, kind: r.el.children[1].textContent, shown: r.body.textContent, repeat: r.repeat.hidden ? null : r.repeat.textContent, title: r.el.title, hidden: r.el.hidden })))`, context))
  return { push, ids, run: code => vm.runInContext(code, context) }
}

test('the time column is filled from the Bot\'s bracketed millisecond timestamp and the text no longer repeats it', () => {
  const rows = panel().push('[07:14:47.301 JST] 行動コードを反映しました。Minecraftへの接続は保持しています。', '07:15:00 JST 露天掘りを開始', 'no timestamp here')
  assert.deepEqual(rows.map(r => [r.time, r.shown]), [['07:14:47', '行動コードを反映しました。Minecraftへの接続は保持しています。'], ['07:15:00', '露天掘りを開始'], ['', 'no timestamp here']])
})

test('consecutive lines that differ only in numbers become one row with the latest values and a count', () => {
  const p = panel()
  const approach = (ms, d) => `[06:31:38.${ms} JST] 戦闘接近: target=drowned distance=${d}m mode=- preview=OUT_OF_REACH context={"claimId":35,"runtimeId":"13367"}`
  let rows = p.push(approach(367, '4.0'), approach(430, '3.9'), approach(482, '3.7'))
  assert.equal(rows.length, 1)
  assert.deepEqual([rows[0].time, rows[0].shown, rows[0].repeat], ['06:31:38', '戦闘接近: target=drowned distance=3.7m mode=- preview=OUT_OF_REACH', '×3'])
  // A different message ends the run; the same message later starts a new row.
  rows = p.push('[06:31:38.500 JST] 戦闘終了: target=drowned code=APPROACH_NOT_READY 2112ms', approach(585, '4.0'), '[06:31:39.000 JST] 戦闘接近: target=zombie distance=4.0m mode=- preview=OUT_OF_REACH')
  assert.deepEqual(rows.map(r => r.repeat), ['×3', null, null, null])
  assert.equal(rows.length, 4, 'another target is another row')
  assert.equal(p.ids['log-view'].children.length, 4)
  assert.match(p.ids['log-count'].textContent, /4/)
})

test('the machine context is hidden from the row but kept for hover and search', () => {
  const p = panel()
  const rows = p.push('[06:31:38.359 JST] 戦闘開始: target=drowned mode=approach context={"claimId":35,"scope":{"connectionId":"aeb31da1"}}')
  assert.equal(rows[0].shown, '戦闘開始: target=drowned mode=approach')
  assert.match(rows[0].title, /context=\{"claimId":35/)
  assert.equal(rows[0].kind, '戦闘')
  p.ids['log-search'].value = 'aeb31da1'
  assert.equal(p.run('refreshLogs(); lines[0].el.hidden'), false)
  p.ids['log-search'].value = 'not in any line'
  assert.equal(p.run('refreshLogs(); lines[0].el.hidden'), true)
})
