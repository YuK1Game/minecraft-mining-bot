'use strict'

const { isDeepStrictEqual } = require('node:util')
const { isShulkerBox } = require('./container-types')

const SLOT_COUNT = 27
const copy = value => structuredClone(value)
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const nameOf = value => typeof value === 'string' && /^minecraft:[a-z0-9_]+$/.test(value) ? value : null
const unknown = reason => ({ known: false, slotCount: SLOT_COUNT, slots: null, reason })
const plainMarkers = new Set([false, 'false', 0])
const taggedMarkers = new Set([true, 'true', 65535])
const isCompound = tag => tag?.type === 'compound' && object(tag.value)
const canonicalTag = tag => Object.keys(tag.value).length ? { type: 'compound', value: copy(tag.value) } : null
const integerTag = (tag, types, min, max) => types.includes(tag?.type) && Number.isInteger(tag.value) && tag.value >= min && tag.value <= max
const observedStack = raw => raw && Number.isInteger(raw.network_id) && raw.network_id >= -32768 && raw.network_id <= 32767 && Number.isInteger(raw.count) && raw.count >= 0 && raw.count <= 127 && (raw.network_id === 0 ? raw.count === 0 && (raw.has_stack_id !== true || raw.stack_id === 0) : raw.count > 0 && raw.has_stack_id === true && Number.isInteger(raw.stack_id) && raw.stack_id > 0 && raw.stack_id <= 2147483647)

function readItemTag (raw) {
  if (!object(raw?.extra)) return { known: false }
  // These protocol side lists have no proven persisted-NBT conversion here.
  // Do not silently claim to preserve adventure-mode restrictions.
  if (!Array.isArray(raw.extra.can_place_on) || raw.extra.can_place_on.length || !Array.isArray(raw.extra.can_destroy) || raw.extra.can_destroy.length) return { known: false }
  if (plainMarkers.has(raw.extra.has_nbt)) return raw.extra.nbt == null ? { known: true, tag: null } : { known: false }
  const root = raw.extra.nbt?.nbt ?? raw.extra.nbt
  if (!taggedMarkers.has(raw.extra.has_nbt) || !isCompound(root)) return { known: false }
  return { known: true, tag: canonicalTag(root) }
}

// Bedrock stores carried contents directly in item-root Items, not the Java
// BlockEntityTag path. An absent Items tag may be a legitimate empty box, but
// this reader cannot prove that observation; callers must open it to find out.
function readShulkerContents (raw, { resolveName } = {}) {
  if (typeof resolveName !== 'function') return unknown('ITEM_NAMES_UNOBSERVED')
  if (!observedStack(raw) || raw.count !== 1) return unknown('BOX_STACK_UNOBSERVED')
  let boxName
  try { boxName = resolveName(raw.network_id) } catch { return unknown('ITEM_NAMES_UNOBSERVED') }
  if (!isShulkerBox(boxName)) return unknown('NOT_A_SHULKER_BOX')
  const root = raw.extra?.nbt?.nbt ?? raw.extra?.nbt
  if (!taggedMarkers.has(raw.extra?.has_nbt) || !isCompound(root)) return unknown('CONTENTS_NBT_UNOBSERVED')
  const items = root.value.Items
  if (items?.type !== 'list' || !Array.isArray(items.value?.value) || items.value.value.length > SLOT_COUNT || items.value.type !== 'compound' && !(items.value.type === 'end' && items.value.value.length === 0)) return unknown('CONTENTS_LIST_UNOBSERVED')
  const slots = Array.from({ length: SLOT_COUNT }, () => null), occupied = new Set()
  for (const entry of items.value.value) {
    const value = entry?.type === 'compound' ? entry.value : entry
    if (!object(value) || !integerTag(value.Slot, ['byte'], 0, SLOT_COUNT - 1) || !integerTag(value.Count, ['byte'], 1, 127) || !integerTag(value.Damage, ['short', 'int'], 0, 65535) || value.Name?.type !== 'string' || !nameOf(value.Name.value) || value.Name.value === 'minecraft:air' || occupied.has(value.Slot.value)) return unknown('CONTENTS_ENTRY_INVALID')
    if (value.tag != null && !isCompound(value.tag)) return unknown('CONTENTS_TAG_UNOBSERVED')
    for (const name of ['CanPlaceOn', 'CanDestroy']) {
      const restrictions = value[name]
      if (restrictions != null && (restrictions.type !== 'list' || !['string', 'end'].includes(restrictions.value?.type) || !Array.isArray(restrictions.value?.value) || restrictions.value.value.length)) return unknown('CONTENTS_RESTRICTIONS_UNSUPPORTED')
    }
    const slot = value.Slot.value
    occupied.add(slot)
    slots[slot] = { slot, name: value.Name.value, count: value.Count.value, metadata: value.Damage.value, tag: value.tag == null ? null : canonicalTag(value.tag) }
  }
  return { known: true, slotCount: SLOT_COUNT, slots }
}

// Input must be the complete received 27-slot window, including observed air
// descriptors. Sparse arrays and missing extras are not an empty inventory.
function readContainerContents (rawSlots, { resolveName } = {}) {
  if (typeof resolveName !== 'function') return unknown('ITEM_NAMES_UNOBSERVED')
  if (!Array.isArray(rawSlots) || rawSlots.length !== SLOT_COUNT) return unknown('CONTAINER_SLOTS_UNOBSERVED')
  const slots = []
  for (let slot = 0; slot < SLOT_COUNT; slot++) {
    const raw = rawSlots[slot]
    if (!observedStack(raw)) return unknown('CONTAINER_STACK_UNOBSERVED')
    if (raw.network_id === 0) { slots.push(null); continue }
    let name
    try { name = nameOf(resolveName(raw.network_id)) } catch { return unknown('ITEM_NAMES_UNOBSERVED') }
    if (!name || name === 'minecraft:air' || !Number.isInteger(raw.metadata) || raw.metadata < 0 || raw.metadata > 65535) return unknown('CONTAINER_IDENTITY_UNOBSERVED')
    const tag = readItemTag(raw)
    if (!tag.known) return unknown('CONTAINER_TAG_UNOBSERVED')
    slots.push({ slot, name, count: raw.count, metadata: raw.metadata, tag: tag.tag })
  }
  return { known: true, slotCount: SLOT_COUNT, slots }
}

// This compares observations only. The caller still binds the returned box to
// a fresh main-inventory receipt after its owned block was received as AIR.
function compareShulkerContents (boxRaw, rawSlots, options) {
  const actual = readShulkerContents(boxRaw, options)
  if (!actual.known) return { known: false, matches: false, reason: actual.reason }
  const expected = readContainerContents(rawSlots, options)
  if (!expected.known) return { known: false, matches: false, reason: expected.reason }
  const matches = isDeepStrictEqual(actual.slots, expected.slots)
  return { known: true, matches, ...(matches ? {} : { reason: 'CONTENTS_MISMATCH' }) }
}

module.exports = { readShulkerContents, readContainerContents, compareShulkerContents }
