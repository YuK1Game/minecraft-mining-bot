'use strict'

const { low } = require('./low-block')

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
const fs = require('node:fs')
const path = require('node:path')
const { writeDurableJson } = require('../common/durable-json')
const { normalizeMode } = require('./bot-mode')
const { storable } = require('./player-storage-rubble')
const { underCover } = require('./player-surface')
const { bankableAll } = require('./player-base-kit')

const CHEST = 'minecraft:chest'
const DIAMOND = 'minecraft:diamond'
const KEEP = 8, BANK_AT = 16, NEAR_M = 96, DEEP_DIAMONDS = 8, DEEP_VALUABLES = 32, NEAR_STACKS = 4, FAR_M = 1024, AGAIN_MS = 600000, TRAVEL_MS = 300000
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
const diamonds = inventory => slotItems(inventory).filter(item => item.name === DIAMOND).reduce((sum, item) => sum + item.count, 0)

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

// A cell to stand in beside the chest: received solid ground and two received open cells.
function standBeside (getBlock, chest) { return standsBeside(getBlock, chest)[0] ?? null }
function standsBeside (getBlock, chest) {
  const out = []
  const open = (x, y, z) => { const found = getBlock(x, y, z); return found?.known === true && found.boundingBox !== 'block' && !/water|lava/.test(found.name ?? '') }
  // Not on a chest (the other half of the large chest) or another low block (modes/low-block.js).
  const solid = (x, y, z) => { const found = getBlock(x, y, z); return found?.known === true && found.boundingBox === 'block' && !low(found) }
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
    for (const dy of [0, -1, 1]) {
      const x = chest.x + dx, y = chest.y + dy, z = chest.z + dz
      if (solid(x, y - 1, z) && open(x, y, z) && open(x, y + 1, z)) { out.push({ x: x + 0.5, y, z: z + 0.5 }); break }
    }
  }
  return out
}

function createPlayerBase ({ getMode, shared, agent, hands, chest, canBuild = () => true, door = async () => true, climb, travel, walk, approach, getBlock, getPosition, getFeet, getInventory, getWorn = () => null, file = null, write = writeDurableJson, blocked = () => false, hostile = () => false, disposed = () => false, log = () => {}, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  let busy = false, waitUntil = 0, banked = 0
  const live = () => !disposed() && normalizeMode(getMode()) === 'player' && shared.playerWanted === true
  const say = text => log(`プレイヤーモード: ${text}`)
  const restart = async () => { for (let attempt = 0; attempt < 5 && live(); attempt++) { try { await agent.start({ ...agent.objective }); return true } catch { await sleep(2000) } } return false }
  const settle = async () => { for (let i = 0; i < 40 && agent.settled?.() === false && !disposed(); i++) await sleep(200) }
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
  const stacksNow = () => bankableAll(getInventory(), { worn: getWorn() })
  function due () {
    const inventory = getInventory(), position = getPosition()
    if (!inventory || !position) return false
    const stacks = stacksNow()
    const banked = name => stacks.filter(stack => stack.name === name).reduce((sum, stack) => sum + stack.count, 0)
    const spare = banked(DIAMOND), precious = stacks.filter(stack => PRECIOUS.test(stack.name)).reduce((sum, stack) => sum + stack.count, 0)
    const base = shared.playerBase
    const covered = underCover(getBlock, position)
    // With no base to go to and no wood for its chest, the trip only climbs out
    // of the tunnel: on the surface the wood is gathered before going down
    // again (player-supply.js), and the base is made once it is held (live
    // 2026-11-17 01:57-02:03 JST: 145 diamonds, no wood, the trip never began).
    if ((!base || flat(base, position) > FAR_M) && !canBuild()) return spare >= BANK_AT && covered
    if (spare >= DEEP_DIAMONDS || precious - spare >= DEEP_VALUABLES) return true
    return !!base && flat(base, position) <= NEAR_M && !covered && (precious > 0 || stacks.length >= NEAR_STACKS)
  }

  async function trip () {
    const aborted = () => !live() || blocked()
    if (underCover(getBlock, getPosition())) {
      say('大事な物が増えたため、地上へ出て拠点のチェストに預けます。')
      let out = null
      try { out = await climb(aborted) } catch (error) { out = { ok: false, reason: String(error?.message ?? error).slice(0, 80) } }
      if (aborted()) return false
      if (underCover(getBlock, getPosition())) { say(`地上へ出られないため、拠点へ預けに行けません（${out?.reason ?? '不明'}）`); return false }
    }
    let base = shared.playerBase
    if (base && flat(base, getPosition()) > FAR_M) { say(`拠点 (${base.x}, ${base.z}) が ${FAR_M}m より遠いため、ここに新しい拠点を作ります`); base = null }
    if (base) {
      if (flat(base, getPosition()) > 20) {
        say(`拠点 (${base.x}, ${base.y}, ${base.z}) へ移動しています。`)
        try { await travel.to({ destination: { x: base.x, z: base.z } }) } catch (error) { say(`拠点へ移動を始められません ${String(error?.message ?? error).slice(0, 80)}`); return false }
        const until = now() + TRAVEL_MS
        while (!aborted() && now() < until && travel.status()?.busy) await sleep(1000)
        if (travel.status()?.busy) { try { await travel.cancel() } catch {} }
        if (aborted()) return false
      }
      if (flat(base, getPosition()) > 6) await approach(base, 6)
      // Any received stand beside the chest that a walk reaches (inside the house the nearest may be walled off).
      // Into the starter house: its door opened first (house/house-door.js).
      try { await door() } catch {}
      for (const stand of standsBeside(getBlock, base).slice(0, 4)) { if (aborted() || flat(stand, getFeet()) <= 0.45) break; if (await walk(stand)) break }
      if (aborted()) return false
      if (flat(base, getPosition()) > 4) { say(`拠点のチェストのそばまで行けません（残り ${Math.round(flat(base, getPosition()))}m）`); return false }
      // A chest that is gone (received as something else) is made again here.
      if (getBlock(base.x, base.y, base.z)?.known === true && !isChest(base)) { say('拠点のチェストがなくなっていたため、作り直します'); base = null }
    }
    if (!base && !canBuild()) { say('拠点のチェストを作る木がないため、地上で木を集めてから拠点を作ります'); return false }
    if (!base) {
      const at = await chest()
      if (!at) { say('拠点のチェストを置けません'); return false }
      base = await record(at)
    }
    const stacks = stacksNow()
    const total = stacks.reduce((sum, stack) => sum + stack.count, 0)
    let moved = await hands.store(base, stacks)
    // A full base chest: a new large chest beside it takes the rest.
    if (moved < total && hands.room(base) === 0) {
      const extra = await chest()
      if (extra) moved += await hands.store(extra, stacksNow())
    }
    banked += moved
    say(`拠点のチェスト (${base.x}, ${base.y}, ${base.z}) に ${moved} 個預けました（手元のダイヤ ${diamonds(getInventory())} 個）`)
    return moved > 0
  }

  async function tick () {
    if (!live() || busy || blocked() || hostile() || travel.status()?.busy || now() < waitUntil || !due()) return null
    busy = true
    let ok = false
    try {
      agent.stop('拠点へ資材を預けに行きます。')
      await settle()
      ok = await trip()
      return ok
    } catch (error) {
      say(`拠点へ預けられません ${String(error?.message ?? error).slice(0, 120)}`)
      return false
    } finally {
      waitUntil = now() + (ok ? 30000 : AGAIN_MS)
      busy = false
      await restart()
    }
  }

  return { tick, status: () => ({ active: busy, reason: busy ? '拠点へ資材を預けに行きます。' : null, banked, base: shared.playerBase ?? null }) }
}

module.exports = { createPlayerBase, bankable, standBeside, baseFile, loadBaseSync, KEEP, BANK_AT }
