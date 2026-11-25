'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const reach = require('../src/combat/threat-reachability')
const { evaluateThreats } = require('../src/combat/threats')
const { createCombatSearchBudget } = require('../src/combat/combat-search-budget')
const { setImmediate: turn } = require('node:timers/promises')

// Advance independent scheduler windows without waiting for real 50ms ticks.
// Each real search slice still retains its normal eight-millisecond bound.
async function completeRefresh (state, entities, options) {
  let offset = 0
  const budget = createCombatSearchBudget({ clock: () => performance.now() + offset })
  for (let attempt = 0; attempt < 100; attempt++) {
    reach.refresh(state, entities, { ...options, budget })
    if (!reach.snapshot()?.pending) return
    offset += 50
    await turn()
  }
  assert.fail('Reachability continuation did not finish within its bounded node searches')
}

// Flat stone floor at y=63 with air above; `walls` adds solid cells.
function world ({ walls = () => false, unknown = () => false } = {}) {
  return { getBlock: (x, y, z) => unknown(x, y, z) ? { known: false } : y <= 63 || walls(x, y, z) ? { known: true, name: 'minecraft:stone', boundingBox: 'block', extra: [] } : { known: true, name: 'minecraft:air', boundingBox: 'empty', extra: [] } }
}
// A sealed 1x1 pit around the bot at x=0,z=0 (feet y=64).
const pit = (x, y, z) => y >= 64 && y <= 66 && (Math.abs(x) === 1 && Math.abs(z) <= 1 || Math.abs(z) === 1 && Math.abs(x) <= 1) || y === 66 && x === 0 && z === 0
const state = { phase: 'spawned', dimension: 'overworld', position: { x: 0.5, y: 65.62, z: 0.5 }, threatPolicy: 'online_learning', health: 20, runtimeEntityId: '1' }
const skeleton = (id, x, z) => ({ runtimeId: id, kind: 'mob', entityType: 'minecraft:skeleton', hostile: true, alive: true, positionKnown: true, dimension: 'overworld', position: { x, y: 64, z } })

test('in a sealed pit a hostile has no walk route: not a threat and not engageable', async () => {
  reach.clear()
  const actor = skeleton('23', 12.5, 0.5)
  assert.equal(evaluateThreats(state, [actor]).threats.length, 1)
  await completeRefresh(state, [actor], { world: world({ walls: pit }), now: 1000 })
  const e = evaluateThreats(state, [actor], { now: () => 1500 })
  assert.equal(e.threats.length, 0); assert.equal(e.unreachable[0].unreachableNow, true); assert.equal(e.suppressedByTerrain.length, 0); assert.equal(e.outsideDanger.length, 0)
  assert.equal(reach.knownReachable(state, actor, 1500), false)
})

test('on open ground a hostile within two chunks is reachable and stays a threat', async () => {
  reach.clear()
  const near = skeleton('30', 12.5, 0.5)
  await completeRefresh(state, [near], { world: world(), now: 1000 })
  assert.equal(reach.knownReachable(state, near, 1200), true)
  assert.equal(evaluateThreats(state, [near], { now: () => 1200 }).threats.length, 1)
})

test('stale, region-leaving or out-of-radius evidence stays unknown; moving within the region keeps it', async () => {
  reach.clear()
  const actor = skeleton('24', 12.5, 0.5); const far = skeleton('31', 40.5, 0.5)
  await completeRefresh(state, [actor, far], { world: world({ walls: pit }), now: 1000 })
  assert.equal(evaluateThreats(state, [actor], { now: () => 5000 }).threats.length, 1)
  assert.equal(evaluateThreats({ ...state, position: { ...state.position, x: 5.5 } }, [actor], { now: () => 1500 }).threats.length, 1)
  assert.equal(evaluateThreats({ ...state, position: { ...state.position, x: 0.9 } }, [actor], { now: () => 1500 }).threats.length, 0)
  assert.equal(evaluateThreats(state, [{ ...actor, position: { ...actor.position, x: 14.5 } }], { now: () => 1500 }).threats.length, 0)
  assert.equal(reach.knownReachable(state, far, 1200), false); assert.equal(reach.knownUnreachable(state, far, 1200), false)
})

test('refresh is throttled so repeated state reads do not re-run the search', async () => {
  reach.clear()
  let reads = 0; const w = world(); const counted = { getBlock: (...a) => { reads++; return w.getBlock(...a) } }
  await completeRefresh(state, [skeleton('40', 12.5, 0.5)], { world: counted, now: 1000 }); const first = reads
  await completeRefresh(state, [skeleton('40', 12.5, 0.5)], { world: counted, now: 1100 })
  assert.ok(first > 0); assert.equal(reads, first)
})


test('a creeper is never suppressed as unreachable: it keeps normal danger evaluation', async () => {
  reach.clear()
  const creeper = { ...skeleton('50', 5.5, 0.5), entityType: 'minecraft:creeper' }
  await completeRefresh(state, [creeper], { world: world({ walls: pit }), now: 1000 })
  assert.equal(reach.knownUnreachable(state, creeper, 1500), true)
  const e = evaluateThreats(state, [creeper], { now: () => 1500 })
  assert.equal(e.threats.length, 1); assert.equal(e.unreachable.length, 0)
})

test('targeted seek reaches a hostile on open ground, reports false when walled off, null on budget', async () => {
  const { seekCells } = require('../src/combat/threat-reachability')
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

// Live 2026-11-16: bot on grass at y=68 (feet 69), a drowned at the bottom of
// a dry 1x1 shaft six deep, 6.8 m away; elsewhere in the disk a block was not
// received, so the fill from the bot stayed "unknown".
test('a hostile at the bottom of a deep shaft is shut in even when the disk has unreceived blocks', async () => {
  const shaft = (x, y, z) => !(x === -5 && z === 4 && y >= 64)
  const terrain = unknown => ({ getBlock: (x, y, z) => unknown(x, y, z) ? { known: false } : y <= 63 || y <= 68 && shaft(x, y, z) ? { known: true, name: 'minecraft:stone', boundingBox: 'block', extra: [] } : { known: true, name: 'minecraft:air', boundingBox: 'empty', extra: [] } })
  const far = (x, y, z) => x === 20 && z === 0 && y === 68
  const bot = { phase: 'spawned', dimension: 'overworld', position: { x: 0.5, y: 70.62, z: 0.5 }, threatPolicy: 'balanced_mining', health: 2, runtimeEntityId: '1' }
  const drowned = (x, y, z) => ({ runtimeId: '11237', kind: 'mob', entityType: 'minecraft:drowned', hostile: true, alive: true, positionKnown: true, dimension: 'overworld', position: { x, y, z } })
  const actor = drowned(-4.5, 63.9999, 4.5)
  // The fills are bounded by their cell counts; their wall-clock bounds (a few ms) are lifted
  // here, where a loaded machine running cold code can pass them (CI 2026-11-19: this test
  // failed twice in a row beside another test file, on a pull request that did not touch this
  // module, and passed alone on the base).
  const calm = { fillMs: 5000, pitMs: 5000 }
  reach.clear()
  await completeRefresh(bot, [actor], { world: terrain(far), now: 1000, ...calm })
  assert.equal(reach.snapshot().unknownTouched, true)
  assert.equal(reach.knownUnreachable(bot, actor, 1200), true)
  const e = evaluateThreats(bot, [actor], { now: () => 1200 })
  assert.equal(e.threats.length, 0); assert.equal(e.unreachable[0].unreachableNow, true)
  // It climbed out (moved more than 3 m): the old answer is not reused.
  assert.equal(reach.knownUnreachable(bot, drowned(-1.5, 69, 4.5), 1200), false)
  // An unreceived block in the shaft wall: no evidence.
  reach.clear()
  await completeRefresh(bot, [actor], { world: terrain((x, y, z) => far(x, y, z) || x === -6 && z === 4 && y === 65), now: 1000, ...calm })
  assert.equal(reach.knownUnreachable(bot, actor, 1200), false)
  // On open ground at the bot's level, or in a hole only two deep: no evidence.
  assert.equal(reach.shutIn(terrain(() => false), { x: 5.5, y: 69, z: 0.5 }, { x: 0.5, y: 69, z: 0.5 }), null)
  const shallow = { getBlock: (x, y, z) => y <= 66 || y <= 68 && !(x === -5 && z === 4) ? { known: true, name: 'minecraft:stone', boundingBox: 'block', extra: [] } : { known: true, name: 'minecraft:air', boundingBox: 'empty', extra: [] } }
  assert.equal(reach.shutIn(shallow, { x: -4.5, y: 67, z: 4.5 }, { x: 0.5, y: 69, z: 0.5 }), null)
  assert.equal(reach.shutIn(terrain(() => false), { x: -4.5, y: 64, z: 4.5 }, { x: 0.5, y: 69, z: 0.5 }, { maxMs: 1000 }), true)
})

test('a melee walker in a long cave tunnel >=4 blocks below the bot is unreachable when all cells within 10m stay deep; skeletons, stairs, or unknown blocks stay unknown', async () => {
  // Surface floor at y=63 (feet 64); a 1-wide cave tunnel running along x=-30..30 at z=6, y=58..59 (floor y=57, 6 below bot).
  // Far surface cell unreceived so the surface flood fill stays unknown.
  const makeCave = ({ stairs = false, unknownAt = () => false } = {}) => ({
    getBlock: (x, y, z) => {
      if (unknownAt(x, y, z)) return { known: false }
      if (x === 22 && z === 0 && y === 64) return { known: false }
      const inTunnel = z === 6 && x >= -30 && x <= 30 && (y === 58 || y === 59)
      const stairFloor = stairs && z === 6 && x >= 5 && x <= 9 ? 57 + (x - 4) : null
      if (stairs && z === 6 && x === 4 && y === 60) return { known: true, name: 'minecraft:air', boundingBox: 'empty', extra: [] }
      if (stairFloor !== null) {
        if (y <= stairFloor) return { known: true, name: 'minecraft:stone', boundingBox: 'block', extra: [] }
        if (y <= stairFloor + 3) return { known: true, name: 'minecraft:air', boundingBox: 'empty', extra: [] }
      }
      if (inTunnel) return { known: true, name: 'minecraft:air', boundingBox: 'empty', extra: [] }
      if (y <= 63) return { known: true, name: 'minecraft:stone', boundingBox: 'block', extra: [] }
      return { known: true, name: 'minecraft:air', boundingBox: 'empty', extra: [] }
    }
  })
  const bot = { phase: 'spawned', dimension: 'overworld', position: { x: 0.5, y: 65.62, z: 0.5 }, threatPolicy: 'balanced_mining', health: 20, runtimeEntityId: '1' }
  const mob = (id, entityType) => ({ runtimeId: id, kind: 'mob', entityType, hostile: true, alive: true, positionKnown: true, dimension: 'overworld', position: { x: 0.5, y: 58, z: 6.5 } })
  const calm = { fillMs: 5000, pitMs: 5000 }
  const zombie = mob('901', 'minecraft:zombie')
  const archer = mob('902', 'minecraft:skeleton')
  const creeper = mob('903', 'minecraft:creeper')

  // Long cave tunnel (> PIT_RADIUS): shutIn returns null, undergroundWalker proves the zombie unreachable, while skeleton stays unknown.
  reach.clear()
  const cave = makeCave()
  assert.equal(reach.shutIn(cave, zombie.position, { x: 0.5, y: 64, z: 0.5 }, { maxMs: 1000 }), null)
  await completeRefresh(bot, [zombie, archer, creeper], { world: cave, now: 1000, ...calm })
  assert.equal(reach.knownUnreachable(bot, zombie, 1200), true)
  assert.equal(reach.knownUnreachable(bot, archer, 1200), false)
  assert.equal(reach.knownUnreachable(bot, creeper, 1200), false)

  // Stairs rising above botFeet.y - 4 within 10 m: zombie is NOT marked unreachable.
  reach.clear()
  await completeRefresh(bot, [zombie], { world: makeCave({ stairs: true }), now: 1000, ...calm })
  assert.equal(reach.knownUnreachable(bot, zombie, 1200), false)

  // An unreceived block inside the 10 m cave tunnel: conservative unknown.
  reach.clear()
  await completeRefresh(bot, [zombie], { world: makeCave({ unknownAt: (x, y, z) => x === 4 && y === 58 && z === 6 }), now: 1000, ...calm })
  assert.equal(reach.knownUnreachable(bot, zombie, 1200), false)

  // Live 2026-11-25 04:52-05:08 JST: a stepped pit (drop 3 from y=64 to y=61, then drop 2 to y=59)
  // lets the bot's flood fill drop in (asymmetric MAX_DROP=3 vs step-up=1), yet the zombie cannot
  // climb back out to the bot. It must be proven unreachable rather than blocking work forever.
  const steppedPit = {
    getBlock: (x, y, z) => {
      if (x === 4 && z === 0) return y <= 60 ? { known: true, name: 'minecraft:stone', boundingBox: 'block', extra: [] } : { known: true, name: 'minecraft:air', boundingBox: 'empty', extra: [] }
      if (x === 5 && z === 0) return y <= 58 ? { known: true, name: 'minecraft:stone', boundingBox: 'block', extra: [] } : { known: true, name: 'minecraft:air', boundingBox: 'empty', extra: [] }
      return y <= 63 ? { known: true, name: 'minecraft:stone', boundingBox: 'block', extra: [] } : { known: true, name: 'minecraft:air', boundingBox: 'empty', extra: [] }
    }
  }
  const pitZombie = { ...zombie, runtimeId: '904', position: { x: 5.5, y: 59, z: 0.5 } }
  reach.clear()
  await completeRefresh(bot, [pitZombie], { world: steppedPit, now: 1000, ...calm })
  assert.equal(reach.knownUnreachable(bot, pitZombie, 1200), true)
})
