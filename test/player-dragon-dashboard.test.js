'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const fs = require('node:fs')
const path = require('node:path')

test('player dashboard distinguishes manual stop, active play, and a completed expedition', () => {
  const createElement = () => ({
    dataset: {}, append () {}, after () {}, setAttribute () {}, addEventListener () {},
    replaceChildren () {}, querySelector: () => createElement()
  })
  const elements = new Map()
  const document = { createElement, getElementById (id) {
    if (!elements.has(id)) elements.set(id, createElement())
    return elements.get(id)
  } }
  let render
  const window = { botControl: { idle: () => true }, addEventListener: (_, fn) => { render = fn } }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../dashboard/mode.js'), 'utf8'), { document, window })
  const show = (phase, running) => render({ detail: {
    ready:true, mode:{ current:'player', player:{ phase, running, stages:[], reason:'確認済みの進捗' } }
  } })
  const badge = document.getElementById('control-live'), start = document.getElementById('control-start')
  show('idle', false)
  assert.equal(badge.textContent, '停止中')
  assert.equal(start.disabled, false)
  show('working', true)
  assert.equal(badge.textContent, 'プレイ中')
  show('completed', false)
  assert.equal(badge.textContent, '遠征完了')
  assert.equal(badge.title, '確認済みの進捗')
  assert.equal(start.disabled, true)
})
