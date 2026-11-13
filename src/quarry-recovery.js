'use strict'

const { documentWorld, worldIdentity, sameWorld } = require('./quarry-job-identity')
// SLOW_BREAK_PERSISTS (2026-11-13 16:03): server lag that ended in a disconnect.
const RESUMABLE = /^(?:PROCESS_RESTARTED|DISCONNECTED|ACTION_FAILED|STORAGE_UNREACHABLE|RECOVERY_NOT_PROGRESSING|HEALTH_NOT_RECOVERING|SLOW_BREAK_PERSISTS)(?::|$)/
function recoverable (doc) {
  if (!doc || doc.requestedStop || doc.state === 'FINISHED' || ['CANCELLED', 'COMPLETED', 'COMPLETED_WITH_EXCEPTIONS', 'FINISHED'].includes(doc.result?.type) || doc.persistence?.status === 'failed') return false
  if (['stopped', 'cancelled'].includes(doc.userRunIntent)) return false
  if (doc.userRunIntent !== 'running' && !(doc.userRunIntent === 'paused' && doc.pauseReason === 'PROCESS_RESTARTED')) return false
  return doc.state !== 'PAUSED' || RESUMABLE.test(doc.pauseReason ?? '')
}
function selectRecoveryCandidate (docs, state, now = Date.now()) {
  const world = worldIdentity(state)
  if (!world) return null
  // The latest matching job is authoritative. A newer manual stop/completion
  // must not cause us to resurrect an older unfinished job.
  const latest = docs.filter(doc => sameWorld(documentWorld(doc), world) && Number.isFinite(Date.parse(doc.savedAt))).sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt))[0]
  const age = now - Date.parse(latest?.savedAt)
  return latest && age >= 0 && age < 24 * 3600e3 && recoverable(latest) ? latest : null
}
function retryableRecoveryError (error) { return ['EAGAIN', 'EBUSY', 'EIO', 'EMFILE', 'ENFILE', 'ESTALE', 'ETIMEDOUT', 'QUARRY_BUSY', 'RECOVERY_CONTEXT_CHANGED'].includes(error?.code) }
module.exports = { RESUMABLE, recoverable, selectRecoveryCandidate, retryableRecoveryError }
