'use strict'

// The complete suite takes minutes, and the comparison ran it twice on every
// push: once on the base commit and once on the change (CI 2026-11-18: 14 to
// 19 minutes for the two runs). The base commit does not change between
// pushes, so its report is kept and read again; and the files of the suite are
// divided into shards that run on separate machines.
// A kept report is used only when it was made for the same commit, shard and
// settings (dependencies, exact Node runtime, concurrency, and the code that
// chooses, runs and reads the tests).
// Anything else is not a report of this comparison and the suite runs again.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const { strictFiles } = require('./test-lanes')

const SELECTION = 'test-families-outside-strict-lanes-v2'
const posix = name => name.split(path.sep).join('/')
const familyOf = file => posix(file).replace(/\.part\d+(?=\.test\.[cm]?js$)/, '')

// 'k/n' (1 <= k <= n <= 16); nothing means the whole suite.
function parseShard (text) {
  if (text == null || String(text).trim() === '') return { index: 1, count: 1 }
  const match = /^(\d+)\/(\d+)$/.exec(String(text).trim())
  const index = Number(match?.[1]), count = Number(match?.[2])
  if (!match || index < 1 || count < 1 || count > 16 || index > count) throw new Error(`SUITE_SHARD must look like 1/3, got ${JSON.stringify(text)}`)
  return { index, count }
}
// All parts of a file stay together. Their tests are assigned by ordinal, so
// inserting one test can move an existing failure to another part. Splitting
// those parts between CI shards would make that old failure look new.
const shardOf = (file, count) => crypto.createHash('md5').update(`suite:${familyOf(file)}`).digest().readUInt32BE(0) % count + 1

// A result names the file that registered the test, not its part wrapper.
// Rerunning that file alone runs only its first part; include every sibling
// part on the side being rerun (the base can have a different part count).
function expandTestFiles (directory, files) {
  const out = new Set()
  for (const file of files) {
    const family = familyOf(file), folder = path.posix.dirname(family)
    let entries
    try { entries = fs.readdirSync(path.join(directory, folder), { withFileTypes: true }) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    for (const entry of entries) {
      const candidate = `${folder}/${entry.name}`
      if ((entry.isFile() || entry.isSymbolicLink()) && familyOf(candidate) === family) out.add(candidate)
    }
  }
  return [...out].sort()
}

// Every *.test.js (.cjs, .mjs) under test/ that no strict lane runs, sorted,
// relative to the directory, with forward slashes. The strict lanes (review,
// player) fail on any failure and run beside the comparison, so their files
// are not run here again. The rules of the lanes are those of the code doing
// the comparison, applied to the files of each side: the base and the change
// are chosen the same way.
function testFiles (directory) {
  const strict = strictFiles(directory)
  const out = []
  const walk = relative => {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      const name = `${relative}/${entry.name}`
      if (entry.isDirectory()) walk(name); else if (/\.test\.[cm]?js$/.test(entry.name) && !strict.has(name)) out.push(name)
    }
  }
  if (fs.existsSync(path.join(directory, 'test'))) walk('test')
  return out.sort()
}
const shardFiles = (directory, shard) => testFiles(directory).filter(file => shardOf(file, shard.count) === shard.index)

// 'blocking-pipes-v1': how the suite's output is collected (blocking-output.js).
// A report made before that can lack tests, so it is not read again.
const OUTPUT = 'blocking-pipes-v1'
const digest = value => crypto.createHash('sha256').update(value).digest('hex')
function filesDigest (directory, files) {
  return digest(JSON.stringify(files.map(file => {
    try { return [file, fs.readFileSync(path.join(directory, file), 'utf8').replace(/\r\n/g, '\n')] } catch (error) { if (error.code === 'ENOENT') return [file, null]; throw error }
  })))
}
// A fresh baseline shares the current node_modules. A report made with older
// dependencies, selection rules or runtime flags cannot stand in for that run.
const settingsOf = ({ concurrency, shard, directory = path.resolve(__dirname, '../..') }) => ({
  selection: SELECTION, output: OUTPUT, node: process.versions.node, platform: process.platform, arch: process.arch,
  concurrency, shard: `${shard.index}/${shard.count}`, nodeOptions: digest(process.env.NODE_OPTIONS ?? ''),
  dependencies: filesDigest(directory, ['package.json', 'package-lock.json', 'npm-shrinkwrap.json']),
  implementation: filesDigest(directory, ['scripts/lib/test-lanes.js', 'scripts/lib/suite-store.js', 'scripts/lib/test-report.js', 'scripts/compare-tests.js', 'scripts/lib/blocking-output.js'])
})
const settingsKey = settings => digest(JSON.stringify(settings))
const fileOf = (directory, sha, shard) => path.join(directory, `${sha}.${shard.index}of${shard.count}.json`)
const sound = report => Number.isSafeInteger(report?.counts?.tests) && Number.isSafeInteger(report?.counts?.fail) && Array.isArray(report?.failures) && Array.isArray(report?.reported) && Array.isArray(report?.unreported)

// The kept report of that commit, or null (none, unreadable, another commit, other settings).
function readStored (directory, sha, settings) {
  if (!directory) return null
  let stored
  try { stored = JSON.parse(fs.readFileSync(fileOf(directory, sha, parseShard(settings.shard)), 'utf8')) } catch { return null }
  if (stored?.sha !== sha || JSON.stringify(stored.settings) !== JSON.stringify(settings) || !sound(stored.report)) return null
  return { report: stored.report, savedAt: stored.savedAt ?? null }
}
function writeStored (directory, sha, settings, report, now = new Date()) {
  if (!directory || !sound(report)) return false
  fs.mkdirSync(directory, { recursive: true })
  const file = fileOf(directory, sha, parseShard(settings.shard)), temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, JSON.stringify({ sha, settings, savedAt: now.toISOString(), report }) + '\n')
  fs.renameSync(temporary, file)
  return true
}
// Reports of other commits are removed, so the kept directory does not grow with every commit.
function prune (directory, keep) {
  if (!directory || !fs.existsSync(directory)) return []
  const wanted = new Set(keep.filter(Boolean)), removed = []
  for (const name of fs.readdirSync(directory)) {
    const match = /^([0-9a-f]{40})\.\d+of\d+\.json$/.exec(name)
    if (match && !wanted.has(match[1])) { fs.rmSync(path.join(directory, name), { force: true }); removed.push(name) }
  }
  return removed
}

module.exports = { parseShard, shardOf, testFiles, shardFiles, expandTestFiles, settingsOf, settingsKey, readStored, writeStored, prune }
