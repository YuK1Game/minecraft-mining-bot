'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createIncidentRecorder } = require('../src/modes/incident-snapshot')

test('incident-snapshot: captures compact terrain, inventory, goal and journal with cooldown and rolling cap', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mmb-incident-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const logs = []
  let nowMs = Date.parse('2026-11-24T12:00:00.000Z')
  const shared = {
    vitals: { hunger: 17 },
    decisionJournal: { 遠征: { key: 'early.home_reserve#1|mine', since: nowMs - 60000, at: nowMs, turns: 1, text: '遠征 採掘場を進めます' } }
  }
  const recorder = createIncidentRecorder({
    root,
    shared,
    getState: () => ({ dimension: 'overworld', health: 14, dead: false, position: { x: 10.5, y: 65.62, z: -4.5 } }),
    getFeet: () => ({ x: 10.5, y: 64, z: -4.5 }),
    getBlock: (x, y, z) => {
      if (y === 63 && Math.abs(x - 10) <= 1 && Math.abs(z + 5) <= 1) return { known: true, name: 'minecraft:stone' }
      if (y >= 64 && Math.abs(x - 10) <= 1 && Math.abs(z + 5) <= 1) return { known: true, name: 'minecraft:air' }
      return { known: false }
    },
    getInventory: () => ({ known: true, items: [{ slot: 0, name: 'minecraft:iron_pickaxe', count: 1, durabilityKnown: true, durabilityRemaining: 80, maxDurability: 250 }] }),
    getGoal: () => ({ id: 'early.home_reserve#1', key: 'early.home_reserve', stalledMs: 300000, decisions: 3, holds: 1, hold: { code: 'NO_PROGRESS', until: nowMs + 600000 } }),
    log: line => logs.push(line),
    now: () => nowMs,
    maxFiles: 2,
    cooldownMs: 60000,
    radius: 2
  })

  const first = await recorder.capture({ source: 'expedition', code: 'NO_PROGRESS', reason: '採掘が進みません', stage: 'early' })
  assert.equal(first.captured, true)
  assert.equal(fs.existsSync(first.file), true)
  const saved = JSON.parse(fs.readFileSync(first.file, 'utf8'))
  assert.equal(saved.code, 'NO_PROGRESS')
  assert.equal(saved.world.health, 14)
  assert.equal(saved.world.hunger, 17)
  assert.equal(saved.inventory.items[0].name, 'minecraft:iron_pickaxe')
  assert.ok(saved.terrain.nonAirKnown.some(([, y, , name]) => y === 63 && name === 'minecraft:stone'))
  assert.ok(saved.terrain.unknownCount > 0)

  // Same key within cooldown is deduplicated.
  const deduped = await recorder.capture({ source: 'expedition', code: 'NO_PROGRESS', reason: 'repeat' })
  assert.equal(deduped.captured, false)
  assert.equal(deduped.reason, 'COOLDOWN')

  // Rolling file cap prunes oldest incidents.
  nowMs += 120000
  await recorder.capture({ source: 'return', code: 'CHEST_UNREACHED', reason: 'c1' })
  nowMs += 120000
  await recorder.capture({ source: 'return', code: 'TRANSFER_REJECTED', reason: 'c2' })
  const files = fs.readdirSync(recorder.directory).filter(f => f.endsWith('.json'))
  assert.equal(files.length, 2)
  assert.ok(logs.some(line => line.includes('.local/incidents/')))
})
