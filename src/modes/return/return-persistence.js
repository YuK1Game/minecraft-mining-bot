'use strict'

const path = require('node:path')

// The host and its shared object survive a hot reload; this module does not.
// Keep the pending writes there, outside the serializable goal. An old write
// already inside fsync/rename must finish before a new runtime saves a newer
// goal or a cancellation. A per-runner (or per-module) promise cannot do that.
const QUEUES = Symbol.for('minecraft-realms-bot.player-return-writes')

function queueReturnWrite (shared, file, document, write) {
  if (!shared[QUEUES]) Object.defineProperty(shared, QUEUES, { value: new Map() })
  const queues = shared[QUEUES], key = path.resolve(file)
  const pending = (queues.get(key) ?? Promise.resolve()).then(() => write(file, document))
  // A failed write is reported to its caller but must not block the next one.
  const tail = pending.then(() => {}, () => {})
  queues.set(key, tail)
  void tail.then(() => { if (queues.get(key) === tail) queues.delete(key) })
  return pending
}

module.exports = { queueReturnWrite }
