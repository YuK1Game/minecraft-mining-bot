'use strict'

// The expedition's wait for health, under a lid.
//
// Badly hurt, the ordinary play digs the long trip's covered pit and rests in it (player-shelter.js). While the
// expedition owns the work that shelter is not run, and the expedition's own wait for health (dragon-heal.js)
// stood in the open: a hit sent it a few steps from the nearest enemy, then it ate and waited where it stood
// (real Realm 2026-11-23 09:35:41-09:38:11 JST, a held goal on open ground at noon: a phantom took 3.1 five
// times — 13.7 → 10.6, 9.0 → 5.9, 8.9 → 5.8, 8.8 → 5.7, 5.7 → 2.6 —, meanwhile it moved 60 m west to a skeleton,
// a zombie and a creeper, and it died with its diamond sword and pickaxe. Between the swoops nothing stood
// within 10 m, and hunger was 19).
// - In: overworld, health under REST_BELOW, something feeds the wait (a meal now, or hunger that regenerates),
//   no hostile within CALM_M, not in the house (its roof is the shelter) and not through a block of the house. The pit is planned where
//   it stands or at the nearest cell it can walk to within NEAR cells (travel/night-stop.js planPit: three down,
//   walls and floor received solid) and dug by the long trip's pit (every step by received terrain). A try that
//   did not end under a lid is not repeated for RETRY_MS.
// - Inside, the wait and its meals go on whatever stands above (dragon-heal.js).
// - Out: the wait is over, or nothing feeds it. The record is cleared first (the shared climb stops while a pit
//   is recorded), then straight up through the lid by the shared climb (the pillar fills the pit again). Left
//   under the lid, the lid is mined and the ordinary ways out of a hole go on.
// The record is the long trip's (shared.travelNight) with reason 'rest' and owner 'dragon'. While the expedition
// owns the work the ordinary shelter leaves such a pit alone (mode-runtime.js); when the ordinary play works
// again it keeps and leaves it by its own rules.
const { REST_BELOW } = require('./player-shelter')
const { planPit } = require('../travel/night-stop')
const { inside: inHouse } = require('./house/house-exit')
const { createHouseProtection } = require('../safety/house-protection')

const CALM_M = 10, NEAR = 5, RETRY_MS = 30000, SAY_MS = 60000, LID_POLLS = 175
const REST = '体力回復のため、ふたをした穴の中で待ちます。'
const text = value => String(value ?? '').replace(/[\p{C}§]/gu, ' ').slice(0, 120)

// The expedition's own rest pit, and nothing else's.
const resting = shared => { const pit = shared?.travelNight; return !!pit?.cover && pit.reason === 'rest' && pit.owner === 'dragon' }

// Where the pit can be dug: here, else the nearest cell of `cells` (what it can walk to). null: nowhere near.
function pitSite ({ getBlock, feet, cells = null, house = null }) {
  if (!feet || ![feet.x, feet.y, feet.z].every(Number.isFinite)) return null
  const overlay = createHouseProtection(() => house)
  const built = cell => overlay(getBlock(cell.x, cell.y, cell.z), cell.x, cell.y, cell.z)?.houseBlock === true
  const fits = at => {
    if (inHouse(house?.origin, at)) return false
    const plan = planPit(getBlock, at)
    return plan.ready === true && ![...plan.dig, plan.cover].some(built)
  }
  const here = { x: Math.floor(feet.x) + 0.5, y: Math.round(feet.y), z: Math.floor(feet.z) + 0.5 }
  if (fits(here)) return { ...here, walk: false }
  const near = [...(cells?.values?.() ?? cells ?? [])]
    .filter(cell => Math.max(Math.abs(cell.x + 0.5 - here.x), Math.abs(cell.z + 0.5 - here.z)) <= NEAR && Math.abs(cell.y - here.y) <= 2)
    .map(cell => ({ x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 }))
    .sort((a, b) => Math.hypot(a.x - here.x, a.z - here.z) - Math.hypot(b.x - here.x, b.z - here.z))
  const found = near.find(fits)
  return found ? { ...found, walk: true } : null
}

// ctx: the step's ports. health / hostileDistance: () => the received values. dig(signal): the long trip's pit.
// climb(): the shared way up to the open sky.
function createRest ({ ctx, health, hostileDistance = () => null, dig = null, climb = null, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const shared = ctx.shared
  const log = line => ctx.log?.(line)
  const inside = () => resting(shared)

  // One look of the wait in the open. fed: a meal can be eaten now, or the hunger regenerates.
  async function enter ({ fed }) {
    const pit = shared.travelNight ??= { cover: null, pitTried: 0 }
    const hp = health(), far = hostileDistance()
    if (typeof dig !== 'function' || pit.cover || fed !== true || !(Number.isFinite(hp) && hp > 0 && hp < REST_BELOW)) return null
    if (Number.isFinite(far) && far <= CALM_M) return null
    if (now() - (pit.dragonTriedAt ?? -Infinity) < RETRY_MS) return null
    // Under its own roof the house is the shelter: no pit, and no walk out of the door for one.
    if (inHouse(shared.playerHouse?.origin, ctx.getFeet())) return null
    const site = pitSite({ getBlock: ctx.getBlock, feet: ctx.getFeet(), cells: ctx.cells?.(), house: shared.playerHouse })
    if (!site) {
      if (now() - (pit.dragonSaidAt ?? -Infinity) >= SAY_MS) { pit.dragonSaidAt = now(); log(`遠征: 体力 ${hp.toFixed(1)} ですが、近くに回復の穴を作れる場所がありません。このまま回復を待ちます`) }
      return null
    }
    pit.dragonTriedAt = now()
    if (site.walk) {
      let walked = false
      try { walked = await ctx.walk({ x: site.x, y: site.y, z: site.z }) !== false } catch { walked = false }
      if (!walked || ctx.cancelled()) return null
    }
    let result = null
    try { result = await dig(ctx.signal) } catch (error) { result = { ok: false, reason: error?.message ?? error } }
    // A lid that stands is recorded even when the step was cancelled meanwhile: the Bot is under it.
    if (result?.ok && result.cover) {
      Object.assign(pit, { cover: result.cover, reason: 'rest', owner: 'dragon' })
      log(`遠征: 体力 ${hp.toFixed(1)} のため、ふたをした穴の中で回復を待ちます`)
      return { phase: 'recovering', reason: REST }
    }
    log(`遠征: 回復の穴を作れませんでした（${text(result?.reason)}）。このまま回復を待ちます`)
    return null
  }

  // why: 'healed' or 'unfed'.
  async function leave (why = 'healed') {
    const pit = shared.travelNight, lid = pit?.cover
    if (!lid) return { phase: 'recovering', reason: REST }
    Object.assign(pit, { cover: null, reason: null, owner: null, pitTried: 0 })
    // In the pit's column, below the lid's top. A pit left behind by a death is only forgotten.
    const here = () => { const feet = ctx.getFeet(); return !!feet && Math.floor(feet.x) === lid.x && Math.floor(feet.z) === lid.z && feet.y < lid.y + 0.99 && feet.y > lid.y - 4 }
    if (!here()) return { phase: 'recovering', reason: '回復の穴の記録を片付けました。' }
    log(why === 'unfed' ? '遠征: 穴の中で食べられる物がなくなったため、穴を出ます' : '遠征: 体力が戻ったので、穴を出ます')
    try { await climb?.() } catch (error) { log(`遠征: 穴から上がれませんでした（${text(error?.message ?? error)}）`) }
    const under = () => { const found = ctx.getBlock(lid.x, lid.y, lid.z); return here() && !(found?.known === true && found.boundingBox !== 'block') }
    if (under() && !ctx.cancelled()) {
      let started = false
      try { ctx.operations.mining.start([lid]); started = true } catch (error) { log(`遠征: 穴のふたを掘れません（${text(error?.message ?? error)}）`) }
      for (let i = 0; started && i < LID_POLLS && under() && !ctx.cancelled(); i++) await sleep(200)
      if (!under()) log('遠征: 穴のふたを開けました')
    }
    return { phase: 'recovering', reason: '回復の穴を出ます。' }
  }

  return { inside, enter, leave }
}

module.exports = { createRest, pitSite, resting, REST, CALM_M, RETRY_MS }
