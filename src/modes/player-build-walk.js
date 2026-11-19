'use strict'

// Player mode: to a place no walk leads to, by a route that digs and stacks
// (movement/build-route.js plans it over received terrain; this carries it
// out). User 2026-11-18: 「移動場所ルートが見つからないときは、『ブロックを積み上げて
// 移動できるか』『掘って移動できるか』も計算してください。永遠にルート探す仕様は
// 辞めてください。」
// - Each step is the ordinary thing: a walk, the ordinary mining of the
//   blocks in the way, the pillar descent of the own block under the feet,
//   one pillar step up. A step counts by received data only (received air, the
//   feet at the cell, the received block and one block less).
// - A block the mining check refuses, or a step that did not get the Bot to
//   its cell, is left out of the next plan. The plan is made again from where
//   the Bot stands, at most ROUNDS times; then the answer is the reason.
// - No plan: the answer is NO_BUILD_ROUTE (or the search limit) at once.
// ports: the scaffold's hands (player-scaffold-ports.js): feet, block, walk,
// canMine, mine, canDig, dig, pick, descend, pillar, bridge, fill, reason.
const { planBuildRouteAsync, keyOf } = require('../movement/build-route')
const { createHouseProtection } = require('../safety/house-protection')
const { centreOnColumn } = require('./pillar-centre')

const AIR = /^minecraft:(?:air|cave_air|void_air)$/
const ROUNDS = 6
const RUN = 4 // plain walking steps taken as one walk

async function buildWalk ({ ports, target, done, log = () => {}, aborted = () => false, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), rounds = ROUNDS, plan = planBuildRouteAsync, limits = {} }) {
  const { feet, block, walk } = ports
  const cell = () => { const at = feet(); return at && [at.x, at.y, at.z].every(Number.isFinite) ? { x: Math.floor(at.x), y: Math.floor(at.y + 0.001), z: Math.floor(at.z) } : null }
  const centre = at => ({ x: at.x + 0.5, y: at.y, z: at.z + 0.5 })
  const there = at => { const now = cell(); return !!now && now.x === at.x && now.y === at.y && now.z === at.z }
  const isAir = at => { const found = block(at.x, at.y, at.z); return found?.known === true && (AIR.test(found.name ?? '') || found.boundingBox !== 'block') }
  const refused = new Set(), barred = new Set()
  const bar = (a, b) => barred.add(`${keyOf(a.x, a.y, a.z)}>${keyOf(b.x, b.y, b.z)}`)
  const say = text => log(`プレイヤーモード: ${text}`)
  let moved = 0, mined = 0, stacked = 0, bridged = 0, why = null

  // The blocks in the way of one step: mined by the ordinary mining, by hand where no pickaxe may be used.
  async function clear (cells) {
    for (const at of cells) {
      if (aborted()) return false
      if (isAir(at)) continue
      const tool = ports.canMine(at) || (await ports.pick?.() && ports.canMine(at))
      if (!tool && !ports.canDig?.(at)) { refused.add(keyOf(at.x, at.y, at.z)); why = ports.reason?.(at) ?? 'CANNOT_MINE'; return false }
      if (!await (tool ? ports.mine(at) : ports.dig(at))) { refused.add(keyOf(at.x, at.y, at.z)); why = ports.why?.() ?? 'MINE_FAILED'; return false }
      mined++
    }
    return true
  }

  for (let round = 0; round < rounds && !aborted(); round++) {
    const start = cell()
    if (!start) return { ok: false, code: 'NO_POSITION', moved, mined, stacked }
    if (done(start)) return { ok: true, code: 'BUILD_ROUTE_DONE', moved, mined, stacked }
    const carried = ports.fill?.() ?? 0
    let route = await plan({ getBlock: block, start, target, done, blocks: carried, refused, barred, ...limits })
    // No way by walking, digging and stacking: once more with floor blocks placed over gaps.
    // Also off an edge two or three down (nothing carried is needed for that).
    const mayBridge = carried > 0 && typeof ports.bridge === 'function', mayDrop = typeof ports.drop === 'function'
    if (!route.ok && (mayBridge || mayDrop) && !aborted()) {
      const wider = await plan({ getBlock: block, start, target, done, blocks: carried, refused, barred, ...limits, allowBridge: mayBridge, allowDrop: mayDrop })
      if (wider.ok) route = wider; else route = { ...route, expanded: route.expanded + wider.expanded }
    }
    if (!route.ok) {
      say(`掘る・積む道もありません（${route.code}・調べたマス ${route.expanded}${why ? `・${String(why).slice(0, 60)}` : ''}）`)
      return { ok: false, code: route.code, moved, mined, stacked, expanded: route.expanded }
    }
    say(`歩ける道がないため、掘る・積む道で進みます（${route.steps.length} 歩・掘る ${route.dig} 個・自分の柱を下りる ${route.shaft} 段・積む ${route.stack} 段${route.bridge ? `・足場を置く ${route.bridge} 個` : ''}${round ? `・${round + 1} 回目の計画` : ''}）`)
    let at = start, failed = false
    for (let i = 0; i < route.steps.length && !failed; i++) {
      if (aborted()) return { ok: false, code: 'INTERRUPTED', moved, mined, stacked }
      const step = route.steps[i]
      if (step.kind === 'walk' && !step.dig.length) {
        // Plain steps in a row are one walk; when that fails, the first of them alone.
        let last = i
        while (last + 1 < route.steps.length && last - i < RUN - 1 && route.steps[last + 1].kind === 'walk' && !route.steps[last + 1].dig.length) last++
        if (last > i && await walk(centre(route.steps[last].to)) && there(route.steps[last].to)) { moved += last - i + 1; at = route.steps[last].to; i = last; continue }
        if (there(step.to) || await walk(centre(step.to)) && there(step.to)) { moved++; at = step.to; continue }
        bar(at, step.to); why = ports.why?.() ?? 'WALK_FAILED'; failed = true
        continue
      }
      if (!await clear(step.dig)) { failed = true; continue }
      if (step.kind === 'walk') {
        if (await walk(centre(step.to)) && there(step.to)) { moved++; at = step.to; continue }
        bar(at, step.to); why = ports.why?.() ?? 'WALK_FAILED'; failed = true
      } else if (step.kind === 'bridge') {
        // A floor block over the gap first (received), then the step onto it.
        const floor = () => { const found = block(step.place.x, step.place.y, step.place.z); return found?.known === true && found.boundingBox === 'block' }
        const laid = floor() || (typeof ports.bridge === 'function' && await ports.bridge(step.place, at) && floor())
        if (laid && await walk(centre(step.to)) && there(step.to)) { moved++; bridged++; at = step.to; continue }
        bar(at, step.to); why = laid ? ports.why?.() ?? 'WALK_FAILED' : ports.why?.() ?? 'BRIDGE_FAILED'; failed = true
      } else if (step.kind === 'drop') {
        // Centred on the edge cell first, then the predicted drop; the feet at the lower cell count.
        await walk(centre(at))
        if (await ports.drop(centre(step.to)) && there(step.to)) { moved++; at = step.to; continue }
        bar(at, step.to); why = ports.why?.() ?? 'DROP_FAILED'; failed = true
      } else if (step.kind === 'shaft') {
        if (await ports.descend({ x: at.x, y: at.y - 1, z: at.z }) && there(step.to)) { moved++; mined++; at = step.to; continue }
        bar(at, step.to); why = ports.why?.() ?? 'DESCEND_FAILED'; failed = true
      } else {
        await walk(centre(at))
        await centreOnColumn({ column: at, base: at.y, feet, block, walk, aborted })
        let up = await ports.pillar({ x: at.x, z: at.z }, at.y, { any: true })
        // The step before may still be ending (the mining that just finished).
        if (!up?.ok && !aborted() && !there(step.to)) { await sleep(1500); up = there(step.to) ? { ok: true } : await ports.pillar({ x: at.x, z: at.z }, at.y, { any: true }) }
        if ((up?.ok || there(step.to)) && there(step.to)) { moved++; stacked++; at = step.to; continue }
        bar(at, step.to); why = up?.reason ?? ports.why?.() ?? 'PILLAR_FAILED'; failed = true
      }
    }
    const now = cell()
    if (!failed && now && done(now)) { say(`掘る・積む道で着きました（${moved} 歩・掘った ${mined} 個・積んだ ${stacked} 段${bridged ? `・置いた足場 ${bridged} 個` : ''}）`); return { ok: true, code: 'BUILD_ROUTE_DONE', moved, mined, stacked } }
    if (failed) say(`掘る・積む道の途中で進めなくなりました（${moved} 歩目のあと・${String(why ?? '不明').slice(0, 80)}）。そこを外して計画し直します`)
  }
  if (aborted()) return { ok: false, code: 'INTERRUPTED', moved, mined, stacked }
  say(`掘る・積む道を ${rounds} 回計画しても着けませんでした（${moved} 歩・${String(why ?? '不明').slice(0, 80)}）`)
  return { ok: false, code: 'BUILD_ROUTE_FAILED', moved, mined, stacked, detail: why }
}

// The port the jobs use: the hands, with the starter house read as built
// (safety/house-protection.js), so its floor and walls are never part of a route.
function createBuildWalk ({ hands, getHouse = () => null, log = () => {} }) {
  const overlay = createHouseProtection(getHouse)
  const ports = { ...hands, block: (x, y, z) => overlay(hands.block(x, y, z), x, y, z) }
  return (target, { done, aborted = () => false, limits = {} } = {}) => buildWalk({ ports, target, done, log, aborted, limits })
}

module.exports = { buildWalk, createBuildWalk, ROUNDS }
