'use strict'

// The way back into the mine from below its entrance (src/modes/mining/mine-route.js `enterMine`).
// Real Realm 2026-11-24, mine 943e0d9a (site anchor (9838, 10258), surface y 66, shaft columns x 9869..9870,
// z 10257..10258, approach (9869.5, 66, 10256.5)): 16:33:09〜16:35:52 the cobblestone gathering dug the ground east
// of the shaft and ended at the bottom of its own pit, feet (9862.5, 52.0, 10245.5): 14 below the entrance, 15m from
// it, stone over the head at y 55. From 16:35:53 「採掘場の入口へ安全な地上路が見つかりません。」
// (MINE_ENTRY_UNREACHABLE) every two seconds; the feet did not move, and at 16:45:52 the goal early.home_reserve#4
// was at decision 3/3. The entry looked only for a surface walk (and a bounded build within 12 levels).
// The pit as the PC received it at 16:52 (GET /blocks, radius 3): the feet cell and the three over it open, the four
// sides stone. Outside that, this test puts plain ground (stone up to y 64, grass at 65, air above): a stand-in.
// Real: `enterMine`, the shared way up (player-rise.js `riseToSky` with player-climb.js), the scaffold's hands,
// the navigation and its physics. Stand-in: the server (test/helpers/dig-world.js) and the mine's position receipt.
// Before: MINE_ENTRY_UNREACHABLE at once, nothing mined or placed. After: up the pit by the pillar, then at the entrance.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { enterMine } = require('../src/modes/mining/mine-route')
const { riseToSky } = require('../src/modes/player-rise')
const { underCover } = require('../src/modes/player-surface')
const { createBuildWalk } = require('../src/modes/player-build-walk')
const { createDigWorld } = require('./helpers/dig-world')

const FEET = { x: 9862.5, y: 52, z: 10245.5 }
const TO = { x: 9869.5, y: 66, z: 10256.5 }
const PIT = new Set(['9862,52,10245', '9862,53,10245', '9862,54,10245'])

function scene ({ climb = true } = {}) {
  const outside = (x, y, z) => PIT.has(`${x},${y},${z}`) ? 'air' : y <= 64 ? 'stone' : y === 65 ? 'grass_block' : 'air'
  const w = createDigWorld({ x0: 0, z0: 0, feet: FEET, legend: {}, rows: {} }, {
    outside,
    items: [{ slot: 0, name: 'minecraft:stone_pickaxe', count: 1, durabilityKnown: true, durabilityRemaining: 120 },
      { slot: 1, name: 'minecraft:cobblestone', count: 64 }]
  })
  const state = { profile: 'test', realm: { id: 'one' }, dimension: 'overworld', connectionId: 'a', startedAt: 'start',
    runtimeEntityId: '1', lifecycle: { deathId: 0 }, phase: 'spawned', health: 20 }
  const raw = w.ctx.runtime.raw
  w.ctx.runtime.raw = () => ({ ...raw(), ...state })
  const near = (a, b) => Math.abs(a.x - b.x) < 0.3 && Math.abs(a.y - b.y) < 0.1 && Math.abs(a.z - b.z) < 0.3
  const arrive = async target => { if (!near(w.ctx.getFeet(), target)) await w.ctx.hands.walk(target); return { status: 'completed', serverConfirmed: near(w.ctx.getFeet(), target) } }
  w.ctx.saveMine = async () => true
  w.ctx.minePorts = { walk: arrive, confirmPosition: arrive }
  w.climbs = 0
  if (climb) w.ctx.climbUp = () => { w.climbs++; return riseToSky({ ports: w.ctx.hands, log: line => w.lines.push(line), sky: () => !underCover(w.getBlock, { ...w.ctx.getFeet(), y: w.ctx.getFeet().y + 1.62 }), build: createBuildWalk({ hands: w.ctx.hands, getHouse: () => null, log: line => w.lines.push(line) }) }) }
  w.branch = { plan: { shaft: { approach: TO, columns: [{ x: 9869, z: 10258 }, { x: 9869, z: 10257 }, { x: 9870, z: 10258 }, { x: 9870, z: 10257 }] } } }
  return w
}

test('from the bottom of a pit 14 below the entrance the shared way up runs first, then the entrance is reached', async () => {
  const w = scene()
  let out = null
  for (let i = 0; i < 4 && !out?.serverConfirmed; i++) out = await enterMine(w.ctx, w.branch)
  const log = w.lines.join('\n')
  assert.ok(w.climbs >= 1, 'the way up was asked')
  assert.ok(w.placed.length > 0, `the pillar was built\n${log}`)
  assert.equal(out?.serverConfirmed, true, `${JSON.stringify(out)}\n${log}`)
  const feet = w.ctx.getFeet()
  assert.ok(Math.abs(feet.x - TO.x) < 0.3 && Math.abs(feet.z - TO.z) < 0.3 && Math.abs(feet.y - TO.y) < 0.1, JSON.stringify(feet))
})

test('without a way up the answer is the old one: no surface route, nothing mined or placed', async () => {
  const w = scene({ climb: false })
  const out = await enterMine(w.ctx, w.branch)
  assert.equal(out.code, 'MINE_ENTRY_UNREACHABLE')
  assert.equal(w.placed.length, 0)
  assert.equal(w.minedNames.length, 0)
})
