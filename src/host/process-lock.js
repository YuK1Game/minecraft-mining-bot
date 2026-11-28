'use strict'

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const PID_REUSE_START_DRIFT_MS = 60000

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

function inspectProcessIdentity (pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  try {
    if (process.platform === 'win32') {
      const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue; if (-not $p) { Write-Output 'NONE' } else { $ms = if ($p.CreationDate) { [DateTimeOffset]::new($p.CreationDate).ToUnixTimeMilliseconds() } else { $null }; [pscustomobject]@{ startedAtMs = $ms; commandLine = $p.CommandLine } | ConvertTo-Json -Compress }`
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim()
      if (!out) return null
      if (out === 'NONE') return { exists: false, startedAtMs: null, commandLine: null }
      const parsed = JSON.parse(out)
      return {
        exists: true,
        startedAtMs: Number.isFinite(parsed?.startedAtMs) ? parsed.startedAtMs : null,
        commandLine: typeof parsed?.commandLine === 'string' ? parsed.commandLine : null
      }
    }
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'lstart=,args='], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    if (!out) return { exists: false, startedAtMs: null, commandLine: null }
    const match = out.match(/^([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/)
    const startedAtMs = match ? Date.parse(match[1]) : NaN
    return {
      exists: true,
      startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : null,
      commandLine: match ? match[2] : out
    }
  } catch {
    return null
  }
}

function looksLikeBotCommand (commandLine) {
  if (typeof commandLine !== 'string' || !commandLine.trim()) return null
  const normalized = commandLine.replace(/\\/g, '/').toLowerCase()
  return /(?:^|[\s"'/])src\/main\.js(?:$|[\s"'])/.test(normalized)
}

function isStaleReusedProcess (existing, inspected) {
  if (!inspected) return false
  if (inspected.exists === false) return true
  const lockStartedAtMs = typeof existing?.startedAt === 'string' ? Date.parse(existing.startedAt) : NaN
  if (Number.isFinite(lockStartedAtMs) && Number.isFinite(inspected.startedAtMs)) {
    if (inspected.startedAtMs - lockStartedAtMs > PID_REUSE_START_DRIFT_MS) return true
  }
  const isBot = looksLikeBotCommand(inspected.commandLine)
  if (isBot === false) return true
  return false
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
function acquireProcessLock ({ root, profile = 'main', pid = process.pid, now = Date.now, isAlive = isProcessAlive, inspectProcess = (isAlive === isProcessAlive ? inspectProcessIdentity : () => null) } = {}) {
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
        const inspected = typeof inspectProcess === 'function' ? inspectProcess(existing.pid) : null
        if (!isStaleReusedProcess(existing, inspected)) {
          const message = `同じプロフィール (${safeProfileName(profile)}) の Bot がすでに起動しています (PID ${existing.pid}、開始 ${existing.startedAt ?? '不明'})。二重接続を防ぐため起動を中止しました。`
          throw Object.assign(new Error(message), { code: 'BOT_ALREADY_RUNNING', pid: existing.pid, profile: safeProfileName(profile), lockFile: file })
        }
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

module.exports = { acquireProcessLock, lockFilePath, isProcessAlive, inspectProcessIdentity, isStaleReusedProcess, looksLikeBotCommand, safeProfileName }
