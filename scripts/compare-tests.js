'use strict'

// Compare the complete legacy suite at the same Node version/dependencies.
// Known baseline failures remain visible; this gate rejects *new* failures.
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { spawn, execFileSync } = require('node:child_process')
const { createWriteStream, existsSync } = require('node:fs')
const { finished } = require('node:stream/promises')
const { parseTap, compareReports, baselineGaps, withRerun, confirmedByRerun } = require('./lib/test-report')
const root = path.resolve(__dirname, '..')
// Both runs use the same settings, so the comparison stays like for like.
const CONCURRENCY = Math.max(2, Math.min(8, os.availableParallelism()))
const SUITE_LIMIT_MS = 25 * 60 * 1000
// 2026-11-15: a run on CI ended normally but its report had no totals (the
// forced exit after the last test can cut the reporter's final output). Such
// a run says nothing, so it is repeated once before the comparison gives up.
async function runSuite (directory, filename, files = []) {
  try { return await runSuiteOnce(directory, filename, files) } catch (error) {
    if (!/Test report is incomplete/.test(String(error?.message))) throw error
    console.warn(`The report ${path.basename(filename)} has no totals; running that suite once more`)
    return runSuiteOnce(directory, filename, files)
  }
}
async function runSuiteOnce (directory, filename, files = []) {
  const output = createWriteStream(filename, { flags: 'w' })
  // Failed legacy tests can leave intervals/polling alive. Preserve their
  // reported failures and timeouts, then exit after all test results exist.
  const child = spawn(process.execPath, ['--test', '--test-force-exit', `--test-concurrency=${CONCURRENCY}`, '--test-timeout=30000', '--test-reporter=tap', ...files], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pipe(output, { end: false }); child.stderr.pipe(output, { end: false })
  let expired = false
  const timeout = setTimeout(() => { expired = true; child.kill('SIGTERM') }, SUITE_LIMIT_MS)
  let code
  try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (value, signal) => signal ? reject(new Error(`Test suite terminated: ${signal}`)) : resolve(value)) }) } finally { clearTimeout(timeout); output.end(); await finished(output) }
  // The suite outgrew the earlier 12-minute cap (2026-11-14): the kill left a
  // report without totals and every run failed as "incomplete". Say so plainly.
  if (expired) throw new Error(`Test suite did not finish within ${SUITE_LIMIT_MS / 60000} minutes (concurrency ${CONCURRENCY}); no comparison was made`)
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
    let baseline = await runSuite(worktree, path.join(reports, 'baseline.tap'))
    const current = await runSuite(root, path.join(reports, 'current.tap'))
    // 2026-11-14: a baseline test file ended early, eight of its long-failing
    // tests had no result, and the same failures in the current run were
    // counted as new. A file with such a gap is run once more on the baseline
    // alone; a file the baseline does not have keeps its failures as new.
    const rerunFiles = baselineGaps(baseline, compareReports(baseline, current).introduced).filter(file => existsSync(path.join(worktree, file)))
    if (rerunFiles.length) {
      console.warn(`Baseline recorded no result for tests in ${rerunFiles.length} file(s); running them again on the baseline: ${rerunFiles.join(', ')}`)
      baseline = withRerun(baseline, await runSuite(worktree, path.join(reports, 'baseline-rerun.tap'), rerunFiles), rerunFiles)
    }
    const comparison = { base, node: process.version, ...compareReports(baseline, current), baselineRerunFiles: rerunFiles, currentUnreported: current.unreported, passedWhenRunAgain: [] }
    // 2026-11-15: one timing-sensitive test failed under four workers in the
    // current run only and turned the gate red; it passes when run alone. A
    // new failure is confirmed by running its file once more on the current
    // code: a test that fails again, or has no result there, stays new.
    const suspectFiles = [...new Set(comparison.introduced.map(item => item.file).filter(file => /^test\/.+\.[cm]?js$/.test(file) && existsSync(path.join(root, file))))].sort()
    if (suspectFiles.length) {
      console.warn(`Running ${suspectFiles.length} file(s) with new failures once more on the current code: ${suspectFiles.join(', ')}`)
      const settled = confirmedByRerun(comparison.introduced, await runSuite(root, path.join(reports, 'current-rerun.tap'), suspectFiles))
      comparison.introduced = settled.confirmed; comparison.passedWhenRunAgain = settled.passed
    }
    if (current.unreported.length) console.warn(`Current run recorded no result for ${current.unreported.length} started test(s); a failure among them would not be seen: ${current.unreported.slice(0, 10).join(' | ')}`)
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
