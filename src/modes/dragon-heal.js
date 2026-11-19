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
const { threatWait } = require('./dragon-threat-wait')

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
async function heal ({ ctx, record, dim, shared, runtime, threatened, supplies, nether, recover, now = Date.now }) {
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

module.exports = { heal, unfed, REGEN, WAIT }
