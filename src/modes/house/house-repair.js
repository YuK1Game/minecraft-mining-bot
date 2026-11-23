'use strict'

// The starter house's record, and what each part of it means.
//
// Until 2026-11-19 one flag did three jobs: `done` was "the blocks stand", "nobody is repairing" and "the bed,
// the chests and the furnaces can be used". A repair that ran out of time set it back to true with the blocks
// still missing, and every reader took the house for whole. Now (shared.playerHouse, .local/player-house.json):
// - `done`: what was last observed. True only from received blocks (house-build.js: every step stands and both
//   large chests gave 54 slots). False from received blocks too (house-damage.js, or a job that found the thing
//   it needs broken). A timeout, a pause or a hold never writes it.
// - `built`: the house was finished once (the stage 「拠点の作成」 stays reached while it is damaged).
// - `repair`: the repair work, apart from what is observed:
//     null                      nothing to do, or the first build (which has no time limit);
//     { state: 'running', … }   the ordinary build is putting blocks back (`since`; GIVE_UP_MS at most);
//     { state: 'held', … }      given up for now. `until`, and `basis` (what was missing, which materials were
//                               short, whether the house was seen whole) say when it is looked at again.
//   `need` names the one thing a job asked for (house-facilities.js) and `focus` its blueprint steps: while
//   they are set the build and the gathering of materials do only those, and the repair is held again as soon
//   as the thing stands, so the job goes on without waiting for the walls.
// - What a job may use is not in the record at all: it reads the thing's blocks now (house-facilities.js) and
//   uses it through the existing steps (the walk in, the open click, the received slots).
//
// Who works: `houseDuty` is the one answer for every reader of the record (the expedition's objective, the
// gathering of materials, the build, the night at home).
const { facility, repairSteps, LABEL } = require('./house-facilities')

const GIVE_UP_MS = 20 * 60000, AGAIN_MS = 60 * 60000, MAX_ROUNDS = 2

// 'build' (no finished house yet), 'repair' (a repair is running) or null (whole, or the repair is held).
function houseDuty (house) {
  if (house?.done === true) return null
  if (!house?.origin || !house.repair) return 'build'
  return house.repair.state === 'running' ? 'repair' : null
}

// The steps the running repair is limited to (a Set of ids), or null for the whole blueprint.
function focusOf (house) {
  const repair = house?.repair
  return repair?.state === 'running' && Array.isArray(repair.focus) && repair.focus.length ? new Set(repair.focus) : null
}

const running = (now, extra = {}) => ({ state: 'running', since: now, ...extra })

// A job needs one thing of the house and its received blocks are broken: the observation is written down
// (`done: false`) and the repair of that thing is asked for. Answers what the job can do now:
// - { state: 'standing' | 'unknown' | 'spent' }: nothing written; use it, wait for the blocks, or tell the ledger;
// - { state: 'repair' }: the repair of this thing runs (the ordinary build takes over);
// - { state: 'held', until }: this thing's repair was tried and given up; it is looked at again by the repair's
//   own conditions (house-damage.js), not by asking again.
function needHouse (shared, getBlock, name, { now = Date.now(), log = () => {} } = {}) {
  const house = shared.playerHouse
  if (!house?.origin) return { state: 'unknown', facility: null }
  const seen = facility(getBlock, house.origin, name)
  if (seen.state !== 'broken') return { state: seen.state, facility: seen }
  const repair = house.repair ?? null
  if (house.done !== true && !repair) return { state: 'repair', facility: seen } // the first build is still going
  if (repair?.state === 'held' && (repair.need === name || repair.tried?.[name] != null)) return { state: 'held', until: repair.until, facility: seen }
  if (repair?.state === 'running' && repair.need) return { state: 'repair', facility: seen } // one thing at a time
  const focus = repairSteps(getBlock, house.origin, name)
  shared.playerHouse = { ...house, done: false, ...(house.done === true ? { built: true } : {}),
    repair: running(repair?.state === 'running' ? repair.since : now, { need: name, ...(focus.length ? { focus } : {}), ...(repair?.tried ? { tried: { ...repair.tried } } : {}) }) }
  log(`プレイヤーモード: 家の${LABEL[name]}が壊れているため、そこだけ先に直します（${focus.length} 手）`)
  return { state: 'repair', facility: seen }
}

// Given up for now: the observation stays as it is; only the work and when to look again change.
// `missing`: the steps not standing as received now (null when the house is not received whole); `short`: the raw
// materials short for them ({ logs, … }, null while the inventory is not received); `met`: the thing a job asked
// for stands again, so nothing was tried in vain.
// A repair looked at again only because its time was up, and held again with the same count of missing steps, waits
// twice as long each time (60, 120, 240 minutes): nothing it can see has changed, and each look takes the body out
// of its work and back (live 2026-11-24 05:11, 06:25 and 07:45 JST: one roof slab out of sight from every stand;
// each look walked from the mine to the house and back). A changed count or material looks again as before, and
// so does a repair a job asked for (`need`).
function hold (house, { now, missing = null, short = null, met = false, again = null }) {
  const repair = house.repair ?? {}
  const rounds = !met && missing !== null && repair.again?.missing === missing ? Math.min((repair.again.rounds ?? 0) + 1, MAX_ROUNDS) : 0
  again = again ?? AGAIN_MS * 2 ** rounds
  const keep = !met && repair.need ? { need: repair.need, ...(repair.focus ? { focus: [...repair.focus] } : {}) } : {}
  const tried = { ...(repair.tried ?? {}), ...(!met && repair.need ? { [repair.need]: now } : {}) }
  return { ...house, repair: { state: 'held', since: repair.since ?? now, heldAt: now, until: now + again, ...keep, tried, basis: { missing, short: short ? { ...short } : null, seen: missing !== null, ...(rounds ? { rounds } : {}) } } }
}

// Why a held repair is looked at again now, or null. `sight`: the confirmed observation ({ missing }) or null;
// `short`: the raw materials short now, or null while the inventory is not received.
function review (repair, { now, sight = null, short = null }) {
  const basis = repair.basis ?? {}
  if (now >= repair.until) return 'TIME'
  if (sight && basis.seen !== true) return 'SEEN'
  if (sight && Number.isFinite(basis.missing) && sight.missing !== basis.missing) return 'OBSERVED'
  // A kind of material that was short and is all there now. One more of a kind still short is not a reason.
  if (short && basis.short && Object.keys(basis.short).some(kind => basis.short[kind] > 0 && !(short[kind] > 0))) return 'MATERIALS'
  return null
}

// The held repair runs again. The thing a job asked for stays first until it is received standing.
// `why`: the reason of the look ('TIME' keeps what the hold was measured by, so the next hold can tell a look that
// found nothing new).
function resume (house, { now, getBlock, why = null }) {
  const repair = house.repair ?? {}
  const again = why === 'TIME' && !repair.need && Number.isFinite(repair.basis?.missing) ? { again: { missing: repair.basis.missing, rounds: repair.basis.rounds ?? 0 } } : {}
  const state = repair.need ? facility(getBlock, house.origin, repair.need).state : null
  const need = state === 'broken' || state === 'unknown' ? repair.need : null
  const focus = state === 'broken' ? repairSteps(getBlock, house.origin, need) : need ? repair.focus ?? [] : []
  return { ...house, repair: running(now, { ...(need ? { need, ...(focus.length ? { focus: [...focus] } : {}) } : {}), ...again }) }
}

module.exports = { houseDuty, focusOf, needHouse, hold, review, resume, running, GIVE_UP_MS, AGAIN_MS, MAX_ROUNDS }
