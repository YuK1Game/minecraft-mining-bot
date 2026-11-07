'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const { readJsonBounded, writeDurableJson } = require('./durable-json')
const { validateJobId, documentInstance, documentWorld, sameWorld, failure } = require('./quarry-job-identity')
// Serializes callers of this loaded module. Runtime disposal drains outstanding
// writes before hot reload. Separate processes must use separate work directories.
const writes = new Map()
function createQuarryStore ({ directory, onSaved = () => {}, io = fs, write = writeDurableJson } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new TypeError('Quarry store requires an absolute directory')
  const filename = id => path.join(directory, `${validateJobId(id)}.json`)
  async function save (id, doc) {
    const file = filename(id)
    if (doc?.config?.jobId !== id || !documentWorld(doc)) throw failure('JOB_DOCUMENT_IDENTITY_INVALID')
    const key = file.toLowerCase(), previous = writes.get(key) ?? Promise.resolve()
    const task = previous.catch(() => {}).then(async () => {
      await io.mkdir(directory, { recursive: true })
      // Reject case-folded aliases even on Linux, so a checkout moved to
      // Windows does not suddenly start overwriting another job.
      const names = await io.readdir(directory)
      if (names.some(name => name.toLowerCase() === path.basename(file).toLowerCase() && name !== path.basename(file))) throw failure('JOB_ID_COLLISION')
      let existing
      try { existing = await readJsonBounded(file, { io }) } catch (error) { if (error.code !== 'ENOENT') throw error }
      if (existing && (existing.config?.jobId !== id || documentInstance(existing) !== documentInstance(doc) || !sameWorld(documentWorld(existing), documentWorld(doc)))) throw failure('JOB_ID_COLLISION')
      const receipt = await write(file, doc, { io })
      onSaved(doc, receipt)
      return receipt
    })
    writes.set(key, task)
    try { return await task } finally { if (writes.get(key) === task) writes.delete(key) }
  }
  async function load (id) {
    const doc = await readJsonBounded(filename(id), { io })
    if (doc?.config?.jobId !== id) throw failure('JOB_DOCUMENT_IDENTITY_INVALID')
    return doc
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
