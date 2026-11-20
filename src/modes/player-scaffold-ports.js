'use strict'

// The scaffold's hands: ordinary walking, mining and placement through the
// runtime's operations. Every answer comes from received data: a mined cell
// is received air, a placed block a received solid block, the dirt count the
// received inventory, a walk the working position at the target.
const AIR = /^minecraft:(?:air|cave_air|void_air)$/
const DIRT = 'minecraft:dirt'
// What the climb may stand on: dirt first, then the cobblestone it mined on the way.
const FILL = [DIRT, 'minecraft:cobblestone', 'minecraft:cobbled_deepslate']
const { low, offGrid } = require('./low-block')
const { onRim, footings } = require('./ledge-footing')
const { digTool, toolNeeded } = require('./dig-tool')
const { toolOf } = require('../quarry/quarry-rules')

function createScaffoldPorts ({ operations, getBlock, getFeet, getInventory, getMotion, getHealth = () => null, getHeld = () => null, pillarStep, disposed = () => false, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now }) {
  const block = (x, y, z) => getBlock(x, y, z)
  const air = cell => { const found = block(cell.x, cell.y, cell.z); return found?.known === true && AIR.test(found.name ?? '') }
  const until = async (test, ms) => { const end = now() + ms; while (now() < end && !disposed()) { if (test()) return true; await sleep(200) } return test() }
  const stacks = () => (getInventory()?.items ?? []).filter(item => item?.name === DIRT && item.count > 0)
  const dirt = () => getInventory()?.known === true ? stacks().reduce((sum, item) => sum + item.count, 0) : 0

  const held = name => getInventory()?.known === true ? (getInventory().items ?? []).filter(item => item?.name === name && item.count > 0).reduce((sum, item) => sum + item.count, 0) : 0
  const fill = () => FILL.reduce((sum, name) => sum + held(name), 0)

  let why = null // the last refusal, for the log
  let said = '' // the last refusal's message
  const refused = error => { why = String(error?.code ?? error?.message ?? error); said = String(error?.message ?? error); return false }
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
  // A walk refused because the body hangs a little above its floor (a step
  // cut short, e.g. by a fight) first lands with the ordinary settle, then is
  // planned again. Nothing else moves the prediction while idle (real Realm
  // 2026-11-16 20:23-20:28 JST: half-way up its own tunnel, every walk, climb
  // and trip was refused with "Wait for a supported landing before planning"
  // for five minutes, until a server position arrived).
  const LANDING = /supported landing/
  async function land () {
    if (typeof operations.movement.settle !== 'function') return false
    try { operations.movement.settle({ maxTicks: 40, maxDrop: 1, maxHorizontal: 1 }) } catch (error) { return refused(error) }
    await sleep(200)
    await until(() => !['moving', 'settling'].includes(getMotion()?.phase), 5000)
    return true
  }
  // Standing on a chest (feet off the half-block grid) no walk can be
  // planned: one step down onto a floor cell beside it first
  // (movement/low-step-down.js, modes/low-block.js).
  async function stepOff (toward = null) {
    const at = getFeet()
    if (!offGrid(at)) return false
    const y = Math.floor(at.y), cx = Math.floor(at.x), cz = Math.floor(at.z), out = []
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const x = cx + dx, z = cz + dz, below = block(x, y - 1, z)
      if ((dx || dz) && below?.known === true && below.boundingBox === 'block' && !low(below) && air({ x, y, z }) && air({ x, y: y + 1, z })) out.push({ x: x + 0.5, y, z: z + 0.5 })
    }
    const cost = cell => toward ? Math.hypot(cell.x - toward.x, cell.z - toward.z) : Math.hypot(cell.x - at.x, cell.z - at.z)
    for (const cell of out.sort((a, b) => cost(a) - cost(b)).slice(0, 4)) {
      if (!await begin(() => operations.movement.start(cell, { lowStepDown: true, maxDistance: 2, maxTicks: 40 }))) continue
      await sleep(300)
      await until(() => !['moving', 'settling'].includes(getMotion()?.phase), 5000)
      if (!offGrid(getFeet())) return true
    }
    return false
  }
  // On the rim of a block (the body's centre over air, ledge-footing.js) no walk can be planned either: one
  // simulated connector onto a full stand, level or one block lower. It counts when the feet's own cell has a floor.
  const RIM = /starting footprint has no known safe support/
  async function footing (toward = null) {
    if (!onRim(block, getFeet())) return false
    for (const stand of footings(block, getFeet(), toward)) {
      if (!await begin(() => operations.movement.start(stand.target, stand.options))) continue
      await sleep(300)
      await until(() => !['moving', 'settling'].includes(getMotion()?.phase), 5000)
      const at = getFeet()
      if (at && !offGrid(at) && !onRim(block, at)) return true
    }
    return false
  }
  async function walk (target) {
    let started = await begin(() => operations.movement.start(target, { maxDistance: 16 }))
    if (!started && (RIM.test(said) || RIM.test(why ?? '')) && await footing(target)) started = await begin(() => operations.movement.start(target, { maxDistance: 16 }))
    // The landing refusal is read before the step-down, whose own refusal
    // would hide it from the ordinary landing below (real Realm 2026-11-17
    // 15:12 JST: mid-stair in its tunnel the step-down was refused and the
    // walk back never settled: 「Low block step-down lacks bounded known support」).
    const landing = !started && (LANDING.test(said) || LANDING.test(why ?? ''))
    if (landing && offGrid(getFeet()) && await stepOff(target)) started = await begin(() => operations.movement.start(target, { maxDistance: 16 }))
    if (!started && landing && await land()) started = await begin(() => operations.movement.start(target, { maxDistance: 16 }))
    if (!started && landing && offGrid(getFeet()) && await stepOff(target)) started = await begin(() => operations.movement.start(target, { maxDistance: 16 }))
    if (!started) return false
    await sleep(300)
    await until(() => !['moving', 'settling'].includes(getMotion()?.phase), 12000)
    const at = getFeet()
    return !!at && Math.hypot(at.x - target.x, at.z - target.z) <= 0.45 && Math.abs(at.y - target.y) <= 0.2
  }
  // From farther than one walk reaches: hops of about ten blocks toward the
  // target over received ground (the walk itself plans at most 16 blocks; real
  // Realm 2026-11-15: 「Target lies outside the bounded search area」).
  const open = (x, y, z) => { const found = block(x, y, z); return found?.known === true && found.boundingBox !== 'block' }
  // The stand nearest the wanted height (by default the highest within reach).
  const standY = (x, z, near, want = near + 4) => {
    let best = null
    for (let y = near + 4; y >= near - 6; y--) { const below = block(x, y - 1, z); if (below?.known === true && below.boundingBox === 'block' && !low(below) && open(x, y, z) && open(x, y + 1, z) && (best === null || Math.abs(y - want) < Math.abs(best - want))) best = y }
    return best
  }
  // `within`: how near counts as there. With the target's height known, each
  // hop steps toward it as well and the height counts in the distance (real
  // Realm 2026-11-17 11:46 JST: 32 m from the base chest and 7 blocks above
  // it, the hops kept to the highest ground and the trip ended there).
  async function approach (target, within = 12) {
    const away = at => Math.hypot(target.x - at.x, target.z - at.z, Number.isFinite(target.y) ? target.y - at.y : 0)
    for (let hop = 0; hop < 10 && !disposed(); hop++) {
      const at = getFeet()
      if (!at) return false
      const dx = target.x - at.x, dz = target.z - at.z, far = away(at), flatFar = Math.hypot(dx, dz)
      if (far <= within) return true
      const base = Math.floor(at.y + 0.001), want = Number.isFinite(target.y) ? base + Math.max(-6, Math.min(4, Math.round(target.y - base))) : base + 4
      const reach = Math.max(2, Math.min(10, flatFar - within / 2))
      let moved = false
      for (const turn of [0, 0.5, -0.5, 1, -1]) {
        const angle = Math.atan2(dz, dx) + turn, x = Math.floor(at.x + Math.cos(angle) * reach), z = Math.floor(at.z + Math.sin(angle) * reach), y = standY(x, z, base, want)
        if (y === null) continue
        await walk({ x: x + 0.5, y, z: z + 0.5 })
        const after = getFeet()
        if (after && away(after) < far - 2) { moved = true; break }
      }
      if (!moved) return false
    }
    const at = getFeet()
    return !!at && away(at) <= within
  }
  const canMine = cell => { try { return operations.mining.preview([cell])?.ready === true } catch { return false } }
  // With no usable pickaxe left: plain rock by hand (slow, no drop).
  const byHand = cell => ({ x: cell.x, y: cell.y, z: cell.z, accessPreparation: 'hand_dig', ...(cell.climbShaft === true ? { climbShaft: true } : {}) })
  const canDig = cell => { try { return operations.mining.preview([byHand(cell)])?.ready === true } catch { return false } }
  async function dig (cell) {
    if (air(cell)) return true
    if (!await begin(() => operations.mining.start([byHand(cell)]))) return false
    return until(() => air(cell), 35000)
  }
  // Why the mining preview refuses a cell, for the log.
  const reason = cell => { try { const preview = operations.mining.preview([cell]); return preview?.ready === true ? null : String(preview?.errors?.[0] ?? preview?.error ?? '').slice(0, 160) || null } catch (error) { return String(error?.message ?? error).slice(0, 160) } }
  async function mine (cell) {
    if (air(cell)) return true
    await ready(cell)
    if (!await begin(() => operations.mining.start([cell]))) return false
    return until(() => air(cell), 35000)
  }
  // The pillar block under the feet: received air there, then the feet one lower.
  async function descend (cell) {
    const name = block(cell.x, cell.y, cell.z)?.name
    await ready(cell)
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
  async function place (cell, { any = false } = {}) {
    const material = any ? FILL.find(name => held(name) > 0) : DIRT
    const have = () => (getInventory()?.items ?? []).filter(item => item?.name === material && item.count > 0)
    let item = have().find(stack => stack.slot <= 8)
    if (!item && have().length) { try { await operations.inventory.equip(have()[0].slot) } catch { return false } item = have().find(stack => stack.slot <= 8) }
    if (!item) return false
    try { await operations.interactions.placeBlock({ position: cell, slot: item.slot }) } catch { return false }
    return until(() => { const found = block(cell.x, cell.y, cell.z); return found?.known === true && found.boundingBox === 'block' }, 5000)
  }
  // A floor block into the gap `cell` beside the feet (modes/player-build-walk.js): the ordinary
  // placement against a side face, the block under the feet first, then a block beside the gap.
  // It counts by the received block; a placement sent and not answered is not sent a second time.
  const FACES = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]]
  async function bridge (cell, from) {
    const solid = () => { const found = block(cell.x, cell.y, cell.z); return found?.known === true && found.boundingBox === 'block' }
    if (solid()) return true
    const material = FILL.find(name => held(name) > 0)
    const have = () => (getInventory()?.items ?? []).filter(item => item?.name === material && item.count > 0)
    let item = have().find(stack => stack.slot <= 8)
    if (!item && have().length) { try { await operations.inventory.equip(have()[0].slot) } catch (error) { return refused(error) } item = have().find(stack => stack.slot <= 8) }
    if (!item) { why = 'NO_BLOCK'; return false }
    const beside = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => ({ x: cell.x + dx, y: cell.y, z: cell.z + dz }))
    const under = { x: from.x, y: from.y - 1, z: from.z }
    for (const clicked of [under, ...beside.filter(at => !(at.x === under.x && at.z === under.z))]) {
      const face = FACES.findIndex(([dx, dy, dz]) => clicked.x + dx === cell.x && clicked.y + dy === cell.y && clicked.z + dz === cell.z)
      if (face < 0) continue
      const options = { position: cell, slot: item.slot, clicked, face }
      let preview = null
      try { preview = operations.interactions.previewPlaceAgainst(options) } catch (error) { refused(error); continue }
      if (preview?.ready !== true) { why = String(preview?.errors?.[0] ?? 'PLACE_REFUSED'); continue }
      let sent = false
      if (!await begin(() => { const run = operations.interactions.placeAgainst(options); sent = true; Promise.resolve(run).catch(refused) })) { if (sent) return false; continue }
      return until(solid, 5000)
    }
    return false
  }
  // A pickaxe into the hand (the pillar step leaves dirt there; real Realm 2026-11-16 06:41 JST: stone overhead was
  // refused with a sword in hand, 「適切なツルハシの装備を確認できません」).
  // For a block (`cell`): the working pickaxe of the lowest tier that mines it (dig-tool.js), so rock and dirt are
  // not dug with the iron pickaxe while a stone one is carried. With no cell, or a block with no dig rule: the
  // pickaxe with the most uses left, as before.
  const picks = () => (getInventory()?.items ?? []).filter(item => /_pickaxe$/.test(item?.name ?? '') && item.count > 0 && item.durabilityKnown === true && item.durabilityRemaining > 2).sort((a, b) => b.durabilityRemaining - a.durabilityRemaining)
  const chosen = cell => {
    const name = cell ? block(cell.x, cell.y, cell.z)?.name : null
    return name && digTool(getInventory()?.items ?? [], name, getHeld()) || picks()[0] || null
  }
  async function pick (cell = null) {
    const item = chosen(cell)
    if (!item) return false
    // Through the inventory, into the slot the server has selected: a hotbar
    // selection alone is not confirmed by this server, and the mining check
    // then reads the old hand (real Realm 07:01 JST: refused with the wooden
    // pickaxe selected).
    try {
      const moved = await operations.inventory.equip(item.slot)
      if (moved?.phase !== 'completed') return false
      // Already in the hand: nothing was swapped and nothing is waited for.
      if (moved.selectedSlotChanged === false && moved.slot === moved.sourceSlot) return true
    } catch (error) { return refused(error) }
    await sleep(250)
    return true
  }
  // Before a block is mined: the pickaxe for that block into the hand. A hand that cannot be changed is left as it
  // is, and the mining check decides as before.
  // A block no tool is needed for (dirt, grass) costs nothing with no tool in the hand: the hand is changed only
  // when it holds a tool of a higher tier than the cheapest pickaxe (the iron pickaxe, with a stone one carried).
  async function ready (cell) {
    const hand = getHeld() ?? null
    const name = block(cell.x, cell.y, cell.z)?.name, tool = name ? digTool(getInventory()?.items ?? [], name, hand) : null
    if (!tool) return
    if (hand && hand.slot === tool.slot && hand.name === tool.name) return
    if (!toolNeeded(name) && !((toolOf(hand)?.tier ?? 0) > tool.tier)) return
    const before = why
    if (!await pick(cell)) why = before
  }
  // Off an edge onto a floor two or three lower in the next cell: the navigation's predicted controlled drop
  // (movement/navigation.js `controlledDrop`). It counts when the feet are received at the lower cell.
  // `fall` over three (the route asked for it, build-route.js `maxFall`) is a jump that costs health.
  async function drop (target, fall = 3) {
    if (!await begin(() => operations.movement.start(target, { controlledDrop: true, dropLimit: Math.min(6, Math.max(3, Math.round(fall))), maxDistance: 2, maxTicks: 80 }))) return false
    await sleep(300)
    await until(() => !['moving', 'settling'].includes(getMotion()?.phase), 6000)
    const at = getFeet()
    return !!at && Math.floor(at.x) === Math.floor(target.x) && Math.floor(at.z) === Math.floor(target.z) && Math.abs(at.y - target.y) < 0.3
  }
  return { feet: getFeet, block, dirt, fill, walk, stepOff, footing, land, approach, canMine, mine, canDig, dig, descend, pillar, bridge, drop, health: () => { const value = getHealth(); return Number.isFinite(value) ? value : null }, place, pick, reason, why: () => why }
}

module.exports = { createScaffoldPorts }
