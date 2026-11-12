'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const { main } = require('../scripts/reset-loadout')
const filename = require.resolve('./loadout-control.test.js'), script = fs.readFileSync(filename, 'utf8')
const first = script.indexOf('function cli () {'), last = script.indexOf("\ntest('loadout-cli:", first)
assert.ok(first >= 0 && last > first)
const loaded = new Module(filename, module)
loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename))
loaded._compile("const { summary } = require('../src/quarry-v22-reset')\n" + script.slice(first, last) + '\nmodule.exports = { cli }\n', filename)
const { cli } = loaded.exports
const commands = f => f.requests.filter(Boolean)

for (const [name, mutate] of [
  ['missing proof', f => { delete f.state.positionProof }],
  ['unconfirmed proof', f => { f.state.positionProof.confirmed = false }],
  ['wrong session', f => { f.state.positionProof.session = 'other-session' }],
  ['prediction source', f => { f.state.positionProof.source = 'client_position_prediction' }],
  ['unknown source', f => { f.state.positionProof.source = 'unknown' }],
  ['nonfinite feet', f => { f.state.positionProof.feet.x = NaN }],
  ['missing radius', f => { delete f.state.positionProof.radius }],
  ['negative radius', f => { f.state.positionProof.radius = -1 }],
  ['oversized radius', f => { f.state.positionProof.radius = 2 }],
  ['lower boundary overlap', f => { f.state.positionProof.feet.x = .1 }],
  ['upper boundary overlap', f => { f.state.positionProof.feet.x = 15.9 }],
  ['negative boundary overlap', f => { f.state.positionProof.feet.x = -.1 }],
  ['missing generation', f => { delete f.state.positionProof.generation }],
  ['negative generation', f => { f.state.positionProof.generation = -1 }],
  ['unknown observation time', f => { f.state.positionProof.observedAt = 'unknown' }],
  ['future observation time', f => { f.state.positionProof.observedAt = Date.now() + 60000 }]
]) test(`loadout CLI refuses ${name} before requesting any reset preview or start`, async () => {
  const f = cli()
  f.state.position = { x: 8, y: 64, z: 8 }; f.state.chunk = { x: 0, z: 0 }
  f.state.positionSource = 'client_prediction'
  mutate(f)
  let asked = 0
  await assert.rejects(main(['--preview'], { ...f.opts, ask: async () => { asked++; return 'RESET' } }), /位置|チャンク/)
  assert.deepEqual(commands(f), [], 'raw or predicted display positions cannot become a reset scope')
  assert.equal(asked, 0)
})

test('loadout CLI derives canonical negative chunks from the confirmed point and binds both reset requests to the same area', async () => {
  const f = cli()
  f.state.positionProof.feet = { x: -.5, y: 64, z: -16.5 }
  const result = await main([], { ...f.opts, ask: async () => 'RESET' })
  assert.equal(result.serverConfirmed, true)
  const area = { x1: -1, z1: -2, x2: -1, z2: -2 }
  assert.deepEqual(commands(f), [
    { command: 'resetPreview', session: 's', area },
    { command: 'resetStart', session: 's', resetToken: 'one-shot', area, confirm: 'REPLACE_SURFACE_CHEST_AND_CLEAR_INVENTORY' }
  ])
  assert.ok(!commands(f).some(request => ['moveToChunk', 'start', 'resume', 'confirmPosition'].includes(request.command)))
})

test('loadout CLI uses floor at exact and fractional negative chunk boundaries without widening the selected area', async () => {
  for (const [x, chunk] of [[-.01, -1], [-16, -1], [-16.01, -2], [0, 0], [16, 1]]) {
    const f = cli(); f.state.positionProof.feet.x = x; f.state.positionProof.radius = 0
    await main(['--preview'], f.opts)
    assert.deepEqual(commands(f), [{ command: 'resetPreview', session: 's', area: { x1: chunk, z1: 0, x2: chunk, z2: 0 } }])
  }
})

for (const changed of ['session', 'generation', 'area', 'proof']) test(`loadout CLI rechecks ${changed} after explicit confirmation and never sends a stale reset start`, async () => {
  const f = cli()
  const answer = async () => {
    if (changed === 'session') { f.state.session = 'new-session'; f.state.positionProof.session = 'new-session' }
    if (changed === 'generation') f.state.positionProof.generation++
    if (changed === 'area') f.state.positionProof.feet.x += 16
    if (changed === 'proof') f.state.positionProof.confirmed = false
    return 'RESET'
  }
  await assert.rejects(main([], { ...f.opts, ask: answer }), /位置|接続|範囲/)
  assert.deepEqual(commands(f), [{ command: 'resetPreview', session: 's', area: { x1: 0, z1: 0, x2: 0, z2: 0 } }])
})

test('loadout CLI refuses a changed preview response scope before asking for destructive confirmation', async () => {
  const f = cli(), request = f.opts.request
  let asked = 0
  await assert.rejects(main([], { ...f.opts, request: async input => {
    const result = await request(input)
    if (input.payload?.command === 'resetPreview') f.state.positionProof.generation++
    return result
  }, ask: async () => { asked++; return 'RESET' } }), /接続|範囲/)
  assert.equal(asked, 0)
  assert.equal(commands(f).filter(request => request.command === 'resetStart').length, 0)
})
