'use strict'

const { serpentineLayer } = require('./quarry-region')
const empty = () => ({ remaining: 0, unknown: 0, reserved: 0, deferred: 0 })
const add = (total, value) => { for (const key of Object.keys(total)) total[key] += value[key] }

// Display scans reuse unchanged 16-cube sections. Synchronous completion
// checks deliberately pass no observer and always read the current terrain.
function createQuarryCounts ({ regions, cellStatus, revision }) {
  const sections = new Map()
  function * sectionCells (chunk, top, bottom) {
    const total = empty()
    let visited = 0, started = performance.now()
    for (let y = top; y >= bottom; y--) for (const p of serpentineLayer(chunk, y)) {
      const { status } = cellStatus(p)
      if (['pending', 'fluid', 'blocked'].includes(status)) total.remaining++
      else if (status === 'unknown') total.unknown++
      else if (status === 'reserved') total.reserved++
      else if (status === 'deferred') total.deferred++
      if (++visited % 128 === 0 && performance.now() - started >= 8) { yield; started = performance.now() }
    }
    return total
  }
  function * countCells (yTop, observeTerrain) {
    const total = empty()
    if (!Number.isSafeInteger(yTop)) return total
    for (let sy = Math.floor(yTop / 16); sy >= Math.floor(regions.yBottom / 16); sy--) for (const chunk of regions.chunks) {
      const top = Math.min(yTop, sy * 16 + 15), bottom = Math.max(regions.yBottom, sy * 16)
      const key = `${chunk.x},${sy},${chunk.z}:${top}:${bottom}`, cached = observeTerrain && sections.get(key)
      if (cached && cached.revision === revision() && cached.terrain.reuse?.() === true) { add(total, cached.value); continue }
      const terrain = observeTerrain?.(), scan = sectionCells(chunk, top, bottom)
      const run = fn => terrain ? terrain.run(fn) : fn()
      let result = run(() => scan.next())
      while (!result.done) { yield; result = run(() => scan.next()) }
      add(total, result.value)
      if (terrain?.current()) {
        if (sections.size >= 4096) sections.clear()
        sections.set(key, { revision: revision(), terrain, value: result.value })
      }
      // Even warm-cache scans yield periodically across a large job.
      yield
    }
    return total
  }
  function counts (yTop) {
    const scan = countCells(yTop), run = () => scan.next()
    let result = run()
    while (!result.done) result = run()
    return result.value
  }
  async function countsAsync (yTop, isCurrent = () => true, { observeTerrain, run = fn => fn() } = {}) {
    if (!isCurrent()) return null
    const scan = countCells(yTop, observeTerrain)
    let result = run(() => scan.next())
    while (!result.done) {
      await new Promise(resolve => setImmediate(resolve))
      if (!isCurrent()) return null
      result = run(() => scan.next())
    }
    return isCurrent() ? result.value : null
  }
  return { counts, countsAsync }
}

module.exports = { createQuarryCounts }
