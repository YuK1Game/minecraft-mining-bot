'use strict'

// One shape for what a step of the return to the base answers. The caller
// decides from `status` and `code`, never from the Japanese text shown to the
// user (that is `detail`, for the log only).
// - completed: the received data shows the step's end condition.
// - partial: part is confirmed by received data, the rest is left.
// - blocked: a precondition is missing; `retry` says what has to change.
// - failed: this way does not work; another way is needed.
// - interrupted: something with priority (a fight, a meal, a flee) took the
//   controls; the goal goes on afterwards.
// - cancelled: the player stopped, or the mode changed.
const STATUSES = Object.freeze(['completed', 'partial', 'blocked', 'failed', 'interrupted', 'cancelled'])

// What has to change before the same step is worth trying again.
// - now: nothing; try again at once (bounded by the attempt counts).
// - owner_released: the operation that holds the controls has ended.
// - inventory_update: the inventory is received again.
// - container_update: the chest's contents are received.
// - terrain_received: the terrain in question is received.
// - position_changed: the Bot stands somewhere else (another route).
// - supplies_changed: wood, chests or tools are held that were not.
// - build_free: the house work or the chest waiting to be received that kept a new chest from being made is over.
// - time: only for the network and for things that move by themselves.
const RETRIES = Object.freeze(['now', 'owner_released', 'inventory_update', 'container_update', 'terrain_received', 'position_changed', 'supplies_changed', 'build_free', 'time'])

function result (status, code, { progress = {}, remaining = null, evidence = null, retry = null, detail = null } = {}) {
  if (!STATUSES.includes(status)) throw new Error(`Unknown return status: ${status}`)
  if (typeof code !== 'string' || !code) throw new Error('A return result needs a code')
  if (retry && !RETRIES.includes(retry.kind)) throw new Error(`Unknown retry kind: ${retry.kind}`)
  return { status, code, progress: { ...progress }, remaining, evidence, retry: retry ? { ...retry } : null, detail: detail == null ? null : String(detail).slice(0, 160) }
}

const completed = (code, extra) => result('completed', code, extra)
const partial = (code, extra) => result('partial', code, extra)
const blocked = (code, retry, extra) => result('blocked', code, { ...extra, retry })
const failed = (code, extra) => result('failed', code, extra)
const interrupted = (code, extra) => result('interrupted', code, extra)
const cancelled = (code, extra) => result('cancelled', code, extra)

module.exports = { STATUSES, RETRIES, result, completed, partial, blocked, failed, interrupted, cancelled }
