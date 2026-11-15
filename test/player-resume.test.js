'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createPlayerResume, loadPlayingSync } = require('../src/modes/player-resume')

function fixture ({ playing = true, mode = 'player', shared = {} } = {}) {
  const writes = [], logs = []
  let stored = playing
  const resume = createPlayerResume({ file: 'x', shared, getMode: () => mode, log: text => logs.push(text), load: () => stored, write: async (file, value) => { writes.push(value); stored = value.playing }, now: () => 0 })
  return { resume, shared, writes, logs }
}

test('a restarted process in player mode plays on when it was playing', () => {
  const f = fixture()
  assert.equal(f.resume.restore(), true)
  assert.equal(f.shared.playerWanted, true)
  assert.equal(f.shared.safetyWanted, true)
  assert.equal(f.logs.length, 1)
})

test('no resume after a deliberate stop, in quarry mode, or under a managed start', () => {
  for (const options of [{ playing: false }, { mode: 'quarry' }, { shared: { quarryRestoreDisabled: true } }]) {
    const f = fixture(options)
    assert.equal(f.resume.restore(), false)
    assert.equal(f.shared.playerWanted, false)
    assert.equal(f.shared.safetyWanted, undefined)
  }
})

test('a hot reload keeps the current wish instead of the saved one', () => {
  const f = fixture({ shared: { playerWanted: false } })
  assert.equal(f.resume.restore(), false)
  assert.equal(f.shared.playerWanted, false)
})

test('the wish is written only when it changes', async () => {
  const f = fixture({ playing: false })
  f.resume.restore()
  assert.equal(await f.resume.note(), false)
  f.shared.playerWanted = true
  assert.equal(await f.resume.note(), true)
  assert.equal(await f.resume.note(), false)
  f.shared.playerWanted = false
  assert.equal(await f.resume.note(), true)
  assert.deepEqual(f.writes.map(value => value.playing), [true, false])
})

test('a missing or damaged file means not playing', () => {
  assert.equal(loadPlayingSync('x', { io: { readFileSync () { throw new Error('missing') } } }), false)
  assert.equal(loadPlayingSync('x', { io: { readFileSync: () => '{' } }), false)
  assert.equal(loadPlayingSync('x', { io: { readFileSync: () => '{"playing":true}' } }), true)
})
