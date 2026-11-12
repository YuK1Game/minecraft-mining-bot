'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { serialize } = require('node:v8')
const { createLoadoutReset } = require('./loadout-reset')
const { createQuarryV22Reset } = require('./quarry-v22-reset')
const { createLoadoutCommand } = require('./loadout-command')
const { writeDurableJson, readJsonBounded } = require('./durable-json')
const { isShulkerBox } = require('./container-types')
const failure = (code, message = code) => Object.assign(new Error(message), { code })

function createRuntimeLoadoutReset ({ host, getState, inspection, crafting, armor, inventory, chest, assertIdle, acquire, release, getJob, generation, cancelTransfers, journalDirectory = path.resolve(__dirname, '..', '.local', 'loadout-reset') }) {
  const worldKey = () => { const s = getState(); return createHash('sha256').update(JSON.stringify([s.profile, String(s.realm?.id), s.dimension])).digest('hex') }
  const file = (key = worldKey()) => {
    if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) throw failure('RESET_JOURNAL_WORLD_INVALID')
    return path.join(journalDirectory, `${key}.json`)
  }
  const getView = () => {
    const view = inspection.snapshot(getState())
    for (const item of view.slots) {
      const raw = crafting.rawItem(item.slot)
      // A reset's successful /replaceitem creates a new plain box. No NBT is
      // accepted as emptiness only in combination with that command receipt.
      item.resetPlainEmptyBox = isShulkerBox(item.name) && [false, 'false', 0].includes(raw?.extra?.has_nbt) && raw.extra.nbt == null && Array.isArray(raw.extra.can_destroy) && !raw.extra.can_destroy.length && Array.isArray(raw.extra.can_place_on) && !raw.extra.can_place_on.length
    }
    return view
  }
  function resetState () {
    // Explicit operator debugging: actor proximity/unknown actor positions are
    // not admission criteria. Do not alter the ordinary combat threat model.
    return { ...getState(), loadingScreenEnded: host.shared.loadingScreenEnded === true }
  }
  const commands = createLoadoutCommand({ client: host.client, getState: resetState })
  const adapter = {
    getState: resetState, getView, getBlock: (x, y, z) => host.world.getBlock(x, y, z), generation,
    assertIdle: () => {
      assertIdle()
      const observed = crafting.snapshot()
      if (observed.authority !== true || observed.inventoryKnown !== true || observed.pendingRequestId != null) throw failure('RESET_AUTHORITY_UNKNOWN', 'サーバー権威の所持品状態を確認してから実行してください。')
      const j = getJob(), d = j?.document(), s = j?.status()
      if (s?.state && !['IDLE', 'PAUSED', 'FINISHED'].includes(s.state) || j?.holdsWork?.() || s?.persistence?.status === 'failed' || d?.portableStorage || d?.supplyRestock || d?.egress?.operationId && !d.surfaceReturnedAt || crafting.status?.().openContainer) throw failure('RESET_JOB_PENDING', '採掘を停止し、収納・回収・保存の未確定状態を解消してください。')
    },
    protectedAt: p => (getJob()?.document()?.config?.permissions?.protectedRegion ?? []).some(b => p.x >= b.xMin && p.x <= b.xMax && p.y >= b.yMin && p.y <= b.yMax && p.z >= b.zMin && p.z <= b.zMax),
    acquire, release,
    jobIdentity: () => { const d = getJob()?.document(); return d ? `${d.instanceId}:${d.state}:${d.userRunIntent}` : null },
    cancelJob: async () => {
      const job = getJob()
      if (job?.document()) {
        const s = await job.cancel()
        if (s?.state !== 'FINISHED' || s.persistence?.status === 'failed') throw failure('RESET_JOB_STOP_UNCONFIRMED')
      }
      host.shared.quarryAutoResume = false; host.shared.quarryRestoreDisabled = true
    },
    save: async value => { await fs.mkdir(journalDirectory, { recursive: true }); return writeDurableJson(file(value.world), value) },
    load: async () => { try { return await readJsonBounded(file()) } catch (error) { if (error.code === 'ENOENT') return null; throw error } },
    select: (slot, options) => inventory.selectHotbarForReset(slot, options),
    equipArmor: () => armor.equipBest({ maxMoves: 1 }),
    open: async p => { crafting.closeContainer(); return chest.open(p, undefined, { expectedSlots: 27 }) },
    close: async () => { crafting.closeContainer() },
    deposit: value => chest.depositItem(value),
    container: () => inspection.snapshot(getState()).openContainer,
    cancelTransfers
  }
  return createLoadoutReset({ adapter, commands })
}

// A job blocks the surface-chest reset while it may still act: running, its
// persistence failed, or (unless it was cancelled to FINISHED) an unfinished
// container, supply or exit operation. A FINISHED job never resumes; its
// records of unfinished work stay in its document (live 2026-11-11 18:40: a
// cancelled job's placed supply box kept every reset refused).
function jobPending (job) {
  const d = job?.document?.(), state = job?.status?.()
  if (state?.state && !['IDLE', 'PAUSED', 'FINISHED'].includes(state.state)) return true
  if (job?.holdsWork?.() || state?.persistence?.status === 'failed') return true
  if (state?.state === 'FINISHED' && d?.state === 'FINISHED') return false
  return Boolean(d?.portableStorage || d?.supplyRestock || d?.egress?.operationId && !d?.surfaceReturnedAt)
}

// Reset admission can describe unknown equipment, but clearing must observe
// actual slot packets. ACK-derived Armor/UI state cannot prove an empty slot.
function receivedEquipmentView (inspection, crafting, state) {
  if (typeof inspection.rawEquipment !== 'function') throw failure('RESET_RECEIPTS_UNAVAILABLE')
  const view = inspection.snapshot(state)
  for (const [kind, size] of [['armor', 4], ['offhand', 1]]) {
    const slots = Array.from({ length: size }, (_, slot) => {
      const raw = inspection.rawEquipment(kind, slot)
      if (!raw) return { slot, known: false, empty: false, name: null, count: null }
      const empty = raw.network_id === 0 && raw.count === 0
      return {
        slot, known: true, empty,
        name: empty ? null : crafting.itemNameOf(raw.network_id), count: raw.count,
        networkId: raw.network_id, stackId: raw.stack_id ?? 0, metadata: raw.metadata ?? 0,
        receiptIdentity: createHash('sha256').update(serialize(raw)).digest('hex')
      }
    })
    view[kind] = { known: slots.every(slot => slot.known), slots }
  }
  return view
}

function createRuntimeV22ChestReset ({
  host, getState, inspection, crafting, armor, inventory, chest,
  assertIdle, acquire, release, getJob, generation, cancelTransfers,
  journalDirectory = path.resolve(__dirname, '..', '.local', 'loadout-reset-v22')
}) {
  const worldKey = () => {
    const state = getState()
    return createHash('sha256').update(JSON.stringify([state.profile, String(state.realm?.id), state.dimension])).digest('hex')
  }
  const filename = world => path.join(journalDirectory, (world == null ? worldKey() : createHash('sha256').update(world).digest('hex')) + '.json')
  const command = createLoadoutCommand({ client: host.client, getState })
  const jobIdentity = (job = getJob()) => {
    const doc = job?.document()
    return doc ? `${doc.instanceId}:${doc.state}:${doc.userRunIntent}` : null
  }
  const adapter = {
    getState,
    getView: () => receivedEquipmentView(inspection, crafting, getState()),
    getBlock: (x,y,z) => host.world.getBlock(x,y,z),
    generation,
    assertIdle: () => {
      assertIdle()
      const current = crafting.snapshot(), job = getJob(), d = job?.document(), state = job?.status()
      if (current.authority !== true || current.inventoryKnown !== true || current.pendingRequestId != null ||
        jobPending(job) || current.openContainer) throw failure('RESET_JOB_PENDING')
    },
    acquire, release, jobIdentity,
    cancelJob: async ({ expectedJobIdentity } = {}) => {
      const job = getJob()
      const previousJobIdentity = jobIdentity(job), instanceId = job?.document()?.instanceId
      if (previousJobIdentity !== expectedJobIdentity) throw failure('RESET_JOB_CHANGED')
      if(job?.document()){
        const status = await job.cancel()
        if(status?.state !== 'FINISHED' || status.persistence?.status === 'failed')throw failure('RESET_JOB_STOP_UNCONFIRMED')
      }
      if (getJob() !== job || job?.document()?.instanceId !== instanceId) throw failure('RESET_JOB_CHANGED')
      host.shared.quarryAutoResume = false
      host.shared.quarryRestoreDisabled = true
      return { serverConfirmed: true, previousJobIdentity, jobIdentity: jobIdentity(job) }
    },
    save: async value => {
      await fs.mkdir(journalDirectory,{recursive:true})
      return writeDurableJson(filename(value.world),value)
    },
    load: async () => {
      try { return await readJsonBounded(filename()) }
      catch(error){if(error.code==='ENOENT')return null;throw error}
    },
    select: (slot, options) => inventory.selectHotbarForReset(slot,options),
    open: async (p, size) => {crafting.closeContainer();return chest.open(p,undefined,{expectedSlots:size})},
    close: async () => {crafting.closeContainer()},
    deposit: options => chest.depositItem(options),
    container: () => inspection.snapshot(getState()).openContainer,
    cancelTransfers,
    publishHomeSite: site => {host.shared.quarryV22HomeChest = structuredClone(site)}
  }
  return createQuarryV22Reset({adapter,commands:command})
}

module.exports = { createRuntimeLoadoutReset, createRuntimeV22ChestReset, jobPending, receivedEquipmentView }
