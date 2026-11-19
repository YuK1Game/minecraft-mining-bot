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
const { fleeThreats } = require('./player-flee-threats')
const { knownUnreachable, knownReachable } = require('../combat/threat-reachability')
const { createPlayerCover } = require('./player-cover')
const { walkableCells } = require('./player-drops')
const { createCombatExposure } = require('../combat/combat-exposure')
const { createPlayerScaffold } = require('./player-scaffold')
const { createScaffoldPorts } = require('./player-scaffold-ports')
const { riseToSky } = require('./player-rise')
const { recordedFloors } = require('./player-tunnel-exit')
const { underCover } = require('./player-surface')
const { boxedIn, stepOut } = require('./player-pit')
const { settle, offCentre, offGrid } = require('./player-settle')
const { openDoor } = require('./house/house-door')
const { leaveHouse } = require('./house/house-exit')
const { createBuildWalk } = require('./player-build-walk')
const { createPlayerTorch } = require('./player-torch')
const { createTorchPorts } = require('./player-torch-ports')
const { createPlayerStorage } = require('./player-storage')
const { createStoragePorts } = require('./player-storage-ports')
const { stationWorldScope } = require('../survival/supply-return')
const { nextObjective } = require('./player-goal')
const { guardDragonOperations } = require('./dragon-ports')
const { createDragonRuntime } = require('./dragon-runtime')
const { expeditionTrip } = require('./dragon-trip')
const { pruneTunnelFloors } = require('./player-floor-prune')
const { noteDamage } = require('./damage-note')
const { createGroundRefresh } = require('../movement/ground-refresh')
const { playFile, createPlayerResume } = require('./player-resume')
const { createPlayerBase, baseFile, loadBaseSync } = require('./player-base')
const { returnFile, loadReturnSync } = require('./return/return-goal')
const { inside: insideHouse } = require('./house/house-exit')
const { createHouseWool } = require('./house/house-wool')
const { createHouseSand } = require('./house/house-sand')
const { createPlayerFood, hasFood } = require('./player-food')
const { createPlayerWater } = require('./player-water')
const { dryStart } = require('./travel-dry-start')
const { departPlayer } = require('./player-departure')
const { createIslandStart } = require('./island-start')
const { createHouseBuild, houseFile, loadHouseSync } = require('./house/house-build')
const { createHousePorts } = require('./house/house-ports')
const { chestOf, bedOf, setSpawn } = require('./house/house-spawn')
const { writeDurableJson } = require('../common/durable-json')

function attachModeOperations (operations, runtime, { root = path.resolve(__dirname, '..', '..') } = {}) {
  const shared = runtime.host().shared, file = modeFile(root), log = text => runtime.host().log(text)
  // First runtime of this process: `npm run auto` means player mode, otherwise the saved choice.
  if (!isMode(shared.botMode)) shared.botMode = shared.autoWanted === true ? 'player' : loadModeSync(file)
  // Raw meat on its way to the furnace is not eaten by any meal path (raw-meat-keep.js).
  require('./raw-meat-keep').wire(() => runtime.food?.(), () => shared)
  const resume = createPlayerResume({ file: playFile(root), shared, getMode: () => shared.botMode, log })
  resume.restore()
  const quarry = operations.quarry
  // The modes start and stop the autonomy through these. Anyone else (the /stop
  // and /agent commands, the local API) goes through operations.agent, where a
  // stop also means "the player stops playing".
  let expedition
  const inner = operations.agent, agent = { start: options => { if (expedition?.owns()) { expedition.tick(); return agentStatus() } if (flee.status().active) throw Error('敵から離れている間は始めません。'); return inner.start(aimed(options)) }, stop: reason => inner.stop(reason) }
  // In player mode every start plays for the next goal (player-goal.js).
  let aim = null
  const aimed = options => {
    if (control.get() !== 'player') return options
    const next = nextObjective(options, shared.inventoryUncertain ? null : runtime.raw().inventory)
    if (next?.diamondCount > 1 && next.diamondCount !== aim) log(`プレイヤーモード: 次の目標はダイヤモンド ${next.diamondCount} 個です`)
    aim = next?.diamondCount ?? aim
    return next
  }
  operations.agent = { ...inner, start: options => { if (control.get() === 'player') shared.playerWanted = true; return agent.start(options) }, stop: reason => { shared.playerWanted = false; cancelExpedition(); recovery.cancel(); base.cancel('MANUAL_STOP'); return inner.stop(reason) } }
  const agentStatus = () => runtime.autonomy()?.snapshot() ?? { running: false }
  const disposed = () => runtime.disposed?.() === true
  const idle = () => { const value = agentStatus(); return value.running !== true && value.busy !== true && value.actionActive !== true }
  const control = createModeControl({
    shared, save: mode => saveMode(file, mode), log,
    getQuarryStatus: () => quarry.status(), getAgentStatus: () => expedition?.busy() || expedition?.owns() || recovery.status().active || shelter.status().active || flee.status().active || cover.status().active || scaffold.status().active || torch.status().active || storage.status().active || base.status().active || wool.status().active || sand.status().active || food.status().active || water.status().active || house.status().active ? { running: true } : agentStatus(),
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
  // An archer whose position has not changed for a minute is not aiming (a skeleton that aims turns, and every turn is a move update): live 2026-11-17 10:46-10:59 JST, a cave skeleton 15 blocks below with no update for 4+ minutes held the house's sand search the whole time.
  const danger = () => {
    const health = runtime.raw()?.health
    if (Number.isFinite(health)) { if (Number.isFinite(healthSeen) && health < healthSeen) hurtAt = Date.now(); healthSeen = health }
    if (Date.now() - hurtAt < 10000) return true
    const at = where()
    if (!at) return runtime.nearestHostile() < 12
    const state = runtime.raw(), near = actor => actor?.position && Math.hypot(actor.position.x - at.x, actor.position.y - at.y, actor.position.z - at.z)
    // A walker the reachability check found no route from does not count (creepers always do): live 2026-11-17 11:15 JST, zombies 10-12 m away in the cave above held the base trip.
    return (runtime.hostiles() ?? []).some(actor => (near(actor) < 12 && (/creeper/.test(String(actor?.entityType ?? '')) || !knownUnreachable(state, actor))) || (ARCHER.test(String(actor?.entityType ?? '')) && actor.position && !(Date.now() - Date.parse(actor.positionUpdatedAt ?? '') > 60000) && near(actor) < 24))
  }
  const where = () => { const position = runtime.position?.(); return position && [position.x, position.y, position.z].every(Number.isFinite) ? position : runtime.raw().position ?? null }
  // Ordinary walking, mining, placement and the pillar step, shared by the scaffold and the climb out of a tunnel.
  const buildHands = (done, actions = operations) => createScaffoldPorts({
    operations: actions, disposed: done, pillarStep: (step, settings) => runtime.pillarStep(step, settings),
    getBlock: (x, y, z) => runtime.host().world.getBlock(x, y, z), getInventory: () => shared.inventoryUncertain ? null : runtime.inventory(), getMotion: () => runtime.motion(),
    getFeet: () => { const position = where(); return position ? { x: position.x, y: position.y - 1.62, z: position.z } : null }
  })
  const hands = buildHands(disposed)
  const houseWayOut = (target, done) => createBuildWalk({ hands, getHouse: () => shared.playerHouse, log })(target, { done, aborted: () => disposed() })
  const leaveIsland = createIslandStart({ getFeet: () => { const position = where(); return position ? { x: position.x, y: position.y - 1.62, z: position.z } : null }, walkable: feet => walkableCells({ x: feet.x, y: feet.y + 1.62, z: feet.z }, (x, y, z) => runtime.host().world.getBlock(x, y, z)), openSky: () => !underCover((x, y, z) => runtime.host().world.getBlock(x, y, z), where()), skyAt: cell => !insideHouse(shared.playerHouse?.origin, cell) && !underCover((x, y, z) => runtime.host().world.getBlock(x, y, z), { x: cell.x + 0.5, y: cell.y + 1.62, z: cell.z + 0.5 }), build: (target, done) => houseWayOut(target, done), log })
  // A long trip from inside the starter house first walks out through its door (house/house-exit.js).
  // Still in the water after the exit: the land trip is not started (it only fails leg after leg from there).
  const travelTo = (input, { aborted: cancelled = () => false } = {}) => {
    const aborted = () => cancelled() || disposed() || shared.botMode !== 'player' || shared.playerWanted !== true
    const check = () => { if (aborted()) throw Object.assign(new Error('長距離移動を中断しました。'), { code: 'LONG_TRAVEL_CANCELLED' }) }
    return departPlayer({
      input, aborted, canPack: () => runtime.raw().health > 10 && !danger() && !hungryWithoutFood() && !flee.status().active && !shelter.status().active && !water.needed(),
      pack: () => operations.playerWorkstations?.recoverNearby(),
      leave: () => leaveHouse({ house: shared.playerHouse, getFeet: feetNow, getBlock: (x, y, z) => runtime.host().world.getBlock(x, y, z), walk: target => { check(); return hands.walk(target) }, door: () => { check(); return houseDoor() }, why: () => hands.why(), build: houseWayOut, log }),
      dry: () => dryStart({ needed: () => water.needed(), exit: () => { check(); return water.exit(() => aborted() || flee.status().active || shelter.status().active) }, ready: () => aborted() || idle(), log }),
      waterNeeded: () => water.needed(), travel: (value, options) => quarry.travelTo(value, options),
      ground: () => { check(); return leaveIsland(input?.destination ?? input ?? null) }
    })
  }
  // Out of a tunnel to the open sky, shared by the recovery and the base trip.
  async function climbUp (aborted) {
    for (let i = 0; i < 50 && !aborted() && !idle(); i++) await new Promise(resolve => setTimeout(resolve, 200))
    const stop = () => aborted() || flee.status().active || shelter.status().active
    // The tunnel it dug itself on foot, a walk to the open sky, or straight up (player-rise.js).
    return riseToSky({ ports: hands, floors: recordedFloors(shared, runtime.raw()), log, aborted: stop, sky: () => !underCover((x, y, z) => runtime.host().world.getBlock(x, y, z), where()) })
  }
  // A finished house that lost blocks is built again (house/house-damage.js).
  const houseDamage = require('./house/house-damage').createHouseDamage({ shared, getBlock: (x, y, z) => runtime.host().world.getBlock(x, y, z), getFeet: () => feetNow(), log })
  // The long trip's own way on when no walk leads on (travel/travel-detour.js): lent only while the play mode plays.
  const tripDetour = require('../travel/travel-detour').createTravelDetour({ getFeet: () => feetNow(), getBlock: (x, y, z) => runtime.host().world.getBlock(x, y, z), covered: () => underCover((x, y, z) => runtime.host().world.getBlock(x, y, z), where()), climb: aborted => climbUp(aborted), wet: () => water.needed(), dry: aborted => water.exit(aborted), build: (target, options) => createBuildWalk({ hands, getHouse: () => shared.playerHouse, log })(target, options), log })
  shared.travelDetour = (destination, { signal } = {}) => disposed() || control.get() !== 'player' || shared.playerWanted !== true ? null : tripDetour(destination, { aborted: () => signal?.aborted === true || disposed() || shared.playerWanted !== true })
  // One memory of failed climbs for every expedition step (dragon-rise.js).
  const tripRise = require('./dragon-rise').createTripRise({ covered: () => underCover((x, y, z) => runtime.host().world.getBlock(x, y, z), where()), getFeet: () => feetNow(), log })
  const recovery = createPlayerRecovery({
    getMode: control.get, shared, log, disposed, held: () => !!shared.travelNight?.cover,
    agent: { objective: OBJECTIVE, start: options => agent.start(options), stop: reason => agent.stop(reason), running: () => agentStatus().running === true },
    travel: { to: travelTo, status: () => quarry.travelStatus(), cancel: () => quarry.cancelTravel() },
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
      needed: () => !!offCentre((x, y, z) => runtime.host().world.getBlock(x, y, z), hands.feet()) || offGrid(hands.feet()),
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
  shared.onAutonomyProgress = snapshot => { if (expedition?.owns()) return; keepAim(); return recovery.onProgress(snapshot) }
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
    getState: () => { const state = runtime.raw(); return { health: state.health, position: where(), inventory: shared.inventoryUncertain ? null : state.inventory, totem: () => runtime.totem(), healing: require('./flee-healing').healing({ hunger: hunger(), inventory: shared.inventoryUncertain ? null : runtime.inventory(), hasFood }) } },
    // A hostile with fresh evidence that it cannot walk to the Bot (shut in a
    // deep pit, no route) is not run from; creepers always are.
    // Nor is a shooter or a flyer behind received blocks (player-flee-threats.js).
    hostiles: () => { const state = runtime.raw(), at = where(), seen = createCombatExposure({ world: runtime.host().world, entities: {}, scopeOf: () => null, solidCover: true }); return fleeThreats({ hostiles: runtime.hostiles(), unreachable: actor => knownUnreachable(state, actor), sight: actor => at && actor?.position ? seen.evaluate(actor, { position: at }).evidence.sight : null }) },
    retreat: () => runtime.travel().retreatFromHostiles()
  })
  // Shot by an archer it cannot walk to: behind the nearest block (player-cover.js), under the expedition too (cover-ports.js).
  const coverHold = require('./cover-ports').createCoverPorts({ expedition: { owns: () => expedition?.owns() === true, busy: () => expedition?.busy() === true }, cancelExpedition: () => cancelExpedition(), agent, agentRunning: () => agentStatus().running === true, travelStatus: () => quarry.travelStatus(), walk: target => hands.walk(target), reachable: actor => knownReachable(runtime.raw(), actor), combatOwns: () => runtime.combatOwns?.() === true })
  const cover = createPlayerCover({
    getMode: control.get, shared, log, disposed,
    agent: coverHold.agent,
    getState: () => { const state = runtime.raw(); return { health: state.health, position: where(), inventory: shared.inventoryUncertain ? null : state.inventory } },
    hostiles: () => runtime.hostiles(), reachable: coverHold.reachable,
    sight: (from, to) => createCombatExposure({ world: runtime.host().world, entities: {}, scopeOf: () => null }).sight(from, to),
    cells: position => walkableCells(position, (x, y, z) => runtime.host().world.getBlock(x, y, z)).values(),
    walk: coverHold.walk,
    blocked: () => shelter.status().active || flee.status().active || scaffold.status().active || coverHold.tripBlocks()
  })
  // Logs out of reach: a dirt pillar in the trunk's place, taken down again afterwards.
  const scaffold = createPlayerScaffold({
    getMode: control.get, shared, log, disposed,
    agent: { objective: OBJECTIVE, start: options => agent.start(options), stop: reason => agent.stop(reason), settled: () => { const value = agentStatus(); return value.running !== true && value.busy !== true && value.actionActive !== true } },
    blocked: () => recovery.status().active || shelter.status().active || flee.status().active || cover.status().active || house.status().active || quarry.travelStatus().busy === true,
    ports: hands
  })
  // Underground, a torch every eight blocks (player-torch.js).
  // The finished house's door, opened by an ordinary click before going in (house/house-door.js).
  const houseDoor = () => shared.playerHouse?.origin ? openDoor({ origin: shared.playerHouse.origin, getBlock: (x, y, z) => runtime.host().world.getBlock(x, y, z), useDoor: target => operations.interactions.useDoor(target), walk: target => hands.walk(target), getFeet: feetNow, log }) : Promise.resolve(true)
  const feetNow = () => { const position = where(); return position ? { x: position.x, y: position.y - 1.62, z: position.z } : null }
  const torch = createPlayerTorch({
    getMode: control.get, shared, log, disposed, getFeet: feetNow,
    getBlock: (x, y, z) => runtime.host().world.getBlock(x, y, z), getInventory: () => shared.inventoryUncertain ? null : runtime.inventory(),
    agent: { objective: OBJECTIVE, start: options => agent.start(options), stop: reason => agent.stop(reason), running: () => agentStatus().running === true, settled: idle },
    blocked: () => recovery.status().active || shelter.status().active || flee.status().active || cover.status().active || scaffold.status().active || house.status().active || quarry.travelStatus().busy === true || danger(),
    hands: createTorchPorts({ operations, disposed, getBlock: (x, y, z) => runtime.host().world.getBlock(x, y, z), getInventory: () => shared.inventoryUncertain ? null : runtime.inventory() })
  })
  // A full inventory goes into a large chest beside the Bot (player-storage.js).
  const storagePorts = createStoragePorts({ operations, disposed, held: () => runtime.combatOwns?.() === true, getFeet: feetNow, getBlock: (x, y, z) => runtime.host().world.getBlock(x, y, z), getInventory: () => shared.inventoryUncertain ? null : runtime.inventory(), memory: shared.playerChestMemory ??= { seen: new Map() } })
  const storage = createPlayerStorage({
    file: path.join(root, '.local', 'player-chest-pairs.json'), write: writeDurableJson, worldScope: () => stationWorldScope(runtime.raw()),
    getMode: control.get, shared, log, disposed, getFeet: feetNow, mine: async cell => (await hands.pick()) && hands.mine(cell), dig: cell => hands.dig(cell), why: () => hands.why(), walk: target => hands.walk(target), cells: () => { const at = where(); return at ? walkableCells(at, (x, y, z) => runtime.host().world.getBlock(x, y, z)) : null },
    getBlock: (x, y, z) => runtime.host().world.getBlock(x, y, z), getInventory: () => shared.inventoryUncertain ? null : runtime.inventory(),
    agent: { objective: OBJECTIVE, start: options => agent.start(options), stop: reason => agent.stop(reason), settled: idle },
    blocked: () => recovery.status().active || shelter.status().active || flee.status().active || cover.status().active || scaffold.status().active || torch.status().active || base.status().active || wool.status().active || sand.status().active || food.status().active || water.status().active || house.status().active || quarry.travelStatus().busy === true || danger(),
    hands: storagePorts
  })
  // A base on the surface: spare diamonds and valuables go into its large chest (player-base.js).
  if (shared.playerBase === undefined) shared.playerBase = loadBaseSync(baseFile(root))
  // The return goal and its failure memory outlive a restart (return/return-goal.js).
  if (shared.playerReturn === undefined) { const saved = loadReturnSync(returnFile(root)); shared.playerReturn = saved.goal; shared.playerReturnFailures = saved.failures }
  const jobs = () => recovery.status().active || shelter.status().active || flee.status().active || cover.status().active || scaffold.status().active || torch.status().active || storage.status().active || wool.status().active || sand.status().active || food.status().active || water.status().active || house.status().active
  // Who holds the controls ahead of the return: a fight, a meal, or one of the jobs above.
  const eating = () => { try { return operations.food?.snapshot?.()?.busy === true } catch { return false } }
  const ahead = () => flee.status().active ? '敵から離れる' : cover.status().active ? '射線から外れる' : shelter.status().active ? '避難' : runtime.combatOwns?.() === true ? '戦闘' : eating() ? '食事' : jobs() ? 'ほかの作業' : null
  const base = createPlayerBase({
    getMode: control.get, shared, log, disposed, getFeet: feetNow, getPosition: where, file: baseFile(root), returnFile: returnFile(root), getWorn: () => { try { return runtime.armor?.() ?? null } catch { return null } },
    getBlock: (x, y, z) => runtime.host().world.getBlock(x, y, z), getInventory: () => shared.inventoryUncertain ? null : runtime.inventory(),
    agent: { objective: OBJECTIVE, start: options => agent.start(options), stop: reason => agent.stop(reason), settled: idle, running: () => agentStatus().running === true || shared.autoWanted === true },
    hands: storagePorts, pendingChest: at => storage.pendingChest(at), chest: options => storage.chest(options), porch: () => { const o = shared.playerHouse?.origin; return o ? { stand: { x: o.x + 3, y: o.y, z: o.z + 10 }, avoid: [8, 9].flatMap(dz => [0, 1, 2].map(dy => ({ x: o.x + 3, y: o.y + dy, z: o.z + dz }))) } : null }, canBuild: () => shared.playerHouse?.done === true && storage.canMakeChest(), climb: climbUp, door: () => houseDoor(), porchWalk: () => shared.playerHouse?.origin ? house.closeIn(shared.playerHouse.origin) : false, spares: () => { const o = shared.playerHouse?.origin; return o ? [{ x: o.x + 5, y: o.y + 1, z: o.z + 3 }] : [] }, walk: target => hands.walk(target), approach: (target, within) => hands.approach(target, within), build: require('./player-build-walk').createBuildWalk({ hands, getHouse: () => shared.playerHouse, log }),
    // The return checks each precondition itself: out of the water, out of the house, then the raw long travel.
    travel: { to: (input, options) => quarry.travelTo(input, options), status: () => quarry.travelStatus(), cancel: () => quarry.cancelTravel() },
    water: { needed: () => water.needed(), exit: aborted => water.exit(aborted) },
    house: { inside: () => insideHouse(shared.playerHouse?.origin, feetNow()), leave: () => leaveHouse({ house: shared.playerHouse, getFeet: feetNow, getBlock: (x, y, z) => runtime.host().world.getBlock(x, y, z), walk: target => hands.walk(target), door: () => houseDoor(), why: () => hands.why(), build: houseWayOut, log }) },
    scope: () => { try { return runtime.scope?.() ?? null } catch { return null } }, dimension: () => { try { return runtime.raw()?.dimension ?? null } catch { return null } }, interrupter: ahead,
    hostile: () => danger()
  })
  const hungryWithoutFood = () => { const value = hunger(); return Number.isFinite(value) && value <= 14 && !shared.inventoryUncertain && !hasFood(runtime.inventory()) }
  // No food, hungry, deep underground: up to the surface where the animals are (player-food.js).
  const food = createPlayerFood({
    getMode: control.get, shared, log, disposed, getHunger: hunger, getState: () => ({ health: runtime.raw()?.health, position: where(), inventory: shared.inventoryUncertain ? null : runtime.inventory() }), getBlock: (x, y, z) => runtime.host().world.getBlock(x, y, z),
    agent: { objective: OBJECTIVE, start: options => agent.start(options), stop: reason => agent.stop(reason) }, climb: climbUp,
    travel: { to: travelTo, status: () => quarry.travelStatus(), cancel: () => quarry.cancelTravel() }, prey: () => { const seen = operations.foraging?.snapshot(); return seen && seen.busy !== true && seen.phase !== 'moving' ? seen.target?.position ?? null : null },
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
    travel: { to: travelTo, status: () => quarry.travelStatus(), cancel: () => quarry.cancelTravel() }, climb: climbUp, approach: (target, within) => hands.approach(target, within),
    agent: { objective: OBJECTIVE, start: options => agent.start(options), stop: reason => agent.stop(reason), settled: idle },
    blocked: () => !(runtime.raw().health > 10) || hungryWithoutFood() || recovery.status().active || shelter.status().active || flee.status().active || cover.status().active || scaffold.status().active || torch.status().active || storage.status().active || base.status().active || wool.status().active || house.status().active || quarry.travelStatus().busy === true || danger()
  })
  // The starter house from the user's blueprint, right after the wooden tools (house/house-build.js).
  if (shared.playerHouse === undefined) shared.playerHouse = loadHouseSync(houseFile(root))
  const house = createHouseBuild({
    chestWork: storage.chestWork,
    getMode: control.get, shared, log, disposed, getFeet: feetNow, getPosition: where, file: houseFile(root), write: writeDurableJson,
    getBlock: (x, y, z) => runtime.host().world.getBlock(x, y, z), getInventory: () => shared.inventoryUncertain ? null : runtime.inventory(),
    agent: { objective: OBJECTIVE, start: options => agent.start(options), stop: reason => agent.stop(reason), settled: idle },
    ports: createHousePorts({ operations, disposed, getBlock: (x, y, z) => runtime.host().world.getBlock(x, y, z), getInventory: () => shared.inventoryUncertain ? null : runtime.inventory() }),
    hands, climb: climbUp,
    travel: { to: travelTo, status: () => quarry.travelStatus(), cancel: () => quarry.cancelTravel() },
    hostile: () => danger(),
    // Not with 10 health or less: eating, the shelter and fleeing come first (live 2026-11-17 05:53 JST: the build began at 1.9 health with no food).
    // Nor hungry with no food: the forage comes first (live 2026-11-17 08:26-08:29 JST: hunger 12, the build stopped the forage for a cow).
    blocked: () => !(runtime.raw().health > 10) || hungryWithoutFood() || recovery.status().active || shelter.status().active || flee.status().active || cover.status().active || scaffold.status().active || torch.status().active || storage.status().active || base.status().active || wool.status().active || sand.status().active || food.status().active,
    // Done: chest A is the base, and the bed sets the respawn point.
    onDone: async (origin, { largeChests = [] } = {}) => {
      const at = chestOf(origin), here = (x, y, z) => runtime.host().world.getBlock(x, y, z)
      if (largeChests.some(p => p.x === at.x && p.y === at.y && p.z === at.z) && /chest$/.test(here(at.x, at.y, at.z)?.name ?? '') && !(shared.playerBase && shared.playerBase.x === at.x && shared.playerBase.y === at.y && shared.playerBase.z === at.z)) {
        shared.playerBase = at
        try { await writeDurableJson(baseFile(root), { version: 1, chest: at, savedAt: new Date().toISOString() }) } catch { /* Kept in shared. */ }
        log(`プレイヤーモード: 拠点を家のラージチェスト (${at.x}, ${at.y}, ${at.z}) にしました`)
      }
      const bed = bedOf(origin)
      if (bed && /bed$/.test(here(bed.x, bed.y, bed.z)?.name ?? '') && shared.playerHouse?.spawn !== true) {
        await houseDoor()
        if (await setSpawn({ origin, shared, useBed: target => operations.interactions.useBed(target), wakeBed: target => operations.interactions.wakeBed(target), walk: target => hands.walk(target), getFeet: feetNow, getBlock: here, previewUse: target => operations.interactions.previewUseBed?.(target), log })) shared.playerHouse = { ...shared.playerHouse, spawn: true }
      }
    }
  })
  const crew = [recovery, shelter, flee, cover, scaffold, torch, storage, base, wool, sand, food, water, house]
  const lifeKey = () => { const state = runtime.host().getServerFields?.(['connectionId', 'startedAt', 'dimension']) ?? runtime.raw(); return JSON.stringify([state.connectionId, state.startedAt, state.dimension, runtime.host().getLife?.()?.deathId]) }
  const active = () => !disposed() && control.get() === 'player' && shared.playerWanted === true
  const getBlock = (x, y, z) => runtime.host().world.getBlock(x, y, z)
  const cancelExpedition = () => {
    if (expedition?.busy() && quarry.travelStatus?.()?.busy) void Promise.resolve(quarry.cancelTravel()).catch(() => {})
    expedition?.cancel()
  }
  expedition = createDragonRuntime({
    operations, runtime, shared, root, active, log, getBlock, lifeKey, loading: () => shared.loadingScreenEnded === false || shared.respawnTerrain?.pending === true || shared.inventoryUncertain === true, threatened: danger,
    finish: () => { shared.playerWanted = false; shared.autoWanted = false; void resume.note() },
    legacyIdle: () => idle() && shared.autoWanted !== true,
    legacyBusy: () => require('./crew-busy').crewBusy(crew) || runtime.chunkMoveHeld() || runtime.manualChestStorage()?.isBusy() === true || runtime.resetHeld() || runtime.combatOwns?.() === true,
    stopLegacy: (reason, why) => why?.hurtOnly === true && runtime.combatOwns?.() === true ? runtime.autonomy().stop(reason) : inner.stop(reason),
    stepPorts: signal => {
      const owner = lifeKey()
      const cancelled = () => signal.aborted || !active() || lifeKey() !== owner || shared.loadingScreenEnded === false
      const travel = (input, options = {}) => {
        if (cancelled() || runtime.raw().dimension !== 'overworld') throw Error('地上の長距離移動は現世でのみ開始できます。')
        // The step keeps its trip until it ends (dragon-trip.js); nothing else of the expedition starts between two legs.
        const aborted = () => cancelled() || options.aborted?.() === true
        return expeditionTrip({ start: async () => { await tripRise(input?.destination ?? input ?? null, () => climbUp(cancelled)); return travelTo(input, { aborted }) }, status: () => quarry.travelStatus(), cancel: () => quarry.cancelTravel(), cancelled: aborted, until: options.until, resting: () => !!shared.travelNight?.cover, log })
      }
      const actions = guardDragonOperations(operations, cancelled)
      const hands = buildHands(cancelled, actions)
      return { operations: actions, runtime, shared, root, log, getBlock, where, feetNow, getFeet: feetNow,
        hands, walk: hands.walk, drop: (slot, count) => cancelled() ? null : storagePorts.drop(slot, count), cells: () => { const at = where(); return at ? walkableCells(at, (x, y, z) => runtime.host().world.getBlock(x, y, z)) : null }, travelTo: travel, climbUp: () => climbUp(cancelled), storage, cancelled, signal }
    }
  })
  // Direct resumes inside the runtime also consult the selected player's owner.
  shared.dragonOwnsWork = () => !disposed() && expedition.owns()
  // What the defenses were doing at a hit (live 2026-11-17 23:13-23:16 JST: three
  // minutes of arrows with no flee, cover or combat line in the log).
  const defenseNote = () => { const safe = (() => { try { return operations.safety.snapshot() } catch { return null } })(); return `離れる ${flee.status().skip ?? (flee.status().active ? '実行中' : '-')}・射線 ${cover.status().skip ?? (cover.status().active ? '実行中' : '-')}・待機保護 ${safe?.phase ?? '?'}${safe?.active ? `/${safe.active}` : ''}・プレイ ${shared.playerWanted === true ? '中' : '外'}` }
  const fleeTimer = setInterval(require('../common/work-spans').wrap('player-flee.tick', () => { if (disposed()) clearInterval(fleeTimer); else { coverHold.sample(); if (expedition.owns()) expedition.guard(); else void flee.tick().catch(() => {}); void cover.tick().catch(() => {}); try { noteDamage({ shared, health: runtime.raw().health, position: where(), actors: runtime.host().entities.snapshot({ kind: 'all' }), getBlock: (x, y, z) => runtime.host().world.getBlock(x, y, z), log, why: defenseNote }) } catch { /* A log line only. */ } } }), 500)
  fleeTimer.unref?.()
  // The received world behind the server under the feet: the terrain there is asked for again
  // (live 2026-11-18 07:09-09:48 JST, movement/ground-refresh.js).
  const ground = createGroundRefresh({ getCorrection: () => shared.lastServerCorrection, getBlock: (x, y, z) => runtime.host().world.getBlock(x, y, z), getDimension: () => runtime.raw().dimension, send: request => runtime.host().client.queue('subchunk_request', request), log })
  // The shelter is checked every two seconds; a reloaded runtime's timer ends itself.
  const timer = setInterval(require('../common/work-spans').wrap('player-mode.tick', () => {
    if (disposed()) { expedition.cancel(); return clearInterval(timer) }
    void resume.note()
    try { const gone = control.get() === 'player' ? pruneTunnelFloors(shared, runtime.raw(), where()) : 0; if (gone) log(`プレイヤーモード: 帰路の床の記録が多いため、遠いものから ${gone} 個を外しました`) } catch { /* The next tick retries. */ }
    try { if (shared.playerWanted === true) ground.tick() } catch { /* The next tick retries. */ }
    try { if (shared.playerWanted === true) houseDamage.tick() } catch { /* The next tick looks again. */ }
    if (expedition.tick()) {
      if (shared.travelNight?.cover && runtime.raw().dimension === 'overworld') void shelter.tick().catch(() => {})
      return
    }
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
  if (shared.playerRecovering === true) { shared.playerRecovering = false; if (control.get() === 'player' && !expedition.owns()) shared.autoWanted = true }
  // The runtime restarts a stopped run with the options it was last started with: a reload brings the player objective's current flags.
  if (control.get() === 'player' && shared.autoOptions && typeof shared.autoOptions === 'object') shared.autoOptions = { ...shared.autoOptions, deferOptionalShelter: true, nearThreatDistance: 8 }
  const player = createPlayerMode({
    getMode: control.get, log, expedition, safety: operations.safety, recovery: { ...recovery, cancel: () => { if (shared.playerWanted !== true) { cancelExpedition(); base.cancel('MANUAL_STOP') } return recovery.cancel() } }, shelter, flee, scaffold: { status: () => house.status().active ? house.status() : wool.status().active ? wool.status() : sand.status().active ? sand.status() : food.status().active ? food.status() : base.status().active ? base.status() : storage.status().active ? storage.status() : torch.status().active ? torch.status() : scaffold.status() }, shared,
    agent: { start: options => agent.start(options), stop: reason => agent.stop(reason), snapshot: agentStatus },
    getInventory: () => shared.inventoryUncertain ? null : runtime.raw().inventory,
    getWorn: () => { try { return runtime.armor?.() ?? null } catch { return null } }
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
