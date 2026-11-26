'use strict'

// Converts a captured `.local/incidents/*.json` snapshot into a normalized
// fixture JSON and a ready-to-run `node:test` scaffold.
// Usage:
//   npm run incident:fixture -- [--incident=<path>] [--slug=<name>] [--write]
const fs = require('node:fs')
const path = require('node:path')
const { listIncidents } = require('../src/common/diagnose-report')
const { normalizeIncidentFixture, buildIncidentTestSource } = require('../src/modes/incident-replay')

const root = path.resolve(__dirname, '..')
const argValue = prefix => process.argv.find(a => a.startsWith(`--${prefix}=`))?.slice(prefix.length + 3) ?? null

const incidentArg = argValue('incident')
const chosen = incidentArg ? path.resolve(root, incidentArg) : listIncidents(root).at(-1) ?? null
if (!chosen || !fs.existsSync(chosen)) {
  console.error('対象のインシデントファイルが見つかりません（--incident=<path> で指定するか .local/incidents/ を確認してください）。')
  process.exit(1)
}

const rawDoc = JSON.parse(fs.readFileSync(chosen, 'utf8'))
const fixture = normalizeIncidentFixture(rawDoc)
const defaultSlug = path.basename(chosen, '.json').toLowerCase().replace(/[^a-z0-9_-]+/g, '-')
const slug = (argValue('slug') ?? defaultSlug).replace(/[^A-Za-z0-9_-]+/g, '-')
const fixtureRelFromTest = `./fixtures/incident-${slug}.json`
const testSource = buildIncidentTestSource({ fixtureRelPath: fixtureRelFromTest, slug, doc: fixture })

if (process.argv.includes('--write')) {
  const fixturePath = path.join(root, 'test', 'fixtures', `incident-${slug}.json`)
  const testPath = path.join(root, 'test', `player-incident-${slug}.test.js`)
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true })
  fs.writeFileSync(fixturePath, JSON.stringify(fixture, null, 2) + '\n')
  fs.writeFileSync(testPath, testSource)
  console.log(JSON.stringify({ written: true, fixture: path.relative(root, fixturePath), test: path.relative(root, testPath) }, null, 2))
} else {
  console.log(testSource)
}
