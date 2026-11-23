'use strict'

// Player mode: the keeper of the starter house. It looks at the house's blocks, and it runs the clock of the
// repair. The two are kept apart (house-repair.js says what each field of the record means).
//
// A creeper blast (real Realm 2026-11-19 01:34 JST) took the door, the floor behind it and the ground in
// front; for ten hours every walk in and out of the house was a special case. A finished house that lost
// blocks is therefore built again. Until 2026-11-19 a repair that did not finish in twenty minutes wrote the
// house back to "done" with the blocks still missing, and nothing looked for an hour: every reader took a
// broken house for whole.
//
// What is observed:
// - Near the house (NEAR_M), in the overworld, with every blueprint cell received, the steps not standing are
//   counted (house-blueprint.js `remaining`). The same count twice, CONFIRM_MS apart, is the observation
//   (shared.playerHouseSeen: complete or damaged). Away, with a cell unreceived, or after another connection,
//   dimension or life it is unknown, and nothing is decided from it: unreceived is neither damage nor whole.
// - Observed damage on a house recorded done sets `done: false` and starts the repair (the ordinary build,
//   house-build.js, the same placements and materials).
// - `done: true` is written by the build alone, from received blocks and both chests' 54 slots.
//
// The repair's clock:
// - A repair that runs GIVE_UP_MS is held: the rest of the play is not stopped by a block that cannot be
//   placed. `done` stays false. The hold says what was missing and which materials were short.
// - A held repair runs again when its time is up (AGAIN_MS), when the count of missing steps has changed, when a
//   kind of material that was short is all there, or, for a hold taken with nothing observed in this life, when
//   the house is received whole for the first time (house-repair.js `review`). A hold taken out of sight of a
//   house this life has observed is measured by that observation: the same count seen again is not a reason.
// - A repair a job asked for (one thing of the house, house-repair.js `needHouse`) is held as soon as that
//   thing stands again, so the job goes on; the walls wait for the next look.
const { placements, remaining, counts } = require('./house-blueprint')
const { houseNeeds } = require('./house-needs')
const { facility, LABEL } = require('./house-facilities')
const { hold, review, resume, running, GIVE_UP_MS, AGAIN_MS } = require('./house-repair')

const NEAR_M = 16, CONFIRM_MS = 4000
const WHY = Object.freeze({ TIME: '時間', SEEN: '家全体を受信', OBSERVED: '家の様子が変化', MATERIALS: '材料がそろった' })

function createHouseDamage ({ shared, getBlock, getFeet, getInventory = () => null, dimension = () => 'overworld', scope = () => null, save = () => {}, log = () => {}, now = Date.now } = {}) {
  let first = null, seenScope, kept
  const say = text => log(`プレイヤーモード: ${text}`)
  const minutes = ms => Math.round(ms / 60000)
  // What of the record the file has to hold for the repair to go on after a restart.
  const mark = house => JSON.stringify([house.done === true, house.built === true, house.repair ?? null])
  function write (house) {
    shared.playerHouse = house
    kept = mark(house)
    try { void Promise.resolve(save(house)).catch(() => {}) } catch { /* Kept in shared until the next save. */ }
  }

  // The steps not standing, as received now; null unless near, in the overworld, with every blueprint cell received.
  function reading (origin) {
    const feet = getFeet()
    if (dimension() !== 'overworld' || !feet || Math.hypot(feet.x - (origin.x + 3.5), feet.z - (origin.z + 3.5)) > NEAR_M) return null
    if (!placements(origin).every(step => step.cells.every(cell => getBlock(cell.x, cell.y, cell.z)?.known === true))) return null
    return remaining(getBlock, origin)
  }
  // The observation: the same count twice, CONFIRM_MS apart. Null while there is none.
  function look (left) {
    const key = scope()
    if (key !== seenScope) { seenScope = key; first = null; shared.playerHouseSeen = { state: 'unknown', missing: null, at: now() } }
    if (!left) { first = null; return null }
    if (!first || first.missing !== left.length) { first = { at: now(), missing: left.length }; return null }
    if (now() - first.at < CONFIRM_MS) return null
    shared.playerHouseSeen = { state: left.length ? 'damaged' : 'complete', missing: left.length, at: now() }
    return { missing: left.length, left }
  }
  // The raw materials short for what the repair still has to place; null while they cannot be told.
  function shortNow (house, left) {
    const focus = Array.isArray(house.repair?.focus) && house.repair.focus.length ? new Set(house.repair.focus) : null
    const steps = left ? (focus ? left.filter(step => focus.has(step.id)) : left) : focus ? placements(house.origin).filter(step => focus.has(step.id)) : null
    const wanted = steps ? counts(steps) : house.left ?? null
    return wanted ? houseNeeds(getInventory(), wanted)?.need ?? null : null
  }

  function tick () {
    let house = shared.playerHouse
    if (!house?.origin) return null
    // The record of the code before 2026-11-19 (shared.playerHouseRepair), read once after a reload.
    if (shared.playerHouseRepair !== undefined) {
      const old = shared.playerHouseRepair
      delete shared.playerHouseRepair
      if (!house.repair && old?.open === true && house.done !== true) { house = { ...house, built: true, repair: running(Number.isFinite(old.since) ? old.since : now()) }; write(house) }
    }
    // A repair a job asked for (`needHouse`) is written to `shared` only: the keeper saves it, so that what the
    // job needs and its steps are still there after a restart. (The first tick after a reload saves once.)
    if (mark(house) !== kept) write(house)
    const left = reading(house.origin), sight = look(left), repair = house.repair ?? null
    if (house.done === true) {
      if (repair) { write({ ...house, built: true, repair: null }); say('家の修理が終わりました'); return 'repaired' }
      if (!sight?.missing) return null
      write({ ...house, done: false, built: true, repair: running(now(), { steps: sight.missing }) })
      const items = [...new Set(sight.left.map(step => step.item))].slice(0, 5).join('・')
      say(`家が壊れています（${sight.missing} 手: ${items}）。設計図どおりに直します`)
      return 'reopened'
    }
    if (!repair) {
      // Not done and finished once: a repair, with the repair's limit, counted from now. Not finished once (a first
      // build, or a file of the code before, which did not write `built`; a bed that stands says nothing, it is
      // used before the house is finished): the ordinary build, which has no limit.
      if (house.built === true) write({ ...house, repair: running(now()) })
      return null
    }
    if (repair.state === 'running') {
      const met = !!repair.need && facility(getBlock, house.origin, repair.need).state === 'standing'
      // A run of this repair failed on every step it could still work on, with no raw material short: nothing it waits
      // for will change, so it is held now and the other work goes on (live 2026-11-23 22:45-23:05 and
      // 2026-11-24 00:05 JST: one roof slab out of sight from every stand; the work stood still 20 minutes an hour).
      const tried = shared.playerHouseTried, short = shortNow(house, left)
      const spent = !met && tried?.since === repair.since && !!short && !Object.values(short).some(count => count > 0)
      if (!met && !spent && now() - repair.since < GIVE_UP_MS) return null
      // Out of sight at this moment: what this life last observed of the house is what the hold is measured by.
      // (A hold taken blind is looked at again at the first sight of the house. Three holds taken a few steps
      // outside NEAR_M were each looked at again within two minutes, with the count they had already seen.)
      const last = shared.playerHouseSeen?.state === 'damaged' ? shared.playerHouseSeen.missing : null
      const missing = left ? left.length : last
      const next = hold(house, { now: now(), missing, short, met })
      write(next)
      const seen = left ? `残り ${left.length} 手` : missing !== null ? `最後に見た時は残り ${missing} 手` : '家は未確認'
      const thing = repair.need ? `家の${LABEL[repair.need]}` : '家'
      say(met ? `${thing}が直ったため、残りの修理は保留して作業に戻ります（${seen}。見直し: ${minutes(AGAIN_MS)} 分後、または材料・家の様子が変わった時）`
        : spent ? `${thing}の修理で、いま置ける手がないため保留します（観測は破損のまま: ${seen}。見直し: ${minutes(AGAIN_MS)} 分後、または材料・家の様子が変わった時）`
        : `${thing}の修理が ${minutes(GIVE_UP_MS)} 分で終わらないため保留します（観測は破損のまま: ${seen}。見直し: ${minutes(AGAIN_MS)} 分後、または材料・家の様子が変わった時）`)
      return 'held'
    }
    const why = review(repair, { now: now(), sight, short: shortNow(house, left) })
    if (!why) return null
    write(resume(house, { now: now(), getBlock }))
    say(`保留していた家の修理を見直します（${WHY[why]}${sight ? `・残り ${sight.missing} 手` : ''}）`)
    return 'resumed'
  }
  return { tick }
}

module.exports = { createHouseDamage, NEAR_M, CONFIRM_MS, GIVE_UP_MS, AGAIN_MS }
