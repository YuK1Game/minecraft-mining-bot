'use strict'

const { packRoom, crowded } = require('./dragon-pack-room')
const { createDragonExpedition } = require('./dragon-expedition')
const { createDragonState } = require('./dragon-state')
const { objectiveNow, runDragonEarly } = require('./dragon-early')
const { stepNether } = require('./dragon-nether')
const { createDragonStronghold } = require('./dragon-stronghold')
const { runDragonEndStep } = require('./dragon-end')
const { recoverDragon } = require('./dragon-recovery')
const { createDragonSupplies } = require('./dragon-supplies')
const { nightHome } = require('./dragon-night')
const { heal, hungry, feed } = require('./dragon-heal')
const { createRest } = require('./dragon-rest-pit')
const { finishTree } = require('./dragon-tree')
const { createProgress } = require('./dragon-progress')
const { createGoalLedger } = require('./goal/goal-ledger')
const { goalKey, measure } = require('./dragon-goal-measure')
const { reserveCounts } = require('./dragon-reserve-seen')
const { mineWorldScope, sameWorld } = require('./mining/mine-state')
const { held, receivedInventory } = require('./mining/mine-observed')
const { constructionSupplies, builtWork } = require('./mining/mine-needs')
const { createJournal, expeditionJudge } = require('./decision-journal')
const { createIncidentRecorder } = require('./incident-snapshot')
const says = require('./dragon-judge')
const { inOwnMine, leaveOwnMine } = require('./dragon-mine-exit')

const HELD = '進まない目的を保留しています。場所・持ち物・接続が変わった時か、時間をおいて見直します。'
const LET_GO_MS = 60000
const cell16 = feet => feet && Number.isFinite(feet.x) ? [feet.x, feet.y, feet.z].map(v => Math.floor(v / 16)).join(',') : '?'

function createDragonRuntime (ports) {
  const { runtime, shared, root, getBlock } = ports
  const raw = runtime.raw
  const state = createDragonState({ root, shared, getState: raw, getBlock,
    getLife: () => runtime.host().getLife?.(), getWorldId: () => runtime.host().meta?.startGame?.seed })
  // The starter jobs get the player at the mine's entrance, not inside the mine (dragon-mine-exit.js).
  const legacyNeeded = memory => objectiveNow({ runtime, shared, memory, getFeet: ports.getFeet }).legacy === true &&
    !inOwnMine({ runtime, getFeet: ports.getFeet ?? (() => raw()?.position), record: memory })
  let stepRecord = null, unpin = false, triedFinishHold = null
  // The parent goal of the work (goal/goal-ledger.js): its clock, its budget and its hold are in `shared`, and
  // its checkpoint is saved with the record, so neither a reload nor a restart starts them again.
  const now = ports.now ?? Date.now
  const ledger = createGoalLedger({ shared, now, world: () => state.scope(), restore: () => { try { return state.snapshot()?.goal ?? null } catch { return null } } })
  // What a step may tell its goal: a confirmed step, a mark, a failure of one way (`spent` after three), a wait on purpose.
  // What the step chose and why, for the log (decision-journal.js); nothing reads it back.
  const journal = createJournal({ shared, log: ports.log, now })
  const incidents = ports.incidents ?? createIncidentRecorder({
    root, shared, getState: raw, getFeet: ports.getFeet, getBlock,
    getInventory: () => shared.inventoryUncertain ? null : runtime.inventory?.(),
    getGoal: () => ledger.goal(), log: ports.log, now
  })
  const goal = { step: key => ledger.step(key), mark: (key, value, by) => ledger.mark(key, value, by), fail: (failure, options) => ledger.fail(failure, options), spent: failure => ledger.spent(failure), clearFailures: () => ledger.clearFailures?.(), forget: failure => ledger.forget?.(failure),
    reached: kind => ledger.step(kind + '@' + cell16(raw()?.position)) }
  async function run (record, signal, recoverHealth, live = {}) {
    stepRecord = record
    ledger.run()
    // The choice a decision dropped is taken out of the record this run saves (the run before holds a copy of its own).
    if (unpin) { unpin = false; if (record.early) delete record.early.gather }
    const result = await step(record, signal, recoverHealth, live)
    const mark = ledger.checkpoint()
    if (mark) record.goal = mark
    return result
  }
  async function step (record, signal, recoverHealth, live) {
    const ctx = ports.stepPorts(signal)
    ctx.goal = { ...goal, wait: code => live.wait?.(code) }
    const judge = ctx.judge = expeditionJudge({ journal, goal: () => ledger.goal() })
    const dim = raw().dimension
    if (record.stage !== 'early') shared.dragonGoldBoots = dim === 'nether' || record.stage === 'nether'
    const opts = { signal, aborted: ctx.cancelled }
    const supplies = createDragonSupplies(ctx)
    Object.assign(ctx, { supplies, memory: record, rt: runtime, ports: ctx.hands, active: () => !ctx.cancelled(), ...opts })
    ctx.saveMine = async () => !ctx.cancelled() && await state.save(record) === true && !ctx.cancelled()
    const stronghold = createDragonStronghold(ctx)
    // The health wait's covered pit (dragon-rest-pit.js): left as soon as the wait is over, before anything else goes on.
    const rest = createRest({ ctx, health: () => raw().health, hostileDistance: () => runtime.nearestHostile?.(), dig: runtime.travel?.()?.travelNightPit, climb: ctx.rise, now })
    if (rest.inside() && !recoverHealth) { judge(...says.restLeave(raw().health)); return rest.leave() }
    // From dusk the overworld part before the Nether goes home to its bed when
    // on the surface (not safely working underground in the branch mine) (dragon-night.js).
    const inMine = dim === 'overworld' && require('./mining/mine-location').insideMine(ctx, record.early?.mine?.branch)
    const recoveryBlocksNight = !!record.recovery && !record.recovery.gather
    if (dim === 'overworld' && record.stage === 'early' && !inMine && !recoveryBlocksNight && !record.lootRecovery && !rest.inside() && !(recoverHealth && ports.threatened())) {
      const night = await nightHome(ctx, { clock: () => runtime.travel?.()?.travelClock?.() })
      if (night) { judge(...says.night(runtime.travel?.()?.travelClock?.())); return night }
    }
    // Planned mining stores its cargo in confirmed chests. Other expedition work retains its pack-room policy.
    const mine = record.early?.mine?.branch
    const capacityPending = mine?.capacityDestination || mine?.homeCapacityPending === true
    if (dim === 'overworld' && !recoverHealth && ctx.drop &&
        (capacityPending || crowded(shared.inventoryUncertain ? null : runtime.inventory()) && !ports.threatened())) {
      const returningToMine = record.stage === 'early' && ['early.diamond', 'early.home_reserve'].includes(ledger.goal()?.key)
      const stored = await require('./mining/mine-controller').minePackRoom(ctx, { returningToMine })
      if (stored) { judge(...says.mineCargo(runtime.inventory(), capacityPending)); return stored }
      if (!ports.threatened()) {
        const packed = await packRoom({ shared, getInventory: () => shared.inventoryUncertain ? null : runtime.inventory(), getFeet: ctx.getFeet, drop: ctx.drop, walk: ctx.walk, why: () => ctx.hands.why?.(), cells: ctx.cells, log: ctx.log })
        if (packed) { judge(...says.pack(runtime.inventory())); return packed }
      }
    }
    // Reconcile any timed-out mine placement before heal/hungry/recovery too:
    // low-health heal and hungry paths can delegate into mine work and hit
    // MINE_ACTION_UNCONFIRMED forever if they return before reconcilePlacement
    // runs (live 2026-11-27 19:27 JST, 2026-11-28 06:28 JST).
    if (dim === 'overworld' && record.stage === 'early') {
      const mineGoal = ['early.home_reserve', 'early.diamond'].includes(ledger.goal()?.key)
      if (mineGoal || record.recovery || record.lootRecovery || mine?.pendingAction) {
        const reconciled = await ctx.minePorts?.reconcilePlacement?.()
        if (reconciled) {
          judge(...says.mineMend(false))
          return { phase: 'waiting', reason: '設置先の受信結果を確認しました。縦坑・坑道の作業を続けます。' }
        }
      }
    }
    // The wait for health: a meal, the regeneration, or the way to food (dragon-heal.js).
    if (recoverHealth && dim !== 'end') {
      // Healing is the work now: more health than at any time since the last result is a mark, a hit and a heal in turn is none.
      ledger.mark('health', 20 - Number(raw().health), 2)
      judge(...says.heal(raw().health, ctx.operations.food?.snapshot?.()?.hunger))
      return heal({ ctx, record, dim, shared, runtime, threatened: ports.threatened, supplies, nether: stepNether, recover: recoverDragon, rest })
    }
    // Hunger of 6 or less and nothing to eat: a meal or the way to food before the work (dragon-heal.js).
    const want = hungry({ ctx, record, dim, shared, runtime, threatened: ports.threatened })
    if (want) { judge(...says.hungry(ctx.operations.food?.snapshot?.()?.hunger, want)); return feed(want, { ctx, supplies }) }
    // Bare while the house reserve already holds iron gear (a death while it was being stocked): the recovery is opened
    // once to take it back from the partial reserve (dragon-rearm.js, dragon-recovery.js `partial`).
    if (!record.recovery && dim === 'overworld' && record.stage === 'early' && !record.early?.reserveReady && require('./dragon-rearm').rearmWanted(ctx, record)) record.recovery = { at: Date.now(), cause: 'rearm', lootChecked: true, rearm: true }
    const hadRecovery = Boolean(record.recovery)
    if (dim === 'overworld' && record.stage === 'early' && record.recovery?.gather) {
      const way = supplies.weapon()
      if (way && (way.code === 'NOT_MADE' || !ports.threatened())) { judge(...says.weapon()); return supplies.arm(way) }
    }
    if (record.recovery || record.lootRecovery) {
      judge(...says.recover(record))
      const recovery = await recoverDragon(ctx, record)
      if (!recovery.done) return { phase: 'recovering', reason: recovery.reason }
      // When recovery cleared immediately (e.g. no reserve kit stocked yet) at night, re-check nightHome before leaving the house.
      if (hadRecovery && !record.recovery && dim === 'overworld' && record.stage === 'early' && !rest.inside() && !(recoverHealth && ports.threatened())) {
        const night = await nightHome(ctx, { clock: () => runtime.travel?.()?.travelClock?.() })
        if (night) { judge(...says.night(runtime.travel?.()?.travelClock?.())); return night }
      }
    }
    // Work of the starter jobs is due and the Bot is inside the mine: out by the ladder first (dragon-mine-exit.js).
    if (dim === 'overworld' && record.stage === 'early' && objectiveNow({ runtime, shared, memory: record, getFeet: ports.getFeet }).legacy === true) {
      const leaving = await leaveOwnMine(ctx)
      if (leaving) { judge(...says.mineExit(objectiveNow({ runtime, shared, memory: record, getFeet: ports.getFeet }).label)); return leaving }
    }
    // No weapon in the bag: a stone sword is made of what is carried before other work (carry-weapon.js).
    if (dim === 'overworld' && record.stage === 'early') {
      const way = supplies.weapon()
      // With the parts carried the sword is made even while hostiles are about: it is a moment's crafting, and the
      // fight preempts it as any other step. Waiting for a quiet moment kept the Bot unarmed among zombies (live
      // 2026-11-26 04:38-05:13 JST after the death at 04:34: 74 cobblestone, logs and a stick carried, no sword made,
      // 「被弾したため、攻撃を中断して退避します」 again and again at 10-15 health). Fetching wood still waits.
      if (way && (way.code === 'NOT_MADE' || !ports.threatened())) { judge(...says.weapon()); return supplies.arm(way) }
    }
    // A tree that was begun is cut down to its last log before other work (dragon-tree.js).
    if (dim === 'overworld' && (shared.playerTree || shared.playerScaffoldDebt) && !ports.threatened()) {
      const logs = shared.playerTree?.logs?.length, felling = await finishTree(ctx)
      if (felling) { judge(...says.tree(logs)); return felling }
    }
    const currentGoal = ledger.goal()
    if (currentGoal?.hold) {
      ledger.clearHold?.()
      currentGoal.hold = null
    }
    if (dim === 'end') {
      judge(...says.stage('end', dim))
      const result = await runDragonEndStep(ctx, record.end, opts)
      record.stage = 'end'
      return result
    }
    if (record.stage === 'end') {
      judge(...says.stage('endReturn', dim))
      if (dim !== 'overworld') return { phase: 'waiting', reason: 'エンド出撃所のある現世への復帰を待ちます。', wait: { code: 'DIMENSION' } }
      const result = record.end.returnAttempt ? await runDragonEndStep(ctx, record.end, opts) : {}
      if (result.phase === 'complete') {
        record.stage = 'complete'
        return { phase: 'completed', reason: result.reason }
      }
      return stronghold.enter(record, opts)
    }
    if (dim === 'nether' || record.stage === 'nether') {
      judge(...says.stage('nether', dim))
      const result = await stepNether(ctx)
      if (result.done && raw().dimension === 'overworld') { record.nether.finished = true; record.stage = 'stronghold'; shared.dragonGoldBoots = false }
      return result
    }
    if (dim !== 'overworld') { judge(...says.stage('dimension', dim)); return { phase: 'waiting', reason: '現在の次元を確認しています。', wait: { code: 'DIMENSION' } } }
    if (record.stage === 'stronghold') {
      judge(...says.stage('stronghold', dim))
      const result = await stronghold.step(record, opts)
      if (result.patch) Object.assign(record, result.patch)
      if (result.ready) { record.stronghold.prepared = true; record.stage = 'end' }
      return result
    }
    judge(...says.early(objectiveNow({ runtime, shared, memory: record, getFeet: ports.getFeet }), record))
    const result = await (ports.early ?? runDragonEarly)(ctx)
    if (result.done) { record.early.finished = true; record.stage = 'nether' }
    return result
  }
  const retryState = () => {
    const host = runtime.host?.(), inventory = shared.inventoryStore, chest = ports.operations?.chest?.snapshot?.()
    const night = require('../travel/night-stop').dayPhase(runtime.travel?.()?.travelClock?.())
    return {
      position: ports.getFeet?.(), terrainRevision: typeof host?.world?.revision === 'function' ? host.world.revision() : host?.world?.revision ?? null,
      inventoryRevision: JSON.stringify([inventory?.revision ?? null, Object.values(inventory?.containers?.main ?? {}).map(slot => slot.at)]),
      containerRevision: chest ? JSON.stringify([chest.window?.epoch, chest.contentsKnown, chest.slots]) : null,
      buildFree: ports.retryBuildFree?.() === true,
      priority: [ports.threatened?.() === true, ports.operations?.food?.snapshot?.()?.hunger ?? null, night.known, night.shelter, shared.inventoryUncertain === true]
    }
  }
  const expedition = createDragonExpedition({ ...ports, now, state, raw, run, legacyNeeded, retryState })
  // What a goal decided again forgets (dragon-progress.js): the pinned kit item, the home-approach rests, and the step itself.
  const progress = createProgress({ shared, ledger, now, log: ports.log, onReset: ({ waiting = null } = {}) => {
    expedition.reconsider()
    // Only a step that has not returned for LET_GO_MS is let go: one that answers every two seconds is asked again anyway.
    const letGo = expedition.stepMs() >= LET_GO_MS && expedition.abandon('進まない遠征の1歩をやめて、状態を再確認します。') && 'step'
    // A wait past its limit (another owner, the night) is only looked at again; the step's choices are for work that stood.
    if (waiting) return [letGo].filter(Boolean).join('・')
    const dropped = [stepRecord?.early?.gather && 'gather ' + stepRecord.early.gather.name, shared.dragonHomeWalk && 'homeWalk', shared.dragonHomeInner && 'homeInner', letGo].filter(Boolean)
    unpin = true
    delete shared.dragonHomeWalk; delete shared.dragonHomeInner
    return dropped.join('・')
  }, onStall: ({ code = 'NO_PROGRESS' } = {}) => {
    void incidents.capture({ source: 'expedition', code, reason: '進捗が止まったため診断スナップショットを保存し、選択を捨てて決め直します。', stage: stepRecord?.stage ?? null })
  } })
  // The goal the expedition works toward now; null while it cannot be told (nothing received yet).
  function keyNow () {
    let record = stepRecord
    if (!record) { try { record = state.peek ? state.peek() : state.snapshot() } catch { return null } }
    if (!record || state.scope() == null) return null
    if (record.stage !== 'early') return { key: goalKey(record), record }
    const objective = objectiveNow({ runtime, shared, memory: record, getFeet: ports.getFeet })
    // No objective of its own to name (the inventory is not received, or the expedition owns the player only to
    // recover what a death left): the goal it had goes on.
    return { key: goalKey(record, objective) ?? ledger.goal()?.key ?? 'early.recover', record }
  }
  // Looked at on every tick, not after a step: a step that never returns is a stall too. While another owner has
  // the player nothing is counted and nothing is cleared: the same goal goes on when the expedition has it again.
  function tick () {
    const owned = expedition.tick()
    if (!owned) return owned
    const at = keyNow()
    if (!at?.key) return owned
    const seen = raw(), armor = runtime.armor?.(), shown = expedition.status(), live = expedition.runState(), stepMs = expedition.stepMs()
    // Measured only from a received inventory and received armour; while either is open, nothing is counted as a result.
    const items = shared.inventoryUncertain || seen?.inventory?.known !== true || seen.inventory.uncertain ? null : seen.inventory.items
    const sized = armor && armor.known !== true ? null : measure({ key: at.key, items, worn: armor?.worn ?? [], reserve: reserveCounts(shared), record: at.record })
    progress.note(at.key, { feet: seen?.position, health: seen?.health, value: sized?.value ?? null, extras: sized?.extras ?? null, scope: ports.lifeKey?.() ?? null },
      { n: live.n, wait: live.wait, reason: String(shown?.reason ?? '').replace(/。$/, '') + (live.outcome ? '・結果 ' + live.outcome.status + '/' + live.outcome.code : '') + (stepMs >= 60000 ? '・同じ1歩が ' + Math.round(stepMs / 1000) + ' 秒' : '') })
    return owned
  }
  function mineKeep (inventory) {
    if (!ports.active() || !receivedInventory(inventory)) return null
    let record = stepRecord
    if (!record) { try { record = state.peek ? state.peek() : state.snapshot() } catch { return null } }
    const branch = record?.early?.mine?.branch, request = branch?.request
    if (record?.stage !== 'early' || !request || branch.retiring ||
      !sameWorld(branch.plan?.scope, mineWorldScope(runtime.mineState?.() ?? raw()))) return null
    const needOre = held(inventory, request.resource) < request.targetHeld
    const producingReserve = request.requester === 'home_reserve' && record.early.reserveReady !== true
    if (!needOre && !branch.segmentTask && !branch.vein && !producingReserve) return null
    const layer = branch.segmentTask?.layer ?? branch.vein?.layer ?? request.layer
    const supplies = constructionSupplies(branch.plan, layer, {
      inventory, getBlock: p => getBlock(p.x, p.y, p.z), refillCobblestone: branch.refillCobblestone === true, built: builtWork(branch)
    })
    return { ...supplies, [request.resource]: request.targetHeld }
  }
  // The early objective as it reads now, for whoever names the owner in the log; null outside the early stage.
  const objective = () => { const record = keyNow()?.record; return record?.stage === 'early' ? objectiveNow({ runtime, shared, memory: record, getFeet: ports.getFeet }) : null }
  const inMine = () => {
    let record = stepRecord
    if (!record) { try { record = state.peek ? state.peek() : null } catch { record = null } }
    return Boolean(record && inOwnMine({ runtime, getFeet: ports.getFeet ?? (() => raw()?.position), record }))
  }
  return { ...expedition, tick, record: state.record, goal, mineKeep, objective, inMine }
}
module.exports = { createDragonRuntime }
