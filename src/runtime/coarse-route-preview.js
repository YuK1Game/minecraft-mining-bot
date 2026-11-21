'use strict'

const { planCoarseRouteAsync } = require('../travel/coarse-route')

const budget = (value, fallback, cap) => Number.isFinite(value) && value > 0 ? Math.max(1, Math.min(cap, Math.floor(value))) : fallback

// A diagnostic shares the connection's event loop. Bound its total work and
// yield while searching, just as the travel controller does. Cached terrain
// belongs to its observed sections; a relevant change invalidates the preview.
async function previewCoarseRoute ({ world, getState, cancelled = () => false, now = Date.now }, input = {}, { signal } = {}) {
  const d = input.destination, st = getState(), p = st.position
  if (!d || ![d.x, d.z, p?.x, p?.y, p?.z].every(Number.isFinite)) throw new Error('目的地 {x, z} と受信した現在位置が必要です。')
  const terrainObserver = world.observeTerrain?.(), revision = world.revision?.(), started = now()
  const active = () => {
    if (cancelled()) return true
    if (terrainObserver ? !terrainObserver.current() : revision != null && world.revision() !== revision) throw Object.assign(new Error('地形が更新されたため、経路プレビューをやり直してください。'), { code: 'COARSE_ROUTE_STALE' })
    return false
  }
  const r = await planCoarseRouteAsync({ getBlock: (x, y, z) => world.getBlock(x, y, z), start: { x: p.x, y: p.y - 1.62, z: p.z }, goal: d,
    maxNodes: budget(input.maxNodes, 60000, 120000), maxMs: budget(input.maxMs, 1000, 2000), sliceMs: 8, now, signal, cancelled: active, terrainObserver,
    allowDig: input.allowDig === true, surfaceOnly: input.surfaceOnly === true, maxDrop: Number.isSafeInteger(input.maxDrop) ? Math.max(0, Math.min(6, input.maxDrop)) : 3 })
  const step = Math.max(1, Math.floor(r.path.length / 20))
  return { ready: r.ready, reached: r.reached, surfaced: r.surfaced === true, timedOut: r.timedOut, remaining: r.remaining, expanded: r.expanded,
    ms: now() - started, length: r.path.length, sample: r.path.filter((_, i) => i % step === 0 || i === r.path.length - 1), frontier: r.frontier.slice(0, 8) }
}

module.exports = { previewCoarseRoute }
