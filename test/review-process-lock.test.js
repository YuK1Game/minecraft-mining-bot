'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { acquireProcessLock, lockFilePath } = require('../src/host/process-lock')

function tempRoot (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmb-lock-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('process-lock: acquires exclusive lock per profile and releases cleanly', t => {
  const root = tempRoot(t)
  const lock = acquireProcessLock({ root, profile: 'main', pid: 41001, isAlive: () => true })
  assert.equal(lock.file, lockFilePath(root, 'main'))
  assert.equal(fs.existsSync(lock.file), true)

  // A different profile can run simultaneously.
  const other = acquireProcessLock({ root, profile: 'alt_bot', pid: 41002, isAlive: () => true })
  assert.equal(fs.existsSync(other.file), true)

  assert.equal(lock.release(), true)
  assert.equal(fs.existsSync(lock.file), false)
  assert.equal(other.release(), true)
})

test('process-lock: blocks duplicate startup while owning PID is alive', t => {
  const root = tempRoot(t)
  const first = acquireProcessLock({ root, profile: 'HouchiChan', pid: 52001, isAlive: pid => pid === 52001 })
  assert.throws(
    () => acquireProcessLock({ root, profile: 'HouchiChan', pid: 52002, isAlive: pid => pid === 52001 }),
    error => error.code === 'BOT_ALREADY_RUNNING' && error.pid === 52001
  )
  first.release()
})

test('process-lock: recovers stale or corrupt lock files left by dead processes', t => {
  const root = tempRoot(t)
  const file = lockFilePath(root, 'main')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ pid: 999999, profile: 'main', startedAt: '2026-11-24T00:00:00.000Z' }))

  const acquired = acquireProcessLock({ root, profile: 'main', pid: 63001, isAlive: () => false })
  assert.equal(acquired.pid, 63001)
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(saved.pid, 63001)
  acquired.release()

  // Corrupt lock file also recovers cleanly.
  fs.writeFileSync(file, '{not-json')
  const recovered = acquireProcessLock({ root, profile: 'main', pid: 63002, isAlive: () => true })
  assert.equal(recovered.pid, 63002)
  recovered.release()
})
