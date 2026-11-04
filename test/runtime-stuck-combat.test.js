'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const { createMovement } = require('../src/movement')
const filename = path.resolve(__dirname, 'runtime-user-behaviors.test.js'), loaded = new Module(filename, module)
loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename))
let source = fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0]
source = source.replace("  let worldReads = 0,", "  let safetyOptions = null; const safetyStatus = { running: true, busy: false, phase: 'emergency_retry', lastResult: { action: 'escape', reason: 'no_known_away_route' } };\n  let worldReads = 0,")
source = source.replace(/^    '\.\/idle-safety': .+$/m, "    './idle-safety': { createIdleSafety: options => { safetyOptions = options; return { snapshot: () => structuredClone(safetyStatus), start: () => { safetyStatus.running = true }, stop: async () => { safetyStatus.running = false }, drain: async () => {}, requestWorkClearance: () => ({ pending: false }) } } },")
source = source.replace('return { runtime, host, raw,', 'return { safetyStatus, getSafetyOptions: () => safetyOptions, runtime, host, raw,')
loaded._compile(source + '\nmodule.exports = { scene };', filename)
const { scene } = loaded.exports
function setup (t, options) {
  const f = scene(t, options); f.shared.autoWanted = true; f.shared.userBehaviorsEnabled = true
  const target = { runtimeId: '70', uniqueId: '-700', kind: 'mob', entityType: 'minecraft:skeleton', hostile: true, alive: true, positionKnown: true, dimension: 'overworld', position: { x: 10.5, y: 65, z: 0.5 } }
  f.actors.push(target)
  const observe = () => f.getSafetyOptions().getState(), allowed = () => f.facadeOptions.coordinatorOptions.canAcquireMeleeApproach(structuredClone(target), f.facadeOptions.getState())
  return { ...f, target, observe, allowed }
}
test('Runtime stuck admission reuses a recent canonical observation with no new terrain rays', t => {
  const f = setup(t); assert.equal(f.allowed(), false); f.observe(); const reads = f.worldReads()
  assert.equal(f.allowed(), true); assert.equal(f.worldReads(), reads)
  const stamp = Date.now(), mockedNow = t.mock.method(Date, 'now', () => stamp + 501)
  assert.equal(f.allowed(), false); mockedNow.mock.restore()
  f.safetyStatus.phase = 'observing'; assert.equal(f.allowed(), false); f.safetyStatus.phase = 'emergency_retry'
  f.safetyStatus.lastResult.reason = 'no_known_escape_origin'; assert.equal(f.allowed(), false); f.safetyStatus.lastResult.reason = 'no_known_away_route'
  f.raw.inventory.items = [{ name: 'minecraft:bow', count: 1 }, { name: 'minecraft:arrow', count: 1 }]; assert.equal(f.allowed(), false); f.raw.inventory.items = []
  f.actors.push({ ...f.target, runtimeId: '71', uniqueId: '-701', positionKnown: false, position: null }); assert.equal(f.allowed(), false); f.actors.pop()
  f.target.position.x += 0.1; assert.equal(f.allowed(), false); f.target.position.x -= 0.1
  f.target.position.x = 22.5; f.observe(); assert.equal(f.allowed(), false, 'outside canonical danger is never a stuck-fight admission'); f.target.position.x = 10.5; f.observe()
  f.shared.autoWanted = false; assert.equal(f.allowed(), false); f.shared.autoWanted = true
  f.shared.deathRespawn.deathId++; assert.equal(f.allowed(), false)
})
async function nativeRelay (t, mode = 'known', distance = 10) {
  const f = setup(t, { nativeStanding: true }); f.target.position.x = f.raw.position.x + distance
  const ctx = { kind: 'combat', claimId: 'combat:1', scope: f.scope() }; ctx.token = await f.facadeOptions.acquireControl(ctx)
  const starts = [], previews = []; const getBlock = f.host.world.getBlock
  let invalidate = false
  f.host.world.getBlock = (x, y, z) => invalidate && x >= 1 && x <= 6 && (mode === 'unknown' && y >= 64 && y <= 67 || mode === 'body' && y >= 65 && y <= 66) ? mode === 'unknown' ? { known: false } : getBlock(x, 64, z) : getBlock(x, y, z)
  const probe = createMovement({ client: { queue: () => assert.fail('route proof must stay passive') }, getState: () => f.facadeOptions.getState(), world: f.host.world, version: '1.26.60', startGame: f.host.meta.startGame, startGameReceivedAt: 0 })
  t.after(() => probe.stop())
  f.mockMovement.preview = (target, options) => { previews.push({ target, options }); const route = probe.preview(target, options); if (mode !== 'known' && options.maxDistance === 12) invalidate = true; return route }
  f.mockMovement.start = (target, options) => { starts.push({ target, options }); f.setMovement({ phase: 'awaiting_server_confirmation', running: false, sent: 0 }); return f.mockMovement.snapshot() }
  const result = await f.facadeOptions.approach(structuredClone(f.target), ctx)
  return { f, result, starts, previews }
}
test('Runtime relays an actual known Native route to a full-supported waypoint within6 without claiming enemy arrival', async t => {
  const { result, starts, previews } = await nativeRelay(t)
  assert.equal(result.code, 'PARTIAL_APPROACH'); assert.equal(result.targetReached, false); assert.equal(result.serverConfirmed, false); assert.equal(starts.length, 1)
  assert.ok(Math.hypot(starts[0].target.x - 0.5, starts[0].target.y - 65, starts[0].target.z - 0.5) <= 6)
  assert.ok(previews.some(p => p.options.maxDistance === 12)); assert.equal(starts[0].options.maxDistance, 6)
})
test('a distant standoff needs only a known Native intermediate step and honestly remains partial', async t => {
  const { result, starts } = await nativeRelay(t, 'known', 16)
  assert.equal(result.code, 'PARTIAL_APPROACH'); assert.equal(result.targetReached, false); assert.equal(starts.length, 1); assert.ok(starts[0].target.x > 0.5 && starts[0].target.x <= 6.5)
})
for (const mode of ['unknown', 'body']) {
  test(`${mode} terrain after full-route preview prevents every relay movement`, async t => {
    const { result, starts } = await nativeRelay(t, mode)
    assert.equal(result.ready, false, mode); assert.equal(starts.length, 0, mode)
  })
}
