'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { writeDurableJson } = require('../common/durable-json')

const DIMENSIONS = ['overworld', 'nether', 'end']
const STAGES = ['early', 'nether', 'stronghold', 'end', 'complete']
const LIMIT = 1024 * 1024
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const point = p => p && [p.x, p.y, p.z].every(Number.isFinite) ? { x: p.x, y: p.y, z: p.z } : null
function initial () {
  return { stage: 'early', early: {}, nether: {}, stronghold: {}, end: {}, lastDimension: null, lastDeath: null, lastTransition: null, lastLife: null, recovery: null }
}

function createDragonState ({ root, shared, getState, getLife = () => null, getWorldId = () => null, write = writeDurableJson }) {
  // Shared with the next behavior generation so an older pending write cannot
  // win a rename race against the reloaded runtime.
  const stores = shared.dragonCheckpointStores ??= new Map()
  const issued = new WeakMap()
  function environment () {
    const state = getState()
    const dimension = DIMENSIONS[state?.dimension] ?? state?.dimension
    if (!DIMENSIONS.includes(dimension) || !state?.profile || state.realm?.id == null) return null
    const worldId = getWorldId() ?? state.worldSeed
    const key = JSON.stringify([String(state.profile), String(state.realm.id), worldId == null ? null : String(worldId)])
    const life = getLife() ?? state.lifecycle ?? state
    const connectionId = state.connectionId == null ? null : String(state.connectionId)
    const deathId = Number.isSafeInteger(life.deathId) && life.deathId >= 0 ? life.deathId : null
    const dead = state.dead === true || life.dead === true || state.health === 0
    const fence = JSON.stringify([key, connectionId, state.startedAt, String(state.runtimeEntityId), deathId, dead, dimension, shared.dragonDimensionTransition?.sequence ?? 0])
    return { key, dimension, connectionId, deathId, dead, fence, position: point(state.rawServerPosition ?? (state.positionSource !== 'client_prediction' && state.position)) }
  }
  function store (env) {
    if (!env) return null
    if (!stores.has(env.key)) {
      const filename = path.join(root, '.local', 'dragon-expedition', createHash('sha256').update(env.key).digest('hex') + '.json')
      let value = initial()
      try {
        if (fs.statSync(filename).size > LIMIT) throw Error('ドラゴン遠征の保存データが大きすぎます。')
        const doc = JSON.parse(fs.readFileSync(filename, 'utf8'))
        if (doc.version !== 1 || doc.scope !== env.key || !STAGES.includes(doc.value?.stage) || !STAGES.slice(0, 4).every(key => object(doc.value[key]))) throw Error('ドラゴン遠征の保存データを読み取れません。')
        value = { ...initial(), ...doc.value }
      } catch (error) { if (error.code !== 'ENOENT') throw error }
      stores.set(env.key, { filename, value, revision: 0, lastPose: null, queue: Promise.resolve() })
    }
    return stores.get(env.key)
  }
  function enqueue (entry, fn) {
    const job = entry.queue.then(fn)
    entry.queue = job.catch(() => {})
    return job
  }
  async function replace (entry, env, value) {
    if (JSON.stringify(entry.value) === JSON.stringify(value)) return true
    await write(entry.filename, { version: 1, scope: env.key, savedAt: new Date().toISOString(), value }, { maxBytes: LIMIT })
    entry.value = value
    entry.revision++
    return true
  }
  function record () {
    const env = environment(), entry = store(env)
    if (!entry) return null
    const copy = structuredClone(entry.value)
    issued.set(copy, { revision: entry.revision, fence: env.fence })
    return copy
  }
  async function save (value) {
    const env = environment(), issuedAt = issued.get(value)
    if (!env || issuedAt?.fence !== env.fence) return false
    const entry = store(env), copy = structuredClone(value)
    if (!STAGES.includes(copy.stage) || !STAGES.slice(0, 4).every(key => object(copy[key]))) throw Error('ドラゴン遠征の段階が不正です。')
    return enqueue(entry, async () => {
      if (issuedAt.revision !== entry.revision || environment()?.fence !== env.fence) return false
      const result = await replace(entry, env, copy)
      issuedAt.revision = entry.revision
      return result
    })
  }
  async function observe () {
    const env = environment(), entry = store(env)
    if (!entry) return false
    return enqueue(entry, async () => {
      const current = entry.value
      const life = current.lastLife
      const sameConnection = life && life.connectionId === env.connectionId
      const newDeath = env.deathId != null && (sameConnection ? env.deathId > (life.deathId ?? 0) : env.deathId > 0)
      const deadNow = env.dead && !(sameConnection && life.dead && env.deathId === life.deathId)
      let value = current
      if (newDeath || deadNow) {
        const receipt = shared.dragonDeathLocation
        const from = receipt?.connectionId === env.connectionId && receipt.deathId === env.deathId ? receipt : null
        const dimension = from?.dimension ?? (env.dead ? env.dimension : current.lastDimension) ?? env.dimension
        const position = from?.position ?? (env.dead && env.dimension === dimension ? env.position : entry.lastPose?.dimension === dimension ? entry.lastPose.position : null)
        const at = from?.at ?? Date.now()
        const recent = current.lastDeath && current.lastDeath.stage === current.stage && at - current.lastDeath.at <= 15 * 60000
        value = { ...current, lootRecovery: null, lastDeath: { stage: current.stage, at }, recovery: { fromStage: current.stage, dimension, position, deathId: env.deathId, cause: from?.cause ?? null, at, repeated: !!recent } }
      }
      const transition = shared.dragonDimensionTransition
      if (transition && transition.connectionId === env.connectionId && transition.to === env.dimension && (current.lastTransition?.connectionId !== transition.connectionId || current.lastTransition?.sequence !== transition.sequence)) value = { ...value, lastTransition: structuredClone(transition) }
      if (value !== current || current.lastDimension !== env.dimension || !sameConnection || life.deathId !== env.deathId || life.dead !== env.dead) {
        await replace(entry, env, { ...value, lastDimension: env.dimension, lastLife: { connectionId: env.connectionId, deathId: env.deathId, dead: env.dead } })
      }
      if (!env.dead && env.position) entry.lastPose = { dimension: env.dimension, position: env.position }
      return true
    })
  }
  // Capture a death/portal boundary even between scheduler ticks (or right
  // before disconnect). Only an active player's existing record is observed.
  shared.flushDragonCheckpoints = () => Promise.all([...stores.values()].map(entry => entry.queue))
  shared.persistDragonBoundary = () => {
    if (shared.botMode === 'player' && shared.playerWanted === true && stores.size) return observe()
  }
  return { record, save, observe, snapshot: () => { const entry = store(environment()); return entry ? structuredClone(entry.value) : null } }
}

module.exports = { createDragonState }
