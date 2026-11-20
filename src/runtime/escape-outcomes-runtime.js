'use strict'

// Moved out of runtime.js by scripts/extract-runtime-block.js.
// `rt` exposes the bindings of that closure this code uses; each read or write
// of rt.<name> reads or writes the closure's own variable at that moment.
// Modules are loaded through rt.require, the require of runtime.js.

function createEscapeOutcomesRuntime (rt) {
  const { isSafetyInterruption } = rt.require('./runtime/safety-ownership')
  const ESCAPE_PAUSE_MS = 20000
  const escapeScope = () => {
    const state = rt.raw()
    return JSON.stringify([state.profile ?? null, state.realm?.id == null ? null : String(state.realm.id), state.dimension ?? null, state.connectionId ?? null, state.startedAt ?? null, state.runtimeEntityId == null ? null : String(state.runtimeEntityId), rt.host.shared.deathRespawn?.deathId ?? state.lifecycle?.deathId ?? null])
  }
  function currentHistory () {
    const scope = escapeScope(), previous = rt.host.shared.escapeStuck
    // Changing world, connection or life expires evidence; it is not a
    // successful escape. A same-life combat handoff keeps the existing streak.
    if (!previous || previous.scope !== scope) rt.host.shared.escapeStuck = { scope, fails: 0, until: 0, health: null }
    return rt.host.shared.escapeStuck
  }
  function escapePaused () {
    const stuck = currentHistory()
    if (Date.now() >= stuck.until) return false
    const s = rt.raw()
    if (!(s.health >= stuck.health) || rt.nearestHostileDistance() <= 4) { stuck.until = 0; stuck.fails = 0; return false }
    return true
  }
  function noteEscapeOutcome (failedNoRoute, startedScope) {
    const stuck = currentHistory()
    if (stuck.scope !== startedScope) return
    const hp = rt.raw().health
    if (!failedNoRoute) { stuck.fails = 0; return }
    if (stuck.fails === 0) stuck.health = hp
    stuck.fails++
    if (stuck.fails >= 3 && hp >= stuck.health) { stuck.until = Date.now() + ESCAPE_PAUSE_MS; stuck.fails = 0; rt.host.log(`待機保護の退避を一時停止: 経路なしが3回続き被弾なし（${ESCAPE_PAUSE_MS / 1000}秒）`) }
  }
  function logEscapePhase (context, task) {
    const started = Date.now(), nearest = rt.nearestHostileText(), startedScope = escapeScope()
    rt.host.log(`待機保護の退避開始: op=${context?.operationId ?? '?'} ${nearest}`)
    return Promise.resolve(task).then(result => {
      rt.host.log(`待機保護の退避終了: ${Date.now() - started}ms supported=${result?.supported} escaped=${result?.escaped ?? result?.ok ?? '?'} code=${result?.code ?? result?.reason ?? 'none'}`)
      try {
        if (!isSafetyInterruption(result)) {
          if (result?.escaped === true || result?.arrived === true && result?.partialEscape === true) noteEscapeOutcome(false, startedScope)
          else if (result?.supported === false && /no_known/.test(String(result?.code ?? result?.reason ?? '')) || result?.supported === true && result?.escaped === false) noteEscapeOutcome(true, startedScope)
        }
      } catch {}
      return result
    }, error => {
      const cancelled = isSafetyInterruption(error)
      rt.host.log(`待機保護の退避${cancelled ? '引継ぎ・中断' : '終了'}: ${Date.now() - started}ms ${cancelled ? 'code' : 'error'}=${error?.code ?? error?.message ?? error}`)
      // Interrupted or unclassified work says nothing about route progress.
      // Only an actual escape/progress result clears a no-route streak.
      try { currentHistory(); if (!cancelled && /deadline|stalled/.test(String(error?.message ?? ''))) noteEscapeOutcome(true, startedScope) } catch {}
      throw error
    })
  }
  return {
    escapePaused,
    logEscapePhase
  }
}

module.exports = { createEscapeOutcomesRuntime }
