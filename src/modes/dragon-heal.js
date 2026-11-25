'use strict'

// The expedition's wait for health (from health 12 or less until 18, dragon-expedition.js).
//
// The wait heals only when something feeds it: a meal eaten now, or hunger of
// 18 or more (natural regeneration). With neither, the food comes first: the
// step that hunts and cooks at home. Before, only an empty pack sent it for
// food. Raw meat kept for the furnace (raw-meat-keep.js: hunger 10 or more
// and health above 12) is food in the pack that no meal may take, so the wait
// stood with it for ever (real Realm 2026-11-19 19:26-19:34 JST: health
// 17.03, hunger 16, raw meat 4 and no cooked food, 95 m west of the house,
// 「安全な場所で食事を取り、体力18以上への回復を待ちます。」 until the stall
// reset at ten minutes, which chose the same wait again).
const { hasFood } = require('./player-food')
const { count: kitCount } = require('./dragon-supply-kit')
const { threatWait } = require('./dragon-threat-wait')

const { REST } = require('./dragon-rest-pit')

const REGEN = 18
const WAIT = '安全な場所で食事を取り、体力18以上への回復を待ちます。'

// Nothing in the pack feeds the wait: no food, or food no meal may take while the hunger does not regenerate.
// `meal`: the eat preview. An unreceived hunger does not regenerate.
function unfed ({ meal, inventory, hunger }) {
  if (meal?.ready === true) return false
  if (!hasFood(inventory)) return true
  return meal?.code === 'FOOD_KEPT' && !(Number.isFinite(hunger) && hunger >= REGEN)
}

// One step of the wait. nether / recover: the expedition's own steps for the way back to the food.
// rest: the wait's covered pit (dragon-rest-pit.js), or null.
async function heal ({ ctx, record, dim, shared, runtime, threatened, supplies, nether, recover, rest = null, now = Date.now }) {
  const hunger = () => ctx.operations.food.snapshot?.()?.hunger
  // Under its lid the wait and its meals go on whatever stands above; with nothing left to feed it, out to the food.
  if (rest?.inside()) {
    const meal = ctx.operations.food.preview()
    if (meal.ready) await ctx.operations.food.eat()
    else if (!(Number.isFinite(hunger()) && hunger() >= REGEN) && unfed({ meal, inventory: runtime.inventory(), hunger: hunger() })) return rest.leave('unfed')
    return { phase: 'recovering', reason: REST }
  }
  // Badly hurt in the open with nothing near: the wait is taken under a lid, before a retreat leads it on.
  if (dim === 'overworld' && rest) {
    const dug = await rest.enter({ fed: ctx.operations.food.preview().ready === true || Number.isFinite(hunger()) && hunger() >= REGEN })
    if (dug) return dug
  }
  // An enemy that stands near without hitting for twenty seconds no longer holds the meal and the hunt
  // (live 2026-11-19 01:21-01:34 JST: thirteen minutes at health 7 with no food, then a creeper).
  const hit = now() - Number(shared.travelLastDamageAt ?? 0) < 10000
  if (threatened() && threatWait(shared, 'recover', { fighting: hit, slot: 'dragonRecoverWait' })) {
    await runtime.travel().retreatFromHostiles()
    return { phase: 'recovering', reason: '被弾したため、攻撃を中断して退避します。' }
  }
  const food = ctx.operations.food
  const meal = food.preview()
  if (meal.ready) await food.eat()
  else if (unfed({ meal, inventory: runtime.inventory(), hunger: food.snapshot?.()?.hunger })) {
    if (dim === 'nether' && record.nether.gate) {
      record.nether.returning = 'supplies'
      return nether(ctx)
    }
    if (record.recovery) return recover(ctx, record)
    if (dim === 'overworld' && shared.playerHouse?.origin) return supplies.acquire('food', 1)
  }
  return { phase: 'recovering', reason: WAIT }
}

// Hunger this low with nothing to eat: the food comes before the work, while the health is still whole.
// Before, only health of 12 or less sent the expedition for food, so a Bot with an empty pack worked on
// until it starved down to that (real Realm 2026-11-24 08:16 JST: hunger 6, no food, no armour, health
// 19.5, 「採掘場の資材を準備しています」; hunger had been under 18 - no regeneration - since 07:47).
// Once a food trip begins, keep gathering cooked provisions up to FOOD_TRIP (real Realm 2026-11-25
// 10:14-10:31 JST: acquiring only 1 food let the Bot eat 1 raw/cooked meat, jump hunger 6 -> 8/10 with
// 0 food left, climb 54 blocks back down to the Y=16 branch mine, dig 3 steps, and repeat every 5 min).
const HUNGRY = 6
const FOOD_TRIP = 6
// What that asks for now: 'eat' (a meal can be taken), 'food' (the way to food), or null (not hungry, or not here).
function hungry ({ ctx, record, dim, shared, runtime, threatened }) {
  const food = ctx.operations.food, hunger = food?.snapshot?.()?.hunger
  if (dim !== 'overworld' || record.stage !== 'early' || record.recovery || !shared?.playerHouse?.origin) {
    if (shared) delete shared.dragonFoodTrip
    return null
  }
  if (!Number.isFinite(hunger) || threatened()) return null
  const inventory = runtime.inventory()
  const cooked = inventory?.known === true && !inventory.uncertain && Array.isArray(inventory.items)
    ? kitCount('food', inventory.items)
    : null
  if (shared.dragonFoodTrip && cooked !== null && cooked >= FOOD_TRIP) delete shared.dragonFoodTrip
  const meal = food.preview()
  if (hunger <= HUNGRY) {
    if (meal?.ready === true) return 'eat'
    if (unfed({ meal, inventory, hunger })) {
      shared.dragonFoodTrip = true
      return 'food'
    }
    return null
  }
  if (shared.dragonFoodTrip && cooked !== null && cooked < FOOD_TRIP) return 'food'
  return null
}
async function feed (want, { ctx, supplies }) {
  if (want === 'food') return supplies.acquire('food', FOOD_TRIP)
  await ctx.operations.food.eat()
  return { phase: 'recovering', reason: '満腹度が少ないため、先に食事を取ります。' }
}

module.exports = { heal, hungry, feed, unfed, REGEN, HUNGRY, FOOD_TRIP, WAIT }
