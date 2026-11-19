'use strict'

const { walkableCells, collectable } = require('./player-drops')
const { cellKey } = require('../movement/plan-cache')
const { chestOf } = require('./house/house-spawn')
const { approachHome } = require('./dragon-early-home')
const { provisionFood } = require('./dragon-early-food')
const { navigate } = require('./dragon-stronghold-navigation')

const working = reason => ({ done: false, reason })
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const near = (p, q, range) => p && q && dist(p, q) <= range
const hazards = /lava|fire|magma|cactus|campfire|wither_rose|powder_snow|sweet_berry|portal/
const HAZARD_CAUSE = /outOfWorld|out_of_world|fell\.out|lava|void/i
const itemCount = (state, name) => (state.inventory?.items ?? []).filter(i => i.name === name).reduce((sum, i) => sum + i.count, 0)

// Opportunistic local pickup. Walking the already planned expedition route
// may bring the Bot back near the drops; this never opens a portal or sends a
// fresh loadout to explore an unknown death site.
async function recoverLoot (ctx, record) {
  const loot = record.lootRecovery
  const s = ctx.runtime.raw()
  const abandon = () => { record.lootRecovery = null; return { done: true } }
  if (!loot || !loot.position || loot.repeated || HAZARD_CAUSE.test(loot.cause ?? '') || !Number.isFinite(loot.at) || Date.now() - loot.at > 5 * 60000) return abandon()
  if (s.dimension !== loot.dimension || !near(s.position, loot.position, 16)) return { done: true }
  if (s.health < 16 || ctx.cancelled()) return { done: true }
  const actors = ctx.runtime.host().entities.snapshot({ kind: 'all' })
  const relevant = actors.filter(a => a.dimension === s.dimension && a.alive !== false)
  if (relevant.some(a => (a.hostile || ['minecraft:area_effect_cloud', 'minecraft:dragon_fireball'].includes(a.entityType)) && (!a.positionKnown || near(a.position, s.position, 12) || near(a.position, loot.position, 12))) ||
      relevant.some(a => a.kind === 'player' && near(a.position, loot.position, 8))) return abandon()
  if (loot.pending) {
    const confirmed = itemCount(s, loot.pending.name) > loot.pending.before
    if (!confirmed && Date.now() - loot.pending.at < 1600) return working('拾った品が持ち物に反映されるのを待っています。')
    loot.pending = null
    if (confirmed) return working('死亡地点のドロップが持ち物に戻ったことを確認しました。')
  }
  if ((loot.tried?.length ?? 0) >= 3) return abandon()
  const candidates = relevant.filter(a => a.kind === 'item' && a.positionKnown === true && a.name && a.uniqueId != null &&
    a.count > 0 && near(a.position, loot.position, 5) && !loot.tried?.includes(String(a.uniqueId)))
  if (!candidates.length) return abandon()
  const dryBlock = (x, y, z) => {
    const block = ctx.getBlock(x, y, z)
    return block?.extra?.length || hazards.test(block?.name ?? '') ? null : block
  }
  const cells = walkableCells(s.position, dryBlock)
  for (const drop of candidates.sort((a, b) => dist(a.position, s.position) - dist(b.position, s.position))) {
    const { x, y, z } = drop.position
    const cell = ctx.getBlock(Math.floor(x), Math.floor(y), Math.floor(z))
    if (!cell?.known || hazards.test(cell.name) || cell.extra?.length || !collectable(drop, cells)) continue
    const stands = [...cells.values()].filter(p => near({ x: p.x + 0.5, y: p.y + 0.5, z: p.z + 0.5 }, drop.position, 1.5) && collectable(drop, new Map([[cellKey(p.x, p.y, p.z), p]])))
    if (!stands.length) continue
    stands.sort((a, b) => dist(a, s.position) - dist(b, s.position))
    const stand = stands[0]
    loot.tried ??= []
    loot.tried.push(String(drop.uniqueId))
    loot.pending = { name: drop.name, before: itemCount(s, drop.name), at: Date.now() }
    await ctx.hands.walk({ x: stand.x + 0.5, y: stand.y, z: stand.z + 0.5 })
    return working('安全な足場からドロップを回収し、持ち物を再確認します。')
  }
  return abandon()
}

async function recoverDragon (ctx, record) {
  const recovery = record.recovery
  if (!recovery) return record.lootRecovery ? recoverLoot(ctx, record) : { done: true }
  const state = ctx.runtime.raw()
  if (ctx.cancelled() || state.dead || state.spawnPending || state.inventory?.known !== true || state.inventory.uncertain) return working('復帰後の位置と持ち物の受信を待っています。')
  if (!recovery.lootChecked) {
    if (!recovery.repeated && recovery.position && !HAZARD_CAUSE.test(recovery.cause ?? '')) record.lootRecovery = { position: recovery.position, dimension: recovery.dimension, at: recovery.at, cause: recovery.cause }
    recovery.lootChecked = true
  }
  if (record.lootRecovery && state.dimension === recovery.dimension) {
    const loot = await recoverLoot(ctx, record)
    if (!loot.done) return loot
  }
  // If a non-Overworld respawn anchor exists, let the owning stage navigate
  // that dimension. The outstanding reserve withdrawal survives until home.
  if (state.dimension !== 'overworld') return { done: true }
  const outpost = record.stronghold.outpostChest
  const useOutpost = outpost && record.stage === 'end'
  const home = ctx.shared.playerHouse?.origin
  const chest = useOutpost ? outpost : record.early.reserveReady && (home ? record.early.reserveAt ?? chestOf(home) : ctx.shared.playerBase)
  if (!chest) {
    record.recovery = null
    return { done: true }
  }
  if (recovery.gather) {
    const { name, count } = recovery.gather
    const result = name === 'food' ? await provisionFood(ctx, count) : await ctx.supplies.acquire(name, count)
    if (result.done && !ctx.cancelled()) delete recovery.gather
    return working(result.reason)
  }
  if (!near(ctx.getFeet(), chest, 5)) {
    if (useOutpost) {
      const goal = record.stronghold.surface ?? chest
      if (Math.hypot(ctx.getFeet().x - chest.x, ctx.getFeet().z - chest.z) > 40) await ctx.travelTo({ destination: { x: goal.x, z: goal.z } }, { aborted: ctx.cancelled })
      else await navigate(ctx, record.stronghold, chest)
    } else if (home) await approachHome(ctx, chest)
    else if (near(ctx.getFeet(), chest, 20)) await ctx.hands.approach(chest, 3)
    else return working('復帰地点から出撃所までの安全な経路を確認しています。')
    return working('記録した予備装備チェストへ戻っています。')
  }
  const options = { mode: 'recover', kit: useOutpost ? 'end' : 'home', keepReserve: recovery.repeated === true, signal: ctx.signal, aborted: ctx.cancelled }
  const kit = await ctx.supplies.reserve(chest, options)
  if (!kit.done || ctx.cancelled()) {
    if (kit.missing?.name && Number.isFinite(kit.missing.count)) recovery.gather = { name: kit.missing.name, count: kit.missing.count }
    return working(kit.reason)
  }
  if (!useOutpost && record.stage === 'early') {
    record.early.reserveReady = false
    record.early.outfitted = false
    delete record.early.gather
  }
  record.recovery = null
  return working('復帰装備を持ち物で確認しました。保存した遠征を再開します。')
}

module.exports = { recoverDragon }
