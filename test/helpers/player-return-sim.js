'use strict'

// A small Realm for the player's return to the base, for tests.
//
// Real modules under test: player-base.js (when a trip is due, what is banked),
// return/* (goal, runner, stages, failure memory, container ports),
// player-storage-ports.js, player-scaffold-ports.js (walk, approach),
// player-water.js (the water exit), house/house-door.js and house-exit.js,
// and actions/chest.js with its 1.26.60 packets (open, item_stack_request,
// item_stack_response, inventory_slot).
//
// Simulated here, and only here: the server (it answers the chest packets and
// owns the inventory and the chest contents), the walking engine (a breadth-
// first walk over standable cells that takes time and stops at a closed door),
// the long travel (a straight walk that takes time, fails from water and from
// inside a roofed house), the climb, the autonomy (a stop takes time to end),
// and a fight that takes the controls. Nothing here "arrives by being called":
// every move takes simulated time and can be cut short.
const { createChest } = require('../../src/actions/chest')
const { createPlayerBase } = require('../../src/modes/player-base')
const { createStoragePorts } = require('../../src/modes/player-storage-ports')
const { createScaffoldPorts } = require('../../src/modes/player-scaffold-ports')
const { createPlayerWater } = require('../../src/modes/player-water')
const { openDoor } = require('../../src/modes/house/house-door')
const { leaveHouse, inside } = require('../../src/modes/house/house-exit')
const { placements } = require('../../src/modes/house/house-blueprint')
const { underCover } = require('../../src/modes/player-surface')
const { low } = require('../../src/modes/low-block')
const { openAccess } = require('../../src/actions/open-face')
const { chestsNear } = require('../../src/modes/player-storage')

const EYE = 1.62, WALK = 4.3, TRAVEL = 4, GROUND = 64
const extra = () => ({ has_nbt: 'false', can_place_on: [], can_destroy: [] })
const air = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: extra() })
const NAMES = ['diamond', 'cobblestone', 'coal', 'iron_ingot', 'emerald', 'tuff', 'oak_log', 'oak_planks', 'chest', 'diamond_pickaxe', 'diamond_sword', 'cooked_beef', 'dirt', 'stick', 'wooden_pickaxe', 'string', 'bone']
const REGISTRY = NAMES.map((name, index) => ({ runtime_id: 400 + index, name: `minecraft:${name}` }))
const idOf = name => REGISTRY.find(entry => entry.name === (name.includes(':') ? name : `minecraft:${name}`)).runtime_id
const nameOf = id => REGISTRY.find(entry => entry.runtime_id === id)?.name ?? null

function createReturnSim ({ feet = { x: 0.5, y: GROUND, z: 0.5 }, items = [], stopLagMs = 400 } = {}) {
  // ---- clock: simulated time; every sleep also lets real promises settle ----
  let clock = 1_000_000
  const now = () => clock
  const due = []
  const later = (ms, run) => due.push({ at: clock + ms, run })
  async function sleep (ms) {
    let left = Math.max(1, ms)
    while (left > 0) {
      const dt = Math.min(200, left)
      clock += dt; left -= dt
      step(dt)
      for (const entry of due.filter(entry => entry.at <= clock)) { due.splice(due.indexOf(entry), 1); entry.run() }
      await new Promise(resolve => setImmediate(resolve))
    }
  }

  // ---- world ----
  const blocks = new Map(), key = (x, y, z) => `${x},${y},${z}`
  let runtimeId = 1000
  const solid = name => ({ known: true, name, boundingBox: 'block', runtimeId: ++runtimeId, extra: [] })
  const empty = (name, properties) => ({ known: true, name, boundingBox: 'empty', runtimeId: ++runtimeId, extra: [], ...(properties ? { properties } : {}) })
  const STONE = solid('minecraft:stone'), AIR = empty('minecraft:air')
  const unknown = new Set()
  function getBlock (x, y, z) {
    if (unknown.has(`${Math.floor(x / 16)},${Math.floor(z / 16)}`)) return { known: false }
    return blocks.get(key(x, y, z)) ?? (y < GROUND ? STONE : AIR)
  }
  const setBlock = (x, y, z, name, { passable = false, properties = null } = {}) => blocks.set(key(x, y, z), passable ? empty(name, properties) : solid(name))
  const water = (x, y, z) => setBlock(x, y, z, 'minecraft:water', { passable: true })
  const isWater = (x, y, z) => /water/.test(getBlock(x, y, z)?.name ?? '')
  const closedDoor = (x, y, z) => { const found = getBlock(x, y, z); return /door$/.test(found?.name ?? '') && ![true, 1].includes(found.properties?.open_bit) }
  const passable = (x, y, z) => { const found = getBlock(x, y, z); return found?.known === true && found.boundingBox !== 'block' }
  const firm = (x, y, z) => { const found = getBlock(x, y, z); return found?.known === true && found.boundingBox === 'block' }
  const floor = (x, y, z) => firm(x, y, z) && !low(getBlock(x, y, z))
  const standable = (x, y, z, wet = false) => floor(x, y - 1, z) && passable(x, y, z) && passable(x, y + 1, z) && (wet || (!isWater(x, y, z) && !isWater(x, y + 1, z)))

  // ---- the Bot's body and identity ----
  const body = { x: feet.x, y: feet.y, z: feet.z }
  const state = { phase: 'spawned', profile: 'bot', realm: { id: '1' }, connectionId: 'sim-1', startedAt: '2026-11-18T00:00:00.000Z', runtimeEntityId: '77', dimension: 'overworld', lifecycle: { deathId: 0, dead: false }, gameMode: 'survival', health: 20, inventory: { known: true } }
  const getFeet = () => ({ ...body })
  const getPosition = () => ({ x: body.x, y: body.y + EYE, z: body.z })
  const cellOf = () => ({ x: Math.floor(body.x), y: Math.floor(body.y + 0.05), z: Math.floor(body.z) })
  const scope = () => JSON.stringify([state.connectionId, state.dimension, state.lifecycle.deathId])
  const inWater = () => { const at = cellOf(); return isWater(at.x, at.y, at.z) || isWater(at.x, at.y - 1, at.z) }

  // ---- who holds the controls ----
  const agent = { running: false, stopUntil: 0, starts: [], stops: [] }
  let combatUntil = 0, eatingUntil = 0, connections = 1
  const combatOwns = () => clock < combatUntil
  const settled = () => !agent.running && clock >= agent.stopUntil
  function requireIdle () {
    if (combatOwns()) throw new Error('利用者指定の戦闘・睡眠・片付け動作が操作を使用中です。')
    if (clock < agent.stopUntil) throw new Error('前の操作の終了処理を待ってください。')
  }
  const log = []
  const events = [] // every game operation that began, with its time
  const began = (kind, detail) => events.push({ at: clock, kind, detail, combat: combatOwns(), stopping: clock < agent.stopUntil, agentRunning: agent.running, wet: inWater(), indoors: !!(sim.house && inside(sim.house.origin, getFeet())), scope: scope() })

  // ---- walking: breadth-first over standable cells, a step up or down at most ----
  let motion = { phase: 'idle', reason: null }, path = [], trips = 0
  const fail = { walk: null, waterExit: false, climb: null, travel: null, approach: false }
  function route (to, { wet = false, max = 16 } = {}) {
    const from = cellOf(), goal = { x: Math.floor(to.x), y: Math.floor(to.y + 0.05), z: Math.floor(to.z) }
    if (Math.hypot(goal.x - from.x, goal.z - from.z) > max) throw new Error('Target lies outside the bounded search area')
    if (!standable(goal.x, goal.y, goal.z, wet)) throw new Error('No known safe standing position has a valid route')
    const seen = new Map([[key(from.x, from.y, from.z), null]]), queue = [from]
    while (queue.length) {
      const at = queue.shift()
      if (at.x === goal.x && at.y === goal.y && at.z === goal.z) { const out = []; for (let cell = at; cell; cell = seen.get(key(cell.x, cell.y, cell.z))) out.unshift(cell); return out.slice(1) }
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [0, 1, -1]) {
        const next = { x: at.x + dx, y: at.y + dy, z: at.z + dz }
        if (Math.hypot(next.x - from.x, next.z - from.z) > max + 2 || seen.has(key(next.x, next.y, next.z)) || !standable(next.x, next.y, next.z, wet)) continue
        if (dy === 1 && !passable(at.x, at.y + 2, at.z)) continue
        seen.set(key(next.x, next.y, next.z), at); queue.push(next); break
      }
    }
    throw new Error('No safe route found')
  }
  const movement = {
    start (target, options = {}) {
      requireIdle()
      if (fail.walk) throw new Error(fail.walk)
      const wet = options.waterExit === true
      if (inWater() && !wet) throw new Error('Water prediction is experimental and disabled')
      if (wet && fail.waterExit) throw new Error('No safe known shore route is accepted by the live movement preview')
      // The short walk plans no way out of the house by itself beyond a few cells (sim.indoorWalkM):
      // out goes through the door's two stands (house-exit.js).
      if (sim.house && inside(sim.house.origin, getFeet()) && !inside(sim.house.origin, { x: target.x, y: target.y, z: target.z }) && Math.hypot(target.x - body.x, target.z - body.z) > sim.indoorWalkM) throw new Error('No safe route found')
      path = route(target, { wet, max: options.maxDistance ?? 16 })
      motion = { phase: 'moving', reason: null }
      began('walk', { x: target.x, y: target.y, z: target.z })
    },
    settle () { requireIdle(); motion = { phase: 'idle', reason: null } },
    snapshot: () => motion
  }
  function walkStep (dt) {
    let left = WALK * dt / 1000
    while (left > 0 && path.length) {
      const next = path[0]
      // The server does not let a body through a closed door, whatever the client planned.
      if (closedDoor(next.x, next.y, next.z)) { path = []; motion = { phase: 'idle', reason: 'server position correction at a closed door' }; return }
      const tx = next.x + 0.5, tz = next.z + 0.5, far = Math.hypot(tx - body.x, tz - body.z)
      if (far <= left) { body.x = tx; body.z = tz; body.y = next.y; left -= far; path.shift() } else { body.x += (tx - body.x) / far * left; body.z += (tz - body.z) / far * left; left = 0 }
    }
    if (!path.length) motion = { phase: 'idle', reason: motion.reason }
  }

  // ---- the long travel: a straight walk over the surface ----
  const travel = { busy: false, phase: 'idle', reason: null, destination: null, failures: 0, zones: [], speed: TRAVEL }
  const surfaceY = (x, z) => { for (let y = GROUND + 30; y > GROUND - 30; y--) if (standable(Math.floor(x), y, Math.floor(z))) return y; return null }
  const travelApi = {
    to: async ({ destination }) => {
      requireIdle()
      trips++
      Object.assign(travel, { busy: true, phase: 'moving', reason: null, destination: { ...destination }, failures: 0 })
      began('travel', { ...destination })
    },
    status: () => ({ busy: travel.busy, phase: travel.phase, reason: travel.reason }),
    cancel: async () => { Object.assign(travel, { busy: false, phase: 'stopped', reason: 'MANUAL_STOP' }) }
  }
  function travelStep (dt) {
    if (!travel.busy || combatOwns()) return
    const to = travel.destination, far = Math.hypot(to.x - body.x, to.z - body.z)
    if (far <= 20) return Object.assign(travel, { busy: false, phase: 'arrived', reason: 'LONG_TRAVEL_ARRIVED' })
    const house = sim.house
    if (fail.travel === 'stall') { travel.reason = 'CHUNK_TRAVEL_NO_ROUTE'; return }
    const stuck = fail.travel ?? (inWater() ? 'CHUNK_TRAVEL_NO_ROUTE' : house && inside(house.origin, getFeet()) ? 'CHUNK_TRAVEL_NO_ROUTE' : null)
    const move = Math.min(far - 20 + 0.1, travel.speed * dt / 1000), nx = body.x + (to.x - body.x) / far * move, nz = body.z + (to.z - body.z) / far * move
    const zone = travel.zones.find(z => nx >= z.x1 && nx <= z.x2 && nz >= z.z1 && nz <= z.z2)
    let y = surfaceY(nx, nz)
    // A single block in the way (a chest) is walked round, as the real route does.
    if (y === null && !stuck && !zone) {
      for (const side of [1.5, -1.5]) {
        const sx = nx - (to.z - body.z) / far * side, sz = nz + (to.x - body.x) / far * side, sy = surfaceY(sx, sz)
        if (sy !== null) { body.x = sx; body.z = sz; body.y = sy; return }
      }
    }
    if (stuck || zone || y === null) {
      travel.reason = stuck ?? zone?.code ?? 'CHUNK_TRAVEL_NO_ROUTE'
      if (++travel.failures >= 15) { Object.assign(travel, { busy: false, phase: 'failed' }); if (zone?.once) travel.zones.splice(travel.zones.indexOf(zone), 1) }
      return
    }
    body.x = nx; body.z = nz; body.y = y
  }

  // ---- the climb out of a tunnel: one block a second, cut short by a fight ----
  async function climb (aborted) {
    began('climb')
    if (fail.climb) return { ok: false, reason: fail.climb }
    // Up until the feet stand level with the ground the shaft broke through (player-climb.js).
    for (let i = 0; i < 96 && (underCover(getBlock, getPosition()) || body.y < GROUND); i++) {
      if (aborted()) return { ok: false, reason: 'INTERRUPTED' }
      if (combatOwns()) return { ok: false, reason: 'PILLAR_ASCENT_COMBAT_INTERRUPTED', code: 'PILLAR_ASCENT_COMBAT_INTERRUPTED' }
      await sleep(1000)
      const at = cellOf()
      blocks.set(key(at.x, at.y + 2, at.z), AIR); blocks.set(key(at.x, at.y, at.z), solid('minecraft:dirt')); body.y += 1
    }
    return { ok: !underCover(getBlock, getPosition()) }
  }

  function step (dt) { if (!combatOwns() && motion.phase === 'moving') walkStep(dt); travelStep(dt) }

  // ---- the server side of the inventory and the chests ----
  const bag = Array.from({ length: 36 }, air)
  let stackId = 100
  const raw = (name, count) => ({ network_id: idOf(name), count, metadata: 0, has_stack_id: true, stack_id: ++stackId, block_runtime_id: 0, extra: extra() })
  for (const [slot, name, count] of items) bag[slot] = raw(name, count)
  let uncertain = false
  const inventory = () => uncertain ? null : ({ known: true, items: bag.map((item, slot) => item.network_id ? { slot, name: nameOf(item.network_id), count: item.count } : null).filter(Boolean) })
  const held = name => bag.filter(item => item.network_id === idOf(name)).reduce((sum, item) => sum + item.count, 0)
  const stores = new Map() // one store per container; the halves of a large chest share it
  const pairOf = at => [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => ({ x: at.x + dx, y: at.y, z: at.z + dz })).find(p => getBlock(p.x, p.y, p.z)?.name === 'minecraft:chest') ?? null
  const storeKey = at => { const pair = pairOf(at); const first = !pair || at.x < pair.x || (at.x === pair.x && at.z < pair.z) ? at : pair; return key(first.x, first.y, first.z) }
  function storeOf (at) {
    const id = storeKey(at), size = pairOf(at) ? 54 : 27
    if (!stores.has(id) || stores.get(id).length !== size) stores.set(id, Array.from({ length: size }, (_, slot) => stores.get(id)?.[slot] ?? air()))
    return stores.get(id)
  }
  function placeChest (x, y, z, { fill = 0 } = {}) {
    setBlock(x, y, z, 'minecraft:chest')
    const store = storeOf({ x, y, z })
    for (let slot = 0; slot < Math.min(fill, store.length); slot++) if (!store[slot].network_id) store[slot] = raw('tuff', 64)
    return { x, y, z }
  }
  const stored = (at, name) => storeOf(at).filter(item => item.network_id === idOf(name)).reduce((sum, item) => sum + item.count, 0)

  const server = { contents: 'send', transfer: 'ok', requests: [], window: null }, truth = []
  const observed = { authority: true, inventoryKnown: true, pendingRequestId: null, openContainer: null }
  const crafting = {
    snapshot: () => structuredClone(observed), rawItem: slot => bag[slot] ? structuredClone(bag[slot]) : null,
    applyPacket (name, packet) {
      if (name === 'container_open') observed.openContainer = { id: packet.window_id, type: packet.window_type }
      if (name === 'container_close') observed.openContainer = null
      if (name === 'inventory_slot' && [0, 'inventory'].includes(packet.window_id)) bag[packet.slot] = structuredClone(packet.item)
    },
    closeContainer () { if (server.window) { const id = server.window.id; server.window = null; observe('container_close', { window_id: id }) } }
  }
  const container = id => ({ container_id: id, dynamic_container_id: null })
  let windowId = 4, requestId = -501
  const client = {
    queue (name, params) {
      if (name !== 'item_stack_request') return
      const request = params.requests[0], action = request.actions[0]
      server.requests.push({ at: clock, id: request.request_id, count: action.count, from: action.source.slot, to: action.destination.slot, chest: server.window?.position })
      began('transfer', { count: action.count })
      const mode = typeof server.transfer === 'function' ? server.transfer(server.requests.length) : server.transfer
      if (mode === 'drop') return // not applied, no answer: the chest module times out and marks the inventory uncertain
      if (mode === 'apply_silent') { // applied, the answer is lost: the truth shows at the next full inventory
        const store = storeOf(server.window.position), from = bag[action.source.slot], count = action.count
        store[action.destination.slot] = { ...structuredClone(from), count, stack_id: ++stackId }
        truth.push(() => { bag[action.source.slot] = from.count - count > 0 ? { ...from, count: from.count - count, stack_id: ++stackId } : air() })
        return
      }
      setImmediate(() => {
        if (!server.window) return
        if (mode === 'reject') return observe('item_stack_response', { responses: [{ status: 'error', request_id: request.request_id }] })
        const store = storeOf(server.window.position), deposit = action.source.slot_type.container_id === 'hotbar_and_inventory'
        const playerSlot = deposit ? action.source.slot : action.destination.slot, chestSlot = deposit ? action.destination.slot : action.source.slot
        const give = (list, slot, from) => { list[slot] = list[slot].network_id ? { ...list[slot], count: list[slot].count + action.count, stack_id: ++stackId } : { ...structuredClone(from), count: action.count, stack_id: ++stackId } }
        const take = (list, slot) => { list[slot] = list[slot].count - action.count > 0 ? { ...list[slot], count: list[slot].count - action.count, stack_id: ++stackId } : air() }
        const next = { bag: bag.map(item => structuredClone(item)), store }
        if (deposit) { give(store, chestSlot, bag[playerSlot]); take(next.bag, playerSlot) } else { give(next.bag, playerSlot, store[chestSlot]); take(store, chestSlot) }
        const slot = (index, item) => ({ slot: index, hotbar_slot: index, count: item.count, item_stack_id: item.network_id ? item.stack_id : 0, custom_name: '', filtered_custom_name: '', durability_correction: 0 })
        observe('item_stack_response', { responses: [{ status: 'ok', request_id: request.request_id, containers: [{ slot_type: container('hotbar_and_inventory'), slots: [slot(playerSlot, next.bag[playerSlot])] }, { slot_type: container('container'), slots: [slot(chestSlot, store[chestSlot])] }] }] })
        if (mode !== 'ack_only') observe('inventory_slot', { window_id: 'inventory', slot: playerSlot, container: container('inventory'), storage_item: air(), item: next.bag[playerSlot] })
        observe('inventory_slot', { window_id: server.window.id, slot: chestSlot, container: container('container'), storage_item: air(), item: store[chestSlot] })
      })
    }
  }
  const interactions = {
    // The real rule of the open click (actions/open-face.js): within reach of the
    // face towards the eye, with a clear line to it.
    async openChest (target) {
      const refused = openAccess(pos => getBlock(pos.x, pos.y, pos.z), getPosition(), target)
      if (refused) { began('open_refused', { ...target, code: refused.code }); throw new Error(refused.message) }
      began('open', { ...target })
      const id = ++windowId
      server.window = { id, position: { ...target } }
      setImmediate(() => {
        if (server.window?.id !== id) return
        observe('container_open', { window_id: id, window_type: 'container', coordinates: target, runtime_entity_id: -1n })
        if ((typeof server.contents === 'function' ? server.contents(target) : server.contents) === 'send') observe('inventory_content', { window_id: id, input: storeOf(target).map(item => structuredClone(item)), container: container('container'), storage_item: air() })
      })
      return { serverConfirmed: true }
    },
    cancel () {}
  }
  const chest = createChest({ client, getState: () => state, world: { getBlock }, crafting, interactions, timeoutMs: 400, allocateRequestId: () => { const id = requestId; requestId -= 2; return id }, onInventory: delta => crafting.applyPacket('inventory_slot', delta), onUncertain: () => { uncertain = true } })
  function observe (name, packet) { crafting.applyPacket(name, packet); chest.applyPacket(name, packet) }
  const sendInventory = () => { for (const apply of truth.splice(0)) apply(); observe('inventory_content', { window_id: 'inventory', input: bag.map(item => structuredClone(item)), container: container('inventory'), storage_item: air() }); uncertain = false }
  observe('start_game', { server_authoritative_inventory: true, itemstates: REGISTRY })
  observe('item_registry', { itemstates: REGISTRY })
  sendInventory()

  const operations = {
    movement,
    chest: { open: position => { requireIdle(); crafting.closeContainer(); return chest.open(position) }, depositItem: options => { requireIdle(); return chest.depositItem(options) }, withdrawItem: options => { requireIdle(); return chest.withdrawItem(options) }, snapshot: () => chest.snapshot(), cancel: reason => chest.cancel(reason) },
    crafting: { closeContainer: () => crafting.closeContainer() },
    interactions: { previewOpenChest: target => { const refused = openAccess(pos => getBlock(pos.x, pos.y, pos.z), getPosition(), target); return refused ? { ready: false, code: refused.code, errors: [refused.message] } : { ready: true } }, useDoor: async at => { requireIdle(); began('door', { ...at }); later(200, () => { for (const dy of [0, 1]) { const found = getBlock(at.x, at.y + dy, at.z); if (/door$/.test(found?.name ?? '')) blocks.set(key(at.x, at.y + dy, at.z), empty(found.name, { open_bit: true })) } }) } },
    mining: { preview: () => ({ ready: false }), start () { throw new Error('not simulated') } },
    inventory: {}
  }

  // ---- a starter house from the blueprint, with its chests and its door ----
  function buildHouse (origin) {
    const BLOCK = { oak_door: 'minecraft:wooden_door', torch: 'minecraft:torch' }
    for (const stepOf of placements(origin)) for (const at of stepOf.cells) {
      if (!at) continue
      if (stepOf.item === 'chest') placeChest(at.x, at.y, at.z)
      else if (stepOf.item === 'oak_door') setBlock(at.x, at.y, at.z, BLOCK.oak_door, { passable: true, properties: { open_bit: false } })
      else setBlock(at.x, at.y, at.z, BLOCK[stepOf.item] ?? `minecraft:${stepOf.item}`, { passable: stepOf.item === 'torch' })
    }
    sim.house = { origin: { ...origin }, done: true }
    return sim.house
  }

  // ---- one runtime: the real player modules over the simulated Realm ----
  const shared = { playerWanted: true, playerBase: null }
  const canBuild = () => held('chest') >= 1
  // Like player-storage.js ensure(): a chest standing near the Bot that it was
  // not told to skip and that is not known full comes first; otherwise a held one is placed.
  function makeChest ({ full = [], avoid = [] } = {}, room = () => null) {
    const skipped = new Set(full.map(p => key(p.x, p.y, p.z))), listed = p => !!p && skipped.has(key(p.x, p.y, p.z))
    const standing = chestsNear(getBlock, getFeet()).find(found => !listed(found.position) && !listed(found.pair) && room(found.position) !== 0 && !(found.pair && room(found.pair) === 0))
    if (standing) return standing.position
    if (held('chest') < 1 || (sim.house && inside(sim.house.origin, getFeet()))) return null // no flat pair inside the house
    const at = cellOf(), taken = new Set([...full, ...avoid].map(p => key(p.x, p.y, p.z)))
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [2, 0], [0, 2]]) {
      const x = at.x + dx, z = at.z + dz
      if (taken.has(key(x, at.y, z)) || !firm(x, at.y - 1, z) || getBlock(x, at.y, z).name !== 'minecraft:air') continue
      const slot = bag.findIndex(item => item.network_id === idOf('chest'))
      bag[slot] = bag[slot].count > 1 ? { ...bag[slot], count: bag[slot].count - 1 } : air()
      sendInventory()
      began('place_chest', { x, y: at.y, z })
      return placeChest(x, at.y, z)
    }
    return null
  }
  function mount () {
    let gone = false
    const disposed = () => gone
    const say = line => log.push(line)
    const hands = createScaffoldPorts({ operations, disposed, getBlock, getFeet, getInventory: inventory, getMotion: () => motion, pillarStep: async () => ({ ok: false }), sleep, now })
    const storagePorts = createStoragePorts({ operations, disposed, getBlock, getFeet, getInventory: inventory, held: combatOwns, sleep, now })
    const waterJob = createPlayerWater({ getMode: () => sim.mode, shared, agent: { objective: {}, start: async () => {}, stop () {}, settled }, getPosition: getFeet, getBlock, start: (target, options) => movement.start(target, options), moving: () => motion.phase === 'moving', why: () => motion.reason, disposed, log: say, now, sleep })
    const door = () => sim.house?.origin ? openDoor({ origin: sim.house.origin, getBlock, useDoor: at => operations.interactions.useDoor(at), walk: target => hands.walk(target), getFeet, log: say, now, sleep }) : Promise.resolve(true)
    const jobs = { other: null } // 'flee', 'shelter', ... while set
    const base = createPlayerBase({
      getMode: () => sim.mode, shared, log: say, disposed, getFeet, getPosition, getBlock, getInventory: inventory, getWorn: () => sim.worn, now, sleep,
      agent: { objective: { objective: 'diamond' }, start: async options => { if (gone) throw new Error('reloaded'); agent.running = true; agent.starts.push({ at: clock, options }) }, stop: reason => { agent.running = false; agent.stopUntil = clock + sim.stopLagMs; agent.stops.push({ at: clock, reason }); path = []; motion = { phase: 'idle', reason: null } }, settled, running: () => agent.running },
      hands: storagePorts, chest: async options => makeChest(options, at => storagePorts.room(at)), canBuild,
      porch: () => { const o = sim.house?.origin; return o ? { stand: { x: o.x + 3.5, y: o.y, z: o.z + 10.5 }, avoid: [8, 9].flatMap(dz => [0, 1, 2].map(dy => ({ x: o.x + 3, y: o.y + dy, z: o.z + dz }))) } : null },
      spares: () => { const o = sim.house?.origin; return o ? [{ x: o.x + 5, y: o.y + 1, z: o.z + 3 }] : [] },
      climb, door, walk: target => hands.walk(target), approach: (target, within) => fail.approach ? Promise.resolve(false) : hands.approach(target, within),
      // The house's own walk to its porch (house-build.js closeIn): a longer walk, which takes its time too.
      porchWalk: async () => { const o = sim.house?.origin ?? sim.porch; if (!o) return false; began('porch'); movement.start({ x: o.x + 3.5, y: o.y, z: o.z + 10.5 }, { maxDistance: 48 }); while (motion.phase === 'moving') await sleep(200); return true },
      travel: travelApi, water: { needed: () => waterJob.needed(), exit: aborted => waterJob.exit(aborted) },
      house: { inside: () => inside(sim.house?.origin, getFeet()), leave: () => leaveHouse({ house: sim.house, getFeet, getBlock, walk: target => hands.walk(target), door, log: say }) },
      scope, dimension: () => state.dimension, interrupter: () => jobs.other ?? (combatOwns() ? '戦闘' : clock < eatingUntil ? '食事' : null),
      hostile: () => sim.hostileNear, file: 'player-base.json', returnFile: 'player-return.json',
      write: async (file, data) => { if (sim.writeFails) throw new Error('disk full'); sim.files[file] = JSON.parse(JSON.stringify(data)) }
    })
    return { base, jobs, storagePorts, hands, dispose: () => { gone = true } }
  }

  // Ticks the base like the mode timer (every two seconds) until `done` or the time is up.
  async function run (runtime, { until = () => false, ms = 600000 } = {}) {
    const end = clock + ms
    let last = null
    while (clock < end) {
      last = await runtime.base.tick()
      if (until(last)) return last
      await sleep(2000)
    }
    return last
  }

  const sim = {
    mode: 'player', worn: { known: true, worn: ['helmet', 'chestplate', 'leggings', 'boots'].map(piece => ({ piece, name: `minecraft:diamond_${piece}` })) }, hostileNear: false, stopLagMs, writeFails: false, files: {}, house: null, porch: null, indoorWalkM: Infinity,
    now, sleep, later, getBlock, setBlock, water, placeChest, stored, storeOf, buildHouse, unknown, body, state, shared, agent, log, events, server, fail, travel, bag, held, inventory, chest, operations, mount, run, getFeet, getPosition, scope, settled, combatOwns,
    get clock () { return clock }, get trips () { return trips },
    set uncertain (value) { uncertain = value }, get uncertain () { return uncertain },
    resync: sendInventory,
    give (slot, name, count) { bag[slot] = raw(name, count); sendInventory() },
    fight (ms) { combatUntil = clock + ms; path = []; motion = { phase: 'idle', reason: 'combat' } },
    eat (ms) { eatingUntil = clock + ms },
    die (spawn) { state.lifecycle = { deathId: state.lifecycle.deathId + 1, dead: false }; for (let slot = 0; slot < 36; slot++) bag[slot] = air(); Object.assign(body, spawn); path = []; Object.assign(travel, { busy: false, phase: 'idle' }); server.window = null; observe('container_close', { window_id: windowId }); sendInventory() },
    reconnect () { state.connectionId = `sim-${++connections}`; server.window = null; observed.openContainer = null; observe('start_game', { server_authoritative_inventory: true, itemstates: REGISTRY }); observe('item_registry', { itemstates: REGISTRY }); sendInventory() },
    goal: runtime => runtime.base.status().goal
  }
  return sim
}

module.exports = { createReturnSim, GROUND }
