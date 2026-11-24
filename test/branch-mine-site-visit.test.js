'use strict'

// The site search of the planned branch mine, joined: the actual nextMine, planner, survey, Host World,
// terrain requester, observation walk and mine ports (helpers/branch-mine-observation-world.js).
// Stand-ins: the peer's terrain and position receipts, and the long trip (ctx.travelTo). The trip here moves
// the pose and has the peer announce the columns around the new place, which is what arriving does.
//
// Live 2026-11-22 17:50 JST - 2026-11-23 06:53 JST: 17 centres, 8 rejected, 9 deferred as unreceivable from
// where the Bot stood, then MINE_OBSERVATION_EXHAUSTED for thirteen hours. Nothing moved the Bot.
const test = require('node:test'), assert = require('node:assert/strict')
const { observationWorld } = require('./helpers/branch-mine-observation-world')
const { nextMine, originAt } = require('../src/modes/mining/mine-sites')
const { createMineGeometry } = require('../src/modes/mining/mine-geometry')
const { mineWorldScope } = require('../src/modes/mining/mine-state')
const { MAX_VISITS } = require('../src/modes/mining/mine-site-visit')

const tick = async f => { f.advance(10000); return nextMine(f.ctx, 'raw_iron', 1) }
// No level walk leaves the home: the frontier around the feet is stone or unreceived.
const walled = f => { for (const [x, z] of [[1, 0], [0, 1], [0, -1]]) f.put({ x, y: 64, z }, 'stone') }
const spend = async (f, limit = 80) => { let out; for (let i = 0; i < limit; i++) { out = await tick(f); if (out.branch || /EXHAUSTED|SITE_VISIT/.test(out.result?.code ?? '')) break } return out }

function trips (f, { arrive = () => true } = {}) {
  const made = [], logs = []
  f.ctx.log = line => logs.push(line)
  f.ctx.travelTo = async ({ destination }) => {
    made.push({ ...destination })
    if (!arrive(destination)) return { phase: 'failed', reason: 'CHUNK_TRAVEL_NO_ROUTE', ended: 'finished' }
    f.receiveSite(Math.floor(destination.x / 16), Math.floor(destination.z / 16))
    // The long trip counts 20 m as arrived.
    f.setFeet({ x: destination.x + 12.5, y: 64, z: destination.z + 0.5 })
    return { phase: 'arrived', ended: 'finished' }
  }
  return { made, logs }
}

test('without a way to go there, a spent search stays spent (the live state)', async () => {
  const f = observationWorld({ index: 0 }); walled(f)
  const out = await spend(f)
  assert.equal(out.result.code, 'MINE_OBSERVATION_EXHAUSTED')
  const search = f.ctx.memory.early.mine.search
  assert.equal(search.index, 9); assert.ok(Object.keys(search.deferred).length >= 8)
  for (let i = 0; i < 4; i++) assert.equal((await tick(f)).result.code, 'MINE_OBSERVATION_EXHAUSTED')
  assert.equal(f.walks.length, 0)
})

test('a spent search goes to the nearest deferred centre, receives it there and plans a real site', async () => {
  const f = observationWorld({ index: 0 }); walled(f)
  const { made, logs } = trips(f)
  let out
  for (let i = 0; i < 80; i++) { out = await tick(f); if (out.branch) break }
  assert.ok(out.branch, JSON.stringify(out.result))
  assert.deepEqual(made, [{ x: 48, z: 0 }], 'one trip, to the centre itself')
  assert.ok(out.branch.plan.site.anchor.x > 20, 'the site is at the visited centre')
  assert.ok(out.branch.plan.evaluation.availableTargetOre >= 1)
  assert.equal(f.ctx.memory.early.mine.search, undefined)
  assert.ok(logs.some(line => /採掘候補 2\/9 は、ここからは地形を受信できないため、その場所 \(48, 0\) へ行って調べます/.test(line)), logs.join('\n'))
  assert.ok(logs.some(line => /採掘候補 2\/9 の場所に着きました/.test(line)))
  assert.ok(logs.some(line => /採掘場を計画しました/.test(line)))
})

test('each deferred centre is visited once; trips that do not arrive end the search as before', async () => {
  const f = observationWorld({ index: 0 }); walled(f)
  const { made, logs } = trips(f, { arrive: () => false })
  let out
  for (let i = 0; i < 120; i++) { out = await tick(f); if (out.result?.code === 'MINE_OBSERVATION_EXHAUSTED') break }
  assert.equal(out.result.code, 'MINE_OBSERVATION_EXHAUSTED')
  const search = f.ctx.memory.early.mine.search, far = Object.keys(search.deferred).filter(index => Number(index) > 0)
  assert.equal(made.length, far.length * MAX_VISITS); assert.equal(new Set(made.map(p => `${p.x},${p.z}`)).size, made.length)
  assert.ok(far.every(index => search.visited[index] === MAX_VISITS))
  assert.ok(logs.some(line => /の場所へ着けませんでした（残り \d+m、CHUNK_TRAVEL_NO_ROUTE）/.test(line)))
  for (let i = 0; i < 6; i++) assert.equal((await tick(f)).result.code, 'MINE_OBSERVATION_EXHAUSTED')
  assert.equal(made.length, far.length * MAX_VISITS, 'no trip is repeated')
  assert.equal(f.walks.length, 0)
})

test('a centre that rejects after its visit leaves the next one its own visit', async () => {
  const f = observationWorld({ index: 0 }); walled(f)
  // The first visited place has no ore: its plan is rejected from received terrain. The second has ore.
  const made = [], logs = []
  f.ctx.log = line => logs.push(line)
  f.ctx.travelTo = async ({ destination }) => {
    made.push({ ...destination })
    const cx = Math.floor(destination.x / 16), cz = Math.floor(destination.z / 16)
    // The host asks for a view distance of 4 chunks (host.js), so the columns 4 chunks round the arrival are
    // announced; a 64-block site with its 8-block shift reaches 44 blocks from the centre.
    if (made.length === 1) { for (let x = cx - 4; x <= cx + 4; x++) for (let z = cz - 4; z <= cz + 4; z++) { f.announce(x, z); for (let y = 0; y <= 5; y++) f.section(x, y, z, y >= 4 ? 'air' : 'stone') } } else f.receiveSite(cx, cz)
    f.setFeet({ x: destination.x + 12.5, y: 64, z: destination.z + 0.5 })
    return { phase: 'arrived', ended: 'finished' }
  }
  let out
  for (let i = 0; i < 160; i++) { out = await tick(f); if (out.branch) break }
  assert.ok(out.branch, JSON.stringify(out.result) + '\n' + logs.join('\n'))
  assert.equal(made.length, 2); assert.notDeepEqual(made[0], made[1])
  assert.ok(logs.some(line => /採掘候補 2\/9: .*MINE_/.test(line)), 'the first centre is rejected with its reason')
})

test('a far centre is not walked toward eight steps at a time; it is deferred for its visit', async () => {
  const f = observationWorld({ index: 5 }) // (48, 48): 68 m from the home, open ground around the feet
  let out
  for (let i = 0; i < 12; i++) { out = await tick(f); if (f.ctx.memory.early.mine.search.deferred?.[5]) break }
  assert.ok(f.ctx.memory.early.mine.search.deferred?.[5], JSON.stringify(out.result))
  assert.equal(f.walks.length, 0)
})

test('a search saved at the end of the two inner rings continues into the outer rings', async () => {
  const f = observationWorld({ index: 17 }), mine = f.ctx.memory.early.mine
  mine.sites = [{ plan: createMineGeometry({ scope: mineWorldScope(f.current), anchor: { x: 0, z: 0 }, direction: 'east', surfaceY: 64, upperY: 48, width: 16, length: 16 }) }]
  mine.search.origin = { x: 0.5, y: 64, z: 0.5 }; mine.search.exhaustedRevision = 1; mine.search.entranceSurveyed = true
  f.receiveSite(9, 0) // (144, 0): the first centre of the third ring
  const out = await tick(f)
  assert.ok(out.branch, JSON.stringify(out.result))
  assert.ok(out.branch.plan.site.anchor.x > 110)
})

test('a centre whose own column is a pond takes its height from a column beside it', () => {
  const f = observationWorld(); f.receiveSite(3, 0)
  f.put({ x: 48, y: 63, z: 0 }, 'water')
  assert.deepEqual(originAt(f.ctx, 1, [], { x: 0.5, y: 64, z: 0.5 }).origin, { x: 52.5, y: 64, z: 0.5 })
  // Received and nowhere to stand in any of the columns: nothing to ask for, the centre is rejected.
  for (const r of [4, 8, 12]) for (const [x, z] of [[r, 0], [0, r], [-r, 0], [0, -r], [r, r], [-r, r], [-r, -r], [r, -r]]) f.put({ x: 48 + x, y: 63, z }, 'water')
  assert.deepEqual(originAt(f.ctx, 1, [], { x: 0.5, y: 64, z: 0.5 }), { unknown: [] })
})
