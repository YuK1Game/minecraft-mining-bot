'use strict'

const { underCover } = require('./player-surface')
const { walkableCells } = require('./player-drops')
const { stands, clearLine } = require('./house/house-steps')
const { createHousePorts } = require('./house/house-ports')
const { bedStands } = require('./house/house-spawn')
const { active, air, cell, center, digStep, dir, distance, flat, floor, frames, intersection, localSurvey, miningTarget, navigate, read, standsAround } = require('./dragon-stronghold-navigation')

const EYE = 'minecraft:ender_eye', PEARL = 'minecraft:ender_pearl', ROD = 'minecraft:blaze_rod', POWDER = 'minecraft:blaze_powder'
const working = reason => ({ phase: 'working', reason })
const waiting = reason => ({ phase: 'waiting', reason })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const eyeActor = a => a?.entityType === 'minecraft:eye_of_ender_signal' && a.position && a.dimension === 'overworld'
const comparable = (p, q) => p && q && p.x === q.x && p.y === q.y && p.z === q.z

function createDragonStronghold (ctx) {
  const { runtime, operations, getBlock, getFeet, hands, cancelled, supplies } = ctx
  const inventory = () => ctx.shared.inventoryUncertain ? null : runtime.inventory()
  const items = () => inventory()?.items ?? []
  const bedItem = () => items().find(row => /^minecraft:(?:bed|[a-z_]+_bed)$/.test(row.name) && row.count > 0)?.name
  const count = name => items().reduce((sum, row) => sum + ((row.name === name || name === 'minecraft:bed' && row.name === bedItem()) && row.count > 0 ? row.count : 0), 0)
  const actors = () => runtime.host().entities.snapshot({ kind: 'all' })
  const ports = createHousePorts({ operations, getBlock, getInventory: inventory, disposed: cancelled })
  async function slotFor (name) {
    const find = () => items().find(i => i.name === name && i.count > 0 && i.slot <= 8)
    if (!find()) {
      const row = items().find(i => i.name === name && i.count > 0)
      if (!row || cancelled()) return null
      await operations.inventory.equip(row.slot)
    }
    return find()?.slot ?? null
  }

  async function trip (p) {
    if (!cancelled() && !operations.quarry.travelStatus().busy) await ctx.travelTo({ destination: { x: Math.round(p.x), z: Math.round(p.z) } }, { aborted: cancelled })
  }

  function trail (s) {
    const route = s.route ??= [], at = cell(getFeet())
    if (!route.length || distance(route.at(-1), at) >= 3) {
      const back = route.findIndex(p => distance(p, at) < 1.6)
      if (back >= 0) route.splice(back + 1)
      else if (route.length < 4096) route.push(at)
    }
  }

  // The projectile must first appear beside this thrower. Previously tracked
  // eyes, any item drops, and a second player's ambiguous throw are excluded.
  async function throwEye (s) {
    const pos = ctx.where(), before = new Set(actors().filter(eyeActor).map(a => a.runtimeId)), slot = await slotFor(EYE)
    if (!pos || slot == null || cancelled()) return waiting('エンダーアイと現在位置の受信を待っています。')
    if (actors().some(a => a.kind === 'player' && a.position && distance(a.position, pos) < 5)) return waiting('近くのプレイヤーから離れてアイの飛ぶ方向を測ります。')
    await operations.interactions.useDragonItem({ item: EYE, slot })
    let id = null, start = null, end = null
    for (let t = 0; t < 65 && !cancelled(); t++) {
      const seen = actors().filter(a => eyeActor(a) && !before.has(a.runtimeId))
      if (!id) {
        const nearby = seen.filter(a => distance(a.position, pos) < 4)
        if (nearby.length > 1) break
        if (nearby.length === 1) { id = nearby[0].runtimeId; start = { ...nearby[0].position } }
      }
      const current = id && seen.find(a => a.runtimeId === id)
      if (id && !current) break
      if (current) end = { ...current.position }
      await sleep(55)
    }
    if (cancelled()) return waiting('アイの観測を中断しました。')
    if (!end || !start) return waiting('投げたアイの飛行を受信できませんでした。残数を照合します。')
    const len = flat(start, end)
    if (end.y < start.y - 0.5) {
      s.surface = { x: Math.round(end.x), y: Math.floor(getFeet().y), z: Math.round(end.z) }
      s.destination = null
    } else if (len >= 3) {
      const ray = { x: start.x, z: start.z, dx: (end.x - start.x) / len, dz: (end.z - start.z) / len }
      const previous = s.rays ?? []
      const target = [...previous].reverse().map(r => intersection(r, ray)).find(Boolean)
      s.rays = [...previous.slice(-5), ray]
      s.triangulated = Boolean(target)
      const advance = target ? Math.min(320, flat(ray, target)) : 96
      s.destination = target && advance < 320 ? target : { x: Math.round(ray.x + ray.dx * advance - (target ? 0 : ray.dz * 48)), z: Math.round(ray.z + ray.dz * advance + (target ? 0 : ray.dx * 48)) }
    } else return waiting('アイの移動量が小さいため方向を再測定します。')
    const drop = actors().find(a => a.name === EYE && a.kind === 'item' && a.position && flat(a.position, end) <= 4)
    if (drop && !cancelled()) await hands.approach(drop.position, 0.8)
    return working(s.surface ? 'アイが地下へ向かう地点を確認しました。' : '飛行軌跡を記録しました。地上を進んで再測定します。')
  }

  async function pearls (s, signal) {
    const feet = getFeet()
    const drop = actors().find(a => a.kind === 'item' && a.name === PEARL && a.position && distance(a.position, feet) < 15)
    if (drop) {
      await hands.approach(drop.position, 0.9)
      return working('観測したエンダーパールを回収します。')
    }
    const mob = actors().filter(a => a.entityType === 'minecraft:enderman' && a.alive && a.position && a.dimension === 'overworld').sort((a, b) => distance(a.position, feet) - distance(b.position, feet))[0]
    const cells = [...walkableCells({ ...feet, y: feet.y + 1.62 }, getBlock).values()]
    if (mob && distance(mob.position, feet) < 40) {
      const roofs = cells.filter(p => floor(getBlock(p.x, p.y + 2, p.z)) && clearLine(getBlock, { x: p.x + 0.5, y: p.y + 1.62, z: p.z + 0.5 }, { ...mob.position, y: mob.position.y + 2.5 }, cell({ ...mob.position, y: mob.position.y + 2.5 })))
      roofs.sort((a, b) => distance(center(a), mob.position) - distance(center(b), mob.position))
      const stand = roofs[0]
      if (stand && distance(center(stand), feet) > 0.45) {
        await hands.walk(center(stand))
        return working('エンダーマンから身を守れる高さ2の通路へ移動します。')
      }
      if (stand && !cancelled()) {
        if (distance(feet, mob.position) <= 2.9) await runtime.expeditionStrike(mob, 'melee', { signal })
        else {
          const input = runtime.dragonItems.input()
          if (!input.stats().target) {
            const started = !input.stats().running
            input.lookAt({ ...mob.position, y: mob.position.y + 2.55 })
            if (started) input.start()
            try { for (let n = 0; n < 12 && !cancelled(); n++) await sleep(70) } finally { if (started && !cancelled()) input.stop() }
          }
        }
        return working('屋根の下からエンダーマンを誘い、接近した個体を剣で狙います。')
      }
    }
    // Scout accessible cave levels as well as the surface; a Realm may have
    // permanent daylight. Prefer horizontal travel in existing dark cavities.
    const anchor = s.hunt ??= { ...cell(feet), visits: {} }
    if (mob && distance(mob.position, feet) > 9 && await navigate(ctx, anchor, mob.position)) return working('受信したエンダーマンのいる通路へ向かいます。')
    const below = { x: anchor.x + 8, y: anchor.y - 14, z: anchor.z + 8 }
    if (feet.y > below.y + 1) {
      if (!await navigate(ctx, anchor, below)) await digStep(ctx, anchor, below, true)
    } else if (!await navigate(ctx, anchor, below, { explore: true })) {
      await digStep(ctx, anchor, { ...below, x: below.x + 24 }, false)
    }
    return working('高さ2の退路を残して洞窟を探索し、エンダーパールを集めます。')
  }

  async function makeEyes (record, target, signal) {
    const needed = target - count(EYE)
    if (needed <= 0) return null
    if (!count(POWDER)) {
      if (!count(ROD)) {
        const s = record.stronghold, gate = record.nether?.homeGate
        if (gate && flat(getFeet(), gate) > 24) {
          if (operations.quarry.travelStatus().busy) return working('ブレイズ素材の補給のため地上のゲートへ戻ります。')
          if (ctx.climbUp && underCover(getBlock, ctx.where())) await ctx.climbUp(cancelled)
          else await trip(gate)
          return working('ブレイズ素材の補給のため地上のゲートへ戻ります。')
        }
        if (s.surface) s.resumeSurface = true
        record.stage = 'nether'
        return working('アイに必要なブレイズ素材をネザーで追加調達します。')
      }
      await ports.craft(POWDER, Math.min(count(ROD), Math.ceil(needed / 2)))
      return working('ブレイズロッドからパウダーを作り、受信数を確認します。')
    }
    if (!count(PEARL)) return pearls(record.stronghold, signal)
    await ports.craft(EYE, Math.min(needed, count(POWDER), count(PEARL)))
    return working('パールとブレイズパウダーからエンダーアイを作ります。')
  }

  function visibleFrame (portal, feet) {
    const eye = { ...feet, y: feet.y + 1.62 }
    return frames(portal).some(f => {
      const top = { x: f.x + 0.5, y: f.y + 13 / 16 + 0.01, z: f.z + 0.5 }
      return read(getBlock, f)?.name === 'minecraft:end_portal_frame' && eye.y > top.y && distance(eye, top) < 4.5 && clearLine(getBlock, eye, top, f)
    })
  }
  async function approachPortal (s) {
    const at = getFeet(), p = s.portal
    if (distance(center(p), at) <= 8 && (s.bed && bedAlive(s.bed) || visibleFrame(p, at))) return true
    if (s.bed && bedAlive(s.bed) && distance(center(s.bed), at) <= 4 && distance(center(p), at) <= 18) return true
    if (distance(center(p), at) <= 18) {
      const cells = [...walkableCells({ ...at, y: at.y + 1.62 }, getBlock).values()]
      const candidates = cells.filter(q => flat(center(q), center(p)) >= 3 && distance(center(q), center(p)) < 8 && visibleFrame(p, center(q)))
      for (const q of candidates.sort((a, b) => distance(center(a), at) - distance(center(b), at)).slice(0, 3)) {
        if (cancelled()) return false
        if (await hands.walk(center(q))) return true
      }
    }
    if (s.surface && flat(at, s.surface) > 64) { await trip(s.surface); return false }
    if (s.route?.length) {
      const cells = walkableCells({ ...at, y: at.y + 1.62 }, getBlock)
      const target = s.route.findLast(pt => [...cells.values()].some(q => comparable(q, pt)) && distance(center(pt), at) > 1.5 && distance(center(pt), at) < 13 && distance(center(pt), p) < distance(at, p))
      if (target && await hands.walk(center(target))) return false
    }
    const goal = dir.map(([dx, dz]) => ({ x: p.x + 4 * dx, y: p.y, z: p.z + 4 * dz })).sort((a, b) => distance(a, at) - distance(b, at))[0]
    if (!await navigate(ctx, s, goal)) await digStep(ctx, s, goal, false)
    return false
  }

  async function findRoom (s) {
    const at = cell(getFeet())
    if (flat(at, s.surface) > 36 && !s.inside) { await trip(s.surface); return working('アイが沈んだ地点へ戻ります。') }
    trail(s)
    const found = localSurvey(getBlock, at)
    if (found.portal) { s.portal = found.portal; return working('12個の枠を受信し、ポータルの中心を記録しました。') }
    if (found.brick) {
      if (distance(at, found.brick) <= 2.6) s.inside = true
      if (!s.inside) {
        if (!await navigate(ctx, s, center(found.brick))) await digStep(ctx, s, found.brick, false)
        return working('受信した石レンガ構造へ近づきます。')
      }
      if (await navigate(ctx, s, at, { explore: true })) return working('要塞の通路と分岐を探索しています。')
      await digStep(ctx, s, found.brick, false)
    } else if (s.inside && await navigate(ctx, s, at, { explore: true })) return working('未探索の要塞通路へ進みます。')
    else await digStep(ctx, s, { ...s.surface, y: -61 }, true)
    return working('退路となる階段を残しながら要塞を探します。')
  }

  function bedAlive (p) {
    if (!p) return false
    const b = read(getBlock, p)
    return b?.known === true && b.name === 'minecraft:bed'
  }
  function spawnMatches (p) {
    const set = ctx.shared.lastSpawnSet
    return [0, 'player'].includes(set?.type) && [0, 'overworld'].includes(set.dimension) && set.position && distance(set.position, p) <= 3
  }
  async function prepareBed (s) {
    if (!s.bed || !bedAlive(s.bed)) {
      if (s.bed && read(getBlock, s.bed)?.known !== true) return waiting('前哨ベッドの地形を確認しています。')
      if (!count('minecraft:bed')) return working((await supplies.acquire('bed', 1)).reason)
      const at = getFeet(), nearby = [...walkableCells({ ...at, y: at.y + 1.62 }, getBlock).values()]
      const choices = nearby.filter(p => flat(center(s.portal), center(p)) >= 5 && flat(center(s.portal), center(p)) <= 12 && Math.abs(s.portal.y - p.y) <= 3 && floor(getBlock(p.x, p.y - 1, p.z)) && air(read(getBlock, p)))
      choices.sort((a, b) => distance(center(a), at) - distance(center(b), at))
      // Starting a move can take seconds. Bound each pass and resume with
      // other candidate cells instead of repeating a whole floor in one tick.
      const offset = (s.bedCursor ?? 0) % Math.max(1, choices.length)
      s.bedCursor = offset + 3
      for (const foot of choices.slice(offset, offset + 3)) for (const [dx, dz] of dir) {
        if (cancelled()) return waiting('ベッド設置を中断しました。')
        const head = { x: foot.x + dx, y: foot.y, z: foot.z + dz }
        const stand = { x: foot.x - dx + 0.5, y: foot.y, z: foot.z - dz + 0.5 }
        if (!nearby.some(p => comparable(p, cell(stand))) || !air(read(getBlock, head)) || !floor(getBlock(head.x, head.y - 1, head.z))) continue
        if (!await hands.walk(stand) || cancelled()) continue
        const plan = { position: foot, head, clicked: { ...foot, y: foot.y - 1 }, face: 1, alignFacing: true }
        if (!ports.preview(bedItem(), plan)) continue
        const ok = await ports.place(bedItem(), plan)
        if (bedAlive(foot)) { s.bed = foot; s.spawnAt = null }
        return working(ok ? '要塞に前哨ベッドを置きました。' : '前哨ベッドの設置結果を確認します。')
      }
      return waiting('ポータルと溶岩から離れた、ベッドを置ける通路を探しています。')
    }
    if (s.spawnAt && (![0, 'player'].includes(ctx.shared.lastSpawnSet?.type) || spawnMatches(s.bed))) return null
    if (operations.interactions.previewUseBed(s.bed)?.ready !== true) {
      for (const stand of bedStands(getBlock, s.bed).slice(0, 8)) {
        if (cancelled()) return waiting('前哨ベッドへの移動を中断しました。')
        if (await hands.walk(stand) && operations.interactions.previewUseBed(s.bed)?.ready === true) break
      }
    }
    if (cancelled()) return waiting('リスポーン設定を中断しました。')
    const before = Date.now()
    await operations.interactions.useBed(s.bed)
    for (let n = 0; n < 24 && !cancelled() && !(ctx.shared.lastSpawnSet?.at >= before && spawnMatches(s.bed)); n++) await sleep(150)
    if (!cancelled()) await operations.interactions.wakeBed(s.bed)
    if (ctx.shared.lastSpawnSet?.at >= before && spawnMatches(s.bed)) s.spawnAt = ctx.shared.lastSpawnSet.at
    return working('要塞のベッドを使用し、サーバーの復帰地点通知を照合しました。')
  }

  async function activate (s) {
    if (active(getBlock, s.portal)) return null
    for (const f of frames(s.portal)) {
      const block = read(getBlock, f)
      if (block?.known !== true || block.name !== 'minecraft:end_portal_frame' || ![0, false].includes(block.properties?.end_portal_eye_bit)) continue
      const slot = await slotFor(EYE)
      if (slot == null || cancelled()) return waiting('空の枠に入れるアイの到着を待っています。')
      const target = { ...f, y: f.y + 13 / 16 }
      const visible = () => {
        const p = ctx.where()
        return p && p.y > target.y && distance(p, { ...target, x: f.x + 0.5, z: f.z + 0.5 }) < 4.4 && clearLine(getBlock, p, { x: f.x + 0.5, y: target.y + 0.02, z: f.z + 0.5 }, f)
      }
      if (!visible()) {
        const click = { clicked: f, face: 1 }
        for (const stand of stands(getBlock, { position: f }, click, getFeet()).filter(p => flat(p, center(s.portal)) >= 2.6).slice(0, 4)) {
          if (cancelled()) return waiting('ポータル枠への移動を中断しました。')
          if (await hands.walk(stand) && visible()) break
        }
      }
      if (!visible() || cancelled()) continue
      await operations.interactions.useDragonItem({ item: EYE, slot, position: f })
      for (let n = 0; n < 12 && !cancelled() && [0, false].includes(read(getBlock, f)?.properties?.end_portal_eye_bit); n++) await sleep(150)
      return working('1枠にアイを入れ、枠とポータル面の受信を照合します。')
    }
    return waiting('ポータル枠と起動した9マスの受信を待っています。')
  }

  async function step (record, { signal } = {}) {
    const s = record.stronghold ??= {}
    const inv = inventory()
    if (runtime.raw().dimension !== 'overworld' || cancelled() || inv?.known !== true || inv.uncertain || !getFeet()) return waiting('現世の位置・持ち物の受信を待っています。')
    if (!s.departed) {
      const made = await makeEyes(record, 20, signal)
      if (made) return made
      for (const [name, need] of [['minecraft:bed', 1], ['minecraft:chest', 2]]) if (count(name) < need) return working((await supplies.acquire(name, need)).reason)
      const combat = await supplies.prepare('end')
      if (!combat.done) return working(combat.reason)
      const spare = await supplies.prepare('reserve-end')
      if (!spare.done) return working(spare.reason)
      s.departed = true
      return working('アイ20個・ベッド・ラージチェストの材料・戦闘装備と復帰用品をそろえました。')
    }
    if (operations.quarry.travelStatus().busy) return working('記録した目的地まで地上を移動しています。')
    if (s.resumeSurface && s.surface) {
      if (flat(getFeet(), s.surface) > 24) { await trip(s.surface); return working('補給を終え、記録した要塞入口へ戻っています。') }
      s.resumeSurface = false
    }
    if (!s.portal && !s.surface) {
      if (count(EYE) <= 12) {
        const made = await makeEyes(record, 16, signal)
        if (made) return made
      }
      if (ctx.climbUp && underCover(getBlock, ctx.where())) { await ctx.climbUp(cancelled); return working('投げたアイと進行方向を確認できる地上へ出ます。') }
      if (s.triangulated && s.destination && flat(getFeet(), s.destination) <= 24 && flat(getFeet(), s.destination) > 5) {
        if (await hands.approach(s.destination, 4)) return working('推定地点の近くでアイの高さを再測定します。')
      }
      if (s.destination && flat(getFeet(), s.destination) > 20) { await trip(s.destination); return working('アイの示した方向へ移動します。') }
      return throwEye(s)
    }
    if (!s.portal) return findRoom(s)
    if (!await approachPortal(s)) return working('記録した道を使ってポータルの部屋へ近づきます。')
    const spawner = dir.flatMap(([dx, dz]) => [3, 4, 5, 6, 7].flatMap(d => [0, 1, -1].map(dy => ({ x: s.portal.x + dx * d, y: s.portal.y + dy, z: s.portal.z + dz * d })))).find(p => read(getBlock, p)?.name === 'minecraft:mob_spawner')
    if (spawner) {
      if (!await hands.pick() || cancelled()) return waiting('スポナーを撤去するツルハシを確認しています。')
      const target = miningTarget(spawner, read(getBlock, spawner))
      if (!hands.canMine(target)) {
        const near = standsAround(ctx, center(spawner), 1, 3).find(p => distance(center(p), getFeet()) > 0.45)
        if (near) await hands.walk(center(near))
      } else await hands.mine(target)
      return working('ポータル部屋のシルバーフィッシュスポナーを撤去します。')
    }
    const bed = await prepareBed(s)
    if (bed) return bed
    if (!s.outpostChest || read(getBlock, s.outpostChest)?.known === true && read(getBlock, s.outpostChest).name !== 'minecraft:chest') {
      const choices = bedStands(getBlock, s.bed)
      if (distance(getFeet(), center(s.bed)) > 3.5 && choices[0]) { await hands.walk(choices[0]); return working('ベッド脇の備蓄場所へ移動します。') }
      const p = await ctx.storage.chest({ aborted: cancelled, avoid: [s.bed, ...frames(s.portal)] })
      if (p) { s.outpostChest = p; s.reserve = false }
      return working('前哨ラージチェストを設置し、54枠の受信を確認します。')
    }
    if (!s.reserve) {
      const result = await supplies.reserve(s.outpostChest, { mode: 'stock', kit: 'end', aborted: cancelled, signal })
      if (result.done) s.reserve = true
      if (!result.done && result.missing && !cancelled()) return working((await supplies.acquire(result.missing.name, result.missing.count)).reason)
      return working(result.reason)
    }
    if (!active(getBlock, s.portal)) {
      const needed = frames(s.portal).filter(f => [false, 0].includes(read(getBlock, f)?.properties?.end_portal_eye_bit)).length
      if (count(EYE) < needed) return (await makeEyes(record, needed, signal)) ?? waiting('枠の状態を確認しています。')
      return activate(s)
    }
    const battle = await supplies.prepare('end')
    if (!battle.done) return working(battle.reason)
    return { ready: true, phase: 'working', reason: '前哨ベッド・予備装備・起動済みポータルを確認しました。' }
  }

  async function enter (record, { signal } = {}) {
    const s = record.stronghold
    if (!s?.prepared || !s.portal || runtime.raw().dimension !== 'overworld' || cancelled() || !getFeet()) return waiting('エンド入場の準備・次元を確認しています。')
    if (!await approachPortal(s)) return working('要塞のポータルへ戻ります。')
    if (!active(getBlock, s.portal)) return waiting('起動済みポータルの9マスを再確認しています。')
    const at = getFeet()
    if (flat(at, center(s.portal)) > 8) {
      await navigate(ctx, s, center(s.portal))
      return working('前哨からポータルの縁へ近づきます。')
    }
    const edges = dir.map(([dx, dz]) => ({
      outer: { x: s.portal.x + 3 * dx, y: s.portal.y, z: s.portal.z + 3 * dz },
      rim: { x: s.portal.x + 2 * dx, y: s.portal.y, z: s.portal.z + 2 * dz },
      hole: { x: s.portal.x + dx, y: s.portal.y, z: s.portal.z + dz }
    })).sort((a, b) => distance(center(a.outer), at) - distance(center(b.outer), at))
    for (const { outer, rim, hole } of edges) {
      if (cancelled()) break
      const feet = getFeet(), onRim = flat(feet, center(rim)) <= 0.5
      if (!onRim) {
        const y = [outer.y + 1, outer.y].find(y => floor(getBlock(outer.x, y - 1, outer.z)) && air(getBlock(outer.x, y, outer.z)) && air(getBlock(outer.x, y + 1, outer.z)))
        if (y === undefined) continue
        const stand = center({ ...outer, y })
        if (distance(feet, stand) > 0.45 && !await hands.walk(stand)) continue
      }
      if (!cancelled() && active(getBlock, s.portal)) await runtime.enterEndPortal(hole, { signal })
      return working('要塞のポータルに進み、エンドへの次元変更を待っています。')
    }
    return waiting('起動した面に隣接する安全な足場へ移動します。')
  }

  return { step, enter }
}

module.exports = { createDragonStronghold }
