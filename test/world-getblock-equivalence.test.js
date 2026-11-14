'use strict'

// getBlock shares block descriptions and remembers the last section it read.
// These tests hold it to the previous implementation's exact results, kept
// here as the reference, across palettes, updates, fluid layers and resets.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createWorld, readRuntimeSection } = require('../src/world')

function varint (number) {
  let value = ((number << 1) ^ (number >> 31)) >>> 0
  const bytes = []
  while (value > 127) { bytes.push((value & 127) | 128); value >>>= 7 }
  bytes.push(value)
  return Buffer.from(bytes)
}
function random (seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 } }
function layer (bits, palette, pick) {
  if (bits === 0) return Buffer.concat([Buffer.from([1]), varint(palette[0])])
  const perWord = Math.floor(32 / bits), words = new Uint32Array(Math.ceil(4096 / perWord))
  for (let index = 0; index < 4096; index++) words[Math.floor(index / perWord)] |= pick(index) << ((index % perWord) * bits)
  const body = Buffer.alloc(words.length * 4)
  words.forEach((word, i) => body.writeUInt32LE(word >>> 0, i * 4))
  return Buffer.concat([Buffer.from([(bits << 1) | 1]), body, varint(palette.length), ...palette.map(varint)])
}
function payload (y, layers) { return Buffer.concat([Buffer.from([9, layers.length, y & 255]), ...layers]) }

function registryOf (shift = 0) {
  const names = ['air', 'stone', 'water', 'dirt', 'oak_log', 'gravel', 'lava', 'minecraft:chest']
  const entries = {}, blockStates = []
  names.forEach((name, id) => {
    blockStates.push({ name, states: id === 4 ? { pillar_axis: { value: 'y' }, plain: 3 } : {} })
    entries[id + shift] = { stateId: id, name, boundingBox: id === 0 || id === 2 || id === 6 ? 'empty' : 'block', hardness: id ? id / 2 : undefined, diggable: id !== 0 }
  })
  entries['-7'] = entries[1 + shift]
  return { blocksByRuntimeId: entries, blockStates, handleStartGame () {} }
}

// The implementation before the shared descriptions, reading the same inputs.
function reference (registry) {
  const sections = new Map(); let initialized = false, air = null
  const resolve = runtimeId => {
    const entry = registry.blocksByRuntimeId[runtimeId] ?? registry.blocksByRuntimeId[runtimeId | 0]
    const state = entry && registry.blockStates[entry.stateId]
    if (!state) return null
    return { name: state.name.startsWith('minecraft:') ? state.name : `minecraft:${state.name}`, runtimeId: runtimeId >>> 0, properties: Object.fromEntries(Object.entries(state.states ?? {}).map(([name, value]) => [name, value?.value ?? value])), boundingBox: entry.boundingBox ?? null, hardness: entry.hardness ?? null, diggable: entry.diggable ?? false }
  }
  return {
    start () { sections.clear(); initialized = true; air = Number(Object.entries(registry.blocksByRuntimeId).find(([, entry]) => entry.name === 'air')[0]) },
    put (x, y, z, buffer) { sections.set(`${x},${y},${z}`, { layers: readRuntimeSection(buffer, 0, y).layers, updates: new Map() }) },
    drop (x, y, z) { sections.delete(`${x},${y},${z}`) },
    update (p, layerIndex, runtimeId) {
      const section = sections.get(`${Math.floor(p.x / 16)},${Math.floor(p.y / 16)},${Math.floor(p.z / 16)}`)
      const index = ((p.x & 15) << 8) | ((p.z & 15) << 4) | (p.y & 15)
      if (!section.updates.has(index)) section.updates.set(index, new Map())
      section.updates.get(index).set(layerIndex, runtimeId)
    },
    getBlock (x, y, z) {
      const position = { x, y, z }
      const unknown = (reason, runtimeId = null) => ({ known: false, position, name: null, runtimeId, properties: null, reason })
      if (![x, y, z].every(Number.isSafeInteger)) return unknown('invalid_position')
      if (!initialized) return unknown('world_not_initialized')
      const section = sections.get(`${Math.floor(x / 16)},${Math.floor(y / 16)},${Math.floor(z / 16)}`)
      if (!section) return unknown('subchunk_not_received')
      const index = ((x & 15) << 8) | ((z & 15) << 4) | (y & 15), updates = section.updates.get(index), layers = []
      for (let i = 0; i < Math.max(2, section.layers.length); i++) {
        let runtimeId = updates?.get(i)
        const storage = section.layers[i]
        if (runtimeId === undefined) {
          if (!storage) runtimeId = air
          else if (storage.bits === 0) runtimeId = storage.palette[0]
          else { const perWord = Math.floor(32 / storage.bits); runtimeId = storage.palette[(storage.words[Math.floor(index / perWord)] >>> ((index % perWord) * storage.bits)) & ((1 << storage.bits) - 1)] }
        }
        if (runtimeId == null) return unknown('unknown_palette_entry')
        const block = resolve(runtimeId)
        if (!block) return unknown('unknown_runtime_id', runtimeId >>> 0)
        layers.push(block)
      }
      return { known: true, position, ...layers[0], extra: layers.slice(1).filter(block => block.name !== 'minecraft:air') }
    }
  }
}

function pair (registry) {
  const world = createWorld({ registry }), model = reference(registry)
  const start = () => { world.applyPacket('start_game', { dimension: 'overworld' }); model.start() }
  const put = (x, y, z, buffer) => { world.applyPacket('subchunk', { dimension: 0, cache_enabled: false, origin: { x, y, z }, entries: [{ dx: 0, dy: 0, dz: 0, result: 'success', payload: buffer }] }); model.put(x, y, z, buffer) }
  const update = (position, layerIndex, runtimeId) => { world.applyPacket('update_block', { position, block_runtime_id: runtimeId, layer: layerIndex }); model.update(position, layerIndex, runtimeId) }
  const same = (x, y, z) => assert.deepStrictEqual(world.getBlock(x, y, z), model.getBlock(x, y, z), `${x},${y},${z}`)
  return { world, model, start, put, update, same }
}

function fill (h, next, shift = 0) {
  const id = () => Math.floor(next() * 8) + shift
  for (const [x, y, z] of [[0, 4, 0], [-1, -4, -1], [1, 4, 0], [0, 3, 0], [-2, 0, 3]]) {
    const bits = [0, 1, 2, 3, 4, 5, 6, 8, 16][Math.floor(next() * 9)], size = Math.max(1, Math.min(1 << Math.min(bits, 6), 40))
    const palette = Array.from({ length: bits === 0 ? 1 : size }, id)
    // 99999 and -7 exercise an unmapped ID and the signed-hash lookup.
    if (bits >= 2) { palette[1] = 99999; palette[2] = -7 }
    const layers = [layer(bits, palette, () => Math.floor(next() * palette.length))]
    if (next() < 0.6) layers.push(layer(1, [shift, 2 + shift], () => next() < 0.2 ? 1 : 0))
    h.put(x, y, z, payload(y, layers))
  }
}
function sweep (h, next, count = 6000) {
  for (let i = 0; i < count; i++) h.same(Math.floor(next() * 80) - 40, Math.floor(next() * 160) - 70, Math.floor(next() * 80) - 24)
  // Runs along one column stay inside one section, as a route search does.
  for (let y = 64; y < 80; y++) for (let x = 0; x < 16; x++) h.same(x, y, 5)
}

test('getBlock matches the previous implementation over random sections, updates and unreceived space', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const next = random(seed), h = pair(registryOf())
    h.same(0, 64, 0)
    h.start(); fill(h, next); sweep(h, next)
    for (let i = 0; i < 400; i++) {
      const position = [{ x: Math.floor(next() * 16), y: 64 + Math.floor(next() * 16), z: Math.floor(next() * 16) }, { x: -1 - Math.floor(next() * 16), y: -64 + Math.floor(next() * 16), z: -1 - Math.floor(next() * 16) }][i % 2]
      h.update(position, i % 3 === 0 ? 1 : 0, [0, 1, 2, 3, 99999, -7][Math.floor(next() * 6)])
      h.same(position.x, position.y, position.z)
    }
    sweep(h, next)
    for (const bad of [[0.5, 64, 0], [0, NaN, 0], [0, 64, 2 ** 53], [null, 64, 0]]) h.same(...bad)
  }
})

test('a replaced or removed section is never served from the remembered one', () => {
  const h = pair(registryOf())
  h.start()
  h.put(0, 4, 0, payload(4, [layer(0, [1])]))
  h.same(3, 70, 3)
  h.put(0, 4, 0, payload(4, [layer(0, [3])]))
  h.same(3, 70, 3)
  assert.equal(h.world.getBlock(3, 70, 3).name, 'minecraft:dirt')
  h.world.applyPacket('subchunk', { dimension: 0, cache_enabled: false, origin: { x: 0, y: 4, z: 0 }, entries: [{ dx: 0, dy: 0, dz: 0, result: 'chunk_not_found' }] }); h.model.drop(0, 4, 0)
  h.same(3, 70, 3)
  assert.equal(h.world.getBlock(3, 70, 3).known, false)
  h.put(0, 4, 0, payload(4, [layer(0, [1])]))
  h.world.applyPacket('level_chunk', { dimension: 0, x: 0, z: 0, sub_chunk_count: 0xfffffffe, cache_enabled: false, payload: Buffer.alloc(0) }); h.model.drop(0, 4, 0)
  h.same(3, 70, 3)
})

test('a new start_game with different runtime IDs does not reuse earlier block descriptions', () => {
  const registry = registryOf(), h = pair(registry), next = random(9)
  h.start(); fill(h, next); sweep(h, next, 500)
  assert.equal(h.world.getBlock(0, 0, 0).known, false)
  // The same registry object now maps every ID to a different block.
  const shifted = registryOf(3)
  registry.blocksByRuntimeId = shifted.blocksByRuntimeId; registry.blockStates = shifted.blockStates
  h.start(); fill(h, next, 3); sweep(h, next, 2000)
})

test('one read cannot change what a later read returns', () => {
  const h = pair(registryOf())
  h.start()
  h.put(0, 4, 0, payload(4, [layer(0, [4]), layer(0, [2])]))
  const first = h.world.getBlock(1, 64, 1)
  assert.deepEqual(first.properties, { pillar_axis: 'y', plain: 3 })
  assert.throws(() => { first.properties.pillar_axis = 'x' }, TypeError)
  first.name = 'changed'; first.position.x = 99; first.extra[0].name = 'changed'; first.extra.push({})
  h.same(1, 64, 1)
  assert.notEqual(h.world.getBlock(1, 64, 1).extra, h.world.getBlock(1, 64, 1).extra)
})
