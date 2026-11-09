'use strict'

// Read-only proposals for moving to a supply worksite. No placement, mining,
// fabricated terrain, or changes to the quarry's ordinary permissions.
const { permits } = require('./quarry-region')
const point = p => p && ['x', 'y', 'z'].every(k => Number.isSafeInteger(p[k]))
const same = (a, b) => point(a) && point(b) && ['x', 'y', 'z'].every(k => a[k] === b[k])

function supplyPlacementAllowed (regions, p) {
  if (!point(p) || !regions?.columns?.has(`${p.x},${p.z}`) || p.y < regions.yBottom || p.y > regions.worldMaxY - 1) return false
  if (!permits(regions, 'travel', p).allowed || !permits(regions, 'travel', { ...p, y: p.y + 1 }).allowed) return false
  const allowed = permits(regions, 'place', p)
  if (allowed.allowed) return true
  // A box on the uncut surface sits one cell above yTop. Authorize only
  // temporary supply work there, not another layer of quarry excavation.
  return allowed.reason === 'OUTSIDE_PERMITTED_REGION' && p.y === regions.yTop + 1 && permits(regions, 'place', { ...p, y: p.y - 1 }).allowed
}

async function planSupplyApproach ({ origin, regions, planner, canPlace, previewSite, previewRoute = null, guard = () => {} }) {
  guard()
  const workStand = p => supplyPlacementAllowed(regions, p) && planner.standable(p)
  const check = p => {
    if (!workStand(p)) return null
    const result = previewSite(p)
    return result?.ready === true && same(result.stand, p) && Array.isArray(result.positions) && result.positions.length === 1 && result.positions.every(canPlace) ? result : null
  }
  // Already at a valid site: do not walk to the edge or back to the surface.
  const current = check(origin)
  if (current) return { ready: true, site: current, path: [origin], serverConfirmed: false }
  const reach = await planner.reachableFromAsync(origin)
  guard()
  const candidates = [...reach].map(([k, distance]) => { const [x, y, z] = k.split(',').map(Number); return { stand: { x, y, z }, distance } })
    .filter(c => !same(c.stand, origin) && workStand(c.stand))
    .sort((a, b) => a.distance - b.distance || Math.abs(a.stand.y - origin.y) - Math.abs(b.stand.y - origin.y) || a.stand.x - b.stand.x || a.stand.z - b.stand.z)
  let examined = 0, routeChecks = 0, cause = null
  // Cooperative and bounded even for a large permitted region. This limit is
  // reported explicitly; exhausting it is not proof that terrain is absent.
  for (const { stand } of candidates.slice(0, 1024)) {
    if ((examined++ & 15) === 0) { await new Promise(resolve => setImmediate(resolve)); guard() }
    const site = check(stand)
    if (!site) continue
    const path = planner.pathTo(origin, stand)
    guard()
    if (!path?.length || !same(path[0], origin) || !same(path.at(-1), stand) || path.some(p => !permits(regions, 'travel', p).allowed || !planner.standable(p))) continue
    if (previewRoute) {
      if (routeChecks++ >= 8) return { ready: false, reason: 'SUPPLY_APPROACH_ROUTE_LIMIT', details: { candidates: candidates.length, examined, cause } }
      const result = await previewRoute(site, path)
      guard()
      if (result?.ready !== true) { cause = result?.reason ?? 'NATIVE_ROUTE_UNAVAILABLE'; continue }
    }
    return { ready: true, site, path, serverConfirmed: false }
  }
  return { ready: false, reason: !candidates.length ? 'SUPPLY_APPROACH_UNREACHABLE' : candidates.length > 1024 ? 'SUPPLY_SITE_SEARCH_LIMIT' : 'STORAGE_SITE_UNOBSERVED', details: { origin, candidates: candidates.length, examined, ...(cause ? { cause } : {}) } }
}

module.exports = { supplyPlacementAllowed, planSupplyApproach }
