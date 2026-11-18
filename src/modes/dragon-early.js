'use strict'

const { GEAR } = require('../survival/diamond-gear')
const { hasWorkingPick } = require('./dragon-supply-kit')
const { bedOf, chestOf, setSpawn } = require('./house/house-spawn')
const { approachHome } = require('./dragon-early-home')
const { provisionFood } = require('./dragon-early-food')

// The starter jobs build the house and tools. Before mining for diamonds,
// establish the respawn point and physically stock the first recovery kit.
function earlyObjective ({ inventory, worn, house, memory = {} }) {
  const step = (id, label, legacy = false, ready = false) => ({ id, label, next: label, legacy, ready })
  if (inventory?.known !== true || inventory.uncertain || !Array.isArray(inventory.items)) return step('observe', '持ち物の受信を待ちます。')
  const held = inventory.items.filter(item => item?.count > 0 && item.durabilityRemaining !== 0)
  if (!held.some(item => /_pickaxe$/.test(item.name))) return step('wood', '原木から最初の道具を作ります。', true)
  if (!house?.done || !house.origin) return step('base', 'ベッドとラージチェストのある本拠点を作ります。', true)
  if (!hasWorkingPick(held, 'stone')) return step('stone', '鉄鉱石を採れる石以上のツルハシを用意します。', true)
  if (!memory.early?.spawnReady) return step('home_spawn', '本拠点へ戻り、復帰ベッドを確認します。')
  if (!memory.early.reserveReady) return step('home_reserve', '本拠点のラージチェストに再出発用の装備を揃えます。')
  const equipped = worn?.known === true ? (worn.worn ?? []).filter(item => item?.name) : []
  const owned = new Set([...held, ...equipped].map(item => item.name?.replace(/^minecraft:(diamond|netherite)_/, '')))
  if (!GEAR.every(piece => owned.has(piece.output.slice(8)))) return step('diamond', '採掘とクラフトでダイヤ装備を揃えます。', true)
  if (!memory.early.outfitted) return step('nether_kit', 'ネザー偵察用の装備と食料を揃えます。')
  return step('early_ready', '予備装備を本拠点に残し、ネザーの入口を準備します。', false, true)
}

const distanceToBed = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const playerSpawn = receipt => !!receipt?.position && [0, 'player'].includes(receipt.type)
const atHomeBed = (receipt, bed) => playerSpawn(receipt) && [0, 'overworld'].includes(receipt.dimension) && distanceToBed(bed, receipt.position) <= 3
const scoutArmor = worn => ['helmet', 'chestplate', 'leggings'].every(piece =>
  worn.some(item => item.name === 'minecraft:diamond_' + piece || item.name === 'minecraft:netherite_' + piece)) && worn.some(item => item.name === 'minecraft:golden_boots')

async function runDragonEarly (ctx) {
  const { shared, memory, runtime, supplies, cancelled } = ctx
  const state = memory.early ??= {}
  const inventory = runtime.inventory()
  const result = reason => ({ done: false, reason })
  const next = earlyObjective({ inventory, worn: runtime.armor(), house: shared.playerHouse, memory })
  if (cancelled() || next.legacy || next.id === 'observe') return result(next.label)
  if (next.ready) return { done: true, reason: next.label }
  const origin = shared.playerHouse.origin
  const acquire = (name, count) => name === 'food' ? provisionFood(ctx, count) : supplies.acquire(name, count)
  if (next.id === 'home_spawn') {
    const bed = bedOf(origin)
    if (!await approachHome(ctx, bed)) return result('本拠点のベッドへ戻っています。')
    const block = ctx.getBlock(bed.x, bed.y, bed.z)
    if (block?.known !== true) return result('本拠点のベッドの受信を待ちます。')
    if (!/bed$/.test(block.name)) {
      shared.playerHouse = { ...shared.playerHouse, done: false, spawn: false }
      return result('ベッドを失ったため、本拠点の建築を再開します。')
    }
    const last = shared.lastSpawnSet
    if (shared.playerHouse.spawn && atHomeBed(last, bed)) {
      state.spawnReady = true
      return result('本拠点のベッドと設定済みの復帰地点を確認しました。')
    }
    const interactions = ctx.operations.interactions
    const ok = await setSpawn({ origin, shared, getBlock: ctx.getBlock, getFeet: ctx.getFeet, walk: ctx.hands.walk,
      useBed: position => interactions.useBed(position), wakeBed: position => interactions.wakeBed(position),
      previewUse: position => interactions.previewUseBed(position), log: ctx.log })
    const update = shared.lastSpawnSet
    const confirmed = ok && atHomeBed(update, bed)
    if (confirmed && !cancelled()) state.spawnReady = true
    return result(confirmed ? '本拠点の復帰地点を受信しました。' : '復帰地点の設定通知を待っています。')
  }
  if (next.id === 'home_reserve') {
    if (state.gather) {
      const item = await acquire(state.gather.name, state.gather.count)
      if (item.done && !cancelled()) delete state.gather
      return result(item.reason)
    }
    const chest = chestOf(origin)
    if (!await approachHome(ctx, chest)) return result('本拠点の予備装備チェストへ戻っています。')
    const stock = await supplies.reserve(chest, { mode: 'stock', kit: 'home' })
    if (!cancelled()) {
      if (stock.done) state.reserveReady = true
      else if (stock.missing) state.gather = { ...stock.missing }
    }
    return result(stock.reason)
  }
  shared.dragonGoldBoots = true
  const worn = runtime.armor()
  const equipped = worn?.known === true ? worn.worn ?? [] : []
  const kit = await supplies.prepare('nether', { signal: ctx.signal })
  if (!kit.done || cancelled()) return result(kit.reason)
  if (!scoutArmor(equipped)) {
    await ctx.operations.armor.equipBest()
    return result('金のブーツと残り3部位のダイヤ以上の防具を装着します。')
  }
  if (!await approachHome(ctx, chestOf(origin))) return result('ネザー偵察の出発点になる本拠点へ戻っています。')
  if (playerSpawn(shared.lastSpawnSet) && !atHomeBed(shared.lastSpawnSet, bedOf(origin))) {
    state.spawnReady = false
    return result('遠征中に変更された復帰地点を本拠点に戻します。')
  }
  if (!cancelled()) state.outfitted = true
  return { done: !cancelled(), reason: '本拠点に予備を残し、ネザー偵察用の装備を確認しました。' }
}

module.exports = { earlyObjective, runDragonEarly }
