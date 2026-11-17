'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { resumeTrip } = require('../src/travel/travel-resume')

test('player play does not resume an ownerless trip', () => {
  assert.equal(resumeTrip({ playerWanted: true }), false)
  assert.equal(resumeTrip({ playerWanted: false }), true)
  assert.equal(resumeTrip({}), true)
})

test('the resume timer drops the saved trip in player play', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/runtime/long-travel-runtime.js'), 'utf8')
  const timer = src.slice(src.indexOf('const travelResumeTimer'), src.indexOf('travelResumeTimer.unref'))
  const drop = timer.indexOf("resumeTrip(rt.host.shared)) rt.host.shared.longTravelResume = null")
  assert.ok(drop > 0)
  assert.ok(drop < timer.indexOf('const r = rt.host.shared.longTravelResume'))
})
