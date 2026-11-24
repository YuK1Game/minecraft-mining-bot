'use strict'

const { hasWorkingPick, home } = require('./dragon-supply-kit')
const { pinned } = require('./dragon-gather-pin')
const { bedOf, chestOf, setSpawn } = require('./house/house-spawn')
const { approachHome } = require('./dragon-early-home')
const { provisionFood } = require('./dragon-early-food')
const { houseDuty } = require('./house/house-repair')
const { homeTarget, homeUse, same } = require('./dragon-home-use')
const { failed } = require('./return/return-result')
const { diamondNeed, prepareDiamonds } = require('./dragon-diamond')
const homeIron = require('./dragon-home-iron')

// The starter jobs build the house and tools. Before mining for diamonds,
// establish the respawn point and physically stock the first recovery kit.
// The house is the starter jobs' while it is being built or repaired (house/house-repair.js `houseDuty`); a
// damaged house whose repair is held is not: each step then asks for the one thing it needs, from that thing's
// received blocks (dragon-home-use.js), and goes on when it stands.
function earlyObjective ({ inventory, worn, house, memory = {} }) {
  const step = (id, label, legacy = false, ready = false) => ({ id, label, next: label, legacy, ready })
  if (inventory?.known !== true || inventory.uncertain || !Array.isArray(inventory.items)) return step('observe', '持ち物の受信を待ちます。')
  const held = inventory.items.filter(item => item?.count > 0)
  const duty = house?.origin ? houseDuty(house) : 'build'
  const activeMine = !duty && memory.early?.spawnReady === true && !!memory.early?.mine?.branch?.request
  if (!activeMine && !hasWorkingPick(held, 'wooden')) return step('wood', '原木から最初の道具を作ります。', true)
  if (duty) return step('base', duty === 'repair' ? '壊れた本拠点を直します。' : 'ベッドとラージチェストのある本拠点を作ります。', true)
  if (!activeMine && !hasWorkingPick(held, 'stone')) return step('stone', '鉄鉱石を採れる石以上のツルハシを用意します。', true)
  if (!memory.early?.spawnReady) return step('home_spawn', '本拠点へ戻り、復帰ベッドを確認します。')
  if (!memory.early.reserveReady) return step('home_reserve', '本拠点のラージチェストに再出発用の装備を揃えます。')
  if (!diamondNeed(inventory, worn).done) return step('diamond', '計画した下層坑道の採掘とクラフトでダイヤ装備を揃えます。')
  if (!memory.early.outfitted) return step('nether_kit', 'ネザー偵察用の装備と食料を揃えます。')
  return step('early_ready', '予備装備を本拠点に残し、ネザーの入口を準備します。', false, true)
}

// One reading of the objective for everyone who asks: who has the player (dragon-runtime.js `legacyNeeded`), what
// the goal is called (`keyNow`) and the step below. It is read from the inventory the steps work with
// (`runtime.inventory()`: the received rows with the tools' received durability), not from the host's bare rows.
// Until 2026-11-20 the owner and the goal read the bare rows, where a worn-out pickaxe is still a pickaxe, and the
// step read the other: the owner kept the player for `home_reserve`, the step answered "the starter jobs make the
// first tools" and did nothing, and the starter jobs never got the player.
// Live 2026-11-20 02:21-02:32 JST: the stone pickaxe reached 0 of 131 while digging a way down; for eleven minutes
// the Bot stood at y 54 under 「原木から最初の道具を作ります。」 with no move, no dig and the starter jobs not started.
const objectiveNow = ({ runtime, shared, memory }) => earlyObjective({ inventory: shared.inventoryUncertain ? null : runtime.inventory(),
  worn: runtime.armor?.(), house: shared.playerHouse, memory })

const distanceToBed = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const playerSpawn = receipt => !!receipt?.position && [0, 'player'].includes(receipt.type)
const atHomeBed = (receipt, bed) => playerSpawn(receipt) && [0, 'overworld'].includes(receipt.dimension) && distanceToBed(bed, receipt.position) <= 3
const scoutArmor = worn => ['helmet', 'chestplate', 'leggings'].every(piece =>
  worn.some(item => item.name === 'minecraft:diamond_' + piece || item.name === 'minecraft:netherite_' + piece)) && worn.some(item => item.name === 'minecraft:golden_boots')

async function runDragonEarly (ctx) {
  const { shared, memory, runtime, supplies, cancelled } = ctx
  const state = memory.early ??= {}
  const result = reason => ({ done: false, reason })
  const next = objectiveNow({ runtime, shared, memory })
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
      // Received as gone: the respawn point is no longer this bed, and the bed alone is asked for (not the whole house).
      const use = homeUse(ctx, 'bed')
      shared.playerHouse = { ...shared.playerHouse, spawn: false }
      return use.ok ? result('本拠点のベッドの受信を待ちます。') : { ...result(use.reason), result: use.result }
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
    const batching = homeIron.enabled(ctx)
    if (batching && state.reserveIron) {
      const iron = await supplies.prepareHomeIron(state.reserveIron)
      if (iron.done && !cancelled()) delete state.reserveIron
      return { ...iron, done: false }
    }
    if (state.gather && (!pinned(state.gather, home) || batching && homeIron.usesIron(state.gather.name) && !state.gather.homeEquipment)) delete state.gather
    if (state.gather) {
      const item = batching && state.gather.homeEquipment
        ? await supplies.acquire(state.gather.name, state.gather.count, { atHome: true })
        : await acquire(state.gather.name, state.gather.count)
      if ((item.done || item.replanIron) && !cancelled()) delete state.gather
      // The step's own outcome (return-result.js) goes up with the text.
      return item.result ? { ...result(item.reason), result: item.result } : result(item.reason)
    }
    // One of the house's two large chests, the one used before first (the kit is not split over both); the other
    // one while the first is broken or was not read three times.
    const unread = at => ({ stage: 'reserve', target: [at.x, at.y, at.z].join(','), code: 'CHEST_NOT_READ' })
    const choice = { prefer: state.reserveAt ?? null, spent: at => ctx.goal?.spent?.(unread(at)) === true }
    const chest = homeTarget(ctx, 'chest', choice).at
    if (!await approachHome(ctx, chest)) return result('本拠点の予備装備チェストへ戻っています。')
    const use = homeUse(ctx, 'chest', choice)
    if (!use.ok) return { ...result(use.reason), result: use.result }
    if (!same(use.at, chest)) return result('本拠点の使えるラージチェストへ移ります。')
    if (use.alternative && !same(state.reserveAt, use.at)) ctx.log?.(`プレイヤーモード: 本拠点のラージチェストのうち、使えるほう (${use.at.x}, ${use.at.y}, ${use.at.z}) に予備装備を置きます`)
    if (!cancelled()) state.reserveAt = { ...use.at }
    const stock = await supplies.reserve(chest, { mode: 'stock', kit: 'home' })
    // The chest stands and its 54 slots did not come: one failure of this chest, for the goal's ledger.
    if (stock.unread && !cancelled()) {
      const noted = ctx.goal?.fail?.(unread(chest), { paceMs: 20000 })
      if (noted?.exhausted) ctx.log?.(`プレイヤーモード: 本拠点のラージチェスト (${chest.x}, ${chest.y}, ${chest.z}) の54枠を ${noted.count} 回とも受信できなかったため、このチェストは使いません（${stock.unread}）`)
      return { ...result(stock.reason), result: failed('CHEST_NOT_READ', { detail: stock.unread }) }
    }
    if (!cancelled()) {
      if (stock.done) state.reserveReady = true
      else if (batching && stock.ironTarget > 0) state.reserveIron = { target: stock.ironTarget }
      else if (stock.missing) state.gather = { ...stock.missing, since: Date.now(), ...(batching && homeIron.usesIron(stock.missing.name) ? { homeEquipment: true } : {}) }
    }
    return result(stock.reason)
  }
  if (next.id === 'diamond') return prepareDiamonds(ctx)
  shared.dragonGoldBoots = true
  const worn = runtime.armor()
  const equipped = worn?.known === true ? worn.worn ?? [] : []
  const kit = await supplies.prepare('nether', { signal: ctx.signal })
  if (!kit.done || cancelled()) return result(kit.reason)
  if (!scoutArmor(equipped)) {
    await ctx.operations.armor.equipBest()
    return result('金のブーツと残り3部位のダイヤ以上の防具を装着します。')
  }
  if (!await approachHome(ctx, state.reserveAt ?? chestOf(origin))) return result('ネザー偵察の出発点になる本拠点へ戻っています。')
  if (playerSpawn(shared.lastSpawnSet) && !atHomeBed(shared.lastSpawnSet, bedOf(origin))) {
    state.spawnReady = false
    return result('遠征中に変更された復帰地点を本拠点に戻します。')
  }
  if (!cancelled()) state.outfitted = true
  return { done: !cancelled(), reason: '本拠点に予備を残し、ネザー偵察用の装備を確認しました。' }
}

module.exports = { earlyObjective, objectiveNow, runDragonEarly }
