'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createQuarryV22Reset } = require('../src/quarry-v22-reset')
const { observedScope } = require('../src/server-position-verifier')
const key = p => `${p.x},${p.y},${p.z}`
const air = () => ({ known: true, name: 'minecraft:air', boundingBox: 'empty', extra: [] })
const solid = (name = 'minecraft:stone') => ({ known: true, name, boundingBox: 'block', extra: [] })
const empty = slot => ({ slot, known: true, empty: true, name: null, count: 0 })

function fixture ({ feet = { x: 1998.6959, y: 67, z: 2008.8618 }, logs = false } = {}) {
  const state = { phase: 'spawned', profile: 'bot', realm: { id: '42', name: 'Test Realm' }, connectionId: 'site-connection',
    startedAt: '2026-11-12T00:00:00Z', runtimeEntityId: '41', lifecycle: { deathId: 0 }, dimension: 'overworld', gameMode: 'survival', health: 20,
    position: { x: feet.x, y: feet.y + 1.62, z: feet.z }, inventory: { known: true } }
  const terrain = new Map(), calls = [], acquisitions = [], saves = []
  if (logs) for (const y of [67, 68]) terrain.set(`1997,${y},2008`, solid('minecraft:birch_log'))
  const columns = { slots: Array.from({ length: 36 }, (_, slot) => empty(slot)), armor: { known: true, slots: Array.from({ length: 4 }, (_, slot) => empty(slot)) }, offhand: { known: true, slots: [empty(0)] } }
  const adapter = {
    getState: () => state, getView: () => ({ known: true, ...structuredClone(columns) }),
    getBlock: (x, y, z) => structuredClone(terrain.get(`${x},${y},${z}`) ?? (y <= feet.y - 1 ? solid() : air())),
    assertIdle () {}, acquire: id => { acquisitions.push(id) }, release () {},
    jobIdentity: () => null, cancelJob: async () => ({ serverConfirmed: true, previousJobIdentity: null, jobIdentity: null }),
    save: async document => { saves.push(structuredClone(document)) }, load: async () => null, generation: () => 0,
    select: async () => {}, open: async () => { throw new Error('Preview must not open a container') }, close: async () => {},
    deposit: async () => { throw new Error('Site tests cannot transfer items') }, container: () => null, cancelTransfers: async () => {}
  }
  const commands = { send: async command => {
    calls.push(command)
    if (command !== '/testfor @s') throw Object.assign(new Error('No destructive command is permitted in a site regression'), { code: 'UNEXPECTED_DESTRUCTIVE_COMMAND' })
    return { serverConfirmed: true, scope: observedScope(state) }
  }, cancel () {} }
  const reset = createQuarryV22Reset({ adapter, commands })
  return { reset, state, terrain, calls, acquisitions, saves, adapter }
}
function passive (f) {
  assert.deepEqual(f.calls, []); assert.deepEqual(f.acquisitions, []); assert.deepEqual(f.saves, [])
}
function validSite (f, home) {
  const feet = { x: Math.floor(f.state.position.x), y: Math.floor(f.state.position.y - 1.62 + 0.001), z: Math.floor(f.state.position.z) }
  const chunk = { x: Math.floor(feet.x / 16), z: Math.floor(feet.z / 16) }
  assert.deepEqual(home.chunk, chunk)
  assert.deepEqual(home.stand, feet)
  assert.equal(home.position.z, home.other.z); assert.equal(home.position.y, home.other.y)
  assert.equal(Math.abs(home.position.x - home.other.x), 1, 'the default north-facing chest pair must join east/west')
  assert.equal(new Set([home.position, home.other, home.stage].map(key)).size, 3)
  for (const p of [home.position, home.other, home.stage]) {
    assert.equal(Math.floor(p.x / 16), chunk.x, 'every new placement stays in the current chunk')
    assert.equal(Math.floor(p.z / 16), chunk.z, 'every new placement stays in the current chunk')
    assert.equal(p.y, feet.y)
    assert.equal(f.adapter.getBlock(p.x, p.y, p.z).name, 'minecraft:air')
    assert.equal(f.adapter.getBlock(p.x, p.y + 1, p.z).name, 'minecraft:air')
    assert.equal(f.adapter.getBlock(p.x, p.y - 1, p.z).boundingBox, 'block')
  }
  passive(f)
}
function onlyColumns (f, points) {
  const allowed = new Set(points.map(p => `${p.x},${p.z}`))
  f.adapter.getBlock = (x, y, z) => y <= 66 || !allowed.has(`${x},${z}`) ? solid() : air()
}

test('actual chunk-edge feet and birch logs select another observed east/west row without preview writes', async () => {
  const f = fixture({ logs: true }), preview = await f.reset.prepare()
  validSite(f, preview.homeChest)
  assert.deepEqual(preview.homeChest.chunk, { x: 124, z: 125 })
  assert.ok([preview.homeChest.position, preview.homeChest.other].every(p => p.z !== 2008), 'the original west row is obstructed and the east pair crosses the chunk')
  assert.equal(preview.replaces.surfaceChest, false)
})

test('the staging column can be selected independently when the original opposite column is obstructed', async () => {
  const f = fixture({ feet: { x: 8.5, y: 67, z: 8.5 } })
  onlyColumns(f, [{ x: 8, z: 8 }, { x: 9, z: 8 }, { x: 10, z: 8 }, { x: 8, z: 7 }])
  const preview = await f.reset.prepare()
  validSite(f, preview.homeChest)
  assert.deepEqual([preview.homeChest.position.x, preview.homeChest.other.x].sort((a, b) => a - b), [9, 10])
  assert.deepEqual(preview.homeChest.stage, { x: 8, y: 67, z: 7 })
})

test('the filled production double chest stays unchanged and cannot become part of the new debug pair', async () => {
  const f = fixture({ logs: true }), oldPair = [{ x: 1999, y: 67, z: 2009 }, { x: 1999, y: 67, z: 2010 }]
  const contents = new Map(oldPair.map(p => [key(p), [{ name: 'minecraft:purple_shulker_box', count: 1, packed: true }]]))
  for (const p of oldPair) f.terrain.set(key(p), solid('minecraft:chest'))
  const before = structuredClone({ terrain: f.terrain, contents })
  const preview = await f.reset.prepare()
  validSite(f, preview.homeChest)
  assert.equal(preview.homeChest.existing, false); assert.equal(preview.replaces.surfaceChest, false)
  for (const p of [preview.homeChest.position, preview.homeChest.other]) for (const old of oldPair) {
    assert.ok(Math.abs(p.x - old.x) + Math.abs(p.z - old.z) > 1, 'new chest cannot merge with either occupied production half')
  }
  assert.deepEqual({ terrain: f.terrain, contents }, before)
})

test('non-solid grass and flowers never count as air for a chest or staging column', async () => {
  for (const name of ['minecraft:short_grass', 'minecraft:poppy']) {
    const f = fixture({ feet: { x: 8.5, y: 67, z: 8.5 } }), block = f.adapter.getBlock
    f.adapter.getBlock = (x, y, z) => y === 67 && (x !== 8 || z !== 8) ? { ...air(), name } : block(x, y, z)
    await assert.rejects(f.reset.prepare(), { code: 'RESET_CHEST_SITE_UNAVAILABLE' })
    passive(f)
  }
})

test('unknown, hazardous and protected candidate floors, bodies and heads cannot authorize reset preview', async () => {
  for (const mode of ['unknown-floor', 'unknown-body', 'unknown-head', 'hazard-floor', 'hazard-body', 'hazard-head', 'protected-floor', 'protected-body', 'protected-head']) {
    const f = fixture({ feet: { x: 8.5, y: 67, z: 8.5 } }), block = f.adapter.getBlock
    f.adapter.getBlock = (x, y, z) => {
      if (x === 8 && z === 8) return block(x, y, z)
      const [hazard, part] = mode.split('-'), level = { floor: 66, body: 67, head: 68 }[part]
      if (y !== level) return block(x, y, z)
      if (hazard === 'unknown') return { known: false }
      if (hazard === 'hazard') return part === 'floor' ? solid('minecraft:magma') : { ...air(), name: 'minecraft:fire' }
      if (hazard === 'protected') return { ...(part === 'floor' ? solid() : air()), protected: true, protectionSource: 'bot_base' }
      return block(x, y, z)
    }
    await assert.rejects(f.reset.prepare(), { code: 'RESET_CHEST_SITE_UNAVAILABLE' }, mode)
    passive(f)
  }
})

test('negative and positive edge coordinates keep both chest halves and the stage in their floor-selected chunk', async () => {
  for (const value of [-17, -16, -1, 0, 15]) {
    const f = fixture({ feet: { x: value + 0.5, y: 67, z: value + 0.5 } }), preview = await f.reset.prepare()
    validSite(f, preview.homeChest)
    assert.deepEqual(preview.homeChest.chunk, { x: Math.floor(value / 16), z: Math.floor(value / 16) })
  }
})

test('an entirely blocked surrounding area fails without acquiring, saving or clearing anything', async () => {
  const f = fixture({ feet: { x: 8.5, y: 67, z: 8.5 } })
  onlyColumns(f, [{ x: 8, z: 8 }])
  await assert.rejects(f.reset.prepare(), { code: 'RESET_CHEST_SITE_UNAVAILABLE' })
  passive(f)
})

test('moving fractionally within the same feet cell into a confirmed chest or stage rejects before destructive commands', async () => {
  for (const into of ['chest', 'stage']) {
    const f = fixture({ feet: { x: 8.5, y: 67, z: 8.5 } })
    onlyColumns(f, [{ x: 7, z: 8 }, { x: 8, z: 8 }, { x: 9, z: 8 }, { x: 10, z: 8 }])
    const preview = await f.reset.prepare()
    validSite(f, preview.homeChest)
    assert.deepEqual(preview.homeChest.stage, { x: 7, y: 67, z: 8 })
    f.state.position.x = into === 'chest' ? 8.9 : 8.1
    assert.equal(Math.floor(f.state.position.x), preview.homeChest.stand.x)
    let refused = false
    try { f.reset.start({ token: preview.token, confirm: 'REPLACE_SURFACE_CHEST_AND_CLEAR_INVENTORY' }); await f.reset.drain() } catch { refused = true }
    assert.ok(refused || f.reset.status().phase === 'failed', into)
    assert.equal(f.calls.filter(command => command !== '/testfor @s').length, 0, into + ' overlap must be rejected before a destructive command')
    assert.equal(f.reset.status().serverConfirmed, false)
  }
})
