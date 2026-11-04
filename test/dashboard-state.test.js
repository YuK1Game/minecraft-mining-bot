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
  assert.equal(status.milestones.find(row => row.id === 'diamond').status, 'pending')
})

test('missing values remain unknown and a mission completion claim cannot create an actual diamond', () => {
  const mission = { version: 1, work: { title: '採掘', state: 'complete' }, milestones: [{ id: 'diamond', label: 'ダイヤ', status: 'done', detail: 'unverified claim' }] }
  const status = sanitizeStatus({}, { ...options, apiAvailable: false, mission })
  assert.equal(status.online, false)
  assert.equal(status.health, null)
  assert.equal(status.hunger, null)
  assert.equal(status.position, null)
  assert.equal(status.inventoryKnown, false)
  assert.deepEqual(status.inventory, [])
  assert.equal(status.work.state, 'waiting')
  assert.equal(status.milestones[0].status, 'pending')
  assert.match(status.milestones[0].detail, /未確認/)
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

test('only confirmed inventory can mark the diamond complete and historical gear is distinguished from current items', () => {
  const value = raw(); value.inventory.items.push({ name: 'minecraft:diamond', count: 1 })
  const mission = { version: 1, milestones: [{ id: 'sword', label: '剣', status: 'done', detail: '過去に作成' }, { id: 'pick', label: 'つるはし', status: 'pending' }, { id: 'base', label: '小屋', status: 'history', detail: '建築実績。現在の閉鎖は未確認。' }] }
  const status = sanitizeStatus(value, { ...options, mission })
  assert.equal(status.milestones.find(row => row.id === 'diamond').status, 'done')
  assert.equal(status.milestones.find(row => row.id === 'sword').status, 'history')
  assert.equal(status.milestones.find(row => row.id === 'pick').status, 'done')
  assert.equal(status.milestones.find(row => row.id === 'base').status, 'history')
  const past = sanitizeCachedStatus(status, { checkedAt: later })
  assert.match(past.milestones.find(row => row.id === 'diamond').detail, /最終確認時|過去/)
  value.inventory.uncertain = true
  const uncertain = sanitizeStatus(value, options)
  assert.equal(uncertain.inventoryKnown, false)
  assert.equal(uncertain.milestones.find(row => row.id === 'diamond').status, 'pending')
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
  assert.equal(status.hut.known, false)
  assert.equal(status.hut.closed, null)
  assert.equal(status.milestones.find(row => row.id === 'diamond').status, 'pending')
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
