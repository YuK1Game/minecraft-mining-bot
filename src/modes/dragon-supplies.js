'use strict'

const { createStoragePorts } = require('./player-storage-ports')
const { bestWool } = require('./house/house-needs')
const { createHousePorts } = require('./house/house-ports')
const { createContainerPorts } = require('./return/container-ports')
const { approach, findCells, inView, collect, SOURCES, MOBS } = require('./dragon-supply-gather')
const { createDragonBrewing } = require('./dragon-brew')
const { home, end, nether, spare, combined, compactReserveKit, matches, count, full, bare, homeCarryNeed, hasWorkingPick } = require('./dragon-supply-kit')
const { provisionFood } = require('./dragon-early-food')
const { placeStation } = require('./station-room')
const { homeFurnace } = require('./station-yard')
const { reserveRoom } = require('./dragon-reserve-room')
const { createOpenStand } = require('./open-stand')

const { ingredient, smelted, small, pickFor } = require('./dragon-supply-recipes')
const { diggerWanted } = require('./dig-tool')
const { openAbove } = require('./player-surface')
const { weaponWanted } = require('./carry-weapon')
const { noteReserve } = require('./dragon-reserve-seen')
const mining = require('./mining/mine-controller')
const { reservedShaftCell, insideMine } = require('./mining/mine-location')
const { mineWorldScope, sameWorld } = require('./mining/mine-state')
const { occupied } = require('./mining/mine-carry')
const homeIron = require('./dragon-home-iron')
const DIGGER = { stage: 'digger', target: 'stone_pickaxe', code: 'NOT_MADE' }
const WOOD = { stage: 'digger', target: 'log', code: 'NOT_FOUND' }
const SWORD = { stage: 'weapon', target: 'stone_sword', code: 'NOT_MADE' }
const SWORD_WOOD = { stage: 'weapon', target: 'log', code: 'NOT_FOUND' }
const DIGGER_SAYS = { flag: 'dragonDiggerWood', wood: '岩を掘る石のツルハシの棒がないため、掘り始める前に原木を1本取ります（良いツルハシは、それが要るブロックに残します）', made: '岩を掘るための石のツルハシを作りました（良いツルハシは、それが要るブロックに残します）', none: '石のツルハシにする木が近くに見つからないため、持っているツルハシで掘り進みます' }
const SWORD_SAYS = { flag: 'dragonSwordWood', wood: '武器がなく、石の剣にする木も足りないため、先に原木を1本取ります', made: '武器がないため、石の剣を作りました', none: '石の剣にする木が近くに見つからないため、武器なしで作業を続けます' }
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
  // One memory of received chest contents with the return and the storage (mode-runtime.js): what any of them last received of a chest.
  const deps = { operations, getFeet: ctx.getFeet, getBlock, getInventory, disposed: cancelled, memory: ctx.shared.playerChestMemory ??= { seen: new Map() }, ...(ctx.sleep ? { sleep: ctx.sleep, now: ctx.now } : {}) }
  const reserved = cell => {
    const plan = ctx.memory?.early?.mine?.branch?.plan
    return reservedShaftCell(plan, cell) && sameWorld(plan.scope, mineWorldScope(runtime.mineState?.() ?? runtime.raw?.()))
  }
  const bench = createStoragePorts({ ...deps, reservedPlacement: reserved }), house = createHousePorts(deps), box = createContainerPorts(deps)
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

  async function station (name, { existingOnly = false } = {}) {
    const returning = await mining.beforeSurfaceSupply(ctx)
    if (returning) { trouble = returning.reason; return null }
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
    if (existingOnly) return null
    // Near the house the house's furnace is used; no portable one is put down beside it (station-yard.js).
    if (name === 'furnace') {
      const home = await homeFurnace(ctx)
      if (home?.at) return remember(home.at)
      if (home) { trouble = home.reason; return null }
    }
    if (!held(name)) { await acquire(name, 1); return null }
    // Open cells first; in a one-wide tunnel a niche is mined for it (station-room.js).
    const pos = await placeStation({ getBlock, reserved, feet: ctx.getFeet(), getFeet: ctx.getFeet, place: cell => bench.place(cell, full(name)), retrySafe: () => bench.placementRetrySafe(), why: () => bench.refusal(), hands: ctx.hands, cancelled, log: ctx.log, label: name === 'crafting_table' ? '作業台' : name === 'furnace' ? 'かまど' : name })
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
  // The stone pickaxe for digging rock (dig-tool.js `diggerWanted`), and the way to it that is open now.
  // DIGGER: its parts are carried, it is made. WOOD: the cobblestone is carried and no stick, plank or log; a log
  // is fetched where that is a short walk: one in view, or the open sky overhead (a tree is looked for as any other
  // material is; a head under ground, a roof or unreceived cells is not the open sky). Underground with no log in
  // view nothing is fetched and the digging goes on with what is carried. A way that failed three times is left.
  // The way open now to a stone tool of the Bot's own making: `made` with its parts carried, `wood` where a log is
  // a short walk, null where neither is or the way failed three times.
  const sky = () => {
    if (insideMine(ctx, ctx.memory?.early?.mine?.branch)) return false
    const feet = ctx.getFeet()
    return !!feet && openAbove(getBlock, Math.floor(feet.x), Math.floor(feet.y + 0.001), Math.floor(feet.z))
  }
  const wayTo = (want, made, wood) => want === 'make' ? (ctx.goal?.spent?.(made) === true ? null : made) : ctx.goal?.spent?.(wood) === true || insideMine(ctx, ctx.memory?.early?.mine?.branch) ? null : inView(ctx, 'log').length > 0 || sky() ? wood : null
  function digger () {
    const want = diggerWanted(rows(), held)
    return want && (held('crafting_table') || bench.tableNear()) ? wayTo(want, DIGGER, WOOD) : null
  }
  // A stone sword when no weapon is carried (carry-weapon.js), by the same ways.
  function weapon () {
    const want = getInventory() ? weaponWanted(rows(), held, { table: () => held('crafting_table') > 0 || !!bench.tableNear() }) : false
    if (!want) return null
    const way = wayTo(want, SWORD, SWORD_WOOD)
    if (way || want !== 'make') return way
    // Unarmed with the parts carried, a spent way is tried again every five minutes: being unarmed is what kills
    // (live 2026-11-26 05:17-05:33 JST: the way spent after three tries, then sixteen minutes unarmed in the mine
    // among spiders, zombies and skeletons at 12 health).
    const at = (ctx.now ?? Date.now)()
    if (at < (ctx.shared.dragonSwordRetryAt ?? 0)) return null
    ctx.shared.dragonSwordRetryAt = at + 5 * 60000
    return SWORD
  }
  // One try at such a tool. A look that brought it no nearer (no log, no stick made, no table put down) is a failed
  // try; after three the way is left. True once the tool is in the bag.
  async function own (item, way, wood, says) {
    const parts = () => [held(item), held('stick'), held('planks'), held('log'), held('crafting_table'), !!bench.tableNear()].join()
    const before = held(item), was = parts()
    if (way === wood && !ctx.shared[says.flag]) { ctx.shared[says.flag] = true; ctx.log?.('プレイヤーモード: ' + says.wood) }
    // With the planks for it carried and no table carried or near, the table is made in the bag first, so the tool is
    // made here and the search for a table does not walk off to one far away (live 2026-11-26 05:14-05:17 JST: three
    // tries at the stone sword, each a trip, then the way was spent and the Bot went back into the mine unarmed).
    if (way !== wood && !held('crafting_table') && !bench.tableNear() && !cancelled()) {
      if (held('planks') < 4 && held('log') > 0) await acquire('planks', 4)
      if (held('planks') >= 4 && !cancelled()) await bench.craftSmall(full('crafting_table'), 1)
    }
    await acquire(item, before + 1)
    if (held(item) > before) { delete ctx.shared[says.flag]; ctx.log?.('プレイヤーモード: ' + says.made); return true }
    if (!cancelled() && parts() === was && ctx.goal?.fail?.(way, { paceMs: way === wood ? 20000 : 15000 })?.exhausted && way === wood) { delete ctx.shared[says.flag]; ctx.log?.('プレイヤーモード: ' + says.none) }
    return false
  }
  // The step of the runtime before other work (dragon-runtime.js): null with a weapon carried or no way to one.
  async function arm (way = weapon()) {
    if (!way) return null
    await own('stone_sword', way, SWORD_WOOD, SWORD_SAYS)
    return { phase: 'working', reason: '武器がないため、石の剣を用意しています。' }
  }
  async function fill (name) {
    const vessel = name === 'water_bucket' ? 'bucket' : 'glass_bottle'
    if (!held(vessel)) { await acquire(vessel, 1); return }
    const source = findCells(ctx, b => b.name === 'minecraft:water' && b.properties?.liquid_depth === 0 && !b.extra?.length)[0]
    if (source) await useWater(vessel, source)
    else await require('./dragon-supply-gather').explore(ctx, 'water')
  }

  // Each thing asked for is said to the decision journal with what is held of it (decision-journal.js `need`):
  // things asked for inside one another are one line there.
  const activeAcquire = new Map()
  async function acquire (requested, target = 1, options = {}) {
    const key = bare(requested)
    const leave = ctx.judge?.need?.(key, getInventory() ? held(key) : '?', target)
    activeAcquire.set(key, (activeAcquire.get(key) ?? 0) + 1)
    try { return await gain(requested, target, options) } finally {
      const left = (activeAcquire.get(key) ?? 1) - 1
      if (left > 0) activeAcquire.set(key, left)
      else activeAcquire.delete(key)
      leave?.()
    }
  }
  async function gain (requested, target = 1, { atHome = false } = {}) {
    const name = bare(requested)
    if (cancelled() || !getInventory() || !Number.isSafeInteger(target) || target < 1) return pending('資材を準備するため、現在の所持品を再確認します。')
    // Unarmed, the begun mine section waits: going back down to finish it is how the sword was never made (live
    // 2026-11-26 05:14-05:52 JST: each 「石の剣を作ります」 asked for planks, this walked the Bot 140 m back to the
    // mine entrance for its section, and the sword step ended there; 4 logs, sticks and 74 cobblestone carried).
    // Keep the entire stone_sword dependency chain (including cobblestone/wooden_pickaxe when bare after respawn)
    // out of finishMineWork so MINE_UNARMED can never recurse infinitely (live 2026-11-27 21:41 JST).
    const makingSword = (activeAcquire.get('stone_sword') ?? 0) > 0
    if(name!=='food' && !mining.MINERALS.has(name) && (ctx.memory?.early?.mine?.branch?.vein || (!makingSword && !/^(?:stone_sword|cobblestone|wooden_pickaxe|crafting_table|planks|stick|log)$/.test(name)) || !require('./player-flee').unarmed(getInventory()))){
      const finishing=await mining.finishMineWork(ctx)
      if(finishing?.result?.code==='MINE_UNARMED' && !cancelled() && !makingSword)return acquire('stone_sword',1)
      if(finishing)return finishing
    }
    const plannedMining = mining.enabled(ctx) && runtime.raw().dimension === 'overworld' && mining.MINERALS.has(name)
    if (held(name) >= target) {
      if (plannedMining && ctx.memory?.early?.mine?.branch?.request?.resource === name) return mining.requestMine(ctx, { resource: name, targetHeld: target })
      return done(name + ' を持ち物で確認しました。')
    }
    if (name === 'food') {
      // Cooking raw meat with coal mines coal inside the planned branch mine.
      // Do not force leaving the mine via beforeSurfaceSupply while coal is
      // needed for cooking (live 2026-11-28 18:55-19:00 JST: shaft bounce loop).
      const items = rows()
      const rawMeat = items.find(i => /^minecraft:(?:beef|porkchop|chicken|rabbit|mutton|salmon|cod)$/.test(i.name ?? '') && i.count > 0)
      const wheatCount = items.filter(i => i.name === 'minecraft:wheat').reduce((n, i) => n + i.count, 0)
      const inMine = mining.enabled(ctx) && insideMine(ctx, ctx.memory?.early?.mine?.branch)
      if (inMine && rawMeat && wheatCount < 3 &&
          require('./cook-fuel').fuelWanted(items, Math.min(3, rawMeat.count, Math.max(1, target - held('food'))), ctx)?.name === 'coal') {
        return acquire('coal', 1)
      }
      return await mining.beforeSurfaceSupply(ctx) ?? provisionFood(ctx, target)
    }
    const recipe = ingredient[name], material = smelted[name]
    if (name === 'water_bucket') await fill(name)
    else if (name === 'planks') {
      const log = rows().find(i => matches('log', i))
      if (!log) await acquire('log', 1)
      else await bench.craftPlanks(log.name, 1, occupied(getInventory()) === 36 ? Math.min(log.count, 16) : 1)
    } else if (material) {
      const batch = mining.enabled(ctx) ? Math.max(1, Math.min(name === 'iron_ingot' ? 24 : 8, target - held(name))) : 1
      const plank = rows().find(i => matches('planks', i))
      const fuel = held('coal') ? 'minecraft:coal' : held('charcoal') ? 'minecraft:charcoal' : plank?.name
      // Read a nearby furnace before gathering: it may already hold the result,
      // the raw item or burning fuel from the interrupted previous look.
      // Once its shortage was received, let that gathering continue for up to a
      // minute without walking back to the same empty furnace every two seconds.
      // This is a next-step hint only; using the furnace always reads it anew.
      const gather = ctx.shared.dragonSmeltGather, at = (ctx.now ?? Date.now)(), dimension = runtime.raw()?.dimension
      const inMine = mining.enabled(ctx) && insideMine(ctx, ctx.memory?.early?.mine?.branch)
      const sameGather = gather?.name === name && gather.dimension === dimension && at >= gather.at && (gather.need.input > 0 && held(material) < (gather.inputGoal ?? 1) || gather.need.fuel && !fuel)
      const fetching = sameGather && (inMine || at - gather.at < 60000)
      const furnace = fetching ? null : await station('furnace', { existingOnly: !held(material) || !fuel })
      let need = fetching ? gather.need : null
      if (furnace && !cancelled()) {
        house.reset()
        const made = await house.smelt(furnace, full(material), batch, fuel, /coal$/.test(fuel ?? '') ? Math.ceil(batch / 8) : batch, full(name))
        if (made > 0 || cancelled() || !getInventory()) { delete ctx.shared.dragonSmeltGather; return held(name) >= target ? done(name + ' の所持数を確認しました。') : pending(name + ' の精錬後の所持数を確認します。') }
        need = house.smeltNeed()
        if (house.why()) trouble = 'かまど: ' + house.why()
        if (!need) return pending(trouble ?? 'かまどの受信を確認します。')
        ctx.shared.dragonSmeltGather = { name, dimension, at: (ctx.now ?? Date.now)(), need, inputGoal: held(material) + need.input }
      } else if (!fetching && sameGather) {
        // Away from any furnace when the 60s re-check expires: keep the furnace-measured
        // inputGoal instead of resetting to `batch` (which invalidated mine stockKey and
        // bounced between wood search and the shaft every 60s: live 2026-11-28 19:21-19:25 JST).
        need = gather.need
      }
      const inputGoal = (fetching || (!furnace && sameGather)) ? gather.inputGoal ?? 1 : need ? held(material) + need.input : batch
      if ((!need || need.input > 0) && held(material) < inputGoal) {
        // With no reusable furnace nearby, the batch is still a demand for
        // raw material. Keep that demand while the mine is underground;
        // seeing its first ore must not cause a new trip to look for a furnace.
        if(mining.enabled(ctx) && !fetching)ctx.shared.dragonSmeltGather={name,dimension,at: (ctx.now ?? Date.now)(),need:need??{input:inputGoal-held(material),fuel:!fuel},inputGoal}
        const input = await acquire(material, inputGoal)
        if (!input.done && input.result) return input
      }
      else if ((!need || need.fuel) && !fuel) {
        // Fuel: while already inside the planned branch mine, keep mining coal
        // underground instead of climbing out to gather planks (which bounced
        // back to coal as soon as surface coal ore entered view: live 2026-11-28 13:49-13:55 JST).
        const coalNear = inMine || inView(ctx, 'coal').length > 0
        const fuelResult = await acquire(coalNear ? 'coal' : 'planks', coalNear ? 1 : 2)
        if (!fuelResult.done && fuelResult.result) return fuelResult
      }
    } else if (recipe) {
      const times = atHome ? target - held(name) : 1
      const missing = Object.entries(recipe).find(([part, need]) => held(part) < need * times)
      if (missing) {
        if (atHome && missing[0] === 'iron_ingot') return { ...pending('必要な鉄をまとめて見積もり直します。'), replanIron: true }
        if (name === 'magma_cream' && missing[0] === 'slime_ball' && runtime.raw().dimension === 'nether') await collect(ctx, name)
        else {
          // Iron for the whole carried iron kit is asked for at once, not three or four ingots per piece: each piece
          // was its own trip down, a smelt and a craft (live 2026-11-28, the diamond stage asked iron_pickaxe ← 3,
          // then iron_leggings ← 4, iron_helmet ← 5, iron_boots ← 2, shield ← 1, and never reached the lower layer).
          const kitIron = missing[0] === 'iron_ingot' && mining.enabled(ctx) && name !== 'iron_pickaxe' && home.some(([item]) => item === name)
            ? home.reduce((sum, [item, amount]) => sum + (ingredient[item]?.iron_ingot ?? 0) * homeCarryNeed(item, amount, rows(), worn()), 0) : 0
          const input = await acquire(missing[0], Math.max(missing[1] * times, Math.min(24, kitIron)))
          if (!input.done && input.result) return input
        }
      } else if (small.has(name)) await bench.craftSmall(full(name), 1)
      else {
        const homeTable = atHome ? await homeIron.homeStation(ctx, 'table') : null
        if (homeTable && !homeTable.at) return homeTable
        const table = homeTable?.at ?? await station('crafting_table')
        if (table && !cancelled()) {
          // Equipment is unstackable, so each copy needs its own received slot.
          for (let index = 0; index < times && !cancelled(); index++) {
            if (!await bench.craftAtTable(table, full(name), 1)) break
          }
        }
      }
    } else if (pickFor[name] && !hasWorkingPick(rows(), pickFor[name])) {
      // Stone pickaxes are made three at a time while the parts are carried: one lasts about five minutes of corridor
      // and each was a climb to a table on the surface (live 2026-11-28 21:24-21:37 JST, a trip every five minutes).
      const pick = pickFor[name] + '_pickaxe', extra = pickFor[name] === 'stone' ? 3 : 1
      for (let made = 0; made < extra && !cancelled(); made++) {
        if (made > 0 && (held('cobblestone') < 3 || held('stick') < 2 && held('planks') < 2)) break
        const before = held(pick)
        await acquire(pick, before + 1)
        if (held(pick) <= before) break
      }
    } else if (pickFor[name] && digger()) {
      // Rock on the way to ore is dug with a stone pickaxe (dig-tool.js); the better one is kept for what needs it.
      // A look that brought it no nearer (no log, no stick made, no table put down) is a failed try; after three
      // it is left, and the digging goes on.
      await own('stone_pickaxe', digger(), WOOD, DIGGER_SAYS)
    } else if (plannedMining) {
      const out = await mining.requestMine(ctx, { resource: name, targetHeld: target })
      // If local carry-weapon gave up (no nearby tree) while armed-entry refuses
      // the mine, acquire a stone_sword through normal supply roaming so the Bot
      // does not deadlock on MINE_UNARMED (live 2026-11-27 20:06-20:30 JST).
      if (out?.result?.code === 'MINE_UNARMED' && !cancelled() && !makingSword) return acquire('stone_sword', 1)
      return out
    }
    else if (SOURCES[name] || MOBS[name]) {
      const returning = await mining.beforeSurfaceSupply(ctx)
      if (returning) return returning
      await collect(ctx, name)
    }
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
    if (take) return await box.withdraw(pos, slots => select(slots, name, amount, true), { aborted: cancelled })
    return await box.deposit(pos, select(rows(), name, amount, false), { aborted: cancelled })
  }
  async function bank (pos, item, amount, take) {
    const name = bare(item), slots = await inspect(pos)
    if (!slots) return pending('補給用のラージチェストを開き、54枠を確認します。')
    const observed = take ? held(name) : count(name, slots)
    if (observed >= amount) return done(name + ' の保管数・所持数を確認しました。')
    await moveStock(pos, name, amount - observed, take)
    return pending(name + ' の移動後の数量を確認します。')
  }
  async function reserve (pos, { mode, kit, keepReserve = false, partial = false } = {}) {
    const recovering = mode === 'recover', desired = kit === 'end' ? spare : home
    const slots = await inspect(pos)
    if (!slots) return unread ? { ...pending('予備のラージチェストの54枠を受信できません（' + unread + '）。'), unread } : pending('予備のラージチェスト54枠と持ち物を確認します。')
    // What the reserve chest holds, as received just now: part of what the goal has (dragon-goal-measure.js, read through dragon-reserve-seen.js).
    noteReserve(ctx.shared, pos, desired.map(([name]) => name), slots)
    if (!recovering && kit === 'home' && homeIron.enabled(ctx)) {
      const ironTarget = homeIron.homeIronTarget(slots, rows(), worn())
      if (held('iron_ingot') < ironTarget) return { ...pending('携行用と予備用の鉄をまとめて準備します。'), ironTarget }
    }
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
      // The last weapon in the bag never goes into the reserve: the Bot banked its only sword and died to a creeper with
      // no weapon at all (live 2026-11-26 22:40 JST, 「武器がないため敵から離れます」, the iron sword in the reserve chest).
      const weapons = rows().filter(row => /_sword$|_axe$/.test(String(row.name)) && !/_pickaxe$/.test(String(row.name))).reduce((sum, row) => sum + row.count, 0)
      const lastWeapon = !recovering && /_sword$/.test(name) ? Math.max(0, 1 - (weapons - carried)) : 0
      const available = Math.max(0, recovering ? inChest - (keepReserve ? amount : 0) : carried - Math.max(keep, lastWeapon))
      if (available < 1 && recovering && partial) continue
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
      // A move that moved nothing is said with its reason and counted: three in a row leave that thing for now (live
      // 2026-11-26 18:45-18:53 JST: 「food の予備装備の移動を確認します」 2,700 times in eight minutes, nothing moved, no reason).
      const trial = { stage: 'reserve-move', target: name, code: 'RESERVE_MOVE_NONE' }
      if (ctx.goal?.spent?.(trial)) continue
      const out = await moveStock(pos, name, Math.min(wanted, available), recovering)
      const movedNow = out?.progress?.confirmedTransferred ?? 0
      if (!movedNow && !cancelled()) {
        const noted = ctx.goal?.fail?.(trial, { paceMs: 10000 })
        if (noted?.exhausted) ctx.log?.('プレイヤーモード: ' + name + ' を予備チェストへ移せないため、ほかの装備を先に進めます（' + (out?.detail ?? out?.code ?? '理由不明') + '）')
        return pending(name + ' の予備装備を移せませんでした（' + (out?.detail ?? out?.code ?? '理由不明') + '）。')
      }
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
    const kit = kind === 'nether' ? nether
      : kind === 'reserve-end' ? combined(end, spare)
        : kind === 'reserve-end-compact' ? compactReserveKit(rows(), worn())
          : end
    for (const [name, need] of kit) {
      const equipped = count(name, worn()), carried = held(name)
      if (equipped + carried >= need) continue
      return { ...await acquire(name, need - equipped), done: false }
    }
    const wantedPotions = kind === 'reserve-end' || kind === 'reserve-end-compact' ? 8 : 4
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
  return { acquire, prepare, reserve, waterAt, weapon, arm, prepareHomeIron: batch => homeIron.prepareHomeIron(ctx, batch, { held, house, acquire }),
    store:(p,n,c) => bank(p,n,c,false), withdraw:(p,n,c) => bank(p,n,c,true), ...brewing }
}
module.exports = { createDragonSupplies }
