'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const source = path.resolve(__dirname, '..', 'src')
for (const filename of fs.readdirSync(source).filter(name => name.endsWith('.js'))) {
  const result = spawnSync(process.execPath, ['--check', path.join(source, filename)], { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
console.log('全ソースの構文確認が完了しました。')
