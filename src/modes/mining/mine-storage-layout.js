'use strict'

const { at, key, open, solid } = require('./mine-common')
const { placementSupportOk } = require('../../quarry/storage/storage-site-terrain')
const { receivedLight } = require('./mine-lighting')

const feetCell = feet => ({ x: Math.floor(feet.x), y: Math.ceil(feet.y), z: Math.floor(feet.z) })
const above = p => ({ ...p, y: p.y + 1 })
const below = p => ({ ...p, y: p.y - 1 })

// A one-cell end slice can keep an unowned cobblestone at a wall torch's
// position. The saved centre route and every floor (including below the
// retained stone) stay in the construction work.
function retainStorageTorchSupport (ctx, plan, step, cells, saved = null) {
  if (step.kind !== 'storage' || step.count !== 1) return null
  const remaining = cells.clear.filter(p => !open(at(ctx, p)))
  if (remaining.length !== 1) return null

  const support = remaining[0], block = at(ctx, support), id = key(support)
  if (block.name !== 'minecraft:cobblestone' || !placementSupportOk(block)) return null
  if ((ctx.memory?.early?.mine?.branch?.temporarySeals ?? []).some(p => key(p) === id)) return null
  const original = cells.torch.find(item => key(item.position) === id)
  if (!original) return null
  const position = {
    x: support.x + support.x - original.support.x,
    y: support.y,
    z: support.z + support.z - original.support.z
  }
  const clear = cells.clear.filter(p => key(p) !== id)
  if (!clear.some(p => key(p) === key(position)) ||
    cells.torch.some(item => key(item.position) === key(position)) ||
    plan.storage.some(room => room.pairs.some(pair => pair.positions.some(p => p.x === position.x && p.z === position.z)))) return null

  const entry = feetCell(cells.approach), stand = feetCell(cells.stand)
  if (support.y !== stand.y + 1 || Math.abs(entry.x - stand.x) + Math.abs(entry.z - stand.z) !== 1 ||
    ![entry, stand].every(p => open(at(ctx, p)) && open(at(ctx, above(p))) && solid(at(ctx, below(p))))) return null

  const torch = cells.torch.map(item => item === original ? { ...item, position, support } : item)
  const targets = new Set(torch.map(item => key(item.position)))
  if (!torch.every(item => open(at(ctx, item.position)) && placementSupportOk(at(ctx, item.support)))) return null
  // Estimate brightness only. Finishing still needs the actual receipt for
  // each floor, torch, sealing block and the final walking position.
  const light = receivedLight((x, y, z) => targets.has(key({ x, y, z }))
    ? { known: true, name: 'minecraft:torch', boundingBox: 'empty' } : ctx.getBlock(x, y, z),
  cells.clear.filter(p => p.y === stand.y), { target: plan.finish.lightTarget })
  if (!light.safe) return null

  const retainedTorchSupport = { support, position, name: block.name, runtimeId: block.runtimeId ?? null }
  if (saved && (!saved.support || !saved.position || key(saved.support) !== id || key(saved.position) !== key(position) ||
    saved.name !== block.name || saved.runtimeId !== retainedTorchSupport.runtimeId)) return null
  return { ...cells, clear, torch, retainedTorchSupport }
}

module.exports = { retainStorageTorchSupport }
