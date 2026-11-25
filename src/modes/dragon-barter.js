'use strict'

// Piglin bartering in the Nether for ender pearls (plus useful bonus drops like
// fire resistance potions and obsidian). In a permanently daylight Realm,
// surface night Endermen never spawn; bartering gold ingots with peaceful adult
// Piglins while wearing golden boots avoids cave-hunting RNG and combat risk.
// Every pearl count and gold drop is verified strictly from server receipts.
const { cell, center, distance, held, live, pending } = require('./dragon-nether-portal')
const { nearby, recordStep, retrieve, survey, reachable } = require('./dragon-nether-route')
const { isSupportedFood } = require('../actions/food')

const PEARL_TARGET = 20
const GOLD_PER_PEARL_BATCH = 4
const MIN_GOLD_BATCH = 16
const MAX_GOLD_BATCH = 48
const PIGLIN_COOLDOWN_MS = 7500
const BARTER_WAIT_AFTER_DROP_MS = 9000
const MAX_SURVEY_STEPS = 24
const BARTER_RANGE = 4.2
const BARTER_LOOT_PRIORITY = [
  'minecraft:ender_pearl',
  'minecraft:potion',
  'minecraft:obsidian',
  'minecraft:arrow',
  'minecraft:string',
  'minecraft:iron_nugget',
  'minecraft:fire_charge'
]
const BARTER_LOOT_RANK = new Map(BARTER_LOOT_PRIORITY.map((name, idx) => [name, idx]))
const DANGEROUS_NEARBY = /wither_skeleton|piglin_brute/

const count = (ctx, name) => held(ctx, 'minecraft:' + name)
const pearlProgress = ctx => count(ctx, 'ender_pearl') + count(ctx, 'ender_eye')
const safetyFood = ctx => (ctx.runtime.inventory()?.items ?? []).reduce((sum, i) => sum + (isSupportedFood(i.name, ctx.runtime.raw()) ? i.count : 0), 0)
const wearingGoldBoots = ctx => ctx.runtime.armor?.()?.worn?.some(piece => piece?.name === 'minecraft:golden_boots') === true

function barterGoldGoal (missingPearls) {
  const missing = Math.max(1, Number.isSafeInteger(missingPearls) ? missingPearls : PEARL_TARGET)
  return Math.min(MAX_GOLD_BATCH, Math.max(MIN_GOLD_BATCH, missing * GOLD_PER_PEARL_BATCH))
}

function isBarterablePiglin (actor, enemies = []) {
  if (!actor || actor.entityType !== 'minecraft:piglin') return false
  if (actor.dimension !== 'nether' || actor.alive === false || actor.positionKnown !== true || !actor.position) return false
  if (actor.baby === true || actor.isBaby === true || actor.animalMeta?.baby === true) return false
  if (actor.hostile === true) return false
  // Skip Piglins standing right next to a Piglin Brute or Wither Skeleton.
  for (const other of enemies) {
    if (!other?.position || other.runtimeId === actor.runtimeId) continue
    if (DANGEROUS_NEARBY.test(other.entityType ?? '') && distance(actor.position, other.position) < 8) return false
  }
  return true
}

function barterDrops (actors) {
  return actors
    .filter(a => a.kind === 'item' && BARTER_LOOT_RANK.has(a.name))
    .sort((a, b) => (BARTER_LOOT_RANK.get(a.name) ?? 99) - (BARTER_LOOT_RANK.get(b.name) ?? 99))
}

async function lookAtActor (ctx, target) {
  const input = ctx.runtime.dragonItems?.input?.()
  if (!input || typeof input.stats !== 'function' || typeof input.lookAt !== 'function') return
  if (input.stats().target) return
  const started = !input.stats().running
  input.lookAt({ x: target.position.x, y: target.position.y + 1.4, z: target.position.z })
  if (started) input.start()
  try {
    await new Promise(resolve => setTimeout(resolve, 120))
  } finally {
    if (started && !ctx.cancelled?.()) input.stop()
  }
}

async function stepBarter (ctx, n, { pearlTarget = PEARL_TARGET, now = Date.now } = {}) {
  const at = cell(ctx.getFeet())
  const actors = nearby(ctx, 40)
  const enemies = actors.filter(a => a.kind !== 'item')
  const drops = barterDrops(actors)

  if (pearlProgress(ctx) >= pearlTarget) {
    n.returning = 'barter'
    return pending('ピグリン交易で必要なエンダーパールを確認したため地上へ戻ります')
  }
  if (ctx.runtime.raw().health <= 12 || safetyFood(ctx) < 8 ||
      enemies.some(a => DANGEROUS_NEARBY.test(a.entityType ?? '') && a.distance < 5)) {
    n.returning = 'supplies'
    return pending('体力・補給・危険な敵の接近から退路へ戻ります')
  }
  if (!wearingGoldBoots(ctx)) {
    if (count(ctx, 'golden_boots') > 0 && typeof ctx.operations?.armor?.equipBest === 'function') {
      ctx.shared.dragonGoldBoots = true
      await ctx.operations.armor.equipBest()
      return pending('ピグリン交易のため金のブーツの装着を確認しています')
    }
    n.returning = 'supplies'
    return pending('金のブーツを装備していないため、安全のため地上へ戻ります')
  }

  // Always collect confirmed barter drops (pearls & potions first) before dropping more gold.
  const loot = await retrieve(ctx, n, drops)
  if (loot) return loot

  const goldSlot = (ctx.runtime.inventory()?.items ?? []).find(item => item?.name === 'minecraft:gold_ingot' && item.count > 0 && Number.isInteger(item.slot))
  const currentTime = now()
  const waitingLastBarter = Number.isFinite(n.lastBarterDropAt) && currentTime - n.lastBarterDropAt < BARTER_WAIT_AFTER_DROP_MS
  if (!goldSlot) {
    if (waitingLastBarter) return pending('最後に渡した金インゴットの交易結果がドロップするのを待っています')
    n.returning = 'barter'
    return pending('交易用の金インゴットを使い切ったため地上へ戻って確認・補充します')
  }

  if (typeof ctx.drop !== 'function') {
    n.barterExhausted = true
    n.returning = 'barter_none'
    return pending('アイテム受け渡し操作を利用できないため現世の収集方法へ切り替えます')
  }

  const piglins = enemies
    .filter(a => isBarterablePiglin(a, enemies))
    .sort((a, b) => a.distance - b.distance)

  if (piglins.length > 0) {
    n.piglinSite = cell(piglins[0].position)
    n.barterSurveySteps = 0
    const cooldowns = ctx.shared.piglinBarterCooldowns instanceof Map
      ? ctx.shared.piglinBarterCooldowns
      : (ctx.shared.piglinBarterCooldowns = new Map())
    // Prune expired cooldown entries.
    for (const [id, until] of cooldowns) if (until <= currentTime) cooldowns.delete(id)

    const ready = piglins.find(p => (cooldowns.get(p.runtimeId) ?? 0) <= currentTime)
    if (!ready) {
      return pending('ピグリンが金インゴットを確認して交易品を渡すのを待っています')
    }

    const dist = distance(ctx.getFeet(), ready.position)
    if (dist > BARTER_RANGE) {
      const stand = reachable(ctx)
        .filter(p => {
          const d = distance(center(p), ready.position)
          return d >= 1.8 && d <= 3.8
        })
        .sort((a, b) => distance(center(a), ready.position) - distance(center(b), ready.position))[0]
      if (stand && live(ctx)) {
        if (await ctx.hands.walk(center(stand))) recordStep(n, cell(ctx.getFeet()))
        return pending('交易できる大人のピグリンの近くへ移動します')
      }
      // Piglin is across a gap or ledge with no reachable footing: keep surveying.
    } else if (live(ctx)) {
      await lookAtActor(ctx, ready)
      const dropped = await ctx.drop(goldSlot.slot, 1)
      if (dropped?.serverConfirmed === true) {
        cooldowns.set(ready.runtimeId, now() + PIGLIN_COOLDOWN_MS)
        n.lastBarterDropAt = now()
        return pending('ピグリンに金インゴットを1個渡しました。交易品のドロップと持ち物増加を確認します')
      }
      return pending('金インゴットの受け渡し応答を確認しています')
    }
  }

  n.barterSurveySteps = (n.barterSurveySteps ?? 0) + 1
  if (n.barterSurveySteps > MAX_SURVEY_STEPS) {
    n.barterExhausted = true
    n.returning = 'barter_none'
    return pending('ネザーで交易できるピグリンが見つからなかったため地上へ戻り、洞窟探索へ切り替えます')
  }
  return survey(ctx, n, 'piglin')
}

module.exports = {
  PEARL_TARGET,
  BARTER_LOOT_PRIORITY,
  PIGLIN_COOLDOWN_MS,
  BARTER_WAIT_AFTER_DROP_MS,
  MAX_SURVEY_STEPS,
  barterGoldGoal,
  pearlProgress,
  isBarterablePiglin,
  barterDrops,
  wearingGoldBoots,
  stepBarter
}
