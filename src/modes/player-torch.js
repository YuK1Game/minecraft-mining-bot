'use strict'

// Player mode: light the way underground so that nothing spawns behind the Bot
// (user 2026-11-16 08:04 JST: 「ちゃんとたいまつで湧き潰ししながら進むように
// してほしい」). While the Bot plays under received solid ground and no torch
// stands within eight blocks, the autonomy is stopped for a moment, torches
// are crafted when none is held (one coal and one stick give four; coal for
// smelting and sticks for the next pickaxe stay), one torch is placed on the
// floor beside the feet by the ordinary placement, and play goes on. A torch
// counts as placed only as a received torch block. A torch lights 13 blocks
// around it, so one every eight leaves no dark floor in a tunnel.
const { normalizeMode } = require('./bot-mode')
const { underCover } = require('./player-surface')

const TORCH = 'minecraft:torch'
const AIR = /^minecraft:(?:air|cave_air|void_air)$/
const LIT = /(?:^|:)(?:torch|soul_torch|lantern|glowstone|lava|flowing_lava|lit_furnace)$/
const NEAR = 8
const KEEP_COAL = 2
const KEEP_STICKS = 2
const AGAIN_MS = 20000
const FAILED_MS = 60000

// Whether a received light stands within NEAR blocks (taxicab) of the feet cell.
function torchNear (getBlock, feet, near = NEAR) {
  const fx = Math.floor(feet.x), fy = Math.floor(feet.y + 0.001), fz = Math.floor(feet.z)
  for (let dy = -3; dy <= 4; dy++) for (let dx = -near; dx <= near; dx++) for (let dz = -near; dz <= near; dz++) {
    if (Math.abs(dx) + Math.abs(dz) + Math.abs(dy) > near) continue
    const block = getBlock(fx + dx, fy + dy, fz + dz)
    if (block?.known === true && LIT.test(block.name ?? '')) return true
  }
  return false
}

// Floor cells beside the feet where a torch can stand: received air on a received full block.
// heading: where the Bot is going ({x,y,z}); spots behind it come first, since
// a torch in the next cell of a tunnel is mined away again and picked back up
// (live 2026-11-18 02:18-02:19 JST: eight torches in a row, 「残り 2 本」 each time).
function torchSpots (getBlock, feet, heading = null) {
  const fx = Math.floor(feet.x), fy = Math.floor(feet.y + 0.001), fz = Math.floor(feet.z)
  const spots = []
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) for (const dy of [0, 1, -1]) {
    const cell = { x: fx + dx, y: fy + dy, z: fz + dz }, here = getBlock(cell.x, cell.y, cell.z), below = getBlock(cell.x, cell.y - 1, cell.z)
    if (here?.known === true && AIR.test(here.name ?? '') && !here.extra?.length && below?.known === true && below.boundingBox === 'block' && !/leaves|sand$|gravel$|crafting_table|furnace|chest/.test(below.name ?? '')) { spots.push(cell); break }
  }
  if (!heading) return spots
  const ahead = cell => (cell.x + 0.5 - feet.x) * heading.x + (cell.y - feet.y) * heading.y + (cell.z + 0.5 - feet.z) * heading.z
  return spots.map((cell, index) => ({ cell, index, ahead: ahead(cell) })).sort((a, b) => a.ahead - b.ahead || a.index - b.index).map(entry => entry.cell)
}

// What can be done with the held items: 'place', 'craft' (a torch recipe), 'sticks' (sticks from planks first) or null.
function torchSupply (inventory) {
  if (inventory?.known !== true) return null
  const count = test => (inventory.items ?? []).filter(item => item?.count > 0 && test.test(item.name ?? '')).reduce((sum, item) => sum + item.count, 0)
  if (count(/^minecraft:torch$/) > 0) return 'place'
  if (count(/^minecraft:(?:coal|charcoal)$/) <= KEEP_COAL) return null
  if (count(/^minecraft:stick$/) > KEEP_STICKS) return 'craft'
  return count(/_planks$/) >= 2 && count(/_planks$/) !== 4 ? 'sticks' : null // four planks are the next crafting table
}

// hands: { craft(output) -> bool, place(cell) -> bool } on the runtime's ordinary operations.
function createPlayerTorch ({ getMode, shared, agent, hands, getBlock, getFeet, getInventory, blocked = () => false, disposed = () => false, log = () => {}, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  let busy = false, waitUntil = 0, placed = 0
  const trail = [], lost = new Set()
  // Where the Bot is heading: from a spot at least three blocks back on its trail.
  function headingNow (feet) {
    const last = trail.at(-1)
    if (!last || Math.hypot(feet.x - last.x, feet.y - last.y, feet.z - last.z) >= 1) { trail.push({ x: feet.x, y: feet.y, z: feet.z }); if (trail.length > 12) trail.shift() }
    const from = trail.find(point => Math.hypot(feet.x - point.x, feet.y - point.y, feet.z - point.z) >= 3) ?? trail[0]
    const vector = { x: feet.x - from.x, y: feet.y - from.y, z: feet.z - from.z }
    return Math.hypot(vector.x, vector.y, vector.z) >= 1 ? vector : null
  }
  const live = () => !disposed() && normalizeMode(getMode()) === 'player' && shared.playerWanted === true
  const restart = async () => { for (let attempt = 0; attempt < 5 && live(); attempt++) { try { await agent.start({ ...agent.objective }); return true } catch { await sleep(2000) } } return false }
  const settle = async () => { for (let i = 0; i < 40 && agent.settled?.() === false && !disposed(); i++) await sleep(200) }
  const torches = () => (getInventory()?.items ?? []).filter(item => item?.name === TORCH && item.count > 0).reduce((sum, item) => sum + item.count, 0)

  async function tick () {
    if (busy || !live() || blocked() || now() < waitUntil || agent.running?.() !== true) return null
    const feet = getFeet()
    const heading = feet ? headingNow(feet) : null
    const spotsFor = at => torchSpots(getBlock, at, heading).filter(cell => !lost.has(`${cell.x},${cell.y},${cell.z}`))
    if (!feet || !underCover(getBlock, { x: feet.x, y: feet.y + 1.62, z: feet.z }) || torchNear(getBlock, feet)) return null
    if (!torchSupply(getInventory()) || !spotsFor(feet).length) { waitUntil = now() + AGAIN_MS; return null }
    busy = true
    let ok = false
    try {
      agent.stop('松明を置いています。')
      await settle()
      for (let step = 0; step < 3 && live() && torches() < 1; step++) {
        const supply = torchSupply(getInventory())
        if (supply !== 'craft' && supply !== 'sticks') break
        if (!await hands.craft(supply === 'sticks' ? 'minecraft:stick' : TORCH)) break
      }
      if (torches() > 0) for (const cell of spotsFor(getFeet() ?? feet).slice(0, 3)) {
        if (!live()) break
        if (await hands.place(cell)) {
          ok = true; placed++; log(`プレイヤーモード: 松明を置きました (${cell.x}, ${cell.y}, ${cell.z})（残り ${torches()} 本）`)
          // A torch that does not stay (mined away, or its floor dug out) is not placed there again.
          await sleep(2000)
          const now_ = getBlock(cell.x, cell.y, cell.z)
          if (now_?.known === true && now_.name !== TORCH) { lost.add(`${cell.x},${cell.y},${cell.z}`); ok = false; log(`プレイヤーモード: 置いた松明が残っていません (${cell.x}, ${cell.y}, ${cell.z})`) }
          break
        }
      }
      if (!ok) log(`プレイヤーモード: 松明を置けませんでした（松明 ${torches()} 本）`)
      return ok
    } catch (error) {
      log(`プレイヤーモード: 松明の処理に失敗 ${String(error?.message ?? error).slice(0, 120)}`)
      return false
    } finally {
      waitUntil = now() + (ok ? AGAIN_MS / 4 : FAILED_MS)
      busy = false
      await restart()
    }
  }

  return { tick, status: () => ({ active: busy, reason: busy ? '松明を置いています。' : null, placed }) }
}

module.exports = { createPlayerTorch, torchNear, torchSpots, torchSupply, NEAR }
