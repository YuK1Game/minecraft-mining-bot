'use strict'

// The open list of a best-first search (navigation, tunnelling) as a binary
// heap. `before(a, b)` orders two ranks; equal ranks leave in the order their
// node first entered the list, which is what a linear scan of an
// insertion-ordered Set picked. Scanning every open node per expansion made
// the searches quadratic in their limit (2026-11-16: seconds of blocked event
// loop per tunnel search). A node whose record was replaced leaves a stale
// entry behind; `records` tells which entry is current.
function createOpenList ({ records, before }) {
  const heap = []
  const entered = new Map()
  let sequence = 0
  const first = (a, b) => before(a.rank, b.rank) || !before(b.rank, a.rank) && a.sequence < b.sequence
  function push (id, record, rank) {
    if (!entered.has(id)) entered.set(id, sequence++)
    heap.push({ id, record, rank, sequence: entered.get(id) })
    for (let index = heap.length - 1; index > 0;) {
      const parent = (index - 1) >> 1
      if (!first(heap[index], heap[parent])) break
      ;[heap[index], heap[parent]] = [heap[parent], heap[index]]
      index = parent
    }
  }
  // The best open node's id, or null when none is left.
  function pop () {
    while (heap.length) {
      const top = heap[0]
      const last = heap.pop()
      if (heap.length) {
        heap[0] = last
        for (let index = 0; ;) {
          const left = index * 2 + 1, right = left + 1
          let best = index
          if (left < heap.length && first(heap[left], heap[best])) best = left
          if (right < heap.length && first(heap[right], heap[best])) best = right
          if (best === index) break
          ;[heap[index], heap[best]] = [heap[best], heap[index]]
          index = best
        }
      }
      if (entered.has(top.id) && records.get(top.id) === top.record) { entered.delete(top.id); return top.id }
    }
    return null
  }
  return { push, pop, get size () { return entered.size } }
}

module.exports = { createOpenList }
