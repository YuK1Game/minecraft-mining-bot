'use strict'

// Compare the complete legacy suite at the same Node version/dependencies.
// Known baseline failures remain visible; this gate rejects *new* failures.
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { spawn, execFileSync } = require('node:child_process')
const { createWriteStream } = require('node:fs')
const { finished } = require('node:stream/promises')
const { parseTap, compareReports } = require('./lib/test-report')
const root = path.resolve(__dirname, '..')
async function runSuite (directory, filename) {
  const output = createWriteStream(filename, { flags: 'w' })
  const child = spawn(process.execPath, ['--test', '--test-concurrency=2', '--test-timeout=30000', '--test-reporter=tap'], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pipe(output, { end: false }); child.stderr.pipe(output, { end: false })
  const timeout = setTimeout(() => child.kill('SIGTERM'), 12 * 60 * 1000)
  let code
  try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (value, signal) => signal ? reject(new Error(`Test suite terminated: ${signal}`)) : resolve(value)) }) } finally { clearTimeout(timeout); output.end(); await finished(output) }
  const report = parseTap(await fs.readFile(filename, 'utf8'), { root: directory })
  if (![0, 1].includes(code) || code !== 0 && report.failures.length === 0) throw new Error(`Test process failed without an attributable test failure (${code})`)
  return report
}
async function main () {
  const supplied = process.argv[2] || process.env.CI_BASE_SHA
  const ref = supplied && /^[0-9a-f]{40}$/i.test(supplied) && !/^0+$/.test(supplied) ? supplied : execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], { cwd: root, encoding: 'utf8' }).trim()
  const base = execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: root, encoding: 'utf8' }).trim()
  const reports = path.resolve(root, 'test-results')
  await fs.mkdir(reports, { recursive: true })
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-baseline-'))
  const worktree = path.join(temporary, 'repo')
  let attached = false
  try {
    execFileSync('git', ['worktree', 'add', '--detach', worktree, base], { cwd: root, stdio: 'inherit' }); attached = true
    await fs.symlink(path.join(root, 'node_modules'), path.join(worktree, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    console.log(`Full suite baseline: ${base}; Node ${process.version}`)
    const baseline = await runSuite(worktree, path.join(reports, 'baseline.tap'))
    const current = await runSuite(root, path.join(reports, 'current.tap'))
    const comparison = { base, node: process.version, ...compareReports(baseline, current) }
    await fs.writeFile(path.join(reports, 'comparison.json'), JSON.stringify(comparison, null, 2) + '\n')
    console.log(JSON.stringify(comparison, null, 2))
    if (baseline.failures.length) console.warn(`Known baseline failures: ${baseline.failures.length}. A green regression comparison is NOT a fully passing legacy suite.`)
    if (comparison.introduced.length) process.exitCode = 1
  } finally {
    // Unlink the node_modules junction first: on Windows a recursive removal
    // of the temporary worktree followed it and emptied the real node_modules
    // (2026-11-09). Only the link is removed, never its target.
    await fs.unlink(path.join(worktree, 'node_modules')).catch(() => {})
    if (attached) execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: root, stdio: 'inherit' })
    await fs.rm(temporary, { recursive: true, force: true })
  }
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1 })
module.exports = { runSuite }
