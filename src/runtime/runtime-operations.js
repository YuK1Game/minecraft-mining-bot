'use strict'

// Moved out of runtime.js unchanged by scripts/extract-runtime-block.js.
// `rt` exposes the bindings of that closure this code uses; each read or write
// of rt.<name> reads or writes the closure's own variable at that moment.
// Modules are loaded through rt.require, the require of runtime.js.

function createRuntimeOperations (rt) {
  const operations = {
    loadout: { preview: input => { rt.requireIdle({ loadoutHandoff: true }); return rt.ensureLoadoutReset().prepare({ area: rt.normalizeChunkArea(input?.area) }) },
      start: input => { rt.requireIdle({ loadoutHandoff: true }); return rt.ensureLoadoutReset().start({ ...input, area: rt.normalizeChunkArea(input?.area) }) },
      status: () => rt.loadoutReset?.status() ?? { busy: false, phase: 'idle' }, cancel: () => rt.loadoutReset?.cancel() ?? { busy: false, phase: 'idle' } },
    shulkerRecovery: {
      load: id => rt.loadManualShulkerRecovery(id),
      run: () => rt.runManualShulkerRecovery(),
      status: () => ({ ...(rt.manualShulkerRecovery?.snapshot() ?? { busy: false }), document: structuredClone(rt.manualShulkerDocument) }),
      cancel: reason => { rt.manualShulkerAbort?.abort(new Error(reason ?? 'MANUAL_STOP')); rt.manualShulkerRecovery?.cancel(reason ?? 'MANUAL_STOP'); return rt.manualShulkerTask ?? Promise.resolve(rt.manualShulkerRecovery?.snapshot() ?? { busy: false }) }
    },
    quarry: {
      moveToChunk: input => rt.ensureChunkTravel().start({ area: rt.normalizeChunkArea(input?.area) }),
      // Long-distance travel (2026-11-14): repeated chunk-travel legs toward a far
      // destination; never while quarry work runs. Continues saved progress.
      travelTo: async input => {
        if (rt.quarryJob?.holdsWork()) throw new Error('露天掘りの作業中です。/quarry pause で一時停止してから操作してください。')
        const d = input?.destination
        if (!d || ![d.x, d.z].every(Number.isFinite)) throw new Error('目的地 {x, z} を指定してください。')
        let resume = null
        try { const prior = JSON.parse(await rt.require('node:fs/promises').readFile(rt.travelRuntime.longTravelFile(), 'utf8')); if (prior?.destination && Math.hypot(prior.destination.x - d.x, prior.destination.z - d.z) < 1 && prior.phase !== 'arrived') resume = prior } catch {}
        return rt.ensureLongTravel().start({ destination: { x: d.x, y: d.y, z: d.z }, resume })
      },
      travelStatus: () => rt.travelRuntime.longTravel?.status() ?? { busy: false, phase: 'idle' },
      // Last resort out of a cave (2026-11-14, decision relay): a staircase dug
      // up by ordinary mining until the stand sees the sky. Each step clears the
      // two cells ahead one block up and the cell over the head, then steps up.
      // Never under lava/water/gravel/sand; bounded per block and in total.
      digUp: async (input = {}) => {
        if (rt.quarryJob?.holdsWork()) throw new Error('露天掘りの作業中です。')
        const maxMs = Math.min(45 * 60000, input.maxMs ?? 30 * 60000), started = Date.now()
        const get = (x, y, z) => rt.host.world.getBlock(x, y, z)
        const nm = b => String(b?.name ?? '')
        const air = b => b?.known === true && (b.boundingBox === 'empty' || /^minecraft:(?:air|cave_air)$/.test(nm(b))) && !/water|lava/.test(nm(b))
        const solid = b => b?.known === true && b.boundingBox === 'block' && !/water|lava/.test(nm(b))
        const danger = b => !b || b.known !== true || /lava|water|gravel|sand|bedrock|obsidian/.test(nm(b))
        const skyOpen = (x, y, z) => { for (let yy = y + 2; yy < 320; yy++) { const b = get(x, yy, z); if (!b || b.known !== true) { if (yy >= 128) return true; return false } if (b.boundingBox === 'block' && !/leaves|log|wood/.test(nm(b))) return false } return true }
        const mineCell = async c => {
          if (air(get(c.x, c.y, c.z))) return true
          operations.mining.start([{ x: c.x, y: c.y, z: c.z }])
          const until = Date.now() + 35000
          while (!air(get(c.x, c.y, c.z))) { if (Date.now() > until) return false; await new Promise(r => setTimeout(r, 250)) }
          return true
        }
        let steps = 0
        const prefer = input.heading ?? null
        while (Date.now() - started < maxMs) {
          const st = rt.working(); if (!st.position || st.dead) { await new Promise(r => setTimeout(r, 1000)); continue }
          const fx = Math.floor(st.position.x), fy = Math.floor(st.position.y - 1.62 + 0.2), fz = Math.floor(st.position.z)
          if (skyOpen(fx, fy, fz)) { rt.host.log(`地上へ出ました: (${fx},${fy},${fz})・${steps}段`); return { surfaced: true, steps, position: { x: fx, y: fy, z: fz } } }
          const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]]
          if (prefer) dirs.sort((a, b) => (b[0] * prefer.x + b[1] * prefer.z) - (a[0] * prefer.x + a[1] * prefer.z))
          let done = false
          for (const [dx, dz] of dirs) {
            const nx = fx + dx, nz = fz + dz, floor = get(nx, fy, nz)
            const cells = [{ x: fx, y: fy + 2, z: fz }, { x: nx, y: fy + 1, z: nz }, { x: nx, y: fy + 2, z: nz }]
            if (!solid(floor)) continue
            if (cells.some(c => danger(get(c.x, c.y, c.z)) && !air(get(c.x, c.y, c.z))) || danger(get(nx, fy + 3, nz)) && !air(get(nx, fy + 3, nz)) || danger(get(fx, fy + 3, fz)) && !air(get(fx, fy + 3, fz))) continue
            let ok = true
            for (const c of cells) { if (!(await mineCell(c))) { ok = false; break } }
            if (!ok) continue
            try { rt.startMotion('navigation', { x: nx + 0.5, y: fy + 1, z: nz + 0.5 }, { allowLowHealth: true, maxDistance: 3 }) } catch {}
            const until = Date.now() + 6000
            while (Date.now() < until) { await new Promise(r => setTimeout(r, 250)); const p = rt.working().position; if (p && Math.floor(p.x) === nx && Math.floor(p.z) === nz && Math.abs(p.y - 1.62 - (fy + 1)) < 0.6) break }
            const p = rt.working().position
            if (p && Math.floor(p.x) === nx && Math.floor(p.z) === nz) { steps++; if (steps % 5 === 1) rt.host.log(`掘り上がり: ${steps}段目 (${nx},${fy + 1},${nz})`); done = true; break }
          }
          if (!done) { rt.host.log('掘り上がり: どの方向にも段を作れませんでした'); return { surfaced: false, steps, reason: 'NO_STEP' } }
        }
        return { surfaced: false, steps, reason: 'TIME_LIMIT' }
      },
      // Long-trip preparation without the legacy autonomy (2026-11-14 decision):
      // hunt food animals and eat while hunger is below 18, then cut logs from
      // received trees by ordinary mining and pick the drops up. Every result is
      // the received inventory change. Logs only (never leaves); shooters are
      // still avoided by the combat rules for empty hands.
      prepGather: async (input = {}) => {
        if (rt.quarryJob?.holdsWork()) throw new Error('露天掘りの作業中です。')
        const logTarget = Math.max(0, Math.min(10, input.logs ?? 10))
        // logs: 0 is the food step alone (eat, or hunt within 24 m); no wood is taken.
        if (logTarget > 0 && !rt.longTravelLogAllowance()) throw new Error('先に prepareLongTravel({gather:false}) で準備の許可を出してください。')
        const started = Date.now(), maxMs = Math.min(40 * 60000, input.maxMs ?? 20 * 60000)
        const say = m => rt.host.log(`長距離移動の準備: ${m}`)
        const items = () => rt.working().inventory?.items ?? []
        const count = re => items().filter(i => re.test(i.name ?? '')).reduce((n, i) => n + (i.count ?? 0), 0)
        const LOGS = /^minecraft:[a-z_]+_(?:log|stem)$/, FOOD = /^minecraft:(?:cooked_)?(?:beef|porkchop|mutton|chicken|rabbit)$|^minecraft:(?:bread|apple|carrot|baked_potato)$/
        const hunger = () => { const v = rt.host.shared.vitals?.hunger; return Number.isFinite(v) ? v : Number.isFinite(v?.value) ? v.value : null }
        const feetOf = () => { const p = rt.working().position; return p ? { x: p.x, y: p.y - 1.62, z: p.z } : null }
        const sleep = ms => new Promise(r => setTimeout(r, ms))
        const wait = async (fn, ms) => { const until = Date.now() + ms; while (Date.now() < until) { if (fn()) return true; await sleep(200) } return fn() }
        // Walk next to a point by the ordinary local movement (radius 1-2, heights -2..+2).
        const walkNear = async (pos, radii = [1, 2]) => {
          const opts = { allowWater: true, allowLowHealth: true, maxDistance: 16 }
          const here = feetOf(); if (!here) return false
          if (Math.hypot(pos.x - here.x, pos.z - here.z) <= 2.2 && Math.abs(pos.y - here.y) <= 2.5) return true
          const cands = []
          for (const r of radii) for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) if (Math.max(Math.abs(dx), Math.abs(dz)) === r) for (const dy of [0, -1, 1, -2, 2]) cands.push({ x: Math.floor(pos.x) + dx + 0.5, y: Math.floor(pos.y) + dy, z: Math.floor(pos.z) + dz + 0.5 })
          cands.sort((a, b) => Math.hypot(a.x - here.x, a.z - here.z) - Math.hypot(b.x - here.x, b.z - here.z))
          // Live 15:14: forty back-to-back previews stalled the event loop for 24 s
          // and the server closed the connection. Yield after each preview and
          // stop planning after two seconds.
          const planUntil = Date.now() + 2000
          for (const t of cands.slice(0, 40)) {
            if (Date.now() > planUntil) return false
            let pv = null; try { rt.motionOrigin = rt.working(); pv = rt.movement?.preview(t, opts) } catch {}
            await new Promise(resolve => setImmediate(resolve))
            if (pv?.ready !== true) continue
            try { rt.requireIdle({ inventoryRequired: false }); rt.startMotion('navigation', t, opts) } catch { return false }
            await wait(() => { const m = rt.movement?.snapshot() ?? {}; return !['moving', 'settling'].includes(m.phase) }, 20000)
            const f = feetOf(); return !!f && Math.hypot(t.x - f.x, t.z - f.z) <= 1.5
          }
          return false
        }
        const pickup = async center => {
          const drops = rt.allActors().filter(a => a?.kind === 'item' && a.position && Math.hypot(a.position.x - center.x, a.position.z - center.z) <= 5)
          for (const d of drops.slice(0, 4)) await walkNear(d.position, [0, 1])
          await sleep(800)
        }
        let hunts = 0, logsTried = 0, eatRefused = false, rottenTried = false
        const woolTarget = Math.max(0, Math.min(3, input.wool ?? 0)), WOOL = /^minecraft:[a-z_]*wool$/
        const foodTarget = Math.max(0, Math.min(16, input.food ?? 0))
        const skipLog = new Set() // logs that could not be reached or mined are not tried again
        while (Date.now() - started < maxMs) {
          const st = rt.working(); if (!st.position || st.dead) { await sleep(1000); continue }
          // 1. food first while hunger is below 18
          if ((hunger() ?? 20) < 18) {
            // Live 15:04: a raw chicken matched FOOD but the eat check refused it
            // and the step looped. One refusal ends eating here (emergency rotten
            // flesh is tried once); the step goes on to hunting.
            if (!eatRefused && count(FOOD) > 0) { try { await operations.food.eat({}); say(`食べました（満腹度 ${hunger()}）`); continue } catch (e) { eatRefused = true; say(`食事を見送り: ${String(e.message ?? e).slice(0, 60)}`) } }
            if (!rottenTried && count(/^minecraft:rotten_flesh$/) > 0) { rottenTried = true; try { await operations.food.eat({ allowEmergencyRotten: true }); say(`非常食として腐った肉を食べました（満腹度 ${hunger()}）`); continue } catch {} }
            const feet = feetOf()
            const animal = rt.allActors().filter(a => a?.kind === 'mob' && a.hostile === false && /^minecraft:(?:cow|pig|sheep|chicken)$/.test(a.entityType ?? '') && a.alive !== false && a.position && a.baby !== true && a.isBaby !== true && Math.hypot(a.position.x - feet.x, a.position.z - feet.z) <= 24).sort((a, b) => Math.hypot(a.position.x - feet.x, a.position.z - feet.z) - Math.hypot(b.position.x - feet.x, b.position.z - feet.z))[0]
            if (animal && hunts < 12) {
              hunts++
              const before = count(FOOD)
              if (await walkNear(animal.position, [1])) {
                for (let hit = 0; hit < 6; hit++) { try { await rt.combat.animalAttack(animal.runtimeId, {}) } catch { break } await sleep(500); if (!rt.allActors().some(a => String(a.runtimeId) === String(animal.runtimeId) && a.alive !== false)) break }
                await pickup(animal.position)
              }
              if (count(FOOD) > before) say(`食料を得ました（${count(FOOD)}個）`)
              continue
            }
          }
          // 1a. a food stock before a long trip (coordinator 2026-11-14: 5-10)
          if (foodTarget && count(FOOD) < foodTarget && hunts < 24) {
            const feet = feetOf()
            const animal = rt.allActors().filter(a => a?.kind === 'mob' && a.hostile === false && /^minecraft:(?:cow|pig|sheep|chicken|rabbit)$/.test(a.entityType ?? '') && a.alive !== false && a.position && a.baby !== true && a.isBaby !== true && Math.hypot(a.position.x - feet.x, a.position.z - feet.z) <= 32).sort((a, b) => Math.hypot(a.position.x - feet.x, a.position.z - feet.z) - Math.hypot(b.position.x - feet.x, b.position.z - feet.z))[0]
            if (animal) {
              hunts++
              const before = count(FOOD)
              if (await walkNear(animal.position, [1])) {
                for (let hit = 0; hit < 6; hit++) { try { await rt.combat.animalAttack(animal.runtimeId, {}) } catch { break } await sleep(500); if (!rt.allActors().some(a => String(a.runtimeId) === String(animal.runtimeId) && a.alive !== false)) break }
                await pickup(animal.position)
              }
              if (count(FOOD) > before) say(`食料を得ました（${count(FOOD)}個）`)
              continue
            }
          }
          // 1b. wool from sheep for a respawn bed (coordinator 2026-11-14)
          if (woolTarget && count(WOOL) < woolTarget && hunts < 12) {
            const feet = feetOf()
            const sheep = rt.allActors().filter(a => a?.kind === 'mob' && a.hostile === false && a.entityType === 'minecraft:sheep' && a.alive !== false && a.position && a.baby !== true && a.isBaby !== true && Math.hypot(a.position.x - feet.x, a.position.z - feet.z) <= 24).sort((a, b) => Math.hypot(a.position.x - feet.x, a.position.z - feet.z) - Math.hypot(b.position.x - feet.x, b.position.z - feet.z))[0]
            if (sheep) {
              hunts++
              const before = count(WOOL)
              if (await walkNear(sheep.position, [1])) {
                for (let hit = 0; hit < 6; hit++) { try { await rt.combat.animalAttack(sheep.runtimeId, {}) } catch { break } await sleep(500); if (!rt.allActors().some(a => String(a.runtimeId) === String(sheep.runtimeId) && a.alive !== false)) break }
                await pickup(sheep.position)
              }
              if (count(WOOL) > before) say(`羊毛を得ました（${count(WOOL)}個）`)
              continue
            }
          }
          // 2. logs
          const logs = count(LOGS)
          if (logs >= logTarget) { if (logTarget > 0) say(`原木 ${logs} 本を持っています`); return { done: true, logs, food: count(FOOD), hunger: hunger() } }
          if (logsTried > 40) break
          const feet = feetOf(), known = []
          for (let dx = -24; dx <= 24; dx++) for (let dz = -24; dz <= 24; dz++) for (let dy = -6; dy <= 12; dy++) {
            const x = Math.floor(feet.x) + dx, y = Math.floor(feet.y) + dy, z = Math.floor(feet.z) + dz
            const b = rt.host.world.getBlock(x, y, z)
            if (b?.known === true && LOGS.test(b.name ?? '')) known.push({ x, y, z, d: Math.hypot(dx, dz) + Math.abs(dy) * 0.5 })
          }
          known.sort((a, b) => a.d - b.d)
          const trunkLow = t => { for (let y = t.y - 1; y >= t.y - 3; y--) { const b = rt.host.world.getBlock(t.x, y, t.z); if (b?.known !== true) return false; if (LOGS.test(b.name ?? '')) continue; return b.boundingBox === 'block' && !/leaves/.test(b.name ?? '') } return false }
          const target = known.find(t => trunkLow(t) && !skipLog.has(`${t.x},${t.y},${t.z}`))
          if (!target) { say('近くに届く原木が見つかりません'); break }
          logsTried++
          if (!(await walkNear(target, [1, 2]))) { skipLog.add(`${target.x},${target.y},${target.z}`); say(`原木 (${target.x},${target.y},${target.z}) の隣へ歩けません（この原木は飛ばします）`); continue }
          const before = count(LOGS)
          try { operations.mining.start([{ x: target.x, y: target.y, z: target.z }]) } catch (e) { skipLog.add(`${target.x},${target.y},${target.z}`); say(`採掘を開始できません: ${String(e.message ?? e).slice(0, 60)}`); await sleep(1000); continue }
          const broken = await wait(() => { const b = rt.host.world.getBlock(target.x, target.y, target.z); return b?.known === true && !LOGS.test(b.name ?? '') }, 35000)
          if (!broken) { skipLog.add(`${target.x},${target.y},${target.z}`); say('原木を壊せませんでした'); continue }
          await pickup(target)
          if (count(LOGS) > before) say(`原木 ${count(LOGS)} 本`)
        }
        return { done: false, logs: count(LOGS), food: count(FOOD), hunger: hunger(), reason: Date.now() - started >= maxMs ? 'TIME_LIMIT' : 'NO_TARGET' }
      },
      // Read-only request: the terrain above the bot (its chunk and the eight
      // around it) up to y=120, to find the way back to open sky from a cave.
      // Pick up received item drops near a point by ordinary walking (2026-11-14:
      // the preparation items dropped at a death). Success is the received
      // inventory growing; the drop vanishing alone is not counted.
      pickupNear: async (input = {}) => {
        if (rt.quarryJob?.holdsWork()) throw new Error('露天掘りの作業中です。')
        const center = input.center, radius = Math.min(32, input.radius ?? 16), maxMs = Math.min(600000, input.maxMs ?? 180000), started = Date.now()
        if (!center || ![center.x, center.z].every(Number.isFinite)) throw new Error('center {x, z} を指定してください。')
        const sleep = ms => new Promise(r => setTimeout(r, ms))
        const feetOf = () => { const q = rt.working().position; return q ? { x: q.x, y: q.y - 1.62, z: q.z } : null }
        const total = () => (rt.working().inventory?.items ?? []).reduce((n, i) => n + (i.count ?? 0), 0)
        const before = total(), skip = new Set()
        const opts = { allowWater: true, allowLowHealth: true, maxDistance: 16 }
        while (Date.now() - started < maxMs) {
          const here = feetOf(); if (!here) { await sleep(500); continue }
          const drop = rt.allActors().filter(a => a?.kind === 'item' && a.position && !skip.has(String(a.runtimeId)) && Math.hypot(a.position.x - center.x, a.position.z - center.z) <= radius).sort((a, b) => Math.hypot(a.position.x - here.x, a.position.z - here.z) - Math.hypot(b.position.x - here.x, b.position.z - here.z))[0]
          if (!drop) break
          const t = { x: Math.floor(drop.position.x) + 0.5, y: Math.floor(drop.position.y + 0.01), z: Math.floor(drop.position.z) + 0.5 }
          let moved = false
          for (const dy of [0, 1, -1]) {
            let pv = null; try { rt.motionOrigin = rt.working(); pv = rt.movement?.preview({ ...t, y: t.y + dy }, opts) } catch {}
            if (pv?.ready !== true) continue
            try { rt.requireIdle({ inventoryRequired: false }); rt.startMotion('navigation', { ...t, y: t.y + dy }, opts); moved = true } catch {}
            break
          }
          if (!moved) { skip.add(String(drop.runtimeId)); continue }
          const until = Date.now() + 20000
          while (Date.now() < until) { const m = rt.movement?.snapshot() ?? {}; if (!['moving', 'settling'].includes(m.phase)) break; await sleep(200) }
          await sleep(600)
          if (rt.allActors().some(a => String(a.runtimeId) === String(drop.runtimeId))) skip.add(String(drop.runtimeId))
        }
        const gained = total() - before
        rt.host.log(`拾得: 受信した持ち物が ${gained} 個増えました`)
        return { gained, items: total(), skipped: skip.size }
      },
      // One canopy-escape pass outside a trip (same rules as during long travel).
      leafEscape: async () => { if (rt.quarryJob?.holdsWork()) throw new Error('露天掘りの作業中です。'); if (rt.travelRuntime.longTravel?.status?.().busy) throw new Error('長距離移動の途中です。'); return rt.travelLeafEscape(null) },
      // Read-only: the route the trip itself would plan from here (same options).
      travelDebug: (input = {}) => {
        const st = rt.working(); if (!st.position) throw new Error('位置が不明です。')
        const feet = { x: st.position.x, y: st.position.y - 1.62, z: st.position.z }, d = input.destination ?? { x: 1968, z: -2041 }
        const bad = rt.host.shared.longTravelBadCells
        const r = rt.require('./travel/coarse-route').planCoarseRoute({ getBlock: (x, y, z) => rt.host.world.getBlock(x, y, z), start: feet, goal: d, maxNodes: 60000, maxMs: input.maxMs ?? 400, allowDig: true, maxDrop: 1, surfaceOnly: true, blocked: bad ?? new Set(), faceStairs: input.faceStairs === true })
        const firstDig = r.ready ? r.path.findIndex(q => q.dig) : -1
        const previews = [12, 9, 6, 4, 3, 2, 1].map(a => { const q = r.path[Math.min(firstDig > 0 ? Math.min(a, firstDig - 1) : a, r.path.length - 1)]; if (!q) return null; let pv = null; try { rt.motionOrigin = rt.working(); pv = rt.movement?.preview({ x: q.x, y: q.y, z: q.z }, { allowWater: true, allowLowHealth: true, maxDistance: 16 }) } catch (e) { pv = { ready: false, reason: e.message } } return { a, q, ready: pv?.ready === true, reason: pv?.reason ?? null } })
        return { bad: bad?.size ?? 0, ready: r.ready, reached: r.reached, timedOut: r.timedOut, expanded: r.expanded, length: r.path.length, firstDig, firstSteps: r.path.slice(0, 6), previews }
      },
      // Kit before a long trip (coordinator 2026-11-14, after three deaths near
      // spawn): wool for a bed, a food stock, logs; then planks, sticks, a table,
      // a wooden sword, a bed and a boat. Results are the received inventory.
      prepKit: async (input = {}) => {
        if (rt.quarryJob?.holdsWork()) throw new Error('露天掘りの作業中です。')
        if (rt.travelRuntime.longTravel?.status?.().busy) throw new Error('長距離移動の途中です。')
        const say = m => rt.host.log(`長距離移動の準備: ${m}`)
        const items = () => rt.working().inventory?.items ?? []
        const count = re => items().filter(i => re.test(i.name ?? '')).reduce((n, i) => n + (i.count ?? 0), 0)
        if (!rt.longTravelLogAllowance()) await operations.quarry.prepareLongTravel({ logCount: 10, gather: false })
        const has = re => count(re) > 0
        const foodWanted = Math.max(5, Math.min(10, input.food ?? 6))
        const FOODS = /^minecraft:(?:cooked_)?(?:beef|porkchop|mutton|chicken|rabbit)$|^minecraft:(?:bread|apple|carrot|baked_potato)$/
        const LOGS0 = /^minecraft:[a-z_]+_(?:log|stem)$/
        // Planks the remaining items need (live 19:25: the last logs went into the
        // sword and boat and the bed was never crafted): table 4, sticks 2,
        // sword 2, bed 3, boat 5.
        const planksNeeded = () => (has(/^minecraft:crafting_table$/) ? 0 : 4) + (has(/_sword$/) ? 0 : 2 + (has(/^minecraft:stick$/) ? 0 : 2)) + (has(/^minecraft:bed$/) ? 0 : 3) + (has(/_boat$/) ? 0 : 5)
        const woodHeld = () => count(/^minecraft:[a-z_]+_planks$/) + count(LOGS0) * 4
        const missing = () => [!has(/^minecraft:bed$/) && count(/wool$/) < 3 ? 'wool' : null, count(FOODS) < foodWanted ? 'food' : null, woodHeld() < planksNeeded() ? 'logs' : null].filter(Boolean)
        // Live 18:52: right after a reconnect nothing was in sight and the kit
        // ended at once. Gather, and while something is missing walk about 48 m
        // to another spot (six rounds, turning 60 degrees) and gather again.
        const origin = rt.working().position ? { x: rt.working().position.x, z: rt.working().position.z } : null
        for (let round = 0; round < 7 && origin; round++) {
          if (!rt.longTravelLogAllowance()) await operations.quarry.prepareLongTravel({ logCount: 10, gather: false }) // live 20:01: the 30-minute allowance ran out mid-kit
          if (missing().includes('wool')) await operations.quarry.prepGather({ logs: 0, wool: 3, maxMs: 120000 })
          if (missing().includes('food')) await operations.quarry.prepGather({ logs: 0, food: foodWanted, maxMs: 180000 })
          if (missing().includes('logs')) await operations.quarry.prepGather({ logs: Math.min(10, count(LOGS0) + Math.ceil((planksNeeded() - woodHeld()) / 4)), maxMs: 180000 })
          if (!missing().length || round === 6) break
          const ang = round * Math.PI / 3
          let dest = { x: Math.round(origin.x + Math.cos(ang) * 48), z: Math.round(origin.z + Math.sin(ang) * 48) }
          // Logs missing (live 19:46: six rounds found none while trees were
          // known to the west): head for the nearest received log within 64 m.
          if (missing().includes('logs')) {
            const here = rt.working().position, hx = Math.floor(here.x), hy = Math.floor(here.y - 1.62), hz = Math.floor(here.z)
            let best = null
            for (let dx = -64; dx <= 64; dx += 2) for (let dz = -64; dz <= 64; dz += 2) {
              const d = Math.hypot(dx, dz); if (d < 20 || best && d >= best.d) continue
              for (let dy = -8; dy <= 16; dy++) { const b = rt.host.world.getBlock(hx + dx, hy + dy, hz + dz); if (b?.known === true && LOGS0.test(b.name ?? '')) { best = { x: hx + dx, z: hz + dz, d }; break } }
              if ((dz & 15) === 0) await new Promise(resolve => setImmediate(resolve))
            }
            if (best) dest = { x: best.x, z: best.z }
          }
          say(`まだ足りません（${missing().join('・')}）。(${dest.x}, ${dest.z}) へ探しに行きます`)
          try { await operations.quarry.travelTo({ destination: dest }) } catch {}
          const until = Date.now() + 180000
          while (Date.now() < until && rt.travelRuntime.longTravel?.status?.().busy) await new Promise(r => setTimeout(r, 1000))
          if (rt.travelRuntime.longTravel?.status?.().busy) { try { await rt.travelRuntime.longTravel.cancel('KIT_EXPLORE') } catch {} }
        }
        const LOGS = /^minecraft:([a-z_]+)_log$/, PLANKS = /^minecraft:([a-z_]+)_planks$/
        const log = items().filter(i => LOGS.test(i.name ?? '')).sort((a, b) => b.count - a.count)[0]
        const made = []
        if (log || count(PLANKS) >= 4) {
          await rt.crafting.openInventory()
          try {
            if (log) { await rt.crafting.craft(`minecraft:${LOGS.exec(log.name)[1]}_planks`, { times: log.count }); made.push('planks') }
            if (!has(/^minecraft:stick$/)) { await rt.crafting.craft('minecraft:stick', { times: 1 }); made.push('stick') }
            if (!has(/^minecraft:crafting_table$/)) { await rt.crafting.craft('minecraft:crafting_table', { times: 1 }); made.push('table') }
          } finally { try { rt.crafting.closeContainer() } catch {} }
          const table = await rt.travelPlaceTable()
          if (table) {
            await rt.interactions.openCraftingTable(table)
            try {
              if (!has(/_sword$/)) { await rt.crafting.craft('minecraft:wooden_sword', { times: 1 }); made.push('wooden_sword') }
              if (!has(/^minecraft:bed$/) && count(/wool$/) >= 3) { try { await rt.crafting.craft('minecraft:bed', { times: 1 }); made.push('bed') } catch (e) { say(`ベッドを作れません: ${String(e.message ?? e).slice(0, 60)}`) } }
              if (!has(/_boat$/)) { const p = items().find(i => PLANKS.test(i.name ?? '') && i.count >= 5); if (p) { try { await rt.crafting.craft(`minecraft:${PLANKS.exec(p.name)[1]}_boat`, { times: 1 }); made.push('boat') } catch {} } }
            } finally { try { rt.crafting.closeContainer() } catch {} }
          }
        }
        if (rt.travelRuntime.longTravel?.status?.().busy) { try { await rt.travelRuntime.longTravel.cancel('KIT_DONE') } catch {} }
        const kit = { bed: count(/^minecraft:bed$/), sword: count(/_sword$/), food: items().filter(i => /^minecraft:(?:cooked_)?(?:beef|porkchop|mutton|chicken|rabbit)$|^minecraft:(?:bread|apple|carrot|baked_potato)$/.test(i.name ?? '')).reduce((n, i) => n + i.count, 0), boat: count(/_boat$/), wool: count(/wool$/) }
        say(`${missing().length ? `足りないもの: ${missing().join('・')}。` : '揃いました。'}ベッド ${kit.bed}・剣 ${kit.sword}・食料 ${kit.food}・ボート ${kit.boat}（受信した持ち物で確認、作ったもの: ${made.join('・') || 'なし'}）`)
        return { made, kit }
      },
      // Read-only: each gate of the automatic armour step.
      armorCheck: () => { const g = {}; for (const [k, f] of Object.entries({ resetHeld: () => rt.resetHeld(), manualChest: () => !!rt.manualChestStorage?.isBusy(), chunkMoveHeld: () => rt.chunkMoveHeld(), placementPrep: () => !!rt.quarryPlacementPreparation, surfaceOwner: () => !!rt.host.shared.quarrySurfaceStorageOwner, allowed: () => rt.armorAutoAllowed(), task: () => !!rt.armorTask, workFree: () => rt.armorWorkFree(), nearest: () => rt.nearestHostileDistance(), preview: () => rt.armor.preview(), snapshot: () => rt.armor.snapshot() })) { try { g[k] = f() } catch (e) { g[k] = 'ERR ' + String(e.message ?? e).slice(0, 80) } } return g },
      // Take a few items out of a supply box kept in the home chest
      // (coordinator 2026-11-14: totems and a pickaxe/shovel before the trip).
      // The box is withdrawn, placed beside the bot by ordinary placement,
      // opened, the items withdrawn, the box broken under this placement's own
      // record (combat waits from the break until the box is back in the
      // received inventory) and returned to the chest. Never with a reachable
      // enemy near. Every step is the received inventory or block.
      supplyBoxTake: async (input = {}) => rt.travelSupplyBoxTake(input),
      // Read-only: why the empty-handed preparation flag is on or off.
      prepCheck: () => {
        const cheap = rt.require('./safety/learning-health').cheapItem, out = { allowance: rt.longTravelLogAllowance(), flag: rt.emptyHandedPrep(), blocking: [] }
        for (const [container, size] of [['main', 36], ['armor', 4], ['offhand', 1]]) {
          const v = rt.inventoryStore.view(container)
          if (v.known !== true || v.slots.length !== size) { out.blocking.push({ container, known: v.known, size: v.slots.length }); continue }
          v.slots.forEach((slot, i) => { const name = slot.raw ? rt.crafting.itemNameOf(slot.raw.network_id) : null; if (!(slot.received === true && slot.raw && (slot.raw.network_id === 0 || slot.raw.count === 0 || container === 'main' && cheap(name)))) out.blocking.push({ container, slot: i, received: slot.received, name, id: slot.raw?.network_id }) })
        }
        return out
      },
      requestTerrainAbove: async () => {
        const st = rt.working(); if (!st.position) throw new Error('位置が不明です。')
        const cx = Math.floor(st.position.x / 16), cz = Math.floor(st.position.z / 16), y = Math.floor(st.position.y - 1.62)
        const results = []
        // Live 13:58: a canopy over unreceived terrain (y48-63) looked like a deep hole; the request also covers 24 below.
        for (const [bottom, top] of [[Math.max(-60, y - 24), Math.min(110, y + 60)], [Math.min(110, y + 60), 120]]) {
          if (bottom >= top) continue
          results.push(await rt.requestQuarryTerrain({ config: { target: { chunks: [{ x: cx, z: cz }] } }, yTop: top, yBottom: bottom }, {}))
        }
        return results.map(r => ({ requested: r.requested, packets: r.packets, reason: r.reason ?? null }))
      },
      // Read-only: the coarse wide-area route over the received terrain.
      coarseRoutePreview: (input = {}) => {
        const d = input.destination, st = rt.working()
        if (!d || ![d.x, d.z].every(Number.isFinite) || !st.position) throw new Error('目的地 {x, z} を指定してください。')
        const started = Date.now()
        const r = rt.require('./travel/coarse-route').planCoarseRoute({ getBlock: (x, y, z) => rt.host.world.getBlock(x, y, z), start: { x: st.position.x, y: st.position.y - 1.62, z: st.position.z }, goal: d, maxNodes: Math.min(120000, input.maxNodes ?? 60000), allowDig: input.allowDig === true, surfaceOnly: input.surfaceOnly === true, maxDrop: Number.isInteger(input.maxDrop) ? input.maxDrop : 3 })
        const step = Math.max(1, Math.floor(r.path.length / 20))
        return { ready: r.ready, reached: r.reached, surfaced: r.surfaced === true, remaining: r.remaining, expanded: r.expanded, ms: Date.now() - started, length: r.path.length, sample: r.path.filter((_, i) => i % step === 0 || i === r.path.length - 1), frontier: r.frontier.slice(0, 8) }
      },
      // Preparation for a long trip from empty hands: about 10 logs by the
      // existing tree work (logs only), then planks/table/tools by the existing
      // crafting. The allowance expires after 30 minutes.
      prepareLongTravel: (input = {}) => {
        if (rt.quarryJob?.holdsWork()) throw new Error('露天掘りの作業中です。/quarry pause で一時停止してから操作してください。')
        const logCount = Math.max(1, Math.min(10, Number.isInteger(input.logCount) ? input.logCount : 10))
        rt.host.shared.woodHarvestAllowance = { purpose: 'long_travel_prep', logCount, startedAt: Date.now(), expiresAt: Date.now() + 30 * 60000 }
        rt.host.log(`長距離移動の準備: 原木を ${logCount} 本まで集めます（30分以内・原木のみ）${input.gather === false ? '（許可のみ。採取は後で）' : ''}`)
        if (input.gather === false) return { allowance: structuredClone(rt.host.shared.woodHarvestAllowance) }
        return rt.autonomy.start({ objective: 'long_travel_prep', logCount })
      },
      endLongTravelPrep: () => { rt.host.shared.woodHarvestAllowance = null; return rt.autonomy.stop('長距離移動の準備を終了しました。') },
      cancelTravel: async () => {
        const result = await (rt.travelRuntime.longTravel?.cancel('MANUAL_STOP') ?? { busy: false, phase: 'idle' })
        // A manual stop is saved, so a reconnect or restart does not resume it.
        try { const f = rt.travelRuntime.longTravelFile(), fsp = rt.require('node:fs/promises'); const doc = JSON.parse(await fsp.readFile(f, 'utf8')); doc.phase = 'stopped'; doc.reason = 'MANUAL_STOP'; doc.savedAt = new Date().toISOString(); await fsp.writeFile(f, JSON.stringify(doc, null, 2)) } catch {}
        rt.host.shared.longTravelResume = null
        return result
      },
      cancelChunkMove: operationId => {
        if (!operationId || rt.chunkTravel?.status().operationId !== operationId) throw Object.assign(new Error('移動操作が変わりました。状態を更新してください。'), { code: 'STALE_CHUNK_MOVE' })
        return rt.cancelChunkMovement('MANUAL_STOP')
      },
      chunkMoveStatus: () => rt.chunkTravel?.status() ?? { available: true, busy: false, phase: 'idle', operationId: null, serverConfirmed: false },
      controlPosition: () => rt.controlLocation.snapshot(),
      // Read-only: prove the bot's present position to the server (the same
      // /testfor volume query chunk travel uses), so the dashboard can act here.
      proveControlPosition: async () => { const st = rt.working(); if (!st.position) throw new Error('位置が不明です。'); return rt.controlLocation.confirm({ x: st.position.x, y: st.position.y - 1.62, z: st.position.z }, { radius: 0.2 }) },
      confirmControlPosition: (area, options) => rt.controlLocation.confirm(null, { ...options, area: rt.normalizeChunkArea(area), radius: 0.12, operationId: 'dashboard_area_position' }),
      plan: config => {
        if (!rt.quarryJob?.holdsWork()) rt.requireIdle()
        const input=structuredClone(config??{})
        const registered=rt.getRegisteredQuarryHomeSite()
        const view=rt.receivedEquipmentView(rt.inventoryInspection,rt.crafting,rt.quarryState())
        const empty=section=>section?.known===true&&Array.isArray(section.slots)&&section.slots.every(slot=>slot?.known===true&&slot.empty===true&&slot.count===0)
        const emptyBot=view.known===true&&!view.uncertain&&view.slots?.length===36&&empty(view)&&view.armor?.slots?.length===4&&empty(view.armor)&&view.offhand?.slots?.length===1&&empty(view.offhand)
        const explicit=input.initialLoadout==='v22'
        if (explicit && (!registered || input.homeChest && ['position','other','stand','stage'].some(part=>['x','y','z'].some(axis=>input.homeChest[part]?.[axis]!==registered[part]?.[axis])))) {
          throw Object.assign(new Error('初期セットの登録済みチェストを確認してください。'),{code:'LOADOUT_SOURCE_NOT_REGISTERED'})
        }
        if (registered && (explicit || input.homeChest==null&&emptyBot)) {
          input.homeChest=registered
          input.initialLoadout='v22'
          input.inventory={...input.inventory,supplyLayout:'v22'}
        } else if (input.homeChest == null && (input.inventory?.depositWhen == null || input.inventory.depositWhen === 'four_layers')) {
          input.homeChest=registered
        }
        return rt.ensureQuarryJob().plan(input)
      },
      start: () => { rt.requireIdle(); return rt.ensureQuarryJob().start() },
      resume: () => { rt.requireIdle(); return rt.ensureQuarryJob().resume() },
      retryPersistence: () => rt.ensureQuarryJob().retryPersistence(),
      configureExit: options => rt.ensureQuarryJob().configureExit(options ?? {}),
      configureTools: options => rt.ensureQuarryJob().configureTools(options ?? {}),
      configureStorage: options => rt.ensureQuarryJob().configureStorage(options ?? {}),
      configureDirtSupply: options => rt.ensureQuarryJob().configureDirtSupply(options ?? {}),
      configureAnimalClearing: options => rt.ensureQuarryJob().configureAnimalClearing(options ?? {}),
      acceptCarriedStorageLoss: options => rt.ensureQuarryJob().acceptCarriedStorageLoss(options ?? {}),
      // Manual selective storage into a large chest within reach (2026-11-13 user
      // request): cargo boxes and loose items go in; supply boxes, tools, worn
      // armour, the totem and food stay. Only while no quarry job is running.
      storeToChest: async (options = {}) => {
        const doc = rt.quarryJob?.document?.()
        if (doc && !['FINISHED', 'PAUSED', 'IDLE', 'CANCELLED'].includes(doc.state)) throw new Error('露天掘りの実行中は収納できません。')
        const p = options?.position
        if (!p || !['x', 'y', 'z'].every(k => Number.isSafeInteger(p[k])) || Object.keys(options).some(k => !['position', 'all'].includes(k))) throw new Error('storeToChest accepts { position: {x,y,z}, all?: true } of a large chest')
        const operationId = 'manual-store:' + new Date().toISOString().replace(/[:.]/g, '-')
        const file = rt.require('node:path').join(process.cwd(), '.local', 'manual-chest-deposit', operationId.replace(':', '-') + '.json')
        rt.require('node:fs').mkdirSync(rt.require('node:path').dirname(file), { recursive: true })
        const save = cp => rt.require('node:fs').writeFileSync(file, JSON.stringify(cp, null, 1))
        const { FINAL_CHEST_KEEP } = rt.require('./quarry/quarry-job')
        rt.ensureQuarryJob()
        if (!rt.quarryRuntime.quarrySurfaceChestRunner) throw new Error('収納の準備ができていません。')
        // all: true stores the gear too (2026-11-13 18:17 user request).
        const result = await rt.quarryRuntime.quarrySurfaceChestRunner('depositAll', { jobId: doc?.config?.jobId ?? 'manual', operationId, position: { x: p.x, y: p.y, z: p.z }, checkpoint: null, ...(options.all === true ? {} : { keep: FINAL_CHEST_KEEP }) }, { onCheckpoint: async cp => save(cp) })
        save({ ...(result.checkpoint ?? {}), result: { status: result.status, reason: result.reason ?? null, serverConfirmed: result.serverConfirmed } })
        rt.host.log(`手動収納（選択）: ${result.status} ${result.reason ?? ''} 記録 ${file}`)
        return { status: result.status, reason: result.reason ?? null, serverConfirmed: result.serverConfirmed, stored: (result.checkpoint?.receipts ?? []).filter(r => /deposit/.test(r.kind)).reduce((n, r) => n + (r.count ?? 0), 0), stacks: (result.checkpoint?.receipts ?? []).length, record: file }
      },
      configureCargoLossAcceptance: options => rt.ensureQuarryJob().configureCargoLossAcceptance(options ?? {}),
      configureSpareArmor: options => rt.ensureQuarryJob().configureSpareArmor(options ?? {}),
      requestTerrain: () => { const doc = rt.ensureQuarryJob().document(); if (!doc) throw new Error('No quarry job'); return rt.requestQuarryTerrain({ config: doc.config, yTop: doc.yTop, yBottom: doc.config.yBottom }) },
      confirmPosition: (feet, options) => rt.confirmQuarryPosition(feet, options),
      positionStatus: () => ({ ...(rt.quarryPositionVerifier?.snapshot() ?? { busy: false }), lastOutput: structuredClone(rt.host.shared.quarryPositionOutput ?? null) }),
      pillarStatus: () => rt.quarryPillar?.snapshot() ?? { busy: false, phase: 'unavailable' },
      pillarContext: () => {
        const state = rt.quarryState()
        return { phase: state.phase, health: state.health, position: state.position, rawServerPosition: state.rawServerPosition, rawServerPositionUpdatedAt: state.rawServerPositionUpdatedAt, connectionId: state.connectionId, startedAt: state.startedAt, lifecycle: state.lifecycle, inventory: state.inventory, heldItem: state.heldItem, selectedSlot: state.selectedSlot, protectionBusy: rt.idleSafety?.snapshot().busy === true, userControlBusy: rt.userBehaviorOwns(), loadingScreenEnded: rt.host.shared.loadingScreenEnded === true }
      },
      testPillar: options => rt.testQuarryPillar(options ?? {}),
      storeCarried: options => { rt.requireIdle(); return rt.ensureQuarryJob().storeCarriedNow(options ?? {}) },
      configureSupplies: options => { rt.requireIdle(); return rt.ensureQuarryJob().configureSupplies(options ?? {}) },
      restockSuppliesNow: () => { rt.requireIdle(); return rt.ensureQuarryJob().restockSuppliesNow() },
      reconcileSupplyPlacement: () => { rt.requireIdle({ inventoryRequired: false }); return rt.ensureQuarryJob().reconcileSupplyPlacement() },
      reconcileCarriedPlacement: () => { rt.requireIdle({ inventoryRequired: false }); return rt.ensureQuarryJob().reconcileCarriedPlacement() },
      reconcileCurrentStoragePlacement: () => { rt.requireIdle({ inventoryRequired: false }); return rt.ensureQuarryJob().reconcileCurrentStoragePlacement() },
      currentPlacementAuditStatus: () => ({ ...(rt.storagePlacementAudit?.snapshot() ?? {}), lastOutput: structuredClone(rt.host.shared.storagePlacementAuditOutput ?? null) }),
      reconcileRejectedStorage: () => { rt.requireIdle({ inventoryRequired: false }); return rt.ensureQuarryJob().reconcileRejectedStorage() },
      reconcileObservedStoragePlacement: () => { rt.requireIdle({ inventoryRequired: false }); return rt.ensureQuarryJob().reconcileObservedStoragePlacement() },
      acceptExceptions: () => rt.ensureQuarryJob().acceptExceptions(),
      reopenWorkLayer: options => rt.ensureQuarryJob().reopenWorkLayer(options ?? {}),
      recordDebugAction: options => rt.ensureQuarryJob().recordDebugAction(options ?? {}),
      pause: () => { rt.cancelQuarryRestore(); rt.cancelChunkMovement('QUARRY_PAUSE'); return rt.quarryJob ? rt.quarryJob.pause('MANUAL_PAUSE') : rt.quarrySnapshot() },
      emergencyStop: () => { rt.cancelQuarryRestore(); rt.cancelChunkMovement('EMERGENCY_STOP'); return rt.quarryJob ? rt.quarryJob.emergencyStop() : rt.quarrySnapshot() },
      cancel: () => { rt.cancelQuarryRestore(); rt.cancelChunkMovement('QUARRY_CANCEL'); return rt.quarryJob ? rt.quarryJob.cancel() : rt.quarrySnapshot() },
      load: jobId => rt.loadQuarryFile(jobId),
      status: () => rt.quarrySnapshot(),
      document: () => rt.quarryJob?.document() ?? structuredClone(rt.host.shared.quarryDocument ?? null)
    },
    storage: {
      prepare: options => rt.ensureManualChestStorage().prepare(options ?? {}),
      start: options => rt.ensureManualChestStorage().start(options ?? {}),
      status: () => rt.manualChestStorage?.status() ?? { available: true, busy: false, phase: 'idle', operationId: null, serverConfirmed: false, target: null, transferredStacks: 0, remainingStacks: null, error: null },
      diagnostics: () => rt.ensureManualChestStorage().diagnostics(),
      retryClose: () => rt.ensureManualChestStorage().retryClose(),
      cancel: reason => rt.manualChestStorage?.cancel(reason ?? 'MANUAL_STOP') ?? { available: true, busy: false, phase: 'idle' },
      drain: () => rt.manualChestStorage?.drain() ?? Promise.resolve()
    },
    userBehaviors: {
      start: () => { if (rt.disposed || rt.disposing) throw new Error('Runtime is reloading'); rt.host.shared.combatDefenseWanted = true; rt.host.shared.userBehaviorsEnabled = true; rt.tickUserBehaviors(); return rt.userBehaviorSnapshot() },
      stop: async reason => { rt.host.shared.combatDefenseWanted = false; rt.host.shared.combatDefenseAnchor = null; rt.host.shared.userBehaviorsEnabled = false; rt.userBehaviors?.cancel(reason ?? 'manual_user_behavior_stop', 'CANCELLED'); await rt.userBehaviors?.drain(); return rt.userBehaviorSnapshot() },
      tick: () => { rt.tickUserBehaviors(); return rt.userBehaviorSnapshot() }, snapshot: rt.userBehaviorSnapshot
    },
    safety: {
      start: (options = {}) => {
        if (rt.disposed || rt.disposing) throw new Error('行動コードを更新しました。新しい状態からやり直してください。')
        if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'lowHealthRecoveryMs') || options.lowHealthRecoveryMs !== undefined && (!Number.isSafeInteger(options.lowHealthRecoveryMs) || options.lowHealthRecoveryMs < 0 || options.lowHealthRecoveryMs > 60000)) throw new Error('低体力回復の待機時間が不正です。')
        if (options.lowHealthRecoveryMs && rt.idleSafety?.snapshot().running) throw new Error('保護動作中に低体力回復の期限は変更できません。')
        if (options.lowHealthRecoveryMs) rt.host.shared.safetyRecoveryDeadline = Date.now() + options.lowHealthRecoveryMs
        else if (!rt.host.shared.safetyWanted) rt.host.shared.safetyRecoveryDeadline = 0
        if (!rt.host.shared.safetyWanted) { rt.host.shared.safetyEnableEpoch++; rt.host.shared.safetyEmergency = null }
        rt.host.shared.safetyWanted = true
        return rt.resumeSafety()
      },
      stop: async reason => {
        if (rt.disposed || rt.disposing) throw new Error('行動コードを更新しました。新しい状態からやり直してください。')
        rt.safetyDispatchEpoch++
        rt.host.shared.safetyWanted = false
        await rt.idleSafety?.stop(reason ?? '待機保護を停止しました。')
        await rt.idleSafety?.drain()
        return rt.safetySnapshot()
      },
      snapshot: rt.safetySnapshot
    },
    guardRoute: {
      execute: (waypoints, options) => { rt.requireIdle(); if (!rt.guardRoute) throw new Error('経路監視の初期化を待ってください。'); const result = rt.guardRoute.execute(waypoints, options); rt.guardRouteProgress = null; return result },
      returnRoute: (prefix, options) => { rt.requireIdle(); if (!rt.guardRoute) throw new Error('経路監視の初期化を待ってください。'); const result = rt.guardRoute.returnRoute(prefix, options); rt.guardRouteProgress = null; return result },
      escape: (waypoints, options) => { rt.requireIdle(); if (!rt.guardRoute) throw new Error('経路監視の初期化を待ってください。'); const result = rt.guardRoute.escape(waypoints, options); rt.guardRouteProgress = null; return result },
      snapshot: rt.guardRouteSnapshot,
      stop: reason => rt.guardRoute?.stop(reason) ?? { phase: 'idle', busy: false }
    },
    hut: {
      preview: options => rt.hut?.preview(options) ?? { ready: false },
      reconcileEmptyPlacement: () => { rt.requireIdle(); if (!rt.hut) throw new Error('小屋の初期化を待ってください。'); return rt.hut.reconcileEmptyPlacement() },
      execute: options => { rt.requireIdle(); return rt.hut.execute(options) },
      leave: options => { rt.requireIdle(); return rt.hut.leave(options) },
      snapshot: () => rt.hut?.snapshot() ?? null,
      stop: reason => rt.hut?.stop(reason)
    },
    armor: { equipBest: rt.equipManualArmor },
    diagnostics: {
      locatePlains: async () => {
        rt.plainsLocator ??= rt.createPlainsLocator({ client: rt.host.client, getState: () => rt.disposed || rt.disposing || rt.replaying ? null : rt.lightweightRawState() })
        const result = await rt.plainsLocator.locate()
        if (result.requestId) rt.host.shared.lastPlainsLocate = structuredClone(result)
        return result
      },
      locatePlainsStatus: () => ({ pending: rt.plainsLocator?.snapshot().pending ?? false, lastResult: structuredClone(rt.host.shared.lastPlainsLocate ?? null) }),
      resistance: () => rt.selfResistance.snapshot(),
      manualRecoveryGroundProof: runtimeId => {
        const state = rt.manualRecoveryState(), target = rt.host.entities.snapshot({ kind: 'all' }).find(actor => String(actor.runtimeId) === String(runtimeId))
        return rt.manualGroundAccessProof(target, state)
      },
      slowFalling: () => rt.selfSlowFalling.snapshot(),
      effectEvents: () => rt.selfEffectEvents.snapshot(),
      lastWaterPreview: () => structuredClone(rt.host.shared.waterPreviewObservation ?? null),
      movement: () => rt.movement?.diagnostics() ?? null,
      shoreSurvey: async () => {
        const start = rt.raw()
        if (start.phase !== 'spawned' || !start.position || start.dead) throw new Error('ワールド内の位置を確認できません。')
        const scope = JSON.stringify([start.profile, start.realm?.id, start.dimension, start.connectionId])
        const result = await rt.surveyShore({ world: rt.host.world, position: start.position, radius: 64, valid: () => {
          const current = rt.raw()
          return !rt.disposed && !rt.disposing && current.phase === 'spawned' && !current.dead && JSON.stringify([current.profile, current.realm?.id, current.dimension, current.connectionId]) === scope
        } })
        if (rt.shoreMemory && !rt.disposed && !rt.disposing) {
          await rt.loadShoreHistory()
          rt.shoreMemory.rememberSurvey({ profile: start.profile, realmId: String(start.realm?.id), dimension: start.dimension }, result)
          await rt.shoreMemory.save()
        }
        return result
      },
      rawInventorySlot: slot => {
        if (!Number.isInteger(slot) || slot < 0 || slot > 35) throw new Error('持ち物スロットは0〜35で指定してください。')
        return rt.crafting.rawItem(slot)
      },
      craftingRecipes: output => rt.crafting.describeRecipes(output),
      lastInventoryUpdate: () => structuredClone(rt.host.shared.lastInventoryUpdate ?? null),
      shelterEvents: () => structuredClone(rt.host.shared.shelterEvents ?? []),
      inventoryEvents: () => structuredClone(rt.host.shared.inventoryEvents ?? []),
      permissions: () => ({ permissionLevel: rt.host.meta.startGame?.permission_level, playerGameMode: rt.host.meta.startGame?.player_gamemode, worldGameMode: rt.host.meta.startGame?.world_gamemode, serverAuthoritativeInventory: rt.host.meta.startGame?.server_authoritative_inventory, serverAuthoritativeBlockBreaking: rt.host.meta.startGame?.server_authoritative_block_breaking, playerName: rt.raw().playerName, runtimeEntityId: rt.raw().runtimeEntityId }),
      threatReachability: () => rt.threatReachability.snapshot(),
      combatSearchBudget: () => rt.combatExposure.snapshot(),
      combatCandidates: () => rt.userBehaviors?.explainCombat?.() ?? null,
      // Read-only: each condition of the user-behavior combat canAct gate.
      combatGate: () => {
        const read = f => { try { return f() } catch (error) { return `unavailable: ${error.message}` } }
        return { surfaceReturnOwner: read(() => !!rt.surfaceReturnOwner), replaying: read(() => !!rt.replaying), combatDefenseWanted: rt.defenseEnabled(rt.host.shared), userBehaviorsEnabled: rt.host.shared.userBehaviorsEnabled === true, autoWanted: rt.host.shared.autoWanted === true, loadingScreenEnded: rt.host.shared.loadingScreenEnded === true, respawnTerrainPending: !!rt.host.shared.respawnTerrain?.pending, userBehaviorWakePending: read(() => !!rt.userBehaviorWakePending), disposed: read(() => !!rt.disposed || !!rt.disposing) }
      },
      // Read-only test helper: dry, flat, open areas in received terrain.
      findFlatArea: (options = {}) => rt.findFlatArea(options),
      // Read-only: in-process CPU profile (no inspector port is opened). Saves
      // .local/cpu-<time>.cpuprofile and returns the top self-time functions.
      cpuProfile: ms => rt.profileCpu(ms),
      // Read-only: why the after-restart quarry restore did or did not run.
      quarryRestore: () => { const st = rt.raw(); return { tried: rt.host.shared.quarryRestoreTried === true, result: rt.host.shared.quarryRestore ?? null, ports: !!rt.quarryPorts, phase: st.phase, loadingScreenEnded: rt.host.shared.loadingScreenEnded === true, spawnPending: !!st.spawnPending, inventoryKnown: st.inventory?.known ?? null, inventoryUncertain: rt.host.shared.inventoryUncertain ?? null } },
      // Read-only: the raw server item in a slot (NBT, enchantments) as JSON.
      rawItem: slot => { const r = rt.crafting.rawItem(Number(slot)); return r ? JSON.parse(JSON.stringify(r, (k, v) => typeof v === 'bigint' ? String(v) : v)) : null },
      // Read-only: milliseconds spent in each part of the /status snapshot.
      snapshotTimings: () => {
        const parts = { userBehaviors: () => rt.userBehaviorSnapshot(), safety: () => rt.safetySnapshot(), guardRoute: () => rt.guardRouteSnapshot(), queuedPrediction: () => rt.inputHistory?.snapshot(), missionMemory: () => rt.missionJournal.snapshot(), hut: () => rt.hut?.snapshot(), shelter: () => rt.activeBase()?.snapshot(), foraging: () => rt.foraging?.snapshot(), food: () => rt.food.snapshot(), recovery: () => rt.recovery?.snapshot(), excavation: () => rt.excavation?.snapshot(), quarry: () => rt.quarrySnapshot(), tunneling: () => rt.tunneling?.snapshot(), furnace: () => rt.furnace.snapshot(), chest: () => rt.chest.snapshot(), mining: () => rt.mining.snapshot(), walking: () => rt.walker?.snapshot(), movement: () => rt.movement?.snapshot(), crafting: () => rt.crafting.snapshot(), inventoryActions: () => rt.inventory.snapshot(), interactions: () => rt.interactions.snapshot(), combat: () => rt.combat?.snapshot(), agent: () => rt.autonomy.snapshot(), depotPrebuild: () => rt.depotPrebuild?.snapshot(), depotMission: () => rt.depotMission?.snapshot(), surfaceReturn: () => rt.surfaceReturn?.snapshot(), entitiesAll: () => rt.host.entities.snapshot({ kind: 'all' }), worldStats: () => rt.host.world.stats() }
        return rt.measureSnapshots(parts)
      },
      armor: () => rt.armor.snapshot(),
      sightFrom: (x, y, z) => { const p = rt.raw().position; const hs = rt.host.entities.snapshot({ kind: 'all' }).filter(e => e.hostile && e.alive !== false && e.position && Math.hypot(e.position.x - x, e.position.z - z) < 32); return hs.map(e => ({ type: e.entityType, runtimeId: e.runtimeId, distance: +Math.hypot(e.position.x - x, e.position.y - y, e.position.z - z).toFixed(1), clear: rt.bowSightClearAt({ x, y: y + 1.62, z }, { x: e.position.x, y: e.position.y + 0.9, z: e.position.z }), clearFromBot: p ? rt.bowSightClearAt(p, { x: e.position.x, y: e.position.y + 0.9, z: e.position.z }) : null })).sort((a, b) => a.distance - b.distance).slice(0, 8) },
      blocksAround: () => { const p = rt.raw().position; if (!p) return null; const fx = Math.floor(p.x), fy = Math.floor(p.y - 1.62), fz = Math.floor(p.z), rows = []; for (let dy = 2; dy >= -1; dy--) { const lines = []; for (let dz = -2; dz <= 2; dz++) { let line = ''; for (let dx = -2; dx <= 2; dx++) { const b = rt.host.world.getBlock(fx + dx, fy + dy, fz + dz); line += !b?.known ? '?' : /air/.test(b.name) ? '.' : /water/.test(b.name) ? '~' : b.boundingBox === 'empty' ? ',' : '#' } lines.push(line) } rows.push({ dy, lines: lines.join(' ') }) } return { feet: { x: fx, y: fy, z: fz }, exact: p, rows } },
      userTick: () => { const s = rt.host.shared.userTickStats ?? {}; return { inventoryUncertain: rt.host.shared.inventoryUncertain ?? null, rangedShotUncertain: rt.host.shared.rangedShotUncertain ?? null, resync: rt.host.shared.inventoryResync?.lastRequest ?? null, ...s, taskAgeMs: s.taskSince ? Date.now() - s.taskSince : 0, sinceRanMs: s.lastRanAt ? Date.now() - s.lastRanAt : null, taskPending: !!rt.userBehaviorTickTask, lastCombat: rt.userBehaviors?.snapshot?.().combat?.lastResult?.code ?? null, worker: rt.userBehaviors?.snapshot?.().combat?.phase ?? null } },
      acquireDenials: () => ({ last: rt.host.shared.lastUserAcquireDenial ?? null, counts: { ...(rt.host.shared.userAcquireDenials ?? {}) }, lastPreemptSurvey: rt.host.shared.lastPreemptSurvey ?? null }),
      foodLife: () => ({ foodKnownLife: rt.foodKnownLife(), deathRespawn: rt.host.shared.deathRespawn?.deathId ?? null, receipt: rt.host.shared.inventoryLifeReceipt ? { source: rt.host.shared.inventoryLifeReceipt.source, deathId: rt.host.shared.inventoryLifeReceipt.deathId, keyMatches: rt.host.shared.inventoryLifeReceipt.key === rt.inventoryLifeBaseKey(rt.raw()) } : null, verified: !!rt.verifiedInitialLifeReceipt(), hunger: rt.food.snapshot().hunger }),
      // Operator helper: sends any slash command as the bot (the owner allows
      // all commands on this Realm). The result is not proof of anything;
      // check the world or inventory afterwards.
      command: (text, version = 'latest') => {
        if (typeof text !== 'string' || !/^\/\S/.test(text) || text.length > 512 || /[\r\n]/.test(text)) throw new Error('コマンドは / で始まる1行（512文字以内）で指定してください。')
        const uuid = rt.require('node:crypto').randomUUID()
        // The reply with this request UUID is kept (bounded) for commandOutput().
        rt.host.shared.diagCommandOutputs ??= new Map()
        rt.host.shared.diagCommandOutputs.set(uuid, { command: text, sentAt: Date.now(), output: null })
        while (rt.host.shared.diagCommandOutputs.size > 20) rt.host.shared.diagCommandOutputs.delete(rt.host.shared.diagCommandOutputs.keys().next().value)
        rt.host.client.queue('command_request', { command: text, origin: { type: 'player', uuid, request_id: '', player_entity_id: 0n }, internal: false, version: String(version) })
        return { sent: true, command: text, version: String(version), uuid }
      },
      // Runs the real storage air audit once (read-only) at a received cell.
      auditAir: async (x, y, z) => {
        if (![x, y, z].every(Number.isSafeInteger)) throw new Error('整数の座標を指定してください。')
        rt.storagePlacementAudit ??= rt.createStoragePlacementAudit({ client: rt.host.client, getState: rt.quarryState })
        return rt.storagePlacementAudit.confirmAir({ x, y, z }, { operationId: 'diagnostics:audit-air' })
      },
      commandOutput: uuid => { const row = rt.host.shared.diagCommandOutputs?.get(String(uuid ?? '').toLowerCase()) ?? rt.host.shared.diagCommandOutputs?.get(String(uuid ?? '')); return row ? structuredClone(row) : null }
    },
    shelter: {
      preview: options => rt.shelter?.preview(options) ?? { ready: false },
      execute: options => { rt.requireIdle(); return rt.shelter.execute(options) },
      leave: options => { rt.requireIdle(); return rt.shelter.leave(options) },
      snapshot: () => rt.shelter?.snapshot() ?? null,
      stop: reason => rt.shelter?.stop(reason)
    },
    foraging: {
      preview: options => rt.foraging?.preview(options) ?? { ready: false },
      execute: options => { rt.requireIdle(); return rt.foraging.execute(options) },
      snapshot: () => rt.foraging?.snapshot() ?? null,
      stop: reason => rt.foraging?.stop(reason)
    },
    food: {
      preview: options => rt.food.preview(options),
      eat: options => { rt.requireIdle(); return rt.food.eat(options) },
      snapshot: () => rt.food.snapshot(),
      stop: reason => rt.food.cancel(reason)
    },
    recovery: {
      preview: options => rt.recovery?.preview(options) ?? { ready: false },
      previewAsync: options => rt.recovery?.previewAsync(options) ?? Promise.resolve({ ready: false }),
      execute: options => { rt.requireIdle({ inventoryRequired: false }); return rt.recovery.execute(options) },
      snapshot: () => rt.recovery?.snapshot() ?? null,
      stop: reason => rt.recovery?.stop(reason)
    },
    tunneling: {
      preview: (decision, options) => rt.tunneling?.preview(decision, options) ?? { ready: false },
      execute: (decision, options) => { rt.requireIdle(); return rt.tunneling.execute(decision, options) },
      snapshot: () => rt.tunneling?.snapshot() ?? null,
      stop: reason => rt.tunneling?.stop(reason)
    },
    excavation: {
      preview: options => rt.excavation?.preview(options) ?? { ready: false },
      execute: options => { rt.requireIdle(); return rt.excavation.execute(options) },
      snapshot: () => rt.excavation?.snapshot() ?? null,
      stop: reason => rt.excavation?.stop(reason)
    },
    prospecting: {
      start: options => {
        rt.prospecting.scan(options ?? {}).then(result => { if (!rt.disposed && !rt.disposing) rt.host.shared.prospecting = result }).catch(error => { if (!rt.disposed) rt.host.shared.prospectingError = error.message })
        return rt.prospecting.snapshot()
      },
      scan: async options => {
        const result = await rt.prospecting.scan(options ?? {})
        if (!rt.disposed && !rt.disposing) rt.host.shared.prospecting = result
        return result
      },
      snapshot: () => rt.prospecting.snapshot(),
      stop: reason => rt.prospecting.cancel(reason)
    },
    depotMission: {
      start: async () => { rt.host.shared.legacyWorkHoldScope = null; rt.host.shared.legacyWorkHoldLease = null; rt.autonomy.stop('ダイヤ保管後も継続する作業へ引き継ぎます。'); return rt.depotMission.start() },
      stop: () => rt.depotMission.stop(),
      tick: () => rt.depotMission.tick(),
      snapshot: () => rt.depotMission.snapshot()
    },
    surfaceReturn: {
      preview: options => rt.surfaceReturn?.previewAsync(options) ?? Promise.resolve({ ready: false, code: 'NOT_READY' }),
      previewAsync: options => rt.surfaceReturn?.previewAsync(options) ?? Promise.resolve({ ready: false, code: 'NOT_READY' }),
      execute: options => rt.executeSurfaceReturn(options),
      stop: reason => rt.surfaceReturn?.stop(reason),
      snapshot: () => rt.surfaceReturn?.snapshot() ?? null
    },
    chest: {
      open: (position, slot) => { rt.requireIdle(); rt.crafting.closeContainer(); return rt.chest.open(position, slot) },
      withdrawItem: options => { rt.requireIdle(); return rt.chest.withdrawItem(options) },
      depositDiamond: options => { rt.requireIdle(); return rt.chest.depositDiamond(options) },
      depositItem: options => { rt.requireIdle(); return rt.chest.depositItem(options) },
      snapshot: () => rt.chest.snapshot(),
      status: rt.chestStatus,
      rawItem: slot => rt.chest.rawItem(slot),
      cancel: reason => rt.chest.cancel(reason)
    },
    furnace: {
      putInput: (...args) => { rt.requireIdle(); return rt.furnace.putInput(...args) },
      putFuel: (...args) => { rt.requireIdle(); return rt.furnace.putFuel(...args) },
      takeOutput: options => { rt.requireIdle(); return rt.furnace.takeOutput(options) },
      waitOutput: (...args) => rt.furnace.waitOutput(...args),
      stop: reason => rt.furnace.cancel(reason),
      cancel: reason => rt.furnace.cancel(reason),
      snapshot: () => rt.furnace.snapshot()
    },
    perception: {
      entities: () => rt.host.entities.snapshot({ kind: 'all' }),
      nearby: (options = {}) => rt.host.entities.nearby(rt.working().position, options),
      observe: options => rt.runner.observe(options ?? {})
    },
    mining: {
      previewAccessClearance: options => rt.mining.previewAccessClearance(options),
      startAccessClearance: options => { rt.requireIdle(); rt.crafting.closeContainer(); return rt.mining.startAccessClearance(options) },
      preview: targets => rt.mining.preview(targets),
      start: targets => {
        rt.requireIdle()
        if (Array.isArray(targets) && targets.some(p => p && rt.portableKeys().has(String(p.x) + ',' + String(p.y) + ',' + String(p.z)))) throw Object.assign(new Error('地下作業場所の床と屋根は掘削しません。'), { code: 'PROTECTED_BLOCK' })
        if (!rt.ownedCall && Array.isArray(targets) && targets.some(point => point && rt.planningWorld.getBlock(point.x, point.y, point.z).protectionSource === 'bot_base')) {
          const error = new Error('拠点の床・壁・屋根は通常の資材採掘では壊しません。')
          error.code = 'PROTECTED_BLOCK'
          throw error
        }
        if (!rt.ownedCall && Array.isArray(targets)) {
          const state = rt.raw()
          if (rt.host.shared.tunnelFloors != null && (typeof state.profile !== 'string' || !state.profile || state.realm?.id == null || !['overworld', 'nether', 'end'].includes(state.dimension))) {
            const error = new Error('帰路の床のワールド情報が未確定のため、通常採掘を停止します。')
            error.code = 'TUNNEL_FLOOR_SCOPE_UNKNOWN'
            throw error
          }
          const floors = rt.readCurrentTunnelFloors()
          // The player's climb (player-climb.js) passes through a floor and fills its shaft behind it.
          if (targets.some(point => point && point.climbShaft !== true && floors.some(floor => floor.x === point.x && floor.y === point.y && floor.z === point.z))) {
            const error = new Error('実際に通った坑道の帰路の床は、通常の資材採掘では壊しません。')
            error.code = 'PROTECTED_BLOCK'
            error.protectionSource = 'tunnel_floor'
            throw error
          }
        }
        rt.crafting.closeContainer()
        return rt.mining.start(targets)
      },
      stop: reason => rt.mining.stop(reason)
    },
    walking: {
      preview: target => { rt.requireIdle({ inventoryRequired: false }); rt.motionOrigin = rt.working(); return rt.walker?.preview(target) ?? { ready: false, errors: ['歩行の初期化を待っています。'] } },
      start: target => rt.startMotion('flat_walk', target),
      stop: reason => { rt.publishWalker(); return rt.walker?.stop(reason) ?? { phase: 'idle' } }
    },
    movement: {
      destination: rt.movementDestination,
      clearDestination: rt.clearMovementDestination,
      preview: (target, options) => { const guardedOptions = rt.portableMovementOptions(target, options); rt.requireIdle({ inventoryRequired: false }); rt.motionOrigin = rt.working(); return rt.movement?.preview(target, guardedOptions) ?? { ready: false, errors: ['移動の初期化を待っています。'] } },
      start: (target, options) => rt.startMotion('navigation', target, options),
      settle: options => {
        if (options?._portableMovementLease != null) throw rt.portablePolicyError('tagged settle requires reobservation')
        rt.requireIdle({ inventoryRequired: false })
        rt.yieldPortableMovement()
        if (!rt.movement?.settle) throw new Error('着地処理の更新を待っています。')
        rt.stopIdleStream()
        rt.idlePhysicsState = null
        rt.motionOrigin = rt.working()
        rt.host.shared.motionSource = 'navigation_settle'
        return rt.movement.settle(options)
      },
      stop: reason => {
        // A delayed external cleanup must not cancel a movement that the idle
        // safety supervisor has since acquired. Explicit agent/safety stops
        // still use their own cancellation and cleanup paths.
        if (!rt.ownedCall && rt.idleSafety?.snapshot().busy) throw new Error('保護動作が移動を使用中です。全体を停止する場合は自律動作か保護動作を停止してください。')
        return rt.movement?.stop(reason) ?? { phase: 'idle' }
      }
    },
    crafting: {
      preview: (...args) => rt.host.shared.inventoryUncertain ? { ready: false, errors: ['操作後の持ち物が未確定です。'] } : rt.crafting.preview(...args),
      craft: (...args) => { rt.requireIdle(); return rt.crafting.craft(...args) },
      openInventory: () => { rt.requireIdle({ inventoryRequired: false }); return rt.crafting.openInventory() },
      closeContainer: () => rt.crafting.closeContainer()
    },
    interactions: {
      cancel: reason => rt.interactions.cancel(reason),
      equip: slot => { rt.requireIdle(); const result = rt.interactions.equip(slot); rt.host.setEquipmentPrediction(slot); return result },
      placeCraftingTable: data => {
        rt.requireIdle(); rt.crafting.closeContainer()
        return rt.interactions.placeCraftingTable(data).then(result => {
          rt.host.shared.stations ??= {}
          rt.host.shared.stations.craftingTable = { known: true, serverConfirmed: true, placedByBot: true, position: result.position }
          return result
        })
      },
      placeBlock: data => {
        rt.requireIdle(); rt.crafting.closeContainer()
        const plan = rt.interactions.previewPlace(data)
        if (!plan.ready) throw new Error(plan.errors.join('\n'))
        return rt.interactions.placeBlock(data).then(result => {
          const name = plan.expectedBlock
          if (name === 'minecraft:furnace' || name === 'minecraft:crafting_table') {
            rt.host.shared.stations ??= {}
            rt.host.shared.stations[name === 'minecraft:furnace' ? 'furnace' : 'craftingTable'] = { known: true, serverConfirmed: true, placedByBot: true, position: result.position }
          }
          return result
        })
      },
      previewPlace: data => rt.interactions.previewPlace(data),
      // Manual normal placement against a side face (2026-11-13: a bridge to the
      // registered chest over the finished pit). Same checks as the quarry's seals.
      previewPlaceAgainst: data => rt.interactions.previewQuarryPlace(data),
      placeAgainst: data => { rt.requireIdle(); rt.crafting.closeContainer(); const plan = rt.interactions.previewQuarryPlace(data); if (!plan.ready) throw new Error((plan.errors ?? []).join(' / ') || 'placement refused'); return rt.interactions.placeQuarryBlock(data) },
      openCraftingTable: (...args) => { rt.requireIdle(); rt.crafting.closeContainer(); return rt.interactions.openCraftingTable(...args) },
      openFurnace: (...args) => { rt.requireIdle(); rt.crafting.closeContainer(); return rt.interactions.openFurnace(...args) },
      openChest: (position, slot) => { rt.requireIdle(); rt.crafting.closeContainer(); return rt.chest.open(position, slot) },
      previewOpenChest: (position, slot) => rt.interactions.previewOpenChest(position, slot)
    },
    inventory: {
      resync: () => rt.requestInventoryResyncWithReceipt(),
      resyncStatus: () => structuredClone(rt.host.shared.inventoryResync?.lastRequest ?? null),
      equip: async slot => {
        rt.requireIdle()
        const result = await rt.inventory.equip(slot)
        if (result.serverConfirmed) rt.host.shared.equipment = null
        return result
      },
      // Throwing a held stack away (player mode, no chest and no wood).
      discard: (slot, count) => { rt.requireIdle(); return rt.armor.discard(slot, count) }
    },
    combat: {
      previewHunt: id => rt.combat?.previewHunt(id) ?? { ready: false },
      previewEngage: (id, options) => rt.combat?.previewEngage(id, options) ?? { ready: false },
      previewWaterCreeper: id => rt.combat?.previewWaterCreeper(id) ?? { ready: false },
      waterCreeperAttack: id => { rt.requireIdle(); return rt.combat.waterCreeperAttack(id) },
      hunt: id => { rt.requireIdle(); return rt.require('./survival/hunt-weapon').huntArmed({ hunt: target => rt.combat.hunt(target), equip: slot => rt.inventory.equipForCombat(slot), crafting: rt.crafting, getState: () => rt.observedState(), log: text => rt.host.log(text) }, id) },
      preview: id => rt.combat?.preview(id) ?? { ready: false },
      attack: id => { rt.requireIdle(); return rt.combat.attack(id) },
      defend: options => { rt.requireIdle(); return rt.combat.defend(options) },
      engage: (id, options) => { rt.requireIdle(); return rt.combat.engage(id, options) },
      stop: reason => { rt.combat?.cancel(reason); return rt.combat?.drain() }
    },
    agent: {
      yieldWork: async reason => {
        if (rt.disposed || rt.disposing) throw new Error('Runtime is reloading')
        const options=reason&&typeof reason==='object'?reason:null, ttlMs=options?.ttlMs
        if(ttlMs!=null&&(!Number.isSafeInteger(ttlMs)||ttlMs<1000||ttlMs>60000))throw Error('Work hold ttlMs must be an integer1000..60000')
        const scope=rt.userScope(rt.rawScope()), lease=ttlMs==null?null:{id:rt.require('node:crypto').randomUUID(),scope,createdAt:Date.now(),expiresAt:Date.now()+ttlMs}
        rt.host.shared.legacyWorkHoldScope=scope;rt.host.shared.legacyWorkHoldLease=lease
        rt.autonomy.stop(options?.reason ?? (typeof reason==='string'?reason:'Logical work handoff'))
        await rt.autonomy.tick()
        return {held:lease?rt.host.shared.legacyWorkHoldLease?.id===lease.id&&rt.logicalWorkHeld():rt.logicalWorkHeld(),policyUnchanged:true,leaseId:lease?.id??null,scope,expiresAt:lease?.expiresAt??null,agent:rt.autonomy.snapshot()}
      },
      releaseWork: leaseId => {
        const lease=rt.host.shared.legacyWorkHoldLease
        if(typeof leaseId!=='string'||!lease||lease.id!==leaseId)return {released:false,policyUnchanged:true}
        rt.host.shared.legacyWorkHoldLease=null
        if(rt.host.shared.legacyWorkHoldScope===lease.scope)rt.host.shared.legacyWorkHoldScope=null
        return {released:true,policyUnchanged:true}
      },
      start: options => {
        if (rt.chunkMoveHeld()) throw Object.assign(new Error('Botの移動が終わるまで待ってください。'), { code: 'CHUNK_MOVE_BUSY' })
        if (rt.manualChestStorage?.isBusy()) throw Object.assign(new Error('ラージチェストへの収納操作中です。'), { code: 'STORAGE_BUSY' })
        if (rt.resetHeld()) throw Object.assign(new Error('初期アイテムのリセット処理中です。'), { code: 'RESET_BUSY' })
        if (rt.disposed || rt.disposing) throw new Error('行動コードを更新しました。新しい状態からやり直してください。')
        rt.host.shared.legacyWorkHoldScope = null; rt.host.shared.legacyWorkHoldLease = null
        rt.host.shared.autoWanted = true
        rt.host.shared.autoOptions = { objective: 'diamond', diamondCount: 1, maxRunMs: 7200000, maxWaitTicks: 1200, ...options }
        const start = () => { if (rt.disposed || rt.disposing || rt.resetHeld() || rt.manualChestStorage?.isBusy() || rt.chunkMoveHeld()) return rt.autonomy.snapshot(); return rt.autonomy.start({ ...rt.host.shared.autoOptions, progress: options?.progress ?? rt.host.shared.autonomyProgress }) }
        return rt.missionJournal.enabled ? rt.missionJournal.load().then(result => rt.missionReady(result) ? start() : rt.autonomy.snapshot()) : start()
      },
      stop: reason => { rt.host.shared.autoWanted = false; rt.clearNavigationDestination(); const result = rt.autonomy.stop(reason); rt.stopActions(reason); return result },
      tick: () => { if (rt.chunkMoveHeld()) throw Object.assign(new Error('Botの移動が終わるまで待ってください。'), { code: 'CHUNK_MOVE_BUSY' }); if (rt.manualChestStorage?.isBusy()) throw Object.assign(new Error('ラージチェストへの収納操作中です。'), { code: 'STORAGE_BUSY' }); if (rt.resetHeld()) throw Object.assign(new Error('初期アイテムのリセット処理中です。'), { code: 'RESET_BUSY' }); return rt.autonomy.tick() }
    }
  }
  rt.require('./modes/mode-runtime').attachModeOperations(operations, { host: () => rt.host, autonomy: () => rt.autonomy, manualChestStorage: () => rt.manualChestStorage, chunkMoveHeld: () => rt.chunkMoveHeld(), resetHeld: () => rt.resetHeld(), raw: () => rt.raw(), disposed: () => !!rt.disposed || !!rt.disposing, travel: () => rt.travelRuntime, nearestHostile: () => rt.nearestHostileDistance(), hostiles: () => rt.allActors().filter(actor => actor?.hostile === true && actor.alive !== false), totem: () => rt.working().totemGuard === true, position: () => rt.working().position, inventory: () => rt.working().inventory, motion: () => rt.movement?.snapshot() ?? {}, pillarStep: (step, settings) => rt.quarryPorts.pillarStep(step, settings) })
  return {
    get operations () { return operations }
  }
}

module.exports = { createRuntimeOperations }
