'use strict'

const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const air = b => b?.known === true && /^minecraft:(?:air|cave_air|void_air)$/.test(b.name) && !b.extra?.length
const ground = b => b?.known === true && /^minecraft:(?:end_stone|obsidian|bedrock|cobblestone|cobbled_deepslate|dirt)$/.test(b.name) && !b.extra?.length
const cell = p => ({ x: Math.floor(p.x), y: Math.floor(p.y + 0.001), z: Math.floor(p.z) })
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
const center = p => ({ x: p.x + 0.5, z: p.z + 0.5, y: p.y })

// The central return fountain has a bedrock rim three blocks from its pillar.
// Read both together: air on some other floor cannot attest a closed portal.
function fountain (get) {
  const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  for (let y = 35; y <= 110; y++) {
    if (get(0, y, 0)?.name !== 'minecraft:bedrock') continue
    for (const [x, z] of directions) {
      if (get(3 * x, y, 3 * z)?.name !== 'minecraft:bedrock') continue
      const portal = { x: 2 * x, z: 2 * z, y }, inside = get(portal.x, y, portal.z)
      if (inside?.known !== true || !(air(inside) || inside.name === 'minecraft:end_portal')) continue
      return { open: inside.name === 'minecraft:end_portal', portal, rim: { x: 3 * x, z: 3 * z, y: y + 1 } }
    }
  }
  return null
}

function stand (get, x, y, z) {
  return ground(get(x, y - 1, z)) && air(get(x, y, z)) && air(get(x, y + 1, z))
}

// Pick a reachable short leg across known island ground. The search can go
// around a spike. Never choose an unknown or unsupported footstep over the void.
function nextGround (get, feet, target, avoid = () => false) {
  const start = cell(feet), nodes = [start], seen = new Set([`${start.x},${start.y},${start.z}`])
  let best = null, bestScore = distance(center(start), target)
  for (let n = 0; n < nodes.length && n < 450; n++) {
    const from = nodes[n]
    for (const [dx, dz] of SIDES) {
      const x = from.x + dx, z = from.z + dz
      if (Math.hypot(x - start.x, z - start.z) > 8) continue
      for (const dy of [0, 1, -1]) {
        const y = from.y + dy, key = `${x},${y},${z}`
        if (seen.has(key) || !stand(get, x, y, z) || avoid({ x, y, z }) ||
            dy > 0 && !air(get(from.x, from.y + 2, from.z)) || dy < 0 && !air(get(x, from.y + 1, z))) continue
        seen.add(key)
        const node = { x, y, z }
        nodes.push(node)
        const score = distance(center(node), target)
        if (score < bestScore) { best = node; bestScore = score }
        break
      }
    }
  }
  return best && center(best)
}

// Look for a two-block-high refuge on reachable End stone. A roof this low
// excludes Endermen; never move toward a known breath cloud to reach it.
function findShelter (get, feet, danger) {
  const here = cell(feet), options = []
  for (let x = here.x-8; x <= here.x+8; x++) for (let z = here.z-8; z <= here.z+8; z++) {
    for (let y = here.y-2; y <= here.y+2; y++) {
      const at = { x, y, z }
      if (ground(get(x,y+2,z)) && stand(get,x,y,z) && !danger(at) &&
          SIDES.some(([dx,dz]) => ground(get(x+dx,y+1,z+dz)))) options.push(center(at))
    }
  }
  options.sort((a,b) => distance(a,feet)-distance(b,feet))
  return options[0] ?? null
}

async function bridge (ctx, current) {
  const { runtime, operations, getBlock } = ctx
  const below = { x: current.x, y: current.y - 1, z: current.z }
  if (!ground(getBlock(below.x, below.y, below.z))) return false
  const position = { ...below, x: below.x - 1 }
  if (![0, 1, 2].every(dy => air(getBlock(position.x, position.y + dy, position.z)))) return false
  const material = () => runtime.inventory()?.items?.filter(i => i.count > 0 && ['minecraft:cobblestone','minecraft:cobbled_deepslate','minecraft:dirt'].includes(i.name)) ?? []
  let item = material().find(i => i.slot < 9)
  if (!item && material().length) {
    await operations.inventory.equip(material()[0].slot)
    if (ctx.cancelled?.()) return false
    item = material().find(i => i.slot < 9)
  }
  if (!item) return false
  const options = { position, clicked: below, face: 4, slot: item.slot }
  if (!operations.interactions.previewPlaceAgainst(options).ready) return false
  const result = await operations.interactions.placeAgainst(options)
  return result?.serverConfirmed === true && ground(getBlock(position.x, position.y, position.z))
}

module.exports = { nextGround, fountain, cell, center, distance, ground, air, SIDES, bridge, findShelter }
