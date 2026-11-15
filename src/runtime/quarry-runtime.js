'use strict'

// Moved out of runtime.js unchanged by scripts/extract-runtime-block.js.
// `rt` exposes the runtime closure bindings this code uses; each read or write
// of rt.<name> reads or writes the runtime's own variable at that moment.
// Modules are loaded through rt.require, the runtime's own require.

function createQuarryRuntime (rt) {
  function quarryDir () { return rt.require('node:path').resolve(rt.__dirname, '..', '.local', 'quarry') }
  const quarryStorage = rt.createQuarryStore({
    directory: quarryDir(),
    onSaved: doc => {
      if (!rt.disposed && rt.quarryJob?.document()?.instanceId === doc.instanceId) rt.host.shared.quarryDocument = doc
    }
  })
  let quarryLoadSequence = 0
  let quarryRestoreTask = null
  function cancelQuarryRestore () {
    quarryLoadSequence++
    rt.host.shared.quarryRestoreDisabled = true
    rt.host.shared.quarryRestoreTried = true
  }
  function quarryEvidence (target, state) {
    const exposure = rt.combatAttackExposure(target, state)
    return { route: exposure.evidence.routeToBot, sight: exposure.evidence.sight, intercept: exposure.intercept, unknown: exposure.unknown }
  }
  // Own shulker out in the world: its recovery has priority over combat
  // (2026-11-14 user). Hits taken meanwhile are logged; once the box is back in
  // the received inventory the hold ends and combat proceeds as usual.
  const shulkerHoldLog = { key: null, at: 0, health: null }
  function quarryShulkerHold (target, state) {
    let hold = null
    try { hold = rt.quarryJob?.shulkerHold?.() ?? null } catch {}
    // The trip's own supply box between breaking and recovery (same rule as the quarry).
    if (!hold && rt.host.shared.travelShulkerHold) hold = rt.host.shared.travelShulkerHold
    if (!hold) { shulkerHoldLog.health = null; shulkerHoldLog.key = null; return null }
    const hp = Number(state?.health)
    if (Number.isFinite(hp) && Number.isFinite(shulkerHoldLog.health) && hp < shulkerHoldLog.health) rt.host.log(`露天掘り: 箱の作業中に被弾 HP ${shulkerHoldLog.health}→${hp} (${hold.operationId} ${hold.stage})。戦闘は箱の回収の確定まで保留`)
    if (Number.isFinite(hp)) shulkerHoldLog.health = hp
    const key = `${hold.operationId}|${hold.stage}`, at = Date.now()
    if (key !== shulkerHoldLog.key || at - shulkerHoldLog.at > 5000) {
      shulkerHoldLog.key = key; shulkerHoldLog.at = at
      const d = target?.position && state?.position ? Math.hypot(target.position.x - state.position.x, target.position.y - state.position.y, target.position.z - state.position.z) : null
      rt.host.log(`露天掘り: 箱の回収を優先して戦闘を保留: target=${String(target?.entityType ?? target?.name ?? '?').replace('minecraft:', '')} distance=${d == null ? '?' : d.toFixed(1) + 'm'} box=${hold.box ?? '?'} stage=${hold.stage} operation=${hold.operationId}`)
    }
    return { allowed: false, reason: 'SHULKER_RECOVERY_PRIORITY', stage: hold.stage }
  }
  // 2026-11-14 02:01 user: "満腹度が一定以下になると体力を回復しなくなるので、満腹度が
  // 一定以下の場合は食事を取るようにしてください". While no quarry work runs (paused,
  // waiting), a received hunger below 18 starts the ordinary eat operation and
  // it repeats up to 20. requireIdle() keeps it out of combat, box work and any
  // other operation; refused attempts just wait for the next check.
  const idleEat = { timer: null, toFull: false, busy: false, refusedAt: 0 }
  const idleEatTick = async () => {
    if (rt.disposed || rt.disposing) { clearInterval(idleEat.timer); return }
    if (idleEat.busy || rt.quarryJob?.holdsWork()) return
    const v = rt.host.shared.vitals?.hunger, hunger = Number.isFinite(v) ? v : Number.isFinite(v?.value) ? v.value : null
    if (hunger == null) return
    if (hunger < 18) idleEat.toFull = true
    if (hunger >= 20) idleEat.toFull = false
    if (!idleEat.toFull) return
    let s = null
    try { s = rt.working() } catch { return }
    if (s?.phase !== 'spawned' || s.dead || s.isDead || !(s.health > 0) || s.inventory?.known !== true) return
    // Rotten flesh is the last resort below 18 when nothing else is edible (2026-11-15: HP 8.5, hunger 9, no natural healing).
    const hasFood = (s.inventory.items ?? []).some(i => i.count > 0 && rt.require('./quarry/quarry-inventory').isFood(i.name)), hasRotten = (s.inventory.items ?? []).some(i => i.count > 0 && i.name === 'minecraft:rotten_flesh')
    if (!hasFood && !(hasRotten && hunger < 18)) { idleEat.toFull = false; return }
    idleEat.busy = true
    try { await rt.operations.food.eat(hasFood ? {} : { allowEmergencyRotten: true }); rt.host.log(`待機中の食事: 満腹度 ${hunger} → 食事しました`) } catch (error) {
      if (Date.now() - idleEat.refusedAt > 60000) { idleEat.refusedAt = Date.now(); rt.host.log(`待機中の食事を見送り: 満腹度 ${hunger} (${String(error.message ?? error).slice(0, 80)})`) }
    } finally { idleEat.busy = false }
  }
  // Never throws out of the timer: a fault only logs (a timer error ends the process).
  idleEat.timer = setInterval(() => { idleEatTick().catch(error => { idleEat.busy = false; try { rt.host.log(`待機中の食事の確認に失敗: ${String(error?.message ?? error).slice(0, 120)}`) } catch {} }) }, 5000)
  idleEat.timer.unref?.()
  // Drowned are fought as melee enemies on land (coordinator 2026-11-14: a drowned
  // killed the bot at 18:48 while it would not fight back); never from the water.
  function drownedOnLand (target, state) { return /drowned/.test(String(target?.entityType ?? target?.name ?? '')) && state?.isInWater !== true && state?.phase === 'spawned' }
  // Player mode running from enemies at low health (src/modes/player-flee.js): combat stands down for those seconds.
  const playerFleeing = () => rt.host.shared.playerFlee?.until > Date.now()
  function quarryCanSelectTarget (target, state, info = {}) { if (!drownedOnLand(target, state) && !rt.require('./safety/learning-health').emptyHandedTargetAllowed(state, target)) return { allowed: false, reason: 'EMPTY_HANDED_AVOID' }; if (playerFleeing()) return { allowed: false, reason: 'PLAYER_FLEE' }; if (rt.travelRuntime.longTravel?.status?.().busy && /witch/.test(String(target?.entityType ?? target?.name ?? ''))) return { allowed: false, reason: 'TRAVEL_AVOID_WITCH' }; const hold = quarryShulkerHold(target, state); if (hold) return hold; return rt.quarryJob?.holdsWork() ? rt.quarryJob.bridge.canSelectTarget(target, state, { ...quarryEvidence(target, state), provoked: info.provoked === true }) : { allowed: true, reason: 'NO_QUARRY_JOB' } }
  function quarryCanContinue (target, state, info = {}) { if (!rt.require('./safety/learning-health').emptyHandedTargetAllowed(state, target)) return { allowed: false, reason: 'EMPTY_HANDED_AVOID' }; if (playerFleeing()) return { allowed: false, reason: 'PLAYER_FLEE' }; const hold = quarryShulkerHold(target, state); if (hold) return hold; return rt.quarryJob?.holdsWork() ? rt.quarryJob.bridge.canContinue(target, state, { ...quarryEvidence(target, state), provoked: info.provoked === true, retreating: info.retreating === true || rt.quarryRetreatDepth > 0 }) : { allowed: true, reason: 'NO_QUARRY_JOB' } }
  function quarryState () {
    const state = rt.lightweightUserState()
    const hunger = rt.host.shared.vitals?.hunger
    return { ...state, food: Number.isFinite(hunger) ? hunger : Number.isFinite(hunger?.value) ? hunger.value : state.food ?? null, deathCause: rt.host.shared.deathRespawn?.cause ?? null, inventory: rt.host.shared.inventoryUncertain ? { ...state.inventory, uncertain: true } : state.inventory }
  }
  function confirmQuarryPosition (feet, settings) {
    rt.quarryPositionVerifier ??= rt.createServerPositionVerifier({ client: rt.host.client, getState: quarryState })
    return rt.quarryPositionVerifier.confirm(feet, settings)
  }
  function requestQuarryTerrain (request, settings) {
    rt.quarryTerrainRequester ??= rt.createQuarryTerrainRequester({ client: rt.host.client, getState: quarryState, world: rt.host.world })
    return rt.quarryTerrainRequester.request(request, settings)
  }
  async function runQuarryEgress (adapter, live, own, request, options = {}) {
    if (rt.quarryEgressTask) throw new Error('EGRESS_BUSY')
    const controller = new AbortController()
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
    const read = quarryBlockReader(), config = rt.quarryJob?.document()?.config ?? {}
    const policy = { ...(config.tools ?? {}), ...(config.collection ?? {}) }
    const runner = rt.createQuarryEgressRuntime({
      getState: quarryState, getBlock: read,
      confirmPosition: (feet, settings) => confirmQuarryPosition(feet, settings),
      moveTo: (cell, settings) => {
        if (!rt.permitsExitAction(request.plan, 'travel', cell)) throw new Error('EGRESS_OUTSIDE_PERMITTED_COLUMN')
        return adapter.moveTo(cell, settings)
      },
      mineTargets: async (targets, settings = {}) => {
        for (const target of targets) {
          signal.throwIfAborted(); settings.signal?.throwIfAborted()
          const p = target.position
          if (!rt.permitsExitAction(request.plan, 'break', p)) throw new Error('EGRESS_OUTSIDE_PERMITTED_COLUMN')
          const block = read(p.x, p.y, p.z)
          if (block?.known && ['air', 'cave_air', 'void_air'].includes(rt.quarryNameOf(block))) continue
          if (block?.known !== true || block.protected || block.protectionSource || block.name !== target.name || block.extra?.length) throw new Error('EGRESS_TARGET_CHANGED')
          const state = quarryState(), rule = rt.require('./quarry/exit/quarry-exit-plan').exitDigRule(block.name)
          const tool = rt.quarrySelectTool(rule, state.inventory?.items, policy)
          if (!tool.ok) throw new Error('EXIT_TOOL_MISSING')
          if (tool.kind !== 'hand') await adapter.prepareMining(tool, { signal })
          else {
            const hand = state.inventory?.items?.find(item => item.count > 0 && item.durabilityKnown !== true && !/_(sword|pickaxe|axe|shovel|hoe)$|:(bow|crossbow|shears|trident|fishing_rod|flint_and_steel)$/.test(item.name ?? ''))
            if (!hand) throw new Error('EXIT_HAND_ITEM_REQUIRED')
            await own(slot => { rt.requireIdle(); return rt.inventory.equip(slot) })(hand.slot)
          }
          signal.throwIfAborted()
          await adapter.mine([{ ...p, expectedName: block.name, expectedRuntimeId: block.runtimeId ?? target.expectedRuntimeId ?? null, requiredTool: tool.kind === 'hand' ? null : tool, ...(request.allowFullInventory === true ? { allowFullInventory: true } : {}), ...(rule.exitOre ? { exitShaftOre: true } : {}) }], { signal })
        }
        return { phase: 'completed' }
      },
      pillarStep: (step, settings) => {
        if (!rt.permitsExitAction(request.plan, 'place', { ...step.column, y: step.feetY })) throw new Error('EGRESS_OUTSIDE_PERMITTED_COLUMN')
        return live().pillarStep(step, settings)
      }
    })
    rt.quarryEgressRuntime = runner; rt.quarryEgressAbort = controller
    const task = runner.run(request, { ...options, signal })
    rt.quarryEgressTask = task
    try { return await task } finally {
      if (rt.quarryEgressTask === task) { rt.quarryEgressTask = null; rt.quarryEgressAbort = null }
    }
  }
  // A bounded local diagnostic exercises the same controller without editing
  // the quarry cursor or granting mining permissions. It only uses the current
  // received column and is available while the job is paused.
  async function testQuarryPillar ({ steps = 1 } = {}) {
    if (!Number.isSafeInteger(steps) || steps < 1 || steps > 3) throw new Error('検証する土柱は1〜3段で指定してください。')
    if (!rt.quarryPorts || rt.quarryEgressTask || rt.quarryPillarTask || rt.quarryJob?.holdsWork() || rt.userBehaviorOwns() || rt.idleSafety?.snapshot().busy || rt.pendingStops.size) throw new Error('土柱の検証を始められる待機状態ではありません。')
    const state = quarryState(), source = state.position
    if (state.phase !== 'spawned' || !(state.health > 0) || !source) throw new Error('ASCENT_NOT_ALIVE')
    const feet = { x: Math.floor(source.x), y: Math.floor(source.y - 1.62 + 1e-3), z: Math.floor(source.z) }
    const job = ensureQuarryJob(), document = job.document()
    if (document?.state !== 'PAUSED') throw new Error('露天掘りを一時停止してから土柱を検証してください。')
    const adapterMove = rt.createQuarryRuntimeAdapter({ getState: quarryState, getBlock: quarryBlockReader(), entities: () => [], mining: rt.quarryPorts.mining, movement: rt.quarryPorts.movement, getMining: rt.quarryPorts.getMining, getMovement: rt.quarryPorts.getMovement, stopAll: () => {}, combatActive: () => false })
    const controller = new AbortController(), signal = controller.signal
    const operationId = 'pillar-validation:' + Date.now(), receipts = []
    rt.quarryEgressAbort = controller
    const task = (async () => {
      await adapterMove.moveTo(feet, { signal })
      for (let i = 0; i < steps; i++) {
        signal.throwIfAborted()
        const result = await rt.quarryPorts.pillarStep({ jobId: document.config.jobId, operationId, column: { x: feet.x, z: feet.z }, feetY: feet.y + i }, { signal, onCheckpoint: async checkpoint => { rt.host.shared.quarryPillarValidation = structuredClone(checkpoint) } })
        receipts.push(result)
        if (result.status !== 'completed' || result.serverConfirmed !== true) return { status: 'blocked', reason: result.reason, serverConfirmed: false, operationId, origin: feet, receipts }
      }
      return { status: 'completed', serverConfirmed: true, operationId, origin: feet, steps, receipts }
    })()
    rt.quarryEgressTask = task
    try { return await task } finally { if (rt.quarryEgressTask === task) { rt.quarryEgressTask = null; rt.quarryEgressAbort = null } }
  }
  // The planner reads thousands of cells per decision. planningWorld.getBlock
  // re-derives its protection overlays on every call, which can hold the event
  // loop long enough to stall the movement input timer, so reads are memoised
  // until the world revision changes (or for at most one second).
  function quarryBlockReader () {
    let cache = new Map(), revision = -1, at = 0
    return (x, y, z) => {
      const rev = typeof rt.host.world.revision === 'function' ? rt.host.world.revision() : null, t = Date.now()
      if (rev !== revision || t - at > 1000) { cache = new Map(); revision = rev; at = t }
      const k = x + ',' + y + ',' + z
      let b = cache.get(k)
      if (b === undefined) { b = rt.planningWorld.getBlock(x, y, z); cache.set(k, b) }
      return b
    }
  }
  // Quarry storage expansion: one more chest at the first candidate cell that
  // works. It reuses the depot storage controller, one primitive per step: a
  // carried chest is placed directly; otherwise planks are crafted from
  // carried logs, a crafting table is used (a nearby one, or one crafted and
  // placed at another candidate), and the chest is crafted and placed. Only a
  // server-confirmed chest block counts; nothing comes from commands.
  let quarryChestWork = null
  // Torches for the chest area (quarry). Crafted normally from carried coal or
  // charcoal plus sticks (planks from a carried log if needed); never by command.
  async function quarryCraftTorches ({ want = 8, signal } = {}) {
    const inv = () => rt.lightweightUserState().inventory?.items ?? []
    const count = re => inv().filter(i => re.test(i.name ?? '')).reduce((n, i) => n + i.count, 0)
    const torches = () => count(/^minecraft:torch$/)
    if (torches() >= want) return { ok: true, torches: torches() }
    if (!count(/^minecraft:(coal|charcoal)$/)) return { ok: torches() > 0, reason: 'NO_COAL', torches: torches() }
    const made = []
    try {
      await rt.crafting.openInventory()
      for (let guard = 0; guard < 6 && torches() < want && count(/^minecraft:(coal|charcoal)$/); guard++) {
        if (signal?.aborted) throw new Error('quarry torch crafting aborted')
        if (!count(/^minecraft:stick$/)) {
          if (!count(/_planks$/)) {
            const log = inv().find(i => /^minecraft:[a-z_]+_log$/.test(i.name ?? '') && !/stripped/.test(i.name))
            if (!log) return { ok: torches() > 0, reason: 'NO_WOOD', torches: torches(), made }
            await rt.crafting.craft(log.name.replace(/_log$/, '_planks'), { times: 1 }); made.push('planks')
          }
          await rt.crafting.craft('minecraft:stick', { times: 1 }); made.push('stick')
        }
        await rt.crafting.craft('minecraft:torch', { times: 1 }); made.push('torch')
      }
    } catch (error) { return { ok: torches() > 0, reason: 'CRAFT_FAILED', error: String(error.message).slice(0, 160), torches: torches(), made } }
    finally { try { rt.crafting.closeContainer() } catch {} }
    return { ok: torches() > 0, torches: torches(), made }
  }
  async function quarryPlaceTorch ({ position, signal } = {}) {
    let item = (rt.lightweightUserState().inventory?.items ?? []).find(i => i.name === 'minecraft:torch' && i.count > 0)
    if (!item) return { ok: false, reason: 'NO_TORCH' }
    if (item.slot > 8) { await rt.operations.inventory.equip(item.slot); item = (rt.lightweightUserState().inventory?.items ?? []).find(i => i.name === 'minecraft:torch' && i.count > 0 && i.slot <= 8) }
    if (!item) return { ok: false, reason: 'TORCH_NOT_IN_HOTBAR' }
    if (signal?.aborted) throw new Error('quarry torch placement aborted')
    await rt.interactions.placeBlock({ position, slot: item.slot, face: 1 })
    const b = rt.host.world.getBlock(position.x, position.y, position.z)
    return { ok: b?.known === true && b.name === 'minecraft:torch', block: b?.name ?? null }
  }
  async function quarryAddChest ({ candidates = [], signal } = {}) {
    quarryChestWork ??= rt.createDepotStorageWork({ getState: () => rt.lightweightUserState(), world: rt.host.world, crafting: rt.crafting, interactions: rt.interactions, chest: rt.chest, inventory: rt.inventory })
    const isAir = p => { const b = rt.host.world.getBlock(p.x, p.y, p.z); return b?.known === true && /^minecraft:(air|cave_air|void_air)$/.test(b.name) }
    const tried = []
    const crafted = []
    try {
      // The job walks to a stand beside candidates[0] before each call; the
      // other cells are only spare places for a crafting table.
      for (const cell of candidates.slice(0, 1)) {
        let lastKind = null
        for (let step = 0; step < 32; step++) {
          if (signal?.aborted) throw new Error('quarry add chest aborted')
          const b = rt.host.world.getBlock(cell.x, cell.y, cell.z)
          if (b?.known === true && b.name === 'minecraft:chest') return { ok: true, position: { ...cell }, crafted }
          const state = rt.lightweightUserState()
          const near = state.position ? rt.host.world.getArea({ x: Math.floor(state.position.x), y: Math.floor(state.position.y - 1.62), z: Math.floor(state.position.z) }, 3) : []
          const table = near.filter(x => x.known && x.name === 'minecraft:crafting_table').sort((a, c) => Math.hypot(a.position.x - state.position.x, a.position.z - state.position.z) - Math.hypot(c.position.x - state.position.x, c.position.z - state.position.z))[0]?.position ?? null
          const tableCell = candidates.find(c => (c.x !== cell.x || c.y !== cell.y || c.z !== cell.z) && isAir(c) && Math.abs(c.x - cell.x) + Math.abs(c.z - cell.z) >= 2) ?? null
          const options = { scope: rt.continuationScope(state), storageCell: cell, tablePosition: table, tableCell }
          const decision = quarryChestWork.preview(options)
          lastKind = decision.kind
          if (decision.kind === 'need_logs') return { ok: false, reason: 'NO_CHEST_MATERIAL', needs: { logs: decision.count ?? 2, planks: decision.missingPlanks ?? null }, crafted }
          if (['need_access', 'need_equip', 'need_table_cell', 'blocked', 'verify_chest_ownership', 'observe_inventory'].includes(decision.kind)) { tried.push({ cell, kind: decision.kind, reason: decision.reason ?? decision.errors?.[0] ?? null }); break }
          const result = await quarryChestWork.step(options, { signal })
          if (decision.kind === 'craft') crafted.push(decision.output)
          if (result?.phase === 'failed') { tried.push({ cell, kind: decision.kind, reason: result.reason ?? null }); break }
          await new Promise(resolve => setTimeout(resolve, 150))
        }
        if (lastKind && !tried.some(t => t.cell === cell)) tried.push({ cell, kind: lastKind, reason: 'STEP_LIMIT' })
      }
    } finally { try { rt.crafting.closeContainer() } catch {} }
    return { ok: false, reason: 'NO_PLACEABLE_CELL', tried: tried.slice(0, 6), crafted }
  }
  // Set by ensureQuarryJob: the guarded surface chest runner (manual storage).
  let quarrySurfaceChestRunner = null
  function ensureQuarryJob () {
    if (rt.quarryJob) return rt.quarryJob
    if (rt.disposed || rt.disposing) throw new Error('行動コードを更新しています。少し待ってからやり直してください。')
    if (!rt.quarryPorts) throw new Error('移動・採掘の準備がまだ終わっていません。スポーン後にやり直してください。')
    // Ports are looked up on every call: a teleport or respawn starts a new
    // input generation, and ports captured when the job was created would then
    // refuse every move/mine ("スポーン前の操作は終了しました") until a reload.
    const live = () => { if (!rt.quarryPorts) throw new Error('移動・採掘の準備がまだ終わっていません。'); return rt.quarryPorts }
    const own = fn => (...args) => live().own(fn)(...args)
    const ports = {
      mining: { preview: (...a) => live().mining.preview(...a), start: (...a) => live().mining.start(...a), stop: (...a) => live().mining.stop(...a) },
      movement: { preview: (...a) => live().movement.preview(...a), start: (...a) => live().movement.start(...a), stop: (...a) => live().movement.stop(...a) },
      getMining: () => live().getMining(), getMovement: () => live().getMovement()
    }
    let portableOwnedWindow = null
    const containerPorts = {
      open: own(async (position, slot, settings) => {
        rt.requireIdle(); rt.crafting.closeContainer()
        const owner = rt.portableActionOwners.currentOwner(), pending = rt.chest.open(position, slot, settings)
        const chestSerial = rt.portableActionOwners.serial(rt.chest), interactionSerial = rt.portableActionOwners.serial(rt.interactions)
        const result = await pending
        const window = rt.chestStatus().window, open = rt.craftStatus().openContainer
        if (owner && rt.portableActionOwners.isCurrent(owner) && result?.serverConfirmed === true && window && open && Number.isSafeInteger(window.epoch) && ['x', 'y', 'z'].every(axis => window.position?.[axis] === position[axis]) && rt.sameWindowId(window.id, open.id) && rt.sameWindowId(result.windowId, open.id) && rt.portableActionOwners.serial(rt.chest) === chestSerial && rt.portableActionOwners.serial(rt.interactions) === interactionSerial) portableOwnedWindow = { owner, epoch: window.epoch, id: rt.canonicalWindowId(open.id), type: String(open.type), interactionSerial }
        return result
      }),
      depositItem: own(settings => { rt.requireIdle(); return rt.chest.depositItem(settings) }),
      withdrawItem: own(settings => { rt.requireIdle(); return rt.chest.withdrawItem(settings) }),
      snapshot: () => rt.chest.snapshot(), status: rt.chestStatus, rawItem: slot => rt.chest.rawItem(slot), close: () => rt.crafting.closeContainer()
    }
    let surfaceChestController = null
    const verifySurfaceChestOwner = () => {
      const owner = rt.host.shared.quarrySurfaceStorageOwner
      owner?.signal?.throwIfAborted()
      if (owner && (rt.disposed || rt.disposing || owner.scope !== rt.portableCancellationScope() || owner.revision !== rt.quarryCancellationRevision)) throw Object.assign(new Error('SURFACE_STORAGE_INTERRUPTED'), { code: 'SURFACE_STORAGE_INTERRUPTED' })
    }
    quarrySurfaceChestRunner = (method, request, options) => runSurfaceChest(method, request, options)
    async function runSurfaceChest (method, request, options = {}) {
      options.signal?.throwIfAborted()
      if (rt.host.shared.quarrySurfaceStorageOwner) throw Object.assign(new Error('SURFACE_STORAGE_BUSY'), { code: 'SURFACE_STORAGE_BUSY' })
      const owner = { scope: rt.portableCancellationScope(), revision: rt.quarryCancellationRevision, signal: options.signal }
      rt.host.shared.quarrySurfaceStorageOwner = owner
      try {
        verifySurfaceChestOwner()
        const result = await surfaceChest()[method](request, options)
        verifySurfaceChestOwner()
        return result
      } finally {
        if (rt.host.shared.quarrySurfaceStorageOwner === owner) delete rt.host.shared.quarrySurfaceStorageOwner
      }
    }
    function surfaceChest () {
      if (surfaceChestController) return surfaceChestController
      return surfaceChestController = rt.createQuarryV22ChestWork({
        getState: () => { verifySurfaceChestOwner(); return quarryState() },
        getView: () => rt.inventoryInspection.snapshot(quarryState()),
        getRawMain: slot => rt.crafting.rawItem(slot),
        getRawChest: slot => rt.chest.rawItem(slot),
        getRawEquipment: (kind, slot) => rt.inventoryInspection.rawEquipment(kind, slot),
        open: (position, slot, options) => containerPorts.open(position, slot, options),
        close: () => rt.crafting.closeContainer(),
        withdraw: params => containerPorts.withdrawItem(params),
        deposit: params => containerPorts.depositItem(params),
        equipArmor: opts => rt.armor.equipBest(opts),
        equipmentTransfer: params => rt.quarryV22Equipment.transfer(params),
        resync: opts => adapter.resyncInventory(opts),
        getRefreshDelay: rt.inventoryResyncDelay
      })
    }
    function getSupplies () {
      return rt.quarrySupplies ??= rt.createQuarrySupplies({
        getState: quarryState, crafting: rt.crafting, chest: containerPorts, getPortable,
        refreshInventory: options => adapter.resyncInventory(options),
        getRefreshDelay: rt.inventoryResyncDelay
      })
    }
    async function preparePortablePlacement (context, { signal } = {}) {
      const generation = live(), initial = quarryState(), scope = rt.observedScope(initial)
      const fields = { profile: initial.profile, realmId: String(initial.realm?.id), dimension: initial.dimension, connectionId: initial.connectionId, startedAt: initial.startedAt, runtimeEntityId: String(initial.runtimeEntityId), life: initial.lifecycle?.deathId }
      if (!scope || !context?.scope || Object.keys(fields).some(key => fields[key] !== context.scope[key])) throw Object.assign(new Error('収納設置の接続範囲を確認できません。'), { code: 'STORAGE_SCOPE_CHANGED' })
      if (rt.quarryPlacementPreparation) throw Object.assign(new Error('別の設置準備が進行中です。'), { code: 'STORAGE_PLACEMENT_NOT_SETTLED' })
      const prep = { history: rt.inputHistory, revision: rt.quarryCancellationRevision, frame: null }
      rt.quarryPlacementPreparation = prep
      let lastTick = null, lastPosition = null, stableFrames = 0, health = initial.health
      const deadline = Date.now() + 4000
      const check = () => {
        signal?.throwIfAborted()
        const state = quarryState()
        if (rt.disposed || rt.disposing || live() !== generation || rt.inputHistory !== prep.history || rt.quarryCancellationRevision !== prep.revision || rt.observedScope(state) !== scope || state.health < health || rt.userBehaviorOwns()) throw Object.assign(new Error('収納設置準備が中断されました。'), { code: 'STORAGE_PREPARATION_INTERRUPTED' })
        health = Math.max(health, state.health)
        return state
      }
      try {
        while (Date.now() < deadline) {
          const state = check(), motion = generation.getMovement(), physical = state.predicted?.physicsState ?? state.physicsState
          const feet = state.position && { x: state.position.x, y: state.position.y - 1.62, z: state.position.z }
          if (motion.running || rt.motionActive() || generation.getMining()?.phase === 'mining' || rt.input?.stats().running || rt.armorTask || rt.manualArmorOwner) {
            stableFrames = 0; await rt.delay(50); continue
          }
          // Keep only the existing neutral physics stream running; never stop
          // another movement owner or replace an observed position to settle.
          rt.startIdle()
          const frame = prep.frame
          const ready = physical?.onGround === true && !physical.isInWater && !physical.isInLava && generation.standingClear(state, feet) && frame && Date.now() - frame.at >= 0 && Date.now() - frame.at <= 200 && Math.hypot(frame.position.x - state.position.x, frame.position.y - state.position.y, frame.position.z - state.position.z) <= 0.03
          if (!ready) { stableFrames = 0; lastPosition = null }
          else if (frame.tick !== lastTick) {
            stableFrames = lastPosition && Math.hypot(lastPosition.x - state.position.x, lastPosition.y - state.position.y, lastPosition.z - state.position.z) <= 0.01 ? stableFrames + 1 : 1
            lastTick = frame.tick; lastPosition = { ...state.position }
          }
          if (stableFrames >= 3) {
            const proof = await rt.controlLocation.confirm(feet, { signal, radius: 0.12, operationId: context.operationId + ':prepare_placement' })
            const after = check()
            if (proof?.serverConfirmed === true && Date.now() < deadline && generation.standingClear(after, { x: after.position.x, y: after.position.y - 1.62, z: after.position.z }) && Math.hypot(after.position.x - state.position.x, after.position.y - state.position.y, after.position.z - state.position.z) <= 0.03) return { ready: true, proof }
            stableFrames = 0; lastPosition = null
          }
          await rt.delay(50)
        }
        throw Object.assign(new Error('収納設置前の着地と実位置がまだ安定していません。'), { code: 'STORAGE_PLACEMENT_NOT_SETTLED' })
      } finally { if (rt.quarryPlacementPreparation === prep) rt.quarryPlacementPreparation = null }
    }
    async function reconcileCurrentPortablePlacement (request, options = {}) {
      const cp = request?.checkpoint
      if (request?.manual !== true || !cp?.scope || cp.intent?.type !== 'place') throw new Error('STORAGE_CURRENT_AUDIT_MANUAL_REQUIRED')
      await own(preparePortablePlacement)({ jobId: request.jobId, operationId: request.operationId, scope: cp.scope }, { signal: options.signal })
      const generation = live(), state = quarryState(), stream = rt.inputStream, scope = rt.observedScope(state)
      if (rt.quarryPlacementPreparation || !scope || !stream?.drainQueued) throw new Error('STORAGE_CURRENT_AUDIT_BUSY')
      const owner = { kind: 'current_storage_audit', history: rt.inputHistory, revision: rt.quarryCancellationRevision, generation, stream, scope, request, signal: options.signal, health: state.health, startedAt: Date.now(), deadline: Date.now() + 20000 }
      rt.quarryPlacementPreparation = owner
      try {
        requireCurrentPlacementAudit(owner)
        owner.drain = stream.drainQueued(); rt.inputOwner = 'none'
        if (owner.drain.queuedTransaction !== false || owner.drain.queuedActions !== 0) throw new Error('STORAGE_CURRENT_AUDIT_QUEUE_PENDING')
        owner.transactionGeneration = owner.drain.revision
        rt.startIdle()
        const current = requireCurrentPlacementAudit(owner), feet = { ...current.position, y: current.position.y - 1.62 }
        // Input and commands share Bedrock's RELIABLE_ORDERED channel 0.
        // This fresh reply follows all earlier queued input on this connection.
        const positionReceipt = await rt.controlLocation.confirm(feet, { signal: options.signal, radius: 0.12, operationId: request.operationId + ':current_fence' })
        requireCurrentPlacementAudit(owner)
        if (positionReceipt?.serverConfirmed !== true || positionReceipt.receivedAt < owner.drain.drainedAt) throw new Error('STORAGE_CURRENT_AUDIT_FENCE_UNCONFIRMED')
        owner.fence = { kind: 'drained_input_and_server_position_barrier', generation: rt.host.shared.loadoutGeneration, transactionGeneration: owner.transactionGeneration, startedAt: owner.drain.drainedAt, receivedAt: positionReceipt.receivedAt, drain: structuredClone(owner.drain), positionReceipt }
        return await getPortable().reconcileCurrentPlacement(request, options)
      } finally {
        if (rt.quarryPlacementPreparation === owner) rt.quarryPlacementPreparation = null
      }
    }
    function requireCurrentPlacementAudit (owner) {
      const state = quarryState(), stats = owner.stream.stats()
      if (owner.signal?.aborted || rt.disposed || rt.disposing || Date.now() >= owner.deadline || rt.quarryPlacementPreparation !== owner || live() !== owner.generation || rt.inputStream !== owner.stream || rt.inputHistory !== owner.history || rt.quarryCancellationRevision !== owner.revision || rt.observedScope(state) !== owner.scope || state.health < owner.health || rt.userBehaviorOwns() || rt.motionActive() || rt.input?.stats().running || rt.mining.snapshot().phase === 'mining' || rt.armorTask || rt.manualArmorOwner || rt.chestStatus().busy || rt.inventory.snapshot().busy || rt.craftStatus().pendingRequestId != null || rt.interactions.snapshot().pendingOperation != null || owner.transactionGeneration !== undefined && (stats.queuedActions !== 0 || stats.queuedTransaction !== false || stats.actionRevision !== owner.transactionGeneration)) throw new Error('STORAGE_CURRENT_AUDIT_INTERRUPTED')
      owner.health = Math.max(owner.health, state.health)
      return state
    }
    async function confirmCurrentPlacementState (context, { signal } = {}) {
      const owner = rt.quarryPlacementPreparation, cp = owner?.request?.checkpoint
      if (owner?.kind !== 'current_storage_audit' || !owner.fence || context.jobId !== cp?.jobId || context.operationId !== cp.operationId || JSON.stringify(context.scope) !== JSON.stringify(cp.scope) || ['x', 'y', 'z'].some(axis => context.position?.[axis] !== cp.intent.position[axis]) || context.slot !== cp.intent.slot || context.sourceStackId !== cp.placementSourcePin?.stackId) throw new Error('STORAGE_CURRENT_AUDIT_OWNER_CHANGED')
      signal?.throwIfAborted(); requireCurrentPlacementAudit(owner)
      rt.storagePlacementAudit ??= rt.createStoragePlacementAudit({ client: rt.host.client, getState: quarryState })
      const targetAirReceipt = await rt.storagePlacementAudit.confirmAir(context.position, { signal, operationId: cp.operationId })
      const state = requireCurrentPlacementAudit(owner), feet = { ...state.position, y: state.position.y - 1.62 }
      if (targetAirReceipt?.serverConfirmed !== true || targetAirReceipt.scope !== owner.scope) throw new Error(targetAirReceipt?.reason ?? 'STORAGE_CURRENT_TARGET_UNCONFIRMED')
      const positionReceipt = await rt.controlLocation.confirm(feet, { signal, radius: 0.12, operationId: cp.operationId + ':current_after_air' })
      requireCurrentPlacementAudit(owner); signal?.throwIfAborted()
      if (positionReceipt?.serverConfirmed !== true || positionReceipt.scope !== owner.scope) throw new Error('STORAGE_CURRENT_POSITION_UNCONFIRMED')
      return { serverConfirmed: true, kind: 'current_placement_state', scope: structuredClone(cp.scope), jobId: cp.jobId, operationId: cp.operationId, position: structuredClone(context.position), targetAir: true, quiet: true, generation: rt.host.shared.loadoutGeneration, transactionGeneration: owner.transactionGeneration, observedAt: positionReceipt.receivedAt, requestId: targetAirReceipt.requestId, fence: structuredClone(owner.fence), targetAirReceipt, positionReceipt }
    }
    function getPortable () {
      return rt.quarryPortableStorage ??= rt.createQuarryPortableStorage({ shulkerOnly: true,
        getState: quarryState,
        getObservationFreshness: () => ({
          inventoryObservedAt: rt.inventoryInspection.snapshot(quarryState()).observedAt,
          inventoryResync: rt.host.shared.inventoryResync?.lastRequest ?? null
        }),
        onRecoveryDiagnostic: diagnostic => {
          const summary = {
            operationId: diagnostic.operationId, scope: diagnostic.scope, stage: diagnostic.stage,
            checks: Object.fromEntries(Object.entries(diagnostic.checks).map(([name, check]) => [name, check.status])),
            baselineCount: diagnostic.baseline.count, actualCount: diagnostic.actual.count,
            candidateIds: diagnostic.actual.candidateIds, freshness: diagnostic.freshness
          }
          rt.host.log(`収納回収照合: ${JSON.stringify(summary)}`)
          for (const candidate of diagnostic.candidates) {
            rt.host.log(`収納回収内容差分: ${JSON.stringify({ operationId: diagnostic.operationId, slot: candidate.slot, stackId: candidate.stackId, status: candidate.contents.status, reason: candidate.contents.reason ?? null, differences: candidate.contents.differences, truncated: candidate.contents.truncated })}`)
          }
        },
        captureActionOwner: (kind, operation) => rt.portableActionOwners.createOwner({ ...operation, kind, generation: live(), revision: rt.quarryCancellationRevision, scope: rt.portableCancellationScope() }),
        runActionOwned: (owner, fn) => rt.portableActionOwners.run(owner, fn),
        getBlock: (x, y, z) => rt.host.world.getBlock(x, y, z),
        crafting: rt.crafting,
        chest: containerPorts,
        workWithContainer: (context, options) => getSupplies().workWithContainer(context, options),
        interactions: {
          snapshot: () => rt.interactions.snapshot(),
          previewPlace: settings => rt.interactions.previewPlace(settings),
          placeBlock: own(settings => { rt.requireIdle(); rt.crafting.closeContainer(); return rt.interactions.placeBlock(settings) })
        },
        equip: own(slot => rt.operations.inventory.equip(slot)),
        moveTo: (cell, settings) => adapter.moveTo(cell, settings),
        getPath: (origin, goal, owner) => ensureQuarryJob().portablePath(origin, goal, owner),
        travel: (position, owner) => ensureQuarryJob().portableTravel(position, owner),
        previewMove: cell => ports.movement.preview({ x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 }, { allowWater: false, maxDistance: 8, maxExpanded: 500 }),
        refreshInventory: ({ signal }) => adapter.resyncInventory({ signal }),
        preparePlacement: own(preparePortablePlacement),
        confirmPlacementState: confirmCurrentPlacementState,
        mine: async (target, { signal } = {}) => {
          signal?.throwIfAborted()
          // A cargo shulker's v2.2 break must preserve the selected pickaxe.
          // Normal supply / legacy recovery without requiredTool retains the
          // original non-damaging item behavior.
          if (target.requiredTool?.kind === 'pickaxe') {
            const hand = quarryState().heldItem
            if (!hand?.name || !/_(?:pickaxe)$/.test(hand.name) ||
                hand.durabilityKnown !== true ||
                !Number.isFinite(hand.durabilityRemaining) ||
                hand.durabilityRemaining <= target.requiredTool.reserve) {
              throw Object.assign(new Error('SHULKER_PICKAXE_UNCONFIRMED'), { code: 'SHULKER_PICKAXE_UNCONFIRMED' })
            }
          } else {
            const state = quarryState()
            const damaging = name => /_(sword|pickaxe|axe|shovel|hoe)$|^minecraft:(bow|crossbow|shears|trident|fishing_rod|flint_and_steel)$/.test(name ?? '')
            if (damaging(state.heldItem?.name)) {
              const held = state.inventory?.items?.find(item => item.count > 0 && !damaging(item.name) && item.durabilityKnown !== true)
              if (!held) throw new Error('箱回収に使う非耐久アイテムがありません。')
              await own(slot => rt.operations.inventory.equip(slot))(held.slot)
            }
          }
          signal?.throwIfAborted()
          rt.crafting.closeContainer()
          return ports.mining.start([target])
        },
        getMining: () => ports.getMining(), stopMining: (reason, owner) => rt.portableActionOwners.cancel(rt.mining, owner, () => rt.mining.stop(reason)),
        getEntities: () => rt.host.entities.snapshot({ kind: 'all' }),
        cancelAction: (kind, reason, owner) => {
          if (kind === 'equip') rt.portableActionOwners.cancel(rt.inventory, owner, () => rt.inventory.cancel(reason))
          else if (kind === 'place' || kind === 'interaction') rt.portableActionOwners.cancel(rt.interactions, owner, () => rt.interactions.cancel(reason))
          else if (kind === 'open' || kind === 'deposit' || kind === 'chest') {
            const proof = portableOwnedWindow, expected = proof?.owner?.context, actual = owner?.context
            const window = rt.chestStatus().window, open = rt.craftStatus().openContainer
            const closeOwned = rt.portableActionOwners.isCurrent(owner) && proof && expected?.generation === actual?.generation && expected?.revision === actual?.revision && expected?.scope === actual?.scope && expected?.jobId === actual?.jobId && expected?.operationId === actual?.operationId && window?.epoch === proof.epoch && rt.sameWindowId(window?.id, proof.id) && rt.sameWindowId(open?.id, proof.id) && String(open?.type) === proof.type && rt.portableActionOwners.serial(rt.interactions) === proof.interactionSerial
            rt.portableActionOwners.cancel(rt.chest, owner, () => rt.chest.cancel(reason))
            rt.portableActionOwners.cancel(rt.interactions, owner, () => rt.interactions.cancel(reason))
            if (closeOwned) { portableOwnedWindow = null; rt.crafting.closeContainer() }
          } else if (kind === 'mine' || kind === 'mining') {
            rt.portableActionOwners.cancel(rt.inventory, owner, () => rt.inventory.cancel(reason))
            rt.portableActionOwners.cancel(rt.mining, owner, () => rt.mining.stop(reason))
          } else if (kind === 'move' || kind === 'movement') owner?.context?.generation?.cancelPortableMovement(owner, reason)
        }
      })
    }
    const adapter = rt.createQuarryRuntimeAdapter({
      getState: quarryState,
      getBlock: quarryBlockReader(),
      requestTerrain: (request, options) => requestQuarryTerrain(request, options),
      confirmPosition: (feet, options) => confirmQuarryPosition(feet, options),
      // A prediction the server-position witness disproved (2026-11-13) is
      // discarded; the received raw position is never rewritten.
      discardPrediction: reason => rt.discardWorkingPrediction(reason),
      rawItem: slot => rt.crafting.rawItem(slot),
      inventoryDetails: () => rt.inventoryInspection.snapshot(rt.working()),
      attackAnimal: (runtimeId, options) => { if (!rt.combat) throw new Error('戦闘モジュールが未準備です。'); return rt.combat.animalAttack(runtimeId, options) },
      worldRevision: () => rt.host.world.revision?.() ?? null,
      entities: () => rt.host.entities.snapshot({ kind: 'all' }),
      mining: ports.mining, getMining: ports.getMining, movement: ports.movement, getMovement: ports.getMovement,
      previewStorageRoute: (target, options) => live().previewStorageRoute(target, options),
      equip: own(slot => rt.operations.inventory.equip(slot)),
      prepareMining: async (tool, { signal } = {}) => {
        if (signal?.aborted) throw new Error('採掘再開は中断されました。')
        if (tool.kind === 'hand') return { prepared: true }
        let state = quarryState(), item = state.inventory?.items?.find(item => item.slot === tool.slot)
        if (state.inventory?.known !== true || state.inventory.uncertain || item?.name !== tool.name || !(item.count > 0)) throw new Error('採掘再開前の道具を確認できません。')
        const expectedScope = rt.userScope(state), initialHealth = state.health
        const verify = () => {
          if (signal?.aborted) throw new Error('採掘再開は中断されました。')
          const current = quarryState(), actual = current.inventory?.items?.find(value => value.slot === tool.slot)
          if (rt.userScope(current) !== expectedScope || current.phase !== 'spawned' || current.dead || current.isDead || current.lifecycle?.dead || !(current.health > 0) || current.health < initialHealth || current.inventory?.known !== true || current.inventory.uncertain || actual?.name !== tool.name || !(actual.count > 0)) throw new Error('採掘再開前の接続・生存状態・実際の道具が変わりました。')
          return { state: current, item: actual }
        }
        // Near the final use, an air update can arrive before the tool's next
        // damage packet. Request fresh inventory before acquiring the equip
        // owner: inventoryResyncIdle deliberately refuses an existing owner.
        if (item.durabilityKnown === true && item.durabilityRemaining <= 9) {
          const refreshed = await rt.refreshInventoryWithRetry({
            refreshInventory: () => adapter.resyncInventory({ signal }),
            getRefreshDelay: rt.inventoryResyncDelay,
            verify: () => { verify(); rt.inventoryResyncIdle() },
            signal,
            waitErrorCode: 'RESYNC_RATE_LIMIT'
          })
          if (refreshed !== true) throw new Error('TOOL_DURABILITY_OBSERVATION_PENDING')
          ;({ state, item } = verify())
        }
        return own(async () => {
          verify(); rt.requireIdle()
          const result = await rt.inventory.equipForMining(tool.slot, { signal })
          if (signal?.aborted) throw new Error('採掘再開は中断されました。')
          const latest = quarryState(), selected = latest.inventory?.items?.find(value => value.slot === result.slot)
          if (rt.userScope(latest) !== expectedScope || latest.phase !== 'spawned' || latest.dead || latest.isDead || latest.lifecycle?.dead || latest.health < initialHealth) throw new Error('道具を選択した後の接続・生存状態が変わりました。')
          return { ...result, toolObservation: selected ? { slot: selected.slot, name: selected.name, stackId: selected.stackId ?? null, durabilityKnown: selected.durabilityKnown === true, durabilityRemaining: selected.durabilityRemaining } : null }
        })()
      },
      // Fresh inventory + selected slot from the server (quarry SLOW_BREAK).
      resyncInventory: async ({ signal } = {}) => {
        const startedAt = Date.now(); let sent = false; let lastError = null
        while (Date.now() - startedAt < 5000) {
          if (signal?.aborted) return false
          if (!sent) { try { await rt.requestInventoryResyncWithReceipt('quarry_slow_break'); sent = true } catch (error) { if (error.code === 'RESYNC_RATE_LIMIT') throw error; lastError = error } }
          const r = rt.host.shared.inventoryResync?.lastRequest
          if (sent && r?.status === 'FRESH_MAIN_OBSERVED' && Date.parse(r.requestedAt) >= startedAt - 50) return true
          await new Promise(resolve => setTimeout(resolve, 100))
        }
        if (!sent && lastError) throw lastError
        return false
      },
      placeQuarry: own(options => { rt.requireIdle(); rt.crafting.closeContainer(); return rt.interactions.placeQuarryBlock(options) }),
      eat: own(() => rt.operations.food.eat({})),
      equipmentTransfer: value => rt.quarryV22Equipment.transfer(value),
      equipmentView: () => rt.receivedEquipmentView(rt.inventoryInspection,rt.crafting,quarryState()),
      registeredHomeChest: () => rt.getRegisteredQuarryHomeSite(),
      logout: () => { if (rt.quarryJob?.status()?.state !== 'FINISHED' || rt.quarryJob?.status()?.persistence?.status === 'failed') throw new Error('QUARRY_LOGOUT_NOT_READY'); rt.host.disconnectOnCompletedQuarry() },
      chest: { open: own(position => rt.operations.chest.open(position)), depositItem: own(options => rt.operations.chest.depositItem(options)), close: () => rt.crafting.closeContainer() },
      addChest: own(options => { rt.requireIdle(); rt.crafting.closeContainer(); return quarryAddChest(options) }),
      egress: (request, options) => runQuarryEgress(adapter, live, own, request, options),
      storeCarried: (request, options) => getPortable().storeCarried(request, options),
      discoverSupplies: layout => getSupplies().discoverBindings(layout),
      loadoutWithdraw: (request,options) => runSurfaceChest('withdrawAll',request,options),
      finalChestDeposit: (request,options) => runSurfaceChest('depositAll',request,options),
      restockSupplies: (request, options) => getSupplies().run(request, options),
      previewSupplySite: (stand, options) => getPortable().previewSupplySite(stand, options),
      reconcileSupplyPlacement: (request, options) => getSupplies().reconcileUnsentPlacement(request, options),
      reconcileCarriedPlacement: (request, options) => getPortable().reconcileUnsentPlacement(request, options),
      reconcileCurrentPlacement: (request, options) => reconcileCurrentPortablePlacement(request, options),
      reconcileObservedPlacement: (request, options) => {
        // New placement receipts retain send facts. The portable controller
        // validates them and still requires fresh source, block and exact NBT.
        if (request.checkpoint?.intent?.placementFailure?.wireSent === true) return getPortable().reconcileObservedPlacement(request, options)
        const matched = rt.historicalEmptyPlacement({ checkpoint: request.checkpoint, recordedFailure: request.recordedFailure, events: rt.host.shared.inventoryEvents ?? [], state: quarryState() })
        if (!matched.ok) return { status: 'blocked', reason: matched.reason, checkpoint: structuredClone(request.checkpoint) }
        return getPortable().reconcileObservedPlacement({ ...request, placementEvidence: matched.proof }, options)
      },
      reconcileRejectedDeposit: (request, options) => {
        if (request.checkpoint?.intent?.rejectionProof) return getPortable().reconcileRejectedDeposit({ ...request, rejectionProof: request.checkpoint.intent.rejectionProof }, options)
        const matched = rt.historicalSourceRejection({ checkpoint: request.checkpoint, recordedFailure: request.recordedFailure, events: rt.host.shared.inventoryEvents ?? [], state: quarryState() })
        if (!matched.ok) return { status: 'blocked', reason: matched.reason, checkpoint: structuredClone(request.checkpoint) }
        return getPortable().reconcileRejectedDeposit({ ...request, rejectionProof: matched.proof }, options)
      },
      craftTorches: own(options => { rt.requireIdle(); return quarryCraftTorches(options) }),
      placeTorch: own(options => { rt.requireIdle(); rt.crafting.closeContainer(); return quarryPlaceTorch(options) }),
      stopAll: async reason => { try { rt.quarrySupplies?.cancel?.(reason) } catch {} rt.quarryEgressAbort?.abort(new Error(reason ?? 'EGRESS_INTERRUPTED')); rt.quarryPillar?.cancel(reason); try { ports.mining.stop(reason) } catch {} try { ports.movement.stop(reason) } catch {} try { rt.chest.cancel(reason) } catch {} try { rt.interactions.cancel(reason) } catch {} await Promise.allSettled([rt.quarryPillarTask, rt.quarryEgressTask]) },
      // Idle-protection escapes move the bot too; treat them like a fight so the
      // quarry yields movement instead of racing them.
      combatActive: () => { const b = rt.userBehaviorSnapshot(); return rt.userBehaviorLease?.kind === 'combat' || b.activeKind === 'combat' || b.claim?.kind === 'combat' || rt.idleSafety?.snapshot().busy === true },
      threatEvidence: target => quarryEvidence(target, rt.lightweightUserState()),
      recentDamageAt: () => { const at = Number(rt.host.shared.recentDamageNoPrimary?.at ?? NaN); return Number.isFinite(at) ? at : null },
      userControlInterruption: () => structuredClone(rt.host.shared.quarryUserPreemption ?? null),
      log: message => { try { rt.host.log(message) } catch {} }
    })
    adapter.onStarted = () => {
      const cfg = rt.quarryJob?.document()?.config
      rt.autonomy.stop('露天掘りを開始します。')
      if (!rt.host.shared.safetyWanted) { rt.host.shared.safetyEnableEpoch++; rt.host.shared.safetyWanted = true }
      if (cfg?.quarryCombat?.enabled !== false) {
        rt.host.shared.combatDefenseAnchor = null
        rt.quarryBehaviorRestore ??= { userBehaviorsEnabled: rt.host.shared.userBehaviorsEnabled === true }
        rt.host.shared.userBehaviorsEnabled = true
        rt.quarryCombatArmed = true
      }
      rt.resumeSafety()
    }
    adapter.onFinished = s => {
      rt.quarryCombatArmed = false
      if (rt.quarryBehaviorRestore) { rt.host.shared.userBehaviorsEnabled = rt.quarryBehaviorRestore.userBehaviorsEnabled; rt.quarryBehaviorRestore = null }
      try { rt.host.log(`露天掘り: ${s?.result?.type ?? s?.state}${s?.pauseReason ? ` (${s.pauseReason})` : ''}`) } catch {}
    }
    // Read the same durable reset record on demand. The dashboard may restart
    // after the chest is built; a cached in-memory location is not enough.
    adapter.registeredHomeChest = rt.getRegisteredQuarryHomeSite
    rt.quarryJob = rt.createQuarryJob({ adapter, storageMode: 'shulker', storage: quarryStorage, log: message => { try { rt.host.log(`露天掘り: ${message}`) } catch {} } })
    if (rt.host.shared.quarryDocument) { try { rt.quarryJob.load(rt.host.shared.quarryDocument) } catch (error) { rt.host.shared.quarryLoadError = String(error.message).slice(0, 200) } }
    return rt.quarryJob
  }
  function quarrySnapshot () {
    try { return rt.quarryJob ? rt.quarryJob.status() : rt.host.shared.quarryDocument ? { state: rt.host.shared.quarryDocument.state, jobId: rt.host.shared.quarryDocument.config?.jobId ?? null, pauseReason: rt.host.shared.quarryDocument.pauseReason ?? null, loaded: false } : null } catch (error) { return { error: String(error.message).slice(0, 200) } }
  }
  async function loadQuarryFile (jobId) {
    const ticket = ++quarryLoadSequence, generation = rt.quarryPorts
    const owner = ensureQuarryJob(), before = owner.document()?.instanceId ?? null
    const doc = await quarryStorage.load(jobId)
    if (rt.disposed || rt.disposing || ticket !== quarryLoadSequence || generation !== rt.quarryPorts || owner.document()?.instanceId !== before && !(before === null && owner.document() === null)) throw Object.assign(new Error('Quarry recovery context changed'), { code: 'RECOVERY_CONTEXT_CHANGED' })
    rt.assertJobWorld(doc, quarryState())
    const status = owner.load(doc)
    rt.host.shared.quarryDocument = owner.document()
    return status
  }

  // Supply boxes get new stack IDs on every connection; register them again
  // from the received inventory before an automatic resume (2026-11-13).
  async function rebindQuarrySupplies () {
    const doc = ensureQuarryJob().document()
    if (!doc?.config?.inventory?.supplyBoxes?.length) return
    try { await ensureQuarryJob().configureSupplies(); rt.host.log('露天掘り: 補給箱を再登録しました。') } catch (error) { rt.host.log(`露天掘り: 補給箱の再登録をせずに再開します: ${String(error.message).slice(0, 160)}`) }
  }
  async function restoreQuarryJob () {
    const job = ensureQuarryJob(), current = job.document()
    if (current) {
      if (!rt.recoverableQuarry(current) || !rt.QUARRY_AUTO_RESUMABLE.test(current.pauseReason ?? '')) return { skipped: 'job_loaded' }
      rt.assertJobWorld(current, quarryState())
      job.resume()
      return { loaded: current.config.jobId, resumed: true }
    }
    const ticket = quarryLoadSequence, generation = rt.quarryPorts
    const docs = await quarryStorage.list()
    if (rt.disposed || rt.disposing || rt.host.shared.quarryRestoreDisabled || ticket !== quarryLoadSequence || generation !== rt.quarryPorts || job.document()) throw Object.assign(new Error('Quarry recovery context changed'), { code: 'RECOVERY_CONTEXT_CHANGED' })
    const candidate = rt.selectRecoveryCandidate(docs, quarryState())
    if (!candidate) {
      // Only on the dashboard's reconnect after an unexpected disconnect (the
      // restore is disabled for a UI connect): a job left running but paused for
      // another reason is loaded and its own bounded retries are re-armed; a
      // placed-box operation stopped by the connection change is resumed once
      // (its takeover rules decide; anything unsafe pauses again).
      const paused = rt.host.shared.quarryRestoreAfterReconnect === true ? rt.require('./quarry/quarry-recovery').selectPausedRunningCandidate(docs, quarryState()) : null
      if (!paused) return { skipped: 'none' }
      const status = await loadQuarryFile(paused.config.jobId)
      const detail = status?.pauseDetails?.reason ?? null
      rt.host.log(`露天掘り: 再接続後に一時停止中のジョブを読み込みました: ${paused.config.jobId} (${status?.pauseReason ?? ''}${detail ? ' / ' + detail : ''})`)
      if (['SUPPLY_RESTOCK_BLOCKED', 'CARRIED_STORAGE_BLOCKED'].includes(status?.pauseReason) && ['SUPPLY_SCOPE_CHANGED', 'STORAGE_PICKUP_CAPACITY_REQUIRED', 'STORAGE_RECOVERY_SLOT_REQUIRED', 'STORAGE_WINDOW_CHANGED'].includes(detail)) {
        ensureQuarryJob().resume()
        return { loaded: paused.config.jobId, resumed: true, reason: status.pauseReason, detail }
      }
      const rearmed = ensureQuarryJob().rescheduleAutoResume()
      return { loaded: paused.config.jobId, resumed: false, rearmed: rearmed === true, reason: status?.pauseReason ?? null, detail }
    }
    const status = await loadQuarryFile(candidate.config.jobId)
    const reason = status?.pauseReason ?? ''
    rt.host.log(`露天掘り: 同じワールドのジョブを復元しました: ${candidate.config.jobId} (${reason || status?.state})`)
    if (!rt.QUARRY_AUTO_RESUMABLE.test(reason)) return { loaded: candidate.config.jobId, resumed: false, reason }
    await rebindQuarrySupplies()
    ensureQuarryJob().resume()
    return { loaded: candidate.config.jobId, resumed: true, reason }
  }

  function maybeRestoreQuarryJob () {
    if (rt.chunkMoveHeld()) return
    if (rt.manualChestStorage?.isBusy()) return
    if (rt.resetHeld()) return
    if (rt.disposed || rt.disposing || rt.host.shared.quarryRestoreDisabled || rt.host.shared.quarryRestoreTried || quarryRestoreTask || !rt.quarryPorts || Date.now() < (rt.host.shared.quarryRestoreNextAt ?? 0)) return
    const state = rt.raw()
    if (state.phase !== 'spawned' || !rt.host.shared.loadingScreenEnded || state.spawnPending || state.inventory?.known !== true || rt.host.shared.inventoryUncertain) return
    const attempt = rt.host.shared.quarryRestoreAttempts = (rt.host.shared.quarryRestoreAttempts ?? 0) + 1
    const task = restoreQuarryJob().then(result => {
      if (rt.disposed || rt.disposing) return
      rt.host.shared.quarryRestoreTried = true
      rt.host.shared.quarryRestore = { ...result, attempts: attempt }
      rt.host.log(`露天掘り: 再起動後の確認: ${JSON.stringify(result)}`)
    }).catch(error => {
      if (rt.disposed || rt.disposing) return
      const retry = !rt.host.shared.quarryRestoreDisabled && rt.retryableRecoveryError(error) && attempt < 3
      rt.host.shared.quarryRestoreTried = !retry
      rt.host.shared.quarryRestoreNextAt = retry ? Date.now() + 15000 * attempt : null
      rt.host.shared.quarryRestore = { error: String(error.message).slice(0, 200), code: error.code ?? null, attempts: attempt, retryScheduled: retry }
      rt.host.log(`露天掘り: 復元失敗 (${retry ? '再試行予定' : '自動再試行なし'}): ${String(error.message).slice(0, 160)}`)
    }).finally(() => { if (quarryRestoreTask === task) quarryRestoreTask = null })
    quarryRestoreTask = task
  }
  // resumeRequested is not reached while autonomy is running (as it is right
  // after a restart), so the restore also runs from its own timer.
  // A reset that switched command feedback on and never confirmed switching it
  // off (e.g. a disconnect mid-reset) is restored once after spawn (2026-11-13).
  const feedbackRestoreTimer = setInterval(() => {
    if (rt.disposed || rt.disposing) { clearInterval(feedbackRestoreTimer); return }
    if (rt.host.shared.feedbackRestoreChecked || rt.raw().phase !== 'spawned' || !rt.host.shared.loadingScreenEnded) return
    rt.host.shared.feedbackRestoreChecked = true
    Promise.resolve().then(() => rt.ensureLoadoutReset().restoreFeedbackIfPending?.()).then(result => { if (result) rt.host.log(`初期セット: コマンド応答の設定を戻しました ${JSON.stringify(result)}`) }).catch(error => rt.host.log(`初期セット: コマンド応答の復元を確認できません: ${String(error.message).slice(0, 160)}`))
  }, 15000)
  feedbackRestoreTimer.unref?.()
  const quarryRestoreTimer = setInterval(() => { if (rt.disposed || rt.disposing) { clearInterval(quarryRestoreTimer); return } try { maybeRestoreQuarryJob() } catch {} }, 15000)
  quarryRestoreTimer.unref?.()
  // Keep the quarry's terrain: its chunks and the exit column are never evicted
  // from the world cache, and eviction starts far from them and from the bot.
  return {
    quarryState,
    confirmQuarryPosition,
    quarrySnapshot,
    quarryCanSelectTarget,
    quarryCanContinue,
    requestQuarryTerrain,
    ensureQuarryJob,
    get quarrySurfaceChestRunner () { return quarrySurfaceChestRunner },
    testQuarryPillar,
    cancelQuarryRestore,
    loadQuarryFile,
    maybeRestoreQuarryJob,
    get quarryRestoreTask () { return quarryRestoreTask },
    get quarryRestoreTimer () { return quarryRestoreTimer },
    get quarryLoadSequence () { return quarryLoadSequence }, set quarryLoadSequence (value) { quarryLoadSequence = value }
  }
}

module.exports = { createQuarryRuntime }
