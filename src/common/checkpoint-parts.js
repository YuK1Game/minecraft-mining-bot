'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')

// Explicit immutable records are kept out of ordinary intent/receipt copies
// and durable replacements. Every part is durable before its manifest changes.
const hash = text => createHash('sha256').update(text).digest('hex')
const invalid = () => Object.assign(new Error('Invalid checkpoint part'), { code: 'CHECKPOINT_PART_INVALID' })
const get = (value, keys) => keys.reduce((node, key) => node?.[key], value)
const deeplyFrozen = new WeakSet()
function set (value, keys, part) {
  let node = value
  for (const key of keys.slice(0, -1)) { if (!node?.[key]) return; node[key] = { ...node[key] }; node = node[key] }
  if (node && Object.hasOwn(node, keys.at(-1))) node[keys.at(-1)] = part
}
function freeze (value) {
  if (!value || typeof value !== 'object' || deeplyFrozen.has(value)) return value
  for (const child of Object.values(value)) freeze(child)
  Object.freeze(value)
  deeplyFrozen.add(value)
  return value
}

function createCheckpointParts ({ filename, paths, limit, write, io = fs.promises, freezeInputs = false }) {
  const pinned = new WeakMap(), parts = new Map(), directory = filename + '.parts'
  let publishedParts = null
  function pin (value) {
    if (!value || typeof value !== 'object') return null
    let part = pinned.get(value)
    if (!part) {
      const text = JSON.stringify(value), bytes = Buffer.byteLength(text)
      if (bytes > limit) throw invalid()
      const id = hash(text)
      part = parts.get(id)
      if (!part) { part = { id, bytes, value: freeze(JSON.parse(text)), written: false }; parts.set(id, part) }
      if (freezeInputs) freeze(value)
      if (deeplyFrozen.has(value)) pinned.set(value, part)
      pinned.set(part.value, part)
    }
    parts.set(part.id, part)
    return part
  }
  function split (value) {
    const core = { ...value }, references = []
    for (const keys of paths) {
      const part = pin(get(value, keys))
      if (part) { set(core, keys, { checkpointPart: part.id, bytes: part.bytes }); references.push({ keys, part }) }
    }
    return { core, references }
  }
  function copy (value) {
    const { core, references } = split(value), result = structuredClone(core)
    for (const { keys, part } of references) set(result, keys, part.value)
    return result
  }
  function signature (value) { return JSON.stringify(split(value).core) }
  function readers (value) {
    const references = []
    for (const keys of paths) {
      const reference = get(value, keys)
      if (reference == null) continue
      if (!/^[a-f0-9]{64}$/.test(reference.checkpointPart) || !Number.isSafeInteger(reference.bytes) || reference.bytes < 0) throw invalid()
      references.push({ keys, reference, file: path.join(directory, reference.checkpointPart + '.json') })
    }
    if (Buffer.byteLength(JSON.stringify(value)) + references.reduce((n, { reference }) => n + reference.bytes, 0) > limit) throw invalid()
    return references
  }
  function receive (value, { keys, reference }, saved) {
    const text = JSON.stringify(saved.value)
    if (saved.version !== 1 || hash(text) !== reference.checkpointPart || Buffer.byteLength(text) !== reference.bytes) throw invalid()
    const part = pin(saved.value); part.written = true
    set(value, keys, part.value)
  }
  function restoreSync (value) {
    for (const ref of readers(value)) {
      try {
        if (fs.statSync(ref.file).size > limit) throw invalid()
        receive(value, ref, JSON.parse(fs.readFileSync(ref.file, 'utf8')))
      } catch (cause) { throw Object.assign(invalid(), { cause }) }
    }
    return copy(value)
  }
  async function restore (value) {
    const { readJsonBounded } = require('./durable-json')
    for (const ref of readers(value)) {
      try { receive(value, ref, await readJsonBounded(ref.file, { io, maxBytes: limit })) } catch (cause) { throw Object.assign(invalid(), { cause }) }
    }
    return copy(value)
  }
  async function save (value, document = core => core) {
    const { core, references } = split(value)
    const bytes = Buffer.byteLength(JSON.stringify(core)) + references.reduce((n, { part }) => n + part.bytes, 0)
    if (bytes > limit) throw Object.assign(new Error('Checkpoint exceeds its size bound'), { code: 'DOCUMENT_TOO_LARGE' })
    // Publish all dependencies durably before replacing the manifest. Failure
    // leaves the previous manifest, including an outstanding intent, readable.
    for (const { part } of references) {
      const file = path.join(directory, part.id + '.json')
      // A different store generation may have retired this immutable part.
      // A metadata lookup is bounded; never reserialize the large record just
      // to check it, and never publish a reference to a deleted dependency.
      if (part.written) try { if (!(await io.stat(file)).isFile()) throw invalid() } catch (error) { if (error.code !== 'ENOENT') throw error; part.written = false }
      if (!part.written) {
        publishedParts = null
        await write(file, { version: 1, value: part.value }, { io, maxBytes: limit })
        part.written = true
      }
    }
    const receipt = await write(filename, document(core), { io, maxBytes: limit })
    const retained = new Set(references.map(({ part }) => part.id))
    const partsKey = [...retained].join(',')
    // Replaced plans and historical archive versions must not accumulate.
    // Cleanup is after publication, never a prerequisite for a valid receipt.
    if (partsKey !== publishedParts) try {
      for (const name of await io.readdir(directory)) if (/^[a-f0-9]{64}\.json$/.test(name) && !retained.has(name.slice(0, -5))) {
        await io.unlink(path.join(directory, name))
        const old = parts.get(name.slice(0, -5)); if (old) old.written = false
        parts.delete(name.slice(0, -5))
      }
      publishedParts = partsKey
    } catch (error) { if (error.code === 'ENOENT') publishedParts = partsKey }
    return receipt
  }
  return { copy, signature, restore, restoreSync, save }
}

module.exports = { createCheckpointParts, freeze }
