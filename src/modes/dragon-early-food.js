'use strict'

const { createHousePorts } = require('./house/house-ports')
const { placements, matches } = require('./house/house-blueprint')
const { spiralPoint } = require('./house/house-sand')
const { approachHome } = require('./dragon-early-home')
const { threatWait, WAIT_MS } = require('./dragon-threat-wait')
const { foodReach } = require('./dragon-food-reach')

const PROVISIONS = /^minecraft:(?:bread|cooked_(?:beef|porkchop|chicken|rabbit|mutton|salmon|cod)|baked_potato)$/
const MEAT = /^minecraft:(beef|porkchop|chicken|rabbit|mutton|salmon|cod)$/
const SEED_GRASS = /^minecraft:(?:short_grass|tallgrass)$/
const AIR = /^minecraft:(?:air|cave_air)$/
const THREAT = new Set(['NEARBY_THREAT', 'THREAT_OBSERVATION_UNKNOWN'])
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const key = at => [at.x, at.y, at.z].join(',')
const pending = reason => ({ done: false, reason })
const known = (cell, names) => cell?.known === true && names.test(cell.name)

function farmSites (getBlock, center) {
  const result = new Map()
  // Two blocks from received surface water: irrigated soil, with a dry stand
  // beside it. Restrict plots to outside the starter house and porch.
  for (let dx = -12; dx <= 17; dx++) for (let dz = -12; dz <= 17; dz++) for (let dy = -2; dy <= 2; dy++) {
    const x = center.x + dx, y = center.y + dy, z = center.z + dz
    if (!known(getBlock(x, y, z), /^minecraft:(?:flowing_)?water$/)) continue
    for (const [ox, oz] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) {
      const at = { x: x + ox, y, z: z + oz }
      if (at.x >= center.x - 1 && at.x <= center.x + 7 && at.z >= center.z - 1 && at.z <= center.z + 10) continue
      const dirt = getBlock(at.x, y, at.z)
      if (dirt?.protected || dirt?.protectionSource || !known(dirt, /^minecraft:(?:dirt|grass_block|grass)$/)) continue
      if (!known(getBlock(at.x, y + 1, at.z), AIR) || !known(getBlock(at.x, y + 2, at.z), AIR)) continue
      result.set(key(at), at)
    }
  }
  return [...result.values()].sort((a, b) => distance(a, center) - distance(b, center)).slice(0, 8)
}

async function harvest (ctx, plant, block) {
  if (!await ctx.hands.approach(plant, 3) || ctx.cancelled()) return pending('収穫できる距離まで近づきます。')
  const target = { ...plant, accessPreparation: 'farm_harvest', expectedName: block.name, expectedRuntimeId: block.runtimeId }
  const mining = ctx.operations.mining
  if (!mining.preview([target]).ready) return pending('収穫対象への射線と足元を確認します。')
  await mining.start([target])
  return pending('収穫入力後、作物と落下品を再確認します。')
}

async function tend (ctx, items, origin, state) {
  if (!Array.isArray(state.plots) || !state.plots.length) state.plots = farmSites(ctx.getBlock, origin)
  const seeds = items.find(item => item.name === 'minecraft:wheat_seeds' && item.count > 0)
  const plots = state.plots.map(at => ({ at, soil: ctx.getBlock(at.x, at.y, at.z), above: ctx.getBlock(at.x, at.y + 1, at.z) }))
  const ripe = plots.find(plot => known(plot.above, /^minecraft:wheat$/) && plot.above.properties?.growth === 7)
  if (ripe) return harvest(ctx, { ...ripe.at, y: ripe.at.y + 1 }, ripe.above)
  const empty = plots.filter(plot => known(plot.above, AIR))
  if (!empty.length) return null
  if (!seeds) {
    const from = ctx.getFeet()
    let grass = null
    for (let dx = -8; dx <= 8; dx++) for (let dz = -8; dz <= 8; dz++) for (const dy of [0, 1, -1]) {
      const at = { x: Math.floor(from.x) + dx, y: Math.floor(from.y) + dy, z: Math.floor(from.z) + dz }
      const block = ctx.getBlock(at.x, at.y, at.z)
      if (known(block, SEED_GRASS) && !block.protected && (!grass || distance(from, at) < distance(from, grass.at))) grass = { at, block }
    }
    return grass ? harvest(ctx, grass.at, grass.block) : null
  }
  const ready = empty.find(plot => known(plot.soil, /^minecraft:farmland$/))
  const plot = ready ?? empty.find(plot => known(plot.soil, /^minecraft:(?:dirt|grass_block|grass)$/))
  if (!plot) return null
  const name = ready ? 'minecraft:wheat_seeds' : 'minecraft:stone_hoe'
  const tool = items.find(item => item.name === name && item.count > 0)
  if (!tool) return ctx.supplies.acquire('stone_hoe', 1)
  if (!await ctx.hands.approach(plot.at, 3) || ctx.cancelled()) return pending('本拠点の畑へ近づきます。')
  const equip = await ctx.operations.inventory.equip(tool.slot)
  if (!equip || !['completed', 'unchanged', 'already_selected'].includes(equip.phase) || ctx.cancelled()) return pending('農具を持ち替えています。')
  const slot = ctx.runtime.inventory()?.items?.find(item => item.slot === equip.slot && item.name === name && item.count > 0)?.slot
  if (slot == null) return pending('農具の装備確認を待ちます。')
  await ctx.operations.interactions.useDragonItem({ item: name, position: plot.at, slot })
  return pending(ready ? '種をまき、作物の出現を確認します。' : '耕した畑のブロック更新を待ちます。')
}

async function provisionFood (ctx, wanted = 32) {
  const inventory = ctx.runtime.inventory()
  if (inventory?.known !== true || inventory.uncertain || ctx.cancelled()) return pending('食料の所持数を確認します。')
  const items = inventory.items ?? []
  const count = items.reduce((n, item) => n + (PROVISIONS.test(item.name) ? item.count : 0), 0)
  if (count >= wanted) return { done: true, reason: '遠征に持参する食料を確認しました。' }
  if (ctx.runtime.raw()?.dimension !== 'overworld') return pending('食料の補給には現世の拠点へ戻ります。')
  const state = ctx.memory.early ??= {}
  const origin = ctx.shared.playerHouse?.origin
  const feet = ctx.getFeet()
  if (!feet || !origin) return pending('食料を用意する本拠点を確認します。')
  const here = distance(feet, origin) < 25
  const raw = items.find(item => MEAT.test(item.name) && item.count > 0)
  const wheat = items.filter(item => item.name === 'minecraft:wheat').reduce((n, item) => n + item.count, 0)
  // One piece of raw meat is not a reason to walk home while another animal is in view (cook-trip.js).
  const rawCount = items.reduce((n, item) => n + (MEAT.test(item.name) ? item.count : 0), 0)
  const seen = raw && !here ? ctx.operations.foraging.preview({ stockpile: true }) : null
  const huntReady = seen?.ready === true && !foodReach(ctx.shared, { now: ctx.now }).given(seen.target?.runtimeId)
  if (wheat >= 3 || require('./cook-trip').cookNow({ raw: rawCount, here, huntReady })) {
    const stationType = raw ? 'furnace' : 'crafting_table'
    const station = placements(origin).find(step => step.item === stationType).position
    if (!await approachHome(ctx, station, { open: true })) return pending('集めた材料を本拠点で調理します。')
    if (!matches(stationType, ctx.getBlock(station.x, station.y, station.z))) return pending('調理設備のブロックを確認します。')
    const house = createHousePorts({ operations: ctx.operations, getBlock: ctx.getBlock, getInventory: ctx.runtime.inventory, disposed: ctx.cancelled, ...(ctx.sleep ? { sleep: ctx.sleep, now: ctx.now } : {}) })
    if (!raw) await house.craft('minecraft:bread', Math.min(Math.floor(wheat / 3), wanted - count, 16), station)
    else {
      const amount = Math.min(3, raw.count, wanted - count)
      const fuel = require('./cook-fuel').cookFuel(items, amount)
      if (!fuel) return pending((await ctx.supplies.acquire('coal', 1)).reason)
      const cooked = await house.smelt(station, raw.name, amount, fuel.name, fuel.count, raw.name.replace('minecraft:', 'minecraft:cooked_'))
      // A cook that gained nothing says why (live 2026-11-18 23:15-23:19 JST: four minutes at the door with this step's
      // text and no log line).
      if (!(cooked > 0) && !ctx.cancelled()) {
        const why = house.why() ?? '焼いた肉が増えません'
        const at = (ctx.now ?? Date.now)()
        if (!(at - (state.cookSaidAt ?? -Infinity) < 20000)) { state.cookSaidAt = at; ctx.log?.(`プレイヤーモード: 本拠点のかまどで調理できません（${why}。足元 ${Math.floor(feet.x)}, ${Math.floor(feet.y)}, ${Math.floor(feet.z)}）`) }
        return pending(`本拠点のかまどで調理をやり直します。（かまど: ${why}）`)
      }
    }
    return pending('調理後の食料数を確認します。')
  }
  if (here) {
    const drops = ctx.operations.perception.entities().filter(actor => actor.kind === 'item' && actor.position && distance(actor.position, feet) < 8 && /(?:wheat|wheat_seeds)$/.test(actor.name ?? actor.item?.name ?? ''))
    if (drops.length) {
      await ctx.operations.quarry.pickupNear({ center: drops[0].position, radius: 2, maxMs: 3000 })
      return pending('小麦と種の受け取りを確認します。')
    }
    const farm = await tend(ctx, items, origin, state)
    if (farm) return pending(farm.reason)
  }
  const forage = ctx.operations.foraging
  const plan = forage.preview({ stockpile: true })
  // Sources the hunt could not walk to are walked to once, then left alone (dragon-food-reach.js).
  const reach = foodReach(ctx.shared, { now: ctx.now })
  const name = target => String(target?.name ?? '').replace(/^minecraft:/, '')
  if (plan.ready && !reach.given(plan.target?.runtimeId)) {
    const stop = () => forage.stop('食料集めを中断しました。')
    ctx.signal.addEventListener('abort', stop, { once: true })
    let hunt
    try { hunt = await forage.execute({ stockpile: true, timeoutMs: 12000 }) } finally { ctx.signal.removeEventListener('abort', stop) }
    const gave = reach.note(hunt)
    if (gave) ctx.log?.(gave.chased ? `プレイヤーモード: 食料源 ${name(hunt.target)} は歩いても当てられないため、5分あけて別の食料源を探します（${hunt.reason ?? '理由不明'}）` : `プレイヤーモード: 食料源 ${name(hunt.target)} へ歩いて近づけません（${hunt.reason ?? '理由不明'}）`)
    return pending('狩りで得た肉を確認して調理します。')
  }
  if (plan.ready) {
    const near = reach.trip(plan.target, feet)
    if (near && !ctx.operations.quarry.travelStatus().busy && !ctx.cancelled()) {
      ctx.log?.(`プレイヤーモード: 食料源 ${name(plan.target)} のそばへ長距離移動で行きます（${Math.round(plan.distance ?? 0)}m）`)
      await ctx.travelTo({ destination: near }, { aborted: ctx.cancelled })
      reach.walked(plan.target?.runtimeId)
      return pending('食料源のそばから狩りをやり直します。')
    }
  }
  if (!plan.ready && plan.code !== 'NO_KNOWN_FOOD_SOURCE') {
    const reason = plan.errors?.[0] ?? '食料探しの安全確認を待ちます。'
    // An enemy nobody fights is not waited for without end (dragon-threat-wait.js): the search goes on somewhere else.
    if (!THREAT.has(plan.code) || threatWait(ctx.shared, 'food', { now: ctx.now, fighting: ctx.runtime.combatOwns?.() === true })) return pending(reason)
    if (!ctx.operations.quarry.travelStatus().busy && !ctx.cancelled()) ctx.log?.(`プレイヤーモード: 近くの敵が ${WAIT_MS / 1000} 秒たっても離れず、戦闘にもならないため、食料を探す場所を変えます`)
  }
  if (!ctx.operations.quarry.travelStatus().busy && !ctx.cancelled()) {
    const index = state.foodSearch ?? 0
    // Return to the plots regularly so they are loaded and can grow.
    const destination = index % 3 === 2 ? { x: origin.x + 3, z: origin.z + 9 } : spiralPoint(origin, index % 6)
    // The search trip ends as soon as a food source comes into view (dragon-trip.js).
    await ctx.travelTo({ destination }, { aborted: ctx.cancelled, until: () => { const seen = forage.preview({ stockpile: true }); return seen.ready === true && !reach.given(seen.target?.runtimeId) } })
    state.foodSearch = index + 1
  }
  return pending('畑の成長を待ちながら、周囲の食料源を探します。')
}

module.exports = { provisionFood, farmSites, PROVISIONS }
