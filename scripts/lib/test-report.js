'use strict'

const path = require('node:path')
// TAP reports may be read on a different OS from the one that produced them.
// Never resolve an already absolute POSIX root through Windows' current drive.
function normalize (text, root) {
  let value = String(text ?? '').replaceAll('\\', '/')
  if (!root) return value
  const supplied = String(root).replaceAll('\\', '/')
  const windows = /^[A-Za-z]:\//.test(supplied) || supplied.startsWith('//')
  const absolute = windows
    ? path.win32.normalize(String(root)).replaceAll('\\', '/')
    : path.posix.isAbsolute(supplied) ? path.posix.normalize(supplied) : path.resolve(root).replaceAll('\\', '/')
  // Node's TAP diagnostic formatter can double the slashes of a Windows path.
  // Normalize just known checkout prefixes; do not alter unrelated paths/URLs.
  const prefix = absolute.replace(/\/$/, '') + '/'
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = windows ? escaped.replaceAll('/', '/+') : escaped
  value = value.replace(new RegExp(pattern, windows ? 'gi' : 'g'), '')
  // Relative Windows source locations also contain doubled separators.
  if (windows && /^(?:test|src|scripts)\//.test(value)) value = value.replace(/\/+/g, '/')
  return value
}
function parseTap (text, { root = '' } = {}) {
  const lines = text.split(/\r?\n/), failures = []
  for (let index = 0; index < lines.length; index++) {
    const match = /^(\s*)not ok \d+ - (.*)$/.exec(lines[index])
    if (!match || / # (?:SKIP|TODO)\b/.test(match[2])) continue
    const indent = match[1].length
    const detail = []
    for (let next = index + 1; next < lines.length; next++) {
      if (new RegExp(`^\\s{0,${indent}}(?:ok |not ok |# Subtest:|1\\.\\.)`).test(lines[next])) break
      detail.push(lines[next])
      if (lines[next].trim() === '...') break
    }
    const field = key => {
      const line = detail.find(line => line.trimStart().startsWith(`${key}: `))
      let value = line?.trim().slice(key.length + 2) ?? ''
      if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).replaceAll("''", "'")
      if (value.startsWith('"') && value.endsWith('"')) { try { value = JSON.parse(value) } catch {} }
      return normalize(value, root)
    }
    const name = normalize(match[2], root)
    const file = (field('location').replace(/:\d+(?::\d+)?$/, '') || (/^test\/.+\.[cm]?js$/.test(name) ? name : 'unknown'))
    const failureType = field('failureType'), code = field('code')
    failures.push({ name, file, failureType, code, key: JSON.stringify([file, name, failureType, code]) })
  }
  // A test file whose process ends early leaves tests that started ("# Subtest")
  // without any result line. They are neither passes nor failures of this run.
  const started = new Map(), reported = new Map()
  const bump = (map, name) => map.set(name, (map.get(name) ?? 0) + 1)
  for (const line of lines) {
    const begin = /^# Subtest: (.*)$/.exec(line), result = begin ? null : /^(?:not ok|ok) \d+ - (.*?)(?: # (?:SKIP|TODO)\b.*)?$/.exec(line)
    if (begin) bump(started, normalize(begin[1], root)); else if (result) bump(reported, normalize(result[1], root))
  }
  const unreported = [...started].filter(([name, count]) => count > (reported.get(name) ?? 0)).map(([name]) => name)
  const counts = {}
  for (const line of lines) {
    const match = /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)\s*$/.exec(line)
    if (match) counts[match[1]] = Number(match[2])
  }
  if (!Number.isSafeInteger(counts.tests) || !Number.isSafeInteger(counts.fail) || !Number.isSafeInteger(counts.pass) || !/^1\.\.\d+\s*$/m.test(text)) throw new Error('Test report is incomplete; baseline comparison is not valid')
  return { counts, failures, unreported, reported: [...reported.keys()] }
}
function compareReports (baseline, current) {
  const allowance = new Map()
  for (const item of baseline.failures) allowance.set(item.key, (allowance.get(item.key) ?? 0) + 1)
  const introduced = []
  for (const item of current.failures) {
    const count = allowance.get(item.key) ?? 0
    if (count) allowance.set(item.key, count - 1)
    else introduced.push(item)
  }
  return { baseline: baseline.counts, current: current.counts, introduced, removedFailureCount: [...allowance.values()].reduce((sum, count) => sum + count, 0) }
}
// Files of new failures for which the baseline run recorded no result at all
// (neither pass nor failure). When a baseline test file ends early, every test
// after that point is missing; the baseline is silent about them, so those
// files need another baseline run before a failure there can be called new.
function baselineGaps (baseline, introduced) {
  const known = new Set(baseline.reported ?? [])
  return [...new Set(introduced.filter(item => !known.has(item.name) && /^test\/.+\.[cm]?js$/.test(item.file)).map(item => item.file))].sort()
}
// Adds the failures of a second run of some files to a report of the whole suite.
function withRerun (report, rerun, files) {
  const again = new Set(files)
  return { ...report, failures: [...report.failures.filter(item => !again.has(item.file)), ...rerun.failures] }
}
module.exports = { parseTap, compareReports, baselineGaps, withRerun }
