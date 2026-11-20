'use strict'

const { createStoragePorts } = require('./player-storage-ports')
const { bestWool } = require('./house/house-needs')
const { createHousePorts } = require('./house/house-ports')
const { createContainerPorts } = require('./return/container-ports')
const { approach, findCells, collect, SOURCES, MOBS } = require('./dragon-supply-gather')
const { createDragonBrewing } = require('./dragon-brew')
const { home, end, nether, spare, combined, matches, count, full, bare, homeCarryNeed, hasWorkingPick } = require('./dragon-supply-kit')
const { provisionFood } = require('./dragon-early-food')
const { placeStation } = require('./station-room')
const { reserveRoom } = require('./dragon-reserve-room')
const { createOpenStand } = require('./open-stand')

const { ingredient, smelted, small, pickFor } = require('./dragon-supply-recipes')
const { diggerWanted } = require('./dig-tool')
const DIGGER = { stage: 'digger', target: 'stone_pickaxe', code: 'NOT_MADE' }
const pending = reason => ({ done: false, reason })
const done = reason => ({ done: true, reason })

function createDragonSupplies (ctx) {
  const { operations, runtime, getBlock, cancelled } = ctx
  const getInventory = () => {
    const inv = runtime.inventory()
    return !ctx.shared.inventoryUncertain && inv?.known === true && inv.uncertain !== true ? inv : null
  }
  const rows = () => (getInventory()?.items ?? []).map(row => ({ ...row, metadata: row.metadata ?? runtime.dragonItems?.rawItem(row.slot)?.metadata }))
  const held = name => name === 'wool' ? bestWool(rows()) : count(name, rows())
  const worn = () => {
    const armor = runtime.armor?.(), result = armor?.known ? (armor.worn ?? []).filter(i => i.name).map(i => ({ ...i, count: 1 })) : []
    if (armor?.offhand?.name) result.push({ ...armor.offhand, count: 1 })
    return result
  }
  const deps = { operations, getFeet: ctx.getFeet, getBlock, getInventory, disposed: cancelled }
  const bench = createStoragePorts(deps), house = createHousePorts(deps), box = createContainerPorts(deps)
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  // Why the last step of this run did nothing (a refused open click, …): shown with the reason, so a stall is not silent.
  let trouble = null
  // A furnace that stands near and cannot be opened from anywhere the Bot can stand: one failure of that furnace
  // for the goal's ledger (three, and it is spent). Live 2026-11-20 02:55-03:03 JST: underground, a furnace in
  // the bag, raw iron and fuel in hand, and a furnace within eight blocks that no walk reached. Every two seconds
  // the smelt was asked of that furnace and refused (「かまど: 操作対象が手の届く範囲外です。」) for eight minutes,
  // until the pinned item ran out; the held furnace was never put down.
  const stand = createOpenStand({ getBlock, getFeet: ctx.getFeet, walk: to => ctx.hands.walk(to) })
  const shut = cell => ({ stage: 'station', target: [cell.x, cell.y, cell.z].join(','), code: 'STATION_NOT_OPENED' })

  async function station (name) {
    const saved = ctx.memory?.early
    const previous = name === 'brewing_stand' && saved?.brewingStand
    if (previous && runtime.raw().dimension === 'overworld') {
      const b = getBlock(previous.x, previous.y, previous.z)
      const far = Math.hypot(ctx.getFeet().x - previous.x, ctx.getFeet().z - previous.z)
      if (far > 16 && !cancelled()) {
        if (!operations.quarry.travelStatus().busy) await ctx.travelTo({destination:{x:previous.x,z:previous.z}}, {aborted:cancelled})
        return null
      }
      if (b?.known !== true || b.name === full(name)) {
        if (b?.known && await approach(ctx,previous)) return previous
        return null
      }
      delete saved.brewingStand
    }
    function remember (cell) {
      if (saved && name === 'brewing_stand' && runtime.raw().dimension === 'overworld') saved.brewingStand = {x:cell.x,y:cell.y,z:cell.z}
      return cell
    }
    // A furnace standing nearby is used from where its open click has a line (open-stand.js: the rule of the click
    // itself). One that gave no such place three times is left for another, or for the held one to be put down.
    const near = findCells(ctx, b => b.name === full(name) || name === 'furnace' && b.name === 'minecraft:lit_furnace', 8, 3).find(cell => ctx.goal?.spent?.(shut(cell)) !== true)
    if (near && name === 'furnace') {
      await approach(ctx, near)
      if (cancelled()) return null
      if (await stand.go(near, cancelled)) return remember(near)
      if (cancelled()) return null
      const noted = ctx.goal?.fail?.(shut(near), { paceMs: 10000 })
      trouble = `かまど (${near.x}, ${near.y}, ${near.z}) を開けられる場所に立てません`
      if (noted?.exhausted) ctx.log?.(`プレイヤーモード: かまど (${near.x}, ${near.y}, ${near.z}) を開けられる場所に ${noted.count} 回立てなかったため、このかまどは使いません（ほかのかまどを使うか、持っているかまどを置きます）`)
      return null
    }
    if (near) { await approach(ctx, near); return remember(near) }
    if (!held(name)) { await acquire(name, 1); return null }
    // Open cells first; in a one-wide tunnel a niche is mined for it (station-room.js).
    const pos = await placeStation({ getBlock, feet: ctx.getFeet(), getFeet: ctx.getFeet, place: cell => bench.place(cell, full(name)), retrySafe: () => bench.placementRetrySafe(), why: () => bench.refusal(), hands: ctx.hands, cancelled, log: ctx.log, label: name === 'crafting_table' ? '作業台' : name === 'furnace' ? 'かまど' : name })
    return pos ? remember(pos) : null
  }

  async function useWater (item, pos) {
    const stack = rows().find(i => i.name === full(item))
    if (!stack || !pos || !await approach(ctx, pos) || cancelled()) return false
    const equipped = await operations.inventory.equip(stack.slot)
    const slot = equipped?.slot ?? stack.slot
    if (cancelled() || slot > 8 || !rows().some(i => i.slot === slot && i.name === full(item))) return false
    await operations.interactions.useDragonItem({ item: full(item), position: { x:pos.x,y:pos.y,z:pos.z }, slot })
    return !cancelled()
  }
  async function fill (name) {
    const vessel = name === 'water_bucket' ? 'bucket' : 'glass_bottle'
    if (!held(vessel)) { await acquire(vessel, 1); return }
    const source = findCells(ctx, b => b.name === 'minecraft:water' && b.properties?.liquid_depth === 0 && !b.extra?.length)[0]
    if (source) await useWater(vessel, source)
    else await require('./dragon-supply-gather').explore(ctx, 'water')
  }

  async function acquire (requested, target = 1) {
    const name = bare(requested)
    if (cancelled() || !getInventory() || !Number.isSafeInteger(target) || target < 1) return pending('資材を準備するため、現在の所持品を再確認します。')
    if (held(name) >= target) return done(name + ' を持ち物で確認しました。')
    if (name === 'food') return provisionFood(ctx, target)
    const recipe = ingredient[name], material = smelted[name]
    if (name === 'water_bucket') await fill(name)
    else if (name === 'planks') {
      const log = rows().find(i => matches('log', i))
      if (!log) await acquire('log', 1)
      else await bench.craftPlanks(log.name, 1)
    } else if (material) {
      if (!held(material)) await acquire(material, 1)
      else if (!held('coal') && !held('charcoal') && !held('planks')) {
        // Fuel: coal ore already in view (underground) before a walk to the trees.
        const coalNear = findCells(ctx, b => SOURCES.coal.test(bare(b.name))).length > 0
        await acquire(coalNear ? 'coal' : 'planks', coalNear ? 1 : 2)
      }
      else {
        const furnace = await station('furnace')
        const plank = rows().find(i => matches('planks', i))
        const fuel = held('coal') ? 'minecraft:coal' : held('charcoal') ? 'minecraft:charcoal' : plank?.name
        if (furnace && fuel && !cancelled()) { house.reset(); if (!await house.smelt(furnace, full(material), 1, fuel, 1, full(name)) && house.why()) trouble = 'かまど: ' + house.why() }
      }
    } else if (recipe) {
      const missing = Object.entries(recipe).find(([part, need]) => held(part) < need)
      if (missing) {
        if (name === 'magma_cream' && missing[0] === 'slime_ball' && runtime.raw().dimension === 'nether') await collect(ctx, name)
        else await acquire(missing[0], missing[1])
      } else if (small.has(name)) await bench.craftSmall(full(name), 1)
      else {
        const table = await station('crafting_table')
        if (table && !cancelled()) await bench.craftAtTable(table, full(name), 1)
      }
    } else if (pickFor[name] && !hasWorkingPick(rows(), pickFor[name])) {
      await acquire(pickFor[name] + '_pickaxe', 1)
    } else if (pickFor[name] && diggerWanted(rows(), held) && (held('crafting_table') || bench.tableNear()) && ctx.goal?.spent?.(DIGGER) !== true) {
      // Rock on the way to ore is dug with a stone pickaxe made from what is carried (dig-tool.js); the better one
      // is kept for what needs it. A look that brought it no nearer (no stick made, no table put down) is a failed
      // try; after three it is left, and the digging goes on.
      const parts = () => [held('stone_pickaxe'), held('stick'), held('planks'), held('crafting_table'), !!bench.tableNear()].join()
      const before = held('stone_pickaxe'), was = parts()
      await acquire('stone_pickaxe', before + 1)
      if (held('stone_pickaxe') > before) ctx.log?.('プレイヤーモード: 岩を掘るための石のツルハシを作りました（良いツルハシは、それが要るブロックに残します）')
      else if (!cancelled() && parts() === was) ctx.goal?.fail?.(DIGGER, { paceMs: 15000 })
    } else if (SOURCES[name] || MOBS[name]) await collect(ctx, name)
    else return { ...pending(full(name) + ' の回収を待っています。'), missing: { name, count: target } }
    const current = held(name)
    return current >= target ? done(name + ' の所持数を確認しました。') : pending(name + ' を準備しています（' + current + '/' + target + '）。' + (trouble ? '（' + trouble + '）' : ''))
  }

  // Why the last chest gave no 54 slots, when the chest itself answered so (not a walk, a pause or a fight in between).
  let unread = null
  async function inspect (pos) {
    unread = null
    if (!pos || cancelled() || !getInventory() || !await approach(ctx, pos) || cancelled()) return null
    const result = await box.inspect(pos, { aborted: cancelled })
    if (result.status === 'completed' && result.evidence.slotCount === 54) return box.contents(pos)
    if (!cancelled() && ['completed', 'failed', 'blocked'].includes(result.status)) unread = result.status === 'completed' ? `${result.evidence.slotCount ?? '?'}枠` : String(result.code ?? result.status)
    return null
  }
  function select (stacks, name, wanted, chest) {
    const result = []
    for (const row of stacks) {
      if (!matches(name, row) || wanted <= 0) continue
      const amount = Math.min(wanted, row.count)
      result.push({ [chest ? 'chestSlot' : 'slot']: row.slot, count: amount, name:row.name }); wanted -= amount
    }
    return result
  }
  async function moveStock (pos, name, amount, take) {
    if (cancelled()) return
    if (take) await box.withdraw(pos, slots => select(slots, name, amount, true), { aborted: cancelled })
    else await box.deposit(pos, select(rows(), name, amount, false), { aborted: cancelled })
  }
  async function bank (pos, item, amount, take) {
    const name = bare(item), slots = await inspect(pos)
    if (!slots) return pending('補給用のラージチェストを開き、54枠を確認します。')
    const observed = take ? held(name) : count(name, slots)
    if (observed >= amount) return done(name + ' の保管数・所持数を確認しました。')
    await moveStock(pos, name, amount - observed, take)
    return pending(name + ' の移動後の数量を確認します。')
  }
  async function reserve (pos, { mode, kit, keepReserve = false } = {}) {
    const recovering = mode === 'recover', desired = kit === 'end' ? spare : home
    const slots = await inspect(pos)
    if (!slots) return unread ? { ...pending('予備のラージチェストの54枠を受信できません（' + unread + '）。'), unread } : pending('予備のラージチェスト54枠と持ち物を確認します。')
    // What the reserve chest holds, as received just now: part of what the goal has (dragon-goal-measure.js).
    ctx.shared.dragonReserveSeen = { counts: Object.fromEntries(desired.map(([name]) => [name, count(name, slots)])) }
    for (const [name, amount] of desired) {
      const inChest = count(name, slots), carried = held(name), equipped = count(name, worn())
      if (recovering && carried + equipped >= amount) continue
      const wanted = recovering ? amount - carried - equipped : amount - inChest
      const activeKit = kit === 'end' ? end : nether
      const keep = kit === 'home' ? homeCarryNeed(name, amount, rows(), worn())
        : Math.max(0, (activeKit.find(([id]) => id === name)?.[1] ?? 0) - equipped)
      if (!recovering && inChest >= amount) {
        if (kit === 'home' && carried < keep) return { ...pending(name + ' を手持ち用に補給します。'), missing: { name, count: keep } }
        continue
      }
      const available = Math.max(0, recovering ? inChest - (keepReserve ? amount : 0) : carried - keep)
      if (available < 1) {
        const target = recovering ? amount - equipped : wanted + keep
        return { ...pending(name + ' を予備用に補給します。'), missing:{name, count:target} }
      }
      if (!recovering) {
        // A full chest takes nothing: one stack of rubble comes out first (dragon-reserve-room.js).
        const room = reserveRoom(slots, select(rows(), name, Math.min(wanted, available), false))
        if (!room.fits && !room.evict) return pending('予備のラージチェストが満杯で、取り出せる石材もありません（' + name + ' を入れられません）。')
        if (!room.fits) {
          const out = await box.withdraw(pos, seen => seen.filter(slot => slot.slot === room.evict.slot && slot.name === room.evict.name && slot.count > 0).map(slot => ({ chestSlot: slot.slot, name: slot.name, count: slot.count })), { aborted: cancelled })
          const taken = out.progress?.confirmedTransferred ?? 0
          return pending('予備のラージチェストが満杯のため、' + bare(room.evict.name) + ' を取り出して ' + name + ' の場所を空けます（' + taken + ' 個' + (taken ? '' : '・' + (out.detail ?? out.code ?? '取り出せませんでした')) + '）。')
        }
      }
      await moveStock(pos, name, Math.min(wanted, available), recovering)
      return pending(name + ' の予備装備の移動を確認します。')
    }
    // Bank any slow-falling bottles available beyond the main kit. With no
    // phantom source in a permanently daylight Realm, the diamond pick and
    // the interior tower stair route remain usable after a death.
    if (kit === 'end') {
      const usable = row => row.name === 'minecraft:potion' && [40, 41].includes(row.metadata)
      const bottles = slots.filter(usable)
      if (recovering && !keepReserve && heldSlow() < 4 && bottles.length) {
        await box.withdraw(pos, observed => observed.filter(usable).slice(0, 4 - heldSlow()).map(row => ({
          chestSlot: row.slot, name:row.name, count:1
        })), {aborted:cancelled})
        return pending('復帰用の低速落下を取り出しています。')
      }
      if (!recovering && heldSlow() > 4 && bottles.length < 4) {
        const available = rows().filter(usable).slice(0, Math.min(heldSlow() - 4, 4 - bottles.length))
        await box.deposit(pos, available.map(row => ({slot:row.slot, name:row.name, count:1})), {aborted:cancelled})
        return pending('本番用の4本を残して低速落下の予備を預けます。')
      }
      function heldSlow () { return rows().filter(usable).length }
    }
    return done(recovering ? '復帰用装備の所持を確認しました。' : 'ラージチェストに予備を確認しました。')
  }

  const brewing = createDragonBrewing(ctx, { rows, acquire, station, fill, sleep })
  async function prepare (kind) {
    if (!getInventory() || cancelled()) return pending('遠征用の持ち物の受信を待ちます。')
    const kit = kind === 'nether' ? nether : kind === 'reserve-end' ? combined(end, spare) : end
    for (const [name, need] of kit) {
      const equipped = count(name, worn()), carried = held(name)
      if (equipped + carried >= need) continue
      return { ...await acquire(name, need - equipped), done: false }
    }
    const wantedPotions = kind === 'reserve-end' ? 8 : 4
    if (kind !== 'nether' && brewing.countPotion('slow_falling') < wantedPotions &&
        (held('phantom_membrane') > 0 || ctx.operations.perception.entities().some(e => e.entityType === 'minecraft:phantom' && e.alive !== false))) {
      return { ...await brewing.brew('slow_falling', { count:wantedPotions }), done:false }
    }
    return done('遠征用の装備・食料・矢・足場の所持を確認しました。')
  }
  async function waterAt (cell) {
    if (!held('water_bucket')) return pending('水バケツが必要です。')
    await useWater('water_bucket', cell)
    const actual = getBlock(cell.x, cell.y + 1, cell.z)
    return actual?.known === true && actual.name === 'minecraft:water' && actual.properties?.liquid_depth === 0 ? done('水源を確認しました。') : pending('注いだ水源の受信を待ちます。')
  }
  return { acquire, prepare, reserve, waterAt, store:(p,n,c) => bank(p,n,c,false), withdraw:(p,n,c) => bank(p,n,c,true), ...brewing }
}
module.exports = { createDragonSupplies }
