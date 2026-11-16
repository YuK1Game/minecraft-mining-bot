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
// - The house is done when every step stands; the next play goes on as before.
// - Not while a hostile is within 12 m or another job runs; ten minutes after
//   a run that placed nothing.
const fs = require('node:fs')
const path = require('node:path')
const { normalizeMode } = require('../bot-mode')
const { placements, remaining, matches, counts } = require('./house-blueprint')
const { houseNeeds } = require('./house-needs')
const { pending } = require('./house-supply')
const { findSite, PLANT } = require('./house-site')
const { clicks, stands } = require('./house-steps')
const { underCover } = require('../player-surface')

const AGAIN_MS = 600000, SHORT_MS = 3000, TRIES = 3, RUN_MS = 20 * 60000
const WOODS = 'oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|bamboo|crimson|warped'
const short = name => String(name ?? '').replace(/^minecraft:/, '')
const ITEM = {
  cobblestone: name => name === 'minecraft:cobblestone',
  oak_log: name => new RegExp(`^minecraft:(?:${WOODS})_(?:log|stem)$`).test(name),
  oak_planks: name => new RegExp(`^minecraft:(?:${WOODS})_planks$`).test(name),
  oak_slab: name => new RegExp(`^minecraft:(?:${WOODS})_slab$`).test(name),
  oak_door: name => new RegExp(`^minecraft:(?:${WOODS})_door$`).test(name),
  white_bed: name => name === 'minecraft:bed',
  glass: name => name === 'minecraft:glass',
  chest: name => name === 'minecraft:chest',
  crafting_table: name => name === 'minecraft:crafting_table',
  furnace: name => name === 'minecraft:furnace',
  torch: name => name === 'minecraft:torch'
}
// The floor, then the table and furnaces, then the blueprint's order.
const EARLY = ['p_178', 'p_179', 'p_180']
const order = steps => [...steps.filter(step => step.phase === 'foundation'), ...EARLY.map(id => steps.find(step => step.id === id)).filter(Boolean), ...steps.filter(step => step.phase !== 'foundation' && !EARLY.includes(step.id))]

function createHouseBuild ({ getMode, shared, agent, ports, hands, climb, travel, getBlock, getPosition, getFeet, getInventory, file = null, write = null, blocked = () => false, hostile = () => false, onDone = async () => {}, disposed = () => false, log = () => {}, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  let busy = false, waitUntil = 0, placedTotal = 0
  const live = () => !disposed() && normalizeMode(getMode()) === 'player' && shared.playerWanted === true
  const say = text => log(`プレイヤーモード: ${text}`)
  const settle = async () => { for (let i = 0; i < 40 && agent.settled?.() === false && !disposed(); i++) await sleep(200) }
  const restart = async () => { for (let attempt = 0; attempt < 5 && live(); attempt++) { try { await agent.start({ ...agent.objective }); return } catch { await sleep(2000) } } }
  const items = () => getInventory()?.items ?? []
  const held = test => items().filter(item => item?.count > 0 && test(item.name ?? '')).reduce((sum, item) => sum + item.count, 0)
  const stackOf = test => items().filter(item => item?.count > 0 && test(item.name ?? '')).sort((a, b) => b.count - a.count)[0] ?? null
  const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
  let hunts = 0
  const eyeTo = (cell, from) => Math.hypot(cell.x + 0.5 - from.x, cell.y + 0.5 - (from.y + 1.62), cell.z + 0.5 - from.z)

  async function save () {
    if (!file || !write) return
    try { await write(file, { version: 1, origin: shared.playerHouse.origin, done: shared.playerHouse.done === true, spawn: shared.playerHouse.spawn === true, savedAt: new Date(now()).toISOString() }) } catch { /* Kept in shared until the next save. */ }
  }

  function due () {
    const inventory = getInventory(), position = getPosition()
    if (!inventory || !position || !pending({ mode: getMode(), playing: shared.playerWanted === true, shared, state: { inventory } })) return false
    const origin = shared.playerHouse?.origin ?? null
    const left = origin ? remaining(getBlock, origin) : placements()
    const needs = houseNeeds(inventory, counts(left))
    // Logs and cobblestone start it; the glass waits for sand and the bed for
    // wool, so a house is not held back by a desert-less or sheep-less area
    // (live 2026-11-17 03:32 JST: no sand in sight, the build never began).
    if (!needs || needs.need.logs > 0 || needs.need.cobblestone > 0) return false
    return left.some(step => step.item === 'glass' ? needs.need.sand === 0 : step.item === 'white_bed' ? needs.need.wool === 0 : true)
  }

  // The wood kind most held, for crafted wood.
  const wood = () => { const stack = stackOf(name => ITEM.oak_planks(name) || ITEM.oak_log(name)); return stack ? short(stack.name).replace(/_(?:planks|log|stem)$/, '') : null }
  const logsKept = left => left.filter(step => step.item === 'oak_log').length

  async function planks (needed, left) {
    for (let i = 0; i < 4 && held(ITEM.oak_planks) < needed; i++) {
      const log = stackOf(ITEM.oak_log), spare = log ? held(ITEM.oak_log) - logsKept(left) : 0
      if (!log || spare <= 0) return false
      if (!await ports.craft(short(log.name).replace(/_(?:log|stem)$/, '_planks').replace(/^/, 'minecraft:'), Math.min(spare, 16, Math.ceil((needed - held(ITEM.oak_planks)) / 4)))) return false
    }
    return held(ITEM.oak_planks) >= needed
  }

  const tableAt = origin => { const step = placements(origin).find(s => s.id === 'p_178'); return matches('crafting_table', getBlock(step.position.x, step.position.y, step.position.z)) ? step.position : null }
  const furnaceAt = origin => placements(origin).filter(s => s.item === 'furnace').map(s => s.position).find(at => matches('furnace', getBlock(at.x, at.y, at.z))) ?? null

  async function near (cell) {
    const feet = getFeet()
    if (feet && eyeTo(cell, feet) <= 4) return true
    const stand = stands(getBlock, { position: cell, item: 'crafting_table' }, { clicked: cell, face: 1, clickY: null }, feet ?? cell, { reach: 3.8, radius: 3 })[0]
    return !!stand && await hands.walk(stand) && eyeTo(cell, getFeet()) <= 4.5
  }

  // Makes what `step` places when none is held. True when one is held.
  async function make (step, origin, left) {
    if (held(ITEM[step.item]) > 0) return true
    const table = tableAt(origin), kind = wood()
    const atTable = async (output, times) => table && await near(table) && ports.craft(output, times, table)
    const count = item => left.filter(s => s.item === item).length
    switch (step.item) {
      case 'oak_planks': return planks(1, left)
      case 'crafting_table': return await planks(4, left) && ports.craft('minecraft:crafting_table', 1)
      case 'oak_slab': { const times = Math.min(16, Math.ceil(count('oak_slab') / 6)); return !!kind && await planks(times * 3, left) && atTable(`minecraft:${kind}_slab`, times) }
      case 'oak_door': return !!kind && await planks(6, left) && atTable(`minecraft:${kind}_door`, 1)
      case 'chest': { const times = Math.min(count('chest'), 4); return await planks(times * 8, left) && atTable('minecraft:chest', times) }
      case 'white_bed': return held(name => /_wool$/.test(name)) >= 3 && await planks(3, left) && atTable('minecraft:bed', 1)
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
  async function put (step) {
    const standing = () => step.cells.every(cell => matches(step.item, getBlock(cell.x, cell.y, cell.z)))
    if (standing()) return true
    for (const cell of step.cells) {
      const found = getBlock(cell.x, cell.y, cell.z)
      if (found?.known === true && PLANT.test(found.name ?? '')) await ports.mine(cell)
    }
    const stack = stackOf(ITEM[step.item])
    if (!stack) return false
    const head = step.item === 'white_bed' ? step.cells[1] : null
    for (const click of clicks(getBlock, step)) {
      const plan = { position: step.position, clicked: click.clicked, face: click.face, clickY: click.clickY, head, alignFacing: !!step.look }
      // From here when it reaches; else from the nearest stands.
      // A step drawn facing a way is placed only from a stand behind it.
      const feet = getFeet()
      if (!step.look && await ports.place(stack.name, plan)) { await sleep(150); if (standing()) return true }
      for (const stand of stands(getBlock, step, click, feet ?? step.position).slice(0, 3)) {
        if (!live() || blocked() || hostile()) return false
        if (!await hands.walk(stand)) continue
        if (await ports.place(stackOf(ITEM[step.item])?.name ?? stack.name, plan)) { await sleep(150); if (standing()) return true }
      }
    }
    return standing()
  }

  async function run () {
    const aborted = () => !live() || blocked() || hostile()
    if (underCover(getBlock, getPosition())) {
      say('拠点の家の材料がそろったため、地上へ出て家を建てます。')
      try { await climb(aborted) } catch {}
      if (aborted() || underCover(getBlock, getPosition())) { say('地上へ出られないため、拠点の家を建てられません'); return 0 }
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
    const fails = new Map(), started = now()
    let placed = 0
    const reasons = new Map()
    const note = (step, text) => { if (!reasons.has(text)) reasons.set(text, { count: 0, step }); reasons.get(text).count++ }
    // Passes go on while one places something (each step is tried TRIES times at most).
    for (let pass = 0; !aborted() && now() - started < RUN_MS; pass++) {
      let progress = 0
      for (const step of order(remaining(getBlock, origin))) {
        if (aborted() || now() - started > RUN_MS) break
        if ((fails.get(step.id) ?? 0) >= TRIES) continue
        const left = remaining(getBlock, origin)
        if (!await make(step, origin, left)) { fails.set(step.id, (fails.get(step.id) ?? 0) + 1); note(step, `${step.item} を用意できません${ports.why() ? `: ${ports.why()}` : ''}`); if (fails.get(step.id) === TRIES) say(`拠点の家: ${step.item} を用意できません（${step.id}${ports.why() ? `: ${ports.why()}` : ''}）`); continue }
        if (await put(step)) { placed++; progress++; continue }
        fails.set(step.id, (fails.get(step.id) ?? 0) + 1)
        note(step, String(ports.why() ?? hands.why?.() ?? (clicks(getBlock, step).length ? '置けませんでした' : 'クリックできる面がありません')).slice(0, 80))
        if (fails.get(step.id) === TRIES) say(`拠点の家: ${step.item} を (${step.position.x}, ${step.position.y}, ${step.position.z}) に置けません（${ports.why() ?? hands.why?.() ?? '不明'}）`)
      }
      if (!progress) break
    }
    const left = remaining(getBlock, origin)
    if (!left.length) {
      shared.playerHouse = { ...shared.playerHouse, origin, done: true }
      await save()
      say(`拠点の家が完成しました (${origin.x}, ${origin.y}, ${origin.z})`)
    } else {
      say(`拠点の家: ${placed} 個置きました（残り ${left.length} 個）`)
      // Why the rest stayed: the three commonest reasons, with one step each.
      const top = [...reasons].sort((a, b) => b[1].count - a[1].count).slice(0, 3)
      if (top.length) say(`拠点の家: 置けなかった理由 ${top.map(([text, { count, step }]) => `${text}（${count}回、${step.item} (${step.position.x}, ${step.position.y}, ${step.position.z})）`).join(' / ')}`)
    }
    // The chest A and the bed are used as soon as they stand, finished or not.
    try { await onDone(origin) } catch (error) { say(`拠点の家の仕上げ（拠点・ベッド）に失敗しました ${String(error?.message ?? error).slice(0, 80)}`) }
    return placed
  }

  async function tick () {
    if (!live() || busy || blocked() || hostile() || travel.status()?.busy || now() < waitUntil || !due()) return null
    busy = true
    let placed = 0
    try {
      agent.stop('拠点の家を建てます。')
      await settle()
      placed = await run()
      placedTotal += placed
      return placed > 0
    } catch (error) {
      say(`拠点の家を建てられません ${String(error?.message ?? error).slice(0, 120)}`)
      return false
    } finally {
      waitUntil = now() + (shared.playerHouse?.done ? 0 : placed > 0 ? SHORT_MS : AGAIN_MS)
      busy = false
      // Something placed and more to do: stay at the house for the next run
      // instead of letting the agent wander off (live 04:30-04:42 JST: after
      // 14 blocks it went mining and could not climb back out).
      if (!(placed > 0 && live() && !shared.playerHouse?.done && due())) await restart()
    }
  }

  return { tick, status: () => ({ active: busy, reason: busy ? '拠点の家を建てています。' : null, placed: placedTotal, house: shared.playerHouse ?? null }) }
}

// The house's record: .local/player-house.json ({ origin, done }).
const houseFile = root => path.resolve(root, '.local', 'player-house.json')
function loadHouseSync (file, { io = fs } = {}) {
  try {
    const value = JSON.parse(String(io.readFileSync(file, 'utf8')).replace(/^\uFEFF/, ''))
    const origin = value?.origin
    return origin && [origin.x, origin.y, origin.z].every(Number.isSafeInteger) ? { origin: { x: origin.x, y: origin.y, z: origin.z }, done: value.done === true, spawn: value.spawn === true } : null
  } catch { return null }
}

module.exports = { createHouseBuild, order, ITEM, houseFile, loadHouseSync }
