'use strict'

// A stage of a function in idle-safety-runtime.js, moved here unchanged by scripts/extract-stage.js.
// `st` exposes the locals of that function this stage uses; each read or write
// of st.<name> reads or writes the caller's own variable at that moment.
// It returns { value } where the caller returns that value.

function reportEmergencyStop (rt, st) {
        if (!st.safetyCurrent() || !rt.host.shared.safetyWanted || String(st.details.enableEpoch) !== String(rt.host.shared.safetyEnableEpoch)) return { value: undefined }
        const previous = rt.host.shared.safetyEmergency
        const captureDue = !previous || previous.scope !== st.safetyOriginScope || Date.now() - Date.parse(previous.capturedAt ?? previous.at) >= 5000
        const receipt = { enableEpoch: rt.host.shared.safetyEnableEpoch, scope: st.safetyOriginScope, status: 'remaining_online', reason: st.details.reason, health: st.details.health, at: new Date().toISOString(), capturedAt: captureDue ? new Date().toISOString() : previous.capturedAt ?? previous.at, retries: (previous?.retries ?? 0) + 1, retryAt: st.details.retryAt ?? null }
        const dispatchEpoch = rt.safetyDispatchEpoch
        rt.host.shared.safetyEmergency = receipt
        // Reporting is local. A failed defense keeps the connection, wanted
        // state and supervisor alive; confirmed death uses normal recovery.
        setImmediate(() => {
          if (!st.safetyCurrent() || !rt.host.shared.safetyWanted || dispatchEpoch !== rt.safetyDispatchEpoch || rt.host.shared.safetyEmergency !== receipt || receipt.enableEpoch !== rt.host.shared.safetyEnableEpoch) { receipt.status = 'cancelled'; return }
          try { Promise.resolve(rt.host.onEmergency?.({ ...st.details, continuedOnline: true })).catch(error => rt.host.log(`待機保護の記録: ${error.message}`)) } catch (error) { rt.host.log(`待機保護の記録: ${error.message}`) }
          if (!captureDue) return
          try {
            const reasonCode = new Map([
              ['Idle danger cannot be safely defended', 'DEFENSE_UNAVAILABLE'],
              ['Actual sword equip is unconfirmed', 'SWORD_UNCONFIRMED'],
              ['Known body or closed GUI is unconfirmed', 'BODY_OR_GUI_UNCONFIRMED'],
              ['Exact idle defense oracle refused', 'DEFENSE_PREVIEW_REFUSED'],
              ['Fresh idle defense state changed after preview', 'DEFENSE_STATE_CHANGED'],
              ['Idle danger remains after bounded defense', 'DANGER_REMAINS'],
              ['プレイヤー位置・次元が変わりました。', 'POSITION_OR_DIMENSION_CHANGED']
            ]).get(st.details.reason) ?? 'IDLE_PROTECTION_UNRESOLVED'
            const observed = rt.raw()
            const phase = ['starting', 'connecting', 'joining', 'spawned', 'dead', 'disconnected'].includes(observed.phase) ? observed.phase : 'unknown'
            rt.host.log(`待機保護の非常停止: reasonCode=${reasonCode} health=${Number.isFinite(observed.health) ? observed.health : 'unknown'} phase=${phase} sameScope=true`)
            if (process.env.MINECRAFT_CAPTURE_EMERGENCY === '1') {
              try {
                const current = st.safetyState(); const p = current.position
                if (p && ['x', 'y', 'z'].every(axis => Number.isFinite(p[axis])) && typeof rt.host.world.getArea === 'function') {
                  const center = { x: Math.floor(p.x), y: Math.floor(p.y - 1.62), z: Math.floor(p.z) }
                  const protection = rt.generationSafety.snapshot()
                  const lowerTerrain = []
                  // Bound diagnostic capture to nearby received terrain; it is
                  // evidence only and never authorizes a movement by itself.
                  for (let x = center.x - 6; x <= center.x + 6; x++) for (let z = center.z - 6; z <= center.z + 6; z++) for (let y = center.y - 12; y <= center.y + 4; y++) lowerTerrain.push(rt.host.world.getBlock(x, y, z))
                  const motion = rt.generationMovement.snapshot()
                  const guardStatus = st.generationGuardRoute.snapshot()
                  const capturePoint = point => point && ['x', 'y', 'z'].every(axis => Number.isFinite(point[axis])) ? { x: point.x, y: point.y, z: point.z } : null
                  const captureText = value => typeof value === 'string' ? value.slice(0, 300) : null
                  const inputStatus = rt.generationStream.stats()
                  const capture = { observedAt: new Date().toISOString(), health: current.health, position: p, rawServerPosition: current.rawServerPosition, predicted: current.predicted, realmId: current.realm?.id, dimension: current.dimension, performance: rt.host.shared.perfObservations ?? null, movement: { phase: motion.phase, target: motion.target, sent: motion.sent, reason: motion.reason, lastTimerGapMs: motion.lastTimerGapMs, maxFrameTimings: motion.maxFrameTimings ?? null, inputReplay: motion.inputReplay ?? null, directSurface: motion.route?.directSurface === true, start: rt.generationMovement.diagnostics?.() ?? null, route: motion.route ? { origin: motion.route.origin ?? null, flags: { directSurface: motion.route.directSurface === true, directFlat: motion.route.directFlat === true, partialDrop: motion.route.partialDrop === true, controlledDrop: motion.route.controlledDrop === true, partialRecenter: motion.route.partialRecenter === true, shoreRecenter: motion.route.shoreRecenter === true }, waypointCount: motion.route.waypoints?.length ?? 0, waypoints: (motion.route.waypoints ?? []).slice(0, 4), avoidanceCount: motion.route.avoidance?.length ?? 0, avoidance: (motion.route.avoidance ?? []).slice(0, 16), reason: motion.route.reason ?? null, unknownFrontier: (motion.route.unknownFrontier ?? []).slice(0, 4) } : null }, safety: { lastError: typeof protection.lastError === 'string' ? protection.lastError.slice(0, 300) : null, lastEscapeDiagnostic: protection.lastEscapeDiagnostic ?? null, lastResult: protection.lastResult, lastWaterSearch: protection.lastWaterSearch ?? null, lastWaterReplan: protection.lastWaterReplan ?? null, lastWaterCounter: protection.lastWaterCounter ?? null }, enemies: (current.entities ?? []).filter(actor => actor.hostile && actor.positionKnown && actor.position).map(actor => ({ runtimeId: actor.runtimeId, uniqueId: actor.uniqueId, entityType: actor.entityType, position: actor.position, primed: actor.primed ?? null, ignited: actor.ignited ?? null, fuseLength: actor.fuseLength ?? null, charged: actor.charged ?? null, lastEvent: actor.lastEvent ?? null, terrainOcclusion: actor.terrainOcclusion ? { suppressed: actor.terrainOcclusion.suppressed, reason: actor.terrainOcclusion.reason, rays: actor.terrainOcclusion.rays.map(ray => ({ known: ray.known, blocked: ray.blocked, reason: ray.reason, barrierLength: ray.barrierLength, barrierCells: ray.barrierCells })) } : null })), blocks: rt.host.world.getArea(center, 3), lowerTerrain }
                  capture.clearance = structuredClone(rt.host.shared.clearanceDiagnostic ?? null)
                  capture.guardRoute = { phase: captureText(guardStatus.phase), code: captureText(guardStatus.code), reason: captureText(guardStatus.reason), routeInterruption: guardStatus.routeInterruption ? { code: captureText(guardStatus.routeInterruption.code), reason: captureText(guardStatus.routeInterruption.reason) } : null, interruptions: Number.isSafeInteger(guardStatus.interruptions) ? guardStatus.interruptions : null, movementStarts: Number.isSafeInteger(guardStatus.movementStarts) ? guardStatus.movementStarts : null, origin: capturePoint(guardStatus.visitedPrefix?.[0]), originCoordinates: 'feet', visitedPrefix: (guardStatus.visitedPrefix ?? []).slice(0, 8).map(capturePoint).filter(Boolean) }
                  const captureRejection = value => value ? { reason: captureText(value.reason), detail: captureText(value.detail), mode: captureText(value.mode), actorId: captureText(value.actorId), actorName: captureText(value.actorName), minDistance: Number.isFinite(value.minDistance) ? value.minDistance : null, required: Number.isFinite(value.required) ? value.required : null, requestedTarget: capturePoint(value.requestedTarget), segment: value.segment ? { index: Number.isSafeInteger(value.segment.index) ? value.segment.index : null, from: capturePoint(value.segment.from), to: capturePoint(value.segment.to) } : null, preview: value.preview ? { ready: value.preview.ready === true, reason: captureText(value.preview.reason), origin: capturePoint(value.preview.origin), target: capturePoint(value.preview.target), waypointCount: Number.isSafeInteger(value.preview.waypointCount) ? value.preview.waypointCount : null, waypoints: (value.preview.waypoints ?? []).slice(0, 4).map(waypoint => ({ position: capturePoint(waypoint.position), action: captureText(waypoint.action), medium: captureText(waypoint.medium) })) } : null, latestPose: value.latestPose ? { position: capturePoint(value.latestPose.position), rawServerPosition: capturePoint(value.latestPose.rawServerPosition), positionSource: captureText(value.latestPose.positionSource) } : null } : null
                  capture.safety.lastContinuation = protection.lastContinuation ?? null
                  capture.safety.workClearancePending = protection.workClearancePending === true
                  capture.safety.workClearance = protection.workClearance ?? null
                  capture.queuedPrediction = rt.inputHistory?.snapshot() ?? null
                  capture.boundedJumpSearch = structuredClone(rt.boundedJumpSearch)
                  capture.lastInputFailure = structuredClone(rt.host.shared.lastInputFailure ?? null)
                  capture.input = { owner: rt.inputOwner, running: inputStatus.running === true, tick: captureText(inputStatus.tick), sent: Number.isSafeInteger(inputStatus.sent) ? inputStatus.sent : null, lastError: captureText(inputStatus.lastError), idleError: captureText(rt.host.shared.idleError) }
                  capture.guardRoute.progressReplan = guardStatus.progressReplan ? { kind: captureText(guardStatus.progressReplan.kind), originMode: captureText(guardStatus.progressReplan.originMode), anchorTick: captureText(guardStatus.progressReplan.anchorTick), currentTick: captureText(guardStatus.progressReplan.currentTick) } : null
                  capture.connectionId = captureText(current.connectionId)
                  capture.profile = captureText(current.profile)
                  capture.phase = captureText(current.phase)
                  capture.gameMode = current.gameMode
                  capture.version = captureText(rt.host.meta.version)
                  capture.threatPolicy = captureText(current.threatPolicy)
                  const capturedEvaluation = rt.evaluateThreats(current, current.entities ?? [], { observationRadius: 32 })
                  const capturedActor = actor => ({ runtimeId: captureText(actor.runtimeId), name: captureText(actor.name), distance: actor.distance, dangerRadius: actor.dangerRadius, category: captureText(actor.category) })
                  capture.threatEvaluation = { observedAt: capture.observedAt, requiresObservation: capturedEvaluation.requiresObservation, unknownPositions: capturedEvaluation.unknownPositions.length, hostUnknownPositions: current.entityStats?.unknownPositions ?? null, threatCount: capturedEvaluation.threats.length, threats: capturedEvaluation.threats.slice(0, 32).map(capturedActor), outsideDanger: capturedEvaluation.outsideDanger.slice(0, 32).map(capturedActor), suppressedByTerrain: capturedEvaluation.suppressedByTerrain.slice(0, 32).map(capturedActor) }
                  capture.inventory = { known: current.inventory?.known === true, uncertain: current.inventory?.uncertain === true, items: (current.inventory?.items ?? []).slice(0, 36).map(item => ({ slot: item.slot, name: captureText(item.name), count: item.count })) }
                  capture.rawSelectedSlot = current.rawServerSelectedSlot ?? current.rawSelectedSlot ?? current.selectedSlot
                  capture.heldItem = current.heldItem ? { slot: current.heldItem.slot, name: captureText(current.heldItem.name), count: current.heldItem.count } : null
                  capture.equipmentServerConfirmed = current.equipmentServerConfirmed
                  capture.vitals = structuredClone(current.vitals ?? {})
                  capture.removedEntities = (current.removedEntities ?? []).slice(-16).map(actor => ({ runtimeId: captureText(actor.runtimeId), uniqueId: captureText(actor.uniqueId), entityType: captureText(actor.entityType), position: capturePoint(actor.position), removedAt: typeof actor.removedAt === 'string' ? captureText(actor.removedAt) : Number.isFinite(actor.removedAt) ? actor.removedAt : null }))
                  capture.guardRoute.routeRejection = captureRejection(guardStatus.routeRejection)
                  capture.guardRoute.remainingRouteRejection = captureRejection(guardStatus.remainingRouteRejection)
                  capture.guardRoute.progressReplan = guardStatus.progressReplan ? { from: capturePoint(guardStatus.progressReplan.from), target: capturePoint(guardStatus.progressReplan.target), position: capturePoint(guardStatus.progressReplan.position), authoritativePosition: capturePoint(guardStatus.progressReplan.authoritativePosition), horizontalProgress: Number.isFinite(guardStatus.progressReplan.horizontalProgress) ? guardStatus.progressReplan.horizontalProgress : null, targetOvershoot: Number.isFinite(guardStatus.progressReplan.targetOvershoot) ? guardStatus.progressReplan.targetOvershoot : null, authoritativeStamp: typeof guardStatus.progressReplan.authoritativeStamp === 'number' ? guardStatus.progressReplan.authoritativeStamp : captureText(guardStatus.progressReplan.authoritativeStamp) } : null
                  process.stdout.write('EMERGENCY_CAPTURE ' + JSON.stringify(capture) + '\n')
                }
              } catch { /* Diagnostics must never block the emergency stop. */ }
            }
            const protection = rt.generationSafety.snapshot()
            const escape = protection.lastResult?.action === 'escape' ? protection.lastResult : null
            const defense = protection.lastDefense
            if (protection.lastClear?.cleared) rt.host.log('待機保護の障害物: 自然の葉1個の除去を確認')
            if (defense) rt.host.log(`待機保護の自衛: action=${defense.action} phase=${defense.phase} code=${defense.code ?? 'none'} reason=${defense.reasonCode ?? 'none'} hits=${Number.isSafeInteger(defense.hitsRequested) ? defense.hitsRequested : 'unknown'} confirmed=${defense.serverConfirmed === true}`)
            const errorText = String(protection.lastError ?? '')
            const errorCode = /damage/i.test(errorText) ? 'DAMAGE' : /deadline|timed out|timeout/i.test(errorText) ? 'TIMEOUT' : /danger|threat|enemy/i.test(errorText) ? 'THREAT_CHANGED' : /support|terrain|ground|landing/i.test(errorText) ? 'TERRAIN' : /scope|session|generation/i.test(errorText) ? 'SCOPE' : /cancel|abort|stopped/i.test(errorText) ? 'CANCELLED' : errorText ? 'OTHER' : 'none'
            rt.host.log(`待機保護の退避: attempts=${Number.isSafeInteger(protection.escapes) ? protection.escapes : 0} supported=${escape?.supported === true} partial=${escape?.partialEscape === true} code=${escape?.code ?? escape?.reason ?? 'none'} cause=${escape?.cause ?? 'none'} error=${errorCode}`)
            const errorDetail = new Map([['Idle escape danger changed', 'IDENTITY_OR_NEW_THREAT'], ['Idle escape remaining path danger changed', 'OUTSIDE_THREAT_CROSSED_PATH'], ['New or unknown danger interrupted protection', 'NEW_OR_UNKNOWN_THREAT'], ['Idle escape four-second deadline exceeded', 'DEADLINE'], ['Idle escape stopped on observed damage', 'DAMAGE']]).get(errorText)
            if (errorDetail) rt.host.log(`待機保護の中断詳細: ${errorDetail}`)
            if (escape?.diagnostics) rt.host.log(`待機保護の探索: visited=${escape.diagnostics.visited} candidates=${escape.diagnostics.candidates} partials=${escape.diagnostics.partials} previews=${escape.diagnostics.previews} ready=${escape.diagnostics.readyPreviews} floor=${escape.diagnostics.floorBlocked} body=${escape.diagnostics.bodyBlocked} unknown=${escape.diagnostics.terrainUnknown} away=${escape.diagnostics.awayBlocked} gain=${escape.diagnostics.gainBlocked}`)
            try {
              const current = rt.working(); const physical = current.predicted?.physicsState ?? current.physicsState
              const grounded = typeof physical?.onGround === 'boolean' ? String(physical.onGround) : 'unknown'
              const sword = current.inventory?.known === true && /^minecraft:(?:wooden|stone|iron|golden|diamond|netherite)_sword$/.test(current.heldItem?.name ?? '')
              const bodyClear = st.verifyStrikeBody(current)
              rt.host.log(`待機保護の体勢: grounded=${grounded} bodyClear=${bodyClear} meleeSupport=${st.verifyMeleeBody(current)} swordHeld=${sword} inventoryKnown=${current.inventory?.known === true} defenses=${Number.isSafeInteger(protection.defenses) ? protection.defenses : 0}`)
              if (!bodyClear) rt.host.log(`待機保護の体勢詳細: ${JSON.stringify(st.strikeBodyDiagnostic(current))}`)
            } catch { /* Diagnostics cannot interrupt online protection. */ }
            if (escape?.rejection) rt.host.log(`待機保護の経路: reason=${escape.rejection.reason} detail=${escape.rejection.detail ?? 'none'} preview=${escape.rejection.previewCode ?? 'none'} actor=${escape.rejection.actorName ?? 'unknown'} distance=${Number.isFinite(escape.rejection.minDistance) ? escape.rejection.minDistance.toFixed(2) : 'unknown'} required=${Number.isFinite(escape.rejection.required) ? escape.rejection.required.toFixed(2) : 'unknown'}`)
            // Keep a bounded, non-packet summary for diagnosing a protection
            // failure while the bot remains online. Never log
            // player names, positions, inventory, chat or authentication.
            try {
              const state = { ...observed, ...st.threatFields(rt.host.shared) }
              const danger = rt.evaluateThreats(state, rt.host.entities.snapshot({ kind: 'all' }), { observationRadius: 32 })
              const nearest = danger.threats[0]
              if (nearest && /^minecraft:[a-z_]{1,40}$/.test(nearest.name) && Number.isFinite(nearest.distance)) rt.host.log(`待機保護の近傍敵: type=${nearest.name} distance=${nearest.distance.toFixed(1)} cover=unverified unknown=${danger.requiresObservation} count=${danger.threats.length}`)
              if (danger.threats.length === 1 && nearest) {
                const preview = rt.generationCombat.previewEngage(nearest.runtimeId)
                const reason = String(preview.errors?.[0] ?? '')
                const code = preview.ready ? 'READY' : /視線/.test(reason) ? 'SIGHT' : /近接範囲/.test(reason) ? 'RANGE' : /剣|持ち物|スロット|主手/.test(reason) ? 'EQUIPMENT' : /体力/.test(reason) ? 'HEALTH' : /操作/.test(reason) ? 'BUSY' : 'OTHER'
                rt.host.log(`待機保護の交戦確認: ${code}`)
              }
              const summary = danger.threats.slice(0, 8).filter(actor => /^minecraft:[a-z_]{1,40}$/.test(actor.name) && Number.isFinite(actor.distance) && actor.position).map(actor => {
                const dx = actor.position.x - state.position.x; const dz = actor.position.z - state.position.z
                const direction = Math.abs(dx) > Math.abs(dz) * 2 ? (dx > 0 ? 'E' : 'W') : Math.abs(dz) > Math.abs(dx) * 2 ? (dz > 0 ? 'S' : 'N') : `${dz > 0 ? 'S' : 'N'}${dx > 0 ? 'E' : 'W'}`
                return `${actor.name}:${actor.distance.toFixed(1)}:${direction}`
              }).join(',')
              if (summary) rt.host.log(`待機保護の敵一覧（遮蔽未評価）: ${summary}`)
            } catch { /* Logging must not prevent a fresh bounded response. */ }
          } catch (error) { rt.host.log(`待機保護の記録に失敗しました: ${error.message}`) }
        })
}

module.exports = { reportEmergencyStop }
