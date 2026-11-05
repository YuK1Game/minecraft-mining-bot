'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createQuarryJob } = require('../src/quarry-job')
const { createSim, flatTerrain } = require('./helpers/quarry-sim')

function fixture ({ unreachableFirst = false } = {}) {
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
  const docs = []; const lines = []
  const j = createQuarryJob({ adapter: sim.adapter, storage: { save: async (id, doc) => { docs.push(doc) } }, log: line => lines.push(line), sleep: () => new Promise(resolve => setImmediate(resolve)), pollMs: 5 })
  const plan = j.plan({ jobId: 'storage-reachability', target: { chunks: [{ x: 0, z: 0 }] }, yTop: 62, yBottom: 62, worldMinY: 50, worldMaxY: 75, inventory: { storage: [first, second] } })
  assert.equal(plan.ready, true, JSON.stringify(plan.issues))
  return { sim, j, docs, lines, first, second }
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
