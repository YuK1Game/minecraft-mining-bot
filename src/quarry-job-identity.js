'use strict'

const { createHash, randomUUID } = require('node:crypto')
const failure = code => Object.assign(new Error(code), { code })

// Reject, never sanitize: two different caller IDs must not address one file.
function validateJobId (id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(id) || id.endsWith('.') || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(id)) throw failure('INVALID_JOB_ID')
  return id
}
function newJobId () { return `quarry_${randomUUID()}` }
function worldIdentity (state) {
  const profile = state?.profile
  const rawId = state?.realm?.id ?? state?.realmId
  const dimension = typeof state?.dimension === 'string' ? state.dimension.replace(/^minecraft:/, '') : null
  if (typeof profile !== 'string' || !profile || !['string', 'number'].includes(typeof rawId) || !String(rawId) || !['overworld', 'nether', 'end'].includes(dimension)) return null
  return { profile, realmId: String(rawId), dimension }
}
function documentWorld (doc) {
  if (doc?.world != null) return worldIdentity(doc.world)
  // Legacy snapshots already contain the original world. Never adopt the
  // currently connected world when that evidence is absent or malformed.
  try {
    const [profile, realmId, dimension] = JSON.parse(doc?.scope)
    return worldIdentity({ profile, realmId, dimension })
  } catch { return null }
}
function sameWorld (a, b) { return !!a && !!b && a.profile === b.profile && a.realmId === b.realmId && a.dimension === b.dimension }
function assertJobWorld (doc, state) {
  const expected = documentWorld(doc), actual = worldIdentity(state)
  if (!expected || !actual) throw failure('WORLD_IDENTITY_UNKNOWN')
  if (!sameWorld(expected, actual) || doc.config?.dimension?.replace(/^minecraft:/, '') !== expected.dimension) throw failure('WORLD_MISMATCH')
  return expected
}
function documentInstance (doc) {
  if (typeof doc?.instanceId === 'string' && doc.instanceId) return doc.instanceId
  return 'legacy:' + createHash('sha256').update(JSON.stringify([doc?.config?.jobId, doc?.scope ?? null, doc?.startedAt ?? null])).digest('hex')
}
module.exports = { validateJobId, newJobId, worldIdentity, documentWorld, sameWorld, assertJobWorld, documentInstance, failure }
