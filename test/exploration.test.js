'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { knownStandpoints, rankExplorationTargets, rankRetreatTargets, createExploration } = require('../src/exploration')

function terrain ({ radius = 12, height = () => 64, unknown = () => false, replacement = () => null } = {}) {
  const blocks = []
  for (let x = -radius; x <= radius; x++) for (let z = -radius; z <= radius; z++) {
    const y = height(x, z)
    for (let dy = 0; dy <= 2; dy++) {
      const position = { x, y: y + dy, z }
      blocks.push(replacement(position, dy) ?? (unknown(position, dy) ? { known: false, position, name: null } : { known: true, position, name: dy === 0 ? 'minecraft:grass_block' : 'minecraft:air', boundingBox: dy === 0 ? 'block' : 'empty', extra: [] }))
    }
  }
  return { center: { x: 0, y: 65, z: 0 }, radius, blocks, coverage: { expected: blocks.length, known: blocks.filter(block => block.known).length } }
}

function state () {
  return { profile: 'bot', realm: { id: 'realm' }, dimension: 'overworld', position: { x: 0.5, y: 66.62, z: 0.5 }, rotation: { yaw: 0, pitch: 0 } }
}

test('exploration endpoints use received regular support and clear body cells in the eight-to-eleven-block band', () => {
  const snapshot = state()
  const observations = terrain()
  const before = structuredClone(observations)
  const targets = rankExplorationTargets(snapshot, observations, { resource: 'logs' })
  assert.ok(targets.length > 0 && targets.length <= 20)
  for (const target of targets) {
    assert.ok(target.distance >= 8 && target.distance <= 11)
    assert.equal(target.position.y, 65)
    assert.equal(target.resource, 'logs')
  }
  assert.ok(targets[0].position.z > 0.5, 'symmetric terrain should prefer continuing the current heading')
  const changedSector = rankExplorationTargets(snapshot, observations, { resource: 'logs', attempt: 2 })
  assert.notDeepEqual(changedSector[0].position, targets[0].position)
  assert.deepEqual(observations, before)
})

test('unknown terrain, missing headroom, liquids and nonstandard support never become standpoints', () => {
  const valid = { x: 8, y: 64, z: 0 }
  const observations = { blocks: [
    { known: false, position: valid, name: 'minecraft:grass_block', boundingBox: 'block', extra: [] },
    { known: true, position: { x: 8, y: 65, z: 0 }, name: 'minecraft:air', boundingBox: 'empty', extra: [] },
    { known: true, position: { x: 8, y: 66, z: 0 }, name: 'minecraft:air', boundingBox: 'empty', extra: [] }
  ] }
  assert.equal(knownStandpoints(state(), observations).length, 0)
  observations.blocks[0].known = true
  assert.equal(knownStandpoints(state(), observations).length, 1)
  observations.blocks[2].name = 'minecraft:stone'
  observations.blocks[2].boundingBox = 'block'
  assert.equal(knownStandpoints(state(), observations).length, 0)
  observations.blocks[2].name = 'minecraft:air'; observations.blocks[2].boundingBox = 'empty'
  observations.blocks[1].name = 'minecraft:water'
  assert.equal(knownStandpoints(state(), observations).length, 0)
  observations.blocks[1].name = 'minecraft:air'
  observations.blocks[0].name = 'minecraft:gravel'
  assert.equal(knownStandpoints(state(), observations).length, 0)
  assert.equal(rankExplorationTargets(state(), { blocks: [] }).length, 0)
})

test('terrain height rather than current player height defines destinations, while excessive height changes are excluded', () => {
  const observations = terrain({ height: (x, z) => x >= 8 ? 66 : 64 })
  const targets = knownStandpoints(state(), observations, { minDistance: 8, maxDistance: 11, maxHeightDelta: 3, limit: 1000 })
  const uphill = targets.find(target => target.position.x >= 8.5)
  assert.ok(uphill)
  assert.equal(uphill.position.y, 67)
  const high = terrain({ height: () => 70 })
  assert.equal(rankExplorationTargets(state(), high).length, 0)
})

test('recent attempts, visits and origins avoid cycling; history is bounded and scoped to realm and dimension', () => {
  let time = 1000
  const memory = createExploration({ historyLimit: 4, historyTtlMs: 5000, clock: () => time })
  const snapshot = state()
  const observations = terrain()
  const first = memory.candidates(snapshot, observations)[0]
  memory.remember(snapshot, first.position, { kind: 'blocked', resource: 'logs' })
  const next = memory.candidates(snapshot, observations)[0]
  assert.ok(Math.hypot(next.position.x - first.position.x, next.position.z - first.position.z) >= 1.5)
  for (let i = 0; i < 8; i++) memory.remember(snapshot, { x: i * 3, y: 65, z: -8 }, { kind: 'visited', serverConfirmed: false })
  assert.equal(memory.snapshot().history.length, 4)
  const detached = memory.snapshot(); detached.history[0].position.x = -999
  assert.notEqual(memory.snapshot().history[0].position.x, -999)
  memory.candidates({ ...snapshot, dimension: 'nether' }, observations)
  assert.equal(memory.snapshot().history.length, 0)
  memory.remember(snapshot, first.position, { kind: 'visited' })
  time += 6000
  memory.candidates(snapshot, observations)
  assert.equal(memory.snapshot().history.length, 0)
})

test('retreat endpoints increase enemy distance and use known hillside support heights', () => {
  const observations = terrain({ height: x => x <= -3 ? 65 : 64 })
  const threats = [{ hostile: true, position: { x: 2.5, y: 65, z: 0.5 } }]
  const candidates = rankRetreatTargets(state(), observations, threats)
  assert.ok(candidates.length > 0 && candidates.length <= 20)
  assert.ok(candidates[0].position.x < 0.5)
  assert.equal(candidates[0].position.y, 66)
  assert.ok(candidates.every(candidate => candidate.threatDistanceGain >= 0.5 && candidate.distance >= 3 && candidate.distance <= 6))
  assert.equal(rankRetreatTargets(state(), { blocks: [] }, threats).length, 0)
})


// Sanitized 25 x 16 x 25 received-block fixture from the stranded river bank.
// Only terrain and observer coordinates are retained; the test never reads .local.
function strandedBankFixture () {
  const types = ["minecraft:dirt|block","minecraft:stone|block","minecraft:clay|block","minecraft:copper_ore|block","minecraft:water|empty","minecraft:grass_block|block","minecraft:air|empty","minecraft:short_grass|empty","minecraft:tall_grass|empty","minecraft:coal_ore|block","minecraft:granite|block","minecraft:gravel|block","minecraft:sand|block","minecraft:poppy|empty"]
  const runs = '0:4 1:21 2:2 0:5 1:18 2:2 0:6 3:2 1:15 4:4 5:3 0:1 3:3 1:14 6:7 5:1 0:1 1:14 0:2 6:7 7:1 0:2 1:13 5:2 6:8 5:1 0:1 1:12 0:1 6:11 5:1 0:3 1:9 5:1 6:12 0:6 1:6 6:13 5:4 0:8 6:13 7:2 6:2 5:10 6:18 8:1 7:3 6:1 7:2 6:18 8:1 6:82 0:6 1:19 2:1 0:7 1:17 2:1 0:7 1:17 4:6 5:2 0:1 1:16 6:8 0:1 1:16 6:8 5:1 0:1 1:15 6:9 0:2 1:11 0:3 6:9 5:1 0:4 1:8 5:3 6:10 5:1 0:3 1:7 0:1 6:1 7:1 6:12 5:3 0:7 5:1 6:17 5:7 7:1 6:17 7:1 6:2 7:2 6:1 7:1 6:104 0:7 1:18 2:1 0:7 1:17 2:1 0:8 1:16 4:7 5:1 0:1 1:16 6:8 5:1 0:1 1:15 6:9 0:2 1:14 6:9 5:1 0:2 1:12 9:1 6:10 5:1 0:3 1:8 0:2 9:1 6:11 5:1 0:2 1:4 0:1 1:2 0:1 5:2 0:1 6:11 7:1 5:2 0:7 5:1 6:2 5:1 6:14 5:7 6:18 7:2 6:1 7:1 6:1 8:1 6:24 8:1 6:80 0:8 1:17 0:7 2:1 0:1 1:16 0:7 2:1 0:1 1:16 4:8 5:1 0:1 1:15 6:9 0:2 1:14 6:9 5:1 0:2 1:13 6:9 7:1 5:1 0:2 1:12 6:10 7:1 5:1 0:3 1:10 6:12 5:1 0:3 1:2 0:7 6:13 5:4 0:3 5:5 6:13 7:1 6:1 8:1 6:1 5:3 7:1 6:19 8:1 6:109 0:8 1:17 0:5 2:4 1:16 0:5 2:5 1:15 4:8 5:1 2:1 0:1 1:14 6:8 7:1 5:1 0:1 1:14 6:10 5:1 0:1 1:13 6:11 0:3 1:11 6:11 5:1 0:9 1:2 0:2 6:11 7:1 5:2 0:9 5:2 6:14 5:9 6:18 8:1 6:1 7:1 6:1 7:1 6:1 7:1 6:18 8:1 6:108 0:9 10:1 1:6 3:2 1:7 0:2 11:1 0:2 2:5 1:15 0:2 11:1 0:2 2:1 4:1 2:3 0:1 1:14 4:9 5:1 0:1 1:14 6:10 5:1 0:1 1:13 6:11 0:2 1:12 6:11 5:1 0:2 1:7 0:2 1:1 0:1 6:12 5:1 0:12 6:13 5:1 0:7 5:4 6:14 5:7 6:2 8:1 7:1 6:18 8:1 7:1 6:3 8:1 6:19 8:1 6:106 1:1 0:8 10:2 1:5 3:2 1:7 11:4 2:6 1:7 3:1 1:7 11:4 2:1 4:3 2:3 1:14 11:1 4:8 5:1 2:1 0:1 1:13 6:9 7:1 5:1 0:2 1:12 6:11 5:1 0:2 1:9 0:2 6:11 7:1 5:1 0:12 6:13 5:1 0:9 5:2 6:14 5:3 0:1 5:5 6:16 7:2 6:2 7:1 6:156 1:1 0:9 10:1 1:14 11:5 2:1 4:1 2:3 0:1 1:14 11:5 4:3 2:2 0:2 1:13 11:1 4:9 5:1 0:1 1:13 7:1 6:10 5:1 0:1 1:11 0:1 6:12 0:2 1:6 0:5 6:12 5:1 0:11 5:1 6:13 5:1 0:6 5:4 6:15 5:6 6:23 8:1 6:24 8:1 6:131 0:6 4:1 0:3 1:5 11:1 1:9 11:5 4:3 2:2 12:2 1:13 11:4 4:5 2:1 12:2 1:13 4:10 12:3 1:10 0:2 6:12 12:2 1:8 0:3 6:12 5:1 0:10 5:2 6:13 5:1 0:8 5:1 6:15 7:1 5:8 6:22 13:1 6:180 0:6 4:2 0:1 12:2 1:2 11:3 1:6 0:2 4:1 11:4 4:5 12:3 1:11 0:1 4:1 11:3 4:7 12:3 1:10 0:1 4:12 12:3 1:8 0:1 4:2 6:12 12:2 1:5 0:4 6:15 5:1 0:8 5:1 6:16 0:5 5:3 7:1 6:16 5:5 6:1 7:2 6:18 7:1 6:184 0:5 4:3 0:1 12:4 11:3 1:6 0:1 4:2 11:3 4:6 12:4 1:9 0:1 4:13 12:3 1:7 0:2 4:14 12:3 1:4 0:4 4:2 6:13 12:5 0:4 5:1 6:15 5:1 0:5 5:3 7:1 6:16 5:5 7:1 6:1 7:1 6:18 7:2 6:208 0:4 4:5 12:5 11:2 1:4 0:3 4:2 0:2 4:8 12:4 1:6 0:3 4:15 12:2 1:1 12:1 1:2 0:2 4:17 12:5 0:2 4:5 6:14 12:4 0:1 5:1 6:19 5:5 7:1 6:19 7:1 6:2 7:2 6:231 0:1 4:9 12:4 11:2 12:3 0:1 12:1 0:1 4:15 12:7 0:1 4:19 12:5 4:20 12:3 4:8 6:14 12:2 6:24 7:1 6:259 4:12 12:6 0:1 12:1 4:18 12:5 4:21 12:2 4:34 6:300 4:13 12:6 4:20 12:3 4:58 6:300 4:14 12:4 4:21 12:1 4:60 6:300 4:100 6:300 4:100 6:300 4:100 6:300 4:100 6:300 4:100 6:300 4:100 6:300 4:100 6:300 4:100 6:300 4:100 6:300'.split(' ').map(value => value.split(':').map(Number))
  const indices = runs.flatMap(([type, count]) => Array(count).fill(type))
  let index = 0
  const blocks = []
  for (let x = -3; x <= 21; x++) for (let y = 59; y <= 74; y++) for (let z = -14; z <= 10; z++) {
    const [name, boundingBox] = types[indices[index++]].split('|')
    blocks.push({ known: true, name, boundingBox, extra: [], position: { x, y, z } })
  }
  assert.equal(index, indices.length)
  return {
    state: { ...state(), position: {"x":9.269323348999023,"y":64.25498664561462,"z":-1.8536235094070432} },
    observations: { blocks, center: {"x":9,"y":62,"z":-2}, radius: 12 }
  }
}

test('the saved ten-thousand-block bank finds a short land endpoint after its outer ring is exhausted', () => {
  const fixture = strandedBankFixture()
  const { observations, state: snapshot } = fixture
  const before = structuredClone(fixture)
  assert.equal(observations.blocks.length, 10000)
  const outer = knownStandpoints(snapshot, observations, { minDistance: 8, maxDistance: 11, maxHeightDelta: 3, limit: 1000 })
  assert.equal(outer.length, 7)
  const history = outer.map(candidate => ({ kind: 'blocked', position: candidate.position }))
  history.push({ kind: 'origin', position: { ...snapshot.position, y: snapshot.position.y - 1.62 } })
  const targets = rankExplorationTargets(snapshot, observations, { history, resource: 'logs' })
  assert.ok(targets.length > 0 && targets.length <= 20)
  assert.equal(targets[0].mode, 'intermediate')
  assert.ok(targets[0].heightDelta > 1)
  for (const target of targets) {
    assert.ok(target.distance >= 2 && target.distance <= 6)
    assert.equal(target.requiresLivePreview, true)
    assert.equal(target.resource, 'logs')
    assert.ok(!history.some(entry => entry.kind === 'blocked' && Math.hypot(entry.position.x - target.position.x, entry.position.z - target.position.z) < 1.5 && Math.abs(entry.position.y - target.position.y) < 0.75))
  }
  assert.deepEqual(fixture, before)
})

test('nearby fallback favours a known uphill step and retains unknown and liquid rejection', () => {
  const observations = terrain({ radius: 3, height: x => 64 + Math.max(0, x) })
  const targets = rankExplorationTargets(state(), observations)
  assert.ok(targets.length > 0)
  assert.equal(targets[0].mode, 'intermediate')
  assert.ok(targets[0].heightDelta >= 1)
  const small = { blocks: [
    { known: true, position: { x: 3, y: 64, z: 0 }, name: 'minecraft:grass_block', boundingBox: 'block', extra: [] },
    { known: true, position: { x: 3, y: 65, z: 0 }, name: 'minecraft:air', boundingBox: 'empty', extra: [] },
    { known: true, position: { x: 3, y: 66, z: 0 }, name: 'minecraft:air', boundingBox: 'empty', extra: [] }
  ] }
  assert.equal(rankExplorationTargets(state(), small).length, 1)
  small.blocks[2].known = false
  assert.deepEqual(rankExplorationTargets(state(), small), [])
  small.blocks[2].known = true
  small.blocks[0].name = 'minecraft:water'
  assert.deepEqual(rankExplorationTargets(state(), small), [])
  assert.deepEqual(rankExplorationTargets(state(), null), [])
})

function transitScene () {
  const a = { x: 0.5, y: 65, z: 0.5 }
  const b = { x: 3.5, y: 67, z: 0.5 }
  const c = { x: 6.5, y: 69, z: 0.5 }
  const blocks = [a, b, c].flatMap(point => [0, 1, 2].map(level => ({ known: true, position: { x: Math.floor(point.x), y: point.y - 1 + level, z: Math.floor(point.z) }, name: level === 0 ? 'minecraft:grass_block' : 'minecraft:air', boundingBox: level === 0 ? 'block' : 'empty', extra: [] })))
  return { a, b, c, observations: { blocks }, snapshot: state() }
}

test('a required visited transit is allowed once toward a new higher endpoint, then cannot bounce back indefinitely', () => {
  const { a, b, c, observations, snapshot } = transitScene()
  const memory = createExploration()
  memory.remember(snapshot, b, { kind: 'visited', from: a })
  memory.remember(snapshot, a, { kind: 'visited', from: b })
  const transit = memory.candidates(snapshot, observations)[0]
  assert.deepEqual(transit.position, b)
  assert.equal(transit.mode, 'transit')
  assert.deepEqual(transit.onward, c)
  memory.remember(snapshot, b, { kind: 'attempt' })
  memory.remember(snapshot, { ...b, x: b.x + 0.25 }, { kind: 'visited', from: a })
  assert.equal(memory.snapshot().transitRevisits, 1, 'normal movement stop drift cannot reset a cell visit counter')
  const atB = { ...snapshot, position: { ...b, y: b.y + 1.62 } }
  assert.deepEqual(memory.candidates(atB, observations)[0].position, c)
  assert.deepEqual(memory.candidates(snapshot, observations), [], 'a third visit of the same middle cell is forbidden')
  observations.blocks = observations.blocks.filter(block => block.position.x !== Math.floor(c.x))
  const fresh = createExploration()
  fresh.remember(snapshot, b, { kind: 'visited', from: a })
  fresh.remember(snapshot, a, { kind: 'visited', from: b })
  assert.deepEqual(fresh.candidates(snapshot, observations), [], 'A-to-B reversal without a known unvisited onward endpoint is not progress')
})

test('the global transit budget survives history pruning and blocks more revisits after four returns', () => {
  const { a, b, observations, snapshot } = transitScene()
  const memory = createExploration({ historyLimit: 4 })
  for (let index = 0; index < 4; index++) {
    const point = { x: 20.5 + index * 3, y: 65, z: -8.5 }
    memory.remember(snapshot, point, { kind: 'visited' })
    memory.remember(snapshot, point, { kind: 'attempt' })
    memory.remember(snapshot, { ...point, x: point.x + 0.25 }, { kind: 'visited' })
  }
  memory.remember(snapshot, b, { kind: 'visited', from: a })
  memory.remember(snapshot, a, { kind: 'visited', from: b })
  assert.equal(memory.snapshot().transitRevisits, 4)
  assert.ok(memory.snapshot().history.length <= 4)
  assert.deepEqual(memory.candidates(snapshot, observations), [])
  memory.candidates({ ...snapshot, dimension: 'nether' }, observations)
  assert.equal(memory.snapshot().transitRevisits, 0)
})
