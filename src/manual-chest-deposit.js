'use strict'

const { randomUUID } = require('node:crypto')
const { observedScope } = require('./server-position-verifier')
const { validateJobId } = require('./quarry-job-identity')
const copy = value => structuredClone(value)
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const point = p => p && ['x', 'y', 'z'].every(k => Number.isSafeInteger(p[k]) && Math.abs(p[k]) < 30000000)
const empty = row => row?.known === true && row.empty === true && row.count === 0
const known = row => empty(row) || row?.known === true && row.empty !== true && typeof row.name === 'string' && Number.isSafeInteger(row.count) && row.count > 0
const worldOf = s => JSON.stringify([s.profile, String(s.realm.id), s.dimension])
const fullView = view => view?.known === true && !view.uncertain && Array.isArray(view.slots) && view.slots.length === 36 && view.slots.every(known) && view.armor?.known === true && Array.isArray(view.armor.slots) && view.armor.slots.length === 4 && view.armor.slots.every(known) && view.offhand?.known === true && Array.isArray(view.offhand.slots) && view.offhand.slots.length === 1 && view.offhand.slots.every(known)
const stacksOf = view => {
  const result = { main: view.slots.filter(row => !empty(row)).length, armor: view.armor.slots.filter(row => !empty(row)).length, offhand: view.offhand.slots.filter(row => !empty(row)).length }
  return { ...result, total: result.main + result.armor + result.offhand }
}
const fail = code => Object.assign(new Error('収納操作を確認できませんでした。' + code), { code })
const safeError = error => {
  const code = /^[A-Z][A-Z0-9_]{0,99}$/.test(error?.code ?? '') ? error.code : 'MANUAL_DEPOSIT_FAILED'
  return { code, message: '収納操作を確認できませんでした。' + code }
}
const operationId = value => { try { return validateJobId(value) } catch { throw fail('MANUAL_DEPOSIT_OPERATION_INVALID') } }

function createManualChestDeposit ({ adapter, now = Date.now, uuid = randomUUID } = {}) {
  const required = ['getState', 'getView', 'getBlock', 'inventoryIdentity', 'generation', 'jobIdentity', 'assertIdle', 'acquire', 'release', 'open', 'close', 'container', 'runDeposit', 'save', 'load', 'cancelTransfers']
  if (required.some(name => typeof adapter?.[name] !== 'function')) throw new TypeError('Manual deposit requires observed inventory, normal chest operations and durable checkpoints')
  let preview = null, active = null, task = null, preparing = null, owner = null, lastError = null
  function frame (inventory = true) {
    const state = adapter.getState(), scope = observedScope(state)
    if (!scope || !['survival', 0].includes(state.gameMode) || !state.position || !['x', 'y', 'z'].every(k => Number.isFinite(state.position[k]))) throw fail('MANUAL_DEPOSIT_NOT_READY')
    const feet = { x: Math.floor(state.position.x), y: Math.floor(state.position.y - 1.62 + 0.001), z: Math.floor(state.position.z) }
    if (!point(feet)) throw fail('MANUAL_DEPOSIT_NOT_READY')
    const result = { state, scope, feet, world: worldOf(state), life: state.lifecycle.deathId, generation: adapter.generation(), jobIdentity: copy(adapter.jobIdentity()) }
    if (inventory) {
      const view = adapter.getView()
      if (!fullView(view) || state.inventory?.known !== true || state.inventory.uncertain) throw fail('MANUAL_DEPOSIT_INVENTORY_UNKNOWN')
      let identity
      try { identity = adapter.inventoryIdentity() } catch { throw fail('MANUAL_DEPOSIT_INVENTORY_UNKNOWN') }
      if (typeof identity !== 'string' || !identity) throw fail('MANUAL_DEPOSIT_INVENTORY_UNKNOWN')
      Object.assign(result, { identity, stacks: stacksOf(view) })
    }
    return result
  }
  function validate (bound, inventory, signal) {
    signal?.throwIfAborted()
    const current = frame(inventory)
    if (current.scope !== bound.scope || current.world !== bound.world || !same(current.feet, bound.feet) || current.generation !== bound.generation || !same(current.jobIdentity, bound.jobIdentity)) throw fail('MANUAL_DEPOSIT_CONTEXT_CHANGED')
    if (inventory && current.identity !== bound.identity) throw fail('MANUAL_DEPOSIT_INVENTORY_CHANGED')
    if (bound.position && !chestReachable(bound.position, current.state)) throw fail('MANUAL_DEPOSIT_CHEST_UNREACHABLE')
    return current
  }
  function chestReachable (position, state) {
    if (!point(position) || position.y < -64 || position.y > 319 || Math.hypot(position.x + 0.5 - state.position.x, position.y + 0.5 - state.position.y, position.z + 0.5 - state.position.z) > 4.5) return false
    const block = adapter.getBlock(position.x, position.y, position.z)
    return block?.known === true && block.name === 'minecraft:chest' && !block.extra?.length
  }
  function container (position, requireEmpty) {
    const box = adapter.container()
    if (box?.known !== true || box.slotCount !== 54 || !Array.isArray(box.slots) || box.slots.length !== 54 || !same(box.position, position) || !box.slots.every(known)) throw fail('MANUAL_DEPOSIT_CHEST_UNCONFIRMED')
    if (requireEmpty && !box.slots.every(empty)) throw fail('MANUAL_DEPOSIT_CHEST_NOT_EMPTY')
    return box
  }
  async function open (run, position, requireEmpty) {
    if (!chestReachable(position, frame(false).state)) throw fail('MANUAL_DEPOSIT_CHEST_UNREACHABLE')
    const receipt = await adapter.open(copy(position), { signal: run.controller.signal, expectedSlots: 54 })
    if (receipt?.serverConfirmed === true) run.opened = true
    if (receipt?.serverConfirmed !== true || receipt.slotCount !== 54) throw fail('MANUAL_DEPOSIT_CHEST_UNCONFIRMED')
    container(position, requireEmpty)
  }
  async function closeOwned (run) {
    if (!run.opened) return
    run.opened = false
    await adapter.close()
  }
  function checkpoint (cp, doc) {
    if (cp == null) return null
    let world
    try { const [profile, realm, dimension] = JSON.parse(cp.world); world = JSON.stringify([profile, String(realm), dimension]) } catch { throw fail('MANUAL_DEPOSIT_CHECKPOINT_INVALID') }
    if (cp.version !== 1 || cp.direction !== 'deposit' || cp.operationId !== doc.operationId || cp.jobId !== doc.jobId || !same(cp.position, doc.position) || world !== doc.world || cp.life !== JSON.stringify([cp.world, doc.life])) throw fail('MANUAL_DEPOSIT_CHECKPOINT_INVALID')
    return copy(cp)
  }
  async function persist (doc) {
    doc.updatedAt = now()
    try { await adapter.save(copy(doc)) } catch { throw fail('MANUAL_DEPOSIT_PERSISTENCE_FAILED') }
  }
  function progress (doc) {
    const count = doc?.checkpoint?.index
    return Number.isSafeInteger(count) && count >= 0 && count <= 54 ? count : 0
  }
  function refreshProgress (doc) {
    try { const view = adapter.getView(); if (fullView(view)) { doc.remainingStacks = stacksOf(view).total; return } } catch {}
    doc.remainingStacks = Math.max(0, (doc.totalStacks ?? doc.remainingStacks ?? 0) - progress(doc))
  }
  function status () {
    const doc = preview ? preview.stored : owner?.doc ?? active
    return { available: true, busy: !!task || !!preparing, phase: preparing ? 'preparing' : preview ? 'ready' : doc?.phase ?? 'idle', operationId: preparing?.id ?? preview?.operationId ?? doc?.operationId ?? null,
      serverConfirmed: !preview && !task && !preparing && doc?.phase === 'completed' && doc.serverConfirmed === true, target: copy(preview?.position ?? doc?.position ?? null),
      transferredStacks: progress(doc), remainingStacks: preview?.stacks.total ?? doc?.remainingStacks ?? null, error: copy(preview ? null : doc?.error ?? lastError) }
  }
  async function prepare ({ operationId: requested } = {}) {
    if (task || preparing) throw fail('MANUAL_DEPOSIT_BUSY')
    preview = null; lastError = null
    adapter.assertIdle()
    const basic = frame(false), requestedId = requested == null ? null : operationId(requested), run = { id: requestedId, controller: new AbortController(), opened: false, acquired: false }
    run.done = new Promise(resolve => { run.finished = resolve })
    preparing = run
    try {
      let stored = requestedId ? await adapter.load(requestedId) : typeof adapter.loadPending === 'function' ? await adapter.loadPending() : null
      validate(basic, false, run.controller.signal)
      if (stored?.phase === 'completed' && stored.serverConfirmed === true) {
        if (requestedId) throw fail('MANUAL_DEPOSIT_ALREADY_COMPLETED')
        stored = null
      }
      if (requestedId && !stored) throw fail('MANUAL_DEPOSIT_RESUME_SCOPE_CHANGED')
      const id = operationId(stored?.operationId ?? requestedId ?? uuid()); run.id = id
      if (stored) {
        if (stored.version !== 1 || stored.operationId !== id || stored.jobId !== 'manual_chest_' + id || !point(stored.position)) throw fail('MANUAL_DEPOSIT_CHECKPOINT_INVALID')
        active = copy(stored); active.phase = 'paused'; active.serverConfirmed = false; active.error = null
        if (stored.scope !== basic.scope || stored.world !== basic.world || stored.life !== basic.life) {
          active.error = safeError({ code: 'MANUAL_DEPOSIT_RESUME_SCOPE_CHANGED' })
          throw fail('MANUAL_DEPOSIT_RESUME_SCOPE_CHANGED')
        }
      }
      if (stored) checkpoint(stored.checkpoint, stored)
      run.acquired = true; await adapter.acquire(id, { scope: basic.scope, signal: run.controller.signal, preview: true, identity: null })
      validate(basic, false, run.controller.signal)
      const current = frame()
      if (current.stacks.total === 0 && !stored?.checkpoint) throw fail('MANUAL_DEPOSIT_NOTHING_TO_STORE')
      const candidates = []
      if (stored) candidates.push(copy(stored.position))
      else for (let x = current.feet.x - 4; x <= current.feet.x + 4; x++) for (let z = current.feet.z - 4; z <= current.feet.z + 4; z++) for (let y = current.feet.y - 2; y <= current.feet.y + 2; y++) {
        const position = { x, y, z }
        if (chestReachable(position, current.state)) candidates.push(position)
      }
      const distance = p => Math.hypot(p.x + 0.5 - current.state.position.x, p.y + 0.5 - current.state.position.y, p.z + 0.5 - current.state.position.z)
      candidates.sort((a, b) => distance(a) - distance(b) || a.x - b.x || a.y - b.y || a.z - b.z)
      let selected = null
      for (const position of candidates.slice(0, 8)) {
        validate(current, true, run.controller.signal)
        try { await open(run, position, !stored?.checkpoint); selected = position } catch (error) {
          if (run.controller.signal.aborted || stored) throw error
        } finally { await closeOwned(run) }
        validate(current, true, run.controller.signal)
        if (selected) break
      }
      if (!selected) throw fail('MANUAL_DEPOSIT_NO_EMPTY_DOUBLE_CHEST')
      preview = { ...current, state: undefined, operationId: id, token: uuid(), expiresAt: now() + 120000, position: copy(selected), stored: stored ? copy(stored) : null }
      return { token: preview.token, expiresAt: preview.expiresAt, operationId: id, position: copy(selected), slotCount: 54, resume: stored != null, stacks: copy(current.stacks),
        target: { position: copy(selected), realm: current.state.realm.name ?? '', player: current.state.playerName ?? current.state.profile, dimension: current.state.dimension } }
    } catch (error) { preview = null; lastError = safeError(error); throw error } finally {
      try { await closeOwned(run) } finally {
        try { if (run.acquired) await adapter.release(run.id) } finally { if (preparing === run) preparing = null; run.finished() }
      }
    }
  }
  function start ({ token, confirm } = {}) {
    const prepared = preview; preview = null
    if (task || preparing) throw fail('MANUAL_DEPOSIT_BUSY')
    if (!prepared || token !== prepared.token || confirm !== 'STORE_ALL_IN_EMPTY_CHEST' || prepared.expiresAt <= now()) throw fail('MANUAL_DEPOSIT_CONFIRMATION_REQUIRED')
    adapter.assertIdle(); validate(prepared, true)
    if (!chestReachable(prepared.position, frame(false).state)) throw fail('MANUAL_DEPOSIT_CHEST_UNREACHABLE')
    const doc = { ...(prepared.stored ?? {}), version: 1, operationId: prepared.operationId, jobId: 'manual_chest_' + prepared.operationId, scope: prepared.scope, world: prepared.world, life: prepared.life,
      feet: copy(prepared.feet), position: copy(prepared.position), generation: prepared.generation, jobIdentity: copy(prepared.jobIdentity), identity: prepared.identity,
      checkpoint: copy(prepared.stored?.checkpoint ?? null), totalStacks: prepared.stacks.total + progress(prepared.stored), remainingStacks: prepared.stacks.total, phase: 'preparing', serverConfirmed: false, error: null, createdAt: prepared.stored?.createdAt ?? now(), updatedAt: now() }
    const run = { id: doc.operationId, doc, controller: new AbortController(), opened: false, acquired: false }
    active = doc; owner = run; lastError = null
    const promise = Promise.resolve().then(() => execute(run, prepared))
    const tracked = promise.finally(() => { if (task === tracked) task = null; if (owner === run) owner = null })
    task = tracked
    return status()
  }
  async function execute (run, prepared) {
    const doc = run.doc, signal = run.controller.signal
    let watcher
    try {
      run.acquired = true; await adapter.acquire(run.id, { scope: doc.scope, signal, preview: false, identity: prepared.identity })
      validate(prepared, true, signal)
      await open(run, doc.position, !doc.checkpoint)
      validate(prepared, true, signal)
      doc.phase = 'running'; await persist(doc)
      validate(prepared, true, signal); container(doc.position, !doc.checkpoint)
      watcher = setInterval(() => {
        try { const current = validate(doc, false, signal); if (!chestReachable(doc.position, current.state)) throw fail('MANUAL_DEPOSIT_CHEST_UNREACHABLE') } catch (error) {
          if (!signal.aborted) {
            run.interrupted = error; run.controller.abort(error)
            try { void Promise.resolve(adapter.cancelTransfers(run.id, error.code)).catch(() => {}) } catch {}
          }
        }
      }, 50)
      const response = await adapter.runDeposit({ jobId: doc.jobId, operationId: doc.operationId, position: copy(doc.position), checkpoint: copy(doc.checkpoint) }, {
        signal, onCheckpoint: async cp => {
          if (owner !== run) throw fail('MANUAL_DEPOSIT_CHECKPOINT_STALE')
          doc.checkpoint = checkpoint(cp, doc)
          refreshProgress(doc)
          try { await persist(doc) } catch (error) { run.interrupted = error; run.controller.abort(error); throw error }
          signal.throwIfAborted()
          try { validate(doc, false, signal) } catch (error) { run.interrupted = error; run.controller.abort(error); throw error }
        }
      })
      if (response?.checkpoint != null) doc.checkpoint = checkpoint(response.checkpoint, doc)
      if (run.interrupted) throw run.interrupted
      signal.throwIfAborted(); validate(doc, false, signal)
      if (response?.status !== 'completed' || response.serverConfirmed !== true) {
        doc.phase = 'paused'; doc.error = safeError({ code: response?.reason ?? 'MANUAL_DEPOSIT_TRANSFER_UNCONFIRMED' }); refreshProgress(doc); await persist(doc); return
      }
      const final = frame()
      if (final.stacks.total !== 0 || !doc.checkpoint || doc.checkpoint.phase !== 'completed') throw fail('MANUAL_DEPOSIT_FINAL_INVENTORY_UNCONFIRMED')
      doc.remainingStacks = 0
      await persist({ ...copy(doc), phase: 'completed', serverConfirmed: true, completedAt: now() })
      validate(doc, false, signal); if (frame().stacks.total !== 0) throw fail('MANUAL_DEPOSIT_FINAL_INVENTORY_UNCONFIRMED')
      doc.phase = 'completed'; doc.serverConfirmed = true; doc.error = null
    } catch (error) {
      doc.phase = signal.aborted && !run.interrupted ? 'paused' : 'failed'; doc.serverConfirmed = false
      doc.error = safeError(run.interrupted ?? (signal.aborted ? { code: 'MANUAL_DEPOSIT_CANCELLED' } : error))
      try { const view = adapter.getView(); if (fullView(view)) doc.remainingStacks = stacksOf(view).total } catch {}
      try { await persist(doc) } catch { doc.phase = 'failed'; doc.error = safeError({ code: 'MANUAL_DEPOSIT_PERSISTENCE_FAILED' }) }
    } finally {
      clearInterval(watcher)
      try { await closeOwned(run) } catch { /* Ownership-aware adapter retains any unrelated UI. */ }
      if (run.acquired) { try { await adapter.release(run.id) } catch {} }
    }
  }
  function cancel () {
    preview = null
    const run = owner ?? preparing
    if (run) {
      run.controller.abort(fail('MANUAL_DEPOSIT_CANCELLED'))
      try { void Promise.resolve(adapter.cancelTransfers(run.id, 'MANUAL_DEPOSIT_CANCELLED')).catch(() => {}) } catch {}
    }
    return status()
  }
  return { prepare, start, status, cancel, drain: () => task ?? preparing?.done ?? Promise.resolve() }
}

module.exports = { createManualChestDeposit }
