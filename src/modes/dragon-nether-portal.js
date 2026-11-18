'use strict'

const { clicks, stands, clearLine } = require('./house/house-steps')
const { walkableCells } = require('./player-drops')
const { wrap } = require('../common/work-spans')

const obsidian = 'minecraft:obsidian'
const stone = 'minecraft:cobblestone'
const portal = block => block?.known === true && /^minecraft:(?:nether_)?portal$/.test(block.name)
const air = block => block?.known === true && /^minecraft:(?:air|cave_air|void_air)$/.test(block.name) && !block.extra?.length
const floor = block => block?.known === true && block.boundingBox === 'block' && !block.extra?.length && !/lava|fire|magma|cactus|leaves|fence|wall|slab|stairs|chest|bed$/.test(block.name)
const cell = p => ({ x: Math.floor(p.x), y: Math.floor(p.y + 0.001), z: Math.floor(p.z) })
const center = p => ({ x: p.x + 0.5, y: p.y, z: p.z + 0.5 })
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const pending = reason => ({ done: false, reason })
const held = (ctx, name) => (ctx.runtime.inventory()?.items ?? []).filter(i => i.name === name && i.count > 0).reduce((n, i) => n + i.count, 0)
const live = ctx => !ctx.signal?.aborted && !ctx.aborted?.()

function framePlan (origin) {
  const at = (x, y, z = 0) => ({ x: origin.x + x, y: origin.y + y, z: origin.z + z })
  const plan = []
  // These three steps provide a visible upper face even for the top of the frame.
  for (let x = -2; x <= 0; x++) for (let y = 0; y < x + 3; y++) plan.push({ item: stone, position: at(x, y, -1) })
  for (let y = 0; y < 5; y++) for (let x = 0; x < 4; x++) {
    const side = x === 0 || x === 3, cap = y === 0 || y === 4
    if (side || cap) plan.push({ item: side && cap ? stone : obsidian, position: at(x, y) })
  }
  return plan
}

const findSite = wrap('dragon-nether.portal-site', ctx => {
  const base = cell(ctx.getFeet()), cache = new Map()
  const get = (x, y, z) => {
    const key = (x - base.x + 16) * 1024 + (y - base.y + 8) * 32 + z - base.z + 16
    if (!cache.has(key)) cache.set(key, ctx.getBlock(x, y, z))
    return cache.get(key)
  }
  // Keep the entrance and its access steps outside the actual starter house.
  const house = ctx.shared.playerHouse?.origin
  for (const dy of [0, -1, 1, -2, 2]) for (let r = 0; r <= 10; r++) for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
    if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
    const o = { x: base.x + dx, y: base.y + dy, z: base.z + dz }
    if (house && o.x + 4 >= house.x && o.x - 3 <= house.x + 6 && o.z + 1 >= house.z && o.z - 2 <= house.z + 8) continue
    let clear = true
    for (let x = -3; x <= 4 && clear; x++) for (let z = -2; z <= 1 && clear; z++) {
      clear = floor(get(o.x + x, o.y - 1, o.z + z))
      for (let y = 0; y < (z === 0 || z === -1 ? 5 : 2) && clear; y++) clear = air(get(o.x + x, o.y + y, o.z + z))
    }
    if (clear) return o
  }
  return null
})

async function hotbar (ctx, name) {
  const stacks = () => (ctx.runtime.inventory()?.items ?? []).filter(i => i.name === name && i.count > 0)
  let item = stacks().find(i => i.slot >= 0 && i.slot < 9)
  if (!item && stacks().length && live(ctx)) {
    await ctx.operations.inventory.equip(stacks()[0].slot)
    item = stacks().find(i => i.slot >= 0 && i.slot < 9)
  }
  return item?.slot ?? null
}

async function place (ctx, step) {
  const { operations, getBlock } = ctx
  const slot = await hotbar(ctx, step.item)
  if (slot == null || !live(ctx)) return pending('建材のホットバー受信を待っています')
  const here = ctx.getFeet()
  for (const click of clicks(getBlock, step)) {
    const options = { ...click, position: step.position, slot }
    const can = () => operations.interactions.previewPlaceAgainst(options)?.ready === true
    const above = click.face === 1 && here.y + 1.62 <= click.clicked.y + 1
    if (above || !can()) {
      const targets = stands(getBlock, step, click, here).filter(p => click.face !== 1 || p.y + 1.62 > click.clicked.y + 1)
      let moved = false
      for (const target of targets.slice(0, 8)) {
        if (!live(ctx)) return pending('ゲート建設を中断しました')
        if (distance(here, target) > 0.3 && await ctx.hands.walk(target) && can()) { moved = true; break }
      }
      if (!moved) continue
    }
    if (!live(ctx)) return pending('ゲート建設を中断しました')
    const result = await operations.interactions.placeAgainst(options)
    return pending(result?.confirmedBy === 'server_block_and_inventory' ? 'ゲートの建材を1個設置しました' : '設置ブロックと消費を確認しています')
  }
  return pending('建材を置ける面と安全な立ち位置を探しています')
}

function nearestGate (getBlock, at, radius = 6) {
  let best = null
  for (let y = at.y - 4; y <= at.y + 4; y++) for (let x = at.x - radius; x <= at.x + radius; x++) for (let z = at.z - radius; z <= at.z + radius; z++) {
    if (!portal(getBlock(x, y, z)) || !floor(getBlock(x, y - 1, z))) continue
    const candidate = { x, y, z }
    if (!best || distance(at, candidate) < distance(at, best)) best = candidate
  }
  return best
}

async function buildGate (ctx, nether) {
  if (!nether.site) {
    const site = findSite(ctx)
    if (!site) {
      const at = cell(ctx.getFeet()), seen = nether.siteSearch ??= {}
      const key = p => Math.floor(p.x / 6) + ',' + Math.floor(p.z / 6)
      seen[key(at)] = (seen[key(at)] ?? 0) + 1
      const choices = [...walkableCells(ctx.where(), ctx.getBlock).values()].filter(p => distance(at, p) > 5 && distance(at, p) < 12)
      choices.sort((a, b) => (seen[key(a)] ?? 0) - (seen[key(b)] ?? 0) || distance(b, at) - distance(a, at))
      if (choices.length) await ctx.hands.walk(center(choices[0]))
      return pending('ゲートを建てられる平地を周囲で探しています')
    }
    nether.site = site
    return pending('ゲートの建築場所を記録しました')
  }
  const origin = nether.site
  if (nether.missing && held(ctx, nether.missing.name) < nether.missing.count) return pending((await ctx.supplies.acquire(nether.missing.name, nether.missing.count)).reason)
  if (distance(ctx.getFeet(), origin) > 12) {
    if (distance(ctx.getFeet(), origin) > 64) await ctx.travelTo({ destination: { x: origin.x, z: origin.z } }, { aborted: ctx.aborted })
    else await ctx.hands.approach(center(origin), 5)
    return pending('記録済みのゲート建築地点へ戻ります')
  }
  const plan = framePlan(origin)
  const missing = plan.filter(step => ctx.getBlock(step.position.x, step.position.y, step.position.z)?.name !== step.item)
  if (missing.length) {
    const step = missing[0]
    const target = ctx.getBlock(step.position.x, step.position.y, step.position.z)
    if (!air(target)) return pending('ゲートの未完成箇所の空きを確認しています')
    const need = missing.filter(s => s.item === step.item).length
    if (held(ctx, step.item) < need) {
      nether.missing = { name: step.item, count: need }
      return pending((await ctx.supplies.acquire(step.item, need)).reason)
    }
    delete nether.missing
    return place(ctx, step)
  }
  const foot = { x: origin.x + 1, y: origin.y, z: origin.z }
  if (!held(ctx, 'minecraft:flint_and_steel')) return pending((await ctx.supplies.acquire('flint_and_steel', 1)).reason)
  const top = { x: foot.x + 0.5, y: foot.y + 1, z: foot.z + 0.5 }, here = ctx.getFeet(), eye = { ...here, y: here.y + 1.62 }
  if (distance(eye, top) > 4.2 || eye.y <= top.y || !clearLine(ctx.getBlock, eye, top, foot)) {
    await ctx.hands.walk({ x: top.x, y: foot.y, z: foot.z + 1.5 })
    return pending('黒曜石の上面へ点火できる場所へ移動します')
  }
  const slot = await hotbar(ctx, 'minecraft:flint_and_steel')
  if (slot != null && live(ctx)) await ctx.operations.interactions.useDragonItem({ item: 'minecraft:flint_and_steel', position: foot, slot })
  return pending('点火後のポータルブロックを確認しています')
}

async function useGate (ctx, gate, destination) {
  if (distance(ctx.getFeet(), gate) > 12) {
    await ctx.hands.approach(center(gate), 5)
    return pending('記録済みのゲートへ戻ります')
  }
  const block = ctx.getBlock(gate.x, gate.y, gate.z)
  if (!portal(block)) {
    const bottom = { ...gate, y: gate.y - 1 }
    if (air(block) && ctx.getBlock(bottom.x, bottom.y, bottom.z)?.name === obsidian && held(ctx, 'minecraft:flint_and_steel')) {
      const eye = ctx.where(), surface = { x: gate.x + 0.5, y: gate.y, z: gate.z + 0.5 }
      if (eye.y > surface.y && distance(eye, surface) < 4.2 && clearLine(ctx.getBlock, eye, surface, bottom)) {
        const slot = await hotbar(ctx, 'minecraft:flint_and_steel')
        if (slot != null && live(ctx)) await ctx.operations.interactions.useDragonItem({ item: 'minecraft:flint_and_steel', position: bottom, slot })
      } else await ctx.hands.approach(surface, 2)
      return pending('消えたゲートに再点火し、ポータルの再出現を確認します')
    }
    return pending('帰り道のポータルブロックの受信を確認しています')
  }
  const at = cell(ctx.getFeet())
  // Dimension evidence arrives independently; never infer entry from footsteps.
  if (!portal(ctx.getBlock(at.x, at.y, at.z)) && live(ctx)) await ctx.hands.walk(center(gate))
  return pending(destination === 'nether' ? 'ゲート内でネザーへの次元変更を待っています' : 'ゲート内で地上への次元変更を待っています')
}

// A player arriving inside a portal must leave it once before a return trip.
async function leaveGate (ctx, gate) {
  const at = cell(ctx.getFeet())
  if (!portal(ctx.getBlock(at.x, at.y, at.z)) && distance(center(at), center(gate)) >= 1) return true
  const cells = walkableCells(ctx.where(), ctx.getBlock)
  const choices = [...cells.values()].filter(p => distance(gate, p) >= 2 && distance(gate, p) <= 5 && air(ctx.getBlock(p.x, p.y, p.z)))
  choices.sort((a, b) => distance(at, a) - distance(at, b))
  for (const target of choices.slice(0, 4)) if (live(ctx) && await ctx.hands.walk(center(target))) return true
  return false
}

module.exports = { buildGate, useGate, leaveGate, framePlan, nearestGate, cell, center, distance, held, floor, air, pending, live, place }
