'use strict'

// Narrow, host-side command boundary. Never expose the arbitrary /action API to
// a browser. A start receipt belongs to one live connection, job and code generation.
const { createHash, randomUUID } = require('node:crypto')
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
  const yBottom = input.bottom == null ? 'world_min' : integer(input.bottom, '採掘下限Y', -64, 319)
  if (typeof yTop === 'number' && typeof yBottom === 'number' && yTop < yBottom) throw error('INVALID_INPUT', '採掘上限は下限以上にしてください。', 400)
  const mode = input.pickupMode ?? 'passive'
  if (!['active', 'passive'].includes(mode)) throw error('INVALID_INPUT', '回収方針が不正です。', 400)
  const storage = []
  return { target: { rect: { x1, z1, x2, z2 } }, dimension: 'overworld', yTop, yBottom,
    inventory: { pickupMode: mode, depositWhen: mode === 'passive' ? 'full' : 'capacity', storage }, quarryCombat: { enabled: true } }
}
function scope (state) {
  if (!state?.connectionId || !state.profile || state.realm?.id == null || !state.dimension) return null
  return digest([state.profile, String(state.realm.id), state.dimension, state.connectionId, state.startedAt, state.lifecycle?.deathId ?? 0])
}
function createDashboardControl ({ getState, getQuarry, getReset = () => null, getGeneration = () => 0, disconnect, now = Date.now, uuid = randomUUID }) {
  let receipt = null, busy = 0
  const invalidate = () => { receipt = null }
  function snapshot () {
    const s = getState(), q = getQuarry()?.status() ?? null
    const position = s?.position && ['x', 'y', 'z'].every(k => Number.isFinite(s.position[k])) ? { x: s.position.x, y: s.position.y - 1.62, z: s.position.z } : null
    return { protocol: 1, phase: text(s?.phase), ready: s?.phase === 'spawned' && s.loadingScreenEnded === true && !s.dead && !s.isDead && !s.lifecycle?.dead && !s.spawnPending && s.health > 0 && s.inventory?.known === true && !s.inventory.uncertain,
      session: scope(s), profile: text(s?.profile), realm: s?.realm ? { id: String(s.realm.id), name: text(s.realm.name) } : null, dimension: text(s?.dimension), position,
      chunk: position ? { x: Math.floor(position.x / 16), z: Math.floor(position.z / 16) } : null,
      busy: busy > 0, loadout: getReset()?.status() ?? { busy: false, phase: 'idle' }, quarry: q?.jobId ? { jobId: text(q.jobId), state: text(q.state), userRunIntent: text(q.userRunIntent), pauseReason: text(q.pauseReason), persistence: q.persistence ?? null, currentY: q.currentY ?? null } : null }
  }
  function checkSession (input) {
    const current = scope(getState())
    if (!current || input.session !== current) throw error('STALE_SESSION', '接続先または生存状態が変わりました。状態を更新して操作してください。')
  }
  async function execute (input) {
    object(input, ['command', 'session', 'config', 'planToken', 'jobId', 'resetToken', 'confirm'])
    if (!['plan', 'start', 'pause', 'resume', 'emergencyStop', 'cancel', 'disconnect', 'resetPreview', 'resetStart', 'resetCancel'].includes(input.command)) throw error('INVALID_COMMAND', 'この操作は管理画面に公開されていません。', 400)
    checkSession(input)
    const reset = getReset()
    if (['resetPreview', 'resetStart', 'resetCancel'].includes(input.command)) {
      invalidate()
      if (!reset) throw error('RESET_UNAVAILABLE', 'Bot本体を更新・再起動してください。')
      if (input.command === 'resetPreview') return { resetPreview: await reset.preview(), state: snapshot() }
      if (input.command === 'resetCancel') return { reset: reset.cancel(), state: snapshot() }
      return { reset: reset.start({ token: input.resetToken, confirm: input.confirm }), state: snapshot() }
    }
    const stopping = ['pause', 'emergencyStop', 'cancel', 'disconnect'].includes(input.command)
    if (reset?.status().busy && !stopping) throw error('RESET_BUSY', '初期アイテムのリセット処理中です。')
    if (stopping && reset?.status().busy) reset.cancel()
    if (busy && !stopping) throw error('CONTROL_BUSY', '前の操作の終了を待っています。')
    const q = getQuarry()
    if (!q) throw error('NOT_READY', 'Botの初期化を待っています。')
    const current = q.status()
    if (input.command !== 'plan' && input.command !== 'start' && input.jobId !== (current?.jobId ?? null)) throw error('STALE_JOB', 'ジョブが変わりました。状態を更新してください。')
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
