'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { createMissionMemory } = require('./mission-memory')

const VERSION = 1
const MAX_BYTES = 128 * 1024
const MAX_SCOPES = 16
const MAX_LANDMARKS = 64
const SOURCES = new Set(['observed_dry_candidate', 'established_shelter_history'])
const HAZARD = /(?:water|lava|fire|cactus|magma|campfire|powder_snow|cobweb|wither_rose|pointed_dripstone|sweet_berry_bush|concrete_powder|anvil|(?:^|:)(?:air|cave_air|void_air)$)/
const copy = value => structuredClone(value)
const horizontal = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)

function scopeOf (input) {
  if (!input || typeof input.profile !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(input.profile) || !['overworld', 'nether', 'end'].includes(input.dimension)) throw new Error('Invalid shore landmark scope')
  const value = input.realmId ?? input.realm?.id
  if (!(typeof value === 'string' && /^\d{1,20}$/.test(value) || typeof value === 'number' && Number.isSafeInteger(value) && value > 0 || typeof value === 'bigint' && value > 0n)) throw new Error('Invalid shore landmark Realm')
  const realmId = BigInt(value)
  if (realmId <= 0n || realmId > (1n << 64n) - 1n) throw new Error('Invalid shore landmark Realm')
  return { profile: input.profile, realmId: String(realmId), dimension: input.dimension }
}
const scopeKey = scope => JSON.stringify([scope.profile, scope.realmId, scope.dimension])
function point (value) {
  if (!value || !['x', 'y', 'z'].every(axis => Number.isFinite(value[axis])) || Math.abs(value.x) > 30000000 || Math.abs(value.z) > 30000000 || value.y < -64 || value.y > 322) throw new Error('Invalid shore landmark position')
  return { x: value.x, y: value.y, z: value.z }
}
function landmark (value) {
  if (!value || !SOURCES.has(value.source) || !Number.isSafeInteger(value.recordedAt) || value.recordedAt < 0) throw new Error('Invalid shore landmark observation')
  const result = { position: point(value.position), source: value.source, recordedAt: value.recordedAt }
  if (result.position.y > 320) throw new Error('Invalid shore landmark elevation')
  return result
}

// Landmarks are remembered observations used only to rank independently
// checked short routes. This store never supplies terrain, a ready route,
// current safety, an arrival receipt, or permission to enter unknown blocks.
function createShoreLandmarks ({ workspaceRoot, clock = Date.now } = {}) {
  if (typeof workspaceRoot !== 'string' || !path.isAbsolute(workspaceRoot) || typeof clock !== 'function') throw new Error('Shore landmarks require an absolute workspace')
  const root = path.resolve(workspaceRoot)
  const directory = path.join(root, '.local')
  const filename = path.join(directory, 'shore-landmarks.json')
  if (root.split(/[\\/]/).some(part => part.toLowerCase() === '.auth')) throw new Error('Invalid shore landmark directory')
  const scopes = new Map()
  let writeQueue = Promise.resolve()

  async function safeDirectory (create) {
    if (create) await fs.mkdir(directory, { recursive: false }).catch(error => { if (error.code !== 'EEXIST') throw error })
    const stat = await fs.lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || path.dirname(filename) !== directory) throw new Error('Unsafe shore landmark directory')
    const existing = await fs.lstat(filename).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.size > MAX_BYTES)) throw new Error('Unsafe shore landmark file')
  }
  function remember (scope, incoming) {
    const key = scopeKey(scope)
    const previous = scopes.get(key)?.landmarks ?? []
    const merged = [...previous]
    for (const item of incoming) {
      const found = merged.findIndex(old => horizontal(old.position, item.position) < 0.75 && Math.abs(old.position.y - item.position.y) <= 1)
      if (found >= 0) {
        if (item.recordedAt >= merged[found].recordedAt) merged[found] = item
      } else merged.push(item)
    }
    merged.sort((a, b) => b.recordedAt - a.recordedAt)
    scopes.delete(key); scopes.set(key, { scope, landmarks: merged.slice(0, MAX_LANDMARKS) })
    while (scopes.size > MAX_SCOPES) scopes.delete(scopes.keys().next().value)
  }
  function entries (requested) {
    const scope = scopeOf(requested)
    return copy(scopes.get(scopeKey(scope))?.landmarks ?? [])
  }
  function rememberSurvey (requested, survey) {
    const scope = scopeOf(requested)
    if (!survey || survey.observationOnly !== true || !Number.isInteger(survey.radius) || survey.radius < 1 || survey.radius > 64 || !Array.isArray(survey.candidates) || survey.candidates.length > 20 || !Number.isSafeInteger(survey.knownCandidateCount) || survey.knownCandidateCount < survey.candidates.length) throw new Error('Invalid shore survey receipt')
    const origin = point(survey.origin)
    const time = clock()
    if (!Number.isSafeInteger(time) || time < 0) throw new Error('Invalid shore landmark clock')
    const incoming = survey.candidates.map(candidate => {
      const position = point(candidate)
      const measured = horizontal(origin, position)
      if (!Number.isFinite(candidate.distance) || Math.abs(measured - candidate.distance) > 0.01 || measured > survey.radius + 1e-6 || position.y < Math.floor(origin.y - 1.62) || position.y > Math.floor(origin.y - 1.62) + 4 || typeof candidate.floor !== 'string' || !/^minecraft:[a-z0-9_]+$/.test(candidate.floor) || HAZARD.test(candidate.floor)) throw new Error('Invalid observed dry shore candidate')
      return landmark({ position, source: 'observed_dry_candidate', recordedAt: time })
    })
    remember(scope, incoming)
    return { remembered: incoming.length, observationOnly: true, requiresWorldValidation: true }
  }
  async function seedShelterHistory (requested) {
    const scope = scopeOf(requested)
    const result = await createMissionMemory({ workspaceRoot: root }).load(scope)
    const memo = result.shelterMemo
    if (result.status !== 'loaded' || memo?.established !== true || !memo.site?.outsideStandpoint || !Array.isArray(memo.placements) || !memo.placements.some(receipt => receipt.serverConfirmed === true && ['received_dirt_and_inventory_decrease', 'received_dirt_and_inventory_after_resume'].includes(receipt.confirmedBy))) return { remembered: 0, status: result.status, observationOnly: true }
    const item = landmark({ position: memo.site.outsideStandpoint, source: 'established_shelter_history', recordedAt: clock() })
    remember(scope, [item])
    return { remembered: 1, landmark: copy(item), observationOnly: true, requiresWorldValidation: true }
  }
  function directionScore (requested, originValue, targetValue) {
    const origin = point(originValue); const target = point(targetValue)
    const available = entries(requested)
    if (!available.length || horizontal(origin, target) > 24) return null
    available.sort((a, b) => horizontal(origin, a.position) - horizontal(origin, b.position) || b.recordedAt - a.recordedAt)
    const chosen = available[0]
    const remaining = horizontal(target, chosen.position)
    const progress = horizontal(origin, chosen.position) - remaining
    return { progress, alignment: horizontal(origin, target) > 1e-6 ? progress / horizontal(origin, target) : 0, remaining, landmark: copy(chosen), observationOnly: true, requiresWorldValidation: true }
  }
  async function load () {
    await writeQueue.catch(() => {})
    try {
      await safeDirectory(false)
      const text = await fs.readFile(filename, 'utf8')
      if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('Oversized shore landmark file')
      const data = JSON.parse(text)
      if (data?.version !== VERSION || !Array.isArray(data.scopes) || data.scopes.length > MAX_SCOPES) throw new Error('Unsupported shore landmark file')
      const restored = new Map()
      for (const entry of data.scopes) {
        const scope = scopeOf(entry?.scope)
        if (restored.has(scopeKey(scope)) || !Array.isArray(entry.landmarks) || entry.landmarks.length > MAX_LANDMARKS) throw new Error('Invalid shore landmark entries')
        restored.set(scopeKey(scope), { scope, landmarks: entry.landmarks.map(landmark) })
      }
      scopes.clear(); for (const [key, value] of restored) scopes.set(key, value)
      return { status: 'loaded', scopes: scopes.size, observationOnly: true }
    } catch (error) {
      if (error.code === 'ENOENT') return { status: 'missing', observationOnly: true }
      return { status: 'rejected', reason: error.message, observationOnly: true }
    }
  }
  function save () {
    const data = `${JSON.stringify({ version: VERSION, scopes: [...scopes.values()] }, null, 2)}\n`
    if (Buffer.byteLength(data, 'utf8') > MAX_BYTES) return Promise.reject(new Error('Oversized shore landmark file'))
    const write = writeQueue.catch(() => {}).then(async () => {
      await safeDirectory(true)
      const temporary = path.join(directory, `.shore-landmarks-${randomUUID()}.tmp`)
      try {
        await fs.writeFile(temporary, data, { flag: 'wx', mode: 0o600 })
        await fs.rename(temporary, filename)
      } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
      return { saved: true, observationOnly: true }
    })
    writeQueue = write
    return write
  }
  return { load, save, flush: () => writeQueue, rememberSurvey, seedShelterHistory, entries, directionScore, snapshot: () => ({ scopeCount: scopes.size, landmarkCount: [...scopes.values()].reduce((count, entry) => count + entry.landmarks.length, 0), observationOnly: true }) }
}

module.exports = { createShoreLandmarks }
