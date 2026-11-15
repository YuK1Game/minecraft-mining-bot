'use strict'
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const Module = require('node:module')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
function collect (directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name)
    return entry.isDirectory() ? collect(filename) : /\.(?:js|cjs|mjs)$/.test(entry.name) ? [filename] : []
  })
}
const files = ['src', 'scripts', 'test', 'dashboard'].flatMap(directory => collect(path.join(root, directory)))
let failed = false
for (const filename of files) {
  // CommonJS files are compiled here exactly as the loader wraps them; one
  // node process per file took about a minute for 700 files.
  if (!filename.endsWith('.mjs')) {
    try { new vm.Script(Module.wrap(fs.readFileSync(filename, 'utf8').replace(/^﻿?#!.*/, '')), { filename }) } catch (error) {
      failed = true
      console.error(`${path.relative(root, filename)}: ${error.stack?.split('\n').slice(0, 6).join('\n') ?? error}`)
    }
    continue
  }
  const result = spawnSync(process.execPath, ['--check', filename], { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) failed = true
}
if (failed) process.exit(1)
const html = fs.readFileSync(path.join(root, 'dashboard/index.html'), 'utf8')
let inline = 0
for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  if (/\bsrc\s*=/.test(match[1]) || /\btype\s*=\s*["']application\/json/.test(match[1])) continue
  new vm.Script(match[2], { filename: `dashboard/index.html:inline-${++inline}` })
}
console.log(`構文確認完了: ${files.length}ファイル + ダッシュボード${inline}スクリプト`)
// Files that already hold too much. Growth is reported on every check so new
// wiring goes to its own module (AGENTS.md); the check itself still passes.
const budget = JSON.parse(fs.readFileSync(path.join(__dirname, 'size-budget.json'), 'utf8'))
for (const [name, limit] of Object.entries(budget.files)) {
  // Counted without carriage returns so Windows and CI checkouts agree.
  const size = Buffer.byteLength(fs.readFileSync(path.join(root, name), 'utf8').replaceAll('\r', ''))
  if (size > limit) console.warn(`サイズ超過: ${name} ${Math.round(size / 1024)}KB（基準 ${Math.round(limit / 1024)}KB、+${Math.round((size - limit) / 1024)}KB）。新しい処理は別モジュールへ。`)
}
