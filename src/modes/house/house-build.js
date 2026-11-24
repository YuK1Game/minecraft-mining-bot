'use strict'

// Player mode: building the starter house (house-blueprint.js) once its raw
// materials are held (house-needs.js: logs, cobblestone, sand and wool; coal
// only lights it). The autonomy stops while it builds.
// - Out of a tunnel first (the climb), then a flat site near the Bot
//   (house-site.js), recorded in shared.playerHouse and .local/player-house.json.
// - The floor first, then the crafting table and the furnaces on it (the
//   crafting and the glass are done there), then the rest in the blueprint's
//   order. Each crafted thing is made when its step comes: planks from the
//   logs beyond the pillars', slabs, the door, chests, the bed at the table,
//   furnaces from cobblestone, glass from sand in the furnace (coal, else
//   planks as fuel), torches from coal (or charcoal) and a stick.
// - Every step is ordinary placement (house-steps.js); it counts when the
//   received block is what the blueprint draws there. A plant in a cell is cut
//   first. A step refused three times is left, and the others go on.
// - The house is done when every step stands and both large chests have
//   received 54-slot windows; the next play goes on as before. This is the only
//   place that writes `done: true` (house-repair.js says what the record means).
// - A repair asked for one thing of the house (house-repair.js `focusOf`) makes
//   and places only that thing's steps; the keeper (house-damage.js) holds the
//   rest as soon as the thing stands.
// - Not while a hostile is within 12 m or another job runs; ten minutes after
//   a run that placed nothing.
const fs = require('node:fs')
const path = require('node:path')
const { normalizeMode } = require('../bot-mode')
const { placements, remaining, matches, counts } = require('./house-blueprint')
const { houseNeeds, bestWool } = require('./house-needs')
const { pending } = require('./house-supply')
const { findSite, PLANT } = require('./house-site')
const { clicks, stands, standable } = require('./house-steps')
const { underCover } = require('../player-surface')
const { chestPairs, neededChests, verifyHouseChests } = require('./house-large-chests')
const { focusOf } = require('./house-repair')
const { doorOf } = require('./house-door')
const { inside } = require('./house-exit')
const { toEntrance } = require('./house-entry')
const { fillYard } = require('./house-yard')
const { centreOnColumn } = require('../pillar-centre')

const AGAIN_MS = 600000, SHORT_MS = 3000, TRIES = 3, RUN_MS = 20 * 60000
const BLIND = /視線/
const UNCONFIRMED = /確認できませんでした|確定した持ち物|未確定/
const WOODS = 'oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|bamboo|crimson|warped'
const short = name => String(name ?? '').replace(/^minecraft:/, '')
const ITEM = {
  cobblestone: name => name === 'minecraft:cobblestone',
  oak_log: name => new RegExp(`^minecraft:(?:${WOODS})_(?:log|stem)$`).test(name),
  oak_planks: name => new RegExp(`^minecraft:(?:${WOODS})_planks$`).test(name),
  oak_slab: name => new RegExp(`^minecraft:(?:${WOODS})_slab$`).test(name),
  oak_door: name => new RegExp(`^minecraft:(?:(?:${WOODS})_door|wooden_door)$`).test(name),
  white_bed: name => name === 'minecraft:bed',
  glass: name => name === 'minecraft:glass',
  chest: name => name === 'minecraft:chest',
  crafting_table: name => name === 'minecraft:crafting_table',
  furnace: name => name === 'minecraft:furnace',
  torch: name => name === 'minecraft:torch'
}
// The floor, then the table and furnaces, then the blueprint's order.
const EARLY = ['p_178', 'p_179', 'p_180']
// Bedrock names the oak door item minecraft:wooden_door (live 2026-11-17 15:06
// JST: 「サーバーから受信したレシピがありません: minecraft:oak_door」).
const doorItem = kind => kind === 'oak' ? 'minecraft:wooden_door' : `minecraft:${kind}_door`

// The door goes last: the Bot does not open doors, and the bed, the chests and
// the table are inside (live 2026-11-17 06:44-06:52 JST: with the door placed
// early the Bot stood outside the south wall, 72 steps left, nothing placed).
const DOOR = 'p_172'
const order = steps => {
  const rest = steps.filter(step => step.phase !== 'foundation' && !EARLY.includes(step.id) && step.id !== DOOR && !step.ground)
  return [...steps.filter(step => step.phase === 'foundation'), ...EARLY.map(id => steps.find(step => step.id === id)).filter(Boolean), ...rest, ...steps.filter(step => step.id === DOOR), ...steps.filter(step => step.ground)]
}

function createHouseBuild ({ getMode, shared, agent, ports, hands, build = null, openEntrance = async () => false, climb, travel, getBlock, getPosition, getFeet, getInventory, chestWork = null, file = null, write = null, blocked = () => false, hostile = () => false, hostileWhy = () => null, onDone = async () => {}, disposed = () => false, log = () => {}, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  let busy = false, waitUntil = 0, placedTotal = 0
  const work = { begin: async () => true, complete: async () => true, attempt: async () => true, received: async () => true, retry: async () => true, canAttempt: () => true, ...chestWork }
  const live = () => !disposed() && normalizeMode(getMode()) === 'player' && shared.playerWanted === true
  const say = text => log(`プレイヤーモード: ${text}`)
  const settle = async () => { for (let i = 0; i < 40 && agent.settled?.() === false && !disposed(); i++) await sleep(200) }
  const restart = async () => { for (let attempt = 0; attempt < 5 && live(); attempt++) { try { await agent.start({ ...agent.objective }); return } catch { await sleep(2000) } } }
  const items = () => getInventory()?.items ?? []
  const held = test => items().filter(item => item?.count > 0 && test(item.name ?? '')).reduce((sum, item) => sum + item.count, 0)
  const stackOf = test => items().filter(item => item?.count > 0 && test(item.name ?? '')).sort((a, b) => b.count - a.count)[0] ?? null
  const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
  let hunts = 0, unreached = 0, soon = false, unsettled = false, unreachedWhy = null, vain = false
  // Unconfirmed transfers per step, across runs: a step that leaves the
  // inventory unconfirmed twice is counted as a failure from then on (live
  // 2026-11-17 07:52-07:57 JST: one out-of-sight corner block timed out first
  // in every run, each run ended there and nothing else was tried for 5 min).
  const limbo = new Map()
  const eyeTo = (cell, from) => Math.hypot(cell.x + 0.5 - from.x, cell.y + 0.5 - (from.y + 1.62), cell.z + 0.5 - from.z)

  // The counts last read with the whole house received (house-supply.js needsNow) are saved too: after a
  // restart away from the house they are all there is (live 2026-11-17 11:03 JST: a reconnect 140 m away
  // dropped them, the house then looked to need no sand and the sand search never started).
  let savedLeft = JSON.stringify(shared.playerHouse?.left ?? null)
  async function save () {
    if (!file || !write) return
    const left = shared.playerHouse.left
    savedLeft = JSON.stringify(left ?? null)
    try { await write(file, houseDoc(shared.playerHouse, now())) } catch { /* Kept in shared until the next save. */ }
  }

  function due () {
    const inventory = getInventory(), position = getPosition()
    if (!inventory || !position || !pending({ mode: getMode(), playing: shared.playerWanted === true, shared, state: { inventory } })) return false
    const origin = shared.playerHouse?.origin ?? null
    const all = origin ? remaining(getBlock, origin) : placements()
    if (origin && !all.length) return shared.playerHouse?.done !== true
    // One thing of the house asked for: only its steps bring the Bot back, and only their materials are waited for.
    const fresh = step => !(now() - (failedAt.get(step.id) ?? -Infinity) < AGAIN_MS)
    const focus = focusOf(shared.playerHouse)
    const left = focus ? all.filter(step => focus.has(step.id)) : all
    if (!left.length) return false
    // The dug ground round the house (house-yard.js) starts the run while any of its material is held; the
    // house's own steps start it on their logs and cobblestone, as before.
    const house = left.filter(step => !step.ground)
    if (!house.length) return left.some(step => fresh(step) && workable(step))
    const needs = houseNeeds(inventory, counts(house))
    // Logs and cobblestone start it; the glass waits for sand and the bed for
    // wool, so a house is not held back by a desert-less or sheep-less area
    // (live 2026-11-17 03:32 JST: no sand in sight, the build never began).
    if (!needs || needs.need.logs > 0 || needs.need.cobblestone > 0) return false
    // A step the last run failed on waits AGAIN_MS, and the door waits for
    // the rest: neither brings the Bot back (live 2026-11-17 14:06-14:11 JST:
    // a corner block out of sight and the door called it home from the sand
    // after every single sand, one glass per round trip).
    if (left.every(step => step.id === DOOR)) return left.length > 0
    return left.some(step => step.id !== DOOR && fresh(step) && (step.item === 'glass' ? needs.need.sand === 0 : step.item === 'white_bed' ? needs.need.wool === 0 : true))
  }
  const failedAt = new Map()

  const logsKept = left => left.filter(step => step.item === 'oak_log').length

  async function planks (needed, left) {
    for (let i = 0; i < 4 && held(ITEM.oak_planks) < needed; i++) {
      const log = stackOf(ITEM.oak_log), spare = log ? held(ITEM.oak_log) - logsKept(left) : 0
      if (!log || spare <= 0) return false
      if (!await ports.craft(short(log.name).replace(/_(?:log|stem)$/, '_planks').replace(/^/, 'minecraft:'), Math.min(spare, 16, Math.ceil((needed - held(ITEM.oak_planks)) / 4)))) return false
    }
    return held(ITEM.oak_planks) >= needed
  }

  // Slabs and doors take one kind of planks: the kind of which `needed` are
  // held, made from that kind's logs when short (live 06:43 JST: the most held
  // stack was birch, the planks were mostly oak, 「材料が不足しています: birch_planks」).
  async function planksOf (needed, left) {
    const kinds = () => { const by = new Map(); for (const item of items()) if (item?.count > 0 && ITEM.oak_planks(item.name ?? '')) by.set(short(item.name).replace(/_planks$/, ''), (by.get(short(item.name).replace(/_planks$/, '')) ?? 0) + item.count); return [...by].sort((a, b) => b[1] - a[1]) }
    const ready = () => kinds().find(([, n]) => n >= needed)?.[0] ?? null
    if (ready()) return ready()
    const logs = items().filter(item => item?.count > 0 && ITEM.oak_log(item.name ?? '')).sort((a, b) => b.count - a.count)
    for (const log of logs) {
      const kind = short(log.name).replace(/_(?:log|stem)$/, '')
      const short_ = needed - (kinds().find(([k]) => k === kind)?.[1] ?? 0)
      const spare = held(ITEM.oak_log) - logsKept(left)
      const times = Math.min(log.count, spare, Math.ceil(short_ / 4))
      if (times <= 0) continue
      if (await ports.craft(`minecraft:${kind}_planks`, times)) { if (ready()) return ready() }
    }
    return ready()
  }

  // A door standing while other steps are left closes the way in: it is taken
  // down by ordinary mining (it drops back) and placed again last.
  // Steps that can go on now: the glass waits for sand and the bed for wool.
  function workable (step) {
    if (step.ground) return held(ITEM.cobblestone) > 0 || held(name => /^minecraft:(?:dirt|cobbled_deepslate)$/.test(name)) > 0
    if (step.item === 'glass') return held(ITEM.glass) > 0 || held(name => /^minecraft:(?:red_)?sand$/.test(name)) > 0
    if (step.item === 'white_bed') return held(ITEM.white_bed) > 0 || bestWool(items()) >= 3
    return true
  }

  async function openDoorway (origin, todo = null) {
    const door = placements(origin).find(step => step.id === DOOR)
    const left = remaining(getBlock, origin)
    if (!door || left.some(step => step.id === DOOR) || !(todo ?? left).some(step => !step.ground && workable(step))) return false
    const at = door.position
    if (!matches('oak_door', getBlock(at.x, at.y, at.z))) return false
    if (!await near(at)) { say('拠点の家: 入口のドアへ近づけません（中の作業が残っています）'); return false }
    ports.reset?.()
    const ok = await ports.mine(at, { accessPreparation: 'house_door', expectedName: getBlock(at.x, at.y, at.z)?.name })
    say(ok ? '拠点の家: 中の作業が残っているため、入口のドアを外しました（最後に付け直します）' : `拠点の家: 入口のドアを外せません（${ports.why() ?? '不明'}）`)
    return ok
  }

  async function enterForChests (origin, aborted) {
    if (aborted() || inside(origin, getFeet())) return
    const { entry } = await toEntrance({ origin, getBlock, getFeet, hands, build, aborted })
    if (!aborted() && await openEntrance() && entry && !aborted()) await hands.walk(entry)
  }

  const tableAt = origin => { const step = placements(origin).find(s => s.id === 'p_178'); return matches('crafting_table', getBlock(step.position.x, step.position.y, step.position.z)) ? step.position : null }
  const furnaceAt = origin => placements(origin).filter(s => s.item === 'furnace').map(s => s.position).find(at => matches('furnace', getBlock(at.x, at.y, at.z))) ?? null

  // Why the last make() came back empty-handed with no port reason (live
  // 2026-11-17 08:04 JST: 「white_bed を用意できません」 with no reason at all).
  let lack = null
  async function near (cell) {
    const feet = getFeet()
    if (feet && eyeTo(cell, feet) <= 4) return true
    const stand = stands(getBlock, { position: cell, item: 'crafting_table' }, { clicked: cell, face: 1, clickY: null }, feet ?? cell, { reach: 3.8, radius: 3 })[0]
    if (!stand) { lack = `(${cell.x}, ${cell.y}, ${cell.z}) の近くに立てる場所がありません`; return false }
    if (!await hands.walk(stand)) { lack = `(${cell.x}, ${cell.y}, ${cell.z}) へ歩けません: ${hands.why?.() ?? '不明'}`; return false }
    if (eyeTo(cell, getFeet()) > 4.5) { lack = `(${cell.x}, ${cell.y}, ${cell.z}) に届きません`; return false }
    return true
  }

  // Makes what `step` places when none is held. True when one is held.
  async function make (step, origin, left) {
    lack = null
    const needed = step.item === 'chest' ? neededChests(step, origin, getBlock) : 1
    if (held(ITEM[step.item]) >= needed) return true
    const made = await making(step, origin, left)
    if (!made && !lack) lack = step.item === 'white_bed' && bestWool(items()) < 3 ? '同じ色の羊毛が3個ありません' : step.item === 'oak_log' ? '原木を持っていません' : !tableAt(origin) ? '作業台がありません' : '理由不明'
    return made && held(ITEM[step.item]) >= needed
  }

  async function making (step, origin, left) {
    const table = tableAt(origin)
    // Opening the table needs a line of sight to it: once the walls stand the
    // nearest place may be outside them (live 06:43 JST: 98 slab tries, all
    // 「操作対象への視線が遮られているか、未取得です。」). Other places are tried then.
    const atTable = async (output, times) => {
      if (!table) return false
      if (await near(table) && await ports.craft(output, times, table)) return true
      if (!BLIND.test(String(ports.why() ?? ''))) return false
      const feet = getFeet()
      for (const stand of stands(getBlock, { position: table, item: 'crafting_table' }, { clicked: table, face: 1, clickY: null }, feet ?? table, { reach: 3.8, radius: 3 }).slice(1, 5)) {
        if (!await hands.walk(stand)) continue
        ports.reset?.()
        if (await ports.craft(output, times, table)) return true
        if (!BLIND.test(String(ports.why() ?? ''))) return false
      }
      return false
    }
    const count = item => left.filter(s => s.item === item).length
    switch (step.item) {
      case 'oak_planks': return planks(1, left)
      case 'crafting_table': return await planks(4, left) && ports.craft('minecraft:crafting_table', 1)
      case 'oak_slab': { const times = Math.min(16, Math.ceil(count('oak_slab') / 6)); const as = await planksOf(times * 3, left); return !!as && atTable(`minecraft:${as}_slab`, times) }
      case 'oak_door': { const as = await planksOf(6, left); return !!as && atTable(doorItem(as), 1) }
      // One chest at a time: a batch over mixed plank kinds splits unevenly (live 07:32 JST: 「材料の種類が混在しています。1回ずつクラフトしてください。」).
      case 'chest': { const missing = Math.min(count('chest') - held(ITEM.chest), 4); for (let i = 0; i < missing; i++) { if (!(await planks(8, left) && await atTable('minecraft:chest', 1))) break } return held(ITEM.chest) >= neededChests(step, origin, getBlock) }
      case 'white_bed': return bestWool(items()) >= 3 && await planks(3, left) && atTable('minecraft:bed', 1)
      case 'furnace': return held(ITEM.cobblestone) >= 8 && (table ? atTable('minecraft:furnace', 1) : false)
      case 'glass': {
        const furnace = furnaceAt(origin), sand = stackOf(name => /^minecraft:(?:red_)?sand$/.test(name))
        if (!furnace || !sand || !await near(furnace)) return false
        const amount = Math.min(sand.count, count('glass'))
        const coal = stackOf(name => /^minecraft:(?:coal|charcoal)$/.test(name))
        if (!coal && !await planks(Math.ceil(amount / 1.5), left)) return false
        const fuel = coal ?? stackOf(ITEM.oak_planks)
        return await ports.smelt(furnace, sand.name, amount, fuel.name, coal ? 1 : Math.ceil(amount / 1.5), 'minecraft:glass') > 0
      }
      case 'torch': {
        let coal = stackOf(name => /^minecraft:(?:coal|charcoal)$/.test(name))
        if (!coal) {
          // Charcoal from a spare log, planks burning.
          const furnace = furnaceAt(origin), log = stackOf(ITEM.oak_log)
          if (!furnace || !log || held(ITEM.oak_log) <= logsKept(left) || !await planks(2, left) || !await near(furnace)) return false
          if (await ports.smelt(furnace, log.name, 1, stackOf(ITEM.oak_planks).name, 1, 'minecraft:charcoal') < 1) return false
          coal = stackOf(name => /^minecraft:(?:coal|charcoal)$/.test(name))
        }
        if (held(name => name === 'minecraft:stick') < 1 && !(await planks(2, left) && await ports.craft('minecraft:stick', 1))) return false
        return ports.craft('minecraft:torch', 1)
      }
      default: return false
    }
  }

  // One placement of `step`; true when its received block stands.
  let walkWhy = null
  async function put (step) {
    walkWhy = null
    const standing = () => step.cells.every(cell => matches(step.item, getBlock(cell.x, cell.y, cell.z)))
    if (standing()) return true
    for (const cell of step.cells) {
      const found = getBlock(cell.x, cell.y, cell.z)
      if (found?.known === true && PLANT.test(found.name ?? '')) await ports.mine(cell)
    }
    const stack = stackOf(ITEM[step.item])
    if (!stack) return false
    const head = step.item === 'white_bed' ? step.cells[1] : null
    const stopped = () => !live() || blocked() || hostile()
    const place = async (name, plan) => {
      if (step.item !== 'chest') return ports.place(name, plan)
      if (stopped() || !await work.attempt(step.position)) return false
      if (stopped()) { await work.retry(step.position); return false }
      const placed = await ports.place(name, plan)
      if (standing()) { const recorded = await work.received(step.position); return placed && recorded }
      if (ports.placementRetrySafe?.() === true) await work.retry(step.position)
      return false
    }
    for (const click of clicks(getBlock, step)) {
      const plan = { position: step.position, clicked: click.clicked, face: click.face, clickY: click.clickY, head, alignFacing: !!step.look }
      // From here when it reaches; else from the nearest stands.
      // A step drawn facing a way is placed only from a stand behind it.
      const feet = getFeet()
      if (!step.look && await place(stack.name, plan)) { await sleep(150); if (standing()) return true }
      for (const stand of stands(getBlock, step, click, feet ?? step.position).slice(0, 3)) {
        if (!live() || blocked() || hostile()) return false
        if (step.item === 'chest' && !work.canAttempt(step.position)) return standing()
        if (!await hands.walk(stand)) { walkWhy = `歩けません: ${String(hands.why?.() ?? '不明').slice(0, 60)}`; continue }
        if (await place(stackOf(ITEM[step.item])?.name ?? stack.name, plan)) { await sleep(150); if (standing()) return true }
      }
    }
    return standing()
  }

  // To a received stand by the porch (origin + (3, 8)); true when within 8 m.
  // From farther, hops of about 9 m toward it first, over received ground at
  // any height between the Bot's and the house's (a walk plans 16 m at most;
  // live 04:59 JST: 18 m away and 15 blocks up the hill, 「Target lies outside
  // the bounded search area」, then 170 steps tried in vain for 1.5 s).
  async function closeIn (origin, { quiet = false } = {}) {
    const porch = { x: origin.x + 3.5, z: origin.z + 8.5 }
    // Height counts too (live 05:14 JST: out of a 43-step climb onto a hill
    // 23 blocks above the house, every step was 「操作対象が手の届く範囲外です」).
    const away = () => { const at = getFeet(); return at ? Math.hypot(at.x - porch.x, at.z - porch.z, at.y - origin.y) : Infinity }
    const near = (centre, low, high, radius, y = null) => {
      const out = []
      for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) for (let cy = high; cy >= low; cy--) {
        const x = Math.floor(centre.x) + dx, z = Math.floor(centre.z) + dz
        if (standable(getBlock, x, cy, z)) out.push({ x: x + 0.5, y: cy, z: z + 0.5 })
      }
      const cost = cell => Math.hypot(cell.x - centre.x, cell.z - centre.z) + (y == null ? 0 : Math.abs(cell.y - y))
      return out.sort((a, b) => cost(a) - cost(b))
    }
    for (let round = 0; round < 8 && away() > 5; round++) {
      const at = getFeet()
      if (!at) return false
      const d = away(), flatD = Math.hypot(at.x - porch.x, at.z - porch.z), rise = origin.y - at.y
      if (d <= 10) {
        let walked = false
        for (const cell of near(porch, origin.y - 3, origin.y + 2, 3, origin.y).slice(0, 4)) if (await hands.walk(cell)) { walked = true; break }
        if (!walked) break
        continue
      }
      // About 9 m on, down (or up) a few steps toward the house's height.
      const step = Math.min(9, Math.max(0, flatD - 4)), point = flatD > 0.5 ? { x: at.x + (porch.x - at.x) / flatD * step, z: at.z + (porch.z - at.z) / flatD * step } : { x: at.x, z: at.z }
      const goal = Math.floor(at.y) + Math.max(-6, Math.min(4, Math.round(rise)))
      let moved = false
      for (const cell of near(point, Math.floor(at.y) - 7, Math.floor(at.y) + 4, step < 3 ? 4 : 2, goal).slice(0, 3)) {
        await hands.walk(cell)
        if (away() < d - 2) { moved = true; break }
      }
      if (!moved) break
    }
    if (away() <= 8) return true
    unreachedWhy = `拠点の家の前まで歩けません（あと ${Math.round(away())}m、${String(hands.why?.() ?? '不明').slice(0, 80)}）`
    if (!quiet) say(unreachedWhy)
    return false
  }

  async function run () {
    const aborted = () => !live() || blocked() || hostile()
    if (underCover(getBlock, getPosition())) {
      say('拠点の家の材料がそろったため、地上へ出て家を建てます。')
      let out = null
      try { out = await climb(aborted) } catch (error) { out = { ok: false, reason: String(error?.message ?? error).slice(0, 80) } }
      if (aborted() || underCover(getBlock, getPosition())) {
        // Why, and soon again when only an enemy or a pause cut it short (live
        // 07:02 JST: cut off after 10 s with no reason, then 10 minutes idle).
        const why = !live() ? 'プレイ停止' : hostile() ? `近くの敵${hostileWhy() ? `: ${hostileWhy()}` : ''}` : blocked() ? 'ほかの作業・体力' : out?.reason ?? '不明'
        say(`地上へ出られないため、拠点の家を建てられません（${why}）`)
        if (live() && (hostile() || blocked() || out?.reason === 'INTERRUPTED')) soon = true
        return 0
      }
    }
    let origin = shared.playerHouse?.origin ?? null
    if (!origin) {
      origin = findSite(getBlock, getFeet())
      // None here: walk about 80 m on (a new direction each time) and look again.
      if (!origin && getFeet()) {
        const from = getFeet(), angle = (hunts++ % 6) * Math.PI / 3
        say(`近くに拠点の家を建てられる場所（7×8マス、起伏2段まで）がないため、約80m先で探します（${Math.round(angle * 180 / Math.PI)}°）`)
        try { await travel.to({ destination: { x: Math.round(from.x + Math.cos(angle) * 80), z: Math.round(from.z + Math.sin(angle) * 80) } }) } catch {}
        const until = now() + 300000
        while (!aborted() && now() < until && travel.status()?.busy) await sleep(1000)
        if (travel.status()?.busy) { try { await travel.cancel() } catch {} }
        if (!aborted()) origin = findSite(getBlock, getFeet())
      }
      if (!origin) { say('近くに拠点の家を建てられる平らな場所（7×8マス）が見つかりません'); return 0 }
      shared.playerHouse = { origin, done: false }
      say(`拠点の家を (${origin.x}, ${origin.y}, ${origin.z}) から建てます（北西の角）`)
      await save()
    }
    if (flat(origin, getPosition()) > 16) {
      try { await travel.to({ destination: { x: origin.x + 3, z: origin.z + 8 } }) } catch {}
      const until = now() + 300000
      while (!aborted() && now() < until && travel.status()?.busy) await sleep(1000)
      if (travel.status()?.busy) { try { await travel.cancel() } catch {} }
      if (flat(origin, getPosition()) > 12) await hands.approach({ x: origin.x + 3, y: origin.y, z: origin.z + 8 })
    }
    // Long travel counts 20 m as arrived and a hop 12 m: walk on to a received
    // stand by the porch, so the steps are within reach (live 04:48 JST: 16 m
    // short of the house, all 14 tries were 「操作対象が手の届く範囲外です」).
    const verificationOnly = remaining(getBlock, origin).length === 0
    const feet = getFeet(), entrance = verificationOnly ? doorOf(origin) : null
    const nearEntrance = entrance && feet && eyeTo(entrance, feet) <= 16 && Math.abs(feet.y - entrance.y) <= 6
    // A house that has stood is reached at the stand outside its door, not by distance: 8 m of the porch is also the
    // far side of a wall or of the ground dug away round it. From outside the walls the run goes on to that stand, by
    // the plain walk, else by the way that digs and stacks (house-entry.js; live 2026-11-23 20:05-20:16 JST: four runs
    // of 「拠点の家の前まで歩けません」, nothing placed; 21:32 JST: 7 m from the porch, outside the west wall with no walk
    // to the door, 3 m from the table through the wall: 「oak_slab を用意できません: 作業台への既知の視線がありません」 x3).
    const stood = !verificationOnly && shared.playerHouse?.built === true
    let reached = nearEntrance || await closeIn(origin, { quiet: stood && !!build })
    if (stood && !aborted() && !inside(origin, getFeet())) {
      const entered = await toEntrance({ origin, getBlock, getFeet, hands, build, aborted })
      if (entered.ok) reached = true
      else if (!aborted()) say(reached ? `拠点の家: 入口の前へ行けませんでした（${entered.code}）。今いる場所から手を試します` : `${unreachedWhy ?? '拠点の家の前まで歩けません'}。入口の前へ掘る・積む道でも行けませんでした（${entered.code}）`)
    }
    if (!reached) {
      // A site the Bot cannot walk to twice running, with little built yet, is
      // given up for one near the Bot (live 2026-11-17 05:28-05:36 JST: the
      // site lay 9-23 blocks below a steep slope, 「No safe route found」).
      const built = placements(origin).length - remaining(getBlock, origin).filter(step => !step.ground).length
      if (++unreached >= 2 && built < 30) {
        say(`拠点の家の場所 (${origin.x}, ${origin.y}, ${origin.z}) へ歩けないため、別の場所に建て直します（置いた ${built} 個は残します）`)
        shared.playerHouse = null
        unreached = 0
        try { if (file) await fs.promises.rm(file, { force: true }) } catch {}
      }
      soon = true
      return 0
    }
    unreached = 0
    // The steps of this run: the whole blueprint, or the one thing a job asked for (and the door again when this run took it down).
    const fresh = step => !(now() - (failedAt.get(step.id) ?? -Infinity) < AGAIN_MS)
    const focus = focusOf(shared.playerHouse)
    const todo = () => { const all = remaining(getBlock, origin); return focus ? all.filter(step => focus.has(step.id)) : all }
    if (verificationOnly) {
      await enterForChests(origin, aborted)
    } else if (await openDoorway(origin, todo()) && focus) focus.add(DOOR)
    const fails = new Map(), started = now()
    let placed = 0, closing = false, yardPass = -1, yardEnded = false
    let largeChests = []
    const verifyChests = async () => { largeChests = await verifyHouseChests({ origin, getBlock, getFeet, hands, ports, aborted, build, confirmed: largeChests, complete: work.complete }); return largeChests.length === chestPairs(origin).length }
    const reasons = new Map()
    const note = (step, text) => { if (!reasons.has(text)) reasons.set(text, { count: 0, step }); reasons.get(text).count++ }
    // Passes go on while one places something (each step is tried TRIES times at most).
    for (let pass = 0; !aborted() && now() - started < RUN_MS; pass++) {
      let progress = 0
      for (const step of order(todo())) {
        if (aborted() || now() - started > RUN_MS) break
        if ((fails.get(step.id) ?? 0) >= TRIES) continue
        // The ground round the house: all its columns at once, from outside (house-yard.js), once a pass.
        // It is the last thing of a run, after the door is back (the closing pass): the fill leaves the Bot outside, in the ring.
        if (step.ground) {
          if (yardPass === pass || !closing || todo().some(other => other.id === DOOR && (fails.get(other.id) ?? 0) < TRIES)) continue
          yardPass = pass
          const filled = await fillYard({ origin, getBlock, hands, aborted, log, sleep, centre: (column, base) => centreOnColumn({ column, base, feet: hands.feet, block: hands.block, walk: hands.walk, aborted }) })
          placed += filled.placed
          progress += filled.placed
          if (!filled.placed) for (const other of todo()) if (other.ground) { fails.set(other.id, TRIES); note(other, `まわりの地面を埋め戻せません（${String(filled.why ?? '不明').slice(0, 60)}）`) }
          // The fill ends outside, in the ring: the run ends there (the next one goes in by the entrance).
          if (filled.tried) { yardEnded = true; break }
          continue
        }
        // The door only once nothing else is left: placed while slabs or glass
        // wait it is taken down again on the next run (live 07:22-07:23 JST).
        if (step.id === DOOR && !closing && todo().some(other => other.id !== DOOR && !other.ground && workable(other) && (fails.get(other.id) ?? 0) < TRIES)) continue
        if (closing && step.id !== DOOR) continue // (the ground is above)
        if (step.id === DOOR && !await verifyChests()) continue
        const left = todo()
        ports.reset?.()
        // The server has not confirmed the last transfer: every further craft or
        // placement would fail the same way (live 06:40 JST: about 90 steps used
        // up their tries within 0.1 s). Stop here and come back shortly.
        const settling = () => UNCONFIRMED.test(String(ports.why() ?? '')) && (limbo.set(step.id, (limbo.get(step.id) ?? 0) + 1), limbo.get(step.id) <= 2)
        if (step.item === 'chest') {
          const pair = chestPairs(origin).find(pair => pair.some(other => other.id === step.id))
          if (!pair || !await work.begin(pair.map(other => other.position)) || !work.canAttempt(step.position) || aborted()) { unsettled = true; break }
        }
        if (!await make(step, origin, left)) { if (settling()) { unsettled = true; break } fails.set(step.id, (fails.get(step.id) ?? 0) + 1); const lacking = ports.why() ?? lack; note(step, `${step.item} を用意できません${lacking ? `: ${lacking}` : ''}`); if (fails.get(step.id) === TRIES) say(`拠点の家: ${step.item} を用意できません（${step.id}${lacking ? `: ${lacking}` : ''}）`); continue }
        if (await put(step)) { if (step.id !== DOOR) placed++; progress++; continue }
        if (settling()) { unsettled = true; break }
        fails.set(step.id, (fails.get(step.id) ?? 0) + 1)
        note(step, String(walkWhy ?? ports.why() ?? hands.why?.() ?? (clicks(getBlock, step).length ? '置けませんでした' : 'クリックできる面がありません')).slice(0, 80))
        if (fails.get(step.id) === TRIES) say(`拠点の家: ${step.item} を (${step.position.x}, ${step.position.y}, ${step.position.z}) に置けません（${ports.why() ?? hands.why?.() ?? '不明'}）`)
      }
      if (unsettled) break
      // After the fill only the door is put back in this run (the house's steps wait for the next run, from inside).
      if (yardEnded) break
      // Nothing more goes up in this run of a repair: the door is put back before the run ends, so the house is not left open
      // for the hour until the rest is looked at again (live 2026-11-23 23:05-2026-11-24 00:08 JST: one roof slab
      // out of sight from every stand, the door down since 22:57).
      if (!progress) { if (closing || aborted() || !todo().some(step => (stood && step.id === DOOR) || (step.ground && (fails.get(step.id) ?? 0) < TRIES))) break; closing = true }
    }
    // A run that failed on every step it could still work on: the keeper holds the repair on it (house-damage.js).
    const rest = todo().filter(step => step.id !== DOOR && workable(step))
    vain = !aborted() && !unsettled && rest.length > 0 && rest.every(step => (fails.get(step.id) ?? 0) > 0)
    // Cut short by an enemy or a pause before or between the steps: say so and
    // come back in 2 minutes, not 10 (live 2026-11-17 14:19 JST: a witch and two
    // skeletons by the house, 「0 個置きました」 with no reason at all).
    // Which enemy it was goes with the line (work-danger.js; live 2026-11-20 22:15-22:44 JST: six runs cut short with nothing in the log near them).
    if (aborted() && live()) { soon = true; const who = hostile() ? hostileWhy() : null; say(`拠点の家: ${hostile() ? '敵が近い' : 'ほかの作業が始まった'}ため中断しました（2分後に続けます）${who ? `。相手: ${who}` : ''}`) }
    const left = remaining(getBlock, origin)
    const chestsVerified = !aborted() && await verifyChests()
    for (const step of left) if ((fails.get(step.id) ?? 0) > 0 && workable(step)) failedAt.set(step.id, now())
    if (!left.length && chestsVerified) {
      shared.playerHouse = { ...shared.playerHouse, origin, done: true, built: true }
      await save()
      say(`拠点の家が完成しました (${origin.x}, ${origin.y}, ${origin.z})`)
    } else {
      say(`拠点の家: ${placed} 個置きました（残り ${left.length} 個）`)
      // Why the rest stayed: the three commonest reasons, with one step each.
      const top = [...reasons].sort((a, b) => b[1].count - a[1].count).slice(0, 3)
      if (top.length) say(`拠点の家: 置けなかった理由 ${top.map(([text, { count, step }]) => `${text}（${count}回、${step.item} (${step.position.x}, ${step.position.y}, ${step.position.z})）`).join(' / ')}`)
      if (!chestsVerified) say('拠点の家: ラージチェスト2組の54枠を受信するまで完成を保留します')
    }
    // The chest A and the bed are used as soon as they stand, finished or not.
    try { await onDone(origin, { largeChests }) } catch (error) { say(`拠点の家の仕上げ（拠点・ベッド）に失敗しました ${String(error?.message ?? error).slice(0, 80)}`) }
    return placed
  }

  let repairSince = shared.playerHouse?.repair?.since ?? null
  async function tick () {
    if (shared.playerHouse?.origin && JSON.stringify(shared.playerHouse.left ?? null) !== savedLeft) await save()
    // A repair begun or begun again is a new start: the wait after the last run that placed nothing belongs to the one before.
    const since = shared.playerHouse?.repair?.state === 'running' ? shared.playerHouse.repair.since : null
    if (since !== repairSince) { repairSince = since; if (since !== null) { waitUntil = 0; failedAt.clear() } }
    if (!live() || busy || blocked() || hostile() || travel.status()?.busy || now() < waitUntil || !due()) return null
    busy = true
    let placed = 0
    try {
      agent.stop('拠点の家を建てます。')
      await settle()
      vain = false
      placed = await run()
      const repair = shared.playerHouse?.repair
      if (vain && repair?.state === 'running') shared.playerHouseTried = { since: repair.since, at: now() }
      placedTotal += placed
      return placed > 0
    } catch (error) {
      say(`拠点の家を建てられません ${String(error?.message ?? error).slice(0, 120)}`)
      return false
    } finally {
      waitUntil = now() + (shared.playerHouse?.done ? 0 : placed > 0 || unsettled ? SHORT_MS : soon ? 120000 : AGAIN_MS)
      soon = false
      unsettled = false
      busy = false
      // Something placed and more to do: stay at the house for the next run
      // instead of letting the agent wander off (live 04:30-04:42 JST: after
      // 14 blocks it went mining and could not climb back out).
      if (!(placed > 0 && live() && !shared.playerHouse?.done && due())) await restart()
    }
  }

  return { tick, closeIn, status: () => ({ active: busy, reason: busy ? '拠点の家を建てています。' : null, placed: placedTotal, house: shared.playerHouse ?? null }) }
}

// The house's record: .local/player-house.json (house-repair.js says what each field means).
const houseFile = root => path.resolve(root, '.local', 'player-house.json')
function houseDoc (house, at = Date.now()) {
  const { left, repair } = house
  return { version: 1, origin: house.origin, done: house.done === true, spawn: house.spawn === true, ...(house.built === true ? { built: true } : {}), ...(left ? { left } : {}), ...(repair ? { repair } : {}), savedAt: new Date(at).toISOString() }
}
// A repair read back: only a shape this code wrote. A file of the code before has none, and its `done: true` is
// what was last observed then, not what stands now (the keeper and every job read the blocks again).
function repairOf (value) {
  if (!value || !['running', 'held'].includes(value.state) || !Number.isFinite(value.since)) return null
  const names = list => Array.isArray(list) ? list.filter(id => typeof id === 'string').slice(0, 64) : null
  const out = { state: value.state, since: value.since }
  if (typeof value.need === 'string') out.need = value.need
  if (names(value.focus)?.length) out.focus = names(value.focus)
  if (value.tried && typeof value.tried === 'object') out.tried = Object.fromEntries(Object.entries(value.tried).filter(([, at]) => Number.isFinite(at)))
  if (value.state === 'held') {
    if (!Number.isFinite(value.until)) return null
    out.heldAt = Number.isFinite(value.heldAt) ? value.heldAt : value.since
    out.until = value.until
    const basis = value.basis ?? {}
    out.basis = { missing: Number.isFinite(basis.missing) ? basis.missing : null, short: basis.short && typeof basis.short === 'object' ? { ...basis.short } : null, seen: basis.seen === true }
  }
  return out
}
function loadHouseSync (file, { io = fs } = {}) {
  try {
    const value = JSON.parse(String(io.readFileSync(file, 'utf8')).replace(/^\uFEFF/, ''))
    const origin = value?.origin
    const left = value?.left && typeof value.left === 'object' && Object.values(value.left).every(Number.isSafeInteger) ? { ...value.left } : null
    const repair = repairOf(value?.repair)
    return origin && [origin.x, origin.y, origin.z].every(Number.isSafeInteger) ? { origin: { x: origin.x, y: origin.y, z: origin.z }, done: value.done === true, spawn: value.spawn === true, ...(value.built === true ? { built: true } : {}), ...(left ? { left } : {}), ...(repair ? { repair } : {}) } : null
  } catch { return null }
}

module.exports = { createHouseBuild, order, ITEM, doorItem, houseFile, houseDoc, loadHouseSync }
