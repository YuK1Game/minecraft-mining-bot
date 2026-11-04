'use strict'

const path = require('node:path')

function loadConfig (env = process.env, root = path.resolve(__dirname, '..')) {
  const profile = env.BOT_PROFILE?.trim() || 'main'
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(profile)) {
    throw new Error('BOT_PROFILE は半角英数字・ハイフン・アンダースコアで指定してください。')
  }
  const realmId = env.REALM_ID?.trim() || undefined
  if (realmId && (!/^\d+$/.test(realmId) || !Number.isSafeInteger(Number(realmId)) || Number(realmId) < 1)) {
    throw new Error('REALM_ID はRealm一覧に表示された正の整数で指定してください。')
  }
  const version = env.MINECRAFT_VERSION?.trim() || undefined
  if (version && !/^1\.\d+\.\d+$/.test(version)) {
    throw new Error('MINECRAFT_VERSION は 1.26.51 のようなライブラリの対応表記で指定してください。')
  }
  const portText = env.API_PORT?.trim() || '3000'
  const port = Number(portText)
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('API_PORT は1〜65535の整数で指定してください。')
  }
  return { profile, realmId, version, port, authDir: path.join(root, '.auth', profile) }
}

module.exports = { loadConfig }
