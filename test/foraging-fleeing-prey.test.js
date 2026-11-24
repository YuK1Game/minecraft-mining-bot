'use strict'

// A hit animal that runs off is run down where it is going (src/survival/prey-lead.js), with a sprint.
// User 2026-11-24 18:07 JST: 「友好モブに攻撃した場合、友好モブはすぐに逃げてしまうので、それを追いかけて攻撃すると時間が
// かかるので、すばやく倒してほしい」. Before, the walk went to a stand beside where the sheep was received and was stopped
// and planned again whenever the sheep was 3 m from that place, without a sprint.
// Real here: survival/foraging.js (the hunt, the stands, the chase) and prey-lead.js. Stand-ins: a flat stone field,
// the walk (a Bot moving toward its stand, 0.215 blocks a tick walking, 0.28 sprinting), the sheep (received
// positions; after a hit it runs straight away from the Bot for 3 s at 0.16 blocks a tick) and the hit's answer
// (5 damage within 2.8 m, a sheep of 8 health, a hit every 0.5 s). Their speeds are a model, not the game's.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createForaging } = require('../src/survival/foraging')

const WALK = 0.215, SPRINT = 0.28, PANIC = 0.16, PANIC_MS = 3000, TICK = 50

function field ({ turnAt = null } = {}) {
  let time = 1000, sinceTick = 0
  const state = { phase: 'spawned', runtimeEntityId: '1', dimension: 'overworld', connectionId: 'c', startedAt: 's', gameMode: 'survival', health: 20, position: { x: 0.5, y: 66.62, z: 0.5 }, rawSelectedSlot: 0, inventory: { known: true, items: [] } }
  state.rawServerPosition = { ...state.position }
  state.rawServerPositionUpdatedAt = time
  const sheep = { runtimeId: '2', uniqueId: '-2', kind: 'mob', entityType: 'minecraft:sheep', dimension: 'overworld', positionKnown: true, alive: true, hostile: false, position: { x: 3.5, y: 65, z: 0.5 } }
  const s = { time: () => time, starts: 0, stops: 0, sprints: 0, hits: 0, health: 8, panicUntil: 0, flee: null, velocity: { x: 0, z: 0 }, killedAt: null }
  let move = null
  const world = { getBlock: (x, y, z) => ({ known: true, name: y < 65 ? 'minecraft:stone' : 'minecraft:air', boundingBox: y < 65 ? 'block' : 'empty', extra: [] }) }
  function tick () {
    // The sheep: runs from the Bot while it panics, then stands.
    if (time < s.panicUntil && sheep.alive) {
      if (turnAt && time >= turnAt.at && !s.turned) { s.turned = true; s.flee = { x: -s.flee.z, z: s.flee.x } }
      s.velocity = { x: s.flee.x * PANIC, z: s.flee.z * PANIC }
      sheep.position = { ...sheep.position, x: sheep.position.x + s.velocity.x, z: sheep.position.z + s.velocity.z }
    } else s.velocity = { x: 0, z: 0 }
    if (move) {
      const speed = move.sprint ? SPRINT : WALK
      const dx = move.target.x - state.position.x, dz = move.target.z - state.position.z, d = Math.hypot(dx, dz)
      if (d <= speed) { state.position = { x: move.target.x, y: move.target.y + 1.62, z: move.target.z }; move = null; s.phase = { phase: 'completed' } }
      else state.position = { ...state.position, x: state.position.x + dx / d * speed, z: state.position.z + dz / d * speed }
      state.rawServerPosition = { ...state.position }; state.rawServerPositionUpdatedAt = time; state.positionSource = 'server'
    }
  }
  const movement = {
    preview: () => ({ ready: true }),
    start: (target, options) => { s.starts++; if (options.sprint) s.sprints++; move = { target: { ...target }, sprint: options.sprint === true }; s.phase = { phase: 'moving' }; return s.phase },
    stop: () => { s.stops++; move = null; s.phase = { phase: 'stopped' } }
  }
  s.phase = { phase: 'idle' }
  let lastHit = -Infinity
  const reach = () => Math.hypot(sheep.position.x - state.position.x, sheep.position.y - state.position.y, sheep.position.z - state.position.z)
  const combat = {
    previewHunt: () => ({ ready: sheep.alive && reach() <= 2.8, cooldownRemainingMs: Math.max(0, 500 - (time - lastHit)) }),
    hunt: async id => {
      assert.ok(!move, 'a hit is swung standing')
      if (reach() > 2.8 || time - lastHit < 500) throw new Error('連打を避けるため次の攻撃まで待ってください。')
      lastHit = time; s.hits++; s.health -= 5
      if (s.health <= 0) { sheep.alive = false; s.killedAt = time; state.inventory.items = [{ slot: 2, name: 'minecraft:mutton', count: 1 }]; return { phase: 'observed', targetRuntimeId: id, reaction: 'death_animation' } }
      const dx = sheep.position.x - state.position.x, dz = sheep.position.z - state.position.z, d = Math.hypot(dx, dz) || 1
      s.flee = { x: dx / d, z: dz / d }; s.panicUntil = time + PANIC_MS
      return { phase: 'observed', targetRuntimeId: id, reaction: 'hurt_animation' }
    },
    cancel: () => {}
  }
  const entities = { snapshot: () => [structuredClone(sheep)], motion: () => time < s.panicUntil ? { velocity: { x: s.velocity.x, y: 0, z: s.velocity.z }, stationary: false } : { velocity: { x: 0, y: 0, z: 0 }, stationary: true } }
  const foraging = createForaging({ getState: () => ({ ...state, threatPolicy: 'online_learning', entities: sheep.alive ? [structuredClone(sheep)] : [] }), world, entities, movement,
    getMovement: () => structuredClone(s.phase), combat, clock: () => time,
    delay: async ms => { sinceTick += ms; time += ms; while (sinceTick >= TICK) { sinceTick -= TICK; tick() } } })
  s.foraging = foraging
  return s
}

// The expedition asks the hunt again every two seconds after a batch (dragon-early-food.js); here at once.
async function huntDown (s, batches = 8) {
  const started = s.time()
  for (let n = 0; n < batches && s.killedAt === null; n++) await s.foraging.execute({ maxSteps: 8, maxHits: 8, timeoutMs: 30000 })
  return s.killedAt === null ? null : s.killedAt - started
}

test('a sheep running straight off after the first hit is run down with a sprint, without a stop every second', async () => {
  const s = field()
  const took = await huntDown(s)
  assert.notEqual(took, null, 'the sheep was killed')
  assert.equal(s.hits, 2)
  assert.ok(s.sprints > 0 && s.sprints === s.starts, `every walk of the chase asked for a sprint (${s.sprints}/${s.starts})`)
  assert.ok(took <= 4000, `killed in ${took} ms`)
  assert.ok(s.starts <= 3, `${s.starts} walks`)
})

test('a sheep that turns while running is caught again from its new track', async () => {
  const s = field({ turnAt: { at: 1000 + 1500 } })
  const took = await huntDown(s)
  assert.notEqual(took, null, 'the sheep was killed')
  assert.ok(took <= 6000, `killed in ${took} ms`)
})
