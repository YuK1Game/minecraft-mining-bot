'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')

const rawBlock = (name, properties = {}, runtimeId = 123) => ({ known: true, name: `minecraft:${name}`, properties, runtimeId, extra: [] })

function instrumentedPhysics () {
  const filename = require.resolve('../src/physics')
  const realRegistryFactory = require('prismarine-registry')
  const realEngine = require('prismarine-physics')
  const counts = { registryFactories: 0, engines: 0, definitionStateReads: 0, blockDefinitions: new Map() }
  const registryFactory = version => {
    counts.registryFactories++
    const registry = realRegistryFactory(version)
    return {
      ...registry,
      blockStates: new Proxy(registry.blockStates, { get (target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) counts.definitionStateReads++
        return Reflect.get(target, property, receiver)
      } }),
      blocksByName: new Proxy(registry.blocksByName, { get (target, property, receiver) {
        counts.blockDefinitions.set(property, (counts.blockDefinitions.get(property) ?? 0) + 1)
        return Reflect.get(target, property, receiver)
      } })
    }
  }
  const isolated = new Module(filename, module)
  isolated.filename = filename
  isolated.paths = module.paths
  isolated.require = id => id === 'prismarine-registry' ? registryFactory : id === 'prismarine-physics' ? {
    ...realEngine,
    Physics: (...args) => { counts.engines++; return realEngine.Physics(...args) }
  } : require(id)
  isolated._compile(fs.readFileSync(filename, 'utf8'), filename)
  return { createPhysics: isolated.exports.createPhysics, counts }
}

function flatWorld (override = () => null) {
  const reads = []
  return { reads, getBlock: (x, y, z) => { reads.push([x, y, z]); return override(x, y, z) ?? rawBlock(y < 65 ? 'stone' : 'air') } }
}

function initial (physics) {
  return physics.fromServer({ position: { x: 0.5, y: 66.62, z: 0.5 }, rotation: { pitch: 0, yaw: -90 }, gameMode: 'survival' })
}

function walk (physics, state, ticks = 35) {
  for (let i = 0; i < ticks; i++) state = physics.step(state, { forward: true })
  return state
}

test('world views share canonical definitions and templates while constructing a separate local engine', () => {
  const { createPhysics, counts } = instrumentedPhysics()
  const properties = { 'minecraft:corner': 'none', upside_down_bit: 0, weirdo_direction: 0 }
  const original = rawBlock('oak_stairs', properties, 1001)
  const before = structuredClone(original)
  const base = createPhysics({ world: { getBlock: () => original } })
  const first = base.blockAt({ x: 1.2, y: 65.8, z: 2.3 })
  const scanned = counts.definitionStateReads
  assert.ok(scanned > 1000, 'the base model prepares its definition index once')
  const siblingRaw = rawBlock('oak_stairs', { weirdo_direction: 0, upside_down_bit: 0, 'minecraft:corner': 'none' }, 987654321)
  const sibling = base.withWorld({ getBlock: () => siblingRaw })
  const secondSibling = base.withWorld({ getBlock: () => rawBlock('oak_slab', { 'minecraft:vertical_half': 'top' }, 1001) })
  assert.equal(counts.registryFactories, 1)
  assert.equal(counts.definitionStateReads, scanned, 'withWorld must not scan the registry definition table again')
  assert.equal(counts.engines, 3, 'each view receives its own collision engine')
  const stairLookups = counts.blockDefinitions.get('oak_stairs')
  const viewed = sibling.blockAt({ x: 8.9, y: 70.1, z: -3.2 })
  assert.equal(counts.blockDefinitions.get('oak_stairs'), stairLookups, 'property insertion order and network runtime ID must not defeat the shared canonical template')
  assert.equal(viewed.stateId, first.stateId)
  assert.deepEqual(viewed.shapes, first.shapes)
  assert.deepEqual({ ...first.position }, { x: 1, y: 65, z: 2 })
  assert.deepEqual({ ...viewed.position }, { x: 8, y: 70, z: -4 })
  assert.notEqual(viewed.stateId, siblingRaw.runtimeId)
  assert.deepEqual(secondSibling.blockAt({ x: 8, y: 70, z: -4 }).shapes, [[0, 0.5, 0, 1, 1, 1]])
  viewed.shapes[0][0] = -99
  viewed._properties.weirdo_direction = 3
  assert.deepEqual(base.blockAt({ x: 1, y: 65, z: 2 }).shapes, first.shapes)
  assert.deepEqual(sibling.blockAt({ x: 8, y: 70, z: -4 }).getProperties(), properties)
  assert.deepEqual(original, before)
  assert.deepEqual(base.capabilities, sibling.capabilities)
  assert.deepEqual(base.constants, sibling.constants)
})

test('base and sibling steps use their own world collisions without mutating the caller state or another view', () => {
  const { createPhysics, counts } = instrumentedPhysics()
  const baseWorld = flatWorld((x, y) => x === 2 && y >= 65 && y < 68 ? rawBlock('stone', {}, 1) : null)
  const clearWorld = flatWorld()
  const nearWorld = flatWorld((x, y) => x === 1 && y >= 65 && y < 68 ? rawBlock('stone', {}, 999) : null)
  const base = createPhysics({ world: baseWorld })
  const clear = base.withWorld(clearWorld)
  const near = base.withWorld(nearWorld)
  const seed = initial(base); const unchanged = structuredClone(seed)
  const expectedBaseTick = base.step(seed, { forward: true })
  const baseWalk = walk(base, seed)
  const clearWalk = walk(clear, seed)
  const nearWalk = walk(near, seed)
  assert.ok(baseWalk.position.x <= 1.700001)
  assert.ok(clearWalk.position.x > 3)
  assert.ok(nearWalk.position.x <= 0.700001)
  assert.equal(baseWalk.isCollidedHorizontally, true)
  assert.equal(nearWalk.isCollidedHorizontally, true)
  assert.deepEqual(base.step(seed, { forward: true }), expectedBaseTick)
  assert.deepEqual(seed, unchanged)
  assert.ok(baseWorld.reads.length > 0 && clearWorld.reads.length > 0 && nearWorld.reads.length > 0)
  const readCounts = [baseWorld.reads.length, clearWorld.reads.length, nearWorld.reads.length]
  clear.blockAt({ x: 17.9, y: 71.2, z: -8.1 })
  assert.equal(baseWorld.reads.length, readCounts[0])
  assert.equal(nearWorld.reads.length, readCounts[2])
  assert.deepEqual(clearWorld.reads.at(-1), [17, 71, -9])
  assert.equal(counts.registryFactories, 1)
  assert.equal(counts.engines, 3)
})

test('cached known templates never authorize unknown or incomplete terrain in a sibling view', () => {
  const { createPhysics } = instrumentedPhysics()
  const base = createPhysics({ world: flatWorld() })
  const seed = initial(base)
  base.blockAt({ x: 0, y: 64, z: 0 })
  base.blockAt({ x: 0, y: 65, z: 0 })
  const unknown = base.withWorld(flatWorld((x, y) => x >= 1 && y >= 65 ? { known: false, name: 'minecraft:air', properties: {}, runtimeId: 123 } : null))
  assert.throws(() => unknown.blockAt({ x: 1, y: 65, z: 0 }), /Unknown terrain/)
  assert.throws(() => walk(unknown, seed), /Unknown terrain/)
  const unknownExtra = base.withWorld({ getBlock: () => ({ ...rawBlock('air'), extra: [{ known: false, name: 'minecraft:air' }] }) })
  assert.throws(() => unknownExtra.blockAt({ x: 0, y: 65, z: 0 }), /secondary collision layer not received/)
  const complete = base.withWorld({ getBlock: () => rawBlock('oak_slab', { 'minecraft:vertical_half': 'bottom' }) })
  complete.blockAt({ x: 0, y: 65, z: 0 })
  const incomplete = base.withWorld({ getBlock: () => rawBlock('oak_slab') })
  assert.throws(() => incomplete.blockAt({ x: 0, y: 65, z: 0 }), /incomplete block state/)
  assert.equal(base.blockAt({ x: 0, y: 64, z: 0 }).name, 'stone')
  assert.equal(base.blockAt({ x: 0, y: 65, z: 0 }).name, 'air')
})
