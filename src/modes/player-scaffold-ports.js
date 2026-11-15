'use strict'

// The scaffold's hands: ordinary walking, mining and placement through the
// runtime's operations. Every answer comes from received data: a mined cell
// is received air, a placed block a received solid block, the dirt count the
// received inventory, a walk the working position at the target.
const AIR = /^minecraft:(?:air|cave_air|void_air)$/
const DIRT = 'minecraft:dirt'

function createScaffoldPorts ({ operations, getBlock, getFeet, getInventory, getMotion, pillarStep, disposed = () => false, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now }) {
  const block = (x, y, z) => getBlock(x, y, z)
  const air = cell => { const found = block(cell.x, cell.y, cell.z); return found?.known === true && AIR.test(found.name ?? '') }
  const until = async (test, ms) => { const end = now() + ms; while (now() < end && !disposed()) { if (test()) return true; await sleep(200) } return test() }
  const stacks = () => (getInventory()?.items ?? []).filter(item => item?.name === DIRT && item.count > 0)
  const dirt = () => getInventory()?.known === true ? stacks().reduce((sum, item) => sum + item.count, 0) : 0

  let why = null // the last refusal, for the log
  const refused = error => { why = String(error?.code ?? error?.message ?? error); return false }
  async function walk (target) {
    try { operations.movement.start(target, { maxDistance: 16 }) } catch (error) { return refused(error) }
    await sleep(300)
    await until(() => !['moving', 'settling'].includes(getMotion()?.phase), 12000)
    const at = getFeet()
    return !!at && Math.hypot(at.x - target.x, at.z - target.z) <= 0.45 && Math.abs(at.y - target.y) <= 0.2
  }
  const canMine = cell => { try { return operations.mining.preview([cell])?.ready === true } catch { return false } }
  async function mine (cell) {
    if (air(cell)) return true
    try { operations.mining.start([cell]) } catch (error) { return refused(error) }
    return until(() => air(cell), 35000)
  }
  // The pillar block under the feet: received air there, then the feet one lower.
  async function descend (cell) {
    const name = block(cell.x, cell.y, cell.z)?.name
    try { operations.mining.start([{ ...cell, accessPreparation: 'pillar_descent', expectedName: name }]) } catch { return false }
    if (!await until(() => air(cell), 35000)) return false
    return until(() => { const at = getFeet(); return !!at && at.y <= cell.y + 0.05 }, 5000)
  }
  async function pillar (column, feetY) {
    try {
      const result = await pillarStep({ jobId: 'player-tree', operationId: `player-tree:${now()}:${feetY}`, column: { x: column.x, z: column.z }, feetY }, {})
      return result?.status === 'completed' && result.serverConfirmed === true ? { ok: true } : { ok: false, reason: result?.reason ?? 'BLOCKED' }
    } catch (error) { return { ok: false, reason: String(error?.code ?? error?.message ?? error) } }
  }
  async function place (cell) {
    let item = stacks().find(stack => stack.slot <= 8)
    if (!item && stacks().length) { try { await operations.inventory.equip(stacks()[0].slot) } catch { return false } item = stacks().find(stack => stack.slot <= 8) }
    if (!item) return false
    try { await operations.interactions.placeBlock({ position: cell, slot: item.slot }) } catch { return false }
    return until(() => { const found = block(cell.x, cell.y, cell.z); return found?.known === true && found.boundingBox === 'block' }, 5000)
  }
  return { feet: getFeet, block, dirt, walk, canMine, mine, descend, pillar, place, why: () => why }
}

module.exports = { createScaffoldPorts }
