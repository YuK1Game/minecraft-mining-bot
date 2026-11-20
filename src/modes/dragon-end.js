'use strict'

const { observeSpikes } = require('./dragon-end-spikes')
const { interiorStairs } = require('./dragon-end-stairs')
const { crystal } = require('../combat/expedition-target')
const { nextGround, fountain, cell, center, distance, air, SIDES, bridge, findShelter } = require('./dragon-end-terrain')

const working = reason => ({ phase: 'working', reason })
const waiting = reason => ({ phase: 'waiting', reason })
const complete = reason => ({ phase: 'complete', reason })
const alive = a => a.dimension === 'end' && a.alive === true && a.positionKnown === true && a.position
const ARENA = { x: 0.5, z: 0.5 }
const FLIGHT_BLOCKED = new Set(['RANGE', 'LOS_BLOCKED', 'BLOCKED_LINE', 'ACTOR_IN_SHOT_PATH', 'SECONDARY_MELEE_THREAT', 'OTHER_PLAYER', 'FRIENDLY_IN_PATH', 'OUT_OF_REACH'])
const shootable = r => r?.shotsRequested > 0 || r?.targetDead
const isCloud = a => /^minecraft:(?:area_effect_cloud|dragon_fireball)$/.test(a.entityType)
const same = (a, b) => a.x === b.x && a.z === b.z
const lifeOf = ctx => ctx.runtime.host().getLife?.()?.deathId ?? ctx.runtime.raw().lifecycle?.deathId ?? null

async function walk (ctx, target, avoid) {
  const next = nextGround(ctx.getBlock, ctx.getFeet(), target, avoid)
  return next ? ctx.hands.walk(next) : false
}

async function dig (ctx, position, expectedName) {
  const get = () => ctx.getBlock(position.x, position.y, position.z)
  if (get()?.name !== expectedName) return false
  if (expectedName === 'minecraft:obsidian') {
    const pick = (ctx.runtime.inventory()?.items ?? []).filter(i =>
      /^minecraft:(?:diamond|netherite)_pickaxe$/.test(i.name) && i.count > 0 && i.durabilityKnown && i.durabilityRemaining > 2
    ).sort((a,b) => b.durabilityRemaining - a.durabilityRemaining)[0]
    if (!pick) return false
    await ctx.operations.inventory.equip(pick.slot)
  } else if (!await ctx.hands.pick(position)) return false
  if (ctx.cancelled?.()) return false
  const target = { ...position, expectedName, accessPreparation: 'end_expedition' }
  if (!ctx.operations.mining.preview([target]).ready) return false
  await ctx.operations.mining.start([target])
  return true // the next step reads the block again
}

function cage (ctx, actor) {
  const p = cell(actor.position)
  // The cage occupies the edge of a 5x5 square centered on the cap.
  for (const [dx, dz] of SIDES) {
    const near = { x: p.x + dx * 2, z: p.z + dz * 2, y: p.y }
    if ([0, 1].some(dy => ctx.getBlock(near.x, near.y + dy, near.z)?.name === 'minecraft:iron_bars')) return true
  }
  return false
}

async function openCage (ctx, record, actor) {
  const p = cell(actor.position), at = cell(ctx.getFeet())
  const column = record.climb
  if (!column) {
    const candidates = SIDES.map(([dx, dz]) => ({ x: p.x + dx * 4, z: p.z + dz * 4, dx, dz }))
    candidates.sort((a, b) => distance(a, at) - distance(b, at))
    const side = candidates.find(s => ![0, 1].every(dy => air(ctx.getBlock(p.x + 2*s.dx, p.y + dy, p.z + 2*s.dz))))
    if (!side) return null
    record.climb = { ...side, baseY: null, id: String(actor.uniqueId), life: lifeOf(ctx), top: p, descending: false, interior: !(ctx.supplies.remainingEffect('slow_falling') > 20000 || ctx.supplies.countPotion('slow_falling') > 0) }
    return working('鉄格子を開ける面と帰りの足場を記録します。')
  }
  if (column.interior) return interiorStairs(ctx, record, column, dig, walk)
  if (!same(at, column)) {
    if (await walk(ctx, center({ ...column, y: at.y }))) return working('鉄格子の外側まで地上から接近します。')
    return waiting('塔の横に安全に立てる足場を探しています。')
  }
  if (column.baseY == null) {
    if (column.descending) { delete record.climb; return working('登頂前に消えたクリスタルを再調査します。') }
    column.baseY = at.y
  }
  if (!column.descending && (ctx.supplies.remainingEffect('slow_falling') ?? 0) < 20000) {
    await ctx.supplies.drink('slow_falling')
    return waiting('低速落下の効果を確認してから高所で作業します。')
  }
  if (!column.descending && at.y < p.y) {
    const result = await ctx.hands.pillar(at, at.y, { any: true })
    return result?.ok ? working('低速落下中に、受信した柱を一段ずつ登ります。') : waiting('柱の設置と足場を確認しています。')
  }
  if (!column.descending) {
    for (const dy of [0, 1]) {
      const bar = { x: p.x + column.dx * 2, z: p.z + column.dz * 2, y: p.y + dy }
      if (ctx.getBlock(bar.x, bar.y, bar.z)?.name === 'minecraft:iron_bars') {
        const started = await dig(ctx, bar, 'minecraft:iron_bars')
        return started ? working('鉄格子を開け、ブロック更新を待ちます。') : waiting('鉄格子の射線とツルハシを確認しています。')
      }
    }
    column.descending = true
    record.openFace = { x: p.x, z: p.z, dx: column.dx, dz: column.dz }
  }
  if (at.y > column.baseY) {
    await ctx.hands.descend({ ...at, y: at.y - 1 })
    return working('クリスタルから離れて撃つため、自分の柱を一段ずつ下ります。')
  }
  delete record.climb
  return working('地上で開けた格子側に射撃位置を取ります。')
}

async function runDragonEndStep (ctx, record, { signal } = {}) {
  const { runtime, getBlock } = ctx, state = runtime.raw(), life = lifeOf(ctx)
  if (signal?.aborted || state.dead || !(state.health > 0) || state.spawnPending) return waiting('生存状態と次元の受信を待っています。')
  if (state.dimension === 'overworld') {
    const attempt = record.returnAttempt
    const transit = ctx.memory?.lastTransition
    if ((record.victory || record.preexisting) && attempt && Number.isSafeInteger(attempt.life) &&
        transit?.connectionId === attempt.connectionId && transit.sequence > attempt.sequence && transit.deathId === attempt.life && transit.respawn === false && transit.from === 'end' && transit.to === 'overworld') {
      record.returned = true
      return complete(record.preexisting ? '既に開通していたエンドから現世へ帰還しました。今回の討伐記録はありません。' : 'ドラゴン討伐後、出口を通って現世に帰還しました。')
    }
    return waiting('現世の出撃所で再入場の準備をします。')
  }
  if (state.dimension !== 'end' || !ctx.getFeet()) return waiting('エンドの地形と現在位置の受信を待っています。')
  const at = ctx.getFeet(), here = cell(at), actors = runtime.host().entities.snapshot({ kind: 'all' })
  const active = actors.filter(alive)
  const dragons = actors.filter(a => a.dimension === 'end' && a.entityType === 'minecraft:ender_dragon')
  const dragon = active.find(a => a.entityType === 'minecraft:ender_dragon')
  const bowl = fountain(getBlock)
  if (dragon) record.dragon = String(dragon.uniqueId)
  if (bowl && !bowl.open) record.closed = true
  if (dragons.some(d => String(d.uniqueId) === record.dragon && d.alive === false && ['death_animation', 3].includes(d.lastEvent?.event))) record.deathSeen = true
  if (bowl?.open && !dragon) {
    if (!record.victory && !record.preexisting) {
      if (record.dragon && (record.closed || record.deathSeen)) record.victory = { by: 'active_exit_after_observed_fight', dragon: record.dragon, participated: record.engagedDragon === record.dragon, finalBlow: 'unknown' }
      else record.preexisting = true
      return working(record.victory ? 'ドラゴン戦のあと中央の出口が開いたことを確認しました。' : '既に開いている出口を確認しました。討伐の帰属は未確認です。')
    }
    if (!same(here, bowl.rim) && !same(here, bowl.portal)) {
      await walk(ctx, center(bowl.rim))
      return working('確認済みの出口の岩盤の縁へ戻ります。')
    }
    if (life == null || !state.connectionId) return waiting('帰還前の接続と生存状態を確認します。')
    if (record.returnAttempt?.life !== life || record.returnAttempt?.connectionId !== state.connectionId) {
      record.returnAttempt = { life, connectionId: state.connectionId, sequence: ctx.memory?.lastTransition?.sequence ?? 0 }
      return working('現世への帰還を記録してから出口に入ります。')
    }
    await runtime.enterEndPortal(bowl.portal, { signal })
    return working('出口に歩いて入り、現世への転送を待ちます。')
  }
  const clouds = active.filter(isCloud)
  const danger = p => clouds.some(a => distance(a.position, p) < 6 && Math.abs(p.y - a.position.y) < 5)
  if (danger(at)) {
    const threat = clouds.find(a => distance(at, a.position) < 7)
    const targets = SIDES.map(([x,z]) => ({ x: at.x + x * 9, z: at.z + z * 9 })).sort((a,b) => distance(b, threat.position) - distance(a, threat.position))
    for (const t of targets) if (distance(t, ARENA) < Math.max(48, distance(at, ARENA) + 1) && await walk(ctx, t, p => distance(p, threat.position) < distance(at, threat.position))) break
    return working('ブレスの雲を避け、足場の続く方向へ移動します。')
  }
  if (state.health <= 12 || record.healing && state.health < 18) {
    record.healing = true
    const shelter = findShelter(getBlock, at, danger)
    if (shelter && distance(at, shelter) > 1 && await walk(ctx, shelter, danger)) return working('体力が減ったため、エンドストーンの天井がある退避場所へ移動します。')
    if (ctx.operations.food.preview().ready) await ctx.operations.food.eat()
    return waiting('島内で攻撃を中断し、体力18まで回復します。')
  }
  delete record.healing
  if (distance(at, ARENA) > 53) {
    if (await walk(ctx, ARENA)) return working('受信済みの地面を通り、島の内側へ進みます。')
    if (here.x >= 45 && Math.abs(here.z) <= 4) {
      for (const dy of [1, 0]) {
        const ahead = { x: here.x - 1, y: here.y + dy, z: here.z }
        if (await dig(ctx, ahead, 'minecraft:end_stone')) return working('到着足場から本島へ通路を掘ります。')
      }
      if (await bridge(ctx, here)) return working('本島への橋を一マス伸ばしました。足場を確認して進みます。')
    }
    return waiting('本島へ続く足場・設置材料・周囲の地形を確認しています。')
  }
  const crystals = active.filter(a => crystal(a.entityType)).sort((a, b) => distance(a.position, at) - distance(b.position, at))
  const ledger = observeSpikes(ctx, record, crystals)
  if (record.climb && record.climb.life !== life) delete record.climb
  const current = record.climb && crystals.find(a => String(a.uniqueId) === record.climb.id)
  if (record.climb && !current) record.climb.descending = true
  if (record.climb) return await openCage(ctx, record, current ?? { position: record.climb.top })
  for (const target of crystals) {
    try {
      const result = await runtime.expeditionStrike(target, 'bow', { signal })
      if (shootable(result)) return working('クリスタルを射撃し、次の受信で残りを確認します。')
    } catch (error) {
      if (!FLIGHT_BLOCKED.has(error.code)) throw error
    }
  }
  if (crystals.length) {
    const open = record.openFace, chosen = crystals.find(a => open && same(cell(a.position), open)) ?? crystals[0]
    if (!(open && same(cell(chosen.position), open)) && cage(ctx, chosen)) {
      const result = await openCage(ctx, record, chosen)
      if (result) return result
    }
    const turns = record.vantage ?? 0, pos = cell(chosen.position)
    const direction = open && same(pos, open) ? Math.atan2(open.dz, open.dx) + [0, .25, -.25][turns % 3] : Math.atan2(-pos.z, -pos.x) + (turns % 8) * Math.PI / 4
    const range = Math.max(22, Math.min(58, pos.y - at.y + 12))
    const target = { x: pos.x + Math.cos(direction)*range, z: pos.z + Math.sin(direction)*range }
    if (distance(target, ARENA) > 52 || distance(target, at) < 4 || !await walk(ctx, target, danger)) record.vantage = (turns + 1) % 24
    return working('塔の高さと開けた面に合わせ、見通しのある射撃位置を探します。')
  }
  if (!ledger.complete) {
    const pending = ledger.pending[0]
    // Approach the inner face, not the inaccessible center of the obsidian.
    const angle = Math.atan2(pending.aim.z, pending.aim.x)
    const stand = { x: pending.aim.x - Math.cos(angle)*9, z: pending.aim.z - Math.sin(angle)*9 }
    if (distance(stand, at) > 2) await walk(ctx, stand, danger)
    return waiting(`エンドクリスタル確認済み ${ledger.cleared}/10。未確認の柱の頂上と周囲を受信します。`)
  }
  if (!dragon) {
    await walk(ctx, ARENA, danger)
    return waiting('島の中央でドラゴン・クリスタル・出口の受信を確認しています。')
  }
  const perched = bowl && distance(dragon.position, ARENA) <= 5 && Math.abs(dragon.position.y - bowl.portal.y) <= 7
  const weapon = perched ? 'melee' : 'bow'
  try {
    const result = await runtime.expeditionStrike(dragon, weapon, { signal })
    if (result?.hitsRequested || result?.shotsRequested) record.engagedDragon = String(dragon.uniqueId)
    if (result?.targetDead && result.serverConfirmed) record.deathSeen = true
    if (result?.hitsRequested || result?.shotsRequested || record.deathSeen) return working(perched ? '中央に降りたドラゴンを剣で攻撃しています。' : '飛行中のドラゴンを弓で攻撃しています。')
  } catch (error) { if (!FLIGHT_BLOCKED.has(error.code)) throw error }
  const toward = perched ? dragon.position : { x: Math.cos((record.survey ?? 0) * Math.PI/4) * 24, z: Math.sin((record.survey ?? 0) * Math.PI/4) * 24 }
  if (!await walk(ctx, toward, danger)) record.survey = ((record.survey ?? 0) + 1) % 8
  return working(perched ? 'ブレスを避け、剣が届く足場へ近づきます。' : '島の内側でドラゴンの射線を取り直します。')
}

module.exports = { runDragonEndStep }
