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

  const failure = at => ({ stage: 'reserve', target: [at.x, at.y, at.z].join(','), code: 'IRON_FURNACE_UNREAD' })
  const oven = await homeStation(ctx, 'furnace', { spent: at => ctx.goal?.spent?.(failure(at)) === true })
  if (!oven.at) return oven
  const left = batch.target - held('iron_ingot')
  if (left <= 0) return { done: true, reason: '携行用と予備用に必要な鉄インゴットを確認しました。' }
  const fuel = ['coal', 'charcoal', 'planks'].find(name => held(name) > 0)
  const fuelName = fuel === 'planks' ? ctx.runtime.inventory()?.items?.find(item => /_planks$/.test(item.name) && item.count > 0)?.name
    : fuel && 'minecraft:' + fuel
  house.reset()
  await house.smelt(oven.at, 'minecraft:raw_iron', Math.min(64, left), fuelName,
    Math.ceil(fuel === 'planks' ? left * 2 / 3 : left / 8), 'minecraft:iron_ingot', { wholeAmount: left, waitBatch: 8 })
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
    const result = await acquire('planks', Math.ceil((batch.target - held('iron_ingot')) * 2 / 3))
    return { ...result, done: false }
  }
  if (!need && house.why()) ctx.goal?.fail?.(failure(oven.at), { paceMs: 20000 })
  return waiting(`本拠点で鉄を精錬しています（${held('iron_ingot')} / ${batch.target}個）。` + (house.why() ? ' ' + house.why() : ''))
}

module.exports = { enabled, usesIron, homeIronTarget, prepareHomeIron, homeStation }
