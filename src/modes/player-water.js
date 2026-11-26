'use strict'

// Player mode: out of the water onto the nearest received ledge, reporting
// structured `return-result` outcomes and bounded failure memory.
const { normalizeMode } = require('./bot-mode')
const { ledges, wetColumn } = require('../movement/water-ledges')
const { way } = require('../movement/water-swim')
const { createSupplyOutcomeTracker } = require('./supply-task-runner')

const STUCK_MS = 15000, AGAIN_MS = 30000, MOVED_M = 1, TRIES = 8, LEGS = 12, SAY_MS = 60000
const finite = p => !!p && [p.x, p.y, p.z].every(Number.isFinite)
const wet = (getBlock, feet) => finite(feet) && wetColumn(getBlock, feet) !== null

function createPlayerWater ({ getMode, shared, agent, getPosition, getBlock, start, moving, scope = () => null, why = () => null, blocked = () => false, disposed = () => false, log = () => {}, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  let busy = false, waitUntil = 0, since = null, anchor = null, said = -Infinity
  const tracker = createSupplyOutcomeTracker({ taskId: 'water', shared, scope, now })
  const R = tracker.result
  const live = () => !disposed() && normalizeMode(getMode()) === 'player' && shared.playerWanted === true
  const settle = async () => { for (let i = 0; i < 40 && agent.settled?.() === false && !disposed(); i++) await sleep(200) }
  const restart = async () => { for (let attempt = 0; attempt < 5 && live(); attempt++) { try { await agent.start({ ...agent.objective }); return } catch { await sleep(2000) } } }

  async function runStep () {
    if (!live() || busy) return null
    const feet = getPosition()
    if (!wet(getBlock, feet)) { since = null; anchor = null; return null }
    if (!anchor || Math.hypot(feet.x - anchor.x, feet.z - anchor.z) > MOVED_M) { anchor = { x: feet.x, z: feet.z }; since = now(); return null }
    if (now() - since < STUCK_MS || now() < waitUntil || blocked()) return null
    const found = ledges(getBlock, feet)[0] ?? way(getBlock, feet)?.shore
    waitUntil = now() + AGAIN_MS
    const cellKey = `${Math.floor(feet.x / 4)},${Math.floor(feet.z / 4)}`
    if (!found) {
      none()
      const outcome = R.blocked('WATER_NO_SHORE', { kind: 'terrain_received' }, { detail: '上がれる岸が見つかりません' })
      tracker.record(outcome, { stage: 'scan', target: cellKey })
      return outcome
    }
    busy = true
    try {
      log(`プレイヤーモード: 水の中で止まっているため、岸 (${Math.floor(found.x)}, ${found.y}, ${Math.floor(found.z)}) へ上がります`)
      agent.stop('水から上がります。')
      await settle()
      const out = await exit(() => !live())
      const outcome = out.ok
        ? R.completed('WATER_EXITED', { evidence: { shore: found } })
        : out.reason === 'INTERRUPTED'
          ? R.interrupted('WATER_INTERRUPTED')
          : R.failed(out.reason === 'NO_LEDGE' ? 'WATER_NO_LEDGE' : 'WATER_EXIT_FAILED', { detail: out.reason ?? '不明' })
      tracker.record(outcome, { stage: 'exit', target: cellKey })
      return outcome
    } finally {
      busy = false
      await restart()
    }
  }

  async function tick () {
    const outcome = await runStep()
    if (outcome?.status === 'interrupted') return false
    return tracker.toTickBoolean(outcome)
  }

  function none () {
    if (now() - said < SAY_MS) return
    said = now()
    log('プレイヤーモード: 水の中で止まっていますが、受信した水面の先に上がれる岸が見つかりません')
  }

  async function swim (aborted) {
    let stalls = 0
    for (let leg = 0; leg < LEGS; leg++) {
      const feet = getPosition()
      if (!wet(getBlock, feet) || ledges(getBlock, feet).length) return { ok: true }
      const far = way(getBlock, feet)
      if (!far) { none(); return { ok: false, reason: 'NO_LEDGE' } }
      if (aborted() || disposed()) return { ok: false, reason: 'INTERRUPTED' }
      if (leg === 0) log(`プレイヤーモード: 岸 (${Math.floor(far.shore.x)}, ${far.shore.y}, ${Math.floor(far.shore.z)}) まで水面を約 ${far.cells} マス泳ぎます`)
      let refused = null
      try { start(far.leg, { allowWater: true, allowLowHealth: true, waterExit: true, maxDistance: 12 }) } catch (error) { refused = String(error?.message ?? error).slice(0, 80) }
      if (!refused) {
        await sleep(300)
        for (let i = 0; i < 75 && moving() && !disposed(); i++) await sleep(200)
      }
      const after = getPosition()
      if (Math.hypot(after.x - feet.x, after.z - feet.z) >= 1) { stalls = 0; continue }
      if (++stalls >= 2) {
        const reason = refused ?? why() ?? '泳いでも進みませんでした'
        log(`プレイヤーモード: 岸へ泳げません（${reason}）`)
        return { ok: false, reason }
      }
      await sleep(1000)
    }
    return { ok: false, reason: 'SWIM_LIMIT' }
  }

  async function exit (aborted = () => false) {
    const feet = getPosition()
    if (!wet(getBlock, feet)) return { ok: false, reason: 'NOT_IN_WATER' }
    let found = ledges(getBlock, feet).slice(0, TRIES)
    if (!found.length) {
      const swum = await swim(aborted)
      if (!swum.ok) return swum
      if (!wet(getBlock, getPosition())) { log('プレイヤーモード: 水から上がりました'); since = null; anchor = null; return { ok: true } }
      found = ledges(getBlock, getPosition()).slice(0, TRIES)
      if (!found.length) { none(); return { ok: false, reason: 'NO_LEDGE' } }
    }
    const reasons = []
    for (const ledge of found) {
      if (aborted() || disposed()) return { ok: false, reason: 'INTERRUPTED' }
      try { start(ledge, { allowWater: true, allowLowHealth: true, waterExit: true, maxDistance: 4 }) } catch (error) { reasons.push(String(error?.message ?? error).slice(0, 80)); continue }
      await sleep(300)
      for (let i = 0; i < 50 && moving() && !disposed(); i++) await sleep(200)
      if (!wet(getBlock, getPosition())) { log('プレイヤーモード: 水から上がりました'); since = null; anchor = null; return { ok: true } }
      reasons.push(why() ?? '上がれませんでした')
    }
    const reason = [...new Set(reasons)].slice(0, 2).join(' / ') || '不明'
    log(`プレイヤーモード: 水から上がれません（${reason}）`)
    return { ok: false, reason }
  }

  return {
    tick,
    runStep,
    exit,
    needed: () => wet(getBlock, getPosition()),
    status: () => ({ active: busy, reason: busy ? '水から上がっています。' : null, lastOutcome: tracker.last() })
  }
}

module.exports = { createPlayerWater, wet, ledges }
