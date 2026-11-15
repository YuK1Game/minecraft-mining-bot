'use strict'

// Player mode keeps playing after the survival autonomy gives up. A run that
// ends 'blocked' or 'failed' is never restarted at once (live 2026-11-15: the
// exploration limit ended the run and the runtime restarted it every 0.4 s).
// - Exploration limit: walk far (to the nearest received log when wood is the
//   need, otherwise to the next point of a ring), then start with a fresh
//   exploration budget.
// - Anything else: start again after a growing pause.
// The reason is logged and shown as the player status while this owns the wait.
const { normalizeMode } = require('./bot-mode')

const LOG = /^(?:minecraft:)?[a-z_]+_(?:log|stem)$/
const TRIP_LIMIT = 8
const TRIP_MS = 240000
const RING_M = 96
const PAUSES_MS = [30000, 60000, 120000, 300000, 600000]
const text = value => String(value ?? '').replace(/[\p{C}§]/gu, ' ').slice(0, 200)

// Nearest received log block between `min` and `radius` metres. Unreceived
// terrain is skipped, never read as "no tree".
async function nearestKnownLog ({ getBlock, position, radius = RING_M, min = 16, step = 2, pause = () => new Promise(resolve => setImmediate(resolve)) }) {
  if (!position || ![position.x, position.y, position.z].every(Number.isFinite)) return null
  const hx = Math.floor(position.x), hy = Math.floor(position.y - 1.62), hz = Math.floor(position.z)
  let best = null
  for (let dx = -radius; dx <= radius; dx += step) {
    for (let dz = -radius; dz <= radius; dz += step) {
      const distance = Math.hypot(dx, dz)
      if (distance < min || distance > radius || best && distance >= best.distance) continue
      for (let dy = -8; dy <= 24; dy++) {
        const block = getBlock(hx + dx, hy + dy, hz + dz)
        if (block?.known === true && LOG.test(block.name ?? '')) { best = { x: hx + dx, z: hz + dz, distance }; break }
      }
    }
    await pause()
  }
  return best
}

// Trip n (1-based) from the anchor: six directions at 96 m, then 192 m.
function ringPoint (anchor, trip) {
  const angle = (trip - 1) * Math.PI / 3, radius = RING_M * Math.ceil(trip / 6)
  return { x: Math.round(anchor.x + Math.cos(angle) * radius), z: Math.round(anchor.z + Math.sin(angle) * radius) }
}

function createPlayerRecovery ({ getMode, shared, agent, travel, getBlock, getPosition, disposed = () => false, log = () => {}, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now }) {
  let run = null, trips = 0, pauses = 0, anchor = null, logsSeen = 0, reason = null
  const live = token => run === token && !disposed() && normalizeMode(getMode()) === 'player'

  async function wait (token, ms) {
    const until = now() + ms
    while (live(token) && now() < until) await sleep(Math.min(1000, until - now()))
    return live(token)
  }

  async function restart (token, options) {
    for (let attempt = 0; attempt < 10 && live(token); attempt++) {
      try {
        await agent.start(options)
        if (shared.autoOptions) delete shared.autoOptions.freshExploration
        return true
      } catch (error) {
        reason = `再開を待っています: ${text(error?.message)}`
        if (!await wait(token, 3000)) return false
      }
    }
    return false
  }

  async function trip (token, snapshot) {
    const position = getPosition()
    if (!position) return false
    anchor ??= { x: position.x, z: position.z }
    const wood = snapshot.lastDecision?.resource === 'logs'
    const tree = wood ? await nearestKnownLog({ getBlock, position }) : null
    if (!live(token)) return false
    const destination = tree ? { x: tree.x, z: tree.z } : ringPoint(anchor, trips)
    reason = tree ? `木が見える (${destination.x}, ${destination.z}) へ移動しています。` : `近くに${wood ? '木' : '資源'}が見つからないため、(${destination.x}, ${destination.z}) へ移動して探します。`
    log(`プレイヤーモード: ${reason}`)
    try { await travel.to({ destination }) } catch (error) { log(`プレイヤーモード: 移動を始められません ${text(error?.message)}`) }
    const until = now() + TRIP_MS
    while (live(token) && now() < until && travel.status()?.busy) await sleep(1000)
    if (travel.status()?.busy) { try { await travel.cancel() } catch {} }
    return live(token)
  }

  async function recover (token, snapshot) {
    const why = text(snapshot.reason)
    log(`プレイヤーモード: 自律作業が止まりました（${why}）`)
    const logs = snapshot.progress?.logsCollected ?? 0
    if (logs > logsSeen) { trips = 0; anchor = null }
    logsSeen = logs
    if (now() - (snapshot.startedAtMs ?? now()) > 600000) pauses = 0
    if (snapshot.stopCode === 'exploration_limit' && trips < TRIP_LIMIT) {
      trips++
      if (await trip(token, snapshot)) return restart(token, { ...agent.objective, freshExploration: true })
      return false
    }
    const pause = PAUSES_MS[Math.min(pauses++, PAUSES_MS.length - 1)]
    reason = `${why} ${Math.round(pause / 1000)}秒後にやり直します。`
    log(`プレイヤーモード: ${Math.round(pause / 1000)}秒後にやり直します`)
    if (snapshot.stopCode === 'exploration_limit') { trips = 0; anchor = null }
    if (!await wait(token, pause)) return false
    return restart(token, { ...agent.objective, ...(snapshot.stopCode === 'exploration_limit' ? { freshExploration: true } : {}) })
  }

  // Called with every autonomy progress snapshot.
  function onProgress (snapshot) {
    if (run || !snapshot || snapshot.running || !['blocked', 'failed'].includes(snapshot.phase)) return false
    if (normalizeMode(getMode()) !== 'player' || shared.autoWanted !== true) return false
    // The runtime restarts a stopped run at once while autoWanted is set.
    shared.autoWanted = false
    shared.playerRecovering = true
    const token = run = {}
    reason = text(snapshot.reason)
    void recover(token, snapshot).catch(error => log(`プレイヤーモード: 復帰に失敗 ${text(error?.message)}`)).finally(() => {
      if (run !== token) return
      run = null; reason = null
      // A hot reload mid-recovery leaves the flag; the next runtime resumes play.
      if (!disposed()) shared.playerRecovering = false
    })
    return true
  }

  function cancel () {
    const active = run !== null
    run = null; reason = null; trips = 0; pauses = 0; anchor = null
    shared.playerRecovering = false
    if (active && travel.status()?.busy) void Promise.resolve().then(() => travel.cancel()).catch(() => {})
    return active
  }

  return { onProgress, cancel, status: () => ({ active: run !== null, reason }) }
}

module.exports = { createPlayerRecovery, nearestKnownLog, ringPoint, TRIP_LIMIT }
