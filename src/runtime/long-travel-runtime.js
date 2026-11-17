'use strict'

// Long-distance travel wiring of the runtime: the trip itself, its night pit,
// danger zones, shooter retreat, respawn bed, supply-box take, boat and the
// chunk-travel leg underneath. Moved out of runtime.js unchanged (2026-11-15).
// `rt` exposes the runtime closure bindings this code uses; each read or write
// of rt.<name> reads or writes the runtime's own variable at that moment.
// Modules are loaded through rt.require, the runtime's own require.

function createLongTravelRuntime (rt) {
  let longTravel = null
  const longTravelFile = () => rt.require('node:path').resolve(rt.__dirname, '..', '.local', 'long-travel', 'current.json')
  // Received overworld clock only (sync_world_clocks, else set_time).
  function travelClock () {
    const clock = Object.values(rt.host.shared.worldClocks ?? {}).find(c => c?.name === 'minecraft:overworld' && c.source === 'server_sync_world_clocks' && Number.isSafeInteger(c.time))
    if (clock) return { time: clock.time, source: clock.source }
    const fallback = rt.host.shared.worldTime
    return rt.raw().dimension === 'overworld' && fallback?.source === 'server_set_time' && Number.isSafeInteger(fallback.ticks) ? { time: fallback.ticks, source: fallback.source } : { time: null, source: 'unknown' }
  }
  // Night stop (coordinator 2026-11-14: the day/night cycle is expected to run):
  // at dusk dig a three-deep pit at the feet by the ordinary mining, cover it
  // with an ordinary placement and wait for morning; each step is confirmed by
  // received terrain. In the morning the cover is mined and the trip climbs out
  // by its covered-start route (carved steps).
  async function travelNightPit (signal) {
    const NS = rt.require('./travel/night-stop')
    const sleep = ms => new Promise(r => setTimeout(r, ms))
    const wait = async (fn, ms) => { const until = Date.now() + ms; while (Date.now() < until) { if (signal?.aborted) return false; if (fn()) return true; await sleep(200) } return fn() }
    const feet = () => { const p = rt.working().position; return p ? { x: p.x, y: p.y - 1.62, z: p.z } : null }
    const plan = NS.planPit((x, y, z) => rt.host.world.getBlock(x, y, z), feet())
    if (!plan.ready) return { ok: false, reason: plan.reason + (plan.name ? `:${plan.name}` : '') }
    const isAir = c => { const b = rt.host.world.getBlock(c.x, c.y, c.z); return b?.known === true && /^minecraft:(?:air|cave_air)$/.test(b.name ?? '') }
    for (const cell of plan.dig) {
      if (!isAir(cell)) {
        rt.host.shared.travelDownUntil = Date.now() + 40000
        try { rt.operations.mining.start([{ ...cell, accessPreparation: 'travel_down' }]) } catch (error) { return { ok: false, reason: `DIG_REFUSED:${String(error.message ?? error).slice(0, 60)}` } }
        if (!(await wait(() => isAir(cell), 35000))) return { ok: false, reason: 'DIG_UNCONFIRMED' }
      }
      if (!(await wait(() => { const f = feet(); return !!f && f.y <= cell.y + 0.05 }, 5000))) return { ok: false, reason: 'FALL_UNCONFIRMED' }
    }
    const PLACEABLE = /^minecraft:(?:dirt|coarse_dirt|cobblestone|cobbled_deepslate|stone|andesite|diorite|granite|deepslate|netherrack)$/
    const items = () => rt.working().inventory?.items ?? []
    let item = items().find(i => PLACEABLE.test(i.name ?? '') && i.count > 0 && i.slot <= 8) ?? items().find(i => PLACEABLE.test(i.name ?? '') && i.count > 0)
    if (!item) return { ok: false, reason: 'NO_COVER_BLOCK' }
    if (item.slot > 8) { try { await rt.operations.inventory.equip(item.slot) } catch {} item = items().find(i => PLACEABLE.test(i.name ?? '') && i.count > 0 && i.slot <= 8) }
    if (!item) return { ok: false, reason: 'COVER_NOT_IN_HOTBAR' }
    try { await rt.operations.interactions.placeBlock({ position: plan.cover, slot: item.slot }) } catch (error) { return { ok: false, reason: `COVER_REFUSED:${String(error.message ?? error).slice(0, 60)}` } }
    const covered = await wait(() => { const b = rt.host.world.getBlock(plan.cover.x, plan.cover.y, plan.cover.z); return b?.known === true && b.boundingBox === 'block' }, 5000)
    return covered ? { ok: true, cover: plan.cover } : { ok: false, reason: 'COVER_UNCONFIRMED' }
  }
  // Getting down from a canopy during long travel (coordinator 2026-11-14,
  // choice A): only the leaves directly under the feet are broken by the
  // ordinary mining; nothing is picked up on purpose. The spot is chosen on
  // received terrain: every cell down to received solid ground, and the fall
  // damage (each air run minus three) leaves at least six health.
  async function travelHoldTool (blockName) {
    const soft = /dirt|grass_block|gravel|sand|clay|snow|mud|podzol|mycelium|farmland|soul_soil/.test(String(blockName ?? ''))
    const kind = soft ? 'shovel' : 'pickaxe'
    const tier = n => ['wooden', 'golden', 'stone', 'iron', 'diamond', 'netherite'].findIndex(t => n.startsWith(`minecraft:${t}_`))
    const items = rt.working().inventory?.items ?? []
    const tool = items.filter(i => i.count > 0 && i.slot < 36 && new RegExp(`_${kind}$`).test(i.name ?? '')).sort((a, b) => tier(b.name) - tier(a.name))[0]
    if (!tool) return false
    if (rt.working().heldItem?.name === tool.name) return true
    await rt.inventory.equipForMining(tool.slot)
    return true
  }
  async function travelLeafEscape (signal) {
    const sleep = ms => new Promise(r => setTimeout(r, ms))
    const feetOf = () => { const q = rt.working().position; return q ? { x: q.x, y: q.y - 1.62, z: q.z } : null }
    const at = (x, y, z) => rt.host.world.getBlock(x, y, z)
    const leaf = b => b?.known === true && /leaves$/.test(b.name ?? '')
    const f0 = feetOf(); if (!f0) return { attempted: false }
    // Live 14:09: after one leaf the bot landed on a branch (log) over a ravine;
    // a canopy branch counts as canopy too (only leaves are ever broken).
    // Every block under the 0.6-wide footprint (live 14:17: the bot stood on the
    // leaf next to its own column).
    const canopyBlock = b => leaf(b) || b?.known === true && /_log$/.test(b.name ?? '')
    const under = []
    for (const ox of [-0.3, 0.3]) for (const oz of [-0.3, 0.3]) { const b = at(Math.floor(f0.x + ox), Math.round(f0.y) - 1, Math.floor(f0.z + oz)); if (b?.boundingBox === 'block' || b?.known !== true) under.push(b) }
    if (!under.length || !under.every(canopyBlock)) return { attempted: false }
    const descent = (x, sy, z) => {
      let damage = 0, run = 0
      for (let y = sy - 1; y >= sy - 30; y--) {
        const b = at(x, y, z)
        if (b?.known !== true) return null
        if (leaf(b)) { damage += Math.max(0, run - 3); run = 0; continue }
        if (/^minecraft:(?:air|cave_air)$/.test(b.name ?? '') || b.boundingBox === 'empty' && !/water|lava|fire/.test(b.name ?? '')) { run++; continue }
        if (b.boundingBox !== 'block' || /water|lava|fire|magma|cactus|powder_snow|_log$/.test(b.name ?? '')) return null // a branch is not ground (live 14:13)
        return { damage: damage + Math.max(0, run - 3), ground: y }
      }
      return null
    }
    const health = rt.working().health ?? 0
    const cands = []
    for (let dx = -6; dx <= 6; dx++) for (let dz = -6; dz <= 6; dz++) {
      const x = Math.floor(f0.x) + dx, z = Math.floor(f0.z) + dz
      for (const sy of [Math.round(f0.y), Math.round(f0.y) - 1, Math.round(f0.y) + 1, Math.round(f0.y) - 2, Math.round(f0.y) + 2]) {
        if (!leaf(at(x, sy - 1, z)) || at(x, sy, z)?.boundingBox !== 'empty' || at(x, sy + 1, z)?.boundingBox !== 'empty') continue
        const d = descent(x, sy, z)
        if (d && health - d.damage >= 6) cands.push({ x, y: sy, z, ...d, dist: Math.hypot(dx, dz) })
      }
    }
    cands.sort((a, b) => a.damage - b.damage || a.dist - b.dist)
    if (!cands.length) return { attempted: true, ok: false, reason: '受信した地面まで安全に降りられる場所がありません' }
    for (const c of cands.slice(0, 8)) {
      if (signal?.aborted) return { attempted: true, ok: false, reason: 'cancelled' }
      const here = feetOf()
      if (Math.floor(here.x) !== c.x || Math.floor(here.z) !== c.z || Math.round(here.y) !== c.y) {
        const t = { x: c.x + 0.5, y: c.y, z: c.z + 0.5 }, opts = { allowWater: false, allowLowHealth: true, maxDistance: 16 }
        let pv = null; try { rt.motionOrigin = rt.working(); pv = rt.movement?.preview(t, opts) } catch {}
        if (pv?.ready !== true) continue
        try { rt.requireIdle({ inventoryRequired: false }); rt.startMotion('navigation', t, opts) } catch { continue }
        const until = Date.now() + 20000
        while (Date.now() < until) { const m = rt.movement?.snapshot() ?? {}; if (!['moving', 'settling'].includes(m.phase)) break; await sleep(200) }
        const f = feetOf(); if (!f || Math.floor(f.x) !== c.x || Math.floor(f.z) !== c.z) continue
      }
      rt.host.log(`長距離移動: 葉の上から降ります (${c.x},${c.y},${c.z}) 地面 y${c.ground}・落下の見込み ${c.damage}`)
      for (let i = 0; i < 30 && !signal?.aborted; i++) {
        const f = feetOf(); if (!f) return { attempted: true, ok: false, reason: '位置が不明' }
        const cell = { x: Math.floor(f.x), y: Math.round(f.y) - 1, z: Math.floor(f.z) }
        if (!leaf(at(cell.x, cell.y, cell.z))) return { attempted: true, ok: true }
        rt.host.shared.travelDownUntil = Date.now() + 40000
        try { rt.operations.mining.start([{ ...cell, accessPreparation: 'travel_down' }]) } catch (error) { return { attempted: true, ok: false, reason: `葉を壊せません: ${String(error.message ?? error).slice(0, 80)}` } }
        const until = Date.now() + 15000
        while (Date.now() < until && leaf(at(cell.x, cell.y, cell.z))) await sleep(150)
        if (leaf(at(cell.x, cell.y, cell.z))) return { attempted: true, ok: false, reason: '葉の採掘を確認できません' }
        // Wait for the received position to settle after the fall.
        let last = null, still = 0
        for (let k = 0; k < 40 && still < 4; k++) { await sleep(150); const q = feetOf(); if (q && last && Math.abs(q.y - last.y) < 0.01) still++; else still = 0; last = q }
      }
      return { attempted: true, ok: false, reason: '降り切れませんでした' }
    }
    // No descent spot is reachable in one walk (live 14:11, a leaf pocket on a
    // branch): take one accepted step on the canopy toward the best spot; the
    // next pass tries again from there.
    const best = cands[0], here = feetOf()
    const steps = []
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (const dy of [0, 1, -1, 2]) {
      const x = Math.floor(here.x) + dx, z = Math.floor(here.z) + dz, y = Math.round(here.y) + dy
      if (!dx && !dz) continue
      const floor = at(x, y - 1, z)
      if (!(leaf(floor) || floor?.known === true && /_log$/.test(floor.name ?? '')) || at(x, y, z)?.boundingBox !== 'empty' || at(x, y + 1, z)?.boundingBox !== 'empty') continue
      const gain = Math.hypot(best.x - Math.floor(here.x), best.z - Math.floor(here.z)) - Math.hypot(best.x - x, best.z - z)
      if (gain > 0.5) steps.push({ x, y, z, gain })
    }
    steps.sort((a, b) => b.gain - a.gain)
    for (const st of steps.slice(0, 10)) {
      const t = { x: st.x + 0.5, y: st.y, z: st.z + 0.5 }, opts = { allowWater: false, allowLowHealth: true, maxDistance: 16 }
      let pv = null; try { rt.motionOrigin = rt.working(); pv = rt.movement?.preview(t, opts) } catch {}
      if (pv?.ready !== true) continue
      try { rt.requireIdle({ inventoryRequired: false }); rt.startMotion('navigation', t, opts) } catch { continue }
      const until = Date.now() + 10000
      while (Date.now() < until) { const m = rt.movement?.snapshot() ?? {}; if (!['moving', 'settling'].includes(m.phase)) break; await sleep(200) }
      return { attempted: true, ok: false, reason: `葉の上を降りる場所 (${best.x},${best.z}) へ1歩進みました` }
    }
    return { attempted: true, ok: false, reason: '降りる場所へ歩けません' }
  }
  async function travelBeforeLeg (signal) {
    const NS = rt.require('./travel/night-stop')
    const night = rt.host.shared.travelNight ??= { cover: null, pitTried: 0 }
    const phase = NS.dayPhase(travelClock())
    if (!phase.known) return { hold: true, phase: 'clock_wait', message: '時刻を受信していないため、受信を待ちます', waitMs: 2000 }
    // Resting (live 18:24: skeleton hits piled up to 1 HP and a creeper finished
    // it): below half health with hunger 18 or more the bot heals in the covered
    // pit and leaves it at 18 health (or by night's end when the pit is a night pit).
    const hpNow = rt.working().health ?? 20, hv0 = rt.host.shared.vitals?.hunger, hunger0 = Number.isFinite(hv0) ? hv0 : Number.isFinite(hv0?.value) ? hv0.value : null
    // A rest pit at dusk simply becomes the night pit.
    if (night.cover && night.reason === 'rest' && phase.shelter) night.reason = 'night'
    const resting = night.reason === 'rest'
    if (night.cover && resting && (hpNow >= 18 || hunger0 !== null && hunger0 < 18)) phase.resume = true
    if (night.cover && resting && !phase.resume) return { hold: true, phase: 'rest', message: `体力回復のため穴の中で待ちます（HP ${Math.round(hpNow)}）`, waitMs: 5000 }
    if (!night.cover && !phase.shelter && hpNow < 10 && hunger0 !== null && hunger0 >= 18 && Date.now() - (night.restTriedAt ?? 0) > 60000) {
      night.restTriedAt = Date.now()
      const r = await travelNightPit(signal)
      if (r.ok) { night.cover = r.cover; night.reason = 'rest'; rt.host.log(`長距離移動: HP ${Math.round(hpNow)} のため、ふたをした穴で回復を待ちます`); return { hold: true, phase: 'rest', message: '体力回復のため穴の中で待ちます', waitMs: 5000 } }
    }
    if (phase.resume && night.cover) {
      const c = night.cover
      const air = () => { const v = rt.host.world.getBlock(c.x, c.y, c.z); return v?.known === true && /^minecraft:(?:air|cave_air)$/.test(v.name ?? '') }
      if (!air()) {
        try { rt.operations.mining.start([c]) } catch (error) { return { hold: true, phase: 'morning', message: `朝です。穴のふたを掘れません: ${String(error.message ?? error).slice(0, 60)}`, waitMs: 3000 } }
        const until = Date.now() + 35000
        while (Date.now() < until && !signal?.aborted && !air()) await new Promise(r => setTimeout(r, 200))
        if (!air()) return { hold: true, phase: 'morning', message: '朝です。ふたの採掘を確認できません', waitMs: 3000 }
      }
      rt.host.log(resting ? `長距離移動: 回復しました（HP ${Math.round(hpNow)}）。穴を出て移動を続けます` : `長距離移動: 朝になりました（時刻 ${phase.dayTime}）。穴を出て移動を続けます`)
      night.cover = null; night.pitTried = 0; night.reason = null
    }
    if (phase.shelter) {
      if (!night.cover && night.pitTried < 3) {
        night.pitTried++
        const r = await travelNightPit(signal)
        if (r.ok) { night.cover = r.cover; night.reason = 'night' }
        else return { hold: true, phase: 'night', message: `夕方です（時刻 ${phase.dayTime}）。ここに夜の穴を作れません: ${r.reason}`, waitMs: 3000 }
      }
      return { hold: true, phase: 'night', message: night.cover ? `夜のため、ふたをした穴の中で朝まで待ちます（時刻 ${phase.dayTime}）` : `夜です（時刻 ${phase.dayTime}）。穴を作れなかったため、その場で朝まで待ちます`, waitMs: 5000 }
    }
    night.pitTried = 0
    // Food (2026-11-14): below hunger 18 natural healing stops; eat, or hunt
    // within 24 m by the food step of the preparation gatherer (no wood).
    const v = rt.host.shared.vitals?.hunger, hunger = Number.isFinite(v) ? v : Number.isFinite(v?.value) ? v.value : null
    // Between legs is the trip's safe point for armour (no enemy within 8 m,
    // inventory confirmed and the screen free).
    try { if (!rt.armorTask && rt.armor.preview() && rt.armorWorkFree() && !rt.armorThreatNear()) { const moves = await rt.armor.equipBest(); if (moves.some(m => m.serverConfirmed)) rt.host.log(`長距離移動: 装備を着けました（${moves.filter(m => m.serverConfirmed).map(m => m.name.replace('minecraft:', '')).join('・')}）`) } } catch {}
    // Shooters (live 16:22: a pillager shot the bot from 20 to 0 while the trip
    // kept trying legs): retreat out of range first.
    try { if (await travelShooterRetreat(signal)) return { hold: false } } catch {}
    if (hunger !== null && hunger < 18) { try { await rt.operations.quarry.prepGather({ logs: 0, maxMs: 90000 }) } catch {} }
    // The boat was lost (coordinator 2026-11-14): within the preparation
    // allowance, with trees near, gather a few logs and craft a boat again.
    try { await travelRespawnBed(signal) } catch (error) { rt.host.log(`長距離移動: ベッドでのリスポーン地点の設定に失敗しました: ${String(error.message ?? error).slice(0, 100)}`) }
    try { await travelMakeBoat(signal) } catch (error) { rt.host.log(`長距離移動: ボートを作れませんでした: ${String(error.message ?? error).slice(0, 100)}`) }
    return { hold: false }
  }
  // Retreat from shooters during long travel: a shooter within 20 m and a hit
  // in the last 5 s (or the shooter within 10 m) moves the bot 5-12 m straight
  // away by the ordinary movement (sprinting when hunger allows).
  const dangerFile = () => rt.require('node:path').resolve(rt.__dirname, '..', '.local', 'long-travel', 'danger.json')
  function travelDangerZones () {
    if (!rt.host.shared.travelDangerZones) { try { rt.host.shared.travelDangerZones = JSON.parse(rt.require('node:fs').readFileSync(dangerFile(), 'utf8')) } catch { rt.host.shared.travelDangerZones = [] } }
    // Live 22:24: the bot died a third time beside the pillager zone; an outpost
    // and its patrols reach farther than 48 m. Pillager zones count 120 m.
    for (const z of rt.host.shared.travelDangerZones) if (/pillager|vindicator|evoker/.test(z.kind ?? '') && z.r < 120) z.r = 120
    return rt.host.shared.travelDangerZones
  }
  // Inside a remembered danger zone (live 22:24: the fallback chunk moves and
  // relay points ignored the zones and walked the bot into one).
  function inDangerZone (x, z) { let goal = null; try { goal = longTravel?.status?.().destination ?? null } catch {} return rt.require('./travel/danger-zones').inZone(travelDangerZones(), x, z, goal) }
  function travelAddDangerZone (p, kind) {
    const zones = travelDangerZones()
    if (zones.some(z => Math.hypot(z.x - p.x, z.z - p.z) < 24)) return
    zones.push({ x: Math.round(p.x), z: Math.round(p.z), r: /pillager|vindicator|evoker/.test(kind) ? 120 : 48, kind, at: new Date().toISOString() })
    rt.host.log(`長距離移動: 危険地帯を記録しました (${Math.round(p.x)}, ${Math.round(p.z)}) ${kind.replace('minecraft:', '')}・半径48m`)
    try { rt.require('node:fs').mkdirSync(rt.require('node:path').dirname(dangerFile()), { recursive: true }); rt.require('node:fs').writeFileSync(dangerFile(), JSON.stringify(zones, null, 2)) } catch {}
  }
  async function travelShooterRetreat (signal) {
    const SHOOT = rt.require('./safety/learning-health').SHOOTING
    const p = rt.working().position; if (!p) return false
    const feet = { x: p.x, y: p.y - 1.62, z: p.z }
    const sh = rt.allActors().filter(a => a?.hostile === true && a.alive !== false && a.position && SHOOT.test(String(a.entityType ?? a.name ?? '')) && !/drowned/.test(String(a.entityType ?? a.name ?? '')) && Math.hypot(a.position.x - feet.x, a.position.z - feet.z) <= 20)
    if (!sh.length) return false
    const nearest = Math.min(...sh.map(a => Math.hypot(a.position.x - feet.x, a.position.z - feet.z)))
    const hurt = Date.now() - (rt.host.shared.travelLastDamageAt ?? 0) < 5000
    // Before the shooter's range (coordinator 2026-11-14): within 16 m, or hit.
    if (!hurt && nearest > 16) return false
    // Live 22:22: five skeletons at 1-2 m while the bot (diamond sword) kept trying
    // to walk away in water. Within 4 m an armed bot leaves it to combat.
    if (nearest < 4 && (rt.working().inventory?.items ?? []).some(i => /_sword$|_axe$/.test(i.name ?? ''))) return false
    if (rt.require('./travel/travel-shooters').playerArmedAndWell({ shared: rt.host.shared, health: rt.working().health, items: rt.working().inventory?.items, hurt })) return false
    const low = (rt.working().health ?? 20) < 10
    if (hurt) for (const a of sh.filter(o => Math.hypot(o.position.x - feet.x, o.position.z - feet.z) <= 24)) travelAddDangerZone(a.position, String(a.entityType ?? a.name ?? ''))
    return retreatStep(sh, feet, { signal, low, label: `長距離移動: 射撃する敵（${sh.map(a => String(a.entityType ?? a.name).replace('minecraft:', '')).join('・')}、${Math.round(nearest)}m）から離れます` })
  }
  // One step (5-12 m) straight away from the given enemies by the ordinary
  // movement, sprinting when hunger allows. With `low`, a spot none of them can
  // see (a solid received block on the line between eyes) is preferred.
  async function retreatStep (sh, feet, { signal = null, low = false, label = null } = {}) {
    const covered = t => sh.every(a => { const sx = a.position.x, sy = a.position.y + 1.5, sz = a.position.z, tx = t.x, ty = t.y + 1.6, tz = t.z, n = Math.ceil(Math.hypot(tx - sx, ty - sy, tz - sz) * 2); for (let i = 1; i < n; i++) { const f = i / n, b = rt.host.world.getBlock(Math.floor(sx + (tx - sx) * f), Math.floor(sy + (ty - sy) * f), Math.floor(sz + (tz - sz) * f)); if (b?.known === true && b.boundingBox === 'block') return true } return false })
    let ax = 0, az = 0
    for (const a of sh) { const dx = feet.x - a.position.x, dz = feet.z - a.position.z, d = Math.max(0.5, Math.hypot(dx, dz)); ax += dx / d; az += dz / d }
    const base = Math.atan2(az, ax)
    const v = rt.host.shared.vitals?.hunger, hunger = Number.isFinite(v) ? v : Number.isFinite(v?.value) ? v.value : 0
    const opts = { allowWater: true, allowLowHealth: true, maxDistance: 16, sprint: hunger > 6 }
    const until = Date.now() + 1500
    for (const d of [12, 8, 5]) for (const deg of [0, 30, -30, 60, -60, 90, -90]) {
      if (signal?.aborted || Date.now() > until) return false
      const ang = base + deg * Math.PI / 180
      const x = Math.floor(feet.x + Math.cos(ang) * d) + 0.5, z = Math.floor(feet.z + Math.sin(ang) * d) + 0.5
      for (const dy of [0, 1, -1, 2, -2]) {
        const t = { x, y: Math.round(feet.y) + dy, z }
        let pv = null; try { rt.motionOrigin = rt.working(); pv = rt.movement?.preview(t, opts) } catch {}
        await new Promise(resolve => setImmediate(resolve))
        if (pv?.ready !== true) continue
        if (low && !covered(t) && Date.now() < until - 700) continue
        try { rt.requireIdle({ inventoryRequired: false }); rt.startMotion('navigation', t, opts) } catch { return false }
        if (label) rt.host.log(label)
        const stop = Date.now() + 8000
        while (Date.now() < stop) { const m = rt.movement?.snapshot() ?? {}; if (!['moving', 'settling'].includes(m.phase)) break; await new Promise(r => setTimeout(r, 200)) }
        return true
      }
    }
    return false
  }
  // Player mode's retreat when badly hurt: one such step away from every
  // hostile within 16 m. Returns false when no step could start.
  async function retreatFromHostiles (signal) {
    const p = rt.working().position; if (!p) return false
    const feet = { x: p.x, y: p.y - 1.62, z: p.z }
    const near = rt.allActors().filter(a => a?.hostile === true && a.alive !== false && a.position && Math.hypot(a.position.x - feet.x, a.position.z - feet.z) <= 16)
    return near.length ? retreatStep(near, feet, { signal }) : false
  }
  // Respawn point on a long trip (coordinator 2026-11-14: every death sent the
  // bot back to the world spawn, about 1,000 m). A bed is crafted from three
  // wool and planks, placed, used (a day use only sets the spawn point), the new
  // spawn point is confirmed by the server's set_spawn_position, and the bed is
  // mined back under this trip's own placement record. No command is used.
  function travelBedOwns (target, block) {
    const rec = rt.host.shared.travelBed
    if (!rec || target?.ownershipKey !== rec.key || block?.name !== 'minecraft:bed' || rec.life !== rt.actualLifeId()) return false
    return [rec.foot, rec.head].some(p => p && p.x === target.x && p.y === target.y && p.z === target.z)
  }
  async function mineTravelBed (foot, key) {
    const isBed = p => rt.host.world.getBlock(p.x, p.y, p.z)?.name === 'minecraft:bed'
    rt.requireIdle({ inventoryRequired: false })
    rt.operations.mining.start([{ ...foot, accessPreparation: 'owned_bed', expectedName: 'minecraft:bed', ownershipKey: key }])
    const mineUntil = Date.now() + 15000
    while (Date.now() < mineUntil && isBed(foot)) await new Promise(r => setTimeout(r, 200))
    if (!isBed(foot)) await rt.operations.quarry.pickupNear({ center: foot, radius: 5, maxMs: 15000 })
  }
  async function travelRespawnBed (signal) {
    const leftover = rt.require('./travel/travel-bed-leftover')
    try { await leftover.recoverLeftover({ shared: rt.host.shared, getBlock: (x, y, z) => rt.host.world.getBlock(x, y, z), mine: mineTravelBed, log: m => rt.host.log(m) }) } catch {}
    if (leftover.houseOwnsSpawn(rt.host.shared)) return { ok: false, reason: 'PLAYER_HOUSE' }
    const items = () => rt.working().inventory?.items ?? []
    const st = rt.working(); if (!st.position) return { ok: false }
    const feet = { x: st.position.x, y: st.position.y - 1.62, z: st.position.z }
    const spawn = rt.host.shared.travelSpawn ?? { x: -8, z: 14 }
    if (Math.hypot(feet.x - spawn.x, feet.z - spawn.z) < 300) return { ok: false, reason: 'NEAR_SPAWN' }
    const memo = rt.host.shared.travelBedMemo ??= { lastTry: 0 }
    if (Date.now() - memo.lastTry < 120000) return { ok: false, reason: 'RECENT' }
    if (rt.nearestHostileDistance() < 16) return { ok: false, reason: 'HOSTILE_NEAR' }
    memo.lastTry = Date.now()
    const bed = () => items().find(i => i.name === 'minecraft:bed' && i.count > 0)
    const WOOL = /^minecraft:[a-z_]*wool$/
    const wool = () => items().filter(i => WOOL.test(i.name ?? '')).reduce((n, i) => n + i.count, 0)
    if (!bed()) {
      if (wool() < 3) { await rt.operations.quarry.prepGather({ logs: 0, wool: 3, maxMs: 120000 }); if (wool() < 3) return { ok: false, reason: 'NO_WOOL' } }
      const LOGS = /^minecraft:([a-z_]+)_log$/, PLANKS = /^minecraft:([a-z_]+)_planks$/
      const planks = () => items().filter(i => PLANKS.test(i.name ?? '')).reduce((n, i) => n + i.count, 0)
      const log = items().filter(i => LOGS.test(i.name ?? '')).sort((a, b) => b.count - a.count)[0]
      if (planks() < 7 && !log) return { ok: false, reason: 'NO_WOOD' }
      rt.host.log('長距離移動: ベッドを作ります')
      await rt.crafting.openInventory()
      try { if (planks() < 7) await rt.crafting.craft(`minecraft:${LOGS.exec(log.name)[1]}_planks`, { times: Math.min(log.count, 2) }); await rt.crafting.craft('minecraft:crafting_table', { times: 1 }) } finally { try { rt.crafting.closeContainer() } catch {} }
      const placed = await travelPlaceTable()
      if (!placed) return { ok: false, reason: 'TABLE_NOT_PLACED' }
      await rt.interactions.openCraftingTable(placed)
      try { await rt.crafting.craft('minecraft:bed', { times: 1 }) } finally { try { rt.crafting.closeContainer() } catch {} }
      if (!bed()) return { ok: false, reason: 'BED_NOT_CRAFTED' }
    }
    // Place: a foot cell beside the bot with its head cell, both received air on solid ground.
    let item = bed(); if (item.slot > 8) { await rt.operations.inventory.equip(item.slot); item = items().find(i => i.name === 'minecraft:bed' && i.slot <= 8) }
    if (!item) return { ok: false, reason: 'BED_NOT_IN_HOTBAR' }
    const fx = Math.floor(feet.x), fy = Math.round(feet.y), fz = Math.floor(feet.z)
    let foot = null
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [0, 2], [-2, 0], [0, -2]]) {
      const pos = { x: fx + dx, y: fy, z: fz + dz }
      try { rt.requireIdle({ inventoryRequired: false }); await rt.interactions.placeBed({ position: pos, slot: item.slot }); foot = pos; break } catch {}
    }
    if (!foot) return { ok: false, reason: 'BED_NOT_PLACED' }
    const isBed = p => rt.host.world.getBlock(p.x, p.y, p.z)?.name === 'minecraft:bed'
    const head = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => ({ x: foot.x + dx, y: foot.y, z: foot.z + dz })).find(isBed) ?? null
    if (!isBed(foot)) return { ok: false, reason: 'BED_PLACEMENT_UNCONFIRMED' }
    rt.host.shared.travelBed = { key: `travel_bed:${Date.now()}`, foot, head, life: rt.actualLifeId() }
    const t0 = Date.now()
    try { rt.requireIdle({ inventoryRequired: false }); await rt.interactions.useBed(foot) } catch {}
    const until = Date.now() + 6000
    while (Date.now() < until && !(rt.host.shared.lastSpawnSet?.at > t0)) await new Promise(r => setTimeout(r, 200))
    const set = rt.host.shared.lastSpawnSet
    const confirmed = set?.at > t0 && set.position && Math.hypot(set.position.x - foot.x, set.position.z - foot.z) <= 3
    if (confirmed) { rt.host.shared.travelSpawn = { x: foot.x, z: foot.z, at: new Date().toISOString() }; rt.host.log(`長距離移動: リスポーン地点を (${foot.x}, ${foot.y}, ${foot.z}) に設定しました（サーバーの通知で確認）`) }
    else rt.host.log(`長距離移動: ベッドに触れましたが、リスポーン地点の設定を確認できません${set?.at > t0 ? `（通知 ${JSON.stringify(set.position)}）` : ''}`)
    // Take the bed back under this trip's own placement record.
    try { if (rt.working().sleeping) await rt.interactions.wakeBed?.(foot) } catch {}
    try {
      await mineTravelBed(foot, rt.host.shared.travelBed.key)
      if (!isBed(foot)) rt.host.shared.travelBed = null
    } catch (error) { rt.host.log(`長距離移動: ベッドを回収できません: ${String(error.message ?? error).slice(0, 80)}`) }
    rt.host.log(`長距離移動: ベッド${bed() ? 'を回収しました（受信した持ち物で確認）' : 'の回収を確認できません'}`)
    return { ok: confirmed, recovered: !!bed() }
  }
  async function travelPlaceTable () {
    const items = () => rt.working().inventory?.items ?? []
    let t = items().find(i => i.name === 'minecraft:crafting_table')
    if (!t) return null
    if (t.slot > 8) { await rt.operations.inventory.equip(t.slot); t = items().find(i => i.name === 'minecraft:crafting_table' && i.slot <= 8) }
    if (!t) return null
    const p = rt.working().position, fx = Math.floor(p.x), fy = Math.round(p.y - 1.62), fz = Math.floor(p.z)
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      const pos = { x: fx + dx, y: fy, z: fz + dz }, at = rt.host.world.getBlock(pos.x, pos.y, pos.z), below = rt.host.world.getBlock(pos.x, pos.y - 1, pos.z)
      if (at?.known !== true || at.name !== 'minecraft:air' || below?.known !== true || below.boundingBox !== 'block') continue
      try { await rt.interactions.placeCraftingTable({ position: pos, slot: t.slot }); return pos } catch {}
    }
    return null
  }
  function travelShulkerOwns (target, block) {
    const rec = rt.host.shared.travelShulker
    if (!rec || target?.ownershipKey !== rec.key || rec.life !== rt.actualLifeId()) return false
    if (!(target.x === rec.position.x && target.y === rec.position.y && target.z === rec.position.z)) return false
    return !block || block.name === rec.name || /^minecraft:(?:air|cave_air)$/.test(block.name ?? '')
  }
  async function travelSupplyBoxTake ({ chest: home, chestSlot, boxName, take = [] } = {}) {
    if (rt.quarryJob?.holdsWork()) throw new Error('露天掘りの作業中です。')
    if (longTravel?.status?.().busy) throw new Error('長距離移動の途中です。')
    if (rt.armorThreatNear()) throw new Error('攻撃が届く敵が近くにいます。')
    const say = m => rt.host.log(`補給箱: ${m}`)
    const items = () => rt.working().inventory?.items ?? []
    const sleep = ms => new Promise(r => setTimeout(r, ms))
    const wait = async (fn, ms) => { const until = Date.now() + ms; while (Date.now() < until) { if (fn()) return true; await sleep(200) } return fn() }
    const isAir = p => { const b = rt.host.world.getBlock(p.x, p.y, p.z); return b?.known === true && /^minecraft:(?:air|cave_air)$/.test(b.name ?? '') }
    // 1. the box out of the home chest
    await rt.operations.chest.open(home)
    await rt.operations.chest.withdrawItem({ chestSlot, count: 1, expectedName: boxName })
    try { rt.crafting.closeContainer() } catch {}
    let box = items().find(i => i.name === boxName)
    if (!box) throw new Error('箱を持ち物で確認できません。')
    if (box.slot > 8) { await rt.operations.inventory.equip(box.slot); box = items().find(i => i.name === boxName && i.slot <= 8) }
    if (!box) throw new Error('箱をホットバーへ移せません。')
    // 2. place it beside the bot (not on the chest cells)
    const p = rt.working().position, fx = Math.floor(p.x), fy = Math.round(p.y - 1.62), fz = Math.floor(p.z)
    let at = null
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const pos = { x: fx + dx, y: fy, z: fz + dz }, below = rt.host.world.getBlock(pos.x, pos.y - 1, pos.z), above = rt.host.world.getBlock(pos.x, pos.y + 1, pos.z)
      if (!isAir(pos) || below?.known !== true || below.boundingBox !== 'block' || /chest|shulker/.test(below.name ?? '') || !isAir({ x: pos.x, y: pos.y + 1, z: pos.z }) || above?.known !== true) continue
      try { await rt.operations.interactions.placeBlock({ position: pos, slot: box.slot }); if (await wait(() => rt.host.world.getBlock(pos.x, pos.y, pos.z)?.name === boxName, 3000)) { at = pos; break } } catch {}
    }
    if (!at) throw new Error('箱を置けません（置いた箱を受信できません）。')
    rt.host.shared.travelShulker = { key: `travel_box:${Date.now()}`, position: at, name: boxName, life: rt.actualLifeId() }
    say(`${boxName.replace('minecraft:', '')} を (${at.x}, ${at.y}, ${at.z}) に置きました`)
    // 3. open it and take the items
    const got = {}
    await rt.operations.chest.open(at)
    const snap = rt.operations.chest.snapshot(), slots = Array.isArray(snap.slots) ? snap.slots : []
    for (const want of take) {
      let left = want.count
      for (const sl of slots.filter(s => s?.name === want.name && s.count > 0)) {
        if (left <= 0) break
        const n = Math.min(left, sl.count)
        try { await rt.operations.chest.withdrawItem({ chestSlot: sl.slot, count: n, expectedName: want.name }); left -= n; got[want.name] = (got[want.name] ?? 0) + n } catch (error) { say(`取り出せません: ${String(error.message ?? error).slice(0, 60)}`); break }
      }
    }
    try { rt.crafting.closeContainer() } catch {}
    // 4. break it under this placement's record and recover it
    rt.host.shared.travelShulkerHold = { operationId: rt.host.shared.travelShulker.key, stage: 'break_to_recover' }
    try {
      rt.operations.mining.start([{ ...at, accessPreparation: 'owned_shulker', expectedName: boxName, ownershipKey: rt.host.shared.travelShulker.key }])
      if (!(await wait(() => isAir(at), 20000))) throw new Error('箱の破壊を受信できません。')
      const before = items().filter(i => i.name === boxName).length
      for (let i = 0; i < 3 && items().filter(x => x.name === boxName).length <= before - 0 && !items().some(x => x.name === boxName); i++) await rt.operations.quarry.pickupNear({ center: at, radius: 4, maxMs: 10000 })
      if (!(await wait(() => items().some(x => x.name === boxName), 5000))) throw new Error('箱の回収を受信した持ち物で確認できません。')
    } finally { rt.host.shared.travelShulkerHold = null }
    // 5. back into the home chest
    await rt.operations.chest.open(home)
    const back = items().find(i => i.name === boxName)
    await rt.operations.chest.depositItem({ sourceSlot: back.slot, count: 1, chestSlot, expectedName: boxName })
    try { rt.crafting.closeContainer() } catch {}
    rt.host.shared.travelShulker = null
    say(`取り出したもの: ${Object.entries(got).map(([k, v]) => `${k.replace('minecraft:', '')}×${v}`).join('・') || 'なし'}。箱はチェストへ戻しました（受信した持ち物で確認）`)
    return { ok: true, got }
  }
  async function travelMakeBoat (signal) {
    const items = () => rt.working().inventory?.items ?? []
    if (items().some(i => /_boat$/.test(i.name ?? '') && i.count > 0)) return { ok: true, have: true }
    if (!rt.longTravelLogAllowance()) return { ok: false, reason: 'NO_ALLOWANCE' }
    const now = Date.now(), memo = rt.host.shared.travelBoatMemo ??= { lastTry: 0 }
    if (now - memo.lastTry < 300000) return { ok: false, reason: 'RECENT' }
    memo.lastTry = now
    const LOGS = /^minecraft:([a-z_]+)_log$/
    const logs = () => items().filter(i => LOGS.test(i.name ?? '')).reduce((n, i) => n + i.count, 0)
    if (logs() < 3 && rt.require('./travel/travel-boat-wood').gatherBoatLogs(rt.host.shared)) { await rt.operations.quarry.prepGather({ logs: 3, maxMs: 120000 }) }
    if (signal?.aborted || logs() < 3) return { ok: false, reason: 'NO_LOGS' }
    const log = items().filter(i => LOGS.test(i.name ?? '')).sort((a, b) => b.count - a.count)[0]
    const wood = LOGS.exec(log.name)[1]
    rt.host.log(`長距離移動: ボートを作ります（${wood}）`)
    await rt.crafting.openInventory()
    try { await rt.crafting.craft(`minecraft:${wood}_planks`, { times: 3 }); await rt.crafting.craft('minecraft:crafting_table', { times: 1 }) } finally { try { rt.crafting.closeContainer() } catch {} }
    const table = items().find(i => i.name === 'minecraft:crafting_table' && i.slot <= 8) ?? items().find(i => i.name === 'minecraft:crafting_table')
    if (!table) return { ok: false, reason: 'NO_TABLE' }
    if (table.slot > 8) await rt.operations.inventory.equip(table.slot)
    const t = items().find(i => i.name === 'minecraft:crafting_table' && i.slot <= 8)
    const p = rt.working().position, fx = Math.floor(p.x), fy = Math.round(p.y - 1.62), fz = Math.floor(p.z)
    let placed = null
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      const pos = { x: fx + dx, y: fy, z: fz + dz }, at = rt.host.world.getBlock(pos.x, pos.y, pos.z), below = rt.host.world.getBlock(pos.x, pos.y - 1, pos.z)
      if (at?.known !== true || !/^minecraft:air$/.test(at.name ?? '') || below?.known !== true || below.boundingBox !== 'block') continue
      try { await rt.interactions.placeCraftingTable({ position: pos, slot: t.slot }); placed = pos; break } catch {}
    }
    if (!placed) return { ok: false, reason: 'TABLE_NOT_PLACED' }
    await rt.interactions.openCraftingTable(placed)
    try { await rt.crafting.craft(`minecraft:${wood}_boat`, { times: 1 }) } finally { try { rt.crafting.closeContainer() } catch {} }
    const ok = items().some(i => /_boat$/.test(i.name ?? '') && i.count > 0)
    rt.host.log(`長距離移動: ボート${ok ? 'を作りました（受信した持ち物で確認）' : 'を確認できません'}`)
    return { ok }
  }
  // Resume a trip that the previous code was running when it was reloaded
  // (bounded: within ten minutes, once, after the bot is spawned and idle).
  // Live 14:42: a reconnect also stopped the trip; the saved trip file (phase
  // still moving, saved within 15 minutes, not stopped by hand) resumes it too.
  let travelFileChecked = false
  const travelResumeTimer = setInterval(async () => {
    if (rt.disposed || rt.disposing) { clearInterval(travelResumeTimer); return }
    if (rt.raw().phase !== 'spawned' || rt.quarryJob?.holdsWork() || longTravel?.status?.().busy) return
    // Never inside a node --test child (live 17:10: a test scene with the live Realm id resumed the real trip and hung the comparison).
    if (!rt.host.shared.longTravelResume && !travelFileChecked && process.env.NODE_TEST_CONTEXT) travelFileChecked = true
    if (!rt.host.shared.longTravelResume && !travelFileChecked) {
      travelFileChecked = true
      try { const doc = JSON.parse(await rt.require('node:fs/promises').readFile(longTravelFile(), 'utf8')); // Only the same Realm and profile the trip was saved for (live 16:13: a test
      // runtime resumed the live trip from the shared file and never exited).
      if (['moving', 'cancelled'].includes(doc?.phase) && doc.realmId != null && doc.realmId === String(rt.raw().realm?.id ?? '') && doc.profile === (rt.raw().profile ?? null) && doc.destination && Date.now() - Date.parse(doc.savedAt) < 900000) rt.host.shared.longTravelResume = { destination: { x: doc.destination.x, z: doc.destination.z }, at: Date.now() } } catch {}
    }
    if (rt.host.shared.longTravelResume && !rt.require('./travel/travel-resume').resumeTrip(rt.host.shared)) rt.host.shared.longTravelResume = null
    const r = rt.host.shared.longTravelResume
    if (!r) { if (travelFileChecked) clearInterval(travelResumeTimer); return }
    if (Date.now() - r.at > 600000) { rt.host.shared.longTravelResume = null; return }
    if (rt.raw().phase !== 'spawned' || rt.quarryJob?.holdsWork() || longTravel?.status?.().busy) return
    rt.host.shared.longTravelResume = null
    Promise.resolve().then(() => rt.operations.quarry.travelTo({ destination: r.destination })).then(() => rt.host.log(`長距離移動: 行動コードの反映後に移動を再開しました（目的地 ${r.destination.x}, ${r.destination.z}）`), error => rt.host.log(`長距離移動: 反映後の再開に失敗しました: ${String(error.message ?? error).slice(0, 100)}`))
  }, 2000)
  travelResumeTimer.unref?.() // never keeps a process (or a test) alive
  function ensureLongTravel () {
    if (longTravel) return longTravel
    longTravel = rt.require('./travel/long-travel').createLongTravel({
      getState: rt.quarryState,
      // One line per pass (coordinator 2026-11-14: measure distance per hour and where the time goes).
      record: async entry => { const f = rt.require('node:path').resolve(rt.__dirname, '..', '.local', 'long-travel', 'legs.jsonl'); await rt.require('node:fs/promises').mkdir(rt.require('node:path').dirname(f), { recursive: true }); await rt.require('node:fs/promises').appendFile(f, JSON.stringify(entry) + '\n') },
      chunkTravel: { start: input => { const a = input?.area; if (a && Number.isFinite(a.x1) && Number.isFinite(a.z1)) { const cx = a.x1 * 16 + 8, cz = a.z1 * 16 + 8, p = rt.quarryState().position; if (inDangerZone(cx, cz) && !(p && inDangerZone(p.x, p.z))) throw Object.assign(new Error('危険地帯の中のチャンクへは移動しません'), { code: 'CHUNK_TRAVEL_DANGER_ZONE' }) } return ensureChunkTravel().start(input) }, status: () => ensureChunkTravel().status(), cancel: reason => rt.cancelChunkMovement(reason ?? 'LONG_TRAVEL') },
      // Only a read request; the chunk travel itself uses received terrain only.
      requestTerrain: async (area, { signal } = {}) => { const st = rt.quarryState(); const y = Math.floor((st.position?.y ?? 65) - 1.62); return rt.requestQuarryTerrain({ config: { target: { chunks: [{ x: area.x1, z: area.z1 }] } }, yTop: Math.min(300, y + 12), yBottom: Math.max(-60, y - 12) }, { signal }) },
      terrainRevision: () => rt.host.world.revision?.() ?? null,
      inventoryReady: () => { try { return rt.inventoryStore.missing().length === 0 } catch { return false } },
      // Arrival counts only under open sky (live 12:13: 'arrived' in a cave at y-33).
      onSurface: feet => rt.require('./travel/open-sky').openSky((x, y, z) => rt.host.world.getBlock(x, y, z), feet),
      // Point legs: a walkable received point toward the destination (distance,
      // angle and height samples), previewed by the ordinary movement planner.
      // Between legs (2026-11-14): the night stop by the received clock, then food.
      beforeLeg: async ({ signal } = {}) => travelBeforeLeg(signal),
      findPoint: async (feet, destination, { signal } = {}) => {
        const opts = { allowWater: true, allowLowHealth: true, maxDistance: 16 }
        // Shooters (witches included) are avoided on every long trip (coordinator 2026-11-14).
        const st0 = rt.working(), fleeing = true
        const shooters = fleeing ? rt.allActors().filter(a => a?.hostile === true && a.alive !== false && a.position && rt.require('./safety/learning-health').SHOOTING.test(String(a.entityType ?? a.name ?? '')) && !/drowned/.test(String(a.entityType ?? a.name ?? '')) && Math.hypot(a.position.x - feet.x, a.position.z - feet.z) <= 48).map(a => a.position) : []
        // Avoid zones (coordinator 2026-11-14): 20 m around a received shooter,
        // 32 m around a group of three or more (an outpost), never closer than
        // the bot already is, so the route bends away before the shooter's range.
        const avoidCols = new Set()
        // Remembered danger zones (live 16:22 and 17:18: pillagers near
        // (540..590, -750) killed the bot twice): 48 m around where a shooter
        // hit the bot, kept on disk; never closer than the bot already is.
        for (const zone of travelDangerZones()) {
          const r = Math.min(zone.r, Math.hypot(zone.x - feet.x, zone.z - feet.z) - 2)
          if (r <= 1 || Math.hypot(zone.x - feet.x, zone.z - feet.z) > 320) continue
          for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) for (let dz = -Math.ceil(r); dz <= Math.ceil(r); dz++) if (dx * dx + dz * dz <= r * r) avoidCols.add(`${Math.floor(zone.x) + dx},${Math.floor(zone.z) + dz}`)
        }
        for (const q of shooters) {
          const group = shooters.filter(o => Math.hypot(o.x - q.x, o.z - q.z) <= 16).length >= 3
          const r = Math.min(group ? 32 : 20, Math.hypot(q.x - feet.x, q.z - feet.z) - 2)
          if (r <= 1) continue
          for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) for (let dz = -Math.ceil(r); dz <= Math.ceil(r); dz++) if (dx * dx + dz * dz <= r * r) avoidCols.add(`${Math.floor(q.x) + dx},${Math.floor(q.z) + dz}`)
        }
        const here = Math.hypot(destination.x - feet.x, destination.z - feet.z)
        const heading = Math.atan2(destination.z - feet.z, destination.x - feet.x)
        // Starting in water (live 2026-11-14: the respawn point is a pool), climb
        // onto an adjacent received ledge first with the water exit move.
        {
          const cellAt = (x, y, z) => rt.host.world.getBlock(x, y, z)
          const fx = Math.floor(feet.x), fy = Math.floor(feet.y + 0.2), fz = Math.floor(feet.z)
          if (/water/.test(cellAt(fx, fy, fz)?.name ?? '') || /water/.test(cellAt(fx, fy - 1, fz)?.name ?? '')) {
            const ledges = []
            // Within five blocks (live 20:00: open water, shore three blocks away);
            // nearest first, then toward the destination.
            for (let dx = -5; dx <= 5; dx++) for (let dz = -5; dz <= 5; dz++) if ((dx || dz) && Math.hypot(dx, dz) <= 5.5) for (const dy of [1, 0]) { const c = cellAt(fx + dx, fy + dy - 1, fz + dz), here = cellAt(fx + dx, fy + dy, fz + dz); if (c?.known === true && c.boundingBox === 'block' && !/water/.test(c.name ?? '') && here?.known === true && here.boundingBox === 'empty' && !/water/.test(here.name ?? '')) ledges.push({ x: fx + dx + 0.5, y: fy + dy, z: fz + dz + 0.5 }) }
            ledges.sort((a, b) => Math.hypot(a.x - feet.x, a.z - feet.z) - Math.hypot(b.x - feet.x, b.z - feet.z) || Math.hypot(destination.x - a.x, destination.z - a.z) - Math.hypot(destination.x - b.x, destination.z - b.z))
            ledges.splice(12)
            for (const l of ledges) { let pv = null; try { rt.motionOrigin = rt.working(); pv = rt.movement?.preview(l, { ...opts, maxDistance: 8, waterExit: true }) } catch {} if (pv?.ready === true) return { ...l, waterExit: true } }
          }
        }
        // Follow the coarse wide-area route first (2026-11-14): a point some
        // nodes ahead on it that the ordinary local planner can walk to.
        try {
          const planRoute = (extra = {}) => { const bad = rt.host.shared.longTravelBadCells ??= new Set(); const blocked = avoidCols.size ? { has: k => bad.has(k) || avoidCols.has(k) } : bad; return rt.require('./travel/coarse-route').planCoarseRouteAsync({ getBlock: (x, y, z) => rt.host.world.getBlock(x, y, z), start: feet, goal: destination, maxNodes: 200000, maxMs: 6000, allowDig: true, maxDrop: 1, surfaceOnly: true, blocked, ...extra }) }
          let route = await planRoute()
          // Live 16:05: columns marked after failed walks fenced the bot in (the
          // same route without them existed). When they leave no route at all,
          // they are forgotten and the plan is made again.
          { const bad = rt.host.shared.longTravelBadCells; if (!route.ready && bad?.size) { rt.host.log(`長距離移動: 歩けなかった列の記録（${bad.size}件）を消して計画し直します`); bad.clear(); route = await planRoute() } }
          // No reachable point is closer (coordinator 2026-11-14, a 20 m cliff at
          // 16:51): stairs cut into a face may be used, never a tunnel.
          if (!route.ready) { const stairs = await planRoute({ faceStairs: true, maxMs: 8000 }); if (stairs.ready) { rt.host.log('長距離移動: 近づける場所がないため、壁面の階段で進みます'); route = stairs } }
          // Going around (coordinator 2026-11-14): when the route does not reach
          // the goal, request the received-terrain frontier closest to the
          // destination (up to three chunks, each at most every two minutes) and
          // plan again; the best reachable point toward the goal is used.
          if (!route.reached && route.frontier.length) {
            const asked = rt.host.shared.longTravelFrontierAsked ??= new Map()
            const chunks = [...new Map(route.frontier.map(f => [`${Math.floor(f.x / 16)},${Math.floor(f.z / 16)}`, f])).values()]
              .sort((a, b) => Math.hypot(destination.x - a.x, destination.z - a.z) - Math.hypot(destination.x - b.x, destination.z - b.z))
              .filter(f => Date.now() - (asked.get(`${Math.floor(f.x / 16)},${Math.floor(f.z / 16)}`) ?? 0) > 120000).slice(0, 3)
            if (chunks.length) {
              const y = Math.floor(feet.y)
              for (const f of chunks) asked.set(`${Math.floor(f.x / 16)},${Math.floor(f.z / 16)}`, Date.now())
              try { await rt.requestQuarryTerrain({ config: { target: { chunks: chunks.map(f => ({ x: Math.floor(f.x / 16), z: Math.floor(f.z / 16) })) } }, yTop: Math.min(150, y + 40), yBottom: Math.max(-60, y - 24) }, {}) } catch {}
              await new Promise(r => setTimeout(r, 800))
              route = await planRoute()
            }
          }
          // Live 2026-11-14 13:35: on a hilltop the terrain above y80 was not
          // received, so no column counted as open sky and the route closed in
          // (97 nodes, no frontier). Request the terrain above once per spot
          // and plan again; unreceived terrain still never counts as open.
          if (!route.ready && !route.frontier.length) {
            const key = `${Math.floor(feet.x / 16)},${Math.floor(feet.z / 16)}`
            const asked = rt.host.shared.longTravelSkyAsked ??= new Map()
            if (Date.now() - (asked.get(key) ?? 0) > 120000) {
              asked.set(key, Date.now())
              try { await rt.operations.quarry.requestTerrainAbove(); await new Promise(r => setTimeout(r, 1500)); route = await planRoute(); rt.host.log(`長距離移動: 頭上の地形を要求しました（経路 ${route.ready ? 'あり' : 'なし'}）`) } catch {}
            }
          }
          // A carved step ahead: walk to the cell before it first, then dig and step.
          const firstDig = route.ready ? route.path.findIndex(p => p.dig) : -1
          if (firstDig > 0 && firstDig <= 12) {
            const before = route.path[firstDig - 1], step = route.path[firstDig]
            if (Math.hypot(before.x - feet.x, before.z - feet.z) > 1.2 || Math.abs(before.y - feet.y) > 0.6) { let pv = null; try { rt.motionOrigin = rt.working(); pv = rt.movement?.preview({ x: before.x, y: before.y, z: before.z }, opts) } catch {} if (pv?.ready === true) return { x: before.x, y: before.y, z: before.z } }
            else return { x: step.x, y: step.y, z: step.z, dig: step.dig }
          }
          if (route.ready) for (const ahead of [12, 9, 6, 4, 3, 2, 1].map(a => firstDig > 0 ? Math.min(a, firstDig - 1) : a)) {
            const p = route.path[Math.min(ahead, route.path.length - 1)]
            if (!p || Math.hypot(p.x - feet.x, p.z - feet.z) < 0.8) continue // a one-node step counts (live 16:06: only it was walkable)
            if (fleeing && shooters.some(q => Math.hypot(q.x - p.x, q.z - p.z) < Math.min(6, Math.hypot(q.x - feet.x, q.z - feet.z)))) continue
            let preview = null
            try { rt.motionOrigin = rt.working(); preview = rt.movement?.preview({ x: p.x, y: p.y, z: p.z }, opts) } catch { preview = null }
            if (preview?.ready === true) return { x: p.x, y: p.y, z: p.z }
          }
        } catch {}
        for (const d of [14, 10, 6]) for (const deg of [0, 25, -25, 50, -50, 75, -75, 100, -100]) {
          if (signal?.aborted) return null
          const ang = heading + deg * Math.PI / 180
          const x = Math.floor(feet.x + Math.cos(ang) * Math.min(d, here)) + 0.5, z = Math.floor(feet.z + Math.sin(ang) * Math.min(d, here)) + 0.5
          if (Math.hypot(destination.x - x, destination.z - z) > here - 3) continue
          if (inDangerZone(x, z) && !inDangerZone(feet.x, feet.z)) continue
          // Empty-handed (decision C, 2026-11-14): never toward a shooting enemy;
          // the first walkable point that does not bring one closer wins.
          if (fleeing && shooters.some(q => Math.hypot(q.x - x, q.z - z) < Math.hypot(q.x - feet.x, q.z - feet.z))) continue
          for (const dy of [0, 1, -1, 2, -2, 3, -3, 4, -4]) {
            const target = { x, y: Math.floor(feet.y + 0.001) + dy, z }
            let preview = null
            try { rt.motionOrigin = rt.working(); preview = rt.movement?.preview(target, opts) } catch { preview = null }
            if (preview?.ready === true) return target
          }
          await new Promise(resolve => setImmediate(resolve))
        }
        // Stranded on a canopy (coordinator 2026-11-14, choice A): break only the
        // leaves under the feet at the best reachable spot, then plan again.
        try { const r = await travelLeafEscape(signal); if (r.attempted) rt.host.log(`長距離移動: 葉の上から降ります: ${r.ok ? '地面に降りました' : r.reason}`) } catch {}
        return null
      },
      walkTo: async (target, { signal } = {}) => {
        try { rt.requireIdle({ inventoryRequired: false }) } catch (error) { return { ok: false, code: 'CHUNK_TRAVEL_BUSY', message: String(error.message ?? error).slice(0, 120) } }
        // Carved step (2026-11-14): each cell by the ordinary mining, confirmed
        // by received air, before stepping up.
        if (Array.isArray(target.dig) && target.dig.length) {
          for (const cell of target.dig) {
            const air = () => { const b = rt.host.world.getBlock(cell.x, cell.y, cell.z); return b?.known === true && /^minecraft:(?:air|cave_air)$/.test(b.name ?? '') }
            if (air()) continue
            rt.host.log(`長距離移動: 段を掘ります (${cell.x},${cell.y},${cell.z}) ${String(cell.name ?? '').replace('minecraft:', '')}`)
            // Live 14:35: stone was refused with the wooden pickaxe in the bag.
            // Hold the best received pickaxe (stone-like) or shovel (soft) first.
            try { await travelHoldTool(cell.name) } catch {}
            try { rt.operations.mining.start([{ x: cell.x, y: cell.y, z: cell.z }]) } catch (error) { (rt.host.shared.longTravelBadCells ??= new Set()).add(`${cell.x},${cell.z}`); return { ok: false, code: 'DIG_START_FAILED', message: String(error.message ?? error).slice(0, 120) } }
            const until = Date.now() + 30000
            while (!air()) {
              if (signal?.aborted) { try { rt.operations.mining.stop?.('LONG_TRAVEL_CANCELLED') } catch {} return { ok: false, code: 'LONG_TRAVEL_CANCELLED' } }
              if (Date.now() > until) return { ok: false, code: 'DIG_TIMEOUT', message: `(${cell.x},${cell.y},${cell.z})` }
              await new Promise(resolve => setTimeout(resolve, 250))
            }
          }
          try { rt.requireIdle({ inventoryRequired: false }) } catch (error) { return { ok: false, code: 'CHUNK_TRAVEL_BUSY', message: String(error.message ?? error).slice(0, 120) } }
        }
        const startHealth = rt.working().health
        // Empty-handed: sprint out of range while hunger allows it (> 6).
        const v = rt.host.shared.vitals?.hunger, hunger = Number.isFinite(v) ? v : v?.value
        const sprint = rt.working().emptyHandedPrep === true && Number.isFinite(hunger) && hunger > 6
        try { rt.startMotion('navigation', { x: target.x, y: target.y, z: target.z }, { allowWater: true, allowLowHealth: true, maxDistance: target.waterExit ? 4 : 16, ...(target.waterExit ? { waterExit: true } : sprint ? { sprint: true } : {}) }) } catch (error) { return { ok: false, code: 'POINT_START_FAILED', message: String(error.message ?? error).slice(0, 120) } }
        const until = Date.now() + 60000
        for (;;) {
          await new Promise(resolve => setTimeout(resolve, 200))
          if (signal?.aborted) { try { rt.movement?.stop?.('LONG_TRAVEL_CANCELLED') } catch {} return { ok: false, code: 'LONG_TRAVEL_CANCELLED' } }
          const st = rt.working(), m = rt.movement?.snapshot() ?? {}
          if (st.health < startHealth && st.emptyHandedPrep !== true) { try { rt.movement?.stop?.('damage') } catch {} return { ok: false, code: 'CHUNK_TRAVEL_DAMAGED' } }
          if (['failed', 'stopped'].includes(m.phase) && !/replan|correction|stalled|ticks were missed/i.test(String(m.reason ?? ''))) { const bad = rt.host.shared.longTravelBadCells ??= new Set(); bad.add(`${Math.floor(target.x)},${Math.floor(target.z)}`); if (bad.size > 2000) bad.delete(bad.values().next().value) }
          if (['failed', 'stopped', 'replan_required'].includes(m.phase)) return { ok: false, code: m.phase === 'replan_required' || /replan|correction|stalled|ticks were missed/i.test(String(m.reason ?? '')) ? 'POINT_REPLAN' : 'POINT_WALK_FAILED', message: `${String(m.reason ?? m.phase).slice(0, 120)}${/frame guard/.test(String(m.reason)) && rt.host.shared.waterGuardWhy ? ` [${rt.host.shared.waterGuardWhy}]` : ''}` }
          if (['completed', 'idle', 'awaiting_server_confirmation'].includes(m.phase) && m.running !== true) {
            const feet = { x: st.position.x, y: st.position.y - 1.62, z: st.position.z }
            return Math.hypot(feet.x - target.x, feet.z - target.z) <= 1.2 && Math.abs(feet.y - target.y) <= 1.6 ? { ok: true } : { ok: false, code: 'POINT_ENDED_SHORT' }
          }
          if (Date.now() > until) { try { rt.movement?.stop?.('timeout') } catch {} return { ok: false, code: 'POINT_WALK_TIMEOUT' } }
        }
      },
      save: async doc => { doc = { ...doc, realmId: rt.raw().realm?.id == null ? null : String(rt.raw().realm.id), profile: rt.raw().profile ?? null }; const fsp = rt.require('node:fs/promises'), file = longTravelFile(); await fsp.mkdir(rt.require('node:path').dirname(file), { recursive: true }); await fsp.writeFile(file + '.tmp', JSON.stringify(doc, null, 2)); await fsp.rename(file + '.tmp', file) },
      log: message => rt.host.log(message)
    })
    return longTravel
  }
  function ensureChunkTravel () {
    if (rt.chunkTravel) return rt.chunkTravel
    let planner = null
    rt.chunkTravel = rt.createChunkTravel({ getState: rt.quarryState, getBlock: (x, y, z) => rt.host.world.getBlock(x, y, z),
      getMovement: () => rt.movement?.snapshot() ?? { phase: 'unavailable', running: false },
      generation: () => rt.host.shared.loadoutGeneration, jobIdentity: rt.chunkMoveJobIdentity, log: message => rt.host.log(message),
      planRoute: async (target, options) => {
        if (!rt.idlePhysics) return { ready: false, reason: '移動に必要な地形が未受信です。' }
        planner ??= rt.createNavigator({ world: rt.host.world, version: rt.host.meta.version, allowWater: true,
          physics: rt.idlePhysics.withWorld(rt.host.world, { allowWater: true }), planningDistanceLimit: 48 })
        await rt.reconcilePlanningOrigin()
        const origin = rt.require('./movement/move-origin').planningOrigin({ fromServer: state => planner.physics.fromServer(state), getState: rt.quarryState, discardPrediction: rt.discardWorkingPrediction })
        return planner.planAsync(origin, target, { ...options, maxDistance: 48, maxExpanded: 5000 })
      },
      previewMove: (target, options) => {
        rt.verifyChunkMoveLease(rt.chunkMoveLease?.id)
        rt.motionOrigin = rt.working()
        return rt.movement?.preview(target, { ...options, allowWater: true, sprint: false, allowLowHealth: true })
      },
      startMove: (target, options) => {
        const owner = rt.verifyChunkMoveLease(options.operationId)
        rt.controlLocation.invalidate()
        rt.chunkMoveDepth++
        try {
          const { operationId, ...native } = options
          // User decision 2026-11-13: a dashboard move runs at any health above zero.
          const result = rt.startMotion('navigation', target, { ...native, allowWater: true, sprint: false, allowLowHealth: true })
          owner.startedMovement = rt.movement; owner.startedSerial = rt.portableMovementSerial; owner.stopped = false
          return result
        } finally { rt.chunkMoveDepth-- }
      },
      stopMove: (id, reason) => rt.stopChunkMovement(id, reason),
      confirmPosition: (feet, options) => rt.controlLocation.confirm(feet, options),
      acquire: async (id, options) => {
        rt.requireIdle({ inventoryRequired: false, chunkMoveHandoff: true })
        const doc = rt.quarryJob?.document() ?? rt.host.shared.quarryDocument
        if (rt.chunkMoveLease || rt.resetHeld() || rt.manualChestStorage?.isBusy() || rt.manualShulkerTask || rt.armorTask || rt.manualArmorOwner || rt.quarryRestoreTask ||
          rt.autonomy.snapshot().running || rt.depotMission?.isBusy() || doc && (!['IDLE', 'PAUSED', 'FINISHED'].includes(doc.state) || doc.persistence?.status === 'failed' ||
          doc.state !== 'FINISHED' && (doc.portableStorage || doc.supplyRestock || doc.egress?.operationId && !doc.surfaceReturnedAt))) throw Object.assign(new Error('現在の作業を終了してからBotを移動させてください。'), { code: 'CHUNK_MOVE_NOT_IDLE' })
        rt.chunkMoveLease = { id, scope: options.scope, signal: options.signal, generation: rt.host.shared.loadoutGeneration, job: rt.chunkMoveJobIdentity(), startedMovement: null, startedSerial: null, stopped: true }
        rt.controlLocation.invalidate()
        rt.loadoutReset?.cancel()
        rt.stopIdleStream()
        rt.idlePhysicsState = null
        await rt.idleSafety?.stop('選択チャンクへの移動')
        await rt.idleSafety?.drain()
        rt.verifyChunkMoveLease(id)
        if (!(await rt.ensureMovementLifeKnown())) throw Object.assign(new Error('Botの生存状態をまだ確認できていません。数秒待ってからもう一度お試しください。'), { code: 'MOVE_LIFE_UNKNOWN' })
        rt.verifyChunkMoveLease(id)
      },
      release: id => { if (rt.chunkMoveLease?.id === id) { rt.stopChunkMovement(id, 'CHUNK_MOVE_FINISHED'); rt.chunkMoveLease = null; rt.resumeSafety() } }
    })
    return rt.chunkTravel
  }
  return {
    travelBedOwns,
    travelShulkerOwns,
    get longTravel () { return longTravel },
    ensureChunkTravel,
    get longTravelFile () { return longTravelFile },
    ensureLongTravel,
    travelLeafEscape,
    travelNightPit,
    retreatFromHostiles,
    travelClock,
    travelPlaceTable,
    travelSupplyBoxTake
  }
}

module.exports = { createLongTravelRuntime }
