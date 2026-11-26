'use strict'

const { home, count, homeCarryNeed } = require('./dragon-supply-kit')
const { ingredient } = require('./dragon-supply-recipes')
const { approachHome } = require('./dragon-early-home')
const { homeTarget, homeUse, same } = require('./dragon-home-use')
const { requestMine, beforeSurfaceSupply } = require('./mining/mine-controller')

const usesIron = name => (ingredient[name]?.iron_ingot ?? 0) > 0
const enabled = ctx => !!ctx.minePorts && ctx.runtime.raw()?.dimension === 'overworld'
const maxIron = home.reduce((total, [name, amount]) => total + 2 * amount * (ingredient[name]?.iron_ingot ?? 0), 0)
const waiting = reason => ({ done: false, reason })

function homeIronTarget (slots, inventory, worn) {
  return home.reduce((total, [name, amount]) => {
    if (!usesIron(name)) return total
    const reserveMissing = Math.max(0, amount - count(name, slots))
    const carryNeed = homeCarryNeed(name, amount, inventory, worn)
    const toCraft = Math.max(0, reserveMissing + carryNeed - count(name, inventory))
    return total + toCraft * ingredient[name].iron_ingot
  }, 0)
}

async function homeStation (ctx, name, options = {}) {
  const at = homeTarget(ctx, name, options).at
  if (!await approachHome(ctx, at, { open: true }) || ctx.cancelled()) {
    return waiting(`本拠点の${name === 'furnace' ? 'かまど' : '作業台'}へ戻っています。`)
  }
  const use = homeUse(ctx, name, options)
  if (!use.ok) return { ...waiting(use.reason), result: use.result }
  return same(at, use.at) ? { at } : waiting('本拠点の使える設備へ移ります。')
}

// The iron is smelted with charcoal, made of logs in the house's other furnace (the owner's rule, 2026-11-26 17:07
// JST: 「燃料は原木を木炭にしてから使ってください」). A charcoal smelts 8 items where a plank smelts 1.5; the planks
// only burn the logs into charcoal. null when the coal and charcoal held already cover `left` ingots.
async function charcoalFuel (ctx, left, ironOven, { held, house, acquire }) {
  const need = Math.ceil(left / 8), burning = held('coal') + held('charcoal')
  if (left <= 0 || burning >= need) return null
  const short = need - burning, plankFuel = Math.ceil(short * 2 / 3)
  if (held('planks') < plankFuel) return { ...await acquire('planks', plankFuel), done: false }
  if (held('log') < short) return { ...await acquire('log', short), done: false }
  const other = homeTarget(ctx, 'furnace', { spent: at => !!ironOven && same(at, ironOven) })
  const kiln = other.state === 'standing' ? other.at : ironOven
  if (!kiln) return waiting('木炭を焼く本拠点のかまどを確認します。')
  if (!await approachHome(ctx, kiln, { open: true }) || ctx.cancelled()) return waiting('木炭を焼く本拠点のかまどへ向かいます。')
  const items = ctx.runtime.inventory()?.items ?? []
  const log = items.find(item => /_log$/.test(item.name) && !/stripped_/.test(item.name) && item.count > 0)?.name
  const plank = items.find(item => /_planks$/.test(item.name) && item.count > 0)?.name
  if (!log || !plank) return waiting('木炭にする原木と板材を確認します。')
  house.reset()
  await house.smelt(kiln, log, short, plank, plankFuel, 'minecraft:charcoal', { wholeAmount: short, waitBatch: 8 })
  return waiting(`精錬の燃料に、原木を木炭にしています（木炭 ${held('charcoal')} / ${need}個）。` + (house.why() ? ' ' + house.why() : ''))
}

async function prepareHomeIron (ctx, batch, { held, house, acquire }) {
  if (!Number.isSafeInteger(batch.target) || batch.target < 1 || batch.target > maxIron) {
    return { done: true, reason: '今の所持品と備蓄から鉄の必要数を計算し直します。' }
  }
  if (batch.rawTarget > 0) {
    const result = await requestMine(ctx, { resource: 'raw_iron', targetHeld: batch.rawTarget, requester: 'home_reserve' })
    if (!result.done || ctx.cancelled()) return result
    delete batch.rawTarget
    return waiting('携行用と予備用の鉄の原石を確保しました。本拠点で精錬します。')
  }
  const returning = await beforeSurfaceSupply(ctx)
  if (returning) return returning
  if (held('iron_ingot') >= batch.target) return { done: true, reason: '携行用と予備用に必要な鉄インゴットを確認しました。' }
  const leftNow = batch.target - held('iron_ingot')
  // Once the furnace reported no burning fuel and none was held, keep gathering
  // wood outside instead of walking back inside to the same empty furnace after
  // every search step (live 2026-11-26 00:36-00:55 JST: 18 min door/tree loop).
  if (batch.fuelTarget > 0) {
    const step = await charcoalFuel(ctx, leftNow, homeTarget(ctx, 'furnace').at, { held, house, acquire })
    if (step) return step
    delete batch.fuelTarget
  }

  const failure = at => ({ stage: 'reserve', target: [at.x, at.y, at.z].join(','), code: 'IRON_FURNACE_UNREAD' })
  const oven = await homeStation(ctx, 'furnace', { spent: at => ctx.goal?.spent?.(failure(at)) === true })
  if (!oven.at) return oven
  const left = batch.target - held('iron_ingot')
  if (left <= 0) return { done: true, reason: '携行用と予備用に必要な鉄インゴットを確認しました。' }
  const fuel = ['coal', 'charcoal'].find(name => held(name) > 0)
  const fuelName = fuel && 'minecraft:' + fuel
  house.reset()
  await house.smelt(oven.at, 'minecraft:raw_iron', Math.min(64, left), fuelName,
    Math.ceil(left / 8), 'minecraft:iron_ingot', { wholeAmount: left, waitBatch: 8 })
  if (ctx.cancelled() || ctx.shared.inventoryUncertain || ctx.runtime.inventory()?.known !== true || ctx.runtime.inventory()?.uncertain) {
    return waiting('精錬後の持ち物を再受信します。')
  }
  const need = house.smeltNeed()
  if (need?.wholeInputMissing > 0) {
    batch.rawTarget = held('raw_iron') + need.wholeInputMissing
    return waiting(`携行用と予備用の鉄の原石を、採掘場で計${batch.rawTarget}個まで集めます。`)
  }
  if (held('iron_ingot') >= batch.target) return { done: true, reason: '携行用と予備用の鉄を本拠点で精錬しました。' }
  if (need?.fuel && !fuelName) {
    batch.fuelTarget = Math.ceil((batch.target - held('iron_ingot')) / 8)
    const step = await charcoalFuel(ctx, batch.target - held('iron_ingot'), oven.at, { held, house, acquire })
    if (step) return step
    delete batch.fuelTarget
    return waiting('木炭がそろったので、本拠点で鉄の精錬を続けます。')
  }
  if (!need && house.why()) ctx.goal?.fail?.(failure(oven.at), { paceMs: 20000 })
  return waiting(`本拠点で鉄を精錬しています（${held('iron_ingot')} / ${batch.target}個）。` + (house.why() ? ' ' + house.why() : ''))
}

module.exports = { enabled, usesIron, homeIronTarget, prepareHomeIron, homeStation }
