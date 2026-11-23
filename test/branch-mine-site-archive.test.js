'use strict'

// The archive of used mines does not end the search for the next one.
// Real Realm 2026-11-23 22:42 JST (home (9877,64,10138), goal early.home_reserve#4, raw_iron 10/33):
//   22:42:47 プレイヤーモード: 採掘範囲を使い終えたため、確認済みの施工を残して次の採掘場を調べます（保存済み8か所）
//   22:42:49 プレイヤーモード: 確認済み採掘場が8か所に達しました。保管した鉱石と採掘範囲を確認します。
// The archive held at most 8 sites, a number from the time the search had its nine inner centres. The search
// has had 33 centres (rings to 192 m) since, and with eight sites saved nextMine answered MINE_SITE_LIMIT on
// every tick before looking at any of them: no further mine could ever be planned.
// Real: nextMine (mine-sites.js), the planner, survey, Host World, terrain requester and mine ports
// (helpers/branch-mine-observation-world.js). The peer's terrain is local; the eight saved sites here are
// geometry only, away from the centre that is planned.
const test = require('node:test'), assert = require('node:assert/strict')
const { observationWorld } = require('./helpers/branch-mine-observation-world')
const { nextMine, protectedBySites, MAX_SITES, MAX_BYTES } = require('../src/modes/mining/mine-sites')
const { createMineGeometry } = require('../src/modes/mining/mine-geometry')
const { mineWorldScope } = require('../src/modes/mining/mine-state')

// The search as it stood after the two inner rings, with `n` used mines saved south of the home.
function searchWith (n) {
  const f = observationWorld({ index: 17 }), mine = f.ctx.memory.early.mine, scope = mineWorldScope(f.current), logs = []
  mine.sites = Array.from({ length: n }, (_, i) => ({ plan: createMineGeometry({ scope, anchor: { x: -40 * i, z: 400 }, direction: 'east', surfaceY: 64, upperY: 48, width: 16, length: 16 }) }))
  mine.search.origin = { x: 0.5, y: 64, z: 0.5 }; mine.search.exhaustedRevision = 1; mine.search.entranceSurveyed = true
  f.ctx.log = line => logs.push(line)
  f.receiveSite(9, 0) // (144, 0): the first centre of the third ring
  return { f, mine, logs }
}
const tick = async f => { f.advance(10000); return nextMine(f.ctx, 'raw_iron', 1) }

test('22:42 JST: with eight used mines saved, the next centre is still planned', async () => {
  const { f, mine, logs } = searchWith(8)
  const out = await tick(f)
  assert.ok(out.branch, JSON.stringify(out.result))
  assert.ok(out.branch.plan.site.anchor.x > 110, 'the site is at the received centre')
  assert.ok(out.branch.plan.evaluation.availableTargetOre >= 1)
  assert.equal(mine.sites.length, 8, 'the saved mines stay saved')
  assert.equal(protectedBySites(mine.sites, mine.sites[0].plan.scope)({ x: 4, y: 48, z: 404 }), true, 'and stay protected')
  assert.ok(logs.some(line => /採掘場を計画しました/.test(line)), logs.join('\n'))
})

test('the archive holds a site for every centre of the search, inside the saved record\'s size', () => {
  assert.equal(MAX_SITES, 33)
  const { mine } = searchWith(1)
  assert.ok(Buffer.byteLength(JSON.stringify(Array(MAX_SITES).fill(mine.sites[0]))) < MAX_BYTES)
})

test('a full archive still stops the search, with the number it holds', async () => {
  const { f, mine } = searchWith(MAX_SITES)
  const out = await tick(f)
  assert.equal(out.result.code, 'MINE_SITE_LIMIT')
  assert.match(out.result.reason ?? out.result.detail ?? JSON.stringify(out.result), /33か所/)
  assert.equal(mine.branch, undefined)
})
