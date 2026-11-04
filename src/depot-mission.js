'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const { createBaseContinuation, continuationScope } = require('./base-continuation')
const clone = value => structuredClone(value)

// A durable scheduler for ordinary scoped controllers. It owns no transport.
function createDepotMission ({ getState, world, getRawItem, workspaceRoot, dispatch, onProgress = () => {}, intervalMs = 1500 }) {
  let enabled = false, closed = false, suspended = false, timer = null, inFlight = null, controller = null
  let policy = null, worldKey = null, filename = null, saved = null, extra = {}, failures = 0, protectedCache = [], protectedKeys = new Set()
  let status = { enabled: false, busy: false, phase: 'disabled', actions: 0, lastResult: null, lastError: null }
  function summarizeResult (result) {
    if (!result || typeof result !== 'object') return result ?? null
    const out = {}
    for (const key of ['phase','kind','code','reason','error','operation','item','count','confirmedBy','serverConfirmed','inventoryConfirmed','containerConfirmed','surfaceReached','partial','feetPosition','target','position','owner']) {
      const value = result[key]
      if (typeof value === 'string') out[key] = value.slice(0,500)
      else if (typeof value === 'number' || typeof value === 'boolean') out[key] = value
      else if (value && ['x','y','z'].every(axis => Number.isFinite(value[axis]))) out[key] = {x:value.x,y:value.y,z:value.z}
    }
    if (result.decision) out.decision = Object.fromEntries(['type','stage','resource','code','reason','targetCount'].filter(key => ['string','number','boolean'].includes(typeof result.decision[key])).map(key => [key,typeof result.decision[key] === 'string' ? result.decision[key].slice(0,500) : result.decision[key]]))
    return out
  }
  const snapshot = () => ({ ...clone(status), enabled, policy: policy?.snapshot() ?? null })
  const emit = () => { try { onProgress(snapshot()) } catch {} }
  async function load () {
    const state = getState(), scope = continuationScope(state)
    if (!scope || !workspaceRoot) throw new Error('Current depot world is not ready')
    const key = JSON.stringify([scope.profile, scope.realmId, scope.dimension])
    if (key === worldKey && policy) return
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(scope.profile) || !/^\d{1,20}$/.test(scope.realmId)) throw new Error('Invalid depot storage scope')
    filename = path.join(workspaceRoot, '.local', `depot-${scope.profile}-${scope.realmId}-${scope.dimension}.json`)
    let record = null
    try { const text = await fs.readFile(filename, 'utf8'); if (Buffer.byteLength(text) <= 131072) record = JSON.parse(text) } catch (error) { if (error.code !== 'ENOENT') status.lastError = String(error.message).slice(0, 200) }
    if (record?.world !== key) record = null
    policy = createBaseContinuation({ getState, world, getRawItem, foodReserveTarget: 1, memo: record?.policy ?? null })
    extra = record?.extra && typeof record.extra === 'object' ? record.extra : {}
    worldKey = key; saved = null; protectedCache = policy.protectedCells(); protectedKeys = new Set(protectedCache.map(p => JSON.stringify([p.x,p.y,p.z])))
    if (record?.enabled === true) enabled = true
  }
  async function persist () {
    if (!policy || !filename) return
    protectedCache = policy.protectedCells()
    protectedKeys = new Set(protectedCache.map(p => JSON.stringify([p.x,p.y,p.z])))
    const record = JSON.stringify({ version: 1, world: worldKey, enabled, policy: policy.memo(), extra })
    if (record === saved) return
    if (Buffer.byteLength(record) > 131072) throw new Error('Depot journal exceeds its bounded size')
    await fs.mkdir(path.dirname(filename), { recursive: true })
    await fs.writeFile(filename + '.pending', record + '\n')
    await fs.rename(filename + '.pending', filename)
    saved = record
  }
  function schedule (ms = intervalMs) {
    if (closed || suspended || !enabled || timer) return
    timer = setTimeout(() => { timer = null; void tick() }, ms)
  }
  function tick () {
    if (inFlight) return inFlight
    if (closed || suspended) return Promise.resolve(snapshot())
    controller = new AbortController()
    const signal = controller.signal
    status.busy = true
    inFlight = (async () => {
      try {
        await load()
        if (!enabled || closed) return snapshot()
        const scope = continuationScope(getState())
        const intent = policy.plan()
        status.phase = intent.kind; status.lastIntent = intent; emit()
        const result = await dispatch(intent, { signal, policy, extra, scope, setExtra: value => { extra = clone(value) } })
        if (closed || signal.aborted) return snapshot()
        const current = continuationScope(getState())
        if (JSON.stringify(current) !== JSON.stringify(scope)) throw new Error('Depot action crossed a connection or life boundary')
        status.lastResult = summarizeResult(result); status.lastError = null; status.actions++; failures = 0
        await persist()
      } catch (error) {
        status.lastError = String(error.message ?? error).slice(0, 300)
        status.code = error.code ?? null; failures++
      } finally {
        // Actual partial construction receipts remain historical evidence even
        // when a later admission or connection check interrupts this step.
        try { await persist() } catch (error) { status.lastError = String(error.message).slice(0,300); failures++ }
        status.busy = false; inFlight = null; emit()
        schedule(Math.min(30000, intervalMs * Math.max(1, failures)))
      }
      return snapshot()
    })()
    return inFlight
  }
  async function start () { await load(); if (closed) throw new Error('Depot scheduler is closed'); suspended = false; enabled = true; status.phase = 'starting'; await persist(); schedule(0); emit(); return snapshot() }
  async function stop () { enabled = false; clearTimeout(timer); timer = null; controller?.abort(); await inFlight; await persist(); status.phase = 'disabled'; emit(); return snapshot() }
  async function resume () { await load(); suspended = false; schedule(0); return snapshot() }
  async function interrupt (reason) { suspended = true; clearTimeout(timer); timer = null; controller?.abort(new Error(reason)); await inFlight; return snapshot() }
  async function close () { closed = true; clearTimeout(timer); timer = null; controller?.abort(); await inFlight; await persist() }
  return { start, stop, resume, tick, close, interrupt, snapshot, isEnabled: () => enabled, isBusy: () => status.busy, extra: () => clone(extra), protectedCells: () => clone(protectedCache), isProtected: p => protectedKeys.has(JSON.stringify([p.x,p.y,p.z])) }
}
module.exports = { createDepotMission }
