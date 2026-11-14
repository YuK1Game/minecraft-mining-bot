'use strict'

// Long-distance travel, stage 1 (2026-11-14 user request: walk from spawn to a
// far quarry; "0,0 から 2000,2000 まで" without commands). The existing chunk
// travel (received terrain, verified walking, server position witness, 48 m)
// is repeated as legs toward a far destination over land:
// - each leg aims at the chunk about LEG_M ahead (then turned left/right by
//   growing angles when that leg cannot be walked: cliffs, water, unreceived);
// - the terrain of that chunk is requested and only received terrain is used
//   (the chunk travel itself refuses unknown footing);
// - arrival of every leg is the chunk travel's own server-confirmed position;
// - progress is saved after each leg, so a restart continues from where the
//   bot actually is (the received position is always the truth);
// - combat, eating and respawn stay the existing ones; damage ends a leg and
//   the next one starts after a short pause.
// Nothing here moves the bot by command or marks terrain as received.

const copy = value => structuredClone(value)
const finite = p => p && ['x', 'z'].every(k => Number.isFinite(p[k]))
const feetOf = s => s?.position && Number.isFinite(s.position.x) ? { x: s.position.x, y: s.position.y - 1.62, z: s.position.z } : null
const horizontal = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
const fail = (code, message) => Object.assign(new Error(message ?? code), { code })

const LEG_M = 32
const ANGLES = [0, 25, -25, 50, -50, 75, -75, 100, -100]
const reasons = {
  LONG_TRAVEL_ARRIVED: '目的地に着きました',
  LONG_TRAVEL_BLOCKED: 'どの方向にも進めませんでした',
  LONG_TRAVEL_LEG_LIMIT: '区間数の上限に達しました',
  LONG_TRAVEL_NOT_ALIVE: '生存中の位置を確認できません',
  LONG_TRAVEL_CANCELLED: '移動を中断しました',
  LONG_TRAVEL_BUSY: 'ほかの移動の途中です',
  LONG_TRAVEL_NO_PROGRESS: '同じ場所から先へ進めていません'
}

function createLongTravel ({ getState, chunkTravel, requestTerrain = null, terrainRevision = null, findPoint = null, walkTo = null, inventoryReady = null, save = async () => {}, log = () => {}, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  legM = LEG_M, arriveM = 20, maxLegs = 600, maxFailuresInRow = 6, damagePauseMs = 3000, legWaitMs = 200000, pollMs = 250 } = {}) {
  if (typeof getState !== 'function' || typeof chunkTravel?.start !== 'function' || typeof chunkTravel?.status !== 'function') throw new TypeError('Long travel needs getState and chunk travel')
  let run = null, task = null
  const status = () => run ? copy({ busy: !!task, phase: run.phase, destination: run.destination, remaining: run.remaining, legs: run.legs, failures: run.failures, reason: run.reason, message: run.message, startedAt: run.startedAt, lastLegAt: run.lastLegAt })
    : { busy: false, phase: 'idle', destination: null, remaining: null, legs: 0, failures: 0, reason: null, message: null }
  const say = text => { run.message = text; try { log(`長距離移動: ${text}`) } catch {} }
  function chunkAhead (feet, destination, angleDeg, distanceM) {
    const heading = Math.atan2(destination.z - feet.z, destination.x - feet.x) + angleDeg * Math.PI / 180
    const d = Math.min(distanceM, horizontal(feet, destination))
    const p = { x: feet.x + Math.cos(heading) * d, z: feet.z + Math.sin(heading) * d }
    return { x1: Math.floor(p.x / 16), z1: Math.floor(p.z / 16) }
  }
  async function waitChunkTravel (signal) {
    const until = now() + legWaitMs
    for (;;) {
      if (signal.aborted) throw fail('LONG_TRAVEL_CANCELLED')
      const s = chunkTravel.status()
      if (!s.busy) return s
      if (now() > until) { try { await chunkTravel.cancel?.('LONG_TRAVEL_LEG_WAIT') } catch {} return { ...s, phase: 'failed', error: { code: 'LONG_TRAVEL_LEG_WAIT' } } }
      await sleep(pollMs)
    }
  }
  async function leg (area, signal) {
    if (typeof requestTerrain === 'function') { try { await requestTerrain(area, { signal }) } catch {} }
    // Live 2026-11-14 09:46: terrain arriving during route planning changed the
    // world revision and every plan aborted (NAVIGATION_CONTEXT_CHANGED). Wait
    // until the received terrain stops changing (bounded) before planning.
    if (typeof terrainRevision === 'function') {
      const until = now() + 6000
      let last = terrainRevision(), stableSince = now()
      while (now() < until && now() - stableSince < 800) { await sleep(150); if (signal.aborted) break; const r = terrainRevision(); if (r !== last) { last = r; stableSince = now() } }
    }
    try { await chunkTravel.start({ area }) } catch (error) { return { ok: false, code: error.code ?? 'CHUNK_TRAVEL_START_FAILED', message: String(error.message ?? error).slice(0, 160) } }
    const s = await waitChunkTravel(signal)
    if (s.phase === 'arrived' && s.serverConfirmed === true) return { ok: true }
    return { ok: false, code: s.error?.code ?? s.phase ?? 'CHUNK_TRAVEL_FAILED', message: s.error?.message ?? null }
  }
  async function loop (signal) {
    let stuckAt = null, stuckCount = 0, lastLife = null
    while (!signal.aborted) {
      const state = getState(), feet = feetOf(state)
      if (state?.phase !== 'spawned' || state.dead || !feet || !(state.health > 0)) { run.phase = 'waiting'; await sleep(1000); continue }
      // Deaths during one trip (decision 2026-11-14): five are continued after
      // the normal respawn; the sixth stops the trip with the reason.
      const life = state.lifecycle?.deathId ?? null
      if (lastLife !== null && life !== null && life !== lastLife) { run.deaths = (run.deaths ?? 0) + 1; say(`死亡しました（${run.deaths}回目）。リスポーンのあと続けます`); if (run.deaths > 5) throw fail('LONG_TRAVEL_DEATH_LIMIT', '死亡が5回を超えたため停止しました') }
      lastLife = life
      // After a respawn the armour/offhand arrive a little later; the empty-hand
      // judgement (and its exceptions) waits for the complete received inventory.
      if (typeof inventoryReady === 'function' && inventoryReady() !== true) { run.phase = 'waiting'; await sleep(500); continue }
      run.remaining = Math.round(horizontal(feet, run.destination))
      if (run.remaining <= arriveM) { run.phase = 'arrived'; run.reason = 'LONG_TRAVEL_ARRIVED'; say(`${reasons.LONG_TRAVEL_ARRIVED}（残り ${run.remaining}m・${run.legs}区間）`); await persist(); return }
      if (run.legs >= maxLegs) throw fail('LONG_TRAVEL_LEG_LIMIT')
      run.phase = 'moving'
      const tried = new Set()
      let moved = false, last = null
      // Rough terrain (live 2026-11-14 09:53: a ravine by the water) needs
      // shorter legs: each direction is tried at full and then half length.
      const tries = ANGLES.flatMap(angle => [[angle, legM], [angle, Math.max(12, Math.round(legM / 2))]])
      // Point legs first (live 2026-11-14 09:58: whole target chunks had no known
      // footing while nearer points toward the destination were walkable): the
      // runtime finds a walkable received point toward the destination and walks
      // there by the ordinary movement; arrival is the received position.
      if (typeof findPoint === 'function' && typeof walkTo === 'function') {
        let point = null
        try { point = await findPoint(feet, run.destination, { signal }) } catch {}
        if (!point) say("歩ける中継点が見つかりません"); else {
          const result = await walkTo(point, { signal })
          if (signal.aborted) throw fail('LONG_TRAVEL_CANCELLED')
          if (result?.ok) moved = true
          else { last = result ?? { ok: false, code: 'POINT_WALK_FAILED' }; say(`中継点 (${point.x},${point.y},${point.z}) へ歩けませんでした（${last.code}${last.message ? ': ' + last.message : ''}）`) }
        }
      }
      if (!moved && last?.code !== 'POINT_REPLAN') for (const [angle, length] of tries) {
        const area = chunkAhead(feet, run.destination, angle, length)
        const key = `${area.x1},${area.z1}`
        if (tried.has(key) || area.x1 === Math.floor(feet.x / 16) && area.z1 === Math.floor(feet.z / 16) && run.remaining > length) continue
        tried.add(key)
        const result = await leg(area, signal)
        if (signal.aborted) throw fail('LONG_TRAVEL_CANCELLED')
        if (result.ok) { moved = true; break }
        last = result
        if (result.code === 'CHUNK_TRAVEL_DAMAGED') { say(`被弾したため一時停止し、${damagePauseMs / 1000}秒後に続けます`); await sleep(damagePauseMs); break }
        if (result.code === 'CHUNK_TRAVEL_BUSY' || result.code === 'CHUNK_TRAVEL_CONTEXT_CHANGED') { await sleep(2000); break }
      }
      const after = feetOf(getState())
      // Damage, combat holding control or a changed connection is not a
      // blocked direction: wait and try again without counting it.
      // A server position correction mid-walk (water) only needs a new plan from
      // the corrected position (live 2026-11-14 10:35).
      const soft = !moved && ['CHUNK_TRAVEL_DAMAGED', 'CHUNK_TRAVEL_BUSY', 'CHUNK_TRAVEL_CONTEXT_CHANGED', 'POINT_REPLAN'].includes(last?.code)
      if (soft) { run.reason = last.code; continue }
      if (moved) {
        run.legs++; run.failures = 0; run.lastLegAt = new Date(now()).toISOString()
        run.remaining = after ? Math.round(horizontal(after, run.destination)) : run.remaining
        run.lastPosition = after ? { x: Math.round(after.x), y: Math.round(after.y), z: Math.round(after.z) } : null
        if (run.legs % 5 === 1) say(`進行中: 残り ${run.remaining}m・${run.legs}区間目`)
        await persist()
      } else {
        run.failures++
        run.reason = last?.code ?? null
        say(`区間を進めませんでした（${last?.code ?? '不明'}${last?.message ? `: ${String(last.message).slice(0, 80)}` : ''}）。${run.failures}回目`)
        if (run.failures >= maxFailuresInRow) throw fail('LONG_TRAVEL_BLOCKED', `${reasons.LONG_TRAVEL_BLOCKED}（最後の理由: ${last?.code ?? '不明'}）`)
        await sleep(1500)
      }
      // Progress guard: the received position must keep getting closer.
      const here = after ? Math.round(horizontal(after, run.destination) / 8) : null
      if (here != null && here === stuckAt) { if (++stuckCount >= 12) throw fail('LONG_TRAVEL_NO_PROGRESS') } else { stuckAt = here; stuckCount = 0 }
    }
    throw fail('LONG_TRAVEL_CANCELLED')
  }
  async function persist () { try { await save(copy({ destination: run.destination, legs: run.legs, remaining: run.remaining, lastPosition: run.lastPosition ?? null, phase: run.phase, reason: run.reason, startedAt: run.startedAt, savedAt: new Date(now()).toISOString() })) } catch {} }
  function start ({ destination, resume = null } = {}) {
    if (task) throw fail('LONG_TRAVEL_BUSY', reasons.LONG_TRAVEL_BUSY)
    if (!finite(destination)) throw fail('LONG_TRAVEL_DESTINATION_INVALID', '目的地の座標が不正です')
    const controller = new AbortController()
    run = { destination: { x: destination.x, y: Number.isFinite(destination.y) ? destination.y : null, z: destination.z }, legs: resume?.legs ?? 0, failures: 0, remaining: null, phase: 'starting', reason: null, message: null,
      startedAt: resume?.startedAt ?? new Date(now()).toISOString(), lastLegAt: null, controller }
    say(`出発: 目的地 (${Math.round(destination.x)}, ${Math.round(destination.z)})${resume ? `（${run.legs}区間目から再開）` : ''}`)
    task = loop(controller.signal).catch(async error => {
      run.phase = error.code === 'LONG_TRAVEL_CANCELLED' ? 'cancelled' : 'stopped'
      run.reason = error.code ?? 'LONG_TRAVEL_FAILED'
      say(`停止: ${error.message && error.message !== run.reason ? String(error.message).slice(0, 160) : reasons[run.reason] ?? String(error.message ?? error).slice(0, 120)}（残り ${run.remaining ?? '?'}m・${run.legs}区間）`)
      await persist()
    }).finally(() => { task = null })
    return status()
  }
  async function cancel (reason = 'LONG_TRAVEL_CANCELLED') {
    if (!run || !task) return status()
    run.controller.abort(fail('LONG_TRAVEL_CANCELLED'))
    try { await chunkTravel.cancel?.(reason) } catch {}
    try { await task } catch {}
    return status()
  }
  return { start, cancel, status, chunkAhead }
}

module.exports = { createLongTravel }
