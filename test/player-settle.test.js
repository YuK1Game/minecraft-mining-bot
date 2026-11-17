'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { settle, offCentre } = require('../src/modes/player-settle')

const stone = { known: true, name: 'minecraft:deepslate', boundingBox: 'block' }
const air = { known: true, name: 'minecraft:air', boundingBox: 'empty' }

// A floor at y 9 under a two-high gallery; `holes` are cells with no floor, `walls` are solid at feet and head.
function scene ({ at, holes = [], walls = [], shortWalk = true }) {
  const feet = { ...at }
  const walks = []
  const block = (x, y, z) => {
    if (y === 9) return holes.includes(`${x},${z}`) ? air : stone
    if (y === 10 || y === 11) return walls.includes(`${x},${z}`) ? stone : air
    return y < 9 ? stone : air
  }
  const walk = async target => {
    walks.push(`${target.x},${target.y},${target.z}`)
    // A walk of less than half a block does not move the Bot unless `shortWalk`.
    if (!shortWalk && Math.hypot(target.x - feet.x, target.z - feet.z) < 0.5) return false
    Object.assign(feet, target)
    return true
  }
  return { ports: { feet: () => ({ ...feet }), block, walk }, feet, walks }
}

test('a body in the middle of its cell needs nothing', async () => {
  const sim = scene({ at: { x: 0.5, y: 10, z: 0.45 } })
  assert.equal(offCentre(sim.ports.block, sim.ports.feet()), null)
  assert.equal((await settle({ ports: sim.ports })).reason, 'NOT_NEEDED')
  assert.deepEqual(sim.walks, [])
})

test('at the rim of a hole and against a wall the Bot walks to the centre of its cell', async () => {
  // Live 2026-11-16: x fraction .2998 (0.0002 inside the west wall cell), z fraction .212 over a hole to the north.
  const sim = scene({ at: { x: 0.2998046875, y: 10, z: 0.211830054708 }, holes: ['0,-1'], walls: ['-1,0'] })
  assert.deepEqual(offCentre(sim.ports.block, sim.ports.feet()), { x: 0, y: 10, z: 0 })
  const out = await settle({ ports: sim.ports })
  assert.equal(out.ok, true)
  assert.equal(out.stepped, false)
  assert.deepEqual(sim.walks, ['0.5,10,0.5'])
})

test('when the short walk does not move the Bot it steps to a free cell beside and back', async () => {
  const sim = scene({ at: { x: 0.3, y: 10, z: 0.5 }, walls: ['1,0', '-1,0'], shortWalk: false })
  const out = await settle({ ports: sim.ports })
  assert.equal(out.ok, true)
  assert.equal(out.stepped, true)
  assert.deepEqual(sim.walks, ['0.5,10,0.5', '0.5,10,1.5', '0.5,10,0.5'])
})

test('with no free cell beside it the answer says so, and a cell that cannot be stood in is left alone', async () => {
  const boxed = scene({ at: { x: 0.3, y: 10, z: 0.5 }, walls: ['-1,0', '1,0', '0,1', '0,-1'], shortWalk: false })
  assert.equal((await settle({ ports: boxed.ports })).reason, 'STILL_OFF_CENTRE')
  const noFloor = scene({ at: { x: 0.3, y: 10, z: 0.5 }, holes: ['0,0'] })
  assert.equal(offCentre(noFloor.ports.block, noFloor.ports.feet()), null)
  const midair = scene({ at: { x: 0.3, y: 10.4, z: 0.5 } })
  assert.equal(offCentre(midair.ports.block, midair.ports.feet()), null)
})

test('on a chest the settle steps down beside it', async () => {
  const { settle } = require('../src/modes/player-settle')
  let stepped = 0
  const ports = { feet: () => ({ x: 0.5, y: 64.95, z: 0.5 }), block: () => null, walk: async () => true, stepOff: async () => { stepped++; return true } }
  assert.deepEqual(await settle({ ports }), { ok: true, steppedOff: true })
  assert.equal(stepped, 1)
})

test('hanging 0.23 above the floor: the ordinary landing comes before the step-down (live 2026-11-17 21:27 JST)', async () => {
  let y = 65.2315
  const calls = []
  const block = (x, by) => by === 65 ? { known: true, name: 'minecraft:air', boundingBox: 'empty' } : by === 64 ? { known: true, name: 'minecraft:netherrack', boundingBox: 'block' } : null
  const ports = { feet: () => ({ x: -4989.4, y, z: -4974.5 }), block, walk: async () => true, stepOff: async () => { calls.push('stepOff'); return false }, land: async () => { calls.push('land'); y = 65; return true } }
  assert.deepEqual(await settle({ ports }), { ok: true, landed: true })
  assert.deepEqual(calls, ['land'])
  // A landing that leaves the body hanging still tries the step-down, then reports.
  y = 65.2315
  const stuck = { ...ports, land: async () => { calls.push('land'); return true } }
  calls.length = 0
  assert.equal((await settle({ ports: stuck })).reason, 'STILL_ON_LOW_BLOCK')
  assert.deepEqual(calls, ['land', 'stepOff'])
})
