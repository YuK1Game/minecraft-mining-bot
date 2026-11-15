'use strict'

// A stage of escapeOrStop in idle-safety-escape.js, moved here unchanged by scripts/extract-stage.js.
// `st` exposes the locals of that function this stage uses; each read or write
// of st.<name> reads or writes the caller's own variable at that moment.
// It returns { value } where the caller returns that value.

async function unarmedFallback (rt, st) {
    if (await rt.holdWorkClearance(st.run, st.op)) return { value: undefined }
    // When a healthy freshly respawned player is trapped with no sword, a
    // A known zombie or already-close drowned can be pushed back with ordinary
    // unarmed attacks. A drowned may carry a trident, so never wait for a
    // distant drowned to approach or pursue it.
    const unarmedMelee = st.value.threats.threats.filter(actor => actor.name === 'minecraft:zombie' || actor.name === 'minecraft:drowned' && actor.distance <= 4)
    const unarmedTarget = unarmedMelee.length === 1 ? unarmedMelee[0] : null
    const unarmedOthers = st.value.threats.threats.filter(actor => actor.runtimeId !== unarmedTarget?.runtimeId)
    const unarmedRanged = unarmedOthers.length === 1 && ['minecraft:skeleton', 'minecraft:stray', 'minecraft:bogged'].includes(unarmedOthers[0].name) && unarmedOthers[0].distance >= 16 ? unarmedOthers[0] : null
    if (!st.run.damage && !st.value.unknown && rt.emptyHand(st.value.state) && unarmedTarget && (unarmedOthers.length === 0 || unarmedRanged && unarmedTarget.name === 'minecraft:zombie') && (!unarmedRanged || unarmedTarget.distance <= 4) && rt.previewStrike && rt.strike && rt.verifyMeleeBody && !st.value.state.crafting?.openContainer) {
      const target = unarmedTarget
      const entity = (st.value.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === target.runtimeId)
      const rangedActor = unarmedRanged && (st.value.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === unarmedRanged.runtimeId)
      if (entity?.uniqueId != null && (!unarmedRanged || rangedActor?.uniqueId != null) && await rt.call(st.run, st.op, 'Verify unarmed defense support', signal => rt.unarmedBodyReady(st.value.state, { signal, operationId: st.op.id }))) {
        st.op.targetId = target.runtimeId; st.op.unarmedTargetName = target.name; st.op.targetUniqueId = String(entity.uniqueId); st.op.unarmedSecondary = unarmedRanged ? { id: unarmedRanged.runtimeId, name: unarmedRanged.name, uniqueId: String(rangedActor.uniqueId) } : null; st.op.allowedIds = new Set([target.runtimeId, ...(unarmedRanged ? [unarmedRanged.runtimeId] : [])])
        rt.stage(st.op, 'unarmed_preview')
        let strikes = 0
        for (let attempt = 0; attempt < 1200; attempt++) {
          const preview = await rt.call(st.run, st.op, 'Preview unarmed defense', signal => rt.previewStrike(target.runtimeId, { signal, operationId: st.op.id }))
          st.value = await rt.inspect(st.run, st.op)
          if (st.value.unknown || st.run.damage || !rt.emptyHand(st.value.state) || !rt.unarmedParticipants(st.value, st.op)) break
          if (preview?.ready === true && !(preview.cooldownRemainingMs > 0)) {
            if (target.name === 'minecraft:zombie' && !unarmedRanged) {
              const committed = await rt.call(st.run, st.op, 'Preview committed unarmed defense', signal => rt.previewEngage(target.runtimeId, { allowUnarmed: true, signal, operationId: st.op.id }))
              st.value = await rt.inspect(st.run, st.op)
              if (committed?.ready !== true || st.value.unknown || st.run.damage || !rt.emptyHand(st.value.state) || !rt.unarmedParticipants(st.value, st.op) || !await rt.unarmedBodyReady(st.value.state, { operationId: st.op.id })) break
              st.op.unarmedCommitted = true; st.op.unarmedHand = rt.unarmedHandKey(st.value.state); st.op.targetName = target.name
              rt.stage(st.op, 'engage'); st.op.owns = true; rt.status.defenses++
              const result = await rt.call(st.run, st.op, 'Committed unarmed defense', signal => rt.engage(target.runtimeId, { allowUnarmed: true, durationMs: 30000, maxHits: 24, signal, operationId: st.op.id }), { timeout: 30500, committedDefense: true, mutation: true })
              rt.status.lastResult = { action: 'unarmed_engage', phase: result?.phase ?? 'unknown', reaction: result?.reaction ?? null, serverConfirmed: result?.serverConfirmed === true, enemyDefeated: null }
              rt.status.lastDefense = { ...rt.status.lastResult, code: result?.code ?? null, hitsRequested: result?.hitsRequested ?? null }
              await rt.cleanup(st.run, st.op, 'Committed unarmed defense returned'); st.value = await rt.inspect(st.run, st.op)
              if (result?.targetStopped === true && result.serverConfirmed === true && !st.value.unknown && !st.value.threats.threats.length && st.value.state.health > 6 && await rt.unarmedBodyReady(st.value.state, { operationId: st.op.id }, { continuation: true })) { st.run.damage = false; st.run.damageUnderCover = false; rt.report('observing'); return { value: undefined } }
              break
            }
            rt.stage(st.op, 'unarmed_strike'); st.op.owns = true; rt.status.defenses++
            const result = await rt.call(st.run, st.op, 'Single unarmed defense', signal => rt.strike(target.runtimeId, { signal, operationId: st.op.id }), { timeout: 1500, mutation: true })
            strikes++
            rt.status.lastDefense = { action: 'unarmed_strike', phase: result?.phase ?? 'unknown', reaction: result?.reaction ?? null, serverConfirmed: result?.serverConfirmed === true, enemyDefeated: null, hitsRequested: 1 }
            await rt.cleanup(st.run, st.op, 'Unarmed defense returned'); st.value = await rt.inspect(st.run, st.op)
            if (!st.value.unknown && !st.value.threats.threats.length && !st.run.damage && st.value.state.health >= 18) { rt.report('observing'); return { value: undefined } }
            if (strikes < 24 && !st.value.unknown && !st.run.damage && rt.emptyHand(st.value.state) && rt.unarmedParticipants(st.value, st.op)) { rt.stage(st.op, 'unarmed_preview'); continue }
            break
          }
          // Do not wait for a distant target to approach while a ranged enemy
          // is present. A confirmed in-range target may wait out the ordinary
          // attack cooldown under the same monitored distance checks.
          if ((unarmedRanged || target.name === 'minecraft:drowned') && !(strikes > 0 && preview?.ready === true && preview.cooldownRemainingMs > 0)) break
          await rt.call(st.run, st.op, 'Observe zombie approach', signal => rt.sleep(50, undefined, { signal }))
        }
      }
    }
    await rt.emergency(st.run, st.op, st.value, st.reason)
}

module.exports = { unarmedFallback }
