'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const Module = require('node:module')
const { createIncidentRecorder } = require('../src/modes/incident-snapshot')
const { loadIncidentScene, inspectIncidentTerrain, normalizeIncidentFixture, buildIncidentTestSource } = require('../src/modes/incident-replay')
const { collectDiagnostics, formatDiagnosticsText } = require('../src/common/diagnose-report')

test('schema-2 incident snapshot replays exact received terrain, hazards, and generated test scaffold', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mmb-diagnose-'))
  try {
    const blocks = new Map([
      ['10,63,20', { known: true, name: 'minecraft:netherrack', boundingBox: 'block' }],
      ['10,64,20', { known: true, name: 'minecraft:air', boundingBox: 'empty' }],
      ['10,65,20', { known: true, name: 'minecraft:air', boundingBox: 'empty' }],
      ['11,63,20', { known: true, name: 'minecraft:lava', boundingBox: 'empty' }],
      ['12,63,20', { known: true, name: 'minecraft:water', boundingBox: 'empty' }]
    ])
    const shared = {
      vitals: { hunger: 14 },
      decisionJournal: {
        expedition: { key: 'nether.fortress', since: 1000, at: 2000, turns: 4 }
      }
    }
    const recorder = createIncidentRecorder({
      root,
      shared,
      now: () => Date.UTC(2026, 10, 26, 10, 55, 0),
      getState: () => ({ dimension: 'nether', health: 15, dead: false, position: { x: 10.5, y: 65.62, z: 20.5 } }),
      getFeet: () => ({ x: 10.5, y: 64, z: 20.5 }),
      getBlock: (x, y, z) => blocks.get(`${x},${y},${z}`) ?? { known: false },
      getInventory: () => ({ known: true, items: [{ slot: 0, name: 'minecraft:diamond_sword', count: 1 }, { slot: 1, name: 'minecraft:gold_ingot', count: 12 }] }),
      getGoal: () => ({ id: 'g1', key: 'nether.fortress', stalledMs: 300000, decisions: 9, holds: 0, hold: null }),
      radius: 2
    })

    const saved = await recorder.capture({ source: 'expedition', code: 'NETHER_STALL', reason: '要塞の足場が見つかりません', stage: 'nether' })
    assert.equal(saved.captured, true)

    const scene = loadIncidentScene(saved.doc)
    assert.deepEqual(scene.getFeet(), { x: 10.5, y: 64, z: 20.5 })
    assert.equal(scene.getState().dimension, 'nether')
    assert.equal(scene.getBlock(10, 63, 20).name, 'minecraft:netherrack')
    assert.equal(scene.getBlock(11, 63, 20).name, 'minecraft:lava')
    assert.equal(scene.getBlock(9, 64, 20).known, false, 'unobserved cell stays unknown')
    assert.equal(scene.getBlock(999, 64, 20).known, false, 'outside cell stays unknown')

    const summary = inspectIncidentTerrain(saved.doc.terrain)
    assert.equal(summary.available, true)
    assert.equal(summary.hazardCells, 1)
    assert.equal(summary.waterCells, 1)
    assert.ok(summary.unknownCells > 0)

    const normalized = normalizeIncidentFixture(saved.doc)
    const testCode = buildIncidentTestSource({ fixtureRelPath: './fixtures/sample.json', slug: 'nether-stall', doc: normalized })
    assert.doesNotThrow(() => new vm.Script(Module.wrap(testCode), { filename: 'generated-incident.test.js' }))

    fs.mkdirSync(path.join(root, '.local'), { recursive: true })
    fs.writeFileSync(path.join(root, '.local', 'mode.json'), JSON.stringify({ mode: 'player' }))
    const report = collectDiagnostics({ root })
    assert.equal(report.mode, 'player')
    assert.equal(report.incidentCount, 1)
    assert.equal(report.latestIncident.code, 'NETHER_STALL')
    const text = formatDiagnosticsText(report)
    assert.match(text, /NETHER_STALL/)
    assert.match(text, /nether\.fortress/)
    assert.match(text, /diamond_swordx1/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
