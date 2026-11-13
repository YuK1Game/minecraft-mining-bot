'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const readline = require('node:readline/promises')
const { randomUUID } = require('node:crypto')
const { PerformanceObserver } = require('node:perf_hooks')
const { loadConfig } = require('./config')
const { chooseRealm, printRealms, displayText } = require('./realms')
const { installRealmJoinHandling } = require('./realm-join')
const { createState } = require('./state')
const { createApi } = require('./api')
const { createWorld } = require('./world')
const { createEntities } = require('./entities')
const { createLifecycle } = require('./lifecycle')
const { createSessionCache } = require('./session-cache')
const { createHotReloader } = require('./hotreload')
const { normalizePlayerCorrection } = require('./server-physics')
const { createRespawnSwim } = require('./respawn-swim')
const { parseQuarryCommand } = require('./quarry-cli')

const PACKET_EVENTS = ['start_game', 'move_player', 'correct_player_move_prediction', 'server_post_move', 'change_dimension', 'respawn', 'update_attributes', 'set_health', 'death_info', 'item_registry', 'inventory_content', 'inventory_slot', 'mob_equipment', 'player_hotbar', 'set_player_game_type', 'update_player_game_type', 'level_chunk', 'subchunk', 'update_block', 'update_subchunk_blocks', 'crafting_data', 'item_stack_response', 'container_open', 'container_close', 'add_item_entity', 'take_item_entity', 'remove_entity', 'move_entity', 'move_entity_delta', 'add_player', 'add_entity', 'entity_event', 'set_entity_data', 'command_output']
const CONTROL_EVENTS = new Set(['update_client_input_locks', 'set_movement_authority', 'client_movement_prediction_sync', 'packet_violation_warning'])
const TRANSPORT_EVENTS = new Set(['error', 'close', 'connect', 'spawn', 'join', 'kick', 'newListener', 'removeListener'])

function errorText (error) {
  return displayText(error?.message ?? error).replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]').replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[redacted token]')
}
const finite = point => point && ['x', 'y', 'z'].every(axis => Number.isFinite(point[axis]))
const dimensionName = value => ['overworld', 'nether', 'end'][value] ?? value

// While the loading screen is active, idle safety intentionally cannot move.
// A received, already lit creeper can explode before terrain/inventory finish
// loading, so a safety-armed connection must not wait for that later loop.
function startupFuseDanger (state, shared, actors) {
  if (shared?.safetyWanted !== true || shared.loadingScreenEnded === true && !shared.respawnTerrain?.pending || !['joined', 'spawned'].includes(state?.phase) || !state.runtimeEntityId || state.dead || state.spawnPending || !finite(state.position) || !Array.isArray(actors)) return null
  const dimension = dimensionName(state.dimension)
  const bounds = dimension === 'overworld' ? [-68, 324] : dimension === 'nether' ? [-4, 132] : dimension === 'end' ? [-4, 260] : null
  if (!bounds || state.position.y < bounds[0] || state.position.y > bounds[1] || Math.abs(state.position.x) > 30000000 || Math.abs(state.position.z) > 30000000) return null
  const candidates = actors.filter(actor => actor?.entityType === 'minecraft:creeper' && actor.hostile === true && actor.alive === true && actor.primed === true && actor.positionKnown === true && finite(actor.position) && dimensionName(actor.dimension) === dimension).map(actor => ({ actor, distance: Math.hypot(actor.position.x - state.position.x, actor.position.y - state.position.y, actor.position.z - state.position.z) })).filter(value => value.distance <= 12).sort((a, b) => a.distance - b.distance)
  const found = candidates[0]
  return found ? { runtimeId: found.actor.runtimeId, uniqueId: found.actor.uniqueId, distance: found.distance, fuseLength: Number.isInteger(found.actor.fuseLength) ? found.actor.fuseLength : null } : null
}
function createStartupFuseGuard ({ getState, getShared, getActors, isStopping, onDanger = () => {}, report = () => {}, schedule = setImmediate }) {
  let pending = false
  let reported = null
  function observe () {
    const shared = getShared()
    if (pending || isStopping() || shared?.safetyWanted !== true || shared.loadingScreenEnded === true && !shared.respawnTerrain?.pending) return
    const danger = startupFuseDanger(getState(), shared, getActors())
    if (!danger) { reported = null; return }
    const epoch = shared.safetyEnableEpoch
    const key = `${epoch}:${danger.runtimeId}:${danger.uniqueId}`
    if (key === reported) return
    pending = true
    schedule(() => {
      pending = false
      const currentShared = getShared()
      const current = startupFuseDanger(getState(), currentShared, getActors())
      if (isStopping() || currentShared?.safetyEnableEpoch !== epoch || !current || current.runtimeId !== danger.runtimeId || current.uniqueId !== danger.uniqueId) return
      reported = key
      report(current)
      onDanger(current)
    })
  }
  return { observe }
}

// Local danger never owns the transport. This observer has no close/disconnect
// capability; actual server closure, authentication errors and manual quit keep
// their existing host shutdown paths.
function resumeRuntimeSafely (runtime, { shared, source = 'resume', onError = () => {} } = {}) {
  const failed = error => {
    const receipt = { source: String(source).slice(0, 60), message: errorText(error).slice(0, 300), at: new Date().toISOString() }
    if (shared) shared.runtimeResumeError = receipt
    try { onError(receipt) } catch { /* Diagnostic observers cannot close the connection. */ }
    return false
  }
  try {
    const result = runtime?.resumeRequested?.()
    return result && typeof result.then === 'function' ? Promise.resolve(result).then(() => true, failed) : true
  } catch (error) { return failed(error) }
}

function formatOnlineEmergency (receipt) {
  const line = receipt.resumeError
    ? `行動の再開を見送り、接続を保持します: online_emergency: ${receipt.resumeError}`
    : `危険を検知しました。接続を保持し、通常の保護と復帰を続けます: ${receipt.reasonCode}`
  return receipt.suppressedCount > 0 ? `${line}（直前の同一危険ログ ${receipt.suppressedCount} 件を省略）` : line
}

function createOnlineEmergencyHandler ({ getState, getShared, getCurrent, getLife = state => state.lifecycle?.deathId ?? state.deathId, now = Date.now, report = () => {} }) {
  const scopeOf = state => JSON.stringify([state.connectionId, state.startedAt, String(state.runtimeEntityId ?? ''), state.dimension, getLife(state) ?? null])
  let group = null
  function emit (receipt, currentGroup, when) {
    const suppressedCount = currentGroup?.suppressed ?? 0
    if (currentGroup) {
      currentGroup.lastReportedAt = when
      currentGroup.suppressed = 0
    }
    try { report({ ...receipt, suppressedCount }) } catch { /* Diagnostic failures must not stop protection. */ }
  }
  return details => {
    const state = getState(); const shared = getShared()
    if (details?.connectionId != null && details.connectionId !== state.connectionId) return { accepted: false, reason: 'connection_changed' }
    const when = now(), scope = scopeOf(state)
    const reason = String(details?.reason ?? 'Local danger observed'), reasonCode = String(details?.reasonCode ?? 'LOCAL_DANGER')
    const changed = !group || group.scope !== scope || group.reasonCode !== reasonCode || group.reason !== reason
    if (changed) group = { scope, reason, reasonCode, lastReportedAt: null, lastHealth: null, suppressed: group?.scope === scope ? group.suppressed : 0 }
    const owner = group
    const damaged = Number.isFinite(owner.lastHealth) && Number.isFinite(state.health) && state.health < owner.lastHealth
    if (Number.isFinite(state.health)) owner.lastHealth = state.health
    const receipt = { status: 'remaining_online', reason: reason.slice(0, 300), reasonCode: reasonCode.slice(0, 80), connectionId: state.connectionId, health: state.health, at: new Date(when).toISOString() }
    shared.onlineEmergency = receipt
    if (changed || damaged || when < owner.lastReportedAt || when - owner.lastReportedAt >= 5000) emit(receipt, owner, when)
    else owner.suppressed++
    resumeRuntimeSafely(getCurrent(), { source: 'online_emergency', onError: failure => {
      const sameScope = getShared() === shared && scopeOf(getState()) === scope
      if (sameScope && shared.onlineEmergency === receipt) {
        receipt.resumeError = failure.message
        shared.runtimeResumeError = failure
      }
      emit({ ...receipt, resumeError: failure.message }, sameScope && group === owner ? owner : null, now())
    } })
    return { accepted: true, ...receipt }
  }
}

// Confirmed lifecycle deaths retain a respawn owner even when a resource goal
// previously stopped. All callers share the normal lifecycle handshake; no
// health, destination or successful recovery is synthesized here.
function createDeathRespawnReflex ({ getState, getShared, getLifecycle, getCurrent, isStopping = () => false, schedule = setImmediate, report = () => {} }) {
  const inFlight = new Map()
  let automaticKey = null
  const scope = state => JSON.stringify([state.connectionId ?? null, state.startedAt ?? null, String(state.runtimeEntityId ?? '')])
  function request (options = {}) {
    const lifecycle = getLifecycle(); const state = getState(); const life = lifecycle?.stats()
    if (!lifecycle || isStopping()) return Promise.reject(new Error('The connection is closing; respawn was not requested'))
    if (!life.dead && !life.spawnPending) return lifecycle.respawn(options)
    const key = `${scope(state)}:${life.deathId}`
    if (inFlight.has(key)) return inFlight.get(key)
    const session = scope(state)
    const task = Promise.resolve().then(async () => {
      const drained = await getCurrent()?.stopActions?.('死亡後の通常リスポーン前に操作の終了を確認します。')
      if (Array.isArray(drained) && drained.some(result => result?.status === 'rejected')) throw new Error('Previous player actions have not confirmed cleanup')
      if (isStopping() || scope(getState()) !== session) throw new Error('The respawn connection or player changed')
      return lifecycle.respawn(options)
    }).finally(() => { if (inFlight.get(key) === task) inFlight.delete(key) })
    inFlight.set(key, task)
    return task
  }
  function observe () {
    const shared = getShared(); const state = getState(); const life = getLifecycle()?.stats()
    if (isStopping() || !(shared.safetyWanted === true || shared.autoWanted === true) || !life?.dead || !Number.isSafeInteger(life.deathId) || life.deathId < 1 || !['spawned', 'dead', 'respawning'].includes(state.phase)) return false
    const key = `${scope(state)}:${life.deathId}`
    if (automaticKey === key) return false
    automaticKey = key
    const session = scope(state)
    const receipt = { deathId: life.deathId, connectionId: state.connectionId, phase: 'scheduled', at: new Date().toISOString() }
    shared.deathRespawn = receipt
    schedule(() => {
      if (isStopping() || scope(getState()) !== session || !(shared.safetyWanted === true || shared.autoWanted === true) || getLifecycle()?.stats().deathId !== life.deathId || !getLifecycle()?.stats().dead) return
      receipt.phase = 'respawning'
      void request().then(result => {
        Object.assign(receipt, { phase: result?.serverConfirmed === true ? 'confirmed' : 'unconfirmed', serverConfirmed: result?.serverConfirmed === true })
        report(receipt)
      }, error => {
        Object.assign(receipt, { phase: 'failed', reason: errorText(error), serverConfirmed: false })
        report(receipt)
      })
    })
    return true
  }
  return { observe, request }
}

// A chunk announcement can arrive before the spawn event. Request only the
// already-announced nearby sections, without ending the loading screen or
// treating any terrain as received until the server actually replies.
function requestStartupTerrain ({ state, shared, world, queue, version }) {
  if (version !== '1.26.60' || state?.phase !== 'joined' || state.dead || state.spawnPending || shared?.safetyWanted !== true || shared.loadingScreenEnded === true || !finite(state.position)) return false
  const dimension = dimensionName(state.dimension)
  const bounds = dimension === 'overworld' ? [-68, 324] : dimension === 'nether' ? [-4, 132] : dimension === 'end' ? [-4, 260] : null
  if (!bounds || state.position.y < bounds[0] || state.position.y > bounds[1] || Math.abs(state.position.x) > 30000000 || Math.abs(state.position.z) > 30000000) return false
  const request = world.buildSubchunkRequest(state.position)
  if (!request) return false
  queue('subchunk_request', request)
  return true
}

// Respawn ends the death handshake before the destination's chunks necessarily
// arrive. Knowledge here only permits the normal live body checks to resume.
function respawnTerrainKnown (world, position) {
  if (!finite(position)) return false
  const feet = position.y - 1.62
  for (let x = Math.floor(position.x - 0.3 + 1e-6); x <= Math.floor(position.x + 0.3 - 1e-6); x++) {
    for (let z = Math.floor(position.z - 0.3 + 1e-6); z <= Math.floor(position.z + 0.3 - 1e-6); z++) {
      for (let y = Math.floor(feet - 1e-4); y <= Math.floor(feet + 1.8 - 1e-6); y++) {
        let block
        try { block = world.getBlock(x, y, z) } catch { return false }
        if (block?.known !== true || (block.extra ?? []).some(layer => layer?.known === false)) return false
      }
    }
  }
  return true
}

function createRespawnTerrainHandoff ({ getState, shared, world, queue, getCurrent, isStopping = () => false, onResumeError = () => {} }) {
  let pending = null
  const scope = state => JSON.stringify([state.connectionId, state.dimension, state.runtimeEntityId])
  const terrainEvents = new Set(['timer', 'level_chunk', 'subchunk', 'update_block', 'update_subchunk_blocks', 'move_player', 'correct_player_move_prediction', 'server_post_move'])
  function cancel (reason) {
    if (!pending) return
    pending = null
    shared.respawnTerrain = { ...shared.respawnTerrain, pending: false, phase: 'cancelled', reason }
  }
  function observe (name) {
    const run = pending
    if (!run || isStopping()) return false
    const state = getState()
    if (state.dead || state.spawnPending || !(state.health > 0) || scope(state) !== run.scope) { cancel('Respawn session changed'); return false }
    if (!terrainEvents.has(name)) return true
    if (finite(state.position)) {
      shared.respawnTerrain.position = { ...state.position }
      try {
        const request = world.buildSubchunkRequest(state.position)
        if (request) queue('subchunk_request', request)
      } catch (error) { shared.respawnTerrain.reason = errorText(error); return true }
      if (run.drained && respawnTerrainKnown(world, state.position)) {
        pending = null
        shared.respawnTerrain = { ...shared.respawnTerrain, pending: false, phase: 'ready' }
        resumeRuntimeSafely(getCurrent(), { shared, source: 'respawn_terrain', onError: onResumeError })
        return false
      }
    }
    return true
  }
  function begin (result) {
    if (result?.serverConfirmed !== true || !finite(result.position) || !(result.health > 0)) throw new Error('A confirmed living respawn position is required')
    const state = getState()
    const run = pending = { scope: scope(state), drained: false }
    shared.respawnTerrain = { pending: true, phase: 'awaiting_terrain', deathId: result.deathId, position: { ...result.position } }
    // The runtime resets synchronously before returning its cleanup promise;
    // no old movement input may run during the destination terrain wait.
    let cleanup
    try {
      const runtime = getCurrent()
      if (typeof runtime?.onRespawn !== 'function') throw new Error('Respawn runtime cleanup is unavailable')
      cleanup = runtime.onRespawn(result)
    } catch (error) { cleanup = Promise.reject(error) }
    observe('timer')
    void Promise.resolve(cleanup).then(() => {
      if (pending !== run) return
      run.drained = true
      observe('timer')
    }, error => {
      if (pending === run) shared.respawnTerrain = { ...shared.respawnTerrain, phase: 'cleanup_failed', reason: errorText(error) }
    })
  }
  return { begin, observe, cancel, pending: () => pending !== null }
}

// Connection-owned listeners retain only a packet name and this stable router.
// A runtime registers names, never callbacks. Receiving resolves the current
// runtime through the owner's pipeline, even after many behaviour replacements.
function createHostPacketEvents ({ receive, onError = () => {} }) {
  if (typeof receive !== 'function' || typeof onError !== 'function') throw new Error('Packet events require a stable receiver and error handler')
  const names = new Set()
  const listeners = new Map()
  let client = null
  let disposed = false
  function attachName (name) {
    if (!client || listeners.has(name)) return
    const listener = packet => { if (!disposed) { try { receive(name, packet) } catch (error) { onError(error) } } }
    client.on(name, listener)
    listeners.set(name, listener)
  }
  function registerPacketEvents (requested) {
    if (disposed) throw new Error('Packet event router is disposed')
    if (!Array.isArray(requested) || requested.length > 128 || requested.some(name => typeof name !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(name) || TRANSPORT_EVENTS.has(name))) throw new Error('Register packet names as an array of protocol event names')
    const additions = [...new Set(requested)].filter(name => !names.has(name))
    if (names.size + additions.length > 512) throw new Error('Too many packet event registrations')
    for (const name of additions) { names.add(name); attachName(name) }
    return additions
  }
  function detach () {
    if (client) for (const [name, listener] of listeners) client.off(name, listener)
    listeners.clear()
  }
  function attachClient (next) {
    if (disposed) throw new Error('Packet event router is disposed')
    if (typeof next?.on !== 'function' || typeof next?.off !== 'function') throw new Error('Packet events require an event client')
    if (client === next) return
    detach(); client = next
    for (const name of names) attachName(name)
  }
  function dispose () { if (disposed) return; disposed = true; detach(); client = null }
  return { registerPacketEvents, attachClient, dispose, snapshot: () => ({ registered: [...names], attached: [...listeners.keys()], disposed }) }
}

function createHostPacketReceiver ({ state, shared, meta, cache, applyState, world, entities, getLifecycle, getCurrent, log = () => {}, clock = () => performance.now() }) {
  if (!state || !shared || !meta || typeof cache?.observe !== 'function' || typeof applyState !== 'function' || typeof world?.applyPacket !== 'function' || typeof entities?.applyPacket !== 'function' || [getLifecycle, getCurrent, log, clock].some(value => typeof value !== 'function')) throw new Error('Host packet receiver requires connection-owned observations and current-runtime access')
  // This high-water mark belongs to the raw observation gate, independently of
  // reloadable helpers such as shared.lastPhysicsCorrectionTick.
  let lastCorrectionTick = null
  let acceptedCorrections = 0
  let rejectedCorrections = 0
  function receive (name, packet) {
    if (name === 'start_game') lastCorrectionTick = null
    let correction = null
    if (name === 'correct_player_move_prediction') {
      correction = normalizePlayerCorrection(packet, { version: meta.version, lastCorrectionTick, historyAvailable: false })
      if (!correction.accepted) { rejectedCorrections++; return correction }
      if (correction.tick !== '0') lastCorrectionTick = correction.tick
      acceptedCorrections++
    }
    const previousHealth = state.health
    if (name === 'start_game') { meta.startGame = packet; meta.startGameReceivedAt = clock() }
    const ownMove = name === 'move_player' && String(packet.runtime_id) === state.runtimeEntityId
    if (ownMove || ['correct_player_move_prediction', 'server_post_move', 'change_dimension'].includes(name) || (name === 'respawn' && packet.state === 1 && String(packet.runtime_entity_id) === state.runtimeEntityId)) { shared.prediction = null; shared.motionSource = null }
    if (name === 'player_hotbar' || (name === 'mob_equipment' && String(packet.runtime_entity_id) === state.runtimeEntityId && (packet.window_id === 'inventory' || packet.window_id === 0))) shared.equipment = null
    cache.observe(name, packet)
    applyState(name, packet)
    world.applyPacket(name, packet)
    const entityUpdate = entities.applyPacket(name, packet)
    getLifecycle()?.applyPacket(name, packet)
    getCurrent()?.applyPacket(name, packet, { entityDangerChanged: entityUpdate?.dangerChanged !== false })
    if (shared.loadingScreenEnded && previousHealth > 0 && state.health < previousHealth) {
      state.safety = { reason: 'damage_detected', previousHealth, health: state.health, at: new Date().toISOString() }
      getCurrent()?.stopActions('ダメージを検知しました。')
      log(`ダメージを検知しました: ${previousHealth} → ${state.health}`)
      state.safety.action = 'paused_while_connected'
    }
    return correction ?? { accepted: true }
  }
  return { receive, snapshot: () => ({ lastCorrectionTick, acceptedCorrections, rejectedCorrections }) }
}

// Append-only live log for the dashboard (.local/bot.log), rotated at 5MB to
// bot.log.1. Writes are fire-and-forget; a disk error never affects the Bot.
const liveLog = require('./live-log').createLiveLog({ file: path.resolve(__dirname, '..', '.local', 'bot.log') })

async function main () {
  const args = process.argv.slice(2)
  if (args.includes('--help')) { console.log('npm start: 接続してコード更新を待つ / npm run auto: 自律作業 / npm run realms: Realm一覧'); return }
  if (args.some(arg => !['--list', '--auto', '--dashboard'].includes(arg))) throw new Error('引数は --list / --auto / --help を指定してください。')
  const managed = args.includes('--dashboard')
  if (managed && (typeof process.send !== 'function' || args.length !== 1)) throw new Error('--dashboard は管理画面からのみ起動できます。')
  const config = loadConfig()
  const bedrock = require('bedrock-protocol')
  const { Authflow, Titles } = require('prismarine-auth')
  const { RealmAPI } = require('prismarine-realms')
  const options = require('bedrock-protocol/src/options')
  const version = config.version ?? options.CURRENT_VERSION
  if (!options.Versions[version]) throw new Error(`未対応の接続バージョンです: ${version}`)
  const { state, applyPacket: applyState, snapshot: rawSnapshot, snapshotFields: rawFields } = createState(config.profile)
  state.version = version
  state.connectionId = randomUUID()
  const world = createWorld({ version })
  const entities = createEntities()
  const cache = createSessionCache()
  const controlInfo = {}
  const meta = { version, startGame: null, startGameReceivedAt: null, workspaceRoot: process.cwd(), profile: config.profile }
  const shared = { autoWanted: args.includes('--auto'), safetyWanted: args.includes('--auto'), autoOptions: {}, autonomyProgress: null, loadingScreenEnded: false, motionSource: null, prediction: null, equipment: null }
  let gcObserver = null
  if (process.env.MINECRAFT_CAPTURE_EMERGENCY === '1') {
    gcObserver = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        shared.perfObservations ??= {}
        if (entry.duration > (shared.perfObservations.gc?.ms ?? 0)) shared.perfObservations.gc = { ms: entry.duration, kind: entry.detail?.kind ?? null }
      }
    })
    gcObserver.observe({ entryTypes: ['gc'] })
  }
  let client = null; let api = null; let terminal = null; let reloader = null; let lifecycle = null; let chunkTimer = null
  let dashboardSession = null
  const realmJoinAbort = new AbortController()
  let restoreRealmJoin = null
  // Connecting from the UI must never restart old digging. Only the dashboard's
  // automatic reconnect after an unexpected disconnect (2026-11-13) may restore
  // the job that was running (the recovery rules still decide).
  if (managed && process.env.DASHBOARD_RESTORE_QUARRY !== '1') shared.quarryRestoreDisabled = true
  if (managed && process.env.DASHBOARD_RESTORE_QUARRY === '1') shared.quarryRestoreAfterReconnect = true
  let stopping = false; let nextOdd = -1; let nextEven = -2; let lastInputTick = -1n; let loginSwim = null
  const current = () => reloader?.current
  // Millisecond wall-clock prefix (JST, UTC+9) so combat/escape timelines can be rebuilt.
  // Every line is also appended to .local/bot.log for the dashboard's live log page.
  const log = message => {
    const line = `[${new Date(Date.now() + 9 * 3600000).toISOString().slice(11, 23)} JST] ${displayText(message)}`
    console.log(line)
    liveLog.write(line)
  }
  const reportResumeError = receipt => log(`行動の再開を見送り、接続を保持します: ${receipt.source}: ${receipt.message}`)
  const onlineEmergency = createOnlineEmergencyHandler({ getState: () => state, getShared: () => shared, getCurrent: current, getLife: () => lifecycle?.stats().deathId, now: Date.now, report: receipt => log(formatOnlineEmergency(receipt)) })
  const deathRespawn = createDeathRespawnReflex({ getState: () => state, getShared: () => shared, getLifecycle: () => lifecycle, getCurrent: current, isStopping: () => stopping, report: result => log(`死亡後の通常リスポーン: ${result.phase}${result.reason ? ` (${result.reason})` : ''}`) })
  const startupCreeperEvents = []
  const receiver = createHostPacketReceiver({ state, shared, meta, cache, applyState, world, entities, getLifecycle: () => lifecycle, getCurrent: current, log })
  const startupFuseGuard = createStartupFuseGuard({ getState: () => state, getShared: () => shared, getActors: () => entities.snapshot({ kind: 'all' }), isStopping: () => stopping, report: danger => {
    log('読み込み中に近くのクリーパーの点火を受信しました。接続を保持し、保護と観測を続けます。')
    if (process.env.MINECRAFT_CAPTURE_EMERGENCY === '1') {
      const stats = world.stats()
      const center = finite(state.position) ? { x: Math.floor(state.position.x), y: Math.floor(state.position.y - 1.62), z: Math.floor(state.position.z) } : null
      const blocks = stats.loadedSections && center ? world.getArea(center, 3) : []
      const capture = { observedAt: new Date().toISOString(), phase: state.phase, realmId: state.realm?.id ?? null, dimension: state.dimension, health: state.health, healthSource: state.healthSource, position: state.position, positionSource: state.positionSource, loadingScreenEnded: shared.loadingScreenEnded, inventoryKnown: state.inventory?.known === true, world: stats, danger, blocks, actors: entities.snapshot({ kind: 'hostile' }).filter(actor => actor.entityType === 'minecraft:creeper'), creeperEvents: startupCreeperEvents.slice() }
      console.log(`STARTUP_EMERGENCY_CAPTURE ${JSON.stringify(capture)}`)
    }
  }, onDanger: () => onlineEmergency({ reason: 'Loading-screen Creeper fuse observed', reasonCode: 'STARTUP_CREEPER', connectionId: state.connectionId }) })
  const packetEvents = createHostPacketEvents({
    receive: (name, packet) => {
      const perfStart = process.env.MINECRAFT_CAPTURE_EMERGENCY === '1' ? performance.now() : null
      if (CONTROL_EVENTS.has(name)) {
        controlInfo[name] = JSON.parse(JSON.stringify(packet, (_, value) => typeof value === 'bigint' ? String(value) : value))
        if (name === 'packet_violation_warning') console.error(`サーバーの通信警告: ${packet.severity} ${errorText(packet.reason)}`)
      }
      receiver.receive(name, packet)
      deathRespawn.observe()
      respawnTerrainHandoff.observe(name)
      if (name === 'level_chunk' && !stopping) requestStartupTerrain({ state, shared, world, queue: (type, data) => connection.queue(type, data), version: meta.version })
      if (process.env.MINECRAFT_CAPTURE_EMERGENCY === '1' && !shared.loadingScreenEnded && ['add_entity', 'set_entity_data', 'entity_event'].includes(name)) {
        const id = name === 'add_entity' ? packet.runtime_id : packet.runtime_entity_id
        const actor = entities.snapshot({ kind: 'all' }).find(item => item.runtimeId === String(id) && item.entityType === 'minecraft:creeper')
        if (actor) {
          const metadata = (Array.isArray(packet.metadata) ? packet.metadata : []).filter(entry => entry?.key === 'fuse_length' || entry?.key === 55 || entry?.key === 'flags' || entry?.key === 0).map(entry => ({ key: entry.key, value: entry.key === 'flags' || entry.key === 0 ? { ignited: entry.value?.ignited, powered: entry.value?.powered, charged: entry.value?.charged } : entry.value }))
          startupCreeperEvents.push({ at: new Date().toISOString(), name, runtimeId: actor.runtimeId, uniqueId: actor.uniqueId, position: actor.position, primed: actor.primed, ignited: actor.ignited, fuseLength: actor.fuseLength, tick: packet.tick == null ? null : String(packet.tick), metadata, loadedSections: world.stats().loadedSections, inventoryKnown: state.inventory.known, selectedSlot: state.selectedSlot, heldItem: state.heldItem })
          if (startupCreeperEvents.length > 80) startupCreeperEvents.shift()
        }
      }
      if (shared.safetyWanted === true && (shared.loadingScreenEnded !== true || shared.respawnTerrain?.pending) && ['start_game', 'move_player', 'correct_player_move_prediction', 'server_post_move', 'add_entity', 'entity_event', 'set_entity_data'].includes(name)) {
        startupFuseGuard.observe()
      }
      if (perfStart !== null) {
        const ms = performance.now() - perfStart
        shared.perfObservations ??= {}
        if (ms > (shared.perfObservations.packet?.ms ?? 0)) shared.perfObservations.packet = { name, ms }
      }
    },
    onError: error => { console.error(`状態取得: ${errorText(error)}`); current()?.stopActions(errorText(error)) }
  })
  packetEvents.registerPacketEvents([...PACKET_EVENTS, ...CONTROL_EVENTS])
  function workingSnapshot () {
    const result = rawSnapshot()
    result.rawServerPosition = result.position ? { ...result.position } : null
    result.rawSelectedSlot = result.selectedSlot
    result.rawServerPositionUpdatedAt = result.positionUpdatedAt
    result.dead = lifecycle?.stats().dead ?? state.dead ?? false
    if (shared.prediction && !result.dead && finite(shared.prediction.position)) {
      result.position = { ...shared.prediction.position }; result.positionSource = 'client_prediction'; result.positionServerConfirmed = false
      result.positionUpdatedAt = shared.prediction.updatedAt; result.predicted = structuredClone(shared.prediction)
    } else result.positionServerConfirmed = result.position != null
    if (shared.equipment && !result.dead) {
      result.selectedSlot = shared.equipment.slot
      result.heldItem = result.inventory.items.find(item => item.slot === shared.equipment.slot) ?? null
      result.equipmentSource = 'client_request'; result.equipmentServerConfirmed = false
    }
    return result
  }
  function setPrediction (prediction, source = 'navigation') {
    if (!prediction || !finite(prediction.position)) return
    shared.motionSource = source
    shared.prediction = { ...structuredClone(prediction), source: 'client_prediction', updatedAt: new Date().toISOString(), serverConfirmed: false }
  }
  function commitInventory (packet) { cache.observe('inventory_content', packet); applyState('inventory_content', packet) }
  // A hotbar selection we sent (the server does not echo our own mob_equipment).
  function commitSelection (slot) {
    if (!Number.isInteger(slot) || slot < 0 || slot > 8) return
    const packet = { selected_slot: slot, window_id: 'inventory', select_slot: true }
    cache.observe('player_hotbar', packet); applyState('player_hotbar', packet); shared.equipment = null
  }
  const connection = { queue (name, packet) {
    if (!client || stopping) throw new Error('Minecraftへの接続がありません。')
    if (name === 'player_auth_input') {
      let tick = BigInt(packet.tick)
      if (tick <= lastInputTick) tick = lastInputTick + 1n
      lastInputTick = tick; packet = { ...packet, tick }
      client.queue(name, packet)
      return { tick }
    }
    return client.queue(name, packet)
  } }
  const respawnTerrainHandoff = createRespawnTerrainHandoff({ getState: rawSnapshot, shared, world, queue: (name, packet) => connection.queue(name, packet), getCurrent: current, isStopping: () => stopping, onResumeError: reportResumeError })
  function allocate (kind) {
    const value = kind === 'craft' ? nextOdd : nextEven
    if (value < -2147483647) throw new Error('操作IDを使い切ったため接続の更新が必要です。')
    if (kind === 'craft') nextOdd -= 2
    else nextEven -= 2
    return value
  }
  function stop (code = 0) {
    if (stopping) return
    const cleanup = current()?.dispose('接続を終了します。'); stopping = true
    realmJoinAbort.abort()
    restoreRealmJoin?.()
    dashboardSession?.dispose()
    loginSwim?.stop(); packetEvents.dispose(); gcObserver?.disconnect()
    clearInterval(chunkTimer); reloader?.stop(); lifecycle?.stop('接続を終了します。')
    state.phase = 'disconnected'; terminal?.close(); client?.close(); api?.close(); api?.closeIdleConnections()
    process.exitCode = code
    const deadline = setTimeout(() => process.exit(code), 5000).unref()
    const finish = () => { clearTimeout(deadline); process.exit(code) }
    void Promise.all([cleanup, liveLog.close()]).then(finish, error => { console.error(`終了時の記録確認: ${errorText(error)}`); finish() })
  }
  process.once('SIGINT', () => stop()); process.once('SIGTERM', () => stop())
  const context = {
    client: connection, world, entities, cache, meta, shared, apiUrl: `http://127.0.0.1:${config.port}`,
    getState: workingSnapshot, getServerState: rawSnapshot, getServerFields: rawFields, commitInventory,
    // The one life counter: every death seen on this connection (src/life-identity.js).
    getLife: () => { const life = lifecycle?.stats(); return life ? { connectionId: state.connectionId, deathId: life.deathId, dead: life.dead === true } : null },
    commitSelection, setPrediction, allocate, log, onEmergency: onlineEmergency,
    disconnectOnCompletedQuarry: () => stop(0),
    registerPacketEvents: packetEvents.registerPacketEvents,
    setEquipmentPrediction: slot => { shared.equipment = { slot, requestedAt: new Date().toISOString() } },
    setCapabilities: values => { Object.assign(state.capabilities, values) }, noteProgress: progress => { shared.lastProgress = progress }
  }
  const watched = ['runtime', 'input', 'mining', 'walking', 'physics', 'navigation', 'movement', 'crafting', 'interactions', 'combat', 'water-counterattack', 'planner', 'autonomy', 'runner', 'immediate-diamond'].map(name => path.join(__dirname, `${name}.js`))
  try {
    await fs.mkdir(config.authDir, { recursive: true })
    const onMsaCode = data => { state.phase = 'authenticating'; if (managed) { dashboardSession?.auth(data); return } console.log(`Microsoft認証: ${data.verification_uri ?? 'https://www.microsoft.com/link'}\nコード: ${data.user_code}`) }
    const authflow = new Authflow(config.profile, config.authDir, { flow: 'live', authTitle: Titles.MinecraftNintendoSwitch, deviceType: 'Nintendo' }, onMsaCode)
    restoreRealmJoin = installRealmJoinHandling({
      Rest: require('prismarine-realms/src/rest'), fetch: require('node-fetch'), signal: realmJoinAbort.signal,
      onAttempt: event => {
        const retry = event.waitMs == null ? '' : `、${Math.ceil(event.waitMs / 1000)}秒後に再試行${event.retryAfterMs == null ? '' : '（サーバー指定）'}`
        log(`Realms参加先取得: HTTP ${event.status}、${event.attempt}回目、経過${Math.floor(event.elapsedMs / 1000)}秒${retry}`)
      }
    })
    if (managed) dashboardSession = require('./dashboard-session').createDashboardSession({
      onStop: async () => { try { await current()?.operations.quarry?.pause() } finally { stop() } },
      getRealms: () => RealmAPI.from(authflow, 'bedrock', { minecraftVersion: version }).getRealms()
    })
    log(`ログイン用プロフィール: ${config.profile}`)
    if (args.includes('--list')) { printRealms(await RealmAPI.from(authflow, 'bedrock', { minecraftVersion: version }).getRealms()); stop(); return }
    lifecycle = createLifecycle({ client: connection, getState: rawSnapshot, version,
      onDeath: () => { state.dead = true; respawnTerrainHandoff.cancel('Player died'); shared.prediction = null; shared.equipment = null; current()?.stopActions('死亡を確認しました。'); deathRespawn.observe() },
      onSpawnPending: () => { state.spawnPending = true; shared.prediction = null; shared.equipment = null; current()?.stopActions('参加位置の確定を待っています。') },
      onRespawn: result => { state.dead = false; state.spawnPending = false; state.health = result.health; shared.prediction = null; applyState('server_post_move', { position: result.position }); respawnTerrainHandoff.begin(result) }
    })
    reloader = createHotReloader({ entry: path.join(__dirname, 'runtime.js'), watchFiles: watched, createContext: () => context,
      canReload: () => !lifecycle.stats().pending && (current()?.canReload() ?? true),
      onSwap: next => { log('行動コードを反映しました。Minecraftへの接続は保持しています。'); setImmediate(() => { if (!stopping) resumeRuntimeSafely(next, { shared, source: 'reload', onError: reportResumeError }) }) },
      onError: error => console.error(`コード更新を見送りました: ${errorText(error)}`)
    })
    await reloader.loadInitial(); reloader.watch()
    const invoke = group => new Proxy({}, { get: (_, method) => (...params) => {
      // Dedicated legacy endpoints must obey the same reset lease as /action.
      const resetting = current()?.operations.loadout
      if (resetting?.status().busy) {
        if (method === 'stop') resetting.cancel()
        else throw new Error('初期アイテムのリセット中です。完了または中断を待ってください。')
      }
      const handler = current()?.operations[group]?.[method]
      if (typeof handler !== 'function') throw new Error('この行動は現在のコードで利用できません。')
      return handler(...params)
    } })
    function fullSnapshot () {
      const perfStart = process.env.MINECRAFT_CAPTURE_EMERGENCY === '1' ? performance.now() : null
      const working = workingSnapshot()
      const result = { ...working, ...current().snapshot(), world: world.stats(), lifecycle: lifecycle.stats(), onlineEmergency: structuredClone(shared.onlineEmergency ?? null), runtimeResumeError: structuredClone(shared.runtimeResumeError ?? null), deathRespawn: structuredClone(shared.deathRespawn ?? null), droppedItems: entities.snapshot(),
        nearbyHostiles: working.position ? entities.nearby(working.position, { radius: 16, kind: 'hostile' }) : [], entityStats: entities.stats(), hotReload: reloader.snapshot(), sessionCache: cache.snapshot(), controlInfo }
      if (perfStart !== null) {
        shared.perfObservations ??= {}
        shared.perfObservations.fullSnapshotMs = Math.max(shared.perfObservations.fullSnapshotMs ?? 0, performance.now() - perfStart)
      }
      return result
    }
    const dashboardControl = require('./dashboard-control').createDashboardControl({
      getState: () => { const observed = rawSnapshot(); return { ...observed, lifecycle: lifecycle.stats(), loadingScreenEnded: shared.loadingScreenEnded, inventory: shared.inventoryUncertain ? { ...observed.inventory, known: false, uncertain: true } : observed.inventory } },
      getQuarry: () => current()?.operations.quarry, getReset: () => current()?.operations.loadout, getStorage: () => current()?.operations.storage, getGeneration: () => reloader.snapshot().generation, disconnect: () => stop()
    })
    api = createApi({ dashboardControl, snapshot: fullSnapshot, disconnect: () => stop(), lifecycle: { ...lifecycle, respawn: options => deathRespawn.request(options) },
      mining: invoke('mining'), walking: invoke('walking'), movement: invoke('movement'), crafting: invoke('crafting'), interactions: invoke('interactions'), combat: invoke('combat'), agent: invoke('agent'), reload: () => reloader.reload({ reason: 'api' }),
      action: async ({ group, method, args = [] }) => {
        const operations = current().operations
        if (operations.loadout?.status().busy && group !== 'loadout') throw new Error('初期アイテムのリセット中です。中断は loadout.cancel を使用してください。')
        if (!Object.hasOwn(operations, group) || !Object.hasOwn(operations[group], method) || !Array.isArray(args) || args.length > 4) throw new Error('登録済みの行動と引数を指定してください。')
        return operations[group][method](...args)
      },
      blocks: query => {
        const currentState = workingSnapshot()
        if (!finite(currentState.position)) throw new Error('プレイヤー位置の取得を待ってください。')
        const center = { x: Math.floor(currentState.position.x), y: Math.floor(currentState.position.y - 1.62 + 0.001), z: Math.floor(currentState.position.z) }
        for (const axis of ['x', 'y', 'z']) { if (query[axis] !== undefined) { if (!/^-?\d+$/.test(query[axis]) || !Number.isSafeInteger(Number(query[axis]))) throw new Error('座標は整数で指定してください。'); center[axis] = Number(query[axis]) } }
        return { center, dimension: currentState.dimension, blocks: world.getArea(center, query.radius === undefined ? 1 : Number(query.radius)) }
      }
    })
    await new Promise((resolve, reject) => { api.once('error', reject); api.listen(config.port, '127.0.0.1', resolve) })
    api.on('error', error => { console.error(errorText(error)); stop(1) })
    log(`状態API: http://127.0.0.1:${config.port}/status`); log('行動コードの保存を監視しています。更新時も接続は維持します。')
    if (process.stdin.isTTY) {
      terminal = readline.createInterface({ input: process.stdin, output: process.stdout })
      terminal.on('SIGINT', () => stop()); terminal.on('close', () => stop())
      terminal.on('line', line => {
        const command = line.trim()
        if (command === '/quit') stop()
        else if (command === '/status') console.log(JSON.stringify(fullSnapshot(), null, 2))
        else if (command === '/stop') { current().operations.agent.stop('ターミナルから停止しました。'); void Promise.resolve(current().operations.quarry?.pause()).catch(() => {}) }
        else if (command === '/auto') current().operations.agent.start({})
        else if (command === '/reload') void reloader.reload({ reason: 'terminal' }).catch(error => console.error(errorText(error)))
        else if (command === '/quarry' || command.startsWith('/quarry ')) {
          void (async () => {
            const { method, args } = parseQuarryCommand(command, { position: state.position })
            const result = await current().operations.quarry[method](...args)
            console.log(JSON.stringify(method === 'status' || method === 'plan' ? result : { state: result?.state, result: result?.result ?? null, pauseReason: result?.pauseReason ?? null }, null, 2))
          })().catch(error => console.error(`露天掘り: ${errorText(error)}`))
        }
        else if (command) log('/status /auto /stop /reload /quarry /quit が使えます。')
      })
    }
    state.phase = 'authenticating'
    log(`Realms接続バージョン: ${version}`)
    client = bedrock.createClient({ username: config.profile, profilesFolder: config.authDir, authflow, offline: false, onMsaCode,
      raknetBackend: 'jsp-raknet', ...(config.version ? { version: config.version } : {}), conLog: message => log(message),
      realms: { pickRealm: async realms => {
        state.phase = 'selecting_realm'
        const realm = managed ? await dashboardSession.selectRealm(realms) : await chooseRealm(realms, { realmId: config.realmId, ask: terminal ? prompt => terminal.question(prompt) : undefined })
        state.realm = { id: String(realm.id), name: realm.name }; state.phase = 'connecting'; return realm
      } }
    })
    packetEvents.attachClient(client)
    client.viewDistance = 4
    client.on('join', () => { state.phase = 'joined'; state.playerName = client.profile?.name ?? null; meta.version = state.version = client.options.version; log(`ログイン成功: ${state.playerName}`) })
    let loginRespawnAttempted = false
    function requestChunks () {
      if (stopping || state.phase !== 'spawned') return
      deathRespawn.observe()
      if (respawnTerrainHandoff.pending()) { respawnTerrainHandoff.observe('timer'); return }
      const life = lifecycle.stats()
      // A dead reconnect can start at an out-of-world placeholder. Ask for
      // terrain at the server's ready destination without presenting that
      // destination as the player's confirmed position.
      const requestPosition = life.spawnPending && life.readyPosition ? life.readyPosition : workingSnapshot().position
      const request = world.buildSubchunkRequest(requestPosition)
      if (request) connection.queue('subchunk_request', request)
      if (shared.loadingScreenEnded && !life.spawnPending) {
        for (const survey of world.buildSurfaceSurveyRequests(requestPosition, { horizontalRadius: 4, maxRequestsPerBatch: 4 })) connection.queue('subchunk_request', survey)
      }
      const readyFeet = life.spawnPending && life.readyPosition ? { x: Math.floor(life.readyPosition.x), y: Math.floor(life.readyPosition.y - 1.62), z: Math.floor(life.readyPosition.z) } : null
      const destinationKnown = !readyFeet || world.getBlock(readyFeet.x, readyFeet.y, readyFeet.z).known
      if (!shared.loadingScreenEnded && world.stats().loadedSections > 0 && destinationKnown && meta.version === '1.26.60') {
        connection.queue('serverbound_loading_screen', { type: 2, loading_screen_id: null })
        shared.loadingScreenEnded = state.loadingScreenEnded = true; resumeRuntimeSafely(current(), { shared, source: 'loading_ready', onError: reportResumeError })
      }
      if (shared.safetyWanted === true && shared.loadingScreenEnded && life.spawnPending && life.readyPosition && !loginRespawnAttempted) {
        loginRespawnAttempted = true
        log('参加位置の確定を要求します。')
        const recovery = lifecycle.respawn()
        loginSwim = createRespawnSwim({ world, client: connection, getState: rawSnapshot, getLife: () => lifecycle.stats(), getActors: () => entities.snapshot({ kind: 'all' }), getShared: () => shared, meta })
        if (loginSwim.start()) log('参加位置で短い上下移動を試みます。')
        void recovery.then(() => { loginSwim?.stop(); log('参加位置をサーバーで確認しました。') }, error => { loginSwim?.stop(); state.lastError = errorText(error); log(`参加位置を確認できませんでした: ${state.lastError}`) })
      }
    }
    client.on('spawn', () => {
      state.phase = 'spawned'; state.connectedAt = new Date().toISOString()
      deathRespawn.observe()
      try { current().onSpawn() } catch (error) { state.lastError = errorText(error); log(`操作の初期化を見送りました: ${state.lastError}`) }
      log('ワールドに参加しました。接続を保ったまま行動コードを更新できます。'); requestChunks(); chunkTimer = setInterval(requestChunks, 2000)
    })
    client.on('kick', packet => { if (!stopping) { log(`接続終了: ${packet.message}`); stop(1) } })
    client.on('error', error => { if (!stopping) { dashboardSession?.failed(error); console.error(errorText(error)); stop(error.code === 'CANCELLED' ? 0 : 1) } })
    client.on('close', () => { if (!stopping) { log('サーバーとの接続が閉じられました。'); stop(1) } })
  } catch (error) { if (!stopping) { dashboardSession?.failed(error); console.error(errorText(error)); stop(error.code === 'CANCELLED' ? 0 : 1) } }
}

module.exports = { main, errorText, createHostPacketEvents, createHostPacketReceiver, startupFuseDanger, createStartupFuseGuard, resumeRuntimeSafely, formatOnlineEmergency, createOnlineEmergencyHandler, createDeathRespawnReflex, requestStartupTerrain, respawnTerrainKnown, createRespawnTerrainHandoff }
