'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { writeDurableJson } = require('../common/durable-json')
const { createStationRecovery } = require('../actions/station-recovery')
const { supplyScope } = require('../survival/supply-return')
const { walkableCells } = require('./player-drops')
const stations = require('./player-workstations')

const failure = (code, message) => Object.assign(new Error(message), { code })
const copy = value => structuredClone(value)
const moving = status => ['moving', 'settling'].includes(status?.phase)

function loadStations (file) {
  try {
    if (fs.statSync(file).size > 1024 * 1024) return { version: 1, records: [] }
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    return { version: 1, receipts: Array.isArray(value?.receipts) ? value.receipts.filter(key => typeof key === 'string').slice(-512) : [], records: value?.version === 1 && Array.isArray(value.records) ? value.records.filter(stations.validRecord).slice(0, 512).map(record => ({ ...record, authorization: null })) : [] }
  } catch { return { version: 1, records: [] } }
}

function createPlayerWorkstationRuntime ({ shared, getState, getBlock, getMotion, getFurnace, operations, held = () => false, disposed = () => false,
  file = path.resolve(__dirname, '..', '..', '.local', 'player-workstations.json'), write = writeDurableJson, log = () => {}, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  shared.playerWorkstations ??= file ? loadStations(file) : { version: 1, records: [] }
  shared.playerWorkstations.receipts ??= []
  shared.playerWorkstationSequence ??= 0
  let active = null
  const say = text => log(`プレイヤーモード: ${text}`)
  const find = id => shared.playerWorkstations.records.find(record => record.id === id)
  // Reloaded controllers join the same queue; an old save cannot overwrite a
  // new receipt. Authorization is deliberately not persisted across runtimes.
  async function save () {
    if (!file) return
    const value = { version: 1, receipts: [...shared.playerWorkstations.receipts], records: shared.playerWorkstations.records.filter(record => record.phase !== 'collected').map(({ authorization, ...record }) => copy(record)) }
    const task = (shared.playerWorkstationSave ?? Promise.resolve()).catch(() => {}).then(() => write(file, value))
    shared.playerWorkstationSave = task
    await task
  }
  const currentRecords = () => stations.nearbyRecords({ shared, state: getState(), getBlock, now: now() })
  function reconcile (state) {
    let changed = false
    for (const record of stations.records(shared, state)) {
      if (record.phase === 'collected') continue
      const block = getBlock(record.position.x, record.position.y, record.position.z)
      if (record.pending?.miningStarted === true) {
        if (block?.known === true && stations.AIR.has(block.name) && record.pending.blockCleared !== true) { record.pending.blockCleared = true; changed = true }
        if (record.pending.blockCleared === true && block?.known === true && !stations.AIR.has(block.name)) { record.invalidated = true; record.authorization = null; record.lastCode = 'STATION_REPLACED'; changed = true }
        continue
      }
      // A furnace's fire changes its runtime ID, but is not a replacement.
      const burning = record.item === 'minecraft:furnace' && block?.name === 'minecraft:lit_furnace' &&
        JSON.stringify(Object.fromEntries(Object.entries(block.properties ?? {}).map(([k, v]) => [k, v?.value ?? v]).sort(([a], [b]) => a.localeCompare(b)))) === JSON.stringify(record.fingerprint.properties)
      if (block?.known === true && !stations.matches(record, block) && !burning) { record.invalidated = true; record.authorization = null; record.lastCode = 'STATION_REPLACED'; changed = true }
    }
    if (changed) void save().catch(error => say(`設備の所有記録を保存できません: ${error.code ?? 'SAVE_FAILED'}`))
  }
  const blocked = () => disposed() || held() || shared.botMode !== 'player' || shared.playerWanted !== true
  const verify = (state, target, block) => !blocked() && stations.ownsStation({ shared, state, target, block, now: now() })
  const safeState = scope => {
    const state = getState()
    if (blocked() || !supplyScope(state) || scope && scope !== supplyScope(state) || state.phase !== 'spawned' || state.dead || state.isDead || state.lifecycle?.dead || !(state.health > 0) || !stations.inventoryReady(state)) throw failure('STATION_INTERRUPTED', '設備の回収を中断し、受信した状態からやり直します。')
    return state
  }
  async function waitFor (test, ms, check) {
    const end = now() + ms
    while (now() < end) { check(); if (test()) return true; await sleep(50) }
    check(); return test()
  }
  async function walk (target, check) {
    check()
    const options = { maxDistance: 16, maxTicks: 160, allowWater: false }
    if (operations.movement.preview(target, options)?.ready !== true) return false
    check()
    operations.movement.start(target, options)
    const started = getMotion(), stamp = JSON.stringify(started?.timingDiagnostics?.start ?? null)
    const own = () => !disposed() && !held() && stamp !== 'null' && JSON.stringify(getMotion()?.timingDiagnostics?.start ?? null) === stamp
    try {
      await waitFor(() => !moving(getMotion()), 9000, check)
      const state = check(), p = state.position
      return !!p && Math.hypot(p.x - target.x, p.z - target.z) <= 0.6 && Math.abs(p.y - 1.62 - target.y) <= 0.4
    } finally {
      // A late cancellation cannot stop combat or another movement owner.
      if (own() && moving(getMotion())) operations.movement.stop('設備回収の歩行を終了しました。')
    }
  }
  async function approach (record, check, pickup = false) {
    let state = check()
    const at = { x: record.position.x + 0.5, y: record.position.y, z: record.position.z + 0.5 }
    if (pickup) {
      // The actual drop may already have arrived before any movement is needed.
      const baseline = record.pending?.inventoryBefore
      if (Number.isSafeInteger(baseline) && stations.count(state, record.item) > baseline) return true
    } else if (Math.hypot(state.position.x - at.x, state.position.y - at.y - 0.5, state.position.z - at.z) <= 3.5) return true
    const choices = [...walkableCells(state.position, getBlock).values()].map(value => ({ x: value.x + 0.5, y: value.y, z: value.z + 0.5 }))
      .filter(p => Number.isFinite(p.x) && Math.hypot(p.x - at.x, p.z - at.z) <= (pickup ? 1 : 2.5) && Math.abs(p.y - at.y) <= (pickup ? 0.5 : 2))
      .sort((a, b) => Math.hypot(a.x - at.x, a.z - at.z) - Math.hypot(b.x - at.x, b.z - at.z)).slice(0, 8)
    for (const target of choices) { if (await walk(target, check)) return true; state = check() }
    return false
  }
  async function prepareFurnace (record, check) {
    check()
    let ownWindow = null
    try {
      await operations.interactions.openFurnace(record.position)
      check()
      ownWindow = getFurnace()?.window
      const received = await waitFor(() => getFurnace()?.contentsKnown === true, 3000, check)
      const block = getBlock(record.position.x, record.position.y, record.position.z)
      if (!received || !stations.emptyFurnace(getFurnace(), record.position, block)) throw failure('STATION_FURNACE_NOT_EMPTY', '稼働中・内容がある・中身を確認できないかまどは残して再利用します。')
    } finally {
      if (!disposed() && !held() && ownWindow && JSON.stringify(getFurnace()?.window) === JSON.stringify(ownWindow)) operations.crafting.closeContainer()
    }
    const state = check()
    const pick = state.inventory.items.filter(i => /_pickaxe$/.test(i.name) && i.count > 0 && i.durabilityKnown === true && i.durabilityRemaining > 1).sort((a, b) => b.durabilityRemaining - a.durabilityRemaining)[0]
    if (!pick) throw failure('STATION_PICKAXE_REQUIRED', 'かまどを回収できるツルハシが必要です。')
    await operations.inventory.equip(pick.slot)
    check()
    return true
  }
  function forgetRecovered (record) {
    const kind = record.item === 'minecraft:crafting_table' ? 'craftingTable' : 'furnace'
    if (stations.same(shared.stations?.[kind]?.position, record.position)) delete shared.stations[kind]
    const page = shared.stationCatalog?.scopes?.[record.worldScope]
    if (Array.isArray(page?.entries)) page.entries = page.entries.filter(entry => entry.kind !== kind || !stations.same(entry.position, record.position))
    const site = shared.portableWorksiteMemo?.site
    if (site && (stations.same(site.table, record.position) || stations.same(site.furnace, record.position))) { shared.portableWorksiteMemo = null; shared.portableWorksiteSearch = null }
  }
  const recovery = createStationRecovery({
    getState, getBlock, verifyOwnedStation: verify, now, sleep, timeoutMs: 20000,
    mining: { preview: targets => operations.mining.preview(targets), start: targets => operations.mining.start(targets), stop: reason => operations.mining.stop(reason), snapshot: () => operations.mining.snapshot() },
    getPending: target => copy(find(target.ownershipKey)?.pending ?? null),
    setPending: async (target, pending) => {
      const record = find(target.ownershipKey)
      if (!record) throw failure('STATION_RECORD_CHANGED', '仮設設備の記録が変わりました。')
      record.pending = copy(pending); record.phase = pending ? 'retrieving' : 'collected'
      if (!pending) { record.collectedAt = now(); forgetRecovered(record) }
      await save()
    },
    collect: async (target, { signal } = {}) => {
      const record = find(target.ownershipKey), scope = supplyScope(getState())
      const check = () => { if (signal?.aborted) throw failure('ABORTED', '設備回収を中断しました。'); return safeState(scope) }
      if (!await approach(record, check, true)) throw failure('STATION_PICKUP_UNREACHABLE', '設備の落とし物へ歩いて届きません。回収待ちとして残します。')
    }
  })

  async function notePlacement (item, receipt) {
    if (!stations.ITEMS.has(item) || !receipt?.position) return
    const state = getState(), p = receipt.position
    const record = stations.placementRecord({ shared, state, item, receipt, block: getBlock(p.x, p.y, p.z), now: now() })
    if (!record || shared.playerWorkstations.receipts.includes(record.receiptKey)) return
    shared.playerWorkstations.receipts = [...shared.playerWorkstations.receipts, record.receiptKey].slice(-512)
    // Same coordinate can be reused after a confirmed pickup. Never accumulate
    // duplicate obligations for one received placement.
    shared.playerWorkstations.records = shared.playerWorkstations.records.filter(old => old.phase !== 'collected' && !(old.worldScope === record.worldScope && stations.same(old.position, p)))
    shared.playerWorkstations.records.push(record)
    await save()
  }

  function observe (state = getState()) {
    if (shared.botMode !== 'player') return { enabled: false }
    reconcile(state)
    const list = stations.nearbyRecords({ shared, state, getBlock, now: now() })
    const table = list.find(record => record.item === 'minecraft:crafting_table')
    const waiting = stations.records(shared, state).find(record => record.item === 'minecraft:crafting_table' && record.phase !== 'collected' &&
      record.attempts < 3 && record.retryAt > now() && state.position && Math.hypot(state.position.x - record.position.x, state.position.y - record.position.y, state.position.z - record.position.z) <= 12)
    const retryTable = waiting ? { ...stations.recoveryDecision(waiting), type: 'wait', code: 'station_recovery_retry', retryAt: waiting.retryAt, reason: '仮設の作業台は回収待ちです。新しく作り直さず、次の確認を待ちます。' } : null
    const furnace = list.find(record => record.item === 'minecraft:furnace')
    const empty = furnace && (furnace.pending || stations.emptyFurnace(getFurnace(), furnace.position, getBlock(furnace.position.x, furnace.position.y, furnace.position.z)))
    return { enabled: true, recoverTable: stations.recoveryDecision(table) ?? retryTable, recoverFurnace: empty ? stations.recoveryDecision(furnace) : null,
      inspectFurnace: furnace ? stations.recoveryDecision(furnace) : null }
  }

  async function recover (id, { signal } = {}) {
    if (active || blocked()) return { phase: 'deferred', collected: false, serverConfirmed: false, code: 'STATION_BUSY' }
    reconcile(getState())
    const record = stations.records(shared, getState()).find(r => r.id === id)
    if (!record || record.phase === 'collected') return { phase: 'deferred', collected: false, serverConfirmed: false, code: 'STATION_NOT_OWNED' }
    const token = {}, scope = supplyScope(getState())
    let authorization = null
    const check = () => { if (signal?.aborted || active !== token) throw failure('ABORTED', '設備回収を中断しました。'); return safeState(scope) }
    active = token
    try {
      const state = check()
      if (!stations.hasRoom(state, record.item)) throw failure('STATION_INVENTORY_FULL', '設備をしまう枠がないため、収納後に回収します。')
      const block = getBlock(record.position.x, record.position.y, record.position.z)
      if (!record.pending && !stations.matches(record, block)) throw failure('STATION_BLOCK_CHANGED', '仮設設備の現在のブロックを確認できません。')
      if (!await approach(record, check)) throw failure('STATION_UNREACHABLE', '仮設設備へ歩いて届きません。')
      // An intact station can be retried after reconnecting; an unconfirmed
      // lost drop cannot acquire a new inventory baseline and become success.
      if (record.pending && record.pending.scope !== scope && stations.matches(record, block)) { record.pending = null; record.phase = 'placed'; await save() }
      const alreadyBroken = block?.known === true && stations.AIR.has(block.name)
      const furnaceEmpty = record.item !== 'minecraft:furnace' || alreadyBroken && record.pending?.miningStarted === true || await prepareFurnace(record, check)
      check()
      record.authorization = authorization = { scope, expiresAt: now() + 30000, furnaceEmpty }
      const out = await recovery.recover(stations.stationTarget(record), { signal })
      say(`${record.item === 'minecraft:crafting_table' ? '作業台' : 'かまど'}を回収し、持ち物に戻ったことを確認しました`)
      return { ...out, phase: 'completed' }
    } catch (error) {
      if (signal?.aborted || blocked() || ['ABORTED', 'STATION_INTERRUPTED'].includes(error.code)) throw error
      record.attempts = (record.attempts ?? 0) + 1
      record.retryAt = now() + (record.attempts < 3 ? 60000 : 600000)
      record.lastCode = error.code ?? 'STATION_RECOVERY_FAILED'
      await save()
      say(`${record.item === 'minecraft:crafting_table' ? '作業台' : 'かまど'}は回収待ちです (${record.position.x}, ${record.position.y}, ${record.position.z}): ${record.lastCode}`)
      return { phase: 'deferred', collected: false, serverConfirmed: false, code: record.lastCode }
    } finally { if (record.authorization === authorization) record.authorization = null; if (active === token) active = null }
  }

  async function recoverAt (position, options = {}) {
    const record = currentRecords().find(r => stations.same(r.position, position))
    return record ? recover(record.id, options) : { phase: 'deferred', collected: false, serverConfirmed: false, code: 'STATION_NOT_OWNED' }
  }
  async function recoverNearby ({ tablesOnly = false, ...options } = {}) {
    const results = []
    for (const record of currentRecords().filter(r => !tablesOnly || r.item === 'minecraft:crafting_table').slice(0, 2)) {
      if (blocked() || options.signal?.aborted) break
      results.push(await recover(record.id, options))
    }
    return results
  }
  return { notePlacement, observe, recover, recoverAt, recoverNearby, save, snapshot: () => ({ busy: active !== null, pending: copy(shared.playerWorkstations.records.filter(r => r.phase !== 'collected')) }) }
}

module.exports = { createPlayerWorkstationRuntime, loadStations }
