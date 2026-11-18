'use strict'

// Player mode: a full inventory goes into a large chest beside the Bot. The
// planners only stopped on a full inventory (real Realm 2026-11-16 20:47 JST:
// 「持ち物が満杯です」 every second, 15 of the 36 slots stone; user:
// 「チェスト作る機能はないの？持ち物整理したり。チェストはもちろんラージチェストになるように優先してね」).
// - It starts when 34 or more of the 36 slots are taken and something can be
//   stored: stone and other building rubble beyond a reserve (64 cobblestone
//   and 32 dirt stay for pillars and floors), leaf litter, gravel, flint,
//   rotten flesh, and pickaxes with 2 or fewer uses when another pickaxe has
//   more. Diamonds, ores, coal, food, wood, working tools and weapons stay.
// - The chest: a large chest within 5 blocks with room is used first. A single
//   chest there is made large by a second one placed beside it. Otherwise two
//   chests are placed side by side (a large chest). Chests are made from held
//   planks or logs at a crafting table within reach, or a table made and
//   placed from held planks.
// - Every step counts only by received data: a craft by the received
//   inventory, a large chest by its received 54-slot window, a deposit by the received slots.
const { normalizeMode } = require('./bot-mode')
const { makeRoom, free } = require('./player-storage-room')
const { storable } = require('./player-storage-rubble')
const { discardJunk } = require('./player-discard')
const { createChestPairs } = require('./player-chest-pairs')
const { stands } = require('./house/house-steps')

const CHEST = 'minecraft:chest'
const TABLE = 'minecraft:crafting_table'
const AIR = /^minecraft:(?:air|cave_air|void_air|short_grass|fern|leaf_litter)$/
const START_AT = 34, NEAR = 5, AGAIN_MS = 60000

const occupied = inventory => new Set((inventory?.items ?? []).filter(item => item?.count > 0 && Number.isInteger(item.slot) && item.slot >= 0 && item.slot < 36).map(item => item.slot)).size

// The placed chest faces the player, opposite to the look used to place it.
// Use the received state, including the older Bedrock facing_direction form.
function chestLook (getBlock, at) {
  const block = getBlock(at.x, at.y, at.z)
  if (block?.known !== true || block.name !== CHEST) return null
  const properties = block.properties ?? {}, unwrap = value => value?.value ?? value
  const front = unwrap(properties['minecraft:cardinal_direction'] ?? properties.cardinal_direction) ?? ({ 2: 'north', 3: 'south', 4: 'west', 5: 'east' }[unwrap(properties.facing_direction)])
  return { north: 'south', south: 'north', west: 'east', east: 'west' }[front] ?? null
}

// Chests within reach: [{ position, pair: position|null }].
function chestsNear (getBlock, feet, near = NEAR) {
  const fx = Math.floor(feet.x), fy = Math.floor(feet.y + 0.05), fz = Math.floor(feet.z)
  const isChest = (x, y, z) => { const found = getBlock(x, y, z); return found?.known === true && found.name === CHEST }
  const found = []
  for (let dy = -2; dy <= 3; dy++) for (let dx = -near; dx <= near; dx++) for (let dz = -near; dz <= near; dz++) {
    const x = fx + dx, y = fy + dy, z = fz + dz
    if (!isChest(x, y, z)) continue
    const pair = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([ox, oz]) => ({ x: x + ox, y, z: z + oz })).find(p => isChest(p.x, p.y, p.z)) ?? null
    found.push({ position: { x, y, z }, pair })
  }
  return found.sort((a, b) => Number(!!b.pair) - Number(!!a.pair) || Math.hypot(a.position.x - fx, a.position.z - fz) - Math.hypot(b.position.x - fx, b.position.z - fz))
}

// A cell a chest can stand in: received air with received solid ground, not
// the Bot's own cells, beside the feet level.
function chestCell (getBlock, feet, cell) {
  const fx = Math.floor(feet.x), fy = Math.floor(feet.y + 0.05), fz = Math.floor(feet.z)
  if (cell.x === fx && cell.z === fz) return false
  if (Math.abs(cell.y - fy) > 1 || Math.hypot(cell.x + 0.5 - feet.x, cell.z + 0.5 - feet.z) > 3.5) return false
  const here = getBlock(cell.x, cell.y, cell.z), below = getBlock(cell.x, cell.y - 1, cell.z)
  return here?.known === true && AIR.test(here.name ?? '') && !here.extra?.length && below?.known === true && below.boundingBox === 'block' && !/chest|crafting_table|furnace|leaves|sand$|gravel$/.test(below.name ?? '')
}

// Two cells side by side for a new large chest, or one beside a single chest.
function chestCells (getBlock, feet, single = null, skip = new Set()) {
  const ok = cell => !skip.has(`${cell.x},${cell.y},${cell.z}`) && chestCell(getBlock, feet, cell)
  const fx = Math.floor(feet.x), fy = Math.floor(feet.y + 0.05), fz = Math.floor(feet.z)
  const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  const facing = cell => {
    const dx = cell.x + 0.5 - feet.x, dz = cell.z + 0.5 - feet.z
    // Avoid the 45-degree boundary where the two clicks can select different facings.
    if (Math.abs(Math.abs(dx) - Math.abs(dz)) < 0.05) return null
    return Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 'east' : 'west') : (dz > 0 ? 'south' : 'north')
  }
  const isolated = (cell, mate) => SIDES.every(([dx, dz]) => {
    const at = { x: cell.x + dx, y: cell.y, z: cell.z + dz }
    return at.x === mate.x && at.z === mate.z || getBlock(at.x, at.y, at.z)?.name !== CHEST
  })
  if (single) {
    const look = chestLook(getBlock, single), sides = /east|west/.test(look ?? '') ? [[0, 1], [0, -1]] : [[1, 0], [-1, 0]]
    if (!look || facing(single) !== look) return []
    return sides.map(([dx, dz]) => ({ x: single.x + dx, y: single.y, z: single.z + dz })).filter(cell => ok(cell) && look && facing(cell) === look && isolated(cell, single)).slice(0, 1)
  }
  for (const dy of [0, -1, 1]) for (const [dx, dz] of [...SIDES.map(([x, z]) => [x * 2, z * 2]), ...SIDES, [2, 1], [2, -1], [-2, 1], [-2, -1], [1, 2], [-1, 2], [1, -2], [-1, -2]]) {
    const first = { x: fx + dx, y: fy + dy, z: fz + dz }
    if (!ok(first)) continue
    // The pair runs across the line of sight so both are placed facing the Bot.
    const along = Math.abs(dx) >= Math.abs(dz) ? [0, 1] : [1, 0]
    for (const sign of [1, -1]) {
      const second = { x: first.x + along[0] * sign, y: first.y, z: first.z + along[1] * sign }
      if (ok(second) && facing(first) && facing(second) === facing(first) && isolated(first, second) && isolated(second, first)) return [first, second]
    }
  }
  return []
}

function createPlayerStorage ({ getMode, shared, agent, hands, mine = null, dig = null, why = () => null, walk = null, cells = () => null, getBlock, getFeet, getInventory, worldScope = () => null, file = null, write, blocked = () => false, disposed = () => false, log = () => {}, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  let busy = false, waitUntil = 0, stored = 0
  const live = () => !disposed() && normalizeMode(getMode()) === 'player' && shared.playerWanted === true
  const restart = async () => { for (let attempt = 0; attempt < 5 && live(); attempt++) { try { await agent.start({ ...agent.objective }); return true } catch { await sleep(2000) } } return false }
  const settle = async () => { for (let i = 0; i < 40 && agent.settled?.() === false && !disposed(); i++) await sleep(200) }
  const held = name => (getInventory()?.items ?? []).filter(item => item?.name === name && item.count > 0).reduce((sum, item) => sum + item.count, 0)
  const say = text => log(`プレイヤーモード: ${text}`)
  const pairs = createChestPairs({ shared, worldScope, getBlock, file, write, say })
  const recoverTables = async () => { try { await hands.recoverTables?.() } catch (error) { say(`作業台の回収を保留しました ${String(error?.message ?? error).slice(0, 120)}`) } }

  // Enough held chests, or planks and logs for the missing ones and a table.
  function woodFor (needed) {
    const items = getInventory()?.items ?? []
    const want = needed - held(CHEST)
    if (want <= 0) return true
    const planks = items.filter(item => /_planks$/.test(item?.name ?? '')).reduce((sum, item) => sum + item.count, 0)
    const logs = items.filter(item => /_(?:log|stem|wood|hyphae)$/.test(item?.name ?? '') && !/stripped/.test(item.name)).reduce((sum, item) => sum + item.count, 0)
    return planks + 4 * logs >= want * 8 + (hands.tableNear() || held(TABLE) ? 0 : 4)
  }

  // A material gate only; ensure() still opens the resulting container and
  // requires 54 received slots before returning its position.
  function canMakeChest () {
    if (!pairs.ready()) return false
    const feet = getFeet()
    const nearby = feet ? chestsNear(getBlock, feet).filter(chest => hands.room(chest.position) !== 0 && !(chest.pair && hands.room(chest.pair) === 0)) : []
    return nearby.some(chest => !!chest.pair) || woodFor(nearby.some(chest => !chest.pair) ? 1 : 2)
  }

  // Chests held, made at a table from planks (logs are cut into planks first).
  async function makeChests (needed, avoid = [], aborted = () => !live()) {
    if (aborted()) return false
    const planks = () => (getInventory()?.items ?? []).filter(item => /_planks$/.test(item?.name ?? '') && item.count > 0).reduce((sum, item) => sum + item.count, 0)
    const logs = () => (getInventory()?.items ?? []).filter(item => /_(?:log|stem|wood|hyphae)$/.test(item?.name ?? '') && !/stripped/.test(item.name) && item.count > 0)
    const want = needed - held(CHEST)
    if (want <= 0) return true
    // A craft needs an empty slot for its result.
    if (!await makeRoom({ hands, getBlock, getFeet, getInventory, avoid, say, mine, dig, why }) || aborted()) return false
    const table = hands.tableNear()
    const plankNeed = want * 8 + (table ? 0 : held(TABLE) ? 0 : 4)
    for (let step = 0; step < 4 && planks() < plankNeed && logs().length; step++) {
      // With one empty slot the whole log stack is cut, so its slot is freed for the next craft.
      const log = logs()[0], times = free(getInventory()) <= 1 ? log.count : Math.min(log.count, Math.ceil((plankNeed - planks()) / 4))
      if (!await hands.craftPlanks(log.name, times)) { say(`原木から板材を作れません（${log.name.replace('minecraft:', '')} ${times} 本）`); break }
      if (aborted()) return false
    }
    if (planks() < plankNeed) { say(`チェストを作る板材が足りません（板材 ${planks()}・原木 ${logs().reduce((sum, item) => sum + item.count, 0)}・必要 板材 ${plankNeed}）`); return false }
    let at = table
    if (!at) {
      if (!held(TABLE) && !await hands.craftSmall(TABLE)) { say('作業台を作れません'); return false }
      if (aborted()) return false
      at = await hands.placeTable()
      if (!at) { say('作業台を置けません'); return false }
    }
    if (aborted()) return false
    if (!await hands.craftAtTable(at, CHEST, want)) { say('チェストを作れません'); return false }
    return !aborted() && held(CHEST) >= needed
  }

  // A large chest beside the Bot (or one already there): its position, true
  // when junk was thrown away instead (discard), or null.
  // full: chest cells known full (the base's), skipped with their pairs; avoid:
  // cells no new chest stands in (the path to the house door).
  async function ensure (discard = false, { full = [], avoid = [], aborted = () => false } = {}) {
    const startingWorld = worldScope()
    const stopped = () => !live() || aborted() || worldScope() !== startingWorld
    const feet = getFeet()
    if (stopped() || !feet || !pairs.ready()) return null
    if (!await pairs.observe() || stopped()) return null
    const key = p => `${p.x},${p.y},${p.z}`, fullSet = new Set(full.map(key))
    const chests = chestsNear(getBlock, feet).filter(chest => !fullSet.has(key(chest.position)) && !(chest.pair && fullSet.has(key(chest.pair))))
    const roomy = chest => hands.room(chest.position) !== 0 && !(chest.pair && hands.room(chest.pair) === 0)
    const inspect = async position => {
      if (stopped() || !hands.inspect) return null
      const out = await hands.inspect(position, { aborted: stopped })
      return !stopped() && out?.status === 'completed' ? out.evidence : null
    }
    const placeChest = async position => {
      if (stopped() || !await pairs.attempt(position)) return { placed: false, retrySafe: false }
      // This controller knows nothing was submitted if it was stopped while
      // the durable intent was being written.
      if (stopped()) { await pairs.retry(position); return { placed: false, retrySafe: true } }
      const placed = await hands.place(position, CHEST)
      const block = getBlock(position.x, position.y, position.z)
      if (block?.known === true && block.name === CHEST) { const recorded = await pairs.received(position); return { placed: placed && recorded, retrySafe: false } }
      const retrySafe = hands.placementRetrySafe?.() === true && await pairs.retry(position)
      return { placed: false, retrySafe }
    }
    const besideSingle = async single => {
      const skip = new Set(avoid.map(key))
      // Resume the recorded partner, including a house blueprint's fixed
      // cell; do not silently change the intended pair after an interruption.
      const reserved = pairs.unfinished().find(entry => entry.cells.some(at => key(at) === key(single)))
      const mate = reserved?.cells.find(at => key(at) !== key(single))
      if (mate) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const at = { x: single.x + dx, y: single.y, z: single.z + dz }
        if (key(at) !== key(mate)) skip.add(key(at))
      }
      const current = () => chestCells(getBlock, getFeet() ?? feet, single, skip)
      if (current().length) return current()
      const look = chestLook(getBlock, single)
      if (!look) { say('既存チェストの向きを受信できていないため、2つ目の設置を保留しました'); return [] }
      if (!walk || stopped()) return []
      const click = { clicked: { ...single, y: single.y - 1 }, face: 1, clickY: null }
      const choices = stands(getBlock, { position: single, item: 'chest', look }, click, getFeet() ?? feet).filter(stand => chestCells(getBlock, stand, single, skip).length)
      for (const stand of choices.slice(0, 3)) {
        if (stopped()) return []
        if (await walk(stand) && !stopped() && current().length) return current()
      }
      return []
    }
    // Adjacent blocks are candidates, not proof of a joined container. Its
    // complete 54-slot window must have arrived from the server.
    let single = null, unconfirmed = false
    const seen = new Set()
    for (const candidate of chests.filter(roomy)) {
      if (seen.has(key(candidate.position))) continue
      seen.add(key(candidate.position))
      if (candidate.pair) seen.add(key(candidate.pair))
      const evidence = await inspect(candidate.position)
      if (stopped()) return null
      if (evidence?.slotCount === 54) {
        if (!await pairs.complete(candidate.position) || stopped()) return null
        if (evidence.room !== 0) return candidate.position
      } else if (!candidate.pair && evidence?.slotCount === 27) { if (!single || pairs.pending(candidate.position)) single = candidate }
      else unconfirmed = true
    }
    // Leave an unconfirmed pair for the next inspection. Adding a third box
    // or making another pair would consume wood without resolving this one.
    if (unconfirmed && !single) { say('ラージチェストの54枠を受信できないため、設置済みのチェストを確認待ちにしました'); return null }
    // A previous send may have succeeded even while the old air is still in
    // the world cache. Inventory resync and a new controller do not prove it
    // was rejected. Only a received chest or an explicit no-send clears that.
    if (pairs.waiting()) { say('送信済みチェストのブロック受信を待っています。重複して設置しません'); return null }
    const unfinished = pairs.unfinished()
    if (unfinished.length && single && !pairs.pending(single.position)) single = null
    const reserved = !single ? unfinished.find(entry => entry.stages?.every(stage => stage === 'reserved') && entry.cells.every(at => chestCell(getBlock, feet, at)))?.cells : null
    if (unfinished.length && !single && !reserved) return null
    if (discard && hands.drop && !woodFor(single ? 1 : 2) && await discardJunk({ drop: hands.drop, walk, why, cells, getInventory, getFeet, shared, say, now })) return true
    if (single) {
      let cells = await besideSingle(single.position)
      if (!cells.length || !await makeChests(1, cells, stopped) || stopped()) return null
      cells = await besideSingle(single.position)
      if (!cells.length) return null
      if (!await pairs.begin([single.position, cells[0]]) || stopped()) return null
      if (!(await placeChest(cells[0])).placed || stopped()) return null
      if ((await inspect(single.position))?.slotCount !== 54) { say('2つ目のチェストを置きましたが、ラージチェストの54枠は未確認です'); return null }
      if (!await pairs.complete(single.position) || stopped()) return null
      say(`ラージチェストにしました (${single.position.x}, ${single.position.y}, ${single.position.z})`)
      return single.position
    }
    const skip = new Set(avoid.map(key))
    let pair = reserved ?? chestCells(getBlock, feet, null, skip)
    if (pair.length !== 2) { say('ラージチェストを置ける平らな場所がありません'); return null }
    // Hold both before starting. A half left by interruption is found above
    // and needs only the missing chest when this work resumes.
    if (!await makeChests(2, pair, stopped) || stopped()) return null
    pair = reserved ?? chestCells(getBlock, getFeet() ?? feet, null, skip)
    for (let attempt = 0; attempt < 3 && pair.length === 2 && !stopped(); attempt++) {
      if (!await pairs.begin(pair) || stopped()) return null
      const first = await placeChest(pair[0])
      if (first.placed) {
        if (stopped()) return null
        // The first received block determines the second's facing too. A
        // correction or knockback between the two placements must not turn
        // the second chest sideways and leave two separate containers.
        const beside = await besideSingle(pair[0])
        if (!beside.length || stopped()) return null
        if (key(beside[0]) !== key(pair[1])) {
          pair = [pair[0], beside[0]]
          if (!await pairs.begin(pair) || stopped()) return null
        }
        if (!(await placeChest(pair[1])).placed) { say(`チェストの2つ目を置けません (${pair[1].x}, ${pair[1].y}, ${pair[1].z}) ${hands.refusal?.() ?? ''}`.trim()); return null }
        if (stopped() || (await inspect(pair[0]))?.slotCount !== 54) { say('チェストを2つ置きましたが、ラージチェストの54枠は未確認です'); return null }
        if (!await pairs.complete(pair[0]) || stopped()) return null
        say(`ラージチェストを置きました (${pair[0].x}, ${pair[0].y}, ${pair[0].z})`)
        return pair[0]
      }
      if (stopped() || getBlock(pair[0].x, pair[0].y, pair[0].z)?.name === CHEST) return null
      if (!first.retrySafe || !pair.every(at => { const block = getBlock(at.x, at.y, at.z); return block?.known === true && AIR.test(block.name) }) || !await pairs.complete(pair[0])) return null
      say(`チェストを置けません (${pair[0].x}, ${pair[0].y}, ${pair[0].z}) ${hands.refusal?.() ?? ''}`.trim())
      skip.add(key(pair[0]))
      pair = chestCells(getBlock, getFeet() ?? feet, null, skip)
    }
    return null
  }

  async function run () {
    const got = await ensure(true)
    if (got === true) return true
    // No chest could be made or placed (no flat cells, table refused): the
    // rubble is thrown away too, wood or not (live 2026-11-17 05:12-05:24 JST
    // on a hilltop with 37 logs: 「ラージチェストを置ける平らな場所がありません」
    // and 「作業台を置けません」, 35-36/36 slots for ten minutes).
    if (!got) return !!hands.drop && await discardJunk({ drop: hands.drop, walk, why, cells, getInventory, getFeet, shared, say, now }) > 0
    const target = { position: got }
    const moved = await hands.store(target.position, storable(getInventory()))
    stored += moved
    say(`チェスト (${target.position.x}, ${target.position.y}, ${target.position.z}) に ${moved} 個しまいました（持ち物 ${occupied(getInventory())}/36 枠）`)
    return moved > 0
  }

  // Why a full inventory is not being stored, once a minute (live 23:37-23:42
  // JST: 36/36 slots and no storage line at all for five minutes).
  let quietSince = null, quietSaid = 0
  function quiet (why) {
    if (!why) { quietSince = null; return null }
    quietSince ??= now()
    if (now() - quietSince >= 60000 && now() - quietSaid >= 60000) { quietSaid = now(); say(`持ち物が満杯ですが、しまう処理を始めていません（${why}）`) }
    return null
  }

  async function tick () {
    if (!live()) return null
    const inventory = getInventory(), feet = getFeet()
    const full = (inventory && occupied(inventory) >= START_AT) || (getInventory() == null && shared.inventoryUncertain)
    if (busy) return full ? quiet('前のしまう処理が終わっていません') : null
    if (blocked()) return full ? quiet('別の作業中か、12m以内に敵がいます') : quiet(null)
    if (now() < waitUntil) return null
    if (!inventory) return quiet(shared.inventoryUncertain ? '持ち物が未確定です' : null)
    if (!feet || occupied(inventory) < START_AT) return quiet(null)
    if (!storable(inventory).length) return quiet('しまえる物がありません')
    quiet(null)
    busy = true
    let ok = false
    try {
      say(`持ち物が ${occupied(inventory)}/36 枠のため、チェストにしまいます。`)
      agent.stop('持ち物をチェストにしまっています。')
      await settle()
      ok = await run()
      return ok
    } catch (error) {
      say(`チェストにしまえません ${String(error?.message ?? error).slice(0, 120)}`)
      return false
    } finally {
      await recoverTables()
      waitUntil = now() + (ok ? 5000 : AGAIN_MS)
      busy = false
      await restart()
    }
  }

  // The base's large chest (player-base.js), made like the storage chest.
  async function chest (options = {}) { if (busy) return null; busy = true; try { const got = await ensure(false, options); return got && got !== true ? got : null } finally { await recoverTables(); busy = false } }

  return { tick, chest, woodFor, canMakeChest, pendingChest: pairs.pending, chestWork: pairs, status: () => ({ active: busy, reason: busy ? '持ち物をチェストにしまっています。' : null, stored }) }
}

module.exports = { createPlayerStorage, storable, chestsNear, chestCells, occupied, START_AT }
