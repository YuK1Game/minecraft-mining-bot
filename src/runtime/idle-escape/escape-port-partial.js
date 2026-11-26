'use strict'

// A stage of a function in idle-safety-runtime.js, moved here unchanged by scripts/extract-stage.js.
// `st` exposes the locals of that function this stage uses; each read or write
// of st.<name> reads or writes the caller's own variable at that moment.
// It returns { value } where the caller returns that value.

async function runPartialEscape (rt, st) {
          const controller = new AbortController()
          const signal = st.context.signal ? AbortSignal.any([st.context.signal, controller.signal]) : controller.signal
          const initial = st.safetyState(); const origin = { ...initial.position, y: initial.position.y - 1.62 }
          const selected = initial.rawServerSelectedSlot ?? initial.rawSelectedSlot
          const sword = initial.inventory?.known === true && !initial.inventory.uncertain && initial.equipmentServerConfirmed !== false && initial.inventory.items?.some(item => item.slot === selected && item.count === 1 && /^minecraft:(?:wooden|stone|iron|golden|diamond|netherite)_sword$/.test(item.name) && initial.heldItem?.name === item.name && initial.heldItem?.count === 1)
          const handItem = initial.inventory?.items?.find(item => item.slot === selected && item.count > 0)
          const bootstrapHand = !initial.heldItem && !handItem || initial.heldItem?.name === 'minecraft:rotten_flesh' && handItem?.name === initial.heldItem.name && handItem.count === initial.heldItem.count
          const unarmed = initial.health >= 18 && initial.inventory?.known === true && !initial.inventory.uncertain && initial.equipmentServerConfirmed !== false && Number.isInteger(selected) && bootstrapHand && !initial.inventory.items?.some(item => item.count > 0 && /^minecraft:(?:wooden|stone|iron|golden|diamond|netherite)_sword$/.test(item.name))
          const physical = initial.predicted?.physicsState ?? initial.physicsState
          const learningLife = rt.actualLifeId()
          const confirmedHand = Number.isInteger(selected) && selected >= 0 && selected <= 8 && (initial.heldItem ? handItem?.name === initial.heldItem.name && handItem.count === initial.heldItem.count && handItem.count > 0 : !handItem)
          const learningShore = rt.resourceMinHealth(initial) === 0 && initial.inventory?.known === true && !initial.inventory.uncertain && initial.equipmentServerConfirmed !== false && confirmedHand && physical?.onGround === true && !physical.isInWater && !physical.isInLava && !st.verifyMeleeBody(initial, { signal }) && st.verifyLedgeBody(initial, { signal })
          if (!(initial.health > 0) || !(sword || unarmed || learningShore) || physical?.onGround !== true || !st.verifyLedgeBody(initial, { signal }) || await rt.verifyRouteStanding(initial, origin, { signal })) return { value: { supported: false, reason: 'no_known_escape_origin' } }
          const initialThreats = rt.evaluateThreats(initial, initial.entities, { observationRadius: 32 })
          if (initialThreats.requiresObservation || initial.entityStats?.unknownPositions > initialThreats.unknownPositions.length || !initialThreats.threats.length) return { value: { supported: false, reason: 'no_known_away_route' } }
          const single = initialThreats.threats[0]
          const creeperRecenter = initialThreats.threats.length === 1 && single.name === 'minecraft:creeper' && single.dangerRadius === 8 && single.distance >= 3.9 && single.position && Math.hypot(single.position.x - origin.x, single.position.y - origin.y, single.position.z - origin.z) >= 3.1
          const criticalZombieRecenter = initial.health <= 6 && initialThreats.threats.length === 1 && single.name === 'minecraft:zombie' && single.distance >= 5.75
          const unarmedCreeperRecenter = unarmed && creeperRecenter && single.distance >= 5.5
          const unarmedZombieRecenter = unarmed && initialThreats.threats.length === 1 && single.name === 'minecraft:zombie' && single.distance >= 8.5
          const unarmedDrownedRecenter = unarmed && initialThreats.threats.length === 1 && single.name === 'minecraft:drowned' && single.distance >= 10.5
          const unarmedSpiderRecenter = unarmed && initialThreats.threats.length === 1 && single.name === 'minecraft:spider' && single.distance >= 8.5
          const unarmedSpiderGroup = unarmed && initialThreats.threats.length === 2 && initialThreats.threats.every(actor => actor.name === 'minecraft:spider' && actor.distance >= 8.5)
          const unarmedCreeperZombie = rt.isUnarmedCreeperZombie(initial, initialThreats.threats)
          const shoreRecenter = learningShore || !st.verifyMeleeBody(initial, { signal }) && (unarmedSpiderRecenter || unarmedSpiderGroup || unarmedCreeperRecenter || unarmedCreeperZombie)
          const shoreSpiderApproach = shoreRecenter && unarmedSpiderRecenter && initial.health === 20 && single.distance >= 9.5
          const creeperEntity = single && initial.entities.find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === single.runtimeId)
          const shoreCreeperCloseApproach = shoreRecenter && unarmedCreeperRecenter && initial.health === 20 && single.distance >= 5.75 && Math.hypot(single.position.x - initial.position.x, single.position.z - initial.position.z) >= 5.5 && creeperEntity?.primed === false && creeperEntity?.charged === false
          const shoreCreeperApproach = shoreRecenter && unarmedCreeperRecenter && initial.health === 20 && single.distance >= 7 && Math.hypot(single.position.x - initial.position.x, single.position.z - initial.position.z) >= 6.4 || shoreCreeperCloseApproach
          // A partly supported player can also recenter away from both members
          // of one identified, sufficiently distant creeper/spider pair. The
          // simulated and live corridor must never approach either actor.
          const unarmedDualRecenter = unarmedCreeperZombie || unarmed && initialThreats.threats.length === 2 && initialThreats.threats.some(actor => actor.name === 'minecraft:creeper' && actor.dangerRadius === 8 && actor.distance >= 5.5) && initialThreats.threats.some(actor => actor.name === 'minecraft:spider' && actor.distance >= 8.5)
          if (unarmed && !learningShore && !(unarmedZombieRecenter || unarmedDrownedRecenter || unarmedSpiderRecenter || unarmedSpiderGroup || unarmedDualRecenter || unarmedCreeperRecenter)) return { value: { supported: false, reason: 'no_known_away_route' } }
          // Below ten health permit a single ordinary creeper, or at critical
          // health a single sufficiently distant zombie. The retreat never
          // moves closer along its simulated corridor.
          if (initial.health < 10 && !learningShore && !creeperRecenter && !criticalZombieRecenter) return { value: { supported: false, reason: 'no_known_away_route' } }
          const primary = initialThreats.threats.reduce((a, b) => a.distance < b.distance ? a : b)
          const all = [...initialThreats.threats, ...initialThreats.outsideDanger]
          const activeIds = new Set(initialThreats.threats.map(actor => actor.runtimeId))
          const trackedRangedIds = new Set()
          const identities = new Map(); const circles = []
          for (const actor of all) {
            const entity = initial.entities.find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
            if (entity?.uniqueId == null) return { value: { supported: false, reason: 'no_known_away_route' } }
            identities.set(actor.runtimeId, { uniqueId: String(entity.uniqueId), name: actor.name, radius: actor.dangerRadius })
            let minimum = actor.dangerRadius
            const ranged = ['minecraft:skeleton', 'minecraft:stray', 'minecraft:bogged'].includes(actor.name)
            const zombie = ['minecraft:zombie', 'minecraft:zombie_villager', 'minecraft:zombie_villager_v2', 'minecraft:husk'].includes(actor.name)
            const spider = actor.name === 'minecraft:spider'
            const creeper = creeperRecenter && actor.runtimeId === single.runtimeId
            if (activeIds.has(actor.runtimeId)) {
              const exactDistance = learningShore || unarmedDualRecenter || unarmedSpiderGroup || creeper || (criticalZombieRecenter || unarmedZombieRecenter || unarmedDrownedRecenter || unarmedSpiderRecenter) && actor.runtimeId === single.runtimeId
              const floor = exactDistance ? actor.distance : zombie ? (actor.runtimeId === primary.runtimeId ? 4.5 : 7.5) : spider ? 6 : ranged ? 18 : null
              if (floor === null || !exactDistance && actor.distance < floor + 0.1) return { value: { supported: false, reason: 'no_known_away_route' } }
              const recenterBudget = unarmedDrownedRecenter && initial.health === 20 && actor.distance >= 12.5 ? 0.5 : 0.25
              minimum = learningShore ? actor.distance : unarmedCreeperZombie && zombie ? rt.unarmedZombieFloor(actor) : unarmedCreeperZombie && spider ? rt.activeUnarmedSpiderFloor(actor) : unarmedCreeperZombie && actor.name === 'minecraft:creeper' ? Math.max(5.75, actor.distance - 0.4) : shoreCreeperApproach && actor.runtimeId === single.runtimeId ? shoreCreeperCloseApproach ? Math.max(5.25, actor.distance - 0.65) : Math.max(6.5, actor.distance - 0.4) : shoreSpiderApproach && actor.runtimeId === single.runtimeId ? Math.max(9, actor.distance - 0.4) : unarmedDrownedRecenter && actor.runtimeId === single.runtimeId ? Math.max(10.25, actor.distance - recenterBudget) : exactDistance ? actor.distance : actor.runtimeId === primary.runtimeId ? Math.max(floor, actor.distance - 0.4) : Math.max(floor, actor.distance - 1.5)
            } else if (ranged && actor.distance >= 18.25 && actor.distance <= actor.dangerRadius + 1.5) {
              // The same already observed ranged actor may cross its broad
              // avoidance radius while the short descent is underway. It still
              // must remain beyond 18 and within the fixed 1.5-block budget.
              trackedRangedIds.add(actor.runtimeId)
              minimum = Math.max(18, actor.distance - 1.5)
            }
            circles.push({ id: actor.runtimeId, position: { ...actor.position }, minDistance: minimum, padding: 0 })
          }
          const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
          const eye = point => ({ ...point, y: point.y + 1.62 })
          const segment = (point, from, to) => {
            const d = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z }; const length = d.x ** 2 + d.y ** 2 + d.z ** 2
            const t = length ? Math.max(0, Math.min(1, ((point.x - from.x) * d.x + (point.y - from.y) * d.y + (point.z - from.z) * d.z) / length)) : 0
            return distance(point, { x: from.x + t * d.x, y: from.y + t * d.y, z: from.z + t * d.z })
          }
          function knownFullRecenterFloor (target) {
            try {
              const cube = block => block.shapes.length === 1 && block.shapes[0].every((value, index) => Math.abs(value - [0, 0, 0, 1, 1, 1][index]) <= 1e-9)
              const hazard = /(?:water|lava|fire|cactus|magma|campfire|powder_snow|cobweb|wither_rose|pointed_dripstone|sweet_berry_bush|concrete_powder|anvil)/
              for (let x = Math.floor(target.x - 0.3 + 1e-4); x <= Math.floor(target.x + 0.3 - 1e-4); x++) for (let z = Math.floor(target.z - 0.3 + 1e-4); z <= Math.floor(target.z + 0.3 - 1e-4); z++) {
                const floor = rt.generationPhysics.blockAt({ x, y: target.y - 1, z })
                if (hazard.test(floor.name) || !cube(floor)) return false
                if (/^(?:sand|red_sand|gravel)$/.test(floor.name)) {
                  let stable = false
                  for (let depth = 1; depth <= 8; depth++) {
                    const below = rt.generationPhysics.blockAt({ x, y: target.y - 1 - depth, z })
                    if (hazard.test(below.name) || !cube(below)) return false
                    if (!/^(?:sand|red_sand|gravel)$/.test(below.name)) { stable = true; break }
                  }
                  if (!stable) return false
                }
                for (const y of [target.y, target.y + 1]) {
                  const body = rt.generationPhysics.blockAt({ x, y, z })
                  if (hazard.test(body.name) || body.shapes.length) return false
                }
              }
              return true
            } catch { return false }
          }
          let started = false; let timer; let watch; let trace = null; let traceIndex = 0
          const deadline = Date.now() + 4000
          const check = () => {
            st.requireSafety(); if (signal.aborted) throw signal.reason ?? new Error('Partial escape interrupted')
            if (Date.now() >= deadline) throw new Error('Partial escape deadline')
            const { state: current, observedEntities } = st.safetyObservation()
            if (signal.aborted) throw signal.reason ?? new Error('Partial escape interrupted')
            if (current.dead || current.health < initial.health || learningShore && rt.actualLifeId() !== learningLife || current.connectionId !== initial.connectionId || !rt.sameRouteScope(rt.routeScope(current), rt.routeScope(initial))) throw new Error('Partial escape session or health changed')
            const currentPhysical = current.predicted?.physicsState ?? current.physicsState
            if (shoreRecenter && (currentPhysical?.isInWater || currentPhysical?.isInLava)) throw new Error('Partial escape entered water or lava')
            const currentSlot = current.rawServerSelectedSlot ?? current.rawSelectedSlot
            const currentItem = current.inventory.items?.find(item => item.slot === currentSlot && item.count > 0)
            const equipmentValid = learningShore ? initial.heldItem ? current.heldItem?.name === initial.heldItem.name && current.heldItem?.count === initial.heldItem.count && currentItem?.name === initial.heldItem.name && currentItem.count === initial.heldItem.count : !current.heldItem && !currentItem : unarmed ? initial.heldItem ? current.heldItem?.name === initial.heldItem.name && current.heldItem?.count === initial.heldItem.count && currentItem?.name === initial.heldItem.name && currentItem.count === initial.heldItem.count : !current.heldItem && !currentItem : current.heldItem?.name === initial.heldItem?.name && current.heldItem?.count === 1 && currentItem?.name === current.heldItem.name && currentItem.count === 1
            if (current.inventory?.known !== true || current.inventory.uncertain || current.equipmentServerConfirmed === false || currentSlot !== selected || !equipmentValid) throw new Error('Partial escape equipment changed')
            const evaluation = rt.evaluateThreats(current, current.entities, { observationRadius: 32 })
            if (evaluation.requiresObservation || current.entityStats?.unknownPositions > evaluation.unknownPositions.length || evaluation.threats.some(actor => !activeIds.has(actor.runtimeId) && !trackedRangedIds.has(actor.runtimeId))) throw new Error('Partial escape danger changed')
            if (trace) {
              // Occlusion changes danger, not identity or the fixed distance
              // floor of an actor already included in this retreat corridor.
              const observed = rt.evaluateThreats(current, observedEntities, { observationRadius: 32 })
              if (observed.requiresObservation) throw new Error('Partial escape actor observations are incomplete')
              const actors = new Map([...observed.threats, ...observed.outsideDanger, ...observed.suppressedByTerrain, ...observed.unreachable].map(actor => [actor.runtimeId, actor]))
              const nearest = trace.reduce((best, point, index) => index < traceIndex ? best : !best || distance(eye(point), current.position) < best.distance ? { index, distance: distance(eye(point), current.position) } : best, null)
              if (!nearest || nearest.distance > 0.5) throw new Error('Partial escape left its predicted corridor')
              traceIndex = nearest.index
              const remaining = [current.position, ...trace.slice(traceIndex + 1).map(eye)]
              for (const circle of circles) {
                const actor = actors.get(circle.id); const entity = observedEntities.find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === circle.id); const known = identities.get(circle.id)
                if (!actor || !known) throw new Error('Partial escape actor no longer observed')
                if (String(entity?.uniqueId) !== known.uniqueId || actor.name !== known.name) throw new Error('Partial escape actor identity changed')
                if (actor.dangerRadius > known.radius) throw new Error('Partial escape actor danger expanded')
                if (actor.distance < circle.minDistance - 1e-4) throw new Error('Partial escape actor approached distance floor')
                if (unarmedCreeperZombie && actor.name === 'minecraft:creeper' && (Math.hypot(actor.position.x - current.position.x, actor.position.z - current.position.z) < 5.5 || remaining.slice(1).some((point, index) => segment({ ...actor.position, y: 0 }, { ...remaining[index], y: 0 }, { ...point, y: 0 }) < 5.5))) throw new Error('Partial escape creeper horizontal distance became unsafe')
                if (shoreCreeperApproach && actor.runtimeId === single.runtimeId && (Math.hypot(actor.position.x - current.position.x, actor.position.z - current.position.z) < (shoreCreeperCloseApproach ? 5 : 6) || remaining.slice(1).some((point, index) => segment({ ...actor.position, y: 0 }, { ...remaining[index], y: 0 }, { ...point, y: 0 }) < (shoreCreeperCloseApproach ? 5 : 6)))) throw new Error('Partial escape creeper horizontal distance became unsafe')
                if (remaining.slice(1).some((point, index) => segment(actor.position, remaining[index], point) < circle.minDistance - 1e-4)) throw new Error('Partial escape remaining path is unsafe')
              }
            }
            return current
          }
          const cancel = () => { if (started && st.safetyCurrent()) rt.routeMovement.stop('Partial escape interrupted') }
          const inspectPacket = () => { try { check() } catch (error) { controller.abort(error) } }
          signal.addEventListener('abort', cancel, { once: true })
          try {
            timer = setTimeout(() => controller.abort(new Error('Partial escape deadline')), 4000)
            let partialPlanningChecks = 0, partialPlanningSlice = performance.now()
            const yieldPartialPlanning = async (force = false) => {
              if (!force && ++partialPlanningChecks % 32 !== 0 && performance.now() - partialPlanningSlice < 12) return
              st.requireSafety(); if (signal.aborted) throw signal.reason
              rt.maintainIdle()
              await new Promise(resolve => setImmediate(resolve))
              check()
              partialPlanningSlice = performance.now()
            }
            const targets = []
            for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (const ox of [0.3, 0.35, 0.5, 0.65, 0.7]) for (const oz of [0.3, 0.35, 0.5, 0.65, 0.7]) for (const recenter of learningShore ? [true] : creeperRecenter || criticalZombieRecenter || unarmedZombieRecenter || unarmedDrownedRecenter || unarmedSpiderRecenter || unarmedSpiderGroup || unarmedDualRecenter ? [true, false] : [false]) {
              await yieldPartialPlanning()
              if (!recenter && (shoreRecenter || creeperRecenter && !rt.clearanceDistanceAllowed(initial, single))) continue
              const target = { x: Math.floor(origin.x) + dx + ox, y: Math.round(origin.y) - (recenter ? 0 : 1), z: Math.floor(origin.z) + dz + oz }
              const horizontal = Math.hypot(target.x - origin.x, target.z - origin.z)
              const gain = distance(primary.position, eye(target)) - primary.distance
              // A partly supported ledge may require one short step onto its
              // support before an away route is possible. Restrict this to a
              // healthy unarmed player and a single distant drowned; the
              // fixed circle still bounds every simulated and observed frame.
              const mixedCreeperApproach = unarmedCreeperZombie && primary.name === 'minecraft:creeper' && primary.distance >= 6.5 && Math.hypot(primary.position.x - initial.position.x, primary.position.z - initial.position.z) >= 6
              const recenterGain = learningShore ? 0 : shoreRecenter && recenter ? (mixedCreeperApproach ? -0.3 : shoreCreeperCloseApproach ? -0.65 : shoreSpiderApproach || shoreCreeperApproach ? -0.4 : 0) : unarmedDrownedRecenter && recenter ? -(initial.health === 20 && single.distance >= 12.5 ? 0.5 : 0.25) : 0.25
              const creeperHorizontalSafe = !shoreCreeperApproach || segment({ ...single.position, y: 0 }, { ...initial.position, y: 0 }, { ...target, y: 0 }) >= (shoreCreeperCloseApproach ? 5 : 6)
              if (horizontal < 0.2 || horizontal > (unarmedCreeperZombie ? 0.9 : shoreCreeperCloseApproach ? 0.75 : 1.2) || gain < recenterGain || !creeperHorizontalSafe || circles.some(circle => segment(circle.position, initial.position, eye(target)) < circle.minDistance - 1e-4)) continue
              if ((learningShore || unarmedCreeperZombie) && recenter && !knownFullRecenterFloor(target)) continue
              targets.push({ target, gain, recenter })
            }
            targets.sort((a, b) => Number(b.recenter) - Number(a.recenter) || (unarmedCreeperZombie ? Math.hypot(a.target.x - origin.x, a.target.z - origin.z) - Math.hypot(b.target.x - origin.x, b.target.z - origin.z) : b.gain - a.gain))
            let candidate = null; let preview = null
            for (const entry of targets.slice(0, unarmedZombieRecenter || unarmedDrownedRecenter || unarmedSpiderRecenter || unarmedSpiderGroup || unarmedDualRecenter || unarmedCreeperRecenter ? 120 : 60)) {
              await new Promise(resolve => setImmediate(resolve)); check(); rt.motionOrigin = rt.working()
              const options = { emergency: true, allowWater: shoreRecenter, shoreRecenter, partialDrop: !entry.recenter, partialRecenter: entry.recenter, maxDistance: 2, maxTicks: 40, avoidance: circles }
              const planned = rt.generationMovement.preview(entry.target, options)
              if (planned.ready && (entry.recenter ? planned.partialRecenter === true : planned.partialDrop === true) && Array.isArray(planned.predictedTrace) && planned.predictedTrace.length > 2) { candidate = { ...entry, options }; preview = planned; break }
            }
            if (!candidate) return { value: { supported: false, reason: 'no_known_away_route' } }
            trace = preview.predictedTrace
            await yieldPartialPlanning(true)
            watch = setInterval(inspectPacket, 25)
            rt.inspectPartialEscapePacket = inspectPacket
            rt.routeMovement.start(candidate.target, candidate.options); started = true
            while (true) {
              await rt.delay(50, undefined, { signal })
              const current = check(); const movementState = rt.generationMovement.snapshot()
              if (['failed', 'stopped', 'replan_required'].includes(movementState.phase)) return { value: { supported: true, arrived: false, escaped: false, code: movementState.phase === 'replan_required' ? 'PARTIAL_REPLAN' : movementState.phase === 'failed' && movementState.reason === 'Movement input timer stalled' ? 'PARTIAL_STALLED' : 'PARTIAL_STOPPED', reason: 'no_known_away_route', partialFailure: typeof movementState.reason === 'string' ? movementState.reason.slice(0, 200) : null } }
              if (['awaiting_server_confirmation', 'completed', 'idle'].includes(movementState.phase)) {
                if (!await rt.verifyRouteStanding(current, candidate.target, { signal })) return { value: { supported: true, arrived: false, escaped: false, reason: 'no_known_escape_origin' } }
                const evaluation = rt.evaluateThreats(current, current.entities, { observationRadius: 32 })
                return { value: { supported: true, arrived: true, escaped: !evaluation.requiresObservation && !evaluation.threats.length, partialEscape: !evaluation.requiresObservation && evaluation.threats.length > 0, constrainedEscape: !(creeperRecenter || criticalZombieRecenter || unarmedZombieRecenter || unarmedDrownedRecenter || unarmedSpiderRecenter || unarmedSpiderGroup || unarmedDualRecenter), constrainedPrimaryId: creeperRecenter || criticalZombieRecenter || unarmedZombieRecenter || unarmedDrownedRecenter || unarmedSpiderRecenter || unarmedSpiderGroup || unarmedDualRecenter ? null : primary.runtimeId, serverConfirmed: false } }
              }
            }
          } catch (error) {
            // Node's abortable delay reports a generic AbortError; preserve
            // the specific safety condition that stopped the owned motion.
            if (controller.signal.aborted && controller.signal.reason instanceof Error) throw controller.signal.reason
            throw error
          } finally {
            clearTimeout(timer); clearInterval(watch); signal.removeEventListener('abort', cancel)
            if (rt.inspectPartialEscapePacket === inspectPacket) rt.inspectPartialEscapePacket = null
            if (started && st.safetyCurrent()) rt.routeMovement.stop('Partial escape finished')
          }
}

module.exports = { runPartialEscape }
