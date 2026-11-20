'use strict'

// The real expedition runtime (dragon-runtime.js: the expedition, its saved record, the goal ledger and the
// watcher) over a virtual clock. Only the early step is a stand-in: it does what the test says a step did.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createDragonRuntime } = require('../../src/modes/dragon-runtime')
const { createDragonState } = require('../../src/modes/dragon-state')

const PICK = { slot: 0, name: 'minecraft:stone_pickaxe', count: 1, durabilityRemaining: 100 }
const turns = async n => { for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve)) }

// live(): what of the Bot's state is read from elsewhere at each look (position, inventory, the hand).
// ports(signal, shared): the ports a step gets beside the stand-ins here (the hands of helpers/dig-world.js).
async function createWorld (t, { items = [PICK], step = async () => ({ done: false, reason: 'iron_helmet を準備しています（0/2）。' }), live = () => ({}), ports = () => ({}), getBlock = () => ({ known: false }) } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dragon-goal-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const w = { root, at: 1e9, lines: [], life: 'a/0', step, calls: 0, hung: false, shared: null, rt: null, worn: [],
    raw: { profile: 'bot', realm: { id: 'r' }, connectionId: 'a', startedAt: 't', dimension: 'overworld', health: 20, phase: 'spawned', lifecycle: { deathId: 0 },
      position: { x: 0.5, y: 70, z: 0.5 }, inventory: { known: true, items: items.map(item => ({ ...item })) } } }
  const host = () => ({ getLife: () => w.raw.lifecycle, meta: { startGame: { seed: 1 } } })
  // The saved record of a Bot whose bed is confirmed: the goal is the kit at home.
  const seed = createDragonState({ root, shared: {}, getState: () => w.raw, getLife: () => w.raw.lifecycle, getWorldId: () => 1 })
  const record = seed.record()
  record.early.spawnReady = true
  await seed.save(record)
  // shared given: a reload of the behaviour code (the same shared state). None: a restart of the process.
  w.boot = (shared = { playerHouse: { done: true, origin: { x: 0, y: 70, z: 0 } } }) => {
    w.shared = shared
    const raw = () => ({ ...w.raw, ...live() })
    w.rt = createDragonRuntime({ now: () => w.at, shared, root, getBlock, log: line => w.lines.push(line),
      runtime: { raw, host, armor: () => ({ known: true, worn: w.worn }), inventory: () => raw().inventory },
      active: () => true, legacyBusy: () => false, legacyIdle: () => true, stopLegacy: () => {}, lifeKey: () => w.life, loading: () => false, threatened: () => w.threatened === true,
      stepPorts: signal => { w.hung = false; return { cancelled: () => signal.aborted, getFeet: () => raw().position, hands: {}, log: line => w.lines.push(line), shared, operations: {}, runtime: { raw, inventory: () => raw().inventory }, ...ports(signal, shared) } },
      early: ctx => { w.calls++; return w.step(ctx, w) } })
    return w.rt
  }
  // A step nothing answers.
  let hang = () => {}
  w.never = () => { w.hung = true; hang(); return new Promise(() => {}) }
  // ms of the virtual clock, one look per tickMs. each: called before every look with the minutes passed.
  w.pass = async (ms, { tickMs = 10000, each = null } = {}) => {
    for (let passed = 0; passed < ms; passed += tickMs) {
      each?.(passed / 60000)
      w.rt.tick()
      // A run that hangs is not waited for: the look goes on every tick, as it does over a real clock.
      if (w.hung) await turns(4)
      else await Promise.race([w.rt.settled(), new Promise(resolve => { hang = resolve })])
      w.at += tickMs
    }
  }
  w.goal = () => w.shared.dragonGoal
  w.said = pattern => w.lines.filter(line => pattern.test(line))
  w.have = (name, count) => {
    const list = w.raw.inventory.items.filter(item => item.name !== 'minecraft:' + name)
    if (count > 0) list.push({ slot: list.length, name: 'minecraft:' + name, count })
    w.raw.inventory = { known: true, items: list }
  }
  w.boot()
  return w
}

module.exports = { createWorld, PICK }
