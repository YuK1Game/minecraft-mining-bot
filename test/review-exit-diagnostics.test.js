'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { buildRegions } = require('../src/quarry-region')
const { planQuarryExit } = require('../src/quarry-exit-plan')
function fixture (patch) {
  const regions = buildRegions({ target: { chunks: [{ x: 0, z: 2 }] }, yTop: 62, yBottom: -64 })
  const getBlock = (x, y, z) => {
    const override = patch(x, y, z)
    if (override) return override
    const name = y <= -60 ? 'bedrock' : y > 62 ? 'air' : 'stone'
    return { known: true, name: `minecraft:${name}`, boundingBox: name === 'air' ? 'empty' : 'block', extra: [] }
  }
  return { regions, getBlock, feet: { x: 0, y: 63, z: 32 }, preflight: true }
}
for (const liquid of ['water', 'lava']) test(`review: liquid exit failure reports actual ${liquid}, representative cell and all candidate counts`, () => {
  const args = fixture((x, y, z) => x === 17 && y === 62 ? { known: true, name: `minecraft:${liquid}`, boundingBox: 'empty', extra: [] } : null)
  const result = planQuarryExit({ ...args, exit: { side: 'east' } })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'EXIT_COLUMN_UNAVAILABLE')
  assert.deepEqual(result.details.position, { x: 17, y: 62, z: 32 })
  assert.equal(result.details.block, `minecraft:${liquid}`)
  assert.deepEqual(result.details.counts, { FLUID_OR_EXTRA_LAYER: 16 })
})
test('review: extra fluid is distinguished from the primary observed landing block', () => {
  const args = fixture((x, y, z) => x === 17 && y === 62 ? { known: true, name: 'minecraft:stone', boundingBox: 'block', extra: [{ name: 'minecraft:water' }] } : null)
  const r = planQuarryExit({ ...args, exit: { side: 'east' } })
  assert.equal(r.ok, false); assert.equal(r.details.block, 'minecraft:stone'); assert.deepEqual(r.details.extra, ['minecraft:water'])
})
test('review: mixed exit rejections retain unknown and fluid counts rather than labeling all candidates water', () => {
  const args = fixture((x, y, z) => x === 17 && y === 62 ? z < 40 ? { known: true, name: 'minecraft:water', boundingBox: 'empty', extra: [] } : { known: false } : null)
  const r = planQuarryExit({ ...args, exit: { side: 'east' } })
  assert.equal(r.ok, false); assert.equal(r.details.cause, 'UNKNOWN'); assert.equal(r.details.block, null)
  assert.deepEqual(r.details.counts, { FLUID_OR_EXTRA_LAYER: 8, UNKNOWN: 8 })
})
