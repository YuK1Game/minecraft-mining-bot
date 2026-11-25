'use strict'

const { buildGate, useGate, leaveGate, nearestGate, cell, center, distance, held, floor, air, pending, live, place } = require('./dragon-nether-portal')
const { isSupportedFood } = require('../actions/food')
const { approachHome } = require('./dragon-early-home')
const { chestOf } = require('./house/house-spawn')
const { inside, leaveHouse } = require('./house/house-exit')
const { openDoor } = require('./house/house-door')
const { nearby, recordStep, retrieve, returnAlongRoute, survey, findWart, reachable } = require('./dragon-nether-route')
const { barterGoldGoal, pearlProgress, stepBarter } = require('./dragon-barter')

const count = (ctx, name) => held(ctx, 'minecraft:' + name)
const eyeBudget = ctx => count(ctx, 'ender_eye') + count(ctx, 'blaze_powder') + 2 * count(ctx, 'blaze_rod')
const potion = ctx => ctx.supplies.countPotion('fire_resistance')
const effect = ctx => ctx.supplies.remainingEffect('fire_resistance')
const safetyFood = ctx => (ctx.runtime.inventory()?.items ?? []).reduce((sum, i) => sum + (isSupportedFood(i.name, ctx.runtime.raw()) ? i.count : 0), 0)
const stopped = reason => ({ done: false, phase: 'waiting', reason })

function portalProof (record, raw, destination) {
  const event = record.lastTransition, departure = record.nether.departure
  const gate = destination === 'nether' ? record.nether.gate : record.nether.homeGate
  return !!gate && !!event?.position && distance(event.position, gate) < 8 && !!departure && event?.from === departure.from && event.to === destination && event.respawn === false &&
    (!raw.dimension || raw.dimension === destination) && event.connectionId === departure.connectionId &&
    event.deathId === departure.deathId && Number.isSafeInteger(event.sequence) && event.sequence > departure.sequence
}

async function cross (ctx, gate, to) {
  const record = ctx.memory, raw = ctx.runtime.raw(), n = record.nether
  const life = record.lastLife
  if (!life || life.connectionId !== raw.connectionId || life.deathId == null) return stopped('ゲートに入る前に生存情報を確認しています')
  // Save the departure before stepping into the gate. A dimension transition
  // invalidates an in-flight step's old world scope.
  if (n.departure?.from !== raw.dimension || n.departure.connectionId !== raw.connectionId || n.departure.deathId !== life.deathId) {
    n.departure = { from: raw.dimension, connectionId: raw.connectionId, deathId: life.deathId, sequence: record.lastTransition?.connectionId === raw.connectionId ? record.lastTransition.sequence : 0 }
    return pending('出発する次元・ゲートと生存情報を記録しました')
  }
  return useGate(ctx, gate, to)
}

async function afterEntry (ctx, n, gate, dim) {
  const proof = ctx.memory.lastTransition
  const key = proof && proof.to === dim && proof.connectionId === ctx.runtime.raw().connectionId ? [proof.connectionId, proof.sequence].join(':') : null
  if (!key || n.arrival?.key === key && n.arrival.cleared) return null
  if (!n.arrival || n.arrival.key !== key) n.arrival = { key }
  if (!n.arrival.leftAt) {
    if (await leaveGate(ctx, gate)) n.arrival.leftAt = Date.now()
    return pending('到着ゲートから一度外へ出ます')
  }
  if (Date.now() - n.arrival.leftAt < 16000) return pending('ゲートの外で再使用できるまで待機しています')
  n.arrival.cleared = true
  return null
}

function shelterPlan (ctx, n, at = n.gate) {
  for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
    const atOffset = (ahead, side, up = 0) => ({ x: at.x + dx * ahead - dz * side, y: at.y + up, z: at.z + dz * ahead + dx * side })
    const get = p => ctx.getBlock(p.x, p.y, p.z)
    const plan = []
    let ok = true
    for (let a = 2; a <= 3 && ok; a++) for (let s = -1; s <= 1 && ok; s++) {
      if (!floor(get(atOffset(a, s, -1)))) { ok = false; break }
      for (let h = 0; h < 3; h++) {
        const p = atOffset(a, s, h), b = get(p), wall = s !== 0 || h === 2
        if (wall && air(b)) plan.push(p)
        else if (wall ? !floor(b) : !air(b)) { ok = false; break }
      }
    }
    if (ok) return { steps: plan.sort((a, b) => a.y - b.y), entrance: atOffset(2, 0) }
  }
  return null
}

function landingStep (ctx, gate) {
  const frame = ctx.getBlock(gate.x, gate.y, gate.z)
  if (frame?.known !== true || !['x', 'z'].includes(frame.properties?.portal_axis)) return null
  const axisX = frame.properties.portal_axis === 'x'
  for (const sign of [1, -1]) {
    for (let step = 1; step <= 3; step++) {
      const x = gate.x + (axisX ? 0 : sign * step), z = gate.z + (axisX ? sign * step : 0), y = gate.y - 1
      const below = ctx.getBlock(x, y, z)
      if (!air(ctx.getBlock(x, y + 1, z)) || !air(ctx.getBlock(x, y + 2, z))) break
      if (floor(below)) continue
      const previous = ctx.getBlock(x - (axisX ? 0 : sign), y, z - (axisX ? sign : 0))
      if (air(below) && floor(previous)) return { x, y, z }
      break
    }
  }
  return null
}

async function outpost (ctx, n) {
  if (n.sheltered) return null
  if (!n.shelter) {
    n.shelter = shelterPlan(ctx, n)
    if (!n.shelter) {
      const candidates = reachable(ctx).filter(p => distance(p, n.gate) <= 8).sort((a, b) => distance(a, n.gate) - distance(b, n.gate))
      for (const p of candidates.slice(0, 40)) {
        n.shelter = shelterPlan(ctx, n, p)
        if (n.shelter) break
      }
    }
  }
  if (!n.shelter) {
    // The portal sometimes opens over a drop. Verify a natural refuge rather
    // than placing a roof or picking a direction over an unknown floor.
    const refuge = reachable(ctx).find(p => distance(p, n.gate) <= 9 && floor(ctx.getBlock(p.x, p.y + 2, p.z)) &&
      [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([x, z]) => floor(ctx.getBlock(p.x + x, p.y, p.z + z))).length >= 2)
    if (!refuge) {
      n.returning = 'unsafe_exit'
      return pending('ネザー側の出口に退避場所を作れないため地上へ戻ります')
    }
    n.shelter = { entrance: refuge, steps: [] }
  }
  const step = n.shelter.steps.find(p => !floor(ctx.getBlock(p.x, p.y, p.z)))
  if (!step) { n.sheltered = true; return null }
  if (count(ctx, 'cobblestone') < 1) { n.returning = 'supplies'; return pending('遮蔽用の丸石を補給します') }
  return place(ctx, { item: 'minecraft:cobblestone', position: step })
}

async function ingredients (ctx, n, at) {
  if (!n.wartBed || count(ctx, 'nether_wart') < 1 && ctx.getBlock(n.wartBed.x, n.wartBed.y, n.wartBed.z)?.name !== 'minecraft:nether_wart') {
    n.wartBed = findWart(ctx, at)
  }
  if (!n.wartBed) return null
  const wart = n.wartBed
  let position = wart, name = 'minecraft:nether_wart'
  if (count(ctx, 'nether_wart') > 0) {
    if (count(ctx, 'soul_sand') > 0) return null
    position = { ...wart, y: wart.y - 1 }; name = 'minecraft:soul_sand'
    if (!air(ctx.getBlock(wart.x, wart.y, wart.z))) return null
  }
  if (ctx.getBlock(position.x, position.y, position.z)?.name !== name) return null
  if (distance(at, position) > 4) {
    const stand = reachable(ctx).sort((a, b) => distance(a, position) - distance(b, position)).find(p => distance(p, position) < 4)
    if (!stand) return null
    if (await ctx.hands.walk(center(stand))) recordStep(n, cell(ctx.getFeet()))
    return pending('ネザーウォート畑の安全な足場へ向かいます')
  }
  const target = { ...position, accessPreparation: 'nether_ingredient', expectedName: name }
  if (!ctx.hands.canMine(target)) return null
  await ctx.hands.mine(target)
  return pending('醸造材料を採取し、ドロップの受信を確認します')
}

async function hunt (ctx, n) {
  const at = cell(ctx.getFeet()), actors = nearby(ctx, 40)
  const drops = actors.filter(a => a.kind === 'item' && ['blaze_rod', 'nether_wart', 'soul_sand', 'magma_cream'].some(name => a.name === 'minecraft:' + name))
  const enemies = actors.filter(a => a.kind !== 'item')
  if (n.firstReturned && !n.brewed && potion(ctx) > 0) n.brewed = true
  if (ctx.runtime.raw().health <= 12 || safetyFood(ctx) < 8 || !count(ctx, 'arrow') ||
      enemies.some(a => /wither_skeleton|piglin_brute/.test(a.entityType) && a.distance < 5)) {
    n.returning = 'supplies'
    return pending('体力・補給・接敵状況から退路へ戻ります')
  }
  const blaze = enemies.find(a => a.entityType === 'minecraft:blaze')
  if (blaze && !n.blazeSite) n.blazeSite = at
  const needsWart = !n.brewed && !count(ctx, 'nether_wart')
  const needsCream = !n.brewed && !count(ctx, 'magma_cream') && !count(ctx, 'slime_ball')
  const cube = needsCream && enemies.find(a => a.entityType === 'minecraft:magma_cube')
  const target = n.firstReturned && !n.brewed ? cube || (blaze?.distance < 8 && blaze) : blaze || cube
  const resourcesReady = !needsWart && !needsCream
  const bootstrap = !n.firstReturned
  const sourceFound = Boolean(n.fortress || n.blazeSite)
  const cargoReady = bootstrap ? count(ctx, 'blaze_rod') >= 2 && sourceFound : n.brewed ? eyeBudget(ctx) >= 20 && sourceFound : resourcesReady
  if (cargoReady) {
    n.returning = bootstrap ? 'first_rods' : n.brewed ? 'rods' : 'ingredients'
    return pending('採取した素材を持って地上へ戻ります')
  }
  const missed = n.missedShot
  const occluded = missed?.id === target?.runtimeId && missed?.position && target?.position && distance(missed.position, target.position) < 1 && Date.now() < missed.until
  if (target && !occluded && target.distance <= 32) {
    if (n.brewed && effect(ctx) < 20000) {
      if (!potion(ctx)) { n.returning = 'supplies'; return pending('耐火の残量が少ないので帰還します') }
      await ctx.supplies.drink('fire_resistance', { signal: ctx.signal })
      return pending('受信した耐火効果を確認しています')
    }
    // Leave other hostiles to the regular defensive combat mode.
    const weapon = target.distance <= 3 ? 'melee' : 'bow'
    if (live(ctx)) {
      try {
        const result = await ctx.runtime.expeditionStrike(target, weapon, { signal: ctx.signal })
        if (result?.shotsRequested || result?.hitsRequested) return pending('単体を攻撃し、戦利品は実際の持ち物で確認します')
      } catch (error) {
        if (ctx.signal?.aborted) throw error
      }
      n.missedShot = { id: target.runtimeId, position: target.position, until: Date.now() + 8000 }
    }
  }
  const loot = await retrieve(ctx, n, drops)
  if (loot) return loot
  if (!n.brewed) {
    const gathered = await ingredients(ctx, n, at)
    if (gathered) return gathered
  }
  return survey(ctx, n, n.firstReturned && !n.brewed ? needsWart ? 'wart' : 'magma' : 'blaze')
}

async function exitHome (ctx) {
  const { getFeet, getBlock, log, shared } = ctx
  const walk = p => live(ctx) && ctx.hands.walk(p)
  const door = () => openDoor({ origin: shared.playerHouse.origin, getBlock, getFeet, walk, log, useDoor: p => ctx.operations.interactions.useDoor(p) })
  await leaveHouse({ house: shared.playerHouse, getBlock, getFeet, walk, door, log })
  return pending('ネザーゲートへ向かうため本拠点のドアから出ます')
}

async function overworld (ctx, n) {
  const at = cell(ctx.getFeet())
  if ((!n.homeGate || n.departure?.from === 'overworld') && inside(ctx.shared.playerHouse?.origin, ctx.getFeet())) return exitHome(ctx)
  if (!n.homeGate) {
    const gate = nearestGate(ctx.getBlock, at, 8)
    if (!gate) return buildGate(ctx, n)
    n.homeGate = gate
    return pending('地上のゲートブロックと座標を記録しました')
  }
  const proof = portalProof(ctx.memory, ctx.runtime.raw(), 'overworld')
  if (proof && n.returning) {
    if (n.returning === 'unsafe_exit') n.unsafeExit = true
    if (n.returning === 'probe') n.roundTrip = true
    if (n.returning === 'barter_none') n.barterExhausted = true
    if (count(ctx, 'blaze_rod') >= 2) n.firstReturned = true
    if (n.returning === 'rods') n.fortressReturn = true
    n.route = []
    n.returning = null
    n.departure = null
  } else if (n.returning && !proof) {
    // Death/reconnect without an arrival receipt cannot certify a handoff.
    n.returning = null
    n.route = []
  }
  if (n.unsafeExit) return stopped('ネザー側の足場を確保できず地上へ帰還しました。出口の修復後、ネザーで地形を再確認します。')
  if (n.barterGoal) {
    if (pearlProgress(ctx) >= n.barterGoal) {
      delete n.barterGoal
      ctx.shared.dragonGoldBoots = false
      return { done: true, reason: 'ピグリン交易で必要なエンダーパールを確認し、現世へ戻りました。' }
    }
    if (n.barterExhausted) {
      delete n.barterGoal
      ctx.shared.dragonGoldBoots = false
      return { done: true, reason: 'ネザーで交易できるピグリンが見つからなかったため、現世の洞窟探索へ切り替えます。' }
    }
  } else if (n.roundTrip && n.brewed && n.fortressReturn && eyeBudget(ctx) >= 20) {
    ctx.shared.dragonGoldBoots = false
    return { done: true, reason: 'ネザー往復と、地上でアイ20個分のブレイズ素材を確認しました。' }
  }
  const cooldown = await afterEntry(ctx, n, n.homeGate, 'overworld')
  if (cooldown) return cooldown
  if (n.firstReturned) {
    const chest = ctx.shared.playerBase ?? (ctx.shared.playerHouse?.origin && chestOf(ctx.shared.playerHouse.origin))
    if (!chest) return stopped('最初のロッドを預ける本拠点のチェストを確認しています')
    if (!n.banked) {
      if (!await approachHome(ctx, chest)) return pending('最初のロッドを本拠点へ運んでいます')
      const bank = await ctx.supplies.store(chest, 'blaze_rod', 2)
      if (bank.done) n.banked = true
      return pending(bank.reason)
    }
    if (!potion(ctx)) {
      const ready = count(ctx, 'nether_wart') && (count(ctx, 'magma_cream') || count(ctx, 'slime_ball'))
      if (n.brewed || n.brewing || ready) {
        if (!n.brewed && !n.brewing) {
          if (!await approachHome(ctx, chest)) return pending('醸造に使うロッドを受け取りに戻ります')
          const retrieved = await ctx.supplies.withdraw(chest, 'blaze_rod', 2)
          if (retrieved.done) n.brewing = true
          return pending(retrieved.reason)
        }
        const brew = await ctx.supplies.brew('fire_resistance', { count: 3, signal: ctx.signal })
        if (!brew.done || !potion(ctx)) return pending(brew.reason)
      }
    }
    if (potion(ctx)) { n.brewed = true; n.brewing = false }
  }
  const kit = await ctx.supplies.prepare('nether', { signal: ctx.signal })
  if (!kit.done) return pending(kit.reason)
  ctx.shared.dragonGoldBoots = true
  if (!ctx.runtime.armor()?.worn?.some(piece => piece.name === 'minecraft:golden_boots')) {
    await ctx.operations.armor.equipBest()
    return pending('金のブーツを装備枠で確認しています')
  }
  if (count(ctx, 'cobblestone') < 24 && !n.sheltered) return pending((await ctx.supplies.acquire('cobblestone', 24)).reason)
  if (n.barterGoal && typeof ctx.supplies?.acquire === 'function') {
    const goldGoal = barterGoldGoal(Math.max(1, n.barterGoal - pearlProgress(ctx)))
    if (count(ctx, 'gold_ingot') < goldGoal) return pending((await ctx.supplies.acquire('gold_ingot', goldGoal)).reason)
  }
  if (inside(ctx.shared.playerHouse?.origin, ctx.getFeet())) return exitHome(ctx)
  return cross(ctx, n.homeGate, 'nether')
}

async function stepNether (ctx) {
  if (!live(ctx) || !ctx.getFeet() || ctx.runtime.inventory()?.known !== true || ctx.shared.inventoryUncertain) return stopped('現在地と持ち物の受信を待っています')
  const raw = ctx.runtime.raw(), n = ctx.memory.nether
  if (raw.dimension === 'overworld') return overworld(ctx, n)
  if (raw.dimension !== 'nether') return stopped('ネザー遠征の次元を再確認しています')
  const at = cell(ctx.getFeet())
  if (!n.gate) {
    const gate = nearestGate(ctx.getBlock, at, 10)
    if (!gate) return stopped('ネザー側の帰還ゲートを受信するまで出発を保留しています')
    n.gate = gate
    return pending('ネザー側の帰還ゲートと退路の起点を記録しました')
  }
  if (n.unsafeExit) delete n.unsafeExit
  if (!n.sheltered && !n.returning && !n.shelter && !n.arrival?.cleared) {
    // On a suspended portal the only initial foothold may be the sill itself.
    // Confirm a walkable landing; build each outward floor from received air
    // adjoining a solid face, with the same placement/inventory receipts as the frame.
    const choices = reachable(ctx)
    if (!choices.some(p => distance(p, n.gate) >= 2 && distance(p, n.gate) <= 5 && air(ctx.getBlock(p.x, p.y, p.z)))) {
      const landing = landingStep(ctx, n.gate)
      if (landing && count(ctx, 'cobblestone') > 0) return place(ctx, { item: 'minecraft:cobblestone', position: landing })
      return stopped('ネザーのゲートの外に安全な足場を確認できないため、着地点の地形更新を待っています。')
    }
  }
  const cooldown = await afterEntry(ctx, n, n.gate, 'nether')
  if (cooldown) return cooldown
  if (!n.returning && !n.sheltered) {
    const cover = await outpost(ctx, n)
    if (cover) return cover
  }
  if (!n.returning && !n.roundTrip) n.returning = 'probe'
  if (n.returning) {
    const walking = await returnAlongRoute(ctx, n)
    if (walking) return walking
    return cross(ctx, n.gate, 'overworld')
  }
  if (n.barterGoal) return stepBarter(ctx, n, { pearlTarget: n.barterGoal })
  return hunt(ctx, n)
}

module.exports = { stepNether, portalProof, eyeBudget, landingStep }
