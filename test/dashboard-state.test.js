'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { sanitizeStatus, sanitizeCachedStatus, sanitizeMission } = require('../scripts/lib/dashboard-state')
const observedAt = '2026-10-31T02:35:43.191Z'
const later = '2026-10-31T03:00:00.000Z'
const options = { observedAt, checkedAt: observedAt }
function raw () {
  return { phase: 'spawned', playerName: 'HouchiChan', realm: { name: 'YuK1Game', id: 'private-realm-id' }, health: 19, position: { x: -39.5, y: 71.62, z: 24.43 }, positionSource: 'client_prediction', vitals: { hunger: { value: 17, source: 'server_attribute' } }, inventory: { known: true, items: [{ name: 'minecraft:stick', count: 1 }, { name: 'minecraft:stick', count: 4 }, { name: 'minecraft:wooden_pickaxe', count: 1, durabilityKnown: true, durabilityRemaining: 59 }] }, connectionId: 'local-connection' }
}

test('live status exposes foot coordinates, real counts and Japanese labels without inventing missing durability', () => {
  const status = sanitizeStatus(raw(), options)
  assert.equal(status.online, true)
  assert.equal(status.apiAvailable, true)
  assert.equal(status.stale, false)
  assert.equal(status.position.y, 70)
  assert.equal(status.position.confirmed, false)
  assert.equal(status.health, 19)
  assert.equal(status.hunger, 17)
  assert.equal(status.inventoryKnown, true)
  assert.deepEqual(status.inventory[0], { name: 'minecraft:stick', label: '棒', count: 5, durabilityRemaining: null, maxDurability: null })
  assert.equal(status.inventory[1].label, '木のつるはし')
  assert.equal(status.inventory[1].durabilityRemaining, 59)
  assert.equal(status.inventory[1].maxDurability, null)
  assert.equal(status.goal, 'quarry')
  assert.deepEqual(status.milestones, [])
})

test('missing values remain unknown and the former diamond mission cannot create progress', () => {
  const mission = { version: 1, work: { title: '採掘', state: 'complete' }, milestones: [{ id: 'diamond', label: 'ダイヤ', status: 'done', detail: 'unverified claim' }] }
  const status = sanitizeStatus({}, { ...options, apiAvailable: false, mission })
  assert.equal(status.online, false)
  assert.equal(status.health, null)
  assert.equal(status.hunger, null)
  assert.equal(status.position, null)
  assert.equal(status.inventoryKnown, false)
  assert.deepEqual(status.inventory, [])
  assert.notEqual(status.work.state, 'complete')
  assert.equal(status.goal, 'quarry')
  assert.deepEqual(status.milestones, [])
  assert.doesNotMatch(status.work.title, /ダイヤ/)
})

test('authentication is available but not alive, while observed death and zero hunger remain real zeroes', () => {
  const auth = sanitizeStatus({ phase: 'authenticating', auth: { code: 'private-auth-code' } }, options)
  assert.equal(auth.apiAvailable, true)
  assert.equal(auth.online, false)
  assert.equal(auth.stale, false)
  assert.equal(auth.phase, 'authenticating')
  const dead = raw(); dead.health = 0; dead.vitals.hunger.value = 0
  const status = sanitizeStatus(dead, options)
  assert.equal(status.phase, 'dead')
  assert.equal(status.health, 0)
  assert.equal(status.hunger, 0)
  assert.equal(status.online, false)
})

test('offline cache keeps observation time and foot height without counting a second eye offset', () => {
  const seed = sanitizeStatus(raw(), { ...options, apiAvailable: false })
  const cached = sanitizeCachedStatus(seed, { checkedAt: later })
  assert.equal(cached.apiAvailable, false)
  assert.equal(cached.online, false)
  assert.equal(cached.stale, true)
  assert.equal(cached.phase, 'offline')
  assert.equal(cached.observedAt, observedAt)
  assert.equal(cached.checkedAt, later)
  assert.equal(cached.position.y, 70)
  assert.equal(cached.inventory[1].durabilityRemaining, 59)
  assert.equal(sanitizeCachedStatus({ version: 1, health: 20 }), null)
})

test('carried diamonds remain inventory items and cannot complete the quarry goal', () => {
  const value = raw(); value.inventory.items.push({ name: 'minecraft:diamond', count: 1 })
  const mission = { version: 1, milestones: [{ id: 'sword', label: '剣', status: 'done', detail: '過去に作成' }, { id: 'pick', label: 'つるはし', status: 'pending' }, { id: 'base', label: '小屋', status: 'history', detail: '建築実績。現在の閉鎖は未確認。' }] }
  const status = sanitizeStatus(value, { ...options, mission })
  assert.equal(status.inventory.find(row => row.name === 'minecraft:diamond').count, 1)
  assert.equal(status.goal, 'quarry')
  assert.deepEqual(status.milestones, [])
  assert.notEqual(status.work.state, 'complete')
  const past = sanitizeCachedStatus(status, { checkedAt: later })
  assert.equal(past.stale, true)
  assert.equal(past.inventory.find(row => row.name === 'minecraft:diamond').count, 1)
  assert.deepEqual(past.milestones, [])
  value.inventory.uncertain = true
  const uncertain = sanitizeStatus(value, options)
  assert.equal(uncertain.inventoryKnown, false)
  assert.deepEqual(uncertain.inventory, [])
  assert.notEqual(uncertain.work.state, 'complete')
})

test('privacy whitelist removes auth, accounts, raw NBT, stack IDs, caches and arbitrary internal data', () => {
  const value = raw()
  value.auth = { accessToken: 'private-access-token', refreshToken: 'private-refresh-token', code: 'private-auth-code' }
  value.account = 'private-email@example.test'
  value.inventory.items[0].extra = { nbt: { secret: 'private-raw-nbt' } }
  value.inventory.items[0].stackId = 444444
  value.sessionCache = { secret: 'private-session-cache' }
  value.hut = { memo: { private: 'private-memo', site: { center: { x: -9, y: 67, z: 11 } } }, established: true, closed: true }
  value.inventory.items.push({ name: 'mod:unknown', count: 2 }, { name: 'minecraft:diamond', count: 10, source: 'client_prediction' })
  const status = sanitizeStatus(value, options)
  const serialized = JSON.stringify(status)
  for (const privateValue of ['private-access-token', 'private-refresh-token', 'private-auth-code', 'private-email', 'private-raw-nbt', 'private-session-cache', 'private-memo', 'stackId', 'private-realm-id']) assert.ok(!serialized.includes(privateValue), privateValue)
  assert.equal(status.inventory.find(row => row.name === 'mod:unknown').label, 'mod:unknown')
  assert.equal(status.hut, undefined)
  assert.deepEqual(status.milestones, [])
})

test('mission JSON is a bounded text description and has no authority over raw player/items or hidden fields', () => {
  const mission = sanitizeMission({ version: 1, eval: 'never execute', work: { title: 't'.repeat(1000), detail: '<script>literal text</script>', state: 'bogus', secret: 'hidden' }, milestones: Array.from({ length: 40 }, (_, i) => ({ id: String(i), label: '実績', status: 'history' })), recentEvents: Array.from({ length: 40 }, (_, i) => ({ at: observedAt, title: String(i), secret: 'hidden' })) })
  assert.equal(mission.work.title.length, 160)
  assert.equal(mission.work.state, 'waiting')
  assert.equal(mission.work.detail, '<script>literal text</script>')
  assert.equal(mission.milestones.length, 24)
  assert.equal(mission.recentEvents.length, 24)
  assert.ok(!JSON.stringify(mission).includes('hidden'))
  assert.equal(sanitizeMission({ version: 2 }), null)
})

test('item durability, enchants and received shulker contents survive an offline cache round trip', () => {
  const value = raw()
  const slots = Array.from({ length: 36 }, (_, slot) => ({ slot, known: true, empty: true, name: null, count: 0 }))
  slots[9] = {
    slot: 9, known: true, empty: false, name: 'minecraft:iron_pickaxe', count: 1,
    durabilityKnown: true, maxDurability: 250, durabilityRemaining: 171,
    displayName: '<script>literal tool name</script>', lore: ['採掘道具'],
    enchantmentsKnown: true, enchantments: [{ id: 15, name: 'efficiency', label: '効率', level: 3 }],
    stackId: 998877, extra: { nbt: { secret: 'private-nested-nbt' } }
  }
  const contents = Array(27).fill(null)
  contents[7] = { slot: 7, known: true, empty: false, name: 'minecraft:cobblestone', count: 64 }
  slots[10] = { slot: 10, known: true, empty: false, name: 'minecraft:shulker_box', count: 1, container: { known: true, slotCount: 27, slots: contents } }
  value.inventoryDetails = { known: true, uncertain: false, observedAt, selectedSlot: 0, slots, containers: [{ id: 'fake', name: 'private-summary-only' }] }
  const observed = sanitizeStatus(value, options)
  const detail = observed.inventoryDetails
  assert.equal(detail.known, true)
  assert.equal(detail.slots.length, 36)
  assert.equal(detail.slots[0].empty, true)
  assert.equal(detail.slots[9].durabilityRemaining, 171)
  assert.equal(detail.slots[9].durabilityUsed, 79)
  assert.equal(detail.slots[9].enchantments[0].level, 3)
  assert.equal(detail.slots[9].displayName, '<script>literal tool name</script>')
  assert.equal(detail.containers.length, 1)
  assert.equal(detail.containers[0].sourceSlot, 10)
  assert.equal(detail.containers[0].slots[0].empty, true)
  assert.equal(detail.containers[0].slots[7].count, 64)
  assert.doesNotMatch(JSON.stringify(observed), /998877|stackId|private-nested-nbt|private-summary-only/)
  const cached = sanitizeCachedStatus(observed, { checkedAt: later })
  assert.equal(cached.stale, true)
  assert.equal(cached.inventoryDetails.observedAt, observedAt)
  assert.deepEqual(cached.inventoryDetails.slots[9], detail.slots[9])
  assert.equal(cached.inventoryDetails.containers[0].slots[7].count, 64)
})

test('unobserved contents, invalid wear and predicted slots do not become confirmed empty or usable items', () => {
  const value = raw()
  value.inventoryDetails = { known: true, slots: [
    { slot: 0, known: true, empty: false, name: 'minecraft:iron_pickaxe', count: 1, durabilityKnown: true, maxDurability: 250, durabilityRemaining: 251 },
    { slot: 1, known: true, empty: false, name: 'minecraft:shulker_box', count: 1, container: { known: false, slotCount: 27, slots: null, reason: 'NBT_UNOBSERVED' } },
    { slot: 2, known: true, empty: false, name: 'minecraft:diamond', count: 64, source: 'client_prediction' }
  ] }
  const detail = sanitizeStatus(value, options).inventoryDetails
  assert.equal(detail.known, false)
  assert.equal(detail.slots[0].durabilityKnown, false)
  assert.equal(detail.slots[0].durabilityRemaining, null)
  assert.equal(detail.slots[1].container.known, false)
  assert.equal(detail.slots[1].container.slots, null)
  assert.equal(detail.slots[2].known, false)
  assert.equal(detail.slots[2].empty, false)
  assert.equal(detail.slots[3].known, false)
  assert.equal(detail.slots[3].empty, false)
  value.inventory.uncertain = true
  const uncertain = sanitizeStatus(value, options).inventoryDetails
  assert.equal(uncertain.known, false)
  assert.equal(uncertain.containers.length, 0)
  assert.equal(uncertain.slots.every(slot => slot.known === false), true)
})

test('truncated, sparse or invalid container contents remain unconfirmed through the public cache', () => {
  const malformed = [Array(26).fill(null), Array(28).fill(null), Array(27)]
  for (const item of [
    { slot: 7, known: true, empty: false, name: 'minecraft:cobblestone', count: -1 },
    { slot: 7, known: false, empty: false, name: null, count: null },
    { slot: 7, known: true, empty: false, name: 'minecraft:diamond', count: 64, source: 'client_prediction' }
  ]) {
    const contents = Array(27).fill(null)
    contents[7] = item
    malformed.push(contents)
  }
  for (const contents of malformed) {
    const value = raw()
    const slots = Array.from({ length: 36 }, (_, slot) => ({ slot, known: true, empty: true, count: 0 }))
    slots[0] = { slot: 0, known: true, empty: false, name: 'minecraft:shulker_box', count: 1, container: { known: true, slotCount: 27, slots: contents } }
    value.inventoryDetails = {
      known: true, observedAt, slots,
      openContainer: { id: 'window:1', kind: 'chest', known: true, slotCount: 27, slots: contents }
    }
    const observed = sanitizeStatus(value, options)
    for (const status of [observed, sanitizeCachedStatus(observed, { checkedAt: later })]) {
      assert.equal(status.inventoryDetails.slots[0].known, true)
      assert.equal(status.inventoryDetails.slots[0].count, 1)
      assert.equal(status.inventoryDetails.slots[0].container.known, false)
      assert.equal(status.inventoryDetails.slots[0].container.slots, null)
      assert.equal(status.inventoryDetails.containers[0].known, false)
      assert.equal(status.inventoryDetails.containers[0].slots, null)
      assert.equal(status.inventoryDetails.openContainer.known, false)
      assert.equal(status.inventoryDetails.openContainer.slots, null)
    }
  }
})
