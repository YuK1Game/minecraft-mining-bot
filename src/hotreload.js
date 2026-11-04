'use strict'

const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const Module = require('node:module')
const crypto = require('node:crypto')

const STABLE_FILES = /^(?:host|stable[-_]?host|cli|auth|authentication|hotreload|api|world|entities|state|lifecycle|session[-_]?cache|config|realms)\.(?:js|cjs)$/i
const FORBIDDEN_DIRECTORIES = new Set(['node_modules', '.auth', 'auth', '.git', '.cache', 'cache', 'host'])
const keyOf = value => process.platform === 'win32' ? value.toLowerCase() : value
const errorText = error => String(error?.message ?? error).slice(0, 800)

function validateFile (file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('監視対象は絶対パスで指定してください。')
  const absolute = path.resolve(file)
  const forbidden = candidate => candidate.split(/[\\/]+/).some(part => FORBIDDEN_DIRECTORIES.has(part.toLowerCase())) || STABLE_FILES.test(path.basename(candidate))
  if (forbidden(absolute)) throw new Error('接続ホスト・認証・キャッシュ・外部依存は再読み込み対象にできません。')
  if (!/\.(?:js|cjs)$/i.test(absolute)) throw new Error('再読み込み対象はCommonJSの.js/.cjsファイルに限ります。')
  const resolved = fs.realpathSync.native(absolute)
  if (forbidden(resolved) || !/\.(?:js|cjs)$/i.test(resolved)) throw new Error('保護された場所を指すファイルは監視できません。')
  if (!fs.statSync(resolved).isFile()) throw new Error('監視対象は通常のソースファイルである必要があります。')
  return resolved
}

function createHotReloader ({ entry, watchFiles = [], createContext, onSwap = () => {}, onError = () => {}, canReload = () => true, debounceMs = 350, maxWaitMs = 15000, pollMs = 100, autoDiscover = true }) {
  if (typeof createContext !== 'function' || typeof onSwap !== 'function' || typeof onError !== 'function' || typeof canReload !== 'function') throw new Error('再読み込み用のコールバックが不正です。')
  if (!Array.isArray(watchFiles)) throw new Error('watchFilesはファイルパスの配列で指定してください。')
  for (const [name, value] of Object.entries({ debounceMs, maxWaitMs, pollMs })) {
    if (!Number.isFinite(value) || value <= 0 || value > 60000) throw new Error(`${name}の待ち時間が不正です。`)
  }
  entry = validateFile(entry)
  const files = [...new Map([entry, ...watchFiles.map(validateFile)].map(file => [keyOf(file), file])).values()]
  const watched = new Set(files.map(keyOf))
  const directories = [...new Set(files.map(file => path.dirname(file)))]
  const sourceRoot = path.dirname(entry)
  const watchedDirectories = new Set()
  const watchers = []
  let current = null
  let currentFactory = null
  let inFlight = null
  let controller = null
  let debounce = null
  let stopped = false
  let revision = 0
  let loadedSources = null
  let activeRequest = null
  const status = { generation: 0, phase: 'idle', pending: false, watching: false, lastReload: null, lastError: null, lastErrorAt: null, recoveryFailed: false }

  function snapshot () { return { ...status, lastReload: status.lastReload ? { ...status.lastReload } : null, entry, watchFiles: [...files], loaded: current !== null } }
  function sourceSnapshot () {
    return new Map(files.map(file => [keyOf(validateFile(file)), crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]))
  }
  function sameSources (a,b) { return !!a && !!b && a.size===b.size && [...a].every(([file,digest])=>b.get(file)===digest) }
  function sourcesUnchanged () { try { return current!==null && sameSources(loadedSources,sourceSnapshot()) } catch { return false } }
  function skipWatchReload (reason) {
    status.phase='ready';status.lastError=null;status.lastErrorAt=null;status.recoveryFailed=false
    status.lastIgnored={at:new Date().toISOString(),reason:'source_unchanged',trigger:String(reason).slice(0,200)}
    return snapshot()
  }
  function cancelled () { const error = new Error('再読み込みの監視は停止されました。'); error.name = 'AbortError'; return error }
  function report (error) {
    status.lastError = errorText(error)
    status.lastErrorAt = new Date().toISOString()
    try { onError(error, snapshot()) } catch { /* A reporting failure must not affect the stable connection. */ }
  }
  function guarded (work, signal, timeoutMs = maxWaitMs) {
    let timer
    let abort
    const cancellation = new Promise((resolve, reject) => {
      abort = () => reject(cancelled())
      if (signal.aborted) { abort(); return }
      signal.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => reject(new Error('再読み込み処理が制限時間内に完了しませんでした。')), timeoutMs)
    })
    return Promise.race([Promise.resolve().then(() => { if (signal.aborted) throw cancelled(); return work() }), cancellation]).finally(() => { clearTimeout(timer); signal.removeEventListener('abort', abort) })
  }
  async function safePoint (signal) {
    const deadline = Date.now() + maxWaitMs
    while (true) {
      if (signal.aborted || stopped) throw cancelled()
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error('処理中のクラフト・アイテム操作が終了しないため、再読み込みを見送りました。')
      if (await guarded(() => canReload(), signal, remaining) !== false) return
      status.phase = 'waiting_for_safe_point'
      await guarded(() => new Promise(resolve => setTimeout(resolve, Math.min(pollMs, remaining))), signal, remaining)
    }
  }
  function validateSyntax () {
    for (const file of files) {
      // Check again after an editor's atomic replace, before reading content.
      if (keyOf(validateFile(file)) !== keyOf(file)) throw new Error(`監視対象の実体が変更されました: ${file}`)
      const source = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').replace(/^#![^\r\n]*/, '')
      try { new vm.Script(Module.wrap(source), { filename: file, displayErrors: true }) } catch (error) {
        error.message = `構文確認に失敗しました (${path.basename(file)}): ${error.message}`
        throw error
      }
    }
  }
  function captureCache () {
    const originalModules = new Map(Object.entries(require.cache))
    const originalChildren = new Map([...originalModules.values()].map(parent => [parent, [...parent.children]]))
    const entries = new Map(files.map(file => [file, require.cache[file]]))
    const links = new Map()
    for (const parent of Object.values(require.cache)) {
      const children = parent.children.filter(child => watched.has(keyOf(child.filename)))
      if (children.length) links.set(parent, children)
    }
    return { entries, links, originalModules, originalChildren }
  }
  function registerFile (file, backup) {
    file = validateFile(file)
    if (watched.has(keyOf(file))) return false
    files.push(file)
    watched.add(keyOf(file))
    if (backup) {
      backup.entries.set(file, backup.originalModules.get(file))
      for (const [parent, children] of backup.originalChildren) {
        const matching = children.filter(child => keyOf(child.filename) === keyOf(file))
        if (matching.length) backup.links.set(parent, [...new Set([...(backup.links.get(parent) ?? []), ...matching])])
      }
    }
    const directory = path.dirname(file)
    if (!directories.includes(directory)) directories.push(directory)
    if (status.watching) watchDirectory(directory)
    return true
  }
  function discoverDependencies (backup) {
    if (!autoDiscover) return 0
    const visited = new Set()
    let added = 0
    function visit (loaded) {
      if (!loaded || visited.has(loaded)) return
      visited.add(loaded)
      const filename = loaded.filename
      if (!filename || !path.isAbsolute(filename)) return
      const relative = path.relative(sourceRoot, filename)
      if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) return
      if (filename.split(/[\\/]+/).some(part => FORBIDDEN_DIRECTORIES.has(part.toLowerCase()))) return
      if (/\.(?:js|cjs)$/i.test(filename) && !STABLE_FILES.test(path.basename(filename))) {
        if (registerFile(filename, backup)) added++
      }
      // Stable modules keep their own exports/cache, but may reference behavior
      // helpers under src that need to be discovered independently.
      for (const child of loaded.children) visit(child)
    }
    visit(require.cache[entry])
    return added
  }
  function clearTargetCache () {
    for (const file of files) delete require.cache[file]
    for (const parent of Object.values(require.cache)) parent.children = parent.children.filter(child => !watched.has(keyOf(child.filename)))
  }
  function restoreCache (backup) {
    clearTargetCache()
    for (const [file, value] of backup.entries) if (value) require.cache[file] = value
    for (const [parent, children] of backup.links) parent.children.push(...children.filter(child => !parent.children.includes(child)))
  }
  function validateRuntime (runtime) {
    if (!runtime || typeof runtime !== 'object' || typeof runtime.dispose !== 'function') throw new Error('createRuntimeはdispose(reason)を持つ受動的なruntimeを返す必要があります。')
    if (runtime === current) throw new Error('createRuntimeは既存runtimeではなく新しいruntimeを返してください。')
  }
  async function discard (runtime, reason) {
    if (!runtime || runtime === current || typeof runtime.dispose !== 'function') return
    try { await runtime.dispose(reason) } catch { /* The previous runtime and stable client remain owned by the host. */ }
  }

  async function performReload (reason, signal, request) {
    const startedAt = Date.now()
    let backup = null
    let next = null
    const previous = current
    const previousFactory = currentFactory
    let previousDisposed = false
    const maySkip=()=>request.fromWatch && !request.force
    const discardChanged=async()=>{await discard(next,'source_changed_during_reload');next=null;if(backup)restoreCache(backup)}
    try {
      // Source changes during passive construction are retried before the
      // active instance is touched. Continued churn retains it after4 tries.
      for(let attempt=0;attempt<4;attempt++) {
        await safePoint(signal)
        if(maySkip() && sourcesUnchanged())return skipWatchReload(reason)
        validateSyntax()
        status.phase = 'loading'
        backup ??= captureCache()
        let exported,candidateSources
        // Keep the existing bounded discovery/reconstruction contract.
        for (let pass = 0; pass < 32; pass++) {
          clearTargetCache()
          validateSyntax()
          candidateSources=sourceSnapshot()
          exported = require(entry)
          if (typeof exported?.createRuntime !== 'function') throw new Error('entryはmodule.exports.createRuntime(ctx)を公開する必要があります。')
          if (discoverDependencies(backup)) continue
          const context = await guarded(() => createContext(), signal)
          next = await guarded(() => exported.createRuntime(context), signal)
          validateRuntime(next)
          if (!discoverDependencies(backup)) break
          await discard(next, 'dependency_discovery')
          next = null
        }
        if (!next) throw new Error('動作モジュールの依存関係が安定しないため、再読み込みを中止しました。')
        const consistent=()=>sameSources(candidateSources,sourceSnapshot())
        if(!consistent()){await discardChanged();continue}
        await safePoint(signal)
        if(maySkip() && sourcesUnchanged()){await discardChanged();return skipWatchReload(reason)}
        if(!consistent()){await discardChanged();continue}
        if (stopped || signal.aborted) throw cancelled()
        status.phase = 'swapping'
        if (previous) {
          previousDisposed = true
          await guarded(() => previous.dispose('hot_reload'), signal)
        }
        await guarded(() => onSwap(next, previous), signal)
        current = next
        currentFactory = exported.createRuntime
        loadedSources=candidateSources
        status.generation++
        status.phase = 'ready'
        status.lastError = null
        status.lastErrorAt = null
        status.recoveryFailed = false
        status.lastReload = { at: new Date().toISOString(), reason, durationMs: Date.now() - startedAt }
        // A change in an asynchronous swap callback earns a normal follow-up,
        // even if its directory event has not reached the JS loop yet.
        try { if(!consistent())revision++ } catch { revision++ }
        return snapshot()
      }
      throw new Error('Source changed repeatedly during passive reload; current Runtime was retained')
    } catch (error) {
      if (backup) restoreCache(backup)
      await discard(next, 'reload_failed')
      if (previousDisposed && previousFactory && !stopped) {
        // A passive constructor can be rebuilt from the last known-good module
        // if activation fails after its old instance was already disposed.
        try {
          const restoredContext = await guarded(() => createContext(), signal)
          const restored = await guarded(() => previousFactory(restoredContext), signal)
          validateRuntime(restored)
          await guarded(() => onSwap(restored, previous), signal)
          current = restored
          currentFactory = previousFactory
        } catch (recoveryError) {
          status.recoveryFailed = true
          error.message += ` / 旧動作の再生成にも失敗しました: ${errorText(recoveryError)}`
        }
      }
      status.phase = stopped ? 'stopped' : current ? 'ready' : 'failed'
      if (error.name !== 'AbortError') report(error)
      throw error
    }
  }
  function enqueueWatchReload () {
    if (stopped) return
    revision++
    clearTimeout(debounce)
    debounce = setTimeout(() => {
      debounce = null
      void reloadInternal('source_saved',true).catch(() => {})
    }, debounceMs)
  }
  function reloadInternal (reason, fromWatch = false) {
    if (inFlight) { if(!fromWatch && activeRequest)activeRequest.force=true;return inFlight }
    if (stopped) return Promise.reject(cancelled())
    if(fromWatch && sourcesUnchanged())return Promise.resolve(skipWatchReload(reason))
    const request={fromWatch,force:!fromWatch};activeRequest=request
    controller = new AbortController()
    status.pending = true
    const startedRevision = revision
    const work = performReload(String(reason).slice(0, 200), controller.signal, request).finally(() => {
      if (inFlight === work) {inFlight = null;if(activeRequest===request)activeRequest=null}
      status.pending = false
      if (!stopped && status.watching && revision > startedRevision && !debounce) {
        debounce = setTimeout(() => { debounce = null; void reloadInternal('source_saved_during_reload',true).catch(() => {}) }, debounceMs)
      }
    })
    inFlight = work
    return work
  }
  // Public/manual/API calls always force the existing reload semantics, even
  // if their supplied reason happens to equal a watcher label.
  function reload ({ reason = 'manual' } = {}) {return reloadInternal(reason,false)}
  function loadInitial () {
    if (inFlight) return inFlight
    if (current) return Promise.resolve(snapshot())
    return reload({ reason: 'initial_load' })
  }
  function watchDirectory (directory) {
    if (!watchedDirectories.has(keyOf(directory))) {
      const watcher = fs.watch(directory, (event, filename) => {
        if (filename == null || watched.has(keyOf(path.resolve(directory, String(filename))))) enqueueWatchReload()
      })
      watcher.on('error', report)
      watchers.push(watcher)
      watchedDirectories.add(keyOf(directory))
    }
  }
  function watch () {
    if (stopped) throw cancelled()
    if (status.watching) return snapshot()
    for (const directory of directories) watchDirectory(directory)
    status.watching = true
    return snapshot()
  }
  function addWatchFile (file) {
    if (stopped) throw cancelled()
    if (inFlight) throw new Error('再読み込み完了後に監視ファイルを追加してください。')
    registerFile(file)
    return snapshot()
  }
  function stop () {
    stopped = true
    clearTimeout(debounce); debounce = null
    for (const watcher of watchers.splice(0)) watcher.close()
    watchedDirectories.clear()
    controller?.abort(cancelled())
    status.watching = false
    status.phase = 'stopped'
    // stop() owns watchers and reload attempts, not the stable client/runtime.
    return snapshot()
  }
  return { loadInitial, reload, watch, addWatchFile, stop, snapshot, get current () { return current } }
}

module.exports = { createHotReloader }
