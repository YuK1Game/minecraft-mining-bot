'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createShoreLandmarks } = require('../src/shore-landmarks')
const { createMissionMemory } = require('../src/mission-memory')
const { planHut } = require('../src/hut-planner')

const scope = { realmId: '21225335', profile: 'bot', dimension: 'overworld' }
async function fixture (t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraftbot-shore-landmarks-'))
  const local = path.join(root, '.local')
  t.after(async () => {
    try {
      for (const name of await fs.readdir(local)) {
        const file = path.resolve(local, name)
        assert.equal(path.dirname(file), local)
        const stat = await fs.lstat(file)
        assert.equal(stat.isDirectory(), false)
        await fs.unlink(file)
      }
      await fs.rmdir(local)
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    await fs.rmdir(root)
  })
  return { root, local, file: path.join(local, 'shore-landmarks.json'), create: () => createShoreLandmarks({ workspaceRoot: root, clock: () => 1000 }) }
}
function survey () {
  return { observationOnly: true, origin: { x: 0.5, y: 64.62, z: 0.5 }, radius: 8, knownCandidateCount: 1, candidates: [{ x: -4.5, y: 63, z: 0.5, distance: 5, floor: 'minecraft:stone' }] }
}
function hutMemo () {
  const state = { phase: 'spawned', health: 20, gameMode: 'survival', realm: { id: scope.realmId }, dimension: scope.dimension, runtimeEntityId: '41', position: { x: 0.5, y: 66.62, z: 0.5 }, positionSource: 'move_player', positionUpdatedAt: 'hut-pose', connectionId: 'old-connection', inventory: { known: true, items: [] }, entities: [] }
  const getBlock = (x, y, z) => ({ known: true, name: y < 65 ? 'minecraft:grass_block' : 'minecraft:air', boundingBox: y < 65 ? 'block' : 'empty', runtimeId: y < 65 ? 10 : 0, extra: [] })
  const site = planHut(state, { getBlock }, { radius: 0 })
  assert.equal(site.ready, true)
  const temporary = new Set(site.temporaryPillar.map(p => [p.x, p.y, p.z].join(',')))
  return { version: 1, kind: 'soil_hut', scope: { realmId: scope.realmId, dimension: scope.dimension }, site, stepIndex: 30, totalActions: 32, placements: site.ownedBuildCells.map((position, index) => ({ position, item: 'minecraft:dirt', count: 1, serverConfirmed: true, confirmedBy: 'received_dirt_and_inventory_decrease', requestId: -2 - index * 2, ...(temporary.has([position.x, position.y, position.z].join(',')) ? { removed: true } : {}) })), established: true, recoveredTemporaryDirt: true, reclaimBaseline: 0, pendingPlacement: null }
}

test('missing shore memory is passive; an observed candidate survives a reconnect as direction only', async t => {
  const f = await fixture(t); const store = f.create()
  assert.equal((await store.load()).status, 'missing')
  await assert.rejects(fs.stat(f.local), { code: 'ENOENT' })
  assert.equal(store.rememberSurvey(scope, survey()).remembered, 1)
  await store.save()
  const resumed = f.create()
  assert.equal((await resumed.load()).status, 'loaded')
  const toward = resumed.directionScore(scope, { x: 0.5, y: 64, z: 0.5 }, { x: -0.5, y: 63, z: 0.5 })
  const away = resumed.directionScore(scope, { x: 0.5, y: 64, z: 0.5 }, { x: 1.5, y: 63, z: 0.5 })
  assert.equal(toward.progress, 1)
  assert.equal(away.progress, -1)
  assert.equal(toward.observationOnly, true)
  assert.equal(toward.requiresWorldValidation, true)
  assert.equal(Object.hasOwn(toward, 'ready'), false)
  assert.equal(Object.hasOwn(toward, 'terrain'), false)
  assert.equal(Object.hasOwn(toward, 'serverConfirmed'), false)
})

test('shore memory cannot guide another profile, Realm or dimension', async t => {
  const f = await fixture(t); const store = f.create()
  store.rememberSurvey(scope, survey())
  for (const other of [{ ...scope, profile: 'other' }, { ...scope, realmId: '77' }, { ...scope, dimension: 'nether' }]) {
    assert.deepEqual(store.entries(other), [])
    assert.equal(store.directionScore(other, { x: 0, y: 64, z: 0 }, { x: 1, y: 64, z: 0 }), null)
  }
  const returned = store.entries(scope); returned[0].position.x = 999
  assert.equal(store.entries(scope)[0].position.x, -4.5)
})

test('invalid survey provenance, geometry and unsafe floor observations are rejected without partial insertion', async t => {
  const f = await fixture(t); const store = f.create()
  for (const bad of [
    { ...survey(), observationOnly: false },
    { ...survey(), radius: 65 },
    { ...survey(), candidates: [{ ...survey().candidates[0], x: -20 }] },
    { ...survey(), candidates: [{ ...survey().candidates[0], distance: 2 }] },
    { ...survey(), candidates: [{ ...survey().candidates[0], floor: 'minecraft:water' }] },
    { ...survey(), candidates: [{ ...survey().candidates[0], floor: 'minecraft:cave_air' }] },
    { ...survey(), candidates: [{ ...survey().candidates[0], y: 100 }] }
  ]) assert.throws(() => store.rememberSurvey(scope, bad))
  assert.equal(store.snapshot().landmarkCount, 0)
  assert.throws(() => store.rememberSurvey({ ...scope, profile: '../.auth' }, survey()))
  assert.equal(store.directionScore(scope, { x: 0, y: 64, z: 0 }, { x: 25, y: 64, z: 0 }), null)
})

test('invalid persisted coordinates are rejected and do not enter the ranking cache', async t => {
  const f = await fixture(t)
  await fs.mkdir(f.local)
  await fs.writeFile(f.file, JSON.stringify({ version: 1, scopes: [{ scope, landmarks: [{ source: 'observed_dry_candidate', recordedAt: 1000, position: { x: 40000000, y: 63, z: 0 } }] }] }))
  const store = f.create()
  assert.equal((await store.load()).status, 'rejected')
  assert.equal(store.snapshot().landmarkCount, 0)
})

test('only validated established shelter history supplies a durable directional landmark', async t => {
  const f = await fixture(t)
  const mission = createMissionMemory({ workspaceRoot: f.root })
  const memo = hutMemo()
  await mission.save({ ...scope, shelterMemo: memo })
  const store = f.create()
  const result = await store.seedShelterHistory(scope)
  assert.equal(result.remembered, 1)
  assert.equal(result.landmark.source, 'established_shelter_history')
  assert.deepEqual(result.landmark.position, memo.site.outsideStandpoint)
  assert.equal(result.requiresWorldValidation, true)
  assert.equal((await store.seedShelterHistory({ ...scope, realmId: '99' })).remembered, 0)
  await store.save()
  const resumed = f.create(); await resumed.load()
  assert.equal(resumed.entries(scope)[0].source, 'established_shelter_history')
  await mission.save({ ...scope, shelterMemo: { ...memo, established: false } })
  const unestablished = f.create()
  assert.equal((await unestablished.seedShelterHistory(scope)).remembered, 0)
})
