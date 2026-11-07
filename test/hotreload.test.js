'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')
const { createHotReloader } = require('../src/hotreload')

function workspace (t) {
  // Match the canonical paths used by the reloader (Windows may return an 8.3 TEMP alias).
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'minecraftbot-hotreload-')))
  const created = new Set()
  const managers = []
  const context = { client: { identity: 'stable-client', connected: true }, events: [] }
  const errors = []
  function write (name, source) {
    const file = path.resolve(directory, name)
    assert.equal(path.dirname(file), directory, 'test fixtures must remain flat inside their own explicit directory')
    created.add(file)
    fs.writeFileSync(file, source)
    return file
  }
  const helper = write('helper.js', 'exports.value = 1\n')
  const stable = write('stable.js', 'exports.marker = "unchanged"\n')
  const entry = write('runtime.js', `const helper = require('./helper'); const stable = require('./stable');
exports.createRuntime = context => ({ value: helper.value, stable, client: context.client, dispose(reason) { context.events.push('dispose:' + helper.value + ':' + reason) } })\n`)
  function create (options = {}) {
    const manager = createHotReloader({ entry, watchFiles: [entry, helper], createContext: () => context, onSwap: next => context.events.push(`swap:${next.value}`), onError: error => errors.push(error.message), autoDiscover: false, ...options })
    managers.push(manager)
    return manager
  }
  t.after(async () => {
    for (const manager of managers) manager.stop()
    await delay(5)
    // Delete only the exact flat files created above; no recursive or computed
    // cross-shell deletion is used on Windows.
    for (const file of created) {
      assert.equal(path.dirname(file), directory)
      delete require.cache[file]
      try { fs.unlinkSync(file) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    fs.rmdirSync(directory)
  })
  return { directory, entry, helper, stable, context, errors, write, create }
}

test('valid reload swaps behavior while preserving the same client and unlisted dependency cache', async t => {
  const f = workspace(t)
  const manager = f.create()
  await manager.loadInitial()
  const old = manager.current
  const cachedStable = require.cache[f.stable]
  assert.equal(old.value, 1)
  f.write('helper.js', 'exports.value = 2\n')
  f.write('stable.js', 'exports.marker = "new disk content must not reload"\n')
  const status = await manager.reload({ reason: 'test_save' })
  assert.equal(status.generation, 2)
  assert.equal(manager.current.value, 2)
  assert.strictEqual(manager.current.client, old.client)
  assert.strictEqual(manager.current.client, f.context.client)
  assert.strictEqual(require.cache[f.stable], cachedStable)
  assert.strictEqual(manager.current.stable, old.stable)
  assert.deepEqual(f.context.events, ['swap:1', 'dispose:1:hot_reload', 'swap:2'])
})

test('syntax errors in any watched helper retain the old runtime without disposing it', async t => {
  const f = workspace(t)
  const manager = f.create()
  await manager.loadInitial()
  const previous = manager.current
  const cache = require.cache[f.entry]
  f.write('helper.js', 'exports.value = (\n')
  await assert.rejects(manager.reload(), /構文確認/)
  assert.strictEqual(manager.current, previous)
  assert.strictEqual(require.cache[f.entry], cache)
  assert.equal(manager.snapshot().generation, 1)
  assert.deepEqual(f.context.events, ['swap:1'])
  assert.equal(f.errors.length, 1)
})

test('factory exceptions restore only target cache and never dispose the previous behavior', async t => {
  const f = workspace(t)
  const manager = f.create()
  await manager.loadInitial()
  const previous = manager.current
  const cache = require.cache[f.entry]
  f.write('runtime.js', 'exports.createRuntime = () => { throw new Error("factory failed") }\n')
  await assert.rejects(manager.reload(), /factory failed/)
  assert.strictEqual(manager.current, previous)
  assert.strictEqual(require.cache[f.entry], cache)
  assert.equal(f.context.client.connected, true)
  assert.deepEqual(f.context.events, ['swap:1'])
})

test('unsafe operations defer reload and concurrent requests share the same promise', async t => {
  const f = workspace(t)
  let safe = true
  const manager = f.create({ canReload: () => safe, pollMs: 10, maxWaitMs: 500 })
  await manager.loadInitial()
  f.write('helper.js', 'exports.value = 2\n')
  safe = false
  const pending = manager.reload()
  assert.strictEqual(manager.reload(), pending)
  await delay(25)
  assert.equal(manager.snapshot().pending, true)
  assert.equal(manager.current.value, 1)
  assert.deepEqual(f.context.events, ['swap:1'])
  safe = true
  await pending
  assert.equal(manager.current.value, 2)
})

test('busy timeout and explicit watcher stop leave the existing client/runtime intact', async t => {
  const f = workspace(t)
  let safe = true
  const manager = f.create({ canReload: () => safe, maxWaitMs: 45, pollMs: 5 })
  await manager.loadInitial()
  const previous = manager.current
  safe = false
  await assert.rejects(manager.reload(), /制限時間|終了しない/)
  assert.strictEqual(manager.current, previous)
  const pending = manager.reload()
  manager.stop()
  await assert.rejects(pending, /停止/)
  assert.strictEqual(manager.current, previous)
  assert.equal(manager.snapshot().watching, false)
  assert.equal(f.context.client.connected, true)
  assert.deepEqual(f.context.events, ['swap:1'])
})

test('activation failures can rebuild the previous passive factory using an async stable context', async t => {
  const f = workspace(t)
  const manager = f.create({ createContext: async () => f.context, onSwap: next => {
    if (next.value === 2) throw new Error('activation failed')
    f.context.events.push(`swap:${next.value}`)
  } })
  await manager.loadInitial()
  f.write('helper.js', 'exports.value = 2\n')
  await assert.rejects(manager.reload(), /activation failed/)
  assert.equal(manager.current.value, 1)
  assert.strictEqual(manager.current.client, f.context.client)
  assert.equal(manager.snapshot().generation, 1)
  assert.equal(manager.snapshot().recoveryFailed, false)
})

test('directory watchers debounce saves, survive atomic replacements, and stop without disposing current', async t => {
  const f = workspace(t)
  const manager = f.create({ debounceMs: 35 })
  await manager.loadInitial()
  manager.watch()
  f.write('helper.js', 'exports.value = 2\n')
  f.write('helper.js', 'exports.value = 3\n')
  const until = async predicate => {
    const deadline = Date.now() + 2000
    while (!predicate()) {
      if (Date.now() > deadline) assert.fail('watcher did not reload in time')
      await delay(15)
    }
  }
  await until(() => manager.current.value === 3)
  assert.equal(manager.snapshot().generation, 2)
  const replacement = f.write('replacement.js', 'exports.value = 4\n')
  fs.renameSync(replacement, f.helper)
  await until(() => manager.current.value === 4)
  assert.equal(manager.snapshot().generation, 3)
  manager.stop()
  const current = manager.current
  const events = [...f.context.events]
  f.write('helper.js', 'exports.value = 5\n')
  await delay(80)
  assert.strictEqual(manager.current, current)
  assert.deepEqual(f.context.events, events)
  assert.equal(f.context.client.connected, true)
})

test('relative paths, host/auth/cache files, directories and non-CommonJS targets are rejected', t => {
  const f = workspace(t)
  const base = { entry: f.entry, createContext: () => f.context }
  assert.throws(() => createHotReloader({ ...base, watchFiles: ['relative.js'] }), /絶対/)
  assert.throws(() => createHotReloader({ ...base, entry: f.write('host.js', 'exports.x = 1') }), /接続ホスト/)
  assert.throws(() => createHotReloader({ ...base, watchFiles: [path.join(f.directory, '.auth', 'cache.js')] }), /認証/)
  assert.throws(() => createHotReloader({ ...base, watchFiles: [require.resolve('bedrock-protocol')] }), /外部依存/)
  assert.throws(() => createHotReloader({ ...base, watchFiles: [f.write('other.txt', 'text')] }), /CommonJS/)
})

test('new required behavior modules are discovered and refreshed while stable world cache stays intact', async t => {
  const f = workspace(t)
  const world = f.write('world.js', 'exports.identity = { stable: true }\n')
  const firstWorld = require(world)
  const extra = f.write('extra.js', 'exports.value = 10\n')
  require(extra) // Simulate a helper that the old host had cached previously.
  f.write('extra.js', 'exports.value = 20\n')
  f.write('runtime.js', `const helper = require('./helper'); const world = require('./world');
exports.createRuntime = context => ({ value: helper.value, world, client: context.client, dispose() {} })\n`)
  const manager = f.create({ autoDiscover: true, watchFiles: [f.entry] })
  await manager.loadInitial()
  assert.ok(manager.snapshot().watchFiles.includes(f.helper))
  assert.ok(!manager.snapshot().watchFiles.includes(world))
  f.write('runtime.js', `const helper = require('./helper'); const extra = require('./extra'); const world = require('./world');
exports.createRuntime = context => ({ value: helper.value + extra.value, world, client: context.client, dispose() {} })\n`)
  await manager.reload()
  assert.equal(manager.current.value, 21)
  assert.ok(manager.snapshot().watchFiles.includes(extra))
  assert.strictEqual(manager.current.world, firstWorld)
  f.write('extra.js', 'exports.value = 30\n')
  await manager.reload()
  assert.equal(manager.current.value, 31)
  assert.strictEqual(manager.current.client, f.context.client)
})

test('explicit addWatchFile validates and includes additional source files without reconnecting', async t => {
  const f = workspace(t)
  const manager = f.create()
  await manager.loadInitial()
  const extra = f.write('additional.js', 'exports.value = 3\n')
  manager.addWatchFile(extra)
  assert.ok(manager.snapshot().watchFiles.includes(extra))
  assert.throws(() => manager.addWatchFile(f.write('lifecycle.js', 'exports.value = 1')), /接続ホスト/)
  assert.equal(manager.snapshot().generation, 1)
  assert.equal(f.context.client.connected, true)
})
