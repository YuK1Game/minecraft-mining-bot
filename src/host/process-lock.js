'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function safeProfileName (profile) {
  const cleaned = String(profile || 'main').trim().replace(/[^A-Za-z0-9_-]/g, '_')
  return cleaned || 'main'
}

function lockFilePath (root, profile) {
  return path.resolve(root, '.local', `bot-${safeProfileName(profile)}.lock`)
}

function isProcessAlive (pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function readLockRecord (file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

// Acquires an exclusive per-profile lock file under `.local/` so two Bot
// processes cannot connect to the same Realm with the same Microsoft profile.
function acquireProcessLock ({ root, profile = 'main', pid = process.pid, now = Date.now, isAlive = isProcessAlive } = {}) {
  const file = lockFilePath(root, profile)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const payload = JSON.stringify({
    pid,
    profile: safeProfileName(profile),
    startedAt: new Date(now()).toISOString(),
    hostname: os.hostname()
  }, null, 2) + '\n'

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(file, payload, { flag: 'wx', mode: 0o600 })
      return makeHandle(file, safeProfileName(profile), pid)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const existing = readLockRecord(file)
      if (existing && existing.pid === pid) return makeHandle(file, safeProfileName(profile), pid)
      if (existing && Number.isSafeInteger(existing.pid) && isAlive(existing.pid)) {
        const message = `同じプロフィール (${safeProfileName(profile)}) の Bot がすでに起動しています (PID ${existing.pid}、開始 ${existing.startedAt ?? '不明'})。二重接続を防ぐため起動を中止しました。`
        throw Object.assign(new Error(message), { code: 'BOT_ALREADY_RUNNING', pid: existing.pid, profile: safeProfileName(profile), lockFile: file })
      }
      // Stale or corrupt lock left behind by a crashed process: remove and retry.
      try { fs.unlinkSync(file) } catch (unlinkError) {
        if (unlinkError?.code !== 'ENOENT') throw unlinkError
      }
    }
  }
  throw Object.assign(new Error(`プロセスロックを取得できませんでした: ${file}`), { code: 'BOT_LOCK_FAILED', lockFile: file })
}

function makeHandle (file, profile, pid) {
  let released = false
  function release () {
    if (released) return false
    released = true
    const current = readLockRecord(file)
    if (current && current.pid !== pid) return false
    try {
      fs.unlinkSync(file)
      return true
    } catch {
      return false
    }
  }
  return { file, profile, pid, release }
}

module.exports = { acquireProcessLock, lockFilePath, isProcessAlive, safeProfileName }
