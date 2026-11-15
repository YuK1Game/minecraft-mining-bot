'use strict'

// Moved out of idle-safety.js unchanged by scripts/extract-runtime-block.js.
// `rt` exposes the bindings of that closure this code uses; each read or write
// of rt.<name> reads or writes the closure's own variable at that moment.
// Modules are loaded through rt.require, the require of idle-safety.js.

function createIdleSafetyProtect (rt) {
  async function protect (run, value, closeKey) {
    const op = rt.operation = { id: ++rt.sequence, action: null, previousAction: null, owns: false, risk: value.risk, allowedIds: new Set(value.threats.threats.map(actor => actor.runtimeId)) }
    try {
      if (closeKey && run.lastCloseKey !== closeKey) {
        run.lastCloseKey = closeKey; rt.stage(op, 'close_hut'); op.owns = true; rt.status.closures++
        await rt.call(run, op, 'close_hut', signal => rt.closeHut({ state: rt.copy(value.state), signal, operationId: op.id }), { timeout: 3000, mutation: true })
        await rt.cleanup(run, op, 'Idle refuge closure returned')
        value = await rt.inspect(run, op)
      }
      if (!value.risk) {
        if (value.workClearancePending && !value.unknown) { op.risk = true; await rt.escapeOrStop(run, op, value, 'Work pause needs clearance from observed pursuers') }
        return
      }
      op.risk = true
      let target = value.threats.threats[0]
      let physical = value.state.predicted?.physicsState ?? value.state.physicsState
      if (rt.waterCounter && rt.verifyShallowWater && !value.unknown && !run.damage && value.state.health === 20 && rt.emptyHand(value.state) && !value.state.crafting?.openContainer && value.threats.threats.length >= 1 && value.threats.threats.length <= 2 && value.threats.threats.every(actor => actor.name === 'minecraft:creeper') && await rt.call(run, op, 'Verify water counterattack origin', signal => rt.verifyShallowWater(rt.copy(value.state), { signal, operationId: op.id }))) {
        rt.stage(op, 'water_counter'); op.owns = true
        const result = await rt.call(run, op, 'Water counterattack', signal => rt.waterCounter({ state: rt.copy(value.state), threats: rt.copy(value.threats.threats), signal, operationId: op.id }), { mutation: true })
        rt.status.lastWaterCounter = { supported: result?.supported === true, attacked: result?.attacked === true, reason: typeof result?.reason === 'string' ? result.reason.slice(0, 120) : null, detail: typeof result?.detail === 'string' ? result.detail.slice(0, 160) : null, initialThreats: Number.isSafeInteger(result?.initialThreats) ? result.initialThreats : null, targetDistance: Number.isFinite(result?.targetDistance) ? result.targetDistance : null, arrived: result?.arrived === true, serverConfirmed: result?.serverConfirmed === true }
        if (result?.attacked === true) { rt.status.defenses++; rt.status.lastDefense = { action: 'water_counter', phase: result.reason === 'hit_unconfirmed' ? 'requested' : 'observed', reaction: null, reason: result.reason ?? null, serverConfirmed: false, enemyDefeated: null, hitsRequested: 1 } }
        await rt.cleanup(run, op, 'Water counterattack returned'); value = await rt.inspect(run, op)
        if (!value.unknown && !run.damage && !value.threats.threats.length && value.state.health > 10) { rt.report('observing'); return }
        if (result?.attacked === true) { await rt.escapeOrStop(run, op, value, 'Water counterattack requires a safe retreat'); return }
        target = value.threats.threats[0]; physical = value.state.predicted?.physicsState ?? value.state.physicsState
      }
      if (!value.unknown && !run.damage && value.state.health > 6 && value.state.health <= 10 && value.threats.threats.length > 0 && !rt.swordHeld(value.state) && value.state.inventory?.known === true && !value.state.inventory.uncertain && value.state.inventory.items?.some(item => item.count === 1 && rt.SWORD.test(item.name) && !(item.durabilityKnown === true && item.durabilityRemaining <= 0)) && physical?.onGround === true && rt.verifyMeleeBody && !value.state.crafting?.openContainer) {
        op.equipmentHealth = value.state.health
        op.equipmentThreats = new Map(value.threats.threats.map(actor => {
          const entity = (value.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
          return [actor.runtimeId, { name: actor.name, radius: actor.dangerRadius, uniqueId: entity?.uniqueId == null ? null : String(entity.uniqueId) }]
        }))
        if (rt.emergencyEquipmentSafe(value, op) && await rt.call(run, op, 'Verify emergency equipment support', signal => rt.verifyMeleeBody(rt.copy(value.state), { signal, operationId: op.id })) ) {
          rt.stage(op, 'emergency_equip'); op.owns = true
          const swordStock = rt.copy(value.state.inventory.items)
          const equipped = await rt.call(run, op, 'Emergency sword equipment', signal => rt.equipSword({ state: rt.copy(value.state), signal, operationId: op.id }), { timeout: 3000, mutation: true })
          await rt.cleanup(run, op, 'Emergency equipment returned')
          value = await rt.inspect(run, op)
          const expectedSword = swordStock.find(item => item.slot === equipped?.sourceSlot && rt.SWORD.test(item.name) && item.count === 1)
          if (!rt.equipmentReady(equipped, value.state, { sourceSlot: expectedSword?.slot, expectedItem: expectedSword }) || !rt.swordHeld(value.state)) { await rt.escapeOrStop(run, op, value, 'Actual sword equip is unconfirmed'); return }
          if (value.recovering && !value.threats.threats.length) { rt.report('recovering'); return }
          target = value.threats.threats[0]
          physical = value.state.predicted?.physicsState ?? value.state.physicsState
        }
      }
      const zombies = value.threats.threats.filter(actor => actor.name === 'minecraft:zombie')
      const closeMelee = value.threats.threats.filter(actor => ['minecraft:zombie', 'minecraft:spider'].includes(actor.name))
      const creeperTarget = value.state.health > 6 && value.state.health <= 10 && value.threats.threats.length === 1 && value.threats.threats[0].name === 'minecraft:creeper' && value.threats.threats[0].dangerRadius === 8 && value.threats.threats[0].distance <= 3.5 && physical?.onGround === true ? value.threats.threats[0] : null
      const emergencyTarget = creeperTarget ?? (value.state.health > 10 && value.threats.threats.length > 1 && closeMelee.length ? closeMelee.reduce((a, b) => a.distance < b.distance ? a : b) : zombies.length === 1 ? zombies[0] : null)
      const otherThreats = value.threats.threats.filter(actor => actor.runtimeId !== emergencyTarget?.runtimeId)
      const critical = value.state.health > 0 && value.state.health <= 6 && emergencyTarget?.name === 'minecraft:zombie' && emergencyTarget.distance <= 3.5
      const ranged = otherThreats.length === 1 && ['minecraft:skeleton', 'minecraft:stray', 'minecraft:bogged'].includes(otherThreats[0].name) && otherThreats[0].distance >= (critical ? 20 : 18) ? otherThreats[0] : null
      const distantZombie = otherThreats.length === 1 && otherThreats[0].name === 'minecraft:zombie' && otherThreats[0].distance >= 8 && value.state.health > 10 ? otherThreats[0] : null
      const guardedGroup = value.state.health > 10 && otherThreats.length >= 2 && otherThreats.length <= 3 && otherThreats.every(actor => rt.guardedSecondaryMinimum(actor) !== null && actor.distance >= rt.guardedSecondaryMinimum(actor)) ? otherThreats : null
      if (rt.previewEmergency && rt.emergencyStrike && rt.verifyStrikeBody && !value.unknown && (value.state.health > 6 || critical) && (value.state.health <= 10 || distantZombie || guardedGroup) && emergencyTarget && (otherThreats.length === 0 || ranged || distantZombie || guardedGroup) && emergencyTarget.distance <= (critical ? 3.5 : distantZombie || guardedGroup ? 4 : 6) && rt.swordHeld(value.state) && !value.state.crafting?.openContainer && !physical?.isInWater && !physical?.isInLava) {
        target = emergencyTarget
        const find = state => (state.entities ?? []).find(entity => String(entity.runtimeId ?? entity.runtimeEntityId ?? entity.entityId ?? entity.id) === target.runtimeId)
        const actor = find(value.state); const uniqueId = actor?.uniqueId == null ? null : String(actor.uniqueId)
        const secondary = ranged ?? distantZombie
        const secondaryActor = secondary && (value.state.entities ?? []).find(entity => String(entity.runtimeId ?? entity.runtimeEntityId ?? entity.entityId ?? entity.id) === secondary.runtimeId)
        const groupActors = guardedGroup?.map(item => ({ id: item.runtimeId, name: item.name, minimum: rt.guardedSecondaryMinimum(item), uniqueId: (value.state.entities ?? []).find(entity => String(entity.runtimeId ?? entity.runtimeEntityId ?? entity.entityId ?? entity.id) === item.runtimeId)?.uniqueId }))
        if (uniqueId !== null && (!secondary || secondaryActor?.uniqueId != null) && (!groupActors || groupActors.every(item => item.uniqueId != null)) && await rt.call(run, op, 'Verify emergency body', signal => rt.verifyStrikeBody(rt.copy(value.state), { signal, operationId: op.id })) && (!critical || await rt.call(run, op, 'Verify critical body', signal => rt.criticalBodyReady(value.state, { signal, operationId: op.id })) ) && (!creeperTarget || rt.verifyMeleeBody && await rt.call(run, op, 'Verify creeper strike support', signal => rt.verifyMeleeBody(rt.copy(value.state), { signal, operationId: op.id })))) {
          op.targetId = target.runtimeId; op.targetName = target.name; op.targetUniqueId = uniqueId; op.critical = critical; op.creeper = !!creeperTarget; op.secondary = secondary ? { id: secondary.runtimeId, name: secondary.name, uniqueId: String(secondaryActor.uniqueId), minimum: distantZombie ? 8 : critical ? 20 : 18 } : null
          op.secondaryGroup = groupActors?.map(item => ({ ...item, uniqueId: String(item.uniqueId) })) ?? null
          rt.stage(op, 'emergency_preview')
          let preview = null
          for (let n = 0; n < 60; n++) {
            preview = await rt.call(run, op, 'Preview emergency defense', signal => rt.previewEmergency(target.runtimeId, { signal, operationId: op.id, allowDistantRanged: !!ranged, allowDistantZombie: !!distantZombie, allowGuardedGroup: !!guardedGroup, allowCritical: critical, allowEmergencyCreeper: !!creeperTarget }))
            value = await rt.inspect(run, op)
            const latest = find(value.state)
            if (value.recovering && !value.threats.threats.length) { rt.report('recovering'); return }
            if (value.unknown || value.state.health <= (critical ? 0 : 6) || (!distantZombie && !guardedGroup && value.state.health > 10) || !rt.emergencyParticipants(value, op) || !rt.swordHeld(value.state)) break
            if (preview?.ready === true && !(preview.cooldownRemainingMs > 0)) break
            const horizontal = rt.finite(latest?.position) ? Math.hypot(latest.position.x - value.state.position.x, latest.position.z - value.state.position.z) : 0
            if (critical || creeperTarget || horizontal <= 2.6 || !await rt.bodyReady(run, op, value.state, { stationaryMelee: true })) break
            await rt.call(run, op, 'Observe emergency approach', signal => rt.sleep(50, undefined, { signal }))
          }
          if (preview?.ready === true && !(preview.cooldownRemainingMs > 0) && !value.unknown && value.state.health > (critical ? 0 : 6) && (value.state.health <= 10 || distantZombie || guardedGroup) && rt.emergencyParticipants(value, op) && rt.swordHeld(value.state) && await rt.call(run, op, 'Recheck emergency body', signal => rt.verifyStrikeBody(rt.copy(value.state), { signal, operationId: op.id })) && (!critical || await rt.call(run, op, 'Recheck critical body', signal => rt.criticalBodyReady(value.state, { signal, operationId: op.id })) ) && (!creeperTarget || await rt.call(run, op, 'Recheck creeper strike support', signal => rt.verifyMeleeBody(rt.copy(value.state), { signal, operationId: op.id })))) {
            rt.stage(op, 'emergency_strike'); op.owns = true; rt.status.defenses++
            const result = await rt.call(run, op, 'Single emergency defense', signal => rt.emergencyStrike(target.runtimeId, { signal, operationId: op.id, allowDistantRanged: !!ranged, allowDistantZombie: !!distantZombie, allowGuardedGroup: !!guardedGroup, allowCritical: critical, allowEmergencyCreeper: !!creeperTarget }), { timeout: 1500, mutation: true })
            rt.status.lastDefense = { action: 'emergency_strike', phase: result?.phase ?? 'unknown', reaction: result?.reaction ?? null, serverConfirmed: false, enemyDefeated: null, hitsRequested: 1 }
            await rt.cleanup(run, op, 'Single emergency defense returned')
            value = await rt.inspect(run, op)
            if (value.recovering && !value.threats.threats.length) { rt.report('recovering'); return }
          }
        }
        await rt.escapeOrStop(run, op, value, 'Emergency defense requires a safe retreat'); return
      }
      const strikeCandidate = rt.previewStrike && rt.strike && rt.verifyStrikeBody && !value.unknown && value.state.health > 10 && value.threats.threats.length === 1 && rt.MELEE.has(target?.name) && target.distance <= 4 && !physical?.isInWater && !physical?.isInLava && rt.swordHeld(value.state) && !value.state.crafting?.openContainer
      const unsettled = strikeCandidate && !await rt.bodyReady(run, op, value.state, { stationaryMelee: true })
      if (unsettled && await rt.call(run, op, 'Verify airborne body', signal => rt.verifyStrikeBody(rt.copy(value.state), { signal, operationId: op.id }))) {
        const actor = (value.state.entities ?? []).find(entity => String(entity.runtimeId ?? entity.runtimeEntityId ?? entity.entityId ?? entity.id) === target.runtimeId)
        if (actor?.uniqueId != null) {
          rt.stage(op, 'preview_defense')
          const preview = await rt.call(run, op, 'Preview airborne defense', signal => rt.previewStrike(target.runtimeId, { state: rt.copy(value.state), signal, operationId: op.id }))
          value = await rt.inspect(run, op)
          const current = value.threats.threats[0]
          const same = (value.state.entities ?? []).find(entity => String(entity.runtimeId ?? entity.runtimeEntityId ?? entity.entityId ?? entity.id) === target.runtimeId)
          if (preview?.ready === true && !(preview.cooldownRemainingMs > 0) && !value.unknown && value.threats.threats.length === 1 && current?.runtimeId === target.runtimeId && current.name === target.name && String(same?.uniqueId) === String(actor.uniqueId) && rt.swordHeld(value.state) && value.state.health > 10) {
            rt.stage(op, 'strike'); op.owns = true; rt.status.defenses++
            const result = await rt.call(run, op, 'Single airborne defense', signal => rt.strike(target.runtimeId, { signal, operationId: op.id }), { timeout: 1500, mutation: true })
            rt.status.lastResult = { action: 'strike', phase: result?.phase ?? 'unknown', serverConfirmed: result?.serverConfirmed === true, enemyDefeated: null }
            rt.status.lastDefense = { ...rt.status.lastResult, hitsRequested: 1 }
            await rt.cleanup(run, op, 'Single airborne defense returned')
            value = await rt.inspect(run, op)
            if (!value.unknown && !value.threats.threats.length && value.state.health > 10) { run.damage = false; run.damageUnderCover = false; rt.report('observing'); return }
          }
        }
        await rt.escapeOrStop(run, op, value, 'Airborne defense did not clear danger'); return
      }
      // A single melee enemy may approach while the already-equipped sword
      // is ready. The actual body/line-of-sight oracle decides attack range;
      // eye-to-feet avoidance distance is not an attack-range measurement.
      if (!value.unknown && value.state.health > 10 && value.threats.threats.length === 1 && rt.MELEE.has(target?.name) && target.name !== 'minecraft:drowned' && target.distance <= 12 && rt.swordHeld(value.state) && !value.state.crafting?.openContainer && await rt.bodyReady(run, op, value.state, { stationaryMelee: true })) {
        const findTarget = state => (state.entities ?? []).find(entity => String(entity.runtimeId ?? entity.runtimeEntityId ?? entity.entityId ?? entity.id) === target.runtimeId)
        const initialActor = findTarget(value.state)
        const uniqueId = initialActor?.uniqueId == null ? null : String(initialActor.uniqueId)
        if (uniqueId !== null) {
          rt.stage(op, 'preview_defense')
          let ready = false
          for (let n = 0; n < 120; n++) {
            const preview = await rt.call(run, op, 'Preview approaching melee', signal => rt.previewEngage(target.runtimeId, { state: rt.copy(value.state), signal, operationId: op.id }))
            if (preview?.ready === true) { ready = true; break }
            const actor = findTarget(value.state)
            const horizontal = actor?.position && rt.finite(actor.position) ? Math.hypot(actor.position.x - value.state.position.x, actor.position.z - value.state.position.z) : 0
            // If the enemy is already too close without a usable attack face,
            // escape instead of waiting for it to hit the player.
            if (horizontal <= 2.6) break
            await rt.call(run, op, 'Observe approaching melee', signal => rt.sleep(50, undefined, { signal }))
            value = await rt.inspect(run, op)
            if (!value.unknown && !value.threats.threats.length && !run.damage) { rt.report('observing'); return }
            const current = value.threats.threats[0]; const entity = findTarget(value.state)
            if (value.unknown || run.damage || value.state.health <= 10 || value.threats.threats.length !== 1 || current?.runtimeId !== target.runtimeId || current.name !== target.name || String(entity?.uniqueId) !== uniqueId || !rt.swordHeld(value.state) || !await rt.bodyReady(run, op, value.state, { stationaryMelee: true })) { await rt.escapeOrStop(run, op, value, 'Idle melee approach became unsafe'); return }
            target = current
          }
          if (!ready) { await rt.escapeOrStop(run, op, value, 'No safe melee attack opportunity'); return }
        }
      }
      if (value.unknown || !(value.state.health > 10) || value.threats.threats.length !== 1 || !rt.MELEE.has(target?.name) || target.distance > 4 || value.state.inventory?.known !== true || value.state.inventory.uncertain || !await rt.bodyReady(run, op, value.state, { stationaryMelee: true })) { await rt.escapeOrStop(run, op, value, 'Idle danger cannot be safely defended'); return }
      rt.stage(op, 'equip_sword'); op.owns = true
      const swordStock = rt.copy(value.state.inventory.items)
      const equipped = await rt.call(run, op, 'equip_sword', signal => rt.equipSword({ state: rt.copy(value.state), signal, operationId: op.id }), { mutation: true })
      value = await rt.inspect(run, op)
      const expectedSword = swordStock.find(item => item.slot === equipped?.sourceSlot && rt.SWORD.test(item.name) && item.count === 1)
      if (!rt.equipmentReady(equipped, value.state, { sourceSlot: expectedSword?.slot, expectedItem: expectedSword }) || !rt.swordHeld(value.state)) { await rt.escapeOrStop(run, op, value, 'Actual sword equip is unconfirmed'); return }
      rt.stage(op, 'close_gui')
      await rt.call(run, op, 'close_gui', signal => rt.closeGui({ signal, operationId: op.id }), { mutation: true })
      value = await rt.inspect(run, op)
      if (value.state.crafting?.openContainer || !await rt.bodyReady(run, op, value.state, { stationaryMelee: true })) { await rt.escapeOrStop(run, op, value, 'Known body or closed GUI is unconfirmed'); return }
      rt.stage(op, 'preview_defense')
      const preview = await rt.call(run, op, 'preview_defense', signal => rt.previewEngage(target.runtimeId, { state: rt.copy(value.state), signal, operationId: op.id }))
      if (preview?.ready !== true) { await rt.escapeOrStop(run, op, value, 'Exact idle defense oracle refused'); return }
      value = await rt.inspect(run, op)
      if (!(value.state.health > 10) || value.unknown || value.threats.threats.length !== 1 || value.threats.threats[0].runtimeId !== target.runtimeId || value.threats.threats[0].name !== target.name || !rt.swordHeld(value.state)) { await rt.escapeOrStop(run, op, value, 'Fresh idle defense state changed after preview'); return }
      op.targetName = target.name
      rt.stage(op, 'engage'); rt.status.defenses++
      const result = await rt.call(run, op, 'engage', signal => rt.engage(target.runtimeId, { durationMs: 5500, maxHits: 8, signal, operationId: op.id }), { timeout: 6000, mutation: true })
      rt.status.lastResult = { action: 'engage', phase: result?.phase ?? 'unknown', reaction: result?.reaction ?? null, serverConfirmed: result?.serverConfirmed === true, enemyDefeated: null }
      const defenseReason = String(result?.reason ?? '')
      const reasonCode = /対象への視線/.test(defenseReason) ? 'SIGHT' : /近接範囲/.test(defenseReason) ? 'RANGE' : /位置が変わった/.test(defenseReason) ? 'PLAYER_MOVED' : /対象.*(?:位置|個体|種類|次元|生存)/.test(defenseReason) ? 'TARGET_CHANGED' : /体力|ダメージ/.test(defenseReason) ? 'HEALTH' : /持ち物|剣|スロット|主手/.test(defenseReason) ? 'EQUIPMENT' : /入力|視線を向ける/.test(defenseReason) ? 'INPUT' : /別の危険な敵|位置が不明な敵/.test(defenseReason) ? 'OTHER_THREAT' : defenseReason ? 'OTHER' : null
      rt.status.lastDefense = { ...rt.status.lastResult, code: typeof result?.code === 'string' && /^[a-z_]{1,40}$/.test(result.code) ? result.code : null, reasonCode, hitsRequested: Number.isSafeInteger(result?.hitsRequested) ? result.hitsRequested : null }
      await rt.cleanup(run, op, 'Bounded idle defense returned')
      value = await rt.inspect(run, op)
      if (!value.unknown && !value.threats.threats.length && value.state.health > 10) { run.damage = false; run.damageUnderCover = false; rt.report('observing'); return }
      await rt.escapeOrStop(run, op, value, 'Idle danger remains after bounded defense')
    } catch (error) {
      rt.status.lastError = error.message
      if (!rt.valid(run) || ['CANCELLED', 'YIELD', 'DEAD', 'COVERED', 'SCOPE_CHANGED'].includes(error.code)) {
        if (error.code === 'YIELD') { rt.status.graceUntil = rt.now() + rt.graceMs; run.lastCloseKey = null }
        if (error.code === 'COVERED' || error.code === 'DEAD') { run.damage = false; run.damageUnderCover = false; rt.report(error.code === 'COVERED' ? 'covered' : 'dead') }
        if (error.code === 'SCOPE_CHANGED') rt.halt(run, 'Scope changed')
      } else {
        try { await rt.escapeOrStop(run, op, value, error.message) } catch (secondary) { if (rt.valid(run) && !['YIELD', 'DEAD', 'COVERED', 'SCOPE_CHANGED'].includes(secondary.code)) await rt.emergency(run, op, value, secondary.message) }
      }
    } finally {
      await rt.cleanup(run, op, 'Idle protection episode ended')
      if (rt.operation === op) rt.operation = null
      rt.status.active = null; rt.status.busy = false
    }
  }
  return {
    protect
  }
}

module.exports = { createIdleSafetyProtect }
