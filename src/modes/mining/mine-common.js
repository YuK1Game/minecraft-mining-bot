'use strict'

const results = require('../return/return-result')
const { bottomSlab, scopeOf } = require('./mine-observed')
const AIR = /^minecraft:(?:air|cave_air|void_air)$/
const FLUID = /(?:water|lava|bubble_column)/
const key = p => `${p.x},${p.y},${p.z}`
const point = p => p && ['x', 'y', 'z'].every(a => Number.isFinite(p[a])) ? { x: p.x, y: p.y, z: p.z } : null
const centre = p => ({ x: p.x + 0.5, y: p.y, z: p.z + 0.5 })
const at = (ctx, p) => ctx.getBlock(p.x, p.y, p.z)
const air = b => b?.known === true && AIR.test(b.name ?? '') && !b.extra?.length
const open = b => b?.known === true && !b.extra?.length && (AIR.test(b.name ?? '') || /^minecraft:(?:torch|wall_torch|ladder)$/.test(b.name ?? ''))
const wet = b => FLUID.test(b?.name ?? '') || b?.extra?.some(layer => FLUID.test(layer.name ?? ''))
const solid = b => b?.known === true && b.boundingBox === 'block' && !wet(b) && !/gravel|sand$/.test(b.name ?? '')
const standY = (floor, y) => bottomSlab(floor) ? y - 0.5 : y
const received = receipt => receipt?.status === 'completed' && (receipt.serverConfirmed === true || receipt.evidence?.serverConfirmed === true)
const inventory = ctx => { const inv = ctx.runtime.inventory(); return !ctx.shared?.inventoryUncertain && inv?.known === true && inv.uncertain !== true && Array.isArray(inv.items) ? inv : null }
const count = (ctx, name) => (inventory(ctx)?.items ?? []).reduce((n, row) => n + (row.name === 'minecraft:' + name.replace(/^minecraft:/, '') ? Math.max(0, row.count ?? 0) : 0), 0)
const scope = ctx => scopeOf(ctx)
const live = (ctx, before = scope(ctx)) => !!before && !ctx.cancelled() && scope(ctx) === before && inventory(ctx) !== null
const blocked = (code, detail, kind = 'terrain_received') => results.blocked(code, { kind }, { detail })
const pending = (reason, result) => ({ done: false, reason, ...(result ? { result } : {}) })
const stopped = () => results.interrupted('MINE_INTERRUPTED')

async function observe (ctx, cells, reason) {
  if (!ctx.cancelled()) await ctx.minePorts?.observe?.({ cells: cells.map(point).filter(Boolean), reason })
  return blocked('MINE_TERRAIN_UNKNOWN', reason)
}

// The intent is durable before an input can be sent. Rechecking the life and inventory after every await also
// keeps a delayed response from a previous connection from advancing this connection's mine.
async function save (ctx, branch, before = scope(ctx)) {
  if (!live(ctx, before)) return false
  if (typeof ctx.saveMine !== 'function') return false
  return await ctx.saveMine() === true && live(ctx, before)
}

async function action (ctx, branch, intent, call, confirm = () => true) {
  const before = scope(ctx)
  if (!live(ctx, before)) return stopped()
  branch.intent = { ...intent, liveScope: before }
  if (!await save(ctx, branch, before)) return blocked('MINE_CHECKPOINT', '採掘場の施工予定を保存できません。', 'owner_released')
  let out
  try { out = await call() } catch (error) { return live(ctx, before) ? results.failed(String(error.code ?? 'MINE_ACTION_FAILED'), { detail: error.message }) : stopped() }
  if (!live(ctx, before)) return stopped()
  if (!received(out)) return out?.status ? out : blocked('MINE_ACTION_UNCONFIRMED', '採掘場の操作結果をまだ確認できません。', 'time')
  if (!confirm()) return blocked('MINE_RECEIPT_CHANGED', '採掘場の受信結果を再確認します。')
  delete branch.intent
  if (!await save(ctx, branch, before)) return blocked('MINE_CHECKPOINT', '採掘場の施工結果を保存できません。', 'owner_released')
  return { ...out, serverConfirmed: true }
}

const feetAt = (ctx, target) => { const feet = ctx.getFeet(); return !!feet && Math.hypot(feet.x - target.x, feet.z - target.z) <= 0.2 && Math.abs(feet.y - target.y) < 0.12 }

module.exports = { key, point, centre, at, air, open, wet, solid, standY, received, inventory, count, scope, live, blocked, pending, stopped, observe, save, action, feetAt, results }
