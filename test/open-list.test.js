'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createOpenList } = require('../src/common/open-list')

test('pops in the order a linear scan of an insertion-ordered set picks', () => {
  let seed = 3
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  const records = new Map(), list = createOpenList({ records, before: (a, b) => a < b }), set = new Set()
  const scan = () => { let best; for (const id of set) if (best === undefined || records.get(id).f < records.get(best).f) best = id; set.delete(best); return best }
  for (let round = 0; round < 2000; round++) {
    if (set.size && random() < 0.4) { assert.equal(list.pop(), scan()); continue }
    // New nodes, cheaper replacements of open ones, and re-entries after a pop.
    const id = `n${Math.floor(random() * 60)}`, record = { f: Math.floor(random() * 12) }
    if (set.has(id) && records.get(id).f <= record.f) continue
    records.set(id, record); set.add(id); list.push(id, record, record.f)
    assert.equal(list.size, set.size)
  }
  while (set.size) assert.equal(list.pop(), scan())
  assert.equal(list.pop(), null)
  assert.equal(list.size, 0)
})
