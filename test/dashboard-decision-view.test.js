'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { modeState, playerActivity } = require('../scripts/lib/player-activity')

test('dashboard-decision-view: passes decision summary through playerActivity and classifies decision log lines', () => {
  const state = modeState({
    mode: 'player',
    player: {
      running: true,
      phase: 'working',
      reason: null,
      decision: '遠征［early.home_reserve#1］ 採掘場を進めます',
      current: 'iron',
      stages: [{ id: 'iron', label: '鉄装備', shortLabel: '鉄', reached: false, checks: [] }]
    }
  })
  const activity = playerActivity(state)
  assert.equal(activity.detail, '遠征［early.home_reserve#1］ 採掘場を進めます')

  const html = fs.readFileSync(path.resolve(__dirname, '../dashboard/index.html'), 'utf8').replace(/\r\n/g, '\n')
  const from = html.indexOf('const logHost=$(')
  const to = html.indexOf("for(const b of document.querySelectorAll('[data-log-filter]'))", from)
  const el = (tag = 'div', cls = '') => {
    let own = ''
    return {
      tag, className: cls, children: [], hidden: false, title: '', removed: false,
      get textContent () { return own + this.children.map(child => child.textContent).join('') },
      set textContent (value) { own = String(value); this.children = [] },
      append (...nodes) { this.children.push(...nodes.flatMap(n => n.tag === 'fragment' ? n.children : [n])) },
      prepend (...nodes) { this.children.unshift(...nodes.flatMap(n => n.tag === 'fragment' ? n.children : [n])) },
      remove () { this.removed = true }
    }
  }
  const ids = { 'log-view': Object.assign(el(), { scrollTop: 0, scrollHeight: 0 }), 'follow-log': { checked: true }, 'log-search': { value: '' }, 'log-count': el() }
  const context = vm.createContext({
    $: id => ids[id],
    document: { createDocumentFragment: () => el('fragment') },
    node: (tag, cls, v) => { const e = el(tag, cls); if (v !== undefined) e.textContent = v; return e },
    set: (id, v) => { ids[id].textContent = v },
    fmt: v => String(v), clean: v => v, time: v => v, setTimeout, clearTimeout
  })
  vm.runInContext(html.slice(from, to), context)
  const rows = JSON.parse(vm.runInContext(`pending.push('[20:10:00.100 JST] 判断: 遠征 採掘場を進めます'); flushLogs(); JSON.stringify(lines.map(r => ({ kind: r.el.children[1].textContent, cls: r.el.className })))`, context))
  assert.equal(rows[0].kind, '判断')
  assert.match(rows[0].cls, /\bdecision\b/)
})
