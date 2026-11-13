'use strict'

// Quarry capacity, keep-list and ledger helpers (spec v1.2 §11, §16.2).

const { nameOf, toolOf, SEAL_MATERIALS } = require('./quarry-rules')
const { foodNutrition } = require('./food')
const { surplusToolSlots } = require('./quarry-surplus-tools')

const SLOTS = 36
const STACK16 = /^(snowball|egg|ender_pearl|honey_bottle|sign|.*_sign|bucket|armor_stand|banner|.*_banner)$/
const STACK1 = /(_sword|_pickaxe|_axe|_shovel|_hoe|_helmet|_chestplate|_leggings|_boots|^bow$|^crossbow$|^shield$|^shears$|^trident$|_bucket$|^saddle$|^totem_of_undying$|^elytra$|^flint_and_steel$|^fishing_rod$|^potion$|^splash_potion$|^lingering_potion$|^mushroom_stew$|^rabbit_stew$|^beetroot_soup$|^suspicious_stew$|_bed$|^bed$|^cake$)/
const FOOD = /^(bread|cooked_[a-z_]+|baked_potato|apple|golden_apple|enchanted_golden_apple|golden_carrot|carrot|potato|beetroot|melon_slice|sweet_berries|glow_berries|cookie|pumpkin_pie|dried_kelp|mushroom_stew|rabbit_stew|beetroot_soup|beef|porkchop|mutton|chicken|rabbit|cod|salmon)$/
const KEEP = /^(torch|soul_torch|bucket|water_bucket|lava_bucket|bow|crossbow|arrow|spectral_arrow|tipped_arrow|shield|totem_of_undying|bed|.*_bed|.*_helmet|.*_chestplate|.*_leggings|.*_boots|ladder|scaffolding|flint_and_steel|ender_pearl)$/

const isShulkerBox = name => /(?:^|_)shulker_box$/.test(nameOf(name))
const maxStack = name => { const n = nameOf(name); return isShulkerBox(n) || STACK1.test(n) ? 1 : STACK16.test(n) ? 16 : 64 }
const isFood = name => FOOD.test(nameOf(name))

// Use the received stack identity when available. Recovery can move a shulker
// to another slot and give it a new stack ID; its controller returns the new
// key when a full box must be skipped for the remainder of a storage pass.
function carriedContainerKey (item) {
  const stack = item?.stackId ?? item?.stack_id
  return Number.isSafeInteger(stack) && stack > 0 ? `${nameOf(item)}:stack:${stack}` : `${nameOf(item)}:slot:${item?.slot}`
}

// A connection-independent identity of a carried box: its received item
// identity with the stack ID and count left out (the NBT holds the contents).
// Live 2026-11-13: stack IDs change on reconnect, so the stack-keyed "full"
// marks no longer matched and every full box was placed and recovered again.
// A box that was full and received nothing since keeps the same contents.
function carriedContainerIdentity (item) {
  const r = item?.raw
  if (!r || !Number.isInteger(r.network_id) || r.network_id === 0 || r.extra == null) return null
  return require('crypto').createHash('sha256').update(require('v8').serialize({ network_id: r.network_id, metadata: r.metadata, block_runtime_id: r.block_runtime_id, extra: r.extra })).digest('hex')
}

// Unenchanted, plain armour in the bag whose piece is already worn in a
// strictly better material (e.g. a copper helmet dropped by a drowned while a
// diamond helmet is worn). Everything must be server-received and known;
// anything unclear stays kept.
const ARMOR_RANK = { leather: 1, golden: 2, copper: 2, chainmail: 3, iron: 4, diamond: 5, netherite: 6 }
const ARMOR = /^(leather|golden|copper|chainmail|iron|diamond|netherite)_(helmet|chestplate|leggings|boots)$/
function spareArmorStackIds (details) {
  const worn = new Map()
  if (details?.armor?.known !== true || !Array.isArray(details.armor.slots) || !Array.isArray(details.slots)) return []
  for (const piece of details.armor.slots) {
    const m = piece?.known === true && piece.empty === false && ARMOR.exec(nameOf(piece.name))
    if (m && piece.enchantmentsKnown === true) worn.set(m[2], Math.max(worn.get(m[2]) ?? 0, ARMOR_RANK[m[1]]))
  }
  const out = []
  for (const item of details.slots) {
    const m = item?.known === true && item.empty === false && Number.isInteger(item.slot) && item.slot >= 0 && item.slot < SLOTS && ARMOR.exec(nameOf(item.name))
    if (!m || item.count !== 1 || !Number.isSafeInteger(item.stackId) || item.stackId < 1) continue
    if (item.enchantmentsKnown !== true || !Array.isArray(item.enchantments) || item.enchantments.length || item.displayName != null || (Array.isArray(item.lore) ? item.lore.length : item.lore != null) || item.repairCost != null && item.repairCost !== 0) continue
    if ((worn.get(m[2]) ?? 0) > ARMOR_RANK[m[1]]) out.push(item.stackId)
  }
  return out
}

function selectCarriedStorage (items, { excludedShulkerKeys = [], excludedShulkerIdentities = [], shulkerOnly = false } = {}) {
  const available = [...(items ?? [])].filter(item => Number.isInteger(item?.slot) && item.slot >= 0 && item.slot < SLOTS && Number.isSafeInteger(item.count) && item.count > 0).sort((a, b) => a.slot - b.slot)
  const excluded = new Set(excludedShulkerKeys), excludedIdentity = new Set(excludedShulkerIdentities)
  const source = (item, count) => ({ slot: item.slot, name: item.name, count, ...(Number.isSafeInteger(item.stackId ?? item.stack_id) ? { stackId: item.stackId ?? item.stack_id } : {}) })
  const box = available.find(item => isShulkerBox(item.name) && item.count === 1 && !excluded.has(carriedContainerKey(item)) && !(excludedIdentity.size && excludedIdentity.has(carriedContainerIdentity(item))) && !(shulkerOnly && require('./loadout-manifest').SUPPLY_NAMES.includes(item.name)))
  if (box) return { kind: 'shulker', key: carriedContainerKey(box), sources: [source(box, 1)] }
  if (shulkerOnly) return null
  const chests = available.filter(item => nameOf(item) === 'chest')
  const count = Math.min(2, chests.reduce((sum, item) => sum + item.count, 0))
  if (!count) return null
  const sources = []; let left = count
  for (const item of chests) { if (!left) break; const take = Math.min(left, item.count); sources.push(source(item, take)); left -= take }
  return { kind: count === 2 ? 'double_chest' : 'single_chest', key: sources.map(item => `${carriedContainerKey(item)}:${item.count}`).join('|'), sources }
}

// What stays with the bot on deposit (§11.1): tools, weapons, armour, food,
// emergency items and up to keepSealBlocks of seal/stair material.
// Material for one more storage chest is kept too: carried chests and a
// crafting table, plus a few logs/planks (2 logs make a chest, 1 a table).
// A little coal and a few sticks stay too, to craft torches for the chest area.
function keepPlan (items, { keepSealBlocks = 32, keepSealMaterial = null, keepFood = 64, keepLogs = 4, keepPlanks = 12, keepCoal = 4, keepSticks = 4, keepExitDirt = 0, sealDirt = true, keepRawMeat = true, cargoStackIds = [], autoSupplies = false, supplyBoxes = [], toolPolicy = {}, storeInferiorTools = true } = {}) {
  const keep = new Map() // slot -> count kept
  let seal = 0; let food = 0; let logs = 0; let planks = 0; let coal = 0; let sticks = 0; let exitDirt = 0
  const sorted = [...(items ?? [])].filter(i => Number.isInteger(i.slot) && i.slot >= 0 && i.slot < SLOTS).sort((a, b) => a.slot - b.slot)
  const cargo = new Set(Array.isArray(cargoStackIds) ? cargoStackIds.filter(id => Number.isSafeInteger(id) && id > 0) : [])
  const surplus = surplusToolSlots(sorted, { enabled: autoSupplies === true && storeInferiorTools !== false, supplyBoxes, toolPolicy })
  // Reserve meals by hunger restoration before a low-slot stack fills the
  // food allowance. Other KEEP categories and deposit order stay slot-based.
  // keepRawMeat false (quarry animal clearing, 2026-11-13): raw meat from
  // cleared animals is cargo, not kept food, so it can leave the bag.
  const RAW_MEAT = /^minecraft:(?:chicken|beef|porkchop|mutton|rabbit)$/
  for (const item of sorted.filter(i => isFood(i.name) && (keepRawMeat !== false || !RAW_MEAT.test(i.name))).sort((a, b) => foodNutrition(b.name) - foodNutrition(a.name) || a.slot - b.slot)) {
    if (food >= keepFood) break
    const count = Math.min(item.count, keepFood - food)
    food += count; keep.set(item.slot, count)
  }
  for (const item of sorted) {
    const n = nameOf(item)
    if (n === 'dirt' && exitDirt < keepExitDirt) { const k = Math.min(item.count, keepExitDirt - exitDirt); keep.set(item.slot, k); exitDirt += k; if (k === item.count) continue }
    if (surplus.has(item.slot)) continue
    // Spare armour picked up from mobs that is worse than what is worn (opt-in,
    // matched by its received stack ID, 2026-11-13) is cargo, not kept gear.
    if (cargo.size && /_(helmet|chestplate|leggings|boots)$/.test(n) && cargo.has(item.stackId ?? item.stack_id)) continue
    if (toolOf(item) || KEEP.test(n) || isShulkerBox(n) || n === 'chest' || n === 'crafting_table') { keep.set(item.slot, item.count); continue }
    if (/_(log|stem)$/.test(n) && logs < keepLogs) { const k = Math.min(item.count, keepLogs - logs); logs += k; keep.set(item.slot, k); continue }
    if (/^(coal|charcoal)$/.test(n) && coal < keepCoal) { const k = Math.min(item.count, keepCoal - coal); coal += k; keep.set(item.slot, k); continue }
    if (n === 'stick' && sticks < keepSticks) { const k = Math.min(item.count, keepSticks - sticks); sticks += k; keep.set(item.slot, k); continue }
    if (/_planks$/.test(n) && planks < keepPlanks) { const k = Math.min(item.count, keepPlanks - planks); planks += k; keep.set(item.slot, k); continue }
    if (isFood(n) && keep.has(item.slot)) continue
    // sealDirt false (v2.2 work dirt on demand, 2026-11-12): dirt is not kept as
    // seal material; it comes from the dirt supply box when a seal needs it.
    if (SEAL_MATERIALS.includes(n) && (sealDirt !== false || n !== 'dirt') && (!keepSealMaterial || n === nameOf(keepSealMaterial)) && seal < keepSealBlocks) { const prior = keep.get(item.slot) ?? 0; const k = Math.min(item.count - prior, keepSealBlocks - seal); seal += k; keep.set(item.slot, prior + k) }
  }
  const deposits = []
  for (const item of sorted) { const k = keep.get(item.slot) ?? 0; if (item.count > k) deposits.push({ slot: item.slot, name: item.name, count: item.count - k }) }
  return { keep, deposits }
}

// Room for the exit dirt withdrawal (2026-11-13: a full-only bag kept 34 of
// 36 slots fixed, 192 dirt needs 3). First make room by storing what the bag
// no longer needs (bounded attempts); otherwise withdraw only the selected
// exit column's need plus 8 when that fits. 'short' means even that does not
// fit and the withdrawal is limited to the room.
function egressDirtRoom (items, { target, keepPolicy = {}, storageAvailable = false, depositAttempts = 0, planDirt = null } = {}) {
  const dirt = (items ?? []).filter(i => nameOf(i) === 'dirt')
  const have = dirt.reduce((n, i) => n + i.count, 0)
  if (!Number.isSafeInteger(target) || target <= have) return { action: 'restock', target: Number.isSafeInteger(target) ? target : have }
  const partial = dirt.reduce((n, i) => n + Math.max(0, 64 - i.count), 0), free = freeSlots(items)
  const fits = have + partial + free * 64
  if (fits >= target) return { action: 'restock', target }
  const storable = keepPlan(items, keepPolicy).deposits.filter(d => nameOf(d.name) !== 'dirt' && !isShulkerBox(d.name))
  if (storable.length && storageAvailable && depositAttempts < 2) return { action: 'deposit', deposits: storable }
  if (Number.isSafeInteger(planDirt) && planDirt > 0 && planDirt + 8 <= fits) return { action: 'restock', target: Math.max(have, planDirt + 8), limited: true }
  return { action: 'restock', target: Math.max(have, fits), limited: true, short: true }
}

function freeSlots (items) {
  const used = new Set((items ?? []).filter(i => Number.isInteger(i.slot) && i.slot >= 0 && i.slot < SLOTS && i.count > 0).map(i => i.slot))
  return SLOTS - used.size
}

// Can the next dig's worst-case drops be held (§11.1, T06)? Different
// enchantment/damage/custom data never stack; only plain stacks are topped up.
function canAccept (items, drops, { minFreeSlots = 0 } = {}) {
  let free = freeSlots(items)
  if (free < minFreeSlots) return false
  const room = new Map()
  for (const i of items ?? []) {
    if (!Number.isInteger(i.slot) || i.slot < 0 || i.slot >= SLOTS || i.custom || i.enchantments?.length || i.durabilityKnown) continue
    const n = nameOf(i)
    room.set(n, (room.get(n) ?? 0) + Math.max(0, maxStack(n) - i.count))
  }
  for (const d of drops ?? []) {
    let left = d.count
    const n = nameOf(d.name)
    const r = room.get(n) ?? 0
    const used = Math.min(r, left); left -= used; room.set(n, r - used)
    while (left > 0) { if (free <= minFreeSlots) return false; free--; const take = Math.min(maxStack(n), left); left -= take; room.set(n, (room.get(n) ?? 0) + maxStack(n) - take) }
  }
  return true
}

// Inventory totals by item name.
function totals (items) {
  const t = new Map()
  for (const i of items ?? []) if (Number.isInteger(i.slot) && i.slot >= 0 && i.slot < SLOTS && i.count > 0) t.set(nameOf(i), (t.get(nameOf(i)) ?? 0) + i.count)
  return t
}
function diff (before, after) {
  const out = []
  for (const name of new Set([...before.keys(), ...after.keys()])) { const d = (after.get(name) ?? 0) - (before.get(name) ?? 0); if (d) out.push({ name, delta: d }) }
  return out
}

// MaterialLedger (§16.2): separate buckets, never mixed.
function createLedger (saved = {}) {
  const buckets = ['minedBlocks', 'picked', 'loot', 'deposited', 'placedTemporary', 'placedSeal', 'reminedTemporary', 'lost', 'unaccounted', 'startInventory']
  const ledger = Object.fromEntries(buckets.map(b => [b, { ...(saved[b] ?? {}) }]))
  const add = (bucket, name, count = 1) => { if (!ledger[bucket]) throw new Error(`Unknown ledger bucket ${bucket}`); const n = nameOf(name); ledger[bucket][n] = (ledger[bucket][n] ?? 0) + count }
  return { add, export: () => structuredClone(ledger), summary: () => Object.fromEntries(buckets.map(b => [b, Object.values(ledger[b]).reduce((s, v) => s + v, 0)])) }
}

// Drops that fit, in order, while keepFree slots stay empty (live 2026-11-12
// 22:30: a make-room pickup overflowed into a new stack). Without keepFree, no
// free slot is used at all.
function dropsFittingStacks (items, drops, { keepFree = null } = {}) {
  const fitting = [], free = freeSlots(items), keep = Number.isSafeInteger(keepFree) && keepFree >= 0 ? Math.min(keepFree, free) : free
  for (const drop of drops ?? []) if (Number.isSafeInteger(drop?.count) && drop.count > 0 && typeof drop.name === 'string' && canAccept(items, [...fitting, drop], { minFreeSlots: keep })) fitting.push(drop)
  return fitting
}

module.exports = { keepPlan, freeSlots, canAccept, dropsFittingStacks, totals, diff, createLedger, maxStack, isFood, isShulkerBox, carriedContainerKey, carriedContainerIdentity, spareArmorStackIds, selectCarriedStorage, egressDirtRoom, SLOTS }
