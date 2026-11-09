'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { createLoadoutReset } = require('./loadout-reset')
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
    select: slot => inventory.equipForCombat(slot),
    equipArmor: () => armor.equipBest({ maxMoves: 1 }),
    open: async p => { crafting.closeContainer(); return chest.open(p, undefined, { expectedSlots: 27 }) },
    close: async () => { crafting.closeContainer() },
    deposit: value => chest.depositItem(value),
    container: () => inspection.snapshot(getState()).openContainer,
    cancelTransfers
  }
  return createLoadoutReset({ adapter, commands })
}
module.exports = { createRuntimeLoadoutReset }
