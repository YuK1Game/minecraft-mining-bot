'use strict'

const { spawn: nodeSpawn } = require('node:child_process')
const path = require('node:path')

// Importing this file does not launch a client, read configuration/credentials,
// inspect child output, attach signal handlers or schedule a timer.
function createKeepAlive ({ autoStart = true, spawn = nodeSpawn, execPath = process.execPath, cwd = path.resolve(__dirname, '..'), signals = process, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, baseDelayMs = 2000, maxDelayMs = 60000, restartWindowMs = 600000, maxRestarts = 5, stopGraceMs = 5000, forceCloseMs = 1000, onState = () => {}, onStop = () => {} } = {}) {
  if (typeof autoStart !== 'boolean') throw new Error('autoStart must be a boolean')
  if ([spawn, now, setTimer, clearTimer, onState, onStop].some(value => typeof value !== 'function') || typeof execPath !== 'string' || !execPath || typeof cwd !== 'string' || !cwd || signals != null && (typeof signals.on !== 'function' || typeof signals.off !== 'function')) throw new Error('Invalid keep-alive dependencies')
  if (![baseDelayMs, maxDelayMs, restartWindowMs, stopGraceMs, forceCloseMs].every(value => Number.isFinite(value) && value > 0) || maxDelayMs < baseDelayMs || !Number.isInteger(maxRestarts) || maxRestarts < 0 || maxRestarts > 1000) throw new Error('Invalid keep-alive retry limits')
  let child = null
  let childHandlers = null
  let retryTimer = null
  let graceTimer = null
  let forceTimer = null
  let began = false
  let stopping = false
  let finished = false
  let attachedSignals = false
  let failureStreak = 0
  let restartTimes = []
  let requestedSignal = null
  let requestedExitCode = null
  let exitInfo = null
  let childStartedAt = null
  let childExited = false
  let resolveDone
  const done = new Promise(resolve => { resolveDone = resolve })
  let status = { phase: 'idle', starts: 0, restarts: 0, restartsInWindow: 0, childPid: null, nextDelayMs: null, nextRetryAt: null, lastExit: null, reason: null, exitCode: null }
  function time () { const value = now(); if (!Number.isFinite(value)) throw new Error('Invalid supervisor clock'); return value }
  function prune () { const cutoff = time() - restartWindowMs; restartTimes = restartTimes.filter(value => value > cutoff); status.restartsInWindow = restartTimes.length }
  function snapshot () { return structuredClone({ ...status, running: child !== null && !childExited, stopping, finished }) }
  function publish () { try { onState(snapshot()) } catch { /* Observers never control retries. */ } }
  function cancelTimers () {
    for (const timer of [retryTimer, graceTimer, forceTimer]) if (timer !== null) clearTimer(timer)
    retryTimer = graceTimer = forceTimer = null
    status.nextDelayMs = status.nextRetryAt = null
  }
  function detachSignals () {
    if (!attachedSignals) return
    signals.off('SIGINT', onSigint); signals.off('SIGTERM', onSigterm)
    attachedSignals = false
  }
  function detachChild () {
    if (child && childHandlers) for (const [event, handler] of Object.entries(childHandlers)) child.off(event, handler)
    childHandlers = null
  }
  function finish (reason, exitCode) {
    if (finished) return
    finished = true
    cancelTimers(); detachSignals()
    status.phase = exitCode === 0 || stopping ? 'stopped' : 'failed'
    status.reason = reason; status.exitCode = exitCode; status.childPid = null
    publish()
    const result = snapshot()
    try { onStop(result) } catch { /* Terminal state remains terminal. */ }
    resolveDone(result)
  }
  const signalCode = signal => signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1
  function shutdownCode () { return requestedExitCode ?? (requestedSignal ? signalCode(requestedSignal) : 0) }
  function kill (signal) {
    if (!child || childExited) return
    try { child.kill(signal) } catch { /* Close/error or bounded cleanup settles shutdown. */ }
  }
  function stop (signal = null, reason = 'stopped_by_owner', exitCode = null) {
    if (finished) return done
    if (!stopping) {
      stopping = true; requestedSignal = signal; requestedExitCode = exitCode
      if (retryTimer !== null) clearTimer(retryTimer)
      retryTimer = null; status.nextDelayMs = status.nextRetryAt = null
      status.phase = 'stopping'; status.reason = reason
      publish()
      if (!child) finish(reason, shutdownCode())
      else {
        kill(signal ?? 'SIGTERM')
        if (finished || !child) return done
        graceTimer = setTimer(() => {
          graceTimer = null
          if (!child) return
          kill('SIGKILL')
          if (finished || !child) return
          forceTimer = setTimer(() => {
            forceTimer = null
            if (!child) return
            // A stuck close event must not keep the wrapper alive forever.
            // This factory is terminal and can never launch a second child.
            const abandoned = child
            detachChild(); child = null
            abandoned.on('error', () => {})
            abandoned.unref?.()
            finish('forced_shutdown', shutdownCode())
          }, forceCloseMs)
        }, stopGraceMs)
      }
    }
    return done
  }
  function onSigint () { void stop('SIGINT', 'SIGINT') }
  function onSigterm () { void stop('SIGTERM', 'SIGTERM') }
  function scheduleRestart (code) {
    prune()
    if (restartTimes.length >= maxRestarts) { finish('restart_limit', code); return }
    const delay = Math.min(maxDelayMs, baseDelayMs * (2 ** Math.min(30, failureStreak - 1)))
    status.phase = 'backoff'; status.nextDelayMs = delay; status.nextRetryAt = time() + delay
    publish()
    retryTimer = setTimer(() => {
      retryTimer = null; status.nextDelayMs = status.nextRetryAt = null
      if (!stopping && !finished && !child) launch(true)
    }, delay)
  }
  function launch (restart) {
    if (child || stopping || finished) return
    if (restart) {
      prune()
      if (restartTimes.length >= maxRestarts) { finish('restart_limit', status.lastExit?.code ?? 1); return }
      restartTimes.push(time()); status.restarts++; status.restartsInWindow = restartTimes.length
    }
    status.starts++; status.phase = 'running'; status.reason = null
    exitInfo = null; childExited = false; childStartedAt = time()
    let next
    const args = ['--env-file-if-exists=.env', 'src/main.js']
    if (autoStart) args.push('--auto')
    try { next = spawn(execPath, args, { cwd, stdio: 'inherit', windowsHide: true }) } catch { finish('spawn_error', 1); return }
    if (!next || typeof next.on !== 'function' || typeof next.off !== 'function' || typeof next.kill !== 'function') { finish('invalid_spawn_result', 1); return }
    child = next; status.childPid = Number.isInteger(next.pid) ? next.pid : null
    const owned = next
    childHandlers = {
      exit: (code, signal) => {
        if (child !== owned || finished) return
        childExited = true
        exitInfo = { code: Number.isInteger(code) ? code : null, signal: signal ?? null }
        status.lastExit = { ...exitInfo }
        status.phase = stopping ? 'stopping' : 'awaiting_close'
        publish()
      },
      close: (code, signal) => {
        if (child !== owned || finished) return
        const result = exitInfo ?? { code: Number.isInteger(code) ? code : null, signal: signal ?? null }
        status.lastExit = { ...result }
        detachChild(); child = null; status.childPid = null; childExited = true
        if (stopping) { finish(status.reason ?? 'stopped_by_owner', shutdownCode()); return }
        if (result.signal) { finish('child_signal', signalCode(result.signal)); return }
        if (result.code === 0) { finish('child_exit_zero', 0); return }
        if (!Number.isInteger(result.code) || result.code <= 0) { finish('unknown_exit', 1); return }
        if (time() - childStartedAt >= restartWindowMs) failureStreak = 0
        failureStreak++
        scheduleRestart(result.code)
      },
      error: () => {
        if (child !== owned || finished) return
        // An error event is not a nonzero exit. Do not invent a retry result or
        // parse its message for authentication/transport details.
        void stop(null, 'spawn_error', 1)
      }
    }
    for (const [event, handler] of Object.entries(childHandlers)) child.on(event, handler)
    publish()
  }
  function start () {
    if (began || stopping || finished) return snapshot()
    began = true
    if (signals) { signals.on('SIGINT', onSigint); signals.on('SIGTERM', onSigterm); attachedSignals = true }
    launch(false)
    return snapshot()
  }
  return { start, stop, snapshot, done }
}

function main (args = process.argv.slice(2), createSupervisor = createKeepAlive) {
  const valid = args.every(arg => arg === '--connect-only' || arg === '--help') && args.filter(arg => arg === '--connect-only').length <= 1
  if (!valid || args.includes('--help')) {
    console.log('使い方: node scripts/keep-alive.js [--connect-only] [--help]\n既定は旧サバイバル自律も開始します。--connect-only は接続だけで起動します。異常終了時には同じモードで再接続します。')
    if (!valid) process.exitCode = 2
    return null
  }
  const supervisor = createSupervisor({
    autoStart: !args.includes('--connect-only'),
    onState: state => { if (state.phase === 'backoff') console.log(`Botが異常終了しました。${state.nextDelayMs / 1000}秒後に再接続します。`) },
    onStop: state => { process.exitCode = state.exitCode; if (state.reason === 'restart_limit') console.error('短時間の再接続が上限に達したため停止しました。') }
  })
  supervisor.start()
  return supervisor
}

if (require.main === module) main()

module.exports = { createKeepAlive, main }
