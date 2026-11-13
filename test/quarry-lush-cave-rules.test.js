'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { blockRule, setUnknownBlockDefault } = require('../src/quarry-rules')

// Live 2026-11-13: 55 cells of a lush pocket (moss_block, cave_vines with and
// without berries) stayed as UNKNOWN_BLOCK exceptions at the end of the job.
test('lush cave and dripstone blocks are ordinary digs with their Bedrock 1.26.60 names', () => {
  for (const name of ['moss_block', 'pale_moss_block']) assert.equal(blockRule(name).kind, 'dig', name)
  for (const name of ['moss_carpet', 'pale_moss_carpet', 'cave_vines', 'cave_vines_body_with_berries', 'cave_vines_head_with_berries', 'glow_lichen', 'spore_blossom', 'small_dripleaf_block', 'big_dripleaf', 'hanging_roots', 'pale_hanging_moss']) {
    const r = blockRule(name)
    assert.equal(r.kind, 'dig', name); assert.equal(r.plant, true, name); assert.equal(r.tool, null, name)
  }
  assert.deepEqual(blockRule('cave_vines_body_with_berries').drops, ['glow_berries'])
  for (const name of ['small_amethyst_bud', 'amethyst_cluster', 'pointed_dripstone']) assert.equal(blockRule(name).tool, 'pickaxe', name)
  for (const name of ['dirt_with_roots', 'clay', 'dripstone_block', 'amethyst_block', 'calcite', 'smooth_basalt']) assert.equal(blockRule(name).kind, 'dig', name)
})

test('azalea bushes and leaves stay with the tree exclusion; sculk and budding amethyst stay protected', () => {
  for (const name of ['azalea', 'flowering_azalea', 'azalea_leaves', 'azalea_leaves_flowered', 'flowering_azalea_leaves']) assert.deepEqual(blockRule(name), { kind: 'protected', reason: 'LEAF_HARVEST_DISABLED' }, name)
  for (const name of ['sculk', 'sculk_vein', 'sculk_sensor', 'sculk_shrieker', 'sculk_catalyst']) assert.equal(blockRule(name).kind, 'protected', name)
  assert.equal(blockRule('budding_amethyst').kind, 'protected')
  // A player's wool carpet is still not taken.
  assert.equal(blockRule('white_carpet').kind, 'protected')
})

test('the opt-in default mines an unlisted ordinary block by its data, never a protected one', () => {
  try {
    setUnknownBlockDefault(false)
    assert.equal(blockRule('honeycomb_block').kind, 'unknown')
    setUnknownBlockDefault(true)
    const r = blockRule('honeycomb_block')
    assert.equal(r.kind, 'dig'); assert.equal(r.defaulted, true)
    for (const name of ['chest', 'barrel', 'mob_spawner', 'bedrock', 'water', 'lava', 'end_portal_frame', 'oak_log', 'sculk_shrieker']) assert.notEqual(blockRule(name).kind, 'dig', name)
    assert.equal(blockRule('no_such_block_xyz').kind, 'unknown', 'unknown to the data stays unknown')
  } finally { setUnknownBlockDefault(false) }
})
