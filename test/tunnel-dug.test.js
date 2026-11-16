'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { emptyDug } = require('../src/survival/tunnel-dug')

test('a dug set answers like a copied Set across branches and snapshots', () => {
  let dug = emptyDug(), copy = new Set()
  const branches = []
  for (let step = 0; step < 60; step++) {
    const ids = step % 3 === 0 ? [] : [step * 10, step * 10 + 1]
    dug = dug.with(ids); copy = new Set([...copy, ...ids])
    if (step % 7 === 0) branches.push({ dug, copy: new Set(copy) })
  }
  for (const { dug: branch, copy: expected } of [...branches, { dug, copy }]) {
    assert.equal(branch.size, expected.size)
    for (let id = 0; id < 620; id++) assert.equal(branch.has(id), expected.has(id), `id ${id}`)
  }
  // A branch made later does not change an earlier one.
  const side = branches[2].dug.with([99999])
  assert.equal(side.has(99999), true)
  assert.equal(branches[2].dug.has(99999), false)
  assert.equal(emptyDug().with([]).size, 0)
})
