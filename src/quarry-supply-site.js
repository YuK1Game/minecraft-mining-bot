'use strict'

// Read-only proposals for moving to a supply worksite. No placement, mining,
// fabricated terrain, or changes to the quarry's ordinary permissions.
const { permits } = require('./quarry-region')
const point = p => p && ['x', 'y', 'z'].every(k => Number.isSafeInteger(p[k]))
const same = (a, b) => point(a) && point(b) && ['x', 'y', 'z'].every(k => a[k] === b[k])

function supplyPlacementAllowed (regions, p, initialStation = null) {
  if (!point(p) || !regions?.columns?.has(`${p.x},${p.z}`) || p.y < regions.yBottom || p.y > regions.worldMaxY - 1) return false
  if (!permits(regions, 'travel', p).allowed || !permits(regions, 'travel', { ...p, y: p.y + 1 }).allowed) return false
  const allowed = permits(regions, 'place', p)
  if (allowed.allowed) return true
  // A box on the uncut surface sits one cell above yTop. Authorize only
  // temporary supply work there, not another layer of quarry excavation.
  if (allowed.reason !== 'OUTSIDE_PERMITTED_REGION') return false
  if (p.y === regions.yTop + 1 && permits(regions, 'place', { ...p, y: p.y - 1 }).allowed) return true
  // The receipt-backed initial kit has one registered surface station, which
  // can be above the v2.2 work cap. This callback also guards the standing cell
  // during placement/recovery; it never changes ordinary break/place rights.
  const cells = [initialStation?.stand, initialStation?.stage]
  return cells.every(c => {
    if (!point(c) || !regions.columns.has(`${c.x},${c.z}`) || c.y < regions.yBottom || c.y >= regions.worldMaxY) return false
    return [c, { ...c, y: c.y + 1 }].every(body => {
      const placement = permits(regions, 'place', body)
      return permits(regions, 'travel', body).allowed && (placement.allowed || placement.reason === 'OUTSIDE_PERMITTED_REGION')
    })
  }) &&
    !same(cells[0], cells[1]) && cells[0].y === cells[1].y && cells.some(c => same(c, p))
}

async function planSupplyApproach ({ origin, regions, planner, canPlace, previewSite, initialStation = null, previewRoute = null, guard = () => {} }) {
  guard()
  const failures = [], counts = {}
  const reject = result => {
    const detail = result?.details ?? { cause: result?.reason ?? 'SITE_PREVIEW_UNCONFIRMED' }
    const cause = detail.cause ?? result?.reason ?? 'SITE_PREVIEW_UNCONFIRMED'
    counts[cause] = (counts[cause] ?? 0) + 1
    if (failures.length < 8) failures.push({ cause, ...(detail.position ? { position: detail.position } : {}), ...(detail.block ? { block: detail.block } : {}) })
  }
  const workStand = p => supplyPlacementAllowed(regions, p, initialStation) && planner.standable(p)
  const check = p => {
    if (!workStand(p)) return null
    const result = previewSite(p)
    if (result?.ready === true && same(result.stand, p) && Array.isArray(result.positions) && result.positions.length === 1 && result.positions.every(canPlace)) return result
    reject(result); return null
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
  const first = failures.find(f => /UNKNOWN|UNOBSERVED/.test(f.cause)) ?? failures[0]
  return { ready: false, reason: !candidates.length ? 'SUPPLY_APPROACH_UNREACHABLE' : candidates.length > 1024 ? 'SUPPLY_SITE_SEARCH_LIMIT' : 'STORAGE_SITE_UNOBSERVED', details: { cause: cause ?? first?.cause ?? 'NO_REACHABLE_WORKSITE', position: first?.position ?? origin, ...(first?.block ? { block: first.block } : {}), origin, candidates: candidates.length, examined, counts, failures } }
}

module.exports = { supplyPlacementAllowed, planSupplyApproach }
