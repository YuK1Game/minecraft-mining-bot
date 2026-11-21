'use strict'

// Real Host terrain receives complete sections and explicit block updates.
const { createWorld } = require('../../src/host/world')
const state = () => ({ phase: 'spawned', profile: 'mine-test', realm: { id: 'realm' }, dimension: 'overworld', worldSeed: '123', connectionId: 'connection', startedAt: '2026-11-21T00:00:00Z', runtimeEntityId: '1', lifecycle: { deathId: 0 }, health: 20 })
function plannerWorld ({ minSection = -4 } = {}) {
  const names = ['air', 'stone', 'deepslate', 'iron_ore', 'coal_ore', 'gold_ore', 'redstone_ore', 'diamond_ore', 'deepslate_diamond_ore', 'water', 'chest', 'torch', 'ladder', 'cobblestone', 'cobblestone_slab']
  const registry = { blocksByRuntimeId: Object.fromEntries(names.map((name, id) => [id, { stateId: id, name, boundingBox: ['air', 'water', 'torch', 'ladder'].includes(name) ? 'empty' : 'block', hardness: name === 'deepslate' ? 3 : 1.5, diggable: !['air', 'water'].includes(name) }])), blockStates: names.map(name => ({ name, states: name === 'cobblestone_slab' ? { 'minecraft:vertical_half': 'bottom' } : name === 'ladder' ? { facing_direction: 5 } : {} })), handleStartGame () {} }
  const world = createWorld({ registry }), current = state()
  world.applyPacket('start_game', { dimension: 'overworld' })
  const section = (x, y, z, name) => world.applyPacket('subchunk', { dimension: 0, cache_enabled: false, origin: { x, y, z }, entries: [{ dx: 0, dy: 0, dz: 0, result: 'success', payload: Buffer.from([9, 1, y & 255, 1, names.indexOf(name) << 1]) }] })
  const put = (p, name) => world.applyPacket('update_block', { position: p, block_runtime_id: names.indexOf(name), layer: 0 })
  const receive = (from = -4, to = 4) => { for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) for (let y = from; y <= to; y++) section(x, y, z, y === 4 ? 'air' : y < 0 ? 'deepslate' : 'stone') }
  receive(minSection)
  return { world, current, getState: () => structuredClone(current), section, put, receive }
}
module.exports = { plannerWorld, state }
