'use strict'

// Player mode keeps playing after the survival autonomy gives up. A run that
// ends 'blocked' or 'failed' is never restarted at once (live 2026-11-15: the
// exploration limit ended the run and the runtime restarted it every 0.4 s).
// - Wood is needed and none is near (the plan says "explore for logs"), or the
//   exploration limit ended the run: walk to the nearest log in the received
//   terrain; with none received, walk 96 m straight ahead and look there
//   (user 2026-11-15 17:15 JST: 「読み込みチャンクの一番近い木に向かえ、
//   なければ適当に歩いて木を探せ」). Then start with a fresh exploration budget.
//   The heading is kept from walk to walk and turns 60 degrees only when a walk
//   got nowhere: points on a ring around the start kept the Bot within 150 m
//   of a badlands spawn for 25 minutes (live 2026-11-15 20:21-20:46 JST). It
//   starts toward the nearest received grass, where trees are likelier.
// - Anything else: start again after a growing pause.
// The reason is logged and shown as the player status while this owns the wait.
const { normalizeMode } = require('./bot-mode')

const LOG = /^(?:minecraft:)?[a-z_]+_(?:log|stem)$/
const TRIP_LIMIT = 8
const TRIP_MS = 240000
const STEP_M = 96
const GRASS = /^(?:minecraft:)?grass_block$/
const SCAN_M = 128 // about the terrain a Realm sends around the Bot
// At most two minutes (user 2026-11-15 22:50 JST: 「６００秒長すぎない？」).
const PAUSES_MS = [30000, 60000, 120000]
const text = value => String(value ?? '').replace(/[\p{C}§]/gu, ' ').slice(0, 200)

// Nearest received log block between `min` and `radius` metres. Unreceived
// terrain is skipped, never read as "no tree". `avoid` holds trees already
// walked to that did not end the search.
async function nearestKnownLog ({ getBlock, position, radius = SCAN_M, min = 6, step = 2, avoid = [], match = LOG, below = 8, pause = () => new Promise(resolve => setImmediate(resolve)) }) {
  if (!position || ![position.x, position.y, position.z].every(Number.isFinite)) return null
  const hx = Math.floor(position.x), hy = Math.floor(position.y - 1.62), hz = Math.floor(position.z)
  let best = null
  for (let dx = -radius; dx <= radius; dx += step) {
    for (let dz = -radius; dz <= radius; dz += step) {
      const distance = Math.hypot(dx, dz)
      if (distance < min || distance > radius || best && distance >= best.distance) continue
      if (avoid.some(point => Math.hypot(point.x - hx - dx, point.z - hz - dz) < 8)) continue
      for (let dy = -below; dy <= 24; dy++) {
        const block = getBlock(hx + dx, hy + dy, hz + dz)
        if (block?.known === true && match.test(block.name ?? '')) { best = { x: hx + dx, z: hz + dz, distance }; break }
      }
    }
    await pause()
  }
  return best
}

// 96 m from where the Bot stands, along the search heading (radians, 0 = +x).
function aheadPoint (position, heading) {
  return { x: Math.round(position.x + Math.cos(heading) * STEP_M), z: Math.round(position.z + Math.sin(heading) * STEP_M) }
}

// Where the stopped run's last decision wanted to work, when that is between
// 24 m and 512 m from the Bot.
function farTarget (snapshot, position) {
  const point = snapshot?.lastDecision?.resourceTarget ?? snapshot?.lastDecision?.target
  if (!position || !point || ![point.x, point.z].every(Number.isFinite)) return null
  const distance = Math.hypot(point.x + 0.5 - position.x, point.z + 0.5 - position.z)
  return distance > 24 && distance <= 512 ? { x: Math.floor(point.x), z: Math.floor(point.z) } : null
}

const seeksWood = snapshot => snapshot?.lastDecision?.type === 'explore' && snapshot.lastDecision.resource === 'logs'

function createPlayerRecovery ({ getMode, shared, agent, travel, held = () => false, getBlock, getPosition, disposed = () => false, log = () => {}, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now }) {
  let run = null, trips = 0, pauses = 0, heading = null, logsSeen = 0, reason = null, visited = []
  const live = token => run === token && !disposed() && normalizeMode(getMode()) === 'player'

  async function wait (token, ms) {
    const until = now() + ms
    while (live(token) && now() < until) await sleep(Math.min(1000, until - now()))
    return live(token)
  }

  // Tries until it starts or this recovery is cancelled: giving up here left the
  // player stopped for good (live 2026-11-15 18:23 JST, after a failed chunk move).
  async function restart (token, options) {
    for (let attempt = 0; live(token); attempt++) {
      try {
        await agent.start(options)
        if (shared.autoOptions) { delete shared.autoOptions.freshExploration; delete shared.autoOptions.freshExclusions }
        return true
      } catch (error) {
        reason = `再開を待っています: ${text(error?.message)}`
        if (attempt === 0) log(`プレイヤーモード: ${reason}`)
        if (!await wait(token, attempt < 10 ? 3000 : 15000)) return false
      }
    }
    return false
  }

  async function trip (token, snapshot, goal = null) {
    const position = getPosition()
    if (!position) return false
    const wood = seeksWood(snapshot), from = { x: position.x, z: position.z }
    const tree = !goal && wood ? await nearestKnownLog({ getBlock, position, avoid: visited }) : null
    if (!live(token)) return false
    if (!goal && !tree && heading === null) {
      const grass = await nearestKnownLog({ getBlock, position, match: GRASS, min: 16, step: 4, below: 24 })
      if (!live(token)) return false
      heading = grass ? Math.atan2(grass.z - Math.floor(position.z), grass.x - Math.floor(position.x)) : 0
    }
    const destination = goal ? { x: goal.x, z: goal.z } : tree ? { x: tree.x, z: tree.z } : aheadPoint(position, heading)
    if (tree) visited = [...visited.slice(-15), destination]
    reason = goal ? `次の作業の場所 (${destination.x}, ${destination.z}) が遠いため、そこへ移動しています。` : tree ? `木が見える (${destination.x}, ${destination.z}) へ移動しています。` : `近くに${wood ? '木' : '資源'}が見つからないため、(${destination.x}, ${destination.z}) へ移動して探します。`
    log(`プレイヤーモード: ${reason}`)
    try { await travel.to({ destination }) } catch (error) { log(`プレイヤーモード: 移動を始められません ${text(error?.message)}`) }
    const until = now() + TRIP_MS
    // A death moves the Bot to its spawn point: the search goes on from there,
    // never back across the map to the old destination (live 2026-11-15 21:44
    // JST: after a respawn the walk went on toward a point 14 km away).
    const lost = () => { const at = getPosition(); return !!at && Math.hypot(at.x - destination.x, at.z - destination.z) > SCAN_M * 3 }
    while (live(token) && now() < until && travel.status()?.busy && !lost()) await sleep(1000)
    if (lost() && !goal) { log('プレイヤーモード: 目的地から大きく離れたため、この移動をやめて今の場所から探し直します'); heading = null; visited = [] }
    // A walk that got nowhere (a cliff, water, no route): try the next direction.
    const reached = getPosition()
    if (!goal && !tree && heading !== null && reached && Math.hypot(reached.x - from.x, reached.z - from.z) < STEP_M / 4) heading += Math.PI / 3
    // The trip dug a night or rest pit: the shelter keeps the Bot there and plays on afterwards.
    if (held()) return live(token)
    if (travel.status()?.busy) { try { await travel.cancel() } catch {} }
    return live(token)
  }

  async function recover (token, snapshot) {
    const why = text(snapshot.reason), search = snapshot.running === true || snapshot.stopCode === 'exploration_limit'
    if (snapshot.running === true) { try { agent.stop('木を探して移動します。') } catch {} } else log(`プレイヤーモード: 自律作業が止まりました（${why}）`)
    const logs = snapshot.progress?.logsCollected ?? 0
    if (logs > logsSeen) { trips = 0; heading = null; visited = [] }
    logsSeen = logs
    if (now() - (snapshot.startedAtMs ?? now()) > 600000) pauses = 0
    if (search && trips < TRIP_LIMIT) {
      trips++
      await trip(token, snapshot)
      // In a pit the trip dug, the shelter holds the Bot and plays on afterwards.
      if (!live(token) || held()) return false
      return restart(token, { ...agent.objective, freshExploration: true })
    }
    // The work the plan asked for is far away (live 2026-11-15 23:00 JST: iron
    // ore 113 m off, "outside the bounded tunneling area", three stops in a
    // row): walk there first, then go on. Once there the distance is short, so
    // the same place is not walked to twice.
    const far = farTarget(snapshot, getPosition())
    if (!search && far && trips < TRIP_LIMIT) {
      trips++
      await trip(token, snapshot, far)
      if (!live(token) || held()) return false
      return restart(token, { ...agent.objective })
    }
    // The list of unreachable candidates filled up (live 2026-11-15 22:01 JST: a
    // cobblestone drop in a hole under the feet; every retry ten minutes later
    // met the same full list and stopped within ten seconds). Start again soon
    // with an empty list: what is still out of reach is excluded again, the
    // rest of the list is free for other stone and drops.
    if (snapshot.stopCode === 'exclusion_limit') {
      reason = `${why} ${Math.round(PAUSES_MS[0] / 1000)}秒後に、除外した候補を忘れてやり直します。`
      log(`プレイヤーモード: ${Math.round(PAUSES_MS[0] / 1000)}秒後に、除外した候補を忘れてやり直します`)
      if (!await wait(token, PAUSES_MS[0])) return false
      return restart(token, { ...agent.objective, freshExclusions: true })
    }
    // A search only rests between sets of walks; other stops wait longer each time.
    const pause = search ? PAUSES_MS[0] : PAUSES_MS[Math.min(pauses++, PAUSES_MS.length - 1)]
    reason = `${why} ${Math.round(pause / 1000)}秒後にやり直します。`
    log(`プレイヤーモード: ${Math.round(pause / 1000)}秒後にやり直します`)
    if (search) { trips = 0; visited = [] }
    if (!await wait(token, pause)) return false
    return restart(token, { ...agent.objective, ...(search ? { freshExploration: true } : {}) })
  }

  // Called with every autonomy progress snapshot.
  function onProgress (snapshot) {
    if (run || !snapshot || normalizeMode(getMode()) !== 'player' || shared.autoWanted !== true) return false
    // Running: only the search for wood is taken over. Stopped: blocked and failed runs.
    if (snapshot.running ? !seeksWood(snapshot) : !['blocked', 'failed'].includes(snapshot.phase)) return false
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

  // The player wants to play but nothing is running and nothing here owns the
  // pause (a run ended 'stopped' by a failed action, a restart that never
  // happened): after ten idle seconds, start again.
  let idleSince = null
  function keepPlaying ({ running, resting = false }) {
    if (run || resting || running || shared.playerWanted !== true || shared.autoWanted === true || normalizeMode(getMode()) !== 'player' || disposed() || travel.status()?.busy) { idleSince = null; return false }
    idleSince ??= now()
    if (now() - idleSince < 10000) return false
    idleSince = null
    log('プレイヤーモード: 止まっていたので再開します')
    shared.playerRecovering = true
    const token = run = {}
    reason = '再開しています。'
    void restart(token, { ...agent.objective }).catch(() => {}).finally(() => { if (run === token) { run = null; reason = null; if (!disposed()) shared.playerRecovering = false } })
    return true
  }

  function cancel () {
    const active = run !== null
    run = null; reason = null; trips = 0; pauses = 0; heading = null; visited = []
    shared.playerRecovering = false
    if (active && travel.status()?.busy) void Promise.resolve().then(() => travel.cancel()).catch(() => {})
    return active
  }

  return { onProgress, keepPlaying, cancel, status: () => ({ active: run !== null, reason }) }
}

module.exports = { createPlayerRecovery, nearestKnownLog, aheadPoint, farTarget, TRIP_LIMIT }
