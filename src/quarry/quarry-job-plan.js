'use strict'

// Moved out of quarry-job.js unchanged by scripts/extract-runtime-block.js.
// `rt` exposes the bindings of that closure this code uses; each read or write
// of rt.<name> reads or writes the closure's own variable at that moment.
// Modules are loaded through rt.require, the require of quarry-job.js.

function createQuarryJobPlan (rt) {
  function planningBlocks (config) {
    const protectedBoxes = config.permissions?.protectedRegion ?? []
    return (x, y, z) => {
      const block = rt.adapter.getBlock(x, y, z)
      if (block?.known !== true || block.protected || block.protectionSource) return block
      const permanent = protectedBoxes.find(b => x >= b.xMin && x <= b.xMax && y >= b.yMin && y <= b.yMax && z >= b.zMin && z <= b.zMax)
      const temporary = rt.job?.portableStorage?.checkpoint?.placed?.some(c => c.position?.x === x && c.position?.z === z && (c.position.y === y || c.position.y - 1 === y))
      return permanent || temporary ? { ...block, protected: true, protectionSource: permanent?.source === 'home_station' ? 'home_station' : 'quarry_storage' } : block
    }
  }

  function rebuildPlanner () {
    const records = rt.planner?.exportRecords() ?? rt.job.records ?? {}
    rt.regions = makeRegions(rt.job.config, rt.job.yTop, rt.adapter.getState())
    rt.planner = rt.createQuarryPlanner({ regions: rt.regions, getBlock: planningBlocks(rt.job.config), config: rt.job.config.strategy, records, exit: rt.job.config.exit })
    rt.countsRevision++
  }

  // ---- planning (no world changes, §4.1 plan) ---------------------------
  function buildTravel (config, regs, state) {
    if (Array.isArray(config.permissions.travelRegion)) return config.permissions.travelRegion
    // Default: the job's columns grown by 2, plus the storage and the bot's
    // current place, from the job bottom to a few blocks above its top.
    const xs = []; const zs = []; const ys = []; const lows = [regs.yBottom]
    for (const chunk of regs.chunks) { const b = rt.chunkBounds(chunk); xs.push(b.xMin - 2, b.xMax + 2); zs.push(b.zMin - 2, b.zMax + 2) }
    for (const s of config.inventory.storage ?? []) if (s?.position) { xs.push(s.position.x - 3, s.position.x + 3); zs.push(s.position.z - 3, s.position.z + 3); ys.push(s.position.y + 4, s.position.y - 2); lows.push(s.position.y - 2) }
    // The final chest is a bounded surface endpoint, not an intermediate
    // quarry storage target. Its floor and interaction stand must stay routed.
    for (const point of [config.homeChest?.position,config.homeChest?.other,config.homeChest?.stand]) if (point) {
      xs.push(point.x - 2,point.x + 2);zs.push(point.z - 2,point.z + 2)
      ys.push(point.y + 3,point.y - 2);lows.push(point.y - 2)
    }
    // The bot's own place may lie below the job bottom (lower ground beside
    // the area), so the region reaches down to it as well.
    if (state?.position) { const f = rt.feetCell(state); xs.push(f.x - 2, f.x + 2); zs.push(f.z - 2, f.z + 2); ys.push(f.y + 4, f.y - 2); lows.push(f.y - 2) }
    const top = Math.min(regs.worldMaxY, Math.max(...ys, (regs.yTop ?? regs.worldMaxY - 4) + 4))
    return [{ xMin: Math.min(...xs), xMax: Math.max(...xs), yMin: Math.max(regs.worldMinY, Math.min(...lows)), yMax: top, zMin: Math.min(...zs), zMax: Math.max(...zs) }]
  }
  // Air below the surface inside the target columns. The surface of a column
  // is its highest non-air block at or under yTop; air under it is cave.
  function surveyCaves (regs, yTop, read) {
    let air = 0, known = 0, unknown = 0, longestRun = 0
    for (const col of regs.columns) {
      const [x, z] = col.split(',').map(Number)
      let surface = null, run = 0
      for (let y = yTop; y >= regs.yBottom; y--) {
        const b = read(x, y, z)
        if (b?.known !== true) { unknown++; run = 0; continue }
        const isAir = rt.AIR.has(rt.nameOf(b))
        // Trees and plants are not the ground: the air under a canopy is not
        // a cave (live 2026-11-13, chunk 123,-128 counted forest air as 43%).
        if (surface === null) { const r = isAir ? null : rt.blockRule(b.name); if (!isAir && !(r.plant || r.leaves || /^(WOOD|LEAF)_HARVEST_DISABLED$/.test(r.reason ?? '') || b.boundingBox !== 'block')) surface = y; continue }
        known++
        if (isAir) { air++; run++; longestRun = Math.max(longestRun, run) } else run = 0
      }
    }
    const ratio = known ? Math.round(air / known * 1000) / 1000 : 0
    const unknownRatio = known + unknown ? Math.round(unknown / (known + unknown) * 1000) / 1000 : 0
    return { air, known, unknown, ratio, unknownRatio, longestRun, high: ratio > rt.CAVE_RATIO || longestRun >= rt.CAVE_RUN }
  }

  function planExitPreview (config, regs, yTop, state, inv) {
    const read = planningBlocks(config); let unknown = false
    const result = rt.planQuarryExit({ regions: regs, yTop, feet: rt.feetCell(state), getBlock: (x, y, z) => { const b = read(x, y, z); if (b?.known !== true) unknown = true; return b }, inventory: inv, policy: { ...config.tools, ...config.collection }, exit: config.exit, preflight: true })
    const d = result.details ?? {}
    return { ready: result.ok === true, reason: result.ok ? null : result.reason ?? 'EXIT_PREFLIGHT_FAILED', unknown: !result.ok && unknown, predictionOnly: true, side: result.plan?.side ?? null, column: rt.copy(result.plan?.column ?? null), counts: rt.copy(d.counts ?? null), cause: d.cause ?? null }
  }
  // Deepest bottom (8-block steps, at most 24 tries) whose exit plan succeeds on received terrain.
  function suggestExitBottom (config, yTop, state, inv, fromY) {
    for (let y = fromY + 8, tries = 0; y <= yTop - 8 && tries < 24; y += 8, tries++) {
      const trial = { ...config, yBottom: y }
      const r = planExitPreview(trial, makeRegions(trial, yTop, state), yTop, state, inv)
      if (r.ready) return y
    }
    return null
  }

  function makeRegions (config, yTop, state) {
    const base = { target: config.target, yTop, yBottom: config.yBottom, worldMinY: config.worldMinY, worldMaxY: config.worldMaxY, boundarySeal: config.boundarySeal, infrastructureRegion: config.permissions.infrastructureRegion, protectedRegion: config.permissions.protectedRegion }
    const first = rt.buildRegions({ ...base, travelRegion: [] })
    const result = rt.buildRegions({ ...base, travelRegion: buildTravel(config, { ...first, yTop }, state) })
    if (rt.job?.config === config && rt.job.exitReservation?.plan) result.exitReservation = rt.job.exitReservation.plan
    return result
  }

  function plan (input) {
    rt.requireDrained()
    if (rt.job && rt.ACTIVE.has(rt.job.state)) throw new Error('A quarry job is running; pause or cancel it first')
    rt.clearAutoResume()
    const config = rt.defaults(input)
    // New jobs mine unlisted ordinary blocks by their data (2026-11-13 user request).
    if (input.strategy?.unknownBlockDefault == null) config.strategy.unknownBlockDefault = true
    // Unattended to the surface (2026-11-13 17:46 user instruction): end-of-job
    // exceptions and lost cargo boxes are accepted automatically, spare armour
    // is stored. Each can still be turned off per job.
    for (const key of ['autoAcceptFinalExceptions', 'autoAcceptCargoLoss', 'storeSpareArmor', 'finalChestStore']) if (input.strategy?.[key] == null) config.strategy[key] = true
    rt.setUnknownBlockDefault(config.strategy.unknownBlockDefault === true)
    // Only new production shulker plans adopt v2.2 by default. Persisted
    // legacy jobs keep their explicit policy and require deliberate migration.
    if (rt.shulkerOnly && input.inventory?.pickupMode == null && input.inventory?.depositWhen == null) {
      config.inventory.pickupMode = 'active'
      config.inventory.depositWhen = 'four_layers'
      if (input.inventory?.minFreeSlots == null) config.inventory.minFreeSlots = 3
    }
    if (rt.shulkerOnly && config.inventory.depositWhen === 'four_layers') {
      config.boundarySeal = { ...config.boundarySeal, enabled: true, horizontalMargin: 1, sourceOnly: true, material: 'dirt', closeOpenings: false }
      config.strategy.dirtFromSupplyAtExit = true
    }
    const state = rt.adapter.getState()
    const issues = []; const warnings = []
    if (![null, 'v22'].includes(config.initialLoadout)) issues.push('INVALID_INITIAL_LOADOUT')
    if (config.initialLoadout === 'v22') config.inventory.supplyLayout = 'v22'
    if (config.inventory.supplyLayout != null && config.inventory.supplyLayout !== 'v22') issues.push('INVALID_SUPPLY_LAYOUT')
    const initialLoadout = config.initialLoadout === 'v22'
    if (initialLoadout) {
      config.strategy.dirtFromSupplyAtExit = true
      if (input.inventory?.minFreeSlots == null) config.inventory.minFreeSlots = 3
    }
    const pendingLoadout = initialLoadout && rt.loadoutPorts() && rt.configuredLoadoutHome(config) && rt.emptyLoadoutInventory(state)
    if (initialLoadout) {
      if (!rt.configuredLoadoutHome(config)) issues.push('LOADOUT_CHEST_NOT_CONFIGURED')
      // Live 2026-11-13: the registered chest stood inside the target chunk and
      // was left on a 3-block island over the finished pit, out of reach for
      // the final storage. It must stand outside the target, 2+ blocks away.
      const home = config.homeChest, targetChunks = Array.isArray(config.target?.chunks) ? config.target.chunks : []
      const nearTarget = margin => home?.position && targetChunks.length && [home.position, home.other, home.stand].filter(Boolean).some(p => targetChunks.some(c => { const b = rt.chunkBounds(c); return p.x >= b.xMin - margin && p.x <= b.xMax + margin && p.z >= b.zMin - margin && p.z <= b.zMax + margin }))
      // Inside is refused; within 2 blocks of the edge is only a warning (the
      // usual station stands in the neighbouring chunk next to the pit edge).
      if (nearTarget(0)) issues.push('LOADOUT_CHEST_INSIDE_QUARRY')
      else if (nearTarget(2)) warnings.push({ code: 'LOADOUT_CHEST_NEAR_QUARRY_EDGE' })
      if (!rt.loadoutPorts()) issues.push('V22_RUNTIME_UNAVAILABLE')
      // Held or not yet received items are handled at the start (fetched again,
      // or stored in the registered chest first): a warning, not a refusal.
      if (!rt.emptyLoadoutInventory(state)) warnings.push({ code: 'LOADOUT_START_INVENTORY_NOT_EMPTY' })
      if (pendingLoadout) warnings.push({ code: 'INITIAL_LOADOUT_ON_START' })
    }
    if (!rt.worldIdentity(state)) issues.push('WORLD_IDENTITY_UNKNOWN')
    if (config.inventory.pickupMode !== undefined && !['active', 'passive'].includes(config.inventory.pickupMode)) issues.push('INVALID_PICKUP_MODE')
    if (config.inventory.depositWhen !== undefined && !['capacity', 'full', 'four_layers'].includes(config.inventory.depositWhen)) issues.push('INVALID_DEPOSIT_POLICY')
    if (!rt.validStoragePair(config.inventory)) issues.push('UNSUPPORTED_STORAGE_POLICY')
    if (rt.shulkerOnly && config.inventory.storage?.length) issues.push('SHULKER_ONLY_STORAGE')
    if (config.inventory.depositWhen === 'four_layers' || initialLoadout) {
      const chest = config.homeChest
      if (!initialLoadout && chest?.chunk && Array.isArray(config.target?.chunks) && !config.target.chunks.some(c=>c.x===chest.chunk.x&&c.z===chest.chunk.z)) issues.push('LOADOUT_TARGET_CHUNK_MISMATCH')
      if (!chest || !['position', 'other', 'stand'].every(part=>chest[part] && ['x','y','z'].every(axis=>Number.isSafeInteger(chest[part][axis])))) issues.push('LOADOUT_CHEST_NOT_CONFIGURED')
      if (!initialLoadout && (typeof rt.adapter.loadoutWithdraw !== 'function' || typeof rt.adapter.finalChestDeposit !== 'function' || typeof rt.adapter.equipmentTransfer !== 'function')) issues.push('V22_RUNTIME_UNAVAILABLE')
      if (chest?.position && chest?.other && chest?.stand) {
        // A fixed surface station survives excavation and retains its own
        // interaction floor. Everything else in the chunk remains mineable.
        config.permissions.protectedRegion ??= []
        for (const p of [chest.position, chest.other, {...chest.position,y:chest.position.y-1},
          {...chest.other,y:chest.other.y-1}, {...chest.stand,y:chest.stand.y-1}]) {
          if (!p || !['x','y','z'].every(axis=>Number.isSafeInteger(p[axis])))continue
          const exists=config.permissions.protectedRegion.some(box=>
            box.source==='home_station' && box.xMin===p.x && box.yMin===p.y && box.zMin===p.z)
          if(!exists)config.permissions.protectedRegion.push({xMin:p.x,xMax:p.x,yMin:p.y,yMax:p.y,zMin:p.z,zMax:p.z,source:'home_station'})
        }
      }
    }
    if (rt.shulkerOnly && !config.inventory.supplyBoxes?.length && !(config.inventory.depositWhen === 'four_layers' && config.homeChest) && !pendingLoadout) {
      const discovered = rt.adapter.discoverSupplies?.(rt.v22SupplyLayout(config) ? 'v22' : 'legacy')
      if (discovered?.ok) { config.inventory.supplyBoxes = rt.copy(discovered.bindings); config.inventory.autoSupplies = true }
    }
    if (config.inventory.autoSupplies && !config.inventory.supplyBoxes?.length && !(config.inventory.depositWhen === 'four_layers' && config.homeChest) && !pendingLoadout) {
      const discovered = rt.adapter.discoverSupplies?.(rt.v22SupplyLayout(config) ? 'v22' : 'legacy')
      if (discovered?.ok) config.inventory.supplyBoxes = rt.copy(discovered.bindings)
      else issues.push(discovered?.reason ?? 'SUPPLY_BOXES_UNCONFIRMED')
    }
    if (config.inventory.supplyBoxes?.length && (!rt.validSupplyBindings(config.inventory.supplyBoxes, config.inventory) || typeof rt.adapter.restockSupplies !== 'function')) issues.push('SUPPLY_BINDINGS_INVALID')
    if (state?.phase !== 'spawned' || state.dead) issues.push('NOT_SPAWNED')
    if (state?.gameMode !== 'survival' && state?.gameMode !== 0) issues.push('NOT_SURVIVAL')
    if (state?.dimension && state.dimension !== config.dimension.replace(/^minecraft:/, '')) issues.push('WRONG_DIMENSION')
    let regs = makeRegions(config, Number.isSafeInteger(config.yTop) ? config.yTop : null, state)
    const p = rt.createQuarryPlanner({ regions: regs, getBlock: planningBlocks(config), config: config.strategy, exit: config.exit })
    let yTop = Number.isSafeInteger(config.yTop) ? config.yTop : null
    let unknownAbove = 0
    if (yTop === null) { const s = p.surveyTop(); yTop = s.yTop; unknownAbove = s.unknownAbove }
    if (config.inventory.depositWhen === 'four_layers' || initialLoadout) {
      if (Number.isSafeInteger(yTop)) yTop = Math.min(yTop, 75)
      // The upper bound is clamped; terrain above it is outside the quarry.
    }
    if (yTop === null) issues.push('Y_TOP_UNKNOWN')
    if (unknownAbove) warnings.push({ code: 'Y_TOP_PROVISIONAL', unknownCells: unknownAbove })
    if (yTop !== null) regs = makeRegions(config, yTop, state)
    const inv = rt.items(state)
    if (!inv) issues.push('INVENTORY_UNKNOWN')
    const storageList = config.inventory.storage ?? []
    if ((rt.shulkerOnly || !storageList.length && config.inventory.carryOnly !== true) && !pendingLoadout && !(config.inventory.depositWhen === 'four_layers' && config.homeChest && !inv?.length || typeof rt.adapter.storeCarried === 'function' && rt.cargoSelection(inv, { excludedShulkerKeys: rt.storageSupplyExclusions(config.inventory.supplyBoxes) }))) issues.push(rt.shulkerOnly ? 'NO_CARGO_SHULKER' : 'NO_STORAGE_REGISTERED')
    for (const s of storageList) {
      const b = s?.position ? rt.adapter.getBlock(s.position.x, s.position.y, s.position.z) : null
      if (!b?.known || !/chest|barrel/.test(rt.nameOf(b))) issues.push(`STORAGE_NOT_OBSERVED:${JSON.stringify(s?.position ?? null)}`)
      else if (rt.permits(regs, 'break', s.position).allowed) issues.push('STORAGE_INSIDE_EXCAVATION')
    }
    if (inv && !pendingLoadout && !(config.inventory.depositWhen === 'four_layers' && config.homeChest && !inv.length)) {
      const picks = inv.filter(i => /_pickaxe$/.test(rt.nameOf(i)))
      if (!picks.length) warnings.push({ code: 'NO_PICKAXE', note: 'Stone and ores will wait for a tool' })
      if (!inv.some(i => rt.isFood(i.name))) warnings.push({ code: 'NO_FOOD' })
      if (!inv.some(i => /cobblestone|cobbled_deepslate|^dirt$|^stone$/.test(rt.nameOf(i)))) warnings.push({ code: 'NO_SEAL_MATERIAL', note: 'Water/lava and stair repairs will pause' })
    }
    const pl = rt.createQuarryPlanner({ regions: regs, getBlock: planningBlocks(config), config: config.strategy, exit: config.exit })
    let stair = null; let counts = null; let survey = null
    if (yTop !== null) {
      const entry = storageList[0]?.position ?? (state?.position ? rt.feetCell(state) : null)
      stair = pl.planStair({ entry, yTop })
      if (!stair && config.exit.mode === 'legacy_stair') issues.push('STAIR_START_UNKNOWN')
      counts = pl.counts(yTop)
      survey = { fluidCells: 0, protected: [], containers: [] }
      for (let y = yTop; y >= regs.yBottom && survey.protected.length < 64; y--) {
        const s = pl.layerSummary(y, {})
        survey.fluidCells += s.fluid.length
        for (const b of s.blocked) if (survey.protected.length < 64) survey.protected.push({ position: b.position, name: b.name, reason: b.reason })
      }
      if (survey.fluidCells > config.strategy.largeFluidCells) warnings.push({ code: 'LARGE_FLUID_IN_TARGET', cells: survey.fluidCells })
      // Many protected/unknown blocks usually mean a player build inside the
      // target; they are never broken, but the user should know before start.
      if (survey.protected.length >= 16) warnings.push({ code: 'PROTECTED_BLOCKS_IN_TARGET', cells: survey.protected.length, note: 'Possibly a player structure; these blocks are left in place', names: [...new Set(survey.protected.map(p => p.name))].slice(0, 8) })
    }
    // Exit check at plan time (prediction only, no world change): the same
    // planner the job runs before excavation. A target whose received terrain
    // leaves no exit column is refused here instead of after start; unknown
    // terrain only warns. A shallower bottom that would work is suggested.
    let exitPreflight = null
    if (yTop !== null && inv && state?.position && config.exit?.mode === 'adjacent_pillar' && typeof rt.adapter.egress === 'function' && config.inventory.depositWhen !== 'four_layers' && !pendingLoadout) {
      exitPreflight = planExitPreview(config, regs, yTop, state, inv)
      if (!exitPreflight.ready) {
        if (exitPreflight.reason === 'EXIT_COLUMN_UNAVAILABLE' && !exitPreflight.unknown) {
          issues.push('PLAN_EXIT_UNAVAILABLE')
          exitPreflight.suggestedBottom = suggestExitBottom(config, yTop, state, inv, regs.yBottom)
        } else warnings.push({ code: exitPreflight.unknown ? 'EXIT_PREFLIGHT_PROVISIONAL' : 'EXIT_PREFLIGHT_' + String(exitPreflight.reason ?? 'FAILED').replace(/^EXIT_/, ''), reason: exitPreflight.reason })
      }
    }
    // Cave check at plan time (received blocks only): open air below the
    // surface inside the box is a cave the layer-by-layer digging cannot cross
    // (live 2026-11-10: chunk (-2,0) was a 40-deep cave from Y21). A large cave
    // refuses the plan unless allowCaves is set; unknown cells only warn.
    let caveSurvey = null
    if (yTop !== null) {
      caveSurvey = surveyCaves(regs, yTop, planningBlocks(config))
      if (caveSurvey.high) {
        if (config.allowCaves) warnings.push({ code: 'CAVE_VOLUME_HIGH', ratio: caveSurvey.ratio, longestRun: caveSurvey.longestRun, overridden: true })
        else issues.push('CAVE_VOLUME_HIGH')
      } else if (caveSurvey.unknownRatio > rt.CAVE_UNKNOWN_RATIO) warnings.push({ code: 'CAVE_VOLUME_PROVISIONAL', unknownRatio: caveSurvey.unknownRatio })
    }
    const sealCells = regs.seal.ready ? regs.seal.columns.size * (regs.seal.yMax - regs.seal.yMin + 1) : 0
    const summary = { ready: issues.length === 0, issues, warnings, jobId: config.jobId, chunks: regs.chunks, yTop, yTopProvisional: unknownAbove > 0, yBottom: regs.yBottom, columns: regs.columns.size, counts, survey, stair, exitPreflight, caveSurvey, boundarySeal: { enabled: regs.seal.enabled, ready: regs.seal.ready, columns: regs.seal.columns.size, yMin: regs.seal.yMin, yMax: regs.seal.yMax, cells: sealCells, placementOnly: true }, travelRegion: regs.travel, storage: storageList,
      ...(pendingLoadout ? { initialLoadout: { mode: 'v22', pending: true, serverConfirmed: false, position: rt.copy(config.homeChest.position) } } : {}) }
    rt.job = { config, instanceId: rt.randomUUID(), world: rt.worldIdentity(state), actionSequence: 0, state: 'IDLE', planned: summary, yTop, cursorY: yTop, deepestY: yTop, records: { stair }, ledger: {}, userRunIntent: 'idle', result: null, pauseReason: null, interruption: null, checkpoint: null, actions: [], deaths: [], startedAt: null, scope: null, life: null }
    rt.regions = regs; rt.planner = pl; rt.ledger = rt.createLedger()
    return rt.copy(summary)
  }
  return {
    planningBlocks,
    makeRegions,
    rebuildPlanner,
    plan
  }
}

module.exports = { createQuarryJobPlan }
