'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { gatherBoatLogs } = require('../src/travel/travel-boat-wood')

test('player play does not cut logs for a travel boat', () => {
  assert.equal(gatherBoatLogs({ playerWanted: true }), false)
  assert.equal(gatherBoatLogs({ playerWanted: false }), true)
  assert.equal(gatherBoatLogs({}), true)
})

test('travelMakeBoat asks before gathering logs', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/runtime/long-travel-runtime.js'), 'utf8')
  const body = src.slice(src.indexOf('  async function travelMakeBoat (signal) {'))
  assert.match(body.slice(0, 1500), /gatherBoatLogs\(rt\.host\.shared\)\) \{ await rt\.operations\.quarry\.prepGather\(\{ logs: 3/)
})
