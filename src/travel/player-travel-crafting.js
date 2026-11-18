'use strict'

const { supplyScope } = require('../survival/supply-return')
const { inventoryReady } = require('../modes/player-workstations')

const TABLE = 'minecraft:crafting_table'
const LOG = /^minecraft:([a-z_]+)_log$/
const PLANK = /^minecraft:([a-z_]+)_planks$/
const failure = (code, message) => Object.assign(new Error(message), { code })
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// Player travel uses the normal guarded operations. The placement wrapper owns
// receipt registration, and the workstation service alone decides what may be
// reclaimed. Borrowing a visible table never grants permission to break it.
function createPlayerTravelCrafting (rt, { now = Date.now } = {}) {
  const stateNow = () => { const state = rt.working(); return { ...state, lifecycle: { ...(state.lifecycle ?? {}), deathId: rt.actualLifeId() } } }
  const items = () => stateNow().inventory?.items ?? []
  const amount = name => items().filter(item => item.name === name && item.count > 0).reduce((sum, item) => sum + item.count, 0)
  const carried = () => items().find(item => item.name === TABLE && item.count > 0 && item.slot >= 0 && item.slot < 36)
  const screen = () => (rt.crafting.status?.() ?? rt.crafting.snapshot()).openContainer ?? null
  function check (signal, scope = null) {
    const state = stateNow(), current = supplyScope(state)
    if (signal?.aborted || rt.disposed || rt.disposing || rt.host.shared.botMode !== 'player' || rt.host.shared.playerWanted !== true || !current || scope !== null && current !== scope || state.phase !== 'spawned' || state.dead || state.isDead || state.lifecycle?.dead || state.spawnPending || !(state.health > 0) || !state.position || !inventoryReady(state)) throw failure('PLAYER_TRAVEL_CRAFT_INTERRUPTED', '長距離移動の製作を中断しました。')
    rt.requireIdle()
    return state
  }
  function nearbyTable (signal, scope) {
    const state = check(signal, scope), p = state.position, x = Math.floor(p.x), y = Math.round(p.y - 1.62), z = Math.floor(p.z), found = []
    for (let dx = -4; dx <= 4; dx++) for (let dy = -3; dy <= 3; dy++) for (let dz = -4; dz <= 4; dz++) {
      const target = { x: x + dx, y: y + dy, z: z + dz }, block = rt.host.world.getBlock(target.x, target.y, target.z)
      if (block?.known !== true || block.name !== TABLE || block.extra?.length) continue
      if (rt.interactions.previewOpenCraftingTable(target)?.ready === true) found.push(target)
    }
    return found.sort((a, b) => Math.hypot(p.x - a.x - 0.5, p.y - a.y - 0.5, p.z - a.z - 0.5) - Math.hypot(p.x - b.x - 0.5, p.y - b.y - 0.5, p.z - b.z - 0.5))[0] ?? null
  }
  async function existingTable (signal, scope) {
    let nearby = nearbyTable(signal, scope)
    if (nearby || carried()) return nearby
    const pending = rt.operations.playerWorkstations.observe().recoverTable
    if (pending) {
      if (pending.type !== 'wait') await rt.operations.playerWorkstations.recoverAt(pending.target, { signal })
      check(signal, scope)
      nearby = nearbyTable(signal, scope)
      if (!nearby && !carried()) throw failure('PLAYER_TRAVEL_TABLE_PENDING', '作業台の回収が未確認のため、新しい台は作りません。')
    }
    return nearby
  }
  async function inScreen (open, work, signal, scope) {
    let owned = null
    try {
      check(signal, scope)
      await open()
      owned = structuredClone(screen())
      check(signal, scope)
      return await work()
    } finally {
      // A delayed cleanup cannot close a replacement operation's screen.
      try { check(signal, scope); if (owned && same(screen(), owned)) rt.operations.crafting.closeContainer() } catch {}
    }
  }
  const woods = () => [...new Set(items().flatMap(item => { const match = LOG.exec(item.name ?? '') ?? PLANK.exec(item.name ?? ''); return match ? [match[1]] : [] }))]
  const woodAvailable = wood => amount(`minecraft:${wood}_planks`) + amount(`minecraft:${wood}_log`) * 4
  async function makePlanks (needed, signal, scope, wood = null) {
    check(signal, scope)
    if (wood !== null) {
      const name = `minecraft:${wood}_planks`, missing = Math.max(0, needed - amount(name)), times = Math.ceil(missing / 4)
      if (times > amount(`minecraft:${wood}_log`)) throw failure('PLAYER_TRAVEL_NO_WOOD', '製作に必要な手持ちの木材が足りません。')
      if (times) { await rt.operations.crafting.craft(name, { times }); check(signal, scope) }
      if (amount(name) < needed) throw failure('PLAYER_TRAVEL_PLANKS_UNCONFIRMED', '板材の増加を受信した持ち物で確認できません。')
      return
    }
    let remaining = needed - items().filter(i => PLANK.test(i.name ?? '')).reduce((sum, i) => sum + i.count, 0)
    for (const log of items().filter(i => LOG.test(i.name ?? '') && i.count > 0).sort((a, b) => b.count - a.count)) {
      if (remaining <= 0) break
      const times = Math.min(log.count, Math.ceil(remaining / 4))
      await rt.operations.crafting.craft(`minecraft:${LOG.exec(log.name)[1]}_planks`, { times }); check(signal, scope)
      remaining = needed - items().filter(i => PLANK.test(i.name ?? '')).reduce((sum, i) => sum + i.count, 0)
    }
    if (remaining > 0) throw failure('PLAYER_TRAVEL_NO_WOOD', '製作に必要な手持ちの木材が足りません。')
  }
  async function placeTable (signal) {
    const scope = supplyScope(check(signal)), nearby = await existingTable(signal, scope)
    if (nearby) return nearby
    if (!carried()) await inScreen(() => rt.operations.crafting.openInventory(), async () => {
      await makePlanks(4, signal, scope)
      await rt.operations.crafting.craft(TABLE, { times: 1 }); check(signal, scope)
    }, signal, scope)
    let table = carried()
    if (!table) throw failure('PLAYER_TRAVEL_TABLE_UNCONFIRMED', '作業台を受信した持ち物で確認できません。')
    if (table.slot > 8) { await rt.operations.inventory.equip(table.slot); check(signal, scope); table = carried() }
    if (!table || table.slot > 8) throw failure('PLAYER_TRAVEL_TABLE_SLOT', '持参した作業台をホットバーで確認できません。')
    const p = check(signal, scope).position, x = Math.floor(p.x), y = Math.round(p.y - 1.62), z = Math.floor(p.z)
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      const position = { x: x + dx, y, z: z + dz }, data = { position, slot: table.slot }
      if (rt.operations.interactions.previewPlace(data)?.ready !== true) continue
      check(signal, scope)
      // A sent-but-unconfirmed placement is not retried at another position.
      const receipt = await rt.operations.interactions.placeCraftingTable(data)
      check(signal, scope)
      if (receipt?.phase !== 'completed' || receipt.confirmedBy !== 'server_block_and_inventory') throw failure('PLAYER_TRAVEL_TABLE_UNCONFIRMED', '作業台の設置をサーバーから確認できません。')
      return { ...receipt.position }
    }
    throw failure('PLAYER_TRAVEL_TABLE_SITE', '安全に作業台を設置できる場所がありません。')
  }
  async function craftAtTable (output, signal) {
    const scope = supplyScope(check(signal))
    let table = null
    try {
      table = await placeTable(signal)
      check(signal, scope)
      await inScreen(() => rt.operations.interactions.openCraftingTable(table), async () => {
        await rt.operations.crafting.craft(output, { times: 1 }); check(signal, scope)
      }, signal, scope)
      return { ok: amount(output) > 0, output }
    } finally {
      if (table) {
        try { check(signal, scope); await rt.operations.playerWorkstations.recoverAt(table, { signal }) } catch (error) { rt.host.log(`長距離移動: 作業台は回収待ちです: ${String(error.code ?? error.message).slice(0, 100)}`) }
      }
    }
  }
  async function makeBed (signal) {
    const scope = supplyScope(check(signal)), needsTable = !await existingTable(signal, scope) && !carried()
    await inScreen(() => rt.operations.crafting.openInventory(), () => makePlanks(3 + (needsTable ? 4 : 0), signal, scope), signal, scope)
    return craftAtTable('minecraft:bed', signal)
  }
  async function makeBoat (signal) {
    const scope = supplyScope(check(signal))
    if (items().some(i => /_boat$/.test(i.name ?? '') && i.count > 0)) return { ok: true, have: true }
    if (!rt.longTravelLogAllowance()) return { ok: false, reason: 'NO_ALLOWANCE' }
    const memo = rt.host.shared.travelBoatMemo ??= { lastTry: 0 }
    if (now() - memo.lastTry < 300000) return { ok: false, reason: 'RECENT' }
    memo.lastTry = now()
    const needsTable = !await existingTable(signal, scope) && !carried()
    let wood = woods().sort((a, b) => woodAvailable(b) - woodAvailable(a))[0]
    if (!wood || woodAvailable(wood) < 5) return { ok: false, reason: 'NO_WOOD' }
    // Reserve table material only when neither a nearby nor carried table is
    // available. Existing planks count before converting the missing logs.
    await inScreen(() => rt.operations.crafting.openInventory(), async () => {
      await makePlanks(5, signal, scope, wood)
      if (needsTable) {
        await makePlanks(9, signal, scope)
        // The ordinary table recipe may consume a different mix of planks.
        // Use its real allocation before promising five of one boat wood.
        for (let attempt = 0; attempt < 3; attempt++) {
          const plan = rt.operations.crafting.preview(TABLE, { times: 1 })
          if (plan?.ready !== true || !Array.isArray(plan.materials)) throw failure('PLAYER_TRAVEL_TABLE_MATERIALS', '作業台の材料を確認できません。')
          const consumed = value => plan.materials.filter(i => i.name === `minecraft:${value}_planks`).reduce((sum, i) => sum + i.count, 0)
          const choices = woods().filter(value => woodAvailable(value) - consumed(value) >= 5)
          wood = choices.sort((a, b) => amount(`minecraft:${b}_planks`) - consumed(b) - amount(`minecraft:${a}_planks`) + consumed(a))[0]
          if (!wood) throw failure('PLAYER_TRAVEL_NO_WOOD', '作業台を作ったあとに残る船の板材が足りません。')
          if (amount(`minecraft:${wood}_planks`) - consumed(wood) >= 5) break
          if (attempt === 2) throw failure('PLAYER_TRAVEL_TABLE_MATERIALS', '作業台と船の材料を同時に確保できません。')
          await makePlanks(5 + consumed(wood), signal, scope, wood)
        }
      }
    }, signal, scope)
    rt.host.log(`長距離移動: ボートを作ります（${wood}）`)
    return craftAtTable(`minecraft:${wood}_boat`, signal)
  }
  return { placeTable, makeBed, makeBoat }
}

module.exports = { createPlayerTravelCrafting }
