'use strict'

// Reserve both positions durably before placement. Until a 54-slot window is
// received, return-to-base must not mistake either half for an existing chest.
const fs = require('node:fs')
const { writeDurableJson } = require('../common/durable-json')

const point = p => p && ['x', 'y', 'z'].every(k => Number.isSafeInteger(p[k]) && Math.abs(p[k]) <= 30000000)
const same = (a, b) => point(a) && point(b) && ['x', 'y', 'z'].every(k => a[k] === b[k])
const valid = entry => entry && (entry.worldScope === null || typeof entry.worldScope === 'string') && Array.isArray(entry.cells) && entry.cells.length === 2 && entry.cells.every(point) && entry.cells[0].y === entry.cells[1].y && Math.abs(entry.cells[0].x - entry.cells[1].x) + Math.abs(entry.cells[0].z - entry.cells[1].z) === 1 && (entry.stages == null || Array.isArray(entry.stages) && entry.stages.length === 2 && entry.stages.every(stage => ['reserved', 'attempting', 'received'].includes(stage)))
// A legacy position-only reservation cannot prove that nothing was sent.
const stagesOf = entry => entry.stages ?? ['attempting', 'attempting']
const empty = () => ({ version: 1, pairs: [] })

function loadChestPairs (file, { io = fs } = {}) {
  if (!file) return empty()
  try {
    const data = JSON.parse(String(io.readFileSync(file, 'utf8')).replace(/^\uFEFF/, ''))
    if (data?.version !== 1 || !Array.isArray(data.pairs) || data.pairs.length > 64 || !data.pairs.every(valid)) throw new Error('invalid chest pair record')
    return data
  } catch (error) { return error?.code === 'ENOENT' ? empty() : { ...empty(), loadFailed: true } }
}

function createChestPairs ({ shared, worldScope = () => null, getBlock = () => null, file = null, write = writeDurableJson, say = () => {} }) {
  if (shared.playerChestPairs === undefined) shared.playerChestPairs = loadChestPairs(file)
  const ready = () => shared.playerChestPairs?.version === 1 && !shared.playerChestPairs.loadFailed && Array.isArray(shared.playerChestPairs.pairs) && (!file || worldScope() != null)
  const entries = () => ready() ? shared.playerChestPairs.pairs.filter(entry => entry.worldScope === worldScope()) : []
  const pending = at => !ready() || entries().some(entry => entry.cells.some(cell => same(cell, at)))
  const standing = at => { const block = getBlock(at.x, at.y, at.z); return block?.known === true && block.name === 'minecraft:chest' }
  const waiting = () => entries().some(entry => stagesOf(entry).includes('attempting'))
  const canAttempt = at => ready() && !waiting() && entries().some(entry => entry.cells.some((cell, i) => same(cell, at) && stagesOf(entry)[i] === 'reserved'))
  function observed (pairs) {
    let changed = false
    const next = pairs.map(entry => {
      if (entry.worldScope !== worldScope()) return entry
      const stages = stagesOf(entry).map((stage, i) => standing(entry.cells[i]) ? 'received' : stage)
      if (entry.stages && stages.every((stage, i) => stage === entry.stages[i])) return entry
      changed = true
      return { ...entry, stages }
    })
    return changed ? next : pairs
  }
  function change (update) {
    const scope = worldScope()
    const pending = shared.playerChestPairWrites ?? Promise.resolve()
    const task = pending.catch(() => {}).then(async () => {
      if (!ready() || worldScope() !== scope) return false
      const pairs = update(shared.playerChestPairs.pairs)
      if (!pairs) return false
      if (pairs === shared.playerChestPairs.pairs) return true
      const next = { version: 1, pairs }
      try { if (file) await write(file, next) } catch (error) { say(`未完成チェストの記録を保存できないため、設置を保留しました ${String(error?.message ?? error).slice(0, 100)}`); return false }
      shared.playerChestPairs = next
      return true
    })
    // Hot reload shares this queue too; a late older write cannot overwrite
    // the next runtime's reservation or discard its unfinished pair.
    Object.defineProperty(shared, 'playerChestPairWrites', { configurable: true, writable: true, enumerable: false, value: task.then(() => {}, () => {}) })
    return task
  }
  async function begin (cells) {
    if (!ready()) { say('未完成チェストの記録・ワールドを確認できないため、設置を保留しました'); return false }
    const entry = { worldScope: worldScope(), cells: cells.map(cell => ({ x: cell.x, y: cell.y, z: cell.z })), stages: ['reserved', 'reserved'] }
    if (!valid(entry)) return false
    return change(current => {
      const pairs = observed(current)
      if (pairs.some(old => old.worldScope === entry.worldScope && old.cells.every(a => entry.cells.some(b => same(a, b))))) return pairs
      const overlapping = pairs.filter(old => old.worldScope === entry.worldScope && old.cells.some(a => entry.cells.some(b => same(a, b))))
      // Replanning may replace a cell that was never attempted, but must not
      // forget an uncertain send or a received half at another position.
      if (overlapping.some(old => old.cells.some((cell, i) => stagesOf(old)[i] !== 'reserved' && !entry.cells.some(at => same(at, cell))))) return null
      entry.stages = entry.cells.map(cell => standing(cell) ? 'received' : (() => { const old = overlapping.find(old => old.cells.some(at => same(at, cell))); return old ? stagesOf(old)[old.cells.findIndex(at => same(at, cell))] : 'reserved' })())
      const keep = pairs.filter(old => old.worldScope !== entry.worldScope || !old.cells.some(a => entry.cells.some(b => same(a, b))))
      if (keep.length >= 64) { say('未完成チェストが残っているため、新しい設置を保留しました'); return null }
      return [...keep, entry]
    })
  }
  const observe = () => change(observed)
  const stage = (at, next) => change(current => {
    const pairs = observed(current)
    const entry = pairs.find(entry => entry.worldScope === worldScope() && entry.cells.some(cell => same(cell, at)))
    if (!entry) return null
    const index = entry.cells.findIndex(cell => same(cell, at)), before = stagesOf(entry)[index]
    if (next === 'attempting' && (before !== 'reserved' || pairs.some(row => row.worldScope === worldScope() && stagesOf(row).includes('attempting')))) return null
    if (next === 'received' && !standing(at)) return null
    if (next === 'reserved' && before === 'received') return null
    if (before === next) return pairs
    const stages = [...stagesOf(entry)]; stages[index] = next
    return pairs.map(row => row === entry ? { ...row, stages } : row)
  })
  async function complete (at) {
    if (!ready()) return false
    const scope = worldScope()
    return change(pairs => {
      const keep = pairs.filter(entry => entry.worldScope !== scope || !entry.cells.some(cell => same(cell, at)))
      return keep.length === pairs.length ? pairs : keep
    })
  }
  return { ready, pending, begin, complete, observe, waiting, canAttempt, unfinished: entries, attempt: at => stage(at, 'attempting'), received: at => stage(at, 'received'), retry: at => stage(at, 'reserved') }
}

module.exports = { createChestPairs, loadChestPairs }
