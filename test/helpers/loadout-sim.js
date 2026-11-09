'use strict'
// Offline authoritative-observation simulator. It never connects to Minecraft.
// Tests can independently drop an acknowledgment or its inventory observation.
const { createLoadoutReset } = require('../../src/loadout-reset')
const { observedScope } = require('../../src/server-position-verifier')
const { allowed } = require('../../src/loadout-command')
const assert = require('node:assert/strict')
const copy = value => structuredClone(value)
const empty = slot => ({ slot, known: true, empty: true, count: 0, name: null })
let nextStack = 1
function item (name, count = 1, enchants = {}, slot = 0) {
  const durabilityApplicable = /diamond_|:bow$/.test(name)
  return { slot, name, known: true, empty: false, metadata: 0, count, stackId: nextStack++, enchantmentsKnown: true,
    enchantments: Object.entries(enchants).map(([name, level]) => ({ name, level })), durabilityApplicable, durabilityKnown: durabilityApplicable, durabilityUsed: durabilityApplicable ? 0 : null,
    ...(/shulker_box$/.test(name) ? { resetPlainEmptyBox: true, container: { known: true, slotCount: 27, slots: Array.from({ length: 27 }, () => null) } } : {}) }
}
function fixture (options = {}) {
  const state = { profile: 'bot', playerName: 'ResetBot', realm: { id: '42', name: 'Offline Realm' }, dimension: 'overworld', phase: 'spawned', connectionId: 'one', startedAt: '2026-11-09T00:00:00Z', runtimeEntityId: '7', lifecycle: { deathId: 0 }, gameMode: 'survival', health: 20, loadingScreenEnded: true, inventory: { known: true }, resetThreats: false, position: { x: .5, y: 65.62, z: .5 } }
  const view = { known: true, uncertain: false, slots: Array.from({ length: 36 }, (_, i) => empty(i)), armor: { known: true, slots: Array.from({ length: 4 }, (_, i) => empty(i)) }, offhand: { known: true, slots: [empty(0)] } }
  view.slots[0] = item('minecraft:diamond', 20)
  view.armor.slots[0] = item('minecraft:iron_helmet')
  view.offhand.slots[0] = item('minecraft:shield')
  const blocks = new Map(), key = p => `${p.x},${p.y},${p.z}`, commandsSent = [], saves = [], calls = []
  let time = 10000, generation = 1, job = 'test:PAUSED', selected = options.serverSlot ?? 0, lease = null, open = null, stored = options.prior ?? null
  const hooks = { beforeSend: null, afterSend: null, save: null, ...options.hooks }
  const blockAt = (x, y, z) => blocks.get(key({ x, y, z })) ?? { known: true, name: y < 64 ? 'minecraft:stone' : 'minecraft:air', boundingBox: y < 64 ? 'block' : 'empty', extra: [] }
  function setItem (slots, slot, name, count) { slots[slot] = name === 'minecraft:air' ? empty(slot) : item(name, count, {}, slot) }
  const commands = {
    async send (text) {
      assert.ok(allowed(text), 'unexpected command: ' + text)
      commandsSent.push(text)
      if (hooks.beforeSend) await hooks.beforeSend(text, commandsSent.length)
      const scope = observedScope(state), args = text.split(' ')
      if (text === '/clear @s') view.slots = view.slots.map((s, i) => empty(i)) // leave armor to test explicit slot clear
      else if (text.startsWith('/replaceitem entity')) {
        const where = args[3], slot = Number(args[4]), name = args[5], count = Number(args[6] ?? 1)
        if (where === 'slot.hotbar') setItem(view.slots, slot, name, count)
        else if (where === 'slot.inventory') setItem(view.slots, slot + 9, name, count)
        else if (where === 'slot.weapon.offhand') setItem(view.offhand.slots, slot, name, count)
        else setItem(view.armor.slots, ['head', 'chest', 'legs', 'feet'].indexOf(where.replace('slot.armor.', '')), name, count)
      } else if (text.startsWith('/testfor @s[hasitem=')) {
        const name = /item=(minecraft:[a-z_]+)/.exec(text)[1]
        if (view.slots[selected]?.empty || view.slots[selected]?.name !== name || view.slots[selected]?.count !== 1) throw Object.assign(Error('commands.testfor.failure'), { code: 'RESET_COMMAND_REJECTED', messageId: 'commands.testfor.failure', serverRejected: true })
      } else if (text.startsWith('/enchant')) {
        if (view.slots[selected]?.empty) throw Object.assign(Error('commands.enchant.noItem'), { code: 'RESET_COMMAND_REJECTED', messageId: 'commands.enchant.noItem' })
        view.slots[selected].enchantments.push({ name: args[2], level: Number(args[3]) })
      }
      else if (text.startsWith('/setblock')) {
        const p = { x: Number(args[1]), y: Number(args[2]), z: Number(args[3]) }
        assert.equal(blockAt(p.x, p.y, p.z).name, 'minecraft:air', 'never overwrite staging terrain')
        blocks.set(key(p), { known: true, name: args[4], boundingBox: 'block', extra: [], contents: Array.from({ length: 27 }, (_, i) => empty(i)) })
      } else if (text.startsWith('/replaceitem block')) {
        const p = { x: Number(args[2]), y: Number(args[3]), z: Number(args[4]) }, b = blocks.get(key(p))
        assert.ok(b?.contents); setItem(b.contents, Number(args[6]), args[7], Number(args[8]))
      } else if (text.startsWith('/loot')) {
        const p = { x: Number(args[8]), y: Number(args[9]), z: Number(args[10]) }, b = blocks.get(key(p)), slot = Number(args[5]) + 9
        assert.ok(b?.contents); const box = item(b.name, 1, {}, slot)
        box.container.slots = copy(b.contents); view.slots[slot] = box
      } else if (text.startsWith('/execute')) {
        const p = { x: Number(args[3]), y: Number(args[4]), z: Number(args[5]) }, b = blocks.get(key(p))
        assert.equal(b?.name, args[6]); assert.ok(b.contents.every(s => s.empty), 'never destroy a filled template')
        blocks.delete(key(p))
      } else assert.equal(text, '/testfor @s')
      if (text.startsWith('/replaceitem entity')) {
        const where = args[3]
        if (where === 'slot.hotbar' || where === 'slot.inventory') view.known = view.slots.every(s => s?.known)
        else if (where === 'slot.weapon.offhand') view.offhand.known = view.offhand.slots.every(s => s?.known)
        else view.armor.known = view.armor.slots.every(s => s?.known)
      }
      if (hooks.afterSend) await hooks.afterSend(text, commandsSent.length)
      return { serverConfirmed: true, scope, requestId: 'receipt-' + commandsSent.length, receivedAt: time }
    }, cancel () { calls.push('commandCancel') }, applyPacket () {}
  }
  const adapter = {
    getState: () => state, getView: () => copy(view), getBlock: blockAt,
    assertIdle: () => { if (options.busy || lease) throw Object.assign(new Error('not idle'), { code: 'RESET_NOT_IDLE' }) },
    acquire: id => { if (options.acquireError) throw new Error('acquire failed'); lease = id; calls.push('acquire') },
    release: id => { assert.equal(lease, id); lease = null; calls.push('release') },
    cancelJob: async () => { calls.push('cancelJob'); job = 'test:FINISHED' },
    save: async doc => { if (hooks.save) await hooks.save(doc); saves.push(copy(doc)); stored = copy(doc) },
    load: async () => stored,
    select: async i => { selected = i },
    equipArmor: async () => {
      const i = ['helmet', 'chestplate', 'leggings', 'boots'].findIndex(s => view.slots[0].name.endsWith(s))
      assert.ok(i >= 0); assert.ok(view.armor.slots[i].empty)
      view.armor.slots[i] = { ...copy(view.slots[0]), slot: i }; view.slots[0] = empty(0)
      return [{ serverConfirmed: true }]
    },
    open: async p => { open = copy(p); calls.push('open') },
    close: async () => { open = null; calls.push('close') },
    deposit: async ({ sourceSlot, chestSlot, count, expectedName }) => {
      assert.ok(open); const b = blocks.get(key(open))
      assert.equal(view.slots[sourceSlot].name, expectedName); assert.equal(count, 1); assert.ok(b.contents[chestSlot].empty)
      b.contents[chestSlot] = { ...copy(view.slots[sourceSlot]), slot: chestSlot }; view.slots[sourceSlot] = empty(sourceSlot)
      calls.push('deposit'); return { serverConfirmed: true }
    },
    container: () => open && ({ known: true, position: copy(open), slots: copy(blocks.get(key(open)).contents) }),
    cancelTransfers: async id => { assert.equal(lease, id); calls.push('cancelTransfers') },
    generation: () => generation, jobIdentity: () => job
  }
  const reset = createLoadoutReset({ adapter, commands, now: () => time, sleep: async ms => { time += ms }, observationTimeoutMs: 100 })
  const start = async () => { const p = await reset.prepare(); return reset.start({ token: p.token, confirm: 'REPLACE_INITIAL_INVENTORY' }) }
  return { reset, start, adapter, commands, state, view, blocks, saves, calls, hooks, commandsSent, selected: () => selected, setSelected: i => { selected = i }, time: n => { time += n }, generation: () => { generation++ }, job: v => { job = v }, lease: () => lease }
}
module.exports = { fixture, item, empty }
