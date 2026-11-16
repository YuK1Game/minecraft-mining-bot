'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os'), fs = require('node:fs'), path = require('node:path')
const { switchRefusal, startRefusal, normalizeMode } = require('../src/modes/bot-mode')
const { loadModeSync, saveMode } = require('../src/modes/mode-store')
const { createModeControl } = require('../src/modes/mode-control')
const { createPlayerMode } = require('../src/modes/player-mode')
const { playerStages } = require('../src/modes/player-stages')

test('mode switch is refused while either mode works, allowed when both are stopped', () => {
  assert.equal(switchRefusal({ from: 'quarry', to: 'player' }), null)
  assert.equal(switchRefusal({ from: 'quarry', to: 'player', quarry: { jobId: 'q', state: 'PAUSED' } }), null)
  assert.equal(switchRefusal({ from: 'quarry', to: 'player', quarry: { jobId: 'q', state: 'MINING' } }).code, 'QUARRY_RUNNING')
  assert.equal(switchRefusal({ from: 'quarry', to: 'player', quarry: { jobId: 'q', state: 'PAUSED', draining: true } }).code, 'QUARRY_RUNNING')
  assert.equal(switchRefusal({ from: 'player', to: 'quarry', agent: { running: true } }).code, 'PLAYER_RUNNING')
  assert.equal(switchRefusal({ from: 'player', to: 'quarry', busy: true }).code, 'MODE_BUSY')
  assert.equal(switchRefusal({ from: 'player', to: 'travel' }).code, 'INVALID_MODE')
  assert.equal(startRefusal('quarry', 'quarry'), null)
  assert.equal(startRefusal('quarry', 'player').code, 'MODE_MISMATCH')
  assert.equal(normalizeMode('x'), 'quarry')
})

test('the selected mode is saved and read back; a damaged file means the default', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mode-')), file = path.join(dir, '.local', 'mode.json')
  assert.equal(loadModeSync(file), 'quarry')
  await saveMode(file, 'player')
  assert.equal(loadModeSync(file), 'player')
  fs.writeFileSync(file, '{broken')
  assert.equal(loadModeSync(file), 'quarry')
  await assert.rejects(saveMode(file, 'other'), { code: 'INVALID_MODE' })
})

test('mode control records the switch, saves it and never restores a quarry job in player mode', async () => {
  const shared = {}, saved = [], quarry = { jobId: 'q', state: 'MINING' }
  const control = createModeControl({ shared, save: async mode => { saved.push(mode) }, getQuarryStatus: () => quarry })
  assert.equal(control.get(), 'quarry')
  assert.throws(() => control.set('player'), { code: 'QUARRY_RUNNING' })
  assert.equal(control.get(), 'quarry')
  quarry.state = 'PAUSED'
  assert.deepEqual(control.set('player'), { mode: 'player', changed: true })
  assert.equal(shared.quarryRestoreDisabled, true)
  assert.deepEqual(control.set('player'), { mode: 'player', changed: false })
  await control.settled()
  assert.deepEqual(saved, ['player'])
})

test('player mode starts the survival autonomy with idle protection only in player mode', async () => {
  let mode = 'quarry'; const calls = []
  const agent = { start: options => { calls.push(['start', options.objective]); return { running: true } }, stop: () => calls.push(['stop']), snapshot: () => ({ running: calls.at(-1)?.[0] === 'start', phase: 'working' }) }
  const player = createPlayerMode({ getMode: () => mode, agent, safety: { start: () => calls.push(['safety']) }, getInventory: () => ({ known: true, items: [{ name: 'minecraft:iron_pickaxe', count: 1 }] }) })
  assert.throws(() => player.start(), { code: 'MODE_MISMATCH' })
  assert.deepEqual(calls, [])
  mode = 'player'
  const started = player.start()
  assert.deepEqual(calls, [['safety'], ['start', 'diamond']])
  assert.equal(started.running, true)
  assert.equal(started.current, 'diamond')
  assert.equal((await player.stop()).running, false)
})

test('stages are reached only from a received inventory', () => {
  assert.equal(playerStages(null).current, null)
  assert.equal(playerStages({ known: true, uncertain: true, items: [{ name: 'minecraft:diamond', count: 1 }] }).known, false)
  assert.equal(playerStages({ known: true, items: [] }).current, 'wood')
  const stone = playerStages({ known: true, items: [{ name: 'minecraft:stone_pickaxe', count: 1 }] })
  assert.deepEqual(stone.stages.filter(s => s.reached).map(s => s.id), ['wood', 'stone'])
  assert.equal(stone.current, 'iron')
  // Diamonds alone are not the diamond stage: the pickaxe and the sword are.
  assert.equal(playerStages({ known: true, items: [{ name: 'minecraft:iron_pickaxe', count: 1 }, { name: 'minecraft:diamond', count: 18 }] }).current, 'diamond')
  assert.equal(playerStages({ known: true, items: [{ name: 'minecraft:diamond_pickaxe', count: 1 }] }).current, 'diamond')
  // Pickaxe, sword and a worn chestplate are not the full set (user 21:39 JST).
  const tools = [{ name: 'minecraft:diamond_pickaxe', count: 1 }, { name: 'minecraft:diamond_sword', count: 1 }]
  assert.equal(playerStages({ known: true, items: tools }, { known: true, worn: [{ piece: 'chest', name: 'minecraft:diamond_chestplate' }] }).current, 'diamond')
  const set = { known: true, worn: ['helmet', 'chestplate', 'leggings'].map(piece => ({ name: `minecraft:diamond_${piece}` })) }
  assert.equal(playerStages({ known: true, items: [...tools, { name: 'minecraft:diamond_boots', count: 1 }] }, set).current, 'nether')
  // Unreceived armour counts as nothing worn.
  assert.equal(playerStages({ known: true, items: [...tools, { name: 'minecraft:diamond_boots', count: 1 }] }, { known: false, worn: set.worn }).current, 'diamond')
})
