'use strict'
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
function collect (directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name)
    return entry.isDirectory() ? collect(filename) : /\.(?:js|cjs|mjs)$/.test(entry.name) ? [filename] : []
  })
}
const files = ['src', 'scripts', 'test', 'dashboard'].flatMap(directory => collect(path.join(root, directory)))
for (const filename of files) {
  const result = spawnSync(process.execPath, ['--check', filename], { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
const html = fs.readFileSync(path.join(root, 'dashboard/index.html'), 'utf8')
let inline = 0
for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  if (/\bsrc\s*=/.test(match[1]) || /\btype\s*=\s*["']application\/json/.test(match[1])) continue
  new vm.Script(match[2], { filename: `dashboard/index.html:inline-${++inline}` })
}
console.log(`構文確認完了: ${files.length}ファイル + ダッシュボード${inline}スクリプト`)
