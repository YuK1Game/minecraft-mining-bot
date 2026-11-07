'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const source = fs.readFileSync(require.resolve('../src/runtime'), 'utf8')
const start = source.indexOf('  function applyPacket (name, packet, { entityDangerChanged = true } = {}) {')
const end = source.indexOf('  function stopActions (reason)', start)
assert.ok(start >= 0 && end > start)

function fixture (replaying = false) {
  const seen = []
  const boundary = new Error('ordinary packet observers reached')
  const handle = vm.runInNewContext(source.slice(start, end) + '\napplyPacket', {
    disposed: false, disposing: false, replaying,
    mining: { applyPacket: (name, packet) => seen.push({ name, packet }) },
    logCreeperFuse: () => { throw boundary }
  })
  return { handle, seen, boundary }
}

test('whole terrain packets notify mining without cloning buffers or entering unrelated state observers', () => {
  const f = fixture()
  const packet = { get payload () { throw new Error('the terrain payload must stay in World') } }
  for (let i = 0; i < 1000; i++) f.handle(i % 2 ? 'subchunk' : 'level_chunk', packet)
  assert.equal(f.seen.length, 1000)
  assert.ok(f.seen.every(entry => entry.packet === packet))
  const replay = fixture(true)
  replay.handle('subchunk', packet)
  assert.equal(replay.seen.length, 0, 'cache replay is not a fresh mining receipt')
})

test('small block updates continue to the ordinary observers after the immediate mining notification', () => {
  const f = fixture()
  const packet = { position: { x: -49, y: -2, z: 36 } }
  assert.throws(() => f.handle('update_block', packet), error => error === f.boundary)
  assert.equal(f.seen.length, 1)
  assert.equal(f.seen[0].name, 'update_block')
})
