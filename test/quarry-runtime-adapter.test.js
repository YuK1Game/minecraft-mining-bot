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
  assert.deepEqual(parseQuarryCommand('/quarry plan here bottom=40', { position: { x: -3.2, y: 70, z: 33 } }).args[0], { target: { chunks: [{ x: -1, z: 2 }] }, yBottom: 40, inventory: { pickupMode: 'active', depositWhen: 'four_layers', minFreeSlots: 3 } })
  assert.deepEqual(parseQuarryCommand('/quarry plan 0 0 1 1 combat=off').args[0], { target: { rect: { x1: 0, z1: 0, x2: 1, z2: 1 } }, inventory: { pickupMode: 'active', depositWhen: 'four_layers', minFreeSlots: 3 }, quarryCombat: { enabled: false } })
  assert.equal(parseQuarryCommand('/quarry stop').method, 'emergencyStop')
  assert.equal(parseQuarryCommand('/quarry').method, 'status')
  assert.throws(() => parseQuarryCommand('/quarry plan 1'))
  assert.throws(() => parseQuarryCommand('/quarry plan 0 0 chest=1,64,2'), /シュルカー専用/)
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

test('runtime adapter hands a whole batch to one mining.start and waits for every cell to be air', async () => {
  const { ports, calls, blocks } = fakePorts()
  blocks.set('1,1,0', 'minecraft:stone')
  let started = null
  ports.mining = {
    preview: t => ({ ready: t.every(x => x.accessPreparation === 'quarry') }),
    start: t => { started = t; calls.push(['mine', t.length]); let i = 0; const next = () => { if (i >= t.length) return; blocks.delete(`${t[i].x},${t[i].y},${t[i].z}`); i++; setTimeout(next, 5) }; setTimeout(next, 5) }
  }
  let phase = 'idle'; ports.getMining = () => ({ phase: started && [...started].every(x => !blocks.has(`${x.x},${x.y},${x.z}`)) ? 'completed' : phase })
  const a = createQuarryRuntimeAdapter(ports)
  const r = await a.mine([{ x: 1, y: 0, z: 0, expectedName: 'minecraft:stone' }, { x: 1, y: 1, z: 0, expectedName: 'minecraft:stone' }, { x: 2, y: 0, z: 0, expectedName: 'minecraft:dirt' }])
  assert.equal(r.batched, true)
  assert.deepEqual(calls.filter(c => c[0] === 'mine'), [['mine', 3]])
  assert.equal(['1,0,0', '1,1,0', '2,0,0'].some(k => blocks.has(k)), false)
})

test('runtime adapter falls back to one target at a time when the batch preview is refused', async () => {
  const { ports, calls, blocks } = fakePorts()
  ports.mining.preview = t => ({ ready: t.length === 1 })
  const a = createQuarryRuntimeAdapter({ ...ports, previewSettleMs: 20 })
  const r = await a.mine([{ x: 1, y: 0, z: 0, expectedName: 'minecraft:stone' }, { x: 2, y: 0, z: 0, expectedName: 'minecraft:dirt' }])
  assert.notEqual(r.batched, true)
  assert.equal(calls.filter(c => c[0] === 'mine').length, 2)
  assert.equal(blocks.size, 0)
})

test('quarry preview: a permanent refusal never consumes the settling delay', async () => {
  for (const errors of [['対象の周辺に未取得のブロックがあります。'], ['対象ブロックが変更されたため停止しました。'], ['通常の地面に静止していることを確認できません。', '保護されたブロックは露天掘りでも壊しません。']]) {
    const { ports, calls } = fakePorts()
    let sleeps = 0; let previews = 0
    ports.mining.preview = () => { previews++; return { ready: false, errors } }
    const a = createQuarryRuntimeAdapter({ ...ports, sleep: async () => { sleeps++ } })
    await assert.rejects(() => a.mine([{ x: 1, y: 0, z: 0, expectedName: 'minecraft:stone' }]), /preview refused/)
    assert.equal(previews, 1)
    assert.equal(sleeps, 0)
    assert.equal(calls.length, 0, 'no break input was sent')
  }
})

test('quarry preview: only unsettled grounding retries, within one shared deadline', async () => {
  const { ports, calls, blocks } = fakePorts()
  let clock = 0; let previews = 0
  ports.mining = {
    preview: () => ({ ready: ++previews >= 3, errors: ['1,0,0: 通常の地面に静止していることを確認できません。'] }),
    start: targets => { calls.push(['mine']); for (const t of targets) blocks.delete(`${t.x},${t.y},${t.z}`) }
  }
  ports.getMining = () => ({ phase: 'completed' })
  const a = createQuarryRuntimeAdapter({ ...ports, now: () => clock, sleep: async ms => { clock += ms } })
  await a.mine([{ x: 1, y: 0, z: 0, expectedName: 'minecraft:stone' }])
  assert.equal(clock, 300)
  assert.equal(calls.length, 1)

  blocks.set('1,0,0', 'minecraft:stone')
  ports.mining.preview = () => ({ ready: false, errors: ['通常の地面に静止していることを確認できません。'] })
  const start = clock
  await assert.rejects(() => a.mine([{ x: 1, y: 0, z: 0, expectedName: 'minecraft:stone' }, { x: 2, y: 0, z: 0, expectedName: 'minecraft:dirt' }]), /preview refused/)
  assert.equal(clock - start, 3000, 'batch fallback does not restart the settling budget')
  assert.equal(calls.length, 1)
})

test('quarry preview: a hidden later face falls back without polling the unchanged batch', async () => {
  const { ports, blocks } = fakePorts()
  let sleeps = 0; let batches = 0
  ports.mining = {
    preview: targets => { if (targets.length > 1) batches++; return { ready: targets.length === 1, errors: ['射程内の採掘面への視線が遮られているか、未取得です。'] } },
    start: targets => { for (const t of targets) blocks.delete(`${t.x},${t.y},${t.z}`) }
  }
  ports.getMining = () => ({ phase: 'completed' })
  const a = createQuarryRuntimeAdapter({ ...ports, sleep: async () => { sleeps++ } })
  await a.mine([{ x: 1, y: 0, z: 0, expectedName: 'minecraft:stone' }, { x: 2, y: 0, z: 0, expectedName: 'minecraft:dirt' }])
  assert.equal(batches, 1)
  assert.equal(sleeps, 0)
  assert.equal(blocks.size, 0)
})

test('live case 2026-11-04: a block that breaks far slower than the held tool allows is stopped as SLOW_BREAK', async () => {
  const { ports } = fakePorts()
  let stopped = false
  ports.mining = { preview: () => ({ ready: true }), start: () => {}, stop: () => { stopped = true } } // the server never breaks it
  ports.getMining = () => ({ phase: 'mining' })
  const a = createQuarryRuntimeAdapter({ ...ports, slowBreakMinMs: 100 })
  const started = Date.now()
  await assert.rejects(() => a.mine([{ x: 1, y: 0, z: 0, expectedName: 'minecraft:stone' }]), e => e.code === 'SLOW_BREAK')
  assert.ok(Date.now() - started < 2000, 'stopped long before the 15s block timeout')
  assert.equal(stopped, true, 'the mining input is stopped')
})

test('live case 2026-11-10: gravel that refills from above restarts the slow-break clock instead of pausing the job', async () => {
  const { ports } = fakePorts()
  const blocks = new Map([['1,0,0', 'minecraft:gravel']]); let phase = 'idle'
  ports.getBlock = (x, y, z) => ({ known: true, name: blocks.get(`${x},${y},${z}`) ?? 'minecraft:air' })
  ports.mining = {
    preview: () => ({ ready: true }), stop: () => {},
    start: () => {
      phase = 'mining'
      const at = (ms, fn) => setTimeout(fn, ms)
      at(100, () => blocks.delete('1,0,0')); at(150, () => blocks.set('1,0,0', 'minecraft:gravel')) // broken, then refilled
      at(250, () => blocks.delete('1,0,0')); at(300, () => blocks.set('1,0,0', 'minecraft:gravel'))
      at(400, () => { blocks.delete('1,0,0'); phase = 'completed' })
    }
  }
  ports.getMining = () => ({ phase })
  const a = createQuarryRuntimeAdapter({ ...ports, slowBreakMinMs: 100 })
  const result = await a.mine([{ x: 1, y: 0, z: 0, expectedName: 'minecraft:gravel' }])
  assert.equal(result.phase, 'completed')
})

test('live case 2026-11-11: the live adapter exposes receipt-backed v2.2 startup, equipment and final storage ports', async () => {
  const { ports } = fakePorts()
  const calls = []
  const signal = new AbortController().signal
  const checkpoint = { phase: 'withdraw', index: 0 }
  const request = { jobId: 'live-v22', operationId: 'startup', checkpoint }
  const options = { signal, onCheckpoint: async () => {} }
  const withdrawn = { status: 'completed', serverConfirmed: true, checkpoint }
  const deposited = { status: 'completed', serverConfirmed: true, count: 34 }
  const equipped = { serverConfirmed: true, from: 'main', to: 'offhand' }
  const equipment = { offhand: { known: true, slots: [{ name: 'minecraft:totem_of_undying' }] } }
  const loggedOut = { disconnected: true }
  const failure = Object.assign(new Error('LOADOUT_TRANSFER_UNCONFIRMED'), { code: 'LOADOUT_TRANSFER_UNCONFIRMED' })
  let rejectWithdrawal = false
  const adapter = createQuarryRuntimeAdapter({
    ...ports,
    loadoutWithdraw: async (input, settings) => {
      calls.push(['withdraw', input, settings])
      if (rejectWithdrawal) throw failure
      return withdrawn
    },
    finalChestDeposit: async (input, settings) => { calls.push(['deposit', input, settings]); return deposited },
    equipmentTransfer: async input => { calls.push(['equipment', input]); return equipped },
    equipmentView: () => { calls.push(['view']); return equipment },
    logout: async () => { calls.push(['logout']); return loggedOut }
  })

  assert.equal(await adapter.loadoutWithdraw(request, options), withdrawn)
  assert.equal(calls[0][1], request, 'checkpoint-bearing requests are not rewritten')
  assert.equal(calls[0][2], options, 'abort signal and checkpoint persistence callback survive the adapter')
  assert.equal(calls[0][2].signal, signal)
  assert.equal(calls[0][2].onCheckpoint, options.onCheckpoint)

  assert.equal(await adapter.finalChestDeposit(request, options), deposited)
  assert.equal(calls[1][1], request)
  assert.equal(calls[1][2], options)
  const transfer = { from: 'main', fromSlot: 8, to: 'offhand', toSlot: 0, expectedName: 'minecraft:totem_of_undying', signal }
  assert.equal(await adapter.equipmentTransfer(transfer), equipped)
  assert.equal(calls[2][1], transfer)
  assert.equal(calls[2][1].signal, signal)
  assert.equal(adapter.equipmentView(), equipment)
  assert.equal(await adapter.logout(), loggedOut)
  assert.deepEqual(calls.map(call => call[0]), ['withdraw', 'deposit', 'equipment', 'view', 'logout'])

  rejectWithdrawal = true
  await assert.rejects(() => adapter.loadoutWithdraw(request, options), error => error === failure)
  assert.equal(calls.filter(call => call[0] === 'withdraw').length, 2, 'an unconfirmed withdrawal is neither converted to success nor retried')
})

test('runtime adapter leaves unsupported v2.2 ports absent so planning can reject the unavailable runtime', () => {
  const { ports } = fakePorts()
  const names = ['loadoutWithdraw', 'finalChestDeposit', 'equipmentTransfer', 'equipmentView', 'logout']
  for (const unsupported of [undefined, null, false, {}]) {
    const adapter = createQuarryRuntimeAdapter({ ...ports, ...Object.fromEntries(names.map(name => [name, unsupported])) })
    for (const name of names) {
      assert.equal(Object.hasOwn(adapter, name), false, `${name} must not advertise a fabricated implementation`)
    }
  }
})

test('runtime adapter preserves the v2.2 supply layout and discovery results or errors', () => {
  const { ports } = fakePorts()
  const layouts = []
  const received = { ok: true, bindings: [{ role: 'totem' }] }
  const failure = Object.assign(new Error('SUPPLY_BOXES_UNCONFIRMED'), { code: 'SUPPLY_BOXES_UNCONFIRMED' })
  let rejectDiscovery = false
  const adapter = createQuarryRuntimeAdapter({
    ...ports,
    discoverSupplies: layout => {
      layouts.push(layout)
      if (rejectDiscovery) throw failure
      return received
    }
  })
  assert.equal(adapter.discoverSupplies('v22'), received)
  assert.equal(adapter.discoverSupplies('legacy'), received)
  assert.equal(adapter.discoverSupplies(), received)
  assert.deepEqual(layouts, ['v22', 'legacy', undefined], 'the totem supply layout must not silently become legacy bread supplies')
  rejectDiscovery = true
  assert.throws(() => adapter.discoverSupplies('v22'), error => error === failure)
})

test('live case 2026-11-13: a move to the cell the bot already stands in re-centres when off by more than 0.25 m', async () => {
  const { ports, calls, state } = fakePorts()
  state.position = { x: 0.94, y: 1.62, z: 0.46 }
  const a = createQuarryRuntimeAdapter(ports)
  await a.moveTo({ x: 0, y: 0, z: 0 })
  const moves = calls.filter(c => c[0] === 'move')
  assert.equal(moves.length, 1)
  assert.ok(Math.abs(state.position.x - 0.5) < 0.01 && Math.abs(state.position.z - 0.5) < 0.01)
  const near = fakePorts(); near.state.position = { x: 0.6, y: 1.62, z: 0.5 }
  await createQuarryRuntimeAdapter(near.ports).moveTo({ x: 0, y: 0, z: 0 })
  assert.equal(near.calls.filter(c => c[0] === 'move').length, 0, 'already near the centre: no move')
})
