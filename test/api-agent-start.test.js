'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createApi } = require('../src/api')

test('agent start awaits asynchronous initialization and returns its real status or error', async t => {
  const api = createApi({ snapshot: () => ({}), disconnect: () => {}, agent: { start: async options => { if (options.fail) throw new Error('cannot start'); return { phase: 'running', goal: options.objective } } } })
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => api.close(resolve)))
  const url = `http://127.0.0.1:${api.address().port}/agent/start`
  const post = body => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const success = await post({ objective: 'diamond' })
  assert.equal(success.status, 202)
  assert.deepEqual(await success.json(), { phase: 'running', goal: 'diamond' })
  const failure = await post({ fail: true })
  assert.equal(failure.status, 400)
  assert.deepEqual(await failure.json(), { error: 'cannot start' })
})
