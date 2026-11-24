'use strict'

// A vein pocket two columns deep is closed from inside the pocket, far end first.
// Real Realm 2026-11-24 14:32-14:47 JST, plan 943e0d9a3c2d6da00803: after six cells of iron vein north of the
// upper corridor (z 10235), the fill of (9878,49,10233) was sent from the corridor stand (9879.6,47.5,10235.5)
// and refused 「操作対象への視線が遮られているか、未取得です」; goal early.home_reserve#4 went 5 and 10 minutes
// without progress and was reconsidered 3/3. The blocks are the ones the PC received at 14:47 JST (GET /blocks,
// radius 3, all known) and the vein is the saved record.
// Real: restoreVein's order, the shaft's fillCell, the mine's placement port and lighting's stand choice,
// the interactions' house plan and its sight rule. Stand-ins: the server's answer to a click, the walk.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createInteractions } = require('../src/actions/interactions')
const { createMineActions } = require('../src/modes/mining/mine-actions')
const { createMineLighting } = require('../src/modes/mining/mine-lighting')
const { fillCell } = require('../src/modes/mining/mine-shaft')
const { veinFillOrder, createVeinFillStand } = require('../src/modes/mining/mine-vein-fill')
const received = require('./fixtures/mine-vein-pocket.json')

const VEIN = {
  layer: 'upper', anchor: { x: 9879, y: 48, z: 10235 }, returnTo: { x: 9879.554936002014, y: 47.5, z: 10235.499990351933 },
  frontier: [{ x: 9877, y: 48, z: 10235 }, { x: 9878, y: 48, z: 10235 }, { x: 9879, y: 48, z: 10235 }, { x: 9878, y: 48, z: 10234 }, { x: 9878, y: 48, z: 10233 }, { x: 9879, y: 48, z: 10233 }],
  opened: [{ x: 9878, y: 49, z: 10234 }, { x: 9878, y: 48, z: 10234 }, { x: 9878, y: 49, z: 10233 }, { x: 9878, y: 48, z: 10233 }, { x: 9879, y: 49, z: 10233 }, { x: 9879, y: 48, z: 10233 }],
  mined: 6, closing: true
}
const FACE = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]]
const block = (name, bb = 'block', properties = {}) => ({ known: true, name: 'minecraft:' + name, runtimeId: 20, boundingBox: bb, properties, extra: [] })

function fixture ({ stands = true } = {}) {
  const blocks = new Map(received.blocks.map(([x, y, z, name, bb, properties]) => [`${x},${y},${z}`, block(name, bb, properties)]))
  const lines = [], sent = [], walks = []
  const world = { getBlock: (x, y, z) => blocks.get(`${x},${y},${z}`) ?? block('stone') }
  const extra = { has_nbt: 'false', can_place_on: [], can_destroy: [] }
  const empty = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra })
  const raw = new Map(Array.from({ length: 36 }, (_, slot) => [slot, empty()]))
  raw.set(0, { network_id: 4, count: 64, metadata: 0, has_stack_id: true, stack_id: 92, block_runtime_id: 300, extra })
  let feet = { ...VEIN.returnTo }
  const state = { phase: 'spawned', gameMode: 'survival', runtimeEntityId: '41', dimension: 'overworld', health: 20, profile: 'test', realm: { id: 'realm' }, connectionId: 'a', startedAt: 'start', lifecycle: { deathId: 1 }, position: { ...feet, y: feet.y + 1.62 }, selectedSlot: 0, inventory: { known: true } }
  const items = () => [{ slot: 0, name: 'minecraft:cobblestone', count: raw.get(0).count, stackId: 92 }]
  const crafting = { applyPacket () {}, closeContainer () {}, rawItem: slot => structuredClone(raw.get(slot)), snapshot: () => ({ authority: true, inventoryKnown: true, inventory: items() }) }
  let running = false, interactions
  const input = {
    stats: () => ({ running, target: null }), lookAt: () => ({ yaw: 0, pitch: 0 }), start: () => { running = true }, stop: () => { running = false },
    sendTransaction: (value, callbacks) => {
      sent.push({ ...value.data, from: { ...feet } })
      callbacks.onSent()
      // The server's answer: the block where the clicked face points, one item less.
      queueMicrotask(() => {
        const at = value.data.block_position, [dx, dy, dz] = FACE[value.data.face]
        const position = { x: at.x + dx, y: at.y + dy, z: at.z + dz }
        blocks.set(`${position.x},${position.y},${position.z}`, block('cobblestone'))
        raw.get(0).count--
        interactions.applyPacket('update_block', { position })
        interactions.applyPacket('inventory_slot', { window_id: 'inventory', slot: 0, item: raw.get(0) })
      })
    }
  }
  interactions = createInteractions({ client: { queue () {} }, getState: () => state, world, crafting, getInput: () => input })
  const branch = { plan: { id: '943e0d9a3c2d6da00803', scope: { profile: 'test', realmId: 'realm', dimension: 'overworld' } }, vein: structuredClone(VEIN) }
  const ctx = {
    runtime: { raw: () => state, inventory: () => ({ known: true, items: items() }) },
    shared: {}, memory: { early: { mine: { branch } } }, getBlock: world.getBlock, getFeet: () => ({ ...feet }),
    cancelled: () => false, saveMine: async () => true, log: line => lines.push(line), hands: {},
    operations: { interactions: { previewHouseBlock: data => interactions.previewHouseBlock(data), placeHouseBlock: data => interactions.placeHouseBlock(data) }, crafting, inventory: {} },
    sleep: async () => {}, now: (() => { let at = 0; return () => (at += 400) })()
  }
  const actions = createMineActions(ctx)
  // The walk: a stand of the received terrain is reached and its position received.
  actions.walk = async stand => { walks.push({ ...stand }); feet = { ...stand }; state.position = { ...feet, y: feet.y + 1.62 }; return actions.done('MINE_POSITION_RECEIVED', { position: stand }) }
  const lighting = createMineLighting(ctx, actions)
  ctx.minePorts = { ...actions, place: actions.place, approachVeinFill: stands ? createVeinFillStand(ctx, lighting, actions) : undefined }
  return { ctx, branch, blocks, lines, sent, walks, raw, read: p => world.getBlock(p.x, p.y, p.z) }
}

test('the pocket is closed far end first: the column only reached through another, then that one, then the one by the corridor', () => {
  assert.deepEqual(veinFillOrder(VEIN).map(p => `${p.x},${p.y},${p.z}`), [
    '9879,49,10233', '9879,48,10233', '9878,49,10233', '9878,48,10233', '9878,49,10234', '9878,48,10234'
  ])
})

test('14:32 JST: from the corridor stand no face of (9878,49,10233) is in view, and nothing is sent', async () => {
  const f = fixture({ stands: false })
  const out = await fillCell(f.ctx, f.branch, { x: 9878, y: 49, z: 10233 }, 'vein_restore')
  assert.equal(out.code, 'MINE_PLACEMENT_UNCONFIRMED', JSON.stringify(out))
  assert.equal(f.sent.length, 0)
  assert.match(f.lines.find(line => /置けません/.test(line)) ?? '', /9878,49,10233 に cobblestone を置けません（.*視線が遮られている/)
})

test('every opened cell is filled from a stand inside the pocket that sees it: six clicks, six received blocks, six cobblestone', async () => {
  const f = fixture()
  for (const p of veinFillOrder(f.branch.vein)) {
    const out = await fillCell(f.ctx, f.branch, p, 'vein_restore')
    assert.equal(out.status, 'completed', `${p.x},${p.y},${p.z}: ${JSON.stringify(out)}`)
    assert.equal(f.read(p).name, 'minecraft:cobblestone')
  }
  assert.equal(f.sent.length, 6)
  assert.equal(f.raw.get(0).count, 58)
  const cells = new Set([...VEIN.opened, ...VEIN.frontier].map(p => `${p.x},${p.z}`))
  for (const click of f.sent) assert.ok(cells.has(`${Math.floor(click.from.x)},${Math.floor(click.from.z)}`), 'clicked from the pocket or its corridor: ' + JSON.stringify(click.from))
  assert.ok(f.walks.length >= 1, 'walked off the corridor stand into the pocket')
  // The 14:32 cell (third in the order) is not clicked from the corridor stand that could not see it.
  assert.notEqual(`${Math.floor(f.sent[2].from.x)},${Math.floor(f.sent[2].from.z)}`, '9879,10235', JSON.stringify(f.sent[2].from))
  assert.deepEqual(f.lines.filter(line => /置けません/.test(line)), [])
})
