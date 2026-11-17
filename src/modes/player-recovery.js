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
const SHORT_MS = 30 * 60000 // a far place a walk did not reach
const PIT_LIMIT = 3 // tries to step out of a pit, per ten minutes
const WATER_LIMIT = 3 // swims onto a ledge after a stop, per ten minutes
const SETTLE_LIMIT = 3 // walks to the middle of the block, per ten minutes
const { underCover, surfaceAhead } = require('./player-surface')
const { createRepeat, elsewhere } = require('./player-repeat')
const TRIP_MS = 240000
const OVERHEAD_M = 8
const STEP_M = 96
const GRASS = /^(?:minecraft:)?grass_block$/
const SCAN_M = 128 // about the terrain a Realm sends around the Bot
// At most two minutes (user 2026-11-15 22:50 JST: 「６００秒長すぎない？」).
// Rests are not an answer to a stop (user, 2026-11-16): the search for wood
// rests five seconds between sets of walks, and a stop that came back even
// after the far walks rests thirty seconds so it cannot spin.
const PAUSES_MS = [5000, 15000, 30000]
const SPIN_AFTER = 6
const text = value => String(value ?? '').replace(/[\p{C}§]/gu, ' ').slice(0, 200)

// Nearest received log block between `min` and `radius` metres. Unreceived
// terrain is skipped, never read as "no tree". `avoid` holds trees already
// walked to that did not end the search.
async function nearestKnownLog ({ getBlock, position, radius = SCAN_M, min = 6, step = 2, avoid = [], avoidM = 8, match = LOG, accept = null, below = 8, pause = () => new Promise(resolve => setImmediate(resolve)) }) {
  if (!position || ![position.x, position.y, position.z].every(Number.isFinite)) return null
  const hx = Math.floor(position.x), hy = Math.floor(position.y - 1.62), hz = Math.floor(position.z)
  let best = null
  for (let dx = -radius; dx <= radius; dx += step) {
    for (let dz = -radius; dz <= radius; dz += step) {
      const distance = Math.hypot(dx, dz)
      if (distance < min || distance > radius || best && distance >= best.distance) continue
      if (avoid.some(point => Math.hypot(point.x - hx - dx, point.z - hz - dz) < avoidM)) continue
      for (let dy = -below; dy <= 24; dy++) {
        const block = getBlock(hx + dx, hy + dy, hz + dz)
        if (block?.known === true && match.test(block.name ?? '') && (!accept || accept(hx + dx, hy + dy, hz + dz))) { best = { x: hx + dx, y: hy + dy, z: hz + dz, distance }; break }
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
// 24 m and 512 m from the Bot. A target DEEP_M or more below the feet and
// within TUNNEL_REACH_M is left to the tunnel: long travel only walks the
// surface (live 2026-11-16 21:55 JST: an ore 68 below, 45 m away, sent the
// Bot on surface travel that found no walking route for minutes).
const DEEP_M = 8, TUNNEL_REACH_M = 96
function farTarget (snapshot, position) {
  const point = snapshot?.lastDecision?.resourceTarget ?? snapshot?.lastDecision?.target
  if (!position || !point || ![point.x, point.z].every(Number.isFinite)) return null
  const distance = Math.hypot(point.x + 0.5 - position.x, point.z + 0.5 - position.z)
  const deep = Number.isFinite(point.y) && Number.isFinite(position.y) && point.y <= position.y - 1.62 - DEEP_M
  if (deep && distance <= TUNNEL_REACH_M) return null
  return distance > 24 && distance <= 512 ? { x: Math.floor(point.x), z: Math.floor(point.z) } : null
}

// How many blocks above the feet the stopped run's last decision wanted to
// work, when that is at least OVERHEAD_M (a tunnel only descends or stays level).
function overhead (snapshot, position) {
  const point = snapshot?.lastDecision?.resourceTarget ?? snapshot?.lastDecision?.target
  if (!position || !Number.isFinite(point?.y) || !Number.isFinite(position.y)) return 0
  const up = Math.floor(point.y - (position.y - 1.62))
  return up >= OVERHEAD_M ? up : 0
}

// The stopped run was walking to a table or furnace.
const stationMove = snapshot => snapshot?.lastDecision?.type === 'move_to' && ['crafting_table', 'table', 'furnace'].includes(snapshot.lastDecision.resource ?? snapshot.lastDecision.stage)
const seeksWood = snapshot => snapshot?.lastDecision?.type === 'explore' && snapshot.lastDecision.resource === 'logs'

function createPlayerRecovery ({ getMode, shared, agent, travel, climb = null, pit = null, settle = null, water = null, prey = null, held = () => false, getBlock, getPosition, disposed = () => false, log = () => {}, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now }) {
  let run = null, trips = 0, pits = 0, pitAt = 0, settles = 0, settleAt = 0, waters = 0, waterAt = 0, heading = null, logsSeen = 0, reason = null, visited = []
  const repeat = createRepeat({ now })
  let turns = 0
  // Far work places a walk did not reach: not walked to again for SHORT_MS (live
  // 2026-11-17 23:26-23:36 JST: the same ore 160 m west, each walk ended with no
  // route, 181 legs without progress, or the danger zone, and was started again).
  const short = new Map()
  const shortKey = point => `${Math.floor(point.x / 16)},${Math.floor(point.z / 16)}`
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
    // From a tunnel the trees stand overhead: first out to the open sky (player-surface.js).
    // Any search walk too: the long walk only crosses open ground (real Realm
    // 2026-11-17 01:00-01:04 JST: at y -50 in a dug tunnel, the walk to look
    // elsewhere answered 「歩ける中継点が見つかりません」 every 5 s for four minutes).
    const under = !goal && underCover(getBlock, position)
    const destination = goal ? { x: goal.x, z: goal.z } : under ? surfaceAhead(position, tree, heading) : tree ? { x: tree.x, z: tree.z } : aheadPoint(position, heading)
    if (tree && !under) visited = [...visited.slice(-15), destination]
    reason = under ? `地下にいるため、先に地上へ出ます（(${destination.x}, ${destination.z}) の方向）。` : goal?.label ? `${goal.label} (${destination.x}, ${destination.z}) へ歩いて近づきます。` : goal ? `次の作業の場所 (${destination.x}, ${destination.z}) が遠いため、そこへ移動しています。` : tree ? `木が見える (${destination.x}, ${destination.z}) へ移動しています。` : `近くに${wood ? '木' : '資源'}が見つからないため、(${destination.x}, ${destination.z}) へ移動して探します。`
    // No walk leads out of a closed tunnel: straight up first (player-climb.js); the walk below is the fallback.
    // A walk to a known place (a food source...) too: long travel only crosses
    // open ground (live 2026-11-17 08:10-08:13 JST: 13 below the surface, the
    // walk to a sheep found no waypoint and no route, twice, with no food held).
    if (goal && climb && underCover(getBlock, position)) {
      log(`プレイヤーモード: 地下にいるため、先に真上へ掘って地上へ出ます（${goal.label ?? '目的地'} (${destination.x}, ${destination.z}) へ行く前）。`)
      let out = null
      try { out = await climb(() => !live(token)) } catch (error) { log(`プレイヤーモード: 真上へ掘れません ${text(error?.message)}`) }
      if (!live(token)) return false
    }
    if (under && climb) {
      reason = '地下にいるため、真上へ掘って地上へ出ます。'
      log(`プレイヤーモード: ${reason}`)
      let out = null
      try { out = await climb(() => !live(token)) } catch (error) { log(`プレイヤーモード: 真上へ掘れません ${text(error?.message)}`) }
      if (out?.ok || !live(token)) return live(token)
      reason = `地下にいるため、先に地上へ出ます（(${destination.x}, ${destination.z}) の方向）。`
    }
    log(`プレイヤーモード: ${reason}`)
    try { await travel.to({ destination }) } catch (error) { log(`プレイヤーモード: 移動を始められません ${text(error?.message)}`) }
    const until = now() + TRIP_MS
    // A death moves the Bot to its spawn point: the search goes on from there,
    // never back across the map to the old destination (live 2026-11-15 21:44
    // JST: after a respawn the walk went on toward a point 14 km away).
    // Measured from where the walk began: a goal up to 512 m off (farTarget) is
    // farther than 384 m at the start (live 2026-11-17 19:25-19:26 JST: a diamond
    // 413 m away, every walk cancelled 3 ms after it began, eight times).
    const start = Math.hypot(position.x - destination.x, position.z - destination.z)
    const lost = () => { const at = getPosition(); return !!at && Math.hypot(at.x - destination.x, at.z - destination.z) > Math.max(SCAN_M * 3, start + SCAN_M) }
    while (live(token) && now() < until && travel.status()?.busy && !lost() && !(under && !underCover(getBlock, getPosition()))) await sleep(1000)
    if (lost() && !goal) { log('プレイヤーモード: 目的地から大きく離れたため、この移動をやめて今の場所から探し直します'); heading = null; visited = [] }
    // A walk that got nowhere (a cliff, water, no route): try the next direction.
    const reached = getPosition()
    if (!goal && !tree && !under && heading !== null && reached && Math.hypot(reached.x - from.x, reached.z - from.z) < STEP_M / 4) heading += Math.PI / 3
    // The trip dug a night or rest pit: the shelter keeps the Bot there and plays on afterwards.
    if (held()) return live(token)
    if (travel.status()?.busy) { try { await travel.cancel() } catch {} }
    return live(token)
  }

  async function recover (token, snapshot) {
    const why = text(snapshot.reason), search = snapshot.running === true || snapshot.stopCode === 'exploration_limit'
    if (snapshot.running === true) { try { agent.stop('木を探して移動します。') } catch {} } else log(`プレイヤーモード: 自律作業が止まりました（${why}）`)
    const logs = snapshot.progress?.logsCollected ?? 0
    if (logs > logsSeen) { trips = 0; pits = 0; settles = 0; heading = null; visited = [] }
    logsSeen = logs
    // Afloat (player-water.js): the ordinary walk does not plan in water and
    // the shore return of the autonomy keeps failing (real Realm 2026-11-17
    // 09:08 JST: 「No safe known shore route is accepted by the live movement
    // preview」 for 20 minutes in a one-deep pool): onto a ledge with the water exit.
    if (now() - waterAt > 600000) waters = 0
    if (water && waters < WATER_LIMIT && water.needed()) {
      waters++; waterAt = now()
      log('プレイヤーモード: 水の中で止まったため、岸へ上がってから続けます。')
      let out = null
      try { out = await water.exit(() => !live(token)) } catch (error) { log(`プレイヤーモード: 水から上がれません ${text(error?.message)}`) }
      if (!live(token) || held()) return false
      if (out?.ok) { waters = 0; return restart(token, { ...agent.objective }) }
    }
    // At the bottom of a hole no walk leads out of (player-pit.js): a step is
    // cut into the wall first; every other answer below needs a walk.
    // Under a roof the climb below (straight up) is the way out.
    if (now() - pitAt > 600000) pits = 0
    if (pit && pits < PIT_LIMIT && !underCover(getBlock, getPosition()) && pit.boxed()) {
      pits++; pitAt = now()
      reason = '歩いて出られない穴の中にいるため、壁を掘って段を作り、外へ出ます。'
      log(`プレイヤーモード: ${reason}`)
      let out = null
      try { out = await pit.out(() => !live(token)) } catch (error) { log(`プレイヤーモード: 穴から出られません ${text(error?.message)}`) }
      if (!live(token) || held()) return false
      if (out?.ok) { pits = 0; return restart(token, { ...agent.objective, freshExclusions: true }) }
    }
    // Against a wall or at the rim of a hole the planners answer "settle first"
    // and nothing moves (player-settle.js): to the middle of the block, then on.
    if (now() - settleAt > 600000) settles = 0
    if (!search && settle && settles < SETTLE_LIMIT && settle.needed()) {
      settles++
      settleAt = now()
      log('プレイヤーモード: マスの中央に立ち直してから続けます。')
      let out = null
      try { out = await settle.run(() => !live(token)) } catch (error) { log(`プレイヤーモード: 立ち直せません ${text(error?.message)}`) }
      if (!live(token) || held()) return false
      if (out?.ok) return restart(token, { ...agent.objective })
      log(`プレイヤーモード: マスの中央に立てませんでした（${text(out?.reason)}${out?.detail ? ` ${text(out.detail)}` : ''}）`)
    }
    if (search && trips < TRIP_LIMIT) {
      trips++
      await trip(token, snapshot)
      // In a pit the trip dug, the shelter holds the Bot and plays on afterwards.
      if (!live(token) || held()) return false
      return restart(token, { ...agent.objective, freshExploration: true })
    }
    // Underground, the table or furnace cannot be walked to and nothing held
    // makes another (real Realm 2026-11-16 07:46-07:53 JST: at y 55 with raw
    // iron and coal, three stops on the walled-in stations of an old tunnel
    // while the usable ones stood on the surface 22 blocks up): straight up
    // (player-climb.js); the stations and the trees are there.
    if (!search && climb && stationMove(snapshot) && trips < TRIP_LIMIT && underCover(getBlock, getPosition())) {
      trips++
      reason = '作業台・かまどへ歩いて行けないため、真上へ掘って地上へ出ます。'
      log(`プレイヤーモード: ${reason}`)
      let out = null
      try { out = await climb(() => !live(token)) } catch (error) { log(`プレイヤーモード: 真上へ掘れません ${text(error?.message)}`) }
      if (!live(token) || held()) return false
      if (out?.ok) return restart(token, { ...agent.objective })
    }
    // The work the plan asked for lies far overhead (real Realm 2026-11-16
    // 11:12-11:22 JST: at y -7 with no coal and no wood, the plan tunnelled
    // toward coal ore 58 blocks up; a tunnel cannot climb that, so the run
    // stopped three times on the search limit without moving): straight up.
    const over = !search && climb && trips < TRIP_LIMIT ? overhead(snapshot, getPosition()) : 0
    if (over && underCover(getBlock, getPosition())) {
      trips++
      reason = `次の作業の場所が ${over} 段上にあるため、真上へ掘って地上へ出ます。`
      log(`プレイヤーモード: ${reason}`)
      let out = null
      try { out = await climb(() => !live(token)) } catch (error) { log(`プレイヤーモード: 真上へ掘れません ${text(error?.message)}`) }
      if (!live(token) || held()) return false
      if (out?.ok) return restart(token, { ...agent.objective, freshExclusions: true })
    }
    // The work the plan asked for is far away (live 2026-11-15 23:00 JST: iron
    // ore 113 m off, "outside the bounded tunneling area", three stops in a
    // row): walk there first, then go on. Once there the distance is short, so
    // the same place is not walked to twice.
    // The food source cannot be walked to by the forage's own short steps
    // (real Realm 2026-11-16 10:02-10:34 JST: a cow 21 m away, every step
    // refused with 「Partial recenter lacks bounded known support」, twelve
    // stops in half an hour without moving): the long trip walks next to it.
    const food = !search && snapshot.lastDecision?.type === 'forage' && prey ? (() => { try { return prey() } catch { return null } })() : null
    const here = getPosition()
    if (food && here && [food.x, food.z].every(Number.isFinite) && Math.hypot(food.x - here.x, food.z - here.z) > 6 && trips < TRIP_LIMIT) {
      trips++
      await trip(token, snapshot, { x: Math.floor(food.x), z: Math.floor(food.z), label: '食料源' })
      if (!live(token) || held()) return false
      return restart(token, { ...agent.objective })
    }
    const far = farTarget(snapshot, getPosition())
    const shortAt = far ? short.get(shortKey(far)) : undefined
    if (far && shortAt !== undefined && now() - shortAt < SHORT_MS) log(`プレイヤーモード: 次の作業の場所 (${far.x}, ${far.z}) へは前の移動で着けなかったため、今回は移動しません`)
    else if (!search && far && trips < TRIP_LIMIT) {
      trips++
      await trip(token, snapshot, far)
      if (!live(token) || held()) return false
      const after = getPosition()
      if (after && Math.hypot(far.x + 0.5 - after.x, far.z + 0.5 - after.z) > 24) { short.set(shortKey(far), now()); if (short.size > 64) short.delete(short.keys().next().value) }
      return restart(token, { ...agent.objective })
    }
    if (search) {
      // The search for wood only rests between sets of walks.
      reason = `${why} ${Math.round(PAUSES_MS[0] / 1000)}秒後にやり直します。`
      log(`プレイヤーモード: ${Math.round(PAUSES_MS[0] / 1000)}秒後にやり直します`)
      trips = 0; visited = []
      if (!await wait(token, PAUSES_MS[0])) return false
      return restart(token, { ...agent.objective, freshExploration: true })
    }
    // No answer above fits. The same stop is not answered the same way twice
    // (player-repeat.js): at once, then from another place, then from far away.
    const again = repeat.note(snapshot, getPosition())
    const full = snapshot.stopCode === 'exclusion_limit'
    if (again.step === 'again') {
      // The list of unreachable candidates filled up (live 2026-11-15 22:01
      // JST): an empty list; what is still out of reach is excluded again.
      reason = full ? `${why} 除外した候補を忘れて、すぐにやり直します。` : `${why} すぐにやり直します。`
      log(full ? 'プレイヤーモード: 除外した候補を忘れて、すぐにやり直します' : 'プレイヤーモード: すぐにやり直します')
      return restart(token, { ...agent.objective, ...(full ? { freshExclusions: true } : {}) })
    }
    const position = getPosition()
    if (again.step === 'near' && position) {
      const under = climb && underCover(getBlock, position)
      reason = under ? '同じ場所で同じ理由で止まったため、真上へ掘って地上へ出てから続けます。' : '同じ場所で同じ理由で止まったため、別の場所へ移ってから続けます。'
      log(`プレイヤーモード: ${reason}`)
      let out = null
      if (under) { try { out = await climb(() => !live(token)) } catch (error) { log(`プレイヤーモード: 真上へ掘れません ${text(error?.message)}`) } }
      if (!out?.ok && live(token) && !held()) await trip(token, snapshot, { ...elsewhere(position, snapshot.lastDecision, 32, turns++ * Math.PI / 2), label: '別の場所' })
      if (!live(token) || held()) return false
      return restart(token, { ...agent.objective, freshExclusions: true, freshExploration: true })
    }
    if (position) {
      if (again.count >= SPIN_AFTER) {
        reason = `${why} 遠くへ移っても同じ理由で止まるため、30秒後に続けます。`
        log('プレイヤーモード: 遠くへ移っても同じ理由で止まるため、30秒後に続けます')
        if (!await wait(token, PAUSES_MS[2])) return false
      }
      heading = (heading ?? 0) + Math.PI / 3
      reason = '別の場所でも同じ理由で止まったため、遠くへ移動してから続けます。'
      log(`プレイヤーモード: ${reason}`)
      await trip(token, snapshot, { ...aheadPoint(position, heading), label: '遠くの場所' })
      if (!live(token) || held()) return false
    }
    return restart(token, { ...agent.objective, freshExclusions: true, freshExploration: true })
  }

  // Called with every autonomy progress snapshot.
  function onProgress (snapshot) {
    if (run || !snapshot || normalizeMode(getMode()) !== 'player' || shared.autoWanted !== true) return false
    // Running: only the search for wood is taken over. Stopped: blocked and
    // failed runs, and runs the planner itself ended with a stop decision: the
    // runtime restarts those at once with the same exhausted counts (live
    // 2026-11-17 16:01-16:16 JST: 「拠点候補を探す回数の上限に達したため停止します。」
    // every 0.5 s for fifteen minutes, nothing logged, the Bot never moved).
    const planned = snapshot.phase === 'stopped' && snapshot.lastDecision?.type === 'stop'
    if (snapshot.running ? !seeksWood(snapshot) : !(['blocked', 'failed'].includes(snapshot.phase) || planned)) return false
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
    run = null; reason = null; trips = 0; heading = null; visited = []; repeat.reset(); turns = 0
    shared.playerRecovering = false
    if (active && travel.status()?.busy) void Promise.resolve().then(() => travel.cancel()).catch(() => {})
    return active
  }

  return { onProgress, keepPlaying, cancel, status: () => ({ active: run !== null, reason }) }
}

module.exports = { createPlayerRecovery, nearestKnownLog, aheadPoint, farTarget, overhead, TRIP_LIMIT }
