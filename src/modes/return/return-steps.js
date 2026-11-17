'use strict'

// The stages of the return to the base (return-goal.js). Each stage reads the
// received state, does one piece with the ordinary operations and answers with
// a result (return-result.js); `next` names the stage to go to when it is not
// the one after. A stage whose precondition is gone sends the goal back to the
// stage that makes it (in water again: back to "surface").
const { completed, partial, blocked, failed, interrupted, cancelled } = require('./return-result')
const { low } = require('../low-block')
const { underCover } = require('../player-surface')
const { openAccess } = require('../../actions/open-face')

const CHEST = 'minecraft:chest'
const ARRIVE_M = 20, REACH_M = 4, CLOSE_M = 6, FAR_M = 1024, MAX_BUILT = 3, EYE = 1.62, STANDS = 6
// A trip may take 2 s per metre, between 5 and 20 minutes, and goes on while it
// gets 8 m closer every 4 minutes (player-base.js history: live 2026-11-17 20:36 JST).
const TRAVEL_MS = 300000, TRAVEL_MAX_MS = 1200000, STALL_MS = 240000, STALL_M = 8, MS_PER_M = 2000

const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
const same = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y && a.z === b.z
const area = (point, size) => point ? `${Math.floor(point.x / size)},${Math.floor(point.y / size)},${Math.floor(point.z / size)}` : '?'
// From the eyes to the middle of the chest: a chest high above or far below is not within reach.
const reach = (at, eye) => Math.hypot(at.x + 0.5 - eye.x, at.y + 0.5 - eye.y, at.z + 0.5 - eye.z)
const total = stacks => stacks.reduce((sum, stack) => sum + stack.count, 0)

// Cells to stand in beside the chest: received solid ground (not a chest or
// another low block) and two received open cells.
function standsBeside (getBlock, chest) {
  const out = []
  const open = (x, y, z) => { const found = getBlock(x, y, z); return found?.known === true && found.boundingBox !== 'block' && !/water|lava/.test(found.name ?? '') }
  const solid = (x, y, z) => { const found = getBlock(x, y, z); return found?.known === true && found.boundingBox === 'block' && !low(found) }
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
    for (const dy of [0, -1, 1]) {
      const x = chest.x + dx, y = chest.y + dy, z = chest.z + dz
      if (solid(x, y - 1, z) && open(x, y, z) && open(x, y + 1, z)) { out.push({ x: x + 0.5, y, z: z + 0.5 }); break }
    }
  }
  return out
}

// The other half of a large chest: the same container.
function pairOf (getBlock, chest) {
  const isChest = at => { const found = getBlock(at.x, at.y, at.z); return found?.known === true && found.name === CHEST }
  return [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => ({ x: chest.x + dx, y: chest.y, z: chest.z + dz })).find(isChest) ?? null
}

function createReturnSteps ({ goal, ports, flow }) {
  const { getBlock, getPosition, getFeet, getInventory, policy, moves, chests } = ports
  const { ok, interrupter, say, now, sleep } = flow
  const g = goal // read through a function: the runner replaces the goal object
  const isChest = at => { const found = getBlock(at.x, at.y, at.z); return found?.known === true && found.name === CHEST }
  const gone = at => { const found = getBlock(at.x, at.y, at.z); return found?.known === true && found.name !== CHEST }
  const aborted = () => !ok() || !!interrupter()
  // Why a step ended without its end condition, when it was not its own failure.
  const stopped = code => !ok() ? cancelled('RETURN_CANCELLED') : interrupter() ? interrupted(code, { detail: interrupter() }) : null
  const inList = (list, at) => list.some(entry => same(entry, at))
  // Why the open click cannot be sent from here (too far, or no clear line to
  // the chest), by the open operation's own preview; null when it can.
  const away = at => chests.hands.access ? chests.hands.access(at) : reach(at, getPosition()) > REACH_M ? 'CONTAINER_NOT_IN_REACH' : null
  const read = pos => getBlock(pos.x, pos.y, pos.z)
  const opensFrom = (stand, at) => !openAccess(read, { x: stand.x, y: stand.y + EYE, z: stand.z }, at)
  const listed = (list, at) => { if (!inList(list, at)) list.push({ x: at.x, y: at.y, z: at.z }) }

  async function observe () {
    const position = getPosition()
    if (!position) return blocked('POSITION_UNKNOWN', { kind: 'time', ms: 5000 })
    if (!getInventory()) return blocked('INVENTORY_UNKNOWN', { kind: 'inventory_update', timeoutMs: 30000 })
    // The base is in the overworld: from another dimension the goal is held until the dimension changes.
    const dimension = ports.dimension?.()
    if (typeof dimension === 'string' && dimension !== 'overworld') return { ...failed('BASE_IN_OTHER_DIMENSION', { detail: dimension, evidence: { state: { dimension } } }), hold: true }
    const cargo = policy.cargo()
    g().remaining = { stacks: cargo.length, items: total(cargo) }
    // Nothing to bank and nothing to take out (a death took it all): the goal is met as it stands.
    if (!cargo.length && !policy.restockWanted()) return { ...completed('NOTHING_TO_BANK'), next: 'replan' }
    return completed('OBSERVED', { evidence: { cargo: g().remaining } })
  }

  // Under the open sky and on dry land: where a long trip can start.
  async function surface () {
    const here = () => getPosition()
    if (underCover(getBlock, here())) {
      say('地上へ出ます')
      let out = null
      try { out = await moves.climb(aborted) } catch (error) { out = { ok: false, reason: String(error?.message ?? error).slice(0, 80) } }
      if (underCover(getBlock, here())) {
        const code = String(out?.code ?? out?.reason ?? '')
        return stopped('CLIMB_INTERRUPTED') ?? (/COMBAT|INTERRUPT/.test(code) ? interrupted('CLIMB_INTERRUPTED', { detail: code }) : failed('CLIMB_FAILED', { detail: out?.reason ?? code, evidence: { state: { at: area(here(), 8), why: code.slice(0, 40) } } }))
      }
    }
    if (moves.water.needed()) {
      let out = null
      try { out = await moves.water.exit(aborted) } catch (error) { out = { ok: false, reason: String(error?.message ?? error).slice(0, 80) } }
      // Out of the water counts by the received position only; a land trip does not start from the water.
      if (moves.water.needed()) return stopped('WATER_EXIT_INTERRUPTED') ?? blocked('WATER_EXIT_FAILED', { kind: 'position_changed' }, { detail: out?.reason, evidence: { state: { at: area(here(), 4) } } })
    }
    return completed('READY_TO_TRAVEL')
  }

  async function travel () {
    const goalNow = g(), position = getPosition()
    if (!position) return blocked('POSITION_UNKNOWN', { kind: 'time', ms: 5000 })
    let base = goalNow.base
    if (base && flat(base, position) > FAR_M) { say(`拠点 (${base.x}, ${base.z}) が ${FAR_M}m より遠いため、ここに新しい拠点を作ります`); goalNow.base = base = null }
    if (!base) return { ...completed('NO_BASE_YET'), next: 'container' }
    if (flat(base, position) <= ARRIVE_M) return completed('NEAR_BASE', { evidence: { distance: Math.round(flat(base, position)) } })
    if (underCover(getBlock, position) || moves.water.needed()) return { ...completed('START_LOST'), next: 'surface' }
    // From inside the starter house: out through its door first (house/house-exit.js).
    if (moves.house.inside()) {
      let left = false
      try { left = await moves.house.leave() } catch { left = false }
      if (moves.house.inside()) return stopped('HOUSE_EXIT_INTERRUPTED') ?? failed('HOUSE_EXIT_FAILED', { detail: left, evidence: { state: { at: area(position, 2) } } })
    }
    // A way round (return-runner.js): to a point beside the straight line first, then on to the base from there.
    if (goalNow.detour && flat(goalNow.detour, getPosition()) <= ARRIVE_M + 4) goalNow.detour = null
    const round = goalNow.detour, to = round ?? base
    const from = flat(to, getPosition())
    say(round ? `回り道の地点 (${to.x}, ${to.z}) へ移動しています（残り ${Math.round(from)}m）` : `拠点 (${base.x}, ${base.y}, ${base.z}) へ移動しています（残り ${Math.round(from)}m）`)
    try { await moves.travel.to({ destination: { x: to.x, z: to.z } }) } catch (error) {
      return stopped('TRAVEL_INTERRUPTED') ?? blocked(typeof error?.code === 'string' ? error.code : 'TRAVEL_START_REFUSED', { kind: 'owner_released', timeoutMs: 10000 }, { detail: error?.message, evidence: { state: { at: area(getPosition(), 16) } } })
    }
    const until = now() + Math.min(TRAVEL_MAX_MS, Math.max(TRAVEL_MS, from * MS_PER_M))
    let best = from, bestAt = now()
    while (!aborted() && now() < until && now() - bestAt < STALL_MS && moves.travel.status()?.busy) {
      await sleep(1000)
      const left = flat(to, getPosition())
      if (left < best - STALL_M) { best = left; bestAt = now() }
    }
    const why = moves.travel.status()?.reason ?? null
    if (moves.travel.status()?.busy) { try { await moves.travel.cancel() } catch {} }
    const left = flat(to, getPosition()), moved = from - left
    if (round) {
      goalNow.detour = null
      const cut = stopped('TRAVEL_INTERRUPTED')
      if (cut) return cut
      return moved >= STALL_M ? partial('DETOUR_WALKED', { progress: { moved: Math.round(moved) } }) : failed('DETOUR_NO_PROGRESS', { detail: why, evidence: { reason: why, state: { at: area(getPosition(), 16), why } } })
    }
    if (left <= ARRIVE_M) return completed('NEAR_BASE', { progress: { moved: Math.round(moved) }, evidence: { distance: Math.round(left) } })
    const cut = stopped('TRAVEL_INTERRUPTED')
    if (cut) return { ...cut, progress: { moved: Math.round(moved) } }
    // Closer by a real distance: the rest of the way is planned again from here.
    if (moved >= STALL_M) return partial('TRAVEL_SHORT', { progress: { moved: Math.round(moved) }, remaining: { distance: Math.round(left) }, evidence: { reason: why } })
    return failed('TRAVEL_NO_PROGRESS', { remaining: { distance: Math.round(left) }, detail: why, evidence: { reason: why, state: { at: area(getPosition(), 16), why } } })
  }

  // "Arrived" (within 20 m) is not "at the chest": the end is a place the open
  // click can be sent from (within reach, with a clear line to the chest).
  // Hops over received ground, the house's porch walk, the door, then the
  // cells beside the chest, the ones the chest opens from first. When none of
  // them works from inside the house, out through the door and once more
  // (live 2026-11-18 03:16 JST: the chests outside the south wall were tried
  // from inside, 「視線が遮られているか、未取得です」 every time).
  async function approach () {
    const goalNow = g(), at = goalNow.target ?? goalNow.base
    if (!at) return { ...completed('NO_BASE_YET'), next: 'container' }
    if (gone(at)) {
      if (same(at, goalNow.base)) { say('拠点のチェストがなくなっていたため、作り直します'); goalNow.base = null }
      goalNow.target = null
      return { ...completed('CHEST_GONE'), next: 'container' }
    }
    if (flat(at, getPosition()) > ARRIVE_M) return { ...completed('TOO_FAR'), next: 'travel' }
    if (moves.water.needed()) return { ...completed('START_LOST'), next: 'surface' }
    if (away(at) && flat(at, getPosition()) > CLOSE_M) { try { await moves.approach(at, CLOSE_M) } catch {} }
    if (away(at) && flat(at, getPosition()) > CLOSE_M && !aborted()) { try { await moves.porchWalk() } catch {} }
    if (away(at) && !aborted()) { try { await moves.door() } catch {} }
    const beside = async () => {
      const all = standsBeside(getBlock, at)
      for (const stand of [...all.filter(stand => opensFrom(stand, at)), ...all.filter(stand => !opensFrom(stand, at))].slice(0, STANDS)) {
        if (aborted() || !away(at)) return
        if (flat(stand, getFeet()) <= 0.45 && Math.abs(stand.y - getFeet().y) < 0.6) continue
        try { await moves.walk(stand) } catch {}
      }
    }
    await beside()
    if (away(at) && !aborted() && moves.house.inside()) {
      try { await moves.house.leave() } catch {}
      if (!moves.house.inside()) await beside()
    }
    const why = away(at)
    if (!why) return completed('AT_CHEST', { evidence: { chest: at, distance: Math.round(reach(at, getPosition()) * 10) / 10 } })
    return stopped('APPROACH_INTERRUPTED') ?? failed('CHEST_UNREACHED', { detail: why, remaining: { distance: Math.round(reach(at, getPosition())) }, evidence: { chest: at, state: { at: area(getFeet(), 4), why } } })
  }

  // A chest whose received slots show room; a new one when every known chest
  // is full (by its received slots) or would not open from beside it.
  async function container () {
    const goalNow = g()
    // Only taking out: no chest with room is needed, and none is built.
    if (!policy.cargo().length && getInventory()) return { ...completed('NOTHING_TO_STORE'), next: 'verify' }
    // The base's chest, the house's second one, the one in use, and any other standing near the Bot.
    const known = goalNow.base ? [goalNow.base, ...chests.spares(), ...(goalNow.target ? [goalNow.target] : []), ...(chests.near?.() ?? [])].filter((at, index, all) => all.findIndex(other => same(other, at)) === index) : []
    // The halves of a large chest are one container: what is known of one half
    // (full, would not open, could not be got to) holds for the other.
    const either = (list, at) => { const pair = pairOf(getBlock, at); return inList(list, at) || (!!pair && inList(list, pair)) }
    const full = at => either(goalNow.full, at)
    const usable = known.filter(at => isChest(at) && !full(at) && !either(goalNow.unopened, at) && !either(goalNow.unreached, at))
    for (const at of usable) {
      if (aborted()) return stopped('CONTAINER_INTERRUPTED')
      if (full(at)) continue // the other half of one found full just now
      if (away(at)) { goalNow.target = at; return { ...completed('CHEST_CHOSEN'), next: 'approach' } }
      const seen = await chests.hands.inspect(at)
      if (seen.status !== 'completed') return { ...seen, evidence: { ...seen.evidence, chest: at, state: { at: area(getFeet(), 4) } } }
      if (seen.evidence?.room > 0) { goalNow.target = at; return completed('CHEST_HAS_ROOM', { evidence: seen.evidence }) }
      say(`チェスト (${at.x}, ${at.y}, ${at.z}) は満杯です（受信した空き 0 枠）`)
      listed(goalNow.full, at)
      const pair = pairOf(getBlock, at)
      if (pair) listed(goalNow.full, pair)
    }
    // A chest it could not get to is not replaced by a new one somewhere else:
    // the place is planned again later. Only where a chest was opened and
    // its received slots showed it full is a new one made beside it.
    if (known.some(at => isChest(at) && either(goalNow.unreached, at)) && !known.some(at => isChest(at) && full(at))) return failed('CHEST_UNREACHED', { retry: { kind: 'position_changed' }, evidence: { state: { at: area(getFeet(), 4) } } })
    if (goalNow.base && gone(goalNow.base)) { say('拠点のチェストがなくなっていたため、作り直します'); goalNow.base = null }
    if (!policy.canBuild()) return failed('NO_CHEST_MATERIAL', { retry: { kind: 'supplies_changed' }, detail: !goalNow.base ? '拠点のチェストを作る木がありません' : goalNow.unopened.length ? '使えるチェストがなく、新しいチェストを作る木がありません' : '拠点のチェストが満杯で、新しいチェストを作る木がありません' })
    if (goalNow.built >= MAX_BUILT) return failed('CHEST_LIMIT', { retry: { kind: 'supplies_changed' } })
    // The maker answers with a chest standing near the Bot when there is one
    // it was not told to skip; only a chest that was not there before counts as built.
    const skip = [...goalNow.full, ...goalNow.unopened, ...goalNow.unreached]
    let stood = chests.near?.() ?? []
    let made = await chests.make({ full: skip })
    const out = !made && goalNow.base ? chests.porch() : null
    // No room for a chest here (inside the house): out through the door to the porch, and there.
    if (out && !aborted()) {
      if (moves.house.inside()) { try { await moves.house.leave() } catch {} }
      try { await moves.approach(out.stand, 1.5) } catch {}
      stood = chests.near?.() ?? []
      made = await chests.make({ full: skip, avoid: out.avoid })
    }
    if (!made) return stopped('CONTAINER_INTERRUPTED') ?? failed('CHEST_PLACE_FAILED', { retry: { kind: 'position_changed' }, evidence: { state: { at: area(getFeet(), 4) } } })
    const fresh = !inList(stood, made)
    if (fresh) goalNow.built++
    goalNow.base = await policy.record(made)
    goalNow.target = { x: made.x, y: made.y, z: made.z }
    // Placed or found, it is opened from a place it opens from, like any other chest.
    const code = fresh ? 'CHEST_PLACED' : 'CHEST_FOUND'
    return away(goalNow.target) ? { ...completed(code, { evidence: { chest: goalNow.target } }), next: 'approach' } : completed(code, { evidence: { chest: goalNow.target } })
  }

  async function store () {
    const goalNow = g(), at = goalNow.target
    if (!at || !isChest(at)) { goalNow.target = null; return { ...completed('CHEST_GONE'), next: 'container' } }
    if (!getInventory()) return blocked('INVENTORY_UNKNOWN', { kind: 'inventory_update', timeoutMs: 30000 })
    if (!policy.cargo().length) return completed('NOTHING_LEFT')
    const out = await chests.hands.deposit(at, () => policy.cargo(), { aborted })
    const moved = out.progress?.confirmedTransferred ?? 0
    // Counted once, here, whatever the rest of the answer says.
    if (moved > 0) { goalNow.progress.banked += moved; goalNow.progress.lastAt = now(); goalNow.progress.last = `${moved} 個を (${at.x}, ${at.y}, ${at.z}) に収納` }
    if (out.code === 'CONTAINER_FULL') {
      listed(goalNow.full, at)
      const pair = pairOf(getBlock, at)
      if (pair) listed(goalNow.full, pair)
      goalNow.target = null
      return { ...(moved > 0 ? partial : completed)('CONTAINER_FULL', { progress: out.progress, remaining: out.remaining, evidence: out.evidence }), next: 'container' }
    }
    // Pushed away or the line to the chest closed since the approach: another place to stand.
    const moveOn = ['CONTAINER_NOT_IN_REACH', 'CONTAINER_NOT_VISIBLE'].includes(out.code) ? { next: 'approach' } : {}
    return { ...out, ...moveOn, evidence: { ...out.evidence, chest: at, state: { at: area(getFeet(), 4) } } }
  }

  // Nothing left to bank (by the received inventory), then the kit restocked.
  async function verify () {
    const goalNow = g()
    if (!getInventory()) return blocked('INVENTORY_UNKNOWN', { kind: 'inventory_update', timeoutMs: 30000 })
    const cargo = policy.cargo()
    goalNow.remaining = { stacks: cargo.length, items: total(cargo) }
    if (cargo.length) return { ...failed('CARGO_REMAINS', { remaining: goalNow.remaining, evidence: { chest: goalNow.target, state: { items: goalNow.remaining.items } } }), next: goalNow.target ? 'store' : 'container' }
    let taken = 0
    if (chests.hands.take) {
      for (const at of [goalNow.target, goalNow.base, ...chests.spares()].filter((entry, index, all) => entry && all.findIndex(other => same(other, entry)) === index)) {
        if (aborted() || !isChest(at) || away(at)) continue
        taken += await chests.hands.take(at, policy.restock)
      }
    }
    if (taken > 0) { goalNow.progress.taken += taken; goalNow.progress.lastAt = now(); goalNow.progress.last = `${taken} 個を取り出し` }
    // Still wanted and nothing came out (the chest did not open, or the hands are full): not "done".
    if (!taken && !goalNow.progress.banked && !aborted() && policy.restockWanted()) return failed('RESTOCK_UNCONFIRMED', { evidence: { chest: goalNow.base, state: { at: area(getFeet(), 4) } } })
    return completed('RETURN_DONE', { progress: { banked: goalNow.progress.banked, taken: goalNow.progress.taken } })
  }

  return { observe, surface, travel, approach, container, store, verify }
}

module.exports = { createReturnSteps, standsBeside, pairOf, ARRIVE_M, REACH_M, FAR_M }
