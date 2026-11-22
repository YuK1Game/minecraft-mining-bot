'use strict'

// Player mode: a base on the surface. Everything carried was lost at every
// death (real Realm 2026-11-16: 12 diamonds at 16:23, 11 at 19:30 JST; 111
// held at 01:34 JST 2026-11-17 with no chest anywhere; user 01:32 JST:
// 「拠点を作る必要はない？」).
// - The base is a large chest on the surface, recorded in shared.playerBase
//   and .local/player-base.json so it outlives a restart.
// - When 16 or more diamonds beyond the 8 kept are held, or the Bot stands on
//   the surface within 32 m of the base with any to spare, the run stops: out
//   of the tunnel (the climb), the long walk to the base, a walk beside the
//   chest, and the spare diamonds, other valuables and rubble go in.
// - With no base yet (or one farther than 1024 m, after a respawn), the base
//   is made where the Bot comes out: a large chest from held wood, as the
//   storage chest is (player-storage.js). Without that wood the trip only
//   climbs out, and the base is made on the surface once wood is held.
// - A deposit counts by the received inventory, the chest by the received block.
// - This file decides when a trip is due and what is banked. The trip itself is
//   one goal kept through failures, fights, reloads and restarts
//   (return/return-runner.js, docs/player-return.md).
const fs = require('node:fs')
const path = require('node:path')
const { writeDurableJson } = require('../common/durable-json')
const { storable } = require('./player-storage-rubble')
const { chestsNear } = require('./player-storage')
const { underCover } = require('./player-surface')
const { bankableAll, restockable, essential, kitMissing } = require('./player-base-kit')
const { baseChests, knownSlots } = require('./base-chests')
const { createReturnRunner } = require('./return/return-runner')
const { standsBeside } = require('./return/return-steps')

const CHEST = 'minecraft:chest'
const DIAMOND = 'minecraft:diamond'
const KEEP = 8, BANK_AT = 16, NEAR_M = 96, DEEP_DIAMONDS = 8, DEEP_VALUABLES = 32, NEAR_STACKS = 4, FAR_M = 1024
// The chests at the base are looked for again after SCAN_MS; one that was tried and is still unknown rests TRIED_MS.
const SCAN_MS = 5000, TRIED_MS = 30 * 60000
const VALUABLE = /^minecraft:(?:emerald|lapis_lazuli|redstone|raw_gold|gold_ingot|gold_nugget|amethyst_shard|quartz)$/
const PRECIOUS = /^minecraft:(?:diamond|emerald|lapis_lazuli|redstone|raw_gold|gold_ingot|gold_nugget|amethyst_shard|quartz|iron_ingot|raw_iron|raw_copper|copper_ingot|gold_block|iron_block|diamond_block)$/

const baseFile = root => path.resolve(root, '.local', 'player-base.json')
function loadBaseSync (file, { io = fs } = {}) {
  try {
    const value = JSON.parse(String(io.readFileSync(file, 'utf8')).replace(/^﻿/, ''))?.chest
    return value && [value.x, value.y, value.z].every(Number.isSafeInteger) ? { x: value.x, y: value.y, z: value.z } : null
  } catch { return null }
}

const slotItems = inventory => (inventory?.items ?? []).filter(item => item?.count > 0 && Number.isInteger(item.slot) && item.slot >= 0 && item.slot < 36)

// What goes into the base: diamonds beyond the kept 8 (kept in the largest
// stacks), other valuables, and what the storage chest takes (rubble, worn pickaxes).
function bankable (inventory, keep = KEEP) {
  if (inventory?.known !== true || inventory.uncertain) return []
  const items = slotItems(inventory), out = []
  let left = keep
  for (const item of items.filter(item => item.name === DIAMOND).sort((a, b) => b.count - a.count)) {
    if (left >= item.count) { left -= item.count; continue }
    out.push({ slot: item.slot, name: item.name, count: item.count - left }); left = 0
  }
  for (const item of items) if (VALUABLE.test(item.name)) out.push({ slot: item.slot, name: item.name, count: item.count })
  const taken = new Set(out.map(stack => stack.slot))
  return [...out, ...storable(inventory).filter(stack => !taken.has(stack.slot))]
}

// A cell to stand in beside the chest (return/return-steps.js).
const standBeside = (getBlock, chest) => standsBeside(getBlock, chest)[0] ?? null

function createPlayerBase ({ getMode, shared, agent, hands, chest, canBuild = () => true, pendingChest = () => false, door = async () => true, porchWalk = async () => false, spares = () => [], porch = () => null, climb, travel, walk, approach, build = null, water = { needed: () => false, exit: async () => ({ ok: true }) }, house = { inside: () => false, leave: async () => true }, scope = () => null, dimension = () => null, interrupter = null, getBlock, getPosition, getFeet, getInventory, getWorn = () => null, getMineKeep = () => null, file = null, returnFile = null, write = writeDurableJson, blocked = () => false, hostile = () => false, disposed = () => false, log = () => {}, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const say = text => log(`プレイヤーモード: ${text}`)
  const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
  const isChest = at => { const found = getBlock(at.x, at.y, at.z); return found?.known === true && found.name === CHEST }

  async function record (at) {
    shared.playerBase = { x: at.x, y: at.y, z: at.z }
    say(`拠点のチェストを (${at.x}, ${at.y}, ${at.z}) に決めました`)
    if (file) { try { await write(file, { version: 1, chest: shared.playerBase, savedAt: new Date(now()).toISOString() }) } catch { /* Kept in shared until the next save. */ } }
    return shared.playerBase
  }

  // Everything but the kit goes in (player-base-kit.js; user 2026-11-17 11:09 JST:
  // 「必要最低限のアイテム以外はチェストに格納するようにして」). The trip starts:
  // from a tunnel with 8 diamonds or 32 other valuables to bank; on the surface
  // within 96 m of the base with any valuable or 4 stacks to bank.
  // Diamonds first, then the other valuables, then the rest: when the chest
  // fills up on the way, the rubble is what stays out (live 2026-11-18 03:16 JST:
  // 112 items of rubble went in, the chest was full, 17 diamonds were not banked).
  const rank = stack => stack.name === DIAMOND ? 0 : PRECIOUS.test(stack.name) ? 1 : 2
  const stacksNow = () => {
    const inventory = getInventory()
    return bankableAll(inventory, { worn: getWorn(), keep: getMineKeep(inventory) }).sort((a, b) => rank(a) - rank(b))
  }
  // Diamonds and supplies to take back out (player-base-kit.js): from a chest
  // whose received slots hold them, or one not opened yet while diamonds are short.
  const chests = () => shared.playerBase ? [shared.playerBase, ...spares()] : []
  const takeable = slots => restockable(getInventory(), getWorn(), slots)
  // The other chests standing at the base (base-chests.js) may hold them too:
  // each is opened once. One that was tried and is still not known (it did not
  // open, no way to it) is not a reason for another trip for TRIED_MS.
  let scan = { at: -Infinity, list: [] }
  const around = () => { if (!shared.playerBase) return []; if (now() - scan.at >= SCAN_MS) scan = { at: now(), list: baseChests(getBlock, [shared.playerBase, ...spares()], { contents: hands.contents }) }; return scan.list }
  const cell = at => `${at.x},${at.y},${at.z}`
  const tried = at => ((shared.playerChestTried ??= {})[cell(at)] ?? 0) > now()
  const noteTried = at => { (shared.playerChestTried ??= {})[cell(at)] = now() + TRIED_MS }
  const diamondsShort = () => restockable(getInventory(), getWorn(), [{ slot: 0, known: true, name: DIAMOND, count: 64 }]).length > 0
  // Diamonds short, or the kit missing after a death (no weapon, pickaxe, food or armour: player-base-kit.js).
  const lacking = () => diamondsShort() || kitMissing(getInventory(), getWorn())
  // A trip is made for diamonds, gear or food a chest is known to hold, or to
  // open a chest not opened yet while they are missing (each tried one rests TRIED_MS).
  function short () {
    const diamonds = diamondsShort(), missing = diamonds || kitMissing(getInventory(), getWorn())
    const holds = at => { const slots = knownSlots(getBlock, hands.contents, at); return slots ? takeable(slots).some(want => essential(want.name)) : null }
    return chests().filter(isChest).some(at => holds(at) ?? (diamonds || (missing && !tried(at)))) || around().some(at => isChest(at) && (holds(at) ?? (missing && !tried(at))))
  }
  const restockWanted = () => { const position = getPosition(); return !!position && !!shared.playerBase && flat(shared.playerBase, position) <= NEAR_M && !underCover(getBlock, position) && !!hands.take && short() }
  // Why a trip is due now, or null.
  function dueReason () {
    const inventory = getInventory(), position = getPosition()
    if (!inventory || !position) return null
    if (restockWanted()) return diamondsShort() ? '拠点のチェストからダイヤと資材を取り出します' : '拠点のチェストから武器・道具・防具・食料を取り出します'
    const stacks = stacksNow()
    const banked = name => stacks.filter(stack => stack.name === name).reduce((sum, stack) => sum + stack.count, 0)
    const spare = banked(DIAMOND), precious = stacks.filter(stack => PRECIOUS.test(stack.name)).reduce((sum, stack) => sum + stack.count, 0)
    const base = shared.playerBase
    const covered = underCover(getBlock, position)
    // With no base to go to and no wood for its chest, the trip only climbs out
    // of the tunnel: on the surface the wood is gathered before going down
    // again (player-supply.js), and the base is made once it is held (live
    // 2026-11-17 01:57-02:03 JST: 145 diamonds, no wood, the trip never began).
    if ((!base || flat(base, position) > FAR_M) && !canBuild()) return spare >= BANK_AT && covered ? '大事な物が増えたため、地上へ出ます（拠点を作る木がありません）' : null
    if (spare >= DEEP_DIAMONDS || precious - spare >= DEEP_VALUABLES) return `大事な物が増えたため、拠点のチェストに預けます（ダイヤ ${spare} 個・ほかの貴重品 ${precious - spare} 個）`
    return !!base && flat(base, position) <= NEAR_M && !covered && (precious > 0 || stacks.length >= NEAR_STACKS) ? `拠点の近くにいるため、手元に残す物以外を預けます（${stacks.length} 枠）` : null
  }
  // What a new chest is made of, as the number of chests the held material
  // makes (a chest held, eight planks, two logs): a held goal is looked at
  // again when this grows. Nothing of the place the Bot stands at is in it, and
  // planks used for something else are not a reason to go back.
  // Real Realm 2026-11-18 16:20-16:25 JST: this was the plank and log counts
  // and canBuild(), and canBuild() (storage.canMakeChest) reads the chests
  // near the feet. Held for wood with 8 planks, the goal woke as
  // SUPPLIES_CHANGED each time the Bot walked off from the base chests and
  // back, went to the base, and was held again (three trips in eight minutes).
  const supplies = () => { const items = getInventory()?.items; if (!items) return null; const held = pattern => items.filter(item => pattern.test(item?.name ?? '') && item.count > 0).reduce((sum, item) => sum + item.count, 0); return held(/^minecraft:chest$/) + Math.floor((held(/_planks$/) + 4 * held(/_(?:log|stem|wood|hyphae)$/)) / 8) }

  // The trip itself: one goal kept through failures and interruptions (return/return-runner.js).
  const runner = createReturnRunner({
    getMode, shared, agent: { objective: agent?.objective, start: options => agent.start(options), stop: reason => agent.stop(reason), running: () => agent.running ? agent.running() : true }, settled: () => agent?.settled?.() !== false,
    policy: { due: () => dueReason() !== null, reason: () => dueReason() ?? '拠点へ預けます', cargo: stacksNow, restockWanted, lacking, restock: takeable, canBuild, record, supplies },
    ports: { getBlock, getPosition, getFeet, getInventory, dimension, moves: { climb, water, house, travel, approach, porchWalk, door, walk, build }, chests: { hands, spares, all: around, tried: noteTried, porch, pending: pendingChest, make: options => chest(options), near: () => { const feet = getFeet(); return feet ? chestsNear(getBlock, feet, undefined, { shut: true }).map(found => found.position) : [] } } },
    scope, interrupter: interrupter ?? (() => blocked() ? 'ほかの作業' : null), hostile, travelBusy: () => travel?.status()?.busy === true,
    file: returnFile, write, disposed, log, now, sleep
  })

  return { tick: runner.tick, cancel: runner.cancel, status: runner.status }
}

module.exports = { createPlayerBase, bankable, standBeside, baseFile, loadBaseSync, KEEP, BANK_AT }
