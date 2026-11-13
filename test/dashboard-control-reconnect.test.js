'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createDashboardManager } = require('../scripts/lib/dashboard-control')
const { CHANNEL } = require('../src/dashboard-session')

// Live 2026-11-13 16:03: the server closed the connection of the dashboard's
// bot and nothing reconnected it. Unexpected exits now reconnect to the same
// world (bounded backoff); dashboard disconnects and clean exits never do.
function fixture (t) {
  const spawns = [], children = [], timers = []
  let clock = 0
  const manager = createDashboardManager({ workspaceRoot: '/test/work', apiPort: 3000, occupied: async () => false, now: () => clock,
    requestBot: async () => { throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' }) },
    setTimer: (fn, ms) => { const timer = { fn, at: clock + ms, cleared: false, unref () {} }; timers.push(timer); return timer },
    clearTimer: timer => { if (timer) timer.cleared = true },
    spawnBot: (...args) => {
      spawns.push(args); const child = new EventEmitter(); children.push(child)
      child.connected = true; child.messages = []
      child.send = (message, cb) => { child.messages.push(message); cb?.(); if (message.type === 'stop') setImmediate(() => child.emit('close', 0)) }
      child.kill = () => child.emit('close', 1)
      return child
    } })
  t.after(() => manager.stop())
  const last = () => children[children.length - 1]
  const realms = () => last().emit('message', { channel: CHANNEL, type: 'realms', realms: [{ id: '21225335', name: 'w', state: 'OPEN' }] })
  const fire = async () => { const timer = timers.filter(x => !x.cleared && !x.fired).sort((a, b) => a.at - b.at)[0]; if (!timer) return null; clock = timer.at; timer.fired = true; timer.fn(); await new Promise(r => setImmediate(r)); return timer }
  const connected = async () => { await manager.execute('realms', {}); realms(); const s = await manager.snapshot(); await manager.execute('connect', { processId: s.processId, realmId: '21225335' }) }
  return { manager, spawns, children, timers, last, realms, fire, connected, advance: ms => { clock += ms } }
}

test('an unexpected exit relaunches with restore allowed and rejoins the same world', async t => {
  const f = fixture(t)
  await f.connected()
  assert.equal(f.spawns[0][2].env.DASHBOARD_RESTORE_QUARRY, '', 'a UI connect never restores digging')
  f.last().emit('close', 1)
  assert.equal((await f.manager.snapshot()).reconnect.pending, true)
  await f.fire()
  assert.equal(f.spawns.length, 2)
  assert.equal(f.spawns[1][2].env.DASHBOARD_RESTORE_QUARRY, '1')
  f.realms()
  assert.deepEqual(f.last().messages.at(-1), { channel: CHANNEL, type: 'connect', realmId: '21225335' })
})

test('backoff doubles and at most five reconnects run in ten minutes', async t => {
  const f = fixture(t)
  await f.connected()
  const delays = []
  for (let i = 0; i < 6; i++) {
    f.last().emit('close', 1)
    const pending = f.timers.filter(x => !x.cleared && !x.fired)
    if (!pending.length) break
    delays.push(pending[0].at - (pending[0].at - 0))
    const before = f.spawns.length
    const timer = await f.fire()
    delays[delays.length - 1] = timer.at
    if (f.spawns.length > before) f.realms()
  }
  assert.equal(f.spawns.length, 6, 'one launch plus five reconnects')
  assert.match((await f.manager.snapshot()).message, /上限/)
})

test('a dashboard disconnect or a clean exit never reconnects', async t => {
  const f = fixture(t)
  await f.connected()
  const s = await f.manager.snapshot()
  await f.manager.execute('disconnect', { processId: s.processId })
  assert.equal(f.timers.filter(x => !x.cleared).length >= 0, true)
  assert.equal(await f.fire(), null)
  assert.equal(f.spawns.length, 1)
  await f.connected()
  f.last().emit('close', 0)
  assert.equal(await f.fire(), null)
  assert.equal(f.spawns.length, 2)
})
