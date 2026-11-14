'use strict'
// 2026-11-14 user request (relayed): wear the best received armour in every
// state at a safe point; defence, then enchantments, then durability; an empty
// offhand takes a totem, else a shield; never during the quarry's final store.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createArmor, pieceRank } = require('../src/armor')
const { createInventoryStore } = require('../src/inventory-store')

const IDS = { 1: 'minecraft:iron_chestplate', 2: 'minecraft:diamond_chestplate', 3: 'minecraft:totem_of_undying', 4: 'minecraft:shield', 5: 'minecraft:dirt' }
const ID = Object.fromEntries(Object.entries(IDS).map(([k, v]) => [v, Number(k)]))
let stack = 100
const item = (name, { damage = 0, ench = [] } = {}) => ({ network_id: ID[name], count: 1, metadata: 0, has_stack_id: true, stack_id: stack++, block_runtime_id: 0, extra: { has_nbt: true, nbt: { nbt: { type: 'compound', value: { Damage: { type: 'int', value: damage }, ...(ench.length ? { ench: { type: 'list', value: { type: 'compound', value: ench.map(([id, lvl]) => ({ id: { type: 'short', value: id }, lvl: { type: 'short', value: lvl } })) } } } : {}) } } }, can_place_on: [], can_destroy: [] } })
const air = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0 })

function rig ({ main = [], worn = [], offhand = undefined }) {
  const store = createInventoryStore({ shared: {} })
  for (let s = 0; s < 4; s++) store.commit('armor', s, worn[s] ?? air(), 'server_inventory_content')
  if (offhand !== undefined) store.commit('offhand', 0, offhand ?? air(), 'server_inventory_slot')
  const raws = main
  const crafting = {
    rawItem: slot => raws[slot] ?? air(),
    snapshot: () => ({ authority: true, inventoryKnown: true, pendingRequestId: null, openContainer: null, inventory: raws.map((r, slot) => r && r.network_id ? { name: IDS[r.network_id], slot, count: r.count } : null).filter(Boolean) }),
    openInventory: async () => {}, closeContainer: () => {}, itemNameOf: id => IDS[id] ?? null
  }
  const armor = createArmor({ client: { queue () {} }, getState: () => ({ phase: 'spawned', health: 20, gameMode: 'survival', inventory: { known: true } }), crafting, allocateRequestId: () => -1, inventoryStore: store })
  return armor
}

test('a better piece of the same slot is chosen by defence', () => {
  const a = rig({ main: [item('minecraft:diamond_chestplate')], worn: [null, item('minecraft:iron_chestplate')] })
  assert.equal(a.preview()?.name, 'minecraft:diamond_chestplate')
})

test('equal defence: more enchantment levels win, then less damage; an equal piece is left alone', () => {
  assert.ok(pieceRank('minecraft:iron_chestplate', item('minecraft:iron_chestplate', { ench: [[0, 3]] })) > pieceRank('minecraft:iron_chestplate', item('minecraft:iron_chestplate')))
  assert.ok(pieceRank('minecraft:iron_chestplate', item('minecraft:iron_chestplate', { damage: 10 })) > pieceRank('minecraft:iron_chestplate', item('minecraft:iron_chestplate', { damage: 100 })))
  assert.ok(pieceRank('minecraft:diamond_chestplate', item('minecraft:diamond_chestplate', { damage: 500 })) > pieceRank('minecraft:iron_chestplate', item('minecraft:iron_chestplate', { ench: [[0, 4]] })), 'defence comes first')
  const same = rig({ main: [item('minecraft:iron_chestplate')], worn: [null, item('minecraft:iron_chestplate')] })
  assert.equal(same.preview(), null)
  const enchanted = rig({ main: [item('minecraft:iron_chestplate', { ench: [[0, 2]] })], worn: [null, item('minecraft:iron_chestplate')] })
  assert.equal(enchanted.preview()?.name, 'minecraft:iron_chestplate')
})

test('an empty received offhand takes a totem, else a shield; a held offhand or an unreceived one is left alone', () => {
  assert.equal(rig({ main: [item('minecraft:shield'), item('minecraft:totem_of_undying')], offhand: null }).preview()?.name, 'minecraft:totem_of_undying')
  assert.equal(rig({ main: [item('minecraft:shield')], offhand: null }).preview()?.offhand, true)
  assert.equal(rig({ main: [item('minecraft:totem_of_undying')], offhand: item('minecraft:shield') }).preview(), null)
  assert.equal(rig({ main: [item('minecraft:totem_of_undying')] }).preview(), null, 'unknown offhand is not assumed empty')
})

test('the runtime equips in every state at safe points, between long-trip legs, and never in the final chest store', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/runtime'), 'utf8')
  const gate = src.slice(src.indexOf('  function armorAutoAllowed () {'), src.indexOf('  function maybeEquipArmor () {'))
  assert.match(gate, /if \(longTravel\?\.status\?\.\(\)\.busy\) return false/)
  assert.match(gate, /if \(!quarryJob\?\.holdsWork\(\)\) return true/)
  assert.match(gate, /finalChest/)
  assert.doesNotMatch(src, /!\(host\.shared\.autoWanted === true \|\| quarryCombatArmed\) \|\| armorTask/, 'no longer limited to the legacy auto mode')
  assert.match(src, /if \(!armorTask && armor\.preview\(\) && armorWorkFree\(\) && !armorThreatNear\(\)\)/)
  // Live 21:14: only a hostile that can reach the bot within 8 m holds armour back.
  assert.match(src, /return risk\.threats\.some\(t => Number\.isFinite\(t\.distance\) \? t\.distance < 8 : true\)/)
})
