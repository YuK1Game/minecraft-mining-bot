'use strict'

// No connection or account: times world.getBlock on synthetic received
// sections with the real block registry. Pass another world.js as the first
// argument to time that copy instead (for before/after comparisons).
const path = require('node:path')
const { createWorld } = require(process.argv[2] ? path.resolve(process.argv[2]) : '../src/world')
// The real registry only maps runtime IDs after a start_game from a server, so
// the fixture uses 2,000 blocks shaped like its entries (three states each).
const registry = { blocksByRuntimeId: {}, blockStates: [], handleStartGame () {} }
for (let id = 0; id < 2000; id++) {
  registry.blocksByRuntimeId[id] = { stateId: id, name: id ? `block_${id}` : 'air', boundingBox: id ? 'block' : 'empty', hardness: id % 7, diggable: id > 0 }
  registry.blockStates.push({ name: id ? `block_${id}` : 'air', states: id ? { facing_direction: { value: id % 6 }, open_bit: { value: id % 2 }, 'minecraft:cardinal_direction': { value: 'north' } } : {} })
}
const ids = Object.keys(registry.blocksByRuntimeId).map(Number)
const air = 0
function varint (number) {
  let value = ((number << 1) ^ (number >> 31)) >>> 0
  const bytes = []
  while (value > 127) { bytes.push((value & 127) | 128); value >>>= 7 }
  bytes.push(value)
  return Buffer.from(bytes)
}
function section (y, seed) {
  const bits = 4, perWord = 8, words = new Uint32Array(512), palette = [air, ...Array.from({ length: 15 }, (_, i) => ids[(seed * 131 + i * 977) % ids.length])]
  let s = seed
  for (let index = 0; index < 4096; index++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; words[index >> 3] |= (s >>> 28) << ((index % perWord) * bits) }
  const body = Buffer.alloc(2048)
  words.forEach((word, i) => body.writeUInt32LE(word >>> 0, i * 4))
  return Buffer.concat([Buffer.from([9, 1, y & 255, (bits << 1) | 1]), body, varint(palette.length), ...palette.map(varint)])
}
const world = createWorld({ registry })
world.applyPacket('start_game', { dimension: 'overworld' })
for (let x = -2; x < 2; x++) for (let z = -2; z < 2; z++) for (let y = 3; y < 6; y++) world.applyPacket('subchunk', { dimension: 0, cache_enabled: false, origin: { x, y, z }, entries: [{ dx: 0, dy: 0, dz: 0, result: 'success', payload: section(y, (x + 9) * 100 + (z + 9) * 10 + y) }] })
function run (label, visit) {
  for (let i = 0; i < 3; i++) visit()
  const started = performance.now(); let reads = 0, known = 0
  for (let i = 0; i < 20; i++) { const r = visit(); reads += r.reads; known += r.known }
  const ms = performance.now() - started
  return { label, reads, known, nsPerRead: Math.round(ms * 1e6 / reads) }
}
// A route search reads neighbours of nearby cells; a plan scans layer by layer.
const local = () => { let reads = 0, known = 0; for (let x = -30; x < 30; x++) for (let z = -30; z < 30; z++) for (let y = 62; y < 68; y++) { reads++; if (world.getBlock(x, y, z).known) known++ } return { reads, known } }
const scattered = () => { let reads = 0, known = 0, s = 7; for (let i = 0; i < 20000; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; reads++; if (world.getBlock((s & 63) - 32, 48 + ((s >>> 8) & 47), ((s >>> 16) & 63) - 32).known) known++ } return { reads, known } }
console.log(JSON.stringify({ fixture: '48 synthetic sections, 2,000 synthetic block states', results: [run('neighbouring cells', local), run('scattered cells', scattered)] }, null, 2))
