'use strict'

const { createStoragePorts } = require('./player-storage-ports')
const { bestWool } = require('./house/house-needs')
const { createHousePorts } = require('./house/house-ports')
const { createContainerPorts } = require('./return/container-ports')
const { approach, findCells, collect, SOURCES, MOBS } = require('./dragon-supply-gather')
const { createDragonBrewing } = require('./dragon-brew')
const { home, end, nether, spare, combined, matches, count, full, bare, homeCarryNeed, hasWorkingPick } = require('./dragon-supply-kit')
const { provisionFood } = require('./dragon-early-food')

const ingredient = {
  iron_helmet: { iron_ingot: 5 }, iron_chestplate: { iron_ingot: 8 }, iron_leggings: { iron_ingot: 7 }, iron_boots: { iron_ingot: 4 },
  wooden_pickaxe: { planks: 3, stick: 2 }, stone_pickaxe: { cobblestone: 3, stick: 2 },
  golden_boots: { gold_ingot: 4 }, iron_pickaxe: { iron_ingot: 3, stick: 2 }, iron_sword: { iron_ingot: 2, stick: 1 },
  diamond_helmet: { diamond: 5 }, diamond_chestplate: { diamond: 8 }, diamond_leggings: { diamond: 7 }, diamond_boots: { diamond: 4 },
  diamond_sword: { diamond: 2, stick: 1 }, diamond_pickaxe: { diamond: 3, stick: 2 }, shield: { iron_ingot: 1, planks: 6 },
  bow: { string: 3, stick: 3 }, arrow: { stick: 1, feather: 1, flint: 1 }, bucket: { iron_ingot: 3 },
  glass_bottle: { glass: 3 }, brewing_stand: { blaze_rod: 1, cobblestone: 3 }, blaze_powder: { blaze_rod: 1 },
  magma_cream: { slime_ball: 1, blaze_powder: 1 }, ender_eye: { ender_pearl: 1, blaze_powder: 1 },
  flint_and_steel: { iron_ingot: 1, flint: 1 }, chest: { planks: 8 }, crafting_table: { planks: 4 },
  furnace: { cobblestone: 8 }, stick: { planks: 2 }, stone_hoe: { stick: 2, cobblestone: 2 }, bed: { wool: 3, planks: 3 }
}
const smelted = { iron_ingot: 'raw_iron', gold_ingot: 'raw_gold', glass: 'sand' }
const small = new Set(['crafting_table', 'stick', 'flint_and_steel', 'blaze_powder', 'magma_cream', 'ender_eye'])
const pickFor = { cobblestone: 'wooden', coal: 'wooden', raw_iron: 'stone', raw_gold: 'iron', redstone: 'iron', diamond: 'iron', obsidian: 'diamond' }
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
    const near = findCells(ctx, b => b.name === full(name) || name === 'furnace' && b.name === 'minecraft:lit_furnace', 8, 3)[0]
    if (near) { await approach(ctx, near); return remember(near) }
    if (!held(name)) { await acquire(name, 1); return null }
    const feet = ctx.getFeet()
    for (const [dx, dz] of [[2,0],[-2,0],[0,2],[0,-2],[1,1]]) {
      if (cancelled()) return null
      const pos = { x: Math.floor(feet.x) + dx, y: Math.floor(feet.y), z: Math.floor(feet.z) + dz }
      if (await bench.place(pos, full(name))) return remember(pos)
      if (!bench.placementRetrySafe()) break
    }
    return null
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
      else if (!held('coal') && !held('charcoal') && !held('planks')) await acquire('planks', 2)
      else {
        const furnace = await station('furnace')
        const plank = rows().find(i => matches('planks', i))
        const fuel = held('coal') ? 'minecraft:coal' : held('charcoal') ? 'minecraft:charcoal' : plank?.name
        if (furnace && fuel && !cancelled()) await house.smelt(furnace, full(material), 1, fuel, 1, full(name))
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
    } else if (SOURCES[name] || MOBS[name]) await collect(ctx, name)
    else return { ...pending(full(name) + ' の回収を待っています。'), missing: { name, count: target } }
    const current = held(name)
    return current >= target ? done(name + ' の所持数を確認しました。') : pending(name + ' を準備しています（' + current + '/' + target + '）。')
  }

  async function inspect (pos) {
    if (!pos || cancelled() || !getInventory() || !await approach(ctx, pos) || cancelled()) return null
    const result = await box.inspect(pos, { aborted: cancelled })
    return result.status === 'completed' && result.evidence.slotCount === 54 ? box.contents(pos) : null
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
    if (!slots) return pending('予備のラージチェスト54枠と持ち物を確認します。')
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
