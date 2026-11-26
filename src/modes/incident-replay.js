'use strict'

// Replays a schema-2 incident snapshot (saved by `incident-snapshot.js`) as a
// deterministic test scene and generates minimal regression test scaffolding
// without fabricating unobserved blocks or inventory slots.
const { replayTerrain } = require('./incident-terrain')

const HAZARD_NAME = /lava|fire|magma|cactus|campfire|powder_snow|cobweb|wither_rose|dripstone|sweet_berry/
const WATER_NAME = /^minecraft:(?:flowing_)?water$/
const AIR_NAME = /^minecraft:(?:air|cave_air|void_air)$/

function inspectIncidentTerrain (terrain) {
  if (!terrain) {
    return { available: false, totalCells: 0, knownCells: 0, unknownCells: 0, hazardCells: 0, waterCells: 0, airCells: 0, solidCells: 0, hazards: [] }
  }
  const { getBlock } = replayTerrain(terrain)
  if (terrain.version !== 2 || !terrain.center || !Number.isSafeInteger(terrain.radius)) {
    const legacy = Array.isArray(terrain.nonAirKnown) ? terrain.nonAirKnown : []
    return {
      available: true,
      version: terrain.version ?? 1,
      totalCells: legacy.length,
      knownCells: legacy.length,
      unknownCells: 0,
      hazardCells: legacy.filter(([, , , name]) => HAZARD_NAME.test(String(name ?? ''))).length,
      waterCells: legacy.filter(([, , , name]) => WATER_NAME.test(String(name ?? ''))).length,
      airCells: 0,
      solidCells: legacy.length,
      hazards: legacy.filter(([, , , name]) => HAZARD_NAME.test(String(name ?? ''))).slice(0, 12).map(([x, y, z, name]) => ({ x, y, z, name }))
    }
  }
  const { center, radius, dy = [-2, 3] } = terrain
  let totalCells = 0
  let knownCells = 0
  let unknownCells = 0
  let hazardCells = 0
  let waterCells = 0
  let airCells = 0
  let solidCells = 0
  const hazards = []

  for (let oy = dy[0]; oy <= dy[1]; oy++) {
    for (let ox = -radius; ox <= radius; ox++) {
      for (let oz = -radius; oz <= radius; oz++) {
        totalCells++
        const x = center.x + ox
        const y = center.y + oy
        const z = center.z + oz
        const block = getBlock(x, y, z)
        if (block?.known !== true) {
          unknownCells++
          continue
        }
        knownCells++
        const name = String(block.name ?? '')
        if (HAZARD_NAME.test(name)) {
          hazardCells++
          if (hazards.length < 12) hazards.push({ x, y, z, name })
        } else if (WATER_NAME.test(name)) {
          waterCells++
        } else if (AIR_NAME.test(name)) {
          airCells++
        } else {
          solidCells++
        }
      }
    }
  }
  return { available: true, version: 2, center, radius, dy, totalCells, knownCells, unknownCells, hazardCells, waterCells, airCells, solidCells, hazards }
}

function loadIncidentScene (doc) {
  if (!doc || typeof doc !== 'object') throw new Error('Incident document is required')
  const { getBlock } = replayTerrain(doc.terrain ?? null)
  const feet = doc.world?.feet && ['x', 'y', 'z'].every(k => Number.isFinite(doc.world.feet[k]))
    ? { x: doc.world.feet.x, y: doc.world.feet.y, z: doc.world.feet.z }
    : null
  const position = feet ? { x: feet.x, y: Number((feet.y + 1.62).toFixed(3)), z: feet.z } : null
  const inventory = doc.inventory?.known === true
    ? {
        known: true,
        uncertain: false,
        items: (doc.inventory.items ?? []).map(item => ({ ...item }))
      }
    : { known: false, uncertain: true, items: [] }

  const state = {
    phase: doc.world?.dead === true ? 'dead' : 'spawned',
    dead: doc.world?.dead === true,
    dimension: doc.world?.dimension ?? 'overworld',
    health: Number.isFinite(doc.world?.health) ? doc.world.health : null,
    position,
    inventory
  }

  return {
    version: doc.version ?? 1,
    capturedAt: doc.capturedAt ?? null,
    source: doc.source ?? 'unknown',
    code: doc.code ?? 'UNKNOWN',
    stage: doc.stage ?? null,
    reason: doc.reason ?? null,
    goal: doc.goal ? structuredClone(doc.goal) : null,
    journal: doc.journal ? structuredClone(doc.journal) : {},
    getBlock,
    getFeet: () => (feet ? { ...feet } : null),
    getPosition: () => (position ? { ...position } : null),
    getState: () => structuredClone(state),
    getInventory: () => (inventory.known ? structuredClone(inventory) : null),
    terrainSummary: () => inspectIncidentTerrain(doc.terrain ?? null)
  }
}

function normalizeIncidentFixture (doc) {
  if (!doc || typeof doc !== 'object') throw new Error('Incident document is required')
  return {
    version: doc.version ?? 2,
    capturedAt: doc.capturedAt ?? null,
    source: String(doc.source ?? 'mode'),
    code: String(doc.code ?? 'STALL'),
    stage: doc.stage ?? null,
    reason: doc.reason ?? null,
    world: doc.world ? structuredClone(doc.world) : null,
    goal: doc.goal ? structuredClone(doc.goal) : null,
    journal: doc.journal ? structuredClone(doc.journal) : {},
    inventory: doc.inventory ? structuredClone(doc.inventory) : { known: false, items: [] },
    terrain: doc.terrain ? structuredClone(doc.terrain) : null
  }
}

function buildIncidentTestSource ({ fixtureRelPath, slug, doc }) {
  const safeSlug = String(slug || doc?.code || 'incident').replace(/[^A-Za-z0-9_-]+/g, '-')
  const rel = String(fixtureRelPath || `./fixtures/${safeSlug}.json`).replace(/\\/g, '/')
  return [
    "'use strict'",
    '',
    "const { test } = require('node:test')",
    "const assert = require('node:assert/strict')",
    "const path = require('node:path')",
    "const fs = require('node:fs')",
    "const { loadIncidentScene } = require('../src/modes/incident-replay')",
    '',
    `test('incident replay: ${safeSlug} reproduces captured terrain and state without unknown-as-air', () => {`,
    `  const doc = JSON.parse(fs.readFileSync(path.resolve(__dirname, '${rel}'), 'utf8'))`,
    '  const scene = loadIncidentScene(doc)',
    '  const feet = scene.getFeet()',
    '  assert.ok(feet, \'captured feet position is present\')',
    '  const summary = scene.terrainSummary()',
    '  assert.equal(summary.available, true)',
    '  const outside = scene.getBlock(Math.floor(feet.x) + 999, Math.floor(feet.y), Math.floor(feet.z))',
    '  assert.equal(outside.known, false)',
    '})',
    ''
  ].join('\n')
}

module.exports = {
  inspectIncidentTerrain,
  loadIncidentScene,
  normalizeIncidentFixture,
  buildIncidentTestSource
}
