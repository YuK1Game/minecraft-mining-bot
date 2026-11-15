'use strict'

// A stage of storeCarried in quarry-portable-store.js, moved here unchanged by scripts/extract-stage.js.
// `stage` exposes the locals of that function this stage uses; each read or write
// of stage.<name> reads or writes the caller's own variable at that moment.
// It returns { value } where the caller returns that value.

async function packContainer (rt, stage) {
        if (stage.cp.kind !== 'shulker') { stage.close(); stage.cp.stage = 'completed'; await stage.save(); stage.guard(); return { value: stage.result(stage.cp.full ? 'full' : 'completed') } }
        if (rt.freeSlots(stage.guard().items) < 1) throw rt.failure('STORAGE_RECOVERY_SLOT_REQUIRED')
        stage.requirePickupRoom('before_packing')
        const rawSlots = Array.from({ length: 27 }, (_, slot) => rt.chest.rawItem(slot))
        if (rt.chest.snapshot().contentsKnown !== true || !rt.readContainerContents(rawSlots, { resolveName: id => rt.crafting.itemNameOf?.(id) }).known) throw rt.failure('STORAGE_CONTENTS_UNKNOWN')
        stage.cp.expectedContents = rt.pack(rawSlots); stage.cp.stage = 'packed'; await stage.save(); stage.close()
        stage.current = stage.guard()
        stage.cp.recoveryBaseline = stage.current.items.filter(item => rt.isShulkerBox(item.name)).map(item => ({ name: item.name, count: item.count, stackId: item.stackId }))
        // Live 2026-11-14 02:12 (storage:25): combat cut into the pre-break wait
        // below and the unsaved baseline made the final checkpoint differ
        // (STORAGE_FINAL_CHECKPOINT_CHANGED). Every change is saved before waiting.
        await stage.save()
        // Live 2026-11-13 14:20 (storage:692): combat cut into the box break and
        // the box never came back. With a received hostile within 16 m the
        // break of the owned box waits (up to 20 s) for the area to clear.
        const hostileNear = () => { stage.guard(); const st = rt.getState(), list = rt.getEntities(); return Array.isArray(list) && list.some(a => a?.kind === 'mob' && a.hostile === true && a.alive !== false && a.position && st?.position && Math.hypot(a.position.x - st.position.x, a.position.y - st.position.y, a.position.z - st.position.z) <= 16) }
        for (const until = rt.now() + 20000; hostileNear() && rt.now() < until;) { if (stage.cp.breakWaitedForHostile !== true) { stage.cp.breakWaitedForHostile = true; await stage.save() } await rt.sleep(250) }
        stage.cp.stage = 'breaking'; stage.cp.intent = { type: 'break', position: rt.copy(stage.cp.positions[0]) }; await stage.save()
}

module.exports = { packContainer }
