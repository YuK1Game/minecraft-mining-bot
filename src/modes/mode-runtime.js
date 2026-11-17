'use strict'

// Wires the modes into the runtime's operations: adds operations.mode and makes
// a quarry start or resume refuse while player mode is selected. `runtime` holds
// functions that read the runtime's current bindings (host, autonomy, holds).
const path = require('node:path')
const { isMode, startRefusal } = require('./bot-mode')
const { modeFile, loadModeSync, saveMode } = require('./mode-store')
const { createModeControl } = require('./mode-control')
const { createPlayerMode, OBJECTIVE } = require('./player-mode')
const { createPlayerRecovery } = require('./player-recovery')
const { createPlayerShelter } = require('./player-shelter')
const { createPlayerFlee } = require('./player-flee')
const { knownUnreachable, knownReachable } = require('../combat/threat-reachability')
const { createPlayerCover } = require('./player-cover')
const { walkableCells } = require('./player-drops')
const { createCombatExposure } = require('../combat/combat-exposure')
const { createPlayerScaffold } = require('./player-scaffold')
const { createScaffoldPorts } = require('./player-scaffold-ports')
const { climbOut } = require('./player-climb')
const { sidestep } = require('./player-climb-side')
const { walkOut, recordedFloors } = require('./player-tunnel-exit')
const { underCover } = require('./player-surface')
const { boxedIn, stepOut } = require('./player-pit')
const { settle, offCentre } = require('./player-settle')
const { createPlayerTorch } = require('./player-torch')
const { createTorchPorts } = require('./player-torch-ports')
const { createPlayerStorage } = require('./player-storage')
const { createStoragePorts } = require('./player-storage-ports')
const { nextObjective } = require('./player-goal')
const { pruneTunnelFloors } = require('./player-floor-prune')
const { playFile, createPlayerResume } = require('./player-resume')
const { createPlayerBase, baseFile, loadBaseSync } = require('./player-base')
const { createHouseWool } = require('./house/house-wool')
const { createHouseSand } = require('./house/house-sand')
const { createPlayerFood, hasFood } = require('./player-food')
const { createPlayerWater } = require('./player-water')
const { createHouseBuild, houseFile, loadHouseSync } = require('./house/house-build')
const { createHousePorts } = require('./house/house-ports')
const { chestOf, bedOf, setSpawn } = require('./house/house-spawn')
const { writeDurableJson } = require('../common/durable-json')

function attachModeOperations (operations, runtime, { root = path.resolve(__dirname, '..', '..') } = {}) {
  const shared = runtime.host().shared, file = modeFile(root), log = text => runtime.host().log(text)
  // First runtime of this process: `npm run auto` means player mode, otherwise the saved choice.
  if (!isMode(shared.botMode)) shared.botMode = shared.autoWanted === true ? 'player' : loadModeSync(file)
  const resume = createPlayerResume({ file: playFile(root), shared, getMode: () => shared.botMode, log })
  resume.restore()
  const quarry = operations.quarry
  // The modes start and stop the autonomy through these. Anyone else (the /stop
  // and /agent commands, the local API) goes through operations.agent, where a
  // stop also means "the player stops playing".
  const inner = operations.agent, agent = { start: options => { if (flee.status().active) throw Error('敵から離れている間は始めません。'); return inner.start(aimed(options)) }, stop: reason => inner.stop(reason) }
  // In player mode every start plays for the next goal (player-goal.js).
  let aim = null
  const aimed = options => {
    if (control.get() !== 'player') return options
    const next = nextObjective(options, shared.inventoryUncertain ? null : runtime.raw().inventory)
    if (next?.diamondCount > 1 && next.diamondCount !== aim) log(`プレイヤーモード: 次の目標はダイヤモンド ${next.diamondCount} 個です`)
    aim = next?.diamondCount ?? aim
    return next
  }
  operations.agent = { ...inner, start: options => { if (control.get() === 'player') shared.playerWanted = true; return inner.start(aimed(options)) }, stop: reason => { shared.playerWanted = false; recovery.cancel(); return inner.stop(reason) } }
  const agentStatus = () => runtime.autonomy()?.snapshot() ?? { running: false }
  const disposed = () => runtime.disposed?.() === true
  const idle = () => { const value = agentStatus(); return value.running !== true && value.busy !== true && value.actionActive !== true }
  const control = createModeControl({
    shared, save: mode => saveMode(file, mode), log,
    getQuarryStatus: () => quarry.status(), getAgentStatus: () => recovery.status().active || shelter.status().active || flee.status().active || cover.status().active || scaffold.status().active || torch.status().active || storage.status().active || base.status().active || wool.status().active || sand.status().active || food.status().active || water.status().active || house.status().active ? { running: true } : agentStatus(),
    isBusy: () => runtime.chunkMoveHeld() || runtime.manualChestStorage()?.isBusy() === true || runtime.resetHeld()
  })
  // Where the Bot is: the working position. The last received position can be
  // minutes old on this Realm (live 2026-11-15 21:24-21:42 JST: every walk
  // looked like "got nowhere", so the search turned 60 degrees each time and
  // circled a hexagon around the stale point).
  // A hostile near enough to stop a side job (storage, food, house...): within
  // 12 m, an archer within 24 m, or damage taken in the last 10 s (real Realm
  // 2026-11-17 09:52-09:53 JST: a skeleton 12.4 m away shot the Bot from 12.9
  // to 0; the storage and the food climb started anyway, the climb cancelled the
  // fight, and no hit landed).
  let healthSeen = null, hurtAt = 0
  const ARCHER = /skeleton|stray|bogged|pillager|witch/ // one that has not moved for 5 min is not counted
  const danger = () => {
    const health = runtime.raw()?.health
    if (Number.isFinite(health)) { if (Number.isFinite(healthSeen) && health < healthSeen) hurtAt = Date.now(); healthSeen = health }
    if (Date.now() - hurtAt < 10000 || runtime.nearestHostile() < 12) return true
    const at = where()
    return !!at && (runtime.hostiles() ?? []).some(actor => ARCHER.test(String(actor?.entityType ?? '')) && actor.position && !(Date.now() - Date.parse(actor.positionUpdatedAt ?? '') > 300000) && Math.hypot(actor.position.x - at.x, actor.position.y - at.y, actor.position.z - at.z) < 24)
  }
  const where = () => { const position = runtime.position?.(); return position && [position.x, position.y, position.z].every(Number.isFinite) ? position : runtime.raw().position ?? null }
  // Ordinary walking, mining, placement and the pillar step, shared by the scaffold and the climb out of a tunnel.
  const hands = createScaffoldPorts({
    operations, disposed, pillarStep: (step, settings) => runtime.pillarStep(step, settings),
    getBlock: (x, y, z) => runtime.host().world.getBlock(x, y, z), getInventory: () => shared.inventoryUncertain ? null : runtime.inventory(), getMotion: () => runtime.motion(),
    getFeet: () => { const position = where(); return position ? { x: position.x, y: position.y - 1.62, z: position.z } : null }
  })
  // Out of a tunnel to the open sky, shared by the recovery and the base trip.
  async function climbUp (aborted) {
    for (let i = 0; i < 50 && !aborted() && !idle(); i++) await new Promise(resolve => setTimeout(resolve, 200))
    const stop = () => aborted() || flee.status().active || shelter.status().active
    // First the tunnel it dug itself, on foot (player-tunnel-exit.js); what is left of the way is dug straight up.
    const sky = () => !underCover((x, y, z) => runtime.host().world.getBlock(x, y, z), where())
    const walked = await walkOut({ ports: hands, floors: recordedFloors(shared, runtime.raw()), log, aborted: stop, open: sky })
    if (walked.ok && sky()) return { ok: true, steps: 0, walked: walked.walked }
    if (stop()) return { ok: false, reason: 'INTERRUPTED' }
    // Under water, gravel or leaves the shaft moves sideways and goes on (player-climb-side.js).
    let out = await climbOut({ ports: hands, log, aborted: stop })
    for (let i = 0; i < 3 && !out.ok && (out.reason === 'CANNOT_MINE' || out.reason === 'LEAVES_ABOVE') && !stop(); i++) {
      if (!(await sidestep({ ports: hands, log, aborted: stop })).ok) break
      out = await climbOut({ ports: hands, log, aborted: stop })
    }
    return out
  }
  const recovery = createPlayerRecovery({
    getMode: control.get, shared, log, disposed, held: () => !!shared.travelNight?.cover,
    agent: { objective: OBJECTIVE, start: options => agent.start(options), stop: reason => agent.stop(reason) },
    travel: { to: input => quarry.travelTo(input), status: () => quarry.travelStatus(), cancel: () => quarry.cancelTravel() },
    getBlock: (x, y, z) => runtime.host().world.getBlock(x, y, z), getPosition: where,
    prey: () => operations.foraging?.snapshot()?.target?.position ?? null,
    water: {
      needed: () => water.needed(),
      exit: async aborted => { for (let i = 0; i < 50 && !aborted() && !idle(); i++) await new Promise(resolve => setTimeout(resolve, 200)); return water.exit(() => aborted() || flee.status().active || shelter.status().active) }
    },
    pit: {
      boxed: () => boxedIn((x, y, z) => runtime.host().world.getBlock(x, y, z), where()),
      out: async aborted => {
        for (let i = 0; i < 50 && !aborted() && !idle(); i++) await new Promise(resolve => setTimeout(resolve, 200))
        return stepOut({ ports: hands, getBlock: (x, y, z) => runtime.host().world.getBlock(x, y, z), log, aborted: () => aborted() || flee.status().active || shelter.status().active })
      }
    },
    settle: {
      needed: () => !!offCentre((x, y, z) => runtime.host().world.getBlock(x, y, z), hands.feet()),
      run: async aborted => {
        for (let i = 0; i < 50 && !aborted() && !idle(); i++) await new Promise(resolve => setTimeout(resolve, 200))
        return settle({ ports: hands, aborted: () => aborted() || flee.status().active || shelter.status().active })
      }
    },
    climb: aborted => climbUp(aborted)
  })
  // The runtime restarts a finished run from shared.autoOptions without passing
  // through the starts above (real Realm 2026-11-16 08:11-08:34 JST: with one
  // diamond held, 3,510 runs started and completed at once): the goal there is
  // kept current, with every progress snapshot and every two seconds.
  const keepAim = () => {
    const options = shared.autoOptions
    if (control.get() !== 'player' || options?.objective !== 'diamond') return
    const next = aimed(options).diamondCount
    if (Number.isSafeInteger(next) && next !== options.diamondCount) options.diamondCount = next
  }
  shared.onAutonomyProgress = snapshot => { keepAim(); return recovery.onProgress(snapshot) }
  const air = cell => { const block = runtime.host().world.getBlock(cell.x, cell.y, cell.z); return block?.known === true && /^minecraft:(?:air|cave_air)$/.test(block.name ?? '') }
  const hunger = () => { const value = shared.vitals?.hunger; return Number.isFinite(value) ? value : Number.isFinite(value?.value) ? value.value : null }
  const shelter = createPlayerShelter({
    getMode: control.get, shared, log, disposed, recovery,
    agent: { objective: OBJECTIVE, start: options => agent.start(options), stop: reason => agent.stop(reason), running: () => agentStatus().running === true, settled: () => { const value = agentStatus(); return value.running !== true && value.busy !== true && value.actionActive !== true } },
    getClock: () => runtime.travel().travelClock(), getVitals: () => ({ health: runtime.raw().health, hunger: hunger() }),
    hostileDistance: () => runtime.nearestHostile(), travelBusy: () => quarry.travelStatus().busy === true,
    dig: () => runtime.travel().travelNightPit(),
    // The cover is mined by the ordinary mining and counts once the received block is air.
    uncover: async cover => {
      if (air(cover)) return true
      operations.mining.start([cover])
      for (let i = 0; i < 175 && !air(cover) && !disposed(); i++) await new Promise(resolve => setTimeout(resolve, 200))
      return air(cover)
    }
  })
  const flee = createPlayerFlee({
    getMode: control.get, shared, log, disposed,
    agent: { stop: reason => agent.stop(reason), running: () => agentStatus().running === true },
    travel: { status: () => quarry.travelStatus(), cancel: () => quarry.cancelTravel() },
    getState: () => { const state = runtime.raw(); return { health: state.health, position: where(), inventory: shared.inventoryUncertain ? null : state.inventory, totem: () => runtime.totem() } },
    // A hostile with fresh evidence that it cannot walk to the Bot (shut in a
    // deep pit, no route) is not run from; creepers always are.
    hostiles: () => { const state = runtime.raw(); return (runtime.hostiles() ?? []).filter(actor => /creeper/.test(String(actor?.entityType ?? '')) || !knownUnreachable(state, actor)) },
    retreat: () => runtime.travel().retreatFromHostiles()
  })
  // Shot by an archer it cannot walk to: behind the nearest block (player-cover.js).
  const cover = createPlayerCover({
    getMode: control.get, shared, log, disposed,
    agent: { stop: reason => agent.stop(reason), running: () => agentStatus().running === true },
    getState: () => { const state = runtime.raw(); return { health: state.health, position: where(), inventory: shared.inventoryUncertain ? null : state.inventory } },
    hostiles: () => runtime.hostiles(), reachable: actor => knownReachable(runtime.raw(), actor),
    sight: (from, to) => createCombatExposure({ world: runtime.host().world, entities: {}, scopeOf: () => null }).sight(from, to),
    cells: position => walkableCells(position, (x, y, z) => runtime.host().world.getBlock(x, y, z)).values(),
    walk: target => hands.walk(target),
    blocked: () => shelter.status().active || flee.status().active || scaffold.status().active || quarry.travelStatus().busy === true
  })
  // Logs out of reach: a dirt pillar in the trunk's place, taken down again afterwards.
  const scaffold = createPlayerScaffold({
    getMode: control.get, shared, log, disposed,
    agent: { objective: OBJECTIVE, start: options => agent.start(options), stop: reason => agent.stop(reason), settled: () => { const value = agentStatus(); return value.running !== true && value.busy !== true && value.actionActive !== true } },
    blocked: () => recovery.status().active || shelter.status().active || flee.status().active || cover.status().active || house.status().active || quarry.travelStatus().busy === true,
    ports: hands
  })
  // Underground, a torch every eight blocks (player-torch.js).
  const feetNow = () => { const position = where(); return position ? { x: position.x, y: position.y - 1.62, z: position.z } : null }
  const torch = createPlayerTorch({
    getMode: control.get, shared, log, disposed, getFeet: feetNow,
    getBlock: (x, y, z) => runtime.host().world.getBlock(x, y, z), getInventory: () => shared.inventoryUncertain ? null : runtime.inventory(),
    agent: { objective: OBJECTIVE, start: options => agent.start(options), stop: reason => agent.stop(reason), running: () => agentStatus().running === true, settled: idle },
    blocked: () => recovery.status().active || shelter.status().active || flee.status().active || cover.status().active || scaffold.status().active || house.status().active || quarry.travelStatus().busy === true || danger(),
    hands: createTorchPorts({ operations, disposed, getBlock: (x, y, z) => runtime.host().world.getBlock(x, y, z), getInventory: () => shared.inventoryUncertain ? null : runtime.inventory() })
  })
  // A full inventory goes into a large chest beside the Bot (player-storage.js).
  const storagePorts = createStoragePorts({ operations, disposed, getFeet: feetNow, getBlock: (x, y, z) => runtime.host().world.getBlock(x, y, z), getInventory: () => shared.inventoryUncertain ? null : runtime.inventory() })
  const storage = createPlayerStorage({
    getMode: control.get, shared, log, disposed, getFeet: feetNow, mine: async cell => (await hands.pick()) && hands.mine(cell), dig: cell => hands.dig(cell), why: () => hands.why(), walk: target => hands.walk(target), cells: () => { const at = where(); return at ? walkableCells(at, (x, y, z) => runtime.host().world.getBlock(x, y, z)) : null },
    getBlock: (x, y, z) => runtime.host().world.getBlock(x, y, z), getInventory: () => shared.inventoryUncertain ? null : runtime.inventory(),
    agent: { objective: OBJECTIVE, start: options => agent.start(options), stop: reason => agent.stop(reason), settled: idle },
    blocked: () => recovery.status().active || shelter.status().active || flee.status().active || cover.status().active || scaffold.status().active || torch.status().active || base.status().active || wool.status().active || sand.status().active || food.status().active || water.status().active || house.status().active || quarry.travelStatus().busy === true || danger(),
    hands: storagePorts
  })
  // A base on the surface: spare diamonds and valuables go into its large chest (player-base.js).
  if (shared.playerBase === undefined) shared.playerBase = loadBaseSync(baseFile(root))
  const base = createPlayerBase({
    getMode: control.get, shared, log, disposed, getFeet: feetNow, getPosition: where, file: baseFile(root),
    getBlock: (x, y, z) => runtime.host().world.getBlock(x, y, z), getInventory: () => shared.inventoryUncertain ? null : runtime.inventory(),
    agent: { objective: OBJECTIVE, start: options => agent.start(options), stop: reason => agent.stop(reason), settled: idle },
    hands: storagePorts, chest: () => storage.chest(), canBuild: () => shared.playerHouse?.done === true && storage.woodFor(1), climb: climbUp, walk: target => hands.walk(target), approach: target => hands.approach(target),
    travel: { to: input => quarry.travelTo(input), status: () => quarry.travelStatus(), cancel: () => quarry.cancelTravel() },
    hostile: () => danger(),
    blocked: () => recovery.status().active || shelter.status().active || flee.status().active || cover.status().active || scaffold.status().active || torch.status().active || storage.status().active || wool.status().active || sand.status().active || food.status().active || water.status().active || house.status().active
  })
  const hungryWithoutFood = () => { const value = hunger(); return Number.isFinite(value) && value <= 14 && !shared.inventoryUncertain && !hasFood(runtime.inventory()) }
  // No food, hungry, deep underground: up to the surface where the animals are (player-food.js).
  const food = createPlayerFood({
    getMode: control.get, shared, log, disposed, getHunger: hunger, getState: () => ({ position: where(), inventory: shared.inventoryUncertain ? null : runtime.inventory() }), getBlock: (x, y, z) => runtime.host().world.getBlock(x, y, z),
    agent: { objective: OBJECTIVE, start: options => agent.start(options), stop: reason => agent.stop(reason) }, climb: climbUp,
    travel: { to: input => quarry.travelTo(input), status: () => quarry.travelStatus(), cancel: () => quarry.cancelTravel() }, prey: () => { const seen = operations.foraging?.snapshot(); return seen && seen.busy !== true && seen.phase !== 'moving' ? seen.target?.position ?? null : null },
    blocked: () => recovery.status().active || shelter.status().active || flee.status().active || cover.status().active || scaffold.status().active || torch.status().active || storage.status().active || base.status().active || wool.status().active || sand.status().active || food.status().active || water.status().active || house.status().active || quarry.travelStatus().busy === true || danger()
  })
  // Afloat and not moving: onto the nearest ledge with the water exit (player-water.js).
  const water = createPlayerWater({
    getMode: control.get, shared, log, disposed, getBlock: (x, y, z) => runtime.host().world.getBlock(x, y, z), getPosition: () => hands.feet(),
    agent: { objective: OBJECTIVE, start: options => agent.start(options), stop: reason => agent.stop(reason), settled: idle },
    start: (target, options) => operations.movement.start(target, options), moving: () => ['moving', 'settling'].includes(runtime.motion()?.phase),
    why: () => { const reason = runtime.motion()?.reason; return reason ? `${String(reason).slice(0, 80)}${/frame guard/.test(reason) && shared.waterGuardWhy ? ` [${shared.waterGuardWhy}]` : ''}` : null },
    blocked: () => recovery.status().active || shelter.status().active || flee.status().active || cover.status().active || scaffold.status().active || torch.status().active || storage.status().active || base.status().active || wool.status().active || sand.status().active || food.status().active || house.status().active || quarry.travelStatus().busy === true || danger()
  })
  // The starter house's wool from sheep (house/house-wool.js).
  const wool = createHouseWool({
    getMode: control.get, shared, log, disposed, getState: () => ({ ...runtime.raw(), position: where(), inventory: shared.inventoryUncertain ? null : runtime.inventory() }), getBlock: (x, y, z) => runtime.host().world.getBlock(x, y, z),
    actors: () => runtime.host().entities.snapshot({ kind: 'all' }), gather: input => quarry.prepGather(input),
    agent: { objective: OBJECTIVE, start: options => agent.start(options), stop: reason => agent.stop(reason), settled: idle },
    blocked: () => recovery.status().active || shelter.status().active || flee.status().active || cover.status().active || scaffold.status().active || torch.status().active || storage.status().active || base.status().active || house.status().active || sand.status().active || quarry.travelStatus().busy === true || danger()
  })
  // The starter house's sand for the glass: walk to received sand or search for it (house/house-sand.js).
  const sand = createHouseSand({
    getMode: control.get, shared, log, disposed, getState: () => ({ ...runtime.raw(), position: where(), inventory: shared.inventoryUncertain ? null : runtime.inventory() }), getBlock: (x, y, z) => runtime.host().world.getBlock(x, y, z),
    travel: { to: input => quarry.travelTo(input), status: () => quarry.travelStatus(), cancel: () => quarry.cancelTravel() }, climb: climbUp,
    agent: { objective: OBJECTIVE, start: options => agent.start(options), stop: reason => agent.stop(reason), settled: idle },
    blocked: () => !(runtime.raw().health > 10) || hungryWithoutFood() || recovery.status().active || shelter.status().active || flee.status().active || cover.status().active || scaffold.status().active || torch.status().active || storage.status().active || base.status().active || wool.status().active || house.status().active || quarry.travelStatus().busy === true || danger()
  })
  // The starter house from the user's blueprint, right after the wooden tools (house/house-build.js).
  if (shared.playerHouse === undefined) shared.playerHouse = loadHouseSync(houseFile(root))
  const house = createHouseBuild({
    getMode: control.get, shared, log, disposed, getFeet: feetNow, getPosition: where, file: houseFile(root), write: writeDurableJson,
    getBlock: (x, y, z) => runtime.host().world.getBlock(x, y, z), getInventory: () => shared.inventoryUncertain ? null : runtime.inventory(),
    agent: { objective: OBJECTIVE, start: options => agent.start(options), stop: reason => agent.stop(reason), settled: idle },
    ports: createHousePorts({ operations, disposed, getBlock: (x, y, z) => runtime.host().world.getBlock(x, y, z), getInventory: () => shared.inventoryUncertain ? null : runtime.inventory() }),
    hands, climb: climbUp,
    travel: { to: input => quarry.travelTo(input), status: () => quarry.travelStatus(), cancel: () => quarry.cancelTravel() },
    hostile: () => danger(),
    // Not with 10 health or less: eating, the shelter and fleeing come first (live 2026-11-17 05:53 JST: the build began at 1.9 health with no food).
    // Nor hungry with no food: the forage comes first (live 2026-11-17 08:26-08:29 JST: hunger 12, the build stopped the forage for a cow).
    blocked: () => !(runtime.raw().health > 10) || hungryWithoutFood() || recovery.status().active || shelter.status().active || flee.status().active || cover.status().active || scaffold.status().active || torch.status().active || storage.status().active || base.status().active || wool.status().active || sand.status().active || food.status().active,
    // Done: chest A is the base, and the bed sets the respawn point.
    onDone: async origin => {
      const at = chestOf(origin), here = (x, y, z) => runtime.host().world.getBlock(x, y, z)
      if (/chest$/.test(here(at.x, at.y, at.z)?.name ?? '') && !(shared.playerBase && shared.playerBase.x === at.x && shared.playerBase.y === at.y && shared.playerBase.z === at.z)) {
        shared.playerBase = at
        try { await writeDurableJson(baseFile(root), { version: 1, chest: at, savedAt: new Date().toISOString() }) } catch { /* Kept in shared. */ }
        log(`プレイヤーモード: 拠点を家のラージチェスト (${at.x}, ${at.y}, ${at.z}) にしました`)
      }
      const bed = bedOf(origin)
      if (bed && /bed$/.test(here(bed.x, bed.y, bed.z)?.name ?? '') && shared.playerHouse?.spawn !== true) {
        if (await setSpawn({ origin, shared, useBed: target => operations.interactions.useBed(target), wakeBed: target => operations.interactions.wakeBed(target), walk: target => hands.walk(target), getFeet: feetNow, log })) shared.playerHouse = { ...shared.playerHouse, spawn: true }
      }
    }
  })
  const fleeTimer = setInterval(require('../common/work-spans').wrap('player-flee.tick', () => { if (disposed()) clearInterval(fleeTimer); else { void flee.tick().catch(() => {}); void cover.tick().catch(() => {}) } }), 500)
  fleeTimer.unref?.()
  // The shelter is checked every two seconds; a reloaded runtime's timer ends itself.
  const timer = setInterval(require('../common/work-spans').wrap('player-mode.tick', () => {
    if (disposed()) return clearInterval(timer)
    void resume.note()
    try { const gone = control.get() === 'player' ? pruneTunnelFloors(shared, runtime.raw(), where()) : 0; if (gone) log(`プレイヤーモード: 帰路の床の記録が多いため、遠いものから ${gone} 個を外しました`) } catch { /* The next tick retries. */ }
    keepAim()
    void shelter.tick()
    void scaffold.tick().catch(() => {})
    void torch.tick().catch(() => {})
    void storage.tick().catch(() => {})
    void base.tick().catch(() => {})
    void wool.tick().catch(() => {})
    void sand.tick().catch(() => {})
    void food.tick().catch(() => {})
    void water.tick().catch(() => {})
    void house.tick().catch(() => {})
    try { recovery.keepPlaying({ running: agentStatus().running === true, resting: shelter.status().active || flee.status().active || cover.status().active || scaffold.status().active || torch.status().active || storage.status().active || base.status().active || wool.status().active || sand.status().active || food.status().active || water.status().active || house.status().active }) } catch { /* The next tick retries. */ }
  }), 2000)
  timer.unref?.()
  // The previous runtime was reloaded in the middle of a recovery: play on.
  if (shared.playerRecovering === true) { shared.playerRecovering = false; if (control.get() === 'player') shared.autoWanted = true }
  const player = createPlayerMode({
    getMode: control.get, log, safety: operations.safety, recovery, shelter, flee, scaffold: { status: () => house.status().active ? house.status() : wool.status().active ? wool.status() : sand.status().active ? sand.status() : food.status().active ? food.status() : base.status().active ? base.status() : storage.status().active ? storage.status() : torch.status().active ? torch.status() : scaffold.status() }, shared,
    agent: { start: options => agent.start(options), stop: reason => agent.stop(reason), snapshot: agentStatus },
    getInventory: () => shared.inventoryUncertain ? null : runtime.raw().inventory,
    getWorn: () => operations.diagnostics?.armor?.() ?? null
  })
  for (const name of ['start', 'resume']) {
    const inner = quarry[name]
    quarry[name] = (...args) => {
      const refused = startRefusal(control.get(), 'quarry')
      if (refused) throw Object.assign(new Error(refused.message), { code: refused.code })
      return inner(...args)
    }
  }
  operations.mode = {
    get: control.get,
    set: mode => control.set(mode),
    status: () => ({ mode: control.get(), player: player.status() }),
    startPlayer: () => player.start(),
    stopPlayer: reason => player.stop(reason)
  }
  return operations.mode
}

module.exports = { attachModeOperations }
