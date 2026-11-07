'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createQuarryJob } = require('../src/quarry-job')
const { createSim, flatTerrain } = require('./helpers/quarry-sim')

function fixture ({ unreachableFirst = false, fakeClock = false } = {}) {
  const loaded = { xMin: -12, xMax: 28, yMin: 50, yMax: 75, zMin: -12, zMax: 28 }
  const sim = createSim({ loaded })
  flatTerrain(sim, { x1: -12, x2: 28, z1: -12, z2: 28, bedrock: 50, stoneTop: 62, top: 62 })
  sim.setFeet({ x: -3, y: 63, z: 5 })
  sim.give('diamond_pickaxe'); sim.give('diamond_shovel'); sim.give('bread', 5)
  for (let i = 0; i < 31; i++) sim.give('andesite', 64)

  const first = { position: { x: -4, y: unreachableFirst ? 66 : 63, z: -4 }, stand: { x: -3, y: unreachableFirst ? 66 : 63, z: -4 } }
  const second = { position: { x: -4, y: 63, z: -1 }, stand: { x: -3, y: 63, z: -1 } }
  for (const st of [first, second]) sim.world.set(st.position.x, st.position.y, st.position.z, 'chest')
  // The first stand is valid, but its isolated raised floor has no walking route.
  if (unreachableFirst) sim.world.set(first.stand.x, first.stand.y - 1, first.stand.z, 'stone')
  const docs = []; const lines = []; const sleeps = []; let time = 0
  const j = createQuarryJob({ adapter: sim.adapter, storage: { save: async (id, doc) => { docs.push(doc) } }, log: line => lines.push(line), ...(fakeClock ? { now: () => time } : {}), sleep: ms => { sleeps.push(ms); if (fakeClock) time += ms; return new Promise(resolve => setImmediate(resolve)) }, pollMs: 5 })
  const plan = j.plan({ jobId: 'storage-reachability', exit: { mode: 'legacy_stair' }, target: { chunks: [{ x: 0, z: 0 }] }, yTop: 62, yBottom: 62, worldMinY: 50, worldMaxY: 75, inventory: { storage: [first, second] } })
  assert.equal(plan.ready, true, JSON.stringify(plan.issues))
  return { sim, j, docs, lines, first, second, sleeps, elapsed: () => time }
}

async function until (predicate, description) {
  const deadline = Date.now() + 5000
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(predicate(), description)
}

test('an unroutable registered chest is skipped and the next chest receives the deposit', async () => {
  const { sim, j, docs, lines, first, second } = fixture({ unreachableFirst: true })
  const travelled = []
  const goToStorage = sim.adapter.goToStorage
  sim.adapter.goToStorage = async (st, options) => { travelled.push(st.position); return goToStorage(st, options) }
  j.start()
  try {
    await until(() => sim.stats.deposits > 0 || j.status().state === 'PAUSED', 'storage attempt completed')
    assert.ok(sim.stats.deposits > 0, `next chest received items: ${j.status().pauseReason}`)
    assert.deepEqual(travelled[0], second.position)
    assert.ok(sim.chests.get(`${second.position.x},${second.position.y},${second.position.z}`)?.length > 0)
    assert.ok(lines.some(line => line.includes('storage_unroutable')))
  } finally { await j.pause() }
  assert.ok(docs.at(-1).fullStorage.includes(`${first.position.x},${first.position.y},${first.position.z}`))
})

for (const interruption of ['stop', 'combat', 'death']) {
  test(`a ${interruption} interruption while returning does not skip the chest`, async () => {
    const { sim, j, docs, lines } = fixture()
    let returning = false
    sim.adapter.goToStorage = async () => { returning = true; await new Promise(() => {}) }
    j.start()
    try {
      await until(() => returning, 'return movement started')
      if (interruption === 'stop') {
        await j.pause()
        assert.equal(j.status().pauseReason, 'MANUAL_PAUSE')
      } else if (interruption === 'combat') {
        sim.setCombat(true)
        await until(() => j.status().state === 'COMBAT', 'combat took control')
      } else {
        sim.state.dead = true
        await until(() => j.status().state === 'PAUSED', 'death paused the job')
        assert.equal(j.status().pauseReason, 'DEATH')
        assert.equal(j.status().deaths.length, 1)
      }
      assert.equal(sim.stats.deposits, 0)
      assert.equal(lines.some(line => line.includes('storage_unroutable')), false)
    } finally { await j.pause() }
    assert.deepEqual(docs.at(-1).fullStorage ?? [], [])
  })
}

const dangerousActors = () => [{ kind: 'mob', hostile: true, alive: true, entityType: 'minecraft:creeper', position: { x: -4, y: 63, z: -4 } }]

test('an unreachable old chest is skipped before its hostile wait; the usable chest still waits once', async () => {
  const f = fixture({ unreachableFirst: true, fakeClock: true })
  f.sim.adapter.actors = dangerousActors
  f.j.start()
  try {
    await until(() => f.sim.stats.deposits > 0 || f.j.status().state === 'PAUSED', 'reachable chest received storage')
    assert.ok(f.sim.stats.deposits > 0)
    assert.equal(f.lines.filter(line => line.includes('storage_area_hostile')).length, 1)
    assert.equal(f.lines.filter(line => line.includes('storage_area_wait_timeout')).length, 1)
    assert.equal(f.sleeps.filter(ms => ms === 2000).length, 10)
    assert.ok(f.docs.some(d => d.fullStorage?.includes(`${f.first.position.x},${f.first.position.y},${f.first.position.z}`)))
  } finally { await f.j.pause() }
})

test('a valid planner path with no native first segment is skipped before the hostile wait', async () => {
  const f = fixture({ fakeClock: true }), previews = [], travelled = []
  f.sim.adapter.actors = dangerousActors
  f.sim.adapter.previewStorage = async (st, options) => { previews.push({ position: st.position, path: options.path }); return { ready: st.position.z !== f.first.position.z, reason: 'No ready native storage segment' } }
  const go = f.sim.adapter.goToStorage
  f.sim.adapter.goToStorage = async (st, options) => { travelled.push(st.position); return go(st, options) }
  f.j.start()
  try {
    await until(() => f.sim.stats.deposits > 0 || f.j.status().state === 'PAUSED', 'native ready storage received items')
    assert.ok(f.sim.stats.deposits > 0)
    assert.deepEqual(previews[0].position, f.first.position)
    assert.ok(previews[0].path.length > 0)
    assert.deepEqual(travelled[0], f.second.position)
    assert.equal(f.lines.filter(line => line.includes('storage_area_hostile')).length, 1)
    assert.ok(f.lines.some(line => line.includes('storage_unroutable')))
  } finally { await f.j.pause() }
})

test('all full chests at the expansion cap cause no hostile wait before the bounded storage pause', async () => {
  const f = fixture({ fakeClock: true }), saved = f.j.document()
  saved.config.inventory.maxChests = 2
  saved.fullStorage = [f.first, f.second].map(st => `${st.position.x},${st.position.y},${st.position.z}`)
  f.j.load(saved); f.sim.adapter.actors = dangerousActors
  f.j.start()
  try {
    await until(() => f.j.status().state === 'PAUSED', 'all-full cap paused')
    assert.equal(f.j.status().pauseReason, 'WAITING_FOR_STORAGE')
    assert.equal(f.j.status().pauseDetails.addChest.reason, 'MAX_CHESTS')
    assert.equal(f.lines.some(line => line.includes('storage_area_hostile')), false)
    assert.equal(f.sleeps.filter(ms => ms === 2000).length, 0)
  } finally { await f.j.pause() }
})

test('a typed BUSY preview is retried without caching the chest as full or unreachable', async () => {
  const f = fixture({ fakeClock: true }); let previewed = false
  f.sim.adapter.previewStorage = () => { previewed = true; throw Object.assign(new Error('native controller busy'), { code: 'BUSY' }) }
  f.j.start()
  try {
    await until(() => previewed, 'typed busy preview reached')
    assert.equal(f.lines.some(line => line.includes('storage_unroutable')), false)
    assert.equal(f.sim.stats.deposits, 0)
  } finally { await f.j.pause() }
  assert.deepEqual(f.docs.at(-1).fullStorage ?? [], [])
  assert.ok(f.sleeps.includes(100))
})

test('actual return recomputes the path after the hostile wait instead of reusing the preview origin', async () => {
  const f = fixture({ fakeClock: true }), previews = [], returned = []
  const origin = f.sim.feet(); let moved = false
  f.sim.adapter.actors = () => {
    if (!moved && f.elapsed() >= 2000) { moved = true; f.sim.setFeet({ x: -2, y: 63, z: 5 }) }
    return dangerousActors()
  }
  f.sim.adapter.previewStorage = (st, options) => { previews.push(options.path); return { ready: true } }
  const go = f.sim.adapter.goToStorage
  f.sim.adapter.goToStorage = async (st, options) => { returned.push(options.path); return go(st, options) }
  f.j.start()
  try {
    await until(() => f.sim.stats.deposits > 0 || f.j.status().state === 'PAUSED', 'fresh actual path moved')
    assert.ok(f.sim.stats.deposits > 0)
    assert.deepEqual(previews[0][0], origin)
    assert.deepEqual(returned[0][0], { x: -2, y: 63, z: 5 })
    assert.equal(f.lines.filter(line => line.includes('storage_area_wait_timeout')).length, 1)
  } finally { await f.j.pause() }
})

for (const interruption of ['stop', 'combat', 'death']) {
  test(`a ${interruption} interruption during storage preview is never cached as a route failure`, async () => {
    const f = fixture(); let previewing = false
    f.sim.adapter.previewStorage = async () => { previewing = true; await new Promise(() => {}) }
    f.j.start()
    try {
      await until(() => previewing, 'storage preview started')
      if (interruption === 'stop') await f.j.pause()
      else if (interruption === 'combat') { f.sim.setCombat(true); await until(() => f.j.status().state === 'COMBAT', 'preview yielded combat') }
      else { f.sim.state.dead = true; await until(() => f.j.status().state === 'PAUSED', 'preview stopped on death') }
      assert.equal(f.lines.some(line => line.includes('storage_unroutable')), false)
      assert.equal(f.sim.stats.deposits, 0)
    } finally { await f.j.pause() }
    assert.deepEqual(f.docs.at(-1).fullStorage ?? [], [])
  })
}
