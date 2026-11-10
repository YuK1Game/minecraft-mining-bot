'use strict'

const { serverPose, usableServerPose, validPositionVolume, workingFeet } = require('./quarry-pillar')
const { exitDigRule } = require('./quarry-exit-plan')
const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'])
const HAZARD = /water|lava|fire|magma|cactus|campfire|powder_snow|cobweb|pointed_dripstone|sand$|gravel$/
const copy = value => structuredClone(value)
const key = p => `${p.x},${p.y},${p.z}`
const air = b => b?.known === true && AIR.has(b.name) && !b.extra?.length
const dirtTotal = s => (s.inventory?.items ?? []).filter(i => i.name === 'minecraft:dirt' && i.count > 0).reduce((n, i) => n + i.count, 0)
const scope = s => JSON.stringify([s.profile ?? null, String(s.realm?.id ?? ''), s.connectionId ?? null, s.startedAt ?? null, s.dimension ?? null, String(s.runtimeEntityId ?? ''), s.lifecycle?.deathId ?? null])

function createQuarryEgressRuntime ({ getState, getBlock, moveTo, mineTargets, pillarStep, confirmPosition = null, now = Date.now } = {}) {
  if ([getState, getBlock, moveTo, mineTargets, pillarStep].some(fn => typeof fn !== 'function')) throw new Error('Egress runtime requires received state and ordinary move, mining and pillar ports')
  if (confirmPosition !== null && typeof confirmPosition !== 'function' || typeof now !== 'function') throw new Error('Invalid egress position confirmation ports')
  let busy = false
  const positionRequests = new Set()
  async function run (request, { signal, onCheckpoint = async () => {} } = {}) {
    if (busy) return { status: 'blocked', reason: 'EGRESS_BUSY', serverConfirmed: false, checkpoint: copy(request.checkpoint ?? null) }
    const { plan, jobId, operationId } = request
    if (!plan?.column || !Number.isSafeInteger(plan.startFeet?.y) || !Number.isSafeInteger(plan.targetFeetY) || plan.targetFeetY < plan.startFeet.y || !plan.entry || !plan.landing) throw new Error('Egress needs a verified column, entry, start and landing plan')
    const signature = JSON.stringify([plan.column, plan.startFeet, plan.targetFeetY, plan.landing])
    const restoring = request.checkpoint != null
    let checkpoint = restoring ? copy(request.checkpoint) : { version: 1, jobId, operationId, plan: signature, phase: 'entry', confirmedFeetY: plan.startFeet.y, steps: [], pendingStep: null, scope: null, life: null }
    let health = null
    const blocked = reason => ({ status: 'blocked', reason, serverConfirmed: false, checkpoint: copy(checkpoint) })
    if (checkpoint.plan !== signature || checkpoint.jobId !== jobId) return blocked('EGRESS_CHECKPOINT_MISMATCH')
    const check = () => {
      if (signal?.aborted) throw new Error('EGRESS_INTERRUPTED')
      const s = getState()
      if (s.phase !== 'spawned' || s.dead || s.isDead || s.lifecycle?.dead || !(s.health > 0)) throw new Error('EGRESS_NOT_ALIVE')
      if (s.inventory?.known !== true || s.inventory.uncertain) throw new Error('EGRESS_INVENTORY_UNKNOWN')
      const life = s.lifecycle?.deathId
      if (typeof s.profile !== 'string' || !s.profile || s.realm?.id == null || typeof s.connectionId !== 'string' || !s.connectionId || typeof s.startedAt !== 'string' || !s.startedAt || s.dimension == null || s.runtimeEntityId == null || !Number.isSafeInteger(life) || life < 0) throw new Error('EGRESS_SCOPE_UNKNOWN')
      if (!restoring && checkpoint.scope === null) { checkpoint.scope = scope(s); checkpoint.life = life }
      if (checkpoint.scope !== scope(s) || checkpoint.life !== life) throw new Error('EGRESS_SCOPE_CHANGED')
      if (health === null) health = s.health
      else if (s.health < health) throw new Error('EGRESS_DAMAGED')
      return s
    }
    const save = async () => onCheckpoint(copy(checkpoint))
    const verifyPosition = async (centre, refusedReason, previousStamp = null) => {
      const s = check(), pose = usableServerPose(s, centre, now(), !!confirmPosition)
      if (pose && (previousStamp == null || pose.stamp !== previousStamp)) {
        checkpoint.positionEvidence = { kind: 'server_position', position: copy(pose.position), stamp: pose.stamp }
        return
      }
      if (!confirmPosition) throw new Error(refusedReason)
      const started = now(), receipt = await confirmPosition(copy(centre), { signal, operationId })
      const after = check()
      if (!validPositionVolume(receipt, centre, started, now(), scope(after)) || positionRequests.has(receipt.requestId)) throw new Error(refusedReason)
      positionRequests.add(receipt.requestId)
      checkpoint.positionEvidence = copy(receipt)
    }
    const workingNear = (s, centre) => {
      const feet = workingFeet(s)
      return feet && Math.hypot(feet.x - centre.x, feet.y - centre.y, feet.z - centre.z) <= 0.18
    }
    const move = async (cell, settings = {}) => {
      const beforeState = check(), before = serverPose(beforeState), centre = { x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 }
      if (usableServerPose(beforeState, centre, now(), !!confirmPosition) || confirmPosition && workingNear(beforeState, centre)) { await verifyPosition(centre, 'EGRESS_POSITION_UNCONFIRMED'); return }
      await moveTo(cell, { ...settings, signal })
      await verifyPosition(centre, 'EGRESS_POSITION_UNCONFIRMED', before?.stamp)
    }
    const planned = new Map((plan.shaftCells ?? []).map(cell => [key(cell.position), cell]))
    const clearAbove = async feetY => {
      const targets = []
      for (let y = feetY; y <= Math.min(feetY + 3, plan.clearTopY ?? plan.targetFeetY + 2); y++) {
        const p = { x: plan.column.x, y, z: plan.column.z }, block = getBlock(p.x, p.y, p.z)
        if (air(block)) continue
        const intent = planned.get(key(p))
        if (block?.known !== true) throw new Error('EGRESS_TERRAIN_UNKNOWN')
        // Ores planned into the shaft are dug like the plan allows (live
        // 2026-11-11 1:22: copper ore at Y36 was refused as protected).
        if (!intent || block.protected || exitDigRule(block.name).kind !== 'dig' || block.diggable === false || block.extra?.length || HAZARD.test(block.name) || block.name !== intent.name || intent.expectedRuntimeId != null && block.runtimeId !== intent.expectedRuntimeId) throw new Error('EGRESS_SHAFT_CHANGED')
        targets.push(copy(intent))
      }
      if (targets.length) {
        await mineTargets(targets, { signal })
        check()
        if (targets.some(({ position: p }) => !air(getBlock(p.x, p.y, p.z)))) throw new Error('EGRESS_MINING_UNCONFIRMED')
      }
    }
    busy = true
    try {
      // Reconnect during the ascent (live 2026-11-10 13:16): the same account,
      // realm, dimension and life on a new connection may continue only after
      // the server confirms the bot on the column at the checkpoint's height
      // (one higher when the pending step's dirt is already received).
      if (restoring && request.reconnect === true && confirmPosition && typeof checkpoint.scope === 'string' && ['entry', 'ascent'].includes(checkpoint.phase)) {
        const s = getState(), current = scope(s)
        let old = null; try { old = JSON.parse(checkpoint.scope) } catch {}
        const next = JSON.parse(current)
        const sameIdentity = Array.isArray(old) && old[0] === next[0] && old[1] === next[1] && old[4] === next[4] && old[6] === next[6] && checkpoint.life === s.lifecycle?.deathId
        if (current !== checkpoint.scope && sameIdentity && checkpoint.phase === 'ascent') {
          const p = checkpoint.pendingStep?.target
          const placed = p && p.x === plan.column.x && p.z === plan.column.z && p.y === checkpoint.confirmedFeetY && getBlock(p.x, p.y, p.z)?.known === true && getBlock(p.x, p.y, p.z)?.name === 'minecraft:dirt'
          const centre = { x: plan.column.x + 0.5, y: checkpoint.confirmedFeetY + (placed ? 1 : 0), z: plan.column.z + 0.5 }
          const started = now(), receipt = await confirmPosition(copy(centre), { signal, operationId })
          if (!validPositionVolume(receipt, centre, started, now(), current)) return blocked('EGRESS_SCOPE_CHANGED')
          positionRequests.add(receipt.requestId)
          checkpoint.rebound = { from: checkpoint.scope, to: current, evidence: copy(receipt) }
          checkpoint.scope = current; checkpoint.positionEvidence = copy(receipt)
          await save()
        }
      }
      const initial = check()
      if (checkpoint.phase === 'completed') {
        await verifyPosition({ x: plan.landing.x + 0.5, y: plan.landing.y, z: plan.landing.z + 0.5 }, 'EGRESS_LANDING_CHANGED')
        await save()
        return { status: 'completed', serverConfirmed: true, checkpoint }
      }
      if (checkpoint.pendingStep) {
        const pending = checkpoint.pendingStep, p = pending.target
        if (pending.phase === 'not_sent') { checkpoint.pendingStep = null; await save() }
        else {
          // A placement sent but never acknowledged (live 2026-11-10 13:12) is
          // accepted only on full received evidence: the target is now dirt, at
          // most one dirt was spent since the step began (the spend may already
          // be in the count taken at the intent, live 19:50), and the server
          // confirms the feet one block higher (checked just below).
          const unacked = pending.phase === 'placement_pending' && p && p.x === plan.column.x && p.z === plan.column.z && p.y === checkpoint.confirmedFeetY &&
            getBlock(p.x, p.y, p.z)?.known === true && getBlock(p.x, p.y, p.z)?.name === 'minecraft:dirt' && Number.isSafeInteger(pending.beforeDirt) && [pending.beforeDirt - 1, pending.beforeDirt].includes(dirtTotal(check()))
          if (unacked) { pending.phase = 'completed'; pending.serverConfirmed = true; pending.reconciledBy = 'received_dirt_block_one_dirt_spent_and_server_position' }
          // The opposite evidence: the target is still received air, no dirt was
          // spent, and the server confirms the feet at the old height. The step
          // never happened, so it is cleared and sent again as a new step.
          const neverPlaced = !unacked && pending.phase === 'placement_pending' && p && p.x === plan.column.x && p.z === plan.column.z && p.y === checkpoint.confirmedFeetY &&
            air(getBlock(p.x, p.y, p.z)) && Number.isSafeInteger(pending.beforeDirt) && dirtTotal(check()) === pending.beforeDirt
          if (neverPlaced) {
            await verifyPosition({ x: p.x + 0.5, y: p.y, z: p.z + 0.5 }, 'ASCENT_UNCERTAIN_STEP')
            checkpoint.pendingStep = null; await save()
          } else {
          if (pending.phase !== 'completed' || pending.serverConfirmed !== true || !p || p.x !== plan.column.x || p.z !== plan.column.z || p.y !== checkpoint.confirmedFeetY || getBlock(p.x, p.y, p.z)?.known !== true || getBlock(p.x, p.y, p.z)?.name !== 'minecraft:dirt') return blocked('ASCENT_UNCERTAIN_STEP')
          await verifyPosition({ x: p.x + 0.5, y: p.y + 1, z: p.z + 0.5 }, 'ASCENT_UNCERTAIN_STEP')
          checkpoint.steps.push(copy(pending)); checkpoint.confirmedFeetY++; checkpoint.pendingStep = null; await save()
          }
        }
      }
      if (dirtTotal(initial) < plan.targetFeetY - checkpoint.confirmedFeetY + (plan.reserveDirt ?? 8)) return blocked('EXIT_DIRT_REQUIRED')
      if (checkpoint.phase === 'entry') {
        await save(); await move(plan.entry, { ...(Array.isArray(plan.entryPath) ? { path: copy(plan.entryPath) } : {}) }); await clearAbove(plan.startFeet.y); await move(plan.startFeet)
        checkpoint.phase = 'ascent'; await save()
      } else if (!(checkpoint.phase === 'landing' && (usableServerPose(check(), { x: plan.landing.x + 0.5, y: plan.landing.y, z: plan.landing.z + 0.5 }, now(), !!confirmPosition) || confirmPosition && workingNear(check(), { x: plan.landing.x + 0.5, y: plan.landing.y, z: plan.landing.z + 0.5 })))) {
        const centre = { x: plan.column.x + 0.5, y: checkpoint.confirmedFeetY, z: plan.column.z + 0.5 }
        await verifyPosition(centre, 'EGRESS_RESUME_POSITION_CHANGED')
        // Every step was confirmed when it was made. On resume, the block that
        // carries the bot (the latest step, under the confirmed feet) must still
        // be received dirt; a block lower in the finished part of the pillar
        // does not carry the climb (live 2026-11-11 1:00: Y-56 became air while
        // the bot stood at Y-24) and is only recorded.
        if (checkpoint.steps.some(step => step.serverConfirmed !== true)) return blocked('EGRESS_PILLAR_CHANGED')
        const support = checkpoint.steps.length ? checkpoint.steps[checkpoint.steps.length - 1].target : null
        if (support && (support.y !== checkpoint.confirmedFeetY - 1 || getBlock(support.x, support.y, support.z)?.known !== true || getBlock(support.x, support.y, support.z)?.name !== 'minecraft:dirt')) return blocked('EGRESS_PILLAR_CHANGED')
        const missing = checkpoint.steps.filter(step => step !== checkpoint.steps[checkpoint.steps.length - 1] && !(getBlock(step.target.x, step.target.y, step.target.z)?.known === true && getBlock(step.target.x, step.target.y, step.target.z)?.name === 'minecraft:dirt')).map(step => step.target.y)
        if (missing.length) { checkpoint.pillarGaps = missing; await save() }
      }
      while (checkpoint.confirmedFeetY < plan.targetFeetY) {
        const s = check(), feetY = checkpoint.confirmedFeetY
        if (dirtTotal(s) < plan.targetFeetY - feetY + (plan.reserveDirt ?? 8)) return blocked('EXIT_DIRT_REQUIRED')
        await clearAbove(feetY)
        const result = await pillarStep({ jobId, operationId, column: plan.column, feetY }, { signal, onCheckpoint: async step => { checkpoint.pendingStep = copy(step); await save() } })
        if (result?.status !== 'completed' || result.serverConfirmed !== true || result.checkpoint?.phase !== 'completed') {
          if (result?.checkpoint?.phase === 'not_sent') { checkpoint.pendingStep = null; await save() }
          else if (result?.checkpoint) { checkpoint.pendingStep = copy(result.checkpoint); await save() }
          return blocked(result?.reason ?? 'ASCENT_UNCONFIRMED')
        }
        checkpoint.steps.push(copy(result.checkpoint)); checkpoint.confirmedFeetY = feetY + 1; checkpoint.pendingStep = null
        await save()
      }
      checkpoint.phase = 'landing'; await save()
      const p = plan.landing, floor = getBlock(p.x, p.y - 1, p.z)
      if (floor?.known !== true || floor.boundingBox !== 'block' || floor.extra?.length || HAZARD.test(floor.name) || !air(getBlock(p.x, p.y, p.z)) || !air(getBlock(p.x, p.y + 1, p.z))) return blocked('EGRESS_LANDING_UNSAFE')
      await move(p)
      checkpoint.phase = 'completed'; checkpoint.serverConfirmed = true; checkpoint.confirmedBy = 'server_pillar_and_landing'
      await save()
      return { status: 'completed', serverConfirmed: true, checkpoint: copy(checkpoint) }
    } catch (error) { return blocked(error.code ?? error.message) } finally { busy = false }
  }
  return { run, snapshot: () => ({ busy }) }
}

module.exports = { createQuarryEgressRuntime }
