'use strict'

// A stage of a function in idle-safety-runtime.js, moved here unchanged by scripts/extract-stage.js.
// `st` exposes the locals of that function this stage uses; each read or write
// of st.<name> reads or writes the caller's own variable at that moment.
// It returns { value } where the caller returns that value.

async function collectEscapeCandidates (rt, st) {
            st.ensure()
            const initial = st.planningState; st.initial = initial
            const baseline = st.assessEnemies(initial); st.baseline = baseline
            const known = [...baseline.threats, ...baseline.outside]
            const primary = baseline.threats.find(actor => actor.runtimeId === st.context.threats?.[0]?.runtimeId) ?? baseline.threats[0]; st.primary = primary
            const away = (from, to, actors = known, constrained = false) => st.awayFromActors(from, to, actors, constrained)
            const origin = st.feet(initial); st.origin = origin
            const lowHealthSurfaceDiagnostic = { observedAt: new Date().toISOString(), health: initial.health, reason: 'not_checked', previews: 0, ready: 0, attempts: 0, maxSlice: st.surfaceTiming.maxSlice }; st.lowHealthSurfaceDiagnostic = lowHealthSurfaceDiagnostic
            const receivedSurfaceOrigin = rt.lowHealthSurfaceEligible(initial, known, rt.generationPhysics, { diagnostic: lowHealthSurfaceDiagnostic }); st.receivedSurfaceOrigin = receivedSurfaceOrigin
            rt.host.shared.lowHealthWaterDiagnostic = lowHealthSurfaceDiagnostic
            const alreadyShallow = receivedSurfaceOrigin || st.verifyShallowWater(initial, { signal: st.signal, allowDeepSurface: true }); st.alreadyShallow = alreadyShallow
            await st.yieldPlanning()
            const fullOrigin = alreadyShallow || await rt.verifyRouteStanding(initial, origin, { signal: st.signal })
            const partialOrigin = !fullOrigin && await rt.verifyRouteOrigin(initial, origin, { signal: st.signal, stablePartialOrigin: true }); st.partialOrigin = partialOrigin
            if (!primary && fullOrigin && !alreadyShallow) {
              const retreat = await st.tryRecentDamageNoPrimary({ ...initial, lifecycle: { phase: 'alive', deathId: rt.actualLifeId(), dead: initial.dead === true } }, { ...st.context, signal: st.signal, movementBudget: Math.max(0, 5 - st.episodeMovementStarts), onMovementStart: () => { st.episodeMovementStarts++; st.fence.starts = st.episodeMovementStarts } }, st.deadline)
              if (retreat) return { value: retreat }
            }
            if (!primary || !alreadyShallow && !fullOrigin && !partialOrigin) {
              const physical = initial.predicted?.physicsState ?? initial.physicsState
              if (primary && rt.resourceMinHealth(initial) === 0 && st.partialEscapeAction && physical?.onGround === true && !physical.isInWater && !physical.isInLava && st.verifyLedgeBody(initial, { signal: st.signal })) return { value: st.partialEscapeAction({ ...st.context, signal: st.signal }) }
              return { value: { supported: false, reason: 'no_known_escape_origin' } }
            }
            const urgentCreeper = baseline.threats.length === 1 && primary.name === 'minecraft:creeper' && primary.distance < 4.5; st.urgentCreeper = urgentCreeper
            const queue = alreadyShallow ? [] : [{ position: origin, depth: 0 }]; const visited = new Set(); const candidates = []; st.candidates = candidates; const partials = []; st.partials = partials; let planningChecks = 0
            let planningSlice = st.surfaceMark()
            const yieldCandidatePlanning = async (force = false) => {
              if (!force && ++planningChecks % 64 !== 0 && performance.now() - planningSlice.at < 12) return
              st.surfaceRecord('escapeCandidateSlice', planningSlice)
              if (process.env.MINECRAFT_CAPTURE_EMERGENCY === '1') {
                rt.host.shared.perfObservations ??= {}
                rt.host.shared.perfObservations.escapePlanningMaxSliceMs = Math.max(rt.host.shared.perfObservations.escapePlanningMaxSliceMs ?? 0, st.surfaceTiming.lastSlice.ms)
              }
              await st.yieldPlanning()
              planningSlice = st.surfaceMark()
            }
            for (let i = 0; i < queue.length && i < (urgentCreeper ? 24 : 256); i++) {
              // Yield often enough for incoming actor, damage and abort
              // packets while bounding the cost of the local BFS.
              if ((i & 15) === 0) await yieldCandidatePlanning(true)
              const node = queue[i]
              if (node.depth >= (urgentCreeper ? 3 : 6)) continue
              for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [0, -1, 1]) {
                await yieldCandidatePlanning()
                const target = { x: Math.floor(node.position.x) + dx + 0.5, y: Math.round(node.position.y) + dy, z: Math.floor(node.position.z) + dz + 0.5 }
                const key = [target.x, target.y, target.z].join(',')
                if (visited.has(key) || !st.cellSafe(target) || !away(node.position, target)) continue
                if (st.distance(primary.position, st.eye(target)) < st.distance(primary.position, st.eye(node.position)) + 0.25) { st.diagnostics.gainBlocked++; continue }
                visited.add(key); queue.push({ position: target, depth: node.depth + 1 })
                const gain = st.distance(primary.position, st.eye(target)) - primary.distance
                if (gain >= 0.25) {
                  const candidate = { target, depth: node.depth + 1, gain }
                  if (known.every(actor => st.distance(actor.position, st.eye(target)) > actor.dangerRadius + 0.2)) candidates.push(candidate)
                  else if (baseline.threats.every(actor => st.distance(actor.position, st.eye(target)) >= actor.distance + 0.15)) partials.push(candidate)
                }
              }
            }
            // Grid-only steps can be trapped between two hostile circles even
            // when a diagonal path on the same known floor moves away from
            // both. Try finite headings; Nav and Guard verify the full path.
            for (let angle = 0; !alreadyShallow && angle < 32; angle += urgentCreeper ? 2 : 1) for (const length of urgentCreeper ? [0.75, 1, 1.5, 2] : [0.75, 1, 1.5, 2, 4, 6]) {
              await yieldCandidatePlanning()
              const theta = angle * Math.PI / 16
              const target = { x: origin.x + Math.cos(theta) * length, y: origin.y, z: origin.z + Math.sin(theta) * length }
              // A short diagonal can unlock the next safe segment between
              // several threat circles. Guard still requires a 0.25 gain from
              // the primary and validates the entire swept route.
              const minimumGain = length < 2 ? 0.15 : 0.5
              if (!st.cellSafe(target) || !away(origin, target)) continue
              if (st.distance(primary.position, st.eye(target)) < primary.distance + 0.25 || !baseline.threats.every(actor => st.distance(actor.position, st.eye(target)) >= actor.distance + minimumGain)) { st.diagnostics.gainBlocked++; continue }
              const candidate = { target, depth: Math.ceil(length), gain: st.distance(primary.position, st.eye(target)) - primary.distance }
              if (known.every(actor => st.distance(actor.position, st.eye(target)) > actor.dangerRadius + 0.2)) candidates.push(candidate)
              else partials.push(candidate)
            }
            // Small offsets within the adjacent cell matter when the opening
            // is bordered by leaves or trunks; the body is wider than a point.
            const originOffsets = partialOrigin ? [0, -0.15, 0.15, -0.25, 0.25] : [0, -0.15, 0.15]
            const originDirections = partialOrigin ? [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]] : [[1, 0], [-1, 0], [0, 1], [0, -1]]
            for (const [dx, dz] of (alreadyShallow ? [] : originDirections)) for (const dy of (partialOrigin ? [0, -1] : [0])) for (const ox of originOffsets) for (const oz of originOffsets) {
              await yieldCandidatePlanning()
              if (!dx && !dz && dy) continue
              const target = { x: Math.floor(origin.x) + dx + 0.5 + ox, y: Math.round(origin.y) + dy, z: Math.floor(origin.z) + dz + 0.5 + oz }
              const gain = st.distance(primary.position, st.eye(target)) - primary.distance
              if (st.distance(origin, target) > 2 || gain < 0.25 || !st.cellSafe(target) || !away(origin, target) || !baseline.threats.every(actor => st.distance(actor.position, st.eye(target)) >= actor.distance + 0.15)) continue
              const boundedRecenter = partialOrigin && !dy && st.distance(origin, target) <= 1.2
              const candidate = { target, depth: 1, gain, ...(boundedRecenter ? { recenter: true, recenterOffset: Math.abs(ox) + Math.abs(oz) } : {}) }
              if (known.every(actor => st.distance(actor.position, st.eye(target)) > actor.dangerRadius + 0.2)) candidates.push(candidate)
              else partials.push(candidate)
            }
            // Prefer useful pause clearance over the first point just outside
            // a hostile radius. Every chosen route still uses the actual hard
            // distance floors, complete body checks and the same deadline.
            const pauseClearance = candidate => Math.min(...known.map(actor => st.distance(actor.position, st.eye(candidate.target)) - actor.dangerRadius - rt.WORK_MARGIN))
            candidates.sort((a, b) => pauseClearance(b) - pauseClearance(a) || b.gain - a.gain || a.depth - b.depth)
            partials.sort((a, b) => initial.health <= 6 ? a.depth - b.depth || b.gain - a.gain : b.gain - a.gain || a.depth - b.depth)
            st.diagnostics.visited = visited.size; st.diagnostics.candidates = candidates.length; st.diagnostics.partials = partials.length
            const choices = candidates.length ? [...candidates.slice(0, 6), ...partials.slice(0, 6)] : partials.slice(0, 12); st.choices = choices
            // A nearby creeper leaves little time for previews. Include one
            // partial escape when available: a distant destination can fail
            // even though a shorter, guarded move away is feasible. The
            // supervisor can replan after that move from fresh observations.
            if (!['confirmed_leaf_clearance', 'confirmed_soil_clearance', 'confirmed_drowned_step_clearance','confirmed_skeleton_step_clearance'].includes(st.context.reason) && baseline.threats.length === 1 && primary.name === 'minecraft:creeper' && primary.distance < 6.5) {
              const shortPartial = partials.filter(candidate => primary.distance + candidate.gain < primary.dangerRadius - 0.1 && candidate.gain >= 0.5).sort((a, b) => st.distance(origin, a.target) - st.distance(origin, b.target) || b.gain - a.gain)[0]
              const first = candidates[0] ?? shortPartial ?? partials[0]
              const second = candidates[0] ? shortPartial ?? partials[0] ?? candidates[1] : partials.find(candidate => candidate !== first)
              const next = [...partials, ...candidates].filter(candidate => candidate !== first && candidate !== second).sort((a, b) => st.distance(origin, a.target) - st.distance(origin, b.target))
              choices.splice(0, choices.length, ...[first, second, ...next.slice(0, 2)].filter(Boolean))
            }
            // The leaf planner has already simulated a route through the
            // intended opening. Recheck that exact point against the latest
            // terrain and actors, then run the ordinary live preview and Guard.
            const preferred = st.context.preferredTarget
            if (['confirmed_leaf_clearance', 'confirmed_soil_clearance', 'confirmed_drowned_step_clearance','confirmed_skeleton_step_clearance'].includes(st.context.reason) && preferred && ['x', 'y', 'z'].every(axis => Number.isFinite(preferred[axis])) && st.distance(origin, preferred) <= 2 && Math.abs(preferred.y - origin.y - (['confirmed_soil_clearance','confirmed_drowned_step_clearance','confirmed_skeleton_step_clearance'].includes(st.context.reason) ? 1 : 0)) < 1e-4 && st.distance(primary.position, st.eye(preferred)) >= primary.distance + 0.25 && st.cellSafe(preferred) && away(origin, preferred)) choices.unshift({ target: { ...preferred }, depth: 1, gain: st.distance(primary.position, st.eye(preferred)) - primary.distance })
            // If no route moves away from every current enemy, consider a
            // single adjacent step that still moves away from the primary.
            // Only identified distant secondary zombies, spiders or skeletons
            // may lose up to 1.5 blocks, never below their fixed floors. The
            // Guard independently enforces the same bounds on every segment.
            const selected = initial.rawServerSelectedSlot ?? initial.rawSelectedSlot
            const sword = initial.inventory?.known === true && !initial.inventory.uncertain && initial.equipmentServerConfirmed !== false && initial.inventory.items?.some(item => item.slot === selected && item.count === 1 && /^minecraft:(?:wooden|stone|iron|golden|diamond|netherite)_sword$/.test(item.name) && initial.heldItem?.name === item.name && initial.heldItem?.count === 1); st.sword = sword
            if (initial.health > 6 && (sword || st.unarmedMixed) && baseline.threats.length > 1 && st.constrainedFloors.size && baseline.threats.every(actor => st.ids.get(actor.runtimeId)?.uniqueId != null)) {
              const constrainedChoices = []
              let checked = 0
              for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) for (const dy of [0, -1, 1]) for (const ox of [0, -0.15, 0.15]) for (const oz of [0, -0.15, 0.15]) {
                if (++checked % 12 === 0) await st.yieldPlanning()
                const target = { x: Math.floor(origin.x) + dx + 0.5 + ox, y: Math.round(origin.y) + dy, z: Math.floor(origin.z) + dz + 0.5 + oz }
                const gain = st.distance(st.constrainedPrimary.position, st.eye(target)) - st.constrainedPrimary.distance
                if (st.distance(origin, target) > 2 || gain < 0.25 || !st.cellSafe(target) || !away(origin, target, known, true)) continue
                constrainedChoices.push({ target, depth: 1, gain, constrained: true })
              }
              constrainedChoices.sort((a, b) => b.gain - a.gain)
              choices.push(...constrainedChoices)
            }
            st.lastRejected = null
}

module.exports = { collectEscapeCandidates }
