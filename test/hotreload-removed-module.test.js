'use strict'

// Live 2026-11-15: a behaviour module was deleted while the bot ran. The
// reloader kept it on its watch list, its syntax check threw ENOENT, and no
// later reload could load new code until the bot was restarted.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHotReloader } = require('../src/host/hotreload')

function workspace (t) {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'minecraftbot-hotreload-removed-')))
  const created = new Set(), events = [], errors = []
  const write = (name, source) => { const file = path.resolve(directory, name); created.add(file); fs.writeFileSync(file, source); return file }
  const remove = name => fs.unlinkSync(path.resolve(directory, name))
  const helper = write('helper.js', 'exports.value = 1\n')
  const extra = write('extra.js', 'exports.bonus = 10\n')
  const entrySource = withExtra => `const helper = require('./helper');${withExtra ? " const extra = require('./extra');" : ''}
exports.createRuntime = () => ({ value: helper.value + ${withExtra ? 'extra.bonus' : '0'}, dispose (reason) { events.push('dispose:' + reason) } })\n`.replace('events.push', 'globalThis.__hotreloadRemovedEvents.push')
  globalThis.__hotreloadRemovedEvents = events
  const entry = write('runtime.js', entrySource(true))
  const manager = createHotReloader({ entry, watchFiles: [entry, helper, extra], createContext: () => ({}), onSwap: next => events.push('swap:' + next.value), onError: error => errors.push(error), debounceMs: 20 })
  t.after(() => {
    manager.stop()
    delete globalThis.__hotreloadRemovedEvents
    for (const file of created) { delete require.cache[file]; try { fs.unlinkSync(file) } catch (error) { if (error.code !== 'ENOENT') throw error } }
    fs.rmdirSync(directory)
  })
  const names = () => manager.snapshot().watchFiles.map(file => path.basename(file)).sort()
  return { manager, events, errors, write, remove, entrySource, names, extra }
}

test('a module that was removed and is no longer required is dropped from the watch list and the reload goes through', async t => {
  const f = workspace(t)
  await f.manager.loadInitial()
  assert.equal(f.manager.current.value, 11)
  assert.deepEqual(f.names(), ['extra.js', 'helper.js', 'runtime.js'])
  f.write('runtime.js', f.entrySource(false))
  f.remove('extra.js')
  const status = await f.manager.reload({ reason: 'module_removed' })
  assert.equal(status.generation, 2)
  assert.equal(status.lastError, null)
  assert.equal(f.manager.current.value, 1)
  assert.deepEqual(f.names(), ['helper.js', 'runtime.js'])
  assert.equal(require.cache[f.extra], undefined)
  // Later reloads keep working.
  f.write('helper.js', 'exports.value = 5\n')
  assert.equal((await f.manager.reload({ reason: 'next_save' })).generation, 3)
  assert.equal(f.manager.current.value, 5)
  assert.deepEqual(f.events, ['swap:11', 'dispose:hot_reload', 'swap:1', 'dispose:hot_reload', 'swap:5'])
})

test('a removed module that is still required keeps the current runtime, and is watched again once it is back', async t => {
  const f = workspace(t)
  await f.manager.loadInitial()
  const before = f.manager.current
  f.remove('extra.js')
  await assert.rejects(f.manager.reload({ reason: 'module_missing' }), /extra/)
  assert.strictEqual(f.manager.current, before, 'the running behaviour is not replaced or disposed')
  assert.deepEqual(f.events, ['swap:11'])
  assert.equal(f.manager.snapshot().generation, 1)
  f.write('extra.js', 'exports.bonus = 20\n')
  const status = await f.manager.reload({ reason: 'module_back' })
  assert.equal(status.generation, 2)
  assert.equal(f.manager.current.value, 21)
  assert.deepEqual(f.names(), ['extra.js', 'helper.js', 'runtime.js'])
})

// Live 2026-11-15: modules required inside a function that runs on spawn were
// in the module cache but not watched; saving one changed nothing until some
// other watched file was saved.
test('a module first required after the last reload is reloaded when it is saved', async t => {
  const { setTimeout: delay } = require('node:timers/promises')
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'minecraftbot-hotreload-lazy-')))
  const created = new Set()
  const write = (name, source) => { const file = path.resolve(directory, name); created.add(file); fs.writeFileSync(file, source); return file }
  const late = write('late.js', 'exports.value = 1\n')
  const entry = write('runtime.js', "exports.createRuntime = () => ({ late: () => require('./late').value, dispose () {} })\n")
  const manager = createHotReloader({ entry, watchFiles: [entry], createContext: () => ({}), debounceMs: 20 })
  t.after(() => { manager.stop(); for (const file of created) { delete require.cache[file]; try { fs.unlinkSync(file) } catch {} } fs.rmdirSync(directory) })
  await manager.loadInitial()
  manager.watch()
  const names = () => manager.snapshot().watchFiles.map(file => path.basename(file)).sort()
  assert.deepEqual(names(), ['runtime.js'], 'nothing required it while the runtime was created')
  assert.equal(manager.current.late(), 1)
  // A file in the same folder that was never loaded does not start a reload.
  write('unrelated.js', 'exports.value = 0\n')
  await delay(150)
  assert.equal(manager.snapshot().generation, 1)
  write('late.js', 'exports.value = 2\n')
  for (let i = 0; i < 100 && manager.snapshot().generation < 2; i++) await delay(30)
  assert.equal(manager.snapshot().generation, 2, 'saving the lazily required module reloads the behaviour')
  assert.equal(manager.current.late(), 2)
  assert.deepEqual(names(), ['late.js', 'runtime.js'])
})

// Live 2026-11-20 02:09-02:11 JST: after a start, with no file saved, the behaviour was loaded again four times in
// two minutes. The first use of a lazily required module raises a directory event for its file (its access time);
// the file joined the watch list and that alone counted as a change.
function lazyWorld (t, prefix) {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  const created = new Set()
  const write = (name, source) => { const file = path.resolve(directory, name); created.add(file); fs.writeFileSync(file, source); return file }
  const late = write('late.js', 'exports.value = 1\n')
  const entry = write('runtime.js', "exports.createRuntime = () => ({ late: () => require('./late').value, dispose () {} })\n")
  const manager = createHotReloader({ entry, watchFiles: [entry], createContext: () => ({}), debounceMs: 20 })
  t.after(() => { manager.stop(); for (const file of created) { delete require.cache[file]; try { fs.unlinkSync(file) } catch {} } fs.rmdirSync(directory) })
  const names = () => manager.snapshot().watchFiles.map(file => path.basename(file)).sort()
  // The access time alone: content and modification time stay.
  const touch = () => fs.utimesSync(late, new Date(), fs.statSync(late).mtime)
  return { manager, write, late, names, touch }
}

test('an event without a save on a lazily required module does not load the behaviour again; a later save does', async t => {
  const { setTimeout: delay } = require('node:timers/promises')
  const { manager, write, names, touch } = lazyWorld(t, 'minecraftbot-hotreload-touch-')
  await delay(30)
  await manager.loadInitial()
  manager.watch()
  assert.equal(manager.current.late(), 1)
  const running = manager.current
  touch()
  for (let i = 0; i < 40 && names().length < 2; i++) await delay(30)
  await delay(150)
  assert.deepEqual(names(), ['late.js', 'runtime.js'], 'the module is watched from now on')
  assert.equal(manager.snapshot().generation, 1, 'nothing was saved')
  assert.equal(manager.current, running, 'the running behaviour was not replaced')
  assert.equal(manager.snapshot().lastIgnored?.reason, 'source_unchanged')
  // A second event of the same kind, now on a watched file.
  touch()
  await delay(150)
  assert.equal(manager.snapshot().generation, 1)
  write('late.js', 'exports.value = 2\n')
  for (let i = 0; i < 100 && manager.snapshot().generation < 2; i++) await delay(30)
  assert.equal(manager.snapshot().generation, 2, 'a save still loads the behaviour again')
  assert.equal(manager.current.late(), 2)
})

test('a lazily required module written after the last load is not taken as the running source', async t => {
  const { setTimeout: delay } = require('node:timers/promises')
  const { manager, write, names, touch } = lazyWorld(t, 'minecraftbot-hotreload-touch-late-')
  await manager.loadInitial()
  manager.watch()
  await delay(30)
  // Saved before anything required it: no reload, and the first use reads the new source.
  write('late.js', 'exports.value = 2\n')
  await delay(150)
  assert.equal(manager.snapshot().generation, 1)
  assert.equal(manager.current.late(), 2)
  // When it was written relative to its first use is not known here, so the event loads everything again.
  touch()
  for (let i = 0; i < 100 && manager.snapshot().generation < 2; i++) await delay(30)
  assert.equal(manager.snapshot().generation, 2)
  assert.deepEqual(names(), ['late.js', 'runtime.js'])
  assert.equal(manager.current.late(), 2)
})
