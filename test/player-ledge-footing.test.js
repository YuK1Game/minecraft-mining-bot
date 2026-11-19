'use strict'

// Standing on the rim of a block, no walk and no dig-and-stack route starts (src/modes/ledge-footing.js).
// Real Realm 2026-11-20 04:20-04:36 JST (main 055da21): a creeper's knockback left the Bot on the 0.025 lip of the
// grass block under a single chest south of the house. Predicted feet (-4895.75495776697, 75, -4982.275000000001),
// onGround true; the own cell (-4896, 75, -4983) and the cell under it received air. For 16 minutes:
// 「掘る・積む道の途中で進めなくなりました（0 歩目のあと・The starting footprint has no known safe support）」,
// 「掘る・積む道もありません（NO_BUILD_ROUTE・調べたマス 2）」 18 times, 「歩ける中継点が見つかりません」 12 times,
// CHUNK_TRAVEL_CANCELLED walked=0.0m 30 times; the feet never changed.
// The blocks below are the ones received there (GET /blocks 04:36 JST, x -4898..-4894, z -4985..-4980, y 73..77).
// Real here: the navigation's planner and physics (movement/navigation.js: the refusal, `partialDrop`, the walk),
// the scaffold's hands (player-scaffold-ports.js `walk`, `footing`), the dig-and-stack walk and its planner
// (player-build-walk.js, movement/build-route.js). Stand-in: the server, which here agrees with every predicted step.
const test = require('node:test')
const assert = require('node:assert/strict')
const { createNavigator } = require('../src/movement/navigation')
const { createScaffoldPorts } = require('../src/modes/player-scaffold-ports')
const { buildWalk } = require('../src/modes/player-build-walk')
const { onRim, footings } = require('../src/modes/ledge-footing')

const block = (name, properties = {}) => ({ known: true, name: `minecraft:${name}`, boundingBox: name === 'air' ? 'empty' : 'block', properties, extra: [] })
// Columns x -4898..-4894, rows z -4985..-4980.
const ROWS = {
  77: ['. . . . .', '. . . . .', '. . . . .', '. . . . .', '. . . . .', '. . . . .'],
  76: ['. . . . .', '. . . . .', '. . . . .', '. . . . .', '. . . . .', 'G . . . .'],
  75: ['. . . . .', '. . . . .', '. . . . .', '. . C . .', '. . F . .', '. G . . .'],
  74: ['. . . . .', '. . . . .', '. . . . .', '. . G . .', '. G D . .', '. D G . .'],
  73: ['G . . . .', '. . G . .', '. G G . .', '. . D G .', 'G D D . .', '. D D . .'] }
const NAMES = { G: block('grass_block'), D: block('dirt'), C: block('chest', { 'minecraft:cardinal_direction': 'south' }), F: block('furnace', { 'minecraft:cardinal_direction': 'east' }), '.': block('air') }
// Outside what was read: stone under y 73 (so a fall ends), nothing received elsewhere.
const received = (x, y, z) => { const c = ROWS[y]?.[z + 4985]?.split(' ')[x + 4898]; return c ? NAMES[c] : y <= 72 ? block('stone') : y >= 78 ? block('air') : { known: false } }
const LIP = { x: -4895.75495776697, y: 75, z: -4982.275000000001 }

function scene ({ getBlock = received, feet = LIP } = {}) {
  const navigator = createNavigator({ world: { getBlock } })
  let state = navigator.physics.fromServer({ position: { x: feet.x, y: feet.y + 1.62, z: feet.z }, rotation: { yaw: 0, pitch: 0 }, gameMode: 'survival' })
  for (let i = 0; i < 20; i++) state = navigator.physics.step(state, {})
  const w = { starts: [], refusals: [], lines: [], at: 0 }
  // The real plan from the body as it stands; a planned step is walked by the real stepper and the server agrees.
  const operations = { movement: { start (target, { maxTicks, ...options } = {}) {
    const route = navigator.plan(state, target, options)
    if (!route.ready) { w.refusals.push(route.reason); throw new Error(route.reason) }
    w.starts.push({ target: { ...target }, options })
    const stepper = navigator.createStepper(route, state)
    for (let i = 0; i < 400; i++) { const frame = stepper.next(); state = frame.predictedState; if (frame.phase !== 'moving') break }
  } } }
  w.feet = () => ({ ...state.position })
  w.onGround = () => state.onGround
  w.ports = createScaffoldPorts({ operations, getBlock, getFeet: w.feet, getInventory: () => ({ known: true, items: [] }), getMotion: () => ({ phase: 'idle' }), pillarStep: async () => ({ ok: false }), sleep: async ms => { w.at += ms }, now: () => w.at })
  return w
}
const cellOf = at => [Math.floor(at.x), Math.floor(at.y + 0.001), Math.floor(at.z)]

test('the received stance: on the lip under the chest the body rests on the ground and no walk is planned from it', () => {
  const w = scene()
  assert.equal(w.onGround(), true)
  assert.deepEqual(cellOf(w.feet()), [-4896, 75, -4983])
  assert.ok(Math.abs(w.feet().y - 75) < 1e-6 && Math.abs(w.feet().z - LIP.z) < 1e-6, JSON.stringify(w.feet()))
  assert.equal(onRim(received, w.feet()), true)
  assert.deepEqual(footings(received, w.feet())[0], { target: { x: -4895.5, y: 74, z: -4982.5 }, options: { partialDrop: true, maxDistance: 2, maxTicks: 40 } })
})

test('a walk refused on the rim first takes the body onto a full stand, then walks', async () => {
  const w = scene()
  assert.equal(await w.ports.walk({ x: -4895.5, y: 74, z: -4983.5 }), true, w.refusals.join(' / '))
  assert.equal(w.refusals[0], 'The starting footprint has no known safe support')
  assert.deepEqual(w.starts[0], { target: { x: -4895.5, y: 74, z: -4982.5 }, options: { partialDrop: true, maxDistance: 2 } })
  assert.deepEqual(cellOf(w.feet()), [-4896, 74, -4984])
  assert.equal(w.onGround(), true)
})

test('the dig-and-stack walk gets off the rim before it plans, and arrives', async () => {
  const w = scene()
  const to = { x: -4896, y: 74, z: -4984 }
  const out = await buildWalk({ ports: w.ports, target: to, done: cell => cell.x === to.x && cell.y === to.y && cell.z === to.z, log: line => w.lines.push(line), sleep: async () => {}, rounds: 3 })
  const log = [...w.lines, ...w.refusals].join('\n')
  assert.equal(out.ok, true, `${out.code}\n${log}`)
  assert.deepEqual(cellOf(w.feet()), [-4896, 74, -4984], log)
  assert.equal(w.lines.filter(line => /ブロックの縁に立っていたため/.test(line)).length, 1, log)
  assert.equal(w.starts[0].options.partialDrop, true, 'the first input is the step off the rim')
})

test('on a full floor and over ground not received nothing is sent', async () => {
  const flat = (x, y, z) => block(y <= 63 ? 'stone' : 'air')
  const ground = scene({ getBlock: flat, feet: { x: 0.5, y: 64, z: 0.5 } })
  assert.equal(await ground.ports.footing(), false)
  assert.deepEqual(ground.starts, [])
  // The cell under the feet not received: not a rim, nothing is concluded.
  const feet = { x: 0.2, y: 64, z: 0.5 }
  const unknown = (x, y, z) => x === 0 && y === 63 && z === 0 ? { known: false } : flat(x, y, z)
  assert.equal(onRim(unknown, feet), false)
  assert.deepEqual(footings(unknown, feet), [])
})

test('a full stand at the same height is asked for before one a block lower', () => {
  // A one-block step: floor at y 63 for x < 0 (stand at 64), at y 62 for x >= 0. The feet at x 0.25: the centre over the lower floor.
  const step = (x, y, z) => block(y <= (x < 0 ? 63 : 62) ? 'stone' : 'air')
  const list = footings(step, { x: 0.25, y: 64, z: 0.5 })
  assert.deepEqual(list[0], { target: { x: -0.5, y: 64, z: 0.5 }, options: { partialRecenter: true, maxDistance: 2, maxTicks: 40 } })
  assert.ok(list.some(stand => stand.options.partialDrop && stand.target.x === 0.5 && stand.target.y === 63))
  assert.ok(list.length <= 6)
})
