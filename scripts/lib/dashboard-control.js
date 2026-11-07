'use strict'

const http = require('node:http')
const net = require('node:net')
const path = require('node:path')
const { fork } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const { CHANNEL, realmId, publicRealms } = require('../../src/dashboard-session')
const failure = (code, message, status = 409) => Object.assign(new Error(message), { code, status })
const profileName = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) throw failure('INVALID_PROFILE', 'プロフィールは半角英数字・ハイフン・アンダースコアで指定してください。', 400)
  return value
}
function inputKeys (value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw failure('INVALID_INPUT', '入力項目が不正です。', 400)
}
// Fixed loopback destination and fixed paths, not a general HTTP proxy.
function requestControl ({ apiPort, payload, timeoutMs = 1000 }) {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? null : Buffer.from(JSON.stringify(payload))
    const headers = { Host: `127.0.0.1:${apiPort}`, Accept: 'application/json' }
    if (body) Object.assign(headers, { 'Content-Type': 'application/json', 'Content-Length': body.length })
    let timer, settled = false
    const finish = (err, value) => { if (settled) return; settled = true; clearTimeout(timer); err ? reject(err) : resolve(value) }
    const req = http.request({ hostname: '127.0.0.1', port: apiPort, path: body ? '/dashboard/action' : '/dashboard/status', method: body ? 'POST' : 'GET', headers, agent: false }, response => {
      let size = 0; const chunks = []
      response.on('data', chunk => { size += chunk.length; if (size > 256 * 1024) { req.destroy(failure('RESPONSE_TOO_LARGE', 'Botの応答が上限を超えました。')); return } chunks.push(chunk) })
      response.once('error', err => finish(err))
      response.once('aborted', () => finish(failure('RESULT_UNKNOWN', 'Botの応答が中断されました。状態を再確認してください。')))
      response.once('end', () => {
        if (!/^application\/json(?:;|$)/i.test(response.headers['content-type'] ?? '')) return finish(failure('INCOMPATIBLE_BOT', 'Bot本体を更新・再起動してください。'))
        let value
        try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return finish(failure('INVALID_RESPONSE', 'Botの応答を確認できませんでした。')) }
        if (response.statusCode !== 200) return finish(failure(value.code ?? 'BOT_REFUSED', typeof value.error === 'string' ? value.error.slice(0, 500) : 'Botが操作を拒否しました。', response.statusCode === 400 ? 400 : 409))
        if (!body && value.protocol !== 1) return finish(failure('INCOMPATIBLE_BOT', 'Bot本体を更新・再起動してください。'))
        finish(null, value)
      })
    })
    req.once('error', err => finish(err))
    timer = setTimeout(() => req.destroy(failure('RESULT_UNKNOWN', '応答が時間内に届きません。操作を繰り返さず現在の状態を確認してください。', 504)), timeoutMs)
    req.end(body)
  })
}
function portOccupied (port) {
  return new Promise(resolve => {
    let finished = false
    const socket = net.createConnection({ host: '127.0.0.1', port })
    const done = value => { if (finished) return; finished = true; socket.destroy(); resolve(value) }
    socket.once('connect', () => done(true))
    socket.once('error', err => done(err.code !== 'ECONNREFUSED'))
    socket.setTimeout(800, () => done(true)) // Unknown is occupied, never a reason to start twice.
  })
}
function createDashboardManager ({ workspaceRoot, apiPort, defaultProfile = 'main', spawnBot = fork, requestBot = requestControl, occupied = portOccupied, now = Date.now, stopGraceMs = 12000 } = {}) {
  profileName(defaultProfile)
  if (!Number.isSafeInteger(apiPort) || apiPort < 1 || apiPort > 65535 || apiPort === 3001) throw new Error('Bot APIポートを管理画面と異なる1〜65535で指定してください。')
  let child = null, childId = null, profile = defaultProfile, phase = 'offline', auth = null, realms = [], message = null
  let launching = false, closing = null, stopped = false, observing = null
  const publicState = live => ({ processId: childId, managed: !!child, phase: live?.phase || phase, profile, auth: auth && auth.expiresAt > now() ? auth : null, realms,
    message, live: live ?? null, canLaunch: !child && !launching && !live })
  function snapshot () {
    if (observing) return observing
    const task = requestBot({ apiPort }).then(live => {
      const s = publicState(live)
      if (live.realm) { s.auth = null; s.realms = [] }
      return s
    }, err => ({ ...publicState(null), incompatible: err.code !== 'ECONNREFUSED', message: message ?? (err.code === 'ECONNREFUSED' ? null : 'Botの操作APIが利用できません。旧版のBotは更新・再起動してください。') }))
    observing = task.finally(() => { observing = null })
    return observing
  }
  function send (data) {
    if (!child?.connected) throw failure('NOT_CONNECTED', '管理プロセスが終了しています。')
    child.send({ channel: CHANNEL, ...data }, err => { if (err) message = 'Botへの操作送信に失敗しました。状態を確認してください。' })
  }
  async function list (input) {
    inputKeys(input, ['profile'])
    const selected = profileName(input.profile ?? defaultProfile)
    if (stopped || launching || closing) throw failure('CONTROL_BUSY', '起動・停止処理中です。')
    if (child) {
      if (selected !== profile) throw failure('PROFILE_BUSY', 'プロフィールを変更する前にBotを切断してください。')
      if (phase === 'selecting_realm') { send({ type: 'refresh' }); return publicState() }
      if (['starting', 'authenticating'].includes(phase)) return publicState()
      throw failure('ALREADY_RUNNING', '接続中です。ワールドを変更する前に切断してください。')
    }
    launching = true
    try {
      if (await occupied(apiPort)) throw failure('PORT_IN_USE', '既にBotまたは別のプロセスが起動しています。二重起動を防ぐため開始しません。接続状態を確認してください。')
      if (stopped) throw failure('CLOSED', '管理画面サーバーは終了しています。')
      profile = selected; phase = 'starting'; auth = null; realms = []; message = null; childId = randomUUID()
      const spawned = spawnBot(path.join(workspaceRoot, 'src/main.js'), ['--dashboard'], { cwd: workspaceRoot, execPath: process.execPath, execArgv: ['--env-file-if-exists=.env'],
        env: { ...process.env, BOT_PROFILE: selected, REALM_ID: '', API_PORT: String(apiPort) }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true })
      child = spawned
      spawned.on('message', value => {
        if (child !== spawned || value?.channel !== CHANNEL || closing) return
        if (value.type === 'auth' && value.auth && /^[A-Za-z0-9 -]{4,32}$/.test(value.auth.code) && Number.isFinite(value.auth.expiresAt)) {
          phase = 'authenticating'; auth = { code: value.auth.code, url: 'https://www.microsoft.com/link', expiresAt: Math.min(value.auth.expiresAt, now() + 900000) }
        } else if (value.type === 'realms') { phase = 'selecting_realm'; realms = publicRealms(value.realms); auth = null; message = realms.length ? null : '参加可能なRealmがありません。招待とアカウントを確認してください。' }
        else if (value.type === 'connecting') { phase = 'connecting'; auth = null; realms = [] }
        else if (value.type === 'error') message = String(value.message ?? 'Botの操作に失敗しました。').slice(0, 300)
      })
      spawned.once('error', () => { if (child === spawned) message = 'Botを起動できませんでした。Node.jsと依存パッケージを確認してください。' })
      spawned.once('close', code => { if (child !== spawned) return; child = null; childId = null; phase = 'offline'; auth = null; realms = []; if (code && !closing) message ??= 'Botが終了しました。ターミナルのエラーを確認してください。' })
      return publicState()
    } catch (err) { if (!child) { childId = null; phase = 'offline' } throw err } finally { launching = false }
  }
  function connect (input) {
    inputKeys(input, ['processId', 'realmId'])
    if (!child || input.processId !== childId || phase !== 'selecting_realm' || closing) throw failure('STALE_PROCESS', 'ワールド一覧を再取得してください。')
    if (!realmId(input.realmId) || !realms.some(r => r.id === input.realmId && r.available)) throw failure('INVALID_REALM', '参加可能なワールドを選択してください。', 400)
    send({ type: 'connect', realmId: input.realmId }); phase = 'connecting'; message = null
    return publicState()
  }
  function stopChild () {
    if (closing) return closing
    if (!child) return Promise.resolve({ disconnected: true })
    const owner = child
    let timer, force, rejectTimer
    const task = new Promise((resolve, reject) => {
      owner.once('close', () => { clearTimeout(timer); clearTimeout(force); clearTimeout(rejectTimer); resolve({ disconnected: true }) })
      try { send({ type: 'stop' }) } catch { /* A closed IPC channel still needs the child close event. */ }
      timer = setTimeout(() => { message = '通常停止が完了せず、プロセスを終了します。再開時にチェックポイントを確認してください。'; try { owner.kill('SIGTERM') } catch {} }, stopGraceMs)
      force = setTimeout(() => { try { owner.kill('SIGKILL') } catch {} }, stopGraceMs + 3000)
      rejectTimer = setTimeout(() => reject(failure('STOP_UNCONFIRMED', 'Botプロセスの終了を確認できません。ターミナルを確認してください。')), stopGraceMs + 5000)
    })
    phase = 'stopping'; auth = null
    closing = task.finally(() => { closing = null })
    return closing
  }
  async function execute (route, input) {
    if (stopped) throw failure('CLOSED', '管理画面は終了しています。')
    if (route === 'realms') return list(input)
    if (route === 'connect') return connect(input)
    if (route === 'disconnect') {
      inputKeys(input, ['processId', 'session', 'jobId'])
      if (child) {
        if (input.processId !== childId) throw failure('STALE_PROCESS', '起動中のBotが変わりました。状態を更新してください。')
        return stopChild()
      }
      return requestBot({ apiPort, payload: { command: 'disconnect', session: input.session, jobId: input.jobId }, timeoutMs: 30000 })
    }
    if (route === 'quarry') {
      inputKeys(input, ['command', 'session', 'config', 'planToken', 'jobId'])
      if (!['plan', 'start', 'pause', 'resume', 'emergencyStop', 'cancel'].includes(input.command)) throw failure('INVALID_COMMAND', 'この操作は公開されていません。', 400)
      return requestBot({ apiPort, payload: input, timeoutMs: 30000 })
    }
    throw failure('NOT_FOUND', '操作が見つかりません。', 404)
  }
  async function stop () { stopped = true; await stopChild() }
  return { snapshot, execute, stop }
}
module.exports = { createDashboardManager, requestControl, portOccupied, profileName }
