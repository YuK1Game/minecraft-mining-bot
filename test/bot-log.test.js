'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createBotLog } = require('../src/host/bot-log')

test('createBotLog writes JST-formatted lines to output and liveLog file', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-log-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'bot.log')
  const output = []
  const { log, liveLog } = createBotLog({
    file,
    now: () => Date.UTC(2026, 10, 25, 2, 45, 0, 123),
    output: line => output.push(line)
  })
  log('Bot の作業ログ')
  await liveLog.close()
  assert.deepEqual(output, ['[11:45:00.123 JST] Bot の作業ログ'])
  assert.equal((await fs.readFile(file, 'utf8')).trim(), '[11:45:00.123 JST] Bot の作業ログ')
})
