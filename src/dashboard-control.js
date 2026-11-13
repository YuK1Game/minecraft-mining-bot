'use strict'

// Narrow, host-side command boundary. Never expose the arbitrary /action API to
// a browser. A start receipt belongs to one live connection, job and code generation.
const { createHash, randomUUID } = require('node:crypto')
const { observedScope } = require('./server-position-verifier')
const { normalizeChunkArea, areaContainsFeet, chunkAreaKey } = require('./chunk-area')
const error = (code, message, status = 409) => Object.assign(new Error(message), { code, status })
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const text = value => String(value ?? '').replace(/[\p{C}\u00a7]/gu, ' ').slice(0, 240)
function object (value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw error('INVALID_INPUT', '入力項目が不正です。', 400)
}
function integer (value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw error('INVALID_INPUT', `${name} は ${min}〜${max} の整数で指定してください。`, 400)
  return value
}
function quarryConfig (input, state) {
  object(input, ['x1', 'z1', 'x2', 'z2', 'top', 'bottom', 'chest', 'pickupMode'])
  if (input.chest != null) throw error('SHULKER_ONLY_STORAGE', '収納先はシュルカーボックス専用です。', 400)
  if (state.dimension !== 'overworld') throw error('WRONG_DIMENSION', '画面からの新規露天掘りはオーバーワールドに限定しています。')
  const x1 = integer(input.x1, '開始チャンクX', -1875000, 1874999), z1 = integer(input.z1, '開始チャンクZ', -1875000, 1874999)
  const x2 = integer(input.x2 ?? x1, '終了チャンクX', -1875000, 1874999), z2 = integer(input.z2 ?? z1, '終了チャンクZ', -1875000, 1874999)
  if ((Math.abs(x2 - x1) + 1) * (Math.abs(z2 - z1) + 1) > 4) throw error('RANGE_TOO_LARGE', '画面から一度に指定できる範囲は最大4チャンクです。', 400)
  const yTop = input.top == null ? 'auto' : integer(input.top, '採掘上限Y', -64, 319)
  const yBottom = input.bottom == null ? -59 : integer(input.bottom, '採掘下限Y', -64, 319) // default -59 (user request 2026-11-10)
  if (typeof yTop === 'number' && typeof yBottom === 'number' && yTop < yBottom) throw error('INVALID_INPUT', '採掘上限は下限以上にしてください。', 400)
  const mode = input.pickupMode ?? 'passive'
  if (!['active', 'passive'].includes(mode)) throw error('INVALID_INPUT', '回収方針が不正です。', 400)
  const storage = []
  return { target: { rect: { x1, z1, x2, z2 } }, dimension: 'overworld', yTop, yBottom,
    inventory: { pickupMode: mode, depositWhen: mode === 'passive' ? 'full' : 'capacity', storage }, quarryCombat: { enabled: true },
    // Caves are crossed by the running job (chunk 126,126 finished through lush
    // caves on 2026-11-13); a large cave is a plan warning, not a refusal.
    allowCaves: true }
}
function scope (state) {
  if (!state?.connectionId || !state.profile || state.realm?.id == null || !state.dimension) return null
  return digest([state.profile, String(state.realm.id), state.dimension, state.connectionId, state.startedAt, state.lifecycle?.deathId ?? 0])
}
const storageCommands = ['storagePreview', 'storageStart', 'storageCancel']
const operationId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value)
const point = value => value && ['x', 'y', 'z'].every(axis => Number.isSafeInteger(value[axis]) && Math.abs(value[axis]) <= 30000000)
  ? { x: value.x, y: value.y, z: value.z } : null
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0
const storageReady = state => !!scope(state) && state.phase === 'spawned' && state.loadingScreenEnded === true && !state.dead && !state.isDead && !state.lifecycle?.dead && !state.spawnPending && state.health > 0
function storageStatus (storage, state) {
  const value = storage?.status() ?? {}
  return { available: !!storage, ready: !!storage && storageReady(state), busy: value.busy === true, phase: text(value.phase || (storage ? 'idle' : 'unavailable')),
    operationId: operationId(value.operationId) ? value.operationId : null, serverConfirmed: value.serverConfirmed === true,
    target: point(value.target), transferredStacks: count(value.transferredStacks), remainingStacks: count(value.remainingStacks),
    error: value.error ? { code: text(value.error.code), message: text(value.error.message) } : null }
}
function storagePreview (value) {
  const stacks = value?.stacks, position = point(value?.position)
  if (!value || typeof value.token !== 'string' || !value.token || value.token.length > 256 || !Number.isFinite(value.expiresAt) ||
    !operationId(value.operationId) || !position || value.slotCount !== 54 ||
    !stacks || !['main', 'armor', 'offhand', 'total'].every(key => Number.isSafeInteger(stacks[key]) && stacks[key] >= 0) ||
    stacks.main > 36 || stacks.armor > 4 || stacks.offhand > 1 || stacks.total !== stacks.main + stacks.armor + stacks.offhand) throw error('INVALID_STORAGE_PREVIEW', '収納先と持ち物の確認結果が不正です。')
  return { token: value.token, expiresAt: value.expiresAt, operationId: value.operationId, position, slotCount: 54,
    resume: value.resume === true, stacks: { main: stacks.main, armor: stacks.armor, offhand: stacks.offhand, total: stacks.total },
    target: { position: point(value.target?.position), realm: text(value.target?.realm), player: text(value.target?.player), dimension: text(value.target?.dimension) } }
}
function createDashboardControl ({ getState, getQuarry, getReset = () => null, getStorage = () => null, getGeneration = () => 0, disconnect, now = Date.now, uuid = randomUUID }) {
  let receipt = null, resetReceipt = null, revision = 0, busy = 0
  const invalidate = () => { receipt = null; resetReceipt = null; revision++ }
  const areaOf = value => { try { return normalizeChunkArea(value) } catch { throw error('INVALID_INPUT', '移動・初期チェストのチャンク範囲が不正です。', 400) } }
  // Runtime and Host count lives differently (Runtime: the automatic respawn
  // record; Host: every death seen on this connection), so their scope strings
  // can differ in the life element alone. Compare the connection identity; the
  // Runtime already drops its proof when the Bot's own life or pose changes.
  const connectionOf = value => { try { const parts = JSON.parse(value); return Array.isArray(parts) && parts.length === 7 ? JSON.stringify(parts.slice(0, 6)) : null } catch { return null } }
  // Returns { proof } or { reason, ... } naming the one check that failed.
  function proofCheck (q, state) {
    if (typeof q?.controlPosition !== 'function') return { reason: 'NO_CAPABILITY' }
    let value
    try { value = q.controlPosition() } catch { return { reason: 'NO_CAPABILITY' } }
    const currentScope = observedScope(state), feet = value?.feet
    if (!currentScope) return { reason: 'HOST_STATE' }
    if (value?.confirmed !== true) return { reason: 'RUNTIME', detail: typeof value?.reason === 'string' ? text(value.reason).slice(0, 60) : null }
    if (connectionOf(value.scope) === null || connectionOf(value.scope) !== connectionOf(currentScope)) return { reason: 'SCOPE' }
    if (!Number.isSafeInteger(value.generation) || value.generation < 0) return { reason: 'INVALID_PROOF', detail: 'generation' }
    if (typeof value.source !== 'string' || !/position/i.test(value.source) || /prediction/i.test(value.source)) return { reason: 'INVALID_PROOF', detail: 'source' }
    if (!feet || !['x', 'y', 'z'].every(axis => Number.isFinite(feet[axis]) && Math.abs(feet[axis]) <= 30000000)) return { reason: 'INVALID_PROOF', detail: 'feet' }
    if (!Number.isFinite(value.radius) || value.radius < 0 || value.radius > 1.5) return { reason: 'INVALID_PROOF', detail: 'radius' }
    const observedAt = typeof value.observedAt === 'number' ? value.observedAt : Date.parse(value.observedAt)
    if (!Number.isFinite(observedAt) || observedAt > now()) return { reason: 'INVALID_PROOF', detail: 'observedAt' }
    return { proof: { confirmed: true, session: scope(state), feet: { x: feet.x, y: feet.y, z: feet.z }, radius: value.radius, generation: value.generation, observedAt, source: text(value.source) } }
  }
  const positionProof = (q, state) => proofCheck(q, state).proof ?? null
  function moveStatus (q, state) {
    const available = ['moveToChunk', 'cancelChunkMove', 'chunkMoveStatus', 'controlPosition'].every(name => typeof q?.[name] === 'function')
    let value = {}, area = null
    try { value = q?.chunkMoveStatus?.() ?? {}; if (value.area != null) area = normalizeChunkArea(value.area) } catch { /* Unavailable status cannot grant a permission. */ }
    const proof = positionProof(q, state), confirmed = value.serverConfirmed === true && !!area && !!proof && areaContainsFeet(area, proof.feet, proof.radius)
    return { available, busy: value.busy === true, phase: text(value.phase || (available ? 'idle' : 'unavailable')), operationId: operationId(value.operationId) ? value.operationId : null,
      area, serverConfirmed: confirmed, ...(value.error ? { error: { code: text(value.error.code), message: text(value.error.message) } } : {}) }
  }
  const runtimeReasons = { BOT_MOVING: 'Botが移動中', NO_SERVER_POSITION: 'サーバーから現在位置を受信していない', BOT_STATE_UNAVAILABLE: 'Botの接続・体力・生存状態が未確定', BOT_POSITION_UNAVAILABLE: 'Botの現在位置が不明',
    OUTSIDE_AREA: 'Botが選択範囲の外、または範囲の端から0.12ブロック未満', BOT_MOVED: '照会中にBotが動いた', SCOPE_CHANGED: '照会中に接続・生存状態が変わった', GENERATION_CHANGED: '照会中にコードが更新された', ABORTED: '照会が中断された',
    RECEIPT_MISMATCH: 'サーバーの回答が照会した位置と一致しない', SERVER_POSITION_TIMEOUT: 'サーバーが時間内に回答しなかった', SERVER_POSITION_NOT_MATCHED: 'サーバー上のBotの位置が照会した位置と一致しない', SERVER_POSITION_VERIFIER_BUSY: '別の位置照会が進行中' }
  // The refusal names the failed check and the values it compared.
  function positionFailure (area, check, confirmDetail = null) {
    const state = getState(), p = state?.position, fixed = n => Number.isFinite(n) ? n.toFixed(1) : '?'
    const bot = p && ['x', 'y', 'z'].every(axis => Number.isFinite(p[axis])) ? `X ${fixed(p.x)} Y ${fixed(p.y - 1.62)} Z ${fixed(p.z)}` : '不明'
    const range = `X ${area.x1 * 16}〜${area.x2 * 16 + 15} Z ${area.z1 * 16}〜${area.z2 * 16 + 15}`
    const detail = confirmDetail ?? check.detail
    const why = check.reason === 'NO_CAPABILITY' ? 'Bot本体が位置確認に未対応。Botの再起動が必要'
      : check.reason === 'HOST_STATE' ? 'Botの接続・体力・生存状態が未確定'
      : check.reason === 'SCOPE' ? '位置確認の記録が現在の接続のものではない'
      : check.reason === 'INVALID_PROOF' ? `位置確認の記録が不正（${check.detail}）`
      : check.reason === 'OUTSIDE' ? `サーバーで確認した位置 X ${fixed(check.feet.x)} Z ${fixed(check.feet.z)} が選択範囲の外、または端から${fixed(check.radius)}ブロック未満`
      : runtimeReasons[detail] ?? (detail ? `位置確認の記録がない（${detail}）` : '位置確認の記録がない')
    return Object.assign(error('CHUNK_POSITION_UNCONFIRMED', `Botの位置をサーバーで確認できません: ${why}。Bot ${bot} ／ 範囲 ${range}`), { positionCheck: check.reason, positionDetail: detail ?? null })
  }
  function requireAreaPosition (area, q = getQuarry(), confirmDetail = null) {
    const check = proofCheck(q, getState())
    if (!check.proof) throw positionFailure(area, check, confirmDetail)
    if (!areaContainsFeet(area, check.proof.feet, check.proof.radius)) throw positionFailure(area, { reason: 'OUTSIDE', feet: check.proof.feet, radius: check.proof.radius })
    return check.proof
  }
  // A standing Bot rarely holds a fresh proof. Ask the server for one on demand;
  // the placement is still refused unless that actual witness lands in the area.
  async function ensureAreaPosition (area, q, input) {
    try { return requireAreaPosition(area, q) } catch (failure) {
      if (typeof q?.confirmControlPosition !== 'function') throw failure
      let detail = null
      busy++
      try { const receipt = await q.confirmControlPosition(structuredClone(area)); if (receipt?.serverConfirmed !== true) detail = typeof receipt?.detail === 'string' ? text(receipt.detail).slice(0, 80) : 'SERVER_NO_ANSWER' } catch (thrown) { detail = 'SERVER_' + text(thrown?.code ?? 'ERROR').slice(0, 60) } finally { busy-- }
      checkSession(input)
      if (getQuarry() !== q || moveStatus(q, getState()).busy) throw failure
      return requireAreaPosition(area, q, detail)
    }
  }
  function requireMovableJob (q) {
    const status = q.status?.(), doc = q.document?.()
    if (status?.draining || status?.persistence?.status === 'failed' || status?.jobId && !['IDLE', 'PAUSED', 'FINISHED'].includes(status.state) ||
      status?.supplies?.active || status?.portableStorage || doc?.supplyRestock || doc?.portableStorage || doc?.pendingTotemEquip ||
      doc?.loadout && doc.loadoutReady !== true || doc?.finalChest && doc.finalChest.checkpoint?.phase !== 'completed' ||
      doc?.egress?.checkpoint && !doc.surfaceReturnedAt) throw error('QUARRY_BUSY', '既存の作業と未確認の回収が終了してから移動してください。')
  }
  function snapshot () {
    const s = getState(), engine = getQuarry(), q = engine?.status() ?? null
    const position = s?.position && ['x', 'y', 'z'].every(k => Number.isFinite(s.position[k])) ? { x: s.position.x, y: s.position.y - 1.62, z: s.position.z } : null
    return { protocol: 1, phase: text(s?.phase), ready: s?.phase === 'spawned' && s.loadingScreenEnded === true && !s.dead && !s.isDead && !s.lifecycle?.dead && !s.spawnPending && s.health > 0 && s.inventory?.known === true && !s.inventory.uncertain,
      session: scope(s), profile: text(s?.profile), realm: s?.realm ? { id: String(s.realm.id), name: text(s.realm.name) } : null, dimension: text(s?.dimension), position,
      chunk: position ? { x: Math.floor(position.x / 16), z: Math.floor(position.z / 16) } : null,
      busy: busy > 0, loadout: getReset()?.status() ?? { busy: false, phase: 'idle' }, storage: storageStatus(getStorage(), s), chunkMove: moveStatus(engine, s), positionProof: positionProof(engine, s),
      quarry: q?.jobId ? { jobId: text(q.jobId), state: text(q.state), userRunIntent: text(q.userRunIntent), pauseReason: text(q.pauseReason), persistence: q.persistence ?? null, currentY: q.currentY ?? null } : null }
  }
  function checkSession (input) {
    const current = scope(getState())
    if (!current || input.session !== current) throw error('STALE_SESSION', '接続先または生存状態が変わりました。状態を更新して操作してください。')
  }
  async function execute (input) {
    object(input, input?.command === 'moveToChunk' ? ['command', 'session', 'area'] : input?.command === 'cancelChunkMove' ? ['command', 'session', 'operationId'] : input?.command === 'resetPreview' ? ['command', 'session', 'area'] : input?.command === 'resetStart' ? ['command', 'session', 'resetToken', 'confirm', 'area'] : input?.command === 'resetCancel' ? ['command', 'session'] : storageCommands.includes(input?.command)
      ? ['command', 'session', 'operationId', 'storageToken', 'confirm']
      : ['command', 'session', 'config', 'planToken', 'jobId', 'resetToken', 'confirm'])
    if (!['plan', 'start', 'pause', 'resume', 'emergencyStop', 'cancel', 'disconnect', 'resetPreview', 'resetStart', 'resetCancel', 'moveToChunk', 'cancelChunkMove', ...storageCommands].includes(input.command)) throw error('INVALID_COMMAND', 'この操作は管理画面に公開されていません。', 400)
    checkSession(input)
    const reset = getReset(), storage = getStorage(), storing = storage?.status().busy === true
    const movement = getQuarry(), moving = moveStatus(movement, getState())
    if (['moveToChunk', 'cancelChunkMove'].includes(input.command)) {
      invalidate()
      if (!moving.available) throw error('CHUNK_MOVE_UNAVAILABLE', 'Botの移動機能が未反映です。')
      if (input.command === 'cancelChunkMove') {
        if (!operationId(input.operationId) || input.operationId !== moving.operationId) throw error('STALE_CHUNK_MOVE', '移動操作が変わりました。状態を更新してください。')
        movement.cancelChunkMove(input.operationId)
        return { chunkMove: moveStatus(movement, getState()), state: snapshot() }
      }
      const area = areaOf(input.area)
      if (busy || moving.busy) throw error('CONTROL_BUSY', '前の操作の終了を待っています。')
      if (reset?.status().busy) throw error('RESET_BUSY', 'デバッグ操作の終了を待ってください。')
      if (storing) throw error('STORAGE_BUSY', '収納操作の終了を待ってください。')
      if (!storageReady(getState())) throw error('NOT_READY', '参加位置・体力の受信を待っています。')
      requireMovableJob(movement)
      const result = movement.moveToChunk({ area })
      if (result?.then) { void Promise.resolve(result).catch(() => {}); throw error('CHUNK_MOVE_RESULT_UNKNOWN', '移動の受付状態を再確認してください。操作を繰り返さないでください。') }
      return { chunkMove: moveStatus(movement, getState()), state: snapshot() }
    }
    if (moving.busy && ['plan', 'start', 'resume', 'resetPreview', 'resetStart', 'storagePreview', 'storageStart'].includes(input.command)) throw error('CHUNK_MOVE_BUSY', 'Botの移動が終わるまで待ってください。')
    if (storageCommands.includes(input.command)) {
      invalidate()
      if (!storage) throw error('STORAGE_UNAVAILABLE', 'Bot本体の収納機能が未反映です。')
      if (input.command === 'storageCancel') {
        object(input, ['command', 'session', 'operationId'])
        if (!operationId(input.operationId) || input.operationId !== storage.status().operationId) throw error('STALE_STORAGE_OPERATION', '収納操作が変わりました。状態を更新してください。')
        storage.cancel()
        return { storage: storageStatus(storage, getState()), state: snapshot() }
      }
      if (reset?.status().busy) throw error('RESET_BUSY', 'デバッグ操作の終了を待ってください。')
      if (storing) throw error('STORAGE_BUSY', '収納操作の終了を待ってください。')
      if (busy) throw error('CONTROL_BUSY', '前の操作の終了を待っています。')
      if (!storageReady(getState())) throw error('NOT_READY', '参加位置・体力の受信を待っています。')
      busy++
      try {
        if (input.command === 'storagePreview') {
          object(input, ['command', 'session', 'operationId'])
          if (input.operationId !== undefined && !operationId(input.operationId)) throw error('INVALID_INPUT', '収納操作IDが不正です。', 400)
          const preview = await storage.prepare(input.operationId === undefined ? {} : { operationId: input.operationId })
          checkSession(input)
          if (getStorage() !== storage) throw error('STALE_STORAGE_OPERATION', '収納機能が更新されました。状態を更新してください。')
          return { storagePreview: storagePreview(preview), state: snapshot() }
        }
        object(input, ['command', 'session', 'storageToken', 'confirm'])
        if (typeof input.storageToken !== 'string' || !input.storageToken || input.storageToken.length > 256 || input.confirm !== 'STORE_ALL_IN_EMPTY_CHEST') throw error('INVALID_INPUT', '収納の確認情報が不正です。', 400)
        const started = storage.start({ token: input.storageToken, confirm: input.confirm })
        if (started?.then) {
          void Promise.resolve(started).catch(() => {})
          throw error('STORAGE_RESULT_UNKNOWN', '収納の受付状態を再確認してください。操作を繰り返さないでください。')
        }
        return { storage: storageStatus(storage, getState()), state: snapshot() }
      } finally { busy-- }
    }
    if (storing && ['plan', 'start', 'resume', 'resetPreview', 'resetStart'].includes(input.command)) throw error('STORAGE_BUSY', '収納操作の終了を待ってください。')
    if (['resetPreview', 'resetStart', 'resetCancel'].includes(input.command)) {
      if (busy && input.command !== 'resetCancel') throw error('CONTROL_BUSY', '前の操作の終了を待っています。')
      if (!reset) throw error('RESET_UNAVAILABLE', 'Bot本体を更新・再起動してください。')
      if (input.command === 'resetCancel') { invalidate(); return { reset: reset.cancel(), state: snapshot() } }
      const r = input.command === 'resetStart' ? resetReceipt : null
      if (input.command === 'resetStart') invalidate()
      const area = areaOf(input.area)
      let proof // Stay synchronous when the proof is already held.
      try { proof = requireAreaPosition(area, movement) } catch { proof = await ensureAreaPosition(area, movement, input) }
      if (input.command === 'resetPreview') {
        invalidate()
        const generation = getGeneration(), runtimeGeneration = proof.generation, previewRevision = revision
        let preview
        busy++
        try { preview = await reset.preview({ area: structuredClone(area) }) } finally { busy-- }
        checkSession(input)
        if (revision !== previewRevision || getReset() !== reset || getQuarry() !== movement || getGeneration() !== generation || moveStatus(movement, getState()).busy) throw error('STALE_RESET', '初期チェストの確認中に状態が変わりました。')
        if (requireAreaPosition(area, movement).generation !== runtimeGeneration) throw error('STALE_RESET', '初期チェストの確認中に状態が変わりました。')
        if (typeof preview?.token !== 'string' || !preview.token || preview.token.length > 256 || !Number.isFinite(preview.expiresAt)) throw error('INVALID_RESET_PREVIEW', '初期チェストの確認結果が不正です。')
        resetReceipt = { token: preview.token, area: chunkAreaKey(area), session: input.session, generation, runtimeGeneration, reset, quarry: movement, expiresAt: Math.min(preview.expiresAt, now() + 120000) }
        return { resetPreview: preview, state: snapshot() }
      }
      if (!r || r.token !== input.resetToken || r.area !== chunkAreaKey(area) || r.session !== input.session || r.generation !== getGeneration() || r.runtimeGeneration !== proof.generation || r.reset !== reset || r.quarry !== movement || r.expiresAt <= now()) throw error('STALE_RESET', '初期チェストの確認が変更・失効しました。もう一度確認してください。')
      return { reset: reset.start({ token: input.resetToken, confirm: input.confirm, area: structuredClone(area) }), state: snapshot() }
    }
    const stopping = ['pause', 'emergencyStop', 'cancel', 'disconnect'].includes(input.command)
    if (reset?.status().busy && !stopping) throw error('RESET_BUSY', '初期アイテムのリセット処理中です。')
    if (stopping && reset?.status().busy) reset.cancel()
    if (busy && !stopping) throw error('CONTROL_BUSY', '前の操作の終了を待っています。')
    const q = getQuarry()
    if (!q) {
      if (stopping && storing && input.jobId === null) {
        storage.cancel()
        if (input.command === 'disconnect') { checkSession(input); setImmediate(disconnect); return { disconnecting: true } }
        return { state: snapshot() }
      }
      throw error('NOT_READY', 'Botの初期化を待っています。')
    }
    const current = q.status()
    if (input.command !== 'plan' && input.command !== 'start' && input.jobId !== (current?.jobId ?? null)) throw error('STALE_JOB', 'ジョブが変わりました。状態を更新してください。')
    if (stopping && moving.busy) { invalidate(); movement.cancelChunkMove(moving.operationId) }
    if (stopping && storing) storage.cancel()
    if (!stopping && !snapshot().ready) throw error('NOT_READY', '参加位置・体力・所持品の受信を待っています。')
    if (input.command === 'plan') {
      if (current?.jobId && !['IDLE', 'FINISHED'].includes(current.state)) throw error('JOB_EXISTS', '既存のジョブを再開するか、キャンセルしてから新しい計画を作成してください。')
      const config = quarryConfig(input.config, getState())
      invalidate()
      const result = q.plan(config) // Existing synchronous planning: no world mutation.
      if (result?.then) throw error('INVALID_PLANNER', '計画処理の互換性を確認してください。')
      if (result.ready) receipt = { instanceId: q.document()?.instanceId ?? null, token: uuid(), session: input.session, jobId: result.jobId, config: digest(q.document()?.config), generation: getGeneration(), expiresAt: now() + 120000 }
      return { planToken: receipt?.token ?? null, expiresAt: receipt?.expiresAt ?? null,
        plan: { jobId: text(result.jobId), ready: result.ready === true, chunks: result.chunks, yTop: result.yTop, yBottom: result.yBottom,
          issues: (result.issues ?? []).slice(0, 80).map(text), warnings: (result.warnings ?? []).slice(0, 40).map(w => text(w.code ?? w)), counts: result.counts ?? null }, state: snapshot() }
    }
    if (input.command === 'start') {
      const r = receipt
      invalidate() // One shot, even if the engine refuses to start. No automatic POST retry.
      if (!r || input.planToken !== r.token || r.expiresAt <= now() || r.session !== input.session || r.jobId !== current?.jobId || current.state !== 'IDLE' || r.generation !== getGeneration() || r.config !== digest(q.document()?.config) || r.instanceId !== (q.document()?.instanceId ?? null)) throw error('STALE_PLAN', '計画が変更・失効しました。もう一度「計画を確認」を押してください。')
      q.start()
      return { state: snapshot() }
    }
    invalidate()
    if (input.command === 'resume') {
      if (current?.state !== 'PAUSED') throw error('NOT_PAUSED', '一時停止中のジョブだけ再開できます。')
      q.resume()
      return { state: snapshot() }
    }
    busy++
    try {
      if (input.command === 'disconnect') {
        await q.pause()
        checkSession(input)
        setImmediate(disconnect)
        return { disconnecting: true }
      }
      await q[input.command]()
      return { state: snapshot() }
    } finally { busy-- }
  }
  return { snapshot, execute, invalidate }
}
module.exports = { createDashboardControl, quarryConfig, scope }
