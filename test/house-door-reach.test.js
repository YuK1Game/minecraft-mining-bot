'use strict'

// The house door is clicked only from where the click reaches it; where the walk does not get there, the way that
// digs and stacks takes the Bot to the stand outside the door first (src/modes/house/house-door.js `reach`, wired in
// mode-runtime.js to house-entry.js toEntrance).
// Real Realm 2026-11-24 15:49:50-15:51:20 JST, the return to the base chest (9880, 65, 10139) of the house
// (9877,64,10138): 「拠点の家のドアを開けられません 操作対象が手の届く範囲外です。」 nine times, then
// CHEST_UNREACHED (CONTAINER_NOT_VISIBLE / CONTAINER_NOT_IN_REACH) and the return held. The ground round the house had
// been dug away (test/fixtures/house-moat.json, received 2026-11-23 16:20 JST); the repair had put the door back closed.
// Where the Bot stood at 15:49 was not read: the test stands it in the pit north of the wall (the pit of 16:14 11-23).
// Real: the door opening, the entrance approach, the way that digs and stacks, the hands, the navigation and physics.
// Stand-in: the server (test/helpers/dig-world.js: a door click farther than 4.5 m is refused, as on the Realm).
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createDigWorld } = require('./helpers/dig-world')
const { createBuildWalk, createMemo } = require('../src/modes/player-build-walk')
const { openDoor } = require('../src/modes/house/house-door')
const { toEntrance } = require('../src/modes/house/house-entry')
const received = require('./fixtures/house-moat.json')

const origin = received.house.origin
const DOOR = { x: 9880, y: 65, z: 10144 }
const NORTH = { x: 9879.5, y: 63, z: 10136.5 }
const key = cell => `${cell.x},${cell.y},${cell.z}`

function scene () {
  const states = { ...received.states, [key(DOOR)]: { ...received.states[key(DOOR)], open_bit: 0, upper_block_bit: 0 } }
  const items = [{ slot: 0, name: 'minecraft:stone_pickaxe', count: 1, durabilityKnown: true, durabilityRemaining: 67 }, { slot: 1, name: 'minecraft:cobblestone', count: 37 }]
  const w = createDigWorld({ ...received, states, feet: NORTH }, { outside: () => null, items })
  w.log = []
  w.shared = { playerHouse: { origin, done: true, built: true } }
  w.build = createBuildWalk({ hands: w.ctx.hands, getHouse: () => w.shared.playerHouse, log: line => w.log.push(line), memo: createMemo() })
  w.refused = 0
  const click = w.ctx.operations.interactions.useDoor
  w.useDoor = async at => { try { return await click(at) } catch (error) { w.refused++; throw error } }
  w.open = reach => openDoor({ origin, getBlock: w.getBlock, useDoor: w.useDoor, walk: target => w.ctx.hands.walk(target), getFeet: () => w.ctx.hands.feet(), reach, log: line => w.log.push(line) })
  return w
}

test('15:49 JST: from the pit north of the wall the walk gets nowhere near the door, and no click is sent from there', async () => {
  const w = scene()
  assert.equal(await w.open(null), false)
  assert.equal(w.refused, 0, 'no click from out of reach')
  assert.deepEqual(w.clicks, [])
  assert.ok(w.log.some(line => /ドアに手の届く場所へ行けません/.test(line)), w.log.join('\n'))
})

test('with the entrance approach the Bot digs and stacks round to the door step, then clicks the door open', async () => {
  const w = scene()
  const reach = () => toEntrance({ origin, getBlock: w.getBlock, getFeet: () => w.ctx.hands.feet(), hands: w.ctx.hands, build: w.build })
  assert.equal(await w.open(reach), true, w.log.join('\n'))
  assert.equal(w.refused, 0)
  assert.deepEqual(w.clicks, [DOOR])
  const feet = w.ctx.hands.feet()
  assert.ok(Math.hypot(DOOR.x + 0.5 - feet.x, DOOR.z + 0.5 - feet.z) <= 4.5)
})
