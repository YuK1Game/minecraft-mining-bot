'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createKeepAlive } = require('../scripts/keep-alive')

function fixture (options = {}) {
  let time = 0; let nextTimer = 0
  const timers = new Map()
  const children = []; const spawns = []; const states = []; const terminal = []
  const signals = new EventEmitter()
  const spawn = (execPath, args, settings) => {
    const child = new EventEmitter()
    child.pid = 100 + children.length
    child.kills = []
    child.unrefs = 0
    child.kill = signal => { child.kills.push(signal); return true }
    child.unref = () => { child.unrefs++ }
    child.finish = (code, signal = null) => { child.emit('exit', code, signal); child.emit('close', code, signal) }
    spawns.push({ execPath, args: [...args], settings: { ...settings } }); children.push(child)
    return child
  }
  const setTimer = (callback, delay) => { const id = ++nextTimer; timers.set(id, { at: time + delay, callback }); return id }
  const clearTimer = id => timers.delete(id)
  const supervisor = createKeepAlive({ spawn, execPath: 'C:\\Node\\node.exe', cwd: 'G:\\Projects\\MinecraftBot', signals, now: () => time, setTimer, clearTimer, onState: value => states.push(value), onStop: value => terminal.push(value), ...options })
  function advance (ms) {
    const end = time + ms
    let processed = 0
    while (true) {
      const pending = [...timers].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      if (!pending) break
      if (++processed > 1000) throw new Error('Fake timer loop exceeded its bound')
      time = pending[1].at; timers.delete(pending[0]); pending[1].callback()
    }
    time = end
  }
  return { supervisor, signals, children, spawns, states, terminal, advance, timers }
}

test('import and construction are passive and start launches exactly one inherited-stdio Node worker', async () => {
  const f = fixture()
  assert.equal(f.spawns.length, 0)
  assert.equal(f.timers.size, 0)
  assert.equal(f.signals.listenerCount('SIGINT'), 0)
  const first = f.supervisor.start()
  f.supervisor.start(); f.supervisor.start()
  assert.equal(f.spawns.length, 1)
  assert.equal(first.phase, 'running')
  assert.deepEqual(f.spawns[0].args, ['--env-file-if-exists=.env', 'src/main.js', '--auto'])
  assert.equal(f.spawns[0].settings.stdio, 'inherit')
  assert.equal(f.spawns[0].settings.windowsHide, true)
  assert.equal(Object.hasOwn(f.spawns[0].settings, 'shell'), false)
  assert.equal(Object.hasOwn(f.spawns[0].settings, 'env'), false)
  assert.equal(f.children[0].listenerCount('data'), 0, 'no child output is inspected')
  f.children[0].finish(0)
  assert.equal((await f.supervisor.done).reason, 'child_exit_zero')
  assert.equal(f.signals.eventNames().length, 0)
})

test('nonzero exits use 2-60 second exponential delays and cannot overlap a child awaiting close', async () => {
  const f = fixture({ maxRestarts: 20 })
  f.supervisor.start()
  f.children[0].emit('exit', 1, null)
  f.advance(60000)
  f.supervisor.start()
  assert.equal(f.spawns.length, 1, 'the close event must finish before a restart is scheduled')
  f.children[0].emit('close', 1, null)
  const delays = []
  for (let retry = 0; retry < 7; retry++) {
    const delay = f.supervisor.snapshot().nextDelayMs
    delays.push(delay)
    f.advance(delay - 1)
    assert.equal(f.spawns.length, retry + 1)
    f.advance(1)
    assert.equal(f.spawns.length, retry + 2)
    assert.equal(f.children[retry].listenerCount('exit'), 0)
    assert.equal(f.children[retry].listenerCount('close'), 0)
    f.children.at(-1).finish(1)
  }
  assert.deepEqual(delays, [2000, 4000, 8000, 16000, 32000, 60000, 60000])
  await f.supervisor.stop()
  assert.equal(f.timers.size, 0)
})

test('the default ten-minute limit permits five restarts after the initial launch and then stops', async () => {
  const f = fixture()
  f.supervisor.start()
  for (let retry = 0; retry < 5; retry++) { f.children.at(-1).finish(1); f.advance(f.supervisor.snapshot().nextDelayMs) }
  assert.equal(f.spawns.length, 6)
  f.children.at(-1).finish(1)
  const result = await f.supervisor.done
  assert.equal(result.phase, 'failed')
  assert.equal(result.reason, 'restart_limit')
  assert.equal(result.exitCode, 1)
  assert.equal(result.restarts, 5)
  assert.equal(result.restartsInWindow, 5)
  assert.equal(f.timers.size, 0)
  assert.equal(f.terminal.length, 1)
  f.supervisor.start(); f.advance(600000)
  assert.equal(f.spawns.length, 6)
})

test('restart budgeting rolls over and a stable ten-minute worker resets its exponential failure streak', async () => {
  const f = fixture({ maxRestarts: 1 })
  f.supervisor.start()
  f.children.at(-1).finish(1); f.advance(2000)
  f.advance(600001)
  f.children.at(-1).finish(1)
  assert.equal(f.supervisor.snapshot().phase, 'backoff')
  assert.equal(f.supervisor.snapshot().restartsInWindow, 0)
  assert.equal(f.supervisor.snapshot().nextDelayMs, 2000)
  f.advance(2000)
  assert.equal(f.spawns.length, 3)
  f.children.at(-1).finish(0)
  assert.equal((await f.supervisor.done).exitCode, 0)
})

test('exit zero, explicit owner stop and child signal termination never restart', async () => {
  for (const signal of [null, 'SIGINT', 'SIGTERM', 'SIGKILL']) {
    const f = fixture(); f.supervisor.start()
    f.children[0].finish(signal ? null : 0, signal)
    const result = await f.supervisor.done
    assert.equal(result.reason, signal ? 'child_signal' : 'child_exit_zero')
    f.advance(600000)
    assert.equal(f.spawns.length, 1)
  }
  const f = fixture(); f.supervisor.start()
  const stopped = f.supervisor.stop()
  assert.deepEqual(f.children[0].kills, ['SIGTERM'])
  f.children[0].finish(0)
  assert.equal((await stopped).exitCode, 0)
  assert.equal(f.timers.size, 0)
})

test('SIGINT and SIGTERM forward once, wait for close and cannot turn a stopping child into a retry', async () => {
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    const f = fixture(); f.supervisor.start()
    f.signals.emit(signal); f.signals.emit(signal)
    assert.deepEqual(f.children[0].kills, [signal])
    assert.equal(f.supervisor.snapshot().phase, 'stopping')
    f.children[0].emit('exit', 1, null)
    assert.equal(f.terminal.length, 0)
    f.children[0].emit('close', 1, null)
    const result = await f.supervisor.done
    assert.equal(result.exitCode, code)
    assert.equal(f.timers.size, 0)
    assert.equal(f.signals.eventNames().length, 0)
    f.advance(600000)
    assert.equal(f.spawns.length, 1)
  }
})

test('signals cancel backoff immediately and delayed shutdown cleanup escalates without launching another worker', async () => {
  const waiting = fixture(); waiting.supervisor.start(); waiting.children[0].finish(1)
  waiting.signals.emit('SIGTERM')
  assert.equal((await waiting.supervisor.done).exitCode, 143)
  waiting.advance(600000)
  assert.equal(waiting.spawns.length, 1)
  const stuck = fixture(); stuck.supervisor.start()
  const finished = stuck.supervisor.stop('SIGINT')
  stuck.advance(4999)
  assert.deepEqual(stuck.children[0].kills, ['SIGINT'])
  stuck.advance(1)
  assert.deepEqual(stuck.children[0].kills, ['SIGINT', 'SIGKILL'])
  assert.equal(stuck.terminal.length, 0)
  stuck.advance(1000)
  assert.equal((await finished).reason, 'forced_shutdown')
  assert.equal(stuck.children[0].unrefs, 1)
  assert.equal(stuck.children[0].listenerCount('exit'), 0)
  stuck.supervisor.start(); stuck.advance(600000)
  assert.equal(stuck.spawns.length, 1)
  assert.equal(stuck.timers.size, 0)
})

test('spawn exceptions and child error events stop without interpreting output or inventing a nonzero exit retry', async () => {
  const thrown = fixture({ spawn: () => { throw new Error('spawn failed') } })
  thrown.supervisor.start()
  assert.equal((await thrown.supervisor.done).reason, 'spawn_error')
  assert.equal(thrown.supervisor.snapshot().exitCode, 1)
  assert.equal(thrown.timers.size, 0)
  const f = fixture(); f.supervisor.start()
  f.children[0].emit('error', new Error('spawn event failed'))
  assert.equal(f.supervisor.snapshot().phase, 'stopping')
  f.children[0].emit('close', null, null)
  assert.equal((await f.supervisor.done).exitCode, 1)
  f.advance(600000)
  assert.equal(f.spawns.length, 1)
})

test('synchronous close during signal forwarding or escalation cannot leave a cleanup timer or relaunch', async () => {
  for (const closeOn of ['SIGTERM', 'SIGKILL']) {
    const f = fixture(); f.supervisor.start()
    const child = f.children[0]
    child.kill = signal => { child.kills.push(signal); if (signal === closeOn) child.finish(null, signal); return true }
    const stopped = f.supervisor.stop()
    if (closeOn === 'SIGKILL') f.advance(5000)
    assert.equal((await stopped).exitCode, 0)
    assert.equal(f.timers.size, 0)
    f.supervisor.start(); f.advance(600000)
    assert.equal(f.spawns.length, 1)
  }
  const beforeStart = fixture()
  assert.equal((await beforeStart.supervisor.stop()).exitCode, 0)
  beforeStart.supervisor.start()
  assert.equal(beforeStart.spawns.length, 0)
  assert.equal(beforeStart.signals.eventNames().length, 0)
})
