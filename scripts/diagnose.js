'use strict'

// CLI diagnostic summary (`npm run diagnose [-- --json] [-- --incident=<file>]`).
// Reads local state and incident snapshots safely without touching `.auth/` or `.env`.
const path = require('node:path')
const http = require('node:http')
const { collectDiagnostics, formatDiagnosticsText } = require('../src/common/diagnose-report')

const root = path.resolve(__dirname, '..')
const argValue = prefix => process.argv.find(a => a.startsWith(`--${prefix}=`))?.slice(prefix.length + 3) ?? null
const asJson = process.argv.includes('--json')
const incidentPath = argValue('incident')
const skipLive = process.argv.includes('--offline')

function fetchLocalStatus (port = 3000, timeoutMs = 600) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/status', timeout: timeoutMs }, res => {
      if (res.statusCode !== 200) { res.resume(); resolve(null); return }
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { if (raw.length < 512000) raw += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(raw)) } catch { resolve(null) }
      })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
  })
}

async function main () {
  const liveStatus = skipLive ? null : await fetchLocalStatus()
  const report = collectDiagnostics({ root, incidentPath, liveStatus })
  if (asJson) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(formatDiagnosticsText(report))
  }
}

main().catch(error => {
  console.error(`診断の取得に失敗しました: ${error?.message ?? error}`)
  process.exitCode = 1
})
