'use strict'

// IPC only: stdout is never parsed for account information or commands.
const { displayText } = require('./realms')
const CHANNEL = 'minecraft-dashboard-v1'
const realmId = value => typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value))
function publicRealms (realms) {
  if (!Array.isArray(realms)) throw new Error('Realm一覧を取得できませんでした。')
  return realms.slice(0, 200).filter(r => realmId(String(r?.id))).map(r => ({ id: String(r.id), name: displayText(r.name) || '(名前なし)', state: displayText(r.state), expired: r.expired === true, available: r.expired !== true && r.state === 'OPEN' }))
}
function publicAuth (data, now = Date.now()) {
  if (typeof data?.user_code !== 'string' || !/^[A-Za-z0-9 -]{4,32}$/.test(data.user_code)) return null
  const seconds = Number.isFinite(data.expires_in) ? Math.min(900, Math.max(1, data.expires_in)) : 900
  return { code: data.user_code, url: 'https://www.microsoft.com/link', expiresAt: now + seconds * 1000 }
}
function connectionFailure (error) {
  if (error?.code === 'REALM_JOIN_UNAVAILABLE' && error.statusCode === 503) return 'Realmsの参加先取得が一時的に利用できません（HTTP 503）。再試行の上限に達しました。時間をおいて一覧取得からやり直してください。'
  if (error?.code === 'REALM_JOIN_FAILED' && Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode <= 599) return `Realmsの参加先取得に失敗しました（HTTP ${error.statusCode}）。`
  return 'Botの接続処理に失敗しました。ターミナルのエラーを確認してください。'
}
function createDashboardSession ({ channel = process, onStop, getRealms, selectionTimeoutMs = 900000 }) {
  let selection = null, stopped = false, refreshing = false
  const send = payload => { if (!stopped && channel.connected && typeof channel.send === 'function') { try { channel.send({ channel: CHANNEL, ...payload }, () => {}) } catch {} } }
  const stop = () => {
    if (stopped) return
    stopped = true
    if (selection) { clearTimeout(selection.timer); selection.reject(Object.assign(new Error('ワールド選択を中止しました。'), { code: 'CANCELLED' })); selection = null }
    void Promise.resolve().then(onStop).catch(() => {})
  }
  const publish = () => send({ type: 'realms', realms: publicRealms(selection.realms) })
  async function receive (message) {
    if (stopped || message?.channel !== CHANNEL) return
    if (message.type === 'stop') { stop(); return }
    if (!selection) return
    if (message.type === 'refresh' && !refreshing) {
      const owner = selection
      refreshing = true
      try {
        const realms = await getRealms()
        if (selection === owner && !stopped) { owner.realms = realms; publish() }
      } catch { if (selection === owner && !stopped) { publish(); send({ type: 'error', message: 'ワールド一覧を更新できませんでした。切断して認証からやり直してください。' }) } } finally { refreshing = false }
    } else if (message.type === 'connect' && !refreshing) {
      const realm = realmId(message.realmId) && selection.realms.find(r => String(r.id) === message.realmId)
      if (!realm || realm.expired || realm.state !== 'OPEN') { publish(); send({ type: 'error', message: '参加可能なワールドを一覧から選択してください。' }); return }
      const owner = selection; selection = null; clearTimeout(owner.timer)
      send({ type: 'connecting', realm: publicRealms([realm])[0] })
      owner.resolve(realm)
    }
  }
  const listener = message => { void receive(message).catch(() => send({ type: 'error', message: 'ワールド選択に失敗しました。' })) }
  channel.on('message', listener); channel.on('disconnect', stop)
  function selectRealm (realms) {
    if (stopped || selection) return Promise.reject(new Error('ワールド選択は既に終了、または実行中です。'))
    return new Promise((resolve, reject) => {
      selection = { realms, resolve, reject, timer: setTimeout(stop, selectionTimeoutMs) }
      publish()
    })
  }
  return { selectRealm, auth: data => send({ type: 'auth', auth: publicAuth(data) }), failed: error => send({ type: 'error', message: connectionFailure(error) }),
    dispose: () => { stopped = true; if (selection) { clearTimeout(selection.timer); selection.reject(Object.assign(new Error('CANCELLED'), { code: 'CANCELLED' })); selection = null } channel.off('message', listener); channel.off('disconnect', stop) } }
}
module.exports = { CHANNEL, realmId, publicRealms, publicAuth, createDashboardSession }
