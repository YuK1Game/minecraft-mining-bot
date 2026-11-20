'use strict'

// A received box of blocks with the Bot in it, for the expedition's gathering (dragon-supply-gather.js `collect`).
// Real: the navigation's planner and physics (movement/navigation.js), the scaffold's hands (player-scaffold-ports.js)
// and everything above them that the test calls.
// Stand-in, and only this: the server. It agrees with every predicted step. A block is mined when one of its faces is
// open, within reach, and in a straight line of open cells from the eye; its drop is in the inventory at once. Leaves
// and logs are refused (leaves are never mined). The long trip is recorded, not walked. Its success is not the game's.
const { createNavigator } = require('../../src/movement/navigation')
const { createScaffoldPorts } = require('../../src/modes/player-scaffold-ports')

const DROPS = { coal_ore: 'coal', iron_ore: 'raw_iron', stone: 'cobblestone', andesite: 'andesite', diorite: 'diorite', granite: 'granite', dirt: 'dirt', grass_block: 'dirt' }
const EMPTY = new Set(['air', 'leaf_litter', 'short_grass'])
const FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
// The block states the physics needs. Leaves as received under the feet at the tree (persistent_bit 0, update_bit 0);
// logs upright and leaf litter flat where only the name was read.
const STATES = name => /_leaves$/.test(name) ? { persistent_bit: 0, update_bit: 0 } : /_log$/.test(name) ? { pillar_axis: 'y' } : name === 'leaf_litter' ? { growth: 0, 'minecraft:cardinal_direction': 'south' } : {}
const block = name => ({ known: true, name: `minecraft:${name}`, boundingBox: EMPTY.has(name) ? 'empty' : 'block', properties: STATES(name), extra: [] })

// received: { x0, z0, feet, legend, rows: { y: [row of z, a character per x] } }.
// outside(x, y, z): the block where nothing was read (a name, or null for a cell not received).
function createDigWorld (received, { outside = () => 'stone', items = [{ slot: 0, name: 'minecraft:iron_pickaxe', count: 1, durabilityKnown: true, durabilityRemaining: 200 }], health = 20 } = {}) {
  const mined = new Set()
  let revision = 1
  const key = (x, y, z) => `${x},${y},${z}`
  const getBlock = (x, y, z) => {
    if (mined.has(key(x, y, z))) return block('air')
    const c = received.rows[y]?.[z - received.z0]?.[x - received.x0]
    if (c) return block(received.legend[c])
    const name = outside(x, y, z)
    return name ? block(name) : { known: false }
  }
  const navigator = createNavigator({ world: { getBlock, revision: () => revision } })
  let state = navigator.physics.fromServer({ position: { x: received.feet.x, y: received.feet.y + 1.62, z: received.feet.z }, rotation: { yaw: 0, pitch: 0 }, gameMode: 'survival' })
  for (let i = 0; i < 20; i++) state = navigator.physics.step(state, {})
  const w = { lines: [], minedNames: [], trips: [], failures: [], at: 0, getBlock }
  const open = (x, y, z) => { const found = getBlock(x, y, z); return found.known === true && found.boundingBox === 'empty' }
  const visible = cell => {
    const found = getBlock(cell.x, cell.y, cell.z)
    if (found.known !== true || found.boundingBox === 'empty' || /leaves|_log$/.test(found.name)) return false
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
  const operations = {
    perception: { entities: () => [] },
    inventory: { equip: async slot => ({ phase: 'completed', slot }) },
    movement: { start (target, { maxTicks, ...options } = {}) {
      const route = navigator.plan(state, target, options)
      if (!route.ready) throw new Error(route.reason)
      const stepper = navigator.createStepper(route, state)
      for (let i = 0; i < 400; i++) { const frame = stepper.next(); state = frame.predictedState; if (frame.phase !== 'moving') break }
    } },
    mining: {
      preview: ([cell]) => visible(cell) ? { ready: true } : { ready: false, errors: [REFUSED] },
      start ([cell]) {
        if (!visible(cell)) throw new Error(REFUSED)
        const name = getBlock(cell.x, cell.y, cell.z).name.replace('minecraft:', '')
        mined.add(key(cell.x, cell.y, cell.z)); revision++
        w.minedNames.push(name)
        const drop = DROPS[name]
        if (!drop) return
        const row = items.find(item => item.name === `minecraft:${drop}`)
        if (row) row.count++; else items.push({ slot: items.length, name: `minecraft:${drop}`, count: 1 })
      }
    }
  }
  const getFeet = () => ({ ...state.position })
  const inventory = () => ({ known: true, items })
  const hands = createScaffoldPorts({ operations, getBlock, getFeet, getInventory: inventory, getMotion: () => ({ phase: 'idle' }), getHealth: () => health, pillarStep: async () => ({ ok: false }), sleep: async ms => { w.at += ms }, now: () => w.at })
  // What the expedition hands to a step (dragon-runtime.js), as far as the gathering reads it.
  w.ctx = {
    memory: { early: {} }, shared: {}, log: line => w.lines.push(line), cancelled: () => false, operations, hands, getFeet, getBlock,
    runtime: { raw: () => ({ dimension: 'overworld' }), inventory },
    walk: target => hands.walk(target),
    travelTo: async input => { w.trips.push(input) },
    goal: { fail: failure => { w.failures.push(failure) }, mark: () => {}, reached: () => {}, step: () => {} }
  }
  w.count = name => items.reduce((sum, item) => sum + (item.name === `minecraft:${name}` ? item.count : 0), 0)
  w.cell = () => { const at = getFeet(); return { x: Math.floor(at.x), y: Math.floor(at.y + 0.001), z: Math.floor(at.z) } }
  w.onGround = () => state.onGround
  return w
}

module.exports = { createDigWorld, block }
