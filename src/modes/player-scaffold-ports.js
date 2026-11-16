'use strict'

// The scaffold's hands: ordinary walking, mining and placement through the
// runtime's operations. Every answer comes from received data: a mined cell
// is received air, a placed block a received solid block, the dirt count the
// received inventory, a walk the working position at the target.
const AIR = /^minecraft:(?:air|cave_air|void_air)$/
const DIRT = 'minecraft:dirt'
// What the climb may stand on: dirt first, then the cobblestone it mined on the way.
const FILL = [DIRT, 'minecraft:cobblestone', 'minecraft:cobbled_deepslate']

function createScaffoldPorts ({ operations, getBlock, getFeet, getInventory, getMotion, pillarStep, disposed = () => false, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now }) {
  const block = (x, y, z) => getBlock(x, y, z)
  const air = cell => { const found = block(cell.x, cell.y, cell.z); return found?.known === true && AIR.test(found.name ?? '') }
  const until = async (test, ms) => { const end = now() + ms; while (now() < end && !disposed()) { if (test()) return true; await sleep(200) } return test() }
  const stacks = () => (getInventory()?.items ?? []).filter(item => item?.name === DIRT && item.count > 0)
  const dirt = () => getInventory()?.known === true ? stacks().reduce((sum, item) => sum + item.count, 0) : 0

  const held = name => getInventory()?.known === true ? (getInventory().items ?? []).filter(item => item?.name === name && item.count > 0).reduce((sum, item) => sum + item.count, 0) : 0
  const fill = () => FILL.reduce((sum, name) => sum + held(name), 0)

  let why = null // the last refusal, for the log
  const refused = error => { why = String(error?.code ?? error?.message ?? error); return false }
  // A start refused only because the previous operation is still ending is
  // tried again for a few seconds (real Realm 2026-11-15: every scaffold job
  // began in the same millisecond as the autonomy's stop and was refused with
  // 「前の操作の終了処理を待ってください。」).
  const WAIT = /待って|待機|使用中|確認しています/
  async function begin (start) {
    const end = now() + 10000
    for (;;) {
      try { start(); return true } catch (error) {
        if (!WAIT.test(String(error?.message ?? '')) || now() >= end || disposed()) return refused(error)
        await sleep(300)
      }
    }
  }
  async function walk (target) {
    if (!await begin(() => operations.movement.start(target, { maxDistance: 16 }))) return false
    await sleep(300)
    await until(() => !['moving', 'settling'].includes(getMotion()?.phase), 12000)
    const at = getFeet()
    return !!at && Math.hypot(at.x - target.x, at.z - target.z) <= 0.45 && Math.abs(at.y - target.y) <= 0.2
  }
  // From farther than one walk reaches: hops of about ten blocks toward the
  // target over received ground (the walk itself plans at most 16 blocks; real
  // Realm 2026-11-15: 「Target lies outside the bounded search area」).
  const open = (x, y, z) => { const found = block(x, y, z); return found?.known === true && found.boundingBox !== 'block' }
  const standY = (x, z, near) => { for (let y = near + 4; y >= near - 6; y--) { const below = block(x, y - 1, z); if (below?.known === true && below.boundingBox === 'block' && open(x, y, z) && open(x, y + 1, z)) return y } return null }
  async function approach (target) {
    for (let hop = 0; hop < 10 && !disposed(); hop++) {
      const at = getFeet()
      if (!at) return false
      const dx = target.x - at.x, dz = target.z - at.z, far = Math.hypot(dx, dz)
      if (far <= 12) return true
      let moved = false
      for (const turn of [0, 0.5, -0.5, 1, -1]) {
        const angle = Math.atan2(dz, dx) + turn, x = Math.floor(at.x + Math.cos(angle) * 10), z = Math.floor(at.z + Math.sin(angle) * 10), y = standY(x, z, Math.floor(at.y + 0.001))
        if (y === null) continue
        await walk({ x: x + 0.5, y, z: z + 0.5 })
        const after = getFeet()
        if (after && Math.hypot(target.x - after.x, target.z - after.z) < far - 3) { moved = true; break }
      }
      if (!moved) return false
    }
    const at = getFeet()
    return !!at && Math.hypot(target.x - at.x, target.z - at.z) <= 12
  }
  const canMine = cell => { try { return operations.mining.preview([cell])?.ready === true } catch { return false } }
  // Why the mining preview refuses a cell, for the log.
  const reason = cell => { try { const preview = operations.mining.preview([cell]); return preview?.ready === true ? null : String(preview?.errors?.[0] ?? preview?.error ?? '').slice(0, 160) || null } catch (error) { return String(error?.message ?? error).slice(0, 160) } }
  async function mine (cell) {
    if (air(cell)) return true
    if (!await begin(() => operations.mining.start([cell]))) return false
    return until(() => air(cell), 35000)
  }
  // The pillar block under the feet: received air there, then the feet one lower.
  async function descend (cell) {
    const name = block(cell.x, cell.y, cell.z)?.name
    if (!await begin(() => operations.mining.start([{ ...cell, accessPreparation: 'pillar_descent', expectedName: name }]))) return false
    if (!await until(() => air(cell), 35000)) return false
    return until(() => { const at = getFeet(); return !!at && at.y <= cell.y + 0.05 }, 5000)
  }
  async function pillar (column, feetY, { any = false } = {}) {
    try {
      const material = any ? FILL.find(name => held(name) > 0) : DIRT
      const result = await pillarStep({ jobId: 'player-tree', operationId: `player-tree:${now()}:${feetY}`, column: { x: column.x, z: column.z }, feetY, ...(material && material !== DIRT ? { material } : {}) }, {})
      return result?.status === 'completed' && result.serverConfirmed === true ? { ok: true } : (why = result?.checkpoint?.diagnostics?.placementResponse?.reason ?? why, { ok: false, reason: result?.reason ?? 'BLOCKED' })
    } catch (error) { return { ok: false, reason: String(error?.code ?? error?.message ?? error) } }
  }
  async function place (cell) {
    let item = stacks().find(stack => stack.slot <= 8)
    if (!item && stacks().length) { try { await operations.inventory.equip(stacks()[0].slot) } catch { return false } item = stacks().find(stack => stack.slot <= 8) }
    if (!item) return false
    try { await operations.interactions.placeBlock({ position: cell, slot: item.slot }) } catch { return false }
    return until(() => { const found = block(cell.x, cell.y, cell.z); return found?.known === true && found.boundingBox === 'block' }, 5000)
  }
  // The pickaxe with the most uses left into the hand (the pillar step leaves
  // dirt there; real Realm 2026-11-16 06:41 JST: stone overhead was refused
  // with a sword in hand, 「適切なツルハシの装備を確認できません」).
  async function pick () {
    const picks = () => (getInventory()?.items ?? []).filter(item => /_pickaxe$/.test(item?.name ?? '') && item.count > 0 && item.durabilityKnown === true && item.durabilityRemaining > 2).sort((a, b) => b.durabilityRemaining - a.durabilityRemaining)
    const item = picks()[0]
    if (!item) return false
    // Through the inventory, into the slot the server has selected: a hotbar
    // selection alone is not confirmed by this server, and the mining check
    // then reads the old hand (real Realm 07:01 JST: refused with the wooden
    // pickaxe selected).
    try { if ((await operations.inventory.equip(item.slot))?.phase !== 'completed') return false } catch (error) { return refused(error) }
    await sleep(250)
    return true
  }
  return { feet: getFeet, block, dirt, fill, walk, approach, canMine, mine, descend, pillar, place, pick, reason, why: () => why }
}

module.exports = { createScaffoldPorts }
