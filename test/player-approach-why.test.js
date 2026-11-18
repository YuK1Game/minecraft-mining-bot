'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { approachWhy } = require('../src/combat/approach-why')

test('a failed approach names what refused its routes and its standing cells', () => {
  const why = approachWhy()
  assert.deepEqual(why.note({ ready: true }), { ready: true })
  why.note({ ready: false, reason: 'Wait for a supported landing before planning' })
  why.note({ ready: false, reason: 'Wait for a supported landing before planning' })
  why.note({ ready: false, reason: 'No safe route found' })
  why.note(null)
  why.stand()
  assert.equal(why.text(), ' (routes 5, no standing 1: Wait for a supported landing before planning x2; No safe route found x1)')
})

test('with nothing tried it still says so', () => {
  assert.equal(approachWhy().text(), ' (routes 0, no standing 0)')
})
