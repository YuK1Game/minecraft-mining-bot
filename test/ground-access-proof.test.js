'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { proveGroundAccess, isCurrentBlockedGroundProof } = require('../src/ground-access-proof')
const copy = value => structuredClone(value)
const key = p => `${p.x},${p.y},${p.z}`
const air = () => ({ known: true, name: 'minecraft:air', boundingBox: 'empty', extra: [] })
const stone = () => ({ known: true, name: 'minecraft:stone', boundingBox: 'block', extra: [] })

function scene () {
  const state = { profile: 'bot', realm: { id: '42' }, dimension: 'overworld', connectionId: 'current', startedAt: '2026-11-07T00:00:00Z', runtimeEntityId: '1', lifecycle: { deathId: 0 }, phase: 'spawned', health: 20, position: { x: 0.5, y: 15.62, z: 0.5 }, worldRevision: 10 }
  const target = { runtimeId: '8', uniqueId: '-8', entityType: 'minecraft:zombie', kind: 'mob', hostile: true, alive: true, positionKnown: true, dimension: 'overworld', position: { x: 0.5, y: 0, z: 0.5 } }
  const blocks = new Map([[key({ x: 0, y: 0, z: 0 }), air()], [key({ x: 0, y: 14, z: 0 }), air()]])
  let revision = 10
  const input = { target, state, getBlock: (x, y, z) => blocks.get(`${x},${y},${z}`) ?? stone(), getWorldRevision: () => revision, now: () => 1000, clock: () => 0 }
  return { state, target, blocks, input, revision: value => { revision = value }, run: options => proveGroundAccess({ ...input, ...options }) }
}

test('only a fully received closed dry walking component proves the lower zombie cannot reach the bot', () => {
  const f = scene(), before = JSON.stringify([f.state, f.target])
  const proof = f.run()
  assert.equal(proof.status, 'BLOCKED', JSON.stringify(proof))
  assert.equal(proof.routeToBot, false)
  assert.equal(proof.unknownTouched, false)
  assert.equal(proof.boundaryTouched, false)
  assert.equal(proof.truncated, false)
  assert.equal(isCurrentBlockedGroundProof(proof, f.target, f.state, 1100), true)
  assert.equal(JSON.stringify([f.state, f.target]), before)
})

test('unknown, wet, dynamic and partially modeled cells never prove a negative route', () => {
  for (const block of [
    { known: false },
    { known: true, name: 'minecraft:water', boundingBox: 'empty', extra: [] },
    { known: true, name: 'minecraft:gravel', boundingBox: 'block', extra: [] },
    { known: true, name: 'minecraft:stone_slab', boundingBox: 'block', extra: [] },
    { ...stone(), shapes: [[0, 0, 0, 1, 0.5, 1]] },
    { ...stone(), extra: [{ name: 'minecraft:water' }] }
  ]) {
    const f = scene(); f.blocks.set('1,0,0', block)
    const proof = f.run()
    assert.equal(proof.status, 'UNKNOWN', JSON.stringify(block))
    assert.equal(proof.routeToBot, null)
    assert.equal(proof.unknownTouched, true)
    assert.equal(isCurrentBlockedGroundProof(proof, f.target, f.state, 1000), false)
  }
})

test('reachable routes and all exploration boundaries retain the threat', () => {
  const f = scene(); f.state.position = { x: 6.5, y: 1.62, z: 0.5 }
  for (let x = 0; x <= 6; x++) f.blocks.set(`${x},0,0`, air())
  assert.equal(f.run().status, 'REACHABLE')
  const open = (x, y, z) => y < 0 ? stone() : air()
  const boundary = f.run({ getBlock: open, radius: 1 })
  assert.equal(boundary.status, 'UNKNOWN'); assert.equal(boundary.boundaryTouched, true)
  const nodes = f.run({ getBlock: open, maxNodes: 1 })
  assert.equal(nodes.status, 'UNKNOWN'); assert.equal(nodes.truncated, true)
  const cells = f.run({ maxCells: 1 })
  assert.equal(cells.status, 'UNKNOWN'); assert.equal(cells.truncated, true)
  let clock = 0
  const timed = f.run({ clock: () => clock += 10, maxMs: 1 })
  assert.equal(timed.status, 'UNKNOWN'); assert.equal(timed.reason, 'TIME_LIMIT')
})

test('jumping across missing floor and climbing an open vertical shaft never prove a blocked route', () => {
  const gap = scene(); gap.state.position = { x: 6.5, y: 1.62, z: 0.5 }
  for (let x = 0; x <= 6; x++) gap.blocks.set(`${x},0,0`, air())
  for (const x of [2, 3]) gap.blocks.set(`${x},-1,0`, air())
  assert.equal(gap.run().status, 'REACHABLE', 'missing intermediate landing cells cannot hide a jump path')
  const shaft = scene()
  for (let y = 0; y <= 14; y++) shaft.blocks.set(`0,${y},0`, air())
  assert.equal(shaft.run().status, 'REACHABLE', 'the proof overapproximates even impossible climbing')
})

test('proofs expire on world, actor identity, exact position, bot pose, scope or life changes', () => {
  const f = scene(), proof = f.run()
  const changed = [
    [() => { f.state.worldRevision++ }],
    [() => { f.target.uniqueId = '-9' }],
    [() => { f.target.position.x += 0.01 }],
    [() => { f.state.position.z += 0.01 }],
    [() => { f.state.connectionId = 'new' }],
    [() => { f.state.lifecycle.deathId++ }]
  ]
  for (const [change] of changed) {
    const oldState = copy(f.state), oldTarget = copy(f.target)
    change(); assert.equal(isCurrentBlockedGroundProof(proof, f.target, f.state, 1000), false)
    Object.assign(f.state, oldState); Object.assign(f.target, oldTarget)
  }
  assert.equal(isCurrentBlockedGroundProof(proof, f.target, f.state, 1251), false)
  let reads = 0
  const revised = f.run({ getBlock: (...args) => { if (++reads === 2) f.revision(11); return f.input.getBlock(...args) } })
  assert.equal(revised.status, 'UNKNOWN'); assert.equal(revised.reason, 'WORLD_REVISION_CHANGED')
})

test('ranged, flying, climbing, teleporting, unknown and immediate actors cannot receive an exemption', () => {
  for (const type of ['minecraft:drowned', 'minecraft:skeleton', 'minecraft:phantom', 'minecraft:spider', 'minecraft:enderman', 'minecraft:unknown']) {
    const f = scene(); f.target.entityType = type
    assert.equal(f.run().status, 'UNKNOWN')
  }
  const close = scene(); close.target.position.y = 12
  assert.equal(close.run().reason, 'IMMEDIATE_RANGE')
  const primed = scene(); primed.target.primed = true
  assert.equal(primed.run().reason, 'ACTOR_NOT_SUPPORTED')
  const unknown = scene(); unknown.target.positionKnown = false
  assert.equal(unknown.run().status, 'UNKNOWN')
})
