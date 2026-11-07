'use strict'

const path = require('node:path')
function normalize (text, root) {
  let value = String(text ?? '').replaceAll('\\', '/')
  if (root) value = value.replaceAll(path.resolve(root).replaceAll('\\', '/') + '/', '')
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
  const counts = {}
  for (const line of lines) {
    const match = /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)\s*$/.exec(line)
    if (match) counts[match[1]] = Number(match[2])
  }
  if (!Number.isSafeInteger(counts.tests) || !Number.isSafeInteger(counts.fail) || !Number.isSafeInteger(counts.pass) || !/^1\.\.\d+\s*$/m.test(text)) throw new Error('Test report is incomplete; baseline comparison is not valid')
  return { counts, failures }
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
module.exports = { parseTap, compareReports }
