'use strict'

// A received box of blocks with the Bot in it, for the expedition's gathering (dragon-supply-gather.js `collect`).
// Real: the navigation's planner and physics (movement/navigation.js), the scaffold's hands (player-scaffold-ports.js)
// and everything above them that the test calls.
// Stand-in, and only this: the server. It agrees with every predicted step. A block is mined when one of its faces is
// open, within reach, and in a straight line of open cells from the eye; its drop is in the inventory at once. Leaves
// are refused (leaves are never mined), and logs too unless the scene says `logs: true` (player mode takes logs).
// The long trip is recorded, not walked. A placement is answered where a side of the cell is solid (w.placed).
// Its success is not the game's.
// The hand: `equip` swaps the row into the selected slot (slot 0), as the inventory screen does. A block that needs a
// pickaxe is refused with a lesser tool in the hand (the mining check's own line); a tool in the hand loses a use a
// block (a sword two). w.uses counts them by tool, w.swaps the swaps.
const { createNavigator } = require('../../src/movement/navigation')
const { createScaffoldPorts } = require('../../src/modes/player-scaffold-ports')
const { isDoor, openDoorCell } = require('../../src/movement/door-cell')

const DROPS = { coal_ore: 'coal', iron_ore: 'raw_iron', copper_ore: 'raw_copper', stone: 'cobblestone', andesite: 'andesite', diorite: 'diorite', granite: 'granite', dirt: 'dirt', grass_block: 'dirt', oak_log: 'oak_log', birch_log: 'birch_log' }
// Water is given as a source (only names were read); seagrass stands in water.
const EMPTY = new Set(['air', 'leaf_litter', 'short_grass', 'water', 'seagrass', 'torch', 'vine'])
const WET = { extra: [{ name: 'minecraft:water', properties: { liquid_depth: 0 } }] }
// The pickaxe tier a block needs (actions/mining.js PICK, as far as these boxes hold).
const NEEDS = { stone: 1, cobblestone: 1, andesite: 1, diorite: 1, granite: 1, dripstone_block: 1, coal_ore: 1, iron_ore: 2, copper_ore: 2 }
const TIERS = { wooden: 1, stone: 2, iron: 3, diamond: 4 }
const FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
// The block states the physics needs. Leaves as received under the feet at the tree (persistent_bit 0, update_bit 0);
// logs upright, leaf litter flat and torches standing where only the name was read.
const STATES = name => /_leaves$/.test(name) ? { persistent_bit: 0, update_bit: 0 } : /_log$/.test(name) ? { pillar_axis: 'y' } : name === 'leaf_litter' ? { growth: 0, 'minecraft:cardinal_direction': 'south' } : name === 'water' ? { liquid_depth: 0 } : name === 'torch' ? { torch_facing_direction: 'top' } : {}
const block = name => ({ known: true, name: `minecraft:${name}`, boundingBox: EMPTY.has(name) ? 'empty' : 'block', properties: STATES(name), extra: name === 'seagrass' ? WET.extra : [] })

// received: { x0, z0, feet, legend, rows: { y: [row of z, a character per x] }, states?: { 'x,y,z': block states } }.
// outside(x, y, z): the block where nothing was read (a name, or null for a cell not received).
function createDigWorld (received, { outside = () => 'stone', items = [{ slot: 0, name: 'minecraft:iron_pickaxe', count: 1, durabilityKnown: true, durabilityRemaining: 200 }], health = 20, logs = false } = {}) {
  const mined = new Set()
  let revision = 1
  const key = (x, y, z) => `${x},${y},${z}`
  const put = new Map(), opened = new Set()
  const getBlock = (x, y, z) => {
    if (put.has(key(x, y, z))) return block(put.get(key(x, y, z)))
    if (mined.has(key(x, y, z))) return block('air')
    const c = received.rows[y]?.[z - received.z0]?.[x - received.x0]
    // received.states: the block states read for single cells (a door's open_bit, a chest's facing).
    if (c) { const states = received.states?.[key(x, y, z)]; return states ? { ...block(received.legend[c]), properties: opened.has(key(x, y, z)) ? { ...states, open_bit: 1 } : states } : block(received.legend[c]) }
    const name = outside(x, y, z)
    return name ? block(name) : { known: false }
  }
  const navigator = createNavigator({ world: { getBlock, revision: () => revision } })
  let state = navigator.physics.fromServer({ position: { x: received.feet.x, y: received.feet.y + 1.62, z: received.feet.z }, rotation: { yaw: 0, pitch: 0 }, gameMode: 'survival' })
  for (let i = 0; i < 20; i++) state = navigator.physics.step(state, {})
  const w = { lines: [], minedNames: [], placed: [], trips: [], failures: [], uses: {}, swaps: 0, at: 0, corrections: 0, clicks: [], getBlock }
  const SELECTED = 0
  const inHand = () => items.find(item => item.slot === SELECTED && item.count > 0)
  const tierInHand = () => TIERS[/^minecraft:(\w+)_pickaxe$/.exec(inHand()?.name ?? '')?.[1]] ?? 0
  const bareName = cell => getBlock(cell.x, cell.y, cell.z).name?.replace('minecraft:', '')
  const LESSER = cell => `適切なツルハシの装備を確認できません: ${bareName(cell)}`
  const lesser = cell => !['hand_dig', 'pillar_descent'].includes(cell.accessPreparation) && (NEEDS[bareName(cell)] ?? 0) > tierInHand()
  const wet = found => /water|seagrass/.test(found.name ?? '')
  const open = (x, y, z) => { const found = getBlock(x, y, z); return found.known === true && found.boundingBox === 'empty' && !wet(found) && found.name !== 'minecraft:vine' }
  // The mining check's own rule (actions/mining.js): a block with liquid on one of its six sides is refused.
  const BESIDE_LIQUID = '対象の隣に液体・落下ブロックなどがあります。'
  const besideLiquid = cell => FACES.some(([dx, dy, dz]) => wet(getBlock(cell.x + dx, cell.y + dy, cell.z + dz)))
  const visible = cell => {
    const found = getBlock(cell.x, cell.y, cell.z)
    const treePlant = cell.accessPreparation === 'tree_access' && (found.name === 'minecraft:vine' || found.name === 'minecraft:leaf_litter' || /^minecraft:[a-z0-9_]+_leaves$/.test(found.name)) && found.name === cell.expectedName
    if (found.known !== true || (!treePlant && found.boundingBox === 'empty') || (!treePlant && (logs ? /leaves/ : /leaves|_log$/).test(found.name))) return false
    const eye = { x: state.position.x, y: state.position.y + 1.62, z: state.position.z }
    return FACES.some(([dx, dy, dz]) => {
      if (!open(cell.x + dx, cell.y + dy, cell.z + dz)) return false
      const to = { x: cell.x + 0.5 + dx * 0.5, y: cell.y + 0.5 + dy * 0.5, z: cell.z + 0.5 + dz * 0.5 }
      const far = Math.hypot(to.x - eye.x, to.y - eye.y, to.z - eye.z)
      if (far > 5) return false
      for (let i = 1, n = Math.ceil(far / 0.05); i < n; i++) {
        const x = Math.floor(eye.x + (to.x - eye.x) * i / n), y = Math.floor(eye.y + (to.y - eye.y) * i / n), z = Math.floor(eye.z + (to.z - eye.z) * i / n)
        if (!(x === cell.x && y === cell.y && z === cell.z) && !open(x, y, z)) return false
      }
      return true
    })
  }
  const REFUSED = '射程内の採掘面への視線が遮られているか、未取得です。'
  const placeable = (position, slot) => {
    const row = items.find(item => item.slot === slot && item.count > 0)
    const eye = { x: state.position.x, y: state.position.y + 1.62, z: state.position.z }
    const solid = ([dx, dy, dz]) => { const found = getBlock(position.x + dx, position.y + dy, position.z + dz); return found.known === true && found.boundingBox === 'block' }
    return !!row && getBlock(position.x, position.y, position.z).boundingBox === 'empty' && FACES.some(solid) && Math.hypot(position.x + 0.5 - eye.x, position.y + 0.5 - eye.y, position.z + 0.5 - eye.z) <= 5
  }
  const place = ({ position, slot }) => {
    if (!placeable(position, slot)) throw new Error('設置できません。')
    const row = items.find(item => item.slot === slot && item.count > 0)
    row.count--
    w.put(position, row.name.replace('minecraft:', ''))
    w.placed.push({ ...position, name: row.name.replace('minecraft:', '') })
  }
  const operations = {
    perception: { entities: () => [] },
    inventory: { equip: async slot => {
      if (slot === SELECTED) return { phase: 'completed', slot: SELECTED, sourceSlot: slot, selectedSlotChanged: false }
      const moved = items.find(item => item.slot === slot && item.count > 0), was = inHand()
      if (moved) moved.slot = SELECTED
      if (was) was.slot = slot
      w.swaps++
      return { phase: 'completed', slot: SELECTED, sourceSlot: slot }
    } },
    movement: {
      // The ordinary settle: ticks with no input, the body falls to what is under it.
      settle ({ maxTicks = 40 } = {}) { for (let i = 0; i < maxTicks && !state.onGround; i++) state = navigator.physics.step(state, {}) },
      start (target, { maxTicks, ...options } = {}) {
      const route = navigator.plan(state, target, options)
      if (!route.ready) throw new Error(route.reason)
      const stepper = navigator.createStepper(route, state)
      // The server lets no body into a closed door: the feet are put back where they last stood outside it.
      const shut = at => { const cell = [Math.floor(at.x), Math.floor(at.y + 0.001), Math.floor(at.z)], found = getBlock(...cell); return isDoor(found) && !openDoorCell(getBlock, ...cell) }
      w.motion = { phase: 'completed', reason: null }
      for (let i = 0; i < 400; i++) {
        const frame = stepper.next()
        if (shut(frame.predictedState.position)) { w.motion = { phase: 'replan_required', reason: 'Server correction replayed through sent input; replan from the corrected present prediction' }; w.corrections++; break }
        state = frame.predictedState
        if (frame.phase !== 'moving') break
      }
    } },
    // An ordinary placement: into a received open cell with a solid block on one of its sides, within reach. The
    // block is received and the item leaves the bag.
    interactions: { placeBlock: async data => place(data),
      // An ordinary click on a wooden door within reach: its lower half is received open.
      useDoor: async at => {
        const found = getBlock(at.x, at.y, at.z)
        if (!isDoor(found) || Math.hypot(at.x + 0.5 - state.position.x, at.z + 0.5 - state.position.z) > 4.5) throw new Error('受信した木のドアがありません。')
        opened.add(key(at.x, at.y, at.z)); revision++; w.clicks.push({ ...at })
      },
      // The floor block over a gap is clicked against a face of a solid block beside the cell (player-scaffold-ports.js `bridge`).
      previewPlaceAgainst: ({ position, slot, clicked }) => placeable(position, slot) && getBlock(clicked.x, clicked.y, clicked.z).boundingBox === 'block' ? { ready: true } : { ready: false, errors: ['設置できません。'] },
      placeAgainst: async data => place(data) },
    mining: {

      preview: ([cell]) => besideLiquid(cell) ? { ready: false, errors: [BESIDE_LIQUID] } : !visible(cell) ? { ready: false, errors: [REFUSED] } : lesser(cell) ? { ready: false, errors: [LESSER(cell)] } : { ready: true },
      start ([cell]) {
        if (besideLiquid(cell)) throw new Error(BESIDE_LIQUID)
        if (!visible(cell)) throw new Error(REFUSED)
        if (lesser(cell)) throw new Error(LESSER(cell))
        const name = bareName(cell), tool = inHand()
        if (/_(?:pickaxe|sword|shovel|axe)$/.test(tool?.name ?? '')) {
          const kind = tool.name.replace('minecraft:', '')
          w.uses[kind] = (w.uses[kind] ?? 0) + 1
          if (Number.isFinite(tool.durabilityRemaining)) tool.durabilityRemaining -= /_sword$/.test(kind) ? 2 : 1
        }
        put.delete(key(cell.x, cell.y, cell.z)); mined.add(key(cell.x, cell.y, cell.z)); revision++
        w.minedNames.push(name)
        const drop = DROPS[name]
        if (!drop) return
        const row = items.find(item => item.name === `minecraft:${drop}`)
        if (row) row.count++; else items.push({ slot: items.length, name: `minecraft:${drop}`, count: 1 })
      }
    }
  }
  const getFeet = () => ({ ...state.position })
  // One pillar step, as the server answers it: a carried fill block received under the feet, the feet one higher,
  // one block less. Only on the ground with two open cells over the head; otherwise nothing changes.
  const FILL = ['minecraft:dirt', 'minecraft:cobblestone', 'minecraft:cobbled_deepslate']
  const pillarStep = async ({ column, feetY, material }) => {
    const row = items.find(item => item.count > 0 && (material ? item.name === material : item.name === 'minecraft:dirt'))
    const at = w.cell()
    if (!row || !FILL.includes(row.name) || at.x !== column.x || at.z !== column.z || at.y !== feetY || !state.onGround || !open(at.x, at.y + 2, at.z)) return { status: 'blocked', reason: 'PILLAR_REFUSED' }
    row.count--
    w.put(at, row.name.replace('minecraft:', ''))
    w.placed.push({ ...at, name: row.name.replace('minecraft:', '') })
    state = navigator.physics.fromServer({ position: { x: at.x + 0.5, y: at.y + 1 + 1.62, z: at.z + 0.5 }, rotation: { yaw: 0, pitch: 0 }, gameMode: 'survival' })
    for (let i = 0; i < 20; i++) state = navigator.physics.step(state, {})
    return { status: 'completed', serverConfirmed: true }
  }
  const inventory = () => ({ known: true, items: items.filter(item => item.count > 0) })
  const hands = createScaffoldPorts({ operations, getBlock, getFeet, getInventory: inventory, getMotion: () => w.motion ?? { phase: 'idle' }, log: line => w.lines.push(line), getHealth: () => health, getHeld: () => inHand() ?? null, pillarStep, sleep: async ms => { w.at += ms }, now: () => w.at })
  // What the expedition hands to a step (dragon-runtime.js), as far as the gathering reads it.
  w.ctx = {
    memory: { early: {} }, shared: {}, log: line => w.lines.push(line), cancelled: () => false, operations, hands, getFeet, getBlock,
    runtime: { raw: () => ({ dimension: 'overworld', heldItem: inHand() ?? null }), inventory },
    walk: target => hands.walk(target),
    travelTo: async input => { w.trips.push(input) },
    goal: { fail: failure => { w.failures.push(failure) }, mark: () => {}, reached: () => {}, step: () => {} }
  }
  // A block the Bot put down (a placement's received block).
  w.put = (cell, name) => { put.set(key(cell.x, cell.y, cell.z), name); revision++ }
  w.count = name => items.reduce((sum, item) => sum + (item.name === `minecraft:${name}` ? item.count : 0), 0)
  w.cell = () => { const at = getFeet(); return { x: Math.floor(at.x), y: Math.floor(at.y + 0.001), z: Math.floor(at.z) } }
  w.onGround = () => state.onGround
  return w
}

module.exports = { createDigWorld, block }
