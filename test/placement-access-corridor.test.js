'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { planPlacementAccess, placementTopVisible } = require('../src/actions/action-access')

// Live 2026-11-16 04:04 JST: a one-wide, two-high corridor in stone along z=-4960
// (x -4920..-4916), a side cell at (-4917,65,-4959) where the Bot stood against
// the south wall, and a shaft east of it. Shifted here to small coordinates.
function corridor () {
  const key = p => `${p.x},${p.y},${p.z}`, blocks = new Map()
  const set = (p, name) => blocks.set(key(p), { known: true, position: { ...p }, name: 'minecraft:' + name, boundingBox: name === 'air' ? 'empty' : 'block', extra: [] })
  for (let x = -6; x <= 4; x++) for (let y = 62; y <= 68; y++) for (let z = -5; z <= 4; z++) set({ x, y, z }, 'stone')
  for (let x = -4; x <= 0; x++) for (const y of [65, 66]) set({ x, y, z: -1 }, 'air')
  for (const y of [65, 66]) set({ x: -1, y, z: 0 }, 'air')
  for (const y of [63, 64, 65]) set({ x: 0, y, z: 0 }, 'air')
  set({ x: 0, y: 64, z: -1 }, 'air')
  const getBlock = p => blocks.get(key(p)) ?? { known: false, position: p }
  return { blocks: [...blocks.values()], getBlock, state: { position: { x: -0.5, y: 66.62, z: 0.57 } } }
}

test('a placement spot in a one-wide corridor is reached from a stance between the walls', () => {
  const f = corridor()
  const targets = [{ x: -2, y: 65, z: -1 }, { x: -3, y: 65, z: -1 }, { x: -4, y: 65, z: -1 }]
  for (const target of targets) assert.equal(placementTopVisible({ state: f.state, target, getBlock: f.getBlock }), null)
  const access = planPlacementAccess({ state: f.state, targets, blocks: f.blocks, getBlock: f.getBlock })
  assert.ok(access)
  assert.equal(access.standpoint.z, -0.5)
  assert.equal(access.standpoint.y, 65)
  assert.ok(Math.abs(access.standpoint.x - (access.target.x + 0.5)) >= 1.55)
  assert.ok(placementTopVisible({ state: { position: { ...access.standpoint, y: 66.62 } }, target: access.target, getBlock: f.getBlock, maxReach: 4.3 }))
})

test('a stance beside a drop is still refused', () => {
  const f = corridor()
  const access = planPlacementAccess({ state: f.state, targets: [{ x: -2, y: 65, z: -1 }], blocks: f.blocks, getBlock: f.getBlock })
  assert.notEqual(access?.standpoint.x, -0.5)
})
