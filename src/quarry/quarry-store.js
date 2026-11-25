'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const { readJsonBounded, writeDurableJson, MAX_BYTES } = require('../common/durable-json')
const { createCheckpointParts } = require('../common/checkpoint-parts')
const { validateJobId, documentInstance, documentWorld, sameWorld, failure } = require('./quarry-job-identity')
// Serializes callers of this loaded module. Runtime disposal drains outstanding
// writes before hot reload. Separate processes must use separate work directories.
const writes = new Map()
// Identity this process already read back from disk (or wrote) per file.
// Re-reading and parsing a large job document before every checkpoint
// blocked the event loop for hundreds of ms; the alias/collision checks only
// need to run until the file is known to belong to this job instance.
const verified = new Map()
async function enqueue (file, operation) {
  const key = file.toLowerCase(), previous = writes.get(key) ?? Promise.resolve()
  const task = previous.catch(() => {}).then(operation)
  writes.set(key, task)
  try { return await task } finally { if (writes.get(key) === task) writes.delete(key) }
}
function createQuarryStore ({ directory, onSaved = () => {}, io = fs, write = writeDurableJson } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new TypeError('Quarry store requires an absolute directory')
  const filename = id => path.join(directory, `${validateJobId(id)}.json`)
  const parts = new Map()
  const checkpoint = file => {
    if (!parts.has(file)) parts.set(file, createCheckpointParts({ filename: file, paths: [['records']], limit: MAX_BYTES, write, io }))
    return parts.get(file)
  }
  const persist = (file, doc) => checkpoint(file).save(doc, core => ({ ...core, checkpointParts: 1 }))
  async function save (id, doc) {
    const file = filename(id)
    if (doc?.config?.jobId !== id || !documentWorld(doc)) throw failure('JOB_DOCUMENT_IDENTITY_INVALID')
    return enqueue(file, async () => {
      const known = verified.get(file)
      if (known && known.io === io && known.instance === documentInstance(doc) && sameWorld(known.world, documentWorld(doc))) {
        const receipt = await persist(file, doc)
        onSaved(doc, receipt)
        return receipt
      }
      await io.mkdir(directory, { recursive: true })
      // Reject case-folded aliases even on Linux, so a checkout moved to
      // Windows does not suddenly start overwriting another job.
      const names = await io.readdir(directory)
      if (names.some(name => name.toLowerCase() === path.basename(file).toLowerCase() && name !== path.basename(file))) throw failure('JOB_ID_COLLISION')
      let existing
      try { existing = await readJsonBounded(file, { io }) } catch (error) { if (error.code !== 'ENOENT') throw error }
      if (existing && (existing.config?.jobId !== id || documentInstance(existing) !== documentInstance(doc) || !sameWorld(documentWorld(existing), documentWorld(doc)))) throw failure('JOB_ID_COLLISION')
      const receipt = await persist(file, doc)
      verified.set(file, { io, instance: documentInstance(doc), world: documentWorld(doc) })
      onSaved(doc, receipt)
      return receipt
    })
  }
  async function load (id) {
    const file = filename(id)
    // Own the queue through manifest AND part reads, so a subsequent save
    // cannot collect a part that this reader is still about to open.
    return enqueue(file, async () => {
      const doc = await readJsonBounded(file, { io })
      if (doc?.config?.jobId !== id) throw failure('JOB_DOCUMENT_IDENTITY_INVALID')
      if (doc.checkpointParts !== undefined && doc.checkpointParts !== 1) throw failure('JOB_DOCUMENT_IDENTITY_INVALID')
      if (doc.checkpointParts === 1) {
        delete doc.checkpointParts
        return checkpoint(file).restore(doc)
      }
      return doc
    })
  }
  async function list () {
    let names
    try { names = await io.readdir(directory) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
    names = names.filter(name => name.endsWith('.json'))
    if (names.length > 1000) throw failure('TOO_MANY_QUARRY_DOCUMENTS')
    const docs = []
    for (const name of names) {
      const id = name.slice(0, -5)
      // Invalid filenames are not silently mapped to valid ones.
      validateJobId(id)
      docs.push(await load(id))
    }
    return docs
  }
  return { save, load, list }
}
module.exports = { createQuarryStore }
