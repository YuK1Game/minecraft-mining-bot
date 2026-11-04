'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createQuarryRuntimeAdapter } = require('../src/quarry-runtime-adapter')
const { parseQuarryCommand } = require('../src/quarry-cli')

function fakePorts () {
  const blocks = new Map([['1,0,0', 'minecraft:stone'], ['2,0,0', 'minecraft:dirt']])
  const state = { position: { x: 0.5, y: 1.62, z: 0.5 }, inventory: { known: true, items: [{ slot: 3, name: 'minecraft:cobblestone', count: 70 }] } }
  let miningPhase = 'idle'; let movePhase = 'idle'
  const calls = []
  const ports = {
    getState: () => structuredClone(state),
    getBlock: (x, y, z) => ({ known: true, name: blocks.get(`${x},${y},${z}`) ?? 'minecraft:air' }),
    entities: () => [{ kind: 'item', runtimeId: 9, name: 'minecraft:dirt', count: 1, position: { x: 2.5, y: 0, z: 0.5 } }, { kind: 'item', runtimeId: 10, positionKnown: false, position: null }],
    mining: { preview: t => ({ ready: t[0].accessPreparation === 'quarry' }), start: t => { calls.push(['mine', t[0]]); miningPhase = 'mining'; setTimeout(() => { blocks.delete(`${t[0].x},${t[0].y},${t[0].z}`); miningPhase = 'completed' }, 20) } },
    getMining: () => ({ phase: miningPhase }),
    movement: {
      preview: target => ({ ready: Math.hypot(target.x - state.position.x, target.z - state.position.z) <= 3.1 }),
      start: target => { calls.push(['move', target]); movePhase = 'moving'; setTimeout(() => { state.position = { x: target.x, y: target.y + 1.62, z: target.z }; movePhase = 'completed' }, 10) }
    },
    getMovement: () => ({ phase: movePhase }),
    equip: async () => ({}),
    placeQuarry: async o => { calls.push(['place', o]) },
    eat: async () => {},
    chest: {
      open: async () => calls.push(['open']),
      depositItem: async o => { calls.push(['deposit', o]); const i = state.inventory.items.find(x => x.slot === o.sourceSlot); if (calls.filter(c => c[0] === 'deposit').length > 1) throw new Error('実アイテムを置ける受信済みのチェスト枠がありません。'); i.count -= o.count },
      close: () => calls.push(['close'])
    },
    stopAll: async () => {},
    combatActive: () => false,
    sleep: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 5)))
  }
  return { ports, calls, state, blocks }
}

test('runtime adapter mines through quarry targets and waits for received air', async () => {
  const { ports, calls, blocks } = fakePorts()
  const a = createQuarryRuntimeAdapter(ports)
  await a.mine([{ x: 1, y: 0, z: 0, expectedName: 'minecraft:stone', requiredTool: { kind: 'pickaxe', tier: 1 } }, { x: 5, y: 0, z: 0, expectedName: 'minecraft:stone' }])
  assert.equal(blocks.has('1,0,0'), false)
  assert.equal(calls.filter(c => c[0] === 'mine').length, 1, 'already-air targets are skipped')
  assert.deepEqual(calls[0][1].requiredTool, { kind: 'pickaxe', tier: 1 })
})

test('runtime adapter walks a long path in short verified segments', async () => {
  const { ports, calls, state } = fakePorts()
  const a = createQuarryRuntimeAdapter({ ...ports, segmentCells: 6 })
  const path = Array.from({ length: 9 }, (_, i) => ({ x: i, y: 0, z: 0 }))
  await a.moveTo({ x: 8, y: 0, z: 0 }, { path })
  assert.deepEqual([Math.floor(state.position.x), Math.floor(state.position.z)], [8, 0])
  const moves = calls.filter(c => c[0] === 'move')
  assert.ok(moves.length >= 3, 'refused long segments are retried shorter')
  assert.ok(moves.every(m => m[1].x % 1 === 0.5), 'targets are cell centres')
})

test('runtime adapter reports a full chest instead of failing the deposit', async () => {
  const { ports, calls } = fakePorts()
  const a = createQuarryRuntimeAdapter(ports)
  const r = await a.deposit([{ position: { x: 0, y: 0, z: 5 } }], [{ slot: 3, name: 'minecraft:cobblestone', count: 70 }])
  assert.equal(r.full, true)
  assert.deepEqual(r.deposited, [{ name: 'minecraft:cobblestone', count: 64 }])
  assert.equal(calls.at(-1)[0], 'close')
  assert.equal(a.entities().length, 1)
})

test('quarry terminal syntax', () => {
  assert.deepEqual(parseQuarryCommand('/quarry plan here bottom=40 chest=1,64,2', { position: { x: -3.2, y: 70, z: 33 } }).args[0], { target: { chunks: [{ x: -1, z: 2 }] }, yBottom: 40, inventory: { storage: [{ position: { x: 1, y: 64, z: 2 } }] } })
  assert.deepEqual(parseQuarryCommand('/quarry plan 0 0 1 1 combat=off').args[0], { target: { rect: { x1: 0, z1: 0, x2: 1, z2: 1 } }, inventory: { carryOnly: true }, quarryCombat: { enabled: false } })
  assert.equal(parseQuarryCommand('/quarry stop').method, 'emergencyStop')
  assert.equal(parseQuarryCommand('/quarry').method, 'status')
  assert.throws(() => parseQuarryCommand('/quarry plan 1'))
})

test('runtime adapter re-plans a move that ends short instead of waiting out the timeout', async () => {
  const { ports, calls, state } = fakePorts()
  let first = true; let phase = 'idle'
  const a = createQuarryRuntimeAdapter({
    ...ports,
    segmentTimeoutMs: 60000,
    getMovement: () => ({ phase }),
    movement: {
      preview: () => ({ ready: true }),
      stop: () => {},
      start: target => {
        calls.push(['move', target]); phase = 'moving'
        setTimeout(() => {
          // First attempt: server correction leaves the bot one cell short.
          state.position = first ? { x: target.x - 1, y: target.y + 1.62, z: target.z } : { x: target.x, y: target.y + 1.62, z: target.z }
          first = false; phase = 'awaiting_server_confirmation'
        }, 10)
      }
    },
    shortStopMs: 50
  })
  const started = Date.now()
  await a.moveTo({ x: 3, y: 0, z: 0 }, { path: [0, 1, 2, 3].map(x => ({ x, y: 0, z: 0 })) })
  assert.equal(Math.floor(state.position.x), 3)
  assert.ok(Date.now() - started < 5000)
})
