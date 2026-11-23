'use strict'

// On the rim of a shore (the own cell has a floor, an edge of the body over water one block down) no walk and no
// dig-and-stack route starts (src/modes/ledge-footing.js `overWater`).
// Real Realm 2026-11-23 19:08-19:25 JST (main d7ede2a): the Bot stood on a sand bar in the pond south-east of the
// house, feet (9892.705, 63.000, 10173.460) on the sand (9892, 62, 10173); the cell east of it is water and the body
// reached 0.005 over it. Every leg of the long trips ended 「Navigation made no progress」, every dig-and-stack route
// 「0 歩目のあと・The starting footprint has no known safe support」 or 「NO_BUILD_ROUTE・調べたマス 2」, and the feet did
// not change.
// The blocks are the ones received there (test/fixtures/pond-sand-bar.json: two GET /blocks reads at 19:10 JST).
// Real here: the navigation's planners and physics (movement/navigation.js: the dry one and the one that reads
// water, chosen by `allowWater` as movement.js does), the scaffold's hands (player-scaffold-ports.js `walk`,
// `footing`), the dig-and-stack walk and its planner (player-build-walk.js, movement/build-route.js).
// Stand-in: the server, which here agrees with every predicted step, and the runtime's start of a move (the frame
// guard is called for every frame, as movement.js does).
const test = require('node:test')
const assert = require('node:assert/strict')
const { createNavigator } = require('../src/movement/navigation')
const { createScaffoldPorts } = require('../src/modes/player-scaffold-ports')
const { buildWalk } = require('../src/modes/player-build-walk')
const { onRim, overWater, adrift, footings } = require('../src/modes/ledge-footing')
const received = require('./fixtures/pond-sand-bar.json')

const EMPTY = new Set(['air', 'water', 'seagrass'])
const WET = [{ name: 'minecraft:water', properties: { liquid_depth: 0 } }]
const key = (x, y, z) => `${x},${y},${z}`
const block = (name, states) => ({ known: true, name: `minecraft:${name}`, boundingBox: EMPTY.has(name) ? 'empty' : 'block', properties: states ?? (name === 'water' ? { liquid_depth: 0 } : {}), extra: name === 'seagrass' ? WET : [] })
// Outside what was read nothing is received.
const pond = (x, y, z) => { const c = received.rows[y]?.[z - received.z0]?.[x - received.x0]; return c ? block(received.legend[c], received.states?.[key(x, y, z)]) : { known: false } }
const RIM = 'The starting footprint has no known safe support'

function scene ({ getBlock = pond, feet = received.feet } = {}) {
  const world = { getBlock, revision: () => 1 }
  const dry = createNavigator({ world }), wet = createNavigator({ world, allowWater: true })
  // The live state carries the prediction's own onGround (physics.js `fromServer`); the server said the same.
  let state = wet.physics.fromServer({ position: { x: feet.x, y: feet.y + 1.62, z: feet.z }, rotation: { yaw: 0, pitch: 0 }, gameMode: 'survival' }, { onGround: true })
  const w = { starts: [], refusals: [], lines: [], frames: 0, wetFrames: 0, at: 0 }
  const operations = { movement: { start (target, { maxTicks, allowWater = false, beforeInput = null, ...options } = {}) {
    const navigator = allowWater ? wet : dry
    const route = navigator.plan(state, target, options)
    if (!route.ready) { w.refusals.push(route.reason); throw new Error(route.reason) }
    w.starts.push({ target: { ...target }, options: { ...options, allowWater } })
    const stepper = navigator.createStepper(route, state)
    for (let i = 0; i < 400; i++) {
      const frame = stepper.next()
      if (beforeInput && beforeInput(frame) === false) throw new Error('Movement frame guard rejected the proposed input')
      state = frame.predictedState; w.frames++
      if (state.isInWater) w.wetFrames++
      if (frame.phase !== 'moving') break
    }
  } } }
  w.feet = () => ({ ...state.position })
  w.onGround = () => state.onGround
  w.dryPlan = target => dry.plan(state, target, { maxDistance: 16 })
  w.ports = createScaffoldPorts({ operations, getBlock, getFeet: w.feet, getInventory: () => ({ known: true, items: [] }), getMotion: () => ({ phase: 'idle' }), pillarStep: async () => ({ ok: false }), sleep: async ms => { w.at += ms }, now: () => w.at })
  return w
}
const cellOf = at => [Math.floor(at.x), Math.floor(at.y + 0.001), Math.floor(at.z)]
const SOUTH = { x: 9891.5, y: 63, z: 10174.5 }

test('the received stance: on the sand bar the body is on the ground, 0.005 over the water, and no walk is planned', () => {
  const w = scene()
  assert.equal(w.onGround(), true)
  assert.deepEqual(cellOf(w.feet()), [9892, 63, 10173])
  assert.equal(pond(9892, 62, 10173).name, 'minecraft:sand')
  assert.equal(pond(9893, 62, 10173).name, 'minecraft:water')
  assert.equal(onRim(pond, w.feet()), false, 'the own cell has a floor: not the rim of a block')
  assert.equal(overWater(pond, w.feet()), true)
  assert.equal(adrift(pond, w.feet()), true)
  assert.equal(w.dryPlan(SOUTH).reason, RIM)
  const [first] = footings(pond, w.feet())
  assert.deepEqual(first.target, { x: 9892.5, y: 63, z: 10173.5 })
  const { beforeInput, ...options } = first.options
  assert.deepEqual(options, { partialRecenter: true, maxDistance: 2, maxTicks: 40, shoreRecenter: true, allowWater: true })
  assert.equal(beforeInput({ predictedState: { isInWater: false, isInLava: false } }), true)
  assert.equal(beforeInput({ predictedState: { isInWater: true } }), false, 'a frame in water ends the step')
  assert.ok(footings(pond, w.feet()).every(stand => stand.options.shoreRecenter === true && stand.target.y === 63), 'over water only level stands')
})

test('a walk refused on the shore\'s rim first takes the body onto a full stand (the one nearest the target), then walks', async () => {
  const w = scene()
  assert.equal(await w.ports.walk(SOUTH), true, w.refusals.join(' / '))
  assert.equal(w.refusals[0], RIM)
  assert.deepEqual(w.starts[0], { target: { x: 9892.5, y: 63, z: 10174.5 }, options: { partialRecenter: true, maxDistance: 2, shoreRecenter: true, allowWater: true } })
  assert.deepEqual(w.starts[1], { target: SOUTH, options: { maxDistance: 16, allowWater: false } }, 'the walk itself is the ordinary dry one')
  assert.deepEqual(cellOf(w.feet()), [9891, 63, 10174])
  assert.equal(w.onGround(), true)
  assert.equal(w.wetFrames, 0)
  assert.equal(adrift(pond, w.feet()), false)
})

test('the dig-and-stack walk gets off the shore\'s rim before it plans, and arrives', async () => {
  const w = scene()
  const to = { x: 9892, y: 64, z: 10176 }
  const out = await buildWalk({ ports: w.ports, target: to, done: cell => cell.x === to.x && cell.y === to.y && cell.z === to.z, log: line => w.lines.push(line), sleep: async () => {}, rounds: 3 })
  const log = [...w.lines, ...w.refusals].join('\n')
  assert.equal(out.ok, true, `${out.code}\n${log}`)
  assert.deepEqual(cellOf(w.feet()), [9892, 64, 10176], log)
  assert.equal(w.lines.filter(line => /ブロックの縁に立っていたため/.test(line)).length, 1, log)
  assert.equal(w.starts[0].options.shoreRecenter, true, 'the first input is the step onto the full stand')
  assert.equal(w.wetFrames, 0)
})

test('inside its own block, beside water not received, and with water at foot height nothing is sent', async () => {
  // The middle of the same sand block: the body reaches no other column.
  const middle = scene({ feet: { x: 9892.5, y: 63, z: 10173.5 } })
  assert.equal(adrift(pond, middle.feet()), false)
  assert.equal(await middle.ports.footing(), false)
  assert.deepEqual(middle.starts, [])
  // The column the body reaches not received: nothing is concluded.
  const unknown = (x, y, z) => x === 9893 && z === 10173 && y === 62 ? { known: false } : pond(x, y, z)
  assert.equal(overWater(unknown, received.feet), false)
  assert.deepEqual(footings(unknown, received.feet), [])
  // Off the grid (mid-air, or afloat): the landing and the water exit own that.
  assert.equal(overWater(pond, { ...received.feet, y: 63.4 }), false)
})
