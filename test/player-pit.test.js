'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { boxedIn, stepOut } = require('../src/modes/player-pit')

// Flat ground at y 68 (feet), with a pit two deep: floor cells at feet y 66.
function scene ({ pit = [[0, 0], [1, 0]], refuse = () => false } = {}) {
  const dug = new Set(), inPit = (x, z) => pit.some(([px, pz]) => px === x && pz === z)
  const name = (x, y, z) => dug.has(`${x},${y},${z}`) ? 'air' : y >= 68 ? 'air' : inPit(x, z) && y >= 66 ? 'air' : y === 67 ? 'grass_block' : 'dirt'
  const block = (x, y, z) => { const n = name(x, y, z); return { known: true, name: `minecraft:${n}`, boundingBox: n === 'air' ? 'empty' : 'block' } }
  const at = { x: 0.5, y: 66, z: 0.5 }
  const mined = []
  const ports = {
    feet: () => ({ ...at }), block,
    canMine: cell => !refuse(cell), mine: async cell => { mined.push(cell); dug.add(`${cell.x},${cell.y},${cell.z}`); return true },
    walk: async target => { Object.assign(at, target); return true }
  }
  return { ports, block, at, mined, eye: () => ({ x: at.x, y: at.y + 1.62, z: at.z }) }
}

test('the floor of a pit two deep is boxed in; open ground is not', () => {
  const s = scene()
  assert.equal(boxedIn(s.block, s.eye()), true)
  assert.equal(boxedIn(s.block, { x: 5.5, y: 68 + 1.62, z: 5.5 }), false)
  assert.equal(boxedIn(() => ({ known: false }), s.eye()), false)
})

test('one step cut into the wall leads out of a pit two deep', async () => {
  const s = scene()
  const logs = []
  const out = await stepOut({ ports: s.ports, log: text => logs.push(text), sleep: async () => {} })
  assert.equal(out.ok, true)
  assert.equal(out.steps, 1)
  assert.equal(s.mined.length, 1, 'only the wall block at head height is mined')
  assert.equal(s.mined[0].y, 67)
  assert.equal(s.at.y, 67)
  assert.equal(boxedIn(s.block, s.eye()), false)
  assert.match(logs.at(-1), /穴から出ました/)
})

test('a wall the mining preview refuses is skipped; with none left the climb stops with the reason', async () => {
  const some = scene({ refuse: cell => cell.x === 0 && cell.z !== 0 })
  assert.equal((await stepOut({ ports: some.ports, sleep: async () => {} })).ok, true)
  const none = scene({ refuse: () => true })
  const out = await stepOut({ ports: none.ports, sleep: async () => {} })
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'STEP_FAILED')
  assert.equal(none.at.y, 66)
})
