'use strict'

// The wall behind the next rung opens into a cave, and the only face to click is half hidden by the rung above.
// Real Realm 2026-11-23 12:03:31-12:13:33 JST, shaft of plan 0bc096c1f571cda9c1fe at depth 53 (ladder column
// 9885,10126, facing 3, its wall 9885,10125): the fill of (9885,52,10125) was tried every 2 s (runs #581-#731),
// cobblestone stayed at 63, no line was logged, and goal early.home_reserve#4 was held (MINE_PLACEMENT_UNCONFIRMED).
// The blocks below are the ones the PC received at 12:20 JST (GET /blocks, all known).
// Real: the shaft's fillCell, the mine's placement port, HousePorts, the interactions' house plan and its sight
// rule with the rung's plate. Stand-ins: the server's answer to a sent click, the saved record.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createInteractions } = require('../src/actions/interactions')
const { createMineActions, visibleMinePlacement } = require('../src/modes/mining/mine-actions')
const { fillCell } = require('../src/modes/mining/mine-shaft')
const { houseClickGeometry } = require('../src/actions/house-placement')

const TARGET = { x: 9885, y: 52, z: 10125 }, WEST = { x: 9884, y: 52, z: 10125 }
const FEET = { x: 9885.499, y: 53, z: 10127.426 }
const block = (name, properties = {}) => ({ known: true, name: 'minecraft:' + name, runtimeId: 20, boundingBox: ['air', 'torch'].includes(name) ? 'empty' : 'block', properties, extra: [] })

function received () {
  // y: ladder column 9885,10126 | 9885,10127 | 9884,10126 | 9884,10127 | the rungs' wall 9885,10125
  const rows = {
    58: 'Lcccs', 57: 'Lcccs', 56: 'Lcccs', 55: 'Lcccs', 54: 'Laaas', 53: 'Laats', 52: 'asssa', 51: 'csssa', 50: 'aaasa'
  }
  const columns = [[9885, 10126], [9885, 10127], [9884, 10126], [9884, 10127], [9885, 10125]]
  const of = letter => letter === 'L' ? block('ladder', { facing_direction: 3 }) : letter === 'c' ? block('cobblestone') : letter === 's' ? block('stone') : letter === 't' ? block('torch') : block('air')
  const blocks = new Map()
  for (const [y, row] of Object.entries(rows)) [...row].forEach((letter, i) => blocks.set(`${columns[i][0]},${y},${columns[i][1]}`, of(letter)))
  // Around the wall cell: stone above (in the table) and to the west; the cave to the east, north and below.
  blocks.set('9884,52,10125', block('stone')); blocks.set('9886,52,10125', block('air')); blocks.set('9885,52,10124', block('air'))
  return blocks
}

function fixture ({ answer = true } = {}) {
  const blocks = received(), lines = [], sent = []
  const world = { getBlock: (x, y, z) => blocks.get(`${x},${y},${z}`) ?? block('stone') }
  const extra = { has_nbt: 'false', can_place_on: [], can_destroy: [] }
  const empty = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra })
  const raw = new Map(Array.from({ length: 36 }, (_, slot) => [slot, empty()]))
  raw.set(0, { network_id: 4, count: 63, metadata: 0, has_stack_id: true, stack_id: 92, block_runtime_id: 300, extra })
  const state = { phase: 'spawned', gameMode: 'survival', runtimeEntityId: '41', dimension: 'overworld', health: 20, profile: 'test', realm: { id: 'realm' }, connectionId: 'a', startedAt: 'start', lifecycle: { deathId: 1 }, position: { ...FEET, y: FEET.y + 1.62 }, selectedSlot: 0, inventory: { known: true } }
  const items = () => [{ slot: 0, name: 'minecraft:cobblestone', count: raw.get(0).count, stackId: 92 }]
  const crafting = { applyPacket () {}, closeContainer () {}, rawItem: slot => structuredClone(raw.get(slot)), snapshot: () => ({ authority: true, inventoryKnown: true, inventory: items() }) }
  let running = false, interactions
  const input = {
    stats: () => ({ running, target: null }), lookAt: () => ({ yaw: 0, pitch: 0 }), start: () => { running = true }, stop: () => { running = false },
    sendTransaction: (value, callbacks) => {
      sent.push(value)
      callbacks.onSent()
      if (!answer) return
      // The server's answer: the block where the clicked face points, one item less.
      queueMicrotask(() => {
        blocks.set(`${TARGET.x},${TARGET.y},${TARGET.z}`, block('cobblestone'))
        raw.get(0).count--
        interactions.applyPacket('update_block', { position: TARGET })
        interactions.applyPacket('inventory_slot', { window_id: 'inventory', slot: 0, item: raw.get(0) })
      })
    }
  }
  interactions = createInteractions({ client: { queue () {} }, getState: () => state, world, crafting, getInput: () => input })
  const branch = { plan: { id: '0bc096c1f571cda9c1fe', scope: { profile: 'test', realmId: 'realm', dimension: 'overworld' } }, shaft: { depth: 53, landings: {}, entry: true } }
  const ctx = {
    runtime: { raw: () => state, inventory: () => ({ known: true, items: items() }) },
    shared: {}, memory: { early: { mine: { branch } } }, getBlock: world.getBlock, getFeet: () => ({ ...FEET }),
    cancelled: () => false, saveMine: async () => true, log: line => lines.push(line), hands: {},
    operations: { interactions: { previewHouseBlock: data => interactions.previewHouseBlock(data), placeHouseBlock: data => interactions.placeHouseBlock(data) }, crafting, inventory: {} },
    sleep: async () => {}, now: (() => { let at = 0; return () => (at += 400) })()
  }
  ctx.minePorts = createMineActions(ctx)
  return { ctx, branch, blocks, world, lines, sent, raw, interactions, read: p => world.getBlock(p.x, p.y, p.z) }
}

test('12:03 JST: the middle of the only face is behind the plate of the rung above; its south edge is in view', () => {
  const f = fixture(), request = { position: TARGET, name: 'minecraft:cobblestone', supportPurpose: 'ladder_support' }
  // The click the placement sent before: the middle of the east face of the stone to the west.
  const middle = f.interactions.previewHouseBlock({ position: TARGET, slot: 0, clicked: WEST, face: 5, clickY: 0.5 })
  assert.equal(middle.ready, false)
  assert.match(middle.errors[0], /視線が遮られている/)
  const plan = visibleMinePlacement(f.read, request, FEET)
  assert.deepEqual([plan.clicked, plan.face], [WEST, 5])
  assert.notEqual(plan.clickAcross ?? 0.5, 0.5, 'a point of the face beside its middle')
  const point = houseClickGeometry(plan.clicked, plan.face, plan.clickY, plan.clickAcross).point
  assert.equal(point.x, 9885, 'on the east face')
  assert.ok(point.z > 10125.5 && point.z < 10126 && point.y > 52 && point.y < 53, JSON.stringify(point))
  assert.equal(f.interactions.previewHouseBlock({ position: TARGET, slot: 0, clicked: plan.clicked, face: plan.face, clickY: plan.clickY, clickAcross: plan.clickAcross }).ready, true)
})

test('the wall behind the next rung is filled from the work floor: one click on the visible part of the face, the received block and one cobblestone less', async () => {
  const f = fixture()
  const out = await fillCell(f.ctx, f.branch, TARGET, 'ladder_support')
  assert.equal(out.status, 'completed', JSON.stringify(out))
  assert.equal(f.read(TARGET).name, 'minecraft:cobblestone')
  assert.equal(f.raw.get(0).count, 62)
  assert.equal(f.sent.length, 1)
  const click = f.sent[0].data
  assert.deepEqual([click.block_position, click.face], [WEST, 5])
  assert.equal(click.click_pos.x, 1)
  assert.ok(click.click_pos.z > 0.5, 'toward the Bot, clear of the plate: ' + JSON.stringify(click.click_pos))
  assert.equal(f.branch.pendingAction, undefined)
  assert.equal(f.branch.supportFills, undefined, 'a rung\'s wall is permanent: not a temporary floor the shaft may dig again')
  assert.deepEqual(f.lines.filter(line => /置けません/.test(line)), [])
})

test('a wall cell with no face in view is not clicked, and says where and why once', async () => {
  const f = fixture()
  // The stone to the west is cave too: nothing received to click but the underside of the stone above.
  f.blocks.set('9884,52,10125', block('air'))
  for (let i = 0; i < 3; i++) assert.equal((await fillCell(f.ctx, f.branch, TARGET, 'ladder_support')).code, 'MINE_PLACE_SUPPORT_UNKNOWN')
  assert.equal(f.sent.length, 0)
  assert.deepEqual(f.lines.filter(line => /置けません/.test(line)), ['採掘場: 9885,52,10125 に cobblestone を置けません（置く面になる受信済みの固いブロックがありません）'])
})

test('a click the house plan refuses is said once with its reason, and nothing is sent', async () => {
  const f = fixture()
  // A wall cell two rungs up the same column seen from the same floor: every point of its faces is out of view.
  const hidden = { x: 9885, y: 52, z: 10124 }
  f.blocks.set('9885,52,10125', block('stone'))
  f.blocks.set('9884,52,10124', block('stone'))
  for (let i = 0; i < 2; i++) assert.equal((await fillCell(f.ctx, f.branch, hidden, 'ladder_support')).code, 'MINE_PLACEMENT_UNCONFIRMED')
  assert.equal(f.sent.length, 0)
  const said = f.lines.filter(line => /置けません/.test(line))
  assert.equal(said.length, 1, JSON.stringify(f.lines))
  assert.match(said[0], /^採掘場: 9885,52,10124 に cobblestone を置けません（.*視線が遮られている/)
})

test('the middle of a face stays the first choice, a slab stays low, and a fixed height is kept', () => {
  const air = block('air'), stone = block('stone')
  const open = new Set(['3,1,3']), read = p => open.has(`${p.x},${p.y},${p.z}`) || p.y >= 1 && !(p.x === 2 && p.y === 1 && p.z === 3) ? air : stone
  const feet = { x: 3.5, y: 1, z: 5.5 }, position = { x: 3, y: 1, z: 3 }
  const plain = visibleMinePlacement(read, { position, name: 'cobblestone' }, feet)
  assert.equal(plain.clickAcross, undefined, 'a face seen at its middle is clicked there')
  const f = fixture()
  const slab = visibleMinePlacement(f.read, { position: TARGET, name: 'cobblestone_slab' }, FEET)
  assert.ok(slab && slab.clickY < 0.5, JSON.stringify(slab))
  assert.equal(visibleMinePlacement(f.read, { position: TARGET, name: 'cobblestone', clickY: 0.9 }, FEET), null, 'no point at that height is in view')
})
