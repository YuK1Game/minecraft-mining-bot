'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const reach = require('../src/threat-reachability')
const { evaluateThreats } = require('../src/threats')

// Flat stone floor at y=63 with air above; `walls` adds solid cells.
function world ({ walls = () => false, unknown = () => false } = {}) {
  return { getBlock: (x, y, z) => unknown(x, y, z) ? { known: false } : y <= 63 || walls(x, y, z) ? { known: true, name: 'minecraft:stone', boundingBox: 'block', extra: [] } : { known: true, name: 'minecraft:air', boundingBox: 'empty', extra: [] } }
}
// A sealed 1x1 pit around the bot at x=0,z=0 (feet y=64).
const pit = (x, y, z) => y >= 64 && y <= 66 && (Math.abs(x) === 1 && Math.abs(z) <= 1 || Math.abs(z) === 1 && Math.abs(x) <= 1) || y === 66 && x === 0 && z === 0
const state = { phase: 'spawned', dimension: 'overworld', position: { x: 0.5, y: 65.62, z: 0.5 }, threatPolicy: 'online_learning', health: 20, runtimeEntityId: '1' }
const skeleton = (id, x, z) => ({ runtimeId: id, kind: 'mob', entityType: 'minecraft:skeleton', hostile: true, alive: true, positionKnown: true, dimension: 'overworld', position: { x, y: 64, z } })

test('in a sealed pit a hostile has no walk route: not a threat and not engageable', () => {
  reach.clear()
  const actor = skeleton('23', 12.5, 0.5)
  assert.equal(evaluateThreats(state, [actor]).threats.length, 1)
  reach.refresh(state, [actor], { world: world({ walls: pit }), now: 1000 })
  const e = evaluateThreats(state, [actor], { now: () => 1500 })
  assert.equal(e.threats.length, 0); assert.equal(e.unreachable[0].unreachableNow, true); assert.equal(e.suppressedByTerrain.length, 0); assert.equal(e.outsideDanger.length, 0)
  assert.equal(reach.knownReachable(state, actor, 1500), false)
})

test('on open ground a hostile within two chunks is reachable and stays a threat', () => {
  reach.clear()
  const near = skeleton('30', 12.5, 0.5)
  reach.refresh(state, [near], { world: world(), now: 1000 })
  assert.equal(reach.knownReachable(state, near, 1200), true)
  assert.equal(evaluateThreats(state, [near], { now: () => 1200 }).threats.length, 1)
})

test('stale, region-leaving or out-of-radius evidence stays unknown; moving within the region keeps it', () => {
  reach.clear()
  const actor = skeleton('24', 12.5, 0.5); const far = skeleton('31', 40.5, 0.5)
  reach.refresh(state, [actor, far], { world: world({ walls: pit }), now: 1000 })
  assert.equal(evaluateThreats(state, [actor], { now: () => 5000 }).threats.length, 1)
  assert.equal(evaluateThreats({ ...state, position: { ...state.position, x: 5.5 } }, [actor], { now: () => 1500 }).threats.length, 1)
  assert.equal(evaluateThreats({ ...state, position: { ...state.position, x: 0.9 } }, [actor], { now: () => 1500 }).threats.length, 0)
  assert.equal(evaluateThreats(state, [{ ...actor, position: { ...actor.position, x: 14.5 } }], { now: () => 1500 }).threats.length, 0)
  assert.equal(reach.knownReachable(state, far, 1200), false); assert.equal(reach.knownUnreachable(state, far, 1200), false)
})

test('refresh is throttled so repeated state reads do not re-run the search', () => {
  reach.clear()
  let reads = 0; const w = world(); const counted = { getBlock: (...a) => { reads++; return w.getBlock(...a) } }
  reach.refresh(state, [skeleton('40', 12.5, 0.5)], { world: counted, now: 1000 }); const first = reads
  reach.refresh(state, [skeleton('40', 12.5, 0.5)], { world: counted, now: 1100 })
  assert.ok(first > 0); assert.equal(reads, first)
})


test('a creeper is never suppressed as unreachable: it keeps normal danger evaluation', () => {
  reach.clear()
  const creeper = { ...skeleton('50', 5.5, 0.5), entityType: 'minecraft:creeper' }
  reach.refresh(state, [creeper], { world: world({ walls: pit }), now: 1000 })
  assert.equal(reach.knownUnreachable(state, creeper, 1500), true)
  const e = evaluateThreats(state, [creeper], { now: () => 1500 })
  assert.equal(e.threats.length, 1); assert.equal(e.unreachable.length, 0)
})

test('targeted seek reaches a hostile on open ground, reports false when walled off, null on budget', () => {
  const { seekCells } = require('../src/threat-reachability')
  const flat = { getBlock: (x, y, z) => y < 64 ? { known: true, name: 'minecraft:stone', boundingBox: 'block' } : { known: true, name: 'minecraft:air', boundingBox: 'empty' } }
  assert.equal(seekCells(flat, { x: 0.5, y: 64, z: 0.5 }, { x: 20.5, y: 64, z: 3.5 }), true)
  // a pit: the bot stands at the bottom of a 3-deep shaft with no exit
  const pit = { getBlock: (x, y, z) => {
    const inside = x === 0 && z === 0
    if (y < 61) return { known: true, name: 'minecraft:stone', boundingBox: 'block' }
    if (y < 64) return inside ? { known: true, name: 'minecraft:air', boundingBox: 'empty' } : { known: true, name: 'minecraft:stone', boundingBox: 'block' }
    return { known: true, name: 'minecraft:air', boundingBox: 'empty' }
  } }
  assert.equal(seekCells(pit, { x: 0.5, y: 61, z: 0.5 }, { x: 10.5, y: 64, z: 0.5 }), false)
  assert.equal(seekCells(flat, { x: 0.5, y: 64, z: 0.5 }, { x: 30.5, y: 64, z: 0.5 }, { maxNodes: 5 }), null)
})
