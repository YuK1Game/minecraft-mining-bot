'use strict'

const { setTimeout: sleep, setImmediate: immediate } = require('node:timers/promises')
const ORES = new Map([
  ['minecraft:coal_ore', 'coal'], ['minecraft:deepslate_coal_ore', 'coal'],
  ['minecraft:iron_ore', 'iron'], ['minecraft:deepslate_iron_ore', 'iron'],
  ['minecraft:diamond_ore', 'diamond'], ['minecraft:deepslate_diamond_ore', 'diamond']
])
const LIQUID = /(?:water|lava)$/
const OFFSETS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]

function createProspecting ({ client, getState, world, delay = ms => sleep(ms), yieldNow = () => immediate(), timeoutMs = 15000 }) {
  let active = null
  let run = 0
  let status = { phase: 'idle', ores: { coal: [], iron: [], diamond: [] }, known: 0, unknown: 0, requests: 0, reason: null }
  const snapshot = () => structuredClone(status)
  function cancel (reason = '地下の観測を停止しました。') { run++; status.phase = 'stopped'; status.reason = reason }
  function guard (id, signal, scope) {
    if (id !== run || signal?.aborted) throw new Error('地下の観測を中断しました。')
    const current = getState()
    if (current?.phase !== 'spawned' || current.dimension !== scope.dimension || ['connectionId', 'startedAt', 'runtimeEntityId'].some(key => scope[key] != null && String(current[key]) !== String(scope[key]))) throw new Error('接続またはディメンションが変わったため地下の観測を中断しました。')
  }
  async function scan ({ minY = -64, maxY = 80, chunkRadius = 1, maxResults = 64 } = {}, { signal } = {}) {
    if (active) return active
    if (![minY, maxY, chunkRadius, maxResults].every(Number.isInteger) || minY < -64 || maxY > 319 || minY > maxY || chunkRadius < 0 || chunkRadius > 1 || maxResults < 1 || maxResults > 256) throw new Error('観測する高さ・範囲が不正です。')
    const state = getState()
    if (state.phase !== 'spawned' || state.dimension !== 'overworld' || !state.position || !['x', 'y', 'z'].every(axis => Number.isFinite(state.position[axis]))) throw new Error('接続済みOverworldの位置情報が必要です。')
    const origin = { ...state.position }
    const scope = { dimension: state.dimension, connectionId: state.connectionId, startedAt: state.startedAt, runtimeEntityId: state.runtimeEntityId }
    const cx = Math.floor(state.position.x / 16), cz = Math.floor(state.position.z / 16)
    const id = ++run
    status = { phase: 'requesting', center: { x: cx, z: cz }, minY, maxY, ores: { coal: [], iron: [], diamond: [] }, known: 0, unknown: 0, requests: 0, reason: null }
    const task = (async () => {
      const sections = []
      for (let x = -chunkRadius; x <= chunkRadius; x++) for (let z = -chunkRadius; z <= chunkRadius; z++) for (let y = Math.floor(minY / 16); y <= Math.floor(maxY / 16); y++) sections.push({ x: x || 0, y, z: z || 0 })
      for (let offset = 0; offset < sections.length; offset += 18) {
        guard(id, signal, scope)
        const requests = sections.slice(offset, offset + 18)
        client.queue('subchunk_request', { dimension: 0, origin: { x: cx, y: 0, z: cz }, requests })
        status.requests += requests.length
        await delay(25)
      }
      const started = Date.now()
      while (Date.now() - started < timeoutMs) {
        guard(id, signal, scope)
        if (sections.every(section => world.getBlock((cx + section.x) * 16 + 8, section.y * 16 + 8, (cz + section.z) * 16 + 8).known)) break
        await delay(100)
      }
      status.phase = 'scanning'
      const x0 = (cx - chunkRadius) * 16, x1 = (cx + chunkRadius + 1) * 16
      const z0 = (cz - chunkRadius) * 16, z1 = (cz + chunkRadius + 1) * 16
      let batch = 0
      // Keep the ores closest to the actual scan origin, rather than keeping
      // all the highest ones and discarding nearby deep ores when capped.
      const distanceSquared = ore => (ore.position.x + 0.5 - origin.x) ** 2 + (ore.position.y + 0.5 - origin.y) ** 2 + (ore.position.z + 0.5 - origin.z) ** 2
      const rank = (a, b) => distanceSquared(a) - distanceSquared(b) || a.horizontalDistance - b.horizontalDistance || b.position.y - a.position.y
      guard(id, signal, scope)
      for (let x = x0; x < x1; x++) for (let z = z0; z < z1; z++) for (let y = maxY; y >= minY; y--) {
        const block = world.getBlock(x, y, z)
        if (!block.known) status.unknown++
        else {
          status.known++
          const resource = ORES.get(block.name)
          if (resource) {
            const neighbours = OFFSETS.map(([dx, dy, dz]) => world.getBlock(x + dx, y + dy, z + dz))
            const hazards = neighbours.filter(next => next.known && (LIQUID.test(next.name) || next.extra?.some(layer => LIQUID.test(layer.name)))).map(next => next.name)
            const ore = { known: true, name: block.name, runtimeId: block.runtimeId, position: { x, y, z }, horizontalDistance: Math.hypot(x + 0.5 - origin.x, z + 0.5 - origin.z), neighboursKnown: neighbours.every(next => next.known), hazards, exposedFaces: neighbours.filter(next => next.known && next.name === 'minecraft:air').length }
            status.ores[resource].push(ore)
            if (status.ores[resource].length > maxResults * 2) status.ores[resource] = status.ores[resource].sort(rank).slice(0, maxResults)
          }
        }
        if (++batch >= 256) { batch = 0; await yieldNow(); guard(id, signal, scope) }
      }
      guard(id, signal, scope)
      for (const resource of Object.keys(status.ores)) status.ores[resource] = status.ores[resource].sort(rank).slice(0, maxResults)
      status.phase = 'ready'
      status.reason = status.unknown ? '未受信ブロックを不明のまま残し、受信できた鉱石だけを記録しました。' : 'サーバーが送った地形から鉱石の位置を確認しました。'
      status.updatedAt = new Date().toISOString()
      return snapshot()
    })().catch(error => { if (id === run) { status.phase = 'failed'; status.reason = error.message }; throw error }).finally(() => { if (active === task) active = null })
    active = task
    return task
  }
  return { scan, cancel, snapshot }
}

module.exports = { createProspecting }
